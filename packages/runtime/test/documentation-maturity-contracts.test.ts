// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import type { WorkflowOutcomeCandidateV1 } from "../src/workflow-contracts/contracts.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  DOCUMENTATION_ISSUE_PRIORITIES,
  DOCUMENTATION_MATURITY_DISPOSITIONS,
  DOCUMENTATION_MATURITY_GATE_CATALOG,
  DOCUMENTATION_MATURITY_GATE_IDS,
  DocumentationMaturityContractError,
  createDocumentationMaturityFinding,
  createDocumentationMaturityWorkUnit,
  createDocumentationRepositoryObservation,
  decodeDocumentationMaturityFinding,
  decodeDocumentationMaturityGateCatalog,
  decodeDocumentationMaturityWorkUnit,
  decodeDocumentationRepositoryObservation,
  documentationMaturityFindingFingerprint,
  migrateDocumentationMaturityFinding,
  migrateDocumentationMaturityWorkUnit,
  projectSanitizedDocumentationMaturityFinding,
  projectSanitizedDocumentationMaturityWorkUnit,
  validateDocumentationMaturityFinding,
  validateDocumentationMaturityWorkUnit,
  type DocumentationMaturityAuthorityV1,
  type DocumentationMaturityEvidenceReferenceV1,
  type DocumentationMaturityFindingCandidateV1,
  type DocumentationMaturityFindingV1,
} from "./support/maturity-contracts.js";
import {
  createDocumentationGapLedger,
  projectDocumentationSearchFindings,
} from "../src/search/index.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { isWorkflowName } from "../src/workflow-registry/catalog.js";
import { createDocumentationMaturityFinding as createDocumentationMaturityFindingWithWorkflowAccess } from "../src/maturity/contracts.js";
import { createDocumentationMaturityWorkUnit as createDocumentationMaturityWorkUnitWithWorkflowAccess } from "../src/maturity/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { authorizeSecurityScan } from "../src/security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../src/security/scan-disposition.js";
import { normalizeWorkflowSearchEvidence } from "../src/workflow-contracts/search.js";
import { configureCredential } from "./helpers/configured-credential.js";

const REVISION = "a".repeat(40);
const NEXT_REVISION = "b".repeat(40);
const SHA = (value: string) => createHash("sha256").update(value).digest("hex");
const REQUIREMENT = { id: "public-guide", subjectSha256: SHA("public-guide-requirement") };
const SCOPE_SHA256 = SHA("public-guide-scope");
const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

const CATALOG_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/runtime-evaluation/maturity/gate-catalog-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  schemaVersion: 1;
  catalogVersion: "1.0.0";
  gateOrder: string[];
  stages: string[];
  issuePriorities: string[];
  dispositions: string[];
};

describe("documentation maturity contracts", () => {
  it("uses caller-supplied workflow access to validate finding workflow references", () => {
    const { authority, observation } = observationAuthority("absent");
    const checkedNames: string[] = [];
    const finding = createDocumentationMaturityFindingWithWorkflowAccess(
      candidate("observed-absence", referenceFor(observation), { confidence: "confirmed" }),
      authority,
      {
        getWorkflow,
        isWorkflowName(value) {
          checkedNames.push(value);
          return isWorkflowName(value);
        },
      },
    );

    expect(finding.workflow.name).toBe("readiness");
    expect(checkedNames).toContain("readiness");
  });

  it("uses fake finding/work-unit step definitions and validates search contracts", async () => {
    const fake = fakeMaturityWorkflowAccess();
    const base = observationAuthority("absent");
    const authority = withFakeReadinessStep(base.authority, fake.stepId);
    const candidateValue = candidate("observed-absence", referenceFor(base.observation), {
      confidence: "confirmed",
    });
    candidateValue.workflow.stepId = fake.stepId;
    const finding = createDocumentationMaturityFindingWithWorkflowAccess(
      candidateValue,
      authority,
      fake.access,
    );
    expect(finding.workflow.stepId).toBe(fake.stepId);
    const workUnit = createDocumentationMaturityWorkUnitWithWorkflowAccess(
      {
        id: "work-unit:fake-step",
        dependsOnWorkUnitIds: [],
        execution: {
          state: "ready",
          governedInputs: [{ id: "input:add-guide-v1", sha256: SHA("governed-input") }],
          missingInputIds: [],
        },
      },
      finding,
      authority,
      fake.access,
    );
    expect(workUnit.workflow.stepId).toBe(fake.stepId);

    const search = await localSearchAuthority(REVISION);
    try {
      const searchAuthority = withFakeReadinessStep(search.authority, fake.stepId);
      const absentStepAuthority = structuredClone(searchAuthority);
      absentStepAuthority.searches[0]!.stepId = "missing-search-step";
      expectContractError(
        () =>
          createDocumentationMaturityFindingWithWorkflowAccess(
            candidate("observed-absence", searchReference(search.findings[0]!), {
              confidence: "confirmed",
            }),
            absentStepAuthority,
            fake.access,
          ),
        "invalid-authority",
      );
      const noSearchContract = fakeMaturityWorkflowAccess(false);
      const noSearchContractAuthority = withFakeReadinessStep(
        search.authority,
        noSearchContract.stepId,
      );
      expectContractError(
        () =>
          createDocumentationMaturityFindingWithWorkflowAccess(
            candidate("observed-absence", searchReference(search.findings[0]!), {
              confidence: "confirmed",
            }),
            noSearchContractAuthority,
            noSearchContract.access,
          ),
        "invalid-authority",
      );
    } finally {
      await search.cleanup();
    }
  });

  it("publishes exact versioned G0-G5 gates with cumulative prerequisites", () => {
    const catalog = decodeDocumentationMaturityGateCatalog(
      structuredClone(DOCUMENTATION_MATURITY_GATE_CATALOG),
    );
    expect({
      schemaVersion: catalog.schemaVersion,
      catalogVersion: catalog.version,
      gateOrder: catalog.gates.map((gate) => gate.id),
      stages: catalog.gates.map((gate) => gate.stage),
      issuePriorities: [...DOCUMENTATION_ISSUE_PRIORITIES],
      dispositions: [...DOCUMENTATION_MATURITY_DISPOSITIONS],
    }).toEqual(CATALOG_FIXTURE);
    expect(catalog.gates.map((gate) => gate.prerequisites.length)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      DOCUMENTATION_MATURITY_GATE_IDS.some((gate) =>
        DOCUMENTATION_ISSUE_PRIORITIES.includes(gate as never),
      ),
    ).toBe(false);
    expect(
      catalog.gates.every(
        (gate) => gate.dispositions.join(",") === DOCUMENTATION_MATURITY_DISPOSITIONS.join(","),
      ),
    ).toBe(true);
    expect(Object.isFrozen(catalog.gates[5]?.evidenceRequirements)).toBe(true);

    const relabeled = structuredClone(catalog);
    relabeled.gates[0]!.id = "G1";
    expectContractError(() => decodeDocumentationMaturityGateCatalog(relabeled), "invalid-catalog");
  });

  it("round-trips content-free repository observations and rejects extra authority", () => {
    const { observation } = observationAuthority("absent");
    expect(decodeDocumentationRepositoryObservation(structuredClone(observation))).toEqual(
      observation,
    );
    expect(JSON.stringify(observation)).not.toContain("missing documentation text");
    const extra = { ...structuredClone(observation), title: "new authority" };
    expectContractError(
      () => decodeDocumentationRepositoryObservation(extra),
      "invalid-observation",
    );
  });

  it("seals observed absence only from independently supplied repository evidence", () => {
    const { authority, observation } = observationAuthority("absent");
    const finding = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(observation), { confidence: "confirmed" }),
      authority,
    );
    expect(validateDocumentationMaturityFinding(structuredClone(finding), authority)).toEqual(
      finding,
    );
    expect(finding.repository).toEqual(observation.repository);
    expect(finding.disposition).toBe("observed-absence");
    expect(Object.isFrozen(finding.evidence[0])).toBe(true);
  });

  it("reuses authenticated #72/#74 bounded negative evidence without relabeling it", async () => {
    const fixture = await localSearchAuthority(REVISION);
    try {
      expect(fixture.allFindings).toHaveLength(2);
      const absence = fixture.findings.find((finding) => finding.findingClass === "absence")!;
      const reference: DocumentationMaturityEvidenceReferenceV1 = {
        id: `documentation-search:${absence.observationSha256}`,
        kind: "documentation-search",
        sha256: absence.observationSha256,
      };
      const searchCandidate = (
        disposition: "bounded-not-found" | "observed-absence",
        confidence: "bounded" | "confirmed",
      ) => ({
        ...candidate(disposition, reference, { confidence }),
        ...fixture.binding,
        requiredWorkflowInputs: [
          { id: "input:search-workflow", status: "missing" as const, sha256: null },
        ],
      });
      const finding = createDocumentationMaturityFinding(
        searchCandidate("bounded-not-found", "bounded"),
        fixture.authority,
      );
      expect(finding.disposition).toBe("bounded-not-found");

      const exactAbsence = createDocumentationRepositoryObservation({
        id: "observation:exact-search-target-absence",
        repository: {
          identitySha256: fixture.authority.repositoryIdentitySha256,
          revision: REVISION,
        },
        gateId: fixture.binding.gateId,
        requirement: fixture.binding.requirement,
        observation: "absent",
        paths: fixture.binding.affectedPaths,
        scopeSha256: fixture.binding.scopeSha256,
      });
      const precedenceAuthority: DocumentationMaturityAuthorityV1 = {
        ...fixture.authority,
        repositoryObservations: [exactAbsence],
      };
      const sharedAbsenceEvidence = [referenceFor(exactAbsence), reference];
      const exactCandidate = {
        ...searchCandidate("observed-absence", "confirmed"),
        evidence: structuredClone(sharedAbsenceEvidence),
      };
      const exactFinding = createDocumentationMaturityFinding(exactCandidate, precedenceAuthority);
      const inferredCandidate = {
        ...searchCandidate("bounded-not-found", "bounded"),
        evidence: structuredClone(sharedAbsenceEvidence),
      };
      expect(
        documentationMaturityFindingFingerprint({
          ...inferredCandidate,
          repository: exactFinding.repository,
        }),
      ).toBe(exactFinding.fingerprint);
      expectContractError(
        () => createDocumentationMaturityFinding(inferredCandidate, precedenceAuthority),
        "contradictory-evidence",
      );

      const partialLedgerAuthority: DocumentationMaturityAuthorityV1 = {
        ...fixture.authority,
        gapLedger: createDocumentationGapLedger({
          currentRevision: REVISION,
          findings: [absence],
        }),
      };
      expectContractError(
        () =>
          createDocumentationMaturityFinding(
            searchCandidate("bounded-not-found", "bounded"),
            partialLedgerAuthority,
          ),
        "invalid-authority",
      );

      const substitutedTarget = fixture.allFindings.find(
        (item) => item.target.id !== absence.target.id,
      )!;
      const substitutedAuthority = structuredClone(fixture.authority);
      substitutedAuthority.searches[0]!.targetId = substitutedTarget.target.id;
      expectContractError(
        () =>
          createDocumentationMaturityFinding(
            searchCandidate("bounded-not-found", "bounded"),
            substitutedAuthority,
          ),
        "invalid-authority",
      );

      const auditStep = getWorkflow("review-documentation").steps[0]!.id;
      for (const mutate of [
        (value: DocumentationMaturityFindingV1) => {
          value.gateId = "G5";
        },
        (value: DocumentationMaturityFindingV1) => {
          value.requirement = { ...value.requirement, subjectSha256: SHA("other-search-subject") };
        },
        (value: DocumentationMaturityFindingV1) => {
          value.affectedPaths = ["docs/maintenance.md"];
        },
        (value: DocumentationMaturityFindingV1) => {
          value.scopeSha256 = SHA("other-search-scope");
        },
        (value: DocumentationMaturityFindingV1) => {
          value.workflow = { name: "review-documentation", stepId: auditStep };
        },
      ]) {
        const forged = structuredClone(finding);
        mutate(forged);
        rehashFinding(forged);
        expect(decodeDocumentationMaturityFinding(forged)).toEqual(forged);
        expectContractError(
          () => validateDocumentationMaturityFinding(forged, fixture.authority),
          "contradictory-evidence",
        );
      }

      expectContractError(
        () =>
          createDocumentationMaturityFinding(searchCandidate("bounded-not-found", "bounded"), {
            ...fixture.authority,
            gapLedger: null,
          }),
        "invalid-authority",
      );

      expectContractError(
        () =>
          createDocumentationMaturityFinding(
            searchCandidate("observed-absence", "confirmed"),
            fixture.authority,
          ),
        "contradictory-evidence",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps unknown, blocked, satisfied, and not-applicable semantically distinct", () => {
    const { authority, observation } = observationAuthority("present");
    const missingPolicy = candidate("unknown", referenceFor(observation), {
      confidence: "inconclusive",
    });
    missingPolicy.requiredHumanInput = [
      {
        id: "input:support-policy",
        kind: "support-commitment",
        claim: "support-requirement",
        status: "missing",
        decision: null,
        valueSha256: null,
      },
    ];
    const missingPolicyAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      humanInputRequirements: [
        humanRequirementFor(
          missingPolicy,
          observation.repository,
          missingPolicy.requiredHumanInput[0]!,
        ),
      ],
    };
    const unknownFinding = createDocumentationMaturityFinding(
      missingPolicy,
      missingPolicyAuthority,
    );
    expect(unknownFinding.disposition).toBe("unknown");
    const missingInputSatisfiedAttack = candidate(
      "satisfied",
      structuredClone(unknownFinding.evidence),
      { confidence: "confirmed", severity: "informational", impact: "none" },
    );
    missingInputSatisfiedAttack.requiredHumanInput = structuredClone(
      missingPolicy.requiredHumanInput,
    );
    expect(
      documentationMaturityFindingFingerprint({
        ...missingInputSatisfiedAttack,
        repository: unknownFinding.repository,
      }),
    ).toBe(unknownFinding.fingerprint);
    expectContractError(
      () => createDocumentationMaturityFinding(missingInputSatisfiedAttack, missingPolicyAuthority),
      "contradictory-evidence",
    );

    const blockedRecord = outcomeRecord(authority.repository, "blocked");
    const blockedOutcome = blockedRecord.workflowOutcome!;
    const blockedAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      outcomeRecords: [blockedRecord],
    };
    expect(
      createDocumentationMaturityFinding(
        candidate(
          "blocked",
          [
            referenceFor(observation),
            {
              id: `workflow-outcome:${blockedOutcome.outcomeSha256}`,
              kind: "workflow-outcome",
              sha256: blockedOutcome.outcomeSha256,
              productDisposition: "blocked",
            },
          ],
          { confidence: "confirmed" },
        ),
        blockedAuthority,
      ).disposition,
    ).toBe("blocked");

    const inconclusiveRecord = outcomeRecord(authority.repository, "inconclusive");
    const inconclusiveOutcome = inconclusiveRecord.workflowOutcome!;
    const unknownAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      outcomeRecords: [inconclusiveRecord],
    };
    const unknownOutcomeReference: DocumentationMaturityEvidenceReferenceV1 = {
      id: `workflow-outcome:${inconclusiveOutcome.outcomeSha256}`,
      kind: "workflow-outcome",
      sha256: inconclusiveOutcome.outcomeSha256,
      productDisposition: "inconclusive",
    };
    expect(
      createDocumentationMaturityFinding(
        candidate("unknown", [referenceFor(observation), unknownOutcomeReference], {
          confidence: "inconclusive",
        }),
        unknownAuthority,
      ).disposition,
    ).toBe("unknown");

    expect(
      createDocumentationMaturityFinding(
        candidate("satisfied", referenceFor(observation), {
          confidence: "confirmed",
          severity: "informational",
          impact: "none",
        }),
        authority,
      ).disposition,
    ).toBe("satisfied");

    expectContractError(
      () =>
        createDocumentationMaturityFinding(
          candidate("not-applicable", referenceFor(observation), {
            confidence: "confirmed",
            severity: "informational",
            impact: "none",
          }),
          authority,
        ),
      "contradictory-evidence",
    );
    const notApplicable = candidate("not-applicable", referenceFor(observation), {
      confidence: "confirmed",
      severity: "informational",
      impact: "none",
    });
    notApplicable.requiredHumanInput = [
      {
        id: "input:product-policy",
        kind: "product-policy",
        claim: "applicability",
        status: "provided",
        decision: "not-applicable",
        valueSha256: SHA("approved-not-applicable-policy"),
      },
    ];
    expectContractError(
      () => createDocumentationMaturityFinding(notApplicable, authority),
      "contradictory-evidence",
    );
    const policyAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      humanInputRequirements: [
        humanRequirementFor(
          notApplicable,
          observation.repository,
          notApplicable.requiredHumanInput[0]!,
        ),
      ],
      humanInputs: [
        {
          id: "input:product-policy",
          kind: "product-policy",
          claim: "applicability",
          decision: "not-applicable",
          valueSha256: SHA("approved-not-applicable-policy"),
          repository: observation.repository,
          gateId: notApplicable.gateId,
          requirement: notApplicable.requirement,
          affectedPaths: notApplicable.affectedPaths,
          scopeSha256: notApplicable.scopeSha256,
        },
      ],
    };
    const notApplicableFinding = createDocumentationMaturityFinding(notApplicable, policyAuthority);
    expect(notApplicableFinding.disposition).toBe("not-applicable");

    const sameEvidenceSatisfied = candidate(
      "satisfied",
      structuredClone(notApplicableFinding.evidence),
      { confidence: "confirmed", severity: "informational", impact: "none" },
    );
    sameEvidenceSatisfied.requiredHumanInput = structuredClone(notApplicable.requiredHumanInput);
    expect(
      documentationMaturityFindingFingerprint({
        ...sameEvidenceSatisfied,
        repository: notApplicableFinding.repository,
      }),
    ).toBe(notApplicableFinding.fingerprint);
    expectContractError(
      () => createDocumentationMaturityFinding(sameEvidenceSatisfied, policyAuthority),
      "contradictory-evidence",
    );
  });

  it("binds optional product semantics to the exact #81 workflow outcome", () => {
    const { authority, observation, repository } = observationAuthority("present");
    const record = outcomeRecord(repository, "blocked");
    const outcome = record.workflowOutcome!;
    const withOutcome: DocumentationMaturityAuthorityV1 = {
      ...authority,
      outcomeRecords: [record],
    };
    const outcomeReference: DocumentationMaturityEvidenceReferenceV1 = {
      id: `workflow-outcome:${outcome.outcomeSha256}`,
      kind: "workflow-outcome",
      sha256: outcome.outcomeSha256,
      productDisposition: outcome.disposition,
    };
    const finding = createDocumentationMaturityFinding(
      candidate("blocked", [referenceFor(observation), outcomeReference], {
        confidence: "confirmed",
      }),
      withOutcome,
    );
    expect(finding.evidence.map((item) => item.kind)).toEqual([
      "repository-observation",
      "workflow-outcome",
    ]);

    const sameEvidenceSatisfied = candidate("satisfied", structuredClone(finding.evidence), {
      confidence: "confirmed",
      severity: "informational",
      impact: "none",
    });
    expect(
      documentationMaturityFindingFingerprint({
        ...sameEvidenceSatisfied,
        repository: finding.repository,
      }),
    ).toBe(finding.fingerprint);
    expectContractError(
      () => createDocumentationMaturityFinding(sameEvidenceSatisfied, withOutcome),
      "contradictory-evidence",
    );

    const tampered = structuredClone(finding);
    const outcomeEvidence = tampered.evidence.find((item) => item.kind === "workflow-outcome")!;
    outcomeEvidence.productDisposition = "ready";
    rehashFinding(tampered);
    expect(decodeDocumentationMaturityFinding(tampered)).toEqual(tampered);
    expectContractError(
      () => validateDocumentationMaturityFinding(tampered, withOutcome),
      "contradictory-evidence",
    );
  });

  it(
    "admits at most one disposition across isolated and mixed authority classes",
    async () => {
      const candidateFor = (
        disposition: DocumentationMaturityFindingCandidateV1["disposition"],
        evidence: DocumentationMaturityEvidenceReferenceV1[],
      ) =>
        candidate(disposition, structuredClone(evidence), {
          confidence:
            disposition === "bounded-not-found"
              ? "bounded"
              : disposition === "unknown"
                ? "inconclusive"
                : "confirmed",
          severity:
            disposition === "not-applicable" || disposition === "satisfied"
              ? "informational"
              : "critical",
          impact:
            disposition === "not-applicable" || disposition === "satisfied" ? "none" : "blocked",
        });
      const acceptedDispositions = (
        authority: DocumentationMaturityAuthorityV1,
        evidence: DocumentationMaturityEvidenceReferenceV1[],
        configure?: (input: DocumentationMaturityFindingCandidateV1) => void,
      ) =>
        DOCUMENTATION_MATURITY_DISPOSITIONS.filter((disposition) => {
          const input = candidateFor(disposition, evidence);
          configure?.(input);
          try {
            createDocumentationMaturityFinding(input, authority);
            return true;
          } catch (error) {
            expect(error).toBeInstanceOf(DocumentationMaturityContractError);
            return false;
          }
        });

      const observed = observationAuthority("absent");
      expect(
        acceptedDispositions(observed.authority, [referenceFor(observed.observation)]),
      ).toEqual(["observed-absence"]);

      const bounded = await localSearchAuthority(REVISION);
      try {
        const configureBounded = (input: DocumentationMaturityFindingCandidateV1) => {
          Object.assign(input, bounded.binding);
          input.requiredWorkflowInputs = [
            {
              id: "input:search-workflow",
              status: "missing",
              sha256: null,
            },
          ];
        };
        const boundedReference = searchReference(bounded.findings[0]!);
        expect(
          acceptedDispositions(bounded.authority, [boundedReference], configureBounded),
        ).toEqual(["bounded-not-found"]);

        const exactAbsence = createDocumentationRepositoryObservation({
          id: "observation:mixed-matrix-exact-absence",
          repository: {
            identitySha256: bounded.authority.repositoryIdentitySha256,
            revision: REVISION,
          },
          gateId: bounded.binding.gateId,
          requirement: bounded.binding.requirement,
          observation: "absent",
          paths: bounded.binding.affectedPaths,
          scopeSha256: bounded.binding.scopeSha256,
        });
        const blockedRecord = outcomeRecord(bounded.authority.repository, "blocked");
        const blockedOutcome = blockedRecord.workflowOutcome!;
        const blockedReference: DocumentationMaturityEvidenceReferenceV1 = {
          id: `workflow-outcome:${blockedOutcome.outcomeSha256}`,
          kind: "workflow-outcome",
          sha256: blockedOutcome.outcomeSha256,
          productDisposition: "blocked",
        };
        const boundedBlockedAuthority: DocumentationMaturityAuthorityV1 = {
          ...bounded.authority,
          outcomeRecords: [blockedRecord],
        };
        expect(
          acceptedDispositions(
            boundedBlockedAuthority,
            [boundedReference, blockedReference],
            configureBounded,
          ),
        ).toEqual(["blocked"]);

        const exactBoundedBlockedAuthority: DocumentationMaturityAuthorityV1 = {
          ...boundedBlockedAuthority,
          repositoryObservations: [exactAbsence],
        };
        expect(
          acceptedDispositions(
            exactBoundedBlockedAuthority,
            [referenceFor(exactAbsence), boundedReference, blockedReference],
            configureBounded,
          ),
        ).toEqual([]);

        const notReadyRecord = outcomeRecord(bounded.authority.repository, "not-ready");
        const notReadyOutcome = notReadyRecord.workflowOutcome!;
        const notReadyReference: DocumentationMaturityEvidenceReferenceV1 = {
          id: `workflow-outcome:${notReadyOutcome.outcomeSha256}`,
          kind: "workflow-outcome",
          sha256: notReadyOutcome.outcomeSha256,
          productDisposition: "not-ready",
        };
        expect(
          acceptedDispositions(
            {
              ...bounded.authority,
              repositoryObservations: [exactAbsence],
              outcomeRecords: [notReadyRecord],
            },
            [referenceFor(exactAbsence), boundedReference, notReadyReference],
            configureBounded,
          ),
        ).toEqual(["observed-absence"]);
      } finally {
        await bounded.cleanup();
      }

      const product = observationAuthority("present");
      const missingHumanCase = (
        definitions: Array<{
          id: string;
          kind: "product-policy" | "ownership" | "support-commitment";
          claim: "applicability" | "ownership" | "support-requirement";
        }>,
      ) => {
        const template = candidateFor("unknown", [referenceFor(product.observation)]);
        template.requiredHumanInput = definitions.map((definition) => ({
          ...definition,
          status: "missing" as const,
          decision: null,
          valueSha256: null,
        }));
        return {
          authority: {
            ...product.authority,
            humanInputRequirements: template.requiredHumanInput.map((input) =>
              humanRequirementFor(template, product.observation.repository, input),
            ),
          } satisfies DocumentationMaturityAuthorityV1,
          requiredHumanInput: template.requiredHumanInput,
        };
      };
      const missingHumanDefinitions = [
        {
          id: "input:matrix-policy",
          kind: "product-policy" as const,
          claim: "applicability" as const,
        },
        {
          id: "input:matrix-owner",
          kind: "ownership" as const,
          claim: "ownership" as const,
        },
        {
          id: "input:matrix-support",
          kind: "support-commitment" as const,
          claim: "support-requirement" as const,
        },
      ];
      for (const definition of missingHumanDefinitions) {
        const missing = missingHumanCase([definition]);
        expect(
          acceptedDispositions(missing.authority, [referenceFor(product.observation)], (input) => {
            input.requiredHumanInput = structuredClone(missing.requiredHumanInput);
          }),
        ).toEqual(["unknown"]);
      }
      const allMissingHuman = missingHumanCase(missingHumanDefinitions);
      expect(
        acceptedDispositions(
          allMissingHuman.authority,
          [referenceFor(product.observation)],
          (input) => {
            input.requiredHumanInput = structuredClone(allMissingHuman.requiredHumanInput);
          },
        ),
      ).toEqual(["unknown"]);

      const absentMissing = candidateFor("unknown", [referenceFor(observed.observation)]);
      absentMissing.requiredHumanInput = [
        {
          id: "input:matrix-absent-owner",
          kind: "ownership",
          claim: "ownership",
          status: "missing",
          decision: null,
          valueSha256: null,
        },
      ];
      const absentMissingAuthority: DocumentationMaturityAuthorityV1 = {
        ...observed.authority,
        humanInputRequirements: [
          humanRequirementFor(
            absentMissing,
            observed.observation.repository,
            absentMissing.requiredHumanInput[0]!,
          ),
        ],
      };
      expect(
        acceptedDispositions(
          absentMissingAuthority,
          [referenceFor(observed.observation)],
          (input) => {
            input.requiredHumanInput = structuredClone(absentMissing.requiredHumanInput);
          },
        ),
      ).toEqual([]);

      const missingWorkflowAuthority: DocumentationMaturityAuthorityV1 = {
        ...product.authority,
        governedInputs: [],
      };
      const configureMissingWorkflow = (input: DocumentationMaturityFindingCandidateV1) => {
        input.requiredWorkflowInputs = [
          {
            id: "input:add-guide-v1",
            status: "missing",
            sha256: null,
          },
        ];
      };
      expect(
        acceptedDispositions(
          missingWorkflowAuthority,
          [referenceFor(product.observation)],
          configureMissingWorkflow,
        ),
      ).toEqual(["satisfied"]);
      expect(
        acceptedDispositions(
          { ...allMissingHuman.authority, governedInputs: [] },
          [referenceFor(product.observation)],
          (input) => {
            input.requiredHumanInput = structuredClone(allMissingHuman.requiredHumanInput);
            configureMissingWorkflow(input);
          },
        ),
      ).toEqual(["unknown"]);

      const inconclusiveRecord = outcomeRecord(product.repository, "inconclusive");
      const inconclusiveOutcome = inconclusiveRecord.workflowOutcome!;
      const inconclusiveReference: DocumentationMaturityEvidenceReferenceV1 = {
        id: `workflow-outcome:${inconclusiveOutcome.outcomeSha256}`,
        kind: "workflow-outcome",
        sha256: inconclusiveOutcome.outcomeSha256,
        productDisposition: "inconclusive",
      };
      expect(
        acceptedDispositions({ ...product.authority, outcomeRecords: [inconclusiveRecord] }, [
          referenceFor(product.observation),
          inconclusiveReference,
        ]),
      ).toEqual(["unknown"]);

      const notApplicableInput = candidateFor("not-applicable", [
        referenceFor(product.observation),
      ]);
      notApplicableInput.requiredHumanInput = [
        {
          id: "input:applicability-matrix",
          kind: "product-policy",
          claim: "applicability",
          status: "provided",
          decision: "not-applicable",
          valueSha256: SHA("matrix-not-applicable"),
        },
      ];
      const notApplicableAuthority: DocumentationMaturityAuthorityV1 = {
        ...product.authority,
        humanInputRequirements: [
          humanRequirementFor(
            notApplicableInput,
            product.observation.repository,
            notApplicableInput.requiredHumanInput[0]!,
          ),
        ],
        humanInputs: [
          {
            id: "input:applicability-matrix",
            kind: "product-policy",
            claim: "applicability",
            decision: "not-applicable",
            valueSha256: SHA("matrix-not-applicable"),
            repository: product.observation.repository,
            gateId: notApplicableInput.gateId,
            requirement: notApplicableInput.requirement,
            affectedPaths: notApplicableInput.affectedPaths,
            scopeSha256: notApplicableInput.scopeSha256,
          },
        ],
      };
      expect(
        acceptedDispositions(
          notApplicableAuthority,
          [referenceFor(product.observation)],
          (input) => {
            input.requiredHumanInput = structuredClone(notApplicableInput.requiredHumanInput);
          },
        ),
      ).toEqual(["not-applicable"]);

      const blockedRecord = outcomeRecord(product.repository, "blocked");
      const blockedOutcome = blockedRecord.workflowOutcome!;
      const blockedReference: DocumentationMaturityEvidenceReferenceV1 = {
        id: `workflow-outcome:${blockedOutcome.outcomeSha256}`,
        kind: "workflow-outcome",
        sha256: blockedOutcome.outcomeSha256,
        productDisposition: "blocked",
      };
      expect(
        acceptedDispositions({ ...product.authority, outcomeRecords: [blockedRecord] }, [
          referenceFor(product.observation),
          blockedReference,
        ]),
      ).toEqual(["blocked"]);
      expect(
        acceptedDispositions(
          { ...allMissingHuman.authority, outcomeRecords: [blockedRecord] },
          [referenceFor(product.observation), blockedReference],
          (input) => {
            input.requiredHumanInput = structuredClone(allMissingHuman.requiredHumanInput);
          },
        ),
      ).toEqual([]);

      expect(acceptedDispositions(product.authority, [referenceFor(product.observation)])).toEqual([
        "satisfied",
      ]);
    },
    process.env.CI ? 180_000 : 15_000,
  );

  it("retains fingerprints across equivalent revisions but changes material identity", () => {
    const first = observationAuthority("absent", REVISION);
    const second = observationAuthority("absent", NEXT_REVISION);
    const firstFinding = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(first.observation), { confidence: "confirmed" }),
      first.authority,
    );
    const changedMetadata = candidate("observed-absence", referenceFor(second.observation), {
      confidence: "confirmed",
    });
    changedMetadata.id = "finding:renamed";
    changedMetadata.issuePriority = "P1";
    changedMetadata.severity = "major";
    const secondFinding = createDocumentationMaturityFinding(changedMetadata, second.authority);
    expect(secondFinding.fingerprint).toBe(firstFinding.fingerprint);
    expect(secondFinding.findingSha256).not.toBe(firstFinding.findingSha256);

    expect(
      documentationMaturityFindingFingerprint({
        ...firstFinding,
        affectedPaths: ["docs/other.md"],
      }),
    ).not.toBe(firstFinding.fingerprint);
    expect(
      documentationMaturityFindingFingerprint({
        ...firstFinding,
        findingKey: "different-rule",
      }),
    ).not.toBe(firstFinding.fingerprint);
  });

  it("requires work units to be executable or enumerate missing input", () => {
    const { authority, observation } = observationAuthority("absent");
    const finding = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(observation), { confidence: "confirmed" }),
      authority,
    );
    const ready = createDocumentationMaturityWorkUnit(
      {
        id: "work-unit:add-guide",
        dependsOnWorkUnitIds: [],
        execution: {
          state: "ready",
          governedInputs: [{ id: "input:add-guide-v1", sha256: SHA("governed-input") }],
          missingInputIds: [],
        },
      },
      finding,
      authority,
    );
    expect(validateDocumentationMaturityWorkUnit(ready, finding, authority)).toEqual(ready);
    expect(ready.trackerMutation).toBe("not-authorized");
    expect(ready.affectedPaths).toEqual(finding.affectedPaths);
    expect(ready.audienceImpact).toEqual(finding.audienceImpact);
    expect(ready.confidence).toBe(finding.confidence);
    expectContractError(
      () =>
        createDocumentationMaturityWorkUnit(
          {
            id: "work-unit:unresolved-input",
            dependsOnWorkUnitIds: [],
            execution: {
              state: "ready",
              governedInputs: [{ id: "input:not-in-authority", sha256: SHA("invented") }],
              missingInputIds: [],
            },
          },
          finding,
          authority,
        ),
      "invalid-work-unit",
    );

    const missingCandidate = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    missingCandidate.requiredHumanInput = [
      {
        id: "input:owner",
        kind: "other",
        claim: "other",
        status: "missing",
        decision: null,
        valueSha256: null,
      },
    ];
    const missingAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      humanInputRequirements: [
        humanRequirementFor(
          missingCandidate,
          observation.repository,
          missingCandidate.requiredHumanInput[0]!,
        ),
      ],
    };
    const missingFinding = createDocumentationMaturityFinding(missingCandidate, missingAuthority);
    expectContractError(
      () =>
        createDocumentationMaturityWorkUnit(
          {
            id: "work-unit:invent-owner",
            dependsOnWorkUnitIds: [],
            execution: {
              state: "ready",
              governedInputs: [{ id: "input:invented", sha256: SHA("invented") }],
              missingInputIds: [],
            },
          },
          missingFinding,
          missingAuthority,
        ),
      "invalid-work-unit",
    );
    const missing = createDocumentationMaturityWorkUnit(
      {
        id: "work-unit:needs-owner",
        dependsOnWorkUnitIds: [],
        execution: {
          state: "missing-input",
          governedInputs: null,
          missingInputIds: ["input:owner"],
        },
      },
      missingFinding,
      missingAuthority,
    );
    expect(missing.execution).toEqual({
      state: "missing-input",
      governedInputs: null,
      missingInputIds: ["input:owner"],
    });
  });

  it("rejects rehashed evidence and repository substitutions at the authority boundary", () => {
    const authentic = observationAuthority("absent");
    const finding = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(authentic.observation), {
        confidence: "confirmed",
      }),
      authentic.authority,
    );
    const forged = structuredClone(finding);
    forged.evidence[0]!.sha256 = "f".repeat(64);
    rehashFinding(forged);
    expect(decodeDocumentationMaturityFinding(forged)).toEqual(forged);
    expectContractError(
      () => validateDocumentationMaturityFinding(forged, authentic.authority),
      "contradictory-evidence",
    );

    const alternate = observationAuthority("absent", NEXT_REVISION);
    const alternateFinding = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(alternate.observation), {
        confidence: "confirmed",
      }),
      alternate.authority,
    );
    expectContractError(
      () => validateDocumentationMaturityFinding(alternateFinding, authentic.authority),
      "contradictory-evidence",
    );
  });

  it("rejects fully rehashed cross-gate, subject, path, scope, workflow, and step attacks", () => {
    const { authority, observation } = observationAuthority("absent");
    const authentic = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(observation), { confidence: "confirmed" }),
      authority,
    );
    const audit = getWorkflow("review-documentation");
    const polish = getWorkflow("update-documentation");
    const attacks: Array<(value: DocumentationMaturityFindingV1) => void> = [
      (value) => {
        value.gateId = "G5";
      },
      (value) => {
        value.requirement = { ...value.requirement, id: "maintenance-policy" };
      },
      (value) => {
        value.requirement = { ...value.requirement, subjectSha256: SHA("other-subject") };
      },
      (value) => {
        value.affectedPaths = ["docs/maintenance.md"];
      },
      (value) => {
        value.scopeSha256 = SHA("other-scope");
      },
      (value) => {
        value.workflow = { name: "review-documentation", stepId: audit.steps[0]!.id };
      },
      (value) => {
        value.workflow = { name: "update-documentation", stepId: polish.steps[0]!.id };
      },
    ];
    for (const attack of attacks) {
      const forged = structuredClone(authentic);
      attack(forged);
      rehashFinding(forged);
      expect(decodeDocumentationMaturityFinding(forged)).toEqual(forged);
      expectContractError(
        () => validateDocumentationMaturityFinding(forged, authority),
        "contradictory-evidence",
      );
    }
  });

  it("rejects mutually exclusive facts for one exact material binding", async () => {
    const base = observationAuthority("absent");
    const present = createDocumentationRepositoryObservation({
      ...withoutObservationDigest(base.observation),
      id: "observation:present-conflict",
      observation: "present",
    });
    const contradictory: DocumentationMaturityAuthorityV1 = {
      ...base.authority,
      repositoryObservations: [base.observation, present],
    };
    expectContractError(
      () =>
        createDocumentationMaturityFinding(
          candidate("observed-absence", referenceFor(base.observation), {
            confidence: "confirmed",
          }),
          contradictory,
        ),
      "contradictory-evidence",
    );

    const search = await localSearchAuthority(REVISION, "blocked");
    try {
      const blocked = search.findings[0]!;
      const positive = createDocumentationRepositoryObservation({
        id: "observation:positive-conflict",
        repository: {
          identitySha256: search.authority.repositoryIdentitySha256,
          revision: REVISION,
        },
        gateId: search.binding.gateId,
        requirement: search.binding.requirement,
        observation: "present",
        paths: search.binding.affectedPaths,
        scopeSha256: search.binding.scopeSha256,
      });
      const negative = createDocumentationRepositoryObservation({
        id: "observation:negative-conflict",
        repository: {
          identitySha256: search.authority.repositoryIdentitySha256,
          revision: REVISION,
        },
        gateId: search.binding.gateId,
        requirement: search.binding.requirement,
        observation: "absent",
        paths: search.binding.affectedPaths,
        scopeSha256: search.binding.scopeSha256,
      });
      const input = {
        ...candidate("blocked", searchReference(blocked), { confidence: "confirmed" }),
        ...search.binding,
        requiredWorkflowInputs: [
          {
            id: "input:blocked-search",
            status: "missing" as const,
            sha256: null,
          },
        ],
      };
      let refusal: unknown;
      try {
        createDocumentationMaturityFinding(input, {
          ...search.authority,
          repositoryObservations: [positive, negative],
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DocumentationMaturityContractError);
      expect(refusal).toMatchObject({ code: "contradictory-evidence" });
    } finally {
      await search.cleanup();
    }
  });

  it("binds human decisions to exact claims and rejects support-required as not-applicable", () => {
    const { authority, observation } = observationAuthority("present");
    const input = candidate("not-applicable", referenceFor(observation), {
      confidence: "confirmed",
      severity: "informational",
      impact: "none",
    });
    input.requiredHumanInput = [
      {
        id: "input:support",
        kind: "support-commitment",
        claim: "support-requirement",
        status: "provided",
        decision: "support-required",
        valueSha256: SHA("support-required"),
      },
    ];
    const supportAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      humanInputRequirements: [
        humanRequirementFor(input, observation.repository, input.requiredHumanInput[0]!),
      ],
      humanInputs: [
        {
          id: "input:support",
          kind: "support-commitment",
          claim: "support-requirement",
          decision: "support-required",
          valueSha256: SHA("support-required"),
          repository: observation.repository,
          gateId: input.gateId,
          requirement: input.requirement,
          affectedPaths: input.affectedPaths,
          scopeSha256: input.scopeSha256,
        },
      ],
    };
    expectContractError(
      () => createDocumentationMaturityFinding(input, supportAuthority),
      "contradictory-evidence",
    );

    const policy = candidate("not-applicable", referenceFor(observation), {
      confidence: "confirmed",
      severity: "informational",
      impact: "none",
    });
    policy.requiredHumanInput = [
      {
        id: "input:policy",
        kind: "product-policy",
        claim: "applicability",
        status: "provided",
        decision: "not-applicable",
        valueSha256: SHA("not-applicable"),
      },
    ];
    const correct = policyAuthorityFor(policy, observation.repository);
    expect(
      createDocumentationMaturityFinding(policy, {
        ...authority,
        humanInputRequirements: [
          humanRequirementFor(policy, observation.repository, policy.requiredHumanInput[0]!),
        ],
        humanInputs: [correct],
      }).disposition,
    ).toBe("not-applicable");
    for (const altered of [
      { ...correct, gateId: "G5" as const },
      { ...correct, requirement: { ...correct.requirement, subjectSha256: SHA("other") } },
      { ...correct, affectedPaths: ["docs/other.md"] },
      { ...correct, scopeSha256: SHA("other-scope") },
    ]) {
      expectContractError(
        () =>
          createDocumentationMaturityFinding(policy, {
            ...authority,
            humanInputRequirements: [
              humanRequirementFor(policy, observation.repository, policy.requiredHumanInput[0]!),
            ],
            humanInputs: [altered],
          }),
        "invalid-authority",
      );
    }
  });

  it("binds governed inputs to repository, gate, requirement, workflow, and finding", () => {
    const { authority, observation } = observationAuthority("absent");
    const input = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    const correct = authority.governedInputs.find((item) => item.id === "input:add-guide-v1")!;
    expect(
      createDocumentationMaturityFinding(input, authority).requiredWorkflowInputs[0]?.status,
    ).toBe("available");
    const auditStep = getWorkflow("review-documentation").steps[0]!.id;
    const substitutions = [
      { ...correct, sha256: SHA("wrong-input") },
      { ...correct, gateId: "G5" as const },
      { ...correct, requirement: { ...correct.requirement, id: "other-requirement" } },
      { ...correct, workflow: { name: "review-documentation" as const, stepId: auditStep } },
      { ...correct, findingFingerprint: SHA("other-finding") },
    ];
    for (const substituted of substitutions) {
      expect(() =>
        createDocumentationMaturityFinding(input, {
          ...authority,
          governedInputs: authority.governedInputs.map((item) =>
            item.id === correct.id ? substituted : item,
          ),
        }),
      ).toThrow(DocumentationMaturityContractError);
    }
  });

  it("requires the missing-input set to equal human and workflow requirements exactly", () => {
    const { authority, observation } = observationAuthority("absent");
    const input = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    input.requiredHumanInput = [
      {
        id: "input:owner",
        kind: "other",
        claim: "other",
        status: "missing",
        decision: null,
        valueSha256: null,
      },
    ];
    input.requiredWorkflowInputs = [{ id: "input:rubric", status: "missing", sha256: null }];
    const exactAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      humanInputRequirements: [
        humanRequirementFor(input, observation.repository, input.requiredHumanInput[0]!),
      ],
      workflowInputRequirements: [
        {
          ...authority.workflowInputRequirements[0]!,
          id: "input:rubric",
        },
      ],
      governedInputs: [],
    };
    const finding = createDocumentationMaturityFinding(input, exactAuthority);
    const make = (missingInputIds: string[]) => ({
      id: "work-unit:exact-missing",
      dependsOnWorkUnitIds: [],
      execution: { state: "missing-input" as const, governedInputs: null, missingInputIds },
    });
    expect(
      createDocumentationMaturityWorkUnit(
        make(["input:owner", "input:rubric"]),
        finding,
        exactAuthority,
      ).execution.missingInputIds,
    ).toEqual(["input:owner", "input:rubric"]);
    for (const wrong of [["input:owner"], ["input:owner", "input:rubric", "input:invented"]]) {
      expectContractError(
        () => createDocumentationMaturityWorkUnit(make(wrong), finding, exactAuthority),
        "invalid-work-unit",
      );
    }
  });

  it("rejects rehashed work-unit expansion and tracker authorization", () => {
    const { authority, observation } = observationAuthority("absent");
    const finding = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(observation), { confidence: "confirmed" }),
      authority,
    );
    const workUnit = createDocumentationMaturityWorkUnit(
      {
        id: "work-unit:bounded",
        dependsOnWorkUnitIds: [],
        execution: {
          state: "ready",
          governedInputs: [{ id: "input:add-guide-v1", sha256: SHA("governed-input") }],
          missingInputIds: [],
        },
      },
      finding,
      authority,
    );
    const expanded = { ...structuredClone(workUnit), trackerMutation: "authorized" };
    rehash(expanded, "workUnitSha256");
    expectContractError(() => decodeDocumentationMaturityWorkUnit(expanded), "invalid-work-unit");

    const relinked = structuredClone(workUnit);
    relinked.findingFingerprint = "f".repeat(64);
    rehash(relinked, "workUnitSha256");
    expectContractError(
      () => validateDocumentationMaturityWorkUnit(relinked, finding, authority),
      "invalid-work-unit",
    );
  });

  it("produces sanitized projections without paths, human values, or source checkouts", () => {
    const { authority, observation, repository } = observationAuthority("present");
    const input = candidate("unknown", referenceFor(observation), { confidence: "inconclusive" });
    input.requiredHumanInput = [
      {
        id: "input:owner",
        kind: "ownership",
        claim: "ownership",
        status: "missing",
        decision: null,
        valueSha256: null,
      },
    ];
    const inputAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      humanInputRequirements: [
        humanRequirementFor(input, observation.repository, input.requiredHumanInput[0]!),
      ],
    };
    const finding = createDocumentationMaturityFinding(input, inputAuthority);
    const workUnit = createDocumentationMaturityWorkUnit(
      {
        id: "work-unit:sanitized",
        dependsOnWorkUnitIds: [],
        execution: {
          state: "missing-input",
          governedInputs: null,
          missingInputIds: ["input:owner"],
        },
      },
      finding,
      inputAuthority,
    );
    const findingProjection = projectSanitizedDocumentationMaturityFinding(finding);
    const workUnitProjection = projectSanitizedDocumentationMaturityWorkUnit(workUnit);
    const rendered = JSON.stringify([findingProjection, workUnitProjection]);
    expect(rendered).not.toContain("docs/guide.md");
    expect(rendered).not.toContain(repository.sourcePath);
    expect(rendered).not.toContain("input:owner");
    expect(findingProjection.missingHumanInputKinds).toEqual(["ownership"]);
    expect(workUnitProjection.missingInputCount).toBe(1);
  });

  it("uses explicit identity migration and rejects unknown schema versions", () => {
    const { authority, observation } = observationAuthority("absent");
    const migrationCandidate = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    migrationCandidate.requiredWorkflowInputs = [
      {
        id: "input:migration",
        status: "available",
        sha256: SHA("migration"),
      },
    ];
    const migrationAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      workflowInputRequirements: [
        {
          ...authority.workflowInputRequirements[0]!,
          id: "input:migration",
        },
      ],
      governedInputs: [
        {
          ...authority.governedInputs[0]!,
          id: "input:migration",
          sha256: SHA("migration"),
        },
      ],
    };
    const finding = createDocumentationMaturityFinding(migrationCandidate, migrationAuthority);
    const workUnit = createDocumentationMaturityWorkUnit(
      {
        id: "work-unit:migration",
        dependsOnWorkUnitIds: [],
        execution: {
          state: "ready",
          governedInputs: [{ id: "input:migration", sha256: SHA("migration") }],
          missingInputIds: [],
        },
      },
      finding,
      migrationAuthority,
    );
    expect(migrateDocumentationMaturityFinding(finding)).toEqual(finding);
    expect(migrateDocumentationMaturityWorkUnit(workUnit)).toEqual(workUnit);
    expectContractError(
      () => migrateDocumentationMaturityFinding({ ...finding, schemaVersion: 2 }),
      "migration-required",
    );
    expectContractError(
      () => migrateDocumentationMaturityWorkUnit({ ...workUnit, schemaVersion: 0 }),
      "migration-required",
    );
  });

  it("rejects hostile proxies and accessors without invoking user code", () => {
    let trapHits = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          trapHits += 1;
          return undefined;
        },
        getPrototypeOf() {
          trapHits += 1;
          return Object.prototype;
        },
        ownKeys() {
          trapHits += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          trapHits += 1;
          return undefined;
        },
      },
    );
    expectContractError(() => decodeDocumentationMaturityFinding(proxy), "invalid-finding");
    expectContractError(() => decodeDocumentationMaturityWorkUnit(proxy), "invalid-work-unit");
    expectContractError(
      () => decodeDocumentationRepositoryObservation(proxy),
      "invalid-observation",
    );
    expect(trapHits).toBe(0);

    let getterHits = 0;
    const accessor = {};
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get() {
        getterHits += 1;
        return 1;
      },
    });
    expectContractError(() => decodeDocumentationMaturityFinding(accessor), "invalid-finding");
    expect(getterHits).toBe(0);
  });

  it.each([
    "/Users/maintainer/private.md",
    "../private.md",
    "docs/../private.md",
    "C:\\Users\\maintainer\\private.md",
    "docs\\private.md",
  ])("rejects hostile repository path %s", (unsafePath) => {
    const { authority, observation } = observationAuthority("absent");
    const input = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    input.affectedPaths = [unsafePath];
    expectContractError(
      () => createDocumentationMaturityFinding(input, authority),
      "invalid-finding",
    );
  });

  it("rejects gate/priority substitution and host-path-shaped identifiers", () => {
    const { authority, observation } = observationAuthority("absent");
    const input = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    input.gateId = "P0" as typeof input.gateId;
    expectContractError(
      () => createDocumentationMaturityFinding(input, authority),
      "invalid-finding",
    );
    input.gateId = "G1";
    input.issuePriority = "G1" as typeof input.issuePriority;
    expectContractError(
      () => createDocumentationMaturityFinding(input, authority),
      "invalid-finding",
    );
    input.issuePriority = "P0";
    input.requiredHumanInput = [
      {
        id: "input:/Users/maintainer/private",
        kind: "ownership",
        claim: "ownership",
        status: "missing",
        decision: null,
        valueSha256: null,
      },
    ];
    expectContractError(
      () => createDocumentationMaturityFinding(input, authority),
      "invalid-finding",
    );
    input.requiredHumanInput[0]!.id = "input:foo/../../private";
    expectContractError(
      () => createDocumentationMaturityFinding(input, authority),
      "invalid-finding",
    );

    const safe = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    safe.requiredHumanInput = [
      {
        id: "input:team/docs-owner",
        kind: "other",
        claim: "other",
        status: "missing",
        decision: null,
        valueSha256: null,
      },
    ];
    const safeAuthority: DocumentationMaturityAuthorityV1 = {
      ...authority,
      humanInputRequirements: [
        humanRequirementFor(safe, observation.repository, safe.requiredHumanInput[0]!),
      ],
    };
    expect(createDocumentationMaturityFinding(safe, safeAuthority).requiredHumanInput[0]?.id).toBe(
      "input:team/docs-owner",
    );

    for (const requestedRevision of ["HEAD\0other", "main\nnext"]) {
      expectContractError(
        () =>
          createDocumentationMaturityFinding(safe, {
            ...safeAuthority,
            repository: { ...safeAuthority.repository, requestedRevision },
          }),
        "invalid-authority",
      );
    }
  });

  it("rejects credential material and remains provider/harness neutral", () => {
    configureCredential("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    const { authority, observation } = observationAuthority("absent");
    const input = candidate("observed-absence", referenceFor(observation), {
      confidence: "confirmed",
    });
    input.id = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    expectContractError(
      () => createDocumentationMaturityFinding(input, authority),
      "invalid-finding",
    );

    const valid = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(observation), { confidence: "confirmed" }),
      authority,
    );
    const rendered = JSON.stringify(valid);
    expect(rendered).not.toMatch(/pi-coding-agent|model|provider|apiKey/u);
  });
});

function observationAuthority(observationKind: "present" | "absent", revision = REVISION) {
  const repository = {
    sourcePath: "/selected/documentation-repository",
    requestedRevision: revision,
    revision,
  };
  const repositoryIdentitySha256 = SHA(repository.sourcePath);
  const observation = createDocumentationRepositoryObservation({
    id: `observation:${observationKind}`,
    repository: { identitySha256: repositoryIdentitySha256, revision },
    gateId: "G1",
    requirement: REQUIREMENT,
    observation: observationKind,
    paths: ["docs/guide.md"],
    scopeSha256: SCOPE_SHA256,
  });
  const repositoryBinding = { identitySha256: repositoryIdentitySha256, revision };
  const findingFingerprint = documentationMaturityFindingFingerprint({
    repository: repositoryBinding,
    gateId: "G1",
    findingKey: "public-guide-missing",
    requirement: REQUIREMENT,
    scopeSha256: SCOPE_SHA256,
    affectedPaths: ["docs/guide.md"],
  });
  const governedInput = (id: string, sha256: string) => ({
    id,
    sha256,
    repository: repositoryBinding,
    gateId: "G1" as const,
    requirement: REQUIREMENT,
    workflow: { name: "readiness" as const, stepId: "assess-readiness" },
    findingFingerprint,
  });
  const authority: DocumentationMaturityAuthorityV1 = {
    repository,
    repositoryIdentitySha256,
    repositoryObservations: [observation],
    searches: [],
    gapLedger: null,
    outcomeRecords: [],
    humanInputRequirements: [],
    humanInputs: [],
    workflowInputRequirements: [
      {
        id: "input:add-guide-v1",
        repository: repositoryBinding,
        gateId: "G1",
        requirement: REQUIREMENT,
        workflow: { name: "readiness", stepId: "assess-readiness" },
        findingFingerprint,
      },
    ],
    governedInputs: [governedInput("input:add-guide-v1", SHA("governed-input"))],
  };
  return { authority, observation, repository };
}

function candidate(
  disposition: DocumentationMaturityFindingCandidateV1["disposition"],
  evidence: DocumentationMaturityEvidenceReferenceV1 | DocumentationMaturityEvidenceReferenceV1[],
  overrides: {
    confidence: DocumentationMaturityFindingCandidateV1["confidence"];
    severity?: DocumentationMaturityFindingCandidateV1["severity"];
    impact?: "blocked" | "degraded" | "none";
  },
): DocumentationMaturityFindingCandidateV1 {
  return {
    id: "finding:public-guide",
    findingKey: "public-guide-missing",
    gateId: "G1",
    requirement: REQUIREMENT,
    scopeSha256: SCOPE_SHA256,
    disposition,
    issuePriority: "P0",
    severity: overrides.severity ?? "critical",
    confidence: overrides.confidence,
    audienceImpact: [{ audience: "new-user", impact: overrides.impact ?? "blocked" }],
    affectedPaths: ["docs/guide.md"],
    dependencyFingerprints: [],
    requiredHumanInput: [],
    requiredWorkflowInputs: [
      {
        id: "input:add-guide-v1",
        status: "available",
        sha256: SHA("governed-input"),
      },
    ],
    workflow: { name: "readiness", stepId: "assess-readiness" },
    acceptanceCriteria: [
      {
        id: "criterion:guide-observed",
        evidenceKinds: ["documentation-search", "repository-observation"],
      },
    ],
    verification: [
      {
        id: "verification:guide-search",
        method: "bounded-search",
        acceptanceCriterionIds: ["criterion:guide-observed"],
      },
    ],
    evidence: Array.isArray(evidence) ? evidence : [evidence],
  };
}

function referenceFor(
  observation: ReturnType<typeof createDocumentationRepositoryObservation>,
): DocumentationMaturityEvidenceReferenceV1 {
  return {
    id: `repository-observation:${observation.observationSha256}`,
    kind: "repository-observation",
    sha256: observation.observationSha256,
  };
}

function searchReference(
  finding: ReturnType<typeof projectDocumentationSearchFindings>[number],
): DocumentationMaturityEvidenceReferenceV1 {
  return {
    id: `documentation-search:${finding.observationSha256}`,
    kind: "documentation-search",
    sha256: finding.observationSha256,
  };
}

async function localSearchAuthority(
  revision: string,
  findingClass: "absence" | "blocked" = "absence",
) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-maturity-"));
  const repository = { sourcePath: root, requestedRevision: revision, revision };
  const workflow = getWorkflow("readiness");
  const step = workflow.steps.find((item) => item.id === "assess-readiness")!;
  // An unsafe filesystem entry is a genuine host inventory blocker. Rubric
  // probes remain model-owned and the workflow's search plan stays canonical.
  if (findingClass === "blocked") await symlink("missing-guide.md", join(root, "README.md"));
  const coordinator = new LocalWorkflowSearchCoordinator();
  const result = await coordinator.search({
    runId: "run:maturity-search",
    repositoryPath: root,
    repository,
    workflow,
    step,
    plan: step.search!,
  });
  const evidence = normalizeWorkflowSearchEvidence({
    plan: step.search!,
    repository,
    repositoryIdentitySha256: result.repositoryIdentitySha256,
    searches: result.searches,
  });
  const findings = projectDocumentationSearchFindings({
    workflow: workflow.name,
    stepId: step.id,
    evidence,
  });
  const selected = findings.find((finding) => finding.findingClass === findingClass);
  expect(selected, `real ${findingClass} host-search finding`).toBeDefined();
  const binding = {
    gateId: "G1" as const,
    requirement: selected!.requirement,
    affectedPaths: ["docs/guide.md"],
    scopeSha256: SCOPE_SHA256,
  };
  const findingFingerprint = documentationMaturityFindingFingerprint({
    repository: {
      identitySha256: result.repositoryIdentitySha256,
      revision,
    },
    gateId: binding.gateId,
    findingKey: "public-guide-missing",
    requirement: binding.requirement,
    scopeSha256: binding.scopeSha256,
    affectedPaths: binding.affectedPaths,
  });
  const authority: DocumentationMaturityAuthorityV1 = {
    repository,
    repositoryIdentitySha256: result.repositoryIdentitySha256,
    repositoryObservations: [],
    searches: [
      {
        ...binding,
        workflow: workflow.name,
        stepId: step.id,
        targetId: selected!.target.id,
        evidence,
      },
    ],
    gapLedger: createDocumentationGapLedger({ currentRevision: revision, findings }),
    outcomeRecords: [],
    humanInputRequirements: [],
    humanInputs: [],
    workflowInputRequirements: [
      {
        id: findingClass === "blocked" ? "input:blocked-search" : "input:search-workflow",
        repository: { identitySha256: result.repositoryIdentitySha256, revision },
        gateId: binding.gateId,
        requirement: binding.requirement,
        workflow: { name: workflow.name, stepId: step.id },
        findingFingerprint,
      },
    ],
    governedInputs: [],
  };
  return {
    authority,
    findings: [selected!],
    allFindings: findings,
    binding,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function withoutObservationDigest(
  value: ReturnType<typeof createDocumentationRepositoryObservation>,
) {
  const { schemaVersion: _schema, kind: _kind, observationSha256: _digest, ...body } = value;
  return body;
}

function fakeMaturityWorkflowAccess(withSearch = true) {
  const definition = structuredClone(getWorkflow("readiness"));
  const source = definition.steps[0]!;
  const stepId = "fake-assess-readiness";
  definition.steps = [
    {
      ...source,
      id: stepId,
      ...(withSearch ? {} : { search: undefined, searchMode: undefined }),
    },
  ];
  return {
    stepId,
    access: {
      isWorkflowName(value: string): value is "readiness" {
        return value === "readiness";
      },
      getWorkflow(name: "readiness") {
        if (name !== "readiness") throw new Error("workflow excluded");
        return definition;
      },
    },
  };
}

function withFakeReadinessStep(
  authority: DocumentationMaturityAuthorityV1,
  stepId: string,
): DocumentationMaturityAuthorityV1 {
  const result = structuredClone(authority);
  for (const input of result.workflowInputRequirements) input.workflow.stepId = stepId;
  for (const input of result.governedInputs) input.workflow.stepId = stepId;
  for (const search of result.searches) {
    search.workflow = "readiness";
    search.stepId = stepId;
  }
  return result;
}

function policyAuthorityFor(
  candidateValue: DocumentationMaturityFindingCandidateV1,
  repository: ReturnType<typeof createDocumentationRepositoryObservation>["repository"],
) {
  return {
    id: "input:policy",
    kind: "product-policy" as const,
    claim: "applicability" as const,
    decision: "not-applicable" as const,
    valueSha256: SHA("not-applicable"),
    repository,
    gateId: candidateValue.gateId,
    requirement: candidateValue.requirement,
    affectedPaths: candidateValue.affectedPaths,
    scopeSha256: candidateValue.scopeSha256,
  };
}

function humanRequirementFor(
  candidateValue: DocumentationMaturityFindingCandidateV1,
  repository: ReturnType<typeof createDocumentationRepositoryObservation>["repository"],
  input: Pick<
    DocumentationMaturityFindingCandidateV1["requiredHumanInput"][number],
    "id" | "kind" | "claim"
  >,
) {
  return {
    id: input.id,
    kind: input.kind,
    claim: input.claim,
    repository,
    gateId: candidateValue.gateId,
    requirement: candidateValue.requirement,
    affectedPaths: candidateValue.affectedPaths,
    scopeSha256: candidateValue.scopeSha256,
  };
}

function outcomeRecord(
  repository: DocumentationMaturityAuthorityV1["repository"],
  disposition: "ready" | "not-ready" | "blocked" | "inconclusive",
): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: "run:maturity-outcome",
    workflow: "readiness",
    repository,
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    securityScan: {
      ruleSet: "docsfab-local-v2",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    steps: [
      {
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Maturity outcome fixture.",
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
  const candidate: WorkflowOutcomeCandidateV1 =
    disposition === "ready"
      ? {
          disposition,
          findings: [],
          evidence: [evidence],
          limitations: [],
          openDecisions: [],
          producedArtifacts: [],
        }
      : disposition === "not-ready"
        ? {
            disposition,
            findings: [
              {
                id: "finding:maturity-not-ready",
                kind: "product-gap",
                severity: "blocking",
                code: "maturity-not-ready",
                evidenceIds: [evidence.id],
              },
            ],
            evidence: [evidence],
            limitations: [],
            openDecisions: [],
            producedArtifacts: [],
          }
        : disposition === "blocked"
          ? {
              disposition,
              findings: [
                {
                  id: "finding:maturity-blocked",
                  kind: "blocked-dependency",
                  severity: "blocking",
                  code: "maturity-dependency-blocked",
                  evidenceIds: [evidence.id],
                },
              ],
              evidence: [evidence],
              limitations: [],
              openDecisions: [
                {
                  id: "decision:maturity-dependency",
                  kind: "dependency",
                  evidenceIds: [evidence.id],
                },
              ],
              producedArtifacts: [],
            }
          : {
              disposition,
              findings: [
                {
                  id: "finding:maturity-inconclusive",
                  kind: "evidence-limitation",
                  severity: "warning",
                  code: "maturity-evidence-inconclusive",
                  evidenceIds: [evidence.id],
                },
              ],
              evidence: [evidence],
              limitations: ["maturity-evidence-inconclusive"],
              openDecisions: [],
              producedArtifacts: [],
            };
  record.workflowOutcome = createWorkflowOutcome(candidate, record, SECURITY_SCAN_POLICY);
  return record;
}

function rehashFinding(value: DocumentationMaturityFindingV1): void {
  value.fingerprint = documentationMaturityFindingFingerprint(value);
  rehash(value as unknown as Record<string, unknown>, "findingSha256");
}

function rehash(value: object, digestKey: string): void {
  const body: Record<string, unknown> = { ...structuredClone(value) };
  delete body[digestKey];
  Object.assign(value, { [digestKey]: canonicalDigest(body) });
}

function expectContractError(
  invoke: () => unknown,
  code: ConstructorParameters<typeof DocumentationMaturityContractError>[0],
): void {
  expect(invoke).toThrowError(new DocumentationMaturityContractError(code));
}
