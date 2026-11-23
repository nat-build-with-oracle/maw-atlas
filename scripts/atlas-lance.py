#!/usr/bin/env python3
"""atlas-lance — the LanceDB side of `maw atlas embed` (run through uv; the plugin has no npm deps).

usage:
  atlas-lance.py embed <guild-folder>... [--lance DIR] [--room ID]... [--full]
                       [--model M] [--url URL] [--batch N]
  atlas-lance.py self-test

A guild folder is what `maw atlas download <guild> --out` writes: server.sqlite (every message,
raw_json, a channels table naming each blob) + one .tar.gz per channel. embed writes, from ONE
embedding pass:

  <guild-folder>/lance/                         table `messages`: every message with text
  <guild-folder>/channels/<blob name>/lance/    table `messages`: that room only (its threads too)
  --lance DIR                                   table `messages`: every guild given, together

Text = the message content plus its embeds' title/description/fields (a bot often posts only an
embed), cut at 6000 characters. Messages with no text (attachment-only, joins, pins) get no row.

Incremental by default: a row whose text and model are unchanged (text_sha) is not embedded again,
so re-running after a new download only embeds new or edited messages. Rows are committed every
4096 embeddings, so an interrupted run keeps its progress. Room and cross-guild tables are rebuilt
from the guild table (no second embedding) whenever their message_id+text_sha fingerprint differs.

--full re-embeds everything (all rooms: the guild table is rebuilt; with --room: those rooms).
--room ID limits the run to those rooms. Vectors come from an Ollama-compatible /api/embed server:
Chippy on the Apple Neural Engine by default (http://127.0.0.1:11445, embeddinggemma:ane-w8a16);
Ollama works the same (--url http://127.0.0.1:11434 --model embeddinggemma).
"""
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("LANCEDB_LOG", "error")   # lance warns "No existing dataset … will be created" on every new table
DEFAULT_URL = os.environ.get("ATLAS_EMBED_URL", "http://127.0.0.1:11445")
DEFAULT_MODEL = os.environ.get("ATLAS_EMBED_MODEL", "embeddinggemma:ane-w8a16")
MAX_CHARS = 6000          # same cut relic5 uses before encoding
COMMIT_EVERY = 4096       # embeddings per LanceDB commit
TABLE = "messages"
DIGITS = re.compile(r"^\d+$")


def say(*a):
    print(*a, flush=True)


# ── text ────────────────────────────────────────────────────────────────────

def message_text(content, raw_json):
    """content + embed text; '' when the message carries no words."""
    parts = [content.strip()] if content and content.strip() else []
    try:
        raw = json.loads(raw_json) if raw_json else {}
    except ValueError:
        raw = {}
    for e in raw.get("embeds") or []:
        for k in ("title", "description"):
            if e.get(k):
                parts.append(str(e[k]).strip())
        for f in e.get("fields") or []:
            line = " ".join(str(f.get(k, "")).strip() for k in ("name", "value")).strip()
            if line:
                parts.append(line)
        if (e.get("footer") or {}).get("text"):
            parts.append(str(e["footer"]["text"]).strip())
    return "\n".join(p for p in parts if p)[:MAX_CHARS]


def text_sha(model, text):
    return hashlib.sha256(f"{model}\n{text}".encode()).hexdigest()[:16]


# ── embedding server ────────────────────────────────────────────────────────

class Embedder:
    """POST {model, input:[...]} to <url>/api/embed. url 'fake:<dim>' = deterministic test vectors."""

    def __init__(self, url, model):
        self.url, self.model = url.rstrip("/"), model

    def __call__(self, texts):
        if self.url.startswith("fake:"):
            dim = int(self.url.split(":", 1)[1] or 8)
            out = []
            for t in texts:
                h = hashlib.sha256(t.encode()).digest()
                v = [(h[i % len(h)] - 127.5) / 127.5 for i in range(dim)]
                n = sum(x * x for x in v) ** 0.5 or 1.0
                out.append([x / n for x in v])
            return out
        body = json.dumps({"model": self.model, "input": texts}).encode()
        req = urllib.request.Request(f"{self.url}/api/embed", body, {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"embed server {self.url} answered HTTP {e.code}: {e.read()[:300]!r}")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            raise SystemExit(f"embed server {self.url} not reachable ({e}) — start Chippy, or point --url at "
                             f"Ollama: --url http://127.0.0.1:11434 --model embeddinggemma")
        vecs = data.get("embeddings")
        if not isinstance(vecs, list) or len(vecs) != len(texts):
            raise SystemExit(f"embed server {self.url} returned {len(vecs or [])} vectors for {len(texts)} texts")
        return vecs


# ── LanceDB helpers ─────────────────────────────────────────────────────────

def schema(pa, dim):
    s = pa.string()
    return pa.schema([
        ("message_id", s), ("guild_id", s), ("guild", s), ("channel_id", s), ("channel", s),
        ("thread_id", s), ("thread", s), ("author_id", s), ("author", s), ("is_bot", pa.bool_()),
        ("ts", s), ("text", s), ("content", s), ("attachments", s), ("text_sha", s), ("model", s),
        ("vector", pa.list_(pa.float32(), dim)),
    ])


def open_table(lancedb, path):
    """(db, table or None) — a missing or unreadable table is None (it gets rebuilt)."""
    db = lancedb.connect(str(path))
    try:
        return db, db.open_table(TABLE)
    except Exception:
        return db, None


def read_cols(tbl, cols):
    """Columns as python lists, without loading vectors; None when a column is missing."""
    try:
        try:
            t = tbl.to_lance().to_table(columns=cols)
        except Exception:
            t = tbl.to_arrow().select(cols)
        return {c: t[c].to_pylist() for c in cols}
    except Exception:
        return None


def fingerprints(tbl, key):
    """{key value: sha of sorted message_id:text_sha} — equal fingerprints = same rows, same vectors."""
    if tbl is None:
        return {}
    cols = read_cols(tbl, [key, "message_id", "text_sha"])
    if cols is None:
        return None
    groups = defaultdict(list)
    for k, m, s in zip(cols[key], cols["message_id"], cols["text_sha"]):
        groups[k].append(f"{m}:{s}")
    return {k: hashlib.sha256("\n".join(sorted(v)).encode()).hexdigest() for k, v in groups.items()}


def vector_dim(tbl):
    try:
        return tbl.schema.field("vector").type.list_size
    except Exception:
        return None


def rows_where(tbl, where):
    try:
        return tbl.to_lance().to_table(filter=where)
    except Exception:
        return tbl.search().where(where).limit(None).to_arrow()


# ── one guild ───────────────────────────────────────────────────────────────

def load_guild(folder, model, rooms):
    db = sqlite3.connect(f"file:{folder / 'server.sqlite'}?mode=ro", uri=True)
    server = json.loads((folder / "server.json").read_text()) if (folder / "server.json").exists() else {}
    guild_name = (server.get("guild") or {}).get("name") or folder.name
    names, room_dir = {}, {}
    for cid, name, kind, file in db.execute("select id, name, kind, file from channels"):
        names[cid] = name or ""
        if kind == "channel" and file:
            room_dir[cid] = file[: -len(".tar.gz")] if file.endswith(".tar.gz") else file
    rows, skipped, total = [], 0, 0
    q = """select message_id, channel_id, coalesce(thread_id,''), coalesce(guild_id,''), author_id,
                  coalesce(author_name,''), author_is_bot, coalesce(content,''), coalesce(attachments_json,''),
                  ts, raw_json
           from discord_messages order by ts"""
    for mid, cid, tid, gid, aid, aname, bot, content, atts, ts, raw in db.execute(q):
        if rooms and cid not in rooms:
            continue
        total += 1
        text = message_text(content, raw)
        if not text:
            skipped += 1
            continue
        rows.append(dict(message_id=mid, guild_id=gid, guild=guild_name, channel_id=cid,
                         channel=names.get(cid, ""), thread_id=tid, thread=names.get(tid, "") if tid else "",
                         author_id=aid, author=aname, is_bot=bool(bot), ts=ts, text=text, content=content,
                         attachments=atts, text_sha=text_sha(model, text), model=model))
    db.close()
    gid = next((r["guild_id"] for r in rows if r["guild_id"]), (server.get("guild") or {}).get("id", ""))
    return dict(name=guild_name, id=gid, rows=rows, total=total, skipped=skipped, room_dir=room_dir)


def embed_guild(folder, g, args, embed, lancedb, pa):
    rooms, full = args["rooms"], args["full"]
    gpath = folder / "lance"
    db, tbl = open_table(lancedb, gpath)
    if tbl is not None and read_cols(tbl, ["message_id", "text_sha"]) is None:
        say(f"  {gpath}: not a maw atlas table (no text_sha) — rebuilding it")
        tbl = None
        full = True
    rebuild_all = tbl is None or (full and not rooms)
    have = {} if rebuild_all or full else dict(zip(*read_cols(tbl, ["message_id", "text_sha"]).values()))
    todo = [r for r in g["rows"] if have.get(r["message_id"]) != r["text_sha"]]
    unchanged = len(g["rows"]) - len(todo)

    touched = {r["channel_id"] for r in todo}   # rooms re-embedded now: their tables are always rebuilt
    t0, last, done, dim, buf = time.time(), time.time(), 0, None, []
    created = not rebuild_all
    replace_rooms = full and bool(rooms) and tbl is not None

    def commit():
        nonlocal tbl, buf, created, replace_rooms
        if not buf:
            return
        data = pa.Table.from_pylist(buf, schema=schema(pa, dim))
        if not created:
            tbl = db.create_table(TABLE, data=data, schema=schema(pa, dim), mode="overwrite")
            created = True
        elif replace_rooms:   # --full --room: those rooms' old rows go only once new vectors exist
            tbl.delete("channel_id IN (" + ",".join(f"'{r}'" for r in sorted(rooms)) + ")")
            tbl.add(data)
            replace_rooms = False
        elif full and rooms:
            tbl.add(data)
        else:
            tbl.merge_insert("message_id").when_matched_update_all().when_not_matched_insert_all().execute(data)
        buf = []

    b = args["batch"]
    for i in range(0, len(todo), b):
        chunk = todo[i:i + b]
        vecs = embed([r["text"] for r in chunk])
        if dim is None:
            dim = len(vecs[0])
            old = vector_dim(tbl) if tbl is not None and not rebuild_all else None
            if old and old != dim:
                raise SystemExit(f"{gpath} holds {old}-d vectors, {args['model']} gives {dim}-d — "
                                 f"run again with --full (no --room) to rebuild with the new model")
        for r, v in zip(chunk, vecs):
            buf.append({**r, "vector": v})
        done += len(chunk)
        if len(buf) >= COMMIT_EVERY:
            commit()
        if time.time() - last >= 5 and done < len(todo):
            last = time.time()
            say(f"  embedded {done}/{len(todo)} · {done / (last - t0):.1f} texts/s")
    commit()
    dt = time.time() - t0
    rate = f" = {done / dt:.1f} texts/s" if done and dt > 0 else ""
    say(f"{g['name']}: {g['total']} messages, {len(g['rows'])} with text, {done} embedded in {dt:.1f} s{rate}"
        f" ({args['model']} @ {args['url']}), {unchanged} unchanged, {g['skipped']} without text")
    if tbl is None:
        say("  nothing to write (no message has text)")
        return None, False
    say(f"  lance: {gpath} table {TABLE} rows={tbl.count_rows()}")

    # rooms: rebuild every room table whose rows differ from the guild table's rows for that room
    want = fingerprints(tbl, "channel_id") or {}
    rebuilt, current = [], 0
    for cid, fp in sorted(want.items()):
        if rooms and cid not in rooms:
            continue
        rdir = g["room_dir"].get(cid) or cid
        rpath = folder / "channels" / rdir / "lance"
        rdb, rtbl = open_table(lancedb, rpath)
        have_fp = fingerprints(rtbl, "channel_id") if rtbl is not None else {}
        if cid not in touched and have_fp is not None and have_fp.get(cid) == fp and len(have_fp) == 1:
            current += 1
            continue
        if not DIGITS.match(cid):
            raise SystemExit(f"unexpected channel id {cid!r}")
        rdb.create_table(TABLE, data=rows_where(tbl, f"channel_id = '{cid}'"), mode="overwrite")
        rebuilt.append(rdir)
    say(f"  rooms: {len(rebuilt)} rebuilt, {current} up to date → {folder / 'channels'}/<room>/lance")
    for r in rebuilt:
        say(f"    ↻ {r}")
    return tbl, bool(touched)


def update_cross(cross_dir, gid, tbl, lancedb, touched):
    if not DIGITS.match(str(gid)):
        raise SystemExit(f"unexpected guild id {gid!r}")
    db, ctbl = open_table(lancedb, cross_dir)
    want = (fingerprints(tbl, "guild_id") or {}).get(gid)
    have = (fingerprints(ctbl, "guild_id") or {}).get(gid) if ctbl is not None else None
    if want == have and not touched:
        return "up to date"
    data = rows_where(tbl, f"guild_id = '{gid}'")
    if ctbl is None:
        db.create_table(TABLE, data=data, mode="overwrite")
    else:
        ctbl.delete(f"guild_id = '{gid}'")
        ctbl.add(data)
    return f"{data.num_rows} rows refreshed"


# ── cli ─────────────────────────────────────────────────────────────────────

def parse(argv):
    args = dict(folders=[], rooms=set(), full=False, lance=None, model=DEFAULT_MODEL, url=DEFAULT_URL, batch=64)
    it = iter(argv)
    for a in it:
        key, _, val = a.partition("=")
        if key in ("--room", "--lance", "--model", "--url", "--batch") and not val:
            val = next(it, "")
        if key == "--room":
            if not DIGITS.match(val):
                raise SystemExit(f"--room takes a channel id, got {val!r}")
            args["rooms"].add(val)
        elif key == "--lance":
            args["lance"] = val
        elif key == "--model":
            args["model"] = val
        elif key == "--url":
            args["url"] = val
        elif key == "--batch":
            args["batch"] = max(1, int(val))
        elif key == "--full":
            args["full"] = True
        elif a.startswith("--"):
            raise SystemExit(f"unknown flag {a}")
        else:
            args["folders"].append(a)
    return args


def cmd_embed(argv):
    import lancedb
    import pyarrow as pa
    args = parse(argv)
    if not args["folders"]:
        raise SystemExit(__doc__)
    embed = Embedder(args["url"], args["model"])
    for f in args["folders"]:
        folder = Path(f)
        if not (folder / "server.sqlite").exists():
            raise SystemExit(f"{folder}: no server.sqlite — run `maw atlas download <guild> --out` first")
        g = load_guild(folder, args["model"], args["rooms"])
        tbl, touched = embed_guild(folder, g, args, embed, lancedb, pa)
        if args["lance"] and tbl is not None:
            r = update_cross(args["lance"], g["id"], tbl, lancedb, touched)
            say(f"  all: {args['lance']} table {TABLE} — {g['name']}: {r}")
    if args["lance"]:
        _, ctbl = open_table(lancedb, args["lance"])
        if ctbl is not None:
            say(f"all: {args['lance']} table {TABLE} rows={ctbl.count_rows()}")


# ── self-test: fake guild folders + fake vectors, every path checked ────────

def cmd_self_test():
    import lancedb
    checks = 0

    def ok(cond, what):
        nonlocal checks
        if not cond:
            raise SystemExit(f"self-test FAILED: {what}")
        checks += 1

    def guild(root, gid, name, msgs):
        d = root / f"{name}-{gid}"
        d.mkdir(parents=True)
        db = sqlite3.connect(d / "server.sqlite")
        db.executescript("""
          create table discord_messages (message_id text primary key, channel_id text not null, thread_id text,
            guild_id text, author_id text not null, author_name text, author_is_bot integer not null default 0,
            content text, attachments_json text, ts text not null, created_at text not null, raw_json text not null);
          create table channels (id text primary key, name text, kind text not null, type integer,
            parent_id text, position integer, messages integer, file text);""")
        db.executemany("insert into channels values (?,?,?,?,?,?,?,?)", [
            ("10", "general", "channel", 0, None, 0, None, "general-10.tar.gz"),
            ("20", "chat", "channel", 0, None, 1, None, "chat-20.tar.gz"),
            ("21", "a thread", "thread", 11, "20", None, None, "chat-20.tar.gz")])
        for mid, cid, tid, content, raw in msgs:
            db.execute("insert into discord_messages values (?,?,?,?,?,?,?,?,?,?,?,?)",
                       (mid, cid, tid, gid, "u1", "someone", 0, content, None, f"2026-11-0{mid[-1]}", "x",
                        json.dumps(raw or {"content": content})))
        db.commit()
        db.close()
        (d / "server.json").write_text(json.dumps({"guild": {"id": gid, "name": name}}))
        return d

    def count(path):
        return lancedb.connect(str(path)).open_table(TABLE).count_rows()

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        a = guild(root, "111", "alpha", [
            ("1001", "10", None, "hello world", None),
            ("1002", "10", None, "", None),                                              # attachment-only: no row
            ("1003", "20", None, "", {"embeds": [{"title": "bot card", "description": "embed only"}]}),
            ("1004", "20", "21", "in a thread", None),
            ("1005", "20", None, "second chat line", None)])
        b = guild(root, "222", "beta", [("2001", "10", None, "other guild", None)])
        cross = root / "all"
        base = ["--url", "fake:8", "--model", "m1", "--lance", str(cross)]

        cmd_embed([str(a), str(b)] + base)
        ok(count(a / "lance") == 4, "guild table has the 4 messages with text (embed-only bot message included)")
        ok(count(a / "channels/general-10/lance") == 1, "room general: 1 row")
        ok(count(a / "channels/chat-20/lance") == 3, "room chat: 3 rows (thread message under its parent room)")
        ok(count(cross) == 5, "cross-guild table: 4 + 1")
        t = lancedb.connect(str(a / "lance")).open_table(TABLE).to_arrow()
        ok("bot card\nembed only" in t["text"].to_pylist(), "embed title+description became the text")
        ok(t.schema.field("vector").type.list_size == 8, "vector size taken from the server (8)")

        # incremental: nothing changed → nothing embedded, nothing rebuilt
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cmd_embed([str(a)] + base)
        ok(" 0 embedded" in out.getvalue() and "0 rebuilt, 2 up to date" in out.getvalue(), "re-run embeds 0, rebuilds 0")
        ok("up to date" in out.getvalue().split("all:")[1], "cross table untouched on re-run")

        # an edited message: 1 embedded, only its room rebuilt, cross table refreshed
        db = sqlite3.connect(a / "server.sqlite")
        db.execute("update discord_messages set content = 'hello edited' where message_id = '1001'")
        db.commit()
        db.close()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cmd_embed([str(a)] + base)
        s = out.getvalue()
        ok(" 1 embedded" in s and "1 rebuilt, 1 up to date" in s and "↻ general-10" in s, "edit → 1 embedded, room general rebuilt")
        ok(count(a / "lance") == 4 and count(cross) == 5, "edit keeps row counts (merge, not append)")
        txt = lancedb.connect(str(a / "channels/general-10/lance")).open_table(TABLE).to_arrow()["text"].to_pylist()
        ok(txt == ["hello edited"], "room table carries the edited text")

        # a deleted room table is rebuilt from the guild table without embedding
        import shutil
        shutil.rmtree(a / "channels/chat-20/lance")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cmd_embed([str(a)] + base)
        ok(" 0 embedded" in out.getvalue() and count(a / "channels/chat-20/lance") == 3, "missing room rebuilt, 0 embedded")

        # --full --room: only that room re-embedded
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cmd_embed([str(a), "--full", "--room", "20"] + base)
        ok(" 3 embedded" in out.getvalue() and count(a / "lance") == 4, "--full --room 20 re-embeds its 3 rows only")
        ok("1 rebuilt" in out.getvalue() and "↻ chat-20" in out.getvalue(), "a re-embedded room is rebuilt even with equal text")

        # new model with another vector size: refused without --full, rebuilt with it
        refused = None
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                cmd_embed([str(a), "--url", "fake:16", "--model", "m2"])
        except SystemExit as e:
            refused = str(e)
        ok(refused is not None and "--full" in refused, "dim change refused without --full, message names --full")
        ok(count(a / "lance") == 4, "a refused run leaves the table as it was")
        with contextlib.redirect_stdout(io.StringIO()):
            cmd_embed([str(a), "--url", "fake:16", "--model", "m2", "--full"])
        t = lancedb.connect(str(a / "lance")).open_table(TABLE)
        ok(t.schema.field("vector").type.list_size == 16 and t.count_rows() == 4, "--full rebuilt with 16-d vectors")
        ok(lancedb.connect(str(a / "channels/chat-20/lance")).open_table(TABLE).schema.field("vector").type.list_size == 16,
           "room tables follow the new model")

        # search works on a room table
        q = Embedder("fake:16", "m2")(["in a thread"])[0]
        hit = lancedb.connect(str(a / "channels/chat-20/lance")).open_table(TABLE).search(q).limit(1).to_list()[0]
        ok(hit["message_id"] == "1004", "nearest neighbour of a message's own text is that message")

    say(f"self-test ok ({checks} checks)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "embed":
        cmd_embed(sys.argv[2:])
    elif len(sys.argv) > 1 and sys.argv[1] == "self-test":
        cmd_self_test()
    else:
        raise SystemExit(__doc__)
