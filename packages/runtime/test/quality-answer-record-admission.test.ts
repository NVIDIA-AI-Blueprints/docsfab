// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { OUTPUT_RECORD_CONTRACTS } from "../src/contracts/model-output.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../src/harness/answer-submission.js";
import {
  canonicalAdmissionHostFailureReason,
  createQualityAnswerRecordAdmission,
  qualityAnswerRecordAdmissionFailureMessage,
  type QualityAnswerRecordNarrowingV1,
} from "../src/harness/quality-answer-record-admission.js";
import { createQualityAnswerRecordTool } from "../src/harness/quality-candidate-tool.js";
import { deriveAnswerSubmissionRemainingPlan } from "../src/model-composition/answer-submission-record-fit.js";

type ValidateAnswerRecords = Parameters<
  typeof createQualityAnswerRecordAdmission
>[0]["validateRecords"];
type ValidateAnswerRecordCompletion = Parameters<
  typeof createQualityAnswerRecordAdmission
>[0]["validateCompletion"];
import {
  admitAnswerRecordCall,
  createAnswerRecordLedger,
  decodeAnswerRecordCall,
  planAnswerRecords,
  type AnswerRecordAssemblyInput,
} from "../src/harness/answer-records.js";
import { planDocumentationQualityAnswerRecords } from "../src/harness/answer-record-plan.js";
import type { HostMintedValues } from "../src/harness/answer-record-fill.js";
import { registerConfiguredCredential } from "../src/security/configured-credentials.js";
import {
  createRepository,
  resetSharedTestState,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";
import {
  FIXTURE_REPORT,
  qualityStepInput,
  rawToolCallTurn,
  toolResults,
  toolPathHarness,
  userText,
} from "./support/answer-submission-fixtures.js";

const declaration = OUTPUT_RECORD_CONTRACTS["quality-evaluation"];
const digest = "a".repeat(64);
const storeRoots: string[] = [];

async function makeAdmission(
  validateRecords: Parameters<typeof createQualityAnswerRecordAdmission>[0]["validateRecords"],
  hostMinted: HostMintedValues = {} as never,
  validateCompletion: Parameters<
    typeof createQualityAnswerRecordAdmission
  >[0]["validateCompletion"] = async () => ({ status: "valid" }),
  derive: AnswerRecordAssemblyInput["derive"] = async () => ({ status: "open", open: ["test"] }),
  limitOverrides: Readonly<Record<string, number>> = {},
  requiredSelectorSlots: readonly string[] = ["layer-one"],
  options: {
    readonly attempt?: number;
    readonly profilePayloadSha256?: string;
    readonly compositionSha256?: string;
    readonly answerPathCapabilitySha256?: string;
    readonly store?: DurableArtifactStore;
    readonly restoreCheckpoint?: Awaited<
      ReturnType<ReturnType<typeof createQualityAnswerRecordAdmission>["latestCheckpoint"]>
    >;
    readonly onCheckpoint?: Parameters<
      typeof createQualityAnswerRecordAdmission
    >[0]["onCheckpoint"];
    readonly nonExhaustingRefusals?: boolean;
    readonly recordNarrowing?: Partial<QualityAnswerRecordNarrowingV1>;
    readonly referenceIds?: Readonly<Record<string, readonly string[]>>;
  } = {},
) {
  let store = options.store;
  if (!store) {
    const root = await mkdtemp(join(tmpdir(), "quality-record-admission-"));
    storeRoots.push(root);
    store = new DurableArtifactStore(root);
    await store.initialize();
  }
  const plan = planAnswerRecords({
    declaration,
    skeletons: {
      dimensions: [{ key: "dimension-one", slot: "layer-one" }],
      constraints: [{ key: "constraint-one", slot: "constraint-one" }],
      layers: [{ key: "layer-one", slot: "layer-one" }],
    },
    selectors: { required: requiredSelectorSlots },
    limitValue: (name) =>
      limitOverrides[name] ??
      (name === "answerRecords.maxRefusalsPerKey"
        ? 1
        : name === "sealed.answerSubmission.maxRecordBytes"
          ? 8192
          : 128),
  });
  const session = createQualityAnswerRecordAdmission({
    store,
    declaration,
    plan,
    ...(options.nonExhaustingRefusals ? { nonExhaustingRefusals: true } : {}),
    bindings: {
      runId: "run-test",
      stepId: "evaluate-document-quality",
      attempt: options.attempt ?? 1,
      declarationSha256: canonicalDigest(declaration),
      schemaSha256s: {
        evaluation: digest,
        qualityScore: digest,
        qualityPolicy: "b".repeat(64),
      },
      profilePayloadSha256: options.profilePayloadSha256 ?? "c".repeat(64),
      selectionSha256: "d".repeat(64),
      referenceSourceSha256s: {
        "audience-attempt": digest,
        "technical-fact": digest,
        "technical-issue": digest,
        "review-issue": digest,
      },
      evaluatorIdentitySha256: "e".repeat(64),
      compositionSha256: options.compositionSha256 ?? "f".repeat(64),
      answerPathCapabilitySha256: options.answerPathCapabilitySha256 ?? "1".repeat(64),
    },
    hostMinted,
    references: { "audience-attempt": [] },
    referenceIds: {
      "audience-attempt": [],
      "technical-fact": [],
      "technical-issue": [],
      "review-issue": [],
      ...options.referenceIds,
    },
    renderReference: () => [],
    derive,
    recordNarrowing: {
      profilePayloadSha256: options.profilePayloadSha256 ?? "c".repeat(64),
      selectionSha256: "d".repeat(64),
      qualityPolicySha256: "b".repeat(64),
      requiredDimensionIds: ["dimension-one"],
      hardGateIds: ["gate-one"],
      confidenceAnchors: [0.25, 0.5, 0.75],
      d3ResidualDecisions: ["no-shortfall"],
      qualityEvaluationTargetPaths: ["docs/page.md"],
      ...options.recordNarrowing,
    },
    validateRecords,
    validateCompletion,
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
  });
  if (options.restoreCheckpoint) await session.restoreCheckpoint(options.restoreCheckpoint);
  return { ...session, store, plan };
}

async function cleanupStores() {
  await Promise.all(storeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

async function settleForDiagnostic(
  capability: Awaited<ReturnType<typeof createQualityAnswerRecordAdmission>>["capability"],
  input: Parameters<typeof capability.settle>[0],
): Promise<void> {
  return runWithDiagnostic("settle", () => capability.settle(input));
}

async function runWithDiagnostic(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const candidate = error as {
      name?: unknown;
      rejection?: { code?: unknown };
      stack?: unknown;
    };
    const code =
      typeof candidate.rejection?.code === "string"
        ? candidate.rejection.code
        : typeof candidate.name === "string"
          ? candidate.name
          : "unknown-error";
    const frames =
      typeof candidate.stack === "string"
        ? candidate.stack
            .split("\n")
            .slice(1, 16)
            .map((frame) => frame.trim())
            .filter((frame) => frame.includes("quality-answer-record-admission"))
        : [];
    throw new Error(`${label} diagnostic code=${code}; ${frames.join(" | ")}`);
  }
}

function receiptSummary(receipt: {
  readonly status: string;
  readonly type: string | null;
  readonly key: string | null;
  readonly code?: string;
  readonly location?: string;
  readonly remaining: readonly string[];
  readonly complete: boolean;
  readonly open?: readonly string[];
}): string {
  return JSON.stringify({
    status: receipt.status,
    type: receipt.type,
    key: receipt.key,
    code: receipt.code,
    location: receipt.location,
    remaining: receipt.remaining,
    complete: receipt.complete,
    open: receipt.open,
  });
}

const validEvaluationNote = JSON.stringify({
  type: "evaluation-note",
  record: { findings_complete: true },
});
const call = (toolCallId: string, rawArguments: string | undefined = validEvaluationNote) => ({
  toolCallId,
  rawArguments,
});

function generatedValue(schema: Record<string, unknown>): unknown {
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (Array.isArray(schema.enum)) return structuredClone(schema.enum[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    const result: Record<string, unknown> = Object.fromEntries(
      required.map((key) => [String(key), generatedValue(properties[String(key)] ?? {})]),
    );
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const alternatives = schema[keyword];
      if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
      const selected =
        keyword === "allOf"
          ? alternatives.map((entry) => generatedValue(entry as Record<string, unknown>))
          : [generatedValue(alternatives[0] as Record<string, unknown>)];
      for (const value of selected) {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          Object.assign(result, value);
        }
      }
      if (keyword !== "allOf") break;
    }
    return result;
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
    if (keyword === "allOf") {
      const values = alternatives.map((entry) => generatedValue(entry as Record<string, unknown>));
      return values.reduce<unknown>((merged, value) => {
        if (merged !== null && typeof merged === "object" && !Array.isArray(merged)) {
          if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            return Object.assign(merged, value);
          }
        }
        return merged ?? value;
      }, undefined);
    }
    return generatedValue(alternatives[0] as Record<string, unknown>);
  }
  if (type === "array") {
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
    return Array.from({ length: minimum }, () =>
      generatedValue((schema.items ?? {}) as Record<string, unknown>),
    );
  }
  if (type === "string") {
    const minimum = typeof schema.minLength === "number" ? schema.minLength : 1;
    return "x".repeat(Math.max(minimum, 1));
  }
  if (type === "number" || type === "integer") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (type === "boolean") return false;
  if (type === "null") return null;
  return null;
}

function setAllowedPaths(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) setAllowedPaths(entry);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "paths") {
      (value as Record<string, unknown>)[key] = ["docs/page.md"];
    } else {
      setAllowedPaths(child);
    }
  }
}

function recordShape(type: string, shapeIndex = 0): Record<string, unknown> {
  const declarationRow = declaration.records.find((entry) => entry.type === type);
  if (!declarationRow) throw new Error(`Missing generated record declaration: ${type}`);
  const shape = declarationRow.shapes[shapeIndex]?.shape;
  if (!shape) throw new Error(`Missing generated shape ${shapeIndex} for ${type}`);
  const result = generatedValue(shape as Record<string, unknown>) as Record<string, unknown>;
  if (type === "dimension") result.confidence = 0.5;
  if (type === "target-judgment") setAllowedPaths(result);
  return result;
}

function requiredFixtureRecords() {
  return [
    {
      type: "target-judgment",
      key: "singleton",
      record: recordShape("target-judgment"),
    },
    { type: "dimension", key: "dimension-one", record: recordShape("dimension", 0) },
    { type: "dimension", key: "constraint-one", record: recordShape("dimension", 1) },
    { type: "quality-score", key: "singleton", record: recordShape("quality-score") },
    { type: "evaluation-note", key: "singleton", record: { findings_complete: true } },
  ];
}

function validLayerNoteRecord(): Record<string, unknown> {
  return {
    ...recordShape("layer-note"),
    limitations: [],
    layer_shortfall_decision: "no-shortfall",
  };
}

async function makeCompleteAdmission(
  validateRecords: Parameters<typeof createQualityAnswerRecordAdmission>[0]["validateRecords"],
  validateCompletion: Parameters<
    typeof createQualityAnswerRecordAdmission
  >[0]["validateCompletion"],
  waitForLayerNote: boolean,
  nonExhaustingRefusals = false,
  options: {
    readonly attempt?: number;
    readonly store?: DurableArtifactStore;
    readonly restoreCheckpoint?: Awaited<
      ReturnType<ReturnType<typeof createQualityAnswerRecordAdmission>["latestCheckpoint"]>
    >;
    readonly onCheckpoint?: Parameters<
      typeof createQualityAnswerRecordAdmission
    >[0]["onCheckpoint"];
    readonly derive?: AnswerRecordAssemblyInput["derive"];
  } = {},
) {
  const hostMinted: HostMintedValues = {
    "run.step-attempt-id": "attempt-1",
    "contract.evaluation-version": declaration.version,
    "host.clock-at-assembly": () => "2026-10-09T00:00:00.000Z",
    "selection-receipt.profileModel": "fixture-model",
    "selection-receipt.profile": {},
    "evaluate-step-evidence": {},
    "selection-receipt.scopeType": "repository",
    "quality-evaluation-target": (field: string) =>
      field.endsWith(".paths") ? ["docs/page.md"] : "docs/page.md",
    "selection-receipt.repositoryRevision": "revision-1",
    "workflow.finding-owner": "model",
    "workflow.finding-status": "open",
  };
  const derive: AnswerRecordAssemblyInput["derive"] = async ({ artifact, records }) => {
    const hasLayerNote = records.some((entry) => entry.type === "layer-note");
    if (waitForLayerNote && !hasLayerNote) return { status: "open", open: ["layer-one"] };
    const evaluation = structuredClone(artifact.evaluation as Record<string, unknown>);
    for (const layer of Object.values(
      evaluation.layers as Record<string, Record<string, unknown>>,
    )) {
      layer.confidence = 0.5;
      layer.hard_gate_failures = [];
      layer.decision = "pass";
      for (const dimension of layer.dimensions as Record<string, unknown>[]) {
        dimension.applicability = "required";
      }
    }
    for (const constraint of Object.values(
      evaluation.constraints as Record<string, Record<string, unknown>>,
    )) {
      constraint.applicability = "required";
    }
    evaluation.confidence = 0.5;
    evaluation.hard_gate_failures = [];
    evaluation.overall_decision = "pass";
    evaluation.conditions = [];
    const qualityScore = structuredClone(artifact.qualityScore as Record<string, unknown>);
    qualityScore.total = 0;
    return {
      status: "derived",
      artifact: { ...artifact, evaluation, qualityScore },
      hostParts: { "quality:host-limitations": [], "quality:coherence-labels": [] },
    };
  };
  return makeAdmission(
    validateRecords,
    hostMinted,
    validateCompletion,
    options.derive ?? derive,
    {},
    ["layer-one"],
    {
      ...(options.attempt ? { attempt: options.attempt } : {}),
      ...(options.store ? { store: options.store } : {}),
      ...(options.restoreCheckpoint ? { restoreCheckpoint: options.restoreCheckpoint } : {}),
      nonExhaustingRefusals,
      ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
    },
  );
}

async function resealCheckpoint(
  admission: Awaited<ReturnType<typeof makeAdmission>>,
  checkpoint: NonNullable<Awaited<ReturnType<typeof admission.latestCheckpoint>>>,
  mutate: (record: Record<string, unknown>) => void,
) {
  const record = structuredClone(checkpoint.record) as unknown as Record<string, unknown>;
  delete record.recordSha256;
  mutate(record);
  const sealed = { ...record, recordSha256: canonicalDigest(record) };
  const sha256 = opaqueRecordDigest(sealed);
  await admission.store.putRecord(sha256, sealed);
  return { record: sealed as typeof checkpoint.record, sha256 };
}

function fixtureCall(toolCallId: string, record: { type: string; key: string; record: unknown }) {
  const singleton =
    declaration.records.find((entry) => entry.type === record.type)?.key === "singleton";
  return call(
    toolCallId,
    JSON.stringify({
      type: record.type,
      ...(!singleton ? { key: record.key } : {}),
      record: record.record,
    }),
  );
}

describe("quality answer record admission", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await resetSharedTestState();
    await cleanupStores();
  });

  it.each([
    { exhaustPerKeyRefusals: true, finalCode: "answer-record-exhausted" },
    { exhaustPerKeyRefusals: false, finalCode: "answer-record-closed" },
  ])(
    "records closed-set refusals and applies the selected exhaustion mode ($exhaustPerKeyRefusals)",
    ({ exhaustPerKeyRefusals, finalCode }) => {
      const plan = planDocumentationQualityAnswerRecords({
        requiredDimensionsByLayer: { "layer-one": ["dimension-one"] },
        requiredConstraints: [],
        conditionalConstraints: [],
        enforceClosedSetAdmission: true,
      });
      const close = admitAnswerRecordCall(
        createAnswerRecordLedger(plan),
        JSON.stringify({ type: "evaluation-note", record: recordShape("evaluation-note") }),
      );
      expect(close.receipt.status).toBe("admitted");

      const rawFinding = JSON.stringify({ type: "finding", record: recordShape("finding") });
      let ledger = close.ledger;
      const attempts = plan.maxRefusalsPerKey + 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const result = admitAnswerRecordCall(ledger, rawFinding, { exhaustPerKeyRefusals });
        const shouldExhaust = exhaustPerKeyRefusals && attempt > plan.maxRefusalsPerKey;
        expect(result.receipt).toMatchObject({
          status: "refused",
          code: shouldExhaust ? finalCode : "answer-record-closed",
        });
        expect([...result.ledger.refusals.values()].reduce((sum, count) => sum + count, 0)).toBe(
          attempt,
        );
        ledger = result.ledger;
      }
      expect(ledger.exhausted !== null).toBe(exhaustPerKeyRefusals);
    },
  );

  it("records only a closed content-free host reason for host validation failures", async () => {
    expect(canonicalAdmissionHostFailureReason("assembly-validator-owner")).toBe(
      "assembly-validator-owner",
    );
    expect(canonicalAdmissionHostFailureReason("CANARY-secret-value")).toBe("unclassified");

    const session = await makeAdmission(async () => [
      { toolCallId: "unexpected-call-id", status: "valid" },
    ]);
    const candidate = { type: "dimension", key: "dimension-one", record: recordShape("dimension") };
    await expect(
      session.capability.prepareBatch({
        batchId: "host-reason-test",
        toolCalls: [fixtureCall("expected-call-id", candidate)],
        authorizedToolCallIds: ["expected-call-id"],
      }),
    ).rejects.toMatchObject({
      rejection: { code: "candidate-staging-integrity-failed" },
      message: expect.stringContaining("host reason: validator-outcome-set"),
    });
    expect(qualityAnswerRecordAdmissionFailureMessage("CANARY-secret-value")).toContain(
      "host reason: unclassified",
    );
    expect(qualityAnswerRecordAdmissionFailureMessage("CANARY-secret-value")).not.toContain(
      "CANARY-secret-value",
    );
  });

  it("exposes the exact answer-record call ceiling derived from its admitted plan", async () => {
    const session = await makeAdmission(async () => []);
    expect(session.recordCallCeiling).toBe(session.plan.recordCallCeiling);
  });

  it("keeps admitted record payloads out of model-facing receipts", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const session = await makeAdmission(validateRecords);
    const marker = "receipt-payload-must-remain-host-private";
    const record = recordShape("dimension", 0);
    record.rationale = marker;
    const input = fixtureCall("content-free-receipt", {
      type: "dimension",
      key: "dimension-one",
      record,
    });
    await session.capability.prepareBatch({
      batchId: "content-free-receipt",
      toolCalls: [input],
      authorizedToolCallIds: ["content-free-receipt"],
    });

    const receipt = session.capability.receipt("content-free-receipt");
    expect(receipt.status).toBe("admitted");
    expect(receipt).not.toHaveProperty("record");
    expect(JSON.stringify(receipt)).not.toContain(marker);
  });

  it("materializes selector-owned required constraint applicability as host-owned", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(validateRecords, undefined, undefined, undefined, {}, [
      "constraint-one",
    ]);
    const record = recordShape("dimension", 1);
    delete record.applicability;
    await session.capability.prepareBatch({
      batchId: "required-constraint-host-applicability",
      toolCalls: [
        fixtureCall("required-constraint", {
          type: "dimension",
          key: "constraint-one",
          record,
        }),
      ],
      authorizedToolCallIds: ["required-constraint"],
    });

    expect(session.capability.receipt("required-constraint").status).toBe("admitted");
    expect(validateRecords).toHaveBeenCalledTimes(1);
    expect(validateRecords.mock.calls[0]?.[0][0]?.record).not.toHaveProperty("applicability");
    expect(session.promptGuidance).toContain('"key":"constraint-one"');
    expect(session.promptGuidance).not.toContain('"applicability"');
  });

  it("rejects model-supplied selector-owned applicability and still requires optional applicability", async () => {
    const requiredValidator = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const required = await makeAdmission(requiredValidator, undefined, undefined, undefined, {}, [
      "constraint-one",
    ]);
    const modelSupplied = recordShape("dimension", 1);
    await required.capability.prepareBatch({
      batchId: "required-constraint-model-applicability",
      toolCalls: [
        fixtureCall("required-constraint-with-applicability", {
          type: "dimension",
          key: "constraint-one",
          record: modelSupplied,
        }),
      ],
      authorizedToolCallIds: ["required-constraint-with-applicability"],
    });
    expect(required.capability.receipt("required-constraint-with-applicability")).toMatchObject({
      status: "refused",
      code: "evaluation-schema-additional-properties",
    });
    expect(
      required.capability.receipt("required-constraint-with-applicability").feedback,
    ).toContain(
      'Allowed properties at this location: ["assessment","confidence","evidence","measures","rationale","hard_gate_failures"].',
    );
    expect(
      required.capability.receipt("required-constraint-with-applicability").feedback,
    ).not.toContain('"applicability"');
    expect(requiredValidator).not.toHaveBeenCalled();

    const optionalValidator = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const optional = await makeAdmission(
      optionalValidator,
      undefined,
      undefined,
      undefined,
      {},
      [],
    );
    const omitted = recordShape("dimension", 1);
    delete omitted.applicability;
    await optional.capability.prepareBatch({
      batchId: "optional-constraint-requires-applicability",
      toolCalls: [
        fixtureCall("optional-constraint", {
          type: "dimension",
          key: "constraint-one",
          record: omitted,
        }),
      ],
      authorizedToolCallIds: ["optional-constraint"],
    });
    expect(optional.capability.receipt("optional-constraint")).toMatchObject({
      status: "refused",
      code: "evaluation-schema-required",
    });
    expect(optional.promptGuidance).toContain('"applicability"');
    expect(optionalValidator).not.toHaveBeenCalled();
  });

  it("explains schema refusals as complete record replacements without echoing rejected content", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(
      validateRecords,
      undefined,
      undefined,
      undefined,
      {},
      ["layer-one"],
      { nonExhaustingRefusals: true },
    );
    const record = recordShape("target-judgment");
    const rejectedMarker = "never-echo-this-rejected-record-value";
    record.rationale = rejectedMarker;
    delete record.documentation_families;

    await session.capability.prepareBatch({
      batchId: "target-judgment-incomplete",
      toolCalls: [
        fixtureCall("target-judgment-incomplete", {
          type: "target-judgment",
          key: "singleton",
          record,
        }),
      ],
      authorizedToolCallIds: ["target-judgment-incomplete"],
    });
    const refusal = session.capability.receipt("target-judgment-incomplete");
    expect(refusal).toMatchObject({ status: "refused", code: "evaluation-schema-required" });
    expect(refusal.feedback).toContain("complete replacement record");
    expect(refusal.feedback).toContain(
      'Required top-level fields in record: ["documentation_families","documentation_family_evidence","product_reference_model","product_version","environment","risk_boundary","risk_classes","audiences","intended_outcomes","intended_outcome_classes"].',
    );
    expect(refusal.feedback).not.toContain(rejectedMarker);
    for (const hostMintedField of [
      "scope_type",
      "paths",
      "repository_revision",
      "documentation_revision",
      "approved_evidence_revision",
      "delivery_surface_locator",
    ]) {
      expect(refusal.feedback).not.toContain(`"${hostMintedField}"`);
    }
    await session.capability.settle({
      batchId: "target-judgment-incomplete",
      toolCallIds: ["target-judgment-incomplete"],
      authorizedToolCallIds: ["target-judgment-incomplete"],
      successfulToolCallIds: [],
    });

    const corrected = recordShape("target-judgment");
    await session.capability.prepareBatch({
      batchId: "target-judgment-corrected",
      toolCalls: [
        fixtureCall("target-judgment-corrected", {
          type: "target-judgment",
          key: "singleton",
          record: corrected,
        }),
      ],
      authorizedToolCallIds: ["target-judgment-corrected"],
    });
    expect(session.capability.receipt("target-judgment-corrected").status).toBe("admitted");
    expect(validateRecords).toHaveBeenCalledTimes(1);
  });

  it("gives schema-owned guidance for nested and host-derived extra properties and retains prior rows", async () => {
    const arraySession = await makeAdmission(
      vi.fn<ValidateAnswerRecords>(async (records) =>
        records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
      ),
    );
    const arrayRecord = recordShape("target-judgment");
    const arrayMarker = "do-not-echo-array-extra";
    (arrayRecord.documentation_family_evidence as Record<string, unknown>[])[0]!.unapproved =
      arrayMarker;
    await arraySession.capability.prepareBatch({
      batchId: "array-item-extra-property",
      toolCalls: [
        fixtureCall("array-item-extra", {
          type: "target-judgment",
          key: "singleton",
          record: arrayRecord,
        }),
      ],
      authorizedToolCallIds: ["array-item-extra"],
    });
    const arrayRefusal = arraySession.capability.receipt("array-item-extra");
    expect(arrayRefusal.location).toBe("$.record.documentation_family_evidence[]");
    expect(arrayRefusal.feedback).toContain('"evidence_locator"');
    expect(arrayRefusal.feedback).not.toContain("unapproved");
    expect(arrayRefusal.feedback).not.toContain(arrayMarker);
    await arraySession.capability.settle({
      batchId: "array-item-extra-property",
      toolCallIds: ["array-item-extra"],
      authorizedToolCallIds: ["array-item-extra"],
      successfulToolCallIds: [],
    });

    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeCompleteAdmission(
      validateRecords,
      async () => ({ status: "valid" }),
      false,
      true,
    );
    const prior = requiredFixtureRecords().filter((entry) => entry.type !== "quality-score");
    const priorCalls = prior.map((entry, index) => fixtureCall(`kept-${index}`, entry));
    await session.capability.prepareBatch({
      batchId: "keep-accepted-before-schema-feedback",
      toolCalls: priorCalls,
      authorizedToolCallIds: priorCalls.map(({ toolCallId }) => toolCallId),
    });
    await session.capability.settle({
      batchId: "keep-accepted-before-schema-feedback",
      toolCallIds: priorCalls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: priorCalls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: priorCalls.map(({ toolCallId }) => toolCallId),
    });
    const priorSnapshot = await session.snapshotIndex();

    const nestedScore = recordShape("quality-score");
    const nestedMarker = "do-not-echo-nested-extra";
    (nestedScore.scores as Record<string, unknown>).unapproved_nested_marker = nestedMarker;
    await session.capability.prepareBatch({
      batchId: "nested-extra-property",
      toolCalls: [fixtureCall("nested-extra", { type: "quality-score", record: nestedScore })],
      authorizedToolCallIds: ["nested-extra"],
    });
    const nestedRefusal = session.capability.receipt("nested-extra");
    expect(nestedRefusal.status).toBe("refused");
    expect(nestedRefusal.code).toBe("evaluation-schema-additional-properties");
    expect(nestedRefusal.location).toBe("$.record.scores");
    expect(nestedRefusal.feedback).toContain('"technical_accuracy"');
    expect(nestedRefusal.feedback).not.toContain("unapproved_nested_marker");
    expect(nestedRefusal.feedback).not.toContain(nestedMarker);
    await session.capability.settle({
      batchId: "nested-extra-property",
      toolCallIds: ["nested-extra"],
      authorizedToolCallIds: ["nested-extra"],
      successfulToolCallIds: [],
    });

    const hostDerivedScore = recordShape("quality-score");
    const hostMarker = "do-not-echo-host-derived-total";
    hostDerivedScore.total = hostMarker;
    await session.capability.prepareBatch({
      batchId: "host-derived-extra-property",
      toolCalls: [
        fixtureCall("host-derived-extra", { type: "quality-score", record: hostDerivedScore }),
      ],
      authorizedToolCallIds: ["host-derived-extra"],
    });
    const hostRefusal = session.capability.receipt("host-derived-extra");
    expect(hostRefusal.status).toBe("refused");
    expect(hostRefusal.code).toBe("evaluation-schema-additional-properties");
    expect(hostRefusal.location).toBe("$.record");
    expect(hostRefusal.feedback).toContain(
      'Remove undeclared properties from record at "$.record".',
    );
    expect(hostRefusal.feedback).toContain(
      'Allowed properties at this location: ["rubric","scores","hard_gates","decision","confidence","rationale"].',
    );
    expect(hostRefusal.feedback).not.toContain('"total"');
    expect(hostRefusal.feedback).not.toContain(hostMarker);
    await session.capability.settle({
      batchId: "host-derived-extra-property",
      toolCallIds: ["host-derived-extra"],
      authorizedToolCallIds: ["host-derived-extra"],
      successfulToolCallIds: [],
    });
    const afterRefusals = await session.snapshotIndex();
    expect(afterRefusals?.rows).toEqual(priorSnapshot?.rows);
    expect(afterRefusals?.rows.some((row) => row.type === "quality-score")).toBe(false);

    await session.capability.prepareBatch({
      batchId: "corrected-quality-score",
      toolCalls: [
        fixtureCall("corrected-score", {
          type: "quality-score",
          record: recordShape("quality-score"),
        }),
      ],
      authorizedToolCallIds: ["corrected-score"],
    });
    expect(session.capability.receipt("corrected-score")).toMatchObject({
      status: "admitted",
      complete: true,
    });
    await session.capability.settle({
      batchId: "corrected-quality-score",
      toolCallIds: ["corrected-score"],
      authorizedToolCallIds: ["corrected-score"],
      successfulToolCallIds: ["corrected-score"],
    });
    expect((await session.finish("")).qualityScore).toBeDefined();
  });

  it("explains target-path narrowing refusals without echoing rejected paths", async () => {
    const catalogFixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/model-output/answer-record/target-path-outside.json", import.meta.url),
        "utf8",
      ),
    ) as {
      code: string;
      location: string;
      input: { contract: string; allowedTargetPaths: string[] };
      reply: string;
    };
    expect(catalogFixture.input).toEqual({
      contract: "quality-evaluation",
      allowedTargetPaths: ["docs/page.md"],
    });
    const submitted = JSON.parse(catalogFixture.reply) as {
      type: string;
      record: { documentation_family_evidence: Array<{ paths: string[] }> };
    };
    expect(submitted.type).toBe("target-judgment");
    const rejectedPath = submitted.record.documentation_family_evidence[0]!.paths[0]!;
    expect(catalogFixture.input.allowedTargetPaths).not.toContain(rejectedPath);
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(
      validateRecords,
      undefined,
      undefined,
      undefined,
      {},
      ["layer-one"],
      { nonExhaustingRefusals: true },
    );
    await session.capability.prepareBatch({
      batchId: "target-path-outside",
      toolCalls: [call("target-path-outside", catalogFixture.reply)],
      authorizedToolCallIds: ["target-path-outside"],
    });
    const refusal = session.capability.receipt("target-path-outside");
    expect(refusal).toMatchObject({
      status: "refused",
      code: catalogFixture.code,
      location: catalogFixture.location,
    });
    expect(validateRecords).not.toHaveBeenCalled();
    expect(refusal.feedback).toContain("complete replacement record");
    expect(refusal.feedback).toContain('"docs/page.md"');
    expect(refusal.feedback).not.toContain(rejectedPath);
    await session.capability.settle({
      batchId: "target-path-outside",
      toolCallIds: ["target-path-outside"],
      authorizedToolCallIds: ["target-path-outside"],
      successfulToolCallIds: [],
    });
    expect((await session.latestCheckpoint())?.record.refusalDiagnostics).toContainEqual({
      code: "answer-record-target-path",
      location: "$.record",
      count: 1,
    });

    await session.capability.prepareBatch({
      batchId: "target-path-corrected",
      toolCalls: [
        fixtureCall("target-path-corrected", {
          type: "target-judgment",
          key: "singleton",
          record: recordShape("target-judgment"),
        }),
      ],
      authorizedToolCallIds: ["target-path-corrected"],
    });
    expect(session.capability.receipt("target-path-corrected").status).toBe("admitted");
    expect(validateRecords).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "required-dimension applicability",
      type: "dimension",
      key: "dimension-one",
      shapeIndex: 0,
      location: "$.record.assessment",
      rejected: "not-applicable",
      update: (record: Record<string, unknown>) => {
        record.assessment = "not-applicable";
      },
      guidance: 'Required dimensions cannot use assessment "not-applicable"',
    },
    {
      label: "confidence anchors",
      type: "dimension",
      key: "dimension-one",
      shapeIndex: 0,
      location: "$.record.confidence",
      rejected: 0.625,
      update: (record: Record<string, unknown>) => {
        record.confidence = 0.625;
      },
      guidance: "host-provided confidence anchors",
    },
    {
      label: "hard-gate IDs",
      type: "dimension",
      key: "dimension-one",
      shapeIndex: 0,
      location: "$.record.hard_gate_failures",
      rejected: "private-rejected-gate-marker",
      update: (record: Record<string, unknown>) => {
        record.hard_gate_failures = ["private-rejected-gate-marker"];
      },
      guidance: "host-provided hard-gate IDs",
    },
    {
      label: "D3 residual decisions",
      type: "layer-note",
      key: "layer-one",
      shapeIndex: 0,
      location: "$.record.layer_shortfall_decision",
      rejected: "human-review",
      update: (record: Record<string, unknown>) => {
        record.layer_shortfall_decision = "human-review";
      },
      guidance: "host-provided D3 residual decisions",
    },
    {
      label: "finding dimension IDs",
      type: "finding",
      key: "finding-one",
      shapeIndex: 0,
      location: "$.record.dimension_id",
      rejected: "private-rejected-dimension-marker",
      update: (record: Record<string, unknown>) => {
        record.dimension_id = "private-rejected-dimension-marker";
      },
      guidance: "host-resolved answer-record plan",
    },
    {
      label: "finding source IDs",
      type: "finding",
      key: "finding-one",
      shapeIndex: 0,
      location: "$.record.originating_ids",
      rejected: "private-rejected-source-marker",
      update: (record: Record<string, unknown>) => {
        record.originating_ids = ["private-rejected-source-marker"];
      },
      guidance: "host-provided source IDs",
    },
  ])(
    "returns actionable field feedback for $label narrowing refusals without echoing rejected values",
    async ({ label, type, key, shapeIndex, location, rejected, update, guidance }) => {
      const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
        records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
      );
      const session = await makeAdmission(
        validateRecords,
        undefined,
        undefined,
        undefined,
        {},
        ["layer-one"],
        {
          nonExhaustingRefusals: true,
          referenceIds: {
            "technical-fact": ["FACT-1"],
            "technical-issue": ["ISSUE-1"],
            "review-issue": ["REVIEW-1"],
          },
        },
      );
      const record = recordShape(type, shapeIndex);
      if (type === "finding") record.dimension_id = "dimension-one";
      update(record);
      const toolCallId = `narrowing-${type}-${location}`;
      const toolCall =
        type === "finding"
          ? call(toolCallId, JSON.stringify({ type, record }))
          : fixtureCall(toolCallId, { type, key, record });
      await session.capability.prepareBatch({
        batchId: toolCallId,
        toolCalls: [toolCall],
        authorizedToolCallIds: [toolCallId],
      });

      const receipt = session.capability.receipt(toolCallId);
      expect(receipt).toMatchObject({
        status: "refused",
        code: "answer-record-shape",
        location,
      });
      expect(receipt.feedback).toContain("complete replacement record");
      expect(receipt.feedback).toContain(guidance);
      if (label === "required-dimension applicability") {
        expect(receipt.feedback).toContain('use "not-assessed"');
        expect(receipt.feedback).toContain("existing rationale");
        expect(receipt.feedback).toContain("empty array when there are none");
        expect(receipt.feedback).not.toContain("evidence_strength");
        expect(receipt.feedback).not.toContain("state a limitation");
      }
      if (typeof rejected === "string" && rejected.startsWith("private-")) {
        expect(receipt.feedback).not.toContain(rejected);
      }
      expect(validateRecords).not.toHaveBeenCalled();
    },
  );

  it("corrects a required-dimension applicability refusal using only existing record fields", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(
      validateRecords,
      undefined,
      undefined,
      undefined,
      {},
      ["layer-one"],
      { nonExhaustingRefusals: true },
    );

    const retained = call("retained-note");
    await session.capability.prepareBatch({
      batchId: "retained-note-batch",
      toolCalls: [retained],
      authorizedToolCallIds: [retained.toolCallId],
    });
    await session.capability.settle({
      batchId: "retained-note-batch",
      toolCallIds: [retained.toolCallId],
      authorizedToolCallIds: [retained.toolCallId],
      successfulToolCallIds: [retained.toolCallId],
    });
    const retainedIndex = await session.snapshotIndex();
    const retainedRecordSha256 = retainedIndex?.rows[0]?.recordSha256;
    expect(retainedRecordSha256).toMatch(/^[a-f0-9]{64}$/u);

    const rejected = recordShape("dimension");
    const privateMarker = "private-required-dimension-evidence-marker";
    rejected.assessment = "not-applicable";
    rejected.rationale = privateMarker;
    rejected.evidence = [];
    await session.capability.prepareBatch({
      batchId: "required-dimension-refusal",
      toolCalls: [
        fixtureCall("required-dimension-refusal", {
          type: "dimension",
          key: "dimension-one",
          record: rejected,
        }),
      ],
      authorizedToolCallIds: ["required-dimension-refusal"],
    });
    const refusal = session.capability.receipt("required-dimension-refusal");
    expect(refusal).toMatchObject({
      status: "refused",
      code: "answer-record-shape",
      location: "$.record.assessment",
    });
    expect(refusal.feedback).toContain('use "not-assessed"');
    expect(refusal.feedback).toContain("existing rationale");
    expect(refusal.feedback).not.toContain(privateMarker);
    await session.capability.settle({
      batchId: "required-dimension-refusal",
      toolCallIds: ["required-dimension-refusal"],
      authorizedToolCallIds: ["required-dimension-refusal"],
      successfulToolCallIds: [],
    });

    const corrected = recordShape("dimension");
    corrected.assessment = "not-assessed";
    corrected.rationale = "Evidence was insufficient to assess this required dimension.";
    corrected.evidence = [];
    await session.capability.prepareBatch({
      batchId: "required-dimension-correction",
      toolCalls: [
        fixtureCall("required-dimension-correction", {
          type: "dimension",
          key: "dimension-one",
          record: corrected,
        }),
      ],
      authorizedToolCallIds: ["required-dimension-correction"],
    });
    expect(session.capability.receipt("required-dimension-correction").status).toBe("admitted");
    await session.capability.settle({
      batchId: "required-dimension-correction",
      toolCallIds: ["required-dimension-correction"],
      authorizedToolCallIds: ["required-dimension-correction"],
      successfulToolCallIds: ["required-dimension-correction"],
    });

    const checkpoint = await session.latestCheckpoint();
    expect(checkpoint?.record.rows.map(({ key }) => key)).toEqual(["singleton", "dimension-one"]);
    const index = await session.snapshotIndex();
    const retainedAfterCorrection = index?.rows.find((row) => row.key === "singleton");
    const correctedIndexRow = index?.rows.find((row) => row.key === "dimension-one");
    expect(retainedAfterCorrection?.recordSha256).toBe(retainedRecordSha256);
    expect(correctedIndexRow?.recordSha256).toMatch(/^[a-f0-9]{64}$/u);
    const storedCorrection = await session.store.getRecord(correctedIndexRow!.recordSha256);
    expect(opaqueRecordDigest(storedCorrection)).toBe(correctedIndexRow!.recordSha256);
    expect(storedCorrection).toMatchObject({
      kind: "docsfab-answer-record",
      type: "dimension",
      key: "dimension-one",
      payloadSha256: canonicalDigest(corrected),
      payload: corrected,
    });
    expect(
      validateRecords.mock.calls
        .flatMap(([records]) => records)
        .find(({ toolCallId }) => toolCallId === "required-dimension-correction"),
    ).toMatchObject({
      type: "dimension",
      key: "dimension-one",
      record: {
        assessment: "not-assessed",
        rationale: corrected.rationale,
        evidence: [],
      },
    });
    expect(checkpoint?.record.refusalDiagnostics).toContainEqual({
      code: "answer-record-shape",
      location: "$.record.assessment",
      count: 1,
    });
    expect(JSON.stringify(checkpoint)).not.toContain(privateMarker);
  });

  it("keeps admitted progress when a narrowed record is corrected", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(
      validateRecords,
      undefined,
      undefined,
      undefined,
      {},
      ["layer-one"],
      { nonExhaustingRefusals: true },
    );
    const retained = call("retained-note");
    await session.capability.prepareBatch({
      batchId: "retained-note-batch",
      toolCalls: [retained],
      authorizedToolCallIds: [retained.toolCallId],
    });
    expect(session.capability.receipt(retained.toolCallId).status).toBe("admitted");
    await session.capability.settle({
      batchId: "retained-note-batch",
      toolCallIds: [retained.toolCallId],
      authorizedToolCallIds: [retained.toolCallId],
      successfulToolCallIds: [retained.toolCallId],
    });

    const rejected = recordShape("dimension");
    rejected.confidence = 0.625;
    const invalidId = "invalid-confidence";
    await session.capability.prepareBatch({
      batchId: "invalid-confidence-batch",
      toolCalls: [
        fixtureCall(invalidId, { type: "dimension", key: "dimension-one", record: rejected }),
      ],
      authorizedToolCallIds: [invalidId],
    });
    expect(session.capability.receipt(invalidId)).toMatchObject({
      status: "refused",
      location: "$.record.confidence",
    });
    await session.capability.settle({
      batchId: "invalid-confidence-batch",
      toolCallIds: [invalidId],
      authorizedToolCallIds: [invalidId],
      successfulToolCallIds: [],
    });

    const corrected = recordShape("dimension");
    corrected.confidence = 0.5;
    const correctedId = "corrected-confidence";
    await session.capability.prepareBatch({
      batchId: "corrected-confidence-batch",
      toolCalls: [
        fixtureCall(correctedId, { type: "dimension", key: "dimension-one", record: corrected }),
      ],
      authorizedToolCallIds: [correctedId],
    });
    expect(session.capability.receipt(correctedId).status).toBe("admitted");
    await session.capability.settle({
      batchId: "corrected-confidence-batch",
      toolCallIds: [correctedId],
      authorizedToolCallIds: [correctedId],
      successfulToolCallIds: [correctedId],
    });

    const checkpoint = await session.latestCheckpoint();
    expect(checkpoint?.record.rows).toHaveLength(2);
    expect(checkpoint?.record.rows.map(({ key }) => key)).toEqual(["singleton", "dimension-one"]);
    expect(checkpoint?.record.refusalDiagnostics).toContainEqual({
      code: "answer-record-shape",
      location: "$.record.confidence",
      count: 1,
    });
  });

  it("screens credential-bearing raw bytes before the canonical batch validator or durable store", async () => {
    const marker = `quality-record-secret-${Date.now()}-unique`;
    registerConfiguredCredential(marker, "quality answer record admission test");
    const validateRecords = vi.fn(async () => []);
    const session = await makeAdmission(validateRecords);
    await session.capability.prepareBatch({
      batchId: "batch-1",
      toolCalls: [call("call-1", `{"type":"unknown","record":"${marker}"}`)],
      authorizedToolCallIds: ["call-1"],
    });
    expect(session.capability.receipt("call-1").status).toBe("refused");
    expect(validateRecords).not.toHaveBeenCalled();
    await session.capability.settle({
      batchId: "batch-1",
      toolCallIds: ["call-1"],
      authorizedToolCallIds: ["call-1"],
      successfulToolCallIds: [],
    });
    expect(await session.snapshotIndex()).toBeUndefined();
    expect(await readdir(join(storeRoots[0]!, "objects", "sha256"))).toEqual([]);
  });

  it("screens a credential revealed only by JSON decoding before validator or store effects", async () => {
    const marker = `quality-record-decoded-secret-${Date.now()}-unique`;
    registerConfiguredCredential(marker, "quality answer record decoded-secret test");
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const finding = (description: string) => ({
      ...recordShape("finding"),
      severity: "minor",
      dimension_id: "dimension-one",
      description,
      evidence: [
        {
          evidence_class: "deterministic-conformance",
          strength: "direct",
          locator: "docs/page.md",
          description: "A directly observed condition",
        },
      ],
      acceptance_condition: "The observed condition is fixed",
    });

    // The same record shape without the credential reaches canonical validation.
    const controlValidator = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const control = await makeAdmission(controlValidator);
    await control.capability.prepareBatch({
      batchId: "decoded-secret-control",
      toolCalls: [
        call(
          "decoded-secret-control-call",
          JSON.stringify({ type: "finding", record: finding("Evidence without credentials") }),
        ),
      ],
      authorizedToolCallIds: ["decoded-secret-control-call"],
    });
    expect(control.capability.receipt("decoded-secret-control-call").status).toBe("admitted");
    expect(controlValidator).toHaveBeenCalledTimes(1);

    const session = await makeAdmission(validateRecords);
    const escapedMarker = Array.from(
      marker,
      (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    ).join("");
    const raw = JSON.stringify({
      type: "finding",
      record: finding(`Evidence contains ${marker}`),
    }).replace(marker, escapedMarker);
    expect(raw).not.toContain(marker);
    expect(JSON.parse(raw).record.description).toContain(marker);

    await session.capability.prepareBatch({
      batchId: "decoded-secret-batch",
      toolCalls: [call("decoded-secret-call", raw)],
      authorizedToolCallIds: ["decoded-secret-call"],
    });
    const receipt = session.capability.receipt("decoded-secret-call");
    expect(receipt).toMatchObject({
      status: "refused",
      code: "answer-record-shape",
      location: "$.record",
      retry: "terminal",
    });
    expect(validateRecords).not.toHaveBeenCalled();
    await session.capability.settle({
      batchId: "decoded-secret-batch",
      toolCallIds: ["decoded-secret-call"],
      authorizedToolCallIds: ["decoded-secret-call"],
      successfulToolCallIds: [],
    });
    expect(await session.snapshotIndex()).toBeUndefined();
    expect(await readdir(join(storeRoots.at(-1)!, "objects", "sha256"))).toEqual([]);
  });

  it("accepts trusted lazy host-minted providers without eagerly evaluating them", async () => {
    const provider = vi.fn((field: string) => ({ field }));
    const validateRecords = vi.fn(async () => []);
    const session = await makeAdmission(validateRecords, { "host.clock": provider });
    expect(session.capability).toBeDefined();
    expect(session.promptGuidance).toContain("one record per call; multiple calls per turn");
    expect(session.promptGuidance).toContain('"findings_complete"');
    expect(session.promptGuidance).toContain("Required dimensions: dimension-one.");
    expect(session.promptGuidance).toContain("final report as Markdown only");
    expect(session.promptGuidance).not.toContain("JSON envelope");
    expect(provider).not.toHaveBeenCalled();
  });

  it("uses wire keys in singleton guidance and accepts only the declared singleton key form", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const session = await makeAdmission(validateRecords);
    expect(session.promptGuidance).toContain("singleton; omit the key field or use key null");
    expect(session.promptGuidance).toContain('"key":null');
    expect(session.promptGuidance).toContain('"key":"dimension-one"');
    expect(session.promptGuidance).toContain(
      "new records use key null; use a returned key to replace or withdraw an issued record",
    );

    const singletonCall = call(
      "singleton-null-key",
      JSON.stringify({
        type: "evaluation-note",
        key: null,
        record: { findings_complete: true },
      }),
    );
    expect(decodeAnswerRecordCall(session.plan, singletonCall.rawArguments)).toEqual({
      call: {
        type: "evaluation-note",
        key: null,
        record: { findings_complete: true },
        rawBytes: Buffer.byteLength(singletonCall.rawArguments ?? "", "utf8"),
      },
    });
    await session.capability.prepareBatch({
      batchId: "singleton-null-key-batch",
      toolCalls: [singletonCall],
      authorizedToolCallIds: ["singleton-null-key"],
    });
    expect(session.capability.receipt("singleton-null-key").status).toBe("admitted");

    const legacySentinel = JSON.stringify({
      type: "evaluation-note",
      key: "singleton",
      record: { findings_complete: true },
    });
    expect(decodeAnswerRecordCall(session.plan, legacySentinel)).toMatchObject({
      refusal: { code: "answer-record-key", location: "$.key" },
    });
    const refusingSession = await makeAdmission(validateRecords);
    await refusingSession.capability.prepareBatch({
      batchId: "singleton-sentinel-batch",
      toolCalls: [call("singleton-sentinel", legacySentinel)],
      authorizedToolCallIds: ["singleton-sentinel"],
    });
    expect(refusingSession.capability.receipt("singleton-sentinel")).toMatchObject({
      status: "refused",
      code: "answer-record-key",
      location: "$.key",
    });
  });

  it("echoes quality singleton receipt keys as null and accepts the corrected replacement", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const session = await makeAdmission(validateRecords);
    const firstId = "singleton-wire-first";
    await session.capability.prepareBatch({
      batchId: firstId,
      toolCalls: [
        call(
          firstId,
          JSON.stringify({
            type: "evaluation-note",
            key: null,
            record: { findings_complete: true, limitations: ["First note."] },
          }),
        ),
      ],
      authorizedToolCallIds: [firstId],
    });
    expect(session.capability.receipt(firstId)).toMatchObject({
      status: "admitted",
      type: "evaluation-note",
      key: "singleton",
    });
    const tool = createQualityAnswerRecordTool(session.capability, session.promptGuidance);
    const firstResult = await tool.execute(firstId, {}, undefined, undefined, undefined as never);
    const firstReceipt = JSON.parse((firstResult.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(firstReceipt).toMatchObject({
      status: "admitted",
      type: "evaluation-note",
      key: null,
    });
    await session.capability.settle({
      batchId: firstId,
      toolCallIds: [firstId],
      authorizedToolCallIds: [firstId],
      successfulToolCallIds: [firstId],
    });

    const replacementId = "singleton-wire-replacement";
    const replacementRaw = JSON.stringify({
      type: firstReceipt.type,
      key: firstReceipt.key,
      record: { findings_complete: true, limitations: ["Corrected note."] },
    });
    expect(decodeAnswerRecordCall(session.plan, replacementRaw)).toMatchObject({
      call: { type: "evaluation-note", key: null },
    });
    await session.capability.prepareBatch({
      batchId: replacementId,
      toolCalls: [{ toolCallId: replacementId, rawArguments: replacementRaw }],
      authorizedToolCallIds: [replacementId],
    });
    expect(session.capability.receipt(replacementId)).toMatchObject({
      status: "replaced",
      type: "evaluation-note",
      key: "singleton",
    });
    const replacementResult = await tool.execute(
      replacementId,
      {},
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.parse((replacementResult.content[0] as { text: string }).text)).toMatchObject({
      status: "replaced",
      type: "evaluation-note",
      key: null,
    });
  });

  it("refuses model-authored reserved host evidence providers before validation or persistence", async () => {
    for (const providerId of [
      "docsfab-host-fact-render",
      "docsfab-host-issue-render",
      "docsfab-host-locator-carry",
    ]) {
      const baseFinding = recordShape("finding");
      const baseEvidence = Array.isArray(baseFinding.evidence) ? baseFinding.evidence : [];
      if (baseEvidence.length === 0) {
        baseEvidence.push({
          evidence_class: "deterministic-conformance",
          strength: "direct",
          locator: "docs/page.md",
          description: "A directly observed condition",
        });
      }
      baseFinding.dimension_id = "dimension-one";
      baseFinding.evidence = baseEvidence;
      const controlValidator = vi.fn<ValidateAnswerRecords>(async (records) =>
        records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
      );
      const control = await makeAdmission(controlValidator);
      await control.capability.prepareBatch({
        batchId: `host-provider-control-${providerId}`,
        toolCalls: [call("control", JSON.stringify({ type: "finding", record: baseFinding }))],
        authorizedToolCallIds: ["control"],
      });
      expect(
        control.capability.receipt("control").status,
        `control receipt: ${receiptSummary(control.capability.receipt("control"))}`,
      ).toBe("admitted");

      const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
        records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
      );
      const session = await makeAdmission(validateRecords);
      const finding = structuredClone(baseFinding);
      const evidence = finding.evidence as Record<string, unknown>[];
      (evidence[0] as Record<string, unknown>).provider_id = providerId;
      finding.evidence = evidence;
      const spoof = JSON.stringify({ type: "finding", record: finding });
      await session.capability.prepareBatch({
        batchId: `host-provider-spoof-${providerId}`,
        toolCalls: [call("spoof", spoof)],
        authorizedToolCallIds: ["spoof"],
      });
      const receipt = session.capability.receipt("spoof");
      expect(receipt.status).toBe("refused");
      expect(
        receipt.code === "evaluation-profile-semantics" ||
          receipt.code?.startsWith("evaluation-schema-") === true,
        `reserved provider receipt: ${JSON.stringify({
          code: receipt.code,
          location: receipt.location,
          retry: receipt.retry,
        })}`,
      ).toBe(true);
      expect(validateRecords).not.toHaveBeenCalled();
      await session.capability.settle({
        batchId: `host-provider-spoof-${providerId}`,
        toolCallIds: ["spoof"],
        authorizedToolCallIds: ["spoof"],
        successfulToolCallIds: [],
      });
      expect(await session.snapshotIndex()).toMatchObject({
        rows: [],
        progress: { refusalEventCount: 1 },
      });
      expect(await readdir(join(storeRoots.at(-1)!, "objects", "sha256"))).toHaveLength(1);
    }
  });

  it("withdraws issued open-set records and removes their durable index entry", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(validateRecords);
    const finding = JSON.stringify({
      type: "finding",
      record: {
        severity: "minor",
        dimension_id: "dimension-one",
        description: "Observed issue",
        evidence: [
          {
            evidence_class: "deterministic-conformance",
            strength: "direct",
            locator: "docs/page.md",
            description: "A directly observed condition",
          },
        ],
        acceptance_condition: "The observed condition is fixed",
      },
    });
    await session.capability.prepareBatch({
      batchId: "finding-1",
      toolCalls: [call("add", finding)],
      authorizedToolCallIds: ["add"],
    });
    const issuedKey = session.capability.receipt("add").key!;
    await session.capability.settle({
      batchId: "finding-1",
      toolCallIds: ["add"],
      authorizedToolCallIds: ["add"],
      successfulToolCallIds: ["add"],
    });
    expect((await session.snapshotIndex())?.rows).toContainEqual(
      expect.objectContaining({ type: "finding", key: issuedKey }),
    );

    const withdrawal = JSON.stringify({ type: "finding", key: issuedKey, record: null });
    await session.capability.prepareBatch({
      batchId: "finding-withdrawal",
      toolCalls: [call("withdraw", withdrawal)],
      authorizedToolCallIds: ["withdraw"],
    });
    expect(session.capability.receipt("withdraw").status).toBe("withdrawn");
    await settleForDiagnostic(session.capability, {
      batchId: "finding-withdrawal",
      toolCallIds: ["withdraw"],
      authorizedToolCallIds: ["withdraw"],
      successfulToolCallIds: ["withdraw"],
    });
    expect((await session.snapshotIndex())?.rows ?? []).not.toContainEqual(
      expect.objectContaining({ type: "finding", key: issuedKey }),
    );

    await session.capability.prepareBatch({
      batchId: "finding-withdrawal-repeat",
      toolCalls: [call("withdraw-again", withdrawal)],
      authorizedToolCallIds: ["withdraw-again"],
    });
    expect(session.capability.receipt("withdraw-again").status).toBe("unchanged");
    await settleForDiagnostic(session.capability, {
      batchId: "finding-withdrawal-repeat",
      toolCallIds: ["withdraw-again"],
      authorizedToolCallIds: ["withdraw-again"],
      successfulToolCallIds: ["withdraw-again"],
    });
    expect(await session.snapshotIndex()).toMatchObject({
      rows: [],
      progress: { admittedRowCount: 0 },
    });
    expect(validateRecords).toHaveBeenCalledTimes(1);
  });

  it("restores an empty checkpoint across attempts without recycling a withdrawn key", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const first = await makeAdmission(validateRecords);
    const finding = (description: string) =>
      JSON.stringify({
        type: "finding",
        record: {
          severity: "minor",
          dimension_id: "dimension-one",
          description,
          evidence: [
            {
              evidence_class: "deterministic-conformance",
              strength: "direct",
              locator: "docs/page.md",
              description: "A directly observed condition",
            },
          ],
          acceptance_condition: "The observed condition is fixed",
        },
      });
    await first.capability.prepareBatch({
      batchId: "attempt-one-add",
      toolCalls: [call("attempt-one-call", finding("First"))],
      authorizedToolCallIds: ["attempt-one-call"],
    });
    const issuedKey = first.capability.receipt("attempt-one-call").key!;
    await first.capability.settle({
      batchId: "attempt-one-add",
      toolCallIds: ["attempt-one-call"],
      authorizedToolCallIds: ["attempt-one-call"],
      successfulToolCallIds: ["attempt-one-call"],
    });
    await first.capability.prepareBatch({
      batchId: "attempt-one-withdraw",
      toolCalls: [
        call(
          "attempt-one-withdraw-call",
          JSON.stringify({ type: "finding", key: issuedKey, record: null }),
        ),
      ],
      authorizedToolCallIds: ["attempt-one-withdraw-call"],
    });
    await first.capability.settle({
      batchId: "attempt-one-withdraw",
      toolCallIds: ["attempt-one-withdraw-call"],
      authorizedToolCallIds: ["attempt-one-withdraw-call"],
      successfulToolCallIds: ["attempt-one-withdraw-call"],
    });
    const checkpoint = await first.latestCheckpoint();
    expect(checkpoint?.record.rows).toEqual([]);
    expect(checkpoint?.record.issuedKeyHighWater.finding).toBe(1);
    expect(checkpoint?.record.tombstones).toContainEqual(
      expect.objectContaining({ type: "finding", key: issuedKey, reasonCode: "withdrawn" }),
    );

    const malformedTombstone = await resealCheckpoint(first, checkpoint!, (record) => {
      const tombstones = record.tombstones as Array<Record<string, unknown>>;
      tombstones[0] = { ...tombstones[0], key: "\u0000new" };
    });
    await expect(
      makeAdmission(validateRecords, {} as never, undefined, undefined, {}, ["layer-one"], {
        attempt: 2,
        store: first.store,
        restoreCheckpoint: malformedTombstone,
      }),
    ).rejects.toMatchObject({
      rejection: { code: "candidate-staging-integrity-failed" },
      message: expect.stringContaining("host reason: checkpoint-shape"),
    });

    const second = await makeAdmission(
      validateRecords,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      {
        attempt: 2,
        store: first.store,
        restoreCheckpoint: checkpoint,
      },
    );
    expect(await second.snapshotIndex()).toMatchObject({ rows: [], checkpoint: { sequence: 2 } });
    await second.capability.prepareBatch({
      batchId: "attempt-two-add",
      toolCalls: [call("attempt-two-call", finding("Second"))],
      authorizedToolCallIds: ["attempt-two-call"],
    });
    expect(second.capability.receipt("attempt-two-call").key).toBe("F-2");
  });

  it("round-trips explicit zero high-water marks for untouched open sets", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const first = await makeAdmission(validateRecords);
    await first.capability.prepareBatch({
      batchId: "checkpoint-without-findings",
      toolCalls: [
        fixtureCall("checkpoint-dimension", {
          type: "dimension",
          key: "dimension-one",
          record: recordShape("dimension", 0),
        }),
      ],
      authorizedToolCallIds: ["checkpoint-dimension"],
    });
    await first.capability.settle({
      batchId: "checkpoint-without-findings",
      toolCallIds: ["checkpoint-dimension"],
      authorizedToolCallIds: ["checkpoint-dimension"],
      successfulToolCallIds: ["checkpoint-dimension"],
    });

    const checkpoint = await first.latestCheckpoint();
    expect(checkpoint?.record.issuedKeyHighWater.finding).toBe(0);
    const restored = await makeAdmission(
      validateRecords,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      { attempt: 2, store: first.store, restoreCheckpoint: checkpoint },
    );
    expect(await restored.snapshotIndex()).toMatchObject({
      rows: [expect.objectContaining({ type: "dimension", key: "dimension-one" })],
      checkpoint: { sequence: 1 },
    });
  });

  it("keeps the previous checkpoint authoritative when pointer publication fails", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    let failPublication = false;
    const first = await makeAdmission(
      validateRecords,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      {
        onCheckpoint: async () => {
          if (failPublication) throw new Error("injected pointer publication failure");
        },
      },
    );
    const makeFinding = (description: string) =>
      JSON.stringify({
        type: "finding",
        record: {
          severity: "minor",
          dimension_id: "dimension-one",
          description,
          evidence: [
            {
              evidence_class: "deterministic-conformance",
              strength: "direct",
              locator: "docs/page.md",
              description: "A directly observed condition",
            },
          ],
          acceptance_condition: "The observed condition is fixed",
        },
      });
    const add = async (batchId: string, description: string) => {
      await first.capability.prepareBatch({
        batchId,
        toolCalls: [call(`${batchId}-call`, makeFinding(description))],
        authorizedToolCallIds: [`${batchId}-call`],
      });
      await first.capability.settle({
        batchId,
        toolCallIds: [`${batchId}-call`],
        authorizedToolCallIds: [`${batchId}-call`],
        successfulToolCallIds: [`${batchId}-call`],
      });
    };
    await add("committed-row", "Committed row");
    const committed = await first.latestCheckpoint();
    expect(committed).toBeDefined();
    const committedIndex = await first.snapshotIndex();
    failPublication = true;
    await expect(add("orphan-row", "Unpublished replacement")).rejects.toThrow(
      "injected pointer publication failure",
    );
    expect(await first.latestCheckpoint()).toEqual(committed);
    expect(await first.snapshotIndex()).toEqual(committedIndex);

    const resumed = await makeAdmission(
      validateRecords,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      {
        attempt: 2,
        store: first.store,
        restoreCheckpoint: committed,
      },
    );
    const replay = await resumed.replayState();
    expect(replay.pairs).toHaveLength(1);
    expect(replay.pairs[0]?.record).toMatchObject({ description: "Committed row" });
    expect(await resumed.snapshotIndex()).toMatchObject({
      checkpoint: { sha256: committed?.sha256, sequence: 1 },
      rows: [{ key: "F-1", attempt: 1 }],
    });
  });

  it.each([
    ["profile", { profilePayloadSha256: "9".repeat(64) }],
    ["composition", { compositionSha256: "9".repeat(64) }],
    ["answer capability", { answerPathCapabilitySha256: "9".repeat(64) }],
  ] as const)(
    "starts a fresh ledger for an authentic checkpoint with a stale %s binding",
    async (_label, staleBinding) => {
      const validateRecords: ValidateAnswerRecords = async (records) =>
        records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
      const first = await makeAdmission(validateRecords);
      const dimension = requiredFixtureRecords().find((entry) => entry.type === "dimension")!;
      await first.capability.prepareBatch({
        batchId: "stale-profile-source",
        toolCalls: [fixtureCall("stale-profile-row", dimension)],
        authorizedToolCallIds: ["stale-profile-row"],
      });
      await first.capability.settle({
        batchId: "stale-profile-source",
        toolCallIds: ["stale-profile-row"],
        authorizedToolCallIds: ["stale-profile-row"],
        successfulToolCallIds: ["stale-profile-row"],
      });
      const checkpoint = await first.latestCheckpoint();
      expect(checkpoint?.record.rows).toHaveLength(1);

      const retried = await makeAdmission(
        validateRecords,
        {} as never,
        undefined,
        undefined,
        {},
        ["layer-one"],
        {
          attempt: 2,
          ...staleBinding,
          store: first.store,
          restoreCheckpoint: checkpoint,
        },
      );
      expect(retried.checkpointWasStale()).toBe(true);
      expect(await retried.latestCheckpoint()).toBeUndefined();
      expect(await retried.snapshotIndex()).toBeUndefined();
      const replay = await retried.replayState();
      expect(replay.pairs).toEqual([]);
      expect(replay.complete).toBe(false);
      expect(replay.remainingKeys).toContain("dimension:dimension-one");
    },
  );

  it("rebuilds exact replay shells for keyed rows and nullable singletons", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const session = await makeCompleteAdmission(
      validateRecords,
      async () => ({ status: "valid" }),
      false,
    );
    const dimension = requiredFixtureRecords().find((entry) => entry.type === "dimension")!;
    await session.capability.prepareBatch({
      batchId: "replay-shells",
      toolCalls: [
        fixtureCall("replay-keyed", dimension),
        call("replay-singleton-null", JSON.stringify({ type: "quality-score", record: "null" })),
      ],
      authorizedToolCallIds: ["replay-keyed", "replay-singleton-null"],
    });
    await session.capability.settle({
      batchId: "replay-shells",
      toolCallIds: ["replay-keyed", "replay-singleton-null"],
      authorizedToolCallIds: ["replay-keyed", "replay-singleton-null"],
      successfulToolCallIds: ["replay-keyed", "replay-singleton-null"],
    });

    const replay = await session.replayState();
    expect(replay.pairs.find((pair) => pair.type === "dimension")?.toolArguments).toEqual({
      type: "dimension",
      key: "dimension-one",
      record: dimension.record,
    });
    expect(replay.pairs.find((pair) => pair.type === "quality-score")?.toolArguments).toEqual({
      type: "quality-score",
      record: "null",
    });
  });

  it("enforces the open-set bound on same-session durable reload after withdrawal and key reintroduction", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(validateRecords, undefined, undefined, undefined, {
      "answerRecords.maxOpenRecordsPerSet": 2,
    });
    const finding = (description: string) => ({
      ...recordShape("finding"),
      severity: "minor",
      dimension_id: "dimension-one",
      description,
      evidence: [
        {
          evidence_class: "deterministic-conformance",
          strength: "direct",
          locator: "docs/page.md",
          description: "A directly observed condition",
        },
      ],
      acceptance_condition: "The observed condition is fixed",
    });
    const add = async (
      batchId: string,
      toolCallId: string,
      key: string | undefined,
      record: unknown,
    ) => {
      const raw = JSON.stringify({
        type: "finding",
        ...(key ? { key } : {}),
        record,
      });
      await session.capability.prepareBatch({
        batchId,
        toolCalls: [call(toolCallId, raw)],
        authorizedToolCallIds: [toolCallId],
      });
      return raw;
    };
    const settleOne = async (batchId: string, toolCallId: string) =>
      session.capability.settle({
        batchId,
        toolCallIds: [toolCallId],
        authorizedToolCallIds: [toolCallId],
        successfulToolCallIds: [toolCallId],
      });

    await add("open-add-1", "add-1", undefined, finding("First finding"));
    const firstKey = session.capability.receipt("add-1").key!;
    await settleOne("open-add-1", "add-1");
    await add("open-add-2", "add-2", undefined, finding("Second finding"));
    const secondKey = session.capability.receipt("add-2").key!;
    await settleOne("open-add-2", "add-2");
    expect([firstKey, secondKey]).toEqual(["F-1", "F-2"]);
    expect((await session.snapshotIndex())?.rows.map((row) => row.key)).toEqual(["F-1", "F-2"]);

    const withdrawalBatch = "open-withdraw-1";
    await add(withdrawalBatch, "withdraw-1", firstKey, null);
    expect(session.capability.receipt("withdraw-1").status).toBe("withdrawn");
    await settleOne(withdrawalBatch, "withdraw-1");
    expect((await session.snapshotIndex())?.rows.map((row) => row.key)).toEqual(["F-2"]);

    await add("open-add-3", "add-3", undefined, finding("Third finding"));
    expect(session.capability.receipt("add-3")).toMatchObject({ status: "admitted", key: "F-3" });
    await settleOne("open-add-3", "add-3");
    expect((await session.snapshotIndex())?.rows.map((row) => row.key)).toEqual(["F-2", "F-3"]);

    await add("open-reintroduce-1", "reintroduce-1", firstKey, finding("Reintroduced finding"));
    expect(session.capability.receipt("reintroduce-1")).toMatchObject({
      status: "refused",
      code: "answer-record-open-set-bound",
      key: firstKey,
    });
    await session.capability.settle({
      batchId: "open-reintroduce-1",
      toolCallIds: ["reintroduce-1"],
      authorizedToolCallIds: ["reintroduce-1"],
      successfulToolCallIds: [],
    });
    expect((await session.snapshotIndex())?.rows.map((row) => row.key)).toEqual(["F-2", "F-3"]);
    // The reintroduced payload passes screening and the canonical batch check;
    // the reloaded ledger then refuses its open-set admission at the bound.
    expect(validateRecords).toHaveBeenCalledTimes(4);
  });

  it("charges an authorized policy refusal even when the tool result is an error", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({
        toolCallId,
        status: "refused" as const,
        code: "evaluation-profile-semantics" as const,
        location: "$.record",
      })),
    );
    const session = await makeAdmission(validateRecords);
    await session.capability.prepareBatch({
      batchId: "batch-1",
      toolCalls: [call("call-1")],
      authorizedToolCallIds: ["call-1"],
    });
    expect(session.capability.receipt("call-1")).toMatchObject({
      code: "evaluation-profile-semantics",
      status: "refused",
    });
    await session.capability.settle({
      batchId: "batch-1",
      toolCallIds: ["call-1"],
      authorizedToolCallIds: ["call-1"],
      successfulToolCallIds: [],
    });
    await session.capability.prepareBatch({
      batchId: "batch-2",
      toolCalls: [call("call-2")],
      authorizedToolCallIds: ["call-2"],
    });
    expect(session.capability.receipt("call-2")).toMatchObject({
      code: "answer-record-exhausted",
      status: "refused",
    });
    expect(validateRecords).toHaveBeenCalledTimes(2);
  });

  it("keeps discovery refusals correctable across checkpoint restore", async () => {
    const invalid = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({
        toolCallId,
        status: "refused" as const,
        code: "evaluation-profile-semantics" as const,
        location: "$.record",
      })),
    );
    const first = await makeAdmission(
      invalid,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      {
        nonExhaustingRefusals: true,
      },
    );
    for (const number of [1, 2, 3, 4]) {
      const callId = `bad-${number}`;
      const batchId = `bad-batch-${number}`;
      await first.capability.prepareBatch({
        batchId,
        toolCalls: [call(callId)],
        authorizedToolCallIds: [callId],
      });
      expect(first.capability.receipt(callId)).toMatchObject({
        status: "refused",
        code: "evaluation-profile-semantics",
        location: "$.record",
      });
      await first.capability.settle({
        batchId,
        toolCallIds: [callId],
        authorizedToolCallIds: [callId],
        successfulToolCallIds: [],
      });
    }
    const checkpoint = await first.latestCheckpoint();
    expect(checkpoint?.record.refusalExhaustion).toBeNull();
    expect(Object.values(checkpoint?.record.refusalCounts ?? {})).toContain(4);

    const valid = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const resumed = await makeAdmission(
      valid,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      {
        attempt: 2,
        nonExhaustingRefusals: true,
        store: first.store,
        restoreCheckpoint: checkpoint,
      },
    );
    await resumed.capability.prepareBatch({
      batchId: "corrected-after-restore",
      toolCalls: [call("corrected")],
      authorizedToolCallIds: ["corrected"],
    });
    expect(resumed.capability.receipt("corrected")).toMatchObject({
      status: "admitted",
      type: "evaluation-note",
    });
    await resumed.capability.settle({
      batchId: "corrected-after-restore",
      toolCallIds: ["corrected"],
      authorizedToolCallIds: ["corrected"],
      successfulToolCallIds: ["corrected"],
    });
    expect(resumed.capability.answerNowProgress()).toMatchObject({
      completedKeys: ["evaluation-note"],
    });
    const correctedCheckpoint = await resumed.latestCheckpoint();
    expect(correctedCheckpoint?.record.rows).toHaveLength(1);
    expect(correctedCheckpoint?.record.rows[0]).toMatchObject({
      type: "evaluation-note",
      key: "singleton",
    });
    expect(correctedCheckpoint?.record.refusalDiagnostics).toContainEqual({
      code: "evaluation-profile-semantics",
      location: "$.record",
      count: 4,
    });
    expect(valid).toHaveBeenCalledTimes(1);
  });

  it("restores unkeyed open-type refusal accounting without relaxing row addresses", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const validateCompletion: ValidateAnswerRecordCompletion = async () => ({ status: "valid" });
    const first = await makeCompleteAdmission(validateRecords, validateCompletion, false, true);
    const finding = () => ({
      ...recordShape("finding"),
      severity: "minor",
      dimension_id: "dimension-one",
      description: "A concrete finding linked to the fixture documentation.",
      evidence: [
        {
          evidence_class: "deterministic-conformance",
          strength: "direct",
          locator: "docs/page.md",
          description: "A directly observed condition",
        },
      ],
      acceptance_condition: "The observed condition is fixed",
    });
    const malformedFinding = {
      ...finding(),
      undeclared_field: "refused before a row key is issued",
    };
    const refusalId = "unkeyed-finding-refusal";
    const refusalBatch = "unkeyed-finding-refusal-batch";
    await first.capability.prepareBatch({
      batchId: refusalBatch,
      toolCalls: [call(refusalId, JSON.stringify({ type: "finding", record: malformedFinding }))],
      authorizedToolCallIds: [refusalId],
    });
    expect(first.capability.receipt(refusalId)).toMatchObject({
      status: "refused",
      code: "evaluation-schema-additional-properties",
      type: "finding",
      key: null,
    });
    await first.capability.settle({
      batchId: refusalBatch,
      toolCallIds: [refusalId],
      authorizedToolCallIds: [refusalId],
      successfulToolCallIds: [],
    });

    const findingId = "corrected-finding";
    const findingBatch = "corrected-finding-batch";
    await first.capability.prepareBatch({
      batchId: findingBatch,
      toolCalls: [call(findingId, JSON.stringify({ type: "finding", record: finding() }))],
      authorizedToolCallIds: [findingId],
    });
    const correctedReceipt = first.capability.receipt(findingId);
    expect(correctedReceipt, JSON.stringify(correctedReceipt)).toMatchObject({
      status: "admitted",
      key: "F-1",
    });
    await first.capability.settle({
      batchId: findingBatch,
      toolCallIds: [findingId],
      authorizedToolCallIds: [findingId],
      successfulToolCallIds: [findingId],
    });

    const unissuedId = "unissued-finding-refusal";
    const unissuedBatch = "unissued-finding-refusal-batch";
    await first.capability.prepareBatch({
      batchId: unissuedBatch,
      toolCalls: [
        call(
          unissuedId,
          JSON.stringify({ type: "finding", key: "F-999", record: malformedFinding }),
        ),
      ],
      authorizedToolCallIds: [unissuedId],
    });
    expect(first.capability.receipt(unissuedId)).toMatchObject({ status: "refused", key: "F-999" });
    await first.capability.settle({
      batchId: unissuedBatch,
      toolCallIds: [unissuedId],
      authorizedToolCallIds: [unissuedId],
      successfulToolCallIds: [],
    });

    const required = requiredFixtureRecords();
    const requiredCalls = required.map((record, index) => fixtureCall(`required-${index}`, record));
    const requiredIds = requiredCalls.map(({ toolCallId }) => toolCallId);
    const requiredBatch = "complete-required-records";
    await first.capability.prepareBatch({
      batchId: requiredBatch,
      toolCalls: requiredCalls,
      authorizedToolCallIds: requiredIds,
    });
    expect(first.capability.receipt(requiredIds.at(-1)!)).toMatchObject({ complete: true });
    await first.capability.settle({
      batchId: requiredBatch,
      toolCallIds: requiredIds,
      authorizedToolCallIds: requiredIds,
      successfulToolCallIds: requiredIds,
    });

    const checkpoint = await first.latestCheckpoint();
    expect(checkpoint?.record).toMatchObject({ complete: true, sequence: expect.any(Number) });
    expect(checkpoint?.record.refusalCounts).toHaveProperty("finding\u0000\u0000new", 2);
    expect(checkpoint?.record.refusalCounts).not.toHaveProperty("finding\u0000F-999");
    expect((await first.finish("")).index.rows.length).toBeGreaterThan(required.length);

    const resumed = await makeCompleteAdmission(validateRecords, validateCompletion, false, true, {
      attempt: 2,
      store: first.store,
      restoreCheckpoint: checkpoint,
    });
    expect(resumed.capability.answerNowProgress()).toMatchObject({ complete: true });
    const assembled = await resumed.finish("");
    expect(assembled.index.rows).toHaveLength(required.length + 1);
    expect(assembled.qualityScore).toBeDefined();
    expect(assembled.index.rows).toContainEqual(
      expect.objectContaining({ type: "finding", key: "F-1" }),
    );
    expect((await resumed.latestCheckpoint())?.record.refusalCounts).toHaveProperty(
      "finding\u0000\u0000new",
      2,
    );

    const malformedCounter = await resealCheckpoint(first, checkpoint!, (record) => {
      record.refusalCounts = { ...checkpoint!.record.refusalCounts, "unknown\u0000\u0000new": 1 };
    });
    await expect(
      makeCompleteAdmission(validateRecords, validateCompletion, false, true, {
        attempt: 2,
        store: first.store,
        restoreCheckpoint: malformedCounter,
      }),
    ).rejects.toMatchObject({
      rejection: { code: "candidate-staging-integrity-failed" },
      message: expect.stringContaining("host reason: checkpoint-shape"),
    });

    const malformedRow = await resealCheckpoint(first, checkpoint!, (record) => {
      const rows = record.rows as Array<Record<string, unknown>>;
      rows[0] = { ...rows[0], key: "\u0000new" };
    });
    await expect(
      makeCompleteAdmission(validateRecords, validateCompletion, false, true, {
        attempt: 2,
        store: first.store,
        restoreCheckpoint: malformedRow,
      }),
    ).rejects.toMatchObject({
      rejection: { code: "candidate-staging-integrity-failed" },
      message: expect.stringContaining("host reason: checkpoint-shape"),
    });
  });

  it("revalidates a complete restored checkpoint before requesting its report", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validCompletion: ValidateAnswerRecordCompletion = async () => ({ status: "valid" });
    const first = await makeCompleteAdmission(validateRecords, validCompletion, false);
    const records = requiredFixtureRecords();
    const calls = records.map((record, index) => fixtureCall(`source-${index}`, record));
    const toolCallIds = calls.map(({ toolCallId }) => toolCallId);
    await first.capability.prepareBatch({
      batchId: "source",
      toolCalls: calls,
      authorizedToolCallIds: toolCallIds,
    });
    await settleForDiagnostic(first.capability, {
      batchId: "source",
      toolCallIds,
      authorizedToolCallIds: toolCallIds,
      successfulToolCallIds: toolCallIds,
    });
    const checkpoint = await first.latestCheckpoint();
    expect(checkpoint?.record.complete).toBe(true);

    const refusedCompletion: ValidateAnswerRecordCompletion = async () => ({
      status: "refused",
      code: "technical-trace-missing-fact-id",
      location: "$.findings",
      owner: { kind: "record", type: "evaluation-note", key: "singleton" },
      feedback: "Link admitted FACT-TRACE-001 in the finding record.",
    });
    const restored = await makeCompleteAdmission(validateRecords, refusedCompletion, false, false, {
      attempt: 2,
      store: first.store,
      restoreCheckpoint: checkpoint,
    });
    expect(restored.capability.answerNowProgress()).toMatchObject({
      complete: false,
      remainingKeys: ["evaluation-note"],
    });
    expect(restored.capability.takeReportReadiness?.()).toBe(false);
    expect(restored.promptGuidance).toContain("FACT-TRACE-001");
    expect((await first.latestCheckpoint())?.sha256).toBe(checkpoint?.sha256);
    await restored.materializeContinuationCheckpoint();
    expect((await restored.latestCheckpoint())?.record.complete).toBe(false);
    expect((await first.latestCheckpoint())?.sha256).toBe(checkpoint?.sha256);

    const rejectedPublication = await makeCompleteAdmission(
      validateRecords,
      refusedCompletion,
      false,
      false,
      {
        attempt: 2,
        store: first.store,
        restoreCheckpoint: checkpoint,
        onCheckpoint: async () => {
          throw new Error("injected repair checkpoint publication failure");
        },
      },
    );
    await expect(rejectedPublication.materializeContinuationCheckpoint()).rejects.toThrow(
      /injected repair checkpoint publication failure/u,
    );
    expect((await rejectedPublication.latestCheckpoint())?.sha256).toBe(checkpoint?.sha256);
    expect((await first.latestCheckpoint())?.sha256).toBe(checkpoint?.sha256);

    await expect(
      makeCompleteAdmission(
        validateRecords,
        async () => ({
          status: "refused",
          code: "evaluation-validator-refused",
          location: "$",
          owner: { kind: "record", type: "evaluation-note", key: "singleton" },
        }),
        false,
        false,
        { attempt: 2, store: first.store, restoreCheckpoint: checkpoint },
      ),
    ).rejects.toThrow(/unmapped-refusal/u);
  });

  it("keeps a count-complete checkpoint repairable when host derivation remains open", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    let completionCalls = 0;
    const validateCompletion: ValidateAnswerRecordCompletion = async () => {
      completionCalls += 1;
      return { status: "valid" };
    };
    const source = await makeCompleteAdmission(validateRecords, validateCompletion, true);
    const calls = requiredFixtureRecords().map((record, index) =>
      fixtureCall(`open-source-${index}`, record),
    );
    const ids = calls.map(({ toolCallId }) => toolCallId);
    await source.capability.prepareBatch({
      batchId: "open-source",
      toolCalls: calls,
      authorizedToolCallIds: ids,
    });
    expect(source.capability.receipt(ids.at(-1)!)).toMatchObject({
      complete: false,
      open: ["layer-one"],
    });
    await settleForDiagnostic(source.capability, {
      batchId: "open-source",
      toolCallIds: ids,
      authorizedToolCallIds: ids,
      successfulToolCallIds: ids,
    });
    const checkpoint = await source.latestCheckpoint();
    expect(checkpoint?.record.complete).toBe(true);
    expect(completionCalls).toBe(0);

    const restored = await makeCompleteAdmission(validateRecords, validateCompletion, true, false, {
      attempt: 2,
      store: source.store,
      restoreCheckpoint: checkpoint,
    });
    expect(restored.capability.takeReportReadiness?.()).toBe(false);
    expect(restored.promptGuidance).toContain('"layer-one"');
    expect(restored.promptGuidance).toContain("Submit the corresponding layer-note records");
    expect((await restored.latestCheckpoint())?.sha256).toBe(checkpoint?.sha256);
    expect(completionCalls).toBe(0);

    for (const open of [[], ["unplanned-layer"]]) {
      await expect(
        makeCompleteAdmission(validateRecords, validateCompletion, true, false, {
          attempt: 2,
          store: source.store,
          restoreCheckpoint: checkpoint,
          derive: async () => ({ status: "open", open }),
        }),
      ).rejects.toThrow(/derivation-open-shape/u);
    }
    expect(completionCalls).toBe(0);
  });

  it("preserves refusal exhaustion for an issued open key across checkpoint restore", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const first = await makeAdmission(validateRecords);
    const validFinding = {
      ...recordShape("finding"),
      severity: "minor",
      dimension_id: "dimension-one",
      description: "A concrete finding linked to the fixture documentation.",
      evidence: [
        {
          evidence_class: "deterministic-conformance",
          strength: "direct",
          locator: "docs/page.md",
          description: "A directly observed condition",
        },
      ],
      acceptance_condition: "The observed condition is fixed",
    };
    await first.capability.prepareBatch({
      batchId: "issued-key-row",
      toolCalls: [
        call("issued-key-row-call", JSON.stringify({ type: "finding", record: validFinding })),
      ],
      authorizedToolCallIds: ["issued-key-row-call"],
    });
    expect(first.capability.receipt("issued-key-row-call")).toMatchObject({
      status: "admitted",
      key: "F-1",
    });
    await first.capability.settle({
      batchId: "issued-key-row",
      toolCallIds: ["issued-key-row-call"],
      authorizedToolCallIds: ["issued-key-row-call"],
      successfulToolCallIds: ["issued-key-row-call"],
    });

    const malformed = { ...validFinding, undeclared_field: true };
    await first.capability.prepareBatch({
      batchId: "issued-key-refusal",
      toolCalls: [
        call(
          "issued-key-refusal-call",
          JSON.stringify({ type: "finding", key: "F-1", record: malformed }),
        ),
      ],
      authorizedToolCallIds: ["issued-key-refusal-call"],
    });
    expect(first.capability.receipt("issued-key-refusal-call")).toMatchObject({
      status: "refused",
      code: "evaluation-schema-additional-properties",
      key: "F-1",
    });
    await first.capability.settle({
      batchId: "issued-key-refusal",
      toolCallIds: ["issued-key-refusal-call"],
      authorizedToolCallIds: ["issued-key-refusal-call"],
      successfulToolCallIds: [],
    });
    const checkpoint = await first.latestCheckpoint();
    expect(checkpoint?.record.refusalCounts).toHaveProperty("finding\u0000F-1", 1);

    const resumed = await makeAdmission(
      validateRecords,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      { attempt: 2, store: first.store, restoreCheckpoint: checkpoint },
    );
    await resumed.capability.prepareBatch({
      batchId: "issued-key-refusal-after-restore",
      toolCalls: [
        call(
          "issued-key-refusal-after-restore-call",
          JSON.stringify({ type: "finding", key: "F-1", record: malformed }),
        ),
      ],
      authorizedToolCallIds: ["issued-key-refusal-after-restore-call"],
    });
    expect(resumed.capability.receipt("issued-key-refusal-after-restore-call")).toMatchObject({
      status: "refused",
      code: "answer-record-exhausted",
      key: "F-1",
    });
    await resumed.capability.settle({
      batchId: "issued-key-refusal-after-restore",
      toolCallIds: ["issued-key-refusal-after-restore-call"],
      authorizedToolCallIds: ["issued-key-refusal-after-restore-call"],
      successfulToolCallIds: [],
    });
    expect((await resumed.latestCheckpoint())?.record.refusalCounts).toHaveProperty(
      "finding\u0000F-1",
      2,
    );
  });

  it.each([
    { name: "unkeyed open record", charge: "finding\u0000\u0000new", type: "finding" },
    { name: "unclassified call", charge: "\u0000call", type: null },
  ])("restores exhausted refusal bucket for an $name", async ({ charge, type }) => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const first = await makeAdmission(validateRecords);
    const refusedArguments =
      type === null
        ? JSON.stringify({ type: "unknown-record-type", record: {} })
        : JSON.stringify({ type, record: { undeclared_field: true } });
    const refusedCallId = "refusal-call";
    await first.capability.prepareBatch({
      batchId: "first-refusal",
      toolCalls: [call(refusedCallId, refusedArguments)],
      authorizedToolCallIds: [refusedCallId],
    });
    expect(first.capability.receipt(refusedCallId).status).toBe("refused");
    await first.capability.settle({
      batchId: "first-refusal",
      toolCallIds: [refusedCallId],
      authorizedToolCallIds: [refusedCallId],
      successfulToolCallIds: [],
    });

    const exhaustedCallId = "exhausted-refusal-call";
    await first.capability.prepareBatch({
      batchId: "exhausted-refusal",
      toolCalls: [call(exhaustedCallId, refusedArguments)],
      authorizedToolCallIds: [exhaustedCallId],
    });
    expect(first.capability.receipt(exhaustedCallId)).toMatchObject({
      status: "refused",
      code: "answer-record-exhausted",
      type,
      key: null,
    });
    await first.capability.settle({
      batchId: "exhausted-refusal",
      toolCallIds: [exhaustedCallId],
      authorizedToolCallIds: [exhaustedCallId],
      successfulToolCallIds: [],
    });
    const checkpoint = await first.latestCheckpoint();
    expect(checkpoint?.record.refusalCounts).toHaveProperty(charge, 2);
    expect(checkpoint?.record.refusalExhaustion).toEqual({ type, key: null });

    const resumed = await makeAdmission(
      validateRecords,
      {} as never,
      undefined,
      undefined,
      {},
      ["layer-one"],
      { attempt: 2, store: first.store, restoreCheckpoint: checkpoint },
    );
    expect((await resumed.latestCheckpoint())?.record.refusalCounts).toHaveProperty(charge, 2);
    const repeatedCallId = "repeated-exhausted-refusal-call";
    await resumed.capability.prepareBatch({
      batchId: "repeated-exhausted-refusal",
      toolCalls: [call(repeatedCallId, refusedArguments)],
      authorizedToolCallIds: [repeatedCallId],
    });
    expect(resumed.capability.receipt(repeatedCallId)).toMatchObject({
      status: "refused",
      code: "answer-record-exhausted",
      type,
      key: null,
    });
    await resumed.capability.settle({
      batchId: "repeated-exhausted-refusal",
      toolCallIds: [repeatedCallId],
      authorizedToolCallIds: [repeatedCallId],
      successfulToolCallIds: [],
    });
    expect((await resumed.latestCheckpoint())?.record.refusalCounts).toHaveProperty(charge, 3);
  });

  it("does not charge a refused proposal withheld by the execution lease", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({
        toolCallId,
        status: "refused" as const,
        code: "evaluation-profile-semantics" as const,
        location: "$.record",
      })),
    );
    const session = await makeAdmission(validateRecords);
    await session.capability.prepareBatch({
      batchId: "batch-1",
      toolCalls: [call("call-1")],
      authorizedToolCallIds: [],
    });
    await settleForDiagnostic(session.capability, {
      batchId: "batch-1",
      toolCallIds: ["call-1"],
      authorizedToolCallIds: [],
      successfulToolCallIds: [],
    });
    await session.capability.prepareBatch({
      batchId: "batch-2",
      toolCalls: [call("call-2")],
      authorizedToolCallIds: ["call-2"],
    });
    expect(session.capability.receipt("call-2")).toMatchObject({
      code: "evaluation-profile-semantics",
      status: "refused",
    });
    expect(session.capability.receipt("call-2").code).not.toBe("answer-record-exhausted");
  });

  it("aggregates structural and canonical refusals under the same singleton-key budget", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({
        toolCallId,
        status: "refused" as const,
        code: "evaluation-profile-semantics" as const,
        location: "$.record",
      })),
    );
    const session = await makeAdmission(validateRecords);
    await session.capability.prepareBatch({
      batchId: "batch-mixed",
      toolCalls: [
        call(
          "bad-shape",
          JSON.stringify({ type: "evaluation-note", record: { findings_complete: false } }),
        ),
        call("bad-policy"),
      ],
      authorizedToolCallIds: ["bad-shape", "bad-policy"],
    });
    expect(session.capability.receipt("bad-shape")).toMatchObject({
      code: "evaluation-schema-const",
      status: "refused",
    });
    expect(session.capability.receipt("bad-policy")).toMatchObject({
      code: "answer-record-exhausted",
      status: "refused",
    });
    expect(validateRecords).toHaveBeenCalledTimes(1);
    await session.capability.settle({
      batchId: "batch-mixed",
      toolCallIds: ["bad-shape", "bad-policy"],
      authorizedToolCallIds: ["bad-shape", "bad-policy"],
      successfulToolCallIds: [],
    });
  });

  it("persists only an authorized successful row and derives the index from reloaded seals", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const session = await makeAdmission(validateRecords);
    await session.capability.prepareBatch({
      batchId: "batch-1",
      toolCalls: [call("call-1")],
      authorizedToolCallIds: ["call-1"],
    });
    expect(session.capability.receipt("call-1").status).toBe("admitted");
    await session.capability.settle({
      batchId: "batch-1",
      toolCallIds: ["call-1"],
      authorizedToolCallIds: ["call-1"],
      successfulToolCallIds: ["call-1"],
    });
    const index = await session.snapshotIndex();
    expect(index).toMatchObject({
      contractId: "quality-evaluation",
      bindingsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      rows: [
        {
          type: "evaluation-note",
          key: "singleton",
          recordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          state: "admitted",
          attempt: 1,
        },
      ],
    });
    const row = index!.rows[0]!;
    const stored = await session.store.getRecord(row.recordSha256);
    expect(opaqueRecordDigest(stored)).toBe(row.recordSha256);
    expect(stored).toMatchObject({
      kind: "docsfab-answer-record",
      type: "evaluation-note",
      key: "singleton",
      payloadSha256: canonicalDigest({ findings_complete: true }),
      payload: { findings_complete: true },
    });
  });

  it("keeps anonymous finding occurrences open until the real evaluation-note close flag", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const session = await makeAdmission(validateRecords);
    const fixtureRows = [
      { fixture: "fixture-a", group: 4, type: "finding", key: null, rawEnvelopeBytes: 13 },
      { fixture: "fixture-a", group: 3, type: "evaluation-note", key: null, rawEnvelopeBytes: 7 },
    ] as const;
    const project = (progress: ReturnType<typeof session.capability.answerNowProgress>) =>
      deriveAnswerSubmissionRemainingPlan({
        fixtureRows,
        remainingKeys: progress.remainingKeys,
        completedKeys: progress.completedKeys,
        openSets: progress.openSets,
        complete: progress.complete,
        qualifiedMessageBudget: 20,
      });
    const before = session.capability.answerNowProgress();
    expect(before.openSets).toContainEqual({ type: "finding", open: true });
    expect(project(before).openPlanBytes).toBe(20);

    await session.capability.prepareBatch({
      batchId: "close-finding-set",
      toolCalls: [call("close-finding-set")],
      authorizedToolCallIds: ["close-finding-set"],
    });
    await session.capability.settle({
      batchId: "close-finding-set",
      toolCallIds: ["close-finding-set"],
      authorizedToolCallIds: ["close-finding-set"],
      successfulToolCallIds: ["close-finding-set"],
    });
    const after = session.capability.answerNowProgress();
    expect(after.openSets).toContainEqual({ type: "finding", open: false });
    expect(project(after).openPlanBytes).toBe(0);
  });

  it("releaseAll reseals settled required rows as released and finish excludes them", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(async () => ({
      status: "valid",
    }));
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const records = requiredFixtureRecords();
    const calls = records.map((record, index) => fixtureCall(`release-${index}`, record));
    const callIds = calls.map(({ toolCallId }) => toolCallId);

    await runWithDiagnostic("release-all preparation", () =>
      session.capability.prepareBatch({
        batchId: "release-all-complete-records",
        toolCalls: calls,
        authorizedToolCallIds: callIds,
      }),
    );
    expect(session.capability.receipt(callIds.at(-1)!).complete).toBe(true);
    await settleForDiagnostic(session.capability, {
      batchId: "release-all-complete-records",
      toolCallIds: callIds,
      authorizedToolCallIds: callIds,
      successfulToolCallIds: callIds,
    });

    const before = await session.snapshotIndex();
    expect(before?.rows.length).toBe(records.length);
    expect(before?.rows.every((row) => row.state === "admitted")).toBe(true);
    const completed = await session.finish("");
    expect(completed.index.rows.every((row) => row.state === "admitted")).toBe(true);
    expect(completed.index.checkpoint).toEqual(before?.checkpoint);
    expect(completed.index.progress).toEqual(before?.progress);

    await session.releaseAll();
    const reloaded = await session.snapshotIndex();
    expect(reloaded?.rows).toEqual([]);
    expect(reloaded?.progress).toMatchObject({
      admittedRowCount: 0,
      releasedRowCount: records.length,
      complete: false,
    });
    expect(reloaded?.checkpoint?.sequence).toBe((before?.checkpoint?.sequence ?? 0) + 1);
    await expect(session.finish("")).rejects.toMatchObject({
      rejection: { code: "candidate-staging-integrity-failed" },
    });
  });

  it("preserves the prior sealed record when an authorized replacement is persisted", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validateCompletion: ValidateAnswerRecordCompletion = async () => ({ status: "valid" });
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const initial = requiredFixtureRecords();
    const initialCalls = initial.map((record, index) =>
      fixtureCall(`preserve-old-${index}`, record),
    );
    await session.capability.prepareBatch({
      batchId: "preserve-old-records",
      toolCalls: initialCalls,
      authorizedToolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
    });
    await settleForDiagnostic(session.capability, {
      batchId: "preserve-old-records",
      toolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
    });

    const before = await session.snapshotIndex();
    const oldRow = before!.rows.find(
      (row) => row.type === "dimension" && row.key === "dimension-one",
    )!;
    const oldRationale = (
      initial.find((row) => row.type === "dimension")!.record as Record<string, unknown>
    ).rationale;
    const oldStoredRecord = await session.store.getRecord(oldRow.recordSha256);
    const replacement = recordShape("dimension", 0);
    replacement.rationale = "A separately admitted replacement with preserved history.";
    await session.capability.prepareBatch({
      batchId: "persist-replacement",
      toolCalls: [
        fixtureCall("persist-replacement-call", {
          type: "dimension",
          key: "dimension-one",
          record: replacement,
        }),
      ],
      authorizedToolCallIds: ["persist-replacement-call"],
    });
    expect(session.capability.receipt("persist-replacement-call")).toMatchObject({
      status: "replaced",
      type: "dimension",
      key: "dimension-one",
      complete: true,
    });
    await settleForDiagnostic(session.capability, {
      batchId: "persist-replacement",
      toolCallIds: ["persist-replacement-call"],
      authorizedToolCallIds: ["persist-replacement-call"],
      successfulToolCallIds: ["persist-replacement-call"],
    });

    const after = await session.snapshotIndex();
    const newRow = after!.rows.find(
      (row) => row.type === "dimension" && row.key === "dimension-one",
    )!;
    expect(newRow.recordSha256).not.toBe(oldRow.recordSha256);
    expect(await session.store.getRecord(oldRow.recordSha256)).toEqual(oldStoredRecord);
    expect(opaqueRecordDigest(oldStoredRecord)).toBe(oldRow.recordSha256);
    expect(oldStoredRecord).toMatchObject({
      state: "admitted",
      type: "dimension",
      key: "dimension-one",
      payload: { rationale: oldRationale },
    });
    expect(await session.store.getRecord(newRow.recordSha256)).toMatchObject({
      state: "admitted",
      type: "dimension",
      key: "dimension-one",
      payload: { rationale: replacement.rationale },
    });
  });

  it("signals report readiness only for a settled, validated authorized ledger identity", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validateCompletion: ValidateAnswerRecordCompletion = async () => ({ status: "valid" });
    const records = requiredFixtureRecords();
    const calls = records.map((record, index) => fixtureCall(`report-ready-${index}`, record));
    const callIds = calls.map(({ toolCallId }) => toolCallId);
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    await session.capability.prepareBatch({
      batchId: "report-ready-with-unauthorized-suffix",
      toolCalls: [...calls, call("unauthorized-suffix", "{not inspected}")],
      authorizedToolCallIds: callIds,
    });
    expect(session.capability.receipt(callIds.at(-1)!).complete).toBe(true);
    expect(session.capability.takeReportReadiness()).toBe(false);
    await session.capability.settle({
      batchId: "report-ready-with-unauthorized-suffix",
      toolCallIds: [...callIds, "unauthorized-suffix"],
      authorizedToolCallIds: callIds,
      successfulToolCallIds: callIds,
    });
    expect(session.capability.takeReportReadiness()).toBe(true);
    expect(session.capability.takeReportReadiness()).toBe(false);

    const laterBatch = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    await laterBatch.capability.prepareBatch({
      batchId: "report-readiness-invalidated-by-next-batch",
      toolCalls: calls,
      authorizedToolCallIds: callIds,
    });
    await laterBatch.capability.settle({
      batchId: "report-readiness-invalidated-by-next-batch",
      toolCallIds: callIds,
      authorizedToolCallIds: callIds,
      successfulToolCallIds: callIds,
    });
    await laterBatch.capability.prepareBatch({
      batchId: "report-later-ledger-mutation",
      toolCalls: [fixtureCall("later-dimension-update", records[1]!)],
      authorizedToolCallIds: ["later-dimension-update"],
    });
    expect(laterBatch.capability.takeReportReadiness()).toBe(false);

    const unauthorizedCloser = await makeCompleteAdmission(
      validateRecords,
      validateCompletion,
      false,
    );
    await unauthorizedCloser.capability.prepareBatch({
      batchId: "report-closer-not-authorized",
      toolCalls: calls,
      authorizedToolCallIds: callIds.slice(0, -1),
    });
    await unauthorizedCloser.capability.settle({
      batchId: "report-closer-not-authorized",
      toolCallIds: callIds,
      authorizedToolCallIds: callIds.slice(0, -1),
      successfulToolCallIds: callIds.slice(0, -1),
    });
    expect(unauthorizedCloser.capability.takeReportReadiness()).toBe(false);

    const missingSettlement = await makeCompleteAdmission(
      validateRecords,
      validateCompletion,
      false,
    );
    await missingSettlement.capability.prepareBatch({
      batchId: "report-settled-ledger-differs",
      toolCalls: calls,
      authorizedToolCallIds: callIds,
    });
    expect(missingSettlement.capability.receipt(callIds.at(-1)!).complete).toBe(true);
    await missingSettlement.capability.settle({
      batchId: "report-settled-ledger-differs",
      toolCallIds: callIds,
      authorizedToolCallIds: callIds,
      successfulToolCallIds: callIds.slice(1),
    });
    expect(missingSettlement.capability.takeReportReadiness()).toBe(false);

    const openLedger = await makeCompleteAdmission(validateRecords, validateCompletion, true);
    await openLedger.capability.prepareBatch({
      batchId: "report-open-derived-ledger",
      toolCalls: calls,
      authorizedToolCallIds: callIds,
    });
    expect(openLedger.capability.receipt(callIds.at(-1)!).complete).toBe(false);
    await openLedger.capability.settle({
      batchId: "report-open-derived-ledger",
      toolCallIds: callIds,
      authorizedToolCallIds: callIds,
      successfulToolCallIds: callIds,
    });
    expect(openLedger.capability.takeReportReadiness()).toBe(false);

    const laterRefusal = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const refusedSuffix = "refused-after-validated-prefix";
    await laterRefusal.capability.prepareBatch({
      batchId: "report-terminal-refusal",
      toolCalls: [...calls, call(refusedSuffix, "{not JSON")],
      authorizedToolCallIds: [...callIds, refusedSuffix],
    });
    expect(laterRefusal.capability.receipt(refusedSuffix).status).toBe("refused");
    await laterRefusal.capability.settle({
      batchId: "report-terminal-refusal",
      toolCallIds: [...callIds, refusedSuffix],
      authorizedToolCallIds: [...callIds, refusedSuffix],
      successfulToolCallIds: callIds,
    });
    expect(laterRefusal.capability.takeReportReadiness()).toBe(false);

    const failedPersistence = await makeCompleteAdmission(
      validateRecords,
      validateCompletion,
      false,
      false,
      {
        onCheckpoint: async () => {
          throw new Error("Checkpoint publication failed for this test.");
        },
      },
    );
    await failedPersistence.capability.prepareBatch({
      batchId: "report-persistence-failed",
      toolCalls: calls,
      authorizedToolCallIds: callIds,
    });
    await expect(
      failedPersistence.capability.settle({
        batchId: "report-persistence-failed",
        toolCallIds: callIds,
        authorizedToolCallIds: callIds,
        successfulToolCallIds: callIds,
      }),
    ).rejects.toThrow(/Checkpoint publication failed/u);
    expect(failedPersistence.capability.takeReportReadiness()).toBe(false);

    const completedCheckpoint = await session.latestCheckpoint();
    expect(completedCheckpoint?.record.complete).toBe(true);
    const restoredComplete = await makeCompleteAdmission(
      validateRecords,
      validateCompletion,
      false,
      false,
      { attempt: 2, store: session.store, restoreCheckpoint: completedCheckpoint },
    );
    expect((await restoredComplete.replayState()).complete).toBe(true);
    expect(restoredComplete.capability.takeReportReadiness()).toBe(true);
    expect(restoredComplete.capability.takeReportReadiness()).toBe(false);
  });

  it("keeps the real Pi record tool available through D3 correction and asks once after settlement", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(async () => ({
      status: "valid",
    }));
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, true);
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const initial = requiredFixtureRecords().map((record, index) =>
      fixtureCall(`initial-${index}`, record),
    );
    const correction = fixtureCall("layer-note", {
      type: "layer-note",
      key: "layer-one",
      record: validLayerNoteRecord(),
    });
    const toPiCall = (call: ReturnType<typeof fixtureCall>) => ({
      id: call.toolCallId,
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [call.rawArguments!],
    });
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      rawToolCallTurn(initial.map(toPiCall)),
      rawToolCallTurn([toPiCall(correction)]),
      textTurn(FIXTURE_REPORT),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request after the report turn.");
      return response.clone();
    });

    const result = await toolPathHarness({
      timeoutMs: 300_000,
      now: () => 0,
      capability: null,
    }).runStep({
      ...input,
      qualityAnswerRecords: session.capability,
      qualityAnswerRecordCallCeiling: session.recordCallCeiling,
      qualityAnswerRecordProgress: () => session.capability.answerNowProgress(),
      qualityAnswerRecordGuidance: session.promptGuidance,
      qualityAnswerRecordRemainingKeys: session.capability.answerNowProgress().remainingKeys,
    });

    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.tool_choice ?? "auto").toBe("auto");
    const secondTools = bodies[1]!.tools as Array<{ function?: { name?: string } }>;
    expect(
      secondTools.some((tool) => tool.function?.name === QUALITY_ANSWER_RECORD_TOOL_NAME),
    ).toBe(true);
    expect(bodies[2]!.tool_choice).toBe("none");
    const reportAsks = bodies.flatMap((body) =>
      ((body.messages ?? []) as Array<{ role?: string; content?: unknown }>).filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("Return the final evaluator report as Markdown only"),
      ),
    );
    expect(reportAsks).toHaveLength(1);
    expect(validateCompletion).toHaveBeenCalledTimes(1);
    expect(session.capability.takeReportReadiness()).toBe(false);
    expect(result.qualityAnswerRecordReport).toBe(FIXTURE_REPORT);
  });

  it("requires recovery tools after premature final text through D3 until validated report readiness", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(async () => ({
      status: "valid",
    }));
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, true);
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const initial = requiredFixtureRecords().map((record, index) =>
      fixtureCall(`recovery-initial-${index}`, record),
    );
    const correction = fixtureCall("recovery-layer-note", {
      type: "layer-note",
      key: "layer-one",
      record: validLayerNoteRecord(),
    });
    const malformed = fixtureCall("recovery-unknown-record", {
      type: "dimension",
      key: "not-planned",
      record: recordShape("dimension"),
    });
    const toPiCall = (call: ReturnType<typeof fixtureCall>) => ({
      id: call.toolCallId,
      name: QUALITY_ANSWER_RECORD_TOOL_NAME,
      chunks: [call.rawArguments!],
    });
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      textTurn("# Premature report\nThe ledger is not complete."),
      // Even an invalid text-only response to the required-tool request must
      // not synthesize progress or end the recovery loop.
      textTurn("Still no records."),
      rawToolCallTurn([toPiCall(malformed)]),
      rawToolCallTurn(initial.map(toPiCall)),
      rawToolCallTurn([toPiCall(correction)]),
      textTurn(FIXTURE_REPORT),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request after report readiness.");
      return response.clone();
    });

    const result = await toolPathHarness({
      timeoutMs: 300_000,
      now: () => 0,
      capability: null,
    }).runStep({
      ...input,
      qualityAnswerRecords: session.capability,
      qualityAnswerRecordCallCeiling: session.recordCallCeiling,
      qualityAnswerRecordProgress: () => session.capability.answerNowProgress(),
      qualityAnswerRecordGuidance: session.promptGuidance,
      qualityAnswerRecordRemainingKeys: session.capability.answerNowProgress().remainingKeys,
      experimentalAnswerRecordDiscoveryRenewal: true,
    });

    expect(bodies).toHaveLength(6);
    expect(bodies[0]!.tool_choice ?? "auto").toBe("auto");
    expect(bodies[1]).toMatchObject({ tool_choice: "required" });
    expect(bodies[2]).toMatchObject({ tool_choice: "required" });
    expect(bodies[3]).toMatchObject({ tool_choice: "required" });
    expect(bodies[4]).toMatchObject({ tool_choice: "required" });
    expect(bodies[5]).toMatchObject({ tool_choice: "none" });
    const recoveryText = userText(bodies[1]!);
    expect(recoveryText).toContain("labels identify remaining host-planned records");
    expect(recoveryText).not.toContain('A label ending in ":singleton"');
    expect(toolResults(bodies[3]!).get("recovery-unknown-record")).toContain('"status":"refused"');
    expect(toolResults(bodies[5]!).get("recovery-layer-note")).toContain('"status":"admitted"');
    expect(session.capability.answerNowProgress().complete).toBe(true);
    expect(validateCompletion).toHaveBeenCalledTimes(1);
    expect(session.capability.takeReportReadiness?.()).toBe(false);
    expect(result.qualityAnswerRecordReport).toBe(FIXTURE_REPORT);
  });

  it("surfaces a D3 open layer, revalidates later replacements, and retains released evidence", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(async () => ({
      status: "valid",
    }));
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, true);
    const initial = requiredFixtureRecords();
    const initialCalls = initial.map((record, index) => fixtureCall(`initial-${index}`, record));
    await runWithDiagnostic("initial D3 preparation", () =>
      session.capability.prepareBatch({
        batchId: "complete-required-records",
        toolCalls: initialCalls,
        authorizedToolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
      }),
    );
    expect(
      session.capability.receipt("initial-4"),
      receiptSummary(session.capability.receipt("initial-4")),
    ).toMatchObject({
      status: "admitted",
      complete: false,
      open: ["layer-one"],
    });
    await settleForDiagnostic(session.capability, {
      batchId: "complete-required-records",
      toolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: initialCalls.map(({ toolCallId }) => toolCallId),
    });
    expect(session.capability.answerNowProgress().complete).toBe(true);
    expect(session.capability.takeReportReadiness()).toBe(false);

    const layerNote = {
      type: "layer-note",
      key: "layer-one",
      record: validLayerNoteRecord(),
    };
    await runWithDiagnostic("D3 layer-note preparation", () =>
      session.capability.prepareBatch({
        batchId: "resolve-d3-layer",
        toolCalls: [fixtureCall("layer-note", layerNote)],
        authorizedToolCallIds: ["layer-note"],
      }),
    );
    expect(
      session.capability.receipt("layer-note"),
      receiptSummary(session.capability.receipt("layer-note")),
    ).toMatchObject({
      status: "admitted",
      complete: true,
    });
    expect(validateCompletion).toHaveBeenCalledTimes(1);
    await settleForDiagnostic(session.capability, {
      batchId: "resolve-d3-layer",
      toolCallIds: ["layer-note"],
      authorizedToolCallIds: ["layer-note"],
      successfulToolCallIds: ["layer-note"],
    });
    expect(session.capability.takeReportReadiness()).toBe(true);
    expect(session.capability.takeReportReadiness()).toBe(false);

    const oldIndex = await session.snapshotIndex();
    const oldDimension = oldIndex!.rows.find(
      (row) => row.type === "dimension" && row.key === "dimension-one",
    )!;
    validateCompletion.mockResolvedValueOnce({
      status: "refused",
      owner: { kind: "record", type: "dimension", key: "dimension-one" },
      code: "evaluation-profile-semantics",
      location: "$.evaluation.layers.layer-one.dimensions[0].rationale",
    });
    const replacement = recordShape("dimension", 0);
    replacement.rationale = "A changed rationale that requires whole-artifact revalidation.";
    await runWithDiagnostic("replacement preparation", () =>
      session.capability.prepareBatch({
        batchId: "revalidate-replacement",
        toolCalls: [
          fixtureCall("replacement", {
            type: "dimension",
            key: "dimension-one",
            record: replacement,
          }),
        ],
        authorizedToolCallIds: ["replacement"],
      }),
    );
    expect(session.capability.receipt("replacement")).toMatchObject({
      status: "refused",
      type: "dimension",
      key: "dimension-one",
      code: "evaluation-profile-semantics",
      remaining: ["dimension:dimension-one"],
    });
    expect(validateCompletion).toHaveBeenCalledTimes(2);
    await settleForDiagnostic(session.capability, {
      batchId: "revalidate-replacement",
      toolCallIds: ["replacement"],
      authorizedToolCallIds: ["replacement"],
      successfulToolCallIds: [],
    });
    const releasedIndex = await session.snapshotIndex();
    expect(releasedIndex!.rows).not.toContainEqual(
      expect.objectContaining({ type: "dimension", key: "dimension-one" }),
    );
    expect(releasedIndex!.progress?.releasedRowCount).toBe(1);
    expect(releasedIndex!.progress?.complete).toBe(false);
    expect(await session.store.getRecord(oldDimension.recordSha256)).toMatchObject({
      state: "admitted",
    });
    expect((await session.latestCheckpoint())?.record.tombstones).toContainEqual(
      expect.objectContaining({ type: "dimension", key: "dimension-one", reasonCode: "released" }),
    );
    await expect(session.finish("")).rejects.toThrow();
  });

  it("drops a refused required closer, releases its prior owner, and asks for both again", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    let completionCalls = 0;
    const validateCompletion: Parameters<
      typeof createQualityAnswerRecordAdmission
    >[0]["validateCompletion"] = async () => {
      completionCalls += 1;
      if (completionCalls === 1) {
        return {
          status: "refused",
          owner: { kind: "record", type: "dimension", key: "dimension-one" },
          code: "evaluation-profile-semantics",
          location: "$.evaluation.layers.layer-one.dimensions[0].rationale",
        };
      }
      return { status: "valid" };
    };
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const partialRecords = requiredFixtureRecords().filter(
      (entry) => entry.type !== "quality-score",
    );
    const partialCalls = partialRecords.map((record, index) =>
      fixtureCall(`partial-${index}`, record),
    );
    await session.capability.prepareBatch({
      batchId: "persist-owner-without-closer",
      toolCalls: partialCalls,
      authorizedToolCallIds: partialCalls.map(({ toolCallId }) => toolCallId),
    });
    await session.capability.settle({
      batchId: "persist-owner-without-closer",
      toolCallIds: partialCalls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: partialCalls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: partialCalls.map(({ toolCallId }) => toolCallId),
    });

    const score = requiredFixtureRecords().find((entry) => entry.type === "quality-score")!;
    const scoreCall = fixtureCall("closing-score", score);
    await session.capability.prepareBatch({
      batchId: "refused-required-closer",
      toolCalls: [scoreCall],
      authorizedToolCallIds: ["closing-score"],
    });
    expect(session.capability.receipt("closing-score")).toMatchObject({
      status: "refused",
      type: "dimension",
      key: "dimension-one",
    });
    expect(session.capability.receipt("closing-score").remaining).toEqual([
      "dimension:dimension-one",
      "quality-score",
    ]);
    await session.capability.settle({
      batchId: "refused-required-closer",
      toolCallIds: ["closing-score"],
      authorizedToolCallIds: ["closing-score"],
      successfulToolCallIds: [],
    });
    const refusedIndex = await session.snapshotIndex();
    expect(refusedIndex?.rows).not.toContainEqual(
      expect.objectContaining({ type: "dimension", key: "dimension-one" }),
    );
    expect(refusedIndex?.progress?.releasedRowCount).toBe(1);
    expect(refusedIndex?.rows.some((row) => row.type === "quality-score")).toBe(false);

    const corrections = [
      fixtureCall("replay-dimension", partialRecords[1]!),
      fixtureCall("replay-score", score),
    ];
    await session.capability.prepareBatch({
      batchId: "resend-refused-required-rows",
      toolCalls: corrections,
      authorizedToolCallIds: corrections.map(({ toolCallId }) => toolCallId),
    });
    expect(session.capability.receipt("replay-score")).toMatchObject({
      status: "admitted",
      complete: true,
      remaining: [],
    });
    await session.capability.settle({
      batchId: "resend-refused-required-rows",
      toolCallIds: corrections.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: corrections.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: corrections.map(({ toolCallId }) => toolCallId),
    });
    expect((await session.finish("")).qualityScore).toBeDefined();
  });

  it("recomputes the closing receipt after an earlier same-batch owner is refused", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    let completionCalls = 0;
    const validateCompletion: Parameters<
      typeof createQualityAnswerRecordAdmission
    >[0]["validateCompletion"] = async () => {
      completionCalls += 1;
      if (completionCalls === 1) {
        return {
          status: "refused",
          owner: { kind: "record", type: "dimension", key: "dimension-one" },
          code: "evaluation-profile-semantics",
          location: "$.evaluation.layers.layer-one.dimensions[0].rationale",
        };
      }
      return { status: "valid" };
    };
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const records = requiredFixtureRecords();
    const calls = records.map((record, index) => fixtureCall(`same-batch-${index}`, record));
    await session.capability.prepareBatch({
      batchId: "same-batch-owner-refusal",
      toolCalls: calls,
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
    });

    const ownerId = "same-batch-1";
    const closingId = calls.at(-1)!.toolCallId;
    expect(session.capability.receipt(ownerId)).toMatchObject({
      status: "refused",
      type: "dimension",
      key: "dimension-one",
    });
    expect(session.capability.receipt(closingId)).toMatchObject({
      status: "admitted",
      complete: false,
      remaining: ["dimension:dimension-one"],
    });
    await session.capability.settle({
      batchId: "same-batch-owner-refusal",
      toolCallIds: calls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: calls
        .map(({ toolCallId }) => toolCallId)
        .filter((toolCallId) => toolCallId !== ownerId),
    });
    const afterFirstBatch = await session.snapshotIndex();
    expect(
      afterFirstBatch?.rows.some((row) => row.type === "dimension" && row.key === "dimension-one"),
    ).toBe(false);
    expect(
      afterFirstBatch?.rows.some(
        (row) =>
          row.type === "dimension" && row.key === "constraint-one" && row.state === "admitted",
      ),
    ).toBe(true);
    expect(afterFirstBatch?.rows.some((row) => row.type === "quality-score")).toBe(true);

    await session.capability.prepareBatch({
      batchId: "same-batch-owner-correction",
      toolCalls: [fixtureCall("dimension-correction", records[1]!)],
      authorizedToolCallIds: ["dimension-correction"],
    });
    expect(session.capability.receipt("dimension-correction")).toMatchObject({
      status: "admitted",
      complete: true,
      remaining: [],
    });
    await session.capability.settle({
      batchId: "same-batch-owner-correction",
      toolCallIds: ["dimension-correction"],
      authorizedToolCallIds: ["dimension-correction"],
      successfulToolCallIds: ["dimension-correction"],
    });
    expect((await session.snapshotIndex())?.rows.some((row) => row.type === "dimension")).toBe(
      true,
    );
    expect((await session.finish("")).evaluation).toBeDefined();
  });

  it("revalidates an unchanged closing record and keeps complete feedback", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(async () => ({
      status: "valid",
    }));
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const records = requiredFixtureRecords();
    const calls = records.map((record, index) => fixtureCall(`complete-${index}`, record));
    await session.capability.prepareBatch({
      batchId: "complete-before-repeat",
      toolCalls: calls,
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
    });
    const closingCall = calls.at(-1)!;
    expect(session.capability.receipt(closingCall.toolCallId)).toMatchObject({
      status: "admitted",
      complete: true,
      remaining: [],
    });
    await session.capability.settle({
      batchId: "complete-before-repeat",
      toolCallIds: calls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: calls.map(({ toolCallId }) => toolCallId),
    });

    const repeated = fixtureCall("repeat-closing-record", records.at(-1)!);
    await session.capability.prepareBatch({
      batchId: "repeat-complete-closing-record",
      toolCalls: [repeated],
      authorizedToolCallIds: [repeated.toolCallId],
    });
    expect(session.capability.receipt(repeated.toolCallId)).toMatchObject({
      status: "unchanged",
      complete: true,
      remaining: [],
    });
    expect(validateCompletion).toHaveBeenCalledTimes(2);
  });

  it("keeps an unchanged record incomplete while host-derived evaluation remains open", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(async () => ({
      status: "valid",
    }));
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, true);
    const records = requiredFixtureRecords();
    const calls = records.map((record, index) => fixtureCall(`open-${index}`, record));
    await session.capability.prepareBatch({
      batchId: "open-before-repeat",
      toolCalls: calls,
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
    });
    const closingCall = calls.at(-1)!;
    expect(session.capability.receipt(closingCall.toolCallId)).toMatchObject({
      status: "admitted",
      complete: false,
      open: ["layer-one"],
    });
    await session.capability.settle({
      batchId: "open-before-repeat",
      toolCallIds: calls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: calls.map(({ toolCallId }) => toolCallId),
    });

    const repeated = fixtureCall("repeat-open-closing-record", records.at(-1)!);
    await session.capability.prepareBatch({
      batchId: "repeat-open-closing-record",
      toolCalls: [repeated],
      authorizedToolCallIds: [repeated.toolCallId],
    });
    expect(session.capability.receipt(repeated.toolCallId)).toMatchObject({
      status: "unchanged",
      complete: false,
      open: ["layer-one"],
    });
    expect(validateCompletion).not.toHaveBeenCalled();
  });

  it("does not promote an unchanged closing record when whole-artifact validation refuses it", async () => {
    const validateRecords: ValidateAnswerRecords = async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const }));
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(async () => ({
      status: "valid",
    }));
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const records = requiredFixtureRecords();
    const calls = records.map((record, index) => fixtureCall(`valid-${index}`, record));
    await session.capability.prepareBatch({
      batchId: "valid-before-rejected-repeat",
      toolCalls: calls,
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
    });
    await session.capability.settle({
      batchId: "valid-before-rejected-repeat",
      toolCallIds: calls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: calls.map(({ toolCallId }) => toolCallId),
      successfulToolCallIds: calls.map(({ toolCallId }) => toolCallId),
    });

    validateCompletion.mockResolvedValueOnce({
      status: "refused",
      owner: { kind: "record", type: "evaluation-note", key: "singleton" },
      code: "evaluation-profile-semantics",
      location: "$.evaluation.findings",
    });
    const repeated = fixtureCall("rejected-closing-repeat", records.at(-1)!);
    await session.capability.prepareBatch({
      batchId: "reject-complete-closing-repeat",
      toolCalls: [repeated],
      authorizedToolCallIds: [repeated.toolCallId],
    });
    expect(session.capability.receipt(repeated.toolCallId)).toMatchObject({
      status: "refused",
      complete: false,
      type: "evaluation-note",
      key: "singleton",
      remaining: ["evaluation-note"],
    });
    await session.capability.settle({
      batchId: "reject-complete-closing-repeat",
      toolCallIds: [repeated.toolCallId],
      authorizedToolCallIds: [repeated.toolCallId],
      successfulToolCallIds: [],
    });
    expect((await session.snapshotIndex())?.rows).not.toContainEqual(
      expect.objectContaining({ type: "evaluation-note", key: "singleton" }),
    );
  });

  it("limits completion validation to the lease-authorized prefix", async () => {
    const validateRecords = vi.fn<ValidateAnswerRecords>(async (records) =>
      records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
    );
    const validateCompletion = vi.fn<ValidateAnswerRecordCompletion>(
      async ({ records, currentCalls }) => {
        expect(records.some(({ type }) => type === "layer-note")).toBe(false);
        expect(currentCalls.some(({ toolCallId }) => toolCallId === "withheld-layer-note")).toBe(
          false,
        );
        return { status: "valid" as const };
      },
    );
    const session = await makeCompleteAdmission(validateRecords, validateCompletion, false);
    const records = requiredFixtureRecords();
    const authorizedCalls = records.map((record, index) => fixtureCall(`prefix-${index}`, record));
    const suffix = fixtureCall("withheld-layer-note", {
      type: "layer-note",
      key: "layer-one",
      record: validLayerNoteRecord(),
    });
    const allCalls = [...authorizedCalls, suffix];
    const authorizedIds = authorizedCalls.map(({ toolCallId }) => toolCallId);
    await session.capability.prepareBatch({
      batchId: "authorized-prefix-only",
      toolCalls: allCalls,
      authorizedToolCallIds: authorizedIds,
    });
    expect(
      session.capability.receipt("prefix-4"),
      receiptSummary(session.capability.receipt("prefix-4")),
    ).toMatchObject({ complete: true });
    expect(validateCompletion).toHaveBeenCalledTimes(1);
    await session.capability.settle({
      batchId: "authorized-prefix-only",
      toolCallIds: allCalls.map(({ toolCallId }) => toolCallId),
      authorizedToolCallIds: authorizedIds,
      successfulToolCallIds: authorizedIds,
    });
    expect((await session.snapshotIndex())?.rows.some((row) => row.type === "layer-note")).toBe(
      false,
    );
  });
});
