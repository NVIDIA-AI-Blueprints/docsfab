// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Approval is admitted by a trusted host port, never inferred from repository data. */
import { createHash } from "node:crypto";
import {
  feedbackCopy, feedbackDigest, feedbackFreeze, feedbackHash, feedbackId, feedbackKeys,
  feedbackRequire as need, feedbackSeal, feedbackVerify, parseSourceVersion,
} from "./product-feedback-contracts.mjs";

const admitted = new WeakSet();
const comparisons = new WeakSet();
const gitId = value => need(typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value));
function path(value) {
  need(typeof value === "string" && value.length > 0 && !value.startsWith("/") && !/[\\\0\r\n]/u.test(value));
  need(value.split("/").every(part => part && part !== "." && part !== ".."));
}

export function parseReferenceModelSnapshot(value) {
  const input = feedbackCopy(value);
  feedbackKeys(input, ["schemaVersion", "kind", "projectId", "modelId", "version", "state", "revision", "tree",
    "modelPath", "modelSha256", "modelGitObjectId", "files", "sourceClosureSha256", "claims", "openConflicts", "snapshotSha256"]);
  feedbackVerify(input, "snapshotSha256");
  need(input.schemaVersion === 1 && input.kind === "docsfab-reference-model-snapshot" && input.state === "candidate");
  feedbackId(input.projectId); feedbackId(input.modelId); need(/^v\d+\.\d+$/u.test(input.version));
  gitId(input.revision); gitId(input.tree); gitId(input.modelGitObjectId);
  path(input.modelPath); feedbackHash(input.modelSha256); feedbackHash(input.sourceClosureSha256);
  need(input.modelPath === `.docsfab/reference-model/shared/${input.modelId}/${input.version}/model.md`);
  need(Array.isArray(input.files) && input.files.length > 0);
  for (const file of input.files) { feedbackKeys(file, ["path", "sha256"]); path(file.path); feedbackHash(file.sha256); }
  need(new Set(input.files.map(file => file.path)).size === input.files.length);
  need(input.files.some(file => file.path === input.modelPath && file.sha256 === input.modelSha256));
  const sourceFiles = Object.fromEntries(input.files.filter(file => file.path.startsWith(".docsfab/reference-model/source-threads/"))
    .map(file => [file.path, file.sha256]));
  need(feedbackDigest(sourceFiles) === input.sourceClosureSha256);
  for (const [name, idField] of [["claims", "claim_id"], ["openConflicts", "conflict_id"]]) {
    need(Array.isArray(input[name]));
    const ids = new Set();
    for (const entry of input[name]) {
      feedbackKeys(entry, ["id", "sourcePath", "record", "recordSha256"]);
      feedbackId(entry.id); need(!ids.has(entry.id)); ids.add(entry.id);
      path(entry.sourcePath); need(input.files.some(file => file.path === entry.sourcePath));
      feedbackHash(entry.recordSha256); need(feedbackDigest(entry.record) === entry.recordSha256);
      need(entry.record[idField] === entry.id);
      if (name === "openConflicts") need(entry.record.status === "open");
    }
  }
  need(input.claims.length > 0);
  return feedbackFreeze(input);
}

/**
 * Only trusted composition supplies these ports. verifyApproval must verify the
 * snapshot's custody and approval evidence against its authority backend and
 * return the exact admitted binding below; a digest is not proof, and there is
 * no JSON "verified" flag or approve-by-frontmatter path. Serialized output is
 * not a bearer grant and must be re-admitted after restart. For historical
 * envelopes the verifier also authenticates the persisted generation/model/canon
 * association.
 */
export function createApprovedModelAdmission({ verifyApproval }) {
  need(typeof verifyApproval === "function");
  return Object.freeze({
    async admit(loaded) {
      const input = feedbackCopy(loaded);
      feedbackKeys(input, ["projectId", "generation", "streamVersion", "snapshot", "canon", "approvalEvidenceSha256"]);
      feedbackId(input.projectId); need(Number.isSafeInteger(input.generation) && input.generation >= 0);
      need(Number.isSafeInteger(input.streamVersion) && input.streamVersion >= 0);
      feedbackHash(input.approvalEvidenceSha256);
      const snapshot = parseReferenceModelSnapshot(input.snapshot);
      need(snapshot.projectId === input.projectId);
      feedbackKeys(input.canon, ["sha256", "sourcePath", "gitObjectId"]);
      need(input.canon.sha256 === snapshot.modelSha256 && input.canon.sourcePath === snapshot.modelPath &&
        input.canon.gitObjectId === snapshot.modelGitObjectId);
      const request = feedbackFreeze({ projectId: input.projectId, generation: input.generation, streamVersion: input.streamVersion, snapshot,
        canon: input.canon, approvalEvidenceSha256: input.approvalEvidenceSha256 });
      let verified;
      try { verified = await verifyApproval(request); } catch { throw new Error("product-feedback: approval verification failed"); }
      const approval = feedbackCopy(verified);
      feedbackKeys(approval, ["projectId", "modelId", "version", "modelSha256", "snapshotSha256",
        "streamVersion", "principalId", "authorityReceiptSha256", "approvalEvidenceSha256", "scope"]);
      need(approval.projectId === snapshot.projectId && approval.modelId === snapshot.modelId &&
        approval.version === snapshot.version && approval.modelSha256 === snapshot.modelSha256 &&
        approval.snapshotSha256 === snapshot.snapshotSha256 &&
        approval.streamVersion === input.streamVersion &&
        approval.approvalEvidenceSha256 === input.approvalEvidenceSha256 && approval.scope === "model-version");
      feedbackId(approval.principalId); feedbackHash(approval.authorityReceiptSha256);
      const result = feedbackSeal({ schemaVersion: 1, kind: "docsfab-approved-model-baseline",
        projectId: input.projectId, generation: input.generation, streamVersion: input.streamVersion, snapshot, canon: input.canon,
        approval }, "baselineSha256");
      admitted.add(result);
      return result;
    },
  });
}

/** Currentness comes from the trusted loader, not from historical approval admission. */
export function createApprovedModelReader({ loadCurrent, verifyApproval }) {
  need(typeof loadCurrent === "function");
  const admission = createApprovedModelAdmission({ verifyApproval });
  return Object.freeze({
    async readCurrent() {
      let loaded;
      try { loaded = await loadCurrent(); } catch { throw new Error("product-feedback: current baseline unavailable"); }
      return admission.admit(loaded);
    },
  });
}

export function createFeedbackComparisonInput({ baseline, sources, expectedSourceVersions }) {
  need(admitted.has(baseline));
  need(Array.isArray(sources) && Array.isArray(expectedSourceVersions) && expectedSourceVersions.length > 0);
  const sourceVersions = sources.map(parseSourceVersion);
  need(sourceVersions.every(source => source.projectId === baseline.projectId));
  for (const source of expectedSourceVersions) {
    feedbackKeys(source, ["sourceId", "sourceVersionSha256"]); feedbackId(source.sourceId); feedbackHash(source.sourceVersionSha256);
  }
  need(new Set(expectedSourceVersions.map(source => source.sourceVersionSha256)).size === expectedSourceVersions.length);
  const observed = sourceVersions.map(source => source.sourceVersionSha256);
  need(new Set(observed).size === observed.length && sourceVersions.every(source => expectedSourceVersions.some(expected =>
    expected.sourceId === source.sourceId && expected.sourceVersionSha256 === source.sourceVersionSha256)));
  const byDigest = (a, b) => a.sourceVersionSha256.localeCompare(b.sourceVersionSha256);
  const missingSourceVersions = expectedSourceVersions.filter(source => !observed.includes(source.sourceVersionSha256)).sort(byDigest);
  const result = feedbackSeal({ schemaVersion: 1, kind: "docsfab-product-feedback-comparison-input",
    projectId: baseline.projectId, baselineSha256: baseline.baselineSha256, baselineGeneration: baseline.generation,
    modelSha256: baseline.snapshot.modelSha256, modelStreamVersion: baseline.streamVersion, canonSha256: baseline.canon.sha256,
    sourceVersions, coverage: { expectedSourceVersions: [...expectedSourceVersions].sort(byDigest), missingSourceVersions,
      complete: missingSourceVersions.length === 0 } }, "inputSha256");
  comparisons.add(result);
  return result;
}

/** Bind bytes supplied by the host's existing Git/frozen-input content port. */
export function verifyApprovedModelContent(baseline, input) {
  need(admitted.has(baseline));
  feedbackKeys(input, ["content", "sourcePath", "gitObjectId"]);
  need(typeof input.content === "string" && input.sourcePath === baseline.canon.sourcePath &&
    input.gitObjectId === baseline.canon.gitObjectId);
  const sha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
  need(sha256 === baseline.canon.sha256);
  return feedbackFreeze({ ...feedbackCopy(input), sha256 });
}

export function createFeedbackChangeSetReference({ baseline, input, candidateSha256, publicationReceiptSha256 = null }) {
  need(admitted.has(baseline) && comparisons.has(input)); feedbackVerify(input, "inputSha256");
  need(input.kind === "docsfab-product-feedback-comparison-input" && input.projectId === baseline.projectId &&
    input.baselineSha256 === baseline.baselineSha256 && input.baselineGeneration === baseline.generation &&
    input.coverage.complete === true && input.coverage.missingSourceVersions.length === 0);
  feedbackHash(candidateSha256);
  if (publicationReceiptSha256 !== null) feedbackHash(publicationReceiptSha256);
  return feedbackSeal({ schemaVersion: 1, kind: "docsfab-feedback-change-set-reference",
    projectId: baseline.projectId, expectedBaselineGeneration: baseline.generation,
    baselineSha256: baseline.baselineSha256, inputSha256: input.inputSha256, candidateSha256,
    publicationReceiptSha256, status: "candidate", modelApproved: false, baselinePromoted: false }, "changeSetSha256");
}
