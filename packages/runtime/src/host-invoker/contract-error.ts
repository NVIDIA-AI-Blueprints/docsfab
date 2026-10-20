// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fail-closed hosted-runtime contract rejection. */
export class HostRuntimeContractError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Hosted runtime rejected: ${code}.`);
    this.name = "HostRuntimeContractError";
    this.code = code;
  }
}
