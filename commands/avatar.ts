import { getMe, setBotAvatar, toDataUri } from "../lib/discord";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "avatar",
  help: [
    "avatar                       show current bot avatar",
    "avatar set <image-path>      set bot avatar (PNG/JPG/GIF/WebP)",
  ].join("\n"),
  treeLines: [
    "avatar                       show current bot avatar",
    "set <image-path>       set bot avatar (PNG/JPG/GIF/WebP)",
  ],
};

export async function avatar(log: (s: string) => void, token: string, args: string[]) {
  const sub = args[1];

  if (sub === "set") {
    const filePath = args[2];
    if (!filePath) { log("usage: maw atlas avatar set <path-to-image>"); return; }
    const dataUri = toDataUri(filePath);
    const sizeKB = Math.round(Buffer.from(dataUri).length / 1024);
    log(`uploading avatar (${sizeKB}KB)...`);
    const result = await setBotAvatar(token, dataUri);
    log(`✓ avatar updated: ${result.username} (${result.id})`);
    if (result.avatar) {
      log(`  https://cdn.discordapp.com/avatars/${result.id}/${result.avatar}.png`);
    }
    return;
  }

  const me = await getMe(token);
  if (me.avatar) {
    log(`current avatar: https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`);
  } else {
    log("no avatar set");
  }
  log("");
  log("usage: maw atlas avatar set <path-to-image>");
  log("  supports: PNG, JPG, GIF, WebP");
}

export { avatar as run };
