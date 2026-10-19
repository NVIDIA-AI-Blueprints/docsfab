// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { parseBoundedDocImprovementDeclaration } from "../src/doc-improvement.js";
import {
  MULTI_UNIT_DOC_IMPROVEMENT_CAMPAIGN_KIND,
  MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT,
  MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS,
  MULTI_UNIT_MAX_UNITS,
  MultiUnitDocImprovementError,
  assertMultiUnitCampaignPrivateDirectory,
  assertSafeUnitLeafName,
  bindMultiUnitCampaignLedger,
  bindUnitQueueMachineContracts,
  createMultiUnitDocImprovementDeclaration,
  createMultiUnitDocImprovementProgress,
  createMultiUnitDocImprovementUnitQueue,
  decodeMultiUnitDocImprovementDeclaration,
  decodeMultiUnitDocImprovementProgress,
  decodeMultiUnitDocImprovementUnitQueue,
  type MultiUnitDocImprovementDeclarationBodyV1,
  type MultiUnitDocImprovementProgressBodyV1,
} from "../src/autonomy/multi-unit-doc-improvement.js";
import {
  createWorkUnitMachineContract,
  type WorkUnitMachineContractBodyV1,
} from "../src/maturity/work-unit-machine-contract.js";

const SHA = (value: string) => createHash("sha256").update(value).digest("hex");
const REVISION = "b".repeat(40);
const GENERATED_AT = "2026-08-12T14:00:00.000Z";
const UPDATED_AT = "2026-08-12T15:00:00.000Z";

function expectMultiUnitError(
  run: () => unknown,
  code: MultiUnitDocImprovementError["code"],
): void {
  try {
    run();
    throw new Error(`expected MultiUnitDocImprovementError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(MultiUnitDocImprovementError);
    expect((error as MultiUnitDocImprovementError).code).toBe(code);
  }
}

async function expectMultiUnitErrorAsync(
  run: () => Promise<unknown>,
  code: MultiUnitDocImprovementError["code"],
): Promise<void> {
  try {
    await run();
    throw new Error(`expected MultiUnitDocImprovementError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(MultiUnitDocImprovementError);
    expect((error as MultiUnitDocImprovementError).code).toBe(code);
  }
}

function declarationBody(
  overrides: Partial<MultiUnitDocImprovementDeclarationBodyV1> = {},
): MultiUnitDocImprovementDeclarationBodyV1 {
  return {
    campaignId: "campaign-multi-unit-1",
    repositoryId: "tech-docs/docsfab",
    testedCommit: REVISION,
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
        checkKind: "npm-script",
        commandId: "check",
        expectedOutcomeClass: "pass",
      },
    ],
    acceptanceAuthority: "host-deterministic",
    trackerMutation: "not-authorized",
  };
}

function sealedLedger(unitCount = 2) {
  const fingerprints = Array.from({ length: unitCount }, (_, index) => SHA(`unit-${index + 1}`));
  const envelopes = fingerprints.map((fingerprint) =>
    createWorkUnitMachineContract(machineBody(fingerprint)),
  );
  const declaration = createMultiUnitDocImprovementDeclaration(declarationBody());
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
  return { declaration, unitQueue, progress, envelopes, fingerprints };
}

async function writePrivateCampaign(
  declaration: ReturnType<typeof createMultiUnitDocImprovementDeclaration>,
  unitQueue: ReturnType<typeof createMultiUnitDocImprovementUnitQueue>,
  progress: ReturnType<typeof createMultiUnitDocImprovementProgress>,
  options: { unitLeafNames?: string[] } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-multi-unit-"));
  await chmod(root, 0o700);
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
  const leafNames =
    options.unitLeafNames ?? unitQueue.units.map((entry) => entry.workUnitFingerprint);
  for (const leaf of leafNames) {
    const unitDir = join(unitsDir, leaf);
    await mkdir(unitDir, { mode: 0o700 });
    await chmod(unitDir, 0o700);
    const receipt = join(unitDir, "receipt.json");
    await writeFile(receipt, `${JSON.stringify({ ok: true }, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(receipt, 0o600);
  }
  return root;
}

describe("multi-unit-doc-improvement campaign ledger (#266 / #257)", () => {
  it("decodes valid declaration + unit-queue + progress and binds digests", () => {
    const { declaration, unitQueue, progress, envelopes } = sealedLedger(2);
    expect(declaration.kind).toBe(MULTI_UNIT_DOC_IMPROVEMENT_CAMPAIGN_KIND);
    expect(decodeMultiUnitDocImprovementDeclaration(declaration)).toEqual(declaration);
    expect(decodeMultiUnitDocImprovementUnitQueue(unitQueue)).toEqual(unitQueue);
    expect(decodeMultiUnitDocImprovementProgress(progress)).toEqual(progress);
    expect(bindMultiUnitCampaignLedger({ declaration, unitQueue, progress })).toEqual({
      declaration,
      unitQueue,
      progress,
    });
    const bound = bindUnitQueueMachineContracts(unitQueue, envelopes);
    expect(bound).toHaveLength(2);
    expect(bound[0]!.machineContractSha256).toBe(unitQueue.units[0]!.machineContractSha256);
    expect(bound[0]!.workUnitFingerprint).toBe(unitQueue.units[0]!.workUnitFingerprint);
  });

  it("rejects over-cap declaration fields and over-cap queues", () => {
    expectMultiUnitError(
      () =>
        createMultiUnitDocImprovementDeclaration(
          declarationBody({
            caps: {
              maxUnits: MULTI_UNIT_MAX_UNITS + 1,
              maxAttemptsPerUnit: MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT,
              maxCampaignAttempts: MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS,
            },
          }),
        ),
      "cap-exceeded",
    );
    expectMultiUnitError(
      () =>
        createMultiUnitDocImprovementDeclaration(
          declarationBody({
            caps: {
              maxUnits: MULTI_UNIT_MAX_UNITS,
              maxAttemptsPerUnit: MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT + 1,
              maxCampaignAttempts: MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS,
            },
          }),
        ),
      "cap-exceeded",
    );
    expectMultiUnitError(
      () =>
        createMultiUnitDocImprovementDeclaration(
          declarationBody({
            caps: {
              maxUnits: MULTI_UNIT_MAX_UNITS,
              maxAttemptsPerUnit: MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT,
              maxCampaignAttempts: MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS + 1,
            },
          }),
        ),
      "cap-exceeded",
    );

    const fingerprints = Array.from({ length: MULTI_UNIT_MAX_UNITS + 1 }, (_, index) =>
      SHA(`over-cap-unit-${index}`),
    );
    const units = fingerprints.map((fingerprint) => {
      const envelope = createWorkUnitMachineContract(machineBody(fingerprint));
      return {
        workUnitFingerprint: envelope.workUnitFingerprint,
        machineContractSha256: envelope.machineContractSha256,
      };
    });
    expectMultiUnitError(
      () =>
        createMultiUnitDocImprovementUnitQueue({
          campaignId: "campaign-multi-unit-1",
          declarationDigest: SHA("declaration"),
          units,
        }),
      "cap-exceeded",
    );

    const declaration = createMultiUnitDocImprovementDeclaration(
      declarationBody({
        caps: {
          maxUnits: 2,
          maxAttemptsPerUnit: 2,
          maxCampaignAttempts: 4,
        },
      }),
    );
    const shortQueue = createMultiUnitDocImprovementUnitQueue({
      campaignId: declaration.campaignId,
      declarationDigest: declaration.digest,
      units: units.slice(0, 3),
    });
    const progress = createMultiUnitDocImprovementProgress({
      campaignId: declaration.campaignId,
      declarationDigest: declaration.digest,
      unitQueueDigest: shortQueue.digest,
      queueIndex: 0,
      unitAttempts: 0,
      campaignAttempts: 0,
      stopReason: null,
      updatedAt: UPDATED_AT,
    });
    expectMultiUnitError(
      () =>
        bindMultiUnitCampaignLedger({
          declaration,
          unitQueue: shortQueue,
          progress,
        }),
      "cap-exceeded",
    );
  });

  it("rejects unknown stopReason, missing machineContractSha256, and unit leaf traversal", () => {
    const { declaration, unitQueue } = sealedLedger(1);
    const progressBody: MultiUnitDocImprovementProgressBodyV1 = {
      campaignId: declaration.campaignId,
      declarationDigest: declaration.digest,
      unitQueueDigest: unitQueue.digest,
      queueIndex: 0,
      unitAttempts: 0,
      campaignAttempts: 0,
      stopReason: "complete",
      updatedAt: UPDATED_AT,
    };
    expectMultiUnitError(
      () =>
        decodeMultiUnitDocImprovementProgress({
          ...createMultiUnitDocImprovementProgress(progressBody),
          stopReason: "chat-said-done",
        }),
      "invalid-value",
    );

    expectMultiUnitError(
      () =>
        decodeMultiUnitDocImprovementUnitQueue({
          schemaVersion: 1,
          kind: "multi-unit-doc-improvement-unit-queue",
          campaignId: declaration.campaignId,
          declarationDigest: declaration.digest,
          units: [{ workUnitFingerprint: SHA("lonely") }],
          digest: "a".repeat(64),
        }),
      "invalid-shape",
    );

    expectMultiUnitError(() => assertSafeUnitLeafName("../etc"), "unsafe-unit-leaf");
    expectMultiUnitError(() => assertSafeUnitLeafName("units/../../tmp"), "unsafe-unit-leaf");
    expectMultiUnitError(() => assertSafeUnitLeafName("not-a-digest"), "unsafe-unit-leaf");
  });

  it("rejects chat-shaped authority fields on sealed envelopes", () => {
    const declaration = createMultiUnitDocImprovementDeclaration(declarationBody());
    expectMultiUnitError(
      () =>
        decodeMultiUnitDocImprovementDeclaration({
          ...declaration,
          prompt: "please continue the campaign",
        }),
      "invalid-shape",
    );
    expectMultiUnitError(
      () =>
        decodeMultiUnitDocImprovementUnitQueue({
          ...createMultiUnitDocImprovementUnitQueue({
            campaignId: declaration.campaignId,
            declarationDigest: declaration.digest,
            units: [],
          }),
          messages: [{ role: "user", content: "advance" }],
        }),
      "invalid-shape",
    );
    expectMultiUnitError(
      () =>
        decodeMultiUnitDocImprovementProgress({
          ...createMultiUnitDocImprovementProgress({
            campaignId: declaration.campaignId,
            declarationDigest: declaration.digest,
            unitQueueDigest: SHA("queue"),
            queueIndex: 0,
            unitAttempts: 0,
            campaignAttempts: 0,
            stopReason: null,
            updatedAt: UPDATED_AT,
          }),
          chatTranscript: "operator said stop",
        }),
      "invalid-shape",
    );
  });

  it("accepts private campaign dir layout and rejects traversal unit leaves", async () => {
    const { declaration, unitQueue, progress } = sealedLedger(2);
    const root = await writePrivateCampaign(declaration, unitQueue, progress);
    const pinned = await assertMultiUnitCampaignPrivateDirectory({
      directory: root,
      declaration,
      unitQueue,
    });
    expect(pinned.path).toBe(root);

    await expectMultiUnitErrorAsync(
      () =>
        assertMultiUnitCampaignPrivateDirectory({
          directory: root,
          declaration,
          unitQueue: createMultiUnitDocImprovementUnitQueue({
            campaignId: declaration.campaignId,
            declarationDigest: declaration.digest,
            units: [
              {
                workUnitFingerprint: SHA("missing-dir"),
                machineContractSha256: SHA("missing-contract"),
              },
            ],
          }),
        }),
      "unsafe-private-directory",
    );
  });

  it("keeps single-gap bounded-doc-improvement declaration decode unchanged", () => {
    const gapEvidence = [{ path: "docs/provider-reliability.md", sha256: "c".repeat(64) }];
    const declarationValue = {
      schemaVersion: 1 as const,
      kind: "bounded-doc-improvement-campaign" as const,
      campaignId: "issue-35-campaign",
      repositoryId: "example-user/docsfab",
      testedCommit: REVISION,
      repositoryIdentitySha256: SHA("single-gap-repo"),
      gap: {
        id: "retry-doc-gap",
        evidence: gapEvidence,
        successCriterion: "Document the retry path.",
      },
      inputs: {
        analysisRecord: { file: "analysis-record.json", sha256: "a".repeat(64) },
        authorization: { file: "authorization.json", sha256: "b".repeat(64) },
        applicationRecord: { file: "application-record.json", sha256: "d".repeat(64) },
        patch: {
          file: "improvement.patch",
          sha256: "e".repeat(64),
          byteLength: 128,
        },
        independentReview: {
          file: "independent-review.json",
          sha256: "f".repeat(64),
        },
      },
      validationProfile: "docsfab" as const,
      generatedAt: GENERATED_AT,
    };
    const declaration = {
      ...declarationValue,
      digest: canonicalDigest(declarationValue),
    };
    const parsed = parseBoundedDocImprovementDeclaration(declaration);
    expect(parsed.kind).toBe("bounded-doc-improvement-campaign");
    expect(parsed.campaignId).toBe("issue-35-campaign");
    expect(parsed.gap.id).toBe("retry-doc-gap");
  });

  it("rejects progress attempt counters above absolute caps", () => {
    const { declaration, unitQueue } = sealedLedger(1);
    expectMultiUnitError(
      () =>
        createMultiUnitDocImprovementProgress({
          campaignId: declaration.campaignId,
          declarationDigest: declaration.digest,
          unitQueueDigest: unitQueue.digest,
          queueIndex: 0,
          unitAttempts: MULTI_UNIT_MAX_ATTEMPTS_PER_UNIT + 1,
          campaignAttempts: 0,
          stopReason: null,
          updatedAt: UPDATED_AT,
        }),
      "cap-exceeded",
    );
    expectMultiUnitError(
      () =>
        createMultiUnitDocImprovementProgress({
          campaignId: declaration.campaignId,
          declarationDigest: declaration.digest,
          unitQueueDigest: unitQueue.digest,
          queueIndex: 0,
          unitAttempts: 0,
          campaignAttempts: MULTI_UNIT_MAX_CAMPAIGN_ATTEMPTS + 1,
          stopReason: "cap-exhausted",
          updatedAt: UPDATED_AT,
        }),
      "cap-exceeded",
    );
  });

  it("rejects machine-contract digest mismatch on bind", () => {
    const { unitQueue, envelopes } = sealedLedger(1);
    const mismatched = createWorkUnitMachineContract(machineBody(SHA("other-unit")));
    expectMultiUnitError(
      () => bindUnitQueueMachineContracts(unitQueue, [mismatched]),
      "machine-contract-mismatch",
    );
    expectMultiUnitError(
      () => bindUnitQueueMachineContracts(unitQueue, [null]),
      "missing-machine-contract",
    );
    expect(bindUnitQueueMachineContracts(unitQueue, envelopes)).toHaveLength(1);
  });
});
