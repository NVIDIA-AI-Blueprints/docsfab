// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
import { RST_CAPABILITY_NEXT_ACTIONS } from "./capability-guidance.js";

export const RST_CAPABILITY_CONTRACT_VERSION = "existing-single-page-update-v1" as const;

export type RstCapabilityRefusalCode =
  | "rst-capability-unsupported-operation"
  | "rst-capability-unsupported-cardinality"
  | "rst-capability-unsupported-delivery"
  | "rst-capability-unsupported-adapter"
  | "rst-capability-admission-required";

export interface RstCapabilityAdmissionV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-rst-capability-admission";
  readonly contractVersion: typeof RST_CAPABILITY_CONTRACT_VERSION;
  readonly status: "admitted" | "refused";
  readonly workflow: string;
  readonly delivery: "patch-only" | "default" | "unknown";
  readonly targetCount: number;
  readonly targetPathsSha256: string;
  readonly taskSha256: string;
  readonly repository: {
    readonly identitySha256: string;
    readonly revision: string;
  };
  readonly configurationSha256: string;
  readonly adapter: {
    readonly id: "sphinx" | "unknown";
    readonly configurationSha256: string | null;
  };
  readonly refusalCode?: RstCapabilityRefusalCode;
  readonly admissionSha256: string;
}

export interface RstCapabilityAdmissionInput {
  readonly workflow: string;
  readonly delivery: "patch-only" | "default" | "unknown";
  readonly targetPaths: readonly string[];
  readonly taskSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly repositoryRevision: string;
  readonly documentationRoots: readonly string[] | undefined;
  readonly adapterConfigurationSha256?: string;
  readonly adapterEligible: boolean;
}

export interface RstCapabilityAdmissionExpectation {
  readonly workflow: string;
  readonly delivery: "patch-only";
  readonly targetPaths: readonly string[];
  readonly taskSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly repositoryRevision: string;
  readonly documentationRoots: readonly string[];
}

interface IssuedAdmissionBinding {
  readonly record: RstCapabilityAdmissionV1;
  readonly documentationRoots: readonly string[] | undefined;
  readonly adapterConfigurationSha256: string | undefined;
  readonly adapterEligible: boolean;
}

const issuedAdmissions = new WeakMap<object, IssuedAdmissionBinding>();

export class RstCapabilityOperatorError extends Error {
  public readonly name = "RstCapabilityOperatorError";
  public readonly code: RstCapabilityRefusalCode;
  public readonly nextAction: string;
  public readonly admission: RstCapabilityAdmissionV1;

  public constructor(code: RstCapabilityRefusalCode, admission: RstCapabilityAdmissionV1) {
    const message = messages[code].message;
    super(message);
    this.code = code;
    this.nextAction = RST_CAPABILITY_NEXT_ACTIONS[code];
    this.admission = admission;
  }
}

const messages: Record<RstCapabilityRefusalCode, { readonly message: string }> = {
  "rst-capability-unsupported-operation": {
    message: "This runtime supports RST authoring only for an update of one existing Sphinx page.",
  },
  "rst-capability-unsupported-cardinality": {
    message: "This runtime supports one existing Sphinx RST page per authoring task.",
  },
  "rst-capability-unsupported-delivery": {
    message: "RST updates require patch-only delivery.",
  },
  "rst-capability-unsupported-adapter": {
    message: "The requested RST page is not owned by one unambiguous tracked Sphinx configuration.",
  },
  "rst-capability-admission-required": {
    message:
      "This host path cannot establish the admitted RST authoring capability for the canonical task.",
  },
};

/** Builds the closed, repository-bound capability result for canonical task targets. */
export function createRstCapabilityAdmission(
  input: RstCapabilityAdmissionInput,
): RstCapabilityAdmissionV1 | undefined {
  const targets = input.targetPaths.filter((path) => path.endsWith(".rst"));
  if (targets.length === 0) return undefined;

  let refusalCode: RstCapabilityRefusalCode | undefined;
  if (input.workflow !== "update-documentation") {
    refusalCode = "rst-capability-unsupported-operation";
  } else if (input.targetPaths.length !== 1) {
    refusalCode = "rst-capability-unsupported-cardinality";
  } else if (input.delivery === "default") {
    refusalCode = "rst-capability-unsupported-delivery";
  } else if (input.delivery === "unknown") {
    refusalCode = "rst-capability-admission-required";
  } else if (!input.adapterEligible || input.adapterConfigurationSha256 === undefined) {
    refusalCode = "rst-capability-unsupported-adapter";
  }

  const binding = {
    schemaVersion: 1 as const,
    kind: "docsfab-rst-capability-admission" as const,
    contractVersion: RST_CAPABILITY_CONTRACT_VERSION,
    status: refusalCode === undefined ? ("admitted" as const) : ("refused" as const),
    workflow: input.workflow,
    delivery: input.delivery,
    targetCount: input.targetPaths.length,
    targetPathsSha256: canonicalDigest([...input.targetPaths]),
    taskSha256: input.taskSha256,
    repository: {
      identitySha256: input.repositoryIdentitySha256,
      revision: input.repositoryRevision,
    },
    configurationSha256: canonicalDigest({
      documentationRoots: input.documentationRoots ?? null,
      adapter: {
        id: input.adapterEligible ? "sphinx" : "unknown",
        configurationSha256: input.adapterConfigurationSha256 ?? null,
      },
    }),
    adapter: {
      id: input.adapterEligible ? ("sphinx" as const) : ("unknown" as const),
      configurationSha256: input.adapterConfigurationSha256 ?? null,
    },
    ...(refusalCode === undefined ? {} : { refusalCode }),
  };
  const record: RstCapabilityAdmissionV1 = Object.freeze({
    ...binding,
    repository: Object.freeze({ ...binding.repository }),
    adapter: Object.freeze({ ...binding.adapter }),
    admissionSha256: canonicalDigest(binding),
  });
  issuedAdmissions.set(record, {
    record,
    documentationRoots:
      input.documentationRoots === undefined
        ? undefined
        : Object.freeze([...input.documentationRoots]),
    adapterConfigurationSha256: input.adapterConfigurationSha256,
    adapterEligible: input.adapterEligible,
  });
  return record;
}

/**
 * Checks the closed record at the central runner boundary. Record identity is
 * also required: digests correlate the admitted values, while the private
 * WeakMap proves that this exact object came from the trusted local preflight.
 */
export function verifyRstCapabilityAdmission(
  value: unknown,
  expected: RstCapabilityAdmissionExpectation,
): value is RstCapabilityAdmissionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const issued = issuedAdmissions.get(value);
  if (!issued) return false;
  const candidate = value as RstCapabilityAdmissionV1;
  return (
    hasAdmittedRecordShape(candidate) &&
    matchesExpectedAdmission(candidate, expected) &&
    hasValidAdmissionDigests(candidate, expected) &&
    matchesPrivateIssuedBinding(candidate, issued, expected)
  );
}

function hasAdmittedRecordShape(value: unknown): value is RstCapabilityAdmissionV1 {
  if (!isPlainRecord(value)) return false;
  return (
    hasExactKeys(
      value,
      [
        "schemaVersion",
        "kind",
        "contractVersion",
        "status",
        "workflow",
        "delivery",
        "targetCount",
        "targetPathsSha256",
        "taskSha256",
        "repository",
        "configurationSha256",
        "adapter",
        "admissionSha256",
      ],
      ["refusalCode"],
    ) &&
    !Object.hasOwn(value, "refusalCode") &&
    isPlainRecord(value.repository) &&
    hasExactKeys(value.repository, ["identitySha256", "revision"]) &&
    isPlainRecord(value.adapter) &&
    hasExactKeys(value.adapter, ["id", "configurationSha256"])
  );
}

function matchesExpectedAdmission(
  candidate: RstCapabilityAdmissionV1,
  expected: RstCapabilityAdmissionExpectation,
): boolean {
  return (
    candidate.schemaVersion === 1 &&
    candidate.kind === "docsfab-rst-capability-admission" &&
    candidate.contractVersion === RST_CAPABILITY_CONTRACT_VERSION &&
    candidate.status === "admitted" &&
    candidate.workflow === expected.workflow &&
    candidate.delivery === expected.delivery &&
    candidate.targetCount === expected.targetPaths.length &&
    candidate.targetPathsSha256 === canonicalDigest([...expected.targetPaths]) &&
    candidate.taskSha256 === expected.taskSha256 &&
    candidate.repository.identitySha256 === expected.repositoryIdentitySha256 &&
    candidate.repository.revision === expected.repositoryRevision &&
    candidate.adapter.id === "sphinx" &&
    isSha256(candidate.adapter.configurationSha256) &&
    isSha256(candidate.repository.identitySha256) &&
    isSha256(candidate.targetPathsSha256) &&
    isSha256(candidate.taskSha256) &&
    isSha256(candidate.configurationSha256) &&
    isSha256(candidate.admissionSha256)
  );
}

function hasValidAdmissionDigests(
  candidate: RstCapabilityAdmissionV1,
  expected: RstCapabilityAdmissionExpectation,
): boolean {
  const configurationSha256 = canonicalDigest({
    documentationRoots: [...expected.documentationRoots],
    adapter: {
      id: "sphinx",
      configurationSha256: candidate.adapter.configurationSha256,
    },
  });
  const { admissionSha256, ...binding } = candidate;
  return (
    candidate.configurationSha256 === configurationSha256 &&
    canonicalDigest(binding) === admissionSha256
  );
}

function matchesPrivateIssuedBinding(
  candidate: RstCapabilityAdmissionV1,
  issued: IssuedAdmissionBinding,
  expected: RstCapabilityAdmissionExpectation,
): boolean {
  const trustedConfigurationSha256 = canonicalDigest({
    documentationRoots: issued.documentationRoots ?? null,
    adapter: {
      id: issued.adapterEligible ? "sphinx" : "unknown",
      configurationSha256: issued.adapterConfigurationSha256 ?? null,
    },
  });
  return (
    issued.record === candidate &&
    issued.record.admissionSha256 === candidate.admissionSha256 &&
    issued.record.configurationSha256 === candidate.configurationSha256 &&
    issued.record.adapter.id === candidate.adapter.id &&
    issued.record.adapter.configurationSha256 === candidate.adapter.configurationSha256 &&
    trustedConfigurationSha256 === candidate.configurationSha256 &&
    issued.adapterEligible &&
    issued.adapterConfigurationSha256 === candidate.adapter.configurationSha256 &&
    issued.documentationRoots !== undefined &&
    canonicalDigest([...issued.documentationRoots]) ===
      canonicalDigest([...expected.documentationRoots])
  );
}

function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const parent = Object.getPrototypeOf(value);
  return parent === Object.prototype || parent === null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function assertRstCapabilityAdmitted(admission: RstCapabilityAdmissionV1 | undefined): void {
  if (admission?.status === "refused" && admission.refusalCode) {
    throw new RstCapabilityOperatorError(admission.refusalCode, admission);
  }
}
