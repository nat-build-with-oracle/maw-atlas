/**
 * channel-archive — walk one channel (its own history + every thread under it)
 * or one thread into the message store, and optionally also into a blob: a
 * self-contained .tar.gz of the raw Discord JSON plus the attachment bytes.
 *
 * The blob exists because the sqlite archive keeps a reduced row per message
 * (no embeds, replies, reactions) and only attachment URLs — Discord CDN URLs
 * are signed, expire, and die with the channel. `channel delete --yes` writes
 * one before deleting; `download <channel|thread> --out` writes one on demand.
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
import { join } from "path";
import { listActiveThreads, listArchivedThreads } from "./discord-threads";
import { walkTarget } from "./download-target";
import type { MessageStore } from "./discord-db";
import type { Log } from "./command-types";

// Channel types with their own top-level message history: text, voice (text-in-voice),
// announcement, stage. Forum/media channels hold only thread posts — see download-guild.ts.
const MESSAGE_TYPES = new Set([0, 2, 5, 13]);

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

/** Active (guild-wide call, filtered to this parent) + archived public threads, deduped. */
async function threadsUnder(token: string, ch: any): Promise<any[]> {
  const active = (await listActiveThreads(token, ch.guild_id)).filter(t => t.parent_id === ch.id);
  const archived = await listArchivedThreads(token, ch.id);
  const seen = new Set<string>();
  return [...active, ...archived].filter(t => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

export async function archiveChannel(
  token: string, store: MessageStore, ch: any, outDir?: string,
): Promise<ArchiveResult> {
  const isThread = !!ch.thread_metadata;
  if (isThread && !ch.parent_id) throw new Error(`thread ${ch.id} has no parent_id — refusing to guess`);

  const threads = isThread ? [] : await threadsUnder(token, ch);
  const targets: { fetchId: string; dbChannelId: string; dbThreadId: string | null }[] = isThread
    ? [{ fetchId: ch.id, dbChannelId: ch.parent_id, dbThreadId: ch.id }]
    : [
        ...(MESSAGE_TYPES.has(ch.type) ? [{ fetchId: ch.id, dbChannelId: ch.id, dbThreadId: null }] : []),
        ...threads.map(t => ({ fetchId: t.id, dbChannelId: ch.id, dbThreadId: t.id })),
      ];

  const blob = outDir ? new ChannelBlob(outDir, ch, threads) : null;
  const opts = { max: Number.POSITIVE_INFINITY, verbose: false, onMessage: blob ? (m: any) => blob.add(m) : undefined };
  const result: ArchiveResult = { threads: threads.length, fetched: 0, inserted: 0 };
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

  constructor(private readonly outDir: string, private readonly channel: any, private readonly threads: any[]) {
    // Keep the real channel name (emoji, Thai, …) — only strip what a filename can't hold.
    const safeName = String(channel.name ?? "channel").replace(/[\/\\:\s\x00-\x1f]+/g, "_");
    let name = `${safeName}-${channel.id}`;
    if (existsSync(join(outDir, `${name}.tar.gz`)) || existsSync(join(outDir, name))) {
      name += `-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
    }
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
      "",
    ];
    if (!this.threads.length) {
      out.push("No threads inside.");
    } else {
      out.push("| thread | id | messages | archived | created |", "|---|---|---|---|---|");
      for (const t of this.threads) {
        const created = t.thread_metadata?.create_timestamp ?? "";
        out.push(`| ${String(t.name).replace(/\|/g, "\\|")} | ${t.id} | ${this.counts.get(t.id) ?? 0} | ${t.thread_metadata?.archived ? "yes" : "no"} | ${created} |`);
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
      const rel = `attachments/${messageId}-${att.id}-${String(att.filename).replace(/[^\w.-]+/g, "_")}`;
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
