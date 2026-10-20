// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Deterministic candidate content. Approval, Git publication and baseline writes belong to the host. */
import { createHash } from "node:crypto";
import { feedbackDigest as digest, feedbackJson as canonical, feedbackFreeze as freeze,
  feedbackHash as hash, feedbackId as id, feedbackKeys as keys, feedbackVerify as verify,
  feedbackRequire as need, parseSourceVersion } from "./product-feedback-contracts.mjs";
import { parseReferenceModelSnapshot } from "./reference-model-snapshot.mjs";

export const PRODUCT_FEEDBACK_MODEL_MARKER = "<!-- docsfab-product-feedback-model:v1 -->";
/**
 * v4 projects a decided claim into each routed document as the claim's own statement in one
 * marked region (`projectDocument`), appended under a generated section when the document has
 * none yet. v3 writes an advisory decision's claim statement as the owner's own wording, byte
 * for byte; v2 wrapped it in the decision record's template. Every new candidate is v4.
 */
export const PRODUCT_FEEDBACK_MATERIALIZER_VERSION = "docsfab-product-feedback-materializer.v4";
const OWNER_WORDING_VERSION = "docsfab-product-feedback-materializer.v3";
const LEGACY_TEMPLATE_STATEMENT_VERSION = "docsfab-product-feedback-materializer.v2";
/**
 * Versions a retained manifest may name. A v2 or v3 candidate already retained, published or
 * merged still reproduces byte for byte under its own rules, so it can be verified and
 * promoted; nothing new is materialized as v2 or v3.
 */
export const PRODUCT_FEEDBACK_MATERIALIZER_VERSIONS = Object.freeze([LEGACY_TEMPLATE_STATEMENT_VERSION, OWNER_WORDING_VERSION,
  PRODUCT_FEEDBACK_MATERIALIZER_VERSION]);
/**
 * The H2 section a v4 projection is appended under when the routed document holds no region
 * for the claim yet; the section is created at the end of the document when it is absent. A
 * region a maintainer moves elsewhere in the document is rewritten where it stands.
 */
export const PRODUCT_FEEDBACK_PROJECTION_HEADING = "Product reference model decisions";
/**
 * A v4 candidate whose projection would replace or remove someone's text in a document: it
 * publishes as a draft, and DocsFab never merges it itself. The manifest's `projectionReview`
 * records each span by path, byte count and digest, never its content.
 */
export const PROJECTION_REVIEW_CODE = "projection-normalisation-needs-review";
const PROJECTION_INTRODUCTION = "DocsFab writes each accepted product reference model decision here, as the statement the model " +
  "records for its claim. A later decision on the same claim rewrites its entry in place; change the model, not this text.";
/**
 * Names the model package itself in an approval scope; it is never a document route, and
 * no configured document target may take this id. The host's governed-convergence resolver
 * reads the same token in adjudication affected targets, but approval scopes never reach it.
 */
export const PRODUCT_REFERENCE_MODEL_TARGET_ID = "product-reference-model";
/**
 * A carried candidate's refusal when the head no longer holds the exact claim record the owner's
 * decision replaced: another decision changed that claim since, so this one needs the owner again.
 */
export const PRODUCT_FEEDBACK_CARRIED_CLAIM_CHANGED = "product-feedback: carried claim changed";
const sourceRoot = ".docsfab/reference-model/source-threads/";
const modelIndexPath = ".docsfab/reference-model/README.md";
const historyPath = modelId => `.docsfab/reference-model/shared/${modelId}/history.md`;
const manifestCredentialPatterns = [
  /\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprcds]-[A-Za-z0-9-]{20,}\b/u,
  /\bxoxe(?:\.(?:xoxb|xoxp))?-[A-Za-z0-9-]{10,}\b/u,
  /\bxapp-[A-Za-z0-9_-]{10,}\b/u,
  /\bnvapi-[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /(?:^|[^A-Za-z0-9_-])(?:token|secret|password|api[_-]?key|private[_-]?token|authorization)\s*[:=]\s*\S{8,}/iu,
];
function bytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  keys(value, ["encoding", "data"]); need(value.encoding === "base64" && typeof value.data === "string");
  const result = Buffer.from(value.data, "base64"); need(result.toString("base64") === value.data); return result;
}
export function encodeProductFeedbackFile(value) {
  const buffer = Buffer.from(value);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { return { encoding: "base64", data: buffer.toString("base64") }; }
}
const bytesHash = value => createHash("sha256").update(bytes(value)).digest("hex");
const blobId = (content, format) => createHash(format === 64 ? "sha256" : "sha1")
  .update(`blob ${bytes(content).byteLength}\0`).update(bytes(content)).digest("hex");
function inert(value, seen = new Set(), depth = 0) {
  need(depth < 64);
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return;
  need(value && typeof value === "object" && !seen.has(value)); seen.add(value);
  need(Object.getPrototypeOf(value) === (Array.isArray(value) ? Array.prototype : Object.prototype));
  for (const key of Reflect.ownKeys(value)) {
    need(typeof key === "string"); const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && Object.hasOwn(descriptor, "value")); inert(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}
function copy(value) {
  try { inert(value); return JSON.parse(canonical(value)); }
  catch { throw new Error("product-feedback: invalid materialization input"); }
}
function path(value) {
  need(typeof value === "string" && /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,511}$/u.test(value));
  need(value.split("/").every(part => part && part !== "." && part !== ".." && part !== ".git")); return value;
}
function text(value) {
  need(typeof value === "string" && value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value));
  need(!/\b(?:glpat-|github_pat_|xox[baprs]-|sk-proj-)[A-Za-z0-9_-]{20,}/u.test(value)); return value;
}
function revision(value) { need(typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)); return value; }
function timestamp(value) { need(typeof value === "string" && new Date(value).toISOString() === value); return value; }
function binding(value) { keys(value, ["deploymentId", "projectId", "deploymentEpoch"]); Object.values(value).forEach(id); return value; }
function fileMap(value) {
  need(value && typeof value === "object" && !Array.isArray(value));
  for (const [name, content] of Object.entries(value)) { path(name); need(bytes(content).byteLength <= 16 * 1024 * 1024); }
  return value;
}
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sortedFiles = files => Object.entries(files).sort(([a], [b]) => order(a, b)).map(([path, content]) => ({ path, sha256: bytesHash(content) }));
const sourceMap = entries => Object.fromEntries(entries.filter(file => file.path.startsWith(sourceRoot) && !file.path.includes("/views/"))
  .map(file => [file.path, file.sha256]));
const equal = (a, b) => canonical(a) === canonical(b);
const recipeIdentityDigest = (baselineSha256, recipe, decisionSourceRegistrationSha256, disposition) =>
  digest({ baselineSha256, recipe, decisionSourceRegistrationSha256, disposition });
const line = value => String(value).replace(/\s+/gu, " ").replace(/[\\`*_[\]<>#]/gu, "\\$&");
const scopeText = scope => Object.entries(scope).sort(([a], [b]) => order(a, b)).map(([key, value]) => `${line(key)}: ${line(value)}`).join("; ");

function baselineRecord(value) {
  keys(value, ["schemaVersion", "kind", "projectId", "generation", "streamVersion", "snapshot", "canon", "approval", "baselineSha256"]);
  verify(value, "baselineSha256"); need(value.schemaVersion === 1 && value.kind === "docsfab-approved-model-baseline");
  need(Number.isSafeInteger(value.generation) && value.generation >= 0 && Number.isSafeInteger(value.streamVersion) && value.streamVersion >= 0);
  const snapshot = parseReferenceModelSnapshot(value.snapshot);
  need(snapshot.projectId === value.projectId && value.canon.sha256 === snapshot.modelSha256 &&
    value.canon.sourcePath === snapshot.modelPath && value.canon.gitObjectId === snapshot.modelGitObjectId);
  need(value.approval.projectId === value.projectId && value.approval.modelId === snapshot.modelId &&
    value.approval.modelSha256 === snapshot.modelSha256 && value.approval.snapshotSha256 === snapshot.snapshotSha256 &&
    value.approval.streamVersion === value.streamVersion && value.approval.scope === "model-version");
  hash(value.approval.authorityReceiptSha256); return value;
}
function proposalShape(value) {
  keys(value, ["target", "delta"]); const { target, delta } = value;
  keys(delta, ["schemaVersion", "kind", "projectId", "modelId", "approvedParentModelSha256", "comparisonReceiptSha256", "evidenceSourceVersionSha256s", "changes", "deltaSha256"]);
  verify(delta, "deltaSha256"); need(delta.schemaVersion === 1 && delta.kind === "docsfab-offered-model-semantic-delta");
  keys(target, ["schemaVersion", "kind", "projectId", "modelId", "approvedParentModelSha256", "scope", "targetSha256"]);
  verify(target, "targetSha256"); need(target.schemaVersion === 1 && target.kind === "docsfab-model-approval-target");
  for (const record of [target, delta]) { id(record.projectId); id(record.modelId); hash(record.approvedParentModelSha256); }
  need(target.projectId === delta.projectId && target.modelId === delta.modelId && target.approvedParentModelSha256 === delta.approvedParentModelSha256);
  keys(target.scope, ["kind", "semanticDeltaSha256", "claimIds", "evidenceSourceVersionSha256s", "projectionTargets"]);
  need(target.scope.kind === "semantic-delta" && target.scope.semanticDeltaSha256 === delta.deltaSha256);
  need(Array.isArray(delta.changes) && delta.changes.length === 1);
  const change = delta.changes[0]; keys(change, ["claimId", "beforeClaimRecordSha256", "after"]);
  id(change.claimId); hash(change.beforeClaimRecordSha256); keys(change.after, ["claim_id", "statement", "scope"]);
  need(change.after.claim_id === change.claimId); text(change.after.statement);
  need(change.after.scope && Object.getPrototypeOf(change.after.scope) === Object.prototype && Object.keys(change.after.scope).length > 0);
  Object.values(change.after.scope).forEach(text);
  need(equal(target.scope.claimIds, [change.claimId]) && Array.isArray(delta.evidenceSourceVersionSha256s) && delta.evidenceSourceVersionSha256s.length > 0 &&
    new Set(delta.evidenceSourceVersionSha256s).size === delta.evidenceSourceVersionSha256s.length &&
    Array.isArray(target.scope.evidenceSourceVersionSha256s) &&
    equal([...target.scope.evidenceSourceVersionSha256s].sort(), [...delta.evidenceSourceVersionSha256s].sort()));
  hash(delta.comparisonReceiptSha256); delta.evidenceSourceVersionSha256s.forEach(hash);
  need(Array.isArray(target.scope.projectionTargets) && target.scope.projectionTargets.length > 0 &&
    new Set(target.scope.projectionTargets).size === target.scope.projectionTargets.length);
  target.scope.projectionTargets.forEach(id); return { target, delta, change };
}
function proposalRecord(value, baseline) {
  const { target, delta, change } = proposalShape(value);
  need(target.projectId === baseline.projectId && target.modelId === baseline.snapshot.modelId &&
    target.approvedParentModelSha256 === baseline.snapshot.modelSha256);
  const before = baseline.snapshot.claims.find(claim => claim.id === change.claimId);
  need(before && before.recordSha256 === change.beforeClaimRecordSha256 && digest(before.record) === before.recordSha256);
  need(!equal({ claim_id: before.id, statement: before.record.statement, scope: before.record.scope }, change.after));
  return { target, delta, before, change };
}

/**
 * The same statement `renderGovernedConvergenceDecisionStatement`
 * (`packages/host/src/reconciliation/convergence-runner.ts`) renders. This
 * package cannot import a host `.ts` module (knowledge -> runtime <- quality,
 * never the reverse), so it keeps its own copy rather than trusting the
 * host's rendering: `mergeAdvisoryDecisionBinding` below recomputes the
 * statement from the owner's own bound `rationale`/`conflictId`/etc, the
 * same primitive fields it already verifies, instead of trusting a
 * pre-rendered string. `test/product-feedback-advisory-decision.test.ts`
 * (host) holds the two byte-identical across a range of inputs.
 */
function renderAdvisoryDecisionStatement(input) {
  return `Conflict ${input.conflictId}. Decision: ${input.disposition}. Selected claims: ${
    input.selectedClaimIds.length === 0 ? "none" : input.selectedClaimIds.join(", ")
  }. Rationale: ${input.rationale}.${
    input.scope === null ? "" : ` New scope: ${input.scope}.`
  } Decision source: ${input.sourceRegistrationSha256}.`;
}

/** Inspect content bindings only. A matching serialized record is never an approval capability. */
function decisionBinding(decision, baseline, proposal, expectedBinding, version) {
  if (decision === null) return { disposition: "unapproved", evidence: null };
  if (decision.kind === "docsfab-verified-merge-decision-source") return mergeDecisionBinding(decision, baseline, proposal, expectedBinding);
  if (decision.kind === "docsfab-verified-merge-advisory-decision-source") return mergeAdvisoryDecisionBinding(decision, baseline, proposal, expectedBinding, version);
  keys(decision, ["case", "question", "answer", "source", "custody", "selectedOption"]);
  const { case: modelCase, question, answer, source, custody, selectedOption } = decision;
  for (const [record, field] of [[modelCase, "caseSha256"], [question, "questionSha256"], [answer, "answerSha256"],
    [source, "registrationSha256"], [custody, "custodySha256"]]) verify(record, field);
  for (const record of [modelCase, question, answer, source, custody]) for (const key of Object.keys(expectedBinding)) need(record[key] === expectedBinding[key]);
  need(modelCase.baseline.generation === baseline.generation && modelCase.baseline.baselineSha256 === baseline.baselineSha256 &&
    modelCase.baseline.modelSha256 === baseline.snapshot.modelSha256 && modelCase.sourceClosureSha256 === baseline.snapshot.sourceClosureSha256 &&
    modelCase.comparisonReceiptSha256 === proposal.delta.comparisonReceiptSha256 && modelCase.claimId === proposal.before.id);
  need(question.caseSha256 === modelCase.caseSha256 && answer.caseSha256 === modelCase.caseSha256 && answer.questionSha256 === question.questionSha256 &&
    source.caseSha256 === modelCase.caseSha256 && source.questionSha256 === question.questionSha256 &&
    source.answerSha256 === answer.answerSha256 && source.custodySha256 === custody.custodySha256 &&
    source.principalId === answer.principalId && custody.principalId === answer.principalId);
  if (question.purpose !== "owner-decision" || source.sourceKind !== "owner-decision" ||
      answer.disposition !== "accept-variant" || selectedOption === null || answer.selectedOptionId !== selectedOption.optionId ||
      !modelCase.options.some(option => equal(option, selectedOption))) return { disposition: "unapproved", evidence: null };
  if (selectedOption.optionId === "keep-approved") return { disposition: "keep-approved", evidence: { source, answer, custody, modelCase } };
  if (selectedOption.optionId !== "replace-statement-and-scope" || !equal(selectedOption.approvalTarget, proposal.target) ||
      !equal(selectedOption.semanticDelta, proposal.delta) || source.approvalTargetSha256 !== proposal.target.targetSha256) {
    return { disposition: "unapproved", evidence: null };
  }
  return { disposition: "matching-owner-decision", evidence: { source, answer, custody, modelCase } };
}

/** Verify original legacy records as content; the host owns custody readback and current authority. */
function ownerInformationShape(value) {
  keys(value, ["schemaVersion", "kind", "binding", "mergeAnchorSha256", "comparisonSha256", "comparisonReceiptSha256", "baseline",
    "findingSha256", "claimId", "beforeClaimRecordSha256", "evidenceSourceVersionSha256s", "request", "informationSha256",
    ...(Object.hasOwn(value, "comparisonCase") ? ["comparisonCase"] : []), ...(Object.hasOwn(value, "reanalysisOf") ? ["reanalysisOf"] : [])]);
  need(value.schemaVersion === 1 && value.kind === "docsfab-merge-owner-information"); verify(value, "informationSha256"); binding(value.binding); id(value.claimId);
  for (const field of ["mergeAnchorSha256", "comparisonSha256", "comparisonReceiptSha256", "findingSha256", "beforeClaimRecordSha256"]) hash(value[field]);
  need(Array.isArray(value.evidenceSourceVersionSha256s) && value.evidenceSourceVersionSha256s.length > 0 &&
    new Set(value.evidenceSourceVersionSha256s).size === value.evidenceSourceVersionSha256s.length); value.evidenceSourceVersionSha256s.forEach(hash);
  if (value.comparisonCase) {
    keys(value.comparisonCase, ["kind", "caseSha256"]); hash(value.comparisonCase.caseSha256);
    if (value.comparisonCase.kind === "source-case") {
      keys(value.reanalysisOf, ["questionSha256", "sourceRegistrationSha256"]); Object.values(value.reanalysisOf).forEach(hash);
    } else need(value.comparisonCase.kind === "merge" && value.comparisonCase.caseSha256 === value.mergeAnchorSha256 && value.reanalysisOf === undefined);
  } else need(value.reanalysisOf === undefined && value.comparisonCase === undefined);
  const request = value.request;
  keys(request, ["evidenceId", "claimId", "requestKind", "question", "whyOwnerNeeded", "modelCitation", "sourceCitations",
    "inputSha256", "findingSha256", "evidenceSourceVersionSha256s", "requestSha256"]); verify(request, "requestSha256");
  id(request.evidenceId); hash(request.inputSha256);
  need(request.claimId === value.claimId && request.findingSha256 === value.findingSha256 && ["scope", "constraint", "evidence"].includes(request.requestKind) &&
    equal(request.evidenceSourceVersionSha256s, value.evidenceSourceVersionSha256s));
  for (const key of ["question", "whyOwnerNeeded"]) { text(request[key]); need(Buffer.byteLength(request[key]) <= 2048); }
  const citation = row => {
    keys(row, ["evidenceId", "startByte", "endByte", "sha256"]); id(row.evidenceId); hash(row.sha256);
    need(Number.isSafeInteger(row.startByte) && row.startByte >= 0 && Number.isSafeInteger(row.endByte) && row.endByte >= row.startByte); return row;
  };
  need(citation(request.modelCitation).evidenceId === value.claimId && Array.isArray(request.sourceCitations) &&
    request.sourceCitations.map(citation).some(row => row.evidenceId === request.evidenceId));
  return value;
}

function mergeDecisionBinding(decision, baseline, proposal, expectedBinding) {
  keys(decision, ["kind", "binding", "continuation", "question", "answer", "source", "sourceRegisteredAt", "custody", "semanticOffer", "selectedOption"]);
  const { continuation, question, answer, source, custody, semanticOffer: offer, selectedOption } = decision;
  binding(decision.binding); need(equal(decision.binding, expectedBinding));
  for (const [record, field, kind] of [[continuation, "continuationSha256", "docsfab-reconciliation-continuation"],
    [question, "questionSha256", "docsfab-reconciliation-question"], [answer, "answerSha256", "docsfab-reconciliation-answer"],
    [source, "registrationSha256", "docsfab-reconciliation-decision-source"], [offer, "offerSha256", "docsfab-merge-semantic-offer"]]) {
    need(record.schemaVersion === 1 && record.kind === kind); verify(record, field);
  }
  for (const key of Object.keys(expectedBinding)) need(continuation[key] === expectedBinding[key]);
  need(equal(binding(offer.binding), expectedBinding));
  keys(offer, ["schemaVersion", "kind", "binding", "mergeAnchorSha256", "comparisonSha256", "comparisonReceiptSha256", "baseline",
    "findingSha256", "claimId", "beforeClaimRecordSha256", "evidenceSourceVersionSha256s", "options", "offerSha256",
    ...(Object.hasOwn(offer, "comparisonCase") ? ["comparisonCase"] : []), ...(Object.hasOwn(offer, "reanalysisOf") ? ["reanalysisOf"] : []),
    ...(Object.hasOwn(offer, "input") ? ["input"] : [])]);
  hash(offer.mergeAnchorSha256); hash(offer.comparisonSha256); hash(offer.findingSha256);
  const comparisonCase = offer.comparisonCase ?? { kind: "merge", caseSha256: offer.mergeAnchorSha256 };
  keys(comparisonCase, ["kind", "caseSha256"]); hash(comparisonCase.caseSha256);
  if (comparisonCase.kind === "source-case") {
    keys(offer.reanalysisOf, ["questionSha256", "sourceRegistrationSha256"]);
    hash(offer.reanalysisOf.questionSha256); hash(offer.reanalysisOf.sourceRegistrationSha256);
  } else need(comparisonCase.kind === "merge" && comparisonCase.caseSha256 === offer.mergeAnchorSha256 && offer.reanalysisOf === undefined);
  need(equal(offer.baseline, { generation: baseline.generation, baselineSha256: baseline.baselineSha256,
    modelId: baseline.snapshot.modelId, version: baseline.snapshot.version, streamVersion: baseline.streamVersion,
    modelSha256: baseline.snapshot.modelSha256, canonSha256: baseline.canon.sha256,
    approvalReceiptSha256: baseline.approval.authorityReceiptSha256, sourceClosureSha256: baseline.snapshot.sourceClosureSha256 }) &&
    offer.claimId === proposal.before.id && offer.beforeClaimRecordSha256 === proposal.before.recordSha256 &&
    offer.comparisonReceiptSha256 === proposal.delta.comparisonReceiptSha256 &&
    equal([...offer.evidenceSourceVersionSha256s].sort(), [...proposal.delta.evidenceSourceVersionSha256s].sort()));
  need(Array.isArray(offer.options) && offer.options.length === 2);
  for (const [index, option] of offer.options.entries()) {
    keys(option, ["optionId", "claimId", "semanticClaim", "semanticClaimSha256", "approvalTarget", "semanticDelta"]);
    need(option.optionId === ["keep-approved", "replace-statement-and-scope"][index]); id(option.claimId);
    need(option.semanticClaimSha256 === digest(option.semanticClaim) && option.semanticClaim.claim_id === proposal.before.id);
  }
  const [keep, replacement] = offer.options;
  need(keep.claimId !== replacement.claimId && keep.approvalTarget === null && keep.semanticDelta === null &&
    equal(keep.semanticClaim, { claim_id: proposal.before.id, statement: proposal.before.record.statement, scope: proposal.before.record.scope }));
  const turn = continuation.turns.filter(item => item.question.questionId === question.questionId);
  need(turn.length === 1 && ["source-registered", "closed"].includes(turn[0].status) &&
    equal(turn[0].question, question) && equal(turn[0].answer, answer) && equal(turn[0].source, source));
  if (offer.reanalysisOf) {
    const previous = continuation.turns.filter(item => item.question.questionSha256 === offer.reanalysisOf.questionSha256);
    need(previous.length === 1 && ["source-registered", "closed"].includes(previous[0].status));
    const prior = previous[0], hasInformation = Object.hasOwn(prior.question, "ownerInformation"), information = prior.question.ownerInformation;
    need(!(hasInformation && Object.hasOwn(prior.question, "semanticOffer")));
    const priorOffer = hasInformation ? ownerInformationShape(information) : prior.question.semanticOffer;
    for (const [record, field] of [[prior.question, "questionSha256"], [prior.answer, "answerSha256"],
      [prior.source, "registrationSha256"], [priorOffer, hasInformation ? "informationSha256" : "offerSha256"]]) verify(record, field);
    if (hasInformation) need(prior.question.offeredClaimIds.length === 0 && prior.question.variants.length === 0 &&
      equal(prior.question.allowedDispositions, ["provide-evidence", "rescope", "defer"]));
    need(prior.question.generation < question.generation && prior.question.conflictId === question.conflictId &&
      prior.question.reconciliationId === continuation.reconciliationId && prior.answer.questionSha256 === prior.question.questionSha256 &&
      (hasInformation ? ["provide-evidence", "rescope"].includes(prior.answer.decision.disposition) : prior.answer.decision.disposition === "rescope") &&
      prior.source.questionId === prior.question.questionId &&
      prior.source.answerSha256 === prior.answer.answerSha256 && prior.source.principalId === prior.answer.principalId &&
      prior.source.registrationSha256 === offer.reanalysisOf.sourceRegistrationSha256 &&
      priorOffer.mergeAnchorSha256 === offer.mergeAnchorSha256 && equal(priorOffer.binding, expectedBinding) &&
      equal(priorOffer.baseline, offer.baseline) && priorOffer.claimId === offer.claimId &&
      priorOffer.beforeClaimRecordSha256 === offer.beforeClaimRecordSha256 &&
      (hasInformation || equal(priorOffer.options.map(option => option.claimId), offer.options.map(option => option.claimId))));
  }
  const anchor = continuation.anchor; verify(anchor, "anchorSha256");
  need(anchor.modelParent.modelId === baseline.snapshot.modelId && anchor.modelParent.version === baseline.snapshot.version &&
    anchor.modelParent.sha256 === baseline.snapshot.modelSha256 && anchor.modelParent.streamVersion === baseline.streamVersion &&
    question.reconciliationId === continuation.reconciliationId && question.requestKey === anchor.requestKey &&
    question.stoppedAttemptId === anchor.originalAttemptId && question.stoppedJobSha256 === anchor.originalJobSha256 &&
    question.stoppedPacketSha256 === anchor.originalPacketSha256 && question.stoppedContextBindingSha256 === anchor.contextBindingSha256 &&
    question.continuationAttemptKey === `${anchor.requestKey}/adjudication-${question.generation}` &&
    question.resumeAnchorSha256 === digest({ reconciliationId: continuation.reconciliationId, originalAnchorSha256: anchor.anchorSha256,
      questionId: question.questionId, conflictSnapshotSha256: question.conflictSnapshotSha256, continuationAttemptKey: question.continuationAttemptKey }) &&
    equal(question.semanticOffer, offer) && question.confidenceBasisSha256 === offer.findingSha256 &&
    equal([...question.offeredClaimIds].sort(), offer.options.map(option => option.claimId).sort()));
  for (const record of [answer, source]) need(record.reconciliationId === question.reconciliationId && record.questionId === question.questionId && record.conflictId === question.conflictId);
  need(answer.questionSha256 === question.questionSha256 && answer.generation === question.generation &&
    answer.principalId === question.authority.expectedPrincipalId && answer.authorityReceiptSha256 === question.authority.authorityReceiptSha256 &&
    answer.identityReceiptSha256 === question.authority.identityReceiptSha256 && answer.ownerPolicySha256 === question.authority.ownerPolicySha256 &&
    answer.channelIdentitySha256 === question.authority.expectedChannelIdentitySha256 && source.answerSha256 === answer.answerSha256 &&
    source.principalId === answer.principalId && source.authorityReceiptSha256 === answer.authorityReceiptSha256 &&
    source.sourceKind === "authority-decision" && source.evidenceRole === "intent");
  for (const key of ["channelKind", "accountLocatorSha256", "conversationLocatorSha256", "threadLocatorSha256"]) need(answer[key] === question.route[key]);
  keys(custody, ["evidence", "contentSha256", "recordedAt", "custodySha256"]); verify(custody, "custodySha256");
  const evidence = custody.evidence;
  need(evidence.deploymentId === expectedBinding.deploymentId && evidence.projectId === expectedBinding.projectId &&
    evidence.requestKey === question.requestKey && evidence.runId === question.reconciliationId && evidence.attemptId === question.stoppedAttemptId &&
    evidence.questionId === question.questionId && evidence.expectedPrincipalId === answer.principalId && evidence.authority === "accountable-principal" &&
    evidence.disclosurePolicy === "cite-only" && evidence.sourceKind === "slack-thread" && evidence.locatorSha256 === answer.providerLocatorSha256 &&
    evidence.sourceLocator === `slack-source:${answer.providerLocatorSha256}` && evidence.providerLocatorSha256 === question.route.threadLocatorSha256 &&
    evidence.contentSha256 === answer.contentSha256 && custody.contentSha256 === answer.contentSha256);
  [decision.sourceRegisteredAt, custody.recordedAt, answer.receivedAt, question.issuedAt, question.expiresAt].forEach(timestamp);
  need(Date.parse(answer.receivedAt) >= Date.parse(question.issuedAt) && Date.parse(answer.receivedAt) < Date.parse(question.expiresAt) &&
    Date.parse(decision.sourceRegisteredAt) >= Date.parse(answer.receivedAt) && Date.parse(decision.sourceRegisteredAt) >= Date.parse(custody.recordedAt));
  if (answer.decision.disposition !== "accept-variant" || selectedOption === null || !offer.options.some(option => equal(option, selectedOption)) ||
    !equal(answer.decision.selectedClaimIds, [selectedOption.claimId])) return { disposition: "unapproved", evidence: null };
  if (!equal(replacement.approvalTarget, proposal.target) || !equal(replacement.semanticDelta, proposal.delta) ||
    !equal(replacement.semanticClaim, proposal.change.after)) return { disposition: "unapproved", evidence: null };
  const retained = { kind: decision.kind, source, answer, custody, continuation, question, offer,
    sourceRegisteredAt: decision.sourceRegisteredAt, selectedOptionId: selectedOption.optionId, approvalTargetSha256: selectedOption.approvalTarget?.targetSha256 ?? null };
  if (selectedOption.optionId === "keep-approved") return { disposition: "keep-approved", evidence: retained };
  return { disposition: "matching-owner-decision", evidence: retained };
}

/**
 * The no-offer counterpart of `mergeDecisionBinding`: an accountable
 * advisory decision (`isAccountableTurn`, high-confidence advisory or any
 * load-bearing finding) whose question carried no `semanticOffer`. There is
 * no pre-sealed option to select from -- the owner answered a free-text
 * question, not a two-option one -- so the checks below verify the same
 * continuation/question/answer/source/custody/anchor bindings
 * `mergeDecisionBinding` verifies, minus every offer-specific one, and then
 * independently re-derive the claim statement from the owner's own bound
 * reply rather than trusting a pre-computed replacement.
 *
 * The owner's reply text (the wording under `update`, or a structured reply's
 * `Rationale:`) is the claim's new statement, byte for byte. The rendered
 * "Conflict ... Decision source ..." text is the decision record: it stays in
 * the governed decision and the inconsistency report beside the statement,
 * never inside it. A v2 manifest reproduces with the record as the statement.
 */
function mergeAdvisoryDecisionBinding(decision, baseline, proposal, expectedBinding, version) {
  keys(decision, ["kind", "binding", "continuation", "question", "answer", "source", "sourceRegisteredAt", "custody", "decision"]);
  const { continuation, question, answer, source, custody, decision: governed } = decision;
  binding(decision.binding); need(equal(decision.binding, expectedBinding));
  for (const [record, field, kind] of [[continuation, "continuationSha256", "docsfab-reconciliation-continuation"],
    [question, "questionSha256", "docsfab-reconciliation-question"], [answer, "answerSha256", "docsfab-reconciliation-answer"],
    [source, "registrationSha256", "docsfab-reconciliation-decision-source"]]) {
    need(record.schemaVersion === 1 && record.kind === kind); verify(record, field);
  }
  for (const key of Object.keys(expectedBinding)) need(continuation[key] === expectedBinding[key]);
  need(question.semanticOffer === undefined);
  const turn = continuation.turns.filter(item => item.question.questionId === question.questionId);
  need(turn.length === 1 && ["source-registered", "closed"].includes(turn[0].status) &&
    equal(turn[0].question, question) && equal(turn[0].answer, answer) && equal(turn[0].source, source));
  const anchor = continuation.anchor; verify(anchor, "anchorSha256");
  need(anchor.modelParent.modelId === baseline.snapshot.modelId && anchor.modelParent.version === baseline.snapshot.version &&
    anchor.modelParent.sha256 === baseline.snapshot.modelSha256 && anchor.modelParent.streamVersion === baseline.streamVersion &&
    question.reconciliationId === continuation.reconciliationId && question.requestKey === anchor.requestKey &&
    question.stoppedAttemptId === anchor.originalAttemptId && question.stoppedJobSha256 === anchor.originalJobSha256 &&
    question.stoppedPacketSha256 === anchor.originalPacketSha256 && question.stoppedContextBindingSha256 === anchor.contextBindingSha256 &&
    question.continuationAttemptKey === `${anchor.requestKey}/adjudication-${question.generation}` &&
    question.resumeAnchorSha256 === digest({ reconciliationId: continuation.reconciliationId, originalAnchorSha256: anchor.anchorSha256,
      questionId: question.questionId, conflictSnapshotSha256: question.conflictSnapshotSha256, continuationAttemptKey: question.continuationAttemptKey }));
  for (const record of [answer, source]) need(record.reconciliationId === question.reconciliationId && record.questionId === question.questionId && record.conflictId === question.conflictId);
  need(answer.questionSha256 === question.questionSha256 && answer.generation === question.generation &&
    answer.principalId === question.authority.expectedPrincipalId && answer.authorityReceiptSha256 === question.authority.authorityReceiptSha256 &&
    answer.identityReceiptSha256 === question.authority.identityReceiptSha256 && answer.ownerPolicySha256 === question.authority.ownerPolicySha256 &&
    answer.channelIdentitySha256 === question.authority.expectedChannelIdentitySha256 && source.answerSha256 === answer.answerSha256 &&
    source.principalId === answer.principalId && source.authorityReceiptSha256 === answer.authorityReceiptSha256 &&
    source.sourceKind === "authority-decision" && source.evidenceRole === "intent");
  for (const key of ["channelKind", "accountLocatorSha256", "conversationLocatorSha256", "threadLocatorSha256"]) need(answer[key] === question.route[key]);
  keys(custody, ["evidence", "contentSha256", "recordedAt", "custodySha256"]); verify(custody, "custodySha256");
  const evidence = custody.evidence;
  // Schema-aware, unlike a plain literal: parseSlackSourceEvidence names two
  // valid custody authorities (v1 "accountable-principal", v2
  // "repository-maintainer-candidate"), and this custody's own authority
  // must still name a real, live decision-maker for this answer -- omitting
  // this check would let any recorded custody row bind here, including a
  // read grant issued for a lower-authority role.
  need(evidence.deploymentId === expectedBinding.deploymentId && evidence.projectId === expectedBinding.projectId &&
    evidence.requestKey === question.requestKey && evidence.runId === question.reconciliationId && evidence.attemptId === question.stoppedAttemptId &&
    evidence.questionId === question.questionId && evidence.expectedPrincipalId === answer.principalId &&
    evidence.authority === (evidence.schemaVersion === 2 ? "repository-maintainer-candidate" : "accountable-principal") &&
    evidence.disclosurePolicy === "cite-only" && evidence.sourceKind === "slack-thread" && evidence.locatorSha256 === answer.providerLocatorSha256 &&
    evidence.sourceLocator === `slack-source:${answer.providerLocatorSha256}` && evidence.providerLocatorSha256 === question.route.threadLocatorSha256 &&
    evidence.contentSha256 === answer.contentSha256 && custody.contentSha256 === answer.contentSha256);
  [decision.sourceRegisteredAt, custody.recordedAt, answer.receivedAt, question.issuedAt, question.expiresAt].forEach(timestamp);
  need(Date.parse(answer.receivedAt) >= Date.parse(question.issuedAt) && Date.parse(answer.receivedAt) < Date.parse(question.expiresAt) &&
    Date.parse(decision.sourceRegisteredAt) >= Date.parse(answer.receivedAt) && Date.parse(decision.sourceRegisteredAt) >= Date.parse(custody.recordedAt));
  if (answer.decision.disposition !== "accept-variant") return { disposition: "unapproved", evidence: null };
  // Independently re-derive the statement from the owner's own bound
  // rationale: this package never trusts the host's rendering, only the
  // primitive fields the checks above already bound to the real answer.
  keys(governed, ["conflictId", "disposition", "selectedClaimIds", "rationale", "rationaleSha256", "scope", "scopeSha256",
    "sourceRegistrationSha256", "statement", "statementContentSha256"]);
  need(governed.conflictId === question.conflictId && governed.disposition === answer.decision.disposition &&
    equal(governed.selectedClaimIds, answer.decision.selectedClaimIds) && governed.rationale === answer.decision.rationale &&
    governed.rationaleSha256 === answer.decision.rationaleSha256 && governed.scope === answer.decision.scope &&
    governed.scopeSha256 === answer.decision.scopeSha256 && governed.sourceRegistrationSha256 === source.registrationSha256);
  text(governed.rationale);
  const derivedStatement = renderAdvisoryDecisionStatement(governed);
  if (governed.statement !== derivedStatement || governed.statementContentSha256 !== bytesHash(derivedStatement))
    return { disposition: "unapproved", evidence: null };
  const claimStatement = version === LEGACY_TEMPLATE_STATEMENT_VERSION ? derivedStatement : governed.rationale;
  if (!equal(proposal.change.after, { claim_id: proposal.before.id, statement: claimStatement, scope: proposal.before.record.scope })) {
    return { disposition: "unapproved", evidence: null };
  }
  const retained = { kind: decision.kind, source, answer, custody, continuation, question, decision: governed,
    sourceRegisteredAt: decision.sourceRegisteredAt };
  return { disposition: "matching-owner-decision", evidence: retained };
}

function recipeShape(value) {
  keys(value, ["binding", "baseRevision", "comparison", "proposal", "sourceVersions", "metadata", "targets", "targetRoutePolicySha256"]);
  hash(value.targetRoutePolicySha256);
  binding(value.binding); revision(value.baseRevision);
  const comparison = value.comparison;
  keys(comparison, ["receiptSha256", "baselineSha256", "sourceClosureSha256", "complete", "currentness", "missingEvidenceIds"]);
  hash(comparison.receiptSha256); hash(comparison.baselineSha256); hash(comparison.sourceClosureSha256);
  need(comparison.complete === true &&
    comparison.currentness === "current" && Array.isArray(comparison.missingEvidenceIds) && comparison.missingEvidenceIds.length === 0);
  // A record-only recipe offers no claim change: it carries no proposal, and so nothing needs a decision.
  const proposal = value.proposal === null ? null : proposalShape(value.proposal);
  need(proposal === null || (proposal.target.projectId === value.binding.projectId && proposal.delta.comparisonReceiptSha256 === comparison.receiptSha256));
  need(Array.isArray(value.sourceVersions)); value.sourceVersions.forEach(parseSourceVersion);
  const versions = value.sourceVersions.map(source => source.sourceVersionSha256).sort();
  need(value.sourceVersions.every(source => source.projectId === value.binding.projectId) && (proposal === null ?
    versions.length > 0 && new Set(versions).size === versions.length : equal(versions, [...proposal.delta.evidenceSourceVersionSha256s].sort())));
  keys(value.metadata, ["successorVersion", "createdAt", "title"]); timestamp(value.metadata.createdAt); text(value.metadata.title);
  need(/^v\d+\.\d+$/u.test(value.metadata.successorVersion));
  need(value.sourceVersions.every(source => Date.parse(value.metadata.createdAt) >= Date.parse(source.observedAt)));
  need(Array.isArray(value.targets));
  for (const target of value.targets) {
    keys(target, ["claimId", "targetId", "path", "delivery", "heading", "beforeText", "baseSha256"]); id(target.targetId); path(target.path); text(target.heading); hash(target.baseSha256);
    need(proposal !== null && target.claimId === proposal.change.claimId);
    if (target.beforeText !== null) { text(target.beforeText); need(!/[\r\n]/u.test(target.beforeText)); }
    need(["repository-planning", "public-documentation"].includes(target.delivery));
    need(!target.path.startsWith(".docsfab/") && !target.path.startsWith("packages/") && target.path.endsWith(".md"));
  }
  // The routes are exactly the approved scope minus the package itself. An approval scope is never empty and
  // no route may carry the reserved id, so a recipe without routes is admitted only when the scope names the package alone.
  const targetIds = value.targets.map(target => target.targetId), scope = proposal === null ? [] : proposal.target.scope.projectionTargets;
  need(new Set(value.targets.map(target => target.path)).size === value.targets.length && new Set(targetIds).size === targetIds.length &&
    equal([...targetIds].sort(), scope.filter(targetId => targetId !== PRODUCT_REFERENCE_MODEL_TARGET_ID).sort()));
  return proposal;
}

/**
 * The approved generation an owner's decision was made against, when a candidate carries that
 * decision onto a later head: the same project and model, an earlier generation.
 */
function carriedParent(value, head) {
  const parent = baselineRecord(value);
  need(parent.projectId === head.projectId && parent.snapshot.modelId === head.snapshot.modelId && parent.generation < head.generation &&
    parent.baselineSha256 !== head.baselineSha256);
  return parent;
}
const versionAfter = (next, previous) => {
  const a = /^v(\d+)\.(\d+)$/u.exec(next), b = /^v(\d+)\.(\d+)$/u.exec(previous);
  return Boolean(a && b && (Number(a[1]) > Number(b[1]) || (Number(a[1]) === Number(b[1]) && Number(a[2]) > Number(b[2]))));
};

function parseRecipe(value, baseline) {
  const shape = recipeShape(value);
  need(value.binding.projectId === baseline.projectId && value.comparison.baselineSha256 === baseline.baselineSha256 &&
    value.comparison.sourceClosureSha256 === baseline.snapshot.sourceClosureSha256);
  const previous = /^v(\d+)\.(\d+)$/u.exec(baseline.snapshot.version), next = /^v(\d+)\.(\d+)$/u.exec(value.metadata.successorVersion);
  need(previous && next && (Number(next[1]) > Number(previous[1]) ||
    (Number(next[1]) === Number(previous[1]) && Number(next[2]) > Number(previous[2]))));
  return shape === null ? null : proposalRecord(value.proposal, baseline);
}

/** Closed data validation only. It proves no approval, currentness, route authority or actual Git bytes. */
export function parseProductFeedbackCandidateManifest(input) {
  const value = copy(input);
  const serialized = canonical(value);
  need(!manifestCredentialPatterns.some(pattern => pattern.test(serialized)));
  keys(value, ["schemaVersion", "kind", "materializerVersion", "binding", "baseRevision", "baselineGeneration", "baselineSha256",
    "approvedParentModelSha256", "recipe", "recipeSha256", "targetRoutePolicySha256", "decisionRegistrationSha256", "approvalTargetSha256",
    "disposition", "requiredBasePaths", "requiredCandidatePaths", "generatedFiles", "requiredAbsentBasePaths", "model", "sourceClosureSha256",
    "requestedSuccessorGeneration", "publicationReceiptSha256", "modelState", "semanticEvidence", "candidateManifestSha256",
    ...(Object.hasOwn(value, "carriedFrom") ? ["carriedFrom"] : []), ...(Object.hasOwn(value, "projectionReview") ? ["projectionReview"] : [])]);
  need(value.schemaVersion === 1 && value.kind === "docsfab-product-feedback-candidate-manifest" &&
    PRODUCT_FEEDBACK_MATERIALIZER_VERSIONS.includes(value.materializerVersion));
  verify(value, "candidateManifestSha256"); binding(value.binding); revision(value.baseRevision);
  need(Number.isSafeInteger(value.baselineGeneration) && value.baselineGeneration >= 0);
  for (const key of ["baselineSha256", "approvedParentModelSha256", "recipeSha256", "targetRoutePolicySha256", "sourceClosureSha256"]) hash(value[key]);
  const proposal = recipeShape(value.recipe);
  need(["unapproved", "keep-approved", "matching-owner-decision", "record-only"].includes(value.disposition) &&
    (proposal === null) === (value.disposition === "record-only"));
  // A carried candidate's decision, recipe and comparison stand on the generation the decision was made against.
  const carried = Object.hasOwn(value, "carriedFrom") ? value.carriedFrom : null;
  if (carried !== null) {
    keys(carried, ["baselineGeneration", "baselineSha256", "modelSha256"]); hash(carried.baselineSha256); hash(carried.modelSha256);
    need(Number.isSafeInteger(carried.baselineGeneration) && carried.baselineGeneration >= 0 && carried.baselineGeneration < value.baselineGeneration &&
      proposal !== null && ["keep-approved", "matching-owner-decision"].includes(value.disposition));
  }
  const decided = carried === null ? { baselineSha256: value.baselineSha256, modelSha256: value.approvedParentModelSha256 } : carried;
  if (Object.hasOwn(value, "projectionReview")) {
    const review = value.projectionReview; keys(review, ["code", "removed"]);
    need(value.materializerVersion === PRODUCT_FEEDBACK_MATERIALIZER_VERSION && review.code === PROJECTION_REVIEW_CODE &&
      Array.isArray(review.removed) && review.removed.length > 0 && value.recipe.targets.length > 0);
    for (const span of review.removed) {
      keys(span, ["path", "bytes", "sha256"]); path(span.path); hash(span.sha256);
      need(Number.isSafeInteger(span.bytes) && span.bytes > 0 && value.recipe.targets.some(target => target.path === span.path));
    }
  }
  if (proposal === null) need(value.approvalTargetSha256 === null);
  else need(proposal.target.approvedParentModelSha256 === decided.modelSha256 && proposal.target.targetSha256 === value.approvalTargetSha256);
  need(value.recipeSha256 === recipeIdentityDigest(value.baselineSha256, value.recipe, value.decisionRegistrationSha256, value.disposition) &&
    equal(value.recipe.binding, value.binding) && value.recipe.baseRevision === value.baseRevision &&
    value.recipe.comparison.baselineSha256 === decided.baselineSha256 && value.recipe.targetRoutePolicySha256 === value.targetRoutePolicySha256);
  if (["unapproved", "record-only"].includes(value.disposition)) need(value.decisionRegistrationSha256 === null);
  else hash(value.decisionRegistrationSha256);
  need(value.publicationReceiptSha256 === null && value.modelState === "candidate" && value.semanticEvidence === false);
  need(Number.isSafeInteger(value.requestedSuccessorGeneration) && value.requestedSuccessorGeneration === value.baselineGeneration + 1);
  const paths = list => {
    need(Array.isArray(list) && list.length > 0); list.forEach(path);
    need(new Set(list).size === list.length && equal(list, [...list].sort())); return list;
  };
  const base = paths(value.requiredBasePaths), absent = paths(value.requiredAbsentBasePaths), candidate = paths(value.requiredCandidatePaths);
  need(!absent.some(name => base.includes(name)) && equal(candidate, [...base, ...absent].sort()));
  need(Array.isArray(value.generatedFiles) && value.generatedFiles.length > 0);
  for (const file of value.generatedFiles) { keys(file, ["path", "sha256"]); path(file.path); hash(file.sha256); }
  keys(value.model, ["path", "sha256", "gitObjectId", "version", "streamVersion"]);
  path(value.model.path); hash(value.model.sha256); revision(value.model.gitObjectId);
  const location = /^\.docsfab\/reference-model\/shared\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(v\d+\.\d+)\/model\.md$/u.exec(value.model.path);
  need(location && location[2] === value.model.version && value.model.version === value.recipe.metadata.successorVersion &&
    Number.isSafeInteger(value.model.streamVersion) && value.model.streamVersion > 0 && (proposal === null || location[1] === proposal.target.modelId));
  // Every disposition writes one complete version: its three package files, one source thread, the history row and the index pointer.
  const directory = value.model.path.slice(0, -"/model.md".length), history = historyPath(location[1]);
  const generated = paths(value.generatedFiles.map(file => file.path)), targetPaths = value.recipe.targets.map(target => target.path);
  need([...targetPaths, history, modelIndexPath].every(name => base.includes(name)) &&
    equal(generated, [...absent, ...targetPaths, history, modelIndexPath].sort()) &&
    value.generatedFiles.find(file => file.path === value.model.path)?.sha256 === value.model.sha256);
  const artifact = value.generatedFiles.filter(file => file.path.startsWith(sourceRoot) && file.path.includes("/artifacts/sha256/"));
  need(artifact.length === 1);
  const sha = artifact[0].sha256, suffix = sha.slice(0, 32), thread = `${sourceRoot}SRC-FEEDBACK-${suffix}`;
  need(artifact[0].path === `${thread}/artifacts/sha256/${sha.slice(0, 2)}/${sha}` && equal(absent, [
    `${directory}/model.md`, `${directory}/inconsistency-report.md`, `${directory}/merge-receipt.md`,
    `${thread}/thread.json`, `${thread}/items/ITEM-FEEDBACK-${suffix}.json`, `${thread}/events.jsonl`, artifact[0].path, `${thread}/views/thread.md`,
    ...(value.disposition === "keep-approved" ? [`.docsfab/reference-model/proposals/${value.recipeSha256}.json`] : [])].sort()));
  return freeze(value);
}

/** Files a candidate reads at its base revision: the parent snapshot, the routed documents, the history index and the model index. */
export function requiredProductFeedbackBasePaths(input) {
  const value = copy(input); keys(value, ["baseline", "recipe"]);
  const snapshot = value.baseline?.snapshot;
  need(snapshot && Array.isArray(snapshot.files) && Array.isArray(value.recipe?.targets)); id(snapshot.modelId);
  const paths = [...snapshot.files.map(file => file?.path), ...value.recipe.targets.map(target => target?.path), historyPath(snapshot.modelId), modelIndexPath];
  paths.forEach(path);
  return [...new Set(paths)].sort();
}

export function productFeedbackTargetRoutePolicySha256(input) {
  const routes = copy(input); need(Array.isArray(routes));
  const seen = new Set();
  for (const route of routes) {
    keys(route, ["claimId", "targetId", "path", "delivery", "heading", "beforeText"]);
    id(route.claimId); id(route.targetId); path(route.path); text(route.heading);
    need(["repository-planning", "public-documentation"].includes(route.delivery));
    if (route.beforeText !== null) { text(route.beforeText); need(!/[\r\n]/u.test(route.beforeText)); }
    const key = `${route.claimId}\0${route.targetId}`; need(!seen.has(key)); seen.add(key);
  }
  routes.sort((a, b) => order(`${a.claimId}\0${a.targetId}`, `${b.claimId}\0${b.targetId}`));
  return digest({ schemaVersion: 1, kind: "docsfab-product-feedback-target-routes", routes });
}

/** The host supplies its protected route configuration; a serialized recipe cannot choose it. */
export function assertProductFeedbackTargetRoutes(input) {
  const value = copy(input); keys(value, ["manifest", "routes"]);
  const expected = productFeedbackTargetRoutePolicySha256(value.routes);
  need(value.manifest.targetRoutePolicySha256 === expected && value.manifest.recipe.targetRoutePolicySha256 === expected);
  for (const target of value.manifest.recipe.targets) {
    const { baseSha256, ...route } = target; hash(baseSha256);
    need(value.routes.some(configured => equal(configured, route)));
  }
}

/** Replace one actual H2 section, never a marker hidden in a fence or nested block. */
function replaceSection(content, target, claimId, replacement, priorForms) {
  need(typeof content === "string" && bytesHash(content) === target.baseSha256);
  const lines = content.split(/(?<=\n)/u); let offset = 0, start = null, end = content.length, fence = null, found = 0, comment = false;
  for (const value of lines) {
    if (fence === null && (comment || value.includes("<!--"))) {
      comment = value.lastIndexOf("<!--") > value.lastIndexOf("-->") || (comment && !value.includes("-->"));
      offset += value.length; continue;
    }
    const opener = /^( {0,3})(`{3,}|~{3,})/u.exec(value);
    if (opener) {
      if (fence === null) fence = opener[2];
      else if (opener[2][0] === fence[0] && opener[2].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(value)) fence = null;
    } else if (fence === null && /^##? /u.test(value)) {
      const heading = value.trimEnd();
      if (start !== null && end === content.length) end = offset;
      if (heading === `## ${target.heading}`) { found++; start = offset; end = content.length; }
    }
    offset += value.length;
  }
  need(found === 1 && start !== null && fence === null);
  const section = content.slice(start, end), rows = section.split(/(?<=\n)/u), eligible = [];
  offset = 0; fence = null; comment = false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], opener = /^( {0,3})(`{3,}|~{3,})/u.exec(row);
    const usable = fence === null && !comment && opener === null;
    eligible.push({ index, offset, text: row.trimEnd(), usable, length: row.length });
    if (opener) {
      if (fence === null) fence = opener[2];
      else if (opener[2][0] === fence[0] && opener[2].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(row)) fence = null;
    } else if (fence === null && (comment || row.includes("<!--"))) {
      comment = row.lastIndexOf("<!--") > row.lastIndexOf("-->") || (comment && !row.includes("-->"));
    }
    offset += row.length;
  }
  const open = `<!-- docsfab:claim:${claimId}:start -->`, close = `<!-- docsfab:claim:${claimId}:end -->`;
  const starts = eligible.filter(row => row.usable && row.text === open), ends = eligible.filter(row => row.usable && row.text === close);
  let begin, finish;
  if (starts.length || ends.length) {
    need(starts.length === 1 && ends.length === 1 && starts[0].offset < ends[0].offset);
    begin = starts[0].offset; finish = ends[0].offset + ends[0].length;
    // Generated regions may not absorb an intervening human edit. Recognize
    // only the bounded prior forms of this exact approved claim and scope.
    need(priorForms.includes(section.slice(begin, finish)));
  } else {
    need(target.beforeText !== null);
    const matches = eligible.filter(row => row.usable && row.text === target.beforeText &&
      rows[row.index - 1]?.trim() === "" && (rows[row.index + 1]?.trim() ?? "") === "");
    need(matches.length === 1); begin = matches[0].offset; finish = begin + matches[0].length;
  }
  return content.slice(0, start + begin) + replacement + content.slice(start + finish);
}

/**
 * A row that is exactly one DocsFab claim-region marker, indented as far as CommonMark still reads
 * an HTML block (three spaces); the capture is the marker without its indentation.
 */
const CLAIM_MARKER = /^ {0,3}(<!-- docsfab:claim:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}:(?:start|end) -->)$/u;

/**
 * The rows of a Markdown text, each marked usable when it lies outside fenced code and HTML
 * comment blocks, and the fence or comment still open at its end. As in CommonMark, only a row
 * that begins with `<!--` opens a comment block, so an escaped `\<!--` (as `line()` writes one),
 * or one inside a paragraph or inline code, opens nothing. A claim-region marker row outside a
 * fence is always usable: it is a complete comment, so it also closes a comment block left
 * open above it.
 */
function markdownRows(content) {
  const rows = []; let offset = 0, fence = null, comment = false;
  for (const row of content.split(/(?<=\n)/u)) {
    // A backtick fence's info string may not hold a backtick (CommonMark), so `` ```js``` `` is inline code.
    const fenced = /^( {0,3})(`{3,}|~{3,})(.*)/u.exec(row), opener = fenced && !(fenced[2][0] === "`" && fenced[3].includes("`")) ? fenced : null;
    const found = fence === null ? CLAIM_MARKER.exec(row.trimEnd()) : null;
    const marker = found !== null, text = found ? found[1] : row.trimEnd();
    rows.push({ index: rows.length, offset, row, text, usable: marker || (fence === null && !comment && opener === null) });
    if (fence !== null) {
      if (opener && opener[2][0] === fence[0] && opener[2].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(row)) fence = null;
    } else if (marker) comment = false;
    else if (comment) comment = !row.includes("-->");
    else if (opener) fence = opener[2];
    else if (/^ {0,3}<!--/u.test(row)) comment = !row.slice(row.indexOf("<!--") + 4).includes("-->");
    offset += row.length;
  }
  return { rows, fence, comment };
}

/**
 * A v4 projection: the claim's statement as one paragraph, then where in the model it comes from.
 * `line()` escapes backticks; a leading tilde is escaped too, so no statement opens a code fence
 * that would hide the region's end marker.
 */
function renderProjection(claim, modelId, version) {
  return [`<!-- docsfab:claim:${claim.claim_id}:start -->`, line(claim.statement).replace(/^( {0,3})~/u, "$1\\~"), "",
    `_Model claim \`${claim.claim_id}\` in \`${modelId}\` ${version}. Scope: ${scopeText(claim.scope)}._`,
    `<!-- docsfab:claim:${claim.claim_id}:end -->`, ""].join("\n");
}

/**
 * A model-written placement (v4): `beforeText` is one standalone line, between blank lines, of
 * the one usable `## heading` section, and the region replaces it. The rows are `markdownRows`',
 * so an inline or escaped `<!--` hides nothing. Throws when the line cannot be placed exactly once.
 */
function placeBeforeText(content, target, replacement) {
  const rows = markdownRows(content).rows;
  const headings = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.usable && /^##? /u.test(row.row));
  const section = headings.filter(({ row }) => row.text === `## ${target.heading}`);
  need(section.length === 1);
  const from = section[0].index, to = headings.find(({ index }) => index > from)?.index ?? rows.length;
  // As in v3, the section's end counts as a blank line after it.
  const blank = index => index >= to || rows[index].row.trim() === "";
  const matches = rows.slice(from + 1, to).map((row, offset) => ({ row, index: from + 1 + offset }))
    .filter(({ row, index }) => row.usable && row.text === target.beforeText && blank(index - 1) && blank(index + 1));
  need(matches.length === 1);
  const line = matches[0].row;
  return content.slice(0, line.offset) + replacement + content.slice(line.offset + line.row.length);
}

/** The blank-line separation a Markdown block needs after `text`. */
const separated = text => text === "" || text.endsWith("\n\n") ? text : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;

/**
 * One routed document with the decided claim projected (v4), and the coded notes of anything it
 * repaired. No document shape stops a decision, and none grows a second region:
 *
 * - The claim's markers pair in order, a start with the next end. The first region takes the
 *   projection where it stands; every later region and every unpaired marker is removed
 *   (`projection-markers-normalised`). So a later decision on the claim replaces its region, and
 *   re-applying a decision leaves the bytes unchanged. A replaced or removed region that holds
 *   more than DocsFab's own statement and metadata line is someone's text: it is reported in
 *   `removed` (path, byte count, digest), and the candidate needs a human review before it merges.
 * - Without a region, a model-written placement (`beforeText`) replaces its line under its
 *   heading (`placeBeforeText`, the v3 rule on these rows); one that cannot be placed falls back
 *   to the generated section (`projection-placement-not-found`).
 * - Otherwise the region is appended at the end of the generated section, created at the end of
 *   the document when absent. A fence or comment block the document leaves open is closed first
 *   (`projection-unclosed-fence-closed`, `projection-unclosed-comment-closed`), so the region is
 *   neither code nor hidden, and the next pass finds it.
 */
function projectDocument(content, target, claim, modelId, version) {
  need(typeof content === "string" && bytesHash(content) === target.baseSha256);
  const replacement = renderProjection(claim, modelId, version), notes = [], removed = [];
  const open = `<!-- docsfab:claim:${claim.claim_id}:start -->`, close = `<!-- docsfab:claim:${claim.claim_id}:end -->`;
  const all = markdownRows(content).rows;
  // A region DocsFab wrote holds the statement line, a blank line and its own metadata line. Anything
  // else between a pair of markers is someone's text: replacing or removing it needs a human review.
  const metadata = `_Model claim \`${claim.claim_id}\` in \``;
  const review = ([first, last]) => {
    const body = all.slice(first.index + 1, last.index);
    if (body.length === 3 && body[0].text.trim() !== "" && body[1].text.trim() === "" && body[2].text.startsWith(metadata) &&
        /` v\d+\.\d+\. Scope: .*\._$/u.test(body[2].text)) return;
    const text = content.slice(first.offset + first.row.length, last.offset);
    removed.push({ path: target.path, bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text).digest("hex") });
  };
  const pairs = [], stray = []; let pending = null;
  for (const row of all) {
    if (!row.usable) continue;
    if (row.text === open) { if (pending) stray.push(pending); pending = row; }
    else if (row.text === close) { if (pending) { pairs.push([pending, row]); pending = null; } else stray.push(row); }
  }
  if (pending) stray.push(pending);
  if (pairs.length > 1 || stray.length) notes.push("projection-markers-normalised");
  pairs.forEach(review);
  const edits = [...pairs.slice(1).map(([first, last]) => [first.offset, last.offset + last.row.length, ""]),
    ...stray.map(row => [row.offset, row.offset + row.row.length, ""]),
    ...pairs.slice(0, 1).map(([first, last]) => [first.offset, last.offset + last.row.length, replacement])].sort((a, b) => a[0] - b[0]);
  let body = "", at = 0;
  for (const [from, to, text] of edits) { body += content.slice(at, from) + text; at = to; }
  body += content.slice(at);
  if (pairs.length) return { content: body, notes, removed };
  let heading = target.heading;
  if (target.beforeText !== null) {
    try { return { content: placeBeforeText(body, target, replacement), notes, removed }; }
    catch { notes.push("projection-placement-not-found"); heading = PRODUCT_FEEDBACK_PROJECTION_HEADING; }
  }
  const state = markdownRows(body), ended = body === "" || body.endsWith("\n") ? body : `${body}\n`;
  if (state.fence !== null) { body = `${ended}${state.fence}\n`; notes.push("projection-unclosed-fence-closed"); }
  else if (state.comment) { body = `${ended}-->\n`; notes.push("projection-unclosed-comment-closed"); }
  const rows = markdownRows(body).rows, found = rows.findIndex(row => row.usable && row.text === `## ${heading}`);
  if (found < 0) return { content: `${separated(body)}## ${heading}\n\n${PROJECTION_INTRODUCTION}\n\n${replacement}`, notes, removed };
  const end = rows.slice(found + 1).find(row => row.usable && /^##? /u.test(row.row))?.offset ?? body.length;
  const after = body.slice(end);
  return { content: separated(body.slice(0, end)) + replacement + (after === "" ? "" : `\n${after}`), notes, removed };
}

function renderSection(target, claim, approval, sources) {
  const issueOnly = sources.every(source => source.sourceKind.startsWith("issue-"));
  return [`<!-- docsfab:claim:${claim.claim_id}:start -->`, line(claim.statement), "", `Scope: ${scopeText(claim.scope)}.`, "",
    approval === "keep-approved" ? "The approved requirement remains unchanged. Any corrective implementation needs separate validation." :
      "This is a candidate requirement. Shipped behavior is not established by this projection.",
    issueOnly ? "The supporting issue sources describe proposed intent; closure does not establish implementation." :
      "Source observations and owner intent are distinct from behavior verification.", "",
    `Model claim: \`${claim.claim_id}\`.`, `<!-- docsfab:claim:${claim.claim_id}:end -->`, ""].join("\n");
}

/** Explicitly derived metadata; it never reconstructs or republishes a protected Slack message.
 * A record-only thread observes the consistent input itself; every other thread records the decision bindings. */
function sourcePackage(recipe, approved, recipeSha256, modelId, version) {
  const decision = approved.evidence, observation = approved.disposition === "record-only";
  const origin = !observation ? "derived-decision" : recipe.sourceVersions.every(source => source.sourceKind.startsWith("issue-")) ? "repository-issue" : "repository-merge";
  const artifactType = observation ? "source-observation" : "decision";
  const payload = { schemaVersion: 1, kind: "docsfab-derived-feedback-source", sourceVersions: recipe.sourceVersions,
    comparisonReceiptSha256: recipe.comparison.receiptSha256, semanticDeltaSha256: recipe.proposal?.delta.deltaSha256 ?? null,
    decision: decision ? { registrationSha256: decision.source.registrationSha256, answerSha256: decision.answer.answerSha256,
      custodySha256: decision.custody.custodySha256, principalId: decision.answer.principalId,
      authorityReceiptSha256: decision.answer.authorityReceiptSha256,
      ...(decision.kind === "docsfab-verified-merge-decision-source" ? {
        sourceKind: "genuine-merge-decision", reconciliationId: decision.continuation.reconciliationId,
        continuationAnchorSha256: decision.continuation.anchor.anchorSha256, questionId: decision.question.questionId,
        questionSha256: decision.question.questionSha256, semanticOfferSha256: decision.offer.offerSha256,
        mergeAnchorSha256: decision.offer.mergeAnchorSha256, findingSha256: decision.offer.findingSha256,
        ...(decision.offer.comparisonCase ? { comparisonCase: decision.offer.comparisonCase } : {}),
        ...(decision.offer.reanalysisOf ? { reanalysisOf: decision.offer.reanalysisOf } : {}),
        sourceRegisteredAt: decision.sourceRegisteredAt, approvalTargetSha256: decision.approvalTargetSha256,
        selectedOptionId: decision.selectedOptionId,
      } : decision.kind === "docsfab-verified-merge-advisory-decision-source" ? {
        // No offer names this decision: it is the owner's own free-text
        // answer to a no-offer question, so there is no semantic offer,
        // merge anchor variant, or selected option to record -- only the
        // question and the governed statement independently re-derived from it.
        sourceKind: "genuine-merge-advisory-decision", reconciliationId: decision.continuation.reconciliationId,
        continuationAnchorSha256: decision.continuation.anchor.anchorSha256, questionId: decision.question.questionId,
        questionSha256: decision.question.questionSha256, findingSha256: decision.question.confidenceBasisSha256,
        sourceRegisteredAt: decision.sourceRegisteredAt, governedStatementContentSha256: decision.decision.statementContentSha256,
      } : { approvalTargetSha256: decision.source.approvalTargetSha256, selectedOptionId: decision.answer.selectedOptionId }) } : null,
    rawMessageIncluded: false, evidenceRole: "derived-metadata", recipeSha256 };
  const content = `${canonical(payload)}\n`, contentSha256 = bytesHash(content);
  const suffix = contentSha256.slice(0, 32), threadId = `SRC-FEEDBACK-${suffix}`, itemId = `ITEM-FEEDBACK-${suffix}`;
  const directory = `${sourceRoot}${threadId}`, artifact = `artifacts/sha256/${contentSha256.slice(0, 2)}/${contentSha256}`;
  const createdAt = recipe.metadata.createdAt;
  const thread = { schema_version: "docsfab.knowledge.source-thread/v1", thread_id: threadId,
    origin: { kind: origin, identity: "docsfab-product-feedback-materializer", identity_state: "derived" },
    created_at: createdAt, access: { classification: "project-restricted" }, item_ids: [itemId], relations: [],
    event_log: "events.jsonl", head_event_ids: [`EVT-FEEDBACK-${suffix}-2`] };
  const item = { schema_version: "docsfab.knowledge.source-item/v2", item_id: itemId, thread_id: threadId,
    artifact_type: artifactType, governed_visual: false, title: observation ? "Derived input observation bindings" : "Derived product feedback evidence bindings",
    attribution: { author: "DocsFab materializer (derived metadata)", contributors: [], collector: "docsfab-product-feedback-materializer" },
    timestamps: { source_created_at: null, ingested_at: createdAt }, version: { kind: "content-hash", value: `sha256:${contentSha256}` },
    scope: { product_version: recipe.metadata.successorVersion, deployment: recipe.binding.deploymentId,
      audience: "project-restricted", model_region: recipe.proposal?.delta.changes[0].claimId ?? modelId },
    representations: [{ representation_id: "derived-feedback-bindings", role: "derived-metadata", media_type: "application/json",
      original_filename: "feedback-bindings.json", size_bytes: Buffer.byteLength(content),
      locator: { scheme: "thread-artifact", uri: artifact, repository: null, commit: null, path: null, external_version: null, retained_copy: artifact },
      integrity: { algorithm: "sha256", value: contentSha256 }, derived_from: [],
      transform: { tool: version, version: "1", method: observation ?
        "Structured references to the consistent input's source versions; no verbatim reconstruction." :
        "Structured references to source versions and protected decision custody; no verbatim reconstruction.", review_state: "candidate" } }],
    members: [], governance: { consent: "Consult protected original source custody; this artifact grants no authority.",
      citation_boundary: "Derived binding identifiers only.", retention_boundary: "Retain with the immutable candidate.",
      redistribution_boundary: "No wider source disclosure is granted.", access_classification: "project-restricted" },
    lineage: { parent_item_ids: [], supersedes: [], related_item_ids: [] }, evidence_state: "transformed",
    limitations: ["Generated metadata is not independent evidence or the original owner message."] };
  const events = [1, 2].map(sequence => ({ schema_version: "docsfab.knowledge.source-event/v1", event_id: `EVT-FEEDBACK-${suffix}-${sequence}`,
    thread_id: threadId, sequence, occurred_at: createdAt, actor: "docsfab-product-feedback-materializer",
    event_type: sequence === 1 ? "thread.created" : "item.registered", item_id: sequence === 1 ? null : itemId,
    parent_event_ids: sequence === 1 ? [] : [`EVT-FEEDBACK-${suffix}-1`], payload: { recipeSha256, evidenceRole: "derived-metadata" } }));
  const view = ["<!-- Generated from thread.json, items/*.json, and events.jsonl. Do not edit. -->", "", `# Source Thread: ${threadId}`, "",
    `- **Origin:** \`${origin}\` — \`docsfab-product-feedback-materializer\``, "- **Identity state:** `derived`",
    `- **Created:** \`${createdAt}\``, "- **Access:** `project-restricted`", `- **Event heads:** \`EVT-FEEDBACK-${suffix}-2\``, "",
    "## Items", "", "| Item | Type | Title | Version | Representations or members |", "| --- | --- | --- | --- | --- |",
    `| \`${itemId}\` | \`${artifactType}\` | ${item.title} | \`sha256:${contentSha256}\` | 1 |`, "", "## Event Ledger", "",
    "| Sequence | Event | Type | Item | Time |", "| ---: | --- | --- | --- | --- |",
    ...events.map(event => `| ${event.sequence} | \`${event.event_id}\` | \`${event.event_type}\` | ${event.item_id ? `\`${event.item_id}\`` : "—"} | \`${createdAt}\` |`), "",
    "This Markdown file is a derived view. The JSON records and JSONL ledger are canonical.", ""].join("\n");
  return { threadId, itemId, artifactSha256: contentSha256, files: { [`${directory}/thread.json`]: `${canonical(thread)}\n`,
    [`${directory}/items/${itemId}.json`]: `${canonical(item)}\n`, [`${directory}/events.jsonl`]: events.map(event => canonical(event)).join("\n") + "\n",
    [`${directory}/${artifact}`]: content, [`${directory}/views/thread.md`]: view } };
}

/** A record-only envelope has `change: null` and renders no claim section. */
export function renderProductFeedbackModel(model) {
  const claim = model.change === null ? null : model.change.record;
  return [PRODUCT_FEEDBACK_MODEL_MARKER, `# ${model.modelId} Product Reference Model ${model.version}`, "",
    "This immutable candidate inherits all unchanged claims, source records, conflicts, and prose from its parent.",
    "Approval and publication are verified separately by the host.", "", "```json", canonical(model), "```", "",
    ...(claim === null ? [] : [`## ${claim.claim_id}`, "", line(claim.statement), "", `Scope: ${scopeText(claim.scope)}.`, ""])].join("\n");
}

// Report and receipt YAML uses JSON strings, plus escapes for the code points YAML reads as line breaks or refuses.
const yamlString = value => JSON.stringify(String(value)).replace(/[\u007f-\u009f\u2028\u2029\ufffe\uffff]/gu,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const yamlList = values => `[${values.map(yamlString).join(", ")}]`;
const yamlScope = scope => `{${Object.entries(scope ?? {}).sort(([a], [b]) => order(a, b))
  .map(([key, value]) => `${yamlString(key)}: ${yamlString(Array.isArray(value) ? value.join("; ") : value)}`).join(", ")}}`;

/**
 * The conflict and adjudication a version records, from the recipe and the registered decision only.
 * From v3 an advisory decision's record carries its rendered decision (conflict id, decision source and
 * the owner's rationale) as the rationale, beside the claim statement the owner's wording became.
 */
function adjudicationRecord(recipe, proposal, approved, source, version) {
  if (proposal === null) return null;
  const evidence = approved.evidence, claimId = proposal.before.id;
  // The advisory kind retains the SAME `question` shape a semantic offer's
  // decision does (no offer, but still a real reconciliation question), so
  // it reads the real conflict id and classification exactly like the
  // offer-bearing kind, rather than falling into the generic-feedback naming
  // below (which is for legacy, question-less model-conflict evidence only).
  const merge = evidence?.kind === "docsfab-verified-merge-decision-source" ||
    evidence?.kind === "docsfab-verified-merge-advisory-decision-source";
  // The package checker indexes conflict records by `CONFLICT-*` headings; a merge question's id keeps its digest suffix.
  const conflictId = merge ? `CONFLICT-${String(evidence.question.conflictId).replace(/^conflict-/u, "").replace(/[^A-Za-z0-9._-]/gu, "-")}` :
    `CONFLICT-FEEDBACK-${digest({ comparisonReceiptSha256: recipe.comparison.receiptSha256, claimId, semanticDeltaSha256: recipe.proposal.delta.deltaSha256 }).slice(0, 32)}`;
  return { conflictId, claimId, before: proposal.before, after: proposal.change.after, itemId: source.itemId, kept: approved.disposition === "keep-approved",
    classification: merge ? evidence.question.classification : "intent-conflict",
    status: evidence ? "resolved" : "open", owner: evidence ? evidence.answer.principalId : "Accountable product owner; no decision is registered.",
    adjudicator: evidence ? evidence.answer.principalId : "none",
    authorityBasis: evidence ? `${evidence.source.sourceKind} receipt ${evidence.answer.authorityReceiptSha256}` : "none",
    decidedAt: evidence ? evidence.answer.receivedAt ?? evidence.source.registeredAt : "none", disposition: evidence ? "accept-variant" : "none",
    rationale: !evidence ? "none" : evidence.kind === "docsfab-verified-merge-advisory-decision-source" && version !== LEGACY_TEMPLATE_STATEMENT_VERSION
      ? `${evidence.decision.statement} Protected decision custody ${evidence.custody.custodySha256}.`
      : `Protected decision custody ${evidence.custody.custodySha256}; the original reply is not reproduced.` };
}

function renderInconsistencyReport({ baseline, recipe, version, record, source }) {
  const snapshot = baseline.snapshot, conflicts = snapshot.openConflicts;
  const lines = [`# ${snapshot.modelId} Product Reference Model ${version}: Inconsistency Report`, "", "## Comparison Boundary", "",
    `- Prior model: \`${snapshot.modelId}\` \`${snapshot.version}\`, model SHA-256 \`${snapshot.modelSha256}\`.`,
    `- Comparison receipt SHA-256: \`${recipe.comparison.receiptSha256}\`.`,
    `- Input source versions: ${recipe.sourceVersions.map(item => `\`${item.sourceVersionSha256}\``).join(", ")}.`,
    `- Source record: \`${source.itemId}\` in \`${source.threadId}\`.`, ""];
  if (record === null) lines.push("No inconsistencies were found between this input and the approved model. No claim changes, so no decision is required.", "");
  else {
    const offered = record.itemId, evidence = recipe.sourceVersions.map(item => `source-version:${item.sourceVersionSha256}`).sort();
    lines.push(`## ${record.conflictId}: ${record.claimId}`, "", "```yaml", `conflict_id: ${record.conflictId}`, `status: ${record.status}`,
      `classification: ${record.classification}`,
      `summary: ${yamlString(`An input offers a variant of ${record.claimId} that differs from its approved statement or scope.`)}`, "source_variants:",
      `  - source_claim_ids: ${yamlList([record.claimId])}`, `    statement: ${yamlString(record.before.record.statement)}`,
      `    scope: ${yamlScope(record.before.record.scope)}`,
      `    exact_evidence: ${yamlList([`Approved ${snapshot.modelId} ${snapshot.version} claim record SHA-256 ${record.before.recordSha256}.`])}`,
      `  - source_claim_ids: ${yamlList(evidence)}`, `    statement: ${yamlString(record.after.statement)}`, `    scope: ${yamlScope(record.after.scope)}`,
      `    exact_evidence: ${yamlList([`Comparison receipt SHA-256 ${recipe.comparison.receiptSha256}.`, `Offered semantic delta SHA-256 ${recipe.proposal.delta.deltaSha256}.`])}`,
      `why_inconsistent: ${yamlString(`The approved claim and the offered variant cannot both be canonical for ${record.claimId} in the same scope.`)}`,
      `consequence_if_unresolved: ${yamlString(`The model would carry two incompatible statements for ${record.claimId}.`)}`,
      `resolution_owner: ${yamlString(record.owner)}`, "blocks_targets: []", "adjudication:",
      `  adjudicator: ${yamlString(record.adjudicator)}`, `  authority_basis: ${yamlString(record.authorityBasis)}`,
      `  decided_at: ${yamlString(record.decidedAt)}`, `  disposition: ${record.disposition}`, `  rationale: ${yamlString(record.rationale)}`,
      `  decision_evidence: ${yamlList([offered])}`, `  resulting_claim_ids: ${yamlList([record.claimId])}`, "```", "",
      record.status === "open" ? "No decision is registered, so this candidate cannot be published." :
        record.kept ? "The accountable decision keeps the approved claim; the offered variant is not adopted." :
          "The accountable decision adopts the offered variant.", "");
  }
  lines.push("## Inherited Open Conflicts", "", ...(conflicts.length ? conflicts.map(item => `- \`${item.id}\` from \`${item.sourcePath}\`.`) :
    ["The parent model has no open conflict."]), "");
  if (record !== null) lines.push("## Queue Result", "", record.status === "resolved" ? "Resolved: `1/1`. Open: `0/1`." : "Resolved: `0/1`. Open: `1/1`.", "");
  return lines.join("\n");
}

/** The top-level section 14 `yaml visual-closure-receipt` fence; fences, comments and deeper blocks never count. */
function visualClosureReceipt(text) {
  let offset = 0, fence = null, comment = false, section = false, start = null;
  for (const row of text.split(/(?<=\n)/u)) {
    const value = row.replace(/\r?\n$/u, ""), marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(value);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        if (start !== null) return text.slice(start, offset + value.length);
        fence = null;
      }
    } else if (comment) comment = !value.includes("-->");
    else if (/^ {0,3}<!--/u.test(value)) comment = !value.includes("-->");
    else if (marker) { fence = marker[1]; if (section && marker[2].trim() === "yaml visual-closure-receipt") start = offset; }
    else if (/^#{1,2} /u.test(value)) section = value.startsWith("## 14. ");
    offset += row.length;
  }
  return null;
}

/** The legacy ancestor's receipt, when the parent snapshot retains one (the projector reads exactly one). */
function legacyReceipt(snapshot, files) {
  const prefix = `.docsfab/reference-model/shared/${snapshot.modelId}/`;
  const receipts = snapshot.files.map(file => file.path).filter(name => name.startsWith(prefix) && /^v\d+\.\d+\/merge-receipt\.md$/u.test(name.slice(prefix.length)));
  need(receipts.length <= 1);
  return receipts.length ? { version: receipts[0].slice(prefix.length).split("/")[0], text: bytes(files[receipts[0]]).toString("utf8") } : null;
}

function renderMergeReceipt({ baseline, recipe, recipeSha256, version, claim, record, source, approved, proposalPath, receipt, projectionNotes = [] }) {
  const snapshot = baseline.snapshot, id = record?.claimId, delta = recipe.proposal?.delta.deltaSha256;
  const mode = record === null ? "record" : record.status === "open" ? "open" : record.kept ? "kept" : "replaced";
  const inherited = snapshot.openConflicts.map(item => `\`${item.id}\``).join(", ") || "none";
  const carried = receipt === null ? null : visualClosureReceipt(receipt.text);
  const sections = [
    ["Boundary and Prior Version", [`- Model: \`${snapshot.modelId}\``, `- Version: \`${version}\``, `- Prior version: \`${snapshot.version}\``,
      `- Prior model SHA-256: \`${snapshot.modelSha256}\``, `- Recipe SHA-256: \`${recipeSha256}\``, `- Disposition: \`${approved.disposition}\``]],
    ["Exact Inputs", ["| Input | Version and integrity |", "| --- | --- |",
      `| \`${snapshot.modelId} ${snapshot.version}\` | model SHA-256 \`${snapshot.modelSha256}\`; source closure \`${snapshot.sourceClosureSha256}\` |`,
      ...recipe.sourceVersions.map(item => `| \`${item.sourceId}\` | \`${item.sourceKind}\` version \`${item.version}\`; source version SHA-256 \`${item.sourceVersionSha256}\`; content SHA-256 \`${item.contentSha256}\` |`),
      `| Comparison | receipt SHA-256 \`${recipe.comparison.receiptSha256}\` |`,
      `| \`${source.itemId}\` | artifact SHA-256 \`${source.artifactSha256}\` in \`${source.threadId}\` |`]],
    ["Included and Added Claims", [["replaced", "open"].includes(mode) ? `- Every parent claim is inherited unchanged except \`${id}\`, listed below.` :
      "- Every parent claim is inherited unchanged.", "- No claim is added."]],
    ["Superseded and Excluded Claims", [mode === "replaced" ? `- \`${id}\` record SHA-256 \`${record.before.recordSha256}\` is superseded by record SHA-256 \`${digest(claim)}\`.` :
      mode === "open" ? `- \`${id}\` is replaced in this candidate only; nothing is superseded until a decision is registered.` : "- No claim is superseded or excluded."]],
    ["Rescoped and Variant Claims", [mode === "record" ? "- None." : mode === "replaced" ? `- The offered variant (semantic delta \`${delta}\`) becomes \`${id}\`.` :
      mode === "kept" ? `- The offered variant (semantic delta \`${delta}\`) is not adopted; \`${id}\` keeps its approved statement and scope.` :
        `- The offered variant (semantic delta \`${delta}\`) awaits a decision.`]],
    ["Unresolved Conflicts and Routing Owners", [mode === "record" ? "- No conflict was found for this input." : mode === "open" ?
      `- \`${record.conflictId}\` is open; routing owner: the accountable product owner.` : `- \`${record.conflictId}\` is resolved.`,
    `- Inherited open conflicts: ${inherited}.`]],
    ["Behavior Evidence and Accountable Intent", [mode === "record" ? "- No accountable decision is required: the input is consistent with the approved model." :
      mode === "open" ? "- No accountable decision is registered." :
        `- Accountable decision: \`${line(record.adjudicator)}\`, ${line(record.authorityBasis)}; protected custody is cited and the original reply is not reproduced.`,
    "- No behavior verification is established by this record."]],
    ["Agent Inferences", ["- None. The materializer derives this record from the recipe, the approved parent and the registered decision."]],
    ["Documentation Targets Blocked or Unblocked", recipe.targets.length ? recipe.targets.map(target =>
      `- Updated \`${target.path}\` (target \`${target.targetId}\`, ${target.delivery}).`) : ["- No documentation target was written; the model package is the only record updated."]],
    ["Review and Approval State", ["- Model state: candidate.", `- Owner approval required: ${approved.disposition === "unapproved" ? "yes" : "no"}.`,
      "- Publication and baseline promotion are verified separately by the host."]],
    ["Exact Delta", [`- One immutable \`${version}\` package, one history row and one model-index pointer update.`,
      `- One source thread \`${source.threadId}\` with item \`${source.itemId}\`.`, ["replaced", "open"].includes(mode) ? `- \`${id}\` is replaced.` : "- No claim changes.",
      `- Documentation targets updated: ${recipe.targets.length}.`]],
    ["Failures, Interventions, and Acquisition Work", [...(mode === "kept" ?
      [`- Corrective proposal \`${proposalPath}\` records the builders' corrective work; implementation verification is not established.`] :
      projectionNotes.length ? [] : ["- None recorded by the materializer."]), ...projectionNotes]],
    ["Inconsistency Report and Transitions", ["- Report: [inconsistency-report.md](inconsistency-report.md)", ...(mode === "record" ?
      ["- Conflicts: none; the report states that no inconsistencies were found."] : mode === "open" ? [`- Open: \`${record.conflictId}\`; no decision is registered.`] :
        [`- Resolved: \`${record.conflictId}\`, open to resolved (\`accept-variant\`).`, `- Resulting claims: \`${id}\`.`])]],
    ["Governed Visual Closure", carried !== null ? [`This version changes no governed visual. The visual-closure receipt of the legacy ancestor \`${receipt.version}\` is carried unchanged.`, "", carried] :
      [receipt === null ? "This version changes no governed visual. The parent snapshot retains no legacy merge receipt, so no visual-closure receipt is carried." :
        `This version changes no governed visual. The legacy ancestor \`${receipt.version}\` records no visual-closure receipt, so none is carried.`]],
  ];
  return [`# ${snapshot.modelId} Product Reference Model ${version}: Merge Receipt`,
    ...sections.flatMap(([title, body], index) => ["", `## ${index + 1}. ${title}`, "", ...body]), ""].join("\n");
}

const historyVersions = text => text.split("\n").map(row => /^\| \[?(v\d+\.\d+)\]?/u.exec(row)?.[1]).filter(Boolean);
/** Newest first: the row goes directly under the table header, and the parent must already be listed. */
function historyWithRow(content, parentVersion, version, row) {
  need(typeof content === "string");
  const separator = "| --- | --- | --- | --- | --- |\n", at = content.indexOf(separator), versions = historyVersions(content);
  need(at >= 0 && versions.includes(parentVersion) && !versions.includes(version));
  return content.slice(0, at + separator.length) + row + content.slice(at + separator.length);
}

function historyRow({ baseline, recipe, version, record, source }) {
  const note = record === null ? "Records a consistent input; no claim changes." :
    record.status === "open" ? `Records the open conflict \`${record.conflictId}\` for \`${record.claimId}\`; no decision is registered.` :
      record.kept ? `Records the adjudication of \`${record.conflictId}\` that keeps \`${record.claimId}\`; a corrective proposal is filed.` :
        `Records the adjudication of \`${record.conflictId}\` that replaces \`${record.claimId}\`.`;
  return `| [${version}](${version}/model.md) | ${recipe.metadata.createdAt.slice(0, 10)} | Candidate | \`${baseline.snapshot.version}\`, \`${source.itemId}\` | ${note} |\n`;
}

/** Point the model index's current-model links at the new version; each link must appear exactly once. */
function indexPointingTo(content, modelId, version) {
  need(typeof content === "string");
  const lines = content.split("\n");
  for (const [pattern, replacement] of [
    [/^- \[Current product model: (v\d+\.\d+)\]\(shared\/(.+)\/(v\d+\.\d+)\/model\.md\)$/u, `- [Current product model: ${version}](shared/${modelId}/${version}/model.md)`],
    [/^- \[(v\d+\.\d+) inconsistency report\]\(shared\/(.+)\/(v\d+\.\d+)\/inconsistency-report\.md\)$/u, `- [${version} inconsistency report](shared/${modelId}/${version}/inconsistency-report.md)`],
    [/^- \[(v\d+\.\d+) merge receipt\]\(shared\/(.+)\/(v\d+\.\d+)\/merge-receipt\.md\)$/u, `- [${version} merge receipt](shared/${modelId}/${version}/merge-receipt.md)`],
  ]) {
    const found = lines.flatMap((row, index) => { const match = pattern.exec(row); return match && match[1] === match[3] && match[2] === modelId ? [index] : []; });
    need(found.length === 1); lines[found[0]] = replacement;
  }
  return lines.join("\n");
}

/**
 * `materializerVersion` is for reproduction only: verification passes the retained manifest's own
 * version so an earlier candidate reproduces under the rules it was written by. A new candidate omits it.
 */
export function materializeProductFeedbackCandidate(input) {
  const value = copy(input);
  keys(value, ["baseline", "decision", "recipe", "files", ...(Object.hasOwn(value, "materializerVersion") ? ["materializerVersion"] : []),
    ...(Object.hasOwn(value, "carriedFrom") ? ["carriedFrom"] : [])]);
  const materializerVersion = value.materializerVersion ?? PRODUCT_FEEDBACK_MATERIALIZER_VERSION;
  need(PRODUCT_FEEDBACK_MATERIALIZER_VERSIONS.includes(materializerVersion));
  const baseline = baselineRecord(value.baseline), recipe = value.recipe, files = fileMap(value.files), snapshot = baseline.snapshot;
  // Carried: the owner's decision, its recipe and its comparison stand on `carriedFrom`, the generation
  // the decision was made against; the candidate itself is the next version of `baseline`, the head.
  const carriedFrom = Object.hasOwn(value, "carriedFrom") ? carriedParent(value.carriedFrom, baseline) : null;
  const decided = carriedFrom ?? baseline;
  const proposal = parseRecipe(recipe, decided);
  if (carriedFrom !== null) need(proposal !== null && versionAfter(recipe.metadata.successorVersion, snapshot.version));
  // A record-only recipe offers nothing to decide, so a decision supplied with one is refused rather than ignored.
  if (proposal === null) need(value.decision === null);
  const approved = proposal === null ? { disposition: "record-only", evidence: null }
    : decisionBinding(value.decision, decided, proposal, recipe.binding, materializerVersion);
  if (carriedFrom !== null) {
    need(["keep-approved", "matching-owner-decision"].includes(approved.disposition));
    // The decision replaced one exact claim record; it carries only onto a head that still holds that record.
    const held = snapshot.claims.find(entry => entry.id === proposal.before.id);
    if (!held || held.recordSha256 !== proposal.before.recordSha256 || digest(held.record) !== held.recordSha256) {
      throw new Error(PRODUCT_FEEDBACK_CARRIED_CLAIM_CHANGED);
    }
  }
  if (approved.evidence) need(Date.parse(recipe.metadata.createdAt) >= Date.parse(approved.evidence.sourceRegisteredAt ?? approved.evidence.source.registeredAt));
  const history = historyPath(snapshot.modelId), requiredBasePaths = requiredProductFeedbackBasePaths({ baseline, recipe });
  need(equal(Object.keys(files).sort(), requiredBasePaths));
  for (const file of snapshot.files) need(bytesHash(files[file.path]) === file.sha256);
  need(blobId(files[snapshot.modelPath], snapshot.modelGitObjectId.length) === snapshot.modelGitObjectId);
  const recipeSha256 = recipeIdentityDigest(baseline.baselineSha256, recipe, approved.evidence?.source.registrationSha256 ?? null, approved.disposition);
  const claim = proposal === null ? null : approved.disposition === "keep-approved" ? proposal.before.record : { ...proposal.before.record, ...proposal.change.after };
  const version = recipe.metadata.successorVersion, directory = `.docsfab/reference-model/shared/${snapshot.modelId}/${version}`, modelPath = `${directory}/model.md`;
  const inherited = Object.fromEntries(snapshot.files.map(file => [file.path, files[file.path]]));
  const source = sourcePackage(recipe, approved, recipeSha256, snapshot.modelId, materializerVersion), generated = { ...source.files };
  const model = { schemaVersion: 1, kind: "docsfab-product-feedback-model", projectId: baseline.projectId, modelId: snapshot.modelId,
    version, streamVersion: baseline.streamVersion + 1, state: "candidate", recipeSha256,
    parent: { version: snapshot.version, modelSha256: snapshot.modelSha256, modelGitObjectId: snapshot.modelGitObjectId,
      baselineGeneration: baseline.generation, baselineSha256: baseline.baselineSha256, sourceClosureSha256: snapshot.sourceClosureSha256 },
    metadata: recipe.metadata, retainedFiles: snapshot.files,
    change: claim === null ? null : { claimId: proposal.before.id, beforeClaimRecordSha256: proposal.before.recordSha256, record: claim },
    openConflicts: snapshot.openConflicts,
    sourceRegistration: { threadId: source.threadId, itemId: source.itemId, artifactSha256: source.artifactSha256,
      decisionRegistrationSha256: approved.evidence?.source.registrationSha256 ?? null, files: sortedFiles(source.files) },
    sourceClosureSha256: digest(sourceMap([...snapshot.files, ...sortedFiles(source.files)])), approvalTargetSha256: proposal?.target.targetSha256 ?? null };
  const record = adjudicationRecord(recipe, proposal, approved, source, materializerVersion), proposalPath = `.docsfab/reference-model/proposals/${recipeSha256}.json`;
  // v4 projects every routed document before the receipt, which records what each projection repaired.
  const projections = materializerVersion === PRODUCT_FEEDBACK_MATERIALIZER_VERSION
    ? recipe.targets.map(target => ({ target, ...projectDocument(files[target.path], target, claim, snapshot.modelId, version) })) : null;
  const projectionRemovals = (projections ?? []).flatMap(item => item.removed);
  const projectionNotes = [...(projections ?? []).flatMap(item => item.notes.map(code => `- Projection \`${item.target.path}\`: \`${code}\`.`)),
    ...projectionRemovals.map(span => `- Projection \`${span.path}\`: \`${PROJECTION_REVIEW_CODE}\`, removed ${span.bytes} bytes with SHA-256 \`${span.sha256}\`.`)];
  const context = { baseline, recipe, recipeSha256, version, claim, record, source, approved, proposalPath, projectionNotes };
  generated[modelPath] = renderProductFeedbackModel(model);
  generated[`${directory}/inconsistency-report.md`] = renderInconsistencyReport(context);
  generated[`${directory}/merge-receipt.md`] = renderMergeReceipt({ ...context, receipt: legacyReceipt(snapshot, files) });
  if (approved.disposition === "keep-approved") {
    generated[proposalPath] = `${canonical({ schemaVersion: 1,
      kind: "docsfab-corrective-implementation-proposal", approvedModelSha256: snapshot.modelSha256,
      claimId: claim.claim_id, requiredStatement: claim.statement, scope: claim.scope,
      decisionRegistrationSha256: approved.evidence.source.registrationSha256, implementationVerification: "not-established",
      action: "retain-approved-requirement-and-validate-any-corrective-implementation" })}\n`;
  }
  generated[history] = historyWithRow(files[history], snapshot.version, version, historyRow(context));
  generated[modelIndexPath] = indexPointingTo(files[modelIndexPath], snapshot.modelId, version);
  for (const item of projections ?? []) generated[item.target.path] = item.content;
  for (const target of projections === null ? recipe.targets : []) {
    const priorForms = ["matching-owner-decision", "keep-approved"].flatMap(disposition =>
      ["issue-comment", "repository-content"].map(sourceKind => renderSection(target, proposal.before.record, disposition, [{ sourceKind }])));
    generated[target.path] = replaceSection(files[target.path], target, claim.claim_id,
      renderSection(target, claim, approved.disposition, recipe.sourceVersions), priorForms);
  }
  for (const name of Object.keys(generated)) need(!Object.hasOwn(inherited, name));
  const candidateFiles = { ...inherited, ...generated }, modelContent = generated[modelPath];
  const manifestBody = { schemaVersion: 1, kind: "docsfab-product-feedback-candidate-manifest", materializerVersion,
    binding: recipe.binding, baseRevision: recipe.baseRevision, baselineGeneration: baseline.generation, baselineSha256: baseline.baselineSha256,
    approvedParentModelSha256: snapshot.modelSha256, recipe, recipeSha256,
    targetRoutePolicySha256: recipe.targetRoutePolicySha256,
    decisionRegistrationSha256: approved.evidence?.source.registrationSha256 ?? null,
    approvalTargetSha256: proposal?.target.targetSha256 ?? null, disposition: approved.disposition,
    requiredBasePaths, requiredCandidatePaths: Object.keys(candidateFiles).sort(), generatedFiles: sortedFiles(generated),
    requiredAbsentBasePaths: Object.keys(generated).filter(name => !Object.hasOwn(files, name)).sort(),
    model: { path: modelPath, sha256: bytesHash(modelContent), gitObjectId: blobId(modelContent, snapshot.modelGitObjectId.length),
      version, streamVersion: baseline.streamVersion + 1 },
    sourceClosureSha256: model.sourceClosureSha256, requestedSuccessorGeneration: baseline.generation + 1,
    publicationReceiptSha256: null, modelState: "candidate", semanticEvidence: false,
    ...(carriedFrom === null ? {} : { carriedFrom: { baselineGeneration: carriedFrom.generation, baselineSha256: carriedFrom.baselineSha256,
      modelSha256: carriedFrom.snapshot.modelSha256 } }),
    ...(projectionRemovals.length === 0 ? {} : { projectionReview: { code: PROJECTION_REVIEW_CODE, removed: projectionRemovals } }) };
  const manifest = { ...manifestBody, candidateManifestSha256: digest(manifestBody) };
  parseProductFeedbackCandidateManifest(manifest);
  const expectedClaims = claim === null ? snapshot.claims : snapshot.claims.map(entry => entry.id === proposal.before.id ?
    { id: entry.id, sourcePath: modelPath, record: claim, recordSha256: digest(claim) } : entry);
  return freeze({ manifest, files: candidateFiles, changedFiles: generated, expectedClaims,
    outcome: approved.disposition === "keep-approved" ? "corrective-implementation-proposal" :
      approved.disposition === "record-only" ? "record-only-candidate" : "model-and-document-candidate",
    requiresOwnerApproval: approved.disposition === "unapproved", modelApproved: false, baselinePromoted: false });
}

/** Deterministic evidence only; the caller must first obtain the actual decision and current approved parent. */
export function verifyProductFeedbackCandidate(input) {
  const value = copy(input); keys(value, ["baseline", "decision", "manifest", "files", ...(Object.hasOwn(value, "carriedFrom") ? ["carriedFrom"] : [])]);
  keys(value.files, ["base", "candidate"]);
  // A carried manifest reproduces only with the generation its decision was made against, and only a carried one takes it.
  need(Object.hasOwn(value, "carriedFrom") === Object.hasOwn(value.manifest, "carriedFrom"));
  verify(value.manifest, "candidateManifestSha256");
  need(Array.isArray(value.manifest.requiredAbsentBasePaths));
  need(equal(Object.keys(value.files.base).sort(), [...value.manifest.requiredBasePaths, ...value.manifest.requiredAbsentBasePaths].sort()));
  for (const name of value.manifest.requiredAbsentBasePaths) need(value.files.base[name] === null);
  const present = Object.fromEntries(Object.entries(value.files.base).filter(([, content]) => content !== null));
  need(PRODUCT_FEEDBACK_MATERIALIZER_VERSIONS.includes(value.manifest.materializerVersion));
  const expected = materializeProductFeedbackCandidate({ baseline: value.baseline, decision: value.decision,
    recipe: value.manifest.recipe, files: present, materializerVersion: value.manifest.materializerVersion,
    ...(Object.hasOwn(value, "carriedFrom") ? { carriedFrom: value.carriedFrom } : {}) });
  need(equal(expected.manifest, value.manifest) && !expected.requiresOwnerApproval);
  fileMap(value.files.candidate); need(equal(Object.keys(value.files.candidate).sort(), expected.manifest.requiredCandidatePaths));
  for (const [name, content] of Object.entries(expected.files)) need(bytes(value.files.candidate[name]).equals(bytes(content)));
  return freeze({ reproductionSha256: digest({ manifestSha256: value.manifest.candidateManifestSha256,
    expectedFiles: sortedFiles(expected.files), expectedClaims: expected.expectedClaims }),
    expectedFiles: sortedFiles(expected.files), expectedClaims: expected.expectedClaims, model: expected.manifest.model,
    sourceClosureSha256: expected.manifest.sourceClosureSha256 });
}

/**
 * The reference-model snapshot one verified candidate becomes once it merged at `revision` (whose
 * tree is `tree`): what `project_model_feedback.py` projects for that version at that revision,
 * derived from the parent snapshot and the candidate's reproduction alone. The projector reads the
 * parent's retained files, the new `model.md` and this version's registered source files (views
 * excluded); the claims are the reproduction's; open conflicts are inherited. It grants nothing:
 * the host installs it only under the owner's decision, compare-and-set against its parent.
 */
export function productFeedbackSuccessorSnapshot(input) {
  const value = copy(input); keys(value, ["baseline", "manifest", "reproduction", "revision", "tree"]);
  const baseline = baselineRecord(value.baseline), snapshot = baseline.snapshot;
  const manifest = parseProductFeedbackCandidateManifest(value.manifest), reproduction = value.reproduction;
  revision(value.revision); revision(value.tree);
  keys(reproduction, ["reproductionSha256", "expectedFiles", "expectedClaims", "model", "sourceClosureSha256"]); hash(reproduction.reproductionSha256);
  need(manifest.binding.projectId === baseline.projectId && manifest.baselineGeneration === baseline.generation &&
    manifest.baselineSha256 === baseline.baselineSha256 && manifest.approvedParentModelSha256 === snapshot.modelSha256 &&
    equal(reproduction.model, manifest.model) && reproduction.sourceClosureSha256 === manifest.sourceClosureSha256 &&
    manifest.model.streamVersion === baseline.streamVersion + 1);
  const expected = new Map(reproduction.expectedFiles.map(file => [file.path, file.sha256]));
  const registered = manifest.generatedFiles.filter(file => file.path.startsWith(sourceRoot) && !file.path.includes("/views/"));
  const files = new Map(snapshot.files.map(file => [file.path, file.sha256]));
  for (const file of [{ path: manifest.model.path, sha256: manifest.model.sha256 }, ...registered]) {
    need(!files.has(file.path) && expected.get(file.path) === file.sha256); files.set(file.path, file.sha256);
  }
  const body = { schemaVersion: 1, kind: "docsfab-reference-model-snapshot", projectId: baseline.projectId, modelId: snapshot.modelId,
    version: manifest.model.version, state: "candidate", revision: value.revision, tree: value.tree, modelPath: manifest.model.path,
    modelSha256: manifest.model.sha256, modelGitObjectId: manifest.model.gitObjectId,
    files: [...files].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => order(a.path, b.path)),
    sourceClosureSha256: manifest.sourceClosureSha256,
    claims: [...reproduction.expectedClaims].sort((a, b) => order(a.id, b.id)), openConflicts: snapshot.openConflicts };
  return parseReferenceModelSnapshot({ ...body, snapshotSha256: digest(body) });
}
