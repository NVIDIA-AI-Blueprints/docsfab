// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The questions the host asks when the repository or the run, not the model,
 * leaves a choice only the operator can make.
 *
 * Each question is built from structure only: the observed path, the
 * existence answer, and the proposed operation. Nothing here reads the
 * request's wording. Every question offers `stop` last and recommends it, and
 * nothing is written until the operator reruns. The catalog owns each code's
 * kind, retry and operator text; these builders own only the question the
 * rule asks.
 */
import type {
  RequestIntentExistenceKind,
  RequestIntentOperation,
  RequestIntentQuestion,
  RequestIntentSupplyCode,
} from "./contract.js";

const STOP = "stop";
const CONSEQUENCE = "Nothing is written; the run stops until the operator reruns it.";

/** A Supply stop's code and the four-field question it seals as `intent.question`. */
export interface RequestIntentSupplyDecision {
  readonly code: RequestIntentSupplyCode;
  readonly question: RequestIntentQuestion;
}

function decision(
  code: RequestIntentSupplyCode,
  question: string,
  choices: readonly string[],
): RequestIntentSupplyDecision {
  return {
    code,
    question: {
      question,
      options: [...choices, STOP],
      recommendedDefault: STOP,
      consequence: CONSEQUENCE,
    },
  };
}

/** How an existing entry blocks a create. */
const PRESENT_WORDING: Record<Exclude<RequestIntentExistenceKind, "absent">, string> = {
  file: "is an existing file",
  "case-fold": "exists under another letter case or as a link, submodule, or excluded entry",
  directory: "is an existing directory",
  "parent-file": "is under an existing file",
  "file-not-granted": "is an existing file",
};

/**
 * A create run whose reading names no page: only the operator can name the
 * new page's path. Worded with the run's own operation, so a reading of
 * another operation still asks about the page the run would create.
 */
export function targetMissing(operation: RequestIntentOperation) {
  return decision(
    "request-intent-target-missing",
    `The request names no page to ${operation}. Which page is meant?`,
    ["name-a-target"],
  );
}

/** A non-create target that does not exist. */
export function targetAbsent(operation: RequestIntentOperation, path: string) {
  return decision(
    "request-intent-target-absent",
    `The request asks to ${operation} ${path}, which does not exist. What should happen?`,
    ["rerun-as-create", "name-an-existing-page"],
  );
}

/** A create target where an entry already exists, in any form. */
export function targetPresent(
  path: string,
  existing: Exclude<RequestIntentExistenceKind, "absent">,
) {
  return decision(
    "request-intent-target-present",
    `The request asks to create ${path}, which ${PRESENT_WORDING[existing]}. What should happen?`,
    ["rerun-as-update", "name-a-new-path"],
  );
}

/**
 * A non-create target that collides with no editable base: a case variant,
 * a link, a submodule, or an excluded entry, as the plan-binding oracle maps
 * its `case-fold` answer.
 */
export function targetCaseAmbiguous(operation: RequestIntentOperation, path: string) {
  return decision(
    "request-intent-target-case-ambiguous",
    `The request asks to ${operation} ${path}, which ${PRESENT_WORDING["case-fold"]}, not a page DocsFab can edit. Which exact path is meant?`,
    ["name-the-exact-path"],
  );
}

/** A non-create target that is a directory or sits under a file. */
export function targetNotFile(
  operation: RequestIntentOperation,
  path: string,
  existing: "directory" | "parent-file",
) {
  const where = existing === "directory" ? "is a directory" : "is under an existing file";
  return decision(
    "request-intent-target-not-file",
    `The request asks to ${operation} ${path}, which ${where}. Which file is meant?`,
    ["name-a-file"],
  );
}
