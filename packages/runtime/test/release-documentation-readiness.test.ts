// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalDigest, canonicalJson } from "../src/content-ir/canonical.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RunStore } from "../src/records/contracts.js";
import {
  createReleaseDocumentationReadinessArtifact,
  createReleaseDocumentationReadinessResult,
  emitReleaseDocumentationWorkUnitMachineContracts,
  ReleaseDocumentationReadinessError,
  validateReleaseDocumentationReadinessArtifact,
} from "../src/release-documentation-readiness.js";
import {
  admitsWorkUnitMachineContractForCampaign,
  decodeWorkUnitMachineContract,
  WORK_UNIT_MACHINE_CONTRACT_KIND,
} from "../src/maturity/work-unit-machine-contract.js";
import { renderReleaseDocumentationReadinessScorecard } from "../src/release-documentation-scorecard.js";
import {
  createDocumentationGapLedger,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "../src/search/gap-ledger.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  decodeRepositoryDiscoveryInventory,
  validateRepositoryBatchReplayAuthority,
} from "../src/repository/inventory.js";
import { releaseDocumentationQuestion } from "../src/release-documentation-rubric.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { authorizeSecurityScan } from "../src/security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../src/security/scan-disposition.js";
import { createWorkflowOutcome } from "../src/workflow-contracts/outcome.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../src/workflow-contracts/search.js";
import { readyContextPreflight } from "./helpers.js";
import { compositionEvidenceFor, compositionModelEvidence } from "./helpers/composition-record.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import type {
  ModelEvidence,
  ModelProfileEvidence,
  SkillEvidence,
} from "../src/records/contracts.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const temporary: string[] = [];
const activeWorkspaces: Array<Awaited<ReturnType<typeof prepareRepositoryWorkspace>>> = [];
const assessedCache = new Map<string, Promise<Awaited<ReturnType<typeof assessedRecord>>>>();
const resultCache = new Map<
  string,
  Promise<ReturnType<typeof createReleaseDocumentationReadinessResult>>
>();
/** Assessment walks are slow under shared-runner load. */
const readinessTimeoutMs = process.env.CI ? 180_000 : 60_000;
let incompleteRepository: string;
let completeRepository: string;
let incompleteInventoryRepository: string;
let keywordStuffedRepository: string;
const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

beforeAll(async () => {
  [
    incompleteRepository,
    completeRepository,
    incompleteInventoryRepository,
    keywordStuffedRepository,
  ] = await Promise.all([
    repositoryFixture({ complete: false }),
    repositoryFixture({ complete: true }),
    repositoryFixture({ complete: false, trackedSymlink: true }),
    repositoryFixture({ complete: false, keywordStuffed: true }),
  ]);
});

afterAll(async () => {
  await Promise.all(activeWorkspaces.splice(0).map((workspace) => workspace.dispose()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("public release-documentation readiness", () => {
  it("keeps source readiness separate and defines target-specific release coverage", () => {
    const source = getWorkflow("readiness");
    const release = getWorkflow("release-documentation-readiness");
    expect(source.name).not.toBe(release.name);
    expect(source.steps[0]!.id).toBe("assess-readiness");
    expect(release.steps[0]!.id).toBe("assess-release-documentation-readiness");
    expect(release.steps[0]!.mode).toBe("read-only");
    expect(release.steps[0]!.search!.targets).toHaveLength(30);
    expect(new Set(release.steps[0]!.search!.targets.map((item) => item.targetKey)).size).toBe(30);
  });

  it(
    "produces a stable major-gap set, typed work units, and not-ready product outcome",
    async () => {
      const repository = incompleteRepository;
      const first = await cachedAssessedRecord(repository);
      const firstArtifact = await cachedArtifact(repository);
      const secondArtifact = createReleaseDocumentationReadinessArtifact(
        first.record,
        first.expected,
        first.trustedInventory,
      );

      expect(firstArtifact.disposition).toBe("not-ready");
      expect(
        firstArtifact.findings.filter((item) => item.state === "missing").length,
      ).toBeGreaterThanOrEqual(10);
      expect(
        firstArtifact.findings
          .filter((item) => item.state === "missing" || item.state === "needs-human-decision")
          .map((item) => item.category),
      ).toEqual(
        expect.arrayContaining([
          "site-infrastructure",
          "information-architecture",
          "journey",
          "reference",
          "governance",
          "human-decision",
        ]),
      );
      expect(firstArtifact.findings.map((item) => [item.targetId, item.state])).toEqual(
        secondArtifact.findings.map((item) => [item.targetId, item.state]),
      );
      expect(firstArtifact.workUnits.map((item) => item.targetId)).toEqual(
        secondArtifact.workUnits.map((item) => item.targetId),
      );
      expect(
        firstArtifact.workUnits.every(
          (item) =>
            item.acceptanceCriteria.length > 0 &&
            item.verification.length > 0 &&
            Array.isArray(item.dependencies) &&
            Array.isArray(item.requiredHumanInput) &&
            item.trackerMutation === "not-authorized",
        ),
      ).toBe(true);
      expect(firstArtifact.downstreamConsumers).toEqual(["#43", "#46"]);
      expect(firstArtifact.trackerMutation).toBe("not-authorized");
      expect(
        firstArtifact.findings
          .filter((item) => item.state === "missing")
          .every((item) => item.evidence.negativeObservationSha256 !== null),
      ).toBe(true);

      first.record.releaseDocumentationReadiness = firstArtifact;
      first.record.workflowOutcome = createWorkflowOutcome(
        (await cachedResult(repository)).outcome,
        first.record,
        SECURITY_SCAN_POLICY,
      );
      const scorecard = renderReleaseDocumentationReadinessScorecard(
        first.record,
        first.expected,
        first.trustedInventory,
      );
      expect(scorecard).toContain("Product disposition: not-ready");
      expect(scorecard).toContain("Tracker mutation: not-authorized");
      const candidate = (await cachedResult(repository)).outcome;
      const outcome = createWorkflowOutcome(candidate, first.record, SECURITY_SCAN_POLICY);
      expect(outcome.disposition).toBe("not-ready");
      expect(outcome.findings.every((item) => item.kind === "product-gap")).toBe(true);
      expect(outcome.openDecisions.map((item) => item.kind)).toContain("human-decision");
    },
    readinessTimeoutMs,
  );

  it(
    "emits valid machine contracts bound to each workUnitFingerprint (#267)",
    async () => {
      const repository = incompleteRepository;
      const artifact = await cachedArtifact(repository);
      expect(artifact.workUnits.length).toBeGreaterThan(0);

      const contracts = emitReleaseDocumentationWorkUnitMachineContracts(artifact);
      expect(contracts).toHaveLength(artifact.workUnits.length);

      for (const [index, contract] of contracts.entries()) {
        const unit = artifact.workUnits[index]!;
        const decoded = decodeWorkUnitMachineContract(contract);
        expect(decoded.kind).toBe(WORK_UNIT_MACHINE_CONTRACT_KIND);
        expect(decoded.workUnitFingerprint).toBe(unit.workUnitSha256);
        expect(decoded.repositoryIdentitySha256).toBe(artifact.repositoryIdentitySha256);
        expect(decoded.trackerMutation).toBe("not-authorized");
        expect(decoded.acceptanceAuthority).toBe("host-deterministic");
        expect(decoded.machineChecks.length).toBeGreaterThan(0);
        expect(admitsWorkUnitMachineContractForCampaign(decoded)).toBe(true);
      }

      const projected = await cachedResult(repository);
      expect(projected.machineContracts).toHaveLength(artifact.workUnits.length);
      expect(projected.machineContracts.map((item) => item.machineContractSha256)).toEqual(
        contracts.map((item) => item.machineContractSha256),
      );
    },
    readinessTimeoutMs,
  );

  it(
    "never translates provider, tool, scanner, or execution failure into not-ready",
    async () => {
      const repository = incompleteRepository;
      const assessed = await cachedAssessedRecord(repository);
      const candidate = (await cachedResult(repository)).outcome;

      const providerFailed = structuredClone(assessed.record);
      providerFailed.status = "failed";
      providerFailed.steps[0]!.status = "failed";
      expect(() =>
        createReleaseDocumentationReadinessArtifact(
          providerFailed,
          assessed.expected,
          assessed.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);

      const toolFailed = structuredClone(assessed.record);
      const failedTools = {
        totalCalls: 1,
        failedCalls: 1,
        byTool: [{ name: "read", calls: 1, failures: 1 }],
        failureCategories: [{ category: "tool-defect" as const, count: 1 }],
      };
      toolFailed.tools = failedTools;
      toolFailed.steps[0]!.tools = failedTools;
      expect(() =>
        createReleaseDocumentationReadinessArtifact(
          toolFailed,
          assessed.expected,
          assessed.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
      expect(() => createWorkflowOutcome(candidate, toolFailed, SECURITY_SCAN_POLICY)).toThrow();

      // No findings, so this case reaches the non-advisory status gate at the
      // end of `validateScannerEvidence`; a `path: "."` finding would be
      // rejected earlier by the finding-shape check.
      const scannerFailed = structuredClone(assessed.record);
      scannerFailed.securityScan = {
        ruleSet: "scanner-unavailable",
        status: "failed",
        scannedFiles: 0,
        binaryFiles: 0,
        findings: [],
      };
      scannerFailed.securityScanEffectiveDisposition = {
        status: "failed",
      };
      expect(() =>
        createReleaseDocumentationReadinessArtifact(
          scannerFailed,
          assessed.expected,
          assessed.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
      expect(() => createWorkflowOutcome(candidate, scannerFailed, SECURITY_SCAN_POLICY)).toThrow();
    },
    readinessTimeoutMs,
  );

  it(
    "persists the typed artifact and product outcome through the production runner",
    async () => {
      const repository = incompleteRepository;
      const before = await git(repository, ["status", "--porcelain=v1"], { trim: false });
      const assessed = await cachedAssessedRecord(repository);
      const admittedSearch = assessed.record.steps[0]!.searchEvidence!;
      const repositoryIdentitySha256 =
        admittedSearch.searches[0]!.bounded.target.repository.identitySha256;
      const store = new MemoryStore();
      const runner = new WorkflowRunner({
        harness: { runStep: async () => ({ summary: "Release documentation assessed." }) },
        store,
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "test-v1",
            status: "passed",
            scannedFiles: 2,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: readyContextPreflight,
        workflowSearch: {
          search: async () => ({
            repositoryIdentitySha256,
            searches: structuredClone(admittedSearch.searches),
            trustedRepositoryInventory: assessed.trustedInventory,
            repositoryBatchAuthority: structuredClone(
              assessed.record.steps[0]!.repositoryBatchAuthority!,
            ),
          }),
        },
        now: () => new Date("2026-08-05T12:00:00.000Z"),
        id: () => "run:production-release-readiness",
      });
      const record = await runner.run({
        workflow: "release-documentation-readiness",
        workspacePath: "/tracked/release-readiness-export",
        repository: structuredClone(assessed.record.repository),
        allowWrite: false,
        releaseDefaultBranch: "main",
      });
      expect({ status: record.status, error: record.error, step: record.steps[0]?.error }).toEqual({
        status: "succeeded",
        error: undefined,
        step: undefined,
      });
      expect(record.releaseDocumentationReadiness?.disposition).toBe("not-ready");
      expect(record.workflowOutcome?.disposition).toBe("not-ready");
      expect(store.records.at(-1)?.releaseDocumentationReadiness?.artifactSha256).toBe(
        record.releaseDocumentationReadiness?.artifactSha256,
      );
      expect(await git(repository, ["status", "--porcelain=v1"], { trim: false })).toBe(before);
    },
    readinessTimeoutMs,
  );

  it(
    "renders the scorecard for a composition-mode run through the production runner",
    async () => {
      const repository = incompleteRepository;
      const assessed = await cachedAssessedRecord(repository);
      const admittedSearch = assessed.record.steps[0]!.searchEvidence!;
      const runId = "run:composition-release-readiness";
      const compositionExecution = await compositionEvidenceFor({
        runId,
        workflow: "release-documentation-readiness",
        sourcePath: assessed.record.repository.sourcePath,
        revision: assessed.record.repository.revision,
      });
      const model = compositionModelEvidence(compositionExecution);
      const runner = new WorkflowRunner({
        harness: {
          inspectSkill: async ({ step }) => fixtureSkill(step.skill),
          runStep: async (input) => ({
            summary: "Release documentation assessed.",
            model: structuredClone(model),
            skill: fixtureSkill(input.step.skill),
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
            tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
            turns: [governedFixtureTurn(input, model)],
          }),
        },
        store: new MemoryStore(),
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "test-v1",
            status: "passed",
            scannedFiles: 2,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: readyContextPreflight,
        workflowSearch: {
          search: async () => ({
            repositoryIdentitySha256:
              admittedSearch.searches[0]!.bounded.target.repository.identitySha256,
            searches: structuredClone(admittedSearch.searches),
            trustedRepositoryInventory: assessed.trustedInventory,
            repositoryBatchAuthority: structuredClone(
              assessed.record.steps[0]!.repositoryBatchAuthority!,
            ),
          }),
        },
        now: () => new Date("2026-08-05T12:00:00.000Z"),
        id: () => runId,
      });
      const record = await runner.run({
        runId,
        workflow: "release-documentation-readiness",
        workspacePath: "/tracked/release-readiness-export",
        repository: structuredClone(assessed.record.repository),
        allowWrite: false,
        releaseDefaultBranch: "main",
        compositionExecution,
      });
      expect({ status: record.status, error: record.error, step: record.steps[0]?.error }).toEqual({
        status: "succeeded",
        error: undefined,
        step: undefined,
      });
      expect(record.compositionExecutionAggregate).toBeDefined();
      const scorecard = renderReleaseDocumentationReadinessScorecard(
        record,
        assessed.expected,
        assessed.trustedInventory,
      );
      expect(scorecard).toContain("- Product disposition: not-ready");

      // Control for the same reader: a step edited after the aggregate sealed it.
      const edited = structuredClone(record);
      edited.steps[0]!.summary = "Release documentation assessed (edited after sealing).";
      expect(() =>
        renderReleaseDocumentationReadinessScorecard(
          edited,
          assessed.expected,
          assessed.trustedInventory,
        ),
      ).toThrow("Scorecard run record rejected: composition-aggregate-mismatch.");
    },
    readinessTimeoutMs,
  );

  it(
    "allows a complete fixture to reach ready without inventing policy values",
    async () => {
      const repository = completeRepository;
      const assessed = await cachedAssessedRecord(repository);
      const audienceProfile =
        assessed.record.steps[0]!.repositoryBatchAuthority!.inventory.documentProfiles!.find(
          (profile) => profile.path === "docs/audiences.md",
        );
      expect(audienceProfile).toMatchObject({
        contentClasses: ["launch-audiences"],
        sectionCount: 3,
        substantiveSectionCount: 3,
      });
      expect(
        assessed.record.steps[0]!.repositoryBatchAuthority!.targets.find(
          (target) => target.targetId === "release-launch-audiences",
        )!.evidence.results.map((result) => [result.disposition, result.paths]),
      ).toEqual([
        ["found", ["docs/audiences.md"]],
        ["found", ["docs/audiences.md"]],
      ]);
      expect(
        assessed.record.steps[0]!.searchEvidence!.searches.find(
          (target) => target.targetId === "release-launch-audiences",
        )!.bounded.finding.disposition,
      ).toBe("found");
      const artifact = await cachedArtifact(repository);
      expect(
        artifact.findings
          .filter((item) => item.state !== "covered")
          .map((item) => [item.targetId, item.state]),
      ).toEqual([]);
      expect(artifact.disposition).toBe("ready");
      expect(artifact.findings.every((item) => item.state === "covered")).toBe(true);
      expect(artifact.workUnits).toEqual([]);
      const serialized = canonicalJson(artifact);
      expect(serialized).not.toContain(repository);
      expect(serialized).not.toContain("support@example");
      expect(serialized).not.toContain("guarantee");
      assessed.record.releaseDocumentationReadiness = artifact;
      expect(
        createWorkflowOutcome(
          (await cachedResult(repository)).outcome,
          assessed.record,
          SECURITY_SCAN_POLICY,
        ).disposition,
      ).toBe("ready");
    },
    readinessTimeoutMs,
  );

  it(
    "keeps keyword stuffing and prose-only approval below ready",
    async () => {
      const artifact = await cachedArtifact(keywordStuffedRepository);
      expect(artifact.disposition).toBe("not-ready");
      expect(artifact.findings.some((item) => item.state === "needs-human-decision")).toBe(true);
      expect(artifact.findings.filter((item) => item.state === "covered").length).toBeLessThan(10);
    },
    readinessTimeoutMs,
  );

  it(
    "never turns incomplete inventory or an unsupported coordinator into absence",
    async () => {
      const repository = incompleteInventoryRepository;
      const incomplete = await cachedAssessedRecord(repository);
      const artifact = await cachedArtifact(repository);
      expect(artifact.disposition).toBe("blocked");
      expect(artifact.findings.some((item) => item.state === "blocked")).toBe(true);
      incomplete.record.releaseDocumentationReadiness = artifact;
      expect(
        createWorkflowOutcome(
          (await cachedResult(repository)).outcome,
          incomplete.record,
          SECURITY_SCAN_POLICY,
        ).disposition,
      ).toBe("blocked");

      const noWorkspace = await unsupportedRecord(repository);
      expect(() =>
        createReleaseDocumentationReadinessArtifact(
          noWorkspace,
          { ...noWorkspace.repository, defaultBranch: "main" },
          incomplete.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
    },
    readinessTimeoutMs,
  );

  it(
    "rejects canonical rehashes, whole-authority substitution, accessors, and proxies",
    async () => {
      const repository = incompleteRepository;
      const original = await cachedAssessedRecord(repository);
      const artifact = await cachedArtifact(repository);
      const altered = structuredClone(artifact);
      altered.workUnits[0]!.priority = "P2";
      rehashWorkUnit(altered, 0);
      rehashArtifact(altered);
      expect(() =>
        validateReleaseDocumentationReadinessArtifact(
          altered,
          original.record,
          original.expected,
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);

      const alternateRepository = completeRepository;
      const alternate = await cachedAssessedRecord(alternateRepository);
      const alternateArtifact = await cachedArtifact(alternateRepository);
      expect(() =>
        validateReleaseDocumentationReadinessArtifact(
          alternateArtifact,
          original.record,
          original.expected,
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
      const wholeAlternateAuthority = structuredClone(alternate.record);
      wholeAlternateAuthority.releaseDocumentationReadiness = alternateArtifact;
      wholeAlternateAuthority.workflowOutcome = createWorkflowOutcome(
        (await cachedResult(alternateRepository)).outcome,
        wholeAlternateAuthority,
        SECURITY_SCAN_POLICY,
      );
      expect(() =>
        validateReleaseDocumentationReadinessArtifact(
          alternateArtifact,
          wholeAlternateAuthority,
          original.expected,
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);

      const swappedBatches = structuredClone(original.record);
      const replay = swappedBatches.steps[0]!.repositoryBatchAuthority!;
      [replay.targets[0], replay.targets[1]] = [replay.targets[1]!, replay.targets[0]!];
      rehashReplayAuthority(replay);
      expect(() =>
        createReleaseDocumentationReadinessArtifact(
          swappedBatches,
          original.expected,
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
      expect(() =>
        createReleaseDocumentationReadinessArtifact(
          original.record,
          { ...original.expected, defaultBranch: "substituted-main" },
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);

      let getterCalls = 0;
      const accessor = Object.defineProperty({}, "schemaVersion", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 1;
        },
      });
      expect(() =>
        validateReleaseDocumentationReadinessArtifact(
          accessor,
          original.record,
          original.expected,
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
      expect(getterCalls).toBe(0);
      let traps = 0;
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            traps += 1;
            return [];
          },
        },
      );
      expect(() =>
        validateReleaseDocumentationReadinessArtifact(
          proxy,
          original.record,
          original.expected,
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
      expect(traps).toBe(0);
    },
    readinessTimeoutMs,
  );

  it(
    "rejects a fully rehashed invented approval and a cloned inventory capability",
    async () => {
      const original = await cachedAssessedRecord(incompleteRepository);
      const plan = getWorkflow("release-documentation-readiness").steps[0]!.search!;
      const repositoryIdentitySha256 =
        original.record.steps[0]!.searchEvidence!.searches[0]!.bounded.target.repository
          .identitySha256;
      const targets = instantiateWorkflowSearchTargets(plan, {
        identitySha256: repositoryIdentitySha256,
        revision: original.expected.revision,
      });
      const forged = structuredClone(original.record.steps[0]!.repositoryBatchAuthority!);
      fabricateApprovedDecisionAndRehashReplay(forged, "release-security", "release-security");
      expect(() => decodeRepositoryDiscoveryInventory(forged.inventory)).not.toThrow();
      expect(
        original.trustedInventory.files.some(
          (item) => item.path === ".docsfab-release-documentation-decisions.json",
        ),
      ).toBe(false);
      const validate = (trustedInventory: typeof original.trustedInventory) =>
        validateRepositoryBatchReplayAuthority(forged, {
          repositoryIdentitySha256,
          repositoryRevision: original.expected.revision,
          repositoryWorkspace: original.record.repository,
          trustedInventory,
          targets,
          requestsForTarget: (target) =>
            target.requiredProbes.map((probe) => ({
              id: probe.id,
              question: releaseDocumentationQuestion(target.targetKey, probe.id)!,
            })),
        });
      expect(() => validate(original.trustedInventory)).toThrow();
      expect(() => validate(structuredClone(original.trustedInventory))).toThrow();
      expect(() => validate(forged.inventory as typeof original.trustedInventory)).toThrow();

      const artifact = await cachedArtifact(incompleteRepository);
      expect(() =>
        validateReleaseDocumentationReadinessArtifact(
          artifact,
          original.record,
          original.expected,
          structuredClone(original.trustedInventory),
        ),
      ).toThrow(ReleaseDocumentationReadinessError);

      const alternate = await cachedAssessedRecord(completeRepository);
      const alternateArtifact = await cachedArtifact(completeRepository);
      alternate.record.releaseDocumentationReadiness = alternateArtifact;
      alternate.record.workflowOutcome = createWorkflowOutcome(
        (await cachedResult(completeRepository)).outcome,
        alternate.record,
        SECURITY_SCAN_POLICY,
      );
      expect(() =>
        validateReleaseDocumentationReadinessArtifact(
          alternateArtifact,
          alternate.record,
          alternate.expected,
          original.trustedInventory,
        ),
      ).toThrow(ReleaseDocumentationReadinessError);
    },
    readinessTimeoutMs,
  );
});

async function assessedRecord(repository: string) {
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  activeWorkspaces.push(workspace);
  const workflow = getWorkflow("release-documentation-readiness");
  const step = workflow.steps[0]!;
  const repositoryTarget = {
    sourcePath: workspace.sourcePath,
    requestedRevision: workspace.requestedRevision,
    revision: workspace.revision,
  };
  const result = await new LocalWorkflowSearchCoordinator({ workspace }).search({
    runId: "run:release-readiness",
    repositoryPath: workspace.path,
    repository: repositoryTarget,
    workflow,
    step,
    plan: step.search!,
    repositoryDefaultBranch: "main",
  });
  const searchEvidence = normalizeWorkflowSearchEvidence({
    plan: step.search!,
    repository: repositoryTarget,
    repositoryIdentitySha256: result.repositoryIdentitySha256,
    searches: result.searches,
  });
  return {
    workspace,
    trustedInventory: result.trustedRepositoryInventory!,
    expected: { ...repositoryTarget, defaultBranch: "main" } as const,
    record: recordFor(repositoryTarget, searchEvidence, result.repositoryBatchAuthority),
  };
}

function cachedAssessedRecord(repository: string) {
  let value = assessedCache.get(repository);
  if (!value) {
    value = assessedRecord(repository);
    assessedCache.set(repository, value);
  }
  return value;
}

function cachedArtifact(repository: string) {
  return cachedResult(repository).then(({ artifact }) => artifact);
}

function cachedResult(repository: string) {
  let value = resultCache.get(repository);
  if (!value) {
    value = cachedAssessedRecord(repository).then(({ record, expected, trustedInventory }) =>
      createReleaseDocumentationReadinessResult(record, expected, trustedInventory),
    );
    resultCache.set(repository, value);
  }
  return value;
}

async function unsupportedRecord(repository: string): Promise<RunRecord> {
  const workflow = getWorkflow("release-documentation-readiness");
  const step = workflow.steps[0]!;
  const revision = await git(repository, ["rev-parse", "HEAD"]);
  const repositoryTarget = { sourcePath: repository, requestedRevision: "HEAD", revision };
  const result = await new LocalWorkflowSearchCoordinator().search({
    runId: "run:unsupported-release-readiness",
    repositoryPath: repository,
    repository: repositoryTarget,
    workflow,
    step,
    plan: step.search!,
    repositoryDefaultBranch: "main",
  });
  const searchEvidence = normalizeWorkflowSearchEvidence({
    plan: step.search!,
    repository: repositoryTarget,
    repositoryIdentitySha256: result.repositoryIdentitySha256,
    searches: result.searches,
  });
  return recordFor(repositoryTarget, searchEvidence, result.repositoryBatchAuthority);
}

function recordFor(
  repository: RunRecord["repository"],
  searchEvidence: NonNullable<RunRecord["steps"][number]["searchEvidence"]>,
  repositoryBatchAuthority?: NonNullable<RunRecord["steps"][number]["repositoryBatchAuthority"]>,
): RunRecord {
  const findings = projectDocumentationSearchFindings({
    workflow: "release-documentation-readiness",
    stepId: "assess-release-documentation-readiness",
    evidence: searchEvidence,
  });
  const negative = negativeDocumentationEvidence(findings);
  const ledger = createDocumentationGapLedger({ currentRevision: repository.revision, findings });
  return {
    schemaVersion: 2,
    id: "run:release-readiness",
    workflow: "release-documentation-readiness",
    repository,
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T12:00:00.000Z",
    startedAt: "2026-08-05T12:00:00.000Z",
    completedAt: "2026-08-05T12:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
    securityScan: {
      ruleSet: "test-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: {
      status: "passed",
    },
    searchFindings: findings,
    negativeEvidence: negative,
    gapLedger: ledger,
    steps: [
      {
        id: "assess-release-documentation-readiness",
        title: "Assess public release-documentation readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T12:00:00.000Z",
        completedAt: "2026-08-05T12:00:01.000Z",
        durationMs: 1_000,
        contextPreflight: {
          status: "ready",
          packetDigest: "a".repeat(64),
          consultedNodeIds: [],
          ontologyVersion: "test-ontology-v1",
          effectiveDecisionIds: [],
        },
        searchEvidence,
        ...(repositoryBatchAuthority ? { repositoryBatchAuthority } : {}),
        searchFindings: findings,
        negativeEvidence: negative,
        gapLedger: ledger,
        summary: "Host-projected release documentation readiness fixture.",
      },
    ],
  };
}

async function repositoryFixture(options: {
  complete: boolean;
  trackedSymlink?: boolean;
  keywordStuffed?: boolean;
}) {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-release-readiness-"));
  temporary.push(repository);
  await initFixtureRepo(repository);
  const files: Record<string, string> = options.complete
    ? {
        ".gitlab-ci.yml": "docs: { script: npm run docs:link-check }\n",
        ".docsfab.json": JSON.stringify({
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
        }),
        ".docsfab-release-documentation-decisions.json": JSON.stringify({
          schemaVersion: 1,
          decisions: [
            "release-security",
            "release-limitations",
            "release-trust-boundaries",
            "release-compatibility",
            "release-support",
            "release-lifecycle",
            "release-ownership",
            "release-review-policy",
            "release-explicit-human-decisions",
          ].map((topic) => ({ topic, status: "approved" })),
        }),
        "AGENTS.md":
          "# Documentation guidance\n\nPublic documentation changes require evidence and validation.\n",
        "README.md":
          "# Product\n\nUse the [documentation map](docs/information-architecture.md) for public guidance.\n",
        "docusaurus.config.ts": "export default {};\n",
        "package.json": JSON.stringify({
          scripts: { "docs:build": "opaque", "docs:link-check": "opaque" },
          dependencies: { "@docusaurus/core": "1.0.0" },
        }),
      }
    : {
        "README.md": "# Product\n",
        "package.json": JSON.stringify({ scripts: { test: "opaque" } }),
      };
  if (options.complete) {
    const classes = [
      "audiences",
      "personas",
      "user-jobs",
      "site-templates",
      "information-architecture",
      "installation",
      "quickstart",
      "first-success",
      "task-guides",
      "cli-reference",
      "configuration-reference",
      "api-reference",
      "troubleshooting",
      "failure-modes",
      "security",
      "limitations",
      "trust-boundaries",
      "releases",
      "compatibility",
      "support",
      "lifecycle",
      "ownership",
      "freshness",
      "review-policy",
      "human-decisions",
    ];
    for (const name of classes) {
      files[`docs/${name}.md`] = substantiveDocument(name, {
        procedures: [
          "installation",
          "quickstart",
          "first-success",
          "task-guides",
          "troubleshooting",
        ].includes(name),
        code: ["cli-reference", "configuration-reference", "api-reference"].includes(name),
      });
    }
    files["sidebars.json"] = `${JSON.stringify([
      "docs/information-architecture",
      "docs/quickstart",
    ])}\n`;
  }
  if (options.keywordStuffed) {
    Object.assign(files, {
      ".docsfab-release-documentation-decisions.json": JSON.stringify({
        schemaVersion: 1,
        decisions: [{ topic: "release-security", status: "unknown" }],
      }),
      "docs/audiences.md": "# Audiences\nLaunch audience\nPersona\nUser jobs\n",
      "docs/quickstart.md": "# Quickstart\nInstallation\nFirst success\nTask guide\n",
      "docs/release-security-support-lifecycle.md":
        "# Release\nSecurity approved\nSupport approved\nLifecycle approved\nLimitations approved\n",
    });
  }
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), contents);
  }
  if (options.trackedSymlink) await symlink("README.md", join(repository, "docs-link.md"));
  await commitFixture(repository, "fixture");
  return repository;
}

function substantiveDocument(
  name: string,
  options: { procedures: boolean; code: boolean },
): string {
  const procedures = options.procedures
    ? "\n1. Confirm the immutable repository revision.\n2. Follow the documented bounded action.\n3. Validate the stated observable result.\n"
    : "";
  const code = options.code ? "\n```text\ndocsfab example --bounded\n```\n" : "";
  return [
    `# ${name}`,
    "",
    "This public guidance states its audience, scope, prerequisites, and observable outcome without inventing policy or product behavior.",
    "It is revision-bound and directs readers to evidence they can inspect before relying on the procedure.",
    "",
    "## Purpose and prerequisites",
    "",
    "Readers should confirm the selected repository, immutable revision, and applicable authorization before beginning.",
    "The guidance distinguishes documented behavior from decisions that still require an accountable human approval.",
    procedures,
    "## Validation and next steps",
    "",
    "Validate the result with the repository-provided command and preserve the content-minimized run record for review.",
    "If validation differs from the documented result, stop and record the limitation instead of inferring success.",
    code,
    "See the [public information architecture](information-architecture.md) for related release documentation.",
    "",
  ].join("\n");
}

function rehashWorkUnit(
  artifact: ReturnType<typeof createReleaseDocumentationReadinessArtifact>,
  index: number,
) {
  const unit = artifact.workUnits[index]!;
  const body = { ...unit };
  delete (body as Partial<typeof unit>).workUnitSha256;
  unit.workUnitSha256 = canonicalDigest(body);
}

function rehashArtifact(artifact: ReturnType<typeof createReleaseDocumentationReadinessArtifact>) {
  const body = { ...artifact };
  delete (body as Partial<typeof artifact>).artifactSha256;
  artifact.artifactSha256 = canonicalDigest(body);
}

function rehashReplayAuthority(
  authority: NonNullable<RunRecord["steps"][number]["repositoryBatchAuthority"]>,
) {
  const body = { ...authority };
  delete (body as Partial<typeof authority>).authoritySha256;
  authority.authoritySha256 = canonicalDigest(body);
}

function fabricateApprovedDecisionAndRehashReplay(
  authority: NonNullable<RunRecord["steps"][number]["repositoryBatchAuthority"]>,
  targetId: string,
  topic: string,
) {
  const inventory = authority.inventory;
  const decisionPath = ".docsfab-release-documentation-decisions.json" as const;
  if (!inventory.files.some((file) => file.path === decisionPath)) {
    const fileBody = {
      id: `file:${canonicalDigest({ path: decisionPath, kind: "regular" }).slice(0, 32)}`,
      path: decisionPath,
      kind: "regular" as const,
      byteLength: 96,
    };
    inventory.files = [
      ...inventory.files,
      { ...fileBody, evidenceSha256: canonicalDigest(fileBody) },
    ].sort((left, right) => compareCodePoints(left.path, right.path));
    inventory.coverage.structure.indexedCount = inventory.files.length;
    const coverageBody = {
      kind: "structure",
      policy: inventory.coverage.structure.policy,
      status: inventory.coverage.structure.status,
      indexedCount: inventory.coverage.structure.indexedCount,
      excludedCount: inventory.coverage.structure.excludedCount,
      omittedCount: inventory.coverage.structure.omittedCount,
    };
    inventory.coverage.structure.evidenceSha256 = canonicalDigest(coverageBody);
    inventory.structuralSha256 = canonicalDigest({
      forgedTrackedTree: inventory.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        byteLength: file.byteLength,
      })),
    });
  }
  const factBody = {
    id: `decision:${canonicalDigest(topic).slice(0, 32)}`,
    topic,
    status: "approved" as const,
    path: decisionPath,
  };
  inventory.decisionFacts = [
    ...(inventory.decisionFacts ?? []).filter((fact) => fact.topic !== topic),
    { ...factBody, evidenceSha256: canonicalDigest(factBody) },
  ].sort((left, right) => compareCodePoints(left.topic, right.topic));
  const inventoryBody = { ...inventory };
  delete (inventoryBody as Partial<typeof inventory>).inventorySha256;
  inventory.inventorySha256 = canonicalDigest(inventoryBody);

  for (const target of authority.targets) {
    target.evidence.inventorySha256 = inventory.inventorySha256;
    for (const [index, result] of target.evidence.results.entries()) {
      const request = target.requests[index]!;
      if (
        target.targetId === targetId &&
        request.question.kind === "decision-status" &&
        request.question.topic === topic
      ) {
        result.disposition = "found";
        result.failureCategory = null;
        result.matchCount = 1;
        result.evidenceIds = [factBody.id];
        result.paths = [factBody.path];
      }
      const resultBody = { ...result };
      delete (resultBody as Partial<typeof result>).evidenceSha256;
      result.evidenceSha256 = canonicalDigest({
        inventorySha256: inventory.inventorySha256,
        targetSha256: target.evidence.targetSha256,
        requestSha256: result.requestSha256,
        result: resultBody,
      });
    }
    const evidenceBody = { ...target.evidence };
    delete (evidenceBody as Partial<typeof target.evidence>).evidenceSha256;
    target.evidence.evidenceSha256 = canonicalDigest(evidenceBody);
  }
  rehashReplayAuthority(authority);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

function fixtureSkill(id: string): SkillEvidence {
  return {
    id,
    contentSha256: canonicalDigest({ id }),
    bundleSha256: canonicalDigest({ bundle: id }),
    version: "1.0.0",
    license: "Apache-2.0",
    source: {
      repository: "skill-catalog",
      revision: "a".repeat(40),
      path: `skills/${id}/SKILL.md`,
    },
    toolPolicy: { declared: [], granted: [], withheld: [] },
  };
}

/** The governed first-turn evidence a composition step records. */
function governedFixtureTurn(
  input: HarnessStepInput,
  model: ModelEvidence & { profile: ModelProfileEvidence },
) {
  return governProviderTurn({
    context: { messages: [{ role: "user", content: "Assess release documentation." }] },
    policy: {
      budget: {
        configuredContextWindow: model.profile.configuredContextWindow,
        effectiveContextWindow: model.profile.effectiveContextWindow,
        configuredMaxInputTokens: model.profile.configuredMaxInputTokens!,
        effectiveMaxInputTokens: model.profile.effectiveMaxInputTokens!,
        configuredMaxOutputTokens: model.profile.configuredMaxOutputTokens,
        effectiveMaxOutputTokens: model.profile.effectiveMaxOutputTokens,
        reservedTokens: model.profile.requestPolicy.reservedContextTokens,
        requiredMinimumOutputTokens: model.profile.requestPolicy.minimumOutputTokens,
      },
      maxProviderTurns: 4,
      maxToolCalls: 12,
      maxCompactions: 8,
      minRecentToolTurns: 1,
    },
    state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
    evidenceIdentity: input.evidenceIdentity!,
    pinnedMessageCount: 0,
  }).evidence;
}
