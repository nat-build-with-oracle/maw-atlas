/**
 * brain.html in a real headless Chrome: load, Separate / Combined toggle, search, Back / Forward, time machine, the title link.
 *
 * No npm deps: Chrome is started with --remote-debugging-port and driven over the DevTools protocol with Bun's own
 * WebSocket. Skipped when Chrome is missing (CI without a browser) or the three.js CDN is unreachable (offline).
 * The brain folder is a fake 3-room map written here (60 points, no message from any real server).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startBrain, type BrainServer } from "../lib/brain-server";

const CHROME = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));
const CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
const online = CHROME ? await fetch(CDN, { method: "HEAD", signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false) : false;

// ---- a fake brain: 3 rooms of 20 points, each room a blob in Combined and an island in Separate
const N = 60, dir = mkdtempSync(join(tmpdir(), "atlas-brain-page-"));
function writeBrain() {
  const xyz = new Float32Array(N * 3), sep = new Float32Array(N * 3), grp = new Uint32Array(N), knn = new Uint32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const g = Math.floor(i / 20), a = i * 0.105;   // consecutive points close on the ring, so inner links are short and shown
    grp[i] = g;
    xyz.set([Math.cos(a) * 30 + g * 8, Math.sin(a) * 30, (i % 7) * 4 - 12], i * 3);           // rooms mixed together
    sep.set([(g - 1) * 70 + Math.cos(a) * 12, Math.sin(a) * 12, (i % 5) * 2], i * 3);          // rooms apart
    knn.set([g * 20 + ((i + 1) % 20), (i + 20) % N], i * 2);                                   // one link inside, one across
  }
  writeFileSync(join(dir, "xyz.f32"), xyz); writeFileSync(join(dir, "sep.f32"), sep);
  writeFileSync(join(dir, "grp.u32"), grp); writeFileSync(join(dir, "knn.u32"), knn);
  writeFileSync(join(dir, "src.u8"), new Uint8Array(N)); writeFileSync(join(dir, "gld.u8"), new Uint8Array(N));
  writeFileSync(join(dir, "mon.u16"), new Uint16Array(N).fill(322));
  writeFileSync(join(dir, "vec.i8"), new Int8Array(N * 2).map((_, k) => (k % 2 ? 90 : 60)));
  const rooms = ["#general", "#beer", "#cider"];
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ n: N, k: 2, dim: 2, scale: 127, shard: 64, query_prompt: "q: ", model: "m",
    embed_url: "http://127.0.0.1:9", built: "2026-11-23T12:00:00+0700", owner: "a",
    counts: { points: N, messages: N, rooms: 3, servers: 1 }, stats: { links_same_room: 0.5, random_same_room: 0.33, links_same_script: 0.9, random_same_script: 0.8 },
    groups: rooms.map((title) => ({ title, server: 0, points: 20 })), servers: [{ name: "test server" }] }));
  writeFileSync(join(dir, "sep.json"), JSON.stringify({ by: "room", cross_room_links: 0.5, how: { umap: 0, pca: 3, jitter: 0 },
    islands: [0, 1, 2].map((g) => ({ g, n: 20, r: 14, how: "pca", c: [(g - 1) * 70, 0, 4] })) }));
  mkdirSync(join(dir, "p"));
  const day = Date.UTC(2026, 10, 1);
  // one chunk an hour from 2026-11-01 00:00 UTC: Bangkok days Nov 1 (17 chunks), Nov 2 (24), Nov 3 (19)
  writeFileSync(join(dir, "t0.u32"), Uint32Array.from({ length: N }, (_, i) => (day + i * 3.6e6) / 1000));
  writeFileSync(join(dir, "p", "0.json"), JSON.stringify(Array.from({ length: N }, (_, i) =>
    [day + i * 3.6e6, day + i * 3.6e6 + 6e5, null, [[day + i * 3.6e6, "a", `${rooms[grp[i]]} chunk ${i} ${i % 3 ? "about cider" : "about beer"}`, 0]]])));
}

// ---- minimal DevTools protocol client
class Cdp {
  private id = 0; private wait = new Map<number, (m: any) => void>(); errors: string[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)!(m); this.wait.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
    };
  }
  static async open(url: string) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
    return new Cdp(ws);
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((ok) => { this.wait.set(id, ok); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expr}: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  }
  async until<T = any>(expr: string, ms = 45000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await this.eval<T>(expr).catch(() => undefined);
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}; page errors: ${JSON.stringify(this.errors)}`);
      await Bun.sleep(100);
    }
  }
  close() { this.ws.close(); }
}

describe.skipIf(!CHROME || !online)("brain.html in headless Chrome", () => {
  let srv: BrainServer, chrome: ReturnType<typeof Bun.spawn>, cdp: Cdp, profile: string;
  beforeAll(async () => {
    writeBrain();
    srv = await startBrain(dir, { port: 0 });
    profile = mkdtempSync(join(tmpdir(), "atlas-chrome-"));
    chrome = Bun.spawn([CHROME!, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--window-size=1400,900", "about:blank"],
      { stdout: "ignore", stderr: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    for (let t = 0; !existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n"); t++) { if (t > 100) throw new Error("chrome did not start"); await Bun.sleep(100); }
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const pages: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    cdp = await Cdp.open(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: srv.url });
    await cdp.until("window.__brain && window.__brain.N", 120000);
  }, 150000);
  afterAll(() => { cdp?.close(); chrome?.kill(); srv?.stop(); rmSync(dir, { recursive: true, force: true }); if (profile) rmSync(profile, { recursive: true, force: true }); });

  test("loads: 60 points, both layouts, no page error", async () => {
    expect(await cdp.eval("window.__brain.N")).toBe(N);
    expect(await cdp.eval("window.__brain.layout().layouts")).toEqual(["all", "rooms"]);
    expect(await cdp.eval("document.getElementById('status').textContent")).toContain("of links join two rooms");
    expect(cdp.errors).toEqual([]);
  }, 60000);

  test("Separate: points glide to the islands, URL says layout=rooms, labels show, cross-room links hidden", async () => {
    const before = await cdp.eval<number[]>("window.__brain.at(0)");
    const linksAll = await cdp.eval<number>("window.__brain.layout().links");
    await cdp.eval("document.querySelector('#layoutSeg button[data-layout=rooms]').click()");
    await cdp.until("window.__brain.layout().name === 'rooms' && !window.__brain.layout().gliding");
    const after = await cdp.eval<number[]>("window.__brain.at(0)");
    expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])).toBeGreaterThan(5);
    expect(await cdp.eval("location.search")).toBe("?layout=rooms");
    expect(await cdp.eval("window.__brain.layout().labels")).toBeGreaterThan(0);
    expect(await cdp.eval<number>("window.__brain.layout().links")).toBeLessThan(linksAll + 1);
    expect(await cdp.eval("document.getElementById('status').textContent")).toContain("cross-room links");
  }, 60000);

  test("search keeps the layout; Back undoes the search, then the layout; Forward redoes", async () => {
    await cdp.eval(`(() => { const q = document.getElementById('q'); q.value = 'beer'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await cdp.until("document.getElementById('panel').classList.contains('open')");
    expect(await cdp.eval("location.search")).toBe("?layout=rooms&q=beer");
    expect(await cdp.eval("document.getElementById('panel').textContent")).toContain("containing the words");
    await cdp.eval("history.back()");
    await cdp.until("location.search === '?layout=rooms' && !document.getElementById('panel').classList.contains('open')");
    await cdp.eval("history.back()");
    await cdp.until("location.search === '' && window.__brain.layout().name === 'all'");
    await cdp.eval("history.forward()");
    await cdp.until("window.__brain.layout().name === 'rooms'");
  }, 60000);

  test("a URL with layout=rooms opens straight in Separate (no glide)", async () => {
    await cdp.send("Page.navigate", { url: `${srv.url}?layout=rooms&mode=room` });
    await cdp.until("window.__brain && window.__brain.layout().name === 'rooms'", 120000);
    expect(await cdp.eval("window.__brain.layout().gliding")).toBe(false);
    expect(await cdp.eval("document.querySelector('#layoutSeg button.on').dataset.layout")).toBe("rooms");
  }, 60000);

  test("time machine: one tick per day, ▲ travels back a day at a time, later chunks leave the map, Back and Now return", async () => {
    const tm = () => cdp.eval("window.__brain.tm()");
    const t = () => cdp.eval("new URLSearchParams(location.search).get('t')");
    expect(await tm()).toMatchObject({ t: "", days: 3, first: "2026-11-01", last: "2026-11-03", shown: N, ticks: 3 });
    expect(await cdp.eval("document.getElementById('tmDown').disabled")).toBe(true);
    await cdp.eval("document.getElementById('tmUp').click()");
    await cdp.until("new URLSearchParams(location.search).get('t') === '2026-11-03'");
    await cdp.eval("document.getElementById('tmUp').click()");
    await cdp.until("window.__brain.tm().t === '2026-11-02'");
    expect(await tm()).toMatchObject({ shown: 17 + 24 });
    expect(await cdp.eval("document.getElementById('panel').classList.contains('open')")).toBe(false);   // the map changes, no side panel
    expect(await cdp.eval("document.getElementById('status').textContent")).toContain("41 of 60 chunks existed · 24 that day");
    await cdp.eval("history.back()");
    await cdp.until("window.__brain.tm().t === '2026-11-03'");
    expect(await tm()).toMatchObject({ shown: N });
    await cdp.eval("document.getElementById('tmNow').click()");
    await cdp.until("window.__brain.tm().t === ''");
    expect(await t()).toBe(null);
    expect(cdp.errors).toEqual([]);
  }, 60000);

  test("lightning: chunks that come into existence strike their links to older chunks", async () => {
    // the 24 chunks of 2026-11-02 against the 17 of 2026-11-01: the sweep from the end of day 1 to the end of day 2
    const day1 = Date.UTC(2026, 10, 1, 17) / 1000, day2 = day1 + 86400;
    const before = await cdp.eval<number>("window.__brain.bolts().struck");
    const after = await cdp.eval<number>(`window.__brain.spark(${day1}, ${day2})`);
    expect(after).toBeGreaterThan(before);
    expect(await cdp.eval<number>("window.__brain.bolts().live")).toBeGreaterThan(0);
    expect(await cdp.eval<number>(`window.__brain.spark(${day2}, ${day1})`)).toBe(after);   // backwards: no strikes
    expect(cdp.errors).toEqual([]);
  }, 60000);

  test("the title link resets everything, Combined included", async () => {
    await cdp.eval("document.getElementById('home').click()");
    await cdp.until("location.search === '' && window.__brain.layout().name === 'all'");
    expect(cdp.errors).toEqual([]);
  }, 60000);
});
