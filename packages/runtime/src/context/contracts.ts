// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ArtifactEnvelope,
  ArtifactReference,
  ContextPageRole,
  ContextPacketPayload,
} from "../artifacts/contracts.js";
import type {
  ContentFormat,
  ContentIndex,
  RepositoryIdentity,
  StructuralEdgeKind,
} from "../content-ir/contracts.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import type {
  WorkflowContextStepPolicy,
  WorkflowDefinition,
  WorkflowStep,
} from "../workflow-contracts/contracts.js";

export const CONTEXT_QUERY_KINDS = [
  "locate",
  "get-neighborhood",
  "find-home",
  "test-placement",
  "expand",
] as const;
export type ContextQueryKind = (typeof CONTEXT_QUERY_KINDS)[number];

export interface LocateContextQuery {
  kind: "locate";
  sourcePath: string;
  anchor?: string;
}

export interface GetNeighborhoodContextQuery {
  kind: "get-neighborhood";
  targetNodeId: string;
  depth?: number;
}

export interface FindHomeContextQuery {
  kind: "find-home";
  targetNodeId: string;
}

export interface TestPlacementContextQuery {
  kind: "test-placement";
  targetNodeId: string;
  candidateParentId: string;
}

export interface ExpandContextQuery {
  kind: "expand";
  /**
   * The packet records these sorted. The order named here is their retention
   * priority: a packet trimmed to its budget keeps the first-named targets.
   */
  targetNodeIds: string[];
  depth?: number;
}

/** Closed, harness-neutral query language for structural documentation context. */
export type ContextQuery =
  | LocateContextQuery
  | GetNeighborhoodContextQuery
  | FindHomeContextQuery
  | TestPlacementContextQuery
  | ExpandContextQuery;

export type ContextBudgetClass = "local" | "corpus";

/**
 * One packet's budget. Workflow preflight derives it from the bound model's
 * input window and the declared shares in `config/limits/context.yaml`
 * (`budget.ts`); the compiler accepts any positive budget a caller derives.
 */
export interface ContextBudget {
  class: ContextBudgetClass;
  maxNodes: number;
  maxEdges: number;
  maxPaths: number;
  maxDepth: number;
  maxBytes: number;
  maxEstimatedTokens: number;
  maxDurationMs: number;
}

/**
 * The packet estimator's ratio: one estimated token per this many canonical
 * bytes. A conversion between two units of one bound, not a bound itself.
 */
export const CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN = 4;

export interface ContextPolicy {
  id: string;
  version: string;
  digest: string;
  /** Degraded packets are safe only for read-only analysis. */
  allowDegradedRead: boolean;
}

export type OntologyArtifact = ArtifactEnvelope<"ontology">;
export type ContextSemanticsArtifact = ArtifactEnvelope<"context-packet">;

export interface ContextCompileInput {
  /** A validated, immutable-revision Content IR index. */
  index: ContentIndex;
  /** A validated ontology artifact bound to the same Content IR. */
  ontology: OntologyArtifact;
  /** Validated semantic packets; repository text is never promoted to semantics. */
  semantics: readonly ContextSemanticsArtifact[];
  query: ContextQuery;
  policy: ContextPolicy;
  budget: ContextBudget;
  activePlan?: ArtifactReference<"ia-plan">;
}

export interface ContextDocumentSummary {
  id: string;
  kind: "document";
  sourcePath: string;
  format: ContentFormat;
  byteLength: number;
  anchors: string[];
}

export interface ContextSectionSummary {
  id: string;
  kind: "section";
  documentId: string;
  sourcePath: string;
  anchor: string;
  depth: number;
  startLine: number;
  endLine: number;
}

export type ContextNodeSummary = ContextDocumentSummary | ContextSectionSummary;

export interface ContextEdgeSummary {
  kind: StructuralEdgeKind;
  from: string;
  to: string;
}

export interface ContextPathSummary {
  nodeIds: string[];
  edgeKinds: StructuralEdgeKind[];
}

export interface ContextSemanticSummary {
  targetNodeId: string;
  pageRole?: ContextPageRole;
  belongsHere: string[];
  belongsElsewhere: string[];
  canonicalHomeNodeIds: string[];
  activeDecisionIds: string[];
}

export type PlacementDisposition =
  | "belongs-here"
  | "belongs-elsewhere"
  | "canonical-home"
  | "undetermined";

export interface PlacementAssessment {
  targetNodeId: string;
  candidateParentId: string;
  disposition: PlacementDisposition;
}

export interface ContextProvenance {
  repository: RepositoryIdentity;
  indexDigest: string;
  ontology: ArtifactReference<"ontology">;
  semanticPackets: ArtifactReference<"context-packet">[];
  activePlan?: ArtifactReference<"ia-plan">;
  consultedNodeIds: string[];
  activeDecisionIds: string[];
  policy: ContextPolicy;
  budget: ContextBudget;
}

export interface ContextPacketV1 {
  schemaVersion: 1;
  query: ContextQuery;
  nodes: ContextNodeSummary[];
  edges: ContextEdgeSummary[];
  paths: ContextPathSummary[];
  semantics: ContextSemanticSummary[];
  placementAssessment?: PlacementAssessment;
  provenance: ContextProvenance;
  estimates: {
    byteLength: number;
    estimatedTokens: number;
  };
  /** SHA-256 over the canonical packet with this field omitted. */
  digest: string;
}

export const CONTEXT_RESULT_STATUSES = ["ready", "degraded", "unnecessary", "failed"] as const;
export type ContextResultStatus = (typeof CONTEXT_RESULT_STATUSES)[number];

export type ContextReasonCode =
  | "page-role-unresolved"
  | "target-unresolved"
  | "candidate-parent-unresolved"
  | "location-unresolved"
  | "canonical-home-unresolved"
  | "placement-undetermined"
  | "node-budget-exceeded"
  | "edge-budget-exceeded"
  | "path-budget-exceeded"
  | "depth-budget-exceeded"
  | "byte-budget-exceeded"
  | "token-budget-exceeded"
  | "latency-budget-exceeded"
  | "repository-mismatch"
  | "invalid-input"
  | "context-unnecessary";

export interface ContextReason {
  code: ContextReasonCode;
  /** Content-free machine detail such as a node ID or budget field. */
  detail?: string;
}

export interface ContextResult {
  status: ContextResultStatus;
  reasons: ContextReason[];
  provenance: ContextProvenance;
  packet?: ContextPacketV1;
}

/** Internal semantic projection retained as a named type for service adapters. */
export interface ContextSemanticInput extends ContextPacketPayload {}

/** Caught-error identity attached to a failed preflight result. Never includes secrets. */
export interface ContextPreflightDiagnostic {
  name: string;
  message: string;
}

/** Harness-neutral preflight packet; its content stays outside durable records. */
export interface ContextPacket {
  schemaVersion: number;
  digest: string;
  consultedNodeIds?: readonly string[];
}

export type ContextPreflightStatus = "ready" | "degraded" | "unnecessary" | "failed";
export type ContextPreflightReason =
  | "context-service-not-configured"
  | "security-scan-not-authorized"
  | "workflow-stopped-before-step"
  | "policy-marked-unnecessary"
  | "semantic-state-unavailable"
  | "target-not-applicable"
  | "preflight-internal-failure"
  /**
   * A declared bound that `limit` names: the hosted compile outran its
   * latency ceiling, or the packet did not fit its input-window share. A
   * packet the compiler trimmed to fit stays `degraded` with that packet. A
   * packet that cannot fit at all leaves the step `degraded` with none: a
   * read-only step runs without it, and the runner stops a write step, which
   * needs a packet.
   */
  | "preflight-budget-exceeded"
  /**
   * A focused index could not read navigation that a selected target's
   * ancestor chain requires: an alias, or an unsupported navigation shape.
   * Always `degraded`: the packet is real but its navigation is incomplete.
   */
  | "navigation-coverage-incomplete"
  /**
   * A selected target, or a directory on its path, is an alias, such as a
   * tracked symlink. It is never followed. The step gets no packet, so it is
   * `degraded` with a `cause` naming the alias: a read-only step runs without
   * a packet, and the runner stops a write step, which needs one. A record
   * written before this rule may carry it as `failed`.
   */
  | "navigation-alias-refused"
  /**
   * The content index refused something in the checkout while the preflight
   * built it: a `ContentIndexError`, such as two pages with one frontmatter
   * `id` or an anchor a target page cannot admit. `cause` names its content
   * index code and the file. `degraded` with no packet.
   */
  | "content-index-refused"
  /**
   * Reading the checkout to build the content index failed with a file-system
   * error. `cause` names the error code. `degraded` with no packet.
   */
  | "content-index-unreadable"
  /**
   * DocsFab could not compile the step's context on its own side: the
   * compiler returned a reason the preflight has no mapping for, such as
   * `invalid-input` or `repository-mismatch`, or building the index or the
   * packet threw an error that is neither a content index refusal nor a
   * file-system error. `cause` names the raw reason. `degraded` with no packet.
   */
  | "context-compile-failed"
  /**
   * A multi-page scope where at least one, but not every, requested page
   * resolved to a document. The packet binds only the pages that resolved;
   * the unresolved ones stay in the step's authoritative review scope
   * without compiled context (nothing here removes them from the scope, and
   * nothing downstream is wired to surface them to the model or a reviewer
   * -- this reason code is the only persisted signal of the gap today).
   * Always `degraded`: the packet is real, but it does not cover the
   * complete requested scope.
   */
  | "scope-target-partially-unresolved";
/**
 * The operational bound that produced a non-ready preflight, recorded beside
 * the coded reason so the record names the limit and both values rather than
 * only the fact that something degraded.
 */
export interface ContextPreflightLimitEvidence {
  name: string;
  /**
   * `ms` for the hosted compile wait. `tokens` for a packet budget: `name` is
   * the catalog share, `configured` the token budget that share gives this
   * run's input window, and `observed` the packet's estimated tokens before a
   * trim or, when no packet fits, those of the smallest packet (its
   * first-ranked node alone), the size a budget must reach for any packet.
   */
  unit: "ms" | "tokens";
  configured: number;
  observed: number;
}
export interface ContextPreflightMeasurements {
  byteLength: number;
  estimatedTokens: number;
  latencyMs: number;
  nodeCount?: number;
  edgeCount?: number;
  pathCount?: number;
}
export interface ContextPreflightCacheEvidence {
  disposition: "disabled" | "hit" | "miss" | "rejected";
  keyDigest?: string;
  rebuildAttempted: boolean;
}
export interface ContextPreflightEvidence {
  status: ContextPreflightStatus;
  packetDigest?: string;
  consultedNodeIds?: string[];
  ontologyVersion?: string;
  effectiveDecisionIds?: string[];
  measurements?: ContextPreflightMeasurements;
  cache?: ContextPreflightCacheEvidence;
  reason?: ContextPreflightReason;
  limit?: ContextPreflightLimitEvidence;
  /**
   * Requested targets the packet does not bind, sorted: NFC,
   * repository-relative paths, with `#anchor` when the request named one. A
   * page absent from the corpus and a page the packet budget trimmed away both
   * appear here. Only a `degraded` step carries it.
   */
  unboundTargets?: string[];
  /**
   * How many more requested targets the packet does not bind whose paths the
   * record cannot hold, such as a path with a control character. They are
   * counted here instead of named, and never fail the step. Only a
   * `degraded` step carries it.
   */
  unboundTargetsOmitted?: number;
  /**
   * What the preflight met, beside a reason in
   * `CONTEXT_PREFLIGHT_CAUSE_REASONS`, and only beside one.
   */
  cause?: ContextPreflightCause;
}
/**
 * The raw cause behind a coded preflight reason, so the step record says what
 * to fix without a second run.
 */
export interface ContextPreflightCause {
  /**
   * The content index code (`unsafe-path`, `duplicate-node-identity`), the
   * compiler reason (`invalid-input`), the file-system code (`EACCES`), the
   * error name, or `selected-alias`.
   */
  code: string;
  /**
   * One secret-free sentence with no host path, naming the file when the
   * cause has one, with every control, format, and separator code point
   * written as `\u{...}`.
   */
  message: string;
}
/**
 * Reasons a step records with a `cause`. Each leaves the step with no packet
 * of its own: a read-only step whose policy admits degraded reads runs
 * without one, and a write step stops before it calls the model.
 */
export const CONTEXT_PREFLIGHT_CAUSE_REASONS = Object.freeze([
  "content-index-refused",
  "content-index-unreadable",
  "context-compile-failed",
  "navigation-alias-refused",
] as const satisfies readonly ContextPreflightReason[]);
export type ContextPreflightCauseReason = (typeof CONTEXT_PREFLIGHT_CAUSE_REASONS)[number];
export function isContextPreflightCauseReason(
  reason: unknown,
): reason is ContextPreflightCauseReason {
  return (CONTEXT_PREFLIGHT_CAUSE_REASONS as readonly unknown[]).includes(reason);
}
export interface ContextPreflightResult extends ContextPreflightEvidence {
  packet?: ContextPacket;
  /**
   * Operator sentences, each starting with its code, for repository content
   * the preflight left out: a file whose on-disk name the content index
   * cannot hold. The runner keeps them as run warnings; none fails the step.
   */
  limitations?: readonly string[];
}
export interface ContextPreflightTarget {
  sourcePath: string;
  anchor?: string;
  candidateParentPath?: string;
  candidateParentAnchor?: string;
}
/**
 * The complete selected page set of a multi-page focused review. It is kept
 * apart from `contextTarget`, which stays the single-page request shape.
 */
export interface ContextPreflightScope {
  /**
   * Every selected page. The preflight binds every page that resolves; when
   * none of them do, the step is `unnecessary`, and when some but not all
   * do, it is `degraded` (`scope-target-partially-unresolved`) and reviews
   * only the ones that resolved.
   */
  targetPaths: readonly string[];
  /** Identity of the reviewed scope, sealed on the run request and bound into the packet cache key. */
  scopeSha256: string;
}
export interface ContextPreflightInput {
  runId: string;
  repository: RepositoryTarget;
  workspacePath: string;
  workflow: WorkflowDefinition;
  step: WorkflowStep;
  policy: WorkflowContextStepPolicy;
  contextTarget?: ContextPreflightTarget;
  /** Set only for a multi-page focused review with no single `contextTarget`. */
  scope?: ContextPreflightScope;
}
export interface ContextPreflightService {
  preflight(input: ContextPreflightInput): Promise<ContextPreflightResult>;
}
