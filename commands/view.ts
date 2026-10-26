/**
 * maw atlas view <server.sqlite|guild-folder> — open a local, read-only,
 * Discord-style viewer for one guild archive: categories, channels and threads
 * in a sidebar, messages with inline images (from `maw atlas pack`), search.
 *
 * Binds 127.0.0.1 only (or a tailscale 100.x address via --host). No Discord
 * calls. The same viewer ships as one binary: scripts/build-atlas-view.sh.
 */
import { viewMain } from "../lib/viewer-cli";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "view",
  help: "view <server.sqlite|guild-folder> [--port=N] [--host=127.0.0.1]   local Discord-style viewer (read-only)",
  tokenRequirement: "none",
};

export async function run(log: Log, _token: string, args: string[]) {
  await viewMain(log, args.slice(1), "maw atlas view");
}
