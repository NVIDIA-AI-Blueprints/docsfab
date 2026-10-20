// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseChangeRequestSelector } from "../src/inputs/change-request-selector.js";
import { parseLiveAgentChangeReviewReference } from "../src/live-agent/change-review.js";
import { liveAgentWorkflowRunRequest } from "../src/live-agent/host.js";
import {
  SOURCE_COMMAND_REFUSALS,
  createLiveAgentSourceSelection,
  renderSourceCommandOutcome,
} from "../src/live-agent/source-commands.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

describe("live-agent selected change-review basis", () => {
  it.each([
    ["https://github.com/voice-team/agent-docs/pull/161", "github-pull-request"],
    ["gitlab.example.test/group/project!42", "gitlab-merge-request"],
  ] as const)(
    "passes an operator-selected %s through the shared request field",
    async (reference, kind) => {
      const selection = createLiveAgentSourceSelection();
      const outcome = await selection.dispatch(`/sources review ${reference}`);

      expect(outcome?.kind).toBe("review-selected");
      expect(renderSourceCommandOutcome(outcome!).replaceAll(/\s+/gu, " ")).toContain(
        "No pull or merge request source was read or reviewed by this selection command.",
      );
      expect(selection.requestFields().changeSource?.source).toBe(kind);
      expect(selection.instructionCompatibilityFields().changeSource).toEqual(
        selection.requestFields().changeSource,
      );
    },
  );

  it.each([
    "https://github.com/voice-team/agent-docs/pull/161",
    "gitlab.example.test/group/project!42",
  ])("refuses an unrelated workflow with selected review evidence from %s", async (reference) => {
    const selection = createLiveAgentSourceSelection();
    await selection.dispatch(`/sources review ${reference}`);
    const changeSource = selection.requestFields().changeSource;
    if (!changeSource) throw new Error("Missing selected change source.");

    const request = {
      instruction: "Summarize the selected change.",
      repositoryPath: "/workspace/docsfab",
      allowWrite: false,
      changeSource,
    } as const;
    expect(() => liveAgentWorkflowRunRequest({ ...request, workflow: "bootstrap" })).toThrow(
      /attached bound sources.*--pr or --mr is supported only/u,
    );
    expect(
      liveAgentWorkflowRunRequest({ ...request, workflow: "update-documentation" }).changeSource,
    ).toEqual(changeSource);
  });

  it("keeps a selected PR separate from repository-file source grants", async () => {
    const selection = createLiveAgentSourceSelection({ sourcePaths: ["docs/guide.md"] });
    await selection.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");

    expect(selection.requestFields()).toMatchObject({
      sourcePaths: ["docs/guide.md"],
      changeSource: { source: "github-pull-request", number: 161 },
    });
    expect(selection.requestFields().changeRequestSelector).toBeUndefined();
  });

  it.each([
    ["a different reference", "https://github.com/voice-team/agent-docs/pull/162"],
    ["the same reference", "https://github.com/voice-team/agent-docs/pull/161"],
  ])("refuses to replace a selected review basis with %s", async (_label, reference) => {
    const selection = createLiveAgentSourceSelection();
    await selection.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");

    await expect(selection.dispatch(`/sources review ${reference}`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["one-change-request"],
    );
    expect(selection.requestFields().changeSource).toMatchObject({
      source: "github-pull-request",
      number: 161,
    });
  });

  it("retains the exact operator-selected reference across source snapshot restore", async () => {
    const selected = createLiveAgentSourceSelection();
    await selected.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");
    const restored = createLiveAgentSourceSelection();
    await restored.restoreState(selected.snapshotState());

    expect(restored.requestFields().changeSource).toEqual(selected.requestFields().changeSource);
    const listing = await restored.dispatch("/sources");
    expect(listing?.kind).toBe("listing");
    expect(renderSourceCommandOutcome(listing!)).toMatch(/Source read[\s:]*not-read/u);
    expect(renderSourceCommandOutcome(listing!)).toContain("voice-team/agent-docs#161");
  });

  it("rejects a restored snapshot that combines a merged change and a review basis", async () => {
    const mergedChange = createLiveAgentSourceSelection({
      changeRequestSelector: parseChangeRequestSelector("42"),
    });
    const conflictingSnapshot = {
      ...mergedChange.snapshotState(),
      changeReviewReference: "https://github.com/voice-team/agent-docs/pull/161",
    };
    const restored = createLiveAgentSourceSelection();

    await expect(restored.restoreState(conflictingSnapshot)).rejects.toThrow(/invalid-value/u);
    expect(restored.requestFields()).toEqual({});
  });

  it("refuses to replace a newly selected basis with an older snapshot that omitted it", async () => {
    const persistedWithoutReview = createLiveAgentSourceSelection().snapshotState();
    const selection = createLiveAgentSourceSelection();
    await selection.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");

    await expect(selection.restoreState(persistedWithoutReview)).rejects.toThrow(
      /snapshot rejected/u,
    );
    expect(selection.requestFields().changeSource?.source).toBe("github-pull-request");
  });

  it("lists and shows the selected basis as unread until a review consumes it", async () => {
    const selection = createLiveAgentSourceSelection();
    await selection.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");

    const listing = await selection.dispatch("/sources list");
    expect(listing).toMatchObject({
      kind: "listing",
      entries: [],
      changeReview: {
        label: "voice-team/agent-docs#161",
        provider: "github",
        status: "selected",
        sourceRead: "not-read",
      },
    });
    expect(renderSourceCommandOutcome(listing!)).toMatch(/Source read[\s:]*not-read/u);

    const detail = await selection.dispatch("/sources show voice-team/agent-docs#161");
    expect(detail?.kind).toBe("review-detail");
    expect(renderSourceCommandOutcome(detail!)).toContain(
      "https://github.com/voice-team/agent-docs/pull/161",
    );
    expect(renderSourceCommandOutcome(detail!)).toMatch(/Source read[\s:]*not-read/u);
  });

  it("detaches only the selected review basis by its listed label", async () => {
    const selection = createLiveAgentSourceSelection({ sourcePaths: ["docs/guide.md"] });
    await selection.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");

    const detached = await selection.dispatch("/sources remove voice-team/agent-docs#161");
    expect(detached?.kind).toBe("review-detached");
    expect(renderSourceCommandOutcome(detached!)).toContain("detached");
    expect(selection.requestFields()).toEqual({ sourcePaths: ["docs/guide.md"] });
    const listing = await selection.dispatch("/sources list");
    expect(renderSourceCommandOutcome(listing!)).not.toContain("voice-team/agent-docs#161");
  });

  it("refuses unsupported source types without retaining a selector", async () => {
    const selection = createLiveAgentSourceSelection();

    await expect(
      selection.dispatch(
        "/sources review https://github.com/voice-team/agent-docs/compare/main...topic",
      ),
    ).rejects.toThrow(/not a supported pull or merge request reference/u);
    expect(selection.requestFields().changeSource).toBeUndefined();
  });

  it("does not retain a review basis refused by the configured credential screen", async () => {
    const credential = configureCredential(["glpat", plantedCredentialValue(91, 24)].join("-"));
    const selection = createLiveAgentSourceSelection();

    await expect(
      selection.dispatch(`/sources review gitlab.example.test/team/${credential}!42`),
    ).rejects.toThrow(/credential/u);
    expect(selection.requestFields().changeSource).toBeUndefined();
    expect(selection.snapshotState().changeReviewReference).toBeUndefined();

    await selection.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");
    expect(selection.requestFields().changeSource?.source).toBe("github-pull-request");
  });

  it("refuses a credential-bearing review basis during CLI session startup", () => {
    const credential = configureCredential(["glpat", plantedCredentialValue(92, 24)].join("-"));
    const changeSource = parseLiveAgentChangeReviewReference(
      `gitlab.example.test/team/${credential}!42`,
    );

    expect(() => createLiveAgentSourceSelection({ changeSource })).toThrow(/credential/u);
  });
});
