// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleRunsCommand, parseRunsArguments } from "../src/cli/commands/runs.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.js";
import { persistHostedQualityReport } from "../src/evaluation-report/index.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

describe("docsfab runs list", () => {
  it("returns an empty successful projection for missing state", async () => {
    const stateDirectory = await roots.create("docsfab-runs-list-missing-");
    const missing = join(stateDirectory, "missing");
    const io = await captureIo(() => handleRunsCommand(["list", "--json", "--state-dir", missing]));
    expect(JSON.parse(io.stdout)).toEqual({
      schemaVersion: 1,
      kind: "docsfab-run-list",
      runs: [],
    });
    const human = await captureIo(() => handleRunsCommand(["list", "--state-dir", missing]));
    expect(human.stdout).toBe(`No saved runs in ${resolve(missing)}.`);
  });

  it("projects many records newest first with safe artifact and verified report availability", async () => {
    const stateDirectory = await roots.create("docsfab-runs-list-many-");
    await writeRecord(stateDirectory, "older", {
      workflow: "review-documentation",
      status: "failed",
      createdAt: "2026-08-14T10:00:00.000Z",
      startedAt: "2026-08-14T10:01:00.000Z",
      completedAt: "2026-08-14T10:02:00.000Z",
    });
    await writeRecord(stateDirectory, "newer", {
      workflow: "create-documentation",
      status: "succeeded",
      createdAt: "2026-08-15T10:00:00.000Z",
      startedAt: "2026-08-15T10:01:00.000Z",
      completedAt: "2026-08-15T10:02:00.000Z",
      artifacts: [{ role: "output", reference: { kind: "impact-report", digest: "sha256:test" } }],
    });
    await persistHostedQualityReport({
      stateDirectory,
      runId: "newer",
      quality: null,
      markdown: "safe report",
    });

    const io = await captureIo(() =>
      handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
    );
    const envelope = JSON.parse(io.stdout) as { runs: Array<Record<string, unknown>> };
    expect(envelope.runs.map((run) => run.runId)).toEqual(["newer", "older"]);
    expect(envelope.runs[0]).toMatchObject({
      runId: "newer",
      availability: "available",
      workflow: "create-documentation",
      status: "succeeded",
      repository: { path: "/tmp/docsfab-list-repository", revision: "b".repeat(40) },
      startedAt: "2026-08-15T10:01:00.000Z",
      updatedAt: "2026-08-15T10:02:00.000Z",
      artifacts: { available: true, count: 1 },
      report: { available: true },
    });
    expect(io.stdout).not.toContain("safe report");
  });

  it("keeps optional lifecycle timestamps and orders equivalent ISO zones by epoch", async () => {
    const stateDirectory = await roots.create("docsfab-runs-list-time-");
    await writeRecord(stateDirectory, "queued", {
      workflow: "review-documentation",
      status: "queued",
      createdAt: "2026-08-16T10:00:00.000Z",
    });
    await writeRecord(stateDirectory, "running", {
      workflow: "review-documentation",
      status: "running",
      createdAt: "2026-08-16T09:00:00.000Z",
      startedAt: "2026-08-16T09:30:00.000Z",
    });
    await writeRecord(stateDirectory, "zoned", {
      workflow: "review-documentation",
      status: "succeeded",
      createdAt: "2026-08-16T08:00:00.000Z",
      startedAt: "2026-08-16T08:00:00.000Z",
      completedAt: "2026-08-16T12:00:00+02:00",
    });
    const io = await captureIo(() =>
      handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
    );
    const envelope = JSON.parse(io.stdout) as { runs: Array<Record<string, unknown>> };
    expect(envelope.runs.map((run) => run.runId)).toEqual(["zoned", "queued", "running"]);
    expect(envelope.runs.find((run) => run.runId === "queued")).not.toMatchObject({
      availability: "unavailable",
    });
    expect(envelope.runs.find((run) => run.runId === "queued")).not.toHaveProperty("startedAt");
  });

  it("isolates malformed, unsupported, and unreadable records", async () => {
    const stateDirectory = await roots.create("docsfab-runs-list-invalid-");
    await writeFile(join(stateDirectory, "malformed.json"), "{not-json", { mode: 0o600 });
    await writeRecord(stateDirectory, "unsafe", {
      workflow: "review-documentation\nforged-output",
      status: "running",
      startedAt: "2026-08-14T10:00:00.000Z",
      completedAt: "2026-08-14T10:01:00.000Z",
    });
    await writeRecord(stateDirectory, "missing-time", {
      workflow: "review-documentation",
      status: "running",
    });
    await writeFile(
      join(stateDirectory, "unsupported.json"),
      JSON.stringify({ schemaVersion: 1, id: "unsupported" }),
      { mode: 0o600 },
    );
    const unreadable = join(stateDirectory, "unreadable.json");
    await writeRecord(stateDirectory, "unreadable", {
      workflow: "review-documentation",
      status: "running",
      createdAt: "2026-08-14T10:00:00.000Z",
    });
    await chmod(unreadable, 0o000);

    const io = await captureIo(() =>
      handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
    );
    const envelope = JSON.parse(io.stdout) as { runs: Array<Record<string, unknown>> };
    expect(envelope.runs).toEqual(
      expect.arrayContaining([
        { runId: "malformed", availability: "unavailable", reason: "malformed-record" },
        { runId: "unsupported", availability: "unavailable", reason: "unsupported-schema" },
        { runId: "unsafe", availability: "unavailable", reason: "malformed-record" },
        { runId: "missing-time", availability: "unavailable", reason: "malformed-record" },
        expect.objectContaining({ runId: "unreadable", availability: "unavailable" }),
      ]),
    );
    expect(io.stdout).not.toContain("not-json");
  });

  it("lists a record at runs.recordMaxBytes and reports one byte more as too large, not malformed (#1932)", async () => {
    // One raisable bound for every run-record reader, defaulting to at least 64 MiB.
    const definition = LIMIT_DEFINITION_BY_NAME["runs.recordMaxBytes"]!;
    expect(definition.value).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(definition.max).toBeGreaterThan(definition.value);
    expect(definition.override).toBe("DOCSFAB_RUNS_RECORD_MAX_BYTES");
    const stateDirectory = await roots.create("docsfab-runs-list-too-large-");
    const bound = 8192;
    process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES = String(bound);
    await writeRecord(stateDirectory, "at-limit", listedRun("2026-08-17T10:00:00.000Z"), bound);
    await writeRecord(
      stateDirectory,
      "over-limit",
      listedRun("2026-08-17T11:00:00.000Z"),
      bound + 1,
    );

    const io = await captureIo(() =>
      handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
    );
    const envelope = JSON.parse(io.stdout) as { runs: Array<Record<string, unknown>> };
    expect(envelope.runs.find((run) => run.runId === "at-limit")).toMatchObject({
      availability: "available",
    });
    expect(envelope.runs.find((run) => run.runId === "over-limit")).toEqual({
      runId: "over-limit",
      availability: "unavailable",
      reason: "record-too-large",
      limit: {
        name: "runs.recordMaxBytes",
        refusal: "runs-record-max-bytes-bound",
        value: bound,
        observed: bound + 1,
        unit: "bytes",
        remediation: expect.stringContaining("DOCSFAB_RUNS_RECORD_MAX_BYTES"),
      },
    });

    const human = await captureIo(() => handleRunsCommand(["list", "--state-dir", stateDirectory]));
    expect(human.stdout).toContain(
      "over-limit: unavailable (record-too-large: 8193 bytes exceeds runs.recordMaxBytes = 8192 bytes; code runs-record-max-bytes-bound). Set DOCSFAB_RUNS_RECORD_MAX_BYTES",
    );
    expect(human.stdout).not.toContain("malformed");
  });

  it("keeps list parsing read-only and rejects unsupported arguments", () => {
    expect(parseRunsArguments(["list", "--state-dir", "relative"])).toMatchObject({
      command: "list",
      stateDirectory: expect.stringContaining("relative"),
    });
    expect(() => parseRunsArguments(["list", "run-id"])).toThrow(/no positional arguments/u);
    expect(() => parseRunsArguments(["list", "--verbose"])).toThrow(
      /Unknown docsfab runs list option/u,
    );
  });
});

afterEach(() => {
  delete process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES;
});

function listedRun(createdAt: string): Record<string, unknown> {
  return { workflow: "review-documentation", status: "failed", createdAt, completedAt: createdAt };
}

/** Write a record; `bytes` pads it with trailing JSON whitespace to that exact size. */
async function writeRecord(
  stateDirectory: string,
  id: string,
  overrides: Record<string, unknown>,
  bytes?: number,
): Promise<void> {
  const text = JSON.stringify({
    schemaVersion: 2,
    id,
    repository: { sourcePath: "/tmp/docsfab-list-repository", revision: "b".repeat(40) },
    workspace: { strategy: "tracked-export", disposable: true },
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    ...overrides,
  });
  await writeFile(
    join(stateDirectory, `${id}.json`),
    bytes === undefined ? text : `${text}${" ".repeat(bytes - Buffer.byteLength(text))}`,
    { mode: 0o600 },
  );
}

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
