// ψ Vault Scanner — Oracle Markdown Ledger (Soul Brews Studio)
// Scans every ψ vault under the ghq tree, indexes markdown into sqlite + FTS5.
// run: bun vault-scanner/server.ts   (or double-click "Vault Scanner.app")
import { Database } from "bun:sqlite";
import { join, resolve, basename } from "node:path";
import { readdirSync, readFileSync, statSync, realpathSync } from "node:fs";

const PORT = Number(process.env.VAULT_SCANNER_PORT || 47711);
const DB_PATH = join(import.meta.dir, "index.sqlite");
const EXCLUDE = /_archive\/|_husks|\.bak-|\.rescue-husks|node_modules/;
const FTS_BODY_CAP = 65536; // cap body stored in FTS per file

// ── db ──────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (
    path       TEXT PRIMARY KEY,
    vault      TEXT NOT NULL,
    rel_path   TEXT NOT NULL,
    title      TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    mtime      INTEGER NOT NULL,
    snippet    TEXT NOT NULL DEFAULT '',
    oracle_hit INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_files_vault  ON files(vault);
  CREATE INDEX IF NOT EXISTS idx_files_mtime  ON files(mtime DESC);
  CREATE INDEX IF NOT EXISTS idx_files_oracle ON files(oracle_hit, mtime DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path UNINDEXED, title, body);
  CREATE TABLE IF NOT EXISTS vaults (root TEXT PRIMARY KEY, name TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

// ── vault discovery (census one-liner, in-process) ──────────────────────────
function discoverVaults(): { root: string; name: string }[] {
  const ghq = Bun.which("ghq") || "/opt/homebrew/bin/ghq";
  const ghqRoot = new TextDecoder().decode(Bun.spawnSync([ghq, "root"]).stdout).trim();
  const list = new TextDecoder().decode(Bun.spawnSync([ghq, "list"]).stdout);
  const out: { root: string; name: string }[] = [];
  for (const repo of list.split("\n")) {
    const r = repo.trim();
    if (!r) continue;
    const root = join(ghqRoot, r, "ψ");
    if (EXCLUDE.test(root)) continue;
    try {
      if (statSync(root).isDirectory()) out.push({ root, name: basename(r) });
    } catch {}
  }
  return out;
}

// ── markdown walk + parse ───────────────────────────────────────────────────
function* walkMd(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (e.isFile() && e.name.endsWith(".md")) yield p;
  }
}

// Mixed conventions: YAML frontmatter (learnings/resonance/huginn) OR plain
// markdown starting with # H1 (retros/plans). Title = H1 > frontmatter title > filename.
function parseMd(raw: string, filename: string) {
  let body = raw;
  let fmTitle = "";
  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = raw.slice(0, end);
      const nl = raw.indexOf("\n", end + 1);
      body = nl === -1 ? "" : raw.slice(nl + 1);
      const m = fm.match(/^title:\s*(.+)\s*$/m);
      if (m) fmTitle = m[1].trim().replace(/^["']+|["']+$/g, "");
    }
  }
  const h1 = body.match(/^#\s+(.+)\s*$/m);
  const title = (h1 ? h1[1].trim() : "") || fmTitle || filename.replace(/\.md$/, "");
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return { title, body, snippet };
}

// ── single-job pattern (in-process async scan) ──────────────────────────────
type Job = { title: string; startedAt: string; lines: string[]; done: boolean; code: number | null };
let job: Job | null = null;

function startScan(): boolean {
  if (job && !job.done) return false;
  const j: Job = { title: "สแกน ψ vaults", startedAt: new Date().toISOString(), lines: [], done: false, code: null };
  job = j;
  runScan(j).catch(e => {
    j.lines.push(`✗ scan ล้มเหลว: ${e?.message || e}`);
    j.done = true;
    j.code = 1;
  });
  return true;
}

async function runScan(j: Job) {
  const t0 = Date.now();
  const push = (l: string) => { j.lines.push(l); if (j.lines.length > 500) j.lines.shift(); };
  const vaults = discoverVaults();
  push(`พบ ${vaults.length} vaults (ghq tree, ตัด _archive/_husks/.bak/.rescue-husks/node_modules)`);

  const known = new Map<string, { mtime: number; bytes: number }>();
  for (const r of db.query("SELECT path, mtime, bytes FROM files").all() as any[])
    known.set(r.path, { mtime: r.mtime, bytes: r.bytes });
  const seen = new Set<string>();

  const upsert = db.prepare(`
    INSERT INTO files (path, vault, rel_path, title, bytes, mtime, snippet, oracle_hit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET vault=excluded.vault, rel_path=excluded.rel_path,
      title=excluded.title, bytes=excluded.bytes, mtime=excluded.mtime,
      snippet=excluded.snippet, oracle_hit=excluded.oracle_hit`);
  const delFts = db.prepare("DELETE FROM files_fts WHERE path = ?");
  const insFts = db.prepare("INSERT INTO files_fts (path, title, body) VALUES (?, ?, ?)");
  const upVault = db.prepare("INSERT OR REPLACE INTO vaults (root, name, files) VALUES (?, ?, ?)");

  let total = 0, changed = 0, errors = 0;
  db.exec("DELETE FROM vaults");
  for (const v of vaults) {
    let vTotal = 0, vChanged = 0;
    const files = [...walkMd(v.root)];
    db.exec("BEGIN");
    try {
      for (const p of files) {
        let st;
        try { st = statSync(p); } catch { continue; }
        seen.add(p);
        vTotal++;
        const mtime = Math.floor(st.mtimeMs);
        const prev = known.get(p);
        if (prev && prev.mtime === mtime && prev.bytes === st.size) continue; // incremental skip
        let raw = "";
        try { raw = readFileSync(p, "utf8"); } catch { errors++; continue; }
        const { title, body, snippet } = parseMd(raw, basename(p));
        const oracleHit = /oracle/i.test(p) || /oracle/i.test(raw) ? 1 : 0;
        upsert.run(p, v.name, p.slice(v.root.length + 1), title, st.size, mtime, snippet, oracleHit);
        delFts.run(p);
        insFts.run(p, title, body.slice(0, FTS_BODY_CAP));
        vChanged++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    upVault.run(v.root, v.name, vTotal);
    total += vTotal;
    changed += vChanged;
    push(`${v.name}: ${vTotal} md (${vChanged} ใหม่/เปลี่ยน)`);
    await Bun.sleep(0); // yield to the server between vaults
  }

  // remove vanished files
  let removed = 0;
  db.exec("BEGIN");
  try {
    const delFile = db.prepare("DELETE FROM files WHERE path = ?");
    for (const p of known.keys())
      if (!seen.has(p)) { delFile.run(p); delFts.run(p); removed++; }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  const at = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_scan', ?)").run(at);
  const oracle = (db.query("SELECT COALESCE(SUM(oracle_hit),0) o FROM files").get() as any).o;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  push(`— จบ: ${vaults.length} vaults · ${total} ไฟล์ (${changed} indexed, ${removed} ลบ, ${errors} อ่านไม่ได้) · oracle ${oracle} · ${secs}s —`);
  j.done = true;
  j.code = 0;
}

// ── queries ─────────────────────────────────────────────────────────────────
function stats() {
  const s = db.query("SELECT COUNT(*) total, COALESCE(SUM(bytes),0) bytes, COALESCE(SUM(oracle_hit),0) oracle FROM files").get() as any;
  const perVault = db.query("SELECT vault, COUNT(*) files, SUM(oracle_hit) oracle FROM files GROUP BY vault ORDER BY files DESC").all();
  const last = db.query("SELECT v FROM meta WHERE k='last_scan'").get() as any;
  return { total: s.total, oracle: s.oracle, bytes: s.bytes, vaults: perVault.length, lastScan: last?.v || null, perVault };
}

function ftsQuery(q: string): string {
  // quote every token → literal phrase terms, immune to FTS syntax errors
  return q.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
}

function listFiles(q: string, vault: string, oracleOnly: boolean, limit: number) {
  const cols = "f.path, f.vault, f.rel_path, f.title, f.bytes, f.mtime, f.snippet, f.oracle_hit";
  const conds: string[] = [];
  const args: any[] = [];
  if (vault) { conds.push("f.vault = ?"); args.push(vault); }
  if (oracleOnly) conds.push("f.oracle_hit = 1");
  if (q) {
    const where = conds.length ? "AND " + conds.join(" AND ") : "";
    return db.query(
      `SELECT ${cols} FROM files_fts t JOIN files f ON f.path = t.path
       WHERE files_fts MATCH ? ${where} ORDER BY rank LIMIT ?`
    ).all(ftsQuery(q), ...args, limit);
  }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  return db.query(`SELECT ${cols} FROM files f ${where} ORDER BY f.mtime DESC LIMIT ?`).all(...args, limit);
}

// path guard: REALPATH (defeats symlink escapes) must live under a discovered
// vault root — roots realpath'd too so ψ-via-symlink repos still match. .md only.
function guardPath(p: string | null): string | null {
  if (!p) return null;
  let rp: string;
  try { rp = realpathSync(resolve(p)); } catch { return null; }
  if (!rp.endsWith(".md")) return null;
  const roots = db.query("SELECT root FROM vaults").all() as { root: string }[];
  const real = (r: string) => { try { return realpathSync(r); } catch { return r; } };
  if (!roots.some(r => { const rr = real(r.root); return rp === rr || rp.startsWith(rr + "/"); })) return null;
  return rp;
}

// ── server ──────────────────────────────────────────────────────────────────
const INDEX = Bun.file(join(import.meta.dir, "index.html"));
Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const json = (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (p === "/") return new Response(INDEX, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/api/stats") return json(stats());
    if (p === "/api/job") return json(job || { done: true, lines: [], title: null });

    if (p === "/api/scan" && req.method === "POST")
      return startScan() ? json({ ok: true }) : json({ error: "มี job ค้างอยู่" }, 409);

    if (p === "/api/files") {
      const q = (url.searchParams.get("q") || "").trim();
      const vault = (url.searchParams.get("vault") || "").trim();
      const oracleOnly = url.searchParams.get("oracle") === "1";
      const limit = Math.min(Number(url.searchParams.get("limit") || 100) || 100, 500);
      try {
        return json({ files: listFiles(q, vault, oracleOnly, limit) });
      } catch {
        return json({ files: [] });
      }
    }

    if (p === "/api/preview") {
      const rp = guardPath(url.searchParams.get("path"));
      if (!rp) return json({ error: "path อยู่นอก vault ที่รู้จัก" }, 400);
      try {
        return new Response(readFileSync(rp, "utf8"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch {
        return json({ error: "อ่านไฟล์ไม่ได้" }, 404);
      }
    }

    if (p === "/api/open" && req.method === "POST") {
      const body = await req.json().catch(() => ({} as any));
      const rp = guardPath(body.path || null);
      if (!rp) return json({ error: "path อยู่นอก vault ที่รู้จัก" }, 400);
      Bun.spawn(["open", rp]);
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});
console.log(`ψ📜 Vault Scanner: http://localhost:${PORT} (db: ${DB_PATH})`);
