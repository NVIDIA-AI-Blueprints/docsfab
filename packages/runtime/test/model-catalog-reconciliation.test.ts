// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  finalizeModelCatalogObservation,
  finalizeOperatorApprovedModelProfile,
  projectApprovedModelProfile,
  type ModelCatalogField,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogFieldValue,
  type ModelCatalogObservationV1,
} from "../src/model/catalog-contracts.js";
import { inspectInferenceHubMetadata } from "../src/model/inference-hub-metadata.js";
import {
  NVIDIA_INFERENCE_CATALOG_ENDPOINT,
  NVIDIA_INFERENCE_CATALOG_ORIGIN,
  discoverNvidiaInferenceModelCatalog,
} from "../src/model/nvidia-inference-catalog.js";
import {
  MODEL_CATALOG_RECONCILIATION_POLICY,
  ModelCatalogProvenanceError,
  createApprovedCatalogModelEvidence,
  decodeModelCatalogProposalProvenance,
  finalizeModelCatalogApprovalEvidence,
  finalizeModelCatalogObservationProvenance,
  signModelCatalogApprovalAuthorization,
  type ModelCatalogObservationProvenanceV1,
} from "../src/model/catalog-provenance.js";
import {
  ModelCatalogReconciliationError,
  decodeModelCatalogReconciliationDecision,
  reconcileModelCatalog,
  serializeModelCatalogReconciliationDecision,
  type ReconcileModelCatalogInput,
} from "../src/model/catalog-reconciliation.js";
import { validModelConfig } from "./helpers.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const COMPLETED_AT = "2026-08-04T12:01:00.000Z";
const CREATED_AT = "2026-08-04T12:02:00.000Z";
const RUNTIME_MODEL = "openai/gpt-5.4";
const QUALIFIED_MODEL = "azure/openai/gpt-5.4";
const METADATA_ORIGIN = "https://metadata.example.test";
const INFERENCE_KEY = `nvapi-${"A".repeat(24)}`;
const METADATA_KEY = `ihub_api_${"B".repeat(24)}`;
// Test-only signing material derived from a public label; never an operator key.
const CATALOG_RECONCILIATION_FIXTURE_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    createHash("sha256").update("docsfab:test:model-catalog-reconciliation:ed25519:v1").digest(),
  ]),
  format: "der",
  type: "pkcs8",
});
const CATALOG_RECONCILIATION_FIXTURE_PUBLIC_KEY = createPublicKey(
  CATALOG_RECONCILIATION_FIXTURE_PRIVATE_KEY,
)
  .export({ type: "spki", format: "pem" })
  .toString();

describe("deterministic model catalog reconciliation", () => {
  it("reconciles authentic #60/#65 GPT observations across the complete two-source permutation", async () => {
    const sources = await authenticSources();
    const forwardInput = reconciliationInput(sources);
    const forward = reconcileModelCatalog(forwardInput);
    const permutations = [
      reconciliationInput({
        observations: [...sources.observations].reverse(),
        provenance: sources.provenance,
      }),
      reconciliationInput({
        observations: sources.observations,
        provenance: [...sources.provenance].reverse(),
      }),
      reconciliationInput({
        observations: [...sources.observations].reverse(),
        provenance: [...sources.provenance].reverse(),
      }),
    ].map((candidate) => reconcileModelCatalog(candidate));

    expect(forward.status).toBe("proposed");
    for (const permutation of permutations) expect(permutation).toEqual(forward);
    if (forward.status !== "proposed") throw new Error("expected proposal");
    expect(proposalField(forward.proposal.fields, "contextWindow")).toMatchObject({
      state: "observed",
      value: 1_000_000,
    });
    expect(proposalField(forward.proposal.fields, "maxInputTokens")).toMatchObject({
      state: "conflicting",
      value: 872_000,
      derivation: { kind: "rule", rule: "combined-context-input-clamp@1" },
    });
    expect(proposalField(forward.proposal.fields, "maxOutputTokens")).toMatchObject({
      state: "observed",
      value: 128_000,
    });
    expect(proposalField(forward.proposal.fields, "modelId")).toMatchObject({
      state: "observed",
      value: RUNTIME_MODEL,
      derivation: { kind: "rule", rule: "qualified-model-label@1" },
    });
    expect(proposalField(forward.proposal.fields, "providerId")).toMatchObject({
      state: "observed",
      value: "nvidia",
    });
    expect(proposalField(forward.proposal.fields, "origin")).toMatchObject({
      state: "observed",
      value: NVIDIA_INFERENCE_CATALOG_ORIGIN,
    });
    expect(proposalField(forward.proposal.fields, "inputPrice")).toMatchObject({
      state: "unknown",
    });
    expect(forward.decision).toMatchObject({
      disposition: "review-required",
      reconciliationPolicy: MODEL_CATALOG_RECONCILIATION_POLICY,
      proposal: { id: forward.proposal.id, sha256: forward.proposal.sha256 },
      proposalProvenanceSha256: forward.proposalProvenance.sha256,
    });
    expect(forward.decision.observations).toHaveLength(2);
    expect(forward.decision.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        "combined-context-clamp",
        "exact-qualified-model-alias",
        "runtime-boundary-selected",
        "source-observations-retained",
        "unknown-pricing-preserved",
      ]),
    );
    expect(forward.proposalProvenance.reconciliationPolicy).toEqual(
      MODEL_CATALOG_RECONCILIATION_POLICY,
    );
    expect(forward.proposalProvenance.observations).toHaveLength(2);

    const serialized = serializeModelCatalogReconciliationDecision(forward.decision, forwardInput);
    expect(decodeModelCatalogReconciliationDecision(serialized, forwardInput)).toEqual(
      forward.decision,
    );
    expect(serialized).not.toContain(INFERENCE_KEY);
    expect(serialized).not.toContain(METADATA_KEY);
  });

  it("accepts an exact runtime model label without requiring provider equality", async () => {
    const sources = await authenticSources();
    const exact = replaceMetadata(sources, "exact-label", {
      modelId: observed("modelId", RUNTIME_MODEL),
    });

    const result = reconcileModelCatalog(reconciliationInput(exact));

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("expected proposal");
    expect(proposalField(result.proposal.fields, "modelId")).toMatchObject({
      state: "observed",
      value: RUNTIME_MODEL,
    });
    expect(result.decision.reasons.map((item) => item.code)).not.toContain(
      "irreconcilable-model-identity",
    );
  });

  it.each([
    ["case-change", "azure", "azure/openai/GPT-5.4"],
    ["extra-prefix", "azure", "prefix/azure/openai/gpt-5.4"],
    ["extra-suffix", "azure", "azure/openai/gpt-5.4/suffix"],
    ["slash-provider", "azure/openai", "azure/openai/openai/gpt-5.4"],
  ])("blocks non-exact qualified aliases: %s", async (_name, providerId, modelId) => {
    const sources = await authenticSources();
    const altered = replaceMetadata(sources, String(_name), {
      providerId: observed("providerId", providerId),
      modelId: observed("modelId", modelId),
    });

    const result = reconcileModelCatalog(reconciliationInput(altered));

    expect(result.status).toBe("blocked");
    expect(result.decision.disposition).toBe("blocked");
    expect(result.decision.proposal).toBeNull();
    expect(result.decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "irreconcilable-model-identity",
        severity: "blocking",
        field: "modelId",
      }),
    );
  });

  it("blocks endpoint, limit-semantics, API, capability, and pricing conflicts", async () => {
    const base = await authenticSources();
    const cases: Array<[Sources, string]> = [
      [
        replaceInference(base, "endpoint", {
          origin: observed("origin", "https://metadata.example.test"),
        }),
        "irreconcilable-endpoint",
      ],
      [
        replaceInference(base, "semantics", {
          limitSemantics: observed("limitSemantics", "independent-input-output"),
        }),
        "irreconcilable-limit-semantics",
      ],
      [
        replaceInference(base, "api", {
          apiFormats: observed("apiFormats", ["responses"]),
        }),
        "irreconcilable-api-format",
      ],
      [
        replaceInference(base, "capability", {
          reasoning: unsupported("reasoning", "model-unsupported"),
        }),
        "model-unsupported-conflict",
      ],
      [replaceBothPrices(base), "irreconcilable-price-or-unit"],
    ];

    for (const [sources, reasonCode] of cases) {
      const result = reconcileModelCatalog(reconciliationInput(sources));
      expect(result.status).toBe("blocked");
      expect(result.decision.reasons.map((item) => item.code)).toContain(reasonCode);
      expect(result.decision.proposal).toBeNull();
    }
  });

  it("blocks duplicate authoritative source roles", async () => {
    const base = await authenticSources();
    const secondRuntime = replaceInference(base, "duplicate-runtime", {}).observations.find(
      (item) => item.source.id === "nvidia-inference-api-model-catalog",
    )!;
    const secondRuntimeProvenance = finalizeModelCatalogObservationProvenance({
      observation: secondRuntime,
      sourcePath: "/v1/models",
    });
    const sources = {
      observations: [...base.observations, secondRuntime],
      provenance: [...base.provenance, secondRuntimeProvenance],
    };

    const result = reconcileModelCatalog(reconciliationInput(sources));

    expect(result.status).toBe("blocked");
    expect(result.decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "irreconcilable-source-role",
        severity: "blocking",
      }),
    );
  });

  it("canonically blocks each valid partial-source boundary", async () => {
    const base = await authenticSources();
    for (const sourceId of [
      "source:ihub-metadata:authenticated",
      "nvidia-inference-api-model-catalog",
    ]) {
      const observation = base.observations.find((item) => item.source.id === sourceId)!;
      const provenance = base.provenance.find((item) => item.observation.id === observation.id)!;
      const input = reconciliationInput({ observations: [observation], provenance: [provenance] });

      const result = reconcileModelCatalog(input);

      expect(result.status).toBe("blocked");
      expect(result.decision).toMatchObject({ disposition: "blocked", proposal: null });
      expect(result.decision.reasons).toContainEqual(
        expect.objectContaining({
          code: "irreconcilable-source-role",
          severity: "blocking",
        }),
      );
      const serialized = serializeModelCatalogReconciliationDecision(result.decision, input);
      expect(decodeModelCatalogReconciliationDecision(serialized, input)).toEqual(result.decision);
    }
  });

  it.each([
    [
      "public-preview",
      "source:ihub-metadata:public-preview",
      "adapter:nvidia-inference-hub-metadata:public-preview",
      "1.0.0",
    ],
    ["unknown-adapter", "source:unknown-metadata", "adapter:unknown-metadata", "1.0.0"],
    [
      "wrong-version",
      "source:ihub-metadata:authenticated",
      "adapter:nvidia-inference-hub-metadata:authenticated",
      "2.0.0",
    ],
    [
      "wrong-source",
      "source:other-authenticated-metadata",
      "adapter:nvidia-inference-hub-metadata:authenticated",
      "1.0.0",
    ],
  ])(
    "blocks an unqualified metadata source tuple: %s",
    async (suffix, sourceId, adapterId, adapterVersion) => {
      const base = await authenticSources();
      const sources = replaceMetadataTuple(base, suffix, {
        sourceId,
        adapterId,
        adapterVersion,
      });

      const result = reconcileModelCatalog(reconciliationInput(sources));

      expect(result.status).toBe("blocked");
      expect(result.decision.reasons).toContainEqual(
        expect.objectContaining({
          code: "irreconcilable-source-role",
          severity: "blocking",
        }),
      );
    },
  );

  it("keeps unknown capabilities and economics unknown, never false or free", async () => {
    const base = await authenticSources();
    const sources = replaceMetadata(base, "unknown-capability", {
      reasoning: unknown("reasoning", "missing"),
      supportsDeveloperRole: unknown("supportsDeveloperRole", "missing"),
      supportsReasoningEffort: unknown("supportsReasoningEffort", "missing"),
      supportsSystemRole: unknown("supportsSystemRole", "missing"),
      toolUse: unknown("toolUse", "missing"),
    });

    const result = reconcileModelCatalog(reconciliationInput(sources));

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("expected proposal");
    for (const field of [
      "reasoning",
      "supportsDeveloperRole",
      "supportsReasoningEffort",
      "supportsSystemRole",
      "toolUse",
    ] as const) {
      expect(proposalField(result.proposal.fields, field)).toEqual(
        expect.objectContaining({
          field,
          state: "unknown",
        }),
      );
      expect(proposalField(result.proposal.fields, field)).not.toHaveProperty("value");
    }
    for (const field of [
      "billingInterpretation",
      "cacheReadPrice",
      "cacheWritePrice",
      "inputPrice",
      "outputPrice",
    ] as const) {
      expect(proposalField(result.proposal.fields, field)).toMatchObject({ state: "unknown" });
      expect(proposalField(result.proposal.fields, field)).not.toHaveProperty("value");
    }
    expect(JSON.stringify(result)).not.toContain('"value":false');
    expect(JSON.stringify(result)).not.toContain('"amountMicrounits":0');
    expect(result.decision.reasons.map((item) => item.code)).toEqual(
      expect.arrayContaining(["unknown-capability-preserved", "unknown-pricing-preserved"]),
    );
  });

  it("propagates mixed unknown and source-unsupported evidence as unknown", async () => {
    const base = await authenticSources();
    const metadata = replaceMetadata(base, "mixed-no-authority", {
      reasoning: unknown("reasoning", "missing"),
    });
    const sources = replaceInference(metadata, "mixed-no-authority", {
      reasoning: unsupported("reasoning", "source-unsupported"),
      inputPrice: unsupported("inputPrice", "source-unsupported"),
    });

    const result = reconcileModelCatalog(reconciliationInput(sources));

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("expected proposal");
    for (const field of ["reasoning", "inputPrice"] as const) {
      expect(proposalField(result.proposal.fields, field)).toMatchObject({
        state: "unknown",
        derivation: { kind: "rule", rule: "propagate-no-authoritative-value@1" },
      });
      expect(proposalField(result.proposal.fields, field)).not.toHaveProperty("value");
    }
  });

  it("does not mark the clamp conflicting merely because distinct token fields differ", async () => {
    const base = await authenticSources();
    const sources = replaceInference(base, "bounded-input", {
      maxInputTokens: observed("maxInputTokens", 800_000),
    });

    const result = reconcileModelCatalog(reconciliationInput(sources));

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("expected proposal");
    expect(proposalField(result.proposal.fields, "maxInputTokens")).toMatchObject({
      state: "observed",
      value: 800_000,
    });
    expect(result.decision.reasons.map((item) => item.code)).not.toContain(
      "combined-context-clamp",
    );
  });

  it("keeps a much older smaller value over a newer larger value independent of order", async () => {
    const base = await authenticSources();
    const stale = replaceMetadata(base, "stale-smaller", {}, "2026-08-01T00:00:00.000Z");
    const sources = replaceInference(
      stale,
      "newer-larger-context",
      {
        contextWindow: observed("contextWindow", 1_050_000),
      },
      "2026-08-04T12:00:30.000Z",
    );
    const input = reconciliationInput(sources);
    const reverse = reconciliationInput({
      observations: [...sources.observations].reverse(),
      provenance: sources.provenance,
    });

    const result = reconcileModelCatalog(input);
    const reversed = reconcileModelCatalog(reverse);

    expect(reversed).toEqual(result);
    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("expected proposal");
    expect(proposalField(result.proposal.fields, "contextWindow")).toMatchObject({
      state: "conflicting",
      value: 1_000_000,
    });
    expect(proposalField(result.proposal.fields, "maxInputTokens")).toMatchObject({
      state: "conflicting",
      value: 872_000,
    });
  });

  it("binds the decision and proposal provenance to policy v2", async () => {
    const sources = await authenticSources();
    const input = reconciliationInput(sources);
    const result = reconcileModelCatalog(input);
    if (result.status !== "proposed") throw new Error("expected proposal");

    const downgradedDecision = structuredClone(result.decision);
    downgradedDecision.reconciliationPolicy.version = "1" as "2";
    downgradedDecision.sha256 = evidenceDigest(downgradedDecision);
    expect(() => decodeModelCatalogReconciliationDecision(downgradedDecision, input)).toThrow(
      ModelCatalogReconciliationError,
    );

    const downgradedProvenance = structuredClone(result.proposalProvenance);
    Object.assign(downgradedProvenance.reconciliationPolicy, { version: "1" });
    downgradedProvenance.sha256 = evidenceDigest(downgradedProvenance);
    expect(() =>
      decodeModelCatalogProposalProvenance(
        downgradedProvenance,
        result.proposal,
        result.observationSet,
        result.observations,
        result.observationProvenance,
      ),
    ).toThrow(ModelCatalogProvenanceError);

    const wrongProvenanceBinding = structuredClone(result.decision);
    wrongProvenanceBinding.proposalProvenanceSha256 = "f".repeat(64);
    wrongProvenanceBinding.sha256 = evidenceDigest(wrongProvenanceBinding);
    expect(() => decodeModelCatalogReconciliationDecision(wrongProvenanceBinding, input)).toThrow(
      ModelCatalogReconciliationError,
    );

    const tamperedDecision = structuredClone(result.decision);
    tamperedDecision.observations[0]!.provenanceSha256 = "f".repeat(64);
    tamperedDecision.sha256 = evidenceDigest(tamperedDecision);
    expect(() => decodeModelCatalogReconciliationDecision(tamperedDecision, input)).toThrow(
      ModelCatalogReconciliationError,
    );

    const blockedInput = reconciliationInput(
      replaceMetadata(sources, "blocked-policy", {
        modelId: observed("modelId", "azure/openai/other-model"),
      }),
    );
    const blocked = reconcileModelCatalog(blockedInput);
    expect(blocked.status).toBe("blocked");
    expect(blocked.decision).toMatchObject({
      proposal: null,
      reconciliationPolicy: MODEL_CATALOG_RECONCILIATION_POLICY,
    });
    const downgradedBlocked = structuredClone(blocked.decision);
    downgradedBlocked.reconciliationPolicy.version = "1" as "2";
    downgradedBlocked.sha256 = evidenceDigest(downgradedBlocked);
    expect(() => decodeModelCatalogReconciliationDecision(downgradedBlocked, blockedInput)).toThrow(
      ModelCatalogReconciliationError,
    );
  });

  it("rejects omitted, duplicate, sparse, accessor, wrong-purpose, future, and tampered input", async () => {
    const sources = await authenticSources();
    const valid = reconciliationInput(sources);
    const cases: ReconcileModelCatalogInput[] = [];

    cases.push({ ...valid, observationProvenance: [sources.provenance[0]!] });
    cases.push({
      ...valid,
      observations: [sources.observations[0]!, sources.observations[0]!],
      observationProvenance: [sources.provenance[0]!, sources.provenance[0]!],
    });
    cases.push({ ...valid, purpose: "judge" });
    cases.push({ ...valid, observationSetCompletedAt: "2026-08-04T11:59:00.000Z" });
    const tampered = structuredClone(sources.provenance);
    tampered[0]!.sha256 = "f".repeat(64);
    cases.push({ ...valid, observationProvenance: tampered });
    const sparse = [...sources.observations];
    delete sparse[0];
    cases.push({ ...valid, observations: sparse });
    const accessor = [...sources.observations];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => sources.observations[0],
    });
    cases.push({ ...valid, observations: accessor });
    cases.push({ ...valid, extra: true } as unknown as ReconcileModelCatalogInput);
    const topLevelAccessor = { ...valid };
    Object.defineProperty(topLevelAccessor, "purpose", {
      enumerable: true,
      get: () => "policy",
    });
    cases.push(topLevelAccessor);
    const nonPlain = Object.assign(Object.create(null) as Record<string, unknown>, valid);
    cases.push(nonPlain as unknown as ReconcileModelCatalogInput);
    const symbolKeyed = { ...valid } as ReconcileModelCatalogInput & { [key: symbol]: boolean };
    symbolKeyed[Symbol("extra")] = true;
    cases.push(symbolKeyed);
    cases.push(
      new Proxy(valid, {
        ownKeys: () => {
          throw new Error("private proxy trap detail");
        },
      }),
    );

    for (const candidate of cases) {
      expect(() => reconcileModelCatalog(candidate)).toThrow(ModelCatalogReconciliationError);
    }
  });

  it.each(["observationSetId", "proposalId", "decisionId"] as const)(
    "rejects credential-shaped %s on proposed and blocked paths without disclosure",
    async (field) => {
      const sources = await authenticSources();
      const blockedSources = replaceMetadata(sources, "blocked-canary", {
        modelId: observed("modelId", "azure/openai/other-model"),
      });
      const canary = `nvapi-${"Z".repeat(24)}`;
      for (const candidateSources of [sources, blockedSources]) {
        let failure: unknown;
        try {
          reconcileModelCatalog({
            ...reconciliationInput(candidateSources),
            [field]: canary,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(ModelCatalogReconciliationError);
        expect(String(failure)).toBe(
          "ModelCatalogReconciliationError: " +
            "Model catalog reconciliation input or evidence is invalid.",
        );
        expect(String(failure)).not.toContain(canary);
      }
    },
  );

  it("does not mutate the current runtime configuration", async () => {
    const config = inferenceConfig();
    deepFreeze(config);
    const before = JSON.stringify(config);
    const inference = await discoverNvidiaInferenceModelCatalog({
      config,
      purpose: "policy",
      clock: () => NOW,
      fetch: async () =>
        catalogResponse({
          object: "list",
          data: [
            {
              id: RUNTIME_MODEL,
              max_input_tokens: 1_050_000,
              max_output_tokens: 128_000,
            },
          ],
        }),
    });
    const authentic = await authenticSources();
    const metadataIndex = authentic.observations.findIndex(
      (item) => item.source.id === "source:ihub-metadata:authenticated",
    );
    const metadataProvenanceIndex = authentic.provenance.findIndex(
      (item) => item.source.id === "source:ihub-metadata:authenticated",
    );
    const sources = {
      observations: [authentic.observations[metadataIndex]!, inference.observation],
      provenance: [authentic.provenance[metadataProvenanceIndex]!, inference.provenance],
    };
    reconcileModelCatalog(reconciliationInput(sources));
    const blocked = replaceInference(sources, "blocked-nonmutation", {
      limitSemantics: observed("limitSemantics", "independent-input-output"),
    });
    expect(reconcileModelCatalog(reconciliationInput(blocked)).status).toBe("blocked");
    const tampered = structuredClone(sources.provenance);
    tampered[0]!.sha256 = "f".repeat(64);
    expect(() =>
      reconcileModelCatalog(
        reconciliationInput({
          observations: sources.observations,
          provenance: tampered,
        }),
      ),
    ).toThrow(ModelCatalogReconciliationError);

    expect(JSON.stringify(config)).toBe(before);
  });

  it("completes the #63 approval chain with the configured runtime model ID", async () => {
    const sources = await authenticSources();
    const result = reconcileModelCatalog(reconciliationInput(sources));
    if (result.status !== "proposed") throw new Error("expected proposal");
    const approval = finalizeOperatorApprovedModelProfile(
      {
        id: "approval:gpt-5.4",
        purpose: "policy",
        proposalSha256: result.proposal.sha256,
        approvedBy: "operator:catalog-review",
        approvedAt: "2026-08-04T13:00:00.000Z",
        effectiveDate: "2026-08-04",
        reviewAfter: "2026-09-01",
        fields: result.proposal.fields.map((field) =>
          field.state === "conflicting" && field.value !== undefined
            ? { ...structuredClone(field), state: "observed" as const }
            : structuredClone(field),
        ),
      },
      result.proposal,
      result.observationSet,
      result.observations,
    );
    const approvalEvidence = finalizeModelCatalogApprovalEvidence({
      approval,
      proposalProvenance: result.proposalProvenance,
      proposal: result.proposal,
      observationSet: result.observationSet,
      observations: result.observations,
      observationProvenance: result.observationProvenance,
    });
    const authorization = signModelCatalogApprovalAuthorization({
      approvalEvidence,
      approval,
      proposalProvenance: result.proposalProvenance,
      proposal: result.proposal,
      observationSet: result.observationSet,
      observations: result.observations,
      observationProvenance: result.observationProvenance,
      authorityId: approval.approvedBy,
      authorizedAt: approval.approvedAt,
      privateKey: CATALOG_RECONCILIATION_FIXTURE_PRIVATE_KEY,
    });
    const asOf = new Date("2026-08-15T00:00:00.000Z");
    const profile = projectApprovedModelProfile(
      approval,
      result.proposal,
      result.observationSet,
      result.observations,
      asOf,
    );
    const config: ModelEndpointConfig = {
      ...inferenceConfig(),
      profile,
    };

    const evidence = createApprovedCatalogModelEvidence({
      config,
      purpose: "policy",
      asOf,
      approvalEvidence,
      approval,
      proposalProvenance: result.proposalProvenance,
      proposal: result.proposal,
      observationSet: result.observationSet,
      observations: result.observations,
      observationProvenance: result.observationProvenance,
      authorization,
      authority: {
        id: approval.approvedBy,
        publicKey: CATALOG_RECONCILIATION_FIXTURE_PUBLIC_KEY,
      },
    });

    expect(approvalEvidence).toMatchObject({ providerId: "nvidia", modelId: RUNTIME_MODEL });
    expect(config.modelId).toBe(RUNTIME_MODEL);
    expect(evidence).toMatchObject({ provider: "nvidia", model: RUNTIME_MODEL });
  });
});

interface Sources {
  observations: ModelCatalogObservationV1[];
  provenance: ModelCatalogObservationProvenanceV1[];
}

async function authenticSources(): Promise<Sources> {
  const metadata = await inspectInferenceHubMetadata({
    requested: true,
    authority: "authenticated",
    purpose: "policy",
    label: QUALIFIED_MODEL,
    endpoint: { origin: METADATA_ORIGIN, path: "/v1/catalog/search", mode: "search" },
    environment: { INFERENCE_HUB_METADATA_API_KEY: METADATA_KEY },
    clock: () => NOW,
    fetch: async () =>
      jsonResponse({
        data: [
          {
            label: QUALIFIED_MODEL,
            provider_id: "azure",
            status: "active",
            capabilities: {
              chat: true,
              reasoning: true,
              tool_use: true,
              input_modalities: ["text"],
              supports_developer_role: true,
              supports_reasoning_effort: true,
              supports_system_role: true,
            },
            limits: {
              context_length: 1_000_000,
              limit_semantics: "combined-context",
            },
            pricing: null,
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
  });
  if (metadata.status !== "observed") throw new Error("metadata fixture failed");

  const inference = await discoverNvidiaInferenceModelCatalog({
    config: inferenceConfig(),
    purpose: "policy",
    clock: () => NOW,
    fetch: async () =>
      catalogResponse({
        object: "list",
        data: [
          {
            id: RUNTIME_MODEL,
            max_input_tokens: 1_050_000,
            max_output_tokens: 128_000,
          },
        ],
      }),
  });
  return {
    observations: [metadata.observation, inference.observation],
    provenance: [metadata.provenance, inference.provenance],
  };
}

function reconciliationInput(sources: Sources): ReconcileModelCatalogInput {
  return {
    purpose: "policy",
    observationSetId: "observation-set:gpt-5.4",
    observationSetCompletedAt: COMPLETED_AT,
    proposalId: "proposal:gpt-5.4",
    proposalCreatedAt: CREATED_AT,
    decisionId: "decision:gpt-5.4",
    observations: sources.observations,
    observationProvenance: sources.provenance,
  };
}

function inferenceConfig(): ModelEndpointConfig {
  return {
    ...structuredClone(validModelConfig),
    providerId: "nvidia",
    baseUrl: `${NVIDIA_INFERENCE_CATALOG_ORIGIN}/v1`,
    modelId: RUNTIME_MODEL,
    apiKey: INFERENCE_KEY,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function catalogResponse(value: unknown): Response {
  const response = jsonResponse(value);
  Object.defineProperty(response, "url", {
    configurable: true,
    value: NVIDIA_INFERENCE_CATALOG_ENDPOINT,
  });
  return response;
}

function proposalField(fields: readonly { field: ModelCatalogField }[], name: ModelCatalogField) {
  return fields.find((field) => field.field === name);
}

function replaceMetadata(
  sources: Sources,
  suffix: string,
  replacements: Partial<Record<ModelCatalogField, ModelCatalogFieldEvidenceV1>>,
  retrievedAt?: string,
): Sources {
  return replaceRole(
    sources,
    "source:ihub-metadata:authenticated",
    suffix,
    replacements,
    retrievedAt,
  );
}

function replaceInference(
  sources: Sources,
  suffix: string,
  replacements: Partial<Record<ModelCatalogField, ModelCatalogFieldEvidenceV1>>,
  retrievedAt?: string,
): Sources {
  return replaceRole(
    sources,
    "nvidia-inference-api-model-catalog",
    suffix,
    replacements,
    retrievedAt,
  );
}

function replaceRole(
  sources: Sources,
  sourceId: string,
  suffix: string,
  replacements: Partial<Record<ModelCatalogField, ModelCatalogFieldEvidenceV1>>,
  retrievedAt?: string,
): Sources {
  const observations = sources.observations.map((observation) => {
    if (observation.source.id !== sourceId) return observation;
    return finalizeModelCatalogObservation({
      id: `${observation.id}:${suffix}`,
      purpose: observation.purpose,
      source: {
        ...observation.source,
        ...(retrievedAt ? { retrievedAt } : {}),
        adapter: { ...observation.source.adapter },
      },
      fields: observation.fields.map(
        (field) => replacements[field.field] ?? structuredClone(field),
      ),
    });
  });
  const provenance = observations.map((observation) => {
    const existing = sources.observations.find((item) => item.id === observation.id);
    if (existing) {
      return sources.provenance.find((leaf) => leaf.observation.id === existing.id)!;
    }
    return finalizeModelCatalogObservationProvenance({
      observation,
      sourcePath:
        observation.source.id === "nvidia-inference-api-model-catalog"
          ? "/v1/models"
          : "/v1/catalog/search?docsfab-test=true",
    });
  });
  return { observations, provenance };
}

function replaceMetadataTuple(
  sources: Sources,
  suffix: string,
  tuple: { sourceId: string; adapterId: string; adapterVersion: string },
): Sources {
  const observations = sources.observations.map((observation) => {
    if (observation.source.id !== "source:ihub-metadata:authenticated") return observation;
    return finalizeModelCatalogObservation({
      id: `${observation.id}:${suffix}`,
      purpose: observation.purpose,
      source: {
        id: tuple.sourceId,
        adapter: { id: tuple.adapterId, version: tuple.adapterVersion },
        retrievedAt: observation.source.retrievedAt,
      },
      fields: structuredClone(observation.fields),
    });
  });
  const provenance = observations.map((observation) => {
    const existing = sources.provenance.find((leaf) => leaf.observation.id === observation.id);
    return (
      existing ??
      finalizeModelCatalogObservationProvenance({
        observation,
        sourcePath: "/v1/catalog/search?docsfab-test=true",
      })
    );
  });
  return { observations, provenance };
}

function replaceBothPrices(sources: Sources): Sources {
  const metadata = replaceMetadata(sources, "eur-price", {
    inputPrice: observed("inputPrice", {
      amountMicrounits: 1_000_000,
      currency: "EUR",
      unit: "per-million-tokens",
    }),
    billingInterpretation: observed("billingInterpretation", "authoritative-rate"),
  });
  return replaceInference(metadata, "usd-price", {
    inputPrice: observed("inputPrice", {
      amountMicrounits: 1_000_000,
      currency: "USD",
      unit: "per-million-tokens",
    }),
    billingInterpretation: observed("billingInterpretation", "authoritative-rate"),
  });
}

function observed(
  field: ModelCatalogField,
  value: ModelCatalogFieldValue,
): ModelCatalogFieldEvidenceV1 {
  return { field, state: "observed", value };
}

function unknown(
  field: ModelCatalogField,
  reason: "missing" | "not-authoritative" | "source-unavailable",
): ModelCatalogFieldEvidenceV1 {
  return { field, state: "unknown", reason };
}

function unsupported(
  field: ModelCatalogField,
  reason: "model-unsupported" | "source-unsupported",
): ModelCatalogFieldEvidenceV1 {
  return { field, state: "unsupported", reason };
}

function evidenceDigest(value: { sha256: string }): string {
  const { sha256: _sha256, ...body } = value;
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(body as unknown as JsonEvidenceValue))
    .digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
