// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behind the load-time stop, DocsFab's own configured credentials never reach
 * a saved run record, the record the run index reads, or the run summary and
 * diagnosis text, whatever field holds one (#1807). Only configured
 * credentials are replaced; any other text is kept as written.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diagnoseRunRecord, recordDiagnosisLocation } from "../src/diagnosis/record.js";
import { formatRunDiagnosisLines } from "../src/diagnosis/render.js";
import { formatRunFailureDiagnosticLines, formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { nimFixtureRecords } from "./helpers/diagnosis-nim-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
/** A placeholder credential: plain words, never shaped like a real one. */
const KEY = "record-redaction-orchard-meadow-key";
/**
 * A model id configured nowhere: kept as written (control). It shares no
 * 16-character piece with the credential, so no fragment of it matches.
 */
const PLAIN = "example/plain-control-model";
const PROVIDER = "operator-configured-openai-compatible";

/** A run whose model id, as each field records it, is `model`. */
function runRecord(model: string, status: RunRecord["status"] = "failed"): RunRecord {
  return {
    schemaVersion: 2,
    id: "fixture-run-1",
    workflow: "readiness",
    repository: {
      sourcePath: "/operator/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status,
    ...(status === "failed" ? { error: `The provider refused the model ${model}.` } : {}),
    createdAt: "2026-08-03T20:00:00.000Z",
    // A review date long past, so the summary names the model.
    models: [{ provider: PROVIDER, model, profile: { reviewAfter: "2020-01-01" } }] as never,
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
}

async function saved(model: string): Promise<{ file: string; indexed: RunRecord[] }> {
  const directory = await roots.create("docsfab-record-redaction-", {
    mode: 0o700,
    realpath: true,
  });
  const indexed: RunRecord[] = [];
  const store = new FileRunStore(directory, {
    afterSave: async (record) => {
      indexed.push(record);
    },
  });
  await store.save(runRecord(model));
  return {
    file: await readFile(join(directory, "fixture-run-1.json"), "utf8"),
    indexed,
  };
}

describe("the run-record writer", () => {
  it("saves a configured credential as [REDACTED], in the file and the record the index reads", async () => {
    configureCredential(KEY);
    const { file, indexed } = await saved(KEY);

    expect(file).not.toContain(KEY);
    expect(JSON.parse(file).models[0].model).toBe("[REDACTED]");
    expect(JSON.stringify(indexed)).not.toContain(KEY);
    expect(indexed[0]!.models[0]).toMatchObject({ model: "[REDACTED]" });
  });

  it("keeps a value configured nowhere as written (control)", async () => {
    configureCredential(KEY);
    const { file, indexed } = await saved(PLAIN);

    expect(JSON.parse(file).models[0].model).toBe(PLAIN);
    expect(indexed[0]!.models[0]).toMatchObject({ model: PLAIN });
  });
});

describe("the run summary and the diagnosis", () => {
  /** A diagnosed failed run whose model is `model`, with its recurrence queries. */
  function diagnosisText(model: string): string {
    const fixture = nimFixtureRecords().find((record) => record.id === "nim-nano-retired")!;
    const record = JSON.parse(
      JSON.stringify(fixture).replaceAll("nvidia/nemotron-3-nano-30b-a3b", model),
    ) as RunRecord;
    const recordPath = `/state/runs/${record.id}.json`;
    const diagnosis = diagnoseRunRecord(record, recordPath, [])!;
    return formatRunDiagnosisLines(diagnosis, {
      location: recordDiagnosisLocation(recordPath),
    }).join("\n");
  }

  it("shows a configured credential as [REDACTED] in every diagnosis line", () => {
    configureCredential(KEY);
    const text = diagnosisText(KEY);

    expect(text).not.toContain(KEY);
    expect(text).toContain(`Model: ${PROVIDER} [REDACTED];`);
    expect(text).toContain("Recurrence:");
    // Control: a model id configured nowhere is shown as it is.
    expect(diagnosisText(PLAIN)).toContain(`Model: ${PROVIDER} ${PLAIN};`);
  });

  it.each([false, true])(
    "leaves the summary with quiet %s through the one exit that redacts it",
    (quiet) => {
      configureCredential(KEY);
      // The credential in the state directory: the RECORD line and a NEXT
      // argument both name it.
      const summary = formatRunSummary({
        record: runRecord(PLAIN),
        recordPath: `/state/${KEY}/fixture-run-1.json`,
        exitCode: 1,
        repositoryPath: "/operator/source",
        quiet,
        noColor: true,
        tty: false,
      }).join("\n");

      expect(summary).not.toContain(KEY);
      expect(summary).toContain(
        "  docsfab runs show fixture-run-1 --state-dir /state/[REDACTED] --json",
      );
      expect(summary).toContain("  /state/[REDACTED]/fixture-run-1.json");
    },
  );

  it("shows a configured credential as [REDACTED] in the failure lines and the summary", () => {
    configureCredential(KEY);
    const failure = formatRunFailureDiagnosticLines(runRecord(KEY)).join("\n");
    const summary = formatRunSummary({
      record: runRecord(KEY, "succeeded"),
      recordPath: "/state/runs/fixture-run-1.json",
      exitCode: 0,
      repositoryPath: "/operator/source",
      noColor: true,
      tty: false,
    }).join("\n");

    expect(failure).not.toContain(KEY);
    expect(failure).toContain("The provider refused the model [REDACTED].");
    expect(summary).not.toContain(KEY);
    expect(summary).toContain(`Review overdue: ${PROVIDER}/[REDACTED] review date 2020-01-01`);
    // Control: a model id configured nowhere is shown as it is.
    expect(formatRunFailureDiagnosticLines(runRecord(PLAIN)).join("\n")).toContain(PLAIN);
  });
});
