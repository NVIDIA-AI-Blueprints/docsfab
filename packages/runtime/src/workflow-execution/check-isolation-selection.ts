// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host selection of the isolation backend for repository-required checks.
 *
 * Checks select through the host-issued validation backend capability that
 * delivery validation uses (`delivery/worktree/validation-backend.ts`). Only
 * the process platform, read by the host, chooses. Serialized plan, config,
 * environment, CLI, and model values cannot name, construct, or widen a
 * backend.
 *
 * Required checks admit the two host-selected containment backends. They never
 * fall back to native macOS sandboxing or operator-supervised execution.
 */
import {
  issueHostSelectedValidationBackend,
  lookupValidationBackend,
  type ValidationBackendIdentity,
} from "../delivery/worktree/validation-backend.js";
import { DARWIN_DOCKER_DESKTOP_IMAGE } from "../delivery/worktree/docker-desktop-backend.js";
import { CHECK_ISOLATION_UNAVAILABLE } from "./check-sandbox.js";

/**
 * The weaker command-isolation tier of the attended live-agent session
 * (`documentationCommandSandbox` in `live-agent/command-sandbox.ts`): write
 * confinement only, with host-wide reads, network, and no descendant teardown.
 * Declared here by name so it is visibly not a required-check backend; no
 * value of it, and no sandbox that tier returns, is ever admitted below.
 */
export const ATTENDED_WRITE_CONFINEMENT_TIER = "attended-write-confinement" as const;

/** Host-issued backend identities that may run repository-required checks. */
export const REQUIRED_CHECK_BACKEND_IDENTITIES = [
  "linux-bubblewrap",
  "darwin-docker-desktop",
] as const satisfies readonly ValidationBackendIdentity[];
export type RequiredCheckBackendIdentity = (typeof REQUIRED_CHECK_BACKEND_IDENTITIES)[number];

export type CheckIsolationRefusal =
  /** Linux: `/usr/bin/bwrap` is absent, or it could not run the sandbox readiness probe. */
  | "linux-bubblewrap-unavailable"
  /** Linux: the sandbox's host inputs could not be prepared before bubblewrap ran. */
  | "linux-check-preparation-failed"
  /** macOS: Docker Desktop, its pinned image, or its readiness probe is unavailable. */
  | "darwin-docker-desktop-unavailable"
  /** macOS: the private checked view could not be prepared faithfully. */
  | "darwin-check-preparation-failed"
  | "platform-unsupported"
  /** The candidate was not a capability issued by the host backend authority. */
  | "untrusted-backend";

export const CHECK_ISOLATION_REFUSALS: readonly CheckIsolationRefusal[] = [
  "linux-bubblewrap-unavailable",
  "linux-check-preparation-failed",
  "darwin-docker-desktop-unavailable",
  "darwin-check-preparation-failed",
  "platform-unsupported",
  "untrusted-backend",
];

export type RequiredCheckBackendSelection =
  | { readonly status: "selected"; readonly identity: RequiredCheckBackendIdentity }
  | {
      readonly status: "refused";
      readonly refusal: CheckIsolationRefusal;
      readonly message: string;
      readonly backendIdentity?: ValidationBackendIdentity;
    };

/** Serialized inputs a caller may hold; accepted only to prove they cannot select. */
export type RequiredCheckSerializedInputs = Parameters<
  typeof issueHostSelectedValidationBackend
>[1];

/** A required-check isolation refusal that carries its typed reason into check evidence. */
export class CheckIsolationUnavailableError extends Error {
  public readonly refusal: CheckIsolationRefusal;
  public readonly backendIdentity?: ValidationBackendIdentity;

  public constructor(selection: Extract<RequiredCheckBackendSelection, { status: "refused" }>) {
    super(selection.message);
    this.name = "CheckIsolationUnavailableError";
    this.refusal = selection.refusal;
    if (selection.backendIdentity) this.backendIdentity = selection.backendIdentity;
  }
}

const DARWIN_REFUSAL = `Docker Desktop required-check isolation is unavailable; no repository command ran. Start Docker Desktop, load the pinned image with 'docker pull ${DARWIN_DOCKER_DESKTOP_IMAGE}', then retry. The proposed patch remains available for review.`;

const LINUX_PREPARATION_REFUSAL =
  "Read-only, offline check isolation could not be prepared on this host; no repository command ran. Linux bubblewrap was found, but the repository or runtime path could not be resolved, the check scratch directory could not be created in the host temporary directory, or the repository credential scan could not read the checkout.";

const UNTRUSTED_REFUSAL =
  "The required-check isolation backend was not issued by the host, so no repository command ran. This is a runtime defect; do not retry unchanged.";

function refused(
  refusal: CheckIsolationRefusal,
  platform: NodeJS.Platform,
  backendIdentity?: ValidationBackendIdentity,
): Extract<RequiredCheckBackendSelection, { status: "refused" }> {
  return {
    status: "refused",
    refusal,
    message: checkIsolationRefusalMessage(refusal, platform),
    ...(backendIdentity ? { backendIdentity } : {}),
  };
}

export function checkIsolationRefusalMessage(
  refusal: CheckIsolationRefusal,
  platform: NodeJS.Platform,
): string {
  switch (refusal) {
    case "linux-bubblewrap-unavailable":
      return CHECK_ISOLATION_UNAVAILABLE;
    case "linux-check-preparation-failed":
      return LINUX_PREPARATION_REFUSAL;
    case "darwin-docker-desktop-unavailable":
      return DARWIN_REFUSAL;
    case "darwin-check-preparation-failed":
      return "Docker Desktop could not prepare a private, credential-hidden view of the checked tree; no repository command ran. Ensure the proposed tree is readable and contains only supported files, directories, and safe symlinks, then retry.";
    case "platform-unsupported":
      return `Read-only, offline check isolation with bounded process lifetime is unavailable on this platform (${platform}); no repository command ran. Required checks run on Linux with working bubblewrap user namespaces or macOS with Docker Desktop.`;
    case "untrusted-backend":
      return UNTRUSTED_REFUSAL;
  }
}

/**
 * Admits only a capability the host validation-backend authority issued, and
 * only an identity required checks support. Anything else, including the
 * attended live-agent tier, a sandbox that tier returns, or a serialized
 * lookalike of a capability, refuses as `untrusted-backend`.
 */
export function admitRequiredCheckBackend(
  candidate: unknown,
  platform: NodeJS.Platform,
): RequiredCheckBackendSelection {
  const verifier = lookupValidationBackend(candidate);
  // A candidate the host authority did not issue, or no longer vouches for.
  if (!verifier?.verifyCurrent()) return refused("untrusted-backend", platform);
  switch (verifier.identity) {
    case "linux-bubblewrap":
      return { status: "selected", identity: "linux-bubblewrap" };
    case "darwin-docker-desktop":
      return { status: "selected", identity: "darwin-docker-desktop" };
  }
}

/**
 * Selects the required-check backend from the host platform alone. Serialized
 * inputs are forwarded only so tests can prove they cannot choose a backend.
 */
export function selectRequiredCheckBackend(
  platform: NodeJS.Platform,
  serialized?: RequiredCheckSerializedInputs,
): RequiredCheckBackendSelection {
  const capability = issueHostSelectedValidationBackend(platform, serialized);
  if (!capability) return refused("platform-unsupported", platform);
  return admitRequiredCheckBackend(capability, platform);
}

/**
 * The platform remedy for a required check that could not run because no
 * isolation backend was available (#1918). The run still delivers its patch;
 * the remedy says how to let DocsFab run the check next time. It is derived
 * from the typed refusals recorded in check evidence rather than from the host
 * that evaluates the gate. The specific remedy applies only when every such
 * check recorded the same recognized refusal; a mix, or any check without a
 * recognized refusal, gets the generic remedy. No other cause of a check that
 * could not run receives a remedy, so none is sent to another host.
 */
export function requiredCheckIsolationRemedy(recorded: readonly unknown[]): string {
  const recognized = (value: unknown): value is CheckIsolationRefusal =>
    CHECK_ISOLATION_REFUSALS.includes(value as CheckIsolationRefusal);
  const refusals = [...new Set(recorded.filter(recognized))];
  const fallback =
    "to have DocsFab run the check, rerun on a host where the isolated check executor can run the command, for example Linux with working bubblewrap user namespaces and the named tool installed.";
  if (refusals.length !== 1 || !recorded.every(recognized)) return fallback;
  switch (refusals[0]) {
    case "linux-bubblewrap-unavailable":
      return "provide Linux bubblewrap at /usr/bin/bwrap with working user namespaces on this host, or rerun on a Linux host that has them and the named tool installed.";
    case "linux-check-preparation-failed":
      return "bubblewrap is not the cause; make the repository path and every directory in it readable, and the host temporary directory (TMPDIR) writable, for DocsFab, then start a new run.";
    case "darwin-docker-desktop-unavailable":
      return `start Docker Desktop and load the pinned image with 'docker pull ${DARWIN_DOCKER_DESKTOP_IMAGE}', then start a new run on this Mac.`;
    case "darwin-check-preparation-failed":
      return "make the proposed tree readable and remove unsupported entries or unsafe symlinks, then start a new run on this Mac.";
    case "platform-unsupported":
      return "this platform has no required-check isolation backend, so rerun on Linux with working bubblewrap user namespaces and the named tool installed.";
    case "untrusted-backend":
      return "the isolation backend was not issued by the host, which is a runtime defect; report it with the run ID.";
    default:
      return fallback;
  }
}
