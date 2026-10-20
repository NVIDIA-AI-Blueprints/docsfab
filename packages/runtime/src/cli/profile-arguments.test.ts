// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ProfileSeedChoiceRequiredError } from "../model/profile-apply/seed-choice.js";
import { parseProfileSeedArguments } from "./profile-arguments.js";
import { usage } from "./usage.js";

describe("profile seed arguments", () => {
  it("accepts a named preset with or without json", () => {
    expect(parseProfileSeedArguments(["--preset", "future-id"])).toEqual({
      preset: "future-id",
      json: false,
    });
    expect(parseProfileSeedArguments(["--preset", "future-id", "--json"])).toEqual({
      preset: "future-id",
      json: true,
    });
  });

  it("refuses an omitted preset with the named choice refusal", () => {
    for (const args of [[], ["--json"]]) {
      expect(() => parseProfileSeedArguments(args)).toThrow(ProfileSeedChoiceRequiredError);
      expect(() => parseProfileSeedArguments(args)).toThrow(
        "DocsFab profile seed has no default model. Name the model profile to write with --preset.",
      );
    }
    // An empty value is a malformed option, not a missing choice.
    expect(() => parseProfileSeedArguments(["--preset", " "])).toThrow(
      "profile seed requires a non-empty --preset identifier value.",
    );
  });

  it("refuses argv credential flags and unknown options", () => {
    expect(() => parseProfileSeedArguments(["--api-key", "sk-secret"])).toThrow(
      "Unknown profile command option.",
    );
    expect(() => parseProfileSeedArguments(["--json", "--json"])).toThrow("must not be duplicated");
    expect(() => parseProfileSeedArguments(["--preset"])).toThrow("--preset requires a value");
  });

  it("names the unsigned seed command in usage", () => {
    expect(usage()).toContain("docsfab profile seed --preset <id> [--json]");
  });
});
