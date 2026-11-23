/**
 * embed-targets — which guild folders `maw atlas embed` works on.
 *
 * A guild folder is what `download <guild> --out` writes (server.sqlite, server.json,
 * one .tar.gz per channel). A target may be:
 *   a path        that folder (it must hold server.sqlite)
 *   a guild id    the newest finished folder <name>-<id>[-<UTC stamp>] in the blob dir
 *   a name        same, matched against each folder's server.json guild name (lib/names.ts)
 * "Finished" = server.md exists (archiveGuild writes it last). Nothing here calls Discord.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { isSnowflake, lookupFailure, matchGuilds } from "./names";
import type { Log } from "./command-types";

export interface GuildFolder {
  dir: string;
  id: string;
  name: string;
  /** server.json exported_at, or the folder's mtime — the newest folder of a guild wins */
  at: string;
}

/** Every finished guild folder directly under `base`. */
export function listGuildFolders(base: string): GuildFolder[] {
  if (!existsSync(base)) return [];
  const out: GuildFolder[] = [];
  for (const f of readdirSync(base)) {
    const dir = join(base, f);
    if (!existsSync(join(dir, "server.sqlite")) || !existsSync(join(dir, "server.md"))) continue;
    let id = "", name = f, at = statSync(dir).mtime.toISOString();
    try {
      const s = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
      id = String(s.guild?.id ?? "");
      name = String(s.guild?.name ?? f);
      at = String(s.exported_at ?? at);
    } catch {
      const m = f.match(/-(\d{17,20})(?:-\d{8}T\d{6}Z)?$/);
      if (m) id = m[1];
    }
    if (id) out.push({ dir, id, name, at });
  }
  return out;
}

function newestOf(folders: GuildFolder[], id: string): GuildFolder | undefined {
  return folders.filter(f => f.id === id).sort((a, b) => b.at.localeCompare(a.at))[0];
}

/**
 * Targets → folders. A folder path is used as given; an id or a name goes through the
 * finished folders in `base`. Ambiguous or unknown: the candidates are logged and it throws.
 */
export function resolveGuildFolders(log: Log, targets: string[], base: string): GuildFolder[] {
  const out: GuildFolder[] = [];
  let all: GuildFolder[] | null = null;
  const local = () => (all ??= listGuildFolders(base));
  for (const t of targets) {
    const asPath = resolve(t);
    if (t.includes("/") || (existsSync(asPath) && statSync(asPath).isDirectory())) {
      if (!existsSync(join(asPath, "server.sqlite"))) {
        throw new Error(`${t}: no server.sqlite here — run \`maw atlas download <guild> --out\` first`);
      }
      const f = listGuildFolders(join(asPath, "..")).find(x => x.dir === asPath);
      out.push(f ?? { dir: asPath, id: "", name: t, at: "" });
      continue;
    }
    if (isSnowflake(t)) {
      const f = newestOf(local(), t);
      if (!f) throw new Error(`no finished download of guild ${t} in ${base} — run: maw atlas download ${t} --out`);
      out.push(f);
      continue;
    }
    const guilds = [...new Map(local().map(f => [f.id, { id: f.id, name: f.name }])).values()];
    const m = matchGuilds(t, guilds);
    if (!m.pick) {
      const fail = lookupFailure(t, m, guilds, "downloaded guild");
      for (const line of fail.lines) log(line);
      throw new Error(`${fail.error} in ${base}`);
    }
    out.push(newestOf(local(), m.pick.id)!);
  }
  return out;
}
