#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openAcceptanceJsonExclusive,
  readAcceptanceJsonLeaf,
  type AcceptanceEvidenceDirectory,
} from "./acceptance-evidence.js";
import {
  authorizeBoundedDocImprovementCampaign,
  authorizeBoundedDocImprovementWrite,
  buildBoundedDocImprovementEvidence,
  parseBoundedDocImprovementDeclaration,
  renderBoundedDocImprovementEvidenceMarkdown,
  serializeBoundedDocImprovementEvidence,
  type BoundedDocImprovementDeclarationV1,
  type BuildDocImprovementEvidenceInput,
  type CommandEvidence,
  type AuthorizeBoundedDocImprovementWriteInput,
  type DocImprovementVerificationEvidence,
} from "./doc-improvement.js";
import type { BoundedDocImprovementTaskInput } from "./workflow-contracts/contracts.js";
import { loadIaPlanReviewerPolicyFile } from "./ia/reviewer-policy-file.js";
import type { IaPlanReviewerPolicy } from "./ia/plan-review.js";
import { runCliEntrypoint } from "./operator/cli-entrypoint.js";
import { parsePrivateJsonEvidence, readPrivateJsonEvidenceLeaf } from "./operator/json-evidence.js";
import {
  assertPrivateOperatorEvidenceDirectory,
  pinPrivateOperatorEvidenceDirectory,
  preparePrivateOperatorRoot,
} from "./operator/private-state.js";
import { acquireRepositoryWorkspaceLease } from "./repository/workspace/lease.js";
import { prepareRepositoryWorkspace } from "./repository/workspace/materialize.js";
import { verifyActiveRepositoryWorkspace } from "./repository/workspace/tracked-read.js";
import { sha256 } from "./content-ir/canonical.js";
import { hasErrnoCode } from "./shared/primitives.js";
import {
  commandEvidence,
  emptyFailure,
  runRaw,
  text,
  type RawCommandResult,
} from "./doc-improvement-cli/process-capture.js";

import {
  assertNotEffectivelyWritable,
  assertPinnedValidationRuntimePaths,
  assertValidationNpmRuntime,
  pinValidationRuntimeAncestorChain,
  resolveValidationNpmRuntime,
  validationNpmRuntimeTreeDigest,
  type PinnedValidationRuntimePath,
  type ValidationNpmRuntime,
} from "./doc-improvement-cli/npm-runtime.js";
import {
  assertDirectoryIdentity,
  assertDirectoryTree,
  assertGitControlEnvelope,
  assertImmutableLeaf,
  assertNpmCacheCapsule,
  createImmutableNpmConfigLeaves,
  pinDirectoryTree,
  pinGitControl,
  pinNpmCacheCapsule,
  type DirectoryTreeIdentity,
} from "./doc-improvement-cli/pinned-filesystem.js";

export {
  assertPinnedValidationRuntimePaths,
  assertValidationNpmRuntime,
  pinValidationRuntimeAncestorChain,
  resolveValidationNpmRuntime,
  validationNpmRuntimeTreeDigest,
};
export type { PinnedValidationRuntimePath, ValidationNpmRuntime };

const SAFE_BINARY_LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.patch$/u;
const MAX_PATCH_BYTES = 10 * 1024 * 1024;

const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";
/**
 * Config for every git command this module runs. Automatic gc and maintenance
 * are off, so a commit in the private `verification.git` cannot leave a
 * detached `git gc` writing into it while it is removed.
 */
export const DOC_IMPROVEMENT_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "pager.status=false",
  "-c",
  "pager.diff=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
] as const;
const SAFE_GIT_CONFIG = DOC_IMPROVEMENT_GIT_CONFIG;

export interface DocImprovementCliOptions {
  repository: string;
  campaignDirectory: string;
  evidenceDirectory: string;
  reviewerPolicyPath: string;
  npmCacheCapsule: string;
  allowWrite: boolean;
}

export interface DocImprovementCliResult {
  exitCode: 0;
  campaignId: string;
  testedCommit: string;
  evidencePath?: string;
}

export interface DocImprovementCliDependencies {
  loadCampaign?: (
    directory: string,
  ) => Promise<Omit<BuildDocImprovementEvidenceInput, "verification" | "reviewerPolicy">>;
  loadReviewerPolicy?: (path: string) => Promise<IaPlanReviewerPolicy>;
  verify?: (
    repository: string,
    declaration: BoundedDocImprovementDeclarationV1,
    patchBytes: Uint8Array,
    intendedPaths: string[],
    npmCacheCapsule: string,
  ) => Promise<DocImprovementVerificationEvidence>;
  publish?: (
    directory: AcceptanceEvidenceDirectory,
    value: ReturnType<typeof buildBoundedDocImprovementEvidence>,
  ) => Promise<DocImprovementEvidencePublication>;
  /** Adversarial test seam after publication but before terminal source/output checks. */
  afterPublication?: () => void | Promise<void>;
  log?: (message: string) => void;
}

export function parseDocImprovementCliOptions(args: string[]): DocImprovementCliOptions {
  const known = new Set([
    "--repo",
    "--campaign-dir",
    "--evidence-dir",
    "--reviewer-policy",
    "--npm-cache-capsule",
    "--allow-write",
  ]);
  const values = new Map<string, string>();
  let allowWrite = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!known.has(argument))
      throw new Error("Documentation improvement command has an unknown option.");
    if (argument === "--allow-write") {
      if (allowWrite) throw new Error("Documentation improvement command has a duplicate option.");
      allowWrite = true;
      continue;
    }
    if (values.has(argument))
      throw new Error("Documentation improvement command has a duplicate option.");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("Documentation improvement command has a missing option value.");
    }
    values.set(argument, value);
    index += 1;
  }
  const repository = values.get("--repo");
  const campaignDirectory = values.get("--campaign-dir");
  const evidenceDirectory = values.get("--evidence-dir");
  const reviewerPolicyPath = values.get("--reviewer-policy");
  const npmCacheCapsule = values.get("--npm-cache-capsule");
  if (
    !repository ||
    !campaignDirectory ||
    !evidenceDirectory ||
    !reviewerPolicyPath ||
    !npmCacheCapsule
  ) {
    throw new Error(
      "Documentation improvement requires --repo, --campaign-dir, --evidence-dir, --reviewer-policy, and --npm-cache-capsule.",
    );
  }
  return {
    repository: resolve(repository),
    campaignDirectory: resolve(campaignDirectory),
    evidenceDirectory: resolve(evidenceDirectory),
    reviewerPolicyPath: resolve(reviewerPolicyPath),
    npmCacheCapsule: resolve(npmCacheCapsule),
    allowWrite,
  };
}

export async function assertDocImprovementCliBoundaries(
  options: DocImprovementCliOptions,
): Promise<void> {
  const repository = await realpath(options.repository);
  const campaign = await realpath(options.campaignDirectory);
  const reviewerPolicy = await realpath(options.reviewerPolicyPath);
  assertOutside(repository, campaign, "--campaign-dir");
  assertOutside(repository, reviewerPolicy, "--reviewer-policy");
  const evidence = await canonicalCandidateWithoutCreating(options.evidenceDirectory);
  const npmCache = await realpath(options.npmCacheCapsule);
  assertOutside(repository, evidence, "--evidence-dir");
  assertOutside(repository, npmCache, "--npm-cache-capsule");
  assertSeparate(campaign, evidence, "--campaign-dir", "--evidence-dir");
  assertSeparate(campaign, npmCache, "--campaign-dir", "--npm-cache-capsule");
  assertSeparate(evidence, npmCache, "--evidence-dir", "--npm-cache-capsule");
}

async function canonicalCandidateWithoutCreating(path: string): Promise<string> {
  const requested = resolve(path);
  let existing = requested;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      const candidate = resolve(canonical, ...suffix.reverse());
      if (candidate !== requested) {
        throw new Error("Documentation improvement output path must not traverse symbolic links.");
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.push(basename(existing));
      existing = parent;
    }
  }
}

function assertOutside(repository: string, candidate: string, label: string): void {
  const relation = relative(repository, candidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error(`${label} must be outside the source repository.`);
  }
}

function assertSeparate(left: string, right: string, leftLabel: string, rightLabel: string): void {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  if (
    leftToRight === "" ||
    (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
  ) {
    throw new Error(`${leftLabel} and ${rightLabel} must be separate roots.`);
  }
}

export async function runDocImprovementCli(
  options: DocImprovementCliOptions,
  dependencies: DocImprovementCliDependencies = {},
): Promise<DocImprovementCliResult> {
  const load = dependencies.loadCampaign ?? loadPrivateCampaign;
  const loaded = await load(options.campaignDirectory);
  const reviewerPolicy = await (dependencies.loadReviewerPolicy ?? loadIaPlanReviewerPolicyFile)(
    options.reviewerPolicyPath,
  );
  await assertDocImprovementCliBoundaries(options);
  const publicationSourceIdentity = await pinSourceRepository(await realpath(options.repository));
  const preliminaryDeclaration = parseBoundedDocImprovementDeclaration(loaded.declaration);
  const authorizationPreflight = await preflightDocImprovementSource(
    options.repository,
    preliminaryDeclaration,
  );
  const authorized = authorizeBoundedDocImprovementCampaign({
    ...loaded,
    reviewerPolicy,
  });
  const declaration = authorized.declaration;
  const authorization = authorized.authorization;
  await revalidateDocImprovementSourcePreflight(authorizationPreflight, declaration);
  const verification = await (dependencies.verify ?? verifyDocImprovementCampaign)(
    options.repository,
    declaration,
    loaded.patchBytes,
    authorization.intendedPaths,
    options.npmCacheCapsule,
  );
  await assertSourceRepository(publicationSourceIdentity);
  const evidence = buildBoundedDocImprovementEvidence({
    ...loaded,
    verification,
    reviewerPolicy,
  });
  const json = serializeBoundedDocImprovementEvidence(evidence);
  const markdown = renderBoundedDocImprovementEvidenceMarkdown(evidence);
  const log = dependencies.log ?? console.log;
  log(markdown);
  let evidencePath: string | undefined;
  if (options.allowWrite) {
    const safeEvidenceDirectory = await prepareEvidenceOutputDirectory(
      options.evidenceDirectory,
      publicationSourceIdentity,
      await realpath(options.campaignDirectory),
      await realpath(options.reviewerPolicyPath),
    );
    const publication = await (dependencies.publish ?? publishDocImprovementEvidence)(
      safeEvidenceDirectory,
      evidence,
    );
    try {
      await dependencies.afterPublication?.();
      await assertPinnedSourceState(publicationSourceIdentity, declaration.testedCommit);
      await publication.assertStable();
      evidencePath = publication.path;
      await publication.close();
      log(`Sanitized evidence: ${evidencePath}`);
    } catch (error) {
      await publication.invalidate();
      throw error;
    }
  } else {
    log(json);
    log("Dry run: no evidence file was written; re-run with --allow-write after review.");
  }
  return {
    exitCode: 0,
    campaignId: evidence.campaign.id,
    testedCommit: evidence.campaign.testedCommit,
    ...(evidencePath ? { evidencePath } : {}),
  };
}

export interface DocImprovementEvidencePublication {
  readonly path: string;
  assertStable(): Promise<void>;
  invalidate(): Promise<void>;
  close(): Promise<void>;
}

async function prepareEvidenceOutputDirectory(
  requestedPath: string,
  source: SourceRepositoryIdentity,
  campaignRoot: string,
  reviewerPolicyPath: string,
): Promise<AcceptanceEvidenceDirectory> {
  const pinned = await preparePrivateOperatorRoot({
    requestedPath,
    repositoryRoot: source.path,
    label: "--evidence-dir",
  });
  await assertSourceRepository(source);
  await assertPrivateOperatorEvidenceDirectory(pinned);
  const outputRealpath = await realpath(pinned.path);
  if (outputRealpath !== pinned.path) {
    throw new Error("Documentation improvement evidence output identity changed.");
  }
  assertOutside(source.path, outputRealpath, "--evidence-dir");
  assertSeparate(campaignRoot, outputRealpath, "--campaign-dir", "--evidence-dir");
  assertOutside(outputRealpath, reviewerPolicyPath, "--reviewer-policy");
  return pinned;
}

async function loadPrivateCampaign(
  directoryPath: string,
): Promise<Omit<BuildDocImprovementEvidenceInput, "verification" | "reviewerPolicy">> {
  const directory = await pinPrivateOperatorEvidenceDirectory(directoryPath);
  const declarationLeaf = await readAcceptanceJsonLeaf(directory, "declaration.json");
  const declarationValue = parsePrivateJsonEvidence(declarationLeaf.bytes);
  const declaration = parseBoundedDocImprovementDeclaration(declarationValue);
  if (declaration.inputs.patch.file === "declaration.json") {
    throw new Error("Documentation improvement campaign has an invalid patch leaf.");
  }
  const analysis = await strictJsonLeaf(directory, declaration.inputs.analysisRecord.file);
  const authorization = await strictJsonLeaf(directory, declaration.inputs.authorization.file);
  const application = await strictJsonLeaf(directory, declaration.inputs.applicationRecord.file);
  const review = await strictJsonLeaf(directory, declaration.inputs.independentReview.file);
  const patchBytes = await readPrivateDocImprovementPatch(directory, declaration.inputs.patch.file);
  return {
    declaration,
    declarationBytes: declarationLeaf.bytes,
    analysisRecord: analysis.value,
    analysisRecordBytes: analysis.bytes,
    authorization: authorization.value,
    authorizationBytes: authorization.bytes,
    applicationRecord: application.value,
    applicationRecordBytes: application.bytes,
    patchBytes,
    independentReview: review.value,
    independentReviewBytes: review.bytes,
  };
}

/**
 * Load only the immutable declaration, completed audit, and signed grant that
 * are available before the write. This is the mutation preflight used by the
 * main workflow CLI; future application/patch/review leaves are not trusted or
 * required yet.
 */
export async function loadAuthorizedDocImprovementWriteTask(
  campaignDirectory: string,
  reviewerPolicyPath: string,
  repositoryPath: string,
  evaluatedAt: Date = new Date(),
): Promise<BoundedDocImprovementTaskInput> {
  const repository = await realpath(repositoryPath);
  const campaign = await realpath(campaignDirectory);
  const reviewerPolicy = await realpath(reviewerPolicyPath);
  assertOutside(repository, campaign, "--doc-improvement-campaign");
  assertOutside(repository, reviewerPolicy, "--reviewer-policy");
  const directory = await pinPrivateOperatorEvidenceDirectory(campaignDirectory);
  if (directory.path !== campaign || (await realpath(directory.path)) !== campaign) {
    throw new Error("Documentation improvement write campaign identity changed.");
  }
  await assertPrivateOperatorEvidenceDirectory(directory);
  const declarationLeaf = await readAcceptanceJsonLeaf(directory, "declaration.json");
  const declaration = parseBoundedDocImprovementDeclaration(
    parsePrivateJsonEvidence(declarationLeaf.bytes),
  );
  const sourcePreflight = await preflightDocImprovementSource(repository, declaration);
  const analysis = await strictJsonLeaf(directory, declaration.inputs.analysisRecord.file);
  const authorization = await strictJsonLeaf(directory, declaration.inputs.authorization.file);
  const policy = await loadIaPlanReviewerPolicyFile(reviewerPolicyPath);
  const input: AuthorizeBoundedDocImprovementWriteInput = {
    declaration,
    declarationBytes: declarationLeaf.bytes,
    analysisRecord: analysis.value,
    analysisRecordBytes: analysis.bytes,
    authorization: authorization.value,
    authorizationBytes: authorization.bytes,
    reviewerPolicy: policy,
    evaluatedAt: evaluatedAt.toISOString(),
  };
  const task = authorizeBoundedDocImprovementWrite(input);
  await revalidateDocImprovementSourcePreflight(sourcePreflight, declaration);
  return task;
}

async function strictJsonLeaf(
  directory: AcceptanceEvidenceDirectory,
  file: string,
): Promise<{ bytes: Buffer; value: unknown }> {
  const leaf = await readPrivateJsonEvidenceLeaf(directory, file);
  return { bytes: leaf.bytes, value: leaf.value };
}

/** Read an owner-only patch without following links or accepting identity changes. */
export async function readPrivateDocImprovementPatch(
  directory: AcceptanceEvidenceDirectory,
  file: string,
  options: { afterRead?: () => void | Promise<void> } = {},
): Promise<Buffer> {
  if (file !== basename(file) || !SAFE_BINARY_LEAF.test(file)) {
    throw new Error("Documentation improvement campaign has an unsafe patch leaf.");
  }
  const path = join(directory.path, file);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertPrivateOperatorEvidenceDirectory(directory);
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== directory.uid ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size < 1 ||
      before.size > MAX_PATCH_BYTES
    ) {
      throw new Error("unsafe");
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertPrivateOperatorEvidenceDirectory(directory);
    const descriptor = await handle.stat();
    if (!stablePrivatePatchStat(descriptor, before, directory.uid)) {
      throw new Error("changed");
    }
    const bytes = await handle.readFile();
    await options.afterRead?.();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      bytes.byteLength !== before.size ||
      !stablePrivatePatchStat(after, before, directory.uid) ||
      !stablePrivatePatchStat(pathAfter, before, directory.uid)
    ) {
      throw new Error("changed");
    }
    await assertPrivateOperatorEvidenceDirectory(directory);
    return bytes;
  } catch {
    throw new Error("Documentation improvement campaign patch could not be read safely.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function stablePrivatePatchStat(
  actual: Awaited<ReturnType<typeof lstat>>,
  expected: Awaited<ReturnType<typeof lstat>>,
  uid: number,
): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.uid === uid &&
    actual.uid === expected.uid &&
    actual.nlink === 1 &&
    actual.nlink === expected.nlink &&
    actual.mode === expected.mode &&
    (Number(actual.mode) & 0o7777) === 0o600 &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.ctimeMs === expected.ctimeMs
  );
}

export async function verifyDocImprovementCampaign(
  repository: string,
  declaration: BoundedDocImprovementDeclarationV1,
  patchBytes: Uint8Array,
  intendedPaths: string[],
  npmCacheCapsulePath: string,
  dependencies: DocImprovementVerificationDependencies = {},
): Promise<DocImprovementVerificationEvidence> {
  // Capture caller-controlled bytes before the first await. Every Git apply
  // consumes a fresh copy of this held value through stdin; no mutable pathname
  // is ever exposed to a child process.
  const heldPatch = Buffer.from(patchBytes);
  const heldPatchSha256 = sha256(heldPatch);
  if (
    heldPatch.byteLength !== declaration.inputs.patch.byteLength ||
    heldPatchSha256 !== declaration.inputs.patch.sha256
  ) {
    throw new Error("Documentation improvement patch no longer matches its declaration.");
  }
  await dependencies.afterPatchHeld?.();
  const canonicalRepository = await realpath(repository);
  if (sha256(Buffer.from(canonicalRepository)) !== declaration.repositoryIdentitySha256) {
    throw new Error("Documentation improvement repository identity does not match approval.");
  }
  const npmCache = await pinNpmCacheCapsule(npmCacheCapsulePath, declaration.campaignId);
  const sourcePreflight = await preflightDocImprovementSource(canonicalRepository, declaration);
  const sourceIdentity = sourcePreflight.identity;
  const before = sourcePreflight.state;
  await revalidateDocImprovementSourcePreflight(sourcePreflight, declaration);
  const workspace = await prepareRepositoryWorkspace(canonicalRepository, declaration.testedCommit);
  await revalidateDocImprovementSourcePreflight(sourcePreflight, declaration);
  const releaseWorkspace = await acquireRepositoryWorkspaceLease(workspace);
  const validationRoot = await mkdtemp(join(tmpdir(), "docsfab-doc-improvement-validation-"));
  const hostGitRoot = await mkdtemp(join(tmpdir(), "docsfab-doc-improvement-host-git-"));
  const deniedRoot = await mkdtemp(join(tmpdir(), "docsfab-doc-improvement-denied-"));
  try {
    const npmConfigs = await createImmutableNpmConfigLeaves(validationRoot);
    await assertNpmCacheCapsule(npmCache);
    await verifyActiveRepositoryWorkspace(workspace);
    const application = await applyHeldPatchAndBindTree(
      workspace.path,
      hostGitRoot,
      heldPatch,
      intendedPaths,
    );
    await verifyActiveRepositoryWorkspace(workspace);
    await dependencies.afterApply?.(workspace.path);
    if ((await captureAppliedTree(application)) !== application.expectedTree) {
      throw new Error("Documentation improvement applied tree changed before validation.");
    }
    for (const entry of application.entries) {
      if (entry.status !== "A" && entry.status !== "M") {
        throw new Error("Documentation improvement patch has an unsupported file change.");
      }
      const stat = await lstat(join(workspace.path, entry.path));
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) !== 0) {
        throw new Error("Documentation improvement patch has an unsupported file type.");
      }
    }
    await verifyActiveRepositoryWorkspace(workspace);
    const npmRuntime = await resolveValidationNpmRuntime();
    await dependencies.afterNpmRuntimePinned?.({
      cliPath: npmRuntime.cliPath,
      readOnlyDirectories: npmRuntime.readOnlyDirectories,
    });
    await assertValidationNpmRuntime(npmRuntime);
    const isolation = await requireDocImprovementValidationIsolation({
      workspacePath: workspace.path,
      scratchPath: validationRoot,
      deniedReadPaths: [
        join(canonicalRepository, declaration.gap.evidence[0]!.path),
        application.anchorConfigPath,
      ],
      deniedWritePaths: [join(deniedRoot, "forbidden-write")],
      readOnlyDirectories: [npmCache.path],
      readOnlyFiles: [npmConfigs.user.path, npmConfigs.global.path],
      runtimeReadDirectories: npmRuntime.readOnlyDirectories,
    });
    await assertValidationNpmRuntime(npmRuntime);
    await assertNpmCacheCapsule(npmCache);
    await assertImmutableLeaf(npmConfigs.user);
    await assertImmutableLeaf(npmConfigs.global);
    const environment = validationEnvironment(
      validationRoot,
      npmCache.path,
      npmConfigs.user.path,
      npmConfigs.global.path,
    );
    const npmCommand = [npmRuntime.cliPath, "ci", "--offline", "--ignore-scripts"];
    const install = await runIsolated(
      isolation.commandPrefix,
      workspace.path,
      environment,
      process.execPath,
      npmCommand,
    );
    await assertValidationNpmRuntime(npmRuntime);
    const check =
      install.exitCode === 0
        ? await runIsolated(
            isolation.commandPrefix,
            workspace.path,
            environment,
            process.execPath,
            [npmRuntime.cliPath, "run", "check"],
          )
        : emptyFailure();
    await assertValidationNpmRuntime(npmRuntime);
    const build =
      check.exitCode === 0
        ? await runIsolated(
            isolation.commandPrefix,
            workspace.path,
            environment,
            process.execPath,
            [npmRuntime.cliPath, "run", "build"],
          )
        : emptyFailure();
    await assertValidationNpmRuntime(npmRuntime);
    if (install.exitCode !== 0 || check.exitCode !== 0 || build.exitCode !== 0) {
      throw new Error("Documentation improvement repository validation failed closed.");
    }
    await dependencies.afterValidation?.(workspace.path);
    await assertNpmCacheCapsule(npmCache);
    await assertImmutableLeaf(npmConfigs.user);
    await assertImmutableLeaf(npmConfigs.global);
    await verifyActiveRepositoryWorkspace(workspace);
    const finalTree = await captureAppliedTree(application);
    if (finalTree !== application.expectedTree) {
      throw new Error("Documentation improvement validation changed the authorized applied tree.");
    }
    await revalidateDocImprovementSourcePreflight(sourcePreflight, declaration);
    const after = await sourceState(canonicalRepository);
    await assertSourceRepository(sourceIdentity);
    if (
      after.snapshotSha256 !== before.snapshotSha256 ||
      after.revision !== before.revision ||
      after.status !== before.status
    ) {
      throw new Error("Documentation improvement source checkout changed during verification.");
    }
    return {
      npmCache: { contentSha256: npmCache.contentSha256 },
      source: {
        revisionBefore: before.revision,
        revisionAfter: after.revision,
        statusBefore: before.status,
        statusAfter: after.status,
      },
      patchApplyCheck: commandEvidence(
        "git-apply-check",
        ["git", "apply", "--check"],
        application.applyCheck,
      ),
      patchApply: commandEvidence("git-apply", ["git", "apply"], application.apply),
      appliedPatch: {
        sha256: heldPatchSha256,
        byteLength: heldPatch.byteLength,
        lineCount: patchLineCount(heldPatch),
        changedPaths: application.entries.map((entry) => entry.path).sort(),
      },
      dependencyInstall: commandEvidence(
        "npm-ci",
        ["npm", "ci", "--offline", "--ignore-scripts"],
        install,
      ),
      validation: [
        commandEvidence("npm-check", ["npm", "run", "check"], check),
        commandEvidence("npm-build", ["npm", "run", "build"], build),
      ],
    };
  } finally {
    releaseWorkspace();
    await workspace.dispose();
    await rm(validationRoot, { recursive: true, force: true });
    await rm(hostGitRoot, { recursive: true, force: true });
    await rm(deniedRoot, { recursive: true, force: true });
  }
}

export interface DocImprovementValidationIsolation {
  commandPrefix: string[];
  lifecycle: "pid-namespace";
}

export interface DocImprovementValidationIsolationRequest {
  workspacePath: string;
  scratchPath: string;
  deniedReadPaths: string[];
  deniedWritePaths: string[];
  readOnlyDirectories: string[];
  readOnlyFiles: string[];
  runtimeReadDirectories?: string[];
}

export interface DocImprovementVerificationDependencies {
  afterPatchHeld?: () => void | Promise<void>;
  afterApply?: (workspacePath: string) => void | Promise<void>;
  afterValidation?: (workspacePath: string) => void | Promise<void>;
  afterNpmRuntimePinned?: (runtime: {
    cliPath: string;
    readOnlyDirectories: readonly string[];
  }) => void | Promise<void>;
}

interface AppliedTreeSession {
  workspacePath: string;
  gitRootPath: string;
  gitDirectory: string;
  anchorIdentity: DirectoryTreeIdentity;
  anchorConfigPath: string;
  expectedTree: string;
  entries: Array<{ status: string; path: string }>;
  applyCheck: RawCommandResult;
  apply: RawCommandResult;
}

async function applyHeldPatchAndBindTree(
  workspacePath: string,
  hostGitRoot: string,
  heldPatch: Buffer,
  intendedPaths: readonly string[],
): Promise<AppliedTreeSession> {
  const canonicalHostGitRoot = await realpath(hostGitRoot);
  const gitDirectory = join(canonicalHostGitRoot, "verification.git");
  await mkdir(gitDirectory, { mode: 0o700 });
  const run = (args: readonly string[], stdin?: Uint8Array) =>
    runRaw(
      GIT_BINARY,
      [...SAFE_GIT_CONFIG, `--git-dir=${gitDirectory}`, `--work-tree=${workspacePath}`, ...args],
      workspacePath,
      credentialFreeGitEnvironment(),
      stdin,
    );
  await requireSuccess(
    await run(["init", "--quiet"]),
    "could not initialize the clean patch index",
  );
  await requireSuccess(
    await run(["config", "user.name", "DocsFab"]),
    "could not configure patch index",
  );
  await requireSuccess(
    await run(["config", "user.email", "docsfab@example.invalid"]),
    "could not configure patch index",
  );
  await requireSuccess(
    await run(["config", "commit.gpgsign", "false"]),
    "could not configure patch index",
  );
  await requireSuccess(
    await run(["add", "--all", "--force", "--", "."]),
    "could not capture clean export",
  );
  await requireSuccess(
    await run(["commit", "--quiet", "--allow-empty", "-m", "baseline"]),
    "could not commit clean export",
  );

  const expectedCheck = await run(["apply", "--cached", "--check", "-"], heldPatch);
  await requireSuccess(expectedCheck, "patch failed its held-byte index preflight");
  await requireSuccess(
    await run(["apply", "--cached", "-"], heldPatch),
    "patch failed its held-byte expected-tree application",
  );
  const expectedTree = text(
    await requireSuccess(await run(["write-tree"]), "could not bind expected patch tree"),
  ).trim();
  const entries = parseNameStatus(
    text(
      await requireSuccess(
        await run([
          "diff",
          "--cached",
          "--name-status",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          "--",
        ]),
        "could not inspect expected patch paths",
      ),
    ),
  );
  const actualPaths = entries.map((entry) => entry.path).sort();
  const approvedPaths = [...intendedPaths].sort();
  if (
    actualPaths.length === 0 ||
    actualPaths.length !== approvedPaths.length ||
    actualPaths.some((path, index) => path !== approvedPaths[index])
  ) {
    throw new Error("Documentation improvement patch exceeds its approved paths.");
  }
  await requireSuccess(
    await run(["reset", "--mixed", "--quiet", "HEAD"]),
    "could not reset patch index",
  );
  const applyCheck = await run(["apply", "--check", "-"], heldPatch);
  await requireSuccess(applyCheck, "patch failed clean-export application preflight");
  const apply = await run(["apply", "-"], heldPatch);
  await requireSuccess(apply, "patch failed clean-export application");
  await requireSuccess(await run(["add", "--all", "--", "."]), "could not capture applied tree");
  const actualTree = text(
    await requireSuccess(await run(["write-tree"]), "could not bind applied tree"),
  ).trim();
  if (actualTree !== expectedTree) {
    throw new Error("Documentation improvement applied tree does not match the held patch.");
  }
  const anchorIdentity = await pinDirectoryTree(canonicalHostGitRoot, 0o700);
  return {
    workspacePath,
    gitRootPath: canonicalHostGitRoot,
    gitDirectory,
    anchorIdentity,
    anchorConfigPath: join(gitDirectory, "config"),
    expectedTree,
    entries,
    applyCheck,
    apply,
  };
}

async function captureAppliedTree(session: AppliedTreeSession): Promise<string> {
  await assertDirectoryTree(session.anchorIdentity);
  const requestedPostflightRoot = await mkdtemp(
    join(tmpdir(), "docsfab-doc-improvement-postflight-git-"),
  );
  const postflightRoot = await realpath(requestedPostflightRoot);
  const postflightGit = join(postflightRoot, "verification.git");
  try {
    await cp(session.gitDirectory, postflightGit, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    await assertDirectoryTree(session.anchorIdentity);
    const copiedRoot = await pinDirectoryTree(postflightRoot, 0o700);
    const beforeAdd = await pinGitControl(postflightRoot, postflightGit);
    const result = await runRaw(
      GIT_BINARY,
      [
        ...SAFE_GIT_CONFIG,
        `--git-dir=${postflightGit}`,
        `--work-tree=${session.workspacePath}`,
        "add",
        "--all",
        "--",
        ".",
      ],
      session.workspacePath,
      credentialFreeGitEnvironment(),
    );
    await requireSuccess(result, "could not recapture the post-validation tree");
    await assertGitControlEnvelope(beforeAdd, { allowIndex: true, allowObjects: true });
    const afterAdd = await pinGitControl(postflightRoot, postflightGit);
    const treeResult = await requireSuccess(
      await runRaw(
        GIT_BINARY,
        [
          ...SAFE_GIT_CONFIG,
          `--git-dir=${postflightGit}`,
          `--work-tree=${session.workspacePath}`,
          "write-tree",
        ],
        session.workspacePath,
        credentialFreeGitEnvironment(),
      ),
      "could not bind the post-validation tree",
    );
    await assertGitControlEnvelope(afterAdd, { allowIndex: true, allowObjects: true });
    await pinGitControl(postflightRoot, postflightGit);
    await assertDirectoryIdentity(copiedRoot);
    await assertDirectoryTree(session.anchorIdentity);
    return text(treeResult).trim();
  } finally {
    await rm(postflightRoot, { recursive: true, force: true });
  }
}

function parseNameStatus(value: string): Array<{ status: string; path: string }> {
  const tokens = value.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  if (tokens.length % 2 !== 0) {
    throw new Error("Documentation improvement Git path evidence is malformed.");
  }
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const path = tokens[index + 1];
    if (!status || !path || status.length !== 1) {
      throw new Error("Documentation improvement Git path evidence is malformed.");
    }
    entries.push({ status, path });
  }
  return entries;
}

async function requireSuccess(result: RawCommandResult, reason: string): Promise<RawCommandResult> {
  if (result.exitCode !== 0) throw new Error(`Documentation improvement ${reason}.`);
  return result;
}

function patchLineCount(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return lines + (bytes.at(-1) === 0x0a ? 0 : 1);
}

export async function assertDocImprovementSourceState(
  repository: string,
  revision: string,
): Promise<void> {
  const canonical = await realpath(repository);
  const identity = await pinSourceRepository(canonical);
  await assertPinnedSourceState(identity, revision);
}

async function assertPinnedSourceState(
  identity: SourceRepositoryIdentity,
  revision: string,
): Promise<void> {
  await assertSourceRepository(identity);
  const state = await sourceState(identity.path);
  await assertSourceRepository(identity);
  if (
    state.revision !== revision ||
    state.status !== "" ||
    state.snapshotSha256 !== identity.snapshotSha256
  ) {
    throw new Error("Documentation improvement source checkout changed after publication.");
  }
}

interface SourceRepositoryIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  ctimeMs: number;
  snapshotSha256: string;
}

interface DocImprovementSourcePreflight {
  identity: SourceRepositoryIdentity;
  state: Awaited<ReturnType<typeof sourceState>>;
  evidence: Array<{ path: string; sha256: string }>;
}

async function preflightDocImprovementSource(
  repository: string,
  declaration: BoundedDocImprovementDeclarationV1,
): Promise<DocImprovementSourcePreflight> {
  const canonical = await realpath(repository);
  const identity = await pinSourceRepository(canonical);
  await assertSafeSourceGitConfiguration(identity);
  const state = await sourceState(canonical, identity);
  if (state.revision !== declaration.testedCommit || state.status !== "") {
    throw new Error(
      "Documentation improvement source checkout is not clean at the tested revision.",
    );
  }
  const evidence: Array<{ path: string; sha256: string }> = [];
  for (const item of declaration.gap.evidence) {
    const blob = await runSourceGit(identity, ["show", `${declaration.testedCommit}:${item.path}`]);
    const digest = sha256(blob.stdout);
    if (blob.exitCode !== 0 || digest !== item.sha256) {
      throw new Error("Documentation improvement gap evidence does not match the tested revision.");
    }
    evidence.push({ path: item.path, sha256: digest });
  }
  const after = await sourceState(canonical, identity);
  if (
    after.revision !== state.revision ||
    after.status !== state.status ||
    after.snapshotSha256 !== state.snapshotSha256
  ) {
    throw new Error("Documentation improvement source changed during authorization preflight.");
  }
  return { identity, state, evidence };
}

async function revalidateDocImprovementSourcePreflight(
  preflight: DocImprovementSourcePreflight,
  declaration: BoundedDocImprovementDeclarationV1,
): Promise<void> {
  await assertSourceRepository(preflight.identity);
  await assertSafeSourceGitConfiguration(preflight.identity);
  const state = await sourceState(preflight.identity.path, preflight.identity);
  if (
    state.revision !== declaration.testedCommit ||
    state.status !== "" ||
    state.snapshotSha256 !== preflight.state.snapshotSha256
  ) {
    throw new Error("Documentation improvement source authorization preflight became stale.");
  }
  for (const expected of preflight.evidence) {
    const blob = await runSourceGit(preflight.identity, [
      "show",
      `${declaration.testedCommit}:${expected.path}`,
    ]);
    if (blob.exitCode !== 0 || sha256(blob.stdout) !== expected.sha256) {
      throw new Error(
        "Documentation improvement gap evidence changed after authorization preflight.",
      );
    }
  }
}

async function pinSourceRepository(path: string): Promise<SourceRepositoryIdentity> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error("Documentation improvement source repository is not stable.");
  }
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    ctimeMs: stat.ctimeMs,
    snapshotSha256: await sourceTreeSnapshot(path),
  };
}

async function assertSourceRepository(expected: SourceRepositoryIdentity): Promise<void> {
  const stat = await lstat(expected.path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    stat.uid !== expected.uid ||
    stat.mode !== expected.mode ||
    stat.nlink !== expected.nlink ||
    stat.ctimeMs !== expected.ctimeMs ||
    (await realpath(expected.path)) !== expected.path
  ) {
    throw new Error("Documentation improvement source repository identity changed.");
  }
}

async function sourceTreeSnapshot(repository: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stat = await lstat(absolutePath);
      const kind = stat.isDirectory()
        ? "d"
        : stat.isFile()
          ? "f"
          : stat.isSymbolicLink()
            ? "l"
            : "o";
      hash.update(
        JSON.stringify([
          relativePath,
          kind,
          stat.dev,
          stat.ino,
          stat.uid,
          stat.mode,
          stat.nlink,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
        ]),
      );
      hash.update("\n");
      if (stat.isDirectory()) await visit(absolutePath, relativePath);
    }
  };
  await visit(repository, "");
  return hash.digest("hex");
}

async function sourceState(
  repository: string,
  pinned?: SourceRepositoryIdentity,
): Promise<{
  revision: string;
  status: string;
  snapshotSha256: string;
}> {
  const identity = pinned ?? (await pinSourceRepository(repository));
  const revisionResult = await runSourceGit(identity, ["rev-parse", "HEAD"]);
  const statusResult = await runSourceGit(identity, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (revisionResult.exitCode !== 0 || statusResult.exitCode !== 0) {
    throw new Error("Documentation improvement source state could not be inspected.");
  }
  return {
    revision: revisionResult.stdout.toString("utf8").trim(),
    status: statusResult.stdout.toString("utf8").trim(),
    snapshotSha256: await sourceTreeSnapshot(repository),
  };
}

async function assertSafeSourceGitConfiguration(identity: SourceRepositoryIdentity): Promise<void> {
  await assertSourceRepository(identity);
  const result = await runRaw(
    GIT_BINARY,
    [
      ...SAFE_GIT_CONFIG,
      "-C",
      identity.path,
      "config",
      "--local",
      "--no-includes",
      "--null",
      "--list",
    ],
    identity.path,
    credentialFreeGitEnvironment(),
  );
  if (result.exitCode !== 0) {
    throw new Error("Documentation improvement source Git configuration could not be inspected.");
  }
  for (const entry of text(result).split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    const key = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
    if (
      /^(?:include\.|includeif\.|core\.(?:hookspath|fsmonitor|attributesfile|excludesfile)|diff\.external|diff\..*\.(?:command|textconv)|filter\..*\.(?:clean|smudge|process|required)|tar\..*\.command)$/u.test(
        key,
      )
    ) {
      throw new Error(
        "Documentation improvement source has executable or included Git configuration.",
      );
    }
  }
  await assertSourceRepository(identity);
}

async function runSourceGit(
  identity: SourceRepositoryIdentity,
  args: readonly string[],
): Promise<RawCommandResult> {
  await assertSafeSourceGitConfiguration(identity);
  const result = await runRaw(
    GIT_BINARY,
    [...SAFE_GIT_CONFIG, "-C", identity.path, ...args],
    identity.path,
    credentialFreeGitEnvironment(),
  );
  await assertSourceRepository(identity);
  await assertSafeSourceGitConfiguration(identity);
  return result;
}

function credentialFreeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

function validationEnvironment(
  scratchPath: string,
  npmCachePath: string,
  userConfigPath: string,
  globalConfigPath: string,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: scratchPath,
    TMPDIR: scratchPath,
    LANG: "C",
    LC_ALL: "C",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
    npm_config_cache: npmCachePath,
    npm_config_userconfig: userConfigPath,
    npm_config_globalconfig: globalConfigPath,
    npm_config_logs_dir: scratchPath,
  };
}

export async function requireDocImprovementValidationIsolation(
  request: DocImprovementValidationIsolationRequest,
): Promise<DocImprovementValidationIsolation> {
  if (process.platform !== "linux") {
    throw new Error(
      "Documentation improvement validation requires a kernel PID namespace; this platform cannot contain escaped descendants.",
    );
  }
  await assertRootOwnedSystemRuntimeEnvelope();
  const runtimeReadDirectories = request.runtimeReadDirectories ?? [];
  if (runtimeReadDirectories.length > 8) {
    throw new Error(
      "Documentation improvement validation requires proven read/write/network and PID-lifecycle isolation.",
    );
  }
  for (const runtimeDirectory of runtimeReadDirectories) {
    try {
      const canonical = await realpath(runtimeDirectory);
      const metadata = await stat(canonical);
      if (
        !isAbsolute(runtimeDirectory) ||
        canonical !== runtimeDirectory ||
        !metadata.isDirectory() ||
        pathsOverlap(canonical, request.workspacePath) ||
        pathsOverlap(canonical, request.scratchPath) ||
        [...request.deniedReadPaths, ...request.deniedWritePaths].some((deniedPath) =>
          pathsOverlap(canonical, deniedPath),
        )
      ) {
        throw new Error("invalid runtime directory");
      }
    } catch {
      throw new Error(
        "Documentation improvement validation requires proven read/write/network and PID-lifecycle isolation.",
      );
    }
  }
  let hostNetworkNamespaceIdentity: string;
  try {
    const hostNetworkNamespace = await stat("/proc/self/ns/net");
    hostNetworkNamespaceIdentity = `${hostNetworkNamespace.dev}:${hostNetworkNamespace.ino}`;
  } catch {
    throw new Error(
      "Documentation improvement validation requires proven read/write/network and PID-lifecycle isolation.",
    );
  }
  for (const commandPrefix of docImprovementIsolationCandidates(request)) {
    const marker = join(request.scratchPath, "lifecycle-probe-marker");
    await rm(marker, { force: true });
    const escapedChildScript = [
      "const fs=require('node:fs');",
      "setTimeout(()=>{try{fs.writeFileSync(process.argv[1],'escaped')}catch{}},250);",
      "setTimeout(()=>process.exit(0),500);",
    ].join("");
    const script = [
      "const fs=require('node:fs'),cp=require('node:child_process');",
      "const [deniedReadsRaw,deniedWritesRaw,readOnlyRaw,allowedWrite,marker,hostNetNs]=process.argv.slice(1);",
      "const deniedReads=JSON.parse(deniedReadsRaw),deniedWrites=JSON.parse(deniedWritesRaw),readOnly=JSON.parse(readOnlyRaw);",
      "const failures=[];",
      "for(const path of deniedReads){try{fs.readFileSync(path);failures.push('denied-read')}catch{}}",
      "for(const path of deniedWrites){try{fs.writeFileSync(path,'x');failures.push('denied-write')}catch{}}",
      "for(const path of readOnly){let s;try{s=fs.statSync(path);if(s.isDirectory())fs.readdirSync(path);else fs.readFileSync(path);}catch{failures.push('readonly-read');continue}try{if(s.isDirectory())fs.writeFileSync(path+'/.docsfab-write-probe','x');else fs.appendFileSync(path,'x');failures.push('readonly-write')}catch{}}",
      "try{fs.writeFileSync(allowedWrite,'x')}catch{failures.push('allowed-write')}",
      "try{const ns=fs.statSync('/proc/self/ns/net');if(`${ns.dev}:${ns.ino}`===hostNetNs)failures.push('network-namespace')}catch{failures.push('network-namespace')}",
      `const child=cp.spawn(process.execPath,['-e',${JSON.stringify(escapedChildScript)},marker],{detached:true,stdio:'ignore'});child.unref();`,
      "setTimeout(()=>{if(failures.length)process.stderr.write(failures.sort().join(','));process.exit(failures.length?1:0)},50);",
    ].join("");
    const probe = await runRaw(
      commandPrefix[0]!,
      [
        ...commandPrefix.slice(1),
        process.execPath,
        "-e",
        script,
        JSON.stringify(request.deniedReadPaths),
        JSON.stringify(request.deniedWritePaths),
        JSON.stringify([...request.readOnlyDirectories, ...request.readOnlyFiles]),
        join(request.scratchPath, "allowed-probe"),
        marker,
        hostNetworkNamespaceIdentity,
      ],
      request.workspacePath,
      {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: request.scratchPath,
        TMPDIR: request.scratchPath,
        LANG: "C",
        LC_ALL: "C",
      },
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
    let escaped = false;
    try {
      await lstat(marker);
      escaped = true;
    } catch {
      // Expected: PID namespace teardown removed the escaped descendant.
    }
    if (probe.exitCode === 0 && !escaped) {
      return { commandPrefix, lifecycle: "pid-namespace" };
    }
  }
  throw new Error(
    "Documentation improvement validation requires proven read/write/network and PID-lifecycle isolation.",
  );
}

async function assertRootOwnedSystemRuntimeEnvelope(): Promise<void> {
  for (const path of [
    "/usr",
    "/usr/local",
    "/bin",
    "/lib",
    "/lib64",
    "/etc/ssl",
    "/etc/ld.so.cache",
  ]) {
    try {
      const metadata = await stat(path);
      if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
        throw new Error("unsafe system runtime");
      }
      await assertNotEffectivelyWritable(path);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) continue;
      throw new Error(
        "Documentation improvement validation requires a root-owned, non-writable system runtime.",
      );
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    leftToRight === "" ||
    (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
  );
}

export function docImprovementIsolationCandidates(
  request: DocImprovementValidationIsolationRequest,
  platform: NodeJS.Platform = process.platform,
  executable: string = process.execPath,
): string[][] {
  if (platform !== "linux") return [];
  const optionalRuntimeReadDirectories = [
    "/usr",
    "/usr/local",
    "/bin",
    "/lib",
    "/lib64",
    "/etc/ssl",
  ];
  const optionalRuntimeReadFiles = ["/etc/ld.so.cache"];
  const requiredRuntimeReadDirectories = request.runtimeReadDirectories ?? [];
  const optionalReadBinds = [
    ...new Set([...optionalRuntimeReadDirectories, ...optionalRuntimeReadFiles]),
  ].flatMap((path) => ["--ro-bind-try", path, path]);
  const requiredReadBinds = [...new Set([...requiredRuntimeReadDirectories, executable])].flatMap(
    (path) => ["--ro-bind", path, path],
  );
  const writableBinds = [request.workspacePath, request.scratchPath].flatMap((path) => [
    "--bind",
    path,
    path,
  ]);
  const exactReadOnlyBinds = [...request.readOnlyDirectories, ...request.readOnlyFiles].flatMap(
    (path) => ["--ro-bind", path, path],
  );
  // Bubblewrap processes options in order. The tmpfs root has no mount targets,
  // so create every directory target and every file target's parent first.
  const mountDirectories = [
    ...new Set(
      [
        ...optionalRuntimeReadDirectories,
        ...requiredRuntimeReadDirectories,
        request.workspacePath,
        request.scratchPath,
        ...request.readOnlyDirectories,
        ...optionalRuntimeReadFiles.map((path) => dirname(path)),
        dirname(executable),
        ...request.readOnlyFiles.map((path) => dirname(path)),
      ].flatMap((path) => {
        const values: string[] = [path];
        let parent = dirname(path);
        while (parent !== "/") {
          values.push(parent);
          parent = dirname(parent);
        }
        return values;
      }),
    ),
  ]
    .sort((left, right) => left.length - right.length)
    .flatMap((path) => ["--dir", path]);
  return [
    [
      "/usr/bin/bwrap",
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--new-session",
      "--tmpfs",
      "/",
      ...mountDirectories,
      ...optionalReadBinds,
      ...requiredReadBinds,
      ...writableBinds,
      ...exactReadOnlyBinds,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--",
    ],
  ];
}

async function runIsolated(
  prefix: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  file: string,
  args: string[],
): Promise<RawCommandResult> {
  const result = await runRaw(prefix[0]!, [...prefix.slice(1), file, ...args], cwd, environment);
  return result;
}

export async function publishDocImprovementEvidence(
  directory: AcceptanceEvidenceDirectory,
  value: ReturnType<typeof buildBoundedDocImprovementEvidence>,
): Promise<DocImprovementEvidencePublication> {
  return openAcceptanceJsonExclusive(directory, "bounded-doc-improvement.json", value);
}

runCliEntrypoint(import.meta.url, () =>
  runDocImprovementCli(parseDocImprovementCliOptions(process.argv.slice(2))),
);
