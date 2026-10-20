// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable operator codes for repository preflight access failures. */
export type RepositoryAccessRefusalCodeV1 =
  | "repository-ownership-mismatch"
  | "repository-access-denied";

const MESSAGES: Readonly<Record<RepositoryAccessRefusalCodeV1, string>> = Object.freeze({
  "repository-ownership-mismatch":
    "Git refused to read the selected repository because its ownership does not match the current process.",
  "repository-access-denied":
    "Git could not read the selected repository with the current process permissions.",
});

/** Git uses 128 for fatal repository refusals, including dubious ownership. */
const GIT_REPOSITORY_REFUSAL_EXIT_CODE = 128;

/** A content-free refusal created only from a recognized repository access failure. */
export class RepositoryAccessRefusalError extends Error {
  public readonly code: RepositoryAccessRefusalCodeV1;

  public constructor(code: RepositoryAccessRefusalCodeV1) {
    if (!Object.hasOwn(MESSAGES, code)) {
      throw new TypeError("Repository access refusals must use a code shipped with DocsFab.");
    }
    super(MESSAGES[code]);
    this.name = "RepositoryAccessRefusalError";
    this.code = code;
  }
}

/**
 * Inspect only a native Git subprocess failure's stderr and exit status. The
 * text is matched as evidence and is never copied into an error or envelope.
 */
export function repositoryAccessRefusalCode(
  error: unknown,
): RepositoryAccessRefusalCodeV1 | undefined {
  if (!(error instanceof Error)) return undefined;
  const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(error, "stderr");
  if (
    codeDescriptor === undefined ||
    !Object.hasOwn(codeDescriptor, "value") ||
    codeDescriptor.value !== GIT_REPOSITORY_REFUSAL_EXIT_CODE ||
    stderrDescriptor === undefined ||
    !Object.hasOwn(stderrDescriptor, "value") ||
    typeof stderrDescriptor.value !== "string"
  ) {
    return undefined;
  }
  const stderr = stderrDescriptor.value as string;
  if (/^fatal: detected dubious ownership in repository at '[^\r\n]+'\.?$/mu.test(stderr)) {
    return "repository-ownership-mismatch";
  }
  if (
    /^(?:fatal|error): (?:cannot open|could not open|unable to read|unable to access) '[^\r\n]+'(?: for reading)?: Permission denied$/mu.test(
      stderr,
    ) ||
    /^fatal: cannot change to '[^\r\n]+': Permission denied$/mu.test(stderr)
  ) {
    return "repository-access-denied";
  }
  return undefined;
}

/** A failed realpath of the selected checkout proves a local access denial. */
export function repositoryFilesystemAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
  return (
    codeDescriptor !== undefined &&
    Object.hasOwn(codeDescriptor, "value") &&
    (codeDescriptor.value === "EACCES" || codeDescriptor.value === "EPERM")
  );
}
