/**
 * maw atlas channel — create / delete / move guild channels (issue #13).
 *
 * `delete` is the one irreversible verb in this plugin: Discord drops the channel
 * AND every thread under it. So it is a dry run unless --yes, resolves every
 * target before touching any (one bad target aborts the batch), matches names
 * exactly — threads.ts's substring match is fine for `join`, not for `delete` —
 * and backs up before deleting: the channel plus its threads go into the archive
 * DB (same walkTarget + INSERT OR IGNORE as `download`) and into a verified blob,
 * <channel-name>-<channelId>.tar.gz with raw JSON, attachment bytes and a
 * threads.md (lib/channel-archive.ts). A failed backup aborts; --no-backup skips it.
 */
import {
  listGuilds, getGuildChannels, getChannel, createChannel, deleteChannel, moveChannel,
} from "../lib/discord";
import { openMessageStore, archiveDbPath } from "../lib/discord-db";
import { archiveChannel, blobDir, logBlob } from "../lib/channel-archive";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "channel",
  help: [
    "channel create <guildId> <name> [--type=N] [--parent=<categoryId>]   create channel",
    "channel delete <id|#name>... [--yes] [--reason=TEXT] [--out=DIR] [--no-backup]   dry run unless --yes; backs up first",
    "channel move <id|#name> <categoryId>   move channel under a category",
  ].join("\n"),
};

const USAGE = [
  "usage:",
  "  maw atlas channel create <guildId> <name> [--type=N] [--parent=<categoryId>]",
  "  maw atlas channel delete <id|#name>... [--yes] [--reason=TEXT] [--out=DIR] [--no-backup]",
  "      dry run by default — lists what would go; --yes backs each channel up (archive DB +",
  "      <channel-name>-<channelId>.tar.gz blob in --out, default ~/.maw/atlas-blobs), then deletes it",
  "  maw atlas channel move <id|#name> <categoryId>",
];

const SNOWFLAKE = /^\d{17,20}$/;
const CATEGORY = 4;
const THREAD_TYPES = new Set([10, 11, 12]);
const TYPE_NAMES: Record<number, string> = {
  0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum", 16: "media",
};

function argValue(args: string[], name: string): string | undefined {
  const hit = args.find(a => a.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

function positional(args: string[], from: number): string[] {
  return args.slice(from).filter(a => !a.startsWith("--"));
}

function isNotFound(e: unknown): boolean {
  return /\s404\s/.test(e instanceof Error ? e.message : String(e));
}

/** Resolve an id or an exact channel name. Throws on no match or on ambiguity — never guesses. */
async function resolveChannel(token: string, input: string): Promise<any> {
  if (SNOWFLAKE.test(input)) {
    try { return await getChannel(token, input); }
    catch (e) {
      if (isNotFound(e)) throw new Error(`channel ${input} not found (or not visible to this bot)`);
      throw e;
    }
  }
  const name = input.replace(/^#/, "").toLowerCase();
  const guilds = await listGuilds(token);
  const matches: any[] = [];
  for (const g of Array.isArray(guilds) ? guilds : []) {
    const channels = await getGuildChannels(token, g.id);
    for (const c of Array.isArray(channels) ? channels : []) {
      if (c.name?.toLowerCase() === name) matches.push(c);
    }
  }
  if (!matches.length) throw new Error(`no channel named "${input}" in any guild this bot is in`);
  if (matches.length > 1) {
    const ids = matches.map(c => `${c.id} (guild ${c.guild_id})`).join(", ");
    throw new Error(`"${input}" is ambiguous — ${matches.length} channels: ${ids}. Pass the id instead.`);
  }
  return matches[0];
}

function describe(c: any, guildNames: Map<string, string>): string {
  const type = TYPE_NAMES[c.type] ?? `type ${c.type}`;
  const guild = guildNames.get(c.guild_id) ?? c.guild_id;
  return `#${c.name} (${c.id}) — ${type}, guild "${guild}", parent ${c.parent_id ?? "none"}`;
}

async function create(log: Log, token: string, args: string[]) {
  const [guildId, ...nameParts] = positional(args, 2);
  const name = nameParts.join(" ");
  if (!guildId || !SNOWFLAKE.test(guildId) || !name) { USAGE.forEach(l => log(l)); return; }

  const typeArg = argValue(args, "--type");
  const type = typeArg === undefined ? 0 : Number(typeArg);
  if (!Number.isInteger(type)) throw new Error(`--type must be an integer channel type, got "${typeArg}"`);
  const parent = argValue(args, "--parent");
  if (parent !== undefined && !SNOWFLAKE.test(parent)) throw new Error(`--parent must be a category id, got "${parent}"`);

  const c = await createChannel(token, guildId, name, type, parent);
  log(`✓ #${c.name} created (${c.id})${c.parent_id ? ` under ${c.parent_id}` : ""}`);
}

async function del(log: Log, token: string, args: string[]) {
  const targets = positional(args, 2);
  if (!targets.length) { USAGE.forEach(l => log(l)); return; }
  const yes = args.includes("--yes");
  const noBackup = args.includes("--no-backup");
  const outDir = argValue(args, "--out") || blobDir();
  const reason = argValue(args, "--reason") || "maw atlas channel delete";

  // Resolve and validate every target before deleting any.
  const channels: any[] = [];
  for (const t of targets) {
    const c = await resolveChannel(token, t);
    if (THREAD_TYPES.has(c.type)) throw new Error(`${t} is a thread — use \`maw atlas threads delete\``);
    if (c.type === CATEGORY) throw new Error(`${t} is a category — delete or move its channels first`);
    if (!c.guild_id) throw new Error(`${t} is not a guild channel`);
    if (!channels.some(x => x.id === c.id)) channels.push(c);
  }

  const guilds = await listGuilds(token);
  const guildNames = new Map<string, string>((Array.isArray(guilds) ? guilds : []).map((g: any) => [g.id, g.name]));
  for (const c of channels) log(`${yes ? "delete" : "would delete"} ${describe(c, guildNames)}`);
  if (!yes) {
    log(`dry run — nothing deleted. Re-run with --yes to delete ${channels.length} channel(s)` +
      (noBackup ? " WITHOUT a backup." : `, each backed up first (archive DB + blob in ${outDir}).`));
    return;
  }

  const store = noBackup ? null : openMessageStore(archiveDbPath());
  try {
    if (store) log(`backup → ${archiveDbPath()} + blob in ${outDir}`);
    for (const c of channels) {
      if (store) {
        const r = await archiveChannel(token, store, c, outDir);
        log(`  ↳ backed up #${c.name}: ${r.threads} thread(s), ${r.fetched} fetched, ${r.inserted} new`);
        logBlob(log, r.blob!);
      }
      await deleteChannel(token, c.id, reason);
      log(`✓ deleted #${c.name} (${c.id})`);
    }
  } finally {
    store?.close();
  }
}

async function move(log: Log, token: string, args: string[]) {
  const [target, parentId] = positional(args, 2);
  if (!target || !parentId) { USAGE.forEach(l => log(l)); return; }
  if (!SNOWFLAKE.test(parentId)) throw new Error(`category must be an id, got "${parentId}"`);

  const c = await resolveChannel(token, target);
  if (THREAD_TYPES.has(c.type) || c.type === CATEGORY) {
    throw new Error(`${target} is a ${THREAD_TYPES.has(c.type) ? "thread" : "category"} — only channels move under a category`);
  }
  const parent = await resolveChannel(token, parentId);
  if (parent.type !== CATEGORY) throw new Error(`${parentId} (#${parent.name}) is not a category`);
  if (parent.guild_id !== c.guild_id) throw new Error(`category ${parentId} is in a different guild than #${c.name}`);

  await moveChannel(token, c.id, parentId);
  log(`✓ #${c.name} moved under ${parent.name} (${parentId})`);
}

export async function run(log: Log, token: string, args: string[]) {
  const sub = args[1];
  if (sub === "create") return create(log, token, args);
  if (sub === "delete" || sub === "rm") return del(log, token, args);
  if (sub === "move" || sub === "mv") return move(log, token, args);
  USAGE.forEach(l => log(l));
}
