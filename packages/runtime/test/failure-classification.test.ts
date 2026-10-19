// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every failure carries exactly one class from the closed vocabulary, plus its
 * layer and the catalogued code the class was read from.
 *
 * The drift half requires a class for every closed code set a failure can
 * carry, so a code added without one fails here. The surface half drives the
 * shipped runner, store, footer, `runs show --json`, and the operator envelope,
 * and asserts the class an operator sees.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { SOURCES_CLI_REFUSAL_CODES } from "../src/cli/commands/sources.js";
import { DO_SOURCE_ROUTE_REFUSAL_CODES } from "../src/cli/commands/do.js";
import { DELIVERY_FLAG_REFUSAL_CODES } from "../src/cli/delivery-grants.js";
import {
  RUN_OPTION_REFUSAL_CODES,
  SELECTOR_OPTION_REFUSAL_CODES,
  SOURCE_OPTION_REFUSAL_CODES,
} from "../src/cli/run-arguments.js";
import {
  QUALITY_CHECK_INTEGRITY_CODES,
  QUALITY_CHECK_REJECTION_CODES,
  QUALITY_VALIDATOR_UNAVAILABLE_CODES,
  QualityStepRejectionError,
  hostCheckRejection,
  qualityCandidateAdmissionError,
} from "../src/evaluation-report/quality-check-rejections.js";
import { QualityDerivationError } from "../src/evaluation-report/quality-validator-host.js";
import { EVALUATION_DIAGNOSTIC_CODES } from "../src/evaluation-report/quality-validation-rejection.js";
import type { AgentHarness, InferenceRetryPolicy } from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { EDITORIAL_ENVELOPE_SHAPE_REJECTION } from "../src/harness/pi.js";
import { RESPONSE_REJECTION_RULE_HINTS } from "../src/harness/response-correction.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import { INFERENCE_FAILURE_CATEGORIES } from "../src/inference-attempt-taxonomy.js";
import { INIT_CONFIGURATION_ROOT_REFUSAL_CODES } from "../src/init/storage.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import {
  toOperatorErrorEnvelope,
  formatOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import {
  FAILURE_CLASSES,
  FAILURE_CLASS_MEANINGS,
  FAILURE_LAYERS,
  OPERATOR_CODE_FAMILY_FAILURE_CLASSES,
  QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES,
  RUN_FAILURE_CODE_CLASSES,
  attachRunFailureClassifications,
  classifyInferenceAttempt,
  classifyInferenceFailure,
  classifyQualityValidationFailure,
  classifyStepFailure,
  classifyThrownFailure,
  inferenceRejectionFailureClass,
  markRunRefusal,
  operatorCodeFailureClass,
  projectRunFailureOccurrences,
  readFailureClassification,
  readRunFailure,
  readStepFailure,
} from "../src/operator/failure-classification.js";
import {
  REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY,
  RepositoryBootstrapResultError,
} from "../src/onboarding/bootstrap-result.js";
import {
  FIRST_PASS_FAILURE_RULES,
  classifyFirstPassFailure,
  firstPassRuleFailureClass,
  renderPreRecordFailure,
} from "../src/operator/pre-record-failure.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import { SITUATION_CATALOG } from "../src/operator/situation-catalog.js";
import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import { CompositionExecutionEvidenceError } from "../src/records/composition-execution.js";
import { CompositionExecutionEvidenceError as CompositionExecutionErrorLeaf } from "../src/records/composition-execution-error.js";
import { FileRunStore } from "../src/records/file-store.js";
import { REPOSITORY_CONFIGURATION_REFUSAL_CODES } from "../src/repository/workspace/configuration-refusal.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import type { RepositorySecurityScanner, SecurityScanReport } from "../src/security/contracts.js";
import {
  ISSUE_JUDGMENT_VOCABULARY_REJECTIONS,
  TECHNICAL_REVIEW_REJECTION_CODES,
  UNKNOWN_OBLIGATION_LINK_REJECTION,
} from "../src/workflow-execution/review-response.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { SOURCE_OBLIGATION_REJECTION_CODES } from "../src/workflow-execution/source-obligation.js";
import { readyContextPreflight } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

describe("failure class vocabulary (#1186)", () => {
  it.each([
    ["bound", "fact-inventory-limitations-exceeded", "The health-check timed out."],
    ["unknown", "uncatalogued-review-failure", "The network connection is documented."],
  ] as const)("keeps a recorded %s step failure despite report prose", (kind, code, summary) => {
    const failure = { class: kind, layer: "inference", code };
    const step = {
      id: "review",
      status: "failed",
      failure,
      error: "The recorded error has no safe presentation.",
      summary,
    } as unknown as StepRunRecord;
    expect(readStepFailure(step)).toEqual(failure);
  });

  it("gives every class a meaning and keeps the vocabulary closed", () => {
    expect(Object.keys(FAILURE_CLASS_MEANINGS).sort()).toEqual([...FAILURE_CLASSES].sort());
    expect(FAILURE_LAYERS).toEqual(["cli", "workflow", "inference", "host", "harness"]);
    expect(
      readFailureClassification({ class: "flake", layer: "inference", code: "throttled" }),
    ).toEqual({ class: "flake", layer: "inference", code: "throttled" });
    for (const tampered of [
      { class: "transient", layer: "inference", code: "throttled" },
      { class: "flake", layer: "provider", code: "throttled" },
      { class: "flake", layer: "inference", code: "Throttled!" },
      { class: "flake", layer: "inference", code: "throttled", extra: true },
      { class: "flake", layer: "inference" },
    ]) {
      expect(readFailureClassification(tampered), JSON.stringify(tampered)).toBeNull();
    }
  });
});

describe("every catalogued code has a class (#1186 drift)", () => {
  it("classes every situation catalog row, and shared ids agree", () => {
    const byId = new Map<string, string>();
    for (const row of SITUATION_CATALOG) {
      expect(FAILURE_CLASSES, row.id).toContain(row.failureClass);
      const prior = byId.get(row.id);
      if (prior !== undefined) expect(row.failureClass, row.id).toBe(prior);
      byId.set(row.id, row.failureClass);
      expect(operatorCodeFailureClass(row.id), row.id).toBe(row.failureClass);
    }
  });

  it("classes every inference category", () => {
    for (const category of INFERENCE_FAILURE_CATEGORIES) {
      const failure = classifyInferenceFailure({
        category,
        ...(category === "host-runtime-failure"
          ? {
              hostFailureOrigin: {
                schemaVersion: 1 as const,
                origin: "execution-lease-coordinator" as const,
                code: "invalid-execution-lease-coordinator" as const,
              },
            }
          : {}),
      });
      expect(failure, category).toMatchObject({
        layer: "inference",
        code:
          category === "host-runtime-failure" ? "invalid-execution-lease-coordinator" : category,
      });
    }
  });

  it("classes every closed technical-review and source-obligation rejection code", () => {
    for (const code of [
      ...TECHNICAL_REVIEW_REJECTION_CODES,
      ...SOURCE_OBLIGATION_REJECTION_CODES,
    ]) {
      expect(inferenceRejectionFailureClass(code), code).toBeDefined();
    }
  });

  it("classes every code a retry rule hint names, including each family", () => {
    for (const key of Object.keys(RESPONSE_REJECTION_RULE_HINTS)) {
      const code = key.endsWith("*") ? `${key.slice(0, -1)}example-keyword` : key;
      expect(inferenceRejectionFailureClass(code), key).toBeDefined();
    }
  });

  it("classifies available-source all-unassessed refusals as model content", () => {
    expect(inferenceRejectionFailureClass("source-readiness-unassessed-available-sources")).toBe(
      "model-content",
    );
  });

  it("classes each rejection a named raising site exports", () => {
    for (const code of [
      EDITORIAL_ENVELOPE_SHAPE_REJECTION,
      UNKNOWN_OBLIGATION_LINK_REJECTION.code,
      ISSUE_JUDGMENT_VOCABULARY_REJECTIONS.severity.code,
      ISSUE_JUDGMENT_VOCABULARY_REJECTIONS.category.code,
    ]) {
      expect(inferenceRejectionFailureClass(code), code).toBeDefined();
    }
  });

  it("names exactly every quality-path code: the evaluation validator's and every other check's", () => {
    const union = [...new Set([...EVALUATION_DIAGNOSTIC_CODES, ...QUALITY_CHECK_REJECTION_CODES])];
    expect(Object.keys(QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES).sort()).toEqual(union.sort());
    // Each code, recorded under any outer binding code, is classed by itself.
    for (const code of union) {
      expect(
        classifyQualityValidationFailure({
          failureCode: "report-binding-invalid",
          rejectionCode: code,
        }),
        code,
      ).toMatchObject({ layer: "workflow", code });
    }
    expect(
      classifyQualityValidationFailure({
        failureCode: "evaluation-invalid",
        rejectionCode: "evaluation-schema-required",
      }),
    ).toEqual({ class: "contract-shape", layer: "workflow", code: "evaluation-schema-required" });
  });

  it("classes every first-pass rule and CLI refusal code", () => {
    for (const rule of FIRST_PASS_FAILURE_RULES) {
      expect(firstPassRuleFailureClass(rule), rule).toBeDefined();
    }
    for (const code of [
      ...SOURCE_OPTION_REFUSAL_CODES,
      ...SELECTOR_OPTION_REFUSAL_CODES,
      ...RUN_OPTION_REFUSAL_CODES,
      ...SOURCES_CLI_REFUSAL_CODES,
      ...REPOSITORY_CONFIGURATION_REFUSAL_CODES,
      ...INIT_CONFIGURATION_ROOT_REFUSAL_CODES,
      ...DELIVERY_FLAG_REFUSAL_CODES,
      ...DO_SOURCE_ROUTE_REFUSAL_CODES,
    ]) {
      expect(operatorCodeFailureClass(code), code).toBe("operator-input");
    }
    for (const code of Object.keys(RUN_FAILURE_CODE_CLASSES)) {
      expect(operatorCodeFailureClass(code), code).toBeDefined();
    }
  });
});

describe("classifiers name the cause the record carries (#1186)", () => {
  it("classifies the locked quality deriver fault as terminal infrastructure", () => {
    const error = new QualityDerivationError("deriver-exit");
    expect(operatorCodeFailureClass(error.code)).toBe("infrastructure");
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "quality-derivation-failed",
    });
  });

  it("separates model content, contract shape, and a reply cut off at its allowance", () => {
    expect(
      classifyInferenceFailure({
        category: "malformed-response",
        rejectionCode: "invalid-fact-link",
      }),
    ).toEqual({ class: "model-content", layer: "inference", code: "invalid-fact-link" });
    expect(
      classifyInferenceFailure({
        category: "malformed-response",
        rejectionCode: "inventory-fact-locators",
      }),
    ).toEqual({ class: "model-content", layer: "inference", code: "inventory-fact-locators" });
    expect(
      classifyInferenceFailure({
        category: "malformed-response",
        rejectionCode: "review-schema-type",
      }),
    ).toEqual({ class: "contract-shape", layer: "inference", code: "review-schema-type" });
    // Unclosed JSON alone does not prove a cut-off: a reply that stopped
    // normally, or empty text, raises the same parser detail.
    for (const finishReason of [undefined, "stop", "end_turn"]) {
      expect(
        classifyInferenceFailure({
          category: "malformed-response",
          rejectionCode: "json-unexpected-end",
          ...(finishReason ? { finishReason } : {}),
        }),
        String(finishReason),
      ).toEqual({ class: "contract-shape", layer: "inference", code: "json-unexpected-end" });
    }
    // The provider's own output-limit stop proves a cut-off whatever the reply's
    // shape (OpenAI `length`, Anthropic `max_tokens`).
    for (const finishReason of ["length", "max_tokens"]) {
      expect(
        classifyInferenceFailure({
          category: "malformed-response",
          rejectionCode: "json-unexpected-end",
          finishReason,
        }),
        finishReason,
      ).toEqual({ class: "bound", layer: "inference", code: "output-limit-reached" });
    }
  });

  it("reads a rejection code no table knows as unknown, naming that code", () => {
    for (const rejectionCode of [
      "brand-new-rule",
      "unretainable-reason-too-long",
      "unretainable-reason-off-grammar",
    ]) {
      expect(
        classifyInferenceFailure({ category: "malformed-response", rejectionCode }),
        rejectionCode,
      ).toEqual({ class: "unknown", layer: "inference", code: rejectionCode });
    }
  });

  // Pins the class of the codes that carry most failures, so a wrong class
  // in any table fails here rather than misleading an operator.
  it.each([
    ["category", "throttled", "flake"],
    ["category", "provider-transient", "flake"],
    ["category", "context-exhausted", "bound"],
    ["category", "malformed-response", "contract-shape"],
    ["category", "timeout", "unknown"],
    ["category", "blank-response", "unknown"],
    ["category", "invalid-request", "unknown"],
    ["category", "provider-terminal", "unknown"],
    ["rejection", "invalid-review", "model-content"],
    ["rejection", "invalid-fact-link", "model-content"],
    ["rejection", "inventory-fact-locators", "model-content"],
    ["rejection", "inconsistent-status", "model-content"],
    ["rejection", "fact-link-unknown-obligation", "model-content"],
    ["rejection", "invalid-json", "contract-shape"],
    ["rejection", "json-unexpected-end", "contract-shape"],
    ["rejection", "editorial-envelope-shape", "contract-shape"],
    ["rejection", "review-issue-location-unsafe", "model-content"],
    ["rejection", "bounds-exceeded", "bound"],
    ["rejection", "invalid-fact-inventory", "model-content"],
    ["rejection", "invalid-shape", "contract-shape"],
    ["rejection", "fact-link-judgment-fact-mismatch", "model-content"],
    ["rejection", "inventory-dimension-facts", "model-content"],
    ["rejection", "inventory-fact-finding-link", "model-content"],
    ["outer", "evaluation-invalid", "model-content"],
    ["outer", "validator-unavailable", "infrastructure"],
    ["outer", "report-binding-invalid", "contract-shape"],
    ["outer", "technical-trace-incomplete", "model-content"],
    ["outer", "candidate-invalid", "contract-shape"],
    ["outer", "target-scope-mismatch", "contract-shape"],
    ["outer", "quality-score-invalid", "contract-shape"],
    ["outer", "artifact-integrity-invalid", "contract-shape"],
    ["quality", "required-dimension-not-applicable", "model-content"],
    ["quality", "layer-confidence-exceeds-dimensions", "model-content"],
    ["quality", "technical-trace-missing-source-locator", "model-content"],
    // A validator that listed no issue may have crashed or been killed at its limit.
    ["quality", "evaluation-validator-refused", "unknown"],
    ["quality", "quality-score-validator-refused", "unknown"],
    ["quality", "report-binding-validator-refused", "unknown"],
    ["quality", "quality-candidate-missing", "contract-shape"],
    ["quality", "quality-technical-verification-unadmitted", "contract-shape"],
    ["quality", "validator-lock-entry-missing", "infrastructure"],
    ["quality", "report-finalization-integrity-failed", "infrastructure"],
    ["quality", "validation-binding-unstored", "infrastructure"],
    ["quality", "report-profile-bytes-changed", "infrastructure"],
    ["quality", "validator-workspace-not-private", "operator-input"],
    ["quality", "candidate-credential-material", "model-content"],
    ["quality", "candidate-target-outside-scope", "contract-shape"],
    ["quality", "candidate-target-paths-invalid", "contract-shape"],
    ["quality", "candidate-selection-mismatch", "contract-shape"],
    ["quality", "report-limitation-duplicate", "model-content"],
    ["quality", "report-summary-repeated", "model-content"],
    ["quality", "report-target-mismatch", "contract-shape"],
    ["quality", "report-rubric-not-locked", "contract-shape"],
    ["quality", "report-input-unreadable", "unknown"],
    ["quality", "report-binding-semantics", "unknown"],
    ["quality", "quality-score-semantics", "model-content"],
    ["quality", "score-field-missing", "contract-shape"],
    ["quality", "score-total-sum-mismatch", "model-content"],
    ["quality", "score-unreadable", "infrastructure"],
    ["run", "unreadable-rejection-code", "unknown"],
    // A failed candidate check alone does not identify its cause.
    ["run", "required-check-failed", "unknown"],
    ["run", "required-check-instructions-altered", "model-content"],
    ["run", "required-check-evidence-missing", "contract-shape"],
    ["run", "required-check-evidence-stale", "contract-shape"],
    ["run", "required-check-snapshot-unavailable", "infrastructure"],
    // The retired aggregate covered several causes.
    ["run", "required-check-refused", "unknown"],
    ["operator", "provider-credentials-missing", "auth"],
    ["operator", "gitlab-unauthenticated", "auth"],
    ["operator", "cli-usage", "operator-input"],
    ["operator", "tracked-source-dirty", "operator-input"],
    ["operator", "aggregate-timeout", "bound"],
    ["operator", "proposal-scope-duplicate-targets", "planning-refusal"],
    ["operator", "first-pass-support-invalid", "planning-refusal"],
    ["operator", "operator-error", "unknown"],
  ] as const)("pins %s %s to %s", (kind, code, expected) => {
    const actual =
      kind === "category"
        ? classifyInferenceFailure({ category: code as never }).class
        : kind === "rejection"
          ? classifyInferenceFailure({ category: "malformed-response", rejectionCode: code }).class
          : kind === "outer"
            ? classifyQualityValidationFailure({ failureCode: code as never }).class
            : kind === "quality"
              ? classifyQualityValidationFailure({
                  failureCode: "evaluation-invalid",
                  rejectionCode: code,
                }).class
              : kind === "run"
                ? RUN_FAILURE_CODE_CLASSES[code as keyof typeof RUN_FAILURE_CODE_CLASSES]
                : operatorCodeFailureClass(code);
    expect(actual).toBe(expected);
  });

  it("classes every host fault in a quality check as infrastructure, never its outer shape code", () => {
    const hostFaults = [
      ...Object.values(QUALITY_CHECK_INTEGRITY_CODES),
      ...Object.values(QUALITY_VALIDATOR_UNAVAILABLE_CODES),
      ...QUALITY_CHECK_REJECTION_CODES.filter((code) => code.endsWith("-unstored")),
    ];
    expect(hostFaults).toContain("validation-binding-unstored");
    expect(hostFaults).toContain("report-finalization-integrity-failed");
    for (const code of hostFaults) {
      // The outer binding code of a host fault is a shape code; the inner one wins.
      for (const failureCode of ["report-binding-invalid", "artifact-integrity-invalid"] as const) {
        expect(
          classifyQualityValidationFailure({ failureCode, rejectionCode: code }),
          `${failureCode}/${code}`,
        ).toEqual({ class: "infrastructure", layer: "workflow", code });
      }
    }
    for (const code of QUALITY_CHECK_REJECTION_CODES.filter((code) =>
      code.startsWith("technical-trace-missing-"),
    )) {
      expect(
        classifyQualityValidationFailure({
          failureCode: "technical-trace-incomplete",
          rejectionCode: code,
        }).class,
        code,
      ).toBe("model-content");
    }
  });

  it("reads a hand-edited rejection code outside the grammar as unknown, without throwing", () => {
    const edited = "Rejected Reply Prose!";
    const record = {
      status: "failed",
      steps: [
        {
          id: "provisional-technical-verification",
          status: "failed",
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "malformed-response",
                rejection: { code: edited, location: "$" },
              },
            ],
          },
        },
      ],
    } as unknown as RunRecord;
    const expected = { class: "unknown", layer: "inference", code: "unreadable-rejection-code" };
    expect(readRunFailure(record)).toEqual(expected);
    expect(JSON.stringify(projectRunFailureOccurrences(record))).not.toContain("Prose");
    // A family prefix does not make an off-grammar code readable.
    for (const rejectionCode of [edited, "evaluation-schema-Required Prose!"]) {
      expect(
        classifyQualityValidationFailure({ failureCode: "evaluation-invalid", rejectionCode }),
        rejectionCode,
      ).toEqual({ class: "model-content", layer: "workflow", code: "evaluation-invalid" });
    }
  });

  it("classes a run by its first failed step, not a later one", () => {
    const step = (id: string, code: string) => ({
      id,
      status: "failed",
      inference: {
        attempts: [
          { attempt: 1, outcome: "malformed-response", rejection: { code, location: "$" } },
        ],
      },
    });
    const record = {
      status: "failed",
      steps: [step("first", "invalid-fact-link"), step("second", "invalid-json")],
    } as unknown as RunRecord;
    const expected = { class: "model-content", layer: "inference", code: "invalid-fact-link" };
    expect(readRunFailure(record)).toEqual(expected);
    attachRunFailureClassifications(record);
    expect(record.failure).toEqual(expected);
    expect(record.steps[1]?.failure).toEqual({
      class: "contract-shape",
      layer: "inference",
      code: "invalid-json",
    });
  });

  it("keeps a wrapped harness error's cause out of every serialization", async () => {
    const thrown = Object.assign(new Error("The host authority receipt is missing here."), {
      code: "authority-required",
    });
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      sleep: async () => {},
      execute: async () => {
        throw thrown;
      },
    });
    expect(execution.status).toBe("failed");
    const error = (execution as { error: InferenceStepError }).error;
    expect(error.cause).toBe(thrown);
    expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
    expect(Object.keys(error)).not.toContain("cause");
    expect(JSON.stringify(error)).not.toContain("authority");
    expect(JSON.stringify({ ...error })).not.toContain("authority");
  });

  it("reads an uncatalogued or missing code as unknown, naming it", () => {
    const coded = Object.assign(new Error("A contract refused the value for this operation."), {
      code: "never-catalogued-stem",
    });
    expect(classifyThrownFailure(coded, "workflow")).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "never-catalogued-stem",
    });
    expect(
      classifyThrownFailure(new Error("Something failed without a code."), "workflow"),
    ).toEqual({ class: "unknown", layer: "workflow", code: "uncoded-error" });
    expect(classifyThrownFailure(new Error("x"), "workflow", { cancelled: true })).toEqual({
      class: "cancelled",
      layer: "workflow",
      code: "workflow-cancelled",
    });
  });

  it("classifies only composition evidence errors by their closed codes", () => {
    expect(CompositionExecutionEvidenceError).toBe(CompositionExecutionErrorLeaf);
    expect(
      classifyThrownFailure(new CompositionExecutionEvidenceError("subject-mismatch"), "workflow"),
    ).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "subject-mismatch",
    });
    expect(
      classifyThrownFailure(
        Object.assign(new Error("other refusal"), { code: "subject-mismatch" }),
        "workflow",
      ),
    ).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "subject-mismatch",
    });
  });
});

it("lets the sealed host-origin pair outrank any provider error telemetry", () => {
  const attempt = providerAttempt(
    "host-runtime-failure",
    {
      class: "server",
      httpStatus: 503,
    },
    {
      hostFailureOrigin: {
        schemaVersion: 1,
        origin: "execution-lease-coordinator",
        code: "invalid-execution-lease-coordinator",
      },
    },
  );
  expect(classifyInferenceAttempt(attempt)).toEqual({
    class: "infrastructure",
    layer: "inference",
    code: "invalid-execution-lease-coordinator",
  });
  expect(classifyInferenceAttempt(providerAttempt("host-runtime-failure", undefined))).toEqual({
    class: "unknown",
    layer: "inference",
    code: "unreadable-host-failure-origin",
  });
});

/** A failed attempt as `records/contracts.ts` stores it, with provider-error telemetry. */
function providerAttempt(
  outcome: string,
  providerError: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
) {
  return {
    attempt: 1,
    outcome,
    retryable: false,
    retryScheduled: false,
    modelTelemetry: {
      schemaVersion: 1,
      finishReason: "error",
      providerLatencyMs: 1200,
      ...(providerError ? { providerError } : {}),
    },
    ...extra,
  } as never;
}

describe("the recorded provider error splits provider-terminal and invalid-request (#1185)", () => {
  // Pins every class the provider error tables can yield, and the categories
  // they leave `unknown`. The status is the transport's; no message is read.
  it.each([
    // An answered status: the provider said why.
    ["invalid-request", { class: "auth", httpStatus: 401 }, "auth", "provider-http-auth"],
    ["invalid-request", { class: "auth", httpStatus: 403 }, "auth", "provider-http-auth"],
    ["provider-terminal", { class: "server", httpStatus: 503 }, "flake", "provider-http-server"],
    ["timeout", { class: "timeout", httpStatus: 408 }, "flake", "provider-http-timeout"],
    ["provider-terminal", { class: "timeout", httpStatus: 504 }, "flake", "provider-http-timeout"],
    [
      "provider-terminal",
      { class: "rate-limit", httpStatus: 429 },
      "flake",
      "provider-http-rate-limit",
    ],
    // Sent, but no failing status came back: the path to the provider failed.
    ["provider-terminal", { class: "network" }, "infrastructure", "provider-network"],
    ["timeout", { class: "timeout" }, "infrastructure", "provider-timeout"],
    // The same sent failures recorded as retryable categories read the same class.
    ["provider-transient", { class: "network" }, "infrastructure", "provider-network"],
    // A 2xx stream that closed before it finished (#1696).
    [
      "provider-transient",
      { class: "stream-incomplete" },
      "infrastructure",
      "provider-stream-incomplete",
    ],
    ["provider-transient", { class: "server", httpStatus: 502 }, "flake", "provider-http-server"],
    ["provider-terminal", { class: "auth" }, "auth", "provider-auth"],
    // A 400 or 404 covers several causes; the category code still shows.
    [
      "invalid-request",
      { class: "invalid-request", httpStatus: 400 },
      "unknown",
      "invalid-request",
    ],
    [
      "invalid-request",
      { class: "invalid-request", httpStatus: 404 },
      "unknown",
      "invalid-request",
    ],
    ["invalid-request", { class: "content-filter", httpStatus: 400 }, "unknown", "invalid-request"],
    ["provider-terminal", { class: "unknown" }, "unknown", "provider-terminal"],
    ["provider-terminal", undefined, "unknown", "provider-terminal"],
    ["timeout", undefined, "unknown", "timeout"],
  ] as const)(
    "reads %s with provider error %j as %s (%s)",
    (outcome, providerError, expected, code) => {
      expect(classifyInferenceAttempt(providerAttempt(outcome, providerError))).toEqual({
        class: expected,
        layer: "inference",
        code,
      });
    },
  );

  it("lets a named execution ceiling beat the cut-answer condition", () => {
    // The ceiling is the more specific bound; the cut is how the answer ended.
    expect(
      classifyInferenceFailure({
        category: "malformed-response",
        rejectionCode: "invalid-json",
        condition: "cut-answer",
        executionLimitCode: "composition-execution-max-provider-turns-bound",
      }),
    ).toEqual({
      class: "bound",
      layer: "inference",
      code: "composition-execution-max-provider-turns-bound",
    });
    // Adjacent: without the ceiling the condition decides.
    expect(
      classifyInferenceFailure({
        category: "malformed-response",
        rejectionCode: "invalid-json",
        condition: "cut-answer",
      }).code,
    ).toBe("output-limit-reached");
  });

  it("classes a refused continued answer by the whole answer, not its last turn (e2f4c3d4)", () => {
    // The continuation turn stopped normally and the stitched reply failed to
    // parse; the attempt's recorded condition names the output-limit cut.
    const stitched = (extra: Record<string, unknown>) =>
      providerAttempt("malformed-response", undefined, {
        modelTelemetry: { schemaVersion: 1, finishReason: "stop", providerLatencyMs: 5 },
        rejection: { code: "invalid-json", location: "$" },
        ...extra,
      });
    expect(classifyInferenceAttempt(stitched({ condition: "cut-answer" }))).toEqual({
      class: "bound",
      layer: "inference",
      code: "output-limit-reached",
    });
    // Adjacent: the same refusal without the condition keeps its coded rejection.
    expect(classifyInferenceAttempt(stitched({}))?.code).toBe("invalid-json");
    expect(classifyInferenceAttempt(stitched({ condition: "unframed-reply" }))?.code).toBe(
      "invalid-json",
    );
  });

  it("lets a coded rejection, an output-limit stop, and the host's own budget stop win", () => {
    const network = { class: "network" };
    expect(
      classifyInferenceAttempt(
        providerAttempt("malformed-response", network, {
          rejection: { code: "invalid-fact-link", location: "$" },
        }),
      ),
    ).toEqual({ class: "model-content", layer: "inference", code: "invalid-fact-link" });
    expect(
      classifyInferenceAttempt(
        providerAttempt("provider-terminal", network, {
          modelTelemetry: {
            schemaVersion: 1,
            finishReason: "length",
            providerLatencyMs: 5,
            providerError: network,
          },
        }),
      ),
    ).toEqual({ class: "bound", layer: "inference", code: "output-limit-reached" });
    expect(classifyInferenceAttempt(providerAttempt("context-exhausted", network))).toEqual({
      class: "bound",
      layer: "inference",
      code: "context-exhausted",
    });
  });

  // The index shows `finishReason=length` from telemetry, so the class reads the
  // same normalized reason, not only two raw tokens.
  it("reads a cut-off from the normalized finish reason, and the raw token only without telemetry", () => {
    const cut = { class: "bound", layer: "inference", code: "output-limit-reached" };
    const attempt = (finishReason: string | undefined, rawStopReason: string) =>
      ({
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
        rejection: { code: "json-unexpected-end", location: "$response" },
        turns: [{ rawStopReason }],
        ...(finishReason === undefined
          ? {}
          : { modelTelemetry: { schemaVersion: 1, finishReason, providerLatencyMs: 9 } }),
      }) as never;
    // OpenAI responses: the raw token is outside the raw set; telemetry says `length`.
    expect(classifyInferenceAttempt(attempt("length", "incomplete.max_output_tokens"))).toEqual(
      cut,
    );
    expect(classifyInferenceAttempt(attempt("length", "max_output_tokens"))).toEqual(cut);
    // Telemetry that says the turn stopped normally wins over a raw token.
    expect(classifyInferenceAttempt(attempt("stop", "length"))).toEqual({
      class: "contract-shape",
      layer: "inference",
      code: "json-unexpected-end",
    });
    // A record without telemetry still reads the raw token, through the same
    // table the telemetry normalizer uses, so every output-limit token counts.
    expect(classifyInferenceAttempt(attempt(undefined, "max_tokens"))).toEqual(cut);
    expect(classifyInferenceAttempt(attempt(undefined, "max_output_tokens"))).toEqual(cut);
    expect(classifyInferenceAttempt(attempt(undefined, "stop_sequence"))).toEqual({
      class: "contract-shape",
      layer: "inference",
      code: "json-unexpected-end",
    });
  });

  it("ignores telemetry its strict reader refuses, rather than guessing a class", () => {
    for (const providerError of [
      { class: "dns-failure" },
      { class: "auth", httpStatus: 401, message: "Unauthorized" },
      { class: "auth", httpStatus: 1401 },
    ]) {
      expect(
        classifyInferenceAttempt(providerAttempt("provider-terminal", providerError)),
        JSON.stringify(providerError),
      ).toEqual({ class: "unknown", layer: "inference", code: "provider-terminal" });
    }
  });

  // The closed fields of a recorded evaluate-document-quality failure: an
  // undici stream cut ("terminated") with no HTTP status, telemetry class `network`.
  it("classes the 2026-09-23 create-cli stream cut as infrastructure", () => {
    const record = {
      status: "failed",
      steps: [
        {
          id: "evaluate-document-quality",
          status: "failed",
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "provider-terminal",
                retryable: false,
                retryScheduled: false,
                modelTelemetry: {
                  schemaVersion: 1,
                  finishReason: "error",
                  outputAllowance: 128000,
                  providerLatencyMs: 364012,
                  providerError: { class: "network" },
                },
              },
            ],
          },
        },
      ],
    } as unknown as RunRecord;
    const expected = { class: "infrastructure", layer: "inference", code: "provider-network" };
    expect(readRunFailure(record)).toEqual(expected);
    attachRunFailureClassifications(record);
    expect(record.failure).toEqual(expected);
    expect(record.steps[0]?.failure).toEqual(expected);
  });
});

describe("a quality refusal with no validation binding carries its own class (#1237)", () => {
  const succeededEvaluator = {
    inference: { attempts: [{ attempt: 1, outcome: "succeeded" }] },
  } as unknown as Pick<StepRunRecord, "inference">;

  it.each([
    ["quality-candidate-missing", "contract-shape"],
    ["quality-evaluator-identity-unbound", "contract-shape"],
    ["quality-technical-verification-unadmitted", "contract-shape"],
    ["quality-technical-verification-changed", "contract-shape"],
  ] as const)("classes candidate admission %s as %s, not uncoded", (code, expected) => {
    const error = qualityCandidateAdmissionError(code, "The final evaluator was refused.");
    const classification = { class: expected, layer: "workflow", code };
    expect(classifyStepFailure({ error, step: succeededEvaluator, cancelled: false })).toEqual(
      classification,
    );
    // The same error wrapped by the retry layer reads the same cause.
    expect(
      classifyStepFailure({
        error: wrapped(error),
        step: succeededEvaluator,
        cancelled: false,
      }),
    ).toEqual(classification);
  });

  it("classes the early validator-lock-entry-missing refusal as infrastructure", () => {
    const error = new QualityStepRejectionError(
      hostCheckRejection("candidate-staging", "validator-lock-entry-missing"),
      "The quality validators are absent from the verified quality pack lock.",
    );
    expect(classifyStepFailure({ error, step: succeededEvaluator, cancelled: false })).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "validator-lock-entry-missing",
    });
  });

  it("reads an unbound quality code on a record with no failure field", () => {
    const step = {
      id: "evaluate-document-quality",
      status: "failed",
      qualityValidationRejection: {
        validator: "candidate-admission",
        code: "quality-candidate-missing",
        location: "$",
        issueCount: 1,
      },
      inference: { attempts: [{ attempt: 1, outcome: "succeeded" }] },
    } as unknown as StepRunRecord;
    expect(readStepFailure(step, {})).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "quality-candidate-missing",
    });
  });
});

/** The retry layer's wrap of a non-inference error (`retry.ts` `normalizeFailure`). */
function wrapped(cause: unknown): InferenceStepError {
  const error = new InferenceStepError("Model request failed.", "provider-terminal", false);
  Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}

describe("the operator envelope carries one class (#1186)", () => {
  it("classes a wrapped harness error by its cause, as the step record does", () => {
    for (const cause of [
      Object.assign(new Error("The host authority receipt is missing."), {
        code: "authority-required",
      }),
      qualityCandidateAdmissionError("quality-candidate-missing", "No candidate."),
    ]) {
      const error = wrapped(cause);
      const step = classifyStepFailure({
        error,
        step: { inference: { attempts: [] } } as unknown as Pick<StepRunRecord, "inference">,
        cancelled: false,
      });
      const envelope = toOperatorErrorEnvelope(error).failure;
      expect(envelope, step.code).toMatchObject({ class: step.class, code: step.code });
      expect(step.class, step.code).not.toBe("unknown");
    }
  });

  it("classes an inference error by its recorded provider error", () => {
    const error = new InferenceStepError("Model request failed.", "invalid-request", false, {
      modelTelemetry: {
        schemaVersion: 1,
        finishReason: "error",
        providerLatencyMs: 10,
        providerError: { class: "auth", httpStatus: 401 },
      },
    });
    expect(toOperatorErrorEnvelope(error).failure).toEqual({
      class: "auth",
      layer: "inference",
      code: "provider-http-auth",
    });
  });

  it("classes a catalogued situation in JSON and in the human lines", () => {
    const error = Object.assign(new Error("GitLab refused the request."), {
      code: "gitlab-unauthenticated",
    });
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.failure).toEqual({
      class: "auth",
      layer: "cli",
      code: "gitlab-unauthenticated",
    });
    const lines = formatOperatorErrorEnvelope(envelope).split("\n");
    expect(lines[1]).toBe("code: gitlab-unauthenticated");
    expect(lines[2]).toBe("failure class: auth (layer cli)");
  });

  it("classes an inference error by its rejection, and an unknown code as unknown", () => {
    const inference = new InferenceStepError(
      "Technical review response rejected: invalid-review.",
      "malformed-response",
      false,
      undefined,
      { code: "inventory-fact-locators", location: "$.factInventory" },
    );
    const envelope = toOperatorErrorEnvelope(inference);
    expect(envelope.failure).toEqual({
      class: "model-content",
      layer: "inference",
      code: "inventory-fact-locators",
    });
    expect(formatOperatorErrorEnvelope(envelope)).toContain(
      "failure class: model-content (layer inference, code inventory-fact-locators)",
    );
    expect(toOperatorErrorEnvelope(new Error("Plain failure without any code.")).failure).toEqual({
      class: "unknown",
      layer: "cli",
      code: "operator-error",
    });
  });

  it("classes a first-pass stop by its rule and prints it before NEXT", () => {
    const stop = classifyFirstPassFailure({
      phase: "decomposition",
      rule: "strict-json",
      location: "$response",
    })!;
    expect(stop.failure).toEqual({ class: "contract-shape", layer: "cli", code: "strict-json" });
    const lines = renderPreRecordFailure(stop).split("\n");
    expect(lines[2]).toBe("Failure class: contract-shape.");
    expect(lines[3]).toMatch(/^NEXT: /u);
  });
});

class ScannerFixture implements RepositorySecurityScanner {
  public async scan(): Promise<SecurityScanReport> {
    return { ruleSet: "test-v1", status: "passed", scannedFiles: 1, binaryFiles: 0, findings: [] };
  }
}

class EvidenceFixture implements RepositoryEvidenceCollector {
  public async capture(): Promise<ChangeEvidence> {
    return { files: [] };
  }
}

const NO_RETRY: InferenceRetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 1,
  maxDelayMs: 1,
  retryableCategories: [],
};

async function persistFailedReadiness(
  runId: string,
  revision: string,
  runStep: AgentHarness["runStep"],
): Promise<{ record: RunRecord; stateDirectory: string }> {
  const root = await roots.create("docsfab-1186-");
  const stateDirectory = join(root, "runs");
  const repository = join(root, "repository");
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(repository, { recursive: true });
  const runner = new WorkflowRunner({
    harness: { runStep },
    store: new FileRunStore(stateDirectory),
    repositoryScanner: new ScannerFixture(),
    contextPreflight: readyContextPreflight,
    repositoryEvidence: new EvidenceFixture(),
    retryPolicy: NO_RETRY,
    retrySleep: async () => {},
    id: () => runId,
  });
  await runner
    .run({
      workflow: "readiness",
      workspacePath: repository,
      repository: { sourcePath: repository, requestedRevision: "HEAD", revision },
      allowWrite: false,
    })
    .catch(() => undefined);
  const record = parseJsonEvidence(
    await readFile(join(stateDirectory, `${runId}.json`)),
  ) as unknown as RunRecord;
  return { record, stateDirectory };
}

async function showJson(runId: string, stateDirectory: string): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => {
    chunks.push(values.map(String).join(" "));
  };
  try {
    await handleRunsCommand(["show", runId, "--state-dir", stateDirectory, "--json"]);
  } finally {
    console.log = original;
    process.exitCode = undefined;
  }
  return JSON.parse(chunks.join("\n")) as Record<string, unknown>;
}

describe("a failed run records and shows its class (#1186)", () => {
  it("records model content from a coded rejection on the attempt, step, and run", async () => {
    const { record, stateDirectory } = await persistFailedReadiness(
      "failure-class-model-content",
      "a1b2".padEnd(40, "1"),
      async () => {
        throw new InferenceStepError(
          "Technical correction response rejected: invalid-fact-link.",
          "malformed-response",
          false,
          undefined,
          { code: "invalid-fact-link", location: "$.issueJudgments" },
        );
      },
    );
    const expected = { class: "model-content", layer: "inference", code: "invalid-fact-link" };
    expect(record.status).toBe("failed");
    expect(record.failure).toEqual(expected);
    expect(record.steps[0]?.failure).toEqual(expected);
    expect(formatRunFailureDiagnosticLines(record)).toContain(
      "Failure class: model-content (layer inference, code invalid-fact-link).",
    );
    const shown = await showJson("failure-class-model-content", stateDirectory);
    expect(shown.failures).toEqual([
      { scope: "run", ...expected },
      { scope: "step", stepId: "assess-readiness", ...expected },
      { scope: "attempt", stepId: "assess-readiness", attempt: 1, ...expected },
    ]);
  });

  it("records an uncoded thrown error as unknown, never as a plausible class", async () => {
    const { record } = await persistFailedReadiness(
      "failure-class-uncoded",
      "c3d4".padEnd(40, "2"),
      async () => {
        throw new Error("The harness failed in a way nothing catalogued.");
      },
    );
    expect(record.failure).toEqual({ class: "unknown", layer: "workflow", code: "uncoded-error" });
  });

  it("records a quality refusal with no binding by its code, not as uncoded", async () => {
    const { record } = await persistFailedReadiness(
      "failure-class-unbound-quality",
      "a7b8".padEnd(40, "4"),
      async () => {
        throw qualityCandidateAdmissionError(
          "quality-evaluator-identity-unbound",
          "The final evaluator step has no bound evaluator identity digest.",
        );
      },
    );
    const expected = {
      class: "contract-shape",
      layer: "workflow",
      code: "quality-evaluator-identity-unbound",
    };
    expect(record.steps[0]?.failure).toEqual(expected);
    expect(record.failure).toEqual(expected);
  });

  it("records a provider auth failure from the attempt's telemetry", async () => {
    const { record } = await persistFailedReadiness(
      "failure-class-provider-auth",
      "c9d0".padEnd(40, "5"),
      async () => {
        throw new InferenceStepError("Model request failed.", "invalid-request", false, {
          modelTelemetry: {
            schemaVersion: 1,
            finishReason: "error",
            providerLatencyMs: 40,
            providerError: { class: "auth", httpStatus: 401 },
          },
        });
      },
    );
    expect(record.failure).toEqual({
      class: "auth",
      layer: "inference",
      code: "provider-http-auth",
    });
  });

  it("records a catalogued operator code by its catalog class", async () => {
    const { record } = await persistFailedReadiness(
      "failure-class-authority",
      "e5f6".padEnd(40, "3"),
      async () => {
        throw Object.assign(new Error("The host authority receipt is missing for this step."), {
          code: "authority-required",
        });
      },
    );
    expect(record.failure).toEqual({
      class: "auth",
      layer: "workflow",
      code: "authority-required",
    });
  });
});

describe("records written before #1186 still read a class from closed evidence", () => {
  it("derives the run and step class from the terminal attempt", () => {
    const record = {
      status: "failed",
      steps: [
        {
          id: "provisional-technical-verification",
          status: "failed",
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "malformed-response",
                rejection: { code: "inconsistent-status", location: "$.dimensions[].reason" },
              },
            ],
          },
        },
      ],
    } as unknown as RunRecord;
    expect(readRunFailure(record)).toEqual({
      class: "model-content",
      layer: "inference",
      code: "inconsistent-status",
    });
    expect(projectRunFailureOccurrences(record).map((entry) => entry.scope)).toEqual([
      "run",
      "step",
      "attempt",
    ]);
  });

  it("attaches unclassified-run-failure visibly when a failed run names no cause", () => {
    const record = { status: "failed", steps: [] } as unknown as RunRecord;
    attachRunFailureClassifications(record);
    expect(record.failure).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "unclassified-run-failure",
    });
  });
});

describe("namespaced operator code families (#1186)", () => {
  it("keeps the repository bootstrap family literal equal to the one the refusal builds", () => {
    // The table duplicates the literal so the operator module imports no domain
    // module; this assertion keeps the copies equal.
    expect(Object.keys(OPERATOR_CODE_FAMILY_FAILURE_CLASSES)).toContain(
      REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY,
    );
    for (const failureClass of Object.values(OPERATOR_CODE_FAMILY_FAILURE_CLASSES)) {
      expect(FAILURE_CLASSES).toContain(failureClass);
    }
  });

  it("classes every reason a repository bootstrap refusal can carry", () => {
    for (const reason of [
      "changed-file-agreement",
      "declared-patch-without-changes",
      "non-text-guidance",
      "empty-or-changing-guidance",
      "unadmitted-result",
      "quote-mismatch",
      "workflow",
      "schema",
      "path",
      "value",
      "credential-material",
    ]) {
      const error = new RepositoryBootstrapResultError(reason);
      expect(error.code, reason).toBe(`${REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY}${reason}`);
      expect(error.message, reason).toBe(`Repository bootstrap result refused: ${reason}.`);
      expect(operatorCodeFailureClass(error.code), reason).toBe("contract-shape");
      expect(classifyThrownFailure(error, "workflow"), reason).toEqual({
        class: "contract-shape",
        layer: "workflow",
        code: error.code,
      });
    }
  });

  it("leaves the adjacent conditions of family membership uncatalogued", () => {
    // Adjacent condition 1: the bare prefix names no member.
    expect(operatorCodeFailureClass(REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY)).toBeUndefined();
    // Adjacent condition 2: the prefix appears, but not at the start.
    expect(operatorCodeFailureClass("run-repository-bootstrap-schema")).toBeUndefined();
    // Adjacent condition 3: a bare reason is not a family member.
    expect(operatorCodeFailureClass("changed-file-agreement")).toBeUndefined();
    expect(operatorCodeFailureClass("workflow")).toBeUndefined();
  });

  it("records a reported refusal as a classified run failure, and keeps the first cause", () => {
    const refused = { steps: [] } as unknown as RunRecord;
    markRunRefusal(refused, `${REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY}changed-file-agreement`);
    expect(refused.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "repository-bootstrap-changed-file-agreement",
    });
    // Positive control: a run-level code the tables name keeps its class.
    const empty = { steps: [] } as unknown as RunRecord;
    markRunRefusal(empty, "empty-write-result");
    expect(empty.failure).toEqual({
      class: RUN_FAILURE_CODE_CLASSES["empty-write-result"],
      layer: "workflow",
      code: "empty-write-result",
    });
    // Adjacent condition: a record that already names a cause keeps it.
    markRunRefusal(empty, `${REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY}non-text-guidance`);
    expect(empty.failure?.code).toBe("empty-write-result");
  });

  it("never throws out of the finalizer when a port reports a malformed code", () => {
    // A code outside the kebab-case vocabulary is the port's defect; it must
    // record, not raise, so admission never throws.
    const record = { steps: [] } as unknown as RunRecord;
    expect(() => markRunRefusal(record, "Repository Bootstrap Refused!")).not.toThrow();
    expect(record.failure).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "unclassified-run-failure",
    });
  });
});
