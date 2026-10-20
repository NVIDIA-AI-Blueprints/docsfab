// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { recordRunTaskLineage } from "../src/lineage/index.js";
import {
  createAutoAssessment,
  createAutoCycleRequest,
  createAutoWorkflowTaskBinding,
  createWorkflowCandidate,
} from "./support/autonomy-contracts.js";
import {
  createHostAuthorityCycleMint,
  createHostAuthorityLineageMint,
} from "../src/autonomy/once.js";
import {
  ManagedCycleError,
  createManagedIssueAssignmentIntent,
  decodeManagedCycleLink,
  decodeManagedIssueSelection,
  reconcileManagedCycleDraftMrLink,
  runManagedIssueCycleOnce,
  selectManagedIssue,
} from "../src/autonomy/managed-cycle.js";

const IDENTITY = "1".repeat(64);
const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const TRACKER = "3".repeat(64);
const FINDING_SHA = "4".repeat(64);
const FINGERPRINT = "5".repeat(64);
const EVIDENCE = "6".repeat(64);
const ASSIGNEE = "c".repeat(64);
const REPOSITORY = { identitySha256: IDENTITY, revision: REVISION };
const BASE = Date.parse("2026-08-07T12:00:00.000Z");

import type {
  ManagedIssueSelectionCandidateInputV1,
  ManagedIssueSelectionInputV1,
  ManagedCycleLinkV1,
  ManagedCycleOnceHost,
} from "../src/autonomy/managed-cycle.js";

function baseCandidate(
  iid: number,
  seed: string,
  overrides: Partial<ManagedIssueSelectionCandidateInputV1> = {},
): ManagedIssueSelectionCandidateInputV1 {
  return {
    issueIid: iid,
    markerIdentityDigest: seed.repeat(64),
    gate: "g1",
    workflow: "content-repair",
    priority: "p1",
    lifecycle: "ready",
    confidence: "confirmed",
    dependencyReadiness: "ready",
    pathCollision: "none",
    validationCost: 1,
    requiredHumanInputOpen: false,
    testedRevision: REVISION,
    ...overrides,
  };
}

function selectionInput(
  candidates: ManagedIssueSelectionCandidateInputV1[],
): ManagedIssueSelectionInputV1 {
  return {
    cycleId: "cycle:once-fixture",
    repository: REPOSITORY,
    trackerObservationSha256: TRACKER,
    candidates,
  };
}

import { createWorkflowDecision } from "./support/autonomy-contracts.js";

function managedChain(deliveryMode: "local-patch" | "local-user-gitlab", rev: string = REVISION) {
  const repository = { identitySha256: IDENTITY, revision: rev };
  const binding = createAutoWorkflowTaskBinding("create-documentation", null, repository);
  const stepIds = getWorkflow("create-documentation").steps.map((step) => step.id);
  const request = createAutoCycleRequest({
    cycleId: "cycle:once-fixture",
    repository,
    tracker: {
      projectIdentitySha256: "2".repeat(64),
      observationSha256: "3".repeat(64),
      observedAt: "2026-08-07T11:59:00.000Z",
      authority: "observe-only",
    },
    maturityFindingSha256s: [FINDING_SHA],
    bounds: {
      workflowNames: ["create-documentation"],
      pathClass: "documentation-write",
      pathPrefixes: ["docs"],
      targetBranch: "main",
      deliveryMode,
      requiredValidationIds: ["docs-build"],
      workflowPrerequisites: [
        { workflow: "create-documentation", prerequisiteIds: ["scaffold-ready"] },
      ],
      workflowTasks: [binding],
    },
  });
  const candidate = createWorkflowCandidate(
    {
      id: "candidate:create-documentation",
      taskSha256: binding.taskSha256,
      workflow: "create-documentation",
      stepIds,
      prerequisites: [{ id: "scaffold-ready", state: "satisfied", evidenceSha256s: [EVIDENCE] }],
      maturityFindingFingerprints: [FINGERPRINT],
      pathClass: "documentation-write",
      pathPrefixes: ["docs"],
      deliveryMode,
      validationIds: ["docs-build"],
    },
    request,
  );
  const { schemaVersion: _s, kind: _k, candidateSha256: _c, ...candidateInput } = candidate;
  const assessment = createAutoAssessment(
    {
      requestSha256: request.requestSha256,
      repository: request.repository,
      trackerObservationSha256: request.tracker.observationSha256,
      evidenceState: "sufficient",
      maturityFindings: [
        {
          fingerprint: FINGERPRINT,
          findingSha256: FINDING_SHA,
          confidence: "confirmed",
          disposition: "observed-absence",
        },
      ],
      candidates: [candidateInput],
      openInputIds: [],
    },
    request,
  );
  const decision = createWorkflowDecision(
    {
      disposition: "execute",
      candidateSha256: assessment.candidates[0]!.candidateSha256,
      reasonCode: "eligible-candidate-selected",
    },
    request,
    assessment,
  );
  return { request, assessment, decision, repository };
}

import type { AutoCycleOnceRecordV1 } from "../src/autonomy/once.js";

function succeededRun(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-once-fixture",
    workflow: "create-documentation",
    repository: { sourcePath: "/tmp/source", requestedRevision: "HEAD", revision: REVISION },
    status: "succeeded",
  } as unknown as RunRecord;
}

function failedRun(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-once-failed",
    workflow: "create-documentation",
    repository: { sourcePath: "/tmp/source", requestedRevision: "HEAD", revision: REVISION },
    status: "failed",
  } as unknown as RunRecord;
}

function buildManagedHost(options: { failed?: boolean } = {}): {
  host: ManagedCycleOnceHost;
  saved: AutoCycleOnceRecordV1[];
  links: ManagedCycleLinkV1[];
  executed: unknown[];
} {
  const now = () => new Date(BASE);
  const saved: AutoCycleOnceRecordV1[] = [];
  const links: ManagedCycleLinkV1[] = [];
  const executed: unknown[] = [];
  const host: ManagedCycleOnceHost = {
    now,
    confirmation: {
      authorityId: "operator-local",
      operatorIdentitySha256: "c".repeat(64),
      affirmed: true as const,
    },
    mintCycle: createHostAuthorityCycleMint(now),
    mintLineage: createHostAuthorityLineageMint(now),
    execute: async (input) => {
      executed.push(input);
      const record = options.failed ? failedRun() : succeededRun();
      recordRunTaskLineage(record, input.taskLineage);
      return record;
    },
    validate: async (_record, ids) =>
      ids.map((id) =>
        options.failed
          ? { id, status: "not-run" as const, evidenceSha256: null }
          : { id, status: "passed" as const, evidenceSha256: "9".repeat(64) },
      ),
    save: async (record) => {
      saved.push(record);
    },
    saveLink: async (link) => {
      links.push(link);
    },
  };
  return { host, saved, links, executed };
}

function publicationResult(targetBranch: string) {
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-local-user-gitlab-publication-result" as const,
    status: "opened" as const,
    planSha256: "7".repeat(64),
    idempotencyKey: "8".repeat(64),
    receiptSha256: "e".repeat(64),
    state: "opened" as const,
    disposition: "succeeded" as const,
    sourceBranch: "docsfab-run/once-fixture",
    targetBranch,
    commitRevision: REVISION,
    mergeRequest: {
      iid: 42,
      url: "https://example.test/group/repo/-/merge_requests/42",
      draft: true as const,
      headRevision: REVISION,
    },
  };
}

describe("managed-issue selection (#107)", () => {
  it("selects exactly one ready issue and defers lower-ranked eligibles", () => {
    const selection = selectManagedIssue(
      selectionInput([
        baseCandidate(10, "1", { gate: "g2", priority: "p1" }),
        baseCandidate(11, "2", { gate: "g0", priority: "p0" }),
        baseCandidate(12, "3", { gate: "g1", priority: "p1" }),
      ]),
    );
    expect(selection.selected?.issueIid).toBe(11);
    expect(selection.deferred.map((d) => d.issueIid)).toEqual([10, 12]);
    expect(selection.deferred.every((d) => d.reasonCode === "lower-ranked")).toBe(true);
    expect(selection.rejected).toHaveLength(0);
  });

  it("keeps blocked, duplicate, stale, investigation, and human-input issues out", () => {
    const selection = selectManagedIssue(
      selectionInput([
        baseCandidate(20, "a", { lifecycle: "blocked" }),
        baseCandidate(21, "b", { lifecycle: "duplicate" }),
        baseCandidate(22, "c", { testedRevision: OTHER_REVISION }),
        baseCandidate(23, "d", { workflow: "investigation" }),
        baseCandidate(24, "e", { requiredHumanInputOpen: true }),
        baseCandidate(25, "f"),
      ]),
    );
    expect(selection.selected?.issueIid).toBe(25);
    const reasons = new Map(selection.rejected.map((r) => [r.issueIid, r.reasonCode]));
    expect(reasons.get(20)).toBe("blocked-lifecycle");
    expect(reasons.get(21)).toBe("duplicate-lifecycle");
    expect(reasons.get(22)).toBe("stale-evidence");
    expect(reasons.get(23)).toBe("investigation-only");
    expect(reasons.get(24)).toBe("human-input-required");
  });

  it("selects nothing when no issue is ready", () => {
    const selection = selectManagedIssue(
      selectionInput([
        baseCandidate(30, "a", { lifecycle: "blocked" }),
        baseCandidate(31, "b", { lifecycle: "in-review" }),
      ]),
    );
    expect(selection.selected).toBeNull();
    expect(selection.rejected).toHaveLength(2);
  });
});

describe("managed-issue assignment intent (#107)", () => {
  it("binds an assignment intent to the selected issue", () => {
    const selection = selectManagedIssue(selectionInput([baseCandidate(40, "a")]));
    const intent = createManagedIssueAssignmentIntent(selection, ASSIGNEE);
    expect(intent.issueIid).toBe(40);
    expect(intent.fromLifecycle).toBe("ready");
    expect(intent.toLifecycle).toBe("selected");
    expect(intent.assigneeIdentitySha256).toBe(ASSIGNEE);
    expect(intent.operationKey.startsWith("operation:assign:")).toBe(true);
  });

  it("refuses to assign when no ready issue was selected", () => {
    const selection = selectManagedIssue(
      selectionInput([baseCandidate(41, "a", { lifecycle: "blocked" })]),
    );
    expect(() => createManagedIssueAssignmentIntent(selection, ASSIGNEE)).toThrow(
      ManagedCycleError,
    );
  });
});

describe("select, assign, execute, and link one issue to a draft MR (#107)", () => {
  it("links a succeeded GitLab cycle to a draft MR and moves lifecycle to in-review", async () => {
    const { host, saved, links, executed } = buildManagedHost();
    const outcome = await runManagedIssueCycleOnce(
      {
        selection: selectionInput([baseCandidate(50, "a"), baseCandidate(51, "b", { gate: "g3" })]),
        assigneeIdentitySha256: ASSIGNEE,
        chain: managedChain("local-user-gitlab"),
      },
      host,
    );
    expect(executed).toHaveLength(1);
    expect(outcome.selection.selected?.issueIid).toBe(50);
    expect(outcome.assignment?.issueIid).toBe(50);
    expect(outcome.link?.disposition).toBe("executed-succeeded");
    expect(outcome.link?.draftMrLink?.draft).toBe(true);
    expect(outcome.link?.draftMrLink?.closesIssueOnMerge).toBe(true);
    expect(outcome.link?.draftMrLink?.relatedIssueIid).toBe(50);
    expect(outcome.link?.lifecycleTarget).toBe("in-review");
    expect(outcome.link?.patchEvidencePreserved).toBe(true);
    expect(saved).toHaveLength(1);
    expect(links).toHaveLength(1);
  });

  it("preserves patch-only evidence and opens no draft MR for a local-patch cycle", async () => {
    const { host } = buildManagedHost();
    const outcome = await runManagedIssueCycleOnce(
      {
        selection: selectionInput([baseCandidate(52, "a")]),
        assigneeIdentitySha256: ASSIGNEE,
        chain: managedChain("local-patch"),
      },
      host,
    );
    expect(outcome.link?.disposition).toBe("executed-succeeded");
    expect(outcome.link?.draftMrLink).toBeNull();
    expect(outcome.link?.lifecycleTarget).toBe("in-progress");
    expect(outcome.link?.patchEvidencePreserved).toBe(true);
  });
});

describe("managed cycle failure and guard behavior (#107)", () => {
  it("preserves evidence and issue state when the workflow fails", async () => {
    const { host } = buildManagedHost({ failed: true });
    const outcome = await runManagedIssueCycleOnce(
      {
        selection: selectionInput([baseCandidate(53, "a")]),
        assigneeIdentitySha256: ASSIGNEE,
        chain: managedChain("local-user-gitlab"),
      },
      host,
    );
    expect(outcome.link?.disposition).toBe("executed-failed");
    expect(outcome.link?.draftMrLink).toBeNull();
    expect(outcome.link?.lifecycleTarget).toBe("in-progress");
    expect(outcome.link?.patchEvidencePreserved).toBe(true);
  });

  it("rejects a selection bound to a different revision than the cycle", async () => {
    const { host } = buildManagedHost();
    await expect(
      runManagedIssueCycleOnce(
        {
          selection: selectionInput([baseCandidate(54, "a")]),
          assigneeIdentitySha256: ASSIGNEE,
          chain: managedChain("local-user-gitlab", OTHER_REVISION),
        },
        host,
      ),
    ).rejects.toBeInstanceOf(ManagedCycleError);
  });

  it("performs no cycle when the queue has no ready issue", async () => {
    const { host, executed, links } = buildManagedHost();
    const outcome = await runManagedIssueCycleOnce(
      {
        selection: selectionInput([baseCandidate(55, "a", { lifecycle: "blocked" })]),
        assigneeIdentitySha256: ASSIGNEE,
        chain: managedChain("local-user-gitlab"),
      },
      host,
    );
    expect(outcome.selection.selected).toBeNull();
    expect(outcome.link).toBeNull();
    expect(executed).toHaveLength(0);
    expect(links).toHaveLength(0);
  });
});

describe("managed-cycle draft-MR consumer seam for #100 (#107)", () => {
  async function linkedOutcome(deliveryMode: "local-patch" | "local-user-gitlab") {
    const { host } = buildManagedHost();
    const outcome = await runManagedIssueCycleOnce(
      {
        selection: selectionInput([baseCandidate(60, "a")]),
        assigneeIdentitySha256: ASSIGNEE,
        chain: managedChain(deliveryMode),
      },
      host,
    );
    return outcome.link!;
  }

  it("reconciles a draft-MR result to an in-review delivery link", async () => {
    const link = await linkedOutcome("local-user-gitlab");
    const delivery = reconcileManagedCycleDraftMrLink(link, publicationResult("main"));
    expect(delivery.mergeRequestIid).toBe(42);
    expect(delivery.draft).toBe(true);
    expect(delivery.closesIssueOnMerge).toBe(true);
    expect(delivery.lifecycleTarget).toBe("in-review");
    expect(delivery.issueIid).toBe(60);
  });

  it("is idempotent across repeated reconciliation", async () => {
    const link = await linkedOutcome("local-user-gitlab");
    const first = reconcileManagedCycleDraftMrLink(link, publicationResult("main"));
    const second = reconcileManagedCycleDraftMrLink(link, publicationResult("main"));
    expect(second).toEqual(first);
  });

  it("fails closed when the published branch drifts from the authorized target", async () => {
    const link = await linkedOutcome("local-user-gitlab");
    expect(() => reconcileManagedCycleDraftMrLink(link, publicationResult("release"))).toThrow(
      ManagedCycleError,
    );
  });

  it("refuses to reconcile a cycle that produced no draft MR", async () => {
    const link = await linkedOutcome("local-patch");
    expect(() => reconcileManagedCycleDraftMrLink(link, publicationResult("main"))).toThrow(
      ManagedCycleError,
    );
  });
});

describe("managed-cycle records are resumable and consumable (#107)", () => {
  it("round-trips the selection and link through their decoders", async () => {
    const selection = selectManagedIssue(selectionInput([baseCandidate(70, "a")]));
    const decodedSelection = decodeManagedIssueSelection(JSON.parse(JSON.stringify(selection)));
    expect(decodedSelection.selectionSha256).toBe(selection.selectionSha256);

    const { host } = buildManagedHost();
    const outcome = await runManagedIssueCycleOnce(
      {
        selection: selectionInput([baseCandidate(71, "a")]),
        assigneeIdentitySha256: ASSIGNEE,
        chain: managedChain("local-user-gitlab"),
      },
      host,
    );
    const link = outcome.link!;
    const decodedLink = decodeManagedCycleLink(JSON.parse(JSON.stringify(link)));
    expect(decodedLink.linkSha256).toBe(link.linkSha256);
    expect(decodedLink.draftMrLink?.draft).toBe(true);
  });
});
