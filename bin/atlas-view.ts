#!/usr/bin/env bun
/**
 * atlas-view <server.sqlite> — standalone entry for the viewer; compiled to a
 * single executable by scripts/build-atlas-view.sh.
 */
import { viewMain } from "../lib/viewer-cli";

try {
  await viewMain(s => console.log(s), process.argv.slice(2), "atlas-view");
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
