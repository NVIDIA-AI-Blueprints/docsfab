// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Values a consumer excludes on purpose, written out here rather than derived
 * from the consumer's own list, so a consumer that starts dropping a value
 * fails as a changed domain instead of passing silently. Each excluded value
 * must still get the consumer's explicit refusal or no-op.
 */
import type { PairingFamily } from "./known-failures.js";

export interface DeclaredExclusion {
  readonly consumer: string;
  readonly family: PairingFamily;
  readonly excluded: readonly string[];
  /** What the consumer does with an excluded value, checked by the tests. */
  readonly handling: { readonly kind: "runs-import-not-terminal" };
}

/**
 * The run index holds only finished runs: a queued or running record is
 * listed as not terminal by `runs import` and indexed once it finishes.
 * `why` has no exclusion: its refusal of an unfinished run is the same one a
 * missing run gets, so that gap is a known failure, not a declared domain.
 */
export const DECLARED_EXCLUSIONS: readonly DeclaredExclusion[] = Object.freeze([
  {
    consumer: "runs-query",
    family: "run-status",
    excluded: ["queued", "running"],
    handling: { kind: "runs-import-not-terminal" },
  },
]);

/**
 * Families a consumer carries no field for. The run index carries readiness
 * disposition only; generic product disposition and editorial outcomes stay
 * on `runs show`. `why` exposes readiness only for its exact workflow.
 */
export const FAMILIES_NOT_CARRIED: readonly {
  readonly consumer: string;
  readonly family: PairingFamily;
}[] = Object.freeze([
  { consumer: "runs-query", family: "product-disposition" },
  { consumer: "runs-query", family: "editorial-outcome" },
  { consumer: "why", family: "product-disposition" },
  { consumer: "why", family: "editorial-outcome" },
]);

/** The deliberately narrow disposition projection the run index carries. */
export const INDEX_PROJECTIONS: readonly {
  readonly family: PairingFamily;
  readonly field: string;
  readonly workflow: "readiness";
}[] = Object.freeze([
  { family: "readiness-disposition", field: "readinessDisposition", workflow: "readiness" },
]);

export function declaredExclusion(
  consumer: string,
  family: PairingFamily,
  value: string,
): DeclaredExclusion | undefined {
  return DECLARED_EXCLUSIONS.find(
    (entry) =>
      entry.consumer === consumer && entry.family === family && entry.excluded.includes(value),
  );
}
