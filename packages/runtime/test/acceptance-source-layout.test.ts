// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeCommand,
  localAcceptanceEnvironment,
  runAcceptanceCli,
} from "../src/acceptance-cli.js";
import type { AcceptanceCommand } from "../src/acceptance.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const roots = temporaryRoots();
const environment = localAcceptanceEnvironment(process.env);

async function fixture(nested: boolean) {
  const root = await roots.create("docsfab-acceptance-layout-", { realpath: true });
  const source = join(root, "source");
  const runtime = nested ? join(source, "packages", "runtime") : source;
  const ready = join(runtime, "test", "fixtures", "runtime-evaluation", "repositories", "ready");
  await mkdir(ready, { recursive: true });
  await writeFile(join(ready, "README.md"), "readiness fixture\n");
  await writeFile(join(runtime, "package.json"), '{"name":"acceptance-layout-fixture"}\n');
  await writeFile(join(source, "root-config.json"), '{"source":"whole-repository"}\n');
  if (nested) {
    await mkdir(join(source, "packages", "knowledge"));
    await writeFile(join(source, "packages", "knowledge", "README.md"), "sibling source\n");
  }
  await initFixtureRepo(source, undefined, { branch: "main" });
  await commitFixture(source, "current source");
  return {
    root,
    source,
    runtime,
    state: join(root, "state"),
    evidence: join(root, "evidence"),
    tree: await git(source, ["rev-parse", "HEAD^{tree}"]),
    revision: await git(source, ["rev-parse", "HEAD"]),
  };
}

describe("acceptance source export layout", () => {
  it.each([false, true])(
    "authenticates the complete Git tree and retains the runtime execution directory (nested=%s)",
    async (nested) => {
      const paths = await fixture(nested);
      const calls: AcceptanceCommand[] = [];
      let phaseCalls = 0;
      const result = await runAcceptanceCli(
        ["--state-dir", paths.state, "--evidence-dir", paths.evidence],
        {
          repositoryRoot: paths.runtime,
          environment,
          // This control proves real Git/export/layout, not OS confinement or
          // package validation. Separate isolation controls retain that proof.
          isolateOffline: async () => ({ commandPrefix: [] }),
          log: () => {},
          async execute(command, stream) {
            calls.push(command);
            if (command.file === "npm" || command.file === "node") {
              phaseCalls += 1;
              const exportRoot = nested ? resolve(command.cwd, "../..") : command.cwd;
              expect(command.cwd).toBe(
                nested ? join(exportRoot, "packages", "runtime") : exportRoot,
              );
              expect(await readFile(join(exportRoot, "root-config.json"), "utf8")).toContain(
                "whole-repository",
              );
              if (nested) {
                expect(
                  await readFile(join(exportRoot, "packages", "knowledge", "README.md"), "utf8"),
                ).toBe("sibling source\n");
              }
              expect(await git(command.cwd, ["rev-parse", "HEAD^{tree}"])).toBe(paths.tree);
              expect(await readFile(join(command.cwd, "package.json"), "utf8")).toContain(
                "acceptance-layout-fixture",
              );
              return { exitCode: 0, stdout: "" };
            }
            return executeCommand(command, stream);
          },
        },
      );

      expect(result.passed).toBe(true);
      expect(phaseCalls).toBeGreaterThan(0);
      expect(
        calls.find((command) => command.file === "git" && command.args[0] === "archive")?.cwd,
      ).toBe(paths.source);
      expect(await git(paths.source, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
        "",
      );
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
      expect(manifest.testedCommit).toBe(paths.revision);
      expect(
        manifest.phases.find((phase: { id: string }) => phase.id === "workspace-cleanup").status,
      ).toBe("passed");
    },
  );

  it("rejects tampering outside the runtime subtree before any acceptance phase", async () => {
    const paths = await fixture(true);
    let phaseCalls = 0;
    const result = await runAcceptanceCli(
      ["--state-dir", paths.state, "--evidence-dir", paths.evidence],
      {
        repositoryRoot: paths.runtime,
        environment,
        isolateOffline: async () => ({ commandPrefix: [] }),
        log: () => {},
        async execute(command, stream) {
          if (command.file === "npm" || command.file === "node") {
            phaseCalls += 1;
            throw new Error("source authentication must precede phase execution");
          }
          const executed = await executeCommand(command, stream);
          if (command.file === "tar" && executed.exitCode === 0) {
            const target = command.args[command.args.indexOf("-C") + 1]!;
            await writeFile(
              join(target, "packages", "knowledge", "README.md"),
              "tampered sibling\n",
            );
          }
          return executed;
        },
      },
    );
    expect(result.passed).toBe(false);
    expect(phaseCalls).toBe(0);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "setup", status: "failed", networked: false }),
        expect.objectContaining({ id: "source-integrity", status: "passed" }),
        expect.objectContaining({ id: "workspace-cleanup", status: "passed" }),
      ]),
    );
    expect(await git(paths.source, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  });

  it.each(["--state-dir", "--evidence-dir"])(
    "refuses %s in a monorepo sibling before creating private directories",
    async (flag) => {
      const paths = await fixture(true);
      const forbidden = join(paths.source, "private-output");
      const calls: AcceptanceCommand[] = [];
      await expect(
        runAcceptanceCli(
          [
            "--state-dir",
            flag === "--state-dir" ? forbidden : paths.state,
            "--evidence-dir",
            flag === "--evidence-dir" ? forbidden : paths.evidence,
          ],
          {
            repositoryRoot: paths.runtime,
            environment,
            isolateOffline: async () => ({ commandPrefix: [] }),
            log: () => {},
            async execute(command, stream) {
              calls.push(command);
              return executeCommand(command, stream);
            },
          },
        ),
      ).rejects.toThrow(`${flag} must be outside the source repository.`);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(["rev-parse", "--show-toplevel"]);
      await expect(readFile(forbidden)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(paths.state)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(paths.evidence)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(paths.source, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
        "",
      );
    },
  );
});
