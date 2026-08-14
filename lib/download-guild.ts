/**
 * download-guild — enumerate every text channel + thread (active + archived)
 * in one guild and walk each to full history via download-target's walkTarget.
 *
 * "Full history" per the settled spec: active threads (one guild-wide call) AND
 * archived threads (one call-chain per channel) — true completeness, not just
 * what's currently open.
 */
import { getGuildChannels, filterTextChannels } from "./discord";
import { listActiveThreads, listArchivedThreads } from "./discord-threads";
import { walkTarget, type WalkOpts } from "./download-target";
import type { MessageStore } from "./discord-db";
import type { Log } from "./command-types";

export interface GuildWalkResult {
  channels: number;
  threads: number;
  fetched: number;
  inserted: number;
}

export async function walkGuild(
  log: Log, token: string, store: MessageStore, guildId: string, opts: WalkOpts,
): Promise<GuildWalkResult> {
  const rawChannels = await getGuildChannels(token, guildId);
  const textChannels = filterTextChannels(Array.isArray(rawChannels) ? rawChannels : []);

  const result: GuildWalkResult = { channels: 0, threads: 0, fetched: 0, inserted: 0 };

  for (const ch of textChannels) {
    const r = await walkTarget(token, store, ch.id, ch.id, null, guildId, opts);
    result.channels++;
    result.fetched += r.fetched;
    result.inserted += r.inserted;
    if (opts.verbose) log(`  ✓ #${ch.name}: ${r.fetched} fetched, ${r.inserted} new`);
  }

  // Threads: active is one guild-wide call; archived is one call-chain PER channel —
  // sequential (not Promise.all) to stay gentle on the rate limit, matching the rest
  // of this codebase's conservative pacing rather than bursting N channels at once.
  const active = await listActiveThreads(token, guildId);
  const archived: any[] = [];
  for (const ch of textChannels) {
    archived.push(...await listArchivedThreads(token, ch.id));
  }

  const seen = new Set<string>();
  const allThreads = [...active, ...archived].filter(t => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  for (const th of allThreads) {
    const parentId: string | undefined = th.parent_id ?? th.parentId;
    if (!parentId) {
      log(`  ⚠ thread ${th.id} (${th.name ?? "?"}) has no parent_id — skipped`);
      continue;
    }
    const r = await walkTarget(token, store, th.id, parentId, th.id, guildId, opts);
    result.threads++;
    result.fetched += r.fetched;
    result.inserted += r.inserted;
    if (opts.verbose) log(`  ✓ 🧵${th.name ?? th.id}: ${r.fetched} fetched, ${r.inserted} new`);
  }

  return result;
}
