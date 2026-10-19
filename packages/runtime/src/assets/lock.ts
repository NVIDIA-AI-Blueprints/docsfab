// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseJsonEvidence } from "../json-evidence.js";
import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
} from "../security/repository-scanner.js";
import { sha256 } from "../content-ir/canonical.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

interface LockedAssetFile {
  path: string;
  sha256: string;
}

interface LockedAssetBundle {
  id: string;
  version: string;
  license: string;
  localPath: string;
  source: {
    repository: string;
    revision: string;
    path: string;
  };
  bundleSha256: string;
  files: LockedAssetFile[];
}

interface AssetLock {
  schemaVersion: 1;
  bundleHashFormat: "sha256-provenance-lines-v1";
  bundles: LockedAssetBundle[];
}

export interface GovernedAssetEvidence {
  id: string;
  version: string;
  license: string;
  bundleSha256: string;
  source: LockedAssetBundle["source"];
  files: LockedAssetFile[];
}

export interface VerifiedGovernedAssetBundle {
  /** Internal resolved path; never include it in persisted evidence. */
  directory: string;
  evidence: GovernedAssetEvidence;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unknown field.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return value;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return path;
}

function hash(value: unknown, label: string): string {
  const digest = text(value, label);
  if (!SHA256.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256.`);
  }
  return digest;
}

function source(value: unknown, label: string): LockedAssetBundle["source"] {
  const item = record(value, label);
  exact(item, ["repository", "revision", "path"], label);
  const repository = text(item.repository, `${label}.repository`);
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new Error(`${label}.repository must be an HTTPS URL without credentials.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label}.repository must be an HTTPS URL without credentials.`);
  }
  const revision = text(item.revision, `${label}.revision`);
  if (!GIT_OBJECT_ID.test(revision)) {
    throw new Error(`${label}.revision must be a full lowercase Git object ID.`);
  }
  return {
    repository,
    revision,
    path: safeRelativePath(item.path, `${label}.path`),
  };
}

function parseBundle(value: unknown, index: number): LockedAssetBundle {
  const item = record(value, `bundles[${index}]`);
  exact(
    item,
    ["id", "version", "license", "localPath", "source", "bundleSha256", "files"],
    `bundles[${index}]`,
  );
  if (!Array.isArray(item.files) || item.files.length === 0) {
    throw new Error(`bundles[${index}].files must be a non-empty array.`);
  }
  const files = item.files.map((value, fileIndex) => {
    const file = record(value, `bundles[${index}].files[${fileIndex}]`);
    exact(file, ["path", "sha256"], `bundles[${index}].files[${fileIndex}]`);
    return {
      path: safeRelativePath(file.path, `bundles[${index}].files[${fileIndex}].path`),
      sha256: hash(file.sha256, `bundles[${index}].files[${fileIndex}].sha256`),
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error(`bundles[${index}].files contains duplicate paths.`);
  }
  return {
    id: text(item.id, `bundles[${index}].id`),
    version: text(item.version, `bundles[${index}].version`),
    license: text(item.license, `bundles[${index}].license`),
    localPath: safeRelativePath(item.localPath, `bundles[${index}].localPath`),
    source: source(item.source, `bundles[${index}].source`),
    bundleSha256: hash(item.bundleSha256, `bundles[${index}].bundleSha256`),
    files,
  };
}

function parseLock(value: unknown): AssetLock {
  if (detectCredentialRuleIdsInValue(value).length > 0) {
    throw new Error(
      "Governed asset lock contains credential-shaped material; remove it before retrying.",
    );
  }
  const lock = record(value, "asset lock");
  exact(lock, ["schemaVersion", "bundleHashFormat", "bundles"], "asset lock");
  if (lock.schemaVersion !== 1) {
    throw new Error("asset lock schemaVersion must be 1.");
  }
  if (lock.bundleHashFormat !== "sha256-provenance-lines-v1") {
    throw new Error("asset lock bundleHashFormat must be sha256-provenance-lines-v1.");
  }
  if (!Array.isArray(lock.bundles)) {
    throw new Error("The governed asset lock bundles must be an array.");
  }
  const bundles = lock.bundles.map(parseBundle);
  if (new Set(bundles.map((bundle) => bundle.id)).size !== bundles.length) {
    throw new Error("asset lock contains duplicate bundle ids.");
  }
  return {
    schemaVersion: 1,
    bundleHashFormat: "sha256-provenance-lines-v1",
    bundles,
  };
}

function provenanceManifest(bundle: LockedAssetBundle): string {
  return [
    `repository ${bundle.source.repository}\n`,
    `revision ${bundle.source.revision}\n`,
    `source-path ${bundle.source.path}\n`,
    `local-path ${bundle.localPath}\n`,
    `version ${bundle.version}\n`,
    `license ${bundle.license}\n`,
    ...[...bundle.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.sha256}  ${file.path}\n`),
  ].join("");
}

async function listFiles(directory: string, bundleId: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, prefix), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Governed asset bundle "${bundleId}" contains an unsafe path: ${path}.`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, bundleId, path)));
    } else files.push(path);
  }
  return files.sort();
}

function staysInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function assertCanonicalContainedPath(
  root: string,
  candidate: string,
  bundleId: string,
  displayedPath: string,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!staysInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(
      `Governed asset bundle "${bundleId}" contains an unsafe path: ${displayedPath}.`,
    );
  }

  const relativePath = relative(resolvedRoot, resolvedCandidate);
  let component = resolvedRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    component = resolve(component, segment);
    if ((await lstat(component)).isSymbolicLink()) {
      throw new Error(
        `Governed asset bundle "${bundleId}" contains an unsafe path: ${displayedPath}.`,
      );
    }
  }

  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(resolvedRoot),
    realpath(resolvedCandidate),
  ]);
  if (!staysInside(canonicalRoot, canonicalCandidate)) {
    throw new Error(
      `Governed asset bundle "${bundleId}" contains an unsafe path: ${displayedPath}.`,
    );
  }
}

async function readAssetLock(projectRoot: string): Promise<AssetLock> {
  const lockPath = resolve(projectRoot, "governed-assets", "lock.json");
  const lockContents = await readFile(lockPath, "utf8");
  if (detectCredentialRuleIds(lockContents).length > 0) {
    throw new Error(
      "Governed asset lock contains credential-shaped material; remove it before retrying.",
    );
  }
  return parseLock(parseJsonEvidence(lockContents));
}

/** Validate the catalog even when this distribution contains no optional bundles. */
export async function verifyGovernedAssetCatalog(projectRoot: string): Promise<readonly string[]> {
  const lock = await readAssetLock(projectRoot);
  return lock.bundles.map((bundle) => bundle.id);
}

export async function verifyGovernedAssetBundle(
  projectRoot: string,
  bundleId: string,
): Promise<VerifiedGovernedAssetBundle> {
  const lock = await readAssetLock(projectRoot);
  const bundle = lock.bundles.find((candidate) => candidate.id === bundleId);
  if (!bundle) throw new Error(`Governed asset bundle "${bundleId}" is not locked.`);

  const root = resolve(projectRoot);
  const directory = resolve(root, bundle.localPath);
  await assertCanonicalContainedPath(root, directory, bundle.id, bundle.localPath);
  const actualFiles = await listFiles(directory, bundle.id);
  const declaredFiles = bundle.files.map((file) => file.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    throw new Error(`Governed asset bundle "${bundle.id}" file set does not match its lock.`);
  }
  for (const file of bundle.files) {
    const path = resolve(directory, file.path);
    await assertCanonicalContainedPath(directory, path, bundle.id, file.path);
    if (sha256(await readFile(path)) !== file.sha256) {
      throw new Error(`Governed asset bundle "${bundle.id}" checksum mismatch: ${file.path}.`);
    }
  }
  if (sha256(provenanceManifest(bundle)) !== bundle.bundleSha256) {
    throw new Error(`Governed asset bundle "${bundle.id}" provenance checksum mismatch.`);
  }
  return {
    directory,
    evidence: {
      id: bundle.id,
      version: bundle.version,
      license: bundle.license,
      bundleSha256: bundle.bundleSha256,
      source: { ...bundle.source },
      files: bundle.files.map((file) => ({ ...file })),
    },
  };
}
