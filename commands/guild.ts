import { getGuild, listGuilds, toDataUri, updateGuild } from "../lib/discord";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "guild",
  help: [
    "guild icon                   show current guild icon URL",
    "guild icon set <image-path>  set guild icon (PNG/JPG/GIF/WebP)",
    "guild icon --remove          remove guild icon",
  ].join("\n"),
  treeLines: [
    "guild icon                  show current guild icon",
    "set <image-path>       set guild icon",
    "--remove               remove guild icon",
    "--guild=<id|name>      choose target guild",
  ],
};

async function resolveGuild(log: (s: string) => void, token: string, args: string[]) {
  // Slice past the prefix rather than split("=")[1] — a guild name containing
  // its own "=" (e.g. --guild=Foo=Bar) would otherwise silently truncate to "Foo".
  const guildFlag = args.find(a => a.startsWith("--guild="));
  const guildArg = guildFlag ? guildFlag.slice("--guild=".length) : undefined;
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
  // Flags (--guild=X, --remove) can appear anywhere in the invocation, e.g.
  // `guild icon --guild=X set ./icon.png`. Indexing raw args[1]/[2]/[3]
  // shifts every subsequent slot when a flag lands before the subcommand —
  // `set` would land in the flag's slot and silently never run. Strip flags
  // out first so sub/area/iconSub always line up with the real positionals.
  const positional = args.filter(a => !a.startsWith("--"));
  const sub = positional[1];
  const area = positional[2];
  const iconSub = positional[3];

  if (sub !== "icon") {
    log("usage:");
    log("  maw atlas guild icon [--guild=<id|exact-name>]");
    log("  maw atlas guild icon set <path-to-image> [--guild=<id|exact-name>]");
    log("  maw atlas guild icon --remove [--guild=<id|exact-name>]");
    return;
  }

  const selectedGuild = await resolveGuild(log, token, args);
  if (!selectedGuild) return;

  const wantsRemove = args.includes("--remove");
  if (area === "set") {
    const filePath = iconSub;
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

export { guild as run };
