// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, rename, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  projectIssueApplyPresentation,
  projectIssuePreflightPresentation,
  renderAdvancedPresentation,
} from "../cli/advanced-presentation.js";
import { validateRoadmapLedger, type RoadmapLedger } from "./contracts/ledger.js";
import { LocalUserGitLabIssueAdapter } from "./gitlab-issue-adapter.js";
import { applyIssueLifecyclePlan, preflightIssueLifecyclePlan } from "./issue-lifecycle.js";
import { FileIssueLifecycleApplyLock, type IssueLifecycleApplyLock } from "./issue-lock.js";
import { SecurePathAuthority } from "./secure-path.js";
import {
  validateIssueLifecycleMaterialBundle,
  type IssueLifecycleProviderAdapter,
} from "./issue-adapter.js";
import {
  validateRoadmapMutationAuthorizationV2,
  validateRoadmapMutationPlanV2,
  validateRoadmapMutationReceiptV2,
  type RoadmapMutationAuthorizationV2,
  type RoadmapMutationPlanV2,
  type RoadmapMutationReceiptV2,
} from "./execution-v2.js";

export interface IssueLifecycleCliDependencies {
  cwd: string;
  log(message: string): void;
  adapter?: IssueLifecycleProviderAdapter;
  now?: () => Date;
  exclusive?: IssueLifecycleApplyLock;
}

export async function runIssueLifecycleCli(
  args: readonly string[],
  dependencies: IssueLifecycleCliDependencies,
): Promise<void> {
  const [phase, ...rest] = args;
  if (phase !== "preflight" && phase !== "apply")
    throw new Error("roadmap-issues requires preflight or apply.");
  const ledger = validateRoadmapLedger(
    await readPrivateJsonFile(required(rest, "--ledger"), dependencies.cwd),
  );
  const plan = validateRoadmapMutationPlanV2(
    await readPrivateJsonFile(required(rest, "--plan"), dependencies.cwd),
    ledger,
  );
  const materials = validateIssueLifecycleMaterialBundle(
    await readPrivateJsonFile(required(rest, "--material"), dependencies.cwd),
  );
  const adapter = dependencies.adapter ?? new LocalUserGitLabIssueAdapter();
  if (phase === "preflight") {
    rejectUnknown(rest, ["--ledger", "--plan", "--material", "--json"]);
    const result = await preflightIssueLifecyclePlan({ ledger, plan, materials, adapter });
    dependencies.log(
      rest.includes("--json")
        ? canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue)
        : renderAdvancedPresentation(projectIssuePreflightPresentation(result)),
    );
    return;
  }
  rejectUnknown(rest, [
    "--ledger",
    "--plan",
    "--material",
    "--authorization",
    "--receipt",
    "--confirm-plan-sha256",
    "--confirm-authorization-sha256",
    "--json",
  ]);
  const authorization = validateRoadmapMutationAuthorizationV2(
    await readPrivateJsonFile(required(rest, "--authorization"), dependencies.cwd),
    plan,
    ledger,
  );
  if (
    required(rest, "--confirm-plan-sha256") !== plan.digest ||
    required(rest, "--confirm-authorization-sha256") !== authorization.digest
  ) {
    throw new Error("Confirmed plan or authorization digest does not match the validated input.");
  }
  const receiptPath = resolve(dependencies.cwd, required(rest, "--receipt"));
  const result = await applyIssueLifecyclePlan({
    ledger,
    plan,
    authorization,
    materials,
    adapter,
    exclusive: dependencies.exclusive ?? new FileIssueLifecycleApplyLock(),
    loadReceipt: () => optionalReceipt(receiptPath, ledger, plan, authorization),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    persistReceipt: async (receipt) => persistPrivateJson(receiptPath, receipt),
  });
  dependencies.log(
    rest.includes("--json")
      ? canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue)
      : renderAdvancedPresentation(projectIssueApplyPresentation(result)),
  );
}

export async function readPrivateJsonFile(
  pathValue: string,
  cwd: string,
  hooks: { afterStat?: () => Promise<void>; afterParentPin?: () => Promise<void> } = {},
): Promise<unknown> {
  const path = resolve(cwd, pathValue);
  const authority = await SecurePathAuthority.bind(path);
  await hooks.afterParentPin?.();
  await authority.assertStable();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 2n ||
      before.size > BigInt(2 * 1024 * 1024) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("Roadmap input file is not a private owner-only regular file.");
    }
    await assertOpenedPathIdentity(path, before);
    await authority.assertStable();
    await hooks.afterStat?.();
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      bytes.byteLength !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Roadmap input file changed while it was read.");
    }
    await assertOpenedPathIdentity(path, after);
    await authority.assertStable();
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Roadmap input is not valid JSON.");
  }
}

async function optionalReceipt(
  path: string,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
): Promise<RoadmapMutationReceiptV2 | undefined> {
  try {
    return validateRoadmapMutationReceiptV2(
      await readPrivateJsonFile(path, "/"),
      ledger,
      plan,
      authorization,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function persistPrivateJsonFile(
  pathValue: string,
  value: JsonEvidenceValue,
  hooks: ReceiptPersistenceHooks = {},
): Promise<void> {
  const path = resolve(pathValue);
  const bytes = Buffer.from(`${canonicalizeJsonEvidence(value)}\n`, "utf8");
  if (bytes.byteLength > 2 * 1024 * 1024)
    throw new Error("Receipt JSON exceeds the private file size limit.");
  const authority = await SecurePathAuthority.bind(path, { createParents: true });
  await hooks.afterParentPin?.();
  await authority.assertStable();
  await assertReplaceableReceipt(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let temporaryHandle: FileHandle;
  try {
    temporaryHandle = await open(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    await authority.assertStable().catch(() => {
      throw new Error("Parent path changed during secure file access.");
    });
    throw error;
  }
  let finalHandle: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;
  try {
    await authority.refreshAfterParentMutation();
    await hooks.afterTemporaryOpen?.({ path, temporaryPath: temporary });
    await authority.assertStable();
    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    const temporaryEvidence = await captureFileEvidence(temporaryHandle, bytes);
    await assertPathMatchesEvidence(temporary, temporaryEvidence);
    await authority.assertStable();
    await hooks.beforeRename?.({ path, temporaryPath: temporary });
    await authority.assertStable();
    assertExactEvidence(await captureFileEvidence(temporaryHandle, bytes), temporaryEvidence);
    await assertPathMatchesEvidence(temporary, temporaryEvidence);
    await assertReplaceableReceipt(path);
    await rename(temporary, path);
    await authority.refreshAfterParentMutation();
    await hooks.afterRename?.({ path, temporaryPath: temporary });
    await authority.assertStable();
    const retainedAfterRename = await captureFileEvidence(temporaryHandle, bytes);
    assertRenameOnlyTransition(temporaryEvidence, retainedAfterRename);
    finalHandle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const publishedEvidence = await captureFileEvidence(finalHandle, bytes);
    assertExactEvidence(publishedEvidence, retainedAfterRename);
    await assertPathMatchesEvidence(path, publishedEvidence);
    await authority.assertStable();
    directoryHandle = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const directoryState = await directoryHandle.stat({ bigint: true });
    await assertOpenedDirectoryIdentity(dirname(path), directoryState);
    await authority.assertStable();
    await hooks.beforeDirectorySync?.({ path, temporaryPath: temporary });
    await authority.assertStable();
    assertExactEvidence(await captureFileEvidence(temporaryHandle, bytes), retainedAfterRename);
    assertExactEvidence(await captureFileEvidence(finalHandle, bytes), publishedEvidence);
    await assertPathMatchesEvidence(path, publishedEvidence);
    await authority.assertStable();
    await directoryHandle.sync();
    const directoryAfterSync = await directoryHandle.stat({ bigint: true });
    if (
      directoryAfterSync.dev !== directoryState.dev ||
      directoryAfterSync.ino !== directoryState.ino ||
      directoryAfterSync.ctimeNs !== directoryState.ctimeNs
    )
      throw new Error("Parent path changed during secure file access.");
    await assertOpenedDirectoryIdentity(dirname(path), directoryAfterSync);
    assertExactEvidence(await captureFileEvidence(temporaryHandle, bytes), retainedAfterRename);
    assertExactEvidence(await captureFileEvidence(finalHandle, bytes), publishedEvidence);
    await assertPathMatchesEvidence(path, publishedEvidence);
    await authority.assertStable();
  } finally {
    await directoryHandle?.close().catch(() => undefined);
    await finalHandle?.close().catch(() => undefined);
    await temporaryHandle.close().catch(() => undefined);
  }
}

export interface ReceiptPersistenceHooks {
  afterParentPin?: () => Promise<void>;
  afterTemporaryOpen?: (paths: ReceiptPersistencePaths) => Promise<void>;
  beforeRename?: (paths: ReceiptPersistencePaths) => Promise<void>;
  afterRename?: (paths: ReceiptPersistencePaths) => Promise<void>;
  beforeDirectorySync?: (paths: ReceiptPersistencePaths) => Promise<void>;
}

export interface ReceiptPersistencePaths {
  path: string;
  temporaryPath: string;
}

interface BoundFileEvidence {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  digest: string;
}

async function captureFileEvidence(
  handle: FileHandle,
  expectedBytes: Buffer,
): Promise<BoundFileEvidence> {
  const state = await handle.stat({ bigint: true });
  if (
    !state.isFile() ||
    state.size !== BigInt(expectedBytes.byteLength) ||
    state.nlink !== 1n ||
    (state.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" && state.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Receipt path is not a private owner-only regular file.");
  }
  const observed = Buffer.alloc(expectedBytes.byteLength);
  let offset = 0;
  while (offset < observed.byteLength) {
    const { bytesRead } = await handle.read(observed, offset, observed.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (
    offset !== observed.byteLength ||
    state.dev !== after.dev ||
    state.ino !== after.ino ||
    state.uid !== after.uid ||
    state.mode !== after.mode ||
    state.nlink !== after.nlink ||
    state.size !== after.size ||
    state.mtimeNs !== after.mtimeNs ||
    state.ctimeNs !== after.ctimeNs ||
    !observed.equals(expectedBytes)
  ) {
    throw new Error("Published receipt does not match the bound temporary file.");
  }
  return {
    dev: after.dev,
    ino: after.ino,
    uid: after.uid,
    mode: after.mode,
    nlink: after.nlink,
    size: after.size,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
    digest: createHash("sha256").update(observed).digest("hex"),
  };
}

function assertExactEvidence(observed: BoundFileEvidence, expected: BoundFileEvidence): void {
  if (
    observed.dev !== expected.dev ||
    observed.ino !== expected.ino ||
    observed.uid !== expected.uid ||
    observed.mode !== expected.mode ||
    observed.nlink !== expected.nlink ||
    observed.size !== expected.size ||
    observed.mtimeNs !== expected.mtimeNs ||
    observed.ctimeNs !== expected.ctimeNs ||
    observed.digest !== expected.digest
  ) {
    throw new Error("Published receipt does not match the bound temporary file.");
  }
}

function assertRenameOnlyTransition(before: BoundFileEvidence, after: BoundFileEvidence): void {
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== before.uid ||
    after.mode !== before.mode ||
    after.nlink !== before.nlink ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs < before.ctimeNs ||
    after.digest !== before.digest
  ) {
    throw new Error("Published receipt does not match the bound temporary file.");
  }
}

async function assertPathMatchesEvidence(path: string, expected: BoundFileEvidence): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.uid !== expected.uid ||
    current.mode !== expected.mode ||
    current.nlink !== expected.nlink ||
    current.size !== expected.size ||
    current.mtimeNs !== expected.mtimeNs ||
    current.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error("Published receipt does not match the bound temporary file.");
  }
}

async function persistPrivateJson(path: string, value: RoadmapMutationReceiptV2): Promise<void> {
  await persistPrivateJsonFile(path, value as unknown as JsonEvidenceValue);
}

async function assertReplaceableReceipt(path: string): Promise<void> {
  try {
    const state = await lstat(path, { bigint: true });
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      state.nlink !== 1n ||
      (state.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" && state.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("Receipt path is not a private owner-only regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertOpenedPathIdentity(path: string, opened: BigIntStats): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    current.ctimeNs !== opened.ctimeNs
  )
    throw new Error("Roadmap input file changed while it was read.");
}

async function assertOpenedDirectoryIdentity(path: string, opened: BigIntStats): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    current.ctimeNs !== opened.ctimeNs
  )
    throw new Error("Parent path changed during secure file access.");
}

function required(args: readonly string[], name: string): string {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  const index = indexes[0];
  if (
    indexes.length !== 1 ||
    index === undefined ||
    !args[index + 1] ||
    args[index + 1]!.startsWith("--")
  ) {
    throw new Error(`Exactly one ${name} value is required.`);
  }
  return args[index + 1]!;
}

function rejectUnknown(args: readonly string[], options: readonly string[]): void {
  const allowed = new Set(options);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--") || !allowed.has(value))
      throw new Error(`Unknown roadmap-issues option ${value}.`);
    if (seen.has(value)) throw new Error(`Duplicated roadmap-issues option ${value}.`);
    seen.add(value);
    if (value !== "--json") index += 1;
  }
}
