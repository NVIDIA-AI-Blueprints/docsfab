// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, opendir, open, readFile, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createContractKit } from "../contract-kit/index.js";
import type { ExecutionLeaseRuntimeEvidenceV1 } from "../execution/contracts.js";
import {
  ensurePrivateRunDirectory,
  FileRunStore,
  FileRunStoreError,
  SAFE_RECORD_ID,
} from "../records/file-store.js";
import { resolveDocsFabStateDirectory } from "./host-paths.js";
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";
import { isNodeError } from "../shared/primitives.js";

const COMMITTED_RECORD_SUFFIX = ".json";
const TEMPORARY_RECORD = /^\.[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*\.tmp$/u;
/** Owned state beside run records; these names never designate run records. */
const NON_RECORD_STATE_DIRECTORIES = new Set([
  "artifacts",
  "delegated-tasks",
  "input-ask-supersession",
  "native-inputs",
  "reports",
  "study",
]);

type ExecutionLeaseDecoder = (value: unknown) => ExecutionLeaseRuntimeEvidenceV1;
let executionLeaseDecoder: Promise<ExecutionLeaseDecoder> | undefined;

/**
 * `invalid-record` means a record or observation map breaks its contract; the
 * message names the file when one was read. `internal-error` means DocsFab
 * failed while reading a file it has not judged invalid.
 */
export type LimitObservationErrorCode =
  | "invalid-record"
  | "unsafe-store"
  | "read-failed"
  | "internal-error";

export interface LimitObservationErrorOptions {
  /** The file being read when the failure happened. */
  readonly path?: string;
  /** The underlying failure; only `internal-error` names it in the message. */
  readonly cause?: unknown;
}

/**
 * Set on the error so the operator envelope does not infer a remediation from
 * words in the file path or the internal cause. `named` applies when the
 * message names a file.
 */
const NEXT_ACTIONS: Readonly<
  Partial<Record<LimitObservationErrorCode, { readonly named: string; readonly unnamed: string }>>
> = {
  "invalid-record": {
    named:
      "Inspect the named file and correct the contract fields it breaks, then rerun `docsfab doctor --limits`.",
    unnamed: "Correct the limit observations that break their contract, then retry.",
  },
  "internal-error": {
    named:
      "Report this message to the DocsFab maintainers. DocsFab failed internally while reading the named file; it did not judge that file invalid and left it unchanged.",
    unnamed:
      "Report this message to the DocsFab maintainers. DocsFab failed internally; it did not judge any record invalid.",
  },
};

/** Operator-facing failure. It may name the file and an internal cause, never record contents. */
export class LimitObservationError extends Error {
  public readonly code: LimitObservationErrorCode;
  public readonly path: string | undefined;
  public readonly nextAction: string | undefined;
  public constructor(code: LimitObservationErrorCode, options: LimitObservationErrorOptions = {}) {
    const at = options.path === undefined ? "" : ` at ${options.path}`;
    const because =
      code === "internal-error" && options.cause !== undefined
        ? `: ${describeCause(options.cause)}`
        : ".";
    super(
      `Run limit observations failed (${code})${at}${because}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.path = options.path;
    this.nextAction = NEXT_ACTIONS[code]?.[options.path === undefined ? "unnamed" : "named"];
    this.name = "LimitObservationError";
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

function fail(code: LimitObservationErrorCode, options?: LimitObservationErrorOptions): never {
  throw new LimitObservationError(code, options);
}

/**
 * Name the file a record-level failure came from. Only `invalid-record` and
 * `internal-error` are about one file's contents; the other codes keep their
 * existing messages.
 */
function atPath(error: unknown, path: string): unknown {
  if (
    error instanceof LimitObservationError &&
    error.path === undefined &&
    (error.code === "invalid-record" || error.code === "internal-error")
  ) {
    return new LimitObservationError(error.code, { path, cause: error.cause });
  }
  if (error instanceof FileRunStoreError && error.code === "invalid-record") {
    return new LimitObservationError("invalid-record", { path });
  }
  return error;
}

const kit = createContractKit<LimitObservationErrorCode>({
  fail: (code) => fail(code),
  codes: {
    invalidShape: "invalid-record",
    invalidValue: "invalid-record",
    digestMismatch: "invalid-record",
    credentialMaterial: "invalid-record",
    schemaMismatch: "invalid-record",
  },
  inertMode: "strict",
});

export interface ReadRunLimitObservationsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Base for a relative DOCSFAB_LIMITS_OBSERVED_FILE; defaults to the process cwd. */
  readonly cwd?: string;
}

export interface ProjectRunLimitObservationsInput {
  readonly stateDirectory: string;
  readonly recordId: string;
}

export interface PersistHostedLimitObservationsInput {
  readonly observations: Readonly<Record<string, number>>;
  readonly projectId: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const HOSTED_OBSERVATIONS_DIRECTORY_NAME = "hosted-limit-observations";

/** Durable sibling of the run-record store; never the per-attempt private tree. */
export function resolveHostedLimitObservationsDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    dirname(resolveDocsFabStateDirectory(environment)),
    HOSTED_OBSERVATIONS_DIRECTORY_NAME,
  );
}

/**
 * Project actual operational-limit usage from immutable run records.
 *
 * Missing evidence stays absent. A persisted zero remains a measured zero.
 * Independent retry attempts are compared; their per-attempt budgets are never
 * added together.
 */
export async function readRunLimitObservations(
  options: ReadRunLimitObservationsOptions = {},
): Promise<Readonly<Record<string, number>>> {
  const environment = options.environment ?? process.env;
  const compatibilityFile = environment.DOCSFAB_LIMITS_OBSERVED_FILE?.trim();
  if (compatibilityFile) {
    return readCompatibilityObservations(
      isAbsolute(compatibilityFile)
        ? compatibilityFile
        : resolve(options.cwd ?? process.cwd(), compatibilityFile),
    );
  }

  const observations = new Map<string, number>();
  await collectStoreObservations(resolveDocsFabStateDirectory(environment), observations);
  await collectHostedObservations(environment, observations);
  return Object.freeze(Object.fromEntries(observations));
}

/**
 * Project one hosted attempt record while the private state directory still
 * exists. Missing records stay empty so cleanup can proceed without inventing
 * measurements. Extra attempt-tree files are ignored because this path never
 * enumerates the directory.
 */
export async function projectRunLimitObservations(
  input: ProjectRunLimitObservationsInput,
): Promise<Readonly<Record<string, number>>> {
  if (!SAFE_RECORD_ID.test(input.recordId)) fail("unsafe-store");
  try {
    try {
      await lstat(input.stateDirectory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return Object.freeze({});
      fail("read-failed");
    }
    const observations = new Map<string, number>();
    await projectStoredRecord(
      new FileRunStore(input.stateDirectory),
      input.stateDirectory,
      input.recordId,
      observations,
    );
    return Object.freeze(Object.fromEntries(observations));
  } catch (error) {
    if (error instanceof LimitObservationError) throw error;
    if (error instanceof FileRunStoreError) {
      if (error.code === "record-not-found") return Object.freeze({});
      throw new LimitObservationError(
        error.code === "invalid-record" ? "invalid-record" : "unsafe-store",
      );
    }
    fail("read-failed");
  }
}

/**
 * Merge projected hosted measurements into the durable service store. Empty
 * observations are a no-op so a run without lease evidence does not pretend
 * the installed host persisted measurements.
 */
export async function persistHostedLimitObservations(
  input: PersistHostedLimitObservationsInput,
): Promise<void> {
  if (!SAFE_RECORD_ID.test(input.projectId)) fail("unsafe-store");
  const incoming = decodeObservationMap(input.observations);
  if (Object.keys(incoming).length === 0) return;

  const environment = input.environment ?? process.env;
  const directory = resolveHostedLimitObservationsDirectory(environment);
  try {
    await ensurePrivateRunDirectory(directory);
    const destination = join(directory, `${input.projectId}${COMMITTED_RECORD_SUFFIX}`);
    const existing = await readOptionalObservationFile(destination);
    const merged = mergeObservationMaps(existing, incoming);
    await writePrivateObservationFile(directory, input.projectId, merged);
  } catch (error) {
    if (error instanceof LimitObservationError) throw error;
    if (error instanceof FileRunStoreError) {
      throw new LimitObservationError(
        error.code === "invalid-record" ? "invalid-record" : "unsafe-store",
      );
    }
    fail("read-failed");
  }
}

async function collectStoreObservations(
  directory: string,
  observations: Map<string, number>,
): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    fail("read-failed");
  }

  try {
    await ensurePrivateRunDirectory(directory);
    const store = new FileRunStore(directory);
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (NON_RECORD_STATE_DIRECTORIES.has(entry.name)) {
        await assertPrivateStateDirectory(join(directory, entry.name));
        continue;
      }
      if (TEMPORARY_RECORD.test(entry.name)) {
        if (!entry.isFile()) fail("unsafe-store");
        continue;
      }
      const recordId = committedRecordId(entry.name);
      if (recordId === undefined || !entry.isFile()) fail("unsafe-store");
      await projectStoredRecord(store, directory, recordId, observations);
    }
  } catch (error) {
    if (error instanceof LimitObservationError) throw error;
    if (error instanceof FileRunStoreError) {
      throw new LimitObservationError(
        error.code === "invalid-record" ? "invalid-record" : "unsafe-store",
      );
    }
    fail("read-failed");
  }
}

/** Check a known sibling without following a substituted link or repairing its mode. */
async function assertPrivateStateDirectory(path: string): Promise<void> {
  const before = await lstat(path).catch(() => fail("unsafe-store"));
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o7777) !== 0o700
  ) {
    fail("unsafe-store");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => fail("unsafe-store"));
  try {
    const pinned = await handle.stat();
    const after = await lstat(path);
    if (
      !pinned.isDirectory() ||
      pinned.uid !== before.uid ||
      (pinned.mode & 0o7777) !== 0o700 ||
      pinned.dev !== before.dev ||
      pinned.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.uid !== before.uid ||
      (after.mode & 0o7777) !== 0o700
    ) {
      fail("unsafe-store");
    }
  } catch {
    fail("unsafe-store");
  } finally {
    await handle.close();
  }
}

async function collectHostedObservations(
  environment: NodeJS.ProcessEnv,
  observations: Map<string, number>,
): Promise<void> {
  const directory = resolveHostedLimitObservationsDirectory(environment);
  try {
    await lstat(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    fail("read-failed");
  }

  try {
    await ensurePrivateRunDirectory(directory);
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (TEMPORARY_RECORD.test(entry.name)) {
        if (!entry.isFile()) fail("unsafe-store");
        continue;
      }
      const projectId = committedRecordId(entry.name);
      if (
        projectId === undefined ||
        !SAFE_RECORD_ID.test(projectId) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        fail("unsafe-store");
      }
      mergeObservationMapsInto(
        observations,
        await readOptionalObservationFile(join(directory, entry.name)),
      );
    }
  } catch (error) {
    if (error instanceof LimitObservationError) throw error;
    if (error instanceof FileRunStoreError) {
      throw new LimitObservationError(
        error.code === "invalid-record" ? "invalid-record" : "unsafe-store",
      );
    }
    fail("read-failed");
  }
}

async function readCompatibilityObservations(
  path: string,
): Promise<Readonly<Record<string, number>>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    fail("read-failed");
  }

  return decodeObservationFile(text, path);
}

function decodeObservationFile(text: string, path: string): Readonly<Record<string, number>> {
  try {
    return Object.freeze(decodeObservationMap(JSON.parse(text) as unknown));
  } catch (error) {
    if (error instanceof LimitObservationError) throw atPath(error, path);
    fail("invalid-record", { path });
  }
}

function decodeObservationMap(value: unknown): Readonly<Record<string, number>> {
  const parsed = kit.object(value);
  const observations: Record<string, number> = {};
  for (const [name, observed] of Object.entries(parsed)) {
    const definition = LIMIT_DEFINITION_BY_NAME[name];
    if (
      definition === undefined ||
      typeof observed !== "number" ||
      !Number.isFinite(observed) ||
      observed < 0 ||
      (definition.unit !== "ratio" && !Number.isSafeInteger(observed))
    ) {
      fail("invalid-record");
    }
    observations[name] = observed;
  }
  return observations;
}

function mergeObservationMaps(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const merged = new Map<string, number>(Object.entries(left));
  mergeObservationMapsInto(merged, right);
  return Object.fromEntries(merged);
}

function mergeObservationMapsInto(
  observations: Map<string, number>,
  incoming: Readonly<Record<string, number>>,
): void {
  for (const [name, value] of Object.entries(incoming)) {
    const current = observations.get(name);
    if (current === undefined || value > current) observations.set(name, value);
  }
}

async function readOptionalObservationFile(
  path: string,
): Promise<Readonly<Record<string, number>>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return Object.freeze({});
    fail("read-failed");
  }
  return decodeObservationFile(text, path);
}

async function writePrivateObservationFile(
  directory: string,
  projectId: string,
  observations: Readonly<Record<string, number>>,
): Promise<void> {
  const destination = join(directory, `${projectId}${COMMITTED_RECORD_SUFFIX}`);
  const temporary = join(directory, `.${projectId}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(observations)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    created = false;
  } catch (error) {
    if (error instanceof LimitObservationError) throw error;
    fail("read-failed");
  } finally {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

function committedRecordId(name: string): string | undefined {
  if (!name.endsWith(COMMITTED_RECORD_SUFFIX)) return undefined;
  const recordId = name.slice(0, -COMMITTED_RECORD_SUFFIX.length);
  return recordId || undefined;
}

async function projectStoredRecord(
  store: FileRunStore,
  directory: string,
  recordId: string,
  observations: Map<string, number>,
): Promise<void> {
  const path = join(directory, `${recordId}${COMMITTED_RECORD_SUFFIX}`);
  let record: unknown;
  try {
    record = await store.get(recordId);
  } catch (error) {
    throw atPath(error, path);
  }
  try {
    await projectRecordObservations(record, recordId, observations);
  } catch (error) {
    if (error instanceof LimitObservationError) throw atPath(error, path);
    // A record that parsed failed for a reason other than its contract.
    fail("internal-error", { path, cause: error });
  }
}

async function projectRecordObservations(
  value: unknown,
  expectedRecordId: string,
  observations: Map<string, number>,
): Promise<void> {
  const record = kit.object(value);
  if (record.schemaVersion !== 2 || record.id !== expectedRecordId) fail("invalid-record");
  const steps = kit.array(record.steps);
  for (const stepValue of steps) {
    const step = kit.object(stepValue);
    if (step.inference === undefined) continue;
    await projectInferenceObservations(kit.object(step.inference), observations);
  }
}

async function projectInferenceObservations(
  inference: Record<string, unknown>,
  observations: Map<string, number>,
): Promise<void> {
  const attempts = kit.array(inference.attempts);
  if (attempts.length === 0) fail("invalid-record");

  // A transport fault is retried from its own budget, so it is observed against
  // the transport limits and never against `retry.*` contract limits.
  const transportCategories = transportRetryCategoriesOf(inference);
  const backoffs: number[] = [];
  const transportBackoffs: number[] = [];
  let contractRetries = 0;
  let transportRetries = 0;
  let transportElapsedMs = 0;
  // Condition retries, read from each attempt's recorded retry rule; an older
  // record has none and observes nothing against the condition budgets.
  let timedOutRetries = 0;
  let cutAnswerRetries = 0;
  let noProgressRetries = 0;
  for (const [index, attemptValue] of attempts.entries()) {
    const attempt = kit.object(attemptValue);
    if (nonnegativeInteger(attempt.attempt) !== index + 1) fail("invalid-record");
    const durationMs = nonnegativeInteger(attempt.durationMs);
    const transported = transportCategories.includes(attempt.outcome as string);
    if (transported) transportElapsedMs += durationMs;

    const retryScheduled = boolean(attempt.retryScheduled);
    if (attempt.backoffMs === undefined) {
      if (retryScheduled || index + 1 < attempts.length) fail("invalid-record");
    } else {
      const backoffMs = nonnegativeInteger(attempt.backoffMs);
      if (!retryScheduled || index + 1 === attempts.length) fail("invalid-record");
      if (transported) {
        transportRetries += 1;
        transportElapsedMs += backoffMs;
        transportBackoffs.push(backoffMs);
      } else {
        contractRetries += 1;
        backoffs.push(backoffMs);
      }
    }
    if (attempt.retryRule === "retried-cut-answer") cutAnswerRetries += 1;
    if (attempt.retryRule === "retried-no-progress") noProgressRetries += 1;
    if (
      attempt.retryRule === "retried-attempt-deadline" ||
      attempt.retryRule === "retried-provider-timeout"
    ) {
      timedOutRetries += 1;
    }

    await projectAttemptObservations(attempt, durationMs, index + 1, observations);
  }

  observe(observations, "retry.maxRetries", contractRetries);
  if (inference.conditionRetry !== undefined) {
    observe(observations, "retry.maxTimeoutRetries", timedOutRetries);
    observe(observations, "retry.maxCutAnswerRetries", cutAnswerRetries);
    // Older records with condition budgets had no no-progress budget.
    if (
      typeof inference.conditionRetry === "object" &&
      inference.conditionRetry !== null &&
      "maxNoProgressRetries" in inference.conditionRetry
    ) {
      observe(observations, "retry.maxNoProgressRetries", noProgressRetries);
    }
  }
  if (backoffs.length > 0) {
    observe(observations, "retry.baseDelayMs", backoffs[0]!);
    observe(observations, "retry.maxDelayMs", Math.max(...backoffs));
  }
  if (transportCategories.length > 0) {
    observe(observations, "retry.maxTransportRetries", transportRetries);
    observe(observations, "retry.transportMaxElapsedMs", transportElapsedMs);
    if (transportBackoffs.length > 0) {
      observe(observations, "retry.transportMaxDelayMs", Math.max(...transportBackoffs));
    }
  }
}

/** The categories a record's transport block names, or none for an older record. */
function transportRetryCategoriesOf(inference: Record<string, unknown>): readonly string[] {
  if (inference.transportRetry === undefined) return [];
  const categories = kit.object(inference.transportRetry).categories;
  if (!Array.isArray(categories) || categories.some((entry) => typeof entry !== "string")) {
    fail("invalid-record");
  }
  return categories as string[];
}

async function projectAttemptObservations(
  attempt: Record<string, unknown>,
  durationMs: number,
  attemptNumber: number,
  observations: Map<string, number>,
): Promise<void> {
  if (attempt.executionLease === undefined) return;
  const lease = await decodeLease(attempt.executionLease, attemptNumber);
  const usage = attempt.usage === undefined ? undefined : decodeUsage(attempt.usage);
  const tools = attempt.tools === undefined ? undefined : decodeTools(attempt.tools);
  const turns = attempt.turns === undefined ? undefined : decodeProviderTurns(attempt.turns);

  const providerTurns = agree(lease.providerTurns, [usage?.turns, turns]);
  const toolCalls = agree(lease.toolCalls, [tools]);
  // Tokens are read from the lease, which enforces these limits. It charges
  // every turn the session totals in `usage` count, plus any turn an in-turn
  // replay discarded, so it may exceed `usage` but never falls below it.
  if (
    usage !== undefined &&
    (lease.inputTokens < usage.input || lease.outputTokens < usage.output)
  ) {
    fail("invalid-record");
  }

  observe(observations, "compositionExecution.timeoutMs", durationMs);
  observe(observations, "compositionExecution.maxProviderTurns", providerTurns);
  observe(observations, "compositionExecution.maxToolCallsPerStep", lease.readingToolCalls);
  observe(observations, "compositionExecution.maxCumulativeInputTokens", lease.inputTokens);
  observe(observations, "compositionExecution.maxCumulativeOutputTokens", lease.outputTokens);
}

function decodeUsage(value: unknown): { input: number; output: number; turns: number } {
  const usage = kit.object(value);
  return {
    input: nonnegativeInteger(usage.input),
    output: nonnegativeInteger(usage.output),
    turns: nonnegativeInteger(usage.turns),
  };
}

function decodeTools(value: unknown): number {
  return nonnegativeInteger(kit.object(value).totalCalls);
}

function decodeProviderTurns(value: unknown): number {
  const turns = kit.array(value);
  let providerTurns = 0;
  for (const turnValue of turns) {
    const turn = kit.object(turnValue);
    if (turn.decision === "stop") continue;
    if (turn.decision !== "proceed" && turn.decision !== "compact") fail("invalid-record");
    providerTurns += 1;
    if (!Number.isSafeInteger(providerTurns)) fail("invalid-record");
  }
  return providerTurns;
}

async function decodeLease(
  value: unknown,
  attemptNumber: number,
): Promise<{
  providerTurns: number;
  toolCalls: number;
  readingToolCalls: number;
  inputTokens: number;
  outputTokens: number;
}> {
  let decode: ExecutionLeaseDecoder;
  try {
    decode = await loadExecutionLeaseDecoder();
  } catch (error) {
    fail("internal-error", { cause: error });
  }
  let lease: ExecutionLeaseRuntimeEvidenceV1;
  try {
    lease = decode(value);
  } catch (error) {
    // The decoder rejects a lease with ScorecardRecordError, or with
    // JsonEvidenceError when a value it canonicalizes, such as -0, is not JSON
    // evidence. Names are compared because the TypeScript route loads its own
    // module instance.
    if (
      error instanceof Error &&
      (error.name === "ScorecardRecordError" || error.name === "JsonEvidenceError")
    ) {
      fail("invalid-record");
    }
    fail("internal-error", { cause: error });
  }
  if (
    lease.phase !== "terminal" ||
    lease.binding.inferenceAttempt !== attemptNumber ||
    lease.binding.retriesConsumed !== attemptNumber - 1
  ) {
    fail("invalid-record");
  }
  return {
    providerTurns: lease.providerTurns,
    toolCalls: lease.toolCalls.executed,
    readingToolCalls: lease.toolCallsByScope?.reading ?? lease.toolCalls.executed,
    inputTokens: lease.cumulativeInputTokens,
    outputTokens: lease.cumulativeOutputTokens,
  };
}

/**
 * The compiled package imports the compiled decoder, so it needs no
 * devDependency. TypeScript sources load it through tsx: host services run this
 * module as CommonJS under tsx, and a native `import()` there would escape to
 * Node strip-types, which cannot parse the decoder graph's parameter
 * properties.
 */
async function loadExecutionLeaseDecoder(): Promise<ExecutionLeaseDecoder> {
  executionLeaseDecoder ??= (async () => {
    if (!new URL(import.meta.url).pathname.endsWith(".ts")) {
      return (await import("../scorecard-record-decode.js")).decodeExecutionLeaseRuntimeEvidence;
    }
    const runtimeRequire = createRequire(new URL("../../package.json", import.meta.url));
    const tsxCjs = runtimeRequire("tsx/cjs/api") as {
      require: (
        id: string,
        fromFile: string | URL,
      ) => { decodeExecutionLeaseRuntimeEvidence: ExecutionLeaseDecoder };
    };
    return tsxCjs.require("../scorecard-record-decode.ts", import.meta.url)
      .decodeExecutionLeaseRuntimeEvidence;
  })();
  return executionLeaseDecoder;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("invalid-record");
  return value as number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("invalid-record");
  return value;
}

function agree(primary: number, comparisons: readonly (number | undefined)[]): number {
  if (comparisons.some((value) => value !== undefined && value !== primary)) {
    fail("invalid-record");
  }
  return primary;
}

function observe(observations: Map<string, number>, name: string, value: number): void {
  const current = observations.get(name);
  if (current === undefined || value > current) observations.set(name, value);
}
