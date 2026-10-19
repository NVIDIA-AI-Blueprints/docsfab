// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DocsFab's own conversational state for a hosted live-agent turn.
 *
 * The harness's on-disk session file cannot serve a hosted turn: it resumes by
 * repository path, a hosted job gets a fresh worktree and a private empty state
 * directory every attempt, and a vendor transcript format must not become a
 * durable DocsFab contract.
 *
 * This record is bounded, canonical, self-digesting, and bound to the project,
 * epoch, principal, thread, scope, and tool policy of the conversation. The
 * revision is carried, not bound: each turn runs at the mirror's current
 * head, and the session moves with it. The worker never reaches a content
 * store: the host passes prior state inside the frozen turn input, and the
 * worker re-verifies the digest before any prior word reaches the model.
 *
 * The window is capped and overflow evicted because the local agent disables
 * compaction, and a channel thread cannot escape an overlong context by
 * starting a new session.
 */
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { HOSTED_INPUT_CAPACITY } from "./input-capacity.js";

export const LIVE_AGENT_SESSION_STATE_KIND = "docsfab-live-agent-session-state" as const;

/** Exchanges replayed into the next turn. The 7th exchange evicts the 1st. */
export const LIVE_AGENT_SESSION_WINDOW_EXCHANGES = 6;
/** Serialized ceiling for the replayed window, well inside the 96 KiB frozen-input cap. */
export const LIVE_AGENT_SESSION_WINDOW_BYTES = 32 * 1024;
export const LIVE_AGENT_QUESTION_MAX_BYTES = HOSTED_INPUT_CAPACITY.questionBytes;

export type LiveAgentSessionRefusalCode =
  | "session-state-shape"
  | "session-state-digest-mismatch"
  | "session-state-deployment-mismatch"
  | "session-state-project-mismatch"
  | "session-state-epoch-mismatch"
  | "session-state-principal-mismatch"
  | "session-state-thread-mismatch"
  | "session-state-scope-mismatch"
  | "session-state-policy-mismatch"
  | "session-state-window-overflow";

export class LiveAgentSessionStateError extends Error {
  readonly code: LiveAgentSessionRefusalCode;
  constructor(code: LiveAgentSessionRefusalCode) {
    super(`Hosted live-agent session rejected: ${code}.`);
    this.name = "LiveAgentSessionStateError";
    this.code = code;
  }
}

export interface LiveAgentCitationV1 {
  readonly path: string;
  readonly revision: string;
}

export interface LiveAgentExchangeV1 {
  readonly turnIndex: number;
  readonly requestKey: string;
  readonly question: string;
  readonly answer: string;
  readonly answerSha256: string;
  readonly citations: readonly LiveAgentCitationV1[];
}

/** Everything a later turn must agree with before it may replay a single word. */
export interface LiveAgentSessionBindingV1 {
  readonly deploymentId: string;
  readonly projectId: string;
  readonly deploymentEpoch: string;
  readonly principalId: string;
  readonly threadBindingSha256: string;
}

export interface LiveAgentSessionStateV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof LIVE_AGENT_SESSION_STATE_KIND;
  readonly sessionId: string;
  readonly binding: LiveAgentSessionBindingV1;
  readonly revision: string;
  readonly scopeSha256: string;
  readonly compositionId: string;
  readonly toolPolicySha256: string;
  /** Exchanges conducted in this session, including those evicted from the window. */
  readonly turns: number;
  /** Exchanges dropped from the head of the window. */
  readonly evicted: number;
  readonly exchanges: readonly LiveAgentExchangeV1[];
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** Repository-relative, no absolute root, no traversal, no control bytes. */
const CITATION_PATH = /^(?!\/|~)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\u0000-\u001f\u007f]{1,512}$/u;

/**
 * The session id the host mints and the runtime must accept.
 *
 * Host ids look like `live-agent-session:<sha256>`, so the rule admits a colon.
 * The turn payload and session state parsers share this one rule so they
 * cannot disagree with each other or with the host.
 */
export const LIVE_AGENT_SESSION_ID = SAFE_ID;

/**
 * C0 and C1 controls except tab, line feed, and carriage return: the host's
 * rule for text it posts. The session state refuses NUL on resume and the host
 * refuses the rest before posting, so they are stripped where the answer is
 * minted rather than persisted into an unpostable or unresumable state.
 */
export const LIVE_AGENT_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function fail(code: LiveAgentSessionRefusalCode): never {
  throw new LiveAgentSessionStateError(code);
}

function shape(condition: unknown): asserts condition {
  if (!condition) fail("session-state-shape");
}

function plainObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  shape(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
  const root = value as Record<string, unknown>;
  const actual = Object.keys(root).sort();
  shape(JSON.stringify(actual) === JSON.stringify([...keys].sort()));
  return root;
}

function text(value: unknown, maximumBytes: number): string {
  shape(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= maximumBytes &&
      !value.includes("\0") &&
      value.normalize("NFC") === value,
  );
  return value as string;
}

function matching(value: unknown, pattern: RegExp): string {
  shape(typeof value === "string" && pattern.test(value));
  return value as string;
}

/** The digest a session row records and the next turn must present. */
export function liveAgentSessionStateDigest(state: LiveAgentSessionStateV1): string {
  return sha256(canonicalJson(state));
}

function parseCitation(value: unknown): LiveAgentCitationV1 {
  const root = plainObject(value, ["path", "revision"]);
  return Object.freeze({
    path: matching(root.path, CITATION_PATH),
    revision: matching(root.revision, OBJECT_ID),
  });
}

function parseExchange(value: unknown): LiveAgentExchangeV1 {
  const root = plainObject(value, [
    "turnIndex",
    "requestKey",
    "question",
    "answer",
    "answerSha256",
    "citations",
  ]);
  shape(Number.isSafeInteger(root.turnIndex) && (root.turnIndex as number) >= 1);
  shape(Array.isArray(root.citations));
  const answer = text(root.answer, LIVE_AGENT_SESSION_WINDOW_BYTES);
  const answerSha256 = matching(root.answerSha256, SHA);
  // The answer digest is recomputed rather than trusted, so a state blob whose
  // prose was edited after the fact cannot be replayed as if the model said it.
  if (sha256(answer) !== answerSha256) fail("session-state-digest-mismatch");
  return Object.freeze({
    turnIndex: root.turnIndex as number,
    requestKey: matching(root.requestKey, SAFE_ID),
    question: text(root.question, LIVE_AGENT_QUESTION_MAX_BYTES),
    answer,
    answerSha256,
    citations: Object.freeze((root.citations as unknown[]).map(parseCitation)),
  });
}

/**
 * Re-validate a session state that arrived from outside this process. The
 * caller has already checked the presented digest; this checks the body.
 */
export function parseLiveAgentSessionState(value: unknown): LiveAgentSessionStateV1 {
  const root = plainObject(value, [
    "schemaVersion",
    "kind",
    "sessionId",
    "binding",
    "revision",
    "scopeSha256",
    "compositionId",
    "toolPolicySha256",
    "turns",
    "evicted",
    "exchanges",
  ]);
  shape(root.schemaVersion === 1 && root.kind === LIVE_AGENT_SESSION_STATE_KIND);
  const binding = plainObject(root.binding, [
    "deploymentId",
    "projectId",
    "deploymentEpoch",
    "principalId",
    "threadBindingSha256",
  ]);
  shape(Array.isArray(root.exchanges));
  const exchanges = (root.exchanges as unknown[]).map(parseExchange);
  shape(exchanges.length <= LIVE_AGENT_SESSION_WINDOW_EXCHANGES);
  shape(Number.isSafeInteger(root.turns) && (root.turns as number) >= exchanges.length);
  shape(Number.isSafeInteger(root.evicted) && (root.evicted as number) >= 0);
  shape((root.turns as number) - (root.evicted as number) === exchanges.length);
  for (const [index, exchange] of exchanges.entries()) {
    const expected = (root.evicted as number) + index + 1;
    shape(exchange.turnIndex === expected);
  }
  const state: LiveAgentSessionStateV1 = Object.freeze({
    schemaVersion: 1,
    kind: LIVE_AGENT_SESSION_STATE_KIND,
    sessionId: matching(root.sessionId, LIVE_AGENT_SESSION_ID),
    binding: Object.freeze({
      deploymentId: matching(binding.deploymentId, SAFE_SEGMENT),
      projectId: matching(binding.projectId, SAFE_SEGMENT),
      deploymentEpoch: matching(binding.deploymentEpoch, SAFE_SEGMENT),
      principalId: matching(binding.principalId, SAFE_ID),
      threadBindingSha256: matching(binding.threadBindingSha256, SHA),
    }),
    revision: matching(root.revision, OBJECT_ID),
    scopeSha256: matching(root.scopeSha256, SHA),
    compositionId: matching(root.compositionId, SAFE_ID),
    toolPolicySha256: matching(root.toolPolicySha256, SHA),
    turns: root.turns as number,
    evicted: root.evicted as number,
    exchanges: Object.freeze(exchanges),
  });
  if (Buffer.byteLength(canonicalJson(state)) > LIVE_AGENT_SESSION_WINDOW_BYTES) {
    fail("session-state-window-overflow");
  }
  return state;
}

/** A session state's first turn: no prior exchanges, bindings taken from the request. */
export function openLiveAgentSession(input: {
  sessionId: string;
  binding: LiveAgentSessionBindingV1;
  revision: string;
  scopeSha256: string;
  compositionId: string;
  toolPolicySha256: string;
}): LiveAgentSessionStateV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: LIVE_AGENT_SESSION_STATE_KIND,
    sessionId: input.sessionId,
    binding: Object.freeze({ ...input.binding }),
    revision: input.revision,
    scopeSha256: input.scopeSha256,
    compositionId: input.compositionId,
    toolPolicySha256: input.toolPolicySha256,
    turns: 0,
    evicted: 0,
    exchanges: Object.freeze([]),
  });
}

/**
 * Append one exchange and bound the window.
 *
 * The count bound comes first, then the byte bound, which is the one that
 * protects the frozen-input budget. Eviction is whole exchanges from the head,
 * even the newest when it cannot fit, and `evicted` keeps `turnIndex` meaning
 * the Nth question in the thread. Delivery keeps the complete answer on the
 * turn record.
 */
export function appendLiveAgentExchange(
  state: LiveAgentSessionStateV1,
  exchange: Omit<LiveAgentExchangeV1, "turnIndex" | "answerSha256">,
): LiveAgentSessionStateV1 {
  const turns = state.turns + 1;
  const appended: LiveAgentExchangeV1 = Object.freeze({
    turnIndex: turns,
    requestKey: exchange.requestKey,
    question: exchange.question,
    answer: exchange.answer,
    answerSha256: sha256(exchange.answer),
    citations: Object.freeze([...exchange.citations]),
  });
  let window = [...state.exchanges, appended];
  let evicted = state.evicted;
  while (window.length > LIVE_AGENT_SESSION_WINDOW_EXCHANGES) {
    window = window.slice(1);
    evicted += 1;
  }
  let next = freezeState(state, turns, evicted, window);
  while (
    Buffer.byteLength(canonicalJson(next)) > LIVE_AGENT_SESSION_WINDOW_BYTES &&
    window.length > 0
  ) {
    window = window.slice(1);
    evicted += 1;
    next = freezeState(state, turns, evicted, window);
  }
  if (Buffer.byteLength(canonicalJson(next)) > LIVE_AGENT_SESSION_WINDOW_BYTES) {
    fail("session-state-window-overflow");
  }
  return next;
}

function freezeState(
  state: LiveAgentSessionStateV1,
  turns: number,
  evicted: number,
  exchanges: readonly LiveAgentExchangeV1[],
): LiveAgentSessionStateV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: LIVE_AGENT_SESSION_STATE_KIND,
    sessionId: state.sessionId,
    binding: state.binding,
    revision: state.revision,
    scopeSha256: state.scopeSha256,
    compositionId: state.compositionId,
    toolPolicySha256: state.toolPolicySha256,
    turns,
    evicted,
    exchanges: Object.freeze([...exchanges]),
  });
}

/**
 * Verify that a resumed state belongs to this turn.
 *
 * Every check is fail-closed and separately named. A session is not
 * transferable between principals, projects, epochs, threads, scopes or tool
 * policies: each of those changes who is asking, about what, or under which
 * authority.
 *
 * The repository revision is deliberately not compared. A thread's turns run
 * at the mirror's current main head, which moves whenever a merge lands, and
 * the replayed window is rendered as quoted transcript data (not instructions,
 * not repository evidence) that the model must re-check against the
 * repository; each exchange's citations keep the revision they were given at.
 */
export function assertLiveAgentSessionBinding(
  state: LiveAgentSessionStateV1,
  expected: {
    binding: LiveAgentSessionBindingV1;
    scopeSha256: string;
    compositionId: string;
    toolPolicySha256: string;
  },
): void {
  // Compared field by field so each refusal names what moved; a lumped code
  // would hide whether the thread or the project changed.
  if (state.binding.deploymentId !== expected.binding.deploymentId) {
    fail("session-state-deployment-mismatch");
  }
  if (state.binding.projectId !== expected.binding.projectId) {
    fail("session-state-project-mismatch");
  }
  if (state.binding.deploymentEpoch !== expected.binding.deploymentEpoch) {
    fail("session-state-epoch-mismatch");
  }
  if (state.binding.principalId !== expected.binding.principalId) {
    fail("session-state-principal-mismatch");
  }
  if (state.binding.threadBindingSha256 !== expected.binding.threadBindingSha256) {
    fail("session-state-thread-mismatch");
  }
  if (state.scopeSha256 !== expected.scopeSha256) fail("session-state-scope-mismatch");
  if (
    state.compositionId !== expected.compositionId ||
    state.toolPolicySha256 !== expected.toolPolicySha256
  ) {
    fail("session-state-policy-mismatch");
  }
}
