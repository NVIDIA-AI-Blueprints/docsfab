// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { failReviewTarget, kit } from "./codec-kit.js";
import { LIMIT_DEFINITION_BY_NAME } from "../../config/limits.generated.js";

const PATH_MAX = LIMIT_DEFINITION_BY_NAME["reviewScope.pathMaxChars"]!.value;
const PATCH_MARKERS = /(?:^|\s)(?:diff --git |index [a-f0-9]{7,}\.\.|@@ )/u;
// A leading `/` is refused by the empty-segment rule in `relativePath`.
const NON_RELATIVE_PATH =
  /^(?:~(?:\/|$)|[A-Za-z]:\/|\$(?:TMPDIR|DOCSFAB_STATE_DIR|DOCSFAB_CONFIG_ROOT|HOST_PATH)(?:\/|$))|\\/u;

/**
 * A repository-relative path: not absolute, `~`, drive-letter or backslash
 * form, and not a path whose host root was replaced by an egress placeholder.
 */
function relativePath(value: unknown): string {
  const result = kit.string(value);
  if (
    NON_RELATIVE_PATH.test(result) ||
    result.length === 0 ||
    result.length > PATH_MAX ||
    result === "." ||
    result.includes("//") ||
    result.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    failReviewTarget("invalid-value");
  }
  return result;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    failReviewTarget("invalid-value");
  }
  return value;
}

export { PATCH_MARKERS, positiveInteger, relativePath };
