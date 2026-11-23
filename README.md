# maw atlas

Discord fleet infrastructure plugin for [maw-js](https://github.com/Soul-Brews-Studio/maw-js).

## Install

```
maw plugin install nat-build-with-oracle/maw-atlas
maw atlas --help
```

Update: `maw plugin update atlas`

## Commands

```
maw atlas ls                          # list guilds + channels
maw atlas ls my server                  # only guilds whose name holds every word
maw atlas read <channel-id> 50 --format json   # read as raw Discord JSON
maw atlas read <channel-id> --all --since 2026-08-01 --before 2026-08-06
maw atlas backfill [--all]           # backfill message history
maw atlas download <guildId|channelId|threadId> [--max=N]   # explicit full download, no cursor
maw atlas download <channelId|threadId> --out[=DIR]   # + <channel-name>-<channelId>.tar.gz: raw JSON, attachments, threads.md
maw atlas download <guildId> --out[=DIR]   # whole server: one .tar.gz per channel + server.md + server.sqlite
maw atlas download my server --out --extract --safe-names
#   a guild NAME works where an id does (every word must appear; several or none → candidates listed, nothing downloaded)
#   --extract: also unpack each blob → <guild folder>/channels/<channel>-<id>/ (messages.jsonl, attachments/, threads.md)
#   --safe-names: names a shell takes unquoted — Thai kept; emoji, &, ｜, ∕, spaces → "-"   (--ascii: a-z 0-9 . _ - only)
maw atlas embed <guild folder|guildId|guild name>... [--lance=DIR] [--room=<channelId>]... [--full]
#   messages → LanceDB for meaning search; see "Search a server by meaning" below
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

## Search a server by meaning (embed → LanceDB)

`embed` reads a `download <guild> --out` folder (its `server.sqlite`; no Discord calls) and writes, from one
embedding pass, a LanceDB table `messages` per room, per server, and optionally for several servers together:

```
<guild folder>/
├── server.sqlite, server.md, <channel>-<id>.tar.gz …     ← download --out
├── lance/                                                ← embed: every message of the server
└── channels/<channel>-<id>/                              ← download --extract: the unpacked blob
    └── lance/                                            ← embed: this room only (its threads included)
<DIR>/                                                    ← embed --lance=DIR: every server given, together
```

```
maw atlas download my server --out --extract --safe-names
maw atlas embed my server --lance=~/atlas-all     # by name, id, or folder path
maw atlas embed my server --lance=~/atlas-all     # again: only new or edited messages are embedded
maw atlas embed <folder> --room=<channelId> --full        # re-embed one room
```

- **Text** = the message plus its embeds' title/description/fields, cut at 6000 characters. Messages with no
  text (attachment-only, joins, pins) get no row.
- **Incremental**: each row keeps `text_sha` (text + model); unchanged rows are skipped. Room and cross-server
  tables are rebuilt from the server table, never re-embedded. Rows are committed every 4096 embeddings, so an
  interrupted run keeps its progress. `--full` re-embeds (new model, new embed server); a model with another
  vector size is refused without `--full`.
- **Vectors** come from an Ollama-compatible `/api/embed` server — by default
  [Chippy](https://github.com/Soul-Brews-Studio/chippy) on the Apple Neural Engine
  (`http://127.0.0.1:11445`, `embeddinggemma:ane-w8a16`). Ollama: `--url=http://127.0.0.1:11434 --model=embeddinggemma`.
- **Needs [uv](https://docs.astral.sh/uv/)**: LanceDB has no package a bun plugin can carry without an install
  step, so `scripts/atlas-lance.py` writes the tables through `uv run --with lancedb --with pyarrow`
  (wheels cached after the first run).

Columns: `message_id guild_id guild channel_id channel thread_id thread author_id author is_bot ts text content
attachments text_sha model vector`. Query from Python:

```python
import json, urllib.request, lancedb
def vec(q):  # same server + model as the table
    req = urllib.request.Request("http://127.0.0.1:11445/api/embed",
        json.dumps({"model": "embeddinggemma:ane-w8a16", "input": [q]}).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))["embeddings"][0]
t = lancedb.connect("<guild folder>/channels/<channel>-<id>/lance").open_table("messages")
for h in t.search(vec("ราคาเบียร์ต่อแก้ว")).limit(5).to_list():
    print(round(h["_distance"], 3), h["ts"][:10], h["author"], h["text"][:80])
```

| env | default | used by |
|---|---|---|
| `ATLAS_BLOB_DIR` | `~/.maw/atlas-blobs` | `download --out` default, `embed` lookup by id/name (`--from=DIR` overrides) |
| `ATLAS_EMBED_URL` | `http://127.0.0.1:11445` | `embed` (`--url=`) |
| `ATLAS_EMBED_MODEL` | `embeddinggemma:ane-w8a16` | `embed` (`--model=`) |

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

## Development

```
git clone https://github.com/nat-build-with-oracle/maw-atlas && cd maw-atlas
bun index.ts --help                  # run the plugin from the checkout
bun test                             # tests/ — names, embed targets, extract + resume, LanceDB self-test (needs uv)
uv run --with lancedb --with pyarrow python -I scripts/atlas-lance.py self-test   # the LanceDB writer alone
```

## License

MIT
