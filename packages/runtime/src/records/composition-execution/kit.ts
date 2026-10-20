// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../../contract-kit/index.js";
import {
  CompositionExecutionEvidenceError,
  type CompositionExecutionEvidenceErrorCode,
} from "../composition-execution-error.js";

export const fail = (code: CompositionExecutionEvidenceErrorCode): never => {
  throw new CompositionExecutionEvidenceError(code);
};

export const kit = createContractKit<CompositionExecutionEvidenceErrorCode>({
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
