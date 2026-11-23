import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// archiveGuild talks to Discord only through these two modules — a guild with no channels needs none of it.
// mock.module is process-wide in bun test: keep every real export so other test files still link.
const realDiscord = await import("../lib/discord");
const realThreads = await import("../lib/discord-threads");
mock.module("../lib/discord", () => ({ ...realDiscord, getGuildChannels: async () => [] }));
mock.module("../lib/discord-threads", () => ({ ...realThreads, listActiveThreads: async () => [], listArchivedThreads: async () => [] }));
const { archiveGuild, extractBlob } = await import("../lib/channel-archive");

const base = mkdtempSync(join(tmpdir(), "atlas-archive-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("extractBlob", () => {
  test("unpacks <name>/ next to the other files, keeps a lance/ folder already there", () => {
    const src = join(base, "src", "general-10");
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "manifest.json"), "{}");
    writeFileSync(join(src, "messages.jsonl"), '{"id":"1"}\n');
    const tar = join(base, "general-10.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tar, "-C", join(base, "src"), "general-10"]).exitCode).toBe(0);
    const into = join(base, "guild", "channels");
    mkdirSync(join(into, "general-10", "lance"), { recursive: true });
    writeFileSync(join(into, "general-10", "lance", "keep.me"), "x");
    const dir = extractBlob(tar, into);
    expect(dir).toBe(join(into, "general-10"));
    expect(readFileSync(join(dir, "messages.jsonl"), "utf8")).toBe('{"id":"1"}\n');
    expect(existsSync(join(dir, "lance", "keep.me"))).toBe(true);
  });
  test("a broken tarball throws", () => {
    const bad = join(base, "bad.tar.gz");
    writeFileSync(bad, "not a tarball");
    expect(() => extractBlob(bad, join(base, "x"))).toThrow(/cannot extract/);
  });
});

describe("archiveGuild resume", () => {
  test("an unfinished run's staging dirs go, channels/ and lance/ stay", async () => {
    const out = join(base, "out");
    const dir = join(out, "test-guild-111111111111111111");
    mkdirSync(join(dir, "general-10"), { recursive: true });           // staging dir of a killed run
    mkdirSync(join(dir, "channels", "general-10", "lance"), { recursive: true });
    mkdirSync(join(dir, "lance"), { recursive: true });
    const logs: string[] = [];
    const r = await archiveGuild(s => logs.push(s), "token", {} as any,
      { id: "111111111111111111", name: "test guild" }, out, { names: "safe", extract: true });
    expect(r.dir).toBe(dir);
    expect(existsSync(join(dir, "general-10"))).toBe(false);
    expect(existsSync(join(dir, "channels", "general-10", "lance"))).toBe(true);
    expect(existsSync(join(dir, "lance"))).toBe(true);
    expect(existsSync(join(dir, "server.md"))).toBe(true);
    expect(logs.join("\n")).toContain("removed unfinished staging dir general-10/");
  });
});
