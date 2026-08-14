// pm2 job definition for the Discord archive freshness sweep (one-shot).
// Owner: maw-atlas (cli/bf.ts front-end) — absorbed from atlas-discord-backfill-oracle 2026-08-15. Load with:
//   pm2 start scripts/ingest-sweep.ecosystem.config.cjs && pm2 save
// NOTE: a bare `cron_restart` env var (e.g. leaked from another pm2 job's
// environment) silently OVERRIDES both CLI flags and this file's value at
// `pm2 start` time — start from a shell where `env | grep cron_restart` is
// empty, or prefix with `env -u cron_restart`.
module.exports = {
  apps: [
    {
      name: "mirror-ingest-sweep",
      script: "/opt/Code/github.com/nat-build-with-oracle/maw-atlas/scripts/ingest-sweep.sh",
      cwd: "/opt/Code/github.com/nat-build-with-oracle/maw-atlas",
      interpreter: "bash",
      autorestart: false, // one-shot: "stopped" between fires is the normal state
      cron_restart: "*/10 * * * *",
    },
  ],
};
