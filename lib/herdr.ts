/**
 * herdr — thin wrappers over the `maw herdr` CLI for pane resolution.
 *
 * Every function here fails soft (empty array / null) rather than throwing —
 * callers treat "herdr unavailable" the same as "non-herdr machine" and fall
 * back to the legacy tmux path. Nothing here guesses on ambiguity: resolving
 * a label that matches more than one live pane returns the ambiguous list
 * instead of picking one, because `maw herdr resolve` itself silently picks
 * the *focused* pane at the top level — exactly the bug this file exists to
 * route around (measured 2026-10-03: `pulse` resolved 2 panes, chose focus).
 */
import { execFile } from "child_process";

export interface HerdrAgent {
  pane: string;
  agent: string;
  name: string | null;
  status: string;
  workspace: string;
  cwd: string;
}

export type ResolvePaneResult =
  | { kind: "found"; pane: string }
  | { kind: "ambiguous"; panes: string[] }
  | { kind: "not-found" };

function execJson(bin: string, argv: string[]): Promise<any> {
  return new Promise(resolvePromise => {
    execFile(bin, argv, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      try { resolvePromise(JSON.parse(stdout)); }
      catch { resolvePromise(null); }
    });
  });
}

/** Every live agent pane across all herdr sessions. `[]` on any failure (binary missing, non-herdr machine). */
export async function herdrAgents(): Promise<HerdrAgent[]> {
  const data = await execJson("maw", ["herdr", "ls", "--agents", "--json"]);
  const agents = data?.agents;
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((a: any) => a?.pane && a?.cwd)
    .map((a: any): HerdrAgent => ({
      pane: String(a.pane),
      agent: String(a.agent ?? "claude"),
      name: a.name ?? null,
      status: String(a.status ?? "unknown"),
      workspace: String(a.workspace ?? ""),
      cwd: String(a.cwd),
    }));
}

/**
 * Resolve a label to exactly one pane. Reads `resolved.panes` (the full
 * candidate list for that workspace), NOT the top-level `.pane` field —
 * the top-level field is `maw herdr resolve`'s own best guess (the focused
 * pane) and is exactly what silently picked wrong in the measured bug.
 */
export async function resolveHerdrPane(label: string): Promise<ResolvePaneResult> {
  const data = await execJson("maw", ["herdr", "resolve", label, "--json"]);
  const panes = data?.resolved?.panes;
  if (!Array.isArray(panes) || panes.length === 0) return { kind: "not-found" };
  if (panes.length > 1) return { kind: "ambiguous", panes: panes.map((p: any) => String(p?.pane)) };
  const pane = panes[0]?.pane;
  if (!pane) return { kind: "not-found" };
  return { kind: "found", pane: String(pane) };
}
