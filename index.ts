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
