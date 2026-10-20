// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../contract-kit/index.js";
import type { RunStatus } from "./contracts.js";

const invalid = (): never => {
  throw new Error("The checkout persistence outcome does not satisfy its closed schema.");
};
const kit = createContractKit({
  fail: invalid,
  codes: {
    invalidShape: "invalid-checkout-persistence",
    invalidValue: "invalid-checkout-persistence",
    digestMismatch: "invalid-checkout-persistence",
    credentialMaterial: "invalid-checkout-persistence",
    schemaMismatch: "invalid-checkout-persistence",
  },
  inertMode: "strict",
});

/** Checkout application is subsequent to workflow execution, on the same saved run. */
export const CHECKOUT_PERSISTENCE_ERROR_CODES = [
  "run-record-contract-gap",
  "write-disabled",
  "repository-mismatch",
  "patch-conflict",
  "patch-invalid",
  "apply-unverified",
  "cancelled",
  "retention-failed",
  "branch-preparation-failed",
] as const;

export type CheckoutPersistenceErrorCode = (typeof CHECKOUT_PERSISTENCE_ERROR_CODES)[number];

export type CheckoutPersistenceOutcomeV1 = {
  readonly schemaVersion: 1;
  readonly kind: "checkout-persistence";
} & (
  | { readonly outcome: "applied" | "already-applied" | "not-needed" }
  | { readonly outcome: "failed"; readonly errorCode: CheckoutPersistenceErrorCode }
);

/** Exact closed decoder shared by saved-run and publication readers. */
export function decodeCheckoutPersistenceOutcome(value: unknown): CheckoutPersistenceOutcomeV1 {
  const root = kit.object(value);
  if (root.schemaVersion !== 1 || root.kind !== "checkout-persistence") invalid();
  if (root.outcome === "failed") {
    kit.exact(root, ["schemaVersion", "kind", "outcome", "errorCode"]);
    if (
      typeof root.errorCode !== "string" ||
      !CHECKOUT_PERSISTENCE_ERROR_CODES.includes(root.errorCode as CheckoutPersistenceErrorCode)
    )
      invalid();
    return root as CheckoutPersistenceOutcomeV1;
  }
  kit.exact(root, ["schemaVersion", "kind", "outcome"]);
  if (
    typeof root.outcome !== "string" ||
    !["applied", "already-applied", "not-needed"].includes(root.outcome)
  )
    invalid();
  return root as CheckoutPersistenceOutcomeV1;
}

export function overallRunStatus(record: {
  readonly status: RunStatus;
  readonly checkoutPersistence?: CheckoutPersistenceOutcomeV1;
}): RunStatus {
  return record.checkoutPersistence?.outcome === "failed" ? "failed" : record.status;
}
