// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { inspectModelEndpointProfile } from "../src/model/profile-inspection.js";
import { NVIDIA_INFERENCE_CATALOG_ENDPOINT } from "../src/model/nvidia-inference-catalog.js";
import { validModelConfig } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

export const PROFILE_APPROVAL_NOW = new Date("2026-08-04T12:34:56.789Z");

// Test-only signing material derived from a public label; never an operator key.
const PROFILE_APPROVAL_FIXTURE_KEY_SEED = createHash("sha256")
  .update("docsfab:test:profile-approval-fixture:ed25519:v1")
  .digest();
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export async function profileApprovalFixture(
  overrides: Partial<ModelEndpointConfig> = {},
  now = PROFILE_APPROVAL_NOW,
) {
  const endpoint: ModelEndpointConfig = {
    ...structuredClone(validModelConfig),
    providerId: "nvidia",
    baseUrl: HUB_BASE_URL,
    modelId: "openai/gpt-5.4",
    apiKey: `nvapi-${"A".repeat(24)}`,
    ...overrides,
  };
  const responseAt = (url: string, value: unknown): Response => {
    const response = new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const fetch = async (request: string | URL | Request): Promise<Response> => {
    const url = request instanceof Request ? request.url : String(request);
    if (url === NVIDIA_INFERENCE_CATALOG_ENDPOINT) {
      return responseAt(url, {
        object: "list",
        data: [
          {
            id: endpoint.modelId,
            max_input_tokens: 100_000,
            max_output_tokens: 20_000,
          },
        ],
      });
    }
    return responseAt(url, {
      models: [
        {
          label: "azure/openai/gpt-5.4",
          provider_id: "azure",
          status: "active",
          capabilities: {
            reasoning: true,
            chat: true,
            tool_use: true,
            input_modalities: ["text"],
            supports_developer_role: true,
            supports_reasoning_effort: true,
            supports_system_role: true,
          },
          limits: {
            context_length: 128_000,
            max_input_tokens: 96_000,
            max_output_tokens: 32_000,
            limit_semantics: "combined-context",
          },
          pricing: null,
        },
      ],
      next_cursor: null,
    });
  };
  const report = await inspectModelEndpointProfile(endpoint, "policy", {
    catalog: true,
    environment: {
      INFERENCE_HUB_METADATA_ORIGIN: "https://metadata.example.test",
      INFERENCE_HUB_METADATA_PATH: "/v1/catalog/search",
      INFERENCE_HUB_METADATA_MODE: "search",
      MODEL_INFERENCE_HUB_METADATA_LABEL: "azure/openai/gpt-5.4",
      INFERENCE_HUB_METADATA_API_KEY: `ihub_api_${"B".repeat(24)}`,
    },
    fetch: fetch as typeof globalThis.fetch,
    clock: () => now,
  });
  const proposal = report.catalog.reconciliation?.proposal;
  if (!proposal) throw new Error("fixture did not propose");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, PROFILE_APPROVAL_FIXTURE_KEY_SEED]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  return {
    endpoint,
    report,
    proposalSha256: proposal.sha256,
    input: {
      inspection: report,
      purpose: "policy" as const,
      proposalSha256: proposal.sha256,
      effectiveDate: now.toISOString().slice(0, 10),
      reviewAfter: new Date(now.valueOf() + 28 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
      conflictFields: proposal.fields
        .filter((field) => field.state === "conflicting")
        .map((field) => field.field),
      authority: { id: "operator:catalog-review", publicKey },
      privateKey,
      endpoint,
      now,
    },
  };
}
