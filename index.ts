/**
 * maw atlas — Discord fleet infrastructure plugin.
 *
 * Thin dispatcher — each command lives in commands/<name>.ts,
 * Discord API methods in lib/discord.ts.
 */
import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { getToken } from "./lib/discord";
import { whoami } from "./commands/whoami";
import { ls } from "./commands/ls";
import { read } from "./commands/read";
import { addGuild } from "./commands/add-guild";
import { serve } from "./commands/serve";
import { inbox } from "./commands/inbox";
import { backfill } from "./commands/backfill";
import { threads } from "./commands/threads";
import { slash } from "./commands/slash";

export const command = {
  name: "atlas",
  description: "Discord fleet infrastructure — guilds, channels, bots, backfill.",
};

const COMMANDS = `
  ls                          list guilds + channels
  read <channel> [--limit=N]  read channel messages
  backfill [--guild=x] [--all] backfill all channels
  serve [--port=N] [--build]  start PARLIAMENT (auto-build UI)
  check                       consolidation invariant
  wake <bot> [host]           anchor-aware remote wake
  vesicle <bot> [n] [delay]   tmux pane transport
  add-guild <invite-or-id>    discover guild channels
  threads [--json]             list active threads across guilds
  threads create <ch> <name>  create new thread in channel
  slash list [--json]          list registered slash commands
  slash register <name|--all>  register slash command
  slash remove <name-or-id>    remove slash command
  inbox [--all] [--from=x]    read unread inbox messages
  whoami                      bot identity check
`.trim();

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const out: string[] = [];
  const log = (s: string) => (ctx.writer ? ctx.writer(s) : out.push(s));
  const done = (ok: boolean, exitCode = ok ? 0 : 1): InvokeResult =>
    ({ ok, output: ctx.writer ? "" : out.join("\n"), error: ok ? undefined : "", exitCode });

  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const sub = args[0]?.toLowerCase();

  if (sub === "--tree" || sub === "tree") {
    log("maw atlas");
    log("├── ls                          list guilds + channels");
    log("├── read <channel>              read channel messages");
    log("│   ├── --limit=N               message count (default 20)");
    log("│   └── --plain                 human-readable (default JSON)");
    log("├── threads                     list active threads (JSON)");
    log("│   ├── create <ch> <name>      create new thread");
    log("│   └── --plain                 human-readable");
    log("├── backfill                    backfill all channels");
    log("│   ├── --guild=<name>          specific guild");
    log("│   └── --all                   all guilds");
    log("├── serve                       start PARLIAMENT dashboard");
    log("│   ├── --port=N                port (default 4567)");
    log("│   └── --build                 auto-build UI first");
    log("├── check                       consolidation invariant");
    log("├── wake <bot> [host]           anchor-aware remote wake");
    log("├── vesicle <bot> [n] [delay]   tmux pane transport");
    log("├── add-guild <invite-or-id>    discover guild channels");
    log("├── inbox                       read unread inbox messages");
    log("│   ├── --all                   include read messages");
    log("│   └── --from=<oracle>         filter by sender");
    log("├── whoami                      bot identity check");
    log("└── --tree                      this command tree");
    return done(true);
  }

  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    log("maw atlas — Discord fleet infrastructure");
    log("");
    for (const line of COMMANDS.split("\n")) log(`  ${line.trim()}`);
    return done(true);
  }

  // serve + inbox don't need token
  if (sub === "serve") { await serve(log, args); return done(true); }
  if (sub === "inbox") { await inbox(log, args); return done(true); }

  const token = getToken();
  if (!token && !["check", "wake", "vesicle"].includes(sub)) {
    log("✗ no DISCORD_BOT_TOKEN — set env or `pass insert discord/atlas-oracle-token`");
    return done(false);
  }

  try {
    switch (sub) {
      case "whoami":    await whoami(log, token!); break;
      case "ls":        await ls(log, token!); break;
      case "read":      await read(log, token!, args); break;
      case "add-guild": await addGuild(log, token!, args); break;
      case "backfill":  await backfill(log, token!, args); break;
      case "threads":   await threads(log, token!, args); break;
      case "slash":     await slash(log, token!, args); break;
      default:
        log(`unknown: ${sub} — run 'maw atlas --help'`);
        return done(false);
    }
    return done(true);
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return done(false);
  }
}
