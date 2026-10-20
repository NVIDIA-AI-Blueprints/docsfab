// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline catalog-scorecard harness smoke.
 *
 * Proves the checked-in helper writes a machine-readable stub scorecard for
 * the runnable catalog workflows plus auto dry-run, multi-unit dry-run, and
 * `docsfab do --route-only`, with evidence outside the source checkout and
 * no live inference.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { temporaryRoots } from "./helpers/temp.js";

const execFileAsync = promisify(execFile);
const roots = temporaryRoots();
const projectRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = "scripts/catalog-scorecard.mjs";

const REQUIRED_IDS = [
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
  "auto-dry-run",
  "multi-unit-campaign-dry-run",
  "do-route-only",
] as const;

async function runHarness(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      cwd: projectRoot,
      env: {
        ...env,
        PI_OFFLINE: "1",
        CI: "1",
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

describe("canonical catalog scorecard harness (#285)", () => {
  it("writes an offline fixture scorecard outside the checkout without live inference", async () => {
    const evidence = await realpath(
      await mkdtemp(join(tmpdir(), "docsfab-catalog-scorecard-test-")),
    );
    roots.track(evidence);

    const result = await runHarness(["--evidence-dir", evidence]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("docsfab-catalog-scorecard");
    expect(result.stdout).toContain("mode=offline-fixture");
    expect(result.stdout).toContain("liveModel=false");
    expect(evidence.startsWith(projectRoot)).toBe(false);

    const raw = await readFile(join(evidence, "scorecard.json"), "utf8");
    const markdown = await readFile(join(evidence, "scorecard.md"), "utf8");
    expect(raw).not.toMatch(/(?:\/Users\/|\/home\/|glpat-|sk-)/u);
    expect(markdown).not.toMatch(/(?:\/Users\/|\/home\/|glpat-|sk-)/u);

    const scorecard = JSON.parse(raw) as {
      kind: string;
      mode: string;
      liveModel: boolean;
      ciRequired: boolean;
      targetRevision: string;
      entries: Array<{
        id: string;
        surface: string;
        role: string;
        command: string;
        status: string;
        disposition: string;
      }>;
    };
    expect(scorecard.kind).toBe("docsfab-catalog-scorecard");
    expect(scorecard.mode).toBe("offline-fixture");
    expect(scorecard.liveModel).toBe(false);
    expect(scorecard.ciRequired).toBe(false);
    expect(scorecard.targetRevision).toMatch(/^[0-9a-f]{40}$/iu);
    expect(scorecard.entries.map((entry) => entry.id)).toEqual([...REQUIRED_IDS]);
    expect(scorecard.entries).toHaveLength(REQUIRED_IDS.length);
    expect(scorecard.entries.filter((entry) => entry.surface === "catalog-workflow")).toHaveLength(
      4,
    );
    expect(
      scorecard.entries
        .filter((entry) => entry.surface === "operator-mode")
        .map((entry) => entry.id),
    ).toEqual(["auto-dry-run", "multi-unit-campaign-dry-run", "do-route-only"]);
    for (const entry of scorecard.entries) {
      expect(entry.status).toBe("stub");
      expect(entry.disposition).toBe("offline-fixture");
      expect(entry.command.startsWith("docsfab ")).toBe(true);
    }
  });

  it("refuses evidence inside the source checkout and live mode without the env gate", async () => {
    const inside = join(projectRoot, "docs", "prove-a-doc-change");
    const insideResult = await runHarness(["--evidence-dir", inside]);
    expect(insideResult.exitCode).not.toBe(0);
    expect(`${insideResult.stdout}\n${insideResult.stderr}`).toMatch(
      /outside the source checkout/u,
    );

    const live = await runHarness(["--live", "--repo", projectRoot]);
    expect(live.exitCode).not.toBe(0);
    expect(`${live.stdout}\n${live.stderr}`).toMatch(/DOCSFAB_CATALOG_SCORECARD_LIVE=1/u);
    expect(`${live.stdout}\n${live.stderr}`).toMatch(/not CI/u);
  });

  it("keeps the helper offline-first and free of credential material", async () => {
    const [script, docs, pkg] = await Promise.all([
      readFile(join(projectRoot, SCRIPT), "utf8"),
      readFile(join(projectRoot, "docs/prove-a-doc-change/catalog-scorecard.md"), "utf8"),
      readFile(join(projectRoot, "package.json"), "utf8"),
    ]);
    expect(script).toContain("PI_OFFLINE");
    expect(script).toContain("offline-fixture");
    expect(script).toContain("DOCSFAB_CATALOG_SCORECARD_LIVE");
    expect(script).not.toMatch(/glpat-[A-Za-z0-9_-]{10,}/u);
    expect(script).not.toMatch(/\bsk-[A-Za-z0-9]{10,}\b/u);
    expect(docs).toContain("node scripts/catalog-scorecard.mjs");
    expect(docs).toContain("not CI");
    expect(docs).toContain("PI_OFFLINE=1");
    const scripts = (JSON.parse(pkg) as { scripts: Record<string, string> }).scripts;
    expect(scripts["dogfood:catalog-scorecard"]).toBeUndefined();
  });
});
