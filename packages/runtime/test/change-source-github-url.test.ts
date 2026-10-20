// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `--change` grammar for github.com pull request and commit URLs (row 7):
 * what it claims, what it refuses with its own code, what it leaves to other
 * kinds, and that no refusal echoes the operator's value.
 */
import { describe, expect, it } from "vitest";

import { parseRunArguments } from "../src/cli/run-arguments.js";
import {
  CHANGE_SOURCE_SELECTOR_ARMS,
  ChangeSourceError,
  parseChangeSourceSelector,
} from "../src/inputs/change-source.js";

/** The shipped GitHub arm, found in the registry by what it claims, not by its position. */
const githubChangeSourceSelectorArm = (() => {
  const claiming = CHANGE_SOURCE_SELECTOR_ARMS.filter(
    (arm) => arm("https://github.com/o/r/pull/1")?.source === "github-pull-request",
  );
  if (claiming.length !== 1) throw new Error(`expected one GitHub arm, found ${claiming.length}`);
  return claiming[0]!;
})();
import { parseChangeRequestSelector } from "../src/inputs/change-request-selector.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function refusal(value: string): ChangeSourceError {
  try {
    parseChangeSourceSelector(value);
  } catch (error) {
    if (error instanceof ChangeSourceError) return error;
    throw error;
  }
  throw new Error(`expected a refusal for a value of length ${value.length}`);
}

const pull = (owner: string, repository: string, number: number) => ({
  schemaVersion: 1,
  kind: "docsfab-change-source-selector",
  source: "github-pull-request",
  host: "github.com",
  owner,
  repository,
  number,
});

describe("github.com pull request and commit URLs", () => {
  it("claims every whole-pull-request view as one selector", () => {
    for (const value of [
      "https://github.com/octo-org/widget/pull/42",
      "https://github.com/octo-org/widget/pull/42/",
      "https://github.com/octo-org/widget/pull/42/files",
      "https://github.com/octo-org/widget/pull/42/commits",
      "https://github.com/octo-org/widget/pull/42/changes",
      "https://github.com/octo-org/widget/pull/42/files#diff-0123abcd",
      "https://github.com/octo-org/widget/pull/42#issuecomment-1",
      "https://www.github.com/octo-org/widget/pull/42",
      "https://GitHub.com/octo-org/widget/pull/42",
      "https://github.com/octo-org/widget/pull/42.diff",
      "https://github.com/octo-org/widget/pull/42.patch",
    ]) {
      expect(parseChangeSourceSelector(value), value).toEqual(pull("octo-org", "widget", 42));
    }
    expect(parseChangeSourceSelector("https://github.com/a/b.c_d-e/pull/1")).toEqual(
      pull("a", "b.c_d-e", 1),
    );
  });

  it("claims a commit URL, lowercasing the id and keeping an abbreviation for resolution to pin", () => {
    expect(
      parseChangeSourceSelector(`https://github.com/octo-org/widget/commit/${SHA.toUpperCase()}`),
    ).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "github-commit",
      host: "github.com",
      owner: "octo-org",
      repository: "widget",
      commit: SHA,
    });
    expect(parseChangeSourceSelector("https://github.com/o/r/commit/abcd").source).toBe(
      "github-commit",
    );
    expect(parseChangeSourceSelector(`https://github.com/o/r/commit/${SHA}.patch`)).toMatchObject({
      commit: SHA,
    });
  });

  it("refuses each unsafe or partial github.com form with its own code and never echoes the value", () => {
    const secret = "s3cr3t-Value";
    const cases: ReadonlyArray<readonly [string, string, string?]> = [
      [`https://user:${secret}@github.com/o/r/pull/1`, "change-source-github-url-credentials"],
      [`https://${secret}@github.com/o/r/pull/1`, "change-source-github-url-credentials"],
      [`http://user:${secret}@github.com/o/r/pull/1`, "change-source-github-url-credentials"],
      ["http://github.com/o/r/pull/1", "change-source-github-url-insecure"],
      ["https://github.com:8443/o/r/pull/1", "change-source-github-url-grammar", "port"],
      [
        `https://github.com/o/r/pull/1?w=${secret}`,
        "change-source-github-url-grammar",
        "query string",
      ],
      [
        "https://github.com/o/r/pull/1/files?diff=split",
        "change-source-github-url-grammar",
        "query string",
      ],
      [`https://github.com/o/r/pull/1/files/${SHA}..${SHA}`, "change-source-github-url-partial"],
      [`https://github.com/o/r/pull/1/files/${SHA}`, "change-source-github-url-partial"],
      [`https://github.com/o/r/pull/1/commits/${SHA}`, "change-source-github-url-partial"],
      [
        `https://github.com/o/r/compare/main@{1day}...${secret}`,
        "change-source-github-compare-unsupported",
      ],
      ["https://github.com/o/r/compare/main", "change-source-github-compare-unsupported"],
      [
        "https://github.com/o/r/compare/owner:branch...main",
        "change-source-github-compare-unsupported",
      ],
      [
        "https://github.com/o/r/compare/main@{1day}...main",
        "change-source-github-compare-unsupported",
      ],
      ["https://github.com/o/r/pull/0", "change-source-github-url-grammar", "pull request number"],
      [
        "https://github.com/o/r/pull/007",
        "change-source-github-url-grammar",
        "pull request number",
      ],
      [
        "https://github.com/o/r/pull/99999999999999999999",
        "change-source-github-url-grammar",
        "pull request number",
      ],
      [
        "https://github.com/o/r/pull/1/checks",
        "change-source-github-url-grammar",
        "pull request view",
      ],
      [
        "https://github.com/o/r/pull/1.diff/files",
        "change-source-github-url-grammar",
        "pull request number",
      ],
      ["https://github.com/o/r/commit/abc", "change-source-github-url-grammar", "commit id"],
      [`https://github.com/o/r/commit/${SHA}0`, "change-source-github-url-grammar", "commit id"],
      ["https://github.com/o/r/commit/main", "change-source-github-url-grammar", "commit id"],
      [`https://github.com/o/r/commit/${SHA}/x`, "change-source-github-url-grammar", "path"],
      ["https://github.com/-o/r/pull/1", "change-source-github-url-grammar", "owner or repository"],
      ["https://github.com/o/../pull/1", "change-source-github-url-grammar", "path"],
      [
        "https://github.com/o/r%2Fx/pull/1",
        "change-source-github-url-grammar",
        "owner or repository",
      ],
      ["https://github.com/o", "change-source-github-url-grammar", "owner or repository"],
      ["https://github.com/o/r", "change-source-github-url-grammar", "path"],
      ["https://github.com/o/r/issues/1", "change-source-github-url-grammar", "path"],
      ["https://github.com/o/r/pull", "change-source-github-url-grammar", "path"],
    ];
    for (const [value, code, detail] of cases) {
      const error = refusal(value);
      expect([error.code, error.detail], value).toEqual([code, detail]);
      expect(error.message.includes(secret), value).toBe(false);
      expect(error.message.includes("/o/r"), value).toBe(false);
    }
  });

  it("claims the two-sided compare forms, which an earlier release refused", () => {
    expect(parseChangeSourceSelector("https://github.com/o/r/compare/main...feature")).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "github-compare",
      host: "github.com",
      owner: "o",
      repository: "r",
      form: "three-dot",
      base: "main",
      head: "feature",
    });
    expect(parseChangeSourceSelector("https://github.com/o/r/compare/main..feature")).toMatchObject(
      { source: "github-compare", form: "two-dot", base: "main", head: "feature" },
    );
  });

  it("leaves GitLab forms to the other arms: the GitHub arm claims none of them", () => {
    // Which kind a GitLab URL becomes is the GitLab arm's contract, not this one's.
    for (const value of [
      "https://gitlab.example.test/g/p/-/merge_requests/1",
      `https://gitlab.com/g/sub/p/commit/${SHA}`,
      `https://gitlab.com/g/p/compare/main...${SHA}`,
      "https://gitlab.example.test/g/p/-/merge_requests/7/diffs",
    ]) {
      expect(githubChangeSourceSelectorArm(value), value).toBeUndefined();
    }
  });

  it("leaves other hosts and scheme-less forge paths to the foreign-form refusal, with no GitHub wording", () => {
    for (const value of [
      `https://gitea.example.test/o/r/commit/${SHA}`,
      "https://github.example.test/o/r/pull/1",
      "https://github.com.evil.test/o/r/pull/1",
      "https://github.com@evil.test/o/r/pull/1",
      "https://api.github.com/repos/o/r/pulls/1",
      "https://github.com./o/r/pull/1",
      "ssh://git@github.com/o/r.git",
      "git@github.com:o/r.git",
      "github.com/o/r/pull/7",
    ]) {
      const error = refusal(value);
      expect(error.code, value).toBe("change-source-kind-unsupported");
      expect(/github/iu.test(error.message), value).toBe(false);
      expect(githubChangeSourceSelectorArm(value), value).toBeUndefined();
    }
  });

  it("leaves local ranges exactly as the range grammar reads them", () => {
    expect(parseChangeSourceSelector("main..HEAD")).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "local-range",
      form: "two-dot",
      base: "main",
      head: "HEAD",
    });
    expect(parseChangeSourceSelector("v1.0...v1.1")).toMatchObject({
      source: "local-range",
      form: "three-dot",
    });
    expect(parseChangeSourceSelector("HEAD")).toMatchObject({
      source: "local-range",
      form: "single-commit",
    });
    for (const value of [
      "main..HEAD",
      "v1.0...v1.1",
      "HEAD",
      SHA,
      "feature/pull-request-ui..main",
    ]) {
      expect(githubChangeSourceSelectorArm(value), value).toBeUndefined();
    }
  });

  it("keeps --pr GitLab-only and byte-identical, and admits --change with a GitHub URL on run", () => {
    const gitlab = "https://gitlab.example.test/g/p/-/merge_requests/7";
    expect(parseChangeRequestSelector(gitlab)).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-request-selector",
      provider: "gitlab",
      host: "gitlab.example.test",
      projectPath: "g/p",
      number: 7,
    });
    const parsed = parseRunArguments([
      "update-documentation",
      "--repo",
      "/tmp/docsfab-github-cli",
      "--instruction",
      "Update the export guide for the change.",
      "--change",
      "https://github.com/octo-org/widget/pull/42/files",
    ]);
    expect(parsed.changeSource).toEqual(pull("octo-org", "widget", 42));
  });
});
