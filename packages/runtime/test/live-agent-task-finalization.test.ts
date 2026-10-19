// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { sha256 } from "../src/content-ir/canonical.js";
import {
  bindLiveAgentTaskCompletionV1,
  finalizeLiveAgentTaskCompletionV1,
} from "../src/live-agent/task-finalization.js";
import {
  decodeLiveAgentTaskResultV1,
  LIVE_AGENT_TASK_EMPTY_DIFF_SUMMARY_SHA256,
} from "../src/live-agent/task-export.js";
import {
  LIVE_AGENT_TASK_REQUEST_KIND,
  type LiveAgentTaskRequestV1,
} from "../src/live-agent/task-contract.js";

const EMPTY_DIFF_SUMMARY_SHA256 = LIVE_AGENT_TASK_EMPTY_DIFF_SUMMARY_SHA256;

function request(requiredEvidence: string[] = ["no-change-evidence"]): LiveAgentTaskRequestV1 {
  const prompt = "Update this documentation if needed.";
  return {
    schemaVersion: 1,
    kind: LIVE_AGENT_TASK_REQUEST_KIND,
    taskId: "task-finalization-1",
    sessionId: "session-finalization-1",
    prompt: { encoding: "utf-8", text: prompt, sha256: sha256(Buffer.from(prompt, "utf8")) },
    baseline: { repositoryRevision: "a".repeat(40), contentSha256: "b".repeat(64) },
    sources: [],
    scope: {
      documentationRoots: ["docs"],
      requestedPaths: ["docs/guide.md"],
      writeClass: "documentation",
    },
    requiredEvidence,
    effectiveConfig: {
      profileId: "profile-default",
      modelId: "model-default",
      configurationSha256: "c".repeat(64),
      values: {},
    },
  };
}

function finalize(
  decision: "change" | "no-change" | "needs-input" | "refuse" | "unknown",
  overrides: Partial<Parameters<typeof finalizeLiveAgentTaskCompletionV1>[0]> = {},
) {
  return finalizeLiveAgentTaskCompletionV1({
    executionStatus: "completed",
    declaration: {
      schemaVersion: 1,
      kind: "docsfab-live-agent-task-declaration",
      decision,
      evidenceIds: ["no-change-evidence"],
    },
    artifacts: [],
    evidence: [
      {
        evidenceId: "no-change-evidence",
        kind: "agent-declaration",
        availability: "available",
        sha256: "d".repeat(64),
      },
    ],
    checks: [
      {
        checkId: "agent-reported",
        status: "passed",
        authority: "agent",
        evidenceIds: ["no-change-evidence"],
      },
    ],
    diff: { status: "empty", sha256: EMPTY_DIFF_SUMMARY_SHA256 },
    nativeChildRecords: [],
    usage: { status: "redacted", inputTokens: null, outputTokens: null, totalTokens: null },
    trace: {
      status: "clipped",
      activitySha256: null,
      childRecordIds: [],
      missing: ["tool-activity"],
    },
    limitations: ["Tool activity was clipped."],
    ...overrides,
  });
}

describe("live-agent task finalization", () => {
  it("marks no-change structurally evidence-backed without creating a workflow verdict", () => {
    const task = request();
    const completion = finalize("no-change");
    expect(completion.noChangeClaim).toEqual({
      claimed: true,
      classification: "evidence-backed",
      evidenceIds: ["no-change-evidence"],
    });
    expect(completion.checks).toEqual([
      {
        checkId: "agent-reported",
        status: "passed",
        authority: "agent",
        evidenceIds: ["no-change-evidence"],
      },
    ]);
    const result = bindLiveAgentTaskCompletionV1(task, completion);
    expect(result.agentDecision).toBe("no-change");
    expect(result.checks.some((check) => check.authority === "workflow")).toBe(false);
    expect(result).not.toHaveProperty("qualityVerdict");
    expect(result).not.toHaveProperty("benchmarkCorrect");
    expect(result).not.toHaveProperty("runRecord");
  });

  it("keeps a model-only no-change statement unsubstantiated when evidence or the empty diff is absent", () => {
    const completion = finalize("no-change", {
      evidence: [
        {
          evidenceId: "no-change-evidence",
          kind: "agent-declaration",
          availability: "missing",
          sha256: null,
        },
      ],
      diff: { status: "unavailable", sha256: null },
    });
    expect(completion.agentDecision).toBe("no-change");
    expect(completion.noChangeClaim.classification).toBe("unsubstantiated");
    expect(completion.checks[0]?.authority).toBe("agent");
  });

  it("refuses to bind a completion that omits a required evidence obligation", () => {
    expect(() =>
      bindLiveAgentTaskCompletionV1(request(["required-workflow-check"]), finalize("change")),
    ).toThrow(expect.objectContaining({ code: "missing-required-evidence" }));
  });

  it("rejects inconsistent evidence-backed no-change, complete usage, and complete trace without binding", () => {
    const availableEvidenceWithoutDigest = [
      {
        evidenceId: "no-change-evidence",
        kind: "agent-declaration" as const,
        availability: "available" as const,
        sha256: null,
      },
    ];
    expect(() =>
      finalize("no-change", {
        evidence: availableEvidenceWithoutDigest,
        diff: { status: "empty", sha256: EMPTY_DIFF_SUMMARY_SHA256 },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-value" }));
    expect(() =>
      finalize("no-change", { diff: { status: "empty", sha256: "not-a-sha256" } }),
    ).toThrow(expect.objectContaining({ code: "invalid-value" }));

    expect(() =>
      finalize("change", {
        usage: { status: "complete", inputTokens: null, outputTokens: null, totalTokens: null },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-value" }));

    expect(() =>
      finalize("change", {
        trace: {
          status: "complete",
          activitySha256: null,
          childRecordIds: [],
          missing: ["activity"],
        },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-value" }));
  });

  it("requires the canonical empty-summary digest before claiming evidence-backed no-change", () => {
    for (const digest of [sha256(Buffer.alloc(0)), "f".repeat(64)]) {
      expect(() => finalize("no-change", { diff: { status: "empty", sha256: digest } })).toThrow(
        expect.objectContaining({ code: "invalid-value" }),
      );
    }
    expect(
      finalize("no-change", { diff: { status: "empty", sha256: null } }).noChangeClaim
        .classification,
    ).toBe("unsubstantiated");

    const task = request();
    const canonical = bindLiveAgentTaskCompletionV1(task, finalize("no-change"));
    expect(canonical.noChangeClaim.classification).toBe("evidence-backed");
    for (const digest of [sha256(Buffer.alloc(0)), "f".repeat(64)]) {
      expect(() =>
        decodeLiveAgentTaskResultV1(
          { ...canonical, diff: { status: "empty", sha256: digest } },
          task,
        ),
      ).toThrow(expect.objectContaining({ code: "invalid-value" }));
    }
  });

  it("validates the full completion projection before returning it", () => {
    const artifact = {
      artifactId: "draft-page",
      kind: "candidate" as const,
      path: "docs/guide.md",
      sha256: "e".repeat(64),
      disposition: "candidate" as const,
    };
    expect(() =>
      finalize("change", { artifacts: [{ ...artifact, path: "/tmp/secret.md" }] }),
    ).toThrow(expect.objectContaining({ code: "invalid-value" }));
    expect(() => finalize("change", { artifacts: [artifact, artifact] })).toThrow(
      expect.objectContaining({ code: "invalid-value" }),
    );

    const check = {
      checkId: "agent-reported",
      status: "passed" as const,
      authority: "agent" as const,
      evidenceIds: ["no-change-evidence"],
    };
    expect(() => finalize("change", { checks: [check, check] })).toThrow(
      expect.objectContaining({ code: "invalid-value" }),
    );
    expect(() =>
      finalize("change", {
        childRunResults: [
          {
            execution: {
              runId: "child-run",
              workflow: "docs",
              status: "failed",
              exitCode: 9,
              patchSha256: null,
            },
          } as never,
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-value" }));
    expect(() => finalize("change", { limitations: [42] as never })).toThrow(
      expect.objectContaining({ code: "invalid-value" }),
    );
  });

  it("retains partial artifacts, incomplete usage/trace, and missing evidence without a RunRecord", () => {
    const task = request(["no-change-evidence", "workflow-check"]);
    const completion = finalize("change", {
      executionStatus: "partial",
      artifacts: [
        {
          artifactId: "draft-page",
          kind: "candidate",
          path: "docs/guide.md",
          sha256: "e".repeat(64),
          disposition: "partial",
        },
      ],
      evidence: [
        {
          evidenceId: "no-change-evidence",
          kind: "agent-declaration",
          availability: "available",
          sha256: "d".repeat(64),
        },
        {
          evidenceId: "workflow-check",
          kind: "workflow-result",
          availability: "missing",
          sha256: null,
        },
      ],
      checks: [
        {
          checkId: "workflow-not-run",
          status: "not-run",
          authority: "workflow",
          evidenceIds: ["workflow-check"],
        },
      ],
      diff: { status: "unavailable", sha256: null },
      usage: { status: "incomplete", inputTokens: 12, outputTokens: null, totalTokens: null },
      trace: {
        status: "incomplete",
        activitySha256: null,
        childRecordIds: [],
        missing: ["native-trace"],
      },
    });
    const result = bindLiveAgentTaskCompletionV1(task, completion);
    expect(result.executionStatus).toBe("partial");
    expect(result.artifacts[0]?.disposition).toBe("partial");
    expect(
      result.evidence.find((entry) => entry.evidenceId === "workflow-check")?.availability,
    ).toBe("missing");
    expect(result.usage.status).toBe("incomplete");
    expect(result.trace.status).toBe("incomplete");
    expect(result).not.toHaveProperty("runRecord");
  });
});
