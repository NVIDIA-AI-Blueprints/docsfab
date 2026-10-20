// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

/** Newly authored public example; not a retained maturity-corpus case. */
export function noDocFixturePath(runtimeRoot) {
  return join(runtimeRoot, "test/fixtures/public-runtime/no-doc-dogfood");
}
