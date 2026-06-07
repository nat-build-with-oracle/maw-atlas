/**
 * Atlas-oracle repo resolver — find the repo on this machine via ghq.
 */

export function findAtlasRepo(): string | null {
  const { execSync } = require("child_process");
  const { existsSync } = require("fs");
  try {
    const ghqRoot = execSync("ghq root", { encoding: "utf8" }).trim();
    const candidates = [
      `${ghqRoot}/github.com/Soul-Brews-Studio/atlas-oracle`,
      `${ghqRoot}/github.com/Soul-Brews-Studio/atlas-oracle`,
    ];
    for (const p of candidates) {
      if (existsSync(`${p}/parliament/api/server.ts`)) return p;
    }
  } catch {}
  return null;
}
