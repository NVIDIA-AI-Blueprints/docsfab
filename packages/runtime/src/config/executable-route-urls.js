// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  PRIVATE_EXECUTABLE_ROUTE_BASE_URLS,
  PRIVATE_EXECUTABLE_ROUTE_ORIGIN_SHA256,
} from "./private-route-urls.js";

/**
 * Exact HTTPS origins recorded in installed composition deployment identities.
 * Shared by TypeScript execution-profile projection and JS display sanitizers.
 */
export const EXECUTABLE_ROUTE_BASE_URLS = Object.freeze({
  ...PRIVATE_EXECUTABLE_ROUTE_BASE_URLS,
  "nvidia-api-catalog": "https://integrate.api.nvidia.com/v1",
  "openai-api": "https://api.openai.com/v1",
  "anthropic-api": "https://api.anthropic.com/v1",
});

/** Origin-only forms of EXECUTABLE_ROUTE_BASE_URLS (no path, query, or credentials). */
export const EXECUTABLE_ROUTE_ORIGINS = new Set(
  Object.values(EXECUTABLE_ROUTE_BASE_URLS).map((baseUrl) => new URL(baseUrl).origin),
);

/** Verify an origin; an omitted private default never becomes a guessed or decoded URL. */
export function isExecutableRouteOrigin(routeId, origin) {
  const baseUrl = Object.hasOwn(EXECUTABLE_ROUTE_BASE_URLS, routeId)
    ? EXECUTABLE_ROUTE_BASE_URLS[routeId]
    : undefined;
  if (baseUrl !== undefined) return new URL(baseUrl).origin === origin;
  const identity = Object.hasOwn(PRIVATE_EXECUTABLE_ROUTE_ORIGIN_SHA256, routeId)
    ? PRIVATE_EXECUTABLE_ROUTE_ORIGIN_SHA256[routeId]
    : undefined;
  return identity !== undefined && createHash("sha256").update(origin).digest("hex") === identity;
}
