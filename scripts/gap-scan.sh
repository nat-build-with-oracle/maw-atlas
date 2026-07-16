#!/bin/bash
# gap-scan — daily archive completeness check + auto-heal (charter task 3, cron form).
# Owner: atlas-discord-backfill-oracle. Green-lit by Nat 2026-07-16.
#
# 1. detect-gaps.ts probes every channel (read-only, ~200 REST calls, 429-backoff'd)
# 2. fixable gaps (zero-row/bottom/cursor) → route backfill <ch> --full (idempotent)
# 3. re-scan to confirm closure; summary line + JSON kept for the panel / heimdall
#
# pm2 one-shot (autorestart off, cron_restart daily 04:30) — "stopped" between
# fires is normal. TRAP: start with `env -u cron_restart pm2 start ...` — a bare
# cron_restart env var silently overrides the schedule (see ingest-sweep notes).
set -euo pipefail

MAW_ATLAS="${MAW_ATLAS:-/opt/Code/github.com/nat-build-with-oracle/maw-atlas}"
export ATLAS_ROUTE_DB="${ATLAS_ROUTE_DB:-/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite}"
export ATLAS_ROUTE_STATE="${ATLAS_ROUTE_STATE:-/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/last-seen.json}"
export GAPS_JSON="${GAPS_JSON:-/tmp/backfill-gaps.json}"

cd "$MAW_ATLAS"
echo "── gap-scan $(date '+%Y-%m-%d %H:%M:%S') ──"
bun scripts/detect-gaps.ts --json "$GAPS_JSON"

FIXABLE=$(bun -e '
const d = JSON.parse(await Bun.file(process.env.GAPS_JSON).text());
const fix = d.gaps.filter(g => g.kind !== "deleted");
console.log(fix.map(g => g.channelId).join(" "));
')

if [ -n "$FIXABLE" ]; then
  echo "auto-heal: $(echo "$FIXABLE" | wc -w | tr -d ' ') channel(s) → backfill --full"
  for CH in $FIXABLE; do
    bun index.ts route backfill "$CH" --full || echo "  ✗ $CH heal failed (จะลองใหม่รอบหน้า)"
  done
  echo "re-scan เพื่อยืนยันการปิด gap"
  bun scripts/detect-gaps.ts --json "$GAPS_JSON"
else
  echo "ไม่มี gap ที่แก้ได้ — archive สมบูรณ์"
fi

# ── alerting (heimdall's convention 2026-07-16: log every run; alert only
# state-DELTA that needs a human; auto-healed stays silent; summarize) ──
STATE_FILE="$(dirname "$ATLAS_ROUTE_DB")/gap-scan-state.json"
export STATE_FILE
ALERTS=$(bun -e '
const cur = JSON.parse(await Bun.file(process.env.GAPS_JSON).text());
let prev = { gaps: [], authFailures: [] };
try { prev = JSON.parse(await Bun.file(process.env.STATE_FILE).text()); } catch {}
const key = (g) => `${g.kind}:${g.channelId}`;
const prevSet = new Set((prev.gaps || []).map(key));
// unhealed gaps still present after auto-heal, that are NEW since last run
const newUnhealed = cur.gaps.filter(g => !prevSet.has(key(g)));
const prevAuth = new Set((prev.authFailures || []).map(a => `${a.status}:${a.channelId}`));
const newAuth = (cur.authFailures || []).filter(a => !prevAuth.has(`${a.status}:${a.channelId}`));
const out = [];
if (newUnhealed.length) out.push(`GAPS\t${newUnhealed.length} gap ใหม่ที่แก้เองไม่ได้: ${newUnhealed.map(g => `[${g.kind}] ${g.name || g.channelId}`).join(", ")}`);
if (newAuth.length) out.push(`AUTH\t${newAuth.map(a => `${a.name || a.channelId} got ${a.status}`).join(", ")}`);
await Bun.write(process.env.STATE_FILE, JSON.stringify(cur, null, 1));
console.log(out.join("\n"));
')
if echo "$ALERTS" | grep -q "^GAPS"; then
  MSG=$(echo "$ALERTS" | grep "^GAPS" | cut -f2)
  maw hey m5:atlas "gap-scan รายวัน: $MSG — ดู $GAPS_JSON / รายละเอียดใน pm2 log backfill-gap-scan — [m5:backfill]" || true
fi
if echo "$ALERTS" | grep -q "^AUTH"; then
  MSG=$(echo "$ALERTS" | grep "^AUTH" | cut -f2)
  maw hey 02-heimdall:1 "token-health event จาก backfill gap-scan: $MSG (Discord archive probe) — [m5:backfill]" || true
fi
[ -z "$ALERTS" ] && echo "ไม่มี delta ใหม่ — เงียบตาม convention"
echo "── gap-scan done $(date '+%H:%M:%S') ──"
