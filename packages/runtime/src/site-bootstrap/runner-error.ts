// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SiteBootstrapErrorCode } from "./contracts.js";

export class SiteBootstrapRunnerError extends Error {
  public constructor(public readonly code: SiteBootstrapErrorCode) {
    super(`Site bootstrap failed: ${code}.`);
    this.name = "SiteBootstrapRunnerError";
  }
}
