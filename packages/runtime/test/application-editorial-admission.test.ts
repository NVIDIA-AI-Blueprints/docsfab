// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { assembleEditorialAdmissionControlV1 } from "../src/application/editorial-admission.js";
import type { ArtifactReference } from "../src/artifacts/index.js";
import type { ContentIndexV1 } from "../src/content-ir/contracts.js";
import type { ReaderTaskContextObservationV1 } from "../src/execution/reader-task-admission.js";
import * as readerAdmission from "../src/execution/reader-task-admission.js";
import type {
  ReaderTaskContextInputProjectionV1,
  ReaderTaskContextSupplier,
} from "../src/execution/task-context.js";
import type { WorkflowBranchEvidenceHost } from "../src/workflow-contracts/contracts.js";
import * as editorialAssembly from "../src/workflow-execution/editorial-evidence-assembly.js";

const HASH = "a".repeat(64);
const REVISION = "b".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assembleEditorialAdmissionControlV1", () => {
  it("returns undefined when reader evidence is incomplete", async () => {
    const assemble = vi.spyOn(editorialAssembly, "assembleEditorialEvidenceFromAdmissionV1");
    const result = await assembleEditorialAdmissionControlV1({
      ...baseInput(),
      contentIndex: undefined,
    });
    expect(result).toBeUndefined();
    expect(assemble).not.toHaveBeenCalled();
  });

  it("assembles editorial admission from observed reader evidence", async () => {
    const host = sentinelHost("initial");
    mockAssemble([host]);
    const observed = observation();
    const result = await assembleEditorialAdmissionControlV1({
      ...baseInput(),
      observation: observed,
    });
    expect(result?.workflowBranchEvidence).toBe(host);
    expect(result?.editorialAdmission.comparison).toEqual(observed.admission.comparison);
    expect(result?.editorialAdmission.sources).toEqual([
      {
        uri: "docs/guide.md",
        sha256: HASH,
        role: "current-documentation",
      },
    ]);
    expect(result?.editorialAdmission.refreshForPlannedPages).toEqual(expect.any(Function));
  });

  it("deduplicates planned-page refresh hints and keeps first-seen order", async () => {
    mockAssemble([sentinelHost("initial"), sentinelHost("refresh")]);
    const observe = mockObserve(observation());
    const result = await assembleEditorialAdmissionControlV1({
      ...baseInput(),
      initialSourceHints: [
        { role: "current-documentation", path: "docs/a.md" },
        { role: "changed-source", path: "docs/a.md" },
      ],
      retainsVirtualRequest: true,
      requestEvidenceText: "Update the guide.",
    });
    await result?.editorialAdmission.refreshForPlannedPages?.(["docs/a.md", "docs/b.md"]);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toMatchObject({
      repositoryPath: "/tmp/repo",
      revision: REVISION,
      observationMode: "workflow-export",
      sourceHints: [
        { role: "current-documentation", path: "docs/a.md" },
        { role: "current-documentation", path: "docs/b.md" },
        { role: "changed-source", path: "docs/a.md" },
      ],
      requestText: "Update the guide.",
    });
    expect(observe.mock.calls[0]?.[0].onMissingSource).toBeUndefined();
  });

  it("caps merged-MR refresh nominations against change_scope remainder", async () => {
    mockAssemble([sentinelHost("initial"), sentinelHost("refresh")]);
    const observe = mockObserve(observation());
    const changeScope = Array.from({ length: 128 }, (_, index) => `docs/scope-${index}.md`);
    const result = await assembleEditorialAdmissionControlV1({
      ...baseInput({
        readerTaskContext: readerTaskContext(changeScope),
      }),
      capRefreshNominations: true,
    });
    await result?.editorialAdmission.refreshForPlannedPages?.(
      Array.from({ length: 5 }, (_, index) => `docs/page-${index}.md`),
    );
    expect(observe.mock.calls[0]?.[0].sourceHints).toEqual([
      { role: "current-documentation", path: "docs/page-0.md" },
    ]);
    expect(observe.mock.calls[0]?.[0].onMissingSource).toEqual(expect.any(Function));
  });

  it("replaces the live evidence host after planned-page refresh", async () => {
    const initial = sentinelHost("initial");
    const refreshed = sentinelHost("refresh");
    mockAssemble([initial, refreshed]);
    mockObserve(
      observation({
        sources: [
          {
            uri: "docs/planned.md",
            role: "current-documentation",
            sha256: HASH,
          },
        ],
        comparison: { kind: "unknown" },
      }),
    );
    const result = await assembleEditorialAdmissionControlV1(baseInput());
    expect(result?.workflowBranchEvidence).toBe(initial);
    const admitted = await result?.editorialAdmission.refreshForPlannedPages?.(["docs/planned.md"]);
    expect(result?.workflowBranchEvidence).toBe(refreshed);
    expect(admitted?.workflowBranchEvidence).toBe(refreshed);
    expect(admitted?.comparison).toEqual({ kind: "unknown" });
    expect(admitted?.sources).toEqual([
      {
        uri: "docs/planned.md",
        sha256: HASH,
        role: "current-documentation",
      },
    ]);
  });
});

function mockAssemble(hosts: readonly WorkflowBranchEvidenceHost[]) {
  const assemble = vi.spyOn(editorialAssembly, "assembleEditorialEvidenceFromAdmissionV1");
  for (const host of hosts) {
    assemble.mockResolvedValueOnce({
      readerTaskContext: readerTaskContext(),
      observation: observation(),
      editorialEvidenceRefs: [] as ArtifactReference[],
      workflowBranchEvidence: host,
    } as never);
  }
  return assemble;
}

function mockObserve(value: ReaderTaskContextObservationV1) {
  return vi.spyOn(readerAdmission, "observeReaderTaskContextAdmissionV1").mockResolvedValue(value);
}

function sentinelHost(label: string): WorkflowBranchEvidenceHost {
  const fail = async () => {
    throw new Error(`${label} must not run`);
  };
  return {
    select: fail,
    observeAssessment: fail,
    finalize: fail,
    decodeEditorialDecision: () => {
      throw new Error(`${label} must not run`);
    },
  };
}

function readerContext(changeScope: readonly string[]) {
  return {
    schema_version: 1 as const,
    target_audience: "docs engineers",
    reader_job: "Update the guide.",
    change_scope: [...changeScope],
    source_priority: [],
    required_content: [],
    excluded_content: [],
    unresolved_questions: [],
  };
}

function readerTaskContext(
  changeScope: readonly string[] = ["docs/guide.md"],
): ReaderTaskContextInputProjectionV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-reader-task-context-input",
    inputOrigin: "conservative-fallback",
    noChangeAssessment: "ineligible",
    readerContextInput: readerContext(changeScope),
    baseline: {
      path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md",
      sha256: HASH,
      content: "baseline",
    },
    policy: { id: "policy", version: "v1", sha256: HASH },
    prompt: "input",
  };
}

function observation(
  extras: Partial<ReaderTaskContextObservationV1["admission"]> = {},
): ReaderTaskContextObservationV1 {
  return {
    admission: {
      admittedRevision: REVISION,
      workspaceSnapshotSha256: HASH,
      repositoryIdentitySha256: HASH,
      comparison: {
        kind: "base-head",
        base_revision: REVISION,
        head_revision: REVISION,
      },
      sources: [
        {
          uri: "docs/guide.md",
          role: "current-documentation",
          sha256: HASH,
        },
      ],
      provenanceLimitations: ["changed-source-not-applicable-identical-revisions"],
      ...extras,
    },
    sourceBytes: [],
    changedPaths: [],
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    artifactRoot: "/tmp/artifacts",
    contentIndex: {} as ContentIndexV1,
    readerTaskContext: readerTaskContext(),
    observation: observation(),
    supplier: {} as ReaderTaskContextSupplier,
    repositoryPath: "/tmp/repo",
    revision: REVISION,
    initialSourceHints: [] as const,
    ...overrides,
  };
}
