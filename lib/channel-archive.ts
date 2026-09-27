/**
 * channel-archive — walk one channel (its own history + every thread under it)
 * or one thread into the message store, and optionally also into a blob: a
 * self-contained .tar.gz of the raw Discord JSON plus the attachment bytes.
 *
 * The blob exists because the sqlite archive keeps a reduced row per message
 * (no embeds, replies, reactions) and only attachment URLs — Discord CDN URLs
 * are signed, expire, and die with the channel. `channel delete --yes` writes
 * one before deleting; `download <channel|thread> --out` writes one on demand, and
 * `download <guild> --out` writes one per channel plus a server.md index (archiveGuild).
 *
 * Blob layout (<channel-name>-<channelId>.tar.gz; -<UTC stamp> is appended
 * instead of overwriting when that name already exists):
 *   threads.md       human-readable list of every thread inside, with message counts
 *   manifest.json    format, channel object, thread objects, message count, attachment list (+ sha256)
 *   messages.jsonl   one raw Discord message per line — thread messages carry the thread's channel_id
 *   attachments/     <messageId>-<attachmentId>-<filename> — the bytes the CDN serves; the CDN
 *                    can serve a converted file (e.g. webp listed, png served), so a size that
 *                    differs from Discord's is recorded (discord_size) and warned, not fatal
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { getGuildChannels } from "./discord";
import { listActiveThreads, listArchivedThreads } from "./discord-threads";
import { walkTarget } from "./download-target";
import type { MessageStore } from "./discord-db";
import type { Log } from "./command-types";

// Channel types with their own top-level message history: text, voice (text-in-voice),
// announcement, stage. Forum/media channels hold only thread posts — see download-guild.ts.
const MESSAGE_TYPES = new Set([0, 2, 5, 13]);
// Channel types that can parent threads: text, announcement, forum, media.
const THREAD_PARENT_TYPES = new Set([0, 5, 15, 16]);
// Everything a guild download archives — categories hold nothing of their own.
const GUILD_ARCHIVE_TYPES = new Set([0, 2, 5, 13, 15, 16]);

type PrivateThreads = "included" | "no access (403)" | "n/a";

function isForbidden(e: unknown): boolean {
  return /\s403\s/.test(e instanceof Error ? e.message : String(e));
}

/**
 * Clip to a byte budget, keeping a short extension. Filesystems cap one path
 * component at 255 bytes, and Discord attachment names and Thai channel names
 * (3 bytes a character) can exceed it. The original name stays in manifest.json.
 */
function clip(name: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(name).length <= maxBytes) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  let budget = maxBytes - enc.encode(ext).length;
  let base = "";
  for (const ch of Array.from(name.slice(0, name.length - ext.length))) {
    budget -= enc.encode(ch).length;
    if (budget < 0) break;
    base += ch;
  }
  return base + ext;
}

/** Keep the real name (emoji, Thai, …) — only strip what a filename can't hold, and clip it. */
function safeName(name: unknown, fallback: string): string {
  return clip(String(name ?? fallback).replace(/[\/\\:\s\x00-\x1f]+/g, "_") || fallback, 150);
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Default blob directory. Deliberately outside any repo checkout — blobs hold
 * private message content and must never land in a working tree by accident.
 */
export function blobDir(): string {
  return process.env.ATLAS_BLOB_DIR || join(homedir(), ".maw", "atlas-blobs");
}

export interface BlobResult {
  path: string;
  messages: number;
  attachments: number;
  bytes: number;
  /** Attachments whose served size differs from Discord's metadata (CDN format conversion). */
  resized: number;
  /** Contents of threads.md — also printed by the commands. */
  threadsNote: string;
}

export interface ArchiveResult {
  threads: number;
  privateThreads: PrivateThreads;
  fetched: number;
  inserted: number;
  blob?: BlobResult;
}

export function logBlob(log: Log, b: BlobResult) {
  log(`blob: ${b.path}`);
  log(`  ${b.messages} message(s), ${b.attachments} attachment(s), ${(b.bytes / 1024).toFixed(1)} KB of attachments`);
  if (b.resized) log(`  ⚠ ${b.resized} attachment(s) served at a different size than Discord lists — see discord_size in manifest.json`);
  for (const line of b.threadsNote.trimEnd().split("\n")) log(`  ${line}`);
}

/**
 * Active (guild-wide call, filtered to this parent) + archived public + archived
 * private threads, deduped. Private needs Manage Threads; without it the gap is
 * reported (threads.md, server.md), never silently dropped.
 */
async function threadsUnder(token: string, ch: any): Promise<{ threads: any[]; privateThreads: PrivateThreads }> {
  if (!THREAD_PARENT_TYPES.has(ch.type)) return { threads: [], privateThreads: "n/a" };
  const active = (await listActiveThreads(token, ch.guild_id)).filter(t => t.parent_id === ch.id);
  const archived = await listArchivedThreads(token, ch.id);
  let priv: any[] = [];
  let privateThreads: PrivateThreads = "included";
  try {
    priv = await listArchivedThreads(token, ch.id, "private");
  } catch (e) {
    if (!isForbidden(e)) throw e;
    privateThreads = "no access (403)";
  }
  const seen = new Set<string>();
  const threads = [...active, ...archived, ...priv].filter(t => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  return { threads, privateThreads };
}

export async function archiveChannel(
  token: string, store: MessageStore, ch: any, outDir?: string,
): Promise<ArchiveResult> {
  const isThread = !!ch.thread_metadata;
  if (isThread && !ch.parent_id) throw new Error(`thread ${ch.id} has no parent_id — refusing to guess`);

  const { threads, privateThreads } = isThread
    ? { threads: [] as any[], privateThreads: "n/a" as PrivateThreads }
    : await threadsUnder(token, ch);
  const targets: { fetchId: string; dbChannelId: string; dbThreadId: string | null }[] = isThread
    ? [{ fetchId: ch.id, dbChannelId: ch.parent_id, dbThreadId: ch.id }]
    : [
        ...(MESSAGE_TYPES.has(ch.type) ? [{ fetchId: ch.id, dbChannelId: ch.id, dbThreadId: null }] : []),
        ...threads.map(t => ({ fetchId: t.id, dbChannelId: ch.id, dbThreadId: t.id })),
      ];

  const blob = outDir ? new ChannelBlob(outDir, ch, threads, privateThreads) : null;
  const opts = { max: Number.POSITIVE_INFINITY, verbose: false, onMessage: blob ? (m: any) => blob.add(m) : undefined };
  const result: ArchiveResult = { threads: threads.length, privateThreads, fetched: 0, inserted: 0 };
  try {
    for (const t of targets) {
      const r = await walkTarget(token, store, t.fetchId, t.dbChannelId, t.dbThreadId, ch.guild_id ?? null, opts);
      result.fetched += r.fetched;
      result.inserted += r.inserted;
    }
    if (blob) result.blob = await blob.finish();
  } catch (e) {
    blob?.abort(); // never leave a half-written blob that looks like a backup
    throw e;
  }
  return result;
}

class ChannelBlob {
  private readonly name: string;
  private readonly dir: string;
  private readonly tarball: string;
  private readonly lines: string[] = [];
  private readonly attachments: { messageId: string; att: any }[] = [];
  /** message count per Discord channel id — the channel itself or one of its threads */
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly outDir: string, private readonly channel: any,
    private readonly threads: any[], private readonly privateThreads: PrivateThreads,
  ) {
    let name = `${safeName(channel.name, "channel")}-${channel.id}`;
    if (existsSync(join(outDir, `${name}.tar.gz`)) || existsSync(join(outDir, name))) name += `-${stamp()}`;
    this.name = name;
    this.dir = join(outDir, this.name);
    this.tarball = join(outDir, `${this.name}.tar.gz`);
    mkdirSync(join(this.dir, "attachments"), { recursive: true });
  }

  add(msg: any) {
    this.lines.push(JSON.stringify(msg));
    this.counts.set(msg.channel_id, (this.counts.get(msg.channel_id) ?? 0) + 1);
    for (const att of msg.attachments ?? []) this.attachments.push({ messageId: msg.id, att });
  }

  private threadsNote(): string {
    const c = this.channel;
    const out = [
      `# #${c.name} (${c.id})`,
      "",
      `guild ${c.guild_id} · exported ${new Date().toISOString()}`,
      "",
      `- channel messages: ${this.counts.get(c.id) ?? 0}`,
      `- threads: ${this.threads.length}`,
      `- private archived threads: ${this.privateThreads}`,
      "",
    ];
    if (!this.threads.length) {
      out.push("No threads inside.");
    } else {
      out.push("| thread | id | messages | private | archived | created |", "|---|---|---|---|---|---|");
      for (const t of this.threads) {
        const created = t.thread_metadata?.create_timestamp ?? "";
        out.push(`| ${String(t.name).replace(/\|/g, "\\|")} | ${t.id} | ${this.counts.get(t.id) ?? 0} | ${t.type === 12 ? "yes" : "no"} | ${t.thread_metadata?.archived ? "yes" : "no"} | ${created} |`);
      }
    }
    return out.join("\n") + "\n";
  }

  /** Remove this blob's own staging dir and tarball (both named uniquely in the constructor). */
  abort() {
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.tarball, { force: true });
  }

  async finish(): Promise<BlobResult> {
    // Fetch attachment bytes now, while the signed URLs from this walk are still fresh.
    const files: any[] = [];
    let bytes = 0, resized = 0;
    for (const { messageId, att } of this.attachments) {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`attachment ${att.id} (${att.filename}) on message ${messageId}: HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (!data.length && att.size) throw new Error(`attachment ${att.id} (${att.filename}): empty body, Discord says ${att.size} bytes`);
      const sizeDiffers = typeof att.size === "number" && data.length !== att.size;
      if (sizeDiffers) resized++;
      const rel = `attachments/${messageId}-${att.id}-${clip(String(att.filename).replace(/[^\w.-]+/g, "_"), 150)}`;
      writeFileSync(join(this.dir, rel), data);
      bytes += data.length;
      files.push({
        message_id: messageId, attachment_id: att.id, filename: att.filename, size: data.length,
        ...(sizeDiffers ? { discord_size: att.size, served_type: res.headers.get("content-type") } : {}),
        sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"), path: rel,
      });
    }

    const threadsNote = this.threadsNote();
    writeFileSync(join(this.dir, "threads.md"), threadsNote);
    writeFileSync(join(this.dir, "messages.jsonl"), this.lines.length ? this.lines.join("\n") + "\n" : "");
    writeFileSync(join(this.dir, "manifest.json"), JSON.stringify({
      format: "maw-atlas-channel-blob/1",
      exported_at: new Date().toISOString(),
      channel: this.channel,
      threads: this.threads,
      private_threads: this.privateThreads,
      messages: this.lines.length,
      attachments: files,
    }, null, 2));

    const tarball = this.tarball;
    const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", this.outDir, this.name]);
    if (tar.exitCode !== 0) throw new Error(`tar failed (${tar.exitCode}): ${tar.stderr.toString().trim()}`);

    // Read the tarball back before trusting it — the caller may delete the channel next.
    const list = Bun.spawnSync(["tar", "-tzf", tarball]);
    const entries = list.stdout.toString().split("\n");
    const expected = [
      `${this.name}/manifest.json`, `${this.name}/messages.jsonl`, `${this.name}/threads.md`,
      ...files.map(f => `${this.name}/${f.path}`),
    ];
    const missing = expected.filter(e => !entries.includes(e));
    if (list.exitCode !== 0 || missing.length) {
      throw new Error(`blob ${tarball} failed verification — missing: ${missing.join(", ") || `(tar -t exit ${list.exitCode})`}`);
    }

    rmSync(this.dir, { recursive: true });
    return { path: tarball, messages: this.lines.length, attachments: files.length, bytes, resized, threadsNote };
  }
}

export interface GuildArchiveResult {
  dir: string;
  archived: number;
  noAccess: number;
  messages: number;
  attachments: number;
  threads: number;
  bytes: number;
}

/**
 * Archive a whole guild: one blob per channel (text, voice text-chat, announcement,
 * stage, forum, media) into <outDir>/<guild-name>-<guildId>/, plus server.md (a
 * human index of every channel, its threads count and its file) and server.json
 * (the guild object and raw channel list, categories included). A channel the bot
 * cannot read (403) is listed as "no access" in both, never silently skipped; any
 * other failure aborts the run.
 *
 * Resume: a guild folder without server.md is an unfinished run. Re-running into
 * it keeps every channel blob that is already there and still readable (its
 * manifest.json extracts cleanly) and archives only the rest. A finished folder
 * is never touched — a new run gets a UTC-stamped folder instead.
 */
export async function archiveGuild(
  log: Log, token: string, store: MessageStore, guild: any, outDir: string,
): Promise<GuildArchiveResult> {
  const channels: any[] = await getGuildChannels(token, guild.id);
  const byId = new Map(channels.map(c => [c.id, c]));
  // Sidebar order: uncategorised first, then by category position; inside a
  // category text-like channels before voice/stage, then by channel position.
  const catPos = (c: any) => (c.parent_id ? byId.get(c.parent_id)?.position ?? 0 : -1);
  const isVoice = (c: any) => (c.type === 2 || c.type === 13 ? 1 : 0);
  const targets = channels
    .filter(c => GUILD_ARCHIVE_TYPES.has(c.type))
    .sort((a, b) => catPos(a) - catPos(b) || String(a.parent_id ?? "").localeCompare(String(b.parent_id ?? ""))
      || isVoice(a) - isVoice(b) || a.position - b.position);

  let dir = join(outDir, `${safeName(guild.name, "guild")}-${guild.id}`);
  const resuming = existsSync(dir) && !existsSync(join(dir, "server.md"));
  if (existsSync(dir) && !resuming) dir += `-${stamp()}`;
  mkdirSync(dir, { recursive: true });
  if (resuming) log(`  resuming unfinished run in ${dir}`);

  const rows: { ch: any; r?: ArchiveResult; error?: string }[] = [];
  for (const [i, ch] of targets.entries()) {
    const tag = `[${i + 1}/${targets.length}] #${ch.name}`;
    const kept = resuming ? keptBlob(dir, ch) : null;
    if (kept) {
      rows.push({ ch, r: kept });
      log(`  ↺ ${tag}: kept from the earlier run — ${kept.blob!.messages} msg, ${kept.blob!.attachments} att`);
      continue;
    }
    try {
      const r = await archiveChannel(token, store, ch, dir);
      rows.push({ ch, r });
      const b = r.blob!;
      log(`  ✓ ${tag}: ${b.messages} msg, ${b.attachments} att, ${r.threads} thread(s)${r.privateThreads === "no access (403)" ? ", private threads: no access" : ""}`);
    } catch (e) {
      if (!isForbidden(e)) throw e;
      rows.push({ ch, error: "no access (403)" });
      log(`  ⚠ ${tag}: no access (403) — listed in server.md, not archived`);
    }
  }

  const done = rows.filter(x => x.r);
  const sum = (f: (r: ArchiveResult) => number) => done.reduce((n, x) => n + f(x.r!), 0);
  const result: GuildArchiveResult = {
    dir,
    archived: done.length,
    noAccess: rows.length - done.length,
    messages: sum(r => r.blob!.messages),
    attachments: sum(r => r.blob!.attachments),
    threads: sum(r => r.threads),
    bytes: sum(r => r.blob!.bytes),
  };

  const typeName: Record<number, string> = { 0: "text", 2: "voice", 5: "announcement", 13: "stage", 15: "forum", 16: "media" };
  const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|");
  const md = [
    `# ${guild.name} (${guild.id})`,
    "",
    `exported ${new Date().toISOString()} by maw atlas download --out`,
    "",
    `- channels archived: ${result.archived}${result.noAccess ? ` · no access: ${result.noAccess}` : ""}`,
    `- messages: ${result.messages} · attachments: ${result.attachments} (${(result.bytes / 1048576).toFixed(1)} MB) · threads: ${result.threads}`,
    "",
    "Each channel is its own .tar.gz — open it for messages.jsonl, attachments/, threads.md and manifest.json.",
    "",
    "| category | channel | id | type | messages | attachments | threads | file |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(({ ch, r, error }) => [
      cell(ch.parent_id ? byId.get(ch.parent_id)?.name : ""), cell(ch.name), ch.id, typeName[ch.type] ?? ch.type,
      r ? r.blob!.messages : "-", r ? r.blob!.attachments : "-",
      r ? `${r.threads}${r.privateThreads === "no access (403)" ? " (private: no access)" : ""}` : "-",
      r ? cell(basename(r.blob!.path)) : error,
    ].join(" | ")).map(line => `| ${line} |`),
  ].join("\n") + "\n";
  writeFileSync(join(dir, "server.md"), md);
  writeFileSync(join(dir, "server.json"), JSON.stringify({
    format: "maw-atlas-guild-archive/1",
    exported_at: new Date().toISOString(),
    guild,
    channels,
    results: rows.map(({ ch, r, error }) => ({
      channel_id: ch.id, file: r ? basename(r.blob!.path) : null, error: error ?? null,
      messages: r?.blob?.messages ?? null, attachments: r?.blob?.attachments ?? null,
      threads: r?.threads ?? null, private_threads: r?.privateThreads ?? null,
    })),
  }, null, 2));
  return result;
}

/** A channel blob an earlier, unfinished guild run already wrote — only if its manifest reads back cleanly. */
function keptBlob(dir: string, ch: any): ArchiveResult | null {
  const name = `${safeName(ch.name, "channel")}-${ch.id}`;
  const path = join(dir, `${name}.tar.gz`);
  if (!existsSync(path)) return null;
  const out = Bun.spawnSync(["tar", "-xzOf", path, `${name}/manifest.json`]);
  if (out.exitCode !== 0) return null;
  const m = JSON.parse(out.stdout.toString());
  const atts: any[] = m.attachments ?? [];
  return {
    threads: (m.threads ?? []).length,
    privateThreads: m.private_threads ?? "n/a",
    fetched: 0,
    inserted: 0,
    blob: {
      path, messages: m.messages, attachments: atts.length,
      bytes: atts.reduce((n, a) => n + (a.size ?? 0), 0),
      resized: atts.filter(a => "discord_size" in a).length,
      threadsNote: "",
    },
  };
}
