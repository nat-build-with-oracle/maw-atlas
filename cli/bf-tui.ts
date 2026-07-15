#!/usr/bin/env bun
/**
 * bf-tui — cookbook technique: interactive TERMINAL dashboard (btop-style).
 * Alt-screen, live refresh, keybindings. Distinct from `bf` (one-shot commands):
 * this one stays open and watches the archive breathe.
 *
 * keys: j/k scroll · / filter · s sweep · g gap scan · r refresh · q quit
 */
import { Database } from "bun:sqlite";
import { statSync, existsSync, readFileSync } from "fs";
import { spawn } from "child_process";

const DB = process.env.ATLAS_ROUTE_DB
  || "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite";
const SWEEP_LOG = `${process.env.HOME}/.pm2/logs/mirror-ingest-sweep-out.log`;
const GAPS_JSON = "/tmp/backfill-gaps.json";
const NAMES_CACHE = `${process.env.HOME}/.cache/bf-names.json`;
const MAW_ATLAS = process.env.MAW_ATLAS || "/opt/Code/github.com/nat-build-with-oracle/maw-atlas";

// ── ansi ──
const ESC = "\x1b[";
const alt = (on: boolean) => process.stdout.write(ESC + (on ? "?1049h" + ESC + "?25l" : "?25h" + ESC + "?1049l"));
const clear = () => process.stdout.write(ESC + "2J" + ESC + "H");
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const inv = (s: string) => `\x1b[7m${s}\x1b[0m`;
const num = (n: number) => n.toLocaleString("en-US");

function rel(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${s | 0}s`;
  if (s < 5400) return `${(s / 60) | 0}m`;
  if (s < 129600) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

// ── data ──
type Row = { id: string; n: number; latest: string; name: string; guild: string };
// cache shape (written by bf): { at, guilds: {gid: name}, channels: {id: {name, guildId}} }
let names: Record<string, { name: string; guild: string }> = {};
try {
  const raw = JSON.parse(readFileSync(NAMES_CACHE, "utf8"));
  const guilds = raw.guilds || {};
  for (const [id, c] of Object.entries((raw.channels || {}) as Record<string, any>)) {
    names[id] = { name: c.name, guild: guilds[c.guildId] || "" };
  }
} catch {}

function load(): { total: number; channels: Row[]; sweepAt: number; gaps: number } {
  const db = new Database(DB, { readonly: true });
  try {
    const total = (db.query("SELECT COUNT(*) c FROM discord_messages").get() as any).c;
    const channels = (db.query(`
      SELECT channel_id id, COUNT(*) n, MAX(ts) latest FROM discord_messages
      GROUP BY channel_id ORDER BY n DESC`).all() as any[]).map(c => ({
      ...c,
      name: names[c.id]?.name ? `#${names[c.id].name}` : c.id,
      guild: names[c.id]?.guild || "",
    }));
    let sweepAt = 0;
    try { sweepAt = statSync(SWEEP_LOG).mtimeMs; } catch {}
    let gaps = 0;
    try { gaps = JSON.parse(readFileSync(GAPS_JSON, "utf8")).gaps.length; } catch {}
    return { total, channels, sweepAt, gaps };
  } finally { db.close(); }
}

// ── job (sweep / gaps) — one at a time, tail its last line ──
let jobTitle = "";
let jobLast = "";
let jobRunning = false;
function runJob(title: string, argv: string[]) {
  if (jobRunning) { jobLast = "มี job รันอยู่"; return; }
  jobTitle = title; jobRunning = true; jobLast = "เริ่ม…";
  const child = spawn("bun", argv, { cwd: MAW_ATLAS, env: { ...process.env, ATLAS_ROUTE_DB: DB } });
  const tail = (b: any) => { const ls = String(b).split("\n").filter((l: string) => l.trim()); if (ls.length) jobLast = ls[ls.length - 1].slice(0, 120); };
  child.stdout.on("data", tail);
  child.stderr.on("data", tail);
  child.on("close", code => { jobRunning = false; jobLast = `${title} จบ (exit ${code})`; render(); });
}

// ── state + render ──
let offset = 0;
let filter = "";
let filterMode = false;
let data = load();

function render() {
  const { rows: H, columns: W } = { rows: process.stdout.rows || 40, columns: process.stdout.columns || 100 };
  clear();
  const out: string[] = [];
  const age = data.sweepAt ? rel(data.sweepAt) : "?";
  const ageCol = data.sweepAt && Date.now() - data.sweepAt < 15 * 60_000 ? green(age) : yellow(age);
  out.push(bold(cyan("🌊 bf-tui")) + dim(" — Discord archive ledger") +
    `   ${bold(num(data.total))} ข้อความ · sweep ${ageCol} ที่แล้ว · gaps ${data.gaps ? red(String(data.gaps)) : green("0")}`);
  out.push(dim("─".repeat(Math.min(W, 110))));

  const list = data.channels.filter(c => !filter || (c.name + c.guild + c.id).toLowerCase().includes(filter.toLowerCase()));
  const body = H - 6;
  offset = Math.max(0, Math.min(offset, Math.max(0, list.length - body)));
  const slice = list.slice(offset, offset + body);
  const nameW = Math.min(34, Math.max(...slice.map(c => [...c.name].length), 8));
  for (const [i, c] of slice.entries()) {
    const idx = String(offset + i + 1).padStart(3, "0");
    const nm = c.name.length > nameW ? c.name.slice(0, nameW - 1) + "…" : c.name.padEnd(nameW);
    const gl = (c.guild || "—").slice(0, 24).padEnd(24);
    const line = `${dim(idx)}  ${cyan(nm)}  ${dim(gl)}  ${num(c.n).padStart(9)}  ${dim(rel(c.latest))}`;
    out.push(i === 0 && offset > 0 ? line + dim("  ↑") : line);
  }
  if (list.length > offset + body) out.push(dim(`  … อีก ${list.length - offset - body} channels (j เลื่อนลง)`));

  out.push(dim("─".repeat(Math.min(W, 110))));
  if (jobRunning || jobLast) out.push((jobRunning ? yellow("⏳ ") : green("✓ ")) + dim(jobTitle + " · ") + jobLast.slice(0, W - 10));
  out.push(filterMode
    ? inv(` / ${filter}▌ `) + dim("  (enter ยืนยัน · esc ล้าง)")
    : dim("j/k เลื่อน · / กรอง · s sweep · g gaps · r refresh · q ออก") + (filter ? yellow(`   กรอง: ${filter}`) : ""));
  process.stdout.write(out.join("\n"));
}

// ── input ──
if (!process.stdin.isTTY) { console.error("bf-tui ต้องรันใน terminal จริง (interactive tty)"); process.exit(1); }
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (buf: Buffer) => {
  const k = buf.toString();
  if (filterMode) {
    if (k === "\r") filterMode = false;
    else if (k === "\x1b") { filterMode = false; filter = ""; }
    else if (k === "\x7f") filter = filter.slice(0, -1);
    else if (k >= " ") filter += k;
    offset = 0;
    render();
    return;
  }
  if (k === "q" || k === "\x03") { alt(false); process.exit(0); }
  if (k === "j" || k === ESC + "B") { offset++; render(); }
  if (k === "k" || k === ESC + "A") { offset = Math.max(0, offset - 1); render(); }
  if (k === "/") { filterMode = true; render(); }
  if (k === "r") { data = load(); render(); }
  if (k === "s") { runJob("sweep", ["index.ts", "route", "backfill", "all"]); render(); }
  if (k === "g") { runJob("gap scan", ["scripts/detect-gaps.ts", "--json", GAPS_JSON]); render(); }
});

// ── loop ──
alt(true);
render();
const tick = setInterval(() => { data = load(); render(); }, 5000);
process.on("exit", () => { clearInterval(tick); alt(false); });
process.on("SIGINT", () => { alt(false); process.exit(0); });
process.on("SIGTERM", () => { alt(false); process.exit(0); });
