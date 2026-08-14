/**
 * download-guild — enumerate every text channel + thread (active + archived)
 * in one guild and walk each to full history via download-target's walkTarget.
 *
 * "Full history" per the settled spec: active threads (one guild-wide call) AND
 * archived threads (one call-chain per channel) — true completeness, not just
 * what's currently open.
 */
import { getGuildChannels } from "./discord";
import { listActiveThreads, listArchivedThreads } from "./discord-threads";
import { walkTarget, type WalkOpts } from "./download-target";
import type { MessageStore } from "./discord-db";
import type { Log } from "./command-types";

// Discord channel types (https://discord.com/developers/docs/resources/channel#channel-object-channel-types).
// GUILD_TEXT and GUILD_ANNOUNCEMENT carry their own top-level messages, walkable
// directly. GUILD_FORUM and GUILD_MEDIA do NOT — a forum/media channel is just a
// container of thread-posts, so it has nothing to walk except its threads. All
// four types CAN parent threads, so all four must be scanned for thread
// enumeration or "true completeness" is a lie (the bug this fixes).
const MESSAGE_CHANNEL_TYPES = new Set([0 /* GUILD_TEXT */, 5 /* GUILD_ANNOUNCEMENT */]);
const THREAD_PARENT_TYPES = new Set([0, 5, 15 /* GUILD_FORUM */, 16 /* GUILD_MEDIA */]);

export interface GuildWalkResult {
  channels: number;
  threads: number;
  fetched: number;
  inserted: number;
}

export async function walkGuild(
  log: Log, token: string, store: MessageStore, guildId: string, opts: WalkOpts,
): Promise<GuildWalkResult> {
  const fetchedChannels = await getGuildChannels(token, guildId);
  const rawChannels: any[] = Array.isArray(fetchedChannels) ? fetchedChannels : [];
  const messageChannels = rawChannels.filter(c => MESSAGE_CHANNEL_TYPES.has(c.type));
  const threadParentChannels = rawChannels.filter(c => THREAD_PARENT_TYPES.has(c.type));

  const result: GuildWalkResult = { channels: 0, threads: 0, fetched: 0, inserted: 0 };

  for (const ch of messageChannels) {
    const r = await walkTarget(token, store, ch.id, ch.id, null, guildId, opts);
    result.channels++;
    result.fetched += r.fetched;
    result.inserted += r.inserted;
    if (opts.verbose) log(`  ✓ #${ch.name}: ${r.fetched} fetched, ${r.inserted} new`);
  }

  // Threads: active is one guild-wide call; archived is one call-chain PER
  // thread-PARENT-capable channel (text/announcement/forum/media — NOT just
  // text, or forum/media threads are silently missed) — sequential (not
  // Promise.all) to stay gentle on the rate limit, matching the rest of this
  // codebase's conservative pacing rather than bursting N channels at once.
  const active = await listActiveThreads(token, guildId);
  const archived: any[] = [];
  for (const ch of threadParentChannels) {
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
