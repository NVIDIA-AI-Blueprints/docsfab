// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Closed provenance for a host-offered operator choice, never the raw reply. */
import { createContractKit } from "../contract-kit/index.js";
import { SAFE_RECORD_ID } from "./file-store.js";

export const FIRST_PASS_CHOICE_KIND = "docsfab-first-pass-choice" as const;

export interface FirstPassChoiceV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof FIRST_PASS_CHOICE_KIND;
  readonly sourceRunId: string;
  readonly sourceRunRecordSha256: string;
  readonly successorRunId: string;
  readonly repositoryPathSha256: string;
  readonly repositoryRevision: string;
  readonly instructionSha256: string;
  readonly contradictionSha256: string;
  readonly obligationId: string;
  readonly optionIndex: number;
  readonly optionSha256: string;
  readonly selection: "side" | "withhold";
  readonly selectedAt: string;
  readonly choiceSha256: string;
}

export class FirstPassChoiceError extends Error {
  public constructor() {
    super("The first-pass choice does not match a bound offered option.");
    this.name = "FirstPassChoiceError";
  }
}

const fail = (): never => {
  throw new FirstPassChoiceError();
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

function id(value: unknown): string {
  const result = kit.string(value);
  if (!SAFE_RECORD_ID.test(result)) fail();
  return result;
}

function body(root: Record<string, unknown>) {
  if (!Number.isSafeInteger(root.optionIndex) || Number(root.optionIndex) < 0) fail();
  const obligationId = kit.string(root.obligationId);
  if (!obligationId) fail();
  return {
    sourceRunId: id(root.sourceRunId),
    sourceRunRecordSha256: kit.hash(root.sourceRunRecordSha256),
    successorRunId: id(root.successorRunId),
    repositoryPathSha256: kit.hash(root.repositoryPathSha256),
    repositoryRevision: kit.revision(root.repositoryRevision),
    instructionSha256: kit.hash(root.instructionSha256),
    contradictionSha256: kit.hash(root.contradictionSha256),
    obligationId,
    optionIndex: root.optionIndex as number,
    optionSha256: kit.hash(root.optionSha256),
    selection: kit.enumeration(root.selection, ["side", "withhold"] as const),
    selectedAt: kit.timestamp(root.selectedAt),
  };
}

/** Mint only after the host has decoded the original stop and selected its option. */
export function createFirstPassChoice(
  input: Omit<FirstPassChoiceV1, "schemaVersion" | "kind" | "choiceSha256">,
): FirstPassChoiceV1 {
  return kit.seal(FIRST_PASS_CHOICE_KIND, "choiceSha256", body(input));
}

export function decodeFirstPassChoice(value: unknown): FirstPassChoiceV1 {
  return kit.decodeSealed(
    value,
    FIRST_PASS_CHOICE_KIND,
    "choiceSha256",
    [
      "sourceRunId",
      "sourceRunRecordSha256",
      "successorRunId",
      "repositoryPathSha256",
      "repositoryRevision",
      "instructionSha256",
      "contradictionSha256",
      "obligationId",
      "optionIndex",
      "optionSha256",
      "selection",
      "selectedAt",
    ],
    body,
  );
}
