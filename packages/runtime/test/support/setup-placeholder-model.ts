// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { projectModelProfileToEnvironment } from "../../src/config/profile-projection.js";
import { parseModelEndpoint, type ModelEndpointConfig } from "../../src/model/configuration.js";
import { buildPolicyProfileFromEndpoint } from "../../src/setup/split-layout-presets.js";

/**
 * The profile `docsfab setup` writes for an endpoint that matches no installed
 * composition, parsed the way a run loads it: the placeholder window
 * `modelProfile.conservativeFallbackContextWindow`, with metadata no one attested.
 */
export function setupPlaceholderModel(): ModelEndpointConfig {
  const profile = buildPolicyProfileFromEndpoint({
    provider: "openai-compatible",
    baseUrl: "https://unmatched.example.test/v1",
    modelId: "operator/unmatched-model",
  });
  const environment: NodeJS.ProcessEnv = {};
  projectModelProfileToEnvironment(profile, environment);
  environment.COMPATIBLE_API_KEY = "test-secret";
  return parseModelEndpoint(environment, "MODEL");
}
