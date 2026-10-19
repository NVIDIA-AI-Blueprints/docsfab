// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OUTPUT_RECORD_CONTRACTS } from "../contracts/model-output.generated.js";
import { planAnswerRecords, type AnswerRecordPlan } from "./answer-records.js";

/**
 * Build the canonical documentation quality evaluator record plan from the
 * selected profile. Runtime validation and doctor share this projection so
 * neither copies the quality key skeleton or record-call arithmetic.
 */
export function planDocumentationQualityAnswerRecords(input: {
  readonly requiredDimensionsByLayer: Readonly<Record<string, readonly string[]>>;
  readonly requiredConstraints: readonly string[];
  readonly conditionalConstraints: readonly string[];
  readonly limitValue?: (name: string) => number;
  readonly enforceClosedSetAdmission?: boolean;
}): AnswerRecordPlan {
  const dimensions = Object.entries(input.requiredDimensionsByLayer).flatMap(([layer, keys]) =>
    keys.map((key) => ({ key, slot: layer })),
  );
  const member = (key: string) => key.replaceAll("-", "_");
  return planAnswerRecords({
    declaration: OUTPUT_RECORD_CONTRACTS["quality-evaluation"],
    skeletons: {
      dimensions,
      constraints: [...input.requiredConstraints, ...input.conditionalConstraints].map((key) => ({
        key,
        slot: member(key),
      })),
      layers: Object.keys(input.requiredDimensionsByLayer).map((key) => ({ key, slot: key })),
    },
    selectors: { required: input.requiredConstraints.map(member) },
    // `findings_complete` closes required-record accounting; quality replay can
    // still correct a finding while preserving the accepted ledger history.
    enforceClosedSetAdmission: input.enforceClosedSetAdmission ?? false,
    ...(input.limitValue ? { limitValue: input.limitValue } : {}),
  });
}
