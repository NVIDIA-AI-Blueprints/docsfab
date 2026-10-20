// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab doctor --live --answer-records` at its shipped call site (#1967):
 * through `handleDoctorCommand`, with the probe stubbed at its module
 * boundary so no request is sent. The plan goes to stderr before any request,
 * and only GO exits 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import type { AnswerRecordProbePlan } from "../src/profile/answer-record-probe.js";
import { validModelConfig } from "./helpers.js";

const { probeCalls, planCalls, diagnosticPlanCalls, submissionCalls, probeWarnings } = vi.hoisted(
  () => ({
    /** Warnings the stubbed record probe returns beside its verdict. */
    probeWarnings: [] as Array<{ code: string; message: string }>,
    probeCalls: [] as Array<{
      model: unknown;
      corpusPath: unknown;
      selection: unknown;
      typedContextMix?: unknown;
      typedContextGroupOnly?: unknown;
      qualificationCells?: unknown;
      expectedQualificationFingerprint?: unknown;
      diagnosticCell?: unknown;
      expectedDiagnosticFingerprint?: unknown;
      observationDirectory: unknown;
    }>,
    planCalls: [] as Array<{ model: unknown; options: unknown }>,
    diagnosticPlanCalls: [] as Array<{ model: unknown; options: unknown }>,
    submissionCalls: [] as unknown[],
  }),
);

const PLAN: AnswerRecordProbePlan = {
  selection: "premise",
  typedContextMix: false,
  requestTimeoutMs: 300_000,
  decodeWindowMinBasisPoints: 2500,
  answerNowShareBasisPoints: 4000,
  requests: 24,
  transportRetries: 2,
  requestBudget: 24,
  paddedRequests: 9,
  paddingTargetTokens: 60_588,
  paddedInputTokens: 545_292,
  otherInputTokens: 21_162,
  plannedInputTokens: 566_454,
  inputTokenBudget: 600_000,
  paddedRetryFits: false,
  paddedRetriesThatFit: 0,
  ledger: null,
};
const GROUP_PLAN: AnswerRecordProbePlan = {
  selection: "small-groups",
  typedContextMix: false,
  requestTimeoutMs: 300_000,
  decodeWindowMinBasisPoints: 2500,
  answerNowShareBasisPoints: 4000,
  requests: 6,
  transportRetries: 0,
  requestBudget: 11,
  paddedRequests: 6,
  paddingTargetTokens: 60_588,
  paddedInputTokens: 363_400,
  otherInputTokens: 0,
  plannedInputTokens: 363_400,
  inputTokenBudget: 521_807,
  paddedRetryFits: true,
  paddedRetriesThatFit: 2,
  ledger: null,
};
const TYPED_PLAN: AnswerRecordProbePlan = {
  ...PLAN,
  selection: "typed",
  requests: 9,
  transportRetries: 1,
  requestBudget: 17,
  paddedRequests: 0,
  paddedInputTokens: 0,
  otherInputTokens: 90_000,
  plannedInputTokens: 90_000,
  inputTokenBudget: 500_000,
  ledger: {
    observations: 1,
    reservations: 0,
    requests: 13,
    typedRequests: 0,
    inputTokens: 100_000,
    transportRetriesUsed: 1,
  },
};

vi.mock("../src/doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/doctor.js")>()),
  recordAnswerRecordProbe: async (
    model: unknown,
    options: {
      corpusPath: string;
      selection?: string;
      typedContextMix?: boolean;
      typedContextGroupOnly?: boolean;
      qualificationCells?: boolean;
      expectedQualificationFingerprint?: string;
      diagnosticCell?: true;
      expectedDiagnosticFingerprint?: string;
      observationDirectory?: string;
      onPlan?: (plan: AnswerRecordProbePlan) => void;
    },
  ) => {
    probeCalls.push({
      model,
      corpusPath: options.corpusPath,
      selection: options.selection,
      ...(options.typedContextMix ? { typedContextMix: options.typedContextMix } : {}),
      ...(options.typedContextGroupOnly
        ? { typedContextGroupOnly: options.typedContextGroupOnly }
        : {}),
      ...(options.qualificationCells ? { qualificationCells: options.qualificationCells } : {}),
      ...(options.expectedQualificationFingerprint
        ? { expectedQualificationFingerprint: options.expectedQualificationFingerprint }
        : {}),
      ...(options.diagnosticCell ? { diagnosticCell: options.diagnosticCell } : {}),
      ...(options.expectedDiagnosticFingerprint
        ? { expectedDiagnosticFingerprint: options.expectedDiagnosticFingerprint }
        : {}),
      observationDirectory: options.observationDirectory,
    });
    options.onPlan?.(
      options.selection === "small-groups"
        ? GROUP_PLAN
        : options.typedContextGroupOnly
          ? {
              ...TYPED_PLAN,
              typedContextMix: true,
              typedContextGroupOnly: true,
              requests: 1,
              requestBudget: 2,
              paddedRequests: 1,
              paddedInputTokens: 60_588,
              otherInputTokens: 0,
              plannedInputTokens: 60_588,
              inputTokenBudget: 81_236,
            }
          : options.typedContextMix
            ? {
                ...TYPED_PLAN,
                typedContextMix: true,
                requests: 7,
                requestBudget: 8,
                paddedRequests: 7,
                paddedInputTokens: 424_116,
                otherInputTokens: 0,
                plannedInputTokens: 424_116,
                inputTokenBudget: 444_764,
              }
            : options.selection === "typed"
              ? TYPED_PLAN
              : PLAN,
    );
    // `not-checked` writes no observation, so the command touches no state.
    return {
      verdict: { decision: "not-checked", reason: "stubbed at the module boundary" },
      ...(probeWarnings.length > 0 ? { warnings: [...probeWarnings] } : {}),
    };
  },
  planAnswerRecordQualification: async (
    model: unknown,
    options: { corpusPath: string; selection: string; observationDirectory?: string },
  ) => {
    planCalls.push({ model, options });
    return {
      shell: options.selection,
      requests: 12,
      plannedInputTokens: 194034,
      transportRetries: 0,
      cells: [],
    };
  },
  planAnswerRecordDiagnostic: async (
    model: unknown,
    options: { corpusPath: string; observationDirectory: string },
  ) => {
    diagnosticPlanCalls.push({ model, options });
    return {
      diagnostic: { diagnosticFingerprint: "d".repeat(64) },
      requests: 1,
      plannedInputTokens: 60_588,
      transportRetries: 0,
      requestBudget: 4,
      inputTokenBudget: 91_591,
      billing: { status: "not-reported", cost: null },
    };
  },
  probeConfiguredAnswerSubmission: async () => {
    submissionCalls.push(true);
    return { decision: "not-checked", reason: "stubbed at the module boundary" };
  },
}));
vi.mock("../src/doctor-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/doctor-readiness.js")>()),
  inspectDoctorReadiness: async () => ({ status: "ready" }),
  formatDoctorReadiness: () => "DocsFab readiness: ready",
}));
vi.mock("../src/config/runtime-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/runtime-loader.js")>()),
  loadConfig: () => ({ model: validModelConfig, stateDirectory: "/nonexistent/docsfab/runs" }),
}));

const ARGS = ["--live", "--answer-records", "--answer-record-corpus", "/corpus/corpus.json"];

let exitCode: typeof process.exitCode;
let printed: string[];
let errors: string[];
beforeEach(() => {
  exitCode = process.exitCode;
  probeCalls.length = 0;
  planCalls.length = 0;
  diagnosticPlanCalls.length = 0;
  submissionCalls.length = 0;
  printed = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

describe("docsfab doctor --live --answer-records at the CLI", () => {
  it("prints the exact qualification plan without calling the live probe", async () => {
    await handleDoctorCommand([
      "--answer-record-qualification-plan",
      "--answer-record-corpus",
      "/corpus/corpus.json",
      "--answer-record-observation-dir",
      "/retained/answer-record-ledger",
      "--answer-record-typed",
      "--json",
    ]);

    expect(planCalls, JSON.stringify({ planCalls, probeCalls, printed })).toEqual([
      {
        model: validModelConfig,
        options: {
          corpusPath: "/corpus/corpus.json",
          selection: "typed",
          observationDirectory: "/retained/answer-record-ledger",
        },
      },
    ]);
    expect(probeCalls).toHaveLength(0);
    expect(printed.join("\n")).toContain('"plannedInputTokens": 194034');
    expect(printed.join("\n")).toContain('"transportRetries": 0');
  });

  it("prints the provider-free one-cell diagnostic plan without calling the live probe", async () => {
    await handleDoctorCommand([
      "--answer-record-diagnostic-plan",
      "--answer-record-typed",
      "--answer-record-corpus",
      "/corpus/corpus.json",
      "--answer-record-observation-dir",
      "/retained/answer-record-ledger",
    ]);

    expect(diagnosticPlanCalls).toEqual([
      {
        model: validModelConfig,
        options: {
          corpusPath: "/corpus/corpus.json",
          observationDirectory: "/retained/answer-record-ledger",
        },
      },
    ]);
    expect(probeCalls).toHaveLength(0);
    expect(JSON.parse(printed[0]!)).toMatchObject({
      requests: 1,
      transportRetries: 0,
      diagnostic: { diagnosticFingerprint: "d".repeat(64) },
    });
  });

  it("rejects limits with the diagnostic plan before planning or probing", async () => {
    await handleDoctorCommand([
      "--limits",
      "--answer-record-diagnostic-plan",
      "--answer-record-typed",
      "--answer-record-corpus",
      "/corpus/corpus.json",
    ]);

    expect(errors.join("\n")).toContain(
      "doctor --limits cannot be used with an answer-record qualification or diagnostic plan.",
    );
    expect(diagnosticPlanCalls).toHaveLength(0);
    expect(probeCalls).toHaveLength(0);
  });

  it("passes the reviewed fingerprint to the exact live selector", async () => {
    const fingerprint = "a".repeat(64);
    await handleDoctorCommand([
      "--live",
      "--answer-records",
      "--answer-record-corpus",
      "/corpus/corpus.json",
      "--answer-record-typed",
      "--answer-record-qualification-cells",
      "--answer-record-qualification-fingerprint",
      fingerprint,
      "--answer-record-observation-dir",
      "/retained/answer-record-ledger",
      "--json",
    ]);

    expect(probeCalls).toEqual([
      {
        model: validModelConfig,
        corpusPath: "/corpus/corpus.json",
        selection: "typed",
        qualificationCells: true,
        expectedQualificationFingerprint: fingerprint,
        observationDirectory: "/retained/answer-record-ledger",
      },
    ]);
  });

  it("passes only the diagnostic selector and its exact plan fingerprint to the live typed ledger", async () => {
    const fingerprint = "f".repeat(64);
    await handleDoctorCommand([
      "--live",
      "--answer-records",
      "--answer-record-corpus",
      "/corpus/corpus.json",
      "--answer-record-typed",
      "--answer-record-diagnostic-cell",
      "--answer-record-diagnostic-fingerprint",
      fingerprint,
      "--answer-record-observation-dir",
      "/retained/answer-record-ledger",
      "--json",
    ]);

    expect(probeCalls).toEqual([
      {
        model: validModelConfig,
        corpusPath: "/corpus/corpus.json",
        selection: "typed",
        diagnosticCell: true,
        expectedDiagnosticFingerprint: fingerprint,
        observationDirectory: "/retained/answer-record-ledger",
      },
    ]);
  });

  it("runs only the record probe, prints its plan to stderr, and exits 1 when not checked", async () => {
    await handleDoctorCommand([...ARGS]);

    expect(probeCalls).toEqual([
      {
        model: validModelConfig,
        corpusPath: "/corpus/corpus.json",
        selection: "premise",
        observationDirectory: "/nonexistent/docsfab/answer-record-probes",
      },
    ]);
    expect(submissionCalls).toHaveLength(0);
    expect(errors).toEqual([
      "Answer record probe plan: at most 24 requests plus 2 transport retries; input 566454 tokens planned (9 phase B prompts × P=60588: 545292, plus 21162) of 600000 approved. A phase B transport failure cannot be re-sent within that budget and ends the run INCONCLUSIVE.",
    ]);
    expect(printed.join("\n")).toContain("Answer record probe: not checked.");
    expect(process.exitCode).toBe(1);
  });

  it("runs only phase K with --answer-record-small-groups and prints its remainder plan", async () => {
    await handleDoctorCommand([...ARGS, "--answer-record-small-groups"]);

    expect(probeCalls).toEqual([
      {
        model: validModelConfig,
        corpusPath: "/corpus/corpus.json",
        selection: "small-groups",
        // The ledger is the directory the command keeps its observations in.
        observationDirectory: "/nonexistent/docsfab/answer-record-probes",
      },
    ]);
    expect(errors).toEqual([
      "Answer record small-group plan: 6 requests (k = 2 and 3 records per message, each prompt padded to P=60588), plus at most 2 transport re-sends that fit, paid from that remainder and never from the shared transport retries; input 363400 tokens planned, within what the approval has left: 11 requests and 521807 input tokens.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("runs the typed A-t selection and reports that phase G sends nothing", async () => {
    await handleDoctorCommand([...ARGS, "--answer-record-typed"]);
    expect(probeCalls[0]).toMatchObject({ selection: "typed" });
    expect(errors[0]).toContain(
      "9 A-t requests; phase G will not execute (0 requests, request-policy-blocked)",
    );
    expect(printed.join("\n")).toContain("Answer record probe: not checked.");
  });

  it("passes the explicit typed context-screen flag into the existing typed ledger path", async () => {
    await handleDoctorCommand([...ARGS, "--answer-record-typed", "--answer-record-typed-context"]);

    expect(probeCalls).toEqual([
      {
        model: validModelConfig,
        corpusPath: "/corpus/corpus.json",
        selection: "typed",
        typedContextMix: true,
        observationDirectory: "/nonexistent/docsfab/answer-record-probes",
      },
    ]);
    expect(errors[0]).toContain("six P=60588 singleton maxima plus one two-record");
  });

  it("passes the explicit one-group continuation into the typed context probe", async () => {
    await handleDoctorCommand([
      ...ARGS,
      "--answer-record-typed",
      "--answer-record-typed-context",
      "--answer-record-typed-context-group-only",
    ]);

    expect(probeCalls[0]).toMatchObject({
      selection: "typed",
      typedContextMix: true,
      typedContextGroupOnly: true,
    });
    expect(errors[0]).toContain("1 request for the previously unsent two-record");
  });

  it("shows a lock-removal warning beside the verdict, in text and in --json", async () => {
    const warning = {
      code: "answer-record-ledger-lock-not-released",
      message: "The run ended but /state/answer-record-probes/ledger.lock could not be removed.",
    };
    probeWarnings.push(warning);
    try {
      await handleDoctorCommand([...ARGS]);
      expect(printed.join("\n")).toContain(
        `Warning (answer-record-ledger-lock-not-released): ${warning.message}`,
      );
      printed.length = 0;
      await handleDoctorCommand([...ARGS, "--json"]);
      expect(printed).toHaveLength(1);
      expect(JSON.parse(printed[0]!)).toMatchObject({ warnings: [warning] });
    } finally {
      probeWarnings.length = 0;
    }
  });

  it("keeps --json stdout one record", async () => {
    await handleDoctorCommand([...ARGS, "--json"]);

    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0]!)).toMatchObject({
      kind: "docsfab-answer-record-probe-result",
      decision: "not-checked",
    });
  });

  it("refuses --answer-records without --live as a usage error", async () => {
    await expect(handleDoctorCommand(["--answer-records"])).rejects.toMatchObject({
      code: "cli-usage",
      nextAction: "Run docsfab doctor --live --answer-records on its own.",
    });
    expect(probeCalls).toHaveLength(0);
  });
});
