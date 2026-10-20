// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MINIMUM_NODE_VERSION,
  commandRequiresGit,
  displayVersion,
  launch,
  missingGitPrerequisite,
  runtimeCompatibilityIssue,
} from "../src/launcher.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const originalArgv = process.argv;

describe("packaged CLI launcher", () => {
  it("keeps the executable runtime check aligned with package metadata", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      engines: { node: string };
      os: string[];
    };
    expect(packageJson.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
    expect(packageJson.os).toEqual(["darwin", "linux"]);
    expect(runtimeCompatibilityIssue(MINIMUM_NODE_VERSION, "linux")).toBeUndefined();
  });

  it("accepts the newest Node 24 patch and later lines, and refuses everything older", () => {
    // Expected values come from the Node.js release index, not the launcher:
    // 24.21.0 is the newest 24.x release and 24.20.0 the one before it.
    expect(MINIMUM_NODE_VERSION).toBe("24.21.0");
    expect(runtimeCompatibilityIssue("24.21.0", "linux")).toBeUndefined();
    expect(runtimeCompatibilityIssue("24.21.1", "darwin")).toBeUndefined();
    expect(runtimeCompatibilityIssue("26.0.0", "darwin")).toBeUndefined();
    for (const older of ["24.20.0", "24.20.99", "23.11.0", "22.23.2", "22.21.0"]) {
      expect(runtimeCompatibilityIssue(older, "linux")).toBe(
        `DocsFab requires Node.js >=24.21.0; found ${older}. Install a supported Node.js release and retry.`,
      );
    }
  });

  it("returns one actionable error for unsupported Node and operating systems", () => {
    expect(runtimeCompatibilityIssue("not-semver", "linux")).toBe(
      "DocsFab requires Node.js >=24.21.0; found not-semver. Install a supported Node.js release and retry.",
    );
    expect(runtimeCompatibilityIssue("25.0.0", "win32")).toBe(
      "DocsFab supports macOS and Linux; this machine reports win32. Use a supported machine and retry.",
    );
  });

  it("checks git only for shipped commands that use it", () => {
    for (const args of [
      ["run", "readiness"],
      ["init"],
      ["publish", "run-id"],
      ["profile", "approve"],
      ["profile", "rollback"],
    ]) {
      expect(commandRequiresGit(args)).toBe(true);
    }
    for (const args of [
      [],
      ["help"],
      ["list"],
      ["test"],
      ["doctor"],
      ["profile", "inspect"],
      ["evaluate"],
    ]) {
      expect(commandRequiresGit(args)).toBe(false);
    }
    expect(missingGitPrerequisite(() => false)).toBe(
      "This DocsFab command requires git. Install git, ensure it is on PATH, and retry.",
    );
    expect(missingGitPrerequisite(() => true)).toBeUndefined();
  });
});

describe("packaged CLI launcher runtime dispatch", () => {
  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("dispatches a no-argument packaged start without loading the unrelated full CLI", async () => {
    const lines: string[] = [];
    process.argv = [originalArgv[0]!, originalArgv[1]!];
    vi.doMock("../src/cli.js", () => {
      throw new Error("unrelated full CLI initialization failed");
    });
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });

    try {
      await expect(launch([])).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("../src/cli.js");
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("'docsfab' 'setup'");
    expect(lines[0]).toContain("Reason: Bootstrap the host policy profile and configuration root");
    expect(lines[0]).not.toMatch(/\[1\/5\]|Repository discovery|guided-demo|\/skill:/u);
  });

  it("prints the unstamped build identity for the exact --version invocation and exits zero", async () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      version: string;
    };
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });
    await expect(launch(["--version"])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([`${packageJson.version}+unknown`]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("formats verified releases, development builds, dirty builds, and published prereleases", () => {
    const commit = "a".repeat(40);
    expect(displayVersion("0.0.1", { commit, dirty: false, releaseTag: "v0.0.1-rc.7" })).toBe(
      "0.0.1-rc.7",
    );
    expect(displayVersion("0.0.1", { commit, dirty: false, releaseTag: "v0.0.1" })).toBe("0.0.1");
    expect(displayVersion("0.0.1", { commit, dirty: false, releaseTag: null })).toBe(
      `0.0.1-dev+${commit}`,
    );
    expect(displayVersion("0.0.1", { commit, dirty: true, releaseTag: "v0.0.1-rc.7" })).toBe(
      `0.0.1-dev+${commit}.dirty`,
    );
    expect(
      displayVersion("0.0.1-main.abcdef", { commit, dirty: false, releaseTag: "v0.0.1-rc.7" }),
    ).toBe("0.0.1-main.abcdef");
    expect(displayVersion("0.0.1", { commit: null, dirty: null })).toBe("0.0.1+unknown");
    expect(displayVersion("0.0.1", { commit: null, dirty: false, releaseTag: "v0.0.1" })).toBe(
      "0.0.1+unknown",
    );
    expect(displayVersion("0.0.1", { commit, dirty: null, releaseTag: "v0.0.1" })).toBe(
      `0.0.1-dev+${commit}`,
    );
  });
});

// Local budgets in ms for one tsx-compiled launcher child. In CI each case
// gets at least test.ciTimeoutMs from config/limits.yaml, and the child keeps
// its local share of that budget so it is stopped before the case times out.
const localLauncherCaseMs = 20_000;
const localLauncherProcessMs = 15_000;

describe("packaged CLI launcher Node floor at the shipped entry", {
  timeout: testTimeoutMs(localLauncherCaseMs),
}, () => {
  // The direct-run branch of src/launcher.ts is the entry the compiled
  // bin/docsfab.mjs reaches. A preload pins process.versions.node before the
  // launcher reads it, so the real floor check runs against a chosen version.
  function runLauncherAs(nodeVersion: string, args: readonly string[] = ["--version"]) {
    const preload = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:${JSON.stringify(nodeVersion)}});`;
    return spawnSync(
      process.execPath,
      ["--import", preload, "--import", "tsx", "src/launcher.ts", ...args],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: nestedDeadlineMs(localLauncherProcessMs, localLauncherCaseMs),
      },
    );
  }

  it.each([
    ["--version", ["--version"]],
    ["the no-argument start", []],
  ])("refuses the previous Node 24 release before running %s", (_, args) => {
    const result = runLauncherAs("24.20.0", args);
    expect(result.stderr).toContain(
      "DocsFab requires Node.js >=24.21.0; found 24.20.0. Install a supported Node.js release and retry.",
    );
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("runs the command on the floor release itself", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      version: string;
    };
    const result = runLauncherAs("24.21.0");
    expect(result.stderr).not.toContain("DocsFab requires Node.js");
    expect(result.stdout.trim()).toBe(`${packageJson.version}+unknown`);
    expect(result.status).toBe(0);
  });
});
