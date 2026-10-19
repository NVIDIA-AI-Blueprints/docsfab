// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Project already admitted model records; this never supplies model approval. */
import { canonicalJson, createContractKit } from "../contract-kit/index.js";
import type { HostRuntimeApprovedModelData } from "../host-invoker/approved-model.js";
import type { FoundationClaimProposalV1, FoundationInspectInputV1 } from "./inspect.js";

function refuse(): never {
  throw new Error("Hosted Foundation refused an invalid approved model record.");
}

/**
 * One producer-admitted model text field, normalized to NFC instead of refused.
 *
 * Model content, not host authority. Neither producer normalizes Unicode, so
 * the strict contract-kit `string()`, which refuses anything not already NFC,
 * would fail closed inside the worker on an approved statement that is not NFC
 * (an NFD paste is the everyday source). NFC gives
 * every downstream label, limitation code, and applicability digest one form;
 * the shape stays closed, because a non-string is still a refusal.
 */
function modelText(value: unknown): string {
  // Condition: the field is not a string at all. Shape, not content: a producer
  // that sealed a number or an object here did not seal a model statement.
  if (typeof value !== "string") refuse();
  return value.normalize("NFC");
}

const kit = createContractKit({
  fail: refuse,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-version",
  },
});

export function projectApprovedModelFoundation(
  model: HostRuntimeApprovedModelData,
): Pick<FoundationInspectInputV1, "claimProposals" | "sourceConflicts" | "evidenceLimitations"> {
  const evidenceLimitations: string[] = [];
  const claimProposals: FoundationClaimProposalV1[] = model.claims.map(({ id, record }) => {
    const state = modelText(record.model_state),
      behavior = modelText(record.behavior_verification),
      intent = modelText(record.intent_approval),
      action = modelText(record.action);
    const supported = behavior === "supported",
      approvedIntent = intent === "approved";
    // "candidate" is a historic record state, not a veto on admitted approved
    // intent or separately supported behavior. "superseded" action describes a
    // superseding decision; only model_state superseded retires that record.
    const verified =
      state !== "superseded" &&
      state !== "disputed" &&
      state !== "unresolved" &&
      action !== "excluded" &&
      (supported || approvedIntent || state === "approved");
    evidenceLimitations.push(
      `approved-model-claim-state:${id}:${state}`,
      `approved-model-behavior-verification:${id}:${behavior}`,
      `approved-model-intent-approval:${id}:${intent}`,
    );
    return {
      id,
      subjectLabel: supported
        ? "supported-behavior"
        : approvedIntent
          ? "approved-intent"
          : "model-claim",
      assertionLabel: modelText(record.statement),
      statementLabel: modelText(record.statement),
      // The applicability label is grouping/display bytes, not a producer seal,
      // so it uses the runtime's own canonicalization; only the digests the
      // producer sealed are re-verified with the producer's bytes, and that
      // happens in the host-invoker parser. Normalized for the same reason as
      // every other label here.
      applicabilityLabel: canonicalJson(kit.object(record.scope)).normalize("NFC"),
      evidenceIds: ["approved-project-model"],
      confidence: verified ? "high" : "medium",
      verificationStatus: verified ? "verified" : "unverified",
      conflictGroupId: null,
    };
  });
  const sourceConflicts = model.openConflicts.map(({ id, record }) => {
    const claimIds = [
      ...new Set(
        kit
          .array(record.source_variants)
          .flatMap((value) =>
            kit.array(kit.object(value).source_claim_ids).map((id) => modelText(id)),
          ),
      ),
    ];
    return { id, claimIds };
  });
  return { claimProposals, sourceConflicts, evidenceLimitations };
}
