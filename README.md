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
maw atlas download <channelId|threadId> --out[=DIR]   # + <channel-name>-<channelId>.tar.gz: raw JSON, attachments, threads.md
maw atlas download <guildId> --out[=DIR]   # whole server: one .tar.gz per channel + server.md + server.sqlite
# download writes rows to the server's own DB: .maw/atlas-route/guilds/<guildId>-<slug>.sqlite (ATLAS_ROUTE_DB overrides)
maw atlas channel create <guildId> <name> [--type=N] [--parent=<categoryId>]
maw atlas channel delete <id|#name>...          # dry run: lists what would be deleted
maw atlas channel delete <id|#name>... --yes    # archive DB + .tar.gz blob (default ~/.maw/atlas-blobs), then delete
maw atlas channel move <id|#name> <categoryId>
maw atlas add-guild <invite-or-id>   # discover guild channels
maw atlas whoami                     # bot identity
maw atlas guild icon                 # show current guild icon URL
maw atlas guild icon set ./icon.png  # set guild icon
maw atlas guild icon --remove        # remove guild icon
maw atlas check                      # consolidation check
maw atlas wake <bot>                 # remote bot wake
maw atlas vesicle <bot>              # tmux transport demo
```

## One db, one binary: `pack` + `view`

`download <guildId> --out` writes a folder of per-channel `.tar.gz` blobs plus `server.sqlite`.
The images are stored only inside the tarballs, and the CDN URLs in `attachments_json` expire.
These two commands turn that folder into one file you can open anywhere:

```
maw atlas pack <guild-folder>                 # attachments from every .tar.gz into <guild-folder>/server.sqlite
maw atlas view <guild-folder|server.sqlite>   # Discord-style viewer on http://127.0.0.1:7710/
scripts/build-atlas-view.sh                   # bun build --compile → ./atlas-view (one executable)
./atlas-view <server.sqlite> [--port=N] [--host=127.0.0.1]
```

- **pack** adds three tables to `server.sqlite`:
  - `attachments`: attachment_id PK, message/channel/thread ids, filename, content_type, size, width, height, sha256, and `data` BLOB
  - `messages_fts`: a trigram FTS5 index on content + author. Trigram works on Thai, which has no spaces between words
  - `server_meta`: the guild name
  - `channel_meta`: the raw channel and thread objects, which give the viewer each channel's topic
- How pack runs:
  - It extracts one tarball at a time into a temp dir and commits each tarball in its own transaction.
  - It is idempotent: a re-run adds 0.
  - It reports every attachment that `attachments_json` names but the tar lacks.
  - It makes no Discord calls, and it writes only that folder's `server.sqlite`. Run it on a copy (`cp -Rc`) if the original must stay as `download` left it.
- **view** opens the db read-only and is laid out like Discord's dark theme. Features:
  - server rail; sidebar of categories, channels and threads
  - channel header with its topic, and a welcome header at the start of each channel
  - forum channels shown as post cards
  - member list
  - pages of 100 messages, with more loading as you scroll up
  - inline images, video and audio served from `/att/<id>`, with Range support
  - replies, embeds (text only) and reactions
  - search
- Network limits for view:
  - It binds 127.0.0.1, or a tailscale `100.x` address via `--host`. Any other address is refused.
  - It loads nothing from Discord: avatars are initials, custom emoji show as `:name:`, and embed images are not shown.
- An unpacked db still opens in view, showing file names instead of images.

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
