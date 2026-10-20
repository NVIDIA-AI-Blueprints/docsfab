// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";

export class ModelCatalogContractError extends Error {
  readonly code = "invalid-model-catalog-contract" as const;

  constructor() {
    super("Model catalog contract is invalid or incompatible.");
    this.name = "ModelCatalogContractError";
  }
}

export function valueKey(value: unknown): string {
  return canonicalizeJsonEvidence(value as JsonEvidenceValue);
}

export function equalJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return valueKey(left) === valueKey(right);
}

export function invalid(): never {
  throw new ModelCatalogContractError();
}
