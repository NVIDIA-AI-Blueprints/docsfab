// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The DocsFab source revision this runtime was built from. This checked-in
 * module is unstamped; `scripts/build-package.mjs` replaces its `dist/` copy
 * with the checkout's commit and whether the checkout differed from it.
 */
export const DOCSFAB_BUILD_IDENTITY = Object.freeze({
  schemaVersion: 1,
  commit: null,
  dirty: null,
});
