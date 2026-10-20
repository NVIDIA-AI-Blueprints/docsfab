// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import {
  loadInstalledModelCompositionAuthority,
  ModelCompositionError,
  resolveInstalledComposition,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
  type CompositionModelLimits,
} from "../src/model-composition/index.js";
import {
  createCompositionExecutionAggregate,
  createCompositionExecutionEvidence,
  parseCompositionExecutionEvidence,
  type CreateCompositionExecutionEvidenceInput,
  type CompositionExecutionEvidenceV1,
} from "../src/records/composition-execution.js";
import type { RunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { configureCredential } from "./helpers/configured-credential.js";

const runtimeRoot = resolve(import.meta.dirname, "..");

// The direct OpenAI Responses record retired by #1512. New executions refuse
// it; completed runs recorded under it must keep validating.
const RETIRED_GPT_56_SOL = "openai-gpt-5.6-sol-pi";
const GPT_6_SOL_SUCCESSOR = "nvidia-inference-gpt-6-sol-pi";

const REPOSITORY = {
  identitySha256: "a".repeat(64),
  revision: "b".repeat(40),
} as const;

const CONFIGURED_LIMITS: CompositionModelLimits = {
  contextWindow: 128_000,
  maxInputTokens: 128_000,
  maxOutputTokens: 10_000,
  // Must stay above every digest-sealed source: the fixture exercises "a
  // sealed ceiling clamps a looser host config", which holds only while the
  // host value is the larger one. The guard test below fails if it inverts.
  maxProviderTurns: 4_096,
  timeoutMs: 420_000,
  maxResponseBytes: 100_000,
};

async function fixture(
  compositionId = "anthropic-claude-opus-4.7-pi",
): Promise<CreateCompositionExecutionEvidenceInput> {
  const { authority } = await loadInstalledModelCompositionAuthority();
  const bound = resolveInstalledExecutableComposition({
    authority,
    compositionId,
    workflowId: "review-documentation",
  });
  return {
    runId: "composition-evidence-run",
    bound,
    executionProfile: executionProfile(bound),
    configuredLimits: CONFIGURED_LIMITS,
    workflow: { id: bound.workflow.workflowId, sourceSha256: bound.workflow.sourceSha256 },
    repository: REPOSITORY,
  };
}

/**
 * The effective provider-turn budget: the minimum across the host-configured
 * vector and the three digest-sealed sources, as `deriveEffectiveLimits`
 * (src/records/composition-execution.ts) computes it and as
 * `src/cli/run/composition-runtime.ts` builds the policy in production. Derived,
 * not pinned, so a moved sealed budget does not break every fixture here.
 */
function effectiveProviderTurns(bound: BoundExecutableComposition): number {
  return Math.min(
    CONFIGURED_LIMITS.maxProviderTurns,
    bound.candidate.proposedLimits.maxProviderTurns,
    bound.composition.compositionLimits.maxProviderTurns,
    bound.compositionCeiling.maxProviderTurns,
  );
}

function executionProfile(bound: BoundExecutableComposition): BoundModelExecutionProfile {
  const transport = bound.composition.deployment.transport;
  const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
  const effectiveContextWindow =
    bound.composition.deployment.routeId === "nvidia-api-catalog" ? 128_000 : 65_536;
  return {
    routeId: bound.composition.deployment.routeId,
    providerId: bound.composition.deployment.routeId,
    // The preset's own endpoint: a run with no operator override writes v1 evidence.
    baseUrl:
      EXECUTABLE_ROUTE_BASE_URLS[
        bound.composition.deployment.routeId as keyof typeof EXECUTABLE_ROUTE_BASE_URLS
      ],
    modelId: bound.composition.model.resolvedId,
    transport,
    apiFormat,
    profile: {
      configuredLimits: {
        contextWindow: CONFIGURED_LIMITS.contextWindow,
        maxInputTokens: CONFIGURED_LIMITS.maxInputTokens,
        maxOutputTokens: CONFIGURED_LIMITS.maxOutputTokens,
      },
      contextWindow: effectiveContextWindow,
      maxInputTokens: effectiveContextWindow,
      maxOutputTokens: 8_192,
      effectiveLimitReason: "none",
      reasoning: false,
      input: ["text"],
      compatibility: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        apiFormats: [apiFormat],
      },
      costPerMillionTokens: {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
      },
      metadata: {
        approvedSource: null,
        effectiveDate: null,
        reviewAfter: null,
        status: "unknown",
      },
    },
    requestPolicy: { minimumOutputTokens: 256, reservedContextTokens: 4_096 },
    ...(bound.composition.requestPolicy
      ? { compositionRequestPolicy: { ...bound.composition.requestPolicy } }
      : {}),
    compositionPolicy: {
      maxProviderTurns: effectiveProviderTurns(bound),
      // Derived like the turn budget: most records seal 300_000, but the
      // GPT-6 Sol hub record seals 1_800_000, so the host term binds there.
      timeoutMs: Math.min(
        CONFIGURED_LIMITS.timeoutMs,
        bound.candidate.proposedLimits.timeoutMs,
        bound.composition.compositionLimits.timeoutMs,
        bound.compositionCeiling.timeoutMs,
      ),
      // The effective limit is the min across configured / candidate /
      // composition / package (records/composition-execution.ts). Deriving it from
      // the composition alone is wrong whenever CONFIGURED_LIMITS is tighter, as it
      // is here (100_000) to exercise clamping.
      maxResponseBytes: Math.min(
        CONFIGURED_LIMITS.maxResponseBytes,
        bound.composition.compositionLimits.maxResponseBytes,
      ),
    },
  };
}

function mutableEvidence(value: CompositionExecutionEvidenceV1): Record<string, unknown> {
  return structuredClone(value) as unknown as Record<string, unknown>;
}

function reseal(value: Record<string, unknown>): void {
  const { evidenceSha256: _discarded, ...body } = value;
  value.evidenceSha256 = canonicalDigest(body);
}

describe("composition execution evidence", () => {
  it("keeps the host turn budget above every sealed source, so the clamp direction holds", async () => {
    // This file asserts that a sealed ceiling clamps a looser host config, which
    // is meaningful only while CONFIGURED_LIMITS is the larger value. A moved
    // sealed budget can silently invert the comparison while the fixture keeps
    // passing; this guard makes that inversion loud.
    const { bound } = await fixture();
    for (const [name, sealed] of [
      ["candidate.proposedLimits", bound.candidate.proposedLimits.maxProviderTurns],
      ["composition.compositionLimits", bound.composition.compositionLimits.maxProviderTurns],
      ["compositionCeiling", bound.compositionCeiling.maxProviderTurns],
    ] as const) {
      expect(
        CONFIGURED_LIMITS.maxProviderTurns,
        `CONFIGURED_LIMITS.maxProviderTurns must exceed ${name} or this file stops testing the clamp it claims to test`,
      ).toBeGreaterThan(sealed);
    }
  });
  it.each([
    ["nvidia-nemotron-3-super-120b-a12b-pi", "nvidia", "openai-chat-completions"],
    ["nvidia-inference-gpt-6-sol-pi", "nvidia", "openai-chat-completions"],
    ["anthropic-claude-opus-4.7-pi", "anthropic", "anthropic-messages"],
  ] as const)("uses one evidence dialect for %s", async (compositionId, provider, transport) => {
    const evidence = createCompositionExecutionEvidence(await fixture(compositionId));

    expect(evidence.deployment).toMatchObject({ provider, transport });
    expect(Object.keys(evidence)).not.toContain("mode");
    expect(evidence.releaseEligible).toBe(false);
  });

  it("admits the contextAdmission key the live binder supplies (#1046)", async () => {
    // `bindExecutableComposition` returns `contextAdmission`, and the builder's
    // key set is exact, so without admitting the key every
    // `docsfab run --composition` fails with `Composition execution evidence
    // rejected (invalid-shape)` before its first model call.
    const input = await fixture();
    const admitted = createCompositionExecutionEvidence({
      ...input,
      executionProfile: { ...input.executionProfile, contextAdmission: "host-window" },
    });
    expect(Object.keys(admitted)).not.toContain("mode");
    // The same evidence either way: the key is admitted, not recorded.
    expect(admitted.digest).toBe(createCompositionExecutionEvidence(input).digest);

    // Adjacent condition: a value outside the closed pair is still refused, so
    // admitting the key did not admit an arbitrary one.
    expect(() =>
      createCompositionExecutionEvidence({
        ...input,
        executionProfile: {
          ...input.executionProfile,
          contextAdmission: "provider-window",
        } as unknown as BoundModelExecutionProfile,
      }),
    ).toThrow(/invalid-value/u);
    expect(() =>
      createCompositionExecutionEvidence({
        ...input,
        executionProfile: { ...input.executionProfile, contextAdmission: "provider" },
      }),
    ).not.toThrow();
  });

  it("records the raised 120B sealed limits, the package ceiling, and the host-clamped effective limit", async () => {
    const input = await fixture("nvidia-nemotron-3-super-120b-a12b-pi");
    const evidence = createCompositionExecutionEvidence(input);

    // Sealed sources carry the route-proven 524,288; the host in this fixture
    // configures 128,000, so the effective limit records the host clamp, not the
    // ceiling. The evidence keeps all four sources apart for that reason.
    expect(evidence.limits.candidate).toMatchObject({
      contextWindow: 524_288,
      maxInputTokens: 524_288,
      maxOutputTokens: 8_192,
    });
    expect(evidence.limits.composition).toMatchObject({
      contextWindow: 524_288,
      maxInputTokens: 524_288,
      maxOutputTokens: 8_192,
    });
    // The package ceiling is the registry maximum (GPT-6 Sol's 1,050,000 context
    // and DeepSeek's 384,000 output since #1454). The 120B record keeps its own
    // sealed 524,288 / 8,192, so its effective limits are unaffected by it.
    expect(evidence.limits.package).toMatchObject({
      contextWindow: 1_050_000,
      maxInputTokens: 1_050_000,
      maxOutputTokens: 384_000,
    });
    expect(evidence.limits.effective).toMatchObject({
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
    });
    expect(evidence.digests.requestPolicySha256).toBe(
      input.bound.composition.requestPolicy?.policySha256,
    );
  });

  it("projects exact provider-neutral composition evidence without endpoint or credential material", async () => {
    const input = await fixture();
    const evidence = createCompositionExecutionEvidence(input);

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-composition-execution-evidence/v1",
      compositionId: input.bound.composition.compositionId,
      model: input.bound.composition.model,
      deployment: {
        provider: "anthropic",
        routeId: "anthropic-api",
        transport: "anthropic-messages",
        bindingKind: "exact-origin",
        identitySha256: input.bound.composition.deployment.identitySha256,
      },
      authentication: {
        route: "anthropic-api-key",
        credentialFamily: "anthropic-api",
        mechanism: "host-secret-handle",
      },
      harness: input.bound.composition.harness,
      adapters: input.bound.composition.adapters,
      digests: {
        installedManifestSha256: input.bound.installedManifestSha256,
        compositionSha256: input.bound.composition.compositionSha256,
        candidateSha256: input.bound.candidate.candidateSha256,
        workflowSha256: input.bound.workflow.sourceSha256,
        packageLimitsSha256: input.bound.compositionCeilingSha256,
      },
      workflow: input.workflow,
      repository: REPOSITORY,
      limits: {
        configured: CONFIGURED_LIMITS,
        candidate: input.bound.candidate.proposedLimits,
        composition: input.bound.composition.compositionLimits,
        package: input.bound.compositionCeiling,
        effective: {
          contextWindow: 65_536,
          maxInputTokens: 65_536,
          maxOutputTokens: 8_192,
          // This record's own sealed budget is the binding one; the package ceiling
          // is higher for other lanes. Both candidate terms are named, the same
          // shape `maxResponseBytes` below uses, which is still not a re-run of the
          // implementation's own four-way Math.min.
          maxProviderTurns: Math.min(
            input.bound.composition.compositionLimits.maxProviderTurns,
            input.bound.compositionCeiling.maxProviderTurns,
          ),
          // This record seals 300_000 in both its composition and its candidate,
          // below the host default and the ceiling, so the minimum lands there.
          timeoutMs: 300_000,
          maxResponseBytes: Math.min(
            CONFIGURED_LIMITS.maxResponseBytes,
            input.bound.composition.compositionLimits.maxResponseBytes,
          ),
        },
      },
      technicalApproval: "not-established",
      roleQualification: "not-established",
      releaseEligible: false,
      limitations: ["not-release-eligible", "not-technically-approved"],
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(parseCompositionExecutionEvidence(evidence)).toEqual(evidence);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.limits.effective)).toBe(true);

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(input.executionProfile.baseUrl);
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("sourceNames");
  });

  it("still validates retained evidence bound to the retired direct OpenAI GPT-5.6 Sol composition", async () => {
    // Retirement refuses a NEW execution; it must not orphan a completed run.
    // The provenance resolver still binds the retired record, the builder
    // re-creates the evidence against it, and the parser accepts it back.
    const { authority } = await loadInstalledModelCompositionAuthority();
    const provenance = resolveInstalledComposition({
      authority,
      compositionId: RETIRED_GPT_56_SOL,
      workflowId: "review-documentation",
    });
    expect(provenance.composition.status).toBe("retired");
    // The evidence API is typed for the composition binding; a retained run's
    // record is the retired one, which the builder admits by design.
    const bound = provenance as unknown as BoundExecutableComposition;
    const evidence = createCompositionExecutionEvidence({
      runId: "retained-gpt-5-6-sol-run",
      bound,
      executionProfile: executionProfile(bound),
      configuredLimits: CONFIGURED_LIMITS,
      workflow: { id: bound.workflow.workflowId, sourceSha256: bound.workflow.sourceSha256 },
      repository: REPOSITORY,
    });
    const parsed = parseCompositionExecutionEvidence(JSON.parse(JSON.stringify(evidence)));
    expect(parsed).toEqual(evidence);
    expect(parsed).toMatchObject({
      compositionId: RETIRED_GPT_56_SOL,
      deployment: { provider: "openai", routeId: "openai-api", transport: "openai-responses" },
      authentication: { route: "openai-api-key", credentialFamily: "openai-api" },
    });

    // The digest is the one the installed registry seals for the retired
    // record, read independently of the resolver under test.
    const registry = JSON.parse(
      await readFile(join(runtimeRoot, "model-compositions", "composition-registry.json"), "utf8"),
    ) as {
      compositions: Array<{ compositionId: string; compositionSha256: string; status: string }>;
    };
    const installed = registry.compositions.filter(
      (entry) => entry.compositionId === RETIRED_GPT_56_SOL,
    );
    expect(installed).toHaveLength(1);
    expect(installed[0]!.status).toBe("retired");
    expect(parsed.digests.compositionSha256).toBe(installed[0]!.compositionSha256);

    // The same id is refused for a new selection, naming the GPT-6 Sol successor.
    let refusal: unknown;
    try {
      resolveInstalledExecutableComposition({
        authority,
        compositionId: RETIRED_GPT_56_SOL,
        workflowId: "review-documentation",
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ModelCompositionError);
    expect((refusal as ModelCompositionError).code).toBe("composition-retired");
    expect((refusal as ModelCompositionError).nextAction).toContain(GPT_6_SOL_SUCCESSOR);
  });

  it("rejects builder credential material and composition subject drift", async () => {
    configureCredential("must-not-enter-evidence");
    const input = await fixture();
    const credentialBearing = structuredClone(input) as CreateCompositionExecutionEvidenceInput & {
      executionProfile: BoundModelExecutionProfile & { apiKey: string };
    };
    credentialBearing.executionProfile.apiKey = "must-not-enter-evidence";
    expect(() => createCompositionExecutionEvidence(credentialBearing)).toThrow(
      "credential-material",
    );

    const wrongRoute = structuredClone(input);
    wrongRoute.executionProfile.routeId = "another-route";
    expect(() => createCompositionExecutionEvidence(wrongRoute)).toThrow("subject-mismatch");

    const wrongWorkflow = structuredClone(input);
    Object.assign(wrongWorkflow.workflow, { id: "another-workflow" });
    expect(() => createCompositionExecutionEvidence(wrongWorkflow)).toThrow("subject-mismatch");

    const wrongPolicy = structuredClone(input);
    wrongPolicy.executionProfile.compositionPolicy!.timeoutMs += 1;
    expect(() => createCompositionExecutionEvidence(wrongPolicy)).toThrow("subject-mismatch");
  });

  it("rejects unknown fields, credential fields, and unsealed tampering", async () => {
    configureCredential("must-not-enter-evidence");
    const evidence = createCompositionExecutionEvidence(await fixture());

    const unknown = mutableEvidence(evidence);
    (unknown.deployment as Record<string, unknown>).baseUrl = "https://elsewhere.example.test";
    expect(() => parseCompositionExecutionEvidence(unknown)).toThrow("invalid-shape");

    const credential = mutableEvidence(evidence);
    (credential.authentication as Record<string, unknown>).apiKey = "must-not-enter-evidence";
    expect(() => parseCompositionExecutionEvidence(credential)).toThrow("credential-material");

    const tampered = mutableEvidence(evidence);
    (tampered.model as Record<string, unknown>).resolvedId = "another-model";
    expect(() => parseCompositionExecutionEvidence(tampered)).toThrow("digest-mismatch");
  });

  it("rejects re-sealed release claims and non-conservative effective limits", async () => {
    const evidence = createCompositionExecutionEvidence(await fixture());

    const releaseClaim = mutableEvidence(evidence);
    releaseClaim.releaseEligible = true;
    reseal(releaseClaim);
    expect(() => parseCompositionExecutionEvidence(releaseClaim)).toThrow("invalid-value");

    const oversized = mutableEvidence(evidence);
    const limits = oversized.limits as Record<string, Record<string, number>>;
    const packageLimits = limits.package;
    const effectiveLimits = limits.effective;
    if (!packageLimits || !effectiveLimits) throw new Error("expected composition limits");
    if (typeof packageLimits.maxOutputTokens !== "number") {
      throw new Error("expected package max-output limit");
    }
    effectiveLimits.maxOutputTokens = packageLimits.maxOutputTokens + 1;
    reseal(oversized);
    expect(() => parseCompositionExecutionEvidence(oversized)).toThrow("invalid-value");
  });
});

describe("composition execution evidence v2: the operator's values beside the preset's", () => {
  const GATEWAY = "https://llm-gateway.example.test/v1";

  it("writes v2 with the effective subject when the operator changes the endpoint", async () => {
    const input = await fixture();
    const v1 = createCompositionExecutionEvidence(input);
    expect(v1.kind).toBe("docsfab-composition-execution-evidence/v1");
    expect(v1).not.toHaveProperty("effective");

    const moved = structuredClone(input);
    moved.executionProfile.baseUrl = GATEWAY;
    const v2 = createCompositionExecutionEvidence(moved);
    expect(v2.kind).toBe("docsfab-composition-execution-evidence/v2");
    expect(v2.effective).toMatchObject({
      modelId: input.bound.composition.model.resolvedId,
      transport: input.bound.composition.deployment.transport,
      requestPolicySha256: null,
      modelSettingsSha256: null,
    });
    // The preset's identity stays; the endpoint's own differs. No URL is kept.
    expect(v2.deployment.identitySha256).toBe(v1.deployment.identitySha256);
    expect(v2.effective?.deploymentIdentitySha256).not.toBe(v1.deployment.identitySha256);
    expect(JSON.stringify(v2)).not.toContain("llm-gateway");
    expect(parseCompositionExecutionEvidence(v2)).toEqual(v2);
  });

  it("records an operator's model and a window above the preset's, never refusing them", async () => {
    const input = await fixture();
    const changed = structuredClone(input);
    changed.executionProfile.modelId = "operator/model";
    changed.executionProfile.profile.maxOutputTokens = 10_000;
    const evidence = createCompositionExecutionEvidence(changed);
    expect(evidence.effective?.modelId).toBe("operator/model");
    expect(evidence.model.resolvedId).toBe(input.bound.composition.model.resolvedId);
    // 10,000 is above the preset's 8,192 and within what was configured.
    expect(evidence.limits.effective.maxOutputTokens).toBe(10_000);
    expect(evidence.limits.composition.maxOutputTokens).toBe(8_192);
    expect(parseCompositionExecutionEvidence(evidence).limits.effective.maxOutputTokens).toBe(
      10_000,
    );

    // Adjacent condition: a window above what was configured still refuses.
    const oversized = mutableEvidence(evidence);
    const limits = oversized.limits as Record<string, Record<string, number>>;
    limits.effective!.maxOutputTokens = limits.configured!.maxOutputTokens! + 1;
    reseal(oversized);
    expect(() => parseCompositionExecutionEvidence(oversized)).toThrow("invalid-value");
  });

  it("writes v2 when only the preset's request policy is dropped", async () => {
    const input = await fixture("nvidia-inference-qwen3-5-397b-a17b-pi");
    expect(input.executionProfile.compositionRequestPolicy).toBeDefined();
    // Control: the policy preset on its own values stays v1.
    expect(createCompositionExecutionEvidence(input).kind).toBe(
      "docsfab-composition-execution-evidence/v1",
    );
    const dropped = structuredClone(input);
    delete dropped.executionProfile.compositionRequestPolicy;
    const evidence = createCompositionExecutionEvidence(dropped);
    expect(evidence.kind).toBe("docsfab-composition-execution-evidence/v2");
    expect(evidence.effective).toMatchObject({
      modelId: input.bound.composition.model.resolvedId,
      requestPolicySha256: null,
    });
  });

  it("writes v2 when an operator setting differs from the preset, and v1 when it matches", async () => {
    const input = await fixture();
    const record = (settings: object) => ({
      schemaVersion: 1 as const,
      slot: "writing" as const,
      presetId: input.bound.composition.compositionId,
      presetSource: "host-config" as const,
      settings: settings as never,
      notes: [],
    });
    const effort = record({
      reasoningEffort: {
        value: "high",
        source: "environment",
        origin: "MODEL_REASONING_EFFORT",
        presetValue: null,
      },
    });
    const withEffort = createCompositionExecutionEvidence({ ...input, modelSettings: effort });
    expect(withEffort.kind).toBe("docsfab-composition-execution-evidence/v2");
    expect(withEffort.effective?.modelSettingsSha256).toBe(canonicalDigest(effort));

    const same = record({
      maxOutputTokens: {
        value: 8192,
        source: "host-config",
        origin: "host.yaml active.writing.settings.maxOutputTokens",
        presetValue: 8192,
      },
    });
    expect(createCompositionExecutionEvidence({ ...input, modelSettings: same }).kind).toBe(
      "docsfab-composition-execution-evidence/v1",
    );
  });

  it("binds the run's settings record by digest", async () => {
    const input = await fixture();
    const settings = {
      schemaVersion: 1 as const,
      slot: "writing" as const,
      presetId: input.bound.composition.compositionId,
      presetSource: "cli-flag" as const,
      settings: {} as never,
      notes: [],
    };
    const moved = structuredClone(input);
    moved.executionProfile.baseUrl = GATEWAY;
    const evidence = createCompositionExecutionEvidence({
      ...moved,
      modelSettings: settings,
    });
    expect(evidence.effective?.modelSettingsSha256).toBe(canonicalDigest(settings));
  });

  it("refuses an unknown key in the effective subject and a v2 kind without one", async () => {
    const input = await fixture();
    const moved = structuredClone(input);
    moved.executionProfile.baseUrl = GATEWAY;
    const evidence = createCompositionExecutionEvidence(moved);

    const extra = mutableEvidence(evidence);
    (extra.effective as Record<string, unknown>).baseUrl = GATEWAY;
    reseal(extra);
    expect(() => parseCompositionExecutionEvidence(extra)).toThrow("invalid-shape");

    const missing = mutableEvidence(evidence);
    delete missing.effective;
    reseal(missing);
    expect(() => parseCompositionExecutionEvidence(missing)).toThrow("invalid-shape");
  });

  it("aggregates a run on the operator's model against the effective model, not the preset's", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    const bound = resolveInstalledExecutableComposition({
      authority,
      compositionId: "anthropic-claude-opus-4.7-pi",
      workflowId: "readiness",
    });
    const sourcePath = "/fixtures/settings-aggregate";
    const evidence = createCompositionExecutionEvidence({
      runId: "settings-aggregate-run",
      bound,
      executionProfile: {
        ...executionProfile(bound),
        modelId: "operator/model",
      },
      configuredLimits: CONFIGURED_LIMITS,
      workflow: {
        id: bound.workflow.workflowId,
        sourceSha256: bound.workflow.sourceSha256,
      },
      repository: {
        identitySha256: createHash("sha256").update(sourcePath).digest("hex"),
        revision: REPOSITORY.revision,
      },
    });
    const workflow = getWorkflow("readiness");
    const step = workflow.steps[0]!;
    const record = (model: string) =>
      ({
        schemaVersion: 2,
        id: "settings-aggregate-run",
        workflow: "readiness",
        repository: {
          sourcePath,
          requestedRevision: "HEAD",
          revision: REPOSITORY.revision,
        },
        workspace: { strategy: "tracked-export", disposable: true },
        status: "succeeded",
        createdAt: "2026-10-14T00:00:00.000Z",
        models: [],
        skills: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          turns: 0,
        },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        compositionExecution: evidence,
        steps: [
          {
            id: step.id,
            title: step.title,
            kind: "inference",
            skill: step.skill,
            mode: step.mode,
            status: "succeeded",
            model: { provider: evidence.deployment.routeId, model },
            skillEvidence: { id: step.skill, contentSha256: "c".repeat(64) },
            inference: { attempts: [{ outcome: "succeeded" }] },
          },
        ],
      }) as unknown as RunRecord;

    const aggregate = createCompositionExecutionAggregate({
      compositionExecution: evidence,
      run: record("operator/model"),
      workflow,
    });
    expect(aggregate.compositionEvidenceSha256).toBe(evidence.evidenceSha256);
    // Control: a step that recorded the preset's model is not what ran.
    expect(() =>
      createCompositionExecutionAggregate({
        compositionExecution: evidence,
        run: record(bound.composition.model.resolvedId),
        workflow,
      }),
    ).toThrow("subject-mismatch");
  });
});
