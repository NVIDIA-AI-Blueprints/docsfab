// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  digest,
  parseHostRuntimeNativeCustody,
  parseHostRuntimeRequest,
  loadHostRuntimeNativeCustodyInput,
  describeHostRuntimeNativeInput,
  sealHostRuntimeComposition,
  sealHostRuntimeNativeCustody,
  sealHostRuntimeNativeTask,
} from "../src/host-invoker/contracts.js";

import { HOSTED_INPUT_CAPACITY } from "../src/live-agent/input-capacity.js";

const binding = { deploymentId: "native-test", projectId: "project-a", deploymentEpoch: "epoch-a" };
const repositoryIdentitySha256 = "a".repeat(64),
  receiptSha256 = "b".repeat(64);
const receiptLocator = `cas:${digest(binding).slice(0, 32)}:${receiptSha256}`;
const bytes = Buffer.from('{"kind":"native-fixture","text":"説明"}');
const contentSha256 = createHash("sha256").update(bytes).digest("hex");
const selected = {
  recordKey: "c".repeat(64),
  contentSha256,
  bytes,
  source: {
    requestKey: "source-one",
    runId: "source-run",
    principalId: "source-person",
    workflow: "foundation",
    revision: "d".repeat(40),
    repositoryIdentitySha256,
    receiptLocator,
    receiptSha256,
  },
};
const task = sealHostRuntimeNativeTask({
  workflow: "foundation",
  task: { kind: "foundation" },
  inputs: [{ receiptLocator, artifactSha256: contentSha256 }],
});

function custody() {
  return sealHostRuntimeNativeCustody({
    approvedCanonSha256: "e".repeat(64),
    task,
    binding,
    repositoryIdentitySha256,
    inputs: [describeHostRuntimeNativeInput(selected)],
  });
}
function request() {
  const content = "{}",
    contentDigest = createHash("sha256").update(content).digest("hex");
  const workflow = "foundation",
    stepIds = ["inspect-foundation"],
    declaredTools = ["find", "grep", "ls", "read"];
  const composition = sealHostRuntimeComposition({
    compositionId: "test",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools,
  });
  const capsule = {
    receiptSha256: "e".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [],
  };
  return {
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    ...binding,
    requestKey: "current-one",
    origin: { principalId: "source-person", requestId: "current-message" },
    runId: "current-run",
    fence: 1,
    workflow,
    revision: "d".repeat(40),
    sourceTreeObjectId: "f".repeat(40),
    packet: {
      packetFingerprintSha256: "f".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: contentDigest,
        sourcePathSha256: "e".repeat(64),
        gitObjectId: "f".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
      nativeTask: task,
    },
    nativeCustody: custody(),
    stepIds,
    composition,
    toolPolicySha256: digest({ workflow, stepIds, declaredTools }),
    workspacePath: "/srv/workspace",
    stateDirectory: "/srv/state",
    capsule: { ...capsule, sha256: digest(capsule) },
    allowWrite: false,
  };
}

describe("host-resolved native custody wire", () => {
  it("preserves selected UTF-8 files and producing-run provenance without carrying content in JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-input-wire-"));
    try {
      const directory = join(root, "native-inputs");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, contentSha256 + ".json"), bytes, { mode: 0o600 });
      const serialized = JSON.stringify(custody());
      expect(serialized).not.toContain("説明");
      const restored = await loadHostRuntimeNativeCustodyInput(
        JSON.parse(serialized),
        task,
        task.inputs[0]!,
        root,
      );
      expect(Buffer.from(restored.bytes)).toEqual(bytes);
      expect(restored.source.runId).toBe("source-run");
      expect(restored.source.principalId).toBe("source-person");
      expect(parseHostRuntimeRequest(request()).nativeCustody?.nativeTaskSha256).toBe(
        task.taskSha256,
      );
      await writeFile(join(directory, contentSha256 + ".json"), Buffer.alloc(bytes.length));
      await expect(
        loadHostRuntimeNativeCustodyInput(custody(), task, task.inputs[0]!, root),
      ).rejects.toThrow(/input-changed/);
      await rm(join(directory, contentSha256 + ".json"));
      await symlink(join(root, "elsewhere"), join(directory, contentSha256 + ".json"));
      // Not a named contract refusal: `O_RDONLY | O_NOFOLLOW` makes the kernel
      // refuse the final symlink component before `fail("input-file")` can run,
      // so the assertion names the errno the open actually produces.
      await expect(
        loadHostRuntimeNativeCustodyInput(custody(), task, task.inputs[0]!, root),
      ).rejects.toMatchObject({ code: "ELOOP" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses missing, extra or altered selected bytes even with a newly sealed outer body", () => {
    // Positive control: the same seal with the task's exact single input.
    expect(custody().nativeTaskSha256).toBe(task.taskSha256);
    expect(() =>
      sealHostRuntimeNativeCustody({
        approvedCanonSha256: "e".repeat(64),
        task,
        binding,
        repositoryIdentitySha256,
        inputs: [],
      }),
    ).toThrow("native-custody-task-input-binding");
    expect(() =>
      sealHostRuntimeNativeCustody({
        approvedCanonSha256: "e".repeat(64),
        task,
        binding,
        repositoryIdentitySha256,
        inputs: [
          describeHostRuntimeNativeInput(selected),
          describeHostRuntimeNativeInput(selected),
        ],
      }),
    ).toThrow("native-custody-task-input-binding");
    expect(() =>
      sealHostRuntimeNativeCustody({
        approvedCanonSha256: "e".repeat(64),
        task,
        binding,
        repositoryIdentitySha256,
        inputs: [describeHostRuntimeNativeInput({ ...selected, bytes: Buffer.from("changed") })],
      }),
    ).toThrow("native-custody-content-digest");
    // The generic contract-kit seal check, not a bespoke custody code.
    expect(() =>
      parseHostRuntimeNativeCustody({ ...custody(), custodySha256: "0".repeat(64) }, task),
    ).toThrow("native-custody-digest-mismatch");
  });

  it("keeps custody without an approved model parsing while admitting the optional key", () => {
    // Custody without the optional `approvedModel` key keeps its digest and
    // shape.
    const without = custody();
    expect(without).not.toHaveProperty("approvedModel");
    expect(parseHostRuntimeNativeCustody(JSON.parse(JSON.stringify(without)), task)).toEqual(
      without,
    );
    // The same seal with the optional key present admits it and carries the
    // reference through the digest.
    const approvedModel = {
      contentSha256: "1".repeat(64),
      bytes: 512,
      baselineSha256: "2".repeat(64),
      snapshotSha256: "3".repeat(64),
      generation: 3,
      streamVersion: 7,
    };
    const withModel = sealHostRuntimeNativeCustody({
      approvedCanonSha256: "e".repeat(64),
      task,
      binding,
      repositoryIdentitySha256,
      approvedModel,
      inputs: [describeHostRuntimeNativeInput(selected)],
    });
    expect(withModel.approvedModel).toEqual(approvedModel);
    expect(withModel.custodySha256).not.toBe(without.custodySha256);
    expect(
      parseHostRuntimeNativeCustody(JSON.parse(JSON.stringify(withModel)), task).approvedModel,
    ).toEqual(approvedModel);
    // An unknown key is still an invalid shape, not a second optional.
    expect(() =>
      parseHostRuntimeNativeCustody({ ...without, approvedImport: approvedModel }, task),
    ).toThrow("native-custody-invalid-shape");
  });

  it("binds a registered approval import to the site workflow and its own receipt", () => {
    // A `site-bootstrap` task selects the approval-ledger row by the ledger
    // receipt the host wrote, not the producing job's receipt.
    const importReceiptSha256 = "9".repeat(64);
    const importLocator = `cas:${digest(binding).slice(0, 32)}:${importReceiptSha256}`;
    const approvedImport = {
      kind: "site-bootstrap-approval" as const,
      receiptLocator: importLocator,
      receiptSha256: importReceiptSha256,
      authorityReceiptSha256: "8".repeat(64),
      reviewerPolicySha256: "7".repeat(64),
      reviewerPolicyContentSha256: "6".repeat(64),
      reviewerPolicyBytes: 317,
    };
    const siteTask = sealHostRuntimeNativeTask({
      workflow: "site-bootstrap",
      task: {
        kind: "site-bootstrap",
        plan: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: "5".repeat(64),
          repositoryRevision: "d".repeat(40),
          repositoryContentDigest: "4".repeat(64),
        },
      },
      inputs: [{ receiptLocator: importLocator, artifactSha256: contentSha256 }],
    });
    const seal = (proof: Record<string, unknown> | undefined, forTask = siteTask) =>
      sealHostRuntimeNativeCustody({
        approvedCanonSha256: "e".repeat(64),
        task: forTask,
        binding,
        repositoryIdentitySha256,
        inputs: [
          describeHostRuntimeNativeInput({
            ...selected,
            source: { ...selected.source, workflow: "ia-plan" },
            ...(proof ? { approvedImport: proof as typeof approvedImport } : {}),
          }),
        ],
      });
    const sealed = seal(approvedImport);
    expect(sealed.inputs[0]?.approvedImport).toEqual(approvedImport);
    expect(parseHostRuntimeNativeCustody(JSON.parse(JSON.stringify(sealed)), siteTask)).toEqual(
      sealed,
    );
    // Each disjunct of the proof guard, one at a time, against the same row.
    for (const [name, override] of [
      ["another approval kind", { kind: "other-approval" }],
      [
        "a locator from another deployment",
        { receiptLocator: `cas:${"f".repeat(32)}:${importReceiptSha256}` },
      ],
      [
        "a locator naming another receipt",
        { receiptLocator: `cas:${digest(binding).slice(0, 32)}:${"a".repeat(64)}` },
      ],
      ["an empty registered policy", { reviewerPolicyBytes: 0 }],
      ["a fractional policy size", { reviewerPolicyBytes: 1.5 }],
    ] as const) {
      expect(() => seal({ ...approvedImport, ...override }), name).toThrow(
        "native-custody-approved-import-binding",
      );
    }
    // The same proof on a `foundation` task, which selects by the producer
    // receipt, matches nothing the task named.
    expect(() => seal(approvedImport, task)).toThrow("native-custody-task-input-binding");
    // A `foundation` task that names the ledger locator itself matches the key,
    // so only the workflow clause can refuse the approval-ledger row.
    const foundationOnLedger = sealHostRuntimeNativeTask({
      workflow: "foundation",
      task: { kind: "foundation" },
      inputs: [{ receiptLocator: importLocator, artifactSha256: contentSha256 }],
    });
    expect(() => seal(approvedImport, foundationOnLedger)).toThrow(
      "native-custody-task-input-binding",
    );
    // A row without the proof keeps the producer selection key and digest: an
    // absent optional does not become a null key.
    const plain = seal(undefined, task);
    expect(plain.inputs[0]).not.toHaveProperty("approvedImport");
    expect(canonicalJson(plain.inputs[0]!)).toBe(
      canonicalJson({
        ...describeHostRuntimeNativeInput(selected),
        source: { ...selected.source, workflow: "ia-plan" },
      }),
    );
  });

  it("refuses foreign repository or receipt namespace claims", () => {
    // Positive control: the matching repository identity and receipt namespace
    // seal.
    expect(custody().inputs[0]?.source.receiptLocator).toBe(receiptLocator);
    expect(() =>
      sealHostRuntimeNativeCustody({
        approvedCanonSha256: "e".repeat(64),
        task,
        binding,
        repositoryIdentitySha256: "0".repeat(64),
        inputs: [describeHostRuntimeNativeInput(selected)],
      }),
    ).toThrow("native-custody-repository-binding");
    expect(() =>
      sealHostRuntimeNativeCustody({
        approvedCanonSha256: "e".repeat(64),
        task,
        binding: { ...binding, projectId: "project-b" },
        repositoryIdentitySha256,
        inputs: [describeHostRuntimeNativeInput(selected)],
      }),
    ).toThrow("native-custody-receipt-binding");
    expect(() =>
      sealHostRuntimeNativeCustody({
        approvedCanonSha256: "e".repeat(64),
        task,
        binding,
        repositoryIdentitySha256,
        inputs: [
          describeHostRuntimeNativeInput({
            ...selected,
            source: { ...selected.source, receiptSha256: "0".repeat(64) },
          }),
        ],
      }),
    ).toThrow("native-custody-receipt-binding");
  });

  it("requires matching protected custody for a typed task while preserving legacy absence", () => {
    const full = request();
    // Positive control: the complete typed request admits and carries both.
    expect(parseHostRuntimeRequest(full).packet.nativeTask?.taskSha256).toBe(task.taskSha256);
    const { nativeCustody: _custody, ...withoutCustody } = full;
    expect(() => parseHostRuntimeRequest(withoutCustody)).toThrow(/native-custody-required/);
    expect(() => parseHostRuntimeRequest({ ...full, projectId: "project-b" })).toThrow(
      /native-custody-project-binding/,
    );
    expect(() =>
      parseHostRuntimeRequest({ ...full, origin: { ...full.origin, principalId: "other-member" } }),
    ).toThrow(/native-custody-actor-binding/);
    expect(() => parseHostRuntimeRequest({ ...full, workflow: "ia-plan" })).toThrow(
      /native-task-workflow-binding/,
    );
    const { nativeTask: _task, ...packet } = full.packet;
    const legacy = parseHostRuntimeRequest({ ...withoutCustody, packet });
    expect(legacy).not.toHaveProperty("nativeCustody");
    expect(legacy.packet).not.toHaveProperty("nativeTask");
    // Custody present without a task is refused by the same check.
    expect(() => parseHostRuntimeRequest({ ...full, packet })).toThrow(/native-custody-required/);
  });

  // The typed task's canonical bytes count into the frozen-input slot budget
  // like every other packet member: admitted at the ceiling, refused one byte
  // over it.
  it.each([0, 1])(
    "counts the typed native task into the frozen-input capacity at the ceiling plus %s",
    (excess) => {
      const capacity = HOSTED_INPUT_CAPACITY.ordinaryFrozenInputsBytes;
      const manifestBytes = HOSTED_INPUT_CAPACITY.ordinaryFrozenInputBytes;
      const taskBytes = Buffer.byteLength(canonicalJson(task));
      const canonBytes = capacity - manifestBytes - taskBytes + excess;
      expect(canonBytes).toBeGreaterThan(0);
      expect(canonBytes).toBeLessThanOrEqual(manifestBytes);
      const frozen = (kind: "input-manifest" | "canon", size: number) => {
        const content = "a".repeat(size);
        return {
          kind,
          sha256: createHash("sha256").update(content).digest("hex"),
          sourcePathSha256: "e".repeat(64),
          gitObjectId: "f".repeat(40),
          content,
        };
      };
      const full = request();
      const wire = {
        ...full,
        packet: {
          ...full.packet,
          inputManifest: frozen("input-manifest", manifestBytes),
          canon: frozen("canon", canonBytes),
        },
      };
      if (excess === 0)
        expect(parseHostRuntimeRequest(wire).packet.nativeTask?.taskSha256).toBe(task.taskSha256);
      else expect(() => parseHostRuntimeRequest(wire)).toThrow(/frozen-input-size/);
    },
  );
});
