/**
 * detect-gaps — find where the Discord archive is incomplete (task 3, backfill charter).
 *
 * Gap classes:
 *   zero-row  — text channel the bot can see, with no rows in the archive at all
 *   bottom    — history exists OLDER than our oldest archived row (probe: one
 *               `before=MIN(message_id)` page; non-empty ⇒ backfill never reached the floor)
 *   cursor    — :oldest cursor in last-seen.json is older than MIN(message_id) ⇒ rows
 *               between them were lost (interrupted walk) — resume re-fetches them
 *   deleted   — archived channel Discord now 404s (can't verify; kept per Nothing is Deleted)
 *
 * Fix for zero-row/bottom/cursor is the same verb: `route backfill <channelId> --full`
 * (deep walk resuming older from the :oldest cursor; idempotent).
 *
 * Usage: bun scripts/detect-gaps.ts [--db path] [--json out.json]
 * Read-only: never writes to the archive or cursors.
 */
import { Database } from "bun:sqlite";
import { writeFileSync, readFileSync } from "fs";
import { request, getToken, listGuilds, getGuildChannels, filterTextChannels } from "../lib/discord";

const args = process.argv.slice(2);
const val = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DB_PATH = val("--db") || "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite";
const STATE_PATH = val("--state") || "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/last-seen.json";
const JSON_OUT = val("--json");

const token = getToken();
if (!token) { console.error("no DISCORD_BOT_TOKEN / pass token"); process.exit(1); }

const db = new Database(DB_PATH, { readonly: true });
const pause = () => new Promise(r => setTimeout(r, 150));
const snowflakeToIso = (id: string) => new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();

// archived plain-channel stats (threads ride along inside their parent channel)
const archived = db.query(`
  SELECT channel_id id, COUNT(*) n, MIN(message_id) min_id, MAX(ts) latest
  FROM discord_messages WHERE thread_id IS NULL OR thread_id != channel_id
  GROUP BY channel_id`).all() as Array<{ id: string; n: number; min_id: string; latest: string }>;
const archivedMap = new Map(archived.map(c => [c.id, c]));

let cursors: Record<string, string> = {};
try { cursors = JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch {}

type Gap = { kind: "zero-row" | "bottom" | "cursor" | "deleted"; channelId: string; name: string | null; guild: string | null; rows: number; detail: string };
const gaps: Gap[] = [];
// 401/403 = credential/permission signal — heimdall (Bifröst, token-health ledger
// of record) wants these as events; 404 = channel gone, archive-domain only.
const authFailures: Array<{ channelId: string; name: string | null; status: number }> = [];

// ── live channel list (bot's view of Discord truth) ──
console.log("loading live guild/channel list…");
const liveChannels = new Map<string, { name: string; guild: string }>();
const guilds = await listGuilds(token!);
for (const g of Array.isArray(guilds) ? guilds : []) {
  const chs = await getGuildChannels(token!, g.id);
  for (const c of filterTextChannels(Array.isArray(chs) ? chs : [])) liveChannels.set(c.id, { name: c.name, guild: g.name });
  await pause();
}
console.log(`${liveChannels.size} live text channels, ${archived.length} archived channels`);

// class 1: zero-row — probe limit=1 so genuinely-empty channels don't count as gaps
for (const [id, meta] of liveChannels) {
  if (archivedMap.has(id)) continue;
  try {
    const probe = await request(`/channels/${id}/messages?limit=1`, token!);
    if (Array.isArray(probe) && probe.length > 0) {
      gaps.push({ kind: "zero-row", channelId: id, name: meta.name, guild: meta.guild, rows: 0, detail: "มีข้อความบน Discord แต่ archive ว่าง — ยังไม่เคยถูก backfill" });
    }
  } catch { /* no read access — skip */ }
  await pause();
}

// class 2+3: bottom probe + cursor mismatch per archived channel
let probed = 0;
for (const ch of archived) {
  const live = liveChannels.get(ch.id);
  const label = live?.name || ch.id;
  const oldestKey = `${ch.id}:oldest`;

  // bottom probe first (a 404/403 here means cursor holes aren't fixable either)
  let gone = false;
  try {
    const page = await request(`/channels/${ch.id}/messages?limit=100&before=${ch.min_id}`, token!);
    probed++;
    if (Array.isArray(page) && page.length > 0) {
      gaps.push({ kind: "bottom", channelId: ch.id, name: live?.name || null, guild: live?.guild || null, rows: ch.n,
        detail: `มีอย่างน้อย ${page.length}${page.length === 100 ? "+" : ""} ข้อความเก่ากว่าที่เก็บถึง (${snowflakeToIso(ch.min_id).slice(0, 10)})` });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(" 401 ") || msg.includes(" 403 ")) {
      authFailures.push({ channelId: ch.id, name: live?.name || null, status: msg.includes(" 401 ") ? 401 : 403 });
    }
    if (msg.includes(" 404 ") || msg.includes(" 403 ")) {
      gone = true;
      gaps.push({ kind: "deleted", channelId: ch.id, name: live?.name || null, guild: live?.guild || null, rows: ch.n,
        detail: `Discord ${msg.includes(" 404 ") ? "404" : "403"} — channel หาย/หมดสิทธิ์ (เก็บ ${ch.n} rows ไว้ตามเดิม)` });
    } else if (!msg.includes(" 401 ")) {
      console.log(`  ! probe ${label}: ${msg}`);
    }
  }

  // cursor mismatch: cursor older than our oldest row ⇒ hole between them
  // (skip if the channel is gone — those messages died with it)
  const cur = cursors[oldestKey];
  if (!gone && cur && BigInt(cur) < BigInt(ch.min_id)) {
    gaps.push({ kind: "cursor", channelId: ch.id, name: live?.name || null, guild: live?.guild || null, rows: ch.n,
      detail: `cursor ${snowflakeToIso(cur).slice(0, 10)} เก่ากว่า row แรกที่มี ${snowflakeToIso(ch.min_id).slice(0, 10)} — มี hole ระหว่างกลาง` });
  }
  await pause();
}

const order = { "zero-row": 0, bottom: 1, cursor: 2, deleted: 3 } as const;
gaps.sort((a, b) => order[a.kind] - order[b.kind] || b.rows - a.rows);

console.log(`\nprobed ${probed} channels — พบ ${gaps.length} gaps:`);
for (const g of gaps) {
  console.log(`  [${g.kind}] ${g.name ? "#" + g.name : g.channelId} (${g.guild || "?"}) — ${g.detail}`);
}
const fixable = gaps.filter(g => g.kind !== "deleted");
console.log(`\n${fixable.length} แก้ได้ด้วย route backfill <channelId> --full · ${gaps.length - fixable.length} เป็น channel ที่หายไปแล้ว`);

if (authFailures.length) console.log(`⚠ auth failures (401/403): ${authFailures.map(a => `${a.name || a.channelId}:${a.status}`).join(", ")}`);
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), probed, gaps, authFailures }, null, 1));
  console.log(`json → ${JSON_OUT}`);
}
db.close();
