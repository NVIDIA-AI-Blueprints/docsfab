// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Host-side admission for the generated quality-evaluation records contract. */

import { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
import {
  OUTPUT_RULE_HINTS,
  OUTPUT_RULES,
  OUTPUT_RECORD_CONTRACTS,
} from "../contracts/model-output.js";
import type {
  AnswerRecordContinuationCheckpointV1,
  AnswerRecordContinuationCheckpointEnvelopeV1,
  AnswerRecordLedgerIndexV1,
} from "../records/contracts.js";
import { containsConfiguredCredentialInBytes } from "../security/configured-credentials.js";
import {
  isRetainableInferenceRejection,
  retainedInferenceRejection,
} from "../config/inference-rejection-limits.js";
import { opaqueRecordDigest, type DurableArtifactStore } from "../artifacts/store.js";
import {
  admitAnswerRecordCall,
  assembleAnswerRecords,
  createAnswerRecordLedger,
  decodeAnswerRecordCall,
  remainingAnswerRecordKeys,
  type AnswerRecordCode,
  type AnswerRecordLedger,
  type AnswerRecordReceipt,
  type AnswerRecordRow,
  type AnswerRecordPlan,
  type AnswerRecordAssemblyInput,
} from "./answer-records.js";
import type { HostMintedValues } from "./answer-record-fill.js";
import {
  assessCandidate,
  shapeFor,
  validatePreparedOutcomes,
  validateStoredCandidate,
} from "./quality-answer-record-admission/candidate-validation.js";
import type { JsonEvidenceValue } from "../json-evidence.js";
import type {
  QualityAnswerRecordReplayPairV1,
  QualityAnswerRecordSessionV1,
} from "../execution/contracts.js";
import { QualityHostCheckError } from "../evaluation-report/quality-check-rejections.js";
import type { LockedQualityCompletionRefusalCode } from "../evaluation-report/quality-validator-host.js";
export {
  canonicalAdmissionHostFailureReason,
  qualityAnswerRecordAdmissionFailureMessage,
} from "./quality-answer-record-admission/refusal-support.js";
import { failClosed, failKit, kit } from "./quality-answer-record-admission/refusal-support.js";

const DECLARATION = OUTPUT_RECORD_CONTRACTS["quality-evaluation"];
const ROW_KIND = "docsfab-answer-record";
const ROW_DIGEST = "recordSha256";
const CHECKPOINT_KIND = "docsfab-answer-record-continuation-checkpoint";
const CHECKPOINT_DIGEST = "recordSha256";
const REFUSAL_CALL_CHARGE = "\u0000call";
const REFUSAL_NEW_OPEN_KEY = "\u0000new";
const BINDING_KEYS = [
  "declarationSha256",
  "schemaSha256s",
  "profilePayloadSha256",
  "selectionSha256",
  "referenceSourceSha256s",
  "evaluatorIdentitySha256",
  "compositionSha256",
  "answerPathCapabilitySha256",
] as const;

export interface QualityAnswerRecordBindingsV1 {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly declarationSha256: string;
  readonly schemaSha256s: Readonly<Record<string, string>>;
  readonly profilePayloadSha256: string;
  readonly selectionSha256: string;
  readonly referenceSourceSha256s: Readonly<Record<string, string>>;
  readonly evaluatorIdentitySha256: string;
  readonly compositionSha256: string;
  readonly answerPathCapabilitySha256: string;
}

export interface QualityAnswerRecordNarrowingV1 {
  readonly profilePayloadSha256: string;
  readonly selectionSha256: string;
  readonly qualityPolicySha256: string;
  readonly requiredDimensionIds: readonly string[];
  readonly hardGateIds: readonly string[];
  readonly confidenceAnchors: readonly number[];
  readonly d3ResidualDecisions: readonly string[];
  readonly qualityEvaluationTargetPaths: readonly string[];
}

export interface QualityAnswerRecordValidationCandidateV1 {
  readonly toolCallId: string;
  readonly type: string;
  readonly key: string | null;
  readonly record: JsonEvidenceValue;
}

export type QualityAnswerRecordValidationOutcomeV1 =
  | { readonly toolCallId: string; readonly status: "valid" }
  | {
      readonly toolCallId: string;
      readonly status: "refused";
      readonly code: AnswerRecordCode | LockedQualityCompletionRefusalCode;
      readonly location: string;
    };

export type QualityAnswerRecordOutputCode = AnswerRecordCode | LockedQualityCompletionRefusalCode;
export type QualityAnswerRecordReceiptV1 = Omit<AnswerRecordReceipt, "code"> & {
  readonly code?: QualityAnswerRecordOutputCode;
  readonly open?: readonly string[];
};

export interface QualityAnswerRecordAdmissionInputV1 {
  readonly store: DurableArtifactStore;
  readonly declaration: typeof DECLARATION;
  readonly bindings: QualityAnswerRecordBindingsV1;
  readonly plan: AnswerRecordPlan;
  readonly hostMinted: HostMintedValues;
  readonly references: Readonly<Record<string, unknown>>;
  readonly referenceIds: Readonly<Record<string, readonly string[]>>;
  readonly renderReference: (namespace: string, ids: readonly string[]) => readonly unknown[];
  readonly derive: AnswerRecordAssemblyInput["derive"];
  readonly recordNarrowing: QualityAnswerRecordNarrowingV1;
  readonly validateRecords: (
    records: readonly QualityAnswerRecordValidationCandidateV1[],
  ) => Promise<readonly QualityAnswerRecordValidationOutcomeV1[]>;
  /** Discovery runs retain correctable refusals until the provider envelope ends. */
  readonly nonExhaustingRefusals?: boolean;
  /** Physical run whose persisted checkpoint pointer selected the restored state. */
  readonly sourceRunId?: string;
  /** Physical run identity required on the exact checkpoint selected for restore. */
  readonly restoreSourceRunId?: string;
  readonly onCheckpoint?: (
    checkpoint: AnswerRecordContinuationCheckpointEnvelopeV1,
    sha256: string,
    index: AnswerRecordLedgerIndexV1,
  ) => Promise<void>;
  readonly validateCompletion: (candidate: {
    readonly evaluation: Record<string, unknown>;
    readonly qualityScore: Record<string, unknown> | null;
    readonly closingToolCallId?: string;
    readonly records: readonly {
      readonly type: string;
      readonly key: string;
      readonly record: JsonEvidenceValue;
    }[];
    readonly currentCalls: readonly {
      readonly toolCallId: string;
      readonly type: string;
      readonly key: string | null;
    }[];
  }) => Promise<
    | { readonly status: "valid" }
    | {
        readonly status: "refused";
        readonly owner:
          | { readonly kind: "record"; readonly type: string; readonly key: string }
          | { readonly kind: "tool-call"; readonly toolCallId: string };
        readonly code: LockedQualityCompletionRefusalCode;
        readonly location: string;
        readonly feedback?: string;
      }
  >;
}

interface StoredAnswerRecordV1 {
  readonly contractId: "quality-evaluation";
  readonly contractVersion: number;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly type: string;
  readonly key: string;
  readonly state: "admitted" | "released";
  readonly bindings: Omit<QualityAnswerRecordBindingsV1, "runId" | "stepId" | "attempt">;
  readonly payloadSha256: string;
  readonly payload: JsonEvidenceValue;
}

interface PreparedCall {
  readonly toolCallId: string;
  readonly rawArguments: string | undefined;
  readonly candidate?: QualityAnswerRecordValidationCandidateV1;
  readonly receipt: QualityAnswerRecordReceiptV1;
  readonly persistable: boolean;
  readonly credentialRejected?: boolean;
  readonly releaseOwner?: { readonly type: string; readonly key: string };
  readonly validatedLedgerIdentity?: string;
}

interface PreparedBatch {
  readonly batchId: string;
  readonly digest: string;
  readonly orderedIds: readonly string[];
  readonly authorizedIds: readonly string[];
  readonly calls: ReadonlyMap<string, PreparedCall>;
}

function ledgerIdentity(ledger: AnswerRecordLedger): string {
  return canonicalDigest(
    [...ledger.rows.values()]
      .map((row) => ({ type: row.type, key: row.key, payloadSha256: row.payloadSha256 }))
      .sort((left, right) =>
        left.type === right.type
          ? left.key.localeCompare(right.key)
          : left.type.localeCompare(right.type),
      ),
  );
}

interface RefusalExhaustion {
  type: string | null;
  key: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function refusalCharge(
  type: string | null,
  key: string | null,
  plan: AnswerRecordPlan,
  issued: ReadonlyMap<string, number>,
): string {
  if (type === null) return REFUSAL_CALL_CHARGE;
  const planned = plan.types.get(type);
  if (!planned) return REFUSAL_CALL_CHARGE;
  if (planned.declaration.key === "singleton") {
    return key === null || key === "singleton" ? `${type}\u0000singleton` : REFUSAL_CALL_CHARGE;
  }
  if (planned.declaration.open) {
    const serial =
      key === null ? null : new RegExp(`^${planned.serialPrefix}-([1-9][0-9]*)$`, "u").exec(key);
    const highWater = issued.get(type) ?? 0;
    return serial && Number(serial[1]) <= highWater
      ? `${type}\u0000${key}`
      : `${type}\u0000${REFUSAL_NEW_OPEN_KEY}`;
  }
  return planned.keys.some((entry) => entry.key === key)
    ? `${type}\u0000${key}`
    : REFUSAL_CALL_CHARGE;
}

function refusalAddress(charge: string): RefusalExhaustion {
  if (charge === REFUSAL_CALL_CHARGE) return { type: null, key: null };
  const separator = charge.indexOf("\u0000");
  const type = charge.slice(0, separator);
  const key = charge.slice(separator + 1);
  return { type, key: key === REFUSAL_NEW_OPEN_KEY ? null : key };
}

function withoutAnswerRow(
  ledger: AnswerRecordLedger,
  type: string,
  key: string,
): AnswerRecordLedger {
  const rows = new Map(ledger.rows);
  rows.delete(`${type}\u0000${key}`);
  return { ...ledger, rows };
}

function serializeAnswerRow(
  plan: AnswerRecordPlan,
  row: AnswerRecordRow,
  shellForProvider = false,
): string {
  const planned = plan.types.get(row.type);
  if (!planned) return failKit("row-type-missing");
  return canonicalJson({
    type: row.type,
    ...(planned.declaration.key === "singleton" ? {} : { key: row.key }),
    // Tool parameters accept object|string and some serving shells normalize
    // JSON null away. A replay must therefore carry the one-level JSON text
    // "null" for nullable singleton rows, while host ledger rebuilds keep the
    // decoded null payload.
    record: shellForProvider && row.payload === null ? "null" : row.payload,
  });
}

function accountRefusal(
  initial: QualityAnswerRecordReceiptV1,
  currentLedger: AnswerRecordLedger,
  counts: Map<string, number>,
  plan: AnswerRecordPlan,
  exhaustion: { value: RefusalExhaustion | null },
  nonExhaustingRefusals = false,
): QualityAnswerRecordReceiptV1 {
  const denied = exhaustion.value ?? { type: initial.type, key: initial.key };
  const charge = refusalCharge(denied.type, denied.key, plan, currentLedger.issued);
  const used = counts.get(charge) ?? 0;
  counts.set(charge, used + 1);
  if (nonExhaustingRefusals || (exhaustion.value === null && used < plan.maxRefusalsPerKey)) {
    return { ...initial, remaining: remainingAnswerRecordKeys(currentLedger), complete: false };
  }
  if (exhaustion.value === null) exhaustion.value = refusalAddress(charge);
  const code = "answer-record-exhausted" as AnswerRecordCode;
  const rule = (
    OUTPUT_RULES as Readonly<Record<string, { retry: "model-correctable" | "terminal" }>>
  )[code];
  return {
    status: "refused",
    type: exhaustion.value.type,
    key: exhaustion.value.key,
    code,
    location: "$",
    retry: rule?.retry ?? "terminal",
    feedback: OUTPUT_RULE_HINTS[code]?.rule,
    remaining: remainingAnswerRecordKeys(currentLedger),
    complete: false,
  };
}

function validateBindings(input: QualityAnswerRecordAdmissionInputV1): void {
  const { bindings, recordNarrowing, declaration, plan } = input;
  if (
    declaration !== DECLARATION ||
    plan.declaration !== declaration ||
    canonicalDigest(declaration) !== bindings.declarationSha256
  )
    failKit("declaration-mismatch");
  if (
    !bindings.runId ||
    !bindings.stepId ||
    !Number.isSafeInteger(bindings.attempt) ||
    bindings.attempt < 1
  ) {
    failKit("binding-identity");
  }
  for (const name of BINDING_KEYS) {
    if (name === "schemaSha256s" || name === "referenceSourceSha256s") continue;
    if (!hash(bindings[name])) failKit("binding-hash");
  }
  if (
    !isRecord(bindings.schemaSha256s) ||
    Object.keys(bindings.schemaSha256s).length === 0 ||
    Object.values(bindings.schemaSha256s).some((value) => !hash(value))
  )
    failKit("schema-hashes");
  if (
    Object.keys(declaration.canonical.members).some((name) => !hash(bindings.schemaSha256s[name]))
  ) {
    failKit("canonical-schema-binding");
  }
  if (
    !isRecord(bindings.referenceSourceSha256s) ||
    Object.values(bindings.referenceSourceSha256s).some((value) => !hash(value))
  )
    failKit("reference-hashes");
  const namespaces = declaration.references.map((reference) => reference.namespace).sort();
  const referenceHashNames = Object.keys(bindings.referenceSourceSha256s).sort();
  const referenceIdNames = Object.keys(input.referenceIds).sort();
  const referenceValueNames = declaration.references
    .filter((reference) => reference.field !== null)
    .map((reference) => reference.namespace)
    .sort();
  if (
    canonicalJson(referenceHashNames) !== canonicalJson(namespaces) ||
    canonicalJson(referenceIdNames) !== canonicalJson(namespaces) ||
    canonicalJson(Object.keys(input.references).sort()) !== canonicalJson(referenceValueNames)
  )
    failKit("reference-provenance-set");
  for (const ids of Object.values(input.referenceIds)) {
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(ids).size !== ids.length
    ) {
      failKit("reference-id-set");
    }
  }
  if (
    recordNarrowing.profilePayloadSha256 !== bindings.profilePayloadSha256 ||
    recordNarrowing.selectionSha256 !== bindings.selectionSha256 ||
    !Object.values(bindings.schemaSha256s).includes(recordNarrowing.qualityPolicySha256)
  ) {
    failKit("narrowing-binding-mismatch");
  }
  for (const values of [
    recordNarrowing.requiredDimensionIds,
    recordNarrowing.hardGateIds,
    recordNarrowing.d3ResidualDecisions,
    recordNarrowing.qualityEvaluationTargetPaths,
  ]) {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || value.length === 0) ||
      new Set(values).size !== values.length
    )
      failKit("narrowing-values");
  }
  if (
    !Array.isArray(recordNarrowing.confidenceAnchors) ||
    recordNarrowing.confidenceAnchors.some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1,
    ) ||
    new Set(recordNarrowing.confidenceAnchors).size !== recordNarrowing.confidenceAnchors.length
  )
    failKit("confidence-anchors");
  kit.assertInert({ bindings, recordNarrowing });
  kit.rejectCredentials({ bindings, recordNarrowing });
  // Host-minted providers are trusted functions. Their returned values are
  // screened when assembly invokes them, rather than rejecting the functions.
  kit.assertInert({ references: input.references, referenceIds: input.referenceIds });
  kit.rejectCredentials({ references: input.references, referenceIds: input.referenceIds });
}

function makeIndex(
  rows: readonly AnswerRecordRow[],
  bindings: Omit<QualityAnswerRecordBindingsV1, "runId" | "stepId" | "attempt">,
  attempt: number,
  addresses: ReadonlyMap<
    string,
    {
      readonly digest: string;
      readonly payloadSha256: string;
      readonly state: "admitted" | "released";
      readonly attempt: number;
    }
  >,
  checkpoint?: { readonly sha256: string; readonly sequence: number; readonly attempt: number },
  progress?: AnswerRecordLedgerIndexV1["progress"],
): AnswerRecordLedgerIndexV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-answer-record-ledger-index",
    contractId: "quality-evaluation",
    bindingsSha256: canonicalDigest(bindings),
    rows: rows.map((row) => {
      const stored = addresses.get(`${row.type}\u0000${row.key}`);
      if (!stored || stored.payloadSha256 !== row.payloadSha256) {
        return failKit("index-address-missing");
      }
      return {
        type: row.type as AnswerRecordLedgerIndexV1["rows"][number]["type"],
        key: row.key,
        recordSha256: stored.digest,
        state: stored.state,
        attempt: stored.attempt ?? attempt,
      };
    }),
    ...(checkpoint ? { checkpoint } : {}),
    ...(progress ? { progress } : {}),
  };
}

function checkpointProgress(
  checkpoint: AnswerRecordContinuationCheckpointV1,
  ledger: AnswerRecordLedger,
): NonNullable<AnswerRecordLedgerIndexV1["progress"]> {
  const remainingKeyCount = remainingAnswerRecordKeys(ledger).length;
  return {
    admittedRowCount: checkpoint.rows.length,
    releasedRowCount: checkpoint.tombstones.filter((entry) => entry.reasonCode === "released")
      .length,
    remainingKeyCount,
    refusalEventCount: Object.values(checkpoint.refusalCounts).reduce(
      (sum, count) => sum + count,
      0,
    ),
    complete: checkpoint.complete,
    checkpointSequence: checkpoint.sequence,
    logicalRunId: checkpoint.logicalRunId,
    sourceRunId: checkpoint.sourceRunId,
    sourceAttemptHighWater: checkpoint.sourceAttemptHighWater,
  };
}

function refusalDiagnosticId(code: string, location: string): string {
  return canonicalJson([code, location]);
}

function renderPromptGuidance(
  plan: AnswerRecordPlan,
  narrowing: QualityAnswerRecordNarrowingV1,
): string {
  const declaredRecords = [...plan.types.entries()].map(([type, planned]) => {
    const keys = planned.keys.map(({ key }) => key);
    const count = planned.declaration.open
      ? `open set (up to ${plan.maxOpenRecordsPerSet} records)`
      : `${keys.length || 1} planned record${(keys.length || 1) === 1 ? "" : "s"}`;
    const keyDescription = planned.declaration.open
      ? "new records use key null; use a returned key to replace or withdraw an issued record"
      : keys.length
        ? `keys: ${keys.join(", ")}`
        : "singleton; omit the key field or use key null";
    const shapeVariants = new Map<
      string,
      {
        readonly id: string;
        readonly at: string | null;
        readonly schema: Readonly<Record<string, unknown>>;
      }
    >();
    let nextShapeId = 1;
    const variantFor = (key: string | null, at: string | null) => {
      const schema = shapeFor(plan, { toolCallId: "", type, key, record: null });
      const keyLabel = key;
      if (!schema) return { key: keyLabel, shapeId: "unavailable" };
      const identity = canonicalJson({ at, schema });
      let variant = shapeVariants.get(identity);
      if (!variant) {
        variant = { id: `S${nextShapeId++}`, at, schema };
        shapeVariants.set(identity, variant);
      }
      return { key: keyLabel, shapeId: variant.id };
    };
    const plannedShapes = planned.keys.length
      ? planned.keys.map((entry) =>
          variantFor(entry.key, planned.declaration.shapes[entry.shape]?.at ?? null),
        )
      : planned.declaration.shapes.map((shape) => variantFor(null, shape.at));
    return [
      `- ${type}: ${planned.declaration.optional ? "optional" : "required"}; ${count}; ${keyDescription}.`,
      ...(plannedShapes.length
        ? [`  Keys and shape variants: ${canonicalJson(plannedShapes)}`]
        : []),
      ...(shapeVariants.size
        ? [
            `  Shape variant${shapeVariants.size === 1 ? "" : "s"}: ${canonicalJson([...shapeVariants.values()])}`,
          ]
        : []),
    ].join("\n");
  });
  const guidance = [
    "Quality answer-record guidance:",
    "Submit one record per call; multiple calls per turn are supported. Each submission must be a complete record replacement, not a partial field patch. Use the declared type, key, and shape below. Read each host receipt and correct a refused record before finalizing.",
    ...declaredRecords,
    `Required dimensions: ${narrowing.requiredDimensionIds.join(", ") || "none"}.`,
    `Confidence anchors: ${narrowing.confidenceAnchors.join(", ") || "none"}.`,
    `Allowed hard-gate IDs: ${narrowing.hardGateIds.join(", ") || "none"}.`,
    `Allowed D3 residual decisions: ${narrowing.d3ResidualDecisions.join(", ") || "none"}.`,
    `Allowed quality-evaluation target paths: ${narrowing.qualityEvaluationTargetPaths.join(", ") || "none"}.`,
    "Host-minted provenance and references are authoritative; do not claim host provider IDs in model-authored evidence.",
    "For a finding that links admitted evidence, put its FACT and TECH reference IDs in record.originating_ids as a string array; the host renders evidence from those references. Mentioning an ID in prose or acceptance_condition does not create a reference.",
    "After record receipts indicate completion, provide the final report as Markdown only.",
  ].join("\n");
  kit.assertInert(guidance);
  kit.rejectCredentials(guidance);
  return guidance;
}

function screenedHostMinted(values: HostMintedValues): HostMintedValues {
  const screened: Record<string, unknown> = {};
  for (const [source, provider] of Object.entries(values)) {
    if (typeof provider === "function") {
      screened[source] = (field: string) => {
        const produced = (provider as (field: string) => unknown)(field);
        kit.assertInert(produced);
        kit.rejectCredentials(produced);
        return produced;
      };
    } else {
      kit.assertInert(provider);
      kit.rejectCredentials(provider);
      screened[source] = provider;
    }
  }
  return screened as HostMintedValues;
}

export function createQualityAnswerRecordAdmission(
  input: QualityAnswerRecordAdmissionInputV1,
): QualityAnswerRecordSessionV1 {
  validateBindings(input);
  const { store, bindings } = input;
  const admitCall = (currentLedger: AnswerRecordLedger, raw: string | undefined) =>
    admitAnswerRecordCall(currentLedger, raw, {
      exhaustPerKeyRefusals: input.nonExhaustingRefusals !== true,
    });
  const trackRefusal = (
    initial: QualityAnswerRecordReceiptV1,
    currentLedger: AnswerRecordLedger,
    counts: Map<string, number>,
    plan: AnswerRecordPlan,
    exhaustion: { value: RefusalExhaustion | null },
  ) =>
    accountRefusal(initial, currentLedger, counts, plan, exhaustion, input.nonExhaustingRefusals);
  const promptGuidance = renderPromptGuidance(input.plan, input.recordNarrowing);
  let restoredCompletionGuidance: string | undefined;
  let ledger = createAnswerRecordLedger(input.plan);
  let refusalCounts = new Map<string, number>();
  let refusalDiagnostics = new Map<
    string,
    { readonly code: string; readonly location: string; readonly count: number }
  >();
  let refusalExhaustion: RefusalExhaustion | null = null;
  let activeBatch: PreparedBatch | undefined;
  const batches = new Map<string, PreparedBatch>();
  const settledBatches = new Map<string, string>();
  let settledReportReady = false;
  let pendingRestoredRepairPublication = false;
  const tombstones: {
    type: string;
    key: string;
    reasonCode: string;
    settlementSequence: number;
  }[] = [];
  let settlementSequence = 0;
  let latestCheckpointValue:
    | { readonly record: AnswerRecordContinuationCheckpointEnvelopeV1; readonly sha256: string }
    | undefined;
  const persisted = new Map<
    string,
    {
      readonly digest: string;
      readonly payloadSha256: string;
      readonly state: "admitted" | "released";
      readonly attempt: number;
    }
  >();
  let publicationFailure: unknown;
  let restoredCheckpointWasStale = false;
  const captureControlState = () => ({
    ledger: {
      ...ledger,
      rows: new Map(ledger.rows),
      issued: new Map(ledger.issued),
    },
    refusalCounts: new Map(refusalCounts),
    refusalDiagnostics: new Map(refusalDiagnostics),
    refusalExhaustion: refusalExhaustion ? { ...refusalExhaustion } : null,
    tombstones: tombstones.map((entry) => ({ ...entry })),
    persisted: new Map(persisted),
    settledBatches: new Map(settledBatches),
    settlementSequence,
    settledReportReady,
    restoredCompletionGuidance,
    pendingRestoredRepairPublication,
  });
  let committedControlState = captureControlState();
  const restoreCommittedControlState = (): void => {
    ledger = committedControlState.ledger;
    refusalCounts = new Map(committedControlState.refusalCounts);
    refusalDiagnostics = new Map(committedControlState.refusalDiagnostics);
    refusalExhaustion = committedControlState.refusalExhaustion
      ? { ...committedControlState.refusalExhaustion }
      : null;
    tombstones.splice(0, tombstones.length, ...committedControlState.tombstones);
    persisted.clear();
    for (const [key, value] of committedControlState.persisted) persisted.set(key, value);
    settledBatches.clear();
    for (const [key, value] of committedControlState.settledBatches) settledBatches.set(key, value);
    settlementSequence = committedControlState.settlementSequence;
    settledReportReady = committedControlState.settledReportReady;
    restoredCompletionGuidance = committedControlState.restoredCompletionGuidance;
    pendingRestoredRepairPublication = committedControlState.pendingRestoredRepairPublication;
    activeBatch = undefined;
  };
  const assertPublicationHealthy = (): void => {
    if (publicationFailure !== undefined) throw publicationFailure;
  };

  const bindingBody = {
    declarationSha256: bindings.declarationSha256,
    schemaSha256s: bindings.schemaSha256s,
    profilePayloadSha256: bindings.profilePayloadSha256,
    selectionSha256: bindings.selectionSha256,
    referenceSourceSha256s: bindings.referenceSourceSha256s,
    evaluatorIdentitySha256: bindings.evaluatorIdentitySha256,
    compositionSha256: bindings.compositionSha256,
    answerPathCapabilitySha256: bindings.answerPathCapabilitySha256,
  };

  async function publishCheckpoint(): Promise<void> {
    const predecessor = latestCheckpointValue;
    settlementSequence += 1;
    const record: AnswerRecordContinuationCheckpointV1 = {
      schemaVersion: 1,
      kind: "docsfab-answer-record-continuation-checkpoint",
      continuationId: canonicalDigest({
        runId: bindings.runId,
        stepId: bindings.stepId,
        bindings: bindingBody,
      }),
      sequence: (predecessor?.record.sequence ?? 0) + 1,
      predecessorCheckpointSha256: predecessor?.sha256 ?? null,
      sourceRunId: input.sourceRunId ?? bindings.runId,
      logicalRunId: bindings.runId,
      stepId: bindings.stepId,
      sourceAttemptHighWater: Math.max(
        bindings.attempt,
        predecessor?.record.sourceAttemptHighWater ?? 0,
      ),
      bindingsSha256: canonicalDigest(bindingBody),
      bindings: bindingBody,
      rows: [...persisted.entries()]
        .filter(([, value]) => value.state === "admitted")
        .map(([rowId, value]) => {
          const separator = rowId.indexOf("\u0000");
          if (separator < 1) return failKit("checkpoint-row-address");
          return {
            type: rowId.slice(
              0,
              separator,
            ) as AnswerRecordContinuationCheckpointV1["rows"][number]["type"],
            key: rowId.slice(separator + 1),
            recordSha256: value.digest,
            payloadSha256: value.payloadSha256,
            originalAttempt: value.attempt,
          };
        }),
      // The checkpoint contract is closed over every declared open type. Keep
      // untouched open sets explicit at zero so a checkpoint produced by this
      // publisher always passes the same closed decoder used on restore.
      issuedKeyHighWater: Object.fromEntries(
        [...input.plan.types.entries()]
          .filter(([, planned]) => planned.declaration.open)
          .map(([type]) => [type, ledger.issued.get(type) ?? 0]),
      ),
      tombstones: [...tombstones],
      refusalCounts: Object.fromEntries(refusalCounts),
      refusalDiagnostics: [...refusalDiagnostics.values()].sort(
        (left, right) =>
          left.code.localeCompare(right.code) || left.location.localeCompare(right.location),
      ),
      refusalExhaustion: refusalExhaustion ? { ...refusalExhaustion } : null,
      settledBatchHighWater: settlementSequence,
      complete: remainingAnswerRecordKeys(ledger).length === 0,
    };
    kit.assertInert(record);
    kit.rejectCredentials(record);
    const sealed = kit.seal(CHECKPOINT_KIND, CHECKPOINT_DIGEST, record);
    const sha256 = opaqueRecordDigest(sealed);
    await store.putRecord(sha256, sealed);
    const verified = await store.getRecord(sha256);
    if (opaqueRecordDigest(verified) !== sha256) failKit("checkpoint-address");
    const decoded = kit.decodeSealed(
      verified,
      CHECKPOINT_KIND,
      CHECKPOINT_DIGEST,
      [
        "continuationId",
        "sequence",
        "predecessorCheckpointSha256",
        "sourceRunId",
        "logicalRunId",
        "stepId",
        "sourceAttemptHighWater",
        "bindingsSha256",
        "bindings",
        "rows",
        "issuedKeyHighWater",
        "tombstones",
        "refusalCounts",
        "refusalDiagnostics",
        "refusalExhaustion",
        "settledBatchHighWater",
        "complete",
      ],
      (body) => body as unknown as AnswerRecordContinuationCheckpointV1,
    ) as unknown as AnswerRecordContinuationCheckpointEnvelopeV1;
    const rows = await reloadRows();
    const pointer = { sha256, sequence: decoded.sequence, attempt: bindings.attempt };
    const index = makeIndex(
      rows,
      bindingBody,
      bindings.attempt,
      persisted,
      pointer,
      checkpointProgress(decoded, ledger),
    );
    try {
      await input.onCheckpoint?.(decoded, sha256, index);
    } catch (error) {
      publicationFailure = error;
      restoreCommittedControlState();
      throw error;
    }
    latestCheckpointValue = { record: decoded, sha256 };
    committedControlState = captureControlState();
  }

  async function reloadRows(): Promise<AnswerRecordRow[]> {
    const rows: AnswerRecordRow[] = [];
    for (const [rowId, { digest, payloadSha256, state, attempt: originalAttempt }] of persisted) {
      const value = await store.getRecord(digest);
      if (opaqueRecordDigest(value) !== digest) failKit("stored-row-address");
      kit.assertInert(value);
      kit.rejectCredentials(value);
      const decoded = kit.decodeSealed(
        value,
        ROW_KIND,
        ROW_DIGEST,
        [
          "contractId",
          "contractVersion",
          "runId",
          "stepId",
          "attempt",
          "type",
          "key",
          "state",
          "bindings",
          "payloadSha256",
          "payload",
        ],
        (body) => body as unknown as StoredAnswerRecordV1,
      );
      const body = decoded as unknown as StoredAnswerRecordV1;
      if (
        body.contractId !== "quality-evaluation" ||
        body.contractVersion !== input.declaration.version ||
        body.runId !== bindings.runId ||
        body.stepId !== bindings.stepId ||
        body.attempt !== originalAttempt ||
        canonicalJson(body.bindings) !== canonicalJson(bindingBody) ||
        body.payloadSha256 !== payloadSha256 ||
        canonicalDigest(body.payload) !== payloadSha256 ||
        typeof body.type !== "string" ||
        typeof body.key !== "string" ||
        (body.state !== "admitted" && body.state !== "released") ||
        body.state !== state ||
        rowId !== `${body.type}\u0000${body.key}`
      )
        failKit("stored-row-binding");
      kit.assertInert(body.payload);
      kit.rejectCredentials(body.payload);
      const candidate = {
        toolCallId: "persisted-row",
        type: body.type,
        key: body.key,
        record: body.payload,
      };
      validateStoredCandidate(input, candidate, failKit);
      rows.push({
        type: body.type,
        key: body.key,
        payload: body.payload,
        payloadSha256: body.payloadSha256,
      });
    }
    return rows;
  }

  async function releasePersistedRow(type: string, key: string): Promise<void> {
    const rowId = `${type}\u0000${key}`;
    const reference = persisted.get(rowId);
    if (reference?.state !== "admitted") return failKit("release-row-missing");
    await reloadRows();
    const value = await store.getRecord(reference.digest);
    if (opaqueRecordDigest(value) !== reference.digest) failKit("stored-row-address");
    kit.assertInert(value);
    kit.rejectCredentials(value);
    const decoded = kit.decodeSealed(
      value,
      ROW_KIND,
      ROW_DIGEST,
      [
        "contractId",
        "contractVersion",
        "runId",
        "stepId",
        "attempt",
        "type",
        "key",
        "state",
        "bindings",
        "payloadSha256",
        "payload",
      ],
      (sealedBody) => sealedBody as unknown as StoredAnswerRecordV1,
    );
    // `decodeSealed` returns the complete envelope as well as the body. Rebuild
    // the body explicitly so schemaVersion, kind, and the old recordSha256 do
    // not become part of the next seal's digest preimage.
    const body: StoredAnswerRecordV1 = {
      contractId: decoded.contractId,
      contractVersion: decoded.contractVersion,
      runId: decoded.runId,
      stepId: decoded.stepId,
      attempt: decoded.attempt,
      type: decoded.type,
      key: decoded.key,
      state: decoded.state,
      bindings: decoded.bindings,
      payloadSha256: decoded.payloadSha256,
      payload: decoded.payload,
    };
    if (
      body.contractId !== "quality-evaluation" ||
      body.contractVersion !== input.declaration.version ||
      body.runId !== bindings.runId ||
      body.stepId !== bindings.stepId ||
      body.attempt !== reference.attempt ||
      body.type !== type ||
      body.key !== key ||
      body.state !== "admitted" ||
      body.payloadSha256 !== reference.payloadSha256 ||
      canonicalDigest(body.payload) !== reference.payloadSha256 ||
      canonicalJson(body.bindings) !== canonicalJson(bindingBody)
    )
      failKit("release-row-binding");
    const released: StoredAnswerRecordV1 = { ...body, state: "released" };
    const sealed = kit.seal(ROW_KIND, ROW_DIGEST, released);
    const digest = opaqueRecordDigest(sealed);
    await store.putRecord(digest, sealed);
    persisted.set(rowId, { ...reference, digest, state: "released" });
    if (!tombstones.some((entry) => entry.type === type && entry.key === key)) {
      tombstones.push({
        type,
        key,
        reasonCode: "released",
        settlementSequence: settlementSequence + 1,
      });
    }
  }

  function validateOpenDerivedLayers(open: readonly string[]): void {
    kit.assertInert(open);
    kit.rejectCredentials(open);
    const plannedLayerIds = new Set(
      input.plan.types.get("layer-note")?.keys.map((entry) => entry.key) ?? [],
    );
    if (
      !Array.isArray(open) ||
      open.length === 0 ||
      open.some((entry) => typeof entry !== "string" || !plannedLayerIds.has(entry))
    )
      failKit("derivation-open-shape");
  }

  async function prepareBatch(batch: {
    readonly batchId: string;
    readonly toolCalls: readonly {
      readonly toolCallId: string;
      readonly rawArguments: string | undefined;
    }[];
    readonly authorizedToolCallIds: readonly string[];
  }): Promise<void> {
    assertPublicationHealthy();
    if (
      !batch.batchId ||
      batch.toolCalls.length === 0 ||
      batch.toolCalls.some((call) => !call.toolCallId) ||
      new Set(batch.toolCalls.map((call) => call.toolCallId)).size !== batch.toolCalls.length
    )
      failKit("batch-shape");
    const orderedIds = batch.toolCalls.map((call) => call.toolCallId);
    if (
      new Set(batch.authorizedToolCallIds).size !== batch.authorizedToolCallIds.length ||
      canonicalJson(batch.authorizedToolCallIds) !==
        canonicalJson(orderedIds.slice(0, batch.authorizedToolCallIds.length))
    )
      failKit("batch-authorization");
    const digest = canonicalDigest({
      toolCalls: batch.toolCalls,
      authorizedToolCallIds: batch.authorizedToolCallIds,
    });
    const existing = batches.get(batch.batchId);
    if (existing) {
      if (existing.digest !== digest) failKit("batch-drift");
      if (!settledBatches.has(batch.batchId)) activeBatch = existing;
      return;
    }
    if (activeBatch) failKit("overlapping-batch");
    settledReportReady = false;

    // Disclosure is checked against the exact captured bytes before parsing or invoking QVH.
    const clean = new Map<string, boolean>();
    const credentialRaw = new Set<string>();
    const authorizedSet = new Set(batch.authorizedToolCallIds);
    for (const call of batch.toolCalls) {
      const hasCredential =
        call.rawArguments !== undefined &&
        containsConfiguredCredentialInBytes(Buffer.from(call.rawArguments, "utf8"));
      if (hasCredential) credentialRaw.add(call.toolCallId);
      let safe = call.rawArguments !== undefined && !hasCredential;
      if (safe && call.rawArguments !== undefined) {
        try {
          kit.assertInert(call.rawArguments);
          kit.rejectCredentials(call.rawArguments);
        } catch {
          safe = false;
          credentialRaw.add(call.toolCallId);
        }
      }
      clean.set(call.toolCallId, safe);
    }

    let preview = ledger;
    const batchRefusalCounts = new Map(refusalCounts);
    const batchExhaustion = { value: refusalExhaustion ? { ...refusalExhaustion } : null };
    const work: PreparedCall[] = [];
    const candidates: QualityAnswerRecordValidationCandidateV1[] = [];
    for (const call of batch.toolCalls) {
      if (!authorizedSet.has(call.toolCallId)) continue;
      if (!clean.get(call.toolCallId)) {
        const denied = credentialRaw.has(call.toolCallId)
          ? {
              ...failClosed("answer-record-shape", "$", null, null),
              retry: "terminal" as const,
              feedback: undefined,
            }
          : admitCall(preview, undefined).receipt;
        work.push({
          toolCallId: call.toolCallId,
          rawArguments: call.rawArguments,
          receipt: denied,
          persistable: false,
          ...(credentialRaw.has(call.toolCallId) ? { credentialRejected: true } : {}),
        });
        continue;
      }
      const decoded = decodeAnswerRecordCall(input.plan, call.rawArguments);
      if ("refusal" in decoded) {
        const denied = admitCall(preview, call.rawArguments).receipt;
        work.push({
          toolCallId: call.toolCallId,
          rawArguments: call.rawArguments,
          receipt: denied,
          persistable: false,
        });
        continue;
      }
      const candidate = {
        toolCallId: call.toolCallId,
        type: decoded.call.type,
        key: decoded.call.key,
        record: decoded.call.record,
      };
      try {
        kit.assertInert(candidate.record);
        kit.rejectCredentials(candidate.record);
      } catch {
        const denied = failClosed("answer-record-shape", "$.record", candidate.type, candidate.key);
        work.push({
          toolCallId: call.toolCallId,
          rawArguments: call.rawArguments,
          candidate,
          receipt: { ...denied, retry: "terminal", feedback: undefined },
          persistable: false,
          credentialRejected: true,
        });
        continue;
      }
      const assessment = assessCandidate(input, preview, candidate, failClosed, failKit);
      if (!assessment.persistable) {
        work.push({
          toolCallId: call.toolCallId,
          rawArguments: call.rawArguments,
          candidate,
          receipt: assessment.receipt,
          persistable: false,
        });
        continue;
      }
      if (assessment.requiresValidation) candidates.push(candidate);
      work.push({
        toolCallId: call.toolCallId,
        rawArguments: call.rawArguments,
        candidate,
        receipt: assessment.receipt,
        persistable: true,
      });
    }

    // One canonical policy batch runs only after every candidate has passed raw and decoded disclosure screens.
    let outcomes: readonly QualityAnswerRecordValidationOutcomeV1[] = [];
    if (candidates.length) {
      try {
        outcomes = await input.validateRecords(candidates);
      } catch (error) {
        if (error instanceof QualityHostCheckError) throw error;
        return failKit("validator-infrastructure-failure");
      }
    }
    const outcomeById = validatePreparedOutcomes(outcomes, candidates, failKit);

    const calls = new Map<string, PreparedCall>();
    let candidateLedger = preview;
    const verifyCompletion = async (
      closingToolCallId: string,
      prefixLedger: AnswerRecordLedger,
      beforeClosingLedger: AnswerRecordLedger,
    ): Promise<void> => {
      const provisional = await assembleAnswerRecords({
        ledger: prefixLedger,
        hostMinted: screenedHostMinted(input.hostMinted),
        references: input.references,
        referenceIds: input.referenceIds,
        renderReference: input.renderReference,
        derive: input.derive,
      });
      if (provisional.status === "incomplete") return failKit("completion-ledger-drift");
      const closingCall = calls.get(closingToolCallId);
      if (!closingCall) return failKit("completion-call-missing");
      if (provisional.status === "open") {
        validateOpenDerivedLayers(provisional.open);
        calls.set(closingToolCallId, {
          ...closingCall,
          receipt: {
            ...closingCall.receipt,
            open: provisional.open,
            complete: false,
            feedback: "Resolve the listed host-derived quality layers before completion.",
          },
        });
        return;
      }
      const provisionalEvaluation = provisional.artifact.evaluation;
      const provisionalQualityScore = provisional.artifact.qualityScore;
      if (
        !isRecord(provisionalEvaluation) ||
        (provisionalQualityScore !== null && !isRecord(provisionalQualityScore))
      )
        return failKit("assembled-artifact-shape");
      kit.assertInert({ evaluation: provisionalEvaluation, qualityScore: provisionalQualityScore });
      kit.rejectCredentials({
        evaluation: provisionalEvaluation,
        qualityScore: provisionalQualityScore,
      });
      let validation: Awaited<ReturnType<typeof input.validateCompletion>>;
      try {
        validation = await input.validateCompletion({
          evaluation: provisionalEvaluation,
          qualityScore: provisionalQualityScore,
          closingToolCallId,
          records: [...prefixLedger.rows.values()].map((row) => ({
            type: row.type,
            key: row.key,
            record: row.payload,
          })),
          currentCalls: [...calls.values()]
            .filter((item) => item.candidate !== undefined)
            .map((item) => ({
              toolCallId: item.toolCallId,
              type: item.candidate!.type,
              key: item.candidate!.key,
            })),
        });
      } catch (error) {
        if (error instanceof QualityHostCheckError) throw error;
        return failKit("completion-validator-infrastructure-failure");
      }
      if (!validation || (validation.status !== "valid" && validation.status !== "refused"))
        return failKit("assembly-validator-outcome");
      if (validation.status === "refused") {
        let ownerCallId: string | undefined;
        let ownerType: string;
        let ownerKey: string | null;
        let releaseOwner: { type: string; key: string } | undefined;
        if (validation.owner.kind === "tool-call") {
          const owner = calls.get(validation.owner.toolCallId);
          if (!owner?.candidate || owner.receipt.status === "refused")
            return failKit("assembly-validator-owner");
          ownerCallId = owner.toolCallId;
          ownerType = owner.candidate.type;
          ownerKey = owner.receipt.key ?? owner.candidate.key;
        } else {
          ownerType = validation.owner.type;
          ownerKey = validation.owner.key;
          const ownerRowId = `${ownerType}\u0000${ownerKey}`;
          if (persisted.get(ownerRowId)?.state === "admitted") {
            releaseOwner = { type: ownerType, key: ownerKey };
          }
          const owner = [...calls.values()].find(
            (item) =>
              item.candidate?.type === ownerType &&
              (item.receipt.key ?? item.candidate.key) === ownerKey,
          );
          if (owner) {
            if (owner.receipt.status === "refused") return failKit("assembly-validator-owner");
            ownerCallId = owner.toolCallId;
          } else {
            if (!releaseOwner) return failKit("assembly-validator-owner");
            ownerCallId = closingToolCallId;
          }
        }
        const owner = calls.get(ownerCallId);
        if (!owner) return failKit("assembly-validator-owner");
        const ownerRow =
          ownerKey === null ? undefined : prefixLedger.rows.get(`${ownerType}\u0000${ownerKey}`);
        if (!ownerRow && !releaseOwner && validation.owner.kind === "record")
          return failKit("assembly-validator-owner");
        // A completion refusal is returned as an isError tool result. Pi therefore
        // settles the closing call as unsuccessful, so none of its provisional
        // candidate may survive in the next receipt's view. Restore the exact
        // pre-closing snapshot (which may include an earlier successful same-batch
        // value), then release the invalidated owner. For an owner in an earlier
        // current-message call, retain the closing candidate and remove only that
        // failed owner row.
        if (ownerCallId === closingToolCallId) {
          candidateLedger = beforeClosingLedger;
          if (releaseOwner) {
            candidateLedger = withoutAnswerRow(
              candidateLedger,
              releaseOwner.type,
              releaseOwner.key,
            );
          }
        } else if (ownerKey !== null && ownerRow) {
          candidateLedger = withoutAnswerRow(prefixLedger, ownerType, ownerKey);
        }
        calls.set(ownerCallId, {
          ...owner,
          receipt: trackRefusal(
            failClosed(
              validation.code,
              validation.location,
              ownerType,
              ownerKey,
              validation.feedback,
            ),
            candidateLedger,
            batchRefusalCounts,
            input.plan,
            batchExhaustion,
          ),
          persistable: releaseOwner ? owner.persistable : false,
          ...(releaseOwner ? { releaseOwner } : {}),
        });
        if (ownerCallId !== closingToolCallId) {
          calls.set(closingToolCallId, {
            ...closingCall,
            receipt: {
              ...closingCall.receipt,
              remaining: remainingAnswerRecordKeys(candidateLedger),
              complete: false,
            },
          });
        }
      } else {
        restoredCompletionGuidance = undefined;
        calls.set(closingToolCallId, {
          ...closingCall,
          validatedLedgerIdentity: ledgerIdentity(prefixLedger),
          receipt: { ...closingCall.receipt, complete: true },
        });
      }
    };
    for (const item of work) {
      if (!item.persistable || !item.candidate) {
        calls.set(item.toolCallId, {
          ...item,
          receipt: trackRefusal(
            item.receipt,
            candidateLedger,
            batchRefusalCounts,
            input.plan,
            batchExhaustion,
          ),
        });
        continue;
      }
      if (batchExhaustion.value !== null) {
        calls.set(item.toolCallId, {
          ...item,
          receipt: trackRefusal(
            failClosed(
              "answer-record-exhausted",
              "$",
              batchExhaustion.value.type,
              batchExhaustion.value.key,
            ),
            candidateLedger,
            batchRefusalCounts,
            input.plan,
            batchExhaustion,
          ),
          persistable: false,
        });
        continue;
      }
      const isOpenWithdrawal =
        item.candidate.record === null &&
        input.plan.types.get(item.candidate.type)?.declaration.open === true;
      const outcome = isOpenWithdrawal
        ? { status: "valid" as const }
        : outcomeById.get(item.toolCallId)!;
      if (outcome.status === "refused") {
        const receipt = trackRefusal(
          failClosed(outcome.code, outcome.location, item.candidate.type, item.candidate.key),
          candidateLedger,
          batchRefusalCounts,
          input.plan,
          batchExhaustion,
        );
        calls.set(item.toolCallId, { ...item, receipt, persistable: false });
        continue;
      }
      const canonicalCall = canonicalJson({
        type: item.candidate.type,
        ...(item.candidate.key ? { key: item.candidate.key } : {}),
        record: item.candidate.record,
      });
      const beforeClosingLedger = candidateLedger;
      const admitted = admitCall(candidateLedger, canonicalCall);
      if (admitted.receipt.status === "refused") {
        calls.set(item.toolCallId, {
          ...item,
          receipt: trackRefusal(
            admitted.receipt,
            candidateLedger,
            batchRefusalCounts,
            input.plan,
            batchExhaustion,
          ),
          persistable: false,
        });
      } else {
        candidateLedger = admitted.ledger;
        const remaining = remainingAnswerRecordKeys(candidateLedger);
        calls.set(item.toolCallId, {
          ...item,
          receipt: { ...admitted.receipt, remaining, complete: false },
        });
        if (remaining.length === 0) {
          await verifyCompletion(item.toolCallId, candidateLedger, beforeClosingLedger);
        }
      }
    }
    const prepared: PreparedBatch = {
      batchId: batch.batchId,
      digest,
      orderedIds,
      authorizedIds: batch.authorizedToolCallIds,
      calls,
    };
    batches.set(batch.batchId, prepared);
    activeBatch = prepared;
  }

  const capability = {
    answerNowProgress() {
      const requiredKeys = remainingAnswerRecordKeys({ ...ledger, rows: new Map() });
      const remainingKeys = remainingAnswerRecordKeys(ledger);
      const completedKeys = [...ledger.rows.values()].map((row) =>
        row.key === "singleton" ? row.type : `${row.type}:${row.key}`,
      );
      const openSets = [...ledger.plan.types].flatMap(([type, planned]) => {
        if (!planned.declaration.open) return [];
        const closedBy = planned.declaration.closedBy;
        if (!closedBy) return [{ type, open: true }];
        const [closer, flag] = closedBy.split(".") as [string, string];
        const row = ledger.rows.get(`${closer}\u0000singleton`);
        const payload = row?.payload;
        const open =
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          Reflect.get(payload, flag) !== true;
        return [{ type, open }];
      });
      return Object.freeze({
        requiredKeys: Object.freeze(requiredKeys),
        remainingKeys: Object.freeze(remainingKeys),
        completedKeys: Object.freeze(completedKeys),
        openSets: Object.freeze(openSets.map((entry) => Object.freeze(entry))),
        complete: remainingKeys.length === 0,
      });
    },
    takeReportReadiness() {
      const ready = settledReportReady;
      settledReportReady = false;
      return ready;
    },
    prepareBatch,
    receipt(toolCallId: string): QualityAnswerRecordReceiptV1 {
      const item = activeBatch?.calls.get(toolCallId);
      if (!item) return failKit("unknown-call");
      return item.receipt;
    },
    async settle(inputSettle: {
      readonly batchId: string;
      readonly toolCallIds: readonly string[];
      readonly authorizedToolCallIds: readonly string[];
      readonly successfulToolCallIds: readonly string[];
    }): Promise<void> {
      assertPublicationHealthy();
      const batch = batches.get(inputSettle.batchId);
      if (!batch) return failKit("settlement-authority");
      const priorSettlement = settledBatches.get(inputSettle.batchId);
      if (priorSettlement) {
        if (priorSettlement !== canonicalDigest(inputSettle))
          return failKit("settlement-authority");
        return;
      }
      if (
        canonicalJson(inputSettle.toolCallIds) !== canonicalJson(batch.orderedIds) ||
        new Set(inputSettle.authorizedToolCallIds).size !==
          inputSettle.authorizedToolCallIds.length ||
        inputSettle.authorizedToolCallIds.some((id) => !batch.calls.has(id)) ||
        new Set(inputSettle.successfulToolCallIds).size !==
          inputSettle.successfulToolCallIds.length ||
        inputSettle.successfulToolCallIds.some(
          (id) => !inputSettle.authorizedToolCallIds.includes(id),
        ) ||
        canonicalJson(inputSettle.authorizedToolCallIds) !== canonicalJson(batch.authorizedIds) ||
        canonicalJson(inputSettle.successfulToolCallIds) !==
          canonicalJson(
            inputSettle.authorizedToolCallIds.filter((id) =>
              inputSettle.successfulToolCallIds.includes(id),
            ),
          )
      )
        return failKit("settlement-authority");
      const success = new Set(inputSettle.successfulToolCallIds);
      const authorized = new Set(inputSettle.authorizedToolCallIds);
      settledReportReady = false;
      if (
        inputSettle.authorizedToolCallIds.some(
          (toolCallId) => batch.calls.get(toolCallId)?.credentialRejected,
        )
      ) {
        activeBatch = undefined;
        settledBatches.set(inputSettle.batchId, canonicalDigest(inputSettle));
        return;
      }
      let nextLedger = ledger;
      const nextRefusalCounts = new Map(refusalCounts);
      const nextRefusalDiagnostics = new Map(refusalDiagnostics);
      const nextExhaustion = { value: refusalExhaustion ? { ...refusalExhaustion } : null };
      for (const toolCallId of batch.orderedIds) {
        if (!authorized.has(toolCallId)) continue;
        const item = batch.calls.get(toolCallId)!;
        if (item.receipt.status === "refused") {
          const charge = refusalCharge(
            item.receipt.type,
            item.receipt.key,
            input.plan,
            nextLedger.issued,
          );
          nextRefusalCounts.set(charge, (nextRefusalCounts.get(charge) ?? 0) + 1);
          const diagnostic = retainedInferenceRejection({
            code: item.receipt.code ?? "unknown",
            location: item.receipt.location ?? "$",
          });
          const diagnosticId = refusalDiagnosticId(diagnostic.code, diagnostic.location);
          const priorDiagnostic = nextRefusalDiagnostics.get(diagnosticId);
          nextRefusalDiagnostics.set(diagnosticId, {
            ...diagnostic,
            count: (priorDiagnostic?.count ?? 0) + 1,
          });
          if (item.receipt.code === "answer-record-exhausted" && nextExhaustion.value === null) {
            nextExhaustion.value = { type: item.receipt.type, key: item.receipt.key };
          }
          if (item.releaseOwner) {
            await releasePersistedRow(item.releaseOwner.type, item.releaseOwner.key);
          }
          continue;
        }
        if (!success.has(toolCallId)) continue;
        if (!item.persistable || !item.candidate) continue;
        const raw = canonicalJson({
          type: item.candidate.type,
          ...(item.candidate.key ? { key: item.candidate.key } : {}),
          record: item.candidate.record,
        });
        const result = admitCall(nextLedger, raw);
        if (result.receipt.status === "refused") return failKit("settlement-admission-drift");
        nextLedger = result.ledger;
        const row = [...nextLedger.rows.values()].find(
          (entry) => entry.type === result.receipt.type && entry.key === result.receipt.key,
        );
        if (result.receipt.status === "withdrawn") {
          const withdrawnType = result.receipt.type;
          const withdrawnKey = result.receipt.key;
          if (!withdrawnType || !withdrawnKey) failKit("withdrawal-address");
          persisted.delete(`${withdrawnType}\u0000${withdrawnKey}`);
          tombstones.push({
            type: withdrawnType!,
            key: withdrawnKey!,
            reasonCode: "withdrawn",
            settlementSequence: settlementSequence + 1,
          });
          continue;
        }
        if (result.receipt.status === "unchanged") continue;
        if (!row) return failKit("settlement-row-missing");
        const body: StoredAnswerRecordV1 = {
          contractId: "quality-evaluation",
          contractVersion: input.declaration.version,
          runId: bindings.runId,
          stepId: bindings.stepId,
          attempt: bindings.attempt,
          type: row.type,
          key: row.key,
          state: "admitted",
          bindings: bindingBody,
          payloadSha256: row.payloadSha256,
          payload: row.payload,
        };
        const sealed = kit.seal(ROW_KIND, ROW_DIGEST, body);
        const digest = opaqueRecordDigest(sealed);
        await store.putRecord(digest, sealed);
        persisted.set(`${row.type}\u0000${row.key}`, {
          digest,
          payloadSha256: row.payloadSha256,
          state: "admitted",
          attempt: bindings.attempt,
        });
      }
      const reloaded = await reloadRows();
      const emptyLedger = createAnswerRecordLedger(input.plan);
      let admittedLedger: AnswerRecordLedger = {
        ...emptyLedger,
        issued: new Map(nextLedger.issued),
      };
      for (const row of reloaded) {
        const reference = persisted.get(`${row.type}\u0000${row.key}`);
        if (reference?.state !== "admitted") continue;
        const raw = serializeAnswerRow(input.plan, row);
        const result = admitCall(admittedLedger, raw);
        if (result.receipt.status === "refused") return failKit("settlement-ledger-rebuild");
        admittedLedger = result.ledger;
      }
      ledger = admittedLedger;
      refusalCounts = nextRefusalCounts;
      refusalDiagnostics = nextRefusalDiagnostics;
      refusalExhaustion = nextExhaustion.value;
      activeBatch = undefined;
      settledBatches.set(inputSettle.batchId, canonicalDigest(inputSettle));
      await publishCheckpoint();
      const terminalAuthorizedId = inputSettle.authorizedToolCallIds.at(-1);
      if (terminalAuthorizedId && success.has(terminalAuthorizedId)) {
        const terminalCall = batch.calls.get(terminalAuthorizedId);
        const validatedIdentity = terminalCall?.validatedLedgerIdentity;
        settledReportReady =
          terminalCall?.receipt.complete === true &&
          validatedIdentity !== undefined &&
          validatedIdentity === ledgerIdentity(ledger);
      }
    },
  };

  async function snapshotIndex(): Promise<AnswerRecordLedgerIndexV1 | undefined> {
    if (latestCheckpointValue) {
      const committed = new Map(
        latestCheckpointValue.record.rows.map((row) => [
          `${row.type}\u0000${row.key}`,
          {
            digest: row.recordSha256,
            payloadSha256: row.payloadSha256,
            state: "admitted" as const,
            attempt: row.originalAttempt,
          },
        ]),
      );
      const rows = latestCheckpointValue.record.rows.map((row) => ({
        type: row.type,
        key: row.key,
        payload: null,
        payloadSha256: row.payloadSha256,
      }));
      return makeIndex(
        rows,
        bindingBody,
        bindings.attempt,
        committed,
        {
          sha256: latestCheckpointValue.sha256,
          sequence: latestCheckpointValue.record.sequence,
          attempt: bindings.attempt,
        },
        checkpointProgress(latestCheckpointValue.record, ledger),
      );
    }
    // Row writes made by a settlement whose checkpoint/pointer publication
    // failed are orphan evidence. They are never projected as committed state.
    return undefined;
  }

  async function restoreCheckpoint(checkpoint: {
    readonly record: AnswerRecordContinuationCheckpointEnvelopeV1;
    readonly sha256: string;
  }): Promise<void> {
    if (latestCheckpointValue || persisted.size || settlementSequence !== 0)
      failKit("checkpoint-restore-order");
    const stored = await store.getRecord(checkpoint.sha256);
    if (opaqueRecordDigest(stored) !== checkpoint.sha256) failKit("checkpoint-address");
    kit.assertInert(stored);
    kit.rejectCredentials(stored);
    const checkpointKeys = [
      "continuationId",
      "sequence",
      "predecessorCheckpointSha256",
      "sourceRunId",
      "logicalRunId",
      "stepId",
      "sourceAttemptHighWater",
      "bindingsSha256",
      "bindings",
      "rows",
      "issuedKeyHighWater",
      "tombstones",
      "refusalCounts",
      ...(isRecord(stored) && Object.hasOwn(stored, "refusalDiagnostics")
        ? ["refusalDiagnostics"]
        : []),
      "refusalExhaustion",
      "settledBatchHighWater",
      "complete",
    ];
    const decoded = kit.decodeSealed(
      stored,
      CHECKPOINT_KIND,
      CHECKPOINT_DIGEST,
      checkpointKeys,
      (body) => body as unknown as AnswerRecordContinuationCheckpointV1,
    ) as unknown as AnswerRecordContinuationCheckpointEnvelopeV1;
    const bindingsMatch =
      decoded.bindingsSha256 === canonicalDigest(bindingBody) &&
      canonicalJson(decoded.bindings) === canonicalJson(bindingBody);
    validateCheckpointShape(decoded, !bindingsMatch);
    if (
      canonicalJson(decoded) !== canonicalJson(checkpoint.record) ||
      decoded.schemaVersion !== 1 ||
      decoded.kind !== CHECKPOINT_KIND ||
      decoded.logicalRunId !== bindings.runId ||
      decoded.stepId !== bindings.stepId ||
      decoded.sourceRunId !== (input.restoreSourceRunId ?? bindings.runId) ||
      !Number.isSafeInteger(decoded.sequence) ||
      decoded.sequence < 1 ||
      !Number.isSafeInteger(decoded.sourceAttemptHighWater) ||
      decoded.sourceAttemptHighWater < 1
    )
      failKit("checkpoint-binding");
    if (!bindingsMatch) {
      // The sealed checkpoint is authentic and structurally sound, but its
      // semantic route/profile bindings no longer match this attempt. Do not
      // load its row payloads: all prior rows are stale and the caller starts a
      // fresh ledger. Explicit process continuation refuses this status before
      // claiming the source checkpoint; same-run retries persist pointer
      // removal before the next provider turn.
      restoredCheckpointWasStale = true;
      return;
    }
    const empty = createAnswerRecordLedger(input.plan);
    const issued = new Map<string, number>();
    for (const [type, serial] of Object.entries(decoded.issuedKeyHighWater)) {
      if (
        !input.plan.types.get(type)?.declaration.open ||
        !Number.isSafeInteger(serial) ||
        serial < 0
      ) {
        failKit("checkpoint-issued-state");
      }
      issued.set(type, serial);
    }
    for (const row of decoded.rows) {
      const rowId = `${row.type}\u0000${row.key}`;
      if (
        persisted.has(rowId) ||
        !Number.isSafeInteger(row.originalAttempt) ||
        row.originalAttempt < 1 ||
        !hash(row.recordSha256) ||
        !hash(row.payloadSha256)
      )
        failKit("checkpoint-row-shape");
      persisted.set(rowId, {
        digest: row.recordSha256,
        payloadSha256: row.payloadSha256,
        state: "admitted",
        attempt: row.originalAttempt,
      });
    }
    const rows = await reloadRows();
    let restored: AnswerRecordLedger = { ...empty, issued };
    for (const row of rows) {
      const result = admitCall(restored, serializeAnswerRow(input.plan, row));
      if (result.receipt.status === "refused") failKit("checkpoint-row-ledger");
      restored = result.ledger;
    }
    ledger = { ...restored, issued };
    for (const [charge, count] of Object.entries(decoded.refusalCounts)) {
      if (!Number.isSafeInteger(count) || count < 0) failKit("checkpoint-refusal-state");
      refusalCounts.set(charge, count);
    }
    for (const diagnostic of decoded.refusalDiagnostics ?? []) {
      refusalDiagnostics.set(refusalDiagnosticId(diagnostic.code, diagnostic.location), {
        code: diagnostic.code,
        location: diagnostic.location,
        count: diagnostic.count,
      });
    }
    refusalExhaustion = input.nonExhaustingRefusals
      ? null
      : decoded.refusalExhaustion
        ? { ...decoded.refusalExhaustion }
        : null;
    tombstones.push(...decoded.tombstones.map((entry) => ({ ...entry })));
    settlementSequence = decoded.settledBatchHighWater;
    latestCheckpointValue = { record: decoded, sha256: checkpoint.sha256 };
    committedControlState = captureControlState();
    if (decoded.complete) await revalidateRestoredCompletion();
  }

  async function revalidateRestoredCompletion(): Promise<void> {
    const provisional = await assembleAnswerRecords({
      ledger,
      hostMinted: screenedHostMinted(input.hostMinted),
      references: input.references,
      referenceIds: input.referenceIds,
      renderReference: input.renderReference,
      derive: input.derive,
    });
    if (provisional.status === "incomplete") return failKit("completion-ledger-drift");
    if (provisional.status === "open") {
      validateOpenDerivedLayers(provisional.open);
      restoredCompletionGuidance = `Host derivation remains open for these planned layer IDs: ${JSON.stringify(provisional.open)}. Submit the corresponding layer-note records before requesting the final report.`;
      kit.assertInert(restoredCompletionGuidance);
      kit.rejectCredentials(restoredCompletionGuidance);
      settledReportReady = false;
      committedControlState = captureControlState();
      return;
    }
    const evaluation = provisional.artifact.evaluation;
    const qualityScore = provisional.artifact.qualityScore;
    if (!isRecord(evaluation) || (qualityScore !== null && !isRecord(qualityScore)))
      return failKit("assembled-artifact-shape");
    kit.assertInert({ evaluation, qualityScore });
    kit.rejectCredentials({ evaluation, qualityScore });
    let validation: Awaited<ReturnType<typeof input.validateCompletion>>;
    try {
      validation = await input.validateCompletion({
        evaluation,
        qualityScore,
        records: [...ledger.rows.values()].map((row) => ({
          type: row.type,
          key: row.key,
          record: row.payload,
        })),
        currentCalls: [],
      });
    } catch (error) {
      if (error instanceof QualityHostCheckError) throw error;
      return failKit("completion-validator-infrastructure-failure");
    }
    if (!validation || (validation.status !== "valid" && validation.status !== "refused")) {
      return failKit("assembly-validator-outcome");
    }
    if (validation.status === "valid") {
      restoredCompletionGuidance = undefined;
      settledReportReady = true;
      committedControlState = captureControlState();
      return;
    }
    const feedback =
      validation.feedback ??
      "Repair the evaluation-note closure from the host's admitted answer-record progress, then submit it again for validation.";
    const classified = failClosed(
      validation.code,
      validation.location,
      validation.owner.kind === "record" ? validation.owner.type : null,
      validation.owner.kind === "record" ? validation.owner.key : null,
      feedback,
    );
    if (classified.retry !== "model-correctable") return failKit("unmapped-refusal");
    kit.assertInert(feedback);
    kit.rejectCredentials(feedback);
    if (validation.owner.kind !== "record") return failKit("assembly-validator-owner");
    const ownerId = `${validation.owner.type}\u0000${validation.owner.key}`;
    if (persisted.get(ownerId)?.state !== "admitted") return failKit("assembly-validator-owner");
    restoredCompletionGuidance = classified.feedback ?? feedback;
    try {
      await releasePersistedRow(validation.owner.type, validation.owner.key);
      ledger = withoutAnswerRow(ledger, validation.owner.type, validation.owner.key);
      settledReportReady = false;
      pendingRestoredRepairPublication = true;
    } catch (error) {
      restoreCommittedControlState();
      throw error;
    }
  }

  async function materializeContinuationCheckpoint(): Promise<void> {
    const latest = latestCheckpointValue;
    if (!latest) return failKit("checkpoint-continuation-source-missing");
    const attemptAdvanced = bindings.attempt > latest.record.sourceAttemptHighWater;
    if (
      latest.record.sourceRunId === (input.sourceRunId ?? bindings.runId) &&
      !pendingRestoredRepairPublication &&
      !attemptAdvanced
    )
      return;
    // Publish authenticated restored state only after the caller's continuation claim.
    pendingRestoredRepairPublication = false;
    try {
      await publishCheckpoint();
    } catch (error) {
      restoreCommittedControlState();
      throw error;
    }
  }

  function validateCheckpointShape(
    value: AnswerRecordContinuationCheckpointV1,
    staleBindings: boolean,
  ): void {
    const fail = (): never => failKit("checkpoint-shape");
    const safeCounter = (candidate: unknown, minimum = 0): candidate is number =>
      Number.isSafeInteger(candidate) && (candidate as number) >= minimum;
    const declared = (type: unknown) =>
      typeof type === "string" ? input.plan.types.get(type) : undefined;
    const validRowKey = (type: unknown, key: unknown): boolean => {
      const planned = declared(type);
      if (typeof key !== "string" || key.length === 0) return false;
      if (staleBindings) return typeof type === "string" && type.length > 0;
      if (!planned) return false;
      if (planned.declaration.open) {
        const match = new RegExp(`^${planned.serialPrefix}-([1-9][0-9]*)$`, "u").exec(key);
        const issued = value.issuedKeyHighWater[type as string];
        return !!match && safeCounter(issued) && Number(match[1]) <= issued;
      }
      return planned.keys.some((entry) => entry.key === key) || key === "singleton";
    };
    const validRefusalCharge = (charge: string): boolean => {
      if (charge === REFUSAL_CALL_CHARGE) return true;
      const separator = charge.indexOf("\u0000");
      if (separator <= 0) return false;
      const type = charge.slice(0, separator);
      const key = charge.slice(separator + 1);
      if (!key) return false;
      // Old authenticated checkpoints may be restored only to discard stale
      // bindings. Preserve their former opaque non-empty counter addresses.
      if (staleBindings) return true;
      if (key === REFUSAL_NEW_OPEN_KEY) return declared(type)?.declaration.open === true;
      return validRowKey(type, key);
    };
    const validRefusalExhaustion = (type: unknown, key: unknown): boolean => {
      if (type === null) return key === null;
      if (typeof type !== "string" || type.length === 0) return false;
      if (key === null) return staleBindings || declared(type)?.declaration.open === true;
      return validRowKey(type, key);
    };
    const expectedBindingKeys = [...BINDING_KEYS].sort();
    if (
      value.schemaVersion !== 1 ||
      value.kind !== CHECKPOINT_KIND ||
      !safeCounter(value.sequence, 1) ||
      !safeCounter(value.settledBatchHighWater, 1) ||
      value.sequence !== value.settledBatchHighWater ||
      !safeCounter(value.sourceAttemptHighWater, 1) ||
      !hash(value.continuationId) ||
      !hash(value.bindingsSha256) ||
      !Array.isArray(value.rows) ||
      !Array.isArray(value.tombstones) ||
      !isRecord(value.bindings) ||
      Object.keys(value.bindings).sort().join("\u0000") !== expectedBindingKeys.join("\u0000") ||
      !isRecord(value.issuedKeyHighWater) ||
      !isRecord(value.refusalCounts) ||
      typeof value.complete !== "boolean" ||
      typeof value.logicalRunId !== "string" ||
      value.logicalRunId.length === 0 ||
      typeof value.sourceRunId !== "string" ||
      value.sourceRunId.length === 0 ||
      typeof value.stepId !== "string" ||
      value.stepId.length === 0 ||
      canonicalDigest(value.bindings) !== value.bindingsSha256 ||
      BINDING_KEYS.some((key) => {
        const candidate = value.bindings[key];
        if (key === "schemaSha256s" || key === "referenceSourceSha256s") {
          return (
            !isRecord(candidate) ||
            Object.values(candidate).some((digest) => !hash(digest)) ||
            (key === "schemaSha256s" && Object.keys(candidate).length === 0)
          );
        }
        return !hash(candidate);
      }) ||
      value.continuationId !==
        canonicalDigest({
          runId: value.logicalRunId,
          stepId: value.stepId,
          bindings: value.bindings,
        }) ||
      (value.sequence === 1
        ? value.predecessorCheckpointSha256 !== null
        : !hash(value.predecessorCheckpointSha256))
    )
      fail();

    const openTypes = [...input.plan.types.entries()]
      .filter(([, planned]) => planned.declaration.open)
      .map(([type]) => type)
      .sort();
    if (
      !staleBindings &&
      Object.keys(value.issuedKeyHighWater).sort().join("\u0000") !== openTypes.join("\u0000")
    )
      fail();
    for (const [type, highWater] of Object.entries(value.issuedKeyHighWater)) {
      if (type.length === 0 || !safeCounter(highWater)) fail();
    }
    const activeRows = new Set<string>();
    for (const row of value.rows) {
      if (
        !isRecord(row) ||
        !validRowKey(row.type, row.key) ||
        !hash(row.recordSha256) ||
        !hash(row.payloadSha256) ||
        !safeCounter(row.originalAttempt, 1) ||
        row.originalAttempt > value.sourceAttemptHighWater
      )
        fail();
      const address = `${row.type}\u0000${row.key}`;
      if (activeRows.has(address)) fail();
      activeRows.add(address);
    }
    const tombstoneKeys = new Set<string>();
    for (const tombstone of value.tombstones) {
      if (
        !isRecord(tombstone) ||
        !validRowKey(tombstone.type, tombstone.key) ||
        (tombstone.reasonCode !== "withdrawn" && tombstone.reasonCode !== "released") ||
        !safeCounter(tombstone.settlementSequence, 1) ||
        tombstone.settlementSequence > value.settledBatchHighWater ||
        (tombstone.reasonCode === "withdrawn" &&
          !staleBindings &&
          !declared(tombstone.type)?.declaration.open)
      )
        fail();
      const address = `${tombstone.type}\u0000${tombstone.key}`;
      if (activeRows.has(address) || tombstoneKeys.has(address)) fail();
      tombstoneKeys.add(address);
    }
    for (const [charge, count] of Object.entries(value.refusalCounts)) {
      if (!safeCounter(count) || !validRefusalCharge(charge)) fail();
    }
    if (value.refusalDiagnostics !== undefined) {
      if (
        !Array.isArray(value.refusalDiagnostics) ||
        value.refusalDiagnostics.length > input.plan.recordCallCeiling
      )
        fail();
      const diagnostics = new Set<string>();
      for (const diagnostic of value.refusalDiagnostics) {
        if (
          !isRecord(diagnostic) ||
          Object.keys(diagnostic).sort().join("\u0000") !== "code\u0000count\u0000location" ||
          typeof diagnostic.code !== "string" ||
          typeof diagnostic.location !== "string" ||
          !safeCounter(diagnostic.count, 1)
        )
          fail();
        const reason = {
          code: diagnostic.code as string,
          location: diagnostic.location as string,
        };
        if (!isRetainableInferenceRejection(reason)) fail();
        const id = refusalDiagnosticId(reason.code, reason.location);
        if (diagnostics.has(id)) fail();
        diagnostics.add(id);
      }
    }
    if (
      value.refusalExhaustion !== null &&
      (!isRecord(value.refusalExhaustion) ||
        !validRefusalExhaustion(value.refusalExhaustion.type, value.refusalExhaustion.key))
    )
      fail();
  }

  async function releaseAll(): Promise<void> {
    assertPublicationHealthy();
    if (activeBatch) failKit("release-active-batch");
    const rows = await reloadRows();
    for (const row of rows) {
      if (persisted.get(`${row.type}\u0000${row.key}`)?.state === "admitted") {
        await releasePersistedRow(row.type, row.key);
      }
    }
    ledger = {
      ...createAnswerRecordLedger(input.plan),
      issued: new Map(ledger.issued),
    };
    if (latestCheckpointValue) await publishCheckpoint();
  }

  async function finish(
    reportMarkdown: string,
  ): Promise<Awaited<ReturnType<QualityAnswerRecordSessionV1["finish"]>>> {
    assertPublicationHealthy();
    kit.assertInert(reportMarkdown);
    kit.rejectCredentials(reportMarkdown);
    const rows = await reloadRows();
    const emptyLedger = createAnswerRecordLedger(input.plan);
    let rebuilt: AnswerRecordLedger = { ...emptyLedger, issued: new Map(ledger.issued) };
    for (const row of rows) {
      if (persisted.get(`${row.type}\u0000${row.key}`)?.state !== "admitted") continue;
      const raw = serializeAnswerRow(input.plan, row);
      const result = admitCall(rebuilt, raw);
      if (result.receipt.status === "refused") failKit("reloaded-ledger-invalid");
      rebuilt = result.ledger;
    }
    const assembled = await assembleAnswerRecords({
      ledger: rebuilt,
      hostMinted: screenedHostMinted(input.hostMinted),
      references: input.references,
      referenceIds: input.referenceIds,
      renderReference: input.renderReference,
      derive: input.derive,
    });
    if (assembled.status !== "assembled")
      return failKit(assembled.status === "incomplete" ? "ledger-incomplete" : "derivation-open");
    const evaluation = assembled.artifact.evaluation;
    const qualityScore = assembled.artifact.qualityScore;
    if (!isRecord(evaluation) || (qualityScore !== null && !isRecord(qualityScore)))
      return failKit("assembled-artifact-shape");
    const index = await snapshotIndex();
    if (
      !index ||
      latestCheckpointValue?.record.complete !== true ||
      index.progress?.complete !== true ||
      index.rows.length !== rebuilt.rows.size ||
      [...rebuilt.rows.values()].some((row) => {
        const id = `${row.type}\u0000${row.key}`;
        const reference = persisted.get(id);
        const indexed = index.rows.find(
          (entry) => entry.type === row.type && entry.key === row.key,
        );
        return (
          reference?.state !== "admitted" ||
          !indexed ||
          indexed.state !== "admitted" ||
          indexed.recordSha256 !== reference.digest ||
          indexed.attempt !== reference.attempt
        );
      })
    )
      return failKit("completion-ledger-drift");
    return {
      evaluation,
      qualityScore: qualityScore as Record<string, unknown> | null,
      index,
    };
  }

  async function replayState(): Promise<{
    readonly pairs: readonly QualityAnswerRecordReplayPairV1[];
    readonly remainingKeys: readonly string[];
    readonly completedKeys: readonly string[];
    readonly complete: boolean;
  }> {
    assertPublicationHealthy();
    const checkpoint = latestCheckpointValue;
    if (!checkpoint) {
      const progress = capability.answerNowProgress();
      return { pairs: [], ...progress };
    }
    const rows = await reloadRows();
    const byAddress = new Map(rows.map((row) => [`${row.type}\u0000${row.key}`, row]));
    const pairs = checkpoint.record.rows.map((reference) => {
      const row = byAddress.get(`${reference.type}\u0000${reference.key}`);
      const stored = persisted.get(`${reference.type}\u0000${reference.key}`);
      if (!row || !stored || stored.digest !== reference.recordSha256) {
        return failKit("replay-row-not-committed");
      }
      return {
        toolCallId: `restore-${canonicalDigest({ checkpoint: checkpoint.sha256, row: reference.recordSha256 })}`,
        type: row.type,
        key: row.key,
        record: row.payload,
        toolArguments: JSON.parse(
          serializeAnswerRow(input.plan, row, true),
        ) as QualityAnswerRecordReplayPairV1["toolArguments"],
        sourceAttempt: reference.originalAttempt,
        checkpointSha256: checkpoint.sha256,
      } satisfies QualityAnswerRecordReplayPairV1;
    });
    const progress = capability.answerNowProgress();
    return { pairs, ...progress };
  }

  return {
    capability,
    recordCallCeiling: input.plan.recordCallCeiling,
    get promptGuidance() {
      return restoredCompletionGuidance
        ? `${promptGuidance}\n\nCurrent restored-ledger repair guidance: ${restoredCompletionGuidance}`
        : promptGuidance;
    },
    restoreCheckpoint,
    checkpointWasStale: () => restoredCheckpointWasStale,
    materializeContinuationCheckpoint,
    async latestCheckpoint() {
      return latestCheckpointValue;
    },
    replayState,
    snapshotIndex,
    releaseAll,
    finish,
  };
}
