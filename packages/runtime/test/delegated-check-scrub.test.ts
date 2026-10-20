// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDoCommand, type DoCommandOptions } from "../src/cli/commands/do.js";
import { limitDefinition } from "../src/config/limits.js";
import { loadConfig, type DocsFabConfig } from "../src/config/runtime-loader.js";
import { inspectPauseDelegatedTask } from "../src/delegated-task/continuation.js";
import {
  activateConfiguredCredentialMatchingDefaults,
  currentConfiguredCredentialMatchingPolicy,
  refreshConfiguredCredentials,
  registerConfiguredCredential,
} from "../src/security/configured-credentials.js";
import { delegatedCheckEnvironment } from "../src/security/delegated-check-environment.js";
import { validModelConfig } from "./helpers.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const REVISION = "a".repeat(40);
const SEEN_NAMES = "seen-names.json";

/** The check script: it writes the variable NAMES it can see, never a value. */
const REPORTER = [
  'import { writeFileSync } from "node:fs";',
  "writeFileSync(process.argv[2], JSON.stringify(Object.keys(process.env).sort()));",
  "",
].join("\n");

/**
 * Planted values: plain words, so none is shaped like a real credential. The
 * spaces matter: the registry compares a value with whitespace only whole,
 * never by piece, so one planted value can never match another and hide
 * which rule dropped a variable.
 */
function plantedValue(seed: string): string {
  return ["fixture", seed, "lamp quietly hums"].join(" ");
}

const VALUES = {
  model: plantedValue("model"),
  gitlab: plantedValue("gitlab"),
  glab: plantedValue("glab"),
  slack: plantedValue("slack"),
  corpModel: plantedValue("corporate"),
  corpJudge: plantedValue("arbiter"),
  loaded: plantedValue("loaded"),
};

/**
 * A credential under each kind of name the scrub drops, an innocuous name
 * holding a copy of a configured credential, and the controls a check needs.
 */
function plantEnvironment(glabConfigDirectory: string): void {
  vi.stubEnv("MODEL_API_KEY", VALUES.model);
  vi.stubEnv("GITLAB_TOKEN", VALUES.gitlab);
  vi.stubEnv("GLAB_TOKEN", VALUES.glab);
  vi.stubEnv("GLAB_CONFIG_DIR", glabConfigDirectory);
  vi.stubEnv("DOCSFAB_SLACK_BOT_TOKEN", VALUES.slack);
  // Shorter than the exact-match minimum, so only its name marks it.
  vi.stubEnv("DOCSFAB_FIXTURE_SHORT_TOKEN", "short-tok");
  // Custom names that match no credential pattern: only the reference names them.
  vi.stubEnv("MODEL_CREDENTIAL_ENV", "CORP_LLM_KEY");
  vi.stubEnv("CORP_LLM_KEY", VALUES.corpModel);
  vi.stubEnv("JUDGE_CREDENTIAL_ENV", "CORP_JUDGE_KEY");
  vi.stubEnv("CORP_JUDGE_KEY", VALUES.corpJudge);
  vi.stubEnv("DOCSFAB_SECRETS_TOKEN_FILE", join(glabConfigDirectory, "token"));
  vi.stubEnv("CREDENTIALS_DIRECTORY", glabConfigDirectory);
  // Copies of credentials under innocuous names: one the environment names,
  // one a loader registered (as the model connection registers its key).
  vi.stubEnv("DOCSFAB_FIXTURE_MIRROR", VALUES.model);
  vi.stubEnv("DOCSFAB_FIXTURE_LOADED", VALUES.loaded);
  vi.stubEnv("DOCSFAB_FIXTURE_ORDINARY_SETTING", "on");
  registerConfiguredCredential(VALUES.loaded, "the delegated-check scrub fixture");
  refreshConfiguredCredentials();
}

const DROPPED = [
  "MODEL_API_KEY",
  "GITLAB_TOKEN",
  "GLAB_TOKEN",
  "GLAB_CONFIG_DIR",
  "DOCSFAB_SLACK_BOT_TOKEN",
  "DOCSFAB_FIXTURE_SHORT_TOKEN",
  "CORP_LLM_KEY",
  "CORP_JUDGE_KEY",
  "DOCSFAB_SECRETS_TOKEN_FILE",
  "CREDENTIALS_DIRECTORY",
  "DOCSFAB_FIXTURE_MIRROR",
  "DOCSFAB_FIXTURE_LOADED",
] as const;

const KEPT = [
  "PATH",
  "HOME",
  "CI",
  "DOCSFAB_FIXTURE_ORDINARY_SETTING",
  "MODEL_CREDENTIAL_ENV",
  "JUDGE_CREDENTIAL_ENV",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  refreshConfiguredCredentials();
  vi.restoreAllMocks();
});

async function repositoryWithReporter() {
  const root = await directories.create("docsfab-delegated-check-scrub-");
  const repositoryPath = join(root, "repo");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await writeFile(join(repositoryPath, "docs", "api.md"), "# API\n", "utf8");
  await writeFile(join(repositoryPath, "report-env-names.mjs"), REPORTER, "utf8");
  await writeFile(
    join(repositoryPath, "package.json"),
    JSON.stringify({
      name: "scrub-fixture",
      private: true,
      scripts: { "report-env": `node report-env-names.mjs ${SEEN_NAMES}` },
    }),
    "utf8",
  );
  const glabConfigDirectory = join(root, "glab-config");
  await mkdir(glabConfigDirectory, { recursive: true });
  return { repositoryPath, stateDirectory: join(root, "state"), glabConfigDirectory };
}

/** The shipped `docsfab do --delegate --check` path with the model run stubbed and the check real. */
function delegatedOptions(repositoryPath: string, stateDirectory: string): DoCommandOptions {
  return {
    stateDirectory,
    now: () => new Date("2026-10-14T09:00:00.000Z"),
    inspectDelegatedWorkspaceBasis: async () => ({
      canonicalRepositoryPath: repositoryPath,
      committedHeadRevision: REVISION,
      dirtyPaths: [],
      workspace: {
        strategy: "tracked-export" as const,
        disposable: true as const,
        origin: "committed-head" as const,
        revision: REVISION,
      },
    }),
    createDelegatedTaskAuthority: vi.fn(
      async () => ({ kind: "docsfab-delegated-task-authority" }) as never,
    ),
    runDelegatedTask: vi.fn(async () => ({
      kind: "docsfab-delegated-task-result" as const,
      status: "completed" as const,
      answer: "The API page exists ([source-line 1]).",
      transcript: [
        { kind: "tool-call" as const, name: "read", arguments: { path: "docs/api.md" } },
        { kind: "tool-result" as const, name: "read", isError: false, text: "# API\n" },
      ],
      childWorkflows: [],
    })),
    inspectPauseDelegatedTask: inspectPauseDelegatedTask,
    runWorkflow: async () => {
      throw new Error("catalog runner must not run");
    },
    admitCatalogWorkflow: async () => {
      throw new Error("catalog admission must not run");
    },
    signal: new AbortController().signal,
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("docsfab do --delegate --check runs the check without DocsFab's keys and tokens", () => {
  it("a real check script sees none of the credential variables, and still sees PATH, HOME, and CI=1", async () => {
    const { repositoryPath, stateDirectory, glabConfigDirectory } = await repositoryWithReporter();
    plantEnvironment(glabConfigDirectory);

    await quietly(() =>
      handleDoCommand(
        [
          "--delegate",
          "Review docs/api.md.",
          "--repo",
          repositoryPath,
          "--check",
          "report-env",
          "--no-input",
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory),
      ),
    );

    const seen = JSON.parse(
      await readFile(join(repositoryPath, SEEN_NAMES), "utf8"),
    ) as readonly string[];
    for (const name of DROPPED) {
      expect(seen, `the check script saw ${name}`).not.toContain(name);
    }
    for (const name of KEPT) {
      expect(seen, `the check script lost ${name}`).toContain(name);
    }
  });
});

/**
 * A split-layout configuration root whose profile names `CORP_LLM_KEY` as the
 * variable holding its model key: a name no credential pattern matches.
 */
async function configurationRootNamingCorpKey(): Promise<string> {
  const root = await directories.create("docsfab-delegated-check-config-");
  await writeFile(
    join(root, "host.yaml"),
    "schemaVersion: 1\nkind: docsfab-host-config\nactivePolicyProfile: profiles/corp-gateway.yaml\n",
    { mode: 0o600 },
  );
  await mkdir(join(root, "profiles"), { mode: 0o700 });
  await writeFile(
    join(root, "profiles", "corp-gateway.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-model-profile",
      "slot: policy",
      "provider: corp-gateway",
      "baseUrl: https://llm.corp.example.test/v1",
      "modelId: corp/model",
      "apiFormat: chat_completions",
      "transport: openai-chat-completions",
      "credentialEnv: CORP_LLM_KEY",
      "contextWindow: 128000",
      "maxInputTokens: 128000",
      "maxOutputTokens: 8192",
      "apiMinOutputTokens: 16",
      "contextReserveTokens: 1024",
      "reasoning: false",
      "inputTypes: text",
      "supportsDeveloperRole: false",
      "supportsReasoningEffort: false",
      "compatibleApiFormats: chat_completions",
      "inputCostPerMillion: unknown",
      "outputCostPerMillion: unknown",
      "cacheReadCostPerMillion: unknown",
      "cacheWriteCostPerMillion: unknown",
      "profileApprovedSource: unknown",
      "profileEffectiveDate: unknown",
      "profileReviewAfter: unknown",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return root;
}

describe("the check script loses the key the loaded configuration names", () => {
  it("drops CORP_LLM_KEY when only the loaded profile names it, never this process's environment", async () => {
    const { repositoryPath, stateDirectory } = await repositoryWithReporter();
    const root = await configurationRootNamingCorpKey();
    const key = plantedValue("gateway");
    // The operator exported the key; the profile, not the environment, names it.
    vi.stubEnv("CORP_LLM_KEY", key);
    vi.stubEnv("DOCSFAB_FIXTURE_ORDINARY_SETTING", "on");
    refreshConfiguredCredentials();
    // The loader reads the configuration into its own copy, as a private loader does.
    const load = () => loadConfig({ DOCSFAB_CONFIG_ROOT: root });
    const loaded = load();
    expect(loaded.model.credentialEnv).toBe("CORP_LLM_KEY");
    expect(loaded.model.apiKey === key, "DocsFab uses the key the profile names").toBe(true);
    expect(process.env.MODEL_CREDENTIAL_ENV).toBeUndefined();

    await quietly(() =>
      handleDoCommand(
        [
          "--delegate",
          "Review docs/api.md.",
          "--repo",
          repositoryPath,
          "--check",
          "report-env",
          "--no-input",
          "--json",
        ],
        { ...delegatedOptions(repositoryPath, stateDirectory), loadDelegatedConfig: load },
      ),
    );

    const seen = JSON.parse(
      await readFile(join(repositoryPath, SEEN_NAMES), "utf8"),
    ) as readonly string[];
    expect(seen, "the check script saw CORP_LLM_KEY").not.toContain("CORP_LLM_KEY");
    for (const name of ["PATH", "HOME", "CI", "DOCSFAB_FIXTURE_ORDINARY_SETTING"]) {
      expect(seen, `the check script lost ${name}`).toContain(name);
    }
  });
});

describe("the check script loses the judge's key the loaded configuration names", () => {
  it("drops the model and judge keys a loaded configuration names", async () => {
    const { repositoryPath, stateDirectory } = await repositoryWithReporter();
    vi.stubEnv("CORP_LLM_KEY", plantedValue("policy slot"));
    vi.stubEnv("CORP_JUDGE_KEY", plantedValue("judge slot"));
    refreshConfiguredCredentials();
    const configured = {
      model: { ...validModelConfig, credentialEnv: "CORP_LLM_KEY" },
      judge: { ...validModelConfig, credentialEnv: "CORP_JUDGE_KEY" },
    } as unknown as DocsFabConfig;

    await quietly(() =>
      handleDoCommand(
        [
          "--delegate",
          "Review docs/api.md.",
          "--repo",
          repositoryPath,
          "--check",
          "report-env",
          "--no-input",
          "--json",
        ],
        {
          ...delegatedOptions(repositoryPath, stateDirectory),
          loadDelegatedConfig: () => configured,
        },
      ),
    );

    const seen = JSON.parse(
      await readFile(join(repositoryPath, SEEN_NAMES), "utf8"),
    ) as readonly string[];
    expect(seen, "the check script saw CORP_LLM_KEY").not.toContain("CORP_LLM_KEY");
    expect(seen, "the check script saw CORP_JUDGE_KEY").not.toContain("CORP_JUDGE_KEY");
    expect(seen, "the check script lost PATH").toContain("PATH");
  });
});

describe("delegatedCheckEnvironment", () => {
  it("removes a short configured credential and its innocently named copy under the active host policy", () => {
    const minimum = limitDefinition("secrets.configuredCredentialMinChars");
    const previousPolicy = currentConfiguredCredentialMatchingPolicy();
    const shortCredential = plantedCredentialValue(2117, minimum.value - 1);
    try {
      activateConfiguredCredentialMatchingDefaults(process.env, {
        ...previousPolicy,
        minChars: minimum.min,
      });
      vi.stubEnv("DOCSFAB_FIXTURE_SHORT_TOKEN", shortCredential);
      vi.stubEnv("DOCSFAB_FIXTURE_ORDINARY_COPY", shortCredential);
      vi.stubEnv("DOCSFAB_FIXTURE_ORDINARY_SETTING", "on");
      refreshConfiguredCredentials();

      const child = delegatedCheckEnvironment(process.env);
      expect(child).not.toHaveProperty("DOCSFAB_FIXTURE_SHORT_TOKEN");
      expect(child).not.toHaveProperty("DOCSFAB_FIXTURE_ORDINARY_COPY");
      expect(child.DOCSFAB_FIXTURE_ORDINARY_SETTING).toBe("on");
      expect(child.PATH).toBe(process.env.PATH);
      expect(child.CI).toBe("1");
    } finally {
      vi.unstubAllEnvs();
      activateConfiguredCredentialMatchingDefaults(process.env, previousPolicy);
      refreshConfiguredCredentials();
    }
  });

  it("drops each kind of credential variable and keeps the rest, with CI=1", async () => {
    const { glabConfigDirectory } = await repositoryWithReporter();
    plantEnvironment(glabConfigDirectory);

    const projected = delegatedCheckEnvironment(process.env);

    expect(
      Object.keys(projected).filter((name) => (DROPPED as readonly string[]).includes(name)),
    ).toEqual([]);
    expect(projected.CI).toBe("1");
    expect(projected.PATH).toBe(process.env.PATH);
    expect(projected.DOCSFAB_FIXTURE_ORDINARY_SETTING).toBe("on");
    expect(projected.MODEL_CREDENTIAL_ENV).toBe("CORP_LLM_KEY");
  });

  it("drops the variables the loaded configuration names, and only those", () => {
    const projected = delegatedCheckEnvironment(
      {
        PATH: "/usr/bin",
        CORP_LLM_KEY: plantedValue("configured"),
        CORP_LLM_KEY_HINT: "named in the runbook",
      },
      ["CORP_LLM_KEY"],
    );

    expect(projected).toEqual({
      PATH: "/usr/bin",
      CORP_LLM_KEY_HINT: "named in the runbook",
      CI: "1",
    });
  });

  it("drops only the variable a credential reference names, not a variable it merely resembles", () => {
    const projected = delegatedCheckEnvironment({
      PATH: "/usr/bin",
      MODEL_CREDENTIAL_ENV: "CORP_LLM_KEY",
      CORP_LLM_KEY: plantedValue("unregistered"),
      CORP_LLM_KEY_HINT: "named in the runbook",
      // An unset reference names nothing.
      JUDGE_CREDENTIAL_ENV: "",
      CORP_JUDGE_KEY: "kept because no reference names it",
    });

    expect(projected).toEqual({
      PATH: "/usr/bin",
      MODEL_CREDENTIAL_ENV: "CORP_LLM_KEY",
      CORP_LLM_KEY_HINT: "named in the runbook",
      JUDGE_CREDENTIAL_ENV: "",
      CORP_JUDGE_KEY: "kept because no reference names it",
      CI: "1",
    });
  });
});
