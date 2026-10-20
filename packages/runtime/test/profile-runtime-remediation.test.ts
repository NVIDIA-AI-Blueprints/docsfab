// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleProfileCommand } from "../src/cli/commands/profile.js";
import { runProfileDraft } from "../src/cli/profile-draft.js";
import type { InstalledExecutionComposition } from "../src/model-composition/types.js";
import { CLOSED_EVAL_PRESET_IDS } from "../src/model/profile-apply/eval-presets.js";
import {
  formatOperatorErrorEnvelope,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";

/*
 * #1094 route matrix. The other executing rows are:
 * argument refusal (all six commands), inspect configuration and approval
 * artifacts: profile-approval-remediation.test.ts;
 * inspect evidence field/source and advisory date: profile-inspect-remediation.test.ts;
 * approve/rollback ambiguous transactions: profile-ambiguous-routing.test.ts;
 * probe transport/proxy and offline success: profile-probe-compatibility.test.ts.
 * This file covers parsed probe/draft/seed runtime refusals through the handler.
 * The template-mismatch branch requires an injected installed authority and is
 * separately marked as a lower-level row below.
 */

type ProfileCommand = "probe" | "draft" | "seed";

function expectNoProfileCommandLoop(nextAction: string | undefined, command: ProfileCommand): void {
  expect(nextAction?.trim()).toBeTruthy();
  expect(nextAction).not.toMatch(new RegExp(`docsfab profile ${command}(?![\\w-])`, "u"));
}

function expectNonLoopingProjection(
  error: unknown,
  command: ProfileCommand,
  expectedMessage: string,
): void {
  expect(error).toBeInstanceOf(Error);
  const envelope = toOperatorErrorEnvelope(error);
  expect(envelope.message).toContain(expectedMessage);
  expectNoProfileCommandLoop(envelope.nextAction, command);
  const invocation = new RegExp(`docsfab profile ${command}(?![\\w-])`, "u");

  const human = formatOperatorErrorEnvelope(envelope);
  const json = JSON.parse(serializeOperatorErrorEnvelope(envelope)) as {
    code: string;
    nextAction?: string;
  };
  expect(human).toContain(`code: ${envelope.code}`);
  expect(human).toContain(`Next action: ${envelope.nextAction}`);
  expect(human).not.toMatch(new RegExp(`Next action:.*${invocation.source}`, "u"));
  expect(json.code).toBe(envelope.code);
  expect(json.nextAction).toBe(envelope.nextAction);
  expect(json.nextAction).not.toMatch(invocation);
}

async function commandFailure(argv: string[]): Promise<unknown> {
  return handleProfileCommand(argv).then(
    () => undefined,
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parsed profile runtime refusals (#1094)", () => {
  it.each(["probe", "draft", "seed"] as const)(
    "rejects a self-repeating %s action even when it includes flags",
    (command) => {
      expect(() =>
        expectNoProfileCommandLoop(`Run docsfab profile ${command} --json.`, command),
      ).toThrow();
    },
  );

  it("keeps the supported probe route offline without asking for a credential", async () => {
    const fetch = vi.fn();
    const printed: string[] = [];
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    await handleProfileCommand([
      "probe",
      "--route",
      "nvidia-api-catalog",
      "--model",
      "vendor/model",
      "--json",
    ]);
    const observation = JSON.parse(printed.join("\n")) as {
      kind: string;
      live: boolean;
      verdict: string;
    };
    expect(observation).toMatchObject({
      kind: "docsfab-profile-probe-observation",
      live: false,
      verdict: "not-requested",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["probe", ["probe", "--route", "nvidia-api-catalog", "--model", "gpt-5"], "prefix matchers"],
    [
      "probe",
      ["probe", "--route", "other-route", "--model", "vendor/model"],
      "unknown serving route",
    ],
    [
      "draft",
      [
        "draft",
        "--route",
        "nvidia-api-catalog",
        "--model",
        "gpt-5",
        "--verdict",
        "harness-compatible",
      ],
      "prefix matchers",
    ],
    [
      "draft",
      [
        "draft",
        "--route",
        "other-route",
        "--model",
        "vendor/model",
        "--verdict",
        "harness-compatible",
      ],
      "unknown serving route",
    ],
    [
      "draft",
      [
        "draft",
        "--route",
        "nvidia-api-catalog",
        "--model",
        "vendor/model",
        "--verdict",
        "unreachable",
      ],
      "unreachable probe verdicts",
    ],
    [
      "draft",
      [
        "draft",
        "--route",
        "nvidia-api-catalog",
        "--model",
        "vendor/model",
        "--verdict",
        "reasoning-split-uncontrolled",
      ],
      "reasoning-split-uncontrolled",
    ],
    [
      "draft",
      [
        "draft",
        "--route",
        "nvidia-api-catalog",
        "--model",
        "vendor/model",
        "--verdict",
        "harness-compatible",
      ],
      "requires a reasoning-split-controllable verdict",
    ],
    [
      "draft",
      [
        "draft",
        "--route",
        "openai-api",
        "--model",
        "vendor/model",
        "--verdict",
        "harness-compatible",
      ],
      "no installed executable template",
    ],
  ] as const)("routes parsed %s refusal without a command loop", async (command, argv, message) => {
    expectNonLoopingProjection(await commandFailure([...argv, "--json"]), command, message);
  });

  it("refuses a missing live credential before any provider request", async () => {
    vi.stubEnv("MODEL_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const error = await commandFailure([
      "probe",
      "--route",
      "openai-api",
      "--model",
      "openai/gpt-4o",
      "--live",
      "--json",
    ]);
    expectNonLoopingProjection(error, "probe", "MODEL_API_KEY is not set");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an unknown preset before touching owner configuration", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-profile-route-")));
    try {
      await chmod(root, 0o700);
      vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
      const error = await commandFailure(["seed", "--preset", "unknown-preset", "--json"]);
      expectNonLoopingProjection(error, "seed", "unknown --preset");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing seed credential before mutating owner configuration", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-profile-route-")));
    try {
      await chmod(root, 0o700);
      vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
      vi.stubEnv("MODEL_API_KEY", undefined);
      vi.stubEnv("OPENAI_API_KEY", undefined);
      const error = await commandFailure(["seed", "--preset", CLOSED_EVAL_PRESET_IDS[0], "--json"]);
      expectNonLoopingProjection(error, "seed", "requires MODEL_API_KEY");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a conflicting owner MODEL block after seed refusal", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-profile-route-")));
    const ownerFile = resolve(root, ".env");
    const before = "MODEL_ID=owner/model\nOWNER_SETTING=retained\n";
    try {
      await chmod(root, 0o700);
      await writeFile(ownerFile, before, { mode: 0o600 });
      vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
      vi.stubEnv("MODEL_API_KEY", "test-only-key");
      const error = await commandFailure(["seed", "--preset", CLOSED_EVAL_PRESET_IDS[0], "--json"]);
      expectNonLoopingProjection(error, "seed", "conflicting MODEL profile");
      expect(await readFile(ownerFile, "utf8")).toBe(before);
      expect(await readdir(root)).toEqual([".env"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes a mismatched installed draft template through the lower-level seam", async () => {
    const error = await runProfileDraft(
      {
        routeId: "openai-api",
        modelId: "vendor/model",
        verdict: "harness-compatible",
        json: true,
      },
      {
        loadTemplate: async () => {
          return {
            deployment: { routeId: "nvidia-api-catalog" },
          } as unknown as InstalledExecutionComposition;
        },
      },
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    // This is the one lower-level row: the real handler uses installed authority.
    expectNonLoopingProjection(error, "draft", "template does not match");
  });
});
