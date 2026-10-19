// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Project host-admitted answer-record receipts into each provider request. */
import type { HarnessStepInput } from "../../execution/contracts.js";
import type { ModelConnection } from "../../model/provider.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../answer-submission.js";
import { createPiAgentSession, userMessageText } from "../pi-session.js";

export function installPiAnswerRecordReplay(
  session: Awaited<ReturnType<typeof createPiAgentSession>>,
  model: ModelConnection["model"],
  input: Pick<HarnessStepInput, "qualityAnswerRecordReplay" | "qualityAnswerRecordRemainingKeys">,
  expectedSkillExpansion: string,
): void {
  if (!input.qualityAnswerRecordReplay?.length && !input.qualityAnswerRecordRemainingKeys) return;
  const replayMessages = (input.qualityAnswerRecordReplay ?? []).flatMap((pair) => [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: pair.toolCallId,
          name: QUALITY_ANSWER_RECORD_TOOL_NAME,
          arguments: pair.toolArguments,
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: Date.now(),
    },
    {
      role: "toolResult" as const,
      toolCallId: pair.toolCallId,
      toolName: QUALITY_ANSWER_RECORD_TOOL_NAME,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: "admitted", type: pair.type, key: pair.key }),
        },
      ],
      isError: false,
      timestamp: Date.now(),
    },
  ]);
  // Pi expands the governed skill prefix in prompt(). Insert receipts only
  // after that verified user message, and only in the provider projection.
  const previousTransform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const context = previousTransform ? await previousTransform(messages, signal) : messages;
    const firstUserIndex = context.findIndex((message) => message.role === "user");
    const firstUser =
      firstUserIndex >= 0
        ? (context[firstUserIndex] as Extract<(typeof context)[number], { role: "user" }>)
        : undefined;
    if (!firstUser || !userMessageText(firstUser).startsWith(expectedSkillExpansion)) {
      return context;
    }
    const remainingMessage = input.qualityAnswerRecordRemainingKeys
      ? [
          {
            role: "user" as const,
            content: `Host answer-record state: remaining keys ${JSON.stringify(input.qualityAnswerRecordRemainingKeys)}.`,
            timestamp: Date.now(),
          },
        ]
      : [];
    const insert = [...(replayMessages as typeof context), ...remainingMessage];
    if (insert.length === 0) return context;
    return [
      ...context.slice(0, firstUserIndex + 1),
      ...insert,
      ...context.slice(firstUserIndex + 1),
    ];
  };
}
