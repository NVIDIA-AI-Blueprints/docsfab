// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { delimiter } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BARE_ARGV_NEXT_REASON, renderStartupOnboarding } from "../onboarding/startup.js";
import { toOperatorErrorEnvelope } from "../operator/error-envelope.js";
import { egressText } from "../security/egress.js";
import { processHostRootSet, resetStartupPublicRootsForTest } from "../security/host-roots.js";
import { main } from "./router.js";
import { generalHelp, initHelp, runHelp } from "./usage.js";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function setCliArguments(args: readonly string[]): void {
  process.argv = [originalArgv[0]!, originalArgv[1]!, ...args];
}

describe("bare-argv router", () => {
  it("prints the honest NEXT block on first and second no-argument starts", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });
    setCliArguments([]);

    await main();
    await main();

    expect(lines).toEqual([renderStartupOnboarding(), renderStartupOnboarding()]);
    expect(lines[0]).not.toMatch(/\[1\/5\]|Repository discovery/u);
  });

  it("keeps both explicit help routes on CLI usage instead of startup NEXT", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });

    setCliArguments(["--help"]);
    await main();
    setCliArguments(["help"]);
    await main();

    expect(lines).toEqual([generalHelp(), generalHelp()]);
    expect(lines.every((line) => !line.includes(`Reason: ${BARE_ARGV_NEXT_REASON}`))).toBe(true);
  });

  it("routes init and run help to useful command-scoped guidance", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });

    setCliArguments(["init", "--help"]);
    await main();
    setCliArguments(["run", "--help"]);
    await main();

    expect(lines).toEqual([initHelp(), runHelp()]);
    expect(lines[0]).toContain("--approve-plan-sha256 <digest>");
    expect(lines[0]).not.toContain("composition pilot-campaign");
    expect(lines[1]).toContain("--patch-only and --dry-run are separate modes");
    expect(lines[1]).not.toContain("profile approve");
  });

  it("routes path-less ordinary documentation English on do --route-only (#950)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });
    setCliArguments([
      "do",
      "Create a reader-facing health endpoint page for people operating the service...",
      "--route-only",
    ]);

    await main();

    const output = lines.join("\n");
    expect(output).toContain("create-documentation");
    expect(output).not.toContain("live-agent");
    expect(output).not.toContain("No fixed DocsFab workflow");
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("startup public-roots validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetStartupPublicRootsForTest();
  });

  it("stops before any command with a mapped public-roots-invalid stop", async () => {
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", ["/workspace", "/srv/private-root "].join(delimiter));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    setCliArguments(["list"]);

    const failure: unknown = await main().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(log).not.toHaveBeenCalled();
    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope).toMatchObject({
      code: "public-roots-invalid",
      failure: { class: "operator-input" },
    });
    expect(envelope.message).toContain("entry 1");
    expect(envelope.nextAction).toContain("DOCSFAB_PUBLIC_ROOTS");
    expect(JSON.stringify(envelope)).not.toContain("private-root");
  });

  it("keeps the validated declaration for the rest of the process", async () => {
    const home = "/srv/router-roots/home/node";
    vi.stubEnv("HOME", home);
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    setCliArguments(["list"]);
    await main();

    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative");
    expect(egressText(`${home}/x`, processHostRootSet())).toEqual({
      ok: true,
      text: `${home}/x`,
      replaced: [],
    });
  });
});
