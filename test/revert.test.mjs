// Reverts and unstable history: regression tests for why "drop + new session + full replay"
// kept happening instead of smartRevert (see CHANGELOG).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, opts, run, sys, user, asst, decisions } from "./helpers.mjs";

const { msgKey, userText, firstUserText, anchorsOf, sharedExtent, forkUsesCursor } = await import("../dist/provider/history.js")
  .then(async (h) => ({ ...h, forkUsesCursor: (await import("../dist/provider/model.js")).forkUsesCursor }));
const { getLink } = await import("../dist/plugin/sessions.js");

const SYS = sys("You are the build agent.\n<env>\n  Working directory: /proj\n</env>");
const PAYLOAD_A = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOp";
const PAYLOAD_B = "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_ZyXwVuTsRqPoNmLk";

async function first(agent, model, prompt, o) {
  const r = run(model, opts(prompt, o));
  const ns = await agent.next("newSession");
  const p = await agent.next("prompt", (e) => e.sessionId === ns.sessionId);
  return { r, sid: ns.sessionId, p };
}
async function reply(agent, sid, r, text) {
  await agent.chunk(sid, text);
  agent.endTurn(sid, { stopReason: "end_turn" });
  return r.done;
}
const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
function transcriptDir() {
  const configDir = mkdtempSync(join(tmpdir(), "acp-cfg-"));
  const dir = join(configDir, "projects", slug);
  mkdirSync(dir, { recursive: true });
  return { configDir, dir };
}
const line = (o) => JSON.stringify(o) + "\n";

// ---------------------------------------------------------------- unstable keys

test("keys: a redaction marker re-encrypted every request is the same message", () => {
  const a = user(`mi apikey es [SECRET:jwt:${PAYLOAD_A}] ok`);
  const b = user(`mi apikey es [SECRET:jwt:${PAYLOAD_B}] ok`);
  assert.equal(msgKey(a), msgKey(b));
  assert.equal(userText(a), userText(b));
  assert.equal(firstUserText([a]), firstUserText([b]));
  assert.deepEqual(anchorsOf([a]), anchorsOf([b]));
  // a different pattern, or a different surrounding text, is still a different message
  assert.notEqual(msgKey(a), msgKey(user(`mi apikey es [SECRET:otro:${PAYLOAD_A}] ok`)));
  assert.notEqual(msgKey(a), msgKey(user(`mi apikey es [SECRET:jwt:${PAYLOAD_A}] ko`)));
  // and plain text with brackets is untouched
  assert.notEqual(msgKey(user("[SECRET:x]")), msgKey(user("[SECRET:y]")));
});

test("v2: an old user message whose secret marker changes every turn never forces a drop", async () => {
  const { agent, model, done } = setup({ claudeCode: { historyMode: "v2" } });
  try {
    const t1 = await first(agent, model, [SYS, user(`apikey [SECRET:jwt:${PAYLOAD_A}]`)], { session: "ses_mk" });
    await reply(agent, t1.sid, t1.r, "R1");
    const r2 = run(model, opts([SYS, user(`apikey [SECRET:jwt:${PAYLOAD_B}]`), asst("R1"), user("dos")], { session: "ses_mk" }));
    const p2 = await agent.next("prompt", (e) => /dos/.test(e.text));
    assert.doesNotMatch(p2.text, /apikey/, "the old message is not replayed");
    await reply(agent, t1.sid, r2, "R2");
    const d = await decisions("ses_mk");
    assert.deepEqual(d.map((x) => x.decision), ["new", "reuse"]);
    assert.equal(agent.log.filter((e) => e.type === "newSession").length, 1);
  } finally { done(); }
});

// ---------------------------------------------------------------- fork cut

test("forkUsesCursor: by agent version unless configured", () => {
  assert.equal(forkUsesCursor(undefined, "0.112.0"), true);
  assert.equal(forkUsesCursor("auto", "0.109.0"), true);
  assert.equal(forkUsesCursor(undefined, "0.108.2"), false);
  assert.equal(forkUsesCursor(undefined, "0.101.0"), false);
  assert.equal(forkUsesCursor(undefined, undefined), false);
  assert.equal(forkUsesCursor("cursor", "0.50.0"), true);
  assert.equal(forkUsesCursor("resumeSessionAt", "0.112.0"), false);
});

test("sharedExtent: a revert shares the whole incoming history, a rewritten turn up to it", () => {
  const sent = anchorsOf([user("uno"), asst("R1"), user("dos"), asst("R2")]).map((a) => a.key);
  assert.equal(sharedExtent(sent, [user("uno"), asst("R1")]), 2);
  assert.equal(sharedExtent(sent, [user("uno"), asst("R1"), user("tres")]), 2);
  assert.equal(sharedExtent(sent, [user("otro")]), 0);
});

/** Two turns on a v2 session whose transcript is written the way Claude Code does. */
async function twoTurns(agentInfo, session) {
  const { configDir, dir } = transcriptDir();
  const s = setup({ agent: { agentInfo }, claudeCode: { configDir, historyMode: "v2" } });
  const t1 = await first(s.agent, s.model, [SYS, user("uno")], { session });
  await reply(s.agent, t1.sid, t1.r, "R1");
  const file = join(dir, `${t1.sid}.jsonl`);
  writeFileSync(file, line({ type: "user", uuid: "u-0", message: { role: "user", content: [{ type: "text", text: "uno" }] } })
    + line({ type: "assistant", uuid: "a-1" }));
  const r2 = run(s.model, opts([SYS, user("uno"), asst("R1"), user("dos")], { session }));
  await s.agent.next("prompt", (e) => /dos/.test(e.text));
  // what Claude Code wrote for turn 2 (tool results and sidechains in between are not prompts)
  appendFileSync(file, line({ type: "attachment", uuid: "att-1" })
    + line({ type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "dos" }] } })
    + line({ type: "assistant", uuid: "a-2" })
    + line({ type: "user", uuid: "tr-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] } }));
  await reply(s.agent, t1.sid, r2, "R2");
  return { ...s, sid: t1.sid, configDir, file };
}

test("smartRevert (agent ≥ 0.109): forks by cursor before the reverted prompt, in v2, nothing replayed", async () => {
  const s = await twoTurns({ name: "claude-agent-acp", version: "0.112.0" }, "ses_cur");
  try {
    const r3 = run(s.model, opts([SYS, user("uno"), asst("R1"), user("tres")], { session: "ses_cur" }));
    const fk = await s.agent.next("forked");
    const fs = s.agent.log.find((e) => e.type === "forkSession");
    const raw = s.agent.log.find((e) => e.type === "forkRaw").params;
    assert.equal(raw.sessionId, s.sid);
    assert.equal(raw.cursorId, "before:u-1", "the first prompt after the checkpoint, not the tool result");
    assert.equal(fs.meta.claudeCode.options.resumeSessionAt, undefined, "a source uuid does not exist in a fork with fresh uuids");
    const p3 = await s.agent.next("prompt", (e) => e.sessionId === fk.sessionId);
    assert.equal(p3.text.trim(), "tres");
    assert.equal(s.agent.log.filter((e) => e.type === "newSession").length, 1);
    await reply(s.agent, fk.sessionId, r3, "R3");
    const d = await decisions("ses_cur");
    assert.ok(d.some((x) => x.decision === "smart-revert" && x.at === 2));
  } finally { s.done(); }
});

test("smartRevert (older agent): still cuts with resumeSessionAt", async () => {
  const s = await twoTurns({ name: "claude-agent-acp", version: "0.101.0" }, "ses_old");
  try {
    const r3 = run(s.model, opts([SYS, user("uno"), asst("R1"), user("tres")], { session: "ses_old" }));
    await s.agent.next("forked");
    const fs = s.agent.log.find((e) => e.type === "forkSession");
    assert.equal(fs.meta.claudeCode.options.resumeSessionAt, "a-1");
    assert.equal(s.agent.log.find((e) => e.type === "forkRaw").params.cursorId, undefined);
    const p3 = await s.agent.next("prompt", (e) => /tres/.test(e.text));
    await reply(s.agent, p3.sessionId, r3, "R3");
  } finally { s.done(); }
});

test("smartRevert: a pure revert (history shorter) rewinds to the turn that was dropped", async () => {
  const s = await twoTurns({ name: "claude-agent-acp", version: "0.112.0" }, "ses_pure");
  try {
    const r3 = run(s.model, opts([SYS, user("uno"), asst("R1")], { session: "ses_pure" }));
    const fk = await s.agent.next("forked");
    assert.equal(s.agent.log.find((e) => e.type === "forkRaw").params.cursorId, "before:u-1");
    assert.equal(s.agent.log.filter((e) => e.type === "newSession").length, 1);
    // nothing new to say: the turn still has to close
    await s.agent.next("prompt", (e) => e.sessionId === fk.sessionId);
    await reply(s.agent, fk.sessionId, r3, "ok");
  } finally { s.done(); }
});

// ---------------------------------------------------------------- across processes

test("registry: links carry the history proof and the rewind points", async () => {
  const s = await twoTurns({ name: "claude-agent-acp", version: "0.112.0" }, "ses_reg");
  try {
    const link = getLink("ses_reg");
    assert.match(link.sentHash, /^\d+:/);
    assert.deepEqual(link.checkpoints.map((c) => ({ at: c.at, uuid: c.uuid, sid: c.sid })), [{ at: 2, uuid: "a-1", sid: s.sid }]);
    assert.ok(link.checkpoints[0].h);
  } finally { s.done(); }
});

/** Provider options the plugin builds from the registry on a fresh process. */
function fromLink(ocSession) {
  const l = getLink(ocSession);
  return {
    resumeId: l.acpSessionId, resumeLen: l.sentHistoryLen, resumeConvKey: l.convKey, resumeIdPrefixes: l.idPrefixes, resumeCwd: l.cwd,
    resumeSentHash: l.sentHash, resumeCheckpoints: l.checkpoints,
  };
}

test("after a restart: a revert forks the registered session at the verified rewind point", async () => {
  const s = await twoTurns({ name: "claude-agent-acp", version: "0.112.0" }, "ses_rs");
  const extra = fromLink("ses_rs");
  s.done(); // the process (and its live sessions) is gone; the registry and the transcript remain
  const n = setup({ agent: { agentInfo: { name: "claude-agent-acp", version: "0.112.0" } }, claudeCode: { configDir: s.configDir, historyMode: "v2" } });
  try {
    const r = run(n.model, opts([SYS, user("uno"), asst("R1"), user("tres")], { session: "ses_rs", extra }));
    const fk = await n.agent.next("forked");
    const raw = n.agent.log.find((e) => e.type === "forkRaw").params;
    assert.equal(raw.sessionId, s.sid);
    assert.equal(raw.cursorId, "before:u-1");
    const p = await n.agent.next("prompt", (e) => e.sessionId === fk.sessionId);
    assert.match(p.text, /tres$/);
    assert.doesNotMatch(p.text, /uno|R1|dos/, "only the new message (plus the session context), no replay");
    assert.equal(n.agent.log.filter((e) => e.type === "newSession").length, 0);
    await reply(n.agent, fk.sessionId, r, "R3");
    const d = (await decisions("ses_rs")).filter((x) => x.decision === "smart-revert");
    assert.equal(d.at(-1).source, "registry");
    // the registry now follows the fork
    assert.equal(getLink("ses_rs").acpSessionId, fk.sessionId);
  } finally { n.done(); }
});

test("after a restart: an unrewound history still resumes without replay", async () => {
  const s = await twoTurns({ name: "claude-agent-acp", version: "0.112.0" }, "ses_rr");
  const extra = fromLink("ses_rr");
  s.done();
  const n = setup({ agent: { agentInfo: { name: "claude-agent-acp", version: "0.112.0" } }, claudeCode: { configDir: s.configDir, historyMode: "v2" } });
  try {
    const r = run(n.model, opts([SYS, user("uno"), asst("R1"), user("dos"), asst("R2"), user("tres")], { session: "ses_rr", extra }));
    const rs = await n.agent.next("resumeSession");
    assert.equal(rs.sessionId, s.sid);
    const p = await n.agent.next("prompt", (e) => e.sessionId === s.sid);
    assert.match(p.text, /tres/);
    assert.doesNotMatch(p.text, /uno|dos/);
    await reply(n.agent, s.sid, r, "R3");
    assert.equal(n.agent.log.filter((e) => e.type === "forkSession" || e.type === "newSession").length, 0);
  } finally { n.done(); }
});

test("after a restart: a rewound history with no verifiable rewind point starts a new session", async () => {
  const s = await twoTurns({ name: "claude-agent-acp", version: "0.112.0" }, "ses_rn");
  const extra = { ...fromLink("ses_rn"), resumeCheckpoints: [] };
  s.done();
  const n = setup({ agent: { agentInfo: { name: "claude-agent-acp", version: "0.112.0" } }, claudeCode: { configDir: s.configDir, historyMode: "v2" } });
  try {
    const r = run(n.model, opts([SYS, user("uno"), asst("R1"), user("tres")], { session: "ses_rn", extra }));
    const ns = await n.agent.next("newSession");
    const p = await n.agent.next("prompt", (e) => e.sessionId === ns.sessionId);
    assert.match(p.text, /uno/);
    await reply(n.agent, ns.sessionId, r, "R3");
  } finally { n.done(); }
});

// ---------------------------------------------------------------- split replay

test("split replay: a big replay goes as a hidden context-only turn, so reverting its prompt forks", async () => {
  const { configDir, dir } = transcriptDir();
  const s = setup({ agent: { agentInfo: { name: "claude-agent-acp", version: "0.112.0" } }, claudeCode: { configDir, historyMode: "v2" } });
  try {
    const big = "x".repeat(30_000);
    const hist = [SYS, user(`uno ${big}`), asst("R1"), user("dos"), asst("R2")];
    const r = run(s.model, opts([...hist, user("tres")], { session: "ses_split" }));
    const ns = await s.agent.next("newSession");
    const p1 = await s.agent.next("prompt", (e) => e.sessionId === ns.sessionId);
    assert.match(p1.text, /Reply with exactly: OK/);
    assert.match(p1.text, /dos/);
    assert.doesNotMatch(p1.text, /tres/, "the prompt is not part of the context-only turn");
    const file = join(dir, `${ns.sessionId}.jsonl`);
    writeFileSync(file, line({ type: "user", uuid: "u-replay", message: { role: "user", content: [{ type: "text", text: "history" }] } })
      + line({ type: "assistant", uuid: "a-ok" }));
    await s.agent.chunk(ns.sessionId, "OK");
    s.agent.endTurn(ns.sessionId, { stopReason: "end_turn" });
    const p2 = await s.agent.next("prompt", (e) => e.sessionId === ns.sessionId && /tres/.test(e.text));
    assert.doesNotMatch(p2.text, /dos|Reply with exactly/);
    appendFileSync(file, line({ type: "user", uuid: "u-tres", message: { role: "user", content: [{ type: "text", text: "tres" }] } })
      + line({ type: "assistant", uuid: "a-3" }));
    await s.agent.chunk(ns.sessionId, "R3");
    s.agent.endTurn(ns.sessionId, { stopReason: "end_turn" });
    const out = await r.done;
    assert.doesNotMatch(JSON.stringify(out), /"OK"/, "the context-only answer is hidden");
    const cps = getLink("ses_split").checkpoints;
    assert.deepEqual(cps.map((c) => ({ at: c.at, uuid: c.uuid })), [{ at: 4, uuid: "a-ok" }]);
    // the user reverts "tres" and writes something else: fork right before it, no replay
    const r2 = run(s.model, opts([...hist, user("cuatro")], { session: "ses_split" }));
    const fk = await s.agent.next("forked");
    assert.equal(s.agent.log.find((e) => e.type === "forkRaw").params.cursorId, "before:u-tres");
    const p3 = await s.agent.next("prompt", (e) => e.sessionId === fk.sessionId);
    assert.equal(p3.text.trim(), "cuatro");
    assert.equal(s.agent.log.filter((e) => e.type === "newSession").length, 1);
    await reply(s.agent, fk.sessionId, r2, "R4");
    const d = await decisions("ses_split");
    assert.ok(d.some((x) => x.decision === "new" && x.split === 4));
    assert.ok(d.some((x) => x.decision === "smart-revert" && x.at === 4));
  } finally { s.done(); }
});

// ---------------------------------------------------------------- self compaction

test("selfCompact: a turn that ends past autoCompactPct gets a hidden /compact before the next one", async () => {
  const { agent, model, done } = setup({ claudeCode: { historyMode: "v2", autoCompactPct: 30 } });
  try {
    const t1 = await first(agent, model, [SYS, user("uno")], { session: "ses_sc" });
    agent.usage(t1.sid, 40_000, 100_000); // 40 % > 30 % → compacts
    await reply(agent, t1.sid, t1.r, "R1");
    const c = await agent.next("prompt", (e) => e.sessionId === t1.sid && e.text.trim() === "/compact");
    assert.ok(c);
    await agent.chunk(t1.sid, "Compacted.");
    agent.usage(t1.sid, 5_000, 100_000);
    agent.endTurn(t1.sid, { stopReason: "end_turn" });
    const r2 = run(model, opts([SYS, user("uno"), asst("R1"), user("dos")], { session: "ses_sc" }));
    const p2 = await agent.next("prompt", (e) => /dos/.test(e.text));
    await reply(agent, t1.sid, r2, "R2");
    assert.doesNotMatch(JSON.stringify(await r2.done), /Compacted/, "the /compact output is hidden");
    assert.equal(agent.log.filter((e) => e.type === "prompt" && e.text.trim() === "/compact").length, 1);
    assert.ok(p2);
  } finally { done(); }
});

test("selfCompact: under the threshold nothing happens", async () => {
  const { agent, model, done } = setup({ claudeCode: { historyMode: "v2", autoCompactPct: 30 } });
  try {
    const t1 = await first(agent, model, [SYS, user("uno")], { session: "ses_sc2" });
    agent.usage(t1.sid, 20_000, 100_000);
    await reply(agent, t1.sid, t1.r, "R1");
    assert.equal(await agent.none("prompt", 400), null, "no /compact");
  } finally { done(); }
});

test("bridge notice: a turn woken only by it is answered empty, without the agent", async () => {
  const { agent, model, done } = setup({ claudeCode: { historyMode: "v2" } });
  try {
    const notice = user("<!-- acp-notice -->\n**table**");
    const r = run(model, opts([SYS, user("uno"), asst("R1"), notice], { session: "ses_nt" }));
    await r.done;
    assert.equal(await agent.none("newSession", 300), null);
    assert.equal(agent.log.filter((e) => e.type === "prompt").length, 0);
  } finally { done(); }
});

test("bridge notice: the table comes back as the turn's text, and both messages stay out of the history", async () => {
  const { agent, model, done } = setup({ claudeCode: { historyMode: "v2" } });
  try {
    const table = "<!-- acp-notice -->\n**table**";
    const r = run(model, opts([SYS, user("uno"), user(table)], { session: "ses_nt2" }));
    const out = await r.done;
    assert.match(JSON.stringify(out), /\*\*table\*\*/);
    const t1 = run(model, opts([SYS, user("uno"), user(table), asst(table), user("dos")], { session: "ses_nt2" }));
    const p = await agent.next("prompt");
    assert.doesNotMatch(p.text, /table/);
    await reply(agent, p.sessionId, t1, "R");
  } finally { done(); }
});
