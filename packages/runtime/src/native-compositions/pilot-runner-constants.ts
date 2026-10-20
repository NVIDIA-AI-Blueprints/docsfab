// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CROSS_HARNESS_PILOT_REPORT_KIND = "docsfab-cross-harness-comparison/v1" as const;
export const NATIVE_PILOT_ATTEMPT_RECEIPT_KIND = "docsfab-cross-harness-attempt/v1" as const;
export const NATIVE_PILOT_ROLE_RESULT_KIND = "docsfab-cross-harness-role-result/v1" as const;

export const NATIVE_PILOT_EVALUATION_ROLES = Object.freeze([
  "technical",
  "editorial",
  "audience",
  "layered",
  "quality",
] as const);

export const ROUTING_CHECK_IDS = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => `ROUTE-L1-${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 3 }, (_, index) => `ROUTE-L2-${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 4 }, (_, index) => `ROUTE-L3-${String(index + 1).padStart(3, "0")}`),
]);
