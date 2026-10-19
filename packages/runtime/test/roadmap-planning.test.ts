// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

import { ROADMAP_SKILL_PACK_CONTRACTS } from "../src/skills/roadmap-pack.js";
import * as lineagePublicApi from "../src/lineage/index.js";
import * as roadmapPublicApi from "../src/roadmap/index.js";
import * as reviewDeliveryPublicApi from "../src/review-delivery/public.js";
import {
  assertRoadmapPlanningFresh as governedAssertFresh,
  decodeRoadmapPlanningInput,
  planRoadmap as governedPlanRoadmap,
  roadmapDigest,
  RoadmapPlanningError,
  serializeRoadmapPlanningArtifact as governedSerialize,
  validateRoadmapPlanningArtifact as governedValidate,
  type RoadmapHealthPlanningInput,
  type RoadmapPlanningCandidateInput,
  type RoadmapPlanningInput,
  type SanitizedRoadmapIssue,
  type RoadmapPlanningArtifact,
  type RoadmapPlanningSourceCapability,
} from "../src/roadmap/index.js";
import {
  internalCreateRoadmapPlanningHostAuthority,
  internalIssueRoadmapPlanningSourceCapability,
} from "../src/roadmap/planning-authority-internal.js";

const REVISION = "a".repeat(40);
const FROM = "b".repeat(40);
const CONTENT = "c".repeat(64);
const T0 = "2026-08-05T00:00:00.000Z";
const T1 = "2026-08-05T00:01:00.000Z";
const T2 = "2026-08-05T00:02:00.000Z";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/runtime-evaluation/roadmap/planning-cases.json", import.meta.url),
    "utf8",
  ),
) as {
  schemaVersion: number;
  cases: Array<{
    id: string;
    mode: "release" | "health" | "sweep";
    scope?: string;
    disposition: RoadmapPlanningCandidateInput["disposition"];
    relation: "none" | "exact" | "extend" | "conflict";
    confidence: number;
    cap: number;
    candidateCount?: number;
    expectedAction: string;
  }>;
};
const sourceAuthorities = new WeakMap<object, RoadmapPlanningSourceCapability>();
function sourceCapability(input: RoadmapPlanningInput): RoadmapPlanningSourceCapability {
  const decoded = decodeRoadmapPlanningInput(input);
  const digest = roadmapDigest({ source: decoded });
  const hostAuthority = internalCreateRoadmapPlanningHostAuthority(digest);
  return internalIssueRoadmapPlanningSourceCapability(hostAuthority, digest);
}
function planRoadmap(
  input: RoadmapPlanningInput,
  tracker: SanitizedRoadmapIssue[],
): RoadmapPlanningArtifact {
  const capability = sourceCapability(input);
  const artifact = governedPlanRoadmap(input, tracker, capability);
  sourceAuthorities.set(artifact, capability);
  return artifact;
}
function authorityFor(artifact: RoadmapPlanningArtifact): RoadmapPlanningSourceCapability {
  const authority = sourceAuthorities.get(artifact);
  if (!authority) throw new Error("missing test source authority");
  return authority;
}
function validateRoadmapPlanningArtifact(
  value: unknown,
  authority: RoadmapPlanningSourceCapability,
): RoadmapPlanningArtifact {
  return governedValidate(value, authority);
}
function serializeRoadmapPlanningArtifact(artifact: RoadmapPlanningArtifact): string {
  return governedSerialize(artifact, authorityFor(artifact));
}
function assertRoadmapPlanningFresh(
  artifact: RoadmapPlanningArtifact,
  repository: { revision: string; contentDigest: string },
  tracker: SanitizedRoadmapIssue[],
): RoadmapPlanningArtifact {
  return governedAssertFresh(artifact, repository, tracker, authorityFor(artifact));
}

describe("read-only roadmap planning", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("exposes only public roadmap, lineage, and inputs package surfaces", () => {
    const exported = Object.keys(roadmapPublicApi);
    expect(exported).not.toContain("createRoadmapPlanningHostAuthority");
    expect(exported).not.toContain("issueRoadmapPlanningSourceCapability");
    expect(
      exported.every((name) => !name.startsWith("internal") && !name.includes("HostAuthority")),
    ).toBe(true);
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, string> };
    expect(packageJson.exports).toEqual({
      "./roadmap": "./dist/roadmap/index.js",
      "./lineage": "./dist/lineage/index.js",
      "./inputs": "./dist/inputs/index.js",
      "./canon": "./dist/canon/index.js",
      "./publication": "./dist/publication/index.js",
      "./review-delivery": "./dist/review-delivery/public.js",
    });
    expect(Object.keys(reviewDeliveryPublicApi)).toEqual([
      "planRetainedReviewDelivery",
      "prepareRetainedReviewFeedback",
    ]);
    expect(reviewDeliveryPublicApi).not.toHaveProperty("createReviewDeliveryGrant");
    expect(
      Object.keys(reviewDeliveryPublicApi).some((name) => /Authority|Factory/u.test(name)),
    ).toBe(false);
    expect(
      Object.values(packageJson.exports ?? {}).every((path) => !path.includes("internal")),
    ).toBe(true);
    expect(lineagePublicApi.createTaskLineageArtifacts).toBeTypeOf("function");
    expect(lineagePublicApi.decodeTaskOrigin).toBeTypeOf("function");
    expect(
      Object.keys(lineagePublicApi).every(
        (name) => !name.startsWith("internal") && !name.includes("HostAuthority"),
      ),
    ).toBe(true);
  });

  it("executes every checked-in authority fixture", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.cases.map((item) => item.id)).toEqual([
      "release-boundary",
      "post-freeze-sweep",
      "whole-repo-health",
      "scoped-health",
      "existing-duplicate",
      "partial-overlap",
      "conflicting-issue",
      "low-confidence",
      "proposal-cap",
    ]);
    for (const authority of fixture.cases) {
      const artifact = executeAuthorityCase(authority);
      expect(
        artifact.rankedProposals.some((proposal) => proposal.action === authority.expectedAction),
        authority.id,
      ).toBe(true);
    }
  });

  it("accounts for a release boundary exactly once with stable four-way planning", () => {
    const candidates = [
      candidate("documented", "docs/documented.md", "documented", false),
      candidate("no-impact", "src/no-impact.ts", "no-doc-impact", false),
      candidate("update", "docs/update.md", "needs-update"),
      candidate("new", "docs/new.md", "needs-new-doc"),
    ];
    const input = releaseInput(candidates);
    const first = planRoadmap(input, []);
    const reordered = planRoadmap(
      {
        ...input,
        units: [...input.units].reverse(),
        candidates: [...input.candidates].reverse(),
      },
      [],
    );

    expect(first.accountedUnitIds).toHaveLength(4);
    expect(new Set(first.accountedUnitIds).size).toBe(4);
    expect(first.ledger.findings.map((item) => item.disposition).sort()).toEqual([
      "documented",
      "needs-new-doc",
      "needs-update",
      "no-doc-impact",
    ]);
    expect(first.mutationPlan?.operations).toHaveLength(2);
    expect(reordered.mutationPlan?.operations.map((item) => item.key)).toEqual(
      first.mutationPlan?.operations.map((item) => item.key),
    );
    expect(first.readOnly).toBe(true);
    expect(first.authorization).toBeNull();
  });

  it("requires authenticated repository-relative health evidence and supports scope", () => {
    const whole = planRoadmap(
      healthInput([
        candidate("repair", "docs/guide.md", "repair"),
        candidate("healthy", "README.md", "healthy", false),
      ]),
      [],
    );
    expect(whole.ledger.boundary.mode).toBe("documentation-health");
    expect(
      whole.ledger.findings.every((item) =>
        item.affectedPaths.every((path) => !path.startsWith("/")),
      ),
    ).toBe(true);

    const scopedInput = healthInput([candidate("scoped", "docs/api/page.md", "repair")]);
    scopedInput.scope = "docs/api";
    scopedInput.docAudit.scope = "docs/api";
    scopedInput.docAudit.digest = roadmapDigest(scopedInput.docAudit);
    expect(planRoadmap(scopedInput, []).ledger.findings[0]!.affectedPaths).toEqual([
      "docs/api/page.md",
    ]);
    expectPlanningError(
      () => planRoadmap({ ...scopedInput, scope: "docs/other" }, []),
      "invalid-input",
    );

    const staleAudit = {
      ...scopedInput.docAudit,
      repositoryRevision: FROM,
      digest: "0".repeat(64),
    };
    staleAudit.digest = roadmapDigest(staleAudit);
    expectPlanningError(
      () => planRoadmap({ ...scopedInput, docAudit: staleAudit }, []),
      "stale-repository",
    );

    const supplemented = healthInput([candidate("supplemented", "docs/supplemented.md", "repair")]);
    supplemented.units.push(
      {
        id: "unit:structural",
        kind: "structural",
        path: "docs/supplemented.md",
        evidenceDigest: "1".repeat(64),
      },
      {
        id: "unit:impact",
        kind: "impact",
        path: "docs/supplemented.md",
        evidenceDigest: "2".repeat(64),
      },
    );
    supplemented.candidates[0]!.unitIds.push("unit:impact", "unit:structural");
    supplemented.candidates[0]!.unitIds.sort();
    supplemented.docAudit.findings[0]!.units = supplemented.units
      .map((unit) => ({ ...unit }))
      .sort((left, right) => left.id.localeCompare(right.id));
    supplemented.docAudit.findings[0]!.candidateDigest = roadmapDigest(supplemented.candidates[0]!);
    supplemented.docAudit.digest = roadmapDigest(supplemented.docAudit);
    expect(planRoadmap(supplemented, []).accountedUnitIds).toHaveLength(3);
  });

  it("runs deterministic reconciliation before semantic extend, supersede, and conflict review", () => {
    const exactInput = healthInput([candidate("exact", "docs/exact.md", "repair")]);
    const provisional = planRoadmap(exactInput, []);
    const fingerprint = provisional.ledger.findings[0]!.fingerprint;
    exactInput.semanticReconciliation = [
      {
        candidateId: "candidate:exact",
        issueIid: 999,
        decision: "conflict",
        confidence: 1,
        evidenceDigest: "9".repeat(64),
      },
    ];
    const exact = planRoadmap(exactInput, [issue(45, [fingerprint])]);
    expect(exact.rankedProposals[0]).toMatchObject({ action: "link", issueIid: 45 });
    expect(exact.reconciliationOrder).toEqual(["deterministic", "semantic"]);
    expect(exact.mutationPlan).toBeNull();

    const overlapInput = healthInput([candidate("overlap", "docs/overlap.md", "repair")]);
    overlapInput.semanticReconciliation = [
      {
        candidateId: "candidate:overlap",
        issueIid: 46,
        decision: "extend",
        confidence: 0.9,
        evidenceDigest: "8".repeat(64),
      },
    ];
    const overlap = planRoadmap(overlapInput, [issue(46)]);
    expect(overlap.rankedProposals[0]).toMatchObject({ action: "extend", issueIid: 46 });
    expect(overlap.mutationPlan?.operations[0]).toMatchObject({
      kind: "update",
      target: { source: "ledger-observation", targetKey: "issue:46" },
    });

    const supersedeInput = healthInput([candidate("supersede", "docs/supersede.md", "repair")]);
    supersedeInput.semanticReconciliation = [
      {
        candidateId: "candidate:supersede",
        issueIid: 47,
        decision: "supersede",
        confidence: 0.95,
        evidenceDigest: "7".repeat(64),
      },
    ];
    expect(planRoadmap(supersedeInput, [issue(47)]).rankedProposals[0]!.action).toBe("supersede");

    const conflictInput = healthInput([candidate("conflict", "docs/conflict.md", "repair")]);
    conflictInput.semanticReconciliation = [
      {
        candidateId: "candidate:conflict",
        issueIid: 48,
        decision: "conflict",
        confidence: 0.7,
        evidenceDigest: "6".repeat(64),
      },
    ];
    const conflict = planRoadmap(conflictInput, [issue(48)]);
    expect(conflict.rankedProposals[0]).toMatchObject({ action: "investigate", issueIid: 48 });
  });

  it("ranks with concise reasons, turns uncertainty into investigation, and caps high-confidence creates", () => {
    const high = candidate("high", "docs/high.md", "repair");
    high.rank = {
      impact: 4,
      urgency: 4,
      dependency: 4,
      scope: 4,
      verificationCost: 0,
      confidence: 0.99,
    };
    const second = candidate("second", "docs/second.md", "repair");
    second.rank = {
      impact: 3,
      urgency: 3,
      dependency: 3,
      scope: 3,
      verificationCost: 1,
      confidence: 0.9,
    };
    const low = candidate("uncertain", "docs/uncertain.md", "repair");
    low.rank.confidence = 0.4;
    low.review.disposition = "investigation";
    const input = healthInput([second, low, high]);
    input.proposalCap = 1;
    const artifact = planRoadmap(input, []);
    expect(artifact.rankedProposals[0]).toMatchObject({
      candidateId: "candidate:high",
      action: "create",
    });
    expect(
      artifact.rankedProposals.find((item) => item.candidateId === "candidate:second")!.action,
    ).toBe("none");
    expect(
      artifact.rankedProposals.find((item) => item.candidateId === "candidate:uncertain")!.action,
    ).toBe("investigate");
    expect(
      artifact.rankedProposals.every((item) =>
        item.reasons.some((reason) => reason.startsWith("confidence-")),
      ),
    ).toBe(true);
  });

  it("produces reviewable saga, issue, update, and closeout drafts with explicit context", () => {
    const saga = candidate("saga", "docs/saga.md", "repair");
    saga.draft = { ...saga.draft!, kind: "saga" };
    const child = candidate("child", "docs/child.md", "repair");
    child.draft = {
      ...child.draft!,
      kind: "issue",
      selfContained: false,
      requiredParentContext: "Use the constraints in candidate:saga.",
    };
    const createArtifact = planRoadmap(healthInput([saga, child]), []);
    expect(createArtifact.mutationPlan?.operations.map((item) => item.kind).sort()).toEqual([
      "issue",
      "saga",
    ]);
    expect(
      createArtifact.rankedProposals.find((item) => item.candidateId === "candidate:child")!.draft,
    ).toMatchObject({
      selfContained: false,
      requiredParentContext: "Use the constraints in candidate:saga.",
    });

    const update = candidate("update-draft", "docs/update.md", "repair");
    update.draft = { ...update.draft!, kind: "update" };
    const existingInput = healthInput([update]);
    existingInput.semanticReconciliation = [
      {
        candidateId: update.id,
        issueIid: 51,
        decision: "extend",
        confidence: 1,
        evidenceDigest: "5".repeat(64),
      },
    ];
    expect(planRoadmap(existingInput, [issue(51)]).mutationPlan?.operations[0]?.kind).toBe(
      "update",
    );

    const baselineCloseout = candidate("closeout", "docs/closeout.md", "repair");
    const base = planRoadmap(healthInput([baselineCloseout]), []);
    const closeout = structuredClone(baselineCloseout);
    closeout.draft = { ...closeout.draft!, kind: "closeout" };
    const { docAudit: _closeoutAudit, ...closeoutHealth } = healthInput([closeout]);
    const sweepInput: RoadmapPlanningInput = {
      ...closeoutHealth,
      mode: "sweep",
      baseLedger: base.ledger,
    };
    sweepInput.semanticReconciliation = [
      {
        candidateId: closeout.id,
        issueIid: 52,
        decision: "extend",
        confidence: 1,
        evidenceDigest: "6".repeat(64),
      },
    ];
    const sweepArtifact = planRoadmap(sweepInput, [issue(52)]);
    expect(sweepArtifact.ledger.sweeps[0]!.disposition).toBe("clean");
    expect(sweepArtifact.mutationPlan?.operations[0]?.kind).toBe("closure");
  });

  it("records a clean or new-finding post-freeze sweep without authorization", () => {
    const base = planRoadmap(healthInput([candidate("base", "docs/base.md", "repair")]), []);
    const sweepCandidate = candidate("sweep", "docs/sweep.md", "repair");
    const { docAudit: _sweepAudit, ...sweepHealth } = healthInput([sweepCandidate]);
    const sweep: RoadmapPlanningInput = {
      ...sweepHealth,
      mode: "sweep",
      baseLedger: base.ledger,
    };
    const artifact = planRoadmap(sweep, []);
    expect(artifact.ledger.sweeps[0]).toMatchObject({ disposition: "new-findings" });
    expect(artifact.authorization).toBeNull();
  });

  it("invalidates stale repository and tracker observations while preserving dry-run serialization", () => {
    const input = healthInput([candidate("fresh", "docs/fresh.md", "repair")]);
    input.semanticReconciliation = [
      {
        candidateId: "candidate:fresh",
        issueIid: 45,
        decision: "extend",
        confidence: 0.9,
        evidenceDigest: "8".repeat(64),
      },
    ];
    const tracker = [issue(45)];
    const artifact = planRoadmap(input, tracker);
    const serialized = serializeRoadmapPlanningArtifact(artifact);
    expect(validateRoadmapPlanningArtifact(JSON.parse(serialized), authorityFor(artifact))).toEqual(
      artifact,
    );
    expect(assertRoadmapPlanningFresh(artifact, input.repository, tracker)).toEqual(artifact);
    expectPlanningError(
      () => assertRoadmapPlanningFresh(artifact, { ...input.repository, revision: FROM }, tracker),
      "stale-repository",
    );
    expectPlanningError(
      () =>
        assertRoadmapPlanningFresh(artifact, input.repository, [
          { ...tracker[0]!, identityDigest: "f".repeat(64) },
        ]),
      "stale-tracker",
    );
    expectPlanningError(
      () => assertRoadmapPlanningFresh(artifact, input.repository, [...tracker, issue(46)]),
      "stale-tracker",
    );
    expectPlanningError(
      () => assertRoadmapPlanningFresh(artifact, input.repository, []),
      "stale-tracker",
    );
  });

  it("rejects incomplete release accounting and rehashed health scope substitutions", () => {
    const release = releaseInput([candidate("release-change", "docs/change.md", "needs-update")]);
    expectPlanningError(
      () => planRoadmap({ ...release, units: [], candidates: [] }, []),
      "unaccounted-boundary",
    );
    const wrongStatus = structuredClone(release);
    Object.assign(wrongStatus.units[0]!, { status: "deleted" });
    expectPlanningError(() => planRoadmap(wrongStatus, []), "unaccounted-boundary");

    const scoped = healthInput([candidate("inside", "docs/inside.md", "repair")]);
    scoped.scope = "docs";
    scoped.docAudit.scope = "docs";
    scoped.docAudit.digest = roadmapDigest(scoped.docAudit);
    const outside = structuredClone(scoped);
    outside.candidates[0]!.affectedPaths = ["src/outside.ts"];
    outside.candidates[0]!.draft!.evidencePaths = ["src/outside.ts"];
    outside.docAudit.findings[0]!.affectedPaths = ["src/outside.ts"];
    outside.docAudit.findings[0]!.candidateDigest = roadmapDigest(outside.candidates[0]!);
    outside.docAudit.digest = roadmapDigest(outside.docAudit);
    expectPlanningError(() => planRoadmap(outside, []), "invalid-input");

    const tupleMismatch = healthInput([candidate("tuple", "docs/candidate.md", "repair")]);
    tupleMismatch.docAudit.findings[0]!.units[0] = {
      id: "unit:tuple",
      kind: "doc-audit",
      path: "docs/unit.md",
      evidenceDigest: "1".repeat(64),
    };
    tupleMismatch.docAudit.digest = roadmapDigest(tupleMismatch.docAudit);
    expectPlanningError(() => planRoadmap(tupleMismatch, []), "invalid-input");
  });

  it("rejects rehashed proposal and v2 operation substitutions", () => {
    const artifact = planRoadmap(
      healthInput([candidate("binding", "docs/binding.md", "repair")]),
      [],
    );
    const substituted = structuredClone(artifact);
    substituted.rankedProposals[0]!.draft!.summary = "A substituted roadmap proposal.";
    substituted.digest = roadmapDigest(substituted);
    expectPlanningError(
      () => validateRoadmapPlanningArtifact(substituted, authorityFor(artifact)),
      "invalid-input",
    );

    const operation = structuredClone(artifact);
    operation.mutationPlan!.operations[0]!.findingIds = ["finding:substituted"];
    operation.mutationPlan!.digest = roadmapDigest(operation.mutationPlan!);
    operation.digest = roadmapDigest(operation);
    expect(() => validateRoadmapPlanningArtifact(operation, authorityFor(artifact))).toThrow();

    const authenticInput = healthInput([candidate("full-chain", "docs/full-chain.md", "repair")]);
    const authenticAuthority = sourceCapability(authenticInput);
    governedPlanRoadmap(authenticInput, [], authenticAuthority);
    const alteredInput = structuredClone(authenticInput);
    alteredInput.candidates[0]!.draft!.summary = "Fully rebuilt substituted material.";
    alteredInput.docAudit.findings[0]!.candidateDigest = roadmapDigest(alteredInput.candidates[0]!);
    alteredInput.docAudit.digest = roadmapDigest(alteredInput.docAudit);
    const alteredAuthority = sourceCapability(alteredInput);
    const alteredArtifact = governedPlanRoadmap(alteredInput, [], alteredAuthority);
    expectPlanningError(
      () => governedValidate(alteredArtifact, authenticAuthority),
      "invalid-input",
    );

    const renamedInput = structuredClone(authenticInput);
    renamedInput.candidates[0]!.id = "candidate:attacker-renamed";
    renamedInput.docAudit.findings[0]!.id = "candidate:attacker-renamed";
    renamedInput.docAudit.findings[0]!.candidateDigest = roadmapDigest(renamedInput.candidates[0]!);
    renamedInput.docAudit.digest = roadmapDigest(renamedInput.docAudit);
    const renamedAuthority = sourceCapability(renamedInput);
    const renamedArtifact = governedPlanRoadmap(renamedInput, [], renamedAuthority);
    expectPlanningError(
      () => governedValidate(renamedArtifact, authenticAuthority),
      "invalid-input",
    );

    const sameSource = healthInput([candidate("lineage", "docs/lineage.md", "repair")]);
    const decodedSameSource = decodeRoadmapPlanningInput(sameSource);
    const sameDigest = roadmapDigest({ source: decodedSameSource });
    const sameHost = internalCreateRoadmapPlanningHostAuthority(sameDigest);
    const firstCapability = internalIssueRoadmapPlanningSourceCapability(sameHost, sameDigest);
    const secondCapability = internalIssueRoadmapPlanningSourceCapability(sameHost, sameDigest);
    expect(firstCapability).not.toBe(secondCapability);
    const firstArtifact = governedPlanRoadmap(decodedSameSource, [], firstCapability);
    const secondArtifact = governedPlanRoadmap(decodedSameSource, [], secondCapability);
    expect(firstArtifact.digest).not.toBe(secondArtifact.digest);
    expect(governedValidate(structuredClone(firstArtifact), firstCapability)).toEqual(
      firstArtifact,
    );
    expectPlanningError(() => governedValidate(firstArtifact, secondCapability), "invalid-input");
    expectPlanningError(() => governedValidate(secondArtifact, firstCapability), "invalid-input");
  });

  it("fails closed on unaccounted units, unsafe paths, credentials, unknown fields, and inert-shape attacks", () => {
    const input = healthInput([candidate("attack", "docs/attack.md", "repair")]);
    expectPlanningError(
      () =>
        planRoadmap(
          {
            ...input,
            units: [
              ...input.units,
              {
                id: "unit:extra",
                kind: "doc-audit",
                path: "docs/extra.md",
                evidenceDigest: "e".repeat(64),
              },
            ],
          },
          [],
        ),
      "unaccounted-boundary",
    );
    expectPlanningError(
      () =>
        planRoadmap(
          {
            ...input,
            candidates: [{ ...input.candidates[0]!, affectedPaths: ["/Users/private.md"] }],
          },
          [],
        ),
      "invalid-input",
    );
    // DocsFab's own configured credential in a draft refuses (#1807). The
    // fixture rebuilds the audit package, so only the credential can refuse.
    const configured = candidate("attack", "docs/attack.md", "repair");
    configured.draft = { ...configured.draft!, summary: plantConfiguredCredential() };
    expectPlanningError(() => planRoadmap(healthInput([configured]), []), "unsafe-content");
    clearPlantedCredential();
    // A draft that only starts like an issuer token plans and is recorded.
    const shaped = candidate("attack", "docs/attack.md", "repair");
    shaped.draft = { ...shaped.draft!, summary: "glpat-secret" };
    const planned = collectCredentialFindings(() => planRoadmap(healthInput([shaped]), []));
    expect(planned.findings).toContainEqual({
      code: "credential-like-content",
      location: "roadmap-planning:$.candidates[0].draft.summary",
      rule: "credential.gitlab-token",
    });
    const unexpectedInput = Object.assign({}, input, { unexpected: true });
    expectPlanningError(() => planRoadmap(unexpectedInput, []), "invalid-input");

    let hits = 0;
    const units = [...input.units];
    Object.defineProperty(units, "0", {
      enumerable: true,
      get: () => {
        hits += 1;
        return input.units[0];
      },
    });
    expectPlanningError(() => planRoadmap({ ...input, units }, []), "invalid-input");
    expect(hits).toBe(0);
    let traps = 0;
    const proxy = new Proxy([...input.candidates], {
      get: (target, key, receiver) => {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expectPlanningError(() => planRoadmap({ ...input, candidates: proxy }, []), "invalid-input");
    expect(traps).toBe(0);
  });
});

function executeAuthorityCase(authority: (typeof fixture.cases)[number]) {
  const count = authority.candidateCount ?? 1;
  const candidates = Array.from({ length: count }, (_, index) => {
    const value = candidate(
      `${authority.id}-${index}`,
      `${authority.scope ?? "docs"}/${authority.id}-${index}.md`,
      authority.disposition,
    );
    value.rank.confidence = authority.confidence;
    if (authority.confidence < 0.8) value.review.disposition = "investigation";
    return value;
  });
  let input: RoadmapPlanningInput;
  if (authority.mode === "release") input = releaseInput(candidates);
  else if (authority.mode === "sweep") {
    const base = planRoadmap(
      healthInput([candidate("fixture-base", "docs/base.md", "repair")]),
      [],
    );
    const { docAudit: _fixtureAudit, ...fixtureHealth } = healthInput(candidates);
    input = { ...fixtureHealth, mode: "sweep", baseLedger: base.ledger };
  } else {
    input = healthInput(candidates);
    if (authority.scope) {
      input.scope = authority.scope;
      input.docAudit.scope = authority.scope;
      input.docAudit.digest = roadmapDigest(input.docAudit);
    }
  }
  input.proposalCap = authority.cap;
  let tracker: SanitizedRoadmapIssue[] = [];
  if (authority.relation === "exact") {
    const provisional = planRoadmap(input, []);
    tracker = [issue(80, [provisional.ledger.findings[0]!.fingerprint])];
  } else if (authority.relation !== "none") {
    tracker = [issue(80)];
    input.semanticReconciliation = [
      {
        candidateId: candidates[0]!.id,
        issueIid: 80,
        decision: authority.relation,
        confidence: authority.confidence,
        evidenceDigest: "9".repeat(64),
      },
    ];
  }
  return planRoadmap(input, tracker);
}

function healthInput(candidates: RoadmapPlanningCandidateInput[]): RoadmapHealthPlanningInput {
  const project = {
    provider: "gitlab",
    host: "gitlab.example.com",
    fullPath: "group/docsfab",
    projectId: 422_255,
  };
  const units = candidates.map((item) => ({
    id: item.unitIds[0]!,
    kind: "doc-audit" as const,
    path: item.affectedPaths[0]!,
    evidenceDigest: item.evidenceDigest,
  }));
  const docAudit = {
    kind: "authenticated-doc-audit-package" as const,
    schemaVersion: 1 as const,
    runId: "run:audit",
    workflow: "review-documentation" as const,
    status: "succeeded" as const,
    repositoryRevision: REVISION,
    repositoryContentDigest: CONTENT,
    projectIdentityDigest: roadmapDigest(project),
    findings: candidates.map((item) => ({
      id: item.id,
      units: units.filter((unit) => item.unitIds.includes(unit.id)).map((unit) => ({ ...unit })),
      affectedPaths: [...item.affectedPaths],
      evidenceDigest: item.evidenceDigest,
      candidateDigest: roadmapDigest(item),
    })),
    digest: "0".repeat(64),
  };
  docAudit.digest = roadmapDigest(docAudit);
  return {
    kind: "docsfab-roadmap-planning-input",
    schemaVersion: 1,
    mode: "health",
    repository: { revision: REVISION, contentDigest: CONTENT },
    project,
    observedAt: T1,
    expiresAt: T2,
    units,
    candidates,
    semanticReconciliation: [],
    proposalCap: 10,
    docAudit,
  };
}

function releaseInput(candidates: RoadmapPlanningCandidateInput[]) {
  const project = {
    provider: "gitlab",
    host: "gitlab.example.com",
    fullPath: "group/docsfab",
    projectId: 422_255,
  };
  const changes = candidates
    .map((item) => {
      const material = { status: "modified" as const, path: item.affectedPaths[0]! };
      return { ...material, evidenceDigest: roadmapDigest(material) };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const releaseBoundary = {
    kind: "git-release-boundary" as const,
    fromRevision: FROM,
    toRevision: REVISION,
    fromTreeDigest: "1".repeat(64),
    toTreeDigest: CONTENT,
    diffDigest: "2".repeat(64),
    projectIdentityDigest: roadmapDigest(project),
    changes,
    digest: "0".repeat(64),
  };
  releaseBoundary.digest = roadmapDigest(releaseBoundary);
  return {
    ...healthInput(candidates),
    mode: "release" as const,
    fromRevision: FROM,
    toRevision: REVISION,
    releaseRef: "release:v1",
    releasePackContractSha256: ROADMAP_SKILL_PACK_CONTRACTS["release-docs-epic"].contractSha256,
    units: candidates.map((item) => ({
      id: item.unitIds[0]!,
      kind: "change" as const,
      path: item.affectedPaths[0]!,
      status: "modified" as const,
      evidenceDigest: changes.find((change) => change.path === item.affectedPaths[0])!
        .evidenceDigest,
    })),
    releaseBoundary,
    docAudit: undefined,
  };
}

function candidate(
  id: string,
  path: string,
  disposition: RoadmapPlanningCandidateInput["disposition"],
  withDraft = true,
): RoadmapPlanningCandidateInput {
  const evidence = id.slice(0, 1).match(/[a-f]/u)?.[0] ?? "e";
  return {
    id: `candidate:${id}`,
    category: "documentation-gap",
    severity: "p1",
    disposition,
    unitIds: [`unit:${id}`],
    affectedPaths: [path],
    evidenceDigest: evidence.repeat(64),
    rank: { impact: 3, urgency: 2, dependency: 1, scope: 2, verificationCost: 1, confidence: 0.9 },
    review: {
      disposition: "accepted",
      rationaleCode: "adversarial-review-passed",
      evidenceDigest: "f".repeat(64),
    },
    ...(withDraft
      ? {
          draft: {
            kind: "issue" as const,
            title: `Improve ${id}`,
            summary: `Evidence-backed work for ${id}.`,
            acceptanceCriteria: ["The documented gap is resolved."],
            verification: ["Run the bounded documentation checks."],
            evidencePaths: [path],
            selfContained: true,
          },
        }
      : {}),
  };
}

function issue(iid: number, findingFingerprints: string[] = []): SanitizedRoadmapIssue {
  return {
    iid,
    state: "opened",
    updatedAt: T0,
    identityDigest: String(iid % 10).repeat(64),
    findingFingerprints,
    materialEvidenceDigests: [],
  };
}

function expectPlanningError(action: () => unknown, code: RoadmapPlanningError["code"]): void {
  try {
    action();
    throw new Error("Expected RoadmapPlanningError");
  } catch (error) {
    expect(error).toBeInstanceOf(RoadmapPlanningError);
    expect((error as RoadmapPlanningError).code).toBe(code);
  }
}
