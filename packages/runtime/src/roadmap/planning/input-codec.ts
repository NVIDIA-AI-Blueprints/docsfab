// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../../contract-kit/freeze.js";
import { ROADMAP_SKILL_PACK_CONTRACTS } from "../../skills/roadmap-pack.js";
import { roadmapCanonicalJson, roadmapDigest } from "../contracts/decode.js";
import { validateRoadmapLedger, type RoadmapProjectIdentity } from "../contracts/ledger.js";
import { compareText } from "../../shared/primitives.js";
import { requireCondition } from "./protocol.js";
import {
  boundedInteger,
  boolean,
  closed,
  confidence,
  contentArray,
  denseArray,
  digest,
  enumeration,
  identifier,
  pathArray,
  positiveInteger,
  revision,
  safeContent,
  safePath,
  textArray,
  timestamp,
  unique,
  decodeDraft,
  sameStrings,
} from "./value-codec.js";
import {
  ROADMAP_PLANNING_DISPOSITIONS,
  ROADMAP_PLANNING_MODES,
  ROADMAP_PLANNING_SCHEMA_VERSION,
  type RoadmapHealthAuditPackage,
  type RoadmapHealthPlanningInput,
  type RoadmapPlanningCandidateInput,
  type RoadmapPlanningDisposition,
  type RoadmapPlanningInput,
  type RoadmapPlanningUnit,
  type RoadmapReleaseBoundaryAuthority,
  type RoadmapReleaseChange,
  type RoadmapReleasePlanningInput,
  type RoadmapSemanticReconciliation,
  type RoadmapSweepPlanningInput,
} from "./schema.js";

export function decodeRoadmapPlanningInput(value: unknown): RoadmapPlanningInput {
  const root = closed(
    value,
    "$",
    [
      "kind",
      "schemaVersion",
      "mode",
      "repository",
      "project",
      "observedAt",
      "expiresAt",
      "units",
      "candidates",
      "semanticReconciliation",
      "proposalCap",
      "fromRevision",
      "toRevision",
      "releaseRef",
      "releasePackContractSha256",
      "scope",
      "docAudit",
      "baseLedger",
      "releaseBoundary",
    ],
    [
      "kind",
      "schemaVersion",
      "mode",
      "repository",
      "project",
      "observedAt",
      "expiresAt",
      "units",
      "candidates",
      "semanticReconciliation",
      "proposalCap",
    ],
  );
  requireCondition(
    root.kind === "docsfab-roadmap-planning-input" && root.schemaVersion === 1,
    "invalid-input",
    "$",
  );
  const mode = enumeration(root.mode, ROADMAP_PLANNING_MODES, "$.mode");
  const repository = decodeRepository(root.repository, "$.repository");
  const project = decodeProject(root.project, "$.project");
  const observedAt = timestamp(root.observedAt, "$.observedAt");
  const expiresAt = timestamp(root.expiresAt, "$.expiresAt");
  requireCondition(Date.parse(observedAt) <= Date.parse(expiresAt), "invalid-input", "$.expiresAt");
  const units = denseArray(root.units, "$.units")
    .map((item, index) => decodeUnit(item, `$.units[${index}]`))
    .sort((left, right) => compareText(left.id, right.id));
  unique(
    units.map((item) => item.id),
    "$.units",
  );
  const candidates = denseArray(root.candidates, "$.candidates")
    .map((item, index) => decodeCandidate(item, `$.candidates[${index}]`))
    .sort((left, right) => compareText(left.id, right.id));
  unique(
    candidates.map((item) => item.id),
    "$.candidates",
  );
  const unitIds = new Set(units.map((item) => item.id));
  const accounted = candidates.flatMap((candidate) => candidate.unitIds);
  requireCondition(
    accounted.length === new Set(accounted).size &&
      accounted.every((id) => unitIds.has(id)) &&
      accounted.length === units.length,
    "unaccounted-boundary",
    "$.candidates.unitIds",
  );
  const semanticReconciliation = denseArray(root.semanticReconciliation, "$.semanticReconciliation")
    .map((item, index) => decodeSemantic(item, `$.semanticReconciliation[${index}]`))
    .sort((left, right) =>
      compareText(`${left.candidateId}:${left.issueIid}`, `${right.candidateId}:${right.issueIid}`),
    );
  const proposalCap = positiveInteger(root.proposalCap, "$.proposalCap");
  const base = {
    kind: "docsfab-roadmap-planning-input" as const,
    schemaVersion: 1 as const,
    mode,
    repository,
    project,
    observedAt,
    expiresAt,
    units,
    candidates,
    semanticReconciliation,
    proposalCap,
  };
  if (mode === "release") {
    const result: RoadmapReleasePlanningInput = {
      ...base,
      mode,
      fromRevision: revision(root.fromRevision, "$.fromRevision"),
      toRevision: revision(root.toRevision, "$.toRevision"),
      ...(root.releaseRef === undefined
        ? {}
        : { releaseRef: identifier(root.releaseRef, "$.releaseRef") }),
      releasePackContractSha256: digest(
        root.releasePackContractSha256,
        "$.releasePackContractSha256",
      ),
      releaseBoundary: decodeReleaseBoundary(root.releaseBoundary, "$.releaseBoundary"),
    };
    requireCondition(result.toRevision === repository.revision, "stale-repository", "$.toRevision");
    requireCondition(
      result.releasePackContractSha256 ===
        ROADMAP_SKILL_PACK_CONTRACTS["release-docs-epic"].contractSha256,
      "invalid-input",
      "$.releasePackContractSha256",
    );
    requireCondition(
      result.releaseBoundary.fromRevision === result.fromRevision &&
        result.releaseBoundary.toRevision === result.toRevision &&
        result.releaseBoundary.toTreeDigest === repository.contentDigest,
      "stale-repository",
      "$.releaseBoundary",
    );
    requireCondition(
      result.releaseBoundary.projectIdentityDigest === roadmapDigest(project),
      "invalid-input",
      "$.releaseBoundary.projectIdentityDigest",
    );
    requireCondition(
      result.candidates.every((candidate) =>
        ["documented", "no-doc-impact", "needs-update", "needs-new-doc"].includes(
          candidate.disposition,
        ),
      ),
      "invalid-input",
      "$.candidates.disposition",
    );
    requireCondition(
      result.units.every((unit) => ["change", "commit", "merge-request"].includes(unit.kind)),
      "invalid-input",
      "$.units.kind",
    );
    const changeUnits = result.units.filter((unit) => unit.kind === "change");
    requireCondition(
      changeUnits.length === result.releaseBoundary.changes.length &&
        result.releaseBoundary.changes.every((change) =>
          changeUnits.some(
            (unit) =>
              unit.status === change.status &&
              unit.path === change.path &&
              unit.previousPath === change.previousPath &&
              unit.evidenceDigest === change.evidenceDigest,
          ),
        ),
      "unaccounted-boundary",
      "$.releaseBoundary.changes",
    );
    requireCondition(
      root.scope === undefined && root.docAudit === undefined && root.baseLedger === undefined,
      "invalid-input",
      "$",
    );
    return deepFreeze(result);
  }
  if (mode === "health") {
    const audit = decodeHealthAuditPackage(root.docAudit, "$.docAudit");
    const result: RoadmapHealthPlanningInput = {
      ...base,
      mode,
      ...(root.scope === undefined ? {} : { scope: safePath(root.scope, "$.scope") }),
      docAudit: audit,
    };
    requireCondition(
      result.docAudit.repositoryRevision === repository.revision &&
        result.docAudit.repositoryContentDigest === repository.contentDigest,
      "stale-repository",
      "$.docAudit",
    );
    requireCondition(
      result.docAudit.projectIdentityDigest === roadmapDigest(project),
      "invalid-input",
      "$.docAudit.projectIdentityDigest",
    );
    requireCondition(result.docAudit.scope === result.scope, "invalid-input", "$.docAudit.scope");
    requireCondition(
      result.candidates.every((candidate) =>
        ["healthy", "repair", "restructure", "investigate", "excluded", "blocked"].includes(
          candidate.disposition,
        ),
      ),
      "invalid-input",
      "$.candidates.disposition",
    );
    requireCondition(
      result.units.every((unit) =>
        ["doc-audit", "structural", "impact", "repository"].includes(unit.kind),
      ),
      "invalid-input",
      "$.units.kind",
    );
    requireCondition(
      result.units.every((unit) => unit.status === undefined && unit.previousPath === undefined),
      "invalid-input",
      "$.units",
    );
    requireCondition(
      result.units.every(
        (unit) =>
          result.scope === undefined ||
          unit.path === result.scope ||
          unit.path.startsWith(`${result.scope}/`),
      ),
      "invalid-input",
      "$.units.path",
    );
    requireCondition(
      result.candidates.every((candidate) =>
        candidate.affectedPaths.every(
          (path) =>
            result.scope === undefined ||
            path === result.scope ||
            path.startsWith(`${result.scope}/`),
        ),
      ),
      "invalid-input",
      "$.candidates.affectedPaths",
    );
    requireCondition(
      result.docAudit.findings.length === result.candidates.length &&
        result.candidates.every((candidate) =>
          result.docAudit.findings.some((finding) => {
            const authorityUnitIds = finding.units.map((unit) => unit.id).sort(compareText);
            return (
              finding.id === candidate.id &&
              sameStrings(authorityUnitIds, candidate.unitIds) &&
              finding.units.every((authorityUnit) =>
                result.units.some(
                  (unit) => roadmapCanonicalJson(unit) === roadmapCanonicalJson(authorityUnit),
                ),
              ) &&
              sameStrings(finding.affectedPaths, candidate.affectedPaths) &&
              finding.evidenceDigest === candidate.evidenceDigest &&
              finding.candidateDigest === roadmapDigest(candidate) &&
              candidate.affectedPaths.every((path) =>
                finding.units.some((unit) => unit.path === path),
              )
            );
          }),
        ),
      "invalid-input",
      "$.docAudit.findings",
    );
    requireCondition(
      root.fromRevision === undefined &&
        root.toRevision === undefined &&
        root.releasePackContractSha256 === undefined &&
        root.baseLedger === undefined,
      "invalid-input",
      "$",
    );
    return deepFreeze(result);
  }
  const baseLedger = validateRoadmapLedger(root.baseLedger);
  requireCondition(
    baseLedger.repository.revision === repository.revision &&
      baseLedger.repository.contentDigest === repository.contentDigest,
    "stale-repository",
    "$.baseLedger.repository",
  );
  requireCondition(
    root.fromRevision === undefined &&
      root.toRevision === undefined &&
      root.releasePackContractSha256 === undefined &&
      root.docAudit === undefined,
    "invalid-input",
    "$",
  );
  return deepFreeze({ ...base, mode, baseLedger });
}

function decodeUnit(value: unknown, path: string): RoadmapPlanningUnit {
  const item = closed(
    value,
    path,
    ["id", "kind", "path", "evidenceDigest", "status", "previousPath"],
    ["id", "kind", "path", "evidenceDigest"],
  );
  const kind = enumeration(
    item.kind,
    [
      "change",
      "commit",
      "merge-request",
      "doc-audit",
      "structural",
      "impact",
      "repository",
    ] as const,
    `${path}.kind`,
  );
  const result: RoadmapPlanningUnit = {
    id: identifier(item.id, `${path}.id`),
    kind,
    path: safePath(item.path, `${path}.path`),
    evidenceDigest: digest(item.evidenceDigest, `${path}.evidenceDigest`),
    ...(item.status === undefined
      ? {}
      : {
          status: enumeration(
            item.status,
            ["added", "modified", "deleted", "renamed"] as const,
            `${path}.status`,
          ),
        }),
    ...(item.previousPath === undefined
      ? {}
      : { previousPath: safePath(item.previousPath, `${path}.previousPath`) }),
  };
  requireCondition(
    kind === "change"
      ? result.status !== undefined
      : result.status === undefined && result.previousPath === undefined,
    "invalid-input",
    path,
  );
  requireCondition(
    result.status === "renamed"
      ? result.previousPath !== undefined && result.previousPath !== result.path
      : result.previousPath === undefined,
    "invalid-input",
    path,
  );
  return result;
}

function decodeReleaseBoundary(value: unknown, path: string): RoadmapReleaseBoundaryAuthority {
  const item = closed(value, path, [
    "kind",
    "fromRevision",
    "toRevision",
    "fromTreeDigest",
    "toTreeDigest",
    "diffDigest",
    "projectIdentityDigest",
    "changes",
    "digest",
  ]);
  const changes = denseArray(item.changes, `${path}.changes`)
    .map((child, index) => {
      const change = closed(
        child,
        `${path}.changes[${index}]`,
        ["status", "path", "previousPath", "evidenceDigest"],
        ["status", "path", "evidenceDigest"],
      );
      const status = enumeration(
        change.status,
        ["added", "modified", "deleted", "renamed"] as const,
        `${path}.changes[${index}].status`,
      );
      const result: RoadmapReleaseChange = {
        status,
        path: safePath(change.path, `${path}.changes[${index}].path`),
        ...(change.previousPath === undefined
          ? {}
          : {
              previousPath: safePath(change.previousPath, `${path}.changes[${index}].previousPath`),
            }),
        evidenceDigest: digest(change.evidenceDigest, `${path}.changes[${index}].evidenceDigest`),
      };
      requireCondition(
        status === "renamed"
          ? result.previousPath !== undefined && result.previousPath !== result.path
          : result.previousPath === undefined,
        "invalid-input",
        `${path}.changes[${index}]`,
      );
      requireCondition(
        result.evidenceDigest ===
          roadmapDigest({
            status: result.status,
            path: result.path,
            ...(result.previousPath === undefined ? {} : { previousPath: result.previousPath }),
          }),
        "invalid-input",
        `${path}.changes[${index}].evidenceDigest`,
      );
      return result;
    })
    .sort((left, right) =>
      compareText(
        `${left.path}:${left.previousPath ?? ""}`,
        `${right.path}:${right.previousPath ?? ""}`,
      ),
    );
  unique(
    changes.map((change) => `${change.status}:${change.previousPath ?? ""}:${change.path}`),
    `${path}.changes`,
  );
  const result: RoadmapReleaseBoundaryAuthority = {
    kind: "git-release-boundary",
    fromRevision: revision(item.fromRevision, `${path}.fromRevision`),
    toRevision: revision(item.toRevision, `${path}.toRevision`),
    fromTreeDigest: digest(item.fromTreeDigest, `${path}.fromTreeDigest`),
    toTreeDigest: digest(item.toTreeDigest, `${path}.toTreeDigest`),
    diffDigest: digest(item.diffDigest, `${path}.diffDigest`),
    projectIdentityDigest: digest(item.projectIdentityDigest, `${path}.projectIdentityDigest`),
    changes,
    digest: digest(item.digest, `${path}.digest`),
  };
  requireCondition(
    item.kind === "git-release-boundary" && roadmapDigest(result) === result.digest,
    "invalid-input",
    path,
  );
  return result;
}

function decodeHealthAuditPackage(value: unknown, path: string): RoadmapHealthAuditPackage {
  const item = closed(
    value,
    path,
    [
      "kind",
      "schemaVersion",
      "runId",
      "workflow",
      "status",
      "repositoryRevision",
      "repositoryContentDigest",
      "projectIdentityDigest",
      "scope",
      "findings",
      "digest",
    ],
    [
      "kind",
      "schemaVersion",
      "runId",
      "workflow",
      "status",
      "repositoryRevision",
      "repositoryContentDigest",
      "projectIdentityDigest",
      "findings",
      "digest",
    ],
  );
  const findings = denseArray(item.findings, `${path}.findings`)
    .map((child, index) => {
      const finding = closed(child, `${path}.findings[${index}]`, [
        "id",
        "units",
        "affectedPaths",
        "evidenceDigest",
        "candidateDigest",
      ]);
      const units = denseArray(finding.units, `${path}.findings[${index}].units`)
        .map((unit, unitIndex) =>
          decodeUnit(unit, `${path}.findings[${index}].units[${unitIndex}]`),
        )
        .sort((left, right) => compareText(left.id, right.id));
      unique(
        units.map((unit) => unit.id),
        `${path}.findings[${index}].units`,
      );
      return {
        id: identifier(finding.id, `${path}.findings[${index}].id`),
        units,
        affectedPaths: pathArray(finding.affectedPaths, `${path}.findings[${index}].affectedPaths`),
        evidenceDigest: digest(finding.evidenceDigest, `${path}.findings[${index}].evidenceDigest`),
        candidateDigest: digest(
          finding.candidateDigest,
          `${path}.findings[${index}].candidateDigest`,
        ),
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
  unique(
    findings.map((finding) => finding.id),
    `${path}.findings`,
  );
  unique(
    findings.flatMap((finding) => finding.units.map((unit) => unit.id)),
    `${path}.findings.units`,
  );
  const result: RoadmapHealthAuditPackage = {
    kind: "authenticated-doc-audit-package",
    schemaVersion: 1,
    runId: identifier(item.runId, `${path}.runId`),
    workflow: "review-documentation",
    status: "succeeded",
    repositoryRevision: revision(item.repositoryRevision, `${path}.repositoryRevision`),
    repositoryContentDigest: digest(
      item.repositoryContentDigest,
      `${path}.repositoryContentDigest`,
    ),
    projectIdentityDigest: digest(item.projectIdentityDigest, `${path}.projectIdentityDigest`),
    ...(item.scope === undefined ? {} : { scope: safePath(item.scope, `${path}.scope`) }),
    findings,
    digest: digest(item.digest, `${path}.digest`),
  };
  requireCondition(
    item.kind === result.kind &&
      item.schemaVersion === 1 &&
      item.workflow === "review-documentation" &&
      item.status === "succeeded" &&
      roadmapDigest(result) === result.digest,
    "invalid-input",
    path,
  );
  return result;
}

function decodeCandidate(value: unknown, path: string): RoadmapPlanningCandidateInput {
  const item = closed(
    value,
    path,
    [
      "id",
      "category",
      "severity",
      "disposition",
      "unitIds",
      "affectedPaths",
      "evidenceDigest",
      "rank",
      "review",
      "draft",
      "dependsOnCandidateIds",
    ],
    [
      "id",
      "category",
      "severity",
      "disposition",
      "unitIds",
      "affectedPaths",
      "evidenceDigest",
      "rank",
      "review",
    ],
  );
  const rankValue = closed(item.rank, `${path}.rank`, [
    "impact",
    "urgency",
    "dependency",
    "scope",
    "verificationCost",
    "confidence",
  ]);
  const rank = {
    impact: boundedInteger(rankValue.impact, `${path}.rank.impact`, 0, 4),
    urgency: boundedInteger(rankValue.urgency, `${path}.rank.urgency`, 0, 4),
    dependency: boundedInteger(rankValue.dependency, `${path}.rank.dependency`, 0, 4),
    scope: boundedInteger(rankValue.scope, `${path}.rank.scope`, 0, 4),
    verificationCost: boundedInteger(
      rankValue.verificationCost,
      `${path}.rank.verificationCost`,
      0,
      4,
    ),
    confidence: confidence(rankValue.confidence, `${path}.rank.confidence`),
  };
  const reviewValue = closed(item.review, `${path}.review`, [
    "disposition",
    "rationaleCode",
    "evidenceDigest",
  ]);
  const draft = item.draft === undefined ? undefined : decodeDraft(item.draft, `${path}.draft`);
  const result: RoadmapPlanningCandidateInput = {
    id: identifier(item.id, `${path}.id`),
    category: identifier(item.category, `${path}.category`),
    severity: enumeration(item.severity, ["p0", "p1", "p2"] as const, `${path}.severity`),
    disposition: enumeration(
      item.disposition,
      ROADMAP_PLANNING_DISPOSITIONS,
      `${path}.disposition`,
    ),
    unitIds: textArray(item.unitIds, `${path}.unitIds`).sort(compareText),
    affectedPaths: pathArray(item.affectedPaths, `${path}.affectedPaths`),
    evidenceDigest: digest(item.evidenceDigest, `${path}.evidenceDigest`),
    rank,
    review: {
      disposition: enumeration(
        reviewValue.disposition,
        ["accepted", "investigation", "rejected"] as const,
        `${path}.review.disposition`,
      ),
      rationaleCode: identifier(reviewValue.rationaleCode, `${path}.review.rationaleCode`),
      evidenceDigest: digest(reviewValue.evidenceDigest, `${path}.review.evidenceDigest`),
    },
    ...(draft === undefined ? {} : { draft }),
    ...(item.dependsOnCandidateIds === undefined
      ? {}
      : {
          dependsOnCandidateIds: textArray(
            item.dependsOnCandidateIds,
            `${path}.dependsOnCandidateIds`,
          ),
        }),
  };
  requireCondition(
    result.unitIds.length > 0 && result.affectedPaths.length > 0,
    "invalid-input",
    path,
  );
  requireCondition(
    result.draft === undefined || sameStrings(result.affectedPaths, result.draft.evidencePaths),
    "invalid-input",
    `${path}.draft.evidencePaths`,
  );
  requireCondition(
    result.review.disposition === "rejected" ||
      result.draft !== undefined ||
      ["documented", "no-doc-impact", "healthy", "excluded"].includes(result.disposition),
    "invalid-input",
    `${path}.draft`,
  );
  return result;
}

function decodeSemantic(value: unknown, path: string): RoadmapSemanticReconciliation {
  const item = closed(value, path, [
    "candidateId",
    "issueIid",
    "decision",
    "confidence",
    "evidenceDigest",
  ]);
  return {
    candidateId: identifier(item.candidateId, `${path}.candidateId`),
    issueIid: positiveInteger(item.issueIid, `${path}.issueIid`),
    decision: enumeration(
      item.decision,
      ["extend", "supersede", "conflict", "unrelated"] as const,
      `${path}.decision`,
    ),
    confidence: confidence(item.confidence, `${path}.confidence`),
    evidenceDigest: digest(item.evidenceDigest, `${path}.evidenceDigest`),
  };
}

function decodeRepository(
  value: unknown,
  path: string,
): { revision: string; contentDigest: string } {
  const item = closed(value, path, ["revision", "contentDigest"]);
  return {
    revision: revision(item.revision, `${path}.revision`),
    contentDigest: digest(item.contentDigest, `${path}.contentDigest`),
  };
}

function decodeProject(value: unknown, path: string): RoadmapProjectIdentity {
  const item = closed(value, path, ["provider", "host", "fullPath", "projectId"]);
  const provider = identifier(item.provider, `${path}.provider`);
  const host = safeContent(item.host, `${path}.host`);
  const fullPath = safePath(item.fullPath, `${path}.fullPath`);
  requireCondition(fullPath.includes("/") && !provider.includes(":"), "invalid-input", path);
  return {
    provider,
    host,
    fullPath,
    projectId: positiveInteger(item.projectId, `${path}.projectId`),
  };
}
