/**
 * brain-server — the 3D meaning map page for `maw atlas brain serve`, Bun.serve, loopback (or tailscale) only.
 *
 *   /brain/                 lib/brain.html (three.js)
 *   /brain/data/*           the brain folder from scripts/atlas-brain.py (xyz, groups, links, text shards)
 *   POST /brain/search      {query, k}: the query embedded by the same server + model as the build (query prompt,
 *                           first 256 dims renormalised), cosine over vec.i8, plus plain substring matches
 *   POST /brain/reload      re-read the folder after a rebuild, no restart
 *
 * The data is private message text: the bind is 127.0.0.1 unless --host names a tailscale 100.x address
 * (lib/viewer.ts allowedHost — the same rule as `maw atlas view`). Ported from laris-co/facebook-oracle brain/server.ts.
 */
import { existsSync } from "fs";
import { join, normalize } from "path";
import { allowedHost } from "./viewer";

const PAGE = join(import.meta.dir, "brain.html");

type Meta = { n: number; dim: number; scale: number; shard: number; query_prompt: string; model: string; embed_url: string };

export interface BrainServer {
  url: string;
  meta: Meta;
  stop: () => void;
}

function inside(base: string, rel: string): string | null {
  const p = normalize(join(base, rel));
  return p.startsWith(base + "/") ? p : null;
}

export async function startBrain(dir: string, opts: { host?: string; port?: number; embedUrl?: string } = {}): Promise<BrainServer> {
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`${dir}: no meta.json — run 'maw atlas brain build' first`);
  const host = opts.host ?? "127.0.0.1";
  if (!allowedHost(host)) throw new Error(`refusing to bind ${host} — use 127.0.0.1 or a tailscale 100.x address`);

  let meta: Meta, vec: Int8Array, texts: string[];
  const load = async () => {
    meta = await Bun.file(join(dir, "meta.json")).json();
    vec = new Int8Array(await Bun.file(join(dir, "vec.i8")).arrayBuffer());
    texts = new Array(meta.n);
    for (let s = 0; s < Math.ceil(meta.n / meta.shard); s++) {
      const part: any[] = await Bun.file(join(dir, "p", `${s}.json`)).json();
      part.forEach((p, j) => { texts[s * meta.shard + j] = ((p[2] || "") + "\n" + p[3].map((l: any[]) => l[2]).join("\n")).toLowerCase(); });
    }
  };
  await load();
  const embedUrl = () => (opts.embedUrl || process.env.ATLAS_EMBED_URL || meta.embed_url || "http://127.0.0.1:11445").replace(/\/$/, "");

  async function embedQuery(q: string): Promise<Float32Array | null> {
    try {
      const r = await fetch(`${embedUrl()}/api/embed`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: meta.model, input: `${meta.query_prompt}${q}` }), signal: AbortSignal.timeout(5000),
      });
      const v: number[] | undefined = ((await r.json()) as any)?.embeddings?.[0];
      if (!Array.isArray(v)) return null;
      const out = new Float32Array(meta.dim);
      let s = 0;
      for (let d = 0; d < meta.dim; d++) { out[d] = v[d]; s += v[d] * v[d]; }
      s = Math.sqrt(s) || 1;
      for (let d = 0; d < meta.dim; d++) out[d] /= s;
      return out;
    } catch { return null; }
  }

  function topK(q: Float32Array, k: number) {
    const { n, dim, scale } = meta;
    const score = new Float32Array(n);
    for (let i = 0, o = 0; i < n; i++, o += dim) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += vec[o + d] * q[d];
      score[i] = s / scale;
    }
    const best: number[] = [];
    for (let i = 0; i < n; i++) {
      if (best.length < k || score[i] > score[best[best.length - 1]]) {
        let j = best.length < k ? best.length : k - 1;
        best[j] = i;
        while (j > 0 && score[best[j - 1]] < score[best[j]]) { [best[j - 1], best[j]] = [best[j], best[j - 1]]; j--; }
      }
    }
    return best.map(i => ({ i, score: Math.round(score[i] * 1000) / 1000 }));
  }

  const file = async (p: string | null) => {
    const f = p ? Bun.file(p) : null;
    if (!f || !(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "cache-control": "no-store" } });
  };

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "/brain") return Response.redirect("/brain/", 302);
    if (path === "/brain/" || path === "/brain/index.html") return file(PAGE);
    if (path.startsWith("/brain/data/")) return file(inside(dir, path.slice("/brain/data/".length)));
    if (path === "/brain/reload" && req.method === "POST") { await load(); return Response.json({ ok: true, n: meta.n }); }
    if (path === "/brain/search" && req.method === "POST") {
      const { query, k = 60 } = ((await req.json().catch(() => ({}))) || {}) as { query?: string; k?: number };
      const q = query?.trim();
      if (!q) return Response.json({ error: "query required" }, { status: 400 });
      const t0 = performance.now();
      const v = await embedQuery(q);
      const embedMs = Math.round(performance.now() - t0);
      const hits = v ? topK(v, Math.min(Math.max(1, k), 500)) : [];
      const needle = q.toLowerCase();
      const keyword: number[] = [];
      for (let i = 0; i < texts.length && keyword.length < 500; i++) if (texts[i].includes(needle)) keyword.push(i);
      return Response.json({
        hits, keyword, ms: Math.round(performance.now() - t0),
        vector_from: v ? `${meta.model} @ ${embedUrl()} (${embedMs} ms)` : "none (embed server down): keyword only",
      });
    }
    return new Response("not found", { status: 404 });
  };

  const server = Bun.serve({ hostname: host, port: opts.port ?? 7720, fetch: fetchHandler });
  const shown = host.includes(":") ? `[${host}]` : host;
  return { url: `http://${shown}:${server.port}/brain/`, meta: meta!, stop: () => server.stop(true) };
}
