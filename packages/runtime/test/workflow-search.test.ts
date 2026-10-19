// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  attestDocumentationGapReconciliation,
  createDocumentationGapLedger,
  createSearchLimitation,
  createSearchProgressObservation,
  decodeDocumentationGapRoadmapProposal,
  decodeDocumentationGapLedger,
  documentationGapLedgerFromStepFindings,
  deduplicateDocumentationSearchFindings,
  formatDocumentationGapLedgerSummary,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
  proposeDocumentationGapRoadmapUnit,
  renderDocumentationGapLedgerMarkdown,
  validateDocumentationGapRecordProjection,
  validateDocumentationGapRoadmapProposal,
  serializeBoundedSearchEvidence,
  type SearchDisposition,
  type SearchLimitationV1,
  type SearchProbeOutcome,
  type SearchProbeV1,
  type SearchTargetV1,
} from "../src/search/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import type {
  WorkflowSearchPlanV1,
  WorkflowSearchResultV1,
} from "../src/workflow-contracts/contracts.js";
import {
  decodeWorkflowSearchEvidence,
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
  snapshotWorkflowSearchCoordinatorResult,
  snapshotWorkflowSearchPlan,
  validateWorkflowSearchPlan,
} from "../src/workflow-contracts/search.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  decodeSavedWorkflowSearchEvidence,
  historicalDocumentationAuditSearch,
} from "../src/search/historical-audit-search.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { renderDocumentationGapLedgerScorecardMarkdown } from "../src/scorecard-render.js";
import {
  boundedAbsence as sharedBoundedAbsence,
  event,
  executionFor,
  pair as sharedPair,
  probe,
  progressFor,
  readinessEvidenceAt,
  REPOSITORY_IDENTITY,
} from "./helpers/search-progress-fixture.js";

const REVISION = "a".repeat(40);
const SNAPSHOT_AFTER_WRITE = "c".repeat(64);
const SHA = (value: string) => createHash("sha256").update(value).digest("hex");

const plan: WorkflowSearchPlanV1 = {
  schemaVersion: 1,
  id: "workflow-contract-fixture",
  version: "1.0.0",
  targets: [
    {
      id: "artifact",
      targetKey: "artifact",
      question: "Does the declared documentation artifact exist?",
      targetType: "artifact-existence",
      artifactClass: "documentation-artifact",
      requiredProbes: [
        { id: "artifact-exact", strategy: "exact-path", location: "documentation-tree" },
        {
          id: "artifact-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
      ],
    },
    {
      id: "rubric",
      targetKey: "rubric",
      question: "Does the documentation satisfy the declared completeness rubric?",
      targetType: "rubric-coverage",
      requiredProbes: [
        {
          id: "rubric-assessment",
          strategy: "rubric-assessment",
          location: "documentation-tree",
        },
        {
          id: "rubric-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
      ],
      rubric: {
        id: "fixture-rubric",
        version: "1.0.0",
        criteria: [
          {
            id: "complete",
            kind: "completeness",
            requiredProbeIds: ["rubric-assessment", "rubric-inventory"],
          },
        ],
      },
    },
  ],
};

describe("workflow search integration", () => {
  it("reads v1 audit evidence under the current plan without weakening v2 validation", async () => {
    const repository = repositoryAt(REVISION);
    const root = await mkdtemp(join(tmpdir(), "docsfab-historical-audit-"));
    const evidenceFor = async (searchPlan: WorkflowSearchPlanV1) => {
      const workflow = getWorkflow("review-documentation");
      const step = workflow.steps.find((candidate) => candidate.id === "audit-documentation")!;
      const result = await new LocalWorkflowSearchCoordinator().search({
        runId: "historical-audit-evidence",
        repositoryPath: root,
        repository,
        workflow,
        step: { ...step, search: searchPlan },
        plan: searchPlan,
      });
      return normalizeWorkflowSearchEvidence({
        plan: searchPlan,
        repository,
        repositoryIdentitySha256: result.repositoryIdentitySha256,
        searches: result.searches,
      });
    };
    try {
      const historical = await evidenceFor(historicalDocumentationAuditSearch);
      const current = await evidenceFor(documentationAuditSearch);

      expect(() =>
        decodeWorkflowSearchEvidence(historical, documentationAuditSearch, repository),
      ).toThrow();
      expect(
        decodeSavedWorkflowSearchEvidence(historical, documentationAuditSearch, repository),
      ).toEqual(historical);
      expect(
        decodeSavedWorkflowSearchEvidence(current, documentationAuditSearch, repository),
      ).toEqual(current);

      const forged = structuredClone(historical);
      Object.assign(forged.searches[0]!.bounded.target.rubric!, {
        version: "2.0.0-complete-coverage",
      });
      expect(() =>
        decodeSavedWorkflowSearchEvidence(forged, documentationAuditSearch, repository),
      ).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds artifact and rubric questions to one repository revision", () => {
    const targets = instantiateWorkflowSearchTargets(plan, {
      identitySha256: REPOSITORY_IDENTITY,
      revision: REVISION,
    });
    expect(targets.map((target) => target.targetType)).toEqual([
      "artifact-existence",
      "rubric-coverage",
    ]);
    expect(
      targets.every(
        (target) =>
          target.repository.identitySha256 === REPOSITORY_IDENTITY &&
          target.repository.revision === REVISION,
      ),
    ).toBe(true);
    expect(JSON.stringify(targets)).not.toContain(plan.targets[0]!.question);
  });

  it.each([
    ["positive", "found", "match"],
    ["inconclusive", "search-incomplete", "inconclusive"],
    ["blocked", "search-blocked", "blocked"],
    ["hard ceiling", "stopped-hard-ceiling", "blocked"],
  ] as const)("round-trips deterministic %s workflow evidence", (_name, disposition, outcome) => {
    const targets = instantiateWorkflowSearchTargets(plan, {
      identitySha256: REPOSITORY_IDENTITY,
      revision: REVISION,
    });
    const searches = targets.map((target) => terminalSearch(target, disposition, outcome));
    const evidence = normalizeWorkflowSearchEvidence({
      plan,
      repository: {
        sourcePath: "/ephemeral/source",
        requestedRevision: REVISION,
        revision: REVISION,
      },
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      searches,
    });
    const repeated = normalizeWorkflowSearchEvidence({
      plan,
      repository: {
        sourcePath: "/different/host/path",
        requestedRevision: REVISION,
        revision: REVISION,
      },
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      searches,
    });

    expect(repeated).toEqual(evidence);
    expect(
      evidence.searches.every(
        (search) =>
          search.bounded.confidence.disposition === disposition &&
          search.progress.recommendation.disposition === disposition,
      ),
    ).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("/ephemeral/source");
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("accepts bounded absence only after complete probes and saturated resume", () => {
    const targets = instantiateWorkflowSearchTargets(plan, {
      identitySha256: REPOSITORY_IDENTITY,
      revision: REVISION,
    });
    const searches = targets.map(boundedAbsence);
    const evidence = normalizeWorkflowSearchEvidence({
      plan,
      repository: {
        sourcePath: "/ephemeral/source",
        requestedRevision: REVISION,
        revision: REVISION,
      },
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      searches,
    });
    expect(
      evidence.searches.every(
        (search) =>
          search.bounded.coverage.sufficient &&
          search.progress.observations.length === 3 &&
          search.progress.recommendation.disposition === "not-found-after-bounded-search",
      ),
    ).toBe(true);
  });

  it("retains distinct access and tool-defect limitations without claiming absence", () => {
    const [target] = instantiateWorkflowSearchTargets(plan, {
      identitySha256: REPOSITORY_IDENTITY,
      revision: REVISION,
    });
    const access = terminalSearch(target!, "search-blocked", "blocked", "access-denied");
    const defect = terminalSearch(target!, "search-blocked", "blocked", "tool-failure");
    expect(access.progress.recommendation.disposition).toBe("search-blocked");
    expect(defect.progress.recommendation.disposition).toBe("search-blocked");
    expect(access.bounded.limitations.map((item) => item.category)).toEqual(["access-denied"]);
    expect(defect.bounded.limitations.map((item) => item.category)).toEqual(["tool-failure"]);
    expect(
      [access, defect].some(
        (search) => search.bounded.finding.disposition === "not-found-after-bounded-search",
      ),
    ).toBe(false);
  });

  it("rejects a substituted revision, unfinished renewal, and mismatched #71/#72 evidence", () => {
    const [target] = instantiateWorkflowSearchTargets(plan, {
      identitySha256: REPOSITORY_IDENTITY,
      revision: REVISION,
    });
    const valid = terminalSearch(target!, "found", "match");
    const searches = [
      valid,
      terminalSearch(
        instantiateWorkflowSearchTargets(plan, {
          identitySha256: REPOSITORY_IDENTITY,
          revision: REVISION,
        })[1]!,
        "found",
        "match",
      ),
    ];
    const normalize = (values: WorkflowSearchResultV1[]) =>
      normalizeWorkflowSearchEvidence({
        plan,
        repository: {
          sourcePath: "/ephemeral/source",
          requestedRevision: REVISION,
          revision: REVISION,
        },
        repositoryIdentitySha256: REPOSITORY_IDENTITY,
        searches: values,
      });

    const substituted = structuredClone(searches);
    substituted[0] = terminalSearch(
      instantiateWorkflowSearchTargets(plan, {
        identitySha256: REPOSITORY_IDENTITY,
        revision: "c".repeat(40),
      })[0]!,
      "found",
      "match",
    );
    expect(() => normalize(substituted)).toThrowError(/target-mismatch/u);

    const unfinished = productiveSearch(target!);
    expect(() => normalize([unfinished, searches[1]!])).toThrowError(/unfinished-search/u);

    const mismatched = structuredClone(searches);
    mismatched[0]!.bounded = boundedAbsence(target!).bounded;
    expect(() => normalize(mismatched)).toThrowError(/evidence-mismatch/u);
  });

  it("rejects malformed plans instead of accepting undeclared fields", () => {
    const malformed = structuredClone(plan) as WorkflowSearchPlanV1 & { prompt?: string };
    malformed.prompt = "new authority";
    expect(() =>
      instantiateWorkflowSearchTargets(malformed, {
        identitySha256: REPOSITORY_IDENTITY,
        revision: REVISION,
      }),
    ).toThrowError(/invalid-plan/u);
  });

  it("rejects hostile wrapper inputs without proxy traps or getter invocation", () => {
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
    const repository = {
      sourcePath: "/selected/source",
      requestedRevision: REVISION,
      revision: REVISION,
    };
    const repositoryBinding = {
      identitySha256: REPOSITORY_IDENTITY,
      revision: REVISION,
    };
    for (const invoke of [
      () => validateWorkflowSearchPlan(proxy as WorkflowSearchPlanV1),
      () => snapshotWorkflowSearchPlan(proxy as WorkflowSearchPlanV1),
      () => instantiateWorkflowSearchTargets(proxy as WorkflowSearchPlanV1, repositoryBinding),
      () => instantiateWorkflowSearchTargets(plan, proxy as typeof repositoryBinding),
      () =>
        normalizeWorkflowSearchEvidence(
          proxy as Parameters<typeof normalizeWorkflowSearchEvidence>[0],
        ),
      () =>
        snapshotWorkflowSearchCoordinatorResult(
          proxy as Parameters<typeof snapshotWorkflowSearchCoordinatorResult>[0],
        ),
      () => decodeWorkflowSearchEvidence(proxy, plan, repository),
    ]) {
      expect(invoke).toThrowError(/invalid-(?:plan|result)/u);
    }
    expect(trapHits).toBe(0);

    let getterHits = 0;
    const getterRoot = {};
    Object.defineProperty(getterRoot, "plan", {
      enumerable: true,
      get() {
        getterHits += 1;
        return plan;
      },
    });
    for (const invoke of [
      () => validateWorkflowSearchPlan(getterRoot as WorkflowSearchPlanV1),
      () => snapshotWorkflowSearchPlan(getterRoot as WorkflowSearchPlanV1),
      () => instantiateWorkflowSearchTargets(getterRoot as WorkflowSearchPlanV1, repositoryBinding),
      () =>
        normalizeWorkflowSearchEvidence(
          getterRoot as Parameters<typeof normalizeWorkflowSearchEvidence>[0],
        ),
      () =>
        snapshotWorkflowSearchCoordinatorResult(
          getterRoot as Parameters<typeof snapshotWorkflowSearchCoordinatorResult>[0],
        ),
      () => decodeWorkflowSearchEvidence(getterRoot, plan, repository),
    ]) {
      expect(invoke).toThrowError(/invalid-(?:plan|result)/u);
    }
    expect(getterHits).toBe(0);
  });

  it("keeps a coordinator's evidence warnings and refuses warnings that are not text", () => {
    const result = { repositoryIdentitySha256: REPOSITORY_IDENTITY, searches: [] };
    const warning = 'content-index-asset-left-out: "big.bin", linked from "index.md", is left out.';
    expect(
      snapshotWorkflowSearchCoordinatorResult({ ...result, evidenceWarnings: [warning] }),
    ).toEqual({ ...result, evidenceWarnings: [warning] });
    expect(() =>
      snapshotWorkflowSearchCoordinatorResult({
        ...result,
        evidenceWarnings: [7],
      } as unknown as Parameters<typeof snapshotWorkflowSearchCoordinatorResult>[0]),
    ).toThrowError(/invalid-result/u);
  });

  it.each([
    [
      "sparse array",
      () => {
        const value = structuredClone(plan);
        delete value.targets[0]!.requiredProbes[0];
        return value;
      },
    ],
    [
      "extended array",
      () => {
        const value = structuredClone(plan);
        Object.defineProperty(value.targets, "extra", { enumerable: true, value: "extra" });
        return value;
      },
    ],
    [
      "undefined",
      () => {
        const value = structuredClone(plan) as WorkflowSearchPlanV1 & { extra?: undefined };
        value.extra = undefined;
        return value;
      },
    ],
    [
      "symbol",
      () => {
        const value = structuredClone(plan);
        Object.defineProperty(value, Symbol("hidden"), { enumerable: true, value: "symbol" });
        return value;
      },
    ],
    [
      "hidden field",
      () => {
        const value = structuredClone(plan);
        Object.defineProperty(value, "hidden", { enumerable: false, value: "hidden" });
        return value;
      },
    ],
    [
      "extra field",
      () => {
        const value = structuredClone(plan) as WorkflowSearchPlanV1 & { extra?: string };
        value.extra = "extra";
        return value;
      },
    ],
    [
      "custom prototype",
      () => {
        const value = structuredClone(plan);
        Object.setPrototypeOf(value, { custom: true });
        return value;
      },
    ],
    [
      "nested accessor",
      () => {
        const value = structuredClone(plan);
        Object.defineProperty(value.targets[0], "question", {
          enumerable: true,
          get() {
            throw new Error("must not execute");
          },
        });
        return value;
      },
    ],
  ] as const)("rejects descriptor-hostile plan shape: %s", (_name, create) => {
    expect(() => validateWorkflowSearchPlan(create() as WorkflowSearchPlanV1)).toThrowError(
      /invalid-plan/u,
    );
  });

  it.each([
    ["found search and needs input", "found", "match", "needs-input", "needs-input"],
    [
      "bounded absence and successful execution",
      "not-found-after-bounded-search",
      "no-match",
      "succeeded",
      "succeeded",
    ],
  ] as const)(
    "keeps search and workflow execution dispositions separate for %s",
    async (_name, disposition, outcome, harnessOutcome, expectedStatus) => {
      let receivedSearch = false;
      const records: unknown[] = [];
      const runner = new WorkflowRunner({
        harness: {
          async runStep(input) {
            receivedSearch =
              input.searchEvidence?.searches.every(
                (search) => search.progress.recommendation.disposition === disposition,
              ) ?? false;
            return {
              summary: "closed fixture summary",
              outcome: harnessOutcome,
            };
          },
        },
        store: {
          async save(record) {
            records.push(structuredClone(record));
          },
        },
        repositoryScanner: {
          async scan() {
            return {
              ruleSet: "workflow-search-fixture",
              status: "passed",
              scannedFiles: 1,
              binaryFiles: 0,
              findings: [],
            };
          },
        },
        contextPreflight: {
          async preflight() {
            return { status: "unnecessary", reason: "target-not-applicable" };
          },
        },
        workflowSearch: {
          async search(input) {
            const targets = instantiateWorkflowSearchTargets(input.plan, {
              identitySha256: REPOSITORY_IDENTITY,
              revision: input.repository.revision,
            });
            return {
              repositoryIdentitySha256: REPOSITORY_IDENTITY,
              searches: targets.map((target) =>
                disposition === "not-found-after-bounded-search"
                  ? boundedAbsence(target)
                  : terminalSearch(target, disposition, outcome),
              ),
            };
          },
        },
        id: () => "workflow-search-run",
        now: monotonicClock(),
      });
      const record = await runner.run({
        workflow: "readiness",
        workspacePath: "/selected/workspace",
        repository: {
          sourcePath: "/selected/source",
          requestedRevision: REVISION,
          revision: REVISION,
        },
        allowWrite: false,
      });

      expect(receivedSearch).toBe(true);
      expect(record.status).toBe(expectedStatus);
      expect(record.steps[0]!.status).toBe(expectedStatus);
      expect(record.steps[0]!.searchEvidence?.searches).toHaveLength(2);
      expect(record.steps[0]!.searchFindings).toHaveLength(2);
      expect(record.searchFindings).toEqual(record.steps[0]!.searchFindings);
      expect(record.negativeEvidence).toHaveLength(
        disposition === "not-found-after-bounded-search" ? 2 : 0,
      );
      expect(record.gapLedger).toEqual(record.steps[0]!.gapLedger);
      expect(JSON.stringify(records)).not.toContain(plan.targets[0]!.question);
    },
  );

  it("fails closed with a sanitized error when the coordinator cannot produce evidence", async () => {
    const runner = new WorkflowRunner({
      harness: {
        async runStep() {
          throw new Error("harness must not run");
        },
      },
      store: { async save() {} },
      repositoryScanner: {
        async scan() {
          return {
            ruleSet: "workflow-search-fixture",
            status: "passed",
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [],
          };
        },
      },
      contextPreflight: {
        async preflight() {
          return { status: "unnecessary", reason: "target-not-applicable" };
        },
      },
      workflowSearch: {
        async search() {
          throw new Error("glpat-do-not-persist-this-provider-detail");
        },
      },
      id: () => "workflow-search-failure",
      now: monotonicClock(),
    });
    const record = await runner.run({
      workflow: "readiness",
      workspacePath: "/selected/workspace",
      repository: {
        sourcePath: "/selected/source",
        requestedRevision: REVISION,
        revision: REVISION,
      },
      allowWrite: false,
    });
    expect(record.status).toBe("failed");
    // The stop keeps a catalogued code and phase (#1927), never the coordinator's text.
    expect(record.steps[0]!.error).toBe(
      "Governed workflow search could not be completed (workflow-search-coordinator-failed): its coordinator phase raised Error with no code.",
    );
    expect(record.steps[0]!.failure).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "workflow-search-coordinator-failed",
    });
    expect(JSON.stringify(record)).not.toContain("do-not-persist");
  });

  it("uses a fresh frozen plan snapshot before and throughout every coordinator await", async () => {
    const receivedPlans: WorkflowSearchPlanV1[] = [];
    let runNumber = 0;
    const runner = new WorkflowRunner({
      harness: {
        async runStep(input) {
          return {
            summary: input.searchEvidence?.evidenceSha256 ?? "missing",
            outcome: "succeeded",
          };
        },
      },
      store: { async save() {} },
      repositoryScanner: {
        async scan() {
          return {
            ruleSet: "workflow-search-fixture",
            status: "passed",
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [],
          };
        },
      },
      contextPreflight: {
        async preflight() {
          return { status: "unnecessary", reason: "target-not-applicable" };
        },
      },
      workflowSearch: {
        async search(input) {
          receivedPlans.push(input.plan);
          expect(deeplyFrozen(input)).toBe(true);
          expect(input.step.search).toBe(input.plan);
          const mutations = () => {
            expect(() => {
              (input.plan.targets as unknown as Array<{ id: string }>).splice(0, 1);
            }).toThrow(TypeError);
            expect(() => {
              (input.plan.targets[0] as unknown as { id: string }).id = "substituted";
            }).toThrow(TypeError);
            expect(() => {
              (
                input.plan.targets[0]!.requiredProbes as unknown as Array<{ strategy: string }>
              )[0]!.strategy = "tracked-text-index";
            }).toThrow(TypeError);
            expect(() => {
              (input as unknown as { plan: WorkflowSearchPlanV1 }).plan = plan;
            }).toThrow(TypeError);
          };
          mutations();
          await Promise.resolve();
          mutations();
          const targets = instantiateWorkflowSearchTargets(input.plan, {
            identitySha256: REPOSITORY_IDENTITY,
            revision: input.repository.revision,
          });
          return {
            repositoryIdentitySha256: REPOSITORY_IDENTITY,
            searches: targets.map((target) => terminalSearch(target, "found", "match")),
          };
        },
      },
      id: () => `workflow-search-snapshot-${++runNumber}`,
      now: monotonicClock(),
    });
    const request = {
      workflow: "readiness" as const,
      workspacePath: "/selected/workspace",
      repository: {
        sourcePath: "/selected/source",
        requestedRevision: REVISION,
        revision: REVISION,
      },
      allowWrite: false,
    };
    const first = await runner.run(request);
    const second = await runner.run(request);
    expect(receivedPlans).toHaveLength(2);
    expect(receivedPlans[0]).not.toBe(receivedPlans[1]);
    expect(receivedPlans[0]).not.toBe(getWorkflow("readiness").steps[0]!.search);
    expect(first.steps[0]!.searchEvidence).toEqual(second.steps[0]!.searchEvidence);
    expect(first.steps[0]!.summary).toBe(second.steps[0]!.summary);
  });

  it("persists deterministic findings, bounded negative evidence, and a revision-bound ledger", () => {
    const evidence = readinessEvidenceAt(REVISION, (target) => boundedAbsence(target));
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const negative = negativeDocumentationEvidence(findings);
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
    });
    const repeated = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
      priorLedgers: [ledger, ledger],
    });

    expect(findings).toHaveLength(2);
    expect(negative).toHaveLength(2);
    expect(
      ledger.entries.every((entry) => entry.state === "open" && entry.observations.length === 1),
    ).toBe(true);
    expect(repeated.entries.every((entry) => entry.observations.length === 1)).toBe(true);
    expect(JSON.stringify({ findings, negative, ledger })).not.toContain("Does the");
    expect(JSON.stringify({ findings, negative, ledger })).not.toContain("/selected/");
    expect(JSON.stringify({ findings, negative, ledger })).not.toContain("docs/guide.md");

    const proposal = proposeDocumentationGapRoadmapUnit({
      ledger,
      stableGapId: ledger.entries[0]!.stableGapId,
      workflow: "readiness",
      stepId: "assess-readiness",
      repository: repositoryAt(REVISION),
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      searchEvidence: evidence,
    });
    expect(proposal.lifecycle).toBe("proposed");
    expect(proposal.trackerMutation).toBe("not-authorized");
    expect(formatDocumentationGapLedgerSummary(ledger)).toEqual(
      expect.arrayContaining([expect.stringContaining("open=2")]),
    );
    expect(renderDocumentationGapLedgerMarkdown(ledger)).not.toMatch(/(?:\/selected|docs\/guide)/u);
    expect(renderDocumentationGapLedgerScorecardMarkdown(ledger)).toBe(
      renderDocumentationGapLedgerMarkdown(ledger),
    );
  });

  it("retains changed coverage and revision history and advances found/fixed/verified reconciliation", () => {
    const absenceEvidence = workflowEvidenceAt(REVISION, boundedAbsence);
    const absenceFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: absenceEvidence,
    });
    const absenceLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: absenceFindings,
    });
    const changedCoverageEvidence = workflowEvidenceAt(
      REVISION,
      (target) => terminalSearch(target, "found", "match"),
      SNAPSHOT_AFTER_WRITE,
    );
    const changedCoverageFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: changedCoverageEvidence,
    });
    const changedCoverageLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: changedCoverageFindings,
      priorLedgers: [absenceLedger],
    });
    expect(
      changedCoverageLedger.entries.every(
        (entry) =>
          entry.state === "resolved" &&
          entry.observations.length === 2 &&
          entry.reconciliations.map((item) => item.status).join(",") === "found",
      ),
    ).toBe(true);

    const nextRevision = "c".repeat(40);
    const nextEvidence = workflowEvidenceAt(nextRevision, (target) =>
      terminalSearch(target, "found", "match"),
    );
    const nextFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: nextEvidence,
    });
    const nextLedger = createDocumentationGapLedger({
      currentRevision: nextRevision,
      findings: nextFindings,
      priorLedgers: [absenceLedger],
    });
    expect(
      nextLedger.entries.every(
        (entry) =>
          new Set(entry.observations.map((finding) => finding.evidenceIdentity.repositoryRevision))
            .size === 2,
      ),
    ).toBe(true);

    const stableGapId = changedCoverageLedger.entries[0]!.stableGapId;
    const fixed = attestDocumentationGapReconciliation({
      ledger: changedCoverageLedger,
      stableGapId,
      status: "fixed",
      repositoryRevision: REVISION,
      evidenceSha256: SHA("fixed-evidence"),
    });
    const verified = attestDocumentationGapReconciliation({
      ledger: fixed,
      stableGapId,
      status: "verified",
      repositoryRevision: REVISION,
      evidenceSha256: SHA("verified-evidence"),
    });
    expect(
      verified.entries
        .find((entry) => entry.stableGapId === stableGapId)!
        .reconciliations.map((item) => item.status),
    ).toEqual(["found", "fixed", "verified"]);
  });

  it("treats same-revision snapshot changes as history and same-snapshot hash mismatch as contradiction", () => {
    const absenceEvidence = workflowEvidenceAt(REVISION, boundedAbsence);
    const absenceFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: absenceEvidence,
    });
    const absenceLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: absenceFindings,
    });
    const foundEvidence = workflowEvidenceAt(
      REVISION,
      (target) => terminalSearch(target, "found", "match"),
      SNAPSHOT_AFTER_WRITE,
    );
    const foundFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: foundEvidence,
    });
    const history = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: foundFindings,
      priorLedgers: [absenceLedger],
    });
    expect(
      history.entries.every(
        (entry) =>
          entry.observations.length === 2 &&
          new Set(
            entry.observations.map((finding) => finding.evidenceIdentity.workspaceSnapshotSha256),
          ).size === 2,
      ),
    ).toBe(true);

    const colliding = workflowEvidenceAt(REVISION, (target) =>
      terminalSearch(target, "found", "match"),
    );
    const collidingFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: colliding,
    });
    expect(() =>
      createDocumentationGapLedger({
        currentRevision: REVISION,
        findings: collidingFindings,
        priorLedgers: [absenceLedger],
      }),
    ).toThrowError(/contradictory-evidence/u);
  });

  it("keeps the current step observation when reuse re-projects the same snapshot", () => {
    const evidence = workflowEvidenceAt(REVISION, boundedAbsence);
    const verifyFindings = projectDocumentationSearchFindings({
      workflow: "update-documentation",
      stepId: "verify-technical-accuracy",
      evidence,
    });
    const evaluateFindings = projectDocumentationSearchFindings({
      workflow: "update-documentation",
      stepId: "evaluate-document-quality",
      evidence,
    });
    expect(verifyFindings.map((finding) => finding.observationSha256)).not.toEqual(
      evaluateFindings.map((finding) => finding.observationSha256),
    );
    const verifyLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: verifyFindings,
    });
    const reused = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: evaluateFindings,
      priorLedgers: [verifyLedger],
    });
    expect(reused.entries.map((entry) => entry.currentObservationSha256).sort()).toEqual(
      evaluateFindings.map((finding) => finding.observationSha256).sort(),
    );
    expect(reused.entries.every((entry) => entry.observations.length === 1)).toBe(true);
  });

  it("rebuilds a run ledger from search findings even when sibling step fields look like credentials", () => {
    const evidence = workflowEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "update-documentation",
      stepId: "plan-documentation",
      evidence,
    });
    const steps = [
      {
        searchFindings: findings,
        summary: "PRIVATE_SUMMARY_SENTINEL api_key=abcdefghijklmnopqrstuvwx",
      },
      { summary: "later step without search" },
    ];
    const rebuilt = documentationGapLedgerFromStepFindings({
      currentRevision: REVISION,
      steps,
    });
    expect(rebuilt?.searchFindings).toEqual(findings);
  });

  it("rejects orphaned, contradictory, and source-unbound ledger projections", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({ currentRevision: REVISION, findings });

    const orphaned = structuredClone(ledger);
    orphaned.entries[0]!.currentObservationSha256 = "0".repeat(64);
    rehash(orphaned.entries[0]!, "entrySha256");
    rehash(orphaned, "ledgerSha256");
    expect(() => decodeDocumentationGapLedger(orphaned)).toThrowError(/invalid-ledger/u);

    const contradictory = structuredClone(ledger);
    contradictory.entries[0]!.state = "satisfied";
    rehash(contradictory.entries[0]!, "entrySha256");
    rehash(contradictory, "ledgerSha256");
    expect(() => decodeDocumentationGapLedger(contradictory)).toThrowError(
      /contradictory-evidence/u,
    );

    const unbound = structuredClone(findings);
    unbound[0]!.source.workflowSearchEvidenceSha256 = "0".repeat(64);
    rehash(unbound[0]!, "observationSha256");
    const unboundLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: unbound,
    });
    expect(() =>
      validateDocumentationGapRecordProjection({
        workflow: "readiness",
        stepId: "assess-readiness",
        currentRevision: REVISION,
        searchEvidence: evidence,
        searchFindings: unbound,
        negativeEvidence: negativeDocumentationEvidence(unbound),
        gapLedger: unboundLedger,
      }),
    ).toThrowError(/contradictory-evidence/u);
  });

  it("rejects hostile ledger wrappers without invoking traps or accessors", () => {
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
    expect(() => decodeDocumentationGapLedger(proxy)).toThrowError(/invalid-ledger/u);
    expect(trapHits).toBe(0);

    let getterHits = 0;
    const getterRoot = {};
    Object.defineProperty(getterRoot, "entries", {
      enumerable: true,
      get() {
        getterHits += 1;
        return [];
      },
    });
    expect(() => decodeDocumentationGapLedger(getterRoot)).toThrowError(/invalid-ledger/u);
    expect(getterHits).toBe(0);
  });

  it("authenticates the complete #71/#72 envelope before projecting a finding", () => {
    const evidence = workflowEvidenceAt(REVISION, boundedAbsence);
    const substitutedDigest = structuredClone(evidence);
    substitutedDigest.evidenceSha256 = "0".repeat(64);
    expect(() =>
      projectDocumentationSearchFindings({
        workflow: "readiness",
        stepId: "assess-readiness",
        evidence: substitutedDigest,
      }),
    ).toThrowError(/invalid-finding/u);

    const substitutedProgress = structuredClone(evidence);
    substitutedProgress.searches[0]!.progress =
      {} as (typeof substitutedProgress.searches)[0]["progress"];
    rehash(substitutedProgress, "evidenceSha256");
    expect(() =>
      projectDocumentationSearchFindings({
        workflow: "readiness",
        stepId: "assess-readiness",
        evidence: substitutedProgress,
      }),
    ).toThrowError(/invalid-(?:finding|evidence)/u);
  });

  it("deduplicates the same bounded finding across source envelopes", () => {
    const evidence = workflowEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const repeated = structuredClone(findings[0]!);
    repeated.source.stepId = "another-step";
    rehash(repeated, "observationSha256");
    const deduplicated = deduplicateDocumentationSearchFindings([findings[0]!, repeated]);
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: [findings[0]!, repeated],
    });
    expect(deduplicated).toHaveLength(1);
    expect(ledger.entries[0]!.observations).toHaveLength(1);
  });

  it("rejects revision-unbound ledgers and unbound roadmap source evidence", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({ currentRevision: REVISION, findings });
    const wrongRevision = structuredClone(ledger);
    wrongRevision.currentRevision = "c".repeat(40);
    rehash(wrongRevision, "ledgerSha256");
    expect(() => decodeDocumentationGapLedger(wrongRevision)).toThrowError(/invalid-ledger/u);

    const otherEvidence = readinessEvidenceAt("c".repeat(40), boundedAbsence);
    expect(() =>
      proposeDocumentationGapRoadmapUnit({
        ledger,
        stableGapId: ledger.entries[0]!.stableGapId,
        workflow: "readiness",
        stepId: "assess-readiness",
        repository: repositoryAt(REVISION),
        repositoryIdentitySha256: REPOSITORY_IDENTITY,
        searchEvidence: otherEvidence,
      }),
    ).toThrowError(/invalid-proposal/u);
  });

  it("rejects hostile discriminators and reconciliation bindings", () => {
    const absenceEvidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const absenceFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: absenceEvidence,
    });
    const absenceLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: absenceFindings,
    });
    const proposal = proposeDocumentationGapRoadmapUnit({
      ledger: absenceLedger,
      stableGapId: absenceLedger.entries[0]!.stableGapId,
      workflow: "readiness",
      stepId: "assess-readiness",
      repository: repositoryAt(REVISION),
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      searchEvidence: absenceEvidence,
    });
    const hostileProposal = structuredClone(proposal) as unknown as Record<string, unknown>;
    hostileProposal.kind = "attacker-controlled";
    rehash(hostileProposal, "proposalSha256");
    expect(() => decodeDocumentationGapRoadmapProposal(hostileProposal)).toThrowError(
      /invalid-proposal/u,
    );

    const foundEvidence = readinessEvidenceAt(
      REVISION,
      (target) => terminalSearch(target, "found", "match"),
      SNAPSHOT_AFTER_WRITE,
    );
    const foundFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: foundEvidence,
    });
    const resolved = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: foundFindings,
      priorLedgers: [absenceLedger],
    });
    const hostileLedger = structuredClone(resolved);
    const reconciliation = hostileLedger.entries[0]!.reconciliations[0]!;
    reconciliation.evidenceSha256 = "0".repeat(64);
    rehash(reconciliation, "reconciliationSha256");
    rehash(hostileLedger.entries[0]!, "entrySha256");
    rehash(hostileLedger, "ledgerSha256");
    expect(() => decodeDocumentationGapLedger(hostileLedger)).toThrowError(
      /invalid-reconciliation/u,
    );
  });

  it("requires exact source authority for every serialized roadmap proposal field", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({ currentRevision: REVISION, findings });
    const proposal = proposeDocumentationGapRoadmapUnit({
      ledger,
      stableGapId: ledger.entries[0]!.stableGapId,
      workflow: "readiness",
      stepId: "assess-readiness",
      repository: repositoryAt(REVISION),
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      searchEvidence: evidence,
    });
    const authority = {
      ledger,
      workflow: "readiness" as const,
      stepId: "assess-readiness",
      repository: repositoryAt(REVISION),
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      searchEvidence: evidence,
    };
    expect(validateDocumentationGapRoadmapProposal({ proposal, ...authority })).toEqual(proposal);

    const attacks: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.repositoryRevision = "c".repeat(40);
      },
      (value) => {
        value.sourceLedgerSha256 = "1".repeat(64);
      },
      (value) => {
        value.sourceObservationSha256 = "2".repeat(64);
      },
      (value) => {
        const requirement = value.requirement as Record<string, unknown>;
        requirement.id = "substituted-requirement";
        requirement.subjectSha256 = "3".repeat(64);
      },
    ];
    for (const attack of attacks) {
      const hostile = structuredClone(proposal) as unknown as Record<string, unknown>;
      attack(hostile);
      rehash(hostile, "proposalSha256");
      // Shape decoding is intentionally not source authority.
      expect(() => decodeDocumentationGapRoadmapProposal(hostile)).not.toThrow();
      expect(() =>
        validateDocumentationGapRoadmapProposal({
          proposal: hostile as unknown as typeof proposal,
          ...authority,
        }),
      ).toThrowError(/invalid-proposal/u);
    }

    const crossEnvelope = readinessEvidenceAt(REVISION, (target) =>
      terminalSearch(target, "found", "match"),
    );
    expect(() =>
      validateDocumentationGapRoadmapProposal({
        proposal,
        ...authority,
        searchEvidence: crossEnvelope,
      }),
    ).toThrowError(/invalid-proposal/u);
  });

  it("rejects fully rehashed ledgers whose current projection differs from authenticated evidence", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({ currentRevision: REVISION, findings });
    const stableGapId = ledger.entries[0]!.stableGapId;
    const attacks: Array<{
      name: string;
      mutate: (finding: Record<string, unknown>) => void;
      syncRequirement?: boolean;
    }> = [
      {
        name: "source workflow",
        mutate: (finding) => {
          (finding.source as Record<string, unknown>).workflow = "review-documentation";
        },
      },
      {
        name: "source step",
        mutate: (finding) => {
          (finding.source as Record<string, unknown>).stepId = "scan-documentation";
        },
      },
      {
        name: "plan id",
        mutate: (finding) => {
          (finding.source as Record<string, unknown>).planId = "projection-only-plan";
        },
      },
      {
        name: "plan version",
        mutate: (finding) => {
          (finding.source as Record<string, unknown>).planVersion = "9.9.9";
        },
      },
      {
        name: "source envelope digest",
        mutate: (finding) => {
          (finding.source as Record<string, unknown>).workflowSearchEvidenceSha256 = "0".repeat(64);
        },
      },
      {
        name: "requirement id and subject",
        syncRequirement: true,
        mutate: (finding) => {
          const requirement = finding.requirement as Record<string, unknown>;
          requirement.id = "projection-only-requirement";
          requirement.subjectSha256 = "1".repeat(64);
        },
      },
      {
        name: "target id and type",
        mutate: (finding) => {
          const target = finding.target as Record<string, unknown>;
          target.id = "projection-only-target";
          target.targetType =
            target.targetType === "artifact-existence" ? "rubric-coverage" : "artifact-existence";
        },
      },
    ];

    for (const attack of attacks) {
      const hostile = structuredClone(ledger) as unknown as Record<string, unknown>;
      const entry = (hostile.entries as Array<Record<string, unknown>>)[0]!;
      const observation = (entry.observations as Array<Record<string, unknown>>)[0]!;
      attack.mutate(observation);
      rehash(observation, "observationSha256");
      entry.currentObservationSha256 = observation.observationSha256;
      if (attack.syncRequirement) {
        entry.requirement = structuredClone(observation.requirement);
      }
      rehash(entry, "entrySha256");
      rehash(hostile, "ledgerSha256");

      const decoded = decodeDocumentationGapLedger(hostile);
      expect(
        () =>
          proposeDocumentationGapRoadmapUnit({
            ledger: decoded,
            stableGapId,
            workflow: "readiness",
            stepId: "assess-readiness",
            repository: repositoryAt(REVISION),
            repositoryIdentitySha256: REPOSITORY_IDENTITY,
            searchEvidence: evidence,
          }),
        attack.name,
      ).toThrowError(/invalid-proposal/u);
    }
  });

  it("rejects a fully rebuilt attacker plan, repository, ledger, and proposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-gap-authority-"));
    try {
      const workflow = getWorkflow("readiness");
      const step = workflow.steps[0]!;
      const hostilePlan = structuredClone(step.search!);
      hostilePlan.id = "attacker-selected-plan";
      hostilePlan.targets[0]!.id = "attacker-selected-target";
      hostilePlan.targets[0]!.targetKey = "attacker-selected-requirement";
      hostilePlan.targets[0]!.question = "Does the attacker-selected requirement exist?";
      const hostileRevision = "c".repeat(40);
      const hostileRepository = {
        sourcePath: "/attacker/selected/source",
        requestedRevision: hostileRevision,
        revision: hostileRevision,
      };
      const result = await new LocalWorkflowSearchCoordinator().search({
        runId: "attacker-full-rebuild",
        repositoryPath: root,
        repository: hostileRepository,
        workflow,
        step: { ...step, search: hostilePlan },
        plan: hostilePlan,
      });
      const searchEvidence = normalizeWorkflowSearchEvidence({
        plan: hostilePlan,
        repository: hostileRepository,
        repositoryIdentitySha256: result.repositoryIdentitySha256,
        searches: result.searches,
      });
      const findings = projectDocumentationSearchFindings({
        workflow: "readiness",
        stepId: "assess-readiness",
        evidence: searchEvidence,
      });
      const ledger = createDocumentationGapLedger({
        currentRevision: hostileRevision,
        findings,
      });
      const entry = ledger.entries.find(
        (candidate) => candidate.requirement.id === "attacker-selected-requirement",
      )!;
      const current = entry.observations.find(
        (candidate) => candidate.observationSha256 === entry.currentObservationSha256,
      )!;
      const body = {
        schemaVersion: 1 as const,
        kind: "docsfab-documentation-gap-roadmap-proposal" as const,
        proposalId: `gap-proposal:${canonicalDigest({
          stableGapId: entry.stableGapId,
        }).slice(0, 32)}`,
        stableGapId: entry.stableGapId,
        repositoryRevision: hostileRevision,
        requirement: { ...entry.requirement },
        sourceLedgerSha256: ledger.ledgerSha256,
        sourceObservationSha256: current.observationSha256,
        disposition: "not-found-after-bounded-search" as const,
        lifecycle: "proposed" as const,
        trackerMutation: "not-authorized" as const,
      };
      const proposal = decodeDocumentationGapRoadmapProposal({
        ...body,
        proposalSha256: canonicalDigest(body),
      });
      const trustedAuthority = {
        repository: repositoryAt(REVISION),
        repositoryIdentitySha256: REPOSITORY_IDENTITY,
      };
      const attackerRepositoryAuthority = {
        repository: hostileRepository,
        repositoryIdentitySha256: result.repositoryIdentitySha256,
      };

      expect(() =>
        proposeDocumentationGapRoadmapUnit({
          ledger,
          stableGapId: entry.stableGapId,
          workflow: "readiness",
          stepId: "assess-readiness",
          ...trustedAuthority,
          searchEvidence,
        }),
      ).toThrowError(/invalid-proposal/u);
      expect(() =>
        proposeDocumentationGapRoadmapUnit({
          ledger,
          stableGapId: entry.stableGapId,
          workflow: "readiness",
          stepId: "assess-readiness",
          ...attackerRepositoryAuthority,
          searchEvidence,
        }),
      ).toThrowError(/invalid-proposal/u);
      expect(() =>
        validateDocumentationGapRoadmapProposal({
          proposal,
          ledger,
          workflow: "readiness",
          stepId: "assess-readiness",
          ...trustedAuthority,
          searchEvidence,
        }),
      ).toThrowError(/invalid-proposal/u);
      expect(() =>
        validateDocumentationGapRoadmapProposal({
          proposal,
          ledger,
          workflow: "readiness",
          stepId: "assess-readiness",
          ...attackerRepositoryAuthority,
          searchEvidence,
        }),
      ).toThrowError(/invalid-proposal/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function workflowEvidenceAt(
  revision: string,
  create: (target: SearchTargetV1) => WorkflowSearchResultV1,
  workspaceSnapshotSha256?: string,
) {
  const targets = instantiateWorkflowSearchTargets(plan, {
    identitySha256: REPOSITORY_IDENTITY,
    revision,
  });
  return normalizeWorkflowSearchEvidence({
    plan,
    repository: {
      sourcePath: "/selected/source",
      requestedRevision: revision,
      revision,
    },
    repositoryIdentitySha256: REPOSITORY_IDENTITY,
    searches: targets.map(create),
    ...(workspaceSnapshotSha256 ? { workspaceSnapshotSha256 } : {}),
  });
}

function repositoryAt(revision: string) {
  return {
    sourcePath: "/selected/source",
    requestedRevision: revision,
    revision,
  };
}

function rehash(value: object, digestKey: PropertyKey): void {
  const body = structuredClone(value);
  Reflect.deleteProperty(body, digestKey);
  Reflect.set(value, digestKey, canonicalDigest(body));
}

function monotonicClock(): () => Date {
  let milliseconds = 0;
  return () => new Date(milliseconds++);
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => !("value" in descriptor) || deeplyFrozen(descriptor.value, seen),
  );
}

function terminalSearch(
  target: SearchTargetV1,
  disposition: SearchDisposition,
  outcome: SearchProbeOutcome,
  blockingCategory: "access-denied" | "tool-failure" = "access-denied",
): WorkflowSearchResultV1 {
  const probes = target.requiredProbes.map((declaration, index) =>
    probe(
      target,
      declaration.id,
      index === 0 ? outcome : outcome === "match" ? "no-match" : outcome,
    ),
  );
  const limitation =
    disposition === "search-blocked"
      ? limitationFor(target, probes, blockingCategory)
      : disposition === "stopped-hard-ceiling"
        ? limitationFor(target, probes, "hard-ceiling")
        : undefined;
  const limitations = limitation ? [limitation] : [];
  const events = probes.map((item, index) =>
    event(
      target,
      probes,
      limitations,
      disposition === "stopped-hard-ceiling"
        ? "no-new-evidence"
        : item.outcome === "blocked"
          ? disposition === "search-blocked"
            ? blockingCategory === "access-denied"
              ? "authorization-denied"
              : "tool-failure"
            : "tool-failure"
          : "evidence-produced",
      disposition === "stopped-hard-ceiling" ? undefined : item,
      disposition === "stopped-hard-ceiling" ? undefined : limitation,
      index + 1,
    ),
  );
  const execution = executionFor(target, [events], "workflow-completed");
  const observation = createSearchProgressObservation({
    target,
    probes,
    limitations,
    execution,
    events,
  });
  const progress = progressFor(target, probes, limitations, [observation], execution);
  return pair(target, probes, limitations, progress);
}

function productiveSearch(target: SearchTargetV1): WorkflowSearchResultV1 {
  const probes = [probe(target, target.requiredProbes[0]!.id, "no-match")];
  const events = [event(target, probes, [], "evidence-produced", probes[0], undefined, 1)];
  const execution = executionFor(target, [events]);
  const observation = createSearchProgressObservation({
    target,
    probes,
    limitations: [],
    execution,
    events,
  });
  return pair(target, probes, [], progressFor(target, probes, [], [observation], execution));
}

function limitationFor(
  target: SearchTargetV1,
  probes: SearchProbeV1[],
  category: "access-denied" | "hard-ceiling" | "tool-failure",
): SearchLimitationV1 {
  return createSearchLimitation(
    {
      id: `${category}-limitation`,
      category,
      impact: "blocking",
      probeIds: probes.filter((item) => item.outcome === "blocked").map((item) => item.id),
      detailSha256: SHA("f"),
    },
    target,
    probes,
  );
}

function withoutRawQuestionText(result: WorkflowSearchResultV1): WorkflowSearchResultV1 {
  expect(serializeBoundedSearchEvidence(result.bounded)).not.toContain("Does the");
  return result;
}

function boundedAbsence(target: SearchTargetV1): WorkflowSearchResultV1 {
  return withoutRawQuestionText(sharedBoundedAbsence(target));
}

function pair(...args: Parameters<typeof sharedPair>): WorkflowSearchResultV1 {
  return withoutRawQuestionText(sharedPair(...args));
}
