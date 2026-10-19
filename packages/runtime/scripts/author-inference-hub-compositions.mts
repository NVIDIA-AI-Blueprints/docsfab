// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Author executable compositions on the `nvidia-inference-api` route.
 *
 * The reasoning control for reasoning-split models
 * (`chat_template_kwargs: {thinking:false}`) is declared per composition in
 * `requestPolicy.reasoningControl`; these compositions carry it on this route.
 *
 * Every digest is computed with the repository's own `canonicalDigest`:
 *   compositionSha256 / candidateSha256 / registrySha256 = canonicalDigest(body
 *   without its own digest field); deployment identity per installed.ts.
 *
 * Each model's control is measured, not assumed (see
 * docs/internal/evidence/inference-hub-request-policy-probe-2026-08-26/).
 * `nemotron-3.5-lightning` is absent: no control suppressed its reasoning
 * split on this route.
 *
 * Run:  npx tsx scripts/author-inference-hub-compositions.mts [--write]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { canonicalDigest } from "../src/contract-kit/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const ASSETS = resolve(ROOT, "model-compositions");
const WRITE = process.argv.includes("--write");

const ROUTE_ID = "nvidia-inference-api";
const ROUTE_BASE_URL = new URL(EXECUTABLE_ROUTE_BASE_URLS[ROUTE_ID]);
const ORIGIN = ROUTE_BASE_URL.origin;
const BASE_PATH = ROUTE_BASE_URL.pathname;
const TRANSPORT = "openai-chat-completions";
const CREDENTIAL_ENV = "MODEL_API_KEY";

interface HubModel {
  readonly id: string;
  readonly slug: string;
  readonly vendor: string;
  /**
   * `chat-template-kwarg`: a reasoning-split model whose split the measured
   * control suppresses; the record carries the installed request policy.
   * `null`: not reasoning-split; the record carries no policy and uses the
   * provider-neutral finalizer.
   */
  readonly control: "chat-template-kwarg" | null;
  /**
   * Per-record limit overrides; anything omitted follows the catalog template.
   *
   * Set `timeoutMs` and `maxProviderTurns` together: the sealed turn budget
   * lifts the per-step tool ceiling (`resolveLeaseShapeForTurns`), so a longer
   * timer with the template's turn budget turns a timeout into a truncation.
   * Existing records are skipped, so this matters on re-authoring.
   */
  readonly limits?: {
    contextWindow?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxProviderTurns?: number;
    timeoutMs?: number;
  };
}

/**
 * Models on this route. The Nemotron/Qwen lanes are measured to have their
 * reasoning split suppressed by `chat-template-kwarg`; the DeepSeek and
 * Anthropic lanes carry no reasoning control. To add or swap a Claude model id, edit its
 * entry here, its registered governance candidate file, and its profile yaml;
 * generate the candidate's runtime excerpt under model-compositions/sources/candidates/
 * (the repository's model-profile candidate check, with --write-runtime-sources and
 * the profile id), then rerun with --write and re-seal
 * (scripts/reseal-composition-digests.mts).
 */
// Context, input, and output limits are the Inference Hub Metadata record
// values of 2026-09-28 (#1454), except the two Claude outputs: Sonnet 5 keeps
// the route-measured 32,768 (a 64,000-token request was refused with HTTP 408),
// and Opus 5 uses the same 32,768 on that sibling evidence until its route is
// probed; Metadata reports 128,000 for both.
const MODELS: readonly HubModel[] = [
  {
    id: "nvidia/nvidia/nemotron-3-super-v3",
    slug: "nemotron-3-super-v3",
    vendor: "nvidia",
    control: "chat-template-kwarg",
    limits: { contextWindow: 1_048_576, maxInputTokens: 1_048_576, maxOutputTokens: 32_768 },
  },
  {
    id: "nvidia/nvidia/nemotron-3-ultra",
    slug: "nemotron-3-ultra",
    vendor: "nvidia",
    control: "chat-template-kwarg",
    limits: { contextWindow: 1_048_576, maxInputTokens: 1_048_576, maxOutputTokens: 32_768 },
  },
  {
    id: "nvidia/qwen/qwen3-5-397b-a17b",
    slug: "qwen3-5-397b-a17b",
    vendor: "qwen",
    control: "chat-template-kwarg",
    limits: { contextWindow: 262_144, maxInputTokens: 262_144, maxOutputTokens: 131_072 },
  },
  // The `azure/` id returned 403 on 2026-09-28. A 2-prompt, 128-token probe
  // without a tool prompt returned content with no split for the `nvidia/` id,
  // so it carries no policy; tool prompts are not yet checked.
  {
    id: "nvidia/deepseek-ai/deepseek-v4-pro",
    slug: "deepseek-v4-pro",
    vendor: "deepseek",
    control: null,
    limits: { contextWindow: 1_048_576, maxInputTokens: 1_048_576, maxOutputTokens: 384_000 },
  },
  // Anthropic Claude: measured to report no reasoning tokens (no control
  // needed) and to return OpenAI-style tool_calls. Secondary records.
  {
    id: "aws/anthropic/bedrock-claude-sonnet-5",
    slug: "claude-sonnet-5",
    vendor: "anthropic",
    control: null,
    limits: {
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 32_768,
      maxProviderTurns: 512,
      timeoutMs: 1_800_000,
    },
  },
  {
    id: "aws/anthropic/bedrock-claude-opus-5",
    slug: "claude-opus-5",
    vendor: "anthropic",
    control: null,
    limits: {
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 32_768,
      maxProviderTurns: 512,
      timeoutMs: 1_800_000,
    },
  },
];

const read = (name: string) => JSON.parse(readFileSync(resolve(ASSETS, name), "utf8"));

/** Reseal a body by recomputing its digest field. */
function seal<T extends Record<string, unknown>>(body: T, digestKey: string) {
  const { [digestKey]: _old, ...rest } = body as Record<string, unknown>;
  return { ...rest, [digestKey]: canonicalDigest(rest) };
}

function main() {
  const adapterRegistry = read("adapter-registry.json");
  const compositionRegistry = read("composition-registry.json");
  const candidateRegistry = read("candidate-projections.json");

  // Deployment identity, per model-composition/installed.ts.
  const identitySha256 = canonicalDigest({
    schemaVersion: 1,
    origin: ORIGIN,
    route: `${BASE_PATH}/chat/completions`,
    provider: "nvidia",
  });

  const template = compositionRegistry.compositions.find((c: any) =>
    c.compositionId.includes("nemotron-3-super-120b"),
  );
  if (!template) throw new Error("catalog template composition not found");

  // --- adapters -----------------------------------------------------------
  const newAdapters = [
    {
      schemaVersion: 1,
      kind: "route-evidence",
      id: "nvidia-inference-api-route",
      version: "1.0.0",
      status: "implemented",
      routeId: ROUTE_ID,
      transport: TRANSPORT,
      deploymentIdentitySha256: identitySha256,
    },
    {
      schemaVersion: 1,
      kind: "authentication",
      id: "nvidia-inference-api-key",
      version: "1.0.0",
      status: "implemented",
      routeId: ROUTE_ID,
      credentialFamily: ROUTE_ID,
      mechanism: "host-secret-handle",
      sourceNames: [CREDENTIAL_ENV],
      executablePolicySha256: canonicalDigest({
        schemaVersion: 1,
        routeId: ROUTE_ID,
        mechanism: "host-secret-handle",
        sourceNames: [CREDENTIAL_ENV],
      }),
      environmentPolicySha256: canonicalDigest({
        schemaVersion: 1,
        routeId: ROUTE_ID,
        transport: TRANSPORT,
        origin: ORIGIN,
      }),
    },
    {
      schemaVersion: 1,
      kind: "provider-connection",
      id: "pi-openai-compatible-nvidia-inference",
      version: "1.0.0",
      status: "implemented",
      executionClass: "pi-provider",
      routeId: ROUTE_ID,
      transport: TRANSPORT,
      deploymentIdentitySha256: identitySha256,
    },
  ];

  const existingIds = new Set(
    adapterRegistry.adapters.map((a: any) => `${a.kind}:${a.id}@${a.version}`),
  );
  const adapters = [
    ...adapterRegistry.adapters,
    ...newAdapters.filter((a) => !existingIds.has(`${a.kind}:${a.id}@${a.version}`)),
  ];
  const sealedAdapters = seal({ ...adapterRegistry, adapters }, "registrySha256");

  // --- compositions + candidates -----------------------------------------
  const compositions = [...compositionRegistry.compositions];
  const candidates = [...candidateRegistry.candidates];

  for (const model of MODELS) {
    const compositionId = `nvidia-inference-${model.slug}-pi`;
    if (compositions.some((c: any) => c.compositionId === compositionId)) continue;

    const requestPolicy =
      model.control === null
        ? undefined
        : seal(
            {
              deploymentIdentitySha256: identitySha256,
              installedSystemInstructionSha256:
                template.requestPolicy.installedSystemInstructionSha256,
              modelId: model.id,
              // Measured on this route; see the evidence directory in the header.
              reasoningControl: { kind: model.control, thinking: false },
              reasoningMode: "disabled",
              routeId: ROUTE_ID,
              schemaVersion: 1,
              temperature: 0,
              topP: 1,
              transport: TRANSPORT,
            },
            "policySha256",
          );
    const compositionLimits = { ...template.compositionLimits, ...(model.limits ?? {}) };

    const composition = seal(
      {
        adapters: {
          authentication: { id: "nvidia-inference-api-key", version: "1.0.0" },
          harness: { id: "pi-governed", version: "1.0.0" },
          providerConnection: {
            id: "pi-openai-compatible-nvidia-inference",
            version: "1.0.0",
          },
          routeEvidence: { id: "nvidia-inference-api-route", version: "1.0.0" },
        },
        authentication: {
          credentialFamily: ROUTE_ID,
          mechanism: "host-secret-handle",
          route: ROUTE_ID,
          sourceNames: [CREDENTIAL_ENV],
        },
        compositionId,
        deployment: {
          bindingKind: "exact-origin",
          identitySha256,
          provider: "nvidia",
          region: null,
          routeId: ROUTE_ID,
          transport: TRANSPORT,
        },
        executionClass: "pi-provider",
        harness: { id: "pi", policySha256: template.harness.policySha256 },
        limitations: ["not-technically-approved", "not-release-eligible"],
        model: { requestedId: model.id, resolvedId: model.id, vendor: model.vendor },
        compositionLimits,
        // Omitted, not null: the decoder treats the key as optional and a `null`
        // would be rejected as a malformed policy.
        ...(requestPolicy ? { requestPolicy } : {}),
        schemaVersion: 1,
        status: "active",
      },
      "compositionSha256",
    );
    compositions.push(composition);

    candidates.push(
      seal(
        {
          approvalStatus: "not-approved",
          candidateId: `generation-${model.slug}-nvidia-inference-pi`,
          compositionId,
          compositionSha256: (composition as any).compositionSha256,
          deploymentIdentitySha256: identitySha256,
          harnessId: "pi",
          modelId: model.id,
          modelRequest: "blocked",
          proposedLimits: { ...compositionLimits },
          providerConnectionAdapter: {
            id: "pi-openai-compatible-nvidia-inference",
            version: "1.0.0",
          },
          routeId: ROUTE_ID,
          schemaVersion: 1,
          source: {
            kind: "repository-candidate",
            locator: `packages/runtime/model-compositions/sources/candidates/generation-${model.slug}.json`,
            // The digest of the file at `locator`, which is what
            // check-model-compositions.mjs verifies.
            sha256: createHash("sha256")
              .update(
                readFileSync(
                  resolve(ASSETS, "sources", "candidates", `generation-${model.slug}.json`),
                ),
              )
              .digest("hex"),
          },
          status: "candidate",
        },
        "candidateSha256",
      ),
    );
  }

  const sealedCompositions = seal({ ...compositionRegistry, compositions }, "registrySha256");
  const sealedCandidates = seal({ ...candidateRegistry, candidates }, "registrySha256");

  console.log(`deployment identity : ${identitySha256}`);
  console.log(`adapters            : ${adapterRegistry.adapters.length} -> ${adapters.length}`);
  console.log(
    `compositions        : ${compositionRegistry.compositions.length} -> ${compositions.length}`,
  );
  console.log(`candidates          : ${candidateRegistry.candidates.length} -> ${candidates.length}`);

  if (!WRITE) {
    console.log("\ndry run; pass --write to update the assets");
    return;
  }

  const emit = (name: string, value: unknown) =>
    // Pretty-printed so a credential-bearing asset's diff stays reviewable.
    writeFileSync(resolve(ASSETS, name), `${JSON.stringify(value, null, 2)}\n`);
  emit("adapter-registry.json", sealedAdapters);
  emit("composition-registry.json", sealedCompositions);
  emit("candidate-projections.json", sealedCandidates);
  console.log("\nwrote adapter-registry, composition-registry, candidate-projections");
  console.log("next: regenerate installed-manifest.json digests, then run check:model-compositions");
}

main();
