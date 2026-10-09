/**
 * send — post a message (text and/or files) to a channel or thread as the current bot.
 *
 * Built so agents without the Discord MCP plugin (Codex / omx buddies in a herdr pane) can post
 * drafts and images and thread them under a human's message. Mentions are OFF unless --ping:
 * a quoted "@everyone" or "<@id>" in agent text must never notify people by accident.
 */
import { statSync } from "fs";
import { basename } from "path";
import type { CommandMeta, Log } from "../lib/command-types";

export const meta: CommandMeta = {
  name: "send",
  help: "send <channelId> <text|-> [--file PATH]... [--reply MSGID] [--ping] [--dry]  post text/files (mentions off)",
  treeLines: [
    "send <channelId> <text|->   post as the current bot ('-' reads text from stdin)",
    "--file PATH             attach a file (repeat, max 10, ≤25 MB each)",
    "--reply MSGID           thread the post under a message",
    "--ping                  allow @mentions (default: none ping)",
    "--dry                   print what would be sent, send nothing",
  ],
};

const MAX_TEXT = 2000;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface SendArgs { channel: string; text: string; files: string[]; reply?: string; ping: boolean; dry: boolean }

export function parseSendArgs(args: string[], stdin?: () => string): SendArgs | string {
  const pos: string[] = []; const files: string[] = [];
  let reply: string | undefined; let ping = false; let dry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file") { const f = args[++i]; if (!f) return "--file needs a path"; files.push(f); }
    else if (a.startsWith("--file=")) files.push(a.slice(7));
    else if (a === "--reply") { reply = args[++i]; if (!reply) return "--reply needs a message id"; }
    else if (a.startsWith("--reply=")) reply = a.slice(8);
    else if (a === "--ping") ping = true;
    else if (a === "--dry") dry = true;
    else pos.push(a);
  }
  const [channel, ...rest] = pos;
  if (!channel || !/^\d{17,20}$/.test(channel)) return "usage: maw atlas send <channelId> <text|-> [--file PATH]... [--reply MSGID] [--ping] [--dry]";
  let text = rest.join(" ");
  if (text === "-") text = stdin ? stdin() : "";
  if (!text && files.length === 0) return "nothing to send — give text, '-' for stdin, or --file";
  if (text.length > MAX_TEXT) return `text is ${text.length} chars — Discord allows ${MAX_TEXT}; split it`;
  if (files.length > MAX_FILES) return `${files.length} files — Discord allows ${MAX_FILES} per message`;
  if (reply && !/^\d{17,20}$/.test(reply)) return `--reply ${reply} is not a message id`;
  return { channel, text, files, reply, ping, dry };
}

export function buildPayload(a: SendArgs) {
  const payload: any = { allowed_mentions: a.ping ? { parse: ["users", "roles", "everyone"] } : { parse: [] } };
  if (a.text) payload.content = a.text;
  if (a.reply) payload.message_reference = { message_id: a.reply, fail_if_not_exists: false };
  if (a.files.length) payload.attachments = a.files.map((f, id) => ({ id, filename: basename(f) }));
  return payload;
}

export async function run(log: Log, token: string, args: string[]) {
  const parsed = parseSendArgs(args.slice(1), () => require("fs").readFileSync(0, "utf8").replace(/\n$/, ""));
  if (typeof parsed === "string") throw new Error(parsed);

  for (const f of parsed.files) {
    let size: number;
    try { size = statSync(f).size; } catch { throw new Error(`no such file: ${f}`); }
    if (size > MAX_FILE_BYTES) throw new Error(`${f} is ${(size / 1048576).toFixed(1)} MB — over 25 MB`);
  }
  const payload = buildPayload(parsed);
  if (parsed.dry) {
    log(`[dry] → channel ${parsed.channel}${parsed.reply ? ` ↪ ${parsed.reply}` : ""} · ${parsed.files.length} file(s) · mentions ${parsed.ping ? "ON" : "off"}`);
    log(JSON.stringify(payload, null, 2));
    return;
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  parsed.files.forEach((f, i) => form.append(`files[${i}]`, Bun.file(f), basename(f)));

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://discord.com/api/v10/channels/${parsed.channel}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "User-Agent": "maw-atlas/1.0.0" },
      body: form,
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Math.max(1000, Number(res.headers.get("retry-after")) * 1000 || 2000);
      await new Promise(r => setTimeout(r, Math.min(wait, 30_000)));
      continue;
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Discord ${res.status}: ${body?.message ?? "error"}`);
    log(`posted ${body.id} → #${parsed.channel}${parsed.reply ? ` ↪ ${parsed.reply}` : ""} · ${body.attachments?.length ?? 0} file(s)`);
    return;
  }
}
