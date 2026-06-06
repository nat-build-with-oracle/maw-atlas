/**
 * maw atlas backfill — guild-aware Discord channel message backfill.
 *
 * Wraps the backfill script in atlas-oracle repo, or runs standalone
 * Discord REST fetch if the script isn't available.
 */
import { findAtlasRepo } from "../lib/repo";
import { listGuilds, getGuildChannels, getMessages, filterTextChannels } from "../lib/discord";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export async function backfill(log: (s: string) => void, token: string, args: string[]) {
  const repo = findAtlasRepo();
  const scriptPath = repo ? join(repo, "scripts/backfill-channels.ts") : null;

  // if atlas-oracle repo has the full script, delegate to it
  if (scriptPath && existsSync(scriptPath)) {
    const { execSync } = require("child_process");
    const rest = args.slice(1).join(" ");
    log(`delegating to ${scriptPath}`);
    try {
      execSync(`DISCORD_STATE_DIR=${repo}/.discord DISCORD_BOT_TOKEN=${token} bun ${scriptPath} ${rest}`, {
        stdio: "inherit",
      });
    } catch (e: any) {
      log(`backfill exited: ${e.message || e}`);
    }
    return;
  }

  // standalone mode — fetch directly
  const fetchAll = args.includes("--all");
  const listOnly = args.includes("--list");
  const guildFilter = args.find(a => a.startsWith("--guild="))?.split("=")[1];
  const limit = fetchAll ? 10000 : parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "100");

  const guilds = await listGuilds(token);
  log(`${guilds.length} guild(s)`);

  for (const g of guilds) {
    if (guildFilter && !g.id.includes(guildFilter) && !g.name.toLowerCase().includes(guildFilter.toLowerCase())) continue;

    const channels = await getGuildChannels(token, g.id);
    if (!Array.isArray(channels)) { log(`  ✗ ${g.name}: access denied`); continue; }
    const text = filterTextChannels(channels);
    log(`\n${g.name} — ${text.length} text channels`);

    if (listOnly) {
      for (const ch of text) log(`  💬 #${ch.name} (${ch.id})`);
      continue;
    }

    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9฀-๿_-]/g, "_").slice(0, 60);
    const outDir = repo ? join(repo, ".discord/backfill", sanitize(g.name)) : join("backfill", sanitize(g.name));
    mkdirSync(outDir, { recursive: true });

    let guildTotal = 0;
    for (const ch of text) {
      const all: any[] = [];
      let before: string | undefined;

      while (all.length < limit) {
        const batch = await getMessages(token, ch.id, 100, before);
        if (!batch.length) break;
        all.push(...batch);
        before = batch[batch.length - 1].id;
        if (batch.length < 100) break;
        await new Promise(r => setTimeout(r, 500));
      }

      all.sort((a: any, b: any) => a.id.localeCompare(b.id));
      const outFile = join(outDir, `${sanitize(ch.name)}.json`);
      writeFileSync(outFile, JSON.stringify(all, null, 2) + "\n");
      log(`  ✓ #${ch.name}: ${all.length} msgs`);
      guildTotal += all.length;

      await new Promise(r => setTimeout(r, 1000));
    }
    log(`  total: ${guildTotal} msgs`);
  }
}
