// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator's answer-submission option. `recorded`, the default,
 * lets a route whose composition recorded an `answerSubmission` capability
 * take the final quality evaluator's answer through a host tool call;
 * `text-final` keeps every route on the text answer. It selects a path, not a
 * bound, so it is a validated runtime option rather than a `config/limits`
 * entry, and it is parsed when the configuration loads so an unknown value
 * stops the command before any run starts.
 */

export const ANSWER_SUBMISSION_ENVIRONMENT = "DOCSFAB_ANSWER_SUBMISSION";

export const ANSWER_SUBMISSION_OPTIONS = Object.freeze(["recorded", "text-final"] as const);

export type AnswerSubmissionOption = (typeof ANSWER_SUBMISSION_OPTIONS)[number];

/** The option an unset variable selects. */
export const DEFAULT_ANSWER_SUBMISSION_OPTION: AnswerSubmissionOption = "recorded";

/** An answer-submission value that is not one of the closed options. */
export class AnswerSubmissionOptionError extends Error {
  public readonly code = "answer-submission-option-invalid" as const;
  public readonly nextAction: string;

  public constructor() {
    super(
      `${ANSWER_SUBMISSION_ENVIRONMENT} must be one of ${ANSWER_SUBMISSION_OPTIONS.join(", ")}.`,
    );
    this.name = "AnswerSubmissionOptionError";
    this.nextAction = `Set ${ANSWER_SUBMISSION_ENVIRONMENT} to text-final to keep the text answer on every route, or unset it to use each route's recorded answer submission.`;
  }
}

export function isAnswerSubmissionOption(value: unknown): value is AnswerSubmissionOption {
  return (ANSWER_SUBMISSION_OPTIONS as readonly unknown[]).includes(value);
}

/** The effective option; an unset or empty variable is the default. */
export function parseAnswerSubmissionOption(
  environment: NodeJS.ProcessEnv,
): AnswerSubmissionOption {
  const raw = environment[ANSWER_SUBMISSION_ENVIRONMENT]?.trim();
  if (!raw) return DEFAULT_ANSWER_SUBMISSION_OPTION;
  if (!isAnswerSubmissionOption(raw)) throw new AnswerSubmissionOptionError();
  return raw;
}
