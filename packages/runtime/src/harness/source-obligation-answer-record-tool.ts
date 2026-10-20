// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { OUTPUT_RECORD_CONTRACTS } from "../contracts/model-output.js";
import type { SourceObligationAnswerRecordCapabilityV1 } from "../execution/contracts.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "./answer-submission.js";
import { answerRecordReceiptForWire } from "./answer-records.js";

export function createSourceObligationAnswerRecordTool(
  capability: SourceObligationAnswerRecordCapabilityV1,
  guidance: string,
): ToolDefinition<any, any, any> {
  return {
    name: QUALITY_ANSWER_RECORD_TOOL_NAME,
    label: "Submit source-obligation record",
    description: "Submit one declared source-obligation record for host admission.",
    promptSnippet: [
      "Submit one source-obligation record per call; multiple calls per turn are supported.",
      "Read each host receipt and correct any named record before finalizing.",
      "Host-resolved source-obligation plan:",
      guidance,
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: OUTPUT_RECORD_CONTRACTS["source-obligation"].records.map((record) => record.type),
        },
        key: { type: ["string", "null"] },
        record: { type: ["object", "string"] },
      },
    },
    async execute(toolCallId: string) {
      const receipt = answerRecordReceiptForWire(
        capability.receipt(toolCallId),
        OUTPUT_RECORD_CONTRACTS["source-obligation"],
      );
      return {
        ...(receipt.status === "refused" ? { isError: true } : {}),
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        details: { kind: "docsfab-answer-record-receipt" },
      };
    },
  };
}
