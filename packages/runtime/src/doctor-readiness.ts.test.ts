// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DocsFabConfig } from "./config/runtime-loader.js";
import { formatDoctorReadiness, inspectDoctorReadiness } from "./doctor-readiness.js";
import {
  DOCUMENTATION_SOURCE_CAPABILITIES,
  resolveDocumentationSourceAdapter,
  type DocumentationSourceAdapterId,
} from "./repository/documentation-source-support.js";
import { resolveDocsFabPrivateRoots } from "./init.js";
import { bootstrapMissingProjectConfigIntoWorkspace } from "./init/first-run-bootstrap.js";
import { SAFE_GIT_CONFIG } from "./init/types.js";
import { initHelp, usage } from "./cli/usage.js";
import { ModelCompositionError } from "./model-composition/types.js";
import { loadModelConfigurations, parseModelEndpoint } from "./model/configuration.js";
import { resolveEvalPresetFieldBlock } from "./model/profile-apply/eval-presets.js";
import { doctorDiagnosticRemediation, remediationText } from "./operator/remediation.js";
import { NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION } from "./operator/situation-catalog.js";
import { operatorCodeFailureClass } from "./operator/failure-classification.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "./config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const roots: string[] = [];

describe("doctor generator capability matrix (#1602)", () => {
  it.each([
    ["plain-markdown", "docs/guide.md"],
    ["mkdocs", "mkdocs.yml"],
    ["docusaurus", "website/docusaurus.config.ts"],
    ["sphinx", "docs/conf.py"],
    ["fern", "fern/docs.yml"],
    ["jupyter-book", "_toc.yml"],
  ] as const)("reports all registry capability states for %s", async (adapterId, marker) => {
    const fixture = await readyFixture();
    commitFixture(fixture.repository, true);
    await mkdir(dirname(resolve(fixture.repository, marker)), { recursive: true });
    await writeFile(resolve(fixture.repository, marker), "fixture\n");
    execFileSync("git", ["add", "--", marker], { cwd: fixture.repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Doctor Test",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-qm",
        "generator fixture",
      ],
      { cwd: fixture.repository },
    );
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    const generator = result.documentationGenerators?.find(
      (entry) => entry.adapterId === adapterId,
    );
    expect(generator?.capabilities).toEqual(
      resolveDocumentationSourceAdapter(adapterId).capabilities,
    );
    const output = formatDoctorReadiness(result);
    expect(output).toContain(`Generator: ${adapterId}`);
    for (const capability of DOCUMENTATION_SOURCE_CAPABILITIES) {
      expect(output).toContain(
        `  ${capability}: ${resolveDocumentationSourceAdapter(adapterId as DocumentationSourceAdapterId).capabilities[capability]}`,
      );
    }
  });

  it("names an inventoried generator with no adapter without claiming capabilities", async () => {
    const fixture = await readyFixture();
    commitFixture(fixture.repository, true);
    await mkdir(resolve(fixture.repository, ".vitepress"));
    await writeFile(resolve(fixture.repository, ".vitepress/config.ts"), "fixture\n");
    execFileSync("git", ["add", "--", ".vitepress/config.ts"], { cwd: fixture.repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Doctor Test",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-qm",
        "generator fixture",
      ],
      { cwd: fixture.repository },
    );
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.documentationGenerators).toContainEqual(
      expect.objectContaining({ generator: "vitepress", adapterId: null, capabilities: null }),
    );
    expect(formatDoctorReadiness(result)).toContain(
      "Adapter: unavailable in the installed registry",
    );
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeCommands {
  constructor(
    private readonly repository: string,
    private readonly noRemote = false,
    private readonly detached = false,
    private readonly noTrackedProjectConfig = false,
  ) {}

  async run(
    command: "git" | "glab" | "npm",
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string }> {
    const inspectedArgs =
      command === "git" && args[0] === "-c" ? args.slice(SAFE_GIT_CONFIG.length) : args;
    const key = `${command} ${inspectedArgs.join(" ")}`;
    if (this.noRemote && key === "git remote") return { exitCode: 0, stdout: "" };
    if (this.detached && key === "git symbolic-ref --quiet --short HEAD")
      return { exitCode: 1, stdout: "" };
    if (this.noTrackedProjectConfig && key === "git ls-tree --name-only HEAD -- .docsfab.json")
      return { exitCode: 0, stdout: "" };
    const defaults: Record<string, { exitCode: number; stdout: string }> = {
      "git --version": { exitCode: 0, stdout: "git version 2.50.0\n" },
      "git rev-parse --show-toplevel": { exitCode: 0, stdout: `${this.repository}\n` },
      "git rev-parse --is-inside-work-tree": { exitCode: 0, stdout: "true\n" },
      "git symbolic-ref --quiet --short HEAD": { exitCode: 0, stdout: "main\n" },
      "git rev-parse --verify HEAD^{commit}": { exitCode: 0, stdout: `${"a".repeat(40)}\n` },
      [`git cat-file -e ${"a".repeat(40)}^{commit}`]: { exitCode: 0, stdout: "" },
      "git config --get user.name": { exitCode: 0, stdout: "Operator\n" },
      "git config --get user.email": { exitCode: 0, stdout: "operator@example.test\n" },
      "git ls-tree --name-only HEAD -- .docsfab.json": {
        exitCode: 0,
        stdout: ".docsfab.json\n",
      },
      "git status --porcelain=v1 --untracked-files=all": { exitCode: 0, stdout: "" },
      "git remote get-url --all origin": {
        exitCode: 0,
        stdout: "https://gitlab.example.test/group/project.git\n",
      },
      "git remote": { exitCode: 0, stdout: "origin\n" },
      "git remote get-url --push --all origin": {
        exitCode: 0,
        stdout: "https://gitlab.example.test/group/project.git\n",
      },
      "glab --version": { exitCode: 0, stdout: "glab 1.0\n" },
      "glab config get host": { exitCode: 0, stdout: "gitlab.example.test\n" },
      "npm --version": { exitCode: 0, stdout: "11.0.0\n" },
    };
    return defaults[key] ?? { exitCode: 1, stdout: "" };
  }

  async probeCredential(): Promise<"present" | "missing" | "unverified"> {
    return "present";
  }
}

describe("readiness by requested use (#1333)", () => {
  it("uses committed roots when working project config disagrees", async () => {
    const fixture = await readyFixture();
    const configPath = resolve(fixture.repository, ".docsfab.json");
    const base = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, `${JSON.stringify({ ...base, documentationRoots: ["docs"] })}\n`);
    commitFixture(fixture.repository, true);
    await writeFile(
      configPath,
      `${JSON.stringify({ ...base, documentationRoots: ["alternate"] })}\n`,
    );
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.projectConfiguration).toMatchObject({
      authority: "tracked",
      effectiveRoots: ["docs/"],
      checkout: "modified",
    });
    expect(result.useReadiness?.["local-review"].status).toBe("ready");
    expect(formatDoctorReadiness(result)).toContain("Effective documentation roots: docs/");
    expect(formatDoctorReadiness(result)).toContain("repository-source-dirty");
  });

  it.each(["missing", "untracked", "ignored", "staged"] as const)(
    "reports %s working configuration while local defaults remain ready",
    async (state) => {
      const fixture = await readyFixture();
      const configPath = resolve(fixture.repository, ".docsfab.json");
      if (state === "missing") await unlink(configPath);
      if (state === "ignored")
        await writeFile(resolve(fixture.repository, ".gitignore"), ".docsfab.json\n");
      commitFixture(fixture.repository, false);
      if (state === "staged") {
        execFileSync("git", ["add", "-f", ".docsfab.json"], { cwd: fixture.repository });
      }
      const result = await inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: fixture.environment,
        homeDirectory: fixture.home,
        loadConfiguration: () => loadableInferenceConfig(fixture),
        validateConfiguration: async () => undefined,
      });
      expect(result.projectConfiguration).toMatchObject({
        authority: "defaults",
        checkout: state,
        effectiveRoots: ["docs/", "fern/"],
      });
      expect(result.useReadiness?.["local-review"].status).toBe("ready");
      expect(result.useReadiness?.["local-patch"].status).toBe("ready");
      expect(result.useReadiness?.["draft-mr"].status).toBe("blocked");
      expect(result.useReadiness?.["draft-mr"].blockers).toContain(
        state === "missing" ? "no-supported-gitlab-remote" : "project-config-untracked",
      );
      expect(formatDoctorReadiness(result)).toContain(
        `draft-mr readiness: blocked; blockers: ${result.useReadiness?.["draft-mr"].blockers?.join(", ")}`,
      );
    },
  );

  it("reports a staged project edit without changing committed authority", async () => {
    const fixture = await readyFixture();
    const configPath = resolve(fixture.repository, ".docsfab.json");
    const base = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, `${JSON.stringify({ ...base, documentationRoots: ["docs"] })}\n`);
    commitFixture(fixture.repository, true);
    await writeFile(
      configPath,
      `${JSON.stringify({ ...base, documentationRoots: ["alternate"] })}\n`,
    );
    execFileSync("git", ["add", ".docsfab.json"], { cwd: fixture.repository });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.projectConfiguration).toMatchObject({
      authority: "tracked",
      checkout: "staged",
      effectiveRoots: ["docs/"],
    });
    expect(result.useReadiness?.["local-review"].status).toBe("ready");
    expect(result.useReadiness?.["local-review"].diagnostics.map((item) => item.code)).toContain(
      "repository-source-dirty",
    );
  });

  it("reports a staged rename into the uncommitted project config as staged", async () => {
    const fixture = await readyFixture();
    const configPath = resolve(fixture.repository, ".docsfab.json");
    const oldPath = resolve(fixture.repository, "former-config.json");
    await rename(configPath, oldPath);
    commitFixture(fixture.repository, false, ["former-config.json"]);
    await rename(oldPath, configPath);
    execFileSync("git", ["add", "-A", "--", ".docsfab.json", "former-config.json"], {
      cwd: fixture.repository,
    });
    const porcelain = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: fixture.repository,
      encoding: "utf8",
    });
    expect(porcelain).toContain("former-config.json -> .docsfab.json");

    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.projectConfiguration).toMatchObject({
      authority: "defaults",
      checkout: "staged",
      effectiveRoots: ["docs/", "fern/"],
    });
    expect(result.useReadiness?.["local-review"].status).toBe("ready");
    expect(result.useReadiness?.["draft-mr"].blockers).toContain("project-config-untracked");
  });

  it("keeps committed authority but reports a staged rename away as missing", async () => {
    const fixture = await readyFixture();
    commitFixture(fixture.repository, true);
    await rename(
      resolve(fixture.repository, ".docsfab.json"),
      resolve(fixture.repository, "former-config.json"),
    );
    execFileSync("git", ["add", "-A", "--", ".docsfab.json", "former-config.json"], {
      cwd: fixture.repository,
    });
    const porcelain = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: fixture.repository,
      encoding: "utf8",
    });
    expect(porcelain).toContain(".docsfab.json -> former-config.json");

    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.projectConfiguration).toMatchObject({
      authority: "tracked",
      checkout: "missing",
    });
    expect(result.useReadiness?.["local-review"].status).toBe("ready");
    expect(result.useReadiness?.["draft-mr"].blockers).toContain("project-config-missing");
  });

  it("uses defaults for malformed untracked configuration and blocks draft publication", async () => {
    const fixture = await readyFixture();
    commitFixture(fixture.repository, false);
    await writeFile(resolve(fixture.repository, ".docsfab.json"), '{"schemaVersion":2}\n');
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.projectConfiguration).toMatchObject({
      authority: "defaults",
      checkout: "untracked",
      effectiveRoots: ["docs/", "fern/"],
    });
    expect(result.useReadiness?.["local-review"].status).toBe("ready");
    expect(result.useReadiness?.["local-review"].diagnostics).toContainEqual(
      expect.objectContaining({
        code: "project-config-invalid",
        explanation: expect.stringContaining("default documentation roots"),
      }),
    );
    expect(result.useReadiness?.["draft-mr"].blockers).toContain("project-config-untracked");
  });

  it("keeps draft publication blocked when the tracked working file is absent", async () => {
    const fixture = await readyFixture();
    commitFixture(fixture.repository, true);
    await unlink(resolve(fixture.repository, ".docsfab.json"));
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.projectConfiguration).toMatchObject({
      authority: "tracked",
      checkout: "missing",
    });
    expect(result.useReadiness?.["local-review"].status).toBe("ready");
    expect(result.useReadiness?.["draft-mr"].blockers).toContain("project-config-missing");
  });

  it("keeps invalid committed config blocked despite valid working bytes", async () => {
    const fixture = await readyFixture();
    const configPath = resolve(fixture.repository, ".docsfab.json");
    const valid = await readFile(configPath, "utf8");
    await writeFile(configPath, '{"schemaVersion":2}\n');
    commitFixture(fixture.repository, true);
    await writeFile(configPath, valid);
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.projectConfiguration?.authority).toBe("invalid");
    expect(result.useReadiness?.["local-review"].blockers).toContain("project-config-invalid");
    expect(result.useReadiness?.["local-patch"].blockers).toContain("project-config-invalid");
  });
  it.each(["invalid working copy", "repaired working copy"] as const)(
    "blocks local uses when HEAD commits invalid project config with %s",
    async (workingCopy) => {
      const fixture = await readyFixture();
      const valid = await readFile(resolve(fixture.repository, ".docsfab.json"), "utf8");
      await writeFile(resolve(fixture.repository, ".docsfab.json"), '{"schemaVersion":2}\n');
      commitFixture(fixture.repository, true);
      if (workingCopy === "repaired working copy") {
        await writeFile(resolve(fixture.repository, ".docsfab.json"), valid);
      }
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: fixture.repository,
          workspacePath: fixture.repository,
          allowWrite: false,
          writeCapable: false,
          allowLocalUnconfigured: true,
        }),
      ).rejects.toThrow("invalid");
      const common = {
        cwd: fixture.repository,
        environment: fixture.environment,
        homeDirectory: fixture.home,
        loadConfiguration: () => loadableInferenceConfig(fixture),
        validateConfiguration: async () => undefined,
      };
      for (const use of ["local-review", "local-patch"] as const) {
        const result = await inspectDoctorReadiness({ ...common, use });
        expect(result.selectedUse).toBe(use);
        expect(result.status).toBe("blocked");
        expect(result.checks).toContainEqual({ area: "configuration", status: "blocked" });
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "project-config-invalid",
            nextCommand: expect.stringContaining("commit"),
          }),
        );
      }
    },
  );

  it.each(["missing", "untracked"] as const)(
    "keeps local review ready with %s project configuration that bootstrap skips",
    async (state) => {
      const fixture = await readyFixture();
      if (state === "missing") await unlink(resolve(fixture.repository, ".docsfab.json"));
      commitFixture(fixture.repository, false);
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: fixture.repository,
          workspacePath: fixture.repository,
          allowWrite: false,
          writeCapable: false,
          allowLocalUnconfigured: true,
        }),
      ).resolves.toMatchObject({ status: "skipped" });
      const result = await inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: fixture.environment,
        homeDirectory: fixture.home,
        loadConfiguration: () => loadableInferenceConfig(fixture),
        validateConfiguration: async () => undefined,
      });
      expect(result.status).toBe("ready");
      expect(result.useReadiness!["local-patch"].status).toBe("ready");
      expect(result.useReadiness!["draft-mr"].status).toBe("blocked");
    },
  );

  it("keeps local review ready when valid HEAD config has malformed working-copy edits", async () => {
    const fixture = await readyFixture();
    commitFixture(fixture.repository, true);
    await writeFile(resolve(fixture.repository, ".docsfab.json"), '{"schemaVersion":2}\n');
    await expect(
      bootstrapMissingProjectConfigIntoWorkspace({
        sourcePath: fixture.repository,
        workspacePath: fixture.repository,
        allowWrite: false,
        writeCapable: false,
        allowLocalUnconfigured: true,
      }),
    ).resolves.toMatchObject({ status: "tracked" });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.status).toBe("ready");
    expect(result.useReadiness!["local-patch"].status).toBe("ready");
    expect(result.projectConfiguration).toMatchObject({
      authority: "tracked",
      checkout: "modified",
      effectiveRoots: ["docs/", "fern/"],
    });
    expect(result.useReadiness!["draft-mr"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "project-config-invalid" }),
    );
  });

  it("keeps a detached revision ready for local review while blocking draft-MR", async () => {
    const fixture = await readyFixture();
    const common = {
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, false, true),
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    };
    expect((await inspectDoctorReadiness(common)).status).toBe("ready");
    const draft = await inspectDoctorReadiness({ ...common, use: "draft-mr" });
    expect(draft.status).toBe("blocked");
    expect(draft.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-state-blocked" }),
    );
  });
  it("names a remote-less draft-MR blocker without recommending init", async () => {
    const fixture = await readyFixture();
    await unlink(resolve(fixture.repository, ".docsfab.json"));
    commitFixture(fixture.repository, false);
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, true, false, true),
      use: "draft-mr",
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.status).toBe("blocked");
    const condition = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "no-supported-gitlab-remote",
    );
    expect(condition?.nextCommand).toBe(NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION);
    expect(condition?.nextCommand).not.toContain("docsfab init");
  });
  it("blocks a symlinked configuration root even for local review", async () => {
    const fixture = await readyFixture();
    const canonical = resolve(fixture.root, "canonical-config");
    const alias = resolve(fixture.root, "alias-config");
    await mkdir(canonical);
    await chmod(canonical, 0o700);
    await symlink(canonical, alias);
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: { ...fixture.environment, DOCSFAB_CONFIG_ROOT: alias },
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "configuration-root-not-canonical",
        nextCommand: expect.stringContaining("DOCSFAB_CONFIG_ROOT"),
      }),
    );
  });

  it("reports macOS native lint as a limitation without blocking local review", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      platform: "darwin",
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });
    expect(result.status).toBe("ready");
    expect(result.limitations).toContainEqual(
      expect.objectContaining({
        code: "native-lint-platform-unavailable",
        explanation: expect.stringContaining("bubblewrap"),
      }),
    );
  });
  it("allows local review without init while draft-MR names the missing project configuration", async () => {
    const fixture = await readyFixture();
    await unlink(resolve(fixture.repository, ".docsfab.json"));
    commitFixture(fixture.repository, false);
    const common = {
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, false, false, true),
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    };
    const review = await inspectDoctorReadiness(common);
    const draft = await inspectDoctorReadiness({ ...common, use: "draft-mr" });
    expect(review.selectedUse).toBe("local-review");
    expect(review.status).toBe("ready");
    expect(draft.status).toBe("blocked");
    expect(draft.useReadiness?.["draft-mr"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "project-config-missing" }),
    );
    for (const use of Object.values(draft.useReadiness ?? {})) {
      for (const check of use.checks) {
        if (check.status === "blocked") {
          expect(
            use.diagnostics.some(
              (diagnostic) =>
                diagnostic.area === check.area && diagnostic.explanation && diagnostic.nextCommand,
            ),
          ).toBe(true);
        }
      }
    }
  });
});

describe("doctor composition-retired NEXT (#1512)", () => {
  it("reports a retired raw GPT-5.6 profile as composition-retired with the setup remediation", async () => {
    const fixture = await readyFixture();
    const retiredProfile = {
      MODEL_PROVIDER: "nvidia-inference-api",
      MODEL_BASE_URL: HUB_BASE_URL,
      MODEL_ID: "switchyard/openai/gpt-5.6-sol",
      MODEL_API_FORMAT: "chat_completions",
      MODEL_API_KEY: "doctor-retired-placeholder-not-a-credential",
    };

    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => {
        // The real loader path: the retired id refuses before field checks.
        parseModelEndpoint(retiredProfile);
        throw new Error("The retired model id must refuse before any configuration loads.");
      },
      validateConfiguration: async () => undefined,
    });

    const provider = result.diagnostics.filter((item) => item.area === "provider");
    expect(provider).toEqual([
      expect.objectContaining({
        code: "composition-retired",
        nextCommand:
          "GPT-5.6 is retired; run `docsfab setup --profile nvidia-inference-gpt-6-sol-pi` to move to GPT-6 Sol with `MODEL_API_KEY`, or choose another model with `docsfab setup` in a terminal.",
      }),
    ]);
    expect(provider[0]?.explanation).toMatch(
      /^Model selection "switchyard\/openai\/gpt-5\.6-sol" is retired \(superseded-by-operator-decision/u,
    );
    // The neighboring classes do not fire for the same failure.
    expect(result.diagnostics.map((item) => item.code)).not.toContain(
      "provider-configuration-invalid",
    );
    expect(result.diagnostics.map((item) => item.code)).not.toContain(
      "provider-credentials-missing",
    );
    expect(formatDoctorReadiness(result)).toContain("docsfab setup");
  });
});

describe("doctor composition-retired at registration (#1512)", () => {
  it("reports a retired refusal from model registration as composition-retired, not provider-runtime-unavailable", async () => {
    const fixture = await readyFixture();
    const nextAction =
      "Select its successor, `nvidia-inference-gpt-6-sol-pi`; the retired record is retained only so completed run records keep rebinding to it.";
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () =>
        ({
          projectRoot: fixture.repository,
          skillCrateDirectory: fixture.repository,
          qualityDirectory: fixture.repository,
          qualityPackDirectory: fixture.repository,
          stateDirectory: fixture.privateRoots.runs,
          retryPolicy: {
            maxRetries: 0,
            baseDelayMs: 1_000,
            maxDelayMs: 2_000,
            retryableCategories: ["timeout"],
          },
          // A real, loadable live profile: the failure under test is the
          // retired refusal thrown by model registration, not the load.
          model: loadModelConfigurations({
            ...Object.fromEntries(
              resolveEvalPresetFieldBlock("nvidia/nvidia/nemotron-3-super-v3").assignments ?? [],
            ),
            MODEL_API_KEY: "doctor-registration-placeholder-not-a-credential",
          }).model,
        }) as DocsFabConfig,
      validateConfiguration: async () => {
        const refusal = new ModelCompositionError(
          "composition-retired",
          'Composition "openai-gpt-5.6-sol-pi" is retired (superseded-by-operator-decision, effective 2026-09-28T00:00:00.000Z) and cannot be selected for a new execution.',
          nextAction,
        );
        throw refusal;
      },
    });
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).toContain("composition-retired");
    expect(codes).not.toContain("provider-runtime-unavailable");
    expect(result.diagnostics.find((item) => item.code === "composition-retired")).toMatchObject({
      nextCommand: nextAction,
    });
  });
});

describe("doctor provider-credentials-missing NEXT", () => {
  it("prints exactly one seed argv and does not write .env", async () => {
    const fixture = await readyFixture();
    const envPath = resolve(fixture.root, ".env");
    await writeFile(envPath, "MODEL_API_KEY=\n", { mode: 0o600 });
    const before = await readFile(envPath, "utf8");

    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => {
        throw { issues: [{ field: "MODEL_API_KEY" }] };
      },
      validateConfiguration: async () => undefined,
    });

    const missing = result.diagnostics.filter(
      (item) => item.code === "provider-credentials-missing",
    );
    expect(missing).toEqual([
      expect.objectContaining({
        nextCommand: "docsfab setup",
      }),
    ]);
    expect(missing[0]?.nextCommand).toBe(
      doctorDiagnosticRemediation("provider-credentials-missing", "docsfab profile inspect"),
    );
    const output = formatDoctorReadiness(result);
    expect(output).toContain("Next action: docsfab setup");
    expect(output).not.toMatch(/profile inspect/u);
    expect([...output.matchAll(/docsfab setup/gu)]).toHaveLength(1);

    const after = await readFile(envPath, "utf8");
    expect(after).toBe(before);
  });

  it("keeps an incomplete loaded profile on the seed argv without writing .env", async () => {
    const fixture = await readyFixture();
    const envPath = resolve(fixture.repository, ".env");
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () =>
        ({
          projectRoot: fixture.repository,
          skillCrateDirectory: fixture.repository,
          qualityDirectory: fixture.repository,
          qualityPackDirectory: fixture.repository,
          stateDirectory: fixture.privateRoots.runs,
          retryPolicy: {
            maxRetries: 0,
            baseDelayMs: 1_000,
            maxDelayMs: 2_000,
            retryableCategories: ["timeout"],
          },
          model: { apiKey: "", providerId: "test-provider", modelId: "example/model" },
        }) as DocsFabConfig,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "provider-credentials-missing",
        nextCommand: "docsfab setup",
      }),
    );
    await expect(access(envPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("doctor Metadata absence vs inference missing-key", () => {
  it("does not block ordinary inference doctor when Metadata env is empty", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: {
        ...fixture.environment,
        INFERENCE_HUB_METADATA_API_KEY: "",
        INFERENCE_HUB_METADATA_ORIGIN: "",
        INFERENCE_HUB_METADATA_PATH: "",
        INFERENCE_HUB_METADATA_MODE: "",
        MODEL_INFERENCE_HUB_METADATA_LABEL: "",
      },
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });

    expect(result.diagnostics.map((item) => item.code)).not.toContain(
      "provider-credentials-missing",
    );
    expect(result.diagnostics.map((item) => item.code)).not.toContain(
      "provider-configuration-invalid",
    );
    expect(result.checks).toContainEqual({ area: "provider", status: "ready" });
    expect(result.status).toBe("ready");
    const output = formatDoctorReadiness(result);
    expect(output).not.toMatch(/--catalog/u);
    expect(output).not.toMatch(/unify|same key|one NVIDIA key/iu);
  });

  it("keeps Metadata-only load failures off run-blocking inference codes", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => {
        throw { issues: [{ field: "INFERENCE_HUB_METADATA_API_KEY" }] };
      },
      validateConfiguration: async () => undefined,
    });

    expect(result.diagnostics.map((item) => item.code)).toEqual(["metadata-api-key-missing"]);
    expect(result.checks).toContainEqual({ area: "provider", status: "ready" });
    expect(result.status).toBe("ready");
    expect(result.diagnostics[0]?.nextCommand).not.toMatch(/--catalog|docsfab setup/u);
    expect(result.autoModesReady).toEqual(["dry-run", "patch-only"]);
  });

  it("still uses the inference missing-key code when MODEL_API_KEY is absent", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: {
        ...fixture.environment,
        INFERENCE_HUB_METADATA_API_KEY: "",
      },
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => {
        throw {
          issues: [{ field: "MODEL_API_KEY" }, { field: "INFERENCE_HUB_METADATA_API_KEY" }],
        };
      },
      validateConfiguration: async () => undefined,
    });

    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "provider-credentials-missing",
      "metadata-api-key-missing",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "provider-credentials-missing",
        nextCommand: "docsfab setup",
      }),
    );
    expect(formatDoctorReadiness(result)).not.toMatch(/--catalog/u);
    expect(result.checks).toContainEqual({ area: "provider", status: "blocked" });
  });
});

describe("doctor private-state NEXT", () => {
  it("prints the prompt-free preview-then-digest apply sequence from usage", () => {
    const next = doctorDiagnosticRemediation("private-state-missing", "docsfab init");
    expect(next).toBe(remediationText("init"));
    expect(next).toBe(doctorDiagnosticRemediation("private-state-unsafe", "docsfab init"));
    expect(next).toContain("docsfab init --non-interactive");
    expect(next).toContain("--approve-plan-sha256 <digest>");
    expect(next).not.toBe("docsfab init");
    expect(next).not.toMatch(/docsfab init --apply(?:\s|$)/u);
    expect(initHelp()).toContain("--non-interactive --apply");
    expect(initHelp()).toContain("--approve-plan-sha256 <digest>");
    expect(usage()).toContain("--approve-plan-sha256 <digest>");
  });
});

describe("doctor ready NEXT", () => {
  it("prints exactly one catalog next command only when readiness succeeds", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => loadableInferenceConfig(fixture),
      validateConfiguration: async () => undefined,
    });

    expect(result.status).toBe("ready");
    const output = formatDoctorReadiness(result);
    expect([...output.matchAll(/NEXT docsfab list/gu)]).toHaveLength(1);
  });
});

describe("doctor profile evidence on a ready host (#1094)", () => {
  // Everything else is ready, so only the evidence rule decides the provider
  // area: a non-blocking diagnostic would leave doctor ready and send
  // `doctor --catalog` on to the inspection that raises the same defect.
  async function readiness(modelId: string) {
    const fixture = await readyFixture();
    return inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => loadableInferenceConfig(fixture, { MODEL_ID: modelId }),
      validateConfiguration: async () => undefined,
    });
  }

  it("blocks the provider when the model id cannot form evidence", async () => {
    const result = await readiness("llama3:8b");
    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual({ area: "provider", status: "blocked" });
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "provider-profile-evidence-invalid",
    ]);
    expect(operatorCodeFailureClass("provider-profile-evidence-invalid")).toBe("operator-input");
  });

  it("stays ready when the same host's model id forms evidence", async () => {
    const result = await readiness("example/model");
    expect(result.status).toBe("ready");
    expect(result.checks).toContainEqual({ area: "provider", status: "ready" });
    expect(result.diagnostics).toEqual([]);
  });
});

function loadableInferenceConfig(
  fixture: {
    repository: string;
    privateRoots: ReturnType<typeof resolveDocsFabPrivateRoots>;
  },
  overrides: Readonly<Record<string, string>> = {},
): DocsFabConfig {
  return {
    projectRoot: fixture.repository,
    skillCrateDirectory: fixture.repository,
    qualityDirectory: fixture.repository,
    qualityPackDirectory: fixture.repository,
    stateDirectory: fixture.privateRoots.runs,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      retryableCategories: ["timeout"],
    },
    // A complete endpoint: doctor readiness also checks its evidence.
    model: parseModelEndpoint(
      {
        MODEL_PROVIDER: "test-provider",
        MODEL_BASE_URL: "https://inference.example.test/v1/",
        MODEL_ID: "example/model",
        MODEL_API_FORMAT: "chat_completions",
        MODEL_API_KEY: "test-secret",
        MODEL_CONTEXT_WINDOW: "128000",
        MODEL_MAX_OUTPUT_TOKENS: "16384",
        MODEL_API_MIN_OUTPUT_TOKENS: "16",
        MODEL_CONTEXT_RESERVE_TOKENS: "4096",
        MODEL_REASONING: "true",
        MODEL_INPUT_TYPES: "text,image",
        MODEL_SUPPORTS_DEVELOPER_ROLE: "true",
        MODEL_SUPPORTS_REASONING_EFFORT: "true",
        MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
        MODEL_INPUT_COST_PER_MILLION: "1.25",
        MODEL_OUTPUT_COST_PER_MILLION: "10",
        MODEL_CACHE_READ_COST_PER_MILLION: "0.5",
        MODEL_CACHE_WRITE_COST_PER_MILLION: "unknown",
        MODEL_PROFILE_APPROVED_SOURCE: "https://metadata.example.test/models/example-model",
        MODEL_PROFILE_EFFECTIVE_DATE: "2020-01-01",
        MODEL_PROFILE_REVIEW_AFTER: "2099-12-31",
        ...overrides,
      },
      "MODEL",
    ),
  } as DocsFabConfig;
}

function commitFixture(
  repository: string,
  includeProjectConfig: boolean,
  additionalTrackedPaths: readonly string[] = [],
): void {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Doctor Test",
        "-c",
        "user.email=doctor@example.test",
        ...args,
      ],
      { cwd: repository, stdio: "pipe" },
    );
  git("init", "-q", "-b", "main");
  git(
    "add",
    "--",
    "package.json",
    ...(includeProjectConfig ? [".docsfab.json"] : []),
    ...additionalTrackedPaths,
  );
  git("commit", "-qm", "fixture");
}

async function readyFixture(): Promise<{
  root: string;
  repository: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  privateRoots: ReturnType<typeof resolveDocsFabPrivateRoots>;
}> {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-doctor-seed-next-")));
  roots.push(root);
  const repositoryPath = resolve(root, "repository");
  const home = resolve(root, "home");
  const state = resolve(root, "state");
  await Promise.all([mkdir(repositoryPath), mkdir(home), mkdir(state)]);
  const repository = await realpath(repositoryPath);
  await writeFile(
    resolve(repository, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(repository, "package.json"),
    JSON.stringify({
      scripts: { check: "node validate.js" },
    }),
  );
  const environment = { XDG_STATE_HOME: state };
  const privateRoots = resolveDocsFabPrivateRoots(repository, environment, home);
  await Promise.all(
    Object.values(privateRoots).map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  return { root, repository, home, environment, privateRoots };
}
