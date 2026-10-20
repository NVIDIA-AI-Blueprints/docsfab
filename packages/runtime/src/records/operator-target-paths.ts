// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, UNSAFE_PATH_CODE_POINT } from "../contract-kit/index.js";

/** The operator's explicit target inputs, never targets selected by a model. */
export function decodeOperatorTargetPaths(value: unknown): readonly string[] {
  const kit = createContractKit({
    inertMode: "strict",
    fail: () => {
      throw new Error(
        "Run record operatorTargetPaths must contain unique safe repository-relative paths.",
      );
    },
    codes: {
      invalidShape: "invalid",
      invalidValue: "invalid",
      digestMismatch: "invalid",
      credentialMaterial: "invalid",
      schemaMismatch: "invalid",
    },
  });
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const paths = kit.array(value).map((entry) => {
    const path = kit.string(entry);
    if (
      path.includes("\\") ||
      /^[A-Za-z]:/u.test(path) ||
      UNSAFE_PATH_CODE_POINT.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      kit.fail("invalid");
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) kit.fail("invalid");
  return paths;
}
