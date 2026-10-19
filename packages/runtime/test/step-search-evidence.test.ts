// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import type {
  RepositoryBatchReplayAuthorityV1,
  RepositoryDiscoveryInventoryV1,
} from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  createDocumentationGapLedger,
  currentDocumentationGapFindings,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "../src/search/gap-ledger.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.js";
import {
  projectModelSearchBrief,
  resolveSearchBriefLimit,
  searchBriefOmissionWarning,
} from "../src/search/model-search-brief.js";
import {
  createSearchParticipationState,
  rememberSearchObservation,
} from "../src/workflow-execution/search-participation.js";
import type { LastSearchObservation } from "../src/workflow-execution/search-participation.js";
import { workflowSearch } from "../src/workflow-execution/runner-evidence.js";
import { prepareStepSearchEvidence } from "../src/workflow-execution/step-loop/search-evidence.js";
import type { WorkflowSearchCoordinator } from "../src/workflow-contracts/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { initFixtureRepo } from "./helpers/git.js";

const temporary: string[] = [];
const disposers: Array<() => Promise<void>> = [];
const workflow = getWorkflow("release-documentation-readiness");
const observeStep = workflow.steps.find((step) => step.searchMode === "observe")!;
const reuseStep = { ...observeStep, id: "reuse-release-readiness", searchMode: "reuse" as const };
const repositoryRoot = "docs/reference/configuration-reference";
let repository: RunRecord["repository"];
let evidence: NonNullable<StepRunRecord["searchEvidence"]>;
let repositoryBatchAuthority: RepositoryBatchReplayAuthorityV1 | undefined;
let trustedInventory: RepositoryDiscoveryInventoryV1 | undefined;
let coordinator: LocalWorkflowSearchCoordinator;
let hostLimitsFile: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "docsfab-step-search-evidence-"));
  temporary.push(root);
  hostLimitsFile = join(root, "host-limits.env");
  const files: Record<string, string> = {
    "README.md": "# Fixture\n\nSee the [guide](docs/guide.md).\n",
    "docs/guide.md": "# Guide\n\nUse the tool.\n",
    [`${repositoryRoot}/shared.md`]:
      "# Shared Configuration Policy\n\nThis page links the reference entries and explains how operators validate configuration.\n",
  };
  for (let index = 0; index < 17; index += 1) {
    files[`${repositoryRoot}/page-${String(index).padStart(4, "0")}.md`] =
      `# Configuration Reference ${index}\n\nThis page documents supported runtime configuration and environment options. It explains how operators select values, preserve the documented trust boundary, and verify the resulting workflow. See the [shared policy](shared.md) for common validation guidance.\n\n## Setting values\n\nThe project reads settings from a configuration file and permits environment overrides. Keep credentials outside the repository and record the effective setting before running a workflow.\n\n## Example\n\n\`\`\`yaml\nsearch:\n  profile: default\n\`\`\`\n\n## Validation\n\nRun the documented validation command after changing a setting, then confirm the resulting workflow uses the intended value.\n`;
  }
  const revision = await initFixtureRepo(root, files, { branch: "main" });
  const workspace = await prepareRepositoryWorkspace(root, "HEAD");
  disposers.push(() => workspace.dispose());
  repository = {
    sourcePath: workspace.sourcePath,
    requestedRevision: workspace.requestedRevision,
    revision: workspace.revision,
  };
  expect(repository.revision).toBe(revision);
  coordinator = new LocalWorkflowSearchCoordinator({ workspace });
  const searched = await workflowSearch({
    workflowSearch: coordinator,
    runId: "run-step-search-evidence-fixture",
    repositoryPath: workspace.path,
    repository,
    workflow,
    step: observeStep,
    repositoryDefaultBranch: "main",
  });
  if (!searched) throw new Error("The fixture search did not return evidence.");
  evidence = searched.evidence;
  repositoryBatchAuthority = searched.repositoryBatchAuthority;
  trustedInventory = searched.trustedInventory;
  expect(repositoryBatchAuthority).toBeDefined();
  expect(trustedInventory).toBeDefined();
});

afterAll(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function reuseState(
  observedEvidence = evidence,
): ReturnType<typeof createSearchParticipationState> {
  const findings = projectDocumentationSearchFindings({
    workflow: workflow.name,
    stepId: observeStep.id,
    evidence: observedEvidence,
  });
  const gapLedger = createDocumentationGapLedger({
    currentRevision: repository.revision,
    findings,
  });
  const observation: LastSearchObservation = {
    stepId: observeStep.id,
    observedByStepId: observeStep.id,
    searchMode: "observe",
    planId: observeStep.search!.id,
    workspaceSnapshotSha256: observedEvidence.workspaceSnapshotSha256,
    searchEvidence: observedEvidence,
    searchFindings: findings,
    gapLedger,
    ...(repositoryBatchAuthority ? { repositoryBatchAuthority } : {}),
    ...(trustedInventory ? { trustedInventory } : {}),
  };
  const state = createSearchParticipationState();
  rememberSearchObservation(state, observation);
  return state;
}

function recordAndStep(): { record: RunRecord; stepRecord: StepRunRecord } {
  const stepRecord: StepRunRecord = {
    id: reuseStep.id,
    title: reuseStep.title,
    skill: reuseStep.skill,
    mode: reuseStep.mode,
    status: "running",
  };
  const record = {
    schemaVersion: 2,
    id: "run-step-search-evidence-boundary",
    workflow: workflow.name,
    repository,
    workspace: { strategy: "tracked-export", disposable: true },
    status: "running",
    steps: [stepRecord],
  } as RunRecord;
  return { record, stepRecord };
}

function input(
  overrides: Partial<Parameters<typeof prepareStepSearchEvidence>[0]> = {},
  observedEvidence = evidence,
) {
  const { record, stepRecord } = recordAndStep();
  const coordinatorPort: WorkflowSearchCoordinator = {
    search: vi.fn((searchInput: Parameters<WorkflowSearchCoordinator["search"]>[0]) =>
      coordinator.search(searchInput),
    ),
  };
  const value: Parameters<typeof prepareStepSearchEvidence>[0] = {
    activeWorkflowSearch: coordinatorPort,
    step: reuseStep,
    searchParticipation: reuseState(observedEvidence),
    session: { releaseTrustedInventory: undefined },
    stepRecord,
    workflow,
    record,
    options: { store: { save: vi.fn(async () => undefined) } },
    request: { repository, releaseDefaultBranch: "main" },
    activeWorkspacePath: repository.sourcePath,
    ...overrides,
  };
  return {
    record,
    stepRecord,
    coordinatorPort,
    value,
  };
}

describe("step-loop search evidence boundary", () => {
  it("reuses the observed evidence by identity, retains its observer, and saves projected record evidence", async () => {
    const save = vi.fn(async (saved: RunRecord) => {
      const savedStep = saved.steps[0]!;
      expect(savedStep.searchEvidence).toBe(evidence);
      expect(savedStep.searchParticipation).toMatchObject({
        searchMode: "reuse",
        observedByStepId: observeStep.id,
        searchEvidenceSha256: evidence.evidenceSha256,
      });
      expect(savedStep.repositoryBatchAuthority).toBe(repositoryBatchAuthority);
      expect(saved.gapLedger).toBe(savedStep.gapLedger);
      expect(saved.searchFindings).toEqual(currentDocumentationGapFindings(savedStep.gapLedger!));
      expect(saved.negativeEvidence).toEqual(negativeDocumentationEvidence(saved.searchFindings!));
    });
    const setup = input({ options: { store: { save } } });
    const store = setup.value.options.store;
    const coordinatorPort = setup.coordinatorPort;

    const returned = await prepareStepSearchEvidence(setup.value);

    expect(coordinatorPort.search).not.toHaveBeenCalled();
    expect(returned).toBe(evidence);
    expect(setup.stepRecord.searchEvidence).toBe(evidence);
    expect(setup.stepRecord.searchParticipation).toMatchObject({
      searchMode: "reuse",
      observedByStepId: observeStep.id,
      searchEvidenceSha256: evidence.evidenceSha256,
    });
    expect(setup.record.gapLedger).toBe(setup.stepRecord.gapLedger);
    expect(setup.record.searchFindings).toEqual(
      currentDocumentationGapFindings(setup.stepRecord.gapLedger!),
    );
    expect(setup.record.negativeEvidence).toEqual(
      negativeDocumentationEvidence(setup.record.searchFindings!),
    );
    expect(setup.value.session.releaseTrustedInventory).toBe(trustedInventory);
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.save).toHaveBeenCalledWith(setup.record);
  });

  it("propagates a rejected save unchanged before appending an omission warning", async () => {
    const failure = new Error("fixture store failure");
    const limit = resolveSearchBriefLimit();
    const { accounting } = projectModelSearchBrief(evidence, limit);
    const constrainedValue = Math.max(
      LIMIT_DEFINITION_BY_NAME["searchBrief.totalMaxChars"].min,
      accounting.fixedChars,
    );
    expect(accounting.citedPathCount).toBeGreaterThan(0);
    expect(constrainedValue).toBeLessThanOrEqual(limit.value);
    expect(accounting.uncutChars).toBeGreaterThan(constrainedValue);
    await writeFile(hostLimitsFile, `searchBrief.totalMaxChars=${constrainedValue}\n`);
    vi.stubEnv("DOCSFAB_SERVICE_ENV_FILE", hostLimitsFile);
    try {
      expect(resolveSearchBriefLimit()).toMatchObject({
        source: "host",
        value: constrainedValue,
      });
      expect(searchBriefOmissionWarning(reuseStep.id, evidence)).toBeDefined();
      const save = vi.fn(async (_saved: RunRecord) => {
        expect(searchBriefOmissionWarning(reuseStep.id, evidence)).toBeDefined();
        throw failure;
      });
      const setup = input({ options: { store: { save } } });

      await expect(prepareStepSearchEvidence(setup.value)).rejects.toBe(failure);

      expect(save).toHaveBeenCalledOnce();
      expect(setup.coordinatorPort.search).not.toHaveBeenCalled();
      expect(setup.record.evidenceWarnings).toBeUndefined();
      expect(setup.stepRecord.searchEvidence).toBe(evidence);
      expect(setup.record.gapLedger).toBe(setup.stepRecord.gapLedger);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns undefined without mutation or save when the coordinator or plan is absent", async () => {
    const withoutCoordinator = input({ activeWorkflowSearch: undefined });
    const saveWithoutCoordinator = withoutCoordinator.value.options.store.save;
    const beforeWithoutCoordinator = structuredClone(withoutCoordinator.record);
    const sessionWithoutCoordinator = structuredClone(withoutCoordinator.value.session);
    const participationWithoutCoordinator = structuredClone(
      withoutCoordinator.value.searchParticipation,
    );
    await expect(prepareStepSearchEvidence(withoutCoordinator.value)).resolves.toBeUndefined();
    expect(withoutCoordinator.record).toEqual(beforeWithoutCoordinator);
    expect(withoutCoordinator.value.session).toEqual(sessionWithoutCoordinator);
    expect(withoutCoordinator.value.searchParticipation).toEqual(participationWithoutCoordinator);
    expect(saveWithoutCoordinator).not.toHaveBeenCalled();

    const withoutPlan = input({
      step: { ...reuseStep, search: undefined, searchMode: undefined },
    });
    const saveWithoutPlan = withoutPlan.value.options.store.save;
    const beforeWithoutPlan = structuredClone(withoutPlan.record);
    const sessionWithoutPlan = structuredClone(withoutPlan.value.session);
    const participationWithoutPlan = structuredClone(withoutPlan.value.searchParticipation);
    await expect(prepareStepSearchEvidence(withoutPlan.value)).resolves.toBeUndefined();
    expect(withoutPlan.record).toEqual(beforeWithoutPlan);
    expect(withoutPlan.value.session).toEqual(sessionWithoutPlan);
    expect(withoutPlan.value.searchParticipation).toEqual(participationWithoutPlan);
    expect(saveWithoutPlan).not.toHaveBeenCalled();
  });
});
