// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { sealKnowledgeAcceptedSnapshot } from "./attributed-snapshot.mjs";

export {
  emitAttributedSnapshot,
  sealKnowledgeAcceptedSnapshot,
} from "./attributed-snapshot.mjs";

function sortedProjectEntities(collection, projectId) {
  return Object.values(collection)
    .filter((entity) => entity.projectId === projectId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function requireProject(state, projectId) {
  const project = state.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  return project;
}

function selectEntity(
  collection,
  projectId,
  requestedId,
  label,
  predicate = () => true,
) {
  if (requestedId) {
    const entity = collection[requestedId];
    if (!entity || entity.projectId !== projectId) {
      throw new Error(`Unknown ${label}: ${requestedId}`);
    }
    return entity;
  }
  const candidates = sortedProjectEntities(collection, projectId).filter(
    predicate,
  );
  if (candidates.length === 0) {
    throw new Error(`Project has no ${label}`);
  }
  return candidates.at(-1);
}

function line(value) {
  return String(value ?? "")
    .replaceAll("\n", " ")
    .trim();
}

function bullet(value) {
  return `- ${line(value)}`;
}

function compareId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotClaim(claim) {
  return {
    id: claim.id,
    kind: claim.kind,
    scope: String(claim.scope).normalize("NFC"),
    statement: String(claim.statement).normalize("NFC"),
    modelState: claim.modelState,
    evidenceIds: [...claim.evidenceIds].sort(compareString),
  };
}

function snapshotSource(source) {
  const kind = String(source.kind ?? "").normalize("NFC");
  const location = String(source.location ?? "")
    .normalize("NFC")
    .trim();
  if (kind.length === 0) {
    throw new Error(`Source ${source.id} is missing a locator kind`);
  }
  return {
    id: source.id,
    locator: location.length > 0 ? `${kind}:${location}` : kind,
  };
}

function claimBlock(claim) {
  return [
    `### ${claim.id}: ${line(claim.statement)}`,
    "",
    `- Kind: ${claim.kind}`,
    `- Scope: ${line(claim.scope)}`,
    `- Participant: ${claim.participantId ?? "not applicable"}`,
    `- Speaker confirmation: ${claim.speakerConfirmation}`,
    `- Behavior verification: ${claim.behaviorVerification}`,
    `- Intent approval: ${claim.intentApproval}`,
    `- Model state: ${claim.modelState}`,
    `- Evidence: ${claim.evidenceIds.map(line).join(", ")}`,
  ];
}

export function sharedModelMarkdown(state, projectId, modelVersionId = null) {
  const project = requireProject(state, projectId);
  const model = selectEntity(
    state.modelVersions,
    projectId,
    modelVersionId,
    "shared-model version",
    (candidate) => candidate.status === "approved",
  );
  const claims = model.claimIds.map((claimId) => state.claims[claimId]);
  const unresolved = sortedProjectEntities(state.claims, projectId).filter(
    (claim) => !model.claimIds.includes(claim.id),
  );
  const sources = sortedProjectEntities(state.sources, projectId);

  const output = [
    `# Shared Model: ${line(project.name)}`,
    "",
    `- Project: ${project.id}`,
    `- Product version: ${line(project.productVersion)}`,
    `- Model version: ${model.id}`,
    `- Model status: ${model.status}`,
    `- Model approved by: ${model.approver?.name ?? "not approved"}`,
    `- Canonical stream version: ${state.version}`,
    "",
    "## Intended outcome",
    "",
    line(project.outcome),
    "",
    "## Audience and target task",
    "",
    `- Audience: ${line(project.audience)}`,
    `- Target task: ${line(project.targetTask)}`,
    "",
    "## Model claims",
    "",
  ];
  for (const claim of claims) {
    output.push(...claimBlock(claim), "");
  }
  output.push("## Evidence sources", "");
  if (sources.length === 0) {
    output.push("- None registered", "");
  } else {
    output.push(
      ...sources.map(
        (source) =>
          `- ${source.id}: ${line(source.title)} — ${source.kind}; role: ${source.evidenceRole}`,
      ),
      "",
    );
  }
  output.push("## Claims outside this model version", "");
  if (unresolved.length === 0) {
    output.push("- None", "");
  } else {
    output.push(
      ...unresolved.map(
        (claim) =>
          `${bullet(`${claim.id}: ${claim.statement}`)} [${claim.modelState}]`,
      ),
      "",
    );
  }
  return `${output.join("\n").trim()}\n`;
}

export function knowledgeAcceptedSnapshot(
  state,
  projectId,
  modelVersionId = null,
  options = {},
) {
  requireProject(state, projectId);
  const allowCandidate = options.allowCandidate === true;
  const model = selectEntity(
    state.modelVersions,
    projectId,
    modelVersionId,
    "shared-model version",
    allowCandidate
      ? () => true
      : (candidate) => candidate.status === "approved",
  );
  if (!allowCandidate && model.status !== "approved") {
    throw new Error(`Shared-model version is not approved: ${model.status}`);
  }
  if (
    allowCandidate &&
    model.status !== "candidate" &&
    model.status !== "approved" &&
    model.status !== "canonical"
  ) {
    throw new Error(
      `Shared-model version cannot be snapshotted: ${model.status}`,
    );
  }
  const claims = model.claimIds.map((claimId) => {
    const claim = state.claims[claimId];
    if (!claim) {
      throw new Error(`Unknown claim: ${claimId}`);
    }
    return snapshotClaim(claim);
  });
  const sourceIds = [
    ...new Set(claims.flatMap((claim) => claim.evidenceIds)),
  ].sort(compareString);
  const sources = sourceIds.map((sourceId) => {
    const source = state.sources[sourceId];
    if (!source || source.projectId !== projectId) {
      throw new Error(`Claim evidence is not a registered source: ${sourceId}`);
    }
    return snapshotSource(source);
  });
  return sealKnowledgeAcceptedSnapshot({
    projectId,
    modelVersionId: model.id,
    streamVersion: state.version,
    status: model.status,
    claims: claims.sort(compareId),
    sources: sources.sort(compareId),
    conflicts: [],
  });
}

export function documentationBriefMarkdown(state, projectId, planId = null) {
  const project = requireProject(state, projectId);
  const plan = selectEntity(
    state.documentationPlans,
    projectId,
    planId,
    "documentation plan",
  );
  const model = state.modelVersions[plan.modelVersionId];
  if (!model) {
    throw new Error(`Unknown shared-model version: ${plan.modelVersionId}`);
  }
  const claims = model.claimIds.map((claimId) => state.claims[claimId]);
  const output = [
    `# Documentation Brief: ${line(plan.title)}`,
    "",
    `- Project: ${project.id} — ${line(project.name)}`,
    `- Canonical stream version: ${state.version}`,
    `- Shared-model input: ${model.id} (${model.status})`,
    "",
    "## Audience",
    "",
    line(plan.audience),
    "",
    "## Target task",
    "",
    line(plan.targetTask),
    "",
    "## Intended outcome",
    "",
    line(plan.outcome),
    "",
    "## Scope",
    "",
    line(plan.scope),
    "",
    "## Exclusions",
    "",
    line(plan.exclusions) || "None recorded.",
    "",
    "## Shared-model claims to preserve",
    "",
    ...claims.map((claim) => bullet(`${claim.id}: ${claim.statement}`)),
    "",
    "## Required checks",
    "",
    ...plan.requiredChecks.map(bullet),
    "",
  ];
  return `${output.join("\n").trim()}\n`;
}

export function workflowRecordMarkdown(state, workflowId) {
  const workflow = state.workflows[workflowId];
  if (!workflow) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  const project = requireProject(state, workflow.projectId);
  const tasks = sortedProjectEntities(state.tasks, project.id).filter(
    (task) => task.workflowId === workflowId,
  );
  const output = [
    `# Workflow Record: ${line(workflow.outcome)}`,
    "",
    `- Workflow: ${workflow.id}`,
    `- Workflow definition: ${line(workflow.version)}`,
    `- Project: ${project.id} — ${line(project.name)}`,
    `- Canonical stream version: ${state.version}`,
    "",
    "## Lifecycle steps",
    "",
  ];
  for (const step of Object.values(workflow.steps)) {
    output.push(`### ${step.id}: ${step.state}`, "");
    if (step.history.length === 0) {
      output.push("- No transitions", "");
    } else {
      output.push(
        ...step.history.map(
          (entry) =>
            `- ${entry.at}: ${entry.before} → ${entry.after}; actor: ${entry.actor}; note: ${line(entry.note) || "none"}`,
        ),
        "",
      );
    }
  }
  output.push("## Agent work packets and receipts", "");
  if (tasks.length === 0) {
    output.push("- None", "");
  }
  for (const task of tasks) {
    output.push(
      `### ${task.id}: ${task.workPacket.kind}`,
      "",
      `- State: ${task.state}`,
      `- Step: ${task.stepId}`,
      `- Skill: ${task.workPacket.skill}`,
      `- Input version: ${task.workPacket.inputVersion}`,
      `- Inputs: ${task.workPacket.inputRefs.join(", ")}`,
      `- Expected outputs: ${task.workPacket.expectedOutputs.join(", ")}`,
      `- Stop conditions: ${task.workPacket.stopConditions.join(", ")}`,
      `- Claimed by: ${task.claimedBy ?? "nobody"}`,
      `- Receipt: ${task.receipt ? JSON.stringify(task.receipt) : "not submitted"}`,
      "",
    );
  }
  return `${output.join("\n").trim()}\n`;
}
