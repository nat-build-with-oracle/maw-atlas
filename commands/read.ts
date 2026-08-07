import { getMessages, listGuilds, getGuildChannels, filterTextChannels } from "../lib/discord";

const DISCORD_EPOCH_MS = 1420070400000;

type ReadFormat = "text" | "json";

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

export async function read(log: (s: string) => void, token: string, args: string[]) {
  const argv = args.slice(1);
  const positional = extractPositionals(argv);
  const channel = positional[0];
  const limitRaw = flagValue(args, "--limit");
  const inlineLimit = limitRaw !== undefined ? parseInt(limitRaw) : NaN;
  const positionalLimit = parseInt(positional[1] || "");
  const limit = Number.isFinite(inlineLimit) ? inlineLimit : (Number.isFinite(positionalLimit) ? positionalLimit : 5);
  const formatArg = flagValue(args, "--format")?.toLowerCase();
  const json = args.includes("--json") || formatArg === "json";
  const format: ReadFormat = json ? "json" : "text";
  const all = args.includes("--all");
  const sinceRaw = flagValue(args, "--since");
  const beforeRaw = flagValue(args, "--before");
  const since = parseDateInput(sinceRaw);
  const before = parseDateInput(beforeRaw);
  const tree = args.includes("--tree") || (!channel && !json);

  if (limitRaw !== undefined && !Number.isFinite(inlineLimit)) {
    log(`✗ invalid --limit: ${limitRaw}`);
    return;
  }
  if (formatArg && formatArg !== "json" && formatArg !== "text") {
    log(`✗ unsupported format: ${formatArg}`);
    return;
  }
  if (sinceRaw && !since) { log(`✗ invalid --since date: ${sinceRaw}`); return; }
  if (beforeRaw && !before) { log(`✗ invalid --before date: ${beforeRaw}`); return; }
  if (since && before && since.getTime() >= before.getTime()) {
    log("✗ --since must be earlier than --before");
    return;
  }

  if (tree) {
    await readTree(log, token, limit, json);
    return;
  }

  if (!channel) {
    log("usage: maw atlas read <channel> [N] [--limit=N] [--all] [--since YYYY-MM-DD] [--before YYYY-MM-DD] [--json|--format json] [--tree]");
    return;
  }

  const channelId = await resolveChannel(token, channel);
  if (!channelId) { log(`✗ channel not found: ${channel}`); return; }

  const msgs = await readMessages(token, channelId, {
    limit: all ? undefined : Math.max(1, limit),
    before,
    since,
  });

  if (format === "json") {
    log(JSON.stringify(msgs, null, 2));
    return;
  }

  for (const m of msgs) {
    const ts = m.timestamp?.slice(0, 16) || "?";
    const bot = m.author?.bot ? " 🤖" : "";
    log(`${ts} ${m.author?.username}${bot}: ${m.content?.slice(0, 200) || "(no content)"}`);
  }
  log(`\n${msgs.length} messages`);
}

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.split("=")[1];
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

// Flags that consume the NEXT token as their value when passed space-separated
// (`--since 2026-08-01`, not `--since=2026-08-01`). Positional extraction must
// skip that value token too, or it gets misread as the channel/count.
const VALUE_FLAGS = ["--limit", "--format", "--since", "--before"];

function extractPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && VALUE_FLAGS.includes(a) && i + 1 < argv.length) i++; // skip its value token
      continue;
    }
    out.push(a);
  }
  return out;
}

function parseDateInput(input?: string): Date | null {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toSnowflakeBefore(date: Date): string {
  const unixMs = Math.floor(date.getTime());
  const delta = Math.max(0, unixMs - DISCORD_EPOCH_MS);
  return (BigInt(delta) << 22n).toString();
}

async function readMessages(
  token: string,
  channelId: string,
  opts: { limit?: number; before: Date | null; since: Date | null },
): Promise<any[]> {
  const out: any[] = [];
  const max = opts.limit;
  let beforeId = opts.before ? toSnowflakeBefore(opts.before) : undefined;
  const sinceMs = opts.since?.getTime() ?? null;

  while (!max || out.length < max) {
    const remaining = max ? max - out.length : 100;
    const pageSize = Math.max(1, Math.min(100, remaining));
    const page = await getMessages(token, channelId, pageSize, beforeId);
    if (!Array.isArray(page) || page.length === 0) break;

    let reachedSince = false;
    for (const msg of page) {
      const ts = Date.parse(msg.timestamp || "");
      if (sinceMs !== null && Number.isFinite(ts) && ts < sinceMs) {
        // Discord returns pages newest-first, so every remaining message in
        // this page is also older than --since — no point checking them.
        reachedSince = true;
        break;
      }
      out.push(msg);
      if (max && out.length >= max) break;
    }

    beforeId = page[page.length - 1]?.id;
    if (!beforeId || page.length < pageSize || reachedSince) break;
  }

  out.reverse();
  return out;
}

async function readTree(log: (s: string) => void, token: string, limit: number, json: boolean) {
  const guilds = await listGuilds(token);
  if (!Array.isArray(guilds)) { log("✗ could not list guilds"); return; }

  if (json) {
    const result: any[] = [];
    for (const g of guilds) {
      const channels = await getGuildChannels(token, g.id);
      if (!Array.isArray(channels)) continue;
      const text = filterTextChannels(channels);
      const threads = await listActiveThreads(token, g.id);
      const guildData: any = { guild: g.name, channels: [] };
      for (const ch of text) {
        try {
          const msgs = await getMessages(token, ch.id, limit);
          if (!Array.isArray(msgs) || msgs.length === 0) continue;
          guildData.channels.push({
            name: ch.name, id: ch.id,
            messages: msgs.reverse().map((m: any) => ({
              id: m.id, author: m.author?.username, bot: !!m.author?.bot,
              content: m.content || "", timestamp: m.timestamp?.slice(0, 19),
            })),
            threads: threads.filter((t: any) => t.parent_id === ch.id).map((t: any) => ({ id: t.id, name: t.name })),
          });
        } catch { /* no access */ }
      }
      if (guildData.channels.length) result.push(guildData);
    }
    log(JSON.stringify(result, null, 2));
    return;
  }

  for (const g of guilds) {
    const channels = await getGuildChannels(token, g.id);
    if (!Array.isArray(channels)) continue;
    const text = filterTextChannels(channels);
    const threads = await listActiveThreads(token, g.id);
    const threadsByParent = new Map<string, any[]>();
    for (const t of threads) {
      const arr = threadsByParent.get(t.parent_id) || [];
      arr.push(t);
      threadsByParent.set(t.parent_id, arr);
    }

    const activeChannels: any[] = [];
    for (const ch of text) {
      try {
        const msgs = await getMessages(token, ch.id, limit);
        if (Array.isArray(msgs) && msgs.length > 0) {
          activeChannels.push({ ch, msgs: msgs.reverse(), threads: threadsByParent.get(ch.id) || [] });
        } else if (threadsByParent.has(ch.id)) {
          activeChannels.push({ ch, msgs: [], threads: threadsByParent.get(ch.id) || [] });
        }
      } catch { /* no access */ }
    }

    if (activeChannels.length === 0) continue;
    log(`${g.name}`);

    for (let ci = 0; ci < activeChannels.length; ci++) {
      const { ch, msgs, threads: chThreads } = activeChannels[ci];
      const isLastCh = ci === activeChannels.length - 1;
      const cPrefix = isLastCh ? "└── " : "├── ";
      const cCont = isLastCh ? "    " : "│   ";

      log(`${cPrefix}#${ch.name}`);

      for (let mi = 0; mi < msgs.length; mi++) {
        const m = msgs[mi];
        const bot = m.author?.bot ? " 🤖" : "";
        const snippet = (m.content || "(no content)").slice(0, 80).replace(/\n/g, " ");
        const isLastMsg = mi === msgs.length - 1 && chThreads.length === 0;
        const mPrefix = isLastMsg ? "└── " : "├── ";
        log(`${cCont}${mPrefix}${m.author?.username}${bot}: ${snippet}`);
      }

      for (let ti = 0; ti < chThreads.length; ti++) {
        const t = chThreads[ti];
        const isLastThread = ti === chThreads.length - 1;
        const tPrefix = isLastThread ? "└── " : "├── ";
        log(`${cCont}${tPrefix}🧵 ${t.name}`);
      }
    }
    log("");
  }
}
