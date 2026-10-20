// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { executeWorkflowApplication } from "../src/application/execute-workflow.js";
import {
  assertArtifactCurrent,
  assertChildScopeDoesNotWiden,
  assertSessionIsNotGrant,
  assertTaskScopeActive,
  assertWritePathAllowed,
  classifyTaskWritePath,
  createTaskScope,
  narrowTaskScope,
  projectTaskScope,
  TaskScopeError,
  type TaskGrantVerifier,
  type TaskScope,
} from "../src/execution/task-scope.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import {
  createInteractiveOperation,
  decodeInteractiveOperation,
  interactiveOperationFabricatesWorkflowRunRecord,
  persistInteractiveOperation,
  projectInteractiveOperation,
  referenceChildWorkflowResult,
  InteractiveOperationError,
} from "../src/records/interactive-operation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REVISION = "c".repeat(40);

function liveGrant(fingerprintSha256: string): TaskGrantVerifier & { revoke(): void } {
  let current = true;
  return {
    fingerprintSha256,
    verifyCurrent: () => current,
    revoke() {
      current = false;
    },
  };
}

function scope(overrides: Partial<Parameters<typeof createTaskScope>[0]> = {}): TaskScope {
  return createTaskScope({
    taskId: "task-1",
    repositoryIdentitySha256: HASH_A,
    repositoryRevision: REVISION,
    repositoryContentDigest: HASH_B,
    observationMode: "selected-checkout",
    writeClass: "documentation",
    grant: liveGrant(HASH_A),
    writeBoundary: new DocumentationScope(),
    ...overrides,
  });
}

describe("interactive task scope", () => {
  it("binds host-issued identity and refuses lookalike objects", () => {
    const created = scope();
    const projected = projectTaskScope(created);
    expect(projected.availability).toBe("available");
    expect(projected.snapshot.taskId).toBe("task-1");
    expect(projected.snapshot.kind).toBe("docsfab-task-scope");
    expect(() => assertTaskScopeActive({ kind: "docsfab-task-scope" })).toThrowError(
      TaskScopeError,
    );
  });

  it("treats session lifetime as distinct from grant lifetime", () => {
    const grant = liveGrant(HASH_A);
    const created = scope({ grant, sessionId: "session-1" });
    assertSessionIsNotGrant(created, "session-1");
    grant.revoke();
    expect(() => assertSessionIsNotGrant(created, "session-1")).toThrowError(
      expect.objectContaining({ code: "session-is-not-grant" }),
    );
    expect(() => assertTaskScopeActive(created)).toThrowError(
      expect.objectContaining({ code: "grant-revoked" }),
    );
  });

  it("denies source and CI writes while allowing documentation", () => {
    const created = scope();
    expect(classifyTaskWritePath("docs/guide.md")).toBe("documentation");
    expect(classifyTaskWritePath("src/app.js")).toBe("source");
    expect(classifyTaskWritePath(".gitlab-ci.yml")).toBe("ci");
    assertWritePathAllowed(created, "docs/guide.md");
    expect(() => assertWritePathAllowed(created, "src/app.js")).toThrowError(
      expect.objectContaining({ code: "source-write-denied" }),
    );
    expect(() => assertWritePathAllowed(created, ".github/workflows/ci.yml")).toThrowError(
      expect.objectContaining({ code: "ci-write-denied" }),
    );
    const readOnly = narrowTaskScope(created, { writeClass: "none" });
    expect(() => assertWritePathAllowed(readOnly, "docs/guide.md")).toThrowError(
      expect.objectContaining({ code: "source-write-denied" }),
    );
  });

  it("classifies hostile and package source paths before an allow-all boundary", () => {
    expect(classifyTaskWritePath("packages/runtime/src/index.ts")).toBe("source");
    expect(classifyTaskWritePath("packages/runtime/app/main.ts")).toBe("source");
    expect(classifyTaskWritePath("docs//guide.md")).toBe("other");
    expect(classifyTaskWritePath("docs/./guide.md")).toBe("other");
    expect(classifyTaskWritePath("docs/guide\u0000.md")).toBe("other");
    expect(classifyTaskWritePath("packages/runtime/.gitlab/workflows/ci.yml")).toBe("ci");
    expect(classifyTaskWritePath("packages/runtime/.gitlab-ci.yml")).toBe("ci");
    expect(classifyTaskWritePath("docs/.gitlab-ci.yml")).toBe("ci");
    expect(classifyTaskWritePath("packages/runtime/package-lock.json")).toBe("source");
    let boundaryCalls = 0;
    const allowAll = scope({
      writeBoundary: {
        allows: () => {
          boundaryCalls += 1;
          return true;
        },
      },
    });
    for (const invalid of [
      "docs/../src/app.ts",
      "docs//guide.md",
      "docs/guide\\evil.md",
      "C:/repo/docs/guide.md",
      "/repo/docs/guide.md",
      "docs/guide\u0000.md",
    ]) {
      expect(() => assertWritePathAllowed(allowAll, invalid)).toThrowError(
        expect.objectContaining({ code: "invalid-value" }),
      );
    }
    for (const protectedPath of [
      "packages/runtime/scripts/check-limits.mjs",
      "packages/runtime/bin/docsfab.js",
      "scripts/orchestration/mill-state.py",
      "packages/runtime/.gitlab-ci.yml",
      "docs/.git/hooks/code",
      "vendor/docs/code",
      ".git/objects/docs/x",
      "docs/node_modules/x",
      "docs/.github/workflows/ci.yml",
      "tools/unknown/code.ts",
    ]) {
      expect(() => assertWritePathAllowed(allowAll, protectedPath)).toThrowError(
        expect.objectContaining({
          code: protectedPath.includes(".gitlab") ? "ci-write-denied" : "source-write-denied",
        }),
      );
    }
    expect(boundaryCalls).toBe(0);
    expect(() => assertWritePathAllowed(allowAll, "docs/guide.md")).not.toThrow();
    expect(() => assertWritePathAllowed(allowAll, "README.md")).not.toThrow();
    for (const documentationPath of [
      "AUTHORS",
      "CODE_OF_CONDUCT.md",
      "SUPPORT.rst",
      ".docsfab/reference-model/README.md",
      "packages/runtime/docs/guide.md",
    ]) {
      expect(classifyTaskWritePath(documentationPath)).toBe("documentation");
      expect(() => assertWritePathAllowed(allowAll, documentationPath)).not.toThrow();
    }
    expect(() => assertWritePathAllowed(allowAll, "packages/runtime/src/index.ts")).toThrowError(
      expect.objectContaining({ code: "source-write-denied" }),
    );
  });

  it("refuses stale artifacts, cancelled work, and a widened child grant", () => {
    const controller = new AbortController();
    const created = scope({ signal: controller.signal });
    assertArtifactCurrent(created, {
      repositoryRevision: REVISION,
      repositoryContentDigest: HASH_B,
    });
    expect(() =>
      assertArtifactCurrent(created, { repositoryRevision: "d".repeat(40) }),
    ).toThrowError(expect.objectContaining({ code: "stale-artifact" }));
    const narrowed = narrowTaskScope(created, { writeClass: "none" });
    assertChildScopeDoesNotWiden(created, narrowed);
    expect(() =>
      assertChildScopeDoesNotWiden(
        narrowed,
        scope({ writeClass: "documentation", grant: liveGrant(HASH_B) }),
      ),
    ).toThrowError(expect.objectContaining({ code: "grant-widened" }));
    expect(() => narrowTaskScope(narrowed, { writeClass: "documentation" })).toThrowError(
      expect.objectContaining({ code: "grant-widened" }),
    );
    expect(() => assertChildScopeDoesNotWiden(created, scope({ writeClass: "none" }))).toThrowError(
      expect.objectContaining({ code: "grant-widened" }),
    );
    controller.abort();
    expect(() => assertTaskScopeActive(created)).toThrowError(
      expect.objectContaining({ code: "cancelled" }),
    );
  });

  it("refuses an optional source reference that would widen the child", () => {
    const parent = scope({ sourceBinding: null });
    expect(() =>
      narrowTaskScope(parent, {
        sourceBinding: {
          digest: HASH_A,
          repositoryRevision: REVISION,
          repositoryContentDigest: HASH_B,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "source-reference-cannot-widen" }));
    const bound = scope({
      sourceBinding: {
        digest: HASH_A,
        repositoryRevision: REVISION,
        repositoryContentDigest: HASH_B,
      },
    });
    const same = narrowTaskScope(bound, {
      sourceBinding: {
        digest: HASH_A,
        repositoryRevision: REVISION,
        repositoryContentDigest: HASH_B,
      },
    });
    assertChildScopeDoesNotWiden(bound, same);
    expect(() =>
      narrowTaskScope(bound, {
        sourceBinding: {
          digest: HASH_B,
          repositoryRevision: REVISION,
          repositoryContentDigest: HASH_A,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "source-reference-cannot-widen" }));
  });

  it("records direct work as interactive-operation evidence, never a workflow RunRecord", () => {
    const created = scope();
    const operation = createInteractiveOperation({
      operationId: "op-1",
      taskId: projectTaskScope(created).snapshot.taskId,
      grantFingerprintSha256: HASH_A,
      scopeFingerprintSha256: projectTaskScope(created).snapshot.scopeFingerprintSha256,
      observationMode: "selected-checkout",
    });
    expect(operation.kind).toBe("docsfab-interactive-operation");
    expect(operation.schemaVersion).toBe(1);
    expect(operation.effectCertainty).toBe("did-not-start");
    expect(interactiveOperationFabricatesWorkflowRunRecord(operation)).toBe(false);
    expect(operation).not.toHaveProperty("steps");
    expect(operation).not.toHaveProperty("workflow");
    const referenced = referenceChildWorkflowResult(operation, {
      runId: "run-1",
      workflow: "review-documentation",
      recordSha256: HASH_B,
    });
    expect(referenced.childWorkflow).toEqual({
      runId: "run-1",
      workflow: "review-documentation",
      recordSha256: HASH_B,
    });
    expect(referenced.schemaVersion).toBe(1);
    expect(projectInteractiveOperation(referenced).availability).toBe("available");
    expect(() =>
      decodeInteractiveOperation({
        schemaVersion: 2,
        workflow: "review-documentation",
        steps: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "workflow-run-record-forbidden" }));
  });

  it("does not mark mutation complete when persistence fails", async () => {
    const operation = createInteractiveOperation({
      operationId: "op-2",
      taskId: "task-1",
      grantFingerprintSha256: HASH_A,
      scopeFingerprintSha256: HASH_B,
      observationMode: "workflow-export",
    });
    await expect(
      persistInteractiveOperation(operation, {
        nextCertainty: "mutation-completed",
        save: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toMatchObject({ code: "failed-persistence" });
    expect(operation.effectCertainty).toBe("did-not-start");
    const persisted = await persistInteractiveOperation(operation, {
      nextCertainty: "mutation-completed",
      save: async () => undefined,
    });
    expect(persisted.effectCertainty).toBe("mutation-completed");
    expect(decodeInteractiveOperation(persisted).operationSha256).toBe(persisted.operationSha256);
    expect(InteractiveOperationError).toBeDefined();
  });

  it("keeps effect certainty fail-closed and refuses backwards rewrites before save", async () => {
    const unknown = createInteractiveOperation({
      operationId: "op-unknown",
      taskId: "task-1",
      grantFingerprintSha256: HASH_A,
      scopeFingerprintSha256: HASH_B,
      observationMode: "workflow-export",
      effectCertainty: "mutation-unknown",
    });
    let saves = 0;
    await expect(
      persistInteractiveOperation(unknown, {
        nextCertainty: "mutation-completed",
        save: async () => {
          saves += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-value" });
    expect(saves).toBe(0);
    const repeated = await persistInteractiveOperation(unknown, {
      nextCertainty: "mutation-unknown",
      save: async () => {
        saves += 1;
      },
    });
    expect(repeated.effectCertainty).toBe("mutation-unknown");
    expect(saves).toBe(1);
  });

  it("binds shared workflow execution to the current scope before the runner starts", async () => {
    const grant = liveGrant(HASH_A);
    const created = scope({ grant });
    grant.revoke();
    await expect(
      executeWorkflowApplication({
        request: {
          workflow: "review-documentation",
          workspacePath: "/fixture",
          repository: {
            sourcePath: "/fixture",
            requestedRevision: "HEAD",
            revision: REVISION,
          },
          allowWrite: false,
        },
        services: {
          harness: {
            runStep: async () => {
              throw new Error("runner must not start after a revoked grant");
            },
          },
          store: { save: async () => undefined },
        },
        taskScope: created,
      }),
    ).rejects.toMatchObject({ code: "grant-revoked" });
  });

  it("propagates cancellation into the application bind without a private reason leak", async () => {
    const controller = new AbortController();
    const created = scope({ signal: controller.signal });
    controller.abort("PRIVATE cancellation reason");
    await expect(
      executeWorkflowApplication({
        request: {
          workflow: "review-documentation",
          workspacePath: "/fixture",
          repository: {
            sourcePath: "/fixture",
            requestedRevision: "HEAD",
            revision: REVISION,
          },
          allowWrite: false,
          signal: controller.signal,
        },
        services: {
          harness: {
            runStep: async () => {
              throw new Error("runner must not start after cancellation");
            },
          },
          store: { save: async () => undefined },
        },
        taskScope: created,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
