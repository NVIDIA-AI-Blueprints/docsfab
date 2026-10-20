// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { inspectInferenceHubMetadata } from "../src/model/inference-hub-metadata.js";
import {
  assertCredentialFree,
  liveFailure,
  resolveMetadataLiveConfiguration,
} from "./live-catalog-guards.js";

const liveConfiguration = resolveMetadataLiveConfiguration(process.env);

describe("Inference Hub Metadata API live guard", () => {
  it("cleanly declines missing and invalid complete metadata configuration", () => {
    expect(
      resolveMetadataLiveConfiguration({
        DOCSFAB_RUN_INFERENCE_HUB_METADATA_LIVE: "1",
        INFERENCE_HUB_METADATA_API_KEY: `ihub_api_${"A".repeat(24)}`,
        INFERENCE_HUB_METADATA_ORIGIN: "https://metadata.example.test/path",
        INFERENCE_HUB_METADATA_PATH: "/v1/catalog/search",
        INFERENCE_HUB_METADATA_LABEL: "azure/openai/gpt-5.4",
      }),
    ).toBeNull();
    expect(
      resolveMetadataLiveConfiguration({
        DOCSFAB_RUN_INFERENCE_HUB_METADATA_LIVE: "1",
        INFERENCE_HUB_METADATA_API_KEY: `ihub_api_${"A".repeat(24)}`,
        INFERENCE_HUB_METADATA_ORIGIN: "https://metadata.example.test",
        INFERENCE_HUB_METADATA_PATH: "/v1/../catalog",
        INFERENCE_HUB_METADATA_LABEL: "azure/openai/gpt-5.4",
      }),
    ).toBeNull();
  });
});

describe.skipIf(!liveConfiguration)("Inference Hub Metadata API live smoke", () => {
  it("performs an explicitly opted-in read-only exact-label inspection", async () => {
    const { credential, origin, path, label } = liveConfiguration!;
    try {
      const result = await inspectInferenceHubMetadata({
        requested: true,
        authority: "authenticated",
        purpose: "policy",
        label,
        endpoint: { origin, path, mode: "search" },
        environment: process.env,
      });
      expect(result.status).toBe("observed");
      if (result.status === "observed") {
        expect(result.observation.fields.find((field) => field.field === "modelId")).toMatchObject({
          state: "observed",
          value: label,
        });
        assertCredentialFree(result, credential, "Inference Hub Metadata API");
      }
    } catch (error) {
      assertCredentialFree(error, credential, "Inference Hub Metadata API");
      throw liveFailure("Inference Hub Metadata API");
    }
  });
});
