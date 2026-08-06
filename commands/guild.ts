import { getGuild, listGuilds, toDataUri, updateGuild } from "../lib/discord";

async function resolveGuild(log: (s: string) => void, token: string, args: string[]) {
  const guildArg = args.find(a => a.startsWith("--guild="))?.split("=")[1];
  const guilds = await listGuilds(token);
  if (!Array.isArray(guilds) || guilds.length === 0) {
    log("✗ no guilds available");
    return null;
  }

  if (guildArg) {
    const match = guilds.find((g: any) =>
      g.id === guildArg || String(g.name || "").toLowerCase() === guildArg.toLowerCase());
    if (!match) {
      log(`✗ guild not found: ${guildArg}`);
      return null;
    }
    return match;
  }

  if (guilds.length > 1) {
    log("✗ multiple guilds found — use --guild=<id|exact-name>");
    for (const g of guilds) log(`  ${g.name} (${g.id})`);
    return null;
  }

  return guilds[0];
}

function guildIconUrl(guildId: string, iconHash?: string | null) {
  return iconHash ? `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png` : null;
}

export async function guild(log: (s: string) => void, token: string, args: string[]) {
  const sub = args[1];
  const area = args[2];
  const iconSub = args[3];

  if (sub !== "icon") {
    log("usage:");
    log("  maw atlas guild icon [--guild=<id|exact-name>]");
    log("  maw atlas guild icon set <path-to-image> [--guild=<id|exact-name>]");
    log("  maw atlas guild icon --remove [--guild=<id|exact-name>]");
    return;
  }

  const selectedGuild = await resolveGuild(log, token, args);
  if (!selectedGuild) return;

  const wantsRemove = area === "--remove" || iconSub === "--remove" || args.includes("--remove");
  if (area === "set") {
    const filePath = args[3];
    if (!filePath || filePath.startsWith("--")) {
      log("usage: maw atlas guild icon set <path-to-image> [--guild=<id|exact-name>]");
      return;
    }
    const dataUri = toDataUri(filePath);
    const sizeKB = Math.round(Buffer.from(dataUri).length / 1024);
    log(`uploading guild icon (${sizeKB}KB) for ${selectedGuild.name}...`);
    const result = await updateGuild(token, selectedGuild.id, { icon: dataUri });
    log(`✓ guild icon updated: ${result.name} (${result.id})`);
    const url = guildIconUrl(result.id, result.icon);
    if (url) log(`  ${url}`);
    return;
  }

  if (wantsRemove) {
    const result = await updateGuild(token, selectedGuild.id, { icon: null });
    log(`✓ guild icon removed: ${result.name} (${result.id})`);
    return;
  }

  const info = await getGuild(token, selectedGuild.id);
  const url = guildIconUrl(info.id, info.icon);
  if (url) {
    log(`current guild icon (${info.name}): ${url}`);
  } else {
    log(`no guild icon set (${info.name})`);
  }
  log("");
  log("usage:");
  log("  maw atlas guild icon [--guild=<id|exact-name>]");
  log("  maw atlas guild icon set <path-to-image> [--guild=<id|exact-name>]");
  log("  maw atlas guild icon --remove [--guild=<id|exact-name>]");
}
