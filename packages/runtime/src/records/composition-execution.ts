// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { hasOperatorDifference, type ModelSlotSettingsV1 } from "../config/model-settings.js";
import type { BoundModelExecutionProfile } from "../model/configuration.js";
import { isAdmittedModelEndpoint } from "../model/endpoint-transport.js";
import { deploymentIdentityForEndpoint } from "../model-composition/installed.js";
import type {
  BoundExecutableComposition,
  ModelCompositionAdapterReference,
  ModelCompositionTransport,
  CompositionModelLimits,
} from "../model-composition/types.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import type { RunRecord, StepRunRecord } from "./contracts.js";
import {
  isWorkflowManifestV2,
  isWorkflowManifestV3,
  workflowSelectedPath,
  type WorkflowDefinition,
  type WorkflowStepKind,
} from "../workflow-contracts/contracts.js";
import { authoringSelectedPath } from "../workflow-contracts/authoring-schedule.js";
import { validateAuthoringRunRecordV1 } from "./authoring-execution.js";
import { CompositionExecutionEvidenceError } from "./composition-execution-error.js";
import { fail, kit } from "./composition-execution/kit.js";

export { CompositionExecutionEvidenceError } from "./composition-execution-error.js";
export type { CompositionExecutionEvidenceErrorCode } from "./composition-execution-error.js";
export {
  createWorkflowBranchCoverageV1,
  workflowBranchCoverageDecodeOptionsV1,
} from "./composition-execution/branch-coverage.js";

export const COMPOSITION_EXECUTION_EVIDENCE_KIND =
  "docsfab-composition-execution-evidence/v1" as const;
/**
 * Evidence for a preset run whose model, transport, endpoint, request policy,
 * or windows an operator changed: v1 plus the `effective` subject. A run on
 * the preset's own values still writes v1, so its evidence is unchanged.
 */
export const COMPOSITION_EXECUTION_EVIDENCE_KIND_V2 =
  "docsfab-composition-execution-evidence/v2" as const;
export const COMPOSITION_EXECUTION_AGGREGATE_KIND =
  "docsfab-composition-execution-aggregate/v1" as const;

const TRANSPORTS = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;

export interface CompositionExecutionWorkflowIdentity {
  readonly id: string;
  readonly sourceSha256: string;
}

export interface CompositionExecutionRepositoryIdentity {
  readonly identitySha256: string;
  readonly revision: string;
}

export interface CreateCompositionExecutionEvidenceInput {
  readonly runId: string;
  readonly bound: BoundExecutableComposition;
  readonly executionProfile: BoundModelExecutionProfile;
  /** Complete host-configured composition ceilings, before installed clamps. */
  readonly configuredLimits: CompositionModelLimits;
  readonly workflow: CompositionExecutionWorkflowIdentity;
  readonly repository: CompositionExecutionRepositoryIdentity;
  /** The run's effective settings, bound into v2 evidence by digest only. */
  readonly modelSettings?: ModelSlotSettingsV1;
}

/**
 * What ran where it differs from the preset. Endpoint URLs stay out: the
 * endpoint is its deployment identity digest, the settings their digest.
 */
export interface CompositionExecutionEffectiveSubjectV1 {
  readonly modelId: string;
  readonly transport: Exclude<ModelCompositionTransport, "opaque-cli-managed">;
  readonly deploymentIdentitySha256: string;
  /** The request policy the run sent, or null when it ran without one. */
  readonly requestPolicySha256: string | null;
  /** Digest of the run record's `modelSettings` slot, or null when none was bound. */
  readonly modelSettingsSha256: string | null;
}

interface CompositionExecutionEvidenceBodyV1 {
  readonly runId: string;
  readonly compositionId: string;
  readonly model: {
    readonly vendor: string;
    readonly requestedId: string;
    readonly resolvedId: string;
  };
  readonly deployment: {
    readonly provider: string;
    readonly routeId: string;
    readonly transport: Exclude<ModelCompositionTransport, "opaque-cli-managed">;
    readonly bindingKind: "exact-origin";
    readonly identitySha256: string;
    readonly region: string | null;
  };
  readonly authentication: {
    readonly route: string;
    readonly credentialFamily: string;
    readonly mechanism: string;
  };
  readonly harness: {
    readonly id: string;
    readonly policySha256: string;
  };
  readonly adapters: {
    readonly routeEvidence: ModelCompositionAdapterReference;
    readonly authentication: ModelCompositionAdapterReference;
    readonly providerConnection: ModelCompositionAdapterReference;
    readonly harness: ModelCompositionAdapterReference;
  };
  readonly digests: {
    readonly installedManifestSha256: string;
    readonly compositionSha256: string;
    readonly candidateSha256: string;
    readonly workflowSha256: string;
    readonly packageLimitsSha256: string;
    readonly requestPolicySha256: string | null;
  };
  readonly workflow: CompositionExecutionWorkflowIdentity;
  readonly repository: CompositionExecutionRepositoryIdentity;
  readonly limits: {
    readonly configured: CompositionModelLimits;
    readonly candidate: CompositionModelLimits;
    readonly composition: CompositionModelLimits;
    readonly package: CompositionModelLimits;
    readonly effective: CompositionModelLimits;
  };
  readonly technicalApproval: "not-established";
  readonly roleQualification: "not-established";
  readonly releaseEligible: false;
  readonly limitations: readonly string[];
}

/**
 * Composition execution evidence: v1, or v2 with the `effective` subject. The
 * preset's own subject stays in the v1 fields either way.
 */
export interface CompositionExecutionEvidenceV1 extends CompositionExecutionEvidenceBodyV1 {
  readonly schemaVersion: 1;
  readonly kind:
    | typeof COMPOSITION_EXECUTION_EVIDENCE_KIND
    | typeof COMPOSITION_EXECUTION_EVIDENCE_KIND_V2;
  readonly evidenceSha256: string;
  /** Present only in v2: what ran where an operator changed the preset. */
  readonly effective?: CompositionExecutionEffectiveSubjectV1;
}

export interface CompositionExecutionAggregateStepV1 {
  readonly ordinal: number;
  readonly id: string;
  readonly kind: WorkflowStepKind;
  readonly mode: "read-only" | "write";
  readonly skill: string;
  readonly skillEvidenceSha256: string;
  readonly modelEvidenceSha256: string | null;
  readonly inferenceEvidenceSha256: string | null;
  /** Digest of the complete persisted successful step result. */
  readonly resultSha256: string;
}

interface CompositionExecutionAggregateBodyV1 {
  readonly compositionEvidenceSha256: string;
  readonly installedManifestSha256: string;
  readonly workflow: CompositionExecutionWorkflowIdentity;
  readonly repository: CompositionExecutionRepositoryIdentity;
  readonly runId: string;
  readonly steps: readonly CompositionExecutionAggregateStepV1[];
  readonly result: {
    readonly status: "succeeded";
    readonly patchSha256: string | null;
    readonly changesSha256: string | null;
    readonly workflowOutcomeSha256: string | null;
    readonly stepResultsSha256: string;
    readonly runResultSha256: string;
  };
  readonly technicalApproval: "not-established";
  readonly roleQualification: "not-established";
  readonly releaseEligible: false;
}

export interface CompositionExecutionAggregateV1 extends CompositionExecutionAggregateBodyV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof COMPOSITION_EXECUTION_AGGREGATE_KIND;
  readonly aggregateSha256: string;
}

export interface CreateCompositionExecutionAggregateInput {
  readonly compositionExecution: CompositionExecutionEvidenceV1;
  readonly run: RunRecord;
  readonly workflow: WorkflowDefinition;
}

export interface ReconstructCompositionExecutionAggregateSnapshotInput {
  readonly compositionExecution: CompositionExecutionEvidenceV1;
  readonly run: RunRecord;
  readonly workflow: WorkflowDefinition;
  readonly workflowIdentity: CompositionExecutionWorkflowIdentity;
}

const BODY_KEYS = [
  "runId",
  "compositionId",
  "model",
  "deployment",
  "authentication",
  "harness",
  "adapters",
  "digests",
  "workflow",
  "repository",
  "limits",
  "technicalApproval",
  "roleQualification",
  "releaseEligible",
  "limitations",
] as const;

const AGGREGATE_BODY_KEYS = [
  "compositionEvidenceSha256",
  "installedManifestSha256",
  "workflow",
  "repository",
  "runId",
  "steps",
  "result",
  "technicalApproval",
  "roleQualification",
  "releaseEligible",
] as const;

/**
 * Project the exact installed executable composition into immutable run
 * integrity evidence. This self-validating record is not an execution or
 * release authority. Authentication values and endpoint URLs deliberately
 * have no representation in this contract.
 */
export function createCompositionExecutionEvidence(
  input: CreateCompositionExecutionEvidenceInput,
): CompositionExecutionEvidenceV1 {
  assertBuilderInput(input);
  const { bound, executionProfile } = input;
  const composition = bound.composition;
  const candidate = bound.candidate;

  assertBoundSubjects(input);
  const transport = requireExecutableTransport(composition.deployment.transport);
  const effective = deriveEffectiveLimits(
    input.configuredLimits,
    candidate.proposedLimits,
    composition.compositionLimits,
    bound.compositionCeiling,
    executionProfile,
  );
  assertCompositionPolicy(executionProfile, effective);
  const effectiveSubject = effectiveSubjectOf(input, effective);
  const body: CompositionExecutionEvidenceBodyV1 = {
    runId: input.runId,
    compositionId: composition.compositionId,
    model: {
      vendor: composition.model.vendor,
      requestedId: composition.model.requestedId,
      resolvedId: composition.model.resolvedId,
    },
    deployment: {
      provider: composition.deployment.provider,
      routeId: composition.deployment.routeId,
      transport,
      bindingKind: "exact-origin",
      identitySha256: composition.deployment.identitySha256,
      region: composition.deployment.region,
    },
    authentication: {
      route: composition.authentication.route,
      credentialFamily: composition.authentication.credentialFamily,
      mechanism: composition.authentication.mechanism,
    },
    harness: {
      id: composition.harness.id,
      policySha256: composition.harness.policySha256,
    },
    adapters: {
      routeEvidence: { ...composition.adapters.routeEvidence },
      authentication: { ...composition.adapters.authentication },
      providerConnection: { ...composition.adapters.providerConnection },
      harness: { ...composition.adapters.harness },
    },
    digests: {
      installedManifestSha256: bound.installedManifestSha256,
      compositionSha256: composition.compositionSha256,
      candidateSha256: candidate.candidateSha256,
      workflowSha256: bound.workflow.sourceSha256,
      packageLimitsSha256: bound.compositionCeilingSha256,
      requestPolicySha256: composition.requestPolicy?.policySha256 ?? null,
    },
    workflow: { ...input.workflow },
    repository: { ...input.repository },
    limits: {
      configured: { ...input.configuredLimits },
      candidate: { ...candidate.proposedLimits },
      composition: { ...composition.compositionLimits },
      package: { ...bound.compositionCeiling },
      effective,
    },
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
    limitations: [...composition.limitations].sort(kit.compare),
  };
  return parseCompositionExecutionEvidence(
    effectiveSubject
      ? kit.seal(COMPOSITION_EXECUTION_EVIDENCE_KIND_V2, "evidenceSha256", {
          ...body,
          effective: effectiveSubject,
        })
      : kit.seal(COMPOSITION_EXECUTION_EVIDENCE_KIND, "evidenceSha256", body),
  );
}

/**
 * The effective subject when an operator changed what the preset runs: its
 * model, transport, endpoint, request policy, a window above the preset's, or
 * any other setting the operator set to a value the preset does not have.
 * Undefined when the run is the preset's own, so its evidence stays v1.
 */
function effectiveSubjectOf(
  input: CreateCompositionExecutionEvidenceInput,
  effective: CompositionModelLimits,
): CompositionExecutionEffectiveSubjectV1 | undefined {
  const { bound, executionProfile } = input;
  const composition = bound.composition;
  const transport = requireExecutableTransport(executionProfile.transport);
  const deploymentIdentitySha256 = deploymentIdentityForEndpoint({
    baseUrl: executionProfile.baseUrl,
    transport,
    provider: composition.deployment.provider,
  });
  const requestPolicySha256 = executionProfile.compositionRequestPolicy?.policySha256 ?? null;
  const presetWindows = (["contextWindow", "maxInputTokens", "maxOutputTokens"] as const).every(
    (key) =>
      effective[key] <=
      Math.min(
        bound.candidate.proposedLimits[key],
        composition.compositionLimits[key],
        bound.compositionCeiling[key],
      ),
  );
  if (
    executionProfile.modelId === composition.model.resolvedId &&
    transport === composition.deployment.transport &&
    deploymentIdentitySha256 === composition.deployment.identitySha256 &&
    requestPolicySha256 === (composition.requestPolicy?.policySha256 ?? null) &&
    presetWindows &&
    // An operator value that differs from the preset, such as an effort or
    // reasoning setting, makes the run the operator's too.
    !(input.modelSettings && hasOperatorDifference(input.modelSettings))
  ) {
    return undefined;
  }
  return {
    modelId: kit.string(executionProfile.modelId),
    transport,
    deploymentIdentitySha256,
    requestPolicySha256,
    modelSettingsSha256: input.modelSettings ? kit.canonicalDigest(input.modelSettings) : null,
  };
}

/** Parse and canonicalize a closed, credential-free composition evidence record (v1 or v2). */
export function parseCompositionExecutionEvidence(value: unknown): CompositionExecutionEvidenceV1 {
  const kind =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { kind?: unknown }).kind
      : undefined;
  if (kind === COMPOSITION_EXECUTION_EVIDENCE_KIND_V2) {
    return kit.decodeSealed(
      value,
      COMPOSITION_EXECUTION_EVIDENCE_KIND_V2,
      "evidenceSha256",
      [...BODY_KEYS, "effective"],
      (body) => ({
        ...normalizeBody(body),
        effective: normalizeEffectiveSubject(body.effective),
      }),
    ) as CompositionExecutionEvidenceV1;
  }
  return kit.decodeSealed(
    value,
    COMPOSITION_EXECUTION_EVIDENCE_KIND,
    "evidenceSha256",
    [...BODY_KEYS],
    normalizeBody,
  ) as CompositionExecutionEvidenceV1;
}

function normalizeEffectiveSubject(value: unknown): CompositionExecutionEffectiveSubjectV1 {
  const root = exactObject(value, [
    "modelId",
    "transport",
    "deploymentIdentitySha256",
    "requestPolicySha256",
    "modelSettingsSha256",
  ]);
  const modelId = kit.string(root.modelId);
  if (!modelId || /[\s\u0000-\u001f\u007f]/u.test(modelId)) fail("invalid-value");
  return {
    modelId,
    transport: kit.enumeration(root.transport, TRANSPORTS),
    deploymentIdentitySha256: kit.hash(root.deploymentIdentitySha256),
    requestPolicySha256: kit.nullableHash(root.requestPolicySha256),
    modelSettingsSha256: kit.nullableHash(root.modelSettingsSha256),
  };
}

/**
 * Verify a sealed composition selection against the exact workflow source and
 * repository that the runner is about to use. Call this before the first
 * provider turn; an invalid selection never becomes a queued run record.
 */
export function assertCompositionExecutionRequestBinding(
  value: unknown,
  input: {
    readonly runId: string;
    readonly workflow: WorkflowDefinition;
    readonly repository: RepositoryTarget;
  },
): CompositionExecutionEvidenceV1 {
  const evidence = parseCompositionExecutionEvidence(value);
  const repositoryIdentitySha256 = createHash("sha256")
    .update(input.repository.sourcePath)
    .digest("hex");
  if (
    evidence.runId !== input.runId ||
    evidence.workflow.id !== input.workflow.name ||
    evidence.repository.identitySha256 !== repositoryIdentitySha256 ||
    evidence.repository.revision !== input.repository.revision
  ) {
    fail("subject-mismatch");
  }
  assertCurrentWorkflowSource(evidence.workflow);
  assertWorkflowDefinition(input.workflow);
  return evidence;
}

/**
 * Seal the terminal composition integrity aggregate. The marker is intentionally derived
 * from persisted run evidence, not from harness return objects, so later
 * publication can reproduce it byte-for-byte from the run record alone.
 */
export function createCompositionExecutionAggregate(
  input: CreateCompositionExecutionAggregateInput,
): CompositionExecutionAggregateV1 {
  const evidence = assertCompositionExecutionRequestBinding(input.compositionExecution, {
    runId: input.run.id,
    workflow: input.workflow,
    repository: input.run.repository,
  });
  return buildCompositionExecutionAggregate(evidence, input.run, input.workflow);
}

/**
 * Recompute a terminal aggregate from an already authenticated workflow
 * snapshot. This is pure evidence verification and grants no authority to run
 * that workflow; live requests must use assertCompositionExecutionRequestBinding.
 */
export function reconstructCompositionExecutionAggregateSnapshot(
  input: ReconstructCompositionExecutionAggregateSnapshotInput,
): CompositionExecutionAggregateV1 {
  const evidence = parseCompositionExecutionEvidence(input.compositionExecution);
  assertWorkflowDefinition(input.workflow);
  const repositoryIdentitySha256 = createHash("sha256")
    .update(input.run.repository.sourcePath)
    .digest("hex");
  if (
    evidence.workflow.id !== input.workflowIdentity.id ||
    evidence.workflow.sourceSha256 !== input.workflowIdentity.sourceSha256 ||
    input.workflow.name !== input.workflowIdentity.id ||
    evidence.runId !== input.run.id ||
    evidence.repository.revision !== input.run.repository.revision ||
    evidence.repository.identitySha256 !== repositoryIdentitySha256
  ) {
    fail("subject-mismatch");
  }
  return buildCompositionExecutionAggregate(evidence, input.run, input.workflow);
}

function buildCompositionExecutionAggregate(
  evidence: CompositionExecutionEvidenceV1,
  run: RunRecord,
  workflow: WorkflowDefinition,
): CompositionExecutionAggregateV1 {
  const selected = isWorkflowManifestV2(workflow)
    ? run.workflowBranchCoverage?.selection?.branchId
    : undefined;
  const authoring = isWorkflowManifestV3(workflow)
    ? validateAuthoringRunRecordV1(run, workflow, { requireTerminalSuccess: true })
    : undefined;
  const authoringBranch = authoring?.selection?.branchId;
  const effectiveWorkflow = reconstructCompositionWorkflowPathV1(run, workflow);
  if (
    run.status !== "succeeded" ||
    run.id.length === 0 ||
    run.workflow !== workflow.name ||
    run.compositionExecution?.evidenceSha256 !== evidence.evidenceSha256 ||
    run.steps.length !== effectiveWorkflow.steps.length ||
    (isWorkflowManifestV2(workflow) && !selected) ||
    (isWorkflowManifestV3(workflow) && !authoringBranch)
  ) {
    fail("subject-mismatch");
  }

  const steps = effectiveWorkflow.steps.map((definition, index) =>
    aggregateStep(run.steps[index], definition, index, evidence),
  );
  const hasWriteStep = effectiveWorkflow.steps.some((step) => step.mode === "write");
  const patchSha256 = run.changes?.patch?.sha256 ?? null;
  if (hasWriteStep && patchSha256 === null) fail("subject-mismatch");
  const changesSha256 = run.changes ? kit.canonicalDigest(run.changes) : null;
  const workflowOutcomeSha256 = run.workflowOutcome
    ? kit.canonicalDigest(run.workflowOutcome)
    : null;
  const stepResultsSha256 = kit.canonicalDigest(steps.map((step) => step.resultSha256));
  const runResultSha256 = kit.canonicalDigest({
    status: "succeeded",
    changes: run.changes ?? null,
    workflowOutcome: run.workflowOutcome ?? null,
    impactPostflight: run.impactPostflight ?? null,
    stepResultsSha256,
    ...(authoring ? { authoringExecutionSha256: authoring.executionSha256 } : {}),
  });
  const body: CompositionExecutionAggregateBodyV1 = {
    compositionEvidenceSha256: evidence.evidenceSha256,
    installedManifestSha256: evidence.digests.installedManifestSha256,
    workflow: { ...evidence.workflow },
    repository: { ...evidence.repository },
    runId: run.id,
    steps,
    result: {
      status: "succeeded",
      patchSha256,
      changesSha256,
      workflowOutcomeSha256,
      stepResultsSha256,
      runResultSha256,
    },
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  };
  return parseCompositionExecutionAggregate(
    kit.seal(COMPOSITION_EXECUTION_AGGREGATE_KIND, "aggregateSha256", body),
  );
}

/** Reconstruct the exact selected path used by cold and composition validation. */
export function reconstructCompositionWorkflowPathV1(
  run: Readonly<RunRecord>,
  workflow: WorkflowDefinition,
): WorkflowDefinition {
  if (isWorkflowManifestV2(workflow)) {
    const selected = run.workflowBranchCoverage?.selection?.branchId;
    return selected ? { ...workflow, ...workflowSelectedPath(workflow, selected) } : workflow;
  }
  if (!isWorkflowManifestV3(workflow)) return workflow;
  const authoring = validateAuthoringRunRecordV1(run, workflow, {
    requireTerminalSuccess: true,
  });
  const selection = authoring.selection;
  if (!selection) {
    fail("subject-mismatch");
    return workflow;
  }
  return { ...workflow, ...authoringSelectedPath(workflow, selection.branchId) };
}

/** Closed parser for terminal composition aggregates. */
export function parseCompositionExecutionAggregate(
  value: unknown,
): CompositionExecutionAggregateV1 {
  return kit.decodeSealed(
    value,
    COMPOSITION_EXECUTION_AGGREGATE_KIND,
    "aggregateSha256",
    [...AGGREGATE_BODY_KEYS],
    normalizeAggregateBody,
  ) as CompositionExecutionAggregateV1;
}

function assertBuilderInput(
  value: unknown,
): asserts value is CreateCompositionExecutionEvidenceInput {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "runId",
      "bound",
      "executionProfile",
      "configuredLimits",
      "workflow",
      "repository",
      "modelSettings",
    ],
    ["modelSettings"],
  );
  kit.identifier(root.runId);

  const profile = kit.object(root.executionProfile);
  kit.exact(
    profile,
    [
      "routeId",
      "providerId",
      "baseUrl",
      "modelId",
      "transport",
      "apiFormat",
      "profile",
      "requestPolicy",
      "compositionRequestPolicy",
      "compositionPolicy",
      // The live binder supplies this key, so the exact key set must admit it
      // or every composition run fails `invalid-shape`. The evidence body does
      // not carry it; it is range-checked below.
      "contextAdmission",
      // The composition's own recorded answer submission, copied by
      // the binder; the subject check below holds it equal to the record.
      "answerSubmission",
      // The endpoint's operator source label, the reasoning effort sent, and
      // whether an operator set reasoning; none enters the evidence body.
      "endpointSource",
      "reasoningEffort",
      "reasoningSetByOperator",
    ],
    [
      "compositionRequestPolicy",
      "compositionPolicy",
      "contextAdmission",
      "answerSubmission",
      "endpointSource",
      "reasoningEffort",
      "reasoningSetByOperator",
    ],
  );
  if (profile.reasoningSetByOperator !== undefined && profile.reasoningSetByOperator !== true) {
    fail("invalid-value");
  }
  if (
    profile.contextAdmission !== undefined &&
    profile.contextAdmission !== "host-window" &&
    profile.contextAdmission !== "provider"
  ) {
    fail("invalid-value");
  }
  if (profile.compositionPolicy !== undefined) {
    const compositionPolicy = exactObject(profile.compositionPolicy, [
      "maxProviderTurns",
      "timeoutMs",
      "maxResponseBytes",
    ]);
    requirePositiveInteger(compositionPolicy.maxProviderTurns);
    requirePositiveInteger(compositionPolicy.timeoutMs);
    requirePositiveInteger(compositionPolicy.maxResponseBytes);
  }
  const endpoint = parseSafeEndpoint(profile.baseUrl);
  if (
    !isAdmittedModelEndpoint(endpoint) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    fail("invalid-value");
  }

  normalizeLimits(root.configuredLimits);
  normalizeWorkflow(root.workflow);
  normalizeRepository(root.repository);
}

function assertBoundSubjects(input: CreateCompositionExecutionEvidenceInput): void {
  const { bound, executionProfile, configuredLimits, workflow } = input;
  const composition = bound.composition;
  const candidate = bound.candidate;
  const profile = executionProfile.profile;
  // The operator may change the model, transport, and endpoint; the route and
  // credential family stay the preset's. The API format follows the transport.
  const apiFormat =
    executionProfile.transport === "anthropic-messages" ? "messages" : "chat_completions";

  // A retired record still binds evidence because retained runs are
  // re-validated against the exact record they ran under. Refusing a new
  // execution of a retired record is the resolver's job.
  if (
    bound.technicalApproval !== "not-established" ||
    bound.releaseEligible !== false ||
    (composition.status !== "active" && composition.status !== "retired") ||
    composition.executionClass !== "pi-provider" ||
    composition.deployment.bindingKind !== "exact-origin" ||
    executionProfile.routeId !== composition.deployment.routeId ||
    executionProfile.providerId !== composition.deployment.routeId ||
    executionProfile.apiFormat !== apiFormat ||
    !profile.compatibility.apiFormats.includes(apiFormat) ||
    configuredLimits.contextWindow !== profile.configuredLimits.contextWindow ||
    configuredLimits.maxInputTokens !== profile.configuredLimits.maxInputTokens ||
    configuredLimits.maxOutputTokens !== profile.configuredLimits.maxOutputTokens ||
    workflow.id !== bound.workflow.workflowId ||
    workflow.sourceSha256 !== bound.workflow.sourceSha256 ||
    candidate.compositionId !== composition.compositionId ||
    candidate.compositionSha256 !== composition.compositionSha256 ||
    candidate.modelId !== composition.model.resolvedId ||
    candidate.routeId !== composition.deployment.routeId ||
    candidate.deploymentIdentitySha256 !== composition.deployment.identitySha256 ||
    candidate.harnessId !== composition.harness.id ||
    // A request policy and an answer submission, when sent, are the preset's
    // own; a run may go without them when the operator changed what they bind.
    (executionProfile.compositionRequestPolicy !== undefined &&
      executionProfile.compositionRequestPolicy.policySha256 !==
        composition.requestPolicy?.policySha256) ||
    (executionProfile.answerSubmission !== undefined &&
      kit.canonicalDigest(executionProfile.answerSubmission) !==
        kit.canonicalDigest(composition.answerSubmission ?? null)) ||
    !sameAdapter(candidate.providerConnectionAdapter, composition.adapters.providerConnection)
  ) {
    fail("subject-mismatch");
  }
  assertAdapterBindings(bound);
  assertEffectiveProfile(profile);
}

function assertAdapterBindings(bound: BoundExecutableComposition): void {
  const { adapters, composition } = bound;
  if (
    adapters.routeEvidence.status !== "implemented" ||
    adapters.routeEvidence.routeId !== composition.deployment.routeId ||
    adapters.routeEvidence.transport !== composition.deployment.transport ||
    adapters.routeEvidence.deploymentIdentitySha256 !== composition.deployment.identitySha256 ||
    !sameAdapter(adapters.routeEvidence, composition.adapters.routeEvidence) ||
    adapters.authentication.status !== "implemented" ||
    adapters.authentication.routeId !== composition.deployment.routeId ||
    adapters.authentication.credentialFamily !== composition.authentication.credentialFamily ||
    adapters.authentication.mechanism !== composition.authentication.mechanism ||
    !sameAdapter(adapters.authentication, composition.adapters.authentication) ||
    adapters.providerConnection.status !== "implemented" ||
    adapters.providerConnection.executionClass !== "pi-provider" ||
    adapters.providerConnection.routeId !== composition.deployment.routeId ||
    adapters.providerConnection.transport !== composition.deployment.transport ||
    adapters.providerConnection.deploymentIdentitySha256 !==
      composition.deployment.identitySha256 ||
    !sameAdapter(adapters.providerConnection, composition.adapters.providerConnection) ||
    adapters.harness.status !== "implemented" ||
    adapters.harness.executionClass !== "pi-provider" ||
    adapters.harness.harnessId !== composition.harness.id ||
    adapters.harness.harnessPolicySha256 !== composition.harness.policySha256 ||
    !sameAdapter(adapters.harness, composition.adapters.harness)
  ) {
    fail("subject-mismatch");
  }
}

function assertEffectiveProfile(profile: BoundModelExecutionProfile["profile"]): void {
  const configured = profile.configuredLimits;
  if (
    !positiveInteger(profile.contextWindow) ||
    !positiveInteger(profile.maxInputTokens) ||
    !positiveInteger(profile.maxOutputTokens) ||
    profile.contextWindow > configured.contextWindow ||
    profile.maxInputTokens > configured.maxInputTokens ||
    profile.maxInputTokens > profile.contextWindow ||
    profile.maxOutputTokens > configured.maxOutputTokens ||
    profile.maxOutputTokens > profile.contextWindow
  ) {
    fail("invalid-value");
  }
}

function deriveEffectiveLimits(
  configured: CompositionModelLimits,
  candidate: CompositionModelLimits,
  composition: CompositionModelLimits,
  packageLimits: CompositionModelLimits,
  executionProfile: BoundModelExecutionProfile,
): CompositionModelLimits {
  // The windows are the ones the run binds: an operator value wins over the
  // preset's, so they are recorded beside the candidate, preset, and package values.
  const contextWindow = Math.min(configured.contextWindow, executionProfile.profile.contextWindow);
  return {
    contextWindow,
    maxInputTokens: Math.min(
      configured.maxInputTokens,
      executionProfile.profile.maxInputTokens,
      contextWindow,
    ),
    maxOutputTokens: Math.min(
      configured.maxOutputTokens,
      executionProfile.profile.maxOutputTokens,
      contextWindow,
    ),
    maxProviderTurns: Math.min(
      configured.maxProviderTurns,
      candidate.maxProviderTurns,
      composition.maxProviderTurns,
      packageLimits.maxProviderTurns,
    ),
    timeoutMs: Math.min(
      configured.timeoutMs,
      candidate.timeoutMs,
      composition.timeoutMs,
      packageLimits.timeoutMs,
    ),
    maxResponseBytes: Math.min(
      configured.maxResponseBytes,
      candidate.maxResponseBytes,
      composition.maxResponseBytes,
      packageLimits.maxResponseBytes,
    ),
  };
}

function assertCompositionPolicy(
  executionProfile: BoundModelExecutionProfile,
  effective: CompositionModelLimits,
): void {
  const policy = executionProfile.compositionPolicy;
  if (
    policy !== undefined &&
    (policy.maxProviderTurns !== effective.maxProviderTurns ||
      policy.timeoutMs !== effective.timeoutMs ||
      policy.maxResponseBytes !== effective.maxResponseBytes)
  ) {
    fail("subject-mismatch");
  }
}

function normalizeBody(body: Record<string, unknown>): CompositionExecutionEvidenceBodyV1 {
  if (
    body.technicalApproval !== "not-established" ||
    body.roleQualification !== "not-established" ||
    body.releaseEligible !== false
  ) {
    fail("invalid-value");
  }

  const model = exactObject(body.model, ["vendor", "requestedId", "resolvedId"]);
  const deployment = exactObject(body.deployment, [
    "provider",
    "routeId",
    "transport",
    "bindingKind",
    "identitySha256",
    "region",
  ]);
  const authentication = exactObject(body.authentication, [
    "route",
    "credentialFamily",
    "mechanism",
  ]);
  const harness = exactObject(body.harness, ["id", "policySha256"]);
  const adapters = exactObject(body.adapters, [
    "routeEvidence",
    "authentication",
    "providerConnection",
    "harness",
  ]);
  const digests = exactObject(body.digests, [
    "installedManifestSha256",
    "compositionSha256",
    "candidateSha256",
    "workflowSha256",
    "packageLimitsSha256",
    "requestPolicySha256",
  ]);
  const limits = exactObject(body.limits, [
    "configured",
    "candidate",
    "composition",
    "package",
    "effective",
  ]);
  const normalizedLimits = {
    configured: normalizeLimits(limits.configured),
    candidate: normalizeLimits(limits.candidate),
    composition: normalizeLimits(limits.composition),
    package: normalizeLimits(limits.package),
    effective: normalizeLimits(limits.effective),
  };
  assertConservativeEffectiveLimits(normalizedLimits);
  const normalizedDigests = {
    installedManifestSha256: kit.hash(digests.installedManifestSha256),
    compositionSha256: kit.hash(digests.compositionSha256),
    candidateSha256: kit.hash(digests.candidateSha256),
    workflowSha256: kit.hash(digests.workflowSha256),
    packageLimitsSha256: kit.hash(digests.packageLimitsSha256),
    requestPolicySha256: kit.nullableHash(digests.requestPolicySha256),
  };
  const normalizedWorkflow = normalizeWorkflow(body.workflow);
  if (
    normalizedDigests.workflowSha256 !== normalizedWorkflow.sourceSha256 ||
    normalizedDigests.packageLimitsSha256 !== kit.canonicalDigest(normalizedLimits.package)
  ) {
    fail("subject-mismatch");
  }

  const limitations = kit.array(body.limitations).map((entry) => kit.identifier(entry));
  if (
    limitations.length === 0 ||
    new Set(limitations).size !== limitations.length ||
    [...limitations].sort(kit.compare).some((entry, index) => entry !== limitations[index])
  ) {
    fail("invalid-value");
  }

  return {
    runId: kit.identifier(body.runId),
    compositionId: kit.identifier(body.compositionId),
    model: {
      vendor: kit.identifier(model.vendor),
      requestedId: kit.identifier(model.requestedId),
      resolvedId: kit.identifier(model.resolvedId),
    },
    deployment: {
      provider: kit.identifier(deployment.provider),
      routeId: kit.identifier(deployment.routeId),
      transport: kit.enumeration(deployment.transport, TRANSPORTS),
      bindingKind: kit.enumeration(deployment.bindingKind, ["exact-origin"] as const),
      identitySha256: kit.hash(deployment.identitySha256),
      region: deployment.region === null ? null : kit.identifier(deployment.region),
    },
    authentication: {
      route: kit.identifier(authentication.route),
      credentialFamily: kit.identifier(authentication.credentialFamily),
      mechanism: kit.identifier(authentication.mechanism),
    },
    harness: {
      id: kit.identifier(harness.id),
      policySha256: kit.hash(harness.policySha256),
    },
    adapters: {
      routeEvidence: normalizeAdapterReference(adapters.routeEvidence),
      authentication: normalizeAdapterReference(adapters.authentication),
      providerConnection: normalizeAdapterReference(adapters.providerConnection),
      harness: normalizeAdapterReference(adapters.harness),
    },
    digests: normalizedDigests,
    workflow: normalizedWorkflow,
    repository: normalizeRepository(body.repository),
    limits: normalizedLimits,
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
    limitations,
  };
}

function normalizeLimits(value: unknown): CompositionModelLimits {
  const root = exactObject(value, [
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
    "maxProviderTurns",
    "timeoutMs",
    "maxResponseBytes",
  ]);
  const result = {
    contextWindow: requirePositiveInteger(root.contextWindow),
    maxInputTokens: requirePositiveInteger(root.maxInputTokens),
    maxOutputTokens: requirePositiveInteger(root.maxOutputTokens),
    maxProviderTurns: requirePositiveInteger(root.maxProviderTurns),
    timeoutMs: requirePositiveInteger(root.timeoutMs),
    maxResponseBytes: requirePositiveInteger(root.maxResponseBytes),
  };
  if (
    result.maxInputTokens > result.contextWindow ||
    result.maxOutputTokens > result.contextWindow
  ) {
    fail("invalid-value");
  }
  return result;
}

function assertConservativeEffectiveLimits(limits: {
  readonly configured: CompositionModelLimits;
  readonly candidate: CompositionModelLimits;
  readonly composition: CompositionModelLimits;
  readonly package: CompositionModelLimits;
  readonly effective: CompositionModelLimits;
}): void {
  const sources = [limits.configured, limits.candidate, limits.composition, limits.package];
  // An operator window may exceed the preset's; it never exceeds what was configured.
  for (const key of ["contextWindow", "maxInputTokens", "maxOutputTokens"] as const) {
    if (limits.effective[key] > limits.configured[key]) fail("invalid-value");
  }
  for (const key of ["maxProviderTurns", "timeoutMs", "maxResponseBytes"] as const) {
    if (sources.some((source) => limits.effective[key] > source[key])) fail("invalid-value");
  }
}

function normalizeAdapterReference(value: unknown): ModelCompositionAdapterReference {
  const root = exactObject(value, ["id", "version"]);
  return { id: kit.identifier(root.id), version: kit.identifier(root.version) };
}

function normalizeWorkflow(value: unknown): CompositionExecutionWorkflowIdentity {
  const root = exactObject(value, ["id", "sourceSha256"]);
  return { id: kit.identifier(root.id), sourceSha256: kit.hash(root.sourceSha256) };
}

function normalizeRepository(value: unknown): CompositionExecutionRepositoryIdentity {
  const root = exactObject(value, ["identitySha256", "revision"]);
  return {
    identitySha256: kit.hash(root.identitySha256),
    revision: kit.revision(root.revision),
  };
}

function aggregateStep(
  step: StepRunRecord | undefined,
  definition: WorkflowDefinition["steps"][number],
  index: number,
  evidence: CompositionExecutionEvidenceV1,
): CompositionExecutionAggregateStepV1 {
  const kind = definition.kind ?? "inference";
  if (!step) return fail("subject-mismatch");
  const model = step.model;
  const skillEvidence = step.skillEvidence;
  const inference = step.inference;
  if (kind === "host-operation") {
    if (
      step.id !== definition.id ||
      step.kind !== kind ||
      step.mode !== definition.mode ||
      step.skill !== definition.skill ||
      step.status !== "succeeded" ||
      !skillEvidence ||
      skillEvidence.id !== definition.skill ||
      model ||
      inference
    ) {
      return fail("subject-mismatch");
    }
    return {
      ordinal: index + 1,
      id: definition.id,
      kind,
      mode: definition.mode,
      skill: definition.skill,
      skillEvidenceSha256: kit.canonicalDigest(skillEvidence),
      modelEvidenceSha256: null,
      inferenceEvidenceSha256: null,
      resultSha256: kit.canonicalDigest(step),
    };
  }
  if (
    step.id !== definition.id ||
    step.kind !== kind ||
    step.mode !== definition.mode ||
    step.skill !== definition.skill ||
    step.status !== "succeeded" ||
    !model ||
    model.provider !== evidence.deployment.routeId ||
    model.model !== (evidence.effective?.modelId ?? evidence.model.resolvedId) ||
    !skillEvidence ||
    skillEvidence.id !== definition.skill ||
    !inference ||
    inference.attempts.length === 0 ||
    inference.attempts.at(-1)?.outcome !== "succeeded"
  ) {
    return fail("subject-mismatch");
  }
  return {
    ordinal: index + 1,
    id: definition.id,
    kind,
    mode: definition.mode,
    skill: definition.skill,
    skillEvidenceSha256: kit.canonicalDigest(skillEvidence),
    modelEvidenceSha256: kit.canonicalDigest(model),
    inferenceEvidenceSha256: kit.canonicalDigest(inference),
    resultSha256: kit.canonicalDigest(step),
  };
}

function normalizeAggregateBody(
  body: Record<string, unknown>,
): CompositionExecutionAggregateBodyV1 {
  if (
    body.technicalApproval !== "not-established" ||
    body.roleQualification !== "not-established" ||
    body.releaseEligible !== false
  ) {
    fail("invalid-value");
  }
  const steps = kit.array(body.steps).map((value, index) => {
    const step = exactObject(value, [
      "ordinal",
      "id",
      "kind",
      "mode",
      "skill",
      "skillEvidenceSha256",
      "modelEvidenceSha256",
      "inferenceEvidenceSha256",
      "resultSha256",
    ]);
    const ordinal = requirePositiveInteger(step.ordinal);
    if (ordinal !== index + 1) fail("invalid-value");
    return {
      ordinal,
      id: kit.identifier(step.id),
      kind: kit.enumeration(step.kind, ["inference", "evaluate", "host-operation"] as const),
      mode: kit.enumeration(step.mode, ["read-only", "write"] as const),
      skill: kit.identifier(step.skill),
      skillEvidenceSha256: kit.hash(step.skillEvidenceSha256),
      modelEvidenceSha256: parseStepEvidenceDigest(step.kind, step.modelEvidenceSha256),
      inferenceEvidenceSha256: parseStepEvidenceDigest(step.kind, step.inferenceEvidenceSha256),
      resultSha256: kit.hash(step.resultSha256),
    };
  });
  if (steps.length === 0 || new Set(steps.map((step) => step.id)).size !== steps.length) {
    fail("invalid-value");
  }

  const result = exactObject(body.result, [
    "status",
    "patchSha256",
    "changesSha256",
    "workflowOutcomeSha256",
    "stepResultsSha256",
    "runResultSha256",
  ]);
  if (result.status !== "succeeded") fail("invalid-value");
  const normalizedStepsResultSha256 = kit.canonicalDigest(steps.map((step) => step.resultSha256));
  const stepResultsSha256 = kit.hash(result.stepResultsSha256);
  if (normalizedStepsResultSha256 !== stepResultsSha256) fail("subject-mismatch");

  return {
    compositionEvidenceSha256: kit.hash(body.compositionEvidenceSha256),
    installedManifestSha256: kit.hash(body.installedManifestSha256),
    workflow: normalizeWorkflow(body.workflow),
    repository: normalizeRepository(body.repository),
    runId: kit.identifier(body.runId),
    steps,
    result: {
      status: "succeeded",
      patchSha256: kit.nullableHash(result.patchSha256),
      changesSha256: kit.nullableHash(result.changesSha256),
      workflowOutcomeSha256: kit.nullableHash(result.workflowOutcomeSha256),
      stepResultsSha256,
      runResultSha256: kit.hash(result.runResultSha256),
    },
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  };
}

function parseStepEvidenceDigest(kind: unknown, value: unknown): string | null {
  if (kind === "host-operation") {
    if (value !== null) fail("invalid-value");
    return null;
  }
  return kit.hash(value);
}

/** Whether a recorded composition names the workflow source this catalog ships now. */
export function isCurrentCompositionWorkflowSource(
  workflow: CompositionExecutionWorkflowIdentity,
): boolean {
  try {
    assertCurrentWorkflowSource(workflow);
    return true;
  } catch (error) {
    if (error instanceof CompositionExecutionEvidenceError) return false;
    throw error;
  }
}

function assertCurrentWorkflowSource(workflow: CompositionExecutionWorkflowIdentity): void {
  let currentSha256: string;
  try {
    const path = new URL(`../../workflows/${workflow.id}.json`, import.meta.url);
    currentSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return fail("subject-mismatch");
  }
  if (currentSha256 !== workflow.sourceSha256) fail("subject-mismatch");
}

function assertWorkflowDefinition(workflow: WorkflowDefinition): void {
  if (
    workflow.steps.length === 0 ||
    workflow.steps.some((step) => {
      const kind = step.kind ?? "inference";
      return kind !== "inference" && kind !== "evaluate" && kind !== "host-operation";
    }) ||
    new Set(workflow.steps.map((step) => step.id)).size !== workflow.steps.length
  ) {
    fail("subject-mismatch");
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const root = kit.object(value);
  kit.exact(root, keys);
  return root;
}

function requirePositiveInteger(value: unknown): number {
  if (!positiveInteger(value)) fail("invalid-value");
  return value as number;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseSafeEndpoint(value: unknown): URL {
  try {
    return new URL(kit.string(value));
  } catch {
    return fail("invalid-value");
  }
}

function requireExecutableTransport(
  value: ModelCompositionTransport,
): Exclude<ModelCompositionTransport, "opaque-cli-managed"> {
  if (value === "opaque-cli-managed") return fail("subject-mismatch");
  return value;
}

function sameAdapter(
  left: ModelCompositionAdapterReference,
  right: ModelCompositionAdapterReference,
): boolean {
  return left.id === right.id && left.version === right.version;
}

/** Why a recorded composition binding was refused. */
export type RunRecordCompositionRefusal =
  | "composition-aggregate-without-execution"
  | "composition-execution-invalid"
  | "composition-execution-subject-mismatch"
  | "composition-aggregate-missing"
  | "composition-aggregate-invalid"
  | "composition-aggregate-subject-mismatch"
  | "composition-workflow-source-changed"
  | "composition-aggregate-mismatch";

export class RunRecordCompositionError extends Error {
  constructor(readonly code: RunRecordCompositionRefusal) {
    super(`Run record composition binding rejected: ${code}`);
    this.name = "RunRecordCompositionError";
  }
}

/**
 * Verify the composition fields a composition-mode run writes, for a strict
 * reader that admits them. Pass the record exactly as parsed: the aggregate
 * seals the record as written, not a reader's projection of it.
 *
 * - The execution evidence must be sealed and bound to this run, workflow,
 *   repository revision, and source path.
 * - A succeeded run must carry the terminal aggregate (the runner seals it
 *   then) and it must equal the aggregate recomputed from this record, so it
 *   cannot be swapped in from another run or outlive an edit to its steps.
 *   That recomputation reads the current workflow catalog, so a record from
 *   another workflow source refuses by name rather than as a mismatch.
 * - A run that failed after sealing (a final save that threw) may keep its
 *   aggregate; that aggregate must still be sealed and bound to this run.
 *
 * A record with neither field is an omitted-mode run and passes unchanged.
 */
export function verifyRunRecordComposition(
  record: Readonly<RunRecord>,
  workflow: WorkflowDefinition,
): void {
  const continuation = isSelfConsistentAnswerRecordContinuation(record, workflow);
  const executionValue = (record as { compositionExecution?: unknown }).compositionExecution;
  const aggregateValue = (record as { compositionExecutionAggregate?: unknown })
    .compositionExecutionAggregate;
  if (executionValue === undefined) {
    if (aggregateValue !== undefined) refuse("composition-aggregate-without-execution");
    return;
  }
  let execution: ReturnType<typeof parseCompositionExecutionEvidence>;
  try {
    execution = parseCompositionExecutionEvidence(executionValue);
  } catch {
    return refuse("composition-execution-invalid");
  }
  if (
    execution.runId !== record.id ||
    execution.workflow.id !== record.workflow ||
    workflow.name !== record.workflow ||
    execution.repository.revision !== record.repository.revision ||
    execution.repository.identitySha256 !==
      createHash("sha256").update(record.repository.sourcePath).digest("hex")
  ) {
    refuse("composition-execution-subject-mismatch");
  }
  if (aggregateValue === undefined) {
    if (record.status === "succeeded" && !continuation) refuse("composition-aggregate-missing");
    return;
  }
  if (continuation) refuse("composition-aggregate-mismatch");
  let aggregate: ReturnType<typeof parseCompositionExecutionAggregate>;
  try {
    aggregate = parseCompositionExecutionAggregate(aggregateValue);
  } catch {
    return refuse("composition-aggregate-invalid");
  }
  if (
    aggregate.compositionEvidenceSha256 !== execution.evidenceSha256 ||
    aggregate.runId !== record.id ||
    kit.canonicalDigest(aggregate.workflow) !== kit.canonicalDigest(execution.workflow) ||
    kit.canonicalDigest(aggregate.repository) !== kit.canonicalDigest(execution.repository)
  ) {
    refuse("composition-aggregate-subject-mismatch");
  }
  if (record.status !== "succeeded") return;
  if (!isCurrentCompositionWorkflowSource(execution.workflow)) {
    refuse("composition-workflow-source-changed");
  }
  let expected: ReturnType<typeof reconstructCompositionExecutionAggregateSnapshot>;
  try {
    expected = reconstructCompositionExecutionAggregateSnapshot({
      compositionExecution: execution,
      run: record as RunRecord,
      workflow,
      workflowIdentity: execution.workflow,
    });
  } catch {
    return refuse("composition-aggregate-mismatch");
  }
  if (kit.canonicalDigest(expected) !== kit.canonicalDigest(aggregate)) {
    refuse("composition-aggregate-mismatch");
  }
}

/**
 * Continuation children deliberately have no whole-run aggregate: their prefix
 * is inherited evidence from another physical run. Admit that omission only
 * when the child carries an exact receipt, a contiguous provenance-bound
 * prefix, and a child-owned committed evaluator checkpoint. This validates
 * internal consistency only; source/checkpoint authenticity comes from the
 * explicit loader that resolves and verifies the referenced saved objects.
 */
export function isSelfConsistentAnswerRecordContinuation(
  record: Readonly<RunRecord>,
  workflow: WorkflowDefinition,
): boolean {
  const receipt = record.answerRecordContinuation;
  if (
    !receipt ||
    record.status !== "succeeded" ||
    record.compositionExecutionAggregate !== undefined
  ) {
    return false;
  }
  const receiptKeys = [
    "checkpointAttempt",
    "checkpointSequence",
    "checkpointSha256",
    "inheritedPrefixSha256",
    "kind",
    "logicalRunId",
    "schemaVersion",
    "sourceRunId",
    "sourceRunRecordSha256",
  ];
  const hasRecoveryBasis = Object.hasOwn(receipt, "recoveryBasis");
  if (
    Object.keys(receipt).length !== receiptKeys.length + Number(hasRecoveryBasis) ||
    receiptKeys.some((key) => !Object.hasOwn(receipt, key)) ||
    (hasRecoveryBasis && receipt.recoveryBasis !== "same-host-owner-process-exited") ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "docsfab-answer-record-continuation-receipt" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(receipt.sourceRunId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(receipt.logicalRunId) ||
    receipt.sourceRunId === record.id ||
    !/^[a-f0-9]{64}$/u.test(receipt.sourceRunRecordSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.checkpointSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.inheritedPrefixSha256) ||
    !Number.isSafeInteger(receipt.checkpointSequence) ||
    receipt.checkpointSequence < 1 ||
    !Number.isSafeInteger(receipt.checkpointAttempt) ||
    receipt.checkpointAttempt < 1
  ) {
    return false;
  }

  const expectedSteps = isWorkflowManifestV2(workflow)
    ? (() => {
        const branchId = record.workflowBranchCoverage?.selection?.branchId;
        return branchId
          ? workflowSelectedPath(workflow, branchId).steps
          : workflow.branching!.prefix.steps;
      })()
    : workflow.steps;
  if (record.steps.length !== expectedSteps.length) return false;
  let prefixLength = 0;
  while (prefixLength < record.steps.length && record.steps[prefixLength]!.inheritedFrom) {
    const step = record.steps[prefixLength]!;
    const provenance = step.inheritedFrom!;
    const expected = expectedSteps[prefixLength]!;
    if (
      step.id !== expected.id ||
      step.status !== "succeeded" ||
      step.skill !== expected.skill ||
      step.mode !== expected.mode ||
      provenance.sourceRunId !== receipt.sourceRunId ||
      provenance.sourceRunRecordSha256 !== receipt.sourceRunRecordSha256 ||
      provenance.sourceStepId !== step.id
    ) {
      return false;
    }
    prefixLength += 1;
  }
  if (prefixLength < 1 || prefixLength >= record.steps.length) return false;
  if (
    answerRecordContinuationPrefixSha256(record.steps.slice(0, prefixLength)) !==
    receipt.inheritedPrefixSha256
  ) {
    return false;
  }
  if (record.steps.slice(prefixLength).some((step) => step.inheritedFrom)) return false;
  if (expectedSteps[prefixLength]?.id !== "evaluate-document-quality") return false;
  if (
    record.steps.some(
      (step, index) => step.id !== expectedSteps[index]?.id || step.status !== "succeeded",
    )
  ) {
    return false;
  }
  const evaluator = record.steps[prefixLength]!;
  const pointer = evaluator.answerRecordCheckpoint;
  const ledgerPointer = evaluator.answerRecordLedger?.checkpoint;
  const progress = evaluator.answerRecordLedger?.progress;
  return Boolean(
    pointer &&
      ledgerPointer &&
      progress &&
      pointer.sha256 === ledgerPointer.sha256 &&
      pointer.sequence === ledgerPointer.sequence &&
      pointer.attempt === ledgerPointer.attempt &&
      pointer.sequence > receipt.checkpointSequence &&
      progress.checkpointSequence === pointer.sequence &&
      progress.logicalRunId === receipt.logicalRunId &&
      progress.complete === true &&
      progress.sourceAttemptHighWater >= receipt.checkpointAttempt,
  );
}

/** Digest copied prefix content while excluding only the child-added provenance wrapper. */
export function answerRecordContinuationPrefixSha256(steps: readonly StepRunRecord[]): string {
  return kit.canonicalDigest(steps.map(({ inheritedFrom: _inheritedFrom, ...step }) => step));
}

function refuse(code: RunRecordCompositionRefusal): never {
  throw new RunRecordCompositionError(code);
}
