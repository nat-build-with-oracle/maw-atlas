/**
 * maw atlas pack <guild-folder> — copy every attachment out of the folder's
 * channel .tar.gz blobs into its server.sqlite (table `attachments`), plus a
 * trigram FTS5 index for search, so one db file holds text, metadata and images.
 *
 * Writes only <guild-folder>/server.sqlite. No Discord calls. Idempotent: a
 * re-run adds 0. See lib/pack.ts.
 */
import { existsSync } from "fs";
import { resolve } from "path";
import { packGuild } from "../lib/pack";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "pack",
  help: "pack <guild-folder>   put every attachment from the folder's .tar.gz blobs into its server.sqlite (+ FTS5 search index)",
  tokenRequirement: "none",
};

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

export async function run(log: Log, _token: string, args: string[]) {
  const target = args[1];
  if (!target || !existsSync(target)) {
    log("usage: maw atlas pack <guild-folder>");
    log("  <guild-folder> is what 'maw atlas download <guildId> --out' wrote: <channel>.tar.gz files + server.json + server.sqlite");
    log("  writes only <guild-folder>/server.sqlite — run it on a copy if you want the original untouched");
    if (target) throw new Error(`${target}: no such folder`);
    return;
  }
  const dir = resolve(target);
  const t0 = performance.now();
  log(`pack ${dir}`);
  const r = packGuild(dir, (file, added) => { if (added) log(`  + ${file}: ${added} attachment(s)`); });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  log(`done in ${secs}s: ${r.tarballs} tarball(s), ${r.listed} attachment(s) listed in messages`);
  log(`  added ${r.added} (${mb(r.addedBytes)}), already packed ${r.already}, missing ${r.missing.length}`);
  if (r.shaMismatch) log(`  ⚠ ${r.shaMismatch} attachment(s) whose sha256 differs from manifest.json (stored with the sha256 of the bytes)`);
  for (const m of r.missing) log(`  ✗ missing: ${m.file} message ${m.message_id} attachment ${m.attachment_id} "${m.filename}" — ${m.reason}`);
  log(`  attachments table: ${r.totalRows} row(s), ${mb(r.totalBytes)} · search index: ${r.fts} · ${r.db} is ${mb(r.dbBytes)}`);
}
