// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
  type InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import {
  QualityArtifactValidationError,
  QualityDerivationError,
} from "../src/evaluation-report/quality-validator-host.js";
import type { QualityArtifactValidationBindingV1 } from "../src/records/contracts.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { admitQualityArtifactReply } from "../src/harness/reply-admission/quality-artifact.js";
import type { ReplyAdmissionContext } from "../src/harness/reply-admission/context.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { qualityCorrectionFailure } from "../src/workflow-execution/quality-correction-round.js";
import {
  evaluationRequiredKeyCorrection,
  isEchoableKeyName,
} from "../src/workflow-execution/quality-response-correction.js";
import { limit } from "../src/config/limits.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { verificationResultFixture } from "./helpers/verification.js";

/**
 * Rule-specific repairs for the final quality evaluator's retry: the keys an
 * object lacks or has undeclared, and the not-documented facts no finding
 * names. Each is driven from a real refusal through the real retry loop into
 * the real step prompt.
 */

const policy: InferenceRetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories: ["malformed-response"],
};

function evaluatorInput(): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  const step = workflow.steps.find((candidate) => candidate.id === "evaluate-document-quality")!;
  return { repositoryPath: "/tmp/repository", workflow, step };
}

/** Attempt 1 fails with `failure`; attempt 2 builds the real step prompt. */
async function feedbackAfter(failure: InferenceStepError): Promise<string> {
  const prompts: string[] = [];
  const execution = await executeInferenceStep({
    mode: "read-only",
    policy,
    sleep: async () => {},
    execute: async (attempt, responseCorrection) => {
      if (attempt === 1) throw failure;
      prompts.push(
        buildDocsFabStepPrompt({
          ...evaluatorInput(),
          inferenceAttempt: attempt,
          responseCorrection,
        }),
      );
      return { summary: "admitted" };
    },
  });
  expect(execution.status).toBe("succeeded");
  const prompt = prompts[0]!;
  return prompt.slice(prompt.indexOf("\n\nHost validation feedback for this bounded retry:"));
}

const qualityInput = {
  workflow: { name: "review-documentation", schemaVersion: 1, steps: [] },
  step: {
    id: "evaluate-document-quality",
    skill: "evaluate-document-quality",
    kind: "evaluate",
    mode: "read-only",
  },
  qualityProfileSelection: { selectionSha256: "a".repeat(64) },
} as unknown as HarnessStepInput;

function admissionFailure(reply: string): InferenceStepError {
  const context: ReplyAdmissionContext = {
    decodedResponse: reply,
    collectAttemptEvidence: () => ({}),
    refuseContractPlaceholder: () => undefined,
  };
  try {
    admitQualityArtifactReply(qualityInput, reply, context);
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("The reply was admitted.");
}

const REPORT = "# Documentation quality evaluation report\n\n## Findings\n\n- None.\n";

describe("quality envelope shape retries name the answer's keys", () => {
  it("names the missing answer key and the undeclared ones a wrong-keys object had", async () => {
    // The shape hosted Super returned: evaluation fields at the top level.
    const failure = admissionFailure(
      `${JSON.stringify({ target: {}, profile: {}, evaluation: {} })}\n\n${REPORT}`,
    );
    expect(failure.rejection).toEqual({ code: "quality-envelope-shape", location: "$" });
    const feedback = await feedbackAfter(failure);
    expect(feedback).toContain(
      "The leading JSON object must have exactly the keys evaluation and qualityScore. It lacks: qualityScore. It has keys the contract does not declare there: target, profile.",
    );
  });

  it("counts, without naming, an undeclared key that is not an identifier", async () => {
    const failure = admissionFailure(
      `${JSON.stringify({ evaluation: {}, qualityScore: null, "see the report below": 1 })}\n\n${REPORT}`,
    );
    const feedback = await feedbackAfter(failure);
    expect(feedback).toContain(
      "It has keys the contract does not declare there: 1 further key not shown.",
    );
    expect(feedback).not.toContain("see the report below");
  });

  it("counts, without naming, an undeclared key shaped like a credential", async () => {
    // Identifier-shaped, so only the shared credential screen keeps it out.
    const token = `ghp_${"a".repeat(36)}`;
    const awsKey = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    const failure = admissionFailure(
      `${JSON.stringify({ evaluation: {}, qualityScore: null, [token]: 1, [awsKey]: 2 })}\n\n${REPORT}`,
    );
    const feedback = await feedbackAfter(failure);
    expect(feedback).toContain(
      "It has keys the contract does not declare there: 2 further keys not shown.",
    );
    expect(feedback).not.toContain(token);
    expect(feedback).not.toContain(awsKey);
  });

  it("names at most as many undeclared keys as the answer declares, and counts the rest", async () => {
    const failure = admissionFailure(
      `${JSON.stringify({ target: {}, profile: {}, rubric: {}, evaluation: {} })}\n\n${REPORT}`,
    );
    const feedback = await feedbackAfter(failure);
    expect(feedback).toContain(
      "It has keys the contract does not declare there: target, profile, and 1 further key not shown.",
    );
  });

  it("adds no key repair to a shape refusal that read no object", async () => {
    // Adjacent: several fenced JSON blocks are refused at `$` with no keys.
    const reply = `\`\`\`json\n{"evaluation": {}, "qualityScore": null}\n\`\`\`\n\n\`\`\`json\n{"note": 1}\n\`\`\``;
    const failure = admissionFailure(reply);
    expect(failure.rejection).toEqual({ code: "quality-envelope-shape", location: "$" });
    const feedback = await feedbackAfter(failure);
    expect(feedback).not.toContain("The leading JSON object must have exactly the keys");
  });
});

function validationFailure(
  code: string,
  location: string,
  evaluation: Record<string, unknown>,
  technicalVerification?: ReturnType<typeof verificationResultFixture>,
): InferenceStepError {
  const refusal = new QualityArtifactValidationError(
    "evaluation-invalid",
    { status: "failed" } as unknown as QualityArtifactValidationBindingV1,
    "# Retained evaluator report",
    { validator: "evaluation", code, location, issueCount: 1 },
  );
  const result = {
    summary: "# Retained evaluator report",
    qualityArtifactCandidate: {
      evaluation,
      qualityScore: null,
      reportMarkdown: "# Retained evaluator report",
      selectionSha256: "a".repeat(64),
    },
  } as unknown as HarnessStepResult;
  const failure = qualityCorrectionFailure(refusal, result, technicalVerification);
  expect(failure).toBeInstanceOf(InferenceStepError);
  return failure!;
}

const LAYER = {
  decision: "insufficient-evidence",
  confidence: 0,
  hard_gate_failures: [],
  limitations: [],
};

describe("required-key retries name an undeclared key beside the missing one", () => {
  it("keeps a locked deriver fault terminal instead of retrying it as model content", () => {
    const failure = new QualityDerivationError("deriver-exit");
    expect(qualityCorrectionFailure(failure, {} as HarnessStepResult)).toBeUndefined();
  });

  it("carries response byte observations when a successful harness result is reconstructed as a correction failure", () => {
    const providerResponses = {
      schemaVersion: 1 as const,
      state: "complete" as const,
      observations: [
        {
          requestSequence: 1,
          disposition: "complete" as const,
          observedBytes: 128,
          httpStatus: 200,
        },
      ],
      pendingRequestSequences: [],
    };
    const efficiency = {
      schemaVersion: 1 as const,
      requests: [{ requestSequence: 1, turn: 1, bodyBytes: 123, bodySha256: "e".repeat(64) }],
      sourceReuse: null,
    };
    const refusal = new QualityArtifactValidationError(
      "evaluation-invalid",
      { status: "failed" } as unknown as QualityArtifactValidationBindingV1,
      "# Retained evaluator report",
      {
        validator: "evaluation",
        code: "evaluation-schema-required",
        location: "$.layers",
        issueCount: 1,
      },
    );
    const failure = qualityCorrectionFailure(refusal, {
      summary: "# Retained evaluator report",
      providerResponses,
      efficiency,
      qualityArtifactCandidate: {
        evaluation: { layers: {} },
        qualityScore: null,
        reportMarkdown: "# Retained evaluator report",
        selectionSha256: "a".repeat(64),
      },
    } as unknown as HarnessStepResult);

    expect(failure?.evidence?.providerResponses).toEqual(providerResponses);
    expect(failure?.evidence?.efficiency).toEqual(efficiency);
  });

  it("names the missing dimensions key and the undeclared key the layer has instead", async () => {
    // Hosted Super wrote `dim` for `dimensions` in seven of eight evaluations.
    const failure = validationFailure(
      "evaluation-schema-required",
      "$.layers.transferable_understanding.dimensions",
      { layers: { transferable_understanding: { ...LAYER, dim: [] } } },
    );
    const feedback = await feedbackAfter(failure);
    expect(feedback).toContain(
      "The required key dimensions is missing at evaluation.layers.transferable_understanding, and that object has a key the schema does not declare. It has keys the contract does not declare there: dim. Write the required key in full, spelled exactly as the schema spells it, in place of the undeclared one.",
    );
  });

  it("adds nothing when the object lacks the key but has no undeclared one", async () => {
    // Adjacent: a plain omission keeps the schema's required-key list only.
    const failure = validationFailure(
      "evaluation-schema-required",
      "$.layers.transferable_understanding.dimensions",
      { layers: { transferable_understanding: { ...LAYER } } },
    );
    const feedback = await feedbackAfter(failure);
    expect(feedback).toContain(
      "The locked evaluation schema requires these keys at evaluation.layers.transferable_understanding",
    );
    expect(feedback).not.toContain("does not declare");
  });

  it("adds nothing where the location crosses an array", async () => {
    const failure = validationFailure(
      "evaluation-schema-required",
      "$.layers.trustworthy_information.dimensions[].measures[].interpretation",
      {
        layers: {
          trustworthy_information: {
            ...LAYER,
            dimensions: [{ measures: [{ metric_id: "m", value: 1, method: "x", note: "y" }] }],
          },
        },
      },
    );
    const feedback = await feedbackAfter(failure);
    expect(feedback).not.toContain("does not declare");
  });
});

describe("missing fact-id retries name the facts no finding names", () => {
  function omittedFactVerification() {
    const verification = structuredClone(verificationResultFixture(["README.md"]));
    verification.factInventory.dimensions[0]!.facts[0]!.documentationDisposition = "omitted";
    return verification;
  }

  it("lists the not-documented fact IDs from the admitted technical verification", async () => {
    const verification = omittedFactVerification();
    const factId = verification.factInventory.dimensions[0]!.facts[0]!.id;
    const failure = validationFailure(
      "technical-trace-missing-fact-id",
      "$.findings",
      { findings: [], limitations: [...verification.factInventory.limitations] },
      verification,
    );
    const feedback = await feedbackAfter(failure);
    expect(feedback).toContain(
      `No finding names these facts that the admitted technical verification lists as not documented: ${factId}. Write each fact ID exactly as the technical verification spells it.`,
    );
  });

  it("adds no fact list when no verification is bound, or the findings name the fact", async () => {
    const verification = omittedFactVerification();
    const factId = verification.factInventory.dimensions[0]!.facts[0]!.id;
    const unbound = await feedbackAfter(
      validationFailure("technical-trace-missing-fact-id", "$.findings", { findings: [] }),
    );
    expect(unbound).not.toContain("No finding names these facts");
    // Adjacent: the fact is named, so the trace check finds no missing fact ID.
    const named = await feedbackAfter(
      validationFailure(
        "technical-trace-missing-fact-id",
        "$.findings",
        { findings: [{ id: factId }], limitations: [] },
        verification,
      ),
    );
    expect(named).not.toContain("No finding names these facts");
  });
});

describe("quality repairs are readmitted beside their own refusal only", () => {
  const keySet = {
    kind: "quality-key-set",
    missing: ["dimensions"],
    undeclared: ["dim"],
    withheldCount: 0,
  } as const;

  it("drops a fact-ID repair forged beside any other code", () => {
    const factIds = {
      kind: "quality-trace-fact-ids",
      factIds: ["FACT-1"],
      withheldCount: 0,
    } as const;
    const beside = (code: string) =>
      responseCorrectionInstruction(
        { rejection: { code, location: "$.findings" }, detail: factIds },
        evaluatorInput(),
      );
    for (const code of [
      "technical-trace-missing-issue-id",
      "technical-trace-missing-uncertainty",
      "evaluation-schema-required",
    ]) {
      expect(beside(code), code).not.toContain("No finding names these facts");
    }
    // Positive control: beside its own code the repair is stated.
    expect(beside("technical-trace-missing-fact-id")).toContain(
      "No finding names these facts that the admitted technical verification lists as not documented: FACT-1.",
    );
  });

  it("builds no required-key repair for an object without an undeclared key", () => {
    expect(
      evaluationRequiredKeyCorrection(
        {
          code: "evaluation-schema-required",
          location: "$.layers.transferable_understanding.dimensions",
        },
        { layers: { transferable_understanding: { ...LAYER } } },
      ),
    ).toBeUndefined();
  });

  it("drops a key-set repair forged beside another schema code or location", () => {
    // A shape repair whose keys are valid answer vocabulary, beside a shape
    // refusal at a member rather than at `$`.
    const shapeRepair = {
      kind: "quality-key-set",
      missing: ["qualityScore"],
      undeclared: ["target"],
      withheldCount: 0,
    } as const;
    const shapeAt = (location: string, detail: object) =>
      responseCorrectionInstruction(
        { rejection: { code: "quality-envelope-shape", location }, detail },
        evaluatorInput(),
      );
    expect(shapeAt("$.evaluation", shapeRepair)).not.toContain(
      "The leading JSON object must have exactly the keys",
    );
    expect(shapeAt("$", shapeRepair)).toContain(
      "The leading JSON object must have exactly the keys",
    );
    // A credential-shaped name forged into a repair is dropped with the repair.
    expect(shapeAt("$", { ...shapeRepair, undeclared: [`ghp_${"a".repeat(36)}`] })).not.toContain(
      "ghp_",
    );
    for (const rejection of [
      {
        code: "evaluation-schema-enum",
        location: "$.layers.transferable_understanding.dimensions",
      },
      { code: "quality-envelope-shape", location: "$.evaluation" },
      {
        code: "evaluation-schema-required",
        location: "$.layers.transferable_understanding.decision",
      },
    ]) {
      const text = responseCorrectionInstruction({ rejection, detail: keySet }, evaluatorInput());
      expect(text, `${rejection.code} ${rejection.location}`).not.toContain("does not declare");
    }
    // Positive control: the same repair beside its own refusal is stated.
    expect(
      responseCorrectionInstruction(
        {
          rejection: {
            code: "evaluation-schema-required",
            location: "$.layers.transferable_understanding.dimensions",
          },
          detail: keySet,
        },
        evaluatorInput(),
      ),
    ).toContain("It has keys the contract does not declare there: dim.");
  });
});

describe("reply key names a retry may repeat", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const awsKey = "AKIAIOSFODNN7EXAMPLE";

  it("names plain identifier keys, including long schema-like ones", () => {
    for (const key of [
      "dim",
      "limitings",
      "target",
      "human_agent_representation_parity",
      "dimension_id",
    ]) {
      expect(isEchoableKeyName(key), key).toBe(true);
    }
  });

  it("counts a key that hides a token inside an identifier", () => {
    // The shared detector anchors at word boundaries, and `_` is a word
    // character, so each of these passes a whole-key check.
    for (const key of [`x_${token}`, `${awsKey}_x`, `x_${awsKey}`, `${token}_x`]) {
      expect(isEchoableKeyName(key), key).toBe(false);
    }
  });

  it("counts a key with a long segment that mixes letters and digits", () => {
    const at = limit("inference.echoedKeySegmentRandomChars").value;
    const random = `a1${"b2".repeat(at)}`.slice(0, at);
    expect(isEchoableKeyName(random)).toBe(false);
    expect(isEchoableKeyName(`field_${random}`)).toBe(false);
    // A 40-character secret-like key and a 64-character hex-like key.
    expect(isEchoableKeyName("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYab")).toBe(false);
    expect(isEchoableKeyName("a3f9".repeat(16))).toBe(false);
    // Adjacent: one character shorter, or letters only, stays a name.
    expect(isEchoableKeyName(random.slice(0, -1))).toBe(true);
    expect(isEchoableKeyName("b".repeat(at * 2))).toBe(true);
  });
});
