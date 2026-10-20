// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  overflowSourceRepresentationsFromAcquired,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import type { RunRecord, ToolResultArchiveSnapshotV1 } from "../src/records/contracts.js";

const PDF_OVERFLOW = {
  limitation: "byte-budget-truncated" as const,
  limitName: "sources.pdfMaxPages",
  observed: 105,
};

describe("overflowSourceRepresentationsFromAcquired", () => {
  it("returns undefined for missing acquired instead of throwing", () => {
    expect(overflowSourceRepresentationsFromAcquired(undefined)).toBeUndefined();
    expect(overflowSourceRepresentationsFromAcquired(null)).toBeUndefined();
  });

  it("returns undefined for a truthy acquired binding without a nested array", () => {
    expect(overflowSourceRepresentationsFromAcquired({})).toBeUndefined();
    expect(overflowSourceRepresentationsFromAcquired({ acquired: undefined })).toBeUndefined();
    expect(overflowSourceRepresentationsFromAcquired({ acquired: null })).toBeUndefined();
    expect(overflowSourceRepresentationsFromAcquired({ acquired: "entries" })).toBeUndefined();
  });

  it("skips partial entries and keeps sealed overflow from the rest", () => {
    expect(
      overflowSourceRepresentationsFromAcquired({
        acquired: [
          null,
          {},
          { representation: {} },
          { representation: { limitations: [], overflows: [] } },
          {
            representation: {
              limitations: ["byte-budget-truncated"],
              overflows: [PDF_OVERFLOW],
            },
          },
        ],
      }),
    ).toEqual([
      {
        limitations: ["byte-budget-truncated"],
        overflows: [PDF_OVERFLOW],
      },
    ]);
  });

  it("keeps overflow when limitations were omitted from a partial representation", () => {
    expect(
      overflowSourceRepresentationsFromAcquired({
        acquired: [{ representation: { overflows: [PDF_OVERFLOW] } }],
      }),
    ).toEqual([{ limitations: [], overflows: [PDF_OVERFLOW] }]);
  });
});

function archiveCeilingSnapshot(): ToolResultArchiveSnapshotV1 {
  const archiveLimit = limit("toolOutput.archiveCeilingBytes");
  const observedBytes = archiveLimit.value + 1;
  return {
    receipts: [
      {
        schemaVersion: 1,
        kind: "docsfab-tool-result-archive",
        handle: "docsfab-tr-aaaaaaaaaaaaaaaa",
        sha256: "a".repeat(64),
        toolName: "read",
        totalBytes: observedBytes,
      },
    ],
    storedBytes: 0,
    ceilingBytes: archiveLimit.value,
    refusals: [{ limitName: "toolOutput.archiveCeilingBytes", observedBytes }],
  };
}

describe("collectRunLimitOverflowEvidence tool-result archives", () => {
  it("skips a null or malformed inference attempt and keeps archive-ceiling LIMITATIONS", () => {
    const snapshot = archiveCeilingSnapshot();
    const overflow = collectRunLimitOverflowEvidence({
      steps: [
        {
          tools: { totalCalls: 1, failedCalls: 0, byTool: [], toolResultArchive: snapshot },
          inference: {
            attempts: [
              null,
              "untrusted-attempt",
              [],
              { tools: null },
              { tools: { toolResultArchive: snapshot } },
            ],
          },
        },
      ],
    } as RunRecord);
    expect(overflow.toolResultArchives).toEqual([snapshot]);
    expect(overflow.toolResultArchives?.[0]?.receipts).toEqual(snapshot.receipts);
    const lines = projectRunLimitOverflowLines(overflow);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tool-output-archive-ceiling-bytes-bound");
    expect(lines[0]).toContain(String(snapshot.refusals[0]!.observedBytes));
    expect(lines[0]).toContain(String(snapshot.ceilingBytes));
  });
});

describe("collectRunLimitOverflowEvidence partial source reads (#1809)", () => {
  const partial = [
    "source-read-partial: docs/prd.txt was read 16384 of 39176 bytes when step write-documentation started writing; the rest of it was not read.",
    "source-read-partial: step write-documentation could not read every required source whole. sources-read-response-ceiling-bytes-bound: 39176 exceeds sources.readResponseCeilingBytes = 16384 bytes. Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least the bytes named. Follow the named remediation.",
  ];

  it("projects a recorded partial read into LIMITATIONS, once, and nothing else from the warnings", () => {
    const record = {
      steps: [],
      evidenceWarnings: ["Repository change evidence could not be captured.", ...partial],
    } as unknown as RunRecord;
    const overflow = collectRunLimitOverflowEvidence(record);
    expect(overflow.sourceReadPartials).toEqual(partial);
    // The saved record and the live evidence carry the same lines; each prints once.
    const merged = mergeRunLimitOverflowEvidence(overflow, { sourceReadPartials: partial });
    expect(projectRunLimitOverflowLines(merged)).toEqual(partial);
  });

  it("projects nothing for a run whose required sources were read whole", () => {
    const record = {
      steps: [],
      evidenceWarnings: ["Repository change evidence could not be captured."],
    } as unknown as RunRecord;
    const overflow = collectRunLimitOverflowEvidence(record);
    expect(overflow.sourceReadPartials).toBeUndefined();
    expect(projectRunLimitOverflowLines(mergeRunLimitOverflowEvidence(overflow))).toEqual([]);
  });
});

describe("collectRunLimitOverflowEvidence reading-source notices (#2112)", () => {
  const notices = [
    'first-pass-reading-source-unbound: "upstream" (not-tracked): the request\'s reading names it as a source, but the selected revision tracks no regular file at that path or under it, so first pass did not read it and went on with the evidence it could bind. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.',
    'first-pass-reading-source-unbound: "src/*.ts" (glob): the request\'s reading names it as a source, but it is a pattern, and first pass binds a source only by its exact path, so it read nothing for it and went on with the evidence it could bind. Name the files, or the directory that holds them, in the request, or pass the files with --source.',
  ];
  const partial =
    "source-read-partial: docs/prd.txt was read 16384 of 39176 bytes when step write-documentation started writing; the rest of it was not read.";

  it("projects each first-pass notice into LIMITATIONS once, ahead of the run's own limitations", () => {
    const record = {
      steps: [],
      evidenceWarnings: [partial, "Repository change evidence could not be captured.", ...notices],
    } as unknown as RunRecord;
    const overflow = collectRunLimitOverflowEvidence(record);
    expect(overflow.readingSourceNotices).toEqual(notices);
    const merged = mergeRunLimitOverflowEvidence(overflow, { readingSourceNotices: notices });
    expect(projectRunLimitOverflowLines(merged)).toEqual([...notices, partial]);
  });

  it("projects no notice for a run whose reading's sources all bound", () => {
    const record = { steps: [], evidenceWarnings: [partial] } as unknown as RunRecord;
    const overflow = collectRunLimitOverflowEvidence(record);
    expect(overflow.readingSourceNotices).toBeUndefined();
    expect(projectRunLimitOverflowLines(mergeRunLimitOverflowEvidence(overflow))).toEqual([
      partial,
    ]);
  });
});

describe("focused review context coverage", () => {
  it("projects named and unnameable unbound pages without claiming they were reviewed", () => {
    const unbound = Array.from(
      { length: 7 },
      (_unused, index) => `documentation/tensorrt/review/page-${index + 4}.rst`,
    );
    const record = {
      steps: [
        {
          id: "review-documentation",
          mode: "read",
          status: "succeeded",
          contextPreflight: {
            status: "degraded",
            reason: "preflight-budget-exceeded",
            packetDigest: "a".repeat(64),
            ontologyVersion: "ontology-v1",
            limit: {
              name: "context.corpusPacketInputShareBasisPoints",
              unit: "tokens",
              configured: 1_000,
              observed: 3_000,
            },
            unboundTargets: unbound,
            unboundTargetsOmitted: 1,
          },
        },
      ],
    } as unknown as RunRecord;
    const evidence = collectRunLimitOverflowEvidence(record);
    expect(evidence.contextPackets).toEqual([
      expect.objectContaining({
        stepId: "review-documentation",
        disposition: "trimmed",
        unboundTargets: unbound,
        unboundTargetsOmitted: 1,
      }),
    ]);
    const lines = projectRunLimitOverflowLines(evidence);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("context packet measured 3000 estimated tokens before the trim");
    for (const path of unbound) expect(lines[0]).toContain(path);
    expect(lines[0]).toContain("1 more whose path the record cannot hold");
    expect(lines[0]).not.toMatch(/verified|reviewed/iu);
  });
});
