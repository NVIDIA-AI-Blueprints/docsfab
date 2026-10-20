// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseJsonEvidence } from "../json-evidence.js";
import {
  assertCorpusSourceBytes,
  datasetDigest,
  parseCorpusObservationSet,
  parseCorpusFakeCandidateSet,
  parseCorpusThresholdPolicy,
  parseLivingDocumentationDataset,
  type CorpusThresholdPolicy,
  type CorpusFakeCandidateSet,
  type CorpusObservationSet,
  type LivingDocumentationDataset,
} from "./corpus.js";
import type { IaPlanReviewerPolicy } from "../ia/plan-review.js";
import { DurableArtifactStore } from "../artifacts/index.js";
import { deriveCorpusLiveRun } from "./corpus-live.js";
import { buildContentIndex, canonicalDigest, type ContentIndexV1 } from "../content-ir/index.js";

export interface LoadedCorpusInputs {
  dataset: LivingDocumentationDataset;
  thresholds: CorpusThresholdPolicy;
  fakeCandidates: CorpusFakeCandidateSet;
}

export async function loadCorpusInputs(input: {
  projectRoot: string;
  datasetPath: string;
  thresholdsPath: string;
  thresholdPredecessorPath?: string;
  fakeCandidatesPath: string;
}): Promise<LoadedCorpusInputs> {
  const dataset = parseLivingDocumentationDataset(await readStrictJson(input.datasetPath));
  await validateCorpusSourceFiles(input.projectRoot, dataset);
  const thresholds = await loadThresholdPolicyChain(
    input.thresholdsPath,
    input.thresholdPredecessorPath,
  );
  if (
    thresholds.id !== dataset.thresholdPolicy.id ||
    thresholds.revision !== dataset.thresholdPolicy.revision ||
    thresholds.digest !== dataset.thresholdPolicy.digest
  ) {
    throw new Error("Threshold policy does not match the immutable dataset anchor.");
  }
  let rootPolicy = thresholds;
  while (rootPolicy.previous) {
    const rootPath = join(
      dirname(input.thresholdsPath),
      `thresholds-v${rootPolicy.previous.revision}.json`,
    );
    rootPolicy = await loadThresholdPolicyChain(rootPath);
  }
  if (
    rootPolicy.revision !== dataset.thresholdPolicy.rootRevision ||
    rootPolicy.digest !== dataset.thresholdPolicy.rootDigest
  ) {
    throw new Error("Threshold policy root does not match the immutable dataset anchor.");
  }
  const fakeCandidates = parseCorpusFakeCandidateSet(
    await readStrictJson(input.fakeCandidatesPath),
    dataset,
  );
  return { dataset, thresholds, fakeCandidates };
}

async function loadThresholdPolicyChain(
  currentPath: string,
  immediatePredecessorPath?: string,
): Promise<CorpusThresholdPolicy> {
  const values: unknown[] = [];
  let value = await readStrictJson(currentPath);
  let revision = thresholdRevision(value);
  values.push(value);
  while (revision > 1) {
    const predecessorPath =
      values.length === 1 && immediatePredecessorPath
        ? immediatePredecessorPath
        : join(dirname(currentPath), `thresholds-v${revision - 1}.json`);
    value = await readStrictJson(predecessorPath);
    const predecessorRevision = thresholdRevision(value);
    if (predecessorRevision !== revision - 1) {
      throw new Error("Threshold history is not contiguous.");
    }
    values.push(value);
    revision = predecessorRevision;
  }
  let trusted = parseCorpusThresholdPolicy(values.at(-1));
  for (let index = values.length - 2; index >= 0; index -= 1) {
    trusted = parseCorpusThresholdPolicy(values[index], { trustedPredecessor: trusted });
  }
  return trusted;
}

function thresholdRevision(value: unknown): number {
  const revision = (value as { revision?: unknown })?.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new Error("Threshold policy revision is invalid.");
  }
  return Number(revision);
}

export async function loadCorpusObservationSet(
  path: string,
  dataset: LivingDocumentationDataset,
  options: {
    reviewerPolicy: IaPlanReviewerPolicy;
    expectedTestedRevision: string;
    artifactStoreRoot: string;
    fixtureProjectRoot: string;
    now?: Date;
  },
): Promise<CorpusObservationSet> {
  const manifest = liveManifest(await readStrictJson(path, { ownerOnly: true }));
  const binding = manifest.dataset;
  if (
    binding.id !== dataset.id ||
    binding.revision !== dataset.revision ||
    binding.digest !== canonicalDatasetDigest(dataset)
  ) {
    throw new Error("Live campaign dataset binding does not match.");
  }
  const artifactStoreIdentity = await pinExistingDirectory(options.artifactStoreRoot, true);
  const store = new DurableArtifactStore(artifactStoreIdentity.path);
  const manifestDirectory = await realpath(dirname(resolve(path)));
  const runs = [];
  for (const entry of manifest.runs) {
    const corpusCase = dataset.cases.find((item) => item.id === entry.caseId);
    if (!corpusCase) throw new Error("Live campaign names an unknown case.");
    const contentIndexPath = await privateManifestPath(manifestDirectory, entry.contentIndexPath);
    const planningRecordPath = await privateManifestPath(
      manifestDirectory,
      entry.planningRunRecordPath,
    );
    const providerRecordPath = await privateManifestPath(
      manifestDirectory,
      entry.providerRunRecordPath,
    );
    const contentIndexValue = await readStrictJson(contentIndexPath, { ownerOnly: true });
    const contentIndex = await validateFixtureContentIndex(
      options.fixtureProjectRoot,
      corpusCase,
      contentIndexValue,
    );
    await assertPinnedDirectory(artifactStoreIdentity, true);
    const planArtifact = await store.get(entry.planArtifactDigest, {
      index: contentIndex,
      planAcceptance: "any",
      ...(options.now ? { now: options.now } : {}),
    });
    if (planArtifact.kind !== "ia-plan" || !planArtifact.payload.iaEvaluation) {
      throw new Error("Live campaign requires a complete IA plan artifact.");
    }
    const ontologyArtifact = await store.get(entry.ontologyArtifactDigest, {
      index: contentIndex,
      ...(options.now ? { now: options.now } : {}),
    });
    const candidateArtifact = await store.get(planArtifact.payload.candidateArtifact.digest, {
      index: contentIndex,
      ...(options.now ? { now: options.now } : {}),
    });
    const evaluationArtifact = await store.get(planArtifact.payload.iaEvaluation.digest, {
      index: contentIndex,
      ...(options.now ? { now: options.now } : {}),
    });
    const navigationArtifact = await store.get(entry.navigationArtifactDigest, {
      index: contentIndex,
      ...(options.now ? { now: options.now } : {}),
    });
    await assertPinnedDirectory(artifactStoreIdentity, true);
    runs.push(
      deriveCorpusLiveRun(
        corpusCase,
        {
          caseId: entry.caseId,
          planningRunRecord: await readStrictJson(planningRecordPath, { ownerOnly: true }),
          providerRunRecord: await readStrictJson(providerRecordPath, { ownerOnly: true }),
          contentIndex,
          ontologyArtifact,
          candidateArtifact,
          evaluationArtifact,
          planArtifact,
          navigationArtifact,
        },
        options.now ?? new Date(),
      ),
    );
  }
  return parseCorpusObservationSet(
    {
      schemaVersion: 1,
      dataset: manifest.dataset,
      mode: "live",
      runs,
      executionAuthorization: manifest.executionAuthorization,
      authorization: manifest.evidenceApproval,
    },
    dataset,
    options,
  );
}

interface LiveManifest {
  dataset: { id: string; revision: string; digest: string };
  executionAuthorization: unknown;
  evidenceApproval: unknown;
  runs: Array<{
    caseId: string;
    planningRunRecordPath: string;
    providerRunRecordPath: string;
    contentIndexPath: string;
    planArtifactDigest: string;
    navigationArtifactDigest: string;
    ontologyArtifactDigest: string;
  }>;
}

function liveManifest(value: unknown): LiveManifest {
  const root = strictObject(value, [
    "schemaVersion",
    "kind",
    "dataset",
    "executionAuthorization",
    "evidenceApproval",
    "runs",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-corpus-private-live-manifest" ||
    !Array.isArray(root.runs) ||
    root.runs.length === 0
  ) {
    throw new Error("Invalid private live campaign manifest.");
  }
  const dataset = strictObject(root.dataset, ["id", "revision", "digest"]);
  const runs = root.runs.map((value) => {
    const item = strictObject(value, [
      "caseId",
      "planningRunRecordPath",
      "providerRunRecordPath",
      "contentIndexPath",
      "planArtifactDigest",
      "navigationArtifactDigest",
      "ontologyArtifactDigest",
    ]);
    for (const key of [
      "caseId",
      "planningRunRecordPath",
      "providerRunRecordPath",
      "contentIndexPath",
      "planArtifactDigest",
      "navigationArtifactDigest",
      "ontologyArtifactDigest",
    ] as const) {
      if (typeof item[key] !== "string" || !item[key]) {
        throw new Error("Invalid private live campaign manifest.");
      }
    }
    return item as unknown as LiveManifest["runs"][number];
  });
  return {
    dataset: dataset as unknown as LiveManifest["dataset"],
    executionAuthorization: root.executionAuthorization,
    evidenceApproval: root.evidenceApproval,
    runs,
  };
}

function strictObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid private live campaign manifest.");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error("Invalid private live campaign manifest.");
  }
  return root;
}

function canonicalDatasetDigest(dataset: LivingDocumentationDataset): string {
  return datasetDigest(dataset);
}

async function privateManifestPath(root: string, value: string): Promise<string> {
  if (isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    throw new Error("Private live campaign paths must be relative.");
  }
  const candidate = resolve(root, value);
  if (!inside(root, candidate))
    throw new Error("Private live campaign path escapes its directory.");
  const parent = await realpath(dirname(candidate));
  if (!inside(root, parent) || parent !== dirname(candidate)) {
    throw new Error("Private live campaign path uses an unsafe directory.");
  }
  return resolve(parent, basename(candidate));
}

async function validateFixtureContentIndex(
  projectRoot: string,
  corpusCase: LivingDocumentationDataset["cases"][number],
  value: unknown,
): Promise<ContentIndexV1> {
  const root = strictObject(value, [
    "schemaVersion",
    "repository",
    "indexDigest",
    "nodes",
    "edges",
    "evidence",
  ]);
  const repository = strictObject(root.repository, ["revision", "contentDigest"]);
  if (root.schemaVersion !== 1 || typeof repository.revision !== "string") {
    throw new Error("Invalid live content index.");
  }
  const temporary = await mkdtemp(join(tmpdir(), "docsfab-corpus-index-"));
  try {
    for (const source of corpusCase.sources.filter((item) => item.visibility === "public")) {
      const destination = resolve(temporary, source.path);
      if (!inside(temporary, destination))
        throw new Error("Corpus source escapes fixture repository.");
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const bytes = await readCorpusSourceBytes(projectRoot, source.fixturePath);
      assertCorpusSourceBytes(source, bytes);
      const handle = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(),
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const expected = await buildContentIndex({
      repositoryPath: temporary,
      repositoryRevision: repository.revision,
    });
    if (
      canonicalDigest(expected) !== canonicalDigest(value) ||
      expected.repository.contentDigest !== corpusCase.repository.contentDigest
    ) {
      throw new Error("Live content index does not match the versioned corpus sources.");
    }
    return expected;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readCorpusSourceBytes(projectRoot: string, fixturePath: string): Promise<Buffer> {
  const root = await realpath(projectRoot);
  const candidate = resolve(root, fixturePath);
  if (!inside(root, candidate)) throw new Error("Corpus fixture path escapes the project root.");
  const stats = await lstat(candidate);
  const handle = await open(candidate, constants.O_RDONLY | noFollow());
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw new Error("Corpus fixture identity changed.");
    }
    const bytes = await readBounded(handle, 16 * 1024 * 1024);
    const after = await handle.stat();
    const leaf = await lstat(candidate);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      leaf.dev !== opened.dev ||
      leaf.ino !== opened.ino ||
      leaf.size !== opened.size ||
      leaf.mtimeMs !== opened.mtimeMs ||
      leaf.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("Corpus fixture identity changed.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function validateCorpusSourceFiles(
  projectRoot: string,
  dataset: LivingDocumentationDataset,
): Promise<void> {
  const pinnedRoot = await realpath(projectRoot);
  for (const corpusCase of dataset.cases) {
    for (const source of corpusCase.sources) {
      const candidate = resolve(pinnedRoot, source.fixturePath);
      if (!inside(pinnedRoot, candidate))
        throw new Error("Corpus source escapes the project root.");
      const stats = await lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink())
        throw new Error("Corpus source must be a regular file.");
      const actual = await realpath(candidate);
      if (!inside(pinnedRoot, actual) || actual !== candidate)
        throw new Error("Corpus source identity changed.");
      const handle = await open(candidate, constants.O_RDONLY | noFollow());
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
          throw new Error("Corpus source identity changed.");
        }
        assertCorpusSourceBytes(source, await handle.readFile());
      } finally {
        await handle.close();
      }
    }
  }
}

export async function readStrictJson(
  path: string,
  options: { ownerOnly?: boolean; maximumBytes?: number } = {},
): Promise<unknown> {
  const maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Invalid JSON evidence size limit.");
  }
  const absolute = resolve(path);
  const parent = await pinExistingDirectory(dirname(absolute), false);
  const candidate = resolve(parent.path, basename(absolute));
  if (!inside(parent.path, candidate)) throw new Error("Invalid JSON evidence path.");
  const stats = await lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error("JSON evidence must be a regular file.");
  const handle = await open(candidate, constants.O_RDONLY | noFollow());
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw new Error("JSON evidence identity changed.");
    }
    const currentUid = process.getuid?.();
    if (
      options.ownerOnly &&
      ((currentUid !== undefined && opened.uid !== currentUid) ||
        (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600))
    ) {
      throw new Error("Private JSON evidence must be owner-only and owned by the current user.");
    }
    if (opened.size > maximumBytes) throw new Error("JSON evidence exceeds the size limit.");
    const bytes = await readBounded(handle, maximumBytes);
    const after = await handle.stat();
    const leaf = await lstat(candidate);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      leaf.dev !== opened.dev ||
      leaf.ino !== opened.ino ||
      leaf.size !== opened.size ||
      leaf.mtimeMs !== opened.mtimeMs ||
      leaf.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("JSON evidence identity changed.");
    }
    await assertPinnedDirectory(parent, false);
    return parseJsonEvidence(bytes);
  } finally {
    await handle.close();
  }
}

async function readBounded(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes) throw new Error("JSON evidence exceeds the size limit.");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

interface DirectoryIdentity {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  ancestors: Array<{ path: string; dev: number; ino: number; uid: number; mode: number }>;
}

async function pinExistingDirectory(
  path: string,
  privateLeaf: boolean,
): Promise<DirectoryIdentity> {
  const canonicalPath = await realpath(resolve(path));
  const handle = await openDirectory(canonicalPath);
  try {
    const opened = await handle.stat();
    const leaf = await lstat(canonicalPath);
    assertDirectoryIdentity(opened, leaf, privateLeaf);
    const identity: DirectoryIdentity = {
      path: canonicalPath,
      canonicalPath,
      dev: opened.dev,
      ino: opened.ino,
      uid: opened.uid,
      mode: opened.mode,
      ancestors: await captureAncestorChain(canonicalPath),
    };
    await assertPinnedDirectory(identity, privateLeaf);
    return identity;
  } finally {
    await handle.close();
  }
}

async function captureAncestorChain(path: string): Promise<DirectoryIdentity["ancestors"]> {
  const paths: string[] = [];
  let current = dirname(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  paths.reverse();
  return Promise.all(
    paths.map(async (ancestorPath) => {
      const stat = await lstat(ancestorPath);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Directory ancestor is unsafe.");
      return { path: ancestorPath, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
    }),
  );
}

async function assertPinnedDirectory(
  identity: DirectoryIdentity,
  privateLeaf: boolean,
): Promise<void> {
  if ((await realpath(identity.path)) !== identity.canonicalPath) {
    throw new Error("Directory identity changed.");
  }
  for (const ancestor of identity.ancestors) {
    const stat = await lstat(ancestor.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== ancestor.dev ||
      stat.ino !== ancestor.ino ||
      stat.uid !== ancestor.uid ||
      stat.mode !== ancestor.mode
    ) {
      throw new Error("Directory ancestor identity changed.");
    }
  }
  const leaf = await lstat(identity.path);
  if (
    !leaf.isDirectory() ||
    leaf.isSymbolicLink() ||
    leaf.dev !== identity.dev ||
    leaf.ino !== identity.ino ||
    leaf.uid !== identity.uid ||
    leaf.mode !== identity.mode
  ) {
    throw new Error("Directory identity changed.");
  }
  if (privateLeaf) assertPrivateDirectory(leaf);
}

function assertDirectoryIdentity(opened: Stats, leaf: Stats, privateLeaf: boolean): void {
  if (
    !opened.isDirectory() ||
    !leaf.isDirectory() ||
    leaf.isSymbolicLink() ||
    opened.dev !== leaf.dev ||
    opened.ino !== leaf.ino
  ) {
    throw new Error("Directory identity changed.");
  }
  if (privateLeaf) assertPrivateDirectory(opened);
}

function assertPrivateDirectory(stat: Stats): void {
  const uid = process.getuid?.();
  if (
    (uid !== undefined && stat.uid !== uid) ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
  ) {
    throw new Error("Private artifact store must be owner-only.");
  }
}

async function openDirectory(path: string): Promise<FileHandle> {
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Directory identity pinning requires no-follow directory handles.");
  }
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function noFollow(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}
