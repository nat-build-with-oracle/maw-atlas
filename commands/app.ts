import { getMe, getApplication, updateApplication, toDataUri } from "../lib/discord";

export async function app(log: (s: string) => void, token: string, args: string[]) {
  const me = await getMe(token);
  const appId = me.id;
  const sub = args[1];

  if (!sub || sub === "help") {
    log("usage:");
    log("  maw atlas app                          show app settings");
    log("  maw atlas app interactions <url>        set Interactions Endpoint URL");
    log("  maw atlas app interactions --clear      remove Interactions Endpoint URL");
    log("  maw atlas app icon set <path>           set application icon (Dev Portal tile)");
    return;
  }

  if (sub === "icon") {
    const iconSub = args[2];
    if (iconSub === "set") {
      const filePath = args[3];
      if (!filePath) { log("usage: maw atlas app icon set <path-to-image>"); return; }
      const dataUri = toDataUri(filePath);
      const sizeKB = Math.round(Buffer.from(dataUri).length / 1024);
      log(`uploading app icon (${sizeKB}KB)...`);
      const result = await updateApplication(token, appId, { icon: dataUri });
      log(`✓ app icon updated: ${result.name} (${result.id})`);
      if (result.icon) {
        log(`  https://cdn.discordapp.com/app-icons/${result.id}/${result.icon}.png`);
      }
      return;
    }
    const info = await getApplication(token, appId);
    log(info.icon
      ? `current app icon: https://cdn.discordapp.com/app-icons/${info.id}/${info.icon}.png`
      : "no app icon set");
    log("");
    log("usage: maw atlas app icon set <path-to-image>");
    return;
  }

  if (sub === "interactions") {
    const url = args[2];
    if (!url) {
      const info = await getApplication(token, appId);
      log(`current: ${info.interactions_endpoint_url || "(not set)"}`);
      return;
    }
    if (url === "--clear") {
      await updateApplication(token, appId, { interactions_endpoint_url: "" });
      log("✓ Interactions Endpoint URL cleared");
      return;
    }
    await updateApplication(token, appId, { interactions_endpoint_url: url });
    log(`✓ Interactions Endpoint URL set: ${url}`);
    return;
  }

  const info = await getApplication(token, appId);
  log(`${info.name} (${info.id})`);
  log(`  description: ${info.description || "(none)"}`);
  log(`  interactions_endpoint_url: ${info.interactions_endpoint_url || "(not set)"}`);
  log(`  public_key: ${info.verify_key}`);
  log(`  bot_public: ${info.bot_public}`);
  log(`  flags: ${info.flags}`);
}
