// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The read budget a release pages to comes from the model the run binds, at
 * the early-check site in `withLocalWorkflowRun`: the same rule execution
 * applies when it hands each step its budget.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { runSourceReadBudget, resolveRunOperatorBinding } from "../src/cli/run/execution.js";
import type { CliRunInvocation } from "../src/cli/run/request.js";
import { sourceReadBudgetForModel } from "../src/cli/run/source-acquisition.js";
import { ChangeSourceError, parseChangeSourceSelector } from "../src/inputs/change-source.js";
import type { SourceReadBudgetV1 } from "../src/inputs/source-step-policy.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { commitFiles, fixtureGit } from "./support/change-source-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

/** What the early-check site asked for, and the budget the test hands back. */
const seen = vi.hoisted(() => ({ calls: 0, budget: undefined as SourceReadBudgetV1 | undefined }));

vi.mock("../src/cli/run/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/run/execution.js")>();
  return {
    ...actual,
    runSourceReadBudget: (...args: Parameters<typeof actual.runSourceReadBudget>) => {
      seen.calls += 1;
      return seen.budget ?? actual.runSourceReadBudget(...args);
    },
  };
});

const roots = temporaryRoots();

afterEach(() => {
  process.exitCode = undefined;
  seen.calls = 0;
  seen.budget = undefined;
});

function refusingInterpreter(): {
  port: RequestIntentInterpreterPort;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      async call() {
        calls += 1;
        throw new Error("request-intent model call reached in a pre-model refusal test");
      },
    },
  };
}

describe("docsfab run --change release: pages to the bound model's read budget", () => {
  it(
    "refuses before any model call when the bound model's budget holds no one-unit index",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      await fixtureGit(fixture.repository, ["tag", "base"]);
      await commitFiles(fixture.repository, { "src/one.ts": "export const one = 1;\n" }, "one");
      await commitFiles(fixture.repository, { "src/two.ts": "export const two = 2;\n" }, "two");
      const run = async () => {
        const model = new SourceToolHarness({
          readOnSkill: null,
          planSourcePaths: [],
        });
        const interpreter = refusingInterpreter();
        const error = await executeRunRequest(
          {
            ...runRequest(fixture),
            changeSource: parseChangeSourceSelector("release:base..HEAD"),
          },
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: model,
            skillResolver,
            requestInterpreter: interpreter.port,
          },
        ).catch((caught: unknown) => caught);
        return { error, interpreter, model };
      };

      seen.budget = {
        budgetBytes: 200,
        basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 1_333 },
      };
      const refused = await run();
      expect(seen.calls).toBeGreaterThan(0);
      expect(refused.error).toBeInstanceOf(ChangeSourceError);
      expect((refused.error as ChangeSourceError).code).toBe(
        "change-source-release-index-over-read-budget",
      );
      expect((refused.error as ChangeSourceError).detail).toMatch(
        /over the 200-byte source-read budget of one step \(sources\.readInputWindowShare = 0\.15 of the model's 1333-token input window\)$/u,
      );
      expect(refused.interpreter.calls()).toBe(0);
      expect(refused.model.calls).toEqual([]);

      // Adjacent: the execution rule's own budget for this run admits the release.
      seen.budget = undefined;
      const admitted = await run();
      expect(admitted.error).not.toBeInstanceOf(ChangeSourceError);
      expect(admitted.interpreter.calls()).toBe(1);
    },
    testTimeoutMs(120_000),
  );

  it("sizes from a sealed composition's window, and keeps the ceiling under an injected harness", async () => {
    const executionProfile = {
      contextAdmission: "host-window",
      profile: { maxInputTokens: 128_000, effectiveLimitReason: "composition-candidate" },
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 1_024 },
    };
    const composition = {
      request: { workflow: "update-documentation" },
      config: {},
      options: {},
      compositionRuntime: { executionProfile },
    } as unknown as CliRunInvocation;
    expect(await resolveRunOperatorBinding(composition)).toBeUndefined();
    expect(runSourceReadBudget(composition, undefined)).toEqual({
      budgetBytes: 76_185,
      basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 126_976 },
    });
    // Adjacent: the same composition under an injected harness binds no model.
    const harnessed = {
      ...composition,
      options: {
        executionHarness: new SourceToolHarness({
          readOnSkill: null,
          planSourcePaths: [],
        }),
      },
    } as unknown as CliRunInvocation;
    expect(await resolveRunOperatorBinding(harnessed)).toBeUndefined();
    expect(runSourceReadBudget(harnessed, undefined)).toEqual(sourceReadBudgetForModel(undefined));
  });
});
