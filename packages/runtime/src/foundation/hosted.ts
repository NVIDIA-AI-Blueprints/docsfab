// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Actual hosted Foundation inspection over an authenticated immutable workspace. */
import { createHash } from "node:crypto";
import { canonicalDigest } from "../contract-kit/index.js";
import type { DurableArtifactStore } from "../artifacts/store.js";
import { decodeKnowledgeAcceptedSnapshot } from "../canon/from-knowledge-snapshot.js";
import type { HostOperationExecutor } from "../execution/contracts.js";
import { parseHostRuntimeApprovedModelData } from "../host-invoker/approved-model.js";
import type { HostRuntimeApprovedModelReferenceV1 } from "../host-invoker/approved-model.js";
import type { HostRuntimeRequestV1 } from "../host-invoker/contracts.js";
import { loadHostRuntimeNativeBytes } from "../host-invoker/native-custody.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { projectApprovedModelFoundation } from "./approved-model.js";
import { FoundationHostOperation, FoundationWorkflowOutcomeProjector } from "./host-operation.js";
import {
  incompleteFoundationInspectSeed,
  inspectFoundation,
  type FoundationInspectInputV1,
  type FoundationInspectResultV1,
} from "./inspect.js";
import { projectFoundationOnboardingQuestions } from "./onboarding.js";

/**
 * Named outcome when custody carries no admitted approved-model baseline.
 *
 * Model content, not custody: the operator must be able to tell "this project
 * has no admitted model for the frozen canon" from "the model was admitted and
 * had gaps". Both end in `needs-input`; only this code separates them.
 */
export const HOSTED_FOUNDATION_APPROVED_MODEL_ABSENT = "approved-model:absent" as const;

function bytesHash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

type HostedFoundationSeed = Pick<
  FoundationInspectInputV1,
  | "inputBinding"
  | "registeredEvidence"
  | "claimProposals"
  | "sourceConflicts"
  | "evidenceLimitations"
>;

/**
 * The seed this Foundation inspection actually starts from.
 *
 * Condition: `nativeCustody.approvedModel` is present, meaning the host staged
 * a complete admitted baseline for exactly this frozen canon. Absent takes the
 * pre-existing canon path and names the absence; it never refuses, because an
 * unapproved project is a real environment, not a tampered one.
 */
async function admittedInputs(
  request: HostRuntimeRequestV1,
  workspace: RepositoryWorkspace,
): Promise<HostedFoundationSeed> {
  const approvedModel = request.nativeCustody!.approvedModel;
  const carried = request.packet.canon;
  // The canon this custody actually approved, or null. Both branches bind to
  // it, so its transported blob is verified once, here, before either reads it.
  const canon =
    carried && carried.sha256 === request.nativeCustody!.approvedCanonSha256 ? carried : null;
  if (canon) assertTransportedCanon(canon);
  if (approvedModel) {
    // Condition: custody names a staged baseline but the packet's canon is not
    // the canon custody approved. The staged baseline's provenance binds to
    // that exact canon, so this is a custody inconsistency, not model content:
    // refuse rather than silently inspecting without the inheritance.
    if (!canon)
      throw new Error(
        "Hosted Foundation refused native custody that names an approved model without its exact approved canon.",
      );
    return admittedApprovedModel(request, canon, approvedModel);
  }
  return {
    ...admittedCanon(canon, workspace),
    evidenceLimitations: [HOSTED_FOUNDATION_APPROVED_MODEL_ABSENT],
  };
}

/**
 * The approved model can be older than the inspected code revision. Verify its
 * exact transported Git blob instead of inventing a current-tree path.
 */
function assertTransportedCanon(canon: NonNullable<HostRuntimeRequestV1["packet"]["canon"]>): void {
  const bytes = Buffer.from(canon.content);
  const objectId = createHash(canon.gitObjectId.length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (bytesHash(bytes) !== canon.sha256 || objectId !== canon.gitObjectId)
    throw new Error(
      "Hosted Foundation refused the frozen canon because its content or Git object digest differs.",
    );
}

async function admittedApprovedModel(
  request: HostRuntimeRequestV1,
  canon: NonNullable<HostRuntimeRequestV1["packet"]["canon"]>,
  approvedModel: HostRuntimeApprovedModelReferenceV1,
): Promise<HostedFoundationSeed> {
  const baselineBytes = await loadHostRuntimeNativeBytes(
    request.stateDirectory,
    approvedModel.contentSha256,
    approvedModel.bytes,
  );
  const model = parseHostRuntimeApprovedModelData({
    value: JSON.parse(Buffer.from(baselineBytes).toString("utf8")),
    reference: approvedModel,
    projectId: request.projectId,
    canon,
  });
  return {
    inputBinding: {
      manifestSha256: approvedModel.snapshotSha256,
      inputIds: ["approved-project-model"],
    },
    registeredEvidence: [
      {
        id: "approved-project-model",
        inputId: "approved-project-model",
        digestSha256: approvedModel.snapshotSha256,
        strength: "authoritative",
      },
    ],
    ...projectApprovedModelFoundation(model),
  };
}

/** No-approved-model path: the approved canon itself may be a knowledge-accepted snapshot. */
function admittedCanon(
  canon: HostRuntimeRequestV1["packet"]["canon"],
  workspace: RepositoryWorkspace,
): Pick<FoundationInspectInputV1, "inputBinding" | "registeredEvidence" | "claimProposals"> {
  const empty = incompleteFoundationInspectSeed(workspace.revision);
  if (!canon) return empty;
  let value: unknown;
  try {
    value = JSON.parse(canon.content);
  } catch {
    return empty;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "knowledge-accepted-snapshot"
  )
    return empty;
  const snapshot = decodeKnowledgeAcceptedSnapshot(value);
  // The protected project digest establishes input provenance. The existing
  // closed snapshot state and claim states still control what can be used.
  if (snapshot.status !== "approved" && snapshot.status !== "canonical") return empty;
  const conflictByClaim = new Map(
    snapshot.conflicts.flatMap((conflict) =>
      conflict.claimIds.map((id) => [id, conflict.id] as const),
    ),
  );
  return {
    inputBinding: { manifestSha256: canon.sha256, inputIds: ["approved-project-canon"] },
    registeredEvidence: [
      {
        id: "approved-project-canon",
        inputId: "approved-project-canon",
        digestSha256: canon.sha256,
        strength: "authoritative",
      },
    ],
    claimProposals: snapshot.claims.map((claim) => ({
      id: claim.id,
      subjectLabel: claim.kind,
      assertionLabel: claim.statement,
      statementLabel: claim.statement,
      applicabilityLabel: claim.scope,
      evidenceIds: ["approved-project-canon"],
      confidence: claim.modelState === "canonical" ? "high" : "medium",
      verificationStatus: claim.modelState === "canonical" ? "verified" : "unverified",
      conflictGroupId: conflictByClaim.get(claim.id) ?? null,
    })),
  };
}

/** Shared inspection for Foundation and the separately authorized to-patch journey. */
export async function inspectHostedFoundation(input: {
  readonly request: HostRuntimeRequestV1;
  readonly workspace: RepositoryWorkspace;
}): Promise<FoundationInspectResultV1> {
  const { request, workspace } = input;
  if (
    !request.nativeCustody ||
    workspace.revision !== request.revision ||
    (request.workflow !== "foundation" && request.workflow !== "foundation-to-patch")
  )
    throw new Error(
      "Hosted Foundation requires native custody and the exact selected repository revision.",
    );
  const seed = await admittedInputs(request, workspace);
  return inspectFoundation({
    repositoryPath: workspace.path,
    repositoryRevision: workspace.revision,
    repositoryIdentitySha256: request.nativeCustody.repositoryIdentitySha256,
    ...seed,
  });
}

export function assembleHostedFoundation(input: {
  readonly request: HostRuntimeRequestV1;
  readonly workspace: RepositoryWorkspace;
  readonly artifactStore: DurableArtifactStore;
}): {
  readonly hostOperations: HostOperationExecutor;
  readonly outcomeProjector: FoundationWorkflowOutcomeProjector;
} {
  const { request, workspace, artifactStore } = input;
  if (
    request.workflow !== "foundation" ||
    request.packet.nativeTask?.task.kind !== "foundation" ||
    !request.nativeCustody ||
    request.packet.nativeTask.inputs.length !== 0 ||
    request.allowWrite ||
    request.writeAuthority !== null ||
    workspace.revision !== request.revision
  ) {
    throw new Error(
      "Hosted Foundation requires the bound read-only task and its exact repository revision.",
    );
  }
  const operation = new FoundationHostOperation({
    artifactStore,
    async inspectOverride(step) {
      step.signal?.throwIfAborted();
      return inspectHostedFoundation({ request, workspace });
    },
  });
  return {
    outcomeProjector: new FoundationWorkflowOutcomeProjector(),
    hostOperations: {
      async runStep(step) {
        const result = await operation.runStep({ ...step, repositoryPath: workspace.path });
        const inspected = result.foundationInspect;
        await artifactStore.putRecord(inspected.resultSha256, inspected);
        const questions = {
          schemaVersion: 1,
          kind: "docsfab-foundation-onboarding-questions",
          canonSha256: inspected.canon.canonSha256,
          repositoryRevision: workspace.revision,
          questions: projectFoundationOnboardingQuestions(inspected),
        };
        await artifactStore.putRecord(canonicalDigest(questions), questions);
        return { ...result, summary: [result.summary, ...inspected.nextQuestions].join("\n") };
      },
    },
  };
}
