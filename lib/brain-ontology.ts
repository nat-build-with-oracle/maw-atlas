/**
 * brain-ontology — an Apache Ossie (0.3.0.dev0) description of a Discord brain: what the things are, where they live,
 * and the numbers worth asking for, so another tool (or an LLM) can read the archive without guessing the schema.
 *
 *   discord.ontology.yaml        concepts: Server, Room, Thread, Person, Message, Chunk, Topic (+ value types) and
 *                                how they relate, each relationship with a sentence ("{Message} is posted in {Room}")
 *   discord.semantic_model.yaml  datasets over server.sqlite (discord_messages, channels) and the brain folder
 *                                (chunks, rooms, topics), keys, joins, metrics (message count, active people, bot share,
 *                                chunks, topics), ai_context pointing at /brain/api
 *   discord.mapping.yaml         which dataset field identifies each concept and fills each relationship
 *
 * Schema only: no message text, no names, no ids — the counts in descriptions come from meta.json. The three files
 * pass apache/ossie validation/validate.py (tests/brain-ontology.test.ts runs it when the checkout is present).
 * Apache Ossie: https://github.com/apache/ossie (incubating; ex Open Semantic Interchange). Laris built the first
 * fleet Ossie model over relic5 on 2026-11-22 and noted Discord was not covered; this covers it.
 */

const V = "0.3.0.dev0";

// ---- a small YAML writer: maps, lists, scalars. Strings are JSON-quoted (valid YAML double-quoted scalars).
const plain = (s: string) => /^(\.\/)?[A-Za-z_][A-Za-z0-9_./-]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s);
function scalar(v: unknown): string {
  if (typeof v === "string") return plain(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  throw new Error(`not a scalar: ${typeof v}`);
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function toYaml(v: unknown, ind = ""): string {
  if (Array.isArray(v)) {
    if (!v.length) return " []";
    if (v.every((x) => !isObj(x) && !Array.isArray(x))) return ` [${v.map(scalar).join(", ")}]`;
    return v.map((x) => {
      if (isObj(x)) { const body = toYaml(x, ind + "  "); return `\n${ind}- ${body.replace(/^\n\s*/, "")}`; }
      return `\n${ind}-${toYaml(x, ind + "  ")}`;
    }).join("");
  }
  if (isObj(v)) {
    return Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
      if (isObj(x) || (Array.isArray(x) && x.some((y) => isObj(y) || Array.isArray(y)))) return `\n${ind}${k}:${toYaml(x, ind + "  ")}`;
      return `\n${ind}${k}:${Array.isArray(x) ? toYaml(x, ind + "  ") : " " + scalar(x)}`;
    }).join("");
  }
  return " " + scalar(v);
}
const doc = (header: string, body: Record<string, unknown>) => `# ${header}\n# Written by maw atlas brain ontology (Apache Ossie ${V}). Schema only: no message text, names or ids.\n${toYaml(body).replace(/^\n/, "")}\n`;

// ---- ontology
const rel = (name: string, concept: string, says: string, multiplicity = "ManyToOne") => ({ name, roles: [{ concept }], verbalizes: [says], multiplicity });
export function ontology(serverWord: string) {
  const value = (concept: string, extendsC: string, description: string, requires?: string[]) => ({ concept, description, type: "ValueType", extends: [extendsC], requires });
  return {
    version: V,
    name: "DiscordBrain",
    description: `Ontology of a Discord archive (${serverWord}) as maw atlas reads it: servers, rooms, threads, people, messages, and the brain's conversation chunks and topics.`,
    requires: ["COUNT[Message] > 0", "COUNT[Room] > 0"],
    ontology: [
      value("Snowflake", "String", "A Discord id: a 64-bit number written as decimal digits; it also encodes the creation time."),
      value("RoomName", "String", "The name of a channel or thread as Discord shows it."),
      value("PersonName", "String", "The display name of an author at the time of the message."),
      value("MessageText", "String", "Message content plus the text of its embeds."),
      value("Keyword", "String", "A c-TF-IDF keyword of a topic (PyThaiNLP newmm words for Thai)."),
      value("ChunkId", "Integer", "Position of a chunk in the brain folder (0-based).", ["ChunkId >= 0"]),
      value("TopicId", "Integer", "Topic number from HDBSCAN on the 3D map; 65535 means no topic.", ["TopicId >= 0"]),
      value("RoomIndex", "Integer", "Position of a room in meta.json groups (0-based).", ["RoomIndex >= 0"]),
      value("EpochMs", "Integer", "Milliseconds since 1970-01-01 UTC."),
      { concept: "Server", description: "A Discord server (guild).", type: "EntityType", identify_by: ["id"],
        relationships: [rel("id", "Snowflake", "{Server} is identified by {Snowflake}", "OneToOne"), rel("name", "String", "{Server} has name {String}")] },
      { concept: "Room", description: "A text channel. Threads are drawn in their parent room.", type: "EntityType", identify_by: ["id"],
        relationships: [rel("id", "Snowflake", "{Room} is identified by {Snowflake}", "OneToOne"), rel("name", "RoomName", "{Room} has {RoomName}"),
          rel("server", "Server", "{Room} belongs to {Server}")] },
      { concept: "Thread", description: "A thread under a room.", type: "EntityType", extends: ["Room"],
        relationships: [rel("parent", "Room", "{Thread} is opened under {Room}")] },
      { concept: "Person", description: "An author: a person or a bot.", type: "EntityType", identify_by: ["id"],
        relationships: [rel("id", "Snowflake", "{Person} is identified by {Snowflake}", "OneToOne"), rel("name", "PersonName", "{Person} is shown as {PersonName}"),
          { name: "bot", verbalizes: ["{Person} is a bot"] }] },
      { concept: "Message", description: "One Discord message.", type: "EntityType", identify_by: ["id"],
        relationships: [rel("id", "Snowflake", "{Message} is identified by {Snowflake}", "OneToOne"), rel("room", "Room", "{Message} is posted in {Room}"),
          rel("author", "Person", "{Message} is written by {Person}"), rel("text", "MessageText", "{Message} says {MessageText}"),
          rel("sent_at", "DateTime", "{Message} is sent at {DateTime}")] },
      { concept: "Chunk", description: "A conversation chunk: consecutive messages of one room or thread with no long silence; one point on the 3D map.", type: "EntityType", identify_by: ["id"],
        relationships: [rel("id", "ChunkId", "{Chunk} is identified by {ChunkId}", "OneToOne"), rel("room", "Room", "{Chunk} happens in {Room}"),
          rel("starts", "EpochMs", "{Chunk} starts at {EpochMs}"), rel("ends", "EpochMs", "{Chunk} ends at {EpochMs}"),
          rel("topic", "Topic", "{Chunk} is about {Topic}"), rel("size", "Integer", "{Chunk} holds {Integer} messages")] },
      { concept: "Topic", description: "A cluster of chunks on the map (HDBSCAN) named by its c-TF-IDF keywords.", type: "EntityType", identify_by: ["id"],
        relationships: [rel("id", "TopicId", "{Topic} is identified by {TopicId}", "OneToOne"), rel("label", "String", "{Topic} is labelled {String}"),
          rel("chunks", "Integer", "{Topic} has {Integer} chunks"), rel("rising", "Decimal", "{Topic} rises by {Decimal}")] },
    ],
  };
}

// ---- semantic model
const f = (name: string, description: string, datatype: string, extra: Record<string, unknown> = {}) => ({ name, expression: { sql: name }, description, datatype, ...extra });
export function semanticModel(meta: any, insight: any | null) {
  const c = meta.counts || {};
  const topics = insight?.topics?.length ?? 0;
  return {
    version: V,
    name: "discord_brain",
    description: `A Discord archive and its meaning map: ${c.messages ?? "?"} messages in ${c.points ?? meta.n} chunks, ${c.rooms ?? "?"} rooms, ${c.servers ?? (meta.servers || []).length} server(s), ${topics} topics; built ${String(meta.built || "").slice(0, 10)}.`,
    ai_context: {
      instructions: "Discord chat between people and bots. MESSAGES and CHANNELS are the raw archive (server.sqlite from maw atlas download). CHUNKS, ROOMS and TOPICS come from maw atlas brain: one chunk per conversation burst, placed by meaning. For text an LLM can summarize use the served API: /brain/api/topics/<id>, /brain/api/rooms/<i>, /brain/api/context?q=..., /brain/api/story?topic=|room=|q=, /brain/api/report.md. Times are UTC in the data; reports use Asia/Bangkok.",
      synonyms: ["discord archive", "chat history", "discord brain"],
    },
    datasets: [
      { name: "MESSAGES", source: "server.sqlite.discord_messages", primary_key: ["message_id"], description: "Every downloaded message, one row each.",
        ai_context: { synonyms: ["messages", "posts", "chat lines"] },
        fields: [f("message_id", "Discord id of the message.", "String"), f("channel_id", "Room (channel) the message is in.", "String"),
          f("thread_id", "Thread id, empty when the message is in the room itself.", "String"), f("guild_id", "Server id.", "String"),
          f("author_id", "Author id.", "String"), f("author_name", "Author display name.", "String"),
          f("author_is_bot", "1 when the author is a bot, else 0.", "Integer"), f("content", "Message text.", "String"),
          f("ts", "Send time, ISO 8601 UTC.", "String", { dimension: { is_time: true } })] },
      { name: "CHANNELS", source: "server.sqlite.channels", primary_key: ["id"], description: "Rooms and threads of the server.",
        ai_context: { synonyms: ["rooms", "channels", "threads"] },
        fields: [f("id", "Channel or thread id.", "String"), f("name", "Name.", "String"), f("kind", "channel or thread.", "String"),
          f("parent_id", "Parent room of a thread.", "String"), f("messages", "Messages downloaded.", "Integer")] },
      { name: "CHUNKS", source: "brain.chunks", primary_key: ["chunk_id"], description: "One row per point of the 3D map (p/<shard>.json, grp.u32, topic.u16).",
        ai_context: { synonyms: ["conversations", "points", "bursts"] },
        fields: [f("chunk_id", "Position in the brain folder.", "Integer"), f("room_index", "Room (meta.json groups).", "Integer"),
          f("start_ms", "First message, epoch ms.", "Integer", { dimension: { is_time: true } }), f("end_ms", "Last message, epoch ms.", "Integer"),
          f("thread", "Thread name or empty.", "String"), f("topic_id", "Topic, 65535 = none.", "Integer"), f("messages", "Messages in the chunk.", "Integer")] },
      { name: "ROOMS", source: "brain.groups", primary_key: ["room_index"], description: "meta.json groups: one row per room drawn on the map.",
        fields: [f("room_index", "Position in meta.json groups.", "Integer"), f("room_id", "Discord id of the room.", "String"),
          f("title", "Room title.", "String"), f("server_index", "Server (meta.json servers).", "Integer"), f("points", "Chunks in the room.", "Integer")] },
      { name: "TOPICS", source: "brain.insight_topics", primary_key: ["topic_id"], description: "insight.json topics (HDBSCAN on the map + c-TF-IDF).",
        ai_context: { synonyms: ["themes", "subjects", "clusters"] },
        fields: [f("topic_id", "Topic number.", "Integer"), f("label", "Top keywords joined.", "String"), f("chunks", "Chunks in the topic.", "Integer"),
          f("messages", "Messages in the topic.", "Integer"), f("first_day", "First day (Asia/Bangkok).", "String"), f("last_day", "Last day.", "String"),
          f("rising", "Share in the last 14 days over the overall share.", "Decimal")] },
    ],
    relationships: [
      { name: "message_in_channel", from: "MESSAGES", to: "CHANNELS", from_columns: ["channel_id"], to_columns: ["id"] },
      { name: "chunk_in_room", from: "CHUNKS", to: "ROOMS", from_columns: ["room_index"], to_columns: ["room_index"] },
      { name: "chunk_about_topic", from: "CHUNKS", to: "TOPICS", from_columns: ["topic_id"], to_columns: ["topic_id"] },
      { name: "room_is_channel", from: "ROOMS", to: "CHANNELS", from_columns: ["room_id"], to_columns: ["id"] },
    ],
    metrics: [
      { name: "message_count", expression: { sql: "COUNT(MESSAGES.message_id)" }, description: "Messages.", datatype: "Integer", ai_context: { synonyms: ["how many messages", "volume"] } },
      { name: "active_people", expression: { sql: "COUNT(DISTINCT CASE WHEN MESSAGES.author_is_bot = 0 THEN MESSAGES.author_id END)" }, description: "People (not bots) who wrote at least one message.", datatype: "Integer", ai_context: { synonyms: ["members active", "who talks"] } },
      { name: "bot_share", expression: { sql: "AVG(CAST(MESSAGES.author_is_bot AS DOUBLE))" }, description: "Share of messages written by bots (0 to 1).", datatype: "Decimal" },
      { name: "chunk_count", expression: { sql: "COUNT(CHUNKS.chunk_id)" }, description: "Conversation chunks (points on the map).", datatype: "Integer", ai_context: { synonyms: ["conversations"] } },
      { name: "topic_count", expression: { sql: "COUNT(DISTINCT TOPICS.topic_id)" }, description: "Topics found.", datatype: "Integer" },
    ],
  };
}

// ---- mapping
const ref = (relationship: string, expression: string) => ({ relationship, expression });
const child = (relationship: string, concept: string, expression: string) => ({ object_mapping: { concept, expression }, relationship });
const entityChild = (relationship: string, concept: string, refs: object[]) => ({ object_mapping: { concept, referent_mappings: refs }, relationship });
export function mapping() {
  return {
    version: V,
    name: "discord_brain_mapping",
    description: "Maps the DiscordBrain ontology onto the discord_brain semantic model.",
    ontology_ref: { name: "DiscordBrain", iri: "./discord.ontology.yaml" },
    semantic_model_ref: { name: "discord_brain", iri: "./discord.semantic_model.yaml" },
    concept_mappings: [
      { concept: "Server", object_mappings: [{ referent_mappings: [ref("id", "MESSAGES.guild_id")] }] },
      { concept: "Room", object_mappings: [{ referent_mappings: [ref("id", "CHANNELS.id")] }],
        link_mappings: [{ object_mapping: { referent_mappings: [ref("id", "CHANNELS.id")] }, children: [child("name", "RoomName", "CHANNELS.name")] }] },
      { concept: "Person", object_mappings: [{ referent_mappings: [ref("id", "MESSAGES.author_id")] }],
        link_mappings: [
          { object_mapping: { referent_mappings: [ref("id", "MESSAGES.author_id")] }, children: [child("name", "PersonName", "MESSAGES.author_name")] },
          { object_mapping: { referent_mappings: [ref("id", "MESSAGES.author_id WHERE ( MESSAGES.author_is_bot == 1 )")] }, relationship: "bot" }] },
      { concept: "Message", object_mappings: [{ referent_mappings: [ref("id", "MESSAGES.message_id")] }],
        link_mappings: [{ object_mapping: { referent_mappings: [ref("id", "MESSAGES.message_id")] }, children: [
          entityChild("room", "Room", [ref("id", "MESSAGES.channel_id")]),
          entityChild("author", "Person", [ref("id", "MESSAGES.author_id")]),
          child("text", "MessageText", "MESSAGES.content"),
          child("sent_at", "DateTime", "MESSAGES.ts")] }] },
      { concept: "Topic", object_mappings: [{ referent_mappings: [ref("id", "TOPICS.topic_id")] }],
        link_mappings: [{ object_mapping: { referent_mappings: [ref("id", "TOPICS.topic_id")] }, children: [
          child("label", "String", "TOPICS.label"), child("chunks", "Integer", "TOPICS.chunks"), child("rising", "Decimal", "TOPICS.rising")] }] },
      { concept: "Chunk", object_mappings: [{ referent_mappings: [ref("id", "CHUNKS.chunk_id")] }],
        link_mappings: [{ object_mapping: { referent_mappings: [ref("id", "CHUNKS.chunk_id")] }, children: [
          entityChild("room", "Room", [ref("id", "ROOMS.room_id")]),
          child("starts", "EpochMs", "CHUNKS.start_ms"), child("ends", "EpochMs", "CHUNKS.end_ms"),
          entityChild("topic", "Topic", [ref("id", "CHUNKS.topic_id")]),
          child("size", "Integer", "CHUNKS.messages")] }] },
    ],
  };
}

export const ONTOLOGY_FILES = ["discord.ontology.yaml", "discord.semantic_model.yaml", "discord.mapping.yaml"] as const;

/** The three Ossie documents for a brain folder's meta.json (+ insight.json when present). */
export function brainOntology(meta: any, insight: any | null): Record<(typeof ONTOLOGY_FILES)[number], string> {
  const n = (meta.servers || []).length;
  return {
    "discord.ontology.yaml": doc("Ossie ontology: the concepts of a Discord brain", ontology(n > 1 ? `${n} servers` : "one server")),
    "discord.semantic_model.yaml": doc("Ossie semantic model: where those concepts live (server.sqlite + the brain folder)", semanticModel(meta, insight)),
    "discord.mapping.yaml": doc("Ossie mapping: ontology concepts onto semantic model fields", mapping()),
  };
}
