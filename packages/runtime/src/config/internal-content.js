// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PRIVATE_CONTENT_PATHS } from "./private-content-paths.js";

/** Refuse an internal-only operation without inventing a replacement corpus. */
export function internalContentPath(id) {
  const path = PRIVATE_CONTENT_PATHS[id];
  if (!path) {
    const error = new Error(
      `internal-content-unavailable: ${id} is retained internally. Use the authorized internal checkout for this qualification.`,
    );
    error.code = "internal-content-unavailable";
    throw error;
  }
  return path;
}
