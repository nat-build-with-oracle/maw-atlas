import { getMessages } from "../lib/discord";

export async function read(log: (s: string) => void, token: string, args: string[]) {
  const channel = args[1];
  if (!channel) { log("usage: maw atlas read <channel-id> [--limit=N]"); return; }
  const limit = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "20");
  const msgs = await getMessages(token, channel, limit);
  if (!Array.isArray(msgs)) { log(`✗ ${JSON.stringify(msgs)}`); return; }
  msgs.reverse();
  for (const m of msgs) {
    const ts = m.timestamp?.slice(0, 16) || "?";
    const bot = m.author?.bot ? " 🤖" : "";
    log(`${ts} ${m.author?.username}${bot}: ${m.content?.slice(0, 200) || "(no content)"}`);
  }
  log(`\n${msgs.length} messages`);
}
