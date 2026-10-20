// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fail-closed verification for Pin C and the logical B+C quality pack. */
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseJsonEvidence } from "../json-evidence.js";
import { deepFreeze } from "../contract-kit/index.js";
import type { QualityPackEvidenceV1, ResolvedResourceSetV1 } from "../records/contracts.js";
import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
} from "../security/repository-scanner.js";
import { parseCatalogSkillCrateLock } from "../skills/catalog-crate.js";
import { sha256 } from "../content-ir/canonical.js";
import { QualityPackError, type QualityPackErrorCode } from "./error.js";
import {
  HISTORICAL_QUALITY_PROGRAM,
  isHistoricalQualityProgramPath,
  QualityResourceRoleError,
} from "./resource-roles.js";

export { QualityPackError } from "./error.js";
export type { QualityPackErrorCode } from "./error.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9:._-]{0,255}$/u;
const PNG_QUALITY_ASSET = /\.png$/iu;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
export const PRODUCT_DEFAULT_DECLARATION_PATH = "profiles/product-default.json" as const;

export type QualityBarKind = "check" | "profile" | "rubric";
export interface QualityBar {
  id: string;
  kind: QualityBarKind;
  assetPath: string;
}

export interface LockedQualityFile {
  path: string;
  sha256: string;
}

/** One profile the product-default declaration binds, as the generator resolved it. */
export interface ProductDefaultProfileV1 {
  barId: string;
  profileId: string;
  version: string;
  assetPath: string;
  /** sha256-lines over the profile asset and its named files, in path order. */
  sha256: string;
}

export interface ProductDefaultStyleProfileV1 extends ProductDefaultProfileV1 {
  /** Files delivered to style-bound steps, in declared order. */
  deliveredPaths: string[];
}

export interface ProductDefaultEvaluationProfileV1 extends ProductDefaultProfileV1 {
  readerImpactBaselinePath: string;
}

export interface QualityProductDefaultsV1 {
  declarationPath: typeof PRODUCT_DEFAULT_DECLARATION_PATH;
  layer: "product";
  style: ProductDefaultStyleProfileV1;
  evaluation: ProductDefaultEvaluationProfileV1;
}

export interface RuntimeQualityLockV2 {
  schemaVersion: 2;
  bundleHashFormat: "sha256-lines-v1";
  source: { repository: string; revision: string; path: "packages/quality" };
  qualityRoot: ".";
  bars: QualityBar[];
  productDefaults: QualityProductDefaultsV1;
  bundleSha256: string;
  files: LockedQualityFile[];
}

export interface QualityPackManifestV1 {
  schemaVersion: 1;
  id: "docsfab-default";
  version: "1.0.0";
  skillCrate: {
    lockPath: "../skill-crate/lock.json";
    lockSha256: string;
    skillIds: string[];
  };
  quality: {
    lockPath: "../quality/lock.json";
    lockSha256: string;
    bundleSha256: string;
    barIds: string[];
  };
  bindingSha256: string;
}

/** Verified lock context used only by trusted runtime selectors and validator hosts. */
export interface VerifiedQualityPackContext {
  evidence: QualityPackEvidenceV1;
  qualityRoot: string;
  skillCrateRoot: string;
  qualityLock: RuntimeQualityLockV2;
  skillLock: ReturnType<typeof parseCatalogSkillCrateLock>;
}

const verifiedQualityPayloadFiles = new WeakMap<
  VerifiedQualityPackContext,
  ReadonlyArray<{ path: string; sha256: string; bytes: Buffer }>
>();

function record(
  value: unknown,
  label: string,
  code: QualityPackErrorCode,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QualityPackError(code, `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  code: QualityPackErrorCode,
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new QualityPackError(code, `${label} contains unexpected keys.`);
  }
}

function text(value: unknown, label: string, code: QualityPackErrorCode): string {
  if (typeof value !== "string" || !value) {
    throw new QualityPackError(code, `${label} must be a non-empty string.`);
  }
  return value;
}

function hash(value: unknown, label: string, code: QualityPackErrorCode): string {
  const candidate = text(value, label, code);
  if (!SHA256.test(candidate)) {
    throw new QualityPackError(code, `${label} must be a lowercase SHA-256.`);
  }
  return candidate;
}

function safePath(value: unknown, label: string, code: QualityPackErrorCode): string {
  const path = text(value, label, code);
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new QualityPackError(code, `${label} must remain inside the quality payload.`);
  }
  return path;
}

function identifier(value: unknown, label: string, code: QualityPackErrorCode): string {
  const id = text(value, label, code);
  if (!SAFE_ID.test(id)) throw new QualityPackError(code, `${label} is not a stable identifier.`);
  return id;
}

function sortedUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0)
  );
}

function stringArray(value: unknown, label: string, code: QualityPackErrorCode): string[] {
  if (!Array.isArray(value)) throw new QualityPackError(code, `${label} must be an array.`);
  const values = value.map((item, index) => identifier(item, `${label}[${index}]`, code));
  if (!sortedUnique(values)) {
    throw new QualityPackError(code, `${label} must be sorted and unique.`);
  }
  return values;
}

function bundleSha256(files: readonly LockedQualityFile[]): string {
  return sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
}

function isKnownBinaryQualityAsset(path: string, bytes: Buffer): boolean {
  if (!PNG_QUALITY_ASSET.test(path)) return false;
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new QualityPackError("tampered");
  }
  return true;
}

export function parseRuntimeQualityLock(value: unknown): RuntimeQualityLockV2 {
  if (detectCredentialRuleIdsInValue(value).length > 0) throw new QualityPackError("invalid-lock");
  const root = record(value, "runtime quality lock", "invalid-lock");
  // A version 1 lock carries no product-default declaration, so nothing names the bound profiles.
  // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
  if (root.schemaVersion === 1) throw new QualityPackError("migration-required");
  exact(
    root,
    [
      "schemaVersion",
      "bundleHashFormat",
      "source",
      "qualityRoot",
      "bars",
      "productDefaults",
      "bundleSha256",
      "files",
    ],
    "runtime quality lock",
    "invalid-lock",
  );
  if (root.schemaVersion !== 2 || root.bundleHashFormat !== "sha256-lines-v1") {
    throw new QualityPackError("invalid-lock");
  }
  const source = record(root.source, "source", "invalid-lock");
  exact(source, ["repository", "revision", "path"], "source", "invalid-lock");
  const repository = text(source.repository, "source.repository", "invalid-lock");
  let parsedRepository: URL;
  try {
    parsedRepository = new URL(repository);
  } catch {
    throw new QualityPackError("invalid-lock");
  }
  if (
    parsedRepository.protocol !== "https:" ||
    parsedRepository.username ||
    parsedRepository.password ||
    parsedRepository.search ||
    parsedRepository.hash ||
    !GIT_OBJECT_ID.test(text(source.revision, "source.revision", "invalid-lock")) ||
    source.path !== "packages/quality" ||
    root.qualityRoot !== "."
  ) {
    throw new QualityPackError("invalid-lock");
  }
  if (!Array.isArray(root.files) || root.files.length === 0 || !Array.isArray(root.bars)) {
    throw new QualityPackError("invalid-lock");
  }
  const files = root.files.map((value, index) => {
    const item = record(value, `files[${index}]`, "invalid-lock");
    exact(item, ["path", "sha256"], `files[${index}]`, "invalid-lock");
    return {
      path: safePath(item.path, `files[${index}].path`, "invalid-lock"),
      sha256: hash(item.sha256, `files[${index}].sha256`, "invalid-lock"),
    };
  });
  if (!sortedUnique(files.map((file) => file.path))) throw new QualityPackError("invalid-lock");
  const bars = root.bars.map((value, index) => {
    const item = record(value, `bars[${index}]`, "invalid-lock");
    exact(item, ["id", "kind", "assetPath"], `bars[${index}]`, "invalid-lock");
    if (!new Set(["check", "profile", "rubric"]).has(item.kind as string)) {
      throw new QualityPackError("invalid-lock");
    }
    return {
      id: identifier(item.id, `bars[${index}].id`, "invalid-lock"),
      kind: item.kind as QualityBarKind,
      assetPath: safePath(item.assetPath, `bars[${index}].assetPath`, "invalid-lock"),
    };
  });
  if (!sortedUnique(bars.map((bar) => bar.id))) throw new QualityPackError("invalid-lock");
  const filePaths = new Set(files.map((file) => file.path));
  if (bars.some((bar) => !filePaths.has(bar.assetPath))) throw new QualityPackError("invalid-lock");
  const lockedBundle = hash(root.bundleSha256, "bundleSha256", "invalid-lock");
  if (bundleSha256(files) !== lockedBundle) throw new QualityPackError("checksum-mismatch");
  return {
    schemaVersion: 2,
    bundleHashFormat: "sha256-lines-v1",
    source: {
      repository,
      revision: source.revision as string,
      path: "packages/quality",
    },
    qualityRoot: ".",
    bars,
    productDefaults: parseProductDefaults(root.productDefaults, bars, files),
    bundleSha256: lockedBundle,
    files,
  };
}

/** Admit the generator's product-default bindings against the same lock's bars and files. */
function parseProductDefaults(
  value: unknown,
  bars: readonly QualityBar[],
  files: readonly LockedQualityFile[],
): QualityProductDefaultsV1 {
  const code = "invalid-lock";
  const root = record(value, "productDefaults", code);
  exact(root, ["declarationPath", "layer", "style", "evaluation"], "productDefaults", code);
  const lockedPaths = new Set(files.map((file) => file.path));
  if (
    root.declarationPath !== PRODUCT_DEFAULT_DECLARATION_PATH ||
    root.layer !== "product" ||
    !lockedPaths.has(PRODUCT_DEFAULT_DECLARATION_PATH)
  ) {
    throw new QualityPackError(code);
  }
  const profile = (
    entryValue: unknown,
    label: string,
    extraKey: "deliveredPaths" | "readerImpactBaselinePath",
  ) => {
    const entry = record(entryValue, label, code);
    exact(entry, ["barId", "profileId", "version", "assetPath", extraKey, "sha256"], label, code);
    const barId = identifier(entry.barId, `${label}.barId`, code);
    const assetPath = safePath(entry.assetPath, `${label}.assetPath`, code);
    const bar = bars.find((candidate) => candidate.id === barId);
    if (
      !bar ||
      bar.kind !== "profile" ||
      bar.assetPath !== assetPath ||
      entry.profileId !== barId.slice("profile:".length)
    ) {
      throw new QualityPackError(code, `${label} does not name a locked profile bar.`);
    }
    const directory = assetPath.slice(0, assetPath.lastIndexOf("/") + 1);
    const member = (memberValue: unknown, memberLabel: string): string => {
      const path = safePath(memberValue, memberLabel, code);
      if (!path.startsWith(directory) || path.slice(directory.length).includes("/")) {
        throw new QualityPackError(code, `${memberLabel} must sit in its profile directory.`);
      }
      // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
      if (!lockedPaths.has(path)) throw new QualityPackError("file-set-mismatch");
      return path;
    };
    return {
      fields: {
        barId,
        profileId: entry.profileId as string,
        version: identifier(entry.version, `${label}.version`, code),
        assetPath,
        sha256: hash(entry.sha256, `${label}.sha256`, code),
      },
      entry,
      member,
    };
  };
  const style = profile(root.style, "productDefaults.style", "deliveredPaths");
  if (!Array.isArray(style.entry.deliveredPaths) || style.entry.deliveredPaths.length === 0) {
    throw new QualityPackError(code);
  }
  const deliveredPaths = style.entry.deliveredPaths.map((path, index) =>
    style.member(path, `productDefaults.style.deliveredPaths[${index}]`),
  );
  if (new Set(deliveredPaths).size !== deliveredPaths.length) throw new QualityPackError(code);
  const evaluation = profile(
    root.evaluation,
    "productDefaults.evaluation",
    "readerImpactBaselinePath",
  );
  const readerImpactBaselinePath = evaluation.member(
    evaluation.entry.readerImpactBaselinePath,
    "productDefaults.evaluation.readerImpactBaselinePath",
  );
  if (
    resourceSha256([style.fields.assetPath, ...deliveredPaths], files) !== style.fields.sha256 ||
    resourceSha256([evaluation.fields.assetPath, readerImpactBaselinePath], files) !==
      evaluation.fields.sha256
  ) {
    // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
    throw new QualityPackError("checksum-mismatch");
  }
  return {
    declarationPath: PRODUCT_DEFAULT_DECLARATION_PATH,
    layer: "product",
    style: { ...style.fields, deliveredPaths },
    evaluation: { ...evaluation.fields, readerImpactBaselinePath },
  };
}

/** sha256-lines over one resource's locked files in path order, as the generator writes it. */
export function resourceSha256(
  paths: readonly string[],
  files: readonly LockedQualityFile[],
): string {
  const locked = [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => files.find((file) => file.path === path));
  // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
  if (locked.some((file) => file === undefined)) throw new QualityPackError("file-set-mismatch");
  return bundleSha256(locked as LockedQualityFile[]);
}

export function parseQualityPackManifest(value: unknown): QualityPackManifestV1 {
  if (detectCredentialRuleIdsInValue(value).length > 0) {
    throw new QualityPackError("invalid-manifest");
  }
  const root = record(value, "quality-pack manifest", "invalid-manifest");
  exact(
    root,
    ["schemaVersion", "id", "version", "skillCrate", "quality", "bindingSha256"],
    "quality-pack manifest",
    "invalid-manifest",
  );
  if (root.schemaVersion !== 1 || root.id !== "docsfab-default" || root.version !== "1.0.0") {
    throw new QualityPackError("invalid-manifest");
  }
  const skillCrate = record(root.skillCrate, "skillCrate", "invalid-manifest");
  exact(skillCrate, ["lockPath", "lockSha256", "skillIds"], "skillCrate", "invalid-manifest");
  const quality = record(root.quality, "quality", "invalid-manifest");
  exact(
    quality,
    ["lockPath", "lockSha256", "bundleSha256", "barIds"],
    "quality",
    "invalid-manifest",
  );
  if (
    skillCrate.lockPath !== "../skill-crate/lock.json" ||
    quality.lockPath !== "../quality/lock.json"
  ) {
    throw new QualityPackError("invalid-manifest");
  }
  return {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    skillCrate: {
      lockPath: "../skill-crate/lock.json",
      lockSha256: hash(skillCrate.lockSha256, "skillCrate.lockSha256", "invalid-manifest"),
      skillIds: stringArray(skillCrate.skillIds, "skillCrate.skillIds", "invalid-manifest"),
    },
    quality: {
      lockPath: "../quality/lock.json",
      lockSha256: hash(quality.lockSha256, "quality.lockSha256", "invalid-manifest"),
      bundleSha256: hash(quality.bundleSha256, "quality.bundleSha256", "invalid-manifest"),
      barIds: stringArray(quality.barIds, "quality.barIds", "invalid-manifest"),
    },
    bindingSha256: hash(root.bindingSha256, "bindingSha256", "invalid-manifest"),
  };
}

async function readRegularFile(path: string, code: QualityPackErrorCode): Promise<Buffer> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new QualityPackError("unsafe-path");
    }
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    ) {
      throw new QualityPackError("tampered");
    }
    return bytes;
  } catch (error) {
    if (error instanceof QualityPackError) throw error;
    throw new QualityPackError(code);
  }
}

async function assertContainedRoot(root: string): Promise<string> {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new QualityPackError("unsafe-path");
    }
    return await realpath(root);
  } catch (error) {
    if (error instanceof QualityPackError) throw error;
    throw new QualityPackError("lock-unavailable");
  }
}

async function listPayloadFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const metadata = await lstat(resolve(root, path));
    if (metadata.isSymbolicLink()) throw new QualityPackError("unsafe-path");
    if (metadata.isDirectory()) files.push(...(await listPayloadFiles(root, path)));
    else if (metadata.isFile() && metadata.nlink === 1) files.push(path);
    else throw new QualityPackError("unsafe-path");
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function assertInside(
  root: string,
  candidate: string,
  code: QualityPackErrorCode = "unsafe-path",
): Promise<void> {
  try {
    const rootReal = await realpath(root);
    const candidateReal = await realpath(candidate);
    const scoped = relative(rootReal, candidateReal);
    if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
      throw new QualityPackError("unsafe-path");
    }
  } catch (error) {
    if (error instanceof QualityPackError) throw error;
    throw new QualityPackError(code);
  }
}

/** Return already-verified Pin C files under a relative prefix. */
export async function readVerifiedQualityPackFiles(
  context: VerifiedQualityPackContext,
  prefix: string,
): Promise<ReadonlyArray<{ path: string; sha256: string; bytes: Buffer }>> {
  const subtree = safePath(prefix, "quality subtree", "unsafe-path");
  if (
    isHistoricalQualityProgramPath(subtree) ||
    context.qualityLock.files.some(
      (file) => file.path === subtree && file.sha256 === HISTORICAL_QUALITY_PROGRAM.sha256,
    )
  ) {
    // hygiene: envelope — QualityResourceRoleError maps the closed code to an actionable message.
    throw new QualityResourceRoleError("historical-program");
  }
  const cached = verifiedQualityPayloadFiles.get(context);
  if (cached) {
    const locked = cached.filter(
      (file) =>
        !isHistoricalQualityProgramPath(file.path) &&
        file.sha256 !== HISTORICAL_QUALITY_PROGRAM.sha256 &&
        (file.path === subtree || file.path.startsWith(`${subtree}/`)),
    );
    // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
    if (locked.length === 0) throw new QualityPackError("file-set-mismatch");
    return locked.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));
  }
  const locked = context.qualityLock.files.filter(
    (file) =>
      !isHistoricalQualityProgramPath(file.path) &&
      file.sha256 !== HISTORICAL_QUALITY_PROGRAM.sha256 &&
      (file.path === subtree || file.path.startsWith(`${subtree}/`)),
  );
  // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
  if (locked.length === 0) throw new QualityPackError("file-set-mismatch");
  const files = [];
  for (const file of locked) {
    const path = resolve(context.qualityRoot, file.path);
    await assertInside(context.qualityRoot, path);
    const bytes = await readRegularFile(path, "tampered");
    // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
    if (sha256(bytes) !== file.sha256) throw new QualityPackError("checksum-mismatch");
    files.push({ path: file.path, sha256: file.sha256, bytes });
  }
  return files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));
}

async function verifyQualityPack(options: {
  qualityPackDirectory: string;
  qualityDirectory: string;
  skillCrateDirectory: string;
}): Promise<VerifiedQualityPackContext> {
  const [packRoot, qualityRoot, skillRoot] = await Promise.all([
    assertContainedRoot(options.qualityPackDirectory),
    assertContainedRoot(options.qualityDirectory),
    assertContainedRoot(options.skillCrateDirectory),
  ]);
  const manifestPath = resolve(packRoot, "manifest.json");
  const qualityLockPath = resolve(qualityRoot, "lock.json");
  const skillLockPath = resolve(skillRoot, "lock.json");
  await Promise.all([
    assertInside(packRoot, manifestPath, "lock-unavailable"),
    assertInside(qualityRoot, qualityLockPath, "lock-unavailable"),
    assertInside(skillRoot, skillLockPath, "lock-unavailable"),
  ]);
  const [manifestBytes, qualityLockBytes, skillLockBytes] = await Promise.all([
    readRegularFile(manifestPath, "lock-unavailable"),
    readRegularFile(qualityLockPath, "lock-unavailable"),
    readRegularFile(skillLockPath, "lock-unavailable"),
  ]);
  let manifest: QualityPackManifestV1;
  let qualityLock: RuntimeQualityLockV2;
  let skillLock: ReturnType<typeof parseCatalogSkillCrateLock>;
  try {
    manifest = parseQualityPackManifest(parseJsonEvidence(manifestBytes.toString("utf8")));
    qualityLock = parseRuntimeQualityLock(parseJsonEvidence(qualityLockBytes.toString("utf8")));
    skillLock = parseCatalogSkillCrateLock(parseJsonEvidence(skillLockBytes.toString("utf8")));
  } catch (error) {
    if (error instanceof QualityPackError) throw error;
    throw new QualityPackError("invalid-manifest");
  }
  const skillLockSha256 = sha256(skillLockBytes);
  const qualityLockSha256 = sha256(qualityLockBytes);
  if (
    skillLockSha256 !== manifest.skillCrate.lockSha256 ||
    qualityLockSha256 !== manifest.quality.lockSha256 ||
    sha256(`${skillLockSha256}\n${qualityLockSha256}\n`) !== manifest.bindingSha256
  ) {
    throw new QualityPackError("stale");
  }
  if (
    JSON.stringify(skillLock.skills.map((skill) => skill.id)) !==
      JSON.stringify(manifest.skillCrate.skillIds) ||
    qualityLock.bundleSha256 !== manifest.quality.bundleSha256 ||
    JSON.stringify(qualityLock.bars.map((bar) => bar.id)) !==
      JSON.stringify(manifest.quality.barIds)
  ) {
    throw new QualityPackError("stale");
  }
  const actualPaths = (await listPayloadFiles(qualityRoot)).filter((path) => path !== "lock.json");
  if (JSON.stringify(actualPaths) !== JSON.stringify(qualityLock.files.map((file) => file.path))) {
    throw new QualityPackError("file-set-mismatch");
  }
  const payloadFiles: Array<{ path: string; sha256: string; bytes: Buffer }> = [];
  for (const file of qualityLock.files) {
    const path = resolve(qualityRoot, file.path);
    await assertInside(qualityRoot, path);
    const bytes = await readRegularFile(path, "tampered");
    if (sha256(bytes) !== file.sha256) throw new QualityPackError("checksum-mismatch");
    if (
      isHistoricalQualityProgramPath(file.path) &&
      file.sha256 !== HISTORICAL_QUALITY_PROGRAM.sha256
    ) {
      // hygiene: envelope — QualityPackError maps this code to the actionable package-integrity error.
      throw new QualityPackError("checksum-mismatch");
    }
    if (
      file.sha256 === HISTORICAL_QUALITY_PROGRAM.sha256 &&
      !isHistoricalQualityProgramPath(file.path)
    ) {
      // hygiene: envelope — only the declared historical path may authenticate these program bytes.
      throw new QualityPackError("invalid-lock");
    }
    let text: string;
    try {
      text = isKnownBinaryQualityAsset(file.path, bytes)
        ? bytes.toString("utf8")
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof QualityPackError) throw error;
      throw new QualityPackError("tampered");
    }
    if (detectCredentialRuleIds(text).length > 0) throw new QualityPackError("tampered");
    payloadFiles.push({ path: file.path, sha256: file.sha256, bytes });
  }
  const evidence: QualityPackEvidenceV1 = {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    manifestSha256: sha256(manifestBytes),
    bindingSha256: manifest.bindingSha256,
    skillLockSha256,
    qualityLockSha256,
    qualityBundleSha256: qualityLock.bundleSha256,
    barIds: [...manifest.quality.barIds],
    resolvedResources: resolvedResourceSet(qualityLock),
  };
  const context = deepFreeze({
    evidence,
    qualityRoot,
    skillCrateRoot: skillRoot,
    qualityLock,
    skillLock,
  });
  verifiedQualityPayloadFiles.set(context, payloadFiles);
  return context;
}

/** The product-layer resource set a verified lock binds for every run. */
export function resolvedResourceSet(lock: RuntimeQualityLockV2): ResolvedResourceSetV1 {
  const declaration = lock.files.find((file) => file.path === lock.productDefaults.declarationPath);
  // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
  if (!declaration) throw new QualityPackError("file-set-mismatch");
  const { style, evaluation } = lock.productDefaults;
  return {
    schemaVersion: 1,
    declarationPath: lock.productDefaults.declarationPath,
    declarationSha256: declaration.sha256,
    resources: [
      {
        kind: "style-profile",
        id: style.barId,
        layer: "product",
        version: style.version,
        sha256: style.sha256,
      },
      {
        kind: "evaluation-profile",
        id: evaluation.barId,
        layer: "product",
        version: evaluation.version,
        sha256: evaluation.sha256,
      },
    ],
    unresolvedLayers: ["organization", "target", "request"],
  };
}

async function verifyQualityPackEvidence(options: {
  qualityPackDirectory: string;
  qualityDirectory: string;
  skillCrateDirectory: string;
}): Promise<QualityPackEvidenceV1> {
  return (await verifyQualityPack(options)).evidence;
}

export {
  verifyQualityPack as verifyQualityPackContext,
  verifyQualityPackEvidence as verifyQualityPack,
};
