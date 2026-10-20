// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline, fictional Foundation Canon source bytes for the foundation-to-patch
 * dogfood test. Identifiers are stable test labels, never credentials, URLs,
 * machine paths, or production documents.
 */

/** Keyed by relative fixture path. */
export const FOUNDATION_CANON_SYNTHETIC_SOURCE_BYTES: Record<string, string> = {
  "evaluation/foundation-canon/sources/charter.pdf.txt": [
    "SYNTHETIC PDF EXTRACT — Foundation Charter (fictional)",
    "Review gate requires two maintainer approvals before governed release.",
    "Applicability: governed-release @ version-series-2",
  ].join("\n"),
  "evaluation/foundation-canon/sources/charter-p2.extract.txt": [
    "SYNTHETIC EXTRACT — charter page 2",
    "The review gate statement is binding for version-series-2 releases.",
  ].join("\n"),
  "evaluation/foundation-canon/sources/release-notes.extract.txt": [
    "SYNTHETIC EXTRACT — release notes page 1",
    "Quarterly operating review is recommended; cadence is not a release gate.",
  ].join("\n"),
  "evaluation/foundation-canon/sources/docs/governance.md": [
    "# Governance (stale synthetic page)",
    "Owner: unspecified",
    "Last reviewed: version-series-1 (superseded)",
  ].join("\n"),
  "evaluation/foundation-canon/sources/docs/governance-current.md": [
    "# Governance (current synthetic page)",
    "Owner: docs-governance-board",
    "Last reviewed: version-series-2",
  ].join("\n"),
  "evaluation/foundation-canon/sources/docs/release-guide.md": [
    "# Release guide",
    "Governed releases follow the Foundation Charter review gate.",
  ].join("\n"),
  "evaluation/foundation-canon/sources/docs/operations-guide.md": [
    "# Operations guide",
    "Operating reviews are tracked separately from release gates.",
  ].join("\n"),
  "evaluation/foundation-canon/sources/weak-blog.extract.txt": [
    "SYNTHETIC WEAK SOURCE — informal blog paraphrase",
    "Someone said approvals might be optional.",
  ].join("\n"),
};
