/**
 * Contract every commands/*.ts file must satisfy for index.ts to autoload it —
 * export both `meta` (this shape) and `run` (or an alias to it).
 */

export type Log = (s: string) => void;

export type TokenRequirement = "required" | "optional" | "none";

export interface CommandMeta {
  /** matched against argv[0] (lowercased) */
  name: string;
  /** one or more lines (join with "\n" for multi-line entries like `transcribe`) shown in `maw atlas help` */
  help: string;
  /** detailed lines for `maw atlas --tree`; defaults to `help` split on "\n" when omitted */
  treeLines?: string[];
  /**
   * required (default): missing DISCORD_BOT_TOKEN blocks the command with an error.
   * optional: token is fetched and passed through (possibly ""), never blocks.
   * none: token is never fetched; command runs unauthenticated.
   */
  tokenRequirement?: TokenRequirement;
}

export type CommandRun = (log: Log, token: string, args: string[]) => Promise<void>;
