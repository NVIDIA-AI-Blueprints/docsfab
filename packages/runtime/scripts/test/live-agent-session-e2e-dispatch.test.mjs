// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifyInstalledSessionRequest } from "../live-agent-session-e2e-dispatch.mjs";

const prompts = {
  installedTaskPrompt: "Update the exact AsciiDoc file granted for this bounded task.",
  savedRunPrompt: "Summarize saved review saved-review. Do not rerun, edit, or publish anything.",
  liveWorkflowPublicationPrompt:
    "Correct docs/guide.md using the bounded documentation workflow and create a draft MR for its exact saved run.",
};

describe("live-agent installed E2E provider dispatch", () => {
  it("routes provider turns 17-20 by scenario conversation, not request ordinal", () => {
    const requests = [
      {
        messages: [{ role: "user", content: prompts.installedTaskPrompt }],
        tools: [{ function: { name: "edit" } }, { function: { name: "docsfab_read_run" } }],
      },
      {
        messages: [
          { role: "user", content: prompts.installedTaskPrompt },
          { role: "tool", content: "edit completed" },
        ],
      },
      { messages: [{ role: "user", content: prompts.savedRunPrompt }] },
      {
        messages: [
          { role: "user", content: prompts.savedRunPrompt },
          { role: "tool", content: "Saved fixture review finding." },
        ],
      },
    ];

    expect(requests.map((request) => classifyInstalledSessionRequest(request, prompts))).toEqual([
      "installed-bounded-task",
      "installed-bounded-task",
      "saved-run-recovery",
      "saved-run-recovery",
    ]);
  });

  it("routes live workflow publication turns by the retained request at any later offset", () => {
    const payload = {
      messages: [
        { role: "user", content: prompts.liveWorkflowPublicationPrompt },
        { role: "tool", content: '{"kind":"docsfab-live-workflow-result"}' },
      ],
      tools: [{ function: { name: "docsfab_publish_workflow" } }],
    };

    expect(classifyInstalledSessionRequest(payload, prompts)).toBe(
      "live-workflow-publication-session",
    );
  });
});
