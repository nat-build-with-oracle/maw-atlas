/**
 * maw atlas route — bridge Discord threads ↔ Codex panes.
 *
 * Issue #2 lifecycle scope:
 *   - start: spawn a background daemon process
 *   - stop: kill daemon by PID file
 *   - status: show active thread routes + last poll/message time
 *   - sync: rebuild .discord/thread-routing.json from maw team charters + atlas threads
 *
 * Forward bridge scope from codex-1 is preserved under daemon/watch/once:
 *   Discord thread message → maw hey <pane> <message>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFile, spawn } from "child_process";
import { findAtlasRepo } from "../lib/repo";
import { openMessageStore, type MessageStore, type DiscordMsgRow } from "../lib/discord-db";

type Log = (s: string) => void;

type RouteEntry = {
  name?: string;
  pane: string;
  agent?: string;
};

type RoutingTable = Record<string, RouteEntry>;

type DiscordMessage = {
  id: string;
  content?: string;
  timestamp?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  attachments?: Array<{ url?: string; filename?: string }>;
};

type ThreadInfo = {
  id: string;
  name: string;
  guild?: string;
  parent_id?: string;
};

type LastSeen = Record<string, string | undefined>;

type PollOpts = {
  limit: number;
  includeBots: boolean;
  dryRun: boolean;
  selfBotId?: string;
  store?: MessageStore;
};

const API = "https://discord.com/api/v10";
const UA = "maw-atlas/1.0.0";
const DEFAULT_ATLAS_REPO = "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle";
const DEFAULT_ROUTING_TABLE = `${DEFAULT_ATLAS_REPO}/.discord/thread-routing.json`;
const DEFAULT_TEAMS_DIR = `${DEFAULT_ATLAS_REPO}/.maw/teams`;
const DEFAULT_CONFIG = ".discord/thread-routing.json";
const DEFAULT_STATE_FILE = ".maw/atlas-route/last-seen.json";
const DEFAULT_PID_FILE = "/tmp/maw-atlas-route.pid";
const DEFAULT_STATUS_FILE = "/tmp/maw-atlas-route.status.json";
const DEFAULT_LOG_FILE = "/tmp/maw-atlas-route.log";

function argValue(args: string[], name: string): string | undefined {
  const exact = args.find(a => a.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function intArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function snowflakeCompare(a: string, b: string): number {
  try {
    const aa = BigInt(a);
    const bb = BigInt(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

function snowflakeToIso(id?: string): string {
  if (!id) return "never";
  try {
    const timestamp = Number((BigInt(id) >> 22n) + 1420070400000n);
    return new Date(timestamp).toISOString();
  } catch {
    return "unknown";
  }
}

function routingPath(args: string[]): string | null {
  const explicit = argValue(args, "--config") || argValue(args, "--routing") || process.env.DISCORD_THREAD_ROUTING || process.env.ATLAS_THREAD_ROUTING;
  const repo = findAtlasRepo();
  const candidates = [
    explicit ? resolve(explicit) : null,
    resolve(process.cwd(), DEFAULT_CONFIG),
    repo ? resolve(repo, ".discord/thread-routing.json") : null,
    DEFAULT_ROUTING_TABLE,
  ].filter(Boolean) as string[];
  return candidates.find(p => existsSync(p)) || null;
}

function routingPathForWrite(args: string[]): string {
  const explicit = argValue(args, "--config") || argValue(args, "--routing") || process.env.DISCORD_THREAD_ROUTING || process.env.ATLAS_THREAD_ROUTING;
  return resolve(explicit || routingPath(args) || DEFAULT_ROUTING_TABLE);
}

function statePath(args: string[]): string {
  return resolve(argValue(args, "--state") || process.env.ATLAS_ROUTE_STATE || DEFAULT_STATE_FILE);
}

function dbPath(args: string[]): string {
  return resolve(argValue(args, "--db") || process.env.ATLAS_ROUTE_DB || join(dirname(statePath(args)), "messages.sqlite"));
}

function pidPath(args: string[]): string {
  return argValue(args, "--pid-file") || process.env.ATLAS_ROUTE_PID_FILE || DEFAULT_PID_FILE;
}

function statusPath(args: string[]): string {
  return argValue(args, "--status-file") || process.env.ATLAS_ROUTE_STATUS_FILE || DEFAULT_STATUS_FILE;
}

function logPath(args: string[]): string {
  return argValue(args, "--log-file") || process.env.ATLAS_ROUTE_LOG_FILE || DEFAULT_LOG_FILE;
}

function loadRoutingTable(file: string): RoutingTable {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`routing table must be an object: ${file}`);
  }

  const table: RoutingTable = {};
  for (const [threadId, route] of Object.entries(raw as Record<string, any>)) {
    if (!/^\d{17,20}$/.test(threadId)) continue;
    if (!route || typeof route !== "object" || typeof route.pane !== "string" || !route.pane.trim()) continue;
    table[threadId] = {
      name: typeof route.name === "string" ? route.name : undefined,
      pane: route.pane.trim(),
      agent: typeof route.agent === "string" ? route.agent : undefined,
    };
  }
  return table;
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file: string, value: any) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function readLastSeen(file: string): LastSeen {
  const raw = readJson<any>(file, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function writeLastSeen(file: string, state: LastSeen) {
  writeJson(file, state);
}

function readPid(file: string): number | undefined {
  try {
    const raw = readFileSync(file, "utf8").trim();
    if (!raw) return undefined;
    if (raw.startsWith("{")) return JSON.parse(raw).pid;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function writePid(file: string, pid: number) {
  writeFileSync(file, `${pid}\n`);
}

function writeRuntimeStatus(args: string[], patch: Record<string, any>) {
  const file = statusPath(args);
  const current = readJson<any>(file, {});
  writeJson(file, { ...current, ...patch });
}

async function discordGet(token: string, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${token}`, "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Discord ${res.status} GET ${path}`);
  return res.json();
}

async function getThreadMessages(token: string, threadId: string, limit: number, after?: string): Promise<DiscordMessage[]> {
  const params = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
  if (after) params.set("after", after);
  const data = await discordGet(token, `/channels/${threadId}/messages?${params}`);
  return Array.isArray(data) ? data : [];
}

async function getSelfBotId(token: string): Promise<string | undefined> {
  try {
    const me = await discordGet(token, "/users/@me");
    return me?.id ? String(me.id) : undefined;
  } catch {
    return undefined;
  }
}

function toRow(msg: DiscordMessage, channelId: string): DiscordMsgRow {
  return {
    message_id: msg.id,
    channel_id: channelId,
    thread_id: channelId,
    guild_id: null,
    author_id: msg.author?.id || "",
    author_name: msg.author?.global_name || msg.author?.username || null,
    author_is_bot: msg.author?.bot ? 1 : 0,
    content: msg.content ?? null,
    attachments_json: msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
    ts: snowflakeToIso(msg.id),
    created_at: new Date().toISOString(),
  };
}

function formatForwardMessage(route: RouteEntry, msg: DiscordMessage): string {
  const author = msg.author?.global_name || msg.author?.username || "discord";
  const content = (msg.content || "").trim();
  const attachments = (msg.attachments || [])
    .map(a => a.url || a.filename)
    .filter(Boolean)
    .join("\n");
  const body = [content, attachments].filter(Boolean).join("\n").trim() || "(no text content)";
  const thread = route.name ? `#${route.name}` : "Discord thread";
  return `[${thread} · ${author}] ${body}`;
}

async function mawHey(pane: string, message: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;

  const bun = (globalThis as any).Bun;
  if (bun?.spawn) {
    const proc = bun.spawn(["maw", "hey", pane, message], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
      throw new Error([`maw hey exited ${code}`, stderr, stdout].filter(Boolean).join("\n"));
    }
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    execFile("maw", ["hey", pane, message], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error([err.message, stderr, stdout].filter(Boolean).join("\n")));
        return;
      }
      resolvePromise();
    });
  });
}

async function seedLatest(token: string, table: RoutingTable, lastSeen: LastSeen, replay: boolean) {
  if (replay) return;
  for (const threadId of Object.keys(table)) {
    if (lastSeen[threadId]) continue;
    const latest = await getThreadMessages(token, threadId, 1);
    if (latest[0]?.id) lastSeen[threadId] = latest[0].id;
  }
}

async function pollOnce(
  log: Log,
  token: string,
  table: RoutingTable,
  lastSeen: LastSeen,
  opts: PollOpts,
): Promise<number> {
  let forwarded = 0;

  for (const [threadId, route] of Object.entries(table)) {
    const messages = await getThreadMessages(token, threadId, opts.limit, lastSeen[threadId]);
    const ordered = messages.slice().sort((a, b) => snowflakeCompare(a.id, b.id));

    for (const msg of ordered) {
      if (!msg.id) continue;

      // load EVERY polled message into the DB (idempotent), even bot/empty ones
      opts.store?.insert(toRow(msg, threadId));

      const hasContent = !!(msg.content || "").trim();
      const hasAttachments = (msg.attachments || []).length > 0;
      const empty = !hasContent && !hasAttachments;
      const isSelf = !!opts.selfBotId && msg.author?.id === opts.selfBotId;
      // echo guard: always skip our OWN posts; route sibling-bot posts (oracles see each other)
      const skipRoute = empty || (isSelf && !opts.includeBots);

      if (!skipRoute) {
        try {
          await mawHey(route.pane, formatForwardMessage(route, msg), opts.dryRun);
          forwarded++;
          log(`${opts.dryRun ? "dry-run" : "forwarded"}: ${route.name || threadId} → ${route.pane} (${msg.id})`);
        } catch (e) {
          // at-least-once: hold the cursor at the last confirmed id; next poll re-routes
          // (INSERT OR IGNORE keeps the DB from double-storing on the re-fetch)
          log(`route error — cursor held at ${lastSeen[threadId] ?? "start"} for ${route.name || threadId}: ${e instanceof Error ? e.message : String(e)}`);
          break;
        }
      }

      // advance the cursor ONLY after the message is handled (routed or intentionally skipped),
      // and NEVER in dry-run (dry-run must be side-effect-free)
      if (!opts.dryRun) lastSeen[threadId] = msg.id;
    }
  }

  return forwarded;
}

function lastMessagesFromSeen(table: RoutingTable, lastSeen: LastSeen) {
  const out: Record<string, any> = {};
  for (const [threadId, route] of Object.entries(table)) {
    const id = lastSeen[threadId];
    out[threadId] = { id, at: snowflakeToIso(id), name: route.name, pane: route.pane, agent: route.agent };
  }
  return out;
}

function usage(log: Log) {
  log("usage:");
  log("  maw atlas route start [--interval=5000]           spawn daemon process");
  log("  maw atlas route stop [--force]                   stop daemon from /tmp/maw-atlas-route.pid");
  log("  maw atlas route status [--config=path]           show active routes + last poll/message time");
  log("  maw atlas route sync [--teams-dir=path]          rebuild routing table from .maw/teams/*.yaml + threads list");
  log("  maw atlas route once [--dry-run] [--replay]      poll one time");
  log("  maw atlas route daemon|watch [--interval=5000]   run foreground polling loop");
  log("  maw atlas route oracles [--json]                 list all fleet oracles + maw-hey targets");
  log("");
  log("options:");
  log("  --config=path       routing table (default: .discord/thread-routing.json; --routing alias supported)");
  log("  --state=path         default: .maw/atlas-route/last-seen.json");
  log("  --pid-file=path      default: /tmp/maw-atlas-route.pid");
  log("  --status-file=path   default: /tmp/maw-atlas-route.status.json");
  log("  --limit=N            messages fetched per poll/thread (default 20)");
  log("  --interval=N         poll interval ms for daemon/watch (default 5000)");
  log("  --replay             process existing recent messages instead of seeding from latest");
  log("  --include-bots       also forward bot-authored messages");
  log("  --dry-run            log forwards without executing maw hey");
}

function daemonArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "route" || a === "start") continue;
    if (a === "--daemon-cmd") { i++; continue; }
    if (a.startsWith("--daemon-cmd=")) continue;
    out.push(a);
  }
  return out;
}

export async function startRouteDaemon(log: Log, args: string[] = []) {
  const pidFile = pidPath(args);
  const existingPid = readPid(pidFile);
  if (isProcessAlive(existingPid)) {
    log(`✓ route daemon already running (pid ${existingPid})`);
    log(`  pid file: ${pidFile}`);
    return { ok: true, pid: existingPid, alreadyRunning: true };
  }

  const bin = argValue(args, "--daemon-cmd") || process.env.MAW_BIN || "maw";
  const childArgs = bin === "maw"
    ? ["atlas", "route", "daemon", ...daemonArgs(args)]
    : daemonArgs(args);
  const logFile = logPath(args);
  const fd = require("fs").openSync(logFile, "a");
  const child = spawn(bin, childArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      ATLAS_ROUTE_PID_FILE: pidFile,
      ATLAS_ROUTE_STATUS_FILE: statusPath(args),
      ATLAS_ROUTE_LOG_FILE: logFile,
    },
  });
  child.unref();

  writePid(pidFile, child.pid);
  writeRuntimeStatus(args, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    lastPollAt: null,
    command: bin,
    args: childArgs,
    routing: routingPath(args),
  });

  log(`✓ route daemon started (pid ${child.pid})`);
  log(`  pid file: ${pidFile}`);
  log(`  log: ${logFile}`);
  return { ok: true, pid: child.pid, alreadyRunning: false };
}

export async function stopRouteDaemon(log: Log, args: string[] = []) {
  const pidFile = pidPath(args);
  const pid = readPid(pidFile);
  if (!isProcessAlive(pid)) {
    try { unlinkSync(pidFile); } catch {}
    log("route daemon is not running");
    log(`  pid file: ${pidFile}`);
    return { ok: true, stopped: false };
  }

  process.kill(pid!, "SIGTERM");
  for (let i = 0; i < 20 && isProcessAlive(pid); i++) await sleep(100);
  if (isProcessAlive(pid) && args.includes("--force")) process.kill(pid!, "SIGKILL");
  if (isProcessAlive(pid)) {
    log(`✗ route daemon still running (pid ${pid}); retry with --force`);
    return { ok: false, stopped: false, pid };
  }

  try { unlinkSync(pidFile); } catch {}
  writeRuntimeStatus(args, { stoppedAt: new Date().toISOString(), pid: null });
  log(`✓ route daemon stopped (pid ${pid})`);
  return { ok: true, stopped: true, pid };
}

export async function routeStatus(log: Log, args: string[] = []) {
  const pidFile = pidPath(args);
  const pid = readPid(pidFile);
  const running = isProcessAlive(pid);
  const file = routingPath(args);
  const status = readJson<any>(statusPath(args), {});
  const lastSeen = readLastSeen(statePath(args));
  const table = file ? loadRoutingTable(file) : {};
  const routes = Object.entries(table).map(([threadId, route]) => ({
    threadId,
    ...route,
    lastMessageAt: status.lastMessages?.[threadId]?.at || snowflakeToIso(lastSeen[threadId]),
  }));

  if (args.includes("--json")) {
    log(JSON.stringify({ running, pid: running ? pid : null, lastPollAt: status.lastPollAt || null, routes }, null, 2));
    return { ok: true, running, routes };
  }

  log(running ? `route daemon: running (pid ${pid})` : "route daemon: stopped");
  log(`pid file: ${pidFile}`);
  log(`routing table: ${file || "not found"}`);
  log(`last poll: ${status.lastPollAt || "never"}`);
  if (routes.length === 0) {
    log("no active routes");
  } else {
    log("active routes:");
    for (const route of routes) {
      const label = [route.name, route.agent].filter(Boolean).join(" / ") || route.threadId;
      log(`  ${route.threadId} → ${route.pane} (${label}) last=${route.lastMessageAt}`);
    }
    log(`${routes.length} route(s)`);
  }
  return { ok: true, running, routes };
}

function teamCharterPaths(args: string[]): string[] {
  const explicit = argValue(args, "--charter");
  if (explicit) return existsSync(explicit) ? [resolve(explicit)] : [];
  const repo = findAtlasRepo();
  const teamsDir = argValue(args, "--teams-dir")
    || process.env.ATLAS_TEAMS_DIR
    || (existsSync(resolve(process.cwd(), ".maw/teams")) ? resolve(process.cwd(), ".maw/teams") : null)
    || (repo && existsSync(resolve(repo, ".maw/teams")) ? resolve(repo, ".maw/teams") : null)
    || DEFAULT_TEAMS_DIR;
  try {
    return readdirSync(teamsDir)
      .filter(name => name.endsWith(".yaml") || name.endsWith(".yml"))
      .map(name => join(teamsDir, name))
      .sort();
  } catch {
    return [];
  }
}

function parseAgentsFromCharter(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const agents: string[] = [];
  const memberMatches = text.matchAll(/-\s+role:\s*([^\n]+)\n\s+name:\s*([^\s]+)/g);
  for (const match of memberMatches) {
    const role = match[1].trim();
    const name = match[2].trim();
    if (role.startsWith("codex") || name.includes("codex")) agents.push(name);
  }
  if (agents.length) return [...new Set(agents)];
  return [...new Set([...text.matchAll(/name:\s*([^\s]+)/g)].map(m => m[1]).filter(name => name.includes("codex")))];
}

function agentOrdinal(agent: string): number {
  const match = agent.match(/-(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function candidateThreadNames(agent: string): string[] {
  const short = agent.replace(/^atlas-/, "");
  const n = agentOrdinal(agent);
  return [...new Set([
    `${short}-workspace`, short, agent, `${agent}-workspace`,
    `codex-${n}-workspace`, `codex-${n}`,
    n === 1 ? "codex-1-workspace" : "",
    n === 1 ? "codex-workspace" : "",
    n === 1 ? "codex" : "",
  ].filter(Boolean))];
}

function findThreadForAgent(agent: string, threads: ThreadInfo[]): ThreadInfo | undefined {
  const candidates = candidateThreadNames(agent).map(name => name.toLowerCase());
  return threads.find(t => candidates.includes(t.name.toLowerCase()))
    || threads.find(t => candidates.some(c => t.name.toLowerCase().includes(c)));
}

function execJsonArray(bin: string, argv: string[]): Promise<any[]> {
  return new Promise(resolvePromise => {
    execFile(bin, argv, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      try {
        const start = stdout.indexOf("[");
        const end = stdout.lastIndexOf("]");
        if (start >= 0 && end > start) resolvePromise(JSON.parse(stdout.slice(start, end + 1)));
        else resolvePromise([]);
      } catch {
        resolvePromise([]);
      }
    });
  });
}

async function atlasThreadsList(args: string[]): Promise<ThreadInfo[]> {
  const bin = argValue(args, "--maw-bin") || process.env.MAW_BIN || "maw";
  let rows = await execJsonArray(bin, ["atlas", "threads", "list", "--json"]);
  if (!rows.length) rows = await execJsonArray(bin, ["atlas", "threads", "--json"]);
  return rows
    .filter(t => t?.id && t?.name)
    .map(t => ({ id: String(t.id), name: String(t.name), guild: t.guild, parent_id: t.parent_id }));
}

function preservedPane(agent: string, thread: ThreadInfo | undefined, existing: RoutingTable): string | undefined {
  const byAgent = Object.values(existing).find(route => route.agent === agent);
  if (byAgent?.pane) return byAgent.pane;
  if (thread && existing[thread.id]?.pane) return existing[thread.id].pane;
  if (thread) return Object.values(existing).find(route => route.name === thread.name)?.pane;
  return undefined;
}

function inferPane(agent: string, thread: ThreadInfo | undefined, existing: RoutingTable, args: string[]): string {
  const current = preservedPane(agent, thread, existing);
  if (current) return current;
  const session = argValue(args, "--session") || process.env.ATLAS_TMUX_SESSION || "01-atlas";
  const base = Number(argValue(args, "--pane-base") || process.env.ATLAS_PANE_BASE || 2);
  return `${session}:${base + agentOrdinal(agent) - 1}`;
}

export async function syncRouteTable(log: Log, _token: string, args: string[] = []) {
  const charters = teamCharterPaths(args);
  if (!charters.length) {
    log("✗ no team charters found in .maw/teams/*.yaml");
    return { ok: false, routes: 0 };
  }

  const agents = [...new Set(charters.flatMap(parseAgentsFromCharter))];
  const threads = await atlasThreadsList(args);
  const target = routingPathForWrite(args);
  const existing = existsSync(target) ? loadRoutingTable(target) : {};
  const next: RoutingTable = {};
  const missing: string[] = [];

  for (const agent of agents) {
    const thread = findThreadForAgent(agent, threads);
    if (!thread) { missing.push(agent); continue; }
    next[thread.id] = {
      name: thread.name,
      pane: inferPane(agent, thread, existing, args),
      agent,
    };
  }

  if (!Object.keys(next).length) {
    log("✗ no agent threads matched; routing table not changed");
    if (!threads.length) log("  `maw atlas threads list --json` returned no threads");
    return { ok: false, routes: 0, missing };
  }

  writeJson(target, next);
  log(`✓ routing table synced: ${target}`);
  log(`  ${Object.keys(next).length} routes from ${agents.length} charter agents across ${charters.length} charter(s)`);
  for (const [threadId, route] of Object.entries(next)) {
    log(`  ${route.name || threadId} (${threadId}) → ${route.pane} [${route.agent || "agent"}]`);
  }
  if (missing.length) log(`  missing threads: ${missing.join(", ")}`);
  return { ok: true, routes: Object.keys(next).length, missing };
}

async function runRoutePoller(log: Log, token: string, args: string[], sub: string) {
  const file = routingPath(args);
  if (!file) {
    log("✗ .discord/thread-routing.json not found (pass --config=path or set DISCORD_THREAD_ROUTING)");
    return;
  }

  const table = loadRoutingTable(file);
  const routes = Object.entries(table);
  if (routes.length === 0) {
    log(`✗ no valid routes in ${file}`);
    return;
  }
  if (!token) {
    log("✗ no DISCORD_BOT_TOKEN — set env or `pass insert discord/atlas-oracle-token`");
    return;
  }

  const stateFile = statePath(args);
  const lastSeen = readLastSeen(stateFile);
  const opts: PollOpts = {
    limit: intArg(args, "--limit", 20),
    includeBots: args.includes("--include-bots"),
    dryRun: args.includes("--dry-run"),
  };
  const replay = args.includes("--replay");

  // echo guard: resolve our own bot id once (skip our posts, route siblings)
  opts.selfBotId = await getSelfBotId(token);
  // message archive: open the dedicated discord_messages store (idempotent)
  const store = openMessageStore(dbPath(args));
  opts.store = store;

  await seedLatest(token, table, lastSeen, replay);
  if (!opts.dryRun) writeLastSeen(stateFile, lastSeen);   // dry-run must NOT persist the seed cursor
  writeRuntimeStatus(args, {
    pid: process.pid,
    routing: file,
    selfBotId: opts.selfBotId || null,
    db: dbPath(args),
    lastPollAt: new Date().toISOString(),
    lastMessages: lastMessagesFromSeen(table, lastSeen),
  });
  log(`route ${sub} ${opts.dryRun ? "(dry-run) " : ""}watching ${routes.length} thread(s); state=${stateFile}; db=${dbPath(args)}; self=${opts.selfBotId || "?"}`);

  if (sub === "once") {
    const count = await pollOnce(log, token, table, lastSeen, opts);
    if (!opts.dryRun) writeLastSeen(stateFile, lastSeen);
    const stored = store.count();
    writeRuntimeStatus(args, {
      lastPollAt: new Date().toISOString(),
      lastForwardCount: count,
      messageCount: stored,
      lastMessages: lastMessagesFromSeen(table, lastSeen),
    });
    store.close();
    log(`${count} message(s) forwarded; ${stored} message(s) in archive (${dbPath(args)})`);
    return;
  }

  const interval = intArg(args, "--interval", 5000);
  while (true) {
    try {
      const count = await pollOnce(log, token, table, lastSeen, opts);
      if (!opts.dryRun) writeLastSeen(stateFile, lastSeen);
      writeRuntimeStatus(args, {
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        lastForwardCount: count,
        messageCount: store.count(),
        lastMessages: lastMessagesFromSeen(table, lastSeen),
      });
    } catch (e) {
      log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
      writeRuntimeStatus(args, { lastPollError: e instanceof Error ? e.message : String(e), lastPollAt: new Date().toISOString() });
    }
    await sleep(interval);
  }
}

export async function routeDaemon(log: Log, token: string, args: string[] = []) {
  await runRoutePoller(log, token, args, "daemon");
}

export async function routeOracles(log: Log, args: string[]) {
  const repo = findAtlasRepo() || DEFAULT_ATLAS_REPO;
  const sdPath = resolve(repo, "parliament/api/state-dirs.ts");
  let stateDirs: Record<string, string> = {};
  let anchors: Record<string, string> = {};
  try {
    const mod = await import(sdPath);
    stateDirs = mod.STATE_DIRS || {};
    anchors = mod.ANCHORS || {};
  } catch (e) {
    log(`✗ could not load oracle list from ${sdPath}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const rows = Object.keys(stateDirs).sort().map(name => {
    const host = anchors[name] || "m5";
    const hostShort = host.split("@")[0].split(".")[0];
    const short = name.replace(/-oracle$/, "");
    return { name, host, stateDir: stateDirs[name], mawHey: `${hostShort}:${short}` };
  });

  if (args.includes("--json")) {
    log(JSON.stringify(rows, null, 2));
    return;
  }

  log(`oracles (${rows.length}):`);
  for (const r of rows) {
    log(`  ${r.name.padEnd(24)} host=${r.host.padEnd(16)} maw-hey=${r.mawHey}`);
  }
  log(`${rows.length} oracle(s) — source: ${sdPath}`);
}

export async function route(log: Log, token: string, args: string[]) {
  const sub = args[1]?.toLowerCase();
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    usage(log);
    return;
  }

  if (sub === "oracles") { await routeOracles(log, args); return; }
  if (sub === "start") { await startRouteDaemon(log, args); return; }
  if (sub === "stop") { await stopRouteDaemon(log, args); return; }
  if (sub === "status") { await routeStatus(log, args); return; }
  if (sub === "sync") { await syncRouteTable(log, token, args); return; }
  if (sub === "daemon") { await routeDaemon(log, token, args); return; }
  if (sub === "watch" || sub === "once") { await runRoutePoller(log, token, args, sub); return; }

  log(`unknown: ${sub} — run 'maw atlas route help'`);
}
