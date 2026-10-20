// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalDigest } from "../content-ir/index.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface RepositoryCheckDefinition {
  id: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface RepositoryCheckPolicy {
  id: string;
  version: string;
  digest: string;
  checks: RepositoryCheckDefinition[];
}

declare const repositoryCheckCapabilityBrand: unique symbol;

/** Opaque host-prepared authority to execute one exact repository-check policy. */
export interface RepositoryCheckCapability {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly [repositoryCheckCapabilityBrand]: true;
}

interface TrustedRepositoryCheck {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

interface RepositoryCheckCapabilityState {
  readonly policy: Readonly<{
    id: string;
    version: string;
    digest: string;
  }>;
  readonly checks: readonly TrustedRepositoryCheck[];
  readonly path: string;
}

const repositoryCheckCapabilityStates = new WeakMap<
  RepositoryCheckCapability,
  RepositoryCheckCapabilityState
>();
const trustedRepositoryCheckCapabilities = new WeakSet<RepositoryCheckCapability>();

export interface RepositoryCheckResult {
  id: string;
  status: "passed" | "failed";
  exitCode: number | null;
  signal: string | null;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface RepositoryCheckReport {
  schemaVersion: 1;
  policy: { id: string; version: string; digest: string };
  status: "passed" | "failed";
  results: RepositoryCheckResult[];
  digest: string;
}

export class RepositoryCheckError extends Error {
  public constructor(
    public readonly code:
      | "invalid-workspace"
      | "invalid-policy"
      | "executable-denied"
      | "invalid-command",
    public readonly path: string,
  ) {
    super(`Repository check rejected (${code}) at ${path}.`);
    this.name = "RepositoryCheckError";
  }
}

/** Host boundary that validates and seals exact check commands and executable authority. */
export async function prepareRepositoryCheckCapability(options: {
  policy: RepositoryCheckPolicy;
  allowedExecutables: readonly string[];
}): Promise<RepositoryCheckCapability> {
  const validatedPolicy = validatePolicy(options.policy);
  // Snapshot all caller-owned inputs before the first asynchronous boundary.
  const policy: RepositoryCheckPolicy = {
    id: validatedPolicy.id,
    version: validatedPolicy.version,
    digest: validatedPolicy.digest,
    checks: validatedPolicy.checks.map((check) => ({
      id: check.id,
      executable: check.executable,
      args: [...check.args],
      timeoutMs: check.timeoutMs,
    })),
  };
  const allowedExecutables = [...options.allowedExecutables];
  const executables = await validateExecutables(policy, allowedExecutables);
  const policyIdentity = Object.freeze({
    id: policy.id,
    version: policy.version,
    digest: policy.digest,
  });
  const checks = Object.freeze(
    [...policy.checks]
      .sort((left, right) => compareText(left.id, right.id))
      .map((check) =>
        Object.freeze({
          id: check.id,
          executable: executables.byCheckId.get(check.id)!,
          args: Object.freeze([...check.args]),
          timeoutMs: check.timeoutMs,
        }),
      ),
  );
  const capability = Object.freeze({
    ...policyIdentity,
  }) as RepositoryCheckCapability;
  repositoryCheckCapabilityStates.set(
    capability,
    Object.freeze({
      policy: policyIdentity,
      checks,
      path: executables.path,
    }),
  );
  trustedRepositoryCheckCapabilities.add(capability);
  return capability;
}

/** Runs host-prepared checks without a shell or inherited credential environment. */
export async function runRepositoryChecks(options: {
  workspacePath: string;
  capability: RepositoryCheckCapability;
}): Promise<RepositoryCheckReport> {
  const state = resolveRepositoryCheckCapability(options.capability);
  const workspace = await validatedWorkspace(options.workspacePath);
  const results: RepositoryCheckResult[] = [];
  for (const check of state.checks) {
    results.push(await executeCheck(workspace, check, state.path));
  }
  const value = {
    schemaVersion: 1 as const,
    policy: state.policy,
    status: results.every((result) => result.status === "passed")
      ? ("passed" as const)
      : ("failed" as const),
    results,
  };
  return { ...value, digest: canonicalDigest(value) };
}

function resolveRepositoryCheckCapability(
  capability: RepositoryCheckCapability,
): RepositoryCheckCapabilityState {
  const state = repositoryCheckCapabilityStates.get(capability);
  if (state === undefined || !trustedRepositoryCheckCapabilities.has(capability)) {
    throw new RepositoryCheckError("invalid-policy", "capability");
  }
  return state;
}

export function repositoryCheckPolicyDigest(policy: Omit<RepositoryCheckPolicy, "digest">): string {
  return canonicalDigest({
    id: policy.id,
    version: policy.version,
    checks: [...policy.checks]
      .map((check) => ({ ...check, args: [...check.args] }))
      .sort((left, right) => compareText(left.id, right.id)),
  });
}

async function validatedWorkspace(path: string): Promise<string> {
  const resolved = resolve(path);
  let info;
  let canonical;
  try {
    info = await lstat(resolved);
    canonical = await realpath(resolved);
  } catch {
    throw new RepositoryCheckError("invalid-workspace", "workspacePath");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RepositoryCheckError("invalid-workspace", "workspacePath");
  }
  return canonical;
}

function validatePolicy(policy: RepositoryCheckPolicy): RepositoryCheckPolicy {
  if (
    !IDENTIFIER.test(policy.id) ||
    !IDENTIFIER.test(policy.version) ||
    !SHA256.test(policy.digest) ||
    !Array.isArray(policy.checks) ||
    policy.checks.length === 0
  ) {
    throw new RepositoryCheckError("invalid-policy", "policy");
  }
  const ids = new Set<string>();
  for (const [index, check] of policy.checks.entries()) {
    const path = `policy.checks[${index}]`;
    if (!IDENTIFIER.test(check.id) || ids.has(check.id)) {
      throw new RepositoryCheckError("invalid-command", `${path}.id`);
    }
    ids.add(check.id);
    if (
      !Array.isArray(check.args) ||
      check.args.some(
        (argument) =>
          typeof argument !== "string" || argument.length > 4_096 || /[\0\r\n]/u.test(argument),
      )
    ) {
      throw new RepositoryCheckError("invalid-command", `${path}.args`);
    }
    if (
      !Number.isSafeInteger(check.timeoutMs) ||
      check.timeoutMs < 1 ||
      check.timeoutMs > 300_000
    ) {
      throw new RepositoryCheckError("invalid-command", `${path}.timeoutMs`);
    }
  }
  if (repositoryCheckPolicyDigest(policy) !== policy.digest) {
    throw new RepositoryCheckError("invalid-policy", "policy.digest");
  }
  return policy;
}

async function validateExecutables(
  policy: RepositoryCheckPolicy,
  allowedExecutables: readonly string[],
): Promise<{
  byCheckId: ReadonlyMap<string, string>;
  path: string;
}> {
  if (allowedExecutables.length === 0) {
    throw new RepositoryCheckError("invalid-policy", "allowedExecutables");
  }

  const allowed = new Set<string>();
  for (const [index, executable] of allowedExecutables.entries()) {
    const canonical = await canonicalExecutable(
      executable,
      "invalid-policy",
      `allowedExecutables[${index}]`,
    );
    if (allowed.has(canonical)) {
      throw new RepositoryCheckError("invalid-policy", "allowedExecutables");
    }
    allowed.add(canonical);
  }

  const byCheckId = new Map<string, string>();
  for (const [index, check] of policy.checks.entries()) {
    const path = `policy.checks[${index}].executable`;
    const canonical = await canonicalExecutable(check.executable, "invalid-command", path);
    if (!allowed.has(canonical)) {
      throw new RepositoryCheckError("executable-denied", path);
    }
    byCheckId.set(check.id, canonical);
  }

  return {
    byCheckId,
    path: [...new Set([...allowed].map((executable) => dirname(executable)))]
      .sort(compareText)
      .join(delimiter),
  };
}

async function canonicalExecutable(
  executable: string,
  code: "invalid-policy" | "invalid-command",
  path: string,
): Promise<string> {
  if (
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    resolve(executable) !== executable
  ) {
    throw new RepositoryCheckError(code, path);
  }

  try {
    const info = await lstat(executable);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RepositoryCheckError(code, path);
    }
    const canonical = await realpath(executable);
    if (canonical !== executable) {
      throw new RepositoryCheckError(code, path);
    }
    return canonical;
  } catch (error) {
    if (error instanceof RepositoryCheckError) throw error;
    throw new RepositoryCheckError(code, path);
  }
}

async function executeCheck(
  workspace: string,
  check: TrustedRepositoryCheck,
  path: string,
): Promise<RepositoryCheckResult> {
  try {
    const result = await execFileAsync(check.executable, [...check.args], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        PATH: path,
        CI: "1",
        NO_COLOR: "1",
      },
      maxBuffer: 1024 * 1024,
      timeout: check.timeoutMs,
      windowsHide: true,
    });
    return resultFor(check.id, "passed", 0, null, result.stdout, result.stderr);
  } catch (error) {
    const detail = error as {
      code?: unknown;
      signal?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const exitCode = typeof detail.code === "number" ? detail.code : null;
    const signal = typeof detail.signal === "string" ? detail.signal : null;
    return resultFor(
      check.id,
      "failed",
      exitCode,
      signal,
      typeof detail.stdout === "string" ? detail.stdout : "",
      typeof detail.stderr === "string" ? detail.stderr : "",
    );
  }
}

function resultFor(
  id: string,
  status: RepositoryCheckResult["status"],
  exitCode: number | null,
  signal: string | null,
  stdout: string,
  stderr: string,
): RepositoryCheckResult {
  return {
    id,
    status,
    exitCode,
    signal,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
