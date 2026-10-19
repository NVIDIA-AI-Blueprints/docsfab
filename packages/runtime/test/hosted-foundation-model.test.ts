// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { limitDefinition } from "../src/config/limits.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  assembleHostedFoundation,
  inspectHostedFoundation,
  HOSTED_FOUNDATION_APPROVED_MODEL_ABSENT,
} from "../src/foundation/hosted.js";
import {
  inspectFoundation,
  FOUNDATION_CLAIM_LABEL_MAX_CHARS_LIMIT,
} from "../src/foundation/inspect.js";
import {
  parseHostRuntimeApprovedModelData,
  parseHostRuntimeApprovedModelReference,
  HOST_RUNTIME_APPROVED_MODEL_BASELINE_MAXIMUM_BYTES,
} from "../src/host-invoker/approved-model.js";
import {
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeNativeCustody,
  sealHostRuntimeNativeTask,
} from "../src/host-invoker/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  approvedModelFixture,
  describeModelFixture,
  producerCanonicalJson,
  producerDigest,
  stageModelFixture,
} from "./helpers/hosted-approved-model.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** Re-seal a mutated fixture the way the producers seal, never the parser's way. */
function reseal(model: ReturnType<typeof approvedModelFixture>) {
  const { snapshotSha256: _snapshot, ...snapshot } = model.baseline.snapshot;
  model.baseline.snapshot.snapshotSha256 = producerDigest(snapshot);
  model.baseline.approval.snapshotSha256 = model.baseline.snapshot.snapshotSha256;
  const { baselineSha256: _baseline, ...baseline } = model.baseline;
  model.baseline.baselineSha256 = producerDigest(baseline);
}
async function fixture(
  model = approvedModelFixture(),
  options: { stageApprovedModel?: boolean; approvedCanonSha256?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "foundation-model-"));
  roots.push(root);
  const repository = join(root, "repo"),
    stateDirectory = join(root, "state");
  await mkdir(repository);
  await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(
    join(repository, "AGENTS.md"),
    "# Instructions\n\nDocument supported project inputs.\n",
  );
  await writeFile(
    join(repository, "README.md"),
    "# Project inputs\n\nSelect a named project input.\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const workspace = await prepareRepositoryWorkspace(repository);
  const approvedModel =
    options.stageApprovedModel === false
      ? undefined
      : await stageModelFixture(stateDirectory, model.baseline);
  const binding = { deploymentId: "fixture", projectId: "project-a", deploymentEpoch: "epoch" };
  const task = sealHostRuntimeNativeTask({
    workflow: "foundation",
    task: { kind: "foundation" },
    inputs: [],
  });
  const stepIds = ["inspect-foundation"],
    declaredTools = ["find", "grep", "ls", "read"];
  const capsule = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [],
  };
  const request = parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    ...binding,
    requestKey: "request",
    runId: "run",
    origin: { principalId: "fixture-operator", requestId: "message" },
    fence: 1,
    workflow: "foundation",
    revision: workspace.revision,
    sourceTreeObjectId: git("rev-parse", "HEAD^{tree}"),
    workspacePath: workspace.path,
    stateDirectory,
    allowWrite: false,
    nativeCustody: sealHostRuntimeNativeCustody({
      task,
      binding,
      repositoryIdentitySha256: "1".repeat(64),
      approvedCanonSha256: options.approvedCanonSha256 ?? model.canon.sha256,
      ...(approvedModel ? { approvedModel } : {}),
      inputs: [],
    }),
    packet: {
      packetFingerprintSha256: "f".repeat(64),
      inputManifest: null,
      canon: model.canon,
      reviewEvent: null,
      nativeTask: task,
    },
    composition: sealHostRuntimeComposition({
      compositionId: "foundation-fixture",
      route: "offline-fixture",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools,
    }),
    stepIds,
    toolPolicySha256: canonicalDigest({ workflow: "foundation", stepIds, declaredTools }),
    capsule: { ...capsule, sha256: canonicalDigest(capsule) },
  });
  return { root, repository, workspace, request, git };
}

describe("hosted approved-model Foundation bridge", () => {
  it("uses the complete admitted inheritance without requiring every candidate claim to be approved", async () => {
    const f = await fixture();
    try {
      const result = await inspectHostedFoundation(f);
      expect(result.readiness).toBe("ready");
      expect(result.summary.claimCount).toBe(2);
      expect(
        result.canon.claims.find((claim) => claim.id === "CLAIM-INHERITED")?.verificationStatus,
      ).toBe("verified");
      expect(
        result.canon.claims.find((claim) => claim.id === "CLAIM-DELTA")?.verificationStatus,
      ).toBe("unverified");
      expect(result.evidenceLimitations).toContain(
        "approved-model-behavior-verification:CLAIM-INHERITED:not-checked",
      );
      expect(result.evidenceLimitations).toContain(
        "approved-model-claim-state:CLAIM-INHERITED:candidate",
      );
      // Inheritance is present, so the absence code must not appear.
      expect(result.evidenceLimitations).not.toContain(HOSTED_FOUNDATION_APPROVED_MODEL_ABSENT);
      expect(result.canon.authority).toBeNull();
      expect(result.canon.state).toBe("proposal");
      expect(f.git("status", "--porcelain")).toBe("");
    } finally {
      await f.workspace.dispose();
    }
  });
  it("runs without an admitted baseline and names the absence", async () => {
    // Identical custody with no approved model staged. Fail-open: model content
    // is missing, but nothing about custody failed.
    const f = await fixture(approvedModelFixture(), { stageApprovedModel: false });
    try {
      const result = await inspectHostedFoundation(f);
      expect(result.readiness).toBe("needs-input");
      expect(result.evidenceLimitations).toContain(HOSTED_FOUNDATION_APPROVED_MODEL_ABSENT);
      expect(result.canon.inputBinding.inputIds).toEqual([]);
      expect(result.canon.claims).toEqual([]);
    } finally {
      await f.workspace.dispose();
    }
  });
  it("refuses custody that names an approved model without its exact approved canon", async () => {
    // The baseline is staged, but custody approves a different canon than the
    // packet carries. Staged provenance binds one exact canon, so this custody
    // inconsistency fails closed rather than dropping inheritance.
    const f = await fixture(approvedModelFixture(), { approvedCanonSha256: "9".repeat(64) });
    try {
      await expect(inspectHostedFoundation(f)).rejects.toThrow(
        "names an approved model without its exact approved canon",
      );
    } finally {
      await f.workspace.dispose();
    }
  });
  it("preserves complete approved statements longer than the former 512-character label ceiling", async () => {
    const model = approvedModelFixture();
    const statement = "An approved product statement remains intact. ".repeat(20);
    model.baseline.snapshot.claims[0]!.record.statement = statement;
    model.baseline.snapshot.claims[0]!.recordSha256 = producerDigest(
      model.baseline.snapshot.claims[0]!.record,
    );
    reseal(model);
    const f = await fixture(model);
    try {
      const result = await inspectHostedFoundation(f);
      expect(result.readiness).toBe("ready");
      expect(
        result.canon.claims.find((claim) => claim.id === "CLAIM-INHERITED")?.statementSha256,
      ).toBe(createHash("sha256").update(statement).digest("hex"));
    } finally {
      await f.workspace.dispose();
    }
  });
  it("admits a claim label at foundation.claimLabelMaxChars and refuses one character more", async () => {
    const maxChars = limitDefinition(FOUNDATION_CLAIM_LABEL_MAX_CHARS_LIMIT).value;
    const f = await fixture();
    try {
      const proposal = (length: number) => ({
        id: "claim-bound",
        subjectLabel: "product",
        assertionLabel: "supports operators",
        statementLabel: "s".repeat(length),
        applicabilityLabel: "current version",
        evidenceIds: ["ev-1"],
        confidence: "high" as const,
        verificationStatus: "verified" as const,
      });
      const input = {
        repositoryPath: f.workspace.path,
        repositoryRevision: f.workspace.revision,
        inputBinding: { manifestSha256: "0".repeat(64), inputIds: ["input-1"] },
        registeredEvidence: [
          {
            id: "ev-1",
            inputId: "input-1",
            digestSha256: "1".repeat(64),
            strength: "authoritative" as const,
          },
        ],
      };
      const atLimit = await inspectFoundation({ ...input, claimProposals: [proposal(maxChars)] });
      expect(atLimit.canon.claims[0]?.statementSha256).toBe(
        createHash("sha256").update("s".repeat(maxChars)).digest("hex"),
      );
      await expect(
        inspectFoundation({ ...input, claimProposals: [proposal(maxChars + 1)] }),
      ).rejects.toThrow("Foundation inspection rejected: invalid-value.");
    } finally {
      await f.workspace.dispose();
    }
  });
  it("preserves source conflicts even when they cite source-thread claims outside Foundation canon", async () => {
    const model = approvedModelFixture();
    const record = {
      conflict_id: "CONFLICT-INPUTS",
      status: "open",
      source_variants: [
        { source_claim_ids: ["ITEM-A:claim"] },
        { source_claim_ids: ["ITEM-B:claim"] },
      ],
    };
    model.baseline.snapshot.openConflicts.push({
      id: record.conflict_id,
      record,
      recordSha256: producerDigest(record),
      sourcePath: model.baseline.snapshot.modelPath,
    });
    reseal(model);
    const f = await fixture(model);
    try {
      const result = await inspectHostedFoundation(f);
      expect(result.readiness).toBe("conflict");
      expect(result.summary.conflictCount).toBe(1);
      expect(result.conflicts).toEqual([
        { id: "CONFLICT-INPUTS", claimIds: ["ITEM-A:claim", "ITEM-B:claim"] },
      ]);
      expect(result.evidenceLimitations).toContain("unresolved-conflict:CONFLICT-INPUTS");
    } finally {
      await f.workspace.dispose();
    }
  });
  it("does not turn unknown intent and unchecked behavior into verified claims", async () => {
    const model = approvedModelFixture();
    model.baseline.snapshot.claims[0]!.record.intent_approval = "not-requested";
    model.baseline.snapshot.claims[0]!.recordSha256 = producerDigest(
      model.baseline.snapshot.claims[0]!.record,
    );
    reseal(model);
    const f = await fixture(model);
    try {
      expect((await inspectHostedFoundation(f)).readiness).toBe("needs-input");
    } finally {
      await f.workspace.dispose();
    }
  });
  it("refuses swapped private snapshot bytes even when canon itself is unchanged", async () => {
    const f = await fixture();
    try {
      const selected = f.request.nativeCustody!.approvedModel!;
      await writeFile(
        join(f.request.stateDirectory, "native-inputs", selected.contentSha256 + ".json"),
        "{}",
      );
      await expect(inspectHostedFoundation(f)).rejects.toThrow("native-custody-input-file");
    } finally {
      await f.workspace.dispose();
    }
  });
  it("retains the Foundation assembly read-only guard after sharing the inspector", async () => {
    const f = await fixture();
    try {
      expect(() =>
        assembleHostedFoundation({
          ...f,
          request: { ...f.request, allowWrite: true },
          artifactStore: {} as never,
        }),
      ).toThrow("bound read-only");
    } finally {
      await f.workspace.dispose();
    }
  });
  it("admits a staged-baseline reference at the byte capacity and refuses one byte more", () => {
    const reference = {
      contentSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64),
      snapshotSha256: "c".repeat(64),
      generation: 3,
      streamVersion: 7,
    };
    expect(
      parseHostRuntimeApprovedModelReference({
        ...reference,
        bytes: HOST_RUNTIME_APPROVED_MODEL_BASELINE_MAXIMUM_BYTES,
      }).bytes,
    ).toBe(HOST_RUNTIME_APPROVED_MODEL_BASELINE_MAXIMUM_BYTES);
    expect(() =>
      parseHostRuntimeApprovedModelReference({
        ...reference,
        bytes: HOST_RUNTIME_APPROVED_MODEL_BASELINE_MAXIMUM_BYTES + 1,
      }),
    ).toThrow("approved-model-binding");
  });
  it("verifies producer-sealed claim digests over lexicographic bytes, not numeric-first order", async () => {
    const model = approvedModelFixture();
    const claim = model.baseline.snapshot.claims[0]!;
    // A scope whose keys are integer-like. The Python projector admits any
    // non-empty string map here and the knowledge admission re-seals it
    // untouched, so this is a record the authority can already have approved.
    claim.record = { claim_id: "CLAIM-INHERITED", scope: { "10": "ten", "2": "two" } };
    // Golden bytes in the producers' format (`Object.keys(...).sort()` /
    // `sort_keys=True`, separators `,` and `:`), anchored to the producer rather
    // than either canonicalizer.
    const producerBytes = '{"claim_id":"CLAIM-INHERITED","scope":{"10":"ten","2":"two"}}';
    expect(producerCanonicalJson(claim.record)).toBe(producerBytes);
    claim.recordSha256 = createHash("sha256").update(producerBytes).digest("hex");
    // The runtime's canonicalization emits `{"2":..,"10":..}` for the same
    // record, so the two disagree.
    expect(canonicalDigest(claim.record)).not.toBe(claim.recordSha256);
    reseal(model);
    const decoded = parseHostRuntimeApprovedModelData({
      value: model.baseline,
      reference: describeModelFixture(model.baseline).reference,
      projectId: "project-a",
      canon: model.canon,
    });
    expect(decoded.claims[0]!.record.scope).toEqual({ "10": "ten", "2": "two" });
    // The same record sealed with the runtime's canonicalization is not a
    // producer seal, so the parser refuses it.
    claim.recordSha256 = canonicalDigest(claim.record);
    reseal(model);
    expect(() =>
      parseHostRuntimeApprovedModelData({
        value: model.baseline,
        reference: describeModelFixture(model.baseline).reference,
        projectId: "project-a",
        canon: model.canon,
      }),
    ).toThrow("approved-model-binding");
  });
  it("normalizes a decomposed approved statement instead of refusing it inside the worker", async () => {
    const decomposed = "Cafe\u0301 supports named project inputs.",
      composed = "Caf\u00e9 supports named project inputs.";
    expect(decomposed).not.toBe(composed);
    const project = async (statement: string) => {
      const model = approvedModelFixture();
      const claim = model.baseline.snapshot.claims[0]!;
      claim.record.statement = statement;
      claim.recordSha256 = producerDigest(claim.record);
      reseal(model);
      const f = await fixture(model);
      try {
        return await inspectHostedFoundation(f);
      } finally {
        await f.workspace.dispose();
      }
    };
    // Neither producer normalizes Unicode, so a decomposed statement is model
    // content the authority already approved: it must be carried, normalized,
    // not refused with a generic error inside the runtime worker.
    const nfd = await project(decomposed);
    expect(nfd.readiness).toBe("ready");
    expect(nfd.canon.claims.find((claim) => claim.id === "CLAIM-INHERITED")?.statementSha256).toBe(
      createHash("sha256").update(composed).digest("hex"),
    );
    // The composed statement reaches the identical digest.
    const nfc = await project(composed);
    expect(nfc.canon.claims.find((claim) => claim.id === "CLAIM-INHERITED")?.statementSha256).toBe(
      createHash("sha256").update(composed).digest("hex"),
    );
  });
  it("keeps the canon's own record for a retained conflict that repeats a minted id", async () => {
    const f = await fixture();
    try {
      const claim = (id: string) => ({
        id,
        subjectLabel: "product",
        assertionLabel: "supports operators",
        statementLabel: `statement ${id}`,
        applicabilityLabel: "current version",
        evidenceIds: ["ev-1"],
        confidence: "high" as const,
        verificationStatus: "verified" as const,
        conflictGroupId: "CONFLICT-SHARED",
      });
      const input = {
        repositoryPath: f.workspace.path,
        repositoryRevision: f.workspace.revision,
        inputBinding: { manifestSha256: "0".repeat(64), inputIds: ["input-1"] },
        registeredEvidence: [
          {
            id: "ev-1",
            inputId: "input-1",
            digestSha256: "1".repeat(64),
            strength: "authoritative" as const,
          },
        ],
        claimProposals: [claim("claim-a"), claim("claim-b")],
      };
      // The retained conflict repeats an id this canon already minted, so the
      // canon's own record wins and the citation is not doubled.
      const repeated = await inspectFoundation({
        ...input,
        sourceConflicts: [{ id: "CONFLICT-SHARED", claimIds: ["ITEM-OUTSIDE:claim"] }],
      });
      expect(repeated.conflicts).toEqual([
        { id: "CONFLICT-SHARED", claimIds: ["claim-a", "claim-b"] },
      ]);
      // A retained conflict the canon did not mint is carried in beside it with
      // its own outside citations.
      const distinct = await inspectFoundation({
        ...input,
        sourceConflicts: [{ id: "CONFLICT-RETAINED", claimIds: ["ITEM-OUTSIDE:claim"] }],
      });
      expect(distinct.conflicts).toEqual([
        { id: "CONFLICT-SHARED", claimIds: ["claim-a", "claim-b"] },
        { id: "CONFLICT-RETAINED", claimIds: ["ITEM-OUTSIDE:claim"] },
      ]);
    } finally {
      await f.workspace.dispose();
    }
  });
  it.each([
    "project",
    "generation",
    "claim",
    "closure",
    "path",
    "approval",
    "authority-model",
    "schema",
    "kind",
  ])("rejects mismatched %s provenance", (change) => {
    const model = approvedModelFixture();
    const original = describeModelFixture(model.baseline).reference;
    if (change === "project") model.baseline.projectId = "another-project";
    if (change === "generation") model.baseline.generation++;
    if (change === "claim") model.baseline.snapshot.claims[0]!.record.statement = "Tampered claim.";
    if (change === "closure") model.baseline.snapshot.sourceClosureSha256 = "1".repeat(64);
    if (change === "path")
      model.baseline.canon.sourcePath = ".docsfab/reference-model/shared/OTHER/v0.2/model.md";
    if (change === "approval") model.baseline.approval.snapshotSha256 = "2".repeat(64);
    // The approval binds the model digest as well as the snapshot digest: an
    // authority record that names a different model than the frozen canon is
    // not an approval of this canon, however well-formed its envelope is.
    if (change === "authority-model") model.baseline.approval.modelSha256 = "3".repeat(64);
    // Both are re-sealed below, so these two cases drive the declared schema
    // version and kind, not a digest.
    if (change === "schema") model.baseline.schemaVersion = 2;
    if (change === "kind") model.baseline.kind = "docsfab-approved-model-baseline-v2";
    // Re-hashing cannot authenticate altered bindings. Keep original custody
    // for project/generation; for others verify inner record/closure bindings too.
    const { baselineSha256: _old, ...body } = model.baseline;
    model.baseline.baselineSha256 = producerDigest(body);
    const reference = ["project", "generation"].includes(change)
      ? original
      : describeModelFixture(model.baseline).reference;
    expect(() =>
      parseHostRuntimeApprovedModelData({
        value: model.baseline,
        reference,
        projectId: "project-a",
        canon: model.canon,
      }),
    ).toThrow("approved-model-binding");
  });
});
