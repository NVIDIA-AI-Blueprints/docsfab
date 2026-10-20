#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { internalContentPath } from "./config/internal-content.js";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

import {
  readAcceptanceJsonLeaf,
  readAcceptanceJsonLeaves,
  type AcceptanceEvidenceDirectory,
} from "./acceptance-evidence.js";
import {
  assertPrivateOperatorEvidenceDirectory,
  pinPrivateOperatorEvidenceDirectory,
} from "./operator/private-state.js";
import {
  buildMvpScorecard,
  parseScorecardCampaignDeclaration,
  ScorecardInputError,
  type MvpScorecardV1,
  type ScorecardDependencyEvidence,
  type ScorecardVerificationEvidence,
} from "./scorecard.js";
import {
  assertSanitizedScorecardArtifacts,
  renderMvpScorecardMarkdown,
  serializeMvpScorecard,
} from "./scorecard-render.js";
import { runCliEntrypoint } from "./operator/cli-entrypoint.js";
import { parsePrivateJsonEvidence } from "./operator/json-evidence.js";
import { sha256 } from "./content-ir/canonical.js";

const execFile = promisify(execFileCallback);
const modulePath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(modulePath), "..");
const fixturePath = join(
  projectRoot,
  "test/fixtures/runtime-evaluation/fixtures/turn-governance-live-readiness.json",
);
const dependencyScriptPath = join(projectRoot, "scripts/check-dependency-exceptions.mjs");
const packageJsonPath = join(projectRoot, "package.json");
const packageLockPath = join(projectRoot, "package-lock.json");

export interface ScorecardCliOptions {
  stateDirectory: string;
  acceptanceDirectory: string;
  campaignDirectory: string;
  allowWrite: boolean;
}

export interface ScorecardCliResult {
  exitCode: number;
  decision: MvpScorecardV1["decision"];
  testedCommit: string;
  outputDirectory?: string;
}

export interface ScorecardCliDependencies {
  runLocal(command: string, args: string[]): Promise<{ exitCode: number; stdout: string }>;
  publish(outputDirectory: string, json: string, markdown: string): Promise<void>;
  log(message: string): void;
  now(): Date;
}

class ScorecardCliError extends Error {
  public constructor(public readonly code: string) {
    super(`MVP scorecard command failed (${code}).`);
    this.name = "ScorecardCliError";
  }
}

export function parseScorecardCliOptions(args: string[]): ScorecardCliOptions {
  const values = new Map<string, string>();
  let allowWrite = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--allow-write") {
      if (allowWrite) throw new ScorecardCliError("duplicate-option");
      allowWrite = true;
      continue;
    }
    if (!["--state-dir", "--acceptance-dir", "--campaign-dir"].includes(argument)) {
      throw new ScorecardCliError("unknown-option");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) {
      throw new ScorecardCliError("invalid-option");
    }
    values.set(argument, value);
    index += 1;
  }
  const stateDirectory = values.get("--state-dir");
  const acceptanceDirectory = values.get("--acceptance-dir");
  const campaignDirectory = values.get("--campaign-dir");
  if (!stateDirectory || !acceptanceDirectory || !campaignDirectory) {
    throw new ScorecardCliError("missing-option");
  }
  return {
    stateDirectory: resolve(stateDirectory),
    acceptanceDirectory: resolve(acceptanceDirectory),
    campaignDirectory: resolve(campaignDirectory),
    allowWrite,
  };
}

export async function runScorecardCli(
  args: string[],
  dependencies: Partial<ScorecardCliDependencies> = {},
): Promise<ScorecardCliResult> {
  const options = parseScorecardCliOptions(args);
  const runLocal = dependencies.runLocal ?? defaultRunLocal;
  const publish = dependencies.publish ?? publishScorecardArtifacts;
  const log = dependencies.log ?? console.log;

  const stateParent = await pinDirectoryIdentity(
    dirname(options.stateDirectory),
    "evidence-parent",
  );
  const state = await pinPrivateOperatorEvidenceDirectory(options.stateDirectory);
  const recordLeaves = await readAcceptanceJsonLeaves(state);
  if (recordLeaves.length !== 5) throw new ScorecardInputError("invalid-record-set");

  const campaignParent = await pinDirectoryIdentity(
    dirname(options.campaignDirectory),
    "evidence-parent",
  );
  const campaignDirectory = await pinPrivateOperatorEvidenceDirectory(options.campaignDirectory);
  const campaignLeaves = await readAcceptanceJsonLeaves(campaignDirectory);
  const campaignLeaf = campaignLeaves.find((leaf) => leaf.file === "campaign.json");
  if (!campaignLeaf) throw new ScorecardInputError("invalid-campaign");
  const declaration = parseScorecardCampaignDeclaration(campaignLeaf.value);
  const evaluatedDate = declaration.evaluatedAt.slice(0, 10);
  if (declaration.judge.status === "skipped" && declaration.judge.reviewOn < evaluatedDate) {
    throw new ScorecardInputError("invalid-campaign");
  }
  const judgeLeaf = campaignLeaves.find((leaf) => leaf.file === "judge-result.json");
  const expectedCampaignFiles =
    declaration.judge.status === "skipped"
      ? ["campaign.json"]
      : ["campaign.json", "judge-result.json"];
  if (
    campaignLeaves
      .map((leaf) => leaf.file)
      .sort()
      .join("\n") !== expectedCampaignFiles.sort().join("\n")
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }

  const acceptanceParent = await pinDirectoryIdentity(
    dirname(options.acceptanceDirectory),
    "evidence-parent",
  );
  const acceptanceDirectory = await pinPrivateOperatorEvidenceDirectory(
    options.acceptanceDirectory,
  );
  const acceptanceLeaf = await readAcceptanceJsonLeaf(acceptanceDirectory, "manifest.json");
  await revalidateEvidenceInputs([
    { parent: stateParent, directory: state },
    { parent: campaignParent, directory: campaignDirectory },
    { parent: acceptanceParent, directory: acceptanceDirectory },
  ]);
  const fixedInputs = await readFixedInputs("fixed-input");
  const { fixtureBytes, policyBytes, dependencyScriptBytes, packageJsonBytes, packageLockBytes } =
    fixedInputs;
  let policyValue: unknown;
  try {
    policyValue = parsePrivateJsonEvidence(policyBytes);
  } catch {
    throw new ScorecardCliError("policy");
  }
  const policy = parsePolicy(policyValue);
  validateRemainingWorkPolicy(declaration.remainingWork, policy.requiredRemainingWork);

  const gitRevision = await requiredLocal(runLocal, "git", ["rev-parse", "HEAD"]);
  const generatorRevision = gitRevision.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(generatorRevision)) {
    throw new ScorecardCliError("generator-revision");
  }
  const status = await requiredLocal(runLocal, "git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status.trim()) throw new ScorecardCliError("dirty-generator");

  const [dependencyCheck, npmCheck, npmBuild, diffCheck] = await Promise.all([
    localPassed(runLocal, "npm", ["run", "security:dependencies"]),
    localPassed(runLocal, "npm", ["run", "check"]),
    localPassed(runLocal, "npm", ["run", "build"]),
    localPassed(runLocal, "git", ["diff", "--check"]),
  ]);
  const dependencyStatus: ScorecardDependencyEvidence["status"] =
    !dependencyCheck || policy.dependency.reviewOn < evaluatedDate
      ? "failed"
      : policy.dependency.status;
  const dependency: ScorecardDependencyEvidence = {
    advisoryId: policy.dependency.advisoryId,
    status: dependencyStatus,
    owner: policy.dependency.owner,
    reviewOn: policy.dependency.reviewOn,
    packageStateSha256: sha256(
      Buffer.concat([
        policyBytes,
        Buffer.from([0]),
        dependencyScriptBytes,
        Buffer.from([0]),
        packageJsonBytes,
        Buffer.from([0]),
        packageLockBytes,
      ]),
    ),
  };
  const verification: ScorecardVerificationEvidence[] = [
    { id: "npm-check", passed: npmCheck },
    { id: "npm-build", passed: npmBuild },
    { id: "git-diff-check", passed: diffCheck },
  ];
  const scorecard = buildMvpScorecard({
    declarationBytes: campaignLeaf.bytes,
    recordLeaves: recordLeaves.map(({ file, bytes }) => ({ file, bytes })),
    fixtureBytes,
    acceptanceBytes: acceptanceLeaf.bytes,
    ...(judgeLeaf ? { judgeBytes: judgeLeaf.bytes } : {}),
    dependency,
    verification,
    generatorRevision,
  });
  const json = serializeMvpScorecard(scorecard);
  const markdown = renderMvpScorecardMarkdown(scorecard);
  assertSanitizedScorecardArtifacts(json, markdown);

  await revalidatePublicationInputs({
    runLocal,
    generatorRevision,
    fixedInputs,
    evidence: [
      { parent: stateParent, directory: state },
      { parent: campaignParent, directory: campaignDirectory },
      { parent: acceptanceParent, directory: acceptanceDirectory },
    ],
  });

  let outputDirectory: string | undefined;
  if (options.allowWrite) {
    outputDirectory = join(
      projectRoot,
      "docs/evidence",
      `mvp-stabilization-${declaration.testedCommit.slice(0, 12)}`,
    );
    await publish(outputDirectory, json, markdown);
  }
  log(`Decision: ${scorecard.decision}`);
  log(`Revision: ${scorecard.campaign.testedCommit}`);
  log(options.allowWrite ? "Published: scorecard.json, scorecard.md" : "Publication: dry run");
  return {
    exitCode: scorecard.decision === "not ready" ? 1 : 0,
    decision: scorecard.decision,
    testedCommit: scorecard.campaign.testedCommit,
    ...(outputDirectory ? { outputDirectory } : {}),
  };
}

async function revalidatePublicationInputs(input: {
  runLocal: ScorecardCliDependencies["runLocal"];
  generatorRevision: string;
  fixedInputs: FixedInputs;
  evidence: EvidenceInputIdentity[];
}): Promise<void> {
  const revision = (await requiredLocal(input.runLocal, "git", ["rev-parse", "HEAD"])).trim();
  const status = await requiredLocal(input.runLocal, "git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  await revalidateEvidenceInputs(input.evidence);
  const current = await readFixedInputs("publication-revalidation");
  if (
    revision !== input.generatorRevision ||
    status.trim() ||
    fixedInputValues(current).some(
      (bytes, index) => !bytes.equals(fixedInputValues(input.fixedInputs)[index]!),
    )
  ) {
    throw new ScorecardCliError("publication-revalidation");
  }
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}

interface EvidenceInputIdentity {
  parent: DirectoryIdentity;
  directory: AcceptanceEvidenceDirectory;
}

interface FixedInputs {
  fixtureBytes: Buffer;
  policyBytes: Buffer;
  dependencyScriptBytes: Buffer;
  packageJsonBytes: Buffer;
  packageLockBytes: Buffer;
}

async function readFixedInputs(code: string): Promise<FixedInputs> {
  const policyPath = resolve(projectRoot, "../..", internalContentPath("mvpScorecardPolicy"));
  try {
    const [fixtureBytes, policyBytes, dependencyScriptBytes, packageJsonBytes, packageLockBytes] =
      await Promise.all([
        readFile(fixturePath),
        readFile(policyPath),
        readFile(dependencyScriptPath),
        readFile(packageJsonPath),
        readFile(packageLockPath),
      ]);
    return {
      fixtureBytes,
      policyBytes,
      dependencyScriptBytes,
      packageJsonBytes,
      packageLockBytes,
    };
  } catch {
    throw new ScorecardCliError(code);
  }
}

function fixedInputValues(input: FixedInputs): Buffer[] {
  return [
    input.fixtureBytes,
    input.policyBytes,
    input.dependencyScriptBytes,
    input.packageJsonBytes,
    input.packageLockBytes,
  ];
}

async function revalidateEvidenceInputs(inputs: EvidenceInputIdentity[]): Promise<void> {
  for (const input of inputs) {
    await assertDirectoryIdentity(input.parent, "evidence-parent");
    await assertPrivateOperatorEvidenceDirectory(input.directory);
    await assertDirectoryIdentity(input.parent, "evidence-parent");
  }
}

async function defaultRunLocal(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      /TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL/iu.test(name) ||
      name === "GIT_ASKPASS" ||
      name === "SSH_ASKPASS"
    ) {
      delete environment[name];
    }
  }
  try {
    const result = await execFile(command, args, {
      cwd: projectRoot,
      env: environment,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    const result = error as { code?: unknown; stdout?: unknown };
    return {
      exitCode: typeof result.code === "number" ? result.code : 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    };
  }
}

async function requiredLocal(
  run: ScorecardCliDependencies["runLocal"],
  command: string,
  args: string[],
): Promise<string> {
  const result = await run(command, args);
  if (result.exitCode !== 0) throw new ScorecardCliError("local-command");
  return result.stdout;
}

async function localPassed(
  run: ScorecardCliDependencies["runLocal"],
  command: string,
  args: string[],
): Promise<boolean> {
  return (await run(command, args)).exitCode === 0;
}

interface ParsedPolicy {
  dependency: {
    advisoryId: "GHSA-mh99-v99m-4gvg";
    status: "resolved" | "contained";
    owner: "docsfab-maintainers";
    reviewOn: string;
  };
  requiredRemainingWork: Array<{
    issue: number;
    scope: "issue-28-dogfood" | "shared-service";
    reason: "product-validation" | "post-mvp-scope" | "external-governance";
  }>;
}

function parsePolicy(value: unknown): ParsedPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScorecardCliError("policy");
  }
  const root = value as Record<string, unknown>;
  const dependency = root.dependency as Record<string, unknown> | undefined;
  if (
    root.schemaVersion !== 1 ||
    !dependency ||
    dependency.advisoryId !== "GHSA-mh99-v99m-4gvg" ||
    (dependency.status !== "resolved" && dependency.status !== "contained") ||
    dependency.owner !== "docsfab-maintainers" ||
    typeof dependency.reviewOn !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(dependency.reviewOn) ||
    !Array.isArray(root.requiredRemainingWork)
  ) {
    throw new ScorecardCliError("policy");
  }
  const requiredRemainingWork = root.requiredRemainingWork.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ScorecardCliError("policy");
    }
    const work = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(work.issue) ||
      Number(work.issue) <= 0 ||
      (work.scope !== "issue-28-dogfood" && work.scope !== "shared-service") ||
      !["product-validation", "post-mvp-scope", "external-governance"].includes(String(work.reason))
    ) {
      throw new ScorecardCliError("policy");
    }
    return {
      issue: Number(work.issue),
      scope: work.scope as "issue-28-dogfood" | "shared-service",
      reason: work.reason as "product-validation" | "post-mvp-scope" | "external-governance",
    };
  });
  return {
    dependency: {
      advisoryId: dependency.advisoryId,
      status: dependency.status,
      owner: dependency.owner,
      reviewOn: dependency.reviewOn,
    },
    requiredRemainingWork,
  };
}

function validateRemainingWorkPolicy(
  declared: MvpScorecardV1["remainingWork"],
  required: ParsedPolicy["requiredRemainingWork"],
): void {
  for (const item of required) {
    if (
      !declared.some(
        (candidate) =>
          candidate.issue === item.issue &&
          candidate.scope === item.scope &&
          candidate.reason === item.reason,
      )
    ) {
      throw new ScorecardInputError("invalid-campaign");
    }
  }
}

export async function publishScorecardArtifacts(
  outputDirectory: string,
  json: string,
  markdown: string,
  options: {
    /** Test seam for an isolated evidence root. Production always uses docs/evidence. */
    evidenceRoot?: string;
    /** Test seam immediately before the pinned publication root is revalidated. */
    beforeTargetCreate?: () => void | Promise<void>;
    /** Test seam after a complete leaf is synced and revalidated. */
    afterFile?: (file: string) => void | Promise<void>;
  } = {},
): Promise<void> {
  let targetIdentity: DirectoryIdentity | undefined;
  const createdFiles: Array<{ path: string; dev: number; ino: number }> = [];
  const publishedFiles: Array<{
    path: string;
    dev: number;
    ino: number;
    mode: number;
    size: number;
  }> = [];
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const configuredRoot = resolve(options.evidenceRoot ?? join(projectRoot, "docs/evidence"));
    const rootParent = await pinDirectoryIdentity(dirname(configuredRoot), "output-boundary");
    const evidenceRoot = await pinDirectoryIdentity(configuredRoot, "output-boundary");
    const canonicalRoot = await safeRealpath(configuredRoot, "output-boundary");
    const target = resolve(outputDirectory);
    const canonicalTargetParent = await safeRealpath(dirname(target), "output-boundary");
    if (
      canonicalTargetParent !== canonicalRoot ||
      relative(evidenceRoot.path, target).startsWith("..")
    ) {
      throw new ScorecardCliError("output-boundary");
    }
    await options.beforeTargetCreate?.();
    await assertDirectoryIdentity(rootParent, "output-boundary");
    await assertDirectoryIdentity(evidenceRoot, "output-boundary");
    await mkdir(target, { mode: 0o755 });
    targetHandle = await open(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await targetHandle.chmod(0o755);
    const targetStat = await targetHandle.stat();
    assertPublicationDirectory(targetStat);
    targetIdentity = identity(target, targetStat);
    await assertDirectoryIdentity(targetIdentity, "publication");
    await assertDirectoryIdentity(evidenceRoot, "publication");
    for (const [file, contents] of [
      ["scorecard.json", json],
      ["scorecard.md", markdown],
    ] as const) {
      const path = join(target, file);
      let expectedLeaf: Stats | undefined;
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        await handle.chmod(0o644);
        const created = await handle.stat();
        assertPublicationFile(created);
        createdFiles.push({ path, dev: created.dev, ino: created.ino });
        await handle.writeFile(contents, "utf8");
        await handle.sync();
        const written = await handle.stat();
        assertPublicationFile(written);
        if (
          written.dev !== created.dev ||
          written.ino !== created.ino ||
          written.size !== Buffer.byteLength(contents, "utf8")
        ) {
          throw new ScorecardCliError("publication");
        }
        await assertPublicationLeaf(path, written);
        expectedLeaf = written;
      } finally {
        await handle.close();
      }
      await options.afterFile?.(file);
      if (!expectedLeaf) throw new ScorecardCliError("publication");
      await assertPublicationLeaf(path, expectedLeaf);
      publishedFiles.push({
        path,
        dev: expectedLeaf.dev,
        ino: expectedLeaf.ino,
        mode: expectedLeaf.mode,
        size: expectedLeaf.size,
      });
      await assertDirectoryIdentity(rootParent, "publication");
      await assertDirectoryIdentity(evidenceRoot, "publication");
      await assertDirectoryIdentity(targetIdentity, "publication");
    }
    await targetHandle.sync();
    await assertDirectoryIdentity(rootParent, "publication");
    await assertDirectoryIdentity(evidenceRoot, "publication");
    await assertDirectoryIdentity(targetIdentity, "publication");
    for (const file of publishedFiles) await assertPublicationLeaf(file.path, file);
  } catch (error) {
    await targetHandle?.close().catch(() => undefined);
    targetHandle = undefined;
    for (const file of createdFiles.reverse()) await removeCreatedFile(file);
    if (targetIdentity) await removeCreatedDirectory(targetIdentity);
    if (error instanceof ScorecardCliError) throw error;
    throw new ScorecardCliError("publication");
  } finally {
    await targetHandle?.close().catch(() => undefined);
  }
}

async function pinDirectoryIdentity(path: string, code: string): Promise<DirectoryIdentity> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const resolved = resolve(path);
    handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat();
    if (!descriptor.isDirectory()) throw new ScorecardCliError(code);
    const pinned = identity(resolved, descriptor);
    await assertDirectoryIdentity(pinned, code);
    return pinned;
  } catch (error) {
    if (error instanceof ScorecardCliError) throw error;
    throw new ScorecardCliError(code);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertDirectoryIdentity(expected: DirectoryIdentity, code: string): Promise<void> {
  try {
    const current = await lstat(expected.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.uid !== expected.uid ||
      current.mode !== expected.mode
    ) {
      throw new ScorecardCliError(code);
    }
  } catch (error) {
    if (error instanceof ScorecardCliError) throw error;
    throw new ScorecardCliError(code);
  }
}

function identity(path: string, stat: Stats): DirectoryIdentity {
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
  };
}

async function safeRealpath(path: string, code: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new ScorecardCliError(code);
  }
}

function assertPublicationDirectory(stat: Stats): void {
  if (!stat.isDirectory() || stat.uid !== publicationUid() || (stat.mode & 0o777) !== 0o755) {
    throw new ScorecardCliError("publication");
  }
}

function assertPublicationFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.uid !== publicationUid() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o644
  ) {
    throw new ScorecardCliError("publication");
  }
}

function publicationUid(): number {
  if (typeof process.getuid !== "function") {
    throw new ScorecardCliError("publication");
  }
  return process.getuid();
}

async function assertPublicationLeaf(
  path: string,
  expected: { dev: number; ino: number; mode: number; size: number },
): Promise<void> {
  try {
    const current = await lstat(path);
    assertPublicationFile(current);
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.mode !== expected.mode ||
      current.size !== expected.size
    ) {
      throw new ScorecardCliError("publication");
    }
  } catch (error) {
    if (error instanceof ScorecardCliError) throw error;
    throw new ScorecardCliError("publication");
  }
}

async function removeCreatedFile(expected: {
  path: string;
  dev: number;
  ino: number;
}): Promise<void> {
  try {
    const current = await lstat(expected.path);
    if (current.isFile() && current.dev === expected.dev && current.ino === expected.ino) {
      await unlink(expected.path);
    }
  } catch {
    // Best-effort rollback only removes the inode created by this invocation.
  }
}

async function removeCreatedDirectory(expected: DirectoryIdentity): Promise<void> {
  try {
    const current = await lstat(expected.path);
    if (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    ) {
      await rmdir(expected.path);
    }
  } catch {
    // Best-effort rollback only removes the inode created by this invocation.
  }
}

runCliEntrypoint(import.meta.url, () => runScorecardCli(process.argv.slice(2)));
