// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  decodeFirstPassContradictionAdmission,
  firstPassContradictionAdmission,
} from "../src/records/first-pass-contradiction-admission.js";

const base = {
  runId: "stopped-run",
  repositoryRevision: "a".repeat(40),
  instruction: "Create docs/a.md from the repository.",
  contradiction: { obligationId: "target-01" },
};

describe("first-pass contradiction replay admission", () => {
  it("admits only an observed repository-only request and binds its stop body", () => {
    const admitted = firstPassContradictionAdmission(base);
    expect(admitted.outcome).toBe("repository-only");
    expect(decodeFirstPassContradictionAdmission(admitted)).toEqual(admitted);
    expect(() =>
      decodeFirstPassContradictionAdmission({
        ...admitted,
        outcome: "external-binding-unsupported",
      }),
    ).toThrow("The first-pass contradiction admission marker is malformed.");
    const { admissionSha256: _digest, ...body } = admitted;
    expect(() =>
      decodeFirstPassContradictionAdmission({
        ...body,
        outcome: "external-binding-unsupported",
        admissionSha256: canonicalDigest({ ...body, outcome: "external-binding-unsupported" }),
      }),
    ).toThrow("The first-pass contradiction admission marker is malformed.");
  });

  it("admits saved non-authoritative live context without weakening external-source admission", () => {
    const context = {
      ...base,
      instructionContext: "Agent-added context beside the original request.",
    };
    expect(firstPassContradictionAdmission(context)).toMatchObject({
      outcome: "repository-only",
      instructionContextSha256: canonicalDigest(context.instructionContext),
    });
    expect(
      firstPassContradictionAdmission({ ...context, sourcePaths: ["src/a.ts"] }),
    ).toMatchObject({
      outcome: "external-binding-unsupported",
      reasons: ["source"],
    });
  });

  it.each([
    { sourcePaths: ["src/a.ts"] },
    { changeRequestSelector: { number: 1 } },
    { changeSource: { selector: "HEAD~1" } },
    { mergedMrSelection: { window: "recent" } },
    { readerTaskContext: { inputOrigin: "explicit" } },
    { readerSources: [{ path: "src/a.ts" }] },
    { comparisonRequest: { kind: "workspace" } },
    { canonSnapshotPath: "snapshot.json" },
    { planPath: "plan.json" },
    { taskLineage: { taskId: "other" } },
    { compositionId: "profile" },
    { resumeFrom: "other-run" },
    { operatorInputResume: { originalRunId: "other" } },
    { draftMr: true },
    { releaseGate: true },
  ])("refuses to replay a stop with non-replayable evidence or authority %#", (route) => {
    expect(firstPassContradictionAdmission({ ...base, ...route }).outcome).toBe(
      "external-binding-unsupported",
    );
  });
});
