// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export class DocImprovementEvidenceError extends Error {
  public constructor(public readonly code: string) {
    super(`Bounded documentation improvement evidence rejected (${code}).`);
    this.name = "DocImprovementEvidenceError";
  }
}

export function fail(code: string): never {
  throw new DocImprovementEvidenceError(code);
}
