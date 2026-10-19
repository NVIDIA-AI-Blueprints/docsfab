// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Small, data-only contracts. None of these records grants operational authority. */
import { createHash } from "node:crypto";

export const feedbackDigest = value => createHash("sha256").update(feedbackJson(value)).digest("hex");
export function feedbackJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(feedbackJson).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${feedbackJson(value[key])}`).join(",")}}`;
  }
  throw new Error("product-feedback: invalid canonical value");
}
export const feedbackRequire = condition => {
  if (!condition) throw new Error("product-feedback: invalid binding");
};
export function feedbackKeys(value, keys) {
  feedbackRequire(value !== null && typeof value === "object" && !Array.isArray(value));
  feedbackRequire(Object.getPrototypeOf(value) === Object.prototype);
  feedbackRequire(Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
export const feedbackHash = value => feedbackRequire(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
export const feedbackId = value => feedbackRequire(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value));
export function feedbackFreeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(feedbackFreeze); Object.freeze(value); }
  return value;
}
export function feedbackCopy(value) { return JSON.parse(feedbackJson(value)); }
export function feedbackSeal(body, field) { return feedbackFreeze({ ...feedbackCopy(body), [field]: feedbackDigest(body) }); }
export function feedbackVerify(input, field) {
  const { [field]: digest, ...body } = input;
  feedbackHash(digest); feedbackRequire(feedbackDigest(body) === digest);
}
function timestamp(value) {
  feedbackRequire(typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
function actor(value) {
  if (value === null) return;
  feedbackKeys(value, ["providerId", "kind"]); feedbackId(value.providerId);
  feedbackRequire(["human", "agent", "bot", "system", "unknown"].includes(value.kind));
}

export function sealSourceVersion(input) {
  feedbackKeys(input, ["projectId", "sourceKind", "sourceId", "version", "parentVersionSha256",
    "contentSha256", "locator", "author", "editor", "occurredAt", "observedAt", "assertion", "evidenceSha256s"]);
  for (const key of ["projectId", "sourceId", "version"]) feedbackId(input[key]);
  feedbackHash(input.contentSha256);
  feedbackRequire(input.locator === `docsfab-source:${input.contentSha256}`);
  if (input.parentVersionSha256 !== null) feedbackHash(input.parentVersionSha256);
  actor(input.author); actor(input.editor); timestamp(input.observedAt);
  if (input.occurredAt !== null) timestamp(input.occurredAt);
  feedbackRequire(["issue-body", "issue-comment", "issue-system-event", "repository-content", "slack-owner-input"].includes(input.sourceKind));
  feedbackRequire(["source-observation", "proposed-intent", "observed-implementation", "verified-behavior"].includes(input.assertion));
  feedbackRequire(!input.sourceKind.startsWith("issue-") || ["source-observation", "proposed-intent"].includes(input.assertion));
  feedbackRequire(Array.isArray(input.evidenceSha256s)); input.evidenceSha256s.forEach(feedbackHash);
  feedbackRequire(new Set(input.evidenceSha256s).size === input.evidenceSha256s.length);
  feedbackRequire(input.assertion !== "verified-behavior" || input.evidenceSha256s.length > 0);
  return feedbackSeal({ schemaVersion: 1, kind: "docsfab-feedback-source-version", ...input }, "sourceVersionSha256");
}

export function parseSourceVersion(input) {
  feedbackKeys(input, ["schemaVersion", "kind", "projectId", "sourceKind", "sourceId", "version", "parentVersionSha256",
    "contentSha256", "locator", "author", "editor", "occurredAt", "observedAt", "assertion", "evidenceSha256s", "sourceVersionSha256"]);
  feedbackVerify(input, "sourceVersionSha256");
  feedbackRequire(input.schemaVersion === 1 && input.kind === "docsfab-feedback-source-version");
  const { schemaVersion, kind, sourceVersionSha256, ...body } = input;
  return sealSourceVersion(body);
}
