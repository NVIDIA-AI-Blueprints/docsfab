// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const withRepositoryWorkspace = vi.hoisted(() => vi.fn());

vi.mock("../src/repository/workspace/materialize.js", () => ({
  withRepositoryWorkspace,
}));

import { executeRunRequest } from "../src/cli/run-request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { LocalUserPublicationPreflightError } from "../src/delivery/contracts.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";

afterEach(() => {
  withRepositoryWorkspace.mockReset();
  vi.restoreAllMocks();
});

function stubConfig(): DocsFabConfig {
  return {
    projectRoot: "/tmp/does-not-matter",
    skillCrateDirectory: "/tmp/does-not-matter/skill-crate",
    qualityDirectory: "/tmp/does-not-matter/quality",
    qualityPackDirectory: "/tmp/does-not-matter/quality-pack",
    stateDirectory: "/tmp/docsfab-freshness-state",
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

const baseRequest = {
  workflow: "create-documentation" as const,
  repositoryPath: "/tmp/example",
  revision: "HEAD",
  allowWrite: true,
  releaseGate: false,
  verbose: false,
  json: false,
  showScan: false,
};

describe("executeRunRequest --draft-mr freshness prelude", () => {
  it("rejects pre-aborted dry runs before producing output", async () => {
    const controller = new AbortController();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    controller.abort();

    await expect(
      executeRunRequest({ ...baseRequest, dryRun: true, json: true }, stubConfig(), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("Workflow cancelled by user.");
    expect(output).not.toHaveBeenCalled();
    expect(withRepositoryWorkspace).not.toHaveBeenCalled();
  });

  it("rejects pre-aborted comment-MR runs before remote observation", async () => {
    const controller = new AbortController();
    const observe = vi.fn();
    controller.abort();

    await expect(
      executeRunRequest(
        { ...baseRequest, workflow: "review-documentation", commentMr: "88" },
        stubConfig(),
        {
          signal: controller.signal,
          commentExistingMr: {
            mutations: { commits: 0, branches: 0, pushes: 0, mergeRequests: 0 },
            observe,
            project: async () => ({}) as never,
          },
        },
      ),
    ).rejects.toThrow("Workflow cancelled by user.");
    expect(observe).not.toHaveBeenCalled();
    expect(withRepositoryWorkspace).not.toHaveBeenCalled();
  });

  it("runs GitLab freshness before the write workspace", async () => {
    withRepositoryWorkspace.mockRejectedValue(new Error("workspace should not start"));
    await expect(
      executeRunRequest({ ...baseRequest, draftMr: true }, stubConfig(), {
        ensurePublicationFreshness: async () => {
          throw new LocalUserPublicationPreflightError("stale-revision");
        },
      }),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect(withRepositoryWorkspace).not.toHaveBeenCalled();
  });

  it("stamps the pre-write phase recovery on a freshness stale-revision refusal", async () => {
    withRepositoryWorkspace.mockRejectedValue(new Error("workspace should not start"));
    const thrown = await executeRunRequest({ ...baseRequest, draftMr: true }, stubConfig(), {
      ensurePublicationFreshness: async () => {
        throw new LocalUserPublicationPreflightError("stale-revision");
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // A literal transcribed from `staleRevisionRecovery` in
    // src/operator/run-summary.ts, not recomputed through the selector.
    const envelope = toOperatorErrorEnvelope(thrown);
    expect(envelope.code).toBe("stale-revision");
    expect(envelope.nextAction).toContain(`docsfab doctor --repo ${baseRequest.repositoryPath}`);
    expect(envelope.nextAction).toContain(
      "GitLab's target branch moved before the write started; no run was created. Check this workspace with doctor, then retry, or fetch the merge-request target branch and pass --revision with its new head commit.",
    );
    expect(envelope.nextAction).not.toContain("preserved write");
    // The shared typed remediation for the code is replaced, not appended: it
    // speaks of republishing a preserved write, and pre-write has none.
    expect(envelope.message).not.toContain("republish a preserved write");
    expect(envelope.message).not.toContain("Create a new run at");
    expect(new LocalUserPublicationPreflightError("stale-revision").message).toContain(
      "republish a preserved write",
    );
  });

  it("stamps the pre-write phase when the freshness port throws synchronously", async () => {
    // A rejection handler would miss this; the prelude uses a try block so a
    // synchronous refusal from an injected port is marked the same way.
    withRepositoryWorkspace.mockRejectedValue(new Error("workspace should not start"));
    const thrown = await executeRunRequest({ ...baseRequest, draftMr: true }, stubConfig(), {
      ensurePublicationFreshness: () => {
        throw new LocalUserPublicationPreflightError("stale-revision");
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const envelope = toOperatorErrorEnvelope(thrown);
    expect(envelope.code).toBe("stale-revision");
    expect(envelope.nextAction).toContain(`docsfab doctor --repo ${baseRequest.repositoryPath}`);
    expect(envelope.message).not.toContain("republish a preserved write");
    expect(withRepositoryWorkspace).not.toHaveBeenCalled();
  });

  it("materializes the write workspace at GitLab HEAD after freshness", async () => {
    withRepositoryWorkspace.mockResolvedValue(undefined);
    const gitlabRevision = "b".repeat(40);
    await executeRunRequest({ ...baseRequest, draftMr: true }, stubConfig(), {
      ensurePublicationFreshness: async () => ({
        branch: "main",
        revision: gitlabRevision,
      }),
    });
    expect(withRepositoryWorkspace).toHaveBeenCalledWith(
      "/tmp/example",
      gitlabRevision,
      expect.any(Function),
    );
  });

  it("passes the target-branch policy into freshness without changing the requested HEAD", async () => {
    withRepositoryWorkspace.mockResolvedValue(undefined);
    const ensurePublicationFreshness = vi.fn().mockResolvedValue({
      branch: "main",
      revision: "b".repeat(40),
    });
    await executeRunRequest(
      { ...baseRequest, draftMr: true, revisionPolicy: "target-branch-head" },
      stubConfig(),
      { ensurePublicationFreshness },
    );
    expect(ensurePublicationFreshness).toHaveBeenCalledWith(
      expect.objectContaining({ revision: "HEAD", revisionPolicy: "target-branch-head" }),
    );
  });

  it("does not observe GitLab on --dry-run", async () => {
    withRepositoryWorkspace.mockResolvedValue(undefined);
    let observed = false;
    await executeRunRequest({ ...baseRequest, dryRun: true, json: true }, stubConfig(), {
      ensurePublicationFreshness: async () => {
        observed = true;
      },
    });
    expect(observed).toBe(false);
    expect(withRepositoryWorkspace).not.toHaveBeenCalled();
  });

  it("does not observe GitLab when --draft-mr is absent", async () => {
    withRepositoryWorkspace.mockResolvedValue(undefined);
    let observed = false;
    await executeRunRequest(baseRequest, stubConfig(), {
      ensurePublicationFreshness: async () => {
        observed = true;
      },
    });
    expect(observed).toBe(false);
    expect(withRepositoryWorkspace).toHaveBeenCalled();
  });

  it("creates one progress renderer per comment-MR retry without stacking observers", async () => {
    vi.resetModules();
    const { CommentExistingMrHeadChangedError: RetryHeadChangedError } = await import(
      "../src/cli/comment-existing-mr.js"
    );
    const renderers: Array<ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> }> = [];
    const createPrintProgressHandler = vi.fn(() => {
      const handler = Object.assign(vi.fn(), { dispose: vi.fn() });
      renderers.push(handler);
      return handler;
    });
    const localRun = vi.fn(
      async (
        request: { commentMrRetry?: boolean },
        _config: unknown,
        options: { onProgress?: (event: never, workflow: never) => void },
      ) => {
        options.onProgress?.(
          {
            type: "step-status",
            runId: "retry-progress",
            stepId: "audit-documentation",
            status: "running",
            sequence: request.commentMrRetry ? 2 : 1,
          } as never,
          getWorkflow("review-documentation") as never,
        );
        if (!request.commentMrRetry) {
          throw new RetryHeadChangedError({
            host: "gitlab.example.test",
            projectId: 17,
            mergeRequestIid: 88,
            sourceBranch: "docs/topic",
            targetBranch: "main",
            headSha: "e".repeat(40),
            requestIdentitySha256: "b".repeat(64),
            proofStatus: "current",
          });
        }
        return undefined;
      },
    );
    vi.doMock("../src/cli/progress.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/cli/progress.js")>()),
      createPrintProgressHandler,
    }));
    vi.doMock("../src/cli/run/local-workflow.js", () => ({ withLocalWorkflowRun: localRun }));
    const { executeRunRequest: executeIsolatedRunRequest } = await import(
      "../src/cli/run-request.js"
    );
    const observer = vi.fn();
    const observed = {
      host: "gitlab.example.test",
      projectId: 17,
      mergeRequestIid: 88,
      sourceBranch: "docs/topic",
      targetBranch: "main",
      headSha: "d".repeat(40),
      requestIdentitySha256: "a".repeat(64),
      proofStatus: "current" as const,
    };

    try {
      await executeIsolatedRunRequest(
        {
          ...baseRequest,
          workflow: "review-documentation",
          allowWrite: false,
          commentMr: "88",
        },
        stubConfig(),
        {
          onProgress: observer,
          commentExistingMr: {
            mutations: { commits: 0, branches: 0, pushes: 0, mergeRequests: 0 },
            observe: async () => observed,
            project: async () => ({}) as never,
          },
        },
      );
    } finally {
      vi.doUnmock("../src/cli/progress.js");
      vi.doUnmock("../src/cli/run/local-workflow.js");
    }

    expect(localRun).toHaveBeenCalledTimes(2);
    expect(observer).toHaveBeenCalledTimes(2);
    expect(createPrintProgressHandler).toHaveBeenCalledTimes(2);
    expect(renderers).toHaveLength(2);
    expect(renderers[0]).toHaveBeenCalledTimes(1);
    expect(renderers[1]).toHaveBeenCalledTimes(1);
    expect(renderers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(renderers[1]!.dispose).toHaveBeenCalledTimes(1);
  });
});
