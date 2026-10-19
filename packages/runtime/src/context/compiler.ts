// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateArtifact } from "../artifacts/index.js";
import {
  CONTENT_TYPES,
  ORGANIZING_AXES,
  type ArtifactEnvelope,
  type ArtifactReference,
} from "../artifacts/contracts.js";
import type {
  ContentIndex,
  ContentIndexV1,
  ContentNode,
  StructuralEdge,
  StructuralEdgeV2,
  StructuralEdgeKind,
} from "../content-ir/contracts.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { ContentIndexDecodeError, decodeContentIndex } from "../content-ir/decoder.js";
import {
  CONTEXT_RESULT_STATUSES,
  type ContextBudget,
  type ContextCompileInput,
  type ContextEdgeSummary,
  type ContextNodeSummary,
  type ContextPacketV1,
  type ContextPathSummary,
  type ContextProvenance,
  type ContextQuery,
  type ContextReason,
  type ContextResult,
  type PlacementAssessment,
} from "./contracts.js";
import { ContextQueryError, validateContextQuery } from "./queries.js";
import {
  canonicalContextPacketDigest,
  canonicalContextPacketJson,
  estimatedTokensFor,
  fitPacketCut,
  fittedPacket,
  PacketSizer,
  type PacketCut,
  type PacketParts,
} from "./compiler/packet-fit.js";
import {
  artifactReference,
  edgeKey,
  referenceKey,
  semanticSummary,
  uniqueSorted,
} from "./compiler/projections.js";
export { canonicalContextPacketDigest, canonicalContextPacketJson } from "./compiler/packet-fit.js";

const STRUCTURAL_EDGE_KINDS = new Set([
  "parent",
  "child",
  "previous-sibling",
  "next-sibling",
  "outbound-link",
  "backlink",
  "navigation",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const RESULT_REASONS = new Set([
  "page-role-unresolved",
  "target-unresolved",
  "candidate-parent-unresolved",
  "location-unresolved",
  "canonical-home-unresolved",
  "placement-undetermined",
  "node-budget-exceeded",
  "edge-budget-exceeded",
  "path-budget-exceeded",
  "depth-budget-exceeded",
  "byte-budget-exceeded",
  "token-budget-exceeded",
  "latency-budget-exceeded",
  "repository-mismatch",
  "invalid-input",
  "context-unnecessary",
]);

export class ContextResultValidationError extends Error {
  public readonly code = "invalid-context-result" as const;

  public constructor(public readonly path: string) {
    super(`invalid context result at ${path}`);
    this.name = "ContextResultValidationError";
  }
}

export class ContextIndexValidationError extends Error {
  public readonly code = "invalid-context-index" as const;

  public constructor(public readonly path: string) {
    super(`invalid content index at ${path}`);
    this.name = "ContextIndexValidationError";
  }
}

type JsonObject = Record<string, unknown>;

function validationFail(path: string): never {
  throw new ContextResultValidationError(path);
}

function assertJson(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) validationFail(path);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) validationFail(path);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) validationFail(path);
      value.forEach((item, index) => assertJson(item, `${path}[${index}]`, seen));
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) validationFail(path);
    for (const [key, child] of Object.entries(value as JsonObject)) {
      assertJson(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function exactObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) validationFail(path);
  const object = value as JsonObject;
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) validationFail(`${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) validationFail(`${path}.${key}`);
  }
  return object;
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) validationFail(path);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) validationFail(path);
  const result = value.map((item, index) => nonemptyString(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) validationFail(path);
  return result;
}

/** Ordered labels; nested heading walks legitimately repeat `child`. */
function stringSequence(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) validationFail(path);
  return value.map((item, index) => nonemptyString(item, `${path}[${index}]`));
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    validationFail(path);
  }
  return value;
}

function validateReferenceShape(value: unknown, path: string): ArtifactReference {
  const reference = exactObject(value, path, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  if (typeof reference.kind !== "string" || reference.schemaVersion !== 1) validationFail(path);
  if (!SHA256.test(nonemptyString(reference.digest, `${path}.digest`)))
    validationFail(`${path}.digest`);
  nonemptyString(reference.repositoryRevision, `${path}.repositoryRevision`);
  if (
    !SHA256.test(
      nonemptyString(reference.repositoryContentDigest, `${path}.repositoryContentDigest`),
    )
  )
    validationFail(`${path}.repositoryContentDigest`);
  return reference as unknown as ArtifactReference;
}

function validateBudgetShape(value: unknown, path: string): ContextBudget {
  const budget = exactObject(value, path, [
    "class",
    "maxNodes",
    "maxEdges",
    "maxPaths",
    "maxDepth",
    "maxBytes",
    "maxEstimatedTokens",
    "maxDurationMs",
  ]);
  if (budget.class !== "local" && budget.class !== "corpus") validationFail(`${path}.class`);
  for (const field of [
    "maxNodes",
    "maxEdges",
    "maxPaths",
    "maxDepth",
    "maxBytes",
    "maxEstimatedTokens",
    "maxDurationMs",
  ])
    nonnegativeInteger(budget[field], `${path}.${field}`);
  return budget as unknown as ContextBudget;
}

function validateProvenanceShape(value: unknown, path: string): ContextProvenance {
  const provenance = exactObject(
    value,
    path,
    [
      "repository",
      "indexDigest",
      "ontology",
      "semanticPackets",
      "activePlan",
      "consultedNodeIds",
      "activeDecisionIds",
      "policy",
      "budget",
    ],
    [
      "repository",
      "indexDigest",
      "ontology",
      "semanticPackets",
      "consultedNodeIds",
      "activeDecisionIds",
      "policy",
      "budget",
    ],
  );
  const repository = exactObject(provenance.repository, `${path}.repository`, [
    "revision",
    "contentDigest",
  ]);
  nonemptyString(repository.revision, `${path}.repository.revision`);
  if (!SHA256.test(nonemptyString(repository.contentDigest, `${path}.repository.contentDigest`))) {
    validationFail(`${path}.repository.contentDigest`);
  }
  if (!SHA256.test(nonemptyString(provenance.indexDigest, `${path}.indexDigest`))) {
    validationFail(`${path}.indexDigest`);
  }
  const ontology = validateReferenceShape(provenance.ontology, `${path}.ontology`);
  if (ontology.kind !== "ontology") validationFail(`${path}.ontology.kind`);
  if (!Array.isArray(provenance.semanticPackets)) validationFail(`${path}.semanticPackets`);
  provenance.semanticPackets.forEach((reference, index) => {
    if (
      validateReferenceShape(reference, `${path}.semanticPackets[${index}]`).kind !==
      "context-packet"
    ) {
      validationFail(`${path}.semanticPackets[${index}].kind`);
    }
  });
  if (
    provenance.activePlan !== undefined &&
    validateReferenceShape(provenance.activePlan, `${path}.activePlan`).kind !== "ia-plan"
  ) {
    validationFail(`${path}.activePlan.kind`);
  }
  stringArray(provenance.consultedNodeIds, `${path}.consultedNodeIds`);
  stringArray(provenance.activeDecisionIds, `${path}.activeDecisionIds`);
  const policy = exactObject(provenance.policy, `${path}.policy`, [
    "id",
    "version",
    "digest",
    "allowDegradedRead",
  ]);
  nonemptyString(policy.id, `${path}.policy.id`);
  nonemptyString(policy.version, `${path}.policy.version`);
  if (!SHA256.test(nonemptyString(policy.digest, `${path}.policy.digest`))) {
    validationFail(`${path}.policy.digest`);
  }
  if (typeof policy.allowDegradedRead !== "boolean") {
    validationFail(`${path}.policy.allowDegradedRead`);
  }
  validateBudgetShape(provenance.budget, `${path}.budget`);
  return provenance as unknown as ContextProvenance;
}

function validateNodeShape(value: unknown, path: string): void {
  const discriminator = exactObject(
    value,
    path,
    [
      "id",
      "kind",
      "sourcePath",
      "format",
      "byteLength",
      "anchors",
      "documentId",
      "anchor",
      "depth",
      "startLine",
      "endLine",
    ],
    ["id", "kind", "sourcePath"],
  );
  nonemptyString(discriminator.id, `${path}.id`);
  nonemptyString(discriminator.sourcePath, `${path}.sourcePath`);
  if (discriminator.kind === "document") {
    exactObject(value, path, ["id", "kind", "sourcePath", "format", "byteLength", "anchors"]);
    if (!["markdown", "gfm", "myst", "mdx"].includes(discriminator.format as string)) {
      validationFail(`${path}.format`);
    }
    nonnegativeInteger(discriminator.byteLength, `${path}.byteLength`);
    stringArray(discriminator.anchors, `${path}.anchors`);
  } else if (discriminator.kind === "section") {
    exactObject(value, path, [
      "id",
      "kind",
      "documentId",
      "sourcePath",
      "anchor",
      "depth",
      "startLine",
      "endLine",
    ]);
    nonemptyString(discriminator.documentId, `${path}.documentId`);
    nonemptyString(discriminator.anchor, `${path}.anchor`);
    for (const field of ["depth", "startLine", "endLine"]) {
      nonnegativeInteger(discriminator[field], `${path}.${field}`);
    }
  } else validationFail(`${path}.kind`);
}

function validateSemanticShape(value: unknown, path: string): void {
  const semantic = exactObject(
    value,
    path,
    [
      "targetNodeId",
      "pageRole",
      "belongsHere",
      "belongsElsewhere",
      "canonicalHomeNodeIds",
      "activeDecisionIds",
    ],
    [
      "targetNodeId",
      "belongsHere",
      "belongsElsewhere",
      "canonicalHomeNodeIds",
      "activeDecisionIds",
    ],
  );
  nonemptyString(semantic.targetNodeId, `${path}.targetNodeId`);
  for (const field of [
    "belongsHere",
    "belongsElsewhere",
    "canonicalHomeNodeIds",
    "activeDecisionIds",
  ])
    stringArray(semantic[field], `${path}.${field}`);
  if (semantic.pageRole !== undefined) {
    const role = exactObject(
      semantic.pageRole,
      `${path}.pageRole`,
      ["contentType", "readerJob", "canonicalParentId", "organizingAxis"],
      ["contentType", "readerJob", "organizingAxis"],
    );
    if (
      !CONTENT_TYPES.includes(
        nonemptyString(
          role.contentType,
          `${path}.pageRole.contentType`,
        ) as (typeof CONTENT_TYPES)[number],
      )
    )
      validationFail(`${path}.pageRole.contentType`);
    nonemptyString(role.readerJob, `${path}.pageRole.readerJob`);
    if (
      !ORGANIZING_AXES.includes(
        nonemptyString(
          role.organizingAxis,
          `${path}.pageRole.organizingAxis`,
        ) as (typeof ORGANIZING_AXES)[number],
      )
    )
      validationFail(`${path}.pageRole.organizingAxis`);
    if (role.canonicalParentId !== undefined) {
      nonemptyString(role.canonicalParentId, `${path}.pageRole.canonicalParentId`);
    }
  }
}

/**
 * Validates the closed shape and input bindings of a freshly produced compiler
 * result without running the compiler a second time.
 */
export function validateCompilerResult(value: unknown, input?: ContextCompileInput): ContextResult {
  assertJson(value);
  const resultValue = exactObject(
    value,
    "$",
    ["status", "reasons", "provenance", "packet"],
    ["status", "reasons", "provenance"],
  );
  if (!CONTEXT_RESULT_STATUSES.includes(resultValue.status as ContextResult["status"])) {
    validationFail("$.status");
  }
  if (!Array.isArray(resultValue.reasons)) validationFail("$.reasons");
  resultValue.reasons.forEach((reason, index) => {
    const item = exactObject(reason, `$.reasons[${index}]`, ["code", "detail"], ["code"]);
    if (typeof item.code !== "string" || !RESULT_REASONS.has(item.code)) {
      validationFail(`$.reasons[${index}].code`);
    }
    if (item.detail !== undefined) nonemptyString(item.detail, `$.reasons[${index}].detail`);
  });
  const provenance = validateProvenanceShape(resultValue.provenance, "$.provenance");
  const hasPacket = resultValue.packet !== undefined;
  if ((resultValue.status === "ready" || resultValue.status === "degraded") !== hasPacket) {
    validationFail("$.packet");
  }
  if (resultValue.status === "ready" && resultValue.reasons.length !== 0)
    validationFail("$.reasons");
  if (resultValue.status !== "ready" && resultValue.reasons.length === 0)
    validationFail("$.reasons");

  if (hasPacket) {
    const packetValue = exactObject(
      resultValue.packet,
      "$.packet",
      [
        "schemaVersion",
        "query",
        "nodes",
        "edges",
        "paths",
        "semantics",
        "placementAssessment",
        "provenance",
        "estimates",
        "digest",
      ],
      [
        "schemaVersion",
        "query",
        "nodes",
        "edges",
        "paths",
        "semantics",
        "provenance",
        "estimates",
        "digest",
      ],
    );
    if (packetValue.schemaVersion !== 1) validationFail("$.packet.schemaVersion");
    const query = validateContextQuery(packetValue.query);
    if (canonicalJson(query) !== canonicalJson(packetValue.query)) validationFail("$.packet.query");
    for (const field of ["nodes", "edges", "paths", "semantics"]) {
      if (!Array.isArray(packetValue[field])) validationFail(`$.packet.${field}`);
    }
    (packetValue.nodes as unknown[]).forEach((node, index) =>
      validateNodeShape(node, `$.packet.nodes[${index}]`),
    );
    (packetValue.edges as unknown[]).forEach((edge, index) => {
      const item = exactObject(edge, `$.packet.edges[${index}]`, ["kind", "from", "to"]);
      if (!STRUCTURAL_EDGE_KINDS.has(nonemptyString(item.kind, `$.packet.edges[${index}].kind`)))
        validationFail(`$.packet.edges[${index}].kind`);
      nonemptyString(item.from, `$.packet.edges[${index}].from`);
      nonemptyString(item.to, `$.packet.edges[${index}].to`);
    });
    (packetValue.paths as unknown[]).forEach((path, index) => {
      const item = exactObject(path, `$.packet.paths[${index}]`, ["nodeIds", "edgeKinds"]);
      const nodes = stringArray(item.nodeIds, `$.packet.paths[${index}].nodeIds`);
      const edges = stringSequence(item.edgeKinds, `$.packet.paths[${index}].edgeKinds`);
      if (edges.length !== Math.max(0, nodes.length - 1))
        validationFail(`$.packet.paths[${index}]`);
      edges.forEach((kind, edgeIndex) => {
        if (!STRUCTURAL_EDGE_KINDS.has(kind)) {
          validationFail(`$.packet.paths[${index}].edgeKinds[${edgeIndex}]`);
        }
      });
    });
    // Edges and paths join only nodes the packet carries, so a trim that keeps
    // one past its kept nodes is malformed, whoever produced it.
    const packetNodeIds = new Set(
      (packetValue.nodes as Array<{ id: string }>).map((node) => node.id),
    );
    (packetValue.edges as Array<{ from: string; to: string }>).forEach((edge, index) => {
      if (!packetNodeIds.has(edge.from) || !packetNodeIds.has(edge.to)) {
        validationFail(`$.packet.edges[${index}]`);
      }
    });
    (packetValue.paths as Array<{ nodeIds: string[] }>).forEach((path, index) => {
      path.nodeIds.forEach((nodeId, nodeIndex) => {
        if (!packetNodeIds.has(nodeId))
          validationFail(`$.packet.paths[${index}].nodeIds[${nodeIndex}]`);
      });
    });
    (packetValue.semantics as unknown[]).forEach((semantic, index) =>
      validateSemanticShape(semantic, `$.packet.semantics[${index}]`),
    );
    if (packetValue.placementAssessment !== undefined) {
      const placement = exactObject(
        packetValue.placementAssessment,
        "$.packet.placementAssessment",
        ["targetNodeId", "candidateParentId", "disposition"],
      );
      nonemptyString(placement.targetNodeId, "$.packet.placementAssessment.targetNodeId");
      nonemptyString(placement.candidateParentId, "$.packet.placementAssessment.candidateParentId");
      if (
        !["belongs-here", "belongs-elsewhere", "canonical-home", "undetermined"].includes(
          placement.disposition as string,
        )
      )
        validationFail("$.packet.placementAssessment.disposition");
    }
    const packetProvenance = validateProvenanceShape(packetValue.provenance, "$.packet.provenance");
    if (canonicalJson(packetProvenance) !== canonicalJson(provenance)) {
      validationFail("$.packet.provenance");
    }
    const estimates = exactObject(packetValue.estimates, "$.packet.estimates", [
      "byteLength",
      "estimatedTokens",
    ]);
    nonnegativeInteger(estimates.byteLength, "$.packet.estimates.byteLength");
    nonnegativeInteger(estimates.estimatedTokens, "$.packet.estimates.estimatedTokens");
    if (!SHA256.test(nonemptyString(packetValue.digest, "$.packet.digest"))) {
      validationFail("$.packet.digest");
    }
    const packet = packetValue as unknown as ContextPacketV1;
    if (packet.digest !== canonicalContextPacketDigest(packet)) validationFail("$.packet.digest");
    const byteLength = Buffer.byteLength(canonicalContextPacketJson(packet));
    if (
      packet.estimates.byteLength !== byteLength ||
      packet.estimates.estimatedTokens !== estimatedTokensFor(byteLength)
    ) {
      validationFail("$.packet.estimates");
    }
  }

  if (input) {
    if (
      !sameRepository(provenance.repository, input.index.repository) ||
      provenance.indexDigest !== input.index.indexDigest ||
      canonicalJson(provenance.ontology) !== canonicalJson(artifactReference(input.ontology)) ||
      canonicalJson(provenance.policy) !== canonicalJson(input.policy) ||
      canonicalJson(provenance.budget) !== canonicalJson(input.budget) ||
      canonicalJson(provenance.activePlan) !== canonicalJson(input.activePlan)
    ) {
      validationFail("$.provenance");
    }
    const allowedSemantics = new Set(
      input.semantics.map((semantic) => referenceKey(artifactReference(semantic))),
    );
    if (
      provenance.semanticPackets.some((reference) => !allowedSemantics.has(referenceKey(reference)))
    ) {
      validationFail("$.provenance.semanticPackets");
    }
    if (hasPacket) {
      const packet = resultValue.packet as unknown as ContextPacketV1;
      const requestedQuery = validateContextQuery(input.query);
      if (requestedQuery.kind === "expand" && packet.query.kind === "expand") {
        const requestedTargets = new Set(requestedQuery.targetNodeIds);
        if (
          packet.query.targetNodeIds.length === 0 ||
          packet.query.depth !== requestedQuery.depth ||
          packet.query.targetNodeIds.some((nodeId) => !requestedTargets.has(nodeId))
        )
          validationFail("$.packet.query");
      } else if (canonicalJson(packet.query) !== canonicalJson(requestedQuery)) {
        validationFail("$.packet.query");
      }
      const indexNodes = new Map(input.index.nodes.map((node) => [node.id, node]));
      for (const [index, node] of packet.nodes.entries()) {
        const source = indexNodes.get(node.id);
        if (!source || canonicalJson(node) !== canonicalJson(nodeSummary(source))) {
          validationFail(`$.packet.nodes[${index}]`);
        }
      }
      const indexEdges = new Set(input.index.edges.map(edgeKey));
      for (const [index, edge] of packet.edges.entries()) {
        if (!indexEdges.has(edgeKey(edge))) validationFail(`$.packet.edges[${index}]`);
      }
      const retainedNodeIds = new Set(packet.nodes.map((node) => node.id));
      for (const [pathIndex, path] of packet.paths.entries()) {
        for (const [nodeIndex, nodeId] of path.nodeIds.entries()) {
          if (!retainedNodeIds.has(nodeId)) {
            validationFail(`$.packet.paths[${pathIndex}].nodeIds[${nodeIndex}]`);
          }
        }
        for (let edgeIndex = 0; edgeIndex < path.edgeKinds.length; edgeIndex += 1) {
          const kind = path.edgeKinds[edgeIndex]!;
          const from = path.nodeIds[edgeIndex]!;
          const to = path.nodeIds[edgeIndex + 1]!;
          if (
            !indexEdges.has(edgeKey({ kind, from, to })) &&
            !indexEdges.has(edgeKey({ kind, from: to, to: from }))
          )
            validationFail(`$.packet.paths[${pathIndex}].edgeKinds[${edgeIndex}]`);
        }
      }
      const semanticInputs = new Map(
        input.semantics.map((semantic) => [semantic.payload.targetNodeId, semantic]),
      );
      for (const [index, semantic] of packet.semantics.entries()) {
        const source = semanticInputs.get(semantic.targetNodeId);
        if (!source || canonicalJson(semantic) !== canonicalJson(semanticSummary(source.payload))) {
          validationFail(`$.packet.semantics[${index}]`);
        }
        if (!retainedNodeIds.has(semantic.targetNodeId)) {
          validationFail(`$.packet.semantics[${index}].targetNodeId`);
        }
      }
      const expectedConsultedNodeIds = uniqueSorted(packet.nodes.map((node) => node.id));
      if (canonicalJson(provenance.consultedNodeIds) !== canonicalJson(expectedConsultedNodeIds)) {
        validationFail("$.provenance.consultedNodeIds");
      }
      const expectedDecisionIds = uniqueSorted(
        packet.semantics.flatMap((semantic) => semantic.activeDecisionIds),
      );
      if (canonicalJson(provenance.activeDecisionIds) !== canonicalJson(expectedDecisionIds)) {
        validationFail("$.provenance.activeDecisionIds");
      }
      const expectedSemanticPackets = packet.semantics
        .map((semantic) => semanticInputs.get(semantic.targetNodeId))
        .filter((semantic): semantic is ArtifactEnvelope<"context-packet"> => Boolean(semantic))
        .map(artifactReference)
        .sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)));
      if (canonicalJson(provenance.semanticPackets) !== canonicalJson(expectedSemanticPackets)) {
        validationFail("$.provenance.semanticPackets");
      }
      if (packet.query.kind === "test-placement") {
        const source = semanticInputs.get(packet.query.targetNodeId);
        if (!source || !packet.placementAssessment) {
          validationFail("$.packet.placementAssessment");
        }
        const summary = semanticSummary(source.payload);
        const expectedDisposition = summary.canonicalHomeNodeIds.includes(
          packet.query.candidateParentId,
        )
          ? "canonical-home"
          : summary.belongsHere.includes(packet.query.candidateParentId)
            ? "belongs-here"
            : summary.belongsElsewhere.includes(packet.query.candidateParentId)
              ? "belongs-elsewhere"
              : "undetermined";
        if (
          packet.placementAssessment.targetNodeId !== packet.query.targetNodeId ||
          packet.placementAssessment.candidateParentId !== packet.query.candidateParentId ||
          packet.placementAssessment.disposition !== expectedDisposition
        )
          validationFail("$.packet.placementAssessment");
      } else if (packet.placementAssessment !== undefined) {
        validationFail("$.packet.placementAssessment");
      }
    }
  }
  return JSON.parse(canonicalJson(value)) as ContextResult;
}

/**
 * Validates untrusted cached or external evidence by reconstructing the one
 * deterministic result derivable from the bound compile input. Production
 * compiler output can use validateCompilerResult to avoid compiling twice.
 */
export function validateContextResult(value: unknown, input?: ContextCompileInput): ContextResult {
  const validated = validateCompilerResult(value, input);
  if (input) {
    const reconstructed = compileContext(input);
    if (canonicalJson(validated) !== canonicalJson(reconstructed)) {
      validationFail("$");
    }
  }
  return validated;
}

/**
 * A breadth-first walk: the sorted seeds first, then every other node by its
 * distance from them. `retentionOrder` turns this order into the ranks a
 * trim keeps.
 */
interface WalkResult {
  visitedNodeIds: string[];
  /** One path per node that kept one, in the same visit order. */
  visitedPaths: ContextPathSummary[];
  clippedNodes: boolean;
  clippedPaths: boolean;
}

interface AdjacencyEntry {
  nodeId: string;
  kind: StructuralEdgeKind;
}

function nodeSummary(node: ContentNode): ContextNodeSummary {
  return node.kind === "document"
    ? {
        id: node.id,
        kind: "document",
        sourcePath: node.sourcePath,
        format: node.format,
        byteLength: node.byteLength,
        anchors: [...node.anchors].sort(),
      }
    : {
        id: node.id,
        kind: "section",
        documentId: node.documentId,
        sourcePath: node.sourcePath,
        anchor: node.anchor,
        depth: node.depth,
        startLine: node.startLine,
        endLine: node.endLine,
      };
}

/**
 * A budget is positive whole numbers of a known class. It has no ceiling of
 * its own: workflow preflight derives it from declared, raisable limits
 * (`budget.ts`), so a larger budget is a host's choice, not an invalid input.
 */
function validBudget(value: ContextBudget): boolean {
  return (
    (value.class === "local" || value.class === "corpus") &&
    ["maxNodes", "maxEdges", "maxPaths", "maxBytes", "maxEstimatedTokens", "maxDurationMs"].every(
      (field) => {
        const candidate = value[field as keyof ContextBudget];
        return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
      },
    ) &&
    Number.isSafeInteger(value.maxDepth) &&
    value.maxDepth >= 0
  );
}

function validPolicy(input: ContextCompileInput): boolean {
  const { policy } = input;
  return (
    Boolean(policy.id.trim()) &&
    Boolean(policy.version.trim()) &&
    SHA256.test(policy.digest) &&
    typeof policy.allowDegradedRead === "boolean"
  );
}

function sameRepository(
  left: { revision: string; contentDigest: string },
  right: { revision: string; contentDigest: string },
): boolean {
  return left.revision === right.revision && left.contentDigest === right.contentDigest;
}

function validArtifact(artifact: ArtifactEnvelope, index: ContentIndex): boolean {
  try {
    validateArtifact(artifact, { index: index as ContentIndexV1 });
    return true;
  } catch {
    return false;
  }
}

function makeAdjacency(
  edges: readonly StructuralEdgeV2[],
  indexedNodeIds: ReadonlySet<string>,
): ReadonlyMap<string, AdjacencyEntry[]> {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  for (const edge of [...edges].sort((left, right) =>
    edgeKey(left).localeCompare(edgeKey(right)),
  )) {
    // Content IR preserves external links as opaque `external:*` edge targets
    // without promoting them to content nodes. Context packets summarize only
    // indexed repository content, so those boundary edges are not traversable.
    if (
      edge.kind === "asset-link" ||
      !indexedNodeIds.has(edge.from) ||
      !indexedNodeIds.has(edge.to)
    )
      continue;
    const forward = adjacency.get(edge.from) ?? [];
    forward.push({ nodeId: edge.to, kind: edge.kind });
    adjacency.set(edge.from, forward);
    const backward = adjacency.get(edge.to) ?? [];
    backward.push({ nodeId: edge.from, kind: edge.kind });
    adjacency.set(edge.to, backward);
  }
  for (const entries of adjacency.values()) {
    entries.sort((left, right) =>
      `${left.nodeId}\0${left.kind}`.localeCompare(`${right.nodeId}\0${right.kind}`),
    );
  }
  return adjacency;
}

function walk(
  seeds: readonly string[],
  depth: number,
  adjacency: ReadonlyMap<string, AdjacencyEntry[]>,
  budget: ContextBudget,
): WalkResult {
  const sortedSeeds = uniqueSorted(seeds);
  const seen = new Set<string>();
  const queue: Array<{ nodeId: string; depth: number; path: ContextPathSummary }> = sortedSeeds.map(
    (nodeId) => ({ nodeId, depth: 0, path: { nodeIds: [nodeId], edgeKinds: [] } }),
  );
  const nodeIds: string[] = [];
  const paths: ContextPathSummary[] = [];
  let clippedNodes = false;
  let clippedPaths = false;
  // A read cursor instead of `shift()`: the same order, without re-indexing a
  // queue that holds a whole large corpus.
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    if (seen.has(current.nodeId)) continue;
    if (nodeIds.length >= budget.maxNodes) {
      clippedNodes = true;
      continue;
    }
    seen.add(current.nodeId);
    nodeIds.push(current.nodeId);
    if (paths.length < budget.maxPaths) paths.push(current.path);
    else clippedPaths = true;
    if (current.depth >= depth) continue;
    for (const next of adjacency.get(current.nodeId) ?? []) {
      if (seen.has(next.nodeId)) continue;
      queue.push({
        nodeId: next.nodeId,
        depth: current.depth + 1,
        path: {
          nodeIds: [...current.path.nodeIds, next.nodeId],
          edgeKinds: [...current.path.edgeKinds, next.kind],
        },
      });
    }
  }
  return { visitedNodeIds: nodeIds, visitedPaths: paths, clippedNodes, clippedPaths };
}

/**
 * The order a trim keeps nodes in. The requested nodes (the query's seeds)
 * come first, in the order the request named them, so a scope keeps its
 * pages in request order; every other node follows in visit order, nearer
 * the seeds before farther. A lower rank is kept longer.
 *
 * Every node on a path ranks at or before the node the path ends at: a path
 * starts at a seed and passes only through nodes visited before its end. So
 * the paths and edges among a rank prefix of nodes are themselves a prefix of
 * their own rank order.
 */
function retentionOrder(seeds: readonly string[], walked: WalkResult): string[] {
  const visited = new Set(walked.visitedNodeIds);
  const requested = [...new Set(seeds)].filter((nodeId) => visited.has(nodeId));
  const requestedSet = new Set(requested);
  return [...requested, ...walked.visitedNodeIds.filter((nodeId) => !requestedSet.has(nodeId))];
}

/**
 * An expand query's targets in the order the caller named them. Validation
 * already proved the request names the same unique targets as `seeds`.
 */
function requestedTargetOrder(requested: ContextQuery, seeds: readonly string[]): string[] {
  const named = requested.kind === "expand" ? requested.targetNodeIds : [];
  const known = new Set(seeds);
  return [...named.filter((nodeId) => known.has(nodeId)), ...seeds];
}

function targetNodeIds(query: ContextQuery, nodes: readonly ContentNode[]): string[] {
  switch (query.kind) {
    case "locate":
      return nodes
        .filter(
          (node) =>
            node.sourcePath === query.sourcePath &&
            (query.anchor === undefined ||
              (node.kind === "section" && node.anchor === query.anchor)),
        )
        .map((node) => node.id)
        .sort();
    case "expand":
      return query.targetNodeIds;
    case "get-neighborhood":
    case "find-home":
    case "test-placement":
      return [query.targetNodeId];
  }
}

function queryDepth(query: ContextQuery): number {
  switch (query.kind) {
    case "get-neighborhood":
    case "expand":
      return query.depth ?? 1;
    case "find-home":
    case "test-placement":
      return 1;
    case "locate":
      return 0;
  }
}

function initialProvenance(input: ContextCompileInput): ContextProvenance {
  return {
    repository: structuredClone(input.index.repository),
    indexDigest: input.index.indexDigest,
    ontology: artifactReference(input.ontology),
    semanticPackets: [],
    ...(input.activePlan ? { activePlan: structuredClone(input.activePlan) } : {}),
    consultedNodeIds: [],
    activeDecisionIds: [],
    policy: structuredClone(input.policy),
    budget: structuredClone(input.budget),
  };
}

function result(
  status: ContextResult["status"],
  reasons: ContextReason[],
  provenance: ContextProvenance,
  packet?: ContextPacketV1,
): ContextResult {
  return {
    status,
    reasons: [...reasons].sort((left, right) =>
      `${left.code}\0${left.detail ?? ""}`.localeCompare(`${right.code}\0${right.detail ?? ""}`),
    ),
    provenance,
    ...(packet ? { packet } : {}),
  };
}

/**
 * Compiles a deterministic, content-free context packet from validated structural
 * and semantic evidence. It never derives semantic roles from repository text.
 */
export function compileContext(input: ContextCompileInput): ContextResult {
  const candidateIndex =
    input && typeof input === "object" ? (input as { index?: unknown }).index : undefined;
  try {
    decodeContentIndex(candidateIndex);
  } catch (error) {
    throw new ContextIndexValidationError(
      error instanceof ContentIndexDecodeError ? error.path : "$",
    );
  }
  const provenance = initialProvenance(input);
  let query: ContextQuery;
  try {
    query = validateContextQuery(input.query);
  } catch (error) {
    const detail = error instanceof ContextQueryError ? error.path : undefined;
    return result("failed", [{ code: "invalid-input", ...(detail ? { detail } : {}) }], provenance);
  }
  if (!validBudget(input.budget) || !validPolicy(input)) {
    return result("failed", [{ code: "invalid-input" }], provenance);
  }
  if (
    !sameRepository(input.index.repository, input.ontology.repository) ||
    input.semantics.some(
      (semantic) => !sameRepository(input.index.repository, semantic.repository),
    ) ||
    (input.activePlan !== undefined &&
      (input.activePlan.repositoryRevision !== input.index.repository.revision ||
        input.activePlan.repositoryContentDigest !== input.index.repository.contentDigest))
  ) {
    return result("failed", [{ code: "repository-mismatch" }], provenance);
  }
  if (
    !validArtifact(input.ontology, input.index) ||
    input.semantics.some((semantic) => !validArtifact(semantic, input.index)) ||
    (input.activePlan !== undefined &&
      (input.activePlan.kind !== "ia-plan" ||
        input.activePlan.schemaVersion !== 1 ||
        !SHA256.test(input.activePlan.digest)))
  ) {
    return result("failed", [{ code: "invalid-input" }], provenance);
  }

  const nodesById = new Map(input.index.nodes.map((node) => [node.id, node]));
  const seeds = targetNodeIds(query, input.index.nodes);
  if (query.kind === "locate" && seeds.length === 0) {
    return result(
      "unnecessary",
      [{ code: "context-unnecessary" }, { code: "location-unresolved", detail: query.sourcePath }],
      provenance,
    );
  }
  const unresolved = seeds.find((nodeId) => !nodesById.has(nodeId));
  if (unresolved) {
    return result("failed", [{ code: "target-unresolved", detail: unresolved }], provenance);
  }
  if (query.kind === "test-placement" && !nodesById.has(query.candidateParentId)) {
    return result(
      "failed",
      [{ code: "candidate-parent-unresolved", detail: query.candidateParentId }],
      provenance,
    );
  }

  const sortedSemanticInputs = [...input.semantics].sort((left, right) =>
    left.digest.localeCompare(right.digest),
  );
  const semanticTargets = sortedSemanticInputs.map((semantic) => semantic.payload.targetNodeId);
  if (new Set(semanticTargets).size !== semanticTargets.length) {
    return result(
      "failed",
      [{ code: "invalid-input", detail: "duplicate-semantic-target" }],
      provenance,
    );
  }
  const semanticByTarget = new Map(
    sortedSemanticInputs.map((semantic) => [semantic.payload.targetNodeId, semantic]),
  );
  const targetSemantics = seeds
    .map((nodeId) => semanticByTarget.get(nodeId))
    .filter((semantic): semantic is ArtifactEnvelope<"context-packet"> => Boolean(semantic));
  const missingRole = seeds.find((nodeId) => !semanticByTarget.get(nodeId)?.payload.pageRole);
  if (missingRole && (query.kind === "find-home" || query.kind === "test-placement")) {
    return result("failed", [{ code: "page-role-unresolved", detail: missingRole }], provenance);
  }

  const reasons: ContextReason[] = [];
  const requestedDepth = queryDepth(query);
  const effectiveDepth = Math.min(requestedDepth, input.budget.maxDepth);
  if (requestedDepth > effectiveDepth) {
    reasons.push({ code: "depth-budget-exceeded", detail: String(input.budget.maxDepth) });
  }
  const walked = walk(
    seeds,
    effectiveDepth,
    makeAdjacency(input.index.edges, new Set(nodesById.keys())),
    input.budget,
  );
  if (walked.clippedNodes) reasons.push({ code: "node-budget-exceeded" });
  if (walked.clippedPaths) reasons.push({ code: "path-budget-exceeded" });

  // The packet records an expand query's targets sorted; the order the caller
  // named them is their retention priority, so a trim keeps the first-named.
  const ranked = retentionOrder(
    query.kind === "expand" ? requestedTargetOrder(input.query, seeds) : seeds,
    walked,
  );
  const rank = new Map(ranked.map((nodeId, position) => [nodeId, position]));
  const selected = new Set(walked.visitedNodeIds);
  const indexEdges: readonly StructuralEdgeV2[] = input.index.edges;
  // An edge ranks by its farther endpoint, so the edges among a rank prefix of
  // nodes are always a prefix of this order; a clip keeps the edges nearest
  // the targets.
  const rankedEdges = indexEdges
    .filter(
      (edge): edge is StructuralEdge =>
        edge.kind !== "asset-link" && selected.has(edge.from) && selected.has(edge.to),
    )
    .map((edge) => ({
      edge: { ...edge },
      end: Math.max(rank.get(edge.from)!, rank.get(edge.to)!),
      key: edgeKey(edge),
    }))
    .sort((left, right) => left.end - right.end || left.key.localeCompare(right.key));
  const keptEdges = rankedEdges.slice(0, input.budget.maxEdges);
  if (rankedEdges.length > keptEdges.length) reasons.push({ code: "edge-budget-exceeded" });

  const relevantSemantics = uniqueSorted([
    ...walked.visitedNodeIds.filter((nodeId) => semanticByTarget.has(nodeId)),
    ...seeds.filter((nodeId) => semanticByTarget.has(nodeId)),
  ]).map((nodeId) => semanticByTarget.get(nodeId)!);
  const semantics = relevantSemantics.map((semantic) => semanticSummary(semantic.payload));
  provenance.semanticPackets = relevantSemantics
    .map(artifactReference)
    .sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)));
  provenance.consultedNodeIds = uniqueSorted([
    ...walked.visitedNodeIds,
    ...input.ontology.payload.entities
      .flatMap((entity) => entity.evidence.map((item) => item.nodeId))
      .filter((nodeId) => selected.has(nodeId)),
    ...input.ontology.payload.relationships
      .flatMap((relationship) => relationship.evidence.map((item) => item.nodeId))
      .filter((nodeId) => selected.has(nodeId)),
  ]);
  provenance.activeDecisionIds = uniqueSorted(
    relevantSemantics.flatMap((semantic) => semantic.payload.activeDecisionIds),
  );

  let placementAssessment: PlacementAssessment | undefined;
  if (query.kind === "find-home") {
    const homes = semantics.flatMap((semantic) => semantic.canonicalHomeNodeIds);
    if (homes.length === 0) {
      return result(
        "failed",
        [{ code: "canonical-home-unresolved", detail: query.targetNodeId }],
        provenance,
      );
    }
  }
  if (query.kind === "test-placement") {
    const semantic = semantics.find((item) => item.targetNodeId === query.targetNodeId)!;
    const disposition = semantic.canonicalHomeNodeIds.includes(query.candidateParentId)
      ? "canonical-home"
      : semantic.belongsHere.includes(query.candidateParentId)
        ? "belongs-here"
        : semantic.belongsElsewhere.includes(query.candidateParentId)
          ? "belongs-elsewhere"
          : "undetermined";
    placementAssessment = {
      targetNodeId: query.targetNodeId,
      candidateParentId: query.candidateParentId,
      disposition,
    };
    if (disposition === "undetermined")
      reasons.push({
        code: "placement-undetermined",
        detail: query.candidateParentId,
      });
  }

  const rankOf = (path: ContextPathSummary): number => rank.get(path.nodeIds.at(-1)!)!;
  const rankedPaths = [...walked.visitedPaths].sort((left, right) => rankOf(left) - rankOf(right));
  const parts: PacketParts = {
    query,
    rankedNodes: ranked.map((nodeId) => nodeSummary(nodesById.get(nodeId)!)),
    rankedEdges: keptEdges.map((entry) => entry.edge),
    edgeEnds: keptEdges.map((entry) => entry.end),
    rankedPaths,
    pathEnds: rankedPaths.map(rankOf),
    semantics: relevantSemantics,
    provenance: structuredClone(provenance),
    ...(placementAssessment ? { placementAssessment } : {}),
  };
  const sizer = new PacketSizer(parts, rank);
  const whole: PacketCut = {
    nodes: parts.rankedNodes.length,
    edges: parts.rankedEdges.length,
    paths: parts.rankedPaths.length,
  };
  // A packet over its budget keeps the lowest ranks that fit: the requested
  // targets before their neighbours, nearer neighbours before farther ones.
  // Nodes are kept first, then the edges among them, then their paths, so a
  // trim spends the budget on what is nearest the targets.
  const cut = fitPacketCut(parts, sizer, input.budget, whole);
  // The budget reasons carry a measured size to the preflight's limit record:
  // the whole walk before a trim or, when not even the first-ranked node fits,
  // that smallest packet, the size a budget must reach for any packet at all.
  const measured: PacketCut = cut || whole.nodes === 0 ? whole : { nodes: 1, edges: 0, paths: 0 };
  const observedBytes = sizer.byteLength(measured);
  const observedTokens = estimatedTokensFor(observedBytes);
  if (observedBytes > input.budget.maxBytes) {
    reasons.push({ code: "byte-budget-exceeded", detail: String(observedBytes) });
  }
  if (observedTokens > input.budget.maxEstimatedTokens) {
    reasons.push({ code: "token-budget-exceeded", detail: String(observedTokens) });
  }
  const packet = cut ? fittedPacket(parts, cut, input.budget) : undefined;
  if (!packet) return result("failed", reasons, provenance);

  const degraded = reasons.length > 0;
  if (degraded && !input.policy.allowDegradedRead) {
    return result("failed", reasons, provenance);
  }
  return result(degraded ? "degraded" : "ready", reasons, packet.provenance, packet);
}
