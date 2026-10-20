// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  EXECUTABLE_ROUTE_BASE_URLS,
  isExecutableRouteOrigin,
} from "../config/executable-route-urls.js";
import type { ModelEndpointConfig } from "./configuration.js";

/** The private route and its catalog are available only when this distribution supplies it. */
const inferenceBaseUrl = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
export const NVIDIA_INFERENCE_CATALOG_ORIGIN =
  inferenceBaseUrl === undefined ? undefined : new URL(inferenceBaseUrl).origin;
export const OPENAI_API_ORIGIN = "https://api.openai.com" as const;
export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com" as const;

export const OPENAI_API_CATALOG_ADAPTER = {
  id: "adapter:openai-api-model-catalog",
  version: "1.0.0",
} as const;
export const OPENAI_API_CATALOG_SOURCE_ID = "openai-api-model-catalog" as const;

export const ANTHROPIC_API_CATALOG_ADAPTER = {
  id: "adapter:anthropic-api-model-catalog",
  version: "1.0.0",
} as const;
export const ANTHROPIC_API_CATALOG_SOURCE_ID = "anthropic-api-model-catalog" as const;

export type ModelCatalogAdapterSet =
  | "nvidia-inference-api"
  | "openai-api"
  | "anthropic-api"
  | "unimplemented";

const OPENAI_PROVIDER_IDS = new Set(["openai-api", "openai"]);
const ANTHROPIC_PROVIDER_IDS = new Set(["anthropic-api", "anthropic"]);

/** Select the catalog-approval adapter set from the bound serving route. */
export function resolveModelCatalogAdapterSet(
  endpoint: Pick<ModelEndpointConfig, "providerId" | "baseUrl">,
): ModelCatalogAdapterSet {
  try {
    const url = new URL(endpoint.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return "unimplemented";
    }
    const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    if (isExecutableRouteOrigin("nvidia-inference-api", url.origin) && path === "/v1") {
      return "nvidia-inference-api";
    }
    if (
      url.origin === OPENAI_API_ORIGIN &&
      path === "/v1" &&
      OPENAI_PROVIDER_IDS.has(endpoint.providerId)
    ) {
      return "openai-api";
    }
    if (
      url.origin === ANTHROPIC_API_ORIGIN &&
      path === "/v1" &&
      ANTHROPIC_PROVIDER_IDS.has(endpoint.providerId)
    ) {
      return "anthropic-api";
    }
    return "unimplemented";
  } catch {
    return "unimplemented";
  }
}

export function isDirectProviderCatalogAdapterId(adapterId: string): boolean {
  return (
    adapterId === OPENAI_API_CATALOG_ADAPTER.id || adapterId === ANTHROPIC_API_CATALOG_ADAPTER.id
  );
}
