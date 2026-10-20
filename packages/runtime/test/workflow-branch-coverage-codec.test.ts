// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalArtifactJson } from "../src/artifacts/canonical.js";
import {
  decodeWorkflowBranchCoverageV1,
  WorkflowBranchCoverageError,
} from "../src/workflow-contracts/branch-coverage.js";
import type {
  WorkflowBranchCoverageV1,
  WorkflowManifestStepV2,
  WorkflowManifestV2,
} from "../src/workflow-contracts/contracts.js";

const revision = "a".repeat(40);
const snapshot = "b".repeat(64);
const contentDigest = "c".repeat(64);

function step(id: string, mode: "read-only" | "write" = "read-only"): WorkflowManifestStepV2 {
  return {
    id,
    title: id,
    kind: mode === "write" ? "inference" : "evaluate",
    skill: id,
    mode,
    prompt: "Perform " + id + ".",
  };
}

function policy(ids: readonly string[]) {
  return {
    schemaVersion: 1 as const,
    steps: ids.map((stepId) => ({
      stepId,
      required: true,
      level: "change-scoped" as const,
      query: "get-neighborhood" as const,
      allowReadOnlyDegraded: true,
    })),
  };
}

function manifest(): WorkflowManifestV2 {
  const planner = step("plan-documentation");
  const author = [step("write-documentation", "write"), step("evaluate-document-quality")];
  const noChange = [step("verify-technical-accuracy"), step("evaluate-document-quality")];
  return {
    schemaVersion: 2,
    name: "update-documentation",
    title: "Update documentation",
    outcome: "Update or verify no change.",
    prefix: { steps: [planner], contextPolicy: policy([planner.id]) },
    selection: { afterStepId: "plan-documentation", kind: "editorial-candidate-v1" },
    branches: [
      { id: "author", steps: author, contextPolicy: policy(author.map(({ id }) => id)) },
      {
        id: "assess-no-change",
        steps: noChange,
        contextPolicy: policy(noChange.map(({ id }) => id)),
      },
    ],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function candidateArtifact(schemaVersion = 3) {
  return {
    kind: "editorial-decision" as const,
    schemaVersion,
    digest: "d".repeat(64),
    repositoryRevision: revision,
    repositoryContentDigest: contentDigest,
  };
}

function sealedCoverage(
  overrides: Partial<
    Omit<WorkflowBranchCoverageV1, "schemaVersion" | "kind" | "coverageSha256">
  > = {},
) {
  const selectedManifest = overrides.manifest ?? manifest();
  const body = {
    workflow: "update-documentation" as const,
    manifest: selectedManifest,
    manifestSha256: sha256(canonicalArtifactJson(selectedManifest)),
    repositoryRevision: revision,
    workspaceSnapshotSha256: snapshot,
    selection: {
      branchId: "assess-no-change" as const,
      candidateArtifact: candidateArtifact(3),
    },
    requiredStepIds: [
      "plan-documentation",
      "verify-technical-accuracy",
      "evaluate-document-quality",
    ],
    excludedStepIds: ["write-documentation"],
    ...overrides,
  };
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-workflow-branch-coverage" as const,
    ...body,
  };
  return { ...envelope, coverageSha256: sha256(canonicalArtifactJson(envelope)) };
}

function options() {
  return {
    decodeManifest: vi.fn((value: unknown) => value as WorkflowManifestV2),
    validateCoverage: vi.fn(),
  };
}

describe("workflow branch coverage codec", () => {
  it("decodes a sealed selected path only after both mandatory semantic callbacks", () => {
    const callbacks = options();
    const input = sealedCoverage();
    const decoded = decodeWorkflowBranchCoverageV1(input, callbacks);

    expect(decoded).toEqual(input);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(callbacks.decodeManifest).toHaveBeenCalledOnce();
    expect(callbacks.validateCoverage).toHaveBeenCalledWith(decoded);
  });

  it("rejects missing or failing semantic validation instead of accepting structure alone", () => {
    expect(() => decodeWorkflowBranchCoverageV1(sealedCoverage(), {} as never)).toThrowError(
      expect.objectContaining({ code: "coverage-unverified" }),
    );
    expect(() =>
      decodeWorkflowBranchCoverageV1(sealedCoverage(), {
        ...options(),
        validateCoverage() {
          throw new Error("path mismatch");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "coverage-unverified" }));
    expect(() =>
      decodeWorkflowBranchCoverageV1(sealedCoverage(), {
        ...options(),
        validateCoverage() {
          throw new WorkflowBranchCoverageError("manifest-mismatch");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "manifest-mismatch" }));
  });

  it("binds the decoded manifest bytes to their exact digest", () => {
    expect(() =>
      decodeWorkflowBranchCoverageV1(sealedCoverage(), {
        ...options(),
        decodeManifest() {
          throw new Error("unsupported manifest");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "manifest-mismatch" }));
    expect(() =>
      decodeWorkflowBranchCoverageV1(sealedCoverage({ manifestSha256: "e".repeat(64) }), options()),
    ).toThrowError(expect.objectContaining({ code: "manifest-mismatch" }));
  });

  it("accepts no selection and rejects malformed branch artifact selections", () => {
    expect(
      decodeWorkflowBranchCoverageV1(sealedCoverage({ selection: null }), options()).selection,
    ).toBeNull();
    expect(() =>
      decodeWorkflowBranchCoverageV1(
        sealedCoverage({
          selection: {
            branchId: "author",
            candidateArtifact: candidateArtifact(1) as never,
          },
        }),
        options(),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-type" }));
    expect(() =>
      decodeWorkflowBranchCoverageV1(
        sealedCoverage({
          selection: {
            branchId: "different-branch",
            candidateArtifact: candidateArtifact(3),
          } as never,
        }),
        options(),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
  });

  it("requires ordered unique and disjoint selected and excluded step identities", () => {
    for (const overrides of [
      { requiredStepIds: [] },
      { requiredStepIds: ["plan-documentation", "plan-documentation"] },
      {
        requiredStepIds: ["plan-documentation", "evaluate-document-quality"],
        excludedStepIds: ["evaluate-document-quality"],
      },
      { requiredStepIds: Array.from({ length: 17 }, (_, index) => "step-" + index) },
    ]) {
      expect(() =>
        decodeWorkflowBranchCoverageV1(sealedCoverage(overrides), options()),
      ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
    }
  });

  it("rejects wrong workflow, changed seals, and oversized retained manifests", () => {
    expect(() =>
      decodeWorkflowBranchCoverageV1(
        sealedCoverage({ workflow: "create-documentation" as never }),
        options(),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));

    const changed = sealedCoverage();
    changed.repositoryRevision = "f".repeat(40);
    expect(() => decodeWorkflowBranchCoverageV1(changed, options())).toThrowError(
      expect.objectContaining({ code: "digest-mismatch" }),
    );

    const largeManifest = manifest();
    largeManifest.outcome = "x".repeat(70 * 1024);
    expect(() =>
      decodeWorkflowBranchCoverageV1(sealedCoverage({ manifest: largeManifest }), options()),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
  });
});
