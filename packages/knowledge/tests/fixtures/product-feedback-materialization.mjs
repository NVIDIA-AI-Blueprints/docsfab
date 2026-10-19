// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Synthetic authority/source fixtures only; never a real owner or deployment approval. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { feedbackDigest as digest, feedbackSeal as seal, sealSourceVersion } from "../../src/product-feedback-contracts.mjs";
import { productFeedbackTargetRoutePolicySha256 } from "../../src/product-feedback-materializer.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");

/** A history index and model-index pointer shaped like the retained DOCSFAB-PRODUCT package. */
export function packageFiles(modelId, version) {
  return {
    [`.docsfab/reference-model/shared/${modelId}/history.md`]: `# ${modelId} product reference-model history\n\n` +
      "| Version | Date | State | Inputs | Notes |\n| --- | --- | --- | --- | --- |\n" +
      `| [${version}](${version}/model.md) | 2026-09-17 | Candidate | Fixture sources | Synthetic approved parent. |\n`,
    ".docsfab/reference-model/README.md": "# Reference-model artifacts\n\n## Current DocsFab model\n\n" +
      `- [Product reference-model history](shared/${modelId}/history.md)\n` +
      `- [Current product model: ${version}](shared/${modelId}/${version}/model.md)\n` +
      `- [${version} inconsistency report](shared/${modelId}/${version}/inconsistency-report.md)\n` +
      `- [${version} merge receipt](shared/${modelId}/${version}/merge-receipt.md)\n\nUnchanged closing prose.\n`,
  };
}

export function materializerFixture(overrides = {}) {
  const binding = { deploymentId: "fixture", projectId: overrides.snapshot?.projectId ?? "sample-project", deploymentEpoch: "epoch" };
  const modelPath = overrides.snapshot?.modelPath ?? ".docsfab/reference-model/shared/EXAMPLE/v0.1/model.md";
  const receiptPath = ".docsfab/reference-model/shared/EXAMPLE/v0.1/merge-receipt.md";
  const sourcePath = ".docsfab/reference-model/source-threads/SRC-EXAMPLE/thread.json";
  const modelText = "# Original model\n\nUnchanged inherited prose.\n";
  const receiptText = "# Original receipt\n\n## 13. Inconsistency Report and Transitions\n\n- Report: [inconsistency-report.md](inconsistency-report.md)\n\n" +
    "## 14. Governed Visual Closure\n\nSuccessors carry this block unchanged.\n\n```yaml visual-closure-receipt\n" +
    "schema_version: docsfab.knowledge.visual-closure-receipt/v1\nvisual_closures:\n- visual_id: EXAMPLE-DIAGRAM-01\n  target_state: current\n  conflict_id: none\n```\n";
  // `claimIndex` aims the decision at another claim, so sibling decisions can change different claims;
  // `extraClaims` adds that many synthetic claims to the default snapshot.
  const original = { claim_id: "CLAIM-MENTION", statement: "Ordinary channel messages require an explicit mention before the service replies.",
    scope: { surface: "ordinary-channel-messages" }, source_claims: ["ITEM-EXAMPLE-1"], relationship: "compatible", action: "included",
    exact_evidence: ["ITEM-EXAMPLE-1:statement"], agent_inferences: ["Retain this exact inference."], behavior_verification: "not-checked",
    representation_state: "confirmed", intent_approval: "approved", model_state: "candidate", decision_basis: "Original accountable intent.",
    resolution_owner: "Fixture owner", blocks_targets: [], unblocks_targets: ["mention behavior"] };
  const other = { ...original, claim_id: "CLAIM-UNCHANGED", statement: "An unrelated invariant remains unchanged." };
  const defaults = [original, other, ...Array.from({ length: overrides.extraClaims ?? 0 }, (_, index) =>
    ({ ...original, claim_id: `CLAIM-SIBLING-${index + 1}`, statement: `Sibling invariant ${index + 1} holds.` }))];
  const record = overrides.snapshot?.claims[overrides.claimIndex ?? 0].record ?? defaults[overrides.claimIndex ?? 0];
  const snapshot = overrides.snapshot ?? seal({ schemaVersion: 1, kind: "docsfab-reference-model-snapshot", projectId: binding.projectId,
    modelId: "EXAMPLE", version: "v0.1", state: "candidate", revision: "a".repeat(40), tree: "b".repeat(40), modelPath,
    modelSha256: sha(modelText), modelGitObjectId: createHash("sha1").update(`blob ${Buffer.byteLength(modelText)}\0${modelText}`).digest("hex"),
    files: [{ path: receiptPath, sha256: sha(receiptText) }, { path: modelPath, sha256: sha(modelText) }, { path: sourcePath, sha256: sha("{}\n") }],
    sourceClosureSha256: digest({ [sourcePath]: sha("{}\n") }),
    claims: defaults.map(record => ({ id: record.claim_id, sourcePath: modelPath, record, recordSha256: digest(record) })), openConflicts: [] }, "snapshotSha256");
  const streamVersion = overrides.streamVersion ?? 1;
  const approval = { projectId: binding.projectId, modelId: snapshot.modelId, version: snapshot.version, streamVersion,
    modelSha256: snapshot.modelSha256, snapshotSha256: snapshot.snapshotSha256, principalId: "fixture-owner",
    authorityReceiptSha256: digest("fixture authority"), approvalEvidenceSha256: digest("fixture evidence"), scope: "model-version" };
  const baseline = seal({ schemaVersion: 1, kind: "docsfab-approved-model-baseline", projectId: binding.projectId, generation: overrides.generation ?? 0,
    streamVersion, snapshot, canon: { sha256: snapshot.modelSha256, sourcePath: modelPath, gitObjectId: snapshot.modelGitObjectId }, approval }, "baselineSha256");
  const source = sealSourceVersion({ projectId: binding.projectId, sourceKind: "issue-comment", sourceId: "issue-source", version: overrides.sourceVersion ?? "version-1",
    parentVersionSha256: null, contentSha256: digest("Proposed pilot behavior"), locator: `docsfab-source:${digest("Proposed pilot behavior")}`,
    author: { providerId: "author-1", kind: "human" }, editor: null, occurredAt: "2026-09-17T09:00:00.000Z",
    observedAt: "2026-09-17T10:00:00.000Z", assertion: "proposed-intent", evidenceSha256s: [] });
  const targetPaths = ["planning/product-requirements.md", "planning/software-requirements.md", "planning/plan-of-record.md", "docs/specifications/behavior.md"];
  const document = "---\ntitle: Message Behavior\n---\n\nUnchanged introduction with [details](./details.md).\n\n## Mention Requirement\n\nOld contradictory requirement: all messages need a mention.\n\nThis separate exception within the same section remains unchanged.\n\n### Related Limit\n\nPreserve this unrelated subsection.\n\n## Unaffected Details\n\nRetain this exact paragraph and punctuation.\n";
  const documents = overrides.documents ?? Object.fromEntries(targetPaths.map(path => [path, document]));
  const routes = targetPaths.map((path, index) => ({ claimId: record.claim_id, targetId: `target-${index}`, path, delivery: path.startsWith("docs/") ? "public-documentation" : "repository-planning",
    heading: "Mention Requirement", beforeText: "Old contradictory requirement: all messages need a mention.", baseSha256: sha(documents[path]) }));
  const targets = overrides.targets ? routes.filter(route => overrides.targets.includes(route.targetId)) : routes;
  const delta = seal({ schemaVersion: 1, kind: "docsfab-offered-model-semantic-delta", projectId: binding.projectId, modelId: snapshot.modelId,
    approvedParentModelSha256: snapshot.modelSha256, comparisonReceiptSha256: digest("comparison"), evidenceSourceVersionSha256s: [source.sourceVersionSha256],
    changes: [{ claimId: record.claim_id, beforeClaimRecordSha256: digest(record), after: { claim_id: record.claim_id,
      statement: overrides.statement ?? "In the configured pilot channel, the service may reply to ordinary messages without an explicit mention.", scope: { surface: "configured-pilot-channel" } } }] }, "deltaSha256");
  const target = seal({ schemaVersion: 1, kind: "docsfab-model-approval-target", projectId: binding.projectId, modelId: snapshot.modelId,
    approvedParentModelSha256: snapshot.modelSha256, scope: { kind: "semantic-delta", semanticDeltaSha256: delta.deltaSha256,
      claimIds: [record.claim_id], evidenceSourceVersionSha256s: [source.sourceVersionSha256],
      projectionTargets: overrides.projectionTargets ?? targets.map(target => target.targetId) } }, "targetSha256");
  const keep = { optionId: "keep-approved", statement: record.statement, scope: record.scope, approvalTarget: null, semanticDelta: null };
  const option = { optionId: "replace-statement-and-scope", statement: delta.changes[0].after.statement, scope: delta.changes[0].after.scope,
    approvalTarget: target, semanticDelta: delta };
  const modelCase = seal({ ...binding, baseline: { generation: baseline.generation, baselineSha256: baseline.baselineSha256, modelSha256: snapshot.modelSha256 },
    sourceClosureSha256: snapshot.sourceClosureSha256, claimId: record.claim_id, comparisonReceiptSha256: delta.comparisonReceiptSha256,
    sourceCaseSha256: digest("fixture source case"), options: [keep, option] }, "caseSha256");
  const question = seal({ ...binding, caseSha256: modelCase.caseSha256, purpose: "owner-decision" }, "questionSha256");
  const answer = seal({ ...binding, caseSha256: modelCase.caseSha256, questionSha256: question.questionSha256, principalId: "fixture-owner",
    authorityReceiptSha256: approval.authorityReceiptSha256, disposition: "accept-variant", selectedOptionId: option.optionId }, "answerSha256");
  const custody = seal({ ...binding, principalId: "fixture-owner" }, "custodySha256");
  const registered = seal({ ...binding, caseSha256: modelCase.caseSha256, questionSha256: question.questionSha256, answerSha256: answer.answerSha256,
    custodySha256: custody.custodySha256, principalId: "fixture-owner", approvalTargetSha256: target.targetSha256,
    registeredAt: "2026-09-17T11:00:00.000Z", sourceKind: "owner-decision" }, "registrationSha256");
  return { baseline, decision: { case: modelCase, question, answer, source: registered, custody, selectedOption: option },
    recipe: { binding, baseRevision: snapshot.revision, comparison: { receiptSha256: delta.comparisonReceiptSha256, baselineSha256: baseline.baselineSha256,
      sourceClosureSha256: snapshot.sourceClosureSha256, complete: true, currentness: "current", missingEvidenceIds: [] },
      proposal: { target, delta }, sourceVersions: [source], metadata: { successorVersion: overrides.successorVersion ?? "v0.2", createdAt: "2026-09-17T12:00:00.000Z", title: "Pilot mention behavior" }, targets,
      targetRoutePolicySha256: productFeedbackTargetRoutePolicySha256(targets.map(({ baseSha256, ...route }) => route)) },
    files: { ...(overrides.files ?? { [modelPath]: modelText, [receiptPath]: receiptText, [sourcePath]: "{}\n" }),
      ...Object.fromEntries(targets.map(route => [route.path, documents[route.path]])),
      ...(overrides.packageFiles ?? packageFiles(snapshot.modelId, snapshot.version)) } };
}

export function withDecision(input, optionId) {
  const value = structuredClone(input), decision = value.decision;
  decision.selectedOption = decision.case.options.find(option => option.optionId === optionId);
  const { answerSha256: _answer, ...answer } = decision.answer;
  decision.answer = seal({ ...answer, selectedOptionId: optionId }, "answerSha256");
  const { registrationSha256: _source, ...source } = decision.source;
  decision.source = seal({ ...source, answerSha256: decision.answer.answerSha256,
    approvalTargetSha256: decision.selectedOption.approvalTarget?.targetSha256 ?? null }, "registrationSha256");
  return value;
}

/** A consistent input: the same comparison and source versions with no offered change and no decision. */
export function recordOnlyInput(input) {
  const value = structuredClone(input);
  value.decision = null; value.recipe.proposal = null; value.recipe.targets = [];
  value.recipe.targetRoutePolicySha256 = productFeedbackTargetRoutePolicySha256([]);
  for (const path of Object.keys(value.files)) if (!path.startsWith(".docsfab/")) delete value.files[path];
  return value;
}

export function verificationInput(input, output) {
  return { baseline: input.baseline, decision: input.decision, manifest: output.manifest,
    files: { base: { ...input.files, ...Object.fromEntries(output.manifest.requiredAbsentBasePaths.map(path => [path, null])) }, candidate: output.files } };
}

/** Retained output of C's actual local fixture at the commit recorded inside.
 * Approval, model response, Slack transport and persistence are explicitly synthetic.
 * The original continuation/offer/source bytes are never rebuilt as model cases.
 */
export function mergeMaterializerFixture(reanalysis = false) {
  const filename = reanalysis === "owner-information" ? "./product-feedback-owner-information.json" :
    reanalysis ? "./product-feedback-reanalysis.json" : "./product-feedback-genuine-merge.json";
  const retained = JSON.parse(readFileSync(new URL(filename, import.meta.url), "utf8"));
  const { baseline, decision, entry, sourceVersions, files } = retained;
  const prior = baseline.snapshot.claims.find(claim => claim.id === decision.semanticOffer.claimId);
  const path = "planning/product-requirements.md";
  files[path] = `# Synthetic product requirements\n\n## Mention Requirement\n\n${prior.record.statement}\n\nPreserve this unrelated paragraph.\n`;
  Object.assign(files, packageFiles(baseline.snapshot.modelId, baseline.snapshot.version));
  const targets = [{ claimId: prior.id, targetId: "product-requirements", path, delivery: "repository-planning", heading: "Mention Requirement",
    beforeText: prior.record.statement, baseSha256: sha(files[path]) }];
  const recipe = { binding: decision.binding, baseRevision: decision.continuation.anchor.mergeRevision,
    comparison: { receiptSha256: entry.outcome.outcomeSha256, baselineSha256: baseline.baselineSha256,
      sourceClosureSha256: baseline.snapshot.sourceClosureSha256, complete: true, currentness: "current", missingEvidenceIds: [] },
    proposal: { target: decision.semanticOffer.options[1].approvalTarget, delta: decision.semanticOffer.options[1].semanticDelta }, sourceVersions,
    metadata: { successorVersion: "v1.1", createdAt: decision.sourceRegisteredAt, title: "Synthetic accepted mention scope" }, targets,
    targetRoutePolicySha256: productFeedbackTargetRoutePolicySha256(targets.map(({ baseSha256, ...route }) => route)) };
  return { input: { baseline, decision, recipe, files }, entry, provenance: retained.provenance,
    beforeDecision: retained.beforeDecision ?? null, informationSource: retained.informationSource ?? null };
}
