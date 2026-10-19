// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted terminal envelope, run record, and editorial-outcome transport.
 *
 * The terminal transport never treats its own digest or serialized claims as
 * editorial authority. Process-local replay must establish that independently.
 */
import type {
  ArtifactReference,
  EditorialDecisionArtifactReferenceV3,
  EditorialDecisionCandidateV1,
} from "../artifacts/contracts.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import {
  isWorkflowManifestV3,
  getDeclarativeWorkflow,
  validateAuthoringRunRecordV1,
} from "./terminal-validation.js";
import type { RunRecord } from "../records/contracts.js";
import {
  parseHostRuntimePatchEvidence,
  type HostRuntimePatchEvidenceV1,
} from "./patch-evidence.js";
import {
  parseCandidateReviewInput,
  type HostRuntimeCandidateReviewV1,
} from "./candidate-review-evidence.js";
import type { HostRuntimeRequestV1 } from "./request.js";
import {
  HOST_RUNTIME_WORKFLOWS,
  HOST_RUNTIME_WRITE_MAXIMUM_PATCH_BYTES,
  type HostRuntimeWriteAuthorityV2,
} from "./write-authority.js";
import {
  HOST_RUNTIME_EDITORIAL_EVIDENCE_REFS_MAXIMUM,
  HOST_RUNTIME_EDITORIAL_LIMITATIONS_MAXIMUM,
  HOST_RUNTIME_EDITORIAL_LIMITATION_MAXIMUM_CHARS,
} from "./bound-capacity.js";
import {
  bad,
  canonicalJson,
  containsCredentialDeep,
  digest,
  digestBytes,
  enumeration,
  freezeDeep,
  id,
  objectId,
  positive,
  record,
  recordWithOptional,
  segment,
  sha,
  withinWriteCeiling,
} from "./wire-decode.js";

export const HOST_RUNTIME_TERMINAL_KIND = "docsfab-host-runtime-terminal" as const;
export const HOSTED_RUN_RECORD_KIND = "docsfab-hosted-run-record" as const;

export interface HostRuntimeTerminalV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_RUNTIME_TERMINAL_KIND;
  readonly status: "succeeded" | "failed" | "needs-input" | "needs-human-decision";
  readonly runRecord: HostedRunRecordV1;
  readonly patch: string | null;
  /** Recomputed, bounded patch accounting; `null` for every read-only terminal. */
  readonly patchEvidence: HostRuntimePatchEvidenceV1 | null;
}

declare const UNADMITTED_EDITORIAL_TERMINAL: unique symbol;
/** Wire-valid transport that still requires independent host-owned replay. */
export type HostRuntimeUnadmittedTerminalV1 = HostRuntimeTerminalV1 & {
  readonly [UNADMITTED_EDITORIAL_TERMINAL]: true;
};

export interface HostedRunBindingV1 {
  readonly deploymentId: string;
  readonly projectId: string;
  readonly deploymentEpoch: string;
  readonly requestKey: string;
  readonly principalId: string;
  readonly originRequestId: string;
  readonly runId: string;
  readonly fence: number;
  readonly workflow: WorkflowName;
  readonly revision: string;
  readonly sourceTreeObjectId: string;
  readonly packetFingerprintSha256: string;
  readonly inputManifestSha256: string | null;
  readonly inputManifestSourcePathSha256: string | null;
  readonly inputManifestGitObjectId: string | null;
  readonly canonSha256: string | null;
  readonly canonSourcePathSha256: string | null;
  readonly canonGitObjectId: string | null;
  readonly reviewEventSha256: string | null;
  readonly candidateReview?: HostRuntimeCandidateReviewV1;
  readonly readerTaskSha256?: string;
  readonly nativeTaskSha256?: string;
  readonly nativeCustodySha256?: string;
  readonly readerEvidencePolicySha256?: string;
  readonly semanticComparisonSha256?: string;
  readonly capsuleSha256: string;
  readonly contextReceiptSha256: string;
  readonly compositionId: string;
  readonly compositionSha256: string;
  readonly toolPolicySha256: string;
}

export type RunEditorialOutcomeV1 =
  | {
      readonly state: "unavailable";
      readonly outcome: "unavailable";
      readonly decision: null;
      readonly candidateReference: null;
      readonly validatedReference: null;
      readonly evidenceRefs: readonly [];
      readonly limitations: readonly string[];
    }
  | {
      readonly state: "candidate" | "validated";
      readonly outcome:
        | "update-recommended"
        | "executed-update"
        | "verified-no-change"
        | "insufficient-evidence";
      readonly decision: EditorialDecisionCandidateV1;
      readonly candidateReference: EditorialDecisionArtifactReferenceV3;
      readonly validatedReference: EditorialDecisionArtifactReferenceV3 | null;
      readonly evidenceRefs: readonly ArtifactReference[];
      readonly limitations: readonly string[];
    };

/**
 * Every editorial outcome as a runtime list, so a new outcome fails typecheck
 * here and the pairing tests enumerate it against each consumer. No consumer
 * derives its own handling from this map.
 */
export const RUN_EDITORIAL_OUTCOME_KEYS = Object.freeze({
  unavailable: true,
  "update-recommended": true,
  "executed-update": true,
  "verified-no-change": true,
  "insufficient-evidence": true,
} as const satisfies Record<RunEditorialOutcomeV1["outcome"], true>);

/** Host-owned authority for projecting retained editorial evidence. */
export interface HostEditorialOutcomeAuthorityV1 {
  project(runtimeRecord: Readonly<Record<string, unknown>>): RunEditorialOutcomeV1;
}

const EDITORIAL_EVIDENCE_REFERENCE_KINDS = [
  "ontology",
  "context-packet",
  "ia-candidates",
  "ia-evaluation",
  "ia-plan",
  "impact-report",
  "healing-report",
  "navigation-evaluation",
  "roadmap-ledger",
  "roadmap-mutation-plan",
  "roadmap-host-operation-request",
  "editorial-decision",
] as const;

/** Strict transport decoder shared by run-result, hosted runtime, and host replay. */
export function decodeRunEditorialOutcomeV1(value: unknown): RunEditorialOutcomeV1 {
  const root = record(value, [
    "candidateReference",
    "decision",
    "evidenceRefs",
    "limitations",
    "outcome",
    "state",
    "validatedReference",
  ]);
  if (
    !Array.isArray(root.evidenceRefs) ||
    root.evidenceRefs.length > HOST_RUNTIME_EDITORIAL_EVIDENCE_REFS_MAXIMUM ||
    !Array.isArray(root.limitations) ||
    root.limitations.length > HOST_RUNTIME_EDITORIAL_LIMITATIONS_MAXIMUM ||
    root.limitations.some(
      (item) =>
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > HOST_RUNTIME_EDITORIAL_LIMITATION_MAXIMUM_CHARS,
    )
  )
    bad("invalid-editorial-outcome");
  if (root.state === "unavailable") {
    if (
      root.outcome !== "unavailable" ||
      root.decision !== null ||
      root.candidateReference !== null ||
      root.validatedReference !== null ||
      root.evidenceRefs.length !== 0 ||
      root.limitations.length === 0
    )
      bad("invalid-editorial-outcome");
    return freezeDeep(structuredClone(root)) as RunEditorialOutcomeV1;
  }
  if (root.state !== "candidate" && root.state !== "validated") bad("invalid-editorial-outcome");
  if (
    root.decision !== "update" &&
    root.decision !== "no-change" &&
    root.decision !== "insufficient-evidence"
  )
    bad("invalid-editorial-outcome");
  const candidateReference = editorialEvidenceReference(root.candidateReference, true);
  const validatedReference =
    root.validatedReference === null
      ? null
      : editorialEvidenceReference(root.validatedReference, true);
  if (
    (root.state === "candidate" && validatedReference !== null) ||
    (root.state === "validated" && validatedReference === null)
  )
    bad("invalid-editorial-outcome");
  const evidenceRefs = root.evidenceRefs.map((reference) =>
    editorialEvidenceReference(reference, false),
  );
  if (
    (root.outcome === "verified-no-change" &&
      (root.state !== "validated" || root.decision !== "no-change")) ||
    (root.outcome === "executed-update" &&
      (root.state !== "validated" || root.decision !== "update")) ||
    (root.outcome === "update-recommended" && root.decision !== "update") ||
    (root.outcome === "insufficient-evidence" &&
      !(
        root.decision === "insufficient-evidence" ||
        (root.decision === "no-change" &&
          (root.state === "candidate" ||
            // A validated no-change on a run that did not succeed is unverified.
            (root.state === "validated" &&
              (root.limitations as string[]).includes("no-change-unverified"))))
      )) ||
    ![
      "update-recommended",
      "executed-update",
      "verified-no-change",
      "insufficient-evidence",
    ].includes(root.outcome as string)
  )
    bad("invalid-editorial-outcome");
  return freezeDeep({
    state: root.state,
    outcome: root.outcome,
    decision: root.decision,
    candidateReference,
    validatedReference,
    evidenceRefs,
    limitations: [...(root.limitations as string[])],
  }) as RunEditorialOutcomeV1;
}

function editorialEvidenceReference(value: unknown, decision: boolean): ArtifactReference {
  const root = record(value, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  if (
    typeof root.kind !== "string" ||
    !EDITORIAL_EVIDENCE_REFERENCE_KINDS.includes(
      root.kind as (typeof EDITORIAL_EVIDENCE_REFERENCE_KINDS)[number],
    ) ||
    (decision && root.kind !== "editorial-decision") ||
    (root.kind === "editorial-decision" ? root.schemaVersion !== 3 : root.schemaVersion !== 1)
  )
    bad("invalid-editorial-outcome");
  return freezeDeep({
    kind: root.kind,
    schemaVersion: root.schemaVersion,
    digest: sha(root.digest),
    repositoryRevision: objectId(root.repositoryRevision),
    repositoryContentDigest: sha(root.repositoryContentDigest),
  }) as ArtifactReference;
}

export interface HostedRunRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HOSTED_RUN_RECORD_KIND;
  readonly status: HostRuntimeTerminalV1["status"];
  readonly binding: HostedRunBindingV1;
  readonly evidence: {
    readonly runtimeRecordSha256: string;
    readonly stepsSha256: string;
    readonly toolsSha256: string;
    readonly modelsSha256: string;
    readonly securityScanSha256: string | null;
    readonly candidateReviewResultSha256?: string;
    readonly editorialOutcomeSha256?: string;
  };
  readonly runtimeRecord: unknown;
  /** Runtime-projected, digest-bound review result for a private candidate. */
  readonly candidateReviewResult?: unknown;
  /** Present only when runtime strict admission projected editorial evidence. */
  readonly editorialOutcome?: RunEditorialOutcomeV1;
}

export function sealHostRuntimeTerminal(input: {
  request: HostRuntimeRequestV1;
  status: HostRuntimeTerminalV1["status"];
  runtimeRecord: unknown;
  patch: string | null;
  patchEvidence?: HostRuntimePatchEvidenceV1 | null;
  candidateReviewResult?: unknown;
  editorialOutcome?: RunEditorialOutcomeV1;
  editorialAuthority?: HostEditorialOutcomeAuthorityV1;
}): HostRuntimeTerminalV1 {
  const record = jsonRecord(input.runtimeRecord);
  const candidateReviewResult =
    input.candidateReviewResult === undefined ? undefined : jsonRecord(input.candidateReviewResult);
  const editorialOutcome =
    input.editorialOutcome === undefined
      ? undefined
      : decodeRunEditorialOutcomeV1(input.editorialOutcome);
  const hosted: HostedRunRecordV1 = {
    schemaVersion: 1,
    kind: HOSTED_RUN_RECORD_KIND,
    status: input.status,
    binding: bindingFor(input.request),
    evidence: {
      runtimeRecordSha256: digest(record),
      stepsSha256: digest(record.steps ?? null),
      toolsSha256: digest(record.tools ?? null),
      modelsSha256: digest(record.models ?? null),
      securityScanSha256: record.securityScan === undefined ? null : digest(record.securityScan),
      ...(candidateReviewResult
        ? { candidateReviewResultSha256: digest(candidateReviewResult) }
        : {}),
      ...(editorialOutcome ? { editorialOutcomeSha256: digest(editorialOutcome) } : {}),
    },
    runtimeRecord: record,
    ...(candidateReviewResult ? { candidateReviewResult } : {}),
    ...(editorialOutcome ? { editorialOutcome } : {}),
  };
  return parseHostRuntimeTerminal(
    {
      schemaVersion: 1,
      kind: HOST_RUNTIME_TERMINAL_KIND,
      status: input.status,
      runRecord: hosted,
      patch: input.patch,
      ...(input.patchEvidence === undefined ? {} : { patchEvidence: input.patchEvidence }),
    },
    input.request,
    input.editorialAuthority,
  );
}

export function parseHostRuntimeTerminal(
  input: unknown,
  expected?: HostRuntimeRequestV1,
  editorialAuthority?: HostEditorialOutcomeAuthorityV1,
): HostRuntimeTerminalV1 {
  return parseHostRuntimeTerminalInternal(input, expected, editorialAuthority, false);
}

/** Decode worker transport without treating its editorial claim as authority. */
export function parseHostRuntimeTerminalWire(
  input: unknown,
  expected: HostRuntimeRequestV1,
): HostRuntimeUnadmittedTerminalV1 {
  return parseHostRuntimeTerminalInternal(
    input,
    expected,
    undefined,
    true,
  ) as HostRuntimeUnadmittedTerminalV1;
}

function parseHostRuntimeTerminalInternal(
  input: unknown,
  expected: HostRuntimeRequestV1 | undefined,
  editorialAuthority: HostEditorialOutcomeAuthorityV1 | undefined,
  allowUnadmittedEditorial: boolean,
): HostRuntimeTerminalV1 {
  const root = recordWithOptional(
    input,
    ["schemaVersion", "kind", "status", "runRecord", "patch"],
    ["patchEvidence"],
  );
  if (root.schemaVersion !== 1 || root.kind !== HOST_RUNTIME_TERMINAL_KIND) bad("invalid-terminal");
  const patchEvidence =
    root.patchEvidence === undefined || root.patchEvidence === null
      ? null
      : parseHostRuntimePatchEvidence(root.patchEvidence);
  const status = enumeration(root.status, [
    "succeeded",
    "failed",
    "needs-input",
    "needs-human-decision",
  ] as const);
  if (
    root.patch !== null &&
    (typeof root.patch !== "string" ||
      Buffer.byteLength(root.patch) > HOST_RUNTIME_WRITE_MAXIMUM_PATCH_BYTES)
  )
    bad("invalid-terminal");
  if (typeof root.patch === "string" && containsCredentialDeep(root.patch, "hosted-terminal:patch"))
    bad("credential-material");
  const hosted = recordWithOptional(
    root.runRecord,
    ["schemaVersion", "kind", "status", "binding", "evidence", "runtimeRecord"],
    ["candidateReviewResult", "editorialOutcome"],
  );
  if (
    hosted.schemaVersion !== 1 ||
    hosted.kind !== HOSTED_RUN_RECORD_KIND ||
    hosted.status !== status
  )
    bad("terminal-status-mismatch");
  const binding = parseHostedBinding(hosted.binding);
  const runtimeRecord = jsonRecord(hosted.runtimeRecord);
  const candidateReviewResult =
    hosted.candidateReviewResult === undefined
      ? undefined
      : jsonRecord(hosted.candidateReviewResult);
  if (containsCredentialDeep(runtimeRecord, "hosted-terminal:runtimeRecord"))
    bad("credential-material");
  if (
    candidateReviewResult &&
    containsCredentialDeep(candidateReviewResult, "hosted-terminal:candidateReviewResult")
  )
    bad("credential-material");
  const evidenceRoot = recordWithOptional(
    hosted.evidence,
    ["runtimeRecordSha256", "stepsSha256", "toolsSha256", "modelsSha256", "securityScanSha256"],
    ["candidateReviewResultSha256", "editorialOutcomeSha256"],
  );
  const editorialOutcome =
    hosted.editorialOutcome === undefined
      ? undefined
      : decodeRunEditorialOutcomeV1(hosted.editorialOutcome);
  const evidence = Object.freeze({
    runtimeRecordSha256: sha(evidenceRoot.runtimeRecordSha256),
    stepsSha256: sha(evidenceRoot.stepsSha256),
    toolsSha256: sha(evidenceRoot.toolsSha256),
    modelsSha256: sha(evidenceRoot.modelsSha256),
    securityScanSha256:
      evidenceRoot.securityScanSha256 === null ? null : sha(evidenceRoot.securityScanSha256),
    ...(evidenceRoot.candidateReviewResultSha256 === undefined
      ? {}
      : { candidateReviewResultSha256: sha(evidenceRoot.candidateReviewResultSha256) }),
    ...(evidenceRoot.editorialOutcomeSha256 === undefined
      ? {}
      : { editorialOutcomeSha256: sha(evidenceRoot.editorialOutcomeSha256) }),
  });
  if (
    evidence.runtimeRecordSha256 !== digest(runtimeRecord) ||
    evidence.stepsSha256 !== digest(runtimeRecord.steps ?? null) ||
    evidence.toolsSha256 !== digest(runtimeRecord.tools ?? null) ||
    evidence.modelsSha256 !== digest(runtimeRecord.models ?? null) ||
    evidence.securityScanSha256 !==
      (runtimeRecord.securityScan === undefined ? null : digest(runtimeRecord.securityScan))
  )
    bad("terminal-evidence-mismatch");
  if (
    (candidateReviewResult === undefined) !==
      (evidence.candidateReviewResultSha256 === undefined) ||
    (candidateReviewResult !== undefined &&
      evidence.candidateReviewResultSha256 !== digest(candidateReviewResult)) ||
    (candidateReviewResult !== undefined &&
      (binding.candidateReview === undefined || status !== "succeeded"))
  )
    bad("terminal-candidate-review-evidence");
  if (
    (editorialOutcome === undefined) !== (evidence.editorialOutcomeSha256 === undefined) ||
    (editorialOutcome !== undefined && evidence.editorialOutcomeSha256 !== digest(editorialOutcome))
  )
    bad("terminal-evidence-mismatch");
  if (runtimeRecord.status !== status) bad("terminal-status-mismatch");
  if (
    runtimeRecord.id !== binding.runId ||
    runtimeRecord.workflow !== binding.workflow ||
    !runtimeRecord.repository ||
    typeof runtimeRecord.repository !== "object" ||
    Array.isArray(runtimeRecord.repository) ||
    (runtimeRecord.repository as Record<string, unknown>).revision !== binding.revision
  )
    bad("terminal-binding-mismatch");
  const admittedEditorialOutcome =
    expected?.workflow === "update-documentation" && status === "succeeded" && editorialAuthority
      ? decodeRunEditorialOutcomeV1(editorialAuthority.project(runtimeRecord))
      : undefined;
  if (
    expected?.workflow === "update-documentation" &&
    expected.packet.readerTask !== undefined &&
    status === "succeeded" &&
    !allowUnadmittedEditorial &&
    (admittedEditorialOutcome === undefined || admittedEditorialOutcome.state === "unavailable")
  )
    bad("terminal-editorial-authority-unavailable");
  if (expected) {
    const authority = expected.writeAuthority;
    if (authority === null && (root.patch !== null || patchEvidence !== null))
      bad("terminal-patch-not-authorized");
    const exact = bindingFor(expected);
    if (canonicalJson(binding) !== canonicalJson(exact)) bad("terminal-binding-mismatch");
    assertRuntimeRecordPolicy(
      runtimeRecord,
      expected,
      status,
      (allowUnadmittedEditorial && expected.workflow === "update-documentation") ||
        (admittedEditorialOutcome !== undefined &&
          admittedEditorialOutcome.state !== "unavailable"),
    );
    if (authority !== null)
      assertTerminalWriteBinding(authority, patchEvidence, root.patch, status);
  }
  if (editorialOutcome) {
    if (editorialOutcome.state !== "unavailable") {
      if (!editorialAuthority) {
        if (!allowUnadmittedEditorial) bad("terminal-editorial-authority-unavailable");
      } else {
        const admitted =
          admittedEditorialOutcome ??
          decodeRunEditorialOutcomeV1(editorialAuthority.project(runtimeRecord));
        if (canonicalJson(admitted) !== canonicalJson(editorialOutcome))
          bad("terminal-editorial-authority-mismatch");
      }
    }
    assertTerminalEditorialOutcome(editorialOutcome, runtimeRecord, root.patch as string | null);
  }
  return freezeDeep({
    schemaVersion: 1,
    kind: HOST_RUNTIME_TERMINAL_KIND,
    status,
    runRecord: {
      schemaVersion: 1,
      kind: HOSTED_RUN_RECORD_KIND,
      status,
      binding,
      evidence,
      runtimeRecord,
      ...(candidateReviewResult ? { candidateReviewResult } : {}),
      ...(editorialOutcome ? { editorialOutcome } : {}),
    },
    patch: root.patch as string | null,
    patchEvidence,
  });
}

/**
 * Bind a terminal's patch to the grant that permitted it: patch body, evidence,
 * and authority must agree on grant, source tree, and candidate tree.
 */
function assertTerminalWriteBinding(
  authority: HostRuntimeWriteAuthorityV2,
  patchEvidence: HostRuntimePatchEvidenceV1 | null,
  patch: unknown,
  status: HostRuntimeTerminalV1["status"],
): void {
  if (patchEvidence === null) {
    // A run that did not reach its write step has nothing to account for, but
    // a succeeded one must always say what it did or did not change.
    if (status === "succeeded") bad("terminal-patch-evidence-missing");
    if (patch !== null) bad("terminal-patch-not-authorized");
    return;
  }
  if (patchEvidence.authoritySha256 !== authority.authoritySha256)
    bad("terminal-write-authority-mismatch");
  if (
    patchEvidence.sourceRevision !== authority.sourceRevision ||
    patchEvidence.sourceTreeObjectId !== authority.sourceTreeObjectId
  )
    bad("terminal-write-authority-mismatch");
  // An unchanged candidate tree is `H` itself; a changed one must not be.
  if (
    (patchEvidence.candidateTreeObjectId === authority.sourceTreeObjectId) !==
    (patchEvidence.changes.length === 0)
  )
    bad("terminal-candidate-tree-mismatch");
  const body = typeof patch === "string" ? patch : "";
  if (patchEvidence.patchBytes !== Buffer.byteLength(body)) bad("terminal-patch-digest-mismatch");
  if (patchEvidence.patchSha256 !== digestBytes(Buffer.from(body)))
    bad("terminal-patch-digest-mismatch");
  if ((patch === null) !== (patchEvidence.changes.length === 0))
    bad("terminal-patch-digest-mismatch");
  if (patchEvidence.changes.length > authority.limits.maximumChangedPaths)
    bad("patch-limit-exceeded");
  if (patchEvidence.patchBytes > authority.limits.maximumPatchBytes) bad("patch-limit-exceeded");
  const byPath = new Map(authority.targets.map((target) => [target.path, target]));
  for (const change of patchEvidence.changes) {
    if (!withinWriteCeiling(change.path, authority.pathCeiling)) bad("patch-scope-escape");
    const target = byPath.get(change.path);
    if (change.operation === "add") {
      if (target && target.preimageObjectId !== null) bad("patch-operation-mismatch");
      continue;
    }
    if (!target) bad("patch-scope-escape");
    if (!target.operations.includes(change.operation)) bad("patch-operation-mismatch");
    if (change.preimageObjectId !== target.preimageObjectId) bad("patch-preimage-mismatch");
  }
}

function assertTerminalEditorialOutcome(
  editorial: RunEditorialOutcomeV1,
  runtimeRecord: Record<string, unknown>,
  patch: string | null,
): void {
  if (editorial.state === "unavailable") return;
  const repository = runtimeRecord.repository as Record<string, unknown> | undefined;
  const revision = repository?.revision;
  if (
    typeof revision !== "string" ||
    editorial.candidateReference.repositoryRevision !== revision ||
    (editorial.validatedReference !== null &&
      editorial.validatedReference.repositoryRevision !== revision) ||
    editorial.evidenceRefs.some((reference) => reference.repositoryRevision !== revision)
  )
    bad("terminal-editorial-binding");

  const executedAuthorUpdate = runtimeRecordExecutedAuthorUpdate(runtimeRecord, patch);
  if (editorial.outcome === "executed-update" && !executedAuthorUpdate)
    bad("terminal-editorial-execution-mismatch");
  if (editorial.outcome === "update-recommended" && executedAuthorUpdate)
    bad("terminal-editorial-execution-mismatch");
  if (editorial.outcome === "verified-no-change") {
    const coverage = runtimeRecord.workflowBranchCoverage as
      | { selection?: { branchId?: unknown } }
      | undefined;
    const steps = Array.isArray(runtimeRecord.steps) ? runtimeRecord.steps : [];
    if (
      runtimeRecord.status !== "succeeded" ||
      patch !== null ||
      runtimeRecord.changes !== undefined ||
      coverage?.selection?.branchId !== "assess-no-change" ||
      steps.some(
        (step) =>
          Boolean(step) &&
          typeof step === "object" &&
          !Array.isArray(step) &&
          (step as Record<string, unknown>).mode === "write",
      )
    )
      bad("terminal-editorial-execution-mismatch");
  }
}

function runtimeRecordExecutedAuthorUpdate(
  runtimeRecord: Record<string, unknown>,
  patch: string | null,
): boolean {
  const coverage = runtimeRecord.workflowBranchCoverage as
    | { selection?: { branchId?: unknown } }
    | undefined;
  const changes = runtimeRecord.changes as
    | { files?: unknown; patch?: { byteLength?: unknown } }
    | undefined;
  const steps = Array.isArray(runtimeRecord.steps) ? runtimeRecord.steps : [];
  return (
    runtimeRecord.status === "succeeded" &&
    typeof patch === "string" &&
    patch.length > 0 &&
    coverage?.selection?.branchId === "author" &&
    Array.isArray(changes?.files) &&
    changes.files.length > 0 &&
    typeof changes.patch?.byteLength === "number" &&
    changes.patch.byteLength > 0 &&
    steps.some(
      (step) =>
        Boolean(step) &&
        typeof step === "object" &&
        !Array.isArray(step) &&
        (step as Record<string, unknown>).id === "write-documentation" &&
        (step as Record<string, unknown>).mode === "write" &&
        (step as Record<string, unknown>).status === "succeeded",
    )
  );
}

function bindingFor(request: HostRuntimeRequestV1): HostedRunBindingV1 {
  return Object.freeze({
    deploymentId: request.deploymentId,
    projectId: request.projectId,
    deploymentEpoch: request.deploymentEpoch,
    requestKey: request.requestKey,
    principalId: request.origin.principalId,
    originRequestId: request.origin.requestId,
    runId: request.runId,
    fence: request.fence,
    workflow: request.workflow,
    revision: request.revision,
    sourceTreeObjectId: request.sourceTreeObjectId,
    packetFingerprintSha256: request.packet.packetFingerprintSha256,
    inputManifestSha256: request.packet.inputManifest?.sha256 ?? null,
    inputManifestSourcePathSha256: request.packet.inputManifest?.sourcePathSha256 ?? null,
    inputManifestGitObjectId: request.packet.inputManifest?.gitObjectId ?? null,
    canonSha256: request.packet.canon?.sha256 ?? null,
    canonSourcePathSha256: request.packet.canon?.sourcePathSha256 ?? null,
    canonGitObjectId: request.packet.canon?.gitObjectId ?? null,
    reviewEventSha256: request.packet.reviewEvent?.sha256 ?? null,
    ...(request.packet.candidateReview ? { candidateReview: request.packet.candidateReview } : {}),
    ...(request.packet.readerTask
      ? { readerTaskSha256: request.packet.readerTask.readerTaskSha256 }
      : {}),
    ...(request.packet.nativeTask
      ? { nativeTaskSha256: request.packet.nativeTask.taskSha256 }
      : {}),
    ...(request.nativeCustody ? { nativeCustodySha256: request.nativeCustody.custodySha256 } : {}),
    ...(request.readerEvidencePolicy
      ? { readerEvidencePolicySha256: request.readerEvidencePolicy.policySha256 }
      : {}),
    ...(request.packet.semanticComparison
      ? { semanticComparisonSha256: request.packet.semanticComparison.inputSha256 }
      : {}),
    capsuleSha256: request.capsule.sha256,
    contextReceiptSha256: request.capsule.receiptSha256,
    compositionId: request.composition.compositionId,
    compositionSha256: request.composition.compositionSha256,
    toolPolicySha256: request.toolPolicySha256,
  });
}

function parseHostedBinding(input: unknown): HostedRunBindingV1 {
  const root = recordWithOptional(
    input,
    [
      "deploymentId",
      "projectId",
      "deploymentEpoch",
      "requestKey",
      "principalId",
      "originRequestId",
      "runId",
      "fence",
      "workflow",
      "revision",
      "sourceTreeObjectId",
      "packetFingerprintSha256",
      "inputManifestSha256",
      "inputManifestSourcePathSha256",
      "inputManifestGitObjectId",
      "canonSha256",
      "canonSourcePathSha256",
      "canonGitObjectId",
      "reviewEventSha256",
      "capsuleSha256",
      "contextReceiptSha256",
      "compositionId",
      "compositionSha256",
      "toolPolicySha256",
    ],
    [
      "candidateReview",
      "readerTaskSha256",
      "readerEvidencePolicySha256",
      "semanticComparisonSha256",
      "nativeTaskSha256",
      "nativeCustodySha256",
    ],
  );
  const binding: HostedRunBindingV1 = {
    deploymentId: segment(root.deploymentId),
    projectId: segment(root.projectId),
    deploymentEpoch: segment(root.deploymentEpoch),
    requestKey: id(root.requestKey),
    principalId: id(root.principalId),
    originRequestId: id(root.originRequestId),
    runId: segment(root.runId),
    fence: positive(root.fence),
    workflow: enumeration(root.workflow, HOST_RUNTIME_WORKFLOWS),
    revision: objectId(root.revision),
    sourceTreeObjectId: objectId(root.sourceTreeObjectId),
    packetFingerprintSha256: sha(root.packetFingerprintSha256),
    inputManifestSha256: root.inputManifestSha256 === null ? null : sha(root.inputManifestSha256),
    inputManifestSourcePathSha256:
      root.inputManifestSourcePathSha256 === null ? null : sha(root.inputManifestSourcePathSha256),
    inputManifestGitObjectId:
      root.inputManifestGitObjectId === null ? null : objectId(root.inputManifestGitObjectId),
    canonSha256: root.canonSha256 === null ? null : sha(root.canonSha256),
    canonSourcePathSha256:
      root.canonSourcePathSha256 === null ? null : sha(root.canonSourcePathSha256),
    canonGitObjectId: root.canonGitObjectId === null ? null : objectId(root.canonGitObjectId),
    reviewEventSha256: root.reviewEventSha256 === null ? null : sha(root.reviewEventSha256),
    ...(root.candidateReview === undefined
      ? {}
      : { candidateReview: parseCandidateReviewInput(root.candidateReview) }),
    ...(root.readerTaskSha256 === undefined
      ? {}
      : { readerTaskSha256: sha(root.readerTaskSha256) }),
    ...(root.nativeTaskSha256 === undefined
      ? {}
      : { nativeTaskSha256: sha(root.nativeTaskSha256) }),
    ...(root.nativeCustodySha256 === undefined
      ? {}
      : { nativeCustodySha256: sha(root.nativeCustodySha256) }),
    ...(root.readerEvidencePolicySha256 === undefined
      ? {}
      : { readerEvidencePolicySha256: sha(root.readerEvidencePolicySha256) }),
    ...(root.semanticComparisonSha256 === undefined
      ? {}
      : { semanticComparisonSha256: sha(root.semanticComparisonSha256) }),
    capsuleSha256: sha(root.capsuleSha256),
    contextReceiptSha256: sha(root.contextReceiptSha256),
    compositionId: id(root.compositionId),
    compositionSha256: sha(root.compositionSha256),
    toolPolicySha256: sha(root.toolPolicySha256),
  };
  if (
    new Set([
      binding.inputManifestSha256 === null,
      binding.inputManifestSourcePathSha256 === null,
      binding.inputManifestGitObjectId === null,
    ]).size !== 1 ||
    new Set([
      binding.canonSha256 === null,
      binding.canonSourcePathSha256 === null,
      binding.canonGitObjectId === null,
    ]).size !== 1
  )
    bad("terminal-frozen-input-binding");
  return Object.freeze(binding);
}

/**
 * Whether the installed schedule for this request can reach a model provider.
 *
 * Read from the installed manifest, never the run record or a retained
 * manifest, so a record cannot argue its way out of the model requirement. The
 * whole installed schedule is asked, so a partial selection stays strict. A
 * workflow without an installed manifest fails closed as inference-bearing.
 *
 * `inference` and `evaluate` steps call the harness, and a `host-operation`
 * step that `invokes` a child pipeline records the child's model use. A
 * `host-operation` step without `invokes` is deterministic: its harness refuses
 * a model call.
 */
function scheduleCanInvokeInference(request: HostRuntimeRequestV1): boolean {
  const installed = getDeclarativeWorkflow(request.workflow);
  if (!installed) return true;
  return installed.steps.some(
    (step) => (step.kind ?? "inference") !== "host-operation" || step.invokes !== undefined,
  );
}

function assertRuntimeRecordPolicy(
  record: Record<string, unknown>,
  request: HostRuntimeRequestV1,
  status: HostRuntimeTerminalV1["status"],
  allowSelectedEditorialSteps: boolean,
): void {
  const expectedReviewScope =
    request.packet.reviewScope === null
      ? undefined
      : {
          scope: request.packet.reviewScope.scope,
          reason: request.packet.reviewScope.reason,
          targetPaths: request.packet.reviewScope.targets.map((target) => target.path),
          deferredPaths: request.packet.reviewScope.deferred.map((entry) => entry.path),
          anchorPaths: request.packet.reviewScope.anchorPaths,
          scopeSha256: request.packet.reviewScope.scopeSha256,
          corpusFileCount: request.packet.reviewScope.corpusFileCount,
          ...(request.packet.canon
            ? {
                continuationIdentity: {
                  canonSha256: request.packet.canon.sha256,
                  reviewRevision: request.revision,
                },
              }
            : {}),
          ...(request.packet.reviewScope.accounting
            ? { accounting: request.packet.reviewScope.accounting }
            : {}),
        };
  if (canonicalJson(record.reviewScope) !== canonicalJson(expectedReviewScope))
    bad("terminal-review-scope-substitution");
  if (!Array.isArray(record.steps) || !record.tools || typeof record.tools !== "object")
    bad("terminal-record-shape");
  const stepIds = record.steps.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) bad("terminal-record-shape");
    return id((value as Record<string, unknown>).id);
  });
  if (
    new Set(stepIds).size !== stepIds.length ||
    stepIds.some((value) => !request.stepIds.includes(value))
  )
    bad("terminal-step-substitution");
  let selectedAuthoringSteps = false;
  if (status === "succeeded") {
    const installed = getDeclarativeWorkflow(request.workflow);
    if (installed && isWorkflowManifestV3(installed)) {
      if (canonicalJson(request.stepIds) !== canonicalJson(installed.steps.map((step) => step.id)))
        bad("terminal-step-substitution");
      try {
        // The installed schedule and complete candidate/producer closure decide
        // the path; a worker-selected subset or retained manifest is insufficient.
        validateAuthoringRunRecordV1(record as unknown as RunRecord, installed, {
          requireTerminalSuccess: true,
        });
      } catch {
        bad("terminal-step-substitution");
      }
      selectedAuthoringSteps = true;
    }
  }
  if (
    status === "succeeded" &&
    !allowSelectedEditorialSteps &&
    !selectedAuthoringSteps &&
    canonicalJson([...stepIds].sort()) !== canonicalJson([...request.stepIds].sort())
  )
    bad("terminal-step-substitution");
  const tools = record.tools as Record<string, unknown>;
  if (!Array.isArray(tools.byTool)) bad("terminal-record-shape");
  for (const item of tools.byTool) {
    if (!item || typeof item !== "object" || Array.isArray(item)) bad("terminal-record-shape");
    const name = (item as Record<string, unknown>).name;
    if (typeof name !== "string" || !request.composition.declaredTools.includes(name))
      bad("terminal-tool-substitution");
  }
  if (!Array.isArray(record.models)) bad("terminal-record-shape");
  const expectedProvider =
    request.composition.route === "offline-fixture"
      ? "offline-fixture"
      : request.composition.executionProfile?.providerId;
  const expectedModel =
    request.composition.route === "offline-fixture"
      ? request.composition.compositionSha256.slice(0, 16)
      : request.composition.executionProfile?.modelId;
  for (const model of record.models) {
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      (model as Record<string, unknown>).provider !== expectedProvider ||
      (model as Record<string, unknown>).model !== expectedModel
    )
      bad("terminal-model-substitution");
  }
  // No recorded model use under an inference-capable schedule looks like a
  // substituted or skipped inference step. A run whose every executed step is a
  // host operation with no nested pipeline (`foundation`, `ia-plan`) correctly
  // records zero models and must pass.
  if (status === "succeeded" && record.models.length === 0 && scheduleCanInvokeInference(request))
    bad("terminal-model-substitution");
  if (status === "succeeded" && (!record.securityScan || typeof record.securityScan !== "object"))
    bad("terminal-security-evidence");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    bad("terminal-record-shape");
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    bad("terminal-record-shape");
  }
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) bad("terminal-record-shape");
  return copy as Record<string, unknown>;
}
