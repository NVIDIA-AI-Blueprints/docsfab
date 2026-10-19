// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/autonomy/managed-publish-host.js", async () => {
  const actual = await vi.importActual<typeof import("../src/autonomy/managed-publish-host.js")>(
    "../src/autonomy/managed-publish-host.js",
  );
  return {
    ...actual,
    submitAfterSucceededRun: vi.fn(async () => ({
      mergeRequest: { url: "https://gitlab.example.test/group/project/-/merge_requests/42" },
    })),
  };
});

vi.mock("../src/cli/comment-existing-mr.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cli/comment-existing-mr.js")>(
    "../src/cli/comment-existing-mr.js",
  );
  return {
    ...actual,
    postCommentExistingMrReviewSummary: vi.fn(async () => ({
      status: "projected" as const,
      mutation: "created",
      reviewedHeadSha: "d".repeat(40),
      mergeRequestIid: 88,
      noteId: "note-1",
      deliveryIntent: "docsfab-comment-existing-mr-review-summary",
    })),
  };
});

import { deliverCliRunResult, decodeFailedPublicationOutcome } from "../src/cli/run/delivery.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import {
  EmptyPublishableWriteError,
  submitAfterSucceededRun,
} from "../src/autonomy/managed-publish-host.js";
import {
  DeliveryWorktreeError,
  LocalUserPublicationPreflightError,
} from "../src/delivery/contracts.js";
import {
  bindCommentExistingMrTarget,
  CommentExistingMrHeadChangedError,
  postCommentExistingMrReviewSummary,
} from "../src/cli/comment-existing-mr.js";
import type { CliRunInvocation, CliRunOutput } from "../src/cli/run/request.js";
import type { RunPreflight } from "../src/cli/run/preflight.js";
import type { ExecutedCliRun } from "../src/cli/run/execution.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { CommentExistingMrPort } from "../src/cli/comment-existing-mr.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import {
  authoringReviewFindingsRecord,
  UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN,
} from "./helpers/authoring-review-record.js";

const roots: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function minimalRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-test-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    tools: { attempted: 0, succeeded: 0, failed: 0, denied: 0 },
    steps: [],
    ...overrides,
  } as RunRecord;
}

function stubConfig(stateDirectory = "/tmp/docsfab-quiet-delivery-state"): DocsFabConfig {
  return {
    projectRoot: "/tmp/does-not-matter",
    skillCrateDirectory: "/tmp/does-not-matter/skill-crate",
    qualityDirectory: "/tmp/does-not-matter/quality",
    qualityPackDirectory: "/tmp/does-not-matter/quality-pack",
    stateDirectory,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

function capturingOutput(): { output: CliRunOutput; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    output: {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    },
    logs,
    errors,
  };
}

/** CLI invocation with neutral request defaults; `options` follows `request.quiet` unless given. */
function cliInvocation(
  output: CliRunOutput,
  request: Partial<CliRunInvocation["request"]>,
  options: CliRunInvocation["options"] = { quiet: request.quiet ?? false },
  config: DocsFabConfig = stubConfig(),
): CliRunInvocation {
  return {
    request: {
      workflow: "review-documentation",
      repositoryPath: "/tmp/example",
      revision: "HEAD",
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      quiet: false,
      ...request,
    },
    config,
    options,
    output,
  };
}

/** Succeeded run with one modified page and a preserved patch, eligible for a draft MR. */
function draftMrRecord(): RunRecord {
  return minimalRunRecord({
    status: "succeeded",
    changes: {
      files: [{ path: "docs/page.md", changeKind: "modified" } as never],
      patch: {
        sha256: "f".repeat(64),
        byteLength: 12,
        lineCount: 1,
        artifactPath: "/tmp/patches/run-test-001.patch",
        format: "git-diff",
      },
    },
  });
}

function minimalWorkspace() {
  return {
    path: "/tmp/example-workspace",
    sourcePath: "/tmp/example",
    requestedRevision: "HEAD",
    revision: "a".repeat(40),
    dispose: async () => undefined,
  };
}

function minimalPreflight(
  workflow: "review-documentation" | "create-documentation" = "review-documentation",
): RunPreflight {
  return { workflow: getWorkflow(workflow) };
}

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => lines.push(String(message ?? ""));
  try {
    await action();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("deliverCliRunResult authoring findings", () => {
  it("shows admitted findings on the initial human result without admitting evaluator Markdown", async () => {
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(output, {
      workflow: "create-documentation",
      allowWrite: true,
    });
    const record = authoringReviewFindingsRecord();
    await deliverCliRunResult(
      invocation,
      minimalWorkspace(),
      minimalPreflight("create-documentation"),
      { record, exitCode: 0 },
    );
    const human = logs.join("\n");
    expect(human).toContain("PRODUCT\n  Product disposition: inconclusive");
    expect(human).toContain("REVIEW FINDINGS\n  Availability: partial (2)");
    expect(human).toContain("[warning] FACT-001 at docs/usage.md:12");
    expect(human).toContain("technical-issue=TECH-001");
    expect(human).toContain("[info] TASK-001 at docs/usage.md:20");
    expect(human).not.toContain(UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN);
    expect(record.workflowOutcome?.disposition).toBe("inconclusive");
  });

  it("keeps verified patch counts and inspect guidance across initial and saved presentation", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-patch-presentation-"));
    roots.push(root);
    const stateDirectory = join(root, "runs");
    const artifactDirectory = join(root, "patches");
    await Promise.all([
      mkdir(stateDirectory, { recursive: true }),
      mkdir(artifactDirectory, { recursive: true }),
    ]);
    const patchText = `${[
      "diff --git a/docs/usage.md b/docs/usage.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/usage.md",
      "@@ -0,0 +1,112 @@",
      ...Array.from({ length: 112 }, (_, index) => `+line-${String(index).padStart(3, "0")}`),
    ].join("\n")}\n`;
    const patchPath = join(artifactDirectory, "run-patch-presentation.patch");
    await writeFile(patchPath, patchText, { mode: 0o600 });
    const record = minimalRunRecord({
      id: "run-patch-presentation",
      workflow: "create-documentation",
      changes: {
        files: [{ path: "docs/usage.md", status: "added" }],
        patch: {
          sha256: createHash("sha256").update(patchText).digest("hex"),
          byteLength: Buffer.byteLength(patchText),
          lineCount: patchText.split("\n").length - 1,
          artifactPath: patchPath,
          format: "git-diff",
        },
      },
    });
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(
      output,
      { workflow: "create-documentation", allowWrite: true },
      { quiet: false },
      stubConfig(stateDirectory),
    );
    await deliverCliRunResult(
      invocation,
      minimalWorkspace(),
      minimalPreflight("create-documentation"),
      { record, exitCode: 0 },
    );
    await writeFile(
      join(stateDirectory, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );

    const replay = await captureConsole(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    const expectedPatchLine = "  docs/usage.md  +112/-0";
    expect(logs.find((line) => line.includes("docs/usage.md"))).toBe(expectedPatchLine);
    expect(replay.split("\n").find((line) => line.includes("docs/usage.md"))).toBe(
      expectedPatchLine,
    );
    const command = `docsfab runs show ${record.id} --state-dir ${stateDirectory} --json`;
    const reason =
      "Inspect the saved product evidence and review the local patch before deciding whether to publish.";
    for (const outputText of [logs.join("\n"), replay]) {
      expect(outputText).toContain(command);
      expect(outputText).toContain(reason);
      expect(outputText).not.toContain("docsfab publish");
    }
    const jsonReplay = JSON.parse(
      await captureConsole(() =>
        handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
      ),
    ) as { nextSteps: string[] };
    expect(jsonReplay.nextSteps).toEqual([command, reason]);

    await writeFile(patchPath, patchText.replace("+line-001", "+LINE-001"), { mode: 0o600 });
    const tampered = await captureConsole(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(tampered.split("\n")).toContain("  docs/usage.md");
    expect(tampered).not.toContain("+112/-0");

    await rm(patchPath);
    const missing = await captureConsole(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(missing.split("\n")).toContain("  docs/usage.md");
    expect(missing).not.toContain("+112/-0");
  });
});

describe("deliverCliRunResult public --quiet (#314)", () => {
  it("prints the compact --quiet footer: VERDICT + RECORD, no EXECUTION/PRODUCT", async () => {
    // planning/design/10-cli-visual-dialect.md § Verbosity ladder: `--quiet` is
    // verdict + NEXT + PATCH (if any) + RECORD, not silent and not the default
    // supporting sections.
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(output, { quiet: true });
    const execution: ExecutedCliRun = { record: minimalRunRecord(), exitCode: 0 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).toContain("review-documentation run-test");
    expect(logs.join("\n")).toContain("succeeded");
    expect(logs.join("\n")).toContain("run-test-001.json");
    expect(logs).toContain("VERDICT");
    expect(logs).toContain("RECORD");
    expect(logs).not.toContain("EXECUTION");
    expect(logs).not.toContain("PRODUCT");
  });

  it("still reports a blocked security-scan finding on stderr under --quiet", async () => {
    const { output, errors } = capturingOutput();
    const invocation = cliInvocation(output, { quiet: true });
    const record = minimalRunRecord({
      securityScan: {
        ruleSet: "default",
        status: "blocked",
        scannedFiles: 3,
        binaryFiles: 0,
        findings: [{ path: "docs/secret.md", ruleId: "credential-shape" }],
      },
    });
    const execution: ExecutedCliRun = { record, exitCode: 0 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(errors.join("\n")).toContain("Repository scan: 1 finding(s); effective blocked.");
  });

  it("still reports the draft-MR URL under --quiet", async () => {
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(output, { allowWrite: true, quiet: true, draftMr: true });
    const record = draftMrRecord();
    const editorialDecodeOptions = {
      decodeWorkflowBranchCoverage: vi.fn(),
      decodeEditorialDecision: vi.fn(),
    } as unknown as NonNullable<ExecutedCliRun["editorialDecodeOptions"]>;
    const execution: ExecutedCliRun = { record, exitCode: 0, editorialDecodeOptions };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(logs).toContain(
      "Draft merge request: https://gitlab.example.test/group/project/-/merge_requests/42",
    );
    expect(vi.mocked(submitAfterSucceededRun).mock.calls.at(-1)?.[2]).toMatchObject({
      editorialDecodeOptions,
    });
  });

  it("hands continuation coordination the typed publication result", async () => {
    const publicationResult = {
      schemaVersion: 1 as const,
      kind: "docsfab-local-user-gitlab-publication-result" as const,
      status: "opened" as const,
      planSha256: "a".repeat(64),
      idempotencyKey: "b".repeat(64),
      receiptSha256: "c".repeat(64),
      state: "opened" as const,
      disposition: "succeeded" as const,
      sourceBranch: "docs/run-test",
      targetBranch: "main",
      commitRevision: "d".repeat(40),
      mergeRequest: {
        iid: 42,
        url: "https://gitlab.example.test/group/project/-/merge_requests/42",
        draft: true as const,
        headRevision: "d".repeat(40),
      },
    };
    vi.mocked(submitAfterSucceededRun).mockImplementationOnce(async () => ({
      mergeRequest: publicationResult.mergeRequest,
      publicationResult,
    }));
    const { output } = capturingOutput();
    const outcome = vi.fn();
    const invocation = cliInvocation(
      output,
      {
        allowWrite: true,
        draftMr: true,
        gitlabTargetAtRunStart: { branch: "main", revision: "e".repeat(40) },
      },
      { onDeliveryOutcome: outcome },
    );
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), {
      record: draftMrRecord(),
      exitCode: 0,
    });
    expect(outcome).toHaveBeenCalledWith({
      status: "settled",
      mode: "draft-mr",
      locator: publicationResult.mergeRequest.url,
      publicationResult,
    });
  });

  it("keeps publisher activity out of the settled quiet result", async () => {
    const mocked = vi.mocked(submitAfterSucceededRun);
    mocked.mockImplementationOnce(async (_record, _envelope, context) => {
      context.log?.("INTERNAL_PUBLISH_HOST_JSON_ENVELOPE");
      return {
        mergeRequest: { url: "https://gitlab.example.test/group/project/-/merge_requests/42" },
      } as never;
    });
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(output, { allowWrite: true, quiet: true, draftMr: true });
    const record = draftMrRecord();
    const execution: ExecutedCliRun = { record, exitCode: 0 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(logs.join("\n")).not.toContain("INTERNAL_PUBLISH_HOST_JSON_ENVELOPE");
    expect(logs).toContain(
      "Draft merge request: https://gitlab.example.test/group/project/-/merge_requests/42",
    );
  });

  it("does not leak publisher activity when quiet publication fails", async () => {
    const mocked = vi.mocked(submitAfterSucceededRun);
    mocked.mockImplementationOnce(async (_record, _envelope, context) => {
      context.log?.("INTERNAL_PUBLISH_HOST_FAILURE_ENVELOPE");
      throw new Error(
        "Publication failed (remote-rejected); preserved recovery evidence was emitted.",
      );
    });
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(output, { allowWrite: true, quiet: true, draftMr: true });
    const record = draftMrRecord();
    const execution: ExecutedCliRun = { record, exitCode: 0 };
    await expect(
      deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution),
    ).rejects.toThrow(
      "Publication failed (remote-rejected); preserved recovery evidence was emitted.",
    );
    expect(logs.join("\n")).not.toContain("INTERNAL_PUBLISH_HOST_FAILURE_ENVELOPE");
  });

  it("keeps publisher log payloads out of the ordinary settled result", async () => {
    const mocked = vi.mocked(submitAfterSucceededRun);
    mocked.mockImplementationOnce(async (_record, _envelope, context) => {
      context.log?.("INTERNAL_PUBLISH_HOST_JSON_ENVELOPE");
      return {
        mergeRequest: { url: "https://gitlab.example.test/group/project/-/merge_requests/42" },
      } as never;
    });
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(output, { allowWrite: true, draftMr: true });
    const record = draftMrRecord();
    const execution: ExecutedCliRun = { record, exitCode: 0 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(logs.join("\n")).not.toContain("INTERNAL_PUBLISH_HOST_JSON_ENVELOPE");
    expect(logs).toContain(
      "Draft merge request: https://gitlab.example.test/group/project/-/merge_requests/42",
    );
  });

  it.each([
    ["ordinary", false, false],
    ["json", false, true],
    ["quiet", true, false],
  ] as const)(
    "preserves safe delivery failure evidence through %s output",
    async (_name, quiet, json) => {
      const mocked = vi.mocked(submitAfterSucceededRun);
      mocked.mockImplementationOnce(async () => {
        throw new DeliveryWorktreeError("validation-failed", {
          reasonCode: "validation-check-failed",
          results: [{ id: "documentation-relative-links", status: "failed" }],
        });
      });
      const { output, logs, errors } = capturingOutput();
      const invocation = cliInvocation(
        output,
        { allowWrite: true, json, quiet, draftMr: true },
        { quiet, json },
      );
      const record = draftMrRecord();
      const delivery = deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), {
        record,
        exitCode: 0,
      });
      if (quiet || json)
        await expect(delivery).rejects.toMatchObject({ code: "validation-failed" });
      else await expect(delivery).resolves.toBe(record);
      const rendered = [...logs, ...errors].join("\n");
      expect(rendered).not.toContain('"failurePersistence":"stored"');
      expect(rendered).not.toContain("private validation output");
      if (!json) {
        expect(rendered).toContain("Validation: validation-check-failed");
        expect(rendered).toContain("Check documentation-relative-links: failed");
      } else {
        expect(logs).toHaveLength(1);
        expect(() => JSON.parse(logs[0]!)).not.toThrow();
      }
    },
  );

  it("still reports a failed run's reason on stderr under --quiet", async () => {
    // `run-summary.ts` returns before the `FAILURE` section under quiet, so a
    // failed run's reason reaches no stream unless `deliverCliRunResult`
    // re-emits it.
    const { output, logs, errors } = capturingOutput();
    const invocation = cliInvocation(output, { quiet: true });
    const record = minimalRunRecord({
      status: "failed",
      error: "model provider refused the request: quota exhausted",
      steps: [
        {
          id: "audit-docs",
          title: "Audit docs",
          skill: "audit-documentation",
          mode: "read-only",
          status: "failed",
          error: "step blew up",
        },
      ],
    });
    const execution: ExecutedCliRun = { record, exitCode: 1 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(logs).not.toContain("FAILURE");
    expect(errors).toEqual([
      "Run run-test-001 failed at step audit-docs.",
      "Step audit-docs failed: step blew up",
      "model provider refused the request: quota exhausted",
    ]);
  });

  it("omits the failure reason from stderr under --quiet when the run succeeded", async () => {
    const { output, errors } = capturingOutput();
    const invocation = cliInvocation(output, { quiet: true });
    const execution: ExecutedCliRun = { record: minimalRunRecord(), exitCode: 0 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(errors).toEqual([]);
  });

  it("still reports the comment-MR confirmation under --quiet", async () => {
    const { output, logs } = capturingOutput();
    const order: string[] = [];
    const orderedOutput: CliRunOutput = {
      log: (message) => {
        order.push("output");
        output.log(message);
      },
      error: (message) => output.error(message),
    };
    vi.mocked(postCommentExistingMrReviewSummary).mockImplementationOnce(async () => {
      order.push("comment");
      return {
        status: "projected",
        mutation: "created",
        reviewedHeadSha: "d".repeat(40),
        mergeRequestIid: 88,
        noteId: "note-1",
        deliveryIntent: "docsfab-comment-existing-mr-review-summary",
        headSha: "d".repeat(40),
        requestIdentitySha256: "e".repeat(64),
        proofStatus: "current",
      };
    });
    const binding = bindCommentExistingMrTarget(
      {
        host: "gitlab.example.test",
        projectId: 437040,
        mergeRequestIid: 88,
        sourceBranch: "docsfab/topic",
        targetBranch: "main",
        headSha: "d".repeat(40),
        requestIdentitySha256: "e".repeat(64),
        proofStatus: "current",
      },
      "review-documentation",
      0,
    );
    const invocation = cliInvocation(
      orderedOutput,
      { quiet: true, commentMr: "88", commentMrBinding: binding },
      { quiet: true, commentExistingMr: {} as unknown as CommentExistingMrPort },
    );
    const execution: ExecutedCliRun = { record: minimalRunRecord(), exitCode: 0 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(logs.join("\n")).toContain("Review summary created on MR !88");
    expect(order[0]).toBe("comment");
    expect(order.slice(1).every((event) => event === "output")).toBe(true);
  });

  it.each(["human", "quiet", "json"] as const)(
    "prints the saved run result after a terminal comment failure in %s mode",
    async (mode) => {
      const { output, logs } = capturingOutput();
      const failure = Object.assign(new Error("comment write refused"), {
        code: "comment-post-rejected",
      });
      vi.mocked(postCommentExistingMrReviewSummary).mockRejectedValueOnce(failure);
      const onDeliveryOutcome = vi.fn();
      const binding = bindCommentExistingMrTarget(
        {
          host: "gitlab.example.test",
          projectId: 437040,
          mergeRequestIid: 88,
          sourceBranch: "docsfab/topic",
          targetBranch: "main",
          headSha: "d".repeat(40),
          requestIdentitySha256: "e".repeat(64),
          proofStatus: "current",
        },
        "review-documentation",
        0,
      );
      const invocation = cliInvocation(
        output,
        {
          commentMr: "88",
          commentMrBinding: binding,
          quiet: mode === "quiet",
          json: mode === "json",
        },
        {
          quiet: mode === "quiet",
          json: mode === "json",
          commentExistingMr: {} as CommentExistingMrPort,
          onDeliveryOutcome,
        },
      );
      const delivered = deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), {
        record: minimalRunRecord(),
        exitCode: 0,
      });
      if (mode === "human") await expect(delivered).resolves.toMatchObject({ id: "run-test-001" });
      else await expect(delivered).rejects.toBe(failure);

      expect(onDeliveryOutcome).toHaveBeenCalledWith({
        status: "failed",
        mode: "comment-mr",
        failureCode: "comment-post-rejected",
      });
      const rendered = logs.join("\n");
      expect(rendered).toContain("run-test-001");
      expect(rendered).not.toContain("Review summary created on MR !88");
      expect(rendered).not.toContain("docsfab publish run-test-001");
      if (mode === "json") {
        expect(logs).toHaveLength(1);
        expect(() => JSON.parse(logs[0]!)).not.toThrow();
      } else {
        expect(rendered).toContain("RECORD");
        expect(rendered).toContain("docsfab runs show run-test-001");
        if (mode === "human") {
          expect(rendered).toContain("Status: failed (comment-publication-failed)");
          expect(process.exitCode).toBe(1);
        }
      }
    },
  );

  it("still returns a first changed MR head to the invocation retry", async () => {
    const { output, logs } = capturingOutput();
    const observed = {
      host: "gitlab.example.test",
      projectId: 437040,
      mergeRequestIid: 88,
      sourceBranch: "docsfab/topic",
      targetBranch: "main",
      headSha: "d".repeat(40),
      requestIdentitySha256: "e".repeat(64),
      proofStatus: "current" as const,
    };
    const failure = new CommentExistingMrHeadChangedError(observed);
    vi.mocked(postCommentExistingMrReviewSummary).mockRejectedValueOnce(failure);
    const invocation = cliInvocation(
      output,
      {
        commentMr: "88",
        commentMrBinding: bindCommentExistingMrTarget(observed, "review-documentation", 0),
      },
      { commentExistingMr: {} as CommentExistingMrPort },
    );
    await expect(
      deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), {
        record: minimalRunRecord(),
        exitCode: 0,
      }),
    ).rejects.toBe(failure);
    expect(logs).toEqual([]);
  });
});

describe("deliverCliRunResult publication failure honesty", () => {
  it("labels a pre-log stale-revision throw as stale-revision, not an empty patch", async () => {
    const mocked = vi.mocked(submitAfterSucceededRun);
    mocked.mockRejectedValueOnce(new LocalUserPublicationPreflightError("stale-revision"));
    const { output, logs } = capturingOutput();
    const invocation = cliInvocation(output, {
      workflow: "create-documentation",
      allowWrite: true,
      draftMr: true,
    });
    const record = minimalRunRecord({
      status: "succeeded",
      workflow: "create-documentation",
      changes: {
        files: [
          { path: ".docsfab.json", status: "added" },
          { path: "docs/get-started/faq.md", status: "added" },
        ],
        patch: {
          sha256: "f".repeat(64),
          byteLength: 12,
          lineCount: 1,
          artifactPath: "/tmp/patches/run-test-001.patch",
          format: "git-diff",
        },
      },
    });
    const execution: ExecutedCliRun = { record, exitCode: 0 };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), execution);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Status: failed (stale-revision)");
    // A post-write refusal republishes the preserved write, never the pre-write
    // diagnosis. The reason is a literal transcribed from `staleRevisionRecovery`
    // in src/operator/run-summary.ts, not recomputed through the selector.
    expect(logs.join("\n")).toContain(`docsfab ship ${record.id} --repo /tmp/example`);
    expect(logs.join("\n")).toContain(
      "The run base is not an ancestor of GitLab's target branch. Merge it into the target branch, then run this to republish the preserved write without re-running the workflow; or start a new run from a commit on the target branch.",
    );
    expect(logs.join("\n")).not.toContain("docsfab doctor");
    expect(logs.join("\n")).not.toContain("no run was created");
    // The whole screen must agree with that NEXT: the real
    // `LocalUserPublicationPreflightError` detail must not tell the operator to
    // start over while their write is preserved (src/delivery/contracts.ts).
    expect(logs.join("\n")).not.toContain("Create a new run at");
    expect(logs.join("\n")).toContain(
      "republish a preserved write with `docsfab ship <run-id> --repo <path>`",
    );
    expect(logs.join("\n")).not.toContain("No documentation files.");
    expect(logs.join("\n")).toContain("docs/get-started/faq.md");
  });

  it("keeps publication-not-attempted only for an empty documentation patch", () => {
    expect(decodeFailedPublicationOutcome(undefined, new EmptyPublishableWriteError())).toEqual({
      status: "failed",
      failureCode: "publication-not-attempted",
      phase: "post-write",
    });
    expect(
      decodeFailedPublicationOutcome(
        undefined,
        new LocalUserPublicationPreflightError("stale-revision"),
      ),
    ).toMatchObject({ status: "failed", failureCode: "stale-revision", phase: "post-write" });
    expect(decodeFailedPublicationOutcome(undefined, new Error("boom"))).toMatchObject({
      status: "failed",
      failureCode: "publication-failed",
      phase: "post-write",
    });
  });
});
