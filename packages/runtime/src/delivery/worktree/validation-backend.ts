// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Backend-neutral validation capability and redacted attestation. A backend is
 * a trusted host-selected object; plan, config, environment, CLI input, and
 * model output cannot select or construct one. Linux Bubblewrap and Darwin
 * Docker Desktop interchange only at this boundary.
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createContractKit,
  createHostAuthorityFactory,
  type ContractFail,
} from "../../contract-kit/index.js";
import { MAX_COMMAND_OUTPUT } from "./types.js";

export const VALIDATION_BACKEND_CAPABILITY_KIND = "docsfab-validation-backend-capability" as const;
export const VALIDATION_BACKEND_REQUEST_KIND = "docsfab-validation-backend-request" as const;
export const VALIDATION_BACKEND_ATTESTATION_KIND =
  "docsfab-validation-backend-attestation" as const;

export const VALIDATION_BACKEND_IDENTITIES = ["linux-bubblewrap", "darwin-docker-desktop"] as const;
export type ValidationBackendIdentity = (typeof VALIDATION_BACKEND_IDENTITIES)[number];

export type ValidationBackendErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch"
  | "migration-required"
  | "untrusted-backend"
  | "backend-unavailable"
  | "policy-mismatch"
  | "input-tree-mismatch"
  | "scratch-mismatch";

export class ValidationBackendError extends Error {
  public constructor(public readonly code: ValidationBackendErrorCode) {
    super(`The validation backend contract rejected this value (${code}).`);
    this.name = "ValidationBackendError";
  }
}

export function failValidationBackend(code: ValidationBackendErrorCode): never {
  throw new ValidationBackendError(code);
}

export const validationBackendKit = createContractKit({
  fail: failValidationBackend as ContractFail<ValidationBackendErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const kit = validationBackendKit;

/** Built-in DocsFab isolation policy. Repository or model input cannot widen it. */
export const DOCSFAB_VALIDATION_BACKEND_POLICY_V1 = kit.deepFreeze({
  limits: {
    timeoutMs: 10 * 60_000,
    probeTimeoutMs: 5_000,
    maxOutputBytes: MAX_COMMAND_OUTPUT,
    pidNamespace: "required" as const,
    descendantTeardown: "die-with-parent" as const,
  },
  egress: {
    external: "deny" as const,
    hostNetwork: "deny" as const,
    intraCapsuleLoopback: "deny" as const,
  },
  credentials: {
    hostHome: "deny" as const,
    dockerSocket: "deny" as const,
    scmCredentials: "deny" as const,
    modelCredentials: "deny" as const,
    privileged: "deny" as const,
  },
  teardown: {
    descendants: "required" as const,
  },
});

export type ValidationBackendPolicyV1 = typeof DOCSFAB_VALIDATION_BACKEND_POLICY_V1;

export interface ValidationBackendRequestInputV1 {
  inputTreeSha256: string;
  scratchSha256: string;
  limits: ValidationBackendPolicyV1["limits"];
  egress: ValidationBackendPolicyV1["egress"];
  credentials: ValidationBackendPolicyV1["credentials"];
  teardown: ValidationBackendPolicyV1["teardown"];
}

export type ValidationBackendRequestV1 = ValidationBackendRequestInputV1 & {
  readonly schemaVersion: 1;
  readonly kind: typeof VALIDATION_BACKEND_REQUEST_KIND;
  readonly requestSha256: string;
};

export interface ValidationBackendAttestationInputV1 {
  backendIdentity: ValidationBackendIdentity;
  policySha256: string;
  inputTreeSha256: string;
  scratchSha256: string;
  resultSha256: string;
}

export type ValidationBackendAttestationV1 = ValidationBackendAttestationInputV1 & {
  readonly schemaVersion: 1;
  readonly kind: typeof VALIDATION_BACKEND_ATTESTATION_KIND;
  readonly attestationSha256: string;
};

export interface ValidationBackendCapability {
  readonly kind: typeof VALIDATION_BACKEND_CAPABILITY_KIND;
}

interface ValidationBackendVerifier {
  verifyCurrent(): boolean;
  identity: ValidationBackendIdentity;
}

const validationBackendAuthorities = createHostAuthorityFactory<
  typeof VALIDATION_BACKEND_CAPABILITY_KIND,
  ValidationBackendVerifier
>({
  kind: VALIDATION_BACKEND_CAPABILITY_KIND,
  invalidMessage: "Validation backend verifier must be a trusted host object with verifyCurrent.",
});

const REQUEST_BODY_KEYS = [
  "inputTreeSha256",
  "scratchSha256",
  "limits",
  "egress",
  "credentials",
  "teardown",
] as const;

const ATTESTATION_BODY_KEYS = [
  "backendIdentity",
  "policySha256",
  "inputTreeSha256",
  "scratchSha256",
  "resultSha256",
] as const;

export function validationBackendPolicySha256(
  policy: ValidationBackendPolicyV1 = DOCSFAB_VALIDATION_BACKEND_POLICY_V1,
): string {
  return kit.canonicalDigest(policy);
}

/**
 * Host selection uses only the process platform. Serialized plan, config,
 * environment, and model-output fields are accepted so tests can prove they
 * cannot name or construct a backend.
 */
export function selectHostValidationBackendIdentity(
  platform: NodeJS.Platform,
  _serialized?: {
    readonly plan?: unknown;
    readonly config?: unknown;
    readonly environment?: NodeJS.ProcessEnv;
    readonly modelOutput?: unknown;
  },
): ValidationBackendIdentity | undefined {
  void _serialized;
  if (platform === "linux") return "linux-bubblewrap";
  if (platform === "darwin") return "darwin-docker-desktop";
  return undefined;
}

export function issueHostSelectedValidationBackend(
  platform: NodeJS.Platform = process.platform,
  serialized?: Parameters<typeof selectHostValidationBackendIdentity>[1],
): ValidationBackendCapability | undefined {
  const identity = selectHostValidationBackendIdentity(platform, serialized);
  if (identity === undefined) return undefined;
  return validationBackendAuthorities.create({
    verifyCurrent: () => true,
    identity,
  }) as ValidationBackendCapability;
}

export function lookupValidationBackend(
  capability: unknown,
): ValidationBackendVerifier | undefined {
  if (!capability || typeof capability !== "object") return undefined;
  return validationBackendAuthorities.lookup(capability as ValidationBackendCapability);
}

export function requireValidationBackend(capability: unknown): ValidationBackendVerifier {
  const verifier = lookupValidationBackend(capability);
  if (!verifier?.verifyCurrent()) failValidationBackend("untrusted-backend");
  return verifier;
}

export function createValidationBackendRequest(
  input: ValidationBackendRequestInputV1,
): ValidationBackendRequestV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal(VALIDATION_BACKEND_REQUEST_KIND, "requestSha256", normalizeRequestInput(input));
}

export function decodeValidationBackendRequest(value: unknown): ValidationBackendRequestV1 {
  return kit.decodeSealed(
    value,
    VALIDATION_BACKEND_REQUEST_KIND,
    "requestSha256",
    [...REQUEST_BODY_KEYS],
    (root) => normalizeRequestInput(root as unknown as ValidationBackendRequestInputV1),
  );
}

export function createValidationBackendAttestation(
  input: ValidationBackendAttestationInputV1,
): ValidationBackendAttestationV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal(
    VALIDATION_BACKEND_ATTESTATION_KIND,
    "attestationSha256",
    normalizeAttestationInput(input),
  );
}

export function decodeValidationBackendAttestation(value: unknown): ValidationBackendAttestationV1 {
  return kit.decodeSealed(
    value,
    VALIDATION_BACKEND_ATTESTATION_KIND,
    "attestationSha256",
    [...ATTESTATION_BODY_KEYS],
    (root) => normalizeAttestationInput(root as unknown as ValidationBackendAttestationInputV1),
  );
}

export function validationBackendResultSha256(commandPrefix: readonly string[]): string {
  return kit.canonicalDigest({
    probe: "passed",
    commandPrefixSha256: createHash("sha256")
      .update(kit.canonicalJson(commandPrefix))
      .digest("hex"),
  });
}

export async function validationScratchSha256(scratchPath: string): Promise<string> {
  const details = await lstat(resolve(scratchPath));
  if (details.isSymbolicLink() || !details.isDirectory()) {
    failValidationBackend("scratch-mismatch");
  }
  return createHash("sha256")
    .update("docsfab-validation-scratch-v1")
    .update("\0")
    .update(String(details.dev))
    .update("\0")
    .update(String(details.ino))
    .update("\0")
    .update(String(details.mode))
    .digest("hex");
}

function normalizeRequestInput(
  input: ValidationBackendRequestInputV1,
): ValidationBackendRequestInputV1 {
  const root = kit.object(input);
  kit.exact(root, [...REQUEST_BODY_KEYS]);
  const policy = {
    limits: normalizeLimits(root.limits),
    egress: normalizeEgress(root.egress),
    credentials: normalizeCredentials(root.credentials),
    teardown: normalizeTeardown(root.teardown),
  };
  if (kit.canonicalDigest(policy) !== validationBackendPolicySha256()) {
    failValidationBackend("policy-mismatch");
  }
  return {
    inputTreeSha256: kit.hash(root.inputTreeSha256),
    scratchSha256: kit.hash(root.scratchSha256),
    ...policy,
  };
}

function normalizeAttestationInput(
  input: ValidationBackendAttestationInputV1,
): ValidationBackendAttestationInputV1 {
  const root = kit.object(input);
  kit.exact(root, [...ATTESTATION_BODY_KEYS]);
  return {
    backendIdentity: kit.enumeration(root.backendIdentity, VALIDATION_BACKEND_IDENTITIES),
    policySha256: kit.hash(root.policySha256),
    inputTreeSha256: kit.hash(root.inputTreeSha256),
    scratchSha256: kit.hash(root.scratchSha256),
    resultSha256: kit.hash(root.resultSha256),
  };
}

function normalizeLimits(value: unknown): ValidationBackendPolicyV1["limits"] {
  const root = kit.object(value);
  kit.exact(root, [
    "timeoutMs",
    "probeTimeoutMs",
    "maxOutputBytes",
    "pidNamespace",
    "descendantTeardown",
  ]);
  return {
    timeoutMs: positiveInteger(root.timeoutMs),
    probeTimeoutMs: positiveInteger(root.probeTimeoutMs),
    maxOutputBytes: positiveInteger(root.maxOutputBytes),
    pidNamespace: kit.enumeration(root.pidNamespace, ["required"] as const),
    descendantTeardown: kit.enumeration(root.descendantTeardown, ["die-with-parent"] as const),
  };
}

function normalizeEgress(value: unknown): ValidationBackendPolicyV1["egress"] {
  const root = kit.object(value);
  kit.exact(root, ["external", "hostNetwork", "intraCapsuleLoopback"]);
  return {
    external: kit.enumeration(root.external, ["deny"] as const),
    hostNetwork: kit.enumeration(root.hostNetwork, ["deny"] as const),
    intraCapsuleLoopback: kit.enumeration(root.intraCapsuleLoopback, ["deny"] as const),
  };
}

function normalizeCredentials(value: unknown): ValidationBackendPolicyV1["credentials"] {
  const root = kit.object(value);
  kit.exact(root, ["hostHome", "dockerSocket", "scmCredentials", "modelCredentials", "privileged"]);
  return {
    hostHome: kit.enumeration(root.hostHome, ["deny"] as const),
    dockerSocket: kit.enumeration(root.dockerSocket, ["deny"] as const),
    scmCredentials: kit.enumeration(root.scmCredentials, ["deny"] as const),
    modelCredentials: kit.enumeration(root.modelCredentials, ["deny"] as const),
    privileged: kit.enumeration(root.privileged, ["deny"] as const),
  };
}

function normalizeTeardown(value: unknown): ValidationBackendPolicyV1["teardown"] {
  const root = kit.object(value);
  kit.exact(root, ["descendants"]);
  return {
    descendants: kit.enumeration(root.descendants, ["required"] as const),
  };
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    failValidationBackend("invalid-value");
  }
  return value;
}
