// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCandidateDialect, deepFreeze } from "./candidate-dialect.js";

export type CandidateDialectFail = (
  code:
    | "invalid-shape"
    | "invalid-value"
    | "digest-mismatch"
    | "credential-material"
    | "schema-mismatch"
    | "migration-required"
    | "objective-regression"
    | "budget-exhausted"
    | "plateau"
    | "replay-duplicate"
    | "workspace-isolation",
) => never;

export class CandidateExperimentError extends Error {
  public constructor(
    public readonly code:
      | "invalid-shape"
      | "invalid-value"
      | "digest-mismatch"
      | "credential-material"
      | "schema-mismatch"
      | "migration-required"
      | "objective-regression"
      | "budget-exhausted"
      | "plateau"
      | "replay-duplicate"
      | "workspace-isolation",
  ) {
    super(`Candidate experiment rejected: ${code}.`);
    this.name = "CandidateExperimentError";
  }
}

export function candidateFail(code: CandidateExperimentError["code"]): never {
  throw new CandidateExperimentError(code);
}

const kit = createCandidateDialect(candidateFail as CandidateDialectFail);

/** Objective gates — failure always discards; cannot be offset by style. */
export const CANDIDATE_OBJECTIVE_DIMENSIONS = [
  "factual",
  "citation",
  "security",
  "scope",
  "mechanical",
] as const;
export type CandidateObjectiveDimension = (typeof CANDIDATE_OBJECTIVE_DIMENSIONS)[number];

/** Quality dimensions — compared lexicographically only after objectives pass. */
export const CANDIDATE_QUALITY_DIMENSIONS = ["clarity", "coverage", "style"] as const;
export type CandidateQualityDimension = (typeof CANDIDATE_QUALITY_DIMENSIONS)[number];

export const CANDIDATE_GATE_RESULTS = ["pass", "fail"] as const;
export type CandidateGateResult = (typeof CANDIDATE_GATE_RESULTS)[number];

export const CANDIDATE_EVALUATOR_INDEPENDENCE = [
  "independent",
  "baseline-dependent",
  "advisory",
] as const;
export type CandidateEvaluatorIndependence = (typeof CANDIDATE_EVALUATOR_INDEPENDENCE)[number];

export interface CandidateObjectiveVectorV1 {
  factual: CandidateGateResult;
  citation: CandidateGateResult;
  security: CandidateGateResult;
  scope: CandidateGateResult;
  mechanical: CandidateGateResult;
}

export interface CandidateQualityVectorV1 {
  /** Non-negative integers; higher is better. Style cannot offset objectives. */
  clarity: number;
  coverage: number;
  style: number;
}

export interface CandidateEvaluationVectorV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-evaluation-vector";
  objective: CandidateObjectiveVectorV1;
  quality: CandidateQualityVectorV1;
  evaluationSha256: string;
}

export interface CandidateEvaluatorRecordV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-evaluator-record";
  /** Content-free evaluator identity (policy-bound id, not host path). */
  evaluatorId: string;
  policySha256: string;
  inputSha256: string;
  /** Content-free identities of the commands actually run. */
  commandsRun: readonly string[];
  resultSha256: string;
  independence: CandidateEvaluatorIndependence;
  recordSha256: string;
}

export interface CandidateBaselineV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-baseline";
  /** Source checkout identity; never mutated by disposable candidates. */
  sourceCheckoutSha256: string;
  /** May equal the baseline on the first attempt. */
  selectedCandidateSha256: string;
  evaluation: CandidateEvaluationVectorV1;
  baselineSha256: string;
}

export interface CandidateAttemptInputV1 {
  attemptIndex: number;
  /** Never the source checkout. */
  disposableWorkspaceId: string;
  candidateSha256: string;
  baselineSha256: string;
  sourceCheckoutSha256: string;
  evaluation: Omit<CandidateEvaluationVectorV1, "schemaVersion" | "kind" | "evaluationSha256"> & {
    schemaVersion?: 1;
    kind?: "docsfab-candidate-evaluation-vector";
    evaluationSha256?: string;
  };
  evaluators: ReadonlyArray<
    Omit<CandidateEvaluatorRecordV1, "schemaVersion" | "kind" | "recordSha256"> & {
      schemaVersion?: 1;
      kind?: "docsfab-candidate-evaluator-record";
      recordSha256?: string;
    }
  >;
}

export interface CandidateAttemptV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-attempt";
  attemptIndex: number;
  disposableWorkspaceId: string;
  candidateSha256: string;
  baselineSha256: string;
  sourceCheckoutSha256: string;
  evaluation: CandidateEvaluationVectorV1;
  evaluators: readonly CandidateEvaluatorRecordV1[];
  attemptSha256: string;
}

export function sealCandidateEvaluationVector(
  input: Omit<CandidateEvaluationVectorV1, "schemaVersion" | "kind" | "evaluationSha256"> & {
    schemaVersion?: 1;
    kind?: "docsfab-candidate-evaluation-vector";
    evaluationSha256?: string;
  },
): CandidateEvaluationVectorV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const objective = normalizeObjective(input.objective);
  const quality = normalizeQuality(input.quality);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-evaluation-vector" as const,
    objective,
    quality,
  };
  return deepFreeze({
    ...body,
    evaluationSha256: kit.canonicalDigest(body),
  });
}

export function sealCandidateEvaluatorRecord(
  input: Omit<CandidateEvaluatorRecordV1, "schemaVersion" | "kind" | "recordSha256"> & {
    schemaVersion?: 1;
    kind?: "docsfab-candidate-evaluator-record";
    recordSha256?: string;
  },
): CandidateEvaluatorRecordV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const evaluatorId = kit.identifier(input.evaluatorId);
  const policySha256 = kit.hash(input.policySha256);
  const inputSha256 = kit.hash(input.inputSha256);
  const resultSha256 = kit.hash(input.resultSha256);
  const independence = kit.enumeration(input.independence, CANDIDATE_EVALUATOR_INDEPENDENCE);
  const commandsRun = normalizeCommands(input.commandsRun);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-evaluator-record" as const,
    evaluatorId,
    policySha256,
    inputSha256,
    commandsRun,
    resultSha256,
    independence,
  };
  return deepFreeze({
    ...body,
    recordSha256: kit.canonicalDigest(body),
  });
}

export function sealCandidateBaseline(input: {
  sourceCheckoutSha256: string;
  selectedCandidateSha256: string;
  evaluation:
    | CandidateEvaluationVectorV1
    | Omit<CandidateEvaluationVectorV1, "schemaVersion" | "kind" | "evaluationSha256">;
}): CandidateBaselineV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const sourceCheckoutSha256 = kit.hash(input.sourceCheckoutSha256);
  const selectedCandidateSha256 = kit.hash(input.selectedCandidateSha256);
  const evaluation = sealCandidateEvaluationVector(input.evaluation);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-baseline" as const,
    sourceCheckoutSha256,
    selectedCandidateSha256,
    evaluation,
  };
  return deepFreeze({
    ...body,
    baselineSha256: kit.canonicalDigest(body),
  });
}

export function sealCandidateAttempt(input: CandidateAttemptInputV1): CandidateAttemptV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 0) {
    candidateFail("invalid-value");
  }
  const disposableWorkspaceId = kit.identifier(input.disposableWorkspaceId);
  const candidateSha256 = kit.hash(input.candidateSha256);
  const baselineSha256 = kit.hash(input.baselineSha256);
  const sourceCheckoutSha256 = kit.hash(input.sourceCheckoutSha256);
  if (disposableWorkspaceId === sourceCheckoutSha256) {
    candidateFail("workspace-isolation");
  }
  const evaluation = sealCandidateEvaluationVector(input.evaluation);
  const evaluators = Object.freeze(
    input.evaluators.map((record) => sealCandidateEvaluatorRecord(record)),
  );
  if (evaluators.length === 0) candidateFail("invalid-value");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-attempt" as const,
    attemptIndex: input.attemptIndex,
    disposableWorkspaceId,
    candidateSha256,
    baselineSha256,
    sourceCheckoutSha256,
    evaluation,
    evaluators,
  };
  return deepFreeze({
    ...body,
    attemptSha256: kit.canonicalDigest(body),
  });
}

export function decodeCandidateAttempt(value: unknown): CandidateAttemptV1 {
  return kit.decodeSealed(
    value,
    "docsfab-candidate-attempt",
    "attemptSha256",
    [
      "attemptIndex",
      "disposableWorkspaceId",
      "candidateSha256",
      "baselineSha256",
      "sourceCheckoutSha256",
      "evaluation",
      "evaluators",
    ],
    (root) => {
      const sealed = sealCandidateAttempt({
        attemptIndex: root.attemptIndex as number,
        disposableWorkspaceId: root.disposableWorkspaceId as string,
        candidateSha256: root.candidateSha256 as string,
        baselineSha256: root.baselineSha256 as string,
        sourceCheckoutSha256: root.sourceCheckoutSha256 as string,
        evaluation: root.evaluation as CandidateAttemptInputV1["evaluation"],
        evaluators: root.evaluators as CandidateAttemptInputV1["evaluators"],
      });
      const {
        schemaVersion: _schemaVersion,
        kind: _kind,
        attemptSha256: _attemptSha256,
        ...body
      } = sealed;
      return body;
    },
  );
}

export function objectivesPassed(vector: CandidateEvaluationVectorV1): boolean {
  for (const dimension of CANDIDATE_OBJECTIVE_DIMENSIONS) {
    if (vector.objective[dimension] !== "pass") return false;
  }
  return true;
}

function normalizeObjective(value: CandidateObjectiveVectorV1): CandidateObjectiveVectorV1 {
  kit.exact(value as unknown as Record<string, unknown>, [...CANDIDATE_OBJECTIVE_DIMENSIONS]);
  const objective = {} as CandidateObjectiveVectorV1;
  for (const dimension of CANDIDATE_OBJECTIVE_DIMENSIONS) {
    objective[dimension] = kit.enumeration(value[dimension], CANDIDATE_GATE_RESULTS);
  }
  return deepFreeze(objective);
}

function normalizeQuality(value: CandidateQualityVectorV1): CandidateQualityVectorV1 {
  kit.exact(value as unknown as Record<string, unknown>, [...CANDIDATE_QUALITY_DIMENSIONS]);
  const quality = {} as CandidateQualityVectorV1;
  for (const dimension of CANDIDATE_QUALITY_DIMENSIONS) {
    const score = value[dimension];
    if (!Number.isInteger(score) || score < 0 || !Number.isSafeInteger(score)) {
      candidateFail("invalid-value");
    }
    quality[dimension] = score;
  }
  return deepFreeze(quality);
}

function normalizeCommands(commands: readonly string[]): readonly string[] {
  if (!Array.isArray(commands) || commands.length === 0) candidateFail("invalid-value");
  const normalized = commands.map((command) => kit.identifier(command));
  kit.unique(normalized);
  return deepFreeze([...normalized].sort((a, b) => a.localeCompare(b)));
}
