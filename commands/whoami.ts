import { getMe, listGuilds } from "../lib/discord";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "whoami",
  help: "whoami                      bot identity check",
};

export async function whoami(log: (s: string) => void, token: string, _args?: string[]) {
  const me = await getMe(token);
  log(`${me.username} (${me.id}) — bot: ${me.bot}`);
  const guilds = await listGuilds(token);
  log(`${guilds.length} guild(s):`);
  for (const g of guilds) log(`  ${g.name} (${g.id})`);
}

export { whoami as run };
