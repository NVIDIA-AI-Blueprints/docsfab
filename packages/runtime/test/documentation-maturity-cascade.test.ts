// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest, canonicalJson } from "../src/content-ir/canonical.js";
import { buildContentIndexV2 } from "../src/content-ir/indexer.js";
import {
  DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH,
  assessDocumentationMaturityCascade,
  decodeDocumentationMaturityCascadeAssessment,
  decodeDocumentationMaturityCascadeSelection,
  decodeDocumentationMaturityCascadeTrackerObservation,
  inspectDocumentationMaturityCascadeSelection,
  inspectDocumentationMaturityCandidateBudget,
  inspectDocumentationMaturityGitLabBinding,
  inspectDocumentationMaturityPrerequisiteException,
  inspectDocumentationMaturityWorkUnitRanking,
  observeDocumentationMaturityCascadeTracker,
  selectDocumentationMaturityWorkUnit as selectAuthoritativeDocumentationMaturityWorkUnit,
  validateDocumentationMaturityCascadeAssessment,
  validateDocumentationMaturityCascadeSelection,
} from "../src/maturity/cascade.js";
import type { DocumentationMaturityWorkUnitV1 } from "../src/maturity/contracts.js";
import { documentationMaturityFindingFingerprint } from "../src/maturity/contracts.js";
import {
  DOCUMENTATION_MATURITY_HOST_POLICY_PATH,
  mapContentIndexToG3,
  mapRepositoryInventoryToG0,
} from "../src/maturity/evaluators.js";
import { sanitizeGitLabIssue } from "../src/roadmap/gitlab-readonly.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const exec = promisify(execFile);
const temporary = temporaryRoots();
type PreparedRepositoryWorkspace = Awaited<ReturnType<typeof prepareRepositoryWorkspace>>;

const workspaces: PreparedRepositoryWorkspace[] = [];
const NOW = new Date("2026-08-05T16:00:00.000Z");
const PROJECT = {
  provider: "gitlab",
  host: "gitlab.example.invalid",
  fullPath: "docs/fixture",
  projectId: 101,
};

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

describe("documentation maturity cascade", () => {
  it("selects exactly one earliest executable unit and binds assessment plus tracker state", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const observation = await trackerObservation(assessment.repository);
    const selection = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: observation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });

    expect(assessment.gates.map((gate) => gate.gateId)).toEqual([
      "G0",
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
    ]);
    expect(selection.outcome.state).toBe("selected");
    expect(selection.outcome.gateId).toBe("G0");
    expect(selection.outcome.workUnit).toMatchObject({
      trackerMutation: "not-authorized",
      workflow: { name: "readiness", stepId: "assess-readiness" },
      execution: { state: "ready", missingInputIds: [] },
    });
    expect(selection.outcome.workUnit?.affectedPaths.length).toBeGreaterThan(0);
    expect(selection.outcome.workUnit?.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(selection.outcome.workUnit?.verification.length).toBeGreaterThan(0);
    expect(
      selection.candidates.filter((candidate) => candidate.status === "selected"),
    ).toHaveLength(1);
    expect(selection.trackerMutation).toBe("not-authorized");
    expect(selection.assessmentSha256).toBe(assessment.assessmentSha256);
    expect(selection.trackerObservationSha256).toMatch(/^[a-f0-9]{64}$/u);

    expect(decodeDocumentationMaturityCascadeAssessment(structuredClone(assessment))).toEqual(
      assessment,
    );
    expect(decodeDocumentationMaturityCascadeSelection(structuredClone(selection))).toEqual(
      selection,
    );
  });

  it("requires original or reauthenticated assessment and tracker authorities", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const observation = await trackerObservation(assessment.repository);
    const authenticSelection = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: observation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });

    await expect(
      selectAuthoritativeDocumentationMaturityWorkUnit({
        assessment: structuredClone(assessment),
        trackerObservation: observation as never,
        policyWorkspace: workspace,
      }),
    ).rejects.toMatchObject({ code: "invalid-assessment" });
    await expect(
      selectAuthoritativeDocumentationMaturityWorkUnit({
        assessment,
        trackerObservation: structuredClone(observation) as never,
        policyWorkspace: workspace,
      }),
    ).rejects.toMatchObject({ code: "invalid-tracker-observation" });

    const rehashedSelection = structuredClone(authenticSelection);
    rehashedSelection.candidates[0]!.reasonCodes = ["fabricated-rationale"];
    rehashedSelection.selectionSha256 = canonicalDigest(
      without(rehashedSelection, "selectionSha256"),
    );
    expect(() => decodeDocumentationMaturityCascadeSelection(rehashedSelection)).not.toThrow();
    const reauthenticated = await validateDocumentationMaturityCascadeAssessment(
      structuredClone(assessment),
      { gateInputs },
    );
    expect(
      await selectDocumentationMaturityWorkUnit({
        assessment: reauthenticated,
        trackerObservation: observation,
        policyWorkspace: workspace,
        clock: () => NOW,
      }),
    ).toMatchObject({ outcome: { state: "selected" } });
  });

  it("uses active, completed, unverified, and conflicting tracker fingerprints conservatively", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const fingerprint = assessment.gates[0]!.workUnits[0]!.findingFingerprint;
    const activeObservation = await trackerObservation(assessment.repository, [
      trackerIssue(1, "opened", fingerprint, []),
    ]);
    const active = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: activeObservation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });
    expect(active.outcome.state).toBe("selected");
    expect(
      active.candidates.find((candidate) => candidate.status === "selected")?.reasonCodes,
    ).toContain("tracker-active-reuse");

    const completedObservation = await trackerObservation(assessment.repository, [
      trackerIssue(1, "closed", fingerprint, [canonicalDigest("verified-material")]),
    ]);
    const completed = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: completedObservation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });
    expect(completed.outcome.state).toBe("investigation");
    expect(completed.candidates[0]).toMatchObject({
      status: "not-executable",
      reasonCodes: ["tracker-complete"],
    });
    expect(completed.selectionSha256).not.toBe(active.selectionSha256);

    const unverifiedObservation = await trackerObservation(assessment.repository, [
      trackerIssue(1, "closed", fingerprint, []),
    ]);
    const unverified = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: unverifiedObservation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });
    expect(unverified.candidates[0]).toMatchObject({
      status: "investigation",
      reasonCodes: ["tracker-closed-unverified"],
    });

    const conflictObservation = await trackerObservation(assessment.repository, [
      trackerIssue(1, "opened", fingerprint, []),
      trackerIssue(2, "opened", fingerprint, []),
    ]);
    const conflict = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: conflictObservation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });
    expect(conflict.candidates[0]).toMatchObject({
      status: "investigation",
      reasonCodes: ["tracker-fingerprint-conflict"],
    });
  });

  it("ranks every deterministic dimension pairwise and is permutation-stable", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const base = assessment.gates[0]!.workUnits[0]!;
    const observation = await trackerObservation(assessment.repository);
    const inspect = (units: DocumentationMaturityWorkUnitV1[]) =>
      inspectDocumentationMaturityWorkUnitRanking({
        workUnits: units,
        trackerIssues: observation.issues,
      });

    const earlyGate = reworkUnit(base, "early-gate", {
      gateId: "G0",
      affectedPaths: ["guide/early.md"],
    });
    const laterGate = reworkUnit(base, "later-gate", {
      gateId: "G1",
      affectedPaths: ["guide/later.md"],
    });
    expect(inspect([laterGate, earlyGate])[0]!.workUnitFingerprint).toBe(
      earlyGate.workUnitFingerprint,
    );

    const critical = reworkUnit(base, "critical", {
      severity: "critical",
      affectedPaths: ["guide/critical.md"],
    });
    const major = reworkUnit(base, "major", {
      severity: "major",
      affectedPaths: ["guide/major.md"],
    });
    expect(inspect([major, critical])[0]!.workUnitFingerprint).toBe(critical.workUnitFingerprint);

    const blockedAudience = reworkUnit(base, "blocked-audience", {
      affectedPaths: ["guide/blocked.md"],
      audienceImpact: [{ audience: "reader", impact: "blocked" }],
    });
    const degradedAudience = reworkUnit(base, "degraded-audience", {
      affectedPaths: ["guide/degraded.md"],
      audienceImpact: [{ audience: "reader", impact: "degraded" }],
    });
    expect(inspect([degradedAudience, blockedAudience])[0]!.workUnitFingerprint).toBe(
      blockedAudience.workUnitFingerprint,
    );
    const oneDegraded = reworkUnit(base, "one-degraded", {
      affectedPaths: ["guide/one-degraded.md"],
      audienceImpact: [{ audience: "reader", impact: "degraded" }],
    });
    const twoDegraded = reworkUnit(base, "two-degraded", {
      affectedPaths: ["guide/two-degraded.md"],
      audienceImpact: [
        { audience: "maintainer", impact: "degraded" },
        { audience: "reader", impact: "degraded" },
      ],
    });
    expect(inspect([oneDegraded, twoDegraded])[0]!.workUnitFingerprint).toBe(
      twoDegraded.workUnitFingerprint,
    );

    const confirmed = reworkUnit(base, "confirmed", { affectedPaths: ["guide/confirmed.md"] });
    const bounded = reworkUnit(base, "bounded", {
      confidence: "bounded",
      disposition: "bounded-not-found",
      affectedPaths: ["guide/bounded.md"],
    });
    expect(inspect([bounded, confirmed])[0]!.workUnitFingerprint).toBe(
      confirmed.workUnitFingerprint,
    );
    const inconclusive = reworkUnit(base, "inconclusive", {
      confidence: "inconclusive",
      affectedPaths: ["guide/inconclusive.md"],
    });
    expect(inspect([inconclusive])[0]).toMatchObject({ eligibility: "investigation" });

    const narrow = reworkUnit(base, "narrow", { affectedPaths: ["guide/narrow.md"] });
    const wide = reworkUnit(base, "wide", {
      affectedPaths: ["guide/wide-a.md", "guide/wide-b.md"],
    });
    expect(inspect([wide, narrow])[0]!.workUnitFingerprint).toBe(narrow.workUnitFingerprint);

    const oneCriterion = reworkUnit(base, "one-criterion", {
      affectedPaths: ["guide/one-criterion.md"],
    });
    const twoCriteria = reworkUnit(base, "two-criteria", {
      affectedPaths: ["guide/two-criteria.md"],
      acceptanceCriteria: [
        ...base.acceptanceCriteria,
        { id: "criterion:second", evidenceKinds: ["repository-observation" as const] },
      ].sort((left, right) => left.id.localeCompare(right.id)),
      verification: base.verification.map((verification) => ({
        ...verification,
        acceptanceCriterionIds: [...verification.acceptanceCriterionIds, "criterion:second"].sort(),
      })),
    });
    expect(inspect([twoCriteria, oneCriterion])[0]!.workUnitFingerprint).toBe(
      oneCriterion.workUnitFingerprint,
    );

    const cheap = reworkUnit(base, "cheap", { affectedPaths: ["guide/cheap.md"] });
    const expensive = reworkUnit(base, "expensive", {
      affectedPaths: ["guide/expensive.md"],
      acceptanceCriteria: [{ id: "criterion:expensive", evidenceKinds: ["human-input"] }],
      verification: [
        {
          id: "verify:expensive",
          method: "human-attestation",
          acceptanceCriterionIds: ["criterion:expensive"],
        },
      ],
    });
    expect(inspect([expensive, cheap])[0]!.workUnitFingerprint).toBe(cheap.workUnitFingerprint);

    const collidesA = reworkUnit(base, "collides-a", { affectedPaths: ["guide/shared.md"] });
    const collidesB = reworkUnit(base, "collides-b", { affectedPaths: ["guide/shared.md"] });
    const isolated = reworkUnit(base, "isolated", { affectedPaths: ["guide/isolated.md"] });
    expect(inspect([collidesA, isolated, collidesB])[0]!.workUnitFingerprint).toBe(
      isolated.workUnitFingerprint,
    );

    const tiedA = reworkUnit(base, "tied-a", { affectedPaths: ["guide/a.md"] });
    const tiedB = reworkUnit(base, "tied-b", { affectedPaths: ["guide/b.md"] });
    const expectedTie = [tiedA.workUnitFingerprint, tiedB.workUnitFingerprint].sort()[0];
    expect(inspect([tiedB, tiedA])[0]!.workUnitFingerprint).toBe(expectedTie);
    expect(inspect([tiedA, tiedB])).toEqual(inspect([tiedB, tiedA]));

    const leverageRoot = reworkUnit(base, "leverage-root", { affectedPaths: ["guide/lr.md"] });
    const leverageIsolated = reworkUnit(base, "leverage-isolated", {
      affectedPaths: ["guide/li.md"],
    });
    const leverageDependent = reworkUnit(base, "leverage-dependent", {
      affectedPaths: ["guide/ld.md"],
      dependsOnWorkUnitIds: [leverageRoot.id],
    });
    expect(
      inspect([leverageIsolated, leverageDependent, leverageRoot])[0]!.workUnitFingerprint,
    ).toBe(leverageRoot.workUnitFingerprint);
  });

  it("resolves completed dependencies, reports transitive leverage, and rejects cycles or ambiguous IDs", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const base = assessment.gates[0]!.workUnits[0]!;
    const root = reworkUnit(base, "dependency-root", { affectedPaths: ["guide/root.md"] });
    const middle = reworkUnit(base, "dependency-middle", {
      affectedPaths: ["guide/middle.md"],
      dependsOnWorkUnitIds: [root.id],
    });
    const leaf = reworkUnit(base, "dependency-leaf", {
      affectedPaths: ["guide/leaf.md"],
      dependencyFingerprints: [middle.findingFingerprint],
    });
    const observation = await trackerObservation(assessment.repository);
    const graph = inspectDocumentationMaturityWorkUnitRanking({
      workUnits: [leaf, root, middle],
      trackerIssues: observation.issues,
    });
    expect(
      graph.find((item) => item.workUnitFingerprint === root.workUnitFingerprint),
    ).toMatchObject({ eligibility: "ready", rank: { dependencyLeverage: 2 } });
    expect(
      graph.find((item) => item.workUnitFingerprint === middle.workUnitFingerprint),
    ).toMatchObject({ eligibility: "dependency-blocked", rank: { dependencyLeverage: 1 } });

    const completedObservation = await trackerObservation(assessment.repository, [
      trackerIssue(9, "closed", root.findingFingerprint, [canonicalDigest("root-complete")]),
    ]);
    const trackerDependent = reworkUnit(base, "tracker-dependent", {
      affectedPaths: ["guide/tracker-dependent.md"],
      dependencyFingerprints: [root.findingFingerprint],
    });
    const afterCompletion = inspectDocumentationMaturityWorkUnitRanking({
      workUnits: [trackerDependent],
      trackerIssues: completedObservation.issues,
    });
    expect(afterCompletion[0]).toMatchObject({ eligibility: "ready" });

    const cyclicRoot = reworkUnit(root, "cyclic-root", {
      id: root.id,
      dependsOnWorkUnitIds: [leaf.id],
    });
    expect(() =>
      inspectDocumentationMaturityWorkUnitRanking({
        workUnits: [cyclicRoot, middle, leaf],
        trackerIssues: observation.issues,
      }),
    ).toThrowError(/invalid-assessment/u);

    const duplicateId = reworkUnit(base, "duplicate-id", {
      id: root.id,
      affectedPaths: ["guide/duplicate.md"],
    });
    expect(() =>
      inspectDocumentationMaturityWorkUnitRanking({
        workUnits: [root, duplicateId],
        trackerIssues: observation.issues,
      }),
    ).toThrowError(/invalid-assessment/u);
  });

  it("fails closed on incomplete, reordered, sparse, hidden, and oversized gate inputs", async () => {
    const fixture = await repositoryFixture({ validation: true, productNeed: "required" });
    const { gateInputs } = await gateInputsFor(fixture, true);

    await expect(
      assessDocumentationMaturityCascade({ gateInputs: gateInputs.slice(0, 5) }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      assessDocumentationMaturityCascade({
        gateInputs: [gateInputs[1]!, gateInputs[0]!, ...gateInputs.slice(2)],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    const sparse: unknown[] = [];
    sparse.length = 0xffff_ffff;
    sparse[0] = gateInputs[0];
    await expect(
      assessDocumentationMaturityCascade({ gateInputs: sparse as never }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    const hidden = [...gateInputs];
    Object.defineProperty(hidden, "0", { value: hidden[0], enumerable: false });
    await expect(assessDocumentationMaturityCascade({ gateInputs: hidden })).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("returns needs-input for unknown product need without inventing a write", async () => {
    const fixture = await repositoryFixture({ validation: true, productNeed: "unknown" });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const observation = await trackerObservation(assessment.repository);
    const selection = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: observation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });

    expect(selection.outcome).toMatchObject({ state: "needs-input", workUnit: null });
    expect(selection.outcome.missingInputIds).toContain("product-need:G1");
    expect(selection.candidates.some((candidate) => candidate.status === "selected")).toBe(false);
  });

  it("returns stable no-action when G0 is satisfied and all later gates are not applicable", async () => {
    const fixture = await repositoryFixture({ validation: true, productNeed: "not-required" });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const observation = await trackerObservation(assessment.repository);
    const first = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: observation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });
    const second = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: observation,
      policyWorkspace: workspace,
      clock: () => NOW,
    });

    expect(first.outcome).toEqual({
      state: "no-action",
      gateId: null,
      workUnit: null,
      missingInputIds: [],
    });
    expect(first.selectionSha256).toBe(second.selectionSha256);
    expect(first.candidates).toEqual([]);
  });

  it("rejects stale tracker state and noncanonical tracked exception policy", async () => {
    const staleFixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const stale = await gateInputsFor(staleFixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs: stale.gateInputs });
    const observation = await trackerObservation(assessment.repository);
    await expect(
      selectDocumentationMaturityWorkUnit({
        assessment,
        trackerObservation: observation,
        policyWorkspace: stale.workspace,
        clock: () => new Date(NOW.getTime() + 5 * 60 * 1_000),
      }),
    ).rejects.toMatchObject({ code: "invalid-tracker-observation" });

    const badPolicyFixture = await repositoryFixture({
      validation: false,
      productNeed: "required",
      cascadePolicy: `${canonicalJson({
        schemaVersion: 1,
        kind: "docsfab-documentation-maturity-cascade-policy",
        exceptions: [],
      })}\n`,
    });
    const bad = await gateInputsFor(badPolicyFixture, true);
    const badAssessment = await assessDocumentationMaturityCascade({ gateInputs: bad.gateInputs });
    const badObservation = await trackerObservation(badAssessment.repository);
    await expect(
      selectDocumentationMaturityWorkUnit({
        assessment: badAssessment,
        trackerObservation: badObservation,
        policyWorkspace: bad.workspace,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid-policy" });
  });

  it("admits only an exact independent-scope central prerequisite exception", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const prerequisite = assessment.gates[0]!;
    const base = prerequisite.workUnits[0]!;
    const target = reworkUnit(base, "exception-target", {
      gateId: "G1",
      affectedPaths: ["guide/independent.md"],
      dependsOnWorkUnitIds: [],
      dependencyFingerprints: [],
    });
    const exception = {
      id: "exception:g0-g1",
      prerequisiteGateId: "G0",
      targetGateId: "G1",
      candidateWorkUnitFingerprint: target.workUnitFingerprint,
      candidateScopeSha256: target.scopeSha256,
      evidencePath: "guide/exception-evidence.md",
      evidenceSha256: canonicalDigest("independent evidence"),
      rationale: "independent-scope",
    };
    expect(
      inspectDocumentationMaturityPrerequisiteException({
        exception,
        prerequisite,
        targetGateId: "G1",
        workUnit: target,
      }),
    ).toEqual({ authority: "non-authoritative", valid: true });

    const colliding = reworkUnit(base, "exception-collision", {
      gateId: "G1",
      affectedPaths: [...base.affectedPaths],
    });
    expect(
      inspectDocumentationMaturityPrerequisiteException({
        exception: {
          ...exception,
          candidateWorkUnitFingerprint: colliding.workUnitFingerprint,
          candidateScopeSha256: colliding.scopeSha256,
        },
        prerequisite,
        targetGateId: "G1",
        workUnit: colliding,
      }),
    ).toEqual({ authority: "non-authoritative", valid: false });

    const findingDependent = reworkUnit(base, "exception-finding-dependent", {
      gateId: "G1",
      affectedPaths: ["guide/finding-dependent.md"],
      dependencyFingerprints: [prerequisite.findings[0]!.fingerprint],
    });
    expect(
      inspectDocumentationMaturityPrerequisiteException({
        exception: {
          ...exception,
          candidateWorkUnitFingerprint: findingDependent.workUnitFingerprint,
          candidateScopeSha256: findingDependent.scopeSha256,
        },
        prerequisite,
        targetGateId: "G1",
        workUnit: findingDependent,
      }),
    ).toEqual({ authority: "non-authoritative", valid: false });

    const workUnitDependent = reworkUnit(base, "exception-work-dependent", {
      gateId: "G1",
      affectedPaths: ["guide/work-dependent.md"],
      dependsOnWorkUnitIds: [base.id],
    });
    expect(
      inspectDocumentationMaturityPrerequisiteException({
        exception: {
          ...exception,
          candidateWorkUnitFingerprint: workUnitDependent.workUnitFingerprint,
          candidateScopeSha256: workUnitDependent.scopeSha256,
        },
        prerequisite,
        targetGateId: "G1",
        workUnit: workUnitDependent,
      }),
    ).toEqual({ authority: "non-authoritative", valid: false });
  });

  it("loads a canonical tracked exception and unblocks only its exact G1 work unit", async () => {
    const evidence = "# Independent exception evidence\n";
    const fixture = await repositoryFixture({
      validation: false,
      productNeed: "required",
      cascadeEvidence: evidence,
    });
    const initial = await gateInputsFor(fixture, true);
    const initialAssessment = await assessDocumentationMaturityCascade({
      gateInputs: initial.gateInputs,
    });
    const initialSynthetic = withSyntheticG1Target(initialAssessment);
    const initialRootFingerprint =
      initialSynthetic.assessment.gates[0]!.workUnits[0]!.findingFingerprint;
    const initialTracker = await trackerObservation(initialSynthetic.assessment.repository, [
      trackerIssue(98, "closed", initialRootFingerprint, [canonicalDigest("root-complete")]),
    ]);
    const withoutException = await inspectDocumentationMaturityCascadeSelection({
      assessment: initialSynthetic.assessment,
      trackerIssues: initialTracker.issues,
      policyWorkspace: initial.workspace,
      observedAt: NOW.toISOString(),
      timeSource: () => NOW,
    });
    expect(
      withoutException.selection.candidates.find(
        (candidate) =>
          candidate.workUnitFingerprint === initialSynthetic.target.workUnitFingerprint,
      ),
    ).toMatchObject({
      status: "prerequisite-blocked",
      reasonCodes: ["prerequisite-blocked:G0"],
    });
    const exception = {
      id: "exception:g0-g1-tracked",
      prerequisiteGateId: "G0",
      targetGateId: "G1",
      candidateWorkUnitFingerprint: initialSynthetic.target.workUnitFingerprint,
      candidateScopeSha256: initialSynthetic.target.scopeSha256,
      evidencePath: "guide/exception-evidence.md",
      evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
      rationale: "independent-scope",
    };
    await writeFile(
      join(fixture, DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH),
      canonicalJson({
        schemaVersion: 1,
        kind: "docsfab-documentation-maturity-cascade-policy",
        exceptions: [exception],
      }),
    );
    await commitFixture(fixture, "add exception policy");

    const current = await gateInputsFor(fixture, true);
    const currentAssessment = withSyntheticG1Target(
      await assessDocumentationMaturityCascade({
        gateInputs: current.gateInputs,
      }),
    );
    expect(currentAssessment.target.workUnitFingerprint).toBe(
      initialSynthetic.target.workUnitFingerprint,
    );
    const rootFingerprint = currentAssessment.assessment.gates[0]!.workUnits[0]!.findingFingerprint;
    const tracker = await trackerObservation(currentAssessment.assessment.repository, [
      trackerIssue(99, "closed", rootFingerprint, [canonicalDigest("root-complete")]),
    ]);
    const inspected = await inspectDocumentationMaturityCascadeSelection({
      assessment: currentAssessment.assessment,
      trackerIssues: tracker.issues,
      policyWorkspace: current.workspace,
      observedAt: NOW.toISOString(),
      timeSource: () => NOW,
    });
    expect(inspected.selection.outcome).toMatchObject({
      state: "selected",
      gateId: "G1",
      workUnit: { workUnitFingerprint: currentAssessment.target.workUnitFingerprint },
    });
    expect(
      inspected.selection.candidates.find((candidate) => candidate.status === "selected")
        ?.reasonCodes,
    ).toContain("nonblocking-exception:exception:g0-g1-tracked");

    await writeFile(
      join(fixture, DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH),
      canonicalJson({
        schemaVersion: 1,
        kind: "docsfab-documentation-maturity-cascade-policy",
        exceptions: [{ ...exception, candidateScopeSha256: "0".repeat(64) }],
      }),
    );
    await commitFixture(fixture, "invalidate exception");
    const invalid = await gateInputsFor(fixture, true);
    const invalidAssessment = withSyntheticG1Target(
      await assessDocumentationMaturityCascade({
        gateInputs: invalid.gateInputs,
      }),
    );
    await expect(
      inspectDocumentationMaturityCascadeSelection({
        assessment: invalidAssessment.assessment,
        trackerIssues: tracker.issues,
        policyWorkspace: invalid.workspace,
        observedAt: NOW.toISOString(),
        timeSource: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid-policy" });
  });

  it("rejects every invalid tracked prerequisite exception at selection level", async () => {
    const evidence = "# Bound evidence\n";
    const fixture = await repositoryFixture({
      validation: false,
      productNeed: "required",
      cascadeEvidence: evidence,
    });
    const initial = await gateInputsFor(fixture, true);
    const synthetic = withSyntheticG1Target(
      await assessDocumentationMaturityCascade({
        gateInputs: initial.gateInputs,
      }),
    );
    const baseException = {
      id: "exception:matrix",
      prerequisiteGateId: "G0",
      targetGateId: "G1",
      candidateWorkUnitFingerprint: synthetic.target.workUnitFingerprint,
      candidateScopeSha256: synthetic.target.scopeSha256,
      evidencePath: "guide/exception-evidence.md",
      evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
      rationale: "independent-scope",
    };
    const cases = [
      { id: "bad-digest", exception: { ...baseException, evidenceSha256: "1".repeat(64) } },
      { id: "bad-path", exception: { ...baseException, evidencePath: "guide/missing.md" } },
      { id: "wrong-gate", exception: { ...baseException, targetGateId: "G2" } },
      {
        id: "wrong-fingerprint",
        exception: {
          ...baseException,
          candidateWorkUnitFingerprint: "2".repeat(64),
        },
      },
      { id: "dependency-overlap", exception: baseException, dependencyOverlap: true },
      { id: "unused", exception: baseException, clearPrerequisite: true },
    ] as const;
    for (const scenario of cases) {
      await writeFile(
        join(fixture, DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH),
        canonicalJson({
          schemaVersion: 1,
          kind: "docsfab-documentation-maturity-cascade-policy",
          exceptions: [{ ...scenario.exception, id: `exception:${scenario.id}` }],
        }),
      );
      await commitFixture(fixture, scenario.id);
      const current = await gateInputsFor(fixture, true);
      const currentSynthetic = withSyntheticG1Target(
        await assessDocumentationMaturityCascade({
          gateInputs: current.gateInputs,
        }),
      );
      if ("dependencyOverlap" in scenario) {
        currentSynthetic.target.dependsOnWorkUnitIds = [
          currentSynthetic.assessment.gates[0]!.workUnits[0]!.id,
        ];
        currentSynthetic.target.workUnitSha256 = canonicalDigest(
          without(currentSynthetic.target, "workUnitSha256"),
        );
        const gate = currentSynthetic.assessment.gates[1]!;
        gate.evaluationSha256 = canonicalDigest(without(gate, "evaluationSha256"));
        currentSynthetic.assessment.assessmentSha256 = canonicalDigest(
          without(currentSynthetic.assessment, "assessmentSha256"),
        );
      }
      if ("clearPrerequisite" in scenario) {
        const gate = currentSynthetic.assessment.gates[0]!;
        gate.findings = [];
        gate.workUnits = [];
        gate.checks = gate.checks.map((check, index) => ({
          ...check,
          state: "satisfied" as const,
          evidenceSha256s: [canonicalDigest(`satisfied:${index}`)],
          findingFingerprints: [],
          limitationCodes: [],
        }));
        gate.disposition = "satisfied";
        gate.evaluationSha256 = canonicalDigest(without(gate, "evaluationSha256"));
        currentSynthetic.assessment.assessmentSha256 = canonicalDigest(
          without(currentSynthetic.assessment, "assessmentSha256"),
        );
      }
      const rootFingerprint =
        currentSynthetic.assessment.gates[0]!.workUnits[0]?.findingFingerprint;
      const tracker = rootFingerprint
        ? (
            await trackerObservation(currentSynthetic.assessment.repository, [
              trackerIssue(100, "closed", rootFingerprint, [canonicalDigest("complete")]),
            ])
          ).issues
        : [];
      await expect(
        inspectDocumentationMaturityCascadeSelection({
          assessment: currentSynthetic.assessment,
          trackerIssues: tracker,
          policyWorkspace: current.workspace,
          observedAt: NOW.toISOString(),
          timeSource: () => NOW,
        }),
        scenario.id,
      ).rejects.toMatchObject({ code: "invalid-policy" });
    }
  });

  it("keeps tracker authority host-owned and rejects injected seams before I/O", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const primary = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs: primary.gateInputs });
    let overriddenCalls = 0;
    const hostileReader = Object.create(null) as { observe: () => Promise<never[]> };
    hostileReader.observe = async () => {
      overriddenCalls += 1;
      return [];
    };
    await expect(
      observeDocumentationMaturityCascadeTracker({
        assessment,
        workspace: primary.workspace,
        reader: hostileReader,
        fetch: async () => new Response("[]"),
        clock: () => NOW,
        project: PROJECT,
      } as never),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(overriddenCalls).toBe(0);

    const otherFixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const other = await gateInputsFor(otherFixture, true);
    await expect(
      observeDocumentationMaturityCascadeTracker({
        assessment,
        workspace: other.workspace,
      }),
    ).rejects.toMatchObject({ code: "repository-mismatch" });

    const clonedWorkspace = { ...primary.workspace };
    await expect(
      observeDocumentationMaturityCascadeTracker({
        assessment,
        workspace: clonedWorkspace,
      }),
    ).rejects.toMatchObject({ code: "invalid-tracker-observation" });

    const inspection = await inspectDocumentationMaturityCascadeSelection({
      assessment,
      trackerIssues: [],
      policyWorkspace: primary.workspace,
      observedAt: NOW.toISOString(),
      timeSource: () => NOW,
    });
    await expect(
      selectAuthoritativeDocumentationMaturityWorkUnit({
        assessment,
        trackerObservation: inspection as never,
        policyWorkspace: primary.workspace,
      }),
    ).rejects.toMatchObject({ code: "invalid-tracker-observation" });
    await expect(
      selectAuthoritativeDocumentationMaturityWorkUnit({
        assessment,
        trackerObservation: inspection as never,
        policyWorkspace: primary.workspace,
        clock: () => NOW,
      } as never),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("binds the canonical GitLab SSH remote, host, full path, and project metadata", () => {
    const remote = "ssh://git@gitlab.example.com:12051/example-user/docsfab.git";
    const metadata = {
      id: 422_255,
      path_with_namespace: "example-user/docsfab",
      web_url: "https://gitlab.example.com/example-user/docsfab",
      name: "DocsFab",
    };
    const expectedProject = {
      host: "gitlab.example.com",
      fullPath: "example-user/docsfab",
      projectId: 422_255,
      sshPort: 12_051,
    };
    expect(
      inspectDocumentationMaturityGitLabBinding({ remote, metadata, expectedProject }),
    ).toEqual({
      authority: "non-authoritative",
      project: {
        provider: "gitlab",
        host: "gitlab.example.com",
        fullPath: "example-user/docsfab",
        projectId: 422_255,
      },
    });
    for (const mismatched of [
      { ...metadata, path_with_namespace: "other/docsfab" },
      { ...metadata, web_url: "https://evil.example.com/example-user/docsfab" },
      { ...metadata, id: 0 },
      { ...metadata, id: 422_256 },
    ])
      expect(() =>
        inspectDocumentationMaturityGitLabBinding({
          remote,
          metadata: mismatched,
          expectedProject,
        }),
      ).toThrow();
    expect(() =>
      inspectDocumentationMaturityGitLabBinding({
        remote,
        metadata,
        expectedProject: { ...expectedProject, sshPort: 22 },
      }),
    ).toThrow();
  });

  it("exercises the authentic host observer and selector in a fresh process", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    await writeFile(join(fixture, "a.md"), "# Independent G0 fallback\n");
    await writeFile(
      join(fixture, "guide", "start.md"),
      [
        "# Oversized article",
        ...Array.from({ length: 33 }, (_, index) => `\n## Section ${index + 1}\n\nText.`),
        "",
      ].join("\n"),
    );
    await commitFixture(fixture, "authentic cascade targets");
    const prepared = await gateInputsFor(fixture, true);
    const g3Mapping = await mapContentIndexToG3({
      repository: prepared.repository,
      policyWorkspace: prepared.workspace,
      index: await buildContentIndexV2({ workspace: prepared.workspace }),
    });
    const authenticGateInputs = prepared.gateInputs.map((input) =>
      input.gateId === "G3" ? { ...input, mappings: [g3Mapping] } : input,
    );
    const preparedAssessment = await assessDocumentationMaturityCascade({
      gateInputs: authenticGateInputs,
    });
    const target = preparedAssessment.gates[3]!.workUnits.find((unit) =>
      unit.affectedPaths.includes("guide/start.md"),
    )!;
    expect(target.dependencyFingerprints).toEqual([]);
    expect(target.dependsOnWorkUnitIds).toEqual([]);
    const rootFingerprint = preparedAssessment.gates[0]!.workUnits[0]!.findingFingerprint;
    const packageBytes = await readFile(join(fixture, "package.json"));
    const exceptions = preparedAssessment.gates
      .slice(0, 3)
      .filter((gate) => gate.disposition !== "satisfied" && gate.disposition !== "not-applicable")
      .map((gate) => ({
        prerequisiteGateId: gate.gateId,
        id: `exception:${gate.gateId.toLowerCase()}-g3-host`,
        targetGateId: "G3",
        candidateWorkUnitFingerprint: target.workUnitFingerprint,
        candidateScopeSha256: target.scopeSha256,
        evidencePath: "package.json",
        evidenceSha256: createHash("sha256").update(packageBytes).digest("hex"),
        rationale: "independent-scope",
      }));
    expect(exceptions).not.toHaveLength(0);
    expect(exceptions.map((exception) => exception.prerequisiteGateId)).toEqual(["G0", "G1", "G2"]);
    for (const exception of exceptions) {
      expect(
        inspectDocumentationMaturityPrerequisiteException({
          exception,
          prerequisite: preparedAssessment.gates.find(
            (gate) => gate.gateId === exception.prerequisiteGateId,
          )!,
          targetGateId: "G3",
          workUnit: target,
        }),
        exception.prerequisiteGateId,
      ).toEqual({ authority: "non-authoritative", valid: true });
    }
    await writeFile(
      join(fixture, DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH),
      canonicalJson({
        schemaVersion: 1,
        kind: "docsfab-documentation-maturity-cascade-policy",
        exceptions,
      }),
    );
    await commitFixture(fixture, "authentic cascade policy");
    const policyPrepared = await gateInputsFor(fixture, true);
    const policyG3Mapping = await mapContentIndexToG3({
      repository: policyPrepared.repository,
      policyWorkspace: policyPrepared.workspace,
      index: await buildContentIndexV2({ workspace: policyPrepared.workspace }),
    });
    const policyAssessment = await assessDocumentationMaturityCascade({
      gateInputs: policyPrepared.gateInputs.map((input) =>
        input.gateId === "G3" ? { ...input, mappings: [policyG3Mapping] } : input,
      ),
    });
    const policyTarget = policyAssessment.gates[3]!.workUnits.find((unit) =>
      unit.affectedPaths.includes("guide/start.md"),
    )!;
    expect(policyTarget.affectedPaths).toEqual(target.affectedPaths);
    expect(policyTarget.scopeSha256).toBe(target.scopeSha256);
    expect(policyTarget.findingFingerprint).toBe(target.findingFingerprint);
    expect(policyTarget.requirement).toEqual(target.requirement);
    expect(policyTarget.acceptanceCriteria).toEqual(target.acceptanceCriteria);
    expect(policyTarget.verification).toEqual(target.verification);
    expect(policyTarget.workUnitFingerprint).toBe(target.workUnitFingerprint);
    expect(policyAssessment.gates[0]!.workUnits[0]!.findingFingerprint).toBe(rootFingerprint);
    await git(fixture, ["remote", "add", "origin", "ssh://git@127.0.0.1:12051/docs/fixture.git"]);
    let revision = await git(fixture, ["rev-parse", "HEAD"]);
    const hostEdge = async (mode: "valid" | "commit-mismatch" | "oversize" | "missing-glab") => {
      const bin = await temporary.create("docsfab-maturity-glab-");
      const logPath = join(bin, "calls.jsonl");
      const glabPath = join(bin, "glab");
      const commitId = mode === "commit-mismatch" ? "0".repeat(40) : revision;
      const script = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const hostname = args[2];
const endpoint = args[3];
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ hostname, endpoint, hasToken: Boolean(process.env.GITLAB_TOKEN || process.env.PRIVATE_TOKEN), unrelatedSecretPresent: Boolean(process.env.UNRELATED_SECRET) }) + "\\n");
if (endpoint === "projects/docs%2Ffixture") process.stdout.write(JSON.stringify({ id: 101, path_with_namespace: "docs/fixture", web_url: "https://127.0.0.1/docs/fixture" }));
else if (endpoint.includes("/repository/commits/")) process.stdout.write(JSON.stringify({ id: ${JSON.stringify(commitId)} }));
else if (${JSON.stringify(mode)} === "oversize") process.stdout.write(JSON.stringify([{ iid: 1, state: "opened", updated_at: "2026-08-05T15:00:00.000Z", title: "one", description: "x".repeat(5 * 1024 * 1024), labels: [], milestone: null }]));
else process.stdout.write(JSON.stringify([{ iid: 1, state: "closed", updated_at: "2026-08-05T15:00:00.000Z", title: "complete", description: ${JSON.stringify(`[docsfab-fingerprint:${rootFingerprint}] [docsfab-material:${canonicalDigest("root-complete")}]`)}, labels: [], milestone: null }]));
`;
      await writeFile(glabPath, script);
      await chmod(glabPath, 0o755);
      const result = await exec(
        process.execPath,
        [
          "--import",
          "tsx",
          join(process.cwd(), "test", "fixtures", "documentation-maturity-cascade-host-edge.ts"),
          fixture,
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            DOCSFAB_ROADMAP_GITLAB_HOST: "127.0.0.1",
            DOCSFAB_ROADMAP_GITLAB_FULL_PATH: "docs/fixture",
            DOCSFAB_ROADMAP_GITLAB_PROJECT_ID: "101",
            DOCSFAB_ROADMAP_GITLAB_SSH_PORT: "12051",
            ...(mode === "missing-glab"
              ? {}
              : {
                  DOCSFAB_ROADMAP_GLAB_PATH: await realpath(glabPath),
                }),
            DOCSFAB_CASCADE_G3: "1",
            GITLAB_TOKEN: "fixture-secret",
            UNRELATED_SECRET: "must-not-reach-glab",
          },
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const log = await readFile(logPath, "utf8").catch(() => "");
      const calls = log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              hostname: string;
              endpoint: string;
              hasToken: boolean;
              unrelatedSecretPresent: boolean;
            },
        );
      return { output: JSON.parse(result.stdout.trim()) as Record<string, unknown>, calls };
    };

    const valid = await hostEdge("valid");
    expect(valid.output, JSON.stringify(valid.calls)).toMatchObject({
      state: "selected",
      gateId: "G3",
      workUnitFingerprint: target.workUnitFingerprint,
      substitutionCode: "invalid-tracker-observation",
    });
    expect(valid.calls.map((call) => call.endpoint)).toEqual([
      "projects/docs%2Ffixture",
      `projects/101/repository/commits/${revision}`,
      "projects/101/issues?scope=all&state=all&per_page=100&page=1",
    ]);
    expect(
      valid.calls.every(
        (call) => call.hostname === "127.0.0.1" && call.hasToken && !call.unrelatedSecretPresent,
      ),
    ).toBe(true);

    const commitMismatch = await hostEdge("commit-mismatch");
    expect(commitMismatch.output).toEqual({ errorCode: "repository-mismatch" });
    expect(commitMismatch.calls).toHaveLength(2);

    const oversize = await hostEdge("oversize");
    expect(oversize.output).toEqual({ errorCode: "invalid-tracker-observation" });
    expect(oversize.calls).toHaveLength(3);

    const missingGlab = await hostEdge("missing-glab");
    expect(missingGlab.output).toEqual({ errorCode: "invalid-tracker-observation" });
    expect(missingGlab.calls).toHaveLength(0);

    await rm(join(fixture, "a.md"));
    await git(fixture, ["add", "-u"]);
    await git(fixture, ["commit", "-qm", "path collision"]);
    revision = await git(fixture, ["rev-parse", "HEAD"]);
    const collisionPrepared = await gateInputsFor(fixture, true);
    const collisionG3Mapping = await mapContentIndexToG3({
      repository: collisionPrepared.repository,
      policyWorkspace: collisionPrepared.workspace,
      index: await buildContentIndexV2({ workspace: collisionPrepared.workspace }),
    });
    const collisionAssessment = await assessDocumentationMaturityCascade({
      gateInputs: collisionPrepared.gateInputs.map((input) =>
        input.gateId === "G3" ? { ...input, mappings: [collisionG3Mapping] } : input,
      ),
    });
    const collisionTarget = collisionAssessment.gates[3]!.workUnits.find((unit) =>
      unit.affectedPaths.includes("guide/start.md"),
    )!;
    expect(collisionTarget.workUnitFingerprint).toBe(target.workUnitFingerprint);
    expect(collisionTarget.scopeSha256).toBe(target.scopeSha256);
    const blockedPaths = new Set(
      collisionAssessment.gates
        .slice(0, 3)
        .flatMap((gate) => gate.workUnits.flatMap((unit) => unit.affectedPaths)),
    );
    expect(collisionTarget.affectedPaths.some((path) => blockedPaths.has(path))).toBe(true);
    const collision = await hostEdge("valid");
    expect(collision.output).toEqual({ errorCode: "invalid-policy" });
  }, 30_000);

  it("bounds inert traversal and maximum graph work against hostile values", async () => {
    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const proxy = new Proxy(structuredClone(assessment), {});
    expect(() => decodeDocumentationMaturityCascadeAssessment(proxy)).toThrow();

    const accessor = structuredClone(assessment);
    Object.defineProperty(accessor, "kind", { enumerable: true, get: () => accessor.kind });
    expect(() => decodeDocumentationMaturityCascadeAssessment(accessor)).toThrow();

    const custom = Object.assign(Object.create({ inherited: true }), structuredClone(assessment));
    expect(() => decodeDocumentationMaturityCascadeAssessment(custom)).toThrow();

    const symbolic = structuredClone(assessment) as typeof assessment & { [key: symbol]: string };
    symbolic[Symbol("authority")] = "invented";
    expect(() => decodeDocumentationMaturityCascadeAssessment(symbolic)).toThrow();

    const cyclic = structuredClone(assessment);
    cyclic.gates[0] = cyclic as never;
    expect(() => decodeDocumentationMaturityCascadeAssessment(cyclic)).toThrow();

    const deep = structuredClone(assessment);
    let nested: Record<string, unknown> = {};
    deep.gates[0]!.checks[0] = nested as never;
    for (let depth = 0; depth < 80; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    expect(() => decodeDocumentationMaturityCascadeAssessment(deep)).toThrow();

    const largeIssues = Array.from({ length: 300 }, (_, issueIndex) => ({
      iid: issueIndex + 1,
      state: "opened" as const,
      updatedAt: "2026-08-05T15:00:00.000Z",
      identityDigest: canonicalDigest(`large-observation:${issueIndex}`),
      findingFingerprints: Array.from({ length: 256 }, (_, markerIndex) =>
        canonicalDigest(`large-observation:${issueIndex}:${markerIndex}`),
      ).sort(),
      materialEvidenceDigests: [],
    }));
    const largeObservationBody = {
      schemaVersion: 1 as const,
      kind: "docsfab-documentation-maturity-cascade-tracker-observation" as const,
      repository: assessment.repository,
      projectSha256: canonicalDigest(PROJECT),
      observedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 1_000).toISOString(),
      issues: largeIssues,
    };
    const largeObservation = decodeDocumentationMaturityCascadeTrackerObservation({
      ...largeObservationBody,
      observationSha256: canonicalDigest(largeObservationBody),
    });
    expect(largeObservation.issues).toHaveLength(300);
    await expect(
      inspectDocumentationMaturityCascadeSelection({
        assessment,
        trackerIssues: largeObservation.issues,
        policyWorkspace: workspace,
        observedAt: NOW.toISOString(),
        timeSource: () => NOW,
      }),
    ).resolves.toMatchObject({ selection: { outcome: { state: "selected" } } });

    const base = assessment.gates[0]!.workUnits[0]!;
    const deepUnit = structuredClone(base) as unknown as Record<string, unknown>;
    let unitNested: Record<string, unknown> = {};
    deepUnit.requiredHumanInput = unitNested;
    for (let depth = 0; depth < 80; depth += 1) {
      const child: Record<string, unknown> = {};
      unitNested.child = child;
      unitNested = child;
    }
    expect(() =>
      inspectDocumentationMaturityWorkUnitRanking({
        workUnits: [deepUnit],
        trackerIssues: [],
      }),
    ).toThrowError(/invalid-input/u);

    const deepPrerequisite = structuredClone(assessment.gates[0]!) as unknown as Record<
      string,
      unknown
    >;
    let prerequisiteNested: Record<string, unknown> = {};
    (deepPrerequisite.checks as unknown[])[0] = prerequisiteNested;
    for (let depth = 0; depth < 80; depth += 1) {
      const child: Record<string, unknown> = {};
      prerequisiteNested.child = child;
      prerequisiteNested = child;
    }
    expect(() =>
      inspectDocumentationMaturityPrerequisiteException({
        exception: {
          id: "exception:deep",
          prerequisiteGateId: "G0",
          targetGateId: "G1",
          candidateWorkUnitFingerprint: base.workUnitFingerprint,
          candidateScopeSha256: base.scopeSha256,
          evidencePath: "guide/evidence.md",
          evidenceSha256: "0".repeat(64),
          rationale: "independent-scope",
        },
        prerequisite: deepPrerequisite,
        targetGateId: "G1",
        workUnit: base,
      }),
    ).toThrowError(/invalid-input/u);

    const maximum = Array.from({ length: 256 }, (_, index) =>
      reworkUnit(base, `max-${index}`, {
        affectedPaths: [`guide/max-${index}.md`],
      }),
    );
    expect(
      inspectDocumentationMaturityWorkUnitRanking({
        workUnits: maximum,
        trackerIssues: [],
      }),
    ).toHaveLength(256);
    expect(() =>
      inspectDocumentationMaturityWorkUnitRanking({
        workUnits: [...maximum, reworkUnit(base, "over-max", { affectedPaths: ["guide/over.md"] })],
        trackerIssues: [],
      }),
    ).toThrow();
  });

  it("enforces one aggregate native, finding-only, and adapted candidate budget", async () => {
    expect(
      inspectDocumentationMaturityCandidateBudget({
        nativeWorkUnitCount: 256,
        findingOnlyCount: 1_536,
        adaptedWorkUnitCount: 64,
      }),
    ).toMatchObject({ aggregateCount: 1_856, maximumAggregateCount: 1_856 });
    for (const over of [
      { nativeWorkUnitCount: 257, findingOnlyCount: 0, adaptedWorkUnitCount: 0 },
      { nativeWorkUnitCount: 0, findingOnlyCount: 1_537, adaptedWorkUnitCount: 0 },
      { nativeWorkUnitCount: 0, findingOnlyCount: 0, adaptedWorkUnitCount: 65 },
    ])
      expect(() => inspectDocumentationMaturityCandidateBudget(over)).toThrow();

    const fixture = await repositoryFixture({ validation: false, productNeed: "required" });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    const base = (
      await inspectDocumentationMaturityCascadeSelection({
        assessment,
        trackerIssues: [],
        policyWorkspace: workspace,
        observedAt: NOW.toISOString(),
        timeSource: () => NOW,
      })
    ).selection;
    const decision = base.candidates[0]!;
    const transport = structuredClone(base);
    transport.candidates = Array.from({ length: 1_856 }, (_, index) => ({
      ...structuredClone(decision),
      key: `budget:${String(index).padStart(4, "0")}`,
      status: "not-executable" as const,
      reasonCodes: ["budget-fixture"],
    }));
    transport.outcome = {
      state: "investigation",
      gateId: "G0",
      workUnit: null,
      missingInputIds: [],
    };
    transport.selectionSha256 = canonicalDigest(without(transport, "selectionSha256"));
    expect(decodeDocumentationMaturityCascadeSelection(transport).candidates).toHaveLength(1_856);
    const overTransport = structuredClone(transport);
    overTransport.candidates.push({
      ...structuredClone(decision),
      key: "budget:1856",
      status: "not-executable",
      reasonCodes: ["budget-fixture"],
    });
    overTransport.selectionSha256 = canonicalDigest(without(overTransport, "selectionSha256"));
    expect(() => decodeDocumentationMaturityCascadeSelection(overTransport)).toThrow();
  });

  it("rechecks expiry between asynchronous policy operations", async () => {
    const fixture = await repositoryFixture({
      validation: false,
      productNeed: "required",
      cascadePolicy: canonicalJson({
        schemaVersion: 1,
        kind: "docsfab-documentation-maturity-cascade-policy",
        exceptions: [],
      }),
    });
    const { workspace, gateInputs } = await gateInputsFor(fixture, true);
    const assessment = await assessDocumentationMaturityCascade({ gateInputs });
    let checks = 0;
    await expect(
      inspectDocumentationMaturityCascadeSelection({
        assessment,
        trackerIssues: [],
        policyWorkspace: workspace,
        observedAt: NOW.toISOString(),
        timeSource: () => {
          checks += 1;
          return checks < 3 ? NOW : new Date(NOW.getTime() + 5 * 60 * 1_000);
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-tracker-observation" });
    expect(checks).toBeGreaterThanOrEqual(3);
  });
});

async function gateInputsFor(root: string, includeInventory: boolean) {
  const workspace = await prepareRepositoryWorkspace(root, "HEAD");
  workspaces.push(workspace);
  const repository = {
    sourcePath: workspace.sourcePath,
    requestedRevision: workspace.requestedRevision,
    revision: workspace.revision,
  };
  const mappings = includeInventory
    ? [
        mapRepositoryInventoryToG0({
          inventory: await buildRepositoryDiscoveryInventory({ workspace }),
          repository,
        }),
      ]
    : [];
  const gateInputs = (["G0", "G1", "G2", "G3", "G4", "G5"] as const).map((gateId) => ({
    gateId,
    repository,
    policyWorkspace: gateId === "G0" ? null : workspace,
    mappings: gateId === "G0" ? mappings : [],
  }));
  return { workspace, repository, gateInputs };
}

async function trackerObservation(
  _repository: { identitySha256: string; revision: string },
  issues: unknown[] = [],
) {
  const normalized = issues.map((issue) => sanitizeGitLabIssue(issue));
  return {
    issues: normalized,
    observationSha256: canonicalDigest({ authority: "non-authoritative", issues: normalized }),
  };
}

async function selectDocumentationMaturityWorkUnit(input: {
  assessment: Awaited<ReturnType<typeof assessDocumentationMaturityCascade>>;
  trackerObservation: Awaited<ReturnType<typeof trackerObservation>>;
  policyWorkspace: PreparedRepositoryWorkspace;
  clock?: () => Date;
}) {
  const inspected = await inspectDocumentationMaturityCascadeSelection({
    assessment: input.assessment,
    trackerIssues: input.trackerObservation.issues,
    policyWorkspace: input.policyWorkspace,
    observedAt: NOW.toISOString(),
    timeSource: input.clock ?? (() => NOW),
  });
  return inspected.selection;
}

function trackerIssue(
  iid: number,
  state: "opened" | "closed",
  findingFingerprint: string,
  materialEvidenceDigests: string[],
) {
  return {
    iid,
    state,
    updated_at: "2026-08-05T15:00:00.000Z",
    title: `Managed issue ${iid}`,
    description: [
      `[docsfab-fingerprint:${findingFingerprint}]`,
      ...materialEvidenceDigests.map((digest) => `[docsfab-material:${digest}]`),
    ].join("\n"),
    labels: ["docsfab-roadmap::managed"],
    milestone: null,
  };
}

function reworkUnit(
  source: DocumentationMaturityWorkUnitV1,
  key: string,
  overrides: Partial<DocumentationMaturityWorkUnitV1>,
): DocumentationMaturityWorkUnitV1 {
  const unit = structuredClone(source);
  Object.assign(unit, overrides, {
    findingFingerprint: canonicalDigest(`finding:${key}`),
    id: overrides.id ?? `work:${key}`,
  });
  unit.workUnitFingerprint = canonicalDigest({
    schemaVersion: 1,
    findingFingerprint: unit.findingFingerprint,
    requirement: unit.requirement,
    scopeSha256: unit.scopeSha256,
    workflow: unit.workflow,
    acceptanceCriteria: unit.acceptanceCriteria,
    verification: unit.verification,
  });
  unit.workUnitSha256 = canonicalDigest(without(unit, "workUnitSha256"));
  return unit;
}

function withSyntheticG1Target(
  source: Awaited<ReturnType<typeof assessDocumentationMaturityCascade>>,
) {
  const assessment = structuredClone(source);
  const baseFinding = assessment.gates[0]!.findings[0]!;
  const baseUnit = assessment.gates[0]!.workUnits[0]!;
  const gate = assessment.gates[1]!;
  const finding = structuredClone(baseFinding);
  Object.assign(finding, {
    id: "finding:exception-target",
    findingKey: "exception-target",
    gateId: "G1" as const,
    affectedPaths: ["guide/independent-target.md"],
    dependencyFingerprints: [],
  });
  finding.fingerprint = documentationMaturityFindingFingerprint(finding);
  finding.findingSha256 = canonicalDigest(without(finding, "findingSha256"));
  const unit = structuredClone(baseUnit);
  Object.assign(unit, {
    id: "work:exception-target",
    gateId: "G1" as const,
    findingFingerprint: finding.fingerprint,
    affectedPaths: [...finding.affectedPaths],
    dependencyFingerprints: [],
    dependsOnWorkUnitIds: [],
  });
  unit.workUnitFingerprint = canonicalDigest({
    schemaVersion: 1,
    findingFingerprint: unit.findingFingerprint,
    requirement: unit.requirement,
    scopeSha256: unit.scopeSha256,
    workflow: unit.workflow,
    acceptanceCriteria: unit.acceptanceCriteria,
    verification: unit.verification,
  });
  unit.workUnitSha256 = canonicalDigest(without(unit, "workUnitSha256"));
  gate.findings = [finding];
  gate.workUnits = [unit];
  gate.checks[0] = {
    ...gate.checks[0]!,
    state: "finding",
    evidenceSha256s: [finding.findingSha256],
    findingFingerprints: [finding.fingerprint],
    limitationCodes: [],
  };
  gate.disposition = "not-ready";
  gate.evaluationSha256 = canonicalDigest(without(gate, "evaluationSha256"));
  assessment.assessmentSha256 = canonicalDigest(without(assessment, "assessmentSha256"));
  return { assessment, target: unit };
}

async function repositoryFixture(options: {
  validation: boolean;
  productNeed: "required" | "not-required" | "unknown";
  cascadePolicy?: string;
  cascadeEvidence?: string;
}): Promise<string> {
  const root = await temporary.create("docsfab-maturity-cascade-");
  await initFixtureRepo(root);
  await mkdir(join(root, "guide"), { recursive: true });
  await writeFile(join(root, "guide", "start.md"), "# Start\n\n## Run\n\n1. Run it.\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: options.validation ? { test: "node --test" } : {},
    }),
  );
  await writeFile(
    join(root, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
    canonicalJson(hostPolicy(options.productNeed)),
  );
  if (options.cascadePolicy !== undefined) {
    await writeFile(join(root, DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH), options.cascadePolicy);
  }
  if (options.cascadeEvidence !== undefined) {
    await writeFile(join(root, "guide", "exception-evidence.md"), options.cascadeEvidence);
  }
  await commitFixture(root, "fixture");
  return root;
}

function hostPolicy(productNeed: "required" | "not-required" | "unknown") {
  const documentationType =
    productNeed === "not-required"
      ? "none"
      : productNeed === "unknown"
        ? "unknown"
        : "developer-reference";
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-host-policy" as const,
    productNeed: {
      repositoryType: "library" as const,
      documentationType,
      gateIds: ["G1", "G2", "G3", "G4", "G5"],
      decision: {
        id: `fixture-${productNeed}`,
        need: productNeed,
        authorityId: "fixture-product-governance",
        decidedAt: "2026-08-05T12:00:00.000Z",
        evidenceSha256:
          productNeed === "unknown" ? null : canonicalDigest(`fixture-${productNeed}`),
        predecessorDecisionSha256: null,
      },
    },
    modularity: {
      activePolicyId: "fixture-modularity",
      activePolicyVersion: "1",
      policies: [
        {
          id: "fixture-modularity",
          version: "1",
          maximumSectionsPerDocument: 32,
          maximumSectionDepth: 8,
        },
      ],
    },
  };
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = value;
  return rest;
}
