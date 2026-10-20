// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import {
  buildRunResultV1,
  decodeRunResultV1,
  formatDocChangeDeltaReviewLines,
  formatRunSummary,
  projectDocChangeDeltaCliSurface,
  serializeRunResultV1,
} from "../src/operator/index.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import {
  createDocumentationGapLedger,
  projectDocumentationSearchFindings,
} from "../src/search/index.js";
import { boundedAbsence, readinessEvidenceAt } from "./helpers/search-progress-fixture.js";

const REVISION = "a".repeat(40);
const CONTENT = "d".repeat(64);
const PATCH = "f".repeat(64);

describe("DocChangeDelta CLI / run-result surface (#252)", () => {
  it("emits projected delta digest beside patch digest when gap evidence is projectable", () => {
    const record = polishRecordWithOpenGaps();
    const envelope = buildRunResultV1({
      record,
      recordPath: "/private/state/polish-run.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      repositoryContentDigestSha256: CONTENT,
    });
    const parsed = decodeRunResultV1(parseJsonEvidence(serializeRunResultV1(envelope)));

    expect(parsed.execution.patchSha256).toBe(PATCH);
    expect(parsed.execution.patchPath).toContain("changes.patch");
    expect(parsed.execution.docChangeDelta).toMatchObject({
      status: "projected",
      kind: "docsfab-doc-change-delta",
      trackerMutation: "not-authorized",
      repositoryRevision: REVISION,
    });
    if (parsed.execution.docChangeDelta?.status !== "projected") {
      throw new Error("expected projected DocChangeDelta");
    }
    expect(parsed.execution.docChangeDelta.deltaSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parsed.execution.docChangeDelta.summary.added).toBeGreaterThan(0);
    expect(parsed.execution.docChangeDelta.sourceRunRecordSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(parsed.execution.docChangeDelta)).not.toContain("Does the");
    expect(JSON.stringify(parsed.execution.docChangeDelta)).not.toContain("/selected/");
  });

  it("emits explicit unavailable when patch exists without projectable gap evidence", () => {
    const record = minimalPolishRecord({
      changes: {
        files: [{ path: "README.md", status: "modified" }],
        patch: {
          sha256: PATCH,
          byteLength: 12,
          lineCount: 2,
          artifactPath: "/private/patches/changes.patch",
          format: "git-diff",
        },
      },
    });
    const envelope = buildRunResultV1({
      record,
      recordPath: "/private/state/polish-run.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      repositoryContentDigestSha256: CONTENT,
    });
    expect(envelope.execution.patchSha256).toBe(PATCH);
    expect(envelope.execution.docChangeDelta).toEqual({
      status: "unavailable",
      limitation: "gap-ledger-unavailable",
    });
  });

  it("emits explicit unavailable when content digest cannot be reconstructed", () => {
    const record = polishRecordWithOpenGaps();
    const surface = projectDocChangeDeltaCliSurface({ record });
    expect(surface).toEqual({
      status: "unavailable",
      limitation: "repository-content-digest-unavailable",
    });
  });

  it("omits docChangeDelta when no patch was produced", () => {
    const envelope = buildRunResultV1({
      record: minimalPolishRecord(),
      recordPath: "/private/state/polish-run.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
    });
    expect(envelope.execution.patchSha256).toBeNull();
    expect(envelope.execution.docChangeDelta).toBeNull();
  });

  it("prints non-authoritative ADDED/MODIFIED/REMOVED review lines beside the patch", () => {
    const record = polishRecordWithOpenGaps();
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/polish-run.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      repositoryContentDigestSha256: CONTENT,
      tty: false,
    });
    const text = lines.join("\n");
    expect(text).toContain(`Patch digest: ${PATCH}`);
    expect(text).not.toContain("DocChangeDelta:");
    expect(text).not.toContain("Documentation gap ledger:");
    const verboseLines = formatRunSummary({
      record,
      recordPath: "/private/state/polish-run.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      repositoryContentDigestSha256: CONTENT,
      verbose: true,
      tty: false,
    });
    expect(verboseLines.join("\n")).toContain("DocChangeDelta:");
    expect(verboseLines.join("\n")).toMatch(/ADDED:/u);
    expect(verboseLines.join("\n")).toContain("Documentation gap ledger:");
    expect(
      formatDocChangeDeltaReviewLines({
        status: "unavailable",
        limitation: "gap-ledger-unavailable",
      }),
    ).toEqual(["DocChangeDelta: unavailable (gap-ledger-unavailable)"]);
  });
});

function polishRecordWithOpenGaps(): RunRecord {
  const absenceEvidence = readinessEvidenceAt(REVISION, boundedAbsence);
  const absenceFindings = projectDocumentationSearchFindings({
    workflow: "update-documentation",
    stepId: "plan-documentation",
    evidence: absenceEvidence,
  });
  const ledger = createDocumentationGapLedger({
    currentRevision: REVISION,
    findings: absenceFindings,
  });
  return minimalPolishRecord({
    gapLedger: ledger,
    searchFindings: absenceFindings,
    changes: {
      files: [{ path: "README.md", status: "modified" }],
      patch: {
        sha256: PATCH,
        byteLength: 12,
        lineCount: 2,
        artifactPath: "/private/patches/changes.patch",
        format: "git-diff",
      },
    },
  });
}

function minimalPolishRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "polish-run-001",
    workflow: "update-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    ...overrides,
  };
}
