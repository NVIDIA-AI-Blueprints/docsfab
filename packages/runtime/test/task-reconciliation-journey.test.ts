// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { parseDoArguments } from "../src/cli/commands/do.js";
import { doHelp } from "../src/cli/usage.js";
import {
  projectDelegatedTaskFulfillment,
  type DelegatedTaskFulfillmentInputV1,
} from "../src/delegated-task/fulfillment.js";
import {
  delegatedTaskContractKit,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
} from "../src/delegated-task/result-contract.js";
import { WORKFLOW_CANCELLED } from "../src/execution/cancellation.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import {
  InvocationContractError,
  invocationHostCapabilitiesFixture,
  invocationResolveRequestFixture,
  invocationRuntimeBindingFixture,
  resolveInvocationContract,
} from "../src/execution/invocation-contracts.js";
import {
  ReaderTaskAdmissionObservationError,
  observeReaderTaskContextAdmissionV1,
} from "../src/execution/reader-task-admission.js";
import {
  READER_TASK_ADMISSION_FAILURE_KIND,
  projectReaderTaskAdmissionFailure,
  type ReaderTaskAdmissionFailureV1,
} from "../src/execution/reader-task-admission-failure.js";
import {
  createRootTaskBudget,
  projectTaskBudget,
  releaseChildReservation,
  remainingTaskBudget,
  reserveChildBudget,
  settlePhysicalEffect,
  type TaskBudgetEnvelope,
} from "../src/execution/task-budget.js";
import {
  admitTaskRecoveryAction,
  applyAdmittedInventoryRecount,
  assertTaskResultChangeAdmitted,
  projectEffectCertainty,
  projectTaskReconciliation,
  recountTaskInventoryThroughAdmittedTool,
  releasedSupplierPresence,
  TaskReconciliationError,
  type TaskInventoryClaimV1,
} from "../src/execution/task-reconciliation.js";
import { evaluateResumeSkip } from "../src/inputs/operator-input-fill.js";
import { classifyModelFailure } from "../src/model/context-budget.js";
import { createPhysicalProviderAttemptLedger } from "../src/model/provider-attempt.js";
import { RETRYABLE_PROVIDER_TURN_CATEGORIES } from "../src/model/provider-turn-retry.js";
import { runOfflineProductTest } from "../src/product-test.js";
import {
  classifyLatest,
  type KnowledgeContinuationAttemptV1,
} from "../src/records/knowledge-continuation-store.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import {
  loadVerifiedInvocationMetadata,
  selectSkillInvocationProfile,
} from "../src/skills/invocation-metadata.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");
const manifestPath = join(runtimeRoot, "test/fixtures/task-reconciliation/scenarios.json");
const skillCrateDirectory = join(runtimeRoot, "skill-crate");
const HASH = (value: string) => delegatedTaskContractKit.canonicalDigest(value);
const SNAPSHOT_A = "a".repeat(64);
const SNAPSHOT_B = "b".repeat(64);
const PLAN_DIGEST = "c".repeat(64);
const REVISION = "d".repeat(40);
const TASK_ID = "task:reconciliation-journey";
const MANUAL_SENTINEL = "MANUAL_SENTINEL_DO_NOT_MUTATE";
const SOURCE_SENTINEL = "SOURCE_SENTINEL_DO_NOT_MUTATE";
const CI_SENTINEL = "CI_SENTINEL_DO_NOT_MUTATE";
const SCENARIOS = [
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06",
  "S07",
  "S08",
  "S09",
  "S10",
  "S11",
  "S12",
  "S13",
  "S14",
] as const;
const TR_IDS = [
  "TR-01",
  "TR-02",
  "TR-03",
  "TR-04",
  "TR-05",
  "TR-06",
  "TR-07",
  "TR-08",
  "TR-09",
  "TR-10",
  "TR-11",
  "TR-12",
] as const;
const INCOMPLETE_STATUSES = new Set(["incomplete", "missing-grant", "deferred"]);

interface QualificationCell {
  readonly id: string;
  readonly scenario: string;
  readonly surface: string;
  readonly ownerIssue: number;
  readonly trIds: readonly string[];
  readonly status: "deterministic-supported" | "incomplete" | "missing-grant" | "deferred";
  readonly evidenceClass: "mechanics" | "model-judgment" | "not-executed";
  readonly requiresRealModel: boolean;
  readonly expectedObservations: readonly string[];
  readonly canonicalContracts: readonly string[];
  readonly missingInterface: string | null;
}

interface QualificationManifest {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-task-reconciliation-qualification-manifest";
  readonly issue: 940;
  readonly baseRevision: string;
  readonly composition: {
    readonly defaultActivation: boolean;
    readonly sloClaim: boolean;
    readonly legacyBareDo: string;
  };
  readonly eligibilityRules: Record<string, string>;
  readonly budgets: Record<string, string>;
  readonly trMapping: readonly {
    readonly id: string;
    readonly rows: readonly string[];
    readonly owner: string;
  }[];
  readonly laterUnsupportedClaims: readonly string[];
  readonly cells: readonly QualificationCell[];
}

const roots = temporaryRoots();

describe("task reconciliation qualification matrix", () => {
  it("freezes S01 through S14 with TR owners and does not mark incomplete cells as pass", async () => {
    const manifest = await loadManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.issue).toBe(940);
    expect(manifest.composition.defaultActivation).toBe(false);
    expect(manifest.composition.sloClaim).toBe(false);
    expect(manifest.composition.legacyBareDo).toBe("unchanged-catalog-routing");
    expect(Object.keys(manifest.eligibilityRules).sort()).toEqual(
      ["deferred", "deterministic-supported", "incomplete", "missing-grant"].sort(),
    );
    expect(manifest.budgets.realModel).toMatch(/No authorized model grant/u);
    expect(manifest.laterUnsupportedClaims.length).toBeGreaterThan(0);

    const mappedRows = new Set(manifest.trMapping.flatMap((entry) => entry.rows));
    expect([...mappedRows].sort()).toEqual([...SCENARIOS]);
    expect(manifest.trMapping.map((entry) => entry.id)).toEqual([...TR_IDS]);
    for (const entry of manifest.trMapping) {
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.rows.length).toBeGreaterThan(0);
    }

    const scenarioCells = new Set(manifest.cells.map((cell) => cell.scenario));
    expect([...scenarioCells].sort()).toEqual([...SCENARIOS]);
    const cellIds = manifest.cells.map((cell) => cell.id);
    expect(new Set(cellIds).size).toBe(cellIds.length);

    for (const cell of manifest.cells) {
      expect(cell.expectedObservations.length).toBeGreaterThan(0);
      expect(cell.ownerIssue).toBeGreaterThan(0);
      for (const trId of cell.trIds) expect(TR_IDS).toContain(trId);
      if (cell.status === "deterministic-supported") {
        expect(cell.missingInterface).toBeNull();
        expect(cell.requiresRealModel).toBe(false);
        expect(cell.evidenceClass).toBe("mechanics");
        expect(cell.canonicalContracts.length).toBeGreaterThan(0);
        for (const contract of cell.canonicalContracts) {
          expect(existsSync(join(repoRoot, contract)), contract).toBe(true);
        }
      } else {
        expect(INCOMPLETE_STATUSES.has(cell.status)).toBe(true);
        expect(cell.missingInterface, cell.id).toBeTruthy();
        expect(cell.evidenceClass).not.toBe("mechanics");
      }
      if (cell.requiresRealModel) {
        expect(cell.status).toBe("missing-grant");
        expect(cell.evidenceClass).toBe("model-judgment");
      }
    }
  });

  it("records missing supplier APIs as incomplete rather than inventing a parallel runner", async () => {
    const manifest = await loadManifest();
    const incomplete = manifest.cells.filter((cell) => cell.status === "incomplete");
    expect(incomplete.length).toBeGreaterThan(0);
    expect(
      incomplete.some((cell) => cell.missingInterface?.includes("reader-task-admission-repair.ts")),
    ).toBe(true);
    expect(
      incomplete.some((cell) => cell.missingInterface?.includes("task-reconciliation.ts")),
      "an incomplete cell still names task-reconciliation.ts as a missing interface after the composed journey evidence landed",
    ).toBe(false);
    expect(
      incomplete.some((cell) => cell.missingInterface?.includes("delegated-do S01 repair-policy")),
    ).toBe(true);

    const qualifiedByJourney = [
      "S02-task-projection-coverage-correction",
      "S05-task-level-stale-snapshot-invalidation",
      "S06-root-budget-not-reset-by-child",
      "S07-revoked-access-mid-dispatch",
    ];
    for (const id of qualifiedByJourney) {
      const cell = manifest.cells.find((candidate) => candidate.id === id);
      expect(cell, id).toBeDefined();
      expect(cell?.status, id).toBe("deterministic-supported");
      expect(cell?.missingInterface, id).toBeNull();
      expect(cell?.requiresRealModel, id).toBe(false);
    }
    for (const id of [
      "S01-live-agent-changed-handoff-repair",
      "S01-configured-model-bad-evidence-repair",
      "S06-unchanged-invalid-input-repair-cap",
      "S12-delegated-resume-cli",
    ]) {
      const cell = manifest.cells.find((candidate) => candidate.id === id);
      expect(cell?.status, id).not.toBe("deterministic-supported");
      expect(cell?.missingInterface, id).toBeTruthy();
    }

    expect(existsSync(join(runtimeRoot, "src/execution/reader-task-admission-repair.ts"))).toBe(
      false,
    );
    expect(existsSync(join(runtimeRoot, "scripts/pre-run-recovery-proof.mjs"))).toBe(false);
    expect(existsSync(join(runtimeRoot, "src/execution/task-reconciliation.ts"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "src/execution/task-budget.ts"))).toBe(true);
    expect(() => parseDoArguments(["Which flag prints JSON?", "--delegate"])).not.toThrow(
      /Unknown do option "--delegate"/u,
    );
    expect(doHelp()).toMatch(/--delegate/u);
    expect(doHelp()).toContain("--continue <run-id>");
  });
});

describe("S01 bad-evidence nomination diagnostic", () => {
  it("rejects one missing nomination among 16 readable sources, reads the replacement, and writes nothing", async () => {
    const repository = await gitRepository();
    await mkdir(join(repository, "src"), { recursive: true });
    const hints = [];
    for (let index = 0; index < 16; index += 1) {
      const path = `src/module-${String(index).padStart(2, "0")}.ts`;
      await writeFile(
        join(repository, path),
        `export const n = ${index};\n// ${SOURCE_SENTINEL}\n`,
      );
      hints.push({ role: "public-contract" as const, path });
    }
    const replacement = "src/replacement.ts";
    await writeFile(
      join(repository, replacement),
      `export const replacement = true;\n// ${SOURCE_SENTINEL}\n`,
    );
    await writeFile(join(repository, "docs/manual.md"), `# Manual\n${MANUAL_SENTINEL}\n`);
    await writeFile(
      join(repository, ".gitlab-ci.yml"),
      `# ${CI_SENTINEL}\njob:\n  script: echo ci\n`,
    );
    const revision = await commitFixture(repository, "sixteen plus replacement");
    const missing = "src/module-missing.ts";
    const nominated = [...hints, { role: "public-contract" as const, path: missing }];
    const before = await git(repository, ["status", "--porcelain=v1"]);

    const error = await observeRejected({
      repositoryPath: repository,
      observationMode: "workflow-export",
      sourceHints: nominated,
    });
    const failure = requireFailure(error);
    expect(error.code).toBe("evidence-unavailable");
    expect(failure).toMatchObject({
      kind: READER_TASK_ADMISSION_FAILURE_KIND,
      phase: "reader-task-admission",
      reason: "not-admitted-at-selected-revision",
      correctiveAction: "replace-rejected-nomination",
      selectedRevision: revision,
      nomination: {
        binding: "explicit-source-hint",
        index: 16,
        identity: { kind: "repository-relative-path", path: missing },
      },
      effect: {
        workflowStarted: false,
        readerHandoffCreated: false,
      },
    });
    expect(JSON.stringify(failure)).not.toMatch(/nonexistent|does not exist|not found/iu);
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe(before);
    expect(await readFile(join(repository, "docs/manual.md"), "utf8")).toContain(MANUAL_SENTINEL);
    expect(await readFile(join(repository, ".gitlab-ci.yml"), "utf8")).toContain(CI_SENTINEL);

    const replacementBytes = await readFile(join(repository, replacement), "utf8");
    expect(replacementBytes).toContain(SOURCE_SENTINEL);
    const corrected = await observeReaderTaskContextAdmissionV1({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: readerInput(),
      sourceHints: [...hints, { role: "public-contract", path: replacement }],
    });
    expect(corrected.admission.sources.some((source) => source.uri === missing)).toBe(false);
    expect(corrected.admission.sources.some((source) => source.uri === replacement)).toBe(true);
    expect(
      corrected.admission.sources.filter((source) => source.role === "public-contract"),
    ).toHaveLength(17);
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe(before);
  });
});

describe("S02 and S03 inventory recount without asking", () => {
  it("recounts 17 tracked documentation pages and does not keep a stale 14-page claim", async () => {
    const repository = await gitRepository();
    await mkdir(join(repository, "docs", "pages"), { recursive: true });
    for (let index = 1; index <= 17; index += 1) {
      const path = `docs/pages/page-${String(index).padStart(2, "0")}.md`;
      await writeFile(join(repository, path), `# Page ${index}\n\n${SOURCE_SENTINEL}\n`);
    }
    await commitFixture(repository, "seventeen pages");
    const staleClaim = { pages: 14, source: "model-prose" };
    const inventory = await withRepositoryWorkspace(repository, "HEAD", async (workspace) =>
      buildRepositoryDiscoveryInventory({ workspace }),
    );
    const pagePaths = inventory.documents
      .map((document) => document.path)
      .filter((path) => path.startsWith("docs/pages/"));
    expect(pagePaths).toHaveLength(17);
    expect(staleClaim.pages).toBe(14);
    expect(pagePaths.length).not.toBe(staleClaim.pages);
    expect(inventory.documents.some((document) => document.path === "docs/cli.md")).toBe(true);
    expect(JSON.stringify(inventory)).not.toMatch(/InputAsk|needs-input/u);
    expect(await readFile(join(repository, "docs/pages/page-01.md"), "utf8")).toContain(
      SOURCE_SENTINEL,
    );
  });

  // Two synthetic repositories, 17 pages and two recounts run near the local
  // default (test.localTimeoutMs); testTimeoutMs keeps the CI floor
  // (test.ciTimeoutMs) unchanged.
  it("corrects task-level coverage when the repository moves under a once-accurate prose claim", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const repository = await gitRepository();
    const originalPaths = await writePages(repository, 1, 14);
    await commitFixture(repository, "fourteen pages");

    const firstRecount = await recountTaskInventoryThroughAdmittedTool({
      repositoryPath: repository,
    });
    const firstPages = pagePathsOf(firstRecount.pagePaths);
    expect(firstPages).toEqual([...originalPaths].sort());

    const proseClaim: TaskInventoryClaimV1 = {
      source: "model-prose",
      pageCount: 14,
      pagePaths: [...originalPaths],
    };
    const beforeMove = projectTaskReconciliation({
      originalRequest: { outcome: "Count the documentation pages." },
      staleInventoryClaim: proseClaim,
      admittedInventory: { ...firstRecount, pagePaths: firstPages },
      workspaceIdentity: {
        revision: firstRecount.repositoryRevision,
        observationMode: "workflow-export",
      },
    });
    expect(
      beforeMove.inventory.admitted,
      "a recount taken at the projected revision was not admitted",
    ).toBeDefined();
    expect(
      [...beforeMove.inventory.invalidatedModelProseCounts],
      "a prose claim that matches the admitted recount was invalidated anyway",
    ).toEqual([]);
    expect(beforeMove.inventory.pageCount).toBe(14);

    const addedPaths = await writePages(repository, 15, 17);
    await commitFixture(repository, "three more pages");
    const secondRecount = await recountTaskInventoryThroughAdmittedTool({
      repositoryPath: repository,
    });
    const secondPages = pagePathsOf(secondRecount.pagePaths);
    expect(secondPages).toHaveLength(17);
    expect(secondRecount.repositoryRevision).not.toBe(firstRecount.repositoryRevision);
    expect(secondRecount.inventorySha256).not.toBe(firstRecount.inventorySha256);

    const afterMove = projectTaskReconciliation({
      originalRequest: { outcome: "Count the documentation pages." },
      staleInventoryClaim: proseClaim,
      admittedInventory: { ...secondRecount, pagePaths: secondPages },
      workspaceIdentity: {
        revision: secondRecount.repositoryRevision,
        observationMode: "workflow-export",
      },
    });
    expect(
      [...afterMove.inventory.invalidatedModelProseCounts],
      "the projected inventory.invalidatedModelProseCounts does not equal [14] for a mismatched stale count",
    ).toEqual([14]);
    expect(afterMove.inventory.pageCount).toBe(17);
    expect([...afterMove.inventory.retainedPagePaths].sort()).toEqual([...addedPaths].sort());

    const misapplied = applyAdmittedInventoryRecount(beforeMove, {
      ...secondRecount,
      pagePaths: secondPages,
    });
    expect(
      misapplied.inventory.admitted,
      "a recount from a newer revision was admitted onto a projection pinned at the older revision",
    ).toBeUndefined();
    expect([...misapplied.inventory.invalidatedModelProseCounts]).toEqual([]);

    expect(await readFile(join(repository, "docs/pages/page-01.md"), "utf8")).toContain(
      SOURCE_SENTINEL,
    );
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    expect(JSON.stringify(afterMove)).not.toMatch(/InputAsk|needs-input/u);
  });
});

describe("S04 incidental versus required invocation fields", () => {
  it("repairs incidental reader fields on guidance load and preserves required reader-assessment context", async () => {
    const writer = await verifyCatalogSkill({
      skillCrateDirectory,
      skillId: "write-documentation",
      grantedTools: ["read", "grep", "find", "ls", "edit", "write"],
    });
    const planner = await verifyCatalogSkill({
      skillCrateDirectory,
      skillId: "plan-documentation",
      grantedTools: ["read", "grep", "find", "ls"],
    });
    const guidance = selectSkillInvocationProfile(await loadVerifiedInvocationMetadata(writer), {
      operation: "load-guidance",
    });
    try {
      resolveInvocationContract(
        invocationResolveRequestFixture(guidance, { callerFields: ["readerContext"] }),
      );
      expect.unreachable("incidental reader fields must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(InvocationContractError);
      expect((error as InvocationContractError).code).toBe("unsupported-context");
      expect((error as InvocationContractError).recovery).toBe("retry-load-without-reader-fields");
      expect((error as InvocationContractError).fields).toEqual(["readerContext"]);
    }

    const assessment = selectSkillInvocationProfile(await loadVerifiedInvocationMetadata(planner), {
      operation: "load-reader-assessment-guidance",
      profileId: "direct-reader-assessment",
    });
    try {
      resolveInvocationContract(
        invocationResolveRequestFixture(assessment, {
          callerFields: [],
          binding: invocationRuntimeBindingFixture({
            profileId: "direct-reader-assessment",
            restrictions: { requireReadOnly: true, requireObservationSupplier: true },
          }),
          capabilities: invocationHostCapabilitiesFixture(),
        }),
      );
      expect.unreachable("required reader context must not be stripped");
    } catch (error) {
      expect(error).toBeInstanceOf(InvocationContractError);
      expect((error as InvocationContractError).code).toBe("required-context");
      expect((error as InvocationContractError).recovery).toBe("supply-required-reader-context");
      expect((error as InvocationContractError).fields).toEqual(["readerContext"]);
    }
  });
});

describe("S05 dirty checkout versus committed export", () => {
  it("keeps dirty-only bytes distinct from committed workflow-export admission", async () => {
    const repository = await gitRepository();
    const dirty = "src/uncommitted.ts";
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, dirty), `export const dirty = true;\n// ${SOURCE_SENTINEL}\n`);
    await access(join(repository, dirty));

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        sourceHints: [{ role: "public-contract", path: dirty }],
      }),
    );
    expect(failure.reason).toBe("not-admitted-at-selected-revision");
    expect(JSON.stringify(failure)).not.toMatch(/nonexistent|does not exist/iu);
    expect(await readFile(join(repository, dirty), "utf8")).toContain(SOURCE_SENTINEL);
  });

  it("refuses selected-checkout on a dirty tree without committing or overwriting user work", async () => {
    const repository = await gitRepository();
    const dirty = "docs/user-edit.md";
    await writeFile(join(repository, dirty), `# User edit\n${MANUAL_SENTINEL}\n`);
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "selected-checkout",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "current-documentation", path: "docs/cli.md" }],
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(await readFile(join(repository, dirty), "utf8")).toContain(MANUAL_SENTINEL);
    expect(await git(repository, ["status", "--porcelain=v1"])).toMatch(/docs\/user-edit\.md/u);
  });

  it("drops a task snapshot admitted at a superseded revision and keeps the dirty tree blocked", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const repository = await gitRepository();
    await writePages(repository, 1, 5);
    await commitFixture(repository, "five pages");
    const snapshot = await recountTaskInventoryThroughAdmittedTool({
      repositoryPath: repository,
    });

    const matched = projectTaskReconciliation({
      originalRequest: { outcome: "Resume the documentation task." },
      admittedInventory: snapshot,
      workspaceIdentity: {
        revision: snapshot.repositoryRevision,
        observationMode: "workflow-export",
      },
    });
    expect(
      matched.inventory.admitted,
      "a snapshot whose revision matches the workspace identity was dropped",
    ).toBeDefined();
    expect([...matched.appliedEvidenceIds]).toEqual([snapshot.inventorySha256]);

    const [addedPath] = await writePages(repository, 6, 6);
    await commitFixture(repository, "sixth page");
    const current = await recountTaskInventoryThroughAdmittedTool({ repositoryPath: repository });
    expect(current.repositoryRevision).not.toBe(snapshot.repositoryRevision);

    await writeFile(
      join(repository, "docs/cli.md"),
      `# CLI\n${SOURCE_SENTINEL}\n${MANUAL_SENTINEL}\n`,
    );

    const stale = projectTaskReconciliation({
      originalRequest: { outcome: "Resume the documentation task." },
      admittedInventory: snapshot,
      workspaceIdentity: {
        revision: current.repositoryRevision,
        observationMode: "selected-checkout",
      },
      dirtyOnlyPaths: ["docs/cli.md"],
      claimedCommittedPaths: ["docs/cli.md", addedPath],
    });
    expect(
      stale.inventory.admitted,
      "admitted inventory from a mismatched revision was not dropped",
    ).toBeUndefined();
    expect(stale.inventory.pageCount).toBeUndefined();
    expect([...stale.appliedEvidenceIds]).toEqual([]);
    expect(stale.selectedCheckoutBlocked).toBe(true);
    expect(stale.completion).toBe("blocked");
    expect([...stale.committedEvidencePaths]).toEqual([addedPath]);

    expect(await readFile(join(repository, "docs/cli.md"), "utf8")).toContain(MANUAL_SENTINEL);
    expect(await git(repository, ["status", "--porcelain=v1"])).toMatch(/docs\/cli\.md/u);
  });
});

describe("S06 retry owner versus deterministic invalid input", () => {
  it("retries throttling on read-only steps, not write steps or invalid requests", async () => {
    expect(classifyModelFailure({ status: 429 })).toEqual({
      category: "throttled",
      retryable: true,
    });
    expect(classifyModelFailure({ status: 400, message: "invalid request" })).toEqual({
      category: "invalid-request",
      retryable: false,
    });
    expect(RETRYABLE_PROVIDER_TURN_CATEGORIES).toEqual([
      "provider-transient",
      "throttled",
      "timeout",
    ]);
    expect(RETRYABLE_PROVIDER_TURN_CATEGORIES).not.toContain("invalid-request");

    let readAttempts = 0;
    const read = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["throttled"],
      },
      sleep: async () => undefined,
      execute: async () => {
        readAttempts += 1;
        if (readAttempts === 1) {
          throw new InferenceStepError("throttled", "throttled", true);
        }
        return { summary: "recovered" };
      },
    });
    expect(read.status).toBe("succeeded");
    expect(readAttempts).toBe(2);
    expect(read.evidence.attempts).toHaveLength(2);

    let writeAttempts = 0;
    const write = await executeInferenceStep({
      mode: "write",
      policy: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["throttled"],
      },
      execute: async () => {
        writeAttempts += 1;
        throw new InferenceStepError("throttled", "throttled", true);
      },
    });
    expect(write.status).toBe("failed");
    expect(writeAttempts).toBe(1);
    expect(write.evidence.effectiveMaxRetries).toBe(0);
  });

  it("carries settled grandchild work root-ward across two releases without resetting the root", () => {
    // Unlike test/nested-execution-budget.test.ts (one child, charges settled
    // by hand), this tree is two levels deep and the physical provider-attempt
    // ledger issues the charges, so the root total must survive a release chain.
    const root = createRootTaskBudget({ envelope: journeyEnvelope() });
    const rootTurns = journeyEnvelope()["provider-turns"];
    const childTurns = childReservation()["provider-turns"];
    const grandchildTurns = grandchildReservation()["provider-turns"];
    expect(remainingTaskBudget(root)["provider-turns"]).toBe(rootTurns);

    const child = reserveChildBudget(root, childReservation());
    const grandchild = reserveChildBudget(child, grandchildReservation());
    expect(
      remainingTaskBudget(root)["provider-turns"],
      "a child reservation resets or exceeds the parent's remaining budget",
    ).toBe(rootTurns - childTurns);
    expect(
      remainingTaskBudget(child)["provider-turns"],
      "a grandchild reservation was drawn from the root instead of its own parent",
    ).toBe(childTurns - grandchildTurns);
    expect(remainingTaskBudget(grandchild)["provider-turns"]).toBe(grandchildTurns);

    // Shipped call site: the step ledger settles one provider-turn per
    // physical request against whichever owner it was handed.
    const grandchildScope = "journey-s06-grandchild";
    const ledger = createPhysicalProviderAttemptLedger({
      budget: grandchild,
      effectScope: grandchildScope,
    });
    ledger.record();
    expect(
      ledger.refusal(),
      "the shipped ledger was refused inside a reservation that still had room",
    ).toBeUndefined();
    const grandchildSettled = ledger.spent();
    expect(remainingTaskBudget(grandchild)["provider-turns"]).toBe(
      grandchildTurns - grandchildSettled,
    );
    expect(
      remainingTaskBudget(root)["provider-turns"],
      "grandchild settlement moved root remaining before any release",
    ).toBe(rootTurns - childTurns);

    // The replay guard spans the whole tree: the root cannot settle an effect
    // its grandchild already settled two levels down.
    expect(
      () =>
        settlePhysicalEffect(root, {
          effectId: `${grandchildScope}:${grandchildSettled}`,
          charges: replayCharge(),
        }),
      "a physical effect settled by a grandchild settled a second time on the root",
    ).toThrowError(expect.objectContaining({ code: "effect-already-settled" }));

    // Releasing the middle child now would hand the root back capacity the
    // grandchild is still allowed to spend.
    expect(
      () => releaseChildReservation(child),
      "a reservation was released while a grandchild reservation was still outstanding",
    ).toThrowError(expect.objectContaining({ code: "reservation-release-unproven" }));

    releaseChildReservation(grandchild);
    expect(
      remainingTaskBudget(child)["provider-turns"],
      "a released grandchild did not return its unspent reservation to its own parent",
    ).toBe(childTurns - grandchildSettled);
    expect(
      remainingTaskBudget(root)["provider-turns"],
      "a grandchild release reached the root before its own parent released",
    ).toBe(rootTurns - childTurns);

    releaseChildReservation(child);
    const afterRelease = remainingTaskBudget(root)["provider-turns"];
    expect(
      afterRelease,
      "a child reservation resets or exceeds the parent's remaining budget",
    ).toBe(rootTurns - grandchildSettled);
    expect(afterRelease).toBeLessThan(rootTurns);
    expect(projectTaskBudget(root).reservedOutstanding["provider-turns"]).toBe(0);
    expect(projectTaskBudget(root).settled["provider-turns"]).toBe(grandchildSettled);

    // A later sibling adds to the root's settled total; it does not replace it.
    const sibling = reserveChildBudget(root, childReservation());
    expect(remainingTaskBudget(root)["provider-turns"]).toBe(afterRelease - childTurns);
    expect(remainingTaskBudget(sibling)["provider-turns"]).toBe(childTurns);
    const siblingLedger = createPhysicalProviderAttemptLedger({
      budget: sibling,
      effectScope: "journey-s06-sibling",
    });
    siblingLedger.record();
    expect(siblingLedger.refusal()).toBeUndefined();
    releaseChildReservation(sibling);
    const settledTotal = grandchildSettled + siblingLedger.spent();
    expect(
      remainingTaskBudget(root)["provider-turns"],
      "a later child's settled work replaced the root's running total instead of adding to it",
    ).toBe(rootTurns - settledTotal);
    expect(projectTaskBudget(root).settled["provider-turns"]).toBe(settledTotal);

    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Publish the sixth page." },
      workspaceIdentity: {
        revision: REVISION,
        observationMode: "workflow-export",
      },
    });
    expect(releasedSupplierPresence().taskBudget).toBe(true);
    expect(projection.budget).toEqual({
      availability: "unknown",
      reason: "task-budget-api-unconsumed",
    });
  });
});

describe("S07 denied and unsafe source identities", () => {
  it("withholds excluded secret paths and rejects configured-credential identities", async () => {
    const repository = await gitRepository();
    await writeFile(join(repository, ".env"), "TOKEN=tracked-secret\n");
    await git(repository, ["add", "--force", ".env"]);
    await git(repository, ["commit", "--quiet", "-m", "excluded"]);
    const error = await observeRejected({
      repositoryPath: repository,
      observationMode: "workflow-export",
      sourceHints: [{ role: "public-contract", path: ".env" }],
    });
    const failure = requireFailure(error);
    expect(failure.reason).toBe("excluded-or-denied-source");
    expect(failure.correctiveAction).toBe("omit-denied-source");
    expect(failure.nomination.identity).toEqual({
      kind: "opaque-reference",
      reference: "explicit-source-hint:0",
    });
    const serialized = JSON.stringify({ message: error.message, failure });
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("TOKEN=tracked-secret");

    const tokenPath = `src/${configureCredential(`glpat-${"a".repeat(20)}`)}.ts`;
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "public-contract", path: tokenPath }],
      }),
    ).rejects.toMatchObject({ code: "credential-material" });
  });

  it("refuses dispatch and inspection after access is revoked mid-task and writes nothing", async () => {
    const repository = await gitRepository();
    const observed = await recountTaskInventoryThroughAdmittedTool({
      repositoryPath: repository,
    });
    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Dispatch the child workflow." },
      admittedInventory: observed,
      workspaceIdentity: {
        revision: observed.repositoryRevision,
        observationMode: "workflow-export",
      },
    });
    expect(projection.inventory.admitted).toBeDefined();

    expect(
      admitTaskRecoveryAction({}, { kind: "dispatch-child-workflow" }).admitted,
      "an unrevoked-access dispatch was refused",
    ).toBe(true);
    expect(projectEffectCertainty({})).toBe("did-not-start");

    const revoked = { accessRevoked: true } as const;
    expect(
      projectEffectCertainty(revoked),
      "a revoked-access observation was not classified as access-denied",
    ).toBe("access-denied");

    for (const kind of ["dispatch-child-workflow", "continue-incompatible"] as const) {
      const admission = admitTaskRecoveryAction(revoked, { kind });
      expect(admission.admitted, `a revoked-access dispatch was not refused (${kind})`).toBe(false);
      expect(admission.code, `a revoked-access dispatch was not refused (${kind})`).toBe(
        "refused-incompatible-dispatch",
      );
      expect(admission.nextSupportedAction).toBe("stop");
    }
    expect(admitTaskRecoveryAction(revoked, { kind: "inspect-inventory" }).code).toBe(
      "refused-incompatible-dispatch",
    );
    expect(() =>
      assertTaskResultChangeAdmitted(revoked, { kind: "dispatch-child-workflow" }),
    ).toThrowError(TaskReconciliationError);

    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    expect(JSON.stringify(projection)).not.toMatch(/InputAsk|needs-input/u);
  });
});

describe("S08 child evidence versus required checks", () => {
  it("withholds complete when a succeeded child never ran the required check", () => {
    const result = projectDelegatedTaskFulfillment(
      fulfillmentInput({
        artifacts: [artifactEvidence()],
        checks: [checkEvidence({ state: "not-run" })],
        children: [
          childEvidence({
            status: "succeeded",
            formalQuality: "not-established",
            attemptedRequirementIds: ["R1"],
          }),
        ],
      }),
      { modelProseClaim: "done", semanticAssessment: "pass" },
    );
    expect(result.fulfillment).toBe("partial");
    expect(result.fulfillment).not.toBe("complete");
    expect(result.checkState).toBe("not-run");
    expect(result.unmetRequirementIds).toEqual(["R2"]);
    expect(result.children[0]?.status).toBe("succeeded");
    expect(JSON.stringify(result)).not.toContain("done");
  });

  it("keeps a failed child failed beside later direct recovery without inventing workflow success", () => {
    const result = projectDelegatedTaskFulfillment(
      fulfillmentInput({
        deliveryState: "ineligible",
        artifacts: [artifactEvidence()],
        checks: [checkEvidence({ state: "not-run" })],
        children: [
          childEvidence({
            status: "failed",
            failureCode: "workflow-failed",
            formalQuality: "failed",
            attemptedRequirementIds: ["R1"],
          }),
        ],
      }),
    );
    expect(result.fulfillment).toBe("partial");
    expect(result.children[0]).toMatchObject({
      status: "failed",
      failureCode: "workflow-failed",
      formalQuality: "failed",
    });
    expect(result.deliveryState).toBe("ineligible");
    expect(result.fulfillment).not.toBe("complete");
  });
});

describe("S09 effect certainty before replay", () => {
  it("classifies pre-dispatch failure, uncertain writes, and completed writes without replay", () => {
    const owner = { pid: 4242, processBirthIdentity: "e".repeat(64) };
    expect(
      classifyLatest(continuationAttempt({ phase: "failed-before-execution", owner }), {
        inspect: () => ({ alive: false }),
      }),
    ).toBe("retry");
    expect(
      classifyLatest(continuationAttempt({ phase: "executing", owner }), {
        inspect: () => ({ alive: false }),
      }),
    ).toBe("recovery-required");
    expect(
      classifyLatest(continuationAttempt({ phase: "writer-completed", owner }), {
        inspect: () => ({ alive: false }),
      }),
    ).toBe("already-completed");
  });
});

describe("S10 publisher lost-response idempotency", () => {
  it("reuses the existing publication receipt instead of creating a second mutation", () => {
    const result = runOfflineProductTest();
    expect(result.retry).toEqual({
      status: "idempotent",
      sameReceipt: true,
      externalMutationCount: 1,
    });
    expect(result.publication.externalMutationCount).toBe(1);
    expect(result.isolation.credentials).toBe("not-used");
    expect(result.isolation.network).toBe("not-used");
  });
});

describe("S11 cancellation retains actual effects", () => {
  it("starts no further inference attempt after cancellation during backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    await expect(
      executeInferenceStep({
        mode: "read-only",
        signal: controller.signal,
        policy: {
          maxRetries: 2,
          baseDelayMs: 5,
          maxDelayMs: 5,
          retryableCategories: ["throttled"],
        },
        sleep: async () => {
          controller.abort();
        },
        execute: async () => {
          attempts += 1;
          throw new InferenceStepError("throttled", "throttled", true);
        },
      }),
    ).rejects.toThrow(WORKFLOW_CANCELLED);
    expect(attempts).toBe(1);
  });

  it("waits for an in-flight write and retains the actual bytes after cancel", async () => {
    const controller = new AbortController();
    let finishWrite!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      finishWrite = resolveGate;
    });
    let contents = "original";
    let settled = false;
    const write = vi.fn(async (_path: string, content: string) => {
      await gate;
      contents = content;
    });
    const tool = createWriteToolDefinition("/fixture", {
      operations: { mkdir: async () => {}, writeFile: write },
    });
    const pending = tool
      .execute(
        "write-1",
        { path: "docs/page.md", content: "complete edit" },
        controller.signal,
        undefined,
        {} as never,
      )
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    controller.abort();
    expect(settled).toBe(false);
    expect(contents).toBe("original");
    finishWrite();
    await pending;
    expect(contents).toBe("complete edit");
    expect(contents).not.toBe("original");
  });

  it("projects cancellation with a useful artifact as partial rather than complete", () => {
    const result = projectDelegatedTaskFulfillment(
      fulfillmentInput({
        stopReason: "cancelled",
        artifacts: [artifactEvidence()],
        checks: [checkEvidence({ state: "not-run" })],
      }),
    );
    expect(result.fulfillment).toBe("partial");
    expect(result.stopReason).toBe("cancelled");
    expect(result.artifacts).toHaveLength(1);
  });
});

describe("S12 exact-task resume revalidates a stale snapshot", () => {
  it("rejects a stale workspace snapshot and skips only an unchanged bound snapshot", () => {
    const record = {
      steps: [
        {
          id: "plan-documentation",
          searchEvidence: { workspaceSnapshotSha256: SNAPSHOT_A },
          planBinding: { digest: PLAN_DIGEST },
        },
      ],
    };
    expect(evaluateResumeSkip({ record, currentWorkspaceSnapshotSha256: SNAPSHOT_B })).toEqual({
      skipPlanner: false,
      skipSearchObserve: false,
      revalidate: true,
    });
    expect(evaluateResumeSkip({ record, currentWorkspaceSnapshotSha256: SNAPSHOT_A })).toEqual({
      skipPlanner: true,
      skipSearchObserve: true,
      revalidate: false,
    });
  });
});

describe("S13 competing owner and preserved user work", () => {
  it("treats a live matching owner as busy rather than a competing grant", () => {
    const owner = { pid: 99, processBirthIdentity: "f".repeat(64) };
    expect(
      classifyLatest(continuationAttempt({ phase: "executing", owner }), {
        inspect: (pid) =>
          pid === 99 ? { alive: true, identity: owner.processBirthIdentity } : { alive: false },
      }),
    ).toBe("busy");
  });
});

describe("S14 exhausted budget retains partial work", () => {
  it("keeps unmet obligations and a useful artifact when the budget is exhausted", () => {
    const result = projectDelegatedTaskFulfillment(
      fulfillmentInput({
        stopReason: "budget-exhausted",
        artifacts: [artifactEvidence()],
        checks: [checkEvidence({ state: "passed", receiptSha256: HASH("docs-check-receipt") })],
      }),
    );
    expect(result.fulfillment).toBe("partial");
    expect(result.stopReason).toBe("budget-exhausted");
    expect(result.fulfillment).not.toBe("complete");
    expect(result.artifacts).toHaveLength(1);
  });
});

async function loadManifest(): Promise<QualificationManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as QualificationManifest;
}

async function observeRejected(input: {
  repositoryPath: string;
  observationMode: "workflow-export" | "selected-checkout";
  sourceHints: readonly { role: "public-contract" | "current-documentation"; path: string }[];
}): Promise<ReaderTaskAdmissionObservationError> {
  try {
    await observeReaderTaskContextAdmissionV1({
      ...input,
      readerContextInput: readerInput(),
    });
  } catch (error) {
    if (error instanceof ReaderTaskAdmissionObservationError) return error;
    throw error;
  }
  throw new Error("expected reader-task admission to reject the nomination");
}

function requireFailure(error: ReaderTaskAdmissionObservationError): ReaderTaskAdmissionFailureV1 {
  const failure = projectReaderTaskAdmissionFailure(error);
  if (!failure) throw new Error("expected a bounded reader-task admission failure projection");
  return failure;
}

async function writePages(
  repository: string,
  from: number,
  to: number,
): Promise<readonly string[]> {
  await mkdir(join(repository, "docs", "pages"), { recursive: true });
  const paths: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const path = `docs/pages/page-${String(index).padStart(2, "0")}.md`;
    await writeFile(join(repository, path), `# Page ${index}\n\n${SOURCE_SENTINEL}\n`);
    paths.push(path);
  }
  return Object.freeze(paths);
}

function pagePathsOf(paths: readonly string[]): string[] {
  return paths.filter((path) => path.startsWith("docs/pages/")).sort();
}

function journeyEnvelope(): TaskBudgetEnvelope {
  return {
    "provider-turns": 8,
    "tool-calls": 8,
    "input-tokens": 80,
    "output-tokens": 80,
    "source-bytes": 80,
    "elapsed-ms": 80,
    "cost-microusd": 80,
  };
}

function childReservation(): TaskBudgetEnvelope {
  return {
    "provider-turns": 3,
    "tool-calls": 3,
    "input-tokens": 30,
    "output-tokens": 30,
    "source-bytes": 30,
    "elapsed-ms": 30,
    "cost-microusd": 30,
  };
}

function replayCharge(): TaskBudgetEnvelope {
  return {
    "provider-turns": 1,
    "tool-calls": 1,
    "input-tokens": 1,
    "output-tokens": 1,
    "source-bytes": 1,
    "elapsed-ms": 1,
    "cost-microusd": 1,
  };
}

function grandchildReservation(): TaskBudgetEnvelope {
  return {
    "provider-turns": 2,
    "tool-calls": 2,
    "input-tokens": 20,
    "output-tokens": 20,
    "source-bytes": 20,
    "elapsed-ms": 20,
    "cost-microusd": 20,
  };
}

async function gitRepository(): Promise<string> {
  const repository = await roots.create("docsfab-task-reconciliation-");
  await initFixtureRepo(repository, { "docs/cli.md": `# CLI\n${SOURCE_SENTINEL}\n` });
  return repository;
}

function readerInput() {
  return {
    schema_version: 1 as const,
    target_audience: "developers",
    reader_job: "run one inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public contract", "current docs"],
    required_content: ["command", "verification"],
    excluded_content: ["unrelated internals"],
    unresolved_questions: [],
  };
}

function requirements() {
  return [
    {
      id: "R1",
      kind: "artifact" as const,
      originalSha256: delegatedTaskRequirementIdentitySha256({
        id: "R1",
        kind: "artifact",
        targetLocator: "docs/a.md",
      }),
      targetLocator: "docs/a.md",
    },
    {
      id: "R2",
      kind: "check" as const,
      originalSha256: delegatedTaskRequirementIdentitySha256({
        id: "R2",
        kind: "check",
        targetLocator: "docs-check",
      }),
      targetLocator: "docs-check",
    },
  ];
}

function identityFields() {
  const originalRequirements = requirements();
  return {
    taskId: TASK_ID,
    taskSha256: delegatedTaskRequirementsIdentitySha256(originalRequirements),
    repositoryIdentitySha256: HASH("repo"),
    repositoryRevision: REVISION,
  };
}

function fulfillmentInput(
  overrides: Partial<DelegatedTaskFulfillmentInputV1> = {},
): DelegatedTaskFulfillmentInputV1 {
  const originalRequirements = overrides.originalRequirements ?? requirements();
  return {
    taskId: TASK_ID,
    stopReason: "finished",
    deliveryState: "not-requested",
    artifacts: [],
    checks: [],
    children: [],
    pendingQuestions: [],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, total: 14, turns: 2 },
    ...overrides,
    originalRequirements,
    request: {
      kind: "bounded-instruction",
      requestSha256: HASH("request"),
      taskKind: "instruction-only",
      taskSha256: delegatedTaskRequirementsIdentitySha256(originalRequirements),
    },
    repository: {
      identitySha256: HASH("repo"),
      revision: REVISION,
    },
    planRequirementIds: overrides.planRequirementIds ?? originalRequirements.map((item) => item.id),
  };
}

function artifactEvidence() {
  return {
    evidenceId: "artifact:a",
    ...identityFields(),
    locator: "docs/a.md",
    digestSha256: HASH("docs/a.md"),
    boundRequirementIds: ["R1"],
    persistence: "applied" as const,
    supportClass: "supported" as const,
  };
}

function checkEvidence(
  overrides: Partial<{
    state: "not-run" | "passed" | "failed" | "unknown";
    receiptSha256: string | null;
  }> = {},
) {
  return {
    evidenceId: "check:docs-check",
    ...identityFields(),
    checkId: "docs-check",
    state: overrides.state ?? "not-run",
    receiptSha256: overrides.receiptSha256 ?? null,
    boundRequirementIds: ["R2"],
  };
}

function childEvidence(
  overrides: Partial<{
    status: "succeeded" | "failed";
    failureCode: string | null;
    formalQuality: "not-established" | "failed";
    attemptedRequirementIds: readonly string[];
  }> = {},
) {
  return {
    childId: "run:child-create",
    ...identityFields(),
    workflow: "create-documentation" as const,
    status: overrides.status ?? "failed",
    failureCode: overrides.failureCode ?? null,
    formalQuality: overrides.formalQuality ?? "not-established",
    attemptedRequirementIds: overrides.attemptedRequirementIds ?? ["R1"],
  };
}

function continuationAttempt(input: {
  phase: KnowledgeContinuationAttemptV1["phase"];
  owner: KnowledgeContinuationAttemptV1["owner"];
}): KnowledgeContinuationAttemptV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-attempt",
    originalRunId: "stopped-run",
    sequence: 1,
    predecessorSha256: null,
    attemptId: "attempt-1",
    childRunId: "child-1",
    snapshotSha256: SNAPSHOT_A,
    deliveryIntentSha256: SNAPSHOT_B,
    owner: input.owner,
    deliveryOwner: null,
    phase: input.phase,
    childRecordSha256: null,
    deliveryResult: null,
    recordedAt: "2026-09-17T00:00:00.000Z",
    journalSha256: PLAN_DIGEST,
  };
}
