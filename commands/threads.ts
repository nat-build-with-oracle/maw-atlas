import {
  listGuilds, getGuildChannels, postMessage,
  createThread, createThreadFromMessage, deleteThread,
  joinThread, addThreadMember, archiveThread,
} from "../lib/discord";
import type { CommandMeta } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "threads",
  help: [
    "threads [--json]             list active threads across guilds",
    "threads create <ch> <name>  create empty thread",
    "threads open <ch> <name>    create thread with starter msg + join",
    "threads new <ch> <name> --member <uid>  create + add member + tag in first post",
    "threads delete <name-or-id> delete thread",
    "threads archive <name>      archive thread",
    "threads join <name>         bot joins thread",
    "threads add <thread> <uid>  add user to thread",
  ].join("\n"),
  treeLines: [
    "threads                     list active threads (JSON)",
    "create <ch> <name>      create new thread",
    "--plain                 human-readable",
  ],
};

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
    headers: { Authorization: `Bot ${token}`, "User-Agent": "maw-atlas/1.0.0" },
  });
  if (!res.ok) return [];
  const data = await res.json() as any;
  return data.threads || [];
}

async function resolveThread(token: string, nameOrId: string): Promise<string | null> {
  if (/^\d{17,20}$/.test(nameOrId)) return nameOrId;
  const clean = nameOrId.replace(/^#/, "").toLowerCase();
  const guilds = await listGuilds(token);
  if (!Array.isArray(guilds)) return null;
  for (const g of guilds) {
    const threads = await listActiveThreads(token, g.id);
    const match = threads.find((t: any) => t.name?.toLowerCase() === clean || t.name?.toLowerCase().includes(clean));
    if (match) return match.id;
  }
  return null;
}

export async function threads(log: (s: string) => void, token: string, args: string[]) {
  const sub = args[1];

  if (!sub || sub === "help") {
    log("usage:");
    log("  maw atlas threads                          list active threads");
    log("  maw atlas threads create <ch> <name>       create thread (empty)");
    log("  maw atlas threads open <ch> <name>         create thread with starter message + join");
    log("  maw atlas threads new <ch> <name> --member <uid> [--archive-after 60|1440|4320|10080] [--text <msg>] [--no-add] [--no-tag]");
    log("                                             create thread, add the member, tag them in the first post");
    log("  maw atlas threads delete <name-or-id>      delete thread");
    log("  maw atlas threads archive <name-or-id>     archive thread");
    log("  maw atlas threads join <name-or-id>        bot joins thread");
    log("  maw atlas threads add <thread> <user-id>   add user to thread");
    log("  maw atlas threads --json                   JSON output");
    return;
  }

  if (sub === "create") {
    const channel = args[2];
    const name = args.slice(3).filter(a => !a.startsWith("--")).join(" ");
    if (!channel || !name) { log("usage: maw atlas threads create <channel> <thread-name>"); return; }
    const channelId = await resolveChannel(token, channel);
    if (!channelId) { log(`✗ channel not found: ${channel}`); return; }
    const thread = await createThread(token, channelId, name);
    log(`✓ #${thread.name} created (${thread.id})`);
    return;
  }

  if (sub === "open") {
    const channel = args[2];
    const name = args.slice(3).filter(a => !a.startsWith("--")).join(" ");
    if (!channel || !name) { log("usage: maw atlas threads open <channel> <thread-name>"); return; }
    const channelId = await resolveChannel(token, channel);
    if (!channelId) { log(`✗ channel not found: ${channel}`); return; }
    const msg = await postMessage(token, channelId, `🤖 **${name}** — thread workspace`);
    const thread = await createThreadFromMessage(token, channelId, msg.id, name);
    await joinThread(token, thread.id);
    log(`✓ #${thread.name} opened (${thread.id}) — with starter message + bot joined`);
    return;
  }

  if (sub === "new") {
    const rest = args.slice(2);
    const flag = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
    const valueFlags = new Set(["--member", "--archive-after", "--text"]);
    const positional = rest.filter((a, i) => !a.startsWith("--") && !valueFlags.has(rest[i - 1]));
    const channel = positional[0];
    const name = positional.slice(1).join(" ");
    const member = flag("--member");
    const text = flag("--text");
    const archiveAfter = flag("--archive-after") ? Number(flag("--archive-after")) : undefined;
    if (!channel || !name || !member) { log("usage: maw atlas threads new <channel> <thread-name> --member <user-id> [--archive-after 60|1440|4320|10080] [--text <msg>] [--no-add] [--no-tag]"); return; }
    if (!/^\d{17,20}$/.test(member)) { log(`✗ --member must be a user id, got: ${member}`); return; }
    if (archiveAfter !== undefined && ![60, 1440, 4320, 10080].includes(archiveAfter)) { log("✗ --archive-after must be 60, 1440, 4320 or 10080"); return; }
    const channelId = await resolveChannel(token, channel);
    if (!channelId) { log(`✗ channel not found: ${channel}`); return; }
    const thread = await createThread(token, channelId, name, archiveAfter);
    log(`✓ #${thread.name} created (${thread.id}, auto-archive ${archiveAfter ?? 10080} min)`);
    if (!rest.includes("--no-add")) {
      const r = await addThreadMember(token, thread.id, member);
      log(r.ok ? `✓ ${member} added` : `✗ add failed: ${r.status}`);
    }
    const tag = rest.includes("--no-tag") ? "" : `<@${member}> `;
    await postMessage(token, thread.id, `${tag}${text ?? `**${name}**`}`);
    log(`✓ first post${tag ? ` tags ${member}` : ""}`);
    return;
  }

  if (sub === "delete" || sub === "rm") {
    const target = args[2];
    if (!target) { log("usage: maw atlas threads delete <name-or-id>"); return; }
    const threadId = await resolveThread(token, target);
    if (!threadId) { log(`✗ thread not found: ${target}`); return; }
    await deleteThread(token, threadId);
    log(`✓ thread deleted (${threadId})`);
    return;
  }

  if (sub === "archive") {
    const target = args[2];
    if (!target) { log("usage: maw atlas threads archive <name-or-id>"); return; }
    const threadId = await resolveThread(token, target);
    if (!threadId) { log(`✗ thread not found: ${target}`); return; }
    await archiveThread(token, threadId);
    log(`✓ thread archived (${threadId})`);
    return;
  }

  if (sub === "join") {
    const target = args[2];
    if (!target) { log("usage: maw atlas threads join <name-or-id>"); return; }
    const threadId = await resolveThread(token, target);
    if (!threadId) { log(`✗ thread not found: ${target}`); return; }
    const r = await joinThread(token, threadId);
    log(r.ok ? `✓ bot joined thread (${threadId})` : `✗ join failed: ${r.status}`);
    return;
  }

  if (sub === "add") {
    const target = args[2];
    const userId = args[3];
    if (!target || !userId) { log("usage: maw atlas threads add <thread> <user-id>"); return; }
    const threadId = await resolveThread(token, target);
    if (!threadId) { log(`✗ thread not found: ${target}`); return; }
    const r = await addThreadMember(token, threadId, userId);
    log(r.ok ? `✓ user ${userId} added to thread (${threadId})` : `✗ add failed: ${r.status}`);
    return;
  }

  // default: list
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

export { threads as run };
