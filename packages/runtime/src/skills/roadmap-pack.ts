// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { verifyGovernedAssetBundle, type GovernedAssetEvidence } from "../assets/lock.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import type { RoadmapSkillPackEvidence, SkillEvidence } from "../records/contracts.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";

const SHA256 = /^[a-f0-9]{64}$/;

export const ROADMAP_SKILL_PACK_IDS = [
  "release-docs-epic",
  "doc-fix-issues",
  "doc-session-insights",
  "doc-pr-auto-sync",
] as const;
export type RoadmapSkillPackId = (typeof ROADMAP_SKILL_PACK_IDS)[number];

export const ROADMAP_SKILL_PACK_CONTRACTS: Readonly<
  Record<RoadmapSkillPackId, { contractSha256: string; upstreamBundleIds: readonly string[] }>
> = {
  "release-docs-epic": {
    contractSha256: "74609ef309df19b62fd8a16de8aac878181cdd5169807a7507cc2b7e5144d9d3",
    upstreamBundleIds: [
      "roadmap-helpers-apache",
      "roadmap-helpers-repository-license",
      "skill-release-docs-epic-roadmap",
    ],
  },
  // Not recomputed when `save_execute.py` left the bundle it depends on; still
  // attests the pre-removal bundle. See
  // `PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS`.
  "doc-fix-issues": {
    contractSha256: "967c149e2cae2654371b21ef52a77698b6ea55411c4202fd3f110a27627b8f53",
    upstreamBundleIds: [
      "skill-doc-fix-issues-roadmap",
      "roadmap-helpers-apache",
      "roadmap-helpers-repository-license",
    ],
  },
  // Pre-removal attestation; see `PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS`.
  "doc-session-insights": {
    contractSha256: "d162a3d9a7c4f9b5c89e6e82e85065c8884e6d457347c44fee0a29f459e25d5a",
    upstreamBundleIds: [
      "skill-doc-session-insights-open-issues",
      "roadmap-helpers-apache",
      "roadmap-helpers-repository-license",
    ],
  },
  // Pre-removal attestation; see `PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS`.
  "doc-pr-auto-sync": {
    contractSha256: "ef0e84700cbdc45e0b8c5d1716fcdbe74e4fcf9bbcfb9a6aa402ff094456ff31",
    upstreamBundleIds: [
      "skill-doc-pr-auto-sync-roadmap",
      "roadmap-helpers-apache",
      "roadmap-helpers-repository-license",
    ],
  },
};

/**
 * The `contractSha256` values of `doc-fix-issues`, `doc-session-insights`, and
 * `doc-pr-auto-sync` in {@link ROADMAP_SKILL_PACK_CONTRACTS} were not
 * recomputed when `save_execute.py` was removed from the
 * `roadmap-helpers-repository-license` bundle all four packs
 * depend on. They still attest the pre-removal bundle named below. Recomputing
 * them needs each pack's own `SkillEvidence` preimage, and only
 * `release-docs-epic`'s is in this repo
 * (`test/fixtures/release-docs-epic-skill-evidence.json`).
 *
 * No shipped resolver produces `roadmapPack` evidence for these four ids
 * (`CatalogSkillCrateResolver` excludes them as parked adapters), so this is a
 * documented gap in `scorecard-record-decode.ts`'s recompute-and-compare check,
 * not a live provenance failure. `roadmap-skill-packs.test.ts` pins this table
 * so editing any of the three constants without updating this table fails.
 */
export const PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS: Readonly<
  Record<
    Exclude<RoadmapSkillPackId, "release-docs-epic">,
    { readonly attestsUpstreamBundleId: string; readonly attestsBundleSha256: string }
  >
> = {
  "doc-fix-issues": {
    attestsUpstreamBundleId: "roadmap-helpers-repository-license",
    attestsBundleSha256: "416eaa7c50a8b7701ce9b3eba4016360a2ccc69b7220064ce801bcd6615b0cbf",
  },
  "doc-session-insights": {
    attestsUpstreamBundleId: "roadmap-helpers-repository-license",
    attestsBundleSha256: "416eaa7c50a8b7701ce9b3eba4016360a2ccc69b7220064ce801bcd6615b0cbf",
  },
  "doc-pr-auto-sync": {
    attestsUpstreamBundleId: "roadmap-helpers-repository-license",
    attestsBundleSha256: "416eaa7c50a8b7701ce9b3eba4016360a2ccc69b7220064ce801bcd6615b0cbf",
  },
};

export interface LockedRoadmapSkillPack {
  provenanceBundleIds: string[];
  adaptation: {
    version: string;
    path: string;
    sha256: string;
    mappingPath: string;
    mappingSha256: string;
  };
  contractSha256: string;
}

export type GovernedSkillIntegrityErrorCode =
  | "lock-unavailable"
  | "invalid-lock"
  | "unsafe-path"
  | "file-set-mismatch"
  | "checksum-mismatch"
  | "provenance-mismatch"
  | "tool-policy-mismatch"
  | "adaptation-mismatch";

export class GovernedSkillIntegrityError extends Error {
  public constructor(public readonly code: GovernedSkillIntegrityErrorCode) {
    super(`Governed skill integrity verification failed (${code}).`);
    this.name = "GovernedSkillIntegrityError";
  }
}

export function isRoadmapSkillPackId(value: string): value is RoadmapSkillPackId {
  return ROADMAP_SKILL_PACK_IDS.includes(value as RoadmapSkillPackId);
}

export async function verifyRoadmapSkillPack(
  projectRoot: string,
  skill: SkillEvidence,
  locked: LockedRoadmapSkillPack,
): Promise<RoadmapSkillPackEvidence> {
  if (!isRoadmapSkillPackId(skill.id) || locked.provenanceBundleIds.length < 1) {
    throw new GovernedSkillIntegrityError("invalid-lock");
  }
  if (new Set(locked.provenanceBundleIds).size !== locked.provenanceBundleIds.length) {
    throw new GovernedSkillIntegrityError("invalid-lock");
  }
  let assets: GovernedAssetEvidence[];
  try {
    assets = await Promise.all(
      locked.provenanceBundleIds.map(
        async (id) => (await verifyGovernedAssetBundle(projectRoot, id)).evidence,
      ),
    );
  } catch (error) {
    throw normalizeAssetError(error);
  }
  if (locked.adaptation.sha256 !== skill.contentSha256) {
    throw new GovernedSkillIntegrityError("adaptation-mismatch");
  }
  const sourceDirectory = skill.source?.path.split("/").slice(0, -1).join("/");
  if (
    !skill.source ||
    !sourceDirectory ||
    !assets.some(
      (asset) =>
        asset.source.repository === skill.source?.repository &&
        asset.source.revision === skill.source.revision &&
        asset.source.path === sourceDirectory,
    )
  ) {
    throw new GovernedSkillIntegrityError("provenance-mismatch");
  }
  if (!SHA256.test(locked.adaptation.mappingSha256) || !SHA256.test(locked.contractSha256)) {
    throw new GovernedSkillIntegrityError("invalid-lock");
  }
  const evidence: RoadmapSkillPackEvidence = {
    schemaVersion: 1,
    contractSha256: locked.contractSha256,
    upstreamBundles: [...assets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => ({
        id: asset.id,
        bundleSha256: asset.bundleSha256,
        repository: asset.source.repository,
        revision: asset.source.revision,
        path: asset.source.path,
        version: asset.version,
        license: asset.license,
      })),
    adaptation: {
      version: locked.adaptation.version,
      sha256: locked.adaptation.sha256,
      mappingSha256: locked.adaptation.mappingSha256,
    },
  };
  const actual = roadmapSkillPackContractSha256(skill, evidence);
  if (actual !== locked.contractSha256) {
    throw new GovernedSkillIntegrityError("provenance-mismatch");
  }
  return deepFreeze(validateRoadmapSkillPackEvidence(skill, evidence));
}

export function roadmapSkillPackContractSha256(
  skill: SkillEvidence,
  evidence: Omit<RoadmapSkillPackEvidence, "contractSha256"> & { contractSha256?: string },
): string {
  if (detectCredentialRuleIdsInValue({ skill, evidence }).length > 0) {
    throw new GovernedSkillIntegrityError("invalid-lock");
  }
  const input = {
    schemaVersion: 1,
    skill: {
      id: skill.id,
      contentSha256: skill.contentSha256,
      bundleSha256: skill.bundleSha256,
      version: skill.version,
      license: skill.license,
      provenanceStatus: skill.provenanceStatus,
      source: skill.source,
      inputs: skill.inputs,
      outputs: skill.outputs,
      toolPolicy: skill.toolPolicy,
    },
    upstreamBundles: evidence.upstreamBundles,
    adaptation: evidence.adaptation,
  };
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** Validates durable pack evidence against the exact contracts reviewed here. */
export function validateRoadmapSkillPackEvidence(
  skill: SkillEvidence,
  evidence: RoadmapSkillPackEvidence,
): RoadmapSkillPackEvidence {
  if (
    !isRoadmapSkillPackId(skill.id) ||
    detectCredentialRuleIdsInValue({ skill, evidence }).length > 0
  ) {
    throw new GovernedSkillIntegrityError("invalid-lock");
  }
  const expected = ROADMAP_SKILL_PACK_CONTRACTS[skill.id];
  const actualIds = evidence.upstreamBundles.map((bundle) => bundle.id);
  if (
    actualIds.length === 0 ||
    new Set(actualIds).size !== actualIds.length ||
    JSON.stringify(actualIds) !== JSON.stringify(expected.upstreamBundleIds) ||
    skill.provenanceStatus !== "docsfab-adapted-import" ||
    !skill.bundleSha256 ||
    !skill.version ||
    !skill.license ||
    !skill.source ||
    !skill.inputs ||
    !skill.outputs ||
    !skill.toolPolicy ||
    evidence.adaptation.version !== skill.version ||
    evidence.adaptation.sha256 !== skill.contentSha256 ||
    evidence.contractSha256 !== expected.contractSha256 ||
    roadmapSkillPackContractSha256(skill, evidence) !== expected.contractSha256
  ) {
    throw new GovernedSkillIntegrityError("provenance-mismatch");
  }
  return evidence;
}

function normalizeAssetError(error: unknown): GovernedSkillIntegrityError {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("unsafe path")) return new GovernedSkillIntegrityError("unsafe-path");
  if (message.includes("file set")) return new GovernedSkillIntegrityError("file-set-mismatch");
  if (message.includes("provenance checksum"))
    return new GovernedSkillIntegrityError("provenance-mismatch");
  if (message.includes("checksum mismatch"))
    return new GovernedSkillIntegrityError("checksum-mismatch");
  if (message.includes("unavailable") || message.includes("ENOENT"))
    return new GovernedSkillIntegrityError("lock-unavailable");
  return new GovernedSkillIntegrityError("invalid-lock");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
