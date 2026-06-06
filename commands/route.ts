/**
 * maw atlas route — poll Discord threads and forward new messages to Codex panes.
 *
 * MVP scope from issue #2:
 *   1. read .discord/thread-routing.json
 *   2. poll configured Discord thread messages
 *   3. exec: maw hey <pane> <message>
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { execFile } from "child_process";
import { findAtlasRepo } from "../lib/repo";

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

const API = "https://discord.com/api/v10";
const UA = "maw-atlas/1.0.0";
const DEFAULT_ROUTING_TABLE = "/opt/Code/github.com/Soul-Brews-Studio/discord-oracle/.discord/thread-routing.json";
const DEFAULT_CONFIG = ".discord/thread-routing.json";
const DEFAULT_STATE_FILE = ".maw/atlas-route/last-seen.json";

type LastSeen = Record<string, string | undefined>;

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

function routingPath(args: string[]): string | null {
  const explicit = argValue(args, "--config") || argValue(args, "--routing") || process.env.DISCORD_THREAD_ROUTING;
  const repo = findAtlasRepo();
  const candidates = [
    explicit ? resolve(explicit) : null,
    resolve(process.cwd(), DEFAULT_CONFIG),
    repo ? resolve(repo, ".discord/thread-routing.json") : null,
    DEFAULT_ROUTING_TABLE,
  ].filter(Boolean) as string[];
  return candidates.find(p => existsSync(p)) || null;
}

function statePath(args: string[]): string {
  return resolve(argValue(args, "--state") || process.env.ATLAS_ROUTE_STATE || DEFAULT_STATE_FILE);
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

function readLastSeen(file: string): LastSeen {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeLastSeen(file: string, state: LastSeen) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
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

  await new Promise<void>((resolve, reject) => {
    execFile("maw", ["hey", pane, message], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error([err.message, stderr, stdout].filter(Boolean).join("\n")));
        return;
      }
      resolve();
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
  opts: { limit: number; includeBots: boolean; dryRun: boolean },
): Promise<number> {
  let forwarded = 0;

  for (const [threadId, route] of Object.entries(table)) {
    const messages = await getThreadMessages(token, threadId, opts.limit, lastSeen[threadId]);
    const ordered = messages.slice().sort((a, b) => snowflakeCompare(a.id, b.id));

    for (const msg of ordered) {
      if (!msg.id) continue;
      lastSeen[threadId] = msg.id;

      const hasContent = !!(msg.content || "").trim();
      const hasAttachments = (msg.attachments || []).length > 0;
      if (!hasContent && !hasAttachments) continue;
      if (!opts.includeBots && msg.author?.bot) continue;

      await mawHey(route.pane, formatForwardMessage(route, msg), opts.dryRun);
      forwarded++;
      log(`${opts.dryRun ? "dry-run" : "forwarded"}: ${route.name || threadId} → ${route.pane} (${msg.id})`);
    }
  }

  return forwarded;
}

function usage(log: Log) {
  log("usage:");
  log("  maw atlas route status [--config=path]            show thread → pane routes");
  log("  maw atlas route once [--dry-run] [--replay]       poll one time");
  log("  maw atlas route start [--interval=5000]           poll forever and forward via maw hey");
  log("");
  log("options:");
  log("  --config=path        routing table (default: .discord/thread-routing.json; --routing alias supported)");
  log("  --state=path         default: .maw/atlas-route/last-seen.json");
  log("  --limit=N            messages fetched per poll/thread (default 20)");
  log("  --interval=N         poll interval ms for start (default 5000)");
  log("  --replay             process existing recent messages instead of seeding from latest");
  log("  --include-bots       also forward bot-authored messages");
  log("  --dry-run            log forwards without executing maw hey");
}

export async function route(log: Log, token: string, args: string[]) {
  const sub = args[1]?.toLowerCase();
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    usage(log);
    return;
  }

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

  if (sub === "status") {
    log(`routing table: ${file}`);
    for (const [threadId, r] of routes) {
      const label = [r.name, r.agent].filter(Boolean).join(" / ") || threadId;
      log(`  ${threadId} → ${r.pane} (${label})`);
    }
    log(`${routes.length} route(s)`);
    return;
  }

  if (!token) {
    log("✗ no DISCORD_BOT_TOKEN — set env or `pass insert discord/atlas-oracle-token`");
    return;
  }

  if (!["start", "watch", "daemon", "once"].includes(sub)) {
    log(`unknown: ${sub} — run 'maw atlas route help'`);
    return;
  }

  const stateFile = statePath(args);
  const lastSeen = readLastSeen(stateFile);
  const opts = {
    limit: intArg(args, "--limit", 20),
    includeBots: args.includes("--include-bots"),
    dryRun: args.includes("--dry-run"),
  };
  const replay = args.includes("--replay");

  await seedLatest(token, table, lastSeen, replay);
  writeLastSeen(stateFile, lastSeen);
  log(`route ${sub} ${opts.dryRun ? "(dry-run) " : ""}watching ${routes.length} thread(s); state=${stateFile}`);

  if (sub === "once") {
    const count = await pollOnce(log, token, table, lastSeen, opts);
    writeLastSeen(stateFile, lastSeen);
    log(`${count} message(s) forwarded`);
    return;
  }

  const interval = intArg(args, "--interval", 5000);
  while (true) {
    try {
      await pollOnce(log, token, table, lastSeen, opts);
      writeLastSeen(stateFile, lastSeen);
    } catch (e) {
      log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(interval);
  }
}
