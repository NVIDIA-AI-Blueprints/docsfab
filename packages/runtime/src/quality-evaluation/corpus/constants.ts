// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CORPUS_CASE_KINDS = [
  "greenfield-reader-jobs",
  "long-flat-site",
  "mixed-sibling-kinds",
  "hidden-throughlines",
  "monolithic-mixed-purpose-page",
  "long-reference-catalog",
  "evidence-poor-repository",
  "stale-approved-plan",
  "scaffold-collision",
  "context-prevents-duplication",
] as const;

export const CORPUS_DISPOSITIONS = [
  "recommendation-ready",
  "needs-human-input",
  "stale-plan-rejected",
  "collision-rejected",
  "duplication-prevented",
] as const;

export const CORPUS_FAILURE_CLASSES = [
  "blank-response",
  "malformed-response",
  "context-exhausted",
  "timeout",
  "throttled",
  "provider-transient",
  "invalid-request",
  "provider-terminal",
  "host-runtime-failure",
  "no-progress",
  "evidence-insufficient",
  "stale-plan",
  "scaffold-collision",
  "duplication-prevented",
] as const;
