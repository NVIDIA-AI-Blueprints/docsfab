// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Closed result types for cold review-locator authority; this module has no runtime dependencies. */
export type ReviewLocatorLimitation =
  | "legacy-unavailable"
  | "read-unobserved"
  | "source-blob-unavailable"
  | "binding-mismatch"
  | "observation-invalid";

export type ReviewLocatorAuthority = { readonly kind: "docsfab-review-locator-authority" };
export type ReviewLocatorLoadResult =
  | { readonly kind: "verified"; readonly authority: ReviewLocatorAuthority }
  | { readonly kind: "unavailable"; readonly reason: ReviewLocatorLimitation };
