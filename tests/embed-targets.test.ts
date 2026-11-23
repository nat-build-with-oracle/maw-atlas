import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listGuildFolders, resolveGuildFolders } from "../lib/embed-targets";
import { groupTargets } from "../commands/embed";

const base = mkdtempSync(join(tmpdir(), "atlas-embed-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function folder(name: string, id: string, gname: string, at: string, finished = true) {
  const d = join(base, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "server.sqlite"), "");
  writeFileSync(join(d, "server.json"), JSON.stringify({ guild: { id, name: gname }, exported_at: at }));
  if (finished) writeFileSync(join(d, "server.md"), "# done\n");
  return d;
}
const old = folder("Phone_Booth_Cider_Bar_&_Co-1570978122772258906", "1570978122772258906", "Phone Booth Cider Bar & Co", "2026-11-23T01:00:00Z");
const fresh = folder("phone-booth-cider-bar-and-co-1570978122772258906-20261123T030000Z", "1570978122772258906", "Phone Booth Cider Bar & Co", "2026-11-23T03:00:00Z");
folder("Phone_booth_Co_Ltd-1550095261827858504", "1550095261827858504", "Phone booth Co Ltd", "2026-11-23T01:00:00Z");
folder("unfinished-123456789012345678", "123456789012345678", "Half Done", "2026-11-23T01:00:00Z", false);

const lines: string[] = [];
const log = (s: string) => lines.push(s);

describe("embed targets", () => {
  test("only finished folders are listed", () => {
    expect(listGuildFolders(base).map(f => f.name).sort()).toEqual(
      ["Phone Booth Cider Bar & Co", "Phone Booth Cider Bar & Co", "Phone booth Co Ltd"]);
  });
  test("by id → the newest folder of that guild", () => {
    expect(resolveGuildFolders(log, ["1570978122772258906"], base)[0].dir).toBe(fresh);
  });
  test("by name → newest folder; ambiguous → throws with the candidates", () => {
    expect(resolveGuildFolders(log, ["cider bar"], base)[0].dir).toBe(fresh);
    lines.length = 0;
    expect(() => resolveGuildFolders(log, ["phone booth"], base)).toThrow(/ambiguous/);
    expect(lines.join("\n")).toContain("1550095261827858504");
  });
  test("by path → that folder, even an older one", () => {
    expect(resolveGuildFolders(log, [old], base)[0].dir).toBe(old);
  });
  test("a folder without server.sqlite is refused", () => {
    const d = join(base, "empty-dir");
    mkdirSync(d, { recursive: true });
    expect(() => resolveGuildFolders(log, [d], base)).toThrow(/no server.sqlite/);
  });
  test("unknown id or unfinished download → throws", () => {
    expect(() => resolveGuildFolders(log, ["123456789012345678"], base)).toThrow(/no finished download/);
  });
  test("words group into one name; paths and ids stand alone", () => {
    expect(groupTargets(["phone", "booth", "cider", "1550095261827858504", "./x", "cat", "lab"]))
      .toEqual(["phone booth cider", "1550095261827858504", "./x", "cat lab"]);
  });
});
