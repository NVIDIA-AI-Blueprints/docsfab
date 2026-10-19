// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCompositionCliArguments } from "../src/native-compositions/cli.js";
import {
  createHostProxyRoleResult,
  handlePilotCampaignCommand,
  loadNemotronPilotArtifacts,
  parsePilotCampaignCliArguments,
} from "../src/native-compositions/pilot-cli.js";

import { NATIVE_PILOT_EVALUATION_ROLES } from "../src/native-compositions/pilot-runner.js";

afterEach(async () => {
  vi.restoreAllMocks();
});
import {
  campaignArguments,
  cliFixture,
  fakeCampaignDependencies,
  blindPacket,
  privateDirectory,
  expectCode,
} from "./native-pilot-cli.scenarios.js";

vi.mock("../src/config/private-content-paths.js", () => ({
  PRIVATE_CONTENT_PATHS: Object.freeze({}),
}));

describe("native pilot campaign CLI", () => {
  it("parses the exact acknowledged campaign surface and rejects authority expansion", () => {
    const args = campaignArguments("/private/tmp/docsfab-pilot-campaign");
    expect(parsePilotCampaignCliArguments(args)).toMatchObject({
      command: "pilot-campaign",
      corpusId: "routing-task-guide-v1",
      forbiddenRoots: ["/private/tmp/docsfab-source", "/private/tmp/docsfab-target"],
      acknowledged: true,
      json: true,
    });
    expect(parseCompositionCliArguments(["pilot-campaign", ...args])).toMatchObject({
      command: "pilot-campaign",
    });
    const withoutDocument = args.filter(
      (argument) =>
        argument !== "--nemotron-document" && argument !== "/private/tmp/docsfab-nemotron-guide.md",
    );
    expect(parsePilotCampaignCliArguments(withoutDocument).nemotronDocumentPath).toBeNull();
    const recordOnly = withoutDocument.filter(
      (argument) =>
        argument !== "--nemotron-patch" && argument !== "/private/tmp/docsfab-nemotron.patch",
    );
    expect(parsePilotCampaignCliArguments(recordOnly)).toMatchObject({
      nemotronPatchPath: null,
      nemotronDocumentPath: null,
    });

    expectCode(
      () =>
        parsePilotCampaignCliArguments(
          args.filter((argument) => argument !== "--acknowledge-development-only-uncontained"),
        ),
      "acknowledgement-required",
    );
    expectCode(
      () => parsePilotCampaignCliArguments([...args, "--allow-write"]),
      "invalid-arguments",
    );
    expectCode(
      () =>
        parsePilotCampaignCliArguments(
          args.map((argument) =>
            argument === "/private/tmp/docsfab-pilot-campaign" ? "relative/campaign" : argument,
          ),
        ),
      "invalid-arguments",
    );
  });

  it("creates five distinct honest host-proxy artifacts from blinded deterministic bytes", () => {
    const executions = new Set<string>();
    for (const role of NATIVE_PILOT_EVALUATION_ROLES) {
      const result = JSON.parse(createHostProxyRoleResult(blindPacket(role)).toString("utf8")) as {
        role: string;
        evidenceClass: string;
        evaluatorExecutionIdentitySha256: string;
        payload: Record<string, unknown>;
      };
      expect(result.role).toBe(role);
      expect(result.evidenceClass).toBe("unattested-agent-proxy");
      expect(result.evaluatorExecutionIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(result)).not.toContain("compositionId");
      expect(JSON.stringify(result)).not.toContain("gpt-5.6-sol");
      executions.add(result.evaluatorExecutionIdentitySha256);
      if (role === "layered") {
        expect(result.payload).toMatchObject({
          overallDecision: "insufficient-evidence",
          trustworthyInformation: "pass",
          transferableUnderstanding: "agent-evidence-pass",
          effectiveExperience: "agent-evidence-pass",
          outcomesStatus: "insufficient-evidence",
        });
      }
      if (role === "quality") {
        expect(result.payload).toMatchObject({
          decision: "fail",
          taskGuideScore: 95,
          hardGateFailures: 0,
          deterministicChecks: expect.arrayContaining([{ id: "ROUTE-L2-003", passed: false }]),
        });
      }
    }
    expect(executions.size).toBe(5);
  });

  it("requires all three explicit executable settings before constructing the runner", async () => {
    const fixture = await cliFixture();
    const fake = fakeCampaignDependencies(fixture);
    const createRunner = vi.fn(fake.dependencies.createRunner);
    await expect(
      handlePilotCampaignCommand(
        parsePilotCampaignCliArguments(
          campaignArguments(fixture.campaignRoot, fixture.forbiddenRoots),
        ),
        {
          ...fake.dependencies,
          createRunner,
          environment: { ...fake.environment, DOCSFAB_PYTHON_EXECUTABLE: undefined },
        },
      ),
    ).rejects.toMatchObject({ code: "environment-invalid" });
    expect(createRunner).not.toHaveBeenCalled();
  });

  it("rejects malformed or group-readable Nemotron records content-free", async () => {
    const root = await privateDirectory("docsfab-pilot-artifact-");
    const record = join(root, "record.json");
    const patch = join(root, "candidate.patch");
    const document = join(root, "guide.md");
    await Promise.all([
      writeFile(record, "{}\n", { mode: 0o600 }),
      writeFile(patch, "diff --git a/a b/a\n", { mode: 0o600 }),
      writeFile(document, "# Guide\n", { mode: 0o600 }),
    ]);
    await expect(
      loadNemotronPilotArtifacts({ recordPath: record, patchPath: patch, documentPath: document }),
    ).rejects.toMatchObject({ code: "artifact-invalid" });

    await chmod(record, 0o640);
    let error: unknown;
    try {
      await loadNemotronPilotArtifacts({
        recordPath: record,
        patchPath: patch,
        documentPath: document,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "artifact-invalid" });
    expect(String(error)).not.toContain(root);
  });
  it("refuses an unavailable internal corpus before constructing a runner or writing campaign results", async () => {
    const fixture = await cliFixture();
    const fake = fakeCampaignDependencies(fixture);
    const createRunner = vi.fn(fake.dependencies.createRunner);
    await expect(
      handlePilotCampaignCommand(
        parsePilotCampaignCliArguments(
          campaignArguments(fixture.campaignRoot, fixture.forbiddenRoots),
        ),
        { ...fake.dependencies, loadCorpus: undefined, createRunner },
      ),
    ).rejects.toThrow("internal-content-unavailable: modelComparisonInstalled");
    expect(createRunner).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
    await expect(stat(join(fixture.campaignRoot, "report.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
