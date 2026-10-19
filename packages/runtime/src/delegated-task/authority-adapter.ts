// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Task-scoped authority adapter for one delegated task. Direct tools, admitted
 * named checks, and named child workflows share one host-issued grant; session
 * history and lookalike objects are never authority. Write activation needs
 * branch-before-write preparation and a nested budget, which are not
 * available, so writes fail closed. This adapter grants no SCM authority.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import { WORKFLOW_CANCELLED, assertWorkflowActive } from "../execution/cancellation.js";
import { createConfinedToolSet, type ConfinedToolSet } from "../harness/confined-tools.js";
import { FILESYSTEM_READ_ONLY_TOOLS } from "../harness/pi-tool-confine.js";
import { DocumentationScope } from "../live-agent/documentation-scope.js";
import { inspectDelegatedWorkspaceBasis, type DelegatedWorkspaceBasis } from "./workspace-basis.js";

export const DELEGATED_TASK_AUTHORITY_KIND = "docsfab-delegated-task-authority" as const;
export const DELEGATED_WRITE_BLOCKED_ISSUES = ["#758", "#779"] as const;
export const DELEGATED_WRITE_ACTIVATION_MESSAGE =
  "Delegated write activation is blocked until #758 branch preparation and #779 nested budget are released; no documentation content or index mutation ran.";
export const DELEGATED_SCM_DENIED_MESSAGE =
  "A successful later branch result still grants no commit, push, merge-request, or merge action; #680 owns broader SCM authority.";
export const DELEGATED_SESSION_IS_NOT_AUTHORITY =
  "Session history, model messages, and lookalike grant objects cannot recreate delegated task authority.";

export const DELEGATED_OPERATION_CLASSES = [
  "inspect",
  "edit",
  "write",
  "generic-command",
  "git-scm",
  "source-code-write",
  "ci-write",
  "publication",
  "destructive",
  "commit",
  "push",
  "merge-request",
  "merge",
] as const;
export type DelegatedOperationClass = (typeof DELEGATED_OPERATION_CLASSES)[number];

export const DELEGATED_AUTHORITY_DENIAL_CODES = [
  "session-is-not-authority",
  "grant-revoked",
  "cancelled",
  "write-activation-blocked",
  "operation-denied",
  "check-binding-mismatch",
  "scm-authority-not-granted",
  "publication-denied",
  "path-denied",
] as const;
export type DelegatedAuthorityDenialCode = (typeof DELEGATED_AUTHORITY_DENIAL_CODES)[number];

export interface DelegatedTaskAuthority {
  readonly kind: typeof DELEGATED_TASK_AUTHORITY_KIND;
}

export interface DelegatedCheckDefinition {
  readonly checkId: string;
  readonly manager: "npm";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly canonicalRepositoryPath: string;
  readonly environmentAllowlist: readonly string[];
  readonly sideEffectClass: "read-only" | "write";
  readonly inputScope: readonly string[];
  readonly outputRoot: string;
  readonly scriptName: string;
  /** Optional substitution probe; omitted requests use the bound executable. */
  readonly executableRealpath?: string;
}

export interface BoundDelegatedCheck extends DelegatedCheckDefinition {
  readonly executableRealpath: string;
  readonly scriptPath: string;
  readonly scriptDefinition: string;
  readonly scriptBytesSha256: string;
  readonly environmentPolicySha256: string;
}

export interface DelegatedCheckEvidence {
  readonly evidenceId: string;
  readonly checkId: string;
  readonly currentInputIdentitySha256: string;
  readonly receiptSha256: string;
  readonly exitCode: number;
  readonly output: string;
}

export type DelegatedOperationResult<T> =
  | { readonly status: "allowed"; readonly value: T }
  | {
      readonly status: "denied";
      readonly code: DelegatedAuthorityDenialCode;
      readonly message: string;
      readonly blockedOn?: readonly string[];
      readonly branchReady?: false;
      readonly granted?: {
        readonly write: false;
        readonly commit: false;
        readonly push: false;
        readonly mergeRequest: false;
        readonly merge: false;
      };
    };

export interface DelegatedWriteActivationInput {
  readonly branchPreparation?: {
    readonly status: "succeeded" | "failed" | "mismatched";
    readonly branchName?: string;
  };
}

export interface CreateDelegatedTaskAuthorityInput {
  readonly repositoryPath: string;
  readonly allowWrite?: boolean;
  readonly additionalDocumentationDirectories?: readonly string[];
  readonly admittedCheck?: DelegatedCheckDefinition;
  readonly signal?: AbortSignal;
}

interface DelegatedTaskAuthorityState {
  readonly canonicalRepositoryPath: string;
  readonly documentationScope: DocumentationScope;
  readonly confined: ConfinedToolSet;
  readonly admittedCheck?: BoundDelegatedCheck;
  readonly allowWriteRequested: boolean;
  readonly signal?: AbortSignal;
  revoked: boolean;
  evidenceSerial: number;
  verifyCurrent(): { status: "current" };
}

const authorities = createHostAuthorityFactory<
  typeof DELEGATED_TASK_AUTHORITY_KIND,
  DelegatedTaskAuthorityState
>({
  kind: DELEGATED_TASK_AUTHORITY_KIND,
  invalidMessage: "Delegated task authority requires a current host verifier object.",
});

const WRITE_CLASSES = new Set<DelegatedOperationClass>([
  "edit",
  "write",
  "source-code-write",
  "ci-write",
]);
const SCM_CLASSES = new Set<DelegatedOperationClass>(["git-scm", "commit", "push", "merge"]);
const CI_PATH = /(?:^|\/)(?:\.gitlab(?:-ci\.yml)?|\.github)(?:\/|$)/u;
const SOURCE_PATH = /(?:^|\/)(?:src|lib|app|packages)\//u;

export class DelegatedTaskAuthorityError extends Error {
  public constructor(
    message: string,
    public readonly code: DelegatedAuthorityDenialCode,
  ) {
    super(message);
    this.name = "DelegatedTaskAuthorityError";
  }
}

export function resolveDelegatedTaskAuthority(value: unknown): DelegatedTaskAuthority | undefined {
  if (!value || typeof value !== "object") return undefined;
  const authority = value as DelegatedTaskAuthority;
  if (authority.kind !== DELEGATED_TASK_AUTHORITY_KIND) return undefined;
  return authorities.lookup(authority) ? authority : undefined;
}

export function revokeDelegatedTaskAuthority(authority: DelegatedTaskAuthority): void {
  const state = requireState(authority);
  state.revoked = true;
}

export function delegatedTaskGrantIsActive(authority: unknown): boolean {
  const resolved = resolveDelegatedTaskAuthority(authority);
  if (!resolved) return false;
  const state = authorities.lookup(resolved);
  return Boolean(state) && !state!.revoked && !state!.signal?.aborted;
}

export async function createDelegatedTaskAuthority(
  input: CreateDelegatedTaskAuthorityInput,
): Promise<DelegatedTaskAuthority> {
  const canonicalRepositoryPath = await canonicalExistingDirectory(input.repositoryPath);
  const documentationScope = new DocumentationScope(input.additionalDocumentationDirectories ?? []);
  const confined = await createConfinedToolSet({
    workspacePath: canonicalRepositoryPath,
    allowWrite: false,
    isWritePathAllowed: (path) => documentationScope.allows(path),
    readTextRendering: "source-coordinates",
  });
  const admittedCheck = input.admittedCheck
    ? await bindAdmittedCheck(canonicalRepositoryPath, input.admittedCheck)
    : undefined;
  const state: DelegatedTaskAuthorityState = {
    canonicalRepositoryPath,
    documentationScope,
    confined,
    admittedCheck,
    allowWriteRequested: input.allowWrite === true,
    signal: input.signal,
    revoked: false,
    evidenceSerial: 0,
    verifyCurrent() {
      if (this.revoked || this.signal?.aborted) {
        throw new DelegatedTaskAuthorityError(
          "The delegated task grant was revoked or cancelled and cannot authorize further operations.",
          "grant-revoked",
        );
      }
      return { status: "current" };
    },
  };
  return authorities.create(state);
}

export function grantedDirectToolNames(authority: DelegatedTaskAuthority): readonly string[] {
  const state = requireState(authority);
  return Object.freeze(
    state.confined.definitions
      .map((definition) => definition.name)
      .filter((name) => (FILESYSTEM_READ_ONLY_TOOLS as readonly string[]).includes(name)),
  );
}

export function grantedCheckCapabilities(authority: DelegatedTaskAuthority): {
  readonly adapter: "named-structured";
  readonly temporaryOutput: boolean;
  readonly edit: false;
  readonly bash: false;
  readonly scm: false;
  readonly repositoryWrite: false;
} {
  requireState(authority);
  return {
    adapter: "named-structured",
    temporaryOutput: true,
    edit: false,
    bash: false,
    scm: false,
    repositoryWrite: false,
  };
}

export async function inspectDelegatedPath(
  authority: DelegatedTaskAuthority,
  path: string,
): Promise<DelegatedOperationResult<string>> {
  const denied = denyIfInactive(authority);
  if (denied) return denied;
  const state = requireState(authority);
  const relativePath = workspaceRelative(path);
  const read = state.confined.definitions.find((definition) => definition.name === "read");
  if (!read) {
    return deny(
      "operation-denied",
      "Delegated inspection cannot run because the confined read tool is unavailable.",
    );
  }
  try {
    const result = await read.execute(
      "delegated-inspect",
      { path: relativePath },
      state.signal,
      undefined,
      undefined as never,
    );
    return { status: "allowed", value: toolText(result) };
  } catch (error) {
    return deny(
      "path-denied",
      error instanceof Error
        ? error.message
        : "Delegated inspection was denied before any repository mutation.",
    );
  }
}

export async function probeDelegatedOperation(
  authority: DelegatedTaskAuthority,
  operation: DelegatedOperationClass,
  path = "docs/guide.md",
): Promise<DelegatedOperationResult<never>> {
  const denied = denyIfInactive(authority);
  if (denied) return denied;
  if (operation === "inspect") {
    const inspection = await inspectDelegatedPath(authority, path);
    return inspection.status === "allowed"
      ? deny("operation-denied", "Inspection is not a denied probe class for this grant.")
      : inspection;
  }
  if (
    WRITE_CLASSES.has(operation) ||
    operation === "generic-command" ||
    operation === "destructive"
  ) {
    return writeActivationDenied(operation, path);
  }
  if (SCM_CLASSES.has(operation) || operation === "merge-request" || operation === "publication") {
    return {
      status: "denied",
      code: operation === "publication" ? "publication-denied" : "scm-authority-not-granted",
      message: DELEGATED_SCM_DENIED_MESSAGE,
      blockedOn: [...DELEGATED_WRITE_BLOCKED_ISSUES],
      branchReady: false,
      granted: scmDeniedGrant(),
    };
  }
  return deny(
    "operation-denied",
    "Delegated task authority denied the requested operation before side effects.",
  );
}

export async function attemptDelegatedWriteActivation(
  authority: DelegatedTaskAuthority,
  input: DelegatedWriteActivationInput = {},
): Promise<DelegatedOperationResult<never>> {
  const denied = denyIfInactive(authority);
  if (denied) return denied;
  const branch = input.branchPreparation;
  if (!branch || branch.status !== "succeeded") {
    return {
      status: "denied",
      code: "write-activation-blocked",
      message:
        "A failed or mismatched #758 branch result blocks delegated writes before content or index mutation; branch readiness is not claimed.",
      blockedOn: [...DELEGATED_WRITE_BLOCKED_ISSUES],
      branchReady: false,
      granted: scmDeniedGrant(),
    };
  }
  return {
    status: "denied",
    code: "write-activation-blocked",
    message: `${DELEGATED_WRITE_ACTIVATION_MESSAGE} ${DELEGATED_SCM_DENIED_MESSAGE}`,
    blockedOn: [...DELEGATED_WRITE_BLOCKED_ISSUES],
    branchReady: false,
    granted: scmDeniedGrant(),
  };
}

export async function inspectDelegatedGitMetadata(
  authority: DelegatedTaskAuthority,
): Promise<DelegatedOperationResult<DelegatedWorkspaceBasis>> {
  const denied = denyIfInactive(authority);
  if (denied) return denied;
  const state = requireState(authority);
  const basis = await inspectDelegatedWorkspaceBasis(state.canonicalRepositoryPath);
  return { status: "allowed", value: basis };
}

export function writeActivationSuppliersMissing(): {
  readonly taskBudgetPresent: boolean;
  readonly blockedOn: readonly string[];
} {
  return {
    taskBudgetPresent: existsSync(resolve("src/execution/task-budget.ts")),
    blockedOn: [...DELEGATED_WRITE_BLOCKED_ISSUES],
  };
}

export async function executeAdmittedCheck(
  authority: DelegatedTaskAuthority,
  request: DelegatedCheckDefinition,
  options: { readonly run?: typeof runCheckProcess } = {},
): Promise<DelegatedOperationResult<DelegatedCheckEvidence>> {
  const denied = denyIfInactive(authority);
  if (denied) return denied;
  const state = requireState(authority);
  const bound = state.admittedCheck;
  if (!bound) {
    return deny(
      "check-binding-mismatch",
      "Delegated named-check execution requires a check definition bound when the grant was issued.",
    );
  }
  const mismatch = await checkBindingMismatch(bound, request);
  if (mismatch) return deny("check-binding-mismatch", mismatch);
  const currentInputIdentitySha256 = await currentInputIdentity(bound);
  const run = options.run ?? runCheckProcess;
  const result = await run({
    executable: bound.executableRealpath,
    argv: [bound.scriptPath, ...bound.argv.slice(bound.argv.indexOf("--") + 1)],
    cwd: bound.cwd,
    env: boundEnvironment(bound),
    outputRoot: bound.outputRoot,
    signal: state.signal,
  });
  state.evidenceSerial += 1;
  const evidenceId = `check:${bound.checkId}:${state.evidenceSerial}`;
  const receiptSha256 = canonicalDigest({
    evidenceId,
    currentInputIdentitySha256,
    exitCode: result.exitCode,
    outputSha256: sha256(result.output),
  });
  return {
    status: "allowed",
    value: {
      evidenceId,
      checkId: bound.checkId,
      currentInputIdentitySha256,
      receiptSha256,
      exitCode: result.exitCode,
      output: result.output,
    },
  };
}

export function evidenceAttestsCurrentInput(
  evidence: DelegatedCheckEvidence,
  currentInputIdentitySha256: string,
): boolean {
  return evidence.currentInputIdentitySha256 === currentInputIdentitySha256;
}

export async function currentInputIdentityForGrant(
  authority: DelegatedTaskAuthority,
): Promise<string> {
  const state = requireState(authority);
  if (!state.admittedCheck) {
    throw new DelegatedTaskAuthorityError(
      "Delegated current-input identity requires a named check bound to this grant.",
      "check-binding-mismatch",
    );
  }
  return currentInputIdentity(state.admittedCheck);
}

function requireState(authority: DelegatedTaskAuthority): DelegatedTaskAuthorityState {
  const state = authorities.lookup(authority);
  if (!state) {
    throw new DelegatedTaskAuthorityError(
      DELEGATED_SESSION_IS_NOT_AUTHORITY,
      "session-is-not-authority",
    );
  }
  return state;
}

function denyIfInactive(
  authority: DelegatedTaskAuthority,
): DelegatedOperationResult<never> | undefined {
  const resolved = resolveDelegatedTaskAuthority(authority);
  if (!resolved) {
    return deny("session-is-not-authority", DELEGATED_SESSION_IS_NOT_AUTHORITY);
  }
  const state = requireState(resolved);
  if (state.revoked) {
    return deny(
      "grant-revoked",
      "The delegated task grant was revoked and cannot authorize newly requested operations.",
    );
  }
  try {
    assertWorkflowActive(state.signal);
  } catch {
    return deny("cancelled", WORKFLOW_CANCELLED);
  }
  return undefined;
}

function deny(
  code: DelegatedAuthorityDenialCode,
  message: string,
): DelegatedOperationResult<never> {
  return { status: "denied", code, message };
}

function writeActivationDenied(
  operation: DelegatedOperationClass,
  path: string,
): DelegatedOperationResult<never> {
  const ciOrSource =
    operation === "source-code-write" || SOURCE_PATH.test(path)
      ? " Source-code writes stay outside this documentation grant."
      : operation === "ci-write" || CI_PATH.test(path)
        ? " CI writes stay outside this documentation grant."
        : "";
  return {
    status: "denied",
    code: "write-activation-blocked",
    message: `${DELEGATED_WRITE_ACTIVATION_MESSAGE}${ciOrSource}`,
    blockedOn: [...DELEGATED_WRITE_BLOCKED_ISSUES],
    branchReady: false,
    granted: scmDeniedGrant(),
  };
}

function scmDeniedGrant() {
  return {
    write: false,
    commit: false,
    push: false,
    mergeRequest: false,
    merge: false,
  } as const;
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

function workspaceRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !normalized ||
    isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new DelegatedTaskAuthorityError(
      "Delegated inspection requires a repository-relative path without parent or absolute segments.",
      "path-denied",
    );
  }
  return normalized;
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  if (
    typeof path !== "string" ||
    path.trim() === "" ||
    !isAbsolute(path) ||
    path.split(/[\\/]/u).includes("..")
  ) {
    throw new DelegatedTaskAuthorityError(
      "Delegated task authority requires an existing absolute local repository directory.",
      "path-denied",
    );
  }
  const canonical = await realpath(resolve(path));
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) {
    throw new DelegatedTaskAuthorityError(
      "Delegated task authority requires an existing absolute local repository directory.",
      "path-denied",
    );
  }
  return canonical;
}

async function bindAdmittedCheck(
  canonicalRepositoryPath: string,
  definition: DelegatedCheckDefinition,
): Promise<BoundDelegatedCheck> {
  if (definition.manager !== "npm" || definition.sideEffectClass !== "read-only") {
    throw new DelegatedTaskAuthorityError(
      "Delegated named checks admit only the structured npm adapter with read-only side effects.",
      "check-binding-mismatch",
    );
  }
  if (
    definition.argv.length < 3 ||
    definition.argv[0] !== "test" ||
    definition.argv[1] !== "--" ||
    definition.scriptName !== "test"
  ) {
    throw new DelegatedTaskAuthorityError(
      "Delegated named checks require the exact npm test argv array including the -- separator.",
      "check-binding-mismatch",
    );
  }
  const cwd = await realpath(definition.cwd);
  const grantedRepo = await realpath(definition.canonicalRepositoryPath);
  if (cwd !== canonicalRepositoryPath || grantedRepo !== canonicalRepositoryPath) {
    throw new DelegatedTaskAuthorityError(
      "Delegated named-check cwd and canonical repository must resolve to the granted repository.",
      "check-binding-mismatch",
    );
  }
  const outputRoot = await realpath(definition.outputRoot);
  if (outputRoot === canonicalRepositoryPath || isInside(canonicalRepositoryPath, outputRoot)) {
    throw new DelegatedTaskAuthorityError(
      "Delegated named-check output roots must stay on the bounded temporary path outside the repository.",
      "check-binding-mismatch",
    );
  }
  const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scriptDefinition = packageJson.scripts?.[definition.scriptName];
  if (typeof scriptDefinition !== "string" || !scriptDefinition.startsWith("node ")) {
    throw new DelegatedTaskAuthorityError(
      "Delegated named checks require a node script definition in the bound package.json test script.",
      "check-binding-mismatch",
    );
  }
  const scriptPath = await realpath(resolve(cwd, scriptDefinition.slice("node ".length).trim()));
  const scriptBytesSha256 = sha256(await readFile(scriptPath));
  return {
    ...definition,
    sideEffectClass: "read-only",
    cwd,
    canonicalRepositoryPath,
    outputRoot,
    executableRealpath: await realpath(process.execPath),
    scriptPath,
    scriptDefinition,
    scriptBytesSha256,
    environmentPolicySha256: canonicalDigest([...definition.environmentAllowlist].sort()),
    argv: Object.freeze([...definition.argv]),
    environmentAllowlist: Object.freeze([...definition.environmentAllowlist]),
    inputScope: Object.freeze([...definition.inputScope]),
  };
}

async function checkBindingMismatch(
  bound: BoundDelegatedCheck,
  request: DelegatedCheckDefinition,
): Promise<string | undefined> {
  const cwd = await realpath(request.cwd).catch(() => "");
  const repo = await realpath(request.canonicalRepositoryPath).catch(() => "");
  if (cwd !== bound.cwd || repo !== bound.canonicalRepositoryPath) {
    return "Delegated named-check cwd or canonical repository no longer matches the issued grant.";
  }
  if (request.argv.join("\0") !== bound.argv.join("\0")) {
    return "Delegated named-check argv order or content no longer matches the issued grant.";
  }
  if (request.scriptName !== bound.scriptName || request.manager !== bound.manager) {
    return "Delegated named-check executable identity no longer matches the issued grant.";
  }
  if (request.sideEffectClass !== "read-only") {
    return "Delegated named-check side-effect class no longer matches the issued read-only grant.";
  }
  if (canonicalDigest([...request.environmentAllowlist].sort()) !== bound.environmentPolicySha256) {
    return "Delegated named-check environment policy no longer matches the issued grant.";
  }
  if (request.inputScope.join("\0") !== bound.inputScope.join("\0")) {
    return "Delegated named-check input scope no longer matches the issued grant.";
  }
  const outputRoot = await realpath(request.outputRoot).catch(() => "");
  if (outputRoot !== bound.outputRoot) {
    return "Delegated named-check output root no longer matches the issued grant.";
  }
  const packageJson = JSON.parse(await readFile(join(bound.cwd, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (packageJson.scripts?.[bound.scriptName] !== bound.scriptDefinition) {
    return "Delegated named npm script definition no longer matches the issued grant.";
  }
  const requestedExecutable = await realpath(request.executableRealpath ?? process.execPath);
  if (requestedExecutable !== bound.executableRealpath) {
    return "Delegated named-check executable identity no longer matches the issued grant.";
  }
  const scriptPath = await realpath(bound.scriptPath).catch(() => "");
  if (scriptPath !== bound.scriptPath) {
    return "Delegated named-check executable identity no longer matches the issued grant.";
  }
  const scriptBytesSha256 = sha256(await readFile(bound.scriptPath));
  if (scriptBytesSha256 !== bound.scriptBytesSha256) {
    return "Delegated named-check executable identity no longer matches the issued grant.";
  }
  return undefined;
}

async function currentInputIdentity(bound: BoundDelegatedCheck): Promise<string> {
  const files = [];
  for (const path of bound.inputScope) {
    const absolute = resolve(bound.canonicalRepositoryPath, path);
    const bytes = await readFile(absolute);
    files.push({ path, sha256: sha256(bytes) });
  }
  return canonicalDigest({
    canonicalRepositoryPath: bound.canonicalRepositoryPath,
    cwd: bound.cwd,
    argv: bound.argv,
    files,
    scriptDefinition: bound.scriptDefinition,
    scriptBytesSha256: bound.scriptBytesSha256,
  });
}

function boundEnvironment(bound: BoundDelegatedCheck): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of bound.environmentAllowlist) {
    if (key === "TMPDIR" || key === "TMP" || key === "TEMP") {
      env[key] = bound.outputRoot;
      continue;
    }
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.TMPDIR = bound.outputRoot;
  env.npm_config_offline = "true";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  return env;
}

export interface CheckProcessRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly outputRoot: string;
  readonly signal?: AbortSignal;
}

export async function runCheckProcess(
  request: CheckProcessRequest,
): Promise<{ exitCode: number; output: string }> {
  assertWorkflowActive(request.signal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(request.executable, [...request.argv], {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new DelegatedTaskAuthorityError(
          "Delegated named-check execution exceeded its bounded process lifetime and was stopped.",
          "operation-denied",
        ),
      );
    }, 15_000);
    request.signal?.addEventListener(
      "abort",
      () => {
        child.kill("SIGKILL");
      },
      { once: true },
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8").slice(0, 16_384),
      });
    });
  });
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
