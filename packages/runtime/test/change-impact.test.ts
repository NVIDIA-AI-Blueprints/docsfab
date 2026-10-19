// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { ReaderContextComparisonV1 } from "../src/context/reader-context.js";
import type { ChangeImpactAssessmentV1 } from "../src/search/change-impact.js";
import { ChangeImpactError, formatChangeImpactInstruction } from "../src/search/change-impact.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { readTrackedRepositoryFile } from "../src/repository/workspace/tracked-read.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

const RUN_RECORD = "d".repeat(64);
const temporary = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

interface Fixture {
  root: string;
  base: string;
  head: string;
  workspace: RepositoryWorkspace;
}

async function fixture(headConfig = '{"requestTimeout":30}\n'): Promise<Fixture> {
  const root = await temporary.create("docsfab-change-impact-");
  const base = await initFixtureRepo(
    root,
    {
      "docs/guide.md": "# Guide\n\n## Timeouts\n\nSet `requestTimeout` to 30 seconds.\n",
      "src/api.ts": "export const requestTimeout = 30;\n",
      "config/defaults.json": '{"requestTimeout":20}\n',
    },
    { message: "base" },
  );
  await writeFile(join(root, "config", "defaults.json"), headConfig);
  const head = await commitFixture(root, "head");
  const workspace = await prepareRepositoryWorkspace(root, head);
  workspaces.push(workspace);
  return { root, base, head, workspace };
}

async function source(
  workspace: RepositoryWorkspace,
  uri: string,
  role: "public-contract" | "changed-source" | "current-documentation",
) {
  const bytes = await readTrackedRepositoryFile(workspace, uri, 1024 * 1024);
  return { uri, role, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function inspect(
  fixture: Fixture,
  options: {
    comparison?: ReaderContextComparisonV1;
    changedPaths?: string[];
    currentDocumentation?: boolean;
    mode?: "observe" | "revalidate" | "reuse";
    previousAssessment?: ChangeImpactAssessmentV1;
  } = {},
) {
  const comparison = options.comparison ?? {
    kind: "base-head",
    base_revision: fixture.base,
    head_revision: fixture.head,
  };
  const sources = [
    await source(fixture.workspace, "config/defaults.json", "changed-source"),
    await source(fixture.workspace, "src/api.ts", "public-contract"),
    ...(options.currentDocumentation === false
      ? []
      : [await source(fixture.workspace, "docs/guide.md", "current-documentation")]),
  ];
  return new LocalWorkflowSearchCoordinator({
    workspace: fixture.workspace,
    verifyChangeImpactSourceRunRecord: async ({ sourceRunRecordSha256, repository }) => {
      expect(sourceRunRecordSha256).toBe(RUN_RECORD);
      expect(repository.revision).toBe(fixture.head);
      return RUN_RECORD;
    },
  }).inspectChangeImpact({
    changedPaths: options.changedPaths ?? ["config/defaults.json"],
    comparison,
    sources,
    sourceRunRecordSha256: RUN_RECORD,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.previousAssessment ? { previousAssessment: options.previousAssessment } : {}),
  });
}

describe("bounded change-impact evidence", () => {
  it("discovers a generic config change through authenticated source/document terms", async () => {
    const repo = await fixture();
    const result = await inspect(repo);

    expect(result.assessment.disposition).toBe("candidates");
    expect(result.assessment.coverage).toEqual({
      comparison: true,
      changedSource: true,
      currentDocumentation: true,
      publicContract: true,
      inventory: true,
      navigation: true,
    });
    expect(result.assessment.changedPaths).toEqual(["config/defaults.json"]);
    expect(result.assessment.candidates).toContainEqual(
      expect.objectContaining({
        path: "docs/guide.md",
        headingId: "timeouts",
        reason: "source-document-relationship",
        relatedTerms: ["requesttimeout"],
      }),
    );
    expect(result.assessment.sectionEvidence).toContainEqual(
      expect.objectContaining({
        repositoryRevision: repo.head,
        workspaceSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        path: "docs/guide.md",
        headingId: "timeouts",
      }),
    );
    expect(result.delta.sourceRunRecordSha256).toBe(RUN_RECORD);
  });

  it("rejects caller-invented comparison paths and source-run identities", async () => {
    const repo = await fixture();
    await expect(inspect(repo, { changedPaths: ["src/api.ts"] })).rejects.toMatchObject({
      code: "evidence-contradiction",
    } satisfies Partial<ChangeImpactError>);
    const coordinator = new LocalWorkflowSearchCoordinator({ workspace: repo.workspace });
    await expect(
      coordinator.inspectChangeImpact({
        changedPaths: ["config/defaults.json"],
        comparison: { kind: "base-head", base_revision: repo.base, head_revision: repo.head },
        sources: [],
        sourceRunRecordSha256: RUN_RECORD,
      }),
    ).rejects.toThrow(/run-record authority/u);

    const wrongRecord = new LocalWorkflowSearchCoordinator({
      workspace: repo.workspace,
      verifyChangeImpactSourceRunRecord: async ({ repository }) => {
        expect(repository.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(repository.contentDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
        throw new Error("retained record belongs to another revision");
      },
    });
    await expect(
      wrongRecord.inspectChangeImpact({
        changedPaths: ["config/defaults.json"],
        comparison: { kind: "base-head", base_revision: repo.base, head_revision: repo.head },
        sources: [
          await source(repo.workspace, "config/defaults.json", "changed-source"),
          await source(repo.workspace, "src/api.ts", "public-contract"),
          await source(repo.workspace, "docs/guide.md", "current-documentation"),
        ],
        sourceRunRecordSha256: RUN_RECORD,
      }),
    ).rejects.toMatchObject({ code: "evidence-contradiction" });
  });

  it("rejects workspace bytes changed after inventory admission", async () => {
    const repo = await fixture();
    const sources = [
      await source(repo.workspace, "config/defaults.json", "changed-source"),
      await source(repo.workspace, "src/api.ts", "public-contract"),
      await source(repo.workspace, "docs/guide.md", "current-documentation"),
    ];
    const coordinator = new LocalWorkflowSearchCoordinator({
      workspace: repo.workspace,
      verifyChangeImpactSourceRunRecord: async () => {
        await writeFile(join(repo.workspace.path, "docs/guide.md"), "# changed\n");
        return RUN_RECORD;
      },
    });
    await expect(
      coordinator.inspectChangeImpact({
        changedPaths: ["config/defaults.json"],
        comparison: { kind: "base-head", base_revision: repo.base, head_revision: repo.head },
        sources,
        sourceRunRecordSha256: RUN_RECORD,
      }),
    ).rejects.toMatchObject({ code: "snapshot-changed" });
  });

  it("keeps empty filename hits as candidate absence rather than no-change", async () => {
    const repo = await fixture('{"internalBuffer":32}\n');
    const result = await inspect(repo);
    expect(result.assessment.disposition).toBe("candidate-absence");
    expect(result.assessment.candidates).toEqual([]);
    expect(formatChangeImpactInstruction(result.assessment)).toContain(
      "Candidate absence is not a no-change conclusion.",
    );
  });

  it("admits changed-source inapplicability only for identical observed revisions", async () => {
    const repo = await fixture();
    const sources = [
      await source(repo.workspace, "src/api.ts", "public-contract"),
      await source(repo.workspace, "docs/guide.md", "current-documentation"),
    ];
    const coordinator = new LocalWorkflowSearchCoordinator({
      workspace: repo.workspace,
      verifyChangeImpactSourceRunRecord: async () => RUN_RECORD,
    });
    const result = await coordinator.inspectChangeImpact({
      changedPaths: [],
      comparison: {
        kind: "base-head",
        base_revision: repo.head,
        head_revision: repo.head,
      },
      sources,
      sourceRunRecordSha256: RUN_RECORD,
    });
    expect(result.assessment.coverage.changedSource).toBe(true);
    expect(result.assessment.limitations).toContain(
      "changed-source-not-applicable-identical-revisions",
    );
    await expect(
      coordinator.inspectChangeImpact({
        changedPaths: [],
        comparison: {
          kind: "base-head",
          base_revision: repo.head,
          head_revision: repo.head,
        },
        sources: [
          await source(repo.workspace, "config/defaults.json", "changed-source"),
          ...sources,
        ],
        sourceRunRecordSha256: RUN_RECORD,
      }),
    ).rejects.toMatchObject({ code: "evidence-contradiction" });
  });

  it("authenticates workspace comparison coverage through verified nominated source bytes", async () => {
    const repo = await fixture();
    const inventory = await buildRepositoryDiscoveryInventory({ workspace: repo.workspace });
    const sources = [
      await source(repo.workspace, "config/defaults.json", "changed-source"),
      await source(repo.workspace, "src/api.ts", "public-contract"),
      await source(repo.workspace, "docs/guide.md", "current-documentation"),
    ];
    const coordinator = new LocalWorkflowSearchCoordinator({
      workspace: repo.workspace,
      verifyChangeImpactSourceRunRecord: async () => RUN_RECORD,
    });
    const comparison = {
      kind: "workspace" as const,
      snapshot_sha256: inventory.inventorySha256,
    };
    const result = await coordinator.inspectChangeImpact({
      changedPaths: [],
      comparison,
      sources,
      sourceRunRecordSha256: RUN_RECORD,
    });
    expect(result.assessment.coverage).toMatchObject({
      comparison: true,
      changedSource: true,
      currentDocumentation: true,
      publicContract: true,
    });
    expect(result.assessment.verifiedSources).toContainEqual(
      expect.objectContaining({ role: "changed-source", uri: "config/defaults.json" }),
    );
    expect(result.assessment.changedPaths).toEqual([]);

    const missingChangedSource = await coordinator.inspectChangeImpact({
      changedPaths: [],
      comparison,
      sources: sources.filter((item) => item.role !== "changed-source"),
      sourceRunRecordSha256: RUN_RECORD,
    });
    expect(missingChangedSource.assessment.coverage.changedSource).toBe(false);
    expect(missingChangedSource.assessment.disposition).toBe("insufficient-evidence");
    expect(missingChangedSource.assessment.limitations).toContain(
      "changed-source-evidence-missing",
    );

    await expect(
      coordinator.inspectChangeImpact({
        changedPaths: [],
        comparison: { ...comparison, snapshot_sha256: "f".repeat(64) },
        sources,
        sourceRunRecordSha256: RUN_RECORD,
      }),
    ).rejects.toMatchObject({ code: "evidence-contradiction" });
    await expect(
      coordinator.inspectChangeImpact({
        changedPaths: [],
        comparison,
        sources: [{ ...sources[0]!, sha256: "f".repeat(64) }, ...sources.slice(1)],
        sourceRunRecordSha256: RUN_RECORD,
      }),
    ).rejects.toMatchObject({ code: "evidence-contradiction" });
  });

  it("reports unknown comparison and missing current-document evidence honestly", async () => {
    const repo = await fixture();
    const result = await inspect(repo, {
      comparison: { kind: "unknown" },
      changedPaths: [],
      currentDocumentation: false,
    });
    expect(result.assessment.disposition).toBe("insufficient-evidence");
    expect(result.assessment.coverage.comparison).toBe(false);
    expect(result.assessment.coverage.currentDocumentation).toBe(false);
    expect(result.assessment.limitations).toEqual(
      expect.arrayContaining([
        "comparison-unknown-or-mismatched",
        "current-documentation-evidence-missing",
      ]),
    );
  });

  it("invalidates dependent evidence after a newly admitted commit snapshot", async () => {
    const firstRepo = await fixture();
    const first = await inspect(firstRepo);
    await writeFile(join(firstRepo.root, "config", "defaults.json"), '{"requestTimeout":45}\n');
    const nextHead = await commitFixture(firstRepo.root, "next");
    const nextWorkspace = await prepareRepositoryWorkspace(firstRepo.root, nextHead);
    workspaces.push(nextWorkspace);
    const nextRepo = {
      root: firstRepo.root,
      base: firstRepo.head,
      head: nextHead,
      workspace: nextWorkspace,
    };
    const second = await inspect(nextRepo, {
      mode: "revalidate",
      previousAssessment: first.assessment,
    });
    expect(second.assessment.invalidatedEvidenceSha256s).toEqual([
      first.assessment.assessmentSha256,
    ]);
    expect(second.assessment.workspaceSnapshotSha256).not.toBe(
      first.assessment.workspaceSnapshotSha256,
    );
  });

  it("rejects tampered retained evidence before authenticated reuse", async () => {
    const repo = await fixture();
    const first = await inspect(repo);
    const tampered = structuredClone(first.assessment);
    tampered.coverage.currentDocumentation = false;
    await expect(
      inspect(repo, { mode: "reuse", previousAssessment: tampered }),
    ).rejects.toMatchObject({ code: "invalid-value" } satisfies Partial<ChangeImpactError>);
  });
});

describe("comparison CLI intent", () => {
  const revision = "a".repeat(40);
  const baseRevision = "b".repeat(40);
  const base = [
    "update-documentation",
    "--instruction",
    "Assess the current documentation.",
    "--revision",
    revision,
  ];

  it("keeps exact base/head, workspace, and unknown requests distinct", () => {
    expect(
      parseRunArguments([...base, "--comparison-base", baseRevision]).comparisonRequest,
    ).toEqual({
      kind: "base-head",
      baseRevision,
      headRevision: revision,
    });
    expect(parseRunArguments([...base, "--comparison-workspace"]).comparisonRequest).toEqual({
      kind: "workspace",
    });
    expect(parseRunArguments(base).comparisonRequest).toBeUndefined();
  });

  it("does not substitute HEAD or combine comparison modes", () => {
    expect(() =>
      parseRunArguments([
        "update-documentation",
        "--instruction",
        "Assess the current documentation.",
        "--comparison-base",
        baseRevision,
      ]),
    ).toThrow(/exact full Git object IDs/u);
    expect(() =>
      parseRunArguments([...base, "--comparison-base", baseRevision, "--comparison-workspace"]),
    ).toThrow(/mutually exclusive/u);
  });
});
