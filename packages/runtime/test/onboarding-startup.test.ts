// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/router.js";
import { generalHelp, usage } from "../src/cli/usage.js";
import { renderStartupOnboarding } from "../src/onboarding/startup.js";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

function setCliArguments(args: readonly string[]): void {
  process.argv = [originalArgv[0]!, originalArgv[1]!, ...args];
}

describe("runtime-owned startup onboarding", () => {
  it("renders blocked NEXT with one usage.ts argv instead of a fake wizard", () => {
    const output = renderStartupOnboarding({ tty: false, noColor: true, ci: true });

    expect(usage()).toContain("docsfab setup");
    expect(output).toContain("Configure DocsFab: 'docsfab' 'setup'");
    expect(output).toContain("Reason: Bootstrap the host policy profile and configuration root");
    expect(output).toContain("blocked");
    expect(output).toContain("--repo <path>");
    expect(output).not.toContain("repository: <URL or local path>");
    expect(output).not.toMatch(/\[1\/5\]|Repository discovery|guided-demo|\/skill:/u);
  });

  it("repeats the same NEXT on first and second no-argument starts", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });
    setCliArguments([]);

    await main();
    await main();

    expect(lines).toEqual([renderStartupOnboarding(), renderStartupOnboarding()]);
  });

  it("keeps both explicit help routes on CLI usage instead of onboarding", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });

    setCliArguments(["--help"]);
    await main();
    setCliArguments(["help"]);
    await main();

    expect(lines).toEqual([generalHelp(), generalHelp()]);
    expect(lines.every((line) => !line.includes("Reason: Bootstrap the host policy profile"))).toBe(
      true,
    );
  });
});
