// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  attestDocumentationGapReconciliation,
  createDocumentationGapLedger,
  createDocChangeDeltaRunProvenanceAuthority,
  DocChangeDeltaProjectorError,
  projectDocChangeDeltaFromGapLedger,
  projectDocumentationSearchFindings,
  validateDocChangeDelta,
  validateProjectedDocChangeDelta,
  type DocChangeDeltaReadinessWorkUnitSourceV1,
  type DocChangeDeltaRunBindingsV1,
} from "../src/search/index.js";
import {
  boundedAbsence,
  readinessEvidenceAt,
  REPOSITORY_IDENTITY,
  terminalSearch,
} from "./helpers/search-progress-fixture.js";

const REVISION = "a".repeat(40);
const NEXT_REVISION = "c".repeat(40);
const CONTENT = "d".repeat(64);
const RUN_RECORD = "e".repeat(64);
const SNAPSHOT_AFTER_WRITE = "f".repeat(64);
const SHA = (value: string) => createHash("sha256").update(value).digest("hex");

describe("DocChangeDelta projector from gap ledger (#251)", () => {
  it("projects ADDED open gaps and MODIFIED history from fixture ledger + run bindings", () => {
    const absenceEvidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const absenceFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: absenceEvidence,
    });
    const absenceLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: absenceFindings,
    });

    const foundEvidence = readinessEvidenceAt(
      REVISION,
      (target) => terminalSearch(target, "found", "match"),
      SNAPSHOT_AFTER_WRITE,
    );
    const foundFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: foundEvidence,
    });
    // Keep one gap open (ADDED) and advance the other through coverage change (MODIFIED).
    const mixedFindings = [absenceFindings[0]!, foundFindings[1]!];
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: mixedFindings,
      priorLedgers: [absenceLedger],
    });

    const runBindings = bindingsFor(ledger);
    const delta = projectDocChangeDeltaFromGapLedger({ ledger, runBindings });

    expect(delta.trackerMutation).toBe("not-authorized");
    expect(delta.sourceLedgerSha256).toBe(ledger.ledgerSha256);
    expect(delta.sourceRunRecordSha256).toBe(RUN_RECORD);
    expect(delta.repositoryRevision).toBe(REVISION);
    expect(delta.entries.some((entry) => entry.section === "added")).toBe(true);
    expect(delta.entries.some((entry) => entry.section === "modified")).toBe(true);
    expect(delta.entries.every((entry) => entry.evidence.observationSha256 !== null)).toBe(true);
    expect(JSON.stringify(delta)).not.toContain("/selected/");
    expect(JSON.stringify(delta)).not.toContain("Does the");

    const provenance = createDocChangeDeltaRunProvenanceAuthority({
      sourceRunRecordSha256: delta.sourceRunRecordSha256,
      sourceLedgerSha256: delta.sourceLedgerSha256,
      repositoryIdentitySha256: delta.repositoryIdentitySha256,
      repositoryRevision: delta.repositoryRevision,
      repositoryContentDigestSha256: delta.repositoryContentDigestSha256,
    });
    expect(validateDocChangeDelta({ delta, provenance })).toEqual(delta);
    expect(validateProjectedDocChangeDelta({ delta, ledger, runBindings })).toEqual(delta);
  });

  it("projects REMOVED when reconciliation evidence supports explicit closure", () => {
    const absenceEvidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const absenceFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: absenceEvidence,
    });
    const absenceLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: absenceFindings,
    });
    const foundEvidence = readinessEvidenceAt(
      REVISION,
      (target) => terminalSearch(target, "found", "match"),
      SNAPSHOT_AFTER_WRITE,
    );
    const foundFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: foundEvidence,
    });
    const resolved = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: foundFindings,
      priorLedgers: [absenceLedger],
    });
    const stableGapId = resolved.entries[0]!.stableGapId;
    const fixed = attestDocumentationGapReconciliation({
      ledger: resolved,
      stableGapId,
      status: "fixed",
      repositoryRevision: REVISION,
      evidenceSha256: SHA("fixed-evidence"),
    });
    const verified = attestDocumentationGapReconciliation({
      ledger: fixed,
      stableGapId,
      status: "verified",
      repositoryRevision: REVISION,
      evidenceSha256: SHA("verified-evidence"),
    });

    const runBindings = bindingsFor(verified);
    const delta = projectDocChangeDeltaFromGapLedger({
      ledger: verified,
      runBindings,
    });
    expect(
      delta.entries.some(
        (entry) =>
          entry.section === "removed" &&
          entry.stableId === stableGapId &&
          entry.displayLifecycle === "verified" &&
          entry.codes.includes("disposition.closed"),
      ),
    ).toBe(true);
  });

  it("projects readiness missing work units as ADDED when present on the same run", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
    });
    const observation = findings[0]!.observationSha256;
    const workUnits: DocChangeDeltaReadinessWorkUnitSourceV1[] = [
      {
        id: "release-work:artifact",
        state: "missing",
        workUnitSha256: SHA("work-unit"),
        observationSha256: observation,
        findingSha256: findings[0]!.evidenceIdentity.searchFindingSha256,
        repositoryIdentitySha256: REPOSITORY_IDENTITY,
        repositoryRevision: REVISION,
      },
    ];
    const runBindings = bindingsFor(ledger);
    const delta = projectDocChangeDeltaFromGapLedger({
      ledger,
      runBindings,
      readinessWorkUnits: workUnits,
    });
    expect(
      delta.entries.some(
        (entry) =>
          entry.section === "added" &&
          entry.stableId === "release-work:artifact" &&
          entry.codes.includes("readiness.missing"),
      ),
    ).toBe(true);
    expect(
      validateProjectedDocChangeDelta({
        delta,
        ledger,
        runBindings,
        readinessWorkUnits: workUnits,
      }),
    ).toEqual(delta);
  });

  it("fails closed on mismatched revision bindings", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
    });
    expect(() =>
      projectDocChangeDeltaFromGapLedger({
        ledger,
        runBindings: {
          ...bindingsFor(ledger),
          repositoryRevision: NEXT_REVISION,
        },
      }),
    ).toThrow(DocChangeDeltaProjectorError);
  });

  it("fails closed on substituted ledger digest binding", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
    });
    expect(() =>
      projectDocChangeDeltaFromGapLedger({
        ledger,
        runBindings: {
          ...bindingsFor(ledger),
          expectedLedgerSha256: SHA("substituted-ledger"),
        },
      }),
    ).toThrow(DocChangeDeltaProjectorError);
  });

  it("fails closed when readiness work unit lacks observation digests", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
    });
    expect(() =>
      projectDocChangeDeltaFromGapLedger({
        ledger,
        runBindings: bindingsFor(ledger),
        readinessWorkUnits: [
          {
            id: "release-work:artifact",
            state: "missing",
            workUnitSha256: SHA("work-unit"),
            observationSha256: null,
            findingSha256: null,
            repositoryIdentitySha256: REPOSITORY_IDENTITY,
            repositoryRevision: REVISION,
          },
        ],
      }),
    ).toThrow(DocChangeDeltaProjectorError);
  });

  it("fails closed when reconstructed delta does not match admitted sources", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
    });
    const runBindings = bindingsFor(ledger);
    const delta = projectDocChangeDeltaFromGapLedger({ ledger, runBindings });
    const otherEvidence = readinessEvidenceAt(REVISION, (target) =>
      terminalSearch(target, "found", "match"),
    );
    const otherFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: otherEvidence,
    });
    const otherLedger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings: otherFindings,
    });
    expect(() =>
      validateProjectedDocChangeDelta({
        delta,
        ledger: otherLedger,
        runBindings: bindingsFor(otherLedger),
      }),
    ).toThrow(DocChangeDeltaProjectorError);
  });

  it("never claims write or tracker authority", () => {
    const evidence = readinessEvidenceAt(REVISION, boundedAbsence);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({
      currentRevision: REVISION,
      findings,
    });
    const delta = projectDocChangeDeltaFromGapLedger({
      ledger,
      runBindings: bindingsFor(ledger),
    });
    expect(delta.trackerMutation).toBe("not-authorized");
    expect(Object.keys(delta)).not.toContain("writeAuthorization");
    expect(Object.keys(delta)).not.toContain("roadmapApply");
  });
});

function bindingsFor(ledger: { ledgerSha256: string }): DocChangeDeltaRunBindingsV1 {
  return {
    sourceRunRecordSha256: RUN_RECORD,
    repositoryIdentitySha256: REPOSITORY_IDENTITY,
    repositoryRevision: REVISION,
    repositoryContentDigestSha256: CONTENT,
    expectedLedgerSha256: ledger.ledgerSha256,
  };
}
