// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Pure registration of observed issue evidence. No I/O, approval, or operational authority. */
import { containsFirstPassCredentialMaterial } from "./first-pass-support.mjs";
import {
  feedbackDigest,
  feedbackFreeze,
  feedbackHash,
  feedbackId,
  feedbackJson,
  feedbackKeys,
  feedbackRequire,
  feedbackVerify,
  parseSourceVersion,
  sealSourceVersion,
} from "./product-feedback-contracts.mjs";
const SNAPSHOT_KEYS = [
  "schemaVersion",
  "kind",
  "binding",
  "objectKind",
  "objectId",
  "issueId",
  "issueIid",
  "noteId",
  "content",
  "contentSha256",
  "author",
  "editor",
  "editorKnowledge",
  "sourceCreatedAt",
  "sourceUpdatedAt",
  "providerCreatedAt",
  "providerUpdatedAt",
  "lifecycle",
  "system",
  "confidential",
  "internal",
  "disclosure",
  "snapshotSha256",
];
const OBSERVATION_KEYS = [
  "schemaVersion",
  "kind",
  "binding",
  "snapshotSha256",
  "parentIssueSnapshotSha256",
  "readGrantReceiptSha256",
  "requestSha256",
  "responseSha256",
  "observedAt",
  "historyKnowledge",
  "receiptSha256",
];
export function registerRepositoryIssueObservation(input) {
  feedbackKeys(input, ["snapshot", "observation", "previous"]);
  const { snapshot, observation } = input;
  feedbackKeys(snapshot, SNAPSHOT_KEYS);
  feedbackVerify(snapshot, "snapshotSha256");
  feedbackKeys(observation, OBSERVATION_KEYS);
  feedbackVerify(observation, "receiptSha256");
  feedbackRequire(
    snapshot.schemaVersion === 1 &&
      snapshot.kind === "docsfab-repository-issue-snapshot" &&
      snapshot.disclosure === "project-private",
  );
  feedbackRequire(
    observation.schemaVersion === 1 &&
      observation.kind === "docsfab-repository-issue-observation" &&
      observation.historyKnowledge === "observed-snapshots-only",
  );
  feedbackKeys(snapshot.binding, [
    "deploymentId",
    "projectId",
    "deploymentEpoch",
    "provider",
    "providerHost",
    "providerProjectId",
  ]);
  for (const field of ["deploymentId", "projectId", "deploymentEpoch"])
    feedbackId(snapshot.binding[field]);
  feedbackRequire(
    snapshot.binding.provider === "gitlab" &&
      feedbackJson(snapshot.binding) === feedbackJson(observation.binding),
  );
  feedbackRequire(observation.snapshotSha256 === snapshot.snapshotSha256);
  for (const field of [
    "readGrantReceiptSha256",
    "requestSha256",
    "responseSha256",
  ])
    feedbackHash(observation[field]);
  if (observation.parentIssueSnapshotSha256 !== null)
    feedbackHash(observation.parentIssueSnapshotSha256);
  feedbackKeys(snapshot.content, ["title", "body"]);
  feedbackRequire(
    (snapshot.content.title === null ||
      typeof snapshot.content.title === "string") &&
      typeof snapshot.content.body === "string",
  );
  const text = feedbackJson(snapshot.content);
  feedbackRequire(
    !containsFirstPassCredentialMaterial(text) &&
      !text.includes("\\u0000") &&
      Buffer.byteLength(text, "utf8") <= 8 * 1024 * 1024,
  );
  feedbackRequire(feedbackDigest(snapshot.content) === snapshot.contentSha256);
  const numeric = (value) =>
    typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value);
  feedbackRequire(
    numeric(snapshot.objectId) &&
      numeric(snapshot.issueId) &&
      numeric(snapshot.issueIid),
  );
  feedbackRequire(
    typeof snapshot.system === "boolean" &&
      typeof snapshot.confidential === "boolean" &&
      typeof snapshot.internal === "boolean",
  );
  let sourceKind, sourceId;
  if (snapshot.objectKind === "issue") {
    feedbackRequire(
      snapshot.noteId === null &&
        snapshot.objectId === snapshot.issueId &&
        snapshot.system === false &&
        ["opened", "closed"].includes(snapshot.lifecycle) &&
        observation.parentIssueSnapshotSha256 === null,
    );
    sourceKind = "issue-body";
    sourceId = `gitlab-issue:${snapshot.issueIid}:body`;
  } else {
    feedbackRequire(
      snapshot.objectKind === "note" &&
        numeric(snapshot.noteId) &&
        snapshot.objectId === snapshot.noteId &&
        snapshot.lifecycle === null &&
        snapshot.content.title === null &&
        observation.parentIssueSnapshotSha256 !== null,
    );
    sourceKind = snapshot.system ? "issue-system-event" : "issue-comment";
    sourceId = `gitlab-issue:${snapshot.issueIid}:note:${snapshot.noteId}`;
  }
  feedbackRequire(
    ["provider-reported", "unknown"].includes(snapshot.editorKnowledge) &&
      (snapshot.editorKnowledge === "unknown") === (snapshot.editor === null),
  );
  const previous =
    input.previous === null ? null : parseSourceVersion(input.previous);
  if (previous)
    feedbackRequire(
      previous.projectId === snapshot.binding.projectId &&
        previous.sourceId === sourceId,
    );
  const sourceVersion = sealSourceVersion({
    projectId: snapshot.binding.projectId,
    sourceKind,
    sourceId,
    version: `observed:${snapshot.snapshotSha256}`,
    parentVersionSha256: previous?.sourceVersionSha256 ?? null,
    contentSha256: snapshot.contentSha256,
    locator: `docsfab-source:${snapshot.contentSha256}`,
    author: snapshot.author,
    editor: snapshot.editor,
    occurredAt: snapshot.sourceUpdatedAt,
    observedAt: observation.observedAt,
    assertion: "source-observation",
    evidenceSha256s: [snapshot.snapshotSha256, observation.receiptSha256],
  });
  return feedbackFreeze({
    sourceVersion,
    disclosure: "project-private",
    implementationState: "not-established",
    authorityExpansion: false,
  });
}

/** Validate stored bytes and their normalized contract together, without treating hashes as authority. */
export function parseRepositoryIssueRegistration(input) {
  feedbackKeys(input, ["snapshot", "observation", "sourceVersion"]);
  const version = parseSourceVersion(input.sourceVersion);
  // Registration validates all source bytes; the prior hash is lineage only and
  // may be unavailable in an inert recovery archive.
  const normalized = registerRepositoryIssueObservation({
    snapshot: input.snapshot,
    observation: input.observation,
    previous: null,
  }).sourceVersion;
  const { sourceVersionSha256: ignored, ...expected } = normalized;
  expected.parentVersionSha256 = version.parentVersionSha256;
  feedbackRequire(
    feedbackJson(
      sealSourceVersion(
        Object.fromEntries(
          Object.entries(expected).filter(
            ([key]) => !["schemaVersion", "kind"].includes(key),
          ),
        ),
      ),
    ) === feedbackJson(version),
  );
  return feedbackFreeze(version);
}
