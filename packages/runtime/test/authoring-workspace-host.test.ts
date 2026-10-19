// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessStepInput } from "../src/execution/contracts.js";

import {
  createAuthoringCandidate,
  type AuthoringCandidateV1,
} from "../src/workflow-execution/authoring-candidate.js";
import { limit, limitDefinition, OperationalLimitError } from "../src/config/limits.js";
import {
  admitAuthoringCandidate1,
  captureFailedAuthoringPartial,
  materializeSelectedAuthoringEvidence,
  prepareAuthoringRevisionWorkspace,
  readImmutablePatchArtifact,
  resetAuthoringRevisionWorkspace,
  sealAuthoringCandidate,
  type AuthoringCandidateCaptureV1,
  type AuthoringRevisionWorkspaceV1,
} from "../src/workflow-execution/authoring-workspace-host.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import type { RepositoryTarget } from "../src/repository/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { readTrackedRepositoryFile } from "../src/repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import type { SourceObligationLedgerV1 } from "../src/workflow-execution/source-obligation.js";
import { temporaryRoots } from "./helpers/temp.js";
import { initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

// A pass-through spy, so a test can prove which page bytes the host read.
vi.mock("../src/repository/workspace/tracked-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/repository/workspace/tracked-read.js")>();
  return { ...actual, readTrackedRepositoryFile: vi.fn(actual.readTrackedRepositoryFile) };
});

const temporary = temporaryRoots();
const RUN_ID = "run-workspace-1";
const PLAN = "b".repeat(64);
const SOURCE_EVIDENCE = "e".repeat(64);
const SOURCE_SNAPSHOT = "f".repeat(64);
const OUTPUT = "docs/new.md";
const COPIED_OUTPUT = "docs/copied.md";
/** Sealing and copying a page past 8 MiB writes, diffs and digests it several times. */
const LARGE_PAGE_CASE_MS = 60_000;
const SOURCE = "src/source.ts";

describe("authoring workspace host", () => {
  it("reconstructs a complete candidate-0 child and retains independent patches", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    const child = await prepareChild(fixture, initial);
    try {
      expect(await readFile(join(fixture.workspace.path, OUTPUT), "utf8")).toBe("# Candidate 0\n");
      expect(await readFile(join(fixture.source, SOURCE), "utf8")).toContain("source truth");
      expect(await readFile(join(child.workspace.path, SOURCE), "utf8")).toContain("source truth");
      expect(await readFile(join(child.workspace.path, OUTPUT), "utf8")).toBe("# Candidate 0\n");
      const revisedChecks = await child.hostOperations.runStep({
        repositoryPath: child.workspace.path,
        step: {
          id: "lint-revised-documentation",
          title: "Lint revised documentation",
          skill: "lint-documentation",
          mode: "read-only",
          prompt: "",
        },
        workflow: {
          name: "create-documentation",
          title: "Create",
          outcome: "Create fixture",
          contextPolicy: { schemaVersion: 1, steps: [] },
          steps: [],
        },
      } satisfies HarnessStepInput);
      expect(JSON.parse(revisedChecks.summary)).toMatchObject({ status: "unavailable" });
      expect(initial.evidence.patch?.artifactPath).toContain("candidate0.patch");
      const candidate0Patch = await readFile(initial.evidence.patch!.artifactPath);

      await writeFile(join(child.workspace.path, OUTPUT), "# Candidate 1\n");
      const candidate1 = await sealAuthoringCandidate({
        runId: RUN_ID,
        ordinal: 1,
        originalRevision: fixture.repository.revision,
        planDigest: PLAN,
        writePaths: [OUTPUT],
        workspace: child.workspace,
        repository: fixture.repository,
        evidenceCollector: child.evidenceCollector,
        sourceLedger: fixture.ledger,
      });
      await expect(
        materializeSelectedAuthoringEvidence(candidate1, {
          candidate: candidate1.candidate,
          repository: fixture.repository,
          workspace: child.workspace,
        }),
      ).rejects.toThrow("bound lifecycle admission");
      const admitted = await admitAuthoringCandidate1(
        child,
        candidate1.candidate,
        fixture.repository,
        fixture.ledger,
      );
      const candidate1Patch = await readFile(admitted.evidence.patch!.artifactPath);
      expect(admitted.evidence.patch?.artifactPath).toContain("candidate1.patch");
      expect(candidate1Patch.equals(candidate0Patch)).toBe(false);
      expect(candidate1Patch.toString()).toContain("docs/new.md");
      expect(await readFile(initial.evidence.patch!.artifactPath)).toEqual(candidate0Patch);
      expect(
        await materializeSelectedAuthoringEvidence(admitted, {
          candidate: candidate1.candidate,
          repository: fixture.repository,
          workspace: child.workspace,
        }),
      ).toMatchObject({ patch: { sha256: candidate1.candidate.patchDigestSha256 } });
    } finally {
      await child.dispose();
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("captures failed child bytes under a non-selected immutable artifact", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    const child = await prepareChild(fixture, initial);
    try {
      await writeFile(join(child.workspace.path, "outside.md"), "outside plan\n");
      const failed = await captureFailedAuthoringPartial(child, fixture.repository);
      expect(failed.selected).toBe(false);
      expect(failed.workspaceSnapshotDigest).toBeNull();
      expect(failed.evidence.patch?.artifactPath).toContain("failed-partial.patch");
      expect(failed.evidence.files).toEqual(
        expect.arrayContaining([{ path: "outside.md", status: "added" }]),
      );
    } finally {
      await child.dispose();
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("retains an authenticated planned partial snapshot even after cancellation", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    const child = await prepareChild(fixture, initial);
    try {
      await writeFile(join(child.workspace.path, OUTPUT), "# Incomplete candidate 1\n");
      const controller = new AbortController();
      controller.abort();
      const partial = await captureFailedAuthoringPartial(
        child,
        fixture.repository,
        controller.signal,
      );

      expect(partial.selected).toBe(false);
      expect(partial.workspaceSnapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(partial.evidence.files).toEqual([{ path: OUTPUT, status: "added" }]);
    } finally {
      await child.dispose();
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("treats copied destinations as writes while retaining source and rename protection", async () => {
    const copied = await makeFixture();
    try {
      await mkdir(dirname(join(copied.workspace.path, COPIED_OUTPUT)), { recursive: true });
      await writeFile(copied.workspace.path + `/${COPIED_OUTPUT}`, "# Fixture\n");
      const candidate = await sealAuthoringCandidate({
        runId: RUN_ID,
        repository: copied.repository,
        ordinal: 0,
        originalRevision: copied.repository.revision,
        planDigest: PLAN,
        writePaths: [COPIED_OUTPUT],
        workspace: copied.workspace,
        evidenceCollector: copied.collector,
        sourceLedger: copied.ledger,
      });
      expect(candidate.evidence.files).toEqual([
        { path: COPIED_OUTPUT, status: "copied", previousPath: "README.md" },
      ]);
      await expect(
        materializeSelectedAuthoringEvidence(candidate, {
          candidate: candidate.candidate,
          repository: copied.repository,
          workspace: copied.workspace,
        }),
      ).resolves.toMatchObject({
        files: [{ path: COPIED_OUTPUT, status: "copied", previousPath: "README.md" }],
      });

      const child = await prepareChild(copied, candidate);
      try {
        const partial = await captureFailedAuthoringPartial(child, copied.repository);
        expect(partial.workspaceSnapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(partial.evidence.files).toEqual([
          { path: COPIED_OUTPUT, status: "copied", previousPath: "README.md" },
        ]);
      } finally {
        await child.dispose();
      }
    } finally {
      await copied.collector.dispose();
      await copied.workspace.dispose();
    }

    for (const sourceChange of ["modified", "deleted", "renamed"] as const) {
      const fixture = await makeFixture();
      try {
        await mkdir(dirname(join(fixture.workspace.path, COPIED_OUTPUT)), { recursive: true });
        await writeFile(join(fixture.workspace.path, COPIED_OUTPUT), "# Fixture\n");
        if (sourceChange === "modified") {
          await writeFile(join(fixture.workspace.path, "README.md"), "# Modified fixture\n");
        } else if (sourceChange === "deleted") {
          await rm(join(fixture.workspace.path, "README.md"));
        } else {
          await rm(join(fixture.workspace.path, COPIED_OUTPUT));
          await rename(
            join(fixture.workspace.path, "README.md"),
            join(fixture.workspace.path, COPIED_OUTPUT),
          );
        }
        await expect(
          sealAuthoringCandidate({
            runId: `${RUN_ID}-${sourceChange}`,
            repository: fixture.repository,
            ordinal: 0,
            originalRevision: fixture.repository.revision,
            planDigest: PLAN,
            writePaths: [COPIED_OUTPUT],
            workspace: fixture.workspace,
            evidenceCollector: fixture.collector,
            sourceLedger: fixture.ledger,
          }),
        ).rejects.toThrow();
      } finally {
        await fixture.collector.dispose();
        await fixture.workspace.dispose();
      }
    }
  });

  it("rejects writes outside the plan and source mutation before candidate admission", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    let child = await prepareChild(fixture, initial);
    try {
      await writeFile(join(child.workspace.path, "outside.md"), "outside plan\n");
      await expect(candidateForCurrentWorkspace(child, fixture)).rejects.toThrow(
        "planned write paths",
      );

      await child.dispose();
      child = await prepareChild(
        fixture,
        initial,
        await temporary.create("docsfab-authoring-artifacts-2-"),
      );
      const candidate = await candidateForCurrentWorkspace(child, fixture);
      await writeFile(join(child.workspace.path, SOURCE), "mutated source\n");
      await expect(
        admitAuthoringCandidate1(child, candidate, fixture.repository, fixture.ledger),
      ).rejects.toThrow();
    } finally {
      await child.dispose();
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("fails closed for tampered retained patch, workspace snapshot, and cancelled preparation", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    const patchPath = initial.evidence.patch!.artifactPath;
    const originalPatch = await readFile(patchPath);
    await writeFile(patchPath, Buffer.from("tampered"));
    await expect(
      materializeSelectedAuthoringEvidence(initial, {
        candidate: initial.candidate,
        repository: fixture.repository,
        workspace: fixture.workspace,
      }),
    ).rejects.toThrow("patch artifact changed");
    await writeFile(patchPath, originalPatch);
    const decoyPath = join(fixture.artifacts, "decoy.patch");
    await writeFile(decoyPath, originalPatch, { mode: 0o600 });
    await rm(patchPath);
    await symlink(decoyPath, patchPath);
    await expect(
      materializeSelectedAuthoringEvidence(initial, {
        candidate: initial.candidate,
        repository: fixture.repository,
        workspace: fixture.workspace,
      }),
    ).rejects.toThrow("patch artifact changed");
    await rm(patchPath);
    await writeFile(patchPath, originalPatch, { mode: 0o600 });
    await writeFile(join(fixture.workspace.path, OUTPUT), "changed after admission\n");
    await expect(
      materializeSelectedAuthoringEvidence(initial, {
        candidate: initial.candidate,
        repository: fixture.repository,
        workspace: fixture.workspace,
      }),
    ).rejects.toThrow();

    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareAuthoringRevisionWorkspace({
        runId: RUN_ID,
        candidate0: initial,
        sourceWorkspace: fixture.workspace,
        repository: fixture.repository,
        sourceLedger: fixture.ledger,
        artifactDirectory: fixture.artifacts,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    await fixture.collector.dispose();
    await fixture.workspace.dispose();
  });

  it("rejects mutable or wrong-base substitutes at selected promotion", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    try {
      expect(Object.isFrozen(initial)).toBe(true);
      expect(Object.isFrozen(initial.evidence)).toBe(true);
      expect(Object.isFrozen(initial.evidence.files)).toBe(true);
      expect(Object.isFrozen(initial.snapshot)).toBe(true);
      expect(
        await materializeSelectedAuthoringEvidence(initial, {
          candidate: initial.candidate,
          repository: fixture.repository,
          workspace: fixture.workspace,
        }),
      ).toMatchObject({ patch: { sha256: initial.candidate.patchDigestSha256 } });
      expect(() => {
        (initial.evidence.files as { path: string }[])[0]!.path = "outside.md";
      }).toThrow();

      const substitutedFiles = {
        ...initial,
        evidence: {
          ...initial.evidence,
          files: [{ path: "outside.md", status: "added" as const }],
        },
      };
      await expect(
        materializeSelectedAuthoringEvidence(substitutedFiles, {
          candidate: initial.candidate,
          repository: fixture.repository,
          workspace: fixture.workspace,
        }),
      ).rejects.toThrow("host admission authority");

      const substitutedArtifact = {
        ...initial,
        evidence: {
          ...initial.evidence,
          patch: {
            ...initial.evidence.patch!,
            artifactPath: join(fixture.artifacts, "decoy.patch"),
          },
        },
      };
      await expect(
        materializeSelectedAuthoringEvidence(substitutedArtifact, {
          candidate: initial.candidate,
          repository: fixture.repository,
          workspace: fixture.workspace,
        }),
      ).rejects.toThrow("host admission authority");

      const wrongBase = createAuthoringCandidate({
        runId: initial.candidate.runId,
        ordinal: 0,
        originalRevision: "f".repeat(40),
        planDigest: initial.candidate.planDigest,
        writePaths: initial.candidate.writePaths,
        patchDigestSha256: initial.candidate.patchDigestSha256,
        patchBytes: initial.candidate.patchBytes,
        workspaceSnapshotDigest: initial.candidate.workspaceSnapshotDigest,
      });
      await expect(
        materializeSelectedAuthoringEvidence(
          { ...initial, candidate: wrongBase },
          { candidate: wrongBase, repository: fixture.repository, workspace: fixture.workspace },
        ),
      ).rejects.toThrow("host admission authority");
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("rejects rebound revision lifecycle handles before admission or partial capture", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    const child = await prepareChild(fixture, initial);
    try {
      expect(Object.isFrozen(child)).toBe(true);
      expect(Object.isFrozen(child.evidenceCollector)).toBe(false);

      const originalCandidate1 = await candidateForCurrentWorkspace(child, fixture);
      await expect(
        admitAuthoringCandidate1(
          child,
          originalCandidate1,
          { ...fixture.repository, requestedRevision: "HEAD" },
          fixture.ledger,
        ),
      ).rejects.toThrow("repository binding was substituted");
      await expect(
        admitAuthoringCandidate1(child, originalCandidate1, fixture.repository, {
          ...fixture.ledger,
          limitations: ["substituted"],
        }),
      ).rejects.toThrow("source ledger binding was substituted");

      const reboundRunId = "rebound-run";
      const reboundPlan = "c".repeat(64);
      const escapedPath = "docs/escaped.md";
      await writeFile(join(child.workspace.path, escapedPath), "escaped\n");
      const sealedRebound = await sealAuthoringCandidate({
        runId: reboundRunId,
        ordinal: 1,
        originalRevision: fixture.repository.revision,
        planDigest: reboundPlan,
        writePaths: [OUTPUT, escapedPath],
        workspace: child.workspace,
        repository: fixture.repository,
        evidenceCollector: child.evidenceCollector,
        sourceLedger: fixture.ledger,
      });
      const reboundCandidate0 = {
        ...initial,
        candidate: createAuthoringCandidate({
          runId: reboundRunId,
          ordinal: 0,
          originalRevision: fixture.repository.revision,
          planDigest: reboundPlan,
          writePaths: [OUTPUT, escapedPath],
          patchDigestSha256: initial.candidate.patchDigestSha256,
          patchBytes: initial.candidate.patchBytes,
          workspaceSnapshotDigest: initial.candidate.workspaceSnapshotDigest,
        }),
      };
      const rebound = {
        ...child,
        candidate0: reboundCandidate0,
        workspace: fixture.workspace,
        evidenceCollector: fixture.collector,
      } as AuthoringRevisionWorkspaceV1;

      expect(() => Object.assign(child, { candidate0: reboundCandidate0 })).toThrow();
      await expect(
        admitAuthoringCandidate1(
          rebound,
          sealedRebound.candidate,
          fixture.repository,
          fixture.ledger,
        ),
      ).rejects.toThrow("exact host lifecycle authority");
      await expect(captureFailedAuthoringPartial(rebound, fixture.repository)).rejects.toThrow(
        "exact host lifecycle authority",
      );
      await expect(
        materializeSelectedAuthoringEvidence(sealedRebound, {
          candidate: sealedRebound.candidate,
          repository: fixture.repository,
          workspace: child.workspace,
        }),
      ).rejects.toThrow("bound lifecycle admission");

      expect(await readFile(join(fixture.workspace.path, OUTPUT), "utf8")).toBe("# Candidate 0\n");
      await expect(lstat(join(fixture.workspace.path, escapedPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await child.dispose();
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("disposes the private child when collector cleanup fails", async () => {
    const fixture = await makeFixture();
    const initial = await makeCandidate0(fixture);
    const child = await prepareChild(fixture, initial);
    const childPath = child.workspace.path;
    const disposeCollector = child.evidenceCollector.dispose.bind(child.evidenceCollector);
    Object.defineProperty(child.evidenceCollector, "dispose", {
      configurable: true,
      value: async () => {
        throw new Error("forced collector cleanup failure");
      },
    });
    try {
      await expect(child.dispose()).rejects.toThrow("forced collector cleanup failure");
      await expect(lstat(childPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeCollector();
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("keeps ordinary collector artifacts on the legacy run.patch name", async () => {
    const workspace = await temporary.create("docsfab-ordinary-evidence-");
    const artifacts = await temporary.create("docsfab-ordinary-artifacts-");
    await writeFile(join(workspace, "README.md"), "ordinary\n");
    const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
    try {
      await writeFile(join(workspace, "ordinary.md"), "ordinary change\n");
      const evidence = await collector.capture({
        runId: "legacy-run",
        repository: {
          sourcePath: workspace,
          requestedRevision: "HEAD",
          revision: "a".repeat(40),
        },
        workspacePath: workspace,
        persistPatch: true,
      });
      expect(evidence.patch?.artifactPath).toMatch(/legacy-run\.patch$/u);
    } finally {
      await collector.dispose();
    }
  });
});

describe("authoring workspace host catalogued bounds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const CANDIDATE_0_PAGE_BYTES = Buffer.byteLength("# Candidate 0\n");

  it("refuses an oversized planned page at the candidate-0 copy by its catalogued code", async () => {
    const fixture = await makeFixture();
    try {
      const initial = await makeCandidate0(fixture);
      vi.stubEnv("DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES", String(CANDIDATE_0_PAGE_BYTES - 1));
      vi.mocked(readTrackedRepositoryFile).mockClear();
      const refusal = await prepareChild(fixture, initial).catch((error: unknown) => error);
      expectLimitRefusal(refusal, {
        name: "authoring.plannedPageMaxBytes",
        configured: CANDIDATE_0_PAGE_BYTES - 1,
        observed: CANDIDATE_0_PAGE_BYTES,
      });
      // The size comes from the sealed snapshot: no page byte was read.
      expect(pageReads()).toEqual([]);

      // A page exactly at the bound is copied.
      vi.stubEnv("DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES", String(CANDIDATE_0_PAGE_BYTES));
      const child = await prepareChild(fixture, initial);
      try {
        expect(await readFile(join(child.workspace.path, OUTPUT), "utf8")).toBe("# Candidate 0\n");
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("refuses an oversized planned page at the revision reset before touching the page", async () => {
    const fixture = await makeFixture();
    try {
      const initial = await makeCandidate0(fixture);
      const child = await prepareChild(fixture, initial);
      try {
        const page = join(child.workspace.path, OUTPUT);
        await writeFile(page, "# A partial revision\n");
        vi.stubEnv("DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES", String(CANDIDATE_0_PAGE_BYTES - 1));
        vi.mocked(readTrackedRepositoryFile).mockClear();
        const refusal = await resetAuthoringRevisionWorkspace(child, fixture.workspace).catch(
          (error: unknown) => error,
        );
        expectLimitRefusal(refusal, {
          name: "authoring.plannedPageMaxBytes",
          configured: CANDIDATE_0_PAGE_BYTES - 1,
          observed: CANDIDATE_0_PAGE_BYTES,
        });
        expect(await readFile(page, "utf8")).toBe("# A partial revision\n");
        expect(pageReads()).toEqual([]);

        vi.stubEnv("DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES", String(CANDIDATE_0_PAGE_BYTES));
        await resetAuthoringRevisionWorkspace(child, fixture.workspace);
        expect(await readFile(page, "utf8")).toBe("# Candidate 0\n");
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("restores no page of a multi-page plan when a later page is over the bound at the reset", async () => {
    const fixture = await makeFixture();
    try {
      const small = "docs/a.md";
      const large = "docs/z.md";
      const largeBytes = "# Z0 is the larger planned page\n";
      await mkdir(join(fixture.workspace.path, "docs"), { recursive: true });
      await writeFile(join(fixture.workspace.path, small), "# A0\n");
      await writeFile(join(fixture.workspace.path, large), largeBytes);
      const initial = await sealAuthoringCandidate({
        runId: RUN_ID,
        repository: fixture.repository,
        ordinal: 0,
        originalRevision: fixture.repository.revision,
        planDigest: PLAN,
        writePaths: [small, large],
        workspace: fixture.workspace,
        evidenceCollector: fixture.collector,
        sourceLedger: fixture.ledger,
      });
      expect(initial.candidate.writePaths).toEqual([small, large]);
      const child = await prepareChild(fixture, initial);
      try {
        await writeFile(join(child.workspace.path, small), "# A revised\n");
        vi.stubEnv("DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES", "10");
        expectLimitRefusal(
          await resetAuthoringRevisionWorkspace(child, fixture.workspace).catch(
            (error: unknown) => error,
          ),
          {
            name: "authoring.plannedPageMaxBytes",
            configured: 10,
            observed: Buffer.byteLength(largeBytes),
          },
        );
        // The earlier, in-bound page was not restored either.
        expect(await readFile(join(child.workspace.path, small), "utf8")).toBe("# A revised\n");
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  const ADMISSION = "repository.trackedWriteAdmissionMaxBytes";
  const ADMISSION_OVERRIDE = "DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_BYTES";
  /** A lowered admission bound, so the boundary pages stay a few bytes long. */
  const LOWERED_ADMISSION_BYTES = 64;

  it("declares the planned page bound and the tracked-write admission bound at 32 MiB together", () => {
    const page = limitDefinition("authoring.plannedPageMaxBytes");
    const admission = limitDefinition(ADMISSION);
    expect(admission.value).toBe(32 * 1024 * 1024);
    expect(admission.max).toBe(admission.value);
    expect(page.value).toBe(admission.value);
    expect(page.max).toBe(admission.max);
    expect(admission.override).toBe(ADMISSION_OVERRIDE);
  });

  it("captures and delivers the patch of a full rewrite of a page at the admission bound", () => {
    const admission = limitDefinition(ADMISSION).max;
    // A full rewrite removes and re-adds every line: both copies plus a +/- byte per line.
    // Lines averaging 8 bytes are far shorter than real Markdown.
    const rewritePatchBytes = 2 * admission + (2 * admission) / 8;
    expect(limitDefinition("repository.evidenceGitOutputMaxBytes").value).toBeGreaterThan(
      rewritePatchBytes,
    );
  });

  it("refuses a page over the tracked-write admission bound at the candidate-0 seal by its catalogued code", async () => {
    const fixture = await makeFixture();
    try {
      vi.stubEnv(ADMISSION_OVERRIDE, String(LOWERED_ADMISSION_BYTES));
      const page = join(fixture.workspace.path, OUTPUT);
      await mkdir(dirname(page), { recursive: true });
      await writeFile(page, Buffer.alloc(LOWERED_ADMISSION_BYTES + 1, "a"));
      expectLimitRefusal(await sealPlannedPage(fixture).catch((error: unknown) => error), {
        name: ADMISSION,
        configured: LOWERED_ADMISSION_BYTES,
        observed: LOWERED_ADMISSION_BYTES + 1,
      });

      // A page exactly at the bound is admitted and sealed.
      await writeFile(page, Buffer.alloc(LOWERED_ADMISSION_BYTES, "a"));
      await expect(sealPlannedPage(fixture, `${RUN_ID}-at-max`)).resolves.toBeDefined();

      // A lowering override of the planned page bound does not refuse at the
      // seal; it binds where the page is read into memory.
      vi.stubEnv("DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES", "4");
      await expect(makeCandidate0(fixture)).resolves.toBeDefined();
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("refuses a page over the tracked-write admission bound at the revised candidate's admission", async () => {
    const fixture = await makeFixture();
    try {
      const initial = await makeCandidate0(fixture);
      const child = await prepareChild(fixture, initial);
      try {
        const page = join(child.workspace.path, OUTPUT);
        await writeFile(page, "# Candidate 1\n");
        const candidate1 = await candidateForCurrentWorkspace(child, fixture);
        vi.stubEnv(ADMISSION_OVERRIDE, String(LOWERED_ADMISSION_BYTES));
        await writeFile(page, Buffer.alloc(LOWERED_ADMISSION_BYTES + 1, "a"));
        expectLimitRefusal(
          await admitAuthoringCandidate1(
            child,
            candidate1,
            fixture.repository,
            fixture.ledger,
          ).catch((error: unknown) => error),
          {
            name: ADMISSION,
            configured: LOWERED_ADMISSION_BYTES,
            observed: LOWERED_ADMISSION_BYTES + 1,
          },
        );
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("seals and copies a planned page above the former 8 MiB bound at the default bounds", {
    timeout: testTimeoutMs(LARGE_PAGE_CASE_MS),
  }, async () => {
    const fixture = await makeFixture();
    try {
      // One byte past the former 8 MiB bound, as 80-byte Markdown lines.
      const formerBound = 8 * 1024 * 1024;
      const line = `${"a".repeat(79)}\n`;
      const bytes = Buffer.alloc(formerBound + 1, line);
      const page = join(fixture.workspace.path, OUTPUT);
      await mkdir(dirname(page), { recursive: true });
      await writeFile(page, bytes);
      const initial = await sealPlannedPage(fixture);
      expect(initial.evidence.patch?.byteLength).toBeGreaterThan(formerBound);
      const child = await prepareChild(fixture, initial);
      try {
        expect((await readFile(join(child.workspace.path, OUTPUT))).equals(bytes)).toBe(true);
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("refuses a workspace snapshot over its entry or byte bound with the complete observation", async () => {
    const fixture = await makeFixture();
    try {
      const initial = await makeCandidate0(fixture);
      const { entries, totalBytes } = initial.snapshot;
      expect(totalBytes).toBeGreaterThan(CANDIDATE_0_PAGE_BYTES);

      vi.stubEnv("DOCSFAB_AUTHORING_WORKSPACE_SNAPSHOT_MAX_ENTRIES", String(entries.length - 1));
      expectLimitRefusal(await makeCandidate0(fixture).catch((error: unknown) => error), {
        name: "authoring.workspaceSnapshotMaxEntries",
        configured: entries.length - 1,
        observed: entries.length,
      });
      vi.stubEnv("DOCSFAB_AUTHORING_WORKSPACE_SNAPSHOT_MAX_ENTRIES", String(entries.length));
      await expect(makeCandidate0(fixture)).resolves.toBeDefined();

      // The first entry alone crosses this bound; the refusal still reports
      // the whole snapshot's bytes, not the running sum where it crossed.
      vi.stubEnv("DOCSFAB_AUTHORING_WORKSPACE_SNAPSHOT_MAX_BYTES", "1");
      expectLimitRefusal(await makeCandidate0(fixture).catch((error: unknown) => error), {
        name: "authoring.workspaceSnapshotMaxBytes",
        configured: 1,
        observed: totalBytes,
      });
      vi.stubEnv("DOCSFAB_AUTHORING_WORKSPACE_SNAPSHOT_MAX_BYTES", String(totalBytes));
      await expect(makeCandidate0(fixture)).resolves.toBeDefined();
    } finally {
      await fixture.collector.dispose();
      await fixture.workspace.dispose();
    }
  });

  it("refuses a retained patch over the sealed candidate patch bound before reading it", async () => {
    const bound = limit("authoring.candidatePatchMaxBytes");
    const missing = join(await temporary.create("docsfab-authoring-patch-bound-"), "absent.patch");
    expectLimitRefusal(
      await readImmutablePatchArtifact(missing, bound.value + 1, "c".repeat(64)).catch(
        (error: unknown) => error,
      ),
      { name: bound.name, configured: bound.value, observed: bound.value + 1 },
    );
    // At the bound the reader proceeds to the file, which is absent here.
    await expect(readImmutablePatchArtifact(missing, bound.value, "c".repeat(64))).rejects.toThrow(
      "changed after admission",
    );
  });
});

/** Planned pages the host read since the spy was last cleared; source reads excluded. */
function pageReads(): string[] {
  return vi
    .mocked(readTrackedRepositoryFile)
    .mock.calls.map(([, path]) => path)
    .filter((path) => path.startsWith("docs/"));
}

function expectLimitRefusal(
  refusal: unknown,
  expected: { name: string; configured: number; observed: number },
): void {
  const definition = limitDefinition(expected.name);
  expect(refusal).toBeInstanceOf(OperationalLimitError);
  expect(refusal).toMatchObject({
    code: definition.refusal,
    limitName: expected.name,
    configured: expected.configured,
    observed: expected.observed,
    unit: definition.unit,
  });
  const message = (refusal as Error).message;
  expect(message).toContain(`${expected.observed} exceeds ${expected.name}`);
  expect(message).toContain(definition.remediation);
  expect(definition.scope).toBe(
    expected.name === "authoring.candidatePatchMaxBytes" ? "sealed" : "per-run",
  );
}

async function makeCandidate0(fixture: Fixture): Promise<AuthoringCandidateCaptureV1> {
  await mkdir(dirname(join(fixture.workspace.path, OUTPUT)), { recursive: true });
  await writeFile(join(fixture.workspace.path, OUTPUT), "# Candidate 0\n");
  return sealPlannedPage(fixture);
}

/** Seal candidate 0 from whatever the workspace holds at the planned page. */
async function sealPlannedPage(
  fixture: Fixture,
  runId = RUN_ID,
): Promise<AuthoringCandidateCaptureV1> {
  return sealAuthoringCandidate({
    runId,
    repository: fixture.repository,
    ordinal: 0,
    originalRevision: fixture.repository.revision,
    planDigest: PLAN,
    writePaths: [OUTPUT],
    workspace: fixture.workspace,
    evidenceCollector: fixture.collector,
    sourceLedger: fixture.ledger,
  });
}

async function prepareChild(
  fixture: Fixture,
  candidate0: AuthoringCandidateCaptureV1,
  artifactDirectory = fixture.artifacts,
): Promise<AuthoringRevisionWorkspaceV1> {
  return prepareAuthoringRevisionWorkspace({
    runId: RUN_ID,
    candidate0,
    sourceWorkspace: fixture.workspace,
    repository: fixture.repository,
    sourceLedger: fixture.ledger,
    artifactDirectory,
  });
}

async function candidateForCurrentWorkspace(
  child: AuthoringRevisionWorkspaceV1,
  fixture: Fixture,
): Promise<AuthoringCandidateV1> {
  const sealed = await sealAuthoringCandidate({
    runId: RUN_ID,
    repository: fixture.repository,
    ordinal: 1,
    originalRevision: fixture.repository.revision,
    planDigest: PLAN,
    writePaths: [OUTPUT],
    workspace: child.workspace,
    evidenceCollector: child.evidenceCollector,
    sourceLedger: fixture.ledger,
  });
  return sealed.candidate;
}

interface Fixture {
  source: string;
  artifacts: string;
  repository: RepositoryTarget;
  workspace: RepositoryWorkspace;
  collector: GitPatchEvidenceCollector;
  ledger: SourceObligationLedgerV1;
}

async function makeFixture(): Promise<Fixture> {
  const source = await temporary.create("docsfab-authoring-source-");
  const artifacts = await temporary.create("docsfab-authoring-artifacts-");
  const revision = await initFixtureRepo(
    source,
    { "README.md": "# Fixture\n", [SOURCE]: "export const truth = 'source truth';\n" },
    { branch: "main" },
  );
  const sourceDigest = createHash("sha256")
    .update(await readFile(join(source, SOURCE)))
    .digest("hex");
  const repository = { sourcePath: source, requestedRevision: revision, revision };
  const workspace = await prepareRepositoryWorkspace(source, revision);
  const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
  const ledger = {
    kind: "docsfab-source-obligation-ledger" as const,
    schemaVersion: 1 as const,
    identity: {
      repositoryRevision: revision,
      scopeSha256: PLAN,
      sourceEvidenceSha256: SOURCE_EVIDENCE,
      workspaceSnapshotSha256: SOURCE_SNAPSHOT,
      sources: [{ path: SOURCE, sha256: sourceDigest }],
    },
    completeness: "bounded-not-proven" as const,
    dimensions: [],
    limitations: [],
    digest: "a".repeat(64),
  };
  return { source, artifacts, repository, workspace, collector, ledger };
}
