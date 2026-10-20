// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LimitDefinition } from "./limits.generated.js";

export interface SharedResolvedLimit {
  readonly name: string;
  readonly value: number;
  readonly source: "config/limits.yaml" | "host" | "project";
  readonly unit: string;
  readonly warnAt: number;
  readonly refusal: string;
  readonly remediation: string;
}

export const HOST_LIMITS_FILE: "/etc/docsfab/service.env";
export const HOST_LIMITS_FILE_UNREADABLE: "host-limits-file-unreadable";
export const HOST_LIMITS_FILE_REMEDIATION: string;

export interface HostLimitFileSource {
  readonly path: string;
  readonly origin: "argument" | "variable" | "default";
}

/** The installed host limits file a process skipped because it may not read it. */
export interface SkippedHostLimitFile {
  readonly code: "host-limits-file-unreadable";
  readonly path: string;
  /** The read error code, such as `EACCES`. */
  readonly reason: string;
  readonly remediation: string;
}

export interface HostLimitFileRead {
  readonly path: string | undefined;
  readonly values: Map<string, string>;
  readonly skipped: SkippedHostLimitFile | undefined;
}

export class HostLimitsFileError extends Error {
  readonly code: "host-limits-file-unreadable";
  readonly path: string;
  readonly origin: HostLimitFileSource["origin"];
  readonly reason: string;
  constructor(source: HostLimitFileSource, reason: string);
}

export function resolveHostLimitFileSource(
  hostFile: string | null | undefined,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): HostLimitFileSource | undefined;
export function resolveHostLimitFilePath(
  hostFile: string | null | undefined,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined;
/** Say once per process, on stderr, that DocsFab cannot use a host limits file. */
export function reportHostLimitFile(path: string, sentence: string): void;
/** Record that a refusal names this host limits file, so no notice repeats it. */
export function noteHostLimitFileRefused(path: string): void;
export function readHostLimitFile(
  hostFile: string | null | undefined,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): HostLimitFileRead;
export function readHostLimitFileAt(source: HostLimitFileSource | undefined): HostLimitFileRead;
export const RETIRED_LIMIT_NAMES: Readonly<Record<string, readonly string[]>>;
export const RETIRED_LIMIT_NAME_WARNING: "retired-limit-name";
export function retiredHostLimitNames(
  hostValues: Map<string, string>,
): readonly { readonly name: string; readonly replacements: readonly string[] }[];
export function retiredEnvironmentLimitNames(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): readonly { readonly name: string; readonly replacements: readonly string[] }[];
export function parseHostLimitAssignments(text: string, path: string): Map<string, string>;
export function parseLimitOverride(definition: LimitDefinition, raw: string): number;
export function resolveHostLimitOverrides(
  definitions: readonly LimitDefinition[],
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  hostValues: Map<string, string>,
): { readonly resolved: Map<string, number>; readonly presentKeys: Set<string> };
export function resolveLimitDefinitions(
  definitions: readonly LimitDefinition[],
  options?: {
    readonly environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    readonly hostValues?: Map<string, string>;
    readonly projectValues?: Map<string, number>;
  },
): readonly SharedResolvedLimit[];
export function assertDiskHeadroomOrder(
  definitions: readonly Pick<LimitDefinition, "name" | "override">[],
  resolved: readonly Pick<SharedResolvedLimit, "name" | "value">[],
): void;
export function assertSecretsLockOrder(
  definitions: readonly Pick<LimitDefinition, "name" | "override">[],
  resolved: readonly Pick<SharedResolvedLimit, "name" | "value">[],
): void;
