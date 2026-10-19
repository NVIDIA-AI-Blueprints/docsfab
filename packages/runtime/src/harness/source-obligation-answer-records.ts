// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AnswerRecordHostError } from "./answer-record-fill.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  admitAnswerRecordCall,
  assembleAnswerRecords,
  createAnswerRecordLedger,
  decodeAnswerRecordCall,
  planAnswerRecords,
  remainingAnswerRecordKeys,
  refuseAnswerRecordCall,
  type AnswerRecordLedger,
  type AnswerRecordRow,
  type AnswerRecordReceipt,
} from "./answer-records.js";
import { OUTPUT_RECORD_CONTRACTS } from "../contracts/model-output.js";
import { deriveWithRuntimeRules } from "../contracts/derivations/index.js";
import { SOURCE_OBLIGATION_DERIVATIONS } from "../contracts/derivations/source-obligation.js";
import type { SourceObligationLedgerProposalV1 } from "../workflow-execution/source-obligation.js";
import {
  projectSourceObligationRejection,
  validateSourceObligationRecordForAdmission,
} from "../workflow-execution/source-obligation.js";
import { InferenceStepError } from "../execution/contracts.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../workflow-execution/review-response.js";
import type { SourceObligationAnswerRecordCapabilityV1 } from "../execution/contracts.js";

const DECLARATION = OUTPUT_RECORD_CONTRACTS["source-obligation"];

export interface SourceObligationAnswerRecordSessionV1 {
  readonly capability: SourceObligationAnswerRecordCapabilityV1;
  readonly recordCallCeiling: number;
  readonly promptGuidance: string;
  snapshot(): Readonly<AnswerRecordLedger>;
  continuation(): SourceObligationAnswerRecordContinuationV1;
  reopenProposalAfterCorrectableRejection(): void;
  finish(): Promise<SourceObligationLedgerProposalV1>;
}

/** Content-addressed in-memory state for a retry of the same bound step. */
export interface SourceObligationAnswerRecordContinuationV1 {
  readonly identitySha256: string;
  readonly stateSha256: string;
}

const continuationStates = new WeakMap<
  SourceObligationAnswerRecordContinuationV1,
  {
    readonly identitySha256: string;
    readonly stateSha256: string;
    readonly ledger: AnswerRecordLedger;
  }
>();

function copyLedger(
  plan: AnswerRecordLedger["plan"],
  ledger: AnswerRecordLedger,
): AnswerRecordLedger {
  return {
    ...createAnswerRecordLedger(plan),
    rows: new Map([...ledger.rows].map(([id, row]) => [id, structuredClone(row)])),
    refusals: new Map(ledger.refusals),
    issued: new Map(ledger.issued),
    exhausted: ledger.exhausted ? { ...ledger.exhausted } : null,
  };
}

function ledgerStateSha256(ledger: AnswerRecordLedger): string {
  return canonicalDigest({
    rows: [...ledger.rows.values()],
    refusals: [...ledger.refusals],
    issued: [...ledger.issued],
    exhausted: ledger.exhausted,
  });
}

/**
 * S2's record route composes the generic ledger with source-domain assembly.
 * It is created only when the runner injects the qualified step capability.
 */
export function createSourceObligationAnswerRecordSession(input: {
  readonly continuationIdentitySha256: string;
  readonly continuation?: SourceObligationAnswerRecordContinuationV1;
  readonly validateRecord: (
    type: string,
    record: unknown,
    parentStatus?: "applicable" | "not-applicable" | "unverified",
  ) => void;
}): SourceObligationAnswerRecordSessionV1 {
  const plan = planAnswerRecords({
    declaration: DECLARATION,
    skeletons: {
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        key: dimension,
        slot: dimension,
      })),
    },
    selectors: {
      dimension: TECHNICAL_FACT_DIMENSIONS,
      dimensionKey: TECHNICAL_FACT_DIMENSIONS,
    },
  });
  const restored = input.continuation ? continuationStates.get(input.continuation) : undefined;
  if (
    input.continuation &&
    (!restored ||
      restored.identitySha256 !== input.continuationIdentitySha256 ||
      restored.identitySha256 !== input.continuation.identitySha256 ||
      restored.stateSha256 !== input.continuation.stateSha256 ||
      ledgerStateSha256(restored.ledger) !== restored.stateSha256)
  ) {
    throw new AnswerRecordHostError(
      "The source-obligation continuation does not match its step evidence identity.",
    );
  }
  let ledger = restored ? copyLedger(plan, restored.ledger) : createAnswerRecordLedger(plan);
  const receiptByCall = new Map<string, AnswerRecordReceipt>();
  let activeBatch: string | undefined;
  let pending:
    | {
        readonly batchId: string;
        readonly calls: readonly {
          readonly toolCallId: string;
          readonly rawArguments: string | undefined;
        }[];
        readonly authorized: ReadonlySet<string>;
        readonly receipts: ReadonlyMap<string, AnswerRecordReceipt>;
      }
    | undefined;

  const capability: SourceObligationAnswerRecordCapabilityV1 = {
    async prepareBatch(batch) {
      if (activeBatch !== undefined || pending !== undefined) {
        throw new AnswerRecordHostError(
          "The source-obligation record batch is already active for this attempt.",
        );
      }
      const decodedByCall = new Map(
        batch.toolCalls
          .filter((call) => batch.authorizedToolCallIds.includes(call.toolCallId))
          .map((call) => [call.toolCallId, decodeAnswerRecordCall(ledger.plan, call.rawArguments)]),
      );
      const closedInBatch = batch.toolCalls.some((call) => {
        const decoded = decodedByCall.get(call.toolCallId);
        return decoded && "call" in decoded && decoded.call.type === "proposal-note";
      });
      const obligationsInBatch = batch.toolCalls.some((call) => {
        const decoded = decodedByCall.get(call.toolCallId);
        return decoded && "call" in decoded && decoded.call.type === "obligation";
      });
      let preview = ledger;
      const receipts = new Map<string, AnswerRecordReceipt>();
      for (const call of batch.toolCalls) {
        if (!batch.authorizedToolCallIds.includes(call.toolCallId)) continue;
        const decoded = decodedByCall.get(call.toolCallId)!;
        if ("call" in decoded) {
          try {
            assertParentReplacementCompatible(
              preview,
              decoded.call.type,
              decoded.call.key,
              decoded.call.record,
            );
            const parentStatus = parentStatusForObligation(
              preview,
              decoded.call.type,
              decoded.call.record,
            );
            input.validateRecord(decoded.call.type, decoded.call.record, parentStatus);
          } catch (error) {
            const rejection = projectSourceObligationRejection(error);
            if (!(error instanceof InferenceStepError) || !error.retryable || !rejection) {
              throw error;
            }
            const denied = refuseAnswerRecordCall(preview, {
              ...rejection,
              retry: "model-correctable",
              type: decoded.call.type,
              key: decoded.call.key,
            });
            preview = denied.ledger;
            receipts.set(call.toolCallId, denied.receipt);
            continue;
          }
        }
        if (
          closedInBatch &&
          obligationsInBatch &&
          "call" in decoded &&
          decoded.call.type === "proposal-note"
        ) {
          const denied = refuseAnswerRecordCall(preview, {
            code: "answer-record-closed",
            location: "$",
            retry: "terminal",
            type: "proposal-note",
            key: null,
          });
          preview = denied.ledger;
          receipts.set(call.toolCallId, denied.receipt);
          continue;
        }
        if (
          "call" in decoded &&
          decoded.call.type === "obligation" &&
          sourceObligationSetClosed(preview)
        ) {
          const denied = refuseAnswerRecordCall(preview, {
            code: "answer-record-closed",
            location: "$",
            retry: "terminal",
            type: "obligation",
            key: decoded.call.key,
          });
          preview = denied.ledger;
          receipts.set(call.toolCallId, denied.receipt);
          continue;
        }
        const admitted = admitAnswerRecordCall(preview, call.rawArguments);
        preview = admitted.ledger;
        receipts.set(call.toolCallId, admitted.receipt);
      }
      activeBatch = batch.batchId;
      pending = {
        batchId: batch.batchId,
        calls: batch.toolCalls,
        authorized: new Set(batch.authorizedToolCallIds),
        receipts,
      };
      for (const [id, receipt] of receipts) receiptByCall.set(id, receipt);
    },
    receipt(toolCallId) {
      return (
        receiptByCall.get(toolCallId) ?? {
          status: "refused",
          type: null,
          key: null,
          code: "answer-record-key",
          location: "$.type",
          retry: "model-correctable",
          remaining: [],
          complete: false,
        }
      );
    },
    async settle(batch) {
      if (!pending || pending.batchId !== batch.batchId || activeBatch !== batch.batchId) {
        throw new AnswerRecordHostError(
          "The source-obligation record batch has no matching settlement event.",
        );
      }
      const valid = new Set<string>();
      for (const call of pending.calls) {
        const receipt = pending.receipts.get(call.toolCallId);
        if (
          receipt?.status === "refused" &&
          pending.authorized.has(call.toolCallId) &&
          batch.authorizedToolCallIds.includes(call.toolCallId) &&
          batch.failedToolCallIds.includes(call.toolCallId)
        ) {
          // Pi reports the tool's explicit refusal as an executed failed
          // result. Only that observed failure, with the matching refused
          // receipt, consumes its bounded correction budget.
          if (
            receipt.code === undefined ||
            receipt.location === undefined ||
            receipt.retry === undefined
          ) {
            throw new AnswerRecordHostError(
              "A settled source-obligation refusal receipt lacks catalog identity fields.",
            );
          }
          ledger = refuseAnswerRecordCall(ledger, {
            code: receipt.code,
            location: receipt.location,
            retry: receipt.retry,
            type: receipt.type,
            key: receipt.key,
          }).ledger;
        }
        if (
          receipt?.status !== "refused" &&
          pending.authorized.has(call.toolCallId) &&
          batch.authorizedToolCallIds.includes(call.toolCallId) &&
          batch.successfulToolCallIds.includes(call.toolCallId)
        ) {
          const decoded = decodeAnswerRecordCall(ledger.plan, call.rawArguments);
          if ("call" in decoded) {
            try {
              assertParentReplacementCompatible(
                ledger,
                decoded.call.type,
                decoded.call.key,
                decoded.call.record,
              );
              const parentStatus = parentStatusForObligation(
                ledger,
                decoded.call.type,
                decoded.call.record,
              );
              input.validateRecord(decoded.call.type, decoded.call.record, parentStatus);
            } catch {
              throw new AnswerRecordHostError(
                "An obligation row lost valid parent admission before settlement.",
              );
            }
          }
          const result = admitAnswerRecordCall(ledger, call.rawArguments);
          ledger = result.ledger;
          valid.add(call.toolCallId);
        }
      }
      if (batch.successfulToolCallIds.some((id) => !valid.has(id))) {
        // A successful Pi call must have an admitted host receipt.
        throw new AnswerRecordHostError(
          "A source-obligation record settled without its admitted host receipt.",
        );
      }
      activeBatch = undefined;
      pending = undefined;
    },
    async finish() {
      if (pending || activeBatch) {
        throw new AnswerRecordHostError(
          "The source-obligation record batch is not settled before final assembly.",
        );
      }
      const assembled = await assembleAnswerRecords({
        ledger,
        hostMinted: {},
        references: {},
        referenceIds: {},
        renderReference: () => [],
        derive: deriveWithRuntimeRules(DECLARATION, SOURCE_OBLIGATION_DERIVATIONS),
      });
      if (assembled.status !== "assembled") {
        throw new AnswerRecordHostError(
          assembled.status === "incomplete"
            ? `The source-obligation records are incomplete: ${assembled.remaining.join(", ")}.`
            : `The source-obligation derivation is open: ${assembled.open.join(", ")}.`,
        );
      }
      return assembled.artifact.proposal as SourceObligationLedgerProposalV1;
    },
  };

  return {
    capability,
    recordCallCeiling: plan.recordCallCeiling,
    promptGuidance: sourceObligationGuidance(ledger),
    snapshot: () => ({
      ...ledger,
      rows: new Map([...ledger.rows].map(([id, row]) => [id, structuredClone(row)])),
      refusals: new Map(ledger.refusals),
      issued: new Map(ledger.issued),
      exhausted: ledger.exhausted ? { ...ledger.exhausted } : null,
    }),
    continuation: () => {
      const state = copyLedger(plan, ledger);
      const continuation = Object.freeze({
        identitySha256: input.continuationIdentitySha256,
        stateSha256: ledgerStateSha256(state),
      });
      continuationStates.set(continuation, {
        identitySha256: input.continuationIdentitySha256,
        stateSha256: continuation.stateSha256,
        ledger: state,
      });
      return continuation;
    },
    reopenProposalAfterCorrectableRejection: () => {
      if (activeBatch !== undefined || pending !== undefined) {
        throw new AnswerRecordHostError(
          "Cannot reopen the source-obligation proposal while a record batch is active.",
        );
      }
      // A correctable final proposal rejection invalidates only the model's
      // closure assertion. Admitted dimensions/obligations and refusal
      // accounting remain intact for the bounded retry.
      ledger = {
        ...ledger,
        rows: new Map([...ledger.rows].filter(([id]) => id !== "proposal-note\u0000singleton")),
      };
    },
    finish: () => capability.finish(),
  };
}

function sourceObligationGuidance(ledger: AnswerRecordLedger): string {
  const retained = [...ledger.rows.values()].map(({ type, key }) => `${type}:${key}`);
  const remaining = remainingAnswerRecordKeys(ledger);
  return [
    `Submit one dimension record for each: ${TECHNICAL_FACT_DIMENSIONS.join(", ")}.`,
    "Submit each obligation as its own obligation record; set dimensionKey to one listed dimension.",
    "Include obligations: [] in each dimension record; the host links obligation rows to that parent.",
    "Submit proposal-note with closed: true only after all obligation calls have settled.",
    "Do not submit any obligation after the proposal-note closes the set.",
    `Already admitted and retained: ${retained.length > 0 ? retained.join(", ") : "none"}. Do not resubmit these rows.`,
    `Still required by the host: ${remaining.length > 0 ? remaining.join(", ") : "none"}.`,
  ].join("\n");
}

function sourceObligationSetClosed(ledger: AnswerRecordLedger): boolean {
  const closeRecord = ledger.rows.get("proposal-note\u0000singleton");
  return (
    closeRecord !== undefined &&
    isPlainRecord(closeRecord.payload) &&
    closeRecord.payload.closed === true
  );
}

function parentStatusForObligation(
  ledger: AnswerRecordLedger,
  type: string,
  record: unknown,
): "applicable" | "not-applicable" | "unverified" | undefined {
  if (type !== "obligation") return undefined;
  const dimensionKey =
    record !== null && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>).dimensionKey
      : undefined;
  const parent =
    typeof dimensionKey === "string"
      ? ledger.rows.get(`dimension\u0000${dimensionKey}`)
      : undefined;
  if (
    !parent ||
    !parent.payload ||
    typeof parent.payload !== "object" ||
    Array.isArray(parent.payload)
  ) {
    throw sourceRecordRejection("invalid-value", "$.dimensions[].obligations[].dimension");
  }
  const status = (parent.payload as Record<string, unknown>).status;
  if (status !== "applicable" && status !== "not-applicable" && status !== "unverified") {
    throw new AnswerRecordHostError(
      "A planned source-obligation parent record has no valid status.",
    );
  }
  return status;
}

function assertParentReplacementCompatible(
  ledger: AnswerRecordLedger,
  type: string,
  key: string | null,
  record: unknown,
): void {
  if (type !== "dimension" || key === null || !isPlainRecord(record)) return;
  if (record.status === "applicable") return;
  const hasChildren = [...ledger.rows.values()].some(
    (row) =>
      row.type === "obligation" && isPlainRecord(row.payload) && row.payload.dimensionKey === key,
  );
  if (hasChildren) {
    throw sourceRecordRejection("invalid-value", "$.dimensions[].status");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceRecordRejection(code: "invalid-value", location: string): InferenceStepError {
  return new InferenceStepError(
    "The source-obligation record did not satisfy the host-owned contract.",
    "malformed-response",
    true,
    undefined,
    { code, location },
  );
}
