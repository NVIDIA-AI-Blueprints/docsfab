// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalDigest, createContractKit, deepFreeze } from "../contract-kit/index.js";
import { sha256 } from "../content-ir/canonical.js";

export const NATIVE_PILOT_ADAPTER_VERSION = "1.0.0" as const;
export const NATIVE_PILOT_EVIDENCE_CLASS = "development-only-uncontained" as const;
const NATIVE_PILOT_STEP_PLAN_KIND = "docsfab-native-pilot-step-plan" as const;
export const NATIVE_PILOT_STEP_OUTPUT_KIND = "docsfab-native-pilot-step-output" as const;
export const NATIVE_PILOT_STEP_RECEIPT_KIND = "docsfab-native-pilot-step-receipt" as const;

export const NATIVE_PILOT_ENVIRONMENT_NAMES = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "USER",
] as const);
// Both native child environments are exactly the five names above. The harness
// is invoked as an operator would invoke it, and Claude's background auxiliary
// title request is admitted as bounded session-internal orchestration.
export const NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP = 4;

export const NATIVE_PILOT_STEP_IDS = Object.freeze([
  "plan-documentation",
  "write-documentation",
  "lint-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "evaluate-document-quality",
] as const);

export const NATIVE_PILOT_FAILURE_CODES = Object.freeze([
  "invalid-shape",
  "invalid-value",
  "schema-mismatch",
  "migration-required",
  "digest-mismatch",
  "credential-material",
  "environment-policy",
  "path-policy",
  "executable-policy",
  "invocation-policy",
  "feature-state-mismatch",
  "diagnostic-mismatch",
  "rate-limit-event-mismatch",
  "retry-event-mismatch",
  "retry-policy-mismatch",
  "provider-retry-blocked",
  "provider-request-count-mismatch",
  "late-stream-event",
  "claude-stream-guard-required",
  "claude-stream-success-invalid",
  "process-not-settled",
  "process-failed",
  "spawn-failed",
  "timeout",
  "cancelled",
  "output-limit",
  "malformed-stream",
  "malformed-output",
  "unexpected-tool-activity",
  "model-identity-mismatch",
  "session-mismatch",
  "working-directory-mismatch",
  "budget-mismatch",
] as const);

export const NATIVE_PILOT_MAXIMA = Object.freeze({
  maxStdinBytes: 2 * 1024 * 1024,
  maxOutputSchemaBytes: 64 * 1024,
  maxStdoutBytes: 65_536,
  maxStderrBytes: 65_536,
  maxResponseBytes: 65_536,
  timeoutMs: 300_000,
  maxInputTokens: 65_536,
  maxOutputTokens: 8_192,
  maxProviderTurns: 1,
});

export type NativePilotHarnessId = "codex" | "claude-code";
export type NativePilotStepId = (typeof NATIVE_PILOT_STEP_IDS)[number];
export type NativePilotFailureCode = (typeof NATIVE_PILOT_FAILURE_CODES)[number];
export type NativePilotOutcome = "succeeded" | "needs-input" | "needs-human-decision";
export type NativePilotEnvironmentV1 = Readonly<
  Record<(typeof NATIVE_PILOT_ENVIRONMENT_NAMES)[number], string>
>;

export interface NativePilotLimitsV1 {
  readonly maxStdinBytes: number;
  readonly maxOutputSchemaBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxProviderTurns: 1;
}

export interface NativePilotExecutableIdentityV1 {
  readonly sha256: string;
  readonly identitySha256: string;
  readonly reportedVersion: string;
}

export interface NativePilotStepPlanV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof NATIVE_PILOT_STEP_PLAN_KIND;
  readonly adapterVersion: typeof NATIVE_PILOT_ADAPTER_VERSION;
  readonly evidenceClass: typeof NATIVE_PILOT_EVIDENCE_CLASS;
  readonly harnessId: NativePilotHarnessId;
  readonly stepId: NativePilotStepId;
  readonly requestedModel: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly executableIdentitySha256: string;
  readonly reportedVersion: string;
  readonly workingDirectory: string;
  readonly workingDirectorySha256: string;
  readonly environment: NativePilotEnvironmentV1;
  readonly stdinSha256: string;
  readonly serializedInputSha256: string;
  readonly outputSchemaSha256: string;
  readonly outputSchemaPath: string | null;
  readonly systemPromptSha256: string;
  readonly limits: NativePilotLimitsV1;
  readonly planSha256: string;
}

export interface NativePilotUsageV1 {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoningOutput: number;
  readonly total: number;
  readonly effectiveInput: number;
  readonly accounting: "codex-cache-subset" | "claude-cache-additive";
}

// One ordered entry per first-party model the governed session actually charged.
// The last entry is always the requested root model that emitted and bound the
// strict structured output; every earlier entry is bounded session-internal
// orchestration with no repository, external-tool, or output authority.
export interface NativePilotModelLedgerEntryV1 {
  readonly ordinal: number;
  readonly role: "primary-output" | "internal-orchestration";
  readonly modelId: string;
  readonly canonicalModel: string | null;
  readonly provider: "firstParty";
  readonly usage: NativePilotUsageV1;
  readonly costUSD: number | null;
  readonly outputAuthority:
    | "governed-session-structured-output"
    | "session-internal-no-independent-authority";
}

export interface NativePilotStepOutputV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof NATIVE_PILOT_STEP_OUTPUT_KIND;
  readonly stepId: NativePilotStepId;
  readonly outcome: NativePilotOutcome;
  readonly summary: string;
  readonly payload: {
    readonly kind:
      | "plan"
      | "lint-findings"
      | "technical-findings"
      | "editorial-findings"
      | "quality-evaluation";
    readonly content: string;
  } | null;
  readonly document: {
    readonly path: "docs/routing/guide.md";
    readonly content: string;
  } | null;
}

export interface NativePilotStepReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof NATIVE_PILOT_STEP_RECEIPT_KIND;
  readonly adapterVersion: typeof NATIVE_PILOT_ADAPTER_VERSION;
  readonly evidenceClass: typeof NATIVE_PILOT_EVIDENCE_CLASS;
  readonly planSha256: string;
  readonly harnessId: NativePilotHarnessId;
  readonly stepId: NativePilotStepId;
  readonly outcome: NativePilotOutcome;
  readonly requestedModel: string;
  readonly observedModel: string | null;
  readonly observedCanonicalModel: string | null;
  readonly sessionSha256: string;
  readonly usage: NativePilotUsageV1;
  readonly modelLedger: readonly NativePilotModelLedgerEntryV1[];
  readonly modelLedgerSha256: string;
  readonly costUSD: number | null;
  readonly compositionAccounting: "complete" | "partial" | "unavailable";
  readonly auxiliaryModelCalls: number;
  readonly executable: NativePilotExecutableIdentityV1;
  readonly workingDirectorySha256: string;
  readonly stdinSha256: string;
  readonly serializedInputSha256: string;
  readonly outputSchemaSha256: string;
  readonly outputSha256: string;
  readonly outputPayloadSha256: string;
  readonly summarySha256: string;
  readonly argumentPolicySha256: string;
  readonly environmentPolicySha256: string;
  readonly toolPolicySha256: string;
  readonly featureStatePolicySha256: string | null;
  readonly durationMs: number;
  readonly stdinBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly providerTurns: 1;
  readonly providerRequests: number;
  readonly toolEventCount: 0;
  readonly descendantContainment: "unsupported";
  readonly terminalCode: "completed";
  readonly receiptSha256: string;
}

export type NativePilotContractErrorCode = NativePilotFailureCode;

export class NativePilotContractError extends Error {
  public constructor(public readonly code: NativePilotContractErrorCode) {
    super(`Native pilot contract rejected (${code}).`);
    this.name = "NativePilotContractError";
  }
}

function fail(code: NativePilotContractErrorCode): never {
  throw new NativePilotContractError(code);
}

const kit = createContractKit<NativePilotContractErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const PLAN_BODY_KEYS = [
  "adapterVersion",
  "evidenceClass",
  "harnessId",
  "stepId",
  "requestedModel",
  "executablePath",
  "executableSha256",
  "executableIdentitySha256",
  "reportedVersion",
  "workingDirectory",
  "workingDirectorySha256",
  "environment",
  "stdinSha256",
  "serializedInputSha256",
  "outputSchemaSha256",
  "outputSchemaPath",
  "systemPromptSha256",
  "limits",
] as const;

const RECEIPT_BODY_KEYS = [
  "adapterVersion",
  "evidenceClass",
  "planSha256",
  "harnessId",
  "stepId",
  "outcome",
  "requestedModel",
  "observedModel",
  "observedCanonicalModel",
  "sessionSha256",
  "usage",
  "modelLedger",
  "modelLedgerSha256",
  "costUSD",
  "compositionAccounting",
  "auxiliaryModelCalls",
  "executable",
  "workingDirectorySha256",
  "stdinSha256",
  "serializedInputSha256",
  "outputSchemaSha256",
  "outputSha256",
  "outputPayloadSha256",
  "summarySha256",
  "argumentPolicySha256",
  "environmentPolicySha256",
  "toolPolicySha256",
  "featureStatePolicySha256",
  "durationMs",
  "stdinBytes",
  "stdoutBytes",
  "stderrBytes",
  "providerTurns",
  "providerRequests",
  "toolEventCount",
  "descendantContainment",
  "terminalCode",
] as const;

export function sealNativePilotStepPlanV1(
  body: Omit<NativePilotStepPlanV1, "schemaVersion" | "kind" | "planSha256">,
): NativePilotStepPlanV1 {
  return parseNativePilotStepPlanV1(kit.seal(NATIVE_PILOT_STEP_PLAN_KIND, "planSha256", body));
}

export function parseNativePilotStepPlanV1(value: unknown): NativePilotStepPlanV1 {
  return kit.decodeSealed(
    value,
    NATIVE_PILOT_STEP_PLAN_KIND,
    "planSha256",
    [...PLAN_BODY_KEYS],
    normalizePlanBody,
  ) as NativePilotStepPlanV1;
}

export function parseNativePilotStepOutputV1(
  value: unknown,
  expectedStepId: NativePilotStepId,
): NativePilotStepOutputV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", "stepId", "outcome", "summary", "payload", "document"]);
  if (root.schemaVersion !== 1 || root.kind !== NATIVE_PILOT_STEP_OUTPUT_KIND) {
    fail("schema-mismatch");
  }
  const stepId = kit.enumeration(root.stepId, NATIVE_PILOT_STEP_IDS);
  if (stepId !== expectedStepId) fail("invalid-value");
  const outcome = kit.enumeration(root.outcome, [
    "succeeded",
    "needs-input",
    "needs-human-decision",
  ] as const);
  const summary = boundedText(root.summary, 8_192);
  const write = stepId === "write-documentation";
  if (write) {
    if (root.payload !== null) fail("invalid-value");
    const document = kit.object(root.document);
    kit.exact(document, ["path", "content"]);
    if (document.path !== "docs/routing/guide.md") fail("invalid-value");
    return deepFreeze({
      schemaVersion: 1,
      kind: NATIVE_PILOT_STEP_OUTPUT_KIND,
      stepId,
      outcome,
      summary,
      payload: null,
      document: {
        path: "docs/routing/guide.md",
        content: boundedText(document.content, NATIVE_PILOT_MAXIMA.maxResponseBytes),
      },
    });
  }
  if (root.document !== null) fail("invalid-value");
  const payload = kit.object(root.payload);
  kit.exact(payload, ["kind", "content"]);
  const expectedPayloadKind = payloadKindForStep(stepId);
  if (payload.kind !== expectedPayloadKind) fail("invalid-value");
  return deepFreeze({
    schemaVersion: 1,
    kind: NATIVE_PILOT_STEP_OUTPUT_KIND,
    stepId,
    outcome,
    summary,
    payload: {
      kind: expectedPayloadKind,
      content: boundedText(payload.content, NATIVE_PILOT_MAXIMA.maxResponseBytes),
    },
    document: null,
  });
}

export function sealNativePilotStepReceiptV1(
  body: Omit<NativePilotStepReceiptV1, "schemaVersion" | "kind" | "receiptSha256">,
): NativePilotStepReceiptV1 {
  return parseNativePilotStepReceiptV1(
    kit.seal(NATIVE_PILOT_STEP_RECEIPT_KIND, "receiptSha256", body),
  );
}

export function parseNativePilotStepReceiptV1(value: unknown): NativePilotStepReceiptV1 {
  return kit.decodeSealed(
    value,
    NATIVE_PILOT_STEP_RECEIPT_KIND,
    "receiptSha256",
    [...RECEIPT_BODY_KEYS],
    normalizeReceiptBody,
  ) as NativePilotStepReceiptV1;
}

function normalizePlanBody(root: Record<string, unknown>) {
  if (
    root.adapterVersion !== NATIVE_PILOT_ADAPTER_VERSION ||
    root.evidenceClass !== NATIVE_PILOT_EVIDENCE_CLASS
  ) {
    fail("invalid-value");
  }
  const harnessId = kit.enumeration(root.harnessId, ["codex", "claude-code"] as const);
  const requestedModel = boundedIdentifier(root.requestedModel, 128);
  if (
    (harnessId === "codex" && requestedModel !== "gpt-5.6-sol") ||
    (harnessId === "claude-code" && requestedModel !== "claude-opus-4-7")
  ) {
    fail("model-identity-mismatch");
  }
  const executablePath = canonicalAbsolutePath(root.executablePath);
  const workingDirectory = canonicalAbsolutePath(root.workingDirectory);
  const environment = normalizeEnvironment(root.environment, harnessId);
  if (
    workingDirectory === environment.HOME ||
    !inside(environment.TMPDIR, workingDirectory) ||
    root.workingDirectorySha256 !== sha256(workingDirectory) ||
    root.stdinSha256 !== root.serializedInputSha256
  ) {
    fail("path-policy");
  }
  const outputSchemaPath =
    root.outputSchemaPath === null ? null : canonicalAbsolutePath(root.outputSchemaPath);
  if (
    (harnessId === "codex" &&
      (outputSchemaPath === null || !inside(environment.TMPDIR, outputSchemaPath))) ||
    (harnessId === "claude-code" && outputSchemaPath !== null)
  ) {
    fail("path-policy");
  }
  return {
    adapterVersion: NATIVE_PILOT_ADAPTER_VERSION,
    evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
    harnessId,
    stepId: kit.enumeration(root.stepId, NATIVE_PILOT_STEP_IDS),
    requestedModel,
    executablePath,
    executableSha256: kit.hash(root.executableSha256),
    executableIdentitySha256: kit.hash(root.executableIdentitySha256),
    reportedVersion: boundedSingleLine(root.reportedVersion, 128),
    workingDirectory,
    workingDirectorySha256: kit.hash(root.workingDirectorySha256),
    environment,
    stdinSha256: kit.hash(root.stdinSha256),
    serializedInputSha256: kit.hash(root.serializedInputSha256),
    outputSchemaSha256: kit.hash(root.outputSchemaSha256),
    outputSchemaPath,
    systemPromptSha256: kit.hash(root.systemPromptSha256),
    limits: normalizeLimits(root.limits),
  };
}

function payloadKindForStep(
  stepId: Exclude<NativePilotStepId, "write-documentation">,
): NonNullable<NativePilotStepOutputV1["payload"]>["kind"] {
  switch (stepId) {
    case "plan-documentation":
      return "plan";
    case "lint-documentation":
      return "lint-findings";
    case "verify-technical-accuracy":
      return "technical-findings";
    case "review-documentation":
      return "editorial-findings";
    case "evaluate-document-quality":
      return "quality-evaluation";
  }
}

function normalizeReceiptBody(root: Record<string, unknown>) {
  if (
    root.adapterVersion !== NATIVE_PILOT_ADAPTER_VERSION ||
    root.evidenceClass !== NATIVE_PILOT_EVIDENCE_CLASS ||
    root.providerTurns !== 1 ||
    root.toolEventCount !== 0 ||
    root.descendantContainment !== "unsupported" ||
    root.terminalCode !== "completed"
  ) {
    fail("invalid-value");
  }
  const providerRequests = boundedInteger(
    root.providerRequests,
    1,
    NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP,
  );
  const harnessId = kit.enumeration(root.harnessId, ["codex", "claude-code"] as const);
  const requestedModel = boundedIdentifier(root.requestedModel, 128);
  const observedModel =
    root.observedModel === null ? null : boundedIdentifier(root.observedModel, 256);
  const observedCanonicalModel =
    root.observedCanonicalModel === null
      ? null
      : boundedIdentifier(root.observedCanonicalModel, 256);
  const featureStatePolicySha256 = kit.nullableHash(root.featureStatePolicySha256);
  if (
    (harnessId === "codex" &&
      (requestedModel !== "gpt-5.6-sol" ||
        observedModel !== null ||
        observedCanonicalModel !== null ||
        featureStatePolicySha256 === null)) ||
    (harnessId === "claude-code" &&
      (requestedModel !== "claude-opus-4-7" ||
        observedModel !== requestedModel ||
        featureStatePolicySha256 !== null))
  ) {
    fail("model-identity-mismatch");
  }
  const usage = normalizeUsage(root.usage, harnessId);
  const modelLedger = normalizeModelLedger(root.modelLedger, {
    harnessId,
    requestedModel,
    observedCanonicalModel,
    providerRequests,
    compositionUsage: usage,
  });
  if (kit.hash(root.modelLedgerSha256) !== canonicalDigest(modelLedger)) fail("digest-mismatch");
  const costUSD = root.costUSD === null ? null : boundedCost(root.costUSD);
  const compositionAccounting = kit.enumeration(root.compositionAccounting, [
    "complete",
    "partial",
    "unavailable",
  ] as const);
  if (
    boundedInteger(root.auxiliaryModelCalls, 0, NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP - 1) !==
      providerRequests - 1 ||
    (compositionAccounting === "complete" && costUSD === null) ||
    (compositionAccounting === "unavailable" && costUSD !== null)
  ) {
    fail("budget-mismatch");
  }
  const executable = kit.object(root.executable);
  kit.exact(executable, ["sha256", "identitySha256", "reportedVersion"]);
  return {
    adapterVersion: NATIVE_PILOT_ADAPTER_VERSION,
    evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
    planSha256: kit.hash(root.planSha256),
    harnessId,
    stepId: kit.enumeration(root.stepId, NATIVE_PILOT_STEP_IDS),
    outcome: kit.enumeration(root.outcome, [
      "succeeded",
      "needs-input",
      "needs-human-decision",
    ] as const),
    requestedModel,
    observedModel,
    observedCanonicalModel,
    sessionSha256: kit.hash(root.sessionSha256),
    usage,
    modelLedger,
    modelLedgerSha256: canonicalDigest(modelLedger),
    costUSD,
    compositionAccounting,
    auxiliaryModelCalls: providerRequests - 1,
    executable: {
      sha256: kit.hash(executable.sha256),
      identitySha256: kit.hash(executable.identitySha256),
      reportedVersion: boundedSingleLine(executable.reportedVersion, 128),
    },
    workingDirectorySha256: kit.hash(root.workingDirectorySha256),
    stdinSha256: kit.hash(root.stdinSha256),
    serializedInputSha256: kit.hash(root.serializedInputSha256),
    outputSchemaSha256: kit.hash(root.outputSchemaSha256),
    outputSha256: kit.hash(root.outputSha256),
    outputPayloadSha256: kit.hash(root.outputPayloadSha256),
    summarySha256: kit.hash(root.summarySha256),
    argumentPolicySha256: kit.hash(root.argumentPolicySha256),
    environmentPolicySha256: kit.hash(root.environmentPolicySha256),
    toolPolicySha256: kit.hash(root.toolPolicySha256),
    featureStatePolicySha256,
    durationMs: boundedInteger(root.durationMs, 0, NATIVE_PILOT_MAXIMA.timeoutMs + 30_000),
    stdinBytes: boundedInteger(root.stdinBytes, 0, NATIVE_PILOT_MAXIMA.maxStdinBytes),
    stdoutBytes: boundedInteger(root.stdoutBytes, 0, NATIVE_PILOT_MAXIMA.maxStdoutBytes),
    stderrBytes: boundedInteger(root.stderrBytes, 0, NATIVE_PILOT_MAXIMA.maxStderrBytes),
    providerTurns: 1 as const,
    providerRequests,
    toolEventCount: 0 as const,
    descendantContainment: "unsupported" as const,
    terminalCode: "completed" as const,
  };
}

function boundedCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000) {
    fail("budget-mismatch");
  }
  return value;
}

interface ModelLedgerExpectation {
  readonly harnessId: NativePilotHarnessId;
  readonly requestedModel: string;
  readonly observedCanonicalModel: string | null;
  readonly providerRequests: number;
  readonly compositionUsage: NativePilotUsageV1;
}

function normalizeModelLedger(
  value: unknown,
  expectation: ModelLedgerExpectation,
): readonly NativePilotModelLedgerEntryV1[] {
  if (!Array.isArray(value) || value.length !== expectation.providerRequests) {
    fail("invalid-shape");
  }
  const aggregate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0 };
  const canonicalModels = new Set<string>();
  const modelIds = new Set<string>();
  const entries = value.map((item, index) => {
    const entry = kit.object(item);
    kit.exact(entry, [
      "ordinal",
      "role",
      "modelId",
      "canonicalModel",
      "provider",
      "usage",
      "costUSD",
      "outputAuthority",
    ]);
    const primary = index === value.length - 1;
    const modelId = boundedIdentifier(entry.modelId, 256);
    const canonicalModel =
      entry.canonicalModel === null ? null : boundedIdentifier(entry.canonicalModel, 256);
    if (
      entry.ordinal !== index + 1 ||
      entry.provider !== "firstParty" ||
      entry.role !== (primary ? "primary-output" : "internal-orchestration") ||
      entry.outputAuthority !==
        (primary
          ? "governed-session-structured-output"
          : "session-internal-no-independent-authority") ||
      (primary && modelId !== expectation.requestedModel) ||
      (!primary && modelId === expectation.requestedModel) ||
      (!primary && canonicalModel === expectation.requestedModel) ||
      (primary && canonicalModel !== expectation.observedCanonicalModel) ||
      modelIds.has(modelId) ||
      (canonicalModel !== null && canonicalModels.has(canonicalModel))
    ) {
      fail("model-identity-mismatch");
    }
    modelIds.add(modelId);
    if (canonicalModel !== null) canonicalModels.add(canonicalModel);
    const usage = normalizeUsage(entry.usage, expectation.harnessId);
    aggregate.input += usage.input;
    aggregate.output += usage.output;
    aggregate.cacheRead += usage.cacheRead;
    aggregate.cacheWrite += usage.cacheWrite;
    aggregate.reasoningOutput += usage.reasoningOutput;
    return {
      ordinal: index + 1,
      role: entry.role as NativePilotModelLedgerEntryV1["role"],
      modelId,
      canonicalModel,
      provider: "firstParty" as const,
      usage,
      costUSD: entry.costUSD === null ? null : boundedCost(entry.costUSD),
      outputAuthority: entry.outputAuthority as NativePilotModelLedgerEntryV1["outputAuthority"],
    };
  });
  const composition = expectation.compositionUsage;
  if (
    aggregate.input !== composition.input ||
    aggregate.output !== composition.output ||
    aggregate.cacheRead !== composition.cacheRead ||
    aggregate.cacheWrite !== composition.cacheWrite ||
    aggregate.reasoningOutput !== composition.reasoningOutput
  ) {
    fail("budget-mismatch");
  }
  return deepFreeze(entries);
}

function normalizeEnvironment(value: unknown, _harnessId: NativePilotHarnessId) {
  const environment = kit.object(value);
  kit.exact(environment, [...NATIVE_PILOT_ENVIRONMENT_NAMES]);
  const home = canonicalAbsolutePath(environment.HOME);
  const tmp = canonicalAbsolutePath(environment.TMPDIR);
  const lang = locale(environment.LANG);
  const lcAll = locale(environment.LC_ALL);
  const user = username(environment.USER);
  return deepFreeze({ HOME: home, LANG: lang, LC_ALL: lcAll, TMPDIR: tmp, USER: user });
}

function normalizeLimits(value: unknown): NativePilotLimitsV1 {
  const limits = kit.object(value);
  kit.exact(limits, Object.keys(NATIVE_PILOT_MAXIMA));
  const result: NativePilotLimitsV1 = {
    maxStdinBytes: boundedInteger(limits.maxStdinBytes, 1, NATIVE_PILOT_MAXIMA.maxStdinBytes),
    maxOutputSchemaBytes: boundedInteger(
      limits.maxOutputSchemaBytes,
      2,
      NATIVE_PILOT_MAXIMA.maxOutputSchemaBytes,
    ),
    maxStdoutBytes: boundedInteger(limits.maxStdoutBytes, 1, NATIVE_PILOT_MAXIMA.maxStdoutBytes),
    maxStderrBytes: boundedInteger(limits.maxStderrBytes, 1, NATIVE_PILOT_MAXIMA.maxStderrBytes),
    maxResponseBytes: boundedInteger(
      limits.maxResponseBytes,
      1,
      NATIVE_PILOT_MAXIMA.maxResponseBytes,
    ),
    timeoutMs: boundedInteger(limits.timeoutMs, 1, NATIVE_PILOT_MAXIMA.timeoutMs),
    maxInputTokens: boundedInteger(limits.maxInputTokens, 1, NATIVE_PILOT_MAXIMA.maxInputTokens),
    maxOutputTokens: boundedInteger(limits.maxOutputTokens, 1, NATIVE_PILOT_MAXIMA.maxOutputTokens),
    maxProviderTurns: 1,
  };
  if (limits.maxProviderTurns !== 1) fail("invalid-value");
  return deepFreeze(result);
}

function normalizeUsage(value: unknown, harnessId: NativePilotHarnessId): NativePilotUsageV1 {
  const usage = kit.object(value);
  kit.exact(usage, [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoningOutput",
    "total",
    "effectiveInput",
    "accounting",
  ]);
  const input = boundedInteger(usage.input, 0, Number.MAX_SAFE_INTEGER);
  const output = boundedInteger(usage.output, 0, Number.MAX_SAFE_INTEGER);
  const cacheRead = boundedInteger(usage.cacheRead, 0, Number.MAX_SAFE_INTEGER);
  const cacheWrite = boundedInteger(usage.cacheWrite, 0, Number.MAX_SAFE_INTEGER);
  const reasoningOutput = boundedInteger(usage.reasoningOutput, 0, Number.MAX_SAFE_INTEGER);
  const total = boundedInteger(usage.total, 0, Number.MAX_SAFE_INTEGER);
  const effectiveInput = boundedInteger(usage.effectiveInput, 0, Number.MAX_SAFE_INTEGER);
  const accounting = kit.enumeration(usage.accounting, [
    "codex-cache-subset",
    "claude-cache-additive",
  ] as const);
  const expectedAccounting = harnessId === "codex" ? "codex-cache-subset" : "claude-cache-additive";
  const expectedEffectiveInput =
    accounting === "codex-cache-subset" ? input : input + cacheRead + cacheWrite;
  const expectedTotal =
    accounting === "codex-cache-subset" ? input + output : expectedEffectiveInput + output;
  if (
    accounting !== expectedAccounting ||
    effectiveInput !== expectedEffectiveInput ||
    total !== expectedTotal ||
    reasoningOutput > output ||
    (accounting === "codex-cache-subset" && cacheRead > input) ||
    effectiveInput > NATIVE_PILOT_MAXIMA.maxInputTokens ||
    output > NATIVE_PILOT_MAXIMA.maxOutputTokens
  ) {
    fail("budget-mismatch");
  }
  return deepFreeze({
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoningOutput,
    total,
    effectiveInput,
    accounting,
  });
}

function boundedIdentifier(value: unknown, maximum: number): string {
  const result = kit.identifier(value);
  if (result.length > maximum) fail("invalid-value");
  return result;
}

function boundedText(value: unknown, maximum: number): string {
  const result = kit.string(value);
  if (result.length < 1 || result.length > maximum) fail("invalid-value");
  return result;
}

function boundedSingleLine(value: unknown, maximum: number): string {
  const result = boundedText(value, maximum);
  if (/\r|\n/u.test(result)) fail("invalid-value");
  return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("invalid-value");
  }
  return value as number;
}

function canonicalAbsolutePath(value: unknown): string {
  const result = boundedText(value, 4_096);
  if (!isAbsolute(result) || resolve(result) !== result) fail("path-policy");
  return result;
}

function locale(value: unknown): string {
  const result = boundedText(value, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(result)) fail("environment-policy");
  return result;
}

function username(value: unknown): string {
  const result = boundedText(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u.test(result)) fail("environment-policy");
  return result;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
