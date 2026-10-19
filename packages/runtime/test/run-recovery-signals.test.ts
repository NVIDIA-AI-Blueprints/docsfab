// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { limitDefinition } from "../src/config/limits.js";
import { createWorkflowBranchCoverageV1 } from "../src/records/composition-execution.js";
import type { RunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import type { WorkflowBranchCoverageV1 } from "../src/workflow-contracts/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../src/workflow-contracts/outcome.js";
import {
  buildRunHumanNextCommand,
  collectRunResultNextSteps,
  formatRunSummary,
  renderWorkflowOutcome,
  runVerdictPlanes,
  type RunSummaryContext,
} from "../src/operator/run-summary.js";
import { buildRunResultV1 } from "../src/operator/run-result.js";
import { excerptRejectedReply } from "../src/execution/rejected-reply-excerpt.js";
import { fingerprintRejectedReply } from "../src/execution/rejected-reply-shape.js";
import {
  classifyRunResumability,
  projectRunContinuationCommand,
} from "../src/operator/run-resumability.js";
import type { ProjectedReviewFindingsV1 } from "../src/review/findings.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { workflowOutcomePersistenceError } from "../src/workflow-execution/runner-schedule.js";

const REVISION = "a".repeat(40);

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-recovery-001",
    workflow: "review-documentation",
    repository: { sourcePath: "/tmp/example", requestedRevision: "HEAD", revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-14T12:00:00Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    ...overrides,
  };
}

function projection(
  availability: ProjectedReviewFindingsV1["availability"],
  limitations: readonly string[] = [],
  withFinding = false,
): ProjectedReviewFindingsV1 {
  return {
    projector: "docsfab-review-findings-v2",
    availability,
    artifactLocator:
      availability === "complete" || availability === "partial"
        ? `record:sha256:${"b".repeat(64)}`
        : null,
    limitations,
    findings: withFinding
      ? [
          {
            id: "DQ-001",
            code: "DQ-001",
            severity: "warning",
            summary: "The target documentation omits a required behavior.",
            path: "README.md",
            line: 12,
            origin: "agent",
            evidence: "README.md:12: Bound source evidence.",
            recommendation: "Document the missing behavior.",
          },
        ]
      : [],
  };
}

function context(
  review: ProjectedReviewFindingsV1,
  overrides: Partial<RunSummaryContext> = {},
): RunSummaryContext {
  return {
    record: record(),
    recordPath: "/tmp/state/run-recovery-001.json",
    repositoryPath: "/tmp/example",
    exitCode: 0,
    reviewFindingsProjection: review,
    reviewEvidenceProjection: {
      reviewMethod: "static-read-only",
      packageChecks: "not-executed",
      artifactValidators: review.availability === "invalid" ? "invalid" : "unavailable",
      audience: { human: "unavailable", agent: "unavailable" },
    },
    ...overrides,
  };
}

function humanAndJson(contextValue: RunSummaryContext): { human: string; json: string } {
  return {
    human: formatRunSummary(contextValue).join("\n"),
    json: collectRunResultNextSteps(contextValue).join("\n"),
  };
}

function expectSelectedActionParity(contextValue: RunSummaryContext): void {
  const action = buildRunHumanNextCommand(contextValue);
  expect(action).toBeDefined();
  const human = formatRunSummary(contextValue);
  const json = collectRunResultNextSteps(contextValue);
  expect(human.filter((line) => line.trim() === action!.command)).toHaveLength(1);
  expect(human.filter((line) => line.trim() === `Reason: ${action!.reason}`)).toHaveLength(1);
  expect(json.filter((step) => step === action!.command)).toHaveLength(1);
  expect(json.filter((step) => step === action!.reason)).toHaveLength(1);
}

describe("review recovery signals", () => {
  it.each([
    ["Technical review response rejected: invalid-json.", true, false],
    ["Technical review response rejected: unknown.", true, false],
    ["Technical correction response rejected: unknown.", false, false],
    ["Technical review response rejected: invalid-coverage.", false, true],
    ["Technical correction response rejected: source-authority.", false, true],
    ["Technical review response rejected: invalid-json. /Users/private", false, false],
  ] as const)(
    "selects only deterministic closed technical recovery for %s retryable=%s",
    (message, retryable, selected) => {
      const value = context(projection("unavailable"), {
        record: record({
          status: "failed",
          error: message,
          steps: [
            {
              id: "verify-technical-accuracy",
              title: "Technical verification",
              skill: "verify-technical-accuracy",
              mode: "read-only",
              status: "failed",
              error: message,
              inference: {
                policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
                attempts: [
                  {
                    attempt: 1,
                    startedAt: "2026-09-16T12:00:00Z",
                    completedAt: "2026-09-16T12:00:01Z",
                    durationMs: 1000,
                    outcome: "malformed-response",
                    retryable,
                    retryScheduled: false,
                  },
                ],
              },
            },
          ],
        }),
      });
      const reason = buildRunHumanNextCommand(value)?.reason ?? "";
      expect(reason.includes("not admitted as evidence")).toBe(selected);
      if (selected) {
        expect(reason.startsWith(message)).toBe(true);
        expect(reason).toContain("rejected body was not retained");
        expect(reason).toContain("not a provider-outage diagnosis");
        expect(reason).toContain("this diagnosis does not establish a provider root cause");
        expect(reason).toContain("do not retry the same inference unchanged");
        expect(reason).not.toContain("producer or response contract");
      }
      expectSelectedActionParity(value);
    },
  );

  it.each([
    ["no excerpt", undefined, undefined, "The rejected body was not retained."],
    [
      "a retained excerpt",
      "Reasoning before the answer.",
      512,
      "A bounded, redacted excerpt of the rejected body is in the saved run (`docsfab runs show run-1",
    ],
    [
      "a withheld excerpt",
      `Use AIza${"Sy0123456789abcdefghijklmnopqrstuvw"} now.`,
      512,
      "The rejected body's excerpt was withheld because the credential screen matched it.",
    ],
    [
      "an excerpt under bound 0",
      "Reasoning before the answer.",
      0,
      "The rejected body was not retained (inference.rejectedReplyExcerptChars = 0).",
    ],
  ] as const)(
    "says what the saved run keeps of the rejected body with %s (#1690)",
    (_label, reply, bound, sentence) => {
      const message = "Technical review response rejected: invalid-json.";
      const excerptFields =
        reply === undefined
          ? {}
          : {
              rejectedReplyShape: fingerprintRejectedReply(reply, () => true),
              rejectedReplyExcerpt: excerptRejectedReply(reply, bound!, 0),
            };
      const value = context(projection("unavailable"), {
        record: record({
          id: "run-1",
          status: "failed",
          error: message,
          steps: [
            {
              id: "verify-technical-accuracy",
              title: "Technical verification",
              skill: "verify-technical-accuracy",
              mode: "read-only",
              status: "failed",
              error: message,
              inference: {
                policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
                attempts: [
                  {
                    attempt: 1,
                    durationMs: 1000,
                    outcome: "malformed-response",
                    retryable: false,
                    retryScheduled: false,
                    ...excerptFields,
                  },
                ],
              },
            },
          ],
        } as unknown as Partial<RunRecord>),
      });
      const reason = buildRunHumanNextCommand(value)?.reason ?? "";
      expect(reason).toContain(sentence);
      if (reply !== undefined) expect(reason).not.toContain("The rejected body was not retained.");
    },
  );

  it.each([
    // A prose reply whose correctable retries ran out still gets the NEXT action.
    ["unframed-reply", true],
    // Adjacent: an exhausted correctable refusal of another kind does not.
    [undefined, false],
  ] as const)(
    "selects technical recovery for an exhausted reply with condition %s: %s",
    (condition, selected) => {
      const message = "Technical review response rejected: invalid-json.";
      const value = context(projection("unavailable"), {
        record: record({
          status: "failed",
          error: message,
          steps: [
            {
              id: "verify-technical-accuracy",
              title: "Technical verification",
              skill: "verify-technical-accuracy",
              mode: "read-only",
              status: "failed",
              error: message,
              inference: {
                policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
                attempts: [
                  {
                    attempt: 1,
                    durationMs: 1000,
                    outcome: "malformed-response",
                    retryable: true,
                    retryScheduled: false,
                    ...(condition === undefined ? {} : { condition }),
                  },
                ],
              },
            },
          ],
        } as unknown as Partial<RunRecord>),
      });
      const reason = buildRunHumanNextCommand(value)?.reason ?? "";
      expect(reason.includes("not admitted as evidence")).toBe(selected);
      expectSelectedActionParity(value);
    },
  );

  it("states a declined retry, eligibility disagreement, and remaining budget", () => {
    const message = "Technical correction response rejected: invalid-fact-inventory.";
    const value = context(projection("unavailable"), {
      record: record({
        status: "failed",
        error: message,
        steps: [
          {
            id: "verify-technical-accuracy",
            title: "Technical verification",
            skill: "verify-technical-accuracy",
            mode: "read-only",
            status: "failed",
            error: message,
            inference: {
              configuredMaxRetries: 3,
              effectiveMaxRetries: 3,
              baseDelayMs: 0,
              maxDelayMs: 0,
              retryableCategories: ["malformed-response"],
              replay: "read-only",
              attempts: [
                {
                  attempt: 1,
                  startedAt: "2026-09-16T12:00:00Z",
                  completedAt: "2026-09-16T12:00:01Z",
                  durationMs: 1000,
                  outcome: "malformed-response",
                  retryable: false,
                  retryScheduled: false,
                  conditionRetryability: "eligible",
                  retryDecision: "declined",
                },
              ],
            },
          },
        ],
      }),
      exitCode: 1,
    });
    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(
      "docsfab runs show run-recovery-001 --state-dir /tmp/state --json",
    );
    expect(action?.reason).toContain("Retry declined");
    expect(action?.reason).toContain("condition eligible disagrees with retryable false");
    expect(action?.reason).toContain("3 retries remaining");
    expect(action?.reason).toContain("do not retry the same inference unchanged");
    expect(action?.command).not.toContain("doctor");
    expectSelectedActionParity(value);
  });

  it("inspects remaining budget for a declined retry that is not a technical diagnostic", () => {
    const value = context(projection("unavailable"), {
      record: record({
        status: "failed",
        error: "failed as malformed-response",
        steps: [
          {
            id: "assess-readiness",
            title: "Assess readiness",
            skill: "assess-readiness",
            mode: "read-only",
            status: "failed",
            error: "failed as malformed-response",
            inference: {
              configuredMaxRetries: 3,
              effectiveMaxRetries: 3,
              baseDelayMs: 0,
              maxDelayMs: 0,
              retryableCategories: ["malformed-response"],
              replay: "read-only",
              attempts: [
                {
                  attempt: 1,
                  startedAt: "2026-09-16T12:00:00Z",
                  completedAt: "2026-09-16T12:00:01Z",
                  durationMs: 1000,
                  outcome: "malformed-response",
                  retryable: false,
                  retryScheduled: false,
                  conditionRetryability: "eligible",
                  retryDecision: "declined",
                },
              ],
            },
          },
        ],
      }),
      exitCode: 1,
    });
    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(
      "docsfab runs show run-recovery-001 --state-dir /tmp/state --json",
    );
    expect(action?.reason).toContain("Inspect the saved run's retry decision and remaining budget");
    expect(action?.reason).toContain("Retry declined");
    expect(action?.reason).toContain("3 retries remaining");
    expect(action?.reason).toContain("condition eligible disagrees with retryable false");
    expect(action?.command).not.toContain("doctor");
    expect(action?.reason).not.toContain("docsfab doctor");
    expect(action?.command).not.toContain("docsfab run ");
    expectSelectedActionParity(value);
  });

  it("keeps the selected report command and reason in human and JSON recovery", () => {
    const reportServeCommand =
      "docsfab reports serve --state-dir '/tmp/custom review state' --port 9123";
    const cases = [
      projection("complete"),
      projection("partial", ["review-findings-unparsed:lint-documentation"], true),
      projection("unavailable", [
        "review-findings-artifact-unavailable:evaluate-document-quality:no-binding",
      ]),
      projection("invalid", ["review-findings-artifact-invalid:evaluate-document-quality:binding"]),
    ];

    for (const reviewFindingsProjection of cases) {
      const value = context(reviewFindingsProjection, {
        recordPath: "/tmp/custom review state/run-recovery-001.json",
        reportServeCommand,
      });
      expect(buildRunHumanNextCommand(value)?.command).toBe(reportServeCommand);
      expectSelectedActionParity(value);
    }
  });

  it("uses the retained record state directory when a review report is unavailable", () => {
    const value = context(
      projection("partial", ["review-findings-unparsed:review-documentation"]),
      {
        recordPath: "/tmp/custom review state/run-recovery-001.json",
      },
    );
    const command =
      "docsfab runs show run-recovery-001 --state-dir '/tmp/custom review state' --json";
    expect(buildRunHumanNextCommand(value)?.command).toBe(command);
    expectSelectedActionParity(value);
  });

  it("routes a valid negative review to inspection and separately authorized repair", () => {
    const outputs = humanAndJson(
      context(projection("partial", ["review-findings-unparsed:lint-documentation"], true)),
    );
    for (const output of [outputs.human, outputs.json]) {
      expect(output).toContain("separate write grant");
      expect(output).toContain("do not rerun the unchanged review");
      expect(output).not.toContain("provider readiness");
      expect(output).not.toContain("apply the patch");
    }
  });

  it("distinguishes a supported zero from partial and unavailable findings", () => {
    const complete = humanAndJson(context(projection("complete")));
    expect(complete.human).toContain("supported findings projection is empty");
    expect(complete.json).toContain("supported findings projection is empty");

    const partial = humanAndJson(
      context(projection("partial", ["review-findings-unparsed:review-documentation"])),
    );
    expect(partial.human).toContain("empty count does not establish zero defects");
    expect(partial.json).toContain("empty count does not establish zero defects");

    const absent = humanAndJson(
      context(
        projection("unavailable", [
          "review-findings-artifact-unavailable:evaluate-document-quality:no-binding",
        ]),
      ),
    );
    for (const output of [absent.human, absent.json]) {
      expect(output).toContain("artifact was recorded");
      expect(output).toContain("never existed");
      expect(output).not.toContain("Restore the matching known-good");
    }
  });

  it("reserves restoration for lost state and preserves invalid evidence", () => {
    const lost = humanAndJson(
      context(
        projection("unavailable", [
          "review-findings-artifact-unavailable:evaluate-document-quality:artifact-absent",
        ]),
      ),
    );
    expect(lost.human).toContain("matching known-good retained record and artifact set");
    expect(lost.json).toContain("matching known-good retained record and artifact set");
    expect(lost.json).toContain("do not rerun inference");

    const invalid = humanAndJson(
      context(
        projection("invalid", [
          "review-findings-artifact-invalid:evaluate-document-quality:binding",
        ]),
      ),
    );
    for (const output of [invalid.human, invalid.json]) {
      expect(output).toContain("do not edit sealed evidence");
      expect(output).toContain("do not").and.toContain("rerun unchanged inference");
    }
  });

  it("reports static review, host validators, and unavailable audiences without claiming checks", () => {
    const value = context(projection("complete"), {
      reviewEvidenceProjection: {
        reviewMethod: "static-read-only",
        packageChecks: "not-executed",
        artifactValidators: "passed",
        audience: { human: "unavailable", agent: "model-claimed-only" },
      },
    });
    const human = formatRunSummary(value).join("\n");
    expect(human).toContain("Review method: static-read-only");
    expect(human).toContain("Package command checks: not-executed");
    expect(human).toContain("Artifact validators: passed");
    expect(human).toContain("Human audience evidence: unavailable");
    expect(human).toContain("Agent audience evidence: model-claimed-only");
    expect(human).not.toContain("Package command checks: passed");
  });
});

describe("failed-run recovery signals", () => {
  const failureContext = (outcome: string, retryable: boolean): RunSummaryContext => ({
    record: record({
      workflow: "create-documentation",
      status: "failed",
      steps: [
        {
          id: "author",
          title: "Author",
          skill: "author-documentation",
          mode: "write",
          status: "failed",
          inference: {
            attempts: [{ outcome, retryable, retryScheduled: false }] as never,
          } as never,
        },
      ],
    }),
    recordPath: "/tmp/state/run-recovery-001.json",
    repositoryPath: "/tmp/example",
    exitCode: 1,
  });

  it("permits retry only after a recorded transient provider failure clears", () => {
    const value = failureContext("provider-transient", true);
    const human = buildRunHumanNextCommand(value);
    const json = collectRunResultNextSteps(value);
    expect(human?.reason).toContain("only after the provider condition clears");
    expect(json.join(" ")).toContain("only after the provider condition clears");
    expectSelectedActionParity(value);
  });

  it("requires correction for a deterministic malformed-response failure", () => {
    for (const [outcome, retryable, phrase] of [
      ["malformed-response", false, "do not repeat unchanged inference"],
    ] as const) {
      const value = failureContext(outcome, retryable);
      const human = buildRunHumanNextCommand(value);
      const json = collectRunResultNextSteps(value);
      expect(human?.reason).toContain(phrase);
      expect(json.join(" ")).toContain(phrase);
      expect(json.join(" ")).not.toContain("verify runtime and provider readiness, then rerun");
      expectSelectedActionParity(value);
    }
  });

  it("asks for a narrower scope, not doctor or a rerun, after a review scope byte-bound stop", () => {
    const value = failureContext("malformed-response", false);
    value.record.workflow = "review-documentation";
    value.record.steps[0] = {
      ...value.record.steps[0]!,
      id: "provisional-technical-verification",
      inference: {
        attempts: [
          {
            outcome: "malformed-response",
            retryable: false,
            retryScheduled: false,
            rejection: {
              code: "technical-correction-proposal-max-bytes-bound",
              location: "$response",
            },
          },
        ],
      } as never,
    };

    const action = buildRunHumanNextCommand(value);

    expect(action).toMatchObject({
      command: "docsfab runs show run-recovery-001 --state-dir /tmp/state",
      recoveryAction: "rescope",
    });
    expect(action?.reason).toContain("technicalCorrection.proposalMaxBytes");
    expect(action?.reason).toContain("--rescope-from run-recovery-001");
    expect(action?.reason).toContain("--review-target");
    expect(action?.reason).toContain(
      limitDefinition("technicalCorrection.proposalMaxBytes").remediation,
    );
    expect(collectRunResultNextSteps(value).join(" ")).not.toContain("docsfab doctor");
    expectSelectedActionParity(value);
  });

  it("keeps the custom state directory for retryable malformed-response inspection", () => {
    const value = failureContext("malformed-response", true);
    value.recordPath = "/tmp/custom failure state/run-recovery-001.json";
    expect(buildRunHumanNextCommand(value)?.command).toBe(
      "docsfab runs show run-recovery-001 --state-dir '/tmp/custom failure state' --json",
    );
    expectSelectedActionParity(value);
  });

  it.each([
    [
      "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-source-locator-membership.",
      false,
    ],
    ["Authoring revision accounting did not satisfy the host-owned contract.", true],
  ] as const)(
    "routes an exact revision-accounting rejection to saved-run inspection",
    (message, isHistorical) => {
      const value = failureContext("malformed-response", false);
      value.recordPath = "/tmp/custom failure state/run-recovery-001.json";
      value.record.error = message;
      value.record.steps[0] = {
        ...value.record.steps[0]!,
        id: "revise-documentation",
        error: message,
      };

      const action = buildRunHumanNextCommand(value);
      expect(action?.command).toBe(
        "docsfab runs show run-recovery-001 --state-dir '/tmp/custom failure state' --json",
      );
      for (const output of [action?.reason ?? "", collectRunResultNextSteps(value).join(" ")]) {
        expect(output).toContain("producer");
        expect(output).toContain(
          "Candidate selection and failed-partial status could not be verified",
        );
        expect(output).not.toContain("Candidate 0 remains selected");
        expect(output).not.toContain("non-deliverable");
        expect(output).toContain("do not replay or retry the unchanged inference or write step");
        expect(output).not.toContain("decoder capability");
        expect(output).not.toContain("docsfab doctor");
      }
      if (isHistorical) {
        expect(action?.reason).toContain("exact rejected predicate is unavailable");
      } else {
        expect(action?.reason).not.toContain("exact rejected predicate is unavailable");
      }
      expectSelectedActionParity(value);
    },
  );

  it("does not recognize approximate accounting messages or unrelated steps", () => {
    const exact =
      "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-source-locator-membership.";
    for (const [stepId, message] of [
      ["revise-documentation", `${exact} extra`],
      ["author", exact],
    ] as const) {
      const value = failureContext("malformed-response", false);
      value.record.error = message;
      value.record.steps[0] = { ...value.record.steps[0]!, id: stepId, error: message };
      expect(buildRunHumanNextCommand(value)?.command).toContain("docsfab doctor");
      expectSelectedActionParity(value);
    }
  });

  it("routes the later mutation mismatch without inventing a decoder failure", () => {
    const message =
      "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-changed-path-mismatch.";
    const value = failureContext("succeeded", false);
    value.recordPath = "/tmp/custom failure state/run-recovery-001.json";
    value.record.error = message;
    value.record.steps[0] = {
      ...value.record.steps[0]!,
      id: "revise-documentation",
      status: "failed",
      error: message,
    };

    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(
      "docsfab runs show run-recovery-001 --state-dir '/tmp/custom failure state' --json",
    );
    expect(action?.reason).toContain("revision-accounting-changed-path-mismatch");
    expect(action?.reason).not.toContain("schema or decoder capability");
    expect(action?.reason).toContain(
      "do not replay or retry the unchanged inference or write step",
    );
    expectSelectedActionParity(value);
  });

  it("routes the historical generic accounting message after succeeded inference", () => {
    const message = "Authoring revision accounting did not satisfy the host-owned contract.";
    const value = failureContext("succeeded", false);
    value.record.error = message;
    value.record.steps[0] = {
      ...value.record.steps[0]!,
      id: "revise-documentation",
      error: message,
    };

    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(
      "docsfab runs show run-recovery-001 --state-dir /tmp/state --json",
    );
    expect(action?.reason).toContain("historical revision-accounting rejection");
    expect(action?.reason).toContain("exact rejected predicate is unavailable");
    expectSelectedActionParity(value);
  });

  it.each([
    [
      "a decoder diagnostic after succeeded inference",
      () => {
        const message =
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-source-locator-membership.";
        const value = failureContext("succeeded", false);
        value.record.error = message;
        value.record.steps[0] = {
          ...value.record.steps[0]!,
          id: "revise-documentation",
          error: message,
        };
        return value;
      },
    ],
    [
      "a succeeded revision step",
      () => {
        const message =
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-source-locator-membership.";
        const value = failureContext("succeeded", false);
        value.record.error = message;
        value.record.steps[0] = {
          ...value.record.steps[0]!,
          id: "revise-documentation",
          status: "succeeded",
          error: message,
        };
        return value;
      },
    ],
    [
      "a later unrelated failed step",
      () => {
        const message =
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-source-locator-membership.";
        const value = failureContext("malformed-response", false);
        value.record.error = "The later host validation failed.";
        value.record.steps = [
          {
            ...value.record.steps[0]!,
            id: "revise-documentation",
            error: message,
          },
          {
            id: "host-validation",
            title: "Validate",
            skill: "validate-documentation",
            mode: "read-only",
            status: "failed",
            error: value.record.error,
          },
        ];
        return value;
      },
    ],
  ] as const)(
    "inspects the saved run instead of binding accounting recovery to %s",
    (_name, createValue) => {
      const value = createValue();
      const action = buildRunHumanNextCommand(value);
      expect(action?.command).toBe(
        "docsfab runs show run-recovery-001 --state-dir /tmp/state --json",
      );
      expect(action?.command).not.toContain("docsfab doctor");
      expect(action?.reason).not.toContain("revision producer");
      expect(action?.reason).not.toContain("Candidate 0 remains selected");
      expectSelectedActionParity(value);
    },
  );

  it.each([
    [
      "a mutation diagnostic after malformed response",
      () => {
        const message =
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-changed-path-mismatch.";
        const value = failureContext("malformed-response", false);
        value.record.error = message;
        value.record.steps[0] = {
          ...value.record.steps[0]!,
          id: "revise-documentation",
          error: message,
        };
        return value;
      },
    ],
    [
      "mismatched exact step and run diagnostics",
      () => {
        const value = failureContext("malformed-response", false);
        value.record.steps[0] = {
          ...value.record.steps[0]!,
          id: "revise-documentation",
          error:
            "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-source-locator-membership.",
        };
        value.record.error =
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-changed-path-mismatch.";
        return value;
      },
    ],
    [
      "an unknown diagnostic code",
      () => {
        const message =
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-unknown.";
        const value = failureContext("malformed-response", false);
        value.record.error = message;
        value.record.steps[0] = {
          ...value.record.steps[0]!,
          id: "revise-documentation",
          error: message,
        };
        return value;
      },
    ],
    [
      "the wrong workflow",
      () => {
        const message =
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-source-locator-membership.";
        const value = failureContext("malformed-response", false);
        value.record.workflow = "review-documentation";
        value.record.error = message;
        value.record.steps[0] = {
          ...value.record.steps[0]!,
          id: "revise-documentation",
          error: message,
        };
        return value;
      },
    ],
  ] as const)("does not bind accounting recovery to %s", (_name, createValue) => {
    const value = createValue();
    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toContain("docsfab doctor");
    expect(action?.reason).not.toContain("revision producer");
    expect(action?.reason).not.toContain("Candidate 0 remains selected");
    expectSelectedActionParity(value);
  });

  it("does not reuse an earlier recovered transient when a later host stage fails", () => {
    const value = failureContext("provider-transient", true);
    value.record.steps = [
      {
        ...value.record.steps[0]!,
        id: "author",
        status: "succeeded",
        inference: {
          attempts: [
            { outcome: "provider-transient", retryable: true, retryScheduled: true },
            { outcome: "succeeded", retryable: false, retryScheduled: false },
          ] as never,
        } as never,
      },
      {
        id: "host-validation",
        title: "Validate",
        skill: "validate-documentation",
        mode: "read-only",
        status: "failed",
        error: "The host validator failed.",
      },
    ];

    const human = buildRunHumanNextCommand(value);
    const json = collectRunResultNextSteps(value).join(" ");
    expect(human?.command).toBe("docsfab runs show run-recovery-001 --state-dir /tmp/state --json");
    expect(human?.command).not.toContain("docsfab doctor");
    expect(human?.reason).not.toContain("recorded bounded provider retries");
    expect(json).not.toContain("provider condition clears");
    expect(json).not.toContain("repeat the original approved instruction");
    expectSelectedActionParity(value);
  });

  it("routes outcome sealing failures to retained evidence instead of a blind rerun", () => {
    const value: RunSummaryContext = {
      record: record({
        status: "failed",
        error: workflowOutcomePersistenceError,
        steps: [
          {
            id: "evaluate-documentation",
            title: "Evaluate documentation",
            skill: "evaluate-documentation",
            mode: "read-only",
            status: "succeeded",
          },
        ],
      }),
      recordPath: "/tmp/custom state/run-recovery-001.json",
      repositoryPath: "/tmp/example",
      exitCode: 1,
    };

    const human = buildRunHumanNextCommand(value);
    const json = collectRunResultNextSteps(value).join(" ");
    expect(human?.command).toBe(
      "docsfab runs show run-recovery-001 --state-dir '/tmp/custom state' --json",
    );
    expectSelectedActionParity(value);
    for (const output of [human?.reason ?? "", json]) {
      expect(output).toContain("product-outcome and tool-accounting evidence");
      expect(output).toContain("Preserve the failed run unchanged");
      expect(output).toContain("tool-accounting producer");
      expect(output).toContain("do not retry unchanged inference");
      expect(output).not.toContain("provider readiness");
    }
  });

  it("does not project doctor for editorial InputAsk needs-input", () => {
    const value: RunSummaryContext = {
      record: record({
        workflow: "update-documentation",
        status: "needs-input",
        steps: [
          {
            id: "plan-documentation",
            title: "Plan documentation",
            skill: "plan-documentation",
            mode: "read-only",
            status: "needs-input",
          },
        ],
      }),
      recordPath: "/tmp/state/run-recovery-001.json",
      repositoryPath: "/tmp/example",
      exitCode: 2,
    };
    const evidence = workflowOutcomeStepEvidence(value.record, "plan-documentation");
    value.record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "needs-input",
        findings: [
          {
            id: "finding:editorial:comparison",
            kind: "missing-governed-input",
            severity: "warning",
            code: "independent-rejection",
            inputId: "comparison",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:editorial:comparison",
            kind: "governed-input",
            inputId: "comparison",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      },
      value.record,
    );
    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe("docsfab do --continue run-recovery-001");
    expect(action?.command).not.toContain("docsfab doctor");
    expect(action?.reason).toContain("Revision comparison");
    expectSelectedActionParity(value);
  });

  it("keeps an open human decision distinct from doctor and knowledge resume", async () => {
    const value: RunSummaryContext = {
      record: record({
        workflow: "update-documentation",
        status: "needs-human-decision",
        steps: [
          {
            id: "plan-documentation",
            title: "Plan documentation",
            skill: "plan-documentation",
            mode: "read-only",
            status: "needs-human-decision",
          },
        ],
      }),
      recordPath: "/tmp/custom-state/run-recovery-001.json",
      repositoryPath: "/tmp/example",
      exitCode: 2,
      editorialDecodeOptions: humanDecisionCoverageOptions(),
    };
    const evidence = workflowOutcomeStepEvidence(value.record, "plan-documentation");
    value.record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "blocked",
        findings: [
          {
            id: "finding:human-decision:publish-scope",
            kind: "blocked-dependency",
            severity: "blocking",
            code: "publish-scope",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:publish-scope",
            kind: "human-decision",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      },
      value.record,
    );
    value.record.workflowBranchCoverage = { sealed: true } as RunRecord["workflowBranchCoverage"];

    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(
      "docsfab runs show run-recovery-001 --state-dir /tmp/custom-state --json",
    );
    expect(collectRunResultNextSteps(value)[0]).toBe(action?.command);
    expect(formatRunSummary(value).join("\n")).toContain(action?.command);
    expect(action?.command).not.toContain("docsfab doctor");
    expect(action?.command).not.toContain("--resume-from");
    expect(action?.reason).toContain("decision:publish-scope");
    expect(
      renderWorkflowOutcome(value.record, {
        decodeOptions: humanDecisionCoverageOptions(),
      }).join("\n"),
    ).toContain("Product open decisions: decision:publish-scope");
    expect(runVerdictPlanes(value).execution).toBe("needs-input");
    expect(
      buildRunResultV1({
        record: value.record,
        recordPath: value.recordPath,
        exitCode: 2,
        repositoryPath: value.repositoryPath,
        editorialDecodeOptions: value.editorialDecodeOptions,
        nextSteps: collectRunResultNextSteps(value),
      }).execution.status,
    ).toBe("needs-human-decision");

    const resumability = await classifyRunResumability(
      value.record,
      "/tmp/custom-state",
      undefined,
      humanDecisionCoverageOptions(),
    );
    expect(resumability).toEqual({ category: "resumable", reason: "needs-human-decision" });
    expect(await classifyRunResumability(value.record, "/tmp/custom-state")).toEqual({
      category: "blocked",
      reason: "needs-human-decision",
    });
    const refused = await projectRunContinuationCommand({
      record: value.record,
      resumability,
      stateDirectory: "/tmp/unused",
      stateDirectoryExplicit: true,
      canonSnapshotPath: "/tmp/snapshot.json",
      acceptCandidateSnapshot: true,
      authorityId: "owner",
    });
    expect(refused).toMatchObject({
      disposition: "unverifiable",
      reason: expect.stringContaining("--resume-from is refused"),
    });
    expectSelectedActionParity(value);

    const unnamed = await classifyRunResumability(
      record({ status: "needs-human-decision" }),
      "/tmp/unused",
    );
    expect(unnamed).toEqual({ category: "blocked", reason: "needs-human-decision" });
    const malformed = record({
      workflow: "update-documentation",
      status: "needs-human-decision",
      steps: [
        {
          id: "plan-documentation",
          title: "Plan documentation",
          skill: "plan-documentation",
          mode: "read-only",
          status: "needs-human-decision",
        },
      ],
      workflowOutcome: {
        disposition: "blocked",
        openDecisions: [{ id: "not valid!!!", kind: "human-decision", evidenceIds: ["missing"] }],
      },
    } as Partial<RunRecord>);
    expect(await classifyRunResumability(malformed, "/tmp/unused")).toEqual({
      category: "blocked",
      reason: "needs-human-decision",
    });
  });

  describe("custom-store runs list/show parity", () => {
    const roots: string[] = [];

    afterEach(async () => {
      process.exitCode = undefined;
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it("names the same coverage-backed human decision in list and show", async () => {
      const saved = coverageBackedHumanDecisionRecord();
      const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-runs-list-show-parity-"));
      roots.push(stateDirectory);
      await writeFile(join(stateDirectory, `${saved.id}.json`), `${JSON.stringify(saved)}\n`, {
        mode: 0o600,
      });

      expect(await classifyRunResumability(saved, stateDirectory)).toEqual({
        category: "blocked",
        reason: "needs-human-decision",
      });

      const listed = await captureIo(() =>
        handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
      );
      const envelope = JSON.parse(listed.stdout) as {
        runs: Array<{
          runId: string;
          status?: string;
          resumability?: { category: string; reason: string };
        }>;
      };
      expect(envelope.runs).toHaveLength(1);
      expect(envelope.runs[0]?.runId).toBe(saved.id);
      expect(envelope.runs[0]?.status).toBe("needs-human-decision");
      expect(envelope.runs[0]?.resumability).toEqual({
        category: "resumable",
        reason: "needs-human-decision",
      });

      const shown = await captureIo(() =>
        handleRunsCommand(["show", saved.id, "--state-dir", stateDirectory]),
      );
      expect(shown.stdout).toContain("Resumability: resumable (needs-human-decision)");
      expect(shown.stdout).toContain("decision:publish-scope");
      expect(shown.stdout).toContain(`--state-dir ${stateDirectory}`);
      expect(shown.stdout).not.toContain("docsfab doctor");
      expect(shown.stdout).toContain("knowledge --resume-from is refused");
      expect(shown.stdout).not.toMatch(/docsfab run .*--resume-from/u);
      expect(shown.stdout).toMatch(/execution needs-input/u);

      const shownJson = await captureIo(() =>
        handleRunsCommand(["show", saved.id, "--json", "--state-dir", stateDirectory]),
      );
      const result = JSON.parse(shownJson.stdout) as {
        execution: { status: string };
        nextSteps?: string[];
      };
      expect(result.execution.status).toBe("needs-human-decision");
      expect(result.nextSteps?.join("\n")).toContain("decision:publish-scope");
      expect(shownJson.stdout).toContain("knowledge --resume-from is refused");
      expect(shownJson.stdout).not.toMatch(/docsfab run .*--resume-from/u);
    });
  });
});

describe("capability-wall recovery signals (#1041)", () => {
  type WallFinding = {
    readonly kind: "evidence-limitation" | "blocked-dependency" | "product-gap";
    readonly severity: "warning" | "blocking";
    readonly code: string;
  };

  const STATE_DIR_SHOW = "docsfab runs show run-recovery-001 --state-dir /tmp/state --json";

  const PATCH = {
    files: [{ path: "docs/guide.md", status: "modified" as const }],
    patch: {
      sha256: "c".repeat(64),
      byteLength: 128,
      lineCount: 8,
      artifactPath: "/tmp/state/run-recovery-001.patch",
      format: "git-diff" as const,
    },
  };

  function wallRecord(options: {
    readonly status: RunRecord["status"];
    readonly disposition: "inconclusive" | "not-ready" | "blocked" | "ready";
    readonly findings: readonly WallFinding[];
    readonly openDecisionKind?: "dependency" | "policy-approval" | "human-decision";
    readonly withPatch?: boolean;
    readonly workflow?: RunRecord["workflow"];
  }): RunRecord {
    const saved = record({
      workflow: options.workflow ?? "create-documentation",
      status: options.status,
      steps: [
        {
          id: "plan-documentation",
          title: "Plan documentation",
          skill: "plan-documentation",
          mode: "read-only",
          status: options.status,
        },
      ],
      ...(options.withPatch ? { changes: PATCH } : {}),
    });
    const evidence = workflowOutcomeStepEvidence(saved, "plan-documentation");
    saved.workflowOutcome = createWorkflowOutcome(
      {
        disposition: options.disposition,
        findings: options.findings.map((finding) => ({
          id: `finding:${finding.code}`,
          kind: finding.kind,
          severity: finding.severity,
          code: finding.code,
          evidenceIds: [evidence.id],
        })),
        evidence: [evidence],
        limitations: options.findings
          .filter((finding) => finding.kind === "evidence-limitation")
          .map((finding) => finding.code),
        openDecisions: options.openDecisionKind
          ? [
              {
                id: "decision:dependency",
                kind: options.openDecisionKind,
                evidenceIds: [evidence.id],
              },
            ]
          : [],
        producedArtifacts: [],
      },
      saved,
    );
    return saved;
  }

  function failedInferenceRecord(outcome: string, retryable: boolean): RunRecord {
    return record({
      workflow: "create-documentation",
      status: "failed",
      steps: [
        {
          id: "author",
          title: "Author",
          skill: "author-documentation",
          mode: "write",
          status: "failed",
          inference: {
            attempts: [{ outcome, retryable, retryScheduled: false }] as never,
          } as never,
        },
      ],
    });
  }

  function wallContext(
    saved: RunRecord,
    overrides: Partial<RunSummaryContext> = {},
  ): RunSummaryContext {
    return {
      record: saved,
      recordPath: "/tmp/state/run-recovery-001.json",
      repositoryPath: "/tmp/example",
      exitCode: saved.status === "succeeded" ? 0 : saved.status === "failed" ? 1 : 2,
      ...overrides,
    };
  }

  function expectNoWallForbiddenDoor(output: string): void {
    // Forbidden on a wall: InputAsk slots, continue/resume doors, doctor, and retry argv.
    expect(output).not.toContain("InputAsk");
    expect(output).not.toContain("Product input:");
    expect(output).not.toContain("docsfab do --continue");
    expect(output).not.toContain("--resume-from");
    expect(output).not.toContain("docsfab doctor");
    expect(output).not.toMatch(/docsfab run \S+ --repo/u);
    expect(output).not.toContain("<original target checkout>");
  }

  function expectRedirect(value: RunSummaryContext, codes: readonly string[]): void {
    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(STATE_DIR_SHOW);
    const human = formatRunSummary(value).join("\n");
    const json = collectRunResultNextSteps(value);
    expect(json).toEqual([action!.command, action!.reason]);
    for (const output of [action!.reason, human, json.join("\n")]) {
      for (const code of codes) expect(output).toContain(code);
      expect(output).toContain("not missing input");
      expect(output).toContain("narrow or retarget it, wait for the capability, or accept");
      expect(output).toContain("Do not retry the unchanged request.");
      expectNoWallForbiddenDoor(output);
    }
    expectSelectedActionParity(value);
  }

  it.each([
    [
      "an inconclusive evidence-limitation",
      {
        status: "succeeded",
        disposition: "inconclusive",
        findings: [
          { kind: "evidence-limitation", severity: "warning", code: "pdf-tounicode-unavailable" },
        ],
      },
      ["evidence-limitation", "pdf-tounicode-unavailable"],
    ],
    [
      "a not-ready product-gap",
      {
        status: "succeeded",
        disposition: "not-ready",
        findings: [{ kind: "product-gap", severity: "blocking", code: "product-gap.pdf-forms" }],
      },
      ["product-gap", "product-gap.pdf-forms"],
    ],
    [
      "a blocked dependency",
      {
        status: "succeeded",
        disposition: "blocked",
        findings: [
          { kind: "blocked-dependency", severity: "blocking", code: "upstream-api-unreleased" },
        ],
        openDecisionKind: "dependency",
      },
      ["blocked-dependency", "upstream-api-unreleased"],
    ],
  ] as const)("redirects %s on a succeeded run without a patch", (_label, options, codes) => {
    expectRedirect(wallContext(wallRecord(options)), codes);
  });

  it("names every wall kind and code and keeps the retained patch reviewable", () => {
    const value = wallContext(
      wallRecord({
        status: "succeeded",
        disposition: "not-ready",
        withPatch: true,
        findings: [
          { kind: "product-gap", severity: "blocking", code: "product-gap.pdf-forms" },
          { kind: "evidence-limitation", severity: "warning", code: "pdf-tounicode-unavailable" },
        ],
      }),
    );
    expectRedirect(value, [
      "evidence-limitation pdf-tounicode-unavailable",
      "product-gap product-gap.pdf-forms",
    ]);
    const reason = buildRunHumanNextCommand(value)?.reason ?? "";
    expect(reason).toContain("retained local patch does not resolve the wall");
    expect(reason).not.toContain("Inspect the saved product evidence and review the local patch");
  });

  it("redirects a needs-human-decision dependency wall instead of falling back to doctor", () => {
    const value = wallContext(
      wallRecord({
        status: "needs-human-decision",
        disposition: "blocked",
        findings: [
          { kind: "blocked-dependency", severity: "blocking", code: "policy-approval-withheld" },
        ],
        openDecisionKind: "policy-approval",
      }),
    );
    expectRedirect(value, ["blocked-dependency", "policy-approval-withheld"]);
  });

  it.each([
    [
      "evidence-limitation",
      {
        disposition: "inconclusive" as const,
        findings: [
          {
            kind: "evidence-limitation" as const,
            severity: "warning" as const,
            code: "pdf-tounicode-unavailable",
          },
        ],
      },
      ["evidence-limitation", "pdf-tounicode-unavailable"],
    ],
    [
      "blocked-dependency",
      {
        disposition: "blocked" as const,
        findings: [
          {
            kind: "blocked-dependency" as const,
            severity: "blocking" as const,
            code: "upstream-api-unreleased",
          },
        ],
        openDecisionKind: "dependency" as const,
      },
      ["blocked-dependency", "upstream-api-unreleased"],
    ],
  ])(
    "redirects a succeeded review %s wall when the retained findings projection is present",
    (_kind, options, codes) => {
      const saved = wallRecord({
        status: "succeeded",
        workflow: "review-documentation",
        ...options,
      });
      const retained = projection("complete", [], true);
      const withProjection = wallContext(saved, { reviewFindingsProjection: retained });
      expectRedirect(withProjection, codes);
      expect(buildRunHumanNextCommand(withProjection)?.reason).not.toContain(
        "Inspect the admitted findings and coverage limitations",
      );

      const withoutProjection = wallContext(saved);
      expectRedirect(withoutProjection, codes);
      expect(buildRunHumanNextCommand(withProjection)?.command).toBe(
        buildRunHumanNextCommand(withoutProjection)?.command,
      );
    },
  );

  it("keeps ordinary review report NEXT for product-gap findings with a retained projection", () => {
    const saved = wallRecord({
      status: "succeeded",
      workflow: "review-documentation",
      disposition: "not-ready",
      findings: [{ kind: "product-gap", severity: "blocking", code: "audit-documentation-gap" }],
    });
    const value = wallContext(saved, {
      reviewFindingsProjection: projection("complete", [], true),
    });
    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(STATE_DIR_SHOW);
    expect(action?.reason).toContain("Inspect the admitted findings and coverage limitations");
    expect(action?.reason).not.toContain("capability or policy wall");
    expectSelectedActionParity(value);
  });

  it("keeps the wall redirect on saved-run replay because it names no placeholder", () => {
    const value = wallContext(
      wallRecord({
        status: "succeeded",
        disposition: "inconclusive",
        findings: [
          { kind: "evidence-limitation", severity: "warning", code: "pdf-tounicode-unavailable" },
        ],
      }),
      { history: { resumability: { category: "non-resumable", reason: "succeeded" } as never } },
    );
    const action = buildRunHumanNextCommand(value);
    expect(action?.command).toBe(STATE_DIR_SHOW);
    expect(action?.reason).toContain("pdf-tounicode-unavailable");
  });

  it.each(["invalid-request", "provider-terminal"] as const)(
    "redirects a non-retryable %s inference wall without a retry argv or doctor",
    (category) => {
      const value = wallContext(failedInferenceRecord(category, false));
      const action = buildRunHumanNextCommand(value);
      expect(action?.command).toBe(STATE_DIR_SHOW);
      const human = formatRunSummary(value).join("\n");
      const json = collectRunResultNextSteps(value).join("\n");
      for (const output of [action!.reason, human, json]) {
        expect(output).toContain(`wall: ${category}`);
        expect(output).toContain("not missing input");
        expect(output).toContain("Do not retry the unchanged request.");
        expectNoWallForbiddenDoor(output);
      }
      expectSelectedActionParity(value);
    },
  );

  it("keeps the neighboring classes on their own doors", () => {
    const ready = wallContext(
      wallRecord({ status: "succeeded", disposition: "ready", findings: [] }),
    );
    expect(buildRunHumanNextCommand(ready)).toBeUndefined();
    expect(collectRunResultNextSteps(ready)).toEqual([]);

    const legacy = wallContext(record({ workflow: "create-documentation", changes: PATCH }));
    expect(buildRunHumanNextCommand(legacy)?.reason).toBe(
      "Inspect the saved product evidence and review the local patch before deciding whether to publish.",
    );

    const decision = buildRunHumanNextCommand(
      wallContext(
        wallRecord({
          status: "needs-human-decision",
          disposition: "blocked",
          findings: [{ kind: "blocked-dependency", severity: "blocking", code: "publish-scope" }],
          openDecisionKind: "human-decision",
        }),
      ),
    );
    expect(decision?.reason).toContain("Supply the open human decision decision:dependency");
    expect(decision?.reason).not.toContain("capability or policy wall");

    const transient = buildRunHumanNextCommand(
      wallContext(failedInferenceRecord("provider-transient", true)),
    );
    expect(transient?.reason).toContain("only after the provider condition clears");
    expect(transient?.reason).not.toContain("capability or policy wall");

    // A review job delivers product-gap findings about the reviewed docs; they
    // are its product, not a wall. Its evidence-limitation still redirects.
    const reviewGap = wallRecord({
      status: "succeeded",
      disposition: "not-ready",
      findings: [{ kind: "product-gap", severity: "blocking", code: "audit-documentation-gap" }],
    });
    reviewGap.workflow = "review-documentation";
    reviewGap.workflowOutcome = undefined;
    const reviewEvidence = workflowOutcomeStepEvidence(reviewGap, "plan-documentation");
    reviewGap.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "not-ready",
        findings: [
          {
            id: "finding:audit-documentation-gap",
            kind: "product-gap",
            severity: "blocking",
            code: "audit-documentation-gap",
            evidenceIds: [reviewEvidence.id],
          },
        ],
        evidence: [reviewEvidence],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      },
      reviewGap,
    );
    expect(buildRunHumanNextCommand(wallContext(reviewGap))).toBeUndefined();
  });
});

function humanDecisionCoverageOptions(): WorkflowOutcomeDecodeOptionsV1 {
  return {
    decodeWorkflowBranchCoverage: () =>
      ({
        schemaVersion: 1,
        kind: "docsfab-workflow-branch-coverage",
        workflow: "update-documentation",
        manifest: {},
        manifestSha256: "d".repeat(64),
        repositoryRevision: REVISION,
        workspaceSnapshotSha256: "e".repeat(64),
        selection: null,
        requiredStepIds: [],
        excludedStepIds: [],
        coverageSha256: "f".repeat(64),
      }) as WorkflowBranchCoverageV1,
  };
}

function coverageBackedHumanDecisionRecord(): RunRecord {
  const saved = record({
    workflow: "update-documentation",
    status: "needs-human-decision",
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-human-decision",
      },
    ],
  });
  const evidence = workflowOutcomeStepEvidence(saved, "plan-documentation");
  saved.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "blocked",
      findings: [
        {
          id: "finding:human-decision:publish-scope",
          kind: "blocked-dependency",
          severity: "blocking",
          code: "publish-scope",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [
        {
          id: "decision:publish-scope",
          kind: "human-decision",
          evidenceIds: [evidence.id],
        },
      ],
      producedArtifacts: [],
    },
    saved,
  );
  saved.workflowBranchCoverage = createWorkflowBranchCoverageV1({
    workflow: getWorkflow("update-documentation"),
    repositoryRevision: REVISION,
    workspaceSnapshotSha256: "e".repeat(64),
    selection: null,
  });
  return saved;
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
