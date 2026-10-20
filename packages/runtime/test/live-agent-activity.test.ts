// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { LOCAL_REVIEW_SCOPE_FAILURES } from "../src/workflow-execution/local-review-scope.js";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUALITY_ARTIFACT_FAILURES } from "../src/evaluation-report/quality-validator-host.js";
import { LiveAgentActivityRenderer, failureReason } from "../src/live-agent/activity-renderer.js";
import { LIVE_REVIEW_TARGET_FAILURES } from "../src/live-agent/review-target.js";
import { classifyModelFailure } from "../src/model/context-budget.js";
import { resolve } from "node:path";
import {
  LIVE_KNOWLEDGE_STOP_DIAGNOSTICS,
  LIVE_KNOWLEDGE_STOP_NOT_RETAINED,
  createLiveAgentToolDefinitions,
  liveWorkflowKnowledgeStop,
} from "../src/live-agent/capabilities.js";
import { renderLiveAgentKnowledgeStop } from "../src/live-agent/activity-renderer.js";
import { parseRunsArguments } from "../src/cli/commands/runs.js";
import { KnowledgeContinuationError } from "../src/records/knowledge-continuation.js";
import {
  KnowledgeResumeError,
  knowledgeResumeNeedsInputMessage,
  type KnowledgeResumeStopReason,
} from "../src/cli/knowledge-resume.js";
import { runTerminalConversation } from "../src/live-agent/host.js";
import type { ProviderRetryNotice } from "../src/model/provider.js";
import type { ProviderErrorTelemetryV1 } from "../src/records/contracts.js";
import { LocalUserPublicationPreflightError } from "../src/delivery/contracts.js";
import { GITLAB_READ_FAILURES } from "../src/live-agent/gitlab-read.js";
import { LIVE_SKILL_FAILURES } from "../src/live-agent/skill-references.js";
import {
  COMMAND_APPROVAL_PROMPT,
  type LiveConfirmation,
} from "../src/live-agent/command-approval.js";
import {
  DOCUMENTATION_WORK_REFUSAL,
  DOCUMENTATION_WORK_PREREQUISITE_ACTION,
} from "../src/live-agent/documentation-work-state.js";

const options = {
  environment: { NO_COLOR: "1" },
  skillIds: ["review-documentation"],
  workflowIds: ["review-documentation"],
  qualityPath: ".docsfab-governed-assets/quality",
};

it.each(Object.values(LIVE_REVIEW_TARGET_FAILURES))(
  "renders the exact safe PR target diagnostic: %s",
  (message) => {
    expect(failureReason(message, [])).toBe(message);
    expect(failureReason(`${message} private suffix`, [])).toBeUndefined();
    expect(failureReason(`private prefix ${message}`, [])).toBeUndefined();
  },
);

it("keeps a network-disabled review refusal terminal without provider evidence", () => {
  const message = LIVE_REVIEW_TARGET_FAILURES["live-review-retry-network-disabled"];
  for (const error of [message, new Error(message)]) {
    expect(classifyModelFailure(error)).toEqual({
      category: "provider-terminal",
      retryable: false,
    });
    expect(failureReason(error, [])).toBe(message);
  }
});

it.each([
  ["insufficient-evidence", "Evidence limited", "available evidence does not support"],
  ["fail", "Findings", "findings that need correction"],
  ["human-review", "Findings", "findings that need human review"],
])("distinguishes execution from the %s review conclusion", (decision, label, explanation) => {
  const { activity, output } = renderer();
  activity.begin();
  activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
  activity.handle(
    end("docsfab_run_workflow", {
      details: {
        status: "succeeded",
        quality: { decision },
        workflow: "review-documentation",
      },
    }),
  );
  activity.dispose();
  expect(output()).toContain(`[${label}]`);
  expect(output()).toContain(explanation);
  expect(output()).not.toContain("[Done]");
});

function renderer(columns = 100) {
  const chunks: string[] = [];
  const activity = new LiveAgentActivityRenderer({
    ...options,
    tty: true,
    columns: () => columns,
    write: (text) => chunks.push(text),
  });
  return { activity, chunks, output: () => chunks.join("") };
}

function start(toolName: string, args: unknown = {}, toolCallId = "tool-1"): AgentSessionEvent {
  return { type: "tool_execution_start", toolName, args, toolCallId };
}
function end(
  toolName: string,
  result: unknown = {},
  isError = false,
  toolCallId = "tool-1",
): AgentSessionEvent {
  return { type: "tool_execution_end", toolName, result, isError, toolCallId };
}
function text(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  } as AgentSessionEvent;
}

/** The error text one failed assistant turn renders with a typed provider error. */
function failedTurn(providerError: ProviderErrorTelemetryV1, errorMessage: string): string {
  const errors: string[] = [];
  const activity = new LiveAgentActivityRenderer({
    ...options,
    tty: false,
    write: () => {},
    writeError: (text) => errors.push(text),
    providerFailure: () => providerError,
  });
  activity.begin();
  activity.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage },
  } as AgentSessionEvent);
  activity.dispose();
  return errors.join("");
}

afterEach(() => vi.useRealTimers());

describe("live-agent observed activity", () => {
  it.each([
    DOCUMENTATION_WORK_REFUSAL,
    DOCUMENTATION_WORK_PREREQUISITE_ACTION,
    `DocumentationWorkPrerequisiteError: ${DOCUMENTATION_WORK_REFUSAL}`,
    JSON.stringify({
      name: "DocumentationWorkPrerequisiteError",
      code: "documentation-work-prerequisite",
      message: DOCUMENTATION_WORK_REFUSAL,
    }),
  ])("does not trust prerequisite-looking tool text: %s", (message) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("read"));
    activity.handle(
      end(
        "read",
        {
          content: [{ type: "text", text: message }],
          details: {
            kind: "docsfab-documentation-work-prerequisite",
            toolCallId: "tool-1",
            toolName: "read",
          },
        },
        true,
      ),
    );
    activity.dispose();
    expect(output()).toContain("[Failed]");
    expect(output()).toContain("unclassified");
    expect(output()).not.toContain("[Blocked]");
    expect(output()).not.toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
  });

  it("consumes only current matching host facts and clears stale identities and lifecycle state", () => {
    const facts = new Map<string, string>();
    const chunks: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      ...options,
      tty: false,
      write: (line) => chunks.push(line),
      documentationWorkPrerequisite: {
        consume: (id, name) => {
          const observed = facts.get(id);
          facts.delete(id);
          return observed !== undefined && observed === name;
        },
        clear: () => facts.clear(),
      },
    });
    const failed = (name = "read", id = "tool-1") =>
      end(name, { content: [{ type: "text", text: DOCUMENTATION_WORK_REFUSAL }] }, true, id);
    activity.begin();
    activity.handle(start("read"));
    facts.set("tool-1", "read");
    activity.handle(failed());
    expect(chunks.join("")).toContain("[Blocked]");
    expect(facts.size).toBe(0);
    for (const [startedName, endedName, endedId] of [
      ["read", "read", "unknown-id"],
      ["read", "grep", "tool-1"],
      ["grep", "read", "tool-1"],
    ]) {
      chunks.length = 0;
      activity.handle(start(startedName!));
      facts.set("tool-1", "read");
      activity.handle(failed(endedName, endedId));
      expect(chunks.join("")).not.toContain("[Blocked]");
      facts.clear();
    }
    // A fact with no current start is consumed, and an ID reused by any tool clears it.
    activity.dispose();
    activity.begin();
    facts.set("orphan", "read");
    activity.handle(failed("read", "orphan"));
    expect(facts.size).toBe(0);
    facts.set("tool-1", "read");
    chunks.length = 0;
    activity.handle(start("read"));
    activity.handle(failed());
    expect(chunks.join("")).not.toContain("[Blocked]");
    activity.dispose();
    activity.begin();
    chunks.length = 0;
    activity.handle(start("read"));
    activity.handle(start("read"));
    facts.set("tool-1", "read");
    activity.handle(failed());
    activity.handle(failed());
    expect(chunks.join("")).not.toContain("[Blocked]");
    expect(facts.size).toBe(0);
    for (const stop of [
      () => activity.dispose(),
      () => activity.interrupt(),
      () => activity.requestInterrupt(),
      () => activity.fail(new Error("unknown genuine failure")),
    ]) {
      activity.begin();
      facts.set("tool-1", "read");
      stop();
      expect(facts.size).toBe(0);
    }
    activity.dispose();
  });

  it.each([
    ["missing name", "tool-1", undefined],
    ["empty name", "tool-1", ""],
    ["non-string name", "tool-1", { toString: null }],
    ["missing call ID", undefined, "read"],
    ["empty call ID", "", "read"],
    ["non-string call ID", null, "read"],
  ] as const)(
    "keeps malformed %s safely failed despite a prerequisite callback",
    (_label, toolCallId, toolName) => {
      const chunks: string[] = [];
      const activity = new LiveAgentActivityRenderer({
        ...options,
        tty: false,
        write: (line) => chunks.push(line),
        documentationWorkPrerequisite: { consume: () => true, clear: () => undefined },
      });
      activity.begin();
      try {
        activity.handle({
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args: {},
        } as unknown as AgentSessionEvent);
        activity.handle({
          type: "tool_execution_end",
          toolCallId,
          toolName,
          isError: true,
          result: { content: [{ type: "text", text: "private-sdk-error" }] },
        } as unknown as AgentSessionEvent);
        expect(chunks.join("")).toContain("[Failed]");
        expect(chunks.join("")).toContain("unclassified");
        expect(chunks.join("")).not.toContain("[Blocked]");
        expect(chunks.join("")).not.toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
        expect(chunks.join("")).not.toContain("private-sdk-error");
        chunks.length = 0;
        activity.handle(start("read", {}, "valid-recovery"));
        activity.handle(end("read", {}, true, "valid-recovery"));
        expect(chunks.join("")).toContain("[Blocked]");
        expect(chunks.join("")).toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
      } finally {
        activity.dispose();
      }
    },
  );

  it("prints admitted docs-stale evidence warnings on a successful workflow", () => {
    const { activity, output } = renderer();
    const warning =
      "docs-stale: discrepancy 1, detail 1: documentation differs from implementation; verification needed.";
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: { status: "succeeded", evidenceWarnings: [warning] },
      }),
    );
    expect(output()).toContain(warning);
  });

  it("shows a bounded first-pass authority failure before a workflow has a run", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end(
        "docsfab_run_workflow",
        {
          content: [
            {
              type: "text",
              text: "First-pass support stopped in decomposition at $response.additionalObligations[1].condition under rule authority-expansion.",
            },
          ],
        },
        true,
      ),
    );
    expect(output()).toContain(
      "authority-expansion in decomposition at $response.additionalObligations[1].condition",
    );
    expect(output()).toContain("widen permission or publication authority");
    expect(output()).toContain("No workflow steps ran");
    expect(output()).toContain("NEXT: You or DocsFab maintainers can act");
    expect(output()).not.toContain("No safe failure detail");
    expect(output()).not.toContain("Inspect the private session or run log");
  });

  it.each([
    "First-pass support stopped in decomposition at $response.additionalObligations[1].condition under rule authority-expansion. private-suffix",
    "First-pass support stopped in decomposition at /private/session condition under rule authority-expansion.",
  ])("does not expose decorated first-pass authority errors: %s", (message) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", { content: [{ type: "text", text: message }] }, true),
    );
    expect(output()).toContain("No safe failure detail");
    expect(output()).toContain("stopped before DocsFab created a run record");
    expect(output()).not.toContain("Inspect the private session or run log");
    expect(output()).not.toContain("private-suffix");
    expect(output()).not.toContain("/private/session");
  });

  it.each([
    [
      "Source-obligation response rejected: duplicate-key.",
      "Source-obligation response rejected: duplicate-key.",
    ],
    [
      "An applicable source-obligation dimension requires atomic obligations.",
      "An applicable source-obligation dimension requires atomic obligations.",
    ],
    [
      "Source-obligation evidence contains invalid bounded text.",
      "Source-obligation evidence contains invalid bounded text.",
    ],
    [
      "Reader task admission observation rejected input: credential-material.",
      "DocsFab withheld the reader-evidence handoff",
    ],
    [
      "Editorial evidence host rejected input: invalid-value.",
      "Workflow evidence failed validation",
    ],
    [
      "Editorial assessment response rejected: invalid-value.",
      "editorial assessment did not satisfy",
    ],
    [
      "The independent editorial step returned a malformed assessment envelope.",
      "editorial assessment did not satisfy",
    ],
    [
      "Review response did not satisfy the host-owned structured contract.",
      "editorial assessment did not satisfy",
    ],
    ["DocsFab denied the requested tool path.", "outside this tool's allowed repository paths"],
    ["DocsFab tool target is unavailable.", "repository file or directory is unavailable"],
  ])(
    "explains an editorial or repository-path failure without exposing private detail: %s",
    (diagnostic, explanation) => {
      for (const suffix of ["", " PRIVATE"]) {
        const { activity, output } = renderer();
        activity.begin();
        activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
        activity.handle(
          end(
            "docsfab_run_workflow",
            { content: [{ type: "text", text: diagnostic + suffix }] },
            true,
          ),
        );
        activity.finish();
        if (suffix) expect(output()).toContain("No safe failure detail");
        else expect(output()).toContain(explanation);
        expect(output()).not.toContain("PRIVATE");
      }
    },
  );

  it.each([
    ...Object.values(LIVE_SKILL_FAILURES),
    "First-pass support stopped in decomposition at $response under rule response-size.",
  ])("shows a safe skill or first-pass diagnostic: %s", (diagnostic) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", { content: [{ type: "text", text: diagnostic }] }, true),
    );
    activity.finish();
    expect(output()).not.toContain("No safe failure detail");
    expect(output()).toContain(
      diagnostic.startsWith("First-pass")
        ? "response-size in decomposition at $response. No workflow steps ran"
        : diagnostic,
    );
  });

  it("withholds private suffixes on a first-pass diagnostic", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end(
        "docsfab_run_workflow",
        {
          content: [
            {
              type: "text",
              text: "First-pass support stopped in decomposition at $response under rule response-size. PRIVATE",
            },
          ],
        },
        true,
      ),
    );
    activity.finish();
    expect(output()).toContain("No safe failure detail");
    expect(output()).not.toContain("PRIVATE");
  });
  it.each(Object.entries(LOCAL_REVIEW_SCOPE_FAILURES))(
    "shows the safe review scope diagnostic for %s",
    (_code, diagnostic) => {
      const { activity, output } = renderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
      activity.handle(
        end("docsfab_run_workflow", { content: [{ type: "text", text: diagnostic }] }, true),
      );
      activity.finish();
      expect(output()).toContain(diagnostic);
      expect(output()).not.toContain("No safe failure detail");
    },
  );

  it.each(Object.entries(LOCAL_REVIEW_SCOPE_FAILURES))(
    "rejects private suffixes on review scope diagnostic %s",
    (_code, diagnostic) => {
      const { activity, output } = renderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
      activity.handle(
        end(
          "docsfab_run_workflow",
          { content: [{ type: "text", text: `${diagnostic} PRIVATE target content` }] },
          true,
        ),
      );
      activity.finish();
      expect(output()).not.toContain("PRIVATE");
      expect(output()).toContain("No safe failure detail");
    },
  );

  it.each(Object.entries(QUALITY_ARTIFACT_FAILURES))(
    "shows a safe quality failure diagnostic for %s",
    (code, diagnostic) => {
      const { activity, output } = renderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
      activity.handle(
        end("docsfab_run_workflow", {
          details: { status: "failed", error: `Quality artifact validation failed: ${code}.` },
        }),
      );
      activity.finish();
      expect(output()).toContain(diagnostic);
      expect(output()).not.toContain("No safe failure detail");
    },
  );

  it("does not display private text appended to a quality failure code", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          status: "failed",
          error:
            "Quality artifact validation failed: target-scope-mismatch. PRIVATE candidate payload",
        },
      }),
    );
    activity.finish();
    expect(output()).not.toContain("PRIVATE");
    expect(output()).toContain("No safe failure detail");
  });

  it("retains MR and page identity when parallel GitLab reads settle out of order", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_read_gitlab", { operation: "diffs", iid: 381 }, "first"));
    activity.handle(
      start("docsfab_read_gitlab", { operation: "diffs", iid: 383, page: 2 }, "second"),
    );
    activity.handle(
      end(
        "docsfab_read_gitlab",
        { content: [{ type: "text", text: GITLAB_READ_FAILURES.credentials }] },
        true,
        "second",
      ),
    );
    activity.handle(end("docsfab_read_gitlab", {}, false, "first"));
    activity.handle(start("docsfab_read_gitlab", { operation: "get", iid: 383 }));
    activity.handle(end("docsfab_read_gitlab"));
    activity.finish();
    expect(output()).toContain(
      `[Failed] Reading GitLab MR !383 diffs (page 2) (0s)\n${GITLAB_READ_FAILURES.credentials}`,
    );
    expect(output()).toContain("[Done] Reading GitLab MR !381 diffs (page 1)");
    expect(output()).toContain("[Done] Reading GitLab MR !383 details");
    expect(output()).not.toContain("[Failed] Reading GitLab MR !381");
  });

  it.each([
    [{ operation: "list_merged" }, "Listing merged GitLab MRs (page 1)"],
    [{ operation: "list_merged", page: 2 }, "Listing merged GitLab MRs (page 2)"],
    [{ operation: "get", iid: "381 PRIVATE" }, "Reading GitLab evidence (invalid request)"],
    [
      { operation: "diffs", iid: 381, page: "2 PRIVATE" },
      "Reading GitLab evidence (invalid request)",
    ],
    [
      { operation: "get", iid: Number.MAX_SAFE_INTEGER + 1 },
      "Reading GitLab evidence (invalid request)",
    ],
    [{ operation: "PRIVATE", iid: 381 }, "Reading GitLab evidence (invalid request)"],
  ])("labels GitLab requests without printing arbitrary arguments: %j", (args, label) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_read_gitlab", args));
    activity.handle(end("docsfab_read_gitlab", { content: [{ type: "text", text: "PRIVATE" }] }));
    activity.finish();
    expect(output()).toContain(`[Done] ${label}`);
    expect(output()).not.toContain("PRIVATE");
  });

  it("distinguishes edits, failed commands, and declined commands without printing raw tool data", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("edit", { path: "PRIVATE" }));
    activity.handle(end("edit"));
    activity.handle(start("bash", { command: "PRIVATE" }));
    activity.handle(
      end("bash", {
        details: { status: "failed", exitCode: 7 },
        content: [{ type: "text", text: "PRIVATE" }],
      }),
    );
    activity.handle(start("bash"));
    activity.handle(end("bash", { details: { status: "cancelled" } }));
    activity.finish();
    expect(output()).toContain("[Done] Editing repository files");
    expect(output()).toContain("[Failed] Running approved host command");
    expect(output()).toContain("Host command exited with code 7");
    expect(output()).toContain("[Cancelled] Running approved host command");
    expect(output()).not.toContain("PRIVATE");
    expect(output()).not.toContain("No safe failure detail");
  });
  it.each(["tool-call-limit", "provider-turn-limit"])(
    "shows a nested host budget failure: %s",
    (reason) => {
      const { activity, output } = renderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
      activity.handle(
        end("docsfab_run_workflow", {
          details: {
            status: "failed",
            steps: [
              {
                status: "failed",
                error: `Model request failed [unknown; retryable=false]: Error: context-exhausted: Provider turn stopped locally: reason=${reason} turn=13 provider-turn-limit=64 tool-calls=64 tool-call-limit=61 PRIVATE`,
              },
            ],
          },
        }),
      );
      activity.finish();
      expect(output()).toContain(
        reason === "tool-call-limit" ? "tool-call limit (61)" : "model-turn limit (64)",
      );
      expect(output()).not.toContain("PRIVATE");
      expect(output()).not.toContain("No safe failure detail");
    },
  );

  it.each([
    ["tool-call", "tool-call limit (126)"],
    ["provider-turn", "model-turn limit (126)"],
  ])("shows a step that completed at its coded %s ceiling", (ceiling, shown) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          status: "failed",
          steps: [
            {
              status: "failed",
              error: `composition-execution-max-tool-calls-per-step-bound: workflow step "audit-documentation" used all of its ${ceiling} ceiling of 126 calls (observed 126 calls). Scope: one attempt of this step. PRIVATE`,
            },
          ],
        },
      }),
    );
    activity.finish();
    expect(output()).toContain(shown);
    expect(output()).not.toContain("PRIVATE");
    expect(output()).not.toContain("No safe failure detail");
  });

  it("pauses activity for confirmation, resumes progress, and prints a safe publication reason", () => {
    vi.useFakeTimers();
    const { activity, chunks, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_publish_workflow"));
    activity.pauseForInput();
    const paused = chunks.length;
    vi.advanceTimersByTime(2000);
    expect(chunks).toHaveLength(paused);
    activity.resumeAfterInput();
    vi.advanceTimersByTime(1000);
    expect(output()).toContain("Creating draft merge request (3s)");
    const error = new LocalUserPublicationPreflightError("gitlab-unauthenticated");
    activity.handle(
      end("docsfab_publish_workflow", { content: [{ type: "text", text: error.message }] }, true),
    );
    activity.finish();
    expect(output()).toContain(`[Failed] Creating draft merge request (3s)\n${error.message}`);
  });

  it("shows immediate elapsed liveness before a delayed direct answer and stops before streaming", () => {
    vi.useFakeTimers();
    const { activity, output, chunks } = renderer();
    activity.begin();
    expect(output()).toContain("[Working] Contacting model (0s)");
    vi.advanceTimersByTime(2100);
    expect(output()).toContain("Contacting model (2s)");
    activity.handle(text("Direct "));
    vi.advanceTimersByTime(2000);
    activity.handle(text("answer."));
    activity.finish();
    expect(output()).toContain("DocsFab: Direct answer.\n");
    expect(output()).not.toMatch(/skill|workflow|quality|Reading/);
    const count = chunks.length;
    vi.advanceTimersByTime(4000);
    expect(chunks).toHaveLength(count);
  });

  it("preserves real skill, quality, evidence, and workflow milestones without private payloads", () => {
    const { activity, output } = renderer();
    activity.begin();
    for (const [tool, args, result] of [
      ["docsfab_use_skill", { skill: "review-documentation", prompt: "PRIVATE" }, {}],
      ["read", { path: ".docsfab-governed-assets/quality/profile.md" }, { content: "PRIVATE" }],
      ["grep", { path: "/PRIVATE", pattern: "PRIVATE" }, {}],
      [
        "docsfab_run_workflow",
        { workflow: "review-documentation", instruction: "PRIVATE" },
        { details: { status: "succeeded", secret: "PRIVATE" } },
      ],
    ] as const) {
      activity.handle(start(tool, args));
      activity.handle(end(tool, result));
    }
    activity.handle(text("Finished."));
    activity.finish();
    expect(output()).toContain("[Done] Loading skill: review-documentation");
    expect(output()).toContain("[Done] Consulting quality guidance");
    expect(output()).toContain("[Done] Reading repository evidence");
    expect(output()).toContain("[Done] Running workflow: review-documentation");
    expect(output()).not.toContain("PRIVATE");
    expect(output()).not.toMatch(/writing|commit|push|workflow step/i);
  });

  it("uses generic labels for unknown names and paths without granting them a capability", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_use_skill", { skill: "PRIVATE\u001b[2J" }));
    activity.handle(end("docsfab_use_skill", { error: "PRIVATE" }, true));
    activity.handle(start("PRIVATE", { token: "PRIVATE" }));
    activity.handle(end("PRIVATE", {}));
    activity.handle(start("read", { path: ".docsfab-governed-assets/quality/../../PRIVATE" }));
    activity.interrupt();
    expect(output()).toContain("[Failed] Loading skill");
    expect(output()).toContain("Running tool");
    expect(output()).not.toContain("PRIVATE");
    expect(output()).not.toContain("Consulting quality");
  });

  it.each(["failed", "needs-input", "needs-human-decision", undefined, "unknown"])(
    "does not mark workflow status %s as success when tool execution itself succeeded",
    (status) => {
      const { activity, output } = renderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
      activity.handle(end("docsfab_run_workflow", { details: { status, error: "PRIVATE" } }));
      activity.handle(text("Review the outcome."));
      activity.finish();
      expect(output()).not.toContain("[Done] Running workflow");
      expect(output()).toMatch(/\[(Failed|Needs input)\] Running workflow/);
      expect(output()).not.toContain("PRIVATE");
    },
  );

  it.each(["", " PRIVATE"])(
    "explains only the exact safe GitLab setup remote diagnostic%s",
    (suffix) => {
      const { activity, output } = renderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
      activity.handle(
        end(
          "docsfab_run_workflow",
          {
            content: [
              {
                type: "text",
                text: `No supported uncredentialed GitLab remote is available for this operation.${suffix}`,
              },
            ],
          },
          true,
        ),
      );
      activity.interrupt();
      expect(output().includes("the workflow did not start")).toBe(suffix === "");
      expect(output()).not.toContain("Add one and retry");
      if (suffix === "") expect(output()).toContain("Do not add a fabricated remote");
      expect(output()).not.toContain("PRIVATE");
    },
  );

  it("retains outstanding parallel tools until their own completion events", () => {
    vi.useFakeTimers();
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("read", {}, "a"));
    activity.handle(start("docsfab_use_skill", { skill: "review-documentation" }, "b"));
    activity.handle(end("read", {}, false, "a"));
    vi.advanceTimersByTime(2000);
    expect(output()).toContain("Loading skill: review-documentation (2s)");
    activity.handle(end("docsfab_use_skill", {}, false, "b"));
    activity.interrupt();
  });

  it.each([
    [
      'Workflow "review-documentation" can modify files. Re-run with --allow-write after reviewing the plan.',
      "Workflow writes are not enabled.",
    ],
    [
      "The GitLab default branch could not be discovered. Authenticate glab or set the remote HEAD.",
      "The GitLab default branch could not be discovered.",
    ],
    ["401 PRIVATE api_key=synthetic-secret-value", "Authentication failed (HTTP 401)."],
    ["HTTP 403 PRIVATE", "Access was denied (HTTP 403)."],
    ["HTTP 429 PRIVATE", "The service rate limit was reached."],
    ["Request timed out PRIVATE", "The request timed out."],
    ["HTTP 503 PRIVATE", "The service is unavailable or the connection failed."],
    ["invalid response PRIVATE", "The service returned an invalid response"],
    [
      "Model request failed [invalid-request; retryable=false]: 401 PRIVATE",
      "Authentication failed (HTTP 401).",
    ],
    [
      "Model request failed [malformed-response; retryable=true]: PRIVATE",
      "The service returned an invalid response",
    ],
  ])("prints a safe reason immediately below a failed workflow: %s", (error, reason) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", { content: [{ type: "text", text: error }] }, true),
    );
    activity.interrupt();
    expect(output()).toContain(`[Failed] Running workflow: review-documentation (0s)\n${reason}`);
    expect(output()).not.toContain("PRIVATE");
    expect(output()).not.toContain("synthetic-secret-value");
  });

  it.each([true, false])(
    "reports a failed run or step even when the tool itself succeeds: %s",
    (runError) => {
      const { activity, output } = renderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
      activity.handle(
        end("docsfab_run_workflow", {
          details: {
            status: "failed",
            ...(runError
              ? { error: "HTTP 429 PRIVATE" }
              : { steps: [null, { status: "failed", error: "HTTP 429 PRIVATE" }] }),
          },
        }),
      );
      activity.interrupt();
      expect(output()).toContain("(0s)\nThe service rate limit was reached.");
      expect(output()).not.toContain("PRIVATE");
    },
  );

  it.each([
    [
      "Model request failed [provider-terminal; retryable=false]: unclassified provider failure",
      "The default health-check timeout is 60 seconds.",
      "No safe failure detail is available. Run run-2578 was saved",
    ],
    [
      "Model request failed [no-progress; retryable=false]: tool calls made no progress",
      "The network connection setting is documented in the report.",
      "The model kept calling tools without answering",
    ],
    [
      "Model request failed [invalid-request; retryable=false]: rejected request",
      "HTTP 401 authentication is one example in the report.",
      "The service rejected the request.",
    ],
  ])("does not classify saved step summary prose as an error: %s", (error, summary, expected) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "run-2578",
          status: "failed",
          error,
          steps: [{ id: "review", status: "failed", error, summary }],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain(expected);
    expect(output()).not.toContain("The request timed out");
    expect(output()).not.toContain("Authentication failed");
    expect(output()).not.toContain("connection failed");
  });

  it("keeps a typed timeout when the saved step summary describes another failure", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "run-2578",
          status: "failed",
          steps: [
            {
              id: "review",
              status: "failed",
              error: "Model request failed [timeout; retryable=true]: private provider body",
              summary: "The report discusses HTTP 401 authentication.",
            },
          ],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain(
      "The request timed out. Check service availability before retrying.",
    );
    expect(output()).not.toContain("Authentication failed");
    expect(output()).not.toContain("private provider body");
  });

  it("keeps an unrecognized structured step failure uncertain despite timeout prose", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "run-2578",
          status: "failed",
          steps: [
            {
              id: "review",
              status: "failed",
              error: { code: "uncatalogued-review-failure" },
              summary: "The default health-check timed out after 60 seconds.",
            },
          ],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain("No safe failure detail is available. Run run-2578 was saved");
    expect(output()).toContain("docsfab runs show run-2578");
    expect(output()).not.toContain("The request timed out");
  });

  it("keeps a recorded host continuation stop beside its typed failure", () => {
    const { activity, output } = renderer();
    const hostStop =
      "The saved first-pass choice cannot continue this run (stale). Start a new run with the current repository evidence.";
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "run-2578",
          status: "failed",
          failure: { class: "unknown", layer: "workflow", code: "stale" },
          error: hostStop,
          steps: [{ id: "author", status: "failed", summary: "A timeout is documented." }],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain("Failure class: unknown (layer workflow, code stale)");
    expect(output()).toContain(hostStop);
    expect(output()).not.toContain("The request timed out");
  });

  it("does not promote an exact host-stop sentence from saved summary prose", () => {
    const { activity, output } = renderer();
    const hostStop =
      "The saved first-pass choice cannot continue this run (stale). Start a new run with the current repository evidence.";
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "run-2578",
          status: "failed",
          failure: { class: "unknown", layer: "workflow", code: "stale" },
          error: "Uncatalogued failure",
          steps: [{ id: "author", status: "failed", summary: hostStop }],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain("Failure class: unknown (layer workflow, code stale)");
    expect(output()).not.toContain(hostStop);
  });

  it.each([
    [
      { class: "bound", layer: "inference", code: "fact-inventory-limitations-exceeded" },
      "The default health-check timed out after 60 seconds.",
      "fact-inventory-limitations-exceeded",
    ],
    [
      { class: "infrastructure", layer: "inference", code: "provider-timeout" },
      "The report discusses HTTP 401 authentication.",
      "provider-timeout",
    ],
    [
      { class: "unknown", layer: "workflow", code: "uncatalogued-review-failure" },
      "The network connection setting is documented in the report.",
      "uncatalogued-review-failure",
    ],
  ] as const)("renders a typed %s before saved summary prose", (failure, summary, code) => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "run-2578",
          status: "failed",
          failure,
          steps: [
            {
              id: "review",
              status: "failed",
              error: "An unrelated saved error without a safe presentation.",
              summary,
            },
          ],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain(`code ${code}`);
    expect(output()).toContain("docsfab runs show run-2578");
    expect(output()).not.toContain("The request timed out");
    expect(output()).not.toContain("Authentication failed");
    expect(output()).not.toContain("connection failed");
  });

  it("prefers the typed run failure over a conflicting typed step and summary", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "run-2578",
          status: "failed",
          failure: {
            class: "bound",
            layer: "inference",
            code: "fact-inventory-limitations-exceeded",
          },
          steps: [
            {
              id: "review",
              status: "failed",
              failure: { class: "infrastructure", layer: "inference", code: "provider-timeout" },
              summary: "HTTP 401 authentication is one example in the report.",
            },
          ],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain("code fact-inventory-limitations-exceeded");
    expect(output()).not.toContain("code provider-timeout");
  });

  it("shows the planner's specific diagnostic from a needs-input step summary", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          status: "needs-input",
          steps: [
            {
              status: "needs-input",
              summary: "Planner planBinding has missing, unexpected, or incorrectly typed fields.",
            },
          ],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain(
      "(0s)\nPlanner planBinding has missing, unexpected, or incorrectly typed fields.",
    );
  });

  it("puts a provider failure reason below its milestone without private response data", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.fail(new Error("401 PRIVATE \u001b[2J Authorization: Bearer synthetic-secret-value"));
    expect(output()).toContain("[Failed] Contacting model.\nAuthentication failed (HTTP 401).");
    expect(output()).not.toMatch(/PRIVATE|synthetic-secret-value|\u001b\[2J/u);
  });

  it("fits in-place activity to narrow terminals and uses no color escapes with NO_COLOR", () => {
    const { activity, chunks, output } = renderer(24);
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    for (const chunk of chunks) {
      expect(chunk.replace(/\r|\u001b\[2K/g, "").length).toBeLessThan(24);
    }
    activity.interrupt();
    expect(output()).not.toMatch(/\u001b\[[\d;]*m/);
  });

  it("handles provider event errors, context exhaustion, blank replies, and interruption without leaking details", () => {
    vi.useFakeTimers();
    const { activity, output, chunks } = renderer();
    activity.begin();
    activity.handle({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "PRIVATE maximum context length exceeded",
      },
    } as AgentSessionEvent);
    activity.finish();
    expect(output()).toContain("Context budget exceeded");
    activity.begin();
    activity.finish();
    expect(output()).toContain("Model returned no answer");
    activity.begin();
    activity.handle(text("Partial"));
    activity.interrupt();
    expect(output()).toContain("Partial\n[Interrupted]");
    activity.begin();
    activity.fail(new Error("PRIVATE credential and provider payload"));
    activity.dispose();
    expect(output()).toContain("docsfab setup");
    expect(output()).not.toContain("PRIVATE");
    const count = chunks.length;
    vi.advanceTimersByTime(3000);
    expect(chunks).toHaveLength(count);
  });

  it("uses append-only elapsed output on a dumb terminal", () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      ...options,
      environment: { TERM: "dumb" },
      tty: true,
      write: (value) => chunks.push(value),
    });
    activity.begin();
    vi.advanceTimersByTime(1000);
    activity.interrupt();
    expect(chunks.join("")).toContain("Contacting model (1s)\n");
    expect(chunks.join("")).not.toMatch(/\u001b|\r/);
  });
});

describe("live-agent terminal lifecycle", () => {
  it("prints copyable quoted instructions through the terminal conversation", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    let listener: (event: AgentSessionEvent) => void = () => {};
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
        prompt: async () => {
          listener(text("> Check DocsFab development changes merged on October 7, 2026 "));
          listener(text("(UTC−07:00), and update the current documentation to reflect them. "));
          listener(text("Do not commit, push, or open an MR.\n"));
        },
        abort: async () => {},
      },
      input,
      output,
      { ...options, environment: {} },
    );
    input.write("Show the complete request\n");
    await vi.waitFor(() => expect(stripVTControlCharacters(transcript)).toContain("open an MR."));
    input.write("/exit\n");
    await conversation;
    const rendered = stripVTControlCharacters(transcript);
    expect(rendered).toContain("DOCSFAB");
    expect(rendered).toContain("Check DocsFab development changes");
    expect(rendered).not.toContain("│");
    expect(rendered).not.toContain("> Check");
  });

  it.each(["y", "yes", "n", "", "v", "unexpected", "interrupt", "eof"])(
    "shows the entire command once before approve or cancel: %s",
    async (answer) => {
      const input = new PassThrough();
      const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
      let transcript = "";
      output.on("data", (chunk) => {
        transcript += chunk.toString();
      });
      let confirm: (request: LiveConfirmation) => Promise<boolean> = async () => false;
      let approved: boolean | undefined;
      const conversation = runTerminalConversation(
        {
          sessionFile: undefined,
          subscribe: () => () => {},
          prompt: async () => {
            approved = await confirm({
              kind: "command",
              repositoryPath: "/sample",
              command: `${"echo visible\n".repeat(15)}echo final-command`,
            });
          },
          abort: async () => {},
        },
        input,
        output,
        {
          ...options,
          setPublicationConfirmation: (callback) => {
            confirm = callback;
          },
        },
      );
      input.write("Run command\n");
      await vi.waitFor(() => expect(transcript).toContain(COMMAND_APPROVAL_PROMPT));
      expect(transcript).not.toContain("hidden");
      expect(transcript).toContain("│ echo final-command");
      expect(transcript.indexOf("│ echo final-command")).toBeLessThan(
        transcript.indexOf(COMMAND_APPROVAL_PROMPT),
      );
      expect(approved).toBeUndefined();
      expect(COMMAND_APPROVAL_PROMPT).toBe("[y] Approve  [n] Cancel (default: cancel): ");
      expect(transcript).not.toContain("can publish using your local account");
      if (answer === "eof") input.end();
      else input.write(answer === "interrupt" ? "\u0003" : `${answer}\n`);
      await vi.waitFor(() => expect(approved).toBe(answer === "y" || answer === "yes"));
      expect(transcript.split(COMMAND_APPROVAL_PROMPT)).toHaveLength(2);
      expect(transcript.split("│ echo final-command")).toHaveLength(2);
      if (answer !== "eof") input.write("/exit\n");
      await conversation;
    },
  );

  it.each(["yes", "no", "", "interrupt", "eof"])(
    "requires terminal confirmation for publication: %s",
    async (answer) => {
      const input = new PassThrough();
      const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
      let transcript = "";
      output.on("data", (chunk) => {
        transcript += chunk.toString();
      });
      let confirm: (message: string) => Promise<boolean> = async () => false;
      let listener: (event: AgentSessionEvent) => void = () => {};
      let approved: boolean | undefined;
      const conversation = runTerminalConversation(
        {
          sessionFile: undefined,
          subscribe: (fn) => {
            listener = fn;
            return () => {};
          },
          prompt: async () => {
            listener(start("docsfab_publish_workflow"));
            approved = await confirm("Create draft MR? [y/N] ");
            listener(
              end("docsfab_publish_workflow", {
                details: { status: approved ? "succeeded" : "cancelled" },
              }),
            );
            listener(text("Request handled."));
          },
          abort: vi.fn(async () => {}),
        },
        input,
        output,
        {
          ...options,
          setPublicationConfirmation: (fn) => {
            confirm = fn;
          },
        },
      );
      input.write("Create MR\n");
      await vi.waitFor(() => expect(transcript).toContain("Create draft MR? [y/N]"));
      if (answer === "eof") input.end();
      else input.write(answer === "interrupt" ? "\u0003" : `${answer}\n`);
      await vi.waitFor(() => expect(approved).toBe(answer === "yes"));
      if (answer !== "eof") {
        await vi.waitFor(() =>
          expect(transcript).toContain(
            answer === "interrupt" ? "Current turn stopped" : "Request handled.",
          ),
        );
        input.write("/exit\n");
      }
      await conversation;
      if (["no", ""].includes(answer)) {
        expect(transcript).toContain("[Cancelled] Creating draft merge request");
        expect(transcript).not.toContain("[Done] Creating draft merge request");
      }
    },
  );

  it("cancels queued command confirmations when the user interrupts the turn", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    let confirm: (message: string) => Promise<boolean> = async () => false;
    let answers: boolean[] = [];
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        prompt: async () => {
          answers = await Promise.all([confirm("First command? "), confirm("Second command? ")]);
        },
        abort: async () => {},
      },
      input,
      output,
      {
        ...options,
        setPublicationConfirmation: (callback) => {
          confirm = callback;
        },
      },
    );
    input.write("Work\n");
    await vi.waitFor(() => expect(transcript).toContain("First command?"));
    expect(transcript).not.toContain("Second command?");
    input.write("\u0003");
    await vi.waitFor(() => expect(answers).toEqual([false, false]));
    expect(transcript).not.toContain("Second command?");
    input.write("/exit\n");
    await conversation;
  });

  it("keeps cancellation pending until active workflow work and abort settle", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    let listener: (event: AgentSessionEvent) => void = () => {};
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const abort = vi.fn(() => pending);
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
        prompt: async () => {
          listener(start("docsfab_run_workflow", { workflow: "review-documentation" }));
          await pending;
          listener(text("Late text"));
        },
        abort,
      },
      input,
      output,
      options,
    );
    input.write("Work\n");
    await vi.waitFor(() => expect(transcript).toContain("Running workflow"));
    input.write("\u0003");
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(transcript).toContain("Cancellation requested; waiting for active work");
    expect(transcript).not.toContain("Current turn stopped");
    input.write("Summarize documentation while waiting\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transcript).not.toContain("Summarize documentation while waiting");
    settle();
    await vi.waitFor(() => expect(transcript).toContain("Current turn stopped"));
    expect(transcript).not.toContain("Late text");
    input.write("/exit\n");
    await conversation;
  });

  it("closes activity before writing safe errors to the injected error stream", () => {
    const writes: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      ...options,
      tty: true,
      write: (value) => writes.push(`output:${value}`),
      writeError: (value) => writes.push(`error:${value}`),
    });
    activity.begin();
    activity.fail({ code: "context-exhausted", secret: "PRIVATE" });
    expect(writes.at(-2)).toBe("output:\r\u001b[2K");
    expect(writes.at(-1)).toContain("error:[Failed] Contacting model.\nContext budget exceeded.");
    expect(writes.join("")).not.toContain("PRIVATE");
    activity.dispose();
  });

  it("shows status before prompting the provider, recovers after errors, and unsubscribes on exit", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    let listener: (event: AgentSessionEvent) => void = () => {};
    const unsubscribe = vi.fn();
    const prompt = vi.fn(async () => {
      expect(transcript).toContain("[Working] Contacting model (0s)");
      if (prompt.mock.calls.length === 1) throw new Error("PRIVATE provider failure");
      listener(text("Recovered."));
    });
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: (fn) => {
          listener = fn;
          return unsubscribe;
        },
        prompt,
        abort: vi.fn(),
      },
      input,
      output,
      options,
    );
    input.write("First\n");
    await vi.waitFor(() => expect(transcript).toContain("Model or session request failed"));
    input.write("Second\n");
    await vi.waitFor(() => expect(transcript).toContain("DocsFab: Recovered."));
    input.write("/exit\n");
    await conversation;
    expect(transcript).not.toContain("PRIVATE");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("shows provider retries and names the failing status instead of the generic stop", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    let listener: (event: AgentSessionEvent) => void = () => {};
    let retryListener: ((notice: ProviderRetryNotice) => void) | undefined;
    const unsubscribeRetries = vi.fn();
    const prompt = vi.fn(async () => {
      retryListener?.({
        attempt: 1,
        maxAttempts: 2,
        category: "throttled",
        delayMs: 0,
        httpStatus: 429,
      });
      expect(transcript).toContain(
        "[Working] Retrying model request: HTTP 429, attempt 2 of 2 (0s)",
      );
      listener({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: '429 {"error":{"message":"PRIVATE Budget has been exceeded"}}',
        },
      } as AgentSessionEvent);
    });
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: (fn) => {
          listener = fn;
          return vi.fn();
        },
        prompt,
        abort: vi.fn(),
      },
      input,
      output,
      {
        ...options,
        providerTransport: {
          lastExchange: () => ({ sent: true, httpStatus: 429 }),
          onRetryBackoff: (fn) => {
            retryListener = fn;
            return unsubscribeRetries;
          },
        },
      },
    );
    input.write("hello\n");
    await vi.waitFor(() =>
      expect(transcript).toContain(
        "[Failed] Contacting model.\nThe model provider is rate-limiting this API key, or the key's quota or spend budget is used up (HTTP 429).",
      ),
    );
    input.write("/exit\n");
    await conversation;
    expect(transcript).toContain("DocsFab tried 2 times.");
    expect(transcript).not.toContain("Model or session request failed");
    expect(transcript).not.toContain("PRIVATE");
    expect(unsubscribeRetries).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { class: "auth", httpStatus: 403 },
      "refused the API key or its access to this model (HTTP 403)",
    ],
    [{ class: "rate-limit", httpStatus: 429 }, "spend budget is used up (HTTP 429)"],
    [{ class: "invalid-request", httpStatus: 404 }, "does not serve this API or model (HTTP 404)"],
    [{ class: "auth", httpStatus: 407 }, "A proxy between DocsFab and the model provider"],
    [{ class: "invalid-request", httpStatus: 400 }, "rejected the request (HTTP 400)"],
    [{ class: "server", httpStatus: 503 }, "server error (HTTP 503)"],
    [{ class: "server", streamErrorStatus: 500 }, "server error (HTTP 500)"],
    [{ class: "timeout" }, "did not answer in time."],
    [{ class: "network" }, "could not reach the model endpoint"],
    [{ class: "stream-incomplete" }, "closed before the answer finished"],
    [{ class: "content-filter" }, "content filter stopped this answer"],
  ] as const)("names a %o provider failure", (providerError, expected) => {
    expect(failedTurn(providerError, "PRIVATE body")).toContain(expected);
    expect(failedTurn(providerError, "PRIVATE body")).not.toMatch(/PRIVATE|tried/u);
  });

  it("names a per-minute token 429 as a rate limit, not a context overflow", () => {
    expect(
      failedTurn(
        { class: "rate-limit", httpStatus: 429 },
        "429 Rate limit reached on tokens per min (TPM): Limit 30000, Used 29000",
      ),
    ).toContain("rate-limiting this API key");
  });

  it("counts retries per model call, so a later call in the same turn starts at zero", () => {
    const errors: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      ...options,
      tty: false,
      write: () => {},
      writeError: (text) => errors.push(text),
      providerFailure: () => ({ class: "invalid-request", httpStatus: 400 }),
    });
    activity.begin();
    // The first model call recovered after one retry and asked for a tool.
    activity.retrying({ attempt: 1, maxAttempts: 8, category: "provider-transient", delayMs: 0 });
    activity.handle({
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse" },
    } as AgentSessionEvent);
    activity.handle(start("read", { path: "docs/a.md" }));
    activity.handle(end("read"));
    // The next call fails once, unretried.
    activity.handle({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "400 bad" },
    } as AgentSessionEvent);
    activity.dispose();
    expect(errors.join("")).toContain("rejected the request (HTTP 400)");
    expect(errors.join("")).not.toContain("tried");
  });

  it("labels a retry with no HTTP status in plain words", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.retrying({ attempt: 1, maxAttempts: 8, category: "provider-transient", delayMs: 0 });
    expect(output()).toContain(
      "Retrying model request: connection or server error, attempt 2 of 8",
    );
    activity.retrying({ attempt: 2, maxAttempts: 4, category: "blank-response", delayMs: 0 });
    expect(output()).toContain("Retrying model request: empty answer, attempt 3 of 4");
    activity.dispose();
  });

  it("keeps the generic stop for an unknown class and the context rule over a typed 400", () => {
    expect(failedTurn({ class: "unknown" }, "PRIVATE body")).toContain(
      "Model or session request failed",
    );
    expect(
      failedTurn({ class: "invalid-request", httpStatus: 400 }, "maximum context length exceeded"),
    ).toContain("Context budget exceeded.");
    expect(
      failedTurn({ class: "server", httpStatus: 500 }, "500 maximum context length is 8192 tokens"),
    ).toContain("Context budget exceeded.");
  });
});

/**
 * The typed knowledge stop. Sentences are read from the supplier
 * (`knowledgeResumeNeedsInputMessage`) rather than re-typed, so the terminal
 * cannot drift into paraphrase. `create-documentation` is the fixture workflow:
 * a knowledge stop is reachable only for the two first-pass documentation
 * workflows.
 */
const KNOWLEDGE_STOP_REASONS = [
  "conflict",
  "unresolved-claim",
  "insufficient-evidence",
  "needs-authorization",
  "intent-mismatch",
] as const satisfies readonly KnowledgeResumeStopReason[];

/** One short anchor per reason, so a supplier rewrite is visible here too. */
const KNOWLEDGE_STOP_ANCHORS: Readonly<Record<KnowledgeResumeStopReason, string>> = {
  conflict: "unresolved conflicts",
  "unresolved-claim": "disputed or unresolved claims",
  "insufficient-evidence": "cannot support the requested page",
  "needs-authorization": "Authorize a documentation write root",
  "intent-mismatch": "does not match the original Task",
};

const UNTYPED_FALLBACK = "No safe failure detail is available.";
const STOPPED_RUN_ID = "0199a0b6-11ea-7053-a764-53802ec5276a";

const stopOptions = {
  environment: { NO_COLOR: "1" },
  skillIds: ["review-documentation"],
  workflowIds: ["create-documentation", "review-documentation"],
  qualityPath: ".docsfab-governed-assets/quality",
};

function stopRenderer() {
  const chunks: string[] = [];
  const activity = new LiveAgentActivityRenderer({
    ...stopOptions,
    tty: true,
    columns: () => 100,
    write: (value) => chunks.push(value),
  });
  return { activity, output: () => chunks.join("") };
}

/**
 * A stopped run shaped as `cli/run/knowledge-continuation.ts` saves it, the
 * record `cli/run/local-workflow.ts` persists for a first-pass workflow.
 */
function persistedKnowledgeStopRecord(
  overrides: Record<string, unknown> = {},
): import("../src/records/contracts.js").RunRecord {
  return {
    schemaVersion: 2,
    id: STOPPED_RUN_ID,
    workflow: "create-documentation",
    repository: { sourcePath: "/sample", requestedRevision: "HEAD", revision: "a".repeat(40) },
    workspace: { strategy: "tracked-export", disposable: true },
    knowledgeContinuationReceipt: {
      originalRunId: STOPPED_RUN_ID,
      workflow: "create-documentation",
    },
    status: "needs-input",
    error: "insufficient-evidence",
    steps: [],
    changes: [],
    ...overrides,
  } as unknown as import("../src/records/contracts.js").RunRecord;
}

function knowledgeStopTool(run: () => Promise<unknown>) {
  return createLiveAgentToolDefinitions({
    capabilities: {
      skills: [],
      workflows: [{ name: "create-documentation", title: "Create documentation" }],
      qualityPack: {} as never,
    },
    runWorkflow: run as never,
  }).find((entry) => entry.name === "docsfab_run_workflow")!;
}

async function runKnowledgeStopTool(run: () => Promise<unknown>) {
  return (await knowledgeStopTool(run).execute(
    "tool-1",
    { workflow: "create-documentation", instruction: "Write the usage page." },
    undefined,
    undefined,
    undefined as never,
  )) as { content: { text: string }[]; details: Record<string, unknown> };
}

describe("live-agent typed knowledge-stop recovery", () => {
  it("forwards a saved run and step failure class through the workflow tool", async () => {
    const failure = {
      class: "bound",
      layer: "inference",
      code: "fact-inventory-limitations-exceeded",
    };
    const result = await runKnowledgeStopTool(async () =>
      persistedKnowledgeStopRecord({
        status: "failed",
        error: "The step failed for a recorded reason.",
        failure,
        steps: [
          {
            id: "review",
            status: "failed",
            error: "The step failed for a recorded reason.",
            summary: "The default health-check timed out after 60 seconds.",
            failure,
          },
        ],
      }),
    );
    expect(result.details.failure).toEqual(failure);
    expect(result.details.steps).toMatchObject([{ failure }]);
    const { activity, output } = stopRenderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(end("docsfab_run_workflow", { details: result.details }));
    expect(output()).toContain("code fact-inventory-limitations-exceeded");
    expect(output()).not.toContain("The request timed out");
  });

  it.each(KNOWLEDGE_STOP_REASONS)(
    "renders the %s stop from the supplier's own sentence with no run id invented",
    (reason) => {
      const { activity, output } = stopRenderer();
      activity.begin();
      activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
      activity.handle(
        end(
          "docsfab_run_workflow",
          { content: [{ type: "text", text: LIVE_KNOWLEDGE_STOP_DIAGNOSTICS[reason] }] },
          true,
        ),
      );
      const transcript = output();
      expect(transcript).toContain(`Workflow knowledge stop (${reason}).`);
      expect(transcript).toContain(knowledgeResumeNeedsInputMessage(reason));
      expect(transcript).toContain(KNOWLEDGE_STOP_ANCHORS[reason]);
      expect(transcript).toContain(
        "No run record was saved, so there is no run id or resume command for this stop.",
      );
      // A pre-record stop names no run, no resume command and no run log.
      expect(transcript).not.toContain("--resume-from");
      expect(transcript).not.toContain("docsfab runs show");
      expect(transcript).not.toContain("run log");
      // The untyped fallback is not rendered.
      expect(transcript).not.toContain(UNTYPED_FALLBACK);
    },
  );

  it("drives the persisted stop from the capability adapter into the terminal", async () => {
    const result = await runKnowledgeStopTool(async () => persistedKnowledgeStopRecord());
    expect(result.details.status).toBe("needs-input");
    expect(result.details.knowledgeStop).toEqual({
      reason: "insufficient-evidence",
      resumeRunId: STOPPED_RUN_ID,
    });
    const { activity, output } = stopRenderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(end("docsfab_run_workflow", { details: result.details }));
    const transcript = output();
    expect(transcript).toContain("[Needs input] Running workflow: create-documentation");
    expect(transcript).toContain("Workflow knowledge stop (insufficient-evidence).");
    expect(transcript).toContain(knowledgeResumeNeedsInputMessage("insufficient-evidence"));
    expect(transcript).toContain(`The stopped run ${STOPPED_RUN_ID} retains this stop.`);
    expect(transcript).not.toContain(UNTYPED_FALLBACK);
    expect(transcript).not.toContain("Provide the missing task details before retrying");
  });

  it("renders a resume command the shipped runs parser accepts", () => {
    const rendered = renderLiveAgentKnowledgeStop({
      reason: "insufficient-evidence",
      recorded: true,
      resumeRunId: STOPPED_RUN_ID,
    });
    // Placeholders are shell-quoted, so the line survives a paste instead of
    // becoming a redirection.
    expect(rendered).toContain("'<attributed-snapshot.json>'");
    expect(rendered).toContain("'<accountable-authority-id>'");
    // The command occupies its own line with no sentence punctuation, so an
    // operator can paste it verbatim; only the two placeholders are replaced
    // before parsing.
    const commandLine = rendered.split("\n").at(-1)!;
    expect(commandLine.startsWith("docsfab runs show ")).toBe(true);
    expect(commandLine.endsWith("'<accountable-authority-id>'")).toBe(true);
    const command = commandLine
      .replace("'<attributed-snapshot.json>'", "/tmp/attributed-snapshot.json")
      .replace("'<accountable-authority-id>'", "operator-test-1");
    // Parser round trip, minus the "docsfab runs" prefix it is mounted behind.
    // A trailing period would fuse with the closing quote into the authority id.
    const parsed = parseRunsArguments(command.split(" ").slice(2));
    expect(parsed).toMatchObject({
      command: "show",
      runId: STOPPED_RUN_ID,
      acceptCandidateSnapshot: true,
      authorityId: "operator-test-1",
      canonSnapshotPath: resolve("/tmp/attributed-snapshot.json"),
    });
  });

  it.each([
    [
      { resumeRunId: STOPPED_RUN_ID },
      `The stopped run ${STOPPED_RUN_ID} retains this stop.`,
      "docsfab runs show",
    ],
    [
      {},
      "The saved run retains no continuation binding, so there is no resume command for this stop.",
      undefined,
    ],
    [
      { resumeRunId: "../../etc/passwd" },
      "The retained run id is not one this host can load, so no resume command is offered for this stop.",
      undefined,
    ],
    [
      { resumeRunId: "" },
      "The retained run id is not one this host can load, so no resume command is offered for this stop.",
      undefined,
    ],
  ])("states the true resumability for a persisted stop, %j", (stop, sentence, command) => {
    const { activity, output } = stopRenderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          kind: "docsfab-live-workflow-result",
          runId: STOPPED_RUN_ID,
          workflow: "create-documentation",
          status: "needs-input",
          error: "insufficient-evidence",
          knowledgeStop: { reason: "insufficient-evidence", ...stop },
        },
      }),
    );
    const transcript = output();
    expect(transcript).toContain("Workflow knowledge stop (insufficient-evidence).");
    expect(transcript).toContain(sentence);
    if (command) expect(transcript).toContain(command);
    else expect(transcript).not.toContain("docsfab runs show");
    expect(transcript).not.toContain(UNTYPED_FALLBACK);
  });

  it("types the stop DocsFab could not retain instead of the untyped fallback", async () => {
    const failure = await knowledgeStopTool(async () => {
      throw new KnowledgeContinuationError("artifact-missing");
    })
      .execute(
        "tool-1",
        { workflow: "create-documentation", instruction: "Write the usage page." },
        undefined,
        undefined,
        undefined as never,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toBe(LIVE_KNOWLEDGE_STOP_NOT_RETAINED);
    // The continuation code is DocsFab's own artefact bookkeeping and must not
    // become the operator's category.
    expect(message).not.toContain("artifact-missing");
    const { activity, output } = stopRenderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", { content: [{ type: "text", text: message }] }, true),
    );
    const transcript = output();
    expect(transcript).toContain("Workflow knowledge stop (not-retained).");
    expect(transcript).toContain("could not retain a resumable record of that stop.");
    expect(transcript).not.toContain(UNTYPED_FALLBACK);
    expect(transcript).not.toContain("--resume-from");
    expect(transcript).not.toContain("docsfab runs show");
  });

  it.each([
    [`${LIVE_KNOWLEDGE_STOP_DIAGNOSTICS.conflict} PRIVATE_PROVIDER_PAYLOAD`, "decorated"],
    ["PRIVATE_PROVIDER_PAYLOAD knowledge snapshot conflicts with claim alpha", "unrecognized"],
  ])("keeps a %s failure on the untyped fallback rather than a guessed category", (message) => {
    const { activity, output } = stopRenderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", { content: [{ type: "text", text: message }] }, true),
    );
    const transcript = output();
    expect(transcript).toContain(UNTYPED_FALLBACK);
    expect(transcript).not.toContain("Workflow knowledge stop");
    expect(transcript).not.toContain("PRIVATE_PROVIDER_PAYLOAD");
  });

  it("keeps the stopped workflow milestone visible when the session later succeeds with direct skills", () => {
    const { activity, output } = stopRenderer();
    activity.begin();
    activity.handle(
      start("docsfab_run_workflow", { workflow: "create-documentation" }, "call-workflow"),
    );
    activity.handle(
      end(
        "docsfab_run_workflow",
        {
          details: {
            kind: "docsfab-live-workflow-result",
            runId: STOPPED_RUN_ID,
            workflow: "create-documentation",
            status: "needs-input",
            error: "insufficient-evidence",
            knowledgeStop: { reason: "insufficient-evidence", resumeRunId: STOPPED_RUN_ID },
          },
        },
        false,
        "call-workflow",
      ),
    );
    activity.handle(start("docsfab_use_skill", { skill: "review-documentation" }, "call-skill"));
    activity.handle(
      end("docsfab_use_skill", { details: { kind: "docsfab-live-skill" } }, false, "call-skill"),
    );
    activity.handle(text("Created docs/usage.md."));
    activity.finish();
    const transcript = output();
    expect(transcript).toContain("[Needs input] Running workflow: create-documentation");
    expect(transcript).toContain("Workflow knowledge stop (insufficient-evidence).");
    expect(transcript).toContain("[Done] Loading skill: review-documentation");
    // The later skill success never becomes a workflow success.
    expect(transcript).not.toContain("[Done] Running workflow");
    expect(transcript.indexOf("Workflow knowledge stop")).toBeLessThan(
      transcript.indexOf("[Done] Loading skill"),
    );
  });

  it("drives a pre-record stop through the workflow capability adapter into the terminal", async () => {
    const { activity, output } = stopRenderer();
    const failure = await knowledgeStopTool(async () => {
      throw new KnowledgeResumeError(
        "insufficient-evidence",
        "PRIVATE_PROVIDER_PAYLOAD from the knowledge adapter",
      );
    })
      .execute(
        "tool-1",
        { workflow: "create-documentation", instruction: "Write the usage page." },
        undefined,
        undefined,
        undefined as never,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    // The raised error's own message is discarded; the fixed sentence the
    // supplier ships for that reason is what the model reads.
    expect(message).toBe(LIVE_KNOWLEDGE_STOP_DIAGNOSTICS["insufficient-evidence"]);
    expect(message).toContain(knowledgeResumeNeedsInputMessage("insufficient-evidence"));
    expect(message).not.toContain("PRIVATE_PROVIDER_PAYLOAD");
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "create-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", { content: [{ type: "text", text: message }] }, true),
    );
    expect(output()).toContain("Workflow knowledge stop (insufficient-evidence).");
    expect(output()).not.toContain("PRIVATE_PROVIDER_PAYLOAD");
    expect(output()).not.toContain(UNTYPED_FALLBACK);
  });

  it("leaves every other workflow failure class untouched at the adapter", async () => {
    const failure = await knowledgeStopTool(async () => {
      throw new LocalUserPublicationPreflightError("detached-head");
    })
      .execute(
        "tool-1",
        { workflow: "create-documentation", instruction: "Write the usage page." },
        undefined,
        undefined,
        undefined as never,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(LocalUserPublicationPreflightError);
  });

  it("shows the typed stop through the shipped live-agent conversation loop", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    let listener: (event: AgentSessionEvent) => void = () => {};
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
        prompt: async () => {
          listener(start("docsfab_run_workflow", { workflow: "create-documentation" }));
          listener(
            end(
              "docsfab_run_workflow",
              {
                content: [
                  { type: "text", text: LIVE_KNOWLEDGE_STOP_DIAGNOSTICS["insufficient-evidence"] },
                ],
              },
              true,
            ),
          );
        },
        abort: async () => {},
      },
      input,
      output,
      stopOptions,
    );
    input.write("Create the usage page\n");
    await vi.waitFor(() =>
      expect(transcript).toContain("Workflow knowledge stop (insufficient-evidence)."),
    );
    expect(transcript).toContain(
      "No run record was saved, so there is no run id or resume command for this stop.",
    );
    expect(transcript).not.toContain(UNTYPED_FALLBACK);
    input.write("/exit\n");
    await conversation;
  });

  it("shows the typed stop when a continued editorial run stops on knowledge", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const plan = {
      originalRunId: "run-editorial-original",
      workflow: "create-documentation",
      instruction: "Write the usage page.",
      instructionSha256: "b".repeat(64),
      repositoryPath: "/sample",
      revision: "a".repeat(40),
      fills: [{ inputId: "product-name" }],
      skipPlanner: true,
      skipSearchObserve: true,
      revalidate: false,
      verifiedNoChange: false,
      readerSources: [],
    };
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        prompt: async () => {},
        abort: async () => {},
      },
      input,
      output,
      {
        ...stopOptions,
        planEditorialInputAskTurn: async () =>
          ({ kind: "input-ask-resume", plan }) as unknown as Awaited<
            ReturnType<
              NonNullable<
                Parameters<typeof runTerminalConversation>[3]["planEditorialInputAskTurn"]
              >
            >
          >,
        continueEditorialInputAsk: async () =>
          persistedKnowledgeStopRecord({ id: STOPPED_RUN_ID }) as never,
      },
    );
    input.write("The product is called Bluebird\n");
    await vi.waitFor(() =>
      expect(transcript).toContain("Workflow knowledge stop (insufficient-evidence)."),
    );
    expect(transcript).toContain(`The stopped run ${STOPPED_RUN_ID} retains this stop.`);
    expect(transcript).not.toContain(UNTYPED_FALLBACK);
    expect(transcript).not.toContain("Provide the missing task details before retrying");
    input.write("/exit\n");
    await conversation;
  });

  it("ships one fixed diagnostic per shipped knowledge-stop reason", () => {
    expect(Object.keys(LIVE_KNOWLEDGE_STOP_DIAGNOSTICS).sort()).toEqual(
      [...KNOWLEDGE_STOP_REASONS].sort(),
    );
    for (const reason of KNOWLEDGE_STOP_REASONS) {
      expect(LIVE_KNOWLEDGE_STOP_DIAGNOSTICS[reason]).toBe(
        `DocsFab knowledge stop (${reason}). ${knowledgeResumeNeedsInputMessage(reason)}`,
      );
    }
  });

  it.each([
    [{ originalRunId: STOPPED_RUN_ID, workflow: "create-documentation" }, STOPPED_RUN_ID],
    [{ originalRunId: "run-other", workflow: "create-documentation" }, undefined],
    [{ originalRunId: STOPPED_RUN_ID, workflow: "update-documentation" }, undefined],
    [undefined, undefined],
  ])(
    "binds a resumable id to the retained continuation receipt, receipt=%j",
    (receipt, expected) => {
      const stop = liveWorkflowKnowledgeStop({
        id: STOPPED_RUN_ID,
        workflow: "create-documentation",
        status: "needs-input",
        error: "insufficient-evidence",
        ...(receipt ? { knowledgeContinuationReceipt: receipt } : {}),
      } as never);
      expect(stop?.reason).toBe("insufficient-evidence");
      expect(stop?.resumeRunId).toBe(expected);
    },
  );

  it.each([
    ["succeeded", "insufficient-evidence"],
    ["needs-input", "some-other-error"],
    ["needs-input", undefined],
  ])("projects no knowledge stop for status=%s error=%s", (status, error) => {
    expect(
      liveWorkflowKnowledgeStop({
        id: STOPPED_RUN_ID,
        workflow: "create-documentation",
        status,
        error,
      } as never),
    ).toBeUndefined();
  });
});
