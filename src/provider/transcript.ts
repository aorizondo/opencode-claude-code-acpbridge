// Reading Claude Code's session transcripts (`<configDir>/projects/<cwd slug>/<sessionId>.jsonl`):
// the fork points smartRevert needs. Read-only, tail-first (transcripts reach hundreds of MB
// and the entries at the end are what a revert is about).
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** Longest tail read. A single entry can be several hundred KB (a replayed history is one
 *  user entry), so a fixed small window can hold no assistant entry at all. */
const MAX_TAIL = 96 * 1024 * 1024;

/** Lines of the last `len` bytes (a cut first line is dropped unless the whole file is read). */
function tailLines(file: string, len: number): { lines: string[]; whole: boolean } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, len);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split("\n");
    const whole = n === size;
    if (!whole) lines.shift();
    return { lines, whole };
  } finally { closeSync(fd); }
}

/** Runs `scan` over a growing tail until it finds something or the file (or the cap) is exhausted. */
function growingTail<T>(file: string, scan: (lines: string[]) => T | undefined): T | undefined {
  let len = 256 * 1024;
  for (;;) {
    const { lines, whole } = tailLines(file, len);
    const found = scan(lines);
    if (found !== undefined || whole || len >= MAX_TAIL) return found;
    len *= 4;
  }
}

function parse(line: string): any | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

/** uuid of the last main-thread assistant entry. */
export function lastAssistantUuid(file: string): string | undefined {
  try {
    return growingTail(file, (lines) => {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"type":"assistant"')) continue;
        const e = parse(lines[i]);
        if (e?.type === "assistant" && typeof e.uuid === "string" && !e.isSidechain) return e.uuid;
      }
      return undefined;
    });
  } catch { return undefined; /* no transcript (other configDir, agent not writing one) */ }
}

/** A user entry that claude-agent-acp's replay shows as a prompt (the ones a fork cursor can
 *  sit before): not tool results, not meta/compaction/command entries. */
export function isShownUser(e: any): boolean {
  if (e?.type !== "user" || typeof e.uuid !== "string" || e.isSidechain || e.isMeta || e.isCompactSummary) return false;
  if (e.parent_tool_use_id != null) return false;
  const c = e.message?.content;
  if (typeof c === "string") return c.length > 0 && !/^<(local-command-|command-name>)/.test(c.trimStart());
  return Array.isArray(c) && c.some((b: any) => b?.type !== "tool_result");
}

/** uuid of the first prompt the user sent AFTER the entry `uuid` — the message a fork cursor
 *  placed before it would cut at. Undefined when the entry or such a prompt isn't there. */
export function userAfter(file: string, uuid: string): string | undefined {
  try {
    return growingTail(file, (lines) => {
      const needle = `"uuid":"${uuid}"`;
      let at = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(needle)) continue;
        if (parse(lines[i])?.uuid === uuid) { at = i; break; }
      }
      if (at < 0) return undefined;
      for (let i = at + 1; i < lines.length; i++) {
        if (!lines[i].includes('"type":"user"')) continue;
        const e = parse(lines[i]);
        if (isShownUser(e)) return e.uuid as string;
      }
      return undefined;
    });
  } catch { return undefined; }
}
