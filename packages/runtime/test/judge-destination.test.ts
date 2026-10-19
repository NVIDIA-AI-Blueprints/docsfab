// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateAcceptanceGates } from "../src/acceptance.js";
import { validateCampaignJudgeGate } from "../src/campaign-judge.js";
import {
  assertApprovedJudgeDestination,
  normalizeApprovedHttpsUrl,
} from "../src/judge-destination.js";
import { judgeConfig } from "./campaign-judge-fixture.js";
import { validModelEnvironment } from "./helpers.js";

const url = "https://judge.example.test/v1";

describe("approved judge destination", () => {
  it("normalizes trailing slashes and accepts an exact match", () => {
    expect(normalizeApprovedHttpsUrl(`${url}/`)).toEqual({ ok: true, url });
    expect(
      assertApprovedJudgeDestination({
        configured: `${url}/`,
        environment: url,
        approved: `${url}/`,
      }),
    ).toEqual({ ok: true, url });
  });

  it("rejects a mismatched or unsafe destination before either caller maps errors", () => {
    expect(
      assertApprovedJudgeDestination({
        configured: url,
        environment: url,
        approved: "https://other.example.test/v1",
      }),
    ).toEqual({ ok: false, failure: { kind: "mismatch" } });
    expect(
      assertApprovedJudgeDestination({
        configured: url,
        environment: url,
        approved: "https://user:secret@judge.example.test/v1",
      }),
    ).toEqual({
      ok: false,
      failure: { kind: "invalid", field: "approved", code: "embedded-credentials" },
    });
    expect(
      assertApprovedJudgeDestination({
        configured: url,
        environment: undefined,
        approved: url,
      }),
    ).toEqual({ ok: false, failure: { kind: "missing" } });
  });

  it("wires the same normalize-and-match rule into acceptance and campaign gates", () => {
    expect(() =>
      validateAcceptanceGates({
        live: true,
        judge: true,
        approvedModelUrl: validModelEnvironment.MODEL_BASE_URL,
        approvedJudgeUrl: `${url}/`,
        environment: {
          ...validModelEnvironment,
          DOCSFAB_ACCEPTANCE_LIVE: "true",
          DOCSFAB_ACCEPTANCE_JUDGE: "true",
          JUDGE_BASE_URL: url,
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateAcceptanceGates({
        live: true,
        judge: true,
        approvedModelUrl: validModelEnvironment.MODEL_BASE_URL,
        approvedJudgeUrl: "https://other.example.test/v1",
        environment: {
          ...validModelEnvironment,
          DOCSFAB_ACCEPTANCE_LIVE: "true",
          DOCSFAB_ACCEPTANCE_JUDGE: "true",
          JUDGE_BASE_URL: url,
        },
      }),
    ).toThrow("exactly matching JUDGE_BASE_URL");
    expect(
      validateCampaignJudgeGate({
        enabled: true,
        approvedJudgeUrl: `${url}/`,
        environment: {
          DOCSFAB_CAMPAIGN_JUDGE: "true",
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: url,
        },
        judgeConfig,
      }),
    ).toBe(judgeConfig);
    expect(() =>
      validateCampaignJudgeGate({
        enabled: true,
        approvedJudgeUrl: "https://other.example.test/v1",
        environment: {
          DOCSFAB_CAMPAIGN_JUDGE: "true",
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: url,
        },
        judgeConfig,
      }),
    ).toThrow("judge-destination-not-approved");
  });
});
