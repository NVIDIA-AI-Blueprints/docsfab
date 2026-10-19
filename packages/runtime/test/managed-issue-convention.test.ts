// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

import type {
  ManagedIssueIdentityV1,
  ManagedIssueLabels,
  ManagedIssueMarkerV1,
  ManagedIssueObservation,
  RoadmapFinding,
  RoadmapFindingMaterial,
  RoadmapHealthPlanningInput,
  RoadmapLedger,
  RoadmapMutationOperationV2Input,
} from "../src/roadmap/index.js";
import {
  assertManagedIssueMarkerMatchesIdentity,
  createManagedIssueIdentity,
  createManagedIssueMutationIdentityV2,
  createManagedIssueMutationMaterialEvidenceV1,
  createManagedIssueStateBinding,
  createRoadmapLedger,
  createRoadmapMutationPlanV2,
  extractManagedIssueMarker,
  managedIssueFindingFingerprintV1,
  managedIssueLabelNames,
  managedIssueTitle,
  ManagedIssueContractError,
  MANAGED_ISSUE_DISPOSITIONS,
  MANAGED_ISSUE_GATES,
  MANAGED_ISSUE_HUMAN_OWNED_FIELDS,
  MANAGED_ISSUE_KINDS,
  MANAGED_ISSUE_LIFECYCLES,
  MANAGED_ISSUE_PRIORITIES,
  MANAGED_ISSUE_WORKFLOWS,
  reconcileManagedIssue,
  mutationMaterialBytes,
  mutationMaterialDigest,
  renderManagedIssueDraft,
  renderManagedIssueMarker,
  roadmapCanonicalJson,
  roadmapDigest,
  roadmapFindingFingerprint,
  ROADMAP_LIFECYCLE_STATES,
  planRoadmap,
  decodeRoadmapPlanningInput,
  validateManagedIssueHierarchyLink,
  validateManagedIssueLabels,
  validateManagedIssueMarker,
  validateManagedIssueMutationIdentityV2,
  validateManagedIssueStateBinding,
} from "../src/roadmap/index.js";
import {
  internalCreateRoadmapPlanningHostAuthority,
  internalIssueRoadmapPlanningSourceCapability,
} from "../src/roadmap/planning-authority-internal.js";

const REVISION = "a".repeat(40);
const CONTENT = "b".repeat(64);
const T0 = "2026-08-05T00:00:00.000Z";
const T1 = "2026-08-05T00:01:00.000Z";
const TRACKER_45 = "4".repeat(64);
const EVIDENCE_ONE = semanticEvidenceId("candidate:one");
const EVIDENCE_TWO = semanticEvidenceId("candidate:two");
const LABELS: ManagedIssueLabels = {
  gate: "g3",
  workflow: "documentation-health",
  priority: "p1",
  lifecycle: "ready",
};
const CONVENTION = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/runtime-evaluation/roadmap/managed-issue-convention-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  schemaVersion: number;
  requiredLabels: {
    managed: string;
    gate: string[];
    workflow: string[];
    priority: string[];
    lifecycle: string[];
  };
  humanOwnedFields: string[];
  reconciliationDispositions: string[];
  nativeEpicRequired: boolean;
};

describe("managed issue convention", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("keeps the checked-in v1 convention synchronized with executable constants", () => {
    expect(CONVENTION).toMatchObject({
      schemaVersion: 1,
      requiredLabels: {
        managed: "docsfab-roadmap::managed",
        gate: MANAGED_ISSUE_GATES,
        workflow: MANAGED_ISSUE_WORKFLOWS,
        priority: MANAGED_ISSUE_PRIORITIES,
        lifecycle: MANAGED_ISSUE_LIFECYCLES,
      },
      humanOwnedFields: MANAGED_ISSUE_HUMAN_OWNED_FIELDS,
      reconciliationDispositions: MANAGED_ISSUE_DISPOSITIONS,
      nativeEpicRequired: false,
    });
  });

  it("keeps one production-planned semantic defect stable across real revision and evidence changes", () => {
    const first = productionPlan(
      productionHealthInput("1".repeat(40), "2".repeat(64), "3".repeat(64), T0),
    );
    const second = productionPlan(
      productionHealthInput("4".repeat(40), "5".repeat(64), "6".repeat(64), T1),
    );
    const firstIdentity = createManagedIssueIdentity(first.ledger, first.ledger.findings[0]!.id);
    const secondIdentity = createManagedIssueIdentity(second.ledger, second.ledger.findings[0]!.id);

    expect(first.ledger.findings[0]!.fingerprint).not.toBe(second.ledger.findings[0]!.fingerprint);
    expect(firstIdentity.findingId).not.toBe(secondIdentity.findingId);
    expect(first.ledger.findings[0]!.evidenceIds).toEqual(second.ledger.findings[0]!.evidenceIds);
    expect(first.ledger.findings[0]!.evidenceIds[0]).toMatch(/^evidence:[a-f0-9]{64}$/u);
    expect(firstIdentity.marker).toEqual(secondIdentity.marker);
    expect(firstIdentity.repositoryStateDigest).not.toBe(secondIdentity.repositoryStateDigest);
    expect(createManagedIssueStateBinding(firstIdentity).digest).not.toBe(
      createManagedIssueStateBinding(secondIdentity).digest,
    );
    const migration = reconcileManagedIssue({
      identity: secondIdentity,
      observations: [observed(firstIdentity, 105)],
      desiredLabels: LABELS,
    });
    expect(migration).toMatchObject({
      disposition: "migration",
      issueIid: 105,
      reasonCode: "migration-required-host-authentication",
    });
    expect(migration.patch).toBeUndefined();
    expect(migration.nextStateBinding).toBeUndefined();
  });

  it("renders all issue-based kinds with the versioned title, labels, sections, and content-free marker", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    for (const kind of ["saga", "epic", "task", "investigation"] as const) {
      const draft = renderManagedIssueDraft(template(identity, kind));
      expect(draft.title).toBe(
        `[DocsFab][${kind[0]!.toUpperCase()}${kind.slice(1)}] Repair architecture docs`,
      );
      expect(draft.labels).toEqual([
        "docsfab-roadmap::managed",
        "gate::g3",
        "workflow::documentation-health",
        "priority::p1",
        "lifecycle::ready",
      ]);
      for (const heading of [
        "Evidence",
        "Tested revision",
        "Rationale",
        "Audience impact",
        "Path scope",
        "Workflow",
        "Acceptance",
        "Verification",
        "Dependencies",
        "Required human input",
      ])
        expect(draft.description).toContain(`## ${heading}`);
      expect(extractManagedIssueMarker(draft.description)).toEqual(identity.marker);
      const markerText = renderManagedIssueMarker(identity.marker);
      expect(markerText).not.toContain("group/docsfab");
      expect(markerText).not.toContain("tracker.example.com");
      expect(markerText).not.toContain("docs/architecture.md");
      expect(markerText).not.toContain(REVISION);
      expect(markerText).not.toContain("Repair architecture docs");
    }
  });

  it("reconciles after arbitrary title and prose edits using only the exact marker", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    const issue = observed(identity, 105, {
      title: "A human rewrote this title completely",
      description: `Human-owned prose, reordered and rewritten.\n\n${renderManagedIssueMarker(identity.marker)}\n\nMore human prose.`,
      labels: [...managedIssueLabelNames(LABELS), "team::docs", "customer-visible"],
      assigneeIds: [7],
      milestoneIid: 3,
      dueDate: "2026-08-31",
      weight: 8,
      confidential: true,
    });
    const reconciled = reconcileManagedIssue({
      identity,
      observations: [issue],
      desiredLabels: LABELS,
    });
    expect(reconciled).toMatchObject({
      disposition: "reuse",
      issueIid: 105,
      reasonCode: "active-match",
    });
    expect(reconciled.patch).toBeUndefined();
  });

  it("never adopts or mutates an unmarked lookalike", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    const lookalike = observed(identity, 88, {
      title: managedIssueTitle("task", "Repair architecture docs"),
      description: "Same words and evidence, but human-owned.",
      labels: managedIssueLabelNames(LABELS),
    });
    const reconciled = reconcileManagedIssue({
      identity,
      observations: [lookalike],
      desiredLabels: LABELS,
    });
    expect(reconciled).toMatchObject({
      disposition: "create",
      ignoredUnmarkedIssueIids: [88],
      conflictingIssueIids: [],
      reasonCode: "no-marked-match",
    });
    expect(reconciled.nextStateBinding).toEqual(createManagedIssueStateBinding(identity));
  });

  it("fails closed when one finding has multiple active managed matches", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    const reconciled = reconcileManagedIssue({
      identity,
      observations: [observed(identity, 10), observed(identity, 11, { title: "human wording" })],
      desiredLabels: LABELS,
    });
    expect(reconciled).toMatchObject({
      disposition: "conflict",
      conflictingIssueIids: [10, 11],
      reasonCode: "multiple-active-matches",
    });
  });

  it("rejects marker tamper, full rehash, and cross-repository/revision/finding substitution", () => {
    const ledger = makeLedger();
    const identity = createManagedIssueIdentity(ledger, "finding:one");
    const tampered = { ...identity.marker, findingFingerprint: "f".repeat(64) };
    expectError(() => validateManagedIssueMarker(tampered), "digest-mismatch");

    const fullyRehashed = redigestMarker(tampered);
    expect(validateManagedIssueMarker(fullyRehashed)).toEqual(fullyRehashed);
    expectError(
      () => assertManagedIssueMarkerMatchesIdentity(fullyRehashed, identity),
      "finding-mismatch",
    );

    const otherFinding = createManagedIssueIdentity(ledger, "finding:two");
    expectError(
      () => assertManagedIssueMarkerMatchesIdentity(otherFinding.marker, identity),
      "finding-mismatch",
    );

    const otherRepo = createManagedIssueIdentity(makeLedger({ projectId: 422_999 }), "finding:one");
    expectError(
      () => assertManagedIssueMarkerMatchesIdentity(otherRepo.marker, identity),
      "repository-mismatch",
    );

    const renamedRepo = createManagedIssueIdentity(
      makeLedger({ fullPath: "group/renamed-docsfab" }),
      "finding:one",
    );
    expect(renamedRepo.marker).toEqual(identity.marker);

    const otherRevision = createManagedIssueIdentity(
      makeLedger({ revision: "c".repeat(40) }),
      "finding:one",
    );
    expect(otherRevision.marker).toEqual(identity.marker);
    expectError(
      () =>
        validateManagedIssueStateBinding(createManagedIssueStateBinding(otherRevision), identity),
      "repository-mismatch",
    );
    const prior = reconcileManagedIssue({
      identity,
      observations: [observed(otherRevision, 55)],
      desiredLabels: LABELS,
    });
    expect(prior).toMatchObject({
      disposition: "migration",
      issueIid: 55,
      reasonCode: "migration-required-host-authentication",
    });
    expect(prior.patch).toBeUndefined();
    expect(prior.nextStateBinding).toBeUndefined();
  });

  it("classifies prior state as migration-required without granting mutation authority", () => {
    const previousLedger = makeLedger({ revision: "c".repeat(40) });
    const currentLedger = makeLedger();
    const previous = createManagedIssueIdentity(previousLedger, "finding:one");
    const current = createManagedIssueIdentity(currentLedger, "finding:one");
    expect(previous.marker).toEqual(current.marker);
    const issue = observed(previous, 105, {
      title: "human title",
      description: `before human prose\n${renderManagedIssueMarker(previous.marker)}\nafter human prose`,
      labels: [...managedIssueLabelNames({ ...LABELS, lifecycle: "filed" }), "team::docs"],
      assigneeIds: [5],
      milestoneIid: 3,
      dueDate: "2026-09-01",
      weight: 13,
      confidential: true,
    });
    const migration = reconcileManagedIssue({
      identity: current,
      observations: [issue],
      desiredLabels: LABELS,
    });
    expect(migration).toMatchObject({
      disposition: "migration",
      issueIid: 105,
      reasonCode: "migration-required-host-authentication",
    });
    expect(migration.patch).toBeUndefined();
    expect(migration.nextStateBinding).toBeUndefined();

    const duplicateAcrossRevisions = reconcileManagedIssue({
      identity: current,
      observations: [issue, observed(current, 106)],
      desiredLabels: LABELS,
    });
    expect(duplicateAcrossRevisions).toMatchObject({
      disposition: "conflict",
      conflictingIssueIids: [105, 106],
      reasonCode: "multiple-active-matches",
    });

    // A structurally valid rehash remains inert caller data: it can request
    // host migration review, but can never authorize a patch or state advance.
    const clonedBinding = {
      ...structuredClone(issue.stateBinding!),
      ledgerDigest: current.ledgerDigest,
    };
    clonedBinding.digest = roadmapDigest(clonedBinding);
    const clonedIssue = { ...issue, stateBinding: clonedBinding };
    const cloned = reconcileManagedIssue({
      identity: current,
      observations: [clonedIssue],
      desiredLabels: LABELS,
    });
    expect(cloned).toMatchObject({ disposition: "migration", issueIid: 105 });
    expect(cloned.patch).toBeUndefined();
    expect(cloned.nextStateBinding).toBeUndefined();
  });

  it("preserves human labels and exposes only controlled label repair", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    const issue = observed(identity, 105, {
      labels: [
        "docsfab-roadmap::managed",
        "gate::g2",
        "workflow::documentation-health",
        "priority::p2",
        "lifecycle::filed",
        "Docs Team / API",
        "客户文档",
        "UPPER CASE",
        "docsfab-roadmap-notes",
      ],
    });
    const reconciled = reconcileManagedIssue({
      identity,
      observations: [issue],
      desiredLabels: LABELS,
    });
    expect(reconciled.patch).toEqual({
      issueIid: 105,
      labels: [
        ...managedIssueLabelNames(LABELS),
        "Docs Team / API",
        "客户文档",
        "UPPER CASE",
        "docsfab-roadmap-notes",
      ].sort((left, right) => left.localeCompare(right, "en")),
    });
    expect(reconciled.patch).not.toHaveProperty("description");
    for (const unsafe of [
      "Gate::g3",
      "workflow::custom",
      "docsfab-roadmap::custom",
      "DocsFab-Roadmap::managed",
      "team\nops",
      // DocsFab's own configured credential; it looks like no credential.
      plantConfiguredCredential(),
    ]) {
      expectError(
        () =>
          reconcileManagedIssue({
            identity,
            observations: [
              observed(identity, 106, { labels: [...managedIssueLabelNames(LABELS), unsafe] }),
            ],
            desiredLabels: LABELS,
          }),
        "invalid-value",
      );
    }
    clearPlantedCredential();
    // A label that only starts like an issuer token is kept and recorded (#1807).
    const { result, findings } = collectCredentialFindings(() =>
      reconcileManagedIssue({
        identity,
        observations: [
          observed(identity, 106, { labels: [...managedIssueLabelNames(LABELS), "glpat-secret"] }),
        ],
        desiredLabels: LABELS,
      }),
    );
    expect(result).toMatchObject({ disposition: "reuse", issueIid: 106 });
    expect(findings.map((finding) => finding.rule)).toEqual(["credential.gitlab-token"]);
    expect(findings[0]!.location).toMatch(/^managed-issue:\$/u);
  });

  it("represents duplicate, superseded, and manually detached issues without creating replacements", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    for (const [lifecycle, disposition] of [
      ["duplicate", "duplicate"],
      ["superseded", "superseded"],
      ["manually-detached", "manually-detached"],
    ] as const) {
      const issue = observed(identity, 105, {
        labels: managedIssueLabelNames({ ...LABELS, lifecycle }),
      });
      expect(
        reconcileManagedIssue({ identity, observations: [issue], desiredLabels: LABELS })
          .disposition,
      ).toBe(disposition);
    }
    const labelDetached = observed(identity, 106, {
      labels: managedIssueLabelNames(LABELS).filter(
        (label) => label !== "docsfab-roadmap::managed",
      ),
    });
    expect(
      reconcileManagedIssue({ identity, observations: [labelDetached], desiredLabels: LABELS })
        .disposition,
    ).toBe("manually-detached");
  });

  it("never migrates or reactivates a prior-revision terminal issue", () => {
    const priorLedger = makeLedger({ revision: "c".repeat(40) });
    const currentLedger = makeLedger();
    const prior = createManagedIssueIdentity(priorLedger, "finding:one");
    const current = createManagedIssueIdentity(currentLedger, "finding:one");
    for (const [lifecycle, disposition, iid] of [
      ["duplicate", "duplicate", 201],
      ["superseded", "superseded", 202],
      ["closed", "reuse", 203],
      ["manually-detached", "manually-detached", 204],
      ["blocked", "reuse", 205],
    ] as const) {
      const issue = observed(prior, iid, {
        labels: managedIssueLabelNames({ ...LABELS, lifecycle }),
      });
      const result = reconcileManagedIssue({
        identity: current,
        observations: [issue],
        desiredLabels: LABELS,
      });
      expect(result).toMatchObject({ disposition, issueIid: issue.iid });
      expect(result.patch).toBeUndefined();
      expect(result.nextStateBinding).toBeUndefined();
    }
  });

  it("rejects unsafe, non-canonical, duplicate, and unknown marker content", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    const canonical = renderManagedIssueMarker(identity.marker);
    expectError(() => extractManagedIssueMarker(`${canonical}\n${canonical}`), "multiple-markers");
    expectError(
      () =>
        extractManagedIssueMarker(
          `<!-- docsfab-managed-issue:{"schemaVersion":1,"repositoryKeyDigest":"/Users/alice/repo","findingFingerprint":"${"b".repeat(64)}","identityDigest":"${"c".repeat(64)}"} -->`,
        ),
      "invalid-value",
    );
    const withUnknown = { ...identity.marker, prompt: "model output" };
    expectError(() => validateManagedIssueMarker(withUnknown), "unknown-field");
    const pretty = `<!-- docsfab-managed-issue:${JSON.stringify(identity.marker, null, 2)} -->`;
    expectError(() => extractManagedIssueMarker(pretty), "unsafe-content");
  });

  it("binds the marker to the exact executable v2 create identity", () => {
    const ledger = makeLedger();
    const identity = createManagedIssueIdentity(ledger, "finding:one");
    const { plan, createMaterial, updateMaterial } = makePlan(ledger);
    const operation = plan.operations.find(
      (candidate) => candidate.key === "operation:create-managed",
    )!;
    const draft = renderManagedIssueDraft(createMaterial.template);
    const expectedCreateMaterial = {
      operationKey: operation.key,
      action: "create-issue" as const,
      title: draft.title,
      description: draft.description,
      labels: draft.labels,
    };
    expect(operation.materialDigest).toBe(mutationMaterialDigest(expectedCreateMaterial));
    expect(operation.materialBytes).toBe(mutationMaterialBytes(expectedCreateMaterial));
    const binding = createManagedIssueMutationIdentityV2(
      plan,
      ledger,
      operation.key,
      identity,
      createMaterial,
    );
    expect(
      validateManagedIssueMutationIdentityV2(
        JSON.parse(roadmapCanonicalJson(binding)),
        plan,
        ledger,
        operation.key,
        identity,
        createMaterial,
      ),
    ).toEqual(binding);

    const substitutedPlan = {
      ...plan,
      operations: [{ ...operation, materialDigest: "f".repeat(64) }],
    };
    expect(() =>
      validateManagedIssueMutationIdentityV2(
        binding,
        substitutedPlan,
        ledger,
        operation.key,
        identity,
        createMaterial,
      ),
    ).toThrow(/Roadmap contract validation failed/);
    const otherIdentity = createManagedIssueIdentity(ledger, "finding:two");
    expectError(
      () =>
        validateManagedIssueMutationIdentityV2(
          binding,
          plan,
          ledger,
          operation.key,
          otherIdentity,
          createMaterial,
        ),
      "finding-mismatch",
    );

    const update = plan.operations.find(
      (candidate) => candidate.key === "operation:update-managed",
    )!;
    const expectedUpdateMaterial = {
      operationKey: update.key,
      action: "add-labels" as const,
      labels: ["priority::p1"],
    };
    expect(update.materialDigest).toBe(mutationMaterialDigest(expectedUpdateMaterial));
    expect(update.materialBytes).toBe(mutationMaterialBytes(expectedUpdateMaterial));
    const withHumanLabel = {
      ...updateMaterial,
      reconciliation: {
        ...updateMaterial.reconciliation,
        observations: [
          observed(identity, 45, {
            labels: [
              ...managedIssueLabelNames(LABELS).filter((label) => label !== "priority::p1"),
              "Docs Team / API",
            ],
          }),
        ],
      },
    };
    expect(createManagedIssueMutationMaterialEvidenceV1(withHumanLabel, ledger, identity)).toEqual(
      createManagedIssueMutationMaterialEvidenceV1(updateMaterial, ledger, identity),
    );
    const updateBinding = createManagedIssueMutationIdentityV2(
      plan,
      ledger,
      update.key,
      identity,
      updateMaterial,
    );
    expect(updateBinding).toMatchObject({
      operationKey: update.key,
      markerIdentityDigest: identity.marker.identityDigest,
      stateBindingDigest: createManagedIssueStateBinding(identity).digest,
    });
    expect(
      validateManagedIssueMutationIdentityV2(
        updateBinding,
        plan,
        ledger,
        update.key,
        identity,
        updateMaterial,
      ),
    ).toEqual(updateBinding);

    const changedTemplates: Array<{ template: unknown; code: ManagedIssueContractError["code"] }> =
      [
        {
          template: { ...createMaterial.template, summary: "Changed title material" },
          code: "mutation-mismatch",
        },
        {
          template: { ...createMaterial.template, rationale: "Changed prose material" },
          code: "mutation-mismatch",
        },
        {
          template: { ...createMaterial.template, pathScope: ["docs/other.md"] },
          code: "finding-mismatch",
        },
        {
          template: { ...createMaterial.template, labels: { ...LABELS, gate: "g4" as const } },
          code: "mutation-mismatch",
        },
        { template: { ...createMaterial.template, assigneeIds: [7] }, code: "unknown-field" },
        { template: { ...createMaterial.template, milestoneIid: 4 }, code: "unknown-field" },
        { template: { ...createMaterial.template, confidential: true }, code: "unknown-field" },
        { template: { ...createMaterial.template, parentIssueIid: 90 }, code: "mutation-mismatch" },
      ];
    for (const changed of changedTemplates) {
      expectError(
        () =>
          createManagedIssueMutationIdentityV2(plan, ledger, operation.key, identity, {
            kind: "create",
            operationKey: createMaterial.operationKey,
            template: changed.template as typeof createMaterial.template,
          }),
        changed.code,
      );
    }

    const expandedUpdate = { ...updateMaterial, labels: ["Human Label / API"] };
    expectError(
      () =>
        createManagedIssueMutationIdentityV2(
          plan,
          ledger,
          update.key,
          identity,
          expandedUpdate as typeof updateMaterial,
        ),
      "unknown-field",
    );
    expectError(
      () =>
        createManagedIssueMutationIdentityV2(plan, ledger, update.key, identity, {
          ...updateMaterial,
          reconciliation: { ...updateMaterial.reconciliation, title: "forged" },
        } as typeof updateMaterial),
      "unknown-field",
    );
  });

  it("uses standard issue IIDs for saga/epic/task hierarchy when native epics are absent", () => {
    expect(
      validateManagedIssueHierarchyLink({
        parentIssueIid: 90,
        parentKind: "saga",
        childIssueIid: 105,
        childKind: "epic",
      }),
    ).toEqual({ parentIssueIid: 90, parentKind: "saga", childIssueIid: 105, childKind: "epic" });
    expect(
      validateManagedIssueHierarchyLink({
        parentIssueIid: 105,
        parentKind: "epic",
        childIssueIid: 106,
        childKind: "task",
      }),
    ).toBeTruthy();
    expectError(
      () =>
        validateManagedIssueHierarchyLink({
          parentIssueIid: 105,
          parentKind: "epic",
          childIssueIid: 106,
          childKind: "epic",
        }),
      "invalid-value",
    );
  });

  it("rejects absolute paths, marker injection, secrets, and missing required template evidence", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    expectError(
      () =>
        renderManagedIssueDraft({ ...template(identity), pathScope: ["/Users/alice/repo/docs"] }),
      "unsafe-path",
    );
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), pathScope: ["docs/<!-- injected"] }),
      "unsafe-path",
    );
    expectError(
      () =>
        renderManagedIssueDraft({
          ...template(identity),
          rationale: `credential ${plantConfiguredCredential()}`,
        }),
      "unsafe-content",
    );
    clearPlantedCredential();
    // Prose that only looks like it names a credential renders, recorded (#1807).
    const shaped = collectCredentialFindings(() =>
      renderManagedIssueDraft({ ...template(identity), rationale: "credential glpat-secret" }),
    );
    expect(shaped.result.description).toContain("credential glpat-secret");
    expect(shaped.findings.map((finding) => finding.rule)).toEqual(["credential.gitlab-token"]);
    expectError(
      () =>
        renderManagedIssueDraft({
          ...template(identity),
          rationale: `forged ${renderManagedIssueMarker(identity.marker)}`,
        }),
      "unsafe-content",
    );
    expectError(() => managedIssueTitle("task", "first line\nsecond line"), "unsafe-content");
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), evidence: [] }),
      "invalid-value",
    );
  });

  it("rejects proxies, accessors, custom prototypes, hidden fields, symbols, and cycles without executing traps", () => {
    const ledger = makeLedger();
    const identity = createManagedIssueIdentity(ledger, "finding:one");
    let trapCalls = 0;
    const hostileMarker = trappedProxy({ ...identity.marker }, () => {
      trapCalls += 1;
    });
    expectError(() => validateManagedIssueMarker(hostileMarker), "invalid-type");
    expect(trapCalls).toBe(0);

    const accessorIdentity = { ...identity } as Record<string, unknown>;
    Object.defineProperty(accessorIdentity, "findingId", {
      enumerable: true,
      get() {
        trapCalls += 1;
        throw new Error("getter must remain inert");
      },
    });
    expectError(
      () => createManagedIssueStateBinding(accessorIdentity as unknown as ManagedIssueIdentityV1),
      "invalid-type",
    );
    expect(trapCalls).toBe(0);

    const nestedLabels = trappedProxy({ ...LABELS }, () => {
      trapCalls += 1;
    });
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), labels: nestedLabels }),
      "invalid-type",
    );
    expect(trapCalls).toBe(0);

    const customMarker = Object.assign(Object.create({ inherited: true }), identity.marker);
    expectError(() => validateManagedIssueMarker(customMarker), "invalid-type");
    const hiddenMarker = { ...identity.marker };
    Object.defineProperty(hiddenMarker, "hidden", { value: "forged", enumerable: false });
    expectError(() => validateManagedIssueMarker(hiddenMarker), "unknown-field");
    const symbolMarker = { ...identity.marker, [Symbol("forged")]: true };
    expectError(() => validateManagedIssueMarker(symbolMarker), "unknown-field");

    const accessorLedger = structuredClone(ledger) as RoadmapLedger;
    Object.defineProperty(accessorLedger.project, "host", {
      enumerable: true,
      get() {
        trapCalls += 1;
        throw new Error("ledger getter must remain inert");
      },
    });
    expectError(() => createManagedIssueIdentity(accessorLedger, "finding:one"), "invalid-type");
    expect(trapCalls).toBe(0);

    const cyclicLedger = structuredClone(ledger) as RoadmapLedger & { cycle?: unknown };
    cyclicLedger.cycle = cyclicLedger;
    expectError(() => createManagedIssueIdentity(cyclicLedger, "finding:one"), "invalid-value");

    const hostileMaterial = trappedProxy(
      {
        kind: "create" as const,
        operationKey: "operation:create-managed",
        template: template(identity),
      },
      () => {
        trapCalls += 1;
      },
    );
    expectError(
      () => createManagedIssueMutationMaterialEvidenceV1(hostileMaterial, ledger, identity),
      "invalid-type",
    );
    expect(trapCalls).toBe(0);
  });

  it("preflights and validates every standalone finding field before fingerprinting", () => {
    const base = finding("finding:standalone", "docs/standalone.md", "d".repeat(64));
    const previouslyUnused = [
      "id",
      "boundaryId",
      "severity",
      "materialEvidenceDigest",
      "fingerprint",
      "disposition",
      "lifecycle",
      "dependsOnFindingIds",
    ] as const;
    let trapCalls = 0;
    const rootProxy = trappedProxy({ ...base }, () => {
      trapCalls += 1;
    });
    expectError(() => managedIssueFindingFingerprintV1(rootProxy), "invalid-type");
    expect(trapCalls).toBe(0);
    const customRoot = Object.assign(Object.create({ inherited: true }), base);
    expectError(() => managedIssueFindingFingerprintV1(customRoot), "invalid-type");

    for (const key of previouslyUnused) {
      const proxied = {
        ...base,
        [key]: trappedProxy({}, () => {
          trapCalls += 1;
        }),
      };
      expectError(
        () => managedIssueFindingFingerprintV1(proxied as unknown as RoadmapFinding),
        "invalid-type",
      );
      expect(trapCalls).toBe(0);

      const accessor = { ...base } as unknown as Record<string, unknown>;
      Object.defineProperty(accessor, key, {
        enumerable: true,
        get() {
          trapCalls += 1;
          throw new Error("finding getter must remain inert");
        },
      });
      expectError(
        () => managedIssueFindingFingerprintV1(accessor as unknown as RoadmapFinding),
        "invalid-type",
      );
      expect(trapCalls).toBe(0);

      const customValue = { ...base, [key]: Object.create({ inherited: true }) };
      expectError(
        () => managedIssueFindingFingerprintV1(customValue as unknown as RoadmapFinding),
        "invalid-type",
      );

      const cyclic = { ...base } as unknown as Record<string, unknown>;
      cyclic[key] = cyclic;
      expectError(
        () => managedIssueFindingFingerprintV1(cyclic as unknown as RoadmapFinding),
        "invalid-value",
      );
    }

    for (const [key, value, code] of [
      ["id", 7, "invalid-type"],
      ["boundaryId", true, "invalid-type"],
      ["severity", "p9", "invalid-value"],
      ["materialEvidenceDigest", "not-a-digest", "invalid-value"],
      ["fingerprint", "not-a-digest", "invalid-value"],
      ["disposition", "invented", "invalid-value"],
      ["lifecycle", "invented", "invalid-value"],
      ["dependsOnFindingIds", [7], "invalid-type"],
    ] as const) {
      expectError(
        () =>
          managedIssueFindingFingerprintV1({
            ...base,
            [key]: value,
          } as unknown as RoadmapFinding),
        code,
      );
    }

    const mutablePublicLifecycles = ROADMAP_LIFECYCLE_STATES as unknown as string[];
    const originalLifecycleCount = mutablePublicLifecycles.length;
    try {
      mutablePublicLifecycles.push("forged-public-lifecycle");
      expect(ROADMAP_LIFECYCLE_STATES).toContain("forged-public-lifecycle");
      expectError(
        () =>
          managedIssueFindingFingerprintV1({
            ...base,
            lifecycle: "forged-public-lifecycle",
          } as unknown as RoadmapFinding),
        "invalid-value",
      );
    } finally {
      mutablePublicLifecycles.length = originalLifecycleCount;
    }
    expect(managedIssueFindingFingerprintV1(base)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("freezes exported convention authority and preserves terminal eligibility after mutation attempts", () => {
    const exportedAuthority = [
      MANAGED_ISSUE_KINDS,
      MANAGED_ISSUE_GATES,
      MANAGED_ISSUE_WORKFLOWS,
      MANAGED_ISSUE_PRIORITIES,
      MANAGED_ISSUE_LIFECYCLES,
      MANAGED_ISSUE_DISPOSITIONS,
      MANAGED_ISSUE_HUMAN_OWNED_FIELDS,
    ] as const;
    for (const values of exportedAuthority) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(() => (values as unknown as string[]).push("forged")).toThrow(TypeError);
      expect(values).not.toContain("forged");
    }
    expect(() => {
      (MANAGED_ISSUE_LIFECYCLES as unknown as string[])[1] = "blocked";
    }).toThrow(TypeError);
    expectError(() => validateManagedIssueLabels({ ...LABELS, gate: "g9" }), "invalid-value");
    expectError(
      () => validateManagedIssueLabels({ ...LABELS, workflow: "forged" }),
      "invalid-value",
    );
    expectError(() => validateManagedIssueLabels({ ...LABELS, priority: "p9" }), "invalid-value");
    expectError(
      () => validateManagedIssueLabels({ ...LABELS, lifecycle: "forged" }),
      "invalid-value",
    );
    expectError(() => managedIssueTitle("forged" as "task", "Still rejected"), "invalid-value");

    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    const ready = reconcileManagedIssue({
      identity,
      observations: [observed(identity, 1, { labels: managedIssueLabelNames(LABELS) })],
      desiredLabels: LABELS,
    });
    expect(ready).toMatchObject({ disposition: "reuse", reasonCode: "active-match" });
    const blocked = reconcileManagedIssue({
      identity,
      observations: [
        observed(identity, 2, {
          labels: managedIssueLabelNames({ ...LABELS, lifecycle: "blocked" }),
        }),
      ],
      desiredLabels: LABELS,
    });
    expect(blocked).toMatchObject({ disposition: "reuse", reasonCode: "closed-or-terminal-match" });
    expect(blocked.patch).toBeUndefined();
  });

  it("snapshots only bounded dense data arrays and keeps every rendered required section nonempty", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    let trapCalls = 0;
    const proxied = trappedProxy([EVIDENCE_ONE], () => {
      trapCalls += 1;
    });
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), evidence: proxied }),
      "invalid-type",
    );
    expect(trapCalls).toBe(0);

    const accessorElement: string[] = [];
    Object.defineProperty(accessorElement, "0", {
      enumerable: true,
      get() {
        trapCalls += 1;
        throw new Error("array getter must remain inert");
      },
    });
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), evidence: accessorElement }),
      "invalid-type",
    );
    expect(trapCalls).toBe(0);

    const sparse = [EVIDENCE_ONE];
    sparse.length = 2;
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), evidence: sparse }),
      "unknown-field",
    );
    const hidden = [EVIDENCE_ONE];
    Object.defineProperty(hidden, "0", { value: EVIDENCE_ONE, enumerable: false });
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), evidence: hidden }),
      "invalid-type",
    );
    const symbolic = [EVIDENCE_ONE] as string[] & { [key: symbol]: boolean };
    symbolic[Symbol("forged")] = true;
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), evidence: symbolic }),
      "unknown-field",
    );
    const huge: string[] = [];
    huge.length = 65;
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), evidence: huge }),
      "invalid-value",
    );

    expectError(
      () => renderManagedIssueDraft({ ...template(identity), acceptance: [""] }),
      "invalid-value",
    );
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), verification: [] }),
      "invalid-value",
    );
    expectError(
      () => renderManagedIssueDraft({ ...template(identity), pathScope: [""] }),
      "invalid-value",
    );
    const withExplicitNone = renderManagedIssueDraft({
      ...template(identity),
      dependencies: [],
      requiredHumanInput: [],
    });
    expect(withExplicitNone.description).toContain("## Dependencies\n\n- None.");
    expect(withExplicitNone.description).toContain("## Required human input\n\n- [ ] None.");
  });

  it("accepts each documented bounded maximum and the full authoritative tracker scan", () => {
    const identity = createManagedIssueIdentity(makeLedger(), "finding:one");
    const maxTemplate = renderManagedIssueDraft({
      ...template(identity),
      evidence: Array.from({ length: 64 }, (_, index) => `evidence:item-${index}`),
      pathScope: Array.from({ length: 256 }, (_, index) => `docs/file-${index}.md`),
      acceptance: Array.from({ length: 128 }, (_, index) => `Accept ${index}.`),
      verification: Array.from({ length: 128 }, (_, index) => `check:${index}`),
      dependencies: Array.from({ length: 128 }, (_, index) => `issue:#${index + 1}`),
      requiredHumanInput: Array.from({ length: 64 }, (_, index) => `Confirm ${index}.`),
    });
    expect(maxTemplate.description).toContain("docs/file-255.md");

    const labels = [
      ...managedIssueLabelNames(LABELS),
      ...Array.from({ length: 123 }, (_, index) => `Human Label ${index}`),
    ];
    const boundedObservation = observed(identity, 1, {
      labels,
      assigneeIds: Array.from({ length: 64 }, (_, index) => index + 1),
    });
    expect(
      reconcileManagedIssue({
        identity,
        observations: [boundedObservation],
        desiredLabels: LABELS,
      }).disposition,
    ).toBe("reuse");

    const observations = Array.from(
      { length: 10_000 },
      (_, index): ManagedIssueObservation => ({
        iid: index + 1,
        state: "opened",
        title: "Human issue",
        description: "Human-owned and unmarked.",
        labels: [],
      }),
    );
    const fullScan = reconcileManagedIssue({ identity, observations, desiredLabels: LABELS });
    expect(fullScan.disposition).toBe("create");
    expect(fullScan.ignoredUnmarkedIssueIids).toHaveLength(10_000);
    const oversized = new Array<ManagedIssueObservation>(10_001);
    expectError(
      () => reconcileManagedIssue({ identity, observations: oversized, desiredLabels: LABELS }),
      "invalid-value",
    );

    const maxFinding = {
      ...finding("finding:max", "docs/seed.md", "d".repeat(64)),
      affectedPaths: Array.from({ length: 256 }, (_, index) => `docs/path-${index}.md`),
      evidenceIds: Array.from({ length: 256 }, (_, index) =>
        semanticEvidenceId(`candidate:${index}`),
      ),
      dependsOnFindingIds: Array.from({ length: 256 }, (_, index) => `finding:${index}`),
    };
    expect(managedIssueFindingFingerprintV1(maxFinding)).toMatch(/^[a-f0-9]{64}$/u);
  });
});

function makeLedger(
  options: { projectId?: number; revision?: string; fullPath?: string } = {},
): RoadmapLedger {
  const first = finding("finding:one", "docs/architecture.md", "e".repeat(64));
  const second = finding("finding:two", "docs/other.md", "f".repeat(64));
  const revision = options.revision ?? REVISION;
  return createRoadmapLedger({
    id: "ledger:managed-issues",
    repository: { revision, contentDigest: CONTENT },
    project: {
      provider: "gitlab",
      host: "tracker.example.com",
      fullPath: options.fullPath ?? "group/docsfab",
      projectId: options.projectId ?? 422_255,
    },
    boundary: {
      id: "boundary:one",
      mode: "documentation-health",
      observedAt: T0,
      queryDigest: "0".repeat(64),
    },
    trackerObservedAt: T1,
    tracker: [{ issueIid: 45, state: "opened", updatedAt: T1, identityDigest: TRACKER_45 }],
    evidence: [
      {
        id: EVIDENCE_ONE,
        kind: "validation",
        digest: "9".repeat(64),
        repositoryRevision: revision,
      },
      {
        id: EVIDENCE_TWO,
        kind: "validation",
        digest: "8".repeat(64),
        repositoryRevision: revision,
      },
    ],
    findings: [first, second],
    workstreams: [
      {
        id: "workstream:one",
        findingIds: [first.id, second.id],
        dependsOnWorkstreamIds: [],
        collidesWithWorkstreamIds: [],
        executionOrder: 1,
        state: "ready",
      },
    ],
    dedup: [
      { findingId: first.id, decision: "create", rationaleCode: "new-finding" },
      { findingId: second.id, decision: "create", rationaleCode: "new-finding" },
    ],
    transitions: [
      {
        id: "transition:one",
        findingId: first.id,
        from: "observed",
        to: "proposed",
        at: T0,
        reasonCode: "observed",
        evidenceIds: [EVIDENCE_ONE],
      },
      {
        id: "transition:two",
        findingId: second.id,
        from: "observed",
        to: "proposed",
        at: T0,
        reasonCode: "observed",
        evidenceIds: [EVIDENCE_TWO],
      },
    ],
    sweeps: [],
    closeouts: [],
    createdAt: T0,
    updatedAt: T1,
  });
}

function finding(id: string, path: string, materialEvidenceDigest: string): RoadmapFinding {
  const evidenceId = id === "finding:one" ? EVIDENCE_ONE : EVIDENCE_TWO;
  const material: RoadmapFindingMaterial = {
    boundaryId: "boundary:one",
    category: "documentation-gap",
    severity: "p1",
    affectedPaths: [path],
    evidenceIds: [evidenceId],
    materialEvidenceDigest,
  };
  return {
    id,
    ...material,
    fingerprint: roadmapFindingFingerprint(material),
    source: "documentation-health",
    disposition: "repair",
    lifecycle: "proposed",
    dependsOnFindingIds: [],
  };
}

function template(
  identity: ManagedIssueIdentityV1,
  kind: "saga" | "epic" | "task" | "investigation" = "task",
) {
  return {
    kind,
    summary: "Repair architecture docs",
    identity,
    labels: LABELS,
    evidence: [EVIDENCE_ONE],
    rationale: "The architecture guide lacks the supported workflow.",
    audienceImpact: "Maintainers cannot verify the local workflow.",
    pathScope: ["docs/architecture.md"],
    acceptance: ["The supported workflow is documented."],
    verification: ["npm:check"],
    dependencies: ["issue:#90"],
    requiredHumanInput: ["Approve the proposed scope."],
  };
}

function observed(
  identity: ManagedIssueIdentityV1,
  iid: number,
  overrides: Partial<ManagedIssueObservation> = {},
): ManagedIssueObservation {
  return {
    iid,
    state: "opened",
    title: "human title",
    description: renderManagedIssueMarker(identity.marker),
    labels: managedIssueLabelNames(LABELS),
    stateBinding: createManagedIssueStateBinding(identity),
    ...overrides,
  };
}

function makePlan(ledger: RoadmapLedger) {
  const identity = createManagedIssueIdentity(ledger, "finding:one");
  const createMaterial = {
    kind: "create" as const,
    operationKey: "operation:create-managed",
    template: template(identity),
  };
  const updateMaterial = {
    kind: "update" as const,
    operationKey: "operation:update-managed",
    action: "add-labels" as const,
    reconciliation: {
      identity,
      observations: [
        observed(identity, 45, {
          labels: managedIssueLabelNames(LABELS).filter((label) => label !== "priority::p1"),
        }),
      ],
      desiredLabels: LABELS,
    },
  };
  const createEvidence = createManagedIssueMutationMaterialEvidenceV1(
    createMaterial,
    ledger,
    identity,
  );
  const updateEvidence = createManagedIssueMutationMaterialEvidenceV1(
    updateMaterial,
    ledger,
    identity,
  );
  const operation: RoadmapMutationOperationV2Input = {
    key: "operation:create-managed",
    kind: "issue",
    findingIds: ["finding:one"],
    dependsOnOperationKeys: [],
    target: { source: "project", targetKey: `project:${ledger.project.projectId}` },
    preconditions: [],
    proposal: { kind: "issue", intent: "create", effectKind: "issue" },
    materialDigest: createEvidence.materialDigest,
    materialBytes: createEvidence.materialBytes,
    expectedEffectKind: "issue",
  };
  const update: RoadmapMutationOperationV2Input = {
    key: "operation:update-managed",
    kind: "label",
    findingIds: ["finding:one"],
    dependsOnOperationKeys: [],
    target: { source: "ledger-observation", targetKey: "issue:45" },
    preconditions: [
      {
        source: "ledger-observation",
        targetKey: "issue:45",
        observedAt: T1,
        identityDigest: TRACKER_45,
      },
    ],
    proposal: { kind: "label", intent: "assign-label", effectKind: "issue" },
    materialDigest: updateEvidence.materialDigest,
    materialBytes: updateEvidence.materialBytes,
    expectedEffectKind: "issue",
  };
  const plan = createRoadmapMutationPlanV2(
    {
      id: "plan:managed-issue",
      ledger: {
        kind: "roadmap-ledger",
        schemaVersion: 1,
        digest: ledger.digest,
        repositoryRevision: ledger.repository.revision,
        repositoryContentDigest: ledger.repository.contentDigest,
      },
      repository: ledger.repository,
      project: ledger.project,
      trackerObservedAt: ledger.trackerObservedAt,
      operations: [operation, update],
      generatedAt: T1,
      expiresAt: "2026-08-05T01:00:00.000Z",
    },
    ledger,
  );
  return { plan, createMaterial, updateMaterial };
}

function semanticEvidenceId(candidateId: string): string {
  return `evidence:${roadmapDigest({ contract: "roadmap-semantic-candidate-identity-v1", candidateId })}`;
}

function productionPlan(input: RoadmapHealthPlanningInput) {
  const decoded = decodeRoadmapPlanningInput(input);
  const sourceDigest = roadmapDigest({ source: decoded });
  const host = internalCreateRoadmapPlanningHostAuthority(sourceDigest);
  return planRoadmap(input, [], internalIssueRoadmapPlanningSourceCapability(host, sourceDigest));
}

function productionHealthInput(
  revision: string,
  contentDigest: string,
  evidenceDigest: string,
  observedAt: string,
): RoadmapHealthPlanningInput {
  const project = {
    provider: "gitlab",
    host: "tracker.example.com",
    fullPath: "group/docsfab",
    projectId: 422_255,
  };
  const candidate = {
    id: "candidate:stable-api-defect",
    category: "documentation-gap",
    severity: "p1" as const,
    disposition: "repair" as const,
    unitIds: ["unit:stable-api-defect"],
    affectedPaths: ["docs/architecture.md"],
    evidenceDigest,
    rank: { impact: 3, urgency: 2, dependency: 1, scope: 2, verificationCost: 1, confidence: 0.9 },
    review: {
      disposition: "accepted" as const,
      rationaleCode: "reviewed",
      evidenceDigest: "f".repeat(64),
    },
    draft: {
      kind: "issue" as const,
      title: "Repair architecture docs",
      summary: "Repair the stable API documentation defect.",
      acceptanceCriteria: ["The defect is resolved."],
      verification: ["Run documentation checks."],
      evidencePaths: ["docs/architecture.md"],
      selfContained: true,
    },
  };
  const unit = {
    id: candidate.unitIds[0]!,
    kind: "doc-audit" as const,
    path: candidate.affectedPaths[0]!,
    evidenceDigest,
  };
  const audit = {
    kind: "authenticated-doc-audit-package" as const,
    schemaVersion: 1 as const,
    runId: `run:${revision.slice(0, 12)}`,
    workflow: "review-documentation" as const,
    status: "succeeded" as const,
    repositoryRevision: revision,
    repositoryContentDigest: contentDigest,
    projectIdentityDigest: roadmapDigest(project),
    findings: [
      {
        id: candidate.id,
        units: [unit],
        affectedPaths: [...candidate.affectedPaths],
        evidenceDigest,
        candidateDigest: roadmapDigest(candidate),
      },
    ],
    digest: "0".repeat(64),
  };
  audit.digest = roadmapDigest(audit);
  return {
    kind: "docsfab-roadmap-planning-input",
    schemaVersion: 1,
    mode: "health",
    repository: { revision, contentDigest },
    project,
    observedAt,
    expiresAt: "2026-08-06T00:00:00.000Z",
    units: [unit],
    candidates: [candidate],
    semanticReconciliation: [],
    proposalCap: 10,
    docAudit: audit,
  };
}

function redigestMarker(
  value: Omit<ManagedIssueMarkerV1, "identityDigest"> & { identityDigest: string },
): ManagedIssueMarkerV1 {
  const { identityDigest: _digest, ...material } = value;
  return { ...material, identityDigest: roadmapDigest(material) };
}

function trappedProxy<T extends object>(value: T, onTrap: () => void): T {
  const fail = (): never => {
    onTrap();
    throw new Error("proxy trap must remain inert");
  };
  return new Proxy(value, {
    get: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
    has: fail,
    ownKeys: fail,
  });
}

function expectError(action: () => unknown, code: ManagedIssueContractError["code"]): void {
  try {
    action();
    throw new Error("expected managed issue contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedIssueContractError);
    expect((error as ManagedIssueContractError).code).toBe(code);
  }
}
