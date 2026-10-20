// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  assessRequiredRepositoryChecks,
  observeCheckedSnapshot,
  requiredRepositoryChecks,
  WorkflowChecksHostOperation,
} from "../src/workflow-execution/workflow-checks.js";
import {
  documentationUpdateRequest,
  materializePilotHead,
  PILOT_CLI,
  PILOT_REQUIRED_CHECK,
  requiredCheckInstructions,
} from "./helpers/documentation-supervision-pilot.js";
import { recordingAuthority } from "./helpers/recording-check-authority.js";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("required-check fixture distribution contract", () => {
  it("supplies an executable repository, stale guide, source and update request", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const instruction = await requiredCheckInstructions();
    expect(await readFile(join(repository, "AGENTS.md"), "utf8")).toBe(instruction);
    expect(requiredRepositoryChecks([{ path: "AGENTS.md", text: instruction }])).toMatchObject([
      {
        command: PILOT_REQUIRED_CHECK,
        argv: ["python3", "-m", "unittest", "discover", "-s", "tests"],
      },
    ]);
    expect(await readFile(join(repository, "docs/cli.md"), "utf8")).toContain(
      PILOT_CLI.staleOption,
    );
    expect(await readFile(join(repository, PILOT_CLI.source.split(":")[0]!), "utf8")).toContain(
      PILOT_CLI.currentOption,
    );
    expect((await documentationUpdateRequest()).trim()).not.toBe("");
    const result = await execute("python3", ["-m", "unittest", "discover", "-s", "tests"], {
      cwd: repository,
    });
    expect(result.stdout + result.stderr).toContain("Ran 2 tests");
    expect(result.stdout + result.stderr).toContain("OK");
  });

  it("binds required-check dispatch to the snapshot and refuses a later changed guide", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    const snapshot = await observeCheckedSnapshot(workspace.path);
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const operation = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: async () => authority,
    }).runStep({
      repositoryPath: workspace.path,
      step: {
        id: "lint-documentation",
        title: "Check",
        skill: "lint-documentation",
        mode: "read-only",
        prompt: "",
      },
      workflow: {
        name: "update-documentation",
        title: "Update",
        outcome: "Update the guide",
        contextPolicy: { schemaVersion: 1, steps: [] },
        steps: [],
      },
    });
    expect(authority.calls).toEqual([
      {
        executable: "/fixture/bin/python3",
        argv: ["-m", "unittest", "discover", "-s", "tests"],
        cwd: workspace.path,
      },
    ]);
    expect(JSON.parse(operation.summary)).toMatchObject({
      status: "passed",
      snapshotSha256: snapshot.sha256,
    });
    const gate = () =>
      assessRequiredRepositoryChecks({
        runId: "fixture-distribution",
        workspacePath: workspace.path,
        baselineInstructions: snapshot.instructions,
        steps: [
          {
            id: "lint-documentation",
            title: "Check",
            kind: "host-operation",
            skill: "lint-documentation",
            mode: "read-only",
            status: "succeeded",
            summary: operation.summary,
          },
        ],
      });
    expect(await gate()).toMatchObject({ status: "satisfied", commands: [PILOT_REQUIRED_CHECK] });
    await writeFile(join(workspace.path, "docs/cli.md"), PILOT_CLI.corrected);
    expect(await gate()).toMatchObject({ status: "refused" });
  });
});
