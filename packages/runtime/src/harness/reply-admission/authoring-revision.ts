// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
} from "../../execution/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  decodeAuthoringRevisionAccounting,
  isAuthoringRevisionWriter,
} from "../../workflow-execution/authoring-revision.js";
import type { ReplyAdmissionContext } from "./context.js";

export interface AuthoringRevisionReplyAdmission {
  summary: string;
  authoringRevisionAccounting?: HarnessStepResult["authoringRevisionAccounting"];
}

/**
 * Admit an authoring revision writer's accounting against its host-sealed
 * revision input. Any other step keeps its summary and gains no accounting.
 */
export function admitAuthoringRevisionReply(
  input: HarnessStepInput,
  summary: string,
  { collectAttemptEvidence }: ReplyAdmissionContext,
): AuthoringRevisionReplyAdmission {
  let authoringRevisionAccounting: HarnessStepResult["authoringRevisionAccounting"];
  if (isAuthoringRevisionWriter(input)) {
    if (!input.authoringRevisionInput) {
      throw new InferenceStepError(
        "The authoring revision writer requires the host-sealed revision input.",
        "malformed-response",
        false,
        collectAttemptEvidence(),
      );
    }
    try {
      authoringRevisionAccounting = decodeAuthoringRevisionAccounting(
        summary,
        input.authoringRevisionInput,
      );
      summary = canonicalizeJsonEvidence(
        authoringRevisionAccounting as unknown as JsonEvidenceValue,
      ).trimEnd();
    } catch (error) {
      if (error instanceof InferenceStepError) {
        // Keep the coded rejection, so the attempt records its code and
        // location, not only the category.
        throw new InferenceStepError(
          error.message,
          error.category,
          error.retryable,
          collectAttemptEvidence(),
          error.rejection,
        );
      }
      throw error;
    }
  }
  return { summary, authoringRevisionAccounting };
}
