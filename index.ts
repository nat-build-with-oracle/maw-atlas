/**
 * maw atlas — Discord fleet infrastructure plugin.
 *
 * Thin dispatcher — autoloads commands/*.ts. Each command file exports
 * `meta` (name, help, tokenRequirement — see lib/command-types.ts) and
 * `run(log, token, args)`. Adding a command is just adding a file; nothing
 * in this file needs to change.
 */
import { Glob } from "bun";
import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { getToken } from "./lib/discord";
import type { CommandMeta, CommandRun, Log } from "./lib/command-types";

export const command = {
  name: "atlas",
  description: "Discord fleet infrastructure — guilds, channels, bots, backfill.",
};

interface CommandModule {
  meta: CommandMeta;
  run: CommandRun;
}

let registryCache: CommandModule[] | null = null;

async function loadCommands(): Promise<CommandModule[]> {
  if (registryCache) return registryCache;

  const files: string[] = [];
  const glob = new Glob("*.ts");
  for await (const file of glob.scan({ cwd: `${import.meta.dir}/commands` })) files.push(file);
  files.sort();

  const modules: CommandModule[] = [];
  for (const file of files) {
    const mod = await import(`./commands/${file}`);
    if (!mod.meta?.name || typeof mod.run !== "function") {
      throw new Error(`commands/${file}: must export both \`meta\` (with a name) and \`run\` — see lib/command-types.ts`);
    }
    modules.push({ meta: mod.meta, run: mod.run });
  }
  modules.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  registryCache = modules;
  return modules;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const out: string[] = [];
  const log: Log = (s) => (ctx.writer ? ctx.writer(s) : out.push(s));
  const done = (ok: boolean, exitCode = ok ? 0 : 1): InvokeResult =>
    ({ ok, output: ctx.writer ? "" : out.join("\n"), error: ok ? undefined : "", exitCode });

  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const sub = args[0]?.toLowerCase();

  const commands = await loadCommands();

  if (sub === "--tree" || sub === "tree") {
    log("maw atlas");
    commands.forEach((mod, i) => {
      const isLast = i === commands.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const cont = isLast ? "    " : "│   ";
      const lines = mod.meta.treeLines ?? mod.meta.help.split("\n");
      log(`${prefix}${lines[0]}`);
      for (let j = 1; j < lines.length; j++) {
        const lineIsLast = j === lines.length - 1;
        log(`${cont}${lineIsLast ? "└── " : "├── "}${lines[j]}`);
      }
    });
    return done(true);
  }

  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    log("maw atlas — Discord fleet infrastructure");
    log("");
    for (const mod of commands) {
      for (const line of mod.meta.help.split("\n")) log(`  ${line}`);
    }
    return done(true);
  }

  const mod = commands.find(m => m.meta.name === sub);
  if (!mod) {
    log(`unknown: ${sub} — run 'maw atlas --help'`);
    return done(false);
  }

  const requirement = mod.meta.tokenRequirement ?? "required";
  let token = "";
  if (requirement !== "none") {
    token = getToken() ?? "";
    if (!token && requirement === "required") {
      log("✗ no DISCORD_BOT_TOKEN — set env or `pass insert discord/atlas-oracle-token`");
      return done(false);
    }
  }

  try {
    await mod.run(log, token, args);
    return done(true);
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return done(false);
  }
}

// ── bun-dev CLI shim — when run directly via `bun index.ts <args>` ──
if (import.meta.main) {
  const args = process.argv.slice(2);
  const ctx = {
    source: "cli" as const,
    args,
    writer: (...a: unknown[]) => console.log(String(a[0] ?? "")),
  };
  const result = await handler(ctx as any);
  if (!result.ok) {
    if (result.error) console.error(result.error);
    process.exit(result.exitCode ?? 1);
  }
  if (result.output) console.log(result.output);
}
