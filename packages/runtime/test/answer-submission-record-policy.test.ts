// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public answer-submission capability and reseal policy checks.
 * Corpus-bound qualification tests live in answer-submission-record-evidence.internal.test.ts;
 * their pinned corpus includes internal retained-run provenance and stays out of public exports.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  RECORDED_ANSWER_SUBMISSION_FIELDS,
  deriveAnswerSubmissionFixtureRows,
  recordedAnswerSubmissionGaps,
  recordedAnswerSubmissionRecordsEvidenceGaps,
} from "../src/model-composition/answer-submission-record.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const SUPER = "nvidia-nemotron-3-super-120b-a12b-pi";
/** Every field a recorded capability must carry, spelled out so the rule's own list cannot shrink it. */
const REQUIRED_FIELDS = [
  "kind",
  "argumentShell",
  "duplicateKeys",
  "reportTurnToolChoice",
  "objectMembers",
  "evidenceSha256",
] as const;
const COMPLETE = Object.freeze({
  kind: "host-tool-call",
  argumentShell: "untyped",
  duplicateKeys: "unobserved",
  reportTurnToolChoice: "auto",
  objectMembers: "stringified",
  evidenceSha256: "e".repeat(64),
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function withoutKey(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = body;
  return rest;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * A copy of the model-compositions directory and of `installed.ts` whose
 * Super composition records `capability`, with the digests the verify script
 * checks recomputed, so only the capability rule can fail.
 */
async function sealedCopy(capability: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-answer-submission-record-"));
  roots.push(root);
  const compositionsDir = join(root, "model-compositions");
  await cp(join(runtimeRoot, "model-compositions"), compositionsDir, { recursive: true });
  const installedTs = join(root, "installed.ts");
  await cp(join(runtimeRoot, "src/model-composition/installed-manifest-pin.js"), installedTs);

  const registryPath = join(compositionsDir, "composition-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    compositions: Array<Record<string, unknown>>;
    registrySha256: string;
  };
  const composition = registry.compositions.find((entry) => entry.compositionId === SUPER)!;
  composition.answerSubmission = capability;
  composition.compositionSha256 = canonicalDigest(withoutKey(composition, "compositionSha256"));
  registry.registrySha256 = canonicalDigest(
    withoutKey(registry as unknown as Record<string, unknown>, "registrySha256"),
  );
  const registryBytes = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(registryPath, registryBytes);

  const manifestPath = join(compositionsDir, "installed-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    assets: Array<{ path: string; fileSha256: string }>;
  } & Record<string, unknown>;
  manifest.assets.find((asset) => asset.path === "composition-registry.json")!.fileSha256 =
    sha256(registryBytes);
  manifest.installedManifestSha256 = canonicalDigest(
    withoutKey(manifest, "installedManifestSha256"),
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { compositionsDir, installedTs };
}

function runScript(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join("scripts", script), ...args], {
    cwd: runtimeRoot,
    encoding: "utf8",
  });
}

async function snapshot(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries
    .filter((item) => item.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    files.set(entry.name, sha256(await readFile(join(directory, entry.name))));
  }
  return files;
}

describe("recordedAnswerSubmissionGaps", () => {
  it("requires exactly the capability's fields", () => {
    expect([...RECORDED_ANSWER_SUBMISSION_FIELDS].sort()).toEqual([...REQUIRED_FIELDS].sort());
    expect(Object.keys(COMPLETE).sort()).toEqual([...REQUIRED_FIELDS].sort());
  });

  it("passes a complete capability and a registry without one", () => {
    expect(recordedAnswerSubmissionGaps({ compositions: [{ compositionId: SUPER }] })).toEqual([]);
    expect(
      recordedAnswerSubmissionGaps({
        compositions: [{ compositionId: SUPER, answerSubmission: COMPLETE }],
      }),
    ).toEqual([]);
  });

  it.each(REQUIRED_FIELDS)("names a recorded capability that lacks %s", (field) => {
    expect(
      recordedAnswerSubmissionGaps({
        compositions: [{ compositionId: SUPER, answerSubmission: withoutKey(COMPLETE, field) }],
      }),
    ).toEqual([`composition ${SUPER}: answerSubmission lacks ${field}`]);
  });
});

describe("recordedAnswerSubmissionRecordsEvidenceGaps public boundary", () => {
  it("refuses a self-hashed corpus subset before reading probe evidence", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "docsfab-unpinned-answer-record-corpus-"));
    roots.push(evidenceRoot);
    const corpusBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-answer-record-corpus",
        records: [
          { fixture: "synthetic", group: 1, type: "dimension", record: { status: "synthetic" } },
        ],
      }),
    );
    const corpusDigest = sha256(corpusBytes);
    await writeFile(join(evidenceRoot, "corpus.json"), corpusBytes);

    const step8Body = {
      schemaVersion: 1,
      kind: "retained-step8-turn-measurement",
      targetRevisionSha256: "a".repeat(64),
      samples: [
        {
          runEvidenceSha256: "b".repeat(64),
          stepId: "review-documentation",
          attempt: 1,
          compositionId: SUPER,
          modelId: "synthetic-model",
          routeId: "synthetic-route",
          deploymentIdentitySha256: "d".repeat(64),
          providerTurns: 1,
          readingTurns: 0,
          recordCalls: 0,
          turnLatencyMs: 1,
          d3ResidualFires: "unknown",
        },
      ],
      projectedReportTokens: 2700,
    } as const;
    const records = {
      schemaVersion: 1,
      kind: "records",
      maxRecordBytes: 1,
      phaseAAdmittedSamples: 3,
      phaseBMaxAdmittedMessageBytes: 1,
      minimumQualifiedMessageBytes: 1,
      phaseBAdmittedSamples: 3,
      phaseCOutcome: "admitted",
      phaseCSamples: 3,
      phaseCMaxObservedRecordBytes: 1,
      maxMessageBytes: 1,
      groupEnvelopeBytes: [{ group: 1, maxBytes: 1 }],
      fullPlanEnvelopeBytes: 1,
      largestRecordEnvelopeBytes: 1,
      lturnMs: 1,
      readingTurnsP90: 0,
      argumentShell: "untyped",
      decodeTokensPerSecond: 1,
      decodeRateSource: "end-to-end",
      modelId: "synthetic-model",
      routeId: "synthetic-route",
      deploymentIdentitySha256: "d".repeat(64),
      answerSubmissionEvidenceSha256: "e".repeat(64),
      corpusSha256: corpusDigest,
      fixtureRows: deriveAnswerSubmissionFixtureRows([
        {
          fixture: "synthetic",
          group: 1,
          type: "dimension",
          record: { status: "synthetic" },
        },
      ]),
      evidenceSha256: "f".repeat(64),
      step8TurnEvidence: {
        ...step8Body,
        evidenceSha256: canonicalDigest(step8Body),
      },
    };
    const registry = {
      compositions: [
        {
          compositionId: SUPER,
          answerSubmissionRecords: records,
          answerSubmission: { evidenceSha256: records.answerSubmissionEvidenceSha256 },
          model: { resolvedId: records.modelId },
          deployment: {
            routeId: records.routeId,
            identitySha256: records.deploymentIdentitySha256,
          },
        },
      ],
    };

    const gaps = await recordedAnswerSubmissionRecordsEvidenceGaps(registry, evidenceRoot);
    expect(sha256(corpusBytes)).toBe(corpusDigest);
    expect(gaps).toEqual([`composition ${SUPER}: records capability has no valid corpus digest`]);
  });
});
describe("T-S17: the reseal and verify scripts refuse an incomplete recorded capability", () => {
  it("verify fails on a correctly sealed registry whose capability lacks objectMembers, and passes the complete one", async () => {
    const incomplete = await sealedCopy(withoutKey(COMPLETE, "objectMembers"));
    const refused = runScript("verify-composition-digests.mts", [
      "--root",
      incomplete.compositionsDir,
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain(
      "0 mismatch(es); 1 incomplete answerSubmission field(s); 0 unproven answerSubmissionRecords qualification(s)",
    );
    expect(refused.stderr).toContain(`composition ${SUPER}: answerSubmission lacks objectMembers`);

    const complete = await sealedCopy(COMPLETE);
    const passed = runScript("verify-composition-digests.mts", [
      "--root",
      complete.compositionsDir,
    ]);
    expect(passed.stderr).toBe("");
    expect(passed.status).toBe(0);
  }, 120_000);

  it.each(REQUIRED_FIELDS)(
    "verify refuses a correctly sealed registry whose capability lacks %s, and names its root",
    async (field) => {
      const incomplete = await sealedCopy(withoutKey(COMPLETE, field));
      const refused = runScript("verify-composition-digests.mts", [
        "--root",
        incomplete.compositionsDir,
      ]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain(
        `0 mismatch(es); 1 incomplete answerSubmission field(s); 0 unproven answerSubmissionRecords qualification(s) in ${incomplete.compositionsDir}`,
      );
      expect(refused.stderr).toContain(`composition ${SUPER}: answerSubmission lacks ${field}`);
    },
    120_000,
  );

  it("reseal refuses before writing anything, and reseals the complete capability", async () => {
    const incomplete = await sealedCopy(withoutKey(COMPLETE, "objectMembers"));
    const before = await snapshot(incomplete.compositionsDir);
    const installedBefore = sha256(await readFile(incomplete.installedTs));
    const refused = runScript("reseal-composition-digests.mts", [
      "--root",
      incomplete.compositionsDir,
      "--installed-ts",
      incomplete.installedTs,
    ]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(`composition ${SUPER}: answerSubmission lacks objectMembers`);
    expect(await snapshot(incomplete.compositionsDir)).toEqual(before);
    expect(sha256(await readFile(incomplete.installedTs))).toBe(installedBefore);

    const complete = await sealedCopy(COMPLETE);
    const resealed = runScript("reseal-composition-digests.mts", [
      "--root",
      complete.compositionsDir,
      "--installed-ts",
      complete.installedTs,
    ]);
    expect(resealed.status).toBe(0);
    const verified = runScript("verify-composition-digests.mts", [
      "--root",
      complete.compositionsDir,
    ]);
    expect(verified.status).toBe(0);
  }, 120_000);
});
