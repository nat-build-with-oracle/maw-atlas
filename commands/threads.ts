import { listGuilds, getGuildChannels, createThread } from "../lib/discord";

async function resolveChannel(token: string, input: string): Promise<string | null> {
  if (/^\d{17,20}$/.test(input)) return input;
  const clean = input.replace(/^#/, "").toLowerCase();
  const guilds = await listGuilds(token);
  if (!Array.isArray(guilds)) return null;
  for (const g of guilds) {
    const channels = await getGuildChannels(token, g.id);
    if (!Array.isArray(channels)) continue;
    const match = channels.find((c: any) =>
      c.name?.toLowerCase() === clean ||
      c.name?.toLowerCase().includes(clean)
    );
    if (match) return match.id;
  }
  return null;
}

async function listActiveThreads(token: string, guildId: string): Promise<any[]> {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/threads/active`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "maw-atlas/1.0.0",
    },
  });
  if (!res.ok) return [];
  const data = await res.json() as any;
  return data.threads || [];
}

export async function threads(log: (s: string) => void, token: string, args: string[]) {
  const sub = args[1];

  if (sub === "create") {
    const channel = args[2];
    const name = args.slice(3).filter(a => !a.startsWith("--")).join(" ");
    if (!channel || !name) {
      log("usage: maw atlas threads create <channel> <thread-name>");
      return;
    }
    const channelId = await resolveChannel(token, channel);
    if (!channelId) { log(`✗ channel not found: ${channel}`); return; }
    const thread = await createThread(token, channelId, name);
    log(`✓ thread created: #${thread.name} (${thread.id})`);
    log(`  in channel: ${channelId}`);
    return;
  }

  // default: list active threads
  const guilds = await listGuilds(token);
  if (!Array.isArray(guilds)) { log("✗ could not list guilds"); return; }

  const json = args.includes("--json");
  const allThreads: any[] = [];

  for (const g of guilds) {
    const gThreads = await listActiveThreads(token, g.id);
    if (!gThreads.length) continue;

    if (!json) log(`${g.name} — ${gThreads.length} active threads`);
    for (const t of gThreads) {
      if (json) {
        allThreads.push({ id: t.id, name: t.name, guild: g.name, parent_id: t.parent_id });
      } else {
        log(`  🧵 #${t.name} (${t.id}) ← parent: ${t.parent_id}`);
      }
    }
  }

  if (json) {
    log(JSON.stringify(allThreads, null, 2));
  } else if (allThreads.length === 0) {
    log("no active threads found");
  }
}
