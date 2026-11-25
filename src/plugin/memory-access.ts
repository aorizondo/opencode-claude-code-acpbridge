// Claude Code's own memory without a permission prompt. Its auto memory lives in
// `<configDir>/projects/<cwd as slug>/memory/` (MEMORY.md plus one file per memory), and
// under the bridge Claude reads and writes it with OpenCode's tools — the native ones are
// off — so every access asked for `external_directory`. This is the rule that allows it.
//
// A `permission.evaluate` hook rather than a rule in each agent: OpenCode evaluates the
// configured denies first, so a deny of the user's still wins and only `ask` becomes
// `allow`. It applies to the Claude Code agents only; other agents don't own that memory.
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfigDir, type ClaudeCodeControl } from "../acp/claude-config.js";

const slash = (value: string) => value.replaceAll("\\", "/");

/** Claude Code's config directory as the agent processes see it. */
export function claudeConfigRoot(ctrl: ClaudeCodeControl): string {
  return slash(resolveConfigDir(ctrl) ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).replace(/\/+$/, "");
}

/** An `external_directory` resource inside one project's memory directory:
 *  `<root>/projects/<slug>/memory`, `…/memory/*` or deeper. The slug is one path segment. */
export function insideMemory(resource: string, root: string): boolean {
  const prefix = `${root}/projects/`;
  const r = slash(resource);
  if (!r.startsWith(prefix)) return false;
  const [slug, dir, ...rest] = r.slice(prefix.length).split("/");
  return !!slug && dir === "memory" && !rest.some((part) => part === "..");
}

export interface MemoryEvaluation {
  readonly agent?: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  effect: "allow" | "deny" | "ask";
}

/** `ask` → `allow` when a Claude Code agent asks only for its memory directory. */
export function applyMemoryAccess(event: MemoryEvaluation, root: string, isClaudeAgent: (agent: string) => boolean): boolean {
  if (event.effect !== "ask" || event.action !== "external_directory") return false;
  if (!event.agent || !isClaudeAgent(String(event.agent))) return false;
  if (event.resources.length === 0 || !event.resources.every((resource) => insideMemory(resource, root))) return false;
  event.effect = "allow";
  return true;
}
