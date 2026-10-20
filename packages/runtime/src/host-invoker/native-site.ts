// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Genuine signed-plan site execution with standard outer hosted patch evidence. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../content-ir/index.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../artifacts/store.js";
import { catalogCapacity } from "../config/catalog-capacity.js";
import { validateIaPlanReviewerPolicy } from "../ia/plan-review.js";
import { SiteBootstrapBundleError } from "../site-bootstrap/bundle.js";
import { LocalImpactPostflightService } from "../impact/postflight.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import { CatalogSkillCrateResolver } from "../skills/catalog-crate-resolver.js";
import { prepareTemplateSet } from "../templates/load.js";
import { prepareStandardSiteBootstrapChecks } from "../site-bootstrap/policy.js";
import {
  assembleHostedSiteBootstrap,
  verifyHostedSiteBootstrapSelection,
} from "../site-bootstrap/hosted.js";
import type { SiteBootstrapRunRecord } from "../site-bootstrap/contracts.js";
import type { HostRuntimeRequestV1 } from "./contracts.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import type { HostedNativeOperationAssembly } from "./native-operations.js";
import { loadHostRuntimeNativeBytes, loadHostRuntimeNativeCustodyInput } from "./native-custody.js";
import { withinWriteCeiling } from "./wire-decode.js";
import { runTrustedGit } from "./trusted-git.js";

export async function assembleHostedNativeSite(input: {
  request: HostRuntimeRequestV1;
  workspace: RepositoryWorkspace;
}): Promise<HostedNativeOperationAssembly> {
  const { request, workspace } = input;
  const task = request.packet.nativeTask,
    custody = request.nativeCustody,
    authority = request.writeAuthority;
  // Reachable here: an input count other than one, or a write grant with no
  // typed native task or custody. The write-grant and task-kind disjuncts are
  // already refused by `runHostedWorkflow` and `request.ts`.
  if (
    !task ||
    task.task.kind !== "site-bootstrap" ||
    !custody ||
    !request.allowWrite ||
    !authority ||
    task.inputs.length !== 1
  )
    throw new Error(
      "Hosted site bootstrap requires one registered signed-plan bundle and a separate write grant.",
    );
  // `native-custody.ts` only requires a row's `bytes` to be positive, so bound
  // the registered bundle's declared size before a byte is read; the private
  // reader below then enforces that size exactly.
  if (custody.inputs.some((row) => row.bytes > catalogCapacity("siteBootstrap.bundleMaxBytes")))
    throw new SiteBootstrapBundleError("bundle-too-large"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const selected = await loadHostRuntimeNativeCustodyInput(
    custody,
    task,
    task.inputs[0]!,
    request.stateDirectory,
  );
  const proof = selected.approvedImport;
  // The selected bytes must be the output of a registered, separately approved
  // `ia-plan` run at this revision; an ordinary producer output cannot authorize
  // a write. Proof and source come from the sealed custody record, not the task.
  if (
    !proof ||
    selected.source.workflow !== "ia-plan" ||
    selected.source.revision !== request.revision
  )
    throw new Error(
      "Hosted site bootstrap lacks exact producing-plan and registered approval provenance.",
    );
  // The custody parser admits any positive policy size; bound the read first.
  if (proof.reviewerPolicyBytes > catalogCapacity("siteBootstrap.reviewerPolicyMaxBytes"))
    throw new Error(
      "Hosted site bootstrap refused a registered reviewer policy over its catalogued size: policy-too-large.",
    );
  const policyBytes = await loadHostRuntimeNativeBytes(
    request.stateDirectory,
    proof.reviewerPolicyContentSha256,
    proof.reviewerPolicyBytes,
  );
  const reviewerPolicy = validateIaPlanReviewerPolicy(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policyBytes)),
  );
  // The reader above binds the file's bytes to `reviewerPolicyContentSha256`;
  // this binds the decoded policy's canonical digest to `reviewerPolicySha256`,
  // so authenticated bytes carrying some other policy are refused.
  if (reviewerPolicy.digest !== proof.reviewerPolicySha256)
    throw new Error("Hosted site bootstrap reviewer policy differs from the registered import.");
  const bundle = verifyHostedSiteBootstrapSelection({
    task: task.task,
    bundle: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(selected.bytes)),
    reviewerPolicy,
    repositoryRevision: request.revision,
    now: new Date(),
  });
  const approvedPaths = bundle.plan.payload.outputScope.map((output) => output.path);
  // A reviewer signs what to create; the host grant decides where it may be
  // written. Every approved output must sit inside the grant's ceiling.
  if (approvedPaths.some((path) => !withinWriteCeiling(path, authority.pathCeiling)))
    throw new Error("The signed site plan exceeds the installed workflow's write scope.");
  const evidence = await GitPatchEvidenceCollector.create(
    workspace.path,
    resolve(request.stateDirectory, "native-patches"),
  );
  try {
    let operationRecord: SiteBootstrapRunRecord | undefined;
    const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
    // A catalogued bound, not one measured from the record being saved: an
    // oversized record is refused as `artifact-too-large`.
    const runRecordStoreOptions = Object.freeze({
      maxArtifactBytes: catalogCapacity("siteBootstrap.runRecordMaxBytes"),
    });
    const assembly = assembleHostedSiteBootstrap({
      task: task.task,
      workspace,
      evidence,
      allowWrite: true,
      runId: request.runId,
      dependencies: {
        bundle,
        reviewerPolicy,
        templates: await prepareTemplateSet(projectRoot),
        checks: await prepareStandardSiteBootstrapChecks(),
        store: {
          async save(record) {
            operationRecord = structuredClone(record);
            const value = { schemaVersion: 1, kind: "docsfab-site-bootstrap-run", record };
            await new DurableArtifactStore(
              resolve(request.stateDirectory, "artifacts"),
              runRecordStoreOptions,
            ).putRecord(opaqueRecordDigest(value), value);
          },
        },
      },
    });
    const resolver = new CatalogSkillCrateResolver(resolve(projectRoot, "skill-crate"));
    return {
      ...assembly,
      repositoryEvidence: evidence,
      impactPostflight: new LocalImpactPostflightService(bundle.evaluationInput.index),
      harness: {
        inspectSkill: (step) => resolver.resolveSkill(step),
        async runStep() {
          throw new Error("Deterministic site bootstrap cannot invoke an inference harness.");
        },
      },
      async finalize(record) {
        if (record.status !== "succeeded") return;
        if (
          operationRecord?.status !== "succeeded" ||
          !operationRecord.scaffold ||
          !record.changes?.patch
        )
          throw new Error("Site generation has no completed operation and actual patch evidence.");
        const expected = [...approvedPaths].sort();
        if (
          record.impactPostflight?.status !== "completed" ||
          canonicalJson([...record.impactPostflight.changedPaths].sort()) !==
            canonicalJson(expected)
        )
          throw new Error(
            "Site generation lacks completed impact evidence for the exact approved outputs.",
          );
        const actual = record.changes.files.map((file) => file.path).sort();
        if (
          canonicalJson(actual) !== canonicalJson(expected) ||
          canonicalJson(operationRecord.scaffold.outputs.map((file) => file.path).sort()) !==
            canonicalJson(expected)
        )
          throw new Error("The generated site differs from the exact signed output scope.");
        const patch = record.changes.patch;
        const handle = await open(patch.artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size !== patch.byteLength ||
            stat.uid !== process.getuid?.()
          )
            throw new Error("The native patch artifact is no longer the recorded private file.");
          const bytes = await handle.readFile();
          if (createHash("sha256").update(bytes).digest("hex") !== patch.sha256)
            throw new Error("The native patch artifact differs from recorded evidence.");
        } finally {
          await handle.close();
        }
        // Only the disposable outer checkout changes. Its standard finalizer
        // recomputes every Git preimage, mode, path, operation and grant limit.
        await runTrustedGit(request.workspacePath, ["apply", "--check", "--", patch.artifactPath]);
        await runTrustedGit(request.workspacePath, ["apply", "--", patch.artifactPath]);
      },
    };
  } catch (error) {
    await evidence.dispose();
    throw error;
  }
}
