// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DocsFabBuildIdentityV1 {
  readonly schemaVersion: 1;
  /** Full commit SHA, or `null` for a build made outside a Git checkout. */
  readonly commit: string | null;
  /** Whether tracked or untracked, non-ignored files differed from `commit`. */
  readonly dirty: boolean | null;
}

export const DOCSFAB_BUILD_IDENTITY: DocsFabBuildIdentityV1;
