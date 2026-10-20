// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  projectDelegatedTaskFulfillment,
  type DelegatedTaskFulfillmentInputV1,
} from "../src/delegated-task/fulfillment.js";
import {
  delegatedTaskContractKit,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
} from "../src/delegated-task/result-contract.js";
import {
  TASK_RECONCILIATION_FIELD_AUTHORITIES,
  TASK_RECONCILIATION_KIND,
  admitTaskRecoveryAction,
  applyAdmittedInventoryRecount,
  projectEffectCertainty,
  projectTaskReconciliation,
  recountTaskInventoryThroughAdmittedTool,
  releasedSupplierPresence,
  type AdmittedInventoryEvidenceV1,
  type TaskInventoryClaimV1,
} from "../src/execution/task-reconciliation.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { classifyLatest } from "../src/records/knowledge-continuation-store.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");
const HASH = (value: string) => delegatedTaskContractKit.canonicalDigest(value);
const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const TASK_ID = "task:reconciliation-938";
const PAGE_SENTINEL = "PAGE_SENTINEL_DO_NOT_MUTATE";
const SECRET = "TOKEN=tracked-secret";

const roots = temporaryRoots();

describe("task reconciliation field authorities", () => {
  it("maps each factual field to one existing producer and marks #779 task-budget released", () => {
    const fields = TASK_RECONCILIATION_FIELD_AUTHORITIES.map((entry) => entry.field);
    expect(new Set(fields).size).toBe(fields.length);
    expect(fields).toContain("taskBudget");
    for (const entry of TASK_RECONCILIATION_FIELD_AUTHORITIES) {
      expect(entry.producer).not.toMatch(/model-prose|summary|semantic/iu);
      expect(entry.consumer).toBe("packages/runtime/src/execution/task-reconciliation.ts");
      if (entry.status === "released") {
        expect(existsSync(join(repoRoot, entry.producer)), entry.producer).toBe(true);
      } else {
        expect(entry.status).toBe("unknown");
        expect(existsSync(join(repoRoot, entry.producer)), entry.producer).toBe(false);
      }
    }
    expect(releasedSupplierPresence()).toEqual({
      taskBudget: true,
      taskScope: true,
      interactiveOperation: true,
    });
    expect(existsSync(join(runtimeRoot, "src/execution/task-budget.ts"))).toBe(true);
  });
});

describe("S02 inventory recount through the admitted tool", () => {
  it("recounts a real 17-page repository, invalidates a stale 14, and does not ask", async () => {
    const { repository, pagePaths } = await seventeenPageRepository();
    const stalePaths = pagePaths.slice(0, 14);
    const missingPaths = pagePaths.slice(14);
    expect(stalePaths).toHaveLength(14);
    expect(missingPaths).toHaveLength(3);

    const confined = await createConfinedToolSet({
      workspacePath: repository,
      allowWrite: false,
    });
    const find = confined.definitions.find((tool) => tool.name === "find");
    expect(find).toBeDefined();
    const listed = toolText(
      await find!.execute(
        "find",
        { path: "docs/pages", pattern: "*.md" },
        undefined,
        undefined,
        {} as never,
      ),
    );
    const listedPaths = listed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    expect(listedPaths).toHaveLength(17);

    const staleClaim: TaskInventoryClaimV1 = {
      source: "model-prose",
      pageCount: 14,
      pagePaths: stalePaths,
    };
    expect(
      admitTaskRecoveryAction({ inspectAvailable: true }, { kind: "declare-inventory-from-prose" })
        .code,
    ).toBe("refused-model-prose-fact");
    expect(
      admitTaskRecoveryAction({ inspectAvailable: true }, { kind: "ask-human" }).humanAskRequired,
    ).toBe(false);
    expect(
      admitTaskRecoveryAction({ inspectAvailable: true }, { kind: "inspect-inventory" }).admitted,
    ).toBe(true);

    const admitted = await recountTaskInventoryThroughAdmittedTool({
      repositoryPath: repository,
    });
    const pageDocuments = admitted.pagePaths
      .filter((path) => path.startsWith("docs/pages/"))
      .sort();
    expect(pageDocuments).toEqual([...pagePaths].sort());
    expect(pageDocuments).toHaveLength(17);

    const projection = projectTaskReconciliation({
      originalRequest: {
        outcome: "Count the documentation pages.",
        requestSha256: HASH("count"),
      },
      staleInventoryClaim: staleClaim,
      admittedInventory: {
        ...admitted,
        pagePaths: pageDocuments,
      },
      workspaceIdentity: {
        revision: admitted.repositoryRevision,
        observationMode: "workflow-export",
      },
    });
    expect(projection.kind).toBe(TASK_RECONCILIATION_KIND);
    expect(projection.inventory.pageCount).toBe(17);
    expect(projection.inventory.invalidatedModelProseCounts).toEqual([14]);
    expect([...projection.inventory.retainedPagePaths].sort()).toEqual([...missingPaths].sort());
    expect(projection.humanAskRequired).toBe(false);
    expect(projection.completion).toBe("incomplete");
    expect(projection.budget).toEqual({
      availability: "unknown",
      reason: "task-budget-api-unconsumed",
    });
    expect(JSON.stringify(projection)).not.toMatch(/InputAsk|needs-input/u);

    for (const [index, path] of missingPaths.entries()) {
      const bytes = await readFile(join(repository, path), "utf8");
      expect(bytes).toContain(PAGE_SENTINEL);
      expect(bytes).toContain(`# Page ${index + 15}`);
    }
    expect(listed).toContain("page-15.md");
    expect(listed).toContain("page-16.md");
    expect(listed).toContain("page-17.md");
  });

  it("retains incomplete canonical inventory and never admits it as evidence", async () => {
    const { repository } = await seventeenPageRepository();
    const target = join(repository, "docs", "pages", "page-01.md");
    const linked = join(repository, "docs", "pages", "linked.md");
    await symlink(target, linked);
    await commitFixture(repository, "tracked symlink");

    const recounted = await recountTaskInventoryThroughAdmittedTool({ repositoryPath: repository });
    expect(recounted.status).toBe("incomplete");
    expect(recounted.coverage.structure.status).toBe("incomplete");
    expect(recounted.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "unsafe-tracked-entry" })]),
    );

    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Count the documentation pages." },
      admittedInventory: recounted,
      fulfillment: projectDelegatedTaskFulfillment(fulfillmentInput()),
      workspaceIdentity: {
        revision: recounted.repositoryRevision,
        observationMode: "workflow-export",
      },
    });
    expect(projection.inventory.admitted).toBeUndefined();
    expect(projection.inventory.recountStatus).toBe("incomplete");
    expect(projection.inventory.recountFailures).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "unsafe-tracked-entry" })]),
    );
    expect(projection.completion).toBe("incomplete");
  });
});

describe("S08 child evidence versus required checks", () => {
  it("keeps a succeeded child incomplete when a mandatory check never ran", () => {
    const fulfillment = projectDelegatedTaskFulfillment(
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
    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Ship the CLI guide." },
      fulfillment,
      workspaceIdentity: {
        revision: REVISION,
        observationMode: "workflow-export",
      },
    });
    expect(fulfillment.fulfillment).toBe("partial");
    expect(fulfillment.children[0]?.status).toBe("succeeded");
    expect(projection.completion).toBe("incomplete");
    expect(projection.unmetCheckIds).toEqual(["R2"]);
    expect(projection.establishedOperations[0]?.status).toBe("succeeded");
    expect(
      admitTaskRecoveryAction(
        { unmetCheckIds: projection.unmetCheckIds },
        { kind: "claim-complete" },
      ).code,
    ).toBe("refused-complete-unmet-checks");
    expect(JSON.stringify(projection)).not.toContain("done");
  });

  it("keeps a failed child failed beside later direct recovery without inventing workflow success", () => {
    const fulfillment = projectDelegatedTaskFulfillment(
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
    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Ship the CLI guide." },
      fulfillment,
      workspaceIdentity: {
        revision: REVISION,
        observationMode: "workflow-export",
      },
    });
    expect(projection.completion).toBe("incomplete");
    expect(projection.fulfillment?.children[0]).toMatchObject({
      status: "failed",
      failureCode: "workflow-failed",
    });
    expect(projection.fulfillment?.deliveryState).toBe("ineligible");
    expect(projection.fulfillment?.fulfillment).not.toBe("complete");
  });
});

describe("freshness, dirty checkout, and duplicate evidence", () => {
  it("drops admitted inventory from a mismatched revision", () => {
    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Recount pages." },
      staleInventoryClaim: {
        source: "model-prose",
        pageCount: 14,
        pagePaths: ["docs/a.md"],
      },
      admittedInventory: {
        pagePaths: ["docs/a.md", "docs/b.md"],
        repositoryRevision: OTHER_REVISION,
        inventorySha256: HASH("stale-inventory"),
        ...completeInventoryFields(),
      },
      workspaceIdentity: {
        revision: REVISION,
        observationMode: "workflow-export",
      },
    });
    expect(projection.inventory.admitted).toBeUndefined();
    expect(projection.inventory.pageCount).toBeUndefined();
  });

  it("keeps dirty-only paths distinct from committed workflow-export evidence", () => {
    const dirty = "src/uncommitted.ts";
    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Use the current sources." },
      workspaceIdentity: {
        revision: REVISION,
        observationMode: "workflow-export",
      },
      dirtyOnlyPaths: [dirty],
      claimedCommittedPaths: [dirty, "docs/cli.md"],
    });
    expect(projection.committedEvidencePaths).toEqual(["docs/cli.md"]);
    expect(projection.dirtyOnlyPaths).toEqual([dirty]);
    expect(projection.selectedCheckoutBlocked).toBe(false);

    const selected = projectTaskReconciliation({
      originalRequest: { outcome: "Use the current sources." },
      workspaceIdentity: {
        revision: REVISION,
        observationMode: "selected-checkout",
      },
      dirtyOnlyPaths: ["docs/user-edit.md"],
    });
    expect(selected.selectedCheckoutBlocked).toBe(true);
    expect(selected.completion).toBe("blocked");
  });

  it("does not settle the same inventory evidence twice", async () => {
    const { repository, pagePaths } = await seventeenPageRepository();
    const admitted = await recountTaskInventoryThroughAdmittedTool({
      repositoryPath: repository,
    });
    const first = projectTaskReconciliation({
      originalRequest: { outcome: "Count the documentation pages." },
      admittedInventory: { ...admitted, pagePaths },
      workspaceIdentity: {
        revision: admitted.repositoryRevision,
        observationMode: "workflow-export",
      },
    });
    const second = applyAdmittedInventoryRecount(first, {
      ...admitted,
      pagePaths,
    });
    expect(second).toBe(first);
    expect(first.appliedEvidenceIds).toEqual([admitted.inventorySha256]);
    expect(first.budget.availability).toBe("unknown");
  });
});

describe("result-change guards", () => {
  it("refuses cancelled, revoked, exhausted, and competing-owner dispatch", () => {
    const action = { kind: "dispatch-child-workflow" as const };
    expect(admitTaskRecoveryAction({ cancelled: true }, action).code).toBe(
      "refused-incompatible-dispatch",
    );
    expect(admitTaskRecoveryAction({ accessRevoked: true }, action).code).toBe(
      "refused-incompatible-dispatch",
    );
    expect(admitTaskRecoveryAction({ budgetExhausted: true }, action).code).toBe(
      "refused-incompatible-dispatch",
    );
    expect(admitTaskRecoveryAction({ anotherActiveOwner: true }, action).code).toBe(
      "refused-incompatible-dispatch",
    );
    const controller = new AbortController();
    controller.abort();
    expect(admitTaskRecoveryAction({ signal: controller.signal }, action).code).toBe(
      "refused-incompatible-dispatch",
    );
  });

  it("exposes inspect/repair for did-not-start and refuses unknown-write replay", () => {
    const inspect = admitTaskRecoveryAction(
      { effectState: "did-not-start", inspectAvailable: true },
      { kind: "inspect-inventory" },
    );
    expect(inspect.admitted).toBe(true);
    const preDispatch = admitTaskRecoveryAction(
      { effectState: "did-not-start" },
      { kind: "replay-write" },
    );
    expect(preDispatch.code).toBe("expose-inspect-repair");
    expect(preDispatch.nextSupportedAction).toBe("inspect-inventory");
    expect(
      admitTaskRecoveryAction({ effectState: "mutation-unknown" }, { kind: "replay-write" }).code,
    ).toBe("refused-replay-unknown-write");
    expect(
      projectEffectCertainty({
        latest: continuationAttempt("failed-before-execution"),
        processes: { inspect: () => ({ alive: false }) },
      }),
    ).toBe("did-not-start");
    expect(
      projectEffectCertainty({
        latest: continuationAttempt("executing"),
        processes: { inspect: () => ({ alive: false }) },
      }),
    ).toBe("mutation-unknown");
    expect(projectEffectCertainty({ latest: continuationAttempt("executing") })).toBe(
      "mutation-unknown",
    );
    expect(
      admitTaskRecoveryAction(
        { effectState: "mutation-unknown" },
        { kind: "dispatch-child-workflow" },
      ).code,
    ).toBe("refused-incompatible-dispatch");
    expect(
      admitTaskRecoveryAction({ effectState: "mutation-unknown" }, { kind: "inspect-inventory" })
        .admitted,
    ).toBe(true);
    expect(
      classifyLatest(continuationAttempt("executing"), {
        inspect: () => ({ alive: false }),
      }),
    ).toBe("recovery-required");
  });

  it("cannot drop a required obligation and withholds secret-bearing payloads", () => {
    const removal = admitTaskRecoveryAction({}, { kind: "remove-obligation", obligationId: "R2" });
    expect(removal.code).toBe("refused-obligation-removal");
    const leaked = admitTaskRecoveryAction(
      {},
      { kind: "dispatch-child-workflow", secretPayload: SECRET },
    );
    expect(leaked.code).toBe("refused-secret-disclosure");
    expect(JSON.stringify(leaked)).not.toContain(SECRET);
    expect(JSON.stringify(leaked)).not.toContain("TOKEN");
  });

  it("bounds unchanged-input repetition without resetting a missing root budget", () => {
    const first = admitTaskRecoveryAction({}, { kind: "replay-write", inputFingerprint: "same" });
    expect(first.admitted).toBe(false);
    const repeat = admitTaskRecoveryAction(
      { previousRecoveryFingerprint: "same", inspectAvailable: true },
      { kind: "replay-write", inputFingerprint: "same" },
    );
    expect(repeat.code).toBe("refused-unchanged-input-repetition");
    const projection = projectTaskReconciliation({
      originalRequest: { outcome: "Continue the task." },
      workspaceIdentity: { revision: REVISION, observationMode: "unknown" },
    });
    expect(projection.budget.availability).toBe("unknown");
    expect(projection.taskScope.availability).toBe("unknown");
    expect(projection.interactiveOperation.availability).toBe("unknown");
  });
});

async function seventeenPageRepository(): Promise<{
  repository: string;
  pagePaths: string[];
}> {
  const repository = await roots.create("docsfab-task-reconciliation-938-");
  await mkdir(join(repository, "docs", "pages"), { recursive: true });
  const pagePaths: string[] = [];
  for (let index = 1; index <= 17; index += 1) {
    const path = `docs/pages/page-${String(index).padStart(2, "0")}.md`;
    await writeFile(join(repository, path), `# Page ${index}\n\n${PAGE_SENTINEL}\n`);
    pagePaths.push(path);
  }
  await initFixtureRepo(repository);
  await commitFixture(repository, "seventeen pages");
  return { repository, pagePaths };
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
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
    usage: {
      input: 10,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      total: 14,
      turns: 2,
    },
    ...overrides,
    originalRequirements,
    request: {
      kind: "bounded-instruction",
      requestSha256: HASH("request"),
      taskKind: "instruction-only",
      taskSha256: delegatedTaskRequirementsIdentitySha256(originalRequirements),
    },
    repository: { identitySha256: HASH("repo"), revision: REVISION },
    planRequirementIds: overrides.planRequirementIds ?? originalRequirements.map((item) => item.id),
  };
}

function artifactEvidence() {
  return {
    evidenceId: "artifact:a",
    ...identityFields(),
    locator: "docs/a.md",
    digestSha256: HASH("docs/a.md-bytes"),
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
  const state = overrides.state ?? "not-run";
  return {
    evidenceId: "check:docs-check",
    ...identityFields(),
    checkId: "docs-check",
    state,
    receiptSha256:
      overrides.receiptSha256 ?? (state === "passed" ? HASH("docs-check-receipt") : null),
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
  const status = overrides.status ?? "succeeded";
  return {
    childId: "run:child-create",
    ...identityFields(),
    workflow: "create-documentation" as const,
    status,
    failureCode: overrides.failureCode ?? (status === "failed" ? "workflow-failed" : null),
    formalQuality: overrides.formalQuality ?? "not-established",
    attemptedRequirementIds: overrides.attemptedRequirementIds ?? ["R1"],
  };
}

function continuationAttempt(
  phase: "failed-before-execution" | "executing",
): Parameters<typeof classifyLatest>[0] {
  return {
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-attempt",
    originalRunId: "run:original",
    sequence: 1,
    predecessorSha256: null,
    attemptId: "attempt:1",
    childRunId: "run:child",
    snapshotSha256: "c".repeat(64),
    deliveryIntentSha256: "d".repeat(64),
    owner: { pid: 4242, processBirthIdentity: "e".repeat(64) },
    deliveryOwner: null,
    phase,
    childRecordSha256: null,
    deliveryResult: null,
    recordedAt: "2026-09-21T00:00:00.000Z",
    journalSha256: "f".repeat(64),
  };
}

function completeInventoryFields(): Pick<
  AdmittedInventoryEvidenceV1,
  "status" | "coverage" | "failures"
> {
  const coverage = (policy: string) => ({
    policy,
    status: "complete" as const,
    indexedCount: 0,
    excludedCount: 0,
    omittedCount: 0,
    evidenceSha256: HASH(policy),
  });
  return {
    status: "complete",
    coverage: {
      structure: coverage("tracked-tree-v1"),
      text: coverage("tracked-regular-utf8-v1"),
      navigation: coverage("content-ir-graph-v2"),
      metadata: coverage("repository-metadata-v1"),
    } as AdmittedInventoryEvidenceV1["coverage"],
    failures: [],
  };
}
