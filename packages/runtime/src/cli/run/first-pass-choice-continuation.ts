// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Recheck every saved-run binding before an offered choice reaches first pass. */
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { canonicalDigest } from "../../content-ir/canonical.js";
import { FileRunStore } from "../../records/file-store.js";
import { FirstPassChoiceClaimStore } from "../../records/first-pass-choice-store.js";
import { runRecordMaxBytes } from "../../records/run-record-limit.js";
import { decodeSavedRunRecord } from "../../records/saved-run-record.js";
import { decodeFirstPassChoice, type FirstPassChoiceV1 } from "../../records/first-pass-choice.js";
import { decodeFirstPassReplay, type FirstPassReplayV1 } from "../../records/first-pass-replay.js";
import {
  decodeFirstPassContradictionAdmission,
  firstPassContradictionAdmission,
} from "../../records/first-pass-contradiction-admission.js";
import { decodeRunRecordRequestIntent } from "../../request-intent/interpret-record.js";
import {
  decodeRunRecordFirstPassContradiction,
  type RunRecordFirstPassContradictionV1,
} from "./first-pass-contradiction-stop.js";
import type { RunRequestWithPublishProjection } from "./request.js";
import type { DocsFabConfig } from "../../config/runtime-loader.js";

const FIRST_PASS_CHOICE_CONTINUATION_CODES = [
  "ineligible",
  "stale",
  "foreign",
  "tampered",
] as const;

export class FirstPassChoiceContinuationError extends Error {
  public constructor(public readonly code: (typeof FIRST_PASS_CHOICE_CONTINUATION_CODES)[number]) {
    super(
      `The saved first-pass choice cannot continue this run (${code}). Start a new run with the current repository evidence.`,
    );
    this.name = "FirstPassChoiceContinuationError";
  }
}

export const FIRST_PASS_CHOICE_CONTINUATION_MESSAGES: readonly string[] =
  FIRST_PASS_CHOICE_CONTINUATION_CODES.map(
    (code) => new FirstPassChoiceContinuationError(code).message,
  );

/** Render only host-known codes, never an exception's mutable message. */
export function firstPassChoiceContinuationMessage(error: unknown): string | undefined {
  return error instanceof FirstPassChoiceContinuationError &&
    FIRST_PASS_CHOICE_CONTINUATION_CODES.includes(error.code)
    ? new FirstPassChoiceContinuationError(error.code).message
    : undefined;
}

function fail(code: FirstPassChoiceContinuationError["code"]): never {
  throw new FirstPassChoiceContinuationError(code);
}

export interface BoundFirstPassChoiceV1 {
  readonly choice: FirstPassChoiceV1;
  readonly source: RunRecordFirstPassContradictionV1;
}

export async function validateFirstPassChoiceContinuation(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly config: Pick<DocsFabConfig, "stateDirectory">;
}): Promise<{
  readonly choices: readonly BoundFirstPassChoiceV1[];
  readonly requestIntent: ReturnType<typeof decodeRunRecordRequestIntent>;
  readonly replay?: FirstPassReplayV1;
}> {
  const rawChoices = input.request.firstPassChoices;
  if (!rawChoices?.length) fail("ineligible");
  if (
    firstPassContradictionAdmission({
      ...input.request,
      runId: input.request.runId ?? "missing",
      repositoryRevision: input.request.revision,
      instruction: input.request.instruction ?? "",
      contradiction: {},
    }).outcome !== "repository-only"
  )
    fail("ineligible");
  const choices = rawChoices.map(decodeFirstPassChoice);
  if (choices.some((choice) => choice.selection !== "side")) fail("ineligible");
  const actualRepository = realpathSync(resolve(input.request.repositoryPath));
  const currentRevision = execFileSync("git", ["-C", actualRepository, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const bound: BoundFirstPassChoiceV1[] = [];
  let requestIntent: ReturnType<typeof decodeRunRecordRequestIntent> | undefined;
  let replay: FirstPassReplayV1 | undefined;
  for (const [index, choice] of choices.entries()) {
    let saved: Awaited<ReturnType<FileRunStore["getWithDigest"]>>;
    try {
      saved = await new FileRunStore(input.config.stateDirectory).getWithDigest(
        choice.sourceRunId,
        { maxBytes: runRecordMaxBytes().value },
      );
    } catch {
      fail("ineligible");
    }
    if (saved.sha256 !== choice.sourceRunRecordSha256) fail("stale");
    const source = decodeSavedRunRecord(saved.record as never, choice.sourceRunId);
    const sourceReplay = source.firstPassReplay
      ? decodeFirstPassReplay(source.firstPassReplay)
      : undefined;
    try {
      if (
        !(await new FirstPassChoiceClaimStore(input.config.stateDirectory).verifyReplay(
          choice.sourceRunId,
          sourceReplay?.replaySha256,
          saved.sha256,
        ))
      )
        fail("tampered");
    } catch {
      fail("tampered");
    }
    if (index > 0 && replay?.replaySha256 !== sourceReplay?.replaySha256) fail("tampered");
    if (index === 0) replay = sourceReplay;
    if (
      source.workflow !== input.request.workflow ||
      source.status !== "needs-input" ||
      source.error !== "contradicted" ||
      source.steps.length !== 0 ||
      source.firstPassContradiction === undefined ||
      source.firstPassContradictionAdmission === undefined
    )
      fail("ineligible");
    if (
      canonicalDigest(source.firstPassChoices ?? []) !== canonicalDigest(choices.slice(0, index)) ||
      (index > 0 && choices[index - 1]!.successorRunId !== choice.sourceRunId)
    )
      fail("tampered");
    const admission = decodeFirstPassContradictionAdmission(source.firstPassContradictionAdmission);
    if (admission.outcome !== "repository-only") fail("ineligible");
    let sourceRepository: string;
    try {
      sourceRepository = realpathSync(resolve(source.repository.sourcePath));
    } catch {
      fail("foreign");
    }
    if (
      sourceRepository !== actualRepository ||
      choice.repositoryPathSha256 !== canonicalDigest(actualRepository)
    )
      fail("foreign");
    if (
      choice.repositoryRevision !== source.repository.revision ||
      currentRevision !== choice.repositoryRevision ||
      input.request.revision !== choice.repositoryRevision ||
      choice.instructionSha256 !== canonicalDigest(source.instruction?.normalize("NFC") ?? "") ||
      input.request.instruction !== source.instruction ||
      input.request.instructionContext !== source.instructionContext ||
      choice.contradictionSha256 !== canonicalDigest(source.firstPassContradiction)
    )
      fail("stale");
    const field = decodeRunRecordFirstPassContradiction(source.firstPassContradiction);
    if (
      field.question.options[choice.optionIndex] === undefined ||
      canonicalDigest(field.question.options[choice.optionIndex]) !== choice.optionSha256
    )
      fail("tampered");
    const offered = field.contradictions.flatMap((item) => item.sides.map(() => item.obligationId));
    const obligation =
      choice.selection === "withhold"
        ? field.contradictions.length === 1
          ? field.contradictions[0]!.obligationId
          : undefined
        : offered[choice.optionIndex];
    if (
      obligation !== choice.obligationId ||
      (choice.selection === "withhold") !==
        (choice.optionIndex === field.question.options.length - 1)
    )
      fail("tampered");
    try {
      const decoded = decodeRunRecordRequestIntent(source.requestIntent, source.instruction);
      if (requestIntent && canonicalDigest(decoded) !== canonicalDigest(requestIntent))
        fail("tampered");
      requestIntent = decoded;
    } catch {
      fail("tampered");
    }
    bound.push({ choice, source: field });
  }
  if (choices.at(-1)!.successorRunId !== input.request.runId) fail("tampered");
  if (new Set(choices.map((choice) => choice.obligationId)).size !== choices.length)
    fail("tampered");
  return { choices: bound, requestIntent: requestIntent!, ...(replay ? { replay } : {}) };
}

/** Execution admission additionally requires the host's private successor claim. */
export async function loadFirstPassChoiceContinuation(
  input: Parameters<typeof validateFirstPassChoiceContinuation>[0],
): ReturnType<typeof validateFirstPassChoiceContinuation> {
  const validated = await validateFirstPassChoiceContinuation(input);
  const claims = new FirstPassChoiceClaimStore(input.config.stateDirectory);
  for (const [index, bound] of validated.choices.entries()) {
    let admission: Awaited<ReturnType<FirstPassChoiceClaimStore["executionAdmission"]>>;
    try {
      admission = await claims.executionAdmission(
        bound.choice,
        index === validated.choices.length - 1,
      );
    } catch {
      fail("tampered");
    }
    if (admission === "missing" || admission === "foreign-owner") fail("ineligible");
    if (admission !== "matched") fail("tampered");
  }
  return validated;
}
