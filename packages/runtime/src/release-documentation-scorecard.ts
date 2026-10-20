// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "./content-ir/canonical.js";
import type { ReleaseDocumentationReadinessFindingState } from "./release-documentation-readiness.js";
import type { ReleaseDocumentationExpectedRepositoryV1 } from "./release-documentation-rubric.js";
import type { RepositoryDiscoveryInventoryV1 } from "./repository/inventory.js";
import { parseReleaseDocumentationReadinessRunRecord } from "./scorecard-record.js";

export interface ReleaseDocumentationReadinessScorecardV1 {
  schemaVersion: 1;
  kind: "docsfab-release-documentation-readiness-scorecard";
  workflow: "release-documentation-readiness";
  repositoryRevision: string;
  repositoryIdentitySha256: string;
  repositoryInventorySha256: string;
  productDisposition: "ready" | "not-ready" | "inconclusive" | "blocked";
  findingCounts: Record<ReleaseDocumentationReadinessFindingState, number>;
  workUnitCount: number;
  downstreamConsumers: ["#43", "#46"];
  trackerMutation: "not-authorized";
  artifactSha256: string;
  scorecardSha256: string;
}

export function createReleaseDocumentationReadinessScorecard(
  value: unknown,
  expectedRepository: Readonly<ReleaseDocumentationExpectedRepositoryV1>,
  trustedInventory: RepositoryDiscoveryInventoryV1,
): ReleaseDocumentationReadinessScorecardV1 {
  const record = parseReleaseDocumentationReadinessRunRecord(
    value,
    expectedRepository,
    trustedInventory,
  );
  const artifact = record.releaseDocumentationReadiness!;
  const states: ReleaseDocumentationReadinessFindingState[] = [
    "covered",
    "missing",
    "needs-human-decision",
    "inconclusive",
    "blocked",
  ];
  const findingCounts = Object.fromEntries(
    states.map((state) => [
      state,
      artifact.findings.filter((finding) => finding.state === state).length,
    ]),
  ) as Record<ReleaseDocumentationReadinessFindingState, number>;
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-release-documentation-readiness-scorecard" as const,
    workflow: "release-documentation-readiness" as const,
    repositoryRevision: artifact.repositoryRevision,
    repositoryIdentitySha256: artifact.repositoryIdentitySha256,
    repositoryInventorySha256: artifact.repositoryInventorySha256,
    productDisposition: artifact.disposition,
    findingCounts,
    workUnitCount: artifact.workUnits.length,
    downstreamConsumers: artifact.downstreamConsumers,
    trackerMutation: artifact.trackerMutation,
    artifactSha256: artifact.artifactSha256,
  };
  return Object.freeze({ ...body, scorecardSha256: canonicalDigest(body) });
}

export function renderReleaseDocumentationReadinessScorecard(
  value: unknown,
  expectedRepository: Readonly<ReleaseDocumentationExpectedRepositoryV1>,
  trustedInventory: RepositoryDiscoveryInventoryV1,
): string {
  const scorecard = createReleaseDocumentationReadinessScorecard(
    value,
    expectedRepository,
    trustedInventory,
  );
  const counts = Object.entries(scorecard.findingCounts)
    .map(([state, count]) => `${state}: ${count}`)
    .join(", ");
  return [
    "## Public release-documentation readiness",
    "",
    `- Product disposition: ${scorecard.productDisposition}`,
    `- Coverage: ${counts}`,
    `- Proposed work units: ${scorecard.workUnitCount}`,
    `- Downstream consumers: ${scorecard.downstreamConsumers.join(", ")}`,
    `- Tracker mutation: ${scorecard.trackerMutation}`,
    `- Inventory SHA-256: ${scorecard.repositoryInventorySha256}`,
    `- Artifact SHA-256: ${scorecard.artifactSha256}`,
    `- Scorecard SHA-256: ${scorecard.scorecardSha256}`,
  ].join("\n");
}
