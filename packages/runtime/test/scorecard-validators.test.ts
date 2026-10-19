// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createContractKit } from "../src/contract-kit/index.js";
import {
  isScorecardIsoDate,
  isScorecardIsoTimestamp,
  isScorecardSafeId,
  isScorecardSha256,
} from "../src/scorecard-validators.js";

const HASH = "a".repeat(64);
const kit = createContractKit({
  fail: (code) => {
    throw new Error(code);
  },
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  },
});

describe("scorecard validators", () => {
  it("accepts lowercase SHA-256, safe ids, calendar dates, and RFC3339 milliseconds", () => {
    expect(isScorecardSha256(HASH)).toBe(true);
    expect(isScorecardSafeId("campaign-1")).toBe(true);
    expect(isScorecardIsoDate("2026-08-24")).toBe(true);
    expect(isScorecardIsoTimestamp("2026-08-24T12:00:00.000Z")).toBe(true);
  });

  it("rejects uppercase hashes, mixed-case ids, and impossible calendar dates", () => {
    expect(isScorecardSha256("A".repeat(64))).toBe(false);
    expect(isScorecardSafeId("CampaignId")).toBe(false);
    expect(isScorecardIsoDate("2026-02-30")).toBe(false);
    expect(isScorecardIsoTimestamp("2026-08-24T12:00:00.000")).toBe(false);
  });

  it("keeps scorecard ids and calendar dates distinct from kit identifier and timestamp", () => {
    const mixedId = "Campaign:path/id";
    expect(isScorecardSafeId(mixedId)).toBe(false);
    expect(kit.identifier(mixedId)).toBe(mixedId);

    expect(isScorecardIsoDate("2026-08-24")).toBe(true);
    expect(() => kit.timestamp("2026-08-24")).toThrow("invalid-value");

    expect(isScorecardSha256(HASH)).toBe(true);
    expect(kit.hash(HASH)).toBe(HASH);
  });
});
