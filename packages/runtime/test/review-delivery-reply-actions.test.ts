// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  ReviewReplyActionV2,
  ReviewReplyFeedbackDispositionV2,
  ReviewReplyIntentV2,
} from "../src/review-delivery/contracts.js";
import { visitExplicitReviewReplyCommand } from "../src/review-delivery/reply-actions.js";
import { visitUntrustedGitLabReply } from "../src/review-delivery/providers/gitlab-replies.js";
import { visitUntrustedGitHubReply } from "../src/review-delivery/providers/github-replies.js";

type CommandIntent = Exclude<ReviewReplyActionV2["intent"], "record-feedback">;

function classify(body: unknown): {
  accepted: boolean;
  intents: CommandIntent[];
  feedback: Array<[ReviewReplyFeedbackDispositionV2, string]>;
} {
  const intents: CommandIntent[] = [];
  const feedback: Array<[ReviewReplyFeedbackDispositionV2, string]> = [];
  const accepted = visitExplicitReviewReplyCommand(body, {
    onIntent: (intent) => intents.push(intent),
    onFeedback: (disposition, reason) => feedback.push([disposition, reason]),
  });
  return { accepted, intents, feedback };
}

describe("explicit review reply command classification", () => {
  const commands = [
    ["/docsfab explain", "explain-evidence"],
    ["/docsfab recheck", "request-recheck"],
    ["/docsfab fix", "prepare-fix-handoff"],
  ] as const satisfies ReadonlyArray<readonly [string, ReviewReplyIntentV2]>;

  it.each(commands)("accepts exact top-level %s", (body, intent) => {
    expect(classify(body)).toEqual({ accepted: true, intents: [intent], feedback: [] });
  });

  const dispositions: readonly ReviewReplyFeedbackDispositionV2[] = [
    "useful",
    "incorrect",
    "irrelevant",
    "already-covered",
    "intentional",
    "deferred",
  ];

  it.each(dispositions)("retains %s feedback and its required reason", (disposition) => {
    expect(
      classify(`/docsfab feedback ${disposition}: Evidence differs from this revision.`),
    ).toEqual({
      accepted: true,
      intents: [],
      feedback: [[disposition, "Evidence differs from this revision."]],
    });
  });

  it.each([
    "/docsfab feedback incorrect:",
    "/docsfab feedback incorrect:   ",
    "/docsfab feedback useful: /docsfab fix",
    "/docsfab explain\n/docsfab fix",
    "> /docsfab explain",
    "```\n/docsfab recheck\n```",
    "Copied instruction: /docsfab fix",
    " /docsfab explain",
    "/docsfab EXPLAIN",
    "/docsfab feedback unknown: Reason",
    "/docsfab fix please",
    42,
    null,
  ])("refuses malformed, mixed, quoted, fenced or copied input %#", (body) => {
    expect(classify(body)).toEqual({ accepted: false, intents: [], feedback: [] });
  });

  it("does not emit an action when a second marker is inside a feedback reason", () => {
    expect(classify("/docsfab feedback deferred: copied /DOCSFAB explain")).toEqual({
      accepted: false,
      intents: [],
      feedback: [],
    });
  });
});

describe("untrusted provider reply shape normalization", () => {
  const gitlab = {
    provider: "gitlab",
    project_id: 301,
    merge_request_iid: 17,
    root_note_id: 41,
    discussion: {
      id: "thread-a",
      notes: [
        { id: 41, author: { id: 5 }, body: "Original DocsFab note" },
        { id: 42, author: { id: 9 }, body: "/docsfab explain" },
      ],
    },
    reply_id: 42,
  };

  it("preserves GitLab project, discussion, root, reply, actor and body as untrusted data", () => {
    const seen = vi.fn();
    expect(visitUntrustedGitLabReply(gitlab, seen)).toBe(true);
    expect(seen).toHaveBeenCalledExactlyOnceWith(
      301,
      17,
      "thread-a",
      41,
      42,
      9,
      "/docsfab explain",
    );
  });

  it("uses the supplied GitLab root ID when discussion notes arrive out of order", () => {
    const seen = vi.fn();
    const priorReply = { id: 43, author: { id: 8 }, body: "Earlier reply" };
    const reordered = {
      ...gitlab,
      discussion: {
        ...gitlab.discussion,
        notes: [priorReply, gitlab.discussion.notes[1], gitlab.discussion.notes[0]],
      },
    };
    expect(visitUntrustedGitLabReply(reordered, seen)).toBe(true);
    expect(seen).toHaveBeenCalledExactlyOnceWith(
      301,
      17,
      "thread-a",
      41,
      42,
      9,
      "/docsfab explain",
    );
  });

  it("refuses a provider object with a throwing field as ordinary invalid input", () => {
    const seen = vi.fn();
    expect(
      visitUntrustedGitLabReply(
        {
          get provider() {
            throw new Error("untrusted getter");
          },
        },
        seen,
      ),
    ).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  it.each([
    { ...gitlab, provider: "github" },
    { ...gitlab, project_id: "301" },
    { ...gitlab, root_note_id: "41" },
    { ...gitlab, root_note_id: 99 },
    { ...gitlab, root_note_id: 42 },
    { ...gitlab, root_note_id: undefined },
    { ...gitlab, reply_id: 99 },
    { ...gitlab, discussion: { ...gitlab.discussion, notes: [gitlab.discussion.notes[0]] } },
    {
      ...gitlab,
      discussion: {
        ...gitlab.discussion,
        notes: [{ ...gitlab.discussion.notes[0], body: 7 }, gitlab.discussion.notes[1]],
      },
    },
    {
      ...gitlab,
      discussion: {
        ...gitlab.discussion,
        notes: [gitlab.discussion.notes[0], { ...gitlab.discussion.notes[1], author: { id: "9" } }],
      },
    },
    {
      ...gitlab,
      discussion: {
        ...gitlab.discussion,
        notes: [gitlab.discussion.notes[0], gitlab.discussion.notes[0]],
      },
    },
    null,
  ])("refuses a malformed or mismatched GitLab reply %#", (input) => {
    const seen = vi.fn();
    expect(visitUntrustedGitLabReply(input, seen)).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  const github = {
    provider: "github",
    repository: { id: 401, owner: { login: "docs" }, name: "site" },
    pull_number: 23,
    root_comment_id: 51,
    comments: [
      { id: 51, in_reply_to_id: null, user: { id: 6 }, body: "Original DocsFab review comment" },
      { id: 52, in_reply_to_id: 51, user: { id: 8 }, body: "Question" },
      { id: 53, in_reply_to_id: 52, user: { id: 9 }, body: "/docsfab recheck" },
    ],
    reply_id: 53,
  };

  it("retains an incoming GitHub reply to an intermediate comment under the given root", () => {
    const seen = vi.fn();
    expect(visitUntrustedGitHubReply(github, seen)).toBe(true);
    expect(seen).toHaveBeenCalledExactlyOnceWith(
      401,
      "docs",
      "site",
      23,
      51,
      52,
      53,
      9,
      "/docsfab recheck",
    );
  });

  it("accepts a top-level GitHub root whose in_reply_to_id is absent", () => {
    const seen = vi.fn();
    const { in_reply_to_id: _unused, ...root } = github.comments[0];
    expect(
      visitUntrustedGitHubReply(
        { ...github, comments: [root, github.comments[1], github.comments[2]] },
        seen,
      ),
    ).toBe(true);
    expect(seen).toHaveBeenCalledExactlyOnceWith(
      401,
      "docs",
      "site",
      23,
      51,
      52,
      53,
      9,
      "/docsfab recheck",
    );
  });

  it("refuses a GitHub provider object with a throwing field", () => {
    const seen = vi.fn();
    expect(
      visitUntrustedGitHubReply(
        {
          get provider() {
            throw new Error("untrusted getter");
          },
        },
        seen,
      ),
    ).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  it.each([
    { ...github, provider: "gitlab" },
    { ...github, repository: { ...github.repository, id: "401" } },
    { ...github, root_comment_id: 99 },
    { ...github, reply_id: 99 },
    { ...github, comments: [github.comments[0], github.comments[2]] },
    {
      ...github,
      comments: [
        github.comments[0],
        { ...github.comments[1], in_reply_to_id: 53 },
        github.comments[2],
      ],
    },
    {
      ...github,
      comments: [
        github.comments[0],
        github.comments[1],
        { ...github.comments[2], user: { id: "9" } },
      ],
    },
    {
      ...github,
      comments: [github.comments[0], github.comments[1], github.comments[1], github.comments[2]],
    },
    undefined,
  ])("refuses a malformed or unrelated GitHub reply %#", (input) => {
    const seen = vi.fn();
    expect(visitUntrustedGitHubReply(input, seen)).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });
});
