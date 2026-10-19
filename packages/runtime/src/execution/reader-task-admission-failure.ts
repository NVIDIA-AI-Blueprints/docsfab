// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import type { ReaderContextSourceRoleV1 } from "../context/reader-context.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";

export type ReaderTaskAdmissionObservationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "evidence-unavailable"
  | "identity-mismatch";

export const READER_TASK_ADMISSION_FAILURE_KIND = "docsfab-reader-task-admission-failure" as const;
export const READER_TASK_ADMISSION_FAILURE_PHASE = "reader-task-admission" as const;

export const READER_TASK_ADMISSION_FAILURE_REASONS = [
  "not-admitted-at-selected-revision",
  "unsupported-entry-kind",
  "exceeded-source-byte-limit",
  "exceeded-aggregate-byte-limit",
  "changed-snapshot",
  "excluded-or-denied-source",
  "unknown-read-failure",
] as const;

export type ReaderTaskAdmissionFailureReasonV1 =
  (typeof READER_TASK_ADMISSION_FAILURE_REASONS)[number];

export const READER_TASK_ADMISSION_CORRECTIVE_ACTIONS = [
  "replace-rejected-nomination",
  "nominate-regular-tracked-file",
  "reduce-source-bytes",
  "reobserve-unchanged-snapshot",
  "omit-denied-source",
  "none",
] as const;

export type ReaderTaskAdmissionCorrectiveActionV1 =
  (typeof READER_TASK_ADMISSION_CORRECTIVE_ACTIONS)[number];

export const READER_TASK_ADMISSION_NOMINATION_BINDINGS = [
  "explicit-source-hint",
  "change-scope",
  "changed-path",
  "repository-instruction",
] as const;

export type ReaderTaskAdmissionNominationBindingV1 =
  (typeof READER_TASK_ADMISSION_NOMINATION_BINDINGS)[number];

const SOURCE_ROLES = [
  "public-contract",
  "changed-source",
  "current-documentation",
  "repository-instruction",
  "accepted-knowledge",
  "request",
] as const;

const HOST_PATH_SHAPE = /(?:^|[\\/])(?:Users|home|root)[\\/]/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export type ReaderTaskAdmissionNominationIdentityV1 =
  | { readonly kind: "repository-relative-path"; readonly path: string }
  | { readonly kind: "opaque-reference"; readonly reference: string };

export interface ReaderTaskAdmissionFailureNominationV1 {
  readonly binding: ReaderTaskAdmissionNominationBindingV1;
  readonly index: number;
  readonly role: ReaderContextSourceRoleV1;
  readonly identity: ReaderTaskAdmissionNominationIdentityV1;
}

export interface ReaderTaskAdmissionFailureEffectV1 {
  readonly scope: "this-admission-attempt";
  readonly workflowStarted: false;
  readonly readerHandoffCreated: false;
}

export interface ReaderTaskAdmissionFailureV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof READER_TASK_ADMISSION_FAILURE_KIND;
  readonly code: "evidence-unavailable";
  readonly phase: typeof READER_TASK_ADMISSION_FAILURE_PHASE;
  readonly reason: ReaderTaskAdmissionFailureReasonV1;
  readonly correctiveAction: ReaderTaskAdmissionCorrectiveActionV1;
  readonly selectedRevision: string;
  readonly nomination: ReaderTaskAdmissionFailureNominationV1;
  readonly effect: ReaderTaskAdmissionFailureEffectV1;
}

export class ReaderTaskAdmissionObservationError extends Error {
  public readonly failure: ReaderTaskAdmissionFailureV1 | undefined;

  public constructor(
    public readonly code: ReaderTaskAdmissionObservationErrorCode,
    failure?: ReaderTaskAdmissionFailureV1,
  ) {
    super(`Reader task admission observation rejected input: ${code}.`);
    this.name = "ReaderTaskAdmissionObservationError";
    this.failure = failure;
  }
}

function fail(code: ReaderTaskAdmissionObservationErrorCode): never {
  throw new ReaderTaskAdmissionObservationError(code); // hygiene: ok -- the error class constructs the complete stable message.
}

const kit = createContractKit<ReaderTaskAdmissionObservationErrorCode>({
  fail: fail as ContractFail<ReaderTaskAdmissionObservationErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    credentialMaterial: "credential-material",
    digestMismatch: "identity-mismatch",
    schemaMismatch: "invalid-shape",
  },
});

export const READER_TASK_ADMISSION_CORRECTIVE_ACTION_BY_REASON = Object.freeze({
  "not-admitted-at-selected-revision": "replace-rejected-nomination",
  "unsupported-entry-kind": "nominate-regular-tracked-file",
  "exceeded-source-byte-limit": "reduce-source-bytes",
  "exceeded-aggregate-byte-limit": "reduce-source-bytes",
  "changed-snapshot": "reobserve-unchanged-snapshot",
  "excluded-or-denied-source": "omit-denied-source",
  "unknown-read-failure": "none",
} as const satisfies Record<
  ReaderTaskAdmissionFailureReasonV1,
  ReaderTaskAdmissionCorrectiveActionV1
>);

export function safeAdmissionRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4_096 &&
    path === path.normalize("NFC") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !isAbsolute(path) &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

export function admissionPathAllowsDisclosure(path: string): boolean {
  return (
    safeAdmissionRepositoryPath(path) &&
    !HOST_PATH_SHAPE.test(path) &&
    detectCredentialRuleIds(path).length === 0
  );
}

export function opaqueAdmissionNominationReference(
  binding: ReaderTaskAdmissionNominationBindingV1,
  index: number,
): string {
  return `${binding}:${index}`;
}

export function createReaderTaskAdmissionFailureV1(input: {
  reason: ReaderTaskAdmissionFailureReasonV1;
  selectedRevision: string;
  nomination: {
    binding: ReaderTaskAdmissionNominationBindingV1;
    index: number;
    role: ReaderContextSourceRoleV1;
    path: string;
    disclosePath?: boolean;
  };
}): ReaderTaskAdmissionFailureV1 {
  const disclose =
    input.nomination.disclosePath !== false && admissionPathAllowsDisclosure(input.nomination.path);
  const identity: ReaderTaskAdmissionNominationIdentityV1 = disclose
    ? { kind: "repository-relative-path", path: input.nomination.path }
    : {
        kind: "opaque-reference",
        reference: opaqueAdmissionNominationReference(
          input.nomination.binding,
          input.nomination.index,
        ),
      };
  const failure: ReaderTaskAdmissionFailureV1 = {
    schemaVersion: 1,
    kind: READER_TASK_ADMISSION_FAILURE_KIND,
    code: "evidence-unavailable",
    phase: READER_TASK_ADMISSION_FAILURE_PHASE,
    reason: input.reason,
    correctiveAction: READER_TASK_ADMISSION_CORRECTIVE_ACTION_BY_REASON[input.reason],
    selectedRevision: input.selectedRevision,
    nomination: {
      binding: input.nomination.binding,
      index: input.nomination.index,
      role: input.nomination.role,
      identity,
    },
    effect: {
      scope: "this-admission-attempt",
      workflowStarted: false,
      readerHandoffCreated: false,
    },
  };
  return decodeReaderTaskAdmissionFailure(failure);
}

/** Canonical decoder. Extra keys, private retry grants, and unsafe identities fail closed. */
export function decodeReaderTaskAdmissionFailure(value: unknown): ReaderTaskAdmissionFailureV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "code",
    "phase",
    "reason",
    "correctiveAction",
    "selectedRevision",
    "nomination",
    "effect",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== READER_TASK_ADMISSION_FAILURE_KIND) {
    fail("invalid-shape");
  }
  if (root.code !== "evidence-unavailable") fail("invalid-value");
  const phase = kit.enumeration(root.phase, [READER_TASK_ADMISSION_FAILURE_PHASE]);
  const reason = kit.enumeration(root.reason, READER_TASK_ADMISSION_FAILURE_REASONS);
  const correctiveAction = kit.enumeration(
    root.correctiveAction,
    READER_TASK_ADMISSION_CORRECTIVE_ACTIONS,
  );
  if (correctiveAction !== READER_TASK_ADMISSION_CORRECTIVE_ACTION_BY_REASON[reason]) {
    fail("invalid-value");
  }
  const selectedRevision = kit.string(root.selectedRevision);
  if (!REVISION.test(selectedRevision)) fail("invalid-value");
  const nomination = decodeNomination(root.nomination);
  const effect = decodeEffect(root.effect);
  return kit.deepFreeze({
    schemaVersion: 1 as const,
    kind: READER_TASK_ADMISSION_FAILURE_KIND,
    code: "evidence-unavailable" as const,
    phase,
    reason,
    correctiveAction,
    selectedRevision,
    nomination,
    effect,
  });
}

/**
 * Recover a bounded failure across wrapping and JSON projection without parsing
 * arbitrary exception text. Unrecognized or forged payloads yield undefined.
 */
export function projectReaderTaskAdmissionFailure(
  error: unknown,
): ReaderTaskAdmissionFailureV1 | undefined {
  for (const candidate of failureCandidates(error)) {
    try {
      return decodeReaderTaskAdmissionFailure(candidate);
    } catch {}
  }
  return undefined;
}

function decodeNomination(value: unknown): ReaderTaskAdmissionFailureNominationV1 {
  const root = kit.object(value);
  kit.exact(root, ["binding", "index", "role", "identity"]);
  const binding = kit.enumeration(root.binding, READER_TASK_ADMISSION_NOMINATION_BINDINGS);
  if (
    typeof root.index !== "number" ||
    !Number.isSafeInteger(root.index) ||
    root.index < 0 ||
    root.index > 10_000
  ) {
    fail("invalid-value");
  }
  const role = kit.enumeration(root.role, SOURCE_ROLES);
  return kit.deepFreeze({
    binding,
    index: root.index,
    role,
    identity: decodeIdentity(root.identity),
  });
}

function decodeIdentity(value: unknown): ReaderTaskAdmissionNominationIdentityV1 {
  const root = kit.object(value);
  const kind = kit.string(root.kind);
  if (kind === "repository-relative-path") {
    kit.exact(root, ["kind", "path"]);
    const path = kit.string(root.path);
    if (!admissionPathAllowsDisclosure(path)) fail("invalid-value");
    return kit.deepFreeze({ kind: "repository-relative-path" as const, path });
  }
  if (kind === "opaque-reference") {
    kit.exact(root, ["kind", "reference"]);
    const reference = kit.string(root.reference);
    if (!OPAQUE_REFERENCE.test(reference)) fail("invalid-value");
    return kit.deepFreeze({ kind: "opaque-reference" as const, reference });
  }
  fail("invalid-value");
}

function decodeEffect(value: unknown): ReaderTaskAdmissionFailureEffectV1 {
  const root = kit.object(value);
  kit.exact(root, ["scope", "workflowStarted", "readerHandoffCreated"]);
  if (root.scope !== "this-admission-attempt") fail("invalid-value");
  if (root.workflowStarted !== false || root.readerHandoffCreated !== false) fail("invalid-value");
  return kit.deepFreeze({
    scope: "this-admission-attempt" as const,
    workflowStarted: false as const,
    readerHandoffCreated: false as const,
  });
}

function failureCandidates(error: unknown): unknown[] {
  const candidates: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof ReaderTaskAdmissionObservationError && current.failure) {
      candidates.push(current.failure);
    }
    if (typeof current === "object") {
      const record = current as { failure?: unknown };
      if (record.failure !== undefined) candidates.push(record.failure);
      if (
        Object.prototype.hasOwnProperty.call(current, "kind") &&
        (current as { kind?: unknown }).kind === READER_TASK_ADMISSION_FAILURE_KIND
      ) {
        candidates.push(current);
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return candidates;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:/u.test(path);
}
