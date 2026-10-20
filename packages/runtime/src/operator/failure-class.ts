// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The closed failure-class vocabulary. Every DocsFab failure carries one class,
 * the layer that produced it, and the catalogued code the class was read from.
 * Code-to-class tables live in `failure-classification.ts` and the situation
 * catalog. This module has no imports, so the harness can load it through the
 * facade.
 *
 * Append only: a recorded class keeps its meaning for the life of its records.
 */

/** Every failure class, in the order reports list them. */
export const FAILURE_CLASSES = Object.freeze([
  "model-content",
  "contract-shape",
  "planning-refusal",
  "operator-input",
  "bound",
  "auth",
  "infrastructure",
  "flake",
  "cancelled",
  "unknown",
] as const);

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Where a failure was produced. */
export const FAILURE_LAYERS = Object.freeze([
  /** The operator boundary before a run exists: CLI and live-agent refusals. */
  "cli",
  /** A workflow step or run that is not a model attempt. */
  "workflow",
  /** A model attempt, or a step that failed because its model attempt did. */
  "inference",
  /** The host dispatcher around a hosted runtime attempt. */
  "host",
  /** The local-workflows harness that drives and judges a case. */
  "harness",
] as const);

export type FailureLayer = (typeof FAILURE_LAYERS)[number];

/** One sentence per class: what it means, never what a specific run did. */
export const FAILURE_CLASS_MEANINGS: Readonly<Record<FailureClass, string>> = Object.freeze({
  "model-content":
    "The model's reply was well formed, but its content broke a host rule, such as a fact link, a status, or a locator.",
  "contract-shape":
    "An artifact did not match its contract shape: unparseable JSON, missing or unexpected fields, or a producer-side binding defect.",
  "planning-refusal":
    "DocsFab refused to plan or admit the request as given, before or instead of executing it.",
  "operator-input":
    "The request, options, checkout, or configuration the operator supplied is invalid for this command.",
  bound: "An operational limit from config/limits.yaml, or a model output allowance, was reached.",
  auth: "A credential, login, approval, or authority grant is missing, expired, or insufficient.",
  infrastructure:
    "A tool, process, network, provider, or file system DocsFab depends on was unavailable or failed.",
  flake:
    "A condition the provider marks as repeatable, such as throttling or a provider transient error, that can clear on retry.",
  cancelled: "An operator or the host stopped the work on purpose.",
  unknown:
    "DocsFab has no evidence of one cause: the code is uncatalogued, or it covers several causes. The code shows what to catalogue or split.",
});

/** The recorded classification; `code` is the catalogued code the class was read from. */
export interface FailureClassificationV1 {
  readonly class: FailureClass;
  readonly layer: FailureLayer;
  readonly code: string;
}

/** Kebab-case, bounded. Codes are closed host vocabulary, never model text. */
const FAILURE_CODE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export function isFailureClass(value: unknown): value is FailureClass {
  return (FAILURE_CLASSES as readonly unknown[]).includes(value);
}

export function isFailureLayer(value: unknown): value is FailureLayer {
  return (FAILURE_LAYERS as readonly unknown[]).includes(value);
}

export function isFailureCode(value: unknown): value is string {
  return typeof value === "string" && FAILURE_CODE.test(value);
}

/** A frozen classification; throws on a value outside the closed vocabulary. */
export function failureClassification(
  failureClass: FailureClass,
  layer: FailureLayer,
  code: string,
): FailureClassificationV1 {
  if (!isFailureClass(failureClass) || !isFailureLayer(layer) || !isFailureCode(code)) {
    throw new TypeError(
      "A failure classification needs a catalogued class, layer, and kebab-case code.",
    );
  }
  return Object.freeze({ class: failureClass, layer, code });
}

/**
 * Read a recorded classification from untrusted input. Exact keys and closed
 * values only; anything else reads as `null`, never a guessed class.
 */
export function readFailureClassification(value: unknown): FailureClassificationV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "class" || keys[1] !== "code" || keys[2] !== "layer") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isFailureClass(candidate.class) ||
    !isFailureLayer(candidate.layer) ||
    !isFailureCode(candidate.code)
  ) {
    return null;
  }
  return Object.freeze({ class: candidate.class, layer: candidate.layer, code: candidate.code });
}

/** `model-content (layer inference, code invalid-fact-link)`. */
export function describeFailureClassification(failure: FailureClassificationV1): string {
  return `${failure.class} (layer ${failure.layer}, code ${failure.code})`;
}
