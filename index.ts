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
import { avatar } from "./commands/avatar";
import { app } from "./commands/app";
import { teamThreads } from "./commands/team-threads";
import { spawnSession } from "./commands/spawn-session";
import { route } from "./commands/route";
import { watch } from "./commands/watch";
import { transcribe } from "./commands/transcribe";
import { guild } from "./commands/guild";

export const command = {
  name: "atlas",
  description: "Discord fleet infrastructure — guilds, channels, bots, backfill.",
};

const COMMANDS = `
  ls                          list guilds + channels
  read <channel> [--limit=N]  read channel messages
  backfill [--guild=x] [--all] backfill all channels
  serve [--port=N] [--build]  start PARLIAMENT (auto-build UI)
  transcribe <audio> [-o OUT] audio → timestamped transcript (Typhoon/Groq STT)
  transcribe --compare A B    side-by-side STT engine diff
  check                       consolidation invariant
  wake <bot> [host]           anchor-aware remote wake
  vesicle <bot> [n] [delay]   tmux pane transport
  add-guild <invite-or-id>    discover guild channels
  threads [--json]             list active threads across guilds
  threads create <ch> <name>  create empty thread
  threads open <ch> <name>    create thread with starter msg + join
  threads delete <name-or-id> delete thread
  threads archive <name>      archive thread
  threads join <name>         bot joins thread
  threads add <thread> <uid>  add user to thread
  slash list [--json]          list registered slash commands
  slash register <name|--all>  register slash command
  slash remove <name-or-id>    remove slash command
  avatar                       show current bot avatar
  avatar set <image-path>      set bot avatar (PNG/JPG/GIF/WebP)
  guild icon                   show current guild icon URL
  guild icon set <image-path>  set guild icon (PNG/JPG/GIF/WebP)
  guild icon --remove          remove guild icon
  app                          show app settings
  app interactions <url>       set Interactions Endpoint URL
  app interactions --clear     remove Interactions Endpoint URL
  team-threads sync [channel]  create threads for worktree agents
  team-threads list [channel]  list agent threads
  route [start|status|once]    bridge Discord threads to codex panes
  watch <channel>              auto-spawn codex workers from new threads
  spawn-session <charter>      team up + threads sync + route start
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
    log("├── route                       bridge Discord threads to codex panes");
    log("├── watch <channel>             auto-spawn codex workers from new threads");
    log("├── spawn-session <charter>     team up + threads sync + route start");
    log("├── inbox                       read unread inbox messages");
    log("│   ├── --all                   include read messages");
    log("│   └── --from=<oracle>         filter by sender");
    log("├── whoami                      bot identity check");
    log("├── guild icon                  show current guild icon");
    log("│   ├── set <image-path>       set guild icon");
    log("│   ├── --remove               remove guild icon");
    log("│   └── --guild=<id|name>      choose target guild");
    log("└── --tree                      this command tree");
    return done(true);
  }

  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    log("maw atlas — Discord fleet infrastructure");
    log("");
    for (const line of COMMANDS.split("\n")) log(`  ${line.trim()}`);
    return done(true);
  }

  // serve + inbox + transcribe don't need token
  if (sub === "serve") { await serve(log, args); return done(true); }
  if (sub === "inbox") { await inbox(log, args); return done(true); }
  if (sub === "transcribe") { await transcribe(log, args); return done(true); }

  const token = getToken();
  if (!token && !["check", "wake", "vesicle", "route", "watch", "spawn-session"].includes(sub)) {
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
      case "avatar":    await avatar(log, token!, args); break;
      case "guild":     await guild(log, token!, args); break;
      case "app":       await app(log, token!, args); break;
      case "team-threads": await teamThreads(log, token!, args); break;
      case "route":     await route(log, token || "", args); break;
      case "watch":     await watch(log, token || "", args); break;
      case "spawn-session": await spawnSession(log, args); break;
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
