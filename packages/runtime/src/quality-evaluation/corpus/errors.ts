// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export class CorpusValidationError extends Error {
  public constructor(public readonly code: string) {
    super(`Living-documentation corpus rejected (${code}).`);
    this.name = "CorpusValidationError";
  }
}
