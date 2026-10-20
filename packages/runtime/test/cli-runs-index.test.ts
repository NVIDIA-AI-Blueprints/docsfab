// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import {
  parseRunsQueryArguments,
  runsQueryUsage,
  runRunsImport,
  runRunsQuery,
  RunsOperatorError,
} from "../src/cli/commands/runs-index.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { applyRunDeletion, previewRunDeletion } from "../src/records/run-deletion.js";
import { limit } from "../src/config/limits.js";
import {
  projectRunIndexRows,
  RUN_INDEX_LIMITS,
  RUN_INDEX_PROJECTION_REVISION,
  sha256Hex,
} from "../src/records/run-index.js";
import {
  appendRunIndexSnapshot,
  createIndexedFileRunStore,
  createRunStoreIndexer,
  defaultRunIndexDirectory,
  RUN_INDEX_OVERFLOW_FILE_NAME,
  RunIndexStoreError,
  writeRunIndexBytes,
} from "../src/records/run-index-store.js";

const roots: string[] = [];
const savedHostLimits = process.env.DOCSFAB_SERVICE_ENV_FILE;

afterEach(async () => {
  if (savedHostLimits === undefined) delete process.env.DOCSFAB_SERVICE_ENV_FILE;
  else process.env.DOCSFAB_SERVICE_ENV_FILE = savedHostLimits;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Lower index limits through the host limits file, the tier these limits admit. */
async function lowerLimits(root: string, limits: Record<string, number>): Promise<void> {
  const path = join(root, "service.env");
  await writeFile(
    path,
    Object.entries(limits)
      .map(([name, value]) => `${name}=${String(value)}\n`)
      .join(""),
  );
  process.env.DOCSFAB_SERVICE_ENV_FILE = path;
}

const BATCH_ID = "d".repeat(64);

it("labels indexed status as workflow execution and points to saved checkout outcome", () => {
  expect(runsQueryUsage()).toContain("runStatus is workflow execution only");
  expect(runsQueryUsage()).toContain("docsfab runs show <runId> --state-dir <path>");
  const value = {
    ...runRecord("checkout-failed", "succeeded", []),
    checkoutPersistence: {
      schemaVersion: 1,
      kind: "checkout-persistence",
      outcome: "failed",
      errorCode: "patch-conflict",
    },
  };
  const projected = projectRunIndexRows(value, {
    origin: "import",
    snapshotId: "checkout-outcome",
    indexedAt: "2026-10-13T12:00:00.000Z",
    recordSha256: sha256Hex(JSON.stringify(value)),
    fieldMaxChars: 512,
  });
  expect(projected.ok).toBe(true);
  if (projected.ok) {
    expect(projected.rows[0]).toMatchObject({ runStatus: "succeeded", outcome: "succeeded" });
  }
});

function runRecord(
  id: string,
  status: RunRecord["status"],
  rejections: readonly ({ code: string; location: string } | null)[],
): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "restructure-documentation",
    repository: {
      sourcePath: "/fixture/repository",
      requestedRevision: "HEAD",
      revision: "e".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status,
    createdAt: "2026-09-23T09:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "verify-technical-accuracy",
        title: "Verify",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: status === "running" ? "running" : "failed",
        inference: {
          configuredMaxRetries: 3,
          effectiveMaxRetries: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ["malformed-response"],
          replay: "read-only",
          attempts: rejections.map((rejection, index) => ({
            attempt: index + 1,
            outcome: "malformed-response" as const,
            retryable: true,
            retryScheduled: index < rejections.length - 1,
            durationMs: 5,
            model: { provider: "fixture-provider", model: "fixture/model-a" },
            ...(rejection ? { rejection } : {}),
          })),
        },
      },
    ],
  } as unknown as RunRecord;
}

async function writeHarnessBatch(root: string): Promise<string> {
  const batch = join(root, "batch");
  await mkdir(join(batch, "restructure-cli", "runs"), { recursive: true });
  await mkdir(join(batch, "review-cli", "runs"), { recursive: true });
  await mkdir(join(batch, "create-live", "runs"), { recursive: true });
  await writeFile(
    join(batch, "report.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "docsfab-local-e2e-report",
      batchId: BATCH_ID,
      entries: [
        { key: "restructure-cli", outcome: "fail" },
        { key: "review-cli", outcome: "fail" },
        { key: "create-live", outcome: "error" },
      ],
    }),
  );
  const locators = { code: "inventory-fact-locators", location: "$.factInventory" };
  await writeFile(
    join(batch, "restructure-cli", "runs", "run-restructure.json"),
    JSON.stringify(runRecord("run-restructure", "failed", [locators, null, locators])),
  );
  await writeFile(
    join(batch, "review-cli", "runs", "run-review.json"),
    JSON.stringify(
      runRecord("run-review", "failed", [
        { code: "inconsistent-status", location: "$.dimensions[].reason" },
      ]),
    ),
  );
  return batch;
}

describe("docsfab runs import and query", () => {
  it("refuses a source root reused as the index root through a path alias", async () => {
    const root = await temporaryRoot("docsfab-runs-index-alias-");
    const stateDirectory = join(root, "state");
    const record = runRecord("alias-conflict", "failed", [{ code: "fixture", location: "$.x" }]);
    await new FileRunStore(stateDirectory).save(record);
    const result = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory: await realpath(stateDirectory),
      paths: [join(stateDirectory, `${record.id}.json`)],
      docsfabRevision: "f05a81f1b",
    });
    expect(result.imported).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({ code: "runs-index-source-index-root-conflict" }),
    ]);
  });

  it("refuses a projected import after deletion and cannot append the deleted rows directly", async () => {
    const root = await temporaryRoot("docsfab-runs-index-delete-race-");
    const stateDirectory = join(root, "state");
    const indexDirectory = defaultRunIndexDirectory(stateDirectory);
    const target = runRecord("deleted-import-target", "failed", [
      { code: "fixture", location: "$.x" },
    ]);
    const unrelated = runRecord("retained-import-target", "failed", [
      { code: "fixture", location: "$.y" },
    ]);
    const store = new FileRunStore(stateDirectory);
    await store.save(target);
    await store.save(unrelated);
    const request = {
      command: "import" as const,
      help: false,
      json: true,
      indexDirectory,
      paths: [join(stateDirectory, `${unrelated.id}.json`)],
      docsfabRevision: "f05a81f1b",
    };
    expect((await runRunsImport(request)).imported).toHaveLength(1);

    let resume!: () => void;
    let projected!: () => void;
    const paused = new Promise<void>((resolve) => {
      projected = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const stale = runRunsImport(
      { ...request, paths: [join(stateDirectory, `${target.id}.json`)] },
      {
        afterProjection: async () => {
          projected();
          await released;
        },
      },
    );
    await Promise.race([
      paused,
      stale.then(() => {
        throw new Error("import projection did not pause before append");
      }),
    ]);
    const preview = await previewRunDeletion(stateDirectory, target.id);
    expect((await applyRunDeletion(stateDirectory, target.id, preview.confirmation)).complete).toBe(
      true,
    );
    resume();
    const result = await stale;
    expect(result.imported).toEqual([]);
    expect(result.refused).toEqual([expect.objectContaining({ code: "runs-index-run-deleted" })]);

    expect(await readdir(indexDirectory)).toContain(".docsfab-run-index-deleted");
    const marker = createHash("sha256")
      .update("docsfab-run-index-deleted-v1\0")
      .update(await realpath(indexDirectory))
      .update("\0")
      .update(target.id)
      .digest("hex");
    expect(await readdir(join(indexDirectory, ".docsfab-run-index-deleted"))).toContain(marker);

    const bytes = Buffer.from(`${JSON.stringify(target)}\n`);
    const projection = projectRunIndexRows(target, {
      origin: "import",
      snapshotId: "stale-projection",
      indexedAt: "2026-10-09T00:00:00.000Z",
      recordSha256: sha256Hex(bytes),
      fieldMaxChars: limit(RUN_INDEX_LIMITS.fieldMaxChars).value,
      docsfabRevision: "f05a81f1b",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error("fixture projection failed");
    expect(new Set(projection.rows.map((row) => row.runId))).toEqual(new Set([target.id]));
    await expect(
      appendRunIndexSnapshot({
        indexDirectory,
        rows: projection.rows,
        maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
      }),
    ).rejects.toMatchObject({ code: "runs-index-run-deleted" });
    const raw = await readFile(join(indexDirectory, "runs.jsonl"), "utf8");
    expect(raw).not.toContain(target.id);
    expect(raw).toContain(unrelated.id);
  });

  it("imports a harness batch and reproduces an inner-rejection aggregation with one query", async () => {
    const root = await temporaryRoot("docsfab-runs-index-import-");
    const batch = await writeHarnessBatch(root);
    const indexDirectory = join(root, "index");

    const imported = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [batch],
      docsfabRevision: "f05a81f1b",
    });
    expect(imported.imported).toEqual([
      { runId: "run-restructure", caseKey: "restructure-cli", rows: 4 },
      { runId: "run-review", caseKey: "review-cli", rows: 2 },
    ]);
    expect(imported.refused).toEqual([]);
    expect(imported.casesWithoutRunRecord).toEqual([
      { batchId: BATCH_ID, caseKey: "create-live", outcome: "error" },
    ]);

    const again = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [batch],
      docsfabRevision: "f05a81f1b",
    });
    expect(again.imported).toEqual([]);
    expect(again.unchanged).toHaveLength(2);

    const io = await captureIo(() =>
      handleRunsCommand([
        "query",
        "--index-dir",
        indexDirectory,
        "--where",
        "outcome=malformed-response",
        "--group-by",
        "rejectionCode,rejectionLocation",
        "--json",
      ]),
    );
    const envelope = JSON.parse(io.stdout) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: "docsfab-run-index-query",
      population: { rows: 4, runs: 2 },
      incomplete: null,
    });
    expect(envelope.groups).toEqual([
      {
        key: { rejectionCode: "inventory-fact-locators", rejectionLocation: "$.factInventory" },
        rows: 2,
        runs: 1,
        share: 0.5,
      },
      {
        key: { rejectionCode: "inconsistent-status", rejectionLocation: "$.dimensions[].reason" },
        rows: 1,
        runs: 1,
        share: 0.25,
      },
      { key: { rejectionCode: null, rejectionLocation: null }, rows: 1, runs: 1, share: 0.25 },
    ]);

    const byCase = await runRunsQuery(
      parseRunsQueryArguments([
        "--index-dir",
        indexDirectory,
        "--where",
        "rejectionCode=inventory-fact-locators",
        "--group-by",
        "batchId,caseKey,docsfabRevision",
      ]),
    );
    expect(byCase.groups).toEqual([
      {
        key: { batchId: BATCH_ID, caseKey: "restructure-cli", docsfabRevision: "f05a81f1b" },
        rows: 2,
        runs: 1,
        share: 1,
      },
    ]);
  });

  it("refuses an oversized or non-record file by name and still imports the rest", async () => {
    const root = await temporaryRoot("docsfab-runs-index-oversize-");
    const state = join(root, "runs");
    await mkdir(state);
    await writeFile(
      join(state, "small.json"),
      JSON.stringify(runRecord("small", "failed", [null])),
    );
    await writeFile(
      join(state, "large.json"),
      JSON.stringify({ ...runRecord("large", "failed", [null]), padding: "x".repeat(5000) }),
    );
    await writeFile(join(state, "small.limit-overflow.json"), JSON.stringify({ sidecar: true }));
    await writeFile(join(state, "notes.json"), JSON.stringify({ note: "not a record" }));
    await lowerLimits(root, { "runs.recordMaxBytes": 4096 });

    const result = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory: join(root, "index"),
      paths: [state],
      docsfabRevision: null,
    });
    expect(result.imported.map((entry) => entry.runId)).toEqual(["small"]);
    expect(result.refused).toEqual([
      expect.objectContaining({
        path: join(state, "large.json"),
        code: "runs-record-max-bytes-bound",
      }),
      { path: join(state, "notes.json"), code: "runs-index-record-unsupported-schema" },
    ]);
    expect(result.sources).toEqual([
      { path: state, kind: "state-directory", batchId: null, records: 3 },
    ]);
  });

  it("refuses an index append that would cross runs.indexMaxBytes instead of truncating it", async () => {
    const root = await temporaryRoot("docsfab-runs-index-full-");
    const state = join(root, "runs");
    await mkdir(state);
    for (const id of ["one", "two", "three", "four"]) {
      await writeFile(
        join(state, `${id}.json`),
        JSON.stringify(runRecord(id, "failed", [null, null])),
      );
    }
    // Room for one or two of the four snapshots, not all of them.
    const maxBytes = 8192;
    await lowerLimits(root, { "runs.indexMaxBytes": maxBytes });
    const indexDirectory = join(root, "index");
    const result = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [state],
      docsfabRevision: null,
    });
    expect(result.imported.length).toBeGreaterThan(0);
    expect(result.refused.length).toBeGreaterThan(0);
    expect(result.imported.length + result.refused.length).toBe(4);
    for (const refusal of result.refused) {
      expect(refusal.code).toBe("runs-index-max-bytes-bound");
      expect(refusal.observed).toBeGreaterThan(maxBytes);
    }
    const stored = await readFile(join(indexDirectory, "runs.jsonl"), "utf8");
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(maxBytes);
    expect(stored.endsWith("\n")).toBe(true);
  });

  it("rejects an unsupported field with a typed stop and one next action", () => {
    expect(() => parseRunsQueryArguments(["--group-by", "prose"])).toThrow(RunsOperatorError);
    let thrown: unknown;
    try {
      parseRunsQueryArguments(["--where", "rejectionCode"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "runs-query-invalid-arguments",
      nextAction: "docsfab runs query --help",
    });
    expect(() => parseRunsQueryArguments(["--since", "yesterday"])).toThrow(/--since/u);
  });
});

describe("docsfab runs import re-projection (#1230)", () => {
  it("re-indexes a record an earlier projection indexed and counts its quality-validation code", async () => {
    const root = await temporaryRoot("docsfab-runs-index-reproject-");
    const indexDirectory = join(root, "index");
    const record = runRecord("run-quality", "failed", []) as unknown as Record<string, unknown>;
    record.steps = [
      {
        id: "evaluate-document-quality",
        title: "Evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "failed",
        inference: {
          attempts: [{ attempt: 1, outcome: "succeeded", retryable: false, durationMs: 5 }],
        },
        qualityValidationRejection: {
          validator: "evaluation",
          code: "layer-confidence-exceeds-dimensions",
          location: "$.layers.trustworthy_information.confidence",
          issueCount: 1,
        },
      },
    ];
    const path = join(root, "run-quality.json");
    const bytes = JSON.stringify(record);
    await writeFile(path, bytes);

    // A snapshot from an older projection: no revision, no quality step row.
    const earlier = projectRunIndexRows(JSON.parse(bytes), {
      origin: "import",
      snapshotId: "earlier",
      indexedAt: "2026-09-23T12:00:00.000Z",
      recordSha256: sha256Hex(bytes),
      fieldMaxChars: 512,
    });
    if (!earlier.ok) throw new Error("fixture record refused");
    const earlierRows = earlier.rows
      .filter((row) => row.rowKind !== "step")
      .map(({ projectionRevision: _revision, rejectedReplyParseCode: _code, ...row }) => ({
        ...row,
        snapshotRows: 2,
      }));
    await appendRunIndexSnapshot({
      indexDirectory,
      rows: earlierRows as never,
      maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
    });

    const request = {
      command: "import" as const,
      help: false,
      json: true,
      indexDirectory,
      paths: [path],
      docsfabRevision: null,
    };
    const imported = await runRunsImport(request);
    expect(imported.unchanged).toEqual([]);
    expect(imported.imported).toEqual([{ runId: "run-quality", caseKey: null, rows: 3 }]);
    // The current projection's snapshot is then left unchanged.
    expect((await runRunsImport(request)).unchanged).toHaveLength(1);

    const io = await captureIo(() =>
      handleRunsCommand([
        "query",
        "--index-dir",
        indexDirectory,
        "--where",
        "rowKind=step",
        "--group-by",
        "rejectionSource,rejectionCode,rejectionLocation",
        "--json",
      ]),
    );
    expect((JSON.parse(io.stdout) as Record<string, unknown>).groups).toEqual([
      {
        key: {
          rejectionSource: "quality-validation",
          rejectionCode: "layer-confidence-exceeds-dimensions",
          rejectionLocation: "$.layers.trustworthy_information.confidence",
        },
        rows: 1,
        runs: 1,
        share: 1,
      },
    ]);
  });
});

describe("docsfab runs import re-projection of revision 9 and 10 snapshots", () => {
  it.each([9, 10])(
    "re-indexes a revision-%s snapshot so its attempt rows gain the read-loop counters",
    async (revision) => {
      expect(RUN_INDEX_PROJECTION_REVISION).toBeGreaterThan(revision);
      const root = await temporaryRoot("docsfab-runs-index-reproject-read-loop-");
      const indexDirectory = join(root, "index");
      const record = runRecord("run-read-loop", "failed", []) as unknown as Record<string, unknown>;
      record.steps = [
        {
          id: "plan-documentation",
          title: "Plan",
          skill: "plan-documentation",
          mode: "read-only",
          status: "failed",
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "no-progress",
                retryable: false,
                durationMs: 5,
                tools: {
                  totalCalls: 30,
                  failedCalls: 0,
                  byTool: [],
                  failureCategories: [],
                  readEvidence: {
                    unchangedReReads: 25,
                    withheld: 9,
                    maxRepeatsOfOneResult: 4,
                    maxUnchangedReReadsAcrossResults: 25,
                  },
                },
              },
            ],
          },
        },
      ];
      const path = join(root, "run-read-loop.json");
      const bytes = JSON.stringify(record);
      await writeFile(path, bytes);
      // The snapshot that projection revision wrote: no read-loop fields.
      const earlier = projectRunIndexRows(JSON.parse(bytes), {
        origin: "import",
        snapshotId: "earlier",
        indexedAt: "2026-10-01T12:00:00.000Z",
        recordSha256: sha256Hex(bytes),
        fieldMaxChars: 512,
      });
      if (!earlier.ok) throw new Error("fixture record refused");
      const earlierRows = earlier.rows.map(
        ({
          unchangedReReads: _a,
          readLoopWithheld: _b,
          maxRepeatsOfOneResult: _c,
          maxUnchangedReReadsAcrossResults: _d,
          executionCeilingSource: _e,
          ...row
        }) => ({ ...row, projectionRevision: revision }),
      );
      await appendRunIndexSnapshot({
        indexDirectory,
        rows: earlierRows as never,
        maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
      });
      const request = {
        command: "import" as const,
        help: false,
        json: true,
        indexDirectory,
        paths: [path],
        docsfabRevision: null,
      };

      const imported = await runRunsImport(request);
      expect(imported.unchanged).toEqual([]);
      expect((await runRunsImport(request)).unchanged).toHaveLength(1);
      const io = await captureIo(() =>
        handleRunsCommand([
          "query",
          "--index-dir",
          indexDirectory,
          "--group-by",
          "unchangedReReads,maxUnchangedReReadsAcrossResults",
          "--json",
        ]),
      );
      expect((JSON.parse(io.stdout) as Record<string, unknown>).groups).toMatchObject([
        { key: { unchangedReReads: 25, maxUnchangedReReadsAcrossResults: 25 }, rows: 1 },
      ]);
    },
  );
});

describe("docsfab runs import re-projection for telemetry and failure classes (#1236)", () => {
  /** A failed run shaped like a recorded create-cli failure. */
  async function writeTelemetryRecord(root: string): Promise<{ path: string; bytes: string }> {
    const record = runRecord("run-telemetry", "failed", []) as unknown as Record<string, unknown>;
    const failure = { class: "unknown", layer: "inference", code: "provider-terminal" };
    record.failure = failure;
    record.steps = [
      {
        id: "evaluate-document-quality",
        title: "Evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "failed",
        failure,
        inference: {
          attempts: [
            {
              attempt: 1,
              outcome: "provider-terminal",
              retryable: false,
              durationMs: 364100,
              modelTelemetry: {
                schemaVersion: 1,
                finishReason: "error",
                outputAllowance: 128000,
                providerLatencyMs: 364012,
                providerError: { class: "network" },
              },
            },
          ],
        },
      },
    ];
    const path = join(root, "run-telemetry.json");
    const bytes = JSON.stringify(record);
    await writeFile(path, bytes);
    return { path, bytes };
  }

  function projectAt(bytes: string, snapshotId: string) {
    const projection = projectRunIndexRows(JSON.parse(bytes), {
      origin: "import",
      snapshotId,
      indexedAt: "2026-09-23T12:00:00.000Z",
      recordSha256: sha256Hex(bytes),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error("fixture record refused");
    return projection.rows;
  }

  it("re-indexes a revision-2 snapshot, fills the new fields, and is a no-op at revision 3", async () => {
    const root = await temporaryRoot("docsfab-runs-index-telemetry-");
    const indexDirectory = join(root, "index");
    const { path, bytes } = await writeTelemetryRecord(root);
    // A revision-2 snapshot, without the later columns.
    const earlierRows = projectAt(bytes, "earlier").map(
      ({
        failureLayer: _layer,
        providerErrorClass: _class,
        httpStatus: _status,
        outputTokens: _tokens,
        outputAllowance: _allowance,
        providerLatencyMs: _latency,
        ...row
      }) => ({
        ...row,
        projectionRevision: 2,
        failureClass: row.rowKind === "attempt" ? "provider-terminal" : null,
        finishReason: null,
      }),
    );
    await appendRunIndexSnapshot({
      indexDirectory,
      rows: earlierRows as never,
      maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
    });
    const query = [
      "query",
      "--index-dir",
      indexDirectory,
      "--where",
      "rowKind=run",
      "--where",
      "rowKind=attempt",
      "--group-by",
      "rowKind,finishReason,providerErrorClass,failureClass,failureLayer",
      "--json",
    ];
    const before = JSON.parse((await captureIo(() => handleRunsCommand(query))).stdout) as {
      groups: { key: Record<string, unknown> }[];
    };
    // Rows the earlier revision wrote read the changed columns as unavailable.
    expect(before.groups.map((group) => group.key)).toEqual([
      {
        rowKind: "attempt",
        finishReason: null,
        providerErrorClass: null,
        failureClass: null,
        failureLayer: null,
      },
      {
        rowKind: "run",
        finishReason: null,
        providerErrorClass: null,
        failureClass: null,
        failureLayer: null,
      },
    ]);

    const request = {
      command: "import" as const,
      help: false,
      json: true,
      indexDirectory,
      paths: [path],
      docsfabRevision: null,
    };
    const imported = await runRunsImport(request);
    expect(imported.unchanged).toEqual([]);
    expect(imported.imported).toEqual([{ runId: "run-telemetry", caseKey: null, rows: 2 }]);
    const again = await runRunsImport(request);
    expect(again.imported).toEqual([]);
    expect(again.unchanged).toEqual([{ runId: "run-telemetry", caseKey: null }]);

    const after = JSON.parse((await captureIo(() => handleRunsCommand(query))).stdout) as {
      groups: unknown[];
    };
    expect(after.groups).toEqual([
      {
        key: {
          rowKind: "attempt",
          finishReason: "error",
          providerErrorClass: "network",
          // A recorded provider error splits provider-terminal.
          failureClass: "infrastructure",
          failureLayer: "inference",
        },
        rows: 1,
        runs: 1,
        share: 0.5,
      },
      {
        key: {
          rowKind: "run",
          finishReason: null,
          providerErrorClass: null,
          failureClass: "unknown",
          failureLayer: "inference",
        },
        rows: 1,
        runs: 1,
        share: 0.5,
      },
    ]);
    const text = await captureIo(() =>
      handleRunsCommand([
        "query",
        "--index-dir",
        indexDirectory,
        "--group-by",
        "finishReason,providerErrorClass,httpStatus,outputAllowance",
      ]),
    );
    expect(text.stdout).toContain(
      "finishReason=error providerErrorClass=network httpStatus=unavailable outputAllowance=128000",
    );
  });

  it("re-indexes a snapshot another attempt classifier wrote, and reads its classes as unavailable until then", async () => {
    const root = await temporaryRoot("docsfab-runs-index-classifier-");
    const indexDirectory = join(root, "index");
    const { path, bytes } = await writeTelemetryRecord(root);
    // The same revision, bytes, and labels, written before a class-table change.
    const olderRows = projectAt(bytes, "older-classifier").map((row) =>
      row.rowKind === "attempt"
        ? { ...row, attemptClassifierSha256: "0".repeat(64), failureClass: "flake" as const }
        : row,
    );
    await appendRunIndexSnapshot({
      indexDirectory,
      rows: olderRows,
      maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
    });
    const query = [
      "query",
      "--index-dir",
      indexDirectory,
      "--group-by",
      "failureClass,failureLayer",
      "--json",
    ];
    const groups = async () =>
      (
        JSON.parse((await captureIo(() => handleRunsCommand(query))).stdout) as {
          groups: unknown[];
        }
      ).groups;
    // The older classifier's reading is not reported as this one's.
    expect(await groups()).toEqual([
      { key: { failureClass: null, failureLayer: null }, rows: 1, runs: 1, share: 1 },
    ]);
    const request = {
      command: "import" as const,
      help: false,
      json: true,
      indexDirectory,
      paths: [path],
      docsfabRevision: null,
    };
    // Naming the record twice re-projects it once: the second copy then
    // compares against the snapshot this import just wrote.
    const imported = await runRunsImport({ ...request, paths: [path, path] });
    expect(imported.imported).toEqual([{ runId: "run-telemetry", caseKey: null, rows: 2 }]);
    expect(imported.unchanged).toEqual([{ runId: "run-telemetry", caseKey: null }]);
    expect((await runRunsImport(request)).unchanged).toEqual([
      { runId: "run-telemetry", caseKey: null },
    ]);
    expect(await groups()).toEqual([
      {
        key: { failureClass: "infrastructure", failureLayer: "inference" },
        rows: 1,
        runs: 1,
        share: 1,
      },
    ]);
  });

  it("refuses a failureClass or failureLayer value outside its closed list and points to outcome", () => {
    let thrown: unknown;
    try {
      parseRunsQueryArguments(["--where", "failureClass=malformed-response"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "runs-query-invalid-arguments",
      nextAction: "docsfab runs query --help",
    });
    expect((thrown as Error).message).toContain("--where outcome=malformed-response");
    expect(() => parseRunsQueryArguments(["--where", "failureLayer=network"])).toThrow(
      /failureLayer value "network" is not one of cli, workflow, inference, host, harness/u,
    );
    for (const clause of [
      "failureClass=unknown",
      "failureClass=unavailable",
      "failureLayer=inference",
    ]) {
      expect(parseRunsQueryArguments(["--where", clause]).where.size).toBe(1);
    }
  });

  it("leaves a snapshot a later projection revision wrote unchanged", async () => {
    const root = await temporaryRoot("docsfab-runs-index-newer-");
    const indexDirectory = join(root, "index");
    const { path, bytes } = await writeTelemetryRecord(root);
    const newerRows = projectAt(bytes, "newer").map((row) => ({
      ...row,
      projectionRevision: RUN_INDEX_PROJECTION_REVISION + 1,
    }));
    await appendRunIndexSnapshot({
      indexDirectory,
      rows: newerRows,
      maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
    });
    const result = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [path],
      docsfabRevision: null,
    });
    // Re-projecting it here would replace the newer rows and drop their newer fields.
    expect(result.imported).toEqual([]);
    expect(result.unchanged).toEqual([{ runId: "run-telemetry", caseKey: null }]);
    const stored = await readFile(join(indexDirectory, "runs.jsonl"), "utf8");
    expect(stored.trimEnd().split("\n")).toHaveLength(newerRows.length);
  });
});

describe("docsfab runs import re-projection for verifier disagreement (#1439)", () => {
  it("re-indexes a revision-4 snapshot and groups runs by verifierDisagreementCount", async () => {
    const root = await temporaryRoot("docsfab-runs-index-verifier-");
    const indexDirectory = join(root, "index");
    const record = runRecord("run-verifier", "failed", []) as unknown as Record<string, unknown>;
    record.steps = [
      {
        id: "verify-technical-accuracy",
        title: "Verify",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: "failed",
        inference: { attempts: [{ attempt: 1, outcome: "succeeded", durationMs: 5 }] },
        verifierDisagreement: {
          schemaVersion: 1,
          kind: "docsfab-verifier-disagreement",
          provisionalStepId: "provisional-technical-verification",
          status: "compared",
          rows: [
            { kind: "canonical-issue", canonicalIssueId: "TECH-001", category: "completeness" },
            {
              kind: "canonical-issue",
              canonicalIssueId: "TECH-002",
              category: "technical_accuracy",
            },
          ],
        },
      },
    ];
    const path = join(root, "run-verifier.json");
    const bytes = JSON.stringify(record);
    await writeFile(path, bytes);

    // The snapshot the #1343 projection wrote: revision 4, no count column.
    const earlier = projectRunIndexRows(JSON.parse(bytes), {
      origin: "import",
      snapshotId: "earlier",
      indexedAt: "2026-09-25T12:00:00.000Z",
      recordSha256: sha256Hex(bytes),
      fieldMaxChars: 512,
    });
    if (!earlier.ok) throw new Error("fixture record refused");
    await appendRunIndexSnapshot({
      indexDirectory,
      rows: earlier.rows.map(({ verifierDisagreementCount: _count, ...row }) => ({
        ...row,
        projectionRevision: 4,
      })) as never,
      maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
    });
    const query = [
      "query",
      "--index-dir",
      indexDirectory,
      "--where",
      "rowKind=run",
      "--group-by",
      "verifierDisagreementCount",
      "--json",
    ];
    const groupsOf = async () =>
      (JSON.parse((await captureIo(() => handleRunsCommand(query))).stdout) as { groups: unknown })
        .groups;
    // The revision-4 row reads the column as unavailable.
    expect(await groupsOf()).toEqual([
      { key: { verifierDisagreementCount: null }, rows: 1, runs: 1, share: 1 },
    ]);

    const request = {
      command: "import" as const,
      help: false,
      json: true,
      indexDirectory,
      paths: [path],
      docsfabRevision: null,
    };
    const imported = await runRunsImport(request);
    expect(imported.unchanged).toEqual([]);
    // Run, attempt, and the step row of a step that failed after its attempt succeeded.
    expect(imported.imported).toEqual([{ runId: "run-verifier", caseKey: null, rows: 3 }]);
    expect((await runRunsImport(request)).unchanged).toEqual([
      { runId: "run-verifier", caseKey: null },
    ]);
    expect(await groupsOf()).toEqual([
      { key: { verifierDisagreementCount: 2 }, rows: 1, runs: 1, share: 1 },
    ]);
  });
});

describe("docsfab runs import record coverage", () => {
  it("indexes a step-less failed record and lists unfinished records without indexing them", async () => {
    const root = await temporaryRoot("docsfab-runs-index-stepless-");
    const state = join(root, "runs");
    await mkdir(state);
    await writeFile(
      join(state, "preflight-stop.json"),
      JSON.stringify({ ...runRecord("preflight-stop", "failed", []), steps: [] }),
    );
    await writeFile(
      join(state, "in-flight.json"),
      JSON.stringify(runRecord("in-flight", "running", [null])),
    );
    const indexDirectory = join(root, "index");
    const result = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [state],
      docsfabRevision: null,
    });
    expect(result.imported).toEqual([{ runId: "preflight-stop", caseKey: null, rows: 1 }]);
    expect(result.notTerminal).toEqual([
      { path: join(state, "in-flight.json"), runId: "in-flight", status: "running" },
    ]);
    expect(result.refused).toEqual([]);

    const runs = await runRunsQuery(
      parseRunsQueryArguments([
        "--index-dir",
        indexDirectory,
        "--where",
        "rowKind=run",
        "--where",
        "runStatus=failed",
        "--group-by",
        "workflow",
      ]),
    );
    expect(runs.groups).toEqual([
      { key: { workflow: "restructure-documentation" }, rows: 1, runs: 1, share: 1 },
    ]);
  });
});

describe("run index written with the run record", () => {
  it("indexes a step-less terminal save made through the CLI store factory", async () => {
    const root = await temporaryRoot("docsfab-runs-index-factory-");
    const state = join(root, "runs");
    await createIndexedFileRunStore(state).save({
      ...runRecord("knowledge-stop", "needs-input", []),
      steps: [],
    });
    const envelope = await runRunsQuery(
      parseRunsQueryArguments([
        "--state-dir",
        state,
        "--where",
        "rowKind=run",
        "--group-by",
        "runStatus",
      ]),
    );
    expect(envelope.groups).toEqual([
      { key: { runStatus: "needs-input" }, rows: 1, runs: 1, share: 1 },
    ]);
  });

  it("fails open: an unwritable index never fails the save and names the loss on stderr", async () => {
    const root = await temporaryRoot("docsfab-runs-index-failopen-");
    const state = join(root, "runs");
    // The index directory path is a regular file, so neither rows nor overflow can be written.
    await writeFile(join(root, "run-index"), "not a directory");
    const stderr = captureStderr();
    const store = createIndexedFileRunStore(state);
    await expect(store.save(runRecord("saved-anyway", "failed", [null]))).resolves.toBeUndefined();
    await expect(readFile(join(state, "saved-anyway.json"), "utf8")).resolves.toContain(
      "saved-anyway",
    );
    // A direct stderr line, not a Node warning that NODE_NO_WARNINGS would hide.
    expect(stderr.text()).toContain("WARNING runs-index-io-failed: Run saved-anyway was saved");
    expect(stderr.text()).toContain(
      `Move ${join(root, "run-index")} aside, then rebuild it with docsfab runs import ${state} --index-dir ${join(root, "run-index")}.`,
    );
  });

  it("contains a throwing after-save hook in the store itself", async () => {
    const root = await temporaryRoot("docsfab-runs-index-hook-");
    const stderr = captureStderr();
    const store = new FileRunStore(join(root, "runs"), {
      afterSave: async () => {
        throw new Error("hook failure used by this test only");
      },
    });
    await expect(store.save(runRecord("hooked", "failed", [null]))).resolves.toBeUndefined();
    expect(stderr.text()).toContain("WARNING run-store-after-save-failed: Run hooked was saved");
  });

  it("contains a cut-short append without removing bytes, and an in-place import repairs it", async () => {
    const root = await temporaryRoot("docsfab-runs-index-short-");
    const state = join(root, "runs");
    const indexDirectory = join(root, "run-index");
    const indexFile = join(indexDirectory, "runs.jsonl");
    await createIndexedFileRunStore(state).save(runRecord("first", "failed", [null]));
    const before = await readFile(indexFile, "utf8");

    captureStderr();
    const failing = new FileRunStore(state, {
      afterSave: createRunStoreIndexer(state, {
        append: {
          writeAll: async (handle, bytes) => {
            // One whole row plus part of the next, then the disk fills.
            await handle.write(bytes, 0, bytes.indexOf(0x0a) + 12);
            throw new Error("simulated disk full");
          },
        },
      }),
    });
    await failing.save(runRecord("second", "failed", [null]));
    // Nothing is truncated: the fragment stays, and the failure is recorded.
    const afterFailure = await readFile(indexFile, "utf8");
    expect(afterFailure.startsWith(before)).toBe(true);
    expect(afterFailure.length).toBeGreaterThan(before.length);
    const overflow = JSON.parse(
      await readFile(join(indexDirectory, RUN_INDEX_OVERFLOW_FILE_NAME), "utf8"),
    ) as Record<string, unknown>;
    expect(overflow).toMatchObject({
      lastRefusedRunId: "second",
      lastRefusal: { code: "runs-index-io-failed" },
    });

    // The next append starts on its own line, so the fragment never joins a row.
    await createIndexedFileRunStore(state).save(runRecord("third", "failed", [null]));
    const partial = await runRunsQuery(
      parseRunsQueryArguments(["--state-dir", state, "--group-by", "runId"]),
    );
    expect(partial.index.incompleteSnapshots).toBe(1);
    expect(partial.index.unreadableLines).toBe(1);
    expect(partial.groups.map((group) => group.key.runId)).toEqual(["first", "third"]);
    const query = await captureIo(() => handleRunsCommand(["query", "--state-dir", state]));
    expect(query.stdout).toContain("Incomplete snapshots: 1 appends were cut short");
    expect(query.stdout).toContain(`Move ${indexDirectory} aside`);

    // Re-importing in place compares against complete snapshots only.
    const repaired = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [state],
      docsfabRevision: null,
    });
    expect(repaired.imported.map((entry) => entry.runId)).toEqual(["second"]);
    expect(repaired.unchanged.map((entry) => entry.runId)).toEqual(["first", "third"]);
    const complete = await runRunsQuery(
      parseRunsQueryArguments(["--state-dir", state, "--group-by", "runId"]),
    );
    expect(complete.groups.map((group) => group.key.runId)).toEqual(["first", "second", "third"]);
  });

  it("preserves a later writer's snapshot after a failing append", async () => {
    const root = await temporaryRoot("docsfab-runs-index-two-writers-");
    const indexDirectory = join(root, "index");
    const maxBytes = limit(RUN_INDEX_LIMITS.indexMaxBytes);
    const rowsOf = (id: string) => {
      const projection = projectRunIndexRows(runRecord(id, "failed", [null]), {
        origin: "run-store",
        snapshotId: `snapshot-${id}`,
        indexedAt: "2026-09-23T12:00:00.000Z",
        recordSha256: "f".repeat(64),
        fieldMaxChars: 512,
      });
      if (!projection.ok) throw new Error("fixture record refused by the projection");
      return projection.rows;
    };
    await appendRunIndexSnapshot({ indexDirectory, rows: rowsOf("first"), maxBytes });

    await expect(
      appendRunIndexSnapshot(
        { indexDirectory, rows: rowsOf("writer-a"), maxBytes },
        {
          writeAll: async (handle, bytes) => {
            // A write failure may leave an incomplete snapshot. The index gate
            // serializes the next writer so its complete snapshot remains intact.
            await handle.write(bytes, 0, bytes.indexOf(0x0a) + 12);
            throw new Error("simulated ENOSPC");
          },
        },
      ),
    ).rejects.toBeInstanceOf(RunIndexStoreError);
    const b = await appendRunIndexSnapshot({
      indexDirectory,
      rows: rowsOf("writer-b"),
      maxBytes,
    });
    expect(b.status).toBe("appended");

    const envelope = await runRunsQuery(
      parseRunsQueryArguments([
        "--index-dir",
        indexDirectory,
        "--where",
        "rowKind=run",
        "--group-by",
        "runId",
      ]),
    );
    expect(envelope.groups.map((group) => group.key.runId)).toEqual(["first", "writer-b"]);
    expect(envelope.index.incompleteSnapshots).toBe(1);
  });

  it("writes every byte through short writes and refuses a write that makes no progress", async () => {
    const written: string[] = [];
    const counts = [3, 2];
    await writeRunIndexBytes(
      {
        write: async (buffer, offset, length) => {
          const bytesWritten = counts.shift() ?? length;
          written.push(buffer.subarray(offset, offset + bytesWritten).toString("utf8"));
          return { bytesWritten };
        },
      },
      Buffer.from("hello, index\n"),
    );
    expect(written).toEqual(["hel", "lo", ", index\n"]);

    let calls = 0;
    await expect(
      writeRunIndexBytes(
        {
          write: async () => {
            calls += 1;
            if (calls > 1) throw new Error("the loop wrote again after a zero-byte write");
            return { bytesWritten: 0 };
          },
        },
        Buffer.from("x\n"),
      ),
    ).rejects.toBeInstanceOf(RunIndexStoreError);
  });

  it("appends rows only for terminal saves and counts a re-saved run once", async () => {
    const root = await temporaryRoot("docsfab-runs-index-store-");
    const state = join(root, "runs");
    const store = new FileRunStore(state, { afterSave: createRunStoreIndexer(state) });
    const locators = { code: "inventory-fact-locators", location: "$.factInventory" };

    await store.save(runRecord("live-run", "running", [locators]));
    const indexDirectory = defaultRunIndexDirectory(state);
    expect(indexDirectory).toBe(join(root, "run-index"));
    await expect(readFile(join(indexDirectory, "runs.jsonl"), "utf8")).rejects.toThrow();

    await store.save(runRecord("live-run", "failed", [locators]));
    await store.save(runRecord("live-run", "failed", [locators, locators]));

    const envelope = await runRunsQuery(
      parseRunsQueryArguments(["--state-dir", state, "--group-by", "origin,rejectionCode"]),
    );
    // Snapshot one: run row and one attempt; snapshot two: run row and two attempts.
    expect(envelope.index.storedRows).toBe(5);
    expect(envelope.index.supersededRows).toBe(2);
    expect(envelope.groups).toEqual([
      {
        key: { origin: "run-store", rejectionCode: "inventory-fact-locators" },
        rows: 2,
        runs: 1,
        share: 1,
      },
    ]);
  });

  it("records a refused snapshot in the overflow file and every query reports it", async () => {
    const root = await temporaryRoot("docsfab-runs-index-overflow-");
    const state = join(root, "runs");
    await lowerLimits(root, { "runs.indexMaxBytes": 4096 });
    const store = new FileRunStore(state, { afterSave: createRunStoreIndexer(state) });
    const many = Array.from({ length: 8 }, () => null);
    await store.save(runRecord("too-big", "failed", many));

    const overflow = JSON.parse(
      await readFile(join(root, "run-index", RUN_INDEX_OVERFLOW_FILE_NAME), "utf8"),
    ) as Record<string, unknown>;
    expect(overflow).toMatchObject({
      kind: "docsfab-run-index-overflow",
      refusedSnapshots: 1,
      lastRefusedRunId: "too-big",
      lastRefusal: {
        code: "runs-index-max-bytes-bound",
        limitName: "runs.indexMaxBytes",
        limitValue: 4096,
      },
    });
    await expect(readFile(join(state, "too-big.json"), "utf8")).resolves.toContain("too-big");

    const io = await captureIo(() => handleRunsCommand(["query", "--state-dir", state]));
    expect(io.stdout).toContain("INCOMPLETE: 1 run snapshots were not indexed (last too-big");
    expect(io.stdout).toContain("runs.indexMaxBytes = 4096");
    expect(io.stdout).toContain(`Clear the cause, then: Move ${join(root, "run-index")} aside`);
  });
});

describe("run index DocsFab revision from the build (#1688)", () => {
  const BUILD = "b".repeat(40);
  const modelled = (record: RunRecord): RunRecord => ({
    ...record,
    models: [{ provider: "nvidia-api-catalog", model: "nvidia/model-a" }],
  });
  const revisionGroups = async (state: string) =>
    (
      await runRunsQuery(
        parseRunsQueryArguments([
          "--state-dir",
          state,
          "--where",
          "rowKind=run",
          "--group-by",
          "model,docsfabRevision",
        ]),
      )
    ).groups;

  it("stamps the build revision the run store wrote, and runs import keeps it for identical bytes", async () => {
    const root = await temporaryRoot("docsfab-runs-index-build-");
    const state = join(root, "runs");
    const store = new FileRunStore(state, {
      afterSave: createRunStoreIndexer(state, { docsfabRevision: BUILD }),
    });
    await store.save(modelled(runRecord("run-built", "failed", [null])));
    const built = [
      { key: { model: "nvidia/model-a", docsfabRevision: BUILD }, rows: 1, runs: 1, share: 1 },
    ];
    expect(await revisionGroups(state)).toEqual(built);

    // Rebuilding the index from the same record, without the flag, keeps the revision.
    const rebuild = {
      command: "import" as const,
      help: false,
      json: true,
      indexDirectory: defaultRunIndexDirectory(state),
      paths: [state],
      docsfabRevision: null,
    };
    const again = await runRunsImport(rebuild);
    expect(again.unchanged).toEqual([{ runId: "run-built", caseKey: null }]);
    expect(await revisionGroups(state)).toEqual(built);

    // A declared revision still overrides, and changed bytes carry no build.
    await runRunsImport({ ...rebuild, docsfabRevision: "c".repeat(40) });
    expect(await revisionGroups(state)).toEqual([
      {
        key: { model: "nvidia/model-a", docsfabRevision: "c".repeat(40) },
        rows: 1,
        runs: 1,
        share: 1,
      },
    ]);
    const elsewhere = join(root, "elsewhere", "runs");
    await new FileRunStore(elsewhere).save(
      modelled(runRecord("run-built", "failed", [null, null])),
    );
    await runRunsImport({ ...rebuild, paths: [elsewhere] });
    expect(await revisionGroups(state)).toEqual([
      { key: { model: "nvidia/model-a", docsfabRevision: null }, rows: 1, runs: 1, share: 1 },
    ]);
  });

  it("carries a re-imported revision onto every row of the snapshot", async () => {
    const root = await temporaryRoot("docsfab-runs-index-build-rows-");
    const state = join(root, "runs");
    const indexDirectory = defaultRunIndexDirectory(state);
    const store = new FileRunStore(state, {
      afterSave: createRunStoreIndexer(state, { docsfabRevision: BUILD }),
    });
    await store.save(modelled(runRecord("run-rows", "failed", [null, null])));
    // An earlier projection's snapshot is re-projected, so the revision must be carried over.
    const stored = (await readFile(join(indexDirectory, "runs.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => ({ ...(JSON.parse(line) as object), projectionRevision: 5 }));
    await rm(join(indexDirectory, "runs.jsonl"));
    await appendRunIndexSnapshot({
      indexDirectory,
      rows: stored as never,
      maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
    });
    const result = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [state],
      docsfabRevision: null,
    });
    expect(result.imported).toEqual([{ runId: "run-rows", caseKey: null, rows: 3 }]);
    const envelope = await runRunsQuery(
      parseRunsQueryArguments([
        "--state-dir",
        state,
        "--where",
        "rowKind=run",
        "--where",
        "rowKind=attempt",
        "--group-by",
        "docsfabRevision",
      ]),
    );
    expect(envelope.groups).toEqual([
      { key: { docsfabRevision: BUILD }, rows: 3, runs: 1, share: 1 },
    ]);
  });
});

async function captureIo(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => errors.push(String(message ?? ""));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

/** Capture direct stderr writes for the rest of the test; `vi.restoreAllMocks` undoes it. */
function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

describe("docsfab runs query RUN ENDS (#1738)", () => {
  /** A step 8 quality refusal: every attempt succeeded, the step and run failed. */
  function qualityRefusedRun(id: string, model: string): RunRecord {
    const failure = {
      class: "model-content",
      layer: "workflow",
      code: "candidate-target-outside-scope",
    };
    return {
      ...runRecord(id, "failed", []),
      workflow: "review-documentation",
      failure,
      models: [{ provider: "fixture-provider", model }],
      steps: [
        {
          id: "evaluate-document-quality",
          title: "Evaluate",
          skill: "evaluate-document-quality",
          mode: "read-only",
          status: "failed",
          failure,
          qualityValidationRejection: {
            code: "candidate-target-outside-scope",
            location: "$.evaluation.target.paths",
          },
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "succeeded",
                retryable: false,
                retryScheduled: false,
                durationMs: 5,
                model: { provider: "fixture-provider", model },
              },
            ],
          },
        },
      ],
    } as unknown as RunRecord;
  }

  async function importedIndex(records: readonly RunRecord[]): Promise<string> {
    const root = await temporaryRoot("docsfab-runs-ends-");
    const state = join(root, "runs");
    await mkdir(state);
    for (const value of records) {
      await writeFile(join(state, `${value.id}.json`), JSON.stringify(value));
    }
    const indexDirectory = join(root, "index");
    await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory,
      paths: [state],
      docsfabRevision: null,
    });
    return indexDirectory;
  }

  const query = (indexDirectory: string, ...args: string[]) =>
    runRunsQuery(parseRunsQueryArguments(["--index-dir", indexDirectory, ...args]));

  it("shows how every run ended on a plain query, including a run with no attempts", async () => {
    const indexDirectory = await importedIndex([
      qualityRefusedRun("run-refused", "fixture/model-a"),
      {
        ...runRecord("run-preflight", "failed", []),
        steps: [],
      } as unknown as RunRecord,
      runRecord("run-malformed", "failed", [{ code: "invalid-json", location: "$" }]),
    ]);

    const envelope = await query(indexDirectory);

    // The default population still counts attempts only.
    expect(envelope.filters).toMatchObject({
      where: { rowKind: ["attempt"] },
      rowKindDefaulted: true,
    });
    expect(envelope.population).toMatchObject({ rows: 2, runs: 2 });
    expect(envelope.runEnds.population.runs).toBe(3);
    expect(envelope.runEnds.groupBy).toEqual([
      "workflow",
      "model",
      "runStatus",
      "terminalStepId",
      "failureClass",
      "failureCode",
    ]);
    expect(envelope.runEnds.groups.map((group) => group.key)).toEqual(
      expect.arrayContaining([
        {
          workflow: "review-documentation",
          model: "fixture/model-a",
          runStatus: "failed",
          terminalStepId: "evaluate-document-quality",
          failureClass: "model-content",
          failureCode: "candidate-target-outside-scope",
        },
        expect.objectContaining({ runStatus: "failed", terminalStepId: null }),
        expect.objectContaining({
          terminalStepId: "verify-technical-accuracy",
        }),
      ]),
    );
    expect(envelope.runEnds.earlierProjectionRuns).toBe(0);
    expect(envelope.index.staleClassifierRows).toBe(0);

    const text = (
      await captureIo(() => handleRunsCommand(["query", "--index-dir", indexDirectory]))
    ).stdout;
    expect(text).toContain("RUN ENDS: 3 runs, from each run row");
    expect(text).toContain(
      "  1 runs  workflow=review-documentation model=fixture/model-a runStatus=failed terminalStepId=evaluate-document-quality failureClass=model-content failureCode=candidate-target-outside-scope",
    );
  });

  it("limits the run ends to the runs the filters select", async () => {
    const indexDirectory = await importedIndex([
      qualityRefusedRun("run-model-a", "fixture/model-a"),
      qualityRefusedRun("run-model-b", "fixture/model-b"),
    ]);

    const byModel = await query(indexDirectory, "--where", "model=fixture/model-b");
    expect(byModel.runEnds.population.runs).toBe(1);
    expect(byModel.runEnds.groups[0]!.key).toMatchObject({
      model: "fixture/model-b",
    });

    // An explicit row kind keeps the run ends to the population's own runs.
    const none = await query(indexDirectory, "--where", "rowKind=step", "--where", "stepId=absent");
    expect(none.runEnds).toEqual({
      groupBy: expect.any(Array),
      population: { runs: 0 },
      groups: [],
      earlierProjectionRuns: 0,
    });
    const text = (
      await captureIo(() =>
        handleRunsCommand(["query", "--index-dir", indexDirectory, "--where", "stepId=absent"]),
      )
    ).stdout;
    expect(text).toContain("RUN ENDS: none");
  });

  it("names rows an earlier DocsFab indexed instead of grouping them as unknown silently", async () => {
    const root = await temporaryRoot("docsfab-runs-ends-stale-");
    const indexDirectory = join(root, "index");
    const bytes = JSON.stringify(
      runRecord("run-stale", "failed", [{ code: "invalid-json", location: "$" }]),
    );
    const projection = projectRunIndexRows(JSON.parse(bytes), {
      origin: "import",
      snapshotId: "stale",
      indexedAt: "2026-10-01T09:00:00.000Z",
      recordSha256: sha256Hex(bytes),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error("fixture record refused");
    await appendRunIndexSnapshot({
      indexDirectory,
      rows: projection.rows.map((row) => ({
        ...row,
        projectionRevision: 6,
        ...(row.rowKind === "attempt" ? { attemptClassifierSha256: "0".repeat(64) } : {}),
      })),
      maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
    });

    const envelope = await query(indexDirectory);
    expect(envelope.index.staleClassifierRows).toBe(1);
    expect(envelope.runEnds.earlierProjectionRuns).toBe(1);
    const text = (
      await captureIo(() => handleRunsCommand(["query", "--index-dir", indexDirectory]))
    ).stdout;
    expect(text).toContain(
      "Stale classifier: 1 attempt rows were indexed by a DocsFab that classifies attempts differently, so their failureClass, failureLayer, failureCode, and retryDecisionRule read unavailable. Import their records again: docsfab runs import <state-directory> --index-dir",
    );
    expect(text).toContain(
      "  1 of these runs were indexed before run rows carried terminalStepId and failureCode, so both read unavailable.",
    );
  });

  it("counts a re-indexed run's newest run end only", async () => {
    const root = await temporaryRoot("docsfab-runs-ends-superseded-");
    const indexDirectory = join(root, "index");
    for (const [snapshotId, status] of [
      ["older", "failed"],
      ["newer", "succeeded"],
    ] as const) {
      const value = runRecord("run-resaved", status, []);
      const bytes = JSON.stringify(value);
      const projection = projectRunIndexRows(JSON.parse(bytes), {
        origin: "import",
        snapshotId,
        indexedAt: "2026-10-01T09:00:00.000Z",
        recordSha256: sha256Hex(bytes),
        fieldMaxChars: 512,
      });
      if (!projection.ok) throw new Error("fixture record refused");
      await appendRunIndexSnapshot({
        indexDirectory,
        rows: projection.rows,
        maxBytes: limit(RUN_INDEX_LIMITS.indexMaxBytes),
      });
    }
    const envelope = await query(indexDirectory);
    expect(envelope.runEnds.population.runs).toBe(1);
    expect(envelope.runEnds.groups.map((group) => group.key.runStatus)).toEqual(["succeeded"]);
  });

  it("refuses a retry decision rule outside the closed list and accepts unavailable", () => {
    expect(() =>
      parseRunsQueryArguments(["--where", "retryDecisionRule=declined-because"]),
    ).toThrow(/The retryDecisionRule value "declined-because" is not one of retried, exhausted/u);
    expect(
      parseRunsQueryArguments(["--where", "retryDecisionRule=unavailable"]).where.get(
        "retryDecisionRule",
      ),
    ).toEqual(["unavailable"]);
    expect(
      parseRunsQueryArguments(["--where", "retryDecisionRule=declined-unexplained"]).where.get(
        "retryDecisionRule",
      ),
    ).toEqual(["declined-unexplained"]);
  });
});
