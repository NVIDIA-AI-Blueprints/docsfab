// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Trusted composition of one narrowed authoring invocation under its outer grant. */
import { mkdir, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { DurableArtifactStore } from "../artifacts/store.js";
import { loadHostRuntimeNativeBytes } from "./native-custody.js";
import { parseHostRuntimeApprovedModelData } from "./approved-model.js";
import { canonicalDigest } from "../contract-kit/index.js";
import type { RunRecord } from "../records/contracts.js";
import type { FoundationInspectResultV1 } from "../foundation/inspect.js";
import type { HostedNativeCandidate } from "./native-candidate.js";
import { inspectHostedWorkflowCatalog } from "./workflow-catalog.js";
import { withinWriteCeiling } from "./wire-decode.js";
import {
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeWriteAuthority,
  type HostRuntimeRequestV1,
  type HostRuntimePatchEvidenceV1,
} from "./contracts.js";

export interface NativeAuthoringInvocation {
  readonly request: HostRuntimeRequestV1;
  readonly candidate: HostedNativeCandidate;
  readonly inspect: FoundationInspectResultV1;
  readonly intendedPaths: readonly string[];
}
export interface NativeAuthoringOutcome {
  readonly record: RunRecord;
  readonly patch: string | null;
  readonly patchEvidence: HostRuntimePatchEvidenceV1 | null;
}
export type NativeAuthoringExecutor = (
  input: NativeAuthoringInvocation,
) => Promise<NativeAuthoringOutcome>;

export async function prepareNativeAuthoringRequest(input: NativeAuthoringInvocation): Promise<{
  request: HostRuntimeRequestV1;
  instruction: string;
}> {
  const outer = input.request,
    grant = outer.writeAuthority;
  if (
    outer.workflow !== "foundation-to-patch" ||
    !grant ||
    !outer.allowWrite ||
    input.candidate.revision !== outer.revision ||
    input.candidate.treeObjectId !== outer.sourceTreeObjectId ||
    input.inspect.readiness !== "ready" ||
    input.inspect.canon.repository.revision !== outer.revision ||
    input.inspect.canon.repository.identitySha256 !==
      outer.nativeCustody?.repositoryIdentitySha256 ||
    !input.intendedPaths.length ||
    input.intendedPaths.some((path) => !withinWriteCeiling(path, grant.pathCeiling))
  )
    throw new Error(
      "Native authoring requires the ready foundation and exact outer source/write scope.",
    );
  const catalog = inspectHostedWorkflowCatalog("create-documentation");
  const { compositionSha256: _compositionDigest, ...compositionBody } = outer.composition;
  const composition = sealHostRuntimeComposition({
    ...compositionBody,
    declaredTools: catalog.declaredTools,
  });
  const approvedModel = outer.nativeCustody?.approvedModel;
  let modelContext: string[] = [];
  if (approvedModel) {
    if (!outer.packet.canon)
      throw new Error(
        "Native authoring cannot bind inherited model statements without the approved canon.",
      );
    const bytes = await loadHostRuntimeNativeBytes(
      outer.stateDirectory,
      approvedModel.contentSha256,
      approvedModel.bytes,
    );
    const model = parseHostRuntimeApprovedModelData({
      value: JSON.parse(Buffer.from(bytes).toString("utf8")),
      reference: approvedModel,
      projectId: outer.projectId,
      canon: outer.packet.canon,
    });
    // Foundation's canon records statement hashes. Supply the authenticated
    // full statements and their approval/verification states as model input,
    // including inherited claims absent from the latest Markdown delta.
    modelContext = [
      `[approved-project-model snapshot=${approvedModel.snapshotSha256}]\n${JSON.stringify(model)}`,
    ];
  }
  const instruction = [
    "Create source-grounded documentation only at these intended paths:",
    ...input.intendedPaths.map((path) => `- ${path}`),
    `Foundation inspection canon: ${input.inspect.canon.canonSha256}.`,
    `[foundation-inspection]\n${JSON.stringify(input.inspect)}`,
    ...modelContext,
    "Use the supplied governed context and exact repository sources; the Foundation readiness result does not replace observed source citations.",
    "Preserve unresolved facts and return the real questions if required evidence is missing. Do not merge or publish.",
    ...outer.capsule.selectedEvidence.map((item) => `[${item.evidenceId}]\n${item.content}`),
    ...[outer.packet.inputManifest, outer.packet.canon, outer.packet.reviewEvent]
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .map((item) => `[frozen-${item.kind}]\n${item.content}`),
  ].join("\n");
  const requestKey = `native-authoring:${canonicalDigest({ parent: outer.requestKey, task: outer.packet.nativeTask?.taskSha256, instruction })}`;
  const runId = `native-authoring-${canonicalDigest({ parent: outer.runId, fence: outer.fence })}`;
  const toolPolicySha256 = canonicalDigest({
    workflow: catalog.workflow,
    stepIds: catalog.stepIds,
    declaredTools: catalog.declaredTools,
  });
  const stateDirectory = join(outer.stateDirectory, "authoring-state");
  await mkdir(stateDirectory, { mode: 0o700 });
  const { nativeTask: _nativeTask, ...packet } = outer.packet;
  const { authoritySha256: _outerGrantDigest, ...grantBody } = grant;
  const childBody = {
    ...outer,
    requestKey,
    runId,
    workflow: catalog.workflow,
    workspacePath: input.candidate.workspacePath,
    stateDirectory,
    stepIds: catalog.stepIds,
    composition,
    toolPolicySha256,
    packet: {
      ...packet,
      packetFingerprintSha256: canonicalDigest({
        parent: packet.packetFingerprintSha256,
        nativeTaskSha256: outer.packet.nativeTask?.taskSha256,
        workflow: catalog.workflow,
        instruction,
      }),
    },
    writeAuthority: sealHostRuntimeWriteAuthority({
      ...grantBody,
      requestKey,
      runId,
      workflow: catalog.workflow,
      pathCeiling: [...input.intendedPaths],
      targets: grant.targets.filter((target) => input.intendedPaths.includes(target.path)),
      writeStepIds: catalog.writeStepIds,
      compositionSha256: composition.compositionSha256,
      toolPolicySha256,
    }),
  };
  // The child is one private invocation of the existing writer, not another
  // Slack command or independently accepted job. All native input custody stays
  // on the actual outer job and its retained composition evidence.
  const { nativeCustody: _custody, ...body } = childBody;
  return { request: parseHostRuntimeRequest(body), instruction };
}

/** Preserve actual child domain artifacts before the enclosing attempt is removed. */
export async function retainNativeAuthoringArtifacts(
  childState: string,
  parentState: string,
): Promise<void> {
  const root = join(childState, "artifacts"),
    objects = join(root, "objects", "sha256");
  let names: string[];
  try {
    names = await readdir(objects);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name))
      throw new Error(
        "Nested authoring artifact inventory contains an unexpected object filename.",
      );
    const metadata = await lstat(join(objects, name));
    // The domain store verifies private ancestors, ownership, no symlink/hardlink,
    // stable file identity and canonical bytes; use this actual object's capacity.
    const record = await new DurableArtifactStore(root, {
      maxArtifactBytes: metadata.size,
    }).getRecord(name.slice(0, -5));
    await new DurableArtifactStore(join(parentState, "artifacts"), {
      maxArtifactBytes: metadata.size,
    }).putRecord(name.slice(0, -5), record);
  }
}
