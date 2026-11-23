/**
 * Argument handling shared by `maw atlas view` and the standalone `atlas-view`
 * binary (bin/atlas-view.ts), so both take the same flags.
 */
import { existsSync, statSync } from "fs";
import { join } from "path";
import { startViewer } from "./viewer";
import type { Log } from "./command-types";

export async function viewMain(log: Log, args: string[], usage: string) {
  const target = args.find(a => !a.startsWith("--"));
  const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!target || args.includes("--help") || args.includes("-h")) {
    log(`usage: ${usage} <server.sqlite|guild-folder> [--port=N] [--host=127.0.0.1]`);
    log("  read-only Discord-style viewer for one guild archive; binds 127.0.0.1 (or a tailscale 100.x address)");
    log("  images show once 'maw atlas pack <guild-folder>' has put them into server.sqlite");
    if (!target && !args.includes("--help") && !args.includes("-h")) throw new Error("server.sqlite path required");
    return;
  }
  const path = existsSync(target) && statSync(target).isDirectory() ? join(target, "server.sqlite") : target;
  const portArg = flag("port");
  const port = portArg === undefined ? undefined : Number(portArg);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new Error(`bad --port=${portArg}`);
  const v = startViewer(path, { host: flag("host"), port });
  const i = v.info;
  log(`${i.name}: ${i.messages} messages, ${i.attachments} attachments${i.packed ? "" : " (not packed — run 'maw atlas pack' for images)"}, search: ${i.search}`);
  log(`viewer: ${v.url}   (ctrl-c to stop)`);
  await new Promise(() => {}); // serve until killed
}
