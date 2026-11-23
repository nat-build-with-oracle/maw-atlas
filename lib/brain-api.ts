/**
 * brain-api — read-only JSON/markdown over a brain folder, for people and for LLMs (`maw atlas brain serve`).
 *
 *   GET /brain/api                      this list
 *   GET /brain/api/overview             counts, dates, messages by hour (Asia/Bangkok) and day, top rooms/people/bots
 *   GET /brain/api/topics               topics: c-TF-IDF keywords, size, rooms, people, first/last day, rising
 *   GET /brain/api/topics/:id           one topic as an LLM-ready bundle: keywords, stats, the chunks closest to its
 *                                       centre first, then more, up to ?max_chars= (default 12000). ?format=md|json
 *   GET /brain/api/rooms/:i             the same bundle for one room (groups[i] in meta.json), newest chunks first
 *   GET /brain/api/context?q=...        meaning search → the hit chunks as one bundle (for RAG / "summarize this")
 *   GET /brain/api/report.md            the old-school report: numbers, hour histogram, busiest days, topics table
 *   GET /brain/api/story?topic=|room=|q=  the same chunks in TIME order (oldest first) — "the timestamp is the truth":
 *                                       ?format=json gives the ordered ids (the page draws them as a line), md the
 *                                       line-by-line story for an LLM to retell
 *
 * Nothing here calls an LLM or leaves the machine: a bundle is the text an LLM would need, with an instruction line
 * on top; the caller decides which model reads it. Topics come from `atlas-brain.py insight` (HDBSCAN on the map +
 * c-TF-IDF over PyThaiNLP newmm words — the BERTopic recipe).
 */

export interface BrainData {
  meta: any;
  insight: any | null;
  /** [start_ms, end_ms, thread_or_null, [[ms, who, text, bot], ...]] per point */
  points: any[];
  grp: Uint32Array;
  topic: Uint16Array | null;
  search: (q: string, k: number) => Promise<{ hits: { i: number; score: number }[]; from: string }>;
}

const TZ = "Asia/Bangkok";
const day = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const md = (s: string) => new Response(s, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });

function roomTitle(d: BrainData, gi: number): string {
  const g = d.meta.groups[gi];
  const servers = d.meta.servers || [];
  return (servers.length > 1 ? `${servers[g.server]?.name} › ` : "") + g.title;
}

export function chunkText(d: BrainData, i: number): string {
  const [start, end, thread, lines] = d.points[i];
  const head = `### ${roomTitle(d, d.grp[i])}${thread ? ` › ${thread}` : ""} · ${day(start)}${day(end) !== day(start) ? ` → ${day(end)}` : ""} · #${i}`;
  return [head, ...lines.map(([ms, who, text, bot]: any[]) => `${hm(ms)} ${who}${bot ? " (bot)" : ""}: ${text}`)].join("\n");
}

/** Chunks in the given order until the budget is spent (a chunk is never cut in half). */
function pack(d: BrainData, order: number[], maxChars: number): { text: string; used: number[] } {
  const out: string[] = [], used: number[] = [];
  let size = 0;
  for (const i of order) {
    const t = chunkText(d, i);
    if (size + t.length > maxChars && used.length) break;
    out.push(t); used.push(i); size += t.length + 2;
  }
  return { text: out.join("\n\n"), used };
}

function bundle(title: string, instruction: string, facts: string[], body: { text: string; used: number[] }, total: number, format: string, extra: any) {
  if (format === "json") return Response.json({ title, instruction, facts, chunks_included: body.used.length, chunks_total: total, chunk_ids: body.used, text: body.text, ...extra });
  return md([`# ${title}`, "", `> ${instruction}`, "", ...facts.map(f => `- ${f}`), "",
    `${body.used.length} of ${total} chunks below (times Asia/Bangkok):`, "", body.text, ""].join("\n"));
}

const INSTRUCTION = "Summarize what this conversation is about: the main threads, decisions, open questions, and who drove them. Quote numbers exactly. The text is chat between people and bots; do not invent anything not in it.";

export async function brainApi(d: BrainData, path: string, url: URL): Promise<Response | null> {
  if (!path.startsWith("/brain/api")) return null;
  const rest = path.slice("/brain/api".length).replace(/\/$/, "");
  const format = url.searchParams.get("format") === "json" ? "json" : "md";
  const maxChars = Math.min(Math.max(1000, Number(url.searchParams.get("max_chars")) || 12000), 200000);
  const ins = d.insight;

  if (rest === "") {
    return Response.json({
      endpoints: ["/brain/api/overview", "/brain/api/topics", "/brain/api/topics/:id?format=md|json&max_chars=12000",
        "/brain/api/rooms/:i?format=md|json&max_chars=12000", "/brain/api/context?q=...&k=20&max_chars=12000", "/brain/api/report.md",
        "/brain/api/story?topic=<id>|room=<i>|q=...&format=md|json"],
      topics: !!ins, note: ins ? undefined : "no insight.json — run: maw atlas brain insight <brain dir>",
    });
  }
  if (rest === "/overview") return ins ? Response.json(ins.overview) : Response.json({ error: "no insight.json — run maw atlas brain insight" }, { status: 404 });
  if (rest === "/topics") {
    if (!ins) return Response.json({ error: "no insight.json — run maw atlas brain insight" }, { status: 404 });
    return Response.json(ins.topics.map(({ representative, ...t }: any) => t));
  }
  let m = rest.match(/^\/topics\/(\d+)$/);
  if (m) {
    const t = ins?.topics?.[Number(m[1])];
    if (!t || !d.topic) return Response.json({ error: "no such topic" }, { status: 404 });
    const members: number[] = [];
    for (let i = 0; i < d.topic.length; i++) if (d.topic[i] === t.id) members.push(i);
    const rep: number[] = t.representative;
    const order = [...rep, ...members.filter(i => !rep.includes(i)).sort((a, b) => d.points[b][1] - d.points[a][1])];
    const facts = [`keywords (c-TF-IDF): ${t.keywords.join(", ")}`, `${t.chunks} chunks, ${t.messages} messages, ${t.first} → ${t.last}`,
      `rooms: ${t.rooms.map(([r, n]: any) => `${r} (${n})`).join(", ")}`, `people: ${t.people.map(([p, n]: any) => `${p} (${n})`).join(", ")}`,
      `bot share ${Math.round(t.bot_share * 100)}%, share in the last 14 days ×${t.rising} the overall rate`];
    return bundle(`Topic ${t.id}: ${t.label}`, INSTRUCTION, facts, pack(d, order, maxChars), members.length, format, { topic: { ...t, representative: undefined } });
  }
  m = rest.match(/^\/rooms\/(\d+)$/);
  if (m) {
    const gi = Number(m[1]);
    if (!d.meta.groups[gi]) return Response.json({ error: "no such room" }, { status: 404 });
    const members: number[] = [];
    for (let i = 0; i < d.grp.length; i++) if (d.grp[i] === gi) members.push(i);
    members.sort((a, b) => d.points[b][1] - d.points[a][1]);
    const first = Math.min(...members.map(i => d.points[i][0])), last = Math.max(...members.map(i => d.points[i][1]));
    return bundle(`Room ${roomTitle(d, gi)}`, INSTRUCTION, [`${members.length} chunks, ${day(first)} → ${day(last)}`, "newest chunks first"],
      pack(d, members, maxChars), members.length, format, {});
  }
  if (rest === "/context") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return Response.json({ error: "q required" }, { status: 400 });
    const k = Math.min(Math.max(1, Number(url.searchParams.get("k")) || 20), 200);
    const r = await d.search(q, k);
    const facts = [`query: ${q}`, `vectors: ${r.from}`, `best cosine ${r.hits[0]?.score ?? "-"}, ${r.hits.length} hits, most similar first`];
    return bundle(`Context for "${q}"`, `Answer or summarize "${q}" from these chat excerpts only; say when they do not cover it.`, facts,
      pack(d, r.hits.map(h => h.i), maxChars), r.hits.length, format, { hits: r.hits });
  }
  if (rest === "/report.md") return md(report(d));
  if (rest === "/story") {
    const sel = await storySelect(d, url);
    if ("error" in sel) return Response.json({ error: sel.error }, { status: sel.status });
    const ids = sel.ids.sort((a, b) => d.points[a][0] - d.points[b][0] || a - b);
    if (!ids.length) return Response.json({ error: "nothing selected" }, { status: 404 });
    const first = d.points[ids[0]][0], last = d.points[ids[ids.length - 1]][1];
    if (format === "json" && url.searchParams.get("text") !== "1") {
      return Response.json({ title: sel.title, ids, first: day(first), last: day(last), starts: ids.map(i => d.points[i][0]) });
    }
    const facts = [...sel.facts, `${ids.length} chunks, ${day(first)} → ${day(last)}, oldest first (times Asia/Bangkok, from Discord's own message ids)`];
    return bundle(`Story: ${sel.title}`, "Tell what happened in order — when, who, what changed, what was decided. The timestamps are the truth: keep the order, quote dates and numbers exactly, invent nothing.",
      facts, pack(d, ids, maxChars), ids.length, format, { ids });
  }
  return Response.json({ error: "unknown endpoint — see /brain/api" }, { status: 404 });
}

/** Which chunks a story is about: a topic, a room, or a meaning search. */
async function storySelect(d: BrainData, url: URL): Promise<{ ids: number[]; title: string; facts: string[] } | { error: string; status: number }> {
  const t = url.searchParams.get("topic"), r = url.searchParams.get("room"), q = (url.searchParams.get("q") || "").trim();
  if (t !== null) {
    const tp = d.insight?.topics?.[Number(t)];
    if (!tp || !d.topic) return { error: "no such topic", status: 404 };
    const ids: number[] = [];
    for (let i = 0; i < d.topic.length; i++) if (d.topic[i] === tp.id) ids.push(i);
    return { ids, title: `topic ${tp.id} · ${tp.keywords.slice(0, 4).join(", ")}`, facts: [`keywords (c-TF-IDF): ${tp.keywords.join(", ")}`] };
  }
  if (r !== null) {
    const gi = Number(r);
    if (!d.meta.groups[gi]) return { error: "no such room", status: 404 };
    const ids: number[] = [];
    for (let i = 0; i < d.grp.length; i++) if (d.grp[i] === gi) ids.push(i);
    return { ids, title: `room ${roomTitle(d, gi)}`, facts: [] };
  }
  if (q) {
    const k = Math.min(Math.max(1, Number(url.searchParams.get("k")) || 40), 300);
    const res = await d.search(q, k);
    return { ids: res.hits.map(h => h.i), title: `"${q}"`, facts: [`query: ${q}`, `the ${res.hits.length} chunks nearest in meaning (${res.from}), then put in time order`] };
  }
  return { error: "say topic=, room= or q=", status: 400 };
}

/** The old-school report: plain numbers and text bars, no model. */
export function report(d: BrainData): string {
  const ins = d.insight, c = d.meta.counts, st = d.meta.stats;
  const L: string[] = [`# ${(d.meta.servers || []).map((s: any) => s.name).join(" + ") || "Discord"} — brain report`, "",
    `built ${d.meta.built} · ${c.points.toLocaleString()} chunks from ${c.messages.toLocaleString()} messages · ${c.rooms} rooms · model ${d.meta.model}`, ""];
  L.push("## Does the map show meaning?", "",
    `- links in the same room: ${st.links_same_room} (random pairs ${st.random_same_room})`,
    `- links in the same script (Thai/Latin): ${st.links_same_script} (random ${st.random_same_script}) — near random = meaning, not alphabet`, "");
  if (!ins) return L.concat(["(no insight.json — run `maw atlas brain insight <brain dir>` for topics and activity)", ""]).join("\n");
  const o = ins.overview;
  const bar = (n: number, max: number, w = 30) => "█".repeat(Math.round((n / (max || 1)) * w)).padEnd(w, " ");
  L.push("## Activity", "", `${o.first_day} → ${o.last_day}, ${o.active_days} active days · bots wrote ${Math.round(o.bot_message_share * 100)}% of messages`, "",
    "messages by hour (Asia/Bangkok):", "```");
  const hmax = Math.max(...o.messages_by_hour_bkk);
  o.messages_by_hour_bkk.forEach((n: number, h: number) => L.push(`${String(h).padStart(2, "0")}h ${bar(n, hmax)} ${n}`));
  L.push("```", "", "busiest days: " + o.busiest_days.map(([dd, n]: any) => `${dd} (${n})`).join(", "), "");
  L.push("## Rooms and people", "", "| room | chunks |", "|---|---:|", ...o.top_rooms_by_chunks.map(([r, n]: any) => `| ${r} | ${n} |`), "",
    "people: " + o.top_people.map(([p, n]: any) => `${p} ${n}`).join(" · "),
    "bots: " + o.top_bots.map(([p, n]: any) => `${p} ${n}`).join(" · "), "");
  L.push(`## Topics (${ins.topics.length}; ${o.noise_chunks} chunks fit none)`, "", `${o.clustering.method}, min cluster ${o.clustering.min_cluster_size}; keywords: ${o.keywords}.`,
    "Rising = share of the topic's chunks in the last 14 days ÷ the same share for everything (above 1 = growing).", "",
    "| # | keywords | chunks | first → last | main room | rising |", "|---:|---|---:|---|---|---:|",
    ...ins.topics.map((t: any) => `| ${t.id} | ${t.keywords.slice(0, 6).join(", ")} | ${t.chunks} | ${t.first} → ${t.last} | ${t.rooms[0]?.[0] ?? ""} | ${t.rising ?? "-"} |`),
    "", "LLM bundle for a topic: `/brain/api/topics/<#>` · for a room: `/brain/api/rooms/<i>` · for a question: `/brain/api/context?q=...`", "");
  return L.join("\n");
}
