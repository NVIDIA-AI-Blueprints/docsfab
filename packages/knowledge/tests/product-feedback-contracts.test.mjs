// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { feedbackDigest, feedbackSeal, sealSourceVersion, parseSourceVersion } from "../src/product-feedback-contracts.mjs";
import { parseReferenceModelSnapshot, createApprovedModelAdmission, createApprovedModelReader, createFeedbackComparisonInput,
  createFeedbackChangeSetReference } from "../src/reference-model-snapshot.mjs";

const hash = value => feedbackDigest(value);
function snapshot(version = "v1.0", projectId = "sample-project") {
  const modelPath = `.docsfab/reference-model/shared/OTHER-PRODUCT/${version}/model.md`;
  const record = { claim_id: "CLM-EXAMPLE-001", statement: "Fixture intended behavior." };
  return feedbackSeal({ schemaVersion: 1, kind: "docsfab-reference-model-snapshot", projectId,
    modelId: "OTHER-PRODUCT", version, state: "candidate", revision: "a".repeat(40), tree: "b".repeat(40),
    modelPath, modelSha256: hash(version), modelGitObjectId: "c".repeat(40),
    files: [{ path: modelPath, sha256: hash(version) }], sourceClosureSha256: hash({}),
    claims: [{ id: record.claim_id, sourcePath: modelPath, record, recordSha256: hash(record) }], openConflicts: [],
  }, "snapshotSha256");
}
function rawCurrent(value = snapshot(), generation = 0) {
  return { projectId: value.projectId, generation, streamVersion: generation + 10, snapshot: value,
    canon: { sourcePath: value.modelPath, sha256: value.modelSha256, gitObjectId: value.modelGitObjectId },
    approvalEvidenceSha256: hash(`fixture-ledger-approval:${value.version}`) };
}
function fixtureApproval(request) {
  return { projectId: request.projectId, modelId: request.snapshot.modelId, version: request.snapshot.version, streamVersion: request.streamVersion,
    modelSha256: request.snapshot.modelSha256, snapshotSha256: request.snapshot.snapshotSha256,
    principalId: "fixture-owner", authorityReceiptSha256: hash("fixture-owner-authority"),
    approvalEvidenceSha256: request.approvalEvidenceSha256, scope: "model-version" };
}
function source(overrides = {}) {
  return sealSourceVersion({ projectId: "sample-project", sourceKind: "issue-body", sourceId: "issue-10",
    version: "observed-1", parentVersionSha256: null, contentSha256: hash("future proposal"),
    locator: `docsfab-source:${hash("future proposal")}`, author: { providerId: "actor-1", kind: "human" },
    editor: null, occurredAt: null, observedAt: "2026-09-17T00:00:00.000Z", assertion: "proposed-intent",
    evidenceSha256s: [], ...overrides });
}
const ref = value => ({sourceId:value.sourceId,sourceVersionSha256:value.sourceVersionSha256});
async function baseline(input = rawCurrent(), verifier = fixtureApproval) {
  return createApprovedModelReader({ loadCurrent: async () => input, verifyApproval: verifier }).readCurrent();
}

test("issue observations preserve unknown editors and cannot claim implemented or verified behavior", () => {
  const first = source();
  assert.equal(parseSourceVersion(first).editor, null);
  assert.equal(first.assertion, "proposed-intent");
  assert.throws(() => source({ assertion: "verified-behavior", evidenceSha256s: [hash("closed-issue")] }));
  assert.throws(() => source({ assertion: "observed-implementation" }));
  assert.throws(() => source({ sourceKind: "repository-content", assertion: "verified-behavior" }));
  assert.throws(() => source({ locator: "https://foreign.example/secret" }));
  assert.throws(() => parseSourceVersion({ ...first, editor: { providerId: "forged-editor", kind: "human" } }));
});

test("raw approval flags, copied baseline JSON, candidate frontmatter and publication hashes confer no approval", async () => {
  assert.throws(() => parseReferenceModelSnapshot({ ...snapshot(), state: "approved" }));
  await assert.rejects(baseline(rawCurrent(), async () => true));
  await assert.rejects(baseline(rawCurrent(), async () => ({ verified: true })));
  await assert.rejects(baseline(rawCurrent(), async () => ({ publicationReceiptSha256: hash("publication") })));
  const admitted = await baseline();
  assert.throws(() => createFeedbackComparisonInput({ baseline: JSON.parse(JSON.stringify(admitted)), sources: [], expectedSourceVersions: [] }));
  assert.equal(admitted.snapshot.state, "candidate"); // Approval is a distinct verified binding.
  assert.equal(admitted.approval.scope, "model-version");
});

test("the trusted verifier must bind exact model, source snapshot, principal authority and approval scope", async () => {
  for (const change of [
    { projectId: "foreign" }, { version: "v9.0" }, { streamVersion: 99 }, { modelSha256: hash("other") },
    { snapshotSha256: hash("other-source") }, { scope: "read-only-inspection" },
    { approvalEvidenceSha256: hash("wrong-approval") }, { principalId: "" }, { authorityReceiptSha256: "invalid" },
  ]) await assert.rejects(baseline(rawCurrent(), request => ({ ...fixtureApproval(request), ...change })));
  await assert.rejects(baseline(rawCurrent(), () => { throw Error("backend unavailable"); }));
});

test("current snapshot admission refuses canon and generation mismatch before invoking approval", async () => {
  let calls = 0;
  for (const change of [
    { generation: -1 }, { generation: 0.5 }, { streamVersion: -1 }, { projectId: "foreign" },
    { canon: { ...rawCurrent().canon, sha256: hash("old") } },
    { canon: { ...rawCurrent().canon, sourcePath: "other.md" } },
    { canon: { ...rawCurrent().canon, gitObjectId: "d".repeat(40) } },
  ]) await assert.rejects(baseline({ ...rawCurrent(), ...change }, () => { calls++; return null; }));
  assert.equal(calls, 0);
});

test("comparison carries explicit missing-source coverage and refuses foreign source data", async () => {
  const current = await baseline();
  const input = createFeedbackComparisonInput({ baseline: current, sources: [source()], expectedSourceVersions: [ref(source()), {sourceId:"merge-11",sourceVersionSha256:hash("missing-merge")}] });
  assert.equal(input.coverage.complete, false);
  assert.deepEqual(input.coverage.missingSourceVersions.map(value => value.sourceId), ["merge-11"]);
  assert.throws(() => createFeedbackChangeSetReference({ baseline: current, input, candidateSha256: hash("candidate") }));
  assert.throws(() => createFeedbackComparisonInput({ baseline: current, sources: [source({ projectId: "foreign" })], expectedSourceVersions: [ref(source())] }));
  assert.throws(() => createFeedbackComparisonInput({ baseline: current, sources: [source(), source()], expectedSourceVersions: [ref(source())] }));
  const older = source(), newer = source({ version: "observed-2", parentVersionSha256: older.sourceVersionSha256 });
  assert.throws(() => createFeedbackComparisonInput({ baseline: current, sources: [older], expectedSourceVersions: [ref(newer)] }));
  const both = createFeedbackComparisonInput({ baseline: current, sources: [older, newer], expectedSourceVersions: [ref(older), ref(newer)] });
  assert.equal(both.coverage.complete, true);
  assert.throws(() => createFeedbackComparisonInput({ baseline: current, sources: [], expectedSourceVersions: [] }));
  assert.throws(() => createFeedbackChangeSetReference({ baseline: current,
    input: JSON.parse(JSON.stringify(both)), candidateSha256: hash("candidate") }));
});

test("publication reference cannot advance baseline; the next admitted snapshot coherently changes model and canon", async () => {
  let active = rawCurrent();
  const authority = createApprovedModelReader({ loadCurrent: async () => active, verifyApproval: fixtureApproval });
  const first = await authority.readCurrent();
  const input = createFeedbackComparisonInput({ baseline: first, sources: [source()], expectedSourceVersions: [ref(source())] });
  const candidate = createFeedbackChangeSetReference({ baseline: first, input,
    candidateSha256: hash("candidate"), publicationReceiptSha256: hash("published") });
  assert.equal(candidate.modelApproved, false); assert.equal(candidate.baselinePromoted, false);
  assert.equal((await authority.readCurrent()).generation, 0);
  active = rawCurrent(snapshot("v1.1"), 1); // Explicit fixture authority promotion, not publication side effect.
  const next = await authority.readCurrent();
  const nextInput = createFeedbackComparisonInput({ baseline: next, sources: [source()], expectedSourceVersions: [ref(source())] });
  assert.equal(nextInput.baselineGeneration, 1);
  assert.equal(nextInput.modelSha256, nextInput.canonSha256);
  assert.notEqual(nextInput.modelSha256, input.modelSha256);
  assert.throws(() => createFeedbackChangeSetReference({ baseline: next, input, candidateSha256: hash("stale") }));
  assert.equal(first.generation, 0);
});

test("snapshot record corruption, duplicate IDs, unsafe paths and mixed projections refuse", () => {
  const original = snapshot();
  const reseal = change => { const { snapshotSha256, ...body } = { ...original, ...change }; return feedbackSeal(body, "snapshotSha256"); };
  assert.throws(() => parseReferenceModelSnapshot(reseal({ claims: [...original.claims, original.claims[0]] })));
  assert.throws(() => parseReferenceModelSnapshot(reseal({ modelPath: "../foreign.md" })));
  assert.throws(() => parseReferenceModelSnapshot(reseal({ modelSha256: hash("other") })));
  assert.throws(() => parseReferenceModelSnapshot(reseal({ claims: [{ ...original.claims[0], recordSha256: hash("wrong") }] })));
  assert.equal(parseReferenceModelSnapshot(original).modelId, "OTHER-PRODUCT");
});

test("a resumed original envelope needs verified historical admission and cannot manufacture currentness", async () => {
  const original = rawCurrent(), successor = rawCurrent(snapshot("v1.1"), 1);
  const protectedFixtureApprovals = new Map([original, successor].map(input => [hash(input), fixtureApproval(input)]));
  const verifyApproval = async request => {
    const binding = protectedFixtureApprovals.get(hash(request));
    if (!binding) throw Error("fixture authority has no matching approval");
    return binding;
  };
  let active = original;
  const reader = createApprovedModelReader({ loadCurrent: async () => active, verifyApproval });
  const initial = await reader.readCurrent();
  const persisted = JSON.parse(JSON.stringify(original));
  active = successor;
  const current = await reader.readCurrent();
  const admission = createApprovedModelAdmission({ verifyApproval });
  await assert.rejects(admission.admit(JSON.parse(JSON.stringify(initial))));
  await assert.rejects(admission.admit({ ...persisted, approvalEvidenceSha256: hash("altered-old-approval") }));
  await assert.rejects(admission.admit({ ...persisted, generation: current.generation }));
  const historical = await admission.admit(persisted);
  assert.equal(historical.baselineSha256, initial.baselineSha256);
  const resumed = createFeedbackComparisonInput({ baseline: historical, sources: [source()], expectedSourceVersions: [ref(source())] });
  assert.equal(resumed.baselineGeneration, 0);
  assert.throws(() => createFeedbackChangeSetReference({ baseline: current, input: resumed, candidateSha256: hash("stale-candidate") }));
  assert.equal((await reader.readCurrent()).baselineSha256, current.baselineSha256);
});
