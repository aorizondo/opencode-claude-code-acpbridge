// Load-time compatibility checks. The bridge depends on two things it does not ship:
// the OpenCode host (which provides `@opencode/plugin` and `effect` to every plugin, and
// calls the provider through its own AI SDK) and the external `claude-agent-acp` agent.
// When either drifts out of the tested range, say so in the log with what to do,
// instead of failing later with an opaque error.

/** Oldest `@agentclientprotocol/claude-agent-acp` the bridge is tested with: session
 *  fork (smart revert, profile switches), `session/close`, in-place model switching
 *  and prompt queueing all come from it. Also tested with 0.99 (model as a config option). */
export const MIN_AGENT_VERSION = "0.31.0";
/** OpenCode V2 range the plugin supports (matches the `@opencode/plugin` peer range). */
export const MIN_OPENCODE_VERSION = "2.0.14";
export const SUPPORTED_OPENCODE_MAJOR = 2;

function parse(version: string | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1 / 0 / 1, or null when either version is unreadable. */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export function compatibilityWarnings(input: { opencode?: string; agent?: string }): string[] {
  const warnings: string[] = [];
  const host = parse(input.opencode);
  if (host && host[0] !== SUPPORTED_OPENCODE_MAJOR) {
    warnings.push(
      `OpenCode ${input.opencode} is not OpenCode ${SUPPORTED_OPENCODE_MAJOR}.x: this plugin is written for the ` +
        `OpenCode V2 plugin runtime and may not work. Check for a newer opencode-claude-code-acpbridge.`,
    );
  } else if (compareVersions(input.opencode, MIN_OPENCODE_VERSION) === -1) {
    warnings.push(`OpenCode ${input.opencode} is older than ${MIN_OPENCODE_VERSION}, the oldest version supported.`);
  }
  if (compareVersions(input.agent, MIN_AGENT_VERSION) === -1) {
    warnings.push(
      `claude-agent-acp ${input.agent} is older than ${MIN_AGENT_VERSION}, the version this bridge is tested with: ` +
        `session fork (smart revert), session close and in-place model switching may fail. ` +
        `Update it: npm i -g @agentclientprotocol/claude-agent-acp`,
    );
  }
  return warnings;
}

/** A plugin as OpenCode's `plugin.list` reports it (only the fields read here). */
export type ListedPlugin = {
  readonly id: string;
  readonly source?: { readonly type?: string; readonly target?: string; readonly version?: string };
  readonly state?: { readonly status?: string; readonly error?: string };
};

/** The bridge configured twice with different specs (e.g. a remote/organization config
 *  pins one version and the user's own config another). OpenCode V2 keys packages by the
 *  full spec but plugins by id: the first layer to load wins (remote configs load before
 *  the user's) and the other is dropped as "Duplicate plugin ID" — silently, so the user
 *  runs a version they did not choose. Same spec in both layers is fine: one instance,
 *  with the later layer's options. */
export function duplicateWarning(plugins: readonly ListedPlugin[], id: string): string | undefined {
  const ours = plugins.filter((p) => p.id === id && p.source?.type === "package");
  const active = ours.find((p) => p.state?.status === "active");
  const dropped = ours.filter((p) => p.state?.status === "failed" && /duplicate plugin id/i.test(p.state.error ?? ""));
  if (!active || !dropped.length) return undefined;
  const spec = (p: ListedPlugin) => p.source?.target ?? p.id;
  return (
    `${id} is configured more than once with different specs: ${spec(active)} is running and ` +
    `${dropped.map(spec).join(", ")} was ignored (OpenCode keeps the first config layer that loads it; ` +
    `a remote/organization config loads before yours). Use the same spec in every config to pick the version.`
  );
}
