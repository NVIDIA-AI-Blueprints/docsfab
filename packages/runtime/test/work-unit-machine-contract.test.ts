// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DOCUMENTATION_MATURITY_GATE_CATALOG,
  WorkUnitMachineContractError,
  admitsWorkUnitMachineContractForCampaign,
  createDocumentationMaturityFinding,
  createDocumentationMaturityWorkUnit,
  createDocumentationRepositoryObservation,
  createWorkUnitMachineContract,
  decodeDocumentationMaturityGateCatalog,
  decodeDocumentationMaturityWorkUnit,
  decodeWorkUnitMachineContract,
  documentationMaturityFindingFingerprint,
  requireWorkUnitMachineContractForMeaAdmission,
  type DocumentationMaturityAuthorityV1,
  type DocumentationMaturityEvidenceReferenceV1,
  type DocumentationMaturityFindingCandidateV1,
  type WorkUnitMachineCheckV1,
  type WorkUnitMachineContractBodyV1,
  type WorkUnitMachineContractV1,
} from "./support/maturity-contracts.js";
import {
  WORK_UNIT_MACHINE_CHECK_KINDS,
  WORK_UNIT_MACHINE_CONTRACT_KIND,
} from "../src/maturity/work-unit-machine-contract.js";
import { configureCredential } from "./helpers/configured-credential.js";

const SHA = (value: string) => createHash("sha256").update(value).digest("hex");
const REVISION = "a".repeat(40);
const REQUIREMENT = { id: "public-guide", subjectSha256: SHA("public-guide-requirement") };
const SCOPE_SHA256 = SHA("public-guide-scope");

const GATE_CATALOG_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/runtime-evaluation/maturity/gate-catalog-v1.json", import.meta.url),
    "utf8",
  ),
);

function validBody(
  overrides: Partial<WorkUnitMachineContractBodyV1> = {},
): WorkUnitMachineContractBodyV1 {
  const machineChecks: WorkUnitMachineCheckV1[] = [
    {
      checkKind: "npm-script",
      commandId: "check",
      expectedOutcomeClass: "pass",
    },
    {
      checkKind: "vitest-file",
      vitestFileId: "test/work-unit-machine-contract.test.ts",
      expectedOutcomeClass: "pass",
    },
  ];
  return {
    workUnitFingerprint: SHA("bound-work-unit"),
    repositoryIdentitySha256: SHA("repository-identity"),
    machineChecks,
    acceptanceAuthority: "host-deterministic",
    trackerMutation: "not-authorized",
    ...overrides,
  };
}

function expectContractError(run: () => unknown, code: WorkUnitMachineContractError["code"]): void {
  try {
    run();
    throw new Error(`expected WorkUnitMachineContractError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkUnitMachineContractError);
    expect((error as WorkUnitMachineContractError).code).toBe(code);
  }
}

function observationAuthority(observationKind: "present" | "absent" = "absent") {
  const repository = {
    sourcePath: "/selected/documentation-repository",
    requestedRevision: REVISION,
    revision: REVISION,
  };
  const repositoryIdentitySha256 = SHA(repository.sourcePath);
  const observation = createDocumentationRepositoryObservation({
    id: `observation:${observationKind}`,
    repository: { identitySha256: repositoryIdentitySha256, revision: REVISION },
    gateId: "G1",
    requirement: REQUIREMENT,
    observation: observationKind,
    paths: ["docs/guide.md"],
    scopeSha256: SCOPE_SHA256,
  });
  const repositoryBinding = { identitySha256: repositoryIdentitySha256, revision: REVISION };
  const findingFingerprint = documentationMaturityFindingFingerprint({
    repository: repositoryBinding,
    gateId: "G1",
    findingKey: "public-guide-missing",
    requirement: REQUIREMENT,
    scopeSha256: SCOPE_SHA256,
    affectedPaths: ["docs/guide.md"],
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
    governedInputs: [
      {
        id: "input:add-guide-v1",
        sha256: SHA("governed-input"),
        repository: repositoryBinding,
        gateId: "G1",
        requirement: REQUIREMENT,
        workflow: { name: "readiness", stepId: "assess-readiness" },
        findingFingerprint,
      },
    ],
  };
  return { authority, observation, repository };
}

function candidate(
  disposition: DocumentationMaturityFindingCandidateV1["disposition"],
  evidence: DocumentationMaturityEvidenceReferenceV1,
  confidence: DocumentationMaturityFindingCandidateV1["confidence"],
): DocumentationMaturityFindingCandidateV1 {
  return {
    id: "finding:public-guide",
    findingKey: "public-guide-missing",
    gateId: "G1",
    requirement: REQUIREMENT,
    scopeSha256: SCOPE_SHA256,
    disposition,
    issuePriority: "P0",
    severity: "critical",
    confidence,
    audienceImpact: [{ audience: "new-user", impact: "blocked" }],
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
    evidence: [evidence],
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

describe("WorkUnitMachineContractV1", () => {
  it("decodes and freezes a valid envelope with non-empty machineChecks + fingerprint binding", () => {
    const created = createWorkUnitMachineContract(validBody());
    expect(created.kind).toBe(WORK_UNIT_MACHINE_CONTRACT_KIND);
    expect(created.schemaVersion).toBe(1);
    expect(created.machineChecks).toHaveLength(2);
    expect(created.trackerMutation).toBe("not-authorized");
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.machineChecks)).toBe(true);
    const decoded = decodeWorkUnitMachineContract(structuredClone(created));
    expect(decoded).toEqual(created);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it("rejects empty machineChecks, unknown fields, missing fingerprint, host-path/credential-like ids", () => {
    configureCredential("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expectContractError(
      () => createWorkUnitMachineContract(validBody({ machineChecks: [] })),
      "invalid-value",
    );

    const valid = createWorkUnitMachineContract(validBody());
    const unknownField = { ...structuredClone(valid), extra: true };
    expectContractError(() => decodeWorkUnitMachineContract(unknownField), "invalid-shape");

    const { workUnitFingerprint: _omit, ...missingFingerprint } = validBody();
    expectContractError(
      () => createWorkUnitMachineContract(missingFingerprint as WorkUnitMachineContractBodyV1),
      "invalid-shape",
    );

    expectContractError(
      () =>
        createWorkUnitMachineContract(
          validBody({
            machineChecks: [
              {
                checkKind: "npm-script",
                commandId: "/Users/operator/.npmrc",
                expectedOutcomeClass: "pass",
              },
            ],
          }),
        ),
      "invalid-value",
    );
    expectContractError(
      () =>
        createWorkUnitMachineContract(
          validBody({
            machineChecks: [
              {
                checkKind: "cli-smoke",
                commandId: "C:/Windows/System32/cmd.exe",
                expectedOutcomeClass: "pass",
              },
            ],
          }),
        ),
      "invalid-value",
    );
    expectContractError(
      () =>
        createWorkUnitMachineContract(
          validBody({
            machineChecks: [
              {
                checkKind: "fixture-key",
                fixtureKey: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                expectedOutcomeClass: "pass",
              },
            ],
          }),
        ),
      "credential-material",
    );
  });

  it("keeps the closed checkKind set from #255", () => {
    expect([...WORK_UNIT_MACHINE_CHECK_KINDS]).toEqual([
      "npm-script",
      "vitest-file",
      "cli-smoke",
      "fixture-key",
      "inventory-probe",
    ]);
    for (const checkKind of WORK_UNIT_MACHINE_CHECK_KINDS) {
      const check = ((): WorkUnitMachineCheckV1 => {
        switch (checkKind) {
          case "npm-script":
            return { checkKind, commandId: "check", expectedOutcomeClass: "pass" };
          case "cli-smoke":
            return { checkKind, commandId: "docsfab-doctor", expectedOutcomeClass: "pass" };
          case "vitest-file":
            return {
              checkKind,
              vitestFileId: "test/work-unit-machine-contract.test.ts",
              expectedOutcomeClass: "pass",
            };
          case "fixture-key":
            return { checkKind, fixtureKey: "gate-catalog-v1", expectedOutcomeClass: "pass" };
          case "inventory-probe":
            return {
              checkKind,
              inventoryProbeId: "docs-inventory",
              expectedOutcomeClass: "fail-closed",
            };
        }
      })();
      const contract = createWorkUnitMachineContract(validBody({ machineChecks: [check] }));
      expect(contract.machineChecks[0]!.checkKind).toBe(checkKind);
    }
    expectContractError(
      () =>
        createWorkUnitMachineContract(
          validBody({
            machineChecks: [
              {
                checkKind: "shell-script" as "npm-script",
                commandId: "check",
                expectedOutcomeClass: "pass",
              },
            ],
          }),
        ),
      "invalid-value",
    );
  });

  it("rejects noncanonical machineChecks order and open acceptanceAuthority", () => {
    const contract = createWorkUnitMachineContract(validBody());
    const unsorted = structuredClone(contract) as WorkUnitMachineContractV1 & {
      machineChecks: WorkUnitMachineCheckV1[];
    };
    unsorted.machineChecks = [...unsorted.machineChecks].reverse();
    expectContractError(() => decodeWorkUnitMachineContract(unsorted), "digest-mismatch");
    expectContractError(
      () =>
        createWorkUnitMachineContract(
          validBody({
            acceptanceAuthority: "evaluate-alone" as "host-deterministic",
          }),
        ),
      "invalid-value",
    );
    expectContractError(
      () =>
        createWorkUnitMachineContract(
          validBody({
            trackerMutation: "authorized" as "not-authorized",
          }),
        ),
      "invalid-value",
    );
  });

  it("keeps existing maturity work-unit v1 / gate fixtures valid without the envelope", () => {
    const catalog = decodeDocumentationMaturityGateCatalog(
      structuredClone(DOCUMENTATION_MATURITY_GATE_CATALOG),
    );
    expect({
      schemaVersion: catalog.schemaVersion,
      catalogVersion: catalog.version,
      gateOrder: catalog.gates.map((gate) => gate.id),
    }).toMatchObject({
      schemaVersion: GATE_CATALOG_FIXTURE.schemaVersion,
      catalogVersion: GATE_CATALOG_FIXTURE.catalogVersion,
      gateOrder: GATE_CATALOG_FIXTURE.gateOrder,
    });

    const { authority, observation } = observationAuthority("absent");
    const finding = createDocumentationMaturityFinding(
      candidate("observed-absence", referenceFor(observation), "confirmed"),
      authority,
    );
    const workUnit = createDocumentationMaturityWorkUnit(
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
    expect(decodeDocumentationMaturityWorkUnit(structuredClone(workUnit))).toEqual(workUnit);
    expect(admitsWorkUnitMachineContractForCampaign(workUnit)).toBe(false);
  });

  it("fails closed for campaign/MEA admission when the envelope is absent", () => {
    expect(admitsWorkUnitMachineContractForCampaign(null)).toBe(false);
    expect(admitsWorkUnitMachineContractForCampaign(undefined)).toBe(false);
    expectContractError(
      () => requireWorkUnitMachineContractForMeaAdmission(undefined),
      "missing-machine-contract",
    );
    const contract = createWorkUnitMachineContract(
      validBody({
        acceptanceAuthority: "evaluate-step-plus-host",
      }),
    );
    expect(admitsWorkUnitMachineContractForCampaign(contract)).toBe(true);
    expect(requireWorkUnitMachineContractForMeaAdmission(structuredClone(contract))).toEqual(
      contract,
    );
  });
});
