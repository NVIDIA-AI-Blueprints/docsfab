// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CREATE revision writer's bounded correction round.
 *
 * The writer's issue accounting must describe its own mutation. Inside the
 * same attempt, before candidate 1 is sealed, the host observes which planned
 * pages differ from candidate 0 and applies
 * `authoringRevisionMutationDiagnostic`. A disagreement fails the attempt as a
 * coded `malformed-response`; retryability comes from the model-output catalog
 * (`config/model-output/rules/revision-accounting.yaml`).
 *
 * The writer can write, so every retry starts from candidate 0
 * (`resetAuthoringRevisionForRetry`, `replay: "reset-write-step"`).
 *
 * Nothing here loosens a check: sealing candidate 1 repeats the comparison
 * against the sealed patches. A host fault while restoring or observing the
 * workspace stops the step as a coded `AuthoringRevisionReplayError`, not a
 * malformed reply.
 */

import {
  harnessAttemptEvidence,
  type InferenceStepError,
  type HarnessStepResult,
} from "../execution/contracts.js";
import { changedPathsRejectionSubject } from "../execution/rejection-subject.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import type { AuthoringRevisionInputV1 } from "./authoring-candidate.js";
import {
  authoringRevisionAccountingDiagnosticOf,
  authoringRevisionAccountingError,
  authoringRevisionMutationDiagnostic,
  decodeAuthoringRevisionAccounting,
  type AuthoringRevisionAccountingV1,
} from "./authoring-revision.js";
import {
  AuthoringRevisionReplayError,
  type AuthoringCandidateLifecycleV1,
  type AuthoringRevisionSessionV1,
} from "./authoring-runtime.js";

/** What the runner binds for one revision writer step. */
export interface AuthoringRevisionReplayV1 {
  readonly lifecycle: Pick<
    AuthoringCandidateLifecycleV1,
    "observeRevisionChangedPaths" | "resetRevision"
  >;
  readonly session: AuthoringRevisionSessionV1;
  readonly input: AuthoringRevisionInputV1;
  readonly signal?: AbortSignal;
}

/** The outcome of checking one attempt: a model refusal, a host fault, or neither. */
export type AuthoringRevisionAttemptCheckV1 =
  | { readonly kind: "admitted" }
  | { readonly kind: "refused"; readonly refusal: InferenceStepError }
  | { readonly kind: "host-fault"; readonly fault: AuthoringRevisionReplayError };

/**
 * Restore candidate 0 before a retry. A failure is a coded host fault, which
 * the retry layer records on the attempt and the step stops on.
 */
export async function resetAuthoringRevisionForRetry(
  replay: AuthoringRevisionReplayV1,
): Promise<void> {
  try {
    await replay.lifecycle.resetRevision({
      session: replay.session,
      ...(replay.signal ? { signal: replay.signal } : {}),
    });
  } catch (cause) {
    throw new AuthoringRevisionReplayError("authoring-revision-reset-failed", cause); // hygiene: ok -- closed catalogued code; the constructor supplies the operator message.
  }
}

/**
 * Compare one attempt's accounting with the writer's actual mutation. Admits
 * without checking when the attempt did not succeed, returned no accounting,
 * or hit a plan-scope write denial; the step's own checks decide those. Never
 * throws.
 */
export async function checkAuthoringRevisionAttempt(
  replay: AuthoringRevisionReplayV1,
  result: HarnessStepResult,
): Promise<AuthoringRevisionAttemptCheckV1> {
  if (
    (result.outcome ?? "succeeded") !== "succeeded" ||
    result.authoringRevisionAccounting === undefined ||
    (result.mutationBoundaryDenials ?? 0) > 0
  ) {
    return { kind: "admitted" };
  }
  let accounting: AuthoringRevisionAccountingV1;
  try {
    accounting = decodeAuthoringRevisionAccounting(
      canonicalizeJsonEvidence(
        result.authoringRevisionAccounting as unknown as JsonEvidenceValue,
      ).trimEnd(),
      replay.input,
    );
  } catch (error) {
    // The harness already admitted this accounting; the step's own decode
    // after the attempt refuses anything this one could not code.
    const diagnostic = authoringRevisionAccountingDiagnosticOf(error);
    return diagnostic
      ? {
          kind: "refused",
          refusal: authoringRevisionAccountingError(diagnostic, harnessAttemptEvidence(result)),
        }
      : { kind: "admitted" };
  }
  let actualChangedPaths: readonly string[];
  try {
    actualChangedPaths = await replay.lifecycle.observeRevisionChangedPaths({
      session: replay.session,
      ...(replay.signal ? { signal: replay.signal } : {}),
    });
  } catch (cause) {
    return {
      kind: "host-fault",
      fault: new AuthoringRevisionReplayError("authoring-revision-observation-failed", cause),
    };
  }
  const diagnostic = authoringRevisionMutationDiagnostic({
    accounting,
    actualChangedPaths,
    unchanged: actualChangedPaths.length === 0,
  });
  return diagnostic
    ? {
        kind: "refused",
        refusal: authoringRevisionAccountingError(
          diagnostic,
          harnessAttemptEvidence(result),
          // Both lists are plan write paths: the declared ones passed the
          // accounting decode, and the host observed the others.
          changedPathsRejectionSubject(accounting.changedPaths, actualChangedPaths),
        ),
      }
    : { kind: "admitted" };
}
