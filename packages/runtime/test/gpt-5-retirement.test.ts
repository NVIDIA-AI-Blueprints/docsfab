// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { handleProfileCommand } from "../src/cli/commands/profile.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { HOST_CONFIG_FILE, SECRETS_ENV_FILE } from "../src/config/split-layout.js";
import {
  formatDoctorReadiness,
  inspectDoctorReadiness,
  type DoctorReadinessCommandRunner,
} from "../src/doctor-readiness.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { ensureLiveAgentConfiguration } from "../src/live-agent/host.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import { prepareProfileSeed } from "../src/model/profile-apply/seed.js";
import {
  formatOperatorErrorEnvelope,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { formatSetupBootstrapResult, runSetupBootstrap } from "../src/setup/bootstrap.js";
import { gpt5BringYourOwnWarning } from "../src/setup/retired-selections.js";
import { temporaryRoots } from "./helpers/temp.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

// Every GPT-5.x selection retired on 2026-09-28. Literals on purpose, so the
// operator-facing contract is pinned independently of the source constants.
const RETIRED_HUB_ID = "switchyard/openai/gpt-5.6-sol";
const RETIRED_DIRECT = "openai-gpt-5.6-sol-pi";
const GPT_6_SOL = "nvidia-inference-gpt-6-sol-pi";
const NEXT_ACTION =
  "GPT-5.6 is retired; run `docsfab setup --profile nvidia-inference-gpt-6-sol-pi` to move to GPT-6 Sol with `MODEL_API_KEY`, or choose another model with `docsfab setup` in a terminal.";
const PLACEHOLDER_KEY = "gpt5-retirement-placeholder-not-a-credential";

const temporary = temporaryRoots();

/** The profile every bare `docsfab setup` wrote before GPT-6 Sol (origin/main 3bf0ec9a2). */
const PRE_GPT_6_DEFAULT_PROFILE = `schemaVersion: 1
kind: docsfab-model-profile
slot: policy
provider: nvidia-inference-api
baseUrl: ${HUB_BASE_URL}
modelId: ${RETIRED_HUB_ID}
apiFormat: chat_completions
contextWindow: 1050000
maxInputTokens: 1050000
maxOutputTokens: 128000
apiMinOutputTokens: 16
contextReserveTokens: 4096
reasoning: true
inputTypes: text
supportsDeveloperRole: false
supportsReasoningEffort: false
compatibleApiFormats: chat_completions
inputCostPerMillion: unknown
outputCostPerMillion: unknown
cacheReadCostPerMillion: unknown
cacheWriteCostPerMillion: unknown
profileApprovedSource: https://developers.openai.com/api/docs/models/gpt-5.6-sol
profileEffectiveDate: "2026-09-02"
profileReviewAfter: "2026-12-31"
`;

const HOST_PREAMBLE = "schemaVersion: 1\nkind: docsfab-host-config\n";

/** A split root as the pre-GPT-6 bare setup left it: YAML profile plus a stored key. */
async function preGpt6SplitRoot(): Promise<string> {
  const root = await temporary.create("docsfab-gpt5-retired-yaml-");
  await mkdir(join(root, "profiles"), { mode: 0o700 });
  await writeFile(join(root, "profiles", "operating-agent.yaml"), PRE_GPT_6_DEFAULT_PROFILE, {
    mode: 0o600,
  });
  await writeFile(
    join(root, HOST_CONFIG_FILE),
    `${HOST_PREAMBLE}activePolicyProfile: profiles/operating-agent.yaml\n`,
    { mode: 0o600 },
  );
  await writeFile(join(root, SECRETS_ENV_FILE), `MODEL_API_KEY=${PLACEHOLDER_KEY}\n`, {
    mode: 0o600,
  });
  return root;
}

async function hostNaming(executionProfile: string): Promise<string> {
  const root = await temporary.create("docsfab-gpt5-retired-host-");
  await writeFile(
    join(root, HOST_CONFIG_FILE),
    `${HOST_PREAMBLE}activeExecutionProfile: ${executionProfile}\ncompositionId: ${executionProfile}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(root, SECRETS_ENV_FILE), `MODEL_API_KEY=${PLACEHOLDER_KEY}\n`, {
    mode: 0o600,
  });
  return root;
}

/**
 * Who retired GPT-5.x, their words, and the decision record, as the installed
 * registry keeps them. Operator text must repeat none of it.
 */
function registryDecisionProvenance(): string[] {
  const registry = JSON.parse(
    readFileSync(
      new URL("../model-compositions/composition-registry.json", import.meta.url),
      "utf8",
    ),
  ) as {
    compositions: Array<{
      retirement?: { decision?: { decidedBy: string; statement: string; record: string } };
    }>;
  };
  const decisions = registry.compositions.flatMap((entry) =>
    entry.retirement?.decision ? [entry.retirement.decision] : [],
  );
  // The record view keeps the provenance; only operator text drops it.
  expect(decisions.length).toBeGreaterThan(0);
  return decisions.flatMap(({ decidedBy, statement, record }) => [
    decidedBy,
    statement,
    record,
    `#${record.split("/").at(-1)}`,
  ]);
}

function expectNoDecisionProvenance(texts: readonly string[]): void {
  const provenance = registryDecisionProvenance();
  for (const text of texts) {
    for (const item of provenance) expect(text).not.toContain(item);
  }
}

/** The whole public message: the selection, the reason code and instant, and nothing else. */
const RETIRED_MESSAGE =
  /^(?:Model selection|Composition) "[^"]+" is retired \((?:superseded-by-operator-decision|provider-end-of-life), effective [0-9T:.Z-]+\) and cannot be selected for a new execution\.$/u;

function expectRetiredRefusal(error: unknown, nextAction: string | RegExp = NEXT_ACTION): void {
  expect(error).toBeInstanceOf(ModelCompositionError);
  expect((error as ModelCompositionError).code).toBe("composition-retired");
  if (typeof nextAction === "string") {
    expect((error as ModelCompositionError).nextAction).toBe(nextAction);
  } else {
    expect((error as ModelCompositionError).nextAction).toMatch(nextAction);
  }
  expect((error as Error).message).toMatch(RETIRED_MESSAGE);
  const envelope = toOperatorErrorEnvelope(error);
  expectNoDecisionProvenance([
    (error as Error).message,
    (error as ModelCompositionError).nextAction ?? "",
    formatOperatorErrorEnvelope(envelope),
    serializeOperatorErrorEnvelope(envelope),
  ]);
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("GPT-5.x retirement (#1512)", () => {
  it("refuses a pre-GPT-6 host at startup, in loadConfig, and in live-agent", async () => {
    const root = await preGpt6SplitRoot();
    const environment = { DOCSFAB_CONFIG_ROOT: root };
    const hostBefore = await readFile(join(root, HOST_CONFIG_FILE), "utf8");

    const loaded = captureError(() => loadConfig({ ...environment }));
    expectRetiredRefusal(loaded);
    expect((loaded as Error).message).toMatch(
      /^Model selection "switchyard\/openai\/gpt-5\.6-sol" is retired \(superseded-by-operator-decision, effective 2026-09-28T00:00:00\.000Z\) and cannot be selected for a new execution\.$/u,
    );

    expectRetiredRefusal(
      await captureRejection(() =>
        runSetupBootstrap({ environment: { ...environment }, purpose: "startup-check" }),
      ),
    );

    const output = Object.assign(new PassThrough(), { isTTY: true });
    const input = Object.assign(new PassThrough(), { isTTY: true });
    expectRetiredRefusal(
      await captureRejection(() =>
        ensureLiveAgentConfiguration({ environment: { ...environment }, input, output }),
      ),
    );
    // Refuse, never auto-migrate: startup left the root exactly as it was.
    expect(await readFile(join(root, HOST_CONFIG_FILE), "utf8")).toBe(hostBefore);
  });

  it("renders the refusal as a composition-retired envelope with the setup next action", () => {
    const error = captureError(() =>
      loadConfig({
        DOCSFAB_CONFIG_ROOT: "/nonexistent-docsfab-gpt5-root",
        MODEL_PROVIDER: "nvidia-inference-api",
        MODEL_BASE_URL: HUB_BASE_URL,
        MODEL_ID: RETIRED_HUB_ID,
        MODEL_API_KEY: PLACEHOLDER_KEY,
      }),
    );
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("composition-retired");
    expect(envelope.nextAction).toBe(NEXT_ACTION);
    expect(envelope.docsAnchor).toBe("docs/configure/model.md");
    expect(JSON.stringify(envelope)).not.toContain(PLACEHOLDER_KEY);
  });

  it("does not report Ready from profile inspect for an existing direct gpt-5.6-sol host", async () => {
    // The critic's dead end: doctor -> profile inspect -> "Ready". Inspect now
    // refuses the retired model id with the named code instead.
    const root = await temporary.create("docsfab-gpt5-retired-inspect-");
    await mkdir(join(root, "profiles"), { mode: 0o700 });
    await writeFile(
      join(root, "profiles", "gpt-5.6-sol.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-model-profile",
        "slot: policy",
        "provider: openai-api",
        "baseUrl: https://api.openai.com/v1",
        "modelId: gpt-5.6-sol",
        "apiFormat: chat_completions",
        "transport: openai-chat-completions",
        "credentialEnv: OPENAI_API_KEY",
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
    await writeFile(
      join(root, HOST_CONFIG_FILE),
      `${HOST_PREAMBLE}activePolicyProfile: profiles/gpt-5.6-sol.yaml\n`,
      { mode: 0o600 },
    );
    const saved = { ...process.env };
    const printed: string[] = [];
    const originalLog = console.log;
    try {
      for (const name of Object.keys(process.env)) {
        if (/^(?:MODEL|JUDGE)_/u.test(name)) delete process.env[name];
      }
      process.env.DOCSFAB_CONFIG_ROOT = root;
      process.env.OPENAI_API_KEY = PLACEHOLDER_KEY;
      console.log = (value?: unknown) => {
        printed.push(String(value ?? ""));
      };
      expectRetiredRefusal(await captureRejection(() => handleProfileCommand(["inspect"])));
    } finally {
      console.log = originalLog;
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) delete process.env[name];
      }
      Object.assign(process.env, saved);
    }
    expect(printed.join("\n")).not.toMatch(/Ready/u);
  });

  it("refuses a judge slot naming the retired Hub id", () => {
    expectRetiredRefusal(
      captureError(() =>
        loadConfig({
          DOCSFAB_CONFIG_ROOT: "/nonexistent-docsfab-gpt5-root",
          MODEL_PROVIDER: "nvidia-inference-api",
          MODEL_BASE_URL: HUB_BASE_URL,
          MODEL_ID: "azure/openai/gpt-6-sol",
          MODEL_API_KEY: PLACEHOLDER_KEY,
          JUDGE_ENABLED: "true",
          JUDGE_MODEL_ID: RETIRED_HUB_ID,
        }),
      ),
    );
  });

  it("refuses bare setup on a pre-GPT-6 YAML host and moves it to GPT-6 Sol on --profile, keeping the stored key", async () => {
    const root = await preGpt6SplitRoot();
    const environment = { DOCSFAB_CONFIG_ROOT: root };
    const hostBefore = await readFile(join(root, HOST_CONFIG_FILE), "utf8");

    // No default replaces a retired selection; the refusal names the explicit choice.
    expectRetiredRefusal(await captureRejection(() => runSetupBootstrap({ environment })));
    expect(await readFile(join(root, HOST_CONFIG_FILE), "utf8")).toBe(hostBefore);

    const result = await runSetupBootstrap({ profile: GPT_6_SOL, environment });

    expect(result).toMatchObject({
      status: "ready",
      seeded: true,
      activeExecutionProfile: GPT_6_SOL,
      requiredSecretNames: ["MODEL_API_KEY"],
      credentialSource: "existing-env",
      profile: { modelId: "azure/openai/gpt-6-sol" },
    });
    expect(result.activePolicyProfile).toBeUndefined();
    const host = await readFile(join(root, HOST_CONFIG_FILE), "utf8");
    expect(host).toContain(`activeExecutionProfile: ${GPT_6_SOL}`);
    expect(host).not.toContain("activePolicyProfile");
    expect(await readFile(join(root, SECRETS_ENV_FILE), "utf8")).toContain(
      `MODEL_API_KEY=${PLACEHOLDER_KEY}`,
    );
    expect(loadConfig({ ...environment }).model.modelId).toBe("azure/openai/gpt-6-sol");
  });

  it.each([
    [RETIRED_HUB_ID, NEXT_ACTION],
    [RETIRED_DIRECT, /^Select its successor, `nvidia-inference-gpt-6-sol-pi`/u],
  ] as const)(
    "refuses a host naming %s at startup and on bare setup, and moves it to GPT-6 Sol on --profile",
    async (executionProfile, nextAction) => {
      const root = await hostNaming(executionProfile);
      const environment = { DOCSFAB_CONFIG_ROOT: root };

      expectRetiredRefusal(
        captureError(() => loadConfig({ ...environment })),
        nextAction,
      );
      expectRetiredRefusal(
        await captureRejection(() =>
          runSetupBootstrap({ environment: { ...environment }, purpose: "startup-check" }),
        ),
        nextAction,
      );

      expectRetiredRefusal(
        await captureRejection(() => runSetupBootstrap({ environment: { ...environment } })),
        nextAction,
      );
      const migrated = await runSetupBootstrap({
        profile: GPT_6_SOL,
        environment: { ...environment },
      });
      expect(migrated).toMatchObject({ status: "ready", activeExecutionProfile: GPT_6_SOL });
      expect(await readFile(join(root, HOST_CONFIG_FILE), "utf8")).toContain(
        `compositionId: ${GPT_6_SOL}`,
      );
    },
  );

  it("refuses a legacy .env naming the retired Hub id at startup and on bare setup, and migrates it on --profile", async () => {
    const root = await temporary.create("docsfab-gpt5-retired-legacy-");
    await writeFile(
      join(root, ".env"),
      [
        "MODEL_PROVIDER=nvidia-inference-api",
        `MODEL_BASE_URL=${HUB_BASE_URL}`,
        `MODEL_ID=${RETIRED_HUB_ID}`,
        "MODEL_API_FORMAT=chat_completions",
        `MODEL_API_KEY=${PLACEHOLDER_KEY}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const environment = { DOCSFAB_CONFIG_ROOT: root };

    expectRetiredRefusal(
      await captureRejection(() =>
        runSetupBootstrap({ environment: { ...environment }, purpose: "startup-check" }),
      ),
    );
    expect(existsSync(join(root, HOST_CONFIG_FILE))).toBe(false);
    expectRetiredRefusal(
      await captureRejection(() => runSetupBootstrap({ environment: { ...environment } })),
    );
    expect(existsSync(join(root, HOST_CONFIG_FILE))).toBe(false);

    const migrated = await runSetupBootstrap({
      profile: GPT_6_SOL,
      environment: { ...environment },
    });
    expect(migrated).toMatchObject({
      status: "ready",
      layout: "split",
      activeExecutionProfile: GPT_6_SOL,
      credentialSource: "existing-env",
    });
  });

  it.each([
    ["--profile", { profile: RETIRED_HUB_ID }],
    ["--preset", { preset: RETIRED_HUB_ID }],
    ["--preset gpt-5.6-sol", { preset: "gpt-5.6-sol" }],
    [
      "--provider openai-compatible --model",
      {
        model: {
          provider: "openai-compatible" as const,
          modelId: RETIRED_HUB_ID,
          baseUrl: HUB_BASE_URL,
        },
      },
    ],
  ] as const)("refuses setup %s naming a retired GPT-5.6 id before writing", async (_, option) => {
    const root = await temporary.create("docsfab-gpt5-retired-select-");
    const error = await captureRejection(() =>
      runSetupBootstrap({
        ...option,
        environment: {
          DOCSFAB_CONFIG_ROOT: root,
          MODEL_API_KEY: PLACEHOLDER_KEY,
          COMPATIBLE_API_KEY: PLACEHOLDER_KEY,
        },
      }),
    );
    expectRetiredRefusal(error);
    expect(existsSync(join(root, HOST_CONFIG_FILE))).toBe(false);
    expect(existsSync(join(root, SECRETS_ENV_FILE))).toBe(false);
  });

  it("refuses the retired GPT-5.4 preset with its own family in the next action", async () => {
    expectRetiredRefusal(
      await captureRejection(() =>
        runSetupBootstrap({
          preset: "azure/openai/gpt-5.4",
          environment: { DOCSFAB_CONFIG_ROOT: "/nonexistent-docsfab-gpt5-root" },
        }),
      ),
      NEXT_ACTION.replace("GPT-5.6 is retired", "GPT-5.4 is retired"),
    );
  });
});

describe("retired-model text omits the internal decision provenance (#2347)", () => {
  it("refuses a GPT-5.6 id brought through openai-compatible with the reason and date only", async () => {
    const root = await temporary.create("docsfab-gpt5-retired-provider-");
    const error = await captureRejection(() =>
      runSetupBootstrap({
        model: {
          provider: "openai-compatible",
          modelId: "azure/openai/GPT-5.6-Luna",
          baseUrl: "https://models.example.test/v1",
        },
        environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: PLACEHOLDER_KEY },
      }),
    );
    expectRetiredRefusal(error);
    expect((error as Error).message).toBe(
      'Model selection "azure/openai/GPT-5.6-Luna" is retired (superseded-by-operator-decision, effective 2026-09-28T00:00:00.000Z) and cannot be selected for a new execution.',
    );
  });

  it("refuses profile seed with a retired preset without the provenance", async () => {
    const root = await temporary.create("docsfab-gpt5-retired-seed-");
    expectRetiredRefusal(
      await captureRejection(() =>
        prepareProfileSeed({ projectRoot: root, preset: RETIRED_HUB_ID }),
      ),
    );
  });

  it("reports a retired raw profile in doctor without the provenance", async () => {
    const root = await temporary.create("docsfab-gpt5-retired-doctor-");
    const unavailable: DoctorReadinessCommandRunner = {
      run: async () => ({ exitCode: 1, stdout: "" }),
      probeCredential: async () => "missing",
    };
    const result = await inspectDoctorReadiness({
      cwd: root,
      environment: { DOCSFAB_CONFIG_ROOT: root },
      homeDirectory: root,
      commands: unavailable,
      loadConfiguration: () =>
        loadConfig({
          DOCSFAB_CONFIG_ROOT: "/nonexistent-docsfab-gpt5-root",
          MODEL_PROVIDER: "nvidia-inference-api",
          MODEL_BASE_URL: HUB_BASE_URL,
          MODEL_ID: RETIRED_HUB_ID,
          MODEL_API_KEY: PLACEHOLDER_KEY,
        }),
      validateConfiguration: async () => undefined,
    });
    const retired = result.diagnostics.find((item) => item.code === "composition-retired");
    expect(retired?.explanation).toMatch(RETIRED_MESSAGE);
    expect(retired?.nextCommand).toBe(NEXT_ACTION);
    expectNoDecisionProvenance([
      formatDoctorReadiness(result),
      canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue),
    ]);
  });

  it("warns about another GPT-5.x model without citing the decision", async () => {
    const warning = gpt5BringYourOwnWarning("gpt-5.4");
    expect(warning).toBe(
      'Model "gpt-5.4" is a GPT-5.x model. DocsFab retired its GPT-5.x selections in favor of GPT-6 Sol; this bring-your-own selection still runs but is not a supported model. Run `docsfab setup --profile nvidia-inference-gpt-6-sol-pi` to use GPT-6 Sol.',
    );
    const root = await temporary.create("docsfab-gpt5-byo-warning-");
    const result = await runSetupBootstrap({
      model: {
        provider: "openai-compatible",
        modelId: "gpt-5.4",
        baseUrl: "https://models.example.test/v1",
      },
      environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: PLACEHOLDER_KEY },
    });
    expect(result.warnings).toEqual([warning]);
    expectNoDecisionProvenance([formatSetupBootstrapResult(result), ...(result.warnings ?? [])]);
  });
});
