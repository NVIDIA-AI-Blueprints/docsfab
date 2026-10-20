// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, deepFreeze, type ContractFail } from "./contract-kit/index.js";
import { canonicalDigest, canonicalJson } from "./content-ir/canonical.js";
import type { RunRecord } from "./records/contracts.js";
import type { WorkflowOutcomeCandidateV1 } from "./workflow-contracts/contracts.js";
import {
  createWorkUnitMachineContract,
  type WorkUnitMachineContractV1,
} from "./maturity/work-unit-machine-contract.js";
import {
  createDocumentationGapLedger,
  decodeDocumentationGapLedger,
  decodeDocumentationSearchFinding,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "./search/gap-ledger.js";
import {
  validateRepositoryBatchReplayAuthority,
  type RepositoryBatchProbeRequestV1,
  type RepositoryBatchReplayAuthorityV1,
  type RepositoryDiscoveryInventoryV1,
} from "./repository/inventory.js";
import {
  RELEASE_DOCUMENTATION_RUBRIC,
  releaseDocumentationQuestion,
  releaseDocumentationRepositoryIdentity,
  releaseDocumentationRepositoryTargetSha256,
  releaseDocumentationSpecification,
  type ReleaseDocumentationExpectedRepositoryV1,
} from "./release-documentation-rubric.js";
import type {
  ReleaseDocumentationReadinessArtifactV1,
  ReleaseDocumentationReadinessCategory,
  ReleaseDocumentationReadinessFindingState,
  ReleaseDocumentationReadinessFindingV1,
  ReleaseDocumentationWorkUnitV1,
} from "./repository/release-documentation-readiness-contracts.js";
import { getWorkflow } from "./workflow-registry/catalog.js";
import {
  decodeWorkflowSearchEvidence,
  instantiateWorkflowSearchTargets,
} from "./workflow-contracts/search.js";
import {
  assertSuccessfulGovernedWorkflowExecution,
  workflowOutcomeSearchEvidence,
  type WorkflowOutcomeDecodeOptionsV1,
} from "./workflow-contracts/outcome.js";
import { authorizeSecurityScan } from "./security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "./security/scan-disposition.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const WORKFLOW = "release-documentation-readiness" as const;
const STEP = "assess-release-documentation-readiness";
const SECURITY_SCAN_POLICY: WorkflowOutcomeDecodeOptionsV1 = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
};

export type {
  ReleaseDocumentationReadinessArtifactV1,
  ReleaseDocumentationReadinessCategory,
  ReleaseDocumentationReadinessFindingState,
  ReleaseDocumentationReadinessFindingV1,
  ReleaseDocumentationWorkUnitV1,
} from "./repository/release-documentation-readiness-contracts.js";

export class ReleaseDocumentationReadinessError extends Error {
  public constructor(
    public readonly code: "invalid-authority" | "invalid-artifact" | "execution-incomplete",
  ) {
    super(`Release documentation readiness rejected: ${code}.`);
    this.name = "ReleaseDocumentationReadinessError";
  }
}

type ReadinessErrorCode = ReleaseDocumentationReadinessError["code"];
type ReadinessContractKit = ReturnType<typeof createContractKit<ReadinessErrorCode>>;

const readinessKits = new Map<ReadinessErrorCode, ReadinessContractKit>();

function fail(code: ReadinessErrorCode): never {
  throw new ReleaseDocumentationReadinessError(code);
}

function kitFor(code: ReadinessErrorCode): ReadinessContractKit {
  const existing = readinessKits.get(code);
  if (existing) return existing;
  const created = createContractKit({
    fail: fail as ContractFail<ReadinessErrorCode>,
    codes: {
      invalidShape: code,
      invalidValue: code,
      digestMismatch: code,
      credentialMaterial: code,
      schemaMismatch: code,
    },
  });
  readinessKits.set(code, created);
  return created;
}

function requireInert(value: unknown, code: ReadinessErrorCode): void {
  kitFor(code).assertInert(value);
}

function rejectCredentials(value: unknown, code: ReadinessErrorCode): void {
  kitFor(code).rejectCredentials(value);
}

function object(value: unknown, code: ReadinessErrorCode): Record<string, unknown> {
  requireInert(value, code);
  return kitFor(code).object(value);
}

function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: ReadinessErrorCode,
): void {
  kitFor(code).exact(value, keys);
}

/** Project the exact evidence already admitted by a successful run. */
export function createReleaseDocumentationReadinessArtifact(
  record: Readonly<RunRecord>,
  expectedRepository: Readonly<ReleaseDocumentationExpectedRepositoryV1>,
  trustedInventory: RepositoryDiscoveryInventoryV1,
): ReleaseDocumentationReadinessArtifactV1 {
  requireInert(record, "invalid-authority");
  requireInert(expectedRepository, "invalid-authority");
  rejectCredentials(expectedRepository, "invalid-authority");
  if (
    canonicalJson(record.repository) !==
    canonicalJson({
      sourcePath: expectedRepository.sourcePath,
      requestedRevision: expectedRepository.requestedRevision,
      revision: expectedRepository.revision,
    })
  )
    fail("invalid-authority");
  if (
    record.workflow !== WORKFLOW ||
    record.status !== "succeeded" ||
    record.steps.length !== 1 ||
    record.steps[0]?.id !== STEP ||
    record.steps[0].status !== "succeeded"
  )
    fail("execution-incomplete");
  try {
    assertSuccessfulGovernedWorkflowExecution(record as RunRecord, SECURITY_SCAN_POLICY);
  } catch {
    fail("execution-incomplete");
  }
  const step = record.steps[0];
  const plan = getWorkflow(WORKFLOW).steps[0]!.search!;
  if (
    !step.searchEvidence ||
    !step.searchFindings ||
    !step.negativeEvidence ||
    !step.gapLedger ||
    !step.repositoryBatchAuthority ||
    !record.searchFindings ||
    !record.negativeEvidence ||
    !record.gapLedger
  ) {
    fail("invalid-authority");
  }
  const repositoryIdentitySha256 = releaseDocumentationRepositoryIdentity(expectedRepository);
  const targets = instantiateWorkflowSearchTargets(plan, {
    identitySha256: repositoryIdentitySha256,
    revision: expectedRepository.revision,
  });
  let batchAuthority: RepositoryBatchReplayAuthorityV1;
  try {
    batchAuthority = validateRepositoryBatchReplayAuthority(step.repositoryBatchAuthority, {
      repositoryIdentitySha256,
      repositoryRevision: expectedRepository.revision,
      repositoryWorkspace: {
        sourcePath: expectedRepository.sourcePath,
        requestedRevision: expectedRepository.requestedRevision,
        revision: expectedRepository.revision,
      },
      trustedInventory,
      targets,
      requestsForTarget: (target) =>
        target.requiredProbes.map((probe) => {
          const question = releaseDocumentationQuestion(target.targetKey, probe.id);
          if (!question) fail("invalid-authority");
          return { id: probe.id, question } as RepositoryBatchProbeRequestV1;
        }),
    });
  } catch {
    fail("invalid-authority");
  }
  const evidence = decodeWorkflowSearchEvidence(step.searchEvidence, plan, record.repository);
  if (
    evidence.searches.some(
      (search) => search.bounded.target.repository.identitySha256 !== repositoryIdentitySha256,
    )
  ) {
    fail("invalid-authority");
  }
  for (const [index, search] of evidence.searches.entries()) {
    const batch = batchAuthority.targets[index];
    if (
      !batch ||
      batch.targetId !== search.targetId ||
      batch.evidence.results.length !== search.bounded.probes.length
    )
      fail("invalid-authority");
    for (const [probeIndex, probe] of search.bounded.probes.entries()) {
      const result = batch.evidence.results[probeIndex];
      if (
        !result ||
        result.id !== probe.id ||
        probe.evidenceSha256 !== result.evidenceSha256 ||
        (result.disposition === "found"
          ? probe.outcome !== "match"
          : result.disposition === "not-found-after-bounded-search"
            ? probe.outcome !== "no-match"
            : probe.outcome !== "blocked") ||
        canonicalJson(probe.citations.map((citation) => citation.path).sort()) !==
          canonicalJson([...result.paths].sort())
      )
        fail("invalid-authority");
    }
  }
  const expectedFindings = projectDocumentationSearchFindings({
    workflow: WORKFLOW,
    stepId: STEP,
    evidence,
  });
  const expectedNegative = negativeDocumentationEvidence(expectedFindings);
  const expectedLedger = createDocumentationGapLedger({
    currentRevision: record.repository.revision,
    findings: expectedFindings,
  });
  const projection = {
    searchFindings: step.searchFindings.map(decodeDocumentationSearchFinding),
    negativeEvidence: step.negativeEvidence.map(decodeDocumentationSearchFinding),
    gapLedger: decodeDocumentationGapLedger(step.gapLedger),
  };
  if (
    canonicalJson(projection.searchFindings) !== canonicalJson(expectedFindings) ||
    canonicalJson(projection.negativeEvidence) !== canonicalJson(expectedNegative) ||
    canonicalJson(projection.gapLedger) !== canonicalJson(expectedLedger)
  ) {
    fail("invalid-authority");
  }
  const ledger = decodeDocumentationGapLedger(record.gapLedger);
  if (
    canonicalJson(projection.searchFindings) !== canonicalJson(record.searchFindings) ||
    canonicalJson(projection.negativeEvidence) !== canonicalJson(record.negativeEvidence) ||
    canonicalJson(projection.gapLedger) !== canonicalJson(ledger)
  ) {
    fail("invalid-authority");
  }
  const findingByTarget = new Map(projection.searchFindings.map((item) => [item.target.id, item]));
  const searchByTarget = new Map(evidence.searches.map((item) => [item.targetId, item]));
  const batchByTarget = new Map(batchAuthority.targets.map((item) => [item.targetId, item]));
  const rawFindings = RELEASE_DOCUMENTATION_RUBRIC.map((item) => {
    const finding = findingByTarget.get(item.targetId);
    const search = searchByTarget.get(item.targetId);
    const batch = batchByTarget.get(item.targetId);
    if (!finding || !search || !batch) fail("invalid-authority");
    let state = stateFor(finding.disposition);
    if (
      item.questions.some((question) => question.kind === "decision-status") &&
      state === "missing"
    )
      state = "needs-human-decision";
    return {
      id: `release-readiness:${item.targetId}`,
      category: item.category,
      state,
      targetId: item.targetId,
      stableGapId: finding.stableGapId,
      evidence: {
        boundedSearchEvidenceSha256: search.bounded.evidenceSha256,
        repositoryPaths: [...search.bounded.finding.citations.map((entry) => entry.path)].sort(),
        negativeObservationSha256: state === "missing" ? finding.observationSha256 : null,
        limitationSha256s:
          state === "blocked" || state === "inconclusive"
            ? finding.limitations.map((entry) => entry.limitationSha256).sort()
            : [],
        inventorySha256: batch.evidence.inventorySha256,
        requestSetSha256: batch.evidence.requestSetSha256,
        batchEvidenceSha256: batch.evidence.evidenceSha256,
        resultEvidenceSha256s: batch.evidence.results.map((result) => result.evidenceSha256),
      },
    };
  });
  const findings = rawFindings.map((finding) => {
    const body = { ...finding };
    return deepFreeze({ ...body, findingSha256: canonicalDigest(body) });
  });
  const workUnits = findings
    .filter((item) => item.state === "missing" || item.state === "needs-human-decision")
    .map((finding) => {
      const item = specification(finding.targetId);
      const body = {
        id: `release-work:${finding.targetId}`,
        targetId: finding.targetId,
        priority: item.priority,
        rationale: `bounded-gap:${item.category}`,
        dependencies: [...item.dependencies],
        acceptanceCriteria: [
          `Add evidence-backed public documentation satisfying ${finding.targetId}.`,
          "Cite only repository-confirmed behavior and explicitly label unresolved policy.",
        ],
        verification: [
          "Repeat the governed release-documentation-readiness workflow at the resulting revision.",
          `Require ${finding.targetId} to return authenticated found evidence.`,
        ],
        requiredHumanInput: [...item.requiredHumanInput],
        trackerMutation: "not-authorized" as const,
      };
      return deepFreeze({ ...body, workUnitSha256: canonicalDigest(body) });
    });
  const disposition: ReleaseDocumentationReadinessArtifactV1["disposition"] = findings.some(
    (item) => item.state === "blocked",
  )
    ? "blocked"
    : findings.some((item) => item.state === "inconclusive")
      ? "inconclusive"
      : findings.some((item) => item.state === "missing" || item.state === "needs-human-decision")
        ? "not-ready"
        : "ready";
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-release-documentation-readiness" as const,
    workflow: WORKFLOW,
    repositoryRevision: record.repository.revision,
    repositoryIdentitySha256,
    repositoryTargetSha256: releaseDocumentationRepositoryTargetSha256(expectedRepository),
    repositoryInventorySha256: trustedInventory.inventorySha256,
    repositoryBatchAuthoritySha256: batchAuthority.authoritySha256,
    workflowSearchEvidenceSha256: evidence.evidenceSha256,
    gapLedgerSha256: ledger.ledgerSha256,
    disposition,
    findings,
    workUnits,
    downstreamConsumers: ["#43", "#46"] as ["#43", "#46"],
    trackerMutation: "not-authorized" as const,
  };
  return deepFreeze({ ...body, artifactSha256: canonicalDigest(body) });
}

/** Shape checks are deliberately followed by whole-authority reconstruction. */
export function validateReleaseDocumentationReadinessArtifact(
  value: unknown,
  record: Readonly<RunRecord>,
  expectedRepository: Readonly<ReleaseDocumentationExpectedRepositoryV1>,
  trustedInventory: RepositoryDiscoveryInventoryV1,
): ReleaseDocumentationReadinessArtifactV1 {
  requireInert(value, "invalid-artifact");
  rejectCredentials(value, "invalid-artifact");
  const root = object(value, "invalid-artifact");
  requireKeys(
    root,
    [
      "schemaVersion",
      "kind",
      "workflow",
      "repositoryRevision",
      "repositoryIdentitySha256",
      "repositoryTargetSha256",
      "repositoryInventorySha256",
      "repositoryBatchAuthoritySha256",
      "workflowSearchEvidenceSha256",
      "gapLedgerSha256",
      "disposition",
      "findings",
      "workUnits",
      "downstreamConsumers",
      "trackerMutation",
      "artifactSha256",
    ],
    "invalid-artifact",
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-release-documentation-readiness" ||
    root.workflow !== WORKFLOW ||
    typeof root.repositoryRevision !== "string" ||
    !REVISION.test(root.repositoryRevision) ||
    typeof root.artifactSha256 !== "string" ||
    !SHA256.test(root.artifactSha256)
  )
    fail("invalid-artifact");
  const expected = createReleaseDocumentationReadinessArtifact(
    record,
    expectedRepository,
    trustedInventory,
  );
  if (canonicalJson(value) !== canonicalJson(expected)) fail("invalid-artifact");
  return expected;
}

export function projectReleaseDocumentationReadinessOutcome(
  record: Readonly<RunRecord>,
  expectedRepository: Readonly<ReleaseDocumentationExpectedRepositoryV1>,
  trustedInventory: RepositoryDiscoveryInventoryV1,
  artifactValue?: unknown,
): WorkflowOutcomeCandidateV1 {
  const artifact =
    artifactValue === undefined
      ? createReleaseDocumentationReadinessArtifact(record, expectedRepository, trustedInventory)
      : validateReleaseDocumentationReadinessArtifact(
          artifactValue,
          record,
          expectedRepository,
          trustedInventory,
        );
  return outcomeFromArtifact(record, artifact);
}

/** Single-pass production projection so the runner does not reconstruct twice. */
export function createReleaseDocumentationReadinessResult(
  record: Readonly<RunRecord>,
  expectedRepository: Readonly<ReleaseDocumentationExpectedRepositoryV1> | undefined,
  trustedInventory: RepositoryDiscoveryInventoryV1 | undefined,
): {
  artifact: ReleaseDocumentationReadinessArtifactV1;
  outcome: WorkflowOutcomeCandidateV1;
  /** MEA-admission envelopes bound to each executable work unit. */
  machineContracts: readonly WorkUnitMachineContractV1[];
} {
  if (!expectedRepository || !trustedInventory) fail("invalid-authority");
  const artifact = createReleaseDocumentationReadinessArtifact(
    record,
    expectedRepository,
    trustedInventory,
  );
  return deepFreeze({
    artifact,
    outcome: outcomeFromArtifact(record, artifact),
    machineContracts: emitReleaseDocumentationWorkUnitMachineContracts(artifact),
  });
}

/**
 * Emit sealed WorkUnitMachineContractV1 envelopes for MEA-eligible readiness
 * work units. Binds `workUnitFingerprint` to the unit's `workUnitSha256` and
 * reuses the artifact repository identity. Does not rewrite the readiness
 * artifact schema or mint tracker authority.
 */
export function emitReleaseDocumentationWorkUnitMachineContracts(
  artifact: ReleaseDocumentationReadinessArtifactV1,
): readonly WorkUnitMachineContractV1[] {
  requireInert(artifact, "invalid-artifact");
  rejectCredentials(artifact, "invalid-artifact");
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    Array.isArray(artifact) ||
    artifact.kind !== "docsfab-release-documentation-readiness" ||
    typeof artifact.repositoryIdentitySha256 !== "string" ||
    !SHA256.test(artifact.repositoryIdentitySha256) ||
    !Array.isArray(artifact.workUnits)
  ) {
    fail("invalid-artifact");
  }
  const contracts = artifact.workUnits.map((unit) =>
    emitReleaseDocumentationWorkUnitMachineContract(unit, artifact.repositoryIdentitySha256),
  );
  return Object.freeze(contracts);
}

/** Emit one machine-contract envelope bound to a readiness work unit. */
export function emitReleaseDocumentationWorkUnitMachineContract(
  workUnit: ReleaseDocumentationWorkUnitV1,
  repositoryIdentitySha256: string,
): WorkUnitMachineContractV1 {
  requireInert(workUnit, "invalid-artifact");
  rejectCredentials(workUnit, "invalid-artifact");
  if (
    typeof repositoryIdentitySha256 !== "string" ||
    !SHA256.test(repositoryIdentitySha256) ||
    typeof workUnit.workUnitSha256 !== "string" ||
    !SHA256.test(workUnit.workUnitSha256) ||
    typeof workUnit.targetId !== "string"
  ) {
    fail("invalid-artifact");
  }
  return createWorkUnitMachineContract({
    workUnitFingerprint: workUnit.workUnitSha256,
    repositoryIdentitySha256,
    machineChecks: [
      {
        checkKind: "cli-smoke",
        commandId: WORKFLOW,
        expectedOutcomeClass: "pass",
      },
      {
        checkKind: "inventory-probe",
        inventoryProbeId: workUnit.targetId,
        expectedOutcomeClass: "pass",
      },
    ],
    acceptanceAuthority: "host-deterministic",
    trackerMutation: "not-authorized",
  });
}

function outcomeFromArtifact(
  record: Readonly<RunRecord>,
  artifact: ReleaseDocumentationReadinessArtifactV1,
): WorkflowOutcomeCandidateV1 {
  const relevant =
    artifact.disposition === "ready"
      ? artifact.findings
      : artifact.disposition === "not-ready"
        ? artifact.findings.filter(
            (item) => item.state === "missing" || item.state === "needs-human-decision",
          )
        : artifact.disposition === "blocked"
          ? artifact.findings.filter((item) => item.state === "blocked")
          : artifact.findings.filter((item) => item.state === "inconclusive");
  const evidence = relevant.map((item) =>
    workflowOutcomeSearchEvidence(record, STEP, item.targetId),
  );
  if (artifact.disposition === "ready") {
    return {
      disposition: "ready",
      findings: [],
      evidence,
      limitations: [],
      openDecisions: [],
      producedArtifacts: [],
    };
  }
  if (artifact.disposition === "not-ready") {
    return {
      disposition: "not-ready",
      findings: relevant.map((item) => ({
        id: `finding:${item.targetId}`,
        kind: "product-gap" as const,
        severity: "blocking" as const,
        code: item.targetId.replace(/^release-/u, "release-docs."),
        evidenceIds: [`search:${STEP}:${item.targetId}`],
      })),
      evidence,
      limitations: [],
      openDecisions: relevant
        .filter((item) => specification(item.targetId).requiredHumanInput.length > 0)
        .map((item) => ({
          id: `decision:${item.targetId}`,
          kind: "human-decision" as const,
          evidenceIds: [`search:${STEP}:${item.targetId}`],
        })),
      producedArtifacts: [],
    };
  }
  if (artifact.disposition === "blocked") {
    return {
      disposition: "blocked",
      findings: relevant.map((item) => ({
        id: `finding:${item.targetId}`,
        kind: "blocked-dependency" as const,
        severity: "blocking" as const,
        code: "release-docs.governed-search-blocked",
        evidenceIds: [`search:${STEP}:${item.targetId}`],
      })),
      evidence,
      limitations: [],
      openDecisions: relevant.map((item) => ({
        id: `decision:${item.targetId}`,
        kind: "dependency" as const,
        evidenceIds: [`search:${STEP}:${item.targetId}`],
      })),
      producedArtifacts: [],
    };
  }
  return {
    disposition: "inconclusive",
    findings: relevant.map((item) => ({
      id: `finding:${item.targetId}`,
      kind: "evidence-limitation" as const,
      severity: "warning" as const,
      code: "release-docs.search-incomplete",
      evidenceIds: [`search:${STEP}:${item.targetId}`],
    })),
    evidence,
    limitations: ["release-docs.search-incomplete"],
    openDecisions: [],
    producedArtifacts: [],
  };
}

export function formatReleaseDocumentationReadiness(
  artifact: ReleaseDocumentationReadinessArtifactV1,
): string[] {
  return [
    `Release documentation readiness: ${artifact.disposition}`,
    `Coverage: ${artifact.findings.filter((item) => item.state === "covered").length}/${artifact.findings.length}`,
    `Executable work units: ${artifact.workUnits.length}`,
    `Tracker mutation: ${artifact.trackerMutation}`,
  ];
}

function stateFor(disposition: string): ReleaseDocumentationReadinessFindingState {
  if (disposition === "found") return "covered";
  if (disposition === "not-found-after-bounded-search") return "missing";
  if (disposition === "search-blocked" || disposition === "stopped-hard-ceiling") return "blocked";
  return "inconclusive";
}

function specification(targetId: string) {
  const item = releaseDocumentationSpecification(targetId);
  if (!item) fail("invalid-authority");
  return item;
}
