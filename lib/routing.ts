/**
 * routing — shared `.discord/thread-routing.json` read/write, extracted out
 * of commands/route.ts so commands/team-threads.ts can write pane ids into
 * the same table instead of having no pane-recording at all.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { findAtlasRepo } from "./repo";

export type RouteEntry = {
  name?: string;
  pane: string;
  agent?: string;
};

export type RoutingTable = Record<string, RouteEntry>;

const DEFAULT_ATLAS_REPO = "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle";
export const DEFAULT_ROUTING_TABLE = `${DEFAULT_ATLAS_REPO}/.discord/thread-routing.json`;
const DEFAULT_CONFIG = ".discord/thread-routing.json";

function argValue(args: string[], name: string): string | undefined {
  const exact = args.find(a => a.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export function routingPath(args: string[]): string | null {
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

export function routingPathForWrite(args: string[]): string {
  const explicit = argValue(args, "--config") || argValue(args, "--routing") || process.env.DISCORD_THREAD_ROUTING || process.env.ATLAS_THREAD_ROUTING;
  return resolve(explicit || routingPath(args) || DEFAULT_ROUTING_TABLE);
}

export function loadRoutingTable(file: string): RoutingTable {
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

export function writeJson(file: string, value: any) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
