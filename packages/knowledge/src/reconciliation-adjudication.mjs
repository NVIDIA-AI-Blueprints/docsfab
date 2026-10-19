// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { maintainerQuestionAuthority, maintainerAnswerAuthority, bindMaintainerAnswerActor, sameAnswerAuthority } from "./reconciliation-authority-evidence.mjs";
import { createHash } from "node:crypto";

import { parseMergeReconciliationResult } from "./runtime-adapter.mjs";

/** V1 decision-text allowance, used when the host supplies no catalog maximum. */
const LEGACY_DECISION_TEXT_MAX_BYTES = 512;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
/** The provider message id format and its fraction width; comparing two as one
 * integer scales the seconds by that width. Format plumbing, not a bound. */
const SLACK_MESSAGE_ID = /^[0-9]{1,16}\.[0-9]{1,16}$/u;
const SLACK_TIME_FRACTION_DIGITS = 16;
const SLACK_TIME_SCALE = 10n ** BigInt(SLACK_TIME_FRACTION_DIGITS);
const SHA = /^[a-f0-9]{64}$/u;
const DISPOSITIONS = new Set([
  "accept-variant",
  "supersede-variant",
  "rescope",
  "retain-variants",
  "defer",
]);
const CLASSIFICATIONS = new Set([
  "behavior-conflict", "intent-conflict", "terminology-conflict", "scope-conflict",
  "version-conflict", "representation-conflict", "documentation-quality-conflict", "unknown",
]);
const DECISION_KINDS = new Set(["intent", "scope", "representation", "authority"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
// A delivered question carries the routed finding's actual impact (the
// question floor also asks about a high-confidence `advisory` finding, not
// only `load-bearing`; `informational` never clears the floor, but this set
// stays the shared 3-value impact set -- see contracts.ts's matching comment
// on ReconciliationQuestionV1.impact for why it is not narrowed here).
const IMPACT = new Set(["informational", "advisory", "load-bearing"]);
const CREDENTIAL = [
  /\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprcds]-[A-Za-z0-9-]{20,}\b/u,
  /\bnvapi-[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /(?:^|[^A-Za-z0-9_-])(?:token|secret|password|api[_-]?key|private[_-]?token|authorization)\s*[:=]\s*\S{8,}/iu,
];

export function registerReconciliationDecisionSource(input) {
  const root = object(input, "source registration input");
  // `answerTextMaxBytes` is the host's catalog maximum for an already admitted
  // decision. Omitting it keeps the V1 allowance, which can only refuse a
  // longer retained answer, never admit one.
  exact(root, ["question", "answer", "parentThreadEventId",
    ...(Object.hasOwn(root, "answerTextMaxBytes") ? ["answerTextMaxBytes"] : []),
    ...(Object.hasOwn(root, "offerPartsMax") ? ["offerPartsMax"] : [])]);
  const answerTextMaxBytes = retainedAnswerBound(root);
  const question = questionRecord(root.question, retainedOfferPartsBound(root));
  const answer = answerRecord(root.answer, answerTextMaxBytes);
  bindAnswer(question, answer);
  // Each Slack adjudication question is its own immutable source lineage, so no
  // mutable principal-wide head is needed. A correction gets a new question.
  const sourceThreadId = `decision-thread-${digest(question.questionId).slice(0, 32)}`;
  const suffix = answer.answerSha256.slice(0, 32);
  const integritySha256 = digest(canonicalJson({
    schemaVersion: 1,
    questionSha256: question.questionSha256,
    answerSha256: answer.answerSha256,
    authorityReceiptSha256: answer.authorityReceiptSha256,
  }));
  const source = {
    schemaVersion: 1,
    kind: "docsfab-reconciliation-decision-source",
    sourceId: `decision-source-${suffix}`,
    sourceThreadId,
    itemId: `decision-item-${suffix}`,
    sourceKind: "authority-decision",
    evidenceRole:
      question.decisionKind === "representation" ? "representation" :
      question.decisionKind === "authority" ? "authority" : "intent",
    version: `answer-${suffix}`,
    representationId: "slack-thread-answer",
    integritySha256,
    locator: `docsfab-source:${integritySha256}`,
    reconciliationId: answer.reconciliationId,
    questionId: answer.questionId,
    conflictId: answer.conflictId,
    answerSha256: answer.answerSha256,
    principalId: answer.principalId,
    authorityReceiptSha256: answer.authorityReceiptSha256,
    parentThreadEventId: root.parentThreadEventId === null
      ? null
      : fail("question lineage must start at its own root"),
    sourceEventId: `decision-event-${suffix}`,
  };
  return freeze({ ...source, registrationSha256: digest(canonicalJson(source)) });
}

export function adjudicateReconciliationDecision(input) {
  const root = object(input, "adjudication input");
  exact(root, [
    "reconciliationId", "generation", "attemptId", "attemptKey",
    "contextBindingSha256", "originalResult", "priorDecisions", "question", "answer", "source",
    ...(Object.hasOwn(root, "answerTextMaxBytes") ? ["answerTextMaxBytes"] : []),
    ...(Object.hasOwn(root, "offerPartsMax") ? ["offerPartsMax"] : []),
  ]);
  const answerTextMaxBytes = retainedAnswerBound(root), offerPartsMax = retainedOfferPartsBound(root);
  const result = parseMergeReconciliationResult(root.originalResult);
  const question = questionRecord(root.question, offerPartsMax);
  const answer = answerRecord(root.answer, answerTextMaxBytes);
  const source = sourceRecord(root.source);
  const priorDecisions = array(root.priorDecisions, "prior decisions").map((candidate) => {
    const prior = object(candidate, "prior decision");
    exact(prior, ["question", "answer", "source"]);
    return {
      question: questionRecord(prior.question, offerPartsMax),
      answer: answerRecord(prior.answer, answerTextMaxBytes),
      source: sourceRecord(prior.source),
    };
  });
  if (priorDecisions.length > 1) fail("prior decision budget");
  const decisions = [...priorDecisions, { question, answer, source }];
  if (new Set(decisions.map((entry) => entry.question.questionId)).size !== decisions.length) {
    fail("duplicate question");
  }
  if (new Set(decisions.map((entry) => entry.question.conflictId)).size !== decisions.length) {
    fail("duplicate conflict");
  }
  if (decisions.some((entry, index) => entry.question.generation !== index + 1)) {
    fail("decision order");
  }
  if (identifier(root.reconciliationId, "reconciliation id") !== question.reconciliationId) {
    fail("reconciliation binding");
  }
  let nextInconsistencies = result.inconsistencies;
  let nextClaims = result.claims;
  for (const adjudication of decisions) {
    validateDecision(result, question.reconciliationId, adjudication);
    const decision = adjudication.answer.decision;
    nextInconsistencies = nextInconsistencies.map((item) =>
      item.conflictId === adjudication.question.conflictId
        ? {
            ...item,
            status: decision.disposition === "defer" ? "deferred" : "resolved",
            adjudication: {
              adjudicatorPrincipalId: adjudication.answer.principalId,
              authorityReceiptSha256: adjudication.answer.authorityReceiptSha256,
              answerSha256: adjudication.answer.answerSha256,
              disposition: decision.disposition,
              selectedClaimIds: decision.selectedClaimIds,
              rationaleSha256: decision.rationaleSha256,
              scopeSha256: decision.scopeSha256,
              sourceRegistrationSha256: adjudication.source.registrationSha256,
            },
          }
        : item
    );
    nextClaims = nextClaims.map((claim) => applyClaimDecision(claim, adjudication));
  }
  const decision = answer.decision;
  const modelBody = {
    schemaVersion: 1,
    kind: "docsfab-adjudicated-model-candidate",
    modelId: result.modelParent.modelId,
    parentVersion: result.modelParent.version,
    parentSha256: result.modelParent.sha256,
    mergeRevision: result.forge.mergeRevision,
    priorResultSha256: result.resultSha256,
    sourceRegistrations: decisions.map((entry) => entry.source),
    claims: nextClaims,
    inconsistencies: nextInconsistencies,
  };
  const modelSha256 = digest(canonicalJson(modelBody));
  const affectedTargets = [...new Set(
    decisions.flatMap((entry) => entry.question.blocksTargets),
  )].sort();
  const projectionBody = {
    schemaVersion: 1,
    kind: "docsfab-projection-candidate-set",
    sourceModelSha256: modelSha256,
    affectedTargets,
    publish: false,
    merge: false,
  };
  const projectionSha256 = digest(canonicalJson(projectionBody));
  const receiptBody = {
    adjudicatedConflictId: question.conflictId,
    adjudicatorPrincipalId: answer.principalId,
    authorityReceiptSha256: answer.authorityReceiptSha256,
    answerSha256: answer.answerSha256,
    decisionChainSha256: digest(canonicalJson(decisions.map((entry) => ({
      questionSha256: entry.question.questionSha256,
      answerSha256: entry.answer.answerSha256,
      sourceRegistrationSha256: entry.source.registrationSha256,
    })))),
    priorResultSha256: result.resultSha256,
    mergeRevision: result.forge.mergeRevision,
  };
  const receiptSha256 = digest(canonicalJson(receiptBody));
  const remainingLoadBearingConflictIds = nextInconsistencies
    .filter((item) => item.impact === "load-bearing" && item.status !== "resolved")
    .map((item) => item.conflictId)
    .sort();
  const deferredConflictIds = nextInconsistencies
    .filter((item) => item.status === "deferred")
    .map((item) => item.conflictId)
    .sort();
  const outputBody = {
    schemaVersion: 1,
    kind: "docsfab-reconciliation-adjudication-result",
    reconciliationId: question.reconciliationId,
    generation: positive(root.generation, "generation"),
    attemptId: identifier(root.attemptId, "attempt id"),
    attemptKey: identifier(root.attemptKey, "attempt key"),
    contextBindingSha256: hash(root.contextBindingSha256, "context binding"),
    sourceRegistrationSha256: source.registrationSha256,
    priorModelSha256: result.modelParent.sha256,
    resolution: {
      disposition: decision.disposition,
      resolvedConflictId: question.conflictId,
      remainingLoadBearingConflictIds,
      deferredConflictIds,
    },
    model: {
      modelId: result.modelParent.modelId,
      parentVersion: result.modelParent.version,
      parentSha256: result.modelParent.sha256,
      status: "candidate",
      sha256: modelSha256,
      locator: `docsfab-candidate:${modelSha256}`,
    },
    projections: {
      status: "candidate",
      affectedTargets,
      sourceModelSha256: modelSha256,
      sha256: projectionSha256,
      locator: `docsfab-candidate:${projectionSha256}`,
    },
    receipt: {
      ...receiptBody,
      sha256: receiptSha256,
      locator: `docsfab-receipt:${receiptSha256}`,
    },
    authority: {
      exactClaimDecision: true,
      modelApproved: false,
      projectionPublished: false,
      projectionMerged: false,
    },
  };
  return freeze({ ...outputBody, resultSha256: digest(canonicalJson(outputBody)) });
}

function validateDecision(result, reconciliationId, input) {
  const { question, answer, source } = input;
  bindAnswer(question, answer);
  if (
    question.reconciliationId !== reconciliationId ||
    source.reconciliationId !== question.reconciliationId ||
    source.questionId !== question.questionId ||
    source.conflictId !== question.conflictId ||
    source.answerSha256 !== answer.answerSha256 ||
    source.principalId !== answer.principalId ||
    source.authorityReceiptSha256 !== answer.authorityReceiptSha256
  ) fail("source binding");
  const finding = result.inconsistencies.find((item) => item.conflictId === question.conflictId);
  if (!finding || finding.status !== "open") fail("stale conflict");
  if (
    finding.classification !== question.classification ||
    finding.decisionKind !== question.decisionKind ||
    finding.confidence !== question.confidence ||
    finding.confidenceBasisSha256 !== question.confidenceBasisSha256 ||
    finding.impact !== question.impact ||
    finding.impactBasisSha256 !== question.impactBasisSha256 ||
    question.conflictSnapshotSha256 !== digest(canonicalJson(finding)) ||
    finding.safeSummary !== question.safeSummary ||
    canonicalJson(finding.blocksTargets) !== canonicalJson(question.blocksTargets) ||
    canonicalJson(finding.variants) !== canonicalJson(question.variants) ||
    canonicalJson([...finding.sourceClaimIds].sort()) !== canonicalJson(question.offeredClaimIds)
  ) fail("conflict snapshot");
  const decision = answer.decision;
  if (!question.allowedDispositions.includes(decision.disposition)) fail("disposition");
  if (decision.selectedClaimIds.some((claimId) => !question.offeredClaimIds.includes(claimId))) {
    fail("selected claim");
  }
}

function applyClaimDecision(claim, input) {
  const { question, answer } = input;
  const decision = answer.decision;
  if (!question.offeredClaimIds.includes(claim.claimId)) return claim;
  if (decision.disposition === "rescope") return { ...claim, action: "rescoped" };
  if (decision.disposition === "retain-variants" || decision.disposition === "defer") {
    return { ...claim, action: "variant" };
  }
  if (decision.disposition === "accept-variant") {
    return decision.selectedClaimIds.includes(claim.claimId)
      ? { ...claim, action: "included" }
      : { ...claim, action: "superseded" };
  }
  return decision.selectedClaimIds.includes(claim.claimId)
    ? { ...claim, action: "superseded" }
    : { ...claim, action: "included" };
}

function bindAnswer(question, answer) {
  if (
    answer.reconciliationId !== question.reconciliationId ||
    answer.questionId !== question.questionId ||
    answer.generation !== question.generation ||
    answer.questionSha256 !== question.questionSha256 ||
    answer.conflictId !== question.conflictId ||
    !sameAnswerAuthority(question, answer) ||
    answer.channelKind !== question.route.channelKind ||
    answer.accountLocatorSha256 !== question.route.accountLocatorSha256 ||
    answer.conversationLocatorSha256 !== question.route.conversationLocatorSha256 ||
    answer.threadLocatorSha256 !== question.route.threadLocatorSha256 ||
    Date.parse(answer.receivedAt) < Date.parse(question.issuedAt) ||
    Date.parse(answer.receivedAt) >= Date.parse(question.expiresAt)
  ) fail("answer binding");
}

/**
 * The host supplies `offerPartsMax` from `reconciliation.offerPartsMax`. This package
 * holds no limits mirror, so a question with a semantic offer is refused without it.
 */
function questionRecord(input, offerPartsMax) {
  const value = object(input, "question");
  exact(value, [
    ...(Object.hasOwn(value, "semanticOffer") ? ["semanticOffer", "semanticDelivery"] : []),
    "schemaVersion", "kind", "reconciliationId", "questionId", "generation",
    "requestKey", "stoppedAttemptId", "stoppedJobSha256", "stoppedPacketSha256",
    "stoppedContextBindingSha256", "continuationAttemptKey", "resumeAnchorSha256",
    "severityPolicyVersion", "severityPolicySha256", "measurementReceiptSha256",
    "conflictId", "conflictSnapshotSha256", "classification", "decisionKind",
    "confidence", "confidenceBasisSha256", "impact", "impactBasisSha256",
    "blocksTargets", "safeSummary", "variants", "offeredClaimIds", "allowedDispositions",
    "questionTextSha256", "choiceSetSha256", "contextThreadId", "authority", "route",
    "issuedAt", "expiresAt", "questionSha256",
  ]);
  if (![1, 2].includes(value.schemaVersion) || value.kind !== "docsfab-reconciliation-question") fail("question");
  const authorityInput = object(value.authority, "question authority");
  const authority = value.schemaVersion === 2 ? maintainerQuestionAuthority(authorityInput) : (() => {
  exact(authorityInput, [
    "ownerKey", "authorityKind", "expectedPrincipalId", "expectedChannelIdentitySha256",
    "ownerPolicyVersion", "ownerPolicySha256", "authorityReceiptSha256", "identityReceiptSha256",
  ]);
  return {
    ownerKey: identifier(authorityInput.ownerKey, "owner key"),
    authorityKind: identifier(authorityInput.authorityKind, "authority kind"),
    expectedPrincipalId: identifier(authorityInput.expectedPrincipalId, "principal"),
    expectedChannelIdentitySha256: hash(authorityInput.expectedChannelIdentitySha256, "channel identity"),
    ownerPolicyVersion: positive(authorityInput.ownerPolicyVersion, "owner policy version"),
    ownerPolicySha256: hash(authorityInput.ownerPolicySha256, "owner policy"),
    authorityReceiptSha256: hash(authorityInput.authorityReceiptSha256, "authority receipt"),
    identityReceiptSha256: hash(authorityInput.identityReceiptSha256, "identity receipt"),
  };
  })();
  const routeInput = object(value.route, "question route");
  exact(routeInput, [
    "channelKind", "surface", "accountLocatorSha256", "conversationLocatorSha256",
    "threadLocatorSha256", "routeSha256",
  ]);
  const routeBody = {
    channelKind: identifier(routeInput.channelKind, "channel kind"),
    surface: oneOf(routeInput.surface, new Set(["thread", "direct-thread"]), "channel surface"),
    accountLocatorSha256: hash(routeInput.accountLocatorSha256, "account locator"),
    conversationLocatorSha256: hash(routeInput.conversationLocatorSha256, "conversation locator"),
    threadLocatorSha256: hash(routeInput.threadLocatorSha256, "thread locator"),
  };
  const route = { ...routeBody, routeSha256: hash(routeInput.routeSha256, "route digest") };
  if (route.routeSha256 !== digest(canonicalJson(routeBody))) fail("route digest");
  const variants = array(value.variants, "question variants").map((candidate) => {
    const variant = object(candidate, "question variant");
    exact(variant, ["claimId", "safeSummary", "evidenceLocators"]);
    const evidenceLocators = strings(variant.evidenceLocators, "evidence locators");
    if (evidenceLocators.length === 0) fail("evidence locators");
    return {
      claimId: identifier(variant.claimId, "variant claim"),
      safeSummary: safeText(variant.safeSummary, "variant summary"),
      evidenceLocators,
    };
  });
  if (variants.length === 0 || variants.length > 4) fail("question variants");
  const offeredClaimIds = identifiers(value.offeredClaimIds, "offered claims");
  if (
    offeredClaimIds.length === 0 ||
    canonicalJson([...variants.map((variant) => variant.claimId)].sort()) !== canonicalJson(offeredClaimIds)
  ) fail("question variant claims");
  const allowedDispositions = enums(value.allowedDispositions, DISPOSITIONS, "allowed dispositions", false);
  if (allowedDispositions.length === 0) fail("allowed dispositions");
  const issuedAt = timestamp(value.issuedAt, "issued at");
  const expiresAt = timestamp(value.expiresAt, "expires at");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail("question expiry");
  const semanticOffer = value.semanticOffer === undefined ? undefined : parseReconciliationSemanticOffer(value.semanticOffer);
  let semanticDelivery;
  if (semanticOffer) {
    if (!Number.isSafeInteger(offerPartsMax) || offerPartsMax < 1) fail("semantic delivery capacity");
    semanticDelivery = array(value.semanticDelivery, "semantic delivery").map(item => {
      const part = object(item, "semantic part"); exact(part, ["textSha256", "messageId"]);
      if (typeof part.messageId !== "string" || !SLACK_MESSAGE_ID.test(part.messageId)) fail("semantic part message");
      return { textSha256: hash(part.textSha256, "semantic part digest"), messageId: part.messageId };
    });
    if (semanticDelivery.some((part, index) => index > 0 &&
      slackTimeOrder(part.messageId) <= slackTimeOrder(semanticDelivery[index - 1].messageId))) fail("semantic part order");
    if (!semanticDelivery.length || semanticDelivery.length > offerPartsMax ||
        canonicalJson(semanticOffer.options.map(option => option.claimId).sort()) !== canonicalJson([...offeredClaimIds].sort()) ||
        value.choiceSetSha256 !== digest(canonicalJson({ allowedDispositions, semanticOfferSha256: semanticOffer.offerSha256 })))
      fail("semantic question choices");
  }
  const body = {
    reconciliationId: identifier(value.reconciliationId, "reconciliation id"),
    questionId: identifier(value.questionId, "question id"),
    generation: positive(value.generation, "generation"),
    requestKey: identifier(value.requestKey, "request key"),
    stoppedAttemptId: identifier(value.stoppedAttemptId, "stopped attempt"),
    stoppedJobSha256: hash(value.stoppedJobSha256, "stopped job"),
    stoppedPacketSha256: hash(value.stoppedPacketSha256, "stopped packet"),
    stoppedContextBindingSha256: hash(value.stoppedContextBindingSha256, "stopped context"),
    continuationAttemptKey: identifier(value.continuationAttemptKey, "continuation attempt"),
    resumeAnchorSha256: hash(value.resumeAnchorSha256, "resume anchor"),
    severityPolicyVersion: positive(value.severityPolicyVersion, "severity version"),
    severityPolicySha256: hash(value.severityPolicySha256, "severity policy"),
    measurementReceiptSha256: hash(value.measurementReceiptSha256, "measurement receipt"),
    conflictId: identifier(value.conflictId, "conflict id"),
    conflictSnapshotSha256: hash(value.conflictSnapshotSha256, "conflict snapshot"),
    classification: oneOf(value.classification, CLASSIFICATIONS, "classification"),
    decisionKind: oneOf(value.decisionKind, DECISION_KINDS, "decision kind"),
    confidence: oneOf(value.confidence, CONFIDENCE, "confidence"),
    confidenceBasisSha256: hash(value.confidenceBasisSha256, "confidence basis"),
    impact: oneOf(value.impact, IMPACT, "impact"),
    impactBasisSha256: hash(value.impactBasisSha256, "impact basis"),
    blocksTargets: identifiers(value.blocksTargets, "blocked targets"),
    safeSummary: safeText(value.safeSummary, "question summary"),
    variants,
    offeredClaimIds,
    allowedDispositions,
    ...(semanticOffer ? { semanticOffer, semanticDelivery } : {}),
    questionTextSha256: hash(value.questionTextSha256, "question text"),
    choiceSetSha256: hash(value.choiceSetSha256, "choice set"),
    contextThreadId: identifier(value.contextThreadId, "context thread"),
    authority,
    route,
    issuedAt,
    expiresAt,
  };
  if (!semanticOffer && body.choiceSetSha256 !== digest(canonicalJson(allowedDispositions))) fail("choice set digest");
  // A retained group question must name the same Slack destination its authority
  // snapshot was read for, and cannot claim membership observed after issue time.
  if (value.schemaVersion === 2) {
    if (route.channelKind !== "slack" || route.accountLocatorSha256 !== digest(`slack-account:v1:${authority.workspaceId}`) ||
        route.conversationLocatorSha256 !== digest(`slack-conversation:v1:${authority.workspaceId}:${authority.conversationId}`) ||
        Date.parse(authority.snapshot.observedAt) > Date.parse(issuedAt)) fail("maintainer question binding");
  }
  const envelope = { schemaVersion: value.schemaVersion, kind: "docsfab-reconciliation-question", ...body };
  if (value.questionSha256 !== digest(canonicalJson(envelope))) fail("question digest");
  return freeze({ ...envelope, questionSha256: value.questionSha256 });
}

/**
 * The host supplies `answerTextMaxBytes` from `reconciliation.answerTextMaxBytes`;
 * omitting it keeps the V1 decision-text allowance.
 */
function answerRecord(input, answerTextMaxBytes) {
  const value = object(input, "answer");
  exact(value, [
    "schemaVersion", "kind", "reconciliationId", "questionId", "generation",
    "questionSha256", "conflictId", "principalId", "identityReceiptSha256",
    "authorityReceiptSha256", ...(value.schemaVersion === 2 ? ["authority"] : ["ownerPolicySha256"]), "channelKind", "eventLocatorSha256",
    "messageLocatorSha256", "channelIdentitySha256", "accountLocatorSha256",
    "conversationLocatorSha256", "threadLocatorSha256", "providerLocatorSha256",
    "contentSha256", "decision", "receivedAt", "answerId", "answerSha256",
  ]);
  if (![1, 2].includes(value.schemaVersion) || value.kind !== "docsfab-reconciliation-answer") fail("answer");
  const decisionInput = object(value.decision, "answer decision");
  exact(decisionInput, [
    "disposition", "selectedClaimIds", "rationale", "rationaleSha256", "scope", "scopeSha256",
  ]);
  const disposition = oneOf(decisionInput.disposition, DISPOSITIONS, "disposition");
  const selectedClaimIds = identifiers(decisionInput.selectedClaimIds, "selected claims");
  if ((disposition === "accept-variant" || disposition === "supersede-variant") && selectedClaimIds.length !== 1) {
    fail("selected claims");
  }
  if ((disposition === "retain-variants" || disposition === "defer") && selectedClaimIds.length !== 0) {
    fail("selected claims");
  }
  const rationale = semanticText(decisionInput.rationale, "rationale", answerTextMaxBytes);
  const scope = decisionInput.scope === null
    ? null
    : semanticText(decisionInput.scope, "scope", answerTextMaxBytes);
  const rationaleSha256 = hash(decisionInput.rationaleSha256, "rationale digest");
  const scopeSha256 = decisionInput.scopeSha256 === null
    ? null
    : hash(decisionInput.scopeSha256, "scope digest");
  if (
    rationaleSha256 !== digest(rationale) ||
    (disposition === "rescope") !== (scope !== null) ||
    (scope === null) !== (scopeSha256 === null) ||
    (scope !== null && scopeSha256 !== digest(scope))
  ) fail("decision semantic binding");
  const body = {
    reconciliationId: identifier(value.reconciliationId, "reconciliation id"),
    questionId: identifier(value.questionId, "question id"),
    generation: positive(value.generation, "generation"),
    questionSha256: hash(value.questionSha256, "question digest"),
    conflictId: identifier(value.conflictId, "conflict id"),
    principalId: identifier(value.principalId, "principal id"),
    identityReceiptSha256: hash(value.identityReceiptSha256, "identity receipt"),
    authorityReceiptSha256: hash(value.authorityReceiptSha256, "authority receipt"),
    ...(value.schemaVersion === 2 ? { authority: maintainerAnswerAuthority(value.authority) } : { ownerPolicySha256: hash(value.ownerPolicySha256, "owner policy") }),
    channelKind: identifier(value.channelKind, "channel kind"),
    eventLocatorSha256: hash(value.eventLocatorSha256, "event locator"),
    messageLocatorSha256: hash(value.messageLocatorSha256, "message locator"),
    channelIdentitySha256: hash(value.channelIdentitySha256, "channel identity"),
    accountLocatorSha256: hash(value.accountLocatorSha256, "account locator"),
    conversationLocatorSha256: hash(value.conversationLocatorSha256, "conversation locator"),
    threadLocatorSha256: hash(value.threadLocatorSha256, "thread locator"),
    providerLocatorSha256: hash(value.providerLocatorSha256, "provider locator"),
    contentSha256: hash(value.contentSha256, "content digest"),
    decision: {
      disposition,
      selectedClaimIds,
      rationale,
      rationaleSha256,
      scope,
      scopeSha256,
    },
    receivedAt: timestamp(value.receivedAt, "received at"),
  };
  const answerId = `answer:${digest(canonicalJson({
    questionId: body.questionId,
    providerLocatorSha256: body.providerLocatorSha256,
  }))}`;
  if (value.schemaVersion === 2) bindMaintainerAnswerActor(body);
  const envelope = { schemaVersion: value.schemaVersion, kind: "docsfab-reconciliation-answer", ...body, answerId };
  if (value.answerId !== answerId || value.answerSha256 !== digest(canonicalJson(envelope))) {
    fail("answer digest");
  }
  return freeze({ ...envelope, answerSha256: value.answerSha256 });
}

function sourceRecord(input) {
  const value = object(input, "source");
  if (
    value.schemaVersion !== 1 || value.kind !== "docsfab-reconciliation-decision-source" ||
    value.sourceKind !== "authority-decision" || !SHA.test(value.registrationSha256)
  ) fail("source");
  const body = { ...value };
  delete body.registrationSha256;
  if (digest(canonicalJson(body)) !== value.registrationSha256) fail("source digest");
  return value;
}

function object(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    fail(label);
  }
  return input;
}

function exact(input, keys) {
  if (Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0")) fail("shape");
}

function array(input, label) {
  if (!Array.isArray(input)) fail(label);
  return input;
}

function identifiers(input, label) {
  const values = array(input, label).map((value) => identifier(value, label));
  if (new Set(values).size !== values.length) fail(label);
  return [...values].sort();
}

function strings(input, label) {
  const values = array(input, label).map((value) => text(value, label));
  if (new Set(values).size !== values.length) fail(label);
  return values;
}

function enums(input, allowed, label, sort = true) {
  const values = array(input, label).map((value) => oneOf(value, allowed, label));
  if (new Set(values).size !== values.length) fail(label);
  return sort ? [...values].sort() : values;
}

function oneOf(input, allowed, label) {
  if (typeof input !== "string" || !allowed.has(input)) fail(label);
  return input;
}

function text(input, label) {
  if (
    typeof input !== "string" || input.length < 1 || input.length > 512 ||
    input.includes("\0") || input !== input.normalize("NFC")
  ) fail(label);
  return input;
}

function safeText(input, label) {
  const value = text(input, label);
  if (value.length > 240 || /[\u0000-\u001f\u007f<>`]/u.test(value) || /https?:\/\//iu.test(value)) fail(label);
  return value;
}

function semanticText(input, label, maximumBytes) {
  // Omitting the bound keeps the V1 allowance; the host supplies the catalog
  // maximum only for retained (already admitted) decisions.
  const bound = maximumBytes === undefined ? LEGACY_DECISION_TEXT_MAX_BYTES : maximumBytes;
  if (!Number.isSafeInteger(bound) || bound < 1) fail("decision text capacity");
  if (typeof input !== "string" || !input.length || input.includes("\0") || input !== input.normalize("NFC")) fail(label);
  // The owner's own words: blank lines, links and mentions are part of the decision.
  const value = input;
  if (
    Buffer.byteLength(value, "utf8") > bound || value !== value.trim() ||
    CREDENTIAL.some((pattern) => pattern.test(value))
  ) fail(label);
  return value;
}

function timestamp(input, label) {
  if (typeof input !== "string") fail(label);
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== input) fail(label);
  return input;
}

function identifier(input, label) {
  if (typeof input !== "string" || !SAFE_ID.test(input)) fail(label);
  return input;
}

function hash(input, label) {
  if (typeof input !== "string" || !SHA.test(input)) fail(label);
  return input;
}

function positive(input, label) {
  if (!Number.isSafeInteger(input) || input <= 0) fail(label);
  return input;
}

function digest(input) {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(label) {
  throw new Error(`reconciliation-adjudication: invalid ${label}`);
}

function slackTimeOrder(value) {
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds) * SLACK_TIME_SCALE + BigInt(fraction.padEnd(SLACK_TIME_FRACTION_DIGITS, "0"));
}

/** Closed parser for the exact scope a merge question offered. Calling it grants nothing. */
export function parseReconciliationSemanticOffer(input) {
  const value = object(input, "semantic offer");
  // `input` names the merged change's author; an offer retained before it was recorded has none.
  exact(value, ["schemaVersion", "kind", "binding", "mergeAnchorSha256", "comparisonSha256", "comparisonReceiptSha256", "baseline",
    "findingSha256", "claimId", "beforeClaimRecordSha256", "evidenceSourceVersionSha256s", "options", "offerSha256",
    ...(Object.hasOwn(value, "input") ? ["input"] : [])]);
  if (value.schemaVersion !== 1 || value.kind !== "docsfab-merge-semantic-offer") fail("semantic offer version");
  if (Object.hasOwn(value, "input")) {
    const record = object(value.input, "semantic input"); exact(record, ["kind", "authorProviderIdentity"]);
    if (record.kind !== "merge") fail("semantic input");
    identifier(record.authorProviderIdentity, "semantic input author");
  }
  const { binding, baseline, versions } = validateSemanticQuestionContext(value);
  const options = array(value.options, "semantic options");
  if (options.length !== 2) fail("semantic options");
  for (let index = 0; index < options.length; index++) {
    const option = object(options[index], "semantic option");
    exact(option, ["optionId", "claimId", "semanticClaim", "semanticClaimSha256", "approvalTarget", "semanticDelta"]);
    if (option.optionId !== ["keep-approved", "replace-statement-and-scope"][index]) fail("semantic option order");
    identifier(option.claimId, "semantic variant claim");
    const core = object(option.semanticClaim, "semantic core"); exact(core, ["claim_id", "statement", "scope"]);
    const scope = object(core.scope, "semantic scope");
    if (core.claim_id !== value.claimId || typeof core.statement !== "string" || !core.statement.trim() || !Object.keys(scope).length ||
        Object.values(scope).some(item => typeof item !== "string" || !item.trim())) fail("semantic core");
    if (hash(option.semanticClaimSha256, "semantic core digest") !== digest(canonicalJson(core))) fail("semantic core digest");
    if (index === 0) { if (option.approvalTarget !== null || option.semanticDelta !== null) fail("keep approved scope"); }
    else {
      const delta = bindModelApprovalDelta(option.approvalTarget, option.semanticDelta);
      if (delta.projectId !== binding.projectId || delta.modelId !== baseline.modelId || delta.approvedParentModelSha256 !== baseline.modelSha256 ||
          delta.comparisonReceiptSha256 !== value.comparisonReceiptSha256 ||
          canonicalJson([...delta.evidenceSourceVersionSha256s].sort()) !== canonicalJson([...versions].sort()) ||
          delta.changes.length !== 1 || delta.changes[0].claimId !== value.claimId ||
          delta.changes[0].beforeClaimRecordSha256 !== value.beforeClaimRecordSha256 ||
          canonicalJson(delta.changes[0].after) !== canonicalJson(core)) fail("semantic approval scope");
    }
  }
  if (options[0].claimId === options[1].claimId ||
      canonicalJson(options[0].semanticClaim) === canonicalJson(options[1].semanticClaim)) fail("semantic option distinction");
  const { offerSha256, ...body } = value;
  if (hash(offerSha256, "semantic offer digest") !== digest(canonicalJson(body))) fail("semantic offer digest");
  return freeze(value);
}

function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(label); return value;
}

function bindModelApprovalDelta(targetInput, deltaInput) {
  const target = object(targetInput, "semantic target"), delta = object(deltaInput, "semantic delta");
  exact(target, ["schemaVersion", "kind", "projectId", "modelId", "approvedParentModelSha256", "scope", "targetSha256"]);
  exact(delta, ["schemaVersion", "kind", "projectId", "modelId", "approvedParentModelSha256", "comparisonReceiptSha256",
    "evidenceSourceVersionSha256s", "changes", "deltaSha256"]);
  if (target.schemaVersion !== 1 || target.kind !== "docsfab-model-approval-target" || delta.schemaVersion !== 1 ||
      delta.kind !== "docsfab-offered-model-semantic-delta") fail("semantic scope version");
  for (const key of ["projectId", "modelId"]) { identifier(target[key], key); if (target[key] !== delta[key]) fail("semantic scope binding"); }
  hash(target.approvedParentModelSha256, "semantic parent"); hash(delta.comparisonReceiptSha256, "comparison receipt");
  if (target.approvedParentModelSha256 !== delta.approvedParentModelSha256) fail("semantic parent");
  const scope = object(target.scope, "semantic target scope");
  exact(scope, ["kind", "semanticDeltaSha256", "claimIds", "evidenceSourceVersionSha256s", "projectionTargets"]);
  if (scope.kind !== "semantic-delta" || scope.semanticDeltaSha256 !== delta.deltaSha256) fail("semantic scope kind");
  const changes = array(delta.changes, "semantic changes"); if (changes.length !== 1) fail("semantic change count");
  const change = object(changes[0], "semantic change"); exact(change, ["claimId", "beforeClaimRecordSha256", "after"]);
  identifier(change.claimId, "changed claim"); hash(change.beforeClaimRecordSha256, "before record");
  const after = object(change.after, "semantic after"); exact(after, ["claim_id", "statement", "scope"]);
  if (after.claim_id !== change.claimId || typeof after.statement !== "string" || !after.statement.trim()) fail("changed claim");
  const afterScope = object(after.scope, "changed scope");
  if (!Object.keys(afterScope).length || Object.values(afterScope).some(value => typeof value !== "string" || !value.trim())) fail("changed scope");
  const versions = array(delta.evidenceSourceVersionSha256s, "delta sources");
  if (!versions.length || new Set(versions).size !== versions.length) fail("delta sources");
  versions.forEach(value => hash(value, "delta source"));
  const targets = identifiers(scope.projectionTargets, "projection targets");
  if (!targets.length || canonicalJson(scope.claimIds) !== canonicalJson([change.claimId]) ||
      canonicalJson([...array(scope.evidenceSourceVersionSha256s, "target sources")].sort()) !== canonicalJson([...versions].sort())) fail("target scope");
  const { targetSha256, ...targetBody } = target, { deltaSha256, ...deltaBody } = delta;
  if (hash(targetSha256, "target digest") !== digest(canonicalJson(targetBody)) ||
      hash(deltaSha256, "delta digest") !== digest(canonicalJson(deltaBody))) fail("semantic scope digest");
  return delta;
}

function validateSemanticQuestionContext(value) {
  const binding = object(value.binding, "semantic binding"); exact(binding, ["deploymentId", "projectId", "deploymentEpoch"]);
  Object.values(binding).forEach(item => identifier(item, "semantic binding"));
  for (const key of ["mergeAnchorSha256", "comparisonSha256", "comparisonReceiptSha256", "findingSha256", "beforeClaimRecordSha256"]) hash(value[key], key);
  identifier(value.claimId, "semantic claim");
  const baseline = object(value.baseline, "semantic baseline");
  exact(baseline, ["generation", "baselineSha256", "modelId", "version", "streamVersion", "modelSha256", "canonSha256", "approvalReceiptSha256", "sourceClosureSha256"]);
  nonnegative(baseline.generation, "baseline generation"); nonnegative(baseline.streamVersion, "baseline stream");
  identifier(baseline.modelId, "baseline model");
  if (typeof baseline.version !== "string" || !/^v\d+\.\d+$/u.test(baseline.version)) fail("baseline version");
  for (const key of ["baselineSha256", "modelSha256", "canonSha256", "approvalReceiptSha256", "sourceClosureSha256"]) hash(baseline[key], key);
  const versions = array(value.evidenceSourceVersionSha256s, "semantic source versions");
  if (!versions.length || new Set(versions).size !== versions.length) fail("semantic source versions");
  versions.forEach(item => hash(item, "semantic source"));
  return { binding, baseline, versions };
}


/** Closed retained-evidence parser. Calling it cannot authorize a new Slack reply. */
export function validateRetainedReconciliationDecision(question, answer, bounds) {
  const options = object(bounds, "retained decision bounds");
  exact(options, ["answerTextMaxBytes", ...(Object.hasOwn(options, "offerPartsMax") ? ["offerPartsMax"] : [])]);
  // Fail closed: the host must name the catalog maximum; this package holds no
  // limits mirror, so an absent or nonsensical bound is never silently defaulted.
  if (!Number.isSafeInteger(options.answerTextMaxBytes) || options.answerTextMaxBytes < 1) fail("retained answer text capacity");
  const q = questionRecord(question, retainedOfferPartsBound(options)), a = answerRecord(answer, options.answerTextMaxBytes);
  bindAnswer(q, a); return freeze({ question: q, answer: a });
}

/** A present part bound must be a usable count; absence refuses any semantic question. */
function retainedOfferPartsBound(root) {
  if (!Object.hasOwn(root, "offerPartsMax")) return undefined;
  if (!Number.isSafeInteger(root.offerPartsMax) || root.offerPartsMax < 1) fail("semantic delivery capacity");
  return root.offerPartsMax;
}

/** A present bound must be a usable byte count; absence means the V1 allowance. */
function retainedAnswerBound(root) {
  if (!Object.hasOwn(root, "answerTextMaxBytes")) return undefined;
  if (!Number.isSafeInteger(root.answerTextMaxBytes) || root.answerTextMaxBytes < 1) fail("retained answer text capacity");
  return root.answerTextMaxBytes;
}
