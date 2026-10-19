// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateArtifact } from "../artifacts/index.js";
import type {
  ArtifactEvidence,
  IaCandidate,
  IaGroup,
  OntologyEntity,
} from "../artifacts/contracts.js";
import type { ContentNode } from "../content-ir/contracts.js";
import { canonicalDigest } from "../content-ir/index.js";
import {
  IA_DIAGNOSTIC_RULES,
  IA_EXCEPTION_REASONS,
  IA_PAGE_PURPOSES,
  IA_SIBLING_NODE_KINDS,
  type IaDiagnostic,
  type IaDiagnosticEvaluationInput,
  type IaDiagnosticPolicy,
  type IaDiagnosticRecovery,
  type IaDiagnosticRule,
  type IaDiagnosticsReport,
  IaDiagnosticsInputError,
  type IaPageClassification,
  type IaStructuralProjection,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^\S+$/u;

interface EvaluationState {
  input: IaDiagnosticEvaluationInput;
  candidate: IaCandidate;
  nodes: ReadonlyMap<string, ContentNode>;
  entities: ReadonlyMap<string, OntologyEntity>;
  groups: ReadonlyMap<string, IaGroup>;
  classifications: ReadonlyMap<string, IaPageClassification>;
}

/**
 * Evaluate only declared and validated structure. Repository prose and labels
 * (other than the policy's exact unsupported-label set) are never interpreted.
 */
export function evaluateIaDiagnostics(input: IaDiagnosticEvaluationInput): IaDiagnosticsReport {
  const state = validateInput(input);
  const diagnostics = normalizeDiagnostics([
    ...axisDiagnostics(state),
    ...groupShapeDiagnostics(state),
    ...assignmentDiagnostics(state),
    ...overviewDiagnostics(state),
    ...labelDiagnostics(state),
    ...balanceDiagnostics(state),
    ...pagePurposeDiagnostics(state),
    ...evidenceDiagnostics(state),
  ]);
  const blocking = diagnostics.filter((item) => item.severity === "blocking").length;
  const advisory = diagnostics.length - blocking;
  return {
    schemaVersion: 1,
    repository: { ...input.index.repository },
    candidateId: state.candidate.id,
    status: blocking > 0 ? "failed" : "passed",
    highestSeverity: blocking > 0 ? "blocking" : advisory > 0 ? "advisory" : "none",
    diagnostics,
    summary: {
      rulesEvaluated: IA_DIAGNOSTIC_RULES.length,
      blocking,
      advisory,
    },
    provenance: {
      indexDigest: input.index.indexDigest,
      ontologyDigest: input.ontology.digest,
      candidatesDigest: input.candidates.digest,
      semanticDigests: input.semantics.map((item) => item.digest).sort(compareStrings),
      policy: clonePolicy(input.policy),
    },
  };
}

function validateInput(input: IaDiagnosticEvaluationInput): EvaluationState {
  let ontology: ReturnType<typeof validateArtifact>;
  let candidates: ReturnType<typeof validateArtifact>;
  try {
    ontology = validateArtifact(input.ontology, { index: input.index });
    candidates = validateArtifact(input.candidates, { index: input.index });
    input.semantics.forEach((semantic) => {
      const validated = validateArtifact(semantic, { index: input.index });
      if (validated.kind !== "context-packet") inputFail("invalid-artifact", "$.semantics");
    });
  } catch {
    inputFail("invalid-artifact", "$.artifacts");
  }
  if (ontology.kind !== "ontology") inputFail("invalid-artifact", "$.ontology.kind");
  if (candidates.kind !== "ia-candidates") inputFail("invalid-artifact", "$.candidates.kind");
  if (
    !sameRepository(input.index.repository, ontology.repository) ||
    !sameRepository(input.index.repository, candidates.repository)
  ) {
    inputFail("repository-mismatch", "$.artifacts.repository");
  }
  validatePolicy(input.policy);

  const candidate = candidates.payload.candidates.find((item) => item.id === input.candidateId);
  if (!candidate) inputFail("candidate-unresolved", "$.candidateId");
  const nodes = new Map(input.index.nodes.map((node) => [node.id, node]));
  const entities = new Map(ontology.payload.entities.map((entity) => [entity.id, entity]));
  const groups = new Map(candidate.groups.map((group) => [group.id, group]));
  validateProjection(input.structure, candidate, nodes, entities, groups);

  return {
    input,
    candidate,
    nodes,
    entities,
    groups,
    classifications: new Map(
      input.structure.pageClassifications.map((classification) => [
        classification.nodeId,
        classification,
      ]),
    ),
  };
}

function validatePolicy(policy: IaDiagnosticPolicy): void {
  if (
    !validId(policy.id) ||
    !validId(policy.version) ||
    !SHA256.test(policy.digest) ||
    !Number.isSafeInteger(policy.maxFanOut) ||
    policy.maxFanOut < 2 ||
    !Number.isFinite(policy.severeImbalanceRatio) ||
    policy.severeImbalanceRatio <= 1 ||
    !Number.isSafeInteger(policy.minOverviewBytes) ||
    policy.minOverviewBytes < 0 ||
    !Array.isArray(policy.unsupportedLabels) ||
    policy.unsupportedLabels.length === 0
  ) {
    inputFail("invalid-policy", "$.policy");
  }
  const { digest: _digest, ...digestible } = policy;
  if (canonicalDigest(digestible) !== policy.digest) {
    inputFail("invalid-policy", "$.policy.digest");
  }
  const labels = policy.unsupportedLabels.map(normalizeLabel);
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length) {
    inputFail("invalid-policy", "$.policy.unsupportedLabels");
  }
}

function validateProjection(
  structure: IaStructuralProjection,
  candidate: IaCandidate,
  nodes: ReadonlyMap<string, ContentNode>,
  entities: ReadonlyMap<string, OntologyEntity>,
  groups: ReadonlyMap<string, IaGroup>,
): void {
  uniqueIds(structure.topicNodeIds, "$.structure.topicNodeIds");
  structure.topicNodeIds.forEach((id, index) =>
    requireNode(id, nodes, `$.structure.topicNodeIds[${index}]`),
  );

  uniqueIds(
    structure.siblingSets.map((item) => item.id),
    "$.structure.siblingSets",
  );
  const assignedGroups: string[] = [];
  structure.siblingSets.forEach((set, index) => {
    const path = `$.structure.siblingSets[${index}]`;
    if (!validId(set.parentId) || set.groupIds.length === 0) inputFail("invalid-projection", path);
    uniqueIds(set.groupIds, `${path}.groupIds`);
    set.groupIds.forEach((id) => {
      if (!groups.has(id)) inputFail("invalid-projection", `${path}.groupIds`);
      assignedGroups.push(id);
    });
    if (![candidate.primaryAxis, ...candidate.secondaryAxes].includes(set.declaredAxis)) {
      inputFail("invalid-projection", `${path}.declaredAxis`);
    }
    validateEvidence(set.evidence, nodes, `${path}.evidence`);
  });
  if (new Set(assignedGroups).size !== assignedGroups.length) {
    inputFail("invalid-projection", "$.structure.siblingSets");
  }

  uniqueIds(
    structure.overviews.map((item) => item.groupId),
    "$.structure.overviews",
  );
  structure.overviews.forEach((overview, index) => {
    const path = `$.structure.overviews[${index}]`;
    if (!groups.has(overview.groupId)) inputFail("invalid-projection", `${path}.groupId`);
    const node = requireNode(overview.nodeId, nodes, `${path}.nodeId`);
    if (node.kind !== "document") inputFail("invalid-projection", `${path}.nodeId`);
    validateEvidence(overview.evidence, nodes, `${path}.evidence`);
  });

  uniqueIds(
    structure.throughlines.map((item) => item.groupId),
    "$.structure.throughlines",
  );
  structure.throughlines.forEach((throughline, index) => {
    const path = `$.structure.throughlines[${index}]`;
    if (!groups.has(throughline.groupId)) inputFail("invalid-projection", `${path}.groupId`);
    if (!entities.has(throughline.entityId)) inputFail("invalid-projection", `${path}.entityId`);
    validateEvidence(throughline.evidence, nodes, `${path}.evidence`);
  });

  uniqueIds(
    structure.pageClassifications.map((item) => item.nodeId),
    "$.structure.pageClassifications",
  );
  structure.pageClassifications.forEach((classification, index) => {
    const path = `$.structure.pageClassifications[${index}]`;
    requireNode(classification.nodeId, nodes, `${path}.nodeId`);
    if (
      !structure.topicNodeIds.includes(classification.nodeId) ||
      !IA_PAGE_PURPOSES.includes(classification.purpose) ||
      !IA_SIBLING_NODE_KINDS.includes(classification.siblingKind)
    ) {
      inputFail("invalid-projection", path);
    }
    validateEvidence(classification.evidence, nodes, `${path}.evidence`);
  });

  uniqueIds(
    structure.exceptions.map((item) => `${item.rule}:${item.nodeId}`),
    "$.structure.exceptions",
  );
  structure.exceptions.forEach((exception, index) => {
    const path = `$.structure.exceptions[${index}]`;
    if (
      exception.rule !== "unsupported-catch-all" ||
      !groups.has(exception.nodeId) ||
      !IA_EXCEPTION_REASONS.includes(exception.reason)
    ) {
      inputFail("invalid-projection", path);
    }
    validateEvidence(exception.evidence, nodes, `${path}.evidence`);
  });
}

function axisDiagnostics(state: EvaluationState): IaDiagnostic[] {
  const diagnostics: IaDiagnostic[] = [];
  const assignedGroups = new Set<string>();
  for (const set of state.input.structure.siblingSets) {
    set.groupIds.forEach((id) => assignedGroups.add(id));
    const axes = new Set(set.groupIds.map((id) => state.groups.get(id)!.axis));
    if (axes.size !== 1 || !axes.has(set.declaredAxis)) {
      diagnostics.push(
        diagnostic("one-axis-per-sibling-set", set.id, set.groupIds, set.evidence, {
          action: "declare-one-sibling-axis",
          targetNodeIds: set.groupIds,
        }),
      );
    }
  }
  for (const group of state.candidate.groups) {
    if (!assignedGroups.has(group.id)) {
      diagnostics.push(
        diagnostic("missing-sibling-set", group.id, [], group.evidence, {
          action: "declare-sibling-set",
          targetNodeIds: [group.id],
        }),
      );
    }
    if (
      group.axis !== state.candidate.primaryAxis &&
      !state.candidate.secondaryAxes.includes(group.axis)
    ) {
      diagnostics.push(
        diagnostic("undeclared-axis-shift", group.id, [], group.evidence, {
          action: "declare-secondary-axis",
          targetNodeIds: [group.id],
        }),
      );
    }
  }
  return diagnostics;
}

function groupShapeDiagnostics(state: EvaluationState): IaDiagnostic[] {
  const diagnostics: IaDiagnostic[] = [];
  for (const group of state.candidate.groups) {
    if (group.members.length > state.input.policy.maxFanOut) {
      diagnostics.push(
        diagnostic("excessive-fan-out", group.id, group.members, group.evidence, {
          action: "split-group",
          targetNodeIds: group.members,
        }),
      );
    }
    if (group.members.length === 1) {
      diagnostics.push(
        diagnostic("single-child-group", group.id, group.members, group.evidence, {
          action: "collapse-single-child-group",
          targetNodeIds: [group.id, ...group.members],
        }),
      );
    }
    const classified = group.members
      .map((member) => state.classifications.get(member))
      .filter((item): item is IaPageClassification => Boolean(item));
    const kinds = new Set(classified.map((item) => item.siblingKind));
    if (kinds.size > 1) {
      diagnostics.push(
        diagnostic(
          "mixed-node-kinds",
          group.id,
          group.members,
          classified.flatMap((item) => item.evidence),
          { action: "separate-node-kinds", targetNodeIds: group.members },
        ),
      );
    }
  }
  return diagnostics;
}

function assignmentDiagnostics(state: EvaluationState): IaDiagnostic[] {
  const diagnostics: IaDiagnostic[] = [];
  for (const topicId of state.input.structure.topicNodeIds) {
    const parents = state.candidate.groups
      .filter((group) => group.members.includes(topicId))
      .map((group) => group.id)
      .sort(compareStrings);
    if (parents.length === 0) {
      diagnostics.push(
        diagnostic("orphan-topic", topicId, [], evidenceForNode(state, topicId), {
          action: "assign-topic",
          targetNodeIds: [topicId],
        }),
      );
    } else if (parents.length > 1) {
      diagnostics.push(
        diagnostic("multiple-parents", topicId, parents, evidenceForNode(state, topicId), {
          action: "choose-canonical-parent",
          targetNodeIds: [topicId, ...parents],
        }),
      );
    }
  }
  return diagnostics;
}

function overviewDiagnostics(state: EvaluationState): IaDiagnostic[] {
  const byGroup = new Map(
    state.input.structure.overviews.map((overview) => [overview.groupId, overview]),
  );
  return state.candidate.groups.flatMap((group) => {
    const overview = byGroup.get(group.id);
    const node = overview ? state.nodes.get(overview.nodeId) : undefined;
    if (node?.kind === "document" && node.byteLength >= state.input.policy.minOverviewBytes) {
      return [];
    }
    return [
      diagnostic(
        "empty-overview",
        group.id,
        overview ? [overview.nodeId] : [],
        overview ? [...group.evidence, ...overview.evidence] : group.evidence,
        { action: "add-overview", targetNodeIds: overview ? [overview.nodeId] : [group.id] },
      ),
    ];
  });
}

function labelDiagnostics(state: EvaluationState): IaDiagnostic[] {
  const unsupported = new Set(state.input.policy.unsupportedLabels.map(normalizeLabel));
  const exceptions = new Set(
    state.input.structure.exceptions.map((item) => `${item.rule}:${item.nodeId}`),
  );
  return state.candidate.groups.flatMap((group) => {
    if (
      !unsupported.has(normalizeLabel(group.label)) ||
      exceptions.has(`unsupported-catch-all:${group.id}`)
    )
      return [];
    return [
      diagnostic("unsupported-catch-all", group.id, [], group.evidence, {
        action: "rename-group-or-add-exception",
        targetNodeIds: [group.id],
      }),
    ];
  });
}

function balanceDiagnostics(state: EvaluationState): IaDiagnostic[] {
  return state.input.structure.siblingSets.flatMap((set) => {
    if (set.groupIds.length < 2) return [];
    const sizes = set.groupIds.map((id) => state.groups.get(id)!.members.length);
    const minimum = Math.min(...sizes);
    const maximum = Math.max(...sizes);
    if (minimum > 0 && maximum / minimum <= state.input.policy.severeImbalanceRatio) return [];
    return [
      diagnostic("severe-imbalance", set.id, set.groupIds, set.evidence, {
        action: "rebalance-groups",
        targetNodeIds: set.groupIds,
      }),
    ];
  });
}

function pagePurposeDiagnostics(state: EvaluationState): IaDiagnostic[] {
  const diagnostics: IaDiagnostic[] = [];
  for (const topicId of state.input.structure.topicNodeIds) {
    const classification = state.classifications.get(topicId);
    if (!classification) {
      diagnostics.push(
        diagnostic("missing-page-classification", topicId, [], evidenceForNode(state, topicId), {
          action: "classify-page",
          targetNodeIds: [topicId],
        }),
      );
    } else if (classification.purpose === "mixed-purpose") {
      diagnostics.push(
        diagnostic("mixed-purpose-page", topicId, [], classification.evidence, {
          action: "split-mixed-purpose-page",
          targetNodeIds: [topicId],
        }),
      );
    }
    // An explicit reference-catalog classification is a negative control: its
    // length or member count is not evidence of mixed purpose.
  }
  return diagnostics;
}

function evidenceDiagnostics(state: EvaluationState): IaDiagnostic[] {
  const diagnostics: IaDiagnostic[] = [];
  const throughlines = new Map(
    state.input.structure.throughlines.map((throughline) => [throughline.groupId, throughline]),
  );
  for (const group of state.candidate.groups) {
    if (!group.evidence.some((item) => group.members.includes(item.nodeId))) {
      diagnostics.push(
        diagnostic(
          "missing-top-level-evidence",
          group.id,
          group.members,
          state.candidate.evidence,
          { action: "add-repository-evidence", targetNodeIds: [group.id, ...group.members] },
        ),
      );
    }
    const throughline = throughlines.get(group.id);
    const entity = throughline ? state.entities.get(throughline.entityId) : undefined;
    const supported = Boolean(
      throughline &&
        entity &&
        throughline.evidence.some((item) => group.members.includes(item.nodeId)) &&
        entity.evidence.some((item) => group.members.includes(item.nodeId)),
    );
    if (!supported) {
      diagnostics.push(
        diagnostic(
          "missing-throughline",
          group.id,
          group.members,
          throughline ? throughline.evidence : group.evidence,
          { action: "state-ontology-throughline", targetNodeIds: [group.id] },
        ),
      );
    }
  }
  return diagnostics;
}

function diagnostic(
  rule: IaDiagnosticRule,
  nodeId: string,
  relatedNodeIds: readonly string[],
  evidence: readonly ArtifactEvidence[],
  recovery: IaDiagnosticRecovery,
): IaDiagnostic {
  return {
    rule,
    // A one-item reader-job entry is redundant but does not make an otherwise
    // evidenced topology unsafe to plan. Keep it visible for cleanup without
    // making the corpus' legitimate singleton entry points impossible.
    severity: rule === "single-child-group" ? "advisory" : "blocking",
    nodeId,
    relatedNodeIds: [...new Set(relatedNodeIds)].sort(compareStrings),
    evidence: normalizeEvidence(evidence),
    recovery: {
      action: recovery.action,
      targetNodeIds: [...new Set(recovery.targetNodeIds)].sort(compareStrings),
    },
  };
}

function evidenceForNode(state: EvaluationState, nodeId: string): ArtifactEvidence[] {
  const node = state.nodes.get(nodeId)!;
  const artifactEvidence = [
    ...state.input.ontology.payload.entities.flatMap((entity) => entity.evidence),
    ...state.input.semantics.flatMap((semantic) => semantic.payload.evidence),
    ...state.candidate.groups.flatMap((group) => group.evidence),
  ].filter((item) => item.nodeId === nodeId);
  return normalizeEvidence(
    artifactEvidence.length > 0 ? artifactEvidence : [{ path: node.sourcePath, nodeId }],
  );
}

function normalizeDiagnostics(diagnostics: readonly IaDiagnostic[]): IaDiagnostic[] {
  const ruleOrder = new Map(IA_DIAGNOSTIC_RULES.map((rule, index) => [rule, index]));
  return diagnostics
    .map((item) => ({
      ...item,
      relatedNodeIds: [...item.relatedNodeIds].sort(compareStrings),
      evidence: normalizeEvidence(item.evidence),
      recovery: {
        ...item.recovery,
        targetNodeIds: [...item.recovery.targetNodeIds].sort(compareStrings),
      },
    }))
    .sort(
      (left, right) =>
        ruleOrder.get(left.rule)! - ruleOrder.get(right.rule)! ||
        compareStrings(left.nodeId, right.nodeId),
    );
}

function normalizeEvidence(evidence: readonly ArtifactEvidence[]): ArtifactEvidence[] {
  const unique = new Map(evidence.map((item) => [`${item.path}\0${item.nodeId}`, item]));
  return [...unique.values()]
    .map((item) => ({ path: item.path, nodeId: item.nodeId }))
    .sort(
      (left, right) =>
        compareStrings(left.path, right.path) || compareStrings(left.nodeId, right.nodeId),
    );
}

function validateEvidence(
  evidence: readonly ArtifactEvidence[],
  nodes: ReadonlyMap<string, ContentNode>,
  path: string,
): void {
  if (!Array.isArray(evidence) || evidence.length === 0) inputFail("invalid-projection", path);
  const keys = new Set<string>();
  evidence.forEach((item, index) => {
    const node = requireNode(item.nodeId, nodes, `${path}[${index}].nodeId`);
    if (item.path !== node.sourcePath) inputFail("invalid-projection", `${path}[${index}].path`);
    const key = `${item.path}\0${item.nodeId}`;
    if (keys.has(key)) inputFail("invalid-projection", path);
    keys.add(key);
  });
}

function uniqueIds(ids: readonly string[], path: string): void {
  if (!Array.isArray(ids) || ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
    inputFail("invalid-projection", path);
  }
}

function requireNode(
  id: string,
  nodes: ReadonlyMap<string, ContentNode>,
  path: string,
): ContentNode {
  if (!validId(id)) inputFail("invalid-projection", path);
  const node = nodes.get(id);
  if (!node) inputFail("invalid-projection", path);
  return node;
}

function inputFail(code: IaDiagnosticsInputError["code"], path: string): never {
  throw new IaDiagnosticsInputError(code, path);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value === value.normalize("NFC") && IDENTIFIER.test(value);
}

function normalizeLabel(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function sameRepository(
  left: { revision: string; contentDigest: string },
  right: { revision: string; contentDigest: string },
): boolean {
  return left.revision === right.revision && left.contentDigest === right.contentDigest;
}

function clonePolicy(policy: IaDiagnosticPolicy): IaDiagnosticPolicy {
  return { ...policy, unsupportedLabels: [...policy.unsupportedLabels] };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
