// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Product outcome projector for authoring and short quality jobs.
 *
 * Maps admitted evaluate-document-quality step evidence to `inconclusive`
 * limitation codes. Never infers `ready` from a successful model call, a
 * Green band, or an experimental quality profile. The evaluator's own
 * decision and hard-gate failures are carried as advisory findings:
 * model-authored evidence, never a product verdict.
 */

import type { ArtifactReference } from "../artifacts/index.js";
import { validateArtifactReference } from "../artifacts/validate.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import type { RunRecord } from "../records/contracts.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import {
  decodeRetainedAuthoringWorkflowV1,
  validateAuthoringRunRecordV1,
} from "../records/authoring-execution.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { isWorkflowManifestV3 } from "../workflow-contracts/contracts.js";
import type {
  WorkflowName,
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import {
  decodeRunRecordEditorialEvidence,
  defaultInconclusiveWorkflowOutcome,
  isWorkflowOutcomeCode,
  WORKFLOW_OUTCOME_ROOT_LOCATION,
  type WorkflowOutcomeDecodeOptionsV1,
  workflowOutcomeArtifactEvidence,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";
import {
  admitPlannerDiagnostic,
  isPlannerMissingGovernedInputCode,
} from "../workflow-contracts/planner-diagnostic.js";
import { admitPlanScopeStop, planScopeStopInputId } from "../workflow-contracts/plan-scope-stop.js";
import {
  admitWriterNoChangeStop,
  writerNoChangeStopInputId,
} from "../workflow-contracts/writer-no-change-stop.js";
import { AUTHORING_QUALITY_OUTCOME_WORKFLOWS } from "../workflow-contracts/authoring-workflows.js";
import {
  QUALITY_REPORT_DECISIONS,
  projectQualityReportFromRun,
  type QualityReportDecision,
} from "./contracts.js";

export { AUTHORING_QUALITY_OUTCOME_WORKFLOWS };

export type AuthoringQualityOutcomeWorkflow = (typeof AUTHORING_QUALITY_OUTCOME_WORKFLOWS)[number];

const AUTHORING_QUALITY_OUTCOME_WORKFLOW_SET: ReadonlySet<string> = new Set(
  AUTHORING_QUALITY_OUTCOME_WORKFLOWS,
);

const EVALUATE_STEP_ID = "evaluate-document-quality";
const EVALUATE_SKILL_ID = "evaluate-document-quality";
const PLANNER_STEP_ID = "plan-documentation";

export const AUTHORING_QUALITY_LIMITATION_CODES = [
  "experimental-quality-profile",
  "insufficient-evidence",
  "quality-rubric-unavailable",
] as const;

export type AuthoringQualityLimitationCode = (typeof AUTHORING_QUALITY_LIMITATION_CODES)[number];

const QUALITY_EVALUATION_CODE_PREFIX = "quality-evaluation.";
const QUALITY_HARD_GATE_CODE_PREFIX = "quality-hard-gate.";
/**
 * A reported hard-gate failure that cannot become an outcome code (not a
 * string, outside the code grammar, or credential-shaped). Reported under this
 * code, never dropped.
 */
export const QUALITY_HARD_GATE_UNREPRESENTABLE_CODE = "quality-hard-gate-unrepresentable";

/**
 * Codes the authoring path derives from the evaluate and audience steps. None
 * is caused by the request, so NEXT (`run-next-action.ts`) never names one as a
 * capability wall on an authoring job. `standing` holds design-fixed
 * limitations; `advisory` holds the evaluator's model-authored decision and
 * hard-gate failures. NEXT reads this list through
 * {@link classifyAuthoringQualityNonWallCode}.
 */
export const AUTHORING_QUALITY_NON_WALL_CODES = Object.freeze({
  standing: AUTHORING_QUALITY_LIMITATION_CODES,
  advisory: Object.freeze([
    ...QUALITY_REPORT_DECISIONS.map(
      (decision) => `${QUALITY_EVALUATION_CODE_PREFIX}${decision}` as const,
    ),
    QUALITY_HARD_GATE_UNREPRESENTABLE_CODE,
  ]),
  advisoryPrefixes: Object.freeze([QUALITY_HARD_GATE_CODE_PREFIX]),
});

export type AuthoringQualityNonWallCodeClass = "standing" | "advisory";

/**
 * The class of a code in {@link AUTHORING_QUALITY_NON_WALL_CODES}, otherwise
 * `undefined`; an unclassified code (such as `product-gap.*`) stays a wall.
 */
export function classifyAuthoringQualityNonWallCode(
  code: string,
): AuthoringQualityNonWallCodeClass | undefined {
  const codes = AUTHORING_QUALITY_NON_WALL_CODES;
  if ((codes.standing as readonly string[]).includes(code)) return "standing";
  if ((codes.advisory as readonly string[]).includes(code)) return "advisory";
  if (codes.advisoryPrefixes.some((prefix) => code.startsWith(prefix))) return "advisory";
  return undefined;
}

export type AuthoringQualityWorkflowOutcomeErrorCode = "invalid-workflow" | "invalid-record";

/**
 * Contract-style reject when the projector is applied outside authoring jobs
 * or to a record it cannot seal from admitted evidence.
 */
export class AuthoringQualityWorkflowOutcomeError extends Error {
  /**
   * The `$`-rooted run-record member the refusing rule read, such as
   * `$.steps[].planDiagnostic`; array members are `[]`, never an index. It
   * becomes the projection-phase `workflowOutcomeRejection.location`.
   * Non-enumerable, as on `WorkflowOutcomeError`, so the error's identity stays
   * its code.
   */
  public declare readonly location: string;

  public constructor(
    public readonly code: AuthoringQualityWorkflowOutcomeErrorCode,
    location: string = WORKFLOW_OUTCOME_ROOT_LOCATION,
  ) {
    super(messageFor(code));
    this.name = "AuthoringQualityWorkflowOutcomeError";
    Object.defineProperty(this, "location", {
      value: location,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

function messageFor(code: AuthoringQualityWorkflowOutcomeErrorCode): string {
  switch (code) {
    case "invalid-workflow":
      return "Authoring quality outcome projector rejects records that are not an authoring workflow.";
    case "invalid-record":
      return "Authoring quality outcome projector rejects records that cannot be sealed from admitted evidence.";
  }
}

export function isAuthoringQualityOutcomeWorkflow(
  workflow: string,
): workflow is AuthoringQualityOutcomeWorkflow {
  return AUTHORING_QUALITY_OUTCOME_WORKFLOW_SET.has(workflow);
}

export class AuthoringQualityWorkflowOutcomeProjector implements WorkflowOutcomeProjector {
  public async project(
    record: Readonly<RunRecord>,
    decodeOptions: WorkflowOutcomeDecodeOptionsV1 = {},
  ): Promise<WorkflowOutcomeCandidateV1> {
    if (!isAuthoringQualityOutcomeWorkflow(record.workflow)) {
      throw new AuthoringQualityWorkflowOutcomeError("invalid-workflow", "$.workflow"); // hygiene: ok
    }
    // A planner needs-input stop is a supported outcome; every other
    // unfinished status cannot be sealed.
    if (record.status !== "succeeded" && record.status !== "needs-input") {
      throw new AuthoringQualityWorkflowOutcomeError("invalid-record", "$.status"); // hygiene: ok
    }
    if (
      record.authoringExecution !== undefined ||
      record.steps.some(
        (step) =>
          step.authoringPhase !== undefined ||
          ("authoringRevisionAccounting" in step &&
            (step as { authoringRevisionAccounting?: unknown }).authoringRevisionAccounting !==
              undefined),
      )
    ) {
      try {
        const installedWorkflow = getWorkflow(record.workflow);
        const retainedWorkflow = record.authoringExecution
          ? decodeRetainedAuthoringWorkflowV1(record.authoringExecution)
          : null;
        // A retained V3 envelope is the exact workflow identity for this
        // record. The catalog may have advanced since the run completed.
        const workflow =
          retainedWorkflow && isWorkflowManifestV3(retainedWorkflow)
            ? retainedWorkflow
            : isWorkflowManifestV3(installedWorkflow)
              ? installedWorkflow
              : null;
        if (!workflow || !isWorkflowManifestV3(workflow)) {
          throw new Error("CREATE V3 workflow manifest is unavailable for record validation.");
        }
        validateAuthoringRunRecordV1(record, workflow, {
          requireTerminalSuccess: record.status === "succeeded",
        });
      } catch {
        throw new AuthoringQualityWorkflowOutcomeError("invalid-record", "$.authoringExecution"); // hygiene: ok
      }
    }

    const mutable = record as RunRecord;
    if (record.status === "needs-input") {
      // The host's three coded needs-input stops: the planner's governed-input
      // diagnostic, the writer's plan-scope stop, and the writer's no-change
      // stop. Anything else is refused.
      const stop =
        plannerGovernedInputOutcome(mutable) ??
        planScopeGovernedInputOutcome(mutable) ??
        writerNoChangeGovernedInputOutcome(mutable);
      if (!stop) {
        // hygiene: ok
        throw new AuthoringQualityWorkflowOutcomeError(
          "invalid-record",
          record.steps.some((step) => step.planScopeStop !== undefined)
            ? "$.steps[].planScopeStop"
            : record.steps.some((step) => step.writerNoChangeStop !== undefined)
              ? "$.steps[].writerNoChangeStop"
              : "$.steps[].planDiagnostic",
        );
      }
      return stop;
    }
    const evaluator = [...record.steps]
      .reverse()
      .find(
        (step) =>
          step.id === EVALUATE_STEP_ID &&
          step.skill === EVALUATE_SKILL_ID &&
          step.status === "succeeded",
      );
    if (!evaluator) return defaultInconclusiveWorkflowOutcome(mutable);

    if (record.workflowBranchCoverage !== undefined) {
      const editorial = decodeRunRecordEditorialEvidence(mutable, decodeOptions);
      if (editorial.state !== "current" || !editorial.validated) {
        // hygiene: ok
        throw new AuthoringQualityWorkflowOutcomeError(
          "invalid-record",
          "$.workflowBranchCoverage",
        );
      }
      const final = editorial.validated;
      const hasBoundProductGap =
        final.candidate === "update" &&
        final.limitations.some((limitation) => limitation.startsWith("product-gap."));
      if (final.candidate === editorial.candidate.candidate && !hasBoundProductGap) {
        return validatedEditorialOutcome(mutable, evaluator.id, final.limitations);
      }
      if (final.candidate === "no-change") {
        // hygiene: ok
        throw new AuthoringQualityWorkflowOutcomeError(
          "invalid-record",
          "$.artifacts[].reference.candidate",
        );
      }
      return validatedEditorialReversalOutcome(mutable, final.candidate, final.limitations);
    }

    const validatedQuality = projectQualityReportFromRun(mutable);
    const parsed = validatedQuality
      ? {
          evaluation: {
            decision: validatedQuality.decision,
            hard_gate_failures: [...validatedQuality.hardGateFailures],
          },
          rubric: { status: validatedQuality.rubric.status },
        }
      : parseEvaluateJson(evaluator.summary);
    if (!parsed) return defaultInconclusiveWorkflowOutcome(mutable);

    const audience = audienceStep(record);
    const codes = new Set(limitationCodesFromEvaluateJson(parsed));
    const audienceInsufficient = audienceEvidenceIsInsufficient(record, audience);
    if (audienceInsufficient) {
      codes.add("insufficient-evidence");
    }
    const orderedCodes = AUTHORING_QUALITY_LIMITATION_CODES.filter((code) => codes.has(code));
    const advisoryCodes = advisoryCodesFromEvaluateJson(parsed);
    const evidence = workflowOutcomeStepEvidence(mutable, evaluator.id);
    const audienceEvidence =
      audienceInsufficient && audience
        ? workflowOutcomeStepEvidence(mutable, audience.id)
        : undefined;
    const artifacts = recordOutputArtifacts(mutable);
    return {
      // Never inferred ready: a `pass` decision stays an advisory finding.
      disposition: "inconclusive",
      findings: [
        ...orderedCodes.map((code) => ({
          id: `finding:authoring-quality:${code}`,
          kind: "evidence-limitation" as const,
          severity: "warning" as const,
          code,
          evidenceIds:
            code === "insufficient-evidence" && audienceInsufficient && audienceEvidence
              ? [evidence.id, audienceEvidence.id]
              : [evidence.id],
        })),
        // Findings, not `limitations`: they report what the model concluded,
        // not what the evidence could not establish.
        ...advisoryCodes.map((code) => ({
          id: `finding:authoring-quality:${code}`,
          kind: "evidence-limitation" as const,
          severity: "warning" as const,
          code,
          evidenceIds: [evidence.id],
        })),
      ],
      evidence: audienceEvidence ? [evidence, audienceEvidence] : [evidence],
      limitations: orderedCodes,
      openDecisions: [],
      producedArtifacts: artifacts,
    };
  }
}

const PLANNER_GOVERNED_INPUT_PREFIX = "documentation-plan";

/**
 * The product outcome for a planner needs-input stop, or `undefined` when the
 * record is not one. Binds the admitted, content-free `planDiagnostic` code
 * one-to-one to a `governed-input` open decision on the planner step's
 * evidence, as the outcome contract requires of `needs-input`. Reads no
 * planner prose.
 */
export function plannerGovernedInputOutcome(
  record: RunRecord,
): WorkflowOutcomeCandidateV1 | undefined {
  if (record.status !== "needs-input" || !isAuthoringQualityOutcomeWorkflow(record.workflow)) {
    return undefined;
  }
  const diagnostic = admitPlannerDiagnostic(record);
  if (!diagnostic || !isPlannerMissingGovernedInputCode(diagnostic.code)) return undefined;
  const stopped = record.steps.filter((step) => step.status === "needs-input");
  if (stopped.length !== 1 || stopped[0]!.id !== PLANNER_STEP_ID) return undefined;
  const evidence = workflowOutcomeStepEvidence(record, PLANNER_STEP_ID);
  const inputId = `${PLANNER_GOVERNED_INPUT_PREFIX}:${diagnostic.code}`;
  return {
    disposition: "needs-input",
    findings: [
      {
        id: `finding:${inputId}`,
        kind: "missing-governed-input",
        severity: "blocking",
        code: diagnostic.code,
        inputId,
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    limitations: [],
    openDecisions: [
      {
        id: `decision:${inputId}`,
        kind: "governed-input",
        inputId,
        evidenceIds: [evidence.id],
      },
    ],
    producedArtifacts: recordOutputArtifacts(record),
  };
}

/**
 * The product outcome for a writer plan-scope stop, or `undefined` when the
 * record is not one. Binds the admitted, content-free `planScopeStop` code
 * one-to-one to a `governed-input` open decision on the stopped write step's
 * evidence, in the planner's `documentation-plan:` input namespace. Reads no
 * writer prose.
 */
export function planScopeGovernedInputOutcome(
  record: RunRecord,
): WorkflowOutcomeCandidateV1 | undefined {
  if (record.status !== "needs-input" || !isAuthoringQualityOutcomeWorkflow(record.workflow)) {
    return undefined;
  }
  const stop = admitPlanScopeStop(record);
  if (!stop) return undefined;
  return writerStepGovernedInputOutcome(
    record,
    stop.stepId,
    stop.code,
    planScopeStopInputId(stop.code),
  );
}

/**
 * The product outcome for a writer no-change stop, or `undefined` when the
 * record is not one. Binds the admitted, content-free `writerNoChangeStop`
 * code one-to-one to a `governed-input` open decision on the stopped write
 * step's evidence, in the planner's `documentation-plan:` input namespace.
 * Reads no writer prose.
 */
export function writerNoChangeGovernedInputOutcome(
  record: RunRecord,
): WorkflowOutcomeCandidateV1 | undefined {
  if (record.status !== "needs-input" || !isAuthoringQualityOutcomeWorkflow(record.workflow)) {
    return undefined;
  }
  const stop = admitWriterNoChangeStop(record);
  if (!stop) return undefined;
  return writerStepGovernedInputOutcome(
    record,
    stop.stepId,
    stop.code,
    writerNoChangeStopInputId(stop.code),
  );
}

function writerStepGovernedInputOutcome(
  record: RunRecord,
  stepId: string,
  code: string,
  inputId: string,
): WorkflowOutcomeCandidateV1 {
  const evidence = workflowOutcomeStepEvidence(record, stepId);
  return {
    disposition: "needs-input",
    findings: [
      {
        id: `finding:${inputId}`,
        kind: "missing-governed-input",
        severity: "blocking",
        code,
        inputId,
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    limitations: [],
    openDecisions: [
      {
        id: `decision:${inputId}`,
        kind: "governed-input",
        inputId,
        evidenceIds: [evidence.id],
      },
    ],
    producedArtifacts: recordOutputArtifacts(record),
  };
}

function validatedEditorialReversalOutcome(
  record: RunRecord,
  candidate: "update" | "insufficient-evidence",
  limitations: readonly string[],
): WorkflowOutcomeCandidateV1 {
  const evidence = [
    ...record.steps.map((step) => workflowOutcomeStepEvidence(record, step.id)),
    ...(record.artifacts ?? []).map((use) => workflowOutcomeArtifactEvidence(record, use)),
  ];
  const codes = limitations.filter((code) =>
    candidate === "update"
      ? code.startsWith("product-gap.")
      : code.startsWith("evidence-limitation."),
  );
  if (codes.length === 0) {
    // hygiene: ok
    throw new AuthoringQualityWorkflowOutcomeError(
      "invalid-record",
      "$.artifacts[].reference.limitations",
    );
  }
  return {
    disposition: candidate === "update" ? "not-ready" : "inconclusive",
    findings: codes.map((code) => ({
      id: `finding:authoring-quality:${code}`,
      kind: candidate === "update" ? "product-gap" : "evidence-limitation",
      severity: candidate === "update" ? "blocking" : "warning",
      code,
      evidenceIds: evidence.map((entry) => entry.id),
    })),
    evidence,
    limitations: candidate === "update" ? [] : [...codes],
    openDecisions: [],
    producedArtifacts: recordOutputArtifacts(record),
  };
}

function validatedEditorialOutcome(
  record: RunRecord,
  evaluatorId: string,
  editorialLimitations: readonly string[],
): WorkflowOutcomeCandidateV1 {
  const stepEvidence = record.steps.map((step) => workflowOutcomeStepEvidence(record, step.id));
  const artifactEvidence = (record.artifacts ?? []).map((use) =>
    workflowOutcomeArtifactEvidence(record, use),
  );
  const evidence = [...stepEvidence, ...artifactEvidence];
  const audience = audienceStep(record);
  const audienceEvidence = audience
    ? workflowOutcomeStepEvidence(record, audience.id)
    : workflowOutcomeStepEvidence(record, evaluatorId);
  const limitations = [
    ...new Set(["experimental-quality-profile", "insufficient-evidence", ...editorialLimitations]),
  ];
  return {
    disposition: "inconclusive",
    findings: limitations.map((code) => ({
      id: `finding:authoring-quality:${code}`,
      kind: "evidence-limitation" as const,
      severity: "warning" as const,
      code,
      evidenceIds:
        code === "insufficient-evidence"
          ? [audienceEvidence.id]
          : evidence.map((entry) => entry.id),
    })),
    evidence,
    limitations,
    openDecisions: [],
    producedArtifacts: recordOutputArtifacts(record),
  };
}

function audienceStep(record: Readonly<RunRecord>) {
  return record.steps.find(
    (step) =>
      step.id === "test-audience-understanding" &&
      step.skill === "test-audience-understanding" &&
      step.status === "succeeded",
  );
}

function audienceEvidenceIsInsufficient(
  record: Readonly<RunRecord>,
  audience: Readonly<RunRecord["steps"][number]> | undefined,
): boolean {
  // Without a host-admitted semantic validator receipt or host-known content
  // identity, create and update stay insufficient even when the artifact
  // reports direct outcome evidence. The summary is still retained as evidence.
  if (record.workflow === "create-documentation" || record.workflow === "update-documentation") {
    return true;
  }
  if (!audience) {
    return false;
  }

  const parsed = parseEvaluateJson(audience.summary);
  if (!parsed) return true;

  const evidenceStatus = jsonString(parsed.evidence_status) ?? jsonString(parsed.status);
  if (evidenceStatus !== "direct-outcome-evidence") return true;

  const target = jsonObject(parsed.target);
  if (
    !target ||
    !jsonString(target.repository_revision) ||
    !jsonString(target.documentation_revision)
  ) {
    return true;
  }

  const reason = jsonString(parsed.reason);
  return reason === "candidate-revision-mismatch" || reason === "audience-artifact-invalid";
}

function parseEvaluateJson(
  summary: string | undefined,
): { [key: string]: JsonEvidenceValue } | undefined {
  if (summary === undefined || summary.trim().length === 0) return undefined;
  try {
    const value = parseJsonEvidence(summary.trim());
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function limitationCodesFromEvaluateJson(root: {
  [key: string]: JsonEvidenceValue;
}): AuthoringQualityLimitationCode[] {
  // `insufficient-evidence` here is only the audience rule's; the evaluator's
  // own decision becomes the advisory `quality-evaluation.insufficient-evidence`.
  const codes = new Set<AuthoringQualityLimitationCode>(["experimental-quality-profile"]);
  if (rubricUnavailable(root)) {
    codes.add("quality-rubric-unavailable");
  }
  return AUTHORING_QUALITY_LIMITATION_CODES.filter((code) => codes.has(code));
}

/**
 * Advisory codes for the evaluator's decision and the evaluation object's
 * root-level `hard_gate_failures`. A non-array value, or an entry that cannot
 * become an outcome code, adds {@link QUALITY_HARD_GATE_UNREPRESENTABLE_CODE}
 * instead of being dropped. Per-layer `layers.*.hard_gate_failures` are not
 * read.
 */
function advisoryCodesFromEvaluateJson(root: { [key: string]: JsonEvidenceValue }): string[] {
  const codes: string[] = [];
  const decision = readDecision(root);
  if (decision !== undefined) codes.push(`${QUALITY_EVALUATION_CODE_PREFIX}${decision}`);
  const failures = evaluationObject(root)?.hard_gate_failures;
  if (failures === undefined) return codes;
  const gates = Array.isArray(failures)
    ? failures.map(hardGateCode)
    : [QUALITY_HARD_GATE_UNREPRESENTABLE_CODE];
  return [...codes, ...[...new Set(gates)].sort()];
}

function hardGateCode(gate: JsonEvidenceValue): string {
  if (!isWorkflowOutcomeCode(gate)) return QUALITY_HARD_GATE_UNREPRESENTABLE_CODE;
  const code = `${QUALITY_HARD_GATE_CODE_PREFIX}${gate}`;
  // The outcome seal refuses a configured credential anywhere in the
  // candidate, so a gate id holding one would fail the whole run's seal.
  return isWorkflowOutcomeCode(code) && !containsConfiguredCredential(code)
    ? code
    : QUALITY_HARD_GATE_UNREPRESENTABLE_CODE;
}

function evaluationObject(root: {
  [key: string]: JsonEvidenceValue;
}): { [key: string]: JsonEvidenceValue } | undefined {
  return jsonObject(root.evaluation) ?? artifactEntry(root, "evaluation.json");
}

function readDecision(root: {
  [key: string]: JsonEvidenceValue;
}): QualityReportDecision | undefined {
  const evaluation = evaluationObject(root);
  const candidates = [
    root.status,
    root.overall_decision,
    evaluation?.decision,
    evaluation?.overall_decision,
    evaluation?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isQualityReportDecision(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function rubricUnavailable(root: { [key: string]: JsonEvidenceValue }): boolean {
  // A `null` `qualityScore` in the staged envelope means no score was
  // produced, reported as an unavailable rubric; an absent key says nothing.
  if ("qualityScore" in root && root.qualityScore === null) return true;
  const rubric =
    jsonObject(root.rubric) ??
    jsonObject(root.qualityScore) ??
    jsonObject(root.quality_score) ??
    jsonObject(jsonObject(root.step_evidence)?.rubric_score) ??
    artifactEntry(root, "quality-score.json");
  return jsonString(rubric?.status) === "unavailable";
}

function artifactEntry(
  root: { [key: string]: JsonEvidenceValue },
  name: string,
): { [key: string]: JsonEvidenceValue } | undefined {
  const artifacts = jsonObject(root.artifacts);
  if (!artifacts) return undefined;
  const entry = jsonObject(artifacts[name]);
  if (!entry) return undefined;
  return jsonObject(entry.content) ?? entry;
}

function jsonObject(
  value: JsonEvidenceValue | undefined,
): { [key: string]: JsonEvidenceValue } | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function jsonString(value: JsonEvidenceValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isQualityReportDecision(value: string): value is QualityReportDecision {
  return (QUALITY_REPORT_DECISIONS as readonly string[]).includes(value);
}

function recordOutputArtifacts(record: RunRecord): ArtifactReference[] {
  const output: ArtifactReference[] = [];
  for (const use of record.artifacts ?? []) {
    if (
      use.role !== "output" ||
      output.some((item) => canonicalJson(item) === canonicalJson(use.reference))
    ) {
      continue;
    }
    try {
      output.push(validateArtifactReference(use.reference));
    } catch {
      throw new AuthoringQualityWorkflowOutcomeError("invalid-record", "$.artifacts[].reference"); // hygiene: ok
    }
  }
  return output.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}
