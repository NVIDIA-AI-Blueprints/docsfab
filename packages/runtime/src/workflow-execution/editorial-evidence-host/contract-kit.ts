// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../../contract-kit/index.js";
import type { InferenceRejectionReasonV1 } from "../../execution/contracts.js";

export type EditorialEvidenceHostErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "evidence-unavailable"
  | "identity-mismatch"
  | "producer-mismatch"
  | "conflicting-assessment";

export class EditorialEvidenceHostError extends Error {
  public constructor(
    public readonly code: EditorialEvidenceHostErrorCode,
    /**
     * The closed rule and response-contract location a refused model response
     * broke, when the rule has one. The harness records it on the attempt and
     * cites it in the bounded retry's correction.
     */
    public readonly rejection?: InferenceRejectionReasonV1,
  ) {
    super(`Editorial evidence host rejected input: ${code}.`);
    this.name = "EditorialEvidenceHostError";
  }
}

export function fail(code: EditorialEvidenceHostErrorCode): never {
  throw new EditorialEvidenceHostError(code);
}

export const kit = createContractKit<EditorialEvidenceHostErrorCode>({
  fail: fail as ContractFail<EditorialEvidenceHostErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    credentialMaterial: "credential-material",
    digestMismatch: "identity-mismatch",
    schemaMismatch: "invalid-shape",
  },
});
