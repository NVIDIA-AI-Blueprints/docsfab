// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers used across init plan / probe / apply / render seams.
 */
import { execFile, spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { ReadOnlyCommandResult } from "../delivery/command-types.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { glabEnvironment } from "../delivery/gitlab-adapter.js";
import { loadPrivateDocsFabEnvironment } from "../config/private-environment.js";
import {
  SAFE_BRANCH,
  SAFE_GIT_CONFIG,
  SAFE_REMOTE,
  type CommandRunner,
  type FileIdentity,
  type DocsFabInitDependencies,
} from "./types.js";
import { sha256 } from "../content-ir/canonical.js";

export class ExecInitCommandRunner implements CommandRunner {
  run(
    command: "git" | "glab",
    args: readonly string[],
    cwd: string,
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<ReadOnlyCommandResult> {
    return new Promise((resolveResult) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          encoding: "utf8",
          env:
            options.env ??
            (command === "glab"
              ? glabEnvironment(loadPrivateDocsFabEnvironment())
              : gitEnvironment()),
          timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout, stderr) =>
          resolveResult({
            exitCode: error ? 1 : 0,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
            ...(error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? { failure: "output-limit" as const }
              : error?.killed
                ? { failure: "timeout" as const }
                : {}),
          }),
      );
    });
  }
}

export function configuredRemotePreference(
  result: ReadOnlyCommandResult,
  knownRemotes: readonly string[],
  label: string,
): string | undefined {
  if (result.exitCode !== 0) return undefined;
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw new Error(`The configured ${label} is ambiguous or unsafe.`);
  const value = lines[0]!;
  assertSafeRemoteName(value, `The configured ${label} is ambiguous or unsafe.`);
  if (!knownRemotes.includes(value))
    throw new Error(`The configured ${label} does not name a discovered remote.`);
  return value;
}

export function assertSafeRemoteName(value: string, message: string): void {
  if (!safeRemoteName(value)) throw new Error(message);
  assertCredentialFree(value, message);
}

export function safeRemoteName(value: string): boolean {
  return SAFE_REMOTE.test(value) && value === value.normalize("NFC") && credentialFree(value);
}

export function safeBranch(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    SAFE_BRANCH.test(value) &&
    credentialFree(value) &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value
      .split("/")
      .some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  );
}

export function credentialFree(value: unknown): boolean {
  return detectCredentialRuleIdsInValue(value).length === 0;
}

export function assertCredentialFree(value: unknown, message: string): void {
  if (!credentialFree(value)) throw new Error(message);
}

export function logSafe(dependencies: Pick<DocsFabInitDependencies, "log">, output: string): void {
  assertCredentialFree(
    output,
    "Initialization output contained credential material and was withheld.",
  );
  dependencies.log(output);
}

export function gitLabEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "GLAB_CONFIG_DIR",
    "GITLAB_HOST",
    "GLAB_TOKEN",
    "GITLAB_TOKEN",
    "LANG",
    "LC_ALL",
  ] as const;
  return Object.fromEntries(
    names.flatMap((name) => (environment[name] === undefined ? [] : [[name, environment[name]]])),
  ) as NodeJS.ProcessEnv;
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

export async function git(
  commands: CommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<ReadOnlyCommandResult> {
  return commands.run("git", [...SAFE_GIT_CONFIG, ...args], cwd, {
    env: gitEnvironment(),
  });
}

export function safeJson(result: ReadOnlyCommandResult): JsonEvidenceValue | undefined {
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 1024 * 1024) return undefined;
  try {
    return parseJsonEvidence(result.stdout);
  } catch {
    return undefined;
  }
}

export function accessLevel(value: unknown): number {
  return object(value) && positiveSafeInteger(value.access_level) && value.access_level <= 100
    ? value.access_level
    : 0;
}

export function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function fileIdentity(value: Stats): FileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
  };
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

export function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

export function currentUid(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined)
    throw new Error("DocsFab requires owner identity support on this platform.");
  return uid;
}

export function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return (
    fromLeft === "" ||
    fromRight === "" ||
    (!fromLeft.startsWith("..") && !isAbsolute(fromLeft)) ||
    (!fromRight.startsWith("..") && !isAbsolute(fromRight))
  );
}

export function normalizedAbsolute(value: string, label: string): string {
  if (!value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`DocsFab ${label} must be one normalized absolute path.`);
  }
  return value;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function object(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonObject(
  value: JsonEvidenceValue | undefined,
): Record<string, JsonEvidenceValue> | undefined {
  return object(value) ? (value as Record<string, JsonEvidenceValue>) : undefined;
}

export function isNotFound(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

export function isAlreadyExists(error: unknown): boolean {
  return object(error) && error.code === "EEXIST";
}

export { sha256 };
