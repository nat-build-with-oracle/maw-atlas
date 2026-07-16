// pm2 job: daily archive gap-scan + auto-heal (one-shot, 04:30).
// Owner: atlas-discord-backfill-oracle. Load with:
//   env -u cron_restart pm2 start scripts/gap-scan.ecosystem.config.cjs && env -u cron_restart pm2 save
// (bare `cron_restart` env vars silently override this file's value — see ingest-sweep notes)
module.exports = {
  apps: [
    {
      name: "backfill-gap-scan",
      script: "/opt/Code/github.com/nat-build-with-oracle/maw-atlas/scripts/gap-scan.sh",
      cwd: "/opt/Code/github.com/nat-build-with-oracle/maw-atlas",
      interpreter: "bash",
      autorestart: false, // one-shot: "stopped" between daily fires is the normal state
      cron_restart: "30 4 * * *",
    },
  ],
};
