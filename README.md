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
maw atlas add-guild <invite-or-id>   # discover guild channels
maw atlas whoami                     # bot identity
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

## License

MIT
