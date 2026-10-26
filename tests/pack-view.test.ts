import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildServerDb } from "../lib/server-db";
import { packGuild } from "../lib/pack";
import { allowedHost, openViewer } from "../lib/viewer";

// A synthetic guild folder shaped like `download <guild> --out` output: one channel
// blob with one thread, two attachments listed, only one of them in the tar.
const root = mkdtempSync(join(tmpdir(), "atlas-pack-test-"));
const dir = join(root, "Test_Guild-100000000000000001");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const sha = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");

const guild = { id: "100000000000000001", name: "Test Guild" };
const category = { id: "100000000000000002", name: "Text", type: 4, position: 0 };
const channel = { id: "100000000000000003", name: "general", type: 0, position: 0, parent_id: category.id, guild_id: guild.id };
const thread = { id: "100000000000000004", name: "a thread", type: 11, parent_id: channel.id };
const author = { id: "100000000000000009", username: "nat" };
const messages = [
  { id: "1200000000000000001", channel_id: channel.id, author, content: "hello ประชุม world", timestamp: "", type: 0,
    attachments: [{ id: "1300000000000000001", filename: "a.png", size: PNG.length, width: 2, height: 2, content_type: "image/png" }] },
  { id: "1200000000000000002", channel_id: thread.id, author, content: "in the thread", timestamp: "", type: 0,
    attachments: [{ id: "1300000000000000002", filename: "gone.png", size: 9, content_type: "image/png" }] },
];

{
  const name = `general-${channel.id}`;
  const blob = join(root, name);
  mkdirSync(join(blob, "attachments"), { recursive: true });
  writeFileSync(join(blob, "attachments", `${messages[0].id}-1300000000000000001-a.png`), PNG);
  writeFileSync(join(blob, "messages.jsonl"), messages.map(m => JSON.stringify(m)).join("\n") + "\n");
  writeFileSync(join(blob, "threads.md"), "");
  writeFileSync(join(blob, "manifest.json"), JSON.stringify({
    channel, threads: [thread], messages: 2,
    attachments: [{ message_id: messages[0].id, attachment_id: "1300000000000000001", filename: "a.png", size: PNG.length, sha256: sha,
      path: `attachments/${messages[0].id}-1300000000000000001-a.png` }],
  }));
  mkdirSync(dir);
  Bun.spawnSync(["tar", "-czf", join(dir, `${name}.tar.gz`), "-C", root, name]);
  writeFileSync(join(dir, "server.json"), JSON.stringify({ guild, channels: [category, channel], exported_at: "2026-10-26T00:00:00Z" }));
  buildServerDb(dir);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("pack stores what the tar holds, reports what it lacks, and a re-run adds 0", () => {
  const first = packGuild(dir);
  expect(first.listed).toBe(2);
  expect(first.added).toBe(1);
  expect(first.missing.map(m => m.attachment_id)).toEqual(["1300000000000000002"]);
  expect(first.shaMismatch).toBe(0);
  const again = packGuild(dir);
  expect(again.added).toBe(0);
  expect(again.already).toBe(1);
  expect(again.totalRows).toBe(1);
});

test("viewer serves channels, messages, search and attachment bytes, read-only", async () => {
  packGuild(dir);
  const v = openViewer(join(dir, "server.sqlite"));
  const get = (p: string, init?: RequestInit) => v.fetch(new Request(`http://127.0.0.1${p}`, init));
  try {
    expect((await (await get("/api/server")).json()).name).toBe("Test Guild");
    const kinds = (await (await get("/api/channels")).json()).map((c: any) => c.kind).sort();
    expect(kinds).toEqual(["category", "channel", "thread"]);

    const ch = await (await get(`/api/messages?channel=${channel.id}`)).json();
    expect(ch.messages.map((m: any) => m.id)).toEqual([messages[0].id]);
    expect(ch.messages[0].attachments[0]).toMatchObject({ id: "1300000000000000001", packed: true });
    const th = await (await get(`/api/messages?thread=${thread.id}`)).json();
    expect(th.messages[0].attachments[0].packed).toBe(false);

    const s = await (await get(`/api/search?q=${encodeURIComponent("ประชุม")}`)).json();
    expect(s.mode).toBe("fts5");
    expect(s.results.map((r: any) => r.message_id)).toEqual([messages[0].id]);

    const att = await get("/att/1300000000000000001");
    expect(att.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await att.arrayBuffer())).toEqual(PNG);
    const part = await get("/att/1300000000000000001", { headers: { range: "bytes=0-3" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG.subarray(0, 4));

    expect((await get("/api/server", { method: "POST" })).status).toBe(405);
  } finally {
    v.db.close();
  }
});

test("viewer binds only loopback or tailscale addresses", () => {
  expect(allowedHost("127.0.0.1")).toBe(true);
  expect(allowedHost("100.84.206.23")).toBe(true);
  expect(allowedHost("0.0.0.0")).toBe(false);
  expect(allowedHost("192.168.1.5")).toBe(false);
  expect(allowedHost("100.200.0.1")).toBe(false);
});
