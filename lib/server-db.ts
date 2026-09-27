/**
 * server-db — one sqlite per archived guild: <guild folder>/server.sqlite.
 *
 * Built from the channel blobs already in the folder (messages.jsonl + manifest.json
 * inside each .tar.gz), not from Discord, so it costs no API calls and covers blobs
 * kept from an earlier, resumed run. Safe to rebuild: it is written to a temp file
 * and renamed over the old one.
 *
 *   discord_messages  the archive's row shape (see discord-db.ts) + raw_json — the
 *                     full Discord message; thread messages carry channel_id = parent
 *                     and thread_id = the thread, same as the shared archive
 *   channels          every category, channel and thread by name, with its kind,
 *                     parent, message count and the blob file that holds it
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import { basename, join } from "path";
import { toRow } from "./download-target";

const SCHEMA = `
CREATE TABLE discord_messages (
  message_id       TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  thread_id        TEXT,
  guild_id         TEXT,
  author_id        TEXT NOT NULL,
  author_name      TEXT,
  author_is_bot    INTEGER NOT NULL DEFAULT 0,
  content          TEXT,
  attachments_json TEXT,
  ts               TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  raw_json         TEXT NOT NULL
);
CREATE INDEX idx_dm_channel_ts ON discord_messages(channel_id, ts);
CREATE INDEX idx_dm_thread     ON discord_messages(thread_id);
CREATE INDEX idx_dm_author     ON discord_messages(author_id);
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  kind        TEXT NOT NULL,   -- category | channel | thread
  type        INTEGER,
  parent_id   TEXT,
  position    INTEGER,
  messages    INTEGER,
  file        TEXT             -- blob holding it (a thread lives in its parent's blob)
);
`;

export interface ServerDbResult {
  path: string;
  messages: number;
  channels: number;
  threads: number;
}

function readMember(tarball: string, member: string): string {
  const out = Bun.spawnSync(["tar", "-xzOf", tarball, member]);
  if (out.exitCode !== 0) throw new Error(`cannot read ${member} from ${tarball}: ${out.stderr.toString().trim()}`);
  return out.stdout.toString();
}

export function buildServerDb(dir: string): ServerDbResult {
  const server = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
  const guildId: string = server.guild.id;
  const path = join(dir, "server.sqlite");
  const tmp = `${path}.building`;
  rmSync(tmp, { force: true });

  const db = new Database(tmp);
  try {
    db.exec(SCHEMA);
    const insMsg = db.prepare(
      `INSERT OR IGNORE INTO discord_messages
         (message_id, channel_id, thread_id, guild_id, author_id, author_name, author_is_bot,
          content, attachments_json, ts, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insCh = db.prepare(
      `INSERT OR REPLACE INTO channels (id, name, kind, type, parent_id, position, messages, file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const c of server.channels) {
      insCh.run(c.id, c.name, c.type === 4 ? "category" : "channel", c.type, c.parent_id ?? null, c.position ?? null, null, null);
    }

    let messages = 0, threads = 0;
    const counts = new Map<string, number>();
    const tarballs = readdirSync(dir).filter(f => f.endsWith(".tar.gz")).sort();
    db.exec("BEGIN");
    for (const file of tarballs) {
      const name = basename(file, ".tar.gz");
      const manifest = JSON.parse(readMember(join(dir, file), `${name}/manifest.json`));
      const ch = manifest.channel;
      const threadIds = new Set<string>();
      for (const t of manifest.threads ?? []) {
        threadIds.add(t.id);
        threads++;
        insCh.run(t.id, t.name, "thread", t.type, ch.id, null, null, file);
      }
      insCh.run(ch.id, ch.name, ch.type === 4 ? "category" : "channel", ch.type, ch.parent_id ?? null, ch.position ?? null, null, file);

      for (const line of readMember(join(dir, file), `${name}/messages.jsonl`).split("\n")) {
        if (!line) continue;
        const msg = JSON.parse(line);
        const inThread = threadIds.has(msg.channel_id);
        const r = toRow(msg, inThread ? ch.id : msg.channel_id, guildId, inThread ? msg.channel_id : null);
        messages += insMsg.run(
          r.message_id, r.channel_id, r.thread_id, r.guild_id, r.author_id, r.author_name, r.author_is_bot,
          r.content, r.attachments_json, r.ts, r.created_at, line,
        ).changes;
        counts.set(msg.channel_id, (counts.get(msg.channel_id) ?? 0) + 1);
      }
    }
    const setCount = db.prepare("UPDATE channels SET messages = ? WHERE id = ?");
    for (const [id, n] of counts) setCount.run(n, id);
    db.exec("COMMIT");

    const chCount = (db.query("SELECT count(*) AS n FROM channels WHERE kind = 'channel'").get() as { n: number }).n;
    db.close();
    if (existsSync(path)) rmSync(path);
    renameSync(tmp, path);
    return { path, messages, channels: chCount, threads };
  } catch (e) {
    try { db.close(); } catch {}
    rmSync(tmp, { force: true });
    throw e;
  }
}
