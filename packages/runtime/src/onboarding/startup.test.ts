// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { usage } from "../cli/usage.js";
import {
  BARE_ARGV_NEXT_COMMAND,
  BARE_ARGV_NEXT_REASON,
  renderStartupOnboarding,
} from "./startup.js";

const PLAIN = { tty: false, noColor: true, ci: true } as const;

describe("bare-argv startup NEXT", () => {
  it("prints exactly one usage.ts argv instead of a fake 5-step wizard", () => {
    const output = renderStartupOnboarding(PLAIN);
    expect(usage()).toContain(BARE_ARGV_NEXT_COMMAND);
    expect(output).toContain("Configure DocsFab: 'docsfab' 'setup'");
    expect(output).toContain(`Reason: ${BARE_ARGV_NEXT_REASON}`);
    expect(output).toContain("blocked");
    expect(output).not.toMatch(/\[1\/5\]|Repository discovery|guided-demo|\/skill:/u);
    expect(output).not.toContain("Hi! I'm DocsFab");
    expect(output).not.toContain("sample — start with the bundled DocsFab sample");
  });
});
