// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isCliRunRetryContextV1 } from "../src/records/retry-context.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import type { RunRecord } from "../src/records/contracts.js";
import { admitReviewRescope } from "../src/operator/recovery-scope.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";

function minimalContext() {
  return {
    schemaVersion: 1,
    reconstructable: true,
    instructionPresent: false,
    deliveryMode: "read-only",
    allowWrite: false,
    writeGrantExplicit: false,
    releaseGate: false,
  };
}

describe("CLI retry context record contract", () => {
  it("accepts minimal retained context when no instruction was supplied", () => {
    expect(isCliRunRetryContextV1(minimalContext())).toBe(true);
  });

  it("accepts ordinary CLI selections with a symbolic comparison base", () => {
    expect(
      isCliRunRetryContextV1({
        ...minimalContext(),
        instructionPresent: true,
        deliveryMode: "patch-only",
        allowWrite: true,
        writeGrantExplicit: false,
        compositionId: "nvidia-inference-gpt-6-sol-pi",
        contextTarget: {
          sourcePath: "docs/guide.md",
          anchor: "Overview",
          candidateParentPath: "docs/index.md",
        },
        comparisonRequest: { kind: "base-head", baseRevision: "main", headRevision: "HEAD" },
        readerSources: [{ role: "public-contract", path: "src/public.ts" }],
        sourcePaths: ["src/public.ts"],
      }),
    ).toBe(true);
  });

  it.each([
    ["missing schema version", { schemaVersion: undefined }],
    ["unknown field", { injected: "--draft-mr" }],
    ["unknown delivery mode", { deliveryMode: "publish" }],
    ["missing authority state", { writeGrantExplicit: undefined }],
    ["patch mode without write admission", { deliveryMode: "patch-only", allowWrite: false }],
    ["invalid target shape", { contextTarget: { sourcePath: "docs/a.md", extra: true } }],
    ["invalid source binding", { readerSources: [{ role: "public-contract", path: 1 }] }],
    ["unsupported source role", { readerSources: [{ role: "internal-task", path: "src/a.ts" }] }],
    ["invalid comparison arm", { comparisonRequest: { kind: "base-head", baseRevision: "main" } }],
  ])("refuses %s", (_name, override) => {
    expect(isCliRunRetryContextV1({ ...minimalContext(), ...override })).toBe(false);
  });

  it("keeps effective write admission separate from explicit --allow-write", () => {
    expect(
      isCliRunRetryContextV1({
        ...minimalContext(),
        deliveryMode: "patch-only",
        allowWrite: true,
        writeGrantExplicit: false,
      }),
    ).toBe(true);
    expect(
      isCliRunRetryContextV1({
        ...minimalContext(),
        deliveryMode: "patch-only",
        allowWrite: true,
        writeGrantExplicit: true,
      }),
    ).toBe(true);
  });

  it("accepts review comment delivery without repository write authority", () => {
    expect(
      isCliRunRetryContextV1({
        ...minimalContext(),
        deliveryMode: "comment-mr",
        commentMr: "17",
      }),
    ).toBe(true);
  });
});

describe("explicit review rescope", () => {
  const scope = {
    scope: "focused-set" as const,
    reason: "operator-named" as const,
    targetPaths: ["docs/a.md", "docs/b.md"],
    deferredPaths: [],
    corpusFileCount: 2,
  };
  const source = {
    id: "source-run",
    workflow: "review-documentation",
    status: "failed",
    instruction: "Review these pages using docs/reference.md as evidence.",
    repository: { sourcePath: "/fixture/repo", revision: "a".repeat(40) },
    reviewScope: { ...scope, scopeSha256: canonicalDigest(scope) },
  } as unknown as RunRecord;

  it("admits only an operator-selected subset at the recorded revision", () => {
    expect(
      admitReviewRescope({
        source,
        repositoryPath: "/fixture/repo",
        revision: source.repository.revision,
        instruction: source.instruction,
        targetPaths: ["docs/a.md"],
      }),
    ).toEqual({ targetPaths: ["docs/a.md"], remainingPaths: ["docs/b.md"] });
  });

  it("refuses model-advised expansion, revision drift, and changed batch intent", () => {
    const base = {
      source,
      repositoryPath: "/fixture/repo",
      revision: source.repository.revision,
      instruction: source.instruction,
      targetPaths: ["docs/a.md"],
    };
    expect(() => admitReviewRescope({ ...base, targetPaths: ["docs/reference.md"] })).toThrow();
    expect(() => admitReviewRescope({ ...base, revision: "b".repeat(40) })).toThrow();
    expect(() => admitReviewRescope({ ...base, instruction: "Review a different task" })).toThrow();
    expect(() =>
      admitReviewRescope({
        ...base,
        source: { ...source, changeSources: [{}] } as unknown as RunRecord,
      }),
    ).toThrow(/external change evidence/u);
  });

  it("narrows a whole-set review against the inventory at its pinned revision", () => {
    const wholeSet = { ...source, reviewScope: undefined } as RunRecord;
    const base = {
      source: wholeSet,
      repositoryPath: "/fixture/repo",
      revision: wholeSet.repository.revision,
      instruction: wholeSet.instruction,
      wholeSetPaths: ["docs/a.md", "docs/b.md", "docs/c.md"],
    };
    expect(admitReviewRescope({ ...base, targetPaths: ["docs/a.md"] })).toEqual({
      targetPaths: ["docs/a.md"],
      remainingPaths: ["docs/b.md", "docs/c.md"],
    });
    expect(() => admitReviewRescope({ ...base, targetPaths: ["docs/new.md"] })).toThrow();
  });
});

it("does not offer a resume command from a stopped run's prose without a retained receipt", () => {
  const action = buildRunHumanNextCommand({
    record: {
      ...({} as RunRecord),
      id: "stopped-review",
      workflow: "review-documentation",
      status: "needs-input",
      error: "needs-authorization",
      steps: [],
    },
  });
  expect(action?.command ?? "").not.toContain("--resume-from");
  expect(action?.recoveryAction).not.toBe("resume");
});
