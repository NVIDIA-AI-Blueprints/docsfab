// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSavedRunReadTool, SAVED_RUN_FAILURES } from "../src/live-agent/saved-run-tool.js";
import { temporaryRoots } from "./helpers/temp.js";
import { configureCredential } from "./helpers/configured-credential.js";

const roots = temporaryRoots();
afterEach(() => {
  delete process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES;
});
async function fixture() {
  const root = await roots.create("docsfab-read-run-");
  const repositoryPath = join(root, "repo"),
    stateDirectory = join(root, "state");
  await mkdir(repositoryPath);
  await mkdir(stateDirectory);
  const record = {
    schemaVersion: 2,
    id: "saved-review",
    workflow: "review-documentation",
    status: "succeeded",
    workflowOutcome: { disposition: "inconclusive", limitations: ["Missing audience evidence."] },
    repository: { sourcePath: repositoryPath, revision: "a".repeat(40) },
    changes: { files: [] },
    steps: [
      { id: "audit-documentation", status: "succeeded", summary: "Audit finding." },
      {
        id: "evaluate-document-quality",
        skill: "evaluate-document-quality",
        status: "succeeded",
        summary: "Saved review finding; structured report unavailable.",
      },
    ],
    securityScan: { privateFixtureField: "Do not include unrelated scanner internals." },
  };
  const path = join(stateDirectory, "saved-review.json");
  const save = () => writeFile(path, JSON.stringify(record));
  await save();
  const tool = createSavedRunReadTool({ repositoryPath, stateDirectory });
  const run = (args: object = { runId: "saved-review" }) =>
    tool.execute("read-1", args, undefined, undefined, {} as never);
  return { root, repositoryPath, stateDirectory, record, path, save, run };
}
describe("live-agent saved-run reads", () => {
  it("shows failed checkout application beside completed workflow steps", async () => {
    const f = await fixture();
    Object.assign(f.record, {
      checkoutPersistence: {
        schemaVersion: 1,
        kind: "checkout-persistence",
        outcome: "failed",
        errorCode: "run-record-contract-gap",
      },
    });
    await f.save();
    expect((await f.run()).details).toMatchObject({
      executionStatus: "failed",
      workflowStatus: "succeeded",
      checkoutPersistence: { outcome: "failed", errorCode: "run-record-contract-gap" },
      steps: [{ status: "succeeded" }, { status: "succeeded" }],
    });
  });

  it("rejects an unknown checkout diagnostic rather than displaying it", async () => {
    const f = await fixture();
    Object.assign(f.record, {
      checkoutPersistence: {
        schemaVersion: 1,
        kind: "checkout-persistence",
        outcome: "failed",
        errorCode: "untrusted-message",
      },
    });
    await f.save();
    await expect(f.run()).rejects.toThrow(SAVED_RUN_FAILURES.malformed);
  });
  it.each(["create-documentation", "update-documentation"])(
    "retains the shared unavailable-quality limitation when reading saved %s",
    async (workflow) => {
      const f = await fixture();
      f.record.workflow = workflow;
      await f.save();
      const result = await f.run();
      expect(result.details).toMatchObject({
        executionStatus: "succeeded",
        quality: null,
        qualityLimitations: ["quality-validation-unavailable"],
      });
    },
  );

  it("reads completed findings without write mode, approvals, shell commands, or record mutation", async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    const result = await f.run();
    expect(result.details).toMatchObject({
      runId: "saved-review",
      executionStatus: "succeeded",
      workflowOutcome: { disposition: "inconclusive", limitations: ["Missing audience evidence."] },
      quality: null,
      selectedStep: { id: "evaluate-document-quality", summary: f.record.steps[1]!.summary },
    });
    expect(result.details).toMatchObject({
      reportError: expect.stringContaining("missing-report"),
    });
    expect(JSON.stringify(result)).not.toContain("privateFixtureField");
    expect(await readFile(f.path)).toEqual(before);
    expect(
      (await f.run({ runId: "saved-review", stepId: "audit-documentation" })).details,
    ).toMatchObject({ selectedStep: { summary: "Audit finding." } });
  });
  it("rejects paths, other repositories, mismatched IDs, and unknown stages", async () => {
    const f = await fixture();
    await expect(f.run({ runId: "../saved-review" })).rejects.toThrow(SAVED_RUN_FAILURES.input);
    await expect(f.run({ runId: "saved-review", stateDirectory: f.root })).rejects.toThrow(
      SAVED_RUN_FAILURES.input,
    );
    await expect(f.run({ runId: "saved-review", stepId: "absent" })).rejects.toThrow(
      SAVED_RUN_FAILURES.step,
    );
    f.record.repository.sourcePath = f.root;
    await f.save();
    await expect(f.run()).rejects.toThrow(SAVED_RUN_FAILURES.repository);
    f.record.id = "different";
    await f.save();
    await expect(f.run()).rejects.toThrow(SAVED_RUN_FAILURES.malformed);
  });
  it("refuses missing, linked, oversized, and malformed records", async () => {
    const f = await fixture();
    await expect(f.run({ runId: "missing" })).rejects.toThrow(SAVED_RUN_FAILURES.unavailable);
    await symlink(f.path, join(f.stateDirectory, "alias.json"));
    await expect(f.run({ runId: "alias" })).rejects.toThrow(SAVED_RUN_FAILURES.unavailable);
    await writeFile(join(f.stateDirectory, "bad.json"), "not JSON");
    await expect(f.run({ runId: "bad" })).rejects.toThrow(SAVED_RUN_FAILURES.malformed);
    await link(f.path, join(f.stateDirectory, "hardlink.json"));
    await expect(f.run()).rejects.toThrow(SAVED_RUN_FAILURES.malformed);
  });
  it("reads a record at runs.recordMaxBytes and refuses one byte more as too large, not malformed (#1932)", async () => {
    const f = await fixture();
    const bound = 8192;
    process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES = String(bound);
    const text = JSON.stringify(f.record);
    // JSON admits trailing whitespace, so padding changes the size and nothing else.
    await writeFile(f.path, `${text}${" ".repeat(bound - Buffer.byteLength(text))}`);
    await expect(f.run()).resolves.toMatchObject({ details: { runId: "saved-review" } });

    await writeFile(f.path, `${text}${" ".repeat(bound + 1 - Buffer.byteLength(text))}`);
    const refusal = (await f.run().then(
      () => new Error("expected the oversized record to be refused"),
      (error: unknown) => error,
    )) as Error;
    expect(refusal.message).toContain(
      "runs-record-max-bytes-bound: 8193 exceeds runs.recordMaxBytes = 8192 bytes. Set DOCSFAB_RUNS_RECORD_MAX_BYTES",
    );
    expect(refusal.message).not.toBe(SAVED_RUN_FAILURES.malformed);
  });
  it("screens selected output before truncation and never returns a configured credential", async () => {
    const planted = configureCredential(["fixture", "saved", "run", "orchard", "lamp"].join("-"));
    const f = await fixture();
    f.record.steps[0]!.summary = "x".repeat(49_000);
    await f.save();
    expect(
      (await f.run({ runId: "saved-review", stepId: "audit-documentation" })).details,
    ).toMatchObject({ selectedStep: { truncated: true } });
    f.record.steps[0]!.summary += `\nThe deploy job reads ${planted}.`;
    await f.save();
    await expect(f.run({ runId: "saved-review", stepId: "audit-documentation" })).rejects.toThrow(
      SAVED_RUN_FAILURES.credentials,
    );
  });
});
