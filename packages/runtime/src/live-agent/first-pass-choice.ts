// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A live reply may select one saved host option; all other text routes normally. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { findExecutableEvidenceValue } from "../repository/executable-evidence-value.js";

import { canonicalDigest } from "../content-ir/canonical.js";
import { decodeRunRecordFirstPassContradiction } from "../cli/run/first-pass-contradiction-stop.js";
import { FileRunStore } from "../records/file-store.js";
import { runRecordMaxBytes } from "../records/run-record-limit.js";
import { decodeSavedRunRecord } from "../records/saved-run-record.js";
import { decodeFirstPassContradictionAdmission } from "../records/first-pass-contradiction-admission.js";
import { createFirstPassChoice, type FirstPassChoiceV1 } from "../records/first-pass-choice.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";

export interface LiveFirstPassChoicePlanV1 {
  readonly workflow: "create-documentation" | "update-documentation";
  readonly instruction: string;
  readonly instructionContext?: string;
  readonly revision: string;
  readonly sourceRunId: string;
  readonly choices: readonly FirstPassChoiceV1[];
}

export type LiveFirstPassChoiceTurnV1 =
  | { readonly kind: "routing" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "choice"; readonly plan: LiveFirstPassChoicePlanV1 };

const IMPLEMENTATION_REPLY = /^Use the implementation(?::\s*(.+))?\.?$/iu;

function currentRevision(repositoryPath: string): string {
  return execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function executableSide(input: {
  readonly repositoryPath: string;
  readonly revision: string;
  readonly side: { path: string; lineStart: number; lineEnd: number; value: string | null };
}): boolean {
  if (
    !/\.[cm]?[jt]sx?$/iu.test(input.side.path) ||
    input.side.path.startsWith("-") ||
    input.side.path.includes("..") ||
    input.side.path.startsWith("/")
  )
    return false;
  let source: string;
  try {
    source = execFileSync(
      "git",
      ["-C", input.repositoryPath, "show", `${input.revision}:${input.side.path}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: runRecordMaxBytes().value,
      },
    );
  } catch {
    return false;
  }
  return findExecutableEvidenceValue({ source, side: input.side }) !== undefined;
}

/** Does not infer a workflow from reply words; only a live saved stop can supply options. */
export async function planLiveFirstPassChoice(input: {
  readonly stateDirectory: string;
  readonly repositoryPath: string;
  readonly pendingRunId?: string;
  readonly replyText: string;
}): Promise<LiveFirstPassChoiceTurnV1> {
  if (!input.pendingRunId) return { kind: "routing" };
  const reply = input.replyText.trim();
  // Obligation prefixes are opaque; exact saved-option matching below supplies identity.
  if (!/^(?:[\s\S]+: )?Use |^Withhold /iu.test(reply)) return { kind: "routing" };
  try {
    assertConfinedToolResultCredentialFree(reply);
  } catch {
    return {
      kind: "refused",
      reason: "The reply contains configured credential material and cannot be used as a choice.",
    };
  }
  const store = new FileRunStore(input.stateDirectory);
  let saved: Awaited<ReturnType<FileRunStore["getWithDigest"]>>;
  try {
    saved = await store.getWithDigest(input.pendingRunId, { maxBytes: runRecordMaxBytes().value });
  } catch {
    return { kind: "refused", reason: "The stopped run is unavailable. Start a new run." };
  }
  let source;
  try {
    source = decodeSavedRunRecord(saved.record as never, input.pendingRunId);
  } catch {
    return { kind: "refused", reason: "The stopped run could not be verified. Start a new run." };
  }
  if (
    source.status !== "needs-input" ||
    source.error !== "contradicted" ||
    (source.workflow !== "create-documentation" && source.workflow !== "update-documentation") ||
    source.firstPassContradiction === undefined ||
    source.firstPassContradictionAdmission === undefined ||
    !source.instruction
  )
    return {
      kind: "refused",
      reason: "This stop has no eligible first-pass choice. Start a new run.",
    };
  let admission;
  let field;
  try {
    admission = decodeFirstPassContradictionAdmission(source.firstPassContradictionAdmission);
    field = decodeRunRecordFirstPassContradiction(source.firstPassContradiction);
    assertConfinedToolResultCredentialFree(field.question);
    if (source.instructionContext !== undefined)
      assertConfinedToolResultCredentialFree(source.instructionContext);
  } catch {
    return {
      kind: "refused",
      reason: "The saved first-pass options are invalid or unsafe. Start a new run.",
    };
  }
  if (admission.outcome !== "repository-only")
    return {
      kind: "refused",
      reason:
        "This stopped run bound external or non-replayable evidence. Start a new run with those sources.",
    };
  let repositoryPath: string;
  try {
    repositoryPath = realpathSync(resolve(input.repositoryPath));
    if (
      realpathSync(resolve(source.repository.sourcePath)) !== repositoryPath ||
      currentRevision(repositoryPath) !== source.repository.revision
    )
      throw new Error("The repository revision no longer matches the saved contradiction stop.");
  } catch {
    return {
      kind: "refused",
      reason: "The repository or revision changed. Start a new run at the current revision.",
    };
  }
  const sideOptions = field.contradictions.flatMap((item) =>
    item.sides.map((side) => ({ obligationId: item.obligationId, side })),
  );
  let optionIndex = field.question.options.indexOf(reply);
  if (optionIndex >= 0 && field.question.options.indexOf(reply, optionIndex + 1) >= 0)
    return {
      kind: "refused",
      reason:
        "That offered option identifies more than one source. Reply with an unambiguous obligation and source.",
    };
  if (optionIndex < 0 && IMPLEMENTATION_REPLY.test(reply)) {
    const match = IMPLEMENTATION_REPLY.exec(reply);
    const candidates = sideOptions.flatMap((item, index) =>
      executableSide({ repositoryPath, revision: source.repository.revision, side: item.side })
        ? [{ ...item, index }]
        : [],
    );
    if (candidates.length !== 1)
      return {
        kind: "refused",
        reason:
          "DocsFab could not identify exactly one executable implementation side. Reply with one exact offered option and its obligation.",
      };
    const candidate = candidates[0]!;
    const suffix = match?.[1]?.trim().replace(/\.$/u, "");
    if (
      suffix &&
      (candidate.side.value === null ||
        (suffix !== `${candidate.side.value} from ${candidate.side.path}` &&
          suffix !== `"${candidate.side.value}" from ${candidate.side.path}`))
    )
      return {
        kind: "refused",
        reason:
          "The implementation reply does not match the offered source. Reply with its exact option.",
      };
    optionIndex = candidate.index;
  }
  if (optionIndex < 0) {
    if (!/^(?:[\s\S]+: )?Use (?:".*" from |what .+ states)|^Withhold /iu.test(reply))
      return { kind: "routing" };
    return {
      kind: "refused",
      reason: "That choice was not offered by this run. Reply with one exact option.",
    };
  }
  if (optionIndex === field.question.options.length - 1)
    return {
      kind: "refused",
      reason:
        "The disputed section is not mapped precisely enough to withhold in place. Name the section to omit in a new request.",
    };
  const selected = sideOptions[optionIndex];
  if (!selected)
    return {
      kind: "refused",
      reason:
        "The selected source was not offered by this run. Start a new run with clearer evidence.",
    };
  try {
    assertConfinedToolResultCredentialFree(selected.side);
  } catch {
    return {
      kind: "refused",
      reason: "The offered source contains configured credential material and cannot be chosen.",
    };
  }
  const choice = createFirstPassChoice({
    sourceRunId: source.id,
    sourceRunRecordSha256: saved.sha256,
    successorRunId: randomUUID(),
    repositoryPathSha256: canonicalDigest(repositoryPath),
    repositoryRevision: source.repository.revision,
    instructionSha256: canonicalDigest(source.instruction.normalize("NFC")),
    contradictionSha256: canonicalDigest(source.firstPassContradiction),
    obligationId: selected.obligationId,
    optionIndex,
    optionSha256: canonicalDigest(field.question.options[optionIndex]),
    selection: "side",
    selectedAt: new Date().toISOString(),
  });
  return {
    kind: "choice",
    plan: {
      workflow: source.workflow,
      instruction: source.instruction,
      ...(source.instructionContext !== undefined
        ? { instructionContext: source.instructionContext }
        : {}),
      revision: source.repository.revision,
      sourceRunId: source.id,
      choices: [...(source.firstPassChoices ?? []), choice],
    },
  };
}
