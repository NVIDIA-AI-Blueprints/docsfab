// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { decodeCompositionRegistry } from "../src/model-composition/contracts.js";
import {
  assertInstalledDeploymentBaseUrl,
  listInstalledModelCompositions,
  loadInstalledModelCompositionAuthority,
  ModelCompositionError,
  resolveInstalledComposition,
  resolveInstalledExecutableComposition,
  type InstalledModelCompositionAuthority,
  type ModelCompositionErrorCode,
} from "../src/model-composition/index.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { COMPOSITION_EXECUTION_LIMITS } from "../src/config/runtime-loader.js";
import { loadInstalledModelCompositionAuthorityFromTrustedRootForTest } from "../src/model-composition/installed.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { internalOnly } from "./helpers/internal-path.js";

const HUB_ORIGIN = new URL(EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"]).origin;

const runtimeRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];
const hostDispatcherContract = internalOnly(
  "packages/host/src/service/dispatcher/contracts.ts",
  "it reads the hosted dispatcher deadline, and packages/host is not exported",
);

const EXECUTABLE_COMPOSITIONS = [
  "anthropic-claude-opus-4.7-pi",
  "nvidia-inference-claude-opus-5-pi",
  "nvidia-inference-claude-sonnet-5-pi",
  "nvidia-inference-deepseek-v4-pro-pi",
  "nvidia-inference-gpt-6-sol-pi",
  "nvidia-inference-nemotron-3-super-v3-pi",
  "nvidia-inference-nemotron-3-ultra-pi",
  "nvidia-inference-qwen3-5-397b-a17b-pi",
  "nvidia-nemotron-3-super-120b-a12b-pi",
  "nvidia-nemotron-3-ultra-550b-a55b-pi",
  "nvidia-nemotron-3.5-lightning-30b-a3b-pi",
] as const;
const PREFLIGHT_COMPOSITIONS = [
  "anthropic-claude-opus-4.7-claude-code-preflight",
  "openai-gpt-6-sol-codex-preflight",
] as const;
// Retained for provenance: listed and resolvable, but not selectable for a new
// run.
const RETIRED_COMPOSITIONS = [
  "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
  "openai-gpt-5.6-sol-codex-preflight",
  "openai-gpt-5.6-sol-pi",
] as const;
type RetiredCompositionId = (typeof RETIRED_COMPOSITIONS)[number];
// Anthropic Claude via Bedrock through the Inference Hub: policyless records.
const CLAUDE_HUB_COMPOSITIONS = new Set([
  "nvidia-inference-claude-opus-5-pi",
  "nvidia-inference-claude-sonnet-5-pi",
]);
// OpenAI GPT-6 Sol through the Inference Hub: policyless, because the route is
// harness-compatible.
const GPT_6_SOL_HUB_COMPOSITION = "nvidia-inference-gpt-6-sol-pi";
// DeepSeek V4 Pro binds `nvidia/deepseek-ai/deepseek-v4-pro` (#1454): the former
// `azure/` id returns 403. A 2026-09-28 probe of the `nvidia/` id (2 prompts,
// 128 tokens, no tool prompt) returned content with no reasoning split, so the
// record is policyless like GPT-6 Sol.
const DEEPSEEK_HUB_COMPOSITION = "nvidia-inference-deepseek-v4-pro-pi";
// Sealed limits of every Inference Hub record: the Hub Metadata record values
// read 2026-09-28 (#1454, note 71425324). Two exceptions: Sonnet 5's output stays
// at the route-measured 32,768, because the 2026-09-27 route probe (#1401) saw a
// 64,000-token request refused with HTTP 408 although Metadata reports 128,000,
// and Opus 5 on the same gateway uses 32,768 on that sibling evidence.
const HUB_METADATA_LIMITS: Record<string, { context: number; output: number }> = {
  [GPT_6_SOL_HUB_COMPOSITION]: { context: 1_050_000, output: 128_000 },
  "nvidia-inference-claude-sonnet-5-pi": { context: 1_000_000, output: 32_768 },
  "nvidia-inference-claude-opus-5-pi": { context: 1_000_000, output: 32_768 },
  "nvidia-inference-nemotron-3-super-v3-pi": { context: 1_048_576, output: 32_768 },
  "nvidia-inference-nemotron-3-ultra-pi": { context: 1_048_576, output: 32_768 },
  "nvidia-inference-qwen3-5-397b-a17b-pi": { context: 262_144, output: 131_072 },
  [DEEPSEEK_HUB_COMPOSITION]: { context: 1_048_576, output: 384_000 },
};
// The package ceiling is the maximum across records: GPT-6 Sol's context and
// input, and DeepSeek's output.
const PACKAGE_CEILING = {
  contextWindow: 1_050_000,
  maxInputTokens: 1_050_000,
  maxOutputTokens: 384_000,
} as const;

function hubLimits(compositionId: string) {
  const limits = HUB_METADATA_LIMITS[compositionId];
  if (!limits) throw new Error(`no Hub Metadata limits for ${compositionId}`);
  return {
    contextWindow: limits.context,
    maxInputTokens: limits.context,
    maxOutputTokens: limits.output,
  };
}
const RETIREMENT = {
  reason: "provider-end-of-life",
  effectiveAt: "2026-08-26T09:00:00.000Z",
} as const;
// Every retired record, with the exact evidence shape its reason requires and
// the successor its refusal names (the 49B lane declares none).
const RETIRED_EXPECTATIONS: Record<
  RetiredCompositionId,
  {
    readonly retirement: { readonly reason: string; readonly effectiveAt: string } & Record<
      string,
      unknown
    >;
    readonly executionClass: "pi-provider" | "preflight-only";
    readonly modelId: string;
    readonly successor?: string;
  }
> = {
  "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi": {
    retirement: RETIREMENT,
    executionClass: "pi-provider",
    modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  },
  "openai-gpt-5.6-sol-pi": {
    retirement: {
      reason: "superseded-by-operator-decision",
      effectiveAt: "2026-09-28T00:00:00.000Z",
      successorCompositionId: GPT_6_SOL_HUB_COMPOSITION,
      decision: {
        decidedBy: "Lawrence Lane",
        decidedAt: "2026-09-28T00:00:00.000Z",
        record: "docsfab-retirement:openai-gpt-5.6-sol-pi:2026-09-28",
      },
    },
    executionClass: "pi-provider",
    modelId: "gpt-5.6-sol",
    successor: GPT_6_SOL_HUB_COMPOSITION,
  },
  "openai-gpt-5.6-sol-codex-preflight": {
    retirement: {
      reason: "provider-end-of-life",
      effectiveAt: "2026-09-30T00:00:00.000Z",
      successorCompositionId: "openai-gpt-6-sol-codex-preflight",
    },
    executionClass: "preflight-only",
    modelId: "gpt-5.6-sol",
    successor: "openai-gpt-6-sol-codex-preflight",
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function expectCode(run: () => unknown, code: ModelCompositionErrorCode): void {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelCompositionError);
    expect((error as ModelCompositionError).code).toBe(code);
  }
}

async function expectAsyncCode(
  run: () => Promise<unknown>,
  code: ModelCompositionErrorCode,
): Promise<void> {
  try {
    await run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelCompositionError);
    expect((error as ModelCompositionError).code).toBe(code);
  }
}

async function copiedPackageAssets(): Promise<{
  packageRoot: string;
  assetRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-model-compositions-"));
  temporaryRoots.push(root);
  const packageRoot = join(root, "package");
  const assetRoot = join(packageRoot, "model-compositions");
  await Promise.all([
    cp(join(runtimeRoot, "model-compositions"), assetRoot, { recursive: true }),
    cp(join(runtimeRoot, "workflows"), join(packageRoot, "workflows"), { recursive: true }),
  ]);
  return { packageRoot, assetRoot };
}

describe("installed provider-neutral model compositions", () => {
  it("loads the digest-locked package authority and exposes only credential-free summaries", async () => {
    const { authority, snapshot } = await loadInstalledModelCompositionAuthority();
    expect(snapshot.executableCompositionIds).toEqual(EXECUTABLE_COMPOSITIONS);
    expect(snapshot.preflightCompositionIds).toEqual(PREFLIGHT_COMPOSITIONS);
    expect(snapshot.workflowIds).toEqual([
      // A host operation with no model call; it shares the auditor role.
      "audit-documentation",
      "bootstrap",
      "create-documentation",
      // Catalogued but not operator-runnable: the hosted Foundation inspection
      // runs a native host operation and shares the review workflow's record.
      "foundation",
      // Catalogued but not operator-runnable: dispatched by the host spine.
      "foundation-to-patch",
      // Catalogued but not operator-runnable: sealed native tasks dispatched by
      // the host spine. `ia-analysis` has an inference step and binds a model
      // composition; `ia-plan` is a host operation with no model call.
      "ia-analysis",
      "ia-plan",
      // Catalogued but not operator-runnable: the hosted turn shares the review
      // workflow's composition record because the composition digest covers the
      // declared tool set, not the workflow name or its step ids.
      "live-agent-turn",
      "readiness",
      "reconcile-product-behavior",
      "release-documentation-readiness",
      "restructure-documentation",
      "review-documentation",
      // Catalogued but not operator-runnable: a sealed native task that applies
      // an already-signed plan, so its write step makes no model call.
      "site-bootstrap",
      "update-documentation",
    ]);
    expect(snapshot.installedManifestSha256).toMatch(/^[a-f0-9]{64}$/u);

    const summaries = listInstalledModelCompositions(authority);
    expect(summaries.map((entry) => entry.compositionId).sort()).toEqual(
      [...EXECUTABLE_COMPOSITIONS, ...PREFLIGHT_COMPOSITIONS, ...RETIRED_COMPOSITIONS].sort(),
    );
    expect(summaries.every((entry) => entry.technicalApproval === "not-established")).toBe(true);
    expect(summaries.every((entry) => entry.releaseEligible === false)).toBe(true);
    expect(JSON.stringify(summaries)).not.toContain("API_KEY");

    const retired = summaries.filter((entry) => entry.status === "retired");
    expect(retired.map((entry) => entry.compositionId).sort()).toEqual([...RETIRED_COMPOSITIONS]);
    for (const compositionId of RETIRED_COMPOSITIONS) {
      const expected = RETIRED_EXPECTATIONS[compositionId];
      expect(
        retired.find((entry) => entry.compositionId === compositionId),
        compositionId,
      ).toMatchObject({
        status: "retired",
        retirement: expected.retirement,
        executionClass: expected.executionClass,
        modelId: expected.modelId,
      });
    }
    const retirementOf = (compositionId: RetiredCompositionId) =>
      retired.find((entry) => entry.compositionId === compositionId)?.retirement as
        | Record<string, unknown>
        | undefined;
    expect(retirementOf("nvidia-llama-3.3-nemotron-super-49b-v1.5-pi")?.providerNotice).toContain(
      "end of life on 2026-08-26T09:00:00Z",
    );
    expect(retirementOf("openai-gpt-5.6-sol-codex-preflight")?.providerNotice).toContain(
      "Effective September 30",
    );
    // Each reason carries only its own evidence shape.
    expect(retirementOf("openai-gpt-5.6-sol-pi")?.providerNotice).toBeUndefined();
    expect(retirementOf("openai-gpt-5.6-sol-codex-preflight")?.decision).toBeUndefined();
    // A live record must not carry retirement evidence; the pair is exclusive.
    expect(
      summaries
        .filter((entry) => entry.status !== "retired")
        .every((entry) => entry.retirement === undefined),
    ).toBe(true);
  });

  it("refuses a new execution of a retired composition but keeps its record for provenance", async () => {
    const { authority, snapshot } = await loadInstalledModelCompositionAuthority();
    for (const compositionId of RETIRED_COMPOSITIONS) {
      expect(snapshot.compositionIds).toContain(compositionId);
      expect(snapshot.executableCompositionIds).not.toContain(compositionId);
      expect(snapshot.preflightCompositionIds).not.toContain(compositionId);

      // Provenance: completed run records rebind to these exact digests.
      const provenance = resolveInstalledComposition({
        authority,
        compositionId,
        workflowId: "review-documentation",
      });
      const expected = RETIRED_EXPECTATIONS[compositionId];
      expect(provenance.composition).toMatchObject({
        status: "retired",
        retirement: expected.retirement,
        executionClass: expected.executionClass,
        model: { resolvedId: expected.modelId },
      });
      if (compositionId === "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi") {
        expect(provenance.composition.requestPolicy).toMatchObject({
          reasoningControl: { kind: "system-directive", directive: "/no_think" },
        });
        expect(provenance.composition.limitations).toContain("provider-end-of-life");
      }
      expect(provenance.candidate.compositionSha256).toBe(provenance.composition.compositionSha256);

      // Selection for a new execution fails closed and says why.
      let caught: unknown;
      try {
        resolveInstalledExecutableComposition({
          authority,
          compositionId,
          workflowId: "review-documentation",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ModelCompositionError);
      const refusal = caught as ModelCompositionError;
      expect(refusal.code).toBe("composition-retired");
      expect(refusal.message).toBe(
        `Composition "${compositionId}" is retired (${expected.retirement.reason}, effective ${expected.retirement.effectiveAt}) and cannot be selected for a new execution.`,
      );
      if (expected.successor === undefined) {
        expect(refusal.nextAction).toContain("docsfab composition list");
      } else {
        expect(refusal.nextAction).toContain(`Select its successor, \`${expected.successor}\``);
        // The named successor is itself installed and selectable.
        expect([
          ...snapshot.executableCompositionIds,
          ...snapshot.preflightCompositionIds,
        ]).toContain(expected.successor);
      }
    }
  });

  it("requires a policy on the catalog route and admits a policyless record on the hub route", async () => {
    const registryText = await readFile(
      join(runtimeRoot, "model-compositions", "composition-registry.json"),
      "utf8",
    );
    type Registry = {
      compositions: Array<
        Record<string, unknown> & {
          compositionId: string;
          compositionSha256: string;
          requestPolicy?: Record<string, unknown>;
        }
      >;
      registrySha256: string;
    };
    const load = (): Registry => JSON.parse(registryText) as Registry;
    const reseal = (registry: Registry): Registry => {
      for (const composition of registry.compositions) {
        const { compositionSha256: _dropped, ...body } = composition;
        composition.compositionSha256 = canonicalDigest(body);
      }
      const { registrySha256: _registry, ...body } = registry;
      registry.registrySha256 = canonicalDigest(body);
      return registry;
    };
    const find = (registry: Registry, compositionId: string) =>
      registry.compositions.find((entry) => entry.compositionId === compositionId)!;

    // Positive controls from the committed registry: the hub Claude records have
    // no policy, the hub Nemotron record has one, and all decode.
    const decoded = decodeCompositionRegistry(load());
    for (const compositionId of CLAUDE_HUB_COMPOSITIONS) {
      expect(
        decoded.compositions.find((entry) => entry.compositionId === compositionId)?.requestPolicy,
        compositionId,
      ).toBeUndefined();
    }
    expect(
      decoded.compositions.find(
        (entry) => entry.compositionId === "nvidia-inference-nemotron-3-super-v3-pi",
      )?.requestPolicy?.reasoningControl,
    ).toEqual({ kind: "chat-template-kwarg", thinking: false });

    // The catalog route serves reasoning-split SKUs, so a record there needs a policy.
    const catalogWithoutPolicy = load();
    delete find(catalogWithoutPolicy, "nvidia-nemotron-3-super-120b-a12b-pi").requestPolicy;
    expectCode(
      () => decodeCompositionRegistry(reseal(catalogWithoutPolicy)),
      "contract-invalid-value",
    );

    // A policy on a route that emits no control is still refused.
    const strayPolicy = load();
    find(strayPolicy, "anthropic-claude-opus-4.7-pi").requestPolicy = find(
      strayPolicy,
      "nvidia-inference-nemotron-3-super-v3-pi",
    ).requestPolicy;
    expectCode(() => decodeCompositionRegistry(reseal(strayPolicy)), "contract-invalid-value");

    // A hub record may carry a policy, but it must agree with the record.
    const disagreeingPolicy = load();
    find(disagreeingPolicy, "nvidia-inference-claude-sonnet-5-pi").requestPolicy = find(
      disagreeingPolicy,
      "nvidia-inference-nemotron-3-super-v3-pi",
    ).requestPolicy;
    expectCode(
      () => decodeCompositionRegistry(reseal(disagreeingPolicy)),
      "contract-invalid-value",
    );
  });

  it("rejects a half-applied retirement in the composition registry contract", async () => {
    const registryText = await readFile(
      join(runtimeRoot, "model-compositions", "composition-registry.json"),
      "utf8",
    );
    type Registry = {
      compositions: Array<Record<string, unknown> & { status: string; compositionSha256: string }>;
      registrySha256: string;
    };
    const load = (): Registry => JSON.parse(registryText) as Registry;
    // Re-seal digests the way the registry tooling does, so each rejection below
    // is a value rejection, not a digest mismatch.
    const reseal = (registry: Registry): Registry => {
      for (const composition of registry.compositions) {
        const { compositionSha256: _dropped, ...body } = composition;
        composition.compositionSha256 = canonicalDigest(body);
      }
      const { registrySha256: _registry, ...body } = registry;
      registry.registrySha256 = canonicalDigest(body);
      return registry;
    };
    const find = (registry: Registry, compositionId: RetiredCompositionId) =>
      registry.compositions.find((entry) => entry.compositionId === compositionId)!;
    // The provider-end-of-life record the original mutations below were written against.
    const retiredOf = (registry: Registry) =>
      find(registry, "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi");
    const liveOf = (registry: Registry) =>
      registry.compositions.find((entry) => entry.status === "active")!;

    // Positive control: the committed registry decodes and carries every
    // retirement, one per reason shape.
    const decoded = decodeCompositionRegistry(load());
    expect(
      decoded.compositions
        .filter((entry) => entry.status === "retired")
        .map((entry) => entry.compositionId)
        .sort(),
    ).toEqual([...RETIRED_COMPOSITIONS]);
    // Control for the re-seal helper itself: re-sealing unchanged bytes is a no-op.
    expect(reseal(load()).registrySha256).toBe(load().registrySha256);

    const missingEvidence = load();
    delete retiredOf(missingEvidence).retirement;
    expectCode(() => decodeCompositionRegistry(reseal(missingEvidence)), "contract-invalid-value");

    const strayEvidence = load();
    liveOf(strayEvidence).retirement = retiredOf(strayEvidence).retirement;
    expectCode(() => decodeCompositionRegistry(reseal(strayEvidence)), "contract-invalid-value");

    const unknownReason = load();
    (retiredOf(unknownReason).retirement as Record<string, unknown>).reason = "vendor-pricing";
    expectCode(() => decodeCompositionRegistry(reseal(unknownReason)), "contract-invalid-value");

    const looseInstant = load();
    (retiredOf(looseInstant).retirement as Record<string, unknown>).effectiveAt = "2026-08-26";
    expectCode(() => decodeCompositionRegistry(reseal(looseInstant)), "contract-invalid-value");

    const unknownStatus = load();
    retiredOf(unknownStatus).status = "deprecated";
    expectCode(() => decodeCompositionRegistry(reseal(unknownStatus)), "contract-invalid-value");

    // Each reason carries exactly its own evidence; a block that borrows or
    // mixes the other reason's shape is a SHAPE refusal, not a digest one.
    type Retirement = Record<string, unknown> & { decision?: Record<string, unknown> };
    const decisionOf = (registry: Registry) =>
      find(registry, "openai-gpt-5.6-sol-pi").retirement as Retirement;
    const noticeOf = (registry: Registry) =>
      find(registry, "openai-gpt-5.6-sol-codex-preflight").retirement as Retirement;
    // Control: both reason shapes are present in the committed bytes.
    expect(decisionOf(load())).toMatchObject({ reason: "superseded-by-operator-decision" });
    expect(decisionOf(load()).decision).toBeDefined();
    expect(noticeOf(load())).toMatchObject({ reason: "provider-end-of-life" });
    expect(noticeOf(load()).providerNotice).toEqual(expect.any(String));

    // An operator decision dressed as a provider notice.
    const decisionAsNotice = load();
    const borrowed = decisionOf(decisionAsNotice);
    borrowed.providerNotice = String(borrowed.decision?.statement);
    delete borrowed.decision;
    expectCode(() => decodeCompositionRegistry(reseal(decisionAsNotice)), "contract-invalid-shape");

    // An operator decision that also carries a provider notice.
    const mixedDecision = load();
    decisionOf(mixedDecision).providerNotice = noticeOf(mixedDecision).providerNotice;
    expectCode(() => decodeCompositionRegistry(reseal(mixedDecision)), "contract-invalid-shape");

    // A provider end-of-life that also claims an operator decision.
    const noticeWithDecision = load();
    noticeOf(noticeWithDecision).decision = decisionOf(noticeWithDecision).decision;
    expectCode(
      () => decodeCompositionRegistry(reseal(noticeWithDecision)),
      "contract-invalid-shape",
    );

    // A decision that does not say where it is recorded.
    const unrecordedDecision = load();
    delete decisionOf(unrecordedDecision).decision!.record;
    expectCode(
      () => decodeCompositionRegistry(reseal(unrecordedDecision)),
      "contract-invalid-shape",
    );
  });

  it("resolves exact executable Pi compositions without transferring provider authority", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    const expected = {
      "anthropic-claude-opus-4.7-pi": {
        model: "claude-opus-4-7",
        provider: "anthropic",
        route: "anthropic-api",
        transport: "anthropic-messages",
        sources: ["MODEL_API_KEY", "ANTHROPIC_API_KEY"],
      },
      "nvidia-inference-claude-opus-5-pi": {
        model: "aws/anthropic/bedrock-claude-opus-5",
        provider: "nvidia",
        route: "nvidia-inference-api",
        transport: "openai-chat-completions",
        sources: ["MODEL_API_KEY"],
      },
      "nvidia-inference-claude-sonnet-5-pi": {
        model: "aws/anthropic/bedrock-claude-sonnet-5",
        provider: "nvidia",
        route: "nvidia-inference-api",
        transport: "openai-chat-completions",
        sources: ["MODEL_API_KEY"],
      },
      "nvidia-inference-deepseek-v4-pro-pi": {
        model: "nvidia/deepseek-ai/deepseek-v4-pro",
        provider: "nvidia",
        route: "nvidia-inference-api",
        transport: "openai-chat-completions",
        sources: ["MODEL_API_KEY"],
      },
      "nvidia-inference-gpt-6-sol-pi": {
        model: "azure/openai/gpt-6-sol",
        provider: "nvidia",
        route: "nvidia-inference-api",
        transport: "openai-chat-completions",
        sources: ["MODEL_API_KEY"],
      },
      "nvidia-inference-nemotron-3-super-v3-pi": {
        model: "nvidia/nvidia/nemotron-3-super-v3",
        provider: "nvidia",
        route: "nvidia-inference-api",
        transport: "openai-chat-completions",
        sources: ["MODEL_API_KEY"],
      },
      "nvidia-inference-nemotron-3-ultra-pi": {
        model: "nvidia/nvidia/nemotron-3-ultra",
        provider: "nvidia",
        route: "nvidia-inference-api",
        transport: "openai-chat-completions",
        sources: ["MODEL_API_KEY"],
      },
      "nvidia-inference-qwen3-5-397b-a17b-pi": {
        model: "nvidia/qwen/qwen3-5-397b-a17b",
        provider: "nvidia",
        route: "nvidia-inference-api",
        transport: "openai-chat-completions",
        sources: ["MODEL_API_KEY"],
      },
      "nvidia-nemotron-3.5-lightning-30b-a3b-pi": {
        model: "nvidia/nemotron-3.5-lightning-30b-a3b",
        provider: "nvidia",
        route: "nvidia-api-catalog",
        transport: "openai-chat-completions",
        sources: ["DOCSFAB_NVIDIA_API_KEY"],
      },
      "nvidia-nemotron-3-super-120b-a12b-pi": {
        model: "nvidia/nemotron-3-super-120b-a12b",
        provider: "nvidia",
        route: "nvidia-api-catalog",
        transport: "openai-chat-completions",
        sources: ["DOCSFAB_NVIDIA_API_KEY"],
      },
      "nvidia-nemotron-3-ultra-550b-a55b-pi": {
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        provider: "nvidia",
        route: "nvidia-api-catalog",
        transport: "openai-chat-completions",
        sources: ["DOCSFAB_NVIDIA_API_KEY"],
      },
    } as const;
    // The retired direct OpenAI Responses lane is no longer an executable
    // binding; its refusal is asserted in the retirement case above.
    expect(Object.keys(expected).sort()).toEqual([...EXECUTABLE_COMPOSITIONS].sort());

    for (const compositionId of EXECUTABLE_COMPOSITIONS) {
      const bound = resolveInstalledExecutableComposition({
        authority,
        compositionId,
        workflowId: "create-documentation",
      });
      const expectedBinding = expected[compositionId];
      expect(bound.composition.model.resolvedId).toBe(expectedBinding.model);
      expect(bound.composition.deployment.provider).toBe(expectedBinding.provider);
      expect(bound.composition.deployment.routeId).toBe(expectedBinding.route);
      expect(bound.composition.deployment.transport).toBe(expectedBinding.transport);
      expect(bound.composition.authentication.sourceNames).toEqual(expectedBinding.sources);
      expect(bound.composition.authentication.sourceNames).not.toContain(
        "INFERENCE_HUB_METADATA_API_KEY",
      );
      expect(bound.candidate.compositionSha256).toBe(bound.composition.compositionSha256);
      expect(bound.composition.status).toBe("active");
      expect(bound.composition.retirement).toBeUndefined();
      if (CLAUDE_HUB_COMPOSITIONS.has(compositionId)) {
        // Claude is not reasoning-split: no installed request policy, no
        // Nemotron control, no fixed sampling. Limits are the Hub Metadata
        // values; Sonnet 5 keeps its route-measured 32,768 output limit.
        expect(bound.composition.requestPolicy).toBeUndefined();
        expect(bound.composition.model.vendor).toBe("anthropic");
        expect(bound.composition.compositionLimits).toMatchObject(hubLimits(compositionId));
        expect(bound.candidate.proposedLimits).toMatchObject(hubLimits(compositionId));
      } else if (compositionId === DEEPSEEK_HUB_COMPOSITION) {
        // `harness-compatible` on this route for the `nvidia/` id: no installed
        // request policy. The control measured for the former `azure/` id is not
        // evidence about this id.
        expect(bound.composition.requestPolicy).toBeUndefined();
        expect(bound.composition.model.vendor).toBe("deepseek");
        expect(bound.composition.compositionLimits).toMatchObject(hubLimits(compositionId));
        expect(bound.candidate.proposedLimits).toMatchObject(hubLimits(compositionId));
      } else if (compositionId === GPT_6_SOL_HUB_COMPOSITION) {
        // Harness-compatible on this route: text arrives in `content`, so the
        // record carries no installed request policy and no Nemotron control.
        expect(bound.composition.requestPolicy).toBeUndefined();
        expect(bound.composition.model.vendor).toBe("openai");
        expect(bound.composition.compositionLimits).toMatchObject(hubLimits(compositionId));
        expect(bound.candidate.proposedLimits).toMatchObject(hubLimits(compositionId));
      } else if (compositionId.startsWith("nvidia-inference-")) {
        // Inference Hub lanes bind the same control, measured on this route. The
        // control is route-dependent, so a lane here is not evidence about the
        // same model on the catalog route.
        expect(bound.composition.requestPolicy).toMatchObject({
          routeId: "nvidia-inference-api",
          reasoningMode: "disabled",
          reasoningControl: { kind: "chat-template-kwarg", thinking: false },
          temperature: 0,
          topP: 1,
        });
        // Token limits are each model's Hub Metadata values (#1454).
        expect(bound.composition.compositionLimits).toMatchObject(hubLimits(compositionId));
        expect(bound.candidate.proposedLimits).toMatchObject(hubLimits(compositionId));
      } else if (compositionId.startsWith("nvidia-nemotron-3")) {
        // Nemotron 3 binds the one control measured to suppress reasoning on
        // these SKUs. /no_think is inert here, and must not be bound instead.
        expect(bound.composition.requestPolicy).toMatchObject({
          reasoningMode: "disabled",
          reasoningControl: { kind: "chat-template-kwarg", thinking: false },
          temperature: 0,
          topP: 1,
        });
        // The 120B lane's context/input limit is the capacity proven on the
        // route. The other two lanes keep the 49B budget so the cross-lane
        // comparison retains one variable.
        const nemotronLimit =
          compositionId === "nvidia-nemotron-3-super-120b-a12b-pi" ? 524_288 : 128_000;
        expect(bound.composition.compositionLimits).toMatchObject({
          contextWindow: nemotronLimit,
          maxInputTokens: nemotronLimit,
          maxOutputTokens: 8_192,
        });
        expect(bound.candidate.proposedLimits).toMatchObject({
          contextWindow: nemotronLimit,
          maxInputTokens: nemotronLimit,
          maxOutputTokens: 8_192,
        });
      } else {
        expect(bound.candidate.proposedLimits.contextWindow).toBe(65_536);
        expect(bound.composition.compositionLimits.contextWindow).toBe(65_536);
      }
      // The package ceiling is the registry maximum (#1454); each record is
      // still capped by its own compositionLimits.
      expect(bound.compositionCeiling).toMatchObject(PACKAGE_CEILING);
      expect(bound.compositionCeilingSha256).toBe(canonicalDigest(bound.compositionCeiling));
      expect(bound.workflow.steps).toHaveLength(14);
      expect(bound.workflow.steps.filter((step) => step.stepMode === "write")).toEqual([
        expect.objectContaining({
          stepId: "write-documentation",
          stepOrdinal: 3,
          role: "senior-technical-writer",
        }),
        expect.objectContaining({
          stepId: "revise-documentation",
          stepOrdinal: 8,
          role: "senior-technical-writer",
        }),
      ]);
      expect(bound.workflow.steps).toContainEqual(
        expect.objectContaining({
          stepId: "test-audience-understanding",
          stepMode: "read-only",
          stepOrdinal: 13,
          skillId: "test-audience-understanding",
          role: "target-audience-proxy",
        }),
      );
      expect(bound.technicalApproval).toBe("not-established");
      expect(bound.releaseEligible).toBe(false);
    }
  });

  it("keeps every record at its own sealed limit; only route-proven lanes reach the ceiling", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    // Sealed per-record limits. The runtime clamps to
    // min(configured, candidate.proposedLimits, composition.compositionLimits, ceiling),
    // so a record whose own limit is below the ceiling is unaffected by the raise.
    const expectedContext: Record<string, number> = {
      "anthropic-claude-opus-4.7-pi": 65_536,
      // Retired (#1512), resolvable for provenance only; its sealed budget is history.
      "openai-gpt-5.6-sol-pi": 65_536,
      ...Object.fromEntries(
        Object.entries(HUB_METADATA_LIMITS).map(([id, limits]) => [id, limits.context]),
      ),
      "nvidia-nemotron-3.5-lightning-30b-a3b-pi": 128_000,
      "nvidia-nemotron-3-ultra-550b-a55b-pi": 128_000,
      "nvidia-nemotron-3-super-120b-a12b-pi": 524_288,
      // Retired; resolvable for provenance only.
      "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi": 128_000,
      // The preflight-only records are resolvable (`resolveInstalledComposition`
      // does not require executability) and sealed at the budgets of the
      // direct-provider lanes they mirror.
      "anthropic-claude-opus-4.7-claude-code-preflight": 65_536,
      "openai-gpt-6-sol-codex-preflight": 65_536,
      // The retired Codex preflight (#1512), kept for provenance.
      "openai-gpt-5.6-sol-codex-preflight": 65_536,
    };
    // The table must enumerate every installed record, so the identity
    // assertions below range over the whole set.
    expect(Object.keys(expectedContext).sort()).toEqual(
      [...EXECUTABLE_COMPOSITIONS, ...PREFLIGHT_COMPOSITIONS, ...RETIRED_COMPOSITIONS].sort(),
    );
    for (const [compositionId, contextWindow] of Object.entries(expectedContext)) {
      const bound = resolveInstalledComposition({
        authority,
        compositionId,
        workflowId: "review-documentation",
      });
      // Output limit: the Hub Metadata value on the Inference Hub records
      // (Sonnet 5 keeps its route-measured 32,768), and 8,192 everywhere else.
      const maxOutputTokens = HUB_METADATA_LIMITS[compositionId]?.output ?? 8_192;
      expect(bound.composition.compositionLimits, compositionId).toMatchObject({
        contextWindow,
        maxInputTokens: contextWindow,
        maxOutputTokens,
      });
      expect(bound.candidate.proposedLimits, compositionId).toMatchObject({
        contextWindow,
        maxInputTokens: contextWindow,
        maxOutputTokens,
      });
      // No record's output limit exceeds the ceiling either.
      expect(
        bound.composition.compositionLimits.maxOutputTokens <=
          bound.compositionCeiling.maxOutputTokens,
      ).toBe(true);
      // The effective clamp for this record is its own limit, not the ceiling.
      expect(
        Math.min(
          bound.composition.compositionLimits.contextWindow,
          bound.compositionCeiling.contextWindow,
        ),
        compositionId,
      ).toBe(contextWindow);
      // No record exceeds the ceiling; the ceiling is not a loosening.
      expect(
        bound.composition.compositionLimits.contextWindow <= bound.compositionCeiling.contextWindow,
      ).toBe(true);
    }
    // Exactly one record sets each ceiling: GPT-6 Sol's Metadata context and
    // DeepSeek's Metadata output (#1454). A leaked raise on a third record fails
    // here by name.
    const atContextCeiling = Object.entries(expectedContext).filter(
      ([, limit]) => limit === PACKAGE_CEILING.contextWindow,
    );
    expect(atContextCeiling.map(([id]) => id)).toEqual([GPT_6_SOL_HUB_COMPOSITION]);
    const atOutputCeiling = Object.entries(HUB_METADATA_LIMITS).filter(
      ([, limits]) => limits.output === PACKAGE_CEILING.maxOutputTokens,
    );
    expect(atOutputCeiling.map(([id]) => id)).toEqual([DEEPSEEK_HUB_COMPOSITION]);
    // Raised turn and time budgets belong to the named lanes; response bytes are
    // the same for every record. Enumerated per record because a blanket
    // assertion cannot tell a lane-scoped raise from a package-wide one. The
    // GPT-6 Sol hub lane was drafted from this route's template record, so it
    // has the same raised budget.
    const raisedLanes = new Set([
      "nvidia-inference-claude-opus-5-pi",
      "nvidia-inference-claude-sonnet-5-pi",
      GPT_6_SOL_HUB_COMPOSITION,
    ]);
    for (const compositionId of Object.keys(expectedContext)) {
      const bound = resolveInstalledComposition({
        authority,
        compositionId,
        workflowId: "review-documentation",
      });
      const raised = raisedLanes.has(compositionId);
      const expectedLimits = {
        maxProviderTurns: raised ? 512 : 128,
        timeoutMs: raised ? 1_800_000 : 300_000,
        maxResponseBytes: 4_194_304,
      };
      // Both sealed sources: the candidate projection is an independent term of
      // the same minimum, so raising one alone leaves the effective limit unchanged.
      expect(bound.composition.compositionLimits, compositionId).toMatchObject(expectedLimits);
      expect(bound.candidate.proposedLimits, compositionId).toMatchObject(expectedLimits);
      // Each record is clamped by its own limit, not the package ceiling, which
      // is what makes the ceiling raise safe.
      expect(
        Math.min(bound.composition.compositionLimits.timeoutMs, bound.compositionCeiling.timeoutMs),
        compositionId,
      ).toBe(expectedLimits.timeoutMs);
      expect(
        Math.min(
          bound.composition.compositionLimits.maxProviderTurns,
          bound.compositionCeiling.maxProviderTurns,
        ),
        compositionId,
      ).toBe(expectedLimits.maxProviderTurns);
      expect(bound.composition.compositionLimits.timeoutMs, compositionId).toBeLessThanOrEqual(
        bound.compositionCeiling.timeoutMs,
      );
      expect(
        bound.composition.compositionLimits.maxProviderTurns,
        compositionId,
      ).toBeLessThanOrEqual(bound.compositionCeiling.maxProviderTurns);
    }
    // Asserted by identity so that a record newly reaching the ceiling fails.
    const atRaisedTimeout = Object.keys(expectedContext).filter(
      (compositionId) =>
        resolveInstalledComposition({
          authority,
          compositionId,
          workflowId: "review-documentation",
        }).composition.compositionLimits.timeoutMs === 1_800_000,
    );
    expect(atRaisedTimeout.sort()).toEqual([...raisedLanes].sort());
  });

  it.skipIf(hostDispatcherContract.skip)(
    hostDispatcherContract.title(
      "never seals a per-step timer longer than the host dispatcher's whole-job deadline",
    ),
    async () => {
      // A per-step attempt timer above the longest possible job is unreachable:
      // the host dispatcher arms one abort timer around the whole runtime
      // invocation (`packages/host/src/service/dispatcher/invoker.ts`). The bound
      // is read from the host contract rather than restated so the two cannot
      // drift apart.
      const hostContractSource = await readFile(
        resolve(runtimeRoot, "..", "host", "src", "service", "dispatcher", "contracts.ts"),
        "utf8",
      );
      // Read from the exported constant the deadline validation follows.
      const declared = /export const DISPATCHER_JOB_DEADLINE_MAXIMUM_MS = ([\d_]+);/u.exec(
        hostContractSource,
      );
      expect(
        declared,
        "could not find the dispatcher deadlineMilliseconds bound in the host contract",
      ).not.toBeNull();
      const hostJobDeadlineMaximumMs = Number(declared![1]!.replaceAll("_", ""));
      expect(hostJobDeadlineMaximumMs).toBe(10_800_000);
      // The constant is what the contract enforces.
      expect(hostContractSource).toMatch(
        /deadlineMilliseconds:\s*integer\(\s*runtime\.deadlineMilliseconds,\s*DISPATCHER_JOB_DEADLINE_MINIMUM_MS,\s*DISPATCHER_JOB_DEADLINE_MAXIMUM_MS,?\s*\)/u,
      );

      // The runtime's own override ceiling must not exceed it either, or an
      // operator could set DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS above any possible job.
      expect(COMPOSITION_EXECUTION_LIMITS.timeoutMs.max).toBeLessThanOrEqual(
        hostJobDeadlineMaximumMs,
      );
      expect(COMPOSITION_EXECUTION_LIMITS.timeoutMs.default).toBeLessThanOrEqual(
        COMPOSITION_EXECUTION_LIMITS.timeoutMs.max,
      );

      const { authority } = await loadInstalledModelCompositionAuthority();
      const all = [...EXECUTABLE_COMPOSITIONS, ...PREFLIGHT_COMPOSITIONS, ...RETIRED_COMPOSITIONS];
      for (const compositionId of all) {
        const bound = resolveInstalledComposition({
          authority,
          compositionId,
          workflowId: "review-documentation",
        });
        expect(bound.composition.compositionLimits.timeoutMs, compositionId).toBeLessThanOrEqual(
          hostJobDeadlineMaximumMs,
        );
        expect(bound.candidate.proposedLimits.timeoutMs, compositionId).toBeLessThanOrEqual(
          hostJobDeadlineMaximumMs,
        );
      }
      const ceiling = resolveInstalledComposition({
        authority,
        compositionId: "nvidia-inference-claude-sonnet-5-pi",
        workflowId: "review-documentation",
      });
      expect(ceiling.compositionCeiling.timeoutMs).toBeLessThanOrEqual(hostJobDeadlineMaximumMs);
      // The raised lanes sit strictly inside the bound, so the comparison is not
      // vacuous.
      expect(ceiling.composition.compositionLimits.timeoutMs).toBe(1_800_000);
      expect(ceiling.composition.compositionLimits.timeoutMs).toBeLessThan(
        hostJobDeadlineMaximumMs,
      );
    },
  );

  it("keeps Codex and Claude Code records preflight-only", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    for (const compositionId of PREFLIGHT_COMPOSITIONS) {
      const bound = resolveInstalledComposition({
        authority,
        compositionId,
        workflowId: "review-documentation",
      });
      expect(bound.composition.executionClass).toBe("preflight-only");
      expect(
        Object.values(bound.adapters).every((entry) => entry.status === "preflight-only"),
      ).toBe(true);
      expectCode(
        () =>
          resolveInstalledExecutableComposition({
            authority,
            compositionId,
            workflowId: "review-documentation",
          }),
        "composition-not-executable",
      );
    }
    // The retired GPT-5.6 Codex preflight is still preflight-only on record,
    // but a new selection names the retirement before executability.
    const retiredPreflight = resolveInstalledComposition({
      authority,
      compositionId: "openai-gpt-5.6-sol-codex-preflight",
      workflowId: "review-documentation",
    });
    expect(retiredPreflight.composition.executionClass).toBe("preflight-only");
    expectCode(
      () =>
        resolveInstalledExecutableComposition({
          authority,
          compositionId: "openai-gpt-5.6-sol-codex-preflight",
          workflowId: "review-documentation",
        }),
      "composition-retired",
    );
  });

  it("binds configured HTTPS base URLs to the exact deployment identity", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    expect(
      assertInstalledDeploymentBaseUrl({
        authority,
        compositionId: "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      }),
    ).toMatchObject({ requestPath: "/v1/chat/completions" });
    // Retired records keep their sealed deployment identity, so retained run
    // records on the Responses route still rebind.
    expect(
      assertInstalledDeploymentBaseUrl({
        authority,
        compositionId: "openai-gpt-5.6-sol-pi",
        baseUrl: "https://api.openai.com/v1/",
      }),
    ).toMatchObject({
      normalizedBaseUrl: "https://api.openai.com/v1",
      requestPath: "/v1/responses",
    });
    expect(
      assertInstalledDeploymentBaseUrl({
        authority,
        compositionId: "anthropic-claude-opus-4.7-pi",
        baseUrl: "https://api.anthropic.com/v1/",
      }),
    ).toMatchObject({
      normalizedBaseUrl: "https://api.anthropic.com/v1",
      requestPath: "/v1/messages",
    });

    expectCode(
      () =>
        assertInstalledDeploymentBaseUrl({
          authority,
          compositionId: "anthropic-claude-opus-4.7-pi",
          baseUrl: "https://api.anthropic.com/v2",
        }),
      "deployment-binding-mismatch",
    );
    expectCode(
      () =>
        assertInstalledDeploymentBaseUrl({
          authority,
          compositionId: "anthropic-claude-opus-4.7-pi",
          baseUrl: "https://user:password@api.anthropic.com/v1",
        }),
      "deployment-binding-mismatch",
    );
  });

  it("names the recorded origin when a mismatched base URL binds to a different NVIDIA route", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    // The API Catalog and the Inference Hub are different routes that do not
    // authorize each other.
    // This composition installs against the Inference Hub route, so a Catalog
    // origin is refused and the message names the origin DocsFab recorded.
    let caught: unknown;
    try {
      assertInstalledDeploymentBaseUrl({
        authority,
        compositionId: "nvidia-inference-claude-sonnet-5-pi",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelCompositionError);
    const modelCompositionError = caught as ModelCompositionError;
    expect(modelCompositionError.code).toBe("deployment-binding-mismatch");
    expect(modelCompositionError.message).toContain(HUB_ORIGIN);
    expect(modelCompositionError.message).not.toContain("integrate.api.nvidia.com");
    // No credential or secret value belongs in an operator-facing refusal.
    expect(modelCompositionError.message).not.toMatch(/api[_-]?key/i);
    const envelope = toOperatorErrorEnvelope(modelCompositionError);
    expect(envelope.message).toBe(modelCompositionError.message);
    expect(envelope.message).toContain(HUB_ORIGIN);
    expect(envelope.message).not.toContain("[REDACTED]");
  });

  it("falls back to the generic message when a known routeId's mapped origin cannot be proven to match the sealed identity", async () => {
    // EXECUTABLE_ROUTE_BASE_URLS says what origin DocsFab installs for a
    // routeId, not what origin a given composition's identitySha256 was sealed
    // over. A composition can carry a known routeId with an identity sealed
    // against a different origin, so the refusal must not name the mapped
    // origin unless the identity proves it.
    const { assetRoot } = await copiedPackageAssets();

    const compositionRegistryPath = join(assetRoot, "composition-registry.json");
    const candidateRegistryPath = join(assetRoot, "candidate-projections.json");
    const adapterRegistryPath = join(assetRoot, "adapter-registry.json");
    const manifestPath = join(assetRoot, "installed-manifest.json");

    const compositionRegistry = JSON.parse(await readFile(compositionRegistryPath, "utf8"));
    const candidateRegistry = JSON.parse(await readFile(candidateRegistryPath, "utf8"));
    const adapterRegistry = JSON.parse(await readFile(adapterRegistryPath, "utf8"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    const sourceComposition = compositionRegistry.compositions.find(
      (entry: { compositionId: string }) => entry.compositionId === "openai-gpt-5.6-sol-pi",
    );
    const sourceCandidate = candidateRegistry.candidates.find(
      (entry: { compositionId: string }) => entry.compositionId === "openai-gpt-5.6-sol-pi",
    );
    const sourceRouteAdapter = adapterRegistry.adapters.find(
      (entry: { id: string; kind: string }) =>
        entry.kind === "route-evidence" && entry.id === "openai-api-route",
    );
    const sourceConnectionAdapter = adapterRegistry.adapters.find(
      (entry: { id: string; kind: string }) =>
        entry.kind === "provider-connection" && entry.id === "pi-openai-responses",
    );

    // A different sealed origin for the same routeId, transport and provider,
    // computed with the semantics `assertInstalledDeploymentBaseUrl` uses.
    const legacyOrigin = "https://openai-legacy-proxy.nvidia-internal.example.com";
    const legacyIdentitySha256 = canonicalDigest({
      schemaVersion: 1,
      origin: legacyOrigin,
      route: "/v1/responses",
      provider: "openai",
    });
    // The mapped origin must not produce this identity, or the guard is not
    // exercised.
    const mappedIdentitySha256 = canonicalDigest({
      schemaVersion: 1,
      origin: "https://api.openai.com",
      route: "/v1/responses",
      provider: "openai",
    });
    expect(legacyIdentitySha256).not.toBe(mappedIdentitySha256);

    const newCompositionId = "openai-gpt-5.6-sol-legacy-proxy-pi";
    const newRouteAdapterId = "openai-api-route-legacy-proxy";
    const newConnectionAdapterId = "pi-openai-responses-legacy-proxy";

    const { compositionSha256: _sourceCompositionSha256, ...compositionBody } = sourceComposition;
    const newComposition = {
      ...compositionBody,
      compositionId: newCompositionId,
      deployment: { ...compositionBody.deployment, identitySha256: legacyIdentitySha256 },
      adapters: {
        ...compositionBody.adapters,
        routeEvidence: { id: newRouteAdapterId, version: "1.0.0" },
        providerConnection: { id: newConnectionAdapterId, version: "1.0.0" },
      },
    };
    (newComposition as { compositionSha256?: string }).compositionSha256 =
      canonicalDigest(newComposition);
    compositionRegistry.compositions.push(newComposition);

    const { candidateSha256: _sourceCandidateSha256, ...candidateBody } = sourceCandidate;
    const newCandidate = {
      ...candidateBody,
      candidateId: "candidate-openai-gpt-5.6-sol-legacy-proxy",
      compositionId: newCompositionId,
      compositionSha256: newComposition.compositionSha256,
      deploymentIdentitySha256: legacyIdentitySha256,
      providerConnectionAdapter: { id: newConnectionAdapterId, version: "1.0.0" },
    };
    (newCandidate as { candidateSha256?: string }).candidateSha256 = canonicalDigest(newCandidate);
    candidateRegistry.candidates.push(newCandidate);

    adapterRegistry.adapters.push(
      {
        ...sourceRouteAdapter,
        id: newRouteAdapterId,
        deploymentIdentitySha256: legacyIdentitySha256,
      },
      {
        ...sourceConnectionAdapter,
        id: newConnectionAdapterId,
        deploymentIdentitySha256: legacyIdentitySha256,
      },
    );

    const { registrySha256: _compositionRegistrySha256, ...compositionRegistryBody } =
      compositionRegistry;
    compositionRegistry.registrySha256 = canonicalDigest(compositionRegistryBody);
    const { registrySha256: _candidateRegistrySha256, ...candidateRegistryBody } =
      candidateRegistry;
    candidateRegistry.registrySha256 = canonicalDigest(candidateRegistryBody);
    const { registrySha256: _adapterRegistrySha256, ...adapterRegistryBody } = adapterRegistry;
    adapterRegistry.registrySha256 = canonicalDigest(adapterRegistryBody);

    const compositionRegistryText = `${JSON.stringify(compositionRegistry, null, 2)}\n`;
    const candidateRegistryText = `${JSON.stringify(candidateRegistry, null, 2)}\n`;
    const adapterRegistryText = `${JSON.stringify(adapterRegistry, null, 2)}\n`;
    await writeFile(compositionRegistryPath, compositionRegistryText);
    await writeFile(candidateRegistryPath, candidateRegistryText);
    await writeFile(adapterRegistryPath, adapterRegistryText);

    const fileSha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    for (const asset of manifest.assets) {
      if (asset.kind === "composition-registry") {
        asset.fileSha256 = fileSha256(compositionRegistryText);
        asset.contractSha256 = compositionRegistry.registrySha256;
      } else if (asset.kind === "candidate-projections") {
        asset.fileSha256 = fileSha256(candidateRegistryText);
        asset.contractSha256 = candidateRegistry.registrySha256;
      } else if (asset.kind === "adapter-registry") {
        asset.fileSha256 = fileSha256(adapterRegistryText);
        asset.contractSha256 = adapterRegistry.registrySha256;
      }
    }
    const { installedManifestSha256: _priorManifestSha256, ...manifestBody } = manifest;
    manifest.installedManifestSha256 = canonicalDigest(manifestBody);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, manifestText);

    const { authority } = await loadInstalledModelCompositionAuthorityFromTrustedRootForTest(
      assetRoot,
      fileSha256(manifestText),
    );

    let caught: unknown;
    try {
      assertInstalledDeploymentBaseUrl({
        authority,
        compositionId: newCompositionId,
        baseUrl: "https://api.openai.com/v1",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelCompositionError);
    const modelCompositionError = caught as ModelCompositionError;
    expect(modelCompositionError.code).toBe("deployment-binding-mismatch");
    expect(modelCompositionError.message).toMatch(/does not match the deployment identity/u);
    expect(modelCompositionError.message).toContain(newCompositionId);
    // The unproven mapped origin is not named.
    expect(modelCompositionError.message).not.toMatch(/DocsFab recorded the origin/u);
    expect(modelCompositionError.message).not.toContain("api.openai.com");
  });

  it("rejects forged authority, unknown selection, and target-supplied registry fields", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    expectCode(() => listInstalledModelCompositions({ kind: authority.kind }), "authority-invalid");
    expectCode(
      () =>
        resolveInstalledComposition({
          authority,
          compositionId: "unknown",
          workflowId: "review-documentation",
        }),
      "unknown-composition",
    );
    expectCode(
      () =>
        resolveInstalledComposition({
          authority,
          compositionId: EXECUTABLE_COMPOSITIONS[0],
          workflowId: "unknown",
        }),
      "unknown-workflow",
    );
    expectCode(
      () =>
        resolveInstalledComposition({
          authority,
          compositionId: EXECUTABLE_COMPOSITIONS[0],
          workflowId: "review-documentation",
          compositionRegistry: {},
        } as never),
      "contract-invalid-shape",
    );
    expectCode(
      () =>
        resolveInstalledComposition(
          new Proxy(
            {
              authority,
              compositionId: EXECUTABLE_COMPOSITIONS[0],
              workflowId: "review-documentation",
            },
            {},
          ),
        ),
      "contract-invalid-shape",
    );
    let getterInvoked = false;
    const accessorInput = {
      authority,
      workflowId: "review-documentation",
      get compositionId() {
        getterInvoked = true;
        return EXECUTABLE_COMPOSITIONS[0];
      },
    };
    expectCode(() => resolveInstalledComposition(accessorInput), "contract-invalid-shape");
    expect(getterInvoked).toBe(false);
  });

  it("rejects asset-byte tampering before contract resolution", async () => {
    const { assetRoot } = await copiedPackageAssets();
    const path = join(assetRoot, "adapter-registry.json");
    await writeFile(path, `${await readFile(path, "utf8")}\n`);
    await expectAsyncCode(
      () => loadInstalledModelCompositionAuthorityFromTrustedRootForTest(assetRoot),
      "asset-file-digest-mismatch",
    );
  });

  it("rejects a self-consistent installed-manifest replacement against the compiled trust root", async () => {
    const { assetRoot } = await copiedPackageAssets();
    const path = join(assetRoot, "installed-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.compositionCeiling.maxProviderTurns = 5;
    manifest.compositionCeilingSha256 = canonicalDigest(manifest.compositionCeiling);
    const { installedManifestSha256: _prior, ...body } = manifest;
    manifest.installedManifestSha256 = canonicalDigest(body);
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await expectAsyncCode(
      () => loadInstalledModelCompositionAuthorityFromTrustedRootForTest(assetRoot),
      "installed-manifest-digest-mismatch",
    );
  });

  it("rejects workflow source drift even when composition assets are unchanged", async () => {
    const { packageRoot, assetRoot } = await copiedPackageAssets();
    const path = join(packageRoot, "workflows", "create-documentation.json");
    await writeFile(path, `${await readFile(path, "utf8")}\n`);
    await expectAsyncCode(
      () => loadInstalledModelCompositionAuthorityFromTrustedRootForTest(assetRoot),
      "workflow-source-digest-mismatch",
    );
  });
});
