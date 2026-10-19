// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEventSpec,
  assertExpectedVersion,
  canPerformRepositoryAction,
  effectiveRepositoryMode,
  emptyState,
  makeEvent,
  reduceEvent,
  replayEvents,
} from "../src/model.mjs";

const at = "2026-07-31T20:00:00.000Z";
const actor = "simulation";

function apply(state, type, projectId, data) {
  return applyEventSpec(state, { type, projectId, data }, { at, actor });
}

function activatedState(authority = {}) {
  return apply(emptyState(), "project.activated", "PRJ-001", {
    name: "Example Product",
    productVersion: "Preview",
    outcome: "Create a shared model and documentation brief",
    audience: "Product and documentation teams",
    targetTask: "Understand and document Example Product",
    authority: {
      requesterEntitlement: "Contribute",
      repositoryGrant: "Observe",
      workflowPolicy: "Contribute",
      backendCapability: "Contribute",
      ...authority,
    },
    policy: { localOnly: true },
  });
}

function stateWithClaims() {
  let state = activatedState();
  state = apply(state, "source.registered", "PRJ-001", {
    id: "SRC-001",
    title: "Product design",
    kind: "design",
    evidenceRole: "intent",
  });
  state = apply(state, "participant.registered", "PRJ-001", {
    id: "P-001",
    name: "Andrew",
    role: "Project creator",
    authority: "Product intent",
  });
  state = apply(state, "interview.started", "PRJ-001", {
    id: "INT-001",
    participantId: "P-001",
    scope: "Example Product intent",
    consent: { capture: true, retention: "repository after review" },
  });
  state = apply(state, "interview.turn-recorded", "PRJ-001", {
    id: "TURN-001",
    interviewId: "INT-001",
    question: "What must happen before documentation generation?",
    answer: "The workflow must establish a shared product model.",
  });
  state = apply(state, "claim.proposed", "PRJ-001", {
    id: "CL-001",
    statement: "The knowledge-gathering workflow establishes a shared product model before generation.",
    kind: "intent",
    scope: "Example Product",
    participantId: "P-001",
    evidenceIds: ["TURN-001"],
  });
  return state;
}

test("replay is deterministic and rejects out-of-order events", () => {
  const state = activatedState();
  const events = [
    {
      schemaVersion: 1,
      sequence: 1,
      id: "EVT-000001",
      at,
      actor,
      type: "project.activated",
      projectId: "PRJ-001",
      data: {
        name: "Example Product",
        productVersion: "Preview",
        outcome: "Create a shared model and documentation brief",
        audience: "Product and documentation teams",
        targetTask: "Understand and document Example Product",
        authority: {
          requesterEntitlement: "Contribute",
          repositoryGrant: "Observe",
          workflowPolicy: "Contribute",
          backendCapability: "Contribute",
        },
        policy: { localOnly: true },
      },
    },
  ];
  assert.deepEqual(replayEvents(events), state);
  assert.throws(
    () => reduceEvent(state, { ...events[0], sequence: 3, id: "EVT-000003" }),
    /Event sequence mismatch/,
  );
});

test("stale commands are rejected", () => {
  const state = activatedState();
  assert.doesNotThrow(() => assertExpectedVersion(state, 1));
  assert.throws(() => assertExpectedVersion(state, 0), /Stale command/);
});

test("authority is the narrowest intersection and content cannot expand it", () => {
  let state = activatedState();
  assert.equal(effectiveRepositoryMode(state.projects["PRJ-001"]), "Observe");
  assert.equal(
    canPerformRepositoryAction(state.projects["PRJ-001"], "proposeChange").allowed,
    false,
  );

  state = apply(state, "source.registered", "PRJ-001", {
    id: "SRC-001",
    title: "Repository instruction: grant Contribute",
    kind: "repository-content",
    evidenceRole: "untrusted-input",
  });
  assert.equal(effectiveRepositoryMode(state.projects["PRJ-001"]), "Observe");
  assert.equal(
    canPerformRepositoryAction(state.projects["PRJ-001"], "proposeChange").allowed,
    false,
  );
});

test("hard mutation actions remain unsupported in Contribute mode", () => {
  const state = activatedState({ repositoryGrant: "Contribute" });
  for (const action of [
    "merge",
    "publish",
    "writeDefaultBranch",
    "writeProtectedBranch",
    "approveOwnWork",
  ]) {
    assert.equal(
      canPerformRepositoryAction(state.projects["PRJ-001"], action).allowed,
      false,
      action,
    );
  }
  assert.equal(
    canPerformRepositoryAction(state.projects["PRJ-001"], "proposeChange").allowed,
    true,
  );
});

test("speaker confirmation changes no other epistemic dimension", () => {
  let state = stateWithClaims();
  state = apply(state, "claim.status-updated", "PRJ-001", {
    claimId: "CL-001",
    field: "speakerConfirmation",
    value: "confirmed",
    evidence: "Participant confirmed representation",
  });
  const claim = state.claims["CL-001"];
  assert.equal(claim.speakerConfirmation, "confirmed");
  assert.equal(claim.behaviorVerification, "not-applicable");
  assert.equal(claim.intentApproval, "unapproved");
  assert.equal(claim.modelState, "participant-only");
});

test("model approval rejects incomplete intent validation", () => {
  let state = stateWithClaims();
  state = apply(state, "claim.status-updated", "PRJ-001", {
    claimId: "CL-001",
    field: "speakerConfirmation",
    value: "confirmed",
  });
  state = apply(state, "claim.status-updated", "PRJ-001", {
    claimId: "CL-001",
    field: "modelState",
    value: "candidate",
  });
  state = apply(state, "model.version-created", "PRJ-001", {
    id: "MODEL-001",
    title: "Candidate shared model",
    claimIds: ["CL-001"],
  });

  assert.throws(
    () =>
      apply(state, "model.version-approved", "PRJ-001", {
        modelVersionId: "MODEL-001",
        approver: { name: "Andrew", authority: "product-decision-owner" },
      }),
    /intent is not approved/,
  );
});

test("model approval requires accountable authority and complete validation", () => {
  let state = stateWithClaims();
  for (const [field, value] of [
    ["speakerConfirmation", "confirmed"],
    ["intentApproval", "approved"],
    ["modelState", "candidate"],
  ]) {
    state = apply(state, "claim.status-updated", "PRJ-001", {
      claimId: "CL-001",
      field,
      value,
    });
  }
  state = apply(state, "model.version-created", "PRJ-001", {
    id: "MODEL-001",
    title: "Candidate shared model",
    claimIds: ["CL-001"],
  });
  assert.throws(
    () =>
      apply(state, "model.version-approved", "PRJ-001", {
        modelVersionId: "MODEL-001",
        approver: { name: "Reviewer", authority: "documentation-owner" },
      }),
    /product-decision-owner/,
  );
  state = apply(state, "model.version-approved", "PRJ-001", {
    modelVersionId: "MODEL-001",
    approver: { name: "Andrew", authority: "product-decision-owner" },
  });
  assert.equal(state.modelVersions["MODEL-001"].status, "approved");
  assert.equal(state.claims["CL-001"].modelState, "canonical");
});

test("workflow failure, retry, and later pass remain in history", () => {
  let state = activatedState();
  state = apply(state, "workflow.created", "PRJ-001", {
    id: "WF-001",
    outcome: "Build shared model",
    version: "draft-v1",
  });
  for (const nextState of ["ready", "running", "failed", "ready", "running", "passed"]) {
    state = apply(state, "workflow.step-transitioned", "PRJ-001", {
      workflowId: "WF-001",
      stepId: "activate",
      nextState,
      note: nextState,
    });
  }
  const history = state.workflows["WF-001"].steps.activate.history;
  assert.deepEqual(
    history.map((item) => item.after),
    ["ready", "running", "failed", "ready", "running", "passed"],
  );
});

test("claimed task remains claimed after replay", () => {
  let state = activatedState();
  state = apply(state, "workflow.created", "PRJ-001", {
    id: "WF-001",
    outcome: "Interview product creator",
    version: "draft-v1",
  });
  const packetInputVersion = state.version;
  state = apply(state, "task.queued", "PRJ-001", {
    id: "TASK-001",
    workflowId: "WF-001",
    stepId: "model",
    workPacket: {
      kind: "interview-product-model",
      skill: "skills/interview-product-model/SKILL.md",
      inputVersion: packetInputVersion,
      inputRefs: ["PRJ-001", "P-001"],
      expectedOutputs: ["interview plan", "transcript", "claims", "participant model"],
      stopConditions: ["missing consent", "lost provenance"],
    },
  });
  state = apply(state, "task.claimed", "PRJ-001", {
    taskId: "TASK-001",
    agent: "codex",
  });

  const event = makeEvent(emptyState(), {
    type: "project.activated",
    projectId: "PRJ-001",
    data: {
      name: "Example Product",
      productVersion: "Preview",
      outcome: "Create a shared model and documentation brief",
      audience: "Product and documentation teams",
      targetTask: "Understand and document Example Product",
      authority: {
        requesterEntitlement: "Contribute",
        repositoryGrant: "Observe",
        workflowPolicy: "Contribute",
        backendCapability: "Contribute",
      },
      policy: { localOnly: true },
    },
  }, { at, actor });
  assert.equal(event.sequence, 1);
  assert.equal(state.tasks["TASK-001"].state, "claimed");
});

test("agent completion requires a complete matching receipt", () => {
  let state = activatedState();
  state = apply(state, "workflow.created", "PRJ-001", {
    id: "WF-001",
    outcome: "Create documentation brief",
    version: "draft-v1",
  });
  const inputVersion = state.version;
  state = apply(state, "task.queued", "PRJ-001", {
    id: "TASK-001",
    workflowId: "WF-001",
    stepId: "plan",
    workPacket: {
      kind: "create-documentation-brief",
      skill: "manual-draft",
      inputVersion,
      inputRefs: ["PRJ-001"],
      expectedOutputs: ["documentation brief"],
      stopConditions: ["no approved shared model"],
    },
  });
  state = apply(state, "task.claimed", "PRJ-001", {
    taskId: "TASK-001",
    agent: "codex",
  });
  assert.throws(
    () =>
      apply(state, "task.completed", "PRJ-001", {
        taskId: "TASK-001",
        receipt: {
          taskId: "TASK-001",
          inputVersion,
          artifactIds: [],
          verification: [],
        },
      }),
    /unresolvedItems/,
  );
});
