/**
 * pack — put every attachment of a guild folder into its server.sqlite, so the
 * db alone holds text, metadata and images (Discord CDN URLs in attachments_json
 * are signed and expire; the bytes only live inside the channel .tar.gz blobs).
 *
 *   attachments    one row per Discord attachment: ids, filename, type, size,
 *                  width/height, sha256 and the bytes (data BLOB)
 *   messages_fts   trigram FTS5 index over discord_messages.content + author_name
 *                  (trigram, not unicode61: Thai has no spaces between words)
 *   server_meta    key/value — guild name and id, so the viewer needs only the db
 *
 * Reads only the folder (no Discord calls). One tarball is extracted at a time
 * into a temp dir and committed in ~64 MB transactions, so memory holds a slice,
 * not the guild. Idempotent: an attachment already in the table is skipped
 * before its tarball is even extracted.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  thread_id     TEXT,
  filename      TEXT,
  content_type  TEXT,
  size          INTEGER,
  width         INTEGER,
  height        INTEGER,
  sha256        TEXT,
  data          BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_message ON attachments(message_id);
CREATE TABLE IF NOT EXISTS server_meta (key TEXT PRIMARY KEY, value TEXT);
`;

export interface MissingAttachment {
  file: string;
  message_id: string;
  attachment_id: string;
  filename: string;
  reason: string;
}

export interface PackResult {
  db: string;
  tarballs: number;
  /** attachments named in attachments_json across all blobs */
  listed: number;
  added: number;
  already: number;
  addedBytes: number;
  /** sha256 of the bytes differs from manifest.json — stored anyway, reported */
  shaMismatch: number;
  missing: MissingAttachment[];
  totalRows: number;
  totalBytes: number;
  fts: "built" | "unavailable";
  dbBytes: number;
}

function readMember(tarball: string, member: string): string {
  const out = Bun.spawnSync(["tar", "-xzOf", tarball, member]);
  if (out.exitCode !== 0) throw new Error(`cannot read ${member} from ${tarball}: ${out.stderr.toString().trim()}`);
  return out.stdout.toString();
}

const COMMIT_BYTES = 64 * 1048576;

const sha256 = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

export function packGuild(dir: string, onTarball?: (file: string, added: number) => void): PackResult {
  const path = join(dir, "server.sqlite");
  if (!existsSync(path)) throw new Error(`${path} not found — run 'maw atlas download <guildId> --out' first`);
  const db = new Database(path);
  const result: PackResult = {
    db: path, tarballs: 0, listed: 0, added: 0, already: 0, addedBytes: 0, shaMismatch: 0,
    missing: [], totalRows: 0, totalBytes: 0, fts: "unavailable", dbBytes: 0,
  };
  try {
    db.exec(SCHEMA);
    const serverJson = join(dir, "server.json");
    if (existsSync(serverJson)) {
      const server = JSON.parse(readFileSync(serverJson, "utf8"));
      const setMeta = db.prepare("INSERT OR REPLACE INTO server_meta (key, value) VALUES (?, ?)");
      setMeta.run("guild_id", String(server.guild?.id ?? ""));
      setMeta.run("guild_name", String(server.guild?.name ?? ""));
      setMeta.run("exported_at", String(server.exported_at ?? ""));
    }
    const has = db.prepare("SELECT 1 FROM attachments WHERE attachment_id = ?");
    const ins = db.prepare(
      `INSERT OR IGNORE INTO attachments
         (attachment_id, message_id, channel_id, thread_id, filename, content_type, size, width, height, sha256, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tarballs = readdirSync(dir).filter(f => f.endsWith(".tar.gz")).sort();
    for (const file of tarballs) {
      result.tarballs++;
      const tarball = join(dir, file);
      const name = basename(file, ".tar.gz");
      const manifest = JSON.parse(readMember(tarball, `${name}/manifest.json`));
      const ch = manifest.channel;
      const threadIds = new Set<string>((manifest.threads ?? []).map((t: any) => t.id));
      const byId = new Map<string, any>((manifest.attachments ?? []).map((a: any) => [a.attachment_id, a]));

      // Every attachment the messages name, with where it belongs in the server db.
      const wanted: { msg: any; att: any; channelId: string; threadId: string | null }[] = [];
      for (const line of readMember(tarball, `${name}/messages.jsonl`).split("\n")) {
        if (!line) continue;
        const msg = JSON.parse(line);
        const inThread = threadIds.has(msg.channel_id);
        for (const att of msg.attachments ?? []) {
          result.listed++;
          if (has.get(att.id)) { result.already++; continue; }
          wanted.push({ msg, att, channelId: inThread ? ch.id : msg.channel_id, threadId: inThread ? msg.channel_id : null });
        }
      }
      if (!wanted.length) { onTarball?.(file, 0); continue; }

      const tmp = mkdtempSync(join(tmpdir(), "atlas-pack-"));
      let added = 0;
      try {
        // A failed extract is not fatal: every file it left out is reported as missing, with tar's reason.
        const x = Bun.spawnSync(["tar", "-xzf", tarball, "-C", tmp, `${name}/attachments`]);
        const tarErr = x.exitCode === 0 ? "" : ` (tar: ${x.stderr.toString().trim().split("\n")[0]})`;
        let pending = 0;
        db.exec("BEGIN");
        for (const { msg, att, channelId, threadId } of wanted) {
          const entry = byId.get(att.id);
          const p = entry?.path ? join(tmp, name, entry.path) : "";
          if (!entry || !existsSync(p)) {
            result.missing.push({
              file, message_id: msg.id, attachment_id: att.id, filename: att.filename,
              reason: entry ? `${entry.path} not in tar${tarErr}` : "not in manifest.json",
            });
            continue;
          }
          const data = readFileSync(p);
          const sum = sha256(data);
          if (entry.sha256 && entry.sha256 !== sum) result.shaMismatch++;
          const type = att.content_type || Bun.file(p).type.split(";")[0] || null;
          const n = ins.run(
            att.id, msg.id, channelId, threadId, att.filename ?? entry.filename ?? null, type,
            data.length, att.width ?? null, att.height ?? null, sum, data,
          ).changes;
          if (n) { added++; result.addedBytes += data.length; pending += data.length; }
          // Commit in ~64 MB slices and collect the freed buffers, so a 500 MB tarball
          // does not pile up in memory before the GC gets to it.
          if (pending >= COMMIT_BYTES) { db.exec("COMMIT"); Bun.gc(true); db.exec("BEGIN"); pending = 0; }
        }
        db.exec("COMMIT");
        Bun.gc(true);
      } catch (e) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw e;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      result.added += added;
      onTarball?.(file, added);
    }

    result.fts = buildFts(db) ? "built" : "unavailable";
    const t = db.query("SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS b FROM attachments").get() as { n: number; b: number };
    result.totalRows = t.n;
    result.totalBytes = t.b;
  } finally {
    db.close();
  }
  result.dbBytes = statSync(path).size;
  return result;
}

/** (Re)build the trigram index; false when this SQLite has no FTS5 trigram tokenizer. */
function buildFts(db: Database): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, author_name, content='discord_messages', content_rowid='rowid', tokenize='trigram')`);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    return true;
  } catch {
    return false;
  }
}
