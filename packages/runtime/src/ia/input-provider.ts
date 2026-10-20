// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, link, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  buildContentIndex,
  canonicalDigest,
  canonicalJson,
  type ContentIndexV1,
} from "../content-ir/index.js";
import { catalogCapacity } from "../config/catalog-capacity.js";
import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";
import {
  IA_PLANNING_INPUT_ID,
  type IaPlanningInputProvider,
  type IaPlanningInputProviderRequest,
  type IaPlanningInputProviderResult,
} from "./operation.js";
import {
  bindIaEvaluationInput,
  createIaPlanningOutcome,
  type IaEvaluatedPlanningInput,
} from "./planning.js";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_PACKAGE_BYTES = catalogCapacity("ia.inputPackageMaxBytes");
export { DEFAULT_MAX_PACKAGE_BYTES as IA_INPUT_PACKAGE_DEFAULT_MAXIMUM_BYTES };
const MAX_PACKAGE_ALLOWANCE_BYTES = catalogCapacity("ia.packageAllowanceMaxBytes");
export { MAX_PACKAGE_ALLOWANCE_BYTES as IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES };
const PACKAGE_PREFIX = "planning-input-";
const ANALYSIS_PACKAGE_PREFIX = "analysis-input-";
const DEFAULT_PACKAGE_EXPIRY = "9999-12-31T23:59:59.999Z";

export interface IaAnalysisNavigationTask {
  id: string;
  query: string;
}

/** Closed host authority: packages may carry only these exact query inputs. */
export const DEFAULT_IA_NAVIGATION_TASKS: readonly IaAnalysisNavigationTask[] = Object.freeze([
  Object.freeze({
    id: "ambiguous-placement",
    query: "Which destinations could plausibly answer an ambiguous documentation need?",
  }),
  Object.freeze({ id: "routine-task", query: "Where should a new reader begin a routine task?" }),
  Object.freeze({ id: "troubleshooting", query: "Where should a reader diagnose a failed task?" }),
  Object.freeze({
    id: "reference-lookup",
    query: "Where should a reader look up exact reference information?",
  }),
  Object.freeze({
    id: "expected-no-result",
    query: "Which request is intentionally unsupported by this documentation?",
  }),
]);
const DEFAULT_IA_NAVIGATION_TASKS_DIGEST = canonicalDigest(DEFAULT_IA_NAVIGATION_TASKS);

export interface IaAnalysisInputProviderRequest {
  repositoryPath: string;
  task: Readonly<IaPlanTaskInput>;
}

export interface IaAnalysisInputProviderResult {
  index: ContentIndexV1;
  /** Query-only evaluation inputs; canonical answers never enter this package. */
  navigationTasks: IaAnalysisNavigationTask[];
  inputPackage?: {
    digest: string;
    repositoryIdentity: string;
    expiresAt: string;
  };
}

export interface IaAnalysisInputProvider {
  provide(input: IaAnalysisInputProviderRequest): Promise<IaAnalysisInputProviderResult>;
}

export type IaPlanningPackageInput = Omit<
  IaEvaluatedPlanningInput,
  "index" | "scope" | "mode" | "target"
>;

export type IaPlanningInputProviderErrorCode =
  | "invalid-revision"
  | "unsafe-path"
  | "symlink"
  | "invalid-node"
  | "insecure-permissions"
  | "owner-mismatch"
  | "package-too-large"
  | "invalid-json"
  | "missing-package"
  | "invalid-package"
  | "integrity-mismatch"
  | "stale-package"
  | "wrong-repository"
  | "wrong-revision"
  | "expired"
  | "already-exists";

export class IaPlanningInputProviderError extends Error {
  public constructor(
    public readonly code: IaPlanningInputProviderErrorCode,
    public readonly path: string,
  ) {
    super(`IA planning input provider failed (${code}) at ${path}.`);
    this.name = "IaPlanningInputProviderError";
  }
}

export interface LocalIaPlanningInputProviderOptions {
  packageRoot: string;
  /** Immutable revision exported into the disposable workspace. */
  repositoryRevision: string;
  /** Content-free identity of the selected source checkout, fixed by the host. */
  repositoryIdentity?: string;
  /** Exact immutable package selected by an operator-visible receipt. */
  packageDigest?: string;
  /** Host-derived, fully bound recovery command for a missing planning package. */
  missingPackageNextCommand?: string;
  now?: () => Date;
  maxPackageBytes?: number;
}

export interface IaInputPackageReceipt {
  schemaVersion: 1;
  packageKind: "analysis-input" | "planning-input";
  taskKey: string;
  path: string;
  digest: string;
  repositoryIdentity: string;
  repositoryRevision: string;
  repositoryContentDigest: string;
  indexDigest: string;
  expiresAt: string;
  created: boolean;
  nextCommand: string;
}

export interface InspectIaInputPackageOptions {
  packageKind: "analysis-input" | "planning-input";
  packageRoot: string;
  repositoryPath: string;
  repositoryRevision: string;
  repositoryIdentity?: string;
  commandRepositoryPath?: string;
  packageDigest?: string;
  task: Readonly<IaPlanTaskInput>;
  now?: Date;
  maxPackageBytes?: number;
}

export interface PlanningInputPackage {
  schemaVersion: 1;
  taskKey: string;
  task: IaPlanTaskInput;
  repository: {
    identity: string;
    revision: string;
    contentDigest: string;
    indexDigest: string;
  };
  expiresAt: string;
  input: IaPlanningPackageInput;
  digest: string;
}

interface AnalysisInputPackage {
  schemaVersion: 1;
  taskKey: string;
  task: IaPlanTaskInput;
  repository: {
    identity: string;
    revision: string;
    contentDigest: string;
    indexDigest: string;
  };
  expiresAt: string;
  navigationTasks: IaAnalysisNavigationTask[];
  digest: string;
}

/** Loads only query inputs; ontology, candidates, rankings, and answers are forbidden. */
export class LocalIaAnalysisInputProvider implements IaAnalysisInputProvider {
  private readonly packageRoot: string;
  private readonly repositoryRevision: string;
  private readonly maxPackageBytes: number;
  private readonly repositoryIdentity?: string;
  private readonly now: () => Date;
  private readonly packageDigest?: string;

  public constructor(options: LocalIaPlanningInputProviderOptions) {
    if (!GIT_OBJECT_ID.test(options.repositoryRevision)) {
      throw new IaPlanningInputProviderError("invalid-revision", "repositoryRevision");
    }
    if (
      typeof options.packageRoot !== "string" ||
      options.packageRoot.length === 0 ||
      options.packageRoot.includes("\0")
    ) {
      throw new IaPlanningInputProviderError("unsafe-path", String(options.packageRoot));
    }
    const maximum = packageAllowance(options.maxPackageBytes);
    this.packageRoot = resolve(options.packageRoot);
    this.repositoryRevision = options.repositoryRevision;
    this.repositoryIdentity = options.repositoryIdentity;
    this.now = options.now ?? (() => new Date());
    this.packageDigest = optionalPackageDigest(options.packageDigest);
    this.maxPackageBytes = maximum;
  }

  public async provide(
    request: IaAnalysisInputProviderRequest,
  ): Promise<IaAnalysisInputProviderResult> {
    const task = normalizeTask(request.task);
    await assertOutsideRepository(this.packageRoot, request.repositoryPath);
    const index = await buildContentIndex({
      repositoryPath: request.repositoryPath,
      repositoryRevision: this.repositoryRevision,
    });
    await privateDirectoryState(this.packageRoot);
    const repositoryIdentity =
      this.repositoryIdentity ?? (await localIaRepositoryIdentity(request.repositoryPath));
    const now = validNow(this.now());
    const selected = await selectCurrentPackage({
      taskDirectory: resolve(this.packageRoot, planningTaskKey(task)),
      prefix: ANALYSIS_PACKAGE_PREFIX,
      maximum: this.maxPackageBytes,
      ...(this.packageDigest ? { digest: this.packageDigest } : {}),
      validate: (value) => validateAnalysisPackage(value, task, index, repositoryIdentity, now),
    });
    const value = selected.value as AnalysisInputPackage;
    return {
      index,
      navigationTasks: selected.normalized as IaAnalysisNavigationTask[],
      inputPackage: {
        digest: (value as AnalysisInputPackage).digest,
        repositoryIdentity: (value as AnalysisInputPackage).repository.identity,
        expiresAt: (value as AnalysisInputPackage).expiresAt,
      },
    };
  }
}

export async function provisionIaAnalysisInputPackage(options: {
  packageRoot: string;
  repositoryPath: string;
  task: Readonly<IaPlanTaskInput>;
  index: ContentIndexV1;
  navigationTasks: IaAnalysisNavigationTask[];
  repositoryIdentity?: string;
  commandRepositoryPath?: string;
  expiresAt?: string;
  now?: Date;
  maxPackageBytes?: number;
}): Promise<IaInputPackageReceipt> {
  const task = normalizeTask(options.task);
  const packageRoot = resolve(options.packageRoot);
  await assertOutsideRepository(packageRoot, options.repositoryPath);
  const rebuilt = await buildContentIndex({
    repositoryPath: options.repositoryPath,
    repositoryRevision: options.index.repository.revision,
  });
  assertSameIndex(rebuilt, options.index, "$.index");
  const navigationTasks = normalizeAnalysisTasks(options.navigationTasks);
  if (canonicalDigest(navigationTasks) !== DEFAULT_IA_NAVIGATION_TASKS_DIGEST) {
    throw new IaPlanningInputProviderError("invalid-package", "$.navigationTasks");
  }
  const repositoryIdentity =
    options.repositoryIdentity ?? (await localIaRepositoryIdentity(options.repositoryPath));
  const expiresAt = normalizeExpiry(options.expiresAt, options.now);
  const taskKey = planningTaskKey(task);
  const unsigned = {
    schemaVersion: 1 as const,
    taskKey,
    task,
    repository: repositoryBinding(rebuilt, repositoryIdentity),
    expiresAt,
    navigationTasks,
  };
  const value: AnalysisInputPackage = {
    ...unsigned,
    digest: canonicalDigest(unsigned),
  };
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const maximum = packageAllowance(options.maxPackageBytes);
  if (bytes.byteLength > maximum) {
    throw new IaPlanningInputProviderError("package-too-large", "package");
  }
  await ensurePrivateDirectory(packageRoot);
  const taskDirectory = resolve(packageRoot, taskKey);
  await ensurePrivateDirectory(taskDirectory);
  const destination = resolve(taskDirectory, `${ANALYSIS_PACKAGE_PREFIX}${value.digest}.json`);
  const created = await writeImmutablePackage(destination, bytes);
  return packageReceipt(
    "analysis-input",
    taskKey,
    destination,
    value,
    created,
    options.commandRepositoryPath ?? options.repositoryPath,
    task,
  );
}

/**
 * Loads one host-provisioned planning input package keyed by the exact fixed
 * task. The repository is always re-indexed locally; packaged repository or
 * artifact bindings cannot substitute another disposable state.
 */
export class LocalIaPlanningInputProvider implements IaPlanningInputProvider {
  private readonly packageRoot: string;
  private readonly repositoryRevision: string;
  private readonly maxPackageBytes: number;
  private readonly repositoryIdentity?: string;
  private readonly now: () => Date;
  private readonly packageDigest?: string;
  private readonly missingPackageNextCommand?: string;

  public constructor(options: LocalIaPlanningInputProviderOptions) {
    if (!GIT_OBJECT_ID.test(options.repositoryRevision)) {
      throw new IaPlanningInputProviderError("invalid-revision", "repositoryRevision");
    }
    if (
      typeof options.packageRoot !== "string" ||
      options.packageRoot.length === 0 ||
      options.packageRoot.includes("\0")
    ) {
      throw new IaPlanningInputProviderError("unsafe-path", String(options.packageRoot));
    }
    const maximum = packageAllowance(options.maxPackageBytes);
    this.packageRoot = resolve(options.packageRoot);
    this.repositoryRevision = options.repositoryRevision;
    this.repositoryIdentity = options.repositoryIdentity;
    this.now = options.now ?? (() => new Date());
    this.packageDigest = optionalPackageDigest(options.packageDigest);
    this.missingPackageNextCommand = optionalNextCommand(options.missingPackageNextCommand);
    this.maxPackageBytes = maximum;
  }

  public async provide(
    request: IaPlanningInputProviderRequest,
  ): Promise<IaPlanningInputProviderResult> {
    const task = normalizeTask(request.task);
    await assertOutsideRepository(this.packageRoot, request.repositoryPath);
    const index = await buildContentIndex({
      repositoryPath: request.repositoryPath,
      repositoryRevision: this.repositoryRevision,
    });
    const rootState = await privateDirectoryState(this.packageRoot);
    if (rootState === "missing") {
      return missingPackage(index, this.missingPackageNextCommand);
    }
    const repositoryIdentity =
      this.repositoryIdentity ?? (await localIaRepositoryIdentity(request.repositoryPath));
    const now = validNow(this.now());
    try {
      const selected = await selectCurrentPackage({
        taskDirectory: resolve(this.packageRoot, planningTaskKey(task)),
        prefix: PACKAGE_PREFIX,
        maximum: this.maxPackageBytes,
        ...(this.packageDigest ? { digest: this.packageDigest } : {}),
        validate: (value) => validatePackage(value, task, index, repositoryIdentity, now),
      });
      return { index, ...(selected.normalized as IaPlanningPackageInput) };
    } catch (error) {
      if (error instanceof IaPlanningInputProviderError && error.code === "missing-package") {
        return missingPackage(index, this.missingPackageNextCommand);
      }
      throw error;
    }
  }
}

export interface ProvisionIaPlanningInputPackageOptions {
  packageRoot: string;
  repositoryPath: string;
  task: Readonly<IaPlanTaskInput>;
  index: ContentIndexV1;
  input: IaPlanningPackageInput;
  repositoryIdentity?: string;
  commandRepositoryPath?: string;
  expiresAt?: string;
  now?: Date;
  maxPackageBytes?: number;
}

/** Prepare canonical bytes before selecting a host-owned capacity allowance. */
export async function prepareIaPlanningInputPackage(
  options: ProvisionIaPlanningInputPackageOptions,
): Promise<{ package: PlanningInputPackage; bytes: Buffer }> {
  const task = normalizeTask(options.task);
  const packageRoot = resolve(options.packageRoot);
  await assertOutsideRepository(packageRoot, options.repositoryPath);
  const rebuilt = await buildContentIndex({
    repositoryPath: options.repositoryPath,
    repositoryRevision: options.index.repository.revision,
  });
  assertSameIndex(rebuilt, options.index, "$.index");
  const input = normalizePlanningInput(options.input, rebuilt, task);
  const repositoryIdentity =
    options.repositoryIdentity ?? (await localIaRepositoryIdentity(options.repositoryPath));
  const expiresAt = normalizeExpiry(options.expiresAt, options.now);
  const taskKey = planningTaskKey(task);
  const unsigned = {
    schemaVersion: 1 as const,
    taskKey,
    task,
    repository: repositoryBinding(rebuilt, repositoryIdentity),
    expiresAt,
    input,
  };
  const packaged: PlanningInputPackage = {
    ...unsigned,
    digest: canonicalDigest(unsigned),
  };
  const bytes = Buffer.from(canonicalJson(packaged), "utf8");
  return { package: packaged, bytes };
}

/** Host-only helper for provisioning one immutable task package. */
export async function provisionIaPlanningInputPackage(
  options: ProvisionIaPlanningInputPackageOptions,
): Promise<IaInputPackageReceipt> {
  const { package: packaged, bytes } = await prepareIaPlanningInputPackage(options);
  const maximum = packageAllowance(options.maxPackageBytes);
  if (bytes.byteLength > maximum) {
    throw new IaPlanningInputProviderError("package-too-large", "package");
  }
  const packageRoot = resolve(options.packageRoot);
  const { task, taskKey } = packaged;
  await ensurePrivateDirectory(packageRoot);
  const taskDirectory = resolve(packageRoot, taskKey);
  await ensurePrivateDirectory(taskDirectory);
  const destination = resolve(taskDirectory, `${PACKAGE_PREFIX}${packaged.digest}.json`);
  const created = await writeImmutablePackage(destination, bytes);
  return packageReceipt(
    "planning-input",
    taskKey,
    destination,
    packaged,
    created,
    options.commandRepositoryPath ?? options.repositoryPath,
    task,
  );
}

export function planningTaskKey(task: Readonly<IaPlanTaskInput>): string {
  return canonicalDigest(normalizeTask(task));
}

/** Validate one operator-visible package without returning repository content. */
export async function inspectIaInputPackage(
  options: InspectIaInputPackageOptions,
): Promise<IaInputPackageReceipt> {
  const task = normalizeTask(options.task);
  if (!GIT_OBJECT_ID.test(options.repositoryRevision)) {
    throw new IaPlanningInputProviderError("invalid-revision", "repositoryRevision");
  }
  const root = resolve(options.packageRoot);
  await assertOutsideRepository(root, options.repositoryPath);
  const index = await buildContentIndex({
    repositoryPath: options.repositoryPath,
    repositoryRevision: options.repositoryRevision,
  });
  const repositoryIdentity =
    options.repositoryIdentity ?? (await localIaRepositoryIdentity(options.repositoryPath));
  const taskKey = planningTaskKey(task);
  const now = validNow(options.now ?? new Date());
  const common = {
    taskDirectory: resolve(root, taskKey),
    maximum: packageAllowance(options.maxPackageBytes),
    ...(options.packageDigest ? { digest: optionalPackageDigest(options.packageDigest)! } : {}),
  };
  const selected =
    options.packageKind === "analysis-input"
      ? await selectCurrentPackage({
          ...common,
          prefix: ANALYSIS_PACKAGE_PREFIX,
          validate: (value) => validateAnalysisPackage(value, task, index, repositoryIdentity, now),
        })
      : await selectCurrentPackage({
          ...common,
          prefix: PACKAGE_PREFIX,
          validate: (value) => validatePackage(value, task, index, repositoryIdentity, now),
        });
  return packageReceipt(
    options.packageKind,
    taskKey,
    selected.path,
    selected.value as AnalysisInputPackage | PlanningInputPackage,
    false,
    options.commandRepositoryPath ?? options.repositoryPath,
    task,
  );
}

function missingPackage(
  index: ContentIndexV1,
  nextCommand?: string,
): IaPlanningInputProviderResult {
  return {
    index,
    needsInput: [
      {
        id: IA_PLANNING_INPUT_ID,
        kind: "placement",
        evidence: [],
      },
    ],
    ...(nextCommand ? { nextCommand } : {}),
  };
}

async function readPackage(path: string, maximum: number): Promise<unknown> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new IaPlanningInputProviderError("missing-package", path);
    }
    if (isNodeError(error, "ELOOP")) {
      throw new IaPlanningInputProviderError("symlink", path);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    assertPrivateFile(before, path);
    const bytes = await readBounded(handle, maximum, path);
    const after = await handle.stat();
    if (!sameNode(before, after)) {
      throw new IaPlanningInputProviderError("integrity-mismatch", path);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new IaPlanningInputProviderError("invalid-json", path);
    }
    if (canonicalJson(parsed) !== bytes.toString("utf8")) {
      throw new IaPlanningInputProviderError("integrity-mismatch", path);
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

async function selectCurrentPackage<T>(options: {
  taskDirectory: string;
  prefix: string;
  maximum: number;
  digest?: string;
  validate: (value: unknown) => T;
}): Promise<{ path: string; value: unknown; normalized: T }> {
  if ((await privateDirectoryState(options.taskDirectory)) === "missing") {
    throw new IaPlanningInputProviderError("missing-package", options.taskDirectory);
  }
  let entries;
  try {
    entries = await readdir(options.taskDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new IaPlanningInputProviderError("missing-package", options.taskDirectory);
    }
    throw error;
  }
  const pattern = new RegExp(`^${options.prefix}([a-f0-9]{64})\\.json$`, "u");
  const candidates = entries
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => entry.name)
    .filter(
      (name) => options.digest === undefined || name === `${options.prefix}${options.digest}.json`,
    )
    .sort();
  if (candidates.length === 0) {
    throw new IaPlanningInputProviderError("missing-package", options.taskDirectory);
  }
  const valid: Array<{
    path: string;
    value: unknown;
    normalized: T;
    expiresAt: string;
    digest: string;
  }> = [];
  const failures: IaPlanningInputProviderError[] = [];
  for (const name of candidates) {
    const path = resolve(options.taskDirectory, name);
    try {
      const value = await readPackage(path, options.maximum);
      if (
        !plainObject(value) ||
        typeof value.digest !== "string" ||
        value.digest !== pattern.exec(name)?.[1]
      ) {
        throw new IaPlanningInputProviderError("integrity-mismatch", path);
      }
      const normalized = options.validate(value);
      valid.push({
        path,
        value,
        normalized,
        expiresAt: timestamp(value.expiresAt, `${path}:expiresAt`),
        digest: value.digest,
      });
    } catch (error) {
      failures.push(
        error instanceof IaPlanningInputProviderError
          ? error
          : new IaPlanningInputProviderError("invalid-package", path),
      );
    }
  }
  if (valid.length === 1) {
    return valid[0]!;
  }
  if (valid.length > 1) {
    throw new IaPlanningInputProviderError(
      "invalid-package",
      `${options.taskDirectory}:ambiguous-package`,
    );
  }
  const priority: IaPlanningInputProviderErrorCode[] = [
    "wrong-repository",
    "wrong-revision",
    "stale-package",
    "expired",
    "integrity-mismatch",
    "invalid-json",
    "invalid-package",
    "symlink",
    "insecure-permissions",
    "owner-mismatch",
    "invalid-node",
    "package-too-large",
  ];
  failures.sort((left, right) => priority.indexOf(left.code) - priority.indexOf(right.code));
  throw failures[0] ?? new IaPlanningInputProviderError("missing-package", options.taskDirectory);
}

async function writeImmutablePackage(path: string, bytes: Buffer): Promise<boolean> {
  const temporary = resolve(dirname(path), `.package-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    if (isNodeError(error, "ELOOP")) {
      throw new IaPlanningInputProviderError("symlink", temporary);
    }
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const existing = await readPackage(path, Math.max(DEFAULT_MAX_PACKAGE_BYTES, bytes.byteLength));
    if (canonicalJson(existing) === bytes.toString("utf8")) return false;
    throw new IaPlanningInputProviderError("already-exists", path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function packageReceipt(
  packageKind: IaInputPackageReceipt["packageKind"],
  taskKey: string,
  path: string,
  value: AnalysisInputPackage | PlanningInputPackage,
  created: boolean,
  repositoryPath: string,
  task: IaPlanTaskInput,
): IaInputPackageReceipt {
  return {
    schemaVersion: 1,
    packageKind,
    taskKey,
    path,
    digest: value.digest,
    repositoryIdentity: value.repository.identity,
    repositoryRevision: value.repository.revision,
    repositoryContentDigest: value.repository.contentDigest,
    indexDigest: value.repository.indexDigest,
    expiresAt: value.expiresAt,
    created,
    nextCommand: runCommand(
      packageKind,
      repositoryPath,
      value.repository.revision,
      task,
      value.digest,
    ),
  };
}

function runCommand(
  packageKind: IaInputPackageReceipt["packageKind"],
  repositoryPath: string,
  revision: string,
  task: IaPlanTaskInput,
  digest: string,
): string {
  const workflow = packageKind === "analysis-input" ? "ia-analysis" : "ia-plan";
  return `docsfab run ${workflow} --repo ${shellWord(repositoryPath)} --revision ${revision}${taskArguments(task)} --input-digest ${digest}`;
}

/**
 * The admitted package allowance for one caller. An unusable size or one above
 * the catalogued `ia.packageAllowanceMaxBytes` ceiling is refused, never
 * narrowed, so no caller can widen its own bound. An allowance at the ceiling
 * is admitted exactly.
 */
function packageAllowance(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_PACKAGE_BYTES;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    requested > MAX_PACKAGE_ALLOWANCE_BYTES
  ) {
    throw new IaPlanningInputProviderError("package-too-large", "maxPackageBytes");
  }
  return requested;
}

function optionalPackageDigest(value: string | undefined): string | undefined {
  if (value !== undefined && !SHA256.test(value)) {
    throw new IaPlanningInputProviderError("invalid-package", "packageDigest");
  }
  return value;
}

function optionalNextCommand(value: string | undefined): string | undefined {
  if (value !== undefined && (value.length === 0 || value.includes("\0"))) {
    throw new IaPlanningInputProviderError("invalid-package", "missingPackageNextCommand");
  }
  return value;
}

function taskArguments(task: IaPlanTaskInput): string {
  if (task.scope === "site") return ` --scope site --mode ${task.mode}`;
  const fragment = task.target?.anchor ? `#${task.target.anchor}` : "";
  return ` --scope ${task.scope} --target ${shellWord(`${task.target!.sourcePath}${fragment}`)}`;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function localIaRepositoryIdentity(repositoryPath: string): Promise<string> {
  const physical = await realpath(resolve(repositoryPath));
  return canonicalDigest({ schemaVersion: 1, kind: "docsfab-local-repository", physical });
}

function normalizeExpiry(value: string | undefined, now: Date | undefined): string {
  const expiresAt = timestamp(value ?? DEFAULT_PACKAGE_EXPIRY, "expiresAt");
  if (now !== undefined && Date.parse(expiresAt) <= validNow(now).valueOf()) {
    throw new IaPlanningInputProviderError("expired", "expiresAt");
  }
  return expiresAt;
}

function timestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new IaPlanningInputProviderError("invalid-package", path);
  }
  return value;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new IaPlanningInputProviderError("invalid-package", "now");
  }
  return value;
}

/** Canonical decoder shared with retained hosted planning inputs. */
export { validatePackage as validateIaPlanningInputPackage };

function validatePackage(
  value: unknown,
  task: IaPlanTaskInput,
  index: ContentIndexV1,
  repositoryIdentity: string,
  now: Date,
): IaPlanningPackageInput {
  // A retained hosted record's caller supplies `now` directly; re-checking
  // keeps an `Invalid Date` from making the expiry comparison silently false.
  validNow(now);
  if (
    !plainObject(value) ||
    !exactKeys(value, [
      "digest",
      "expiresAt",
      "input",
      "repository",
      "schemaVersion",
      "task",
      "taskKey",
    ]) ||
    value.schemaVersion !== 1 ||
    !SHA256.test(String(value.digest))
  ) {
    throw new IaPlanningInputProviderError("invalid-package", "$.package");
  }
  const { digest: _digest, ...unsigned } = value;
  if (canonicalDigest(unsigned) !== value.digest) {
    throw new IaPlanningInputProviderError("integrity-mismatch", "$.digest");
  }
  if (
    value.taskKey !== planningTaskKey(task) ||
    canonicalJson(normalizeTask(value.task as IaPlanTaskInput)) !== canonicalJson(task)
  ) {
    throw new IaPlanningInputProviderError("stale-package", "$.task");
  }
  validatePackageBinding(value.repository, value.expiresAt, index, repositoryIdentity, now);
  if (
    (value.repository as Record<string, unknown>).contentDigest !==
      index.repository.contentDigest ||
    (value.repository as Record<string, unknown>).indexDigest !== index.indexDigest
  ) {
    throw new IaPlanningInputProviderError("stale-package", "$.repository");
  }
  return normalizePlanningInput(value.input, index, task);
}

function validateAnalysisPackage(
  value: unknown,
  task: IaPlanTaskInput,
  index: ContentIndexV1,
  repositoryIdentity: string,
  now: Date,
): IaAnalysisNavigationTask[] {
  if (
    !plainObject(value) ||
    !exactKeys(value, [
      "digest",
      "expiresAt",
      "navigationTasks",
      "repository",
      "schemaVersion",
      "task",
      "taskKey",
    ]) ||
    value.schemaVersion !== 1 ||
    !SHA256.test(String(value.digest))
  ) {
    throw new IaPlanningInputProviderError("invalid-package", "$.package");
  }
  const { digest: _digest, ...unsigned } = value;
  if (canonicalDigest(unsigned) !== value.digest) {
    throw new IaPlanningInputProviderError("integrity-mismatch", "$.digest");
  }
  if (
    value.taskKey !== planningTaskKey(task) ||
    canonicalJson(normalizeTask(value.task as IaPlanTaskInput)) !== canonicalJson(task)
  ) {
    throw new IaPlanningInputProviderError("stale-package", "$.task");
  }
  validatePackageBinding(value.repository, value.expiresAt, index, repositoryIdentity, now);
  if (
    (value.repository as Record<string, unknown>).contentDigest !==
      index.repository.contentDigest ||
    (value.repository as Record<string, unknown>).indexDigest !== index.indexDigest
  ) {
    throw new IaPlanningInputProviderError("stale-package", "$.repository");
  }
  const tasks = normalizeAnalysisTasks(value.navigationTasks);
  if (canonicalDigest(tasks) !== DEFAULT_IA_NAVIGATION_TASKS_DIGEST) {
    throw new IaPlanningInputProviderError("invalid-package", "$.navigationTasks");
  }
  return tasks;
}

function normalizeAnalysisTasks(value: unknown): IaAnalysisNavigationTask[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IaPlanningInputProviderError("invalid-package", "$.navigationTasks");
  }
  const tasks = value.map((entry, index) => {
    if (
      !plainObject(entry) ||
      !exactKeys(entry, ["id", "query"]) ||
      !safeText(entry.id) ||
      !safeText(entry.query)
    ) {
      throw new IaPlanningInputProviderError("invalid-package", `$.navigationTasks[${index}]`);
    }
    return { id: entry.id as string, query: entry.query as string };
  });
  if (new Set(tasks.map((item) => item.id)).size !== tasks.length) {
    throw new IaPlanningInputProviderError("invalid-package", "$.navigationTasks");
  }
  return tasks;
}

function normalizePlanningInput(
  value: unknown,
  index: ContentIndexV1,
  task: IaPlanTaskInput,
): IaPlanningPackageInput {
  if (!plainObject(value)) {
    throw new IaPlanningInputProviderError("invalid-package", "$.input");
  }
  const keys = [
    "candidates",
    "evaluation",
    "evaluationInput",
    "expiresAt",
    "inboundLinkConsequences",
    "migrationDispositions",
    "navigationEvaluation",
    "ontology",
    "planId",
    "plannedPages",
    "policyBindings",
    "redirects",
    "requiredApproval",
    "useCases",
    ...(Object.hasOwn(value, "supersedes") ? ["supersedes"] : []),
  ];
  if (!exactKeys(value, keys)) {
    throw new IaPlanningInputProviderError("invalid-package", "$.input");
  }
  const input = structuredClone(value) as IaPlanningPackageInput;
  try {
    const planningInput = {
      index,
      scope: task.scope,
      mode: task.mode,
      ...(task.target ? { target: structuredClone(task.target) } : {}),
      ...input,
    } satisfies IaEvaluatedPlanningInput;
    planningInput.evaluationInput = bindIaEvaluationInput(planningInput);
    createIaPlanningOutcome(planningInput);
    return {
      ...input,
      evaluationInput: planningInput.evaluationInput,
    };
  } catch {
    throw new IaPlanningInputProviderError("invalid-package", "$.input");
  }
}

function normalizeTask(value: Readonly<IaPlanTaskInput>): IaPlanTaskInput {
  if (
    !plainObject(value) ||
    value.kind !== "ia-plan" ||
    !["site", "section", "page"].includes(String(value.scope)) ||
    !["create", "reevaluate"].includes(String(value.mode))
  ) {
    throw new IaPlanningInputProviderError("invalid-package", "$.task");
  }
  const expectedKeys = value.target
    ? ["kind", "mode", "scope", "target"]
    : ["kind", "mode", "scope"];
  if (
    !exactKeys(value, expectedKeys) ||
    (value.scope === "site") === (value.target !== undefined)
  ) {
    throw new IaPlanningInputProviderError("invalid-package", "$.task");
  }
  if (
    value.target &&
    (!plainObject(value.target) ||
      !exactKeys(value.target, [
        "sourcePath",
        ...(Object.hasOwn(value.target, "anchor") ? ["anchor"] : []),
      ]) ||
      !safeRelativePath(value.target.sourcePath) ||
      (value.target.anchor !== undefined && !safeText(value.target.anchor)))
  ) {
    throw new IaPlanningInputProviderError("invalid-package", "$.task.target");
  }
  return structuredClone(value);
}

function repositoryBinding(index: ContentIndexV1, identity: string) {
  if (!SHA256.test(identity)) {
    throw new IaPlanningInputProviderError("wrong-repository", "repositoryIdentity");
  }
  return {
    identity,
    revision: index.repository.revision,
    contentDigest: index.repository.contentDigest,
    indexDigest: index.indexDigest,
  };
}

function validatePackageBinding(
  value: unknown,
  expiry: unknown,
  index: ContentIndexV1,
  repositoryIdentity: string,
  now: Date,
): void {
  if (
    !plainObject(value) ||
    !exactKeys(value, ["contentDigest", "identity", "indexDigest", "revision"]) ||
    !SHA256.test(String(value.identity)) ||
    !GIT_OBJECT_ID.test(String(value.revision)) ||
    !SHA256.test(String(value.contentDigest)) ||
    !SHA256.test(String(value.indexDigest))
  ) {
    throw new IaPlanningInputProviderError("invalid-package", "$.repository");
  }
  if (value.identity !== repositoryIdentity) {
    throw new IaPlanningInputProviderError("wrong-repository", "$.repository.identity");
  }
  if (value.revision !== index.repository.revision) {
    throw new IaPlanningInputProviderError("wrong-revision", "$.repository.revision");
  }
  const expiresAt = timestamp(expiry, "$.expiresAt");
  if (Date.parse(expiresAt) <= now.valueOf()) {
    throw new IaPlanningInputProviderError("expired", "$.expiresAt");
  }
}

function assertSameIndex(left: ContentIndexV1, right: ContentIndexV1, path: string): void {
  if (
    left.repository.revision !== right.repository.revision ||
    left.repository.contentDigest !== right.repository.contentDigest ||
    left.indexDigest !== right.indexDigest
  ) {
    throw new IaPlanningInputProviderError("stale-package", path);
  }
}

async function assertOutsideRepository(packageRoot: string, repositoryPath: string): Promise<void> {
  const repositoryRoot = await realpath(resolve(repositoryPath));
  const physicalPackageRoot = await physicalPath(packageRoot);
  const packageRelative = relative(repositoryRoot, physicalPackageRoot);
  const repositoryRelative = relative(physicalPackageRoot, repositoryRoot);
  if (contained(packageRelative) || contained(repositoryRelative)) {
    throw new IaPlanningInputProviderError("unsafe-path", packageRoot);
  }
}

async function physicalPath(path: string): Promise<string> {
  let existing = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(existing), ...missing);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(existing);
      if (parent === existing) {
        throw new IaPlanningInputProviderError("unsafe-path", path);
      }
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

function contained(path: string): boolean {
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  if ((await privateDirectoryState(path)) !== "ready") {
    throw new IaPlanningInputProviderError("invalid-node", path);
  }
}

async function privateDirectoryState(path: string): Promise<"missing" | "ready"> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "missing";
    throw error;
  }
  if (stat.isSymbolicLink()) throw new IaPlanningInputProviderError("symlink", path);
  if (!stat.isDirectory()) throw new IaPlanningInputProviderError("invalid-node", path);
  assertOwner(stat, path);
  if ((stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new IaPlanningInputProviderError("insecure-permissions", path);
  }
  return "ready";
}

function assertPrivateFile(stat: Stats, path: string): void {
  if (!stat.isFile()) throw new IaPlanningInputProviderError("invalid-node", path);
  assertOwner(stat, path);
  if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new IaPlanningInputProviderError("insecure-permissions", path);
  }
}

function assertOwner(stat: Stats, path: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new IaPlanningInputProviderError("owner-mismatch", path);
  }
}

async function readBounded(handle: FileHandle, maximum: number, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) {
      throw new IaPlanningInputProviderError("package-too-large", path);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function sameNode(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function safeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    value === value.normalize("NFC") &&
    !value.includes("\0") &&
    !/[\r\n]/u.test(value)
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
