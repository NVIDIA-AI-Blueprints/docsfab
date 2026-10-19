// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareRepositoryCheckCapability,
  repositoryCheckPolicyDigest,
  RepositoryCheckError,
  runRepositoryChecks,
  type RepositoryCheckCapability,
  type RepositoryCheckPolicy,
} from "../src/templates/checks.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("trusted repository checks", () => {
  it("runs exact allowlisted commands without persisting their output", async () => {
    const workspace = await temporaryDirectory();
    const policy = createPolicy([
      {
        id: "success",
        executable: process.execPath,
        args: [
          "-e",
          `if (process.env.PATH !== ${JSON.stringify(dirname(process.execPath))}) process.exit(9); console.log('TOKEN_SENTINEL')`,
        ],
        timeoutMs: 5_000,
      },
    ]);

    const allowedExecutables = [process.execPath];
    const capabilityPromise = prepareRepositoryCheckCapability({
      policy,
      allowedExecutables,
    });
    policy.checks[0]!.args = ["-e", "process.exit(13)"];
    allowedExecutables[0] = "node";
    const capability = await capabilityPromise;

    const report = await runRepositoryChecks({
      workspacePath: workspace,
      capability,
    });

    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.keys(capability)).toEqual(["id", "version", "digest"]);
    expect(report.status).toBe("passed");
    expect(report.results[0]).toMatchObject({ status: "passed", exitCode: 0, stdoutBytes: 15 });
    expect(report.results[0]!.stdoutSha256).toBe(
      createHash("sha256").update("TOKEN_SENTINEL\n").digest("hex"),
    );
    expect(JSON.stringify(report)).not.toContain("TOKEN_SENTINEL");
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("records a bounded failed result rather than executing through a shell", async () => {
    const workspace = await temporaryDirectory();
    const policy = createPolicy([
      {
        id: "failure",
        executable: process.execPath,
        args: ["-e", "process.stderr.write('private'); process.exit(7)"],
        timeoutMs: 5_000,
      },
    ]);
    const capability = await prepareRepositoryCheckCapability({
      policy,
      allowedExecutables: [process.execPath],
    });
    const report = await runRepositoryChecks({
      workspacePath: workspace,
      capability,
    });

    expect(report).toMatchObject({
      status: "failed",
      results: [{ status: "failed", exitCode: 7 }],
    });
    expect(JSON.stringify(report)).not.toContain("private");
  });

  it("rejects unbound executables, mutable policy fields, and shell-shaped arguments", async () => {
    const policy = createPolicy([
      {
        id: "check",
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 5_000,
      },
    ]);
    await expect(
      prepareRepositoryCheckCapability({
        policy,
        allowedExecutables: ["npm"],
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-policy", "allowedExecutables[0]"));

    const stale = structuredClone(policy);
    stale.checks[0]!.timeoutMs += 1;
    await expect(
      prepareRepositoryCheckCapability({
        policy: stale,
        allowedExecutables: [process.execPath],
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-policy", "policy.digest"));

    const newline = createPolicy([
      { id: "check", executable: process.execPath, args: ["first\nsecond"], timeoutMs: 5_000 },
    ]);
    await expect(
      prepareRepositoryCheckCapability({
        policy: newline,
        allowedExecutables: [process.execPath],
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-command", "policy.checks[0].args"));
  });

  it("rejects a symlink workspace before any command runs", async () => {
    const workspace = await temporaryDirectory();
    const link = `${workspace}-link`;
    temporaryDirectories.push(link);
    await symlink(workspace, link, "dir");
    const policy = createPolicy([
      {
        id: "check",
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 5_000,
      },
    ]);

    const capability = await prepareRepositoryCheckCapability({
      policy,
      allowedExecutables: [process.execPath],
    });
    await expect(
      runRepositoryChecks({
        workspacePath: link,
        capability,
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-workspace", "workspacePath"));
  });

  it("rejects non-canonical, symlink, and non-file executables", async () => {
    const workspace = await temporaryDirectory();
    const executableLink = join(workspace, "node-link");
    const directory = join(workspace, "not-an-executable");
    await symlink(process.execPath, executableLink);
    await mkdir(directory);

    const linkedPolicy = createPolicy([
      { id: "check", executable: executableLink, args: [], timeoutMs: 5_000 },
    ]);
    await expect(
      prepareRepositoryCheckCapability({
        policy: linkedPolicy,
        allowedExecutables: [executableLink],
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-policy", "allowedExecutables[0]"));

    const directoryPolicy = createPolicy([
      { id: "check", executable: directory, args: [], timeoutMs: 5_000 },
    ]);
    await expect(
      prepareRepositoryCheckCapability({
        policy: directoryPolicy,
        allowedExecutables: [directory],
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-policy", "allowedExecutables[0]"));

    const barePolicy = createPolicy([
      { id: "check", executable: "node", args: [], timeoutMs: 5_000 },
    ]);
    await expect(
      prepareRepositoryCheckCapability({
        policy: barePolicy,
        allowedExecutables: [process.execPath],
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-command", "policy.checks[0].executable"));
  });

  it("rejects a structurally identical forged capability", async () => {
    const workspace = await temporaryDirectory();
    const policy = createPolicy([
      { id: "check", executable: process.execPath, args: [], timeoutMs: 5_000 },
    ]);
    const forged = {
      id: policy.id,
      version: policy.version,
      digest: policy.digest,
    } as RepositoryCheckCapability;

    await expect(
      runRepositoryChecks({
        workspacePath: workspace,
        capability: forged,
      }),
    ).rejects.toEqual(new RepositoryCheckError("invalid-policy", "capability"));
  });
});

function createPolicy(checks: RepositoryCheckPolicy["checks"]): RepositoryCheckPolicy {
  const value = { id: "docsfab:test-checks", version: "1", checks };
  return { ...value, digest: repositoryCheckPolicyDigest(value) };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "docsfab-template-checks-"));
  temporaryDirectories.push(path);
  return path;
}
