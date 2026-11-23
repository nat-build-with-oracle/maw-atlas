import { expect, test } from "bun:test";
import { join } from "path";

// The LanceDB writer is python (uv); its self-test builds fake guild folders, uses fake vectors and
// checks every path: rooms, cross-server table, incremental, edits, --full --room, model change.
const uv = Bun.which("uv");
test.skipIf(!uv)("scripts/atlas-lance.py self-test", () => {
  const script = join(import.meta.dir, "..", "scripts", "atlas-lance.py");
  const p = Bun.spawnSync([uv!, "run", "--quiet", "--with", "lancedb", "--with", "pyarrow", "python", "-I", script, "self-test"]);
  const out = p.stdout.toString() + p.stderr.toString();
  expect(out).toMatch(/self-test ok \(\d+ checks\)/);
  expect(p.exitCode).toBe(0);
}, 180_000);
