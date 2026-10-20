// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Host observation of whether a first-pass stop can replay without external evidence. */
import { createContractKit } from "../contract-kit/index.js";
import { decodeRunRecordInstructionContext } from "./instruction-context.js";

export const FIRST_PASS_CONTRADICTION_ADMISSION_KIND =
  "docsfab-first-pass-contradiction-admission" as const;

export interface FirstPassContradictionAdmissionV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof FIRST_PASS_CONTRADICTION_ADMISSION_KIND;
  readonly outcome: "repository-only" | "external-binding-unsupported";
  readonly source: "host-request-observation";
  readonly reasons: readonly (
    | "source"
    | "change"
    | "reader"
    | "context"
    | "snapshot"
    | "plan"
    | "composition"
    | "continuation"
    | "publication"
  )[];
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly instructionSha256: string;
  readonly instructionContextSha256?: string;
  readonly contradictionSha256: string;
  readonly admissionSha256: string;
}

export class FirstPassContradictionAdmissionError extends Error {
  public constructor() {
    super("The first-pass contradiction admission marker is malformed.");
    this.name = "FirstPassContradictionAdmissionError";
  }
}

const fail = (): never => {
  throw new FirstPassContradictionAdmissionError();
};
const kit = createContractKit<"invalid">({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid",
    invalidValue: "invalid",
    digestMismatch: "invalid",
    credentialMaterial: "invalid",
    schemaMismatch: "invalid",
  },
});

/** Call only on the host's admitted request, never on saved/agent/model text. */
export function firstPassContradictionAdmission(input: {
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly instruction: string;
  readonly contradiction: unknown;
  readonly sourcePaths?: readonly string[];
  readonly changeRequestSelector?: unknown;
  readonly changeSource?: unknown;
  readonly mergedMrSelection?: unknown;
  readonly readerTaskContext?: unknown;
  readonly readerSources?: readonly unknown[];
  readonly comparisonRequest?: unknown;
  readonly instructionContext?: string;
  readonly canonSnapshotPath?: unknown;
  readonly acceptCandidateSnapshot?: unknown;
  readonly canonSnapshotAuthorityId?: unknown;
  readonly planPath?: unknown;
  readonly taskLineage?: unknown;
  readonly contextTarget?: unknown;
  readonly compositionId?: unknown;
  readonly resumeFrom?: unknown;
  readonly operatorInputResume?: unknown;
  readonly knowledgeContinuationReceipt?: unknown;
  readonly answerRecordContinuationReceipt?: unknown;
  readonly draftMr?: unknown;
  readonly commentMr?: unknown;
  readonly releaseGate?: boolean;
  readonly remoteName?: unknown;
  readonly retainedEvidenceBindings?: unknown;
  readonly changeSources?: unknown;
}): FirstPassContradictionAdmissionV1 {
  const reasons: FirstPassContradictionAdmissionV1["reasons"][number][] = [];
  if ((input.sourcePaths?.length ?? 0) > 0 || input.retainedEvidenceBindings !== undefined)
    reasons.push("source");
  if (
    input.changeRequestSelector !== undefined ||
    input.changeSource !== undefined ||
    input.mergedMrSelection !== undefined ||
    input.changeSources !== undefined
  )
    reasons.push("change");
  if (
    input.readerTaskContext !== undefined ||
    (input.readerSources?.length ?? 0) > 0 ||
    input.comparisonRequest !== undefined
  )
    reasons.push("reader");
  // Non-authoritative live context is retained on the stopped record and replayed
  // byte-for-byte under its source-record digest; it does not bind an external source.
  if (
    input.canonSnapshotPath !== undefined ||
    input.acceptCandidateSnapshot !== undefined ||
    input.canonSnapshotAuthorityId !== undefined
  )
    reasons.push("snapshot");
  if (
    input.planPath !== undefined ||
    input.taskLineage !== undefined ||
    input.contextTarget !== undefined
  )
    reasons.push("plan");
  if (input.compositionId !== undefined) reasons.push("composition");
  if (
    input.resumeFrom !== undefined ||
    input.operatorInputResume !== undefined ||
    input.knowledgeContinuationReceipt !== undefined ||
    input.answerRecordContinuationReceipt !== undefined
  )
    reasons.push("continuation");
  if (
    input.draftMr === true ||
    input.commentMr !== undefined ||
    input.releaseGate === true ||
    input.remoteName !== undefined
  )
    reasons.push("publication");
  return kit.seal(FIRST_PASS_CONTRADICTION_ADMISSION_KIND, "admissionSha256", {
    outcome: reasons.length > 0 ? "external-binding-unsupported" : "repository-only",
    source: "host-request-observation",
    reasons,
    runId: kit.identifier(input.runId),
    repositoryRevision: kit.revision(input.repositoryRevision),
    instructionSha256: kit.canonicalDigest(input.instruction.normalize("NFC")),
    ...(input.instructionContext !== undefined
      ? {
          instructionContextSha256: kit.canonicalDigest(
            decodeRunRecordInstructionContext(input.instructionContext),
          ),
        }
      : {}),
    contradictionSha256: kit.canonicalDigest(input.contradiction),
  });
}

export function decodeFirstPassContradictionAdmission(
  value: unknown,
): FirstPassContradictionAdmissionV1 {
  kit.assertInert(value);
  const envelope = kit.object(value);
  const hasContext = Object.hasOwn(envelope, "instructionContextSha256");
  return kit.decodeSealed(
    value,
    FIRST_PASS_CONTRADICTION_ADMISSION_KIND,
    "admissionSha256",
    [
      "outcome",
      "source",
      "reasons",
      "runId",
      "repositoryRevision",
      "instructionSha256",
      ...(hasContext ? ["instructionContextSha256"] : []),
      "contradictionSha256",
    ],
    (root) => {
      const outcome = kit.enumeration(root.outcome, [
        "repository-only",
        "external-binding-unsupported",
      ] as const);
      const reasons = kit
        .array(root.reasons)
        .map((reason) =>
          kit.enumeration(reason, [
            "source",
            "change",
            "reader",
            "context",
            "snapshot",
            "plan",
            "composition",
            "continuation",
            "publication",
          ] as const),
        );
      if (
        new Set(reasons).size !== reasons.length ||
        (outcome === "repository-only") !== (reasons.length === 0)
      )
        fail();
      return {
        outcome,
        source: kit.enumeration(root.source, ["host-request-observation"] as const),
        reasons,
        runId: kit.identifier(root.runId),
        repositoryRevision: kit.revision(root.repositoryRevision),
        instructionSha256: kit.hash(root.instructionSha256),
        ...(hasContext
          ? { instructionContextSha256: kit.hash(root.instructionContextSha256) }
          : {}),
        contradictionSha256: kit.hash(root.contradictionSha256),
      };
    },
  );
}
