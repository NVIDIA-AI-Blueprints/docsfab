// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Per-call transport bounds shared with semantic nominations; coverage can span later calls. */
/** Unit: requests/batch. */
export const REPOSITORY_MAX_BATCH_PROBES = 32;
/** Unit: UTF-16 code units/path. */
export const REPOSITORY_PROBE_MAX_PATH_CHARS = 1024;
/** Unit: UTF-16 code units/query. Refuses degenerate one-character probes. */
export const REPOSITORY_PROBE_MIN_LITERAL_CHARS = 2;
/** Unit: UTF-16 code units/query. */
export const REPOSITORY_PROBE_MAX_LITERAL_CHARS = 128;

export function isRepositoryProbePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= REPOSITORY_PROBE_MAX_PATH_CHARS &&
    path === path.normalize("NFC") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\0-\x1f\x7f]/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function isRepositoryLiteralProbeText(value) {
  return (
    typeof value === "string" &&
    value.length >= REPOSITORY_PROBE_MIN_LITERAL_CHARS &&
    value.length <= REPOSITORY_PROBE_MAX_LITERAL_CHARS &&
    !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  );
}
