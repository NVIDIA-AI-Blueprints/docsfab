// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { OUTPUT_RECORD_CONTRACTS } from "../src/contracts/model-output.js";
import { fillHostMinted } from "../src/harness/answer-records.js";

import {
  deriveEvaluationTarget,
  describeEvaluationTarget,
  fillEvaluationTarget,
  HOST_WRITTEN_EVALUATION_FIELDS,
  TEXT_PATH_HOST_MINTED,
  isExactEvaluationTarget,
  type EvaluationTargetInput,
} from "../src/evaluation-report/evaluation-target.js";

/** The router fixture's 11 public tracked Markdown pages (matrix lane C, 2026-10-01). */
const ROUTER_PAGES = [
  ".skill-router/skills/route-check/SKILL.md",
  "AGENTS.md",
  "PRODUCT_ROUTING_CONTRACT.md",
  "docs/index.md",
  "docs/routing/guide.md",
  "docs/routing/reference.md",
  "fixture-seed/home/.agents/skills/malformed-audit/SKILL.md",
  "fixture-seed/home/.agents/skills/route-check/SKILL.md",
  "fixture-seed/repairs/malformed-audit.SKILL.md",
  "fixture-seed/router-home/collections/fixture-pack/skills/route-check/SKILL.md",
  "src/router_fixture/builtin_skills/route-check/SKILL.md",
];

function unfocused(
  scopePaths: readonly string[],
  extra: Partial<EvaluationTargetInput> = {},
): EvaluationTargetInput {
  return {
    scopePaths,
    focused: false,
    documentPaths: scopePaths,
    failures: [],
    ...extra,
  };
}

const paths = (input: EvaluationTargetInput) =>
  deriveEvaluationTarget(input).map((entry) => entry.path);

describe("host-derived evaluation target", () => {
  it("binds the router fixture's whole set as its coarsest exact cover", () => {
    const input = unfocused(ROUTER_PAGES);
    const entries = deriveEvaluationTarget(input);
    expect(entries).toEqual([
      { path: ".skill-router", directory: true, pageCount: 1 },
      { path: "AGENTS.md", directory: false, pageCount: 1 },
      { path: "PRODUCT_ROUTING_CONTRACT.md", directory: false, pageCount: 1 },
      { path: "docs", directory: true, pageCount: 3 },
      { path: "fixture-seed", directory: true, pageCount: 4 },
      { path: "src", directory: true, pageCount: 1 },
    ]);
    expect(
      isExactEvaluationTarget(
        entries.map((entry) => entry.path),
        input,
      ),
    ).toBe(true);
  });

  it("never binds the repository root, even when every document is in scope", () => {
    const entries = paths(unfocused(["README.md", "docs/a.md", "guide/b.md"]));
    expect(entries).toEqual(["README.md", "docs", "guide"]);
    expect(entries).not.toContain("");
    expect(entries).not.toContain(".");
  });

  it("splits a directory that holds an out-of-scope document", () => {
    const scope = ["docs/guide.md", "docs/routing/a.md", "docs/routing/b.md"];
    const input = unfocused(scope, { documentPaths: [...scope, "docs/private/notes.md"] });
    expect(paths(input)).toEqual(["docs/guide.md", "docs/routing"]);
    // The cover a model might write instead over-claims the out-of-scope page.
    expect(isExactEvaluationTarget(["docs"], input)).toBe(false);
  });

  it("collapses past binary, rst, and text or navigation gaps that hide no document", () => {
    const scope = ["docs/a.md", "docs/b.rst"];
    const input = unfocused(scope, {
      failures: [
        { affects: ["text"], path: "docs/diagram.png" },
        { affects: ["navigation"], path: "docs/b.rst" },
        // A root symlink is a structure failure outside docs.
        { affects: ["metadata", "navigation", "structure", "text"], path: "CLAUDE.md" },
      ],
    });
    expect(paths(input)).toEqual(["docs"]);
  });

  it("lets a pathed structure failure block only its own ancestors", () => {
    const scope = ["docs/a/one.md", "docs/b/two.md"];
    const input = unfocused(scope, {
      failures: [
        { affects: ["metadata", "navigation", "structure", "text"], path: "docs/a/changed.md" },
      ],
    });
    expect(paths(input)).toEqual(["docs/a/one.md", "docs/b"]);
  });

  it("collapses nothing after a pathless structure failure", () => {
    const scope = ["docs/a.md", "docs/b.md"];
    const input = unfocused(scope, { failures: [{ affects: ["structure", "text"] }] });
    expect(paths(input)).toEqual(scope);
  });

  it("binds a focused review's exact pages", () => {
    const scope = ["docs/routing/guide.md", "docs/index.md"];
    expect(deriveEvaluationTarget({ ...unfocused(scope), focused: true })).toEqual([
      { path: "docs/index.md", directory: false, pageCount: 1 },
      { path: "docs/routing/guide.md", directory: false, pageCount: 1 },
    ]);
  });

  it("keeps a large repository's documentation set within the target bound", () => {
    // Shaped like this repository: ~1,400 public pages, a few private/
    // directories, and binary images beside the pages.
    const scope: string[] = [];
    const documents: string[] = [];
    for (let area = 0; area < 40; area += 1) {
      for (let page = 0; page < 35; page += 1) {
        scope.push(`packages/area-${area}/docs/topic-${page % 7}/page-${page}.md`);
      }
      if (area % 10 === 0) documents.push(`packages/area-${area}/private/notes.md`);
    }
    const input = unfocused(scope, {
      documentPaths: [...scope, ...documents],
      failures: [{ affects: ["text"], path: "packages/area-1/docs/diagram.png" }],
    });
    const entries = deriveEvaluationTarget(input);
    expect(scope).toHaveLength(1400);
    expect(entries.length).toBeLessThanOrEqual(256);
    expect(entries.reduce((total, entry) => total + entry.pageCount, 0)).toBe(1400);
    expect(
      isExactEvaluationTarget(
        entries.map((entry) => entry.path),
        input,
      ),
    ).toBe(true);
  });

  it("states page counts for directory entries in the contract sentence", () => {
    const sentence = describeEvaluationTarget(deriveEvaluationTarget(unfocused(ROUTER_PAGES)));
    expect(sentence).toContain(
      'Host-bound evaluation.target.paths for this run (11 in-scope pages): [".skill-router","AGENTS.md","PRODUCT_ROUTING_CONTRACT.md","docs","fixture-seed","src"].',
    );
    expect(sentence).toContain('"docs" = 3 pages');
    expect(sentence).toContain('"src" = 1 page.');
  });
});

describe("host fill of evaluation.target.paths", () => {
  const entries = deriveEvaluationTarget(unfocused(ROUTER_PAGES));
  const candidate = (targetPaths?: unknown) => ({
    evaluation: {
      target: {
        scope_type: "documentation-set",
        ...(targetPaths === undefined ? {} : { paths: targetPaths }),
      },
    },
  });

  it("writes the bound target and reports a narrowed set by counts only", () => {
    // Lane C, both models: the evaluator named only the page steps 1-7 dwelt on.
    const filled = fillEvaluationTarget(
      candidate(["docs/routing/guide.md"]),
      entries,
      ROUTER_PAGES,
    );
    expect((filled.candidate.evaluation.target as { paths: string[] }).paths).toEqual(
      entries.map((entry) => entry.path),
    );
    expect(filled.limitation).toBe(
      "The host bound evaluation.target.paths to this run's review scope; the evaluator's path set covered 1 of 11 in-scope pages and named 0 path(s) outside it.",
    );
  });

  it("never echoes the evaluator's paths into the limitation", () => {
    const filled = fillEvaluationTarget(
      candidate(["MARKER-not-a-page.md", "docs"]),
      entries,
      ROUTER_PAGES,
    );
    expect(filled.limitation).toBe(
      "The host bound evaluation.target.paths to this run's review scope; the evaluator's path set covered 3 of 11 in-scope pages and named 1 path(s) outside it.",
    );
    expect(filled.limitation).not.toContain("MARKER");
  });

  it("adds no limitation for an echo with one trailing slash, an empty list, or an omitted field", () => {
    const echo = entries.map((entry) => (entry.directory ? `${entry.path}/` : entry.path));
    expect(fillEvaluationTarget(candidate(echo), entries, ROUTER_PAGES).limitation).toBeUndefined();
    const empty = fillEvaluationTarget(candidate([]), entries, ROUTER_PAGES);
    expect(empty.limitation).toBeUndefined();
    expect((empty.candidate.evaluation.target as { paths: string[] }).paths).toHaveLength(6);
    const omitted = fillEvaluationTarget(candidate(), entries, ROUTER_PAGES);
    expect(omitted.limitation).toBeUndefined();
    expect((omitted.candidate.evaluation.target as { paths: string[] }).paths).toHaveLength(6);
  });

  it("leaves a non-object target to the staging shape check", () => {
    const shapeless = { evaluation: { target: ["docs"] } };
    expect(fillEvaluationTarget(shapeless, entries, ROUTER_PAGES)).toEqual({
      candidate: shapeless,
    });
  });
});

describe("host-written evaluation fields", () => {
  it("writes the bound target paths over any value the evaluator wrote", () => {
    expect(HOST_WRITTEN_EVALUATION_FIELDS).toContain("target.paths");
    const entries = [{ path: "docs/guide.md", directory: false, pageCount: 1 }];
    const evaluation = { target: { paths: ["evaluator-written.md"] } };
    const filled = fillEvaluationTarget({ evaluation }, entries, ["docs/guide.md"]);
    expect((filled.candidate.evaluation.target as { paths: string[] }).paths).toEqual([
      "docs/guide.md",
    ]);
  });
});

describe("generated host fill (closed-schema-answer-records-decision.md §1.4)", () => {
  it("takes the text path's host-written fields from the step 8 declaration's hostMinted", () => {
    const declared = OUTPUT_RECORD_CONTRACTS["quality-evaluation"].hostMinted;
    expect(TEXT_PATH_HOST_MINTED).toEqual([
      { field: "$.evaluation.target.paths", source: "quality-evaluation-target" },
    ]);
    for (const entry of TEXT_PATH_HOST_MINTED) expect(declared).toContainEqual(entry);
    expect(HOST_WRITTEN_EVALUATION_FIELDS).toEqual(
      declared
        .filter((entry) => entry.field !== "$.evaluation.layers.*.dimensions[].dimension_id")
        .map((entry) => entry.field.replace(/^\$\.evaluation\./u, "")),
    );
  });

  it("writes the bound paths through the same fill the records assembly uses", () => {
    const entries = [{ path: "docs", directory: true, pageCount: 2 }];
    const evaluation = { target: { paths: ["docs/a.md"], delivery_surface_locator: "docs/a.md" } };
    const viaTarget = fillEvaluationTarget({ evaluation }, entries, ["docs/a.md", "docs/b.md"]);
    const viaFill = fillHostMinted(
      { hostMinted: TEXT_PATH_HOST_MINTED },
      { evaluation },
      {
        "quality-evaluation-target": () => ["docs"],
      },
    );
    expect(viaTarget.candidate).toEqual(viaFill.artifact);
    expect(viaFill.written).toEqual(["$.evaluation.target.paths"]);
    // The text path binds no other host-minted member yet (design O9, MR 5).
    expect(viaTarget.candidate.evaluation.target).toMatchObject({
      delivery_surface_locator: "docs/a.md",
    });
    expect(evaluation.target.paths).toEqual(["docs/a.md"]);
  });
});
