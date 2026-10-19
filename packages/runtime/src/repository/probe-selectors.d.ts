// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** These bound one batch, not total coverage or continuation rounds. */
export const REPOSITORY_MAX_BATCH_PROBES: number;
export const REPOSITORY_PROBE_MAX_PATH_CHARS: number;
export const REPOSITORY_PROBE_MIN_LITERAL_CHARS: number;
export const REPOSITORY_PROBE_MAX_LITERAL_CHARS: number;
export function isRepositoryProbePath(path: unknown): path is string;
export function isRepositoryLiteralProbeText(value: unknown): value is string;
