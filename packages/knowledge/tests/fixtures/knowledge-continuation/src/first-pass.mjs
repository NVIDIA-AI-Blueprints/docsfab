// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { sealKnowledgeAcceptedSnapshot } from "../../../../src/attributed-snapshot.mjs";
import { KnowledgeBackend } from "../../../../src/backend.mjs";
import { knowledgeAcceptedSnapshot } from "../../../../src/exports.mjs";
import { KnowledgeStore } from "../../../../src/store.mjs";

export async function gatherRepositoryFirstPass(input) {
  const store = new KnowledgeStore(input.dataDirectory);
  await store.initialize();
  const backend = new KnowledgeBackend(store);
  const dispatch = (name, payload) =>
    backend.dispatch(name, {
      expectedVersion: backend.getState().version,
      actor: "knowledge-continuation-fixture",
      input: payload,
    });
  await dispatch("project.activate", {
    name: "Continuation Fixture",
    productVersion: input.revision,
    outcome: "Resolve product purpose before authoring.",
    audience: "Documentation readers",
    targetTask: input.instruction,
    authority: {
      requesterEntitlement: "Contribute",
      repositoryGrant: "Observe",
      workflowPolicy: "Contribute",
      backendCapability: "Contribute",
    },
    policy: { localOnly: true, firstPass: true },
  });
  const projectId = Object.keys(backend.getState().projects)[0];
  const source = await dispatch("source.register", {
    projectId,
    title: "README.md",
    kind: "readme",
    evidenceRole: "intent",
    location: "readme:README.md",
    authority: "repository-revision",
    freshness: "current-revision",
  });
  const behaviorStatement = "The fixture publishes one verified café behavior page.";
  const behavior = await dispatch("claim.propose", {
    projectId,
    statement: behaviorStatement,
    kind: "behavior",
    scope: "Continuation Fixture",
    evidenceIds: [source.event.data.id],
  });
  await dispatch("claim.update-status", {
    projectId,
    claimId: behavior.event.data.id,
    field: "modelState",
    value: "candidate",
    evidence: "README.md establishes the repository-observed behavior.",
  });
  const claim = await dispatch("claim.propose", {
    projectId,
    statement: "The product purpose requires an accountable owner answer.",
    kind: "intent",
    scope: "Continuation Fixture",
    evidenceIds: [source.event.data.id],
  });
  await dispatch("claim.update-status", {
    projectId,
    claimId: claim.event.data.id,
    field: "modelState",
    value: "unresolved",
    evidence: "Repository evidence does not establish product intent.",
  });
  const model = await dispatch("model.create-version", {
    projectId,
    title: "Unresolved product intent",
    claimIds: [behavior.event.data.id, claim.event.data.id],
  });
  const exported = knowledgeAcceptedSnapshot(backend.getState(), projectId, model.event.data.id, {
    allowCandidate: true,
  });
  let snapshot = exported;
  if (process.env.DOCSFAB_FIXTURE_ADVISORY_CONFLICT === "1") {
    const { snapshotSha256: _snapshotSha256, ...body } = exported;
    const disputed = body.claims.find((entry) => entry.id === claim.event.data.id);
    snapshot = sealKnowledgeAcceptedSnapshot({
      ...body,
      claims: [
        ...body.claims.map((entry) =>
          entry.id === disputed.id ? { ...entry, modelState: "disputed" } : entry,
        ),
        {
          ...disputed,
          id: `${disputed.id}-variant`,
          statement: "The product purpose is intentionally left unspecified.",
          modelState: "disputed",
        },
      ],
      conflicts: [
        {
          id: "CF-PURPOSE",
          claimIds: [disputed.id, `${disputed.id}-variant`],
          classification: {
            impact: "load-bearing",
            impactBasisSha256: "d".repeat(64),
            blockingDocumentationPaths: ["docs/about/product.md"],
            resolutionOwner: "product-owner",
            authorityKind: "product-decision-owner",
          },
        },
      ],
    });
  }
  return {
    snapshot,
    projectId,
    modelVersionId: model.event.data.id,
    sourceCount: 1,
    behaviorStatement,
  };
}
