// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectLimits, limit, OperationalLimitError } from "../src/config/limits.js";
import { decodeAcceptanceRunRecord } from "../src/delivery/acceptance.js";
import { runDeliveryAcceptanceCli } from "../src/delivery/acceptance-cli.js";
import { selectOpenEditorialRun } from "../src/inputs/operator-input-fill.js";
import { temporaryRoots } from "./helpers/temp.js";

const OVERRIDE = "DOCSFAB_RUNS_RECORD_MAX_BYTES";
const BOUND = 8192;
const REVISION = "c".repeat(40);
const roots = temporaryRoots();

afterEach(() => {
  delete process.env[OVERRIDE];
  vi.restoreAllMocks();
});

/** A JSON object padded with trailing whitespace to exactly `bytes`. */
function recordText(bytes: number): string {
  const text = JSON.stringify({ schemaVersion: 2, id: "acceptance-run" });
  return `${text}${" ".repeat(bytes - Buffer.byteLength(text))}`;
}

function captureStderr(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

describe("run-record readers under runs.recordMaxBytes (#1932)", () => {
  it("decodes a delivery acceptance record at the bound and refuses one byte more by the bound's code", () => {
    const bound = limit("runs.recordMaxBytes", {
      environment: { [OVERRIDE]: String(BOUND) },
      hostFile: null,
      projectFile: null,
    });
    expect(decodeAcceptanceRunRecord(Buffer.from(recordText(BOUND)), bound)).toMatchObject({
      id: "acceptance-run",
    });
    let refusal: unknown;
    try {
      decodeAcceptanceRunRecord(Buffer.from(recordText(BOUND + 1)), bound);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(OperationalLimitError);
    expect(refusal).toMatchObject({
      code: "runs-record-max-bytes-bound",
      configured: BOUND,
      observed: BOUND + 1,
    });
  });

  it("reads a live acceptance write record at the bound and refuses one byte more by the bound's code", async () => {
    process.env[OVERRIDE] = String(BOUND);
    const root = await roots.create("docsfab-acceptance-record-bound-", { mode: 0o700 });
    const assemble = (writeRecord: string) =>
      runDeliveryAcceptanceCli(
        ["--assemble-chain", "--tested-revision", REVISION, "--write-record", writeRecord],
        {
          currentDocsFabRevision: async () => REVISION,
          assembleChain: () => {
            throw new Error("The chain is never assembled in this test.");
          },
        },
      );

    // At the bound the record is read, and the next missing input stops the chain.
    const atLimit = join(root, "at-limit.json");
    await writeFile(atLimit, recordText(BOUND), { mode: 0o600 });
    await expect(assemble(atLimit)).rejects.toThrow("--readiness-record is required.");

    const overLimit = join(root, "over-limit.json");
    await writeFile(overLimit, recordText(BOUND + 1), { mode: 0o600 });
    await expect(assemble(overLimit)).rejects.toMatchObject({
      code: "runs-record-max-bytes-bound",
      configured: BOUND,
      observed: BOUND + 1,
      message: expect.stringContaining(
        "runs-record-max-bytes-bound: 8193 exceeds runs.recordMaxBytes = 8192 bytes.",
      ),
    });
  });

  it("refuses an explicit continuation whose successor record is over the bound by the bound's code", async () => {
    process.env[OVERRIDE] = String(BOUND);
    const stateDirectory = await roots.create("docsfab-successor-record-bound-");
    await mkdir(join(stateDirectory, "input-ask-supersession"), { mode: 0o700 });
    await writeFile(
      join(stateDirectory, "input-ask-supersession", "original.1.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-input-ask-supersession",
        originalRunId: "original",
        supersededBy: "successor",
        sequence: 1,
        owner: { pid: 0, processBirthIdentity: null },
      }),
      { mode: 0o600 },
    );
    captureStderr();
    const select = () => selectOpenEditorialRun({ stateDirectory, continueFrom: "original" });

    // At the bound the successor is read: it is no saved run, so nothing supersedes.
    await writeFile(join(stateDirectory, "successor.json"), "x".repeat(BOUND), { mode: 0o600 });
    await expect(select()).rejects.toThrow(
      "No open editorial needs-input run named original is available to continue.",
    );

    await writeFile(join(stateDirectory, "successor.json"), "x".repeat(BOUND + 1), {
      mode: 0o600,
    });
    await expect(select()).rejects.toMatchObject({
      code: "runs-record-max-bytes-bound",
      configured: BOUND,
      observed: BOUND + 1,
    });
  });

  it("reports a retired runs.indexRecordMaxBytes host-file line once, naming its replacement, and never applies it", async () => {
    const root = await roots.create("docsfab-retired-limit-name-");
    const hostFile = join(root, "service.env");
    await writeFile(hostFile, "runs.indexRecordMaxBytes=134217728\n", { mode: 0o600 });
    const written = captureStderr();
    const options = { hostFile, environment: {}, projectFile: null };

    expect(limit("runs.recordMaxBytes", options)).toMatchObject({
      value: 67_108_864,
      source: "config/limits.yaml",
    });
    limit("runs.recordMaxBytes", options);
    const expected = `WARNING retired-limit-name: the host limits file ${hostFile} sets runs.indexRecordMaxBytes, which DocsFab no longer reads, so its value is ignored. Set runs.recordMaxBytes or DOCSFAB_RUNS_RECORD_MAX_BYTES instead.\n`;
    expect(written.filter((line) => line.startsWith("WARNING retired-limit-name:"))).toEqual([
      expected,
    ]);

    // `docsfab doctor --limits` resolves through the same path and reports it too.
    const doctorHostFile = join(root, "doctor-service.env");
    await writeFile(doctorHostFile, "runs.indexRecordMaxBytes=134217728\n", { mode: 0o600 });
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const report = await inspectLimits({
      hostFile: doctorHostFile,
      environment: { DOCSFAB_STATE_DIR: stateDirectory },
      projectFile: null,
      cwd: root,
    });
    expect(report.rows.find((row) => row.name === "runs.recordMaxBytes")).toMatchObject({
      value: 67_108_864,
      source: "config/limits.yaml",
    });
    expect(written.join("")).toContain(
      `WARNING retired-limit-name: the host limits file ${doctorHostFile} sets runs.indexRecordMaxBytes`,
    );
  });
});
