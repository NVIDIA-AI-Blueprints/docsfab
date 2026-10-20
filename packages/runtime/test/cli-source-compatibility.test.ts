// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as application from "../src/application/index.js";
import { parseRunArguments } from "../src/cli.js";
import {
  SOURCE_AWARE_WORKFLOWS,
  unsupportedSourceWorkflowRefusal,
} from "../src/cli/run-arguments.js";
import { runHelp } from "../src/cli/usage.js";
import { htmlSourceExtractorAdapter } from "../src/inputs/adapters/html.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import {
  acquireTrackedSourceBinding,
  SourceAcquisitionError,
  SOURCE_ACQUISITION_REFUSAL_CODES,
  TrackedSourceOversizeError,
  type TrackedSourceReaderV1,
} from "../src/inputs/source-acquisition.js";
import {
  createSourceExtractorRegistry,
  type SourceExtractorRegistryV1,
} from "../src/inputs/source-extraction.js";
import {
  classifySourceMediaType,
  createDefaultSourceExtractorRegistry,
  supportedSourceExtensions,
} from "../src/inputs/source-extractor-registry.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { executeWorkflowRun } from "../src/cli/run/execution.js";
import * as sourceAcquisition from "../src/cli/run/source-acquisition.js";
import { main } from "../src/cli/router.js";
import * as readerAdmission from "../src/execution/reader-task-admission.js";
import * as taskContext from "../src/execution/task-context.js";
import { MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION } from "../src/inputs/merged-mr-instruction.js";
import {
  projectSourceRequestContext,
  selectSourceRequestProjectionVersion,
  SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS,
} from "../src/inputs/source-evidence.js";
import * as qualityPack from "../src/quality-pack/manifest.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import * as trackedRead from "../src/repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import type { WorkflowBranchEvidenceHost } from "../src/workflow-contracts/contracts.js";
import * as editorialAssembly from "../src/workflow-execution/editorial-evidence-assembly.js";
import { getWorkflow, RUNNABLE_WORKFLOW_NAMES } from "../src/workflow-registry/catalog.js";
import { removeFixture, runtimeConfig } from "./support/execution-convergence.js";
import { createSourceFixture, HTML_SOURCE_PATH } from "./support/source-acquisition-cli.js";

/**
 * Ordinary UPDATE selectors and CREATE `--source` stay intact beside date-window
 * inference. Date-scoped UPDATE mints its `sourceBinding` later in execution, so
 * this file covers parse-time compatibility.
 */
describe("merged-MR UPDATE CLI source compatibility (#896)", () => {
  it("leaves ordinary UPDATE instructions on the explicit-input path", () => {
    const parsed = parseRunArguments([
      "update-documentation",
      "--instruction",
      "Update the authentication change across the overview.",
      "--reader-source",
      "current-documentation=docs/cli.md",
      "--comparison-workspace",
    ]);
    expect(parsed.mergedMrSelection).toBeUndefined();
    expect(parsed.readerSources).toEqual([{ role: "current-documentation", path: "docs/cli.md" }]);
    expect(parsed.comparisonRequest).toEqual({ kind: "workspace" });
  });

  it("keeps --source a tracked-file binding CREATE still accepts", () => {
    expect(
      parseRunArguments([
        "create-documentation",
        "--instruction",
        "Create docs/whats-new.md from the release notes.",
        "--source",
        "docs/release-notes.html",
      ]).sourcePaths,
    ).toEqual(["docs/release-notes.html"]);
  });
});

/**
 * `--source` admission on `update-documentation`. A workflow is supported when
 * its admitted run request is representable in the source-request projection.
 * Each case drives the shipped parser and asserts the operator-visible string.
 */
const UNSUPPORTED_WORKFLOW_REFUSAL =
  "--source is supported only for the create-documentation and update-documentation workflows. " +
  "Re-run the selected files under one of those workflows, or drop --source and run this workflow without bound sources.";

const RESUME_FROM_REFUSAL =
  "--source cannot be combined with --resume-from; a durable knowledge stop is not source-aware yet. " +
  "Run again without --resume-from to bind these sources on a fresh run, or resume the stopped run without --source.";

const UPDATE_INSTRUCTION = "Update the retention guide for the new export limits.";

/** Divergent ids: an identity collision between the two cannot fake a pass. */
const FIRST_SOURCE = "docs/zeta-release-notes.html";
const SECOND_SOURCE = "docs/alpha-migration.pdf";

function updateArgv(...extra: string[]): string[] {
  return ["update-documentation", "--instruction", UPDATE_INSTRUCTION, ...extra];
}

describe("docsfab run --source workflow admission (#798)", () => {
  it("accepts --source on update-documentation and carries every path in operator order", () => {
    const parsed = parseRunArguments(
      updateArgv("--source", FIRST_SOURCE, "--source", SECOND_SOURCE),
    );

    // Operator order: the reversed alphabet fails a sort-tolerant assertion.
    expect(parsed.sourcePaths).toEqual([FIRST_SOURCE, SECOND_SOURCE]);
    expect(parsed.workflow).toBe("update-documentation");
    expect(parsed.mergedMrSelection).toBeUndefined();
  });

  it("still refuses --source on review-documentation with the exact unsupported-workflow message", () => {
    expect(() =>
      parseRunArguments(["review-documentation", "--source", FIRST_SOURCE]),
    ).toThrowError(UNSUPPORTED_WORKFLOW_REFUSAL);

    // The message renders the shipped set, so the literal and parser cannot disagree.
    expect(unsupportedSourceWorkflowRefusal()).toBe(UNSUPPORTED_WORKFLOW_REFUSAL);
    for (const workflow of SOURCE_AWARE_WORKFLOWS) {
      expect(UNSUPPORTED_WORKFLOW_REFUSAL).toContain(workflow);
    }
    expect(
      unsupportedSourceWorkflowRefusal([...SOURCE_AWARE_WORKFLOWS, "restructure-documentation"]),
    ).toContain("create-documentation, update-documentation and restructure-documentation");

    // Derived from the shipped registry minus the supported set, so a workflow
    // added to either list is covered here.
    const unsupported = RUNNABLE_WORKFLOW_NAMES.filter(
      (name) => !(SOURCE_AWARE_WORKFLOWS as readonly string[]).includes(name),
    );
    expect(unsupported).toContain("review-documentation");
    for (const workflow of unsupported) {
      const argv =
        workflow === "review-documentation"
          ? [workflow]
          : [workflow, "--instruction", UPDATE_INSTRUCTION];
      expect(() => parseRunArguments([...argv, "--source", FIRST_SOURCE])).toThrowError(
        UNSUPPORTED_WORKFLOW_REFUSAL,
      );
    }

    // Positive control: the refusal above is the gate, not an unrelated parse failure.
    for (const workflow of SOURCE_AWARE_WORKFLOWS) {
      expect(
        parseRunArguments([workflow, "--instruction", UPDATE_INSTRUCTION, "--source", FIRST_SOURCE])
          .sourcePaths,
      ).toEqual([FIRST_SOURCE]);
    }
  });

  it("still refuses --source combined with --resume-from", () => {
    expect(() =>
      parseRunArguments([
        "update-documentation",
        "--resume-from",
        "stopped-run-798b",
        "--canon-snapshot",
        "snapshot.json",
        "--allow-write",
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator",
        "--source",
        FIRST_SOURCE,
      ]),
    ).toThrowError(RESUME_FROM_REFUSAL);

    expect(RESUME_FROM_REFUSAL).toContain("cannot be combined with --resume-from");
    expect(RESUME_FROM_REFUSAL).toContain("Run again without --resume-from");
    expect(RESUME_FROM_REFUSAL).toContain("resume the stopped run without --source");

    expect(
      parseRunArguments([
        "update-documentation",
        "--resume-from",
        "stopped-run-798b",
        "--canon-snapshot",
        "snapshot.json",
        "--allow-write",
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator",
      ]).resumeFrom,
    ).toBe("stopped-run-798b");
  });

  it("still refuses two --source options naming the same repository-relative path", () => {
    expect(() =>
      parseRunArguments(updateArgv("--source", FIRST_SOURCE, "--source", FIRST_SOURCE)),
    ).toThrowError(
      "Every --source option must name a distinct repository-relative path for this run.",
    );

    expect(
      parseRunArguments(updateArgv("--source", FIRST_SOURCE, "--source", SECOND_SOURCE))
        .sourcePaths,
    ).toEqual([FIRST_SOURCE, SECOND_SOURCE]);
  });

  it("refuses --source beside a date-scoped merged-MR update instruction", () => {
    // One run binds one source binding, and a date-scoped update mints its own;
    // admitting both would drop one from the evidence writer and verifier share.
    expect(() =>
      parseRunArguments([
        "update-documentation",
        "--instruction",
        MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        "--source",
        FIRST_SOURCE,
      ]),
    ).toThrowError(
      "A date-scoped merged-MR update mints its source binding from the merge requests the instruction names. " +
        "Do not combine it with --source; drop --source, or restate the instruction without the merged-MR date window. " +
        "Merge-request evidence is due to arrive through its own source selector, which will not require this choice.",
    );

    // Positive controls on both sides of the refusal.
    expect(
      parseRunArguments([
        "update-documentation",
        "--instruction",
        MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
      ]).mergedMrSelection,
    ).toBeDefined();
    expect(parseRunArguments(updateArgv("--source", FIRST_SOURCE)).sourcePaths).toEqual([
      FIRST_SOURCE,
    ]);
  });
});

const PROJECTION_RESOLVED = {
  runId: "run-798b-update-7f3c",
  workspaceIdentitySha256: `7f3c${"9".repeat(60)}`,
  repository: { identitySha256: `2b81${"a".repeat(60)}`, revision: `5d0e${"1".repeat(36)}` },
};

/** An admitted UPDATE request shape, with version-2 keys as the CLI sets them. */
function updateAdmittedRequest(): Record<string, unknown> {
  return {
    signal: undefined,
    runId: PROJECTION_RESOLVED.runId,
    workflow: "update-documentation",
    workspacePath: "/tmp/docsfab-798b-workspace",
    repository: PROJECTION_RESOLVED.repository,
    instruction: UPDATE_INSTRUCTION,
    readerContextInput: { schema_version: 1, reader_job: UPDATE_INSTRUCTION },
    readerTaskContext: { kind: "docsfab-reader-task-context-input" },
    editorialEvidenceRefs: [],
    allowWrite: true,
  };
}

describe("docsfab run --source update request projection (#798)", () => {
  it("keeps the selection out of the projected request and still refuses a version-1 pin", () => {
    const request = updateAdmittedRequest();
    const before = projectSourceRequestContext({ ...request }, PROJECTION_RESOLVED);

    const withFlag = parseRunArguments(updateArgv("--source", SECOND_SOURCE));
    const withoutFlag = parseRunArguments(updateArgv());

    // The flag enters nothing the projection reads, so a no-source update run
    // keeps its digest.
    expect(withFlag.sourcePaths).toEqual([SECOND_SOURCE]);
    expect(Object.hasOwn(withoutFlag, "sourcePaths")).toBe(false);
    expect(projectSourceRequestContext({ ...request }, PROJECTION_RESOLVED)).toBe(before);

    // Control: the digest is sensitive, so the equality above is not vacuous.
    expect(
      projectSourceRequestContext(
        { ...request, instruction: `${UPDATE_INSTRUCTION} Also cover the export retries.` },
        PROJECTION_RESOLVED,
      ),
    ).not.toBe(before);

    // A leaked selection fails closed: the projection rejects unrecognized fields.
    expect(() =>
      projectSourceRequestContext(
        { ...request, sourcePaths: [SECOND_SOURCE] },
        PROJECTION_RESOLVED,
      ),
    ).toThrowError("Source-evidence contract rejected: projection-unversioned.");

    // Only version 2 represents the update run; pinning version 1 still refuses it.
    expect(selectSourceRequestProjectionVersion(request)).toBe(2);
    expect(() =>
      projectSourceRequestContext({ ...request }, PROJECTION_RESOLVED, { projectionVersion: 1 }),
    ).toThrowError("Source-evidence contract rejected: projection-unversioned.");
  });

  it("treats an undefined-valued version-2 key as present, so producers must omit it", () => {
    // Version selection keys on key presence, so the producer boundary below is
    // asserted to carry no present-but-undefined version-2 key.
    const versionOneShape = {
      runId: PROJECTION_RESOLVED.runId,
      workflow: "update-documentation",
      repository: PROJECTION_RESOLVED.repository,
      instruction: UPDATE_INSTRUCTION,
      allowWrite: true,
    };
    expect(selectSourceRequestProjectionVersion(versionOneShape)).toBe(1);
    for (const field of SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS) {
      expect(selectSourceRequestProjectionVersion({ ...versionOneShape, [field]: undefined })).toBe(
        2,
      );
    }

    // On real digests: an explicit-undefined key and an absent key are different
    // requests, so a JSON round trip would not verify against the same binding.
    const absentKeyDigest = projectSourceRequestContext(
      { ...versionOneShape, workspacePath: "/tmp/docsfab-798b-workspace", signal: undefined },
      PROJECTION_RESOLVED,
    );
    for (const field of SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS) {
      expect(
        projectSourceRequestContext(
          {
            ...versionOneShape,
            workspacePath: "/tmp/docsfab-798b-workspace",
            signal: undefined,
            [field]: undefined,
          },
          PROJECTION_RESOLVED,
        ),
      ).not.toBe(absentKeyDigest);
    }
  });
});

const PROBE_MAX_BYTES = 4096;

/**
 * Counts every tracked-source body read the CLI could make.
 *
 * `readTrackedBytes` is the method that opens a body. The file-layer spy on
 * `readTrackedRepositoryFile` also catches the reader the acquisition producer
 * builds inside its own module, where an exported-symbol spy does not reach.
 */
function installSourceBodyProbe() {
  const readTrackedBytesCalls: string[] = [];
  const trackedFileReads: string[] = [];
  const createReader = sourceAcquisition.createWorkspaceTrackedSourceReader;
  vi.spyOn(trackedRead, "readTrackedRepositoryFile").mockImplementation(
    async (_workspace: unknown, path: string) => {
      trackedFileReads.push(path);
      return Buffer.from("probe body");
    },
  );
  vi.spyOn(sourceAcquisition, "createWorkspaceTrackedSourceReader").mockImplementation(
    (workspace: RepositoryWorkspace) => {
      const reader = createReader(workspace);
      return {
        isTrackedRegularFile: (path: string) => reader.isTrackedRegularFile(path),
        readTrackedBytes: (path: string, maxBytes: number) => {
          readTrackedBytesCalls.push(path);
          return reader.readTrackedBytes(path, maxBytes);
        },
      };
    },
  );
  const acquire = vi.spyOn(sourceAcquisition, "resolveCliSourceEvidence");
  return {
    readTrackedBytesCalls,
    trackedFileReads,
    acquire,
    /** Proves the counters observe a real `readTrackedBytes` call. */
    async control(workspace: RepositoryWorkspace): Promise<void> {
      const reader = sourceAcquisition.createWorkspaceTrackedSourceReader(workspace);
      await reader.readTrackedBytes(HTML_SOURCE_PATH, PROBE_MAX_BYTES);
    },
    reset(): void {
      readTrackedBytesCalls.length = 0;
      trackedFileReads.length = 0;
    },
  };
}

describe("docsfab run --source update preview paths (#798)", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it("opens no source body under --dry-run on an update run", async () => {
    const fixture = await createSourceFixture();
    roots.push(fixture.root);
    const probe = installSourceBodyProbe();
    const workspace = {
      path: fixture.repository,
      sourcePath: fixture.repository,
      requestedRevision: fixture.revision,
      revision: fixture.revision,
    } as unknown as RepositoryWorkspace;

    await probe.control(workspace);
    expect(probe.readTrackedBytesCalls).toEqual([HTML_SOURCE_PATH]);
    expect(probe.trackedFileReads).toEqual([HTML_SOURCE_PATH]);
    probe.reset();

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logged.push(String(value));
    });
    const parsed = parseRunArguments([
      "update-documentation",
      "--instruction",
      UPDATE_INSTRUCTION,
      "--repo",
      fixture.repository,
      "--revision",
      fixture.revision,
      "--source",
      HTML_SOURCE_PATH,
      "--dry-run",
    ]);

    const result = await executeRunRequest(parsed, runtimeConfig(fixture.stateDirectory), {
      silent: true,
    });

    expect(parsed.sourcePaths).toEqual([HTML_SOURCE_PATH]);
    expect(result).toBeUndefined();
    // Internal silent mode suppresses the preview as well as run output.
    expect(logged).toEqual([]);
    expect(probe.readTrackedBytesCalls).toEqual([]);
    expect(probe.trackedFileReads).toEqual([]);
    expect(probe.acquire).not.toHaveBeenCalled();
  }, 30_000);

  it("opens no source body under --route-only on an update run", async () => {
    const fixture = await createSourceFixture();
    roots.push(fixture.root);
    const probe = installSourceBodyProbe();
    const workspace = {
      path: fixture.repository,
      sourcePath: fixture.repository,
      requestedRevision: fixture.revision,
      revision: fixture.revision,
    } as unknown as RepositoryWorkspace;

    await probe.control(workspace);
    expect(probe.readTrackedBytesCalls).toEqual([HTML_SOURCE_PATH]);
    probe.reset();

    const logged: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logged.push(String(value));
    });
    vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      errors.push(String(value));
    });
    const originalArgv = process.argv;
    const routeOnly = (...extra: string[]) => [
      originalArgv[0]!,
      originalArgv[1]!,
      "do",
      "Update the retention guide because the export limits changed for operators.",
      "--route-only",
      "--repo",
      fixture.repository,
      ...extra,
    ];

    process.argv = routeOnly();
    try {
      await main();
    } finally {
      process.argv = originalArgv;
    }

    expect(logged.join("\n")).toContain("update-documentation");
    expect(process.exitCode ?? 0).toBe(0);
    expect(probe.readTrackedBytesCalls).toEqual([]);
    expect(probe.trackedFileReads).toEqual([]);
    expect(probe.acquire).not.toHaveBeenCalled();

    // `do` admits a source selection: classification parses it and still opens
    // nothing. The probe's control shows these calls fire on a real body read.
    logged.length = 0;
    process.argv = routeOnly("--source", HTML_SOURCE_PATH);
    try {
      await main();
    } finally {
      process.argv = originalArgv;
    }
    expect(logged.join("\n")).toContain("update-documentation");
    expect(errors).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(probe.readTrackedBytesCalls).toEqual([]);
    expect(probe.trackedFileReads).toEqual([]);
    expect(probe.acquire).not.toHaveBeenCalled();
    process.exitCode = undefined;
  }, 30_000);
});

const SEAM_REVISION = "3c".repeat(20);
const SEAM_HASH = "8e".repeat(32);
const SEAM_SOURCE_HASH = "6a".repeat(32);

describe("docsfab run --source update execution seam (#798)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drives workflowBranchEvidence through executeWorkflowRun", async () => {
    const workflowBranchEvidence = sentinelBranchEvidence();
    const captured: {
      services: {
        workflowBranchEvidence?: unknown;
        sourceEvidence?: unknown;
        retainedEvidenceBindings?: unknown;
      }[];
      requests: Record<string, unknown>[];
    } = { services: [], requests: [] };
    const seam = stubUpdateSeam({ captured, workflowBranchEvidence });

    const result = await withCliWorkspace(async (workspace) =>
      executeWorkflowRun(
        cliInvocation([FIRST_SOURCE, SECOND_SOURCE]),
        workspace,
        {} as never,
        {
          workflow: getWorkflow("update-documentation"),
          contentIndex: { schemaVersion: 1, nodes: [] },
        } as never,
        {} as never,
      ),
    );

    expect(captured.services).toHaveLength(1);
    expect(captured.services[0]?.workflowBranchEvidence).toBe(workflowBranchEvidence);
    expect(captured.services[0]?.sourceEvidence).toBe(seam.runnerBinding);
    expect(captured.services[0]?.retainedEvidenceBindings).toMatchObject({
      kind: "docsfab-retained-evidence-bindings",
      sources: expect.arrayContaining([
        {
          path: FIRST_SOURCE,
          sha256: createHash("sha256").update("<p>zeta source</p>\n").digest("hex"),
        },
        {
          path: SECOND_SOURCE,
          sha256: createHash("sha256").update("alpha source fixture bytes\n").digest("hex"),
        },
      ]),
    });
    expect(captured.requests[0]?.sourceBinding).toBe(seam.reference);
    expect(result.editorialDecodeOptions).toEqual(
      expect.objectContaining({
        decodeEditorialDecision: expect.any(Function),
        decodeWorkflowBranchCoverage: expect.any(Function),
      }),
    );
    // Partial `acquired: {}` from the producer stub must not abort after the
    // workflow has already succeeded, and must not invent overflow evidence.
    expect(result.limitOverflowEvidence).toBeUndefined();

    expect(seam.acquisitions).toHaveLength(1);
    const acquisition = seam.acquisitions[0]!;
    expect(acquisition.sourcePaths).toEqual([FIRST_SOURCE, SECOND_SOURCE]);
    expect(acquisition.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(acquisition.admittedRequest.runId).toBe(acquisition.runId);
    expect(captured.requests[0]?.runId).toBe(acquisition.runId);
  });

  it("hands the producer an update request the shipped projection can represent", async () => {
    const captured: {
      services: { workflowBranchEvidence?: unknown; sourceEvidence?: unknown }[];
      requests: Record<string, unknown>[];
    } = { services: [], requests: [] };
    const seam = stubUpdateSeam({ captured });

    await withCliWorkspace((workspace) =>
      executeWorkflowRun(
        cliInvocation([FIRST_SOURCE]),
        workspace,
        {} as never,
        {
          workflow: getWorkflow("update-documentation"),
          contentIndex: { schemaVersion: 1, nodes: [] },
        } as never,
        {} as never,
      ),
    );

    const admitted = seam.acquisitions[0]!.admittedRequest;
    // Key presence is the version discriminant: no undefined-valued version-2 key.
    const present = SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS.filter((field) =>
      Object.hasOwn(admitted, field),
    );
    const undefinedValued = present.filter((field) => admitted[field] === undefined);
    expect(present.length).toBeGreaterThan(0);
    expect(undefinedValued).toEqual([]);

    expect(Object.hasOwn(admitted, "sourcePaths")).toBe(false);

    // Without the version-2 projection this request fails closed as unprojectable.
    expect(selectSourceRequestProjectionVersion(admitted)).toBe(2);
    expect(
      projectSourceRequestContext(admitted, {
        runId: String(admitted.runId),
        workspaceIdentitySha256: PROJECTION_RESOLVED.workspaceIdentitySha256,
        repository: PROJECTION_RESOLVED.repository,
      }),
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("projects an update request that pairs --source with --revision and --comparison-base", async () => {
    const BASE_REVISION = "5d".repeat(20);
    const parsed = parseRunArguments([
      "update-documentation",
      "--instruction",
      UPDATE_INSTRUCTION,
      "--source",
      FIRST_SOURCE,
      "--revision",
      SEAM_REVISION,
      "--comparison-base",
      BASE_REVISION,
    ]);
    expect(parsed.comparisonRequest).toEqual({
      kind: "base-head",
      baseRevision: BASE_REVISION,
      headRevision: SEAM_REVISION,
    });
    const captured: {
      services: { workflowBranchEvidence?: unknown; sourceEvidence?: unknown }[];
      requests: Record<string, unknown>[];
    } = { services: [], requests: [] };
    const seam = stubUpdateSeam({ captured });
    const invocation = cliInvocation([FIRST_SOURCE]) as unknown as {
      request: Record<string, unknown>;
    };
    invocation.request.comparisonRequest = parsed.comparisonRequest;

    await withCliWorkspace((workspace) =>
      executeWorkflowRun(
        invocation as never,
        workspace,
        {} as never,
        {
          workflow: getWorkflow("update-documentation"),
          contentIndex: { schemaVersion: 1, nodes: [] },
        } as never,
        {} as never,
      ),
    );

    const admitted = seam.acquisitions[0]!.admittedRequest;
    // The operator's comparison is retained on the admitted request, so the
    // source binding must commit to it rather than refuse it as unknown.
    expect(admitted.readerEvidenceRequest).toEqual({
      comparisonRequest: parsed.comparisonRequest,
    });
    const resolved = {
      runId: String(admitted.runId),
      workspaceIdentitySha256: PROJECTION_RESOLVED.workspaceIdentitySha256,
      repository: PROJECTION_RESOLVED.repository,
    };
    const digest = projectSourceRequestContext(admitted, resolved);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(selectSourceRequestProjectionVersion(admitted)).toBe(4);
    // The comparison is part of the commitment: another base moves the digest.
    expect(
      projectSourceRequestContext(
        {
          ...admitted,
          readerEvidenceRequest: {
            comparisonRequest: { ...parsed.comparisonRequest!, baseRevision: "7e".repeat(20) },
          },
        },
        resolved,
      ),
    ).not.toBe(digest);
    // Pinning an older version still refuses, and names the field it cannot represent.
    for (const projectionVersion of [2, 3]) {
      expect(() => projectSourceRequestContext(admitted, resolved, { projectionVersion })).toThrow(
        /projection-unversioned\. Field request\.readerEvidenceRequest: /u,
      );
    }
  });

  it("binds a committed diff for an update request that pairs --source with --revision and --comparison-base", async () => {
    // Captured before the seam stub replaces it, so the bind below is the shipped one.
    const shippedResolve = sourceAcquisition.resolveCliSourceEvidence;
    const DIFF_SOURCE = "changes/export-limit.diff";
    const BASE_REVISION = "5d".repeat(20);
    const parsed = parseRunArguments([
      "update-documentation",
      "--instruction",
      UPDATE_INSTRUCTION,
      "--source",
      DIFF_SOURCE,
      "--revision",
      SEAM_REVISION,
      "--comparison-base",
      BASE_REVISION,
    ]);
    expect(parsed.sourcePaths).toEqual([DIFF_SOURCE]);
    const captured: {
      services: { workflowBranchEvidence?: unknown; sourceEvidence?: unknown }[];
      requests: Record<string, unknown>[];
    } = { services: [], requests: [] };
    const seam = stubUpdateSeam({ captured });
    const invocation = cliInvocation([DIFF_SOURCE]) as unknown as {
      request: Record<string, unknown>;
    };
    invocation.request.comparisonRequest = parsed.comparisonRequest;
    await withCliWorkspace(
      async (workspace) => {
        await executeWorkflowRun(
          invocation as never,
          workspace,
          {} as never,
          {
            workflow: getWorkflow("update-documentation"),
            contentIndex: { schemaVersion: 1, nodes: [] },
          } as never,
          {} as never,
        );
        const admitted = seam.acquisitions[0]!.admittedRequest;
        expect(admitted.readerEvidenceRequest).toEqual({
          comparisonRequest: parsed.comparisonRequest,
        });

        // The admitted request, comparison included, binds a real committed diff.
        const bound = await shippedResolve({
          workspace,
          sourcePaths: parsed.sourcePaths!,
          admittedRequest: admitted,
          runId: String(admitted.runId),
        });
        const [acquired] = bound.acquired.acquired;
        expect(acquired!.observation.original.mediaType).toBe("text/x-diff");
        expect(acquired!.representation.spans.map((span) => span.locator)).toMatchObject([
          { kind: "diff", part: "manifest" },
          { kind: "diff", part: "header", fileOrdinal: 1, newPath: "src/export.ts", hunkCount: 1 },
          { kind: "diff", part: "hunk", fileOrdinal: 1, hunkOrdinal: 1, oldStart: 1, newStart: 1 },
        ]);
        // The binding commits to the comparison: another base would not match it.
        expect(selectSourceRequestProjectionVersion(admitted)).toBe(4);
        const resolved = {
          runId: String(admitted.runId),
          workspaceIdentitySha256: bound.runnerBinding.workspaceIdentitySha256,
          repository: bound.acquired.binding.repository,
        };
        expect(bound.acquired.binding.requestSha256).toBe(
          projectSourceRequestContext(admitted, resolved),
        );
        expect(bound.acquired.binding.requestSha256).not.toBe(
          projectSourceRequestContext(
            {
              ...admitted,
              readerEvidenceRequest: {
                comparisonRequest: { ...parsed.comparisonRequest!, baseRevision: "7e".repeat(20) },
              },
            },
            resolved,
          ),
        );
      },
      {
        [DIFF_SOURCE]: [
          "diff --git a/src/export.ts b/src/export.ts",
          "--- a/src/export.ts",
          "+++ b/src/export.ts",
          "@@ -1 +1 @@",
          "-const limit = 100;",
          "+const limit = 500;",
          "",
        ].join("\n"),
      },
    );
  }, 120_000);

  it("hands the producer a create request that carries no version-2 key at all", async () => {
    // The at-risk shape: a create request stays at version 1 to keep its
    // digests, so a key leaked as `undefined` moves it to version 2.
    const captured: {
      services: { workflowBranchEvidence?: unknown; sourceEvidence?: unknown }[];
      requests: Record<string, unknown>[];
    } = { services: [], requests: [] };
    const seam = stubUpdateSeam({ captured });

    await withCliWorkspace((workspace) =>
      executeWorkflowRun(
        cliInvocation([FIRST_SOURCE], "create-documentation"),
        workspace,
        {} as never,
        {
          workflow: getWorkflow("create-documentation"),
          contentIndex: { schemaVersion: 1, nodes: [] },
        } as never,
        {} as never,
      ),
    );

    const admitted = seam.acquisitions[0]!.admittedRequest;
    const present = SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS.filter((field) =>
      Object.hasOwn(admitted, field),
    );
    expect(present).toEqual([]);
    expect(selectSourceRequestProjectionVersion(admitted)).toBe(1);

    expect(
      projectSourceRequestContext(
        admitted,
        {
          runId: String(admitted.runId),
          workspaceIdentitySha256: PROJECTION_RESOLVED.workspaceIdentitySha256,
          repository: PROJECTION_RESOLVED.repository,
        },
        { projectionVersion: 1 },
      ),
    ).toMatch(/^[a-f0-9]{64}$/u);

    // Control: one v2 key present, even as undefined, selects version 2.
    expect(
      selectSourceRequestProjectionVersion({
        ...admitted,
        [SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS[0]!]: undefined,
      }),
    ).toBe(2);
  });
});

function stubUpdateSeam(input: {
  captured: {
    services: { workflowBranchEvidence?: unknown; sourceEvidence?: unknown }[];
    requests: Record<string, unknown>[];
  };
  workflowBranchEvidence?: WorkflowBranchEvidenceHost;
}) {
  const acquisitions: {
    sourcePaths: readonly string[];
    runId: string;
    admittedRequest: Record<string, unknown>;
  }[] = [];
  const reference = { kind: "source-binding", fixture: "798b-reference" };
  const runnerBinding = { fixture: "798b-runner-binding" };
  vi.spyOn(qualityPack, "verifyQualityPackContext").mockResolvedValue({ evidence: {} } as never);
  vi.spyOn(taskContext, "createStyleTaskContext").mockResolvedValue({ prompt: "" } as never);
  vi.spyOn(taskContext, "conservativeReaderContextInput").mockImplementation(
    ({ instruction }: { instruction: string }) => seamReaderContextInput(instruction) as never,
  );
  vi.spyOn(taskContext, "createReaderTaskContextSupplier").mockResolvedValue({
    validateHandoff: (value: unknown) => value,
    projectInput: (value: unknown) => ({
      schemaVersion: 1,
      kind: "docsfab-reader-task-context-input",
      inputOrigin: "conservative-fallback",
      noChangeAssessment: "ineligible",
      readerContextInput: value,
      baseline: { path: "docs/retention.md", sha256: SEAM_HASH, content: "baseline" },
      policy: { id: "policy", version: "v1", sha256: SEAM_HASH },
      prompt: "input",
    }),
  } as never);
  vi.spyOn(readerAdmission, "observeReaderTaskContextAdmissionV1").mockResolvedValue({
    admission: {
      admittedRevision: SEAM_REVISION,
      workspaceSnapshotSha256: SEAM_HASH,
      repositoryIdentitySha256: SEAM_HASH,
      comparison: {
        kind: "base-head",
        base_revision: SEAM_REVISION,
        head_revision: SEAM_REVISION,
      },
      sources: [
        { uri: "docs/retention.md", role: "current-documentation", sha256: SEAM_SOURCE_HASH },
      ],
      provenanceLimitations: ["changed-source-not-applicable-identical-revisions"],
    },
    sourceBytes: [],
    changedPaths: [],
  } as never);
  vi.spyOn(editorialAssembly, "assembleEditorialEvidenceFromAdmissionV1").mockResolvedValue({
    readerTaskContext: {},
    observation: {},
    editorialEvidenceRefs: [],
    workflowBranchEvidence: input.workflowBranchEvidence ?? sentinelBranchEvidence(),
  } as never);
  vi.spyOn(sourceAcquisition, "resolveCliSourceEvidence").mockImplementation(
    async (acquisition: {
      sourcePaths: readonly string[];
      runId: string;
      admittedRequest: Record<string, unknown>;
    }) => {
      acquisitions.push({
        sourcePaths: acquisition.sourcePaths,
        runId: acquisition.runId,
        admittedRequest: acquisition.admittedRequest,
      });
      return { reference, runnerBinding, acquired: {} } as never;
    },
  );
  vi.spyOn(application, "createLocalWorkflowApplicationServices").mockResolvedValue({
    services: { harness: { runStep: async () => ({ summary: "fixture" }) } },
  } as never);
  vi.spyOn(application, "executeWorkflowApplication").mockImplementation(async (applied) => {
    input.captured.services.push(applied.services as never);
    input.captured.requests.push(applied.request as unknown as Record<string, unknown>);
    return {
      id: "cli-798b-update",
      workflow: "update-documentation",
      status: "succeeded",
      steps: [],
    } as never;
  });
  return { acquisitions, reference, runnerBinding };
}

function cliInvocation(
  sourcePaths: readonly string[],
  workflow: "create-documentation" | "update-documentation" = "update-documentation",
) {
  return {
    request: {
      workflow,
      instruction: UPDATE_INSTRUCTION,
      allowWrite: false,
      sourcePaths,
    },
    config: {
      skillCrateDirectory: "/fixture/skills",
      qualityDirectory: "/fixture/quality",
      qualityPackDirectory: "/fixture/quality-pack",
      stateDirectory: "/fixture/runs",
      model: {},
      retryPolicy: {},
    },
    options: {
      quiet: true,
      executionHarness: { runStep: async () => ({ summary: "fixture" }) },
      skillResolver: { resolveSkill: async () => ({ id: "fixture", contentSha256: SEAM_HASH }) },
    },
    output: { log: vi.fn(), error: vi.fn() },
  } as never;
}

async function withCliWorkspace<T>(
  run: (workspace: RepositoryWorkspace) => Promise<T>,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<T> {
  const fixture = await createSourceFixture({
    [FIRST_SOURCE]: "<p>zeta source</p>\n",
    [SECOND_SOURCE]: "alpha source fixture bytes\n",
    ...extraFiles,
  });
  const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
  try {
    return await run(workspace);
  } finally {
    await workspace.dispose();
    await removeFixture(fixture.root);
  }
}

function seamReaderContextInput(instruction: string) {
  return {
    schema_version: 1 as const,
    target_audience: "documentation readers",
    reader_job: instruction,
    change_scope: ["docs/retention.md"],
    source_priority: ["request", "current documentation", "public contract"],
    required_content: [instruction],
    excluded_content: ["unrelated content"],
    unresolved_questions: ["Confirm the independently observed impact."],
    known_limitations: ["No independent impact decision exists yet."],
  };
}

function sentinelBranchEvidence(): WorkflowBranchEvidenceHost {
  const fail = async () => {
    throw new Error("sentinel workflowBranchEvidence must not run");
  };
  return {
    select: fail,
    observeAssessment: fail,
    finalize: fail,
    decodeEditorialDecision: () => {
      throw new Error("sentinel workflowBranchEvidence must not run");
    },
  } as unknown as WorkflowBranchEvidenceHost;
}

/**
 * The supported set is a product decision, pinned so widening it is a reviewed
 * change rather than a silent one.
 */
describe("docsfab run --source supported set (#798)", () => {
  it("admits exactly the two workflows the product decision names", () => {
    expect([...SOURCE_AWARE_WORKFLOWS]).toEqual(["create-documentation", "update-documentation"]);

    // Executed, not read from the same list: every runnable workflow is tried.
    const admitted = RUNNABLE_WORKFLOW_NAMES.filter((workflow) => {
      try {
        parseRunArguments([
          workflow,
          "--instruction",
          UPDATE_INSTRUCTION,
          "--source",
          FIRST_SOURCE,
        ]);
        return true;
      } catch {
        return false;
      }
    });
    expect(admitted).toEqual([...SOURCE_AWARE_WORKFLOWS]);
  });
});

const PRODUCER_REPOSITORY = {
  identitySha256: createHash("sha256").update("/tmp/docsfab-798b-producer").digest("hex"),
  revision: "9f".repeat(20),
};
const PRODUCER_RUN_ID_SHA = createHash("sha256").update("798b-producer-run", "utf8").digest("hex");
const PRODUCER_REQUEST_SHA = createHash("sha256")
  .update("798b-producer-request", "utf8")
  .digest("hex");
const PRODUCER_POLICY_SHA = createHash("sha256")
  .update("798b-producer-policy", "utf8")
  .digest("hex");

function producerReader(files: Record<string, string>): TrackedSourceReaderV1 {
  return {
    async isTrackedRegularFile(path) {
      return Object.hasOwn(files, path);
    },
    async readTrackedBytes(path, maxBytes) {
      const bytes = new TextEncoder().encode(files[path] ?? "");
      if (bytes.byteLength > maxBytes) throw new TrackedSourceOversizeError(path, bytes.byteLength);
      return bytes;
    },
  };
}

function acquireThrough(
  files: Record<string, string>,
  selection: readonly string[],
  limits?: { maxOriginalBytes: number },
  registry?: SourceExtractorRegistryV1,
) {
  return acquireTrackedSourceBinding({
    ...(registry ? { registry } : {}),
    reader: producerReader(files),
    externalInputs: openExternalInputAccessCapture({
      runIdSha256: PRODUCER_RUN_ID_SHA,
      repository: PRODUCER_REPOSITORY,
    }),
    selection,
    readScope: ["."],
    runIdSha256: PRODUCER_RUN_ID_SHA,
    repository: PRODUCER_REPOSITORY,
    requestSha256: PRODUCER_REQUEST_SHA,
    hostPolicySha256: PRODUCER_POLICY_SHA,
    observedAt: "2026-09-17T12:00:00.000Z",
    ...(limits ? { limits } : {}),
  });
}

/**
 * Every hard stop names the failing condition and the remediation; each case
 * reads the operator-visible message from the real producer.
 */
describe("docsfab run --source acquisition stops (#798)", () => {
  it("names the accepted extensions when no extractor claims the selected file", async () => {
    const message = await acquireThrough({ "docs/zeta-spec.foo": "spec bytes" }, [
      "docs/zeta-spec.foo",
    ]).then(
      () => "no refusal",
      (error: Error) => error.message,
    );

    expect(message).toContain("unsupported-media-type (docs/zeta-spec.foo)");
    expect(message).toContain("No installed extractor claims this file's type");
    // Remediation, rendered from the shipped registry.
    expect(message).toContain(supportedSourceExtensions().join(", "));
    expect(message).toContain("then run again");

    // Positive control: the refusal above is the classifier, not the fixture.
    const bound = await acquireThrough(
      {
        "docs/alpha-notes.html": "<html><body><p>Release prose for the producer.</p></body></html>",
      },
      ["docs/alpha-notes.html"],
    );
    expect(bound.acquired).toHaveLength(1);
  });

  it("names the ceiling and how to clear it when a selected source is over the limit", async () => {
    const large = `<html><body><p>${"x".repeat(4096)}</p></body></html>`;
    const message = await acquireThrough(
      { "docs/zeta-large.html": large },
      ["docs/zeta-large.html"],
      {
        maxOriginalBytes: 128,
      },
    ).then(
      () => "no refusal",
      (error: Error) => error.message,
    );

    expect(message).toContain("input-over-limit (docs/zeta-large.html)");
    // The catalog line: the limit's code, the file's bytes, the bound in force,
    // and the override that raises it.
    expect(message).toContain(
      `sources-extraction-max-original-bytes-bound: ${large.length} exceeds sources.extractionMaxOriginalBytes = 128 bytes.`,
    );
    expect(message).toContain(
      "raise DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES, up to 67108864",
    );
    expect(message).toContain("then start a new run. Follow the named remediation.");

    const bound = await acquireThrough(
      { "docs/zeta-large.html": large },
      ["docs/zeta-large.html"],
      {
        maxOriginalBytes: 65_536,
      },
    );
    expect(bound.acquired).toHaveLength(1);
  });
});

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const EXTENSION_SENTENCE = "accepts these tracked source extensions";
const EXTENSION_DOC_PAGES = [
  "docs/get-started/runner-quickstart.md",
  "docs/workflows/run-a-documentation-workflow.md",
  "docs/reference/status-and-configuration/runtime-cli-and-configuration.md",
  "docs/reference/status-and-configuration/source-evidence.md",
];

/** Extensions the CLI help lists, where they are plain text. */
function helpExtensions(text: string): string[] {
  return [...text.matchAll(/\.([a-z0-9]+)/gu)].map((match) => match[1]!);
}

/**
 * Extensions a page claims after the marked sentence. Only backticked `.ext`
 * tokens count, so a plain filename is not a claim; the sentence may wrap.
 */
function documentedExtensions(page: string): string[] {
  const text = readFileSync(resolve(REPOSITORY_ROOT, page), "utf8").replace(/\s+/gu, " ");
  const marker = text.indexOf(EXTENSION_SENTENCE);
  if (marker === -1) return [];
  // The claim ends at the first backticked extension followed by a period.
  const rest = text.slice(marker);
  const end = rest.search(/`\.(?:\s|$)/u);
  const sentence = end === -1 ? rest.slice(0, 400) : rest.slice(0, end + 1);
  const claims: string[] = [];
  for (const match of sentence.matchAll(/`\.([a-z0-9]+)`/gu)) claims.push(match[1]!);
  return claims;
}

describe("docsfab --source documented extension surface (#798)", () => {
  it("documents exactly the extensions the shipped registry accepts", () => {
    const shipped = [...supportedSourceExtensions()];
    expect(shipped.length).toBeGreaterThan(0);

    // The block runs from the marker to the first line that is not part of the list.
    const helpLines = runHelp().split("\n");
    const marker = helpLines.findIndex((line) => line.includes("Accepted extensions:"));
    expect(marker).toBeGreaterThan(-1);
    const helpBlock: string[] = [helpLines[marker]!];
    for (const line of helpLines.slice(marker + 1)) {
      if (!/^\s*\.[a-z0-9]/u.test(line)) break;
      helpBlock.push(line);
    }
    expect(helpExtensions(helpBlock.join(" ")).sort()).toEqual([...shipped].sort());

    // Unwrapped, the block is one comma-separated list, not two split at the break.
    const unwrapped = helpBlock
      .slice(1)
      .map((line) => line.trim())
      .join(" ");
    expect(unwrapped).toBe(shipped.map((extension) => `.${extension}`).join(", "));

    for (const page of EXTENSION_DOC_PAGES) {
      const documented = documentedExtensions(page);
      expect(documented, `${page} must carry the marked extension sentence`).not.toEqual([]);
      expect([...documented].sort(), page).toEqual([...shipped].sort());
    }
  });
});

/**
 * No-source compatibility against the recorded legacy request digest oracle.
 * Explicit `--patch-only` now adds its own true authority field; all prior
 * request fields must retain their original values. Regenerate the digests only
 * with a recorded decision that the legacy CLI contract changed.
 */
const MERGE_BASE_ARGV_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  "review-base": "d0fd2fe65b1e05e7124ec567f9cbde8edc62479ee949b15f18316b76cffea54c",
  "review-json": "bbcb63c3beda288dd146426f9aaa032aa56f35eed1cd4e614c8cca863d05b2d8",
  "review-quiet": "e67a28ecd13d910d476f5656c65aa9fe050e460f5560e28b84a3001164c174ba",
  "review-dry-run": "e38f4f53d9b4e7f72cbbbf7992253e5db266e27fe25947a3b4107b7af1387a35",
  "create-base": "53a9591b7a6a21ee432df5eaa0663abab3c0ff8c7f033543f24cdaed9e54f2c0",
  "create-json": "236da7c183df2f4f615ab8e7d8150f7236432bed1f65da707e560446a7f396c1",
  "create-quiet": "4c97ef789ec4ea6e6f83da3ab9e194e823c3d11e2693ffc78126eda2e328e895",
  "create-dry-run": "a53b333c6769a21d232536712b85d4f033b4d1a8c05c9bece28c5b2ac9dd9113",
  "create-patch-only": "fee096eaaa1a49dca97bc6efe532af905c4d346f2a19313a4b4da7bb41fa71cd",
  "update-base": "bb53374f6961bbedf370fb32b613a5c6cebb68e7cd7200d743cf5934c9499492",
  "update-json": "db79f0f8b391874768b95f77ff00642a7ad9a9f4e34dbec0c3019abf41db7090",
  "update-quiet": "cebc8813dd9bbc79a63146b4a4bd0f2571db83f1ae468b0401eb6c700f74fe2d",
  "update-dry-run": "05c887eba26e4469400ff5d77905e926e613d3adfc18bc2b949bc9531f2bfd53",
  "update-patch-only": "71e27cea7cf3c2b83e180b9aa03e96735b82170041b55c071ad8f11453d1db51",
  "update-reader-source": "d25c526d199b1d801c80efc8df3bbd190932d38082bf5340e5f41e3ca6b37fed",
  "update-comparison-workspace": "90c4e5ec1a28117043fc30deb5aeadad4f2e43a9b71db8dd88a1a5b6f1765b2c",
  "restructure-base": "f3e401cc28d91f612f73d72fbd7c9f99ab1130bfdc568d478e9f1a6a2eced292",
  "restructure-dry-run-json": "e82e0a1b87d759514fdddb64fdf35b9bae9da466f00ba4d3a7a85edf4cb3eef4",
});

const ORACLE_REPO = "/tmp/docsfab-798b-oracle-repo";
const ORACLE_INSTRUCTION = "Update the retention guide for the new export limits.";
const ORACLE_ARGV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "review-base": ["review-documentation", "--repo", ORACLE_REPO],
  "review-json": ["review-documentation", "--repo", ORACLE_REPO, "--json"],
  "review-quiet": ["review-documentation", "--repo", ORACLE_REPO, "--quiet"],
  "review-dry-run": ["review-documentation", "--repo", ORACLE_REPO, "--dry-run"],
  "create-base": [
    "create-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
  ],
  "create-json": [
    "create-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--json",
  ],
  "create-quiet": [
    "create-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--quiet",
  ],
  "create-dry-run": [
    "create-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--dry-run",
  ],
  "create-patch-only": [
    "create-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--patch-only",
  ],
  "update-base": [
    "update-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
  ],
  "update-json": [
    "update-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--json",
  ],
  "update-quiet": [
    "update-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--quiet",
  ],
  "update-dry-run": [
    "update-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--dry-run",
  ],
  "update-patch-only": [
    "update-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--patch-only",
  ],
  "update-reader-source": [
    "update-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--reader-source",
    "current-documentation=docs/cli.md",
  ],
  "update-comparison-workspace": [
    "update-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--comparison-workspace",
  ],
  "restructure-base": [
    "restructure-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
  ],
  "restructure-dry-run-json": [
    "restructure-documentation",
    "--repo",
    ORACLE_REPO,
    "--instruction",
    ORACLE_INSTRUCTION,
    "--dry-run",
    "--json",
  ],
});

/** Key-sorted JSON, so an argument's position in the object cannot move a digest. */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stableJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function argvDigest(argv: readonly string[]): string {
  const parsed = JSON.parse(JSON.stringify(parseRunArguments([...argv]))) as Record<
    string,
    unknown
  >;
  delete parsed.patchOnly;
  return createHash("sha256")
    .update(JSON.stringify(stableJson(parsed)), "utf8")
    .digest("hex");
}

describe("docsfab run no-source argument compatibility (#798)", () => {
  it("preserves all legacy request fields while adding explicit patch-only authority", () => {
    const observed = Object.fromEntries(
      Object.entries(ORACLE_ARGV).map(([name, argv]) => {
        const parsed = parseRunArguments([...argv]);
        const explicitlySelected = argv.includes("--patch-only");
        expect(Object.hasOwn(parsed, "patchOnly"), name).toBe(explicitlySelected);
        expect(parsed.patchOnly, name).toBe(explicitlySelected ? true : undefined);
        return [name, argvDigest(argv)];
      }),
    );

    expect(observed).toEqual(MERGE_BASE_ARGV_DIGESTS);
    expect(Object.keys(observed)).toHaveLength(18);

    // The projection still distinguishes the legacy patch-only request from
    // an ordinary update after excluding only its new explicit authority key.
    expect(argvDigest([...ORACLE_ARGV["update-base"]!, "--patch-only"])).toBe(
      MERGE_BASE_ARGV_DIGESTS["update-patch-only"],
    );
    expect(MERGE_BASE_ARGV_DIGESTS["update-patch-only"]).not.toBe(
      MERGE_BASE_ARGV_DIGESTS["update-base"],
    );
  });
});

/**
 * Every refusal code this producer can mint names the failing condition and the
 * change that clears it. Codes come from the shipped enumeration, so a new code
 * is covered here.
 */
describe("docsfab run --source refusal remediation contract (#798)", () => {
  const PREFIX = /^Source acquisition refused: [a-z-]+(?: \([^)]*\))?\. /u;

  it.each([...SOURCE_ACQUISITION_REFUSAL_CODES])(
    "names a remediation on the %s refusal",
    (code) => {
      const message = new SourceAcquisitionError(code, "docs/zeta-subject.html").message;

      expect(message).toMatch(PREFIX);
      expect(message).toContain(`refused: ${code} (docs/zeta-subject.html).`);

      const remediation = message.replace(PREFIX, "");
      expect(remediation.length).toBeGreaterThan(30);
      expect(remediation.endsWith(".")).toBe(true);
      expect(remediation).toMatch(/\brun\b[^.]*\bagain\b|\brun without\b/iu);
    },
  );

  it("renders the extensions the effective registry accepts, not the shipped default", async () => {
    // An HTML-only host must not offer `.json` while refusing a `.json`.
    const htmlOnly = createSourceExtractorRegistry([htmlSourceExtractorAdapter]);
    const message = await acquireThrough(
      { "docs/zeta-api.json": '{"paths":{}}' },
      ["docs/zeta-api.json"],
      undefined,
      htmlOnly,
    ).then(
      () => "no refusal",
      (error: Error) => error.message,
    );

    const narrowed = supportedSourceExtensions(htmlOnly.list());
    expect(message).toContain("unsupported-media-type (docs/zeta-api.json)");
    expect(message).toContain(narrowed.join(", "));
    expect(narrowed).not.toContain("json");
    expect(message).not.toContain("json,");

    // Positive control: the refusal above is the narrowed registry, not the fixture.
    const bound = await acquireThrough({ "docs/zeta-api.json": '{"paths":{}}' }, [
      "docs/zeta-api.json",
    ]);
    expect(bound.acquired).toHaveLength(1);
  });
});

/** Extension to locator kind, computed from the shipped classifier and registry. */
function shippedExtractorFamilies(): Record<string, string> {
  const registry = createDefaultSourceExtractorRegistry();
  const families: Record<string, string> = {};
  for (const extension of supportedSourceExtensions()) {
    const mediaType = classifySourceMediaType(`fixture.${extension}`)!;
    families[extension] = registry.resolve(mediaType)!.locatorKind;
  }
  return families;
}

/** Extension to locator kind, as the public extractor table claims it. */
function documentedExtractorFamilies(page: string): Record<string, string> {
  const families: Record<string, string> = {};
  for (const line of readFileSync(resolve(REPOSITORY_ROOT, page), "utf8").split("\n")) {
    if (!line.startsWith("|") || !/`\.[a-z0-9]+`/u.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const locator = cells[cells.length - 2]?.match(/\(`([a-z-]+)`\)\s*$/u)?.[1];
    if (locator === undefined) continue;
    for (const match of cells[1]!.matchAll(/`\.([a-z0-9]+)`/gu)) families[match[1]!] = locator;
  }
  return families;
}

describe("docsfab --source documented extractor table (#798)", () => {
  it("assigns every documented extension to the extractor the registry resolves", () => {
    const shipped = shippedExtractorFamilies();
    const documented = documentedExtractorFamilies(
      "docs/reference/status-and-configuration/source-evidence.md",
    );

    expect(documented).toEqual(shipped);
    expect(Object.keys(shipped).sort()).toEqual([...supportedSourceExtensions()].sort());
  });
});
