// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Benchmark-neutral, versioned input contract for one noninteractive
 * live-agent task. The task file describes work and narrows scope; it grants
 * no authority by itself. A host must intersect this scope with its grant.
 */

import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import { sha256 } from "../content-ir/canonical.js";

export const LIVE_AGENT_TASK_REQUEST_KIND = "docsfab-live-agent-task-request" as const;
export const LIVE_AGENT_TASK_REQUEST_SCHEMA_VERSION = 1 as const;

export const LIVE_AGENT_TASK_WRITE_CLASSES = ["none", "documentation"] as const;
export type LiveAgentTaskWriteClassV1 = (typeof LIVE_AGENT_TASK_WRITE_CLASSES)[number];

export type LiveAgentTaskConfigurationValue = string | number | boolean | null;

/** Serializable selection of an immutable prepared local source. */
export interface PreparedLocalSourceRefV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-prepared-local-source";
  readonly sourceId: string;
  readonly repositoryRevision: string;
  readonly contentSha256: string;
  readonly paths: readonly string[];
}

export interface LiveAgentTaskRequestV1 {
  readonly schemaVersion: typeof LIVE_AGENT_TASK_REQUEST_SCHEMA_VERSION;
  readonly kind: typeof LIVE_AGENT_TASK_REQUEST_KIND;
  readonly taskId: string;
  readonly sessionId: string;
  /** The decoded UTF-8 prompt bytes are bound by `sha256`. */
  readonly prompt: {
    readonly encoding: "utf-8";
    readonly text: string;
    readonly sha256: string;
  };
  readonly baseline: {
    readonly repositoryRevision: string;
    readonly contentSha256: string;
  };
  /** Immutable source references; their byte snapshots live out of band. */
  readonly sources: readonly PreparedLocalSourceRefV1[];
  /** Requested paths must be contained by a listed documentation root. */
  readonly scope: {
    readonly documentationRoots: readonly string[];
    readonly requestedPaths: readonly string[];
    readonly writeClass: LiveAgentTaskWriteClassV1;
  };
  /** Named evidence obligations, joined by id to result evidence. */
  readonly requiredEvidence: readonly string[];
  /** Effective, nonsecret configuration as admitted by the host. */
  readonly effectiveConfig: {
    readonly profileId: string | null;
    readonly modelId: string | null;
    readonly configurationSha256: string;
    readonly values: Readonly<Record<string, LiveAgentTaskConfigurationValue>>;
  };
}

export type LiveAgentTaskContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "unsupported-version"
  | "scope-not-narrow";

export class LiveAgentTaskContractError extends Error {
  public constructor(public readonly code: LiveAgentTaskContractErrorCode) {
    super(`Live-agent task contract rejected input (${code}).`);
    this.name = "LiveAgentTaskContractError";
  }
}

function fail(code: LiveAgentTaskContractErrorCode): never {
  throw new LiveAgentTaskContractError(code);
}

const kit = createContractKit<LiveAgentTaskContractErrorCode>({
  fail: (code) => fail(code),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "unsupported-version",
  },
});

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PATH_SEGMENT = /^[^/\\\u0000]+$/u;

function taskId(value: unknown): string {
  const result = kit.string(value);
  if (!TASK_ID.test(result)) fail("invalid-value");
  return result;
}

function documentationPath(value: unknown): string {
  const result = kit.string(value);
  if (
    result.length === 0 ||
    result.startsWith("/") ||
    /^[A-Za-z]:/u.test(result) ||
    result.includes("\\") ||
    result
      .split("/")
      .some(
        (segment) =>
          segment === "" || segment === "." || segment === ".." || !PATH_SEGMENT.test(segment),
      )
  ) {
    fail("invalid-value");
  }
  return result;
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function decodePaths(value: unknown, requireNonEmpty: boolean): string[] {
  const result = kit.array(value).map(documentationPath);
  kit.unique(result);
  if (requireNonEmpty && result.length === 0) fail("invalid-value");
  return result.sort(kit.compare);
}

/** Decode the serializable ref; it selects a host-bound manifest entry, grants no file read. */
export function decodePreparedLocalSourceRefV1(value: unknown): PreparedLocalSourceRefV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const source = kit.object(value);
  kit.exact(source, [
    "schemaVersion",
    "kind",
    "sourceId",
    "repositoryRevision",
    "contentSha256",
    "paths",
  ]);
  if (source.schemaVersion !== 1 || source.kind !== "docsfab-prepared-local-source") {
    fail("invalid-value");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: "docsfab-prepared-local-source",
    sourceId: (() => {
      const id = kit.string(source.sourceId);
      if (!SOURCE_ID.test(id)) fail("invalid-value");
      return id;
    })(),
    repositoryRevision: kit.revision(source.repositoryRevision),
    contentSha256: kit.hash(source.contentSha256),
    paths: decodePaths(source.paths, true),
  });
}

function decodeConfigurationValues(
  value: unknown,
): Record<string, LiveAgentTaskConfigurationValue> {
  const record = kit.object(value);
  const result: Record<string, LiveAgentTaskConfigurationValue> = Object.create(null) as Record<
    string,
    LiveAgentTaskConfigurationValue
  >;
  for (const [key, raw] of Object.entries(record)) {
    const name = kit.string(key);
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(name)) fail("invalid-value");
    if (raw === null || typeof raw === "boolean") result[name] = raw;
    else if (typeof raw === "string") result[name] = kit.string(raw);
    else if (typeof raw === "number") {
      if (
        !Number.isFinite(raw) ||
        Object.is(raw, -0) ||
        (Number.isInteger(raw) && !Number.isSafeInteger(raw))
      ) {
        fail("invalid-value");
      }
      result[name] = raw;
    } else fail("invalid-value");
  }
  return result;
}

/** Decode and validate the closed v1 request before the host performs model work. */
export function decodeLiveAgentTaskRequestV1(value: unknown): LiveAgentTaskRequestV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "taskId",
    "sessionId",
    "prompt",
    "baseline",
    "sources",
    "scope",
    "requiredEvidence",
    "effectiveConfig",
  ]);
  if (root.schemaVersion !== LIVE_AGENT_TASK_REQUEST_SCHEMA_VERSION) fail("unsupported-version");
  if (root.kind !== LIVE_AGENT_TASK_REQUEST_KIND) fail("invalid-value");

  const promptRecord = kit.object(root.prompt);
  kit.exact(promptRecord, ["encoding", "text", "sha256"]);
  if (promptRecord.encoding !== "utf-8") fail("invalid-value");
  // Prompt identity is byte-sensitive: preserve its decoded UTF-8 text as-is
  // instead of normalizing it through the ordinary identifier string parser.
  if (typeof promptRecord.text !== "string" || promptRecord.text.includes("\0")) {
    fail("invalid-value");
  }
  const promptText = promptRecord.text;
  const promptSha256 = kit.hash(promptRecord.sha256);
  if (sha256(Buffer.from(promptText, "utf8")) !== promptSha256) fail("digest-mismatch");

  const baselineRecord = kit.object(root.baseline);
  kit.exact(baselineRecord, ["repositoryRevision", "contentSha256"]);

  const sources = kit.array(root.sources).map((source) => decodePreparedLocalSourceRefV1(source));
  kit.unique(sources.map((source) => source.sourceId));

  const scopeRecord = kit.object(root.scope);
  kit.exact(scopeRecord, ["documentationRoots", "requestedPaths", "writeClass"]);
  const documentationRoots = decodePaths(scopeRecord.documentationRoots, true);
  const requestedPaths = decodePaths(scopeRecord.requestedPaths, true);
  if (
    requestedPaths.some(
      (path) => !documentationRoots.some((rootPath) => isWithinRoot(path, rootPath)),
    )
  ) {
    fail("scope-not-narrow");
  }

  const requiredEvidence = kit.array(root.requiredEvidence).map((id) => kit.identifier(id));
  kit.unique(requiredEvidence);

  const configRecord = kit.object(root.effectiveConfig);
  kit.exact(configRecord, ["profileId", "modelId", "configurationSha256", "values"]);
  const profileId = configRecord.profileId === null ? null : kit.identifier(configRecord.profileId);
  const modelId = configRecord.modelId === null ? null : kit.identifier(configRecord.modelId);

  return deepFreeze({
    schemaVersion: LIVE_AGENT_TASK_REQUEST_SCHEMA_VERSION,
    kind: LIVE_AGENT_TASK_REQUEST_KIND,
    taskId: taskId(root.taskId),
    sessionId: taskId(root.sessionId),
    prompt: {
      encoding: "utf-8",
      text: promptText,
      sha256: promptSha256,
    },
    baseline: {
      repositoryRevision: kit.revision(baselineRecord.repositoryRevision),
      contentSha256: kit.hash(baselineRecord.contentSha256),
    },
    sources,
    scope: {
      documentationRoots,
      requestedPaths,
      writeClass: kit.enumeration(scopeRecord.writeClass, LIVE_AGENT_TASK_WRITE_CLASSES),
    },
    requiredEvidence,
    effectiveConfig: {
      profileId,
      modelId,
      configurationSha256: kit.hash(configRecord.configurationSha256),
      values: decodeConfigurationValues(configRecord.values),
    },
  });
}

/** Canonical identity of an admitted task, including prompt and immutable refs. */
export function liveAgentTaskRequestSha256(request: LiveAgentTaskRequestV1): string {
  return kit.canonicalDigest(request);
}
