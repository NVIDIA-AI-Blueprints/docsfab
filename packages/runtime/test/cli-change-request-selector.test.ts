// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseRunArguments, SOURCE_AWARE_WORKFLOWS } from "../src/cli/run-arguments.js";
import { canonicalGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import {
  CHANGE_REQUEST_SELECTOR_REFUSAL_CODES,
  ChangeRequestSelectorError,
  changeRequestSelectorRefusalMessage,
  changeRequestSelectorUsesCheckout,
  parseChangeRequestSelector,
  type ChangeRequestSelectorRefusalCode,
} from "../src/inputs/change-request-selector.js";

const REPO = "/tmp/docsfab-798c2-selector-repo";
const INSTRUCTION = "Update the export guide for the merged change.";
const MR_URL = "https://gitlab.example.com/tech-docs/agents/docsfab/-/merge_requests/813";

function update(...extra: readonly string[]): readonly string[] {
  return ["update-documentation", "--repo", REPO, "--instruction", INSTRUCTION, ...extra];
}

function refusalOf(value: unknown): ChangeRequestSelectorRefusalCode {
  try {
    parseChangeRequestSelector(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ChangeRequestSelectorError);
    return (error as ChangeRequestSelectorError).code;
  }
  throw new Error(`Expected a refusal for ${JSON.stringify(value)}.`);
}

/**
 * The selector's value grammar, asserted on the parsed reference rather than a
 * boolean. The forms diverge in host, project and number so no assertion passes
 * by coincidence.
 */
describe("docsfab run --pr selector grammar (#798)", () => {
  it("parses a merge-request URL into host, project and number", () => {
    const parsed = parseChangeRequestSelector(MR_URL);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-change-request-selector",
      provider: "gitlab",
      host: "gitlab.example.com",
      projectPath: "tech-docs/agents/docsfab",
      number: 813,
    });
    expect(changeRequestSelectorUsesCheckout(parsed)).toBe(false);
    // The older link shape without the `/-/` separator names the same thing.
    expect(
      parseChangeRequestSelector("https://gitlab.example.test/team/project/merge_requests/42"),
    ).toMatchObject({ host: "gitlab.example.test", projectPath: "team/project", number: 42 });
  });

  it("parses the host, group, project and number reference form", () => {
    const parsed = parseChangeRequestSelector("gitlab.example.test/team/sub/project!57");
    expect(parsed).toMatchObject({
      host: "gitlab.example.test",
      projectPath: "team/sub/project",
      number: 57,
    });
    expect(changeRequestSelectorUsesCheckout(parsed)).toBe(false);
  });

  it("parses a bare number as this checkout's project and resolves nothing itself", () => {
    for (const text of ["!804", "804"]) {
      const parsed = parseChangeRequestSelector(text);
      expect(parsed.number).toBe(804);
      // Null, not a guessed default: the caller resolves it from the checkout.
      expect(parsed.host).toBeNull();
      expect(parsed.projectPath).toBeNull();
      expect(changeRequestSelectorUsesCheckout(parsed)).toBe(true);
    }
  });

  it("refuses every malformed selector with its own code", () => {
    expect(refusalOf("")).toBe("empty-selector");
    expect(refusalOf("   ")).toBe("empty-selector");
    expect(refusalOf(`https://h/g/p/-/merge_requests/${"1".repeat(600)}`)).toBe(
      "selector-too-long",
    );
    expect(refusalOf("https://github.com/owner/repo/pull/7")).toBe("unsupported-provider");
    expect(refusalOf("not-a-selector")).toBe("malformed-selector");
    expect(refusalOf("/etc/passwd")).toBe("malformed-selector");
    expect(refusalOf("file:///tmp/evidence")).toBe("malformed-selector");
    expect(refusalOf(42)).toBe("malformed-selector");
    // Plain HTTP is refused: a read over a rewritable channel is not a basis.
    expect(refusalOf("http://gitlab.example.test/team/project/-/merge_requests/1")).toBe(
      "malformed-selector",
    );
    expect(refusalOf("https://user:token@gitlab.example.test/t/p/-/merge_requests/1")).toBe(
      "invalid-host",
    );
    expect(refusalOf("gitlab.example.test/team/project!0")).toBe("invalid-change-number");
    expect(refusalOf("gitlab.example.test/project!5")).toBe("invalid-project-path");
    expect(refusalOf("gitlab.example.test/team/../etc!5")).toBe("invalid-project-path");
    expect(parseChangeRequestSelector("gitlab.example.test/team/project!5").number).toBe(5);
  });

  it("keeps a cross-host selector on the host the operator typed", () => {
    // A selector that carries its own host ignores the checkout; folding in the
    // local remote would key the locator on another project.
    const a = parseChangeRequestSelector("https://forge-a.example/team/project/-/merge_requests/9");
    const b = parseChangeRequestSelector("forge-b.example/team/project!9");
    expect(a.host).toBe("forge-a.example");
    expect(b.host).toBe("forge-b.example");
    expect(a.number).toBe(b.number);
    expect(a.host).not.toBe(b.host);
  });

  it("reads one merge request the same way however its host is capitalized", () => {
    // On the locator, because citations and observation ids are minted from it.
    const spellings = [
      "https://GitLab.Example.Test/team/project/-/merge_requests/813",
      "GitLab.Example.Test/team/project!813",
      "gitlab.example.test/team/project!813",
      "GITLAB.EXAMPLE.TEST/team/project!813",
    ].map((text) => parseChangeRequestSelector(text));
    for (const parsed of spellings) {
      expect(parsed.host).toBe("gitlab.example.test");
      expect(
        canonicalGitlabMrReviewLocator({
          host: parsed.host!,
          projectId: 7,
          mergeRequestIid: parsed.number,
        }),
      ).toBe("gitlab-mr:v1:host=gitlab.example.test:project=7:mr=813");
    }
    expect(new Set(spellings.map((parsed) => JSON.stringify(parsed))).size).toBe(1);
    // Control: the normalization is case folding, not host flattening.
    expect(parseChangeRequestSelector("gitlab.other.test/team/project!813").host).toBe(
      "gitlab.other.test",
    );
  });

  it("refuses a project path that forgot its forge host instead of reading its first segment as one", () => {
    // GitLab's breadcrumb form. Read as a host, it would fail much later with a
    // network or authentication message.
    expect(refusalOf("tech-docs/agents/docsfab!813")).toBe("ambiguous-reference");
    expect(refusalOf("group/sub/project!1")).toBe("ambiguous-reference");
    const message = changeRequestSelectorRefusalMessage("ambiguous-reference");
    // The message names both accepted forms and the bare-number escape.
    expect(message).toContain("host/group/project!number");
    expect(message).toContain("URL");
    expect(message).toContain("number alone");
    // Positive controls: a dotted or localhost first segment is a host.
    expect(
      parseChangeRequestSelector("gitlab.example.test/tech-docs/agents/docsfab!813"),
    ).toMatchObject({ host: "gitlab.example.test", projectPath: "tech-docs/agents/docsfab" });
    expect(parseChangeRequestSelector("localhost/team/project!1").host).toBe("localhost");
  });

  /**
   * Every selector refusal names a remediation, walked from the shipped
   * enumeration so a new code cannot ship condition-only.
   */
  it.each([...CHANGE_REQUEST_SELECTOR_REFUSAL_CODES])(
    "names a condition and the change that clears it on the %s selector refusal",
    (code) => {
      const message = changeRequestSelectorRefusalMessage(code);
      expect(message).not.toContain(code);
      const sentences = message.split(". ").filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.at(-1)).toMatch(/^(?:Pass|Use|Copy|Write|Name|Run|Correct|Replace)\b/u);
      expect(message.endsWith(".")).toBe(true);
      expect(new ChangeRequestSelectorError(code).message).toBe(message);
    },
  );

  it("retains nothing of the operator's text beyond the validated reference", () => {
    // The parsed reference lands in the admitted request, which is digested and
    // may be logged, so a query parameter (possibly a pasted token) must not
    // survive parsing.
    const withQuery = parseChangeRequestSelector(
      "https://gitlab.example.test/team/project/-/merge_requests/1?ref=SENSITIVE-MARKER",
    );
    expect(JSON.stringify(withQuery)).not.toContain("SENSITIVE-MARKER");
    expect(Object.keys(withQuery).sort()).toEqual([
      "host",
      "kind",
      "number",
      "projectPath",
      "provider",
      "schemaVersion",
    ]);
    // The query is dropped, not merely hidden.
    expect(withQuery).toEqual(
      parseChangeRequestSelector("https://gitlab.example.test/team/project/-/merge_requests/1"),
    );
    // Both spellings agree on mixed case: keeping the host's case verbatim would
    // split one merge request into two locators.
    expect(parseChangeRequestSelector("GitLab.Example.Test/team/project!1")).toEqual(
      parseChangeRequestSelector("https://gitlab.example.test/team/project/-/merge_requests/1"),
    );
    expect(
      parseChangeRequestSelector("https://GitLab.Example.Test/team/project/-/merge_requests/1"),
    ).toEqual(parseChangeRequestSelector("gitlab.example.test/team/project!1"));
    // No refusal message quotes back what it refused.
    for (const code of CHANGE_REQUEST_SELECTOR_REFUSAL_CODES) {
      expect(changeRequestSelectorRefusalMessage(code)).not.toContain("SENSITIVE-MARKER");
    }
  });
});

/**
 * Argument admission for the selector, asserted on the admitted object that a
 * later digest covers.
 */
describe("docsfab run --pr argument admission (#798)", () => {
  it("admits one selector on every source-aware workflow and records it parsed", () => {
    for (const workflow of SOURCE_AWARE_WORKFLOWS) {
      const parsed = parseRunArguments([
        workflow,
        "--repo",
        REPO,
        "--instruction",
        INSTRUCTION,
        "--pr",
        MR_URL,
      ]);
      expect(parsed.changeRequestSelector).toMatchObject({
        host: "gitlab.example.com",
        projectPath: "tech-docs/agents/docsfab",
        number: 813,
      });
    }
  });

  it("admits --pr beside --source so both kinds of evidence can bind", () => {
    const parsed = parseRunArguments([
      ...update("--pr", "!813", "--source", "docs/guide.html", "--source", "docs/api.html"),
    ]);
    expect(parsed.changeRequestSelector?.number).toBe(813);
    expect(parsed.sourcePaths).toEqual(["docs/guide.html", "docs/api.html"]);
  });

  it("refuses a second selector, an unsupported workflow, and a resumed run", () => {
    expect(() => parseRunArguments([...update("--pr", "!1", "--pr", "!2")])).toThrow(
      /at most once in total/u,
    );
    expect(() => parseRunArguments(["review-documentation", "--repo", REPO, "--pr", "!1"])).toThrow(
      /--pr or --mr is supported only for the/u,
    );
    expect(() =>
      parseRunArguments([
        "update-documentation",
        "--repo",
        REPO,
        "--resume-from",
        "run-1",
        "--canon-snapshot",
        "{}",
        "--pr",
        "!1",
      ]),
    ).toThrow(/--pr or --mr cannot be combined with --resume-from/u);
  });

  it("refuses a date-scoped instruction beside an explicit selector", () => {
    // Admitting both a date window and --pr would give one binding two bases.
    const dated = [
      "update-documentation",
      "--repo",
      REPO,
      "--instruction",
      "Update docs for merge requests merged into main on 2026-09-15 in America/Los_Angeles.",
    ];
    expect(parseRunArguments([...dated]).mergedMrSelection).toBeDefined();
    expect(() => parseRunArguments([...dated, "--pr", "!813"])).toThrow(/cannot also take --pr/u);
  });

  it("keeps a no-selector run's admitted request free of the selector key", () => {
    // Key absence, not an undefined value: an undefined-valued key changes the digest.
    const parsed = parseRunArguments([...update()]);
    expect("changeRequestSelector" in parsed).toBe(false);
    expect(
      JSON.stringify(JSON.parse(JSON.stringify(parsed))).includes("changeRequestSelector"),
    ).toBe(false);
  });
});

/**
 * Selector-present digests, pinned so an admitted shape cannot move silently.
 * `cli-source-compatibility.test.ts` pins the no-selector digests.
 */
describe("docsfab run --pr admitted request digests (#798)", () => {
  const digest = (argv: readonly string[]): string =>
    createHash("sha256")
      .update(JSON.stringify(sortDeep(JSON.parse(JSON.stringify(parseRunArguments([...argv]))))))
      .digest("hex");

  it("admits two spellings of one merge request as one request and keeps every identity sensitive", () => {
    const url = digest(update("--pr", MR_URL));
    const path = digest(update("--pr", "gitlab.example.com/tech-docs/agents/docsfab!813"));
    const bare = digest(update("--pr", "!813"));
    // Two spellings of one merge request are the same admitted request.
    expect(url).toBe(path);
    // The bare form leaves host and project for the checkout to resolve.
    expect(bare).not.toBe(url);
    // Sensitivity: every identifying part of the selector moves the digest.
    expect(digest(update("--pr", "!814"))).not.toBe(bare);
    expect(digest(update("--pr", "gitlab.example.com/tech-docs/agents/other!813"))).not.toBe(path);
    expect(digest(update("--pr", "elsewhere.example/tech-docs/agents/docsfab!813"))).not.toBe(path);
    expect(digest(update("--pr", MR_URL))).not.toBe(digest(update()));
  });

  it("leaves a run with tracked sources unchanged when no selector is present", () => {
    // On an argv that exercises the source path, `--pr` is inert when unused.
    const withSources = update("--source", "docs/guide.html");
    const before = digest(withSources);
    expect(digest([...withSources, "--pr", "!813"])).not.toBe(before);
    expect(digest(withSources)).toBe(before);
  });
});

/** Key-sorted, so a field's position in the admitted object cannot move a digest. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
