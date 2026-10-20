// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MODEL_CATALOG_FIELDS,
  ModelCatalogContractError,
  decodeModelCatalogObservation,
  decodeModelCatalogObservationSet,
  decodeModelProfileProposal,
  decodeOperatorApprovedModelProfile,
  finalizeModelCatalogObservation,
  finalizeModelCatalogObservationSet,
  finalizeModelProfileProposal,
  finalizeOperatorApprovedModelProfile,
  projectApprovedModelProfile,
  serializeModelCatalogArtifact,
  type ModelCatalogField,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogFieldValue,
  type ModelCatalogObservationV1,
  type ModelCatalogProposalFieldV1,
  type ModelProfileProposalV1,
} from "../src/model/catalog-contracts.js";
import {
  createModelEvidence,
  validModelEvidenceProjection,
} from "../src/model/profile-evidence.js";
import { validModelConfig } from "./helpers.js";

const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-02T00:00:00.000Z";
const T2 = "2026-08-03T00:00:00.000Z";

describe("normalized model catalog contracts", () => {
  it("canonically round-trips a complete observation without provider payloads", () => {
    const observation = completeObservation();
    const serialized = serializeModelCatalogArtifact(observation);

    expect(decodeModelCatalogObservation(serialized)).toEqual(observation);
    expect(serializeModelCatalogArtifact(decodeModelCatalogObservation(serialized))).toBe(
      serialized,
    );
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).not.toContain("description");
    expect(observation.fields.map((field) => field.field)).toEqual(MODEL_CATALOG_FIELDS);
  });

  it("keeps partial unknown, unsupported, false, and explicit zero distinct", () => {
    const observation = completeObservation("observation:partial", "policy", {
      reasoning: { state: "unknown", reason: "missing" },
      toolUse: { state: "unsupported", reason: "model-unsupported" },
      supportsDeveloperRole: { state: "observed", value: false },
      inputPrice: {
        state: "observed",
        value: { amountMicrounits: 0, currency: "USD", unit: "per-million-tokens" },
      },
      outputPrice: { state: "unknown", reason: "not-authoritative" },
    });
    const parsed = JSON.parse(serializeModelCatalogArtifact(observation)) as {
      fields: Array<Record<string, unknown>>;
    };

    expect(parsed.fields.find((field) => field.field === "reasoning")).toEqual({
      field: "reasoning",
      state: "unknown",
      reason: "missing",
    });
    expect(parsed.fields.find((field) => field.field === "toolUse")).toEqual({
      field: "toolUse",
      state: "unsupported",
      reason: "model-unsupported",
    });
    expect(parsed.fields.find((field) => field.field === "supportsDeveloperRole")).toMatchObject({
      state: "observed",
      value: false,
    });
    expect(parsed.fields.find((field) => field.field === "inputPrice")).toMatchObject({
      state: "observed",
      value: { amountMicrounits: 0 },
    });
    expect(parsed.fields.find((field) => field.field === "outputPrice")).not.toHaveProperty(
      "value",
    );
  });

  it("rejects provider-specific fields recursively and unsafe origins", () => {
    const extra = structuredClone(completeObservation()) as ModelCatalogObservationV1 & {
      source: ModelCatalogObservationV1["source"] & { rawPayload: unknown };
    };
    extra.source.rawPayload = { owned_by: "provider" };
    expect(() => decodeModelCatalogObservation(extra)).toThrow(ModelCatalogContractError);

    expect(() =>
      completeObservation("observation:origin", "policy", {
        origin: { state: "observed", value: "https://catalog.example.test/path?key=secret" },
      }),
    ).toThrow(ModelCatalogContractError);
  });

  it("rejects malformed, duplicate-key, future-version, sparse, and accessor data", () => {
    expect(() => decodeModelCatalogObservation('{"schemaVersion":1,"schemaVersion":2}')).toThrow();
    expect(() => decodeModelCatalogObservation(new Uint8Array([0xff]))).toThrow(
      ModelCatalogContractError,
    );

    const future = structuredClone(completeObservation()) as ModelCatalogObservationV1 & {
      schemaVersion: number;
    };
    Object.assign(future, { schemaVersion: 2 });
    expect(() => decodeModelCatalogObservation(future)).toThrow(ModelCatalogContractError);

    const sparse = structuredClone(completeObservation());
    delete sparse.fields[1];
    expect(() => decodeModelCatalogObservation(sparse)).toThrow(ModelCatalogContractError);

    const accessor = structuredClone(completeObservation());
    Object.defineProperty(accessor.source.adapter, "id", { enumerable: true, get: () => "evil" });
    expect(() => decodeModelCatalogObservation(accessor)).toThrow(ModelCatalogContractError);

    const accessorArray = structuredClone(completeObservation());
    const first = accessorArray.fields[0]!;
    Object.defineProperty(accessorArray.fields, "0", { enumerable: true, get: () => first });
    expect(() => decodeModelCatalogObservation(accessorArray)).toThrow(ModelCatalogContractError);
  });

  it("rejects duplicate or noncanonical conflict alternatives", () => {
    expect(() =>
      completeObservation("observation:duplicate-conflict", "policy", {
        contextWindow: { state: "conflicting", candidates: [10_000, 10_000] },
      }),
    ).toThrow(ModelCatalogContractError);

    const conflict = completeObservation("observation:conflict", "policy", {
      contextWindow: { state: "conflicting", candidates: [1_000_000, 1_050_000] },
    });
    expect(decodeModelCatalogObservation(serializeModelCatalogArtifact(conflict))).toEqual(
      conflict,
    );
  });

  it("builds and verifies a partial proposal from authentic observations", () => {
    const observation = completeObservation("observation:partial-proposal", "policy", {
      reasoning: { state: "unknown", reason: "missing" },
      outputPrice: { state: "unknown", reason: "not-authoritative" },
    });
    const proposal = singleObservationProposal(observation);

    expect(
      decodeModelProfileProposal(serializeModelCatalogArtifact(proposal), setFor([observation]), [
        observation,
      ]),
    ).toEqual(proposal);
    expect(proposal.fields.find((field) => field.field === "reasoning")).not.toHaveProperty(
      "value",
    );
    const approval = approvalFor(proposal, [observation]);
    const projected = projectApprovedModelProfile(
      approval,
      proposal,
      setFor([observation]),
      [observation],
      new Date("2026-08-15T00:00:00.000Z"),
    );
    expect(projected.reasoning).toBe(false);
    expect(projected.costPerMillionTokens).toMatchObject({ input: 1.25, output: null });
  });

  it("recomputes conservative conflict rules and is order invariant", () => {
    const first = completeObservation("observation:a", "policy", {
      contextWindow: { state: "observed", value: 1_000_000 },
      maxInputTokens: { state: "observed", value: 1_000_000 },
      maxOutputTokens: { state: "observed", value: 128_000 },
    });
    const second = completeObservation("observation:b", "policy", {
      contextWindow: { state: "observed", value: 1_050_000 },
      maxInputTokens: { state: "observed", value: 1_050_000 },
      maxOutputTokens: { state: "observed", value: 128_000 },
    });
    const forward = reconciledProposal([first, second], false);
    const reversed = reconciledProposal([second, first], true);

    expect(reversed).toEqual(forward);
    expect(forward.fields.find((field) => field.field === "contextWindow")).toMatchObject({
      state: "conflicting",
      value: 1_000_000,
    });
    expect(
      decodeModelProfileProposal(serializeModelCatalogArtifact(forward), setFor([second, first]), [
        second,
        first,
      ]),
    ).toEqual(forward);
  });

  it("combines complementary sources without turning missing data into false", () => {
    const observed = completeObservation("observation:observed");
    const unknown = completeObservation("observation:unknown", "policy", {
      reasoning: { state: "unknown", reason: "missing" },
    });
    const sourceUnsupported = completeObservation("observation:source-unsupported", "policy", {
      reasoning: { state: "unsupported", reason: "source-unsupported" },
    });
    const proposal = reconciledProposal([observed, unknown, sourceUnsupported]);
    expect(proposal.fields.find((field) => field.field === "reasoning")).toMatchObject({
      state: "observed",
      value: true,
      derivation: { kind: "rule", rule: "prefer-observed@1" },
    });

    const modelUnsupported = completeObservation("observation:model-unsupported", "policy", {
      reasoning: { state: "unsupported", reason: "model-unsupported" },
    });
    expect(() => reconciledProposal([observed, modelUnsupported])).toThrow(
      ModelCatalogContractError,
    );
  });

  it("rejects forged values, omitted evidence, cross-field substitution, and tampered digests", () => {
    const first = completeObservation("observation:a");
    const second = completeObservation("observation:b");
    const valid = reconciledProposal([first, second]);

    const forged = structuredClone(valid);
    forged.fields.find((field) => field.field === "contextWindow")!.value = 999_999;
    expect(() => finalizeProposalClone(forged, [first, second])).toThrow(ModelCatalogContractError);

    const omitted = structuredClone(valid);
    const context = omitted.fields.find((field) => field.field === "contextWindow")!;
    if (context.derivation.kind !== "rule") throw new Error("expected rule");
    context.derivation.inputs.pop();
    expect(() => finalizeProposalClone(omitted, [first, second])).toThrow(
      ModelCatalogContractError,
    );

    const substituted = structuredClone(valid);
    const output = substituted.fields.find((field) => field.field === "maxOutputTokens")!;
    if (output.derivation.kind !== "rule") throw new Error("expected rule");
    output.derivation.inputs[0]!.field = "contextWindow";
    expect(() => finalizeProposalClone(substituted, [first, second])).toThrow(
      ModelCatalogContractError,
    );

    const tamperedObservation = structuredClone(first);
    tamperedObservation.sha256 = "f".repeat(64);
    expect(() =>
      decodeModelProfileProposal(valid, setFor([first, second]), [tamperedObservation, second]),
    ).toThrow(ModelCatalogContractError);
  });

  it("binds proposals to the trusted complete discovery set", () => {
    const first = completeObservation("observation:set-a", "policy", {
      contextWindow: { state: "observed", value: 1_050_000 },
    });
    const second = completeObservation("observation:set-b", "policy", {
      contextWindow: { state: "observed", value: 1_000_000 },
    });
    const incompleteProposal = singleObservationProposal(first);
    const trustedSet = setFor([first, second]);

    expect(() =>
      decodeModelProfileProposal(incompleteProposal, trustedSet, [first, second]),
    ).toThrow(ModelCatalogContractError);
    expect(
      decodeModelCatalogObservationSet(serializeModelCatalogArtifact(trustedSet), [second, first]),
    ).toEqual(trustedSet);
  });

  it("binds approval to the exact proposal, purpose, dates, and selected conflict values", () => {
    const first = completeObservation("observation:a");
    const second = completeObservation("observation:b", "policy", {
      contextWindow: { state: "observed", value: 64_000 },
      maxInputTokens: { state: "observed", value: 47_000 },
    });
    const proposal = reconciledProposal([first, second]);
    const approval = approvalFor(proposal, [first, second]);

    expect(
      decodeOperatorApprovedModelProfile(
        serializeModelCatalogArtifact(approval),
        proposal,
        setFor([first, second]),
        [first, second],
      ),
    ).toEqual(approval);
    expect(approval.fields.find((field) => field.field === "contextWindow")).toMatchObject({
      state: "observed",
      value: 64_000,
    });

    const wrongPurpose = structuredClone(proposal);
    wrongPurpose.purpose = "judge";
    expect(() =>
      decodeOperatorApprovedModelProfile(approval, wrongPurpose, setFor([first, second]), [
        first,
        second,
      ]),
    ).toThrow(ModelCatalogContractError);

    for (const [field, value] of [
      ["modelId", "other/model"],
      ["providerId", "provider:other"],
      ["origin", "https://other.example.test"],
    ] as const) {
      const forged = structuredClone(approval);
      forged.fields.find((item) => item.field === field)!.value = value;
      const { schemaVersion: _schema, kind: _kind, sha256: _sha256, ...input } = forged;
      expect(() =>
        finalizeOperatorApprovedModelProfile(input, proposal, setFor([first, second]), [
          first,
          second,
        ]),
      ).toThrow(ModelCatalogContractError);
    }
  });

  it("rejects future versions independently for every artifact kind", () => {
    const observation = completeObservation();
    const observationSet = setFor([observation]);
    const proposal = singleObservationProposal(observation);
    const approval = approvalFor(proposal, [observation]);
    for (const artifact of [observation, observationSet, proposal, approval]) {
      const future = structuredClone(artifact) as typeof artifact & { schemaVersion: number };
      Object.assign(future, { schemaVersion: 2 });
      if (future.kind === "docsfab-model-catalog-observation") {
        expect(() => decodeModelCatalogObservation(future)).toThrow(ModelCatalogContractError);
      } else if (future.kind === "docsfab-model-catalog-observation-set") {
        expect(() => decodeModelCatalogObservationSet(future, [observation])).toThrow(
          ModelCatalogContractError,
        );
      } else if (future.kind === "docsfab-model-profile-proposal") {
        expect(() => decodeModelProfileProposal(future, observationSet, [observation])).toThrow(
          ModelCatalogContractError,
        );
      } else {
        expect(() =>
          decodeOperatorApprovedModelProfile(future, proposal, setFor([observation]), [
            observation,
          ]),
        ).toThrow(ModelCatalogContractError);
      }
    }
  });

  it.each(["policy", "judge"] as const)(
    "projects a current %s approval through the existing ModelProfile contract",
    (purpose) => {
      const observation = completeObservation(`observation:${purpose}`, purpose);
      const proposal = singleObservationProposal(observation);
      const approval = approvalFor(proposal, [observation]);
      const profile = projectApprovedModelProfile(
        approval,
        proposal,
        setFor([observation]),
        [observation],
        new Date("2026-08-15T00:00:00.000Z"),
      );

      expect(profile).toMatchObject({
        configuredLimits: { contextWindow: 128_000, maxOutputTokens: 16_384 },
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        effectiveLimitReason: "none",
        reasoning: true,
        input: ["image", "text"],
        compatibility: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: true,
          apiFormats: ["chat_completions", "messages"],
        },
        costPerMillionTokens: { input: 1.25, output: 10, cacheRead: 0.5, cacheWrite: 0 },
        metadata: { status: "current" },
      });
      const legacyEvidence = createModelEvidence({ ...validModelConfig, profile });
      expect(validModelEvidenceProjection(legacyEvidence)).toBe(true);
    },
  );

  it("keeps a complete approval current after its review date", () => {
    const observation = completeObservation("observation:overdue", "policy");
    const proposal = singleObservationProposal(observation);
    const approval = approvalFor(proposal, [observation]);
    const project = (asOf: string) =>
      projectApprovedModelProfile(
        approval,
        proposal,
        setFor([observation]),
        [observation],
        new Date(asOf),
      );
    const asOf = "2026-10-01T00:00:00.000Z";
    expect(approval.reviewAfter < asOf.slice(0, 10)).toBe(true);

    const overdue = project(asOf);
    expect(overdue).toEqual(project("2026-08-15T00:00:00.000Z"));
    expect(overdue).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      effectiveLimitReason: "none",
      reasoning: true,
      costPerMillionTokens: { input: 1.25, output: 10, cacheRead: 0.5, cacheWrite: 0 },
      metadata: { status: "current", reviewAfter: approval.reviewAfter },
    });
  });

  it("never enables unknown capabilities or prices, before or after the review date", () => {
    const observation = completeObservation("observation:unknown-claims", "policy", {
      reasoning: { state: "unknown", reason: "missing" },
      supportsDeveloperRole: { state: "unknown", reason: "missing" },
      supportsReasoningEffort: { state: "unknown", reason: "missing" },
      inputPrice: { state: "unknown", reason: "not-authoritative" },
    });
    const proposal = singleObservationProposal(observation);
    const approval = approvalFor(proposal, [observation]);
    const profile = projectApprovedModelProfile(
      approval,
      proposal,
      setFor([observation]),
      [observation],
      new Date("2026-10-01T00:00:00.000Z"),
    );

    expect(profile).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      effectiveLimitReason: "none",
      reasoning: false,
      compatibility: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      costPerMillionTokens: { input: null },
      metadata: { status: "current" },
    });
  });

  it("rejects invalid time and an approval that is not yet effective", () => {
    const observation = completeObservation("observation:time");
    const proposal = singleObservationProposal(observation);
    const approval = approvalFor(proposal, [observation]);
    const { schemaVersion: _schema, kind: _kind, sha256: _sha256, ...futureInput } = approval;
    futureInput.effectiveDate = "2026-09-01";
    futureInput.reviewAfter = "2026-10-01";
    const futureApproval = finalizeOperatorApprovedModelProfile(
      futureInput,
      proposal,
      setFor([observation]),
      [observation],
    );

    expect(() =>
      projectApprovedModelProfile(
        approval,
        proposal,
        setFor([observation]),
        [observation],
        new Date(Number.NaN),
      ),
    ).toThrow(ModelCatalogContractError);
    expect(() =>
      projectApprovedModelProfile(
        approval,
        proposal,
        setFor([observation]),
        [observation],
        new Date("2026-08-03T23:59:59.999Z"),
      ),
    ).toThrow(ModelCatalogContractError);
    expect(() =>
      projectApprovedModelProfile(
        futureApproval,
        proposal,
        setFor([observation]),
        [observation],
        new Date("2026-08-15T00:00:00.000Z"),
      ),
    ).toThrow(ModelCatalogContractError);
  });

  it("approves messages-only profiles without remapping them to chat_completions", () => {
    const observation = completeObservation("observation:messages", "policy", {
      apiFormats: { state: "observed", value: ["messages"] },
    });
    const proposal = singleObservationProposal(observation);
    const approval = approvalFor(proposal, [observation]);
    const profile = projectApprovedModelProfile(
      approval,
      proposal,
      setFor([observation]),
      [observation],
      new Date("2026-08-15T00:00:00.000Z"),
    );
    expect(profile.compatibility.apiFormats).toEqual(["messages"]);
    expect(profile.compatibility.apiFormats).not.toContain("chat_completions");
  });

  it("rejects responses-only projection instead of silently remapping the API", () => {
    const observation = completeObservation("observation:responses", "policy", {
      apiFormats: { state: "observed", value: ["responses"] },
    });
    const proposal = singleObservationProposal(observation);
    expect(() => approvalFor(proposal, [observation])).toThrow(ModelCatalogContractError);
  });

  it("keeps inactive and incompatible limit semantics out of approval", () => {
    for (const overrides of [
      { activity: { state: "observed", value: "inactive" } },
      { limitSemantics: { state: "observed", value: "independent-input-output" } },
    ] satisfies Array<Partial<Record<ModelCatalogField, FieldOverride>>>) {
      const observation = completeObservation("observation:incompatible", "policy", overrides);
      const proposal = singleObservationProposal(observation);
      expect(() => approvalFor(proposal, [observation])).toThrow(ModelCatalogContractError);
    }
  });

  it("accepts the exact combined-budget boundary and rejects boundary plus one", () => {
    const exact = completeObservation("observation:exact-combined-budget", "policy", {
      contextWindow: { state: "observed", value: 128_000 },
      maxInputTokens: { state: "observed", value: 111_616 },
      maxOutputTokens: { state: "observed", value: 16_384 },
      limitSemantics: { state: "observed", value: "combined-context" },
    });
    const exactProposal = singleObservationProposal(exact);
    expect(() => approvalFor(exactProposal, [exact])).not.toThrow();

    const plusOne = completeObservation("observation:unsafe-combined-budget", "policy", {
      contextWindow: { state: "observed", value: 128_000 },
      maxInputTokens: { state: "observed", value: 111_617 },
      maxOutputTokens: { state: "observed", value: 16_384 },
      limitSemantics: { state: "observed", value: "combined-context" },
    });
    const plusOneProposal = singleObservationProposal(plusOne);

    expect(() => approvalFor(plusOneProposal, [plusOne])).toThrow(ModelCatalogContractError);
  });
});

type FieldOverride =
  | { state: "observed"; value: ModelCatalogFieldValue }
  | { state: "unknown"; reason: "missing" | "not-authoritative" | "source-unavailable" }
  | { state: "unsupported"; reason: "model-unsupported" | "source-unsupported" }
  | { state: "conflicting"; candidates: ModelCatalogFieldValue[] };

function completeObservation(
  id = "observation:complete",
  purpose: "policy" | "judge" = "policy",
  overrides: Partial<Record<ModelCatalogField, FieldOverride>> = {},
): ModelCatalogObservationV1 {
  const values = completeValues();
  const fields = MODEL_CATALOG_FIELDS.map((field): ModelCatalogFieldEvidenceV1 => {
    const override = overrides[field];
    return override
      ? ({ field, ...override } as ModelCatalogFieldEvidenceV1)
      : {
          field,
          state: "observed",
          value: values[field],
        };
  }).reverse();
  return finalizeModelCatalogObservation({
    id,
    purpose,
    source: {
      id: `source:${id.split(":").at(-1)}`,
      adapter: { id: "adapter:fixture", version: "1.0.0" },
      retrievedAt: T2,
    },
    fields,
  });
}

function completeValues(): Record<ModelCatalogField, ModelCatalogFieldValue> {
  return {
    activity: "active",
    apiFormats: ["chat_completions", "messages"],
    billingInterpretation: "authoritative-rate",
    cacheReadPrice: price(500_000),
    cacheWritePrice: price(0),
    contextWindow: 128_000,
    inputModalities: ["text", "image"],
    inputPrice: price(1_250_000),
    limitSemantics: "combined-context",
    maxInputTokens: 111_616,
    maxOutputTokens: 16_384,
    modelId: "example/model",
    origin: "https://inference.example.test",
    outputPrice: price(10_000_000),
    providerCreatedAt: T0,
    providerId: "provider:example",
    providerUpdatedAt: T1,
    reasoning: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsSystemRole: true,
    toolUse: true,
  };
}

function price(amountMicrounits: number) {
  return { amountMicrounits, currency: "USD", unit: "per-million-tokens" as const };
}

function reference(observation: ModelCatalogObservationV1, field: ModelCatalogField) {
  return { observationId: observation.id, observationSha256: observation.sha256, field };
}

function singleObservationProposal(observation: ModelCatalogObservationV1): ModelProfileProposalV1 {
  const observationSet = setFor([observation]);
  return finalizeModelProfileProposal(
    {
      id: `proposal:${observation.id.split(":").at(-1)}`,
      purpose: observation.purpose,
      createdAt: T2,
      observationSet: { id: observationSet.id, sha256: observationSet.sha256 },
      observations: [{ id: observation.id, sha256: observation.sha256 }],
      fields: observation.fields
        .map(
          (field): ModelCatalogProposalFieldV1 => ({
            field: field.field,
            state: field.state,
            ...(field.state === "observed" ? { value: field.value } : {}),
            derivation: { kind: "observation", input: reference(observation, field.field) },
          }),
        )
        .reverse(),
    },
    observationSet,
    [observation],
  );
}

function reconciledProposal(
  observations: ModelCatalogObservationV1[],
  reverseFields = false,
): ModelProfileProposalV1 {
  const source = [...observations].sort((left, right) => left.id.localeCompare(right.id));
  const observationSet = setFor(source);
  const fields = MODEL_CATALOG_FIELDS.map((field): ModelCatalogProposalFieldV1 => {
    const entries = source.map(
      (observation) => observation.fields.find((entry) => entry.field === field)!,
    );
    const values = entries.flatMap((entry) => (entry.state === "observed" ? [entry.value] : []));
    const distinct = new Set(values.map((value) => JSON.stringify(value))).size;
    const numericConflict = distinct > 1 && values.every((value) => typeof value === "number");
    const complementary = distinct === 1 && entries.some((entry) => entry.state !== "observed");
    return {
      field,
      state: numericConflict ? "conflicting" : "observed",
      value: numericConflict ? Math.min(...(values as number[])) : values[0]!,
      derivation: {
        kind: "rule",
        rule: numericConflict
          ? "minimum-number@1"
          : complementary
            ? "prefer-observed@1"
            : "exact-consensus@1",
        inputs: source.map((observation) => reference(observation, field)).reverse(),
      },
    };
  });
  return finalizeModelProfileProposal(
    {
      id: "proposal:reconciled",
      purpose: source[0]!.purpose,
      createdAt: T2,
      observationSet: { id: observationSet.id, sha256: observationSet.sha256 },
      observations: observations.map((observation) => ({
        id: observation.id,
        sha256: observation.sha256,
      })),
      fields: reverseFields ? fields.reverse() : fields,
    },
    observationSet,
    observations,
  );
}

function approvalFor(proposal: ModelProfileProposalV1, observations: ModelCatalogObservationV1[]) {
  const fields = proposal.fields.map(
    (field): ModelCatalogProposalFieldV1 =>
      field.state === "conflicting" && field.value !== undefined
        ? { ...field, state: "observed" }
        : structuredClone(field),
  );
  return finalizeOperatorApprovedModelProfile(
    {
      id: `approval:${proposal.purpose}`,
      purpose: proposal.purpose,
      proposalSha256: proposal.sha256,
      approvedBy: "operator:fixture",
      approvedAt: "2026-08-04T00:00:00.000Z",
      effectiveDate: "2026-08-04",
      reviewAfter: "2026-09-01",
      fields,
    },
    proposal,
    setFor(observations),
    observations,
  );
}

function finalizeProposalClone(
  value: ModelProfileProposalV1,
  observations: ModelCatalogObservationV1[],
) {
  const { schemaVersion: _schema, kind: _kind, sha256: _sha256, ...input } = value;
  return finalizeModelProfileProposal(input, setFor(observations), observations);
}

function setFor(observations: ModelCatalogObservationV1[]) {
  const purpose = observations[0]!.purpose;
  return finalizeModelCatalogObservationSet(
    {
      id: `observation-set:${purpose}`,
      purpose,
      completedAt: T2,
      observations: observations.map((observation) => ({
        id: observation.id,
        sha256: observation.sha256,
      })),
    },
    observations,
  );
}
