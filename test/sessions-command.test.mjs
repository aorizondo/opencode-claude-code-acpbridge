import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "acp-home-")); // registry under a scratch HOME
const { renderSessions, selectRows, resumeCommand } = await import("../dist/plugin/sessions-command.js");
const { isBridgeNotice, historyOf, BRIDGE_NOTICE } = await import("../dist/provider/history.js");
const { setLink, getLink, listLinks } = await import("../dist/plugin/sessions.js");

const row = (i, extra = {}) => ({ ocSession: `ses_${i}`, acpSessionId: `uuid-${i}`, sentHistoryLen: 1, ts: 1_800_000_000_000 - i, cwd: "/proj", ...extra });

test("sessions-acp: table with the resume command, current session marked", () => {
  const text = renderSessions([row(1, { title: "Fix | bug" }), row(2, { missing: true })], { current: "ses_1", total: 2, arg: "" });
  assert.ok(text.startsWith(BRIDGE_NOTICE));
  assert.match(text, /\| ▶ \| `ses_1` \| Fix \\\| bug \| \/proj \|/);
  assert.match(text, /`cd \/proj && claude --resume uuid-1`/);
  assert.match(text, /_\(deleted\)_/);
});

test("sessions-acp: earlier Claude sessions of the current conversation are listed", () => {
  const text = renderSessions([row(1, { previous: ["old-a", "old-b"] })], { current: "ses_1", total: 1, arg: "" });
  assert.match(text, /claude --resume old-a/);
  assert.match(text, /claude --resume old-b/);
});

test("sessions-acp: argument selects rows", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(i, { title: i === 7 ? "Revert bridge" : `t${i}` }));
  assert.equal(selectRows(rows, "").length, 25);
  assert.equal(selectRows(rows, "", "ses_29")[0].ocSession, "ses_29", "the current session is always shown");
  assert.equal(selectRows(rows, "all").length, 30);
  assert.deepEqual(selectRows(rows, "revert").map((r) => r.ocSession), ["ses_7"]);
  assert.deepEqual(selectRows(rows, "uuid-3").map((r) => r.ocSession), ["ses_3"]);
  assert.equal(resumeCommand({ acpSessionId: "x", cwd: "/a b" }), "cd '/a b' && claude --resume x");
});

test("bridge notices never reach the agent", () => {
  const notice = { role: "user", content: [{ type: "text", text: `${BRIDGE_NOTICE}\n**table**` }] };
  assert.equal(isBridgeNotice(notice), true);
  assert.equal(isBridgeNotice({ role: "user", content: "hola" }), false);
  assert.deepEqual(historyOf([{ role: "system", content: "s" }, { role: "user", content: "hola" }, notice]).length, 1);
});

test("registry: a new Claude session for the same conversation keeps the earlier ones", () => {
  setLink("ses_p", "a", 1);
  setLink("ses_p", "a", 2);
  setLink("ses_p", "b", 3);
  setLink("ses_p", "c", 4);
  assert.deepEqual(getLink("ses_p").previous, ["b", "a"]);
  assert.ok(listLinks().some((l) => l.ocSession === "ses_p"));
});
