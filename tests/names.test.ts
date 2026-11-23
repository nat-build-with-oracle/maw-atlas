import { describe, expect, test } from "bun:test";
import { fileName, isSnowflake, lookupFailure, matchGuilds, normName } from "../lib/names";

const guilds = [
  { id: "1100000000000000001", name: "Harbor lights Co Ltd" },
  { id: "1100000000000000002", name: "Harbor Lights Cider Bar & Co" },
  { id: "3", name: "Cat Lab & Co" },
  { id: "4", name: "Cat Lab X" },
  { id: "5", name: "ฝ่ายบัญชีตัวอย่าง" },
];

describe("matchGuilds", () => {
  test("every word must appear, case/space/punctuation ignored", () => {
    expect(matchGuilds("harbor lights cider", guilds).pick?.id).toBe("1100000000000000002");
    expect(matchGuilds("HARBORLIGHTS cider", guilds).pick?.id).toBe("1100000000000000002");
    expect(matchGuilds("lights co ltd", guilds).pick?.id).toBe("1100000000000000001");
  });
  test("several matches → no pick, all listed", () => {
    const m = matchGuilds("harbor lights", guilds);
    expect(m.pick).toBeUndefined();
    expect(m.matches.map(g => g.id)).toEqual(["1100000000000000001", "1100000000000000002"]);
    expect(lookupFailure("harbor lights", m, guilds).error).toContain("ambiguous (2 guilds)");
  });
  test("a whole name wins over a longer one that contains it", () => {
    expect(matchGuilds("cat lab x", guilds).pick?.id).toBe("4");
    expect(matchGuilds("Cat Lab & Co", guilds).pick?.id).toBe("3");
  });
  test("no match → nearest by words matched", () => {
    const m = matchGuilds("harborlights craft", guilds);
    expect(m.pick).toBeUndefined();
    expect(m.matches).toEqual([]);
    expect(m.near.map(g => g.id).sort()).toEqual(["1100000000000000001", "1100000000000000002"]);
    const f = lookupFailure("harborlights craft", m, guilds);
    expect(f.error).toBe('no guild matches "harborlights craft"');
    expect(f.lines[0]).toContain("closest");
  });
  test("Thai names", () => {
    expect(matchGuilds("บัญชี", guilds).pick?.id).toBe("5");
    expect(normName("ฝ่าย บัญชี")).toBe("ฝ่ายบัญชี");
  });
  test("snowflakes", () => {
    expect(isSnowflake("1100000000000000002")).toBe(true);
    expect(isSnowflake("harbor")).toBe(false);
    expect(isSnowflake("123")).toBe(false);
  });
});

describe("fileName", () => {
  const safe = (s: string) => fileName(s, "channel", "safe");
  test("keep mode is the old behaviour", () => {
    expect(fileName("Harbor Lights Cider Bar & Co", "guild")).toBe("Harbor_Lights_Cider_Bar_&_Co");
    expect(fileName("📦・demo-project∕demo-oracle", "channel")).toBe("📦・demo-project∕demo-oracle");
  });
  test("safe: no emoji, &, fullwidth bars, look-alike slashes, spaces", () => {
    expect(fileName("Harbor Lights Cider Bar & Co", "guild", "safe")).toBe("harbor-lights-cider-bar-and-co");
    expect(safe("📦・demo-project∕demo-oracle")).toBe("demo-project-demo-oracle");
    expect(safe("🗨️｜chat")).toBe("chat");
    expect(safe("🎙️｜record-meeting")).toBe("record-meeting");
    expect(safe("HUMAN SCHOOL | buildwithoracle.com")).toBe("human-school-buildwithoracle.com");
    expect(safe("it's")).toBe("its");
  });
  test("safe keeps Thai, with its vowel and tone marks", () => {
    expect(safe("ฝ่ายบัญชีตัวอย่าง")).toBe("ฝ่ายบัญชีตัวอย่าง");
    expect(safe("เธรด stock")).toBe("เธรด-stock");
  });
  test("nothing a shell would trip on", () => {
    for (const s of ["--rm -rf /", "a/b\\c:d", "$(whoami)", "`x`", "a;b|c&d", "*?[]", ".hidden", "-x"]) {
      const out = safe(s);
      expect(out).toMatch(/^[\p{L}\p{M}\p{N}_][\p{L}\p{M}\p{N}._-]*$/u);
    }
    expect(safe("--rm -rf /")).toBe("rm-rf");
  });
  test("empty after cleaning → fallback; long → clipped to 150 bytes", () => {
    expect(safe("🎙️")).toBe("channel");
    expect(fileName("ฝ่ายบัญชี", "guild", "ascii")).toBe("guild");
    expect(new TextEncoder().encode(safe("ก".repeat(200))).length).toBeLessThanOrEqual(150);
  });
  test("ascii: a-z 0-9 . _ - only", () => {
    expect(fileName("Café Ñandú & Co", "guild", "ascii")).toBe("cafe-nandu-and-co");
    expect(fileName("เธรด stock", "channel", "ascii")).toBe("stock");
  });
});
