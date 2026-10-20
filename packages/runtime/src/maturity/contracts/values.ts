// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DOCUMENTATION_MATURITY_GATE_IDS = ["G0", "G1", "G2", "G3", "G4", "G5"] as const;

export const DOCUMENTATION_ISSUE_PRIORITIES = ["P0", "P1", "P2"] as const;

export const DOCUMENTATION_MATURITY_DISPOSITIONS = [
  "observed-absence",
  "bounded-not-found",
  "unknown",
  "not-applicable",
  "blocked",
  "satisfied",
] as const;

export const DOCUMENTATION_FINDING_SEVERITIES = [
  "critical",
  "major",
  "minor",
  "informational",
] as const;

export const DOCUMENTATION_FINDING_CONFIDENCE = ["confirmed", "bounded", "inconclusive"] as const;

export const DOCUMENTATION_AUDIENCES = [
  "reader",
  "new-user",
  "operator",
  "maintainer",
  "contributor",
  "support",
] as const;

export const DOCUMENTATION_HUMAN_INPUT_KINDS = [
  "product-policy",
  "ownership",
  "support-commitment",
  "approval",
  "other",
] as const;

export const DOCUMENTATION_VERIFICATION_METHODS = [
  "repository-observation",
  "bounded-search",
  "workflow-outcome",
  "human-attestation",
] as const;
