// Load-time compatibility warnings: OpenCode major/minimum and claude-agent-acp minimum.
import { test } from "node:test";
import assert from "node:assert/strict";

const { compatibilityWarnings, compareVersions, duplicateWarning } = await import("../dist/plugin/compat.js");

test("compat: version comparison is numeric and tolerates a v prefix", () => {
  assert.equal(compareVersions("0.31.0", "0.31.0"), 0);
  assert.equal(compareVersions("0.30.9", "0.31.0"), -1);
  assert.equal(compareVersions("0.100.0", "0.31.0"), 1);
  assert.equal(compareVersions("v2.1.1", "2.0.14"), 1);
  assert.equal(compareVersions(undefined, "2.0.14"), null);
});

test("compat: supported OpenCode and agent → no warnings", () => {
  assert.deepEqual(compatibilityWarnings({ opencode: "2.1.1", agent: "0.31.0" }), []);
  assert.deepEqual(compatibilityWarnings({}), []); // unknown versions never warn
});

test("compat: OpenCode 3.x or older than 2.0.14 warns", () => {
  assert.match(compatibilityWarnings({ opencode: "3.0.0" })[0], /not OpenCode 2\.x/);
  assert.match(compatibilityWarnings({ opencode: "2.0.10" })[0], /older than 2\.0\.14/);
});

test("compat: claude-agent-acp older than the tested version warns with the fix", () => {
  const [w] = compatibilityWarnings({ opencode: "2.1.1", agent: "0.29.2" });
  assert.match(w, /0\.29\.2 is older than 0\.31\.0/);
  assert.match(w, /npm i -g @agentclientprotocol\/claude-agent-acp/);
});

// As OpenCode V2's plugin.list reports a remote config pinning one version and the user's
// config another: the first layer loaded runs, the other is dropped by id.
const ID = "opencode-claude-code-acpbridge";
const pkg = (target, status, error) => ({
  id: ID,
  source: { type: "package", target, version: target.split("@").pop() },
  features: { server: true },
  state: error ? { status, error } : { status },
});

test("compat: a dropped duplicate with another spec names both specs and the fix", () => {
  const w = duplicateWarning([
    { id: "opencode.tool.input.repair", source: { type: "builtin" }, state: { status: "active" } },
    pkg(`${ID}@0.11.0`, "active"),
    pkg(`${ID}@0.11.1`, "failed", `Duplicate plugin ID: ${ID}`),
  ], ID);
  assert.match(w, /@0\.11\.0 is running/);
  assert.match(w, /@0\.11\.1 was ignored/);
  assert.match(w, /same spec in every config/);
});

test("compat: one instance, or a failure that is not a duplicate, warns nothing", () => {
  assert.equal(duplicateWarning([pkg(`${ID}@0.11.1`, "active")], ID), undefined);
  assert.equal(duplicateWarning([
    pkg(`${ID}@0.11.0`, "active"),
    pkg(`${ID}@0.11.1`, "failed", "NpmInstallFailedError: No matching version found"),
  ], ID), undefined);
  assert.equal(duplicateWarning([], ID), undefined);
});
