# maw atlas

Discord fleet infrastructure plugin for [maw-js](https://github.com/Soul-Brews-Studio/maw-js).

```
maw plugin install nat-build-with-oracle/maw-atlas
```

## Commands

```
maw atlas ls                          # list guilds + channels
maw atlas read <channel-id> 50 --format json   # read as raw Discord JSON
maw atlas read <channel-id> --all --since 2026-08-01 --before 2026-08-06
maw atlas backfill [--all]           # backfill message history
maw atlas download <guildId|channelId|threadId> [--max=N]   # explicit full download, no cursor
maw atlas add-guild <invite-or-id>   # discover guild channels
maw atlas whoami                     # bot identity
maw atlas guild icon                 # show current guild icon URL
maw atlas guild icon set ./icon.png  # set guild icon
maw atlas guild icon --remove        # remove guild icon
maw atlas check                      # consolidation check
maw atlas wake <bot>                 # remote bot wake
maw atlas vesicle <bot>              # tmux transport demo
```

## Setup

```bash
# token in pass (recommended)
pass insert discord/atlas-oracle-token

# or env var
export DISCORD_BOT_TOKEN=...
```

## What it does

Atlas manages Discord for the oracle fleet — bots, tokens, channels, guilds, permissions, message history. Named after the Titan who holds the sky.

> ท้องฟ้าไม่ร่วง เพราะมีคนแบกอยู่

## Discord Archive CLI (`bf`)

The Discord message archive (`.maw/atlas-route/messages.sqlite` in atlas-oracle) has its own
terminal front-end, absorbed here from the now-archived `atlas-discord-backfill-oracle` repo
(2026-08-15):

```
bf              # dashboard: totals, sweep recency, top channels, gaps
bf sweep        # incremental backfill, all channels
bf gaps         # scan for archive gaps
bf fill <ch>    # deep backfill one channel
bf download <id> [--max=N]   # explicit guild/channel/thread download
bf view <ch> [n]
bf export <ch> [--csv]
bf channels [query]
```

Source: `cli/bf.ts`. A native desktop twin (SwiftUI + Tauri) lives in `app/` — dormant since its
initial 2026-07-15 build, not part of the daily-driver CLI workflow.

## License

MIT
