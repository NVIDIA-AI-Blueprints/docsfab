// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isRunRevisionPublishableFromMergeBase } from "../src/delivery/revision-freshness.js";

describe("isRunRevisionPublishableFromMergeBase", () => {
  const run = "a".repeat(40);
  const target = "b".repeat(40);

  it("accepts equal revisions", () => {
    expect(isRunRevisionPublishableFromMergeBase(run, run)).toBe(true);
    expect(isRunRevisionPublishableFromMergeBase(run, run.toUpperCase())).toBe(true);
  });

  it("accepts ff drift when merge-base equals the run base", () => {
    expect(isRunRevisionPublishableFromMergeBase(run, run)).toBe(true);
  });

  it("rejects diverged histories", () => {
    expect(isRunRevisionPublishableFromMergeBase(run, target)).toBe(false);
    expect(isRunRevisionPublishableFromMergeBase(run, "c".repeat(40))).toBe(false);
  });
});
