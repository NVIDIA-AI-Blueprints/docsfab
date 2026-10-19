// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOCSFAB_PROJECT_CONFIG_FILE,
  allocateDocsFabPrivateRoots,
  assertDocsFabProjectConfig,
  parseDocsFabInitArguments,
  planHostDerivedProjectConfig,
  resolveDocsFabPrivateRoots,
  runDocsFabInit,
  serializeDocsFabInitPlan,
  type DocsFabInitDependencies,
  type DocsFabInitMutationBoundary,
  type DocsFabInitPrompt,
} from "../src/init.js";
import type { ReadOnlyCommandResult } from "../src/delivery/index.js";
import { formatDoctorReadiness, type DoctorReadinessResult } from "../src/doctor-readiness.js";
import {
  formatDocsFabInitPlan,
  formatInitFailure,
  formatInitResult,
  serializeInitFailure,
} from "../src/init/render.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { sanitizeDisplayText, toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import {
  ConfigurationRootNotCanonicalError,
  allocatePinnedPrivateRoots,
  captureDirectoryPin,
  configurationRootDisplayPath,
  inspectProcessBirth,
  leaseProcessIsGoneOrReused,
  readLockOwnerSnapshot,
  reclaimStaleLockIfSafe,
  recoverPreparedLockClaims,
  requireProcessBirthIdentity,
} from "../src/init/storage.js";
import { formatCheckGrid, formatSectionHeader } from "../src/operator/cli-format.js";
import { temporaryRoots } from "./helpers/temp.js";

const SECRET = "nvapi-this-credential-must-stay-host-private";
const GLAB_SECRET = "glpat-this-credential-must-stay-host-private";
const temporaryDirectories = temporaryRoots();
/** Real git/glab init flows need headroom under parallel Vitest workers. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;

interface Fixture {
  root: string;
  repository: string;
  stateHome: string;
  home: string;
  configRoot: string;
}

class FakeCommands {
  readonly calls: Array<{
    command: "git" | "glab";
    args: readonly string[];
    cwd: string;
    environment?: NodeJS.ProcessEnv;
  }> = [];
  remotes = ["origin"];
  remoteUrls = new Map<string, string[]>([
    ["origin", ["ssh://git@gitlab.example.test:2222/group/docs.git"]],
  ]);
  pushRemoteUrls = new Map<string, string[]>();
  authenticated = true;
  authStderr = "";
  tokenPresent = false;
  projectApi = true;
  localDefaultBranch = "origin/main";
  currentBranch = "work";
  trackingRemote?: string;
  pushDefault?: string;
  headRevision = "0123456789abcdef0123456789abcdef01234567";
  objectFormat = "sha1";
  userResponse: unknown = { id: 7, username: "maintainer", token: GLAB_SECRET };
  projectResponse: unknown = {
    id: 42,
    path_with_namespace: "group/docs",
    default_branch: "main",
    permissions: { project_access: { access_level: 30 }, group_access: null },
    token: GLAB_SECRET,
  };

  constructor(private readonly repository: string) {}

  async run(
    command: "git" | "glab",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<ReadOnlyCommandResult> {
    this.calls.push({ command, args: [...args], cwd, environment: options?.env });
    const key = (command === "git" ? stripSafeGit(args) : args).join(" ");
    if (command === "git") {
      if (key === "rev-parse --show-toplevel") return ok(`${this.repository}\n`);
      if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (key === "rev-parse --verify HEAD") return ok(`${this.headRevision}\n`);
      if (key === "rev-parse --show-object-format") return ok(`${this.objectFormat}\n`);
      if (key === "remote") return ok(`${this.remotes.join("\n")}\n`);
      const remoteUrl = /^remote get-url (?:--push )?--all (.+)$/u.exec(key)?.[1];
      if (remoteUrl && this.remotes.includes(remoteUrl)) {
        const urls = key.includes("--push")
          ? (this.pushRemoteUrls.get(remoteUrl) ?? this.remoteUrls.get(remoteUrl) ?? [])
          : (this.remoteUrls.get(remoteUrl) ?? []);
        return ok(`${urls.join("\n")}\n`);
      }
      if (key === "symbolic-ref --quiet --short HEAD")
        return this.currentBranch ? ok(`${this.currentBranch}\n`) : failed();
      if (key === `config --get branch.${this.currentBranch}.remote`) {
        return this.trackingRemote ? ok(`${this.trackingRemote}\n`) : failed();
      }
      if (key === "config --get remote.pushDefault")
        return this.pushDefault ? ok(`${this.pushDefault}\n`) : failed();
      if (key.startsWith("symbolic-ref --quiet --short refs/remotes/")) {
        return this.localDefaultBranch ? ok(`${this.localDefaultBranch}\n`) : failed();
      }
      return failed();
    }
    if (key === "version") return ok("glab 2\n");
    if (key === "auth status --hostname gitlab.example.test") {
      return this.authenticated ? ok("") : { exitCode: 1, stdout: "", stderr: this.authStderr };
    }
    if (key === "config get token --host gitlab.example.test") {
      return this.tokenPresent ? ok("") : failed();
    }
    if (key === "api --hostname gitlab.example.test user") {
      return this.authenticated ? json(this.userResponse) : failed();
    }
    if (key === "api --hostname gitlab.example.test projects/group%2Fdocs") {
      return this.authenticated && this.projectApi ? json(this.projectResponse) : failed();
    }
    return failed();
  }
}

class FakePrompt implements DocsFabInitPrompt {
  chooseCalls = 0;
  confirmCalls = 0;

  constructor(
    private readonly selected: string,
    private readonly approved: boolean,
  ) {}

  async chooseRemote(candidates: readonly string[]): Promise<string> {
    this.chooseCalls += 1;
    expect(candidates).toContain(this.selected);
    return this.selected;
  }

  async confirm(): Promise<boolean> {
    this.confirmCalls += 1;
    return this.approved;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("guided DocsFab initialization", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("lists every repository file in the approved preview and actual Git status", async () => {
    const fixture = await createFixture();
    runLocalGit(fixture.repository, ["init", "-q"]);
    await writeFile(join(fixture.repository, "seed.md"), "baseline\n");
    runLocalGit(fixture.repository, ["add", "seed.md"]);
    runLocalGit(fixture.repository, [
      "-c",
      "user.name=DocsFab Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "baseline",
    ]);
    const logs: string[] = [];
    const dependencies = basicDependencies(fixture, undefined, logs);
    const plan = await runDocsFabInit(["--non-interactive"], dependencies);
    expect(plan.gitignore).toMatchObject({
      path: ".gitignore",
      action: "create",
      missingEntries: [".docsfab/", ".docsfab-init.*"],
    });
    expect(plan.changedPaths).toEqual([".docsfab.json", ".gitignore"]);
    expect(logs[0]).toContain(".gitignore: create");
    expect(logs[0]).toContain(".docsfab/");
    expect(logs[0]).toContain(".docsfab-init.*");
    expect(
      runLocalGit(fixture.repository, ["status", "--porcelain", "--untracked-files=all"]),
    ).toBe("");

    logs.length = 0;
    await runDocsFabInit(approvedArguments(plan), dependencies);
    const resultLine = logs.at(-1)!;
    expect(resultLine).toContain("Changed files: .docsfab.json, .gitignore");
    const changed = runLocalGit(fixture.repository, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(3))
      .sort();
    expect(changed).toEqual([...plan.changedPaths].sort());
  });

  it("previews a tracked partial .gitignore and matches the applied Git status", async () => {
    const fixture = await createFixture();
    runLocalGit(fixture.repository, ["init", "-q"]);
    await writeFile(join(fixture.repository, ".gitignore"), "node_modules/\n.docsfab/\n");
    runLocalGit(fixture.repository, ["add", ".gitignore"]);
    runLocalGit(fixture.repository, [
      "-c",
      "user.name=DocsFab Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "baseline",
    ]);
    const dependencies = basicDependencies(fixture);
    const plan = await runDocsFabInit(["--non-interactive"], dependencies);
    expect(plan.gitignore).toMatchObject({
      action: "append",
      missingEntries: [".docsfab-init.*"],
    });
    expect(plan.changedPaths).toEqual([".docsfab.json", ".gitignore"]);
    await runDocsFabInit(approvedArguments(plan), dependencies);
    expect(
      runLocalGit(fixture.repository, ["status", "--porcelain", "--untracked-files=all"]),
    ).toBe(" M .gitignore\n?? .docsfab.json\n");
    expect(await readFile(join(fixture.repository, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.docsfab/\n.docsfab-init.*\n",
    );
  });

  it("leaves a complete .gitignore byte-stable and omits it from the preview", async () => {
    const fixture = await createFixture();
    const path = join(fixture.repository, ".gitignore");
    const original = "node_modules/\n.docsfab/\n.docsfab-init.*\n";
    await writeFile(path, original);
    const before = await stat(path);
    const dependencies = basicDependencies(fixture);
    const plan = await runDocsFabInit(["--non-interactive"], dependencies);
    expect(plan.gitignore).toMatchObject({ action: "none", missingEntries: [] });
    expect(plan.changedPaths).toEqual([".docsfab.json"]);
    await runDocsFabInit(approvedArguments(plan), dependencies);
    const after = await stat(path);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("reports a bounded optional .gitignore skip without hiding its bytes or remediation", async () => {
    const fixture = await createFixture();
    const path = join(fixture.repository, ".gitignore");
    const original = "#".repeat(4097);
    await writeFile(path, original);
    const logs: string[] = [];
    const dependencies = basicDependencies(fixture, undefined, logs);
    dependencies.environment = {
      ...dependencies.environment,
      DOCSFAB_INIT_GITIGNORE_MAX_BYTES: "4096",
    };
    const plan = await runDocsFabInit(["--non-interactive", "--json"], dependencies);
    expect(plan.gitignore).toMatchObject({
      action: "skip",
      reason: "too-large",
      limitExceeded: {
        code: "init-gitignore-max-bytes-bound",
        observedBytes: 4097,
        configuredBytes: 4096,
        scope: "selected repository .gitignore",
      },
    });
    expect(plan.changedPaths).toEqual([".docsfab.json"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ gitignore: plan.gitignore });
    logs.length = 0;
    await runDocsFabInit(approvedArguments(plan), dependencies);
    expect(logs.at(-1)).toContain("init-gitignore-max-bytes-bound: observed 4097 bytes");
    expect(logs.at(-1)).toContain("raise DOCSFAB_INIT_GITIGNORE_MAX_BYTES");
    expect(await readFile(path, "utf8")).toBe(original);

    await writeFile(path, "#".repeat(4096));
    logs.length = 0;
    const projected = await runDocsFabInit(["--non-interactive", "--json"], dependencies);
    expect(projected.gitignore).toMatchObject({
      action: "skip",
      reason: "too-large",
      missingEntries: [".docsfab/", ".docsfab-init.*"],
      limitExceeded: { observedBytes: 4096 + Buffer.byteLength("\n.docsfab/\n.docsfab-init.*\n") },
    });
    expect(JSON.parse(logs[0]!)).toMatchObject({ gitignore: projected.gitignore });
    logs.length = 0;
    const human = await runDocsFabInit(["--non-interactive"], dependencies);
    expect(human.sha256).toBe(projected.sha256);
    expect(logs[0]).toContain("missing entries: .docsfab/, .docsfab-init.*");
    expect(await readFile(path, "utf8")).toBe("#".repeat(4096));
  });

  it("binds JSON preview and digest to an ignore-only change on a current project", async () => {
    const fixture = await createFixture();
    const logs: string[] = [];
    const dependencies = basicDependencies(fixture, undefined, logs);
    const first = await runDocsFabInit(["--non-interactive"], dependencies);
    await runDocsFabInit(approvedArguments(first), dependencies);
    await unlink(join(fixture.repository, ".gitignore"));
    logs.length = 0;
    const preview = await runDocsFabInit(["--non-interactive", "--json"], dependencies);
    expect(preview.change).toBe("none");
    expect(preview.changedPaths).toEqual([".gitignore"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      changedPaths: [".gitignore"],
      gitignore: { action: "create", missingEntries: [".docsfab/", ".docsfab-init.*"] },
    });
    logs.length = 0;
    await runDocsFabInit([...approvedArguments(preview), "--json"], dependencies);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      mutation: "none",
      changedPaths: [".gitignore"],
      gitignore: { status: "created" },
    });
  });

  it("refuses an approval whose ignore preimage changed before apply", async () => {
    const fixture = await createFixture();
    const path = join(fixture.repository, ".gitignore");
    await writeFile(path, "node_modules/\n");
    const dependencies = basicDependencies(fixture);
    const plan = await runDocsFabInit(["--non-interactive"], dependencies);
    await writeFile(path, "build-output/\n");
    const fresh = await runDocsFabInit(["--non-interactive"], dependencies);
    expect(fresh.sha256).not.toBe(plan.sha256);
    await expect(runDocsFabInit(approvedArguments(plan), dependencies)).rejects.toThrow(
      "does not match the fresh preview",
    );
    await expect(
      readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path, "utf8")).toBe("build-output/\n");
  });

  it("reports a partial apply when ignore changes after config publication", async () => {
    const fixture = await createFixture();
    const logs: string[] = [];
    const dependencies = basicDependencies(fixture, undefined, logs);
    const plan = await runDocsFabInit(["--non-interactive"], dependencies);
    dependencies.mutationHooks = {
      afterConfigPublished: async () => {
        await writeFile(join(fixture.repository, ".gitignore"), "concurrent/\n");
      },
    };
    logs.length = 0;
    await runDocsFabInit(approvedArguments(plan), dependencies);
    expect(logs.at(-1)).toContain("Changed files: .docsfab.json");
    expect(logs.at(-1)).toContain(".gitignore changed after approval");
    expect(await readFile(join(fixture.repository, ".gitignore"), "utf8")).toBe("concurrent/\n");
  });

  it("refuses ignore drift at the config publication boundary without changing the project file", async () => {
    const fixture = await createFixture();
    const dependencies = basicDependencies(fixture);
    const plan = await runDocsFabInit(["--non-interactive"], dependencies);
    dependencies.mutationHooks = {
      atConfigPublication: async () => {
        await writeFile(join(fixture.repository, ".gitignore"), "concurrent/\n");
      },
    };
    await expect(runDocsFabInit(approvedArguments(plan), dependencies)).rejects.toThrow(
      ".gitignore changed after approval",
    );
    await expect(
      readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(fixture.repository, ".gitignore"), "utf8")).toBe("concurrent/\n");
  });

  it("identifies the unsupported GitLab remote refusal without inventing one", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands(fixture.repository);
    commands.remotes = [];
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands)),
    ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });
    await expect(
      runDocsFabInit(
        ["--non-interactive", "--remote", "origin"],
        basicDependencies(fixture, commands),
      ),
    ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });
    try {
      await runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands));
    } catch (error) {
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("no-supported-gitlab-remote");
      expect(envelope.failure.class).toBe("operator-input");
      expect(envelope.message).toContain("No supported uncredentialed GitLab remote");
      expect(envelope.message).not.toContain("Add one and retry");
      expect(envelope.nextAction).not.toContain("Add one and retry");
      expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
      expect(formatInitFailure(error)).toContain("code: no-supported-gitlab-remote");
      expect(formatInitFailure(error)).toContain("Docs: docs/troubleshooting.md");
      expect(formatInitFailure(error)).not.toContain("Add one and retry");
      expect(JSON.parse(serializeInitFailure(error))).toMatchObject({
        code: "no-supported-gitlab-remote",
        failure: { class: "operator-input" },
      });
    }

    commands.remotes = ["origin"];
    await expect(
      runDocsFabInit(
        ["--non-interactive", "--remote", "missing"],
        basicDependencies(fixture, commands),
      ),
    ).rejects.toThrow("canonical Git remote is not one supported uncredentialed GitLab remote");
    expect(
      (await runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands)))
        .projectConfig.gitlab.remote,
    ).toBe("origin");

    commands.remoteUrls.set("origin", ["https://secret@gitlab.example.test/group/docs.git"]);
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands)),
    ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });

    await writeFile(
      join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE),
      JSON.stringify(projectConfig("origin", "main")),
    );
    commands.remotes = [];
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands)),
    ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });
  });

  it("previews discovery without filesystem mutation or credential/path disclosure", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands(fixture.repository);
    const logs: string[] = [];
    const before = await snapshot(fixture.root);
    const plan = await runDocsFabInit(["--non-interactive"], {
      cwd: fixture.repository,
      commands,
      environment: environment(fixture),
      homeDirectory: fixture.home,
      inspectProvider: async () => ({ status: "ready", profileStatus: "unknown" }),
      checkDoctor: async () => true,
      log: (message) => logs.push(message),
    });

    expect(plan).toMatchObject({
      change: "create",
      gitlabAuthentication: "configured",
      gitlabProject: "ready",
      providerConfiguration: "ready",
      doctor: "ready",
      projectConfig: {
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      },
    });
    expect(plan.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await snapshot(fixture.root)).toEqual(before);
    const output = logs.join("\n");
    expect(output).toContain("same repository context");
    expect(output).toContain("same --repo and --remote selections");
    expect(output).toContain(`--non-interactive --apply --approve-plan-sha256 ${plan.sha256}`);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(GLAB_SECRET);
    expect(output).not.toContain(fixture.root);
    expect(output).not.toContain("maintainer");
    expect(output).not.toContain("Doctor readiness:");
    expect(
      commands.calls
        .filter((call) => call.command === "glab")
        .every(
          (call) =>
            call.environment?.MODEL_API_KEY === undefined &&
            call.environment?.GLAB_TOKEN === GLAB_SECRET,
        ),
    ).toBe(true);
    expect(
      commands.calls
        .filter((call) => call.command === "git")
        .every(
          (call) =>
            call.environment?.HOME === "/dev/null" && call.environment?.GLAB_TOKEN === undefined,
        ),
    ).toBe(true);
  });

  it("derives a conservative host-bound project config without documentation roots", async () => {
    const fixture = await createFixture();
    const derived = await planHostDerivedProjectConfig({
      repositoryPath: fixture.repository,
      commands: new FakeCommands(fixture.repository),
      environment: environment(fixture),
    });
    expect(derived.projectConfig).toEqual({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    });
    expect("documentationRoots" in derived.projectConfig).toBe(false);
    expect(derived.repositoryBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
    const replay = await planHostDerivedProjectConfig({
      repositoryPath: fixture.repository,
      commands: new FakeCommands(fixture.repository),
      environment: environment(fixture),
    });
    expect(replay.repositoryBindingSha256).toBe(derived.repositoryBindingSha256);
  });

  it("applies one minimal config and owner-private roots, then repeats idempotently", async () => {
    const fixture = await createFixture();
    const dependencies = {
      cwd: fixture.repository,
      commands: new FakeCommands(fixture.repository),
      environment: environment(fixture),
      homeDirectory: fixture.home,
      inspectProvider: async () => ({
        status: "ready" as const,
        profileStatus: "current" as const,
      }),
      checkDoctor: async () => true,
      log: () => undefined,
    };
    const firstPreview = await runDocsFabInit(["--non-interactive"], dependencies);
    const first = await runDocsFabInit(
      ["--non-interactive", "--apply", "--approve-plan-sha256", firstPreview.sha256],
      dependencies,
    );
    const configPath = join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE);
    const bytes = await readFile(configPath, "utf8");
    expect(JSON.parse(bytes)).toEqual(first.projectConfig);
    expect(bytes).not.toContain(SECRET);
    expect(bytes).not.toContain(GLAB_SECRET);
    expect(bytes).not.toContain(fixture.root);
    expect(bytes).not.toContain("maintainer");
    expect(Object.keys(JSON.parse(bytes) as object)).toHaveLength(4);

    const roots = resolveDocsFabPrivateRoots(
      await realpath(fixture.repository),
      environment(fixture),
      fixture.home,
    );
    for (const path of Object.values(roots)) {
      const metadata = await lstat(path);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.mode & 0o077).toBe(0);
    }

    const equivalentBytes = `${JSON.stringify(first.projectConfig, null, 2)}\n`;
    await writeFile(configPath, equivalentBytes);
    const firstStat = await stat(configPath);
    const secondPreview = await runDocsFabInit(["--non-interactive"], dependencies);
    const second = await runDocsFabInit(
      ["--non-interactive", "--apply", "--approve-plan-sha256", secondPreview.sha256],
      dependencies,
    );
    const secondStat = await stat(configPath);
    expect(second.change).toBe("none");
    expect(await readFile(configPath, "utf8")).toBe(equivalentBytes);
    expect(secondStat.ino).toBe(firstStat.ino);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("preserves existing documentationRoots on an idempotent init plan", async () => {
    const fixture = await createFixture();
    const dependencies = basicDependencies(fixture);
    const firstPreview = await runDocsFabInit(["--non-interactive"], dependencies);
    await runDocsFabInit(approvedArguments(firstPreview), dependencies);
    const configPath = join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE);
    const withRoots = {
      ...firstPreview.projectConfig,
      documentationRoots: ["docs"],
    };
    await writeFile(configPath, `${JSON.stringify(withRoots, null, 2)}\n`, { mode: 0o600 });
    const preview = await runDocsFabInit(["--non-interactive"], dependencies);
    expect(preview.change).toBe("none");
    expect(preview.projectConfig).toEqual(withRoots);
  });

  it("refuses an existing project file that still carries the deleted execution key", async () => {
    const fixture = await createFixture();
    const dependencies = basicDependencies(fixture);
    const firstPreview = await runDocsFabInit(["--non-interactive"], dependencies);
    await runDocsFabInit(approvedArguments(firstPreview), dependencies);
    const configPath = join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE);
    const withExecution = {
      ...firstPreview.projectConfig,
      execution: { level: "production" },
    };
    await writeFile(configPath, `${JSON.stringify(withExecution, null, 2)}\n`, { mode: 0o600 });

    await expect(runDocsFabInit(["--non-interactive"], dependencies)).rejects.toThrow(
      "Existing DocsFab project configuration has a top-level key DocsFab does not read; keep only schemaVersion, gitlab, provider, storage, and documentationRoots in .docsfab.json, then retry. No project file was changed.",
    );
  });

  it("emits one credential-free JSON result for non-interactive apply", async () => {
    const fixture = await createFixture();
    const logs: string[] = [];
    const dependencies: DocsFabInitDependencies = {
      cwd: fixture.repository,
      commands: new FakeCommands(fixture.repository),
      environment: environment(fixture),
      homeDirectory: fixture.home,
      inspectProvider: async () => ({ status: "ready", profileStatus: "current" }),
      checkDoctor: async () => true,
      log: (message) => logs.push(message),
    };
    const preview = await runDocsFabInit(["--non-interactive", "--json"], dependencies);
    logs.length = 0;
    await runDocsFabInit(
      ["--non-interactive", "--apply", "--approve-plan-sha256", preview.sha256, "--json"],
      dependencies,
    );
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      kind: "docsfab-init-plan",
      sha256: preview.sha256,
    });
    const result = JSON.parse(logs[1]!) as Record<string, unknown>;
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-init-result",
      status: "ready",
      mutation: "applied",
      changedPaths: [".docsfab.json", ".gitignore"],
      nextActions: ["commit-docsfab-json"],
      gitignore: { status: "created", added: [".docsfab/", ".docsfab-init.*"] },
    });
    expect(logs[1]).toContain("commit-docsfab-json");
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(GLAB_SECRET);
    expect(logs.join("\n")).not.toContain(fixture.root);
  });

  it("prints a commit-.docsfab.json next step after successful apply", async () => {
    const fixture = await createFixture();
    const logs: string[] = [];
    const dependencies = basicDependencies(fixture, new FakeCommands(fixture.repository), logs);
    const preview = await runDocsFabInit(["--non-interactive"], dependencies);
    logs.length = 0;
    await runDocsFabInit(approvedArguments(preview), dependencies);
    const output = logs.join("\n");
    expect(output).toContain("Commit `.docsfab.json`");
    expect(output).toContain("do not add the project file to `.gitignore`");
    expect(output).toContain("Private `.gitignore` fragment");
    expect(await readFile(join(fixture.repository, ".gitignore"), "utf8")).toBe(
      ".docsfab/\n.docsfab-init.*\n",
    );
    expect(await readFile(join(fixture.repository, ".gitignore"), "utf8")).not.toMatch(
      /^\s*\.docsfab\.json\s*$/mu,
    );
  });

  it("asks only for an ambiguous remote and final approval in interactive mode", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands(fixture.repository);
    commands.remotes = ["origin", "upstream"];
    commands.remoteUrls.set("upstream", ["ssh://git@gitlab.example.test:2222/group/docs.git"]);
    const prompt = new FakePrompt("upstream", true);
    const plan = await runDocsFabInit([], {
      cwd: fixture.repository,
      commands,
      environment: environment(fixture),
      homeDirectory: fixture.home,
      interactive: true,
      prompt,
      inspectProvider: async () => ({ status: "ready", profileStatus: "unknown" }),
      checkDoctor: async () => true,
      log: () => undefined,
    });

    expect(plan.projectConfig.gitlab.remote).toBe("upstream");
    expect(prompt.chooseCalls).toBe(1);
    expect(prompt.confirmCalls).toBe(1);
    expect(await readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8")).toContain(
      "upstream",
    );
  });

  it("keeps a declined interactive preview mutation-free", async () => {
    const fixture = await createFixture();
    const prompt = new FakePrompt("origin", false);
    const before = await snapshot(fixture.root);
    await runDocsFabInit([], {
      cwd: fixture.repository,
      commands: new FakeCommands(fixture.repository),
      environment: environment(fixture),
      homeDirectory: fixture.home,
      interactive: true,
      prompt,
      inspectProvider: async () => ({ status: "partial", profileStatus: "unavailable" }),
      checkDoctor: async () => {
        throw new Error("must not run");
      },
      log: () => undefined,
    });
    expect(prompt.chooseCalls).toBe(0);
    expect(prompt.confirmCalls).toBe(1);
    expect(await snapshot(fixture.root)).toEqual(before);
  });

  it("uses local remote HEAD when glab is unavailable and gives credential-safe next actions", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands(fixture.repository);
    commands.authenticated = false;
    const logs: string[] = [];
    const plan = await runDocsFabInit(["--non-interactive"], {
      cwd: fixture.repository,
      commands,
      environment: environment(fixture),
      homeDirectory: fixture.home,
      inspectProvider: async () => ({ status: "missing", profileStatus: "unavailable" }),
      checkDoctor: async () => {
        throw new Error("must not run");
      },
      log: (message) => logs.push(message),
    });
    expect(plan).toMatchObject({
      gitlabAuthentication: "missing",
      providerConfiguration: "missing",
      doctor: "profile-diagnostics-required",
      nextActions: ["glab-auth-login", "profile-inspect"],
      projectConfig: { gitlab: { defaultBranch: "main" } },
    });
    expect(logs.join("\n")).toContain("glab auth login");
    expect(logs.join("\n")).toContain("docsfab profile inspect");
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("routes partial profiles through the existing inspection and approval commands", async () => {
    const fixture = await createFixture();
    const logs: string[] = [];
    const plan = await runDocsFabInit(["--non-interactive"], {
      cwd: fixture.repository,
      commands: new FakeCommands(fixture.repository),
      environment: environment(fixture),
      homeDirectory: fixture.home,
      inspectProvider: async () => ({ status: "partial", profileStatus: "unavailable" }),
      checkDoctor: async () => {
        throw new Error("must not run");
      },
      log: (message) => logs.push(message),
    });
    expect(plan.nextActions).toEqual(["profile-inspect"]);
    expect(logs.join("\n")).toContain("docsfab profile inspect");
    expect(logs.join("\n")).toContain("docsfab profile approve");
    expect(logs.join("\n")).not.toContain("MODEL_CONTEXT_WINDOW");
  });

  it("refuses unsafe existing config and insecure or symlinked private roots", async () => {
    const fixture = await createFixture();
    const configTarget = join(fixture.root, "outside.json");
    await writeFile(configTarget, "{}\n");
    await symlink(configTarget, join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE));
    await expect(
      runDocsFabInit(["--non-interactive"], {
        cwd: fixture.repository,
        commands: new FakeCommands(fixture.repository),
        environment: environment(fixture),
        homeDirectory: fixture.home,
        inspectProvider: async () => ({ status: "ready", profileStatus: "unknown" }),
        checkDoctor: async () => true,
        log: () => undefined,
      }),
    ).rejects.toThrow("unsafe or unreadable");
    expect(await readFile(configTarget, "utf8")).toBe("{}\n");

    const roots = resolveDocsFabPrivateRoots(
      await realpath(fixture.repository),
      environment(fixture),
      fixture.home,
    );
    await mkdir(resolve(fixture.stateHome, "docsfab"), { mode: 0o700 });
    await chmod(resolve(fixture.stateHome, "docsfab"), 0o755);
    await expect(allocateDocsFabPrivateRoots(roots)).rejects.toThrow("mode-0700");
  });

  it("rejects credential-shaped remote/default identities at discovery, decode, and output boundaries", async () => {
    const fixture = await createFixture();
    const remoteCommands = new FakeCommands(fixture.repository);
    remoteCommands.remotes = [GLAB_SECRET];
    remoteCommands.remoteUrls = new Map([
      [GLAB_SECRET, ["ssh://git@gitlab.example.test/group/docs.git"]],
    ]);
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, remoteCommands)),
    ).rejects.toThrow("remote names");

    const branchCommands = new FakeCommands(fixture.repository);
    branchCommands.projectResponse = {
      id: 42,
      path_with_namespace: "group/docs",
      default_branch: GLAB_SECRET,
      permissions: { project_access: { access_level: 30 }, group_access: null },
    };
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, branchCommands)),
    ).rejects.toThrow("unsafe default branch");

    expect(() => assertDocsFabProjectConfig(projectConfig(GLAB_SECRET, "main"))).toThrow("invalid");
    const valid = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture));
    // Serialization scans every field even when a caller bypasses TypeScript.
    expect(() =>
      serializeDocsFabInitPlan({ ...valid, profileStatus: GLAB_SECRET } as never),
    ).toThrow("credential material");
  });

  it("binds GitLab readiness to an exact identity, project, and minimum access", async () => {
    const fixture = await createFixture();
    const ready = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture));
    expect(ready.gitlabAuthentication).toBe("configured");
    expect(ready.gitlabProject).toBe("ready");
    expect(ready.gitlabBindingSha256).toMatch(/^[a-f0-9]{64}$/u);

    for (const mutate of [
      (commands: FakeCommands) => {
        commands.projectApi = false;
      },
      (commands: FakeCommands) => {
        commands.userResponse = { username: "maintainer" };
      },
      (commands: FakeCommands) => {
        commands.projectResponse = {
          id: 42,
          path_with_namespace: "other/docs",
          default_branch: "main",
          permissions: { project_access: { access_level: 30 }, group_access: null },
        };
      },
      (commands: FakeCommands) => {
        commands.projectResponse = {
          id: 42,
          path_with_namespace: "group/docs",
          default_branch: "main",
          permissions: { project_access: { access_level: 20 }, group_access: null },
        };
      },
    ]) {
      const commands = new FakeCommands(fixture.repository);
      mutate(commands);
      const plan = await runDocsFabInit(
        ["--non-interactive"],
        basicDependencies(fixture, commands),
      );
      expect(plan.gitlabAuthentication).toBe("configured");
      expect(plan.gitlabProject).toBe("unavailable");
      expect(plan.gitlabBindingSha256).toBeNull();
      expect(plan.nextActions).toContain("verify-gitlab-project-access");
    }

    const unauthenticated = new FakeCommands(fixture.repository);
    unauthenticated.authenticated = false;
    const authPlan = await runDocsFabInit(
      ["--non-interactive"],
      basicDependencies(fixture, unauthenticated),
    );
    expect(authPlan.gitlabAuthentication).toBe("missing");
    expect(authPlan.gitlabProject).toBe("unavailable");
    expect(authPlan.nextActions).toContain("glab-auth-login");

    const unreachable = new FakeCommands(fixture.repository);
    unreachable.authenticated = false;
    unreachable.tokenPresent = true;
    unreachable.authStderr =
      'Error using API: Get "https://gitlab.example.test/api/v4/user": connection reset by peer';
    const unreachablePlan = await runDocsFabInit(
      ["--non-interactive"],
      basicDependencies(fixture, unreachable),
    );
    expect(unreachablePlan.gitlabAuthentication).toBe("unreachable");
    expect(unreachablePlan.nextActions).toContain("retry-gitlab-api");
    expect(unreachablePlan.nextActions).not.toContain("glab-auth-login");
  });

  it("selects tracking remote, then pushDefault, then an unambiguous candidate", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands(fixture.repository);
    commands.remotes = ["origin", "upstream"];
    commands.remoteUrls.set("upstream", ["ssh://git@gitlab.example.test:2222/group/docs.git"]);
    commands.trackingRemote = "upstream";
    let plan = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands));
    expect(plan.projectConfig.gitlab.remote).toBe("upstream");

    commands.trackingRemote = undefined;
    commands.pushDefault = "origin";
    plan = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands));
    expect(plan.projectConfig.gitlab.remote).toBe("origin");

    commands.pushDefault = undefined;
    commands.remotes = ["origin"];
    plan = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture, commands));
    expect(plan.projectConfig.gitlab.remote).toBe("origin");
  });

  it("fails closed for malicious preferences and multiple fetch URLs", async () => {
    const fixture = await createFixture();
    const malicious = new FakeCommands(fixture.repository);
    malicious.trackingRemote = GLAB_SECRET;
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, malicious)),
    ).rejects.toThrow("tracking remote");

    const multiple = new FakeCommands(fixture.repository);
    multiple.trackingRemote = "origin";
    multiple.remoteUrls.set("origin", [
      "ssh://git@gitlab.example.test/group/docs.git",
      "ssh://git@gitlab.example.test/group/other.git",
    ]);
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, multiple)),
    ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });

    const split = new FakeCommands(fixture.repository);
    split.trackingRemote = "origin";
    split.pushRemoteUrls.set("origin", ["ssh://git@gitlab.example.test/group/other.git"]);
    await expect(
      runDocsFabInit(["--non-interactive"], basicDependencies(fixture, split)),
    ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });
  });

  it("keeps preview succeeding when host diagnose is ready and private-state is blocked", async () => {
    const fixture = await createFixture();
    const logs: string[] = [];
    const plan = await runDocsFabInit(["--non-interactive"], {
      ...basicDependencies(fixture, undefined, logs),
      inspectReadiness: async () => [
        { area: "installation", status: "ready" },
        { area: "configuration", status: "ready" },
        { area: "private-state", status: "blocked" },
      ],
    });
    expect(plan.doctor).toBe("ready");
    expect(JSON.parse(serializeDocsFabInitPlan(plan)).doctor).toBe("ready");
    const output = logs.join("\n");
    expect(output).toContain("Host profile diagnose: ready (not repository doctor)");
    expect(output).not.toContain("Host diagnose: ready");
    expect(output).not.toContain("Doctor readiness:");
    expect(output).not.toContain("DocsFab readiness: ready");
    expect(output).toMatch(/private-state:.*blocked/u);
    expect(output).toContain("CHECKS");
  });

  it("requires the exact preview digest before any prompt-free mutation", async () => {
    const fixture = await createFixture();
    const logs: string[] = [];
    const dependencies = basicDependencies(fixture, undefined, logs);
    const before = await snapshot(fixture.root);
    await expect(
      runDocsFabInit(
        ["--non-interactive", "--apply", "--approve-plan-sha256", "f".repeat(64)],
        dependencies,
      ),
    ).rejects.toThrow("does not match the fresh preview");
    expect(logs[0]).toContain("DocsFab initialization preview");
    expect(await snapshot(fixture.root)).toEqual(before);
  });

  it("rejects cross-repository and exact-config-preimage approval replay", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstPlan = await runDocsFabInit(["--non-interactive"], basicDependencies(first));
    const secondPlan = await runDocsFabInit(["--non-interactive"], basicDependencies(second));
    expect(firstPlan.repositoryBindingSha256).not.toBe(secondPlan.repositoryBindingSha256);
    expect(firstPlan.configPreimageSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      runDocsFabInit(approvedArguments(firstPlan), basicDependencies(second)),
    ).rejects.toThrow("does not match the fresh preview");
    await expect(
      readFile(join(second.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const initial = await runDocsFabInit(["--non-interactive"], basicDependencies(first));
    await runDocsFabInit(approvedArguments(initial), basicDependencies(first));
    const commands = new FakeCommands(first.repository);
    commands.projectResponse = {
      id: 42,
      path_with_namespace: "group/docs",
      default_branch: "trunk",
      permissions: { project_access: { access_level: 30 }, group_access: null },
    };
    const update = await runDocsFabInit(["--non-interactive"], basicDependencies(first, commands));
    const configPath = join(first.repository, DOCSFAB_PROJECT_CONFIG_FILE);
    await chmod(configPath, 0o600);
    await expect(
      runDocsFabInit(approvedArguments(update), basicDependencies(first, commands)),
    ).rejects.toThrow("does not match the fresh preview");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    const symlinkFixture = await createFixture();
    const absentPlan = await runDocsFabInit(
      ["--non-interactive"],
      basicDependencies(symlinkFixture),
    );
    const target = join(symlinkFixture.root, "outside-config.json");
    await writeFile(target, `${JSON.stringify(absentPlan.projectConfig)}\n`);
    await symlink(target, join(symlinkFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE));
    await expect(
      runDocsFabInit(approvedArguments(absentPlan), basicDependencies(symlinkFixture)),
    ).rejects.toThrow("unsafe or unreadable");
  });

  it("preserves concurrent create and update values at the final publication boundary", async () => {
    const createFixtureValue = await createFixture();
    const createDependencies = basicDependencies(createFixtureValue);
    const createPlan = await runDocsFabInit(["--non-interactive"], createDependencies);
    const concurrentCreate = projectConfig("origin", "concurrent");
    createDependencies.mutationHooks = {
      atConfigPublication: async () => {
        await writeFile(
          join(createFixtureValue.repository, DOCSFAB_PROJECT_CONFIG_FILE),
          `${JSON.stringify(concurrentCreate)}\n`,
        );
      },
    };
    await expect(runDocsFabInit(approvedArguments(createPlan), createDependencies)).rejects.toThrow(
      "changed after preview",
    );
    expect(
      JSON.parse(
        await readFile(join(createFixtureValue.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8"),
      ),
    ).toEqual(concurrentCreate);

    const updateFixture = await createFixture();
    const initialDependencies = basicDependencies(updateFixture);
    const initialPlan = await runDocsFabInit(["--non-interactive"], initialDependencies);
    await runDocsFabInit(approvedArguments(initialPlan), initialDependencies);
    const updateCommands = new FakeCommands(updateFixture.repository);
    updateCommands.projectResponse = {
      id: 42,
      path_with_namespace: "group/docs",
      default_branch: "trunk",
      permissions: { project_access: { access_level: 30 }, group_access: null },
    };
    const updateDependencies = basicDependencies(updateFixture, updateCommands);
    const updatePlan = await runDocsFabInit(["--non-interactive"], updateDependencies);
    expect(updatePlan.change).toBe("update");
    const concurrentUpdate = projectConfig("origin", "release");
    updateDependencies.mutationHooks = {
      atConfigPublication: async () => {
        const path = join(updateFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE);
        await unlinkIfPresent(path);
        await writeFile(path, `${JSON.stringify(concurrentUpdate)}\n`);
      },
    };
    await expect(runDocsFabInit(approvedArguments(updatePlan), updateDependencies)).rejects.toThrow(
      "changed after preview",
    );
    expect(
      JSON.parse(
        await readFile(join(updateFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8"),
      ),
    ).toEqual(concurrentUpdate);
  }, 30_000);

  it("recovers deterministically from every durable create publication boundary", async () => {
    const boundaries: DocsFabInitMutationBoundary[] = [
      "temporary-created",
      "temporary-synced",
      "temporary-directory-synced",
      "journal-created",
      "journal-synced",
      "journal-renamed",
      "journal-directory-synced",
      "config-linked",
      "config-directory-synced",
      "temporary-unlinked",
      "temporary-unlink-directory-synced",
      "receipt-renamed",
      "receipt-directory-synced",
    ];
    for (const boundary of boundaries) {
      const fixture = await createFixture();
      const dependencies = basicDependencies(fixture);
      const plan = await runDocsFabInit(["--non-interactive"], dependencies);
      let injected = false;
      dependencies.mutationHooks = {
        afterMutationBoundary: async (current) => {
          if (!injected && current === boundary) {
            injected = true;
            throw new Error(`simulated-crash:${boundary}`);
          }
        },
      };
      await expect(runDocsFabInit(approvedArguments(plan), dependencies)).rejects.toThrow(
        `simulated-crash:${boundary}`,
      );
      expect(injected).toBe(true);
      const recoveryDependencies = basicDependencies(fixture);
      const recoveryPlan = await runDocsFabInit(["--non-interactive"], recoveryDependencies);
      await runDocsFabInit(approvedArguments(recoveryPlan), recoveryDependencies);
      expect(
        JSON.parse(await readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8")),
      ).toEqual(plan.projectConfig);
      expect(
        (await readdir(fixture.repository)).filter((name) => name.startsWith(".docsfab-init.")),
      ).toEqual([]);
    }
  }, 90_000);

  it("recovers update preimage rename and cleanup crash boundaries", async () => {
    const boundaries: DocsFabInitMutationBoundary[] = [
      "preimage-renamed",
      "preimage-directory-synced",
      "backup-unlinked",
      "backup-unlink-directory-synced",
    ];
    for (const boundary of boundaries) {
      const fixture = await createFixture();
      const initialDependencies = basicDependencies(fixture);
      const initialPlan = await runDocsFabInit(["--non-interactive"], initialDependencies);
      await runDocsFabInit(approvedArguments(initialPlan), initialDependencies);
      const commands = new FakeCommands(fixture.repository);
      commands.projectResponse = {
        id: 42,
        path_with_namespace: "group/docs",
        default_branch: "trunk",
        permissions: { project_access: { access_level: 30 }, group_access: null },
      };
      const dependencies = basicDependencies(fixture, commands);
      const plan = await runDocsFabInit(["--non-interactive"], dependencies);
      let injected = false;
      dependencies.mutationHooks = {
        afterMutationBoundary: async (current) => {
          if (!injected && current === boundary) {
            injected = true;
            throw new Error(`simulated-crash:${boundary}`);
          }
        },
      };
      await expect(runDocsFabInit(approvedArguments(plan), dependencies)).rejects.toThrow(
        `simulated-crash:${boundary}`,
      );
      const recoveryDependencies = basicDependencies(fixture, commands);
      const recoveryPlan = await runDocsFabInit(["--non-interactive"], recoveryDependencies);
      await runDocsFabInit(approvedArguments(recoveryPlan), recoveryDependencies);
      expect(
        JSON.parse(await readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8")),
      ).toEqual(plan.projectConfig);
    }
  }, 30_000);

  it("rejects and recovers exact journal and receipt inode substitution", async () => {
    for (const target of ["journal", "receipt"] as const) {
      const fixture = await createFixture();
      const logs: string[] = [];
      const dependencies = basicDependencies(fixture, undefined, logs);
      const plan = await runDocsFabInit(["--non-interactive"], dependencies);
      const projectRoot = dirname(
        resolveDocsFabPrivateRoots(fixture.repository, environment(fixture), fixture.home).runs,
      );
      let injected = false;
      dependencies.mutationHooks = {
        afterMutationBoundary: async (boundary) => {
          const selected =
            target === "journal"
              ? boundary === "temporary-unlink-directory-synced"
              : boundary === "receipt-renamed";
          if (!selected || injected) return;
          injected = true;
          const path = join(
            projectRoot,
            target === "journal" ? "init-journal.json" : "init-receipt.json",
          );
          const bytes = await readFile(path);
          await unlink(path);
          await writeFile(path, bytes, { mode: 0o600 });
        },
      };
      await expect(runDocsFabInit(approvedArguments(plan), dependencies)).rejects.toThrow(
        /transaction-bound initialization (?:journal|receipt)/u,
      );
      const recoveryLogs: string[] = [];
      const recoveryDependencies = basicDependencies(fixture, undefined, recoveryLogs);
      const recoveryPlan = await runDocsFabInit(["--non-interactive"], recoveryDependencies);
      await runDocsFabInit(approvedArguments(recoveryPlan), recoveryDependencies);
      expect(recoveryLogs.at(-1)).toContain("applied-cleanup-required");
      expect(
        JSON.parse(await readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8")),
      ).toEqual(plan.projectConfig);
      expect(await lstat(join(projectRoot, `init-${target}.conflict`))).toMatchObject({});
    }
  }, 30_000);

  it("rejects final ancestor and temporary-name substitution and repairs hostile postchecks", async () => {
    const ancestorFixture = await createFixture();
    const ancestorDependencies = basicDependencies(ancestorFixture);
    const ancestorPlan = await runDocsFabInit(["--non-interactive"], ancestorDependencies);
    ancestorDependencies.mutationHooks = {
      atConfigPublication: async () => {
        await rename(ancestorFixture.repository, `${ancestorFixture.repository}-moved-final`);
        await mkdir(ancestorFixture.repository, { mode: 0o700 });
      },
    };
    await expect(
      runDocsFabInit(approvedArguments(ancestorPlan), ancestorDependencies),
    ).rejects.toThrow("pinned initialization directory changed");

    const temporaryFixture = await createFixture();
    const temporaryDependencies = basicDependencies(temporaryFixture);
    const temporaryPlan = await runDocsFabInit(["--non-interactive"], temporaryDependencies);
    temporaryDependencies.mutationHooks = {
      atConfigPublication: async () => {
        const pending = join(temporaryFixture.repository, ".docsfab-init.pending");
        await unlink(pending);
        await writeFile(pending, `${JSON.stringify(temporaryPlan.projectConfig)}\n`, {
          mode: 0o644,
        });
      },
    };
    await expect(
      runDocsFabInit(approvedArguments(temporaryPlan), temporaryDependencies),
    ).rejects.toThrow("temporary pathname was substituted");

    const hostileFixture = await createFixture();
    const logs: string[] = [];
    const hostileDependencies = basicDependencies(hostileFixture, undefined, logs);
    const hostilePlan = await runDocsFabInit(["--non-interactive"], hostileDependencies);
    let replaced = false;
    hostileDependencies.mutationHooks = {
      afterMutationBoundary: async (boundary) => {
        if (!replaced && boundary === "config-linked") {
          replaced = true;
          const configPath = join(hostileFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE);
          await unlink(configPath);
          await writeFile(configPath, `${JSON.stringify(projectConfig("origin", "hostile"))}\n`, {
            mode: 0o644,
          });
        }
      },
    };
    await runDocsFabInit(approvedArguments(hostilePlan), hostileDependencies);
    expect(
      JSON.parse(
        await readFile(join(hostileFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8"),
      ),
    ).toEqual(hostilePlan.projectConfig);
    expect(await lstat(join(hostileFixture.repository, ".docsfab-init.conflict"))).toMatchObject(
      {},
    );
    expect(logs.at(-1)).toContain("applied-cleanup-required");

    const revisionFixture = await createFixture();
    const revisionCommands = new FakeCommands(revisionFixture.repository);
    const revisionDependencies = basicDependencies(revisionFixture, revisionCommands);
    const revisionPlan = await runDocsFabInit(["--non-interactive"], revisionDependencies);
    revisionDependencies.mutationHooks = {
      atConfigPublication: async () => {
        revisionCommands.headRevision = "fedcba9876543210fedcba9876543210fedcba98";
      },
    };
    await expect(
      runDocsFabInit(approvedArguments(revisionPlan), revisionDependencies),
    ).rejects.toThrow("Repository identity changed after approval");
    await expect(
      readFile(join(revisionFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects repository/root swaps and temporary permission failures before publication", async () => {
    const repoFixture = await createFixture();
    const repoDependencies = basicDependencies(repoFixture);
    const repoPlan = await runDocsFabInit(["--non-interactive"], repoDependencies);
    repoDependencies.mutationHooks = {
      beforeConfigCommit: async () => {
        const moved = `${repoFixture.repository}-moved`;
        await rename(repoFixture.repository, moved);
        await mkdir(repoFixture.repository, { mode: 0o700 });
      },
    };
    await expect(runDocsFabInit(approvedArguments(repoPlan), repoDependencies)).rejects.toThrow(
      "pinned initialization directory changed",
    );
    await expect(
      readFile(join(repoFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const rootFixture = await createFixture();
    const rootDependencies = basicDependencies(rootFixture);
    const rootPlan = await runDocsFabInit(["--non-interactive"], rootDependencies);
    rootDependencies.mutationHooks = {
      beforeConfigCommit: async () => {
        const roots = resolveDocsFabPrivateRoots(
          rootFixture.repository,
          environment(rootFixture),
          rootFixture.home,
        );
        await chmod(roots.delivery, 0o755);
      },
    };
    await expect(runDocsFabInit(approvedArguments(rootPlan), rootDependencies)).rejects.toThrow(
      "pinned initialization directory changed",
    );

    const chmodFixture = await createFixture();
    const chmodDependencies = basicDependencies(chmodFixture);
    const chmodPlan = await runDocsFabInit(["--non-interactive"], chmodDependencies);
    chmodDependencies.mutationHooks = {
      configureTemporary: async () => {
        throw new Error("injected-fchmod-failure");
      },
    };
    await expect(runDocsFabInit(approvedArguments(chmodPlan), chmodDependencies)).rejects.toThrow(
      "injected-fchmod-failure",
    );
    await expect(
      readFile(join(chmodFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects noncanonical and overlapping private storage before publication", async () => {
    const overlapFixture = await createFixture();
    const overlapEnvironment = {
      ...environment(overlapFixture),
      XDG_STATE_HOME: overlapFixture.repository,
    };
    const overlapDependencies = {
      ...basicDependencies(overlapFixture),
      environment: overlapEnvironment,
    };
    const overlapPlan = await runDocsFabInit(["--non-interactive"], overlapDependencies);
    await expect(
      runDocsFabInit(approvedArguments(overlapPlan), overlapDependencies),
    ).rejects.toThrow("disjoint");

    const configFixture = await createFixture();
    const configEnvironment = {
      ...environment(configFixture),
      DOCSFAB_CONFIG_ROOT: resolve(configFixture.stateHome, "docsfab"),
    };
    const configDependencies = {
      ...basicDependencies(configFixture),
      environment: configEnvironment,
    };
    const configPlan = await runDocsFabInit(["--non-interactive"], configDependencies);
    await expect(runDocsFabInit(approvedArguments(configPlan), configDependencies)).rejects.toThrow(
      "disjoint",
    );

    const linkedFixture = await createFixture();
    const realState = `${linkedFixture.stateHome}-real`;
    await rename(linkedFixture.stateHome, realState);
    await symlink(realState, linkedFixture.stateHome);
    const linkedDependencies = basicDependencies(linkedFixture);
    const linkedPlan = await runDocsFabInit(["--non-interactive"], linkedDependencies);
    await expect(runDocsFabInit(approvedArguments(linkedPlan), linkedDependencies)).rejects.toThrow(
      /canonical paths|not owner controlled/u,
    );
  });

  describe("configuration root reached through a symlink (#1438)", () => {
    async function rejection(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    function withConfigRoot(fixture: Fixture, configRoot: string | undefined, logs: string[]) {
      const base = basicDependencies(fixture, undefined, logs);
      const { DOCSFAB_CONFIG_ROOT: _omitted, ...rest } = environment(fixture);
      return {
        ...base,
        environment: configRoot === undefined ? rest : { ...rest, DOCSFAB_CONFIG_ROOT: configRoot },
      };
    }

    /**
     * An injected home that contains every fixture path, so the refusal names
     * `~/...` on any host. The fixture's own `home` sibling does not contain
     * the roots, and where the host temp directory sits under `/home/` or
     * `/Users/` operator output redacts an absolute path.
     */
    function containingHome(fixture: Fixture): string {
      return dirname(fixture.home);
    }

    /** The operator-visible refusal, read through the router's own renderers. */
    function expectOperatorRefusal(
      error: unknown,
      canonicalPath: string,
      shownPath: string = canonicalPath,
    ): void {
      expect(error).toBeInstanceOf(ConfigurationRootNotCanonicalError);
      expect(error).toMatchObject({
        code: "configuration-root-not-canonical",
        canonicalPath,
      });
      expect((error as Error).message).toContain(`resolves to "${shownPath}"`);
      const text = formatInitFailure(error);
      // Operator output passes through the shared host-path redaction, which
      // leaves `~/...` visible and may hide an absolute path on this host.
      expect(text).toContain(`resolves to "${sanitizeDisplayText(shownPath)}"`);
      expect(text).toContain("code: configuration-root-not-canonical");
      expect(text).toContain("failure class: operator-input (layer cli)");
      expect(text).toMatch(/^Next action: Rerun docsfab init with DOCSFAB_CONFIG_ROOT/mu);
      expect(text).not.toMatch(/docsfab doctor/u);
      expect(text).toContain("Docs: docs/troubleshooting.md");
      expect(JSON.parse(serializeInitFailure(error))).toMatchObject({
        code: "configuration-root-not-canonical",
        failure: {
          class: "operator-input",
          layer: "cli",
          code: "configuration-root-not-canonical",
        },
        docsAnchor: "docs/troubleshooting.md",
      });
    }

    it("refuses an existing symlinked root in text and JSON preview before any digest is printed", async () => {
      const fixture = await createFixture();
      const linkedRoot = join(dirname(fixture.configRoot), "config-link");
      await symlink(fixture.configRoot, linkedRoot);
      const homeDirectory = containingHome(fixture);
      for (const args of [["--non-interactive"], ["--non-interactive", "--json"]]) {
        const logs: string[] = [];
        const error = await rejection(
          runDocsFabInit(args, { ...withConfigRoot(fixture, linkedRoot, logs), homeDirectory }),
        );
        expectOperatorRefusal(error, fixture.configRoot, "~/config");
        const output = logs.join("\n");
        expect(output).not.toMatch(/Plan: [0-9a-f]{64}/u);
        expect(output).not.toContain("docsfab-init-plan");
      }
      // A home that does not contain the root keeps the absolute path in the
      // message (redaction applies only to rendering).
      const outsideHome = await rejection(
        runDocsFabInit(["--non-interactive"], withConfigRoot(fixture, linkedRoot, [])),
      );
      expectOperatorRefusal(outsideHome, fixture.configRoot);
      // An --apply run with any digest stops at the same preview check.
      const applyError = await rejection(
        runDocsFabInit(approvedArguments({ sha256: "0".repeat(64) }), {
          ...withConfigRoot(fixture, linkedRoot, []),
          homeDirectory,
        }),
      );
      expectOperatorRefusal(applyError, fixture.configRoot, "~/config");
      await expect(
        readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a missing root under a symlinked parent in preview without creating it", async () => {
      const fixture = await createFixture();
      const linkedParent = join(dirname(fixture.configRoot), "parent-link");
      await symlink(fixture.configRoot, linkedParent);
      const logs: string[] = [];
      const error = await rejection(
        runDocsFabInit(["--non-interactive"], {
          ...withConfigRoot(fixture, join(linkedParent, "newroot"), logs),
          homeDirectory: containingHome(fixture),
        }),
      );
      expectOperatorRefusal(error, join(fixture.configRoot, "newroot"), "~/config/newroot");
      expect(logs.join("\n")).not.toMatch(/Plan: [0-9a-f]{64}/u);
      await expect(lstat(join(fixture.configRoot, "newroot"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("refuses at apply when the root becomes a symlink after the preview check", async () => {
      const fixture = await createFixture();
      // Apply must name the root relative to the same injected home the
      // preview used, not the process home.
      const base = { ...basicDependencies(fixture), homeDirectory: containingHome(fixture) };
      const plan = await runDocsFabInit(["--non-interactive"], base);
      const realRoot = `${fixture.configRoot}-real`;
      let swapped = false;
      const error = await rejection(
        runDocsFabInit(approvedArguments(plan), {
          ...base,
          // Runs after the preview-time root check and before applyInitialization.
          inspectReadiness: async () => {
            await rename(fixture.configRoot, realRoot);
            await symlink(realRoot, fixture.configRoot);
            swapped = true;
            return readyReadinessChecks();
          },
        }),
      );
      expect(swapped).toBe(true);
      expectOperatorRefusal(error, realRoot, "~/config-real");
      await expect(
        readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("previews a canonical missing root and the default root without creating either", async () => {
      const fixture = await createFixture();
      const missingRoot = join(fixture.configRoot, "fresh");
      const plan = await runDocsFabInit(
        ["--non-interactive"],
        withConfigRoot(fixture, missingRoot, []),
      );
      expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/u);
      await expect(lstat(missingRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const configHome = join(fixture.home, ".config");
      const defaultPlan = await runDocsFabInit(["--non-interactive"], {
        ...withConfigRoot(fixture, undefined, []),
        environment: {
          ...withConfigRoot(fixture, undefined, []).environment,
          XDG_CONFIG_HOME: configHome,
        },
      });
      expect(defaultPlan.sha256).toBe(plan.sha256);
      await expect(lstat(configHome)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("refuses the default root when its configuration home is reached through a symlink", async () => {
      const fixture = await createFixture();
      const linkedHome = join(dirname(fixture.home), "home-link");
      await symlink(fixture.home, linkedHome);
      const error = await rejection(
        runDocsFabInit(["--non-interactive"], {
          ...withConfigRoot(fixture, undefined, []),
          environment: {
            ...withConfigRoot(fixture, undefined, []).environment,
            XDG_CONFIG_HOME: join(linkedHome, ".config"),
          },
        }),
      );
      // The canonical root sits inside the canonical HOME, so the operator sees
      // the home-relative form, which survives host-path redaction.
      expectOperatorRefusal(error, join(fixture.home, ".config", "docsfab"), "~/.config/docsfab");
    });

    it("names a home-relative path only when home is canonical and contains the root", async () => {
      const fixture = await createFixture();
      const inside = join(fixture.home, ".config", "docsfab");
      expect(await configurationRootDisplayPath(inside, fixture.home)).toBe("~/.config/docsfab");
      expect(await configurationRootDisplayPath(fixture.home, fixture.home)).toBe("~");
      // Paths the short form must not take.
      expect(await configurationRootDisplayPath(fixture.configRoot, fixture.home)).toBe(
        fixture.configRoot,
      );
      const sibling = `${fixture.home}-sibling`;
      expect(await configurationRootDisplayPath(sibling, fixture.home)).toBe(sibling);
      // A child whose name starts with `..` is still inside HOME.
      const dotted = join(fixture.home, "..cfg");
      expect(await configurationRootDisplayPath(dotted, fixture.home)).toBe("~/..cfg");
      // A HOME that is not canonical would expand `~/` back into a
      // non-canonical (or non-normalized) root that init refuses again.
      const linkedHome = join(dirname(fixture.home), "home-alias");
      await symlink(fixture.home, linkedHome);
      expect(await configurationRootDisplayPath(join(linkedHome, "cfg"), linkedHome)).toBe(
        join(linkedHome, "cfg"),
      );
      const unnormalizedHome = `${fixture.home}/../${basename(fixture.home)}`;
      expect(await configurationRootDisplayPath(inside, unnormalizedHome)).toBe(inside);
      const missingHome = join(fixture.root, "no-such-home");
      expect(await configurationRootDisplayPath(join(missingHome, "cfg"), missingHome)).toBe(
        join(missingHome, "cfg"),
      );
    });
  });

  it("serializes concurrent initialization and reports post-commit cleanup truthfully", async () => {
    const fixture = await createFixture();
    const base = basicDependencies(fixture);
    const plan = await runDocsFabInit(["--non-interactive"], base);
    let entered!: () => void;
    let resume!: () => void;
    const enteredPromise = new Promise<void>((resolvePromise) => {
      entered = resolvePromise;
    });
    const resumePromise = new Promise<void>((resolvePromise) => {
      resume = resolvePromise;
    });
    const first = {
      ...basicDependencies(fixture),
      mutationHooks: {
        afterLockAcquired: async () => {
          entered();
          await resumePromise;
        },
      },
    };
    const firstRun = runDocsFabInit(approvedArguments(plan), first);
    await enteredPromise;
    await expect(
      runDocsFabInit(approvedArguments(plan), basicDependencies(fixture)),
    ).rejects.toThrow("Another DocsFab initialization is active");
    resume();
    await firstRun;

    const cleanupFixture = await createFixture();
    const cleanupLogs: string[] = [];
    const cleanupDependencies = basicDependencies(cleanupFixture, undefined, cleanupLogs);
    const cleanupPlan = await runDocsFabInit(["--non-interactive"], cleanupDependencies);
    cleanupDependencies.mutationHooks = {
      afterConfigPublished: async () => {
        throw new Error("injected-post-commit");
      },
    };
    await expect(
      runDocsFabInit(approvedArguments(cleanupPlan), cleanupDependencies),
    ).resolves.toEqual(cleanupPlan);
    expect(cleanupLogs.at(-1)).toContain("applied-cleanup-required");
    expect(
      JSON.parse(
        await readFile(join(cleanupFixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8"),
      ),
    ).toEqual(cleanupPlan.projectConfig);
  });

  it("reclaims a dead owner lease and reports no-change lock-release failures", async () => {
    const fixture = await createFixture();
    const dependencies = basicDependencies(fixture);
    const initial = await runDocsFabInit(["--non-interactive"], dependencies);
    await runDocsFabInit(approvedArguments(initial), dependencies);
    const roots = resolveDocsFabPrivateRoots(
      fixture.repository,
      environment(fixture),
      fixture.home,
    );
    const projectRoot = dirname(roots.runs);
    const lockPath = join(projectRoot, "init.lock");
    await mkdir(lockPath, { mode: 0o700 });
    const acquiredAtMs = Date.now() - 10_000;
    await writeFile(
      join(lockPath, "owner.json"),
      canonicalTestJson({
        schemaVersion: 1,
        kind: "docsfab-init-lock-owner",
        leaseId: "00000000-0000-4000-8000-000000000000",
        pid: 2_147_483_647,
        uid: process.getuid!(),
        processBirthIdentity: "a".repeat(64),
        issuedAtMs: acquiredAtMs,
        expiresAtMs: acquiredAtMs + 1_000,
      }),
      { mode: 0o600 },
    );
    const stalePlan = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture));
    await expect(
      runDocsFabInit(approvedArguments(stalePlan), basicDependencies(fixture)),
    ).resolves.toEqual(stalePlan);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const reclaimedPath = `${lockPath}.reclaimed`;
    await mkdir(reclaimedPath, { mode: 0o700 });
    await writeFile(
      join(reclaimedPath, "owner.json"),
      canonicalTestJson({
        schemaVersion: 1,
        kind: "docsfab-init-lock-owner",
        leaseId: "00000000-0000-4000-8000-000000000000",
        pid: 2_147_483_647,
        uid: process.getuid?.() ?? 0,
        processBirthIdentity: "a".repeat(64),
        issuedAtMs: acquiredAtMs,
        expiresAtMs: acquiredAtMs + 1_000,
      }),
      { mode: 0o600 },
    );
    const reclaimPlan = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture));
    await runDocsFabInit(approvedArguments(reclaimPlan), basicDependencies(fixture));
    await expect(lstat(reclaimedPath)).rejects.toMatchObject({ code: "ENOENT" });

    for (const releaseBoundary of [
      "lock-owner-unlinked",
      "lock-removed",
      "lock-release-parent-synced",
    ] as const) {
      const logs: string[] = [];
      const releaseDependencies = basicDependencies(fixture, undefined, logs);
      const noChangePlan = await runDocsFabInit(["--non-interactive"], releaseDependencies);
      let injected = false;
      releaseDependencies.mutationHooks = {
        afterMutationBoundary: async (boundary) => {
          if (!injected && boundary === releaseBoundary) {
            injected = true;
            throw new Error(`simulated-crash:${releaseBoundary}`);
          }
        },
      };
      await expect(
        runDocsFabInit(approvedArguments(noChangePlan), releaseDependencies),
      ).resolves.toEqual(noChangePlan);
      expect(logs.at(-1)).toContain("applied-cleanup-required");
      const recoveredPlan = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture));
      await expect(
        runDocsFabInit(approvedArguments(recoveredPlan), basicDependencies(fixture)),
      ).resolves.toEqual(recoveredPlan);
    }
  });

  it("recovers lock acquisition crash states with an exact dead-owner lease", async () => {
    const boundaries: DocsFabInitMutationBoundary[] = [
      "lock-owner-synced",
      "lock-created",
      "lock-parent-synced",
    ];
    for (const boundary of boundaries) {
      const fixture = await createFixture();
      const dependencies = basicDependencies(fixture);
      const plan = await runDocsFabInit(["--non-interactive"], dependencies);
      let injected = false;
      dependencies.mutationHooks = {
        afterMutationBoundary: async (current) => {
          if (injected || current !== boundary) return;
          injected = true;
          if (current !== "lock-owner-synced") {
            const roots = resolveDocsFabPrivateRoots(
              fixture.repository,
              environment(fixture),
              fixture.home,
            );
            const now = Date.now() - 10_000;
            await writeFile(
              join(dirname(roots.runs), "init.lock", "owner.json"),
              canonicalTestJson({
                schemaVersion: 1,
                kind: "docsfab-init-lock-owner",
                leaseId: "00000000-0000-4000-8000-000000000000",
                pid: 2_147_483_647,
                uid: process.getuid?.() ?? 0,
                processBirthIdentity: "a".repeat(64),
                issuedAtMs: now,
                expiresAtMs: now + 1_000,
              }),
              { mode: 0o600 },
            );
          }
          throw new Error(`simulated-crash:${boundary}`);
        },
      };
      await expect(runDocsFabInit(approvedArguments(plan), dependencies)).rejects.toThrow(
        `simulated-crash:${boundary}`,
      );
      const recoveryDependencies = basicDependencies(fixture);
      const recoveryPlan = await runDocsFabInit(["--non-interactive"], recoveryDependencies);
      await runDocsFabInit(approvedArguments(recoveryPlan), recoveryDependencies);
      expect(
        JSON.parse(await readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8")),
      ).toEqual(plan.projectConfig);
    }
  }, 15_000);

  it("rejects exact lease substitution and distinguishes legacy from version 2 reuse", async () => {
    const substitutionFixture = await createFixture();
    const substitutionDependencies = basicDependencies(substitutionFixture);
    const substitutionPlan = await runDocsFabInit(["--non-interactive"], substitutionDependencies);
    substitutionDependencies.mutationHooks = {
      afterLockAcquired: async () => {
        const roots = resolveDocsFabPrivateRoots(
          substitutionFixture.repository,
          environment(substitutionFixture),
          substitutionFixture.home,
        );
        const ownerPath = join(dirname(roots.runs), "init.lock", "owner.json");
        const bytes = await readFile(ownerPath);
        // Recreate via temp+rename so overlayfs cannot reuse the same inode for
        // a same-path create-after-unlink of identical bytes.
        const temporary = `${ownerPath}.${randomUUID()}.swap`;
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, ownerPath);
      },
    };
    await expect(
      runDocsFabInit(approvedArguments(substitutionPlan), substitutionDependencies),
    ).rejects.toThrow(/lock lease identity changed|lock release both failed/u);

    const legacyFixture = await createFixture();
    const legacyDependencies = basicDependencies(legacyFixture);
    const legacyPlan = await runDocsFabInit(["--non-interactive"], legacyDependencies);
    const legacyRoots = resolveDocsFabPrivateRoots(
      legacyFixture.repository,
      environment(legacyFixture),
      legacyFixture.home,
    );
    await allocateDocsFabPrivateRoots(legacyRoots);
    const legacyLock = join(dirname(legacyRoots.runs), "init.lock");
    await mkdir(legacyLock, { mode: 0o700 });
    const legacyIssuedAtMs = Date.now() - 20_000;
    await writeFile(
      join(legacyLock, "owner.json"),
      canonicalTestJson({
        schemaVersion: 1,
        kind: "docsfab-init-lock-owner",
        leaseId: "00000000-0000-4000-8000-000000000000",
        pid: process.pid,
        uid: process.getuid?.() ?? 0,
        processBirthIdentity: "b".repeat(64),
        issuedAtMs: legacyIssuedAtMs,
        expiresAtMs: legacyIssuedAtMs + 1_000,
      }),
      { mode: 0o600 },
    );
    await expect(runDocsFabInit(approvedArguments(legacyPlan), legacyDependencies)).rejects.toThrow(
      "Another DocsFab initialization is active",
    );
    expect(await lstat(legacyLock)).toMatchObject({});

    const reusedFixture = await createFixture();
    const reusedDependencies = basicDependencies(reusedFixture);
    const reusedPlan = await runDocsFabInit(["--non-interactive"], reusedDependencies);
    const reusedRoots = resolveDocsFabPrivateRoots(
      reusedFixture.repository,
      environment(reusedFixture),
      reusedFixture.home,
    );
    await allocateDocsFabPrivateRoots(reusedRoots);
    const lockPath = join(dirname(reusedRoots.runs), "init.lock");
    await mkdir(lockPath, { mode: 0o700 });
    const issuedAtMs = Date.now() - 20_000;
    await writeFile(
      join(lockPath, "owner.json"),
      canonicalTestJson({
        schemaVersion: 2,
        kind: "docsfab-init-lock-owner",
        leaseId: "00000000-0000-4000-8000-000000000000",
        pid: process.pid,
        uid: process.getuid?.() ?? 0,
        processBirthIdentity: "b".repeat(64),
        issuedAtMs,
        expiresAtMs: issuedAtMs + 1_000,
      }),
      { mode: 0o600 },
    );
    await expect(
      runDocsFabInit(approvedArguments(reusedPlan), reusedDependencies),
    ).resolves.toEqual(reusedPlan);

    const unexpiredFixture = await createFixture();
    const unexpiredDependencies = basicDependencies(unexpiredFixture);
    const unexpiredPlan = await runDocsFabInit(["--non-interactive"], unexpiredDependencies);
    const unexpiredRoots = resolveDocsFabPrivateRoots(
      unexpiredFixture.repository,
      environment(unexpiredFixture),
      unexpiredFixture.home,
    );
    await allocateDocsFabPrivateRoots(unexpiredRoots);
    const unexpiredLock = join(dirname(unexpiredRoots.runs), "init.lock");
    await mkdir(unexpiredLock, { mode: 0o700 });
    await writeFile(
      join(unexpiredLock, "owner.json"),
      canonicalTestJson({
        schemaVersion: 2,
        kind: "docsfab-init-lock-owner",
        leaseId: "00000000-0000-4000-8000-000000000000",
        pid: 2_147_483_647,
        uid: process.getuid?.() ?? 0,
        processBirthIdentity: "c".repeat(64),
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      }),
      { mode: 0o600 },
    );
    await expect(
      runDocsFabInit(approvedArguments(unexpiredPlan), unexpiredDependencies),
    ).rejects.toThrow("Another DocsFab initialization is active");
  }, 30_000);

  it("binds version 2 lock ownership to one real process identity across processes", async () => {
    const fixture = await createFixture();
    const roots = resolveDocsFabPrivateRoots(
      fixture.repository,
      environment(fixture),
      fixture.home,
    );
    const storage = await allocatePinnedPrivateRoots(roots, fixture.repository, fixture.configRoot);
    const childScript = `
      import { captureDirectoryPin, readLockOwnerSnapshot, requireProcessBirthIdentity, verifyLockLease } from "./src/init/storage.ts";
      console.log(JSON.stringify({ pid: process.pid, identity: requireProcessBirthIdentity(process.pid) }));
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", async () => {
        const lockPath = process.env.DOCSFAB_TEST_LOCK_PATH;
        if (!lockPath) throw new Error("missing test lock path");
        const directory = await captureDirectoryPin(lockPath, true);
        const owner = await readLockOwnerSnapshot(lockPath + "/owner.json");
        if (!owner) throw new Error("missing test lock owner");
        await verifyLockLease({ directory, owner });
        console.log("verified");
        process.exit(0);
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, DOCSFAB_TEST_LOCK_PATH: storage.lockPath },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    const output = lines[Symbol.asyncIterator]();
    try {
      const first = await output.next();
      if (first.done) throw new Error(`identity owner exited before reporting: ${stderr}`);
      const reported = JSON.parse(first.value) as { pid: number; identity: string };
      expect(reported.pid).toBe(child.pid);
      expect(reported.identity).toMatch(/^[a-f0-9]{64}$/u);
      expect(requireProcessBirthIdentity(reported.pid)).toBe(reported.identity);
      expect(requireProcessBirthIdentity(reported.pid)).toBe(reported.identity);

      const issuedAtMs = Date.now() - 20_000;
      const owner = {
        schemaVersion: 2,
        kind: "docsfab-init-lock-owner",
        leaseId: "10000000-0000-4000-8000-000000000000",
        pid: reported.pid,
        uid: process.getuid?.() ?? 0,
        processBirthIdentity: reported.identity,
        issuedAtMs,
        expiresAtMs: issuedAtMs + 1_000,
      } as const;
      await mkdir(storage.lockPath, { mode: 0o700 });
      const ownerPath = join(storage.lockPath, "owner.json");
      await writeFile(ownerPath, canonicalTestJson(owner), { mode: 0o600 });
      const before = await stat(ownerPath);
      const beforeBytes = await readFile(ownerPath);
      await expect(reclaimStaleLockIfSafe(storage, storage.lockPath)).rejects.toThrow(
        "Another DocsFab initialization is active",
      );
      expect(await readFile(ownerPath)).toEqual(beforeBytes);
      expect((await stat(ownerPath)).ino).toBe(before.ino);

      const preparedName = `init.lock.pending-v2-${owner.expiresAtMs}-${owner.pid}-${owner.processBirthIdentity}-${owner.leaseId}`;
      const preparedPath = join(storage.projectRoot.path, preparedName);
      await mkdir(preparedPath, { mode: 0o700 });
      await writeFile(join(preparedPath, "owner.json"), canonicalTestJson(owner), { mode: 0o600 });
      await recoverPreparedLockClaims(storage);
      expect(await lstat(preparedPath)).toMatchObject({});

      child.stdin.write("verify\n");
      const verified = await output.next();
      if (verified.done) throw new Error(`identity owner exited before verification: ${stderr}`);
      expect(verified.value).toBe("verified");
      if (child.exitCode === null) await once(child, "exit");
      expect(inspectProcessBirth(reported.pid)).toEqual({ alive: false });
      await reclaimStaleLockIfSafe(storage, storage.lockPath);
      await expect(lstat(storage.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await recoverPreparedLockClaims(storage);
      await expect(lstat(preparedPath)).rejects.toMatchObject({ code: "ENOENT" });

      const legacyLeaseId = "11000000-0000-4000-8000-000000000000";
      const legacyDead = join(
        storage.projectRoot.path,
        `init.lock.pending-${owner.expiresAtMs}-${owner.pid}-${"e".repeat(64)}-${legacyLeaseId}`,
      );
      await mkdir(legacyDead, { mode: 0o700 });
      await recoverPreparedLockClaims(storage);
      await expect(lstat(legacyDead)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lines.close();
      if (!child.killed) child.kill("SIGTERM");
    }
  }, 30_000);

  it("recovers only attributable expired prepared claims with safe process evidence", async () => {
    const fixture = await createFixture();
    const roots = resolveDocsFabPrivateRoots(
      fixture.repository,
      environment(fixture),
      fixture.home,
    );
    const storage = await allocatePinnedPrivateRoots(roots, fixture.repository, fixture.configRoot);
    const expired = Date.now() - 1_000;
    const liveIdentity = requireProcessBirthIdentity(process.pid);
    const leaseId = "20000000-0000-4000-8000-000000000000";

    const legacyEmpty = join(
      storage.projectRoot.path,
      `init.lock.pending-${expired}-${process.pid}-${"a".repeat(64)}-${leaseId}`,
    );
    await mkdir(legacyEmpty, { mode: 0o700 });
    const legacyPopulated = join(
      storage.projectRoot.path,
      `init.lock.pending-${expired}-${process.pid}-${"b".repeat(64)}-${leaseId}`,
    );
    await mkdir(legacyPopulated, { mode: 0o700 });
    await writeFile(
      join(legacyPopulated, "owner.json"),
      canonicalTestJson({
        schemaVersion: 1,
        kind: "docsfab-init-lock-owner",
        leaseId,
        pid: process.pid,
        uid: process.getuid?.() ?? 0,
        processBirthIdentity: "b".repeat(64),
        issuedAtMs: expired - 1_000,
        expiresAtMs: expired,
      }),
      { mode: 0o600 },
    );
    const versionTwoLive = join(
      storage.projectRoot.path,
      `init.lock.pending-v2-${expired}-${process.pid}-${liveIdentity}-${leaseId}`,
    );
    await mkdir(versionTwoLive, { mode: 0o700 });
    const versionTwoReused = join(
      storage.projectRoot.path,
      `init.lock.pending-v2-${expired}-${process.pid}-${"c".repeat(64)}-${leaseId}`,
    );
    await mkdir(versionTwoReused, { mode: 0o700 });
    const deadPid = 2_147_483_647;
    const deadLegacy = join(
      storage.projectRoot.path,
      `init.lock.pending-${expired}-${deadPid}-${"d".repeat(64)}-${leaseId}`,
    );
    await mkdir(deadLegacy, { mode: 0o700 });
    const malformed = join(storage.projectRoot.path, "init.lock.pending-v3-unknown");
    await mkdir(malformed, { mode: 0o700 });

    await recoverPreparedLockClaims(storage);
    expect(await lstat(legacyEmpty)).toMatchObject({});
    expect(await lstat(legacyPopulated)).toMatchObject({});
    expect(await lstat(versionTwoLive)).toMatchObject({});
    await expect(lstat(versionTwoReused)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(deadLegacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lstat(malformed)).toMatchObject({});

    const mismatch = join(
      storage.projectRoot.path,
      `init.lock.pending-v2-${expired}-${process.pid}-${liveIdentity}-${leaseId}`,
    );
    await writeFile(
      join(mismatch, "owner.json"),
      canonicalTestJson({
        schemaVersion: 1,
        kind: "docsfab-init-lock-owner",
        leaseId,
        pid: process.pid,
        uid: process.getuid?.() ?? 0,
        processBirthIdentity: liveIdentity,
        issuedAtMs: expired - 1_000,
        expiresAtMs: expired,
      }),
      { mode: 0o600 },
    );
    await expect(recoverPreparedLockClaims(storage)).rejects.toThrow(
      "does not match its attributable name",
    );
    expect(await lstat(mismatch)).toMatchObject({});
  });

  it("treats uncertain liveness as active and validates process identity inputs", () => {
    expect(() => inspectProcessBirth(0)).toThrow("positive safe-integer PID");
    expect(
      leaseProcessIsGoneOrReused({
        schemaVersion: 1,
        pid: process.pid,
        processBirthIdentity: "f".repeat(64),
      }),
    ).toBe(false);
    expect(
      leaseProcessIsGoneOrReused({
        schemaVersion: 2,
        pid: process.pid,
        processBirthIdentity: "f".repeat(64),
      }),
    ).toBe(true);

    for (const code of ["EPERM", "EACCES", "EIO"]) {
      vi.spyOn(process, "kill").mockImplementationOnce(() => {
        throw Object.assign(new Error(`simulated-${code}`), { code });
      });
      expect(inspectProcessBirth(2_147_483_647)).toEqual({ alive: true });
    }
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated-ESRCH"), { code: "ESRCH" });
    });
    expect(inspectProcessBirth(2_147_483_647)).toEqual({ alive: false });
  });

  it("strictly rejects malformed and unknown lock owner records", async () => {
    const fixture = await createFixture();
    const ownerPath = join(fixture.root, "owner.json");
    const owner = {
      schemaVersion: 2,
      kind: "docsfab-init-lock-owner",
      leaseId: "30000000-0000-4000-8000-000000000000",
      pid: process.pid,
      uid: process.getuid?.() ?? 0,
      processBirthIdentity: requireProcessBirthIdentity(process.pid),
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 1_000,
    };
    for (const value of [
      { ...owner, schemaVersion: 3 },
      { ...owner, extra: true },
      { ...owner, processBirthIdentity: "invalid" },
    ]) {
      await writeFile(ownerPath, canonicalTestJson(value), { mode: 0o600 });
      expect(await readLockOwnerSnapshot(ownerPath)).toBeUndefined();
      await unlink(ownerPath);
    }
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    expect(await readLockOwnerSnapshot(ownerPath)).toBeUndefined();
  });

  it("uses unique attributable prepared claims for two acquirers paused before owner creation", async () => {
    const fixture = await createFixture();
    const plan = await runDocsFabInit(["--non-interactive"], basicDependencies(fixture));
    let entered!: () => void;
    let resume!: () => void;
    const enteredPromise = new Promise<void>((resolvePromise) => {
      entered = resolvePromise;
    });
    const resumePromise = new Promise<void>((resolvePromise) => {
      resume = resolvePromise;
    });
    const firstDependencies = basicDependencies(fixture);
    let paused = false;
    firstDependencies.mutationHooks = {
      afterMutationBoundary: async (boundary) => {
        if (boundary === "lock-prepared" && !paused) {
          paused = true;
          entered();
          await resumePromise;
        }
      },
    };
    const firstRun = runDocsFabInit(approvedArguments(plan), firstDependencies);
    await enteredPromise;
    const projectRoot = dirname(
      resolveDocsFabPrivateRoots(fixture.repository, environment(fixture), fixture.home).runs,
    );
    const firstPrepared = (await readdir(projectRoot)).filter((name) =>
      name.startsWith("init.lock.pending-"),
    );
    expect(firstPrepared).toHaveLength(1);
    await runDocsFabInit(approvedArguments(plan), basicDependencies(fixture));
    expect(await lstat(join(projectRoot, firstPrepared[0]!))).toMatchObject({});
    resume();
    await expect(firstRun).rejects.toThrow(/irreversible operation|active|changed after approval/u);
    expect(
      (await readdir(projectRoot)).filter((name) => name.startsWith("init.lock.pending-")),
    ).toEqual([]);
    expect(
      JSON.parse(await readFile(join(fixture.repository, DOCSFAB_PROJECT_CONFIG_FILE), "utf8")),
    ).toEqual(plan.projectConfig);
  }, 30_000);

  it("uses profile inspection only for profile failures and doctor for generic readiness failures", async () => {
    const fixture = await createFixture();
    const profile = await runDocsFabInit(["--non-interactive"], {
      ...basicDependencies(fixture),
      inspectProvider: async () => ({ status: "partial", profileStatus: "unavailable" }),
    });
    expect(profile.doctor).toBe("profile-diagnostics-required");
    expect(profile.nextActions).toContain("profile-inspect");

    const generic = await runDocsFabInit(["--non-interactive"], {
      ...basicDependencies(fixture),
      checkDoctor: async () => "diagnostics-required",
    });
    expect(generic.doctor).toBe("diagnostics-required");
    expect(generic.nextActions).toContain("doctor");
    expect(generic.nextActions).not.toContain("profile-inspect");
  });

  it("strictly parses arguments and the closed project schema", () => {
    expect(
      parseDocsFabInitArguments(
        ["--repo", "docs", "--remote", "origin", "--non-interactive"],
        "/work",
      ),
    ).toEqual({
      repositoryPath: "/work/docs",
      remote: "origin",
      nonInteractive: true,
      apply: false,
      json: false,
    });
    expect(() => parseDocsFabInitArguments(["--json"], "/work")).toThrow(
      "requires --non-interactive",
    );
    expect(() => parseDocsFabInitArguments(["--remote", "../unsafe"], "/work")).toThrow(
      "safe Git remote",
    );
    expect(() => parseDocsFabInitArguments(["--apply", "--apply"], "/work")).toThrow(
      "must not be duplicated",
    );
    expect(() => parseDocsFabInitArguments(["--apply"], "/work")).toThrow("approve-plan-sha256");
    expect(parseDocsFabInitArguments(["--non-interactive"], "/work")).toMatchObject({
      nonInteractive: true,
      apply: false,
    });
    expect(() =>
      assertDocsFabProjectConfig({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host", apiKey: SECRET },
        storage: { scope: "user-private" },
      }),
    ).toThrow("invalid");
    expect(() =>
      assertDocsFabProjectConfig({
        ...projectConfig("origin", "main"),
        documentationRoots: ["docs"],
      }),
    ).not.toThrow();
    for (const execution of [{ level: "production" }, {}, "production"]) {
      expect(() =>
        assertDocsFabProjectConfig({
          ...projectConfig("origin", "main"),
          execution,
        }),
      ).toThrow("has a top-level key DocsFab does not read; keep only schemaVersion");
    }
    expect(() =>
      assertDocsFabProjectConfig({
        ...projectConfig("origin", "main"),
        documentationRoots: [],
      }),
    ).toThrow("invalid");
    expect(() =>
      assertDocsFabProjectConfig({
        ...projectConfig("origin", "main"),
        documentationRoots: ["../docs"],
      }),
    ).toThrow("invalid");
    expect(() =>
      assertDocsFabProjectConfig({
        ...projectConfig("origin", "main"),
        documentationRoots: ["/docs"],
      }),
    ).toThrow("invalid");
    expect(() =>
      assertDocsFabProjectConfig({
        ...projectConfig("origin", "main"),
        documentationRoots: ["docs", "docs"],
      }),
    ).toThrow("invalid");
  });
});

describe("init CHECKS grid dialect alignment", () => {
  const checks: DoctorReadinessResult["checks"] = [
    { area: "installation", status: "ready" },
    { area: "configuration", status: "blocked" },
    { area: "private-state", status: "ready" },
  ];

  const STREAM_FIXTURES = [
    { name: "tty", options: { tty: true, noColor: false, forceColor: false, ci: false } },
    { name: "pipe", options: { tty: false, noColor: false, forceColor: false, ci: false } },
    { name: "no-color tty", options: { tty: true, noColor: true, forceColor: false, ci: false } },
  ] as const;

  function plan() {
    return {
      schemaVersion: 1 as const,
      kind: "docsfab-init-plan" as const,
      sha256: "b".repeat(64),
      projectConfig: projectConfig("origin", "main"),
      change: "none" as const,
      repository: "detected" as const,
      repositoryBindingSha256: "c".repeat(64),
      configPreimageSha256: "d".repeat(64),
      gitignore: {
        path: ".gitignore" as const,
        action: "none" as const,
        missingEntries: [],
        preimageSha256: "f".repeat(64),
        maxBytes: 262144,
        maxBytesSource: "config/limits.yaml" as const,
      },
      changedPaths: [],
      gitlabAuthentication: "configured" as const,
      gitlabProject: "ready" as const,
      gitlabBindingSha256: "e".repeat(64),
      providerConfiguration: "ready" as const,
      profileStatus: "current" as const,
      privateRoots: ["runs", "evidence", "delivery", "receipts"] as const,
      doctor: "ready" as const,
      nextActions: [],
    };
  }

  function result() {
    return {
      status: "ready",
      mutation: "none" as const,
      nextActions: [],
    };
  }

  function readiness(): DoctorReadinessResult {
    return {
      schemaVersion: 1,
      kind: "docsfab-doctor-readiness",
      status: "blocked",
      repositoryPath: "/repository",
      liveConnectivity: { requested: false, provider: "not-requested", gitlab: "not-requested" },
      checks,
      diagnostics: [],
      validationCommand: "npm run check",
      checkoutBranch: null,
      checkoutRevision: null,
      gitlabTargetBranch: null,
      gitlabTargetRevision: null,
      draftMrReadiness: {
        state: "blocked",
        revisionPolicy: null,
        runBaseAction: "unknown",
        checkoutRelation: "unknown",
        featureBranch: null,
        checkoutHeadRunBase: "unknown",
        blockers: ["project-config-missing"],
        reason: "not observed in this fixture",
      },
      remediationArgv: ["docsfab", "init", "--repo", "/repository"],
      repositoryRevision: "a".repeat(40),
      autoModesReady: [],
    };
  }

  it.each(STREAM_FIXTURES)(
    "formatDocsFabInitPlan CHECKS rows match the stamped formatCheckGrid dialect ($name)",
    ({ options }) => {
      const output = formatDocsFabInitPlan(plan(), { readinessChecks: checks, ...options });
      expect(output).toContain(`\n${formatSectionHeader("CHECKS", options)}\n`);
      for (const line of formatCheckGrid(checks, options)) expect(output).toContain(line);
    },
  );

  it.each(STREAM_FIXTURES)(
    "formatInitResult CHECKS rows match the stamped formatCheckGrid dialect ($name)",
    ({ options }) => {
      const output = formatInitResult(result(), { readinessChecks: checks, ...options });
      expect(output).toContain(`\n${formatSectionHeader("CHECKS", options)}\n`);
      for (const line of formatCheckGrid(checks, options)) expect(output).toContain(line);
    },
  );

  it.each(STREAM_FIXTURES)(
    "doctor and init render byte-identical CHECKS sections for the same checks ($name)",
    ({ options }) => {
      const doctorOutput = formatDoctorReadiness(readiness(), options);
      const initPlanOutput = formatDocsFabInitPlan(plan(), { readinessChecks: checks, ...options });
      const initResultOutput = formatInitResult(result(), {
        readinessChecks: checks,
        ...options,
      });
      const doctorSection = extractChecksSection(doctorOutput);
      expect(extractChecksSection(initPlanOutput)).toBe(doctorSection);
      expect(extractChecksSection(initResultOutput)).toBe(doctorSection);
    },
  );

  it("does not present Host diagnose as repository doctor when CHECKS are blocked", () => {
    const mixed = [
      { area: "installation", status: "ready" as const },
      { area: "private-state", status: "blocked" as const },
    ];
    const output = formatDocsFabInitPlan(
      { ...plan(), doctor: "ready" },
      { readinessChecks: mixed, tty: false, noColor: true, forceColor: false, ci: true },
    );
    expect(output).toContain("Host profile diagnose: ready (not repository doctor)");
    expect(output).not.toContain("Host diagnose: ready");
    expect(output).not.toContain("DocsFab readiness: ready");
    expect(output).not.toContain("Doctor readiness:");
    expect(output).toContain("private-state: blocked");
    expect(JSON.parse(serializeDocsFabInitPlan({ ...plan(), doctor: "ready" })).doctor).toBe(
      "ready",
    );
  });

  it("forwards terminal suppression overrides to the full init presentation", () => {
    vi.stubEnv("TERM", "xterm");
    const termDumbOutput = formatDocsFabInitPlan(plan(), {
      readinessChecks: checks,
      tty: true,
      noColor: false,
      forceColor: false,
      ci: false,
      termDumb: true,
    });
    expect(termDumbOutput).not.toContain("\u001b[");
    expect(termDumbOutput).not.toContain("──");

    const forceColorDisabledOutput = formatDocsFabInitPlan(plan(), {
      readinessChecks: checks,
      tty: true,
      noColor: false,
      forceColor: true,
      forceColorDisabled: true,
      ci: false,
      termDumb: false,
    });
    expect(forceColorDisabledOutput).not.toContain("\u001b[");
  });

  it("does not present Host diagnose as repository doctor when apply status is needs-attention", () => {
    const mixed = [
      { area: "installation", status: "ready" as const },
      { area: "private-state", status: "blocked" as const },
    ];
    const output = formatInitResult(
      { status: "needs-attention", mutation: "applied", nextActions: [] },
      { readinessChecks: mixed, tty: false, noColor: true, forceColor: false, ci: true },
    );
    expect(output).toContain("Initialization status: needs-attention.");
    expect(output).toContain("private-state: blocked");
    expect(output).not.toContain("Host diagnose: ready");
    expect(output).not.toContain("DocsFab readiness: ready");
    expect(output).not.toContain("Doctor readiness:");
  });
});

/** Isolate the CHECKS header + rows from a rendered doctor/init footer for cross-printer comparison. */
function extractChecksSection(output: string): string {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.includes("CHECKS"));
  if (start === -1) throw new Error("CHECKS section not found");
  const rows: string[] = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("  ")) break;
    rows.push(line);
  }
  return rows.join("\n");
}

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectories.create("docsfab-init-test-");
  let repository = join(root, "repository");
  let stateHome = join(root, "state");
  let home = join(root, "home");
  let configRoot = join(root, "config");
  await Promise.all([
    mkdir(repository, { mode: 0o700 }),
    mkdir(stateHome, { mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
    mkdir(configRoot, { mode: 0o700 }),
  ]);
  [repository, stateHome, home, configRoot] = await Promise.all([
    realpath(repository),
    realpath(stateHome),
    realpath(home),
    realpath(configRoot),
  ]);
  return { root, repository, stateHome, home, configRoot };
}

function readyReadinessChecks(): ReadonlyArray<{ area: string; status: "ready" | "blocked" }> {
  return [
    "installation",
    "configuration",
    "repository",
    "provider",
    "gitlab",
    "private-state",
    "validation",
  ].map((area) => ({ area, status: "ready" as const }));
}

function basicDependencies(
  fixture: Fixture,
  commands: FakeCommands = new FakeCommands(fixture.repository),
  logs: string[] = [],
): DocsFabInitDependencies {
  return {
    cwd: fixture.repository,
    commands,
    environment: environment(fixture),
    homeDirectory: fixture.home,
    inspectProvider: async () => ({ status: "ready", profileStatus: "current" }),
    checkDoctor: async () => "ready",
    inspectReadiness: async () => readyReadinessChecks(),
    log: (message) => logs.push(message),
  };
}

function approvedArguments(plan: { sha256: string }): string[] {
  return ["--non-interactive", "--apply", "--approve-plan-sha256", plan.sha256];
}

function projectConfig(remote: string, defaultBranch: string) {
  return {
    schemaVersion: 1 as const,
    gitlab: { remote, defaultBranch },
    provider: { configuration: "host" as const },
    storage: { scope: "user-private" as const },
  };
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    )
      throw error;
  }
}

function environment(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: fixture.home,
    XDG_STATE_HOME: fixture.stateHome,
    // Never inherit the checkout as config root; CI checkouts are often group-writable.
    DOCSFAB_CONFIG_ROOT: fixture.configRoot,
    GLAB_TOKEN: GLAB_SECRET,
    MODEL_API_KEY: SECRET,
  };
}

function stripSafeGit(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c" && args[index + 1] !== undefined) index += 2;
  return args.slice(index);
}

function ok(stdout: string): ReadOnlyCommandResult {
  return { exitCode: 0, stdout };
}

function failed(): ReadOnlyCommandResult {
  return { exitCode: 1, stdout: "" };
}

function json(value: unknown): ReadOnlyCommandResult {
  return ok(JSON.stringify(value));
}

function canonicalTestJson(value: unknown): string {
  return canonicalizeJsonEvidence(value as never);
}

async function snapshot(path: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(root: string, relative: string): Promise<void> {
    for (const name of (await readdir(root)).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      result.push(childRelative);
      const child = resolve(root, name);
      if ((await lstat(child)).isDirectory()) await visit(child, childRelative);
    }
  }
  await visit(path, "");
  return result;
}

function runLocalGit(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (result.status !== 0) {
    throw new Error(`Git fixture command failed: ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}
