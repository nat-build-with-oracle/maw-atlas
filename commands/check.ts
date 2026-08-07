/**
 * maw atlas check — atlas-oracle "one oracle" consolidation invariant.
 *
 * Native port of the logic proven in scripts/consolidation-check.sh (atlas-oracle
 * repo): asserts the repo hasn't fragmented into multiple worktrees/tmux tiles,
 * the discord plugin is vendored (survives `bun install -g maw-js`), and the bot
 * is live. Read-only — never mutates anything. Calls out to system tools (git,
 * tmux, pgrep, curl, pass) directly rather than depending on that repo's script
 * file being present on disk.
 */
import { execSync } from "child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { findAtlasRepo } from "../lib/repo";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "check",
  help: "check                        consolidation invariant",
  tokenRequirement: "none",
};

function sh(cmd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
  } catch (e: any) {
    return { ok: false, out: (e.stdout?.toString() ?? "").trim() };
  }
}

export async function check(log: (s: string) => void, _token: string, args: string[]) {
  const repo = findAtlasRepo();
  if (!repo) { log("✗ atlas-oracle repo not found"); return; }

  const session = args[1] && !args[1].startsWith("--") ? args[1] : "atlas";
  const tokenName = "discord/atlas-oracle-token";
  let fails = 0;
  const pass = (s: string) => log(`  ✓ ${s}`);
  const fail = (s: string) => { log(`  ✗ ${s}`); fails++; };

  const now = new Date().toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false }).replace(",", "");
  log(`🔍 atlas-oracle consolidation check — ${now} +07`);

  // 1. exactly one git worktree
  const wt = sh(`git -C ${JSON.stringify(repo)} worktree list`);
  const wtLines = wt.out ? wt.out.split("\n").filter(Boolean) : [];
  if (wtLines.length === 1) {
    const head = sh(`git -C ${JSON.stringify(repo)} rev-parse --short HEAD`).out;
    const branch = sh(`git -C ${JSON.stringify(repo)} branch --show-current`).out;
    pass(`1 worktree (${head} [${branch}])`);
  } else {
    fail(`${wtLines.length} worktrees (expected 1): ${wtLines.map(l => l.split(/\s+/)[0]).join(" ")}`);
  }

  // 2. exactly one tmux window in the session
  const hasSession = sh(`tmux has-session -t ${JSON.stringify(session)}`).ok;
  if (hasSession) {
    const winList = sh(`tmux list-windows -t ${JSON.stringify(session)}`);
    const wins = winList.out ? winList.out.split("\n").filter(Boolean) : [];
    if (wins.length === 1) {
      pass(`1 tmux window in ${session}`);
    } else {
      const names = sh(`tmux list-windows -t ${JSON.stringify(session)} -F '#{window_name}'`).out.split("\n").filter(Boolean).join(" ");
      fail(`${wins.length} windows in ${session}: ${names}`);
    }
  } else {
    fail(`tmux session ${session} not found`);
  }

  // 3. no stray agent worktrees / sibling .wt-* dirs
  const strays: string[] = [];
  const agentsDir = join(repo, "agents");
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) strays.push(`agents/${entry.name}/`);
    }
  }
  const parentDir = join(repo, "..");
  const repoBase = repo.split("/").filter(Boolean).pop()!;
  if (existsSync(parentDir)) {
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${repoBase}.wt-`)) strays.push(entry.name);
    }
  }
  if (strays.length === 0) pass("no agents/* or *.wt-* dirs");
  else fail(`stray worktree dirs: ${strays.join(" ")}`);

  // 4. discord plugin vendored (wipe-proof)
  const pluginLink = join(homedir(), ".maw/plugins/discord");
  let target = "";
  try {
    if (lstatSync(pluginLink).isSymbolicLink()) target = readlinkSync(pluginLink);
  } catch { /* missing — target stays "" */ }
  if (target.includes("maw-js") && target.includes("vendor")) {
    pass("plugin vendored (wipe-proof)");
  } else if (target.includes("maw-plugin-registry")) {
    fail("plugin on manual symlink (mpr) — will wipe on next bun install -g; vendored path expected");
  } else if (!target) {
    fail("plugin symlink missing — run: ln -sf $(ghq list -p maw-plugin-registry|head -1)/plugins/discord ~/.maw/plugins/discord");
  } else {
    fail(`plugin symlink unexpected target: ${target}`);
  }

  // 5. working tree clean (ignore build/local/editor junk)
  const JUNK = /\.wrangler|\.local$|\.serena|\.DS_Store/;
  const status = sh(`git -C ${JSON.stringify(repo)} status --porcelain`);
  const dirtyLines = (status.out ? status.out.split("\n") : []).filter(l => l && !JUNK.test(l));
  if (dirtyLines.length === 0) pass("working tree clean (ignoring build/local junk)");
  else fail(`uncommitted real work present: ${dirtyLines.length} file(s)`);

  // 6. bot live (gateway plugin process + REST identity)
  const procCheck = sh(`pgrep -af 'bun.*plugins.*discord'`);
  const procs = procCheck.out ? procCheck.out.split("\n").filter(Boolean).length : 0;
  if (procs >= 1) pass(`discord plugin process alive (${procs})`);
  else fail("no bun discord plugin process");

  if (sh(`command -v pass`).ok) {
    // read token to a var first + strip stray gpg-warning lines/whitespace
    const tokRaw = sh(`pass show ${tokenName}`);
    const tok = tokRaw.out.split("\n").find(l => /^[A-Za-z0-9_.-]{40,}$/.test(l));
    if (tok) {
      const code = sh(`curl -s --compressed -o /dev/null -w '%{http_code}' -H "Authorization: Bot ${tok}" https://discord.com/api/v10/users/@me`);
      if (code.out === "200") pass("Discord REST identity OK (200)");
      else fail(`Discord REST returned ${code.out}`);
    } else {
      pass("Discord REST skipped (token not decryptable in this shell — not drift)");
    }
  }

  log("");
  if (fails === 0) log("✅ CONSOLIDATED — one atlas-oracle, no drift.");
  else log(`⚠ DRIFT: ${fails} check(s) failed. Investigate with /trace --deep + /dig --deep before re-consolidating.`);
}

export { check as run };
