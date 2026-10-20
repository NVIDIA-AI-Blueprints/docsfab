// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SecurityScanAuthorizationEvidence,
  SecurityScanReport,
} from "../security/contracts.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { isRoadmapSkillPackId, validateRoadmapSkillPackEvidence } from "../skills/roadmap-pack.js";
import type { RunRecord, SkillEvidence } from "../records/contracts.js";
import {
  array,
  canonical,
  exact,
  GIT_OBJECT_ID,
  identifier,
  nonnegativeInteger,
  object,
  oneOf,
  pattern,
  positiveInteger,
  repositoryRelativePath,
  requireCondition,
  requireEqual,
  REVISION,
  safeText,
  SHA256,
  timestamp,
  uniqueToolPolicyEntries,
} from "../scorecard-record-parse.js";

export function decodeSecurityScan(value: unknown): SecurityScanReport {
  const item = object(value);
  exact(item, ["ruleSet", "status", "scannedFiles", "binaryFiles", "findings"]);
  const ruleSet = identifier(item.ruleSet);
  const status = oneOf(item.status, ["passed", "blocked", "failed"] as const);
  const scannedFiles = nonnegativeInteger(item.scannedFiles);
  const binaryFiles = nonnegativeInteger(item.binaryFiles);
  requireCondition(binaryFiles <= scannedFiles);
  const findings = array(item.findings).map((entry) => {
    const finding = object(entry);
    exact(finding, ["path", "ruleId"]);
    const path = repositoryRelativePath(finding.path);
    const ruleId = identifier(finding.ruleId);
    return { path, ruleId };
  });
  if (status === "passed") requireCondition(findings.length === 0);
  if (status === "blocked") requireCondition(findings.length > 0);
  return { ruleSet, status, scannedFiles, binaryFiles, findings };
}

export function decodeSecurityDisposition(
  value: unknown,
): NonNullable<RunRecord["securityScanEffectiveDisposition"]> {
  const item = object(value);
  exact(item, ["status"]);
  return {
    status: oneOf(item.status, [
      "advisory",
      "passed",
      "blocked",
      "failed",
      "authorized",
      "denied",
    ] as const),
  };
}

export function decodeSecurityAuthorization(value: unknown): SecurityScanAuthorizationEvidence {
  const item = object(value);
  exact(item, ["status", "overrides"]);
  const status = oneOf(item.status, ["authorized", "denied"] as const);
  const overrides = array(item.overrides).map((entry) => {
    const override = object(entry);
    exact(override, [
      "ruleId",
      "revision",
      "reason",
      "expiresAt",
      "decision",
      "findingCount",
      "rejectionRuleId",
    ]);
    const decision = oneOf(override.decision, ["authorized", "rejected"] as const);
    const rejectionRuleId =
      override.rejectionRuleId === undefined
        ? undefined
        : oneOf(override.rejectionRuleId, [
            "override.scan-not-blocked",
            "override.scan-failed",
            "override.ineligible-rule",
            "override.revision-mismatch",
            "override.reason-required",
            "override.reason-invalid",
            "override.expiry-invalid",
            "override.expired",
            "override.duplicate-rule",
            "override.no-matching-finding",
          ] as const);
    requireCondition((decision === "rejected") === (rejectionRuleId !== undefined));
    return {
      ruleId: identifier(override.ruleId),
      revision: pattern(override.revision, REVISION),
      reason: safeText(override.reason, 4_096),
      expiresAt: timestamp(override.expiresAt),
      decision,
      findingCount: nonnegativeInteger(override.findingCount),
      ...(rejectionRuleId === undefined ? {} : { rejectionRuleId }),
    };
  });
  requireCondition(overrides.length > 0);
  requireCondition(
    status ===
      (overrides.every((override) => override.decision === "authorized") ? "authorized" : "denied"),
  );
  return { status, overrides };
}

export function decodeSkillEvidence(value: unknown): SkillEvidence {
  requireCondition(detectCredentialRuleIdsInValue(value).length === 0);
  const item = object(value);
  exact(item, [
    "id",
    "contentSha256",
    "bundleSha256",
    "version",
    "license",
    "provenanceStatus",
    "source",
    "inputs",
    "outputs",
    "toolPolicy",
    "evaluation",
    "roadmapPack",
  ]);
  const bundleSha256 =
    item.bundleSha256 === undefined ? undefined : pattern(item.bundleSha256, SHA256);
  const version = item.version === undefined ? undefined : identifier(item.version);
  const license = item.license === undefined ? undefined : safeText(item.license, 256);
  const provenanceStatus =
    item.provenanceStatus === undefined
      ? undefined
      : oneOf(item.provenanceStatus, ["docsfab-local", "docsfab-adapted-import"] as const);
  const source = item.source === undefined ? undefined : decodeSkillSource(item.source);
  const inputs = item.inputs === undefined ? undefined : decodeSkillFields(item.inputs);
  const outputs = item.outputs === undefined ? undefined : decodeSkillFields(item.outputs);
  const toolPolicy =
    item.toolPolicy === undefined ? undefined : decodeSkillToolPolicy(item.toolPolicy);
  const evaluation =
    item.evaluation === undefined ? undefined : decodeSkillEvaluation(item.evaluation);
  const roadmapPack =
    item.roadmapPack === undefined ? undefined : decodeRoadmapSkillPack(item.roadmapPack);
  const id = identifier(item.id);
  requireCondition(
    isRoadmapSkillPackId(id) ? roadmapPack !== undefined : roadmapPack === undefined,
  );
  const skill: SkillEvidence = {
    id,
    contentSha256: pattern(item.contentSha256, SHA256),
    ...(bundleSha256 === undefined ? {} : { bundleSha256 }),
    ...(version === undefined ? {} : { version }),
    ...(license === undefined ? {} : { license }),
    ...(provenanceStatus === undefined ? {} : { provenanceStatus }),
    ...(source === undefined ? {} : { source }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(roadmapPack === undefined ? {} : { roadmapPack }),
  };
  if (roadmapPack) validateRoadmapSkillPackEvidence(skill, roadmapPack);
  return skill;
}

export function decodeQualityPackEvidence(
  value: unknown,
): import("../records/contracts.js").QualityPackEvidenceV1 {
  requireCondition(detectCredentialRuleIdsInValue(value).length === 0);
  const item = object(value);
  exact(item, [
    "schemaVersion",
    "id",
    "version",
    "manifestSha256",
    "bindingSha256",
    "skillLockSha256",
    "qualityLockSha256",
    "qualityBundleSha256",
    "barIds",
    "resolvedResources",
  ]);
  requireCondition(item.schemaVersion === 1);
  requireCondition(item.id === "docsfab-default" && item.version === "1.0.0");
  const barIds = array(item.barIds).map(identifier);
  requireCondition(
    new Set(barIds).size === barIds.length &&
      barIds.every((id, index) => index === 0 || barIds[index - 1]!.localeCompare(id) < 0),
  );
  return {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    manifestSha256: pattern(item.manifestSha256, SHA256),
    bindingSha256: pattern(item.bindingSha256, SHA256),
    skillLockSha256: pattern(item.skillLockSha256, SHA256),
    qualityLockSha256: pattern(item.qualityLockSha256, SHA256),
    qualityBundleSha256: pattern(item.qualityBundleSha256, SHA256),
    barIds,
    ...(item.resolvedResources === undefined
      ? {}
      : { resolvedResources: decodeResolvedResourceSet(item.resolvedResources, barIds) }),
  };
}

function decodeResolvedResourceSet(
  value: unknown,
  barIds: readonly string[],
): import("../records/contracts.js").ResolvedResourceSetV1 {
  const item = object(value);
  exact(item, [
    "schemaVersion",
    "declarationPath",
    "declarationSha256",
    "resources",
    "unresolvedLayers",
  ]);
  requireCondition(
    item.schemaVersion === 1 &&
      item.declarationPath === "profiles/product-default.json" &&
      canonical(item.unresolvedLayers) === canonical(["organization", "target", "request"]),
  );
  const resources = array(item.resources).map((entry) => {
    const resource = object(entry);
    exact(resource, ["kind", "id", "layer", "version", "sha256"]);
    const id = identifier(resource.id);
    requireCondition(resource.layer === "product" && barIds.includes(id));
    return {
      kind: oneOf(resource.kind, ["style-profile", "evaluation-profile"] as const),
      id,
      layer: "product" as const,
      version: identifier(resource.version),
      sha256: pattern(resource.sha256, SHA256),
    };
  });
  requireCondition(
    canonical(resources.map((resource) => resource.kind)) ===
      canonical(["style-profile", "evaluation-profile"]),
  );
  return {
    schemaVersion: 1,
    declarationPath: "profiles/product-default.json",
    declarationSha256: pattern(item.declarationSha256, SHA256),
    resources,
    unresolvedLayers: ["organization", "target", "request"],
  };
}

function decodeRoadmapSkillPack(value: unknown): NonNullable<SkillEvidence["roadmapPack"]> {
  const item = object(value);
  exact(item, ["schemaVersion", "contractSha256", "upstreamBundles", "adaptation"]);
  requireCondition(item.schemaVersion === 1);
  const adaptation = object(item.adaptation);
  exact(adaptation, ["version", "sha256", "mappingSha256"]);
  return {
    schemaVersion: 1,
    contractSha256: pattern(item.contractSha256, SHA256),
    upstreamBundles: array(item.upstreamBundles).map((value) => {
      const bundle = object(value);
      exact(bundle, ["id", "bundleSha256", "repository", "revision", "path", "version", "license"]);
      return {
        id: identifier(bundle.id),
        bundleSha256: pattern(bundle.bundleSha256, SHA256),
        repository: credentialFreeHttpsUrl(bundle.repository),
        revision: pattern(bundle.revision, GIT_OBJECT_ID),
        path: repositoryRelativePath(bundle.path),
        version: identifier(bundle.version),
        license: safeText(bundle.license, 256),
      };
    }),
    adaptation: {
      version: identifier(adaptation.version),
      sha256: pattern(adaptation.sha256, SHA256),
      mappingSha256: pattern(adaptation.mappingSha256, SHA256),
    },
  };
}

function credentialFreeHttpsUrl(value: unknown): string {
  const repository = safeText(value, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(repository);
  } catch {
    requireCondition(false);
  }
  requireCondition(
    parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash,
  );
  return repository;
}

function decodeSkillSource(value: unknown): NonNullable<SkillEvidence["source"]> {
  const item = object(value);
  exact(item, ["repository", "revision", "path"]);
  return {
    repository: safeText(item.repository, 4_096),
    revision: safeText(item.revision, 1_024),
    path: repositoryRelativePath(item.path),
  };
}

function decodeSkillFields(value: unknown): NonNullable<SkillEvidence["inputs"]> {
  return array(value).map((entry) => {
    const item = object(entry);
    exact(item, ["name", "description"]);
    return { name: identifier(item.name), description: safeText(item.description, 4_096) };
  });
}

function decodeSkillToolPolicy(value: unknown): NonNullable<SkillEvidence["toolPolicy"]> {
  const item = object(value);
  exact(item, ["declared", "granted", "withheld"]);
  return {
    declared: uniqueToolPolicyEntries(item.declared),
    granted: uniqueToolPolicyEntries(item.granted),
    withheld: uniqueToolPolicyEntries(item.withheld),
  };
}

function decodeSkillEvaluation(value: unknown): NonNullable<SkillEvidence["evaluation"]> {
  const item = object(value);
  exact(item, ["id", "version", "path", "sha256"]);
  return {
    id: identifier(item.id),
    version: positiveInteger(item.version),
    path: repositoryRelativePath(item.path),
    sha256: pattern(item.sha256, SHA256),
  };
}
