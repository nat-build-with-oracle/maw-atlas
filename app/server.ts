/**
 * Backfill app — producer control panel for the Discord archive.
 * กดปุ่ม → download (backfill) → เห็นข้อมูล. Owner: atlas-discord-backfill-oracle.
 *
 * Consumer-side viewing (serve/blogs/MirrorView) belongs to mirror-oracle —
 * this panel only drives INGEST and inspects the raw archive.
 *
 * Run: bun app/server.ts   → http://localhost:47710
 */
import { Database } from "bun:sqlite";
import { spawn } from "child_process";
import { statSync } from "fs";
import { join } from "path";

const MAW_ATLAS = process.env.MAW_ATLAS || "/opt/Code/github.com/nat-build-with-oracle/maw-atlas";
const DB_PATH = process.env.ATLAS_ROUTE_DB
  || "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite";
const SWEEP_LOG = "/Users/nat/.pm2/logs/mirror-ingest-sweep-out.log";
const GAPS_JSON = "/tmp/backfill-gaps.json";
const PORT = Number(process.env.BACKFILL_APP_PORT || 47710);

const { getToken, listGuilds, getGuildChannels } = await import(join(MAW_ATLAS, "lib/discord.ts"));

// ── channel/guild name cache (one REST sweep, refreshable) ──
let names: { guilds: Record<string, string>; channels: Record<string, { name: string; guildId: string }> } = { guilds: {}, channels: {} };
let namesAt = 0;
async function refreshNames(): Promise<void> {
  const token = getToken();
  if (!token) return;
  const out: typeof names = { guilds: {}, channels: {} };
  const guilds = await listGuilds(token);
  for (const g of Array.isArray(guilds) ? guilds : []) {
    out.guilds[g.id] = g.name;
    const chs = await getGuildChannels(token, g.id);
    for (const c of Array.isArray(chs) ? chs : []) out.channels[c.id] = { name: c.name, guildId: g.id };
  }
  names = out;
  namesAt = Date.now();
}

// ── one job at a time (sweep or per-channel backfill) ──
type Job = { title: string; startedAt: string; lines: string[]; done: boolean; code: number | null };
let job: Job | null = null;
function startJob(title: string, argv: string[]): boolean {
  if (job && !job.done) return false;
  const j: Job = { title, startedAt: new Date().toISOString(), lines: [], done: false, code: null };
  job = j;
  const child = spawn("bun", argv, {
    cwd: MAW_ATLAS,
    env: { ...process.env, ATLAS_ROUTE_DB: DB_PATH },
  });
  const push = (buf: any) => {
    for (const l of String(buf).split("\n")) if (l.trim()) { j.lines.push(l); if (j.lines.length > 500) j.lines.shift(); }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("close", code => { j.done = true; j.code = code; j.lines.push(`— จบ (exit ${code}) —`); });
  return true;
}

function db(): Database { return new Database(DB_PATH, { readonly: true }); }

function stats() {
  const d = db();
  try {
    const total = (d.query("SELECT COUNT(*) c FROM discord_messages").get() as any).c;
    const badRows = (d.query("SELECT COUNT(*) c FROM discord_messages WHERE guild_id IS NULL AND thread_id = channel_id").get() as any).c;
    const channels = d.query(`
      SELECT channel_id id, guild_id gid, COUNT(*) n, MAX(ts) latest
      FROM discord_messages GROUP BY channel_id ORDER BY n DESC`).all() as any[];
    let lastSweep: string | null = null;
    try { lastSweep = statSync(SWEEP_LOG).mtime.toISOString(); } catch {}
    return {
      total, badRows, lastSweep, namesAt,
      guilds: names.guilds,
      channels: channels.map(c => ({
        ...c,
        name: names.channels[c.id]?.name || null,
        guildName: names.guilds[c.gid] || names.guilds[names.channels[c.id]?.guildId] || null,
      })),
    };
  } finally { d.close(); }
}

function messages(channelId: string, limit: number) {
  const d = db();
  try {
    return d.query(`
      SELECT message_id, channel_id, thread_id, author_name, author_is_bot, content, attachments_json, ts
      FROM discord_messages WHERE channel_id = ? ORDER BY ts DESC LIMIT ?`).all(channelId, Math.min(limit, 500));
  } finally { d.close(); }
}

function exportRows(channelId: string): any[] {
  const d = db();
  try {
    return d.query("SELECT * FROM discord_messages WHERE channel_id = ? ORDER BY ts").all(channelId);
  } finally { d.close(); }
}

function csvEscape(v: any): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const INDEX = Bun.file(join(import.meta.dir, "index.html"));

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const json = (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (p === "/") return new Response(INDEX, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/api/stats") return json(stats());
    if (p === "/api/names/refresh" && req.method === "POST") { await refreshNames(); return json({ ok: true, namesAt }); }
    if (p === "/api/messages") {
      const ch = url.searchParams.get("channel_id") || "";
      if (!/^\d{17,20}$/.test(ch)) return json({ error: "bad channel_id" }, 400);
      return json(messages(ch, Number(url.searchParams.get("limit") || 50)));
    }
    if (p === "/api/job") return json(job || { done: true, lines: [], title: null });
    if (p === "/api/sweep" && req.method === "POST") {
      return startJob("Sweep ทุก channel (incremental)", ["index.ts", "route", "backfill", "all"])
        ? json({ ok: true }) : json({ error: "มี job ค้างอยู่" }, 409);
    }
    if (p === "/api/backfill" && req.method === "POST") {
      const { channelId } = await req.json().catch(() => ({} as any));
      if (!/^\d{17,20}$/.test(channelId || "")) return json({ error: "bad channelId" }, 400);
      const label = names.channels[channelId]?.name || channelId;
      // --full: per-channel backfill from the app means "give me the whole history /
      // fill the bottom gap", not the cursor sweep (that's the sweep button)
      return startJob(`Backfill เต็ม #${label}`, ["index.ts", "route", "backfill", channelId, "--full"])
        ? json({ ok: true }) : json({ error: "มี job ค้างอยู่" }, 409);
    }
    if (p === "/api/gaps/scan" && req.method === "POST") {
      return startJob("สแกนหา gaps ทุก channel", ["scripts/detect-gaps.ts", "--json", GAPS_JSON])
        ? json({ ok: true }) : json({ error: "มี job ค้างอยู่" }, 409);
    }
    if (p === "/api/gaps") {
      try { return json(JSON.parse(await Bun.file(GAPS_JSON).text())); }
      catch { return json({ at: null, gaps: [] }); }
    }
    if (p === "/api/export") {
      const ch = url.searchParams.get("channel_id") || "";
      const fmt = url.searchParams.get("format") || "json";
      if (!/^\d{17,20}$/.test(ch)) return json({ error: "bad channel_id" }, 400);
      const rows = exportRows(ch);
      const label = (names.channels[ch]?.name || ch).replace(/[^\w฀-๿-]+/g, "_");
      if (fmt === "csv") {
        const cols = rows.length ? Object.keys(rows[0]) : [];
        const csv = [cols.join(","), ...rows.map(r => cols.map(c => csvEscape((r as any)[c])).join(","))].join("\n");
        return new Response(csv, { headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${label}.csv"`,
        } });
      }
      return new Response(JSON.stringify(rows, null, 1), { headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${label}.json"`,
      } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`🌊📜 Backfill app: http://localhost:${PORT} (db: ${DB_PATH})`);
refreshNames().then(() => console.log(`names loaded: ${Object.keys(names.channels).length} channels`)).catch(e => console.log(`name refresh failed: ${e}`));
