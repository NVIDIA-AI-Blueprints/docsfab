// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { bindFirstPassKnowledge } from "../src/cli/first-pass.js";
import type { FirstPassSupportModelBridge } from "../src/cli/first-pass-support.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { OperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import {
  attested,
  bindingContext,
  implementationBridge,
  inventoryReader,
  retainedSupport,
  updateRequest,
  workspaceWith,
} from "./helpers/first-pass-bounds-fixture.js";
import { parseEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

// Without --composition, the support bridge connects through the operator
// binding. These two seams stand in for the binding resolver and the
// provider-bound bridge; bindFirstPassKnowledge and the host limits are real.
const seams = vi.hoisted(() => ({
  binding: undefined as undefined | (() => Promise<unknown>),
  bindingCalls: 0,
  bridgeInputs: [] as Array<Record<string, unknown>>,
  bridge: undefined as undefined | (() => unknown),
}));

vi.mock("../src/cli/first-pass-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass-support.js")>();
  return {
    ...actual,
    firstPassOperatorBinding: () => {
      seams.bindingCalls += 1;
      return seams.binding!();
    },
    createFirstPassSupportModelBridge: (input: Record<string, unknown>) => {
      seams.bridgeInputs.push(input);
      return seams.bridge!();
    },
  };
});

// Counts resolutions; a bridge that resolved its own binding would reach it.
const resolver = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../src/model/operator-execution-binding.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/model/operator-execution-binding.js")>();
  return {
    ...actual,
    resolveOperatorExecutionBinding: async () => {
      resolver.calls += 1;
      throw new Error("the bridge resolved a binding of its own");
    },
  };
});

const roots = temporaryRoots();
const CASE_MS = testTimeoutMs(60_000);
const SOURCE = "src/widget/retry_backoff.py";
const FILES = {
  "docs/guide.md": "# Guide\n\nThe widget client retries.\n",
  [SOURCE]: "RETRY_BACKOFF_SECONDS = 30  # widget retry backoff\n",
};

afterEach(() => {
  resolver.calls = 0;
  seams.binding = undefined;
  seams.bindingCalls = 0;
  seams.bridgeInputs.length = 0;
  seams.bridge = undefined;
});

async function bindWithoutComposition() {
  const workspace = await workspaceWith(roots, FILES);
  await bindFirstPassKnowledge({
    request: updateRequest(
      "Update docs/guide.md to describe how the widget scheduler retries with backoff.",
    ),
    // The configured endpoint claims a 65,536-token window; the binding's wins.
    ...bindingContext(workspace, { maxInputTokens: 65_536, reservedContextTokens: 1_024 }),
    trackedSourceReader: inventoryReader(workspace.tracked),
  });
  return retainedSupport(workspace.root);
}

describe("first-pass prompt window on the operator binding path", () => {
  it("sizes the prompt from the operator binding's admitted window and connects the bridge through it", {
    timeout: CASE_MS,
  }, async () => {
    const binding = Promise.resolve({
      profile: attested({ maxInputTokens: 524_288, reservedContextTokens: 4_096 }),
    } as unknown as OperatorExecutionBinding);
    seams.binding = () => binding;
    seams.bridge = () => implementationBridge(SOURCE) satisfies FirstPassSupportModelBridge;

    const support = await bindWithoutComposition();
    expect(support.terminationReason).toBe("supported");
    // 0.75 of 524,288 tokens less its 4,096-token reserve, at three bytes a token.
    expect(support.limits.maxPresentedBytes).toBe(1_170_432);
    // Resolved once, and the bridge connects through that same binding.
    expect(seams.bindingCalls).toBe(1);
    expect(seams.bridgeInputs).toHaveLength(1);
    expect(seams.bridgeInputs[0]!.operatorBinding).toBe(binding);
  });

  it("sizes nothing from a binding that fails and hands the failure to the bridge", {
    timeout: CASE_MS,
  }, async () => {
    // Rejected when requested, as resolution would be, so the host's handler
    // is the first to see it.
    let failure: Promise<unknown> | undefined;
    seams.binding = () => {
      failure = Promise.reject(new Error("no installed composition matches"));
      return failure;
    };
    seams.bridge = () => implementationBridge(SOURCE);

    const support = await bindWithoutComposition();
    // No attested window: one turn's input share stands in, never the
    // configured endpoint's window.
    expect(support.limits.maxPresentedBytes).toBe(3 * Math.floor(0.75 * 1_050_000));
    expect(failure).toBeDefined();
    expect(seams.bridgeInputs[0]!.operatorBinding).toBe(failure);
    await expect(failure).rejects.toThrow("no installed composition matches");
  });

  it("resolves no operator binding for an embedder that supplies its own model bridge", {
    timeout: CASE_MS,
  }, async () => {
    seams.binding = () =>
      Promise.resolve({
        profile: attested({ maxInputTokens: 65_536, reservedContextTokens: 1_024 }),
      });
    const workspace = await workspaceWith(roots, FILES);
    await bindFirstPassKnowledge({
      request: updateRequest(
        "Update docs/guide.md to describe how the widget scheduler retries with backoff.",
      ),
      ...bindingContext(workspace),
      supportModelBridge: implementationBridge(SOURCE),
      trackedSourceReader: inventoryReader(workspace.tracked),
    });
    const support = await retainedSupport(workspace.root);
    expect(seams.bindingCalls).toBe(0);
    expect(seams.bridgeInputs).toHaveLength(0);
    // The bridge it supplied may serve any model, so one turn's share stands in.
    expect(support.limits.maxPresentedBytes).toBe(3 * Math.floor(0.75 * 1_050_000));
  });

  it("connects the real support bridge through the binding the host resolved, without resolving again", async () => {
    const { createFirstPassSupportModelBridge } = await vi.importActual<
      typeof import("../src/cli/first-pass-support.js")
    >("../src/cli/first-pass-support.js");
    const hostBinding = Promise.reject(new Error("the host's binding failed"));
    // The host attaches its handler as soon as it resolves the binding.
    hostBinding.catch(() => undefined);
    const bridge = createFirstPassSupportModelBridge({
      config: {
        retryPolicy: { maxRetries: 0 },
        model: { profile: { maxInputTokens: 8_192, maxOutputTokens: 256 } },
      } as unknown as DocsFabConfig,
      repositoryRevision: "e".repeat(40),
      loadEvidenceFrameParser: async () => parseEvidenceFrames,
      operatorBinding: hostBinding as Promise<OperatorExecutionBinding>,
    });
    await expect(
      bridge.call({
        systemPrompt: "Assess repository support.",
        prompt: "Phase: obligation-decomposition\n\nReturn one bounded JSON result.",
        maxOutputTokens: 128,
        procedureId: "test-procedure",
        procedureSha256: "a".repeat(64),
        promptSha256: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ rule: "model-connection-failed" });
    expect(resolver.calls).toBe(0);
  });
});
