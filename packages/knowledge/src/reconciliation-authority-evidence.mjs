// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Retained roster/actor evidence only. Live membership admission belongs to the host reader. */
import { createHash } from "node:crypto";
import { feedbackJson as canonicalJson } from "./product-feedback-contracts.mjs";
const CREDENTIAL = [/\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b/u, /\bxox[baprcds]-[A-Za-z0-9-]{20,}\b/u];
function fail(label) { throw new Error(`reconciliation-authority-evidence: ${label}`); }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(label); return value; }
function exact(value, keys) { if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail("shape"); }
function identifier(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) fail(label); return value; }
function hash(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("digest"); return value; }
function timestamp(value, label) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(label); return value; }
function array(value, label) { if (!Array.isArray(value)) fail(label); return value; }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function maintainerSnapshot(input) {
  const value = object(input, "maintainer snapshot");
  exact(value, ["schemaVersion", "kind", "binding", "repository", "source", "observedAt", "members", "membersSha256", "snapshotSha256"]);
  if (value.schemaVersion !== 1 || value.kind !== "docsfab-repository-maintainer-snapshot" || value.source !== "gitlab-project-members-all-and-user-profile") fail("maintainer snapshot");
  const binding = object(value.binding, "maintainer project"); exact(binding, ["deploymentId", "projectId", "deploymentEpoch", "provider", "providerHost", "providerProjectId"]);
  for (const key of ["deploymentId", "projectId", "deploymentEpoch", "providerProjectId"]) identifier(binding[key], "maintainer project");
  if (binding.provider !== "gitlab" || typeof binding.providerHost !== "string" || binding.providerHost !== binding.providerHost.toLowerCase() ||
      /[\s/@?#%\\]/u.test(binding.providerHost)) fail("maintainer host");
  const host = new URL(`https://${binding.providerHost}`); if (host.host !== binding.providerHost || host.username || host.password) fail("maintainer host");
  if (typeof value.repository !== "string" || /[\\\s\u0000-\u001f\u007f?#%]/u.test(value.repository) ||
      value.repository.split("/").some(part => !part || part === "." || part === "..") || CREDENTIAL.some(pattern => pattern.test(value.repository))) fail("maintainer repository");
  timestamp(value.observedAt, "membership time");
  const members = array(value.members, "members"); if (!members.length) fail("empty members");
  for (const member of members) { exact(object(member, "member"), ["gitlabUserId", "username", "accessLevel"]);
    if (typeof member.gitlabUserId !== "string" || !/^[1-9][0-9]*$/u.test(member.gitlabUserId) || !Number.isSafeInteger(Number(member.gitlabUserId)) ||
        !Number.isSafeInteger(member.accessLevel) || member.accessLevel < 40) fail("maintainer member"); identifier(member.username, "maintainer username"); }
  const ordered = [...members].sort((a,b) => a.username < b.username ? -1 : a.username > b.username ? 1 : Number(a.gitlabUserId) - Number(b.gitlabUserId));
  if (new Set(members.map(row => row.gitlabUserId)).size !== members.length || new Set(members.map(row => row.username.toLowerCase())).size !== members.length ||
      canonicalJson(ordered) !== canonicalJson(members) || hash(value.membersSha256) !== digest(canonicalJson(members))) fail("maintainer roster");
  const { snapshotSha256, ...body } = value; if (hash(snapshotSha256) !== digest(canonicalJson(body))) fail("maintainer snapshot digest"); return value;
}
export function maintainerQuestionAuthority(input) {
  const value = object(input, "maintainer question authority"); exact(value, ["schemaVersion", "kind", "ownerKey", "authorityKind", "snapshot", "workspaceId", "conversationId"]);
  if (value.schemaVersion !== 2 || value.kind !== "repository-maintainers") fail("maintainer question authority");
  identifier(value.ownerKey, "owner key"); identifier(value.authorityKind, "authority kind"); maintainerSnapshot(value.snapshot);
  for (const key of ["workspaceId", "conversationId"]) slackIdentity(value[key]); return value;
}
function slackIdentity(value) { if (typeof value !== "string" || !/^[A-Z][A-Z0-9]+$/u.test(value)) fail("maintainer Slack identity"); return value; }
export function maintainerAnswerAuthority(input) {
  const value = object(input, "maintainer answer authority"); exact(value, ["schemaVersion", "kind", "questionSnapshotSha256", "actor"]);
  if (value.schemaVersion !== 2 || value.kind !== "repository-maintainer-admission") fail("maintainer answer authority"); hash(value.questionSnapshotSha256);
  const actor = object(value.actor, "maintainer actor");
  // V1 actor evidence names the command identity map and the sealed Slack map;
  // V2 names sealed identity links and their channel binding. The closed key set
  // per version is what stops one provenance from being read as the other.
  const provenance = actor.schemaVersion === 2 ? ["identityLinksSha256", "channelBindingSha256"] : ["identityMapSha256", "slackMapSha256"];
  exact(actor, ["schemaVersion", "kind", "snapshot", "gitlabUserId", "principalId", "workspaceId", "conversationId", "slackUserId", ...provenance, "receiptSha256"]);
  if (![1, 2].includes(actor.schemaVersion) || actor.kind !== "docsfab-repository-maintainer-actor") fail("maintainer actor"); maintainerSnapshot(actor.snapshot);
  if (!actor.snapshot.members.some(member => member.gitlabUserId === actor.gitlabUserId)) fail("maintainer actor membership");
  identifier(actor.principalId, "maintainer principal"); for (const key of ["workspaceId", "conversationId", "slackUserId"]) slackIdentity(actor[key]);
  for (const key of provenance) hash(actor[key]); const { receiptSha256, ...body } = actor;
  if (hash(receiptSha256) !== digest(canonicalJson(body))) fail("maintainer actor receipt"); return value;
}
/** The receipt names the exact identity provenance the live reader admitted the actor through. */
export function maintainerIdentityReceipt(actor) {
  return digest(canonicalJson({ schemaVersion: 2, kind: "docsfab-repository-maintainer-identity", binding: actor.snapshot.binding,
    gitlabUserId: actor.gitlabUserId, principalId: actor.principalId, workspaceId: actor.workspaceId, conversationId: actor.conversationId,
    slackUserId: actor.slackUserId, ...(actor.schemaVersion === 2
      ? { identityLinksSha256: actor.identityLinksSha256, channelBindingSha256: actor.channelBindingSha256 }
      : { identityMapSha256: actor.identityMapSha256, slackMapSha256: actor.slackMapSha256 }) }));
}
export function bindMaintainerAnswerActor(answer) {
  const actor = answer.authority.actor;
  const identityReceipt = maintainerIdentityReceipt(actor);
  if (answer.principalId !== actor.principalId || answer.authorityReceiptSha256 !== actor.receiptSha256 || answer.identityReceiptSha256 !== identityReceipt ||
      answer.channelKind !== "slack" || answer.channelIdentitySha256 !== digest(`slack-identity:v1:${actor.workspaceId}:${actor.slackUserId}`) ||
      answer.accountLocatorSha256 !== digest(`slack-account:v1:${actor.workspaceId}`) ||
      answer.conversationLocatorSha256 !== digest(`slack-conversation:v1:${actor.workspaceId}:${actor.conversationId}`)) fail("maintainer answer actor binding");
}
export function sameAnswerAuthority(question, answer) {
  if (question.schemaVersion !== answer.schemaVersion) return false;
  if (question.schemaVersion === 1) return answer.principalId === question.authority.expectedPrincipalId &&
    answer.channelIdentitySha256 === question.authority.expectedChannelIdentitySha256 && answer.authorityReceiptSha256 === question.authority.authorityReceiptSha256 &&
    answer.identityReceiptSha256 === question.authority.identityReceiptSha256 && answer.ownerPolicySha256 === question.authority.ownerPolicySha256;
  const expected = question.authority, actual = answer.authority;
  return actual.questionSnapshotSha256 === expected.snapshot.snapshotSha256 && canonicalJson(actual.actor.snapshot.binding) === canonicalJson(expected.snapshot.binding) &&
    actual.actor.snapshot.repository === expected.snapshot.repository && actual.actor.workspaceId === expected.workspaceId && actual.actor.conversationId === expected.conversationId &&
    Date.parse(actual.actor.snapshot.observedAt) >= Date.parse(question.issuedAt) && Date.parse(actual.actor.snapshot.observedAt) < Date.parse(question.expiresAt);
}

export function assertRetainedReconciliationAuthority(question, answer) {
  if (question.schemaVersion === 2) {
    exact(question, ["schemaVersion", "kind", "reconciliationId", "questionId", "generation", "requestKey", "stoppedAttemptId", "stoppedJobSha256",
      "stoppedPacketSha256", "stoppedContextBindingSha256", "continuationAttemptKey", "resumeAnchorSha256", "severityPolicyVersion", "severityPolicySha256",
      "measurementReceiptSha256", "conflictId", "conflictSnapshotSha256", "classification", "decisionKind", "confidence", "confidenceBasisSha256", "impact",
      "impactBasisSha256", "blocksTargets", "safeSummary", "variants", "offeredClaimIds", "allowedDispositions", "questionTextSha256", "choiceSetSha256",
      "contextThreadId", "authority", "route", "expiresAt", "issuedAt", "questionSha256", ...(Object.hasOwn(question, "semanticOffer") ? ["semanticOffer"] : []),
      ...(Object.hasOwn(question, "ownerInformation") ? ["ownerInformation"] : []),
      ...(Object.hasOwn(question, "semanticOffer") || Object.hasOwn(question, "ownerInformation") ? ["semanticDelivery"] : [])]);
    const authority = maintainerQuestionAuthority(question.authority);
    if (question.route.channelKind !== "slack" || question.route.accountLocatorSha256 !== digest(`slack-account:v1:${authority.workspaceId}`) ||
        question.route.conversationLocatorSha256 !== digest(`slack-conversation:v1:${authority.workspaceId}:${authority.conversationId}`) ||
        Date.parse(authority.snapshot.observedAt) > Date.parse(question.issuedAt)) fail("question authority binding");
  }
  else if (question.schemaVersion !== 1) fail("question version");
  if (answer.schemaVersion === 2) {
    exact(answer, ["schemaVersion", "kind", "reconciliationId", "questionId", "generation", "questionSha256", "conflictId", "principalId", "identityReceiptSha256",
      "authorityReceiptSha256", "authority", "channelKind", "eventLocatorSha256", "messageLocatorSha256", "channelIdentitySha256", "accountLocatorSha256",
      "conversationLocatorSha256", "threadLocatorSha256", "providerLocatorSha256", "contentSha256", "decision", "receivedAt", "answerId", "answerSha256"]);
    maintainerAnswerAuthority(answer.authority); bindMaintainerAnswerActor(answer);
  }
  else if (answer.schemaVersion !== 1) fail("answer version");
  if (!sameAnswerAuthority(question, answer) || answer.questionId !== question.questionId || answer.questionSha256 !== question.questionSha256 ||
      answer.generation !== question.generation || answer.conflictId !== question.conflictId || answer.reconciliationId !== question.reconciliationId ||
      ["channelKind", "accountLocatorSha256", "conversationLocatorSha256", "threadLocatorSha256"].some(key => answer[key] !== question.route[key]) ||
      Date.parse(answer.receivedAt) < Date.parse(question.issuedAt) || Date.parse(answer.receivedAt) >= Date.parse(question.expiresAt)) fail("answer authority binding");
}

