#!/usr/bin/env bun
/**
 * bf — friendly CLI for Nat's Discord archive (terminal twin of the SwiftUI app).
 *
 * Pure sqlite + cache reads for dashboard/channels/view/export (no Discord API),
 * imports maw-atlas libs directly for sweep/gaps/fill — works without the web server.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";

// ── paths ──────────────────────────────────────────────────────────────────
const MAW_ATLAS = process.env.MAW_ATLAS || "/opt/Code/github.com/nat-build-with-oracle/maw-atlas";
const ATLAS_ROUTE = "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route";
const DB_PATH = process.env.ATLAS_ROUTE_DB || join(ATLAS_ROUTE, "messages.sqlite");
const STATE_PATH = process.env.ATLAS_ROUTE_STATE || join(ATLAS_ROUTE, "last-seen.json");
const GAPS_JSON = "/tmp/backfill-gaps.json";
const SWEEP_LOG = join(process.env.HOME || "/Users/nat", ".pm2/logs/mirror-ingest-sweep-out.log");
const NAMES_CACHE = join(process.env.HOME || "/Users/nat", ".cache/bf-names.json");
const CACHE_TTL_MS = 24 * 3600 * 1000;

// bare invocations of maw-atlas code must hit the real archive
process.env.ATLAS_ROUTE_DB = DB_PATH;
process.env.ATLAS_ROUTE_STATE = STATE_PATH;

// ── ansi + width-aware formatting (hand-rolled, Thai-friendly) ─────────────
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => esc("1", s);
const dim = (s: string) => esc("2", s);
const cyan = (s: string) => esc("36", s);
const green = (s: string) => esc("32", s);
const yellow = (s: string) => esc("33", s);
const red = (s: string) => esc("31", s);
const magenta = (s: string) => esc("35", s);

/** display width: Thai combining marks = 0, CJK/emoji = 2, else 1 */
function dw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0e31 || (cp >= 0x0e34 && cp <= 0x0e3a) || (cp >= 0x0e47 && cp <= 0x0e4e)) continue; // Thai combining
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining diacritics
    if (
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff)
    ) { w += 2; continue; }
    w += 1;
  }
  return w;
}
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - dw(s)));
const padL = (s: string, n: number) => " ".repeat(Math.max(0, n - dw(s))) + s;
function trunc(s: string, max: number): string {
  if (dw(s) <= max) return s;
  let out = "", w = 0;
  for (const ch of s) {
    const cw = dw(ch);
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return out + "…";
}
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ⏎ ").trim();
const num = (n: number) => n.toLocaleString("en-US");
function rel(msOrIso: number | string): string {
  const t = typeof msOrIso === "string" ? Date.parse(msOrIso) : msOrIso;
  if (!Number.isFinite(t)) return "—";
  let d = Math.max(0, Date.now() - t) / 1000;
  if (d < 60) return `${Math.floor(d)}s`;
  d /= 60; if (d < 60) return `${Math.floor(d)}m`;
  d /= 60; if (d < 48) return `${Math.floor(d)}h`;
  return `${Math.floor(d / 24)}d`;
}
function die(msg: string): never { console.error(red("✗ ") + msg); process.exit(1); }

// ── sqlite (readonly) ──────────────────────────────────────────────────────
function openDb(): Database {
  if (!existsSync(DB_PATH)) die(`ไม่พบ archive DB: ${DB_PATH}`);
  return new Database(DB_PATH, { readonly: true });
}

// ── names cache (~/.cache/bf-names.json) ───────────────────────────────────
type Names = { at: string; guilds: Record<string, string>; channels: Record<string, { name: string; guildId: string }> };
function readNamesFile(): Names | null {
  try { return JSON.parse(readFileSync(NAMES_CACHE, "utf8")); } catch { return null; }
}
async function refreshNames(): Promise<Names> {
  const { getToken, listGuilds, getGuildChannels } = await import(join(MAW_ATLAS, "lib/discord.ts"));
  const token = getToken();
  if (!token) die("ไม่มี token — ตั้ง DISCORD_BOT_TOKEN หรือ `pass insert discord/atlas-oracle-token`");
  const names: Names = { at: new Date().toISOString(), guilds: {}, channels: {} };
  const guilds = await listGuilds(token);
  for (const g of guilds) {
    names.guilds[g.id] = g.name;
    const chans = await getGuildChannels(token, g.id);
    for (const c of Array.isArray(chans) ? chans : []) {
      names.channels[c.id] = { name: c.name, guildId: g.id };
    }
  }
  mkdirSync(dirname(NAMES_CACHE), { recursive: true });
  writeFileSync(NAMES_CACHE, JSON.stringify(names, null, 1));
  return names;
}
/** cache-only read (no API) — dashboard/channels/view use this */
function namesPassive(): Names {
  return readNamesFile() ?? { at: "", guilds: {}, channels: {} };
}
/** cached if fresh (<24h), else refresh from Discord */
async function namesFresh(force = false): Promise<Names> {
  const cached = readNamesFile();
  if (!force && cached && existsSync(NAMES_CACHE) && Date.now() - statSync(NAMES_CACHE).mtimeMs < CACHE_TTL_MS) return cached;
  try { return await refreshNames(); }
  catch (e: any) {
    if (cached) { console.error(yellow(`⚠ refresh names ไม่สำเร็จ (${e?.message ?? e}) — ใช้ cache เก่า`)); return cached; }
    throw e;
  }
}
function chName(names: Names, id: string): string { return names.channels[id]?.name ? `#${names.channels[id].name}` : id; }
function chGuild(names: Names, id: string, gid?: string | null): string {
  const g = names.channels[id]?.guildId || gid || "";
  return names.guilds[g] || (g ? g.slice(0, 8) + "…" : "—");
}

// ── channel arg resolution: snowflake | #name | fragment ───────────────────
async function resolveChannel(arg: string): Promise<{ id: string; name: string | null }> {
  if (/^\d{17,20}$/.test(arg)) return { id: arg, name: namesPassive().channels[arg]?.name ?? null };
  const frag = arg.replace(/^#/, "").toLowerCase();
  const names = await namesFresh();
  const entries = Object.entries(names.channels);
  let hits = entries.filter(([, c]) => c.name.toLowerCase() === frag);
  if (!hits.length) hits = entries.filter(([, c]) => c.name.toLowerCase().includes(frag));
  if (!hits.length) die(`ไม่พบ channel "${arg}" — ลอง \`bf channels ${frag}\` หรือ \`bf channels --refresh\``);
  if (hits.length > 1) {
    console.error(red("✗ ") + `"${arg}" กำกวม — เจอ ${hits.length} channels:`);
    for (const [id, c] of hits.slice(0, 15)) {
      console.error(`  ${pad("#" + c.name, 28)} ${dim(names.guilds[c.guildId] || c.guildId)}  ${dim(id)}`);
    }
    process.exit(1);
  }
  return { id: hits[0][0], name: hits[0][1].name };
}

// ── log adapter for routeBackfill / download ────────────────────────────────
const streamLog = (s: string) => console.log(s);
async function runBackfill(args: string[]) {
  const { getToken } = await import(join(MAW_ATLAS, "lib/discord.ts"));
  const { routeBackfill } = await import(join(MAW_ATLAS, "commands/route.ts"));
  const token = getToken();
  if (!token) die("ไม่มี token — ตั้ง DISCORD_BOT_TOKEN หรือ `pass insert discord/atlas-oracle-token`");
  await routeBackfill(streamLog, token, args);
}
async function runDownload(args: string[]) {
  const { getToken } = await import(join(MAW_ATLAS, "lib/discord.ts"));
  const { run } = await import(join(MAW_ATLAS, "commands/download.ts"));
  const token = getToken();
  if (!token) die("ไม่มี token — ตั้ง DISCORD_BOT_TOKEN หรือ `pass insert discord/atlas-oracle-token`");
  await run(streamLog, token, args);
}

// ── subcommands ────────────────────────────────────────────────────────────

function cmdDashboard() {
  const db = openDb();
  const total = (db.query("SELECT COUNT(*) c FROM discord_messages").get() as any).c as number;
  const nCh = (db.query("SELECT COUNT(DISTINCT channel_id) c FROM discord_messages").get() as any).c as number;
  const nG = (db.query("SELECT COUNT(DISTINCT guild_id) c FROM discord_messages WHERE guild_id IS NOT NULL").get() as any).c as number;
  const pending = (db.query("SELECT COUNT(*) c FROM discord_messages WHERE guild_id IS NULL AND thread_id = channel_id").get() as any).c as number;
  const top = db.query(
    "SELECT channel_id id, guild_id gid, COUNT(*) n, MAX(ts) latest FROM discord_messages GROUP BY channel_id ORDER BY n DESC LIMIT 10",
  ).all() as { id: string; gid: string | null; n: number; latest: string }[];
  db.close();

  const names = namesPassive();
  const sweep = existsSync(SWEEP_LOG) ? rel(statSync(SWEEP_LOG).mtimeMs) + " ที่แล้ว" : "—";

  console.log(bold(cyan("bf")) + dim(" — Discord archive · ") + dim(DB_PATH.replace(process.env.HOME || "", "~")));
  console.log();
  console.log(`  ${pad("ข้อความทั้งหมด", 16)} ${bold(num(total))}`);
  console.log(`  ${pad("channels", 16)} ${bold(String(nCh))}   ${dim("guilds")} ${bold(String(nG))}`);
  console.log(`  ${pad("sweep ล่าสุด", 16)} ${green(sweep)}`);
  console.log(`  ${pad("รอ migrate", 16)} ${pending ? yellow(num(pending)) : green("0")}`);
  console.log();
  console.log(bold("  Top 10 channels"));
  const w1 = Math.max(...top.map(t => dw(chName(names, t.id))), 7);
  for (const t of top) {
    console.log(
      `  ${pad(cyan(chName(names, t.id)), w1 + (TTY ? 9 : 0))} ${dim(pad(trunc(chGuild(names, t.id, t.gid), 18), 18))} ${padL(num(t.n), 8)}  ${dim(rel(t.latest))}`,
    );
  }
  console.log();

  // gaps summary (fresh <24h only — else hint)
  if (existsSync(GAPS_JSON) && Date.now() - statSync(GAPS_JSON).mtimeMs < CACHE_TTL_MS) {
    try {
      const g = JSON.parse(readFileSync(GAPS_JSON, "utf8"));
      const byKind: Record<string, number> = {};
      for (const gap of g.gaps ?? []) byKind[gap.kind] = (byKind[gap.kind] ?? 0) + 1;
      const parts = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(dim(" · "));
      const nGaps = (g.gaps ?? []).length;
      console.log(
        `  ${bold("Gaps")} ${dim(`(scan ${rel(g.at)} ที่แล้ว, probe ${g.probed} ch)`)}  ` +
        (nGaps ? yellow(`${nGaps} จุด: `) + parts : green("ไม่มีช่องโหว่")),
      );
      if (nGaps) console.log(dim(`  ↳ ดูรายละเอียด/ซ่อม: bf gaps · bf fill <ch>`));
    } catch { console.log(dim(`  Gaps: อ่าน ${GAPS_JSON} ไม่ได้ — รัน bf gaps ใหม่`)); }
  } else {
    console.log(dim(`  Gaps: ยังไม่มี scan สดใน 24h — รัน ${""}bf gaps`));
  }
  if (!names.at) console.log(dim("  (ชื่อ channel ยังไม่ cache — รัน bf channels --refresh)"));
}

async function cmdSweep() {
  console.log(bold("bf sweep") + dim(" — incremental backfill ทุก channel (routeBackfill all)"));
  await runBackfill(["route", "backfill", "all"]);
}

async function cmdGaps() {
  console.log(bold("bf gaps") + dim(" — สแกนช่องโหว่ archive (detect-gaps)"));
  const proc = Bun.spawn(["bun", "scripts/detect-gaps.ts", "--json", GAPS_JSON], {
    cwd: MAW_ATLAS,
    env: { ...process.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) die(`detect-gaps exit ${code}`);
  if (!existsSync(GAPS_JSON)) die(`ไม่พบ ${GAPS_JSON} หลังสแกน`);
  const g = JSON.parse(readFileSync(GAPS_JSON, "utf8"));
  const names = namesPassive();
  console.log();
  if (!(g.gaps ?? []).length) { console.log(green("✓ ไม่มีช่องโหว่") + dim(` (probe ${g.probed} channels)`)); return; }
  console.log(bold(`เจอ ${g.gaps.length} จุด`) + dim(` (probe ${g.probed} channels)`));
  for (const gap of g.gaps) {
    const label = gap.name ? `#${gap.name}` : chName(names, gap.channelId);
    const kindC = gap.kind === "deleted" ? dim : gap.kind === "zero-row" ? red : yellow;
    console.log(`  ${pad(kindC(gap.kind), 8 + (TTY ? 8 : 0))} ${pad(trunc(label, 26), 26)} ${padL(num(gap.rows), 7)} rows  ${dim(gap.detail)}`);
    if (gap.kind !== "deleted") console.log(dim(`  ${" ".repeat(8)} ↳ bf fill ${gap.channelId}`));
  }
}

async function cmdFill(chArg?: string) {
  if (!chArg) die("ใช้: bf fill <channel>  (snowflake หรือ #ชื่อ)");
  const { id, name } = await resolveChannel(chArg);
  console.log(bold("bf fill") + dim(` — deep backfill --full → ${name ? "#" + name : id}`));
  await runBackfill(["route", "backfill", id, "--full"]);
}

async function cmdDownload(idArg?: string, rest: string[] = []) {
  if (!idArg || !/^\d{17,20}$/.test(idArg)) die("ใช้: bf download <guildId|channelId|threadId> [--max=N]  (snowflake เท่านั้น — ไม่รับ #ชื่อ)");
  console.log(bold("bf download") + dim(` — explicit full download (guild/channel/thread, ไม่มี cursor) → ${idArg}`));
  await runDownload(["download", idArg, ...rest]);
}

async function cmdView(chArg?: string, nArg?: string) {
  if (!chArg) die("ใช้: bf view <channel> [n]");
  const n = Math.min(Math.max(parseInt(nArg ?? "20", 10) || 20, 1), 500);
  const { id, name } = await resolveChannel(chArg);
  const db = openDb();
  const rows = db.query(
    "SELECT message_id, author_name, author_is_bot, content, attachments_json, ts FROM discord_messages WHERE channel_id = ? ORDER BY ts DESC LIMIT ?",
  ).all(id, n) as any[];
  db.close();
  if (!rows.length) die(`channel ${name ? "#" + name : id} ยังไม่มีข้อความใน archive — ลอง bf fill ${id}`);
  rows.reverse();
  const cols = process.stdout.columns || 120;
  console.log(bold(cyan(name ? `#${name}` : id)) + dim(` — ${rows.length} ข้อความล่าสุด (เก่า→ใหม่)`));
  const wAuthor = Math.min(Math.max(...rows.map(r => dw(r.author_name ?? "?") + (r.author_is_bot ? 4 : 0)), 6), 22);
  for (const r of rows) {
    const t = padL(rel(r.ts), 4);
    const author = (r.author_name ?? "?") + (r.author_is_bot ? dim("⚙bot") : "");
    let content = oneLine(r.content ?? "");
    const nAtt = r.attachments_json ? (JSON.parse(r.attachments_json)?.length ?? 0) : 0;
    if (nAtt) content += ` 📎${nAtt}`;
    if (!content) content = dim("(ว่าง)");
    const room = Math.max(cols - 4 - 2 - wAuthor - 2, 20);
    console.log(`${dim(t)}  ${pad(magenta(author), wAuthor + (TTY ? 9 : 0) + (r.author_is_bot && TTY ? 4 : 0))}  ${trunc(content, room)}`);
  }
}

async function cmdExport(chArg?: string, rest: string[] = []) {
  if (!chArg) die("ใช้: bf export <channel> [--csv] [-o path]");
  const csv = rest.includes("--csv");
  const oIdx = rest.findIndex(a => a === "-o" || a === "--out");
  const outArg = oIdx >= 0 ? rest[oIdx + 1] : undefined;
  const { id, name } = await resolveChannel(chArg);
  const db = openDb();
  const rows = db.query("SELECT * FROM discord_messages WHERE channel_id = ? ORDER BY ts").all(id) as any[];
  db.close();
  if (!rows.length) die(`channel ${name ? "#" + name : id} ไม่มีข้อความใน archive`);
  // default filename carries the channel id — two #general in different guilds
  // must never silently clobber each other's export
  const label = (name ?? id).replace(/[^\w฀-๿-]+/g, "_");
  const ext = csv ? "csv" : "json";
  const out = resolve(outArg ?? `./${label}.${id}.${ext}`);
  if (!outArg && existsSync(out)) die(`${out} มีอยู่แล้ว — ใช้ -o path ถ้าต้องการเขียนทับ`);
  if (csv) {
    const cols = Object.keys(rows[0]);
    const escCsv = (v: any) => {
      const s = v == null ? "" : String(v);
      // bare \r included: a lone CR desyncs RFC-4180 parsers if left unquoted
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(","), ...rows.map(r => cols.map(c => escCsv(r[c])).join(","))];
    writeFileSync(out, lines.join("\n") + "\n");
  } else {
    writeFileSync(out, JSON.stringify(rows, null, 1));
  }
  console.log(green("✓ ") + `export ${bold(num(rows.length))} ข้อความ ${name ? cyan("#" + name) : id} → ${out}`);
}

async function cmdChannels(rest: string[]) {
  const refresh = rest.includes("--refresh");
  const query = rest.filter(a => !a.startsWith("--"))[0]?.replace(/^#/, "").toLowerCase();
  const names = refresh ? await namesFresh(true) : namesPassive();
  const db = openDb();
  const chans = db.query(
    "SELECT channel_id id, guild_id gid, COUNT(*) n, MAX(ts) latest FROM discord_messages GROUP BY channel_id ORDER BY n DESC",
  ).all() as { id: string; gid: string | null; n: number; latest: string }[];
  db.close();
  let list = chans;
  if (query) {
    list = chans.filter(c =>
      c.id.includes(query) ||
      chName(names, c.id).toLowerCase().includes(query) ||
      chGuild(names, c.id, c.gid).toLowerCase().includes(query));
  }
  if (!list.length) die(`ไม่พบ channel ตรงกับ "${query}"` + (names.at ? "" : " — ลอง bf channels --refresh"));
  const w1 = Math.min(Math.max(...list.map(c => dw(chName(names, c.id))), 7), 30);
  console.log(dim(`${list.length} channels` + (query ? ` · filter "${query}"` : "") + (names.at ? ` · names cache ${rel(names.at)} ที่แล้ว` : " · ยังไม่มี names cache (bf channels --refresh)")));
  for (const c of list) {
    console.log(
      `  ${pad(cyan(trunc(chName(names, c.id), 30)), w1 + (TTY ? 9 : 0))} ${dim(pad(trunc(chGuild(names, c.id, c.gid), 20), 20))} ${padL(num(c.n), 8)}  ${dim(padL(rel(c.latest), 4))}`,
    );
  }
}

function cmdHelp() {
  console.log(`${bold(cyan("bf"))} — Discord archive CLI ${dim("(อ่าน sqlite ตรง ไม่ต้องรัน server)")}

${bold("ใช้งาน")}
  bf                    dashboard: ยอดรวม, sweep ล่าสุด, top channels, gaps
  bf sweep              ดึงข้อความใหม่ทุก channel (incremental)
  bf gaps               สแกนหาช่องโหว่ประวัติ → ${GAPS_JSON}
  bf fill <ch>          deep backfill ย้อนประวัติทั้งหมดของ channel เดียว (--full)
  bf download <id> [--max=N]   ดาวน์โหลดทั้ง guild/channel/thread แบบ explicit ${dim("(ไม่มี cursor, snowflake เท่านั้น)")}
  bf view <ch> [n]      ดู n ข้อความล่าสุด (default 20)
  bf export <ch> [--csv] [-o path]   export JSON (default) หรือ CSV
  bf channels [query] [--refresh]    รายชื่อ channel ทั้งหมด (refresh = ดึงชื่อใหม่จาก Discord)
  bf help               หน้านี้

${bold("<ch>")} รับได้ทั้ง snowflake, #ชื่อ, หรือเศษชื่อ ${dim("(กำกวม = โชว์ตัวเลือกแล้วออก)")}
${bold("<id>")} (สำหรับ download) รับเฉพาะ snowflake ${dim("(guild, channel, หรือ thread — ตรวจชนิดอัตโนมัติ)")}

${bold("ตัวอย่าง")}
  bf view #general 50
  bf fill oracle-log
  bf download 1500665320501940267        ${dim("← ทั้ง guild (channels+threads)")}
  bf export 1391430075695693937 --csv -o /tmp/log.csv
  bf channels atlas`);
}

// ── main ───────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case undefined: case "dash": case "status": cmdDashboard(); break;
    case "sweep": await cmdSweep(); break;
    case "gaps": await cmdGaps(); break;
    case "fill": await cmdFill(rest[0]); break;
    case "download": await cmdDownload(rest[0], rest.slice(1)); break;
    case "view": await cmdView(rest[0], rest[1]); break;
    case "export": await cmdExport(rest[0], rest.slice(1)); break;
    case "channels": case "ch": await cmdChannels(rest); break;
    case "help": case "-h": case "--help": cmdHelp(); break;
    default: console.error(red("✗ ") + `ไม่รู้จักคำสั่ง "${cmd}" — bf help`); process.exit(1);
  }
} catch (e: any) {
  die(e?.message ?? String(e));
}
