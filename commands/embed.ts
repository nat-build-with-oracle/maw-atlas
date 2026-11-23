/**
 * maw atlas embed <guild folder|guildId|guild name>... — messages → LanceDB, for meaning search.
 *
 * Works on what `download <guild> --out` wrote (server.sqlite); never calls Discord. One
 * embedding pass writes three kinds of table, all named `messages`:
 *
 *   <guild folder>/lance/                          every message of the server
 *   <guild folder>/channels/<channel>-<id>/lance/  one room (its threads included) — the same
 *                                                  folders `download --extract` unpacks into
 *   --lance=DIR                                    every server given, together
 *
 * Incremental: only new or edited messages are embedded (text + model hashed per row); room and
 * cross-server tables are rebuilt from the server table when their rows differ, never re-embedded.
 * --room=<channelId> limits a run to rooms; --full re-embeds (a new model, a new embed server).
 *
 * Vectors come from an Ollama-compatible /api/embed server: Chippy on the Apple Neural Engine
 * by default (http://127.0.0.1:11445, embeddinggemma:ane-w8a16). LanceDB has no bun-native
 * package this plugin can carry without an install step, so the writing is done by
 * scripts/atlas-lance.py through uv (`uv run --with lancedb --with pyarrow`); uv caches the
 * wheels after the first run. `scripts/atlas-lance.py self-test` checks every path offline.
 */
import { join } from "path";
import { blobDir } from "../lib/channel-archive";
import { resolveGuildFolders } from "../lib/embed-targets";
import { isSnowflake } from "../lib/names";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "embed",
  help: "embed <guild folder|guildId|guild name>... [--lance=DIR] [--room=<channelId>]... [--full]   messages → LanceDB: one table per room + one per server (+ all servers in DIR); vectors from Chippy (ANE) or Ollama",
  treeLines: [
    "embed <guild folder|guildId|guild name>...   messages → LanceDB (needs a download --out folder)",
    "--lance=DIR          also one table for every server given, together",
    "--room=<channelId>   only these rooms (repeat the flag)",
    "--full               re-embed, not only new/edited messages",
    "--from=DIR           where to look for folders by id/name (default ~/.maw/atlas-blobs, ATLAS_BLOB_DIR)",
    "--url=URL --model=M  embed server (default http://127.0.0.1:11445 embeddinggemma:ane-w8a16; env ATLAS_EMBED_URL / ATLAS_EMBED_MODEL)",
  ],
  tokenRequirement: "none",
};

const PASS = ["--lance=", "--room=", "--model=", "--url=", "--batch="];

function usage(log: Log) {
  log("usage: maw atlas embed <guild folder|guildId|guild name>... [--lance=DIR] [--room=<channelId>]... [--full]");
  log("                       [--from=DIR] [--url=URL] [--model=M] [--batch=N]");
  log("  run `maw atlas download <guild> --out` first; embed reads its server.sqlite, never Discord");
  log("  writes <folder>/lance (whole server) and <folder>/channels/<channel>-<id>/lance (each room), table `messages`");
  log("  --lance=DIR adds one table holding every server given; only new or edited messages are embedded");
  log("  vectors: Chippy on the ANE (http://127.0.0.1:11445) by default; Ollama: --url=http://127.0.0.1:11434 --model=embeddinggemma");
  log("  needs uv (LanceDB is written by scripts/atlas-lance.py): brew install uv");
}

/** Plain words next to each other are one guild name; a path or an id stands alone. */
export function groupTargets(words: string[]): string[] {
  const out: string[] = [];
  let name: string[] = [];
  const flush = () => { if (name.length) out.push(name.join(" ")); name = []; };
  for (const w of words) {
    if (w.includes("/") || w.startsWith(".") || isSnowflake(w)) { flush(); out.push(w); }
    else name.push(w);
  }
  flush();
  return out;
}

async function pump(stream: ReadableStream<Uint8Array>, log: Log) {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) {
      log(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
  }
  if (rest) log(rest);
}

export async function run(log: Log, _token: string, args: string[]) {
  const words = args.slice(1).filter(a => !a.startsWith("--"));
  if (!words.length) return usage(log);
  const known = (a: string) => a === "--full" || a.startsWith("--from=") || PASS.some(p => a.startsWith(p));
  const bad = args.slice(1).filter(a => a.startsWith("--") && !known(a));
  if (bad.length) throw new Error(`unknown flag ${bad.join(" ")} — flags take =, e.g. --room=123 (see maw atlas embed)`);

  const uv = Bun.which("uv");
  if (!uv) throw new Error("embed needs uv to run its LanceDB writer — brew install uv (https://docs.astral.sh/uv/)");

  const base = args.find(a => a.startsWith("--from="))?.slice("--from=".length) || blobDir();
  const folders = resolveGuildFolders(log, groupTargets(words), base);
  for (const f of folders) log(`embed "${f.name}"${f.id ? ` (${f.id})` : ""} ← ${f.dir}`);

  const pass = args.slice(1).filter(a => a === "--full" || PASS.some(p => a.startsWith(p)));
  const script = join(import.meta.dir, "..", "scripts", "atlas-lance.py");
  const proc = Bun.spawn(
    [uv, "run", "--quiet", "--with", "lancedb", "--with", "pyarrow", "python", "-I", script, "embed",
      ...folders.map(f => f.dir), ...pass],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, PYTHONUNBUFFERED: "1" } },
  );
  await Promise.all([pump(proc.stdout, log), pump(proc.stderr, s => log(s))]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`atlas-lance.py exited ${code}`);
}
