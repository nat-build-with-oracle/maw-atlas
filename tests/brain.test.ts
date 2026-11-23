import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startBrain } from "../lib/brain-server";

// a 3-point brain folder, enough for the server: meta, vectors, one text shard
const dir = mkdtempSync(join(tmpdir(), "atlas-brain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "meta.json"), JSON.stringify({ n: 3, dim: 2, scale: 127, shard: 64, query_prompt: "q: ", model: "m", embed_url: "http://127.0.0.1:9" }));
writeFileSync(join(dir, "vec.i8"), new Int8Array([127, 0, 0, 127, 90, 90]));
mkdirSync(join(dir, "p"));
writeFileSync(join(dir, "p", "0.json"), JSON.stringify([
  [0, 0, null, [[0, "a", "hello beer", 0]]], [0, 0, "t", [[0, "b", "cider night", 0]]], [0, 0, null, [[0, "c", "more beer", 1]]]]));

describe("brain server", async () => {
  const b = await startBrain(dir, { port: 0 });
  afterAll(() => b.stop());
  const base = b.url.replace(/\/brain\/$/, "");
  test("binds loopback, serves the page and the data", async () => {
    expect(b.url).toStartWith("http://127.0.0.1:");
    const page = await fetch(`${base}/brain/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Discord brain");
    expect((await fetch(`${base}/brain/data/meta.json`)).status).toBe(200);
  });
  test("no path outside the brain folder", async () => {
    expect((await fetch(`${base}/brain/data/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${base}/brain/data/../../etc/passwd`)).status).toBe(404);
  });
  test("search with the embed server down falls back to words", async () => {
    const r: any = await (await fetch(`${base}/brain/search`, { method: "POST", body: JSON.stringify({ query: "beer" }) })).json();
    expect(r.hits).toEqual([]);
    expect(r.keyword).toEqual([0, 2]);
    expect(r.vector_from).toContain("keyword only");
  });
  test("refuses a public bind", async () => {
    expect(startBrain(dir, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/refusing to bind/);
  });
});

const uv = Bun.which("uv");
test.skipIf(!uv)("scripts/atlas-brain.py self-test (chunks, UMAP, links, cache)", () => {
  const script = join(import.meta.dir, "..", "scripts", "atlas-brain.py");
  const p = Bun.spawnSync([uv!, "run", "--quiet", "--no-project", "--python", "3.12", "--with", "numpy", "--with", "umap-learn",
    "python", "-I", "-W", "ignore", script, "self-test"]);
  expect(p.stdout.toString() + p.stderr.toString()).toMatch(/self-test ok \(\d+ checks\)/);
  expect(p.exitCode).toBe(0);
}, 300_000);
