import { listGuilds, getGuildChannels, filterTextChannels, filterVoiceChannels } from "../lib/discord";
import { lookupFailure, matchGuilds } from "../lib/names";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "ls",
  help: "ls [guild name]             list guilds + channels (only guilds whose name holds every word, when given)",
};

export async function ls(log: (s: string) => void, token: string, args: string[] = []) {
  const all = await listGuilds(token);
  const query = args.slice(1).filter(a => !a.startsWith("--")).join(" ");
  let guilds = all;
  if (query) {
    const m = matchGuilds(query, Array.isArray(all) ? all : []);
    if (!m.matches.length) {
      const f = lookupFailure(query, m, all);
      for (const line of f.lines) log(line);
      throw new Error(f.error);
    }
    guilds = m.matches;
  }
  for (const g of guilds) {
    const channels = await getGuildChannels(token, g.id);
    if (!Array.isArray(channels)) { log(`  ✗ ${g.name}: access denied`); continue; }
    const text = filterTextChannels(channels);
    const voice = filterVoiceChannels(channels);
    log(`${g.name} (${g.id}) — ${text.length} text, ${voice.length} voice`);
    for (const ch of text) log(`  💬 #${ch.name} (${ch.id})`);
    for (const ch of voice) log(`  🔊 ${ch.name} (${ch.id})`);
    log("");
  }
}

export { ls as run };
