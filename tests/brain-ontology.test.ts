import { describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { brainOntology, ONTOLOGY_FILES, toYaml } from "../lib/brain-ontology";

const meta = { n: 3, built: "2026-11-23T10:00:00+0700", counts: { points: 3, messages: 9, rooms: 2, servers: 1 },
  servers: [{ name: "secret server name" }], groups: [{ title: "#private-room", room_id: "1234567890123", server: 0, points: 2 }] };
const docs = brainOntology(meta, { topics: [{ id: 0, label: "beer cider", keywords: ["beer"] }] });

describe("brain ontology (Apache Ossie)", () => {
  test("three files, the counts in the description, no names or ids from the brain", () => {
    expect(Object.keys(docs)).toEqual([...ONTOLOGY_FILES]);
    const all = Object.values(docs).join("\n");
    expect(all).toContain("9 messages in 3 chunks, 2 rooms, 1 server(s), 1 topics");
    for (const leak of ["secret server name", "#private-room", "1234567890123", "beer cider"]) expect(all).not.toContain(leak);
    expect(docs["discord.mapping.yaml"]).toContain("iri: ./discord.ontology.yaml");
  });
  test("yaml writer: quotes what YAML would misread, keeps plain words plain", () => {
    expect(toYaml({ a: "yes", b: "x: y # z", c: "plain_word", d: [1, "two"] })).toBe('\na: "yes"\nb: "x: y # z"\nc: plain_word\nd: [1, two]');
    expect(toYaml({ l: [{ k: 1, m: [{ z: "q" }] }] })).toBe("\nl:\n  - k: 1\n    m:\n      - z: q");
  });
  // the real check: apache/ossie's own validator, when the checkout and uv are on this machine
  const ossie = (() => { try { return join(execSync("ghq root", { encoding: "utf8" }).trim(), "github.com/apache/ossie"); } catch { return ""; } })();
  const can = !!Bun.which("uv") && !!ossie && Bun.file(join(ossie, "validation/validate.py")).size > 0;
  test.skipIf(!can)("passes apache/ossie validation/validate.py (ontology, semantic model, mapping)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-ossie-"));
    try {
      for (const [k, v] of Object.entries(docs)) writeFileSync(join(dir, k), v);
      const run = (args: string[]) => spawnSync("uv", ["run", "--quiet", join(ossie, "validation/validate.py"), ...args], { cwd: dir, encoding: "utf8" });
      for (const [args, file] of [[["--schema", join(ossie, "ontology/ontology.json")], "discord.ontology.yaml"], [[], "discord.semantic_model.yaml"],
        [["--schema", join(ossie, "ontology/mapping.json")], "discord.mapping.yaml"]] as [string[], string][]) {
        const r = run([...args, file]);
        expect(r.stdout + r.stderr).toContain(`Validation PASSED: ${file}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
