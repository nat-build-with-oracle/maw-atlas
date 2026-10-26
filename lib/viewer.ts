/**
 * viewer — a read-only, Discord-style web view of one server.sqlite.
 *
 * The db is opened read-only; the only network is the local HTTP server, bound
 * to 127.0.0.1 (or a tailscale 100.64.0.0/10 address). Nothing is fetched from
 * Discord: avatars are initials, custom emoji are their :name:, and embed images
 * are not loaded. Attachment bytes come from the `attachments` table that
 * `maw atlas pack` fills; an unpacked db still renders, with file names only.
 *
 *   GET /                    the page (viewer.html, embedded in a compiled binary)
 *   GET /api/server          guild name, counts, whether attachments/search exist
 *   GET /api/channels        categories, channels and threads (+ topic when packed)
 *   GET /api/users           everyone who posted, with message counts (the member list)
 *   GET /api/forum           ?channel=  forum/media posts as cards
 *   GET /api/messages        ?channel=|thread=  &before=|after=|around=<messageId>  &limit=
 *   GET /api/search          ?q=  (FTS5 trigram when packed, LIKE otherwise)
 *   GET /att/<attachmentId>  the bytes, with Range support
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import html from "./viewer.html" with { type: "text" };

const PAGE = 100;

export interface ViewerOpts {
  host?: string;
  port?: number;
}

/** 127.0.0.1 / localhost / ::1, or a tailscale address — never a public bind. */
export function allowedHost(host: string): boolean {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  const m = host.match(/^100\.(\d+)\.\d+\.\d+$/);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Keep only what the page draws — raw_json carries much more. */
function shapeMessage(row: any, atts: Map<string, any>) {
  const m = JSON.parse(row.raw_json);
  const ref = m.referenced_message;
  return {
    id: m.id,
    type: m.type ?? 0,
    ts: row.ts,
    edited: m.edited_timestamp ?? null,
    author: {
      id: m.author?.id ?? row.author_id,
      name: m.author?.global_name || m.author?.username || row.author_name || "unknown",
      bot: !!m.author?.bot,
    },
    content: m.content ?? "",
    pinned: !!m.pinned,
    attachments: (m.attachments ?? []).map((a: any) => {
      const p = atts.get(a.id);
      return {
        id: a.id, filename: a.filename, content_type: p?.content_type ?? a.content_type ?? null,
        size: p?.size ?? a.size ?? null, width: a.width ?? null, height: a.height ?? null, packed: !!p,
      };
    }),
    embeds: (m.embeds ?? []).map((e: any) => ({
      title: e.title ?? null, description: e.description ?? null, url: e.url ?? null,
      color: e.color ?? null, provider: e.provider?.name ?? null, author: e.author?.name ?? null,
      fields: (e.fields ?? []).map((f: any) => ({ name: f.name, value: f.value })),
      footer: e.footer?.text ?? null,
    })),
    reactions: (m.reactions ?? []).map((r: any) => ({ emoji: r.emoji?.name ?? "?", count: r.count ?? 0 })),
    reply: ref ? {
      id: ref.id, author: ref.author?.global_name || ref.author?.username || "unknown", author_id: ref.author?.id ?? null,
      content: String(ref.content ?? "").slice(0, 200), attachments: ref.attachments?.length ?? 0,
    } : null,
    thread: m.thread ? { id: m.thread.id, name: m.thread.name } : null,
  };
}

export function openViewer(dbPath: string) {
  if (!existsSync(dbPath)) throw new Error(`${dbPath}: no such file`);
  const db = new Database(dbPath, { readonly: true });
  if (!tableExists(db, "discord_messages") || !tableExists(db, "channels")) {
    db.close();
    throw new Error(`${dbPath} is not a server.sqlite (no discord_messages/channels tables)`);
  }
  const packed = tableExists(db, "attachments");
  const hasFts = tableExists(db, "messages_fts");
  const meta = new Map<string, string>(
    tableExists(db, "server_meta")
      ? (db.query("SELECT key, value FROM server_meta").all() as any[]).map(r => [r.key, r.value])
      : [],
  );
  const guildId = meta.get("guild_id") || (db.query("SELECT guild_id FROM discord_messages WHERE guild_id IS NOT NULL LIMIT 1").get() as any)?.guild_id || "";

  const attsFor = (ids: string[]): Map<string, any> => {
    if (!packed || !ids.length) return new Map();
    const rows = db.query(
      `SELECT attachment_id, content_type, size FROM attachments WHERE message_id IN (${ids.map(() => "?").join(",")})`,
    ).all(...ids) as any[];
    return new Map(rows.map(r => [r.attachment_id, r]));
  };
  const shape = (rows: any[]) => {
    const atts = attsFor(rows.map(r => r.message_id));
    return rows.map(r => shapeMessage(r, atts));
  };

  const COLS = "message_id, author_id, author_name, ts, raw_json";
  function messages(q: URLSearchParams) {
    const thread = q.get("thread");
    const channel = q.get("channel");
    const where = thread ? "thread_id = ?" : "channel_id = ? AND thread_id IS NULL";
    const key = thread ?? channel;
    if (!key) return { error: "channel or thread required" };
    const limit = Math.min(Math.max(Number(q.get("limit")) || PAGE, 1), 500);
    const cursor = (id: string | null) =>
      id ? (db.query("SELECT ts, message_id FROM discord_messages WHERE message_id = ?").get(id) as any) : null;

    const older = (c: any, n: number, inclusive = false) => (db.query(
      `SELECT ${COLS} FROM discord_messages WHERE ${where}
         ${c ? `AND (ts < ? OR (ts = ? AND message_id ${inclusive ? "<=" : "<"} ?))` : ""}
       ORDER BY ts DESC, message_id DESC LIMIT ?`,
    ).all(...[key, ...(c ? [c.ts, c.ts, c.message_id] : []), n]) as any[]).reverse();
    const newer = (c: any, n: number) => db.query(
      `SELECT ${COLS} FROM discord_messages WHERE ${where} AND (ts > ? OR (ts = ? AND message_id > ?))
       ORDER BY ts ASC, message_id ASC LIMIT ?`,
    ).all(key, c.ts, c.ts, c.message_id, n) as any[];

    let rows: any[];
    let hasOlder = false, hasNewer = false;
    const around = cursor(q.get("around"));
    const after = cursor(q.get("after"));
    if (around) {
      const before = older(around, Math.ceil(limit / 2) + 1, true);
      hasOlder = before.length > Math.ceil(limit / 2);
      const next = newer(around, Math.floor(limit / 2) + 1);
      hasNewer = next.length > Math.floor(limit / 2);
      rows = [...before.slice(hasOlder ? 1 : 0), ...next.slice(0, Math.floor(limit / 2))];
    } else if (after) {
      const next = newer(after, limit + 1);
      hasNewer = next.length > limit;
      rows = next.slice(0, limit);
    } else {
      const before = older(cursor(q.get("before")), limit + 1);
      hasOlder = before.length > limit;
      rows = before.slice(hasOlder ? 1 : 0);
    }
    return { messages: shape(rows), hasOlder, hasNewer };
  }

  function search(q: string) {
    q = q.trim();
    if (!q) return { results: [], mode: "none" };
    let rows: any[];
    let mode: string;
    // trigram needs 3+ characters; shorter queries fall back to LIKE
    if (hasFts && [...q].length >= 3) {
      mode = "fts5";
      rows = db.query(
        `SELECT m.message_id, m.channel_id, m.thread_id, m.author_id, m.author_name, m.ts, m.content
           FROM messages_fts f JOIN discord_messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? ORDER BY m.ts DESC LIMIT 200`,
      ).all(`"${q.replace(/"/g, '""')}"`) as any[];
    } else {
      mode = "like";
      const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      rows = db.query(
        `SELECT message_id, channel_id, thread_id, author_id, author_name, ts, content FROM discord_messages
          WHERE content LIKE ? ESCAPE '\\' OR author_name LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT 200`,
      ).all(like, like) as any[];
    }
    return { mode, results: rows.map(r => ({ ...r, content: String(r.content ?? "").slice(0, 300) })) };
  }

  function attachment(id: string, req: Request): Response {
    if (!packed) return new Response("attachments not packed — run 'maw atlas pack <guild-folder>'", { status: 404 });
    const row = db.query("SELECT filename, content_type, data FROM attachments WHERE attachment_id = ?").get(id) as any;
    if (!row) return new Response("not found", { status: 404 });
    const data: Uint8Array = row.data;
    const headers: Record<string, string> = {
      "content-type": row.content_type || "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename ?? id)}`,
      "x-content-type-options": "nosniff",
    };
    // Uploaded HTML/SVG would run as this origin — serve those as downloads.
    if (/html|svg|xml|javascript/i.test(headers["content-type"])) {
      headers["content-type"] = "application/octet-stream";
      headers["content-disposition"] = headers["content-disposition"].replace(/^inline/, "attachment");
    }
    const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : data.length - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : data.length - 1;
      start = Math.max(0, start);
      end = Math.min(end, data.length - 1);
      if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${data.length}` } });
      return new Response(data.subarray(start, end + 1), {
        status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${data.length}` },
      });
    }
    return new Response(data, { headers });
  }

  const hasChannelMeta = tableExists(db, "channel_meta");
  function channelList() {
    const rows = db.query(
      `SELECT c.id, c.name, c.kind, c.type, c.parent_id, c.position, c.messages,
              (SELECT max(ts) FROM discord_messages m WHERE m.thread_id = c.id) AS last_ts
              ${hasChannelMeta ? ", cm.raw_json AS raw" : ""}
         FROM channels c ${hasChannelMeta ? "LEFT JOIN channel_meta cm ON cm.id = c.id" : ""}`,
    ).all() as any[];
    return rows.map(({ raw, ...c }) => {
      const r = raw ? JSON.parse(raw) : {};
      return { ...c, topic: r.topic ?? null, nsfw: !!r.nsfw, archived: !!r.thread_metadata?.archived, owner_id: r.owner_id ?? null };
    });
  }

  /** Forum/media channels hold only posts (threads): one card per post with its opening message. */
  function forum(channelId: string) {
    const threads = db.query(
      `SELECT c.id, c.name, c.messages, (SELECT max(ts) FROM discord_messages m WHERE m.thread_id = c.id) AS last_ts
         FROM channels c WHERE c.parent_id = ? AND c.kind = 'thread' ORDER BY last_ts DESC LIMIT 500`,
    ).all(channelId) as any[];
    const opener = db.query(
      `SELECT message_id, author_name, content, raw_json FROM discord_messages WHERE thread_id = ? ORDER BY ts ASC, message_id ASC LIMIT 1`,
    );
    return threads.map(t => {
      const m = opener.get(t.id) as any;
      const raw = m ? JSON.parse(m.raw_json) : null;
      const img = raw?.attachments?.find((a: any) => String(a.content_type ?? "").startsWith("image/"));
      return {
        ...t, author: m?.author_name ?? null, author_id: raw?.author?.id ?? null,
        preview: String(m?.content ?? "").slice(0, 240),
        image: img && packed && db.query("SELECT 1 FROM attachments WHERE attachment_id = ?").get(img.id) ? img.id : null,
      };
    });
  }

  function server() {
    const n = (sql: string) => (db.query(sql).get() as any).n as number;
    return {
      guild_id: guildId,
      name: meta.get("guild_name") || `guild ${guildId}`,
      exported_at: meta.get("exported_at") ?? null,
      messages: n("SELECT count(*) AS n FROM discord_messages"),
      attachments: packed ? n("SELECT count(*) AS n FROM attachments") : 0,
      packed, search: hasFts ? "fts5" : "like",
    };
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405 });
    const p = url.pathname;
    try {
      if (p === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (p === "/api/server") return json(server());
      if (p === "/api/channels") return json(channelList());
      if (p === "/api/users") {
        return json(db.query(
          `SELECT author_id AS id, max(author_name) AS name, max(author_is_bot) AS bot, count(*) AS messages
             FROM discord_messages GROUP BY author_id ORDER BY messages DESC`,
        ).all());
      }
      if (p === "/api/forum") return json(forum(url.searchParams.get("channel") ?? ""));
      if (p === "/api/messages") {
        const r = messages(url.searchParams);
        return json(r, "error" in r ? 400 : 200);
      }
      if (p === "/api/search") return json(search(url.searchParams.get("q") ?? ""));
      if (p.startsWith("/att/")) return attachment(decodeURIComponent(p.slice(5)), req);
      return new Response("not found", { status: 404 });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return { db, fetch, server };
}

export function startViewer(dbPath: string, opts: ViewerOpts = {}) {
  const host = opts.host ?? "127.0.0.1";
  if (!allowedHost(host)) throw new Error(`refusing to bind ${host} — use 127.0.0.1 or a tailscale 100.x address`);
  const v = openViewer(dbPath);
  const serve = (port: number) => Bun.serve({ hostname: host, port, fetch: v.fetch });
  let srv;
  try {
    srv = serve(opts.port ?? 7710);
  } catch (e) {
    if (opts.port !== undefined) throw e;
    srv = serve(0); // default port taken — any free one
  }
  const shown = host.includes(":") ? `[${host}]` : host;
  return { server: srv, url: `http://${shown}:${srv.port}/`, info: v.server() };
}
