// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HostOperationExecutor } from "../src/execution/contracts.js";
import type { RepositoryTarget } from "../src/repository/contracts.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { admitAuthorizedTrackedWrites } from "../src/repository/workspace/tracked-read.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import {
  authoringCandidateForOrdinal,
  authoringRevisionChangedPaths,
  LocalAuthoringCandidateLifecycle,
} from "../src/workflow-execution/authoring-runtime.js";
import type { AuthoringWorkspaceSnapshotV1 } from "../src/workflow-execution/authoring-workspace-host.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import type { SourceObligationLedgerV1 } from "../src/workflow-execution/source-obligation.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporary = temporaryRoots();
const RUN_ID = "run-authoring-runtime-contract";
const PLAN_DIGEST = "b".repeat(64);
const OUTPUT = "docs/new.md";
const SOURCE = "src/source.ts";

describe("local authoring candidate lifecycle", () => {
  it("seals, revises, selects, materializes, and disposes real candidate workspaces", async () => {
    const fixture = await makeFixture();
    const lifecycle = createLifecycle(fixture, hostOperations);
    let revisionPath: string | undefined;
    try {
      expect(lifecycle.sourceWorkspace()).toMatchObject({
        workspacePath: fixture.workspace.path,
        repositoryWorkspace: fixture.workspace,
        hostOperations,
      });

      await mkdir(dirname(join(fixture.workspace.path, OUTPUT)), { recursive: true });
      await writeFile(join(fixture.workspace.path, OUTPUT), "# Candidate 0\n");
      const candidate0 = await lifecycle.sealCandidate0({
        runId: RUN_ID,
        repository: fixture.repository,
        planDigest: PLAN_DIGEST,
        writePaths: [OUTPUT],
        sourceLedger: fixture.ledger,
      });
      expect(candidate0.candidate.ordinal).toBe(0);

      const session = await lifecycle.prepareRevision({
        runId: RUN_ID,
        repository: fixture.repository,
        candidate0,
        sourceLedger: fixture.ledger,
      });
      revisionPath = session.workspacePath;
      expect(session.repositoryWorkspace).toBe(session.hostSession.workspace);
      expect(session.repositoryEvidence).toBe(session.hostSession.evidenceCollector);

      await writeFile(join(session.workspacePath, OUTPUT), "# Incomplete candidate 1\n");
      const partial = await lifecycle.captureFailedPartial({
        session,
        repository: fixture.repository,
      });
      expect(partial).toMatchObject({ selected: false });
      expect(partial.workspaceSnapshotDigest).toMatch(/^[a-f0-9]{64}$/u);

      await writeFile(join(session.workspacePath, OUTPUT), "# Candidate 1\n");
      const candidate1 = await lifecycle.sealCandidate1({
        session,
        runId: RUN_ID,
        repository: fixture.repository,
        planDigest: PLAN_DIGEST,
        writePaths: [OUTPUT],
        sourceLedger: fixture.ledger,
      });
      expect(candidate1.candidate.ordinal).toBe(1);
      expect(authoringCandidateForOrdinal([candidate0, candidate1], 1)).toBe(candidate1.candidate);
      expect(() => authoringCandidateForOrdinal([candidate1], 0)).toThrow(
        "candidate history is incomplete",
      );

      await expect(
        lifecycle.materializeSelected({ capture: candidate1, repository: fixture.repository }),
      ).rejects.toThrow("no authenticated revision workspace");
      await expect(
        lifecycle.materializeSelected({
          capture: candidate1,
          repository: fixture.repository,
          revisionSession: session,
        }),
      ).resolves.toMatchObject({ patch: { sha256: candidate1.candidate.patchDigestSha256 } });

      await lifecycle.dispose(session);
      await expect(lstat(revisionPath)).rejects.toMatchObject({ code: "ENOENT" });
      revisionPath = undefined;
    } finally {
      if (revisionPath) await rm(revisionPath, { recursive: true, force: true });
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("observes the writer's change and restores exactly candidate 0 before a retry (#1266)", async () => {
    const fixture = await makeFixture();
    const lifecycle = createLifecycle(fixture, hostOperations);
    let revisionPath: string | undefined;
    try {
      await mkdir(dirname(join(fixture.workspace.path, OUTPUT)), { recursive: true });
      await writeFile(join(fixture.workspace.path, OUTPUT), "# Candidate 0\n");
      const candidate0 = await lifecycle.sealCandidate0({
        runId: `${RUN_ID}-reset`,
        repository: fixture.repository,
        planDigest: PLAN_DIGEST,
        writePaths: [OUTPUT],
        sourceLedger: fixture.ledger,
      });
      const session = await lifecycle.prepareRevision({
        runId: `${RUN_ID}-reset`,
        repository: fixture.repository,
        candidate0,
        sourceLedger: fixture.ledger,
      });
      revisionPath = session.workspacePath;
      const page = join(session.workspacePath, OUTPUT);

      // The recorded case: a rewrite with identical bytes changes nothing.
      await writeFile(page, "# Candidate 0\n");
      await expect(lifecycle.observeRevisionChangedPaths({ session })).resolves.toEqual([]);

      await writeFile(page, "# A partial revision\n");
      await expect(lifecycle.observeRevisionChangedPaths({ session })).resolves.toEqual([OUTPUT]);

      await lifecycle.resetRevision({ session });
      await expect(readFile(page, "utf8")).resolves.toBe("# Candidate 0\n");
      await expect(lifecycle.observeRevisionChangedPaths({ session })).resolves.toEqual([]);

      // A retry after the reset seals candidate 1 from its own change only.
      await writeFile(page, "# Candidate 1\n");
      const candidate1 = await lifecycle.sealCandidate1({
        session,
        runId: `${RUN_ID}-reset`,
        repository: fixture.repository,
        planDigest: PLAN_DIGEST,
        writePaths: [OUTPUT],
        sourceLedger: fixture.ledger,
      });
      expect(authoringRevisionChangedPaths(candidate0.snapshot, candidate1.snapshot)).toEqual([
        OUTPUT,
      ]);
    } finally {
      if (revisionPath) await rm(revisionPath, { recursive: true, force: true });
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("refuses to restore a planned page through a symbolic link (#1266)", async () => {
    const fixture = await makeFixture();
    const lifecycle = createLifecycle(fixture, hostOperations);
    let revisionPath: string | undefined;
    const outside = await temporary.create("docsfab-authoring-reset-outside-");
    try {
      await mkdir(dirname(join(fixture.workspace.path, OUTPUT)), { recursive: true });
      await writeFile(join(fixture.workspace.path, OUTPUT), "# Candidate 0\n");
      const candidate0 = await lifecycle.sealCandidate0({
        runId: `${RUN_ID}-reset-link`,
        repository: fixture.repository,
        planDigest: PLAN_DIGEST,
        writePaths: [OUTPUT],
        sourceLedger: fixture.ledger,
      });
      const session = await lifecycle.prepareRevision({
        runId: `${RUN_ID}-reset-link`,
        repository: fixture.repository,
        candidate0,
        sourceLedger: fixture.ledger,
      });
      revisionPath = session.workspacePath;
      const parent = join(session.workspacePath, dirname(OUTPUT));
      await rm(parent, { recursive: true, force: true });
      await symlink(outside, parent);

      await expect(lifecycle.resetRevision({ session })).rejects.toThrow(
        "is no longer a plain directory",
      );
      await expect(lstat(join(outside, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (revisionPath) await rm(revisionPath, { recursive: true, force: true });
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  /** Seal candidate 0 with one planned page and open its revision workspace. */
  async function openRevision(runSuffix: string) {
    const fixture = await makeFixture();
    const lifecycle = createLifecycle(fixture, hostOperations);
    await mkdir(dirname(join(fixture.workspace.path, OUTPUT)), { recursive: true });
    await writeFile(join(fixture.workspace.path, OUTPUT), "# Candidate 0\n");
    const candidate0 = await lifecycle.sealCandidate0({
      runId: `${RUN_ID}-${runSuffix}`,
      repository: fixture.repository,
      planDigest: PLAN_DIGEST,
      writePaths: [OUTPUT],
      sourceLedger: fixture.ledger,
    });
    const session = await lifecycle.prepareRevision({
      runId: `${RUN_ID}-${runSuffix}`,
      repository: fixture.repository,
      candidate0,
      sourceLedger: fixture.ledger,
    });
    return {
      fixture,
      lifecycle,
      session,
      async dispose() {
        await rm(session.workspacePath, { recursive: true, force: true });
        await fixture.collector.dispose();
        await fixture.workspace.dispose();
      },
    };
  }

  const UNKNOWN_ENTRY = "contains an entry that candidate 0 does not have";

  it.each([
    [
      "an extra untracked file beside the planned page",
      async (root: string) => writeFile(join(root, "docs/extra.md"), "# Extra\n"),
    ],
    [
      "an extra untracked symbolic link",
      async (root: string, outside: string) => symlink(outside, join(root, "docs/escape")),
    ],
    ["an extra empty directory", async (root: string) => mkdir(join(root, "docs/extra"))],
    ["a Git directory the host never creates", async (root: string) => mkdir(join(root, ".git"))],
  ] as const)(
    "refuses to reset or observe a revision workspace with %s (#1266)",
    async (_name, addEntry) => {
      const revision = await openRevision("reset-unknown");
      const outside = await temporary.create("docsfab-authoring-reset-unknown-outside-");
      try {
        const root = revision.session.workspacePath;
        await writeFile(join(root, OUTPUT), "# A partial revision\n");
        await addEntry(root, outside);

        await expect(
          revision.lifecycle.observeRevisionChangedPaths({ session: revision.session }),
        ).rejects.toThrow(UNKNOWN_ENTRY);
        await expect(
          revision.lifecycle.resetRevision({ session: revision.session }),
        ).rejects.toThrow(UNKNOWN_ENTRY);
        // The walk never followed the link or wrote outside the workspace.
        await expect(readdir(outside)).resolves.toEqual([]);
      } finally {
        await revision.dispose();
      }
    },
  );

  it("refuses a reset whose restored bytes do not reproduce the candidate-0 snapshot (#1266)", async () => {
    const revision = await openRevision("reset-digest");
    try {
      // The source workspace drifts from candidate 0 and its tracked state admits
      // the drift, so only the final snapshot comparison can notice.
      await writeFile(join(revision.fixture.workspace.path, OUTPUT), "# Drifted source\n");
      await admitAuthorizedTrackedWrites(revision.fixture.workspace, [OUTPUT]);
      await writeFile(join(revision.session.workspacePath, OUTPUT), "# A partial revision\n");

      await expect(revision.lifecycle.resetRevision({ session: revision.session })).rejects.toThrow(
        "did not reproduce the complete candidate-0 snapshot",
      );
    } finally {
      await revision.dispose();
    }
  });

  it("materializes the retained initial candidate without a revision workspace", async () => {
    const fixture = await makeFixture();
    const lifecycle = createLifecycle(fixture, hostOperations);
    try {
      await mkdir(dirname(join(fixture.workspace.path, OUTPUT)), { recursive: true });
      await writeFile(join(fixture.workspace.path, OUTPUT), "# Retained candidate 0\n");
      const candidate0 = await lifecycle.sealCandidate0({
        runId: `${RUN_ID}-retained`,
        repository: fixture.repository,
        planDigest: PLAN_DIGEST,
        writePaths: [OUTPUT],
        sourceLedger: fixture.ledger,
      });

      await expect(
        lifecycle.materializeSelected({ capture: candidate0, repository: fixture.repository }),
      ).resolves.toMatchObject({ patch: { sha256: candidate0.candidate.patchDigestSha256 } });
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("requires candidate-check host operations on the source workspace", async () => {
    const fixture = await makeFixture();
    try {
      const lifecycle = createLifecycle(fixture);
      expect(() => lifecycle.sourceWorkspace()).toThrow(
        "requires a host operation executor for candidate checks",
      );
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("derives the exact changed path set from complete workspace snapshots", () => {
    const before = snapshot([
      entry("README.md", "1"),
      entry("docs/guide.md", "2"),
      entry("docs/removed.md", "3"),
    ]);
    const after = snapshot([
      entry("README.md", "1"),
      entry("docs/guide.md", "4"),
      entry("docs/new.md", "5"),
    ]);

    expect(authoringRevisionChangedPaths(before, after)).toEqual([
      "docs/guide.md",
      "docs/new.md",
      "docs/removed.md",
    ]);
  });
});

const hostOperations: HostOperationExecutor = {
  runStep: async (input) => ({ summary: `checked ${input.step.id}` }),
};

interface Fixture {
  artifacts: string;
  repository: RepositoryTarget;
  workspace: RepositoryWorkspace;
  collector: GitPatchEvidenceCollector;
  ledger: SourceObligationLedgerV1;
}

function createLifecycle(fixture: Fixture, operations?: HostOperationExecutor) {
  return new LocalAuthoringCandidateLifecycle({
    workspace: fixture.workspace,
    evidenceCollector: fixture.collector,
    search: new LocalWorkflowSearchCoordinator({ workspace: fixture.workspace }),
    sourceObserver: new LocalSourceObligationSourceObserver(fixture.workspace),
    hostOperations: operations,
    artifactDirectory: fixture.artifacts,
  });
}

async function makeFixture(): Promise<Fixture> {
  const source = await temporary.create("docsfab-authoring-runtime-source-");
  const artifacts = await temporary.create("docsfab-authoring-runtime-artifacts-");
  const revision = await initFixtureRepo(
    source,
    { "README.md": "# Fixture\n", [SOURCE]: "export const truth = 'source truth';\n" },
    { branch: "main" },
  );
  const sourceSha256 = createHash("sha256")
    .update(await readFile(join(source, SOURCE)))
    .digest("hex");
  const repository = { sourcePath: source, requestedRevision: revision, revision };
  const workspace = await prepareRepositoryWorkspace(source, revision);
  const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
  return {
    artifacts,
    repository,
    workspace,
    collector,
    ledger: {
      kind: "docsfab-source-obligation-ledger",
      schemaVersion: 1,
      identity: {
        repositoryRevision: revision,
        scopeSha256: PLAN_DIGEST,
        sourceEvidenceSha256: "e".repeat(64),
        workspaceSnapshotSha256: "f".repeat(64),
        sources: [{ path: SOURCE, sha256: sourceSha256 }],
      },
      completeness: "bounded-not-proven",
      dimensions: [],
      limitations: [],
      digest: "a".repeat(64),
    },
  };
}

function snapshot(entries: AuthoringWorkspaceSnapshotV1["entries"]): AuthoringWorkspaceSnapshotV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-authoring-workspace-snapshot",
    entries,
    totalBytes: entries.reduce((total, item) => total + (item.byteLength ?? 0), 0),
    digest: "f".repeat(64),
  };
}

function entry(path: string, digestDigit: string) {
  return {
    path,
    kind: "regular" as const,
    mode: 0o644,
    byteLength: 1,
    sha256: digestDigit.repeat(64),
  };
}
