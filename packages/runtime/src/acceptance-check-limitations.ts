// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// This module has no imports: vitest.config.ts loads it at run time, before the
// generated mirrors exist.

/**
 * Why the offline acceptance `check` phase cannot run a test file in its
 * network-denied sandbox.
 *
 * - `host-uid-view`: the sandbox is an unprivileged user namespace, which shows
 *   root-owned host paths as an unmapped uid, so root-or-self ownership checks
 *   cannot pass. It applies only on a run whose probe measured a different
 *   owner of `/` inside the sandbox than outside it.
 * - `registry-metadata`: the file needs npm registry metadata, which no
 *   network-denied check phase can reach. It applies to every such phase.
 */
export type AcceptanceCheckLimitationCause = "host-uid-view" | "registry-metadata";

export interface AcceptanceCheckLimitation {
  /** Runtime-package-relative test file the check phase does not run. */
  readonly file: string;
  readonly cause: AcceptanceCheckLimitationCause;
  readonly reason: string;
}

/**
 * Every file the acceptance check phase may leave out, with its cause. Each
 * still runs in the same-commit CI test lanes, which run outside the sandbox.
 * A sandbox that maps host root into its user namespace removes the
 * `host-uid-view` entries without a change here: its probe sees the same owner.
 */
export const ACCEPTANCE_CHECK_LIMITATIONS: readonly AcceptanceCheckLimitation[] = Object.freeze([
  Object.freeze({
    file: "test/roadmap-issue-cli-security.test.ts",
    cause: "host-uid-view",
    reason:
      "uid-namespace path trust: its private test root needs every ancestor from / owned by root or the current user, and the sandbox's user namespace shows root-owned / as another uid",
  }),
  Object.freeze({
    file: "test/doc-improvement-cli.test.ts",
    cause: "host-uid-view",
    reason:
      "uid-namespace path trust: documentation-improvement validation requires a root-owned npm runtime, and the sandbox's user namespace shows the root-owned npm package as another uid",
  }),
  Object.freeze({
    file: "test/native-composition-preflight.test.ts",
    cause: "host-uid-view",
    reason:
      "uid-namespace path trust: the local preflight host trusts only a root- or self-owned executable, and the sandbox's user namespace shows the root-owned node binary as another uid",
  }),
  Object.freeze({
    file: "test/live-agent-task-export.test.ts",
    cause: "host-uid-view",
    reason:
      "uid-namespace path trust: the private task export writes only below a directory whose every ancestor from / is owned by root or the current user, and the sandbox's user namespace shows root-owned / as another uid",
  }),
  Object.freeze({
    file: "test/live-agent-task-runner.test.ts",
    cause: "host-uid-view",
    reason:
      "uid-namespace path trust: the noninteractive task runner retains its result through the private task export, whose ancestors from / must be owned by root or the current user, and the sandbox's user namespace shows root-owned / as another uid",
  }),
  Object.freeze({
    file: "test/packed-profile-probe.test.ts",
    cause: "registry-metadata",
    reason:
      "registry metadata: npm install --global of the packed tarball fetches its direct dependencies' registry metadata, which a network-denied check cannot reach and an npm ci cache does not hold",
  }),
]);

/** Names the causes the acceptance measured; the Vitest config excludes their files. */
export const ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE = "DOCSFAB_ACCEPTANCE_CHECK_LIMITATIONS";

/**
 * The uid that owns `/` outside the offline sandbox and the uid the sandbox
 * shows for it. `inside` is null when the probe could not measure it.
 */
export interface HostRootOwnership {
  readonly outside: number;
  readonly inside: number | null;
}

export interface AcceptanceCheckConditions {
  /** True when the check phase runs inside the deny-network sandbox. */
  readonly networkDenied: boolean;
  /** Absent when no sandbox probe ran. */
  readonly hostRootOwner?: HostRootOwnership;
}

/** The measured conditions and the files they left out, as acceptance evidence records them. */
export interface AcceptanceCheckLimitationRecord extends AcceptanceCheckConditions {
  readonly excluded: readonly AcceptanceCheckLimitation[];
}

/**
 * The limitations whose cause holds for these measured conditions. An
 * unmeasured owner keeps the `host-uid-view` files in the run.
 */
export function applicableAcceptanceCheckLimitations(
  conditions: AcceptanceCheckConditions,
): AcceptanceCheckLimitation[] {
  const owner = conditions.hostRootOwner;
  const hostUidHidden =
    owner !== undefined && owner.inside !== null && owner.inside !== owner.outside;
  return ACCEPTANCE_CHECK_LIMITATIONS.filter((limitation) =>
    limitation.cause === "host-uid-view" ? hostUidHidden : conditions.networkDenied,
  );
}

/** The variable's value for these limitations: their causes, in catalog order. */
export function acceptanceCheckLimitationCauses(
  limitations: readonly AcceptanceCheckLimitation[],
): string {
  return [...new Set(limitations.map((limitation) => limitation.cause))].join(",");
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function uid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read a recorded limitation from acceptance evidence. It is valid only when
 * its exclusions are exactly what its own recorded conditions select, so the
 * evidence cannot name a file that its measurement does not justify.
 */
export function parseAcceptanceCheckLimitationRecord(
  value: unknown,
): AcceptanceCheckLimitationRecord | undefined {
  const record = plainRecord(value);
  if (!record || typeof record.networkDenied !== "boolean" || !Array.isArray(record.excluded)) {
    return undefined;
  }
  const keys = [
    "networkDenied",
    "excluded",
    ...("hostRootOwner" in record ? ["hostRootOwner"] : []),
  ];
  if (!hasExactKeys(record, keys)) return undefined;
  let hostRootOwner: HostRootOwnership | undefined;
  if ("hostRootOwner" in record) {
    const owner = plainRecord(record.hostRootOwner);
    if (
      !owner ||
      !hasExactKeys(owner, ["outside", "inside"]) ||
      !uid(owner.outside) ||
      !(owner.inside === null || uid(owner.inside))
    ) {
      return undefined;
    }
    hostRootOwner = { outside: owner.outside, inside: owner.inside };
  }
  const conditions = {
    networkDenied: record.networkDenied,
    ...(hostRootOwner ? { hostRootOwner } : {}),
  };
  const expected = applicableAcceptanceCheckLimitations(conditions);
  if (
    record.excluded.length !== expected.length ||
    record.excluded.some((entry, index) => {
      const limitation = plainRecord(entry);
      const wanted = expected[index]!;
      return (
        !limitation ||
        !hasExactKeys(limitation, ["file", "cause", "reason"]) ||
        limitation.file !== wanted.file ||
        limitation.cause !== wanted.cause ||
        limitation.reason !== wanted.reason
      );
    })
  ) {
    return undefined;
  }
  return { ...conditions, excluded: expected };
}

/**
 * The catalog entries for the causes named in the environment. A name outside
 * the catalog selects nothing, so its files keep running.
 */
export function acceptanceCheckExcludedFiles(
  environment: Readonly<Record<string, string | undefined>>,
): AcceptanceCheckLimitation[] {
  const causes = new Set((environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE] ?? "").split(","));
  return ACCEPTANCE_CHECK_LIMITATIONS.filter((limitation) => causes.has(limitation.cause));
}
