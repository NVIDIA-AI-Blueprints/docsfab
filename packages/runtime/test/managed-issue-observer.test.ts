// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

import {
  createManagedIssueIdentity,
  createManagedIssueStateLookupV1,
  createRoadmapLedger,
  managedIssueTrackerObservationStateV1,
  observeManagedIssueTrackerV1,
  renderManagedIssueMarker,
  roadmapDigest,
  roadmapFindingFingerprint,
  sanitizeGitLabManagedIssue,
  type ManagedIssueHostProjectionV1,
  type RoadmapLedger,
} from "../src/roadmap/index.js";
import { internalIssueManagedIssueObservationCapability } from "../src/roadmap/managed-issue-observer-authority-internal.js";

const PROJECT = {
  provider: "gitlab",
  host: "gitlab.example.com",
  fullPath: "group/project",
  projectId: 42,
};
const OBSERVED_AT = "2026-08-05T00:00:00.000Z";

describe("managed issue tracker observation", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("sanitizes GitLab prose to marker-only host projection", () => {
    const identity = createManagedIssueIdentity(ledger(), "finding:one");
    const projected = sanitizeGitLabManagedIssue({
      iid: 7,
      state: "opened",
      updated_at: OBSERVED_AT,
      title: "Human-edited sensitive title",
      description: `Human-edited sensitive prose\n\n${renderManagedIssueMarker(identity.marker)}`,
      labels: ["docsfab-roadmap::managed", "gate::g3"],
      milestone: null,
    });
    expect(projected.marker).toEqual(identity.marker);
    expect(JSON.stringify(projected)).not.toContain("sensitive");
  });

  it("projects only marker identity and attaches no caller-authored state", () => {
    const identity = createManagedIssueIdentity(ledger(), "finding:one");
    const issues: ManagedIssueHostProjectionV1[] = [hostIssue({ marker: identity.marker })];
    const observation = observe(issues);
    const state = managedIssueTrackerObservationStateV1(observation);

    expect(observation).toMatchObject({ readOnly: true });
    expect("authorization" in observation).toBe(false);
    expect(state.reconcilerIssues[0]).toEqual({
      iid: 7,
      state: "opened",
      title: "Managed issue",
      description: renderManagedIssueMarker(identity.marker),
      labels: [
        "docsfab-roadmap::managed",
        "gate::g3",
        "lifecycle::ready",
        "priority::p1",
        "workflow::documentation-health",
      ],
    });
    expect(state.tracker[0]).toMatchObject({ issueIid: 7, state: "opened" });
  });

  it("keeps unmarked issues human-owned even when labels look managed", () => {
    const observation = observe([hostIssue({ marker: null })]);
    expect(managedIssueTrackerObservationStateV1(observation).reconcilerIssues[0]).toMatchObject({
      title: "Human-owned issue",
      description: "",
    });
  });

  it("rejects caller-authored capabilities, copied observations, duplicates, and credentials", () => {
    const issues = [hostIssue({ marker: null })];
    expect(() =>
      observeManagedIssueTrackerV1({
        project: PROJECT,
        observedAt: OBSERVED_AT,
        issues,
        sourceCapability: { kind: "docsfab-managed-issue-observation-capability" },
        stateLookup: createManagedIssueStateLookupV1([]),
      }),
    ).toThrow(/invalid-source/u);

    const authentic = observe(issues);
    expect(() => managedIssueTrackerObservationStateV1({ ...authentic })).toThrow(
      /invalid-observation/u,
    );
    expect(() => observe([issues[0]!, issues[0]!])).toThrow(/invalid-observation/u);
    // DocsFab's own configured credential refuses; it looks like no credential.
    expect(() =>
      observe([hostIssue({ marker: null, labels: [plantConfiguredCredential()] })]),
    ).toThrow(/invalid-observation/u);
    clearPlantedCredential();
    // A token-shaped label is observed and recorded against its issue (#1807).
    const shaped = collectCredentialFindings(() =>
      observe([hostIssue({ marker: null, labels: ["glpat-1234567890abcdefghijk"] })]),
    );
    expect(shaped.findings).toEqual([
      {
        code: "credential-like-content",
        location: "managed-issue:7",
        rule: "credential.gitlab-token",
      },
    ]);
    expect(JSON.stringify(shaped.findings)).not.toContain("1234567890abcdefghijk");
  });
});

function observe(issues: ManagedIssueHostProjectionV1[]) {
  const sourceDigest = roadmapDigest({ project: PROJECT, observedAt: OBSERVED_AT, issues });
  return observeManagedIssueTrackerV1({
    project: PROJECT,
    observedAt: OBSERVED_AT,
    issues,
    sourceCapability: internalIssueManagedIssueObservationCapability(sourceDigest),
    stateLookup: createManagedIssueStateLookupV1([]),
  });
}

function hostIssue(overrides: Partial<ManagedIssueHostProjectionV1>): ManagedIssueHostProjectionV1 {
  return {
    iid: 7,
    state: "opened",
    updatedAt: OBSERVED_AT,
    identityDigest: "7".repeat(64),
    marker: null,
    labels: [
      "docsfab-roadmap::managed",
      "gate::g3",
      "lifecycle::ready",
      "priority::p1",
      "workflow::documentation-health",
    ],
    materialEvidenceDigests: [],
    links: [],
    ...overrides,
  };
}

function ledger(): RoadmapLedger {
  const material = {
    boundaryId: "boundary:managed-observer",
    category: "maturity-g3",
    severity: "p1" as const,
    affectedPaths: ["docs/guide.md"],
    evidenceIds: [`evidence:${"d".repeat(64)}`],
    materialEvidenceDigest: "e".repeat(64),
  };
  return createRoadmapLedger({
    id: "ledger:managed-observer",
    repository: { revision: "a".repeat(40), contentDigest: "b".repeat(64) },
    project: PROJECT,
    boundary: {
      id: "boundary:managed-observer",
      mode: "documentation-health",
      observedAt: OBSERVED_AT,
      queryDigest: "c".repeat(64),
    },
    trackerObservedAt: OBSERVED_AT,
    tracker: [],
    evidence: [
      {
        id: `evidence:${"d".repeat(64)}`,
        kind: "validation",
        digest: "e".repeat(64),
        repositoryRevision: "a".repeat(40),
        path: "docs/guide.md",
      },
    ],
    findings: [
      {
        id: "finding:one",
        ...material,
        fingerprint: roadmapFindingFingerprint(material),
        source: "documentation-health",
        disposition: "repair",
        lifecycle: "observed",
        dependsOnFindingIds: [],
      },
    ],
    workstreams: [
      {
        id: "workstream:one",
        findingIds: ["finding:one"],
        dependsOnWorkstreamIds: [],
        collidesWithWorkstreamIds: [],
        executionOrder: 1,
        state: "ready",
      },
    ],
    dedup: [{ findingId: "finding:one", decision: "create", rationaleCode: "new" }],
    transitions: [],
    sweeps: [],
    closeouts: [],
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
  });
}
