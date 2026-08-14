/**
 * discord-threads — thread enumeration for `maw atlas download`'s guild-wide walk.
 *
 * Split out from lib/discord.ts so that file stays the core REST-verb surface —
 * thread enumeration is two extra endpoints, not a core primitive every command needs.
 */
import { request } from "./discord";

/** Active threads in a guild — one call, Discord returns the full set (no pagination). */
export async function listActiveThreads(token: string, guildId: string): Promise<any[]> {
  const res = await request(`/guilds/${guildId}/threads/active`, token);
  return Array.isArray(res?.threads) ? res.threads : [];
}

/**
 * Archived public threads for one channel. Paginated via `before` = the last
 * thread's `thread_metadata.archive_timestamp` (an ISO8601 string, NOT a snowflake —
 * this endpoint's cursor semantics differ from the message-history `before=`).
 */
export async function listArchivedThreads(token: string, channelId: string): Promise<any[]> {
  const all: any[] = [];
  let before: string | undefined;
  for (;;) {
    let path = `/channels/${channelId}/threads/archived/public?limit=100`;
    if (before) path += `&before=${encodeURIComponent(before)}`;
    const res = await request(path, token);
    const threads = Array.isArray(res?.threads) ? res.threads : [];
    if (!threads.length) break;
    all.push(...threads);
    if (!res.has_more) break;
    const last = threads[threads.length - 1];
    const nextBefore = last?.thread_metadata?.archive_timestamp;
    if (!nextBefore || nextBefore === before) break; // no forward progress — stop rather than loop
    before = nextBefore;
  }
  return all;
}
