// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evidenceReads = vi.hoisted(() => ({
  json: vi.fn(async () => ({})),
  reviewerPolicy: vi.fn(async () => ({})),
}));

// Exercise the real public distribution's absent-content capability.
vi.mock("../src/config/private-content-paths.js", () => ({
  PRIVATE_CONTENT_PATHS: Object.freeze({}),
}));
vi.mock("../src/quality-evaluation/corpus-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/quality-evaluation/corpus-files.js")>()),
  readStrictJson: evidenceReads.json,
}));
vi.mock("../src/ia/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ia/index.js")>()),
  loadIaPlanReviewerPolicyFile: evidenceReads.reviewerPolicy,
}));

import { prepareRunPreflight } from "../src/cli/run/preflight.js";
import type { CliRunInvocation } from "../src/cli/run/request.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { validModelConfig } from "./helpers.js";

describe("internal corpus preflight admission", () => {
  let source: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    source = await realpath(await mkdtemp(join(tmpdir(), "docsfab-content-admission-")));
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
  });

  async function preflight(model = validModelConfig): Promise<unknown> {
    const invocation = {
      request: {
        workflow: "ia-analysis",
        runId: "public-capability-control",
        corpusExecutionAuthorizationPath: join(source, "authorization.json"),
        corpusReviewerPolicyPath: join(source, "reviewer-policy.json"),
        corpusCaseId: "independent-case",
        corpusTestedRevision: "a".repeat(40),
      },
      config: { projectRoot: source, model },
      output: {},
    } as unknown as CliRunInvocation;
    return prepareRunPreflight(invocation, {
      sourcePath: source,
    } as unknown as RepositoryWorkspace).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("refuses unavailable internal content before starting authorization or reviewer reads", async () => {
    const failure = await preflight();
    expect(failure).toMatchObject({ code: "internal-content-unavailable" });
    expect(evidenceReads.json).not.toHaveBeenCalled();
    expect(evidenceReads.reviewerPolicy).not.toHaveBeenCalled();
  });

  it("keeps model evidence admission ahead of internal content and evidence reads", async () => {
    const failure = await preflight({ ...validModelConfig, modelId: "invalid:model" });
    expect(toOperatorErrorEnvelope(failure).code).toBe("profile-evidence-invalid");
    expect(evidenceReads.json).not.toHaveBeenCalled();
    expect(evidenceReads.reviewerPolicy).not.toHaveBeenCalled();
  });
});
