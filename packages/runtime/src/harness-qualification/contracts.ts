// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, deepFreeze } from "../contract-kit/index.js";

export const HARNESS_ATTESTATION_KIND = "docsfab-harness-attestation" as const;
export const HARNESS_ADAPTER_VERSION = "1.0.0" as const;

export const HARNESS_QUALIFICATION_FAILURE_CODES = [
  "unsupported-confinement",
  "unsupported-ambient-policy",
  "harness-identity-mismatch",
  "staging-identity-mismatch",
  "host-operation-failed",
  "spawn-failed",
  "unexpected-tool-activity",
  "workspace-mutation",
  "output-limit",
  "timeout",
  "cancelled",
  "process-failed",
  "malformed-output",
  "identity-unavailable",
  "model-identity-mismatch",
  "outbound-credential-boundary",
  "inbound-credential-boundary",
  "executable-drift",
] as const;

export type HarnessQualificationFailureCode = (typeof HARNESS_QUALIFICATION_FAILURE_CODES)[number];
export type HarnessQualificationTerminalCode = "completed" | HarnessQualificationFailureCode;
export type HarnessId = "claude-code" | "codex";
export type HarnessQualificationRole =
  | "writer"
  | "technical-review"
  | "editorial-review"
  | "quality-evaluation"
  | "semantic-judge"
  | "audit"
  | "retrieval";

export interface HarnessAttestationV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HARNESS_ATTESTATION_KIND;
  readonly adapterVersion: typeof HARNESS_ADAPTER_VERSION;
  readonly harnessId: HarnessId;
  readonly executable: {
    readonly basename: string;
    readonly sha256: string;
    readonly reportedVersion: string;
    readonly identityBeforeSha256: string;
    readonly identityAfterSha256: string;
  };
  readonly platform: { readonly os: "darwin" | "linux"; readonly arch: string };
  readonly requestedModel: string;
  readonly observedModel: string | null;
  /** Provider-observed harness session; never copied from model-authored output. */
  readonly observedSessionId: string | null;
  readonly routeClass: "opaque-cli-managed";
  readonly authMechanismClass: "enterprise-oauth" | "api-key" | "unknown";
  readonly arguments: { readonly policySha256: string; readonly names: readonly string[] };
  readonly environment: {
    readonly variableNames: readonly string[];
    readonly policySha256: string;
  };
  readonly policies: {
    readonly sandbox: "synthetic-empty-directory";
    readonly tools: "explicitly-empty" | "not-capability-denied";
    readonly customization: "safe-mode-with-inherited-enterprise-policy" | "disabled";
    readonly session: "not-persisted";
  };
  readonly inputDigests: {
    readonly corpusManifestSha256: string;
    readonly caseSha256: string;
    readonly workflowSha256: string;
    readonly skillSha256: string;
    readonly qualitySha256: string;
    readonly outputSchemaSha256: string;
    readonly thresholdsSha256: string;
    readonly scorerSha256: string;
    /** SHA-256 of the exact stdin bytes sent to the harness. */
    readonly promptSha256: string;
    /** Canonical digest of the host-derived, opened staging manifest. */
    readonly stagingManifestSha256: string;
  };
  readonly resultSha256: string | null;
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
  };
  readonly process: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly stdinBytes: number;
    readonly stdinDelivered: boolean;
    readonly descendantContainment: "verified" | "unsupported";
  };
  readonly toolEventCount: number;
  readonly workspace: { readonly beforeSha256: string; readonly afterSha256: string };
  readonly controls: {
    readonly emptyToolsRequested: boolean;
    readonly toolDenialProbe: "passed" | "failed" | "not-run";
    /** Digest binding the probe to executable, argv, environment, cwd, and platform. */
    readonly probeBindingSha256: string | null;
    readonly outboundGuard: "passed" | "failed" | "not-run";
    readonly inboundGuard: "passed" | "failed" | "not-run";
    readonly executableIdentity: "matched" | "mismatched" | "not-run";
    readonly stagingIdentity: "matched" | "mismatched" | "not-run";
  };
  readonly terminalCode: HarnessQualificationTerminalCode;
  readonly reasonCodes: readonly HarnessQualificationFailureCode[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type HarnessQualificationContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "migration-required";

export class HarnessQualificationContractError extends Error {
  public constructor(public readonly code: HarnessQualificationContractErrorCode) {
    super(`Harness qualification contract rejected (${code}).`);
    this.name = "HarnessQualificationContractError";
  }
}

function fail(code: HarnessQualificationContractErrorCode): never {
  throw new HarnessQualificationContractError(code);
}

const kit = createContractKit<HarnessQualificationContractErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-value",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const ROOT_KEYS = [
  "schemaVersion",
  "kind",
  "adapterVersion",
  "harnessId",
  "executable",
  "platform",
  "requestedModel",
  "observedModel",
  "observedSessionId",
  "routeClass",
  "authMechanismClass",
  "arguments",
  "environment",
  "policies",
  "inputDigests",
  "resultSha256",
  "limits",
  "process",
  "toolEventCount",
  "workspace",
  "controls",
  "terminalCode",
  "reasonCodes",
  "startedAt",
  "finishedAt",
] as const;

/** Decode the only repository-safe harness evidence shape. Raw captures are never accepted. */
export function parseHarnessAttestationV1(value: unknown): HarnessAttestationV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ROOT_KEYS);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== HARNESS_ATTESTATION_KIND ||
    root.adapterVersion !== HARNESS_ADAPTER_VERSION
  ) {
    fail("invalid-value");
  }

  const executable = exactObject(root.executable, [
    "basename",
    "sha256",
    "reportedVersion",
    "identityBeforeSha256",
    "identityAfterSha256",
  ]);
  const platform = exactObject(root.platform, ["os", "arch"]);
  const argumentsValue = exactObject(root.arguments, ["policySha256", "names"]);
  const environment = exactObject(root.environment, ["variableNames", "policySha256"]);
  const policies = exactObject(root.policies, ["sandbox", "tools", "customization", "session"]);
  const inputDigests = exactObject(root.inputDigests, [
    "corpusManifestSha256",
    "caseSha256",
    "workflowSha256",
    "skillSha256",
    "qualitySha256",
    "outputSchemaSha256",
    "thresholdsSha256",
    "scorerSha256",
    "promptSha256",
    "stagingManifestSha256",
  ]);
  const limits = exactObject(root.limits, ["timeoutMs", "maxStdoutBytes", "maxStderrBytes"]);
  const processValue = exactObject(root.process, [
    "exitCode",
    "signal",
    "durationMs",
    "stdoutBytes",
    "stderrBytes",
    "stdinBytes",
    "stdinDelivered",
    "descendantContainment",
  ]);
  const workspace = exactObject(root.workspace, ["beforeSha256", "afterSha256"]);
  const controls = exactObject(root.controls, [
    "emptyToolsRequested",
    "toolDenialProbe",
    "probeBindingSha256",
    "outboundGuard",
    "inboundGuard",
    "executableIdentity",
    "stagingIdentity",
  ]);

  const terminalCode = enumeration(root.terminalCode, [
    "completed",
    ...HARNESS_QUALIFICATION_FAILURE_CODES,
  ] as const);
  const reasonCodes = kit
    .array(root.reasonCodes)
    .map((entry) => enumeration(entry, HARNESS_QUALIFICATION_FAILURE_CODES));
  if (new Set(reasonCodes).size !== reasonCodes.length) fail("invalid-value");
  if (
    (terminalCode === "completed" && reasonCodes.length !== 0) ||
    (terminalCode !== "completed" && reasonCodes[0] !== terminalCode)
  ) {
    fail("invalid-value");
  }

  const result: HarnessAttestationV1 = {
    schemaVersion: 1,
    kind: HARNESS_ATTESTATION_KIND,
    adapterVersion: HARNESS_ADAPTER_VERSION,
    harnessId: enumeration(root.harnessId, ["claude-code", "codex"] as const),
    executable: {
      basename: boundedName(executable.basename),
      sha256: kit.hash(executable.sha256),
      reportedVersion: boundedText(executable.reportedVersion, 128),
      identityBeforeSha256: kit.hash(executable.identityBeforeSha256),
      identityAfterSha256: kit.hash(executable.identityAfterSha256),
    },
    platform: {
      os: enumeration(platform.os, ["darwin", "linux"] as const),
      arch: boundedName(platform.arch),
    },
    requestedModel: boundedName(root.requestedModel),
    observedModel: root.observedModel === null ? null : boundedName(root.observedModel),
    observedSessionId:
      root.observedSessionId === null ? null : boundedSessionId(root.observedSessionId),
    routeClass: enumeration(root.routeClass, ["opaque-cli-managed"] as const),
    authMechanismClass: enumeration(root.authMechanismClass, [
      "enterprise-oauth",
      "api-key",
      "unknown",
    ] as const),
    arguments: {
      policySha256: kit.hash(argumentsValue.policySha256),
      names: normalizedNames(argumentsValue.names, /^--[a-z][a-z0-9-]{0,63}$/u),
    },
    environment: {
      variableNames: normalizedNames(environment.variableNames, /^[A-Z][A-Z0-9_]{0,63}$/u),
      policySha256: kit.hash(environment.policySha256),
    },
    policies: {
      sandbox: enumeration(policies.sandbox, ["synthetic-empty-directory"] as const),
      tools: enumeration(policies.tools, ["explicitly-empty", "not-capability-denied"] as const),
      customization: enumeration(policies.customization, [
        "safe-mode-with-inherited-enterprise-policy",
        "disabled",
      ] as const),
      session: enumeration(policies.session, ["not-persisted"] as const),
    },
    inputDigests: {
      corpusManifestSha256: kit.hash(inputDigests.corpusManifestSha256),
      caseSha256: kit.hash(inputDigests.caseSha256),
      workflowSha256: kit.hash(inputDigests.workflowSha256),
      skillSha256: kit.hash(inputDigests.skillSha256),
      qualitySha256: kit.hash(inputDigests.qualitySha256),
      outputSchemaSha256: kit.hash(inputDigests.outputSchemaSha256),
      thresholdsSha256: kit.hash(inputDigests.thresholdsSha256),
      scorerSha256: kit.hash(inputDigests.scorerSha256),
      promptSha256: kit.hash(inputDigests.promptSha256),
      stagingManifestSha256: kit.hash(inputDigests.stagingManifestSha256),
    },
    resultSha256: kit.nullableHash(root.resultSha256),
    limits: {
      timeoutMs: positiveInteger(limits.timeoutMs),
      maxStdoutBytes: positiveInteger(limits.maxStdoutBytes),
      maxStderrBytes: positiveInteger(limits.maxStderrBytes),
    },
    process: {
      exitCode: nullableInteger(processValue.exitCode),
      signal: processValue.signal === null ? null : boundedName(processValue.signal),
      durationMs: nonnegativeInteger(processValue.durationMs),
      stdoutBytes: nonnegativeInteger(processValue.stdoutBytes),
      stderrBytes: nonnegativeInteger(processValue.stderrBytes),
      stdinBytes: nonnegativeInteger(processValue.stdinBytes),
      stdinDelivered: booleanValue(processValue.stdinDelivered),
      descendantContainment: enumeration(processValue.descendantContainment, [
        "verified",
        "unsupported",
      ] as const),
    },
    toolEventCount: nonnegativeInteger(root.toolEventCount),
    workspace: {
      beforeSha256: kit.hash(workspace.beforeSha256),
      afterSha256: kit.hash(workspace.afterSha256),
    },
    controls: {
      emptyToolsRequested: booleanValue(controls.emptyToolsRequested),
      toolDenialProbe: enumeration(controls.toolDenialProbe, [
        "passed",
        "failed",
        "not-run",
      ] as const),
      probeBindingSha256: kit.nullableHash(controls.probeBindingSha256),
      outboundGuard: enumeration(controls.outboundGuard, ["passed", "failed", "not-run"] as const),
      inboundGuard: enumeration(controls.inboundGuard, ["passed", "failed", "not-run"] as const),
      executableIdentity: enumeration(controls.executableIdentity, [
        "matched",
        "mismatched",
        "not-run",
      ] as const),
      stagingIdentity: enumeration(controls.stagingIdentity, [
        "matched",
        "mismatched",
        "not-run",
      ] as const),
    },
    terminalCode,
    reasonCodes,
    startedAt: kit.timestamp(root.startedAt),
    finishedAt: kit.timestamp(root.finishedAt),
  };
  if (result.finishedAt < result.startedAt) fail("invalid-value");
  if ((result.terminalCode === "completed") !== (result.resultSha256 !== null)) {
    fail("invalid-value");
  }
  assertSemanticInvariants(result);
  return deepFreeze(result);
}

function assertSemanticInvariants(result: HarnessAttestationV1): void {
  const reasons = new Set(result.reasonCodes);
  const requiresReason = (condition: boolean, code: HarnessQualificationFailureCode): void => {
    if (condition !== reasons.has(code)) fail("invalid-value");
  };

  if (result.toolEventCount > 0 && !reasons.has("unexpected-tool-activity")) {
    fail("invalid-value");
  }
  if (
    reasons.has("unexpected-tool-activity") &&
    result.toolEventCount === 0 &&
    result.controls.toolDenialProbe !== "failed"
  ) {
    fail("invalid-value");
  }
  if (
    (result.controls.toolDenialProbe === "not-run" &&
      result.controls.probeBindingSha256 !== null) ||
    (result.controls.toolDenialProbe === "passed" && result.controls.probeBindingSha256 === null)
  ) {
    fail("invalid-value");
  }
  requiresReason(
    result.workspace.beforeSha256 !== result.workspace.afterSha256,
    "workspace-mutation",
  );
  requiresReason(result.controls.outboundGuard === "failed", "outbound-credential-boundary");
  requiresReason(result.controls.inboundGuard === "failed", "inbound-credential-boundary");
  const executableFailure =
    reasons.has("executable-drift") || reasons.has("harness-identity-mismatch");
  if (result.controls.executableIdentity === "mismatched" && !executableFailure) {
    fail("invalid-value");
  }

  if (result.terminalCode !== "completed") return;
  if (
    result.harnessId !== "claude-code" ||
    result.observedModel !== result.requestedModel ||
    result.observedSessionId === null ||
    result.process.exitCode !== 0 ||
    result.process.signal !== null ||
    result.process.stdoutBytes > result.limits.maxStdoutBytes ||
    result.process.stderrBytes > result.limits.maxStderrBytes ||
    result.process.stdinDelivered !== true ||
    result.process.descendantContainment !== "verified" ||
    result.policies.tools !== "explicitly-empty" ||
    result.controls.emptyToolsRequested !== true ||
    result.controls.toolDenialProbe !== "passed" ||
    result.controls.outboundGuard !== "passed" ||
    result.controls.inboundGuard !== "passed" ||
    result.controls.executableIdentity !== "matched" ||
    result.controls.stagingIdentity !== "matched"
  ) {
    fail("invalid-value");
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const root = kit.object(value);
  kit.exact(root, keys);
  return root;
}

function enumeration<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  return kit.enumeration(value, values);
}

function boundedText(value: unknown, maximum: number): string {
  const result = kit.string(value);
  if (result.length < 1 || result.length > maximum) fail("invalid-value");
  return result;
}

function boundedName(value: unknown): string {
  const result = boundedText(value, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/u.test(result)) fail("invalid-value");
  return result;
}

function boundedSessionId(value: unknown): string {
  const result = boundedText(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(result)) fail("invalid-value");
  return result;
}

function normalizedNames(value: unknown, pattern: RegExp): readonly string[] {
  const result = kit.array(value).map((entry) => boundedText(entry, 64));
  if (result.some((entry) => !pattern.test(entry))) fail("invalid-value");
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => index > 0 && result[index - 1]! >= entry)
  ) {
    fail("invalid-value");
  }
  return result;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("invalid-value");
  return value as number;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid-value");
  return value as number;
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : nonnegativeInteger(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail("invalid-value");
  return value;
}
