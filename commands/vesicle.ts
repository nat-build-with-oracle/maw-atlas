/**
 * maw atlas vesicle — tmux pane transport ("vesicle transport" demo).
 *
 * Native port of scripts/vesicle-demo.sh (atlas-oracle repo): shuttles an
 * oracle's tmux pane OUT to its own window (break-pane) then back IN as a
 * split pane (`maw bring`), N times, without ever killing the agent inside
 * — only the container moves. Calls tmux/maw directly rather than depending
 * on that repo's script file being present on disk.
 */
import { execSync } from "child_process";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "vesicle",
  help: "vesicle <bot> [n] [delay]   tmux pane transport",
  tokenRequirement: "none",
};

function sh(cmd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
  } catch (e: any) {
    return { ok: false, out: (e.stdout?.toString() ?? "").trim() };
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise(r => setTimeout(r, seconds * 1000));
}

export async function vesicle(log: (s: string) => void, _token: string, args: string[]) {
  const oracle = args[1];
  const cyclesArg = args[2];
  const delayArg = args[3];
  const cycles = cyclesArg !== undefined ? parseInt(cyclesArg, 10) : 5;
  const delay = delayArg !== undefined ? parseFloat(delayArg) : 0.8;

  if (!oracle || oracle.startsWith("--")) {
    log("usage: maw atlas vesicle <bot> [cycles] [delay] [session]");
    log("  bot      oracle slug whose pane to shuttle (required, e.g. digger-oracle)");
    log("  cycles   out→in round-trips                (default 5)");
    log("  delay    seconds to pause between each move  (default 0.8)");
    log("  session  tmux session to operate in          (default: current, else atlas)");
    return;
  }
  if (!Number.isFinite(cycles) || cycles < 1) { log(`✗ invalid cycles: ${cyclesArg}`); return; }
  if (!Number.isFinite(delay) || delay < 0) { log(`✗ invalid delay: ${delayArg}`); return; }

  let session = args[4];
  if (!session) session = process.env.TMUX ? sh(`tmux display-message -p '#S'`).out : "";
  if (!session) session = "atlas";

  // The window we treat as "home" — where the oracle lands as a split pane.
  const homeWin = sh(`tmux display-message -p -t ${JSON.stringify(session)} '#I'`).out || "1";
  const target = `${session}:${homeWin}`;

  // Find the oracle's pane in the home window by matching its cwd basename.
  const findPane = (): string | null => {
    const panes = sh(`tmux list-panes -t ${JSON.stringify(target)} -F '#{pane_index} #{pane_current_path}'`);
    if (!panes.ok) return null;
    for (const line of panes.out.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      const paneIndex = line.slice(0, sp);
      const cwd = line.slice(sp + 1);
      if (cwd.endsWith(`/${oracle}`)) return paneIndex;
    }
    return null;
  };

  // Is the oracle living as its own window right now?
  const oracleWindow = (): boolean => {
    const wins = sh(`tmux list-windows -t ${JSON.stringify(session)} -F '#{window_name}'`);
    return wins.ok && wins.out.split("\n").includes(oracle);
  };

  log(`🫧 vesicle: ${oracle} × ${cycles} cycles (delay ${delay}s) in ${target}`);

  for (let i = 1; i <= cycles; i++) {
    log(`── cycle ${i}/${cycles} ──`);

    // 1. VESICLE OUT — break the oracle's pane into its own window (a "tab").
    const pane = findPane();
    if (pane !== null) {
      log(`   ⬆ break-pane ${target}.${pane} → tab '${oracle}'`);
      sh(`tmux break-pane -s ${JSON.stringify(`${target}.${pane}`)} -n ${JSON.stringify(oracle)} -d`);
    } else if (oracleWindow()) {
      log("   ⬆ already a tab");
    } else {
      log(`   ⚠ ${oracle} not found as pane or window — is it live? skipping.`);
      break;
    }
    await sleep(delay);

    // 2. VESICLE IN — join it back as a split pane in the home window.
    log(`   ⬇ maw bring ${oracle} → split pane`);
    sh(`tmux select-window -t ${JSON.stringify(target)}`);
    const bring = sh(`maw bring ${JSON.stringify(oracle)}`);
    log(bring.ok ? "   ✓ joined beside" : "   ✗ maw bring failed");
    await sleep(delay);
  }

  log(`✅ done — ${oracle} shuttled ${cycles}× without a single restart.`);
  const finalPanes = sh(`tmux list-panes -t ${JSON.stringify(target)} -F '   pane #{pane_index}: #{pane_current_path}'`);
  if (finalPanes.ok) for (const line of finalPanes.out.split("\n")) log(line);
}

export { vesicle as run };
