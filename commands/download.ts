/**
 * maw atlas download <id> — explicit, one-shot archive of a guild, channel, or thread.
 *
 * Auto-detects what <id> is (tries GET /guilds/:id, falls back to GET /channels/:id —
 * a thread is distinguished from a plain channel by the presence of thread_metadata)
 * and walks it to full history. No modes (--full/--fresh/--newest/--incremental — see
 * commands/route.ts for those), no cursor file — download never reads or writes
 * last-seen.json, so it can never interfere with the scheduled `route backfill`
 * cron sweep. Idempotent (INSERT OR IGNORE on message_id): safe to re-run.
 *
 * Full spec: ψ/incubate/nat-build-with-oracle/maw-atlas/SPEC-download-command.md
 * (atlas-oracle repo) — settled via /grill-me, 2026-08-14.
 *
 * --out[=DIR]: also write self-contained blobs — raw Discord JSON, attachment
 * bytes, and a threads.md listing every thread inside — as
 * <channel-name>-<channelId>.tar.gz. A channel id then includes its threads; a
 * guild id writes one blob per channel into <guild-name>-<guildId>/ with a
 * server.md index. See lib/channel-archive.ts.
 *
 * <name> instead of an id: a guild name, or part of it — every word must appear in the
 * name (case, spaces and punctuation ignored; lib/names.ts). Several matches or none:
 * the candidates are listed and nothing is downloaded.
 *
 * --extract (with --out): also unpack every blob into a plain folder —
 * <guild folder>/channels/<channel>-<id>/ for a guild, <DIR>/<channel>-<id>/ for one
 * channel. --safe-names / --ascii: file and folder names a shell takes unquoted
 * (no emoji, "&", "｜", "∕", spaces); --safe-names keeps Thai letters, --ascii does not.
 *
 * Rows go to the server's own archive DB, guilds/<guildId>-<slug>.sqlite next to
 * the shared messages.sqlite (lib/discord-db.ts archiveDbFor); ATLAS_ROUTE_DB
 * overrides that with one explicit store.
 */
import { getGuild, getChannel, listGuilds } from "../lib/discord";
import { openMessageStore, archiveDbFor } from "../lib/discord-db";
import { walkGuild } from "../lib/download-guild";
import { walkTarget } from "../lib/download-target";
import { archiveChannel, archiveGuild, blobDir, extractBlob, logBlob, type BlobOpts } from "../lib/channel-archive";
import { isSnowflake, lookupFailure, matchGuilds, type NameMode } from "../lib/names";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "download",
  help: [
    "download <guildId|channelId|threadId|guild name> [--max=N]   explicit full download, no cursor, idempotent",
    "download <guildId|channelId|threadId|guild name> --out[=DIR] [--extract] [--safe-names|--ascii]   + blobs: raw JSON, attachments, threads.md (.tar.gz per channel; server.md + server.sqlite for a guild)",
  ].join("\n"),
};

function intArg(args: string[], name: string, def: number): number {
  const hit = args.find(a => a.startsWith(`${name}=`));
  if (!hit) return def;
  const n = Number.parseInt(hit.slice(name.length + 1), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Only a genuine 404 means "not this kind of target — try the next guess".
// Anything else (401 bad token, network error, retry-exhausted 5xx from
// lib/discord.ts's request()) is a real failure and must propagate, not get
// silently reported as "id not found" — that misdiagnosis costs debugging
// time on real infra (fail loud, per fleet convention).
function isNotFound(e: unknown): boolean {
  return /\s404\s/.test(e instanceof Error ? e.message : String(e));
}
async function tryGetGuild(token: string, id: string): Promise<any | null> {
  try { return await getGuild(token, id); }
  catch (e) { if (isNotFound(e)) return null; throw e; }
}
async function tryGetChannel(token: string, id: string): Promise<any | null> {
  try { return await getChannel(token, id); }
  catch (e) { if (isNotFound(e)) return null; throw e; }
}

/**
 * A guild name (or part of it) → the guild id, through the guilds this bot is in.
 * Several matches or none: list the candidates and throw — never guess.
 */
export async function resolveGuildName(log: Log, token: string, query: string): Promise<string> {
  const guilds: { id: string; name: string }[] = await listGuilds(token);
  const m = matchGuilds(query, Array.isArray(guilds) ? guilds : []);
  if (m.pick) {
    log(`"${query}" → ${m.pick.name} (${m.pick.id})`);
    return m.pick.id;
  }
  const f = lookupFailure(query, m, guilds);
  for (const line of f.lines) log(line);
  throw new Error(f.error);
}

/** --safe-names / --ascii → the naming mode; both at once is an error. */
export function nameModeArg(args: string[]): NameMode {
  const safe = args.includes("--safe-names"), ascii = args.includes("--ascii");
  if (safe && ascii) throw new Error("--safe-names and --ascii are two naming modes — pick one");
  return ascii ? "ascii" : safe ? "safe" : "keep";
}

export async function run(log: Log, token: string, args: string[]) {
  const words = args.slice(1).filter(a => !a.startsWith("--"));
  let id = words.length === 1 && isSnowflake(words[0]) ? words[0] : undefined;
  if (!words.length) {
    log("usage: maw atlas download <guildId|channelId|threadId|guild name> [--max=N]");
    log("       maw atlas download <guildId|channelId|threadId|guild name> --out[=DIR] [--extract] [--safe-names|--ascii]");
    log("  auto-detects the id's type — whole guild (channels+threads), a single channel, or a single thread");
    log("  a name picks the guild whose name holds every word (case, spaces, punctuation ignored); several or none: lists them");
    log("  no modes, no cursor file — idempotent full walk, safe to re-run any time");
    log(`  --out also writes <channel-name>-<channelId>.tar.gz (raw JSON + attachments + threads.md) to DIR, default ${blobDir()}`);
    log("        a guild id writes one per channel into <guild-name>-<guildId>/ plus server.md, server.json and server.sqlite");
    log("  --extract also unpacks every blob: <guild folder>/channels/<channel>-<id>/ (messages.jsonl, attachments/, threads.md)");
    log("  --safe-names: names a shell takes unquoted (Thai kept; emoji, &, ｜, ∕, spaces → -) · --ascii: a-z 0-9 . _ - only");
    log("  rows go to the server's own DB, .maw/atlas-route/guilds/<guildId>-<slug>.sqlite (ATLAS_ROUTE_DB overrides)");
    return;
  }

  const outFlag = args.find(a => a === "--out" || a.startsWith("--out="));
  const outDir = outFlag === undefined ? undefined : outFlag.slice("--out=".length) || blobDir();
  if (outDir && args.some(a => a.startsWith("--max="))) throw new Error("--max can't be combined with --out — a blob is always the full history");
  const blobOpts: BlobOpts = { names: nameModeArg(args), extract: args.includes("--extract") };
  if (!outDir && (blobOpts.extract || blobOpts.names !== "keep")) {
    throw new Error("--extract, --safe-names and --ascii shape the blobs — they need --out[=DIR]");
  }
  if (!id) id = await resolveGuildName(log, token, words.join(" "));

  const max = intArg(args, "--max", Number.POSITIVE_INFINITY);
  const opts = { max, verbose: true };

  // Resolve what <id> is first: the target DB is the server's own file.
  const guild = await tryGetGuild(token, id);
  const channel = guild ? null : await tryGetChannel(token, id);
  if (!guild && !channel) {
    log(`✗ "${id}" is not a guild, channel, or thread this bot can see.`);
    const guilds = await listGuilds(token).catch(() => []);
    if (Array.isArray(guilds) && guilds.length) {
      log("  guilds this bot IS in:");
      for (const g of guilds) log(`    ${g.id}  ${g.name}`);
    }
    return;
  }
  const owner = guild ?? (channel.guild_id ? await tryGetGuild(token, channel.guild_id) : null);
  const dbPath = archiveDbFor(owner?.id ?? channel?.guild_id, owner?.name);
  const store = openMessageStore(dbPath);

  try {
    if (guild) {
      if (outDir) {
        log(`download guild "${guild.name}" (${id}) → ${dbPath} + blobs in ${outDir}`);
        const r = await archiveGuild(log, token, store, guild, outDir, blobOpts);
        log(`done: ${r.archived} channel(s)${r.noAccess ? `, ${r.noAccess} no access` : ""}, ${r.messages} messages, ${r.attachments} attachments (${(r.bytes / 1048576).toFixed(1)} MB), ${r.threads} thread(s)`);
        log(`server: ${r.dir}/server.md · ${r.sqlite}`);
        if (r.extracted) log(`folders: ${r.extracted}/<channel>-<id>/`);
        return;
      }
      log(`download guild "${guild.name}" (${id}) → ${dbPath}`);
      const r = await walkGuild(log, token, store, id, opts);
      log(`done: ${r.channels} channel(s), ${r.threads} thread(s), ${r.fetched} fetched, ${r.inserted} new`);
      return;
    }

    const isThread = !!channel.thread_metadata;
    if (isThread && !channel.parent_id) {
      // Never substitute a wrong id — that's the exact "hardcoded to channel_id"
      // corruption class this command exists to avoid, and it'd be permanent
      // (INSERT OR IGNORE means a later correct re-run can't fix it).
      log(`✗ thread "${channel.name ?? id}" (${id}) has no parent_id in Discord's response — refusing to guess, nothing downloaded.`);
      return;
    }
    if (outDir) {
      log(`download ${isThread ? "thread" : "channel"} "#${channel.name}" (${id}) → ${dbPath} + blob in ${outDir}`);
      const r = await archiveChannel(token, store, channel, outDir, blobOpts);
      log(`done: ${r.threads} thread(s), ${r.fetched} fetched, ${r.inserted} new`);
      logBlob(log, r.blob!);
      if (blobOpts.extract) log(`folder: ${extractBlob(r.blob!.path, outDir)}/`);
      return;
    }

    const dbChannelId: string = isThread ? channel.parent_id : id;
    const dbThreadId: string | null = isThread ? id : null;
    log(`download ${isThread ? "thread" : "channel"} "#${channel.name}" (${id}) → ${dbPath}`);
    const r = await walkTarget(token, store, id, dbChannelId, dbThreadId, channel.guild_id ?? null, opts);
    log(`done: ${r.fetched} fetched, ${r.inserted} new`);
  } finally {
    store.close();
  }
}
