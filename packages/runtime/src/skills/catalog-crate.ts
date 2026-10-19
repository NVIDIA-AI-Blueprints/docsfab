// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CATALOG_SKILL_IDS, catalogSkillSourcePath } from "./catalog-ids.js";
/**
 * Pin B (hashed skill bytes and tools): fail-closed verification for the
 * packaged catalog skill crate. Workflow step ids select entries from the
 * closed lock; runtime never scans the authoring catalog at execution time.
 */
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseJsonEvidence } from "../json-evidence.js";
import type { SkillEvidence, SkillInterfaceField } from "../records/contracts.js";
import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
} from "../security/repository-scanner.js";
import { sha256 } from "../content-ir/canonical.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export { CATALOG_SKILL_IDS } from "./catalog-ids.js";

export type CatalogSkillId = (typeof CATALOG_SKILL_IDS)[number];
export type CatalogSkillCrateErrorCode =
  | "lock-unavailable"
  | "invalid-lock"
  | "stale"
  | "tampered"
  | "duplicate"
  | "privilege-expanding"
  | "unresolved-declared-tool"
  | "unsafe-path"
  | "file-set-mismatch"
  | "checksum-mismatch";

const ERROR_MESSAGES: Readonly<Record<CatalogSkillCrateErrorCode, string>> = {
  "lock-unavailable": "Catalog skill crate lock file is unavailable for verification.",
  "invalid-lock": "Catalog skill crate lock failed closed schema or credential validation.",
  stale: "Catalog skill version or content digest is stale against the requested identity.",
  tampered: "Catalog skill bytes failed closed integrity verification.",
  duplicate: "Catalog skill crate lock contains a duplicate identity.",
  "privilege-expanding": "Catalog skill grants tools beyond the workflow step policy.",
  "unresolved-declared-tool":
    "Catalog skill declares a tool name that no registered DocsFab tool provides.",
  "unsafe-path": "Catalog skill crate contains an unsafe filesystem path.",
  "file-set-mismatch": "Catalog skill on-disk file set does not match the crate lock.",
  "checksum-mismatch": "Catalog skill file or bundle checksum does not match the crate lock.",
};

export class CatalogSkillCrateError extends Error {
  public readonly code: CatalogSkillCrateErrorCode;

  public constructor(code: CatalogSkillCrateErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "CatalogSkillCrateError";
    this.code = code;
  }
}

interface LockedSource {
  repository: string;
  revision: string;
}

export interface LockedFile {
  path: string;
  sha256: string;
}

interface LockedToolPolicy {
  declared: string[];
  granted: string[];
  withheld: string[];
}

export interface LockedCatalogSkill {
  id: CatalogSkillId;
  version: string;
  license: string;
  provenanceStatus: "docsfab-local";
  source: LockedSource;
  sourcePath: string;
  /** Path relative to the directory containing lock.json. */
  skillRoot: string;
  contentSha256: string;
  bundleSha256: string;
  files: LockedFile[];
  inputs: SkillInterfaceField[];
  outputs: SkillInterfaceField[];
  toolPolicy: LockedToolPolicy;
}

export interface CatalogSkillCrateLock {
  schemaVersion: 1;
  bundleHashFormat: "sha256-lines-v1";
  contractHashFormat: "sha256-catalog-skill-contract-v1";
  skills: LockedCatalogSkill[];
}

export interface VerifiedCatalogSkill {
  evidence: SkillEvidence;
  directory: string;
  skill: LockedCatalogSkill;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogSkillCrateError("invalid-lock", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CatalogSkillCrateError("invalid-lock", `${label} contains unexpected keys.`);
  }
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CatalogSkillCrateError("invalid-lock", `${label} must be a non-empty string.`);
  }
  return value;
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CatalogSkillCrateError("invalid-lock", `${label} must be an array of strings.`);
  }
  return [...value] as string[];
}

function hashValue(value: unknown, label: string): string {
  const hash = textValue(value, label);
  if (!SHA256.test(hash)) {
    throw new CatalogSkillCrateError("invalid-lock", `${label} must be a lowercase SHA-256.`);
  }
  return hash;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = textValue(value, label);
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      `${label} must stay inside the catalog skill crate.`,
    );
  }
  return path;
}

function interfaceFields(value: unknown, label: string): SkillInterfaceField[] {
  if (!Array.isArray(value)) {
    throw new CatalogSkillCrateError("invalid-lock", `${label} must be an array.`);
  }
  return value.map((item, index) => {
    const field = record(item, `${label}[${index}]`);
    exact(field, ["name", "description"], `${label}[${index}]`);
    return {
      name: textValue(field.name, `${label}[${index}].name`),
      description: textValue(field.description, `${label}[${index}].description`),
    };
  });
}

function sourceValue(value: unknown, label: string): LockedSource {
  const source = record(value, label);
  exact(source, ["repository", "revision"], label);
  const repository = textValue(source.repository, `${label}.repository`);
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      `${label}.repository must be an HTTPS URL without credentials.`,
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      `${label}.repository must be an HTTPS URL without credentials.`,
    );
  }
  const revision = textValue(source.revision, `${label}.revision`);
  if (!GIT_OBJECT_ID.test(revision)) {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      `${label}.revision must be a full lowercase Git object ID.`,
    );
  }
  return { repository, revision };
}

function parseSkill(value: unknown, index: number): LockedCatalogSkill {
  const label = `skills[${index}]`;
  const item = record(value, label);
  exact(
    item,
    [
      "id",
      "version",
      "license",
      "provenanceStatus",
      "source",
      "sourcePath",
      "skillRoot",
      "contentSha256",
      "bundleSha256",
      "files",
      "inputs",
      "outputs",
      "toolPolicy",
    ],
    label,
  );
  const id = textValue(item.id, `${label}.id`);
  if (!CATALOG_SKILL_IDS.includes(id as CatalogSkillId)) {
    throw new CatalogSkillCrateError("invalid-lock", `${label}.id is not a catalog skill id.`);
  }
  if (item.provenanceStatus !== "docsfab-local") {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      `${label}.provenanceStatus must be docsfab-local.`,
    );
  }
  const sourcePath = safeRelativePath(item.sourcePath, `${label}.sourcePath`);
  const skillRoot = safeRelativePath(item.skillRoot, `${label}.skillRoot`);
  if (sourcePath !== catalogSkillSourcePath(id) || skillRoot !== id) {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      `${label} must bind the canonical source path to its colocated crate root.`,
    );
  }
  if (!Array.isArray(item.files) || item.files.length === 0) {
    throw new CatalogSkillCrateError("invalid-lock", `${label}.files must be a non-empty array.`);
  }
  const files = item.files.map((fileValue, fileIndex) => {
    const fileLabel = `${label}.files[${fileIndex}]`;
    const file = record(fileValue, fileLabel);
    exact(file, ["path", "sha256"], fileLabel);
    return {
      path: safeRelativePath(file.path, `${fileLabel}.path`),
      sha256: hashValue(file.sha256, `${fileLabel}.sha256`),
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new CatalogSkillCrateError("duplicate", `${label}.files contains duplicate paths.`);
  }
  const policy = record(item.toolPolicy, `${label}.toolPolicy`);
  exact(policy, ["declared", "granted", "withheld"], `${label}.toolPolicy`);
  return {
    id: id as CatalogSkillId,
    version: textValue(item.version, `${label}.version`),
    license: textValue(item.license, `${label}.license`),
    provenanceStatus: "docsfab-local",
    source: sourceValue(item.source, `${label}.source`),
    sourcePath,
    skillRoot,
    contentSha256: hashValue(item.contentSha256, `${label}.contentSha256`),
    bundleSha256: hashValue(item.bundleSha256, `${label}.bundleSha256`),
    files,
    inputs: interfaceFields(item.inputs, `${label}.inputs`),
    outputs: interfaceFields(item.outputs, `${label}.outputs`),
    toolPolicy: {
      declared: textArray(policy.declared, `${label}.toolPolicy.declared`),
      granted: textArray(policy.granted, `${label}.toolPolicy.granted`),
      withheld: textArray(policy.withheld, `${label}.toolPolicy.withheld`),
    },
  };
}

export function parseCatalogSkillCrateLock(value: unknown): CatalogSkillCrateLock {
  if (detectCredentialRuleIdsInValue(value).length > 0) {
    throw new CatalogSkillCrateError("invalid-lock");
  }
  const lock = record(value, "catalog skill crate lock");
  exact(
    lock,
    ["schemaVersion", "bundleHashFormat", "contractHashFormat", "skills"],
    "catalog skill crate lock",
  );
  if (
    lock.schemaVersion !== 1 ||
    lock.bundleHashFormat !== "sha256-lines-v1" ||
    lock.contractHashFormat !== "sha256-catalog-skill-contract-v1" ||
    !Array.isArray(lock.skills)
  ) {
    throw new CatalogSkillCrateError("invalid-lock");
  }
  const skills = lock.skills.map(parseSkill);
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    throw new CatalogSkillCrateError("duplicate");
  }
  if (JSON.stringify(skills.map((skill) => skill.id)) !== JSON.stringify(CATALOG_SKILL_IDS)) {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      "Catalog skill crate lock must contain the exact ordered public skill catalog.",
    );
  }
  return {
    schemaVersion: 1,
    bundleHashFormat: "sha256-lines-v1",
    contractHashFormat: "sha256-catalog-skill-contract-v1",
    skills,
  };
}

function bundleManifest(files: LockedFile[]): string {
  return [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => `${file.sha256}  ${file.path}\n`)
    .join("");
}

function staysInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function listFiles(directory: string, skillId: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new CatalogSkillCrateError(
        "unsafe-path",
        `Catalog skill "${skillId}" contains an unsafe symbolic link: ${path}.`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, skillId, path)));
    } else if (entry.isFile()) {
      const metadata = await lstat(resolve(directory, path));
      if (metadata.nlink !== 1) {
        throw new CatalogSkillCrateError(
          "unsafe-path",
          `Catalog skill "${skillId}" contains an unsafe hard link: ${path}.`,
        );
      }
      files.push(path);
    }
  }
  return files.sort();
}

async function assertContainedPath(
  root: string,
  candidate: string,
  skillId: string,
  displayedPath: string,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!staysInside(resolvedRoot, resolvedCandidate)) {
    throw new CatalogSkillCrateError(
      "unsafe-path",
      `Catalog skill "${skillId}" contains an unsafe path: ${displayedPath}.`,
    );
  }
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  let component = resolvedRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    component = resolve(component, segment);
    if ((await lstat(component)).isSymbolicLink()) {
      throw new CatalogSkillCrateError(
        "unsafe-path",
        `Catalog skill "${skillId}" contains an unsafe path: ${displayedPath}.`,
      );
    }
  }
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(resolvedRoot),
    realpath(resolvedCandidate),
  ]);
  if (!staysInside(canonicalRoot, canonicalCandidate)) {
    throw new CatalogSkillCrateError(
      "unsafe-path",
      `Catalog skill "${skillId}" contains an unsafe path: ${displayedPath}.`,
    );
  }
}

async function verifyBundle(
  skillCrateDirectory: string,
  skill: LockedCatalogSkill,
): Promise<string> {
  const directory = resolve(skillCrateDirectory, skill.skillRoot);
  await assertContainedPath(skillCrateDirectory, directory, skill.id, skill.skillRoot);
  const actualFiles = await listFiles(directory, skill.id);
  const declaredFiles = skill.files.map((file) => file.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    throw new CatalogSkillCrateError(
      "file-set-mismatch",
      `Catalog skill "${skill.id}" file set does not match skill-crate/lock.json.`,
    );
  }
  for (const file of skill.files) {
    const path = resolve(directory, file.path);
    await assertContainedPath(directory, path, skill.id, file.path);
    if (sha256(await readFile(path)) !== file.sha256) {
      throw new CatalogSkillCrateError(
        "checksum-mismatch",
        `Catalog skill "${skill.id}" checksum mismatch: ${file.path}.`,
      );
    }
  }
  if (sha256(bundleManifest(skill.files)) !== skill.bundleSha256) {
    throw new CatalogSkillCrateError(
      "checksum-mismatch",
      `Catalog skill "${skill.id}" bundle checksum mismatch.`,
    );
  }
  return directory;
}

function assertToolGrant(skill: LockedCatalogSkill, grantedTools: readonly string[]): void {
  if (JSON.stringify(skill.toolPolicy.granted) !== JSON.stringify([...grantedTools])) {
    throw new CatalogSkillCrateError(
      "privilege-expanding",
      `Catalog skill "${skill.id}" tool grant does not match the workflow step policy.`,
    );
  }
  const withheld = new Set(skill.toolPolicy.withheld.map((tool) => tool.toLowerCase()));
  if (skill.toolPolicy.granted.some((tool) => withheld.has(tool.toLowerCase()))) {
    throw new CatalogSkillCrateError(
      "privilege-expanding",
      `Catalog skill "${skill.id}" grants a withheld tool.`,
    );
  }
  assertDeclaredToolsResolve(skill);
}

/**
 * Every declared name must resolve to a tool the model actually has. `granted`
 * is proven equal to the step's harness grant immediately above, so membership
 * in `granted` is membership in the registered tool set.
 *
 * The comparison is exact, not case-folded, because tool dispatch is exact: a
 * Claude-style `Read` against a registered `read` is an unregistered name, and
 * an agent loop answers it with a synthetic "Tool Read not found" result before
 * host preflight runs. Fails closed on both local and hosted paths; the crate
 * lock ships inside the release that reads it, so no sealed run can present an
 * older declared list to newer code.
 */
function assertDeclaredToolsResolve(skill: LockedCatalogSkill): void {
  const granted = new Set(skill.toolPolicy.granted);
  const unresolved = skill.toolPolicy.declared
    .filter((tool) => !granted.has(tool))
    .map((tool) => `"${tool}"`)
    .join(", ");
  if (unresolved !== "") {
    // hygiene: envelope
    throw new CatalogSkillCrateError(
      "unresolved-declared-tool",
      `Catalog skill "${skill.id}" declares ${unresolved}, which no registered DocsFab tool provides.`,
    );
  }
}

export function findLockedCatalogFile(
  skill: LockedCatalogSkill,
  relativePath: string,
): LockedFile | undefined {
  return skill.files.find((file) => file.path === relativePath);
}

/**
 * Read one already-locked file from a verified catalog skill. Callers must
 * pass the result of `verifyCatalogSkill`; this re-checks the exact-file hash
 * and does not scan `packages/skills`.
 */
export async function readVerifiedCatalogFile(
  verified: VerifiedCatalogSkill,
  relativePath: string,
): Promise<Buffer> {
  const locked = findLockedCatalogFile(verified.skill, relativePath);
  if (!locked) {
    // hygiene: envelope
    throw new CatalogSkillCrateError(
      "file-set-mismatch",
      `Catalog skill "${verified.skill.id}" does not lock ${relativePath}.`,
    );
  }
  const path = resolve(verified.directory, relativePath);
  let bytes: Buffer;
  try {
    await assertContainedPath(verified.directory, path, verified.skill.id, relativePath);
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof CatalogSkillCrateError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // hygiene: envelope
      throw new CatalogSkillCrateError(
        "file-set-mismatch",
        `Catalog skill "${verified.skill.id}" does not lock ${relativePath}.`,
      );
    }
    throw error;
  }
  if (sha256(bytes) !== locked.sha256) {
    // hygiene: envelope
    throw new CatalogSkillCrateError(
      "checksum-mismatch",
      `Catalog skill "${verified.skill.id}" checksum mismatch: ${relativePath}.`,
    );
  }
  return bytes;
}

export async function readCatalogSkillCrateLock(
  skillCrateDirectory: string,
): Promise<CatalogSkillCrateLock> {
  const path = resolve(skillCrateDirectory, "lock.json");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CatalogSkillCrateError("lock-unavailable");
    }
    throw error;
  }
  if (detectCredentialRuleIds(contents).length > 0) {
    throw new CatalogSkillCrateError("invalid-lock");
  }
  try {
    return parseCatalogSkillCrateLock(parseJsonEvidence(contents));
  } catch (error) {
    if (error instanceof CatalogSkillCrateError) throw error;
    throw new CatalogSkillCrateError("invalid-lock");
  }
}

export function findCatalogSkill(
  lock: CatalogSkillCrateLock,
  skillId: string,
): LockedCatalogSkill | undefined {
  return lock.skills.find((skill) => skill.id === skillId);
}

export async function verifyCatalogSkill(options: {
  skillCrateDirectory: string;
  skillId: string;
  grantedTools: readonly string[];
  expectedVersion?: string;
  expectedContentSha256?: string;
}): Promise<VerifiedCatalogSkill> {
  const lock = await readCatalogSkillCrateLock(options.skillCrateDirectory);
  const skill = findCatalogSkill(lock, options.skillId);
  if (!skill) {
    throw new CatalogSkillCrateError(
      "invalid-lock",
      `Catalog skill "${options.skillId}" is missing from skill-crate/lock.json.`,
    );
  }
  if (options.expectedVersion !== undefined && options.expectedVersion !== skill.version) {
    throw new CatalogSkillCrateError("stale", `Catalog skill "${skill.id}" version is stale.`);
  }
  if (
    options.expectedContentSha256 !== undefined &&
    options.expectedContentSha256 !== skill.contentSha256
  ) {
    throw new CatalogSkillCrateError(
      "stale",
      `Catalog skill "${skill.id}" content digest is stale.`,
    );
  }
  assertToolGrant(skill, options.grantedTools);
  let directory: string;
  try {
    directory = await verifyBundle(options.skillCrateDirectory, skill);
  } catch (error) {
    if (error instanceof CatalogSkillCrateError) throw error;
    throw new CatalogSkillCrateError("tampered");
  }
  const skillFile = skill.files.find((file) => file.path === "SKILL.md");
  if (!skillFile || skillFile.sha256 !== skill.contentSha256) {
    throw new CatalogSkillCrateError(
      "checksum-mismatch",
      `Catalog skill "${skill.id}" does not lock SKILL.md content.`,
    );
  }
  return {
    directory,
    skill,
    evidence: {
      id: skill.id,
      contentSha256: skill.contentSha256,
      bundleSha256: skill.bundleSha256,
      version: skill.version,
      license: skill.license,
      provenanceStatus: skill.provenanceStatus,
      source: {
        repository: skill.source.repository,
        revision: skill.source.revision,
        path: skill.sourcePath,
      },
      inputs: skill.inputs,
      outputs: skill.outputs,
      toolPolicy: skill.toolPolicy,
    },
  };
}
