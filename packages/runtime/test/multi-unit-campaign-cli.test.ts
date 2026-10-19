// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT,
  MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS,
  MULTI_UNIT_MAX_UNITS,
  createMultiUnitDocImprovementDeclaration,
  createMultiUnitDocImprovementProgress,
  createMultiUnitDocImprovementUnitQueue,
  decodeMultiUnitDocImprovementProgress,
  type MultiUnitDocImprovementDeclarationBodyV1,
} from "../src/autonomy/multi-unit-doc-improvement.js";
import {
  parseMultiUnitCampaignCliArguments,
  runMultiUnitCampaignCli,
} from "../src/autonomy/multi-unit-campaign-cli.js";
import {
  MultiUnitCampaignRunError,
  runMultiUnitCampaignDryRun,
} from "../src/autonomy/multi-unit-campaign-run.js";
import {
  createWorkUnitMachineContract,
  type WorkUnitMachineContractBodyV1,
} from "../src/maturity/work-unit-machine-contract.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const SHA = (value: string) => createHash("sha256").update(value).digest("hex");
const REVISION_PLACEHOLDER = "b".repeat(40);
const GENERATED_AT = "2026-08-12T14:00:00.000Z";
const UPDATED_AT = "2026-08-12T15:00:00.000Z";
const CLOCK = "2026-08-12T16:00:00.000Z";
const roots = temporaryRoots();

function declarationBody(
  overrides: Partial<MultiUnitDocImprovementDeclarationBodyV1> = {},
): MultiUnitDocImprovementDeclarationBodyV1 {
  return {
    campaignId: "campaign-multi-unit-cli-1",
    repositoryId: "tech-docs/docsfab",
    testedCommit: REVISION_PLACEHOLDER,
    repositoryIdentitySha256: SHA("repository-identity"),
    caps: {
      maxUnits: MULTI_UNIT_MAX_UNITS,
      maxAttemptsPerUnit: MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT,
      maxCampaignAttempts: MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS,
    },
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

function machineBody(fingerprint: string): WorkUnitMachineContractBodyV1 {
  return {
    workUnitFingerprint: fingerprint,
    repositoryIdentitySha256: SHA("repository-identity"),
    machineChecks: [
      {
        checkKind: "cli-smoke",
        commandId: "multi-unit-campaign-dry-run",
        expectedOutcomeClass: "pass",
      },
    ],
    acceptanceAuthority: "host-deterministic",
    trackerMutation: "not-authorized",
  };
}

async function createSourceRepository(): Promise<{ path: string; revision: string }> {
  const path = await roots.create("docsfab-multi-unit-src-");
  const revision = await initFixtureRepo(path, { "README.md": "# fixture\n" });
  return { path, revision };
}

async function writePrivateCampaign(
  unitCount: number,
  options: { maxCampaignAttempts?: number; testedCommit?: string } = {},
): Promise<{
  campaignDirectory: string;
  fingerprints: string[];
  declarationDigest: string;
}> {
  const fingerprints = Array.from({ length: unitCount }, (_, index) =>
    SHA(`cli-unit-${index + 1}`),
  );
  const envelopes = fingerprints.map((fingerprint) =>
    createWorkUnitMachineContract(machineBody(fingerprint)),
  );
  const declaration = createMultiUnitDocImprovementDeclaration(
    declarationBody({
      ...(options.testedCommit ? { testedCommit: options.testedCommit } : {}),
      ...(options.maxCampaignAttempts !== undefined
        ? {
            caps: {
              maxUnits: MULTI_UNIT_MAX_UNITS,
              maxAttemptsPerUnit: MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT,
              maxCampaignAttempts: options.maxCampaignAttempts,
            },
          }
        : {}),
    }),
  );
  const unitQueue = createMultiUnitDocImprovementUnitQueue({
    campaignId: declaration.campaignId,
    declarationDigest: declaration.digest,
    units: envelopes.map((envelope) => ({
      workUnitFingerprint: envelope.workUnitFingerprint,
      machineContractSha256: envelope.machineContractSha256,
    })),
  });
  const progress = createMultiUnitDocImprovementProgress({
    campaignId: declaration.campaignId,
    declarationDigest: declaration.digest,
    unitQueueDigest: unitQueue.digest,
    queueIndex: 0,
    unitAttempts: 0,
    campaignAttempts: 0,
    stopReason: null,
    updatedAt: UPDATED_AT,
  });

  const root = await roots.create("docsfab-multi-unit-camp-", { mode: 0o700 });
  const writeLeaf = async (name: string, value: unknown) => {
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  await writeLeaf("declaration.json", declaration);
  await writeLeaf("unit-queue.json", unitQueue);
  await writeLeaf("progress.json", progress);
  const unitsDir = join(root, "units");
  await mkdir(unitsDir, { mode: 0o700 });
  await chmod(unitsDir, 0o700);
  for (const fingerprint of fingerprints) {
    const unitDir = join(unitsDir, fingerprint);
    await mkdir(unitDir, { mode: 0o700 });
    await chmod(unitDir, 0o700);
    const receipt = join(unitDir, "receipt.json");
    await writeFile(receipt, `${JSON.stringify({ ok: true }, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(receipt, 0o600);
  }
  return {
    campaignDirectory: root,
    fingerprints,
    declarationDigest: declaration.digest,
  };
}

describe("multi-unit campaign CLI dry-run (#268 / #257)", () => {
  it("drives ≥2 fingerprint slots under caps with durable progress + terminal stopReason", async () => {
    const source = await createSourceRepository();
    const campaign = await writePrivateCampaign(2, { testedCommit: source.revision });
    const beforeReadme = await readFile(join(source.path, "README.md"), "utf8");
    const beforeStatus = await git(source.path, ["status", "--porcelain"]);

    const lines: string[] = [];
    const result = await runMultiUnitCampaignCli(
      [
        "--campaign-dir",
        campaign.campaignDirectory,
        "--repo",
        source.path,
        "--revision",
        source.revision,
        "--json",
      ],
      {
        log: (message) => lines.push(message),
        now: () => CLOCK,
      },
    );

    expect(result.unitsProcessed).toBe(2);
    expect(result.queueIndex).toBe(2);
    expect(result.campaignAttempts).toBe(2);
    expect(result.stopReason).toBe("complete");
    expect(result.sourceCheckoutUnchanged).toBe(true);
    expect(result.sourceStatusEmpty).toBe(true);
    expect(result.sourceRevision).toBe(source.revision);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: "multi-unit-doc-improvement-campaign-dry-run-result",
      stopReason: "complete",
      unitsProcessed: 2,
    });

    const progressRaw = JSON.parse(
      await readFile(join(campaign.campaignDirectory, "progress.json"), "utf8"),
    );
    const progress = decodeMultiUnitDocImprovementProgress(progressRaw);
    expect(progress.stopReason).toBe("complete");
    expect(progress.queueIndex).toBe(2);
    expect(progress.campaignAttempts).toBe(2);
    expect(progress.digest).toBe(result.progressDigest);

    for (const fingerprint of campaign.fingerprints) {
      const receipt = JSON.parse(
        await readFile(
          join(campaign.campaignDirectory, "units", fingerprint, "dry-run-receipt.json"),
          "utf8",
        ),
      );
      expect(receipt.kind).toBe("multi-unit-doc-improvement-dry-run-receipt");
      expect(receipt.workUnitFingerprint).toBe(fingerprint);
    }

    expect(await git(source.path, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(await readFile(join(source.path, "README.md"), "utf8")).toBe(beforeReadme);
    expect(await git(source.path, ["rev-parse", "HEAD"])).toBe(source.revision);
  });

  it("fails closed on --allow-write and leaves source checkout unchanged", async () => {
    const source = await createSourceRepository();
    const campaign = await writePrivateCampaign(2, { testedCommit: source.revision });
    const beforeStatus = await git(source.path, ["status", "--porcelain"]);

    await expect(
      runMultiUnitCampaignDryRun({
        repositoryPath: source.path,
        campaignDirectory: campaign.campaignDirectory,
        allowWrite: true,
        now: () => CLOCK,
      }),
    ).rejects.toMatchObject({
      code: "write-mode-disabled",
    } satisfies Partial<MultiUnitCampaignRunError>);

    expect(await git(source.path, ["status", "--porcelain"])).toBe(beforeStatus);
  });

  it("fails closed on untracked .docsfab.json with the shared project-config code", async () => {
    const source = await createSourceRepository();
    const campaign = await writePrivateCampaign(2, { testedCommit: source.revision });
    await writeFile(
      join(source.path, ".docsfab.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
      { mode: 0o600 },
    );

    try {
      await runMultiUnitCampaignDryRun({
        repositoryPath: source.path,
        campaignDirectory: campaign.campaignDirectory,
        allowWrite: false,
        now: () => CLOCK,
      });
      throw new Error("expected source-dirty");
    } catch (error) {
      expect(error).toMatchObject({
        code: "source-dirty",
        diagnosticCode: "project-config-untracked",
      } satisfies Partial<MultiUnitCampaignRunError>);
      expect(String(error)).toContain("Code: project-config-untracked");
      expect(String(error)).toContain("docsfab multi-unit-campaign");
    }
  });

  it("fails closed on dirty non-config porcelain with the shared dirty code", async () => {
    const source = await createSourceRepository();
    const campaign = await writePrivateCampaign(2, { testedCommit: source.revision });
    await writeFile(join(source.path, "README.md"), "# dirty\n");

    try {
      await runMultiUnitCampaignDryRun({
        repositoryPath: source.path,
        campaignDirectory: campaign.campaignDirectory,
        allowWrite: false,
        now: () => CLOCK,
      });
      throw new Error("expected source-dirty");
    } catch (error) {
      expect(error).toMatchObject({
        code: "source-dirty",
        diagnosticCode: "repository-source-dirty",
      } satisfies Partial<MultiUnitCampaignRunError>);
      expect(String(error)).toContain("Code: repository-source-dirty");
      expect(String(error)).toContain("git status");
    }
  });

  it("parses dry-run-default argv and rejects unknown options", () => {
    const parsed = parseMultiUnitCampaignCliArguments(
      ["--campaign-dir", "/tmp/campaign", "--repo", "/tmp/repo", "--dry-run"],
      "/tmp",
    );
    expect(parsed.allowWrite).toBe(false);
    expect(parsed.campaignDirectory).toBe("/tmp/campaign");
    expect(parsed.repositoryPath).toBe("/tmp/repo");

    expect(() =>
      parseMultiUnitCampaignCliArguments([
        "--campaign-dir",
        "/tmp/campaign",
        "--repo",
        "/tmp/repo",
        "--merge",
      ]),
    ).toThrow(MultiUnitCampaignRunError);
  });
});
