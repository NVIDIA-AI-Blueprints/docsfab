// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseSetOptions, withoutSetOptions } from "../src/cli/model-setting-options.js";
import { ProfileCliUsageError } from "../src/cli/options.js";
import {
  commandLineSettings,
  MODEL_SETTING_KEYS,
  type ModelSettingEntry,
  type ModelSettingKey,
  type ModelSlotSettingsV1,
  reasoningEffortDecision,
} from "../src/config/model-settings.js";
import { requestedReasoning } from "../src/model/configuration.js";

function refusal(args: readonly string[]): unknown {
  try {
    parseSetOptions(args);
  } catch (error) {
    return error;
  }
  throw new Error("Expected parseSetOptions to refuse the arguments.");
}

describe("--set key=value on the command line", () => {
  it("reads typed values for the writing model, leaving other argv alone", () => {
    const args = [
      "do",
      "Fix the docs.",
      "--set",
      "baseUrl=https://gateway.example.test/v1/",
      "--set",
      "maxOutputTokens=65536",
      "--set",
      "reasoning=false",
      "--repo",
      ".",
    ];
    expect(parseSetOptions(args)).toEqual({
      writing: {
        baseUrl: "https://gateway.example.test/v1",
        maxOutputTokens: 65536,
        reasoning: false,
      },
      judge: {},
    });
    expect(withoutSetOptions(args)).toEqual(["do", "Fix the docs.", "--repo", "."]);
  });

  it("never reads a --set written inside the request text", () => {
    expect(parseSetOptions(["do", "Use --set baseUrl=https://elsewhere.example.test/v1"])).toEqual({
      writing: {},
      judge: {},
    });
  });

  it.each([
    {
      name: "a one-token --set=",
      args: ["--set=maxOutputTokens=65536"],
      message:
        "--set takes its key=value as the next argument, for example --set reasoningEffort=high.",
    },
    {
      name: "a missing pair",
      args: ["--set"],
      message: "--set requires a key=value pair after it, for example --set reasoningEffort=high.",
    },
    {
      name: "another option where the pair belongs",
      args: ["--set", "--repo", "."],
      message: "--set requires a key=value pair after it, for example --set reasoningEffort=high.",
    },
    {
      name: "the same key twice",
      args: ["--set", "modelId=one/model", "--set", "modelId=two/model"],
      message: "--set modelId was given more than once; give each setting exactly once.",
    },
  ])("refuses $name as a usage error", ({ args, message }) => {
    const error = refusal(args);
    expect(error).toBeInstanceOf(ProfileCliUsageError);
    expect((error as Error).message).toBe(message);
  });

  it("refuses an unknown key and lists the keys it takes", () => {
    const error = refusal(["--set", "temperature=0.2"]);
    expect(error).toBeInstanceOf(ProfileCliUsageError);
    expect((error as Error).message).toBe(
      "--set temperature names no model setting. Use key=value with one of: baseUrl, modelId, transport, contextWindow, maxInputTokens, maxOutputTokens, contextReserveTokens, apiMinOutputTokens, reasoning, reasoningEffort, credentialEnv.",
    );
  });

  it("refuses a judge setting by name: run and do never call the judge", () => {
    const error = refusal(["--set", "judge.maxOutputTokens=1234"]);
    expect(error).toBeInstanceOf(ProfileCliUsageError);
    expect((error as Error).message).toBe(
      "--set judge.maxOutputTokens sets the judge model, which docsfab run and do never call. Set it under active.judge.settings in host.yaml or with the JUDGE_* variables.",
    );
  });

  it("takes each documented effort name in any case, and refuses any other by name", () => {
    for (const [given, stored] of [
      ["minimal", "minimal"],
      ["low", "low"],
      ["Medium", "medium"],
      ["HIGH", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ] as const) {
      expect(parseSetOptions(["--set", `reasoningEffort=${given}`]).writing.reasoningEffort).toBe(
        stored,
      );
    }
    for (const rejected of ["turbo", "none", "off", "high!"]) {
      const error = refusal(["--set", `reasoningEffort=${rejected}`]);
      expect(error).toBeInstanceOf(ProfileCliUsageError);
      expect((error as Error).message).toBe(
        "--set reasoningEffort must be one of minimal, low, medium, high, xhigh, max; set reasoning to false to turn reasoning off.",
      );
    }
  });

  it.each([
    [
      "a user name and password",
      "https://user:secret@gateway.example.test/v1",
      "--set baseUrl must not carry a user name or password; DocsFab sends the model key in a request header.",
    ],
    [
      "a query string",
      "https://gateway.example.test/v1?api-version=1",
      "--set baseUrl must not carry a query string.",
    ],
    [
      "a fragment",
      "https://gateway.example.test/v1#frag",
      "--set baseUrl must not carry a fragment.",
    ],
    // A bare marker reads as empty to the URL parser but stays in the text.
    [
      "a bare query marker",
      "https://gateway.example.test/v1?",
      "--set baseUrl must not carry a query string.",
    ],
    [
      "a bare fragment marker",
      "https://gateway.example.test/v1#",
      "--set baseUrl must not carry a fragment.",
    ],
  ])("refuses an endpoint with %s by name", (_label, baseUrl, message) => {
    const error = refusal(["--set", `baseUrl=${baseUrl}`]);
    expect(error).toBeInstanceOf(ProfileCliUsageError);
    expect((error as Error).message).toBe(message);
  });

  it("refuses a malformed value by its key", () => {
    const error = refusal(["--set", "maxOutputTokens=lots"]);
    expect(error).toBeInstanceOf(ProfileCliUsageError);
    expect((error as Error).message).toMatch(/^--set maxOutputTokens /u);
  });

  it("refuses plain HTTP to another host, and admits it only to this machine", () => {
    expect(refusal(["--set", "baseUrl=http://models.example.test/v1"])).toMatchObject({
      code: "model-endpoint-insecure-transport",
    });
    for (const baseUrl of [
      "http://127.0.0.1:8080/v1",
      "http://[::1]:8080/v1",
      "http://localhost:8080/v1",
    ]) {
      expect(parseSetOptions(["--set", `baseUrl=${baseUrl}`]).writing.baseUrl).toBe(baseUrl);
    }
  });
});

describe("a resume command repeats the command line's preset and settings", () => {
  function slot(
    presetSource: "cli-flag" | "host-config",
    overrides: Partial<Record<ModelSettingKey, ModelSettingEntry>>,
  ): ModelSlotSettingsV1 {
    const settings = Object.fromEntries(
      MODEL_SETTING_KEYS.map((key) => [
        key,
        overrides[key] ?? { value: null, source: "preset", origin: "the preset" },
      ]),
    ) as Record<ModelSettingKey, ModelSettingEntry>;
    return {
      schemaVersion: 1,
      slot: "writing",
      presetId: "fixture-preset",
      presetSource,
      settings,
      notes: [],
    };
  }

  it("names the --composition preset and each --set pair, and only those", () => {
    const record = slot("cli-flag", {
      maxOutputTokens: { value: 12000, source: "cli-flag", origin: "--set maxOutputTokens" },
      reasoning: { value: true, source: "cli-flag", origin: "--set reasoning" },
      // Settings from the environment or host.yaml are read again on resume.
      reasoningEffort: {
        value: "high",
        source: "environment",
        origin: "MODEL_REASONING_EFFORT",
      },
      contextWindow: { value: 200000, source: "host-config", origin: "host.yaml" },
    });
    expect(commandLineSettings(record)).toEqual({
      compositionId: "fixture-preset",
      sets: ["maxOutputTokens=12000", "reasoning=true"],
    });
    // A preset host.yaml chose is not repeated on the command line.
    expect(commandLineSettings(slot("host-config", {}))).toEqual({ sets: [] });
    expect(commandLineSettings(undefined)).toEqual({ sets: [] });
  });

  it("shows a --set endpoint as a placeholder, and keeps it only for the exact command", () => {
    const record = slot("cli-flag", {
      baseUrl: {
        value: "https://gateway.example.test/v1",
        source: "cli-flag",
        origin: "--set baseUrl",
      },
    });
    expect(commandLineSettings(record).sets).toEqual([
      "baseUrl=<the endpoint the stopped run used>",
    ]);
    expect(commandLineSettings(record, { exactEndpoint: true }).sets).toEqual([
      "baseUrl=https://gateway.example.test/v1",
    ]);
  });
});

describe("an effort and a reasoning setting decide together", () => {
  function record(reasoning: ModelSettingEntry): ModelSlotSettingsV1 {
    const settings = Object.fromEntries(
      MODEL_SETTING_KEYS.map((key) => [
        key,
        { value: null, source: "preset", origin: "the preset" } as ModelSettingEntry,
      ]),
    ) as Record<ModelSettingKey, ModelSettingEntry>;
    settings.reasoning = reasoning;
    settings.reasoningEffort = {
      value: "high",
      source: "environment",
      origin: "MODEL_REASONING_EFFORT",
    };
    return {
      schemaVersion: 1,
      slot: "writing",
      presetId: null,
      presetSource: null,
      settings,
      notes: [],
    };
  }
  const profileFalse = {
    value: false,
    source: "profile-file",
    origin: "profiles/byo.yaml",
  } as const;
  const operatorFalse = { value: false, source: "cli-flag", origin: "--set reasoning" } as const;

  it("lets an effort override a profile file's reasoning: false", () => {
    expect(reasoningEffortDecision(record(profileFalse))).toEqual({
      reasoning: true,
      effort: "high",
      dropped: false,
    });
    expect(
      requestedReasoning({
        modelSettings: record(profileFalse),
        profile: { reasoning: false },
      } as never),
    ).toEqual({ reasoning: true, effort: "high", profileReasoning: false });
  });

  it("drops the effort when an operator sets reasoning to false (control)", () => {
    expect(reasoningEffortDecision(record(operatorFalse))).toEqual({
      reasoning: false,
      dropped: true,
    });
    expect(
      requestedReasoning({
        modelSettings: record(operatorFalse),
        profile: { reasoning: false },
      } as never),
    ).toEqual({ reasoning: false, profileReasoning: false });
  });
});
