// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { renderCliPresentation } from "../src/cli/presentation.js";
import {
  NATIVE_PREFLIGHT_ADAPTER_VERSION,
  NATIVE_PREFLIGHT_OBSERVATION_KIND,
  type NativePreflightObservationV1,
} from "../src/native-compositions/contracts.js";
import { projectCompositionPreflight } from "../src/native-compositions/presentation.js";

const observation = {
  schemaVersion: 1,
  kind: NATIVE_PREFLIGHT_OBSERVATION_KIND,
  adapterVersion: NATIVE_PREFLIGHT_ADAPTER_VERSION,
  adapterId: "codex-preflight",
  harnessId: "codex",
  routeId: "codex-chatgpt-managed",
  executionClass: "preflight-only",
  capabilities: { modelEgress: "unavailable", workflowExecution: "unavailable" },
  requestedModel: "gpt-6-sol",
  observedModel: null,
  executable: {
    basename: "codex",
    pathSha256: "a".repeat(64),
    sha256: "b".repeat(64),
    identitySha256: "c".repeat(64),
    reportedVersion: "codex-cli 0.155.1",
  },
  environment: { variableNames: ["HOME"], policySha256: "d".repeat(64) },
  authentication: {
    status: "ready",
    mechanism: "chatgpt",
    providerClass: "openai-first-party",
    subscriptionClass: "enterprise",
    projectionSha256: null,
  },
  catalog: { source: "codex-account", availability: "available", projectionSha256: null },
  processes: [],
  terminalCode: "preflight-ready",
  reasonCodes: [],
  preflightSha256: "e".repeat(64),
} satisfies NativePreflightObservationV1;

describe("native composition preflight presentation", () => {
  it("labels the requested model as a model", () => {
    const output = renderCliPresentation(projectCompositionPreflight(observation)).stdout;

    expect(output).toContain("Requested model");
    expect(output).toContain("gpt-6-sol");
    expect(output).not.toContain("Composition: gpt-6-sol");
  });
});
