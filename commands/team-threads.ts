import { listGuilds, getGuildChannels, createThread } from "../lib/discord";
import { herdrAgents, resolveHerdrPane } from "../lib/herdr";
import { routingPathForWrite, loadRoutingTable, writeJson, type RouteEntry } from "../lib/routing";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "team-threads",
  help: [
    "team-threads sync [channel] [--dry-run]  create threads for worktree agents",
    "team-threads list [channel]              list agent threads",
  ].join("\n"),
  treeLines: [
    "team-threads sync [channel] [--dry-run]  create threads for worktree agents",
    "list [channel]          list agent threads",
  ],
};

async function resolveChannel(token: string, input: string): Promise<string | null> {
  if (/^\d{17,20}$/.test(input)) return input;
  const clean = input.replace(/^#/, "").toLowerCase();
  const guilds = await listGuilds(token);
  if (!Array.isArray(guilds)) return null;
  for (const g of guilds) {
    const channels = await getGuildChannels(token, g.id);
    if (!Array.isArray(channels)) continue;
    const match = channels.find((c: any) =>
      c.name?.toLowerCase() === clean ||
      c.name?.toLowerCase().includes(clean)
    );
    if (match) return match.id;
  }
  return null;
}

async function listActiveThreads(token: string, guildId: string): Promise<any[]> {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/threads/active`, {
    headers: { Authorization: `Bot ${token}`, "User-Agent": "maw-atlas/1.0.0" },
  });
  if (!res.ok) return [];
  const data = await res.json() as any;
  return data.threads || [];
}

async function joinThread(token: string, threadId: string) {
  await fetch(`https://discord.com/api/v10/channels/${threadId}/thread-members/@me`, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "User-Agent": "maw-atlas/1.0.0" },
  });
}

async function postMessage(token: string, channelId: string, content: string) {
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "maw-atlas/1.0.0",
    },
    body: JSON.stringify({ content }),
  });
}

function parseAgentsFromCharter(file: string): string[] {
  const { readFileSync } = require("fs");
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

export async function teamThreads(log: (s: string) => void, token: string, args: string[]) {
  const sub = args[1];
  const rest = args.slice(2).filter(a => !a.startsWith("--"));
  const channel = rest[0] || "102-atlas-oracle";
  const dryRun = args.includes("--dry-run");

  if (!sub || sub === "help") {
    log("usage:");
    log("  maw atlas team-threads sync [channel] [--dry-run]  create threads for each worktree agent, record pane ids");
    log("  maw atlas team-threads list [channel]               list agent threads");
    log("");
    log("Sources live worktree agents from `maw herdr ls --agents --json`; falls back to");
    log(".maw/teams/*.yaml charter agents when herdr reports none (non-herdr machine).");
    log("Default channel: 102-atlas-oracle");
    return;
  }

  const channelId = await resolveChannel(token, channel);
  if (!channelId) { log(`✗ channel not found: ${channel}`); return; }

  const guilds = await listGuilds(token);
  let allThreads: any[] = [];
  for (const g of guilds) {
    const threads = await listActiveThreads(token, g.id);
    allThreads = allThreads.concat(threads.filter((t: any) => t.parent_id === channelId));
  }

  if (sub === "list") {
    const agentThreads = allThreads.filter((t: any) => t.name.startsWith("codex-") || t.name === "codex" || t.name.startsWith("atlas-"));
    if (agentThreads.length === 0) { log("no agent threads found"); return; }
    for (const t of agentThreads) {
      log(`  🧵 #${t.name} (${t.id})`);
    }
    log(`\n${agentThreads.length} agent threads`);
    return;
  }

  if (sub === "sync") {
    // Scope is always this team's charter — herdr only changes HOW a pane id
    // is found for each declared member, never WHICH agents get threaded.
    // (A broader "every herdr worktree on the machine" source was tried and
    // measured to fan out across every OTHER oracle's worktrees too — wrong.)
    const { existsSync, readFileSync } = require("fs");
    const { resolve } = require("path");
    const charterPath = resolve(process.cwd(), ".maw/teams/atlas-m5.yaml");
    if (!existsSync(charterPath)) {
      log("✗ .maw/teams/atlas-m5.yaml not found"); return;
    }
    const members = parseAgentsFromCharter(charterPath);
    const agents = members.filter(n => n !== "atlas-oracle");
    const existingNames = new Set(allThreads.map((t: any) => t.name));
    const routingTarget = routingPathForWrite(args);
    const liveAgents = await herdrAgents();

    let created = 0, recorded = 0;
    const routing = !dryRun && existsSync(routingTarget) ? loadRoutingTable(routingTarget) : {};

    for (const agent of agents) {
      const threadName = agent.replace("atlas-", "");
      let pane: string | undefined;
      let cwd: string | undefined;
      if (liveAgents.length > 0) {
        const resolved = await resolveHerdrPane(agent);
        if (resolved.kind === "found") {
          pane = resolved.pane;
          cwd = liveAgents.find(a => a.pane === pane)?.cwd;
        } else if (resolved.kind === "ambiguous") {
          log(`  ⚠ ${agent}: herdr resolve ambiguous (${resolved.panes.join(", ")}) — not recording a pane`);
        }
      }

      let thread = allThreads.find((t: any) => t.name === threadName);
      if (thread) {
        log(`  ✓ #${threadName} exists`);
      } else {
        if (dryRun) {
          log(`  + would create #${threadName}${pane ? ` → ${cwd} [${pane}]` : " (no live pane found)"}`);
          continue;
        }
        thread = await createThread(token, channelId, threadName);
        await joinThread(token, thread.id);
        const body = cwd
          ? `🌍 ${threadName} thread — worktree \`${cwd}\`\n\n— [m5:atlas]`
          : `🌍 ${threadName} thread — worktree \`agents/1-${agent}/\`\n\n— [m5:atlas]`;
        await postMessage(token, thread.id, body);
        log(`  + #${threadName} created (${thread.id})`);
        created++;
      }

      if (dryRun) {
        if (pane) log(`  → would record ${thread?.id ?? "(new)"} → ${pane} [${threadName}]`);
        continue;
      }
      if (pane) {
        const entry: RouteEntry = { name: threadName, pane, agent };
        routing[thread.id] = entry;
        recorded++;
      }
    }

    if (dryRun) {
      log(`\n(dry-run) ${agents.length} charter agent(s) planned, nothing created or written`);
      return;
    }
    if (recorded) writeJson(routingTarget, routing);
    log(`\n${created} created, ${agents.length - created} already existed, ${recorded} pane(s) recorded${recorded ? ` → ${routingTarget}` : ""}`);
    return;
  }

  log(`unknown: ${sub} — run 'maw atlas team-threads help'`);
}

export { teamThreads as run };
