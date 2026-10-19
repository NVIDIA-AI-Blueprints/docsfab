// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  exactObject,
  fail,
  kit,
  normalizeIds,
  normalizePaths,
  normalizeRevisionChangedPaths,
  nullableHash,
  nonnegativeInteger,
  sameStrings,
} from "./protocol.js";
import {
  AUTHORING_PARTIAL_KIND,
  AUTHORING_REVISION_ADMISSION_KIND,
  type AuthoringCandidateArtifactReferenceV1,
  type AuthoringCandidateHistoryEntryV1,
  type AuthoringCandidatePointerV1,
  type AuthoringExecutionBodyV1,
  type AuthoringFinalPatchBindingV1,
  type AuthoringPartialCandidateV1,
  type AuthoringPathSelectionV1,
  type AuthoringProducerSummaryBindingV1,
  type AuthoringRevisionAdmissionBindingV1,
  type AuthoringSelectedProducerSetV1,
  type AuthoringSelectionInputV1,
} from "./schema.js";
import type { AuthoringCandidateV1 } from "../../workflow-execution/authoring-candidate.js";
import { decodeAuthoringCandidate } from "../../workflow-execution/authoring-candidate.js";
import { authoringSelectedPath } from "../../workflow-contracts/authoring-schedule.js";
import type { WorkflowDefinition } from "../../workflow-contracts/contracts.js";
import { requireV3 } from "./phase-codec.js";

export function normalizeExecution(
  root: Record<string, unknown>,
  workflow: WorkflowDefinition,
): AuthoringExecutionBodyV1 {
  const schedule = requireV3(workflow);
  if (root.workflow !== "create-documentation") fail("subject-mismatch");
  const manifest = root.manifest;
  if (kit.canonicalDigest(manifest) !== kit.canonicalDigest(schedule.manifest)) {
    fail("subject-mismatch");
  }
  const manifestSha256 = kit.hash(root.manifestSha256);
  if (manifestSha256 !== kit.canonicalDigest(schedule.manifest)) fail("subject-mismatch");
  const runId = kit.identifier(root.runId);
  const repositoryRevision = kit.revision(root.repositoryRevision);
  const planDigest = kit.hash(root.planDigest);
  const writePaths = normalizePaths(root.writePaths);
  const sourceSearchSnapshotSha256 = nullableHash(root.sourceSearchSnapshotSha256);
  const sourceObligationLedgerSha256 = nullableHash(root.sourceObligationLedgerSha256);
  const technicalCorrectionEvidenceSha256 = nullableHash(root.technicalCorrectionEvidenceSha256);
  const candidates = kit.array(root.candidates).map((value, index) =>
    normalizeCandidateEntry(value, index, {
      runId,
      repositoryRevision,
      planDigest,
      writePaths,
    }),
  );
  if (candidates.length > 2) fail("candidate-mismatch");
  const revisionAdmission =
    root.revisionAdmission === null
      ? null
      : decodeRevisionAdmission(
          root.revisionAdmission,
          candidates.map((entry) => entry.candidate),
        );
  if ((candidates.length === 2) !== (revisionAdmission !== null)) {
    fail("candidate-mismatch");
  }
  const partialCandidate1 =
    root.partialCandidate1 === null ? null : decodePartial(root.partialCandidate1);
  validatePartial(partialCandidate1, candidates, {
    runId,
    repositoryRevision,
    planDigest,
    writePaths,
  });
  const selection =
    root.selection === null
      ? null
      : normalizeSelection(root.selection, workflow, candidates, {
          repositoryRevision,
          planDigest,
          writePaths,
          sourceSearchSnapshotSha256,
          sourceObligationLedgerSha256,
          technicalCorrectionEvidenceSha256,
        });
  const selectedCandidate =
    root.selectedCandidate === null ? null : normalizePointer(root.selectedCandidate, candidates);
  if (
    (candidates.length === 0) !== (selectedCandidate === null) ||
    (candidates.length === 2 && selectedCandidate?.ordinal !== 1)
  ) {
    fail("candidate-mismatch");
  }
  if (selection === null && selectedCandidate?.ordinal === 1) fail("candidate-mismatch");
  if (selection?.branchId === "retain" && selectedCandidate?.ordinal !== 0) {
    fail("selection-mismatch");
  }
  const selectedProducers =
    root.selectedProducers === null
      ? null
      : normalizeSelectedProducers(root.selectedProducers, selectedCandidate, candidates);
  const finalPatch =
    root.finalPatch === null
      ? null
      : normalizeFinalPatch(root.finalPatch, selectedCandidate, candidates);
  if (partialCandidate1 && candidates.length > 1) fail("candidate-mismatch");
  return {
    runId,
    workflow: "create-documentation",
    manifest: structuredClone(schedule.manifest),
    manifestSha256,
    repositoryRevision,
    planDigest,
    writePaths,
    sourceSearchSnapshotSha256,
    sourceObligationLedgerSha256,
    technicalCorrectionEvidenceSha256,
    selection,
    candidates,
    revisionAdmission,
    partialCandidate1,
    selectedCandidate,
    selectedProducers,
    finalPatch,
  };
}

export function decodeRevisionAdmission(
  value: unknown,
  candidates: readonly AuthoringCandidateV1[],
): AuthoringRevisionAdmissionBindingV1 {
  return kit.decodeSealed(
    value,
    AUTHORING_REVISION_ADMISSION_KIND,
    "admissionSha256",
    [
      "candidate0Digest",
      "candidate0WorkspaceSnapshotDigest",
      "candidate1Digest",
      "candidate1WorkspaceSnapshotDigest",
      "changedPaths",
      "accountingSha256",
    ],
    (root) => {
      const candidate0 = candidates[0];
      const candidate1 = candidates[1];
      if (!candidate0 || !candidate1) fail("candidate-mismatch");
      const candidate0Digest = kit.hash(root.candidate0Digest);
      const candidate0WorkspaceSnapshotDigest = kit.hash(root.candidate0WorkspaceSnapshotDigest);
      const candidate1Digest = kit.hash(root.candidate1Digest);
      const candidate1WorkspaceSnapshotDigest = kit.hash(root.candidate1WorkspaceSnapshotDigest);
      if (
        candidate0Digest !== candidate0.digest ||
        candidate0WorkspaceSnapshotDigest !== candidate0.workspaceSnapshotDigest ||
        candidate1Digest !== candidate1.digest ||
        candidate1WorkspaceSnapshotDigest !== candidate1.workspaceSnapshotDigest
      ) {
        fail("candidate-mismatch");
      }
      return {
        candidate0Digest,
        candidate0WorkspaceSnapshotDigest,
        candidate1Digest,
        candidate1WorkspaceSnapshotDigest,
        changedPaths: normalizeRevisionChangedPaths(root.changedPaths, candidate0.writePaths),
        accountingSha256: kit.hash(root.accountingSha256),
      };
    },
  ) as AuthoringRevisionAdmissionBindingV1;
}

export function normalizeCandidateEntry(
  value: unknown,
  index: number,
  subject: {
    runId: string;
    repositoryRevision: string;
    planDigest: string;
    writePaths: readonly string[];
  },
): AuthoringCandidateHistoryEntryV1 {
  const root = exactObject(value, [
    "candidate",
    "artifact",
    "admittedByStepId",
    "revisionInputDigest",
  ]);
  const candidate = decodeAuthoringCandidate(root.candidate);
  if (
    candidate.ordinal !== index ||
    candidate.runId !== subject.runId ||
    candidate.originalRevision !== subject.repositoryRevision ||
    candidate.planDigest !== subject.planDigest ||
    !sameStrings(candidate.writePaths, subject.writePaths)
  ) {
    fail("candidate-mismatch");
  }
  const artifact = normalizeCandidateArtifact(root.artifact, candidate);
  const admittedByStepId = index === 0 ? "write-documentation" : "revise-documentation";
  if (root.admittedByStepId !== admittedByStepId) fail("candidate-mismatch");
  const revisionInputDigest =
    root.revisionInputDigest === null ? null : kit.hash(root.revisionInputDigest);
  if ((index === 0) !== (revisionInputDigest === null)) fail("candidate-mismatch");
  return { candidate, artifact, admittedByStepId, revisionInputDigest };
}

export function normalizeCandidateArtifact(
  value: unknown,
  candidate: AuthoringCandidateV1,
): AuthoringCandidateArtifactReferenceV1 {
  const root = exactObject(value, ["kind", "name", "sha256", "byteLength"]);
  const name = candidate.ordinal === 0 ? "candidate-0.patch" : "candidate-1.patch";
  if (
    root.kind !== "authoring-candidate-patch" ||
    root.name !== name ||
    kit.hash(root.sha256) !== candidate.patchDigestSha256 ||
    nonnegativeInteger(root.byteLength) !== candidate.patchBytes
  ) {
    fail("candidate-mismatch");
  }
  return {
    kind: "authoring-candidate-patch",
    name,
    sha256: candidate.patchDigestSha256,
    byteLength: candidate.patchBytes,
  };
}

export function normalizeSelection(
  value: unknown,
  workflow: WorkflowDefinition,
  candidates: readonly AuthoringCandidateHistoryEntryV1[],
  subject: {
    repositoryRevision: string;
    planDigest: string;
    writePaths: readonly string[];
    sourceSearchSnapshotSha256: string | null;
    sourceObligationLedgerSha256: string | null;
    technicalCorrectionEvidenceSha256: string | null;
  },
): AuthoringPathSelectionV1 {
  const root = exactObject(value, [
    "branchId",
    "input",
    "inputSha256",
    "revisionInputDigest",
    "requiredStepIds",
    "excludedStepIds",
  ]);
  const branchId = kit.enumeration(root.branchId, ["retain", "revise"] as const);
  if (!candidates[0]) fail("selection-mismatch");
  if (
    subject.sourceSearchSnapshotSha256 === null ||
    subject.sourceObligationLedgerSha256 === null ||
    subject.technicalCorrectionEvidenceSha256 === null
  ) {
    fail("selection-mismatch");
  }
  const input = normalizeSelectionInput(root.input, candidates[0]!.candidate, {
    repositoryRevision: subject.repositoryRevision,
    planDigest: subject.planDigest,
    writePaths: subject.writePaths,
    sourceSearchSnapshotSha256: subject.sourceSearchSnapshotSha256,
    sourceObligationLedgerSha256: subject.sourceObligationLedgerSha256,
    technicalCorrectionEvidenceSha256: subject.technicalCorrectionEvidenceSha256,
  });
  const inputSha256 = kit.hash(root.inputSha256);
  if (inputSha256 !== kit.canonicalDigest(input)) fail("selection-mismatch");
  const revisionInputDigest =
    root.revisionInputDigest === null ? null : kit.hash(root.revisionInputDigest);
  if ((branchId === "retain") !== (revisionInputDigest === null)) fail("selection-mismatch");
  const selected = authoringSelectedPath(workflow, branchId);
  const requiredStepIds = normalizeIds(root.requiredStepIds);
  const excludedStepIds = normalizeIds(root.excludedStepIds);
  if (
    !sameStrings(
      requiredStepIds,
      selected.steps.map((step) => step.id),
    ) ||
    !sameStrings(excludedStepIds, selected.excludedStepIds)
  ) {
    fail("selection-mismatch");
  }
  return { branchId, input, inputSha256, revisionInputDigest, requiredStepIds, excludedStepIds };
}

export function normalizeSelectionInput(
  value: unknown,
  candidate0: AuthoringCandidateV1,
  subject: {
    repositoryRevision: string;
    planDigest: string;
    writePaths: readonly string[];
    sourceSearchSnapshotSha256: string;
    sourceObligationLedgerSha256: string;
    technicalCorrectionEvidenceSha256: string;
  },
): AuthoringSelectionInputV1 {
  const root = exactObject(value, [
    "candidate0Digest",
    "candidate0WorkspaceSnapshotDigest",
    "originalRevision",
    "planDigest",
    "writePaths",
    "sourceSearchSnapshotSha256",
    "sourceObligationLedgerSha256",
    "technicalCorrectionEvidenceSha256",
    "technical",
    "editorial",
  ]);
  const normalized: AuthoringSelectionInputV1 = {
    candidate0Digest: kit.hash(root.candidate0Digest),
    candidate0WorkspaceSnapshotDigest: kit.hash(root.candidate0WorkspaceSnapshotDigest),
    originalRevision: kit.revision(root.originalRevision),
    planDigest: kit.hash(root.planDigest),
    writePaths: normalizePaths(root.writePaths),
    sourceSearchSnapshotSha256: kit.hash(root.sourceSearchSnapshotSha256),
    sourceObligationLedgerSha256: kit.hash(root.sourceObligationLedgerSha256),
    technicalCorrectionEvidenceSha256: kit.hash(root.technicalCorrectionEvidenceSha256),
    technical: normalizeProducer(root.technical),
    editorial: normalizeProducer(root.editorial),
  };
  if (
    normalized.candidate0Digest !== candidate0.digest ||
    normalized.candidate0WorkspaceSnapshotDigest !== candidate0.workspaceSnapshotDigest ||
    normalized.originalRevision !== subject.repositoryRevision ||
    normalized.planDigest !== subject.planDigest ||
    !sameStrings(normalized.writePaths, subject.writePaths) ||
    normalized.sourceSearchSnapshotSha256 !== subject.sourceSearchSnapshotSha256 ||
    normalized.sourceObligationLedgerSha256 !== subject.sourceObligationLedgerSha256 ||
    normalized.technicalCorrectionEvidenceSha256 !== subject.technicalCorrectionEvidenceSha256 ||
    !producerMatches(normalized.technical, candidate0, "verify-technical-accuracy") ||
    !producerMatches(normalized.editorial, candidate0, "review-documentation")
  ) {
    fail("selection-mismatch");
  }
  return normalized;
}

export function normalizeSelectedProducers(
  value: unknown,
  selected: AuthoringCandidatePointerV1 | null,
  candidates: readonly AuthoringCandidateHistoryEntryV1[],
): AuthoringSelectedProducerSetV1 {
  if (!selected) fail("candidate-mismatch");
  const root = exactObject(value, ["lint", "technical", "editorial"]);
  const candidate = candidates[selected.ordinal]!.candidate;
  const lint = normalizeProducer(root.lint);
  const technical = normalizeProducer(root.technical);
  const editorial = normalizeProducer(root.editorial);
  const lintId = selected.ordinal === 0 ? "lint-documentation" : "lint-revised-documentation";
  const technicalId =
    selected.ordinal === 0 ? "verify-technical-accuracy" : "verify-revised-technical-accuracy";
  const editorialId =
    selected.ordinal === 0 ? "review-documentation" : "review-revised-documentation";
  if (
    !producerMatches(lint, candidate, lintId) ||
    !producerMatches(technical, candidate, technicalId) ||
    !producerMatches(editorial, candidate, editorialId)
  ) {
    fail("candidate-mismatch");
  }
  return { lint, technical, editorial };
}

export function normalizeProducer(value: unknown): AuthoringProducerSummaryBindingV1 {
  const root = exactObject(value, [
    "stepId",
    "summarySha256",
    "candidateOrdinal",
    "candidateDigest",
    "workspaceSnapshotDigest",
  ]);
  if (root.candidateOrdinal !== 0 && root.candidateOrdinal !== 1) fail("candidate-mismatch");
  const candidateOrdinal = root.candidateOrdinal;
  return {
    stepId: kit.identifier(root.stepId),
    summarySha256: kit.hash(root.summarySha256),
    candidateOrdinal,
    candidateDigest: kit.hash(root.candidateDigest),
    workspaceSnapshotDigest: kit.hash(root.workspaceSnapshotDigest),
  };
}

export function producerMatches(
  producer: AuthoringProducerSummaryBindingV1,
  candidate: AuthoringCandidateV1,
  stepId: string,
): boolean {
  return (
    producer.stepId === stepId &&
    producer.candidateOrdinal === candidate.ordinal &&
    producer.candidateDigest === candidate.digest &&
    producer.workspaceSnapshotDigest === candidate.workspaceSnapshotDigest
  );
}

export function normalizePointer(
  value: unknown,
  candidates: readonly AuthoringCandidateHistoryEntryV1[],
): AuthoringCandidatePointerV1 {
  const root = exactObject(value, ["ordinal", "digest", "artifactName"]);
  if (root.ordinal !== 0 && root.ordinal !== 1) fail("candidate-mismatch");
  const ordinal = root.ordinal;
  const candidate = candidates[ordinal]?.candidate;
  if (!candidate) fail("candidate-mismatch");
  const expected = candidatePointer(candidate);
  if (kit.hash(root.digest) !== expected.digest || root.artifactName !== expected.artifactName) {
    fail("candidate-mismatch");
  }
  return expected;
}

export function normalizeFinalPatch(
  value: unknown,
  selected: AuthoringCandidatePointerV1 | null,
  candidates: readonly AuthoringCandidateHistoryEntryV1[],
): AuthoringFinalPatchBindingV1 {
  if (!selected) fail("patch-mismatch");
  const root = exactObject(value, [
    "candidateOrdinal",
    "candidateDigest",
    "artifactName",
    "sha256",
    "byteLength",
    "baseRevision",
    "writePaths",
  ]);
  const candidate = candidates[selected.ordinal]!.candidate;
  const expected = finalPatchBinding(candidate);
  if (kit.canonicalDigest(root) !== kit.canonicalDigest(expected)) fail("patch-mismatch");
  return expected;
}

export function decodePartial(value: unknown): AuthoringPartialCandidateV1 {
  return kit.decodeSealed(
    value,
    AUTHORING_PARTIAL_KIND,
    "partialSha256",
    [
      "runId",
      "ordinal",
      "inputCandidateDigest",
      "revisionInputDigest",
      "originalRevision",
      "planDigest",
      "writePaths",
      "artifact",
      "workspaceSnapshotDigest",
      "disposition",
      "failureCode",
    ],
    (root) => {
      if (root.ordinal !== 1 || root.disposition !== "non-deliverable") fail("candidate-mismatch");
      const artifact =
        root.artifact === null
          ? null
          : (() => {
              const item = exactObject(root.artifact, ["kind", "name", "sha256", "byteLength"]);
              if (
                item.kind !== "authoring-partial-patch" ||
                item.name !== "candidate-1.partial.patch"
              ) {
                fail("candidate-mismatch");
              }
              return {
                kind: "authoring-partial-patch" as const,
                name: "candidate-1.partial.patch" as const,
                sha256: kit.hash(item.sha256),
                byteLength: nonnegativeInteger(item.byteLength),
              };
            })();
      const workspaceSnapshotDigest =
        root.workspaceSnapshotDigest === null ? null : kit.hash(root.workspaceSnapshotDigest);
      if ((artifact === null) !== (workspaceSnapshotDigest === null)) fail("candidate-mismatch");
      return {
        runId: kit.identifier(root.runId),
        ordinal: 1,
        inputCandidateDigest: kit.hash(root.inputCandidateDigest),
        revisionInputDigest: kit.hash(root.revisionInputDigest),
        originalRevision: kit.revision(root.originalRevision),
        planDigest: kit.hash(root.planDigest),
        writePaths: normalizePaths(root.writePaths),
        artifact,
        workspaceSnapshotDigest,
        disposition: "non-deliverable",
        failureCode: kit.identifier(root.failureCode),
      };
    },
  ) as AuthoringPartialCandidateV1;
}

export function validatePartial(
  partial: AuthoringPartialCandidateV1 | null,
  candidates: readonly AuthoringCandidateHistoryEntryV1[],
  subject: {
    runId: string;
    repositoryRevision: string;
    planDigest: string;
    writePaths: readonly string[];
  },
): void {
  if (!partial) return;
  if (
    !candidates[0] ||
    candidates[1] ||
    partial.runId !== subject.runId ||
    partial.inputCandidateDigest !== candidates[0].candidate.digest ||
    partial.originalRevision !== subject.repositoryRevision ||
    partial.planDigest !== subject.planDigest ||
    !sameStrings(partial.writePaths, subject.writePaths)
  ) {
    fail("candidate-mismatch");
  }
}

export function candidatePointer(
  candidate: AuthoringCandidateV1 | undefined,
): AuthoringCandidatePointerV1 {
  if (!candidate) fail("candidate-mismatch");
  return {
    ordinal: candidate.ordinal,
    digest: candidate.digest,
    artifactName: candidate.ordinal === 0 ? "candidate-0.patch" : "candidate-1.patch",
  };
}

export function finalPatchBinding(candidate: AuthoringCandidateV1): AuthoringFinalPatchBindingV1 {
  return {
    candidateOrdinal: candidate.ordinal,
    candidateDigest: candidate.digest,
    artifactName: candidate.ordinal === 0 ? "candidate-0.patch" : "candidate-1.patch",
    sha256: candidate.patchDigestSha256,
    byteLength: candidate.patchBytes,
    baseRevision: candidate.originalRevision,
    writePaths: [...candidate.writePaths],
  };
}
