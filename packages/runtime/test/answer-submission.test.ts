// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The tool-call answer path's pure parts (#1707): the submission decoder, the
 * report rules mapped onto the submission's codes, retry repair, the one
 * answer-path resolver, the parameter shell, the members-first cut
 * completion, compaction of the submission group, the operator option, and
 * the doctor line.
 */
import { describe, expect, it } from "vitest";

import {
  AnswerSubmissionOptionError,
  parseAnswerSubmissionOption,
} from "../src/config/answer-submission.js";
import {
  OUTPUT_HOST_TEXT,
  OUTPUT_RULE_FAMILIES,
  OUTPUT_RULES,
} from "../src/contracts/model-output.generated.js";
import { answerSubmissionLine } from "../src/doctor.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  QUALITY_SUBMISSION_TOOL_NAME,
  buildSubmissionShell,
  resolveAnswerPath,
} from "../src/harness/answer-submission.js";
import {
  hostCompleteCutQualityReport,
  hostCompleteCutQualityReportFromMembers,
  type CutJudgmentAnswer,
} from "../src/harness/cut-judgment.js";
import { bindQualityArtifactResponseContract } from "../src/harness/editorial-response-contract.js";
import { grantedToolsForStep } from "../src/harness/pi-tool-confine.js";
import {
  QualityArtifactEnvelopeError,
  admitSubmittedQualityArtifact,
  decodeQualityArtifactResponse,
  decodeQualitySubmission,
  qualitySubmissionParameters,
} from "../src/harness/quality-candidate-tool.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import { resolveTurnRecoveryPolicy } from "../src/model/turn-recovery-policy.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { RECORDED_CAPABILITY } from "./support/answer-submission-fixtures.js";

const SELECTION = { selectionSha256: "a".repeat(64) } as NonNullable<
  HarnessStepInput["qualityProfileSelection"]
>;
const EVALUATION = { evaluation_id: "eval-1", overall_decision: "insufficient-evidence" };
const MEMBERS = { evaluation: EVALUATION, qualityScore: null };
const REPORT = "# Documentation quality evaluation report\n\n## Findings\n\n- None.";

function refusalOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof QualityArtifactEnvelopeError) return error.rejection;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

describe("decodeQualitySubmission", () => {
  it.each([
    ["missing text", undefined, { code: "quality-submission-json", location: "$" }],
    ["empty text", "  ", { code: "quality-submission-json", location: "$" }],
    [
      "a duplicate key inside evaluation",
      '{"evaluation":{"a":1,"a":2},"qualityScore":null}',
      { code: "quality-submission-duplicate-key", location: "$.evaluation" },
    ],
    [
      "a duplicate top-level key",
      '{"evaluation":{"a":1},"qualityScore":null,"qualityScore":null}',
      { code: "quality-submission-duplicate-key", location: "$.qualityScore" },
    ],
    [
      "a raw line break in a string",
      '{"evaluation":{"a":"x\ny"},"qualityScore":null}',
      { code: "quality-submission-json", location: "$.evaluation" },
    ],
    [
      "trailing text",
      '{"evaluation":{"a":1},"qualityScore":null}}',
      { code: "quality-submission-json", location: "$" },
    ],
    [
      "a break inside qualityScore",
      '{"evaluation":{"a":1},"qualityScore":{"x":}}',
      { code: "quality-submission-json", location: "$.qualityScore" },
    ],
    ["an array root", "[1,2]", { code: "quality-submission-shape", location: "$" }],
    ["a string root", '"str"', { code: "quality-submission-shape", location: "$" }],
    [
      "a reportMarkdown argument",
      '{"evaluation":{},"qualityScore":null,"reportMarkdown":"# R"}',
      { code: "quality-submission-shape", location: "$" },
    ],
    [
      "a missing qualityScore",
      '{"evaluation":{}}',
      { code: "quality-submission-shape", location: "$" },
    ],
    [
      "a double-encoded evaluation",
      '{"evaluation":"\\"{}\\"","qualityScore":null}',
      { code: "quality-submission-shape", location: "$.evaluation" },
    ],
    [
      "an array evaluation",
      '{"evaluation":[],"qualityScore":null}',
      { code: "quality-submission-shape", location: "$.evaluation" },
    ],
    [
      "qualityScore false",
      '{"evaluation":{},"qualityScore":false}',
      { code: "quality-submission-shape", location: "$.qualityScore" },
    ],
  ])("refuses %s", (_name, raw, rejection) => {
    expect(refusalOf(() => decodeQualitySubmission(raw))).toEqual(rejection);
  });

  it("carries the received keys of a root shape refusal for the retry repair", () => {
    try {
      decodeQualitySubmission('{"evaluation":{},"qualityScore":null,"reportMarkdown":"# R"}');
    } catch (error) {
      expect((error as QualityArtifactEnvelopeError).receivedKeys).toEqual([
        "evaluation",
        "qualityScore",
        "reportMarkdown",
      ]);
      return;
    }
    throw new Error("Expected a refusal.");
  });

  it("admits strict JSON with an object evaluation and a null or object score", () => {
    expect(decodeQualitySubmission(JSON.stringify(MEMBERS))).toEqual({
      ...MEMBERS,
      memberEncoding: { evaluation: "object", qualityScore: "null" },
      innerBytes: 0,
    });
    expect(
      decodeQualitySubmission(JSON.stringify({ evaluation: EVALUATION, qualityScore: { s: 1 } })),
    ).toEqual({
      evaluation: EVALUATION,
      qualityScore: { s: 1 },
      memberEncoding: { evaluation: "object", qualityScore: "object" },
      innerBytes: 0,
    });
  });
});

describe("the report rules on the submitted answer", () => {
  it.each([
    ["an empty report", "", "quality-submission-report"],
    ["text before the heading", `Here is the report.\n${REPORT}`, "quality-submission-report"],
    // The text answer JSON-continuation rule is subsumed by heading-first.
    ["more JSON instead of a report", ',"reportMarkdown":"# R"}', "quality-submission-report"],
    [
      "an open code block",
      `${REPORT}\n\n\`\`\`\n- code\n\nMore text`,
      "quality-submission-report-fence",
    ],
    [
      "an answer member in the text",
      `${REPORT}\n\n"evaluation": {"a": 1}`,
      "quality-submission-report-member",
    ],
    [
      "an object opening on an answer member",
      `${REPORT}\n\nSee {"qualityScore": null} below.`,
      "quality-submission-report-member",
    ],
    [
      "a whole envelope inside a code block",
      `${REPORT}\n\n\`\`\`json\n${JSON.stringify({ evaluation: EVALUATION, qualityScore: null, reportMarkdown: "# R" })}\n\`\`\``,
      "quality-submission-report-envelope",
    ],
  ])("refuses %s with its own code", (_name, report, code) => {
    expect(refusalOf(() => admitSubmittedQualityArtifact(MEMBERS, report, SELECTION))).toEqual({
      code,
      location: "$.reportMarkdown",
    });
  });

  it("drops a stray closing fence the way the text answer does", () => {
    const submitted = admitSubmittedQualityArtifact(MEMBERS, `${REPORT}\n\`\`\`\n`, SELECTION);
    expect(submitted.reportMarkdown).toBe(REPORT);
    expect(submitted).toEqual(
      decodeQualityArtifactResponse(`${JSON.stringify(MEMBERS)}\n\n${REPORT}\n\`\`\`\n`, SELECTION),
    );
  });

  it("stores exactly the candidate the text answer stores for the same members and report", () => {
    const report =
      '# Report\n\nA "quoted" {brace} and ```inline``` code.\n\n```text\n{"x": 1}\n```';
    expect(JSON.stringify(admitSubmittedQualityArtifact(MEMBERS, report, SELECTION))).toBe(
      JSON.stringify(
        decodeQualityArtifactResponse(`${JSON.stringify(MEMBERS)}\n${report}`, SELECTION),
      ),
    );
  });

  it("leaves the text answer's own codes unchanged", () => {
    expect(
      refusalOf(() =>
        decodeQualityArtifactResponse(
          `${JSON.stringify(MEMBERS)},"reportMarkdown":"# R"}`,
          SELECTION,
        ),
      ),
    ).toEqual({ code: "quality-envelope-json-after-object", location: "$" });
  });
});

describe("the quality-submission catalog family", () => {
  const codes = Object.values(OUTPUT_RULES).filter((rule) => rule.family === "quality-submission");

  it("declares every code model-correctable under the read-only replay", () => {
    expect(codes.map((rule) => rule.code).sort()).toEqual(
      [
        "quality-submission-cut",
        "quality-submission-duplicate-key",
        "quality-submission-json",
        "quality-submission-missing",
        "quality-submission-report",
        "quality-submission-report-envelope",
        "quality-submission-report-fence",
        "quality-submission-report-member",
        "quality-submission-shape",
      ].sort(),
    );
    for (const rule of codes) expect(rule.retry, rule.code).toBe("model-correctable");
    expect(OUTPUT_RULE_FAMILIES["quality-submission"].replay).toBe("read-only");
  });

  it("names the submission tool in the retry repair for a root shape refusal", () => {
    const instruction = responseCorrectionInstruction({
      rejection: { code: "quality-submission-shape", location: "$" },
      detail: {
        kind: "quality-key-set",
        missing: ["qualityScore"],
        undeclared: ["reportMarkdown"],
        withheldCount: 0,
      },
    });
    expect(instruction).toContain(OUTPUT_RULES["quality-submission-shape"].atLocation.$);
    expect(instruction).toContain(
      `The ${QUALITY_SUBMISSION_TOOL_NAME} arguments must have exactly the keys evaluation and qualityScore. They lack: qualityScore. They have arguments the tool does not declare: reportMarkdown.`,
    );
  });
});

describe("resolveAnswerPath", () => {
  const workflow = getWorkflow("review-documentation");
  const step = workflow.steps.find((entry) => entry.skill === "evaluate-document-quality")!;
  const base = {
    capability: RECORDED_CAPABILITY,
    option: "recorded" as const,
    workflow,
    step,
    qualityBound: true,
    toolCeiling: undefined,
  };

  it("takes the tool call on a recorded route", () => {
    expect(resolveAnswerPath(base)).toEqual({ path: "tool-call", reason: "recorded-route" });
  });

  it("keeps the text answer for each other reason", () => {
    expect(resolveAnswerPath({ ...base, capability: undefined })).toEqual({
      path: "text-final",
      reason: "not-recorded",
    });
    expect(resolveAnswerPath({ ...base, toolCeiling: ["read", "grep"] })).toEqual({
      path: "text-final",
      reason: "tool-not-granted",
    });
    expect(resolveAnswerPath({ ...base, option: "text-final" })).toEqual({
      path: "text-final",
      reason: "operator-override",
    });
    expect(
      resolveAnswerPath({ ...base, toolCeiling: ["read", QUALITY_SUBMISSION_TOOL_NAME] }),
    ).toEqual({ path: "tool-call", reason: "recorded-route" });
  });

  it("resolves nothing for a step with no tool-call answer form", () => {
    expect(resolveAnswerPath({ ...base, step: workflow.steps[0]! })).toBeUndefined();
    expect(resolveAnswerPath({ ...base, qualityBound: false })).toBeUndefined();
  });

  it("feeds one result to the tool grant and the response contract", () => {
    const resolved = resolveAnswerPath(base);
    const grant = (answerSubmission: typeof resolved) =>
      grantedToolsForStep(
        workflow,
        step,
        true,
        false,
        false,
        false,
        false,
        undefined,
        answerSubmission,
      );
    expect(grant(resolved)).toContain(QUALITY_SUBMISSION_TOOL_NAME);
    expect(grant({ path: "text-final", reason: "not-recorded" })).not.toContain(
      QUALITY_SUBMISSION_TOOL_NAME,
    );
    const input = {
      workflow,
      step,
      repositoryPath: "/workspace",
      qualityProfileSelection: { ...SELECTION, profileAssetPath: "profiles/p.json" },
    } as unknown as HarnessStepInput;
    const toolPrompt = bindQualityArtifactResponseContract({ ...input, answerSubmission: resolved })
      .step.prompt;
    expect(toolPrompt).toContain(OUTPUT_HOST_TEXT["quality-submission-contract-call"]);
    // The text answer's contract is byte for byte the one it had before.
    expect(
      bindQualityArtifactResponseContract({
        ...input,
        answerSubmission: { path: "text-final", reason: "operator-override" },
      }).step.prompt,
    ).toBe(bindQualityArtifactResponseContract(input).step.prompt);
  });
});

describe("the submission's parameter shell", () => {
  it("gives the untyped shell only descriptions, and the typed shell types, never required keys", () => {
    const untyped = qualitySubmissionParameters(
      { ...SELECTION, profileAssetPath: "profiles/p.json", profilePayloadSha256: "c".repeat(64) },
      "untyped",
    );
    expect(Object.keys(untyped.properties)).toEqual(["evaluation", "qualityScore"]);
    expect(untyped.properties.evaluation).toEqual({
      description: expect.stringContaining(`quality/profiles/p.json (sha256 ${"c".repeat(64)})`),
    });
    expect(untyped).not.toHaveProperty("required");
    expect(untyped).not.toHaveProperty("additionalProperties");
    const typed = buildSubmissionShell({
      keys: ["evaluation", "qualityScore"],
      argumentShell: "typed",
      descriptions: { evaluation: "e", qualityScore: "q" },
      types: { evaluation: "object", qualityScore: ["object", "null"] },
    });
    expect(typed.properties).toEqual({
      evaluation: { type: "object", description: "e" },
      qualityScore: { type: ["object", "null"], description: "q" },
    });
  });
});

describe("a report cut after an admitted submission", () => {
  it("is completed exactly as the text answer's cut with the same complete members", () => {
    const partial = "# Report\n\nThe report was cut";
    const cut: CutJudgmentAnswer = {
      shape: "text-truncated",
      stitched: partial,
      finalCut: partial,
      continuationTurns: 1,
      outputTokenLimit: 16_384,
      answerOutputTokens: 20_000,
    };
    const textCut = { ...cut, stitched: `${JSON.stringify(MEMBERS)}\n\n${partial}` };
    expect(hostCompleteCutQualityReportFromMembers(cut, MEMBERS).reply).toBe(
      hostCompleteCutQualityReport(textCut, undefined)!.reply,
    );
  });
});

describe("compaction before the report turn", () => {
  it("keeps the submission's tool group verbatim at the recovery policy's recent-turn floor", () => {
    const { minRecentToolTurns } = resolveTurnRecoveryPolicy(128);
    const read = (id: string, text: string) => [
      {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.md` } }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 2,
      },
    ];
    const submitCall = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "submit-1",
          name: QUALITY_SUBMISSION_TOOL_NAME,
          arguments: MEMBERS,
        },
      ],
      timestamp: 3,
    };
    const ack = {
      role: "toolResult",
      toolCallId: "submit-1",
      toolName: QUALITY_SUBMISSION_TOOL_NAME,
      content: [{ type: "text", text: OUTPUT_HOST_TEXT["quality-submission-acknowledgement"] }],
      isError: false,
      timestamp: 4,
    };
    const ask = { role: "user", content: OUTPUT_HOST_TEXT["quality-submission-report-ask"] };
    const decision = governProviderTurn({
      context: {
        systemPrompt: "bounded",
        messages: [
          { role: "user", content: "pinned request" },
          ...read("read-a", "evidence ".repeat(600)),
          submitCall,
          ack,
          ask,
        ],
      },
      policy: {
        maxProviderTurns: 8,
        maxToolCalls: 12,
        maxCompactions: 2,
        minRecentToolTurns,
        budget: {
          configuredContextWindow: 128_000,
          effectiveContextWindow: 1_600,
          configuredMaxInputTokens: 128_000,
          effectiveMaxInputTokens: 1_600,
          configuredMaxOutputTokens: 4_096,
          effectiveMaxOutputTokens: 256,
          reservedTokens: 64,
          requiredMinimumOutputTokens: 16,
        },
      },
      state: { providerTurns: 2, toolCalls: 2, toolResults: 2, compactions: 0 },
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      pinnedMessageCount: 1,
      toolEvidence: [
        { toolCallId: "read-a", toolName: "read", outcome: "succeeded", citations: ["read-a.md"] },
        {
          toolCallId: "submit-1",
          toolName: QUALITY_SUBMISSION_TOOL_NAME,
          outcome: "succeeded",
          citations: [],
        },
      ],
    });

    expect(minRecentToolTurns).toBeGreaterThanOrEqual(1);
    expect(decision.evidence.decision).toBe("compact");
    expect(decision.nextState.removedToolCallIds).toEqual(["read-a"]);
    expect(decision.context.messages).toContainEqual(submitCall);
    expect(decision.context.messages).toContainEqual(ack);
    expect(decision.context.messages.at(-1)).toEqual(ask);
  });
});

describe("DOCSFAB_ANSWER_SUBMISSION", () => {
  it("defaults to recorded and admits the two closed options", () => {
    expect(parseAnswerSubmissionOption({})).toBe("recorded");
    expect(parseAnswerSubmissionOption({ DOCSFAB_ANSWER_SUBMISSION: " " })).toBe("recorded");
    expect(parseAnswerSubmissionOption({ DOCSFAB_ANSWER_SUBMISSION: "text-final" })).toBe(
      "text-final",
    );
    expect(parseAnswerSubmissionOption({ DOCSFAB_ANSWER_SUBMISSION: "recorded" })).toBe("recorded");
  });

  it("refuses any other value by name", () => {
    let caught: unknown;
    try {
      parseAnswerSubmissionOption({ DOCSFAB_ANSWER_SUBMISSION: "tool-call" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AnswerSubmissionOptionError);
    expect((caught as AnswerSubmissionOptionError).code).toBe("answer-submission-option-invalid");
    expect((caught as Error).message).toContain("recorded, text-final");
  });

  it("is printed by doctor with the route's capability and the path that follows", () => {
    expect(answerSubmissionLine(undefined, RECORDED_CAPABILITY)).toBe(
      "Answer submission: DOCSFAB_ANSWER_SUBMISSION=recorded; route recorded (host-tool-call, untyped arguments, duplicate keys forwarded, report tool_choice none); the final quality evaluator answers by tool-call (recorded-route)",
    );
    expect(answerSubmissionLine("text-final", RECORDED_CAPABILITY)).toContain(
      "answers by text-final (operator-override)",
    );
    expect(answerSubmissionLine("recorded", undefined)).toContain(
      "route not-recorded; the final quality evaluator answers by text-final (not-recorded)",
    );
  });
});
