/**
 * names — find a guild by (part of) its name, and turn Discord names into file names
 * a shell can take without quoting.
 *
 * Guild lookup (download/ls/embed take a name where they took an id):
 *   every word of the query must appear in the guild name, compared without case,
 *   spaces or punctuation — "phone booth cider" and "phoneboothcider" both match
 *   "Phone Booth Cider Bar & Co". A query equal to a whole name always wins.
 *
 * File names (download --out --safe-names | --ascii):
 *   keep  (default) the real name, only `/ \ :` whitespace and control chars → "_"
 *   safe  letters and digits of any script (Thai stays), "." "_" "-"; emoji, "&",
 *         "｜", "∕", spaces and every other symbol → "-"; lowercase
 *   ascii safe, then only a-z 0-9 . _ - (a Thai-only name falls back to "channel"/"guild")
 */

export type NameMode = "keep" | "safe" | "ascii";

export interface NamedGuild {
  id: string;
  name: string;
}

export interface GuildMatch<G extends NamedGuild> {
  /** the guild to use, when the query picks exactly one */
  pick?: G;
  /** every guild whose name holds all the query's words */
  matches: G[];
  /** guilds holding at least one of the words, most words first — shown when nothing matches */
  near: G[];
}

/** Lowercase, compatibility-folded, letters/marks/digits only: "Phone Booth Cider Bar & Co" → "phoneboothciderbarco". */
export function normName(s: string): string {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

export function matchGuilds<G extends NamedGuild>(query: string, guilds: G[]): GuildMatch<G> {
  const words = String(query ?? "").split(/\s+/).map(normName).filter(Boolean);
  if (!words.length) return { matches: [], near: [] };
  const whole = normName(query);
  const exact = guilds.filter(g => normName(g.name) === whole);
  const matches = guilds.filter(g => {
    const n = normName(g.name);
    return words.every(w => n.includes(w));
  });
  const hits = (g: G) => words.filter(w => normName(g.name).includes(w)).length;
  const near = guilds
    .filter(g => !matches.includes(g) && hits(g) > 0)
    .sort((a, b) => hits(b) - hits(a) || a.name.localeCompare(b.name));
  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
  return { pick, matches, near };
}

/** Explain a failed lookup: the lines to print, and the error to throw. */
export function lookupFailure<G extends NamedGuild>(query: string, m: GuildMatch<G>, all: G[], what = "guild"): { lines: string[]; error: string } {
  const lines: string[] = [];
  if (m.matches.length > 1) {
    lines.push(`"${query}" matches ${m.matches.length} ${what}s — add a word, or use the id:`);
    for (const g of m.matches) lines.push(`    ${g.id}  ${g.name}`);
    return { lines, error: `"${query}" is ambiguous (${m.matches.length} ${what}s)` };
  }
  const shown = m.near.length ? m.near : all;
  lines.push(`no ${what} name holds every word of "${query}"${shown.length ? (m.near.length ? " — closest:" : ` — the ${what}s here:`) : ""}`);
  for (const g of shown) lines.push(`    ${g.id}  ${g.name}`);
  return { lines, error: `no ${what} matches "${query}"` };
}

/** True for a Discord snowflake id. */
export function isSnowflake(s: string | undefined): boolean {
  return !!s && /^\d{17,20}$/.test(s);
}

/**
 * Clip to a byte budget, keeping a short extension. Filesystems cap one path
 * component at 255 bytes, and Discord attachment names and Thai channel names
 * (3 bytes a character) can exceed it.
 */
export function clip(name: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(name).length <= maxBytes) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  let budget = maxBytes - enc.encode(ext).length;
  let base = "";
  for (const ch of Array.from(name.slice(0, name.length - ext.length))) {
    budget -= enc.encode(ch).length;
    if (budget < 0) break;
    base += ch;
  }
  return base + ext;
}

/** File-name form of a Discord name (see the modes above); never empty, at most 150 bytes. */
export function fileName(name: unknown, fallback: string, mode: NameMode = "keep"): string {
  const raw = String(name ?? "");
  if (mode === "keep") return clip(raw.replace(/[\/\\:\s\x00-\x1f]+/g, "_") || fallback, 150);
  let s = raw.normalize("NFKC")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    // a combining mark only belongs to the letter before it: the U+FE0F after an
    // emoji (🗨️) is a mark too, and must not survive the emoji's removal
    .replace(/(?<![\p{L}\p{N}\p{M}])\p{M}+/gu, "");
  if (mode === "ascii") s = s.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  s = s.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  return clip(s, 150).replace(/[-.]+$/g, "") || fallback;
}
