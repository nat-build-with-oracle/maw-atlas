/**
 * download-target — the shared paging+insert loop for `maw atlas download`.
 *
 * Walks ONE target (a plain channel or a thread — Discord's message-history
 * endpoint is identical for both) backward to the bottom of its history.
 * Idempotent (INSERT OR IGNORE on message_id, same as everywhere else in this
 * archive) — safe to re-run any time. Deliberately separate from
 * commands/route.ts's backfillChannel*: download has no cursor/mode concept
 * (see ψ/incubate/nat-build-with-oracle/maw-atlas/SPEC-download-command.md in
 * atlas-oracle), so sharing that code would mean threading unused params
 * through it. NEVER reads or writes last-seen.json — fully standalone.
 */
import { getMessages } from "./discord";
import type { MessageStore, DiscordMsgRow } from "./discord-db";

const DISCORD_EPOCH = 1420070400000n;
function snowflakeToIso(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
}

function toRow(msg: any, dbChannelId: string, guildId: string | null, dbThreadId: string | null): DiscordMsgRow {
  return {
    message_id: msg.id,
    channel_id: dbChannelId,
    thread_id: dbThreadId,
    guild_id: guildId,
    author_id: msg.author?.id || "",
    author_name: msg.author?.global_name || msg.author?.username || null,
    author_is_bot: msg.author?.bot ? 1 : 0,
    content: msg.content ?? null,
    attachments_json: msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
    ts: snowflakeToIso(msg.id),
    created_at: new Date().toISOString(),
  };
}

export interface WalkOpts {
  /** Positive integer or Infinity — Infinity is the default (no forced cap; see SPEC). */
  max: number;
  verbose: boolean;
}

export interface WalkResult {
  fetched: number;
  inserted: number;
}

/**
 * @param fetchId    the id to call GET /channels/:id/messages on — a channel id
 *                    or a thread id, same endpoint either way.
 * @param dbChannelId what to store in the `channel_id` column — the PARENT
 *                    channel id when fetchId is a thread, else = fetchId.
 * @param dbThreadId  what to store in the `thread_id` column — the thread's own
 *                    id, or null for a plain channel. Never hardcoded to
 *                    dbChannelId (that was the pre-fix bug this feature exists
 *                    to not repeat).
 */
export async function walkTarget(
  token: string, store: MessageStore, fetchId: string,
  dbChannelId: string, dbThreadId: string | null, guildId: string | null,
  opts: WalkOpts,
): Promise<WalkResult> {
  let before: string | undefined;
  let fetched = 0, inserted = 0;
  while (fetched < opts.max) {
    const batch = await getMessages(token, fetchId, 100, before);
    if (!Array.isArray(batch) || !batch.length) break;
    for (const m of batch) {
      if (!m.id) continue;
      fetched++;
      inserted += store.insert(toRow(m, dbChannelId, guildId, dbThreadId));
    }
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
    await new Promise(r => setTimeout(r, 400)); // gentle on the rate limit, same pacing as route backfill
  }
  return { fetched, inserted };
}
