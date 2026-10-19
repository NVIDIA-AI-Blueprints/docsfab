// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { canonicalizeAcceptanceOutputRoot } from "../src/acceptance.js";
import { runAcceptanceCli } from "../src/acceptance-cli.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { defaultExecutionHostConfig } from "../src/config/profile-projection.js";
import { writeHostConfigFile, writeSecretsEnvFile } from "../src/config/split-layout.js";
import * as setupBootstrap from "../src/setup/bootstrap.js";
import { limit } from "../src/config/limits.js";
import { loadModelConfigurations, ModelProfileMigrationError } from "../src/model/configuration.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import {
  LIVE_MODEL_CI_COMPOSITION_ID,
  liveModelApproveUrl,
  prepareLiveModelCiConfig,
} from "../scripts/prepare-live-model-ci-config.js";
import { validModelEnvironment } from "./helpers.js";
import { internalOnly } from "./helpers/internal-path.js";
import { temporaryRoots } from "./helpers/temp.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const runtimeRun = join(repositoryRoot, ".gitlab/ci/runtime-run.sh");
const roots = temporaryRoots();
const ciWrapper = internalOnly(
  ".gitlab/ci/runtime-run.sh",
  "it runs the GitLab CI job wrapper, which is not exported",
);
const ciPipeline = internalOnly(
  ".gitlab/ci/runtime.yml",
  "it pins the GitLab CI definition, which is not exported",
);

async function scratch(prefix: string): Promise<string> {
  const root = await roots.create(prefix, { realpath: true });
  return root;
}

describe("live-model CI root contract", () => {
  it("refuses output roots inside packages/runtime after only isolated root discovery", async () => {
    const calls: string[] = [];
    await expect(
      runAcceptanceCli(
        [
          "--state-dir",
          join(runtimeRoot, "live-model-state"),
          "--evidence-dir",
          join(runtimeRoot, "live-model-evidence"),
        ],
        {
          repositoryRoot: runtimeRoot,
          isolateOffline: async () => ({ commandPrefix: [] }),
          execute: async (command) => {
            calls.push([command.file, ...command.args].join(" "));
            return { exitCode: 0, stdout: `${repositoryRoot}\n`, stderr: "" };
          },
        },
      ),
    ).rejects.toThrow("must be outside the source repository");
    expect(calls).toEqual(["git rev-parse --show-toplevel"]);
  });

  it("canonicalizes private roots outside the source repository", async () => {
    const root = await scratch("docsfab-live-model-root-");
    const state = join(root, "state");
    const evidence = join(root, "evidence");
    await expect(canonicalizeAcceptanceOutputRoot(state, runtimeRoot, "--state-dir")).resolves.toBe(
      state,
    );
    await expect(
      canonicalizeAcceptanceOutputRoot(evidence, runtimeRoot, "--evidence-dir"),
    ).resolves.toBe(evidence);
  });
});

describe("live-model CI composition projection", () => {
  it("rejects four MODEL_* fields plus a credential as an incomplete profile", () => {
    expect(() =>
      loadModelConfigurations({
        MODEL_PROVIDER: "nvidia",
        MODEL_ID: "azure/openai/gpt-6-sol",
        MODEL_BASE_URL: HUB_BASE_URL,
        MODEL_API_FORMAT: "chat_completions",
        MODEL_API_KEY: "ci-test-placeholder",
      }),
    ).toThrow(ModelProfileMigrationError);
  });

  it("does not bind the claimed composition when MODEL_PROVIDER is deployment.provider", async () => {
    const loaded = loadModelConfigurations({
      ...validModelEnvironment,
      MODEL_PROVIDER: "nvidia",
      MODEL_ID: "azure/openai/gpt-6-sol",
      MODEL_BASE_URL: HUB_BASE_URL,
      MODEL_API_FORMAT: "chat_completions",
      MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
    });
    const bound = await resolveOperatorExecutionBinding({
      model: loaded.model,
      environment: { MODEL_API_KEY: "ci-test-placeholder" },
    });
    expect(bound.match).toBe("unmatched-byo");
    expect(bound.bound?.composition.compositionId).not.toBe(LIVE_MODEL_CI_COMPOSITION_ID);
  });

  it("loads the canonical host projection and binds the installed composition without a provider call", async () => {
    const configurationRoot = await scratch("docsfab-live-model-config-");
    await prepareLiveModelCiConfig({
      configurationRoot,
      modelApiKey: "ci-test-placeholder",
    });
    const config = loadConfig({ DOCSFAB_CONFIG_ROOT: configurationRoot });
    expect(config.model.providerId).toBe("nvidia-inference-api");
    expect(config.model.baseUrl).toBe(liveModelApproveUrl());
    expect(config.model.modelId).toBe("azure/openai/gpt-6-sol");
    expect(config.model.profile.configuredLimits.contextWindow).toBeGreaterThan(0);
    const bound = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: { MODEL_API_KEY: "ci-test-placeholder" },
    });
    expect(bound.match).toBe("installed-composition");
    expect(bound.bound?.composition.compositionId).toBe(LIVE_MODEL_CI_COMPOSITION_ID);
    expect(bound.profile.routeId).toBe("nvidia-inference-api");
    expect(bound.credential.family).toBe("nvidia-inference-api");
  });

  it("calls through to supported setup with the selected composition and received environment", async () => {
    const configurationRoot = await scratch("docsfab-live-model-call-through-");
    const actual = setupBootstrap.runSetupBootstrap;
    const bootstrap = vi.spyOn(setupBootstrap, "runSetupBootstrap").mockImplementation(actual);
    vi.stubEnv("MODEL_PROVIDER", "unwanted-provider");
    vi.stubEnv("MODEL_ID", "unwanted-model");
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", "/unwanted-root");
    vi.stubEnv("MODEL_API_KEY", "should-not-leak");
    try {
      await prepareLiveModelCiConfig({ configurationRoot, modelApiKey: "ci-test-placeholder" });
      expect(bootstrap).toHaveBeenCalledOnce();
      const call = bootstrap.mock.calls[0]?.[0];
      expect(call?.profile).toBe(LIVE_MODEL_CI_COMPOSITION_ID);
      expect(call?.purpose).toBe("setup");
      expect(call?.environment.DOCSFAB_CONFIG_ROOT).toBe(configurationRoot);
      expect(call?.environment.MODEL_API_KEY).toBe("ci-test-placeholder");
      expect(call?.environment.MODEL_PROVIDER).toBe("unwanted-provider");
      expect(call?.environment.MODEL_ID).toBe("unwanted-model");
      const config = loadConfig({ DOCSFAB_CONFIG_ROOT: configurationRoot });
      const bound = await resolveOperatorExecutionBinding({
        model: config.model,
        environment: { MODEL_API_KEY: "ci-test-placeholder" },
      });
      expect(bound.bound?.composition.compositionId).toBe(LIVE_MODEL_CI_COMPOSITION_ID);
    } finally {
      bootstrap.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("preserves host settings and unrelated secrets while the supplied key wins on a repeated root", async () => {
    const configurationRoot = await scratch("docsfab-live-model-repeat-");
    await writeHostConfigFile(configurationRoot, {
      ...defaultExecutionHostConfig("nvidia-inference-claude-sonnet-5-pi"),
      paths: { stateDir: "./retained-state" },
    });
    await writeSecretsEnvFile(configurationRoot, [
      ["MODEL_API_KEY", "should-not-leak"],
      ["OPENAI_API_KEY", "should-not-leak"],
    ]);
    await writeFile(join(configurationRoot, ".env"), "MODEL_API_KEY=should-not-leak\n");
    await prepareLiveModelCiConfig({ configurationRoot, modelApiKey: "ci-test-placeholder" });
    await prepareLiveModelCiConfig({ configurationRoot, modelApiKey: "ci-test-placeholder" });
    const host = parseYaml(await readFile(join(configurationRoot, "host.yaml"), "utf8")) as {
      paths: { stateDir: string };
      activeExecutionProfile: string;
    };
    expect(host.paths.stateDir).toBe("./retained-state");
    expect(host.activeExecutionProfile).toBe(LIVE_MODEL_CI_COMPOSITION_ID);
    const stored = await readFile(join(configurationRoot, "secrets.env"), "utf8");
    expect(stored).toContain("MODEL_API_KEY=ci-test-placeholder");
    expect(stored).toContain("OPENAI_API_KEY=should-not-leak");
    const config = loadConfig({ DOCSFAB_CONFIG_ROOT: configurationRoot });
    const bound = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: { MODEL_API_KEY: "ci-test-placeholder" },
    });
    expect(bound.bound?.composition.compositionId).toBe(LIVE_MODEL_CI_COMPOSITION_ID);
  });

  it("honors a received invalid secrets lock override before creating the root", async () => {
    const configurationRoot = join(await scratch("docsfab-live-model-lock-"), "new-root");
    vi.stubEnv("DOCSFAB_SECRETS_LOCK_RETRY_MS", "invalid");
    try {
      await expect(
        prepareLiveModelCiConfig({ configurationRoot, modelApiKey: "ci-test-placeholder" }),
      ).rejects.toThrow(/secrets-lock-override-invalid/u);
      await expect(readFile(join(configurationRoot, "host.yaml"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a blocked bootstrap status with a fixed safe next action", async () => {
    const configurationRoot = await scratch("docsfab-live-model-blocked-");
    const bootstrap = vi.spyOn(setupBootstrap, "runSetupBootstrap").mockResolvedValue({
      schemaVersion: 1,
      kind: "docsfab-setup-bootstrap",
      status: "blocked-missing-credential",
      configurationRoot,
      layout: "split",
      envPath: join(configurationRoot, ".env"),
      seeded: false,
      migrated: false,
      credentialSource: "none",
      nextCommand: "untrusted-next-command",
      explanation: "untrusted-secret-explanation",
    });
    try {
      let failure: unknown;
      try {
        await prepareLiveModelCiConfig({ configurationRoot, modelApiKey: "ci-test-placeholder" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "supported setup blocked-missing-credential; run docsfab setup.",
      );
      expect(bootstrap).toHaveBeenCalledOnce();
    } finally {
      bootstrap.mockRestore();
    }
  });

  it("refuses a non-normalized outside root before creating configuration", async () => {
    const parent = await scratch("docsfab-live-model-unormalized-");
    const configurationRoot = `${parent}/new/../target`;
    await expect(
      prepareLiveModelCiConfig({ configurationRoot, modelApiKey: "ci-test-placeholder" }),
    ).rejects.toThrow("DOCSFAB_CONFIG_ROOT must be one normalized absolute directory path.");
    await expect(readFile(join(parent, "target/host.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a configuration root inside the collected checkout", async () => {
    // secrets.env holds MODEL_API_KEY, and CI collects the checkout as artifacts,
    // so a root inside it would publish the credential. A manual job's player can
    // override the variable, so the value is checked, not trusted.
    const checkout = await scratch("docsfab-live-model-checkout-");
    for (const inside of [checkout, join(checkout, "packages/runtime/ci-results")]) {
      await expect(
        prepareLiveModelCiConfig({
          configurationRoot: inside,
          modelApiKey: "ci-test-placeholder",
          projectDirectory: checkout,
        }),
      ).rejects.toThrow(/must be outside CI_PROJECT_DIR/u);
    }

    // A root outside the checkout, and an unset CI_PROJECT_DIR, still work.
    const outside = await scratch("docsfab-live-model-outside-");
    await prepareLiveModelCiConfig({
      configurationRoot: outside,
      modelApiKey: "ci-test-placeholder",
      projectDirectory: checkout,
    });
    expect(loadConfig({ DOCSFAB_CONFIG_ROOT: outside }).model.providerId).toBe(
      "nvidia-inference-api",
    );

    // A sibling sharing the checkout's prefix is admitted: without the separator
    // in the prefix test, "<checkout>-x" would read as inside "<checkout>".
    const sibling = `${checkout}-adjacent`;
    await mkdir(sibling, { recursive: true });
    await chmod(sibling, 0o700);
    roots.track(sibling);
    await prepareLiveModelCiConfig({
      configurationRoot: sibling,
      modelApiKey: "ci-test-placeholder",
      projectDirectory: checkout,
    });
    expect(loadConfig({ DOCSFAB_CONFIG_ROOT: sibling }).model.providerId).toBe(
      "nvidia-inference-api",
    );
  });

  it("refuses a configuration root reached through a symlink", async () => {
    // resolve() does not follow symlinks, so a root through one would compare as
    // outside the checkout while writing inside the checkout, as
    // DOCSFAB_CONFIG_ROOT=/proc/self/cwd/... does on Linux.
    const parent = await scratch("docsfab-live-model-symlink-");
    const checkout = join(parent, "checkout");
    await mkdir(join(checkout, "ci-results"), { recursive: true });
    const link = join(parent, "link");
    await symlink(checkout, link, "dir");

    await expect(
      prepareLiveModelCiConfig({
        configurationRoot: join(link, "ci-results", "mr-assessment"),
        modelApiKey: "ci-test-placeholder",
        projectDirectory: checkout,
      }),
    ).rejects.toThrow(/must be outside CI_PROJECT_DIR/u);

    // The checkout may sit under a symlink (macOS /tmp is /private/tmp), and a
    // root outside it is still admitted.
    const outside = join(parent, "outside");
    await mkdir(outside, { recursive: true });
    await chmod(outside, 0o700);
    await prepareLiveModelCiConfig({
      configurationRoot: outside,
      modelApiKey: "ci-test-placeholder",
      projectDirectory: link,
    });
    expect(loadConfig({ DOCSFAB_CONFIG_ROOT: outside }).model.providerId).toBe(
      "nvidia-inference-api",
    );
  });

  it("refuses a root inside a checkout that is given through a symlink", async () => {
    // CI_PROJECT_DIR may be a symlink: canonicalising only the root would let a
    // root inside the checkout read as outside it, and secrets.env would land in
    // the collected artifacts.
    const parent = await scratch("docsfab-live-model-checkout-link-");
    const checkout = join(parent, "checkout");
    await mkdir(join(checkout, "ci-results"), { recursive: true });
    const link = join(parent, "link");
    await symlink(checkout, link, "dir");
    const canonicalCheckout = await realpath(checkout);

    for (const inside of [
      join(link, "ci-results"),
      join(link, "ci-results", "mr-assessment"),
      join(canonicalCheckout, "ci-results", "mr-assessment"),
    ]) {
      await expect(
        prepareLiveModelCiConfig({
          configurationRoot: inside,
          modelApiKey: "ci-test-placeholder",
          projectDirectory: link,
        }),
      ).rejects.toThrow(/must be outside CI_PROJECT_DIR/u);
    }
  });
});

describe.skipIf(ciWrapper.skip)(ciWrapper.title("live-model CI wrapper isolation"), () => {
  async function childEnv(
    jobName: string,
    extra: NodeJS.ProcessEnv = {},
    command: readonly string[] = ["printenv"],
  ): Promise<string> {
    const bin = await scratch("docsfab-runtime-run-bin-");
    const runuser = join(bin, "runuser");
    const printenvShim = `#!/usr/bin/env bash
printenv
`;
    await writeFile(
      runuser,
      `#!/usr/bin/env bash
shift
shift
shift
exec "$@"
`,
      { encoding: "utf8" },
    );
    await chmod(runuser, 0o755);
    await writeFile(join(bin, "npm"), printenvShim, { encoding: "utf8" });
    await chmod(join(bin, "npm"), 0o755);
    await writeFile(join(bin, "node"), printenvShim, { encoding: "utf8" });
    await chmod(join(bin, "node"), 0o755);
    const result = spawnSync("bash", [runtimeRun, ...command], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CI_PROJECT_DIR: repositoryRoot,
        HOME: join(bin, "home"),
        DOCSFAB_TEST_TRUSTED_ROOT: join(bin, "tmp"),
        npm_config_cache: join(bin, "npm-cache"),
        CI_JOB_NAME: jobName,
        CI: "true",
        CI_COMMIT_SHA: "abc123",
        PI_OFFLINE: jobName === "runtime:live-model" ? "0" : "1",
        MODEL_API_KEY: "should-not-leak",
        DOCSFAB_NVIDIA_API_KEY: "should-not-leak",
        MODEL_PROVIDER: "nvidia",
        MODEL_ID: "azure/openai/gpt-6-sol",
        MODEL_API_FORMAT: "chat_completions",
        DOCSFAB_ACCEPTANCE_LIVE: "true",
        DOCSFAB_CONFIG_ROOT: join(bin, "config"),
        CI_JOB_TOKEN: "job-token-must-drop",
        ...extra,
      },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `runtime-run.sh exited ${result.status}`);
    }
    return result.stdout;
  }

  const livePrepare = [
    "node",
    "--import",
    "tsx",
    "scripts/prepare-live-model-ci-config.ts",
  ] as const;
  const livePrintUrl = [...livePrepare, "--print-approve-url"] as const;

  it("runs the shipped helper and approval URL through the real scrubbed wrapper", async () => {
    const bin = await scratch("docsfab-live-model-real-bin-");
    const configurationRoot = await scratch("docsfab-live-model-real-config-");
    const runuser = join(bin, "runuser");
    await writeFile(runuser, '#!/usr/bin/env bash\nshift\nshift\nshift\nexec "$@"\n');
    await chmod(runuser, 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: bin,
      CI_PROJECT_DIR: repositoryRoot,
      DOCSFAB_TEST_TRUSTED_ROOT: bin,
      CI_JOB_NAME: "runtime:live-model",
      CI: "true",
      PI_OFFLINE: "0",
      DOCSFAB_CONFIG_ROOT: configurationRoot,
      MODEL_API_KEY: "ci-test-placeholder",
      MODEL_PROVIDER: "unwanted-provider",
      MODEL_ID: "unwanted-model",
      DOCSFAB_SECRETS_LOCK_RETRY_MS: "invalid",
    };
    const prepared = spawnSync("bash", [runtimeRun, ...livePrepare], {
      encoding: "utf8",
      env: environment,
    });
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).not.toContain("ci-test-placeholder");
    const config = loadConfig({ DOCSFAB_CONFIG_ROOT: configurationRoot });
    const bound = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: { MODEL_API_KEY: "ci-test-placeholder" },
    });
    expect(bound.bound?.composition.compositionId).toBe(LIVE_MODEL_CI_COMPOSITION_ID);
    const approval = spawnSync("bash", [runtimeRun, ...livePrintUrl], {
      encoding: "utf8",
      env: environment,
    });
    expect({ status: approval.status, stdout: approval.stdout.trim() }).toEqual({
      status: 0,
      stdout: liveModelApproveUrl(),
    });

    const missingKey = spawnSync("bash", [runtimeRun, ...livePrepare], {
      encoding: "utf8",
      env: { ...environment, MODEL_API_KEY: "" },
    });
    expect(missingKey.status).toBe(1);
    expect(missingKey.stderr).toContain("requires a non-empty MODEL_API_KEY");
  });

  it("drops live credentials and MODEL_* identity from ordinary offline children", async () => {
    const env = await childEnv("runtime:test");
    expect(env).toMatch(/^PI_OFFLINE=1$/m);
    expect(env).toMatch(/^CI_COMMIT_SHA=abc123$/m);
    expect(env).toMatch(/^CI=true$/m);
    expect(env).not.toMatch(/^MODEL_API_KEY=/m);
    expect(env).not.toMatch(/^DOCSFAB_NVIDIA_API_KEY=/m);
    expect(env).not.toMatch(/^MODEL_PROVIDER=/m);
    expect(env).not.toMatch(/^MODEL_ID=/m);
    expect(env).not.toMatch(/^MODEL_API_FORMAT=/m);
    expect(env).not.toMatch(/^DOCSFAB_ACCEPTANCE_LIVE=/m);
    expect(env).not.toMatch(/^CI_JOB_TOKEN=/m);
  });

  it("forwards MODEL_API_KEY only to live-model configuration preparation", async () => {
    const prepare = await childEnv("runtime:live-model", {}, livePrepare);
    expect(prepare).toMatch(/^PI_OFFLINE=0$/m);
    expect(prepare).toMatch(/^MODEL_API_KEY=should-not-leak$/m);
    expect(prepare).toMatch(/^DOCSFAB_ACCEPTANCE_LIVE=true$/m);
    expect(prepare).toMatch(/^DOCSFAB_CONFIG_ROOT=/m);
    expect(prepare).not.toMatch(/^MODEL_PROVIDER=/m);
    expect(prepare).not.toMatch(/^DOCSFAB_NVIDIA_API_KEY=/m);
    expect(prepare).not.toMatch(/^CI_JOB_TOKEN=/m);
  });

  it("withholds MODEL_API_KEY from npm ci, URL projection, and unrelated live-model children", async () => {
    for (const command of [
      ["npm", "ci"],
      livePrintUrl,
      ["printenv"],
      ["npm", "run", "acceptance"],
      ["npm", "ci", "prepare-live-model-ci-config.ts"],
      ["node", "/tmp/prepare-live-model-ci-config.ts"],
      ["node", "--import", "tsx", "/tmp/prepare-live-model-ci-config.ts"],
      [...livePrepare, "extra"],
    ] as const) {
      const env = await childEnv("runtime:live-model", {}, command);
      expect(env).not.toMatch(/^MODEL_API_KEY=/m);
      expect(env).toMatch(/^DOCSFAB_ACCEPTANCE_LIVE=true$/m);
      expect(env).not.toMatch(/^CI_JOB_TOKEN=/m);
    }
  });
});

describe.skipIf(ciPipeline.skip)(ciPipeline.title("live-model CI pipeline wiring"), () => {
  it.each([0, 1, 37])(
    "passes the collect destination to acceptance and preserves child exit %s",
    async (exitCode) => {
      const pipeline = parseYaml(
        await readFile(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8"),
      ) as Record<string, { script: string[]; artifacts: { when: string; paths: string[] } }>;
      const job = pipeline["runtime:live-model"]!;
      const acceptance = job.script.find((command) => command.includes("npm run acceptance --"))!;
      const trustedRootName = /--state-dir "\$([A-Z_][A-Z0-9_]*)\/live-model-state"/u.exec(
        acceptance,
      )![1]!;
      const root = await scratch("docsfab-live-model-exit-");
      const checkout = join(root, "checkout"),
        privateRoot = join(root, "private");
      const capture = join(root, "acceptance-argv.txt");
      await mkdir(join(checkout, ".gitlab", "ci"), { recursive: true });
      await writeFile(
        join(checkout, ".gitlab", "ci", "runtime-run.sh"),
        `#!/usr/bin/env bash
set -eu
if [[ "$1" == node ]]; then
  printf '%s\n' 'https://model.example.test/v1'
else
  printf '%s\n' "$@" > "$DOCSFAB_CONTROLLED_ARGV"
  exit "$DOCSFAB_CONTROLLED_EXIT"
fi
`,
      );
      const result = spawnSync("bash", ["-c", acceptance], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          CI_PROJECT_DIR: checkout,
          [trustedRootName]: privateRoot,
          DOCSFAB_CONTROLLED_ARGV: capture,
          DOCSFAB_CONTROLLED_EXIT: String(exitCode),
        },
      });
      expect(result.status, result.stderr).toBe(exitCode);
      const argv = (await readFile(capture, "utf8")).trimEnd().split("\n");
      expect(argv[argv.indexOf("--collect-dir") + 1]).toBe(
        join(checkout, "packages/runtime/ci-results/live-model"),
      );
      expect(argv[argv.indexOf("--state-dir") + 1]).toBe(join(privateRoot, "live-model-state"));
      expect(job.artifacts).toMatchObject({
        when: "always",
        paths: ["packages/runtime/ci-results/live-model/"],
      });
    },
  );

  it("keeps private roots, composition projection, and catalogued platform bounds", async () => {
    const pipeline = await readFile(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
    const start = pipeline.indexOf("runtime:live-model:");
    const end = pipeline.indexOf("\n# Assesses documentation impact", start);
    const job = pipeline.slice(start, end);
    expect(job).toMatch(/--state-dir "\$[A-Z_][A-Z0-9_]*\/live-model-state"/u);
    expect(job).toMatch(/--evidence-dir "\$[A-Z_][A-Z0-9_]*\/live-model-evidence"/u);
    expect(job).not.toContain("packages/runtime/live-model-state");
    expect(job).not.toMatch(/MODEL_PROVIDER:/u);
    expect(job).toContain(
      'runtime-run.sh" node --import tsx scripts/prepare-live-model-ci-config.ts',
    );
    expect(job).toContain("--print-approve-url");
    expect(job).toMatch(/runtime-run\.sh" npm ci/u);
    expect(job).toContain("packages/runtime/ci-results/live-model/");
    expect(job).toContain(".ci_live_model_acceptance_platform_bounds");
    expect(limit("ci.liveModelAcceptance.jobTimeoutMs").value).toBe(10_800_000);
    expect(limit("ci.liveModel.evidenceRetentionDays").value).toBe(30);
  });
});

describe.skipIf(ciWrapper.skip)(ciWrapper.title("mr-assessment CI wrapper isolation"), () => {
  async function childEnv(
    jobName: string,
    extra: NodeJS.ProcessEnv = {},
    command: readonly string[] = ["printenv"],
  ): Promise<string> {
    const bin = await scratch("docsfab-runtime-run-mr-bin-");
    const runuser = join(bin, "runuser");
    const printenvShim = `#!/usr/bin/env bash
printenv
`;
    await writeFile(
      runuser,
      `#!/usr/bin/env bash
shift
shift
shift
exec "$@"
`,
      { encoding: "utf8" },
    );
    await chmod(runuser, 0o755);
    await writeFile(join(bin, "npm"), printenvShim, { encoding: "utf8" });
    await chmod(join(bin, "npm"), 0o755);
    await writeFile(join(bin, "node"), printenvShim, { encoding: "utf8" });
    await chmod(join(bin, "node"), 0o755);
    const result = spawnSync("bash", [runtimeRun, ...command], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CI_PROJECT_DIR: repositoryRoot,
        HOME: join(bin, "home"),
        DOCSFAB_TEST_TRUSTED_ROOT: join(bin, "tmp"),
        npm_config_cache: join(bin, "npm-cache"),
        CI_JOB_NAME: jobName,
        CI: "true",
        CI_COMMIT_SHA: "abc123",
        PI_OFFLINE: "0",
        MODEL_API_KEY: "should-not-leak",
        DOCSFAB_NVIDIA_API_KEY: "should-not-leak",
        MODEL_PROVIDER: "nvidia",
        MODEL_ID: "azure/openai/gpt-6-sol",
        MODEL_API_FORMAT: "chat_completions",
        DOCSFAB_ACCEPTANCE_LIVE: "true",
        DOCSFAB_CONFIG_ROOT: join(bin, "config"),
        CI_JOB_TOKEN: "job-token-must-drop",
        CI_MERGE_REQUEST_IID: "1005",
        MR_ASSESSMENT_STAGE_DIR: join(bin, "stage"),
        ...extra,
      },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `runtime-run.sh exited ${result.status}`);
    }
    return result.stdout;
  }

  const livePrepare = [
    "node",
    "--import",
    "tsx",
    "scripts/prepare-live-model-ci-config.ts",
  ] as const;

  it("forwards MODEL_API_KEY to mr-assessment configuration preparation and drops CI_JOB_TOKEN", async () => {
    const prepare = await childEnv("runtime:mr-assessment", {}, livePrepare);
    expect(prepare).toMatch(/^MODEL_API_KEY=should-not-leak$/m);
    expect(prepare).toMatch(/^DOCSFAB_CONFIG_ROOT=/m);
    expect(prepare).toMatch(/^CI_MERGE_REQUEST_IID=1005$/m);
    expect(prepare).toMatch(/^MR_ASSESSMENT_STAGE_DIR=/m);
    expect(prepare).not.toMatch(/^CI_JOB_TOKEN=/m);
  });

  it("withholds MODEL_API_KEY from npm ci under runtime:mr-assessment", async () => {
    const env = await childEnv("runtime:mr-assessment", {}, ["npm", "ci"]);
    expect(env).not.toMatch(/^MODEL_API_KEY=/m);
    expect(env).not.toMatch(/^CI_JOB_TOKEN=/m);
    expect(env).toMatch(/^CI_MERGE_REQUEST_IID=1005$/m);
  });

  it("forwards CI_MERGE_REQUEST_SOURCE_BRANCH_SHA into the sandboxed child", async () => {
    const env = await childEnv(
      "runtime:mr-assessment",
      {
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "base-sha",
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "source-sha",
      },
      ["npm", "ci"],
    );
    expect(env).toMatch(/^CI_MERGE_REQUEST_SOURCE_BRANCH_SHA=source-sha$/m);
    expect(env).toMatch(/^CI_MERGE_REQUEST_DIFF_BASE_SHA=base-sha$/m);
    expect(env).not.toMatch(/^CI_JOB_TOKEN=/m);
  });
});
