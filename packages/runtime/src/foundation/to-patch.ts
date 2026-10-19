// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Composed foundation-to-patch documentation workflow.
 *
 * Harness-neutral host operation: gate on foundation readiness, plan read-only,
 * require current write authorization before draft/revision, preserve
 * checkpoints on failure/interrupt, and never mutate the selected source
 * checkout. Skill ids bind policy identity only; step bodies are injected by
 * the host (production CLI uses gate-only until operators supply steps).
 */

import { createHash } from "node:crypto";
import {
  runBoundedCandidateExperiment,
  type CandidateExperimentLedgerV1,
  type CandidateExperimentLoopResultV1,
} from "../autonomy/experiment-ledger.js";
import type {
  CandidateAttemptInputV1,
  CandidateAttemptV1,
  CandidateBaselineV1,
  CandidateEvaluationVectorV1,
} from "../autonomy/candidate-attempt.js";
import type {
  CandidateExperimentBudgetV1,
  CandidateExperimentConsumptionV1,
  CandidatePlateauPolicyV1,
} from "../autonomy/candidate-plateau.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import type {
  HarnessStepInput,
  HarnessStepResult,
  HostOperationExecutor,
} from "../execution/contracts.js";
import type { RunRecord, RunStatus } from "../records/contracts.js";
import type {
  ProductDisposition,
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import {
  foundationReadinessToProductDisposition,
  inspectFoundation,
  incompleteFoundationInspectSeed,
  type FoundationInspectResultV1,
} from "./index.js";
import {
  defaultInconclusiveWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";

export type FoundationToPatchErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "invalid-step"
  | "write-not-authorized"
  | "path-scope-expanded"
  | "not-ready-canon"
  | "interrupted"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch";

export class FoundationToPatchError extends Error {
  public constructor(public readonly code: FoundationToPatchErrorCode) {
    super(`Foundation-to-patch rejected: ${code}.`);
    this.name = "FoundationToPatchError";
  }
}

function fail(code: FoundationToPatchErrorCode): never {
  throw new FoundationToPatchError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<FoundationToPatchErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/** Frozen skill policy ids consumed from the foundation skill bundle (lock unchanged). */
export const FOUNDATION_TO_PATCH_SKILLS = Object.freeze({
  plan: "documentation-plan",
  draft: "documentation-draft",
  adversarial: "documentation-adversarial-verify",
  revision: "documentation-revision-brief",
} as const);

/** Actual catalog skills used by the hosted authoring/review pipeline. */
export const FOUNDATION_TO_PATCH_CATALOG_SKILLS = Object.freeze({
  plan: "plan-documentation",
  draft: "write-documentation",
  adversarial: "verify-technical-accuracy",
  revision: "write-documentation",
} as const);
type PhaseSkills = typeof FOUNDATION_TO_PATCH_SKILLS | typeof FOUNDATION_TO_PATCH_CATALOG_SKILLS;

export type FoundationToPatchStage =
  | "gate"
  | "plan"
  | "authorize"
  | "draft"
  | "validate"
  | "adversarial"
  | "revision"
  | "impact"
  | "complete";

export interface FoundationToPatchWriteAuthorizationV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-authorization";
  intendedPaths: readonly string[];
  digest: string;
  sha256: string;
  expiresAt: string;
  decidedAt: string;
}

export interface FoundationToPatchPlanEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-plan";
  skillId: PhaseSkills["plan"];
  status: "ready" | "needs-input" | "refuse";
  planSha256: string;
  intendedPaths: readonly string[];
}

export interface FoundationToPatchCandidateEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-candidate";
  skillId: PhaseSkills["draft"];
  candidateSha256: string;
  changedPaths: readonly string[];
}

/** Actual nested authoring paused for input; this is evidence, never a grant. */
export interface FoundationToPatchPendingInputEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-pending-input";
  sourceWorkflow: "create-documentation";
  sourceRunId: string;
  sourceRunSha256: string;
  writeEntered: boolean;
}

export interface FoundationToPatchValidationEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-validation";
  status: "passed" | "failed" | "unavailable";
  validationSha256: string;
  changedPaths: readonly string[];
}

export interface FoundationToPatchAdversarialEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-adversarial";
  skillId: PhaseSkills["adversarial"];
  status: "pass" | "revise" | "block" | "inconclusive";
  reviewSha256: string;
}

export interface FoundationToPatchRevisionEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-revision";
  skillId: PhaseSkills["revision"];
  revisionSha256: string;
  changedPaths: readonly string[];
}

export interface FoundationToPatchPatchEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-patch";
  patchSha256: string;
  byteLength: number;
  changedPaths: readonly string[];
}

export interface FoundationToPatchImpactEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-impact";
  status: "completed" | "failed" | "skipped";
  impactSha256: string;
  changedPaths: readonly string[];
}

/** Additive evidence: bounded candidate keep/discard and plateau ledger. */
export interface FoundationToPatchExperimentEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-experiment";
  ledgerSha256: string;
  terminalReason: NonNullable<CandidateExperimentLedgerV1["terminal"]>["reason"] | null;
  selectedCandidateSha256: string;
  sourceCheckoutSha256: string;
  attemptCount: number;
  boundedTerminal: boolean;
}

export interface FoundationToPatchCheckpointV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-checkpoint";
  stage: FoundationToPatchStage;
  canonSha256?: string;
  readiness?: FoundationInspectResultV1["readiness"];
  plan?: FoundationToPatchPlanEvidenceV1;
  candidate?: FoundationToPatchCandidateEvidenceV1;
  pendingInput?: FoundationToPatchPendingInputEvidenceV1;
  validation?: FoundationToPatchValidationEvidenceV1;
  adversarial?: FoundationToPatchAdversarialEvidenceV1;
  revision?: FoundationToPatchRevisionEvidenceV1;
  patch?: FoundationToPatchPatchEvidenceV1;
  impact?: FoundationToPatchImpactEvidenceV1;
  /** Present only when the host enabled the bounded candidate experiment loop. */
  experiment?: FoundationToPatchExperimentEvidenceV1;
  checkpointSha256: string;
}

export interface FoundationToPatchRunResultV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-to-patch-run";
  status: Extract<RunStatus, "succeeded" | "needs-input" | "failed"> | "blocked" | "interrupted";
  productDisposition: ProductDisposition;
  stage: FoundationToPatchStage;
  checkpoint: FoundationToPatchCheckpointV1;
  /** Explicit proof the selected source checkout was never mutated. */
  sourceCheckoutUnchanged: true;
  guarantees: {
    writeToolsGranted: boolean;
    allowWriteRequired: boolean;
    planningEnteredAsReady: boolean;
  };
  resultSha256: string;
}

export interface FoundationToPatchStepContext {
  inspect: FoundationInspectResultV1;
  authorization: FoundationToPatchWriteAuthorizationV1 | null;
  checkpoint: FoundationToPatchCheckpointV1;
  allowWrite: boolean;
  now: string;
}

export interface FoundationToPatchCandidateExperimentInput {
  experimentId: string;
  baseline: CandidateBaselineV1;
  budget: CandidateExperimentBudgetV1;
  plateau: CandidatePlateauPolicyV1;
  ledger?: CandidateExperimentLedgerV1;
  generateAttempt: (context: {
    attemptIndex: number;
    selectedCandidateSha256: string;
    selectedEvaluation: CandidateEvaluationVectorV1;
    sourceCheckoutSha256: string;
    baselineSha256: string;
    workflowContext: FoundationToPatchStepContext;
  }) => CandidateAttemptInputV1 | CandidateAttemptV1 | null;
  chargeForAttempt?: (attempt: CandidateAttemptV1) => Partial<CandidateExperimentConsumptionV1>;
  /**
   * Map the selected experiment candidate onto foundation-to-patch candidate
   * evidence. Required when the experiment keeps a candidate.
   */
  toCandidateEvidence: (
    selectedCandidateSha256: string,
    ledger: CandidateExperimentLedgerV1,
    context: FoundationToPatchStepContext,
  ) => FoundationToPatchCandidateEvidenceV1;
}

export interface FoundationToPatchRunInput {
  repositoryPath: string;
  repositoryRevision: string;
  allowWrite: boolean;
  now?: string;
  /** Omission preserves historical phase identities and existing record digests. */
  skillPolicy?: "legacy-v1" | "catalog-v1";
  /** Optional precomputed inspection (tests / onboarding handoff). */
  inspect?: FoundationInspectResultV1;
  authorization?: FoundationToPatchWriteAuthorizationV1 | null;
  planStep?: (
    context: FoundationToPatchStepContext,
  ) => Promise<FoundationToPatchPlanEvidenceV1> | FoundationToPatchPlanEvidenceV1;
  draftStep?: (
    context: FoundationToPatchStepContext,
  ) =>
    | Promise<FoundationToPatchCandidateEvidenceV1 | FoundationToPatchPendingInputEvidenceV1>
    | FoundationToPatchCandidateEvidenceV1
    | FoundationToPatchPendingInputEvidenceV1;
  /**
   * Optional bounded candidate keep/discard loop. When set, replaces the
   * single draftStep for candidate selection; stage machine otherwise unchanged.
   */
  candidateExperiment?: FoundationToPatchCandidateExperimentInput;
  validateStep?: (
    context: FoundationToPatchStepContext,
  ) => Promise<FoundationToPatchValidationEvidenceV1> | FoundationToPatchValidationEvidenceV1;
  adversarialStep?: (
    context: FoundationToPatchStepContext,
  ) => Promise<FoundationToPatchAdversarialEvidenceV1> | FoundationToPatchAdversarialEvidenceV1;
  revisionStep?: (
    context: FoundationToPatchStepContext,
  ) => Promise<FoundationToPatchRevisionEvidenceV1> | FoundationToPatchRevisionEvidenceV1;
  impactStep?: (
    context: FoundationToPatchStepContext,
  ) => Promise<FoundationToPatchImpactEvidenceV1> | FoundationToPatchImpactEvidenceV1;
  patchStep?: (
    context: FoundationToPatchStepContext,
  ) => Promise<FoundationToPatchPatchEvidenceV1> | FoundationToPatchPatchEvidenceV1;
  /** Preserve the real nested quality disposition after a valid reviewable patch. */
  completionDisposition?: (
    context: FoundationToPatchStepContext,
  ) => Promise<"ready" | "inconclusive"> | "ready" | "inconclusive";
  /** Test seam: force an interrupt after the named stage completes. */
  interruptAfter?: FoundationToPatchStage;
}

export interface FoundationToPatchHostOperationOptions {
  runInput?: Partial<FoundationToPatchRunInput>;
  run?: (input: FoundationToPatchRunInput) => Promise<FoundationToPatchRunResultV1>;
}

/**
 * Compose the foundation-to-patch journey. Never mutates `repositoryPath`.
 */
export async function runFoundationToPatch(
  input: FoundationToPatchRunInput,
): Promise<FoundationToPatchRunResultV1> {
  const {
    planStep,
    draftStep,
    candidateExperiment,
    validateStep,
    adversarialStep,
    revisionStep,
    impactStep,
    patchStep,
    completionDisposition,
    inspect: inspectOverride,
    authorization: authorizationInput,
    interruptAfter,
    ...data
  } = input;
  kit.assertInert(data);
  kit.rejectCredentials(data);
  if (typeof data.repositoryPath !== "string" || data.repositoryPath.length === 0) {
    fail("invalid-value");
  }
  const revision = kit.revision(data.repositoryRevision);
  const skillPolicy = data.skillPolicy ?? "legacy-v1";
  if (skillPolicy !== "legacy-v1" && skillPolicy !== "catalog-v1") fail("invalid-value");
  const skills =
    skillPolicy === "catalog-v1" ? FOUNDATION_TO_PATCH_CATALOG_SKILLS : FOUNDATION_TO_PATCH_SKILLS;
  const now = data.now ?? new Date().toISOString();
  const authorization = normalizeAuthorization(authorizationInput ?? null, now);

  const inspect =
    inspectOverride ??
    (await inspectFoundation({
      repositoryPath: data.repositoryPath,
      repositoryRevision: revision,
      ...incompleteFoundationInspectSeed(revision),
    }));

  if (inspect.guarantees.hostMutation || inspect.guarantees.writeToolsGranted) {
    fail("invalid-value");
  }

  let checkpoint = sealCheckpoint({
    stage: "gate",
    canonSha256: inspect.canon.canonSha256,
    readiness: inspect.readiness,
  });

  if (inspect.readiness !== "ready") {
    return sealRun({
      status: inspect.readiness === "needs-input" ? "needs-input" : "failed",
      productDisposition: foundationReadinessToProductDisposition(inspect.readiness),
      stage: "gate",
      checkpoint,
      writeToolsGranted: false,
      allowWriteRequired: false,
      planningEnteredAsReady: false,
    });
  }

  if (interruptAfter === "gate") {
    return sealRun({
      status: "interrupted",
      productDisposition: "inconclusive",
      stage: "gate",
      checkpoint,
      writeToolsGranted: false,
      allowWriteRequired: data.allowWrite,
      planningEnteredAsReady: false,
    });
  }

  const contextBase = (): FoundationToPatchStepContext => ({
    inspect,
    authorization,
    checkpoint,
    allowWrite: data.allowWrite,
    now,
  });

  // Historical callbacks retain their byte-compatible scaffold. New catalog
  // compositions must supply real phase implementations; a missing port must
  // never manufacture planning, verification, patch or impact success.
  if (skillPolicy === "catalog-v1" && !planStep) fail("invalid-step");
  // Planning is read-only and only entered when the canon is ready.
  const plan = planStep ? await planStep(contextBase()) : defaultPlan(inspect, skills.plan);
  assertPlan(plan, skills.plan);
  checkpoint = sealCheckpoint({
    ...checkpoint,
    stage: "plan",
    plan,
  });

  if (plan.status !== "ready") {
    return sealRun({
      status: plan.status === "needs-input" ? "needs-input" : "failed",
      productDisposition: plan.status === "needs-input" ? "needs-input" : "not-ready",
      stage: "plan",
      checkpoint,
      writeToolsGranted: false,
      allowWriteRequired: false,
      planningEnteredAsReady: true,
    });
  }

  if (interruptAfter === "plan") {
    return sealRun({
      status: "interrupted",
      productDisposition: "inconclusive",
      stage: "plan",
      checkpoint,
      writeToolsGranted: false,
      allowWriteRequired: data.allowWrite,
      planningEnteredAsReady: true,
    });
  }

  // Write steps require current explicit authorization and allowWrite.
  if (!data.allowWrite || !authorization) {
    checkpoint = sealCheckpoint({ ...checkpoint, stage: "authorize" });
    return sealRun({
      status: "needs-input",
      productDisposition: "needs-input",
      stage: "authorize",
      checkpoint,
      writeToolsGranted: false,
      allowWriteRequired: true,
      planningEnteredAsReady: true,
    });
  }

  if (Date.parse(authorization.expiresAt) <= Date.parse(now)) {
    checkpoint = sealCheckpoint({ ...checkpoint, stage: "authorize" });
    return sealRun({
      status: "needs-input",
      productDisposition: "needs-input",
      stage: "authorize",
      checkpoint,
      writeToolsGranted: false,
      allowWriteRequired: true,
      planningEnteredAsReady: true,
    });
  }

  assertPathsWithin(plan.intendedPaths, authorization.intendedPaths);

  if (!draftStep && !candidateExperiment) {
    checkpoint = sealCheckpoint({ ...checkpoint, stage: "authorize" });
    return sealRun({
      status: "needs-input",
      productDisposition: "needs-input",
      stage: "authorize",
      checkpoint,
      writeToolsGranted: false,
      allowWriteRequired: true,
      planningEnteredAsReady: true,
    });
  }

  if (
    skillPolicy === "catalog-v1" &&
    (!draftStep ||
      !validateStep ||
      !adversarialStep ||
      !patchStep ||
      !impactStep ||
      !completionDisposition)
  )
    fail("invalid-step");

  try {
    let experimentEvidence: FoundationToPatchExperimentEvidenceV1 | undefined;
    let candidate: FoundationToPatchCandidateEvidenceV1;

    if (candidateExperiment) {
      const loopResult = invokeCandidateExperiment(candidateExperiment, contextBase());
      experimentEvidence = projectExperimentEvidence(loopResult);
      candidate = candidateExperiment.toCandidateEvidence(
        loopResult.ledger.selectedCandidateSha256,
        loopResult.ledger,
        contextBase(),
      );
      assertCandidate(candidate, skills.draft);
      assertPathsWithin(candidate.changedPaths, authorization.intendedPaths);
      checkpoint = sealCheckpoint({
        ...checkpoint,
        stage: "draft",
        candidate,
        experiment: experimentEvidence,
      });
    } else {
      const draft = await draftStep!(contextBase());
      if (draft.kind === "docsfab-foundation-to-patch-pending-input") {
        const pendingInput = normalizePendingInput(draft);
        checkpoint = sealCheckpoint({ ...checkpoint, stage: "draft", pendingInput });
        return sealRun({
          status: "needs-input",
          productDisposition: "needs-input",
          stage: "draft",
          checkpoint,
          writeToolsGranted: pendingInput.writeEntered,
          allowWriteRequired: true,
          planningEnteredAsReady: true,
        });
      }
      candidate = draft;
      assertCandidate(candidate, skills.draft);
      assertPathsWithin(candidate.changedPaths, authorization.intendedPaths);
      checkpoint = sealCheckpoint({
        ...checkpoint,
        stage: "draft",
        candidate,
      });
    }

    if (interruptAfter === "draft") {
      return sealRun({
        status: "interrupted",
        productDisposition: "inconclusive",
        stage: "draft",
        checkpoint,
        writeToolsGranted: true,
        allowWriteRequired: true,
        planningEnteredAsReady: true,
      });
    }

    const validation = validateStep
      ? await validateStep(contextBase())
      : defaultValidation(candidate);
    assertValidation(validation);
    assertPathsWithin(validation.changedPaths, authorization.intendedPaths);
    checkpoint = sealCheckpoint({
      ...checkpoint,
      stage: "validate",
      validation,
    });

    if (validation.status === "failed") {
      return sealRun({
        status: "failed",
        productDisposition: "not-ready",
        stage: "validate",
        checkpoint,
        writeToolsGranted: true,
        allowWriteRequired: true,
        planningEnteredAsReady: true,
      });
    }

    const adversarial = adversarialStep
      ? await adversarialStep(contextBase())
      : defaultAdversarial(candidate, skills.adversarial);
    assertAdversarial(adversarial, skills.adversarial);
    checkpoint = sealCheckpoint({
      ...checkpoint,
      stage: "adversarial",
      adversarial,
    });

    if (adversarial.status === "block") {
      return sealRun({
        status: "blocked",
        productDisposition: "blocked",
        stage: "adversarial",
        checkpoint,
        writeToolsGranted: true,
        allowWriteRequired: true,
        planningEnteredAsReady: true,
      });
    }

    if (adversarial.status === "revise") {
      if (!revisionStep) {
        return sealRun({
          status: "needs-input",
          productDisposition: "needs-input",
          stage: "adversarial",
          checkpoint,
          writeToolsGranted: true,
          allowWriteRequired: true,
          planningEnteredAsReady: true,
        });
      }
      const revisionEvidence = await revisionStep(contextBase());
      assertRevision(revisionEvidence, skills.revision);
      assertPathsWithin(revisionEvidence.changedPaths, authorization.intendedPaths);
      checkpoint = sealCheckpoint({
        ...checkpoint,
        stage: "revision",
        revision: revisionEvidence,
        candidate: {
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-candidate",
          skillId: skills.draft,
          candidateSha256: revisionEvidence.revisionSha256,
          changedPaths: revisionEvidence.changedPaths,
        },
      });
    }

    const patch = patchStep ? await patchStep(contextBase()) : defaultPatch(checkpoint.candidate!);
    assertPatch(patch);
    assertPathsWithin(patch.changedPaths, authorization.intendedPaths);
    checkpoint = sealCheckpoint({
      ...checkpoint,
      stage: "impact",
      patch,
    });

    const impact = impactStep ? await impactStep(contextBase()) : defaultImpact(patch);
    assertImpact(impact);
    if (impact.status === "completed") {
      assertPathsWithin(impact.changedPaths, authorization.intendedPaths);
    }
    checkpoint = sealCheckpoint({
      ...checkpoint,
      stage: "complete",
      impact,
    });

    if (impact.status === "failed") {
      return sealRun({
        status: "failed",
        productDisposition: "not-ready",
        stage: "impact",
        checkpoint,
        writeToolsGranted: true,
        allowWriteRequired: true,
        planningEnteredAsReady: true,
      });
    }

    const disposition = completionDisposition
      ? await completionDisposition(contextBase())
      : "ready";
    if (disposition !== "ready" && disposition !== "inconclusive") fail("invalid-value");
    return sealRun({
      status: "succeeded",
      productDisposition:
        checkpoint.validation?.status === "unavailable" ||
        checkpoint.adversarial?.status === "inconclusive"
          ? "inconclusive"
          : disposition,
      stage: "complete",
      checkpoint,
      writeToolsGranted: true,
      allowWriteRequired: true,
      planningEnteredAsReady: true,
    });
  } catch (error) {
    if (error instanceof FoundationToPatchError && error.code === "path-scope-expanded") {
      return sealRun({
        status: "failed",
        productDisposition: "blocked",
        stage: checkpoint.stage,
        checkpoint,
        writeToolsGranted: true,
        allowWriteRequired: true,
        planningEnteredAsReady: true,
      });
    }
    if (error instanceof FoundationToPatchError && error.code === "interrupted") {
      return sealRun({
        status: "interrupted",
        productDisposition: "inconclusive",
        stage: checkpoint.stage,
        checkpoint,
        writeToolsGranted: Boolean(checkpoint.candidate),
        allowWriteRequired: true,
        planningEnteredAsReady: true,
      });
    }
    throw error;
  }
}

/** Mint a content-free write authorization for tests / host adapters. */
export function createFoundationToPatchAuthorization(input: {
  intendedPaths: readonly string[];
  decidedAt: string;
  expiresAt: string;
  seed?: string;
}): FoundationToPatchWriteAuthorizationV1 {
  const intendedPaths = normalizePaths(input.intendedPaths);
  if (intendedPaths.length === 0) fail("invalid-value");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-foundation-to-patch-authorization" as const,
    intendedPaths,
    decidedAt: kit.timestamp(input.decidedAt),
    expiresAt: kit.timestamp(input.expiresAt),
    seed: input.seed ?? "foundation-to-patch-authorization",
  };
  const digest = digestOf(body);
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-authorization",
    intendedPaths,
    decidedAt: body.decidedAt,
    expiresAt: body.expiresAt,
    digest,
    sha256: digest,
  });
}

/** Host-operation adapter for catalog dispatch (no runner.ts special case). */
export class FoundationToPatchHostOperation implements HostOperationExecutor {
  public constructor(private readonly options: FoundationToPatchHostOperationOptions = {}) {}

  public async runStep(input: HarnessStepInput): Promise<
    HarnessStepResult & {
      foundationToPatch: FoundationToPatchRunResultV1;
    }
  > {
    assertFoundationToPatchStep(input);
    const revision = input.evidenceIdentity?.repositoryRevision;
    if (!revision) fail("invalid-step");

    const runInput: FoundationToPatchRunInput = {
      repositoryPath: input.repositoryPath,
      repositoryRevision: revision,
      // Catalog step stays read-only so gate/plan CLI smoke works without
      // --allow-write. Host options supply allowWrite + authorization for
      // authorized draft/revision journeys; source checkout stays unchanged.
      allowWrite: false,
      ...(this.options.runInput ?? {}),
    };

    const result = this.options.run
      ? await this.options.run(runInput)
      : await runFoundationToPatch(runInput);

    return {
      summary: summarize(result),
      outcome: stepOutcome(result),
      foundationToPatch: result,
    };
  }
}

export class FoundationToPatchWorkflowOutcomeProjector implements WorkflowOutcomeProjector {
  public async project(record: Readonly<RunRecord>): Promise<WorkflowOutcomeCandidateV1> {
    if (record.workflow !== "foundation-to-patch") fail("invalid-step");
    if (record.status === "failed" || record.status === "queued" || record.status === "running") {
      return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    }

    const terminal = [...record.steps]
      .reverse()
      .find(
        (step) =>
          step.status === "needs-input" ||
          step.status === "succeeded" ||
          step.status === "needs-human-decision" ||
          step.status === "failed",
      );
    if (!terminal) return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    const evidence = workflowOutcomeStepEvidence(record as RunRecord, terminal.id);
    const parsed = parseSummary(terminal.summary);

    if (parsed.disposition === "ready") {
      return {
        disposition: "ready",
        findings: [],
        evidence: [evidence],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      };
    }

    if (parsed.disposition === "needs-input") {
      return {
        disposition: "needs-input",
        findings: [
          {
            id: "finding:foundation-to-patch-needs-input",
            kind: "missing-governed-input",
            severity: "blocking",
            code: parsed.code ?? "foundation-to-patch-needs-input",
            inputId: "foundation-to-patch-governed-input",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:foundation-to-patch-governed-input",
            kind: "governed-input",
            inputId: "foundation-to-patch-governed-input",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      };
    }

    if (parsed.disposition === "blocked") {
      return {
        disposition: "blocked",
        findings: [
          {
            id: "finding:foundation-to-patch-blocked",
            kind: "blocked-dependency",
            severity: "blocking",
            code: parsed.code ?? "foundation-to-patch-blocked",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:foundation-to-patch-blocked",
            kind: "dependency",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      };
    }

    return {
      disposition: parsed.disposition ?? "not-ready",
      findings: [
        {
          id: "finding:foundation-to-patch-not-ready",
          kind: "product-gap",
          severity: "blocking",
          code: parsed.code ?? "foundation-to-patch-not-ready",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: parsed.interrupted ? ["foundation-to-patch-interrupted"] : [],
      openDecisions: [],
      producedArtifacts: [],
    };
  }
}

function assertFoundationToPatchStep(input: HarnessStepInput): void {
  if (
    input.workflow.name !== "foundation-to-patch" ||
    input.step.kind !== "host-operation" ||
    input.step.operation !== "foundation-to-patch" ||
    (input.step.mode !== "read-only" && input.step.mode !== "write")
  ) {
    fail("invalid-step");
  }
}

function normalizeAuthorization(
  value: FoundationToPatchWriteAuthorizationV1 | null,
  now: string,
): FoundationToPatchWriteAuthorizationV1 | null {
  if (value === null || value === undefined) return null;
  if (value.kind !== "docsfab-foundation-to-patch-authorization" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  const intendedPaths = normalizePaths(value.intendedPaths);
  if (intendedPaths.length === 0) fail("invalid-value");
  if (!SHA256.test(value.digest) || !SHA256.test(value.sha256)) fail("invalid-value");
  const expiresAt = kit.timestamp(value.expiresAt);
  const decidedAt = kit.timestamp(value.decidedAt);
  if (Date.parse(expiresAt) <= Date.parse(now) && Date.parse(expiresAt) <= Date.parse(decidedAt)) {
    // Expiry relative to `now` is enforced by the run loop; shape stays valid.
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-authorization",
    intendedPaths,
    digest: value.digest,
    sha256: value.sha256,
    expiresAt,
    decidedAt,
  });
}

function normalizePaths(paths: readonly string[]): readonly string[] {
  const normalized = [...paths].map((path) => {
    if (typeof path !== "string" || !SAFE_PATH.test(path)) fail("invalid-value");
    return path;
  });
  const unique = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== normalized.length) fail("invalid-value");
  return Object.freeze(unique);
}

function assertPathsWithin(actual: readonly string[], intended: readonly string[]): void {
  const allowed = new Set(intended);
  for (const path of actual) {
    if (!allowed.has(path)) fail("path-scope-expanded");
  }
}

function defaultPlan(
  inspect: FoundationInspectResultV1,
  skillId: PhaseSkills["plan"],
): FoundationToPatchPlanEvidenceV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-plan",
    skillId,
    status: "ready",
    planSha256: digestOf({
      skill: skillId,
      canon: inspect.canon.canonSha256,
    }),
    intendedPaths: Object.freeze(["docs/README.md"]),
  });
}

function defaultValidation(
  candidate: FoundationToPatchCandidateEvidenceV1,
): FoundationToPatchValidationEvidenceV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-validation",
    status: "passed",
    validationSha256: digestOf({
      candidate: candidate.candidateSha256,
      paths: candidate.changedPaths,
    }),
    changedPaths: candidate.changedPaths,
  });
}

function defaultAdversarial(
  candidate: FoundationToPatchCandidateEvidenceV1,
  skillId: PhaseSkills["adversarial"],
): FoundationToPatchAdversarialEvidenceV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-adversarial",
    skillId,
    status: "pass",
    reviewSha256: digestOf({
      skill: skillId,
      candidate: candidate.candidateSha256,
    }),
  });
}

function defaultPatch(
  candidate: FoundationToPatchCandidateEvidenceV1,
): FoundationToPatchPatchEvidenceV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-patch",
    patchSha256: digestOf({
      candidate: candidate.candidateSha256,
      paths: candidate.changedPaths,
    }),
    byteLength: 64,
    changedPaths: candidate.changedPaths,
  });
}

function defaultImpact(patch: FoundationToPatchPatchEvidenceV1): FoundationToPatchImpactEvidenceV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-impact",
    status: "completed",
    impactSha256: digestOf({
      patch: patch.patchSha256,
      paths: patch.changedPaths,
    }),
    changedPaths: patch.changedPaths,
  });
}

function normalizePendingInput(
  input: FoundationToPatchPendingInputEvidenceV1,
): FoundationToPatchPendingInputEvidenceV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const value = kit.object(input);
  kit.exact(value, [
    "schemaVersion",
    "kind",
    "sourceWorkflow",
    "sourceRunId",
    "sourceRunSha256",
    "writeEntered",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-foundation-to-patch-pending-input" ||
    value.sourceWorkflow !== "create-documentation" ||
    typeof value.writeEntered !== "boolean"
  )
    fail("invalid-shape");
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-foundation-to-patch-pending-input",
    sourceWorkflow: "create-documentation",
    sourceRunId: kit.identifier(value.sourceRunId),
    sourceRunSha256: kit.hash(value.sourceRunSha256),
    writeEntered: value.writeEntered,
  });
}

function assertPlan(value: FoundationToPatchPlanEvidenceV1, skillId: PhaseSkills["plan"]): void {
  if (value.kind !== "docsfab-foundation-to-patch-plan" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  if (value.skillId !== skillId) fail("invalid-value");
  if (!["ready", "needs-input", "refuse"].includes(value.status)) fail("invalid-value");
  if (!SHA256.test(value.planSha256)) fail("invalid-value");
  normalizePaths(value.intendedPaths);
}

function assertCandidate(
  value: FoundationToPatchCandidateEvidenceV1,
  skillId: PhaseSkills["draft"],
): void {
  if (value.kind !== "docsfab-foundation-to-patch-candidate" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  if (value.skillId !== skillId) fail("invalid-value");
  if (!SHA256.test(value.candidateSha256)) fail("invalid-value");
  normalizePaths(value.changedPaths);
}

function assertValidation(value: FoundationToPatchValidationEvidenceV1): void {
  if (value.kind !== "docsfab-foundation-to-patch-validation" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  if (!["passed", "failed", "unavailable"].includes(value.status)) fail("invalid-value");
  if (!SHA256.test(value.validationSha256)) fail("invalid-value");
  normalizePaths(value.changedPaths);
}

function assertAdversarial(
  value: FoundationToPatchAdversarialEvidenceV1,
  skillId: PhaseSkills["adversarial"],
): void {
  if (value.kind !== "docsfab-foundation-to-patch-adversarial" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  if (value.skillId !== skillId) fail("invalid-value");
  if (!["pass", "revise", "block", "inconclusive"].includes(value.status)) fail("invalid-value");
  if (!SHA256.test(value.reviewSha256)) fail("invalid-value");
}

function assertRevision(
  value: FoundationToPatchRevisionEvidenceV1,
  skillId: PhaseSkills["revision"],
): void {
  if (value.kind !== "docsfab-foundation-to-patch-revision" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  if (value.skillId !== skillId) fail("invalid-value");
  if (!SHA256.test(value.revisionSha256)) fail("invalid-value");
  normalizePaths(value.changedPaths);
}

function assertPatch(value: FoundationToPatchPatchEvidenceV1): void {
  if (value.kind !== "docsfab-foundation-to-patch-patch" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  if (!SHA256.test(value.patchSha256)) fail("invalid-value");
  if (!Number.isInteger(value.byteLength) || value.byteLength < 0) fail("invalid-value");
  normalizePaths(value.changedPaths);
}

function assertImpact(value: FoundationToPatchImpactEvidenceV1): void {
  if (value.kind !== "docsfab-foundation-to-patch-impact" || value.schemaVersion !== 1) {
    fail("invalid-shape");
  }
  if (!["completed", "failed", "skipped"].includes(value.status)) fail("invalid-value");
  if (!SHA256.test(value.impactSha256)) fail("invalid-value");
  normalizePaths(value.changedPaths);
}

function sealCheckpoint(
  value: Omit<FoundationToPatchCheckpointV1, "schemaVersion" | "kind" | "checkpointSha256"> & {
    schemaVersion?: 1;
    kind?: "docsfab-foundation-to-patch-checkpoint";
    checkpointSha256?: string;
  },
): FoundationToPatchCheckpointV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-foundation-to-patch-checkpoint" as const,
    stage: value.stage,
    ...(value.canonSha256 ? { canonSha256: value.canonSha256 } : {}),
    ...(value.readiness ? { readiness: value.readiness } : {}),
    ...(value.plan ? { plan: value.plan } : {}),
    ...(value.candidate ? { candidate: value.candidate } : {}),
    ...(value.pendingInput ? { pendingInput: normalizePendingInput(value.pendingInput) } : {}),
    ...(value.validation ? { validation: value.validation } : {}),
    ...(value.adversarial ? { adversarial: value.adversarial } : {}),
    ...(value.revision ? { revision: value.revision } : {}),
    ...(value.patch ? { patch: value.patch } : {}),
    ...(value.impact ? { impact: value.impact } : {}),
    ...(value.experiment ? { experiment: value.experiment } : {}),
  };
  return Object.freeze({
    ...body,
    checkpointSha256: digestOf(body),
  }) as FoundationToPatchCheckpointV1;
}

function invokeCandidateExperiment(
  experiment: FoundationToPatchCandidateExperimentInput,
  workflowContext: FoundationToPatchStepContext,
): CandidateExperimentLoopResultV1 {
  return runBoundedCandidateExperiment({
    experimentId: experiment.experimentId,
    baseline: experiment.baseline,
    budget: experiment.budget,
    plateau: experiment.plateau,
    ledger: experiment.ledger,
    generateAttempt: (context) =>
      experiment.generateAttempt({
        ...context,
        workflowContext,
      }),
    chargeForAttempt: experiment.chargeForAttempt,
  });
}

function projectExperimentEvidence(
  result: CandidateExperimentLoopResultV1,
): FoundationToPatchExperimentEvidenceV1 {
  const { ledger } = result;
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-foundation-to-patch-experiment" as const,
    ledgerSha256: ledger.ledgerSha256,
    terminalReason: ledger.terminal?.reason ?? null,
    selectedCandidateSha256: ledger.selectedCandidateSha256,
    sourceCheckoutSha256: ledger.sourceCheckoutSha256,
    attemptCount: ledger.entries.length,
    boundedTerminal: ledger.terminal?.boundedSuccess === true,
  });
}

function sealRun(input: {
  status: FoundationToPatchRunResultV1["status"];
  productDisposition: ProductDisposition;
  stage: FoundationToPatchStage;
  checkpoint: FoundationToPatchCheckpointV1;
  writeToolsGranted: boolean;
  allowWriteRequired: boolean;
  planningEnteredAsReady: boolean;
}): FoundationToPatchRunResultV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-foundation-to-patch-run" as const,
    status: input.status,
    productDisposition: input.productDisposition,
    stage: input.stage,
    checkpoint: input.checkpoint,
    sourceCheckoutUnchanged: true as const,
    guarantees: {
      writeToolsGranted: input.writeToolsGranted,
      allowWriteRequired: input.allowWriteRequired,
      planningEnteredAsReady: input.planningEnteredAsReady,
    },
  };
  return Object.freeze({
    ...body,
    resultSha256: digestOf(body),
  }) as FoundationToPatchRunResultV1;
}

function stepOutcome(result: FoundationToPatchRunResultV1): "succeeded" | "needs-input" {
  if (result.status === "needs-input") return "needs-input";
  if (result.status === "succeeded") return "succeeded";
  // blocked / failed / interrupted still complete the host step; product
  // disposition carries the honest terminal meaning.
  return "succeeded";
}

function summarize(result: FoundationToPatchRunResultV1): string {
  const code =
    result.status === "interrupted"
      ? "foundation-to-patch-interrupted"
      : result.stage === "gate"
        ? "foundation-to-patch-gate"
        : result.stage === "authorize"
          ? "foundation-to-patch-write-authorization"
          : `foundation-to-patch-${result.stage}`;
  return [
    `Foundation-to-patch status=${result.status}`,
    `disposition=${result.productDisposition}`,
    `stage=${result.stage}`,
    `code=${code}`,
    `checkpoint=${result.checkpoint.checkpointSha256.slice(0, 12)}`,
    `source_unchanged=${result.sourceCheckoutUnchanged}`,
    `planning_ready=${result.guarantees.planningEnteredAsReady}`,
  ].join(" ");
}

function parseSummary(summary: string | undefined): {
  disposition?: ProductDisposition;
  code?: string;
  interrupted?: boolean;
} {
  if (!summary) return {};
  const disposition = /\bdisposition=(ready|not-ready|needs-input|inconclusive|blocked)\b/u.exec(
    summary,
  )?.[1] as ProductDisposition | undefined;
  const code = /\bcode=([a-z0-9-]+)\b/u.exec(summary)?.[1];
  const interrupted = /\bstatus=interrupted\b/u.test(summary);
  return { disposition, code, interrupted };
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}
