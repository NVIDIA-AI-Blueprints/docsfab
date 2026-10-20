// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The refusal an installed quality pack raises. This leaf module holds only the
 * error and its codes, so the failure classifier can recognize the type without
 * loading the pack verifier. `manifest.ts` re-exports both.
 */
import { qualityPackRestoreAction } from "./restore.js";

export type QualityPackErrorCode =
  | "lock-unavailable"
  | "migration-required"
  | "invalid-lock"
  | "invalid-manifest"
  | "stale"
  | "tampered"
  | "unsafe-path"
  | "file-set-mismatch"
  | "checksum-mismatch";

const ERROR_MESSAGES: Readonly<Record<QualityPackErrorCode, string>> = {
  "lock-unavailable": "Quality pack lock or manifest is unavailable for verification.",
  "migration-required":
    "Runtime quality lock predates the product-default resource declaration; regenerate it with npm run generate:quality-pack or reinstall DocsFab.",
  "invalid-lock": "Runtime quality lock failed closed validation.",
  "invalid-manifest": "B+C quality-pack manifest failed closed validation.",
  stale: "B+C quality-pack binding is stale against its generated locks.",
  tampered: "Quality pack bytes failed closed integrity verification.",
  "unsafe-path": "Quality pack contains an unsafe filesystem path.",
  "file-set-mismatch": "Runtime quality file set does not match its generated lock.",
  "checksum-mismatch": "Runtime quality file or bundle checksum does not match its lock.",
};

export class QualityPackError extends Error {
  public readonly code: QualityPackErrorCode;
  public constructor(code: QualityPackErrorCode, message: string = ERROR_MESSAGES[code]) {
    super(message);
    this.code = code;
    this.name = "QualityPackError";
  }

  /** The operator envelope prints this as the next action; doctor reports the same step. */
  public get nextAction(): string {
    return qualityPackRestoreAction();
  }
}
