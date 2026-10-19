// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed sealed decoders for the multi-unit doc-improvement campaign. Binds
 * each work-unit fingerprint to its machine-contract digest.
 */

import { basename, join } from "node:path";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";

import {
  pinAcceptanceEvidenceDirectory,
  assertAcceptanceEvidenceDirectory,
  type AcceptanceEvidenceDirectory,
} from "../acceptance-evidence.js";
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import {
  decodeWorkUnitMachineContract,
  type WorkUnitMachineContractV1,
} from "../maturity/work-unit-machine-contract.js";

export const MULTI_UNIT_DOC_IMPROVEMENT_CAMPAIGN_KIND =
  "multi-unit-doc-improvement-campaign" as const;
export const MULTI_UNIT_DOC_IMPROVEMENT_UNIT_QUEUE_KIND =
  "multi-unit-doc-improvement-unit-queue" as const;
export const MULTI_UNIT_DOC_IMPROVEMENT_PROGRESS_KIND =
  "multi-unit-doc-improvement-progress" as const;

export const MULTI_UNIT_DOC_IMPROVEMENT_SCHEMA_VERSION = 1 as const;

/** Absolute hard caps. */
export const MULTI_UNIT_MAX_UNITS = 5 as const;
export const MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT = 3 as const;
export const MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS = 15 as const;

export const MULTI_UNIT_STOP_REASONS = [
  "complete",
  "cap-exhausted",
  "plateau",
  "authorization-revoked",
  "review-failed",
  "operator-stop",
] as const;
export type MultiUnitStopReason = (typeof MULTI_UNIT_STOP_REASONS)[number];

export const MULTI_UNIT_REQUIRED_JSON_LEAVES = [
  "declaration.json",
  "unit-queue.json",
  "progress.json",
] as const;

export const MULTI_UNIT_UNITS_DIRECTORY = "units" as const;

const SAFE_CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_JSON_LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface MultiUnitCampaignCapsV1 {
  maxUnits: number;
  maxAttemptsPerUnit: number;
  maxCampaignAttempts: number;
}

export interface MultiUnitDocImprovementDeclarationBodyV1 {
  campaignId: string;
  repositoryId: string;
  testedCommit: string;
  repositoryIdentitySha256: string;
  caps: MultiUnitCampaignCapsV1;
  generatedAt: string;
}

export type MultiUnitDocImprovementDeclarationV1 = MultiUnitDocImprovementDeclarationBodyV1 & {
  schemaVersion: typeof MULTI_UNIT_DOC_IMPROVEMENT_SCHEMA_VERSION;
  kind: typeof MULTI_UNIT_DOC_IMPROVEMENT_CAMPAIGN_KIND;
  digest: string;
};

export interface MultiUnitQueueEntryV1 {
  workUnitFingerprint: string;
  machineContractSha256: string;
}

export interface MultiUnitDocImprovementUnitQueueBodyV1 {
  campaignId: string;
  declarationDigest: string;
  units: readonly MultiUnitQueueEntryV1[];
}

export type MultiUnitDocImprovementUnitQueueV1 = MultiUnitDocImprovementUnitQueueBodyV1 & {
  schemaVersion: typeof MULTI_UNIT_DOC_IMPROVEMENT_SCHEMA_VERSION;
  kind: typeof MULTI_UNIT_DOC_IMPROVEMENT_UNIT_QUEUE_KIND;
  digest: string;
};

export interface MultiUnitDocImprovementProgressBodyV1 {
  campaignId: string;
  declarationDigest: string;
  unitQueueDigest: string;
  queueIndex: number;
  unitAttempts: number;
  campaignAttempts: number;
  stopReason: MultiUnitStopReason | null;
  updatedAt: string;
}

export type MultiUnitDocImprovementProgressV1 = MultiUnitDocImprovementProgressBodyV1 & {
  schemaVersion: typeof MULTI_UNIT_DOC_IMPROVEMENT_SCHEMA_VERSION;
  kind: typeof MULTI_UNIT_DOC_IMPROVEMENT_PROGRESS_KIND;
  digest: string;
};

export type MultiUnitDocImprovementErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "cap-exceeded"
  | "missing-machine-contract"
  | "machine-contract-mismatch"
  | "unsafe-unit-leaf"
  | "unsafe-private-directory"
  | "binding-mismatch";

export class MultiUnitDocImprovementError extends Error {
  public constructor(public readonly code: MultiUnitDocImprovementErrorCode) {
    super(`Multi-unit documentation-improvement campaign rejected: ${code}.`);
    this.name = "MultiUnitDocImprovementError";
  }
}

function fail(code: MultiUnitDocImprovementErrorCode): never {
  throw new MultiUnitDocImprovementError(code);
}

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  enumeration,
  hash,
  revision,
  timestamp,
  seal,
  decodeSealed,
  unique,
  compare,
} = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const DECLARATION_BODY_KEYS = [
  "campaignId",
  "repositoryId",
  "testedCommit",
  "repositoryIdentitySha256",
  "caps",
  "generatedAt",
] as const;

const UNIT_QUEUE_BODY_KEYS = ["campaignId", "declarationDigest", "units"] as const;

const PROGRESS_BODY_KEYS = [
  "campaignId",
  "declarationDigest",
  "unitQueueDigest",
  "queueIndex",
  "unitAttempts",
  "campaignAttempts",
  "stopReason",
  "updatedAt",
] as const;

function campaignId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_CAMPAIGN_ID.test(value)) {
    fail("invalid-value");
  }
  return value;
}

function repositoryId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REPOSITORY_ID.test(value)) {
    fail("invalid-value");
  }
  return value;
}

function positiveCap(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid-value");
  }
  if ((value as number) > maximum) fail("cap-exceeded");
  return value as number;
}

function nonNegativeBounded(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid-value");
  }
  if ((value as number) > maximum) fail("cap-exceeded");
  return value as number;
}

/**
 * Unit directory leaf under `units/` must be exactly the work-unit fingerprint.
 * Rejects path traversal, separators, and non-digest names.
 */
export function assertSafeUnitLeafName(value: unknown): string {
  if (typeof value !== "string") fail("unsafe-unit-leaf");
  if (
    value !== basename(value) ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    value === "." ||
    value === ".." ||
    !/^[a-f0-9]{64}$/u.test(value)
  ) {
    fail("unsafe-unit-leaf");
  }
  return value;
}

function normalizeCaps(value: unknown): MultiUnitCampaignCapsV1 {
  const root = object(value);
  exact(root, ["maxUnits", "maxAttemptsPerUnit", "maxCampaignAttempts"]);
  return deepFreeze({
    maxUnits: positiveCap(root.maxUnits, MULTI_UNIT_MAX_UNITS),
    maxAttemptsPerUnit: positiveCap(root.maxAttemptsPerUnit, MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT),
    maxCampaignAttempts: positiveCap(root.maxCampaignAttempts, MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS),
  });
}

function normalizeQueueEntry(value: unknown): MultiUnitQueueEntryV1 {
  const root = object(value);
  exact(root, ["workUnitFingerprint", "machineContractSha256"]);
  if (!("machineContractSha256" in root) || root.machineContractSha256 == null) {
    fail("missing-machine-contract");
  }
  const workUnitFingerprint = hash(root.workUnitFingerprint);
  assertSafeUnitLeafName(workUnitFingerprint);
  return deepFreeze({
    workUnitFingerprint,
    machineContractSha256: hash(root.machineContractSha256),
  });
}

function normalizeUnits(value: unknown): readonly MultiUnitQueueEntryV1[] {
  const entries = array(value).map(normalizeQueueEntry);
  if (entries.length > MULTI_UNIT_MAX_UNITS) fail("cap-exceeded");
  unique(entries.map((entry) => entry.workUnitFingerprint));
  return Object.freeze(entries);
}

function normalizeStopReason(value: unknown): MultiUnitStopReason | null {
  if (value === null) return null;
  return enumeration(value, MULTI_UNIT_STOP_REASONS);
}

function normalizeDeclarationBody(
  root: Record<string, unknown>,
): MultiUnitDocImprovementDeclarationBodyV1 {
  return {
    campaignId: campaignId(root.campaignId),
    repositoryId: repositoryId(root.repositoryId),
    testedCommit: revision(root.testedCommit),
    repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
    caps: normalizeCaps(root.caps),
    generatedAt: timestamp(root.generatedAt),
  };
}

function normalizeUnitQueueBody(
  root: Record<string, unknown>,
): MultiUnitDocImprovementUnitQueueBodyV1 {
  return {
    campaignId: campaignId(root.campaignId),
    declarationDigest: hash(root.declarationDigest),
    units: normalizeUnits(root.units),
  };
}

function normalizeProgressBody(
  root: Record<string, unknown>,
): MultiUnitDocImprovementProgressBodyV1 {
  return {
    campaignId: campaignId(root.campaignId),
    declarationDigest: hash(root.declarationDigest),
    unitQueueDigest: hash(root.unitQueueDigest),
    queueIndex: nonNegativeBounded(root.queueIndex, MULTI_UNIT_MAX_UNITS),
    unitAttempts: nonNegativeBounded(root.unitAttempts, MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT),
    campaignAttempts: nonNegativeBounded(root.campaignAttempts, MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS),
    stopReason: normalizeStopReason(root.stopReason),
    updatedAt: timestamp(root.updatedAt),
  };
}

export function createMultiUnitDocImprovementDeclaration(
  input: MultiUnitDocImprovementDeclarationBodyV1,
): MultiUnitDocImprovementDeclarationV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...DECLARATION_BODY_KEYS]);
  return seal(
    MULTI_UNIT_DOC_IMPROVEMENT_CAMPAIGN_KIND,
    "digest",
    normalizeDeclarationBody(root),
  ) as MultiUnitDocImprovementDeclarationV1;
}

export function decodeMultiUnitDocImprovementDeclaration(
  value: unknown,
): MultiUnitDocImprovementDeclarationV1 {
  return decodeSealed(
    value,
    MULTI_UNIT_DOC_IMPROVEMENT_CAMPAIGN_KIND,
    "digest",
    [...DECLARATION_BODY_KEYS],
    normalizeDeclarationBody,
  ) as MultiUnitDocImprovementDeclarationV1;
}

export function createMultiUnitDocImprovementUnitQueue(
  input: MultiUnitDocImprovementUnitQueueBodyV1,
): MultiUnitDocImprovementUnitQueueV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...UNIT_QUEUE_BODY_KEYS]);
  return seal(
    MULTI_UNIT_DOC_IMPROVEMENT_UNIT_QUEUE_KIND,
    "digest",
    normalizeUnitQueueBody(root),
  ) as MultiUnitDocImprovementUnitQueueV1;
}

export function decodeMultiUnitDocImprovementUnitQueue(
  value: unknown,
): MultiUnitDocImprovementUnitQueueV1 {
  return decodeSealed(
    value,
    MULTI_UNIT_DOC_IMPROVEMENT_UNIT_QUEUE_KIND,
    "digest",
    [...UNIT_QUEUE_BODY_KEYS],
    normalizeUnitQueueBody,
  ) as MultiUnitDocImprovementUnitQueueV1;
}

export function createMultiUnitDocImprovementProgress(
  input: MultiUnitDocImprovementProgressBodyV1,
): MultiUnitDocImprovementProgressV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...PROGRESS_BODY_KEYS]);
  return seal(
    MULTI_UNIT_DOC_IMPROVEMENT_PROGRESS_KIND,
    "digest",
    normalizeProgressBody(root),
  ) as MultiUnitDocImprovementProgressV1;
}

export function decodeMultiUnitDocImprovementProgress(
  value: unknown,
): MultiUnitDocImprovementProgressV1 {
  return decodeSealed(
    value,
    MULTI_UNIT_DOC_IMPROVEMENT_PROGRESS_KIND,
    "digest",
    [...PROGRESS_BODY_KEYS],
    normalizeProgressBody,
  ) as MultiUnitDocImprovementProgressV1;
}

/** Missing or mismatched digests or fingerprints fail closed. */
export function bindUnitQueueMachineContracts(
  queue: MultiUnitDocImprovementUnitQueueV1,
  envelopes: readonly unknown[],
): readonly WorkUnitMachineContractV1[] {
  if (envelopes.length !== queue.units.length) fail("binding-mismatch");
  const bound: WorkUnitMachineContractV1[] = [];
  for (let index = 0; index < queue.units.length; index += 1) {
    const entry = queue.units[index]!;
    const envelopeValue = envelopes[index];
    if (envelopeValue === null || envelopeValue === undefined) {
      fail("missing-machine-contract");
    }
    let contract: WorkUnitMachineContractV1;
    try {
      contract = decodeWorkUnitMachineContract(envelopeValue);
    } catch {
      fail("machine-contract-mismatch");
    }
    if (
      contract.workUnitFingerprint !== entry.workUnitFingerprint ||
      contract.machineContractSha256 !== entry.machineContractSha256
    ) {
      fail("machine-contract-mismatch");
    }
    bound.push(contract);
  }
  return Object.freeze(bound);
}

/** Cross-bind declaration, unit queue, and progress against declared caps. */
export function bindMultiUnitCampaignLedger(input: {
  declaration: MultiUnitDocImprovementDeclarationV1;
  unitQueue: MultiUnitDocImprovementUnitQueueV1;
  progress: MultiUnitDocImprovementProgressV1;
}): {
  declaration: MultiUnitDocImprovementDeclarationV1;
  unitQueue: MultiUnitDocImprovementUnitQueueV1;
  progress: MultiUnitDocImprovementProgressV1;
} {
  const { declaration, unitQueue, progress } = input;
  if (
    unitQueue.campaignId !== declaration.campaignId ||
    unitQueue.declarationDigest !== declaration.digest
  ) {
    fail("binding-mismatch");
  }
  if (unitQueue.units.length > declaration.caps.maxUnits) fail("cap-exceeded");
  if (
    progress.campaignId !== declaration.campaignId ||
    progress.declarationDigest !== declaration.digest ||
    progress.unitQueueDigest !== unitQueue.digest
  ) {
    fail("binding-mismatch");
  }
  if (progress.queueIndex > unitQueue.units.length) fail("invalid-value");
  if (progress.unitAttempts > declaration.caps.maxAttemptsPerUnit) {
    fail("cap-exceeded");
  }
  if (progress.campaignAttempts > declaration.caps.maxCampaignAttempts) {
    fail("cap-exceeded");
  }
  return { declaration, unitQueue, progress };
}

function assertPrivateDirectoryStat(stat: Stats, uid: number): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("unsafe-private-directory");
  }
  if (stat.uid !== uid) fail("unsafe-private-directory");
  if ((stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    fail("unsafe-private-directory");
  }
}

function assertPrivateFileStat(stat: Stats, uid: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) fail("unsafe-private-directory");
  if (stat.uid !== uid) fail("unsafe-private-directory");
  if (stat.nlink !== 1) fail("unsafe-private-directory");
  if ((stat.mode & 0o7777) !== PRIVATE_FILE_MODE) {
    fail("unsafe-private-directory");
  }
}

async function assertNamedPrivateFile(
  directory: AcceptanceEvidenceDirectory,
  file: string,
): Promise<void> {
  if (!SAFE_JSON_LEAF.test(file) || file !== basename(file)) {
    fail("unsafe-private-directory");
  }
  const path = join(directory.path, file);
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    assertPrivateFileStat(before, directory.uid);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptor = await handle.stat();
    assertPrivateFileStat(descriptor, directory.uid);
    if (descriptor.dev !== before.dev || descriptor.ino !== before.ino) {
      fail("unsafe-private-directory");
    }
  } catch (error) {
    if (error instanceof MultiUnitDocImprovementError) throw error;
    fail("unsafe-private-directory");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertNamedPrivateDirectory(
  parent: AcceptanceEvidenceDirectory,
  name: string,
): Promise<string> {
  if (name !== basename(name) || name.includes("..") || name.includes("/")) {
    fail("unsafe-unit-leaf");
  }
  const path = join(parent.path, name);
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    assertPrivateDirectoryStat(before, parent.uid);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const descriptor = await handle.stat();
    assertPrivateDirectoryStat(descriptor, parent.uid);
    if (descriptor.dev !== before.dev || descriptor.ino !== before.ino) {
      fail("unsafe-private-directory");
    }
    const canonical = await realpath(path);
    if (
      basename(canonical) !== name ||
      (await realpath(join(canonical, ".."))) !== parent.canonicalPath
    ) {
      fail("unsafe-private-directory");
    }
    return path;
  } catch (error) {
    if (error instanceof MultiUnitDocImprovementError) throw error;
    return fail("unsafe-private-directory");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertUnitSubtree(
  campaign: AcceptanceEvidenceDirectory,
  fingerprint: string,
): Promise<void> {
  const leaf = assertSafeUnitLeafName(fingerprint);
  const unitsRoot = join(campaign.path, MULTI_UNIT_UNITS_DIRECTORY);
  const unitPath = join(unitsRoot, leaf);
  if (unitPath.includes("..") || basename(unitPath) !== leaf) {
    fail("unsafe-unit-leaf");
  }
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(unitPath);
    assertPrivateDirectoryStat(before, campaign.uid);
    handle = await open(
      unitPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat();
    assertPrivateDirectoryStat(descriptor, campaign.uid);
    const entries = await readdir(unitPath);
    for (const entry of entries) {
      if (!SAFE_JSON_LEAF.test(entry) || entry !== basename(entry)) {
        fail("unsafe-unit-leaf");
      }
      const leafPath = join(unitPath, entry);
      const leafStat = await lstat(leafPath);
      assertPrivateFileStat(leafStat, campaign.uid);
    }
  } catch (error) {
    if (error instanceof MultiUnitDocImprovementError) throw error;
    fail("unsafe-private-directory");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Fail-closed private campaign directory layout check (0700 / 0600). */
export async function assertMultiUnitCampaignPrivateDirectory(input: {
  directory: string;
  declaration: MultiUnitDocImprovementDeclarationV1;
  unitQueue: MultiUnitDocImprovementUnitQueueV1;
}): Promise<AcceptanceEvidenceDirectory> {
  const { declaration, unitQueue } = input;
  if (
    unitQueue.campaignId !== declaration.campaignId ||
    unitQueue.declarationDigest !== declaration.digest ||
    unitQueue.units.length > declaration.caps.maxUnits
  ) {
    fail("binding-mismatch");
  }
  let pinned: AcceptanceEvidenceDirectory;
  try {
    pinned = await pinAcceptanceEvidenceDirectory(input.directory);
    await assertAcceptanceEvidenceDirectory(pinned);
  } catch (error) {
    if (error instanceof MultiUnitDocImprovementError) throw error;
    fail("unsafe-private-directory");
  }

  const entries = await readdir(pinned.path, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort(compare);
  for (const required of MULTI_UNIT_REQUIRED_JSON_LEAVES) {
    if (!names.includes(required)) fail("unsafe-private-directory");
  }
  if (!names.includes(MULTI_UNIT_UNITS_DIRECTORY)) {
    fail("unsafe-private-directory");
  }

  for (const entry of entries) {
    if (entry.name === MULTI_UNIT_UNITS_DIRECTORY) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail("unsafe-private-directory");
      }
      continue;
    }
    if (!SAFE_JSON_LEAF.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail("unsafe-private-directory");
    }
  }

  for (const leaf of names) {
    if (leaf === MULTI_UNIT_UNITS_DIRECTORY) continue;
    await assertNamedPrivateFile(pinned, leaf);
  }

  await assertNamedPrivateDirectory(pinned, MULTI_UNIT_UNITS_DIRECTORY);
  const unitsPath = join(pinned.path, MULTI_UNIT_UNITS_DIRECTORY);
  const unitDirs = (await readdir(unitsPath)).sort(compare);
  const expected = [...unitQueue.units.map((entry) => entry.workUnitFingerprint)].sort(compare);
  if (
    unitDirs.length !== expected.length ||
    unitDirs.some((name, index) => name !== expected[index])
  ) {
    fail("unsafe-private-directory");
  }
  for (const fingerprint of expected) {
    await assertUnitSubtree(pinned, fingerprint);
  }

  await assertAcceptanceEvidenceDirectory(pinned);
  return pinned;
}
