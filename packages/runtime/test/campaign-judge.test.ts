// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CampaignJudgeError,
  runCampaignJudgeCli,
  validateCampaignJudgeGate,
} from "../src/campaign-judge.js";
import { parseModelEndpoint } from "../src/model/configuration.js";
import type { EvaluationJudge } from "../src/quality-evaluation/contracts.js";
import { buildMvpScorecard } from "../src/scorecard.js";
import {
  createCampaignInputs,
  digest,
  judgeConfig,
  testedCommit,
} from "./campaign-judge-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { validModelEnvironment } from "./helpers.js";

const roots = temporaryRoots();

function dependencies(judge: EvaluationJudge) {
  return {
    environment: {
      DOCSFAB_CAMPAIGN_JUDGE: "true",
      JUDGE_ENABLED: "true",
      JUDGE_BASE_URL: judgeConfig.baseUrl,
    },
    loadJudgeConfiguration: () => judgeConfig,
    createJudge: () => judge,
  };
}

function fakeJudge(
  input: {
    passed?: boolean;
    score?: number;
    fail?: boolean;
    inspect?: EvaluationJudge["grade"];
  } = {},
): EvaluationJudge {
  return {
    identity: { provider: judgeConfig.providerId, model: judgeConfig.modelId },
    grade:
      input.inspect ??
      (async () => {
        if (input.fail) throw new Error("PRIVATE_PROVIDER_TRANSCRIPT_SENTINEL");
        return {
          passed: input.passed ?? true,
          score: input.score ?? 0.9,
          rationale: "PRIVATE_RATIONALE_SENTINEL api_key=abcdefghijklmnopqrstuvwx",
        };
      }),
  };
}

async function errorFrom(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("five-record campaign judge", () => {
  it.each([
    ["passed", fakeJudge(), 0],
    ["disagreed", fakeJudge({ passed: false, score: 0.2 }), 0],
    ["error", fakeJudge({ fail: true }), 0],
  ] as const)("persists a strict advisory %s result", async (status, judge, exitCode) => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    const result = await runCampaignJudgeCli(input.args, dependencies(judge));
    const path = join(input.campaignDirectory, "judge-result.json");
    const bytes = await readFile(path);
    const artifact = JSON.parse(bytes.toString("utf8"));

    expect(result).toMatchObject({
      exitCode,
      deterministicPassed: true,
      judgeStatus: status,
      evidenceSha256: digest(bytes),
    });
    expect(Object.keys(artifact).sort()).toEqual(
      [
        "campaignId",
        "fixture",
        "inputRecords",
        "judge",
        "schemaVersion",
        "structural",
        "testedCommit",
      ].sort(),
    );
    expect(artifact.inputRecords).toEqual(
      (input.declaration.records as Array<{ id: string; sha256: string }>).map(
        ({ id, sha256 }) => ({ id, sha256 }),
      ),
    );
    expect(artifact.structural).toEqual({ passed: true, recordCount: 5 });
    expect(artifact.judge.status).toBe(status);
    expect(artifact.judge).not.toHaveProperty("rationale");
    expect(artifact.judge).not.toHaveProperty("reason");
    expect(bytes.toString("utf8")).not.toContain("PRIVATE_");
    expect(bytes.toString("utf8")).not.toContain("api_key");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("redacts minimized evidence and calls the judge exactly once", async () => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    let calls = 0;
    await runCampaignJudgeCli(
      input.args,
      dependencies(
        fakeJudge({
          inspect: async ({ evidence }) => {
            calls += 1;
            expect(evidence.records).toHaveLength(5);
            expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
            expect(JSON.stringify(evidence)).not.toContain("abcdefghijklmnopqrstuvwx");
            expect(evidence.records[0]?.steps[0]?.summary).toBe(
              "[REDACTED: credential-like content]",
            );
            return { passed: true, score: 0.8, rationale: "safe" };
          },
        }),
      ),
    );
    expect(calls).toBe(1);
  });

  it("skips without an artifact or judge call when structural evidence fails", async () => {
    const input = await createCampaignInputs({ structuralFailure: true });
    roots.track(input.root);
    const grade = vi.fn(fakeJudge().grade);
    const result = await runCampaignJudgeCli(input.args, dependencies({ ...fakeJudge(), grade }));

    expect(result).toEqual({
      exitCode: 1,
      deterministicPassed: false,
      judgeStatus: "skipped",
      reason: "structural-evaluation-failed",
    });
    expect(grade).not.toHaveBeenCalled();
    await expect(
      readFile(join(input.campaignDirectory, "judge-result.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires dual opt-in and the exact safe configured judge destination", () => {
    for (const candidate of [
      {
        enabled: false,
        approvedJudgeUrl: judgeConfig.baseUrl,
        environment: {
          DOCSFAB_CAMPAIGN_JUDGE: "true",
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: judgeConfig.baseUrl,
        },
      },
      {
        enabled: true,
        approvedJudgeUrl: "https://other.example.test/v1",
        environment: {
          DOCSFAB_CAMPAIGN_JUDGE: "true",
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: judgeConfig.baseUrl,
        },
      },
      {
        enabled: true,
        approvedJudgeUrl: "https://user:secret@judge.example.test/v1",
        environment: {
          DOCSFAB_CAMPAIGN_JUDGE: "true",
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: judgeConfig.baseUrl,
        },
      },
    ]) {
      expect(() => validateCampaignJudgeGate({ ...candidate, judgeConfig })).toThrow(
        CampaignJudgeError,
      );
    }
  });

  describe("judge profile review date", () => {
    const judgeEnvironment = (overrides: Record<string, string>) =>
      Object.fromEntries(
        Object.entries({ ...validModelEnvironment, ...overrides }).map(([key, value]) => [
          key === "MODEL_ID" ? "JUDGE_MODEL_ID" : key.replace(/^MODEL_/u, "JUDGE_"),
          value,
        ]),
      );
    const gate = (overrides: Record<string, string>) => {
      const config = parseModelEndpoint(
        judgeEnvironment(overrides),
        "JUDGE",
        new Date("2026-09-30T00:00:00Z"),
      );
      return validateCampaignJudgeGate({
        enabled: true,
        approvedJudgeUrl: config.baseUrl,
        environment: {
          DOCSFAB_CAMPAIGN_JUDGE: "true",
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: config.baseUrl,
        },
        judgeConfig: config,
      });
    };

    it("admits a judge whose profile review date has passed", () => {
      // Past on both the injected clock and the wall clock.
      const judge = gate({ MODEL_PROFILE_REVIEW_AFTER: "2026-09-01" });
      expect(judge.profile.metadata).toMatchObject({
        status: "current",
        reviewAfter: "2026-09-01",
      });
      expect(judge.profile.reasoning).toBe(true);
    });

    it("still refuses a judge profile with unknown metadata", () => {
      // Adjacent condition: absent provenance keeps its refusal.
      let failure: unknown;
      try {
        gate({
          MODEL_PROFILE_APPROVED_SOURCE: "unknown",
          MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
          MODEL_PROFILE_REVIEW_AFTER: "unknown",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CampaignJudgeError);
      expect((failure as CampaignJudgeError).code).toBe("judge-profile-not-current");
    });
  });

  it("accepts trailing-slash equivalents of the configured judge destination", () => {
    expect(
      validateCampaignJudgeGate({
        enabled: true,
        approvedJudgeUrl: `${judgeConfig.baseUrl}/`,
        environment: {
          DOCSFAB_CAMPAIGN_JUDGE: "true",
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: `${judgeConfig.baseUrl}/`,
        },
        judgeConfig,
      }),
    ).toBe(judgeConfig);
  });

  it("rejects missing authorization before loading judge configuration", async () => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    const loadJudgeConfiguration = vi.fn(() => judgeConfig);
    const error = await errorFrom(() =>
      runCampaignJudgeCli(input.args, {
        environment: {
          JUDGE_ENABLED: "true",
          JUDGE_BASE_URL: judgeConfig.baseUrl,
        },
        loadJudgeConfiguration,
        createJudge: () => fakeJudge(),
      }),
    );
    expect(String(error)).toContain("judge-not-authorized");
    expect(loadJudgeConfiguration).not.toHaveBeenCalled();
  });

  it("rejects a model identity not approved by the #34 acceptance", async () => {
    const input = await createCampaignInputs({ acceptanceModel: "judge/other-model" });
    roots.track(input.root);
    const grade = vi.fn(fakeJudge().grade);
    const error = await errorFrom(() =>
      runCampaignJudgeCli(input.args, dependencies({ ...fakeJudge(), grade })),
    );

    expect(String(error)).toContain("acceptance-judge-mismatch");
    expect(grade).not.toHaveBeenCalled();
  });

  it.each(["arbitrary", "model", "status", "inputs"] as const)(
    "rejects %s separate #34 judge evidence even when its manifest digest is updated",
    async (mutation) => {
      const input = await createCampaignInputs();
      roots.track(input.root);
      const path = join(input.acceptanceDirectory, "judge-result.json");
      let artifact: Record<string, any> = JSON.parse(await readFile(path, "utf8"));
      if (mutation === "arbitrary") artifact = { arbitrary: true };
      if (mutation === "model") artifact.judge.model.model = "judge/other-model";
      if (mutation === "status") artifact.judge.status = "disagreed";
      if (mutation === "inputs") artifact.inputRecords[0].sha256 = "9".repeat(64);
      const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
      await writeFile(path, bytes, { mode: 0o600 });
      const manifestPath = join(input.acceptanceDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.judge.sha256 = digest(bytes);
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      const grade = vi.fn(fakeJudge().grade);

      const error = await errorFrom(() =>
        runCampaignJudgeCli(input.args, dependencies({ ...fakeJudge(), grade })),
      );
      expect(String(error)).toContain("acceptance-judge-mismatch");
      expect(grade).not.toHaveBeenCalled();
    },
  );

  it.each(["duplicate", "wrong-digest"] as const)(
    "rejects %s five-record declaration bindings before grading",
    async (mutation) => {
      const input = await createCampaignInputs();
      roots.track(input.root);
      const records = input.declaration.records as Array<Record<string, unknown>>;
      if (mutation === "duplicate") {
        records[4] = { ...records[4], id: records[0]!.id, file: records[0]!.file };
      } else {
        records[4] = { ...records[4], sha256: "9".repeat(64) };
      }
      await writeFile(
        join(input.campaignDirectory, "campaign.json"),
        `${JSON.stringify(input.declaration)}\n`,
        { mode: 0o600 },
      );
      const grade = vi.fn(fakeJudge().grade);
      const error = await errorFrom(() =>
        runCampaignJudgeCli(input.args, dependencies({ ...fakeJudge(), grade })),
      );
      expect(String(error)).toMatch(/invalid-(?:campaign|record-set)/u);
      expect(grade).not.toHaveBeenCalled();
    },
  );

  it("fails closed for insecure leaves, symlinks, and prior result evidence", async () => {
    const insecure = await createCampaignInputs();
    roots.track(insecure.root);
    await chmod(join(insecure.stateDirectory, "run-1.json"), 0o644);
    expect(
      String(await errorFrom(() => runCampaignJudgeCli(insecure.args, dependencies(fakeJudge())))),
    ).toContain("insecure-permissions");

    const linked = await createCampaignInputs();
    roots.track(linked.root);
    await rm(join(linked.stateDirectory, "run-1.json"));
    await symlink(
      join(linked.stateDirectory, "run-2.json"),
      join(linked.stateDirectory, "run-1.json"),
    );
    expect(
      String(await errorFrom(() => runCampaignJudgeCli(linked.args, dependencies(fakeJudge())))),
    ).toContain("unsafe-entry");

    const existing = await createCampaignInputs();
    roots.track(existing.root);
    const first = await runCampaignJudgeCli(existing.args, dependencies(fakeJudge()));
    const before = await readFile(join(existing.campaignDirectory, "judge-result.json"));
    const error = await errorFrom(() =>
      runCampaignJudgeCli(existing.args, dependencies(fakeJudge({ passed: false }))),
    );
    expect(String(error)).toContain("invalid-campaign");
    expect(await readFile(join(existing.campaignDirectory, "judge-result.json"))).toEqual(before);
    expect(first.deterministicPassed).toBe(true);
  });

  it("rejects a symlink-substituted campaign output directory", async () => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    const moved = join(input.root, "campaign-real");
    await rename(input.campaignDirectory, moved);
    await symlink(moved, input.campaignDirectory);
    const error = await errorFrom(() => runCampaignJudgeCli(input.args, dependencies(fakeJudge())));
    expect(String(error)).toContain("unsafe-directory");
    await expect(readFile(join(moved, "judge-result.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not publish if a private input changes while the judge is running", async () => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    const error = await errorFrom(() =>
      runCampaignJudgeCli(
        input.args,
        dependencies(
          fakeJudge({
            inspect: async () => {
              const path = join(input.stateDirectory, "run-1.json");
              const record = JSON.parse(await readFile(path, "utf8"));
              record.instruction = "changed during grading";
              await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
              return { passed: true, score: 0.8, rationale: "safe" };
            },
          }),
        ),
      ),
    );
    expect(String(error)).toContain("input-changed");
    await expect(
      readFile(join(input.campaignDirectory, "judge-result.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates the retained result if an input mutates at the publication boundary", async () => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    const path = join(input.stateDirectory, "run-1.json");
    const error = await errorFrom(() =>
      runCampaignJudgeCli(input.args, {
        ...dependencies(fakeJudge()),
        publicationOptions: {
          afterWrite: async () => {
            const record = JSON.parse(await readFile(path, "utf8"));
            record.instruction = "changed after result write";
            await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
          },
        },
      }),
    );
    expect(String(error)).toContain("input-changed");
    await expect(
      readFile(join(input.campaignDirectory, "judge-result.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one concurrent exclusive publication and preserves its valid bytes", async () => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    const results = await Promise.allSettled([
      runCampaignJudgeCli(input.args, dependencies(fakeJudge())),
      runCampaignJudgeCli(input.args, dependencies(fakeJudge())),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const bytes = await readFile(join(input.campaignDirectory, "judge-result.json"));
    const artifact = JSON.parse(bytes.toString("utf8"));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      campaignId: "mvp-stabilization-01",
      structural: { passed: true, recordCount: 5 },
      judge: { status: "passed" },
    });
  });

  it("hands the exact artifact digest and disposition to the #33 scorecard", async () => {
    const input = await createCampaignInputs();
    roots.track(input.root);
    const result = await runCampaignJudgeCli(input.args, dependencies(fakeJudge()));
    const judgeBytes = await readFile(join(input.campaignDirectory, "judge-result.json"));
    const declaration = {
      ...input.declaration,
      judge: result.declarationJudge,
    };
    const declarationBytes = Buffer.from(`${JSON.stringify(declaration)}\n`);
    const recordLeaves = await Promise.all(
      (input.declaration.records as Array<{ file: string }>).map(async ({ file }) => ({
        file,
        bytes: await readFile(join(input.stateDirectory, file)),
      })),
    );
    const fixtureBytes = await readFile(
      join(
        process.cwd(),
        "test/fixtures/runtime-evaluation/fixtures/turn-governance-live-readiness.json",
      ),
    );
    const acceptanceBytes = await readFile(join(input.acceptanceDirectory, "manifest.json"));
    const scorecard = buildMvpScorecard({
      declarationBytes,
      recordLeaves,
      fixtureBytes,
      acceptanceBytes,
      judgeBytes,
      dependency: {
        advisoryId: "GHSA-mh99-v99m-4gvg",
        status: "contained",
        owner: "docsfab-maintainers",
        reviewOn: "2026-08-17",
        packageStateSha256: "8".repeat(64),
      },
      verification: [
        { id: "npm-check", passed: true },
        { id: "npm-build", passed: true },
        { id: "git-diff-check", passed: true },
      ],
      generatorRevision: testedCommit,
    });

    expect(scorecard.gates.semanticJudge).toBe("passed");
    expect(scorecard.judge).toMatchObject(result.declarationJudge!);
  });
});
