// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { missingGitPrerequisite } from "../src/launcher.js";
import { createGlabCommentExistingMrNoteHooks } from "../src/cli/comment-existing-mr-glab.js";
import { probeSourceParserConfinement } from "../src/inputs/source-parser-launch.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { documentationCommandSandbox } from "../src/live-agent/command-sandbox.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { ExecInitCommandRunner } from "../src/init/shared.js";
import { untrustedChildEnvironment } from "../src/security/child-process-environment.js";
import { temporaryRoots } from "./helpers/temp.js";
import { validModelEnvironment } from "./helpers.js";

const roots = temporaryRoots();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("credential-free host probes", () => {
  it.each([
    "http://fixture-user:fixture-password@proxy.example.test:8080",
    "//fixture-user:fixture-password@proxy.example.test:8080",
    "fixture-user:fixture-password@proxy.example.test:8080",
    "http://fixture-user:fixture-password@bad host:8080",
  ])("drops credential-bearing or malformed proxy input from an untrusted child", (proxy) => {
    const child = untrustedChildEnvironment({
      PATH: "/usr/bin",
      HTTPS_PROXY: proxy,
      HTTP_PROXY: "http://proxy.example.test:8080",
      ALL_PROXY: "//proxy.example.test:8080",
      http_proxy: "proxy.example.test:8080",
      NO_PROXY: "docs.example.test",
    });
    expect(child).toEqual({
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy.example.test:8080",
      ALL_PROXY: "//proxy.example.test:8080",
      http_proxy: "proxy.example.test:8080",
      NO_PROXY: "docs.example.test",
    });
  });
  it("filters configuration-file credentials from launcher and parser children", async () => {
    const root = await roots.create("docsfab-credential-probes-");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const reportPath = join(root, "child-environment.jsonl");
    const fakePath = join(bin, "git");
    const modelKey = "probe-file-model-secret-7bd2c81e";
    const otherSecret = "probe-file-other-secret-93fe2a70";
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(home, { recursive: true })]);
    await writeFile(
      join(root, ".env"),
      `${Object.entries({
        ...validModelEnvironment,
        MODEL_API_KEY: modelKey,
        DOCSFAB_FIXTURE_TOKEN: otherSecret,
      })
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      fakePath,
      `#!${process.execPath}\nconst fs=require("node:fs");const path=${JSON.stringify(reportPath)};fs.appendFileSync(path,JSON.stringify({model:Boolean(process.env.MODEL_API_KEY),other:Boolean(process.env.DOCSFAB_FIXTURE_TOKEN),path:Boolean(process.env.PATH),home:Boolean(process.env.HOME)})+"\\n");process.exit(0);\n`,
      { mode: 0o700 },
    );
    await chmod(fakePath, 0o700);
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`);
    vi.stubEnv("HOME", home);

    loadConfig();
    const fullEnvironmentControl = execFileSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(String(Boolean(process.env.MODEL_API_KEY && process.env.DOCSFAB_FIXTURE_TOKEN)))",
      ],
      {
        env: { ...process.env, MODEL_API_KEY: modelKey, DOCSFAB_FIXTURE_TOKEN: otherSecret },
        encoding: "utf8",
      },
    );
    expect(fullEnvironmentControl).toBe("true");

    expect(missingGitPrerequisite()).toBeUndefined();
    const parserProbe = probeSourceParserConfinement({
      platform: "linux",
      environment: process.env,
      run: (_file, _args, environment) => {
        const result = spawnSync(fakePath, [], { env: environment, stdio: "ignore" });
        if (result.error || result.status !== 0) throw new Error("stand-in probe failed");
      },
    });
    expect(parserProbe.available).toBe(true);

    const reports = (await readFile(reportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, boolean>);
    expect(reports).toHaveLength(2);
    expect(reports).toEqual(
      reports.map(() => ({ model: false, other: false, path: true, home: true })),
    );
  });

  it("filters the live-agent git and sandbox readiness children", async () => {
    if (process.platform !== "darwin") return;
    const root = await roots.create("docsfab-live-sandbox-env-");
    const repository = join(root, "repository");
    const reportPath = join(root, "sandbox-environment.jsonl");
    await mkdir(repository, { recursive: true });
    execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: repository });
    const modelKey = "sandbox-file-model-secret-7843ac9f";
    const otherSecret = "sandbox-file-other-secret-26c41f83";
    await writeFile(
      join(root, ".env"),
      `${Object.entries({
        ...validModelEnvironment,
        MODEL_API_KEY: modelKey,
        DOCSFAB_FIXTURE_TOKEN: otherSecret,
      })
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    loadConfig();

    const sandbox = await documentationCommandSandbox(
      repository,
      new DocumentationScope(),
      process.env,
      {
        runExec: async (file, _args, options) => {
          const stdout =
            file === "git" ? `${join(repository, ".git")}\n${join(repository, ".git")}\n` : "";
          const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(reportPath)},JSON.stringify({model:Boolean(process.env.MODEL_API_KEY),other:Boolean(process.env.DOCSFAB_FIXTURE_TOKEN),path:Boolean(process.env.PATH),home:Boolean(process.env.HOME)})+"\\n");process.stdout.write(${JSON.stringify(stdout)});`;
          const result = spawnSync(process.execPath, ["-e", script], {
            cwd: options.cwd,
            env: options.env,
            encoding: "utf8",
          });
          if (result.error || result.status !== 0) throw new Error("stand-in sandbox probe failed");
          return { stdout: result.stdout };
        },
      },
    );
    try {
      const reports = (await readFile(reportPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, boolean>);
      expect(reports).toHaveLength(2);
      expect(reports).toEqual(
        reports.map(() => ({ model: false, other: false, path: true, home: true })),
      );
    } finally {
      await sandbox.restoreGitState();
      await sandbox.cleanup();
    }
  });

  it("passes only the named GitLab credentials to the intended glab API child", async () => {
    const root = await roots.create("docsfab-glab-child-env-");
    const bin = join(root, "bin");
    const reportPath = join(root, "glab-environment.json");
    const fakeGlabPath = join(bin, "glab");
    const modelKey = "glab-file-model-secret-c7a35d18";
    const otherSecret = "glab-file-other-secret-b6248e39";
    const glabToken = "operator-glab-token-4b1a8e73";
    const gitlabToken = "operator-gitlab-token-2f7c9d41";
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(root, ".env"),
      `${Object.entries({
        ...validModelEnvironment,
        MODEL_API_KEY: modelKey,
        DOCSFAB_FIXTURE_TOKEN: otherSecret,
        GLAB_TOKEN: glabToken,
      })
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      fakeGlabPath,
      `#!${process.execPath}\nconst fs=require("node:fs");const expectedGlab=${JSON.stringify(glabToken)};const expectedGitlab=${JSON.stringify(gitlabToken)};fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({model:Boolean(process.env.MODEL_API_KEY),other:Boolean(process.env.DOCSFAB_FIXTURE_TOKEN),glab:process.env.GLAB_TOKEN===expectedGlab,gitlab:process.env.GITLAB_TOKEN===expectedGitlab}));process.stdout.write(JSON.stringify({id:42}));\n`,
      { mode: 0o700 },
    );
    await chmod(fakeGlabPath, 0o700);
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`);
    vi.stubEnv("GLAB_TOKEN", undefined);
    vi.stubEnv("GITLAB_TOKEN", gitlabToken);
    loadConfig();
    expect(process.env.GLAB_TOKEN).toBeUndefined();

    const fullEnvironmentControl = execFileSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(String(Boolean(process.env.MODEL_API_KEY && process.env.DOCSFAB_FIXTURE_TOKEN)))",
      ],
      {
        env: { ...process.env, MODEL_API_KEY: modelKey, DOCSFAB_FIXTURE_TOKEN: otherSecret },
        encoding: "utf8",
      },
    );
    expect(fullEnvironmentControl).toBe("true");
    const hooks = await createGlabCommentExistingMrNoteHooks(
      {
        run: async (command, args) => ({
          exitCode: 0,
          stdout:
            command === "git"
              ? args[0] !== "remote"
                ? ""
                : args[1] === "get-url"
                  ? "https://gitlab.com/group/project.git\n"
                  : "origin\n"
              : JSON.stringify({ id: 7 }),
        }),
      },
      root,
    );
    expect(
      await hooks.create({
        binding: { host: "gitlab.com", projectId: 42, mergeRequestIid: 13 },
        body: "fixture note",
      }),
    ).toEqual({ status: "ok", noteId: "42" });
    expect((await new ExecInitCommandRunner().run("glab", ["auth", "status"], root)).exitCode).toBe(
      0,
    );
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual({
      model: false,
      other: false,
      glab: true,
      gitlab: true,
    });
  });
});
