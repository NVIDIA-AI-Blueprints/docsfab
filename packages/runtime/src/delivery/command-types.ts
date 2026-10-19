// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface ReadOnlyCommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
  /** Local process limits, distinct from GitLab or command output. */
  failure?: "output-limit" | "timeout";
}
