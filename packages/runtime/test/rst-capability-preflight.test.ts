// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const campaignProbe = vi.hoisted(() => ({ task: undefined as unknown, calls: 0 }));

vi.mock("../src/doc-improvement-cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/doc-improvement-cli.js")>();
  return {
    ...actual,
    loadAuthorizedDocImprovementWriteTask: async () => {
      campaignProbe.calls += 1;
      return campaignProbe.task;
    },
  };
});

import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { prepareRunPreflight } from "../src/cli/run/preflight.js";
import { assembleHostOperations } from "../src/cli/run/host-operations.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import { reportOperatorFailure } from "../src/operator/error-envelope.js";
import { isProcessEntrypoint, runCliEntrypoint } from "../src/operator/cli-entrypoint.js";
import {
  countingInterpreter,
  digest,
  fixture,
  runRequest,
  task,
} from "./rst-capability-preflight-support.js";
import {
  SITE_BOOTSTRAP_REVIEWER_POLICY,
  siteBootstrapBundle,
  siteBootstrapIndex,
} from "./site-bootstrap-fixtures.js";

const originalArgv = process.argv;

afterEach(() => {
  campaignProbe.task = undefined;
  campaignProbe.calls = 0;
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function runShippedErrorBoundary(error: unknown, json: boolean) {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
    lines.push(String(line));
  });
  process.argv = [originalArgv[0]!, fileURLToPath(import.meta.url), ...(json ? ["--json"] : [])];
  if (!isProcessEntrypoint(import.meta.url)) {
    throw new Error(`test CLI module was not recognized as entrypoint: ${process.argv[1]}`);
  }
  runCliEntrypoint(import.meta.url, async () => {
    throw error;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { lines, exitCode: process.exitCode };
}

describe("caller-bound RST capability admission", () => {
  it("admits the real campaign CLI path before its first provider call", async () => {
    const fixtureData = await fixture();
    campaignProbe.calls = 0;
    campaignProbe.task = task(fixtureData.repositoryPath, fixtureData.revision, ["docs/guide.rst"]);
    const model = countingInterpreter();
    const parsed = parseRunArguments([
      "update-documentation",
      "--repo",
      fixtureData.repositoryPath,
      "--revision",
      fixtureData.revision,
      "--allow-write",
      "--doc-improvement-campaign",
      join(dirname(fixtureData.repositoryPath), "campaign"),
      "--reviewer-policy",
      join(dirname(fixtureData.repositoryPath), "reviewers.json"),
    ]);
    const request = { ...parsed, draftMr: false };
    const failure = await executeRunRequest(request, fixtureData.config, {
      requestInterpreter: model.port,
    }).catch((error: unknown) => error);

    expect(campaignProbe.calls).toBe(1);
    expect(failure).toMatchObject({
      code: "rst-capability-unsupported-delivery",
      nextAction: expect.stringContaining("--patch-only"),
    });
    expect(model.calls).toBe(0);
    const humanLines: string[] = [];
    const human = reportOperatorFailure(failure, { write: (line) => humanLines.push(line) });
    const jsonLines: string[] = [];
    const json = reportOperatorFailure(failure, {
      json: true,
      write: (line) => jsonLines.push(line),
    });
    expect(humanLines.join("\n")).toContain("code: rst-capability-unsupported-delivery");
    expect(humanLines.join("\n")).toContain("Next action: Add --patch-only");
    expect(human).toMatchObject({
      code: "rst-capability-unsupported-delivery",
      failure: { class: "operator-input" },
    });
    expect(JSON.parse(jsonLines[0]!)).toMatchObject({
      code: "rst-capability-unsupported-delivery",
      nextAction: json.nextAction,
      failure: { class: "operator-input" },
    });
    const shippedHuman = await runShippedErrorBoundary(failure, false);
    expect(shippedHuman.exitCode).toBe(1);
    expect(shippedHuman.lines.join("\n")).toContain("code: rst-capability-unsupported-delivery");
    expect(shippedHuman.lines.join("\n")).toContain("Next action: Add --patch-only");
    const shippedJson = await runShippedErrorBoundary(failure, true);
    expect(shippedJson.exitCode).toBe(1);
    expect(JSON.parse(shippedJson.lines[0]!)).toMatchObject({
      kind: "docsfab-operator-error",
      code: "rst-capability-unsupported-delivery",
      nextAction:
        "Add --patch-only to the existing update command, or select a supported Markdown or MDX target.",
    });
    campaignProbe.task = undefined;
  });

  it("leaves site-bootstrap task construction to its existing host assembly", async () => {
    const fixtureData = await fixture();
    const planPath = join(dirname(fixtureData.repositoryPath), "site-plan.json");
    const reviewerPolicyPath = join(dirname(fixtureData.repositoryPath), "reviewers.json");
    await writeFile(
      planPath,
      `${JSON.stringify(siteBootstrapBundle(siteBootstrapIndex(fixtureData.revision), new Date()))}\n`,
    );
    await writeFile(reviewerPolicyPath, `${JSON.stringify(SITE_BOOTSTRAP_REVIEWER_POLICY)}\n`);
    await chmod(reviewerPolicyPath, 0o600);
    const request: RunRequestWithPublishProjection = {
      workflow: "site-bootstrap",
      repositoryPath: fixtureData.repositoryPath,
      revision: "HEAD",
      planPath,
      reviewerPolicyPath,
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    };

    await withRepositoryWorkspace(fixtureData.repositoryPath, "HEAD", async (workspace) => {
      const invocation = {
        request,
        config: fixtureData.config,
        options: {},
        output: { log: () => undefined, error: () => undefined },
      };
      const preflight = await prepareRunPreflight(invocation, workspace);
      if ("stoppedRecord" in preflight) {
        throw new Error(`site-bootstrap preflight stopped at ${preflight.code}`);
      }
      expect(preflight.task).toBeUndefined();

      const assembled = await assembleHostOperations(
        invocation,
        workspace,
        {} as RepositoryEvidenceCollector,
        preflight,
      );
      expect(assembled.task?.kind).toBe("site-bootstrap");
    });
  });

  it("refuses two canonical RST targets before request interpretation", async () => {
    const fixtureData = await fixture();
    const model = countingInterpreter();
    const failure = await executeRunRequest(
      runRequest(
        fixtureData.repositoryPath,
        task(fixtureData.repositoryPath, fixtureData.revision, [
          "docs/guide.rst",
          "docs/other.rst",
        ]),
        true,
      ),
      fixtureData.config,
      { requestInterpreter: model.port },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "rst-capability-unsupported-cardinality" });
    expect(model.calls).toBe(0);
  });

  it("rejects forged task repository or revision bindings in canonical normalization", async () => {
    const fixtureData = await fixture();
    const model = countingInterpreter();
    for (const requestTask of [
      {
        ...task(fixtureData.repositoryPath, fixtureData.revision, ["docs/guide.rst"]),
        repositoryIdentitySha256: digest,
      },
      {
        ...task(fixtureData.repositoryPath, fixtureData.revision, ["docs/guide.rst"]),
        testedCommit: "0".repeat(40),
      },
    ]) {
      const failure = await executeRunRequest(
        runRequest(fixtureData.repositoryPath, requestTask, true),
        fixtureData.config,
        { requestInterpreter: model.port },
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "bounded-doc-binding" });
    }
    expect(model.calls).toBe(0);
  });

  it("refuses a canonical RST update without explicit patch-only delivery before interpretation", async () => {
    const fixtureData = await fixture();
    const model = countingInterpreter();
    const failure = await executeRunRequest(
      runRequest(
        fixtureData.repositoryPath,
        task(fixtureData.repositoryPath, fixtureData.revision, ["docs/guide.rst"]),
        false,
      ),
      fixtureData.config,
      { requestInterpreter: model.port },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "rst-capability-unsupported-delivery",
      nextAction: expect.stringContaining("--patch-only"),
    });
    expect(model.calls).toBe(0);
  });

  it("refuses an RST target in the foundation-to-patch operation before interpretation", async () => {
    const fixtureData = await fixture();
    const model = countingInterpreter();
    const foundationTask = {
      kind: "foundation-to-patch" as const,
      intendedPaths: ["docs/guide.rst"],
    };
    const failure = await executeRunRequest(
      runRequest(fixtureData.repositoryPath, foundationTask, true, "foundation-to-patch"),
      fixtureData.config,
      { requestInterpreter: model.port },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "rst-capability-unsupported-operation",
      nextAction: expect.stringContaining("update-documentation"),
    });
    expect(model.calls).toBe(0);
  });

  it("refuses a caller-bound RST page with competing tracked Sphinx configurations", async () => {
    const fixtureData = await fixture({ competingRootConf: true });
    const model = countingInterpreter();
    const failure = await executeRunRequest(
      runRequest(
        fixtureData.repositoryPath,
        task(fixtureData.repositoryPath, fixtureData.revision, ["docs/guide.rst"]),
        true,
      ),
      fixtureData.config,
      { requestInterpreter: model.port },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "rst-capability-unsupported-adapter",
      nextAction: expect.stringContaining("tracked Sphinx configuration"),
    });
    expect(model.calls).toBe(0);
  });
});
