// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import {
  defaultHostConfig,
  defaultRetryPolicy,
  projectHostConfigToEnvironment,
} from "../src/config/profile-projection.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";

/**
 * One read-only retry default from the limits catalog, whether or not a
 * generated host.yaml is present, with the applied source on the resolved
 * policy the run uses.
 */
describe("read-only retry default unification (#990)", () => {
  it("resolves one catalog value with or without a projected host.yaml, and records the source", () => {
    const catalog = limit("retry.maxRetries", { environment: {}, hostFile: null });
    const withoutHost = parseRetryPolicy({});
    const host = defaultHostConfig("profiles/operating-agent.yaml");
    const projected: NodeJS.ProcessEnv = {};
    projectHostConfigToEnvironment(host, projected);
    const withHost = parseRetryPolicy(projected);

    expect(catalog.source).toBe("config/limits.yaml");
    expect(withoutHost).toMatchObject({ maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 2_000 });
    expect(defaultRetryPolicy().readOnlyMaxRetries).toBe(catalog.value);
    expect(host.retryPolicy?.readOnlyMaxRetries).toBeUndefined();
    expect(withoutHost.maxRetries).toBe(catalog.value);
    expect(withHost.maxRetries).toBe(catalog.value);
    expect(withoutHost.maxRetries).toBe(withHost.maxRetries);
    expect(withoutHost.maxRetriesSource).toBe("config/limits.yaml");
    expect(withHost.maxRetriesSource).toBe("config/limits.yaml");
  });

  it("preserves explicit and historical host overrides separately from the catalog default", () => {
    const catalog = parseRetryPolicy({});
    const overridden = parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_RETRIES: "2" });
    const historicalHost = defaultHostConfig("profiles/operating-agent.yaml");
    const historicalEnvironment: NodeJS.ProcessEnv = {};
    projectHostConfigToEnvironment(
      {
        ...historicalHost,
        retryPolicy: { ...historicalHost.retryPolicy, readOnlyMaxRetries: 1 },
      },
      historicalEnvironment,
    );
    const historical = parseRetryPolicy(historicalEnvironment);
    expect(catalog.maxRetriesSource).toBe("config/limits.yaml");
    expect(overridden.maxRetries).toBe(2);
    expect(overridden.maxRetriesSource).toBe("host");
    expect(overridden.maxRetries).not.toBe(catalog.maxRetries);
    expect(historical.maxRetries).toBe(1);
    expect(historical.maxRetriesSource).toBe("host");
  });

  it("records maxRetriesSource on the reconstructed inference run artefact", async () => {
    const catalog = parseRetryPolicy({});
    const catalogRun = await executeInferenceStep({
      mode: "read-only",
      policy: catalog,
      execute: async () => ({ summary: "ready" }),
    });
    expect(catalogRun.status).toBe("succeeded");
    expect(catalogRun.evidence.maxRetriesSource).toBe("config/limits.yaml");
    expect(catalogRun.evidence.configuredMaxRetries).toBe(catalog.maxRetries);
    expect(catalogRun.evidence).toHaveProperty("maxRetriesSource", "config/limits.yaml");

    const hostPolicy = parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_RETRIES: "2" });
    const hostRun = await executeInferenceStep({
      mode: "read-only",
      policy: hostPolicy,
      execute: async () => ({ summary: "ready" }),
    });
    expect(hostRun.status).toBe("succeeded");
    expect(hostRun.evidence.maxRetriesSource).toBe("host");
    expect(hostRun.evidence.configuredMaxRetries).toBe(2);
  });
});
