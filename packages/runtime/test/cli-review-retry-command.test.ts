// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { parseSetOptions, withoutSetOptions } from "../src/cli/model-setting-options.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import {
  MODEL_SETTING_KEYS,
  type ModelSettingEntry,
  type ModelSettingKey,
} from "../src/config/model-settings.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RunModelSettingsV1 } from "../src/records/run-model-settings.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import { buildProviderRetryCommand } from "../src/operator/run-retry-commands.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = temporaryRoots();

afterEach(() => {
  process.exitCode = undefined;
});

function config(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: ["throttled"],
    },
    model: validModelConfig,
  };
}

function throttledHarness(): AgentHarness {
  return {
    inspectSkill: async (input: HarnessStepInput) => ({
      id: input.step.skill,
      contentSha256: "a".repeat(64),
    }),
    runStep: async () => {
      throw new InferenceStepError("429 throttled by fixture", "throttled", true, undefined, {
        code: "provider-throttle",
        location: "$response",
      });
    },
  };
}

async function fixtureRun(
  args: string[],
  options: {
    readonly omitRetryDeliverySelection?: boolean;
    readonly files?: Readonly<Record<string, string>>;
  } = {},
): Promise<{
  repositoryPath: string;
  stateDirectory: string;
  output: string;
  record: RunRecord;
}> {
  const root = await roots.create("docsfab-review-retry-", { realpath: true });
  const repositoryPath = join(root, "repo");
  const stateDirectory = join(root, "runs");
  await initFixtureRepo(
    repositoryPath,
    options.files ?? { "docs/guide.md": "# Guide\n\nFixture.\n" },
  );
  const parsedRequest = parseRunArguments([args[0]!, "--repo", repositoryPath, ...args.slice(1)]);
  const request = options.omitRetryDeliverySelection
    ? (({
        retryDeliverySelection: _selection,
        writeGrantExplicit: _writeGrantExplicit,
        ...internalRequest
      }) => internalRequest)(parsedRequest)
    : parsedRequest;
  const log: string[] = [];
  const error: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => log.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => error.push(values.map(String).join(" "));
  try {
    await executeRunRequest(request, config(stateDirectory), {
      executionHarness: throttledHarness(),
      skillResolver: {
        resolveSkill: async (input: HarnessStepInput) => ({
          id: input.step.skill,
          contentSha256: "a".repeat(64),
        }),
      },
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const files = (await readdir(stateDirectory)).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  const record = (await new FileRunStore(stateDirectory).get(files[0]!.slice(0, -5))) as RunRecord;
  expect(record.status).toBe("failed");
  expect(record.repository.sourcePath).toBe(repositoryPath);
  expect(
    record.steps.some((step) =>
      step.inference?.attempts.some((attempt) => attempt.outcome === "throttled"),
    ),
  ).toBe(true);
  return { repositoryPath, stateDirectory, output: [...log, ...error].join("\n"), record };
}

function nextCommand(output: string): string {
  const nextSection = output.slice(output.indexOf("NEXT"));
  const match = /^\s{2}(docsfab .+)$/mu.exec(nextSection);
  if (!match?.[1]) throw new Error(`No rendered NEXT command found:\n${output}`);
  return match[1];
}

/** Run the displayed line unchanged through a harmless shell command catcher. */
function commandArguments(command: string): string[] {
  const stdout = execFileSync(
    "/bin/sh",
    ["-c", 'docsfab() { printf "%s\\0" "$@"; }; eval "$1"', "capture", command],
    { encoding: "buffer" },
  );
  const values = stdout.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

describe("review retry NEXT command reconstruction", () => {
  it("prints an executable retry for a review that had no instruction", async () => {
    const run = await fixtureRun(["review-documentation"]);
    const command = nextCommand(run.output);
    const argv = commandArguments(command);
    expect(argv.slice(0, 2)).toEqual(["run", "review-documentation"]);
    const reparsed = parseRunArguments(argv.slice(1));
    expect(reparsed.repositoryPath).toBe(run.repositoryPath);
    expect(reparsed.instruction).toBeUndefined();
    expect(reparsed.allowWrite).toBe(false);
    expect(reparsed.retryDeliverySelection).toBe("read-only");
    expect(reparsed.revision).toBe(run.record.repository.revision);
    expect(reparsed.revisionExplicit).toBe(true);
    expect(command).not.toContain("<original");
    expect(command).not.toContain("--patch-only");

    const legacyRecord = { ...run.record, retryContext: undefined };
    expect(
      buildRunHumanNextCommand({
        record: legacyRecord,
        recordPath: join(run.stateDirectory, `${legacyRecord.id}.json`),
        repositoryPath: run.repositoryPath,
      })?.command,
    ).toBe(`docsfab runs show ${legacyRecord.id} --state-dir ${run.stateDirectory} --json`);
  });

  it("refuses to reconstruct argv from malformed retained retry context", async () => {
    const run = await fixtureRun(["review-documentation"]);
    const malformedRecord = {
      ...run.record,
      retryContext: {
        schemaVersion: 1,
        kind: "docsfab-cli-run-retry-context",
        deliveryMode: "grant-all",
      },
    } as unknown as RunRecord;
    expect(
      buildRunHumanNextCommand({
        record: malformedRecord,
        recordPath: join(run.stateDirectory, `${malformedRecord.id}.json`),
        repositoryPath: run.repositoryPath,
      })?.command,
    ).toBe(`docsfab runs show ${malformedRecord.id} --state-dir ${run.stateDirectory} --json`);
  });

  it("retries the admitted review page set despite supporting-page prose", async () => {
    const run = await fixtureRun([
      "review-documentation",
      "--review-target",
      "docs/guide.md",
      "--instruction",
      "Review docs/guide.md using docs/context.md as supporting material.",
    ]);
    expect(run.record.reviewScope?.targetPaths).toEqual(["docs/guide.md"]);
    const retry = parseRunArguments(commandArguments(nextCommand(run.output)).slice(1));
    expect(retry.reviewTargetPaths).toEqual(["docs/guide.md"]);
    expect(retry.revision).toBe(run.record.repository.revision);
    const inconsistent = {
      ...run.record,
      retryContext: {
        ...run.record.retryContext,
        contextTarget: { sourcePath: "docs/other.md" },
      },
    } as RunRecord;
    expect(buildProviderRetryCommand(inconsistent, "")).toBe(
      `docsfab runs show ${run.record.id} --json`,
    );
  });

  it("executes an explicit smaller batch against the saved scope and revision", async () => {
    const instruction = "Review docs/a.md and docs/b.md using the implementation as evidence.";
    const source = await fixtureRun(
      [
        "review-documentation",
        "--review-target",
        "docs/a.md",
        "--review-target",
        "docs/b.md",
        "--instruction",
        instruction,
      ],
      {
        files: { "docs/a.md": "# A\n", "docs/b.md": "# B\n" },
      },
    );
    expect(source.record.reviewScope?.targetPaths).toEqual(["docs/a.md", "docs/b.md"]);
    const request = parseRunArguments([
      "review-documentation",
      "--repo",
      source.repositoryPath,
      "--revision",
      source.record.repository.revision,
      "--rescope-from",
      source.record.id,
      "--review-target",
      "docs/a.md",
      "--instruction",
      instruction,
    ]);
    await executeRunRequest(request, config(source.stateDirectory), {
      executionHarness: throttledHarness(),
      skillResolver: {
        resolveSkill: async (input: HarnessStepInput) => ({
          id: input.step.skill,
          contentSha256: "a".repeat(64),
        }),
      },
    });
    const runIds = (await readdir(source.stateDirectory)).filter((file) => file.endsWith(".json"));
    expect(runIds).toHaveLength(2);
    const childId = runIds.find((file) => file !== `${source.record.id}.json`)!.slice(0, -5);
    const child = (await new FileRunStore(source.stateDirectory).get(childId)) as RunRecord;
    expect(child.reviewScope?.targetPaths).toEqual(["docs/a.md"]);
    expect(child.repository.revision).toBe(source.record.repository.revision);
  });

  it("round-trips a quoted repository path and instruction without shell execution", async () => {
    const root = await roots.create("docsfab-retry-quoted-root-", { realpath: true });
    const repositoryPath = join(root, "repo 'quoted' ; $(printf injected)");
    const stateDirectory = join(root, "runs");
    await initFixtureRepo(repositoryPath, { "docs/guide.md": "# Guide\n" });
    const instruction = "Review 'docs'; $(printf injected) && preserve * literally";
    const request = parseRunArguments([
      "review-documentation",
      "--repo",
      repositoryPath,
      "--instruction",
      instruction,
      "--revision",
      "HEAD",
      "--context-path",
      "docs/guide.md",
    ]);
    const log: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...values: unknown[]) => log.push(values.map(String).join(" "));
    console.error = () => undefined;
    try {
      await executeRunRequest(request, config(stateDirectory), {
        executionHarness: throttledHarness(),
        skillResolver: {
          resolveSkill: async (input: HarnessStepInput) => ({
            id: input.step.skill,
            contentSha256: "a".repeat(64),
          }),
        },
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const argv = commandArguments(nextCommand(log.join("\n")));
    const reparsed = parseRunArguments(argv.slice(1));
    const [recordFile] = (await readdir(stateDirectory)).filter((file) => file.endsWith(".json"));
    const record = (await new FileRunStore(stateDirectory).get(recordFile!.slice(0, -5)))!;
    expect(reparsed.repositoryPath).toBe(repositoryPath);
    expect(reparsed.instruction).toBe(instruction);
    expect(reparsed.revision).toBe(record.repository.revision);
    expect(reparsed.revisionExplicit).toBe(true);
    expect(reparsed.contextTarget).toEqual({ sourcePath: "docs/guide.md" });
  });

  it("retains an explicitly authorized write-only request without inventing delivery flags", async () => {
    const run = await fixtureRun([
      "bootstrap",
      "--allow-write",
      "--patch-only",
      "--instruction",
      "Create docs/guide.md",
    ]);
    const command = nextCommand(run.output);
    const argv = commandArguments(command);
    expect(argv.slice(0, 2)).toEqual(["run", "bootstrap"]);
    const reparsed = parseRunArguments(argv.slice(1));
    expect(reparsed.repositoryPath).toBe(run.repositoryPath);
    expect(reparsed.instruction).toBe("Create docs/guide.md");
    expect(reparsed.allowWrite).toBe(true);
    expect(reparsed.retryDeliverySelection).toBe("patch-only");
    expect(run.record.retryContext).toMatchObject({ allowWrite: true, deliveryMode: "patch-only" });
    expect(command).not.toContain("--draft-mr");
    expect(command).not.toContain("--comment-mr");
  });

  describe("a retry binds the failed run's settings", () => {
    /** The settings a run records for its host.yaml preset with these entries applied. */
    function recordedSettings(
      overrides: Partial<Record<ModelSettingKey, ModelSettingEntry>>,
    ): RunModelSettingsV1 {
      const settings = Object.fromEntries(
        MODEL_SETTING_KEYS.map((key) => [
          key,
          overrides[key] ?? { value: null, source: "preset", origin: "the preset" },
        ]),
      ) as Record<ModelSettingKey, ModelSettingEntry>;
      return {
        schemaVersion: 1,
        kind: "docsfab-run-model-settings",
        writing: {
          schemaVersion: 1,
          slot: "writing",
          presetId: "fixture-preset",
          presetSource: "host-config",
          settings,
          notes: [],
        },
      };
    }

    function next(run: Awaited<ReturnType<typeof fixtureRun>>, record: RunRecord) {
      return buildRunHumanNextCommand({
        record,
        recordPath: join(run.stateDirectory, `${record.id}.json`),
        repositoryPath: run.repositoryPath,
      });
    }

    it("repeats each --set pair, and only those, in an executable retry", async () => {
      const run = await fixtureRun(["review-documentation"]);
      const record: RunRecord = {
        ...run.record,
        modelSettings: recordedSettings({
          maxOutputTokens: { value: 65536, source: "cli-flag", origin: "--set maxOutputTokens" },
          reasoningEffort: { value: "high", source: "cli-flag", origin: "--set reasoningEffort" },
          // The retry reads host.yaml again, so its values are not repeated.
          contextWindow: {
            value: 200000,
            source: "host-config",
            origin: "host.yaml active.writing.settings.contextWindow",
          },
        }),
      };

      const argv = commandArguments(next(run, record)!.command);
      expect(parseSetOptions(argv).writing).toEqual({
        maxOutputTokens: 65536,
        reasoningEffort: "high",
      });
      const reparsed = parseRunArguments(withoutSetOptions(argv).slice(1));
      expect(reparsed.repositoryPath).toBe(run.repositoryPath);
      expect(reparsed.retryDeliverySelection).toBe("read-only");
      // Control: the same run without --set values retries without them.
      expect(next(run, run.record)!.command).not.toContain("--set");
    });

    it("sends a run that set its endpoint with --set to its saved record", async () => {
      const run = await fixtureRun(["review-documentation"]);
      const record: RunRecord = {
        ...run.record,
        modelSettings: recordedSettings({
          baseUrl: {
            value: "https://gateway.example.test/v1",
            source: "cli-flag",
            origin: "--set baseUrl",
          },
          maxOutputTokens: { value: 65536, source: "cli-flag", origin: "--set maxOutputTokens" },
        }),
      };

      const action = next(run, record)!;
      expect(action.command).toBe(
        `docsfab runs show ${record.id} --state-dir ${run.stateDirectory} --json`,
      );
      expect(action.reason).toContain("--set baseUrl");
      expect(JSON.stringify(action)).not.toContain("gateway.example.test");
    });
  });

  it("omits retry context for an internal write request without CLI delivery provenance", async () => {
    const run = await fixtureRun(
      ["bootstrap", "--allow-write", "--patch-only", "--instruction", "Create docs/guide.md"],
      { omitRetryDeliverySelection: true },
    );
    expect(run.record.retryContext).toBeUndefined();
    const command = nextCommand(run.output);
    expect(command).toBe(
      `docsfab runs show ${run.record.id} --state-dir ${run.stateDirectory} --json`,
    );
    expect(command).not.toContain("--patch-only");
    expect(command).not.toContain("--draft-mr");
  });
});
