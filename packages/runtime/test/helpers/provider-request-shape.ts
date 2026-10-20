// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

/** One chat-completions request body, as a capturing `fetch` parsed it. */
export interface RecordedProviderRequest {
  messages?: ReadonlyArray<{ role?: unknown; tool_calls?: unknown; content?: unknown }>;
  tools?: unknown;
}

/** Whether a recorded request's conversation already holds tool calls or tool results. */
export function carriesToolHistory(request: RecordedProviderRequest): boolean {
  return (request.messages ?? []).some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0),
  );
}

/**
 * A conversation holding tool calls or tool results, sent with `tools` absent
 * or empty, is refused with HTTP 400 by at least one provider front door
 * ("Bedrock doesn't support tool calling without tools= param specified"). A
 * scripted `fetch` accepts it, so harness cases assert no request had that
 * shape. The message names the request index.
 */
export function expectNoToolHistoryWithoutTools(
  requests: readonly RecordedProviderRequest[],
): void {
  requests.forEach((request, index) => {
    if (!carriesToolHistory(request)) return;
    expect(
      Array.isArray(request.tools) ? request.tools.length : 0,
      `request ${index} carries tool history but no tools`,
    ).toBeGreaterThan(0);
  });
}
