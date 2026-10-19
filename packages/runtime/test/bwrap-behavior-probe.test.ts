// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildBwrapArguments } from "../scripts/bwrap-behavior-probe.mjs";

function sequenceIndex(arguments_: string[], sequence: string[]): number {
  return arguments_.findIndex((_, index) =>
    sequence.every((value, offset) => arguments_[index + offset] === value),
  );
}

describe("bwrap behavior probe", () => {
  it("exits successfully with an explicit Linux-only skip on macOS", () => {
    if (process.platform === "linux") return;
    const probePath = fileURLToPath(
      new URL("../scripts/bwrap-behavior-probe.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [probePath], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      bwrap: "skipped",
      reason: "linux-only",
    });
  });

  it("mounts isolated /tmp before the scratch bind so the bind stays reachable", () => {
    const scratch = "/tmp/docsfab-bwrap-probe-test";
    const hostTmpSentinel = "/tmp/docsfab-bwrap-host-tmp-test";
    const arguments_ = buildBwrapArguments(scratch, hostTmpSentinel);

    const isolatedTmpIndex = sequenceIndex(arguments_, ["--tmpfs", "/tmp"]);
    const scratchBindIndex = sequenceIndex(arguments_, ["--bind", scratch, scratch]);

    expect(isolatedTmpIndex).toBeGreaterThanOrEqual(0);
    expect(scratchBindIndex).toBeGreaterThan(isolatedTmpIndex);
  });

  it("passes a host /tmp sentinel to assert that the sandbox has a fresh /tmp", () => {
    const scratch = "/tmp/docsfab-bwrap-probe-test";
    const hostTmpSentinel = "/tmp/docsfab-bwrap-host-tmp-test";
    const arguments_ = buildBwrapArguments(scratch, hostTmpSentinel);
    const separatorIndex = arguments_.indexOf("--");

    expect(arguments_.slice(separatorIndex + 1, separatorIndex + 4)).toEqual([
      process.execPath,
      "-e",
      expect.stringContaining("existsSync(hostTmpSentinel)"),
    ]);
    expect(arguments_.slice(-2)).toEqual([scratch, hostTmpSentinel]);
  });
});
