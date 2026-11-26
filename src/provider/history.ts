// History fingerprinting: how the provider decides what the ACP agent already knows.
//
// OpenCode resends the FULL prompt on every doStream; the ACP session is stateful and
// sequential. Each non-system message gets a cheap key; comparing the keys already
// sent with the incoming ones tells a normal append from a revert or a divergence.
// This logic has broken before (CHANGELOG 0.8.0, 9299af9): change it only together
// with the fixtures in test/fixtures/v2, which are real OpenCode V2 prompts.
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

type Prompt = LanguageModelV3CallOptions["prompt"];

export type HistoryKind = "append" | "revert" | "diverged";

export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Text of the first user message — stable identifier for the conversation. Tags other
 *  plugins inject (DCP) are not part of it: they come and go between requests. */
export function firstUserText(prompt: Prompt): string {
  for (const m of prompt) {
    if (m.role !== "user") continue;
    if (typeof (m as any).content === "string") return keyText(stripInjected((m as any).content)).trim();
    return keyText(stripInjected(((m as any).content as any[]).filter((p) => p.type === "text").map((p) => p.text).join(""))).trim();
  }
  return "";
}

/** Redaction markers (opencode-apex: `[SECRET:<pattern>:<base64url(iv||tag||ciphertext)>]`).
 *  The IV is random, so the SAME secret in the SAME old message is re-encrypted into a
 *  different marker on every request: the message looked different every turn and the
 *  history "diverged" at it each time (new session + full replay). Only the pattern name
 *  is stable, and it is all the fingerprint needs. Used for KEYS only — the text that
 *  reaches the agent keeps its marker. */
const SECRET_MARKER = /\[SECRET:([A-Za-z0-9_.-]+):[A-Za-z0-9_-]{16,}\]/g;

/** Text as the fingerprints see it: unstable decorations normalized away. */
export function keyText(text: string): string {
  return text.includes("[SECRET:") ? text.replace(SECRET_MARKER, "[SECRET:$1]") : text;
}

/** The conversation proper: system messages are excluded because they're forwarded
 *  separately (or not at all) and OpenCode rewrites them every turn — including them
 *  would make every history comparison look like a divergence. */
export function historyOf(prompt: Prompt): any[] {
  return (prompt as any[]).filter((m) => m.role !== "system" && !isBridgeNotice(m));
}

/** Marker opening the messages the bridge itself posts in a session for the USER (e.g. the
 *  `/sessions-acp` table). An HTML comment: invisible once the markdown is rendered. */
export const BRIDGE_NOTICE = "<!-- acp-notice -->";

/** The prompt's latest message (system ones aside) is a bridge notice: nothing for the agent. */
export function endsWithBridgeNotice(prompt: Prompt): boolean {
  const msgs = (prompt as any[]).filter((m) => m.role !== "system");
  return msgs.length > 0 && isBridgeNotice(msgs[msgs.length - 1]);
}

/** A message the bridge posted for the user: never part of the conversation with the agent. */
export function isBridgeNotice(msg: any): boolean {
  if (msg?.role !== "user") return false;
  const c = msg.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((p: any) => p?.type === "text")?.text : undefined;
  return typeof text === "string" && text.trimStart().startsWith(BRIDGE_NOTICE);
}

/** Cheap, stable per-message identity. Deliberately keyed on tool-call IDs rather
 *  than payloads: it must survive re-serialization but change if the turn changes. */
export function msgKey(msg: any): string {
  let body = "";
  if (typeof msg.content === "string") body = keyText(msg.content);
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p?.type === "text") body += `t:${keyText(String(p.text ?? ""))}`;
      else if (p?.type === "tool-call") body += `c:${p.toolCallId}`;
      else if (p?.type === "tool-result") body += `r:${p.toolCallId}`;
      else if (p?.type === "file") body += `f:${p.filename ?? p.mediaType ?? ""}`;
      else body += `?${p?.type}`;
    }
  }
  return `${msg.role}:${hashText(body)}`;
}

/** How the incoming history relates to what the agent already knows.
 *   - append   → normal turn (or another agent ran turns meanwhile): send the tail.
 *   - revert   → the user rewound: the agent can't unremember, so it needs a new session.
 *   - diverged → compaction/rollback replaced the middle: same, a new session. */
export function classifyHistory(sent: readonly string[], keys: readonly string[]): { kind: HistoryKind; fromIndex: number } {
  let i = 0;
  while (i < sent.length && i < keys.length && sent[i] === keys[i]) i++;
  if (i === sent.length) return { kind: "append", fromIndex: i };
  // Prefijo estricto = revert SOLO si incoming es más corto; si son iguales no hay
  // mensajes nuevos → append desde el final (evita falsos revert).
  if (i === keys.length) return keys.length < sent.length
    ? { kind: "revert", fromIndex: i }
    : { kind: "append", fromIndex: keys.length };
  return { kind: "diverged", fromIndex: i };
}

export function systemText(prompt: Prompt): string {
  const parts: string[] = [];
  for (const m of prompt) {
    if (m.role !== "system") continue;
    parts.push(
      typeof (m as any).content === "string"
        ? (m as any).content
        : ((m as any).content as any[]).filter((p) => p.type === "text").map((p) => p.text).join(""),
    );
  }
  return parts.join("\n").trim();
}

// ---- anchor fingerprint (historyMode "shadow" | "v2") -----------------------------
//
// The legacy key hashes every part of every message. OpenCode V2 re-renders OLD
// assistant messages in ways that don't change the conversation — reasoning dropped or
// turned into text after a model switch or an error, providerOptions stripped — and other
// plugins tag message text (DCP). Each of those looked like a divergence → new session +
// cold replay. Anchors keep only what identifies the conversation: what the USER wrote
// and the ids of every tool round-trip. Assistant prose is left out; whether the agent
// already has it is decided separately (own-output detection).

/** Tags other plugins inject into message text (DCP's ids and nudges). */
const INJECTED_TAGS = /<(dcp-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/g;
/** What V2 puts in place of an old image once the request exceeds its media budget. */
const IMAGE_REMOVED = /^\[This image was removed to reduce the request size[^\]]*\]$/;

export function stripInjected(text: string): string {
  return text.replace(INJECTED_TAGS, "");
}

/** A user message that only carries a `<system-reminder>`: V2's plan plugin inserts one
 *  for a single request and persists a copy that lands later — it moves around, so it
 *  can't be part of the identity of the history. */
export function isTransient(msg: any): boolean {
  if (msg?.role !== "user") return false;
  const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  const text = parts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("").trim();
  return parts.every((p: any) => p?.type === "text") && /^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text);
}

/** Normalized text of a user message (injected tags and V2's media placeholders out). */
export function userText(msg: any): string {
  const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  return parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => keyText(stripInjected(String(p.text ?? ""))).trim())
    .filter((t: string) => t && !IMAGE_REMOVED.test(t))
    .join("\n");
}

export interface Anchor {
  key: string;
  /** Index, in the non-system history, of the message the anchor comes from. */
  at: number;
}

export function anchorsOf(hist: readonly any[]): Anchor[] {
  const out: Anchor[] = [];
  hist.forEach((m, at) => {
    if (m.role === "user") {
      if (!isTransient(m)) out.push({ key: `u:${hashText(userText(m))}`, at });
      return;
    }
    if (!Array.isArray(m.content)) return;
    for (const p of m.content) {
      if (p?.type === "tool-call") out.push({ key: `c:${p.toolCallId}`, at });
      else if (p?.type === "tool-result") out.push({ key: `r:${p.toolCallId}`, at });
    }
  });
  return out;
}

/** `classifyHistory` over anchors. `fromIndex` is a MESSAGE index: the tail starts after
 *  the message of the last anchor already known. */
export function classifyAnchors(sent: readonly string[], incoming: readonly Anchor[]): { kind: HistoryKind; fromIndex: number } {
  let i = 0;
  while (i < sent.length && i < incoming.length && sent[i] === incoming[i].key) i++;
  const after = i > 0 ? incoming[i - 1].at + 1 : 0;
  if (i === sent.length) return { kind: "append", fromIndex: after };
  if (i === incoming.length) return incoming.length < sent.length
    ? { kind: "revert", fromIndex: after }
    : { kind: "append", fromIndex: after };
  return { kind: "diverged", fromIndex: after };
}

/** Identity of a list of anchor keys, comparable across processes (the registry stores it). */
export function anchorsHash(keys: readonly string[]): string {
  return `${keys.length}:${hashText(keys.join("|"))}`;
}

/** Hash of the anchors of `hist.slice(0, len)`. */
export function prefixHash(hist: readonly any[], len: number): string {
  return anchorsHash(anchorsOf(hist.slice(0, len)).map((a) => a.key));
}

/** How much of `hist` (a message count) is certainly the conversation the agent already
 *  has: everything before the first anchor that differs. For a pure revert that is the whole
 *  incoming history. Unlike the legacy per-message keys it does not move when an old
 *  assistant message is re-rendered, so it is the right fork-point reference. */
export function sharedExtent(sent: readonly string[], hist: readonly any[]): number {
  const incoming = anchorsOf(hist);
  let i = 0;
  while (i < sent.length && i < incoming.length && sent[i] === incoming[i].key) i++;
  return i === incoming.length ? hist.length : incoming[i].at;
}

/** A point of the agent's session the conversation can be rewound to. `at` is the index (in
 *  the non-system history) of the message that opened the turn that FOLLOWS the point, `uuid`
 *  the last transcript entry before that turn, `sid` the agent session whose transcript holds
 *  that uuid (forks get fresh uuids, so a point stays tied to the session it was taken in),
 *  `h` the anchors hash of `hist.slice(0, at)` (verifies the point from another process). */
export interface Checkpoint {
  at: number;
  uuid: string;
  sid: string;
  h?: string;
}

/** The latest checkpoint at or before `extent`. */
export function pickCheckpoint(cps: readonly Checkpoint[], extent: number): Checkpoint | undefined {
  let best: Checkpoint | undefined;
  for (const c of cps) if (c.at <= extent && (!best || c.at > best.at)) best = c;
  return best;
}

/** The latest checkpoint whose recorded prefix hash still matches the incoming history — what
 *  lets a process that never saw the turns (restart, idle eviction) rewind to a revert point. */
export function verifiedCheckpoint(cps: readonly Checkpoint[], hist: readonly any[]): Checkpoint | undefined {
  const anchors = anchorsOf(hist);
  const sorted = [...cps].filter((c) => c.h && c.at <= hist.length).sort((a, b) => b.at - a.at);
  for (const c of sorted) {
    const n = anchors.filter((a) => a.at < c.at).length;
    if (anchorsHash(anchors.slice(0, n).map((a) => a.key)) === c.h) return c;
  }
  return undefined;
}
