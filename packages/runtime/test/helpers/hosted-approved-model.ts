// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Synthetic authority boundary; real snapshot hashes, inherited claims and file custody. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostRuntimeApprovedModelReferenceV1 } from "../../src/host-invoker/approved-model.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Canonical JSON as the approved-model producers emit it: byte-identical to the
 * knowledge admission's `feedbackJson`
 * (`packages/knowledge/src/product-feedback-contracts.mjs`) and to the model
 * projector's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
 *
 * Not the runtime's content-IR canonicalization: rebuilding an object re-orders
 * integer-like keys numerically, so the fixture would mirror the parser, not the
 * producer's bytes. `hosted-foundation-model.test.ts` and
 * `packages/host/test/native-approved-model.test.ts` anchor it to the producers.
 */
export function producerCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(producerCanonicalJson).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("approved-model fixture: value no producer could canonicalize");
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${producerCanonicalJson(row[key])}`)
    .join(",")}}`;
}
export const producerDigest = (value: unknown) => sha(producerCanonicalJson(value));
const seal = <T extends Record<string, unknown>>(value: T, field: string) => ({
  ...value,
  [field]: producerDigest(value),
});
export function approvedModelFixture(options: { projectId?: string } = {}) {
  // The staging producer binds the baseline to the dispatching project, so a
  // host fixture whose policy names another project must say so here.
  const projectId = options.projectId ?? "project-a";
  const sourcePath = ".docsfab/reference-model/shared/EXAMPLE/v0.2/model.md";
  const priorPath = ".docsfab/reference-model/shared/EXAMPLE/v0.1/model.md";
  const content =
    "# Example v0.2\n\n```yaml\nmodel_id: EXAMPLE\nmodel_version: v0.2\nprior_model_version: v0.1\napproval_state: candidate\n```\n\nInherited claims remain in v0.1.\n";
  const canon = {
    kind: "canon" as const,
    sha256: sha(content),
    content,
    sourcePathSha256: sha(sourcePath),
    gitObjectId: createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest("hex"),
  };
  // Loosely typed on purpose: cases drive producer-admitted record shapes the
  // fixture's own literals do not name, such as integer-like scope keys.
  const records: Record<string, unknown>[] = [
    {
      claim_id: "CLAIM-INHERITED",
      statement: "The documented tool supports named project inputs.",
      scope: { component: "input selection" },
      source_claims: ["ITEM-INPUTS"],
      exact_evidence: ["Explicit fixture owner statement"],
      action: "included",
      behavior_verification: "not-checked",
      intent_approval: "approved",
      model_state: "candidate",
    },
    {
      claim_id: "CLAIM-DELTA",
      statement: "Additional behavior remains under investigation.",
      scope: { component: "delta" },
      source_claims: ["ITEM-DELTA"],
      exact_evidence: ["Explicit fixture proposal"],
      action: "added",
      behavior_verification: "not-checked",
      intent_approval: "not-requested",
      model_state: "candidate",
    },
  ];
  const snapshot = seal(
    {
      schemaVersion: 1,
      kind: "docsfab-reference-model-snapshot",
      projectId,
      modelId: "EXAMPLE",
      version: "v0.2",
      state: "candidate",
      revision: "b".repeat(40),
      tree: "c".repeat(40),
      modelPath: sourcePath,
      modelSha256: canon.sha256,
      modelGitObjectId: canon.gitObjectId,
      files: [
        { path: sourcePath, sha256: canon.sha256 },
        { path: priorPath, sha256: sha("retained previous model") },
      ],
      sourceClosureSha256: producerDigest({}),
      claims: records.map((record, index) => ({
        id: record.claim_id as string,
        sourcePath: index ? sourcePath : priorPath,
        record,
        recordSha256: producerDigest(record),
      })),
      openConflicts: [] as {
        id: string;
        sourcePath: string;
        record: Record<string, unknown>;
        recordSha256: string;
      }[],
    },
    "snapshotSha256",
  );
  const baseline = seal(
    {
      schemaVersion: 1,
      kind: "docsfab-approved-model-baseline",
      projectId,
      generation: 3,
      streamVersion: 7,
      snapshot,
      canon: { sha256: canon.sha256, sourcePath, gitObjectId: canon.gitObjectId },
      approval: {
        projectId,
        modelId: "EXAMPLE",
        version: "v0.2",
        streamVersion: 7,
        modelSha256: canon.sha256,
        snapshotSha256: snapshot.snapshotSha256,
        principalId: "fixture-owner",
        authorityReceiptSha256: "d".repeat(64),
        approvalEvidenceSha256: "e".repeat(64),
        scope: "model-version",
      },
    },
    "baselineSha256",
  );
  return { canon, baseline };
}
export function describeModelFixture(baseline: Record<string, unknown>) {
  const bytes = Buffer.from(JSON.stringify(baseline));
  const reference: HostRuntimeApprovedModelReferenceV1 = {
    contentSha256: sha(bytes.toString("utf8")),
    bytes: bytes.length,
    baselineSha256: baseline.baselineSha256 as string,
    snapshotSha256: (baseline.snapshot as Record<string, unknown>).snapshotSha256 as string,
    generation: baseline.generation as number,
    streamVersion: baseline.streamVersion as number,
  };
  return { bytes, reference };
}
export async function stageModelFixture(
  stateDirectory: string,
  baseline = approvedModelFixture().baseline,
) {
  const { bytes, reference } = describeModelFixture(baseline);
  await mkdir(join(stateDirectory, "native-inputs"), { recursive: true, mode: 0o700 });
  await writeFile(join(stateDirectory, "native-inputs", reference.contentSha256 + ".json"), bytes, {
    mode: 0o600,
  });
  return reference;
}
