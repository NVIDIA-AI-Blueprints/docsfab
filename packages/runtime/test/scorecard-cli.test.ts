// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, stat, symlink } from "node:fs/promises";

import { isAbsolute, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseScorecardCliOptions, publishScorecardArtifacts } from "../src/scorecard-cli.js";

import { isContractErrorLike, toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";

import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

async function errorFrom(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail.");
}

describe("MVP scorecard CLI", () => {
  it("parses required paths and the explicit write authorization", () => {
    const parsed = parseScorecardCliOptions([
      "--state-dir",
      "records",
      "--acceptance-dir",
      "acceptance",
      "--campaign-dir",
      "campaign",
      "--allow-write",
    ]);

    expect(isAbsolute(parsed.stateDirectory)).toBe(true);
    expect(isAbsolute(parsed.acceptanceDirectory)).toBe(true);
    expect(isAbsolute(parsed.campaignDirectory)).toBe(true);
    expect(parsed.allowWrite).toBe(true);
  });

  it.each([
    [[], "missing-option"],
    [["--unknown"], "unknown-option"],
    [
      [
        "--state-dir",
        "one",
        "--state-dir",
        "two",
        "--acceptance-dir",
        "acceptance",
        "--campaign-dir",
        "campaign",
      ],
      "invalid-option",
    ],
    [
      [
        "--state-dir",
        "records",
        "--acceptance-dir",
        "acceptance",
        "--campaign-dir",
        "campaign",
        "--allow-write",
        "--allow-write",
      ],
      "duplicate-option",
    ],
  ] as const)("rejects invalid option input with %s", (args, code) => {
    expect(() => parseScorecardCliOptions([...args])).toThrow(code);
  });

  it("round-trips ScorecardCliError kebab .code through the envelope", () => {
    try {
      parseScorecardCliOptions(["--unknown"]);
      throw new Error("expected ScorecardCliError");
    } catch (error) {
      expect(error).toMatchObject({ name: "ScorecardCliError", code: "unknown-option" });
      expect(isContractErrorLike(error)).toBe(true);
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("unknown-option");
      expect(envelope.code).not.toBe("operator-error");
      expect(envelope.kind).toBe("docsfab-operator-error");
    }
  });

  it("publishes owner-reviewed modes exclusively and never overwrites", async () => {
    const parent = await roots.create("docsfab-scorecard-publish-test-");
    const evidenceRoot = join(parent, "evidence");
    const target = join(evidenceRoot, "mvp-stabilization-test");
    await mkdir(evidenceRoot, { mode: 0o755 });

    await publishScorecardArtifacts(target, '{"safe":true}\n', "# Safe\n", {
      evidenceRoot,
    });

    expect((await stat(target)).mode & 0o777).toBe(0o755);
    expect((await stat(join(target, "scorecard.json"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(target, "scorecard.md"))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(target, "scorecard.json"), "utf8")).toBe('{"safe":true}\n');
    const error = await errorFrom(() =>
      publishScorecardArtifacts(target, "replacement", "replacement", { evidenceRoot }),
    );
    expect(String(error)).toContain("publication");
    expect(await readFile(join(target, "scorecard.json"), "utf8")).toBe('{"safe":true}\n');
  });

  it("rolls back a partial publication without echoing failure content", async () => {
    const parent = await roots.create("docsfab-scorecard-rollback-test-");
    const evidenceRoot = join(parent, "evidence");
    const target = join(evidenceRoot, "mvp-stabilization-test");
    await mkdir(evidenceRoot, { mode: 0o755 });

    const error = await errorFrom(() =>
      publishScorecardArtifacts(target, "safe", "safe", {
        evidenceRoot,
        afterFile: () => {
          throw new Error("PRIVATE_PUBLICATION_SENTINEL");
        },
      }),
    );

    expect(String(error)).toBe("ScorecardCliError: MVP scorecard command failed (publication).");
    expect(String(error)).not.toContain("PRIVATE_PUBLICATION_SENTINEL");
    await expect(stat(target)).rejects.toThrow();
  });

  it("rejects symlinked and out-of-bound publication roots without host paths", async () => {
    const parent = await roots.create("docsfab-scorecard-boundary-test-");
    const realRoot = join(parent, "real-evidence");
    const linkedRoot = join(parent, "linked-evidence");
    await mkdir(realRoot, { mode: 0o755 });
    await symlink(realRoot, linkedRoot);
    const outside = join(parent, "outside");

    for (const operation of [
      () =>
        publishScorecardArtifacts(join(linkedRoot, "result"), "safe", "safe", {
          evidenceRoot: linkedRoot,
        }),
      () =>
        publishScorecardArtifacts(outside, "safe", "safe", {
          evidenceRoot: realRoot,
        }),
    ]) {
      const error = await errorFrom(operation);
      expect(String(error)).toContain("output-boundary");
      expect(String(error)).not.toContain(parent);
    }
  });

  it("rejects a publication-root swap before creating output", async () => {
    const parent = await roots.create("docsfab-scorecard-swap-test-");
    const evidenceRoot = join(parent, "evidence");
    const movedRoot = join(parent, "moved-evidence");
    const target = join(evidenceRoot, "mvp-stabilization-test");
    await mkdir(evidenceRoot, { mode: 0o755 });

    const error = await errorFrom(() =>
      publishScorecardArtifacts(target, "safe", "safe", {
        evidenceRoot,
        beforeTargetCreate: async () => {
          await rename(evidenceRoot, movedRoot);
          await mkdir(evidenceRoot, { mode: 0o755 });
        },
      }),
    );

    expect(String(error)).toContain("output-boundary");
    expect(String(error)).not.toContain(parent);
    await expect(stat(target)).rejects.toThrow();
    await expect(stat(join(movedRoot, "mvp-stabilization-test"))).rejects.toThrow();
  });

  it("sanitizes a missing publication root filesystem error", async () => {
    const parent = await roots.create("docsfab-scorecard-missing-root-test-");
    const missingRoot = join(parent, "PRIVATE_MISSING_ROOT_SENTINEL");
    const error = await errorFrom(() =>
      publishScorecardArtifacts(join(missingRoot, "result"), "safe", "safe", {
        evidenceRoot: missingRoot,
      }),
    );

    expect(String(error)).toContain("output-boundary");
    expect(String(error)).not.toContain(parent);
    expect(String(error)).not.toContain("PRIVATE_MISSING_ROOT_SENTINEL");
  });
});
