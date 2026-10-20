// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  assertAcceptanceEvidenceDirectory,
  pinAcceptanceEvidenceDirectory,
  writeAcceptanceJsonExclusive,
  type AcceptanceEvidenceDirectory,
} from "../acceptance-evidence.js";
import {
  assertCollectableAcceptanceEvidence,
  canonicalizeAcceptanceOutputRoot,
  canonicalizeCollectableEvidenceDestination,
} from "../acceptance.js";
import { ensurePrivateRunDirectory } from "../records/file-store.js";

/**
 * Owner-private evidence directory identity shared by root operator CLIs.
 * Credential material must never enter these helpers or their call sites.
 */
export type PrivateOperatorEvidenceDirectory = AcceptanceEvidenceDirectory;

export interface PreparePrivateOperatorRootInput {
  readonly requestedPath: string;
  readonly repositoryRoot: string;
  /** CLI flag or human label used in boundary error messages. */
  readonly label: string;
  /** Validate several destinations before allocating any of them. Defaults to true. */
  readonly create?: boolean;
}

/**
 * Canonicalize an operator-selected path outside the repository without
 * following symlinks and return the resolved absolute root. Unless create is
 * false, create missing parents as owner-only directories.
 */
export async function canonicalizePrivateOperatorRoot(
  input: PreparePrivateOperatorRootInput,
): Promise<string> {
  return canonicalizeAcceptanceOutputRoot(input.requestedPath, input.repositoryRoot, input.label, {
    create: input.create ?? true,
  });
}

/**
 * Ensure `path` is an owner-only private directory, then pin and reassert its
 * evidence identity. The path must already be absolute and outside the source
 * repository when used as an operator output root.
 */
export async function ensurePinnedPrivateOperatorRoot(
  path: string,
): Promise<PrivateOperatorEvidenceDirectory> {
  await ensurePrivateRunDirectory(path);
  const pinned = await pinAcceptanceEvidenceDirectory(path);
  await assertAcceptanceEvidenceDirectory(pinned);
  return pinned;
}

/** Canonicalize, privatize, and pin an operator-selected output root outside the repository. */
export async function preparePrivateOperatorRoot(
  input: PreparePrivateOperatorRootInput,
): Promise<PrivateOperatorEvidenceDirectory> {
  const canonical = await canonicalizePrivateOperatorRoot(input);
  return ensurePinnedPrivateOperatorRoot(canonical);
}

/** Pin an existing private evidence directory without creating or repairing it. */
export async function pinPrivateOperatorEvidenceDirectory(
  directory: string,
): Promise<PrivateOperatorEvidenceDirectory> {
  return pinAcceptanceEvidenceDirectory(directory);
}

/** Reassert a previously pinned private evidence directory identity. */
export async function assertPrivateOperatorEvidenceDirectory(
  directory: PrivateOperatorEvidenceDirectory,
): Promise<void> {
  await assertAcceptanceEvidenceDirectory(directory);
}

export interface CollectableOperatorDestinationInput {
  readonly requestedPath: string;
  /** Canonical private roots (state, evidence) the destination must never overlap. */
  readonly privateRoots: readonly string[];
  /** CLI flag or human label used in boundary error messages. */
  readonly label: string;
}

/**
 * Validate a collectable evidence destination without creating it. Unlike
 * private roots it may sit inside the checkout so CI can collect it, but it
 * must avoid symbolic links and stay disjoint from every private root.
 */
export async function canonicalizeCollectableOperatorDestination(
  input: CollectableOperatorDestinationInput,
): Promise<string> {
  return canonicalizeCollectableEvidenceDestination(input);
}

export interface PublishCollectableOperatorEvidenceInput
  extends CollectableOperatorDestinationInput {
  /** Fresh per-invocation directory name under the destination; never reused. */
  readonly invocationId: string;
  readonly file: string;
  /** Already-minimized terminal evidence. Raw run records never belong here. */
  readonly value: unknown;
  /** Caller environment whose credential values the evidence must not contain. */
  readonly environment: NodeJS.ProcessEnv;
}

const SAFE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Publish minimized evidence to `<destination>/<invocationId>/<file>`. Evidence
 * carrying a credential value or private-root location is refused before any
 * write. The destination is revalidated at write time, the invocation directory
 * is owner-only and pinned, and the leaf is written exclusively, so an earlier
 * collection is never overwritten.
 */
export async function publishCollectableOperatorEvidence(
  input: PublishCollectableOperatorEvidenceInput,
): Promise<string> {
  if (!SAFE_INVOCATION_ID.test(input.invocationId) || input.invocationId.includes("..")) {
    throw new Error(`${input.label} evidence requires a single safe invocation directory name.`);
  }
  assertCollectableAcceptanceEvidence(input.value, {
    environment: input.environment,
    privateRoots: input.privateRoots,
    label: input.label,
  });
  const destination = await canonicalizeCollectableEvidenceDestination(input);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if ((await realpath(destination)) !== destination) {
    throw new Error(`${input.label} must not resolve through symbolic links once it is created.`);
  }
  await canonicalizeCollectableEvidenceDestination(input);
  const directory = await ensurePinnedPrivateOperatorRoot(join(destination, input.invocationId));
  await writeAcceptanceJsonExclusive(directory, input.file, input.value);
  return join(directory.path, input.file);
}
