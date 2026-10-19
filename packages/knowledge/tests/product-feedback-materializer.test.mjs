// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { materializeProductFeedbackCandidate as materialize, verifyProductFeedbackCandidate as verify,
  parseProductFeedbackCandidateManifest as parseManifest, encodeProductFeedbackFile, assertProductFeedbackTargetRoutes,
  productFeedbackTargetRoutePolicySha256,
  PRODUCT_FEEDBACK_MODEL_MARKER, PRODUCT_REFERENCE_MODEL_TARGET_ID as PACKAGE,
  requiredProductFeedbackBasePaths } from "../src/product-feedback-materializer.mjs";
import { feedbackDigest, feedbackSeal } from "../src/product-feedback-contracts.mjs";
import { materializerFixture, mergeMaterializerFixture, recordOnlyInput, verificationInput, withDecision } from "./fixtures/product-feedback-materialization.mjs";

const refused = { message: "product-feedback: invalid binding" };
const history = ".docsfab/reference-model/shared/EXAMPLE/history.md", modelIndex = ".docsfab/reference-model/README.md";
const envelope = text => JSON.parse(/^```json\n([^\n]+)\n```$/mu.exec(text)[1]);
function versionFiles(output) {
  const directory = output.manifest.model.path.slice(0, -"/model.md".length);
  return { directory, model: output.changedFiles[`${directory}/model.md`], report: output.changedFiles[`${directory}/inconsistency-report.md`],
    receipt: output.changedFiles[`${directory}/merge-receipt.md`] };
}
const registrationItem = output => /ITEM-FEEDBACK-[a-f0-9]{32}/u.exec(Object.keys(output.changedFiles).find(path => path.includes("/items/")))[0];
const reseal = value => { const { candidateManifestSha256: _old, ...body } = value; return feedbackSeal(body, "candidateManifestSha256"); };
function section(text, number) {
  const start = text.indexOf(`\n## ${number}. `), next = text.indexOf(`\n## ${number + 1}. `, start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

test("substantive model and configured document sections change; all unaffected bytes and fields remain exact", () => {
  const input = materializerFixture(), output = materialize(input);
  assert.equal(output.outcome, "model-and-document-candidate"); assert.equal(output.modelApproved, false);
  assert.equal(output.requiresOwnerApproval, false); assert.equal(output.manifest.requestedSuccessorGeneration, 1);
  const before = input.baseline.snapshot.claims[0].record, after = output.expectedClaims[0].record;
  assert.deepEqual(after, { ...before, ...input.recipe.proposal.delta.changes[0].after });
  assert.deepEqual(output.expectedClaims[1], input.baseline.snapshot.claims[1]);
  for (const file of input.baseline.snapshot.files) assert.equal(output.files[file.path], input.files[file.path]);
  assert.ok(output.files[output.manifest.model.path].startsWith(PRODUCT_FEEDBACK_MODEL_MARKER));
  assert.ok(!output.files[output.manifest.model.path].includes("MERGE-"));
  for (const target of input.recipe.targets) {
    const content = output.files[target.path];
    assert.ok(content.includes(after.statement)); assert.ok(!content.includes("Old contradictory requirement"));
    assert.ok(content.startsWith(input.files[target.path].split("## Mention Requirement")[0]));
    assert.ok(content.endsWith("## Unaffected Details\n\nRetain this exact paragraph and punctuation.\n"));
    assert.ok(content.includes("This separate exception within the same section remains unchanged.\n\n### Related Limit\n\nPreserve this unrelated subsection.\n"));
    // v4 writes the claim's statement as prose, with where in the model it comes from, in one region.
    assert.ok(content.includes(`${after.statement}\n\n_Model claim \`CLAIM-MENTION\` in \`EXAMPLE\` v0.2. Scope: surface: configured-pilot-channel._\n`));
    assert.equal(content.split("<!-- docsfab:claim:CLAIM-MENTION:start -->").length - 1, 1);
    assert.ok(!content.includes("Shipped behavior is not established"));
  }
  // A retained v3 candidate still reproduces its own templated section.
  const v3 = materialize({ ...input, materializerVersion: "docsfab-product-feedback-materializer.v3" });
  for (const target of input.recipe.targets) {
    assert.ok(v3.files[target.path].includes("Shipped behavior is not established"));
    assert.ok(v3.files[target.path].includes("closure does not establish implementation"));
  }
  verify(verificationInput(input, v3));
  assert.deepEqual(materialize(input), output, "identical replay does not read the clock or allocate new identifiers");
  const proof = verify(verificationInput(input, output));
  assert.equal(proof.expectedClaims.length, 2); assert.match(proof.reproductionSha256, /^[a-f0-9]{64}$/u);
  const routes = input.recipe.targets.map(({ baseSha256, ...route }) => route);
  assertProductFeedbackTargetRoutes({ manifest: output.manifest, routes });
  const altered = structuredClone(output.manifest); altered.recipe.targets[0].beforeText = "An unrelated paragraph.";
  assert.throws(() => assertProductFeedbackTargetRoutes({ manifest: altered, routes }));
});

test("model-case accepted, keep-approved, unapproved, record-only and PRM-only bytes preserve the reviewed v2 checkpoint under v2 reproduction", () => {
  const V2 = "docsfab-product-feedback-materializer.v2";
  const cases = [
    [materializerFixture(), "bcac89734075431b582b200fd1d0d0bf408ccd977a4017f5139b76305d9475f1"],
    [withDecision(materializerFixture(), "keep-approved"), "6f2b85f2ef0f6cf7e7cbde2a32c73fe528585ae5080d454b71592b42a61c4e1f"],
    [{ ...materializerFixture(), decision: null }, "d0e4181c0cc2ce62110604eea70083bafbdf9c5b925382d9d949cd92c266d9b2"],
    [recordOnlyInput(materializerFixture()), "eeba26a3e8cfc5a5a581211f38414de4d373d310214694589b353cedd7fcf9b2"],
    [materializerFixture({ targets: [], projectionTargets: [PACKAGE] }), "0bd9d2aa8b449297e1487c452d150b429907f85c8a09743f2a26fba69355c106"],
  ];
  // A retained v2 candidate must still reproduce byte for byte, so it can be verified and promoted.
  for (const [input, sha256] of cases) {
    assert.equal(createHash("sha256").update(JSON.stringify(materialize({ ...input, materializerVersion: V2 }))).digest("hex"), sha256);
  }
});

test("v3 and v4 change no claim, path or disposition of a model-case, keep-approved, unapproved, record-only or PRM-only candidate", () => {
  for (const input of [materializerFixture(), withDecision(materializerFixture(), "keep-approved"), { ...materializerFixture(), decision: null },
    recordOnlyInput(materializerFixture()), materializerFixture({ targets: [], projectionTargets: [PACKAGE] })])
  for (const legacyVersion of ["docsfab-product-feedback-materializer.v2", "docsfab-product-feedback-materializer.v3"]) {
    const current = materialize(input), legacy = materialize({ ...input, materializerVersion: legacyVersion });
    assert.equal(current.manifest.materializerVersion, "docsfab-product-feedback-materializer.v4");
    assert.equal(legacy.manifest.materializerVersion, legacyVersion);
    assert.deepEqual(current.expectedClaims, legacy.expectedClaims);
    assert.deepEqual(Object.keys(current.files).sort(), Object.keys(legacy.files).sort());
    assert.equal(current.manifest.disposition, legacy.manifest.disposition);
    assert.notEqual(current.manifest.candidateManifestSha256, legacy.manifest.candidateManifestSha256, "the version is part of the manifest");
    if (!legacy.requiresOwnerApproval) {
      // Verification reproduces each retained manifest under its own version, and only that one.
      verify(verificationInput(input, legacy)); verify(verificationInput(input, current));
      const relabelled = reseal({ ...structuredClone(legacy.manifest), materializerVersion: current.manifest.materializerVersion });
      assert.throws(() => verify({ ...verificationInput(input, legacy), manifest: relabelled }), refused);
    }
  }
  assert.throws(() => materialize({ ...materializerFixture(), materializerVersion: "docsfab-product-feedback-materializer.v1" }), refused);
});

function resealManifest(value) {
  const seal = (record, field) => { const { [field]: old, ...body } = record; return feedbackSeal(body, field); };
  value.recipe.sourceVersions = value.recipe.sourceVersions.map(source => seal(source, "sourceVersionSha256"));
  value.recipe.proposal.delta.evidenceSourceVersionSha256s = value.recipe.sourceVersions.map(source => source.sourceVersionSha256).sort();
  value.recipe.proposal.delta = seal(value.recipe.proposal.delta, "deltaSha256");
  value.recipe.proposal.target.scope.semanticDeltaSha256 = value.recipe.proposal.delta.deltaSha256;
  value.recipe.proposal.target.scope.evidenceSourceVersionSha256s = value.recipe.proposal.delta.evidenceSourceVersionSha256s;
  value.recipe.proposal.target = seal(value.recipe.proposal.target, "targetSha256");
  value.approvalTargetSha256 = value.recipe.proposal.target.targetSha256;
  value.recipeSha256 = feedbackDigest({ baselineSha256: value.baselineSha256, recipe: value.recipe,
    decisionSourceRegistrationSha256: value.decisionRegistrationSha256, disposition: value.disposition });
  return seal(value, "candidateManifestSha256");
}

test("closed manifest parser accepts produced records without asserting approval, currentness or reproduction", () => {
  for (const input of [materializerFixture(), { ...materializerFixture(), decision: null },
    withDecision(materializerFixture(), "keep-approved"), withDecision(materializerFixture({ streamVersion: 0 }), "keep-approved"),
    mergeMaterializerFixture().input, mergeMaterializerFixture(true).input, materializerFixture({ targets: [], projectionTargets: [PACKAGE] }),
    materializerFixture({ targets: ["target-0"], projectionTargets: [PACKAGE, "target-0"] }), recordOnlyInput(materializerFixture())]) {
    const output = materialize(input), parsed = parseManifest(output.manifest);
    assert.deepEqual(parsed, output.manifest); assert.ok(Object.isFrozen(parsed.recipe.sourceVersions[0]));
    assert.equal(parsed.modelState, "candidate"); assert.equal(parsed.publicationReceiptSha256, null);
  }
  const input = materializerFixture(), output = materialize(input), edited = structuredClone(output.manifest);
  edited.recipe.metadata.title = "GRANT access only after an explicit owner decision.";
  const shaped = resealManifest(edited);
  assert.equal(parseManifest(shaped).recipe.metadata.title, edited.recipe.metadata.title, "ordinary policy prose is not an operational grant");
  assert.throws(() => verify({ ...verificationInput(input, output), manifest: shaped }), "closed data alone cannot reproduce different actual bytes");
});

test("recomputed hashes do not admit unknown nested fields, malformed source records, foreign paths or changed manifest invariants", () => {
  for (const mutate of [
    value => { value.approved = true; },
    value => { value.model.current = true; },
    value => { value.recipe.executed = true; },
    value => { value.recipe.comparison.verified = true; },
    value => { value.recipe.proposal.published = true; },
    value => { value.recipe.proposal.target.scope.approved = true; },
    value => { value.recipe.proposal.delta.approvalReceiptSha256 = "0".repeat(64); },
    value => { value.recipe.metadata.credentials = "unused"; },
    value => { value.recipe.targets[0].command = "unused"; },
    value => { value.recipe.proposal.delta.changes[0].after.approved = true; },
    value => { value.recipe.proposal.delta.changes[0].after.scope.surface = { unexpected: true }; },
    value => { value.recipe.sourceVersions[0].author.extra = "unknown"; },
    value => { value.recipe.sourceVersions[0].author.kind = "administrator"; },
    value => { value.recipe.sourceVersions[0].sourceKind = "unknown-source"; },
    value => { value.recipe.sourceVersions[0].locator = "/private/source.json"; },
    value => { value.recipe.targets[0].path = "../outside.md"; },
    value => { value.binding = { ...value.binding, projectId: "foreign-project" }; },
    value => { value.targetRoutePolicySha256 = "0".repeat(64); },
    value => { value.requiredCandidatePaths.push("docs/unknown.md"); value.requiredCandidatePaths.sort(); },
    value => { value.requiredAbsentBasePaths.push(value.requiredBasePaths[0]); value.requiredAbsentBasePaths.sort(); },
    value => { value.generatedFiles[0].authority = true; },
    value => { value.model.gitObjectId = "invalid-object-id"; },
    value => { value.model.path = "/etc/docsfab/model.json"; },
    value => { value.model.version = "v99.0"; },
    value => { value.requestedSuccessorGeneration += 1; },
    value => { value.semanticEvidence = true; },
    value => { value.publicationReceiptSha256 = "1".repeat(64); },
    value => { value.decisionRegistrationSha256 = null; },
  ]) {
    const value = structuredClone(materialize(materializerFixture()).manifest); mutate(value);
    assert.throws(() => parseManifest(resealManifest(value)));
  }
});

test("manifest parser rejects raw credential/key material and accessors before inspecting untrusted values", () => {
  for (const secret of [["glpat", "syntheticcredentialmaterial123456"].join("-"),
    ["github_pat", "syntheticcredentialmaterial123456"].join("_"),
    "Authorization: private-fixture-material", "-----BEGIN PRIVATE KEY-----"]) {
    const value = structuredClone(materialize(materializerFixture()).manifest); value.recipe.metadata.title = secret;
    assert.throws(() => parseManifest(resealManifest(value)));
  }
  const value = structuredClone(materialize(materializerFixture()).manifest); let reads = 0;
  Object.defineProperty(value.recipe.metadata, "title", { get() { reads++; return "hidden"; }, enumerable: true });
  assert.throws(() => parseManifest(value)); assert.equal(reads, 0);
  assert.throws(() => parseManifest(new Proxy({}, { ownKeys() { throw new Error("PRIVATE_SENTINEL"); } })),
    error => !error.message.includes("PRIVATE_SENTINEL"));
});

test("missing or wrong-scope owner evidence yields a reviewable candidate but no promotion proof", () => {
  const input = materializerFixture(); input.decision = null;
  const output = materialize(input); assert.equal(output.requiresOwnerApproval, true);
  assert.equal(output.modelApproved, false); assert.ok(output.files[output.manifest.model.path].includes("candidate"));
  assert.throws(() => verify(verificationInput(input, output)));
  const wrong = materializerFixture();
  const { registrationSha256: _old, ...body } = wrong.decision.source;
  wrong.decision.source = feedbackSeal({ ...body, approvalTargetSha256: "f".repeat(64) }, "registrationSha256");
  assert.equal(materialize(wrong).requiresOwnerApproval, true);
});

test("keep-approved writes a new version that keeps the approved claim, keeps the corrective proposal and verifies", () => {
  const input = withDecision(materializerFixture(), "keep-approved"), output = materialize(input);
  const before = input.baseline.snapshot.claims[0];
  assert.equal(output.outcome, "corrective-implementation-proposal"); assert.equal(output.manifest.disposition, "keep-approved");
  assert.equal(output.manifest.model.path, ".docsfab/reference-model/shared/EXAMPLE/v0.2/model.md", "keep-approved writes a new version directory");
  assert.deepEqual(envelope(output.changedFiles[output.manifest.model.path]).change,
    { claimId: before.id, beforeClaimRecordSha256: before.recordSha256, record: before.record });
  assert.equal(output.manifest.requestedSuccessorGeneration, 1);
  assert.deepEqual(output.expectedClaims[0], { id: before.id, sourcePath: output.manifest.model.path, record: before.record, recordSha256: before.recordSha256 });
  const proposal = Object.entries(output.changedFiles).find(([path]) => path.includes("/proposals/"));
  assert.equal(JSON.parse(proposal[1]).implementationVerification, "not-established");
  assert.ok(output.manifest.requiredAbsentBasePaths.includes(proposal[0]));
  // The projection states the approved claim the decision keeps; a retained v3 candidate keeps its own sentence.
  assert.ok(output.files[input.recipe.targets[0].path].includes(`${before.record.statement}\n\n_Model claim`));
  assert.ok(materialize({ ...input, materializerVersion: "docsfab-product-feedback-materializer.v3" })
    .files[input.recipe.targets[0].path].includes("The approved requirement remains unchanged."));
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
});

test("a PRM-only decision writes one complete version inside the package and no document", () => {
  const input = materializerFixture({ targets: [], projectionTargets: [PACKAGE] }), output = materialize(input);
  assert.equal(output.manifest.disposition, "matching-owner-decision"); assert.equal(output.requiresOwnerApproval, false);
  assert.deepEqual(output.manifest.recipe.targets, []);
  const changed = Object.keys(output.changedFiles), { directory } = versionFiles(output);
  assert.deepEqual(changed.filter(path => !path.startsWith(".docsfab/reference-model/")), [], "a PRM-only decision edits no document");
  for (const path of [`${directory}/model.md`, `${directory}/inconsistency-report.md`, `${directory}/merge-receipt.md`, history, modelIndex]) {
    assert.ok(changed.includes(path), path);
  }
  assert.match(section(versionFiles(output).receipt, 9), /No documentation target was written/u);
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
});

test("the package id is never a document route, and a route-free recipe needs the package alone in its approval scope", () => {
  const documentScope = materializerFixture({ targets: [], projectionTargets: ["target-0"] });
  assert.throws(() => materialize(documentScope), refused);
  const reservedRoute = materializerFixture({ targets: ["target-0"], projectionTargets: [PACKAGE, "target-0"] });
  reservedRoute.recipe.targets[0].targetId = PACKAGE;
  assert.throws(() => materialize(reservedRoute), refused);
});

test("a partial projection writes exactly the updated documents; an approval scope naming unwritten documents is refused", () => {
  const input = materializerFixture({ targets: ["target-0"], projectionTargets: [PACKAGE, "target-0"] }), output = materialize(input);
  assert.deepEqual(Object.keys(output.changedFiles).filter(path => !path.startsWith(".docsfab/")), ["planning/product-requirements.md"]);
  assert.ok(output.changedFiles["planning/product-requirements.md"].includes(output.expectedClaims[0].record.statement));
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
  for (const projectionTargets of [["target-0", "target-1", "target-2", "target-3"], [PACKAGE, "target-0", "target-1"]]) {
    assert.throws(() => materialize(materializerFixture({ targets: ["target-0"], projectionTargets })), refused, projectionTargets.join());
  }
});

test("adjudication records cite custody and bindings, never the reply, and carry the ancestor's section 14 byte for byte", () => {
  const ancestor = materializerFixture().files[".docsfab/reference-model/shared/EXAMPLE/v0.1/merge-receipt.md"];
  const block = ancestor.slice(ancestor.indexOf("```yaml visual-closure-receipt"), ancestor.lastIndexOf("```") + 3);
  const merge = mergeMaterializerFixture().input;
  for (const [label, input, conflict] of [
    ["replace", materializerFixture(), /CONFLICT-FEEDBACK-[a-f0-9]{32}/u],
    ["keep-approved", withDecision(materializerFixture(), "keep-approved"), /CONFLICT-FEEDBACK-[a-f0-9]{32}/u],
    ["merge", merge, new RegExp(`CONFLICT-${merge.decision.question.conflictId.replace(/^conflict-/u, "")}`, "u")],
  ]) {
    const output = materialize(input), { report, receipt } = versionFiles(output), item = registrationItem(output);
    const decision = input.decision, claimId = input.recipe.proposal.delta.changes[0].claimId, conflictId = conflict.exec(report)?.[0];
    assert.ok(conflictId, `${label}: conflict id`);
    assert.match(report, new RegExp(`^conflict_id: ${conflictId}$`, "mu"), label);
    assert.match(report, /^status: resolved$/mu, label); assert.match(report, /^ {2}disposition: accept-variant$/mu, label);
    assert.ok(report.includes(`  decision_evidence: ["${item}"]`) && report.includes(`  resulting_claim_ids: ["${claimId}"]`), label);
    assert.ok(report.includes(`Protected decision custody ${decision.custody.custodySha256}; the original reply is not reproduced.`), label);
    assert.ok(section(receipt, 13).includes(conflictId) && section(receipt, 13).includes("inconsistency-report.md"), label);
    for (const text of [decision.answer.decision?.rationale, "rawMessage"].filter(Boolean)) {
      assert.ok(!report.includes(text) && !receipt.includes(text), `${label}: ${text}`);
    }
    if (label === "merge") assert.match(section(receipt, 14), /retains no legacy merge receipt/u);
    else assert.ok(section(receipt, 14).endsWith(`${block}\n`), `${label}: section 14 carries the ancestor block`);
  }
  assert.equal(merge.decision.answer.decision.rationale, "Confirm the exact pilot scope.", "the fixture retains a reply rationale to keep out");
});

/** Replace or add a retained snapshot file and reseal the snapshot, baseline and recipe binding. */
function withSnapshotFile(source, path, content) {
  const input = structuredClone(source);
  input.files[path] = content;
  const entry = { path, sha256: createHash("sha256").update(content).digest("hex") };
  input.baseline.snapshot.files = [...input.baseline.snapshot.files.filter(file => file.path !== path), entry].sort((a, b) => a.path < b.path ? -1 : 1);
  const { snapshotSha256: _snapshot, ...snapshot } = input.baseline.snapshot;
  input.baseline.snapshot = feedbackSeal(snapshot, "snapshotSha256");
  input.baseline.approval.snapshotSha256 = input.baseline.snapshot.snapshotSha256;
  const { baselineSha256: _baseline, ...baseline } = input.baseline;
  input.baseline = feedbackSeal(baseline, "baselineSha256");
  input.recipe.comparison.baselineSha256 = input.baseline.baselineSha256;
  input.decision = null;
  return input;
}

test("section 14 carries only the top-level receipt block, never a fenced or commented example, from exactly one legacy receipt", () => {
  const source = materializerFixture(), path = ".docsfab/reference-model/shared/EXAMPLE/v0.1/merge-receipt.md", original = source.files[path];
  for (const decoy of ["````text\n## 14. Governed Visual Closure\n\n```yaml visual-closure-receipt\nschema_version: decoy\n```\n````\n\n",
    "<!--\n## 14. Governed Visual Closure\n\n```yaml visual-closure-receipt\nschema_version: decoy\n```\n-->\n\n"]) {
    const carried = section(versionFiles(materialize(withSnapshotFile(source, path, original.replace("## 13.", `${decoy}## 13.`)))).receipt, 14);
    assert.ok(!carried.includes("schema_version: decoy") && carried.includes("visual_id: EXAMPLE-DIAGRAM-01"), decoy.slice(0, 8));
  }
  const second = withSnapshotFile(source, ".docsfab/reference-model/shared/EXAMPLE/v0.0/merge-receipt.md", original);
  assert.throws(() => materialize(second), refused, "two legacy receipts leave the ancestor ambiguous");
});

test("record-only: a consistent input writes a publishable version with unchanged claims and no decision", () => {
  const input = recordOnlyInput(materializerFixture()), output = materialize(input), { model, report, receipt } = versionFiles(output);
  assert.equal(output.manifest.disposition, "record-only"); assert.equal(output.outcome, "record-only-candidate");
  assert.equal(output.requiresOwnerApproval, false); assert.equal(output.manifest.requestedSuccessorGeneration, 1);
  assert.equal(output.manifest.decisionRegistrationSha256, null); assert.equal(output.manifest.approvalTargetSha256, null);
  assert.equal(envelope(model).change, null); assert.ok(!model.includes("\n## "), "no claim section is rendered");
  assert.deepEqual(output.expectedClaims, input.baseline.snapshot.claims);
  assert.match(report, /^No inconsistencies were found between this input and the approved model\./mu);
  assert.doesNotMatch(report, /^## CONFLICT-/mu); assert.doesNotMatch(report, /^adjudication:/mu);
  assert.match(section(receipt, 13), /the report states that no inconsistencies were found/u);
  assert.deepEqual(Object.keys(output.changedFiles).filter(path => !path.startsWith(".docsfab/reference-model/")), []);
  const thread = JSON.parse(Object.entries(output.changedFiles).find(([path]) => path.endsWith("/thread.json"))[1]);
  const item = JSON.parse(Object.entries(output.changedFiles).find(([path]) => path.includes("/items/"))[1]);
  assert.equal(thread.origin.kind, "repository-issue"); assert.equal(item.artifact_type, "source-observation");
  assert.deepEqual(parseManifest(output.manifest), output.manifest);
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
  const merged = recordOnlyInput(mergeMaterializerFixture().input), mergedOutput = materialize(merged);
  const mergedThread = JSON.parse(Object.entries(mergedOutput.changedFiles).find(([path]) => path.endsWith("/thread.json"))[1]);
  assert.equal(mergedThread.origin.kind, "repository-merge", "a merged repository input is observed as a repository merge");
});

test("record-only refuses a decision, routes or missing sources; a claim change without a decision stays unpublishable", () => {
  const base = recordOnlyInput(materializerFixture());
  assert.throws(() => materialize({ ...base, decision: materializerFixture().decision }), refused);
  const routed = structuredClone(base), route = materializerFixture().recipe.targets[0];
  routed.recipe.targets = [route]; routed.files[route.path] = materializerFixture().files[route.path];
  assert.throws(() => materialize(routed), refused);
  for (const sourceVersions of [[], [base.recipe.sourceVersions[0], base.recipe.sourceVersions[0]]]) {
    assert.throws(() => materialize({ ...base, recipe: { ...base.recipe, sourceVersions } }), refused, `${sourceVersions.length} sources`);
  }
  const changed = { ...materializerFixture(), decision: null }, output = materialize(changed), { report } = versionFiles(output);
  assert.equal(output.manifest.disposition, "unapproved"); assert.equal(output.requiresOwnerApproval, true);
  assert.match(report, /^status: open$/mu); assert.match(report, /^ {2}disposition: none$/mu);
  assert.throws(() => verify(verificationInput(changed, output)), refused);
  const claimed = structuredClone(output.manifest); claimed.disposition = "record-only";
  claimed.recipeSha256 = feedbackDigest({ baselineSha256: claimed.baselineSha256, recipe: claimed.recipe,
    decisionSourceRegistrationSha256: null, disposition: "record-only" });
  assert.throws(() => parseManifest(reseal(claimed)), refused, "a manifest carrying a proposal cannot claim record-only");
});

test("the history row and index pointer name the new version first; an unrecognized package index is refused", () => {
  const input = materializerFixture(), output = materialize(input);
  const rows = output.changedFiles[history].split("\n").filter(row => /^\| \[?v\d+\.\d+/u.test(row));
  assert.match(rows[0], /^\| \[v0\.2\]\(v0\.2\/model\.md\) \| 2026-09-17 \| Candidate \| `v0\.1`, `ITEM-FEEDBACK-[a-f0-9]{32}` \| /u);
  assert.match(rows[1], /^\| \[v0\.1\]/u);
  const readme = output.changedFiles[modelIndex];
  for (const link of ["- [Current product model: v0.2](shared/EXAMPLE/v0.2/model.md)", "- [v0.2 inconsistency report](shared/EXAMPLE/v0.2/inconsistency-report.md)",
    "- [v0.2 merge receipt](shared/EXAMPLE/v0.2/merge-receipt.md)"]) assert.ok(readme.includes(`${link}\n`), link);
  assert.ok(!readme.includes("v0.1/") && readme.endsWith("Unchanged closing prose.\n"));
  assert.deepEqual(output.manifest.requiredBasePaths, requiredProductFeedbackBasePaths({ baseline: input.baseline, recipe: input.recipe }));
  for (const [path, edit, label] of [
    [history, text => text.replace(/^\| \[v0\.1\].*\n/mu, ""), "history without the parent"],
    [history, text => text.replace("| --- | --- | --- | --- | --- |\n", "| --- | --- | --- | --- | --- |\n| [v0.2](v0.2/model.md) | x | y | z | w |\n"), "history already listing the successor"],
    [history, text => text.replace("| --- | --- | --- | --- | --- |\n", "| --- | --- |\n"), "history without the table header"],
    [modelIndex, text => text.replace(/^- \[Current product model.*\n/mu, ""), "index without the current-model link"],
    [modelIndex, text => text.replace(/^- \[v0\.1 merge receipt.*\n/mu, "$&$&"), "index with a duplicated link"],
  ]) {
    const edited = structuredClone(input); edited.files[path] = edit(edited.files[path]);
    assert.throws(() => materialize(edited), refused, label);
  }
  const missing = structuredClone(input); delete missing.files[history];
  assert.throws(() => materialize(missing), refused, "the history index is a required base file");
});

test("the manifest parser refuses v1 manifests and any write set missing the history row, index pointer, report or receipt", () => {
  const output = materialize(materializerFixture()), { directory } = versionFiles(output);
  assert.equal(output.manifest.materializerVersion, "docsfab-product-feedback-materializer.v4");
  assert.deepEqual(parseManifest(output.manifest), output.manifest);
  const v1 = structuredClone(output.manifest); v1.materializerVersion = "docsfab-product-feedback-materializer.v1";
  assert.throws(() => parseManifest(reseal(v1)), refused);
  for (const path of [history, modelIndex]) {
    const value = structuredClone(output.manifest); value.generatedFiles = value.generatedFiles.filter(file => file.path !== path);
    assert.throws(() => parseManifest(reseal(value)), refused, path);
  }
  for (const path of [`${directory}/inconsistency-report.md`, `${directory}/merge-receipt.md`]) {
    const value = structuredClone(output.manifest);
    value.generatedFiles = value.generatedFiles.filter(file => file.path !== path);
    value.requiredAbsentBasePaths = value.requiredAbsentBasePaths.filter(name => name !== path);
    value.requiredCandidatePaths = value.requiredCandidatePaths.filter(name => name !== path);
    assert.throws(() => parseManifest(reseal(value)), refused, path);
  }
});

test("byte reproduction rejects unrelated prose, source, metadata and absent-path substitution", () => {
  const input = materializerFixture(), output = materialize(input);
  for (const path of [input.recipe.targets[0].path, input.baseline.snapshot.modelPath,
    output.manifest.generatedFiles.find(file => file.path.includes("/thread.json")).path, output.manifest.model.path]) {
    const changed = structuredClone(verificationInput(input, output)); changed.files.candidate[path] += "\nUnreviewed prose.\n";
    assert.throws(() => verify(changed), path);
  }
  const occupied = structuredClone(verificationInput(input, output));
  occupied.files.base[output.manifest.model.path] = "An existing immutable candidate.";
  assert.throws(() => verify(occupied));
  const extra = structuredClone(verificationInput(input, output)); extra.files.candidate["docs/unexpected.md"] = "Unexpected";
  assert.throws(() => verify(extra));
  const altered = structuredClone(input); altered.recipe.comparison.currentness = "superseded";
  assert.throws(() => materialize(altered));
  const foreign = structuredClone(input); foreign.recipe.binding.projectId = "foreign";
  assert.throws(() => materialize(foreign));
});

test("binary retained artifacts round-trip byte-exactly and malformed base64 refuses", () => {
  const input = structuredClone(materializerFixture());
  const imagePath = ".docsfab/reference-model/source-threads/SRC-EXAMPLE/artifacts/image.bin";
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
  input.files[imagePath] = encodeProductFeedbackFile(image);
  input.baseline.snapshot.files.push({ path: imagePath, sha256: createHash("sha256").update(image).digest("hex") });
  const sourceMap = Object.fromEntries(input.baseline.snapshot.files.filter(file => file.path.includes("/source-threads/")).map(file => [file.path, file.sha256]));
  input.baseline.snapshot.sourceClosureSha256 = feedbackDigest(sourceMap);
  const { snapshotSha256: _snapshot, ...snapshot } = input.baseline.snapshot;
  input.baseline.snapshot = feedbackSeal(snapshot, "snapshotSha256");
  input.baseline.approval.snapshotSha256 = input.baseline.snapshot.snapshotSha256;
  const { baselineSha256: _baseline, ...baseline } = input.baseline;
  input.baseline = feedbackSeal(baseline, "baselineSha256");
  input.recipe.comparison.baselineSha256 = input.baseline.baselineSha256;
  input.recipe.comparison.sourceClosureSha256 = input.baseline.snapshot.sourceClosureSha256;
  input.decision = null;
  const output = materialize(input);
  assert.deepEqual(output.files[imagePath], input.files[imagePath]);
  assert.deepEqual(Buffer.from(output.files[imagePath].data, "base64"), image);
  input.files[imagePath] = { encoding: "base64", data: "not canonical ==" };
  assert.throws(() => materialize(input));
});

test("a v4 model-written placement reads an inline comment opener as text and replaces its line in place (CodeRabbit)", () => {
  const input = materializerFixture({ targets: ["target-0"], projectionTargets: [PACKAGE, "target-0"] });
  const target = input.recipe.targets[0];
  const document = input.files[target.path].replace("## Mention Requirement\n\n", "## Mention Requirement\n\nWrite `<!--` to open a comment.\n\n");
  input.files[target.path] = document;
  target.baseSha256 = createHash("sha256").update(document).digest("hex");
  input.recipe.targetRoutePolicySha256 = productFeedbackTargetRoutePolicySha256(input.recipe.targets.map(({ baseSha256: _b, ...rest }) => rest));
  const output = materialize(input), projected = output.files[target.path];
  assert.ok(!projected.includes("Old contradictory requirement"), "the placement line is replaced");
  assert.ok(!projected.includes("## Product reference model decisions"), "no fallback to the generated section");
  assert.ok(projected.includes("Write `<!--` to open a comment.\n\n<!-- docsfab:claim:CLAIM-MENTION:start -->\n"));
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
});

test("rejects accessors without invocation and refuses misleading section selectors", () => {
  let reads = 0; const input = materializerFixture();
  Object.defineProperty(input, "recipe", { get() { reads++; throw new Error("private"); } });
  assert.throws(() => materialize(input)); assert.equal(reads, 0);
  assert.throws(() => materialize(new Proxy(materializerFixture(), { ownKeys() { throw new Error("PRIVATE_CANARY"); } })),
    error => !error.message.includes("PRIVATE_CANARY"));
  for (const prefix of ["```markdown\n", "<!--\n"]) {
    const candidate = structuredClone(materializerFixture()), target = candidate.recipe.targets[0];
    const wrapped = candidate.files[target.path] = prefix + candidate.files[target.path] + (prefix.startsWith("```") ? "```\n" : "-->\n");
    target.baseSha256 = createHash("sha256").update(candidate.files[target.path]).digest("hex");
    // v3 refuses a selector it can only find inside a fence or comment.
    assert.throws(() => materialize({ ...candidate, materializerVersion: "docsfab-product-feedback-materializer.v3" }));
    // v4 never edits inside one either, and never stalls the decision: the claim goes to the generated section instead.
    const projected = materialize(candidate).files[target.path];
    assert.ok(projected.startsWith(wrapped), prefix);
    assert.ok(projected.slice(wrapped.length).startsWith("\n## Product reference model decisions\n"), prefix);
  }
});

test("genuine merge fixture reproduces substantive candidates using original continuation and source identities", () => {
  const { input, provenance } = mergeMaterializerFixture(), output = materialize(input);
  assert.equal(provenance.kind, "synthetic-authority-fixture");
  assert.equal(input.decision.kind, "docsfab-verified-merge-decision-source");
  assert.equal(Object.hasOwn(input.decision, "case"), false);
  assert.equal(output.requiresOwnerApproval, false); assert.equal(output.modelApproved, false);
  assert.equal(output.expectedClaims[0].record.statement, input.recipe.proposal.delta.changes[0].after.statement);
  for (const file of input.baseline.snapshot.files) assert.equal(output.files[file.path], input.files[file.path]);
  assert.ok(output.files[input.recipe.targets[0].path].endsWith("Preserve this unrelated paragraph.\n"));
  assert.deepEqual(materialize(input), output);
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
  const artifact = Object.entries(output.changedFiles).find(([path]) => path.includes("/artifacts/sha256/"));
  const evidence = JSON.parse(artifact[1]);
  assert.equal(evidence.rawMessageIncluded, false);
  assert.equal(evidence.decision.sourceKind, "genuine-merge-decision");
  assert.equal(evidence.decision.reconciliationId, input.decision.continuation.reconciliationId);
  assert.equal(evidence.decision.continuationAnchorSha256, input.decision.continuation.anchor.anchorSha256);
  assert.equal(Object.hasOwn(evidence.decision, "continuationSha256"), false);
  assert.equal(evidence.decision.questionId, input.decision.question.questionId);
  assert.equal(evidence.decision.semanticOfferSha256, input.decision.semanticOffer.offerSha256);
  assert.equal(evidence.decision.sourceRegisteredAt, input.decision.sourceRegisteredAt);
  assert.equal(evidence.decision.registrationSha256, input.decision.source.registrationSha256);
  assert.equal(evidence.decision.approvalTargetSha256, input.recipe.proposal.target.targetSha256);
});

test("candidate bytes survive the actual continuation final CAS with immutable owner source unchanged", () => {
  const { input, beforeDecision } = mergeMaterializerFixture();
  assert.equal(beforeDecision.continuation.status, "running");
  assert.equal(input.decision.continuation.status, "succeeded");
  assert.notEqual(beforeDecision.continuation.continuationSha256, input.decision.continuation.continuationSha256);
  assert.deepEqual({ ...beforeDecision, continuation: input.decision.continuation }, input.decision);
  const running = { ...input, decision: beforeDecision }, candidate = materialize(running);
  assert.deepEqual(candidate, materialize(input), "final CAS cannot change generated model/source/document bytes");
  const readback = { ...verificationInput(running, candidate), decision: input.decision };
  assert.match(verify(readback).reproductionSha256, /^[a-f0-9]{64}$/u);
});

test("merge content verification rejects mixed original records, foreign custody and accessor input", () => {
  const mutate = [
    input => { input.decision.binding.deploymentEpoch = "foreign"; },
    input => { input.decision.question.confidenceBasisSha256 = "0".repeat(64); },
    input => { input.decision.source.answerSha256 = "0".repeat(64); },
    input => { input.decision.semanticOffer.baseline.generation++; },
    input => { input.decision.continuation.turns = []; },
    input => { input.decision.custody.evidence.questionId = "foreign-question"; },
    input => { input.decision.sourceRegisteredAt = "2026-09-17T00:00:00.000Z"; },
    input => { input.recipe.metadata.createdAt = "2026-09-17T00:00:00.000Z"; },
    input => { input.decision.case = {}; },
  ];
  for (const change of mutate) { const { input } = mergeMaterializerFixture(); change(input); assert.throws(() => materialize(input)); }
  const { input } = mergeMaterializerFixture(); let reads = 0;
  Object.defineProperty(input.decision, "custody", { get() { reads++; return {}; }, enumerable: true });
  assert.throws(() => materialize(input)); assert.equal(reads, 0);
  const pending = mergeMaterializerFixture().input; pending.decision.selectedOption = null;
  assert.equal(materialize(pending).requiresOwnerApproval, true);
  const wrongScope = mergeMaterializerFixture().input;
  wrongScope.recipe = structuredClone(wrongScope.recipe);
  const { deltaSha256: _delta, ...delta } = wrongScope.recipe.proposal.delta;
  delta.changes[0].after.statement = "A different unapproved proposal must remain reviewable.";
  wrongScope.recipe.proposal.delta = feedbackSeal(delta, "deltaSha256");
  const { targetSha256: _target, ...target } = wrongScope.recipe.proposal.target;
  target.scope.semanticDeltaSha256 = wrongScope.recipe.proposal.delta.deltaSha256;
  wrongScope.recipe.proposal.target = feedbackSeal(target, "targetSha256");
  assert.equal(materialize(wrongScope).requiresOwnerApproval, true);
});

test("recomputed hostile merge record digests cannot substitute accepted custody or selected turn", () => {
  const reseal = (record, field) => { const { [field]: old, ...body } = record; return feedbackSeal(body, field); };
  for (const change of [
    decision => { decision.custody.evidence.projectId = "foreign-project"; decision.custody = reseal(decision.custody, "custodySha256"); },
    decision => { decision.custody.evidence.providerLocatorSha256 = "0".repeat(64); decision.custody = reseal(decision.custody, "custodySha256"); },
    decision => { decision.continuation.turns[0].source = null; decision.continuation = reseal(decision.continuation, "continuationSha256"); },
    decision => { decision.answer.principalId = "foreign-owner"; decision.answer = reseal(decision.answer, "answerSha256"); },
  ]) {
    const { input } = mergeMaterializerFixture(); change(input.decision); assert.throws(() => materialize(input));
  }
});

test("a genuine second owner answer reproduces the reanalyzed delta while retaining the original merge lineage", () => {
  const { input, entry } = mergeMaterializerFixture(true), output = materialize(input);
  assert.equal(entry.outcome.case.kind, "source-case"); assert.equal(entry.mergeAnchor, null);
  const { semanticOffer: offer, continuation } = input.decision;
  assert.equal(offer.comparisonCase.caseSha256, entry.outcome.case.caseSha256);
  assert.equal(continuation.turns[0].answer.decision.disposition, "rescope");
  assert.equal(offer.reanalysisOf.sourceRegistrationSha256, continuation.turns[0].source.registrationSha256);
  assert.equal(offer.mergeAnchorSha256, continuation.turns[0].question.semanticOffer.mergeAnchorSha256);
  assert.notEqual(offer.comparisonReceiptSha256, continuation.turns[0].question.semanticOffer.comparisonReceiptSha256);
  assert.equal(output.requiresOwnerApproval, false); assert.equal(output.modelApproved, false);
  assert.deepEqual(materialize(input), output); assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
  const metadata = JSON.parse(Object.entries(output.changedFiles).find(([path]) => path.includes("/artifacts/sha256/"))[1]);
  assert.deepEqual(metadata.decision.comparisonCase, offer.comparisonCase);
  assert.deepEqual(metadata.decision.reanalysisOf, offer.reanalysisOf);
  for (const file of input.baseline.snapshot.files) assert.equal(output.files[file.path], input.files[file.path]);
});

test("a re-sealed invented, changed or non-rescope prior turn cannot authorize the second offer", () => {
  const reseal = (record, field) => { const { [field]: old, ...body } = record; return feedbackSeal(body, field); };
  for (const mutate of [
    prior => { prior.answer.decision.disposition = "accept-variant"; prior.answer = reseal(prior.answer, "answerSha256"); },
    prior => { prior.source.answerSha256 = "0".repeat(64); prior.source = reseal(prior.source, "registrationSha256"); },
    prior => { prior.question.generation = 2; prior.question = reseal(prior.question, "questionSha256"); },
    prior => { prior.question.conflictId = "foreign-conflict"; prior.question = reseal(prior.question, "questionSha256"); },
  ]) {
    const { input } = mergeMaterializerFixture(true); mutate(input.decision.continuation.turns[0]);
    input.decision.continuation = reseal(input.decision.continuation, "continuationSha256"); assert.throws(() => materialize(input));
  }
  const { input } = mergeMaterializerFixture(true);
  input.decision.semanticOffer = input.decision.continuation.turns[0].question.semanticOffer;
  assert.throws(() => materialize(input), "the earlier offer cannot cover the new receipt");
});

test("actual prior owner information remains unapproved context for a later exact accepted offer", () => {
  const { input, entry, informationSource, beforeDecision } = mergeMaterializerFixture("owner-information");
  const prior = input.decision.continuation.turns[0];
  assert.equal(prior.question.semanticOffer, undefined);
  assert.equal(prior.question.ownerInformation.kind, "docsfab-merge-owner-information");
  assert.equal(Object.hasOwn(prior.question.ownerInformation, "options"), false);
  assert.equal(prior.answer.decision.disposition, "provide-evidence");
  assert.equal(entry.outcome.case.kind, "source-case");
  assert.equal(input.decision.semanticOffer.reanalysisOf.sourceRegistrationSha256, prior.source.registrationSha256);
  assert.equal(informationSource.semanticOffer, null); assert.equal(informationSource.selectedOption, null);
  assert.throws(() => materialize({ ...input, decision: informationSource }), "input-only source cannot approve a candidate");
  const output = materialize(input); assert.equal(output.requiresOwnerApproval, false); assert.equal(output.modelApproved, false);
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(materialize({ ...input, decision: beforeDecision }), output, "the actual later final CAS remains byte-stable");
});

test("owner-information lineage refuses invented prior options, changed request evidence and a claimed earlier approval", () => {
  const seal = (record, field) => { const { [field]: old, ...body } = record; return feedbackSeal(body, field); };
  for (const mutate of [
    prior => { prior.question.ownerInformation.options = []; },
    prior => { prior.question.ownerInformation.request.modelCitation.evidenceId = "foreign-claim"; },
    prior => { prior.question.ownerInformation.request.requestKind = "approve-model"; },
    prior => { prior.answer.decision.disposition = "accept-variant"; prior.answer = seal(prior.answer, "answerSha256"); },
    prior => { prior.question.semanticOffer = null; },
  ]) {
    const { input } = mergeMaterializerFixture("owner-information"), prior = input.decision.continuation.turns[0];
    mutate(prior);
    prior.question.ownerInformation.request = seal(prior.question.ownerInformation.request, "requestSha256");
    prior.question.ownerInformation = seal(prior.question.ownerInformation, "informationSha256");
    prior.question = seal(prior.question, "questionSha256");
    input.decision.continuation = seal(input.decision.continuation, "continuationSha256");
    assert.throws(() => materialize(input));
  }
});
