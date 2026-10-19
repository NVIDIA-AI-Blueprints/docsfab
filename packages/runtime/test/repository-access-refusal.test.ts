// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

const gitOwnershipTest = vi.hoisted(() => ({ assumeDifferentOwner: false }));
const filesystemAccessTest = vi.hoisted(() => ({ denyRealpath: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const custom = (actual.execFile as unknown as Record<symbol, unknown>)[promisify.custom] as (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  function execFile(...args: unknown[]): unknown {
    return Reflect.apply(actual.execFile, actual, args);
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: Record<string, unknown>) => {
      if (!gitOwnershipTest.assumeDifferentOwner) return custom(file, args, options);
      return custom(file, args, {
        ...options,
        env: {
          ...(options.env as Record<string, string | undefined> | undefined),
          GIT_TEST_ASSUME_DIFFERENT_OWNER: "true",
        },
      });
    },
  });
  return { ...actual, execFile };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = async (...args: Parameters<typeof actual.realpath>) => {
    if (filesystemAccessTest.denyRealpath) {
      throw Object.assign(new Error("private path and credential canary"), { code: "EACCES" });
    }
    return Reflect.apply(actual.realpath, actual, args);
  };
  return { ...actual, realpath };
});

import {
  repositoryAccessRefusalCode,
  repositoryFilesystemAccessDenied,
  RepositoryAccessRefusalError,
} from "../src/repository/workspace/access-refusal.js";
import {
  formatOperatorErrorEnvelope,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";

const execFileAsync = promisify(execFile);

describe("repository access refusal", () => {
  it("recognizes Git's controlled dubious-ownership refusal without retaining its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-access-refusal-"));
    try {
      await execFileAsync("git", ["init", "--quiet", root]);
      let failure: unknown;
      try {
        await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
          env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "true", LANG: "C", LC_ALL: "C" },
        });
      } catch (error) {
        failure = error;
      }
      expect(repositoryAccessRefusalCode(failure)).toBe("repository-ownership-mismatch");
      const refusal = new RepositoryAccessRefusalError("repository-ownership-mismatch");
      expect(refusal.message).not.toContain(root);
      expect(refusal.message).not.toContain("dubious ownership");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("translates the actual controlled Git refusal through workspace preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-workspace-access-refusal-"));
    try {
      await execFileAsync("git", ["init", "--quiet", root]);
      gitOwnershipTest.assumeDifferentOwner = true;
      let failure: unknown;
      try {
        await prepareRepositoryWorkspace(root);
      } catch (error) {
        failure = error;
      } finally {
        gitOwnershipTest.assumeDifferentOwner = false;
      }
      expect(failure).toBeInstanceOf(RepositoryAccessRefusalError);
      expect(failure).toMatchObject({ code: "repository-ownership-mismatch" });
      expect((failure as Error).message).not.toContain(root);
    } finally {
      gitOwnershipTest.assumeDifferentOwner = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("translates a native checkout realpath access denial and keeps ordinary materialization working", async () => {
    const deniedRoot = await mkdtemp(join(tmpdir(), "docsfab-workspace-realpath-denied-"));
    try {
      filesystemAccessTest.denyRealpath = true;
      let failure: unknown;
      try {
        await prepareRepositoryWorkspace(deniedRoot);
      } catch (error) {
        failure = error;
      } finally {
        filesystemAccessTest.denyRealpath = false;
      }
      expect(failure).toBeInstanceOf(RepositoryAccessRefusalError);
      expect(failure).toMatchObject({ code: "repository-access-denied" });
      expect((failure as Error).message).not.toContain("private path");
      expect((failure as Error).message).not.toContain("credential canary");
    } finally {
      filesystemAccessTest.denyRealpath = false;
      await rm(deniedRoot, { recursive: true, force: true });
    }

    const root = await mkdtemp(join(tmpdir(), "docsfab-workspace-access-control-"));
    try {
      await execFileAsync("git", ["init", "--quiet", root]);
      await writeFile(join(root, "README.md"), "readable workspace\n");
      await execFileAsync("git", ["-C", root, "add", "README.md"]);
      await execFileAsync("git", [
        "-C",
        root,
        "-c",
        "user.name=DocsFab Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "workspace fixture",
      ]);
      const workspace = await prepareRepositoryWorkspace(root);
      try {
        expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe(
          "readable workspace\n",
        );
      } finally {
        await workspace.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes only bounded stderr patterns on a failed Git process", () => {
    const error = Object.assign(new Error("secret-path and secret-token"), {
      code: 128,
      stderr:
        "fatal: detected dubious ownership in repository at '/private/secret-path'\n" +
        "To add an exception for this directory, call:\n" +
        "\tgit config --global --add safe.directory /private/secret-path\n",
    });
    expect(repositoryAccessRefusalCode(error)).toBe("repository-ownership-mismatch");
    expect(
      repositoryAccessRefusalCode(
        Object.assign(new Error("fatal: detected dubious ownership"), {
          code: 128,
          stderr: "fatal: detected dubious ownership",
        }),
      ),
    ).toBeUndefined();
    expect(
      repositoryAccessRefusalCode(
        Object.assign(new Error("permission denied"), {
          code: 128,
          stderr: "fatal: cannot open '.git/config' for reading: Permission denied\n",
        }),
      ),
    ).toBe("repository-access-denied");
    expect(
      repositoryAccessRefusalCode(
        Object.assign(new Error("permission denied"), {
          code: 128,
          stderr: "fatal: cannot change to '/private/secret-path': Permission denied\n",
        }),
      ),
    ).toBe("repository-access-denied");
    expect(
      repositoryFilesystemAccessDenied(Object.assign(new Error("secret"), { code: "EACCES" })),
    ).toBe(true);
    expect(
      repositoryFilesystemAccessDenied(Object.assign(new Error("secret"), { code: "EPERM" })),
    ).toBe(true);
    expect(
      repositoryFilesystemAccessDenied(Object.assign(new Error("secret"), { code: "ENOENT" })),
    ).toBe(false);
    expect(
      repositoryAccessRefusalCode({
        name: "RepositoryAccessRefusalError",
        code: "repository-ownership-mismatch",
        message: "secret path and secret prompt",
      }),
    ).toBeUndefined();
    expect(() => new RepositoryAccessRefusalError("unrecognized-code" as never)).toThrowError(
      "Repository access refusals must use a code shipped with DocsFab.",
    );
  });

  it("projects safe messages, host classification, next action, and docs in human and JSON envelopes", () => {
    const canary = "secret-token-and-private-path";
    for (const code of ["repository-ownership-mismatch", "repository-access-denied"] as const) {
      const error = new RepositoryAccessRefusalError(code);
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope).toMatchObject({
        kind: "docsfab-operator-error",
        code,
        failure: { class: "operator-input", layer: "host", code },
        docsAnchor: "docs/troubleshooting.md",
      });
      expect(envelope.nextAction).toContain("dedicated CI/container checkout");
      expect(envelope.nextAction).toContain("Git metadata");
      expect(formatOperatorErrorEnvelope(envelope)).not.toContain(canary);
      expect(serializeOperatorErrorEnvelope(envelope)).not.toContain(canary);
      expect(JSON.stringify(envelope)).not.toContain("safe.directory");
      expect(JSON.stringify(envelope)).not.toContain("/private/");
    }
  });
});
