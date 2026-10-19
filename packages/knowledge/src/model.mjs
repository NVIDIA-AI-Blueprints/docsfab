// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
export const EVENT_SCHEMA_VERSION = 1;

export const CLAIM_STATUS_VALUES = {
  speakerConfirmation: ["unconfirmed", "confirmed", "corrected", "not-applicable"],
  behaviorVerification: ["unverified", "verified", "contradicted", "not-applicable"],
  intentApproval: ["unapproved", "approved", "rejected", "not-applicable"],
  modelState: [
    "participant-only",
    "candidate",
    "disputed",
    "unresolved",
    "canonical",
    "superseded",
  ],
};

export const REPOSITORY_MODES = ["Discover", "Observe", "Review", "Contribute"];

export const WORKFLOW_STEPS = [
  "activate",
  "model",
  "plan",
  "create",
  "check",
  "review",
  "deliver",
  "use",
  "observe",
  "learn",
];

const STEP_TRANSITIONS = {
  "not-started": new Set(["ready"]),
  ready: new Set(["running"]),
  running: new Set(["passed", "needs-input", "blocked", "failed", "awaiting-review"]),
  "needs-input": new Set(["ready"]),
  blocked: new Set(["ready"]),
  failed: new Set(["ready"]),
  "awaiting-review": new Set(["passed", "needs-input", "blocked", "failed"]),
  passed: new Set(["ready"]),
};

const TASK_TRANSITIONS = {
  queued: new Set(["claimed"]),
  claimed: new Set(["completed", "needs-input", "blocked", "failed"]),
  "needs-input": new Set(["queued"]),
  blocked: new Set(["queued"]),
  failed: new Set(["queued"]),
  completed: new Set(),
};

const MODE_LEVEL = {
  Discover: 0,
  Observe: 1,
  Review: 2,
  Contribute: 3,
};

const ACTION_LEVEL = {
  discover: 0,
  read: 1,
  analyze: 1,
  recordFinding: 2,
  comment: 2,
  proposeChange: 3,
};

const UNSUPPORTED_ACTIONS = new Set([
  "approveOwnWork",
  "changePolicy",
  "manageCredentials",
  "merge",
  "publish",
  "writeDefaultBranch",
  "writeProtectedBranch",
]);

const EVENT_TYPES = new Set([
  "project.activated",
  "source.registered",
  "participant.registered",
  "interview.started",
  "interview.turn-recorded",
  "claim.proposed",
  "claim.status-updated",
  "model.version-created",
  "model.version-approved",
  "docs.plan-created",
  "artifact.registered",
  "workflow.created",
  "workflow.step-transitioned",
  "task.queued",
  "task.claimed",
  "task.completed",
  "task.needs-input",
  "task.blocked",
  "task.failed",
  "task.requeued",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireEntity(collection, id, label) {
  const entity = collection[id];
  if (!entity) {
    throw new Error(`Unknown ${label}: ${id}`);
  }
  return entity;
}

function requireAbsent(collection, id, label) {
  if (collection[id]) {
    throw new Error(`${label} already exists: ${id}`);
  }
}

function assertRepositoryMode(mode, label) {
  if (!REPOSITORY_MODES.includes(mode)) {
    throw new Error(`${label} has unsupported repository mode: ${String(mode)}`);
  }
}

function claimValidationErrors(claim) {
  const errors = [];
  if (
    claim.participantId &&
    !["confirmed", "corrected"].includes(claim.speakerConfirmation)
  ) {
    errors.push("speaker representation is not confirmed");
  }
  if (
    claim.kind === "behavior" &&
    claim.behaviorVerification !== "verified"
  ) {
    errors.push("behavior is not verified");
  }
  if (claim.kind === "intent" && claim.intentApproval !== "approved") {
    errors.push("intent is not approved");
  }
  if (claim.kind === "synthesis") {
    if (!["verified", "not-applicable"].includes(claim.behaviorVerification)) {
      errors.push("synthesis behavior status is incomplete");
    }
    if (!["approved", "not-applicable"].includes(claim.intentApproval)) {
      errors.push("synthesis intent status is incomplete");
    }
  }
  if (["disputed", "unresolved", "superseded"].includes(claim.modelState)) {
    errors.push(`model state is ${claim.modelState}`);
  }
  return errors;
}

function assertStepCompletionRequirements(state, workflow, stepId, nextState) {
  if (!["passed", "awaiting-review"].includes(nextState)) {
    return;
  }
  const projectId = workflow.projectId;
  if (
    stepId === "model" &&
    !Object.values(state.modelVersions).some(
      (model) => model.projectId === projectId && model.status === "approved",
    )
  ) {
    throw new Error("Model step requires an approved shared-model version");
  }
  if (
    stepId === "plan" &&
    !Object.values(state.documentationPlans).some((plan) => plan.projectId === projectId)
  ) {
    throw new Error("Plan step requires a documentation plan");
  }
  if (
    ["create", "review"].includes(stepId) &&
    !Object.values(state.artifacts).some((artifact) => artifact.projectId === projectId)
  ) {
    throw new Error(`${stepId} step requires at least one registered artifact`);
  }
}

export function emptyState() {
  return {
    version: 0,
    eventIds: {},
    projects: {},
    sources: {},
    participants: {},
    interviews: {},
    claims: {},
    modelVersions: {},
    documentationPlans: {},
    artifacts: {},
    workflows: {},
    tasks: {},
  };
}

export function validateEvent(event, expectedSequence) {
  requireObject(event, "Event");
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported event schema: ${String(event.schemaVersion)}`);
  }
  if (event.sequence !== expectedSequence) {
    throw new Error(
      `Event sequence mismatch: expected ${expectedSequence}, received ${String(event.sequence)}`,
    );
  }
  requireString(event.id, "Event id");
  requireString(event.at, "Event timestamp");
  if (Number.isNaN(new Date(event.at).getTime())) {
    throw new Error(`Event has invalid timestamp: ${event.at}`);
  }
  requireString(event.actor, "Event actor");
  if (!EVENT_TYPES.has(event.type)) {
    throw new Error(`Unsupported event type: ${String(event.type)}`);
  }
  requireString(event.projectId, "Event project id");
  requireObject(event.data, "Event data");
  return true;
}

export function reduceEvent(currentState, event) {
  validateEvent(event, currentState.version + 1);
  if (currentState.eventIds[event.id]) {
    throw new Error(`Duplicate event id: ${event.id}`);
  }

  const state = clone(currentState);
  state.eventIds[event.id] = true;

  switch (event.type) {
    case "project.activated": {
      requireAbsent(state.projects, event.projectId, "Project");
      const authority = requireObject(event.data.authority, "Project authority");
      for (const key of [
        "requesterEntitlement",
        "repositoryGrant",
        "workflowPolicy",
        "backendCapability",
      ]) {
        assertRepositoryMode(authority[key], key);
      }
      state.projects[event.projectId] = {
        id: event.projectId,
        name: requireString(event.data.name, "Project name"),
        productVersion: requireString(event.data.productVersion, "Product version"),
        outcome: requireString(event.data.outcome, "Project outcome"),
        audience: requireString(event.data.audience, "Project audience"),
        targetTask: requireString(event.data.targetTask, "Target task"),
        authority: clone(authority),
        policy: clone(event.data.policy ?? {}),
        activatedAt: event.at,
      };
      break;
    }
    case "source.registered": {
      requireEntity(state.projects, event.projectId, "project");
      const id = requireString(event.data.id, "Source id");
      requireAbsent(state.sources, id, "Source");
      state.sources[id] = {
        id,
        projectId: event.projectId,
        title: requireString(event.data.title, "Source title"),
        kind: requireString(event.data.kind, "Source kind"),
        evidenceRole: requireString(event.data.evidenceRole, "Evidence role"),
        location: event.data.location ?? "",
        authority: event.data.authority ?? "context",
        freshness: event.data.freshness ?? "unknown",
        registeredAt: event.at,
      };
      break;
    }
    case "participant.registered": {
      requireEntity(state.projects, event.projectId, "project");
      const id = requireString(event.data.id, "Participant id");
      requireAbsent(state.participants, id, "Participant");
      state.participants[id] = {
        id,
        projectId: event.projectId,
        name: requireString(event.data.name, "Participant name"),
        role: requireString(event.data.role, "Participant role"),
        authority: requireString(event.data.authority, "Participant authority"),
        status: "registered",
      };
      break;
    }
    case "interview.started": {
      requireEntity(state.projects, event.projectId, "project");
      const participant = requireEntity(
        state.participants,
        event.data.participantId,
        "participant",
      );
      if (participant.projectId !== event.projectId) {
        throw new Error("Participant belongs to another project");
      }
      const id = requireString(event.data.id, "Interview id");
      requireAbsent(state.interviews, id, "Interview");
      state.interviews[id] = {
        id,
        projectId: event.projectId,
        participantId: participant.id,
        scope: requireString(event.data.scope, "Interview scope"),
        consent: clone(requireObject(event.data.consent, "Interview consent")),
        status: "in-progress",
        turns: [],
        startedAt: event.at,
      };
      participant.status = "interviewed";
      break;
    }
    case "interview.turn-recorded": {
      const interview = requireEntity(state.interviews, event.data.interviewId, "interview");
      if (interview.projectId !== event.projectId) {
        throw new Error("Interview belongs to another project");
      }
      const turnId = requireString(event.data.id, "Interview turn id");
      if (interview.turns.some((turn) => turn.id === turnId)) {
        throw new Error(`Interview turn already exists: ${turnId}`);
      }
      interview.turns.push({
        id: turnId,
        question: requireString(event.data.question, "Interview question"),
        answer: requireString(event.data.answer, "Interview answer"),
        recordedAt: event.at,
      });
      break;
    }
    case "claim.proposed": {
      requireEntity(state.projects, event.projectId, "project");
      const id = requireString(event.data.id, "Claim id");
      requireAbsent(state.claims, id, "Claim");
      const kind = requireString(event.data.kind, "Claim kind");
      if (!["participant-belief", "behavior", "intent", "synthesis"].includes(kind)) {
        throw new Error(`Unsupported claim kind: ${kind}`);
      }
      if (event.data.participantId) {
        const participant = requireEntity(
          state.participants,
          event.data.participantId,
          "participant",
        );
        if (participant.projectId !== event.projectId) {
          throw new Error("Claim participant belongs to another project");
        }
      }
      const evidenceIds = requireArray(event.data.evidenceIds, "Claim evidence ids");
      if (evidenceIds.length === 0) {
        throw new Error("Claim must reference at least one evidence id");
      }
      state.claims[id] = {
        id,
        projectId: event.projectId,
        statement: requireString(event.data.statement, "Claim statement"),
        kind,
        scope: requireString(event.data.scope, "Claim scope"),
        participantId: event.data.participantId ?? null,
        evidenceIds: clone(evidenceIds),
        speakerConfirmation: event.data.participantId ? "unconfirmed" : "not-applicable",
        behaviorVerification: kind === "behavior" ? "unverified" : "not-applicable",
        intentApproval: kind === "intent" ? "unapproved" : "not-applicable",
        modelState: event.data.participantId ? "participant-only" : "candidate",
        statusHistory: [],
      };
      break;
    }
    case "claim.status-updated": {
      const claim = requireEntity(state.claims, event.data.claimId, "claim");
      if (claim.projectId !== event.projectId) {
        throw new Error("Claim belongs to another project");
      }
      const field = requireString(event.data.field, "Claim status field");
      const allowed = CLAIM_STATUS_VALUES[field];
      if (!allowed) {
        throw new Error(`Unsupported claim status field: ${field}`);
      }
      const value = requireString(event.data.value, "Claim status value");
      if (!allowed.includes(value)) {
        throw new Error(`Unsupported ${field} value: ${value}`);
      }
      claim.statusHistory.push({
        at: event.at,
        actor: event.actor,
        field,
        before: claim[field],
        after: value,
        evidence: event.data.evidence ?? "",
      });
      claim[field] = value;
      break;
    }
    case "model.version-created": {
      requireEntity(state.projects, event.projectId, "project");
      const id = requireString(event.data.id, "Model version id");
      requireAbsent(state.modelVersions, id, "Model version");
      const claimIds = requireArray(event.data.claimIds, "Model claim ids");
      if (claimIds.length === 0) {
        throw new Error("Model version requires at least one claim");
      }
      for (const claimId of claimIds) {
        const claim = requireEntity(state.claims, claimId, "claim");
        if (claim.projectId !== event.projectId) {
          throw new Error("Model includes a claim from another project");
        }
      }
      state.modelVersions[id] = {
        id,
        projectId: event.projectId,
        claimIds: clone(claimIds),
        title: requireString(event.data.title, "Model version title"),
        status: "candidate",
        createdAt: event.at,
        approvedAt: null,
        approver: null,
      };
      break;
    }
    case "model.version-approved": {
      const model = requireEntity(state.modelVersions, event.data.modelVersionId, "model version");
      if (model.projectId !== event.projectId) {
        throw new Error("Model version belongs to another project");
      }
      if (model.status !== "candidate") {
        throw new Error(`Model version is not a candidate: ${model.status}`);
      }
      const approver = requireObject(event.data.approver, "Model approver");
      requireString(approver.name, "Approver name");
      if (approver.authority !== "product-decision-owner") {
        throw new Error("Shared-model approval requires product-decision-owner authority");
      }
      const errors = model.claimIds.flatMap((claimId) =>
        claimValidationErrors(state.claims[claimId]).map((error) => `${claimId}: ${error}`),
      );
      if (errors.length > 0) {
        throw new Error(`Model version is not approvable: ${errors.join("; ")}`);
      }
      model.status = "approved";
      model.approvedAt = event.at;
      model.approver = clone(approver);
      for (const claimId of model.claimIds) {
        state.claims[claimId].statusHistory.push({
          at: event.at,
          actor: event.actor,
          field: "modelState",
          before: state.claims[claimId].modelState,
          after: "canonical",
          evidence: `Approved in ${model.id}`,
        });
        state.claims[claimId].modelState = "canonical";
      }
      break;
    }
    case "docs.plan-created": {
      requireEntity(state.projects, event.projectId, "project");
      const id = requireString(event.data.id, "Documentation plan id");
      requireAbsent(state.documentationPlans, id, "Documentation plan");
      const model = requireEntity(
        state.modelVersions,
        event.data.modelVersionId,
        "model version",
      );
      if (model.projectId !== event.projectId) {
        throw new Error("Documentation plan model belongs to another project");
      }
      state.documentationPlans[id] = {
        id,
        projectId: event.projectId,
        modelVersionId: model.id,
        title: requireString(event.data.title, "Documentation title"),
        audience: requireString(event.data.audience, "Documentation audience"),
        targetTask: requireString(event.data.targetTask, "Documentation target task"),
        outcome: requireString(event.data.outcome, "Documentation outcome"),
        scope: requireString(event.data.scope, "Documentation scope"),
        exclusions: event.data.exclusions ?? "",
        requiredChecks: clone(requireArray(event.data.requiredChecks, "Required checks")),
        createdAt: event.at,
      };
      break;
    }
    case "artifact.registered": {
      requireEntity(state.projects, event.projectId, "project");
      const id = requireString(event.data.id, "Artifact id");
      requireAbsent(state.artifacts, id, "Artifact");
      state.artifacts[id] = {
        id,
        projectId: event.projectId,
        title: requireString(event.data.title, "Artifact title"),
        kind: requireString(event.data.kind, "Artifact kind"),
        path: requireString(event.data.path, "Artifact path"),
        digest: requireString(event.data.digest, "Artifact digest"),
        state: event.data.state ?? "draft",
        createdAt: event.at,
      };
      break;
    }
    case "workflow.created": {
      requireEntity(state.projects, event.projectId, "project");
      const id = requireString(event.data.id, "Workflow id");
      requireAbsent(state.workflows, id, "Workflow");
      state.workflows[id] = {
        id,
        projectId: event.projectId,
        outcome: requireString(event.data.outcome, "Workflow outcome"),
        version: requireString(event.data.version, "Workflow version"),
        steps: Object.fromEntries(
          WORKFLOW_STEPS.map((stepId) => [
            stepId,
            { id: stepId, state: "not-started", note: "", history: [] },
          ]),
        ),
        createdAt: event.at,
      };
      break;
    }
    case "workflow.step-transitioned": {
      const workflow = requireEntity(state.workflows, event.data.workflowId, "workflow");
      if (workflow.projectId !== event.projectId) {
        throw new Error("Workflow belongs to another project");
      }
      const step = requireEntity(workflow.steps, event.data.stepId, "workflow step");
      const nextState = requireString(event.data.nextState, "Next step state");
      if (!STEP_TRANSITIONS[step.state]?.has(nextState)) {
        throw new Error(
          `Invalid step transition: ${step.id} ${step.state} → ${nextState}`,
        );
      }
      assertStepCompletionRequirements(state, workflow, step.id, nextState);
      step.history.push({
        at: event.at,
        actor: event.actor,
        before: step.state,
        after: nextState,
        note: event.data.note ?? "",
      });
      step.state = nextState;
      step.note = event.data.note ?? "";
      break;
    }
    case "task.queued": {
      const workflow = requireEntity(state.workflows, event.data.workflowId, "workflow");
      if (workflow.projectId !== event.projectId) {
        throw new Error("Task workflow belongs to another project");
      }
      const id = requireString(event.data.id, "Task id");
      requireAbsent(state.tasks, id, "Task");
      const packet = requireObject(event.data.workPacket, "Work packet");
      requireString(packet.kind, "Work packet kind");
      requireString(packet.skill, "Work packet skill");
      requireArray(packet.inputRefs, "Work packet input refs");
      const expectedOutputs = requireArray(packet.expectedOutputs, "Expected outputs");
      if (expectedOutputs.length === 0) {
        throw new Error("Work packet requires at least one expected output");
      }
      requireArray(packet.stopConditions, "Work packet stop conditions");
      if (packet.inputVersion !== state.version) {
        throw new Error(
          `Work packet input version ${String(packet.inputVersion)} does not match state ${state.version}`,
        );
      }
      state.tasks[id] = {
        id,
        projectId: event.projectId,
        workflowId: workflow.id,
        stepId: requireString(event.data.stepId, "Task step id"),
        state: "queued",
        workPacket: clone(packet),
        claimedBy: null,
        receipt: null,
        history: [{ at: event.at, actor: event.actor, before: null, after: "queued" }],
      };
      break;
    }
    case "task.claimed":
    case "task.completed":
    case "task.needs-input":
    case "task.blocked":
    case "task.failed":
    case "task.requeued": {
      const task = requireEntity(state.tasks, event.data.taskId, "task");
      if (task.projectId !== event.projectId) {
        throw new Error("Task belongs to another project");
      }
      const nextState =
        event.type === "task.requeued" ? "queued" : event.type.replace("task.", "");
      if (!TASK_TRANSITIONS[task.state]?.has(nextState)) {
        throw new Error(`Invalid task transition: ${task.state} → ${nextState}`);
      }
      if (nextState === "claimed") {
        task.claimedBy = requireString(event.data.agent, "Claiming agent");
      }
      if (nextState === "completed") {
        const receipt = requireObject(event.data.receipt, "Agent receipt");
        if (receipt.taskId !== task.id) {
          throw new Error("Agent receipt task id does not match");
        }
        if (receipt.inputVersion !== task.workPacket.inputVersion) {
          throw new Error("Agent receipt input version does not match work packet");
        }
        for (const field of [
          "artifactIds",
          "verification",
          "unresolvedItems",
          "manualInterventions",
        ]) {
          requireArray(receipt[field], `Agent receipt ${field}`);
        }
        for (const artifactId of receipt.artifactIds) {
          const artifact = requireEntity(state.artifacts, artifactId, "artifact");
          if (artifact.projectId !== event.projectId) {
            throw new Error("Agent receipt includes artifact from another project");
          }
        }
        task.receipt = clone(receipt);
      }
      task.history.push({
        at: event.at,
        actor: event.actor,
        before: task.state,
        after: nextState,
        note: event.data.note ?? "",
      });
      task.state = nextState;
      break;
    }
    default:
      throw new Error(`Reducer does not handle event type: ${event.type}`);
  }

  state.version = event.sequence;
  return state;
}

export function replayEvents(events) {
  let state = emptyState();
  for (const event of events) {
    state = reduceEvent(state, event);
  }
  return state;
}

export function makeEvent(state, spec, options = {}) {
  requireObject(spec, "Event specification");
  const sequence = state.version + 1;
  const at = options.at ?? new Date().toISOString();
  const actor = options.actor ?? "local-operator";
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    sequence,
    id: `EVT-${String(sequence).padStart(6, "0")}`,
    at,
    actor: requireString(actor, "Event actor"),
    type: requireString(spec.type, "Event type"),
    projectId: requireString(spec.projectId, "Project id"),
    data: clone(requireObject(spec.data, "Event data")),
  };
}

export function applyEventSpec(state, spec, options = {}) {
  return reduceEvent(state, makeEvent(state, spec, options));
}

export function nextEntityId(state, collectionName, prefix) {
  const collection = requireObject(state[collectionName], collectionName);
  let index = Object.keys(collection).length + 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (collection[id]) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

export function effectiveRepositoryMode(project) {
  const authority = requireObject(project.authority, "Project authority");
  const modes = [
    authority.requesterEntitlement,
    authority.repositoryGrant,
    authority.workflowPolicy,
    authority.backendCapability,
  ];
  for (const mode of modes) {
    assertRepositoryMode(mode, "Authority");
  }
  return modes.reduce((lowest, mode) =>
    MODE_LEVEL[mode] < MODE_LEVEL[lowest] ? mode : lowest,
  );
}

export function canPerformRepositoryAction(project, action) {
  if (UNSUPPORTED_ACTIONS.has(action)) {
    return {
      allowed: false,
      effectiveMode: effectiveRepositoryMode(project),
      reason: `${action} is outside the knowledge backend authority boundary`,
    };
  }
  if (!(action in ACTION_LEVEL)) {
    throw new Error(`Unknown repository action: ${action}`);
  }
  const effectiveMode = effectiveRepositoryMode(project);
  const allowed = MODE_LEVEL[effectiveMode] >= ACTION_LEVEL[action];
  return {
    allowed,
    effectiveMode,
    reason: allowed
      ? `${action} is allowed in ${effectiveMode} mode`
      : `${action} requires broader authority than ${effectiveMode}`,
  };
}

export function assertExpectedVersion(state, expectedVersion) {
  if (expectedVersion !== state.version) {
    throw new Error(
      `Stale command: expected stream version ${expectedVersion}, current version is ${state.version}`,
    );
  }
}
