// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  COMPATIBILITY_TOOL_NAME,
  decideVerdict,
  probeCompatibility,
} from "../profile/probe-core.js";
import { parseProfileDraftArguments, parseProfileProbeArguments } from "./profile-arguments.js";
import { usage } from "./usage.js";
import { PREFIX_MATCHER_ERROR, runProfileProbe } from "./profile-probe.js";

const ANSWERED = {
  ok: true,
  status: 200,
  eventStream: true,
  events: 3,
  done: true,
  malformedEvents: 0,
  errorEvent: undefined,
  reasoningPresent: false,
  completionTokens: 20,
} as const;

/** A passing endpoint for the compatibility requests; the HTTP path has its own tests. */
function compatibleEndpoint(): typeof probeCompatibility {
  return async () => ({
    toolCall: {
      ...ANSWERED,
      content: "",
      toolCalls: [{ name: COMPATIBILITY_TOOL_NAME, arguments: '{"result":"ok"}' }],
      finishReason: "tool_calls",
    },
    structuredOutput: {
      ...ANSWERED,
      content: '{"result":"ok","checks":["tool-calls","structured-output"]}',
      toolCalls: [],
      finishReason: "stop",
    },
  });
}

describe("profile probe arguments", () => {
  it("requires route and model and stays offline by default", () => {
    expect(
      parseProfileProbeArguments([
        "--route",
        "nvidia-inference-api",
        "--model",
        "azure/openai/gpt-5.4",
      ]),
    ).toEqual({
      routeId: "nvidia-inference-api",
      modelId: "azure/openai/gpt-5.4",
      live: false,
      json: false,
    });
    expect(
      parseProfileProbeArguments([
        "--route",
        "nvidia-inference-api",
        "--model",
        "azure/openai/gpt-5.4",
        "--live",
        "--json",
      ]),
    ).toMatchObject({ live: true, json: true });
  });

  it("names the live-gated probe command in usage", () => {
    expect(usage()).toContain("docsfab profile probe --route <id> --model <id> [--live] [--json]");
  });
});

describe("profile probe", () => {
  it("rejects gpt-5 prefix matchers with a stable error", async () => {
    await expect(
      runProfileProbe({
        routeId: "nvidia-inference-api",
        modelId: "gpt-5",
        live: false,
        json: false,
      }),
    ).rejects.toThrow(PREFIX_MATCHER_ERROR);
    await expect(
      runProfileProbe({
        routeId: "nvidia-inference-api",
        modelId: "azure/openai/gpt-5",
        live: true,
        json: false,
      }),
    ).rejects.toThrow(PREFIX_MATCHER_ERROR);
  });

  it("rejects o1 prefix matchers with a stable error", async () => {
    await expect(
      runProfileProbe({
        routeId: "openai-api",
        modelId: "o1",
        live: false,
        json: false,
      }),
    ).rejects.toThrow(PREFIX_MATCHER_ERROR);
  });

  it("does not spend on the default offline probe path", async () => {
    const probeOne = vi.fn(async () => {
      throw new Error("offline profile probe must not invoke the live matrix probe.");
    });
    const observation = await runProfileProbe(
      {
        routeId: "nvidia-inference-api",
        modelId: "azure/openai/gpt-5.4",
        live: false,
        json: true,
      },
      { probeOne, environment: { MODEL_API_KEY: "secret-must-not-appear" } },
    );
    expect(probeOne).not.toHaveBeenCalled();
    expect(observation.live).toBe(false);
    expect(observation.verdict).toBe("not-requested");
    expect(observation.locator).toBe("nvidia-inference-api:azure/openai/gpt-5.4");
    expect(JSON.stringify(observation)).not.toContain("secret-must-not-appear");
  });

  it("classifies harness-compatible from populated content", async () => {
    const observation = await runProfileProbe(
      {
        routeId: "nvidia-inference-api",
        modelId: "azure/openai/gpt-5.4",
        live: true,
        json: true,
      },
      {
        environment: { MODEL_API_KEY: "secret-must-not-appear" },
        decideVerdict,
        probeCompatibility: compatibleEndpoint(),
        probeOne: async () => ({
          reachable: true,
          status: 200,
          reasoningSplit: false,
          reasoningPresent: false,
          contentPopulated: true,
        }),
      },
    );
    expect(observation.verdict).toBe("harness-compatible");
    expect(observation.compatibility?.verdict).toBe("compatible");
    expect(observation.live).toBe(true);
    expect(observation.locator).toBe("nvidia-inference-api:azure/openai/gpt-5.4");
    expect(JSON.stringify(observation)).not.toContain("secret-must-not-appear");
  });

  it("classifies reasoning-split-controllable when thinking:false restores content", async () => {
    let compatibilityExtraBody: Record<string, unknown> | undefined;
    const observation = await runProfileProbe(
      {
        routeId: "nvidia-inference-api",
        modelId: "nvidia/nvidia/nemotron-3-ultra",
        live: true,
        json: true,
      },
      {
        environment: { MODEL_API_KEY: "secret-must-not-appear" },
        decideVerdict,
        probeCompatibility: async (model, provider, options) => {
          compatibilityExtraBody = options.extraBody;
          return compatibleEndpoint()(model, provider, options);
        },
        probeOne: async (_model, _provider, extraBody) => {
          if (Object.hasOwn(extraBody, "chat_template_kwargs")) {
            return {
              reachable: true,
              status: 200,
              reasoningSplit: false,
              contentPopulated: true,
            };
          }
          return {
            reachable: true,
            status: 200,
            reasoningSplit: true,
            contentPopulated: false,
          };
        },
      },
    );
    expect(observation.verdict).toBe("reasoning-split-controllable");
    // Compatibility is measured with the control a drafted policy installs.
    expect(compatibilityExtraBody).toEqual({ chat_template_kwargs: { thinking: false } });
  });

  it("classifies unreachable when the route cannot be contacted", async () => {
    const observation = await runProfileProbe(
      {
        routeId: "nvidia-inference-api",
        modelId: "azure/openai/gpt-5.4",
        live: true,
        json: true,
      },
      {
        environment: { MODEL_API_KEY: "secret-must-not-appear" },
        decideVerdict,
        probeCompatibility: async () => {
          throw new Error("an unreachable route must not spend on compatibility requests.");
        },
        probeOne: async () => ({ reachable: false, status: 404 }),
      },
    );
    expect(observation.verdict).toBe("unreachable");
    expect(observation.compatibility?.checks[0]).toMatchObject({
      id: "availability",
      finding: "model-not-found",
      httpStatus: 404,
    });
    expect(JSON.stringify(observation)).not.toContain("secret-must-not-appear");
  });
});

describe("profile draft arguments", () => {
  it("requires route, model, and a closed verdict", () => {
    expect(() => parseProfileDraftArguments(["--route", "nvidia-inference-api"])).toThrow(
      "profile draft requires a non-empty --verdict identifier value.",
    );
    expect(
      parseProfileDraftArguments([
        "--route",
        "nvidia-inference-api",
        "--model",
        "azure/openai/gpt-5.4",
        "--verdict",
        "harness-compatible",
      ]),
    ).toEqual({
      routeId: "nvidia-inference-api",
      modelId: "azure/openai/gpt-5.4",
      verdict: "harness-compatible",
      json: false,
    });
  });

  it("names the draft command in usage", () => {
    expect(usage()).toContain(
      "docsfab profile draft --route <id> --model <id> --verdict <verdict> [--json]",
    );
  });
});
