// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { sha256 } from "../src/content-ir/canonical.js";
import { resolveReviewAnchor, type ReviewDiffFile } from "../src/review-delivery/anchors.js";

function file(
  input: Partial<Omit<ReviewDiffFile, "beforeBytes" | "afterBytes">> &
    Pick<ReviewDiffFile, "oldPath" | "newPath"> & {
      readonly beforeContent?: string | null;
      readonly afterContent?: string | null;
    },
): ReviewDiffFile {
  const beforeContent =
    input.beforeContent ?? (input.oldPath === null ? null : (input.afterContent ?? null));
  const afterContent = input.afterContent ?? null;
  const { beforeContent: _beforeContent, afterContent: _afterContent, ...rest } = input;
  return {
    beforeBytes: beforeContent === null ? null : new TextEncoder().encode(beforeContent),
    afterBytes: afterContent === null ? null : new TextEncoder().encode(afterContent),
    beforeSha256: beforeContent === null ? null : sha256(beforeContent),
    afterSha256: afterContent === null ? null : sha256(afterContent),
    state: "complete",
    hunks: [],
    ...rest,
  };
}

describe("exact review delivery anchors", () => {
  it("anchors added and removed lines on their respective immutable sides", () => {
    const changed = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "before\nold\nafter\n",
      afterContent: "before\nnew\nafter\n",
      hunks: [
        {
          lines: [
            { kind: "context", text: "before", beforeLine: 1, afterLine: 1 },
            { kind: "removed", text: "old", beforeLine: 2, afterLine: null },
            { kind: "added", text: "new", beforeLine: null, afterLine: 2 },
            { kind: "context", text: "after", beforeLine: 3, afterLine: 3 },
          ],
        },
      ],
    });

    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 2, text: "new" }, [changed]),
    ).toMatchObject({
      status: "anchored",
      side: "after",
      path: "guide.md",
      startLine: 2,
      endLine: 2,
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "before", line: 2, text: "old" }, [changed]),
    ).toMatchObject({
      status: "anchored",
      side: "before",
      path: "guide.md",
      startLine: 2,
      endLine: 2,
    });
  });

  it("uses the old path for a deletion and the new path for a rename", () => {
    const renamed = file({
      oldPath: "old.md",
      newPath: "new.md",
      beforeContent: "old wording\n",
      afterContent: "new wording\n",
      hunks: [
        {
          lines: [
            { kind: "removed", text: "old wording", beforeLine: 1, afterLine: null },
            { kind: "added", text: "new wording", beforeLine: null, afterLine: 1 },
          ],
        },
      ],
    });
    const deleted = file({
      oldPath: "gone.md",
      newPath: null,
      beforeContent: "retained evidence\n",
      hunks: [
        { lines: [{ kind: "removed", text: "retained evidence", beforeLine: 1, afterLine: null }] },
      ],
    });

    expect(resolveReviewAnchor({ path: "old.md", line: 1 }, [renamed])).toMatchObject({
      status: "anchored",
      side: "before",
      path: "old.md",
      oldPath: "old.md",
      newPath: "new.md",
    });
    expect(resolveReviewAnchor({ path: "new.md", line: 1 }, [renamed])).toMatchObject({
      status: "anchored",
      side: "after",
      path: "new.md",
    });
    expect(resolveReviewAnchor({ path: "gone.md", line: 1 }, [deleted])).toMatchObject({
      status: "anchored",
      side: "before",
      path: "gone.md",
    });
  });

  it("retains absent, truncated, repeated-text and empty-file locations as summary findings", () => {
    const base = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "",
      afterContent: "same\nsame\n",
    });
    const repeated = {
      ...base,
      hunks: [
        {
          lines: [
            { kind: "added" as const, text: "same", beforeLine: null, afterLine: 1 },
            { kind: "added" as const, text: "same", beforeLine: null, afterLine: 2 },
          ],
        },
      ],
    };
    const empty = file({ oldPath: "empty.md", newPath: "empty.md", afterContent: "" });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", text: "same" }, [
        { ...repeated, state: "complete" },
      ]),
    ).toEqual({
      status: "summary",
      reason: "ambiguous-text",
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", line: 1 }, [
        { ...repeated, state: "absent", hunks: [] },
      ]),
    ).toEqual({ status: "summary", reason: "diff-absent" });
    expect(
      resolveReviewAnchor({ path: "guide.md", line: 1 }, [{ ...repeated, state: "truncated" }]),
    ).toEqual({ status: "summary", reason: "diff-truncated" });
    expect(resolveReviewAnchor({ path: "empty.md", side: "after", line: 1 }, [empty])).toEqual({
      status: "summary",
      reason: "location-not-in-diff",
    });
  });

  it("rejects out-of-range, reversed, unmodified, and digest-substituted locations", () => {
    const changed = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "",
      afterContent: "first\nsecond\n",
      hunks: [
        {
          lines: [
            { kind: "added", text: "first", beforeLine: null, afterLine: 1 },
            { kind: "added", text: "second", beforeLine: null, afterLine: 2 },
          ],
        },
      ],
    });
    expect(resolveReviewAnchor({ path: "guide.md", side: "after", line: 3 }, [changed])).toEqual({
      status: "summary",
      reason: "location-not-in-diff",
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 2, endLine: 1 }, [changed]),
    ).toEqual({
      status: "summary",
      reason: "invalid-range",
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", line: 1 }, [
        { ...changed, afterSha256: "0".repeat(64) },
      ]),
    ).toEqual({
      status: "summary",
      reason: "source-digest-mismatch",
    });
    expect(resolveReviewAnchor({ path: "other.md", line: 1 }, [changed])).toEqual({
      status: "summary",
      reason: "path-not-in-diff",
    });
  });

  it("rejects a poisoned surrounding hunk and duplicate line mapping", () => {
    const changed = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "",
      afterContent: "first\nsecond\n",
      hunks: [
        {
          lines: [
            { kind: "added", text: "first", beforeLine: null, afterLine: 1 },
            { kind: "added", text: "poison", beforeLine: null, afterLine: 2 },
          ],
        },
      ],
    });
    expect(resolveReviewAnchor({ path: "guide.md", line: 1 }, [changed])).toEqual({
      status: "summary",
      reason: "source-digest-mismatch",
    });
    const duplicated = {
      ...changed,
      hunks: [
        {
          lines: [
            { kind: "added" as const, text: "first", beforeLine: null, afterLine: 1 },
            { kind: "added" as const, text: "first", beforeLine: null, afterLine: 1 },
          ],
        },
      ],
    };
    expect(resolveReviewAnchor({ path: "guide.md", line: 1 }, [duplicated])).toEqual({
      status: "summary",
      reason: "diff-invalid",
    });
  });

  it("requires one ordered complete edit script across unchanged gaps and suffixes", () => {
    const changed = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "prefix\nold\nmiddle\nold2\nsuffix\n",
      afterContent: "prefix\nnew\nmiddle\nnew2\nsuffix\n",
      hunks: [
        {
          lines: [
            { kind: "removed", text: "old", beforeLine: 2, afterLine: null },
            { kind: "added", text: "new", beforeLine: null, afterLine: 2 },
          ],
        },
        {
          lines: [
            { kind: "removed", text: "old2", beforeLine: 4, afterLine: null },
            { kind: "added", text: "new2", beforeLine: null, afterLine: 4 },
          ],
        },
      ],
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 2 }, [changed]).status,
    ).toBe("anchored");
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 4 }, [changed]).status,
    ).toBe("anchored");
    const omitted = { ...changed, hunks: [changed.hunks[0]!] };
    expect(resolveReviewAnchor({ path: "guide.md", side: "after", line: 2 }, [omitted])).toEqual({
      status: "summary",
      reason: "diff-invalid",
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 2 }, [
        { ...changed, hunks: [changed.hunks[1]!, changed.hunks[0]!] },
      ]),
    ).toEqual({ status: "summary", reason: "diff-invalid" });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 2 }, [
        { ...changed, hunks: [{ lines: [changed.hunks[0]!.lines[1]!] }, changed.hunks[1]!] },
      ]),
    ).toEqual({ status: "summary", reason: "diff-invalid" });
  });

  it("accepts native BOM and CRLF rows while retaining original byte digests", () => {
    const changed = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "\uFEFFbefore\r\n",
      afterContent: "\uFEFFafter\r\n",
      hunks: [
        {
          lines: [
            { kind: "removed", text: "\uFEFFbefore", beforeLine: 1, afterLine: null },
            { kind: "added", text: "\uFEFFafter", beforeLine: null, afterLine: 1 },
          ],
        },
      ],
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 1 }, [changed]),
    ).toMatchObject({
      status: "anchored",
      sourceSha256: changed.afterSha256,
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 1 }, [
        { ...changed, hunks: [{ lines: [{ ...changed.hunks[0]!.lines[1]!, text: "after" }] }] },
      ]),
    ).toEqual({ status: "summary", reason: "source-digest-mismatch" });
  });

  it("uses an explicit side across rename/add path collisions and retains absent-side ambiguity", () => {
    const renamed = file({
      oldPath: "a.md",
      newPath: "b.md",
      beforeContent: "old\n",
      afterContent: "renamed\n",
      hunks: [
        {
          lines: [
            { kind: "removed", text: "old", beforeLine: 1, afterLine: null },
            { kind: "added", text: "renamed", beforeLine: null, afterLine: 1 },
          ],
        },
      ],
    });
    const added = file({
      oldPath: null,
      newPath: "a.md",
      afterContent: "fresh\n",
      hunks: [{ lines: [{ kind: "added", text: "fresh", beforeLine: null, afterLine: 1 }] }],
    });
    expect(
      resolveReviewAnchor({ path: "a.md", side: "before", line: 1 }, [renamed, added]),
    ).toMatchObject({
      status: "anchored",
      side: "before",
      sourceSha256: renamed.beforeSha256,
    });
    expect(
      resolveReviewAnchor({ path: "a.md", side: "after", line: 1 }, [renamed, added]),
    ).toMatchObject({
      status: "anchored",
      side: "after",
      sourceSha256: added.afterSha256,
    });
    expect(resolveReviewAnchor({ path: "a.md", line: 1 }, [renamed, added])).toEqual({
      status: "summary",
      reason: "ambiguous-side",
    });
  });

  it("does not infer an after-side replacement from an absent-side same-path locator", () => {
    const replaced = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "removed\n",
      afterContent: "replacement\n",
      hunks: [
        {
          lines: [
            { kind: "removed", text: "removed", beforeLine: 1, afterLine: null },
            { kind: "added", text: "replacement", beforeLine: null, afterLine: 1 },
          ],
        },
      ],
    });
    expect(resolveReviewAnchor({ path: "guide.md", line: 1 }, [replaced])).toEqual({
      status: "summary",
      reason: "ambiguous-side",
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "before", line: 1 }, [replaced]),
    ).toMatchObject({
      status: "anchored",
      side: "before",
      sourceSha256: replaced.beforeSha256,
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 1 }, [replaced]),
    ).toMatchObject({
      status: "anchored",
      side: "after",
      sourceSha256: replaced.afterSha256,
    });
  });

  it("does not treat a line number present only after an insertion as side provenance", () => {
    const inserted = file({
      oldPath: "guide.md",
      newPath: "guide.md",
      beforeContent: "original\n",
      afterContent: "new\noriginal\n",
      hunks: [
        {
          lines: [
            { kind: "added", text: "new", beforeLine: null, afterLine: 1 },
            { kind: "context", text: "original", beforeLine: 1, afterLine: 2 },
          ],
        },
      ],
    });
    expect(resolveReviewAnchor({ path: "guide.md", line: 2 }, [inserted])).toEqual({
      status: "summary",
      reason: "ambiguous-side",
    });
    expect(
      resolveReviewAnchor({ path: "guide.md", side: "after", line: 2 }, [inserted]),
    ).toMatchObject({
      status: "anchored",
      side: "after",
      startLine: 2,
    });
  });
});
