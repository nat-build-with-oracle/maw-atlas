/**
 * maw atlas wake — anchor-aware Discord bot wake (local-first).
 *
 * Encodes the proven fireman-onboarding flow so reviving a bot doesn't mean
 * re-deriving the recipe (and re-making the same mistakes) from scratch:
 *   1. resolve the bot's canonical repo from fleet-registry.json — NOT
 *      `maw locate` / oracles.json, which can point at a stale checkout
 *   2. cross-verify the Discord token: decode the bot id from the token
 *      itself and check it against the registry, then confirm via REST
 *      /users/@me before touching any session
 *   3. idempotent — a session already showing "Listening for channel
 *      messages" is left alone; a session that's attached (a human is using
 *      it) gets a separate <bot>-gw session instead of being clobbered
 *   4. dry-run by default — prints the exact plan (recon results, the
 *      .envrc block if missing, the launch command) without mutating
 *      anything. --apply is required to actually write/launch.
 *   5. launch goes through `maw run`, never raw tmux send-keys (blocked by
 *      the fleet safety hook anyway)
 *
 * Remote-host wake (the `[host]` arg) is NOT implemented — this only
 * handles the local-first case. See CLAUDE.md "Migrating a bot to its
 * anchor host" for the manual recipe until that's built.
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { findAtlasRepo } from "../lib/repo";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "wake",
  help: "wake <bot> [host]           anchor-aware remote wake",
  tokenRequirement: "none",
};

interface FleetEntry {
  name: string;
  stateDir: string;
  hasEnv: boolean;
  inPass: boolean;
  discord?: { username: string; botId: string; discriminator: string };
  repo: string | null;
}

function sh(cmd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
  } catch (e: any) {
    return { ok: false, out: (e.stdout?.toString() ?? "").trim() + (e.stderr?.toString() ?? "").trim() };
  }
}

function decodeBotId(token: string): string {
  try {
    const seg = token.split(".")[0];
    return Buffer.from(seg, "base64").toString("utf8");
  } catch {
    return "";
  }
}

export async function wake(log: (s: string) => void, _token: string, args: string[]) {
  const bot = args[1];
  const host = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
  const apply = args.includes("--apply");

  if (!bot) {
    log("usage: maw atlas wake <bot> [host] [--apply]");
    log("  no --apply: dry-run — recon + plan only, no mutation (default)");
    log("  --apply:    write .envrc block, direnv allow, preflight, launch, verify");
    return;
  }

  if (host && host !== "local") {
    log(`✗ remote-host wake ("${host}") not implemented — see CLAUDE.md "Migrating a bot to its anchor host" for the manual recipe`);
    return;
  }

  const atlasRepo = findAtlasRepo();
  if (!atlasRepo) { log("✗ atlas-oracle repo not found (need fleet-registry.json)"); return; }

  // 1. resolve from fleet-registry.json — source of truth, NOT maw locate / oracles.json
  const registryPath = join(atlasRepo, "fleet-registry.json");
  if (!existsSync(registryPath)) { log(`✗ fleet-registry.json not found at ${registryPath}`); return; }
  const registry: FleetEntry[] = JSON.parse(readFileSync(registryPath, "utf8"));
  const entry = registry.find(e => e.name.toLowerCase() === bot.toLowerCase());
  if (!entry) {
    log(`✗ "${bot}" not found in fleet-registry.json (${registry.length} entries)`);
    log(`  known: ${registry.map(e => e.name).join(", ")}`);
    return;
  }
  if (!entry.repo) {
    log(`✗ ${bot}: fleet-registry.json has no repo recorded for this entry — can't resolve canonical checkout`);
    return;
  }

  const ghqRoot = sh("ghq root").out;
  if (!ghqRoot) { log("✗ ghq root failed"); return; }
  const repoPath = join(ghqRoot, "github.com", entry.repo);
  if (!existsSync(repoPath)) {
    log(`✗ resolved repo path doesn't exist: ${repoPath}`);
    log(`  fix: ghq get ${entry.repo}`);
    return;
  }
  log(`① repo: ${repoPath} (from fleet-registry.json, not maw locate)`);

  // 2. token cross-verify — decode bot id from the token itself, check against
  //    registry, then confirm the token actually authenticates before touching
  //    any session
  const tokenName = `discord/${entry.name}-token`;
  const tokRaw = sh(`pass show ${tokenName}`);
  if (!tokRaw.ok) { log(`✗ pass entry missing or undecryptable: ${tokenName}`); return; }
  const token = tokRaw.out.split("\n").find(l => /^[A-Za-z0-9_.-]{40,}$/.test(l));
  if (!token) { log(`✗ ${tokenName}: couldn't extract a token-shaped line from pass output`); return; }
  log(`② token: ${tokenName} (${token.length} chars)`);

  const decodedBotId = decodeBotId(token);
  if (entry.discord?.botId) {
    if (decodedBotId === entry.discord.botId) {
      log(`   decoded bot id: ${decodedBotId} ✓ matches registry`);
    } else {
      log(`✗ bot-id mismatch: registry says ${entry.discord.botId}, token decodes to "${decodedBotId || "(decode failed)"}" — STOP, this is the wrong token`);
      return;
    }
  } else {
    log(`   decoded bot id: ${decodedBotId || "(decode failed)"} (registry has no botId to cross-check against)`);
  }

  const rest = sh(`curl -s --compressed -o /dev/null -w '%{http_code}' -H "Authorization: Bot ${token}" https://discord.com/api/v10/users/@me`);
  log(`   REST /users/@me: HTTP ${rest.out || "?"} ${rest.out === "200" ? "✓" : "✗"}`);
  if (rest.out !== "200") { log("✗ token doesn't authenticate — stop before touching sessions"); return; }

  // 3. idempotency — already online? attached (human using it)?
  const session = entry.name;
  const sessionExists = sh(`tmux has-session -t ${JSON.stringify(session)}`).ok;
  let alreadyOnline = false;
  let attached = false;
  if (sessionExists) {
    const peek = sh(`tmux capture-pane -p -t ${JSON.stringify(session)} -S -50`);
    alreadyOnline = /Listening for channel messages/.test(peek.out);
    attached = sh(`tmux list-clients -t ${JSON.stringify(session)}`).out.trim().length > 0;
  }
  log(`③ session "${session}": ${
    !sessionExists ? "not found"
    : alreadyOnline ? "ONLINE (--channels active)"
    : attached ? "exists, ATTACHED (human using it), not channels-active"
    : "exists, not channels-active"
  }`);

  if (alreadyOnline) {
    log("✓ already awake — nothing to do (idempotent skip)");
    return;
  }

  const targetSession = attached ? `${entry.name}-gw` : session;
  if (attached) {
    log(`   session is attached — will use a separate gateway session "${targetSession}" instead of clobbering it`);
  }

  // 4. .envrc — check, never auto-write (too easy to get subtly wrong: stray
  //    host-specific lines, wrong token name, missing DISCORD_STATE_DIR makes
  //    the bun plugin silently exit while the bot still looks "online")
  const envrcPath = join(repoPath, ".envrc");
  const existingEnvrc = existsSync(envrcPath) ? readFileSync(envrcPath, "utf8") : null;
  const hasDiscordToken = !!existingEnvrc?.includes("DISCORD_BOT_TOKEN");
  const hasStateDir = !!existingEnvrc?.includes("DISCORD_STATE_DIR");
  const hasClaudeToken = !!existingEnvrc?.includes("CLAUDE_CODE_OAUTH_TOKEN");
  log(`④ .envrc: ${envrcPath}`);
  log(`   exists: ${existingEnvrc !== null} | DISCORD_BOT_TOKEN: ${hasDiscordToken} | DISCORD_STATE_DIR: ${hasStateDir} | CLAUDE_CODE_OAUTH_TOKEN: ${hasClaudeToken}`);

  const stateDir = entry.stateDir.startsWith("~") ? join(homedir(), entry.stateDir.slice(1)) : entry.stateDir;
  const launchCmd = "claude --dangerously-skip-permissions --channels plugin:discord@claude-plugins-official --continue";
  const needsEnvrcWrite = !hasDiscordToken || !hasStateDir;

  if (!apply) {
    log("");
    log("── DRY RUN — no mutation performed. Re-run with --apply to execute. ──");
    if (needsEnvrcWrite) log(`  would need: ${envrcPath} to export DISCORD_BOT_TOKEN + DISCORD_STATE_DIR=${stateDir} (not auto-written — see below)`);
    log(`  would run: direnv allow ${repoPath}`);
    log(`  would preflight: direnv exec ${repoPath} claude -p "Reply: PREFLIGHT_OK"`);
    log(`  would launch: maw run ${targetSession} "${launchCmd}"`);
    log("  would verify: banner, discord bun process, gateway WS ESTABLISHED, maw atlas whoami");
    return;
  }

  // --apply from here on
  log("");
  log("── APPLYING ──");

  if (needsEnvrcWrite) {
    log("⚠ .envrc is missing required exports — not auto-writing (paste this block in by hand, then re-run --apply):");
    log("");
    log(`  export DISCORD_BOT_TOKEN="$(pass show ${tokenName})"`);
    log(`  export DISCORD_STATE_DIR="${stateDir}"`);
    if (!hasClaudeToken) log('  export CLAUDE_CODE_OAUTH_TOKEN="$(pass show claude/token-<name>)"  # also recommended');
    log("");
    return;
  }

  const allow = sh(`direnv allow ${JSON.stringify(repoPath)}`);
  log(`   direnv allow: ${allow.ok ? "✓" : `✗ ${allow.out}`}`);
  if (!allow.ok) return;

  log("   preflight (claude -p, up to 90s)...");
  const preflight = sh(`timeout 90 direnv exec ${JSON.stringify(repoPath)} claude -p "Reply: PREFLIGHT_OK"`);
  const preflightOk = preflight.ok && preflight.out.includes("PREFLIGHT_OK");
  log(`   preflight: ${preflightOk ? "✓" : `✗ ${preflight.out}`}`);
  if (!preflightOk) {
    log("✗ preflight failed — not launching. Check CLAUDE_TOKEN_NAME / org auth before retrying.");
    return;
  }

  log(`   launching via maw run ${targetSession} ...`);
  const launch = sh(`maw run ${JSON.stringify(targetSession)} ${JSON.stringify(launchCmd)}`);
  log(`   launch: ${launch.ok ? "✓ sent" : `✗ ${launch.out}`}`);
  if (!launch.ok) return;

  log("   waiting 5s before verifying...");
  await new Promise(r => setTimeout(r, 5000));

  const peek2 = sh(`maw peek ${JSON.stringify(targetSession)}`);
  const bannerOk = /Listening for channel messages/.test(peek2.out);
  log(`⑤ banner: ${bannerOk ? "✓" : "✗ not yet visible — may still be starting, re-check with: maw peek " + targetSession}`);
}

export { wake as run };
