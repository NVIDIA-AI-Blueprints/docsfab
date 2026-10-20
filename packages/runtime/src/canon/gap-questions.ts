// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed foundation gap questions.
 *
 * Questions are content-minimized sealed records bound to a canon version and
 * repository/input digests. Free-form model text is never a question authority.
 */

import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import type { FoundationCanonV1 } from "./contracts.js";

export const FOUNDATION_GAP_QUESTION_KINDS = [
  "missing-fact",
  "conflict-resolution",
  "applicability",
  "audience",
  "ownership",
  "support-commitment",
  "output-scope",
  "accepted-assumption",
] as const;

export type FoundationGapQuestionKind = (typeof FOUNDATION_GAP_QUESTION_KINDS)[number];

export type FoundationGapQuestionContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required";

export class FoundationGapQuestionContractError extends Error {
  public constructor(public readonly code: FoundationGapQuestionContractErrorCode) {
    super(`Foundation gap question rejected: ${code}.`);
    this.name = "FoundationGapQuestionContractError";
  }
}

function fail(code: FoundationGapQuestionContractErrorCode): never {
  throw new FoundationGapQuestionContractError(code);
}

const kit = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export interface FoundationGapQuestionBodyV1 {
  id: string;
  /** Typed gap category — not the sealed envelope kind. */
  questionKind: FoundationGapQuestionKind;
  /** Stable operator-facing label; never a host path or credential. */
  promptLabel: string;
  canonId: string;
  canonVersion: string;
  canonSha256: string;
  repository: {
    identitySha256: string;
    revision: string;
    contentDigestSha256: string;
  };
  inputBinding: {
    manifestSha256: string;
    inputIds: string[];
  };
  /** Optional conflict or missing-fact token this question resolves. */
  gapToken: string | null;
}

export type FoundationGapQuestionV1 = FoundationGapQuestionBodyV1 & {
  schemaVersion: 1;
  kind: "docsfab-foundation-gap-question";
  questionSha256: string;
};

/** Seal a typed gap question bound to an exact canon version. */
export function createFoundationGapQuestion(
  input: FoundationGapQuestionBodyV1,
): FoundationGapQuestionV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal(
    "docsfab-foundation-gap-question",
    "questionSha256",
    normalizeBody(kit.object(input)),
  ) as FoundationGapQuestionV1;
}

/** Structural decode only — never confers answer/decision authority. */
export function decodeFoundationGapQuestion(value: unknown): FoundationGapQuestionV1 {
  return kit.decodeSealed(
    value,
    "docsfab-foundation-gap-question",
    "questionSha256",
    [
      "id",
      "questionKind",
      "promptLabel",
      "canonId",
      "canonVersion",
      "canonSha256",
      "repository",
      "inputBinding",
      "gapToken",
    ],
    normalizeBody,
  ) as FoundationGapQuestionV1;
}

/**
 * Project the closed typed question set for a foundation canon that still has
 * critical gaps. Deterministic for the same canon + gap tokens.
 */
export function projectFoundationGapQuestions(input: {
  canon: FoundationCanonV1;
  missingFacts?: readonly string[];
  conflictIds?: readonly string[];
  evidenceLimitations?: readonly string[];
}): readonly FoundationGapQuestionV1[] {
  const canon = input.canon;
  const missing = [...(input.missingFacts ?? [])].sort(kit.compare);
  const conflicts = [...(input.conflictIds ?? [])].sort(kit.compare);
  const limitations = [...(input.evidenceLimitations ?? [])].sort(kit.compare);
  const questions: FoundationGapQuestionV1[] = [];

  const push = (
    id: string,
    questionKind: FoundationGapQuestionKind,
    promptLabel: string,
    gapToken: string | null,
  ): void => {
    questions.push(
      createFoundationGapQuestion({
        id,
        questionKind,
        promptLabel,
        canonId: canon.canonId,
        canonVersion: canon.version,
        canonSha256: canon.canonSha256,
        repository: { ...canon.repository },
        inputBinding: {
          manifestSha256: canon.inputBinding.manifestSha256,
          inputIds: [...canon.inputBinding.inputIds],
        },
        gapToken,
      }),
    );
  };

  if (
    missing.includes("registered-evidence-absent") ||
    limitations.some(
      (item) => item.startsWith("blocked-source:") || item.startsWith("weak-source:"),
    )
  ) {
    push(
      "q-missing-fact-source",
      "missing-fact",
      "What authoritative source binds product truth for the current revision?",
      "registered-evidence-absent",
    );
  }
  if (
    missing.includes("verified-claims-absent") ||
    missing.includes("repository-instructions-absent")
  ) {
    push(
      "q-ownership",
      "ownership",
      "Who owns documentation accuracy for the current version series?",
      missing.includes("verified-claims-absent")
        ? "verified-claims-absent"
        : "repository-instructions-absent",
    );
    push(
      "q-support-commitment",
      "support-commitment",
      "What support channel is authoritative for end users?",
      "support-commitment",
    );
    push("q-audience", "audience", "What audience applies to derived documentation?", "audience");
    push(
      "q-output-scope",
      "output-scope",
      "What output scope applies to derived documentation?",
      "output-scope",
    );
    push(
      "q-applicability",
      "applicability",
      "Which version series is currently in force?",
      "applicability",
    );
    push(
      "q-accepted-assumption",
      "accepted-assumption",
      "Which operating assumption may be accepted until verified?",
      "accepted-assumption",
    );
  }
  for (const conflictId of conflicts) {
    push(
      `q-conflict-${conflictId}`,
      "conflict-resolution",
      `How should conflict ${conflictId} be resolved for the current revision?`,
      `unresolved-conflict:${conflictId}`,
    );
  }

  return deepFreeze([...questions].sort((left, right) => kit.compare(left.id, right.id)));
}

function normalizeBody(root: Record<string, unknown>): FoundationGapQuestionBodyV1 {
  kit.exact(root, [
    "id",
    "questionKind",
    "promptLabel",
    "canonId",
    "canonVersion",
    "canonSha256",
    "repository",
    "inputBinding",
    "gapToken",
  ]);
  const repository = kit.object(root.repository);
  kit.exact(repository, ["identitySha256", "revision", "contentDigestSha256"]);
  const inputBinding = kit.object(root.inputBinding);
  kit.exact(inputBinding, ["manifestSha256", "inputIds"]);
  const promptLabel = kit.string(root.promptLabel);
  if (promptLabel.length === 0 || promptLabel.length > 512 || promptLabel.includes("\0")) {
    fail("invalid-value");
  }
  return {
    id: kit.identifier(root.id),
    questionKind: kit.enumeration(root.questionKind, FOUNDATION_GAP_QUESTION_KINDS),
    promptLabel,
    canonId: kit.identifier(root.canonId),
    canonVersion: kit.identifier(root.canonVersion),
    canonSha256: kit.hash(root.canonSha256),
    repository: {
      identitySha256: kit.hash(repository.identitySha256),
      revision: kit.revision(repository.revision),
      contentDigestSha256: kit.hash(repository.contentDigestSha256),
    },
    inputBinding: {
      manifestSha256: kit.hash(inputBinding.manifestSha256),
      inputIds: kit.array(inputBinding.inputIds).map(kit.identifier).sort(kit.compare),
    },
    gapToken: root.gapToken === null ? null : kit.identifier(root.gapToken),
  };
}
