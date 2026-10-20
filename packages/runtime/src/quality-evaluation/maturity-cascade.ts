// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createPublicKey, createHash, verify as verifySignature } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
  DOCUMENTATION_MATURITY_EVALUATOR_CATALOG,
  DOCUMENTATION_MATURITY_GATE_CATALOG,
  assessDocumentationMaturityCascade,
  inspectDocumentationMaturityCascadeSelection,
  mapRepositoryDocumentationQuality,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeSelectionV1,
  type DocumentationMaturityGateId,
} from "../maturity/index.js";
import { prepareRepositoryWorkspace } from "../repository/workspace/materialize.js";
import { readTrackedRepositoryFile } from "../repository/workspace/tracked-read.js";
import {
  disposition,
  exact,
  gateId,
  invalid,
  record,
  safeId,
  safeMissingInputId,
  safePath,
  sha,
  sortedUnique,
} from "./maturity-cascade/value-primitives.js";
import {
  validateMaturityCascadeDataset,
  maturityCascadeDatasetTransitions,
  validateMaturityCascadeBaseline,
  deriveDatasetTransitions,
} from "./maturity-cascade/dataset-codecs.js";

const exec = promisify(execFile);

const REPEAT_COUNT = 5;
const OBSERVED_AT = "2026-08-01T00:00:00.000Z";
const HOST_POLICY_PATH = ".docsfab-documentation-maturity-policy.json";
const MAXIMUM_FIXTURE_SOURCE_BYTES = 512 * 1024;
const MAXIMUM_SEMANTIC_EVIDENCE_BYTES = 2 * 1024 * 1024;

const SEMANTIC_SCORER_TIMEOUT_MS = 30_000;

export interface MaturityCascadeDatasetSourceV1 {
  path: string;
  fixturePath: string;
  sha256: string;
}

export interface MaturityCascadeDatasetCaseV1 {
  id: string;
  kind:
    | "no-documentation"
    | "partial-coverage"
    | "broken-ia"
    | "monolithic-content"
    | "stale-inaccurate"
    | "polish-only"
    | "complete"
    | "human-decision";
  predecessorId: string | null;
  sources: MaturityCascadeDatasetSourceV1[];
  caseSha256: string;
}

export interface MaturityCascadeDatasetV1 {
  schemaVersion: 1;
  kind: "docsfab-maturity-cascade-dataset";
  id: string;
  revision: string;
  cases: MaturityCascadeDatasetCaseV1[];
  datasetSha256: string;
}

export interface MaturityCascadePortableFindingV1 {
  gateId: DocumentationMaturityGateId;
  findingKey: string;
  severity: "critical" | "major";
  affectedPaths: string[];
  portableFingerprint: string;
}

export interface MaturityCascadePortableSelectionV1 {
  state: "selected" | "needs-input" | "investigation" | "no-action";
  gateId: DocumentationMaturityGateId | null;
  findingKey: string | null;
  missingInputIds: string[];
  portableWorkUnitFingerprint: string | null;
}

export interface MaturityCascadeBaselineCaseV1 {
  id: string;
  gateDispositions: Array<{
    gateId: DocumentationMaturityGateId;
    disposition: "satisfied" | "not-ready" | "unknown" | "blocked" | "not-applicable";
  }>;
  majorFindings: MaturityCascadePortableFindingV1[];
  selection: MaturityCascadePortableSelectionV1;
  forbiddenFindingKeys: string[];
  caseBaselineSha256: string;
}

export interface MaturityCascadeBaselineV1 {
  schemaVersion: 1;
  kind: "docsfab-maturity-cascade-known-answer-baseline";
  dataset: { id: string; revision: string; sha256: string };
  algorithmVersion: typeof DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION;
  gateCatalogSha256: string;
  evaluatorCatalogSha256: string;
  reviewerPolicySha256: string;
  cases: MaturityCascadeBaselineCaseV1[];
  baselineSha256: string;
}

export interface MaturityCascadeReviewerPolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-maturity-cascade-reviewer-policy";
  id: string;
  reviewers: Array<{
    id: string;
    role: "preparer" | "independent-reviewer";
    publicKey: string;
  }>;
  policySha256: string;
}

export interface MaturityCascadeReviewV1 {
  schemaVersion: 1;
  kind: "docsfab-maturity-cascade-baseline-review";
  policySha256: string;
  binding: {
    datasetSha256: string;
    baselineSha256: string;
    algorithmVersion: string;
    gateCatalogSha256: string;
    evaluatorCatalogSha256: string;
    cases: Array<{ id: string; caseBaselineSha256: string }>;
  };
  attestations: Array<{
    stage: "prepared" | "reviewed";
    reviewerId: string;
    reviewedAt: string;
    disposition: "approved";
    signature: string;
  }>;
  reviewSha256: string;
}

export interface MaturityCascadeCaseObservationV1 {
  caseId: string;
  gateDispositions: MaturityCascadeBaselineCaseV1["gateDispositions"];
  majorFindings: MaturityCascadePortableFindingV1[];
  findingKeys: Array<{ gateId: DocumentationMaturityGateId; findingKey: string }>;
  selection: MaturityCascadePortableSelectionV1;
  stability: {
    repeatCount: 5;
    stable: boolean;
    rawAssessmentSha256: string;
    rawFindingFingerprintsSha256: string;
    rawSelectionProjectionSha256: string;
  };
  metrics: {
    authenticatedAdapterCalls: number;
    selectionInspectionCalls: number;
    callsByRun: Array<{
      authenticatedAdapterCalls: number;
      selectionInspectionCalls: number;
    }>;
    latencyMs: number[];
    tokenUsage: { input: 0; output: 0; total: 0 };
  };
  semantic: {
    authority: "advisory-only";
    status: "not-run" | "succeeded" | "failed";
    majorFindingAgreement: number | null;
    tokenUsage: { input: number; output: number; total: number };
    errorCode: string | null;
  };
  observationSha256: string;
}

export interface MaturityCascadeMismatchV1 {
  caseId: string;
  gateId: DocumentationMaturityGateId | null;
  field:
    | "gate-disposition"
    | "major-findings"
    | "selection"
    | "negative-control"
    | "stability"
    | "transition";
  expected: string;
  actual: string;
  evidenceSha256s: string[];
}

export interface MaturityCascadeEvaluationReportV1 {
  schemaVersion: 1;
  kind: "docsfab-maturity-cascade-evaluation-report";
  datasetSha256: string;
  baselineSha256: string;
  reviewSha256: string;
  deterministicAuthority: "authoritative";
  semanticAuthority: "advisory-only";
  productionTrackerCoverage: "not-evaluated-offline";
  cases: MaturityCascadeCaseObservationV1[];
  transitions: MaturityCascadeTransitionObservationV1[];
  mismatches: MaturityCascadeMismatchV1[];
  passed: boolean;
  reportSha256: string;
}

export interface MaturityCascadeSemanticResult {
  majorFindingKeys: string[];
  tokenUsage: { input: number; output: number; total: number };
}

export interface MaturityCascadeSemanticEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-maturity-cascade-semantic-evidence";
  fixtureSha256: string;
  sources: ReadonlyArray<{ path: string; sha256: string; byteLength: number; text: string }>;
  evidenceSha256: string;
}

export interface MaturityCascadeDatasetTransitionV1 {
  predecessorId: string;
  caseId: string;
  predecessorCaseSha256: string;
  caseSha256: string;
  changes: Array<{
    path: string;
    kind: "added" | "modified" | "removed";
    predecessorSha256: string | null;
    currentSha256: string | null;
  }>;
  transitionSha256: string;
}

export interface MaturityCascadeTransitionObservationV1 extends MaturityCascadeDatasetTransitionV1 {
  resolvedPriorSelection: boolean;
  exposedExpectedSelection: boolean;
  passed: boolean;
}

export type MaturityCascadeSemanticScorer = (
  evidence: MaturityCascadeSemanticEvidenceV1,
) => Promise<MaturityCascadeSemanticResult>;

export async function evaluateMaturityCascadeDataset(input: {
  projectRoot: string;
  dataset: MaturityCascadeDatasetV1;
  semanticScorer?: MaturityCascadeSemanticScorer;
}): Promise<MaturityCascadeCaseObservationV1[]> {
  const dataset = validateMaturityCascadeDataset(input.dataset);
  await validateDatasetSources(input.projectRoot, dataset);
  const observations: MaturityCascadeCaseObservationV1[] = [];
  for (const item of dataset.cases) {
    observations.push(await observeCase(input.projectRoot, item, input.semanticScorer));
  }
  return observations;
}

export { validateMaturityCascadeDataset };

export { maturityCascadeDatasetTransitions };

export { validateMaturityCascadeBaseline };

export function validateMaturityCascadeReview(input: {
  review: unknown;
  policy: unknown;
  baseline: MaturityCascadeBaselineV1;
}): MaturityCascadeReviewV1 {
  const policy = decodeReviewerPolicy(input.policy);
  const review = decodeReview(input.review);
  const expectedBinding = reviewBinding(input.baseline);
  if (
    review.policySha256 !== policy.policySha256 ||
    review.policySha256 !== input.baseline.reviewerPolicySha256 ||
    canonicalJson(review.binding) !== canonicalJson(expectedBinding)
  )
    invalid();
  const byRole = new Map(policy.reviewers.map((item) => [item.role, item]));
  const authorities = policy.reviewers.map((item) =>
    createPublicKey(item.publicKey)
      .export({
        type: "spki",
        format: "der",
      })
      .toString("hex"),
  );
  if (new Set(authorities).size !== authorities.length) invalid();
  for (const attestation of review.attestations) {
    const role = attestation.stage === "prepared" ? "preparer" : "independent-reviewer";
    const reviewer = byRole.get(role);
    if (!reviewer || reviewer.id !== attestation.reviewerId) invalid();
    const statement = reviewStatement(review.binding, review.policySha256, attestation);
    if (
      !verifySignature(
        null,
        Buffer.from(canonicalDigest(statement), "hex"),
        createPublicKey(reviewer.publicKey),
        Buffer.from(attestation.signature, "base64url"),
      )
    )
      invalid();
  }
  return review;
}

export function compareMaturityCascadeKnownAnswers(input: {
  dataset: MaturityCascadeDatasetV1;
  baseline: MaturityCascadeBaselineV1;
  review: MaturityCascadeReviewV1;
  observations: MaturityCascadeCaseObservationV1[];
}): MaturityCascadeEvaluationReportV1 {
  const mismatches: MaturityCascadeMismatchV1[] = [];
  if (
    canonicalJson([...input.observations.map((item) => item.caseId)].sort()) !==
    canonicalJson(input.dataset.cases.map((item) => item.id))
  )
    invalid();
  for (const expected of input.baseline.cases) {
    const actual = input.observations.find((item) => item.caseId === expected.id);
    if (!actual) invalid();
    if (!actual.stability.stable)
      mismatch(mismatches, expected.id, null, "stability", "stable", "unstable", [
        actual.observationSha256,
      ]);
    for (const gate of expected.gateDispositions) {
      const observed = actual.gateDispositions.find((item) => item.gateId === gate.gateId);
      if (observed?.disposition !== gate.disposition)
        mismatch(
          mismatches,
          expected.id,
          gate.gateId,
          "gate-disposition",
          gate.disposition,
          observed?.disposition ?? "missing",
          [actual.observationSha256],
        );
    }
    compareMajorFindings(mismatches, expected.id, expected.majorFindings, actual.majorFindings);
    if (canonicalJson(actual.selection) !== canonicalJson(expected.selection)) {
      mismatch(
        mismatches,
        expected.id,
        expected.selection.gateId ?? actual.selection.gateId,
        "selection",
        canonicalDigest(expected.selection),
        canonicalDigest(actual.selection),
        [
          expected.selection.portableWorkUnitFingerprint,
          actual.selection.portableWorkUnitFingerprint,
        ].filter((value): value is string => value !== null),
      );
    }
    const actualKeys = new Set(actual.majorFindings.map((item) => item.findingKey));
    for (const forbidden of expected.forbiddenFindingKeys) {
      const forbiddenFindings = actual.majorFindings.filter(
        (finding) => finding.findingKey === forbidden,
      );
      for (const finding of forbiddenFindings) {
        mismatch(
          mismatches,
          expected.id,
          finding.gateId,
          "negative-control",
          `absent:${forbidden}`,
          `present:${forbidden}`,
          [finding.portableFingerprint],
        );
      }
    }
  }
  const transitions = deriveDatasetTransitions(input.dataset.cases).map((transition) => {
    const predecessorExpected = input.baseline.cases.find(
      (item) => item.id === transition.predecessorId,
    )!;
    const currentExpected = input.baseline.cases.find((item) => item.id === transition.caseId)!;
    const current = input.observations.find((item) => item.caseId === transition.caseId)!;
    const priorIdentity =
      predecessorExpected.selection.findingKey === null ||
      predecessorExpected.selection.gateId === null
        ? null
        : {
            gateId: predecessorExpected.selection.gateId,
            findingKey: predecessorExpected.selection.findingKey,
          };
    const resolvedPriorSelection =
      priorIdentity === null ||
      !current.findingKeys.some(
        (finding) =>
          finding.gateId === priorIdentity.gateId &&
          finding.findingKey === priorIdentity.findingKey,
      );
    const exposedExpectedSelection =
      canonicalJson(current.selection) === canonicalJson(currentExpected.selection);
    if (!resolvedPriorSelection) {
      mismatch(
        mismatches,
        transition.caseId,
        priorIdentity!.gateId,
        "transition",
        `resolved:${priorIdentity!.findingKey}`,
        `present:${priorIdentity!.findingKey}`,
        [transition.transitionSha256],
      );
    }
    if (!exposedExpectedSelection) {
      mismatch(
        mismatches,
        transition.caseId,
        currentExpected.selection.gateId ?? current.selection.gateId,
        "transition",
        canonicalDigest(currentExpected.selection),
        canonicalDigest(current.selection),
        [transition.transitionSha256],
      );
    }
    return {
      ...transition,
      resolvedPriorSelection,
      exposedExpectedSelection,
      passed: resolvedPriorSelection && exposedExpectedSelection,
    };
  });
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-maturity-cascade-evaluation-report" as const,
    datasetSha256: input.dataset.datasetSha256,
    baselineSha256: input.baseline.baselineSha256,
    reviewSha256: input.review.reviewSha256,
    deterministicAuthority: "authoritative" as const,
    semanticAuthority: "advisory-only" as const,
    productionTrackerCoverage: "not-evaluated-offline" as const,
    cases: input.observations,
    transitions,
    mismatches,
    passed: mismatches.length === 0,
  };
  return { ...body, reportSha256: canonicalDigest(body) };
}

function compareMajorFindings(
  mismatches: MaturityCascadeMismatchV1[],
  caseId: string,
  expected: readonly MaturityCascadePortableFindingV1[],
  actual: readonly MaturityCascadePortableFindingV1[],
): void {
  const key = (finding: MaturityCascadePortableFindingV1): string =>
    `${finding.gateId}:${finding.findingKey}`;
  const expectedByKey = new Map(expected.map((finding) => [key(finding), finding]));
  const actualByKey = new Map(actual.map((finding) => [key(finding), finding]));
  for (const findingKey of [...new Set([...expectedByKey.keys(), ...actualByKey.keys()])].sort()) {
    const expectedFinding = expectedByKey.get(findingKey);
    const actualFinding = actualByKey.get(findingKey);
    const gate = expectedFinding?.gateId ?? actualFinding!.gateId;
    if (!expectedFinding) {
      mismatch(
        mismatches,
        caseId,
        gate,
        "major-findings",
        "absent",
        actualFinding!.portableFingerprint,
        [actualFinding!.portableFingerprint],
      );
    } else if (!actualFinding) {
      mismatch(
        mismatches,
        caseId,
        gate,
        "major-findings",
        expectedFinding.portableFingerprint,
        "absent",
        [expectedFinding.portableFingerprint],
      );
    } else if (canonicalJson(expectedFinding) !== canonicalJson(actualFinding)) {
      mismatch(
        mismatches,
        caseId,
        gate,
        "major-findings",
        expectedFinding.portableFingerprint,
        actualFinding.portableFingerprint,
        [expectedFinding.portableFingerprint, actualFinding.portableFingerprint],
      );
    }
  }
}

async function observeCase(
  projectRoot: string,
  item: MaturityCascadeDatasetCaseV1,
  semanticScorer?: MaturityCascadeSemanticScorer,
): Promise<MaturityCascadeCaseObservationV1> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "docsfab-maturity-cascade-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  const semanticSources: Array<MaturityCascadeSemanticEvidenceV1["sources"][number]> = [];
  let semanticEvidenceBytes = 0;
  await mkdir(repositoryRoot, { recursive: true });
  try {
    for (const source of item.sources) {
      const bytes = await readFixtureSource(contained(projectRoot, source.fixturePath));
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) invalid();
      semanticEvidenceBytes += bytes.byteLength;
      if (semanticEvidenceBytes > MAXIMUM_SEMANTIC_EVIDENCE_BYTES) invalid();
      let sourceText: string;
      try {
        sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalid();
      }
      if (detectCredentialRuleIdsInValue(sourceText).length > 0) invalid();
      semanticSources.push(
        Object.freeze({
          path: source.path,
          sha256: source.sha256,
          byteLength: bytes.byteLength,
          text: sourceText,
        }),
      );
      const destination = join(repositoryRoot, ...source.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    await initializeFixtureRepository(repositoryRoot);
    const workspace = await prepareRepositoryWorkspace(repositoryRoot, "HEAD");
    try {
      const repository = {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      };
      const need = await productNeed(workspace);
      const runRecords: Array<{
        assessment: DocumentationMaturityCascadeAssessmentV1;
        selection: DocumentationMaturityCascadeSelectionV1;
        latencyMs: number;
        calls: {
          authenticatedAdapterCalls: number;
          selectionInspectionCalls: number;
        };
      }> = [];
      for (let repeat = 0; repeat < REPEAT_COUNT; repeat += 1) {
        const startedAt = performance.now();
        const calls = { authenticatedAdapterCalls: 0, selectionInspectionCalls: 0 };
        const mappedGateIds: DocumentationMaturityGateId[] =
          need === "required" ? ["G0", "G1", "G2", "G3", "G4", "G5"] : ["G0"];
        const mappingGroups = await Promise.all(
          mappedGateIds.map(async (gateId) => {
            calls.authenticatedAdapterCalls += 1;
            return await mapRepositoryDocumentationQuality({ gateId, repository, workspace });
          }),
        );
        const mappingsByGate = new Map<
          DocumentationMaturityGateId,
          Awaited<ReturnType<typeof mapRepositoryDocumentationQuality>>
        >();
        mappingsByGate.set("G0", mappingGroups[0]!);
        if (need === "required") {
          (["G1", "G2", "G3", "G4", "G5"] as const).forEach((gateId, index) => {
            mappingsByGate.set(gateId, mappingGroups[index + 1]!);
          });
        }
        const gateInputs = (["G0", "G1", "G2", "G3", "G4", "G5"] as const).map((gateId) => ({
          gateId,
          repository,
          policyWorkspace: gateId === "G0" ? null : workspace,
          mappings: mappingsByGate.get(gateId) ?? [],
        }));
        const assessment = await assessDocumentationMaturityCascade({ gateInputs });
        calls.selectionInspectionCalls += 1;
        const inspection = await inspectDocumentationMaturityCascadeSelection({
          assessment,
          trackerIssues: [],
          policyWorkspace: workspace,
          observedAt: OBSERVED_AT,
          timeSource: () => new Date(OBSERVED_AT),
        });
        runRecords.push({
          assessment,
          selection: inspection.selection,
          latencyMs: performance.now() - startedAt,
          calls: Object.freeze({ ...calls }),
        });
      }
      const first = runRecords[0]!;
      const rawFindingFingerprints = (run: typeof first) =>
        run.assessment.gates.flatMap((gate) => gate.findings.map((finding) => finding.fingerprint));
      const rawSelectionProjection = (run: typeof first) => ({
        state: run.selection.outcome.state,
        gateId: run.selection.outcome.gateId,
        workUnitFingerprint: run.selection.outcome.workUnit?.workUnitFingerprint ?? null,
        missingInputIds: run.selection.outcome.missingInputIds,
      });
      const stable = runRecords.every(
        (run) =>
          run.assessment.assessmentSha256 === first.assessment.assessmentSha256 &&
          canonicalJson(rawFindingFingerprints(run)) ===
            canonicalJson(rawFindingFingerprints(first)) &&
          canonicalJson(rawSelectionProjection(run)) ===
            canonicalJson(rawSelectionProjection(first)),
      );
      const majorFindings = portableMajorFindings(item.id, first.assessment);
      const selection = portableSelection(item.id, first.assessment, first.selection);
      const semanticEvidenceBody = {
        schemaVersion: 1 as const,
        kind: "docsfab-maturity-cascade-semantic-evidence" as const,
        fixtureSha256: item.caseSha256,
        sources: Object.freeze([...semanticSources]),
      };
      const semanticEvidence = Object.freeze({
        ...semanticEvidenceBody,
        evidenceSha256: canonicalDigest(semanticEvidenceBody),
      });
      const semantic = await semanticObservation(semanticEvidence, majorFindings, semanticScorer);
      const body = {
        caseId: item.id,
        gateDispositions: first.assessment.gates.map((gate) => ({
          gateId: gate.gateId,
          disposition: gate.disposition,
        })),
        majorFindings,
        findingKeys: first.assessment.gates
          .flatMap((gate) =>
            gate.findings.map((finding) => ({
              gateId: finding.gateId,
              findingKey: finding.findingKey,
            })),
          )
          .sort(
            (left, right) =>
              left.gateId.localeCompare(right.gateId) ||
              left.findingKey.localeCompare(right.findingKey),
          ),
        selection,
        stability: {
          repeatCount: REPEAT_COUNT as 5,
          stable,
          rawAssessmentSha256: first.assessment.assessmentSha256,
          rawFindingFingerprintsSha256: canonicalDigest(rawFindingFingerprints(first)),
          rawSelectionProjectionSha256: canonicalDigest(rawSelectionProjection(first)),
        },
        metrics: {
          authenticatedAdapterCalls: runRecords.reduce(
            (total, run) => total + run.calls.authenticatedAdapterCalls,
            0,
          ),
          selectionInspectionCalls: runRecords.reduce(
            (total, run) => total + run.calls.selectionInspectionCalls,
            0,
          ),
          callsByRun: runRecords.map((run) => run.calls),
          latencyMs: runRecords.map((run) => Math.round(run.latencyMs * 1_000) / 1_000),
          tokenUsage: { input: 0 as const, output: 0 as const, total: 0 as const },
        },
        semantic,
      };
      return { ...body, observationSha256: canonicalDigest(body) };
    } finally {
      await workspace.dispose();
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function portableMajorFindings(
  caseId: string,
  assessment: DocumentationMaturityCascadeAssessmentV1,
): MaturityCascadePortableFindingV1[] {
  return assessment.gates
    .flatMap((gate) =>
      gate.findings
        .filter((finding) => finding.severity === "critical" || finding.severity === "major")
        .map((finding) => {
          const body = {
            logicalRepositoryId: caseId,
            gateId: finding.gateId,
            findingKey: finding.findingKey,
            affectedPaths: finding.affectedPaths,
          };
          return {
            gateId: finding.gateId,
            findingKey: finding.findingKey,
            severity: finding.severity as "critical" | "major",
            affectedPaths: finding.affectedPaths,
            portableFingerprint: canonicalDigest(body),
          };
        }),
    )
    .sort(
      (left, right) =>
        left.gateId.localeCompare(right.gateId) || left.findingKey.localeCompare(right.findingKey),
    );
}

function portableSelection(
  caseId: string,
  assessment: DocumentationMaturityCascadeAssessmentV1,
  selection: DocumentationMaturityCascadeSelectionV1,
): MaturityCascadePortableSelectionV1 {
  const outcome = selection.outcome;
  const findingKey =
    outcome.workUnit === null
      ? null
      : (assessment.gates
          .flatMap((gate) => gate.findings)
          .find((finding) => finding.fingerprint === outcome.workUnit!.findingFingerprint)
          ?.findingKey ?? null);
  return {
    state: outcome.state,
    gateId: outcome.gateId,
    findingKey,
    missingInputIds: outcome.missingInputIds,
    portableWorkUnitFingerprint:
      outcome.workUnit === null
        ? null
        : canonicalDigest({
            logicalRepositoryId: caseId,
            gateId: outcome.workUnit.gateId,
            findingKey,
            affectedPaths: outcome.workUnit.affectedPaths,
            workflow: portableWorkUnitWorkflow(outcome.workUnit.workflow),
          }),
  };
}

/**
 * The sealed quality corpus digests G3/G4 work units as they existed when
 * those gates bound `audit` / `polish`. Live work units now name
 * `review-documentation` / `update-documentation`; this projection keeps the
 * known-answer fingerprints stable without reminting `packages/quality/`.
 */
function portableWorkUnitWorkflow(workflow: { name: string; stepId: string }): {
  name: string;
  stepId: string;
} {
  if (workflow.name === "review-documentation") {
    return {
      name: "audit",
      stepId: workflow.stepId === "audit-documentation" ? "audit-docs" : workflow.stepId,
    };
  }
  if (workflow.name === "update-documentation") {
    return {
      name: "polish",
      stepId: workflow.stepId === "write-documentation" ? "apply-polish" : workflow.stepId,
    };
  }
  return workflow;
}

async function semanticObservation(
  evidence: MaturityCascadeSemanticEvidenceV1,
  findings: MaturityCascadePortableFindingV1[],
  scorer?: MaturityCascadeSemanticScorer,
): Promise<MaturityCascadeCaseObservationV1["semantic"]> {
  if (!scorer)
    return {
      authority: "advisory-only",
      status: "not-run",
      majorFindingAgreement: null,
      tokenUsage: { input: 0, output: 0, total: 0 },
      errorCode: null,
    };
  try {
    const result = decodeSemanticResult(await boundedSemanticScore(scorer, evidence));
    const expected = new Set(findings.map((item) => item.findingKey));
    const actual = new Set(result.majorFindingKeys);
    const union = new Set([...expected, ...actual]);
    const agreement =
      union.size === 0
        ? 1
        : [...union].filter((key) => expected.has(key) && actual.has(key)).length / union.size;
    return {
      authority: "advisory-only",
      status: "succeeded",
      majorFindingAgreement: agreement,
      tokenUsage: result.tokenUsage,
      errorCode: null,
    };
  } catch {
    return {
      authority: "advisory-only",
      status: "failed",
      majorFindingAgreement: null,
      tokenUsage: { input: 0, output: 0, total: 0 },
      errorCode: "semantic-scorer-failed",
    };
  }
}

async function boundedSemanticScore(
  scorer: MaturityCascadeSemanticScorer,
  evidence: MaturityCascadeSemanticEvidenceV1,
): Promise<MaturityCascadeSemanticResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      scorer(evidence),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("semantic-scorer-timeout")),
          SEMANTIC_SCORER_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function decodeSemanticResult(value: unknown): MaturityCascadeSemanticResult {
  const root = record(value);
  exact(root, ["majorFindingKeys", "tokenUsage"]);
  if (!Array.isArray(root.majorFindingKeys) || root.majorFindingKeys.length > 256) invalid();
  const majorFindingKeys = root.majorFindingKeys.map(safeId);
  if (!sortedUnique(majorFindingKeys)) invalid();
  const usageValue = record(root.tokenUsage);
  exact(usageValue, ["input", "output", "total"]);
  const count = (candidate: unknown): number => {
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) invalid();
    return Number(candidate);
  };
  const tokenUsage = {
    input: count(usageValue.input),
    output: count(usageValue.output),
    total: count(usageValue.total),
  };
  if (tokenUsage.total !== tokenUsage.input + tokenUsage.output) invalid();
  return { majorFindingKeys, tokenUsage };
}

async function validateDatasetSources(
  projectRoot: string,
  dataset: MaturityCascadeDatasetV1,
): Promise<void> {
  for (const item of dataset.cases) {
    const fixtureRoot = contained(projectRoot, `evaluation/maturity-cascade/cases/${item.id}`);
    const discovered = await listRegularFiles(fixtureRoot);
    if (canonicalJson(discovered) !== canonicalJson(item.sources.map((source) => source.path)))
      invalid();
    for (const source of item.sources) {
      if (source.fixturePath !== `evaluation/maturity-cascade/cases/${item.id}/${source.path}`)
        invalid();
      const bytes = await readFixtureSource(contained(projectRoot, source.fixturePath));
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) invalid();
    }
  }
}

async function listRegularFiles(root: string, relativePath = ""): Promise<string[]> {
  if (relativePath.split("/").filter(Boolean).length > 16) invalid();
  const entries = await readdir(join(root, relativePath), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) invalid();
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await listRegularFiles(root, child)));
    else result.push(child);
    if (result.length > 64) invalid();
  }
  return result.sort();
}

async function readFixtureSource(path: string): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(MAXIMUM_FIXTURE_SOURCE_BYTES)
  )
    invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    )
      invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    )
      invalid();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function initializeFixtureRepository(path: string): Promise<void> {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z",
    LANG: "C",
    LC_ALL: "C",
  };
  await exec("/usr/bin/git", ["init", "--quiet", "--initial-branch=main", path], { env });
  await exec("/usr/bin/git", ["-C", path, "add", "--all"], { env });
  await exec(
    "/usr/bin/git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=DocsFab Fixture",
      "-c",
      "user.email=fixture.invalid@example.com",
      "-C",
      path,
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { env },
  );
}

async function productNeed(
  workspace: Parameters<typeof readTrackedRepositoryFile>[0],
): Promise<string> {
  const value = JSON.parse(
    (await readTrackedRepositoryFile(workspace, HOST_POLICY_PATH, 64 * 1024)).toString("utf8"),
  ) as {
    productNeed?: { decision?: { need?: unknown } };
  };
  return typeof value.productNeed?.decision?.need === "string"
    ? value.productNeed.decision.need
    : "invalid";
}

function decodeReviewerPolicy(value: unknown): MaturityCascadeReviewerPolicyV1 {
  const root = record(value);
  exact(root, ["schemaVersion", "kind", "id", "reviewers", "policySha256"]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-maturity-cascade-reviewer-policy" ||
    !Array.isArray(root.reviewers) ||
    root.reviewers.length !== 2
  )
    invalid();
  const reviewers = root.reviewers.map((value) => {
    const item = record(value);
    exact(item, ["id", "role", "publicKey"]);
    if (
      (item.role !== "preparer" && item.role !== "independent-reviewer") ||
      typeof item.publicKey !== "string"
    )
      invalid();
    const key = createPublicKey(item.publicKey);
    if (key.asymmetricKeyType !== "ed25519") invalid();
    return {
      id: safeId(item.id),
      role: item.role as MaturityCascadeReviewerPolicyV1["reviewers"][number]["role"],
      publicKey: item.publicKey,
    };
  });
  if (new Set(reviewers.map((item) => item.role)).size !== 2) invalid();
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-maturity-cascade-reviewer-policy" as const,
    id: safeId(root.id),
    reviewers,
  };
  const policySha256 = sha(root.policySha256);
  if (policySha256 !== canonicalDigest(body)) invalid();
  return { ...body, policySha256 };
}

function decodeReview(value: unknown): MaturityCascadeReviewV1 {
  const root = record(value);
  exact(root, ["schemaVersion", "kind", "policySha256", "binding", "attestations", "reviewSha256"]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-maturity-cascade-baseline-review" ||
    !Array.isArray(root.attestations) ||
    root.attestations.length !== 2
  )
    invalid();
  const bindingValue = record(root.binding);
  exact(bindingValue, [
    "datasetSha256",
    "baselineSha256",
    "algorithmVersion",
    "gateCatalogSha256",
    "evaluatorCatalogSha256",
    "cases",
  ]);
  if (!Array.isArray(bindingValue.cases)) invalid();
  const binding = {
    datasetSha256: sha(bindingValue.datasetSha256),
    baselineSha256: sha(bindingValue.baselineSha256),
    algorithmVersion: qualityString(bindingValue.algorithmVersion),
    gateCatalogSha256: sha(bindingValue.gateCatalogSha256),
    evaluatorCatalogSha256: sha(bindingValue.evaluatorCatalogSha256),
    cases: bindingValue.cases.map((value) => {
      const item = record(value);
      exact(item, ["id", "caseBaselineSha256"]);
      return { id: safeId(item.id), caseBaselineSha256: sha(item.caseBaselineSha256) };
    }),
  };
  const attestations = root.attestations.map((value) => {
    const item = record(value);
    exact(item, ["stage", "reviewerId", "reviewedAt", "disposition", "signature"]);
    if (
      (item.stage !== "prepared" && item.stage !== "reviewed") ||
      item.disposition !== "approved" ||
      typeof item.signature !== "string" ||
      !/^[A-Za-z0-9_-]{80,100}$/u.test(item.signature) ||
      typeof item.reviewedAt !== "string" ||
      new Date(item.reviewedAt).toISOString() !== item.reviewedAt
    )
      invalid();
    return {
      stage: item.stage as MaturityCascadeReviewV1["attestations"][number]["stage"],
      reviewerId: safeId(item.reviewerId),
      reviewedAt: item.reviewedAt,
      disposition: "approved" as const,
      signature: item.signature,
    };
  });
  if (
    canonicalJson(attestations.map((item) => item.stage)) !==
    canonicalJson(["prepared", "reviewed"])
  )
    invalid();
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-maturity-cascade-baseline-review" as const,
    policySha256: sha(root.policySha256),
    binding,
    attestations,
  };
  const reviewSha256 = sha(root.reviewSha256);
  if (reviewSha256 !== canonicalDigest(body)) invalid();
  return { ...body, reviewSha256 };
}

function reviewBinding(baseline: MaturityCascadeBaselineV1): MaturityCascadeReviewV1["binding"] {
  return {
    datasetSha256: baseline.dataset.sha256,
    baselineSha256: baseline.baselineSha256,
    algorithmVersion: baseline.algorithmVersion,
    gateCatalogSha256: baseline.gateCatalogSha256,
    evaluatorCatalogSha256: baseline.evaluatorCatalogSha256,
    cases: baseline.cases.map((item) => ({
      id: item.id,
      caseBaselineSha256: item.caseBaselineSha256,
    })),
  };
}

function reviewStatement(
  binding: MaturityCascadeReviewV1["binding"],
  policySha256: string,
  attestation: MaturityCascadeReviewV1["attestations"][number],
) {
  return {
    schemaVersion: 1,
    kind: "docsfab-maturity-cascade-review-statement",
    policySha256,
    binding,
    stage: attestation.stage,
    reviewerId: attestation.reviewerId,
    reviewedAt: attestation.reviewedAt,
    disposition: attestation.disposition,
  };
}

function mismatch(
  result: MaturityCascadeMismatchV1[],
  caseId: string,
  gateIdValue: DocumentationMaturityGateId | null,
  field: MaturityCascadeMismatchV1["field"],
  expected: string,
  actual: string,
  evidenceSha256s: string[],
): void {
  result.push({ caseId, gateId: gateIdValue, field, expected, actual, evidenceSha256s });
}

function contained(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) invalid();
  return absolute;
}

function qualityString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) invalid();
  return value;
}
