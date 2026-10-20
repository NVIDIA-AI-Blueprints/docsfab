// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function isPreservedRecordedOriginToken(token: string): boolean;
export function projectHttpsOrigin(raw: unknown): string | null;
export function projectModelBaseUrl(raw: unknown): string | null;
export function sanitizeDisplaySpans(value: string | null | undefined): Array<[number, number]>;
export function sanitizeDisplayText(
  value: string | null | undefined,
  projectHostRoots?: (text: string) => string,
): string | null | undefined;
export function sanitizeReportValue<T>(value: T, seen?: Set<object>): T;
