// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted runtime's one Git entry point, shared by the read path and the
 * write path in `patch-evidence.ts`: a fixed absolute binary, no hooks, no
 * fsmonitor, no credential helper, no protocol access, a closed environment, a
 * bounded output size, a timeout, and process-group kill.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { catalogCapacity } from "../config/catalog-capacity.js";
import { limit, refuseLimit, type ResolveLimitsOptions } from "../config/limits.js";

const TRUSTED_GIT = "/usr/bin/git";
const TRUSTED_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "advice.graftFileDeprecated=false",
] as const;

function trustedGitEnvironment(localFilesOnly: boolean): NodeJS.ProcessEnv {
  return {
    HOME: "/var/empty/docsfab",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: localFilesOnly ? "file" : "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
}

function killTrustedGitGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
/**
 * Read through `catalogCapacity`, not `limit()`: each Git call inside the
 * worker must not touch the filesystem or environment to learn its bounds, and
 * the three are `sealed` because an override on the output cap or kill timeout
 * would weaken the confinement.
 */
export const MAX_GIT_OUTPUT_BYTES = catalogCapacity("hostInvoker.gitOutputMaxBytes");
const GIT_TIMEOUT_MILLISECONDS = catalogCapacity("hostInvoker.gitTimeoutMs");
const DEFAULT_GIT_OUTPUT_BYTES = catalogCapacity("hostInvoker.gitDefaultOutputMaxBytes");

/**
 * Why a trusted Git call failed, so a caller can code its own refusal without
 * reading the message. `exitCode` is set only for `exit`, and is `null` when a
 * signal ended the process.
 */
export type TrustedGitFailureKind = "timeout" | "output-bound" | "exit" | "spawn";

export class TrustedGitError extends Error {
  public readonly kind: TrustedGitFailureKind;
  public readonly exitCode: number | null;

  public constructor(kind: TrustedGitFailureKind, message: string, exitCode: number | null = null) {
    super(message);
    this.name = "TrustedGitError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

export type TrustedGitBlobFailureCode =
  | "pinned-blob-input-invalid"
  | "pinned-blob-framing-invalid"
  | "pinned-blob-type-or-length-mismatch"
  | "pinned-blob-object-id-mismatch";

export class TrustedGitBlobError extends Error {
  public readonly code: TrustedGitBlobFailureCode;

  public constructor(message: string, code: TrustedGitBlobFailureCode) {
    super(message);
    this.name = "TrustedGitBlobError";
    this.code = code;
  }
}

/**
 * Stream one pinned local blob under the snapshot writer's effective byte
 * admission. This fixed command is separate from runTrustedGit's sealed
 * buffered-output contract; only framing and discarded stderr use that cap.
 */
export async function readTrustedGitBlob(input: {
  readonly sourcePath: string;
  readonly objectId: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly expectedByteLength: number;
  readonly signal?: AbortSignal;
  readonly limits?: ResolveLimitsOptions;
}): Promise<Buffer> {
  const { objectId, objectFormat, expectedByteLength, signal } = input;
  const validId =
    objectFormat === "sha1"
      ? /^[a-f0-9]{40}$/u.test(objectId)
      : objectFormat === "sha256" && /^[a-f0-9]{64}$/u.test(objectId);
  if (
    !isAbsolute(input.sourcePath) ||
    !validId ||
    !Number.isSafeInteger(expectedByteLength) ||
    expectedByteLength < 0
  )
    throw new TrustedGitBlobError(
      "Pinned Git blob input requires an absolute source path, valid object ID, and safe byte length.",
      "pinned-blob-input-invalid",
    );
  const ownerLimit = limit("reviewDelivery.snapshotUniqueOriginalBytesMax", input.limits);
  if (expectedByteLength > ownerLimit.value) refuseLimit(ownerLimit, expectedByteLength);
  if (signal?.aborted) throw abortError();
  const sourcePath = await realpath(input.sourcePath);
  if (signal?.aborted) throw abortError();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(TRUSTED_GIT, [...TRUSTED_GIT_CONFIG, "cat-file", "--batch"], {
      cwd: sourcePath,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: trustedGitEnvironment(false),
    });
    const exactHeader = `${objectId} blob ${expectedByteLength}\n`;
    const hash = createHash(objectFormat).update(`blob ${expectedByteLength}\0`, "latin1");
    let state: "header" | "body" | "trailer" | "done" = "header";
    let header = Buffer.alloc(0);
    let body: Buffer | undefined;
    let written = 0;
    let framingAndStderrBytes = 0;
    let terminationError: Error | undefined;
    const terminate = (error: Error): void => {
      if (terminationError) return;
      terminationError = error;
      killTrustedGitGroup(child);
    };
    const chargeFraming = (count: number): boolean => {
      framingAndStderrBytes += count;
      if (framingAndStderrBytes <= MAX_GIT_OUTPUT_BYTES) return true;
      terminate(
        new TrustedGitError("output-bound", "Hosted runtime Git output exceeded its closed bound."),
      );
      return false;
    };
    const consume = (chunk: Buffer): void => {
      if (terminationError) return;
      let at = 0;
      try {
        while (at < chunk.byteLength && !terminationError) {
          if (state === "header") {
            const end = chunk.indexOf(0x0a, at);
            const length = (end < 0 ? chunk.byteLength : end + 1) - at;
            if (!chargeFraming(length)) return;
            header = Buffer.concat([header, chunk.subarray(at, at + length)]);
            at += length;
            if (end < 0) return;
            if (header.toString("latin1") !== exactHeader) {
              terminate(
                new TrustedGitBlobError(
                  "The pinned Git blob has a different object type or byte length than the verified source record.",
                  "pinned-blob-type-or-length-mismatch",
                ),
              );
              return;
            }
            body = Buffer.alloc(expectedByteLength);
            state = expectedByteLength === 0 ? "trailer" : "body";
          } else if (state === "body") {
            const take = Math.min(expectedByteLength - written, chunk.byteLength - at);
            chunk.copy(body!, written, at, at + take);
            hash.update(chunk.subarray(at, at + take));
            written += take;
            at += take;
            if (written === expectedByteLength) state = "trailer";
          } else if (state === "trailer") {
            if (!chargeFraming(1)) return;
            if (chunk[at++] !== 0x0a) {
              terminate(
                new TrustedGitBlobError(
                  "The pinned Git blob response has invalid framing or ended before its declared bytes.",
                  "pinned-blob-framing-invalid",
                ),
              );
              return;
            }
            state = "done";
          } else {
            chargeFraming(chunk.byteLength - at);
            terminate(
              new TrustedGitBlobError(
                "The pinned Git blob response has invalid framing or ended before its declared bytes.",
                "pinned-blob-framing-invalid",
              ),
            );
          }
        }
      } catch {
        terminate(
          new TrustedGitBlobError(
            "The pinned Git blob response has invalid framing or ended before its declared bytes.",
            "pinned-blob-framing-invalid",
          ),
        );
      }
    };
    const onAbort = (): void => terminate(abortError());
    const timer = setTimeout(
      () => terminate(new TrustedGitError("timeout", "Hosted runtime trusted Git timed out.")),
      GIT_TIMEOUT_MILLISECONDS,
    );
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdin!.on("error", () =>
      terminate(
        new TrustedGitBlobError(
          "The pinned Git blob response has invalid framing or ended before its declared bytes.",
          "pinned-blob-framing-invalid",
        ),
      ),
    );
    child.stdout!.on("data", consume);
    child.stderr!.on("data", (chunk: Buffer) => {
      chargeFraming(chunk.byteLength);
    });
    child.once("error", () =>
      terminate(new TrustedGitError("spawn", "Hosted runtime trusted Git could not start.")),
    );
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (terminationError) reject(terminationError);
      else if (code !== 0)
        reject(
          new TrustedGitError(
            "exit",
            `Hosted runtime trusted Git failed (${code === null ? (exitSignal ?? "signal") : code}).`,
            code,
          ),
        );
      else if (state !== "done" || written !== expectedByteLength || body === undefined)
        reject(
          new TrustedGitBlobError(
            "The pinned Git blob response has invalid framing or ended before its declared bytes.",
            "pinned-blob-framing-invalid",
          ),
        );
      else if (hash.digest("hex") !== objectId)
        reject(
          new TrustedGitBlobError(
            "The pinned Git blob content does not match its verified Git object ID.",
            "pinned-blob-object-id-mismatch",
          ),
        );
      else resolve(body);
    });
    if (!terminationError) child.stdin!.end(Buffer.from(`${objectId}\n`, "latin1"));
  });
}

export async function runTrustedGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  maximumBytes = DEFAULT_GIT_OUTPUT_BYTES,
  /** Verified in-memory patch bytes; avoids reopening a retained artifact by path. */
  input?: Buffer,
): Promise<Buffer> {
  return executeTrustedGit(cwd, args, signal, maximumBytes, false, input);
}

/**
 * Copy only the explicitly selected local source revision into a fresh private
 * repository.
 *
 * This is the one call that may use Git's local file transport, and only for an
 * absolute local path and an exact 40/64-hex revision. Every other call keeps
 * `GIT_ALLOW_PROTOCOL` empty.
 */
export async function fetchTrustedLocalGitRevision(
  cwd: string,
  sourcePath: string,
  revision: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!sourcePath.startsWith("/") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision))
    throw new Error(
      "Hosted candidate source must be an absolute local repository and exact revision.",
    );
  // One selected commit and its tree, not the source's history. `--depth=1` is
  // history depth, not a capacity. Submodule content is not copied.
  await executeTrustedGit(
    cwd,
    [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      sourcePath,
      revision,
    ],
    signal,
    MAX_GIT_OUTPUT_BYTES,
    true,
  );
}

function executeTrustedGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  maximumBytes: number,
  localFilesOnly: boolean,
  input?: Buffer,
): Promise<Buffer> {
  if (signal?.aborted) throw abortError();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(TRUSTED_GIT, [...TRUSTED_GIT_CONFIG, ...args], {
      cwd,
      detached: true,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: trustedGitEnvironment(localFilesOnly),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let terminationError: Error | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const terminate = (error: Error): void => {
      if (terminationError) return;
      terminationError = error;
      killTrustedGitGroup(child);
    };
    const collect = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximumBytes) {
        terminate(
          new TrustedGitError(
            "output-bound",
            "Hosted runtime Git output exceeded its closed bound.",
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    child.stdin?.once("error", () => {
      terminate(new Error("Hosted runtime trusted Git rejected its verified input."));
    });
    if (input) child.stdin?.end(input);
    child.stdout!.on("data", collect);
    child.stderr!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumBytes)
        terminate(
          new TrustedGitError(
            "output-bound",
            "Hosted runtime Git output exceeded its closed bound.",
          ),
        );
    });
    child.once("error", () =>
      finish(new TrustedGitError("spawn", "Hosted runtime trusted Git could not start.")),
    );
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      if (terminationError) finish(terminationError);
      else if (code === 0) finish();
      else
        finish(
          new TrustedGitError(
            "exit",
            `Hosted runtime trusted Git failed (${code === null ? (exitSignal ?? "signal") : code}).`,
            code,
          ),
        );
    });
    const onAbort = (): void => terminate(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => terminate(new TrustedGitError("timeout", "Hosted runtime trusted Git timed out.")),
      GIT_TIMEOUT_MILLISECONDS,
    );
    timer.unref();
  });
}

export function abortError(): Error {
  const error = new Error("Hosted runtime trusted Git was aborted.");
  error.name = "AbortError";
  return error;
}
