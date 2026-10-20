// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { UNDISPLAYABLE_CODE_POINT } from "../shared/display-text.js";

/**
 * What one `RunRecord.evidenceWarnings` entry may hold: non-empty, at most
 * 1,024 characters, and free of every code point a reader-facing line never
 * carries raw, the one escape set in `shared/display-text`: a control
 * character (C0, DEL, C1), a format character such as a bidirectional
 * override or isolate, or a line or paragraph separator. A producer that must
 * not lose its text checks it here before it records it.
 */
export function isRecordableEvidenceWarning(warning: string): boolean {
  return warning.length > 0 && warning.length <= 1_024 && !UNDISPLAYABLE_CODE_POINT.test(warning);
}
