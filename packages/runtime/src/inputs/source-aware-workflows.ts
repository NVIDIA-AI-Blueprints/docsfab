// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Workflows that admit `--source` and `--change`. A workflow belongs here only
 * when its admitted request is representable in the source-request projection,
 * so the host's binding commits to the same bytes the runner recomputes. A
 * leaf, so run-record readers can import it without the CLI.
 */
export const SOURCE_AWARE_WORKFLOWS = ["create-documentation", "update-documentation"] as const;
