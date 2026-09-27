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
 * Rows go to the server's own archive DB, guilds/<guildId>-<slug>.sqlite next to
 * the shared messages.sqlite (lib/discord-db.ts archiveDbFor); ATLAS_ROUTE_DB
 * overrides that with one explicit store.
 */
import { getGuild, getChannel, listGuilds } from "../lib/discord";
import { openMessageStore, archiveDbFor } from "../lib/discord-db";
import { walkGuild } from "../lib/download-guild";
import { walkTarget } from "../lib/download-target";
import { archiveChannel, archiveGuild, blobDir, logBlob } from "../lib/channel-archive";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "download",
  help: [
    "download <guildId|channelId|threadId> [--max=N]   explicit full download, no cursor, idempotent",
    "download <guildId|channelId|threadId> --out[=DIR]   + blobs: raw JSON, attachments, threads.md (.tar.gz per channel; server.md + server.sqlite for a guild)",
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

export async function run(log: Log, token: string, args: string[]) {
  const id = args[1];
  if (!id || !/^\d{17,20}$/.test(id)) {
    log("usage: maw atlas download <guildId|channelId|threadId> [--max=N]");
    log("       maw atlas download <guildId|channelId|threadId> --out[=DIR]");
    log("  auto-detects the id's type — whole guild (channels+threads), a single channel, or a single thread");
    log("  no modes, no cursor file — idempotent full walk, safe to re-run any time");
    log(`  --out also writes <channel-name>-<channelId>.tar.gz (raw JSON + attachments + threads.md) to DIR, default ${blobDir()}`);
    log("        a guild id writes one per channel into <guild-name>-<guildId>/ plus server.md, server.json and server.sqlite");
    log("  rows go to the server's own DB, .maw/atlas-route/guilds/<guildId>-<slug>.sqlite (ATLAS_ROUTE_DB overrides)");
    return;
  }

  const outFlag = args.find(a => a === "--out" || a.startsWith("--out="));
  const outDir = outFlag === undefined ? undefined : outFlag.slice("--out=".length) || blobDir();
  if (outDir && args.some(a => a.startsWith("--max="))) throw new Error("--max can't be combined with --out — a blob is always the full history");

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
        const r = await archiveGuild(log, token, store, guild, outDir);
        log(`done: ${r.archived} channel(s)${r.noAccess ? `, ${r.noAccess} no access` : ""}, ${r.messages} messages, ${r.attachments} attachments (${(r.bytes / 1048576).toFixed(1)} MB), ${r.threads} thread(s)`);
        log(`server: ${r.dir}/server.md · ${r.sqlite}`);
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
      const r = await archiveChannel(token, store, channel, outDir);
      log(`done: ${r.threads} thread(s), ${r.fetched} fetched, ${r.inserted} new`);
      logBlob(log, r.blob!);
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
