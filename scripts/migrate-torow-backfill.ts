/**
 * migrate-torow-backfill — repair rows written before fa81daf, which hardcoded
 * thread_id = channel_id and guild_id = NULL on every insert (issue #3).
 *
 * Bad-row signature (exact): guild_id IS NULL AND thread_id = channel_id.
 * Post-fix rows never match it (real threads get thread_id ≠ channel_id after
 * the parent_id swap; plain channels get thread_id NULL).
 *
 * Repair, per distinct channel_id among bad rows, resolved via one cached
 * GET /channels/{id} (inherits 429 backoff from lib/discord):
 *   - plain channel → guild_id = resolved, thread_id = NULL
 *   - thread (type 10/11/12) → guild_id = resolved, thread_id stays = the id,
 *     channel_id = parent_id (post-fix column convention)
 *   - 404/403 (deleted/lost access) → rows left untouched, reported
 *
 * Usage: bun scripts/migrate-torow-backfill.ts [--db path] [--apply]
 * Dry-run by default. --apply requires a fresh .bak-* backup next to the db.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "fs";
import { basename, dirname } from "path";
import { request, getToken } from "../lib/discord";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1]
  : "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite";

if (!existsSync(dbPath)) { console.error(`db not found: ${dbPath}`); process.exit(1); }
if (apply) {
  const backups = readdirSync(dirname(dbPath)).filter(f => f.startsWith(`${basename(dbPath)}.bak-`));
  if (!backups.length) { console.error("refusing --apply: no .bak-* backup next to db — copy it first"); process.exit(1); }
}

const token = getToken();
if (!token) { console.error("no DISCORD_BOT_TOKEN / pass token"); process.exit(1); }

const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true });
const BAD = "guild_id IS NULL AND thread_id = channel_id";

const total = (db.query(`SELECT COUNT(*) c FROM discord_messages WHERE ${BAD}`).get() as any).c;
const channels = db.query(
  `SELECT channel_id id, COUNT(*) n FROM discord_messages WHERE ${BAD} GROUP BY channel_id ORDER BY n DESC`,
).all() as Array<{ id: string; n: number }>;
console.log(`${total} bad rows across ${channels.length} channels (${apply ? "APPLY" : "dry-run"})`);

const THREAD_TYPES = new Set([10, 11, 12]);
let fixedPlain = 0, fixedThread = 0, unresolved = 0;
const plan: Array<{ id: string; n: number; guildId: string; parentId: string | null; isThread: boolean }> = [];

for (const ch of channels) {
  try {
    const meta = await request(`/channels/${ch.id}`, token!);
    const guildId = meta?.guild_id ?? null;
    if (!guildId) { console.log(`  ? ${ch.id} (${ch.n}) resolved but no guild_id (DM?) — skipped`); unresolved += ch.n; continue; }
    const isThread = THREAD_TYPES.has(meta?.type);
    plan.push({ id: ch.id, n: ch.n, guildId, parentId: meta?.parent_id ?? null, isThread });
    if (isThread) fixedThread += ch.n; else fixedPlain += ch.n;
  } catch (e) {
    console.log(`  ✗ ${ch.id} (${ch.n} rows) unresolved: ${e instanceof Error ? e.message : e}`);
    unresolved += ch.n;
  }
  await new Promise(r => setTimeout(r, 150)); // gentle pacing on top of backoff
}

console.log(`plan: ${fixedPlain} rows in plain channels, ${fixedThread} rows in threads, ${unresolved} unresolvable`);

if (!apply) {
  for (const p of plan.slice(0, 10)) {
    console.log(`  would fix ${p.id} (${p.n}): guild=${p.guildId}${p.isThread ? ` thread→channel_id=${p.parentId}` : " thread_id→NULL"}`);
  }
  if (plan.length > 10) console.log(`  ... and ${plan.length - 10} more channels`);
  console.log("dry-run only — rerun with --apply (after backing up the db) to write");
  process.exit(0);
}

db.exec("BEGIN");
try {
  const fixPlain = db.prepare(`UPDATE discord_messages SET guild_id = ?, thread_id = NULL WHERE channel_id = ? AND ${BAD}`);
  const fixThread = db.prepare(`UPDATE discord_messages SET guild_id = ?, channel_id = ? WHERE channel_id = ? AND ${BAD}`);
  let changed = 0;
  for (const p of plan) {
    // thread rows keep thread_id (= the real thread id); channel_id becomes the parent.
    // guard: a thread with no parent_id shouldn't exist — treat as plain to avoid nulling channel_id.
    changed += (p.isThread && p.parentId
      ? fixThread.run(p.guildId, p.parentId, p.id)
      : fixPlain.run(p.guildId, p.id)).changes;
  }
  db.exec("COMMIT");
  const remaining = (db.query(`SELECT COUNT(*) c FROM discord_messages WHERE ${BAD}`).get() as any).c;
  console.log(`✓ applied: ${changed} rows updated, ${remaining} bad rows remaining (unresolvable channels)`);
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
} finally {
  db.close();
}
