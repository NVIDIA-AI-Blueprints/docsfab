// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listWorkflows } from "../src/workflow-registry/catalog.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/router.js";
import { loadConfig, loadModelEndpointForInspection } from "../src/config/runtime-loader.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { inferRemediationId, remediationText } from "../src/operator/remediation.js";
import { formatSetupBootstrapResult, runSetupBootstrap } from "../src/setup/bootstrap.js";
import { temporaryRoots } from "./helpers/temp.js";

const originalArgv = process.argv;
const roots = temporaryRoots();

afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("supported first-run command chain", () => {
  it("routes a pristine configuration root to setup instead of profile migration", async () => {
    const root = await roots.create("docsfab-onboarding-pristine-");
    const ambientProfiles = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => /^(?:MODEL|JUDGE)_/u.test(name)),
    );
    const originalConfigRoot = process.env.DOCSFAB_CONFIG_ROOT;
    try {
      for (const name of Object.keys(ambientProfiles)) delete process.env[name];
      process.env.DOCSFAB_CONFIG_ROOT = root;
      let failure: unknown;
      try {
        loadConfig({ DOCSFAB_CONFIG_ROOT: root });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: "migration-required",
        reason: "no-profile",
        origin: "fresh",
      });
      expect(inferRemediationId(failure)).toBe("profile-setup");
      expect(remediationText("profile-setup")).toBe("docsfab setup");
      let inspectionFailure: unknown;
      try {
        loadModelEndpointForInspection("policy");
      } catch (error) {
        inspectionFailure = error;
      }
      expect(inspectionFailure).toMatchObject({ origin: "fresh", reason: "no-profile" });
    } finally {
      if (originalConfigRoot === undefined) delete process.env.DOCSFAB_CONFIG_ROOT;
      else process.env.DOCSFAB_CONFIG_ROOT = originalConfigRoot;
      for (const name of Object.keys(ambientProfiles)) delete process.env[name];
      Object.assign(process.env, ambientProfiles);
    }
  });

  it("preserves profile-seed remediation for an existing legacy dotenv", async () => {
    const root = await roots.create("docsfab-onboarding-legacy-empty-");
    await writeFile(join(root, ".env"), "# legacy configuration\n", "utf8");
    let failure: unknown;
    try {
      loadConfig({ DOCSFAB_CONFIG_ROOT: root });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "migration-required",
      reason: "no-profile",
      origin: "legacy",
    });
    expect(inferRemediationId(failure)).toBe("profile-seed");
  });

  it("routes a fresh split setup with only MODEL_API_KEY missing back to setup", async () => {
    const root = await roots.create("docsfab-onboarding-missing-key-");
    const environment = { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: "" };

    const setup = await runSetupBootstrap({
      profile: "nvidia-inference-gpt-6-sol-pi",
      environment,
    });
    expect(setup).toMatchObject({
      status: "blocked-missing-credential",
      layout: "split",
      seeded: true,
      nextCommand: "docsfab setup",
    });

    let failure: unknown;
    try {
      loadConfig(environment);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "migration-required",
      reason: "missing-primary-credential",
    });
    const remediation = inferRemediationId(failure);
    expect(remediation).toBe("profile-setup");
    expect(remediationText(remediation!)).toBe("docsfab setup");
    const output = formatOperatorErrorEnvelope(toOperatorErrorEnvelope(failure));
    expect([...output.matchAll(/docsfab setup/gu)]).toHaveLength(1);
    expect(output).not.toMatch(/profile inspect|profile approve|schema migration/iu);
  });

  it("loads fresh setup with a non-secret sentinel and preserves it on repeat setup", async () => {
    const root = await roots.create("docsfab-onboarding-ready-");
    const sentinel = "NON_SECRET_ONBOARDING_SENTINEL";
    const environment = { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: sentinel };

    const first = await runSetupBootstrap({
      profile: "nvidia-inference-gpt-6-sol-pi",
      environment,
    });
    expect(first).toMatchObject({
      status: "ready",
      layout: "split",
      seeded: true,
      activeExecutionProfile: "nvidia-inference-gpt-6-sol-pi",
      nextCommand: "docsfab doctor",
    });
    const loaded = loadConfig(environment);
    expect(loaded.model.apiKey).toBe(sentinel);
    expect(formatSetupBootstrapResult(first)).not.toContain(sentinel);
    expect(canonicalizeJsonEvidence(first as unknown as JsonEvidenceValue)).not.toContain(sentinel);
    const before = await Promise.all([
      readFile(first.hostConfigPath!, "utf8"),
      readFile(first.secretsPath!, "utf8"),
    ]);

    const repeated = await runSetupBootstrap({ environment });
    expect(repeated).toMatchObject({
      status: "ready",
      seeded: false,
      activeExecutionProfile: "nvidia-inference-gpt-6-sol-pi",
    });
    const after = await Promise.all([
      readFile(repeated.hostConfigPath!, "utf8"),
      readFile(repeated.secretsPath!, "utf8"),
    ]);
    expect(after).toEqual(before);
    expect(formatSetupBootstrapResult(repeated)).not.toContain(sentinel);
    expect(canonicalizeJsonEvidence(repeated as unknown as JsonEvidenceValue)).not.toContain(
      sentinel,
    );
  });

  it("prints the public catalog with actionable plan commands", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => lines.push(String(value)));
    process.argv = [originalArgv[0]!, originalArgv[1]!, "list"];

    await main();

    expect(lines).toHaveLength(1);
    const output = lines[0]!.split("\n");
    const workflows = listWorkflows();
    expect(output[0]).toBe("Available workflows");
    expect(
      output
        .slice(1, workflows.length + 1)
        .map((line) => line.trimStart().split(/\s+/u)[0]?.replace(/:$/u, "")),
    ).toEqual(workflows.map((workflow) => workflow.name));
    expect(output.slice(workflows.length + 1)).toEqual(
      workflows.map((workflow) => `Plan ${workflow.name}: 'docsfab' 'plan' '${workflow.name}'`),
    );
    expect(output.join("\n")).not.toContain("NEXT ");
  });
});
