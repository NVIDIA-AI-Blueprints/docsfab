// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  NATIVE_PILOT_ADAPTER_VERSION,
  NATIVE_PILOT_EVIDENCE_CLASS,
  NATIVE_PILOT_MAXIMA,
  NATIVE_PILOT_STEP_OUTPUT_KIND,
  NativePilotContractError,
  parseNativePilotStepOutputV1,
  parseNativePilotStepPlanV1,
  parseNativePilotStepReceiptV1,
  sealNativePilotStepPlanV1,
  sealNativePilotStepReceiptV1,
  type NativePilotHarnessId,
  type NativePilotModelLedgerEntryV1,
  type NativePilotStepPlanV1,
} from "../src/native-compositions/pilot-contracts.js";
import { configureCredential } from "./helpers/configured-credential.js";

const H = (character: string): string => character.repeat(64);

function plan(harnessId: NativePilotHarnessId = "codex"): NativePilotStepPlanV1 {
  const codex = harnessId === "codex";
  const workingDirectory = "/private/docsfab-pilot/scratch/attempt/plan";
  return sealNativePilotStepPlanV1({
    adapterVersion: NATIVE_PILOT_ADAPTER_VERSION,
    evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
    harnessId,
    stepId: "plan-documentation",
    requestedModel: codex ? "gpt-5.6-sol" : "claude-opus-4-7",
    executablePath: codex ? "/opt/docsfab/codex" : "/opt/docsfab/claude",
    executableSha256: H("a"),
    executableIdentitySha256: H("b"),
    reportedVersion: codex ? "codex-cli 0.147.0" : "2.1.226 (Claude Code)",
    workingDirectory,
    workingDirectorySha256: createHash("sha256").update(workingDirectory, "utf8").digest("hex"),
    environment: {
      HOME: "/Users/tester",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/private/docsfab-pilot",
      USER: "tester",
    },
    stdinSha256: H("d"),
    serializedInputSha256: H("d"),
    outputSchemaSha256: H("e"),
    outputSchemaPath: codex ? "/private/docsfab-pilot/schema/plan.json" : null,
    systemPromptSha256: H("f"),
    limits: NATIVE_PILOT_MAXIMA,
  });
}

const CODEX_USAGE = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 0,
  reasoningOutput: 5,
  total: 120,
  effectiveInput: 100,
  accounting: "codex-cache-subset",
} as const;

const CLAUDE_ROOT_USAGE = {
  input: 60,
  output: 15,
  cacheRead: 20,
  cacheWrite: 10,
  reasoningOutput: 0,
  total: 105,
  effectiveInput: 90,
  accounting: "claude-cache-additive",
} as const;

const CLAUDE_AUXILIARY_USAGE = {
  input: 40,
  output: 5,
  cacheRead: 10,
  cacheWrite: 0,
  reasoningOutput: 0,
  total: 55,
  effectiveInput: 50,
  accounting: "claude-cache-additive",
} as const;

const CLAUDE_COMPOSITION_USAGE = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 10,
  reasoningOutput: 0,
  total: 160,
  effectiveInput: 140,
  accounting: "claude-cache-additive",
} as const;

function claudeLedger(): NativePilotModelLedgerEntryV1[] {
  return [
    {
      ordinal: 1,
      role: "internal-orchestration" as const,
      modelId: "claude-haiku-4-5-20251001",
      canonicalModel: "claude-haiku-4-5",
      provider: "firstParty" as const,
      usage: CLAUDE_AUXILIARY_USAGE,
      costUSD: 0.0125,
      outputAuthority: "session-internal-no-independent-authority" as const,
    },
    {
      ordinal: 2,
      role: "primary-output" as const,
      modelId: "claude-opus-4-7",
      canonicalModel: "claude-opus-4-7-20260815",
      provider: "firstParty" as const,
      usage: CLAUDE_ROOT_USAGE,
      costUSD: 0.25,
      outputAuthority: "governed-session-structured-output" as const,
    },
  ];
}

function codexLedger(): NativePilotModelLedgerEntryV1[] {
  return [
    {
      ordinal: 1,
      role: "primary-output" as const,
      modelId: "gpt-5.6-sol",
      canonicalModel: null,
      provider: "firstParty" as const,
      usage: CODEX_USAGE,
      costUSD: null,
      outputAuthority: "governed-session-structured-output" as const,
    },
  ];
}

function receipt(harnessId: NativePilotHarnessId = "codex") {
  const candidate = plan(harnessId);
  const codex = harnessId === "codex";
  const ledger = codex ? codexLedger() : claudeLedger();
  return sealNativePilotStepReceiptV1({
    adapterVersion: NATIVE_PILOT_ADAPTER_VERSION,
    evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
    planSha256: candidate.planSha256,
    harnessId,
    stepId: candidate.stepId,
    outcome: "succeeded",
    requestedModel: candidate.requestedModel,
    observedModel: codex ? null : "claude-opus-4-7",
    observedCanonicalModel: codex ? null : "claude-opus-4-7-20260815",
    sessionSha256: H("1"),
    usage: codex ? CODEX_USAGE : CLAUDE_COMPOSITION_USAGE,
    modelLedger: ledger,
    modelLedgerSha256: canonicalDigest(ledger),
    costUSD: codex ? null : 0.2625,
    compositionAccounting: codex ? "unavailable" : "complete",
    auxiliaryModelCalls: codex ? 0 : 1,
    executable: {
      sha256: candidate.executableSha256,
      identitySha256: candidate.executableIdentitySha256,
      reportedVersion: candidate.reportedVersion,
    },
    workingDirectorySha256: candidate.workingDirectorySha256,
    stdinSha256: candidate.stdinSha256,
    serializedInputSha256: candidate.serializedInputSha256,
    outputSchemaSha256: candidate.outputSchemaSha256,
    outputSha256: H("2"),
    outputPayloadSha256: H("3"),
    summarySha256: H("4"),
    argumentPolicySha256: H("5"),
    environmentPolicySha256: H("6"),
    toolPolicySha256: H("7"),
    featureStatePolicySha256: codex ? H("8") : null,
    durationMs: 123,
    stdinBytes: 80,
    stdoutBytes: 400,
    stderrBytes: 0,
    providerTurns: 1,
    providerRequests: codex ? 1 : 2,
    toolEventCount: 0,
    descendantContainment: "unsupported",
    terminalCode: "completed",
  });
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ name: "NativePilotContractError", code }));
}

describe("native pilot contracts", () => {
  it("seals exact development-only plans and receipts", () => {
    const codex = plan("codex");
    const claude = plan("claude-code");
    expect(parseNativePilotStepPlanV1(codex)).toEqual(codex);
    expect(claude.evidenceClass).toBe("development-only-uncontained");
    expect(parseNativePilotStepReceiptV1(receipt("codex"))).toEqual(receipt("codex"));
    expect(parseNativePilotStepReceiptV1(receipt("claude-code"))).toEqual(receipt("claude-code"));
  });

  it("binds the same exact five-name child environment for both harnesses", () => {
    const codex = plan("codex");
    const claude = plan("claude-code");
    const names = ["HOME", "LANG", "LC_ALL", "TMPDIR", "USER"];
    expect(Object.keys(codex.environment).sort()).toEqual(names);
    expect(Object.keys(claude.environment).sort()).toEqual(names);
    for (const candidate of [codex, claude]) {
      const terminalTitleEnvironment = {
        ...candidate.environment,
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      };
      expectCode(
        () =>
          sealNativePilotStepPlanV1({
            ...body(candidate),
            environment: terminalTitleEnvironment,
          }),
        "invalid-shape",
      );
      const extraEnvironment = { ...candidate.environment, EXTRA: "1" };
      expectCode(
        () =>
          sealNativePilotStepPlanV1({
            ...body(candidate),
            environment: extraEnvironment,
          }),
        "invalid-shape",
      );
    }
  });

  it("admits a bounded ordered auxiliary ledger charged to the composition", () => {
    const sealed = parseNativePilotStepReceiptV1(receipt("claude-code"));
    expect(sealed.providerRequests).toBe(2);
    expect(sealed.auxiliaryModelCalls).toBe(1);
    expect(sealed.modelLedger.map((entry) => entry.modelId)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-4-7",
    ]);
    expect(sealed.modelLedger[0]?.outputAuthority).toBe(
      "session-internal-no-independent-authority",
    );
    expect(sealed.modelLedger[1]?.outputAuthority).toBe("governed-session-structured-output");
    expect(sealed.usage.total).toBe(160);
    expect(sealed.costUSD).toBeCloseTo(0.2625, 10);
    expect(sealed.compositionAccounting).toBe("complete");
  });

  it("rejects ledger drift, root substitution, and undercounted requests", () => {
    const claude = receipt("claude-code");
    const attacks: Array<{ code: string; mutate: (value: Record<string, unknown>) => void }> = [
      {
        code: "invalid-shape",
        mutate: (value) => {
          value.modelLedger = claudeLedger().slice(1);
        },
      },
      {
        code: "model-identity-mismatch",
        mutate: (value) => {
          value.modelLedger = claudeLedger()
            .reverse()
            .map((entry, index) => ({
              ...entry,
              ordinal: index + 1,
            }));
        },
      },
      {
        code: "model-identity-mismatch",
        mutate: (value) => {
          const ledger = claudeLedger();
          const auxiliary = ledger[0];
          if (!auxiliary) throw new Error("Claude ledger fixture requires an auxiliary entry.");
          ledger[0] = { ...auxiliary, canonicalModel: "claude-opus-4-7-20260815" };
          value.modelLedger = ledger;
          value.modelLedgerSha256 = canonicalDigest(ledger);
        },
      },
      {
        code: "budget-mismatch",
        mutate: (value) => {
          const ledger = claudeLedger();
          const auxiliary = ledger[0];
          if (!auxiliary) throw new Error("Claude ledger fixture requires an auxiliary entry.");
          ledger[0] = {
            ...auxiliary,
            usage: { ...CLAUDE_AUXILIARY_USAGE, input: 41, total: 56, effectiveInput: 51 },
          };
          value.modelLedger = ledger;
          value.modelLedgerSha256 = canonicalDigest(ledger);
        },
      },
      {
        code: "budget-mismatch",
        mutate: (value) => {
          value.auxiliaryModelCalls = 0;
        },
      },
      {
        code: "digest-mismatch",
        mutate: (value) => {
          value.modelLedgerSha256 = H("c");
        },
      },
      {
        code: "invalid-value",
        mutate: (value) => {
          value.providerRequests = 0;
        },
      },
    ];
    for (const attack of attacks) {
      const candidate: Record<string, unknown> = { ...claude };
      attack.mutate(candidate);
      expectCode(() => parseNativePilotStepReceiptV1(candidate), attack.code);
    }
  });

  it("rejects plan digest, model, path, environment, and evidence-class drift", () => {
    const sealed = plan("codex");
    expectCode(
      () => parseNativePilotStepPlanV1({ ...sealed, planSha256: H("9") }),
      "digest-mismatch",
    );
    expectCode(
      () =>
        sealNativePilotStepPlanV1({
          ...body(sealed),
          requestedModel: "claude-opus-4-7",
        }),
      "model-identity-mismatch",
    );
    expectCode(
      () => sealNativePilotStepPlanV1({ ...body(sealed), workingDirectory: "/Users/tester" }),
      "path-policy",
    );
    expectCode(
      () =>
        sealNativePilotStepPlanV1({
          ...body(sealed),
          environment: {
            ...sealed.environment,
            OPENAI_API_KEY: configureCredential(`sk-${"Xq7Lm2Rt9Wk4Hn3BvC8zPd5GJf6STw1Y"}`),
          } as never,
        }),
      "credential-material",
    );
    expectCode(
      () =>
        sealNativePilotStepPlanV1({
          ...body(sealed),
          evidenceClass: "qualified" as never,
        }),
      "invalid-value",
    );
  });

  it("strictly decodes role and writer outputs", () => {
    const planOutput = parseNativePilotStepOutputV1(
      {
        schemaVersion: 1,
        kind: NATIVE_PILOT_STEP_OUTPUT_KIND,
        stepId: "plan-documentation",
        outcome: "succeeded",
        summary: "Grounded plan.",
        payload: { kind: "plan", content: "Use the approved routing sources." },
        document: null,
      },
      "plan-documentation",
    );
    expect(planOutput.payload?.kind).toBe("plan");

    const writer = parseNativePilotStepOutputV1(
      {
        schemaVersion: 1,
        kind: NATIVE_PILOT_STEP_OUTPUT_KIND,
        stepId: "write-documentation",
        outcome: "succeeded",
        summary: "Drafted one guide.",
        payload: null,
        document: { path: "docs/routing/guide.md", content: "---\ntitle: Routing\n---\n" },
      },
      "write-documentation",
    );
    expect(writer.document?.path).toBe("docs/routing/guide.md");
  });

  it("rejects output substitution, unknown keys, and credential material", () => {
    const base = {
      schemaVersion: 1,
      kind: NATIVE_PILOT_STEP_OUTPUT_KIND,
      stepId: "write-documentation",
      outcome: "succeeded",
      summary: "Drafted.",
      payload: null,
      document: { path: "docs/routing/guide.md", content: "safe" },
    };
    expectCode(
      () =>
        parseNativePilotStepOutputV1(
          { ...base, document: { path: "docs/index.md", content: "safe" } },
          "write-documentation",
        ),
      "invalid-value",
    );
    expectCode(
      () => parseNativePilotStepOutputV1({ ...base, extra: true }, "write-documentation"),
      "invalid-shape",
    );
    const secret = configureCredential(`sk-${"Zr4Kp8Wm2Nq6Lt9Hv3Bx7Cy5Dj1Gs0Fe"}`);
    expectCode(
      () =>
        parseNativePilotStepOutputV1(
          { ...base, document: { path: "docs/routing/guide.md", content: secret } },
          "write-documentation",
        ),
      "credential-material",
    );
  });

  it("rejects invalid usage accounting and receipt authority upgrades", () => {
    const valid = receipt("claude-code");
    expectCode(
      () =>
        sealNativePilotStepReceiptV1({
          ...receiptBody(valid),
          usage: { ...valid.usage, effectiveInput: valid.usage.input },
        }),
      "budget-mismatch",
    );
    expectCode(
      () =>
        sealNativePilotStepReceiptV1({
          ...receiptBody(valid),
          evidenceClass: "release" as never,
        }),
      "invalid-value",
    );
  });

  it("uses content-free contract errors", () => {
    const raw = configureCredential(`sk-${"Qa2Ws4Ed6Rf8Tg0Yh1Uj3Ik5Ol7Pz9Xc"}`);
    let caught: unknown;
    try {
      parseNativePilotStepOutputV1(
        {
          schemaVersion: 1,
          kind: NATIVE_PILOT_STEP_OUTPUT_KIND,
          stepId: "plan-documentation",
          outcome: "succeeded",
          summary: raw,
          payload: { kind: "plan", content: "safe" },
          document: null,
        },
        "plan-documentation",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativePilotContractError);
    expect(String(caught)).not.toContain(raw);
  });
});

function body(planValue: NativePilotStepPlanV1) {
  const { schemaVersion: _schemaVersion, kind: _kind, planSha256: _digest, ...result } = planValue;
  return result;
}

function receiptBody(value: ReturnType<typeof receipt>) {
  const { schemaVersion: _schemaVersion, kind: _kind, receiptSha256: _digest, ...result } = value;
  return result;
}
