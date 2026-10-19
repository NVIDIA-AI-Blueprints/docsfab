// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted reader-task evidence and the installed reader-evidence policy.
 *
 * Digests prove transport identity, never authority. Nominations are checked
 * against the installed role/path/count ceiling before any model turn.
 */
import {
  normalizeReaderContextInputTransportV1,
  normalizeReaderSourceHintTransportV1,
} from "../reader-task-transport.js";
import type { ReaderContextInputV1, ReaderContextSourceRoleV1 } from "../context/reader-context.js";
import type { ReaderSourceHintV1 } from "../execution/reader-task-admission.js";
import type { ReaderTaskContextInputOrigin } from "../execution/task-context-contracts.js";
import {
  HOST_RUNTIME_READER_TASK_METADATA_MAXIMUM_BYTES,
  HOST_RUNTIME_READER_TASK_MAXIMUM_BYTES,
} from "./reader-task-capacity.js";
import { HostRuntimeContractError } from "./contract-error.js";
import {
  bad,
  canonicalJson,
  containsCredentialDeep,
  digest,
  enumeration,
  freezeDeep,
  objectId,
  positive,
  record,
  recordWithOptional,
  sha,
} from "./wire-decode.js";

export const HOST_RUNTIME_READER_TASK_KIND = "docsfab-reader-task-evidence" as const;
export const HOST_RUNTIME_READER_TASK_MAXIMUM_SOURCES = 128;
/** Shared with the already-supported host V1 policy transport. */
export const HOST_RUNTIME_READER_EVIDENCE_MAXIMUM_CEILING_ENTRIES = 64;
export { HOST_RUNTIME_READER_TASK_MAXIMUM_BYTES } from "./reader-task-capacity.js";

export interface HostRuntimeReaderTaskV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_RUNTIME_READER_TASK_KIND;
  readonly readerContextInput: ReaderContextInputV1;
  readonly inputOrigin: ReaderTaskContextInputOrigin;
  /** Normalized reader instruction; absent on legacy tasks without changing their digest. */
  readonly requestText?: string;
  /**
   * Captured by trusted operator ingress before any text normalization or model
   * reading. Sealers transport this assertion; a digest alone is not provenance.
   * Missing on legacy/caller-generated reader tasks, which name no special file.
   */
  readonly operatorInput?: {
    readonly requestText: string;
    readonly targetPaths: readonly string[];
  };
  readonly comparison: {
    readonly kind: "base-head";
    readonly baseRevision: string;
    readonly headRevision: string;
  };
  readonly sources: readonly ReaderSourceHintV1[];
  readonly readerTaskSha256: string;
}

export interface HostRuntimeReaderEvidencePolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-host-reader-evidence-policy";
  readonly workflow: "update-documentation";
  readonly sourceRoles: readonly ReaderContextSourceRoleV1[];
  readonly pathCeiling: readonly string[];
  readonly maximumSourceNominations: number;
  readonly policySha256: string;
}

export interface HostRuntimeReaderEvidencePolicyV2 {
  readonly schemaVersion: 2;
  readonly kind: "docsfab-host-reader-evidence-policy";
  readonly workflow: "update-documentation";
  readonly sourceRoles: readonly ReaderContextSourceRoleV1[];
  /** Read authority is the bound repository's tracked tree, never arbitrary host paths. */
  readonly readScope: "bound-tracked-repository";
  readonly maximumSourceNominations: number;
  readonly policySha256: string;
}

export type HostRuntimeReaderEvidencePolicy =
  | HostRuntimeReaderEvidencePolicyV1
  | HostRuntimeReaderEvidencePolicyV2;

export interface HostRuntimeReaderEvidenceNominationV1 {
  readonly role: ReaderContextSourceRoleV1;
  readonly path: string;
  readonly provenance:
    | "explicit"
    | "change-scope"
    | "changed-path"
    | "repository-instruction"
    | "virtual-request";
}

/** Seal inert reader-task input. The digest proves transport identity, never authority. */
export function sealHostRuntimeReaderTask(
  input: Omit<HostRuntimeReaderTaskV1, "readerTaskSha256">,
): HostRuntimeReaderTaskV1 {
  return parseHostRuntimeReaderTask({ ...input, readerTaskSha256: digest(input) });
}

export function sealHostRuntimeReaderEvidencePolicy(
  input:
    | Omit<HostRuntimeReaderEvidencePolicyV1, "schemaVersion" | "kind" | "policySha256">
    | Omit<HostRuntimeReaderEvidencePolicyV2, "kind" | "policySha256">,
): HostRuntimeReaderEvidencePolicy {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-host-reader-evidence-policy" as const,
    ...input,
  };
  return parseHostRuntimeReaderEvidencePolicy({ ...body, policySha256: digest(body) });
}

export function parseHostRuntimeReaderEvidencePolicy(
  input: unknown,
): HostRuntimeReaderEvidencePolicy {
  const version =
    input && typeof input === "object"
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  const root = record(input, [
    "schemaVersion",
    "kind",
    "workflow",
    "sourceRoles",
    ...(version === 2 ? ["readScope"] : ["pathCeiling"]),
    "maximumSourceNominations",
    "policySha256",
  ]);
  if (
    (root.schemaVersion !== 1 && root.schemaVersion !== 2) ||
    root.kind !== "docsfab-host-reader-evidence-policy" ||
    root.workflow !== "update-documentation"
  )
    bad("reader-evidence-policy-version");
  if (
    !Array.isArray(root.sourceRoles) ||
    root.sourceRoles.length < 1 ||
    root.sourceRoles.length > 6
  )
    bad("reader-evidence-policy-roles");
  const sourceRoles = root.sourceRoles.map((role) =>
    enumeration(role, [
      "public-contract",
      "changed-source",
      "current-documentation",
      "repository-instruction",
      "accepted-knowledge",
      "request",
    ] as const),
  );
  if (new Set(sourceRoles).size !== sourceRoles.length) bad("reader-evidence-policy-roles");
  let pathCeiling: string[] | undefined;
  if (version === 2) {
    if (root.readScope !== "bound-tracked-repository") bad("reader-evidence-policy-scope");
  } else {
    if (
      !Array.isArray(root.pathCeiling) ||
      root.pathCeiling.length < 1 ||
      root.pathCeiling.length > HOST_RUNTIME_READER_EVIDENCE_MAXIMUM_CEILING_ENTRIES
    )
      bad("reader-evidence-policy-ceiling");
    pathCeiling = root.pathCeiling.map((value) => {
      if (
        typeof value !== "string" ||
        value.length > 512 ||
        value.startsWith("/") ||
        value.includes("\\") ||
        value.includes("\0") ||
        value.includes(":") ||
        value
          .split("/")
          .some(
            (part, index, all) =>
              (part === "" && index !== all.length - 1) || part === "." || part === "..",
          )
      )
        bad("reader-evidence-policy-ceiling");
      return value;
    });
    if (new Set(pathCeiling).size !== pathCeiling.length) bad("reader-evidence-policy-ceiling");
  }
  const maximumSourceNominations = positive(root.maximumSourceNominations);
  if (maximumSourceNominations > HOST_RUNTIME_READER_TASK_MAXIMUM_SOURCES)
    bad("reader-evidence-policy-maximum");
  const common = {
    kind: "docsfab-host-reader-evidence-policy" as const,
    workflow: "update-documentation" as const,
    sourceRoles: Object.freeze(sourceRoles),
    maximumSourceNominations,
  };
  const body =
    version === 2
      ? freezeDeep({
          schemaVersion: 2 as const,
          ...common,
          readScope: "bound-tracked-repository" as const,
        })
      : freezeDeep({
          schemaVersion: 1 as const,
          ...common,
          pathCeiling: Object.freeze(pathCeiling!),
        });
  if (sha(root.policySha256) !== digest(body)) bad("reader-evidence-policy-digest-mismatch");
  return freezeDeep({ ...body, policySha256: digest(body) });
}

/** Apply the installed role/path/count ceiling to canonical pre-read nominations. */
export function assertHostRuntimeReaderEvidenceNominations(
  policy: HostRuntimeReaderEvidencePolicy,
  nominations: readonly HostRuntimeReaderEvidenceNominationV1[],
): void {
  const identities = new Set(nominations.map(({ role, path }) => `${role}\0${path}`));
  if (
    identities.size > policy.maximumSourceNominations ||
    nominations.some(
      ({ role, path, provenance }) =>
        !policy.sourceRoles.includes(role) ||
        (provenance !== "virtual-request" && !safeReaderPath(path)) ||
        (provenance !== "virtual-request" &&
          policy.schemaVersion === 1 &&
          !policy.pathCeiling.some((entry) =>
            entry.endsWith("/") ? path.startsWith(entry) : path === entry,
          )),
    )
  ) {
    throw new Error("Hosted reader admission exceeds the installed evidence policy.");
  }
}

/** Strictly parse the reader intent and source nominations used by hosted schema-v2 updates. */
export function parseHostRuntimeReaderTask(input: unknown): HostRuntimeReaderTaskV1 {
  const root = recordWithOptional(
    input,
    [
      "schemaVersion",
      "kind",
      "readerContextInput",
      "inputOrigin",
      "comparison",
      "sources",
      "readerTaskSha256",
    ],
    ["requestText", "operatorInput"],
  );
  if (root.schemaVersion !== 1 || root.kind !== HOST_RUNTIME_READER_TASK_KIND)
    bad("reader-task-version");
  const readerContextInput = normalizeReaderContextInputTransportV1(root.readerContextInput, {
    fail: (code) => bad(`reader-task-context-${code}`),
    rejectCredentials: (value) => {
      if (containsCredentialDeep(value, "hosted-reader-task:readerContextInput"))
        bad("credential-material");
    },
  });
  if (readerContextInput.change_scope.some((path) => !safeReaderPath(path)))
    bad("reader-task-path");
  const inputOrigin = enumeration(root.inputOrigin, ["explicit", "conservative-fallback"] as const);
  const comparison = record(root.comparison, ["kind", "baseRevision", "headRevision"]);
  if (comparison.kind !== "base-head") bad("reader-task-comparison");
  if (
    !Array.isArray(root.sources) ||
    root.sources.length < 1 ||
    root.sources.length > HOST_RUNTIME_READER_TASK_MAXIMUM_SOURCES
  )
    bad("reader-task-sources");
  let sources: ReaderSourceHintV1[];
  try {
    sources = root.sources.map((source) =>
      normalizeReaderSourceHintTransportV1(source, {
        fail: (code) => bad(`reader-task-source-${code}`),
        rejectCredentials: (value) => {
          if (containsCredentialDeep(value, "hosted-reader-task:sources"))
            bad("credential-material");
        },
      }),
    );
  } catch (error) {
    if (error instanceof HostRuntimeContractError && error.code === "credential-material") {
      throw error;
    }
    bad("reader-task-sources");
  }
  if (new Set(sources.map(({ role, path }) => `${role}\0${path}`)).size !== sources.length)
    bad("reader-task-sources");
  const requestText = root.requestText;
  if (
    requestText !== undefined &&
    (typeof requestText !== "string" ||
      !/\S/u.test(requestText) ||
      requestText !== requestText.normalize("NFC") ||
      /[\0\r]/u.test(requestText))
  )
    bad("reader-task-request-text");
  if (containsCredentialDeep(requestText, "hosted-reader-task:requestText"))
    bad("credential-material");
  let operatorInput: HostRuntimeReaderTaskV1["operatorInput"];
  if (root.operatorInput !== undefined) {
    const raw = record(root.operatorInput, ["requestText", "targetPaths"]);
    if (
      typeof raw.requestText !== "string" ||
      !/\S/u.test(raw.requestText) ||
      /[\0\r]/u.test(raw.requestText) ||
      raw.requestText.normalize("NFC") !== requestText ||
      !Array.isArray(raw.targetPaths) ||
      raw.targetPaths.some((path) => typeof path !== "string" || !safeReaderPath(path)) ||
      canonicalJson(raw.targetPaths) !== canonicalJson(readerContextInput.change_scope)
    )
      bad("reader-task-operator-input");
    if (containsCredentialDeep(raw, "hosted-reader-task:operatorInput")) bad("credential-material");
    operatorInput = { requestText: raw.requestText, targetPaths: raw.targetPaths as string[] };
  }
  const body = {
    schemaVersion: 1 as const,
    kind: HOST_RUNTIME_READER_TASK_KIND,
    readerContextInput,
    inputOrigin,
    ...(requestText === undefined ? {} : { requestText: requestText as string }),
    ...(operatorInput === undefined ? {} : { operatorInput }),
    comparison: Object.freeze({
      kind: "base-head" as const,
      baseRevision: objectId(comparison.baseRevision),
      headRevision: objectId(comparison.headRevision),
    }),
    sources: Object.freeze(sources),
  };
  const { requestText: _requestText, operatorInput: _operatorInput, ...metadata } = body;
  if (
    Buffer.byteLength(canonicalJson(metadata), "utf8") >
    HOST_RUNTIME_READER_TASK_METADATA_MAXIMUM_BYTES
  )
    bad("reader-task-size");
  if (Buffer.byteLength(canonicalJson(body), "utf8") > HOST_RUNTIME_READER_TASK_MAXIMUM_BYTES)
    bad("reader-task-size");
  if (sha(root.readerTaskSha256) !== digest(body)) bad("reader-task-digest-mismatch");
  return freezeDeep({ ...body, readerTaskSha256: digest(body) });
}

function safeReaderPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    value === value.normalize("NFC") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}
