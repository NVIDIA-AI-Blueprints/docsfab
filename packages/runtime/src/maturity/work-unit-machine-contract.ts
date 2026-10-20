// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed sealed decoder for WorkUnitMachineContractV1.
 * Separate envelope bound by workUnitFingerprint — does not rewrite maturity
 * work-unit v1. Catalog evaluate alone cannot flip Acceptance.
 */

import { createContractKit, deepFreeze } from "../contract-kit/index.js";

export const WORK_UNIT_MACHINE_CONTRACT_KIND = "docsfab-work-unit-machine-contract" as const;
export const WORK_UNIT_MACHINE_CONTRACT_SCHEMA_VERSION = 1 as const;

export const WORK_UNIT_MACHINE_CHECK_KINDS = [
  "npm-script",
  "vitest-file",
  "cli-smoke",
  "fixture-key",
  "inventory-probe",
] as const;
export type WorkUnitMachineCheckKind = (typeof WORK_UNIT_MACHINE_CHECK_KINDS)[number];

export const WORK_UNIT_MACHINE_EXPECTED_OUTCOME_CLASSES = ["pass", "fail-closed"] as const;
export type WorkUnitMachineExpectedOutcomeClass =
  (typeof WORK_UNIT_MACHINE_EXPECTED_OUTCOME_CLASSES)[number];

export const WORK_UNIT_MACHINE_ACCEPTANCE_AUTHORITIES = [
  "host-deterministic",
  "evaluate-step-plus-host",
] as const;
export type WorkUnitMachineAcceptanceAuthority =
  (typeof WORK_UNIT_MACHINE_ACCEPTANCE_AUTHORITIES)[number];

export type WorkUnitMachineCheckV1 =
  | {
      checkKind: "npm-script";
      commandId: string;
      expectedOutcomeClass: WorkUnitMachineExpectedOutcomeClass;
    }
  | {
      checkKind: "cli-smoke";
      commandId: string;
      expectedOutcomeClass: WorkUnitMachineExpectedOutcomeClass;
    }
  | {
      checkKind: "vitest-file";
      vitestFileId: string;
      expectedOutcomeClass: WorkUnitMachineExpectedOutcomeClass;
    }
  | {
      checkKind: "fixture-key";
      fixtureKey: string;
      expectedOutcomeClass: WorkUnitMachineExpectedOutcomeClass;
    }
  | {
      checkKind: "inventory-probe";
      inventoryProbeId: string;
      expectedOutcomeClass: WorkUnitMachineExpectedOutcomeClass;
    };

export interface WorkUnitMachineContractBodyV1 {
  workUnitFingerprint: string;
  repositoryIdentitySha256: string;
  machineChecks: readonly WorkUnitMachineCheckV1[];
  acceptanceAuthority: WorkUnitMachineAcceptanceAuthority;
  /** Catalog evaluate alone cannot flip Acceptance. */
  trackerMutation: "not-authorized";
}

export type WorkUnitMachineContractV1 = WorkUnitMachineContractBodyV1 & {
  schemaVersion: typeof WORK_UNIT_MACHINE_CONTRACT_SCHEMA_VERSION;
  kind: typeof WORK_UNIT_MACHINE_CONTRACT_KIND;
  machineContractSha256: string;
};

export type WorkUnitMachineContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "missing-machine-contract";

export class WorkUnitMachineContractError extends Error {
  public constructor(public readonly code: WorkUnitMachineContractErrorCode) {
    super(`Work-unit machine contract rejected: ${code}.`);
    this.name = "WorkUnitMachineContractError";
  }
}

function fail(code: WorkUnitMachineContractErrorCode): never {
  throw new WorkUnitMachineContractError(code);
}

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  enumeration,
  hash,
  seal,
  decodeSealed,
  compare,
  unique,
} = createContractKit({
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

const BODY_KEYS = [
  "workUnitFingerprint",
  "repositoryIdentitySha256",
  "machineChecks",
  "acceptanceAuthority",
  "trackerMutation",
] as const;

/**
 * Content-free identity: no host paths, traversal, or credential-shaped authority.
 */
function contentFreeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value) ||
    value.includes(":/") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("invalid-value");
  }
  return value;
}

function checkSortKey(check: WorkUnitMachineCheckV1): string {
  switch (check.checkKind) {
    case "npm-script":
    case "cli-smoke":
      return `${check.checkKind}\0${check.commandId}`;
    case "vitest-file":
      return `${check.checkKind}\0${check.vitestFileId}`;
    case "fixture-key":
      return `${check.checkKind}\0${check.fixtureKey}`;
    case "inventory-probe":
      return `${check.checkKind}\0${check.inventoryProbeId}`;
  }
}

function normalizeMachineCheck(value: unknown): WorkUnitMachineCheckV1 {
  const root = object(value);
  const checkKind = enumeration(root.checkKind, WORK_UNIT_MACHINE_CHECK_KINDS);
  const expectedOutcomeClass = enumeration(
    root.expectedOutcomeClass,
    WORK_UNIT_MACHINE_EXPECTED_OUTCOME_CLASSES,
  );
  switch (checkKind) {
    case "npm-script":
    case "cli-smoke": {
      exact(root, ["checkKind", "commandId", "expectedOutcomeClass"]);
      return deepFreeze({
        checkKind,
        commandId: contentFreeId(root.commandId),
        expectedOutcomeClass,
      });
    }
    case "vitest-file": {
      exact(root, ["checkKind", "vitestFileId", "expectedOutcomeClass"]);
      return deepFreeze({
        checkKind,
        vitestFileId: contentFreeId(root.vitestFileId),
        expectedOutcomeClass,
      });
    }
    case "fixture-key": {
      exact(root, ["checkKind", "fixtureKey", "expectedOutcomeClass"]);
      return deepFreeze({
        checkKind,
        fixtureKey: contentFreeId(root.fixtureKey),
        expectedOutcomeClass,
      });
    }
    case "inventory-probe": {
      exact(root, ["checkKind", "inventoryProbeId", "expectedOutcomeClass"]);
      return deepFreeze({
        checkKind,
        inventoryProbeId: contentFreeId(root.inventoryProbeId),
        expectedOutcomeClass,
      });
    }
  }
}

function normalizeMachineChecks(value: unknown): readonly WorkUnitMachineCheckV1[] {
  const checks = array(value).map(normalizeMachineCheck);
  if (checks.length === 0) fail("invalid-value");
  const sorted = [...checks].sort((left, right) =>
    compare(checkSortKey(left), checkSortKey(right)),
  );
  unique(sorted.map(checkSortKey));
  return Object.freeze(sorted);
}

function normalizeBody(root: Record<string, unknown>): WorkUnitMachineContractBodyV1 {
  if (root.trackerMutation !== "not-authorized") fail("invalid-value");
  return {
    workUnitFingerprint: hash(root.workUnitFingerprint),
    repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
    machineChecks: normalizeMachineChecks(root.machineChecks),
    acceptanceAuthority: enumeration(
      root.acceptanceAuthority,
      WORK_UNIT_MACHINE_ACCEPTANCE_AUTHORITIES,
    ),
    trackerMutation: "not-authorized",
  };
}

export function createWorkUnitMachineContract(
  input: WorkUnitMachineContractBodyV1,
): WorkUnitMachineContractV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...BODY_KEYS]);
  return seal(
    WORK_UNIT_MACHINE_CONTRACT_KIND,
    "machineContractSha256",
    normalizeBody(root),
  ) as WorkUnitMachineContractV1;
}

export function decodeWorkUnitMachineContract(value: unknown): WorkUnitMachineContractV1 {
  return decodeSealed(
    value,
    WORK_UNIT_MACHINE_CONTRACT_KIND,
    "machineContractSha256",
    [...BODY_KEYS],
    normalizeBody,
  ) as WorkUnitMachineContractV1;
}

/**
 * MEA / multi-unit campaign admission: missing or invalid envelope fails closed.
 * Cascade selection may still use maturity work units without this envelope.
 */
export function admitsWorkUnitMachineContractForCampaign(envelope: unknown): boolean {
  if (envelope === null || envelope === undefined) return false;
  try {
    decodeWorkUnitMachineContract(envelope);
    return true;
  } catch (error) {
    if (error instanceof WorkUnitMachineContractError) return false;
    throw error;
  }
}

/**
 * Fail-closed MEA admission gate — absent envelope is not half-ready.
 */
export function requireWorkUnitMachineContractForMeaAdmission(
  envelope: unknown,
): WorkUnitMachineContractV1 {
  if (envelope === null || envelope === undefined) {
    fail("missing-machine-contract");
  }
  return decodeWorkUnitMachineContract(envelope);
}
