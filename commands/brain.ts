/**
 * maw atlas brain build|serve — Discord servers as a 3D meaning map (three.js), local only.
 *
 *   brain build <guild folder|guildId|guild name>... [--out=DIR] [--gap=3] [--chars=1200] [--url=URL] [--model=M]
 *   brain serve <brain dir|guild folder|guild name> [--port=7720] [--host=127.0.0.1]
 *
 * build reads `download <guild> --out` folders (server.sqlite; no Discord calls) and writes the brain folder:
 * <guild folder>/brain for one server, --out=DIR for several together. One point = one conversation chunk (a room or
 * thread, cut on --gap hours of silence), embedded on Chippy (the Apple Neural Engine) with EmbeddingGemma, placed by
 * UMAP 3D, linked to its 4 nearest in meaning. The work is scripts/atlas-brain.py through uv (numpy, umap-learn);
 * vectors are cached per chunk, so a rebuild after a new download embeds only new chunks.
 *
 * serve opens lib/brain.html on 127.0.0.1 (or a tailscale 100.x address): colour by room / month / source / server,
 * click a point to read the chunk, search by meaning (same embed server) and by words.
 *
 * The recipe is the fleet's brain: laris-co/book-library (2026-11-19), facebook-oracle's fb brain, kindle-capture.
 */
import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { blobDir } from "../lib/channel-archive";
import { resolveGuildFolders } from "../lib/embed-targets";
import { startBrain } from "../lib/brain-server";
import { groupTargets } from "./embed";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "brain",
  help: "brain build <guild folder|guildId|guild name>... [--out=DIR] | brain serve <brain dir|guild> [--port=7720]   3D meaning map of the messages (Chippy ANE + UMAP + three.js), local only",
  treeLines: [
    "brain build <guild folder|guildId|guild name>...   chunks → vectors (cached) → UMAP 3D → <folder>/brain (or --out=DIR for several)",
    "--gap=3 --chars=1200 --min-chars=40   the chunk: hours of silence that cut it, max and min characters",
    "--url=URL --model=M   embed server (default Chippy http://127.0.0.1:11445 embeddinggemma:ane-w8a16)",
    "brain insight <brain dir|guild>   topics (HDBSCAN + c-TF-IDF, Thai via PyThaiNLP) + activity stats → insight.json (build runs it too)",
    "brain serve <brain dir|guild folder|guild name> [--port=7720] [--host=127.0.0.1]   the three.js page + /brain/api (overview, topics, LLM bundles, report.md)",
  ],
  tokenRequirement: "none",
};

const flag = (args: string[], name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function usage(log: Log) {
  log("usage: maw atlas brain build <guild folder|guildId|guild name>... [--out=DIR] [--gap=3] [--chars=1200] [--min-chars=40]");
  log("       maw atlas brain serve <brain dir|guild folder|guild name> [--port=7720] [--host=127.0.0.1]");
  log("  build: one point per conversation chunk (room/thread, cut on 3 h of silence), EmbeddingGemma on Chippy (ANE), UMAP 3D");
  log("         one server → <guild folder>/brain; several → --out=DIR (required). needs uv (numpy, umap-learn)");
  log("       maw atlas brain insight <brain dir|guild>   topics + stats → insight.json (build runs it too)");
  log("  serve: three.js page, colour by topic / room / month / source / server, click to read, search by meaning + words");
  log("         /brain/api: overview, topics, topics/:id + rooms/:i + context?q= (LLM-ready markdown), report.md");
}

async function pump(stream: ReadableStream<Uint8Array>, log: Log) {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      // umap/numba's own warnings are noise for this command
      if (!/Warning|warn\(|self\.fit\(|ensure_all_finite/.test(line)) log(line);
    }
  }
  if (rest) log(rest);
}

async function build(log: Log, args: string[]) {
  const words = args.slice(2).filter(a => !a.startsWith("--"));
  if (!words.length) return usage(log);
  const uv = Bun.which("uv");
  if (!uv) throw new Error("brain build needs uv (numpy + umap-learn run through it) — brew install uv");
  const base = flag(args, "from") || blobDir();
  const folders = resolveGuildFolders(log, groupTargets(words), base);
  const out = flag(args, "out") || (folders.length === 1 ? join(folders[0].dir, "brain") : "");
  if (!out) throw new Error("several servers make one map — say where it goes: --out=DIR");
  for (const f of folders) log(`brain "${f.name}" ← ${f.dir}`);
  log(`→ ${out}`);
  const pass: string[] = ["--out", resolve(out)];
  for (const k of ["gap", "chars", "min-chars", "url", "model"]) {
    const v = flag(args, k);
    if (v !== undefined) pass.push(`--${k}`, v);
  }
  const script = join(import.meta.dir, "..", "scripts", "atlas-brain.py");
  const proc = Bun.spawn(
    pyCmd(uv, script, ["build", ...folders.map(f => f.dir), ...pass]),
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, PYTHONUNBUFFERED: "1" } },
  );
  await Promise.all([pump(proc.stdout, log), pump(proc.stderr, log)]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`atlas-brain.py exited ${code}`);
  log(`serve it: maw atlas brain serve ${out}`);
}

function pyCmd(uv: string, script: string, rest: string[]) {
  return [uv, "run", "--quiet", "--no-project", "--python", "3.12", "--with", "numpy", "--with", "umap-learn", "--with", "scikit-learn",
    "--with", "pythainlp", "python", "-I", "-W", "ignore", script, ...rest];
}

async function insightCmd(log: Log, args: string[]) {
  const t = args.slice(2).filter(a => !a.startsWith("--")).join(" ");
  if (!t) return usage(log);
  const uv = Bun.which("uv");
  if (!uv) throw new Error("brain insight needs uv — brew install uv");
  const dir = existsSync(join(t, "meta.json")) ? t : join(resolveGuildFolders(log, groupTargets(t.split(" ")), flag(args, "from") || blobDir())[0].dir, "brain");
  const proc = Bun.spawn(pyCmd(uv, join(import.meta.dir, "..", "scripts", "atlas-brain.py"), ["insight", resolve(dir)]),
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  await Promise.all([pump(proc.stdout, log), pump(proc.stderr, log)]);
  if ((await proc.exited) !== 0) throw new Error("atlas-brain.py insight failed");
  log("served pages pick it up after: curl -X POST <page>/brain/reload (or restart serve)");
}

async function serve(log: Log, args: string[]) {
  const words = args.slice(2).filter(a => !a.startsWith("--"));
  if (!words.length) return usage(log);
  let dir = "";
  const t = words.join(" ");
  if (existsSync(t) && statSync(t).isDirectory()) dir = existsSync(join(t, "meta.json")) ? t : join(t, "brain");
  else dir = join(resolveGuildFolders(log, groupTargets(words), flag(args, "from") || blobDir())[0].dir, "brain");
  const portArg = flag(args, "port");
  const port = portArg === undefined ? undefined : Number(portArg);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new Error(`bad --port=${portArg}`);
  const b = await startBrain(resolve(dir), { host: flag(args, "host"), port, embedUrl: flag(args, "url") });
  log(`brain: ${b.meta.n.toLocaleString()} chunks, ${b.meta.dim}-d search, model ${b.meta.model}`);
  log(`page: ${b.url}   (ctrl-c to stop)`);
  await new Promise(() => {});
}

export async function run(log: Log, _token: string, args: string[]) {
  const sub = args[1];
  if (sub === "build") return build(log, args);
  if (sub === "serve") return serve(log, args);
  if (sub === "insight") return insightCmd(log, args);
  usage(log);
  if (sub) throw new Error(`unknown: brain ${sub}`);
}
