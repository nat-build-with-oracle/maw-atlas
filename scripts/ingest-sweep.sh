#!/bin/zsh
# ingest-sweep — cursor-based freshness sweep over every Discord channel.
# Runs `route backfill all --incremental`: walks each channel FORWARD from its
# archive high-watermark (MAX(message_id) — nh's implicit-cursor proposal,
# 2026-07-15), so an idle cycle downloads nothing instead of one full page of
# already-known messages per channel. Channels with no rows yet fall back to
# a newest-style backward walk. Never touches :oldest cursors.
#
# Owner: atlas-discord-backfill-oracle (producer/ingest-keeper). Scheduled on
# m5 via pm2 (name: mirror-ingest-sweep, cron_restart */10, autorestart off —
# this is a one-shot, NOT a daemon; "stopped" between fires is normal).
# Moved here from mirror-oracle/scripts/ 2026-07-15 — producer logic lives
# with the producer code it calls (commands/route.ts).
set -euo pipefail

MAW_ATLAS="${MAW_ATLAS:-/opt/Code/github.com/nat-build-with-oracle/maw-atlas}"
export ATLAS_ROUTE_DB="${ATLAS_ROUTE_DB:-/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite}"
export ATLAS_ROUTE_STATE="${ATLAS_ROUTE_STATE:-/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/last-seen.json}"

cd "$MAW_ATLAS"
exec bun -e '
import { routeBackfill } from "./commands/route";
import { getToken } from "./lib/discord";
const t = getToken();
if (!t) { console.error("no DISCORD_BOT_TOKEN / pass token"); process.exit(1); }
await routeBackfill(console.log, t, ["route", "backfill", "all", "--incremental"]);
'
