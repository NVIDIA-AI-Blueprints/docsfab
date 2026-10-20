// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { diagnoseRun, type DiagnosisLocation } from "../src/diagnosis/engine.js";
import { parseRunsQueryArguments } from "../src/cli/commands/runs-index.js";
import {
  decodeRunIndexRow,
  projectRunIndexRows,
  type RunIndexRowV1,
} from "../src/records/run-index.js";
import { queryRunIndex } from "../src/records/run-index-query.js";

const LOCATION: DiagnosisLocation = {
  indexArgs: " --state-dir /state",
  showArgs: " --state-dir /state",
};

function record(checkpointAttempt = 1): Record<string, unknown> {
  const pointer = { sha256: "a".repeat(64), sequence: 4, attempt: checkpointAttempt };
  return {
    schemaVersion: 2,
    id: "answer-record-run",
    workflow: "review-documentation",
    status: "failed",
    createdAt: "2026-10-10T10:00:00.000Z",
    repository: { sourcePath: "/fixture/repository", revision: "b".repeat(40) },
    qualityPack: { manifestSha256: "c".repeat(64) },
    steps: [
      {
        id: "review-documentation",
        status: "failed",
        skill: "evaluate-document-quality",
        model: { provider: "fixture-provider", model: "fixture/model" },
        answerRecordCheckpoint: pointer,
        answerRecordLedger: {
          schemaVersion: 1,
          kind: "docsfab-answer-record-ledger-index",
          contractId: "answer-records-v1",
          bindingsSha256: "d".repeat(64),
          rows: [
            {
              type: "quality-evaluation",
              key: "judgment:a",
              recordSha256: "e".repeat(64),
              state: "admitted",
              attempt: 1,
            },
            {
              type: "quality-evaluation",
              key: "judgment:b",
              recordSha256: "f".repeat(64),
              state: "released",
              attempt: 1,
            },
          ],
          checkpoint: checkpointAttempt === 1 ? pointer : { ...pointer, sequence: 3 },
          progress: {
            admittedRowCount: 1,
            releasedRowCount: 1,
            remainingKeyCount: 2,
            refusalEventCount: 3,
            complete: false,
            checkpointSequence: 4,
            logicalRunId: "logical-run-a",
            sourceRunId: "source-run-a",
            sourceAttemptHighWater: 5,
          },
        },
        inference: {
          attempts: [
            {
              attempt: 1,
              outcome: "malformed-response",
              retryable: true,
              durationMs: 10,
              model: { provider: "fixture-provider", model: "fixture/model" },
            },
            {
              attempt: 2,
              outcome: "succeeded",
              retryable: false,
              durationMs: 10,
              model: { provider: "fixture-provider", model: "fixture/model" },
            },
          ],
        },
      },
    ],
  };
}

function rowsOf(value: unknown): RunIndexRowV1[] {
  const projection = projectRunIndexRows(value, {
    origin: "import",
    snapshotId: "snapshot-answer-record-progress",
    indexedAt: "2026-10-10T10:01:00.000Z",
    recordSha256: "9".repeat(64),
    fieldMaxChars: 512,
  });
  if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
  return [...projection.rows];
}

describe("checkpoint-bound answer-record progress", () => {
  it("projects progress only on the physical attempt that committed its checkpoint", () => {
    const rows = rowsOf(record());
    const attempts = rows.filter((row) => row.rowKind === "attempt");
    expect(attempts.map((row) => [row.attempt, row.answerRecordCheckpointSequence])).toEqual([
      [1, 4],
      [2, null],
    ]);
    expect(attempts[0]).toMatchObject({
      answerRecordAdmittedRowCount: 1,
      answerRecordReleasedRowCount: 1,
      answerRecordRemainingKeyCount: 2,
      answerRecordRefusalEventCount: 3,
      answerRecordComplete: false,
      answerRecordLogicalRunId: "logical-run-a",
      answerRecordSourceRunId: "source-run-a",
      answerRecordSourceAttemptHighWater: 5,
    });
    expect(attempts[1]?.omittedFields).not.toContain("answerRecordRemainingKeyCount");
    expect(
      rows
        .filter((row) => row.rowKind !== "attempt")
        .every((row) => row.answerRecordComplete === null),
    ).toBe(true);
  });

  it("keeps mismatched checkpoint evidence unavailable and names omitted fields", () => {
    const rows = rowsOf(record(2));
    const attemptOne = rows.find((row) => row.rowKind === "attempt" && row.attempt === 1)!;
    expect(attemptOne.answerRecordCheckpointSequence).toBeNull();
    expect(attemptOne.omittedFields).toContain("answerRecordCheckpointSequence");
    expect(attemptOne.omittedFields).toContain("answerRecordRemainingKeyCount");
  });

  it("does not interpret revision-17 rows as carrying revision-18 checkpoint progress", () => {
    const attempt = rowsOf(record()).find((row) => row.rowKind === "attempt")!;
    const decoded = decodeRunIndexRow({ ...attempt, projectionRevision: 17 });
    expect(decoded).toMatchObject({
      projectionRevision: 17,
      answerRecordAdmittedRowCount: null,
      answerRecordCheckpointSequence: null,
      answerRecordComplete: null,
    });
  });

  it("queries and diagnoses committed counts without treating them as report validation", () => {
    const rows = rowsOf(record());
    const query = queryRunIndex(rows, {
      where: new Map([["answerRecordComplete", ["false"]]]),
      groupBy: ["answerRecordComplete", "answerRecordRemainingKeyCount"],
    });
    expect(query.population.rows).toBe(1);
    expect(query.groups[0]?.key).toEqual({
      answerRecordComplete: false,
      answerRecordRemainingKeyCount: 2,
    });

    const diagnosis = diagnoseRun(rows, {
      location: LOCATION,
      source: "run-index",
      population: rows,
      lookbackRuns: 5,
    });
    const finding = diagnosis.findings.find(
      (candidate) => candidate.evidence.rowKind === "attempt",
    )!;
    expect(finding.evidence.answerRecordProgress).toMatchObject({
      remainingKeyCount: 2,
      refusalEventCount: 3,
      complete: false,
      sourceRunId: "source-run-a",
    });
    expect(finding.what).toContain("required keys remaining");
    expect(
      rows.find((row) => row.rowKind === "attempt" && row.attempt === 1)?.answerRecordComplete,
    ).toBe(false);
    expect(finding.what).not.toContain("validated report");
  });

  it("decodes older rows without inventing counts and validates the closed query value", () => {
    const row = rowsOf(record())[0]!;
    const older = decodeRunIndexRow({ ...row, projectionRevision: 16 });
    expect(older?.answerRecordRemainingKeyCount).toBeNull();
    expect(older?.answerRecordRefusalEventCount).toBeNull();
    expect(
      parseRunsQueryArguments(["--where", "answerRecordComplete=false"]).where.get(
        "answerRecordComplete",
      ),
    ).toEqual(["false"]);
    expect(() => parseRunsQueryArguments(["--where", "answerRecordComplete=maybe"])).toThrow(
      /answerRecordComplete value "maybe"/u,
    );
  });
});
