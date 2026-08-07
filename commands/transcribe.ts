import { findAtlasRepo } from "../lib/repo";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "transcribe",
  help: [
    "transcribe <audio> [-o OUT] audio → timestamped transcript (Typhoon/Groq STT)",
    "transcribe --compare A B    side-by-side STT engine diff",
  ].join("\n"),
  tokenRequirement: "none",
};

/**
 * maw atlas transcribe — audio → timestamped transcript via Typhoon/Groq STT.
 *
 * Wraps scripts/transcribe.py (stdlib-only, uv run). 2-tier fallback chain:
 * Typhoon ASR (Thai-native) primary, Groq Whisper fallback (or swap with --backend).
 *
 * Usage:
 *   maw atlas transcribe <audio-dir-or-files> [-o OUT] [--chunk 60]
 *                        [--backend typhoon|groq] [--fallback auto|none]
 *   maw atlas transcribe --compare DIR_A DIR_B   side-by-side engine diff
 *
 * Keys (rotate-safe, never in args/git):
 *   ~/.config/typhoon/.env   TYPHOON_API_KEY=sk-...
 *   ~/.config/groq/.env      GROQ_API_KEY=gsk_...
 */
export async function transcribe(log: (s: string) => void, _token: string, args: string[]) {
  const { execSync } = require("child_process");
  const { existsSync } = require("fs");

  const repo = findAtlasRepo();
  if (!repo) { log("✗ atlas-oracle repo not found"); return; }

  // strip the "transcribe" subcommand itself
  const rest = args.slice(1);

  // preflight: uv + ffmpeg present
  for (const tool of ["uv", "ffmpeg", "ffprobe"]) {
    try { execSync(`which ${tool}`, { stdio: "ignore" }); }
    catch { log(`✗ ${tool} not on PATH (brew install ${tool === "uv" ? "uv" : "ffmpeg"})`); return; }
  }

  // key presence hint (the script disables a backend silently if key missing)
  const typhoonKey = existsSync(`${process.env.HOME}/.config/typhoon/.env`) || process.env.TYPHOON_API_KEY;
  const groqKey = existsSync(`${process.env.HOME}/.config/groq/.env`) || process.env.GROQ_API_KEY;
  if (!typhoonKey && !groqKey) {
    log("✗ no STT keys found. Set up at least one:");
    log("  printf 'TYPHOON_API_KEY=sk-…\\n'  > ~/.config/typhoon/.env && chmod 600 ~/.config/typhoon/.env");
    log("  printf 'GROQ_API_KEY=gsk_…\\n'    > ~/.config/groq/.env    && chmod 600 ~/.config/groq/.env");
    return;
  }
  log(`keys: typhoon=${typhoonKey ? "✓" : "—"} groq=${groqKey ? "✓" : "—"}`);

  // --compare DIR_A DIR_B → run compare_transcripts.py
  if (rest[0] === "--compare") {
    const cmpArgs = rest.slice(1).map(a => `"${a}"`).join(" ");
    log(`comparing transcripts: ${cmpArgs}`);
    try {
      execSync(`uv run ${repo}/scripts/compare_transcripts.py ${cmpArgs}`, { stdio: "inherit", cwd: repo });
    } catch (e: any) { log(`compare exited: ${e.message || e}`); }
    return;
  }

  if (rest.length === 0) {
    log("usage: maw atlas transcribe <audio-dir-or-files> [-o OUT] [--chunk 60] [--backend typhoon|groq]");
    log("       maw atlas transcribe --compare DIR_A DIR_B");
    return;
  }

  const passthrough = rest.map(a => (a.startsWith("-") ? a : `"${a}"`)).join(" ");
  log(`transcribing → uv run scripts/transcribe.py ${passthrough}`);
  try {
    execSync(`PYTHONUNBUFFERED=1 uv run ${repo}/scripts/transcribe.py ${passthrough}`, {
      stdio: "inherit",
      cwd: repo,
    });
  } catch (e: any) {
    log(`transcribe exited: ${e.message || e}`);
  }
}

export { transcribe as run };
