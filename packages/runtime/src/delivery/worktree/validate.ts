// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate seam: confined validation isolation and ready-worktree attestation.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { admitHostContainment } from "../../validation/host-containment.js";
import {
  nestedExecuteHostMustStayConfined,
  NESTED_SANDBOX_MARKER,
} from "./validation-isolation-policy.js";

export {
  nestedExecuteHostMustStayConfined,
  NESTED_SANDBOX_MARKER,
} from "./validation-isolation-policy.js";
import {
  DeliveryWorktreeError,
  normalizeDeliveryValidationFailureEvidence,
  type DeliveryValidationFailureEvidence,
  type DeliveryWorktreeFailureCode,
  type LocalUserPublicationPlan,
} from "../contracts.js";

const trustedDocumentationValidationFailures = new WeakSet<object>();

/** Accept detailed failure evidence only when this validator issued it. */
export function trustedDocumentationValidationFailureEvidence(
  value: DeliveryValidationFailureEvidence | undefined,
): DeliveryValidationFailureEvidence | undefined {
  return value !== undefined && trustedDocumentationValidationFailures.has(value)
    ? value
    : undefined;
}
import {
  readyAttestations,
  type DeliveryCommandRunner,
  type DeliveryValidationIsolation,
  type DeliveryValidationIsolationRequest,
  type DeliveryWorktreeCapability,
  type DeliveryWorktreeReadyAttestation,
  type SourceState,
  type TrustedCapability,
} from "./types.js";
import {
  DARWIN_DOCKER_DESKTOP_BACKEND_IDENTITY,
  DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT,
  DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT,
  DARWIN_DOCKER_DESKTOP_UNAVAILABLE_DIAGNOSTIC,
  darwinDockerDesktopProbeScript,
  darwinDockerDesktopValidationArgv,
} from "./docker-desktop-backend.js";
import {
  DOCSFAB_VALIDATION_BACKEND_POLICY_V1,
  createValidationBackendRequest,
  failValidationBackend,
  issueHostSelectedValidationBackend,
  requireValidationBackend,
  selectHostValidationBackendIdentity,
  validationBackendPolicySha256,
  validationScratchSha256,
  ValidationBackendError,
  type ValidationBackendAttestationV1,
  type ValidationBackendCapability,
  type ValidationBackendRequestV1,
} from "./validation-backend.js";
import {
  assertDocumentationValidationBinding,
  documentationValidationKit,
  documentationValidationSelectorInputSha256,
  resolveHostDocumentationValidator,
} from "../validation-profile.js";
import {
  documentationCandidateInputTreeSha256,
  documentationRepositoryIdentitySha256,
} from "../documentation-validation-candidate.js";
import {
  StructuralDocumentationValidationError,
  validateSourceAwareStructuralDocumentation,
  validateStructuralDocumentation,
  type DocumentationChangedPath,
  type DocumentationCheckStatus,
} from "../structural-documentation-validator.js";
import { DurableArtifactStore } from "../../artifacts/store.js";
import {
  deriveDocumentationSourceApplicability,
  loadDocumentationSourceApplicability,
} from "../../repository/documentation-source-applicability.js";
import { isDocumentationSourceConfigurationPath } from "../../repository/documentation-source-support.js";
import {
  assertFilesystemMatchesGitTree,
  assertGitConfigSnapshot,
  assertTrustedPaths,
  directRefRevision,
  fail,
  filesystemState,
  readDirectHead,
  readDirectRefs,
  requireCapability,
  resolveCommonGitDirectory,
  resolveGitDirectoryFromWorktree,
  safeRepositoryPath,
  verifyPinnedPatch,
  within,
} from "./host.js";

/**
 * Revalidate an in-process ready capability and issue the exact evidence seam
 * consumed by the SCM publisher. A copied or reconstructed object is rejected.
 */
export async function inspectReadyDeliveryWorktree(
  worktree: DeliveryWorktreeCapability,
): Promise<DeliveryWorktreeReadyAttestation> {
  const trusted = requireCapability(worktree);
  if (
    trusted.state !== "ready" ||
    trusted.worktreeRemoved ||
    !trusted.authorizedTree ||
    !trusted.readyStateSha256 ||
    !trusted.worktreeIdentity
  )
    fail("cleanup-refused");
  await assertTrustedPaths(trusted, true);
  await verifyPinnedPatch(trusted, "patch-mismatch");
  const stateSha256 = await deliveryState(worktree);
  if (stateSha256 !== trusted.readyStateSha256) fail("validation-mutated-delivery");
  const workspaceKey = deliveryWorkspaceKey(trusted);
  const attestation: DeliveryWorktreeReadyAttestation = Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-delivery-worktree-ready-attestation",
    runId: trusted.runId,
    planSha256: trusted.planSha256,
    worktreePath: trusted.worktreePath,
    baseRevision: trusted.baseRevision,
    tree: trusted.authorizedTree,
    workspaceKey,
    patch: Object.freeze({
      sha256: trusted.patchSha256,
      byteLength: trusted.plan.patch.byteLength,
    }),
    validation: Object.freeze({
      commandSha256: createHash("sha256").update(trusted.plan.validationCommand).digest("hex"),
      stateSha256,
      ...(await documentationValidationEvidence(
        trusted,
        stateSha256,
        await filesystemState(trusted.worktreePath),
      )),
    }),
    metadata: Object.freeze({ ...trusted.metadataInputDigests }),
  });
  readyAttestations.set(attestation, { worktree, stateSha256 });
  return attestation;
}

export function deliveryWorkspaceKey(trusted: TrustedCapability): string {
  if (!trusted.authorizedTree || !trusted.worktreeIdentity) fail("cleanup-refused");
  return createHash("sha256")
    .update(trusted.planSha256)
    .update("\0")
    .update(trusted.baseRevision)
    .update("\0")
    .update(trusted.authorizedTree)
    .update("\0")
    .update(trusted.patchSha256)
    .update("\0")
    .update(String(trusted.worktreeIdentity.dev))
    .update("\0")
    .update(String(trusted.worktreeIdentity.ino))
    .digest("hex");
}

async function documentationValidationEvidence(
  trusted: TrustedCapability,
  stateSha256: string,
  candidateTreeSha256: string,
): Promise<Partial<DeliveryWorktreeReadyAttestation["validation"]>> {
  const binding = trusted.plan.documentationValidation;
  if (binding === undefined) return {};
  try {
    assertDocumentationValidationBinding(binding);
  } catch {
    fail("invalid-delivery-input");
  }
  const resolved = resolveHostDocumentationValidator(binding.profileId, binding.profileVersion);
  if (trusted.plan.validationCommand !== resolved.entrypointCommand) fail("invalid-delivery-input");
  const backendIdentity =
    trusted.validationIsolationMode === "confined"
      ? selectHostValidationBackendIdentity(process.platform)
      : undefined;
  const changedPaths = changedPathsFromPatch(
    await readFile(join(trusted.capsulePath, "verified.patch")),
  );
  let applicability;
  if (binding.schemaVersion === 2) {
    applicability = await loadDocumentationSourceApplicability(
      new DurableArtifactStore(trusted.artifactStoreRoot),
      binding.applicabilitySha256,
    ).catch(() => fail("invalid-delivery-input"));
    const expectedCandidateInputTreeSha256 = documentationCandidateInputTreeSha256({
      baseRevision: trusted.baseRevision,
      patchSha256: trusted.patchSha256,
    });
    if (applicability.candidateInputTreeSha256 !== expectedCandidateInputTreeSha256)
      fail("invalid-delivery-input");
    const current = await deriveDocumentationSourceApplicability({
      candidateRoot: trusted.worktreePath,
      repositoryIdentitySha256: documentationRepositoryIdentitySha256({
        host: trusted.plan.project.host,
        path: trusted.plan.project.path,
        projectId: trusted.plan.project.id,
      }),
      baseRevision: trusted.baseRevision,
      candidateInputTreeSha256: expectedCandidateInputTreeSha256,
      changedPaths: applicabilityChangedPaths(trusted),
      baseConfigurationPaths: trusted.changedFiles
        .filter((file) => file.status === "deleted" || file.status === "renamed")
        .map((file) => file.previousPath ?? file.path)
        .filter(isDocumentationSourceConfigurationPath),
    });
    if (current.applicabilitySha256 !== applicability.applicabilitySha256)
      fail("invalid-delivery-input");
    const expectedSelector = documentationValidationSelectorInputSha256({
      workflow: trusted.workflow,
      changedPaths: selectorChangedPaths(trusted),
      hostPolicySha256: validationBackendPolicySha256(),
      applicabilitySha256: applicability.applicabilitySha256,
    });
    if (expectedSelector !== binding.selectorInputSha256) fail("invalid-delivery-input");
  }
  const results = await documentationValidationResults(
    trusted,
    binding.checkIds,
    candidateTreeSha256,
    backendIdentity,
    changedPaths,
    applicability,
  );
  return {
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
    checkIds: [...binding.checkIds],
    selectorInputSha256: binding.selectorInputSha256,
    validatorIdentity: binding.validatorIdentity,
    candidateTreeSha256,
    checkSetSha256: binding.checkSetSha256,
    ...(binding.schemaVersion === 2 ? { applicabilitySha256: binding.applicabilitySha256 } : {}),
    ...(backendIdentity ? { backendIdentity } : {}),
    results,
    resultSha256: documentationValidationKit.canonicalDigest({
      results,
      stateSha256,
      checkSetSha256: binding.checkSetSha256,
      candidateTreeSha256,
      ...(binding.schemaVersion === 2 ? { applicabilitySha256: binding.applicabilitySha256 } : {}),
    }),
  };
}

function applicabilityChangedPaths(trusted: TrustedCapability): DocumentationChangedPath[] {
  return trusted.changedFiles.flatMap((file) => [
    ...(file.previousPath && file.status === "renamed"
      ? [{ path: file.previousPath, status: "deleted" as const }]
      : []),
    {
      path: file.path,
      status:
        file.status === "unknown"
          ? ("modified" as const)
          : file.status === "untracked"
            ? ("added" as const)
            : file.status,
    },
  ]);
}

function selectorChangedPaths(trusted: TrustedCapability): string[] {
  return trusted.changedFiles.flatMap((file) =>
    file.previousPath ? [file.path, file.previousPath] : [file.path],
  );
}

async function documentationValidationResults(
  trusted: TrustedCapability,
  checkIds: readonly string[],
  candidateTreeSha256: string,
  backendIdentity: string | undefined,
  changedPaths: readonly DocumentationChangedPath[],
  applicability?: Awaited<ReturnType<typeof loadDocumentationSourceApplicability>>,
): Promise<readonly { id: string; status: DocumentationCheckStatus }[]> {
  if (checkIds.includes("non-package-script-gate")) {
    if (
      applicability &&
      (applicability.roots.length > 0 ||
        applicability.roots.some((root) => root.limitations.length > 0))
    )
      fail("validation-failed");
    return completeDocumentationValidationResults(checkIds, [
      { id: "candidate-input-tree", status: "passed" },
      { id: "isolation-boundary", status: "passed" },
      { id: "non-package-script-gate", status: "passed" },
    ]);
  }
  let structural: Awaited<ReturnType<typeof validateStructuralDocumentation>>;
  try {
    structural = applicability
      ? await validateSourceAwareStructuralDocumentation(
          trusted.worktreePath,
          changedPaths,
          applicability,
        )
      : await validateStructuralDocumentation(trusted.worktreePath, changedPaths);
  } catch (error) {
    if (error instanceof StructuralDocumentationValidationError) {
      const binding = trusted.plan.documentationValidation;
      const failure = new DeliveryWorktreeError(
        "validation-failed",
        normalizeDeliveryValidationFailureEvidence({
          reasonCode: "validation-check-failed",
          planSha256: trusted.planSha256,
          runId: trusted.runId,
          runRecordSha256: trusted.recordSha256,
          patchSha256: trusted.patchSha256,
          workspaceKey: deliveryWorkspaceKey(trusted),
          commandSha256: createHash("sha256").update(trusted.plan.validationCommand).digest("hex"),
          candidateTreeSha256,
          ...(binding
            ? {
                profileId: binding.profileId,
                profileVersion: binding.profileVersion,
                checkIds: [...binding.checkIds],
                selectorInputSha256: binding.selectorInputSha256,
                validatorIdentity: binding.validatorIdentity,
                checkSetSha256: binding.checkSetSha256,
                ...(binding.schemaVersion === 2
                  ? { applicabilitySha256: binding.applicabilitySha256 }
                  : {}),
              }
            : {}),
          ...(backendIdentity ? { backendIdentity } : {}),
          results: [{ id: error.check, status: error.status }],
        }),
      );
      if (failure.validation === undefined) fail("validation-failed");
      trustedDocumentationValidationFailures.add(failure.validation);
      throw failure;
    }
    throw error;
  }
  const actual = [
    { id: "candidate-input-tree", status: "passed" as const },
    ...structural,
    { id: "isolation-boundary", status: "passed" as const },
  ];
  return completeDocumentationValidationResults(checkIds, actual);
}

/** Enforce one and only one result for every host-selected check. */
export function completeDocumentationValidationResults(
  checkIds: readonly string[],
  results: readonly { id: string; status: DocumentationCheckStatus }[],
): readonly { id: string; status: DocumentationCheckStatus }[] {
  const expected = new Set(checkIds);
  const byId = new Map<string, { id: string; status: DocumentationCheckStatus }>();
  for (const result of results) {
    if (!expected.has(result.id) || byId.has(result.id)) fail("validation-failed");
    byId.set(result.id, result);
  }
  if (byId.size !== checkIds.length) fail("validation-failed");
  return Object.freeze(
    checkIds.map((id) => {
      const result = byId.get(id);
      if (!result) fail("validation-failed");
      return Object.freeze({ ...result });
    }),
  );
}

/** The preserved, sealed patch is the exact changed-path authority at receipt time. */
function changedPathsFromPatch(bytes: Buffer): DocumentationChangedPath[] {
  const paths: DocumentationChangedPath[] = [];
  let current: { path: string; status: DocumentationChangedPath["status"] } | undefined;
  for (const line of bytes.toString("utf8").split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (match) {
      if (current) paths.push(current);
      const path = match[2];
      if (!path || path.includes("\\") || path.includes("\t")) fail("validation-failed");
      current = { path, status: "modified" };
      continue;
    }
    if (!current) continue;
    if (/^new file mode /u.test(line)) current.status = "added";
    else if (/^deleted file mode /u.test(line)) current.status = "deleted";
    else if (/^rename from /u.test(line)) current.status = "renamed";
    else if (/^copy from /u.test(line)) current.status = "copied";
  }
  if (current) paths.push(current);
  if (paths.length === 0) fail("validation-failed");
  const unique = new Map<string, DocumentationChangedPath>();
  for (const path of paths) unique.set(path.path, path);
  return [...unique.values()];
}

function sameDocumentationValidationEvidence(
  attestation: DeliveryWorktreeReadyAttestation,
  trusted: TrustedCapability,
): boolean {
  const binding = trusted.plan.documentationValidation;
  const evidence = attestation.validation;
  if (binding === undefined) {
    return (
      evidence.profileId === undefined &&
      evidence.profileVersion === undefined &&
      evidence.checkIds === undefined &&
      evidence.selectorInputSha256 === undefined &&
      evidence.validatorIdentity === undefined &&
      evidence.candidateTreeSha256 === undefined &&
      evidence.checkSetSha256 === undefined &&
      evidence.applicabilitySha256 === undefined &&
      evidence.backendIdentity === undefined &&
      evidence.resultSha256 === undefined &&
      evidence.results === undefined
    );
  }
  const backendIdentity =
    trusted.validationIsolationMode === "confined"
      ? selectHostValidationBackendIdentity(process.platform)
      : undefined;
  return (
    evidence.profileId === binding.profileId &&
    evidence.profileVersion === binding.profileVersion &&
    Array.isArray(evidence.checkIds) &&
    evidence.checkIds.length === binding.checkIds.length &&
    evidence.checkIds.every((id, index) => id === binding.checkIds[index]) &&
    evidence.selectorInputSha256 === binding.selectorInputSha256 &&
    evidence.validatorIdentity === binding.validatorIdentity &&
    evidence.checkSetSha256 === binding.checkSetSha256 &&
    (binding.schemaVersion === 2
      ? evidence.applicabilitySha256 === binding.applicabilitySha256
      : evidence.applicabilitySha256 === undefined) &&
    evidence.backendIdentity === backendIdentity &&
    typeof evidence.candidateTreeSha256 === "string" &&
    typeof evidence.resultSha256 === "string" &&
    Array.isArray(evidence.results) &&
    evidence.results.length === binding.checkIds.length &&
    evidence.results.every(
      (result, index) => result.id === binding.checkIds[index] && result.status === "passed",
    )
  );
}

export async function assertDeliveryWorktreeReadyAttestation(
  attestation: DeliveryWorktreeReadyAttestation,
  worktree: DeliveryWorktreeCapability,
): Promise<void> {
  const binding = readyAttestations.get(attestation);
  const trusted = requireCapability(worktree);
  if (
    !binding ||
    binding.worktree !== worktree ||
    binding.stateSha256 !== trusted.readyStateSha256 ||
    trusted.state !== "ready" ||
    attestation.planSha256 !== trusted.planSha256 ||
    attestation.runId !== trusted.runId ||
    attestation.worktreePath !== trusted.worktreePath ||
    attestation.baseRevision !== trusted.baseRevision ||
    attestation.tree !== trusted.authorizedTree ||
    attestation.patch.sha256 !== trusted.patchSha256 ||
    attestation.patch.byteLength !== trusted.plan.patch.byteLength ||
    attestation.metadata.workflowOutcomeSha256 !==
      trusted.metadataInputDigests.workflowOutcomeSha256 ||
    attestation.metadata.changedPathsSha256 !== trusted.metadataInputDigests.changedPathsSha256 ||
    attestation.metadata.selectedCompositionId !==
      trusted.metadataInputDigests.selectedCompositionId ||
    attestation.metadata.compositionEvidenceSha256 !==
      trusted.metadataInputDigests.compositionEvidenceSha256 ||
    attestation.metadata.compositionAggregateSha256 !==
      trusted.metadataInputDigests.compositionAggregateSha256 ||
    attestation.metadata.compositionMarkerSha256 !==
      trusted.metadataInputDigests.compositionMarkerSha256 ||
    !sameDocumentationValidationEvidence(attestation, trusted)
  ) {
    fail("cleanup-refused");
  }
  await verifyPinnedPatch(trusted, "patch-mismatch");
  if ((await deliveryState(worktree)) !== binding.stateSha256) fail("validation-mutated-delivery");
}

export async function sourceState(
  repositoryPath: string,
  sourceGitDirectory: string,
  commonGitDirectory: string,
): Promise<SourceState> {
  if (
    (await resolveGitDirectoryFromWorktree(repositoryPath, "source-state-changed")) !==
      sourceGitDirectory ||
    (await resolveCommonGitDirectory(sourceGitDirectory, "source-state-changed")) !==
      commonGitDirectory
  )
    fail("source-state-changed");
  const head = await readDirectHead(sourceGitDirectory, "source-state-changed");
  const parts = [
    head.bytes,
    await directMetadataFingerprint(join(sourceGitDirectory, "index"), "source-state-changed"),
  ];
  return {
    checkoutSha256: createHash("sha256").update(Buffer.concat(parts)).digest("hex"),
    filesystemSha256: await filesystemState(repositoryPath),
    refs: await readDirectRefs(commonGitDirectory, "source-state-changed"),
  };
}

export async function deliveryState(worktree: DeliveryWorktreeCapability): Promise<string> {
  const trusted = requireCapability(worktree);
  if (!trusted.deliveryGitDirectory || !trusted.authorizedEntries) {
    fail("validation-mutated-delivery");
  }
  await assertGitConfigSnapshot(trusted.gitConfigSnapshot, "validation-mutated-delivery");
  await assertFilesystemMatchesGitTree(
    trusted.worktreePath,
    trusted.authorizedEntries,
    "validation-mutated-delivery",
  );
  const gitDirectory = await resolveGitDirectoryFromWorktree(
    trusted.worktreePath,
    "validation-mutated-delivery",
  );
  if (
    gitDirectory !== trusted.deliveryGitDirectory ||
    (await resolveCommonGitDirectory(gitDirectory, "validation-mutated-delivery")) !==
      trusted.commonGitDirectory
  )
    fail("validation-mutated-delivery");
  const head = await readDirectHead(gitDirectory, "validation-mutated-delivery");
  const ref = `refs/heads/${trusted.branch}`;
  if (trusted.retainedHeadShape) {
    const attached =
      trusted.retainedHeadShape !== "detached-base" &&
      trusted.retainedHeadShape !== "detached-commit";
    const revision = attached
      ? await directRefRevision(trusted.commonGitDirectory, ref, "validation-mutated-delivery")
      : head.revision;
    if (
      revision !== trusted.expectedDeliveryHeadRevision ||
      (attached ? head.branch !== ref : head.branch !== undefined) ||
      (await directRefRevision(trusted.commonGitDirectory, ref, "validation-mutated-delivery")) !==
        trusted.expectedSourceBranchRevision
    )
      fail("validation-mutated-delivery");
  } else if (trusted.createsSourceBranch) {
    if (
      head.branch !== ref ||
      (await directRefRevision(trusted.commonGitDirectory, ref, "validation-mutated-delivery")) !==
        trusted.baseRevision
    )
      fail("validation-mutated-delivery");
  } else if (head.branch !== undefined || head.revision !== trusted.baseRevision) {
    fail("validation-mutated-delivery");
  }
  const parts = [
    Buffer.from(await filesystemState(worktree.worktreePath)),
    head.bytes,
    await directMetadataFingerprint(join(gitDirectory, "index"), "validation-mutated-delivery"),
    await directMetadataFingerprint(join(gitDirectory, "gitdir"), "validation-mutated-delivery"),
    await directMetadataFingerprint(join(gitDirectory, "commondir"), "validation-mutated-delivery"),
    ...(trusted.createsSourceBranch || trusted.retainedHeadShape?.startsWith("attached-")
      ? [
          await directMetadataFingerprint(
            join(trusted.commonGitDirectory, ...ref.split("/")),
            "validation-mutated-delivery",
          ),
        ]
      : []),
  ];
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

export async function directMetadataFingerprint(
  path: string,
  code: DeliveryWorktreeFailureCode,
): Promise<Buffer> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) fail(code);
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      after.dev !== details.dev ||
      after.ino !== details.ino ||
      after.mode !== details.mode ||
      after.size !== details.size
    )
      fail(code);
    return Buffer.concat([
      Buffer.from(`${details.dev}\0${details.ino}\0${details.mode}\0${details.size}\0`),
      bytes,
    ]);
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail(code);
  }
}

export function expectedSourceTransition(
  before: SourceState,
  after: SourceState,
  plan: LocalUserPublicationPlan,
  requireCreatedBranch: boolean,
): boolean {
  if (
    before.checkoutSha256 !== after.checkoutSha256 ||
    before.filesystemSha256 !== after.filesystemSha256
  )
    return false;
  const branchRef = `refs/heads/${plan.proposedSourceBranch}`;
  const beforeBranch = before.refs.get(branchRef);
  const afterBranch = after.refs.get(branchRef);
  if (requireCreatedBranch && (beforeBranch !== undefined || afterBranch !== plan.baseRevision))
    return false;
  if (beforeBranch === undefined && afterBranch !== undefined && afterBranch !== plan.baseRevision)
    return false;
  if (beforeBranch !== undefined && afterBranch !== beforeBranch) return false;
  const beforeOther = [...before.refs].filter(([key]) => key !== branchRef);
  const afterOther = [...after.refs].filter(([key]) => key !== branchRef);
  return (
    canonicalizeJsonEvidence(beforeOther as unknown as JsonEvidenceValue) ===
    canonicalizeJsonEvidence(afterOther as unknown as JsonEvidenceValue)
  );
}

export function splitValidationCommand(value: string): {
  command: string;
  args: string[];
} {
  const parts = value.split(/ +/u);
  const command = parts.shift();
  if (!command) fail("invalid-delivery-input");
  return { command, args: parts };
}

export function validationEnvironment(validationHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: validationHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: join(validationHome, "tmp"),
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

export async function validationDeniedReadPaths(trusted: TrustedCapability): Promise<string[]> {
  const sourceSentinel = await findRegularSourceSentinel(trusted.repositoryPath, "");
  const candidates = [
    sourceSentinel ?? join(trusted.sourceGitDirectory, "HEAD"),
    join(trusted.sourceGitDirectory, "HEAD"),
    join(trusted.commonGitDirectory, "config"),
  ];
  const paths = [...new Set(candidates.map((path) => resolve(path)))];
  for (const path of paths) await assertRegularValidationSentinel(path);
  return paths;
}

export async function findRegularSourceSentinel(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  const directory = relativePath ? join(root, ...relativePath.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (path === ".git" || !safeRepositoryPath(path) || entry.isSymbolicLink()) continue;
    const absolute = join(root, ...path.split("/"));
    const details = await lstat(absolute);
    if (details.isFile() && !details.isSymbolicLink()) return absolute;
    if (details.isDirectory()) {
      const nested = await findRegularSourceSentinel(root, path);
      if (nested) return nested;
    }
  }
  return undefined;
}

export async function assertRegularValidationSentinel(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("Validation denied-read sentinel is not a regular file.");
  }
}

export async function requireConfinedValidationIsolation(
  request: DeliveryValidationIsolationRequest,
  commands: DeliveryCommandRunner,
  cwd: string,
): Promise<DeliveryValidationIsolation> {
  const worktreePath = resolve(request.worktreePath);
  const scratchPath = resolve(request.scratchPath);
  const deniedReadPaths = [...new Set(request.deniedReadPaths.map((path) => resolve(path)))];
  const deniedReadRoots = [...new Set(request.deniedReadRoots.map((path) => resolve(path)))];
  if (
    deniedReadPaths.length === 0 ||
    deniedReadRoots.length === 0 ||
    [worktreePath, scratchPath, ...deniedReadPaths, ...deniedReadRoots].some(
      (path) => !isAbsolute(path),
    ) ||
    within(worktreePath, scratchPath) ||
    within(scratchPath, worktreePath)
  ) {
    throw new Error("Invalid validation roots.");
  }
  for (const path of deniedReadPaths) await assertRegularValidationSentinel(path);
  const host = { worktreePath, scratchPath, deniedReadPaths, deniedReadRoots };
  const backend = issueHostSelectedValidationBackend(process.platform);
  if (backend) {
    const verifier = requireValidationBackend(backend);
    const backendRequest = await bindLiveValidationBackendRequest(host);
    if (verifier.identity === "linux-bubblewrap") {
      try {
        const admitted = await admitLinuxBubblewrapValidationBackend(
          backend,
          backendRequest,
          host,
          commands,
          cwd,
        );
        return admitted.isolation;
      } catch (error) {
        if (error instanceof NestedSandboxIsolationError) throw error;
        if (nestedExecuteHostMustStayConfined()) {
          throw new NestedSandboxIsolationError();
        }
      }
    } else if (verifier.identity === DARWIN_DOCKER_DESKTOP_BACKEND_IDENTITY) {
      try {
        const admitted = await admitDarwinDockerDesktopValidationBackend(
          backend,
          backendRequest,
          host,
          commands,
          cwd,
        );
        return admitted.isolation;
      } catch (error) {
        if (error instanceof NestedSandboxIsolationError) throw error;
        if (error instanceof ValidationBackendError) {
          throw new NestedSandboxIsolationError(
            error.code === "backend-unavailable"
              ? DARWIN_DOCKER_DESKTOP_UNAVAILABLE_DIAGNOSTIC
              : `Docker Desktop validation was rejected (${error.code}). The preserved patch was not applied to the source checkout.`,
            !nestedExecuteHostMustStayConfined(),
          );
        }
        throw error;
      }
    } else {
      failValidationBackend("untrusted-backend");
    }
  } else {
    for (const candidate of validationIsolationCandidates(
      process.platform,
      [host.worktreePath],
      [host.scratchPath],
      host.deniedReadRoots,
    )) {
      if (
        (await probeValidationIsolationCandidate(candidate, host, commands, cwd)).exitCode === 0
      ) {
        return { commandPrefix: candidate };
      }
    }
    if (nestedExecuteHostMustStayConfined()) {
      throw new NestedSandboxIsolationError();
    }
  }
  throw new Error("Validation isolation unavailable.");
}

export async function admitLinuxBubblewrapValidationBackend(
  backend: ValidationBackendCapability,
  request: ValidationBackendRequestV1,
  hostRequest: DeliveryValidationIsolationRequest,
  commands: DeliveryCommandRunner,
  cwd: string,
): Promise<{
  isolation: DeliveryValidationIsolation;
  attestation: ValidationBackendAttestationV1;
}> {
  const host = await resolveValidationIsolationHost(hostRequest);
  const admitted = await admitHostContainment({
    backend,
    request,
    identity: "linux-bubblewrap",
    policy: {
      tier: "delivery",
      readRoots: [host.worktreePath],
      writableRoots: [host.scratchPath],
      network: "deny",
      credentials: "deny-host",
      lifetime: "die-with-parent",
    },
    observeInput: () => filesystemState(host.worktreePath),
    observeScratch: () => validationScratchSha256(host.scratchPath),
    probe: async () => {
      for (const candidate of validationIsolationCandidates(
        "linux",
        [host.worktreePath],
        [host.scratchPath],
        host.deniedReadRoots,
      )) {
        const probe = await probeValidationIsolationCandidate(candidate, host, commands, cwd);
        if (probe.exitCode === 0)
          return { value: { commandPrefix: candidate }, commandPrefix: candidate };
      }
      failValidationBackend("backend-unavailable");
    },
  });
  return { isolation: admitted.value, attestation: admitted.attestation };
}

export async function admitDarwinDockerDesktopValidationBackend(
  backend: ValidationBackendCapability,
  request: ValidationBackendRequestV1,
  hostRequest: DeliveryValidationIsolationRequest,
  commands: DeliveryCommandRunner,
  cwd: string,
): Promise<{
  isolation: DeliveryValidationIsolation;
  attestation: ValidationBackendAttestationV1;
}> {
  const host = await resolveValidationIsolationHost(hostRequest);
  const admitted = await admitHostContainment({
    backend,
    request,
    identity: DARWIN_DOCKER_DESKTOP_BACKEND_IDENTITY,
    policy: {
      tier: "delivery",
      readRoots: [host.worktreePath],
      writableRoots: [host.scratchPath],
      network: "deny",
      credentials: "deny-host",
      lifetime: "exact-container",
    },
    observeInput: () => filesystemState(host.worktreePath),
    observeScratch: () => validationScratchSha256(host.scratchPath),
    probe: async () => {
      const candidate = darwinDockerDesktopValidationArgv(host);
      const probe = await probeDarwinDockerDesktopIsolation(candidate, host, commands, cwd);
      if (probe.exitCode !== 0) failValidationBackend("backend-unavailable");
      return { value: { commandPrefix: candidate }, commandPrefix: candidate };
    },
  });
  return { isolation: admitted.value, attestation: admitted.attestation };
}

export async function bindLiveValidationBackendRequest(
  host: DeliveryValidationIsolationRequest,
): Promise<ValidationBackendRequestV1> {
  const resolved = await resolveValidationIsolationHost(host);
  return createValidationBackendRequest({
    inputTreeSha256: await filesystemState(resolved.worktreePath),
    scratchSha256: await validationScratchSha256(resolved.scratchPath),
    limits: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.limits },
    egress: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.egress },
    credentials: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.credentials },
    teardown: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.teardown },
  });
}

async function resolveValidationIsolationHost(
  request: DeliveryValidationIsolationRequest,
): Promise<{
  worktreePath: string;
  scratchPath: string;
  deniedReadPaths: string[];
  deniedReadRoots: string[];
}> {
  const worktreePath = resolve(request.worktreePath);
  const scratchPath = resolve(request.scratchPath);
  const deniedReadPaths = [...new Set(request.deniedReadPaths.map((path) => resolve(path)))];
  const deniedReadRoots = [...new Set(request.deniedReadRoots.map((path) => resolve(path)))];
  if (
    deniedReadPaths.length === 0 ||
    deniedReadRoots.length === 0 ||
    [worktreePath, scratchPath, ...deniedReadPaths, ...deniedReadRoots].some(
      (path) => !isAbsolute(path),
    ) ||
    within(worktreePath, scratchPath) ||
    within(scratchPath, worktreePath)
  ) {
    throw new Error(
      "Validation isolation roots must be absolute, disjoint, and include sentinels.",
    );
  }
  for (const path of deniedReadPaths) await assertRegularValidationSentinel(path);
  return { worktreePath, scratchPath, deniedReadPaths, deniedReadRoots };
}

async function probeValidationIsolationCandidate(
  candidate: readonly string[],
  host: {
    worktreePath: string;
    scratchPath: string;
    deniedReadPaths: readonly string[];
  },
  commands: DeliveryCommandRunner,
  cwd: string,
) {
  // Private loopback is permitted in a network namespace; test outbound connectivity instead.
  const probeScript = darwinDockerDesktopProbeScript();
  return commands.run(
    candidate[0]!,
    [
      ...candidate.slice(1),
      process.execPath,
      "-e",
      probeScript,
      ...host.deniedReadPaths,
      join(host.worktreePath, ".docsfab-validation-probe"),
      join(host.scratchPath, "probe"),
    ],
    cwd,
    { env: validationEnvironment(host.scratchPath), timeoutMs: 5_000 },
  );
}

async function probeDarwinDockerDesktopIsolation(
  candidate: readonly string[],
  host: {
    worktreePath: string;
    scratchPath: string;
    deniedReadPaths: readonly string[];
  },
  commands: DeliveryCommandRunner,
  cwd: string,
) {
  return commands.run(
    candidate[0]!,
    [
      ...candidate.slice(1),
      "node",
      "-e",
      darwinDockerDesktopProbeScript(),
      ...host.deniedReadPaths,
      `${DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT}/.docsfab-validation-probe`,
      `${DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT}/probe`,
    ],
    cwd,
    { env: validationEnvironment(host.scratchPath), timeoutMs: 5_000 },
  );
}

/**
 * Confinement is unusable on a nested execute host, or Docker Desktop rejected
 * validation. Interactive-once may fall back to operator-supervised validation
 * only when `allowOperatorSupervisedFallback` is true, which Docker Desktop sets
 * outside nested hosts. A non-nested host with no confinement throws a plain Error.
 */
export class NestedSandboxIsolationError extends Error {
  public readonly allowOperatorSupervisedFallback: boolean;

  public constructor(
    message = "Validation isolation unavailable.",
    allowOperatorSupervisedFallback = false,
  ) {
    super(message);
    this.name = "NestedSandboxIsolationError";
    this.allowOperatorSupervisedFallback = allowOperatorSupervisedFallback;
  }
}

export function validationIsolationCandidates(
  platform: NodeJS.Platform,
  readRoots: readonly string[],
  scratchRoots: readonly string[],
  deniedRoots: readonly string[] = [],
): string[][] {
  const reads = [...new Set(readRoots.map((root) => resolve(root)))];
  const scratch = [...new Set(scratchRoots.map((root) => resolve(root)))];
  const denied = [...new Set(deniedRoots.map((root) => resolve(root)))];
  if (
    reads.length === 0 ||
    scratch.length === 0 ||
    [...reads, ...scratch, ...denied].some((root) => !isAbsolute(root))
  )
    return [];
  const runtimeReads = ["/usr", "/bin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/ssl"];
  if (platform === "linux") {
    if (
      denied.some((sensitive) =>
        runtimeReads.some((runtime) => within(runtime, sensitive) || within(sensitive, runtime)),
      )
    )
      return [];
    const readBinds = [...runtimeReads, process.execPath, ...reads].flatMap((root) => [
      "--ro-bind-try",
      root,
      root,
    ]);
    const scratchBinds = scratch.flatMap((root) => ["--bind", root, root]);
    return [
      [
        "/usr/bin/bwrap",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--new-session",
        "--tmpfs",
        "/",
        ...readBinds,
        ...scratchBinds,
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--",
      ],
    ];
  }
  return [];
}
