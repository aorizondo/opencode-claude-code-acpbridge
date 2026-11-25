// Claude Code's memory directory: only `ask` → `allow`, only `external_directory`, only for
// the Claude Code agents, and only when every requested path is in a project's memory dir.
import { test } from "node:test";
import assert from "node:assert/strict";

const { applyMemoryAccess, insideMemory, claudeConfigRoot } = await import("../dist/plugin/memory-access.js");

const ROOT = "/home/u/.claude";
const claude = (agent) => agent.startsWith("claude-");
const run = (agent, action, resources, effect = "ask") => {
  const event = { agent, action, resources, effect };
  applyMemoryAccess(event, ROOT, claude);
  return event.effect;
};

test("memory: a project's memory directory and below", () => {
  assert.ok(insideMemory("/home/u/.claude/projects/-home-u-repo/memory/*", ROOT));
  assert.ok(insideMemory("/home/u/.claude/projects/-home-u-repo/memory", ROOT));
  assert.ok(insideMemory("/home/u/.claude/projects/-home-u-repo/memory/sub/*", ROOT));
  // the transcripts next to it, other config, `..` escapes: no
  assert.ok(!insideMemory("/home/u/.claude/projects/-home-u-repo/*", ROOT));
  assert.ok(!insideMemory("/home/u/.claude/*", ROOT));
  assert.ok(!insideMemory("/home/u/.claude/projects/-home-u-repo/memory/../../*", ROOT));
  assert.ok(!insideMemory("/home/u/.claude-other/projects/x/memory/*", ROOT));
});

test("memory: ask → allow for a Claude Code agent, nothing else changes", () => {
  const mem = ["/home/u/.claude/projects/-home-u-repo/memory/*"];
  assert.equal(run("claude-default", "external_directory", mem), "allow");
  assert.equal(run("build", "external_directory", mem), "ask");
  assert.equal(run("claude-default", "external_directory", mem, "deny"), "deny");
  assert.equal(run("claude-default", "external_directory", [...mem, "/etc/*"]), "ask");
  assert.equal(run("claude-default", "edit", mem), "ask");
  assert.equal(run(undefined, "external_directory", mem), "ask");
});

test("memory: the root follows configDir", () => {
  assert.equal(claudeConfigRoot({ configDir: "/data/claude/" }), "/data/claude");
});
