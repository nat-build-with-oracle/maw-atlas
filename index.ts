/**
 * maw atlas — Discord fleet infrastructure plugin.
 *
 * Manage bots, channels, guilds, permissions, and message history
 * across multiple Discord servers.
 *
 * Commands:
 *   maw atlas ls                          list guilds + channels
 *   maw atlas read <channel> [--limit=N]  read channel messages
 *   maw atlas backfill [--guild=x] [--all] backfill message history
 *   maw atlas check                       consolidation invariant
 *   maw atlas wake <bot> [host]           anchor-aware remote wake
 *   maw atlas vesicle <bot> [n] [delay]   tmux pane transport demo
 *   maw atlas add-guild <invite-or-id>    resolve guild + add all channels
 */
import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: "atlas",
  description: "Discord fleet infrastructure — guilds, channels, bots, backfill.",
};

const API = "https://discord.com/api/v10";

function getToken(): string | null {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  try {
    const { execSync } = require("child_process");
    return execSync("pass show discord/atlas-oracle-token 2>/dev/null", { encoding: "utf8" }).trim() || null;
  } catch { return null; }
}

async function dapi(path: string, token: string, method = "GET", body?: any): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "maw-atlas/1.0.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Discord API ${res.status} on ${method} ${path}`);
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

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
    log("  ls                          list guilds + channels");
    log("  read <channel> [--limit=N]  read channel messages");
    log("  backfill [--guild=x] [--all] backfill all channels");
    log("  serve [--port=N] [--build]   start PARLIAMENT (auto-build UI if missing)");
    log("  check                       consolidation invariant");
    log("  wake <bot> [host]           anchor-aware remote wake");
    log("  vesicle <bot> [n] [delay]   tmux pane transport");
    log("  add-guild <invite-or-id>    add guild + all channels");
    log("  whoami                      bot identity check");
    return done(true);
  }

  // find atlas-oracle repo (for serve/check/wake/vesicle)
  function findAtlasRepo(): string | null {
    const { execSync } = require("child_process");
    try {
      const ghqRoot = execSync("ghq root", { encoding: "utf8" }).trim();
      const candidates = [
        `${ghqRoot}/github.com/Soul-Brews-Studio/discord-oracle`,
        `${ghqRoot}/github.com/Soul-Brews-Studio/atlas-oracle`,
      ];
      const { existsSync } = require("fs");
      for (const p of candidates) {
        if (existsSync(`${p}/parliament/api/server.ts`)) return p;
      }
    } catch {}
    return null;
  }

  if (sub === "serve") {
    const repo = findAtlasRepo();
    if (!repo) { log("✗ atlas-oracle repo not found (need parliament/api/server.ts)"); return done(false); }
    const port = args.find((a: string) => a.startsWith("--port="))?.split("=")[1] || "4567";
    const password = process.env.DASHBOARD_PASSWORD || "catlab";
    const autoBuild = args.includes("--build");
    const { execSync } = require("child_process");
    const { existsSync } = require("fs");

    // auto-build frontend if --build or dist/ missing
    const distPath = `${repo}/parliament/app/dist/index.html`;
    if (autoBuild || !existsSync(distPath)) {
      log(`building PARLIAMENT UI (${repo}/parliament/app)...`);
      try {
        execSync(`cd ${repo}/parliament/app && bun run build`, { stdio: "inherit" });
        log("✓ build complete");
      } catch (e: any) {
        log(`⚠ build failed: ${e.message || e} — serving API only`);
      }
    }

    log(`starting PARLIAMENT on :${port}`);
    log(`  API: ${repo}/parliament/api/server.ts`);
    log(`  UI:  ${existsSync(distPath) ? "parliament/app/dist/ (built)" : "not built — API only"}`);
    try {
      execSync(`bun ${repo}/parliament/api/server.ts`, {
        stdio: "inherit",
        env: { ...process.env, DASHBOARD_PASSWORD: password },
      });
    } catch (e: any) {
      log(`server exited: ${e.message || e}`);
    }
    return done(true);
  }

  const token = getToken();
  if (!token && !["check", "wake", "vesicle"].includes(sub)) {
    log("✗ no DISCORD_BOT_TOKEN — set env or `pass insert discord/atlas-oracle-token`");
    return done(false);
  }

  try {
    if (sub === "whoami") {
      const me = await dapi("/users/@me", token!);
      log(`${me.username} (${me.id}) — bot: ${me.bot}`);
      const guilds = await dapi("/users/@me/guilds", token!);
      log(`${guilds.length} guild(s):`);
      for (const g of guilds) log(`  ${g.name} (${g.id})`);
      return done(true);
    }

    if (sub === "ls") {
      const guilds = await dapi("/users/@me/guilds", token!);
      for (const g of guilds) {
        const channels = await dapi(`/guilds/${g.id}/channels`, token!);
        if (!Array.isArray(channels)) { log(`  ✗ ${g.name}: access denied`); continue; }
        const text = channels.filter((c: any) => c.type === 0);
        const voice = channels.filter((c: any) => c.type === 2);
        log(`${g.name} — ${text.length} text, ${voice.length} voice`);
        for (const ch of text) log(`  💬 #${ch.name} (${ch.id})`);
        for (const ch of voice) log(`  🔊 ${ch.name} (${ch.id})`);
        log("");
      }
      return done(true);
    }

    if (sub === "read") {
      const channel = args[1];
      if (!channel) { log("usage: maw atlas read <channel-id> [--limit=N]"); return done(false); }
      const limit = parseInt(args.find((a: string) => a.startsWith("--limit="))?.split("=")[1] || "20");
      const msgs = await dapi(`/channels/${channel}/messages?limit=${Math.min(limit, 100)}`, token!);
      if (!Array.isArray(msgs)) { log(`✗ ${JSON.stringify(msgs)}`); return done(false); }
      msgs.reverse();
      for (const m of msgs) {
        const ts = m.timestamp?.slice(0, 16) || "?";
        const bot = m.author?.bot ? " 🤖" : "";
        log(`${ts} ${m.author?.username}${bot}: ${m.content?.slice(0, 200) || "(no content)"}`);
      }
      log(`\n${msgs.length} messages`);
      return done(true);
    }

    if (sub === "add-guild") {
      const input = args[1];
      if (!input) { log("usage: maw atlas add-guild <invite-code-or-guild-id>"); return done(false); }
      let guildId = input;
      if (!/^\d+$/.test(input)) {
        const code = input.replace(/.*discord\.gg\//, "").replace(/.*invite\//, "");
        const invite = await dapi(`/invites/${code}`, token!);
        guildId = invite.guild?.id;
        log(`resolved invite → ${invite.guild?.name} (${guildId})`);
      }
      const channels = await dapi(`/guilds/${guildId}/channels`, token!);
      if (!Array.isArray(channels)) { log(`✗ can't access guild ${guildId}`); return done(false); }
      const text = channels.filter((c: any) => c.type === 0);
      log(`${text.length} text channels found`);
      for (const ch of text) log(`  💬 #${ch.name} (${ch.id})`);
      return done(true);
    }

    if (sub === "whoami") {
      const me = await dapi("/users/@me", token!);
      log(`${me.username} (${me.id})`);
      return done(true);
    }

    log(`unknown: ${sub} — run 'maw atlas --help'`);
    return done(false);
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return done(false);
  }
}
