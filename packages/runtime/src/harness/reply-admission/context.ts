// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceStepError } from "../../execution/contracts.js";

/**
 * What `PiHarness.runStep` lends each per-step reply admission. No module under
 * `reply-admission/` imports `../pi.js`, so the harness can re-export from them
 * without an ESM cycle.
 */
export interface ReplyAdmissionContext {
  /** The decoded reply exactly as the step returned it, before trimming. */
  readonly decodedResponse: string;
  /**
   * The attempt's evidence collector itself, never a precomputed value: each
   * refusal reads the evidence at the moment it throws.
   */
  readonly collectAttemptEvidence: () => NonNullable<InferenceStepError["evidence"]>;
  /** The contract-placeholder refusal bound to this step's own prompt. */
  readonly refuseContractPlaceholder: (reply: string) => void;
}
