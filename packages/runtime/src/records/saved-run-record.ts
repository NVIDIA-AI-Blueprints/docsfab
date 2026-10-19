// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { JsonEvidenceValue } from "../json-evidence.js";
import type { RunRecord } from "./contracts.js";
import { assertAnswerRecordDiscoveryRunBindingV1 } from "./answer-record-discovery.js";
import { decodeInferenceProgressObservation } from "./inference-progress.js";
import { decodeCheckoutPersistenceOutcome } from "./checkout-persistence.js";
import { decodeFirstPassContradictionAdmission } from "./first-pass-contradiction-admission.js";
import { decodeFirstPassChoice } from "./first-pass-choice.js";
import { decodeFirstPassReplay } from "./first-pass-replay.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { decodeRunRecordInstructionContext } from "./instruction-context.js";

/**
 * Workflow and status values admitted by the saved-run boundary.
 * Keep this module free of CLI imports so pin/digest verification can decode
 * saved run records before generated CLI mirrors are available.
 */
export const SAVED_RUN_WORKFLOWS: ReadonlySet<string> = new Set([
  "readiness",
  "release-documentation-readiness",
  "audit-documentation",
  "foundation",
  "bootstrap",
  "ia-analysis",
  "ia-plan",
  "site-bootstrap",
  "foundation-to-patch",
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
]);

export const SAVED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "needs-input",
  "needs-human-decision",
  "succeeded",
  "failed",
]);

/**
 * Validate the closed, immutable fields needed before a saved run is trusted.
 * This is shared by CLI presentation and non-CLI evidence readers.
 */
export function decodeSavedRunRecord(value: JsonEvidenceValue, expectedId: string): RunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved run record is malformed and cannot be shown.");
  }
  const root = value as { [key: string]: JsonEvidenceValue };
  if (root.schemaVersion !== 2) {
    throw new Error("The saved run record schemaVersion is not a supported run record.");
  }
  if (typeof root.id !== "string" || root.id !== expectedId) {
    throw new Error("The saved run record id does not match the requested run.");
  }
  const repository = root.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    throw new Error("The saved run record is malformed and cannot be shown.");
  }
  const repo = repository as { [key: string]: JsonEvidenceValue };
  if (typeof repo.sourcePath !== "string" || typeof repo.revision !== "string") {
    throw new Error("The saved run record is malformed and cannot be shown.");
  }
  if (
    typeof root.workflow !== "string" ||
    !SAVED_RUN_WORKFLOWS.has(root.workflow) ||
    typeof root.status !== "string" ||
    !SAVED_RUN_STATUSES.has(root.status)
  ) {
    throw new Error("The saved run record is malformed and cannot be shown.");
  }
  if (root.checkoutPersistence !== undefined) {
    try {
      decodeCheckoutPersistenceOutcome(root.checkoutPersistence);
    } catch {
      throw new Error("The saved run has malformed checkout persistence evidence.");
    }
  }
  if (root.firstPassContradictionAdmission !== undefined) {
    try {
      if (typeof root.instruction !== "string")
        throw new Error("A stopped first-pass run must retain its original instruction.");
      const admission = decodeFirstPassContradictionAdmission(root.firstPassContradictionAdmission);
      if (root.status !== "needs-input" || root.firstPassContradiction === undefined)
        throw new Error("The marker does not belong to a contradiction stop.");
      if (
        admission.runId !== expectedId ||
        admission.repositoryRevision !== repo.revision ||
        admission.instructionSha256 !==
          canonicalDigest(String(root.instruction).normalize("NFC")) ||
        admission.contradictionSha256 !== canonicalDigest(root.firstPassContradiction) ||
        ((admission.outcome === "repository-only" ||
          admission.instructionContextSha256 !== undefined) &&
          admission.instructionContextSha256 !==
            (root.instructionContext === undefined
              ? undefined
              : canonicalDigest(decodeRunRecordInstructionContext(root.instructionContext))))
      )
        throw new Error("The marker does not match the stopped run.");
    } catch {
      throw new Error("The saved first-pass contradiction admission does not match this run.");
    }
  }
  if (root.firstPassReplay !== undefined) {
    try {
      if (
        root.status !== "needs-input" ||
        root.firstPassContradiction === undefined ||
        root.firstPassContradictionAdmission === undefined ||
        decodeFirstPassContradictionAdmission(root.firstPassContradictionAdmission).outcome !==
          "repository-only"
      )
        throw new Error("The retained assessment belongs only to a repository contradiction stop.");
      decodeFirstPassReplay(root.firstPassReplay);
    } catch {
      throw new Error("The saved first-pass assessment does not match this run.");
    }
  }
  if (root.firstPassChoices !== undefined) {
    try {
      if (root.workflow !== "create-documentation" && root.workflow !== "update-documentation")
        throw new Error("A first-pass choice belongs only to documentation work.");
      if (typeof root.instruction !== "string")
        throw new Error("A continued first-pass run must retain its original instruction.");
      if (!Array.isArray(root.firstPassChoices) || root.firstPassChoices.length === 0)
        throw new Error("The saved first-pass choice chain contains no selected options.");
      const seen = new Set<string>();
      for (const raw of root.firstPassChoices) {
        const choice = decodeFirstPassChoice(raw);
        if (
          seen.has(choice.obligationId) ||
          choice.repositoryRevision !== repo.revision ||
          choice.instructionSha256 !== canonicalDigest(String(root.instruction).normalize("NFC"))
        )
          throw new Error("The choice chain does not belong to this run.");
        seen.add(choice.obligationId);
      }
      if (decodeFirstPassChoice(root.firstPassChoices.at(-1)).successorRunId !== expectedId)
        throw new Error("The final choice does not name this run.");
    } catch {
      throw new Error("The saved first-pass choice does not match this run.");
    }
  }
  if (
    !Array.isArray(root.steps) ||
    root.steps.some((step) => !step || typeof step !== "object" || Array.isArray(step))
  ) {
    throw new Error("The saved run record is malformed and cannot be shown.");
  }
  for (const stepValue of root.steps) {
    const step = stepValue as { [key: string]: JsonEvidenceValue };
    if (step.inferenceProgress !== undefined) {
      try {
        decodeInferenceProgressObservation(step.inferenceProgress);
      } catch {
        throw new Error(
          "The saved run record has malformed inference progress and cannot be shown.",
        );
      }
    }
  }
  if (root.answerRecordDiscovery !== undefined) {
    if (
      root.compositionExecution !== undefined ||
      root.compositionExecutionAggregate !== undefined ||
      root.workflow !== "review-documentation"
    ) {
      throw new Error("The saved experimental discovery record has an invalid execution mode.");
    }
    try {
      assertAnswerRecordDiscoveryRunBindingV1(root.answerRecordDiscovery, {
        runId: expectedId,
        workflow: root.workflow,
        repositoryRevision: repo.revision,
        repositorySourcePath: repo.sourcePath,
      });
    } catch {
      throw new Error(
        "The saved experimental discovery evidence is invalid for this run and cannot be resumed.",
      );
    }
  }
  return value as unknown as RunRecord;
}
