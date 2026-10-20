// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared channel formatting, independent of execution and provider budgets.
 * The caller has already bounded the retained answer. Every iteration consumes
 * input; there is no separate policy ceiling on the number of messages.
 */
export function liveAgentAnswerSequenceMarkerWidth(total: number): number {
  return `\n(${total}/${total})`.length;
}

/**
 * Preserve every UTF-16 code unit, including whitespace and surrogate pairs.
 * `messageBudget` includes the sequence marker added by the channel. Re-plan
 * only when the actual message count needs a wider marker (9 to 10, etc.).
 */
export function planLiveAgentAnswerChunks(
  answer: string,
  messageBudget: number,
): readonly string[] {
  if (!Number.isSafeInteger(messageBudget) || messageBudget < 1) {
    throw new RangeError("Live-agent message budget must be a positive safe integer.");
  }
  let markerWidth = liveAgentAnswerSequenceMarkerWidth(1);
  for (;;) {
    const bodyBudget = messageBudget - markerWidth;
    if (bodyBudget < 2) {
      throw new RangeError("Live-agent message budget cannot fit text and its sequence marker.");
    }
    const chunks: string[] = [];
    let offset = 0;
    while (offset < answer.length) {
      let end = Math.min(answer.length, offset + bodyBudget);
      if (end < answer.length) {
        const window = answer.slice(offset, end);
        for (const separator of ["\n\n", "\n", " "]) {
          const at = window.lastIndexOf(separator);
          if (at > 0) {
            end = offset + at + separator.length;
            break;
          }
        }
        if (
          /[\uD800-\uDBFF]/u.test(answer[end - 1] ?? "") &&
          /[\uDC00-\uDFFF]/u.test(answer[end] ?? "")
        )
          end -= 1;
      }
      chunks.push(answer.slice(offset, end));
      offset = end;
    }
    const neededWidth = liveAgentAnswerSequenceMarkerWidth(chunks.length);
    if (neededWidth <= markerWidth) return Object.freeze(chunks);
    markerWidth = neededWidth;
  }
}
