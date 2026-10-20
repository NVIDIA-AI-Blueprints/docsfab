// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  LiveAgentChangeReviewReferenceError,
  parseLiveAgentChangeReviewReference,
} from "../src/live-agent/change-review.js";

describe("live-agent change-review reference adapter", () => {
  it("parses a GitHub pull request without losing its repository and number", () => {
    expect(
      parseLiveAgentChangeReviewReference("https://github.com/voice-team/agent-docs/pull/161"),
    ).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "github-pull-request",
      host: "github.com",
      owner: "voice-team",
      repository: "agent-docs",
      number: 161,
    });
  });

  it("parses a configured GitLab project reference without resolving it", () => {
    expect(parseLiveAgentChangeReviewReference("gitlab.example.test/group/project!42")).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "gitlab-merge-request",
      changeRequest: {
        schemaVersion: 1,
        kind: "docsfab-change-request-selector",
        provider: "gitlab",
        host: "gitlab.example.test",
        projectPath: "group/project",
        number: 42,
      },
    });
  });

  it.each([
    "https://github.com/voice-team/agent-docs/pull/not-a-number",
    "https://github.com/voice-team/agent-docs/pull/161/files/one-file",
    "https://gitlab.com/group/project/-/merge_requests/42/commits/one-commit",
  ])("refuses malformed or partial review references without echoing input: %s", (reference) => {
    expect(() => parseLiveAgentChangeReviewReference(reference)).toThrow(
      LiveAgentChangeReviewReferenceError,
    );
    try {
      parseLiveAgentChangeReviewReference(reference);
    } catch (error) {
      expect(error).toBeInstanceOf(LiveAgentChangeReviewReferenceError);
      expect((error as Error).message).not.toContain(reference);
    }
  });

  it.each([
    "https://github.com/voice-team/agent-docs/commit/abcdef0123456789",
    "https://github.com/voice-team/agent-docs/compare/main...topic",
    "HEAD~1..HEAD",
  ])("rejects a change selector that is not a whole PR: %s", (reference) => {
    expect(() => parseLiveAgentChangeReviewReference(reference)).toThrow(
      LiveAgentChangeReviewReferenceError,
    );
  });
});
