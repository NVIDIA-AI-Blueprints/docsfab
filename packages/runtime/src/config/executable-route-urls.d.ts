// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const EXECUTABLE_ROUTE_BASE_URLS: Readonly<{
  readonly "nvidia-inference-api"?: string;
  readonly "nvidia-api-catalog": "https://integrate.api.nvidia.com/v1";
  readonly "openai-api": "https://api.openai.com/v1";
  readonly "anthropic-api": "https://api.anthropic.com/v1";
}>;

export const EXECUTABLE_ROUTE_ORIGINS: ReadonlySet<string>;

export function isExecutableRouteOrigin(
  routeId: keyof typeof EXECUTABLE_ROUTE_BASE_URLS,
  origin: string,
): boolean;
