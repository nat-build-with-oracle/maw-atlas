#!/usr/bin/env python3
"""atlas-brain — a Discord server (or several) as a 3D meaning map, for `maw atlas brain` (run through uv).

usage:
  atlas-brain.py insight <brain dir>     topics (HDBSCAN + c-TF-IDF) + stats → insight.json, topic.u16
  atlas-brain.py build <guild-folder>... --out DIR [--gap H] [--chars N] [--min-chars N] [--url URL] [--model M]
  atlas-brain.py self-test

The recipe is the fleet's brain (laris-co/book-library tools/brain_build.py → facebook-oracle scripts/brain_build.py,
2026-11-19), applied to `maw atlas download <guild> --out` folders (server.sqlite):

Unit = one CONVERSATION CHUNK, not one message. Discord messages are short (a word, a link, "ok"), and a map of single
messages sorts by script (Thai vs Latin), not meaning — the Facebook brain measured that. A chunk is consecutive
messages of one room or one thread with no silence longer than --gap hours (3), packed up to --chars characters (1200);
chunks under --min-chars (40) are dropped. Text = message + embed text (atlas-lance.py message_text), WITHOUT author
names, so people do not pull the map apart; the panel still shows who said what.

Vectors: EmbeddingGemma through an Ollama-style /api/embed (Chippy on the Apple Neural Engine by default), document
prompt "title: none | text: ", shortest first in batches of 64 (fixed-shape ANE batches pad less). Cached per embedded
string (sha1) in DIR/cache/, so a rebuild after a new download embeds only new chunks.

Map: UMAP 3D (cosine, n_neighbors 15, min_dist 0.15, random_state 7) on the first 256 dims (Matryoshka, renormalised),
4 nearest links from UMAP's own neighbour graph — or pynndescent when UMAP has none (umap-learn 0.6, small sets).
Written to DIR (local data: message text — never commit it):

  xyz.f32  float32 [n x 3], about ±100        grp.u32  uint32 [n], room (channel) of each point
  src.u8   0 people, 1 bots, 2 both            mon.u16  uint16 [n], months since 2000-01
  gld.u8   uint8 [n], which server             knn.u32  uint32 [n x 4] nearest in meaning, knn_cos.f16 their cosine
  vec.i8   int8 [n x 256] for search           p/<s>.json  64 points a shard: [start_ms, end_ms, thread_or_null, [[ms, who, text, bot], ...]]
  meta.json  counts, groups (room title, server, points, centroid), servers, stats, timings

Prints counts, rates and timings only, never message content.
"""
import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

SHARD, DIM, K = 64, 256, 4
DOC = "title: none | text: "
QUERY = "task: search result | query: "
DEFAULT_URL = os.environ.get("ATLAS_EMBED_URL", "http://127.0.0.1:11445")
DEFAULT_MODEL = os.environ.get("ATLAS_EMBED_MODEL", "embeddinggemma:ane-w8a16")


def say(*a):
    print(*a, flush=True)


def _lance_helpers():
    """message_text() lives in atlas-lance.py next to this file (one definition of 'the text of a message')."""
    spec = importlib.util.spec_from_file_location("atlas_lance", Path(__file__).with_name("atlas-lance.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def thai_share(s):
    th = sum(1 for ch in s if "฀" <= ch <= "๿")
    lat = sum(1 for ch in s if ch.isascii() and ch.isalpha())
    return th / (th + lat) if th + lat else 0.0


def iso_ms(ts):
    from datetime import datetime
    return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)


# ── load + chunk ────────────────────────────────────────────────────────────

def load(folders, gap_h, cap, min_chars):
    message_text = _lance_helpers().message_text
    points, groups, servers, gidx = [], [], [], {}
    for si, folder in enumerate(folders):
        folder = Path(folder)
        server = json.loads((folder / "server.json").read_text()) if (folder / "server.json").exists() else {}
        sname = (server.get("guild") or {}).get("name") or folder.name
        servers.append({"name": sname, "id": str((server.get("guild") or {}).get("id") or "")})
        db = sqlite3.connect(f"file:{folder / 'server.sqlite'}?mode=ro", uri=True)
        names = {cid: (name or "") for cid, name in db.execute("select id, name from channels")}
        rows = db.execute("""select channel_id, coalesce(thread_id,''), ts, coalesce(author_name,''), author_is_bot,
                                    coalesce(content,''), raw_json
                             from discord_messages order by channel_id, coalesce(thread_id,''), ts""").fetchall()
        db.close()
        gap = gap_h * 3600_000
        cur, size, key, prev_ms = [], 0, None, 0

        def flush():
            if not cur:
                return
            text = "\n".join(t for _, _, t, _ in cur)
            if len(text) < min_chars:
                return
            room, thread = key
            gk = (si, room)
            if gk not in gidx:
                gidx[gk] = len(groups)
                groups.append({"title": f"#{names.get(room) or room}", "server": si, "room_id": room})
            bots = {b for _, _, _, b in cur}
            points.append({"g": gidx[gk], "si": si, "start": cur[0][0], "end": cur[-1][0],
                           "thread": names.get(thread) if thread else None,
                           "src": 2 if len(bots) > 1 else (1 if True in bots else 0),
                           "lines": [[ms, who, t, 1 if b else 0] for ms, who, t, b in cur], "text": text})

        for room, thread, ts, who, bot, content, raw in rows:
            t = message_text(content, raw)
            if not t:
                continue
            ms = iso_ms(ts)
            if (room, thread) != key or ms - prev_ms > gap or (size and size + len(t) + 1 > cap):
                flush()
                cur, size = [], 0
            key, prev_ms = (room, thread), ms
            cur.append((ms, who, t, bool(bot)))
            size += len(t) + 1
        flush()
        say(f"{sname}: {sum(1 for p in points if p['si'] == si):,} chunks from {len(rows):,} messages "
            f"(gap {gap_h} h, <= {cap} chars, >= {min_chars})")
    return points, groups, servers


# ── vectors, cached per embedded string ─────────────────────────────────────

def embed(texts, cache, url, model, np):
    cache.mkdir(parents=True, exist_ok=True)
    strs = [DOC + t[:2400] for t in texts]
    keys = [hashlib.sha1(f"{model}\n{s}".encode()).hexdigest()[:20] for s in strs]
    vfile, kfile = cache / "vec.f16.npy", cache / "keys.txt"
    have, OV = {}, None
    if vfile.exists() and kfile.exists():
        OV, ok = np.load(vfile), kfile.read_text().split()
        if len(ok) == len(OV):
            have = {k: n for n, k in enumerate(ok)}
        else:
            OV = None
    todo = sorted({k: n for n, k in enumerate(keys) if k not in have}.values(), key=lambda n: len(strs[n]))
    say(f"vectors: {len(keys) - len(todo):,} from cache, {len(todo):,} to embed")
    new_v, new_k, took = [], [], 0.0

    def call(batch):
        if url.startswith("fake:"):
            dim = int(url.split(":", 1)[1] or 768)
            out = []
            for s in batch:
                h = hashlib.sha256(s.encode()).digest()
                out.append([(h[i % 32] - 127.5) / 127.5 for i in range(dim)])
            return out
        req = urllib.request.Request(f"{url.rstrip('/')}/api/embed", json.dumps({"model": model, "input": batch}).encode(),
                                     {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)["embeddings"]
        except OSError as e:
            raise SystemExit(f"embed server {url} not reachable ({e}) — start Chippy, or --url http://127.0.0.1:11434 "
                             f"--model embeddinggemma for Ollama")

    def save():
        if not new_v:
            return
        stack = np.asarray(new_v, np.float16)
        np.save(vfile, stack if OV is None or not len(OV) else np.concatenate([OV, stack]))
        kfile.write_text("\n".join(list(have) + new_k))

    if todo:
        t0, last = time.time(), 0.0
        for k in range(0, len(todo), 64):
            part = todo[k:k + 64]
            new_v.extend(call([strs[n] for n in part]))
            new_k.extend(keys[n] for n in part)
            done, el = min(k + 64, len(todo)), time.time() - t0
            if el - last >= 10 or done == len(todo):
                last = el
                say(f"  embed {100 * done / len(todo):5.1f}%  {done:,}/{len(todo):,}  {done / max(el, 1e-9):,.0f} texts/s")
        took = time.time() - t0
        save()
    V = np.load(vfile)
    pos = {k: n for n, k in enumerate(kfile.read_text().split())}
    return np.asarray(V[[pos[k] for k in keys]], np.float32), len(todo), took


# ── map ─────────────────────────────────────────────────────────────────────

def build(folders, out, gap=3.0, chars=1200, min_chars=40, url=DEFAULT_URL, model=DEFAULT_MODEL):
    import numpy as np
    T0 = time.time()
    out = Path(out)
    points, groups, servers = load(folders, gap, chars, min_chars)
    if len(points) < 6:
        raise SystemExit(f"only {len(points)} chunks — too few for a map")
    V, embedded, embed_s = embed([p["text"] for p in points], out / "cache", url, model, np)
    X = V[:, :DIM] / (np.linalg.norm(V[:, :DIM], axis=1, keepdims=True) + 1e-9)

    import umap  # heavy import after the cheap work
    nn = min(15, len(X) - 1)
    t1 = time.time()
    say(f"UMAP 3D on {len(X):,} x {DIM} (cosine, n_neighbors {nn}, min_dist 0.15) ...")
    reducer = umap.UMAP(n_components=3, n_neighbors=nn, min_dist=0.15, metric="cosine", random_state=7, low_memory=True)
    P = reducer.fit_transform(X).astype(np.float32)
    ki, kd = getattr(reducer, "_knn_indices", None), getattr(reducer, "_knn_dists", None)
    if ki is None:   # umap-learn 0.6 dropped _knn_indices, and small sets never had it
        from pynndescent import NNDescent
        ki, kd = NNDescent(X, metric="cosine", n_neighbors=min(K + 1, len(X)), random_state=7, low_memory=True).neighbor_graph
    k = min(K, ki.shape[1] - 1)
    knn = np.asarray(ki[:, 1:k + 1], dtype=np.uint32)
    kdist = np.asarray(kd[:, 1:k + 1], dtype=np.float32)
    P -= P.mean(axis=0)
    P *= 100 / (np.abs(P).max() or 1)
    umap_s = time.time() - t1
    say(f"UMAP 3D in {umap_s:.0f} s")

    grp = np.array([p["g"] for p in points], np.uint32)
    rng = np.random.default_rng(3)
    thai = np.array([thai_share(p["text"]) > 0.5 for p in points])
    a_ = np.repeat(np.arange(len(points)), k)
    b_ = knn.reshape(-1).astype(np.int64)
    r_ = rng.integers(0, len(points), len(a_))
    stats = {"links_same_room": round(float((grp[a_] == grp[b_]).mean()), 3),
             "random_same_room": round(float((grp[a_] == grp[r_]).mean()), 3),
             "links_same_script": round(float((thai[a_] == thai[b_]).mean()), 3),
             "random_same_script": round(float((thai[a_] == thai[r_]).mean()), 3),
             "thai_points": round(float(thai.mean()), 3)}
    say(f"links: same room {stats['links_same_room']} (random {stats['random_same_room']}), "
        f"same script {stats['links_same_script']} (random {stats['random_same_script']})")

    out.mkdir(parents=True, exist_ok=True)
    P.tofile(out / "xyz.f32")
    grp.tofile(out / "grp.u32")
    np.array([p["src"] for p in points], np.uint8).tofile(out / "src.u8")
    np.array([p["si"] for p in points], np.uint8).tofile(out / "gld.u8")
    mon = [(time.gmtime(p["start"] / 1000).tm_year - 2000) * 12 + time.gmtime(p["start"] / 1000).tm_mon - 1 for p in points]
    np.array(mon, np.uint16).tofile(out / "mon.u16")
    knn.tofile(out / "knn.u32")
    (1 - kdist).astype(np.float16).tofile(out / "knn_cos.f16")
    scale = 127 / float(np.abs(X).max())
    np.clip(np.round(X * scale), -127, 127).astype(np.int8).tofile(out / "vec.i8")
    pdir = out / "p"
    pdir.mkdir(exist_ok=True)
    for old in pdir.glob("*.json"):
        old.unlink()
    for s in range(0, len(points), SHARD):
        part = [[p["start"], p["end"], p["thread"], p["lines"]] for p in points[s:s + SHARD]]
        (pdir / f"{s // SHARD}.json").write_text(json.dumps(part, ensure_ascii=False, separators=(",", ":")))
    counts = np.bincount(grp, minlength=len(groups))
    for gi, g in enumerate(groups):
        g["points"] = int(counts[gi])
        g["c"] = [round(float(v), 2) for v in P[grp == gi].mean(axis=0)] if counts[gi] else [0, 0, 0]
    humans = {}
    for p in points:
        for _, who, _, bot in p["lines"]:
            if not bot:
                humans[who] = humans.get(who, 0) + 1
    links = len({(min(i, j), max(i, j)) for i, j in zip(a_.tolist(), b_.tolist())})
    meta = {"n": len(points), "k": k, "dim": DIM, "scale": scale, "shard": SHARD,
            "owner": max(humans, key=humans.get) if humans else "",
            "unit": {"gap_hours": gap, "max_chars": chars, "min_chars": min_chars},
            "counts": {"points": len(points), "rooms": len(groups), "servers": len(servers),
                       "messages": sum(len(p["lines"]) for p in points), "links_unique": links,
                       "embedded_now": embedded, "embed_seconds": round(embed_s, 1),
                       "embed_rate": round(embedded / embed_s, 1) if embedded and embed_s else None,
                       "umap_seconds": round(umap_s, 1), "total_seconds": round(time.time() - T0, 1)},
            "stats": stats, "model": model, "embed_url": url, "doc_prompt": DOC, "query_prompt": QUERY,
            "groups": groups, "servers": servers, "built": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    mb = sum(f.stat().st_size for f in out.rglob("*") if f.is_file() and "cache" not in f.parts) / 2**20
    say(f"wrote {out} ({mb:.1f} MB without cache): {json.dumps(meta['counts'])}")
    return meta



# ── insight: topics (HDBSCAN on the map + c-TF-IDF keywords) and old-school stats ──────────────
# BERTopic's recipe (embed → UMAP → HDBSCAN → c-TF-IDF), run on the brain folder that build wrote: no re-embedding.
# Thai has no spaces, so words come from PyThaiNLP's newmm tokenizer; Latin words from a regex.

EN_STOP = set("""a an and are as at be but by for from has have i if in into is it its me my no not of on or our so that
the their them then there these they this to too up us was we were what when which who will with you your ok okay yes
just can do does did get got like also more very all any been one would should could about than out how""".split())


FILLERS = set("พี่ ผม หนู เรา เค้า ทำ เงี้ย งี้ ไอ้ เดี๋ยว ไหม มั้ย บอ เอ่อ อะ อ่า อ่ะ อืม อือ อ้า ครับ คับ ค่ะ คะ นะ น่ะ จ้า จ้ะ ฮะ เนี่ย อ่ะนะ แบบ ก็ คือ มัน เลย ละ แล้ว".split())


def tokenizer(names=()):
    import re
    from pythainlp.corpus import thai_stopwords
    from pythainlp.tokenize import word_tokenize
    stop = set(thai_stopwords()) | EN_STOP | FILLERS
    for nm in names:   # people's names say who talked, not what about
        stop.update(w for w in re.split(r"[^\w]+", nm.lower()) if len(w) >= 2)
    url = re.compile(r"https?://\S+|<[@#:!&][^>]*>|`[^`]*`")
    mirror = re.compile(r"\d{1,2}/\d{1,2}/\d{4},? \d{1,2}:\d{2} - [^-\n]{1,40} - ")   # a mirrored chat line's "date - name - "
    latin = re.compile(r"[a-z][a-z0-9_+.-]{1,}")

    def words(text):
        text = url.sub(" ", mirror.sub(" ", text)).lower()
        out = []
        for tok in word_tokenize(text, engine="newmm", keep_whitespace=False):
            tok = tok.strip(" .,:;!?()[]{}\"'*_~|>-")
            if len(tok) < 2 or tok in stop or tok.isdigit():
                continue
            if tok.isascii():
                out.extend(w for w in latin.findall(tok) if w not in stop)
            else:
                out.append(tok)
        return out
    return words


def insight(out):
    import numpy as np
    from collections import Counter, defaultdict
    from sklearn.cluster import HDBSCAN
    out = Path(out)
    meta = json.loads((out / "meta.json").read_text())
    n, dim = meta["n"], meta["dim"]
    xyz = np.fromfile(out / "xyz.f32", np.float32).reshape(n, 3)
    vec = np.fromfile(out / "vec.i8", np.int8).reshape(n, dim).astype(np.float32)
    vec /= np.linalg.norm(vec, axis=1, keepdims=True) + 1e-9
    grp = np.fromfile(out / "grp.u32", np.uint32)
    src = np.fromfile(out / "src.u8", np.uint8)
    pts = []
    for s_ in range(0, n, meta["shard"]):
        pts.extend(json.loads((out / "p" / f"{s_ // meta['shard']}.json").read_text()))
    t0 = time.time()

    mcs = max(8, n // 80)
    labels = HDBSCAN(min_cluster_size=mcs, min_samples=max(3, mcs // 3)).fit_predict(xyz)
    topics_ids = sorted(set(labels.tolist()) - {-1}, key=lambda t: -(labels == t).sum())
    remap = {t: i for i, t in enumerate(topics_ids)}
    topic = np.array([remap.get(int(l), 65535) for l in labels], np.uint16)
    topic.tofile(out / "topic.u16")

    names = {l[1] for p in pts for l in p[3]}
    for p in pts:   # names inside mirrored lines ("22/11/2026 08:25 - Some One - text")
        for l in p[3]:
            for m in __import__("re").finditer(r"\d{1,2}/\d{1,2}/\d{4},? \d{1,2}:\d{2} - ([^-\n]{1,40}) - ", l[2]):
                names.add(m.group(1).strip())
    words = tokenizer(names)
    toks = [words("\n".join(l[2] for l in p[3])) for p in pts]
    per = [Counter() for _ in topics_ids]
    for i, t in enumerate(topic):
        if t != 65535:
            per[t].update(toks[i])
    total = Counter()
    for c in per:
        total.update(c)
    avg = (sum(total.values()) / max(1, len(per))) or 1
    bkk = lambda ms: time.gmtime(ms / 1000 + 7 * 3600)   # Asia/Bangkok
    day = lambda ms: time.strftime("%Y-%m-%d", bkk(ms))
    last_ms = max(p[1] for p in pts)

    topics = []
    for ti, c in enumerate(per):
        idx = np.where(topic == ti)[0]
        size = sum(c.values()) or 1
        score = {w: (f / size) * np.log(1 + avg / total[w]) for w, f in c.items() if f >= 2}
        kw = [w for w, _ in sorted(score.items(), key=lambda x: -x[1])[:10]]
        cen = vec[idx].mean(axis=0)
        cen /= np.linalg.norm(cen) + 1e-9
        rep = idx[np.argsort(-(vec[idx] @ cen))[:5]].tolist()
        rooms = Counter(meta["groups"][grp[i]]["title"] for i in idx).most_common(4)
        people = Counter(l[1] for i in idx for l in pts[i][3] if not l[3]).most_common(5)
        recent = sum(1 for i in idx if last_ms - pts[i][1] < 14 * 86400_000)
        topics.append({"id": ti, "label": " · ".join(kw[:3]), "keywords": kw, "chunks": int(len(idx)),
                       "messages": int(sum(len(pts[i][3]) for i in idx)),
                       "first": day(min(pts[i][0] for i in idx)), "last": day(max(pts[i][1] for i in idx)),
                       "rooms": rooms, "people": people, "bot_share": round(float((src[idx] > 0).mean()), 2),
                       "recent_share": round(recent / len(idx), 2), "representative": rep,
                       "centroid_xyz": [round(float(v), 1) for v in xyz[idx].mean(axis=0)]})
    all_recent = sum(1 for p in pts if last_ms - p[1] < 14 * 86400_000) / n
    for t in topics:
        t["rising"] = round(t["recent_share"] / all_recent, 2) if all_recent else None

    hours, days, authors, bots = Counter(), Counter(), Counter(), Counter()
    for p in pts:
        for ms, who, _, bot in p[3]:
            hours[bkk(ms).tm_hour] += 1
            days[day(ms)] += 1
            (bots if bot else authors)[who] += 1
    rooms_all = Counter(meta["groups"][g]["title"] for g in grp.tolist())
    over = {"built": meta["built"], "counts": meta["counts"], "stats": meta["stats"], "unit": meta["unit"],
            "servers": [s_["name"] for s_ in meta.get("servers", [])],
            "first_day": min(days), "last_day": max(days), "active_days": len(days),
            "messages_by_hour_bkk": [hours.get(h, 0) for h in range(24)],
            "messages_by_day": sorted(days.items()), "busiest_days": days.most_common(5),
            "top_rooms_by_chunks": rooms_all.most_common(10), "top_people": authors.most_common(10),
            "top_bots": bots.most_common(5),
            "bot_message_share": round(sum(bots.values()) / max(1, sum(bots.values()) + sum(authors.values())), 3),
            "topics": len(topics), "noise_chunks": int((topic == 65535).sum()),
            "clustering": {"method": "HDBSCAN on the 3D map", "min_cluster_size": mcs},
            "keywords": "c-TF-IDF over PyThaiNLP newmm + latin words, stopwords removed"}
    (out / "insight.json").write_text(json.dumps({"overview": over, "topics": topics}, ensure_ascii=False, separators=(",", ":")))
    say(f"insight: {len(topics)} topics (HDBSCAN min_cluster_size {mcs}), {over['noise_chunks']} chunks in no topic, "
        f"{time.time() - t0:.1f} s → {out / 'insight.json'}")
    return over, topics

# ── cli ─────────────────────────────────────────────────────────────────────

def parse(argv):
    a = dict(folders=[], out=None, gap=3.0, chars=1200, min_chars=40, url=DEFAULT_URL, model=DEFAULT_MODEL)
    it = iter(argv)
    for arg in it:
        key, _, val = arg.partition("=")
        flags = {"--out": "out", "--gap": "gap", "--chars": "chars", "--min-chars": "min_chars", "--url": "url", "--model": "model"}
        if key in flags:
            val = val or next(it, "")
            a[flags[key]] = float(val) if key == "--gap" else int(val) if key in ("--chars", "--min-chars") else val
        elif arg.startswith("--"):
            raise SystemExit(f"unknown flag {arg}")
        else:
            a["folders"].append(arg)
    if not a["folders"] or not a["out"]:
        raise SystemExit(__doc__)
    return a


def self_test():
    """Two fake servers, fake vectors: chunking rules, outputs, cache reuse."""
    checks = 0

    def ok(c, what):
        nonlocal checks
        if not c:
            raise SystemExit(f"self-test FAILED: {what}")
        checks += 1

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        folders = []
        for si, (gid, name) in enumerate([("111", "alpha"), ("222", "beta")]):
            d = root / name
            d.mkdir()
            db = sqlite3.connect(d / "server.sqlite")
            db.executescript("""create table discord_messages (message_id text primary key, channel_id text not null,
                thread_id text, guild_id text, author_id text not null, author_name text, author_is_bot integer not null default 0,
                content text, attachments_json text, ts text not null, created_at text not null, raw_json text not null);
                create table channels (id text primary key, name text, kind text not null, type integer, parent_id text,
                position integer, messages integer, file text);""")
            db.executemany("insert into channels values (?,?,?,?,?,?,?,?)", [
                ("10", "general", "channel", 0, None, 0, None, "general-10.tar.gz"),
                ("20", "ideas", "channel", 0, None, 1, None, "ideas-20.tar.gz"),
                ("21", "a thread", "thread", 11, "20", None, None, "ideas-20.tar.gz")])
            n = 0
            for room, thread in (("10", None), ("20", None), ("20", "21")):
                for burst in range(4):              # 4 bursts 5 h apart → 4 chunks per room/thread
                    for m in range(3):
                        n += 1
                        ts = f"2026-11-{1 + burst:02d}T{8 + m:02d}:00:00Z"
                        text = f"server {name} room {room} thread {thread} burst {burst} line {m} about topic {burst % 2}"
                        db.execute("insert into discord_messages values (?,?,?,?,?,?,?,?,?,?,?,?)",
                                   (f"{gid}{n:04d}", room, thread, gid, "u1" if m else "b1", "nat" if m else "botty",
                                    0 if m else 1, text, None, ts, ts, json.dumps({"content": text})))
            db.execute("insert into discord_messages values ('x1','10',null,?,'u1','nat',0,'ok',null,'2026-11-20T00:00:00Z','x','{}')", (gid,))
            db.commit()
            db.close()
            (d / "server.json").write_text(json.dumps({"guild": {"id": gid, "name": name}}))
            folders.append(d)
        out = root / "brain"
        meta = build(folders, out, url="fake:768", model="m")
        ok(meta["n"] == 24, f"2 servers x 3 room/threads x 4 bursts = 24 chunks (got {meta['n']}); 'ok' alone dropped (< 40 chars)")
        ok(meta["counts"]["rooms"] == 4, "rooms = 2 per server (a thread is drawn in its parent room)")
        ok(meta["counts"]["messages"] == 72, "every message with enough text is in a chunk")
        import numpy as np
        ok(np.fromfile(out / "xyz.f32", np.float32).size == 72, "xyz has 3 floats a point")
        ok(np.fromfile(out / "vec.i8", np.int8).size == 24 * DIM, "vec.i8 has 256 dims a point")
        ok(set(np.fromfile(out / "src.u8", np.uint8).tolist()) == {2}, "every chunk mixes a bot and a person → src 2")
        ok(np.fromfile(out / "knn.u32", np.uint32).size == 24 * meta["k"], "knn has k links a point")
        p0 = json.loads((out / "p" / "0.json").read_text())
        ok(len(p0) == 24 and len(p0[0][3]) == 3 and p0[0][3][0][1] == "botty", "shard holds lines with author names")
        ok("botty" not in (out / "meta.json").read_text() and meta["owner"] == "nat", "owner = most active person")
        again = build(folders, out, url="fake:768", model="m")
        ok(again["counts"]["embedded_now"] == 0, "rebuild embeds 0 (cache)")
        over, topics = insight(out)
        ok((out / "insight.json").exists() and (out / "topic.u16").stat().st_size == 48, "insight.json + topic.u16 (2 bytes a point)")
        ok(over["counts"]["points"] == 24 and len(over["messages_by_hour_bkk"]) == 24, "overview: counts + 24 hour buckets")
        ok(all(t["keywords"] and len(t["representative"]) <= 5 for t in topics), "every topic has keywords and ≤5 representatives")
    say(f"self-test ok ({checks} checks)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "build":
        a = parse(sys.argv[2:])
        for f in a["folders"]:
            if not (Path(f) / "server.sqlite").exists():
                raise SystemExit(f"{f}: no server.sqlite — run `maw atlas download <guild> --out` first")
        build(a["folders"], a["out"], a["gap"], a["chars"], a["min_chars"], a["url"], a["model"])
        insight(a["out"])
    elif len(sys.argv) > 2 and sys.argv[1] == "insight":
        insight(sys.argv[2])
    elif len(sys.argv) > 1 and sys.argv[1] == "self-test":
        self_test()
    else:
        raise SystemExit(__doc__)
