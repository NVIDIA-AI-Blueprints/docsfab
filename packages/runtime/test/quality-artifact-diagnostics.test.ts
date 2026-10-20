// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { DurableArtifactStore } from "../src/artifacts/index.js";
import type { SelectedDocumentationQualityProfile } from "../src/evaluation-report/quality-profile-selection.js";
import type { EvaluationTargetEntryV1 } from "../src/evaluation-report/evaluation-target.js";
import { QUALITY_ARTIFACT_FAILURES } from "../src/evaluation-report/quality-validator-host.js";
import {
  decodeQualityValidationBinding,
  loadStagedQualityArtifact,
  sealQualityValidationBinding,
  stageQualityArtifactCandidate,
} from "../src/evaluation-report/quality-artifact-staging.js";

const bindings = {
  runId: "scope-diagnostic-run",
  repositoryRevision: "a".repeat(40),
  selectionSha256: "b".repeat(64),
  evaluatorIdentitySha256: "c".repeat(64),
  qualityPackBindingSha256: "d".repeat(64),
};

const page = (path: string): EvaluationTargetEntryV1 => ({ path, directory: false, pageCount: 1 });
/** The whole-set target the host binds for the two in-scope pages. */
const DOCS_COVER: EvaluationTargetEntryV1[] = [{ path: "docs", directory: true, pageCount: 2 }];

function input(paths: string[], profileId = "docsfab-documentation-quality") {
  const records = new Map<string, unknown>();
  const putRecord = vi.fn(async (key: string, value: unknown) => {
    records.set(key, value);
  });
  return {
    records,
    putRecord,
    request: {
      store: {
        putRecord,
        getRecord: async (key: string) => records.get(key),
      } as unknown as DurableArtifactStore,
      bindings,
      selection: {
        receipt: {
          ...bindings,
          profileId: "docsfab-documentation-quality",
          profileVersion: "v0.1",
          profileModel: "documentation-quality-model-v0.2",
        },
        documentationPaths: ["docs/requested.md", "docs/second.md"],
        evaluationTarget: DOCS_COVER,
      } as unknown as SelectedDocumentationQualityProfile & {
        evaluationTarget: EvaluationTargetEntryV1[];
      },
      candidate: {
        selectionSha256: bindings.selectionSha256,
        evaluation: {
          profile: { id: profileId, version: "v0.1" },
          model_version: "documentation-quality-model-v0.2",
          target: {
            scope_type: "documentation-set",
            repository_revision: bindings.repositoryRevision,
            paths,
          },
        },
        qualityScore: null,
        reportMarkdown: "# Retained candidate report",
      },
    },
  };
}

describe("quality artifact failure diagnostics", () => {
  it.each([
    ["docs/requested.md"],
    ["docs/requested.md", "docs/second.md", "outside.md"],
    // A different cover of the same pages, or a slash alias: the host-bound set is exactly ["docs"].
    ["docs/requested.md", "docs/second.md"],
    ["docs/"],
  ])(
    "distinguishes target coverage disagreement without persisting artifacts: %j",
    async (...paths) => {
      const fixture = input(paths);
      await expect(stageQualityArtifactCandidate(fixture.request)).rejects.toMatchObject({
        code: "target-scope-mismatch",
      });
      expect(fixture.putRecord).not.toHaveBeenCalled();
    },
  );

  it.each(["docs/", "docs/requested.md/"])(
    "rejects focused folder and trailing-slash aliases: %s",
    async (path) => {
      const fixture = input([path]);
      fixture.request.selection.documentationPaths = ["docs/requested.md"];
      fixture.request.selection.evaluationTarget = [page("docs/requested.md")];
      fixture.request.selection.focused = true;
      await expect(stageQualityArtifactCandidate(fixture.request)).rejects.toMatchObject({
        code: "target-scope-mismatch",
      });
      expect(fixture.putRecord).not.toHaveBeenCalled();
    },
  );

  it("refuses a directory that covers a page-bound target", async () => {
    // The coverage rule this replaced accepted it: "docs" covers both bound pages.
    const fixture = input(["docs"]);
    fixture.request.selection.evaluationTarget = [
      page("docs/requested.md"),
      page("docs/second.md"),
    ];
    await expect(stageQualityArtifactCandidate(fixture.request)).rejects.toMatchObject({
      code: "target-scope-mismatch",
      reason: "candidate-target-outside-scope",
    });
    expect(fixture.putRecord).not.toHaveBeenCalled();
  });

  it("tells the operator a target mismatch is a host defect, not a scope choice", () => {
    // The host writes evaluation.target.paths, so only a DocsFab defect can mismatch it.
    expect(QUALITY_ARTIFACT_FAILURES["target-scope-mismatch"]).toBe(
      "Quality validation failed because the staged evaluation target differs from the target the host bound and wrote for this run, which is a DocsFab defect. Report it with the retained run; this result is not validated.",
    );
  });

  it("refuses a selection without a bound target as a host binding fault", async () => {
    const fixture = input(["docs"]);
    delete (fixture.request.selection as { evaluationTarget?: unknown }).evaluationTarget;
    await expect(stageQualityArtifactCandidate(fixture.request)).rejects.toMatchObject({
      code: "candidate-invalid",
      reason: "candidate-host-binding-mismatch",
    });
    expect(fixture.putRecord).not.toHaveBeenCalled();
  });

  it("accepts the host-bound whole-set cover and the exact focused page set", async () => {
    const wholeSet = input(["docs"]);
    await expect(stageQualityArtifactCandidate(wholeSet.request)).resolves.toMatchObject({
      evaluation: { record: { artifactKind: "evaluation" } },
    });
    const focused = input(["docs/second.md", "docs/requested.md"]);
    focused.request.selection.evaluationTarget = [
      page("docs/requested.md"),
      page("docs/second.md"),
    ];
    focused.request.selection.focused = true;
    await expect(stageQualityArtifactCandidate(focused.request)).resolves.toMatchObject({
      evaluation: { record: { artifactKind: "evaluation" } },
    });
  });

  it("keeps malformed candidate metadata distinct from a scope mismatch", async () => {
    const fixture = input(["docs/requested.md"], "different-profile");
    await expect(stageQualityArtifactCandidate(fixture.request)).rejects.toMatchObject({
      code: "candidate-invalid",
    });
    expect(fixture.putRecord).not.toHaveBeenCalled();
  });

  it("retains the scope diagnostic in a sealed validation binding", () => {
    const binding = sealQualityValidationBinding({
      ...bindings,
      status: "failed",
      failureCode: "target-scope-mismatch",
      artifacts: { evaluation: null, qualityScore: null, candidateReport: null, finalReport: null },
      validators: { evaluation: null, qualityScore: null, reportBinding: null },
      validatorAssets: {
        evaluationScriptSha256: "e".repeat(64),
        evaluationSchemaSha256: "f".repeat(64),
        qualityScoreScriptSha256: "1".repeat(64),
        reportScriptSha256: "2".repeat(64),
      },
    });
    expect(decodeQualityValidationBinding(binding)).toEqual(binding);
    expect(() => decodeQualityValidationBinding({ ...binding, schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "migration-required" }),
    );
    expect(() =>
      decodeQualityValidationBinding({ ...binding, failureCode: "candidate-invalid" }),
    ).toThrow();
  });

  it("preserves migration-required through staged artifact load and store round-trip", async () => {
    const fixture = input(["docs"]);
    const staged = await stageQualityArtifactCandidate(fixture.request);
    fixture.records.set(staged.evaluation.binding.recordSha256, {
      ...staged.evaluation.record,
      schemaVersion: 2,
    });
    await expect(
      loadStagedQualityArtifact(fixture.request.store, staged.evaluation.binding.recordSha256),
    ).rejects.toMatchObject({ code: "migration-required" });

    const corruptingStore = {
      async putRecord(key: string, value: unknown) {
        fixture.records.set(key, { ...(value as object), schemaVersion: 2 });
      },
      async getRecord(key: string) {
        return fixture.records.get(key);
      },
    } as DurableArtifactStore;
    await expect(
      stageQualityArtifactCandidate({ ...fixture.request, store: corruptingStore }),
    ).rejects.toMatchObject({ code: "migration-required" });
  });
});
