// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HistoricalQualityProgram {
  readonly schemaVersion: 1;
  readonly role: "historical-program-identity";
  readonly qualityPath: string;
  readonly qualitySourcePath: string;
  readonly barId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly policy: Readonly<{
    qualityLockSha256: string;
    manifestSha256: string;
    skillLockSha256: string;
  }>;
}
export interface QualityExecutionResource {
  readonly scope: "quality" | "skill";
  readonly kind: "script" | "module";
  readonly path: string;
  readonly skillId?: string;
  readonly moduleName?: string;
}
export const HISTORICAL_QUALITY_PROGRAM: HistoricalQualityProgram;
export const QUALITY_EXECUTION_RESOURCES: Readonly<
  Record<
    "evaluation" | "quality-score" | "report-binding" | "derivation" | "decision-policy",
    QualityExecutionResource
  >
>;
export class QualityResourceRoleError extends Error {
  readonly code: "historical-program" | "unsupported-execution" | "invalid-identity";
  constructor(code: QualityResourceRoleError["code"]);
}
export function isHistoricalQualityProgramPath(path: string): boolean;
export function qualityExecutionResource(selection: unknown): QualityExecutionResource;
export function assertHistoricalQualityProgramIdentity(input: {
  programBytes: Uint8Array;
  qualityLockBytes: Uint8Array;
  manifestBytes: Uint8Array;
  skillLockBytes: Uint8Array;
}): void;
