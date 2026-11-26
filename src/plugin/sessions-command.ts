// `/sessions-acp`: which Claude Code session each OpenCode session is linked to, with the
// command to resume it in Claude Code directly (when OpenCode fails, or to continue there).
import type { SessionLink } from "./sessions.js";
import { BRIDGE_NOTICE } from "../provider/history.js";

export interface SessionRow extends SessionLink {
  ocSession: string;
  title?: string;
  directory?: string;
  missing?: boolean;
}

const DEFAULT_ROWS = 25;

/** Which links to show for the command's argument: none → the latest 25, `all` → every one,
 *  anything else → those whose OpenCode/Claude id, title or directory contains it. */
export function selectRows<T extends SessionRow>(rows: T[], arg: string, current?: string): T[] {
  const q = arg.trim().toLowerCase();
  if (q === "all") return rows;
  if (q) return rows.filter((r) =>
    [r.ocSession, r.acpSessionId, r.title, r.directory ?? r.cwd, ...(r.previous ?? [])]
      .some((v) => typeof v === "string" && v.toLowerCase().includes(q)));
  const top = rows.slice(0, DEFAULT_ROWS);
  const cur = current ? rows.find((r) => r.ocSession === current) : undefined;
  return cur && !top.includes(cur) ? [cur, ...top] : top;
}

const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
const when = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const quote = (dir: string) => (/^[\w./~-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`);
export const resumeCommand = (r: Pick<SessionLink, "acpSessionId" | "cwd">) =>
  `${r.cwd ? `cd ${quote(r.cwd)} && ` : ""}claude --resume ${r.acpSessionId}`;

/** The markdown posted in the session (starts with the bridge-notice marker). */
export function renderSessions(rows: SessionRow[], opts: { current?: string; total: number; arg: string }): string {
  const lines = [BRIDGE_NOTICE, "**OpenCode ↔ Claude Code sessions** (acpbridge)", ""];
  if (!rows.length) {
    lines.push(opts.arg ? `No linked session matches \`${opts.arg}\`.` : "No OpenCode session is linked to a Claude Code session yet.");
    return lines.join("\n");
  }
  lines.push("| | OpenCode session | Title | Directory | Last used | Claude Code session | Resume in Claude Code |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const mark = r.ocSession === opts.current ? "▶" : "";
    const title = r.missing ? "_(deleted)_" : cell(r.title ?? "");
    lines.push(`| ${mark} | \`${r.ocSession}\` | ${title} | ${cell(r.directory ?? r.cwd ?? "")} | ${when(r.ts)} | \`${r.acpSessionId}\` | \`${resumeCommand(r)}\` |`);
  }
  const cur = rows.find((r) => r.ocSession === opts.current);
  if (cur?.previous?.length) {
    lines.push("", "Earlier Claude Code sessions of this conversation (newest first; e.g. the state before a revert):");
    for (const id of cur.previous) lines.push(`- \`${resumeCommand({ acpSessionId: id, cwd: cur.cwd })}\``);
  }
  const shown = rows.length < opts.total ? ` Showing ${rows.length} of ${opts.total}: \`/sessions-acp all\` lists every one, \`/sessions-acp <text>\` filters.` : "";
  lines.push("", `This message is not sent to the model.${shown}`);
  return lines.join("\n");
}
