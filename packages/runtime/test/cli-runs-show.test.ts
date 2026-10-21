// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand, parseRunsArguments } from "../src/cli/commands/runs.js";
import { resolveDocsFabStateDirectory } from "../src/config/host-paths.js";
import { FileRunStore } from "../src/records/file-store.js";
import { main } from "../src/cli/router.js";
import { usage } from "../src/cli/usage.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { WorkflowOutcomeFindingV1 } from "../src/workflow-contracts/contracts.js";
import {
  QUALITY_REPORT_FAILURES,
  inspectQualityReportFromRun,
  persistHostedQualityReport,
  projectQualityReportFromRun,
  QualityReportProjectionError,
  sealQualityValidationBinding,
  sealQualityValidatorReceipt,
} from "../src/evaluation-report/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import {
  buildRunResultV1,
  collectRunResultNextSteps,
  defaultRunRecordPath,
  decodeRunResultV1,
  serializeRunResultV1,
  type RunSummaryContext,
} from "../src/operator/index.js";
import {
  createWorkflowOutcome,
  interactiveWorkflowOutcomePolicy,
  workflowOutcomeExitCode,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import {
  authoringReviewFindingsRecord,
  UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN,
} from "./helpers/authoring-review-record.js";
import { recordedIntent } from "./helpers/first-pass-intent.js";
import {
  credentialFindingLocationReadBound,
  escapeCredentialFindingLocation,
} from "../src/security/credential-findings.js";

const roots: string[] = [];
const INFERENCE_BLOB = "MODEL_INFERENCE_PROGRESS_MUST_NOT_LEAK";
const CREDENTIAL_BLOB = "sk-secret-credential-value";

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("docsfab runs show", () => {
  it("parses only the addressed JSON saved-review inventory projection", () => {
    const digest = "a".repeat(64);
    expect(
      parseRunsArguments([
        "show",
        "saved-review",
        "--state-dir",
        "/tmp/runs",
        "--review-delivery-inventory",
        digest,
        "--json",
      ]),
    ).toMatchObject({
      command: "show",
      runId: "saved-review",
      json: true,
      reviewDeliveryInventory: digest,
    });
    expect(() =>
      parseRunsArguments(["show", "saved-review", "--review-delivery-inventory", digest]),
    ).toThrow("requires --json");
    expect(() =>
      parseRunsArguments(["show", "saved-review", "--review-delivery-inventory", "bad", "--json"]),
    ).toThrow("SHA-256");
  });

  it("returns the same safe credential finding in saved human and JSON views", async () => {
    const finding = {
      code: "credential-like-content" as const,
      location: "docs/quickstart.md:23",
      rule: "credential.nvidia-api-key",
    };
    const record = { ...savedAuditRecord(), credentialFindings: [finding] } as RunRecord;
    const { stateDirectory } = await writeSavedRun(record);
    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(human.stdout).toContain("docs/quickstart.md:23 (credential.nvidia-api-key)");
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    expect(decodeRunResultV1(parseJsonEvidence(json.stdout)).credentialFindings).toEqual([finding]);
  });

  it("inspects long escaped finding locations without changing the saved record", async () => {
    const location = `${"x".repeat(credentialFindingLocationReadBound() - 1)}\u202e`;
    const finding = {
      code: "credential-like-content" as const,
      location,
      rule: "credential.nvidia-api-key",
    };
    const record = { ...savedAuditRecord(), credentialFindings: [finding] } as RunRecord;
    const { stateDirectory } = await writeSavedRun(record);
    const recordPath = join(stateDirectory, `${record.id}.json`);
    const original = await readFile(recordPath);
    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const displayed = escapeCredentialFindingLocation(location);
    expect(human.stdout).toContain(displayed);
    expect(decodeRunResultV1(parseJsonEvidence(json.stdout)).credentialFindings).toEqual([
      { ...finding, location: displayed },
    ]);
    expect(human.stdout + json.stdout).not.toContain("\u202e");
    expect(await readFile(recordPath)).toEqual(original);
  });

  it("reports saved checkout failure as the overall result while preserving workflow status", async () => {
    const record = {
      ...savedAuditRecord(),
      id: "saved-checkout-failure",
      checkoutPersistence: {
        schemaVersion: 1,
        kind: "checkout-persistence",
        outcome: "failed",
        errorCode: "run-record-contract-gap",
      },
    } as RunRecord;
    const { stateDirectory } = await writeSavedRun(record);
    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(human.stdout).toContain("Checkout persistence: failed (run-record-contract-gap)");
    expect(human.stdout).toContain("Workflow status: succeeded");
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const projected = decodeRunResultV1(parseJsonEvidence(json.stdout));
    expect(projected.execution).toMatchObject({
      status: "failed",
      workflowStatus: "succeeded",
      exitCode: 1,
      checkoutPersistence: { outcome: "failed", errorCode: "run-record-contract-gap" },
    });
  });
  it("distinguishes an absent checkout outcome from malformed present list metadata", async () => {
    const stateDirectory = await temporaryRoot("docsfab-runs-list-checkout-contract-");
    const cases = [
      { id: "legacy", record: savedAuditRecord() },
      {
        id: "failed-checkout",
        record: {
          ...savedAuditRecord(),
          checkoutPersistence: {
            schemaVersion: 1,
            kind: "checkout-persistence",
            outcome: "failed",
            errorCode: "patch-conflict",
          },
        },
      },
      ...[null, false, 0, ""].map((checkoutPersistence, index) => ({
        id: `malformed-${index}`,
        record: { ...savedAuditRecord(), checkoutPersistence },
      })),
    ];
    for (const { id, record } of cases) {
      await writeFile(
        join(stateDirectory, `${id}.json`),
        `${JSON.stringify({ ...record, id })}\n`,
        { mode: 0o600 },
      );
    }
    const output = await captureIo(() =>
      handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
    );
    const entries = (
      JSON.parse(output.stdout) as {
        runs: Array<{
          runId: string;
          availability: string;
          status?: string;
          reason?: string;
          checkoutPersistence?: unknown;
        }>;
      }
    ).runs;
    const byId = new Map(entries.map((entry) => [entry.runId, entry]));
    expect(byId.get("legacy")).toMatchObject({ availability: "available", status: "succeeded" });
    expect(byId.get("legacy")?.checkoutPersistence).toBeUndefined();
    expect(byId.get("failed-checkout")).toMatchObject({
      availability: "available",
      status: "failed",
      checkoutPersistence: { outcome: "failed", errorCode: "patch-conflict" },
    });
    for (const { id } of cases.slice(2)) {
      expect(byId.get(id)).toMatchObject({
        availability: "unavailable",
        reason: "malformed-record",
      });
    }
  });
  it.each(["ambiguous-scope", "missing-information"])(
    "projects a saved planner %s stop as exit two in human and JSON views",
    async (code) => {
      const record = { ...savedPlannerFailureRecord(code), status: "needs-input" as const };
      const { stateDirectory } = await writeSavedRun(record);
      const recordPath = join(stateDirectory, `${record.id}.json`);
      const original = await readFile(recordPath);
      const human = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      expect(human.stdout).toContain("Exit code: 2");
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
      const json = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
      );
      const projected = decodeRunResultV1(parseJsonEvidence(json.stdout));
      expect(projected.execution).toMatchObject({ status: "needs-input", exitCode: 2 });
      expect(projected.plannerDiagnostic).toMatchObject({
        code,
        category: "missing-governed-input",
      });
      expect(process.exitCode).toBe(2);
      expect(await readFile(recordPath)).toEqual(original);
    },
  );

  it.each(["invalid-envelope", "unknown-stop"])(
    "does not treat a saved %s diagnostic as an admitted planner input stop",
    async (code) => {
      const record = { ...savedPlannerFailureRecord(code), status: "needs-input" as const };
      const { stateDirectory } = await writeSavedRun(record);
      const json = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
      );
      const projected = decodeRunResultV1(parseJsonEvidence(json.stdout));
      expect(projected.execution.exitCode).toBe(0);
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it("keeps a saved checkout failure ahead of a planner input stop", async () => {
    const record = {
      ...savedPlannerFailureRecord("ambiguous-scope"),
      status: "needs-input" as const,
      checkoutPersistence: {
        schemaVersion: 1 as const,
        kind: "checkout-persistence" as const,
        outcome: "failed" as const,
        errorCode: "patch-conflict" as const,
      },
    };
    const { stateDirectory } = await writeSavedRun(record);
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    expect(decodeRunResultV1(parseJsonEvidence(json.stdout)).execution.exitCode).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it("projects saved question exits only from a step-free verified admission", async () => {
    const instruction = "Review docs/a.md. RAW_REQUEST_NEVER_RENDER";
    const question = recordedIntent(
      instruction,
      {
        operation: "review",
        targets: [{ path: "docs/a.md", quote: "docs/a.md" }],
        question: {
          question: "Which page should be reviewed?",
          options: ["docs/a.md", "stop"],
          recommendedDefault: "stop",
          consequence: "The run stops for an answer.",
        },
      },
      "question",
    );
    const nonQuestion = recordedIntent(instruction, {
      operation: "review",
      targets: [{ path: "docs/a.md", quote: "docs/a.md" }],
    });
    const base = savedAuditRecord();
    const badQualityStep = {
      ...base.steps[0]!,
      id: "evaluate-document-quality",
      skill: "evaluate-document-quality",
      summary: "Evaluator output without a valid summary.",
    };
    const cases: Array<{ name: string; record: RunRecord; code: number }> = [
      { name: "succeeded", record: { ...base, steps: [] }, code: 0 },
      { name: "failed refusal", record: { ...base, status: "failed", steps: [] }, code: 1 },
      {
        name: "legacy needs-input",
        record: { ...base, status: "needs-input", steps: [] },
        code: 0,
      },
      {
        name: "malformed question",
        record: {
          ...base,
          status: "needs-input",
          steps: [],
          instruction,
          requestIntent: {} as RunRecord["requestIntent"],
        },
        code: 0,
      },
      {
        name: "tampered question",
        record: {
          ...base,
          status: "needs-input",
          steps: [],
          instruction: `${instruction} tampered`,
          requestIntent: question,
        },
        code: 0,
      },
      {
        name: "non-question admission",
        record: {
          ...base,
          status: "needs-input",
          steps: [],
          instruction,
          requestIntent: nonQuestion,
        },
        code: 0,
      },
      {
        name: "question with step",
        record: { ...base, status: "needs-input", instruction, requestIntent: question },
        code: 0,
      },
      {
        name: "failed question",
        record: { ...base, status: "failed", steps: [], instruction, requestIntent: question },
        code: 1,
      },
      {
        name: "question with quality error",
        record: {
          ...base,
          status: "needs-input",
          steps: [badQualityStep],
          instruction,
          requestIntent: question,
        },
        code: 1,
      },
      {
        name: "verified question",
        record: { ...base, status: "needs-input", steps: [], instruction, requestIntent: question },
        code: 2,
      },
    ];
    for (const testCase of cases) {
      const record = {
        ...testCase.record,
        id: `run-show-question-${testCase.name.replaceAll(" ", "-")}`,
      };
      const { stateDirectory } = await writeSavedRun(record);
      process.exitCode = undefined;
      const human = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      expect(human.stdout, testCase.name).toContain(`Exit code: ${testCase.code}`);
      expect(process.exitCode ?? 0, testCase.name).toBe(testCase.code);
      expect(human.stdout, testCase.name).not.toContain("RAW_REQUEST_NEVER_RENDER");

      process.exitCode = undefined;
      const json = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
      );
      const result = decodeRunResultV1(parseJsonEvidence(json.stdout));
      expect(result.execution.status, testCase.name).toBe(record.status);
      expect(result.execution.exitCode, testCase.name).toBe(testCase.code);
      expect(process.exitCode ?? 0, testCase.name).toBe(testCase.code);
      expect(json.stdout, testCase.name).not.toContain("RAW_REQUEST_NEVER_RENDER");
    }
  });
  it("replays admitted authoring findings without inference or a quality claim", async () => {
    const record = authoringReviewFindingsRecord();
    const { stateDirectory } = await writeSavedRun(record);
    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(human.stdout).toContain("PRODUCT\n  Product disposition: inconclusive");
    expect(human.stdout).toContain("REVIEW FINDINGS\n  Availability: partial (2)");
    expect(human.stdout).toContain("[warning] FACT-001 at docs/usage.md:12");
    expect(human.stdout).toContain("technical-issue=TECH-001");
    expect(human.stdout).toContain("[info] TASK-001 at docs/usage.md:20");
    expect(human.stdout).not.toContain(UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN);
    expect(human.stdout).not.toMatch(/step \S+: running/u);

    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const result = decodeRunResultV1(parseJsonEvidence(json.stdout));
    expect(result.product.disposition).toBe("inconclusive");
    expect(result.product.findings).toEqual(["structured-product-evidence-unavailable"]);
    expect(result.reviewFindings?.map((finding) => finding.code)).toEqual(["TASK-001", "FACT-001"]);
    expect(result.reviewFindingsProjection).toBeUndefined();
    expect(result.quality).toBeNull();
    expect(json.stdout).not.toContain(UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN);
  });

  it("re-renders EXECUTION/PRODUCT/RECORD from a saved audit record without inference", async () => {
    const { stateDirectory, record } = await writeSavedRun();
    const io = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(io.stdout).toContain("EXECUTION");
    expect(io.stdout).toContain("PRODUCT");
    expect(io.stdout).toContain("RECORD");
    expect(io.stdout).toContain(record.id);
    expect(io.stdout).toContain(record.repository.sourcePath);
    expect(io.stdout).not.toContain(INFERENCE_BLOB);
    expect(io.stdout).not.toMatch(/step \S+: running/u);
    expect(io.stdout).not.toContain("harness");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("fails closed for missing or unknown ids without inventing a record or leaking credentials", async () => {
    const { stateDirectory } = await writeSavedRun();
    const lookedIn = resolve(stateDirectory);
    const missing = await captureIo(() =>
      handleRunsCommand(["show", "unknown-run-id", "--state-dir", stateDirectory]),
    );
    expect(missing.stderr).toContain(
      `The requested saved run record was not found in ${lookedIn}.`,
    );
    expect(missing.stderr).toContain("code: saved-run-not-found");
    expect(missing.stderr).toContain(`Next action: docsfab runs list --state-dir ${lookedIn}`);
    expect(missing.stderr).not.toContain("retry the command");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(missing.stdout).not.toContain("EXECUTION");
    expect(missing.stdout).not.toContain("unknown-run-id");
    expect(combined(missing)).not.toContain(CREDENTIAL_BLOB);

    const missingJson = await captureIo(() =>
      handleRunsCommand(["show", "unknown-run-id", "--json", "--state-dir", stateDirectory]),
    );
    expect(JSON.parse(missingJson.stderr)).toEqual({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
      code: "saved-run-not-found",
      message: `The requested saved run record was not found in ${lookedIn}.`,
      nextAction: `docsfab runs list --state-dir ${lookedIn}`,
    });
    expect(missingJson.stdout).toBe("");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const malformedDir = await temporaryRoot("docsfab-runs-malformed-");
    await writeFile(
      join(malformedDir, "bad-run.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "other-id",
        apiKey: CREDENTIAL_BLOB,
        repository: { sourcePath: "/tmp/example", revision: "a".repeat(40) },
        workflow: "review-documentation",
        status: "succeeded",
        steps: [],
      }),
      { mode: 0o600 },
    );
    const mismatched = await captureIo(async () => {
      await expect(
        handleRunsCommand(["show", "bad-run", "--state-dir", malformedDir]),
      ).rejects.toThrow(/does not match the requested run/u);
    });
    expect(mismatched.stdout).not.toContain("EXECUTION");
    expect(combined(mismatched)).not.toContain(CREDENTIAL_BLOB);

    await expect(handleRunsCommand(["show", "../escape"])).rejects.toThrow(/safe record identity/u);
  });

  it("reads a FileRunStore record through runs show and list under a relative DOCSFAB_STATE_DIR", async () => {
    const configurationRoot = resolve(await temporaryRoot("docsfab-runs-same-context-"));
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", configurationRoot);
    vi.stubEnv("DOCSFAB_STATE_DIR", "./.docsfab/runs");
    const record = savedAuditRecord();
    const stateDirectory = resolveDocsFabStateDirectory();
    expect(stateDirectory).toBe(resolve(configurationRoot, ".docsfab", "runs"));
    await new FileRunStore(stateDirectory).save(record);

    const shown = await captureIo(() => handleRunsCommand(["show", record.id]));
    expect(shown.stdout).toContain("EXECUTION");
    expect(shown.stdout).toContain(record.id);
    expect(process.exitCode ?? 0).toBe(0);

    const listed = await captureIo(() => handleRunsCommand(["list"]));
    expect(listed.stdout).toContain(record.id);
    expect(listed.stdout).toContain("workflow=review-documentation");

    const missing = await captureIo(() => handleRunsCommand(["show", "missing-run-id"]));
    expect(missing.stderr).toContain(
      `The requested saved run record was not found in ${stateDirectory}.`,
    );
    expect(missing.stderr).toContain(
      `Next action: docsfab runs list --state-dir ${stateDirectory}`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects malformed saved step members before text or JSON projection", async () => {
    for (const step of [null, [], "untrusted-step"]) {
      const stateDirectory = await temporaryRoot("docsfab-runs-malformed-step-");
      const runId = `malformed-step-${typeof step}`;
      await writeFile(
        join(stateDirectory, `${runId}.json`),
        JSON.stringify({ ...savedAuditRecord(), id: runId, steps: [step] }),
        { mode: 0o600 },
      );
      for (const flags of [[], ["--json"]]) {
        await expect(
          handleRunsCommand(["show", runId, ...flags, "--state-dir", stateDirectory]),
        ).rejects.toThrow("The saved run record is malformed and cannot be shown.");
      }
    }
  });

  it("shows a saved record whose models are malformed, with no review-overdue line", async () => {
    // The decoder does not validate `models`; the advisory reader must skip,
    // not throw. Adjacent condition: a well-formed overdue model next to the
    // malformed members still prints its line.
    const overdue = {
      provider: "fixture",
      model: "overdue-model",
      profile: { reviewAfter: "2026-08-01" },
    };
    const malformedModels = [
      undefined,
      {},
      [null],
      ["x", { provider: 1, model: "m", profile: { reviewAfter: "2026-08-01" } }],
      [{ provider: "p", model: "m", profile: null }],
      [{ provider: "p", model: "not-a-day", profile: { reviewAfter: "0" } }],
    ];
    for (const [index, models] of malformedModels.entries()) {
      const record = { ...savedAuditRecord(), id: `malformed-models-${index}`, models };
      const { stateDirectory } = await writeSavedRun(record as unknown as RunRecord);
      const io = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      expect(io.stdout).toContain(record.id);
      expect(io.stdout).not.toContain("Review overdue");
    }
    const mixed = {
      ...savedAuditRecord(),
      id: "malformed-models-mixed",
      models: [null, overdue, { provider: "p", model: "m", profile: { reviewAfter: "0" } }],
    };
    const { stateDirectory } = await writeSavedRun(mixed as unknown as RunRecord);
    const io = await captureIo(() =>
      handleRunsCommand(["show", mixed.id, "--state-dir", stateDirectory]),
    );
    expect(io.stdout.match(/Review overdue/gu)).toHaveLength(1);
    expect(io.stdout).toContain(
      "Review overdue: fixture/overdue-model review date 2026-08-01 had passed",
    );
  });

  it("rejects unknown saved workflow and status strings without echoing them", async () => {
    for (const override of [
      { workflow: `unknown\n${CREDENTIAL_BLOB}` },
      { status: `unknown-${CREDENTIAL_BLOB}` },
    ]) {
      const stateDirectory = await temporaryRoot("docsfab-runs-malformed-enum-");
      const runId = `malformed-enum-${Object.keys(override)[0]}`;
      await writeFile(
        join(stateDirectory, `${runId}.json`),
        JSON.stringify({ ...savedAuditRecord(), id: runId, ...override }),
        { mode: 0o600 },
      );
      for (const flags of [[], ["--json"]]) {
        const io = await captureIo(async () => {
          await expect(
            handleRunsCommand(["show", runId, ...flags, "--state-dir", stateDirectory]),
          ).rejects.toThrow("The saved run record is malformed and cannot be shown.");
        });
        expect(combined(io)).not.toContain(CREDENTIAL_BLOB);
      }
    }
  });

  it("emits one docsfab-run-result object for --json of the same id", async () => {
    const { stateDirectory, record } = await writeSavedRun();
    const io = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const envelope = decodeRunResultV1(parseJsonEvidence(io.stdout));
    expect(envelope.kind).toBe("docsfab-run-result");
    expect(envelope.execution.runId).toBe(record.id);
    expect(envelope.schemaVersion).toBe(1);
    expect(io.stdout.trim().startsWith("{")).toBe(true);
    expect(io.stdout.includes("\n{")).toBe(false);
  });

  it("matches buildRunResultV1 digest for a legacy saved record without inference", async () => {
    const { stateDirectory, record } = await writeSavedRun();
    const expected = independentlyBuiltRunResult(record, stateDirectory);
    const io = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const envelope = decodeRunResultV1(parseJsonEvidence(io.stdout));
    expect(io.stdout).toBe(serializeRunResultV1(expected).trimEnd());
    expect(envelope.resultSha256).toBe(expected.resultSha256);
    expect(envelope.product.disposition).toBe("legacy-no-product-disposition");
    expect(envelope.product.findings).toEqual([]);
    expect(io.stdout).not.toContain(INFERENCE_BLOB);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("matches buildRunResultV1 digest for a current sealed workflowOutcome", async () => {
    const record = savedAuditRecordWithCurrentOutcome();
    const { stateDirectory } = await writeSavedRun(record);
    const expected = independentlyBuiltRunResult(record, stateDirectory);
    const io = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const envelope = decodeRunResultV1(parseJsonEvidence(io.stdout));
    expect(io.stdout).toBe(serializeRunResultV1(expected).trimEnd());
    expect(envelope.resultSha256).toBe(expected.resultSha256);
    expect(envelope.product.disposition).toBe(record.workflowOutcome?.disposition);
    expect(envelope.product.findings).toEqual(
      record.workflowOutcome?.findings.map((finding) => finding.code),
    );
    expect(io.stdout).not.toContain(INFERENCE_BLOB);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("replays planner failures with the same typed, non-looping diagnosis", async () => {
    for (const expected of [
      {
        code: "invalid-envelope",
        category: "invalid-model-output",
        disposition: null,
        nextPhrase: "no missing user input was established",
      },
      {
        code: "missing-information",
        category: "missing-governed-input",
        disposition: "needs-input",
        nextPhrase: "required governed input",
      },
    ] as const) {
      const record = savedPlannerFailureRecord(expected.code);
      const { stateDirectory } = await writeSavedRun(record);
      const human = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      process.exitCode = undefined;
      const json = await captureIo(() =>
        handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
      );
      const envelope = decodeRunResultV1(parseJsonEvidence(json.stdout));
      expect(human.stdout).toContain(`Planner diagnostic: ${expected.code}`);
      expect(human.stdout).toContain(`Planner diagnostic category: ${expected.category}`);
      // docsfab runs show is history replay: it never guesses a NEXT command
      // from a placeholder retry template. The sealed JSON nextSteps below still
      // carry this phrase.
      expect(human.stdout).not.toContain("<original target checkout>");
      expect(human.stdout).toContain("Resumability: non-resumable (failed)");
      expect(envelope.product.disposition).toBe(expected.disposition);
      expect(envelope.plannerDiagnostic).toMatchObject({
        category: expected.category,
        code: expected.code,
      });
      expect(envelope.nextSteps.join(" ")).toContain(expected.nextPhrase);
      expect(combined(human)).not.toContain("legacy-no-product-disposition");
      expect(combined(human)).not.toContain("docsfab runs show");
      expect(combined(human)).not.toContain(INFERENCE_BLOB);
      expect(json.stdout).not.toContain(INFERENCE_BLOB);
      process.exitCode = undefined;
    }
  });

  it("does not label a current failed record legacy when planner evidence is unavailable", async () => {
    const record = savedPlannerFailureRecord("invalid-envelope");
    record.steps = [];
    record.error = "Planner failed before producing a diagnostic.";
    const { stateDirectory } = await writeSavedRun(record);
    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    process.exitCode = undefined;
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const envelope = decodeRunResultV1(parseJsonEvidence(json.stdout));
    const inspect = `docsfab runs show ${record.id} --state-dir ${stateDirectory} --json`;
    const inspectReason =
      "Inspect the saved run for the failing step and coded rejection. Do not retry unchanged inference from this output.";
    expect(human.stdout).toContain("Product disposition: unavailable");
    expect(human.stdout).toContain("Planner diagnostic: unavailable");
    // The failed-run inspect fallback names this exact saved run, and history
    // replay still refuses a placeholder retry template.
    expect(human.stdout).toContain(inspect);
    expect(human.stdout).toContain(inspectReason);
    expect(envelope.nextSteps).toEqual([inspect, inspectReason]);
    expect(human.stdout).not.toContain("docsfab doctor --repo");
    expect(human.stdout).not.toContain("<original target checkout>");
    expect(human.stdout).toContain("Resumability: non-resumable (failed)");
    expect(human.stdout).not.toContain("legacy-no-product-disposition");
    expect(human.stdout).not.toContain(INFERENCE_BLOB);
    expect(json.stdout).not.toContain(INFERENCE_BLOB);
    process.exitCode = undefined;
  });

  it("preserves product bookkeeping recovery when planner evidence is unavailable", async () => {
    const record = savedPlannerFailureRecord("invalid-envelope");
    record.steps = [];
    const { stateDirectory } = await writeSavedRun(record);
    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    process.exitCode = undefined;
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const result = decodeRunResultV1(parseJsonEvidence(json.stdout));
    const command = `docsfab runs show ${record.id} --state-dir ${stateDirectory} --json`;
    const reason =
      "Inspect the retained product-outcome and tool-accounting evidence. Preserve the failed run unchanged, correct the outcome projector or tool-accounting producer, then start a new run; do not retry unchanged inference.";
    expect(human.stdout).toContain(command);
    expect(human.stdout).toContain(reason);
    expect(result.nextSteps).toContain(command);
    expect(result.nextSteps).toContain(reason);
    expect(human.stdout).toContain("Product disposition: unavailable");
    expect(human.stdout).toContain("Planner diagnostic: unavailable");
    expect(human.stdout).not.toContain("legacy-no-product-disposition");
    expect(json.stdout).not.toContain("legacy-no-product-disposition");
  });

  it("reloads a persisted hosted HTML report onto QUALITY and the JSON envelope", async () => {
    const record = savedQualityRecord();
    const { stateDirectory } = await writeSavedRun(record);
    const quality = projectQualityReportFromRun(record);
    if (!quality) throw new Error("expected a quality report");
    const htmlReport = await persistHostedQualityReport({
      stateDirectory,
      runId: record.id,
      quality,
      markdown: record.steps[0]?.summary ?? "",
      environment: {},
    });
    const io = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(io.stdout).toContain("QUALITY");
    expect(io.stdout).toContain(`Report: ${htmlReport.url}`);
    expect(io.stdout).toContain(`Markdown path: ${htmlReport.markdownPath}`);
    expect(io.stdout).toContain(htmlReport.serveCommand);
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const envelope = decodeRunResultV1(parseJsonEvidence(json.stdout));
    expect(envelope.htmlReport).toMatchObject({
      url: htmlReport.url,
      digestSha256: htmlReport.digestSha256,
    });
    expect(Object.keys(envelope.htmlReport ?? {}).sort()).toEqual(["digestSha256", "path", "url"]);
  });

  it("rejects legacy and substituted runtime quality evidence during replay", () => {
    const legacy = savedQualityRecord();
    delete legacy.qualityProfileSelection;
    delete legacy.qualityArtifactValidation;
    expectInvalidQualityReport(legacy);

    const substituted = savedQualityRecord();
    substituted.qualityArtifactValidation = {
      ...substituted.qualityArtifactValidation!,
      repositoryRevision: "f".repeat(40),
    };
    expectInvalidQualityReport(substituted);

    const digestMismatched = savedQualityRecord();
    resealQualityValidation(digestMismatched, {
      artifacts: {
        ...digestMismatched.qualityArtifactValidation!.artifacts,
        finalReport: {
          ...digestMismatched.qualityArtifactValidation!.artifacts.finalReport!,
          payloadSha256: "9".repeat(64),
        },
      },
    });
    expectInvalidQualityReport(digestMismatched);

    const locatorMismatched = savedQualityRecord();
    rebindFinalMarkdown(
      locatorMismatched,
      locatorMismatched.steps[0]!.summary!.replace(
        `record:sha256:${"1".repeat(64)}`,
        `record:sha256:${"9".repeat(64)}`,
      ),
    );
    expectInvalidQualityReport(locatorMismatched);

    const forgedPass = savedQualityRecord();
    forgedPass.steps = [{ ...forgedPass.steps[0]!, summary: "Quality evaluation: PASS" }];
    delete forgedPass.qualityProfileSelection;
    delete forgedPass.qualityArtifactValidation;
    expect(inspectQualityReportFromRun(forgedPass)).toEqual({
      quality: null,
      error: QUALITY_REPORT_FAILURES["missing-report"],
    });
    expect(() => projectQualityReportFromRun(forgedPass)).toThrow(QualityReportProjectionError);
  });

  it("replays a retained report when quality projection fails and exits 1", async () => {
    const record = savedQualityRecord();
    record.id = "run-show-quality-invalid-001";
    record.steps = [{ ...record.steps[0]!, summary: "Evaluator output without a valid summary." }];
    const { stateDirectory } = await writeSavedRun(record);
    const retained = await persistHostedQualityReport({
      stateDirectory,
      runId: record.id,
      quality: null,
      markdown: record.steps[0]!.summary!,
    });

    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(human.stdout).toContain("QUALITY");
    expect(human.stdout).toContain("Quality: unavailable/not projected");
    expect(human.stdout).toContain(`Report: ${retained.url}`);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    const envelope = decodeRunResultV1(parseJsonEvidence(json.stdout));
    expect(envelope.quality).toBeNull();
    expect(envelope.htmlReport).toEqual({
      url: retained.url,
      path: retained.path,
      digestSha256: retained.digestSha256,
    });
    expect(envelope.nextSteps.join(" ")).toContain("missing-report");
    expect(process.exitCode).toBe(1);
  });

  it("does not list HTML-only or corrupt report pairs as available", async () => {
    const stateDirectory = await temporaryRoot("docsfab-runs-show-list-reports-");
    const legacy = { ...savedAuditRecord(), id: "legacy-html-only" };
    const corrupt = { ...savedAuditRecord(), id: "corrupt-report-pair" };
    await Promise.all(
      [legacy, corrupt].map((record) =>
        writeFile(
          join(stateDirectory, `${record.id}.json`),
          `${JSON.stringify(record, null, 2)}\n`,
          { mode: 0o600 },
        ),
      ),
    );
    await mkdir(join(stateDirectory, "reports", legacy.id), { recursive: true });
    await writeFile(join(stateDirectory, "reports", legacy.id, "index.html"), "legacy");
    await persistHostedQualityReport({
      stateDirectory,
      runId: corrupt.id,
      quality: null,
      markdown: "retained evaluator report\n",
    });
    await writeFile(
      join(stateDirectory, "reports", corrupt.id, "quality-report.md"),
      "tampered\n",
      "utf8",
    );
    const io = await captureIo(() =>
      handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
    );
    const runs = (
      JSON.parse(io.stdout) as { runs: Array<{ runId: string; report?: { available: boolean } }> }
    ).runs;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.report?.available === false)).toBe(true);
  });

  it("explains a damaged retained Markdown pair without losing quality context", async () => {
    const record = savedQualityRecord();
    const { stateDirectory } = await writeSavedRun(record);
    const quality = projectQualityReportFromRun(record);
    if (!quality) throw new Error("expected a quality report");
    const report = await persistHostedQualityReport({
      stateDirectory,
      runId: record.id,
      quality,
      markdown: record.steps[0]?.summary ?? "retained evaluator report",
    });
    await writeFile(report.markdownPath!, "tampered evaluator report\n", "utf8");
    const human = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(human.stdout).toContain("Decision: pass");
    expect(human.stdout).toContain("Report: retained report unavailable (artifact-unavailable)");
    const json = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
    );
    expect(decodeRunResultV1(parseJsonEvidence(json.stdout)).htmlReport).toBeNull();
  });

  it("rejects unknown flags, extra subcommands, and write authorization", () => {
    expect(() => parseRunsArguments(["inspect"])).toThrow(
      /supports list, show, query, import, or delete/u,
    );
    expect(() => parseRunsArguments(["inspect"])).toThrow(
      expect.objectContaining({
        code: "runs-invalid-subcommand",
        nextAction: "docsfab runs --help",
      }),
    );
    expect(() => parseRunsArguments(["show", "run-1", "--verbose"])).toThrow(
      /Unknown docsfab runs show option "--verbose"/u,
    );
    expect(() => parseRunsArguments(["show", "run-1", "--json", "--allow-write"])).toThrow(
      /does not accept write authorization/u,
    );
    expect(() => parseRunsArguments(["show", "run-1", "--json", "--mystery"])).toThrow(
      /Unknown docsfab runs show option "--mystery"/u,
    );
  });

  it("keeps saved-run loaders behind the read-only review facade", async () => {
    const runsPath = fileURLToPath(new URL("../src/cli/commands/runs.ts", import.meta.url));
    const source = await readFile(runsPath, "utf8");
    expect(source).not.toMatch(/evaluation\//u);
    expect(source).toContain("review-delivery/public.js");
    expect(source.replace("review-delivery/public.js", "")).not.toMatch(/delivery\//u);
    expect(source).not.toContain("loadVerifiedPublicationRun");
    expect(source).not.toContain("FileRunStore");
    expect(source).not.toContain("loadRunRecord");
    expect(source).not.toContain("structural.js");
  });

  it("wires docsfab runs through the router and usage text", async () => {
    expect(usage()).toContain(
      "docsfab runs show <run-id> [--json] [--show-scan] [--state-dir <path>]",
    );
    const { stateDirectory, record } = await writeSavedRun();
    const argv = process.argv;
    process.argv = [argv[0]!, argv[1]!, "runs", "show", record.id, "--state-dir", stateDirectory];
    try {
      const io = await captureIo(() => main());
      expect(io.stdout).toContain("EXECUTION");
      expect(io.stdout).toContain(record.id);
    } finally {
      process.argv = argv;
    }
  });
});

async function writeSavedRun(
  record: RunRecord = savedAuditRecord(),
): Promise<{ stateDirectory: string; record: RunRecord }> {
  const stateDirectory = await temporaryRoot("docsfab-runs-show-");
  await writeFile(
    join(stateDirectory, `${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return { stateDirectory, record };
}

function independentlyBuiltRunResult(record: RunRecord, stateDirectory: string) {
  const recordPath = defaultRunRecordPath(stateDirectory, record.id);
  const exitCode = workflowOutcomeExitCode(record, interactiveWorkflowOutcomePolicy());
  const summaryContext: RunSummaryContext = {
    record,
    recordPath,
    exitCode,
    repositoryPath: record.repository.sourcePath,
  };
  return buildRunResultV1({
    record,
    recordPath,
    exitCode,
    repositoryPath: record.repository.sourcePath,
    nextSteps: collectRunResultNextSteps(summaryContext),
  });
}

function savedAuditRecord(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-show-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example-docs",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-14T16:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "audit-documentation",
        title: "Audit documentation",
        kind: "inference",
        skill: "audit-documentation",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-14T16:00:00.000Z",
        completedAt: "2026-08-14T16:00:01.000Z",
        durationMs: 1_000,
        summary: INFERENCE_BLOB,
      },
    ],
  };
}

function savedAuditRecordWithCurrentOutcome(): RunRecord {
  const record = savedAuditRecord();
  record.id = "run-show-current-001";
  const evidence = workflowOutcomeStepEvidence(record, "audit-documentation");
  const findings: WorkflowOutcomeFindingV1[] = [
    {
      id: "finding:01-missing-audience",
      kind: "product-gap",
      severity: "blocking",
      code: "missing-audience",
      evidenceIds: [evidence.id],
    },
  ];
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "not-ready",
      findings,
      evidence: [evidence],
      limitations: [],
      openDecisions: [],
      producedArtifacts: [],
    },
    record,
  );
  return record;
}

function savedPlannerFailureRecord(code: string): RunRecord {
  const record = savedAuditRecord();
  record.id = `run-show-planner-${code}`;
  record.workflow = "create-documentation";
  record.status = "failed";
  record.instruction = "Create docs/usage.md from approved repository evidence.";
  record.error = "Workflow product outcome could not be validated or persisted.";
  record.steps = [
    {
      id: "plan-documentation",
      title: "Plan documentation",
      kind: "evaluate",
      skill: "plan-documentation",
      mode: "read-only",
      status: "needs-input",
      inference: { attempts: [{ outcome: "succeeded" }] } as never,
      startedAt: "2026-08-14T16:00:00.000Z",
      completedAt: "2026-08-14T16:00:01.000Z",
      durationMs: 1_000,
      planDiagnostic: {
        schemaVersion: 1,
        kind: "docsfab-documentation-plan-diagnostic",
        code,
        responseSha256: "d".repeat(64),
        responseShape: "json-object",
      },
      summary: INFERENCE_BLOB,
    },
  ];
  return record;
}

function savedQualityRecord(): RunRecord {
  const revision = "a".repeat(40);
  const evaluationRecord = "1".repeat(64);
  const scoreRecord = "2".repeat(64);
  const evaluatorIdentity = "3".repeat(64);
  const packBinding = "4".repeat(64);
  const runId = "run-show-quality-001";
  const markdown = [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      target: {
        paths: ["docs/guide.md"],
        repository_revision: revision,
        documentation_revision: revision,
      },
      profile: { id: "docsfab-documentation-quality", version: "v0.1" },
      evaluation: { decision: "pass", confidence: 0.9, hard_gate_failures: [] },
      rubric: {
        status: "available",
        id: "task-guide-v0.1",
        dimension_scores: {},
        total: 84,
        threshold: 80,
        interpretation_band: "Green",
        decision: "pass",
        confidence: 0.9,
        hard_gates: {},
      },
      validation: {
        evaluation: "passed",
        quality_score: "passed",
        report_binding: "passed",
      },
      artifact_locators: {
        evaluation: `record:sha256:${evaluationRecord}`,
        quality_score: `record:sha256:${scoreRecord}`,
        quality_report: `run:${runId}:evaluate-document-quality:quality-report`,
      },
    }),
    "```",
  ].join("\n");
  const selection = qualitySelectionReceipt(revision, packBinding);
  const reportSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  return {
    schemaVersion: 2,
    id: runId,
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example-docs",
      requestedRevision: "HEAD",
      revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-14T16:00:00.000Z",
    models: [],
    skills: [],
    qualityPack: qualityPack(selection, packBinding),
    qualityProfileSelection: selection,
    qualityArtifactValidation: sealQualityValidationBinding({
      runId,
      repositoryRevision: revision,
      selectionSha256: selection.selectionSha256,
      qualityPackBindingSha256: packBinding,
      evaluatorIdentitySha256: evaluatorIdentity,
      status: "passed",
      failureCode: null,
      artifacts: {
        evaluation: { recordSha256: evaluationRecord, payloadSha256: "5".repeat(64) },
        qualityScore: { recordSha256: scoreRecord, payloadSha256: "6".repeat(64) },
        candidateReport: { recordSha256: "7".repeat(64), payloadSha256: reportSha256 },
        finalReport: { recordSha256: "8".repeat(64), payloadSha256: reportSha256 },
      },
      validatorAssets: {
        evaluationScriptSha256: "65".padStart(64, "0"),
        evaluationSchemaSha256: "9".repeat(64),
        qualityScoreScriptSha256: "71".padStart(64, "0"),
        reportScriptSha256: "72".padStart(64, "0"),
      },
      validators: {
        evaluation: qualityValidatorReceipt("evaluation", [
          "5".repeat(64),
          "9".repeat(64),
          selection.profilePayloadSha256,
        ]),
        qualityScore: qualityValidatorReceipt("quality-score", ["6".repeat(64)]),
        reportBinding: qualityValidatorReceipt("report-binding", [
          "5".repeat(64),
          reportSha256,
          selection.profilePayloadSha256,
          "6".repeat(64),
        ]),
      },
    }),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "evaluate-document-quality",
        title: "Evaluate document quality",
        kind: "evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "succeeded",
        evaluateEvidence: {
          schemaVersion: 1,
          kind: "docsfab-evaluate-step-evidence",
          evaluatorIdentitySha256: evaluatorIdentity,
          toolPolicySha256: "c".repeat(64),
          acceptancePolicySha256: "d".repeat(64),
        },
        summary: markdown,
      },
    ],
  };
}

function qualitySelectionReceipt(revision: string, packBinding: string) {
  const body = {
    workflow: "review-documentation" as const,
    selectorId: "review-documentation:docsfab-documentation-quality:v1" as const,
    workflowSourceSha256: "d".repeat(64),
    repositoryIdentitySha256: createHash("sha256").update("/tmp/example-docs").digest("hex"),
    repositoryRevision: revision,
    inventorySha256: "e".repeat(64),
    targetScope: "documentation-set" as const,
    targetScopeSha256: "f".repeat(64),
    targetPathSetSha256: "5".repeat(64),
    applicabilitySha256: "6".repeat(64),
    documentCount: 1,
    qualityPackManifestSha256: "2".repeat(64),
    qualityPackBindingSha256: packBinding,
    skillLockSha256: "3".repeat(64),
    qualityLockSha256: "4".repeat(64),
    qualityBundleSha256: "1".repeat(64),
    profileBarId: "profile:docsfab-documentation-quality" as const,
    profileAssetPath: "profiles/docsfab-documentation-quality/profile.json" as const,
    profilePayloadSha256: "d425dd5c21b067ab67dbfdb6b06082b480769216a31e6df50a6341c1d8e62c01",
    profileId: "docsfab-documentation-quality" as const,
    profileVersion: "v0.1" as const,
    profileModel: "documentation-quality-model-v0.2" as const,
    profileStatus: "experimental" as const,
    releaseGateEligible: false as const,
  };
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-quality-profile-selection-receipt" as const,
    ...body,
    selectionSha256: canonicalDigest({
      schemaVersion: 1,
      kind: "docsfab-quality-profile-selection-receipt",
      ...body,
    }),
  };
}

function qualityPack(
  selection: ReturnType<typeof qualitySelectionReceipt>,
  bindingSha256: string,
): NonNullable<RunRecord["qualityPack"]> {
  return {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    manifestSha256: "2".repeat(64),
    bindingSha256,
    skillLockSha256: "3".repeat(64),
    qualityLockSha256: "4".repeat(64),
    qualityBundleSha256: selection.qualityBundleSha256,
    barIds: [selection.profileBarId],
  };
}

function qualityValidatorReceipt(
  validator: "evaluation" | "quality-score" | "report-binding",
  inputPayloadSha256s: string[],
) {
  return sealQualityValidatorReceipt({
    validator,
    program: "python3",
    scriptSha256: validator.charCodeAt(0).toString(16).padStart(64, "0"),
    inputPayloadSha256s,
    outcome: "passed",
    exitCode: 0,
    stdoutSha256: "1".repeat(64),
    stderrSha256: "2".repeat(64),
  });
}

function expectInvalidQualityReport(recordValue: RunRecord): void {
  expect(inspectQualityReportFromRun(recordValue)).toEqual({
    quality: null,
    error: QUALITY_REPORT_FAILURES["invalid-report"],
  });
  expect(() => projectQualityReportFromRun(recordValue)).toThrowError(
    expect.objectContaining({
      name: "QualityReportProjectionError",
      code: "invalid-report",
    }),
  );
}

function resealQualityValidation(
  recordValue: RunRecord,
  overrides: Partial<
    Omit<
      NonNullable<RunRecord["qualityArtifactValidation"]>,
      "schemaVersion" | "kind" | "bindingSha256"
    >
  >,
): void {
  const validation = recordValue.qualityArtifactValidation!;
  recordValue.qualityArtifactValidation = sealQualityValidationBinding({
    runId: validation.runId,
    repositoryRevision: validation.repositoryRevision,
    selectionSha256: validation.selectionSha256,
    qualityPackBindingSha256: validation.qualityPackBindingSha256,
    evaluatorIdentitySha256: validation.evaluatorIdentitySha256,
    status: validation.status,
    failureCode: validation.failureCode,
    artifacts: validation.artifacts,
    validatorAssets: validation.validatorAssets,
    validators: validation.validators,
    ...overrides,
  });
}

function rebindFinalMarkdown(recordValue: RunRecord, markdown: string): void {
  const validation = recordValue.qualityArtifactValidation!;
  const reportReceipt = validation.validators.reportBinding!;
  const payloadSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  const evaluator = recordValue.steps.find((step) => step.skill === "evaluate-document-quality")!;
  evaluator.summary = markdown;
  recordValue.qualityArtifactValidation = sealQualityValidationBinding({
    runId: validation.runId,
    repositoryRevision: validation.repositoryRevision,
    selectionSha256: validation.selectionSha256,
    qualityPackBindingSha256: validation.qualityPackBindingSha256,
    evaluatorIdentitySha256: validation.evaluatorIdentitySha256,
    status: validation.status,
    failureCode: validation.failureCode,
    artifacts: {
      ...validation.artifacts,
      finalReport: { ...validation.artifacts.finalReport!, payloadSha256 },
    },
    validatorAssets: validation.validatorAssets,
    validators: {
      ...validation.validators,
      reportBinding: sealQualityValidatorReceipt({
        validator: reportReceipt.validator,
        program: reportReceipt.program,
        scriptSha256: reportReceipt.scriptSha256,
        inputPayloadSha256s: reportReceipt.inputPayloadSha256s.map((digest, index) =>
          index === 1 ? payloadSha256 : digest,
        ),
        outcome: reportReceipt.outcome,
        exitCode: reportReceipt.exitCode,
        stdoutSha256: reportReceipt.stdoutSha256,
        stderrSha256: reportReceipt.stderrSha256,
      }),
    },
  });
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function captureIo(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message ?? ""));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

function combined(io: { stdout: string; stderr: string }): string {
  return `${io.stdout}\n${io.stderr}`;
}
