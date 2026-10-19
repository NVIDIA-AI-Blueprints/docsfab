// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { handleReportsCommand, parseReportsArguments } from "../src/cli/commands/reports.js";

describe("docsfab reports serve", () => {
  it("defaults to loopback 8787 and the operator state directory", () => {
    const parsed = parseReportsArguments(["serve"]);
    expect(parsed.bind).toBe("127.0.0.1");
    expect(parsed.port).toBe(8787);
    expect(parsed.stateDirectory.length).toBeGreaterThan(0);
  });

  it("accepts bind, port, and an absolute state directory", () => {
    expect(
      parseReportsArguments([
        "serve",
        "--bind",
        "0.0.0.0",
        "--port",
        "9090",
        "--state-dir",
        "/tmp",
      ]),
    ).toMatchObject({
      bind: "0.0.0.0",
      port: 9090,
      stateDirectory: "/tmp",
    });
  });

  it("rejects unknown options, positional arguments, and unsafe binds", () => {
    expect(() => parseReportsArguments(["list"])).toThrow(/supports only the serve subcommand/u);
    expect(() => parseReportsArguments(["serve", "--bind", "example.com"])).toThrow(/--bind/u);
    expect(() => parseReportsArguments(["serve", "extra"])).toThrow(/positional/u);
    expect(() => parseReportsArguments(["serve", "--mystery"])).toThrow(/Unknown/u);
  });

  it("prints the listen origin and injects listen for tests", async () => {
    const seen: unknown[] = [];
    const logs: string[] = [];
    await handleReportsCommand(["serve", "--port", "9191"], {
      listen: async (options) => {
        seen.push(options);
      },
      log: (message) => logs.push(message),
    });
    expect(logs[0]).toContain("http://127.0.0.1:9191/reports/");
    expect(seen).toEqual([{ bind: "127.0.0.1", port: 9191, stateDirectory: expect.any(String) }]);
  });
});
