// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical rubric wire IDs.
 *
 * These strings are protocol identities. JSON, CLI evidence, and published
 * artifacts must keep emitting the exact same bytes. Do not rename them.
 */
export const DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID = "docsfab.semantic-evidence-quality" as const;
/** Version 1 alias for the same semantic-evidence wire ID. */
export const DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID_V1 = DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID;
export const DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_VERSION = 1 as const;

export const DOCSFAB_LIVING_DOCUMENTATION_QUALITY_ID =
  "docsfab.living-documentation-quality" as const;
/** Version 1 alias for the same living-documentation wire ID. */
export const DOCSFAB_LIVING_DOCUMENTATION_QUALITY_ID_V1 = DOCSFAB_LIVING_DOCUMENTATION_QUALITY_ID;
export const DOCSFAB_LIVING_DOCUMENTATION_QUALITY_VERSION = 1 as const;
