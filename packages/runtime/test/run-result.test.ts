// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import type {
  EditorialDecisionArtifactReferenceV3,
  EditorialDecisionPayloadV1,
} from "../src/artifacts/contracts.js";
import { limit } from "../src/config/limits.js";
import {
  buildRunResultV1,
  decodeRunEditorialOutcomeV1,
  decodeRunResultV1,
  projectRunEditorialOutcome,
  projectRunProduct,
  RUN_RESULT_SCHEMA_VERSION,
  serializeRunResultV1,
  type BuildRunResultInput,
} from "../src/operator/run-result.js";
import {
  NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
  NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION,
} from "../src/artifacts/editorial-decision.js";
import {
  buildRunHumanNextCommand,
  collectRunResultNextSteps,
  formatRunSummary,
} from "../src/operator/run-summary.js";
import { admittedKeptUnchangedPages } from "../src/workflow-contracts/kept-pages.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import { assertRunRecordEditorialDeliveryEligible } from "../src/delivery/run-record.js";
import {
  createDocumentationGapLedger,
  projectDocumentationSearchFindings,
} from "../src/search/index.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  credentialFindingLocationReadBound,
  credentialFindingPresentationLocationReadBound,
  escapeCredentialFindingLocation,
} from "../src/security/credential-findings.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plainConfiguredCredential } from "./helpers/planted-configured-credential.js";
import {
  projectRunRetainedDeliveryV1,
  type RunRetainedDeliveryV1,
} from "../src/records/retained-delivery.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { normalizeWorkflowSearchEvidence } from "../src/workflow-contracts/search.js";
import type { WorkflowBranchCoverageV1 } from "../src/workflow-contracts/contracts.js";
import {
  createWorkflowOutcome,
  decodeRunRecordEditorialEvidence,
  workflowOutcomeArtifactEvidence,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../src/workflow-contracts/outcome.js";

const REVISION = "a".repeat(40);
const PATCH_SHA256 = "b".repeat(64);
const CONTENT_DIGEST_SHA256 = "c".repeat(64);

const PUBLIC_CREDENTIAL_FINDING = {
  code: "credential-like-content" as const,
  location: "docs/quickstart.md:23",
  rule: "credential.nvidia-api-key",
};

function publicResultDigest(body: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(body as JsonEvidenceValue), "utf8")
    .digest("hex");
}

describe("retained delivery display", () => {
  const retained: RunRetainedDeliveryV1 = {
    status: "retained",
    worktrees: ["/owned/delivery/attempt/repository"],
    branches: ["docsfab-run/owned"],
    keptBranches: [],
    cleanupPreviewCommand: "docsfab runs delete run-1 --state-dir /owned/runs",
    explanation: null,
  };

  it("binds the closed display in the public digest without changing execution or MR lookup", () => {
    const ordinary = buildRunResultV1(minimalInput());
    const result = buildRunResultV1(minimalInput({ retainedDelivery: retained }));
    expect(result.retainedDelivery).toEqual(retained);
    expect(result.execution).toEqual(ordinary.execution);
    expect(result.publication).toBe(ordinary.publication);
    expect(result.resultSha256).not.toBe(ordinary.resultSha256);
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result)))).toEqual(result);
    expect(ordinary).not.toHaveProperty("retainedDelivery");
  });

  it("rejects private authority fields in the actual public builder and decoder", () => {
    const injected = { ...retained, confirmation: "private deletion confirmation" };
    expect(() => buildRunResultV1(minimalInput({ retainedDelivery: injected }))).toThrow(
      "retained delivery display does not match its contract",
    );
    const { resultSha256: _digest, ...body } = buildRunResultV1(minimalInput());
    const changed = { ...body, retainedDelivery: injected };
    expect(() =>
      decodeRunResultV1({ ...changed, resultSha256: publicResultDigest(changed) }),
    ).toThrow("retained delivery display does not match its contract");
  });

  it("withholds a credential-bearing path and its entire executable command", () => {
    const credential = configureCredential(plainConfiguredCredential());
    const display = projectRunRetainedDeliveryV1({
      ...retained,
      worktrees: [`/owned/${credential}/repository`],
      cleanupPreviewCommand: `docsfab runs delete run-1 --state-dir /owned/${credential}`,
    });
    expect(display).toMatchObject({
      status: "inspection-required",
      worktrees: [],
      cleanupPreviewCommand: null,
    });
    const result = buildRunResultV1(minimalInput({ retainedDelivery: display }));
    expect(serializeRunResultV1(result)).not.toContain(credential);
    expect(serializeRunResultV1(result)).not.toContain("[REDACTED]");
  });
});

describe("public credential finding metadata", () => {
  it("copies valid finding metadata and binds it in the result digest", () => {
    const record = minimalRunRecord({
      credentialFindings: [PUBLIC_CREDENTIAL_FINDING],
    });
    const result = buildRunResultV1(minimalInput({ record }));
    expect(result.credentialFindings).toEqual([PUBLIC_CREDENTIAL_FINDING]);
    const { resultSha256, ...body } = result;
    expect(resultSha256).toBe(publicResultDigest(body));
    const { credentialFindings: _findings, ...withoutFindings } = body;
    expect(resultSha256).not.toBe(publicResultDigest(withoutFindings));
    expect(serializeRunResultV1(result)).not.toContain("private scanner evidence");
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result)))).toEqual(result);
  });

  it("refuses private finding fields in an initial raw record", () => {
    const record = minimalRunRecord({
      credentialFindings: [
        { ...PUBLIC_CREDENTIAL_FINDING, matchedText: "private scanner evidence" },
      ],
    } as unknown as Partial<RunRecord>);
    expect(() => buildRunResultV1(minimalInput({ record }))).toThrow();
  });

  it("rejects injected finding evidence even with a matching recomputed digest", () => {
    const { resultSha256: _digest, ...body } = buildRunResultV1(minimalInput());
    const injected = {
      ...body,
      credentialFindings: [{ ...PUBLIC_CREDENTIAL_FINDING, snippet: "private scanner evidence" }],
    };
    expect(() =>
      decodeRunResultV1({ ...injected, resultSha256: publicResultDigest(injected) }),
    ).toThrow();
  });

  it("rejects unsafe public locations even with a matching recomputed digest", () => {
    const { resultSha256: _digest, ...body } = buildRunResultV1(minimalInput());
    const injected = {
      ...body,
      credentialFindings: [
        { ...PUBLIC_CREDENTIAL_FINDING, location: "docs/\u202equickstart.md:23" },
      ],
    };
    expect(() =>
      decodeRunResultV1({ ...injected, resultSha256: publicResultDigest(injected) }),
    ).toThrow();
  });
  it("preserves retained locations admitted at the existing read bound", () => {
    const prefix = "docs/";
    const suffix = ".md:23";
    const location =
      prefix +
      "a".repeat(credentialFindingLocationReadBound() - prefix.length - suffix.length) +
      suffix;
    const record = minimalRunRecord({
      credentialFindings: [{ ...PUBLIC_CREDENTIAL_FINDING, location }],
    });
    const result = buildRunResultV1(minimalInput({ record }));
    expect(result.credentialFindings?.[0]?.location).toBe(location);
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result)))).toEqual(result);
  });

  it("preserves a complete escaped location at the retained read bound", () => {
    const location = "\u202e".repeat(credentialFindingLocationReadBound());
    const record = minimalRunRecord({
      credentialFindings: [{ ...PUBLIC_CREDENTIAL_FINDING, location }],
    });
    const result = buildRunResultV1(minimalInput({ record }));
    expect(result.credentialFindings?.[0]?.location).toBe(
      escapeCredentialFindingLocation(location),
    );
    expect(result.credentialFindings?.[0]?.location.length).toBe(
      credentialFindingPresentationLocationReadBound(),
    );
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result)))).toEqual(result);
    expect(record.credentialFindings?.[0]?.location).toBe(location);
  });

  it("keeps the original raw record location allowance", () => {
    const record = minimalRunRecord({
      credentialFindings: [
        {
          ...PUBLIC_CREDENTIAL_FINDING,
          location: "a".repeat(credentialFindingLocationReadBound() + 1),
        },
      ],
    });
    expect(() => buildRunResultV1(minimalInput({ record }))).toThrow();
  });

  it("refuses public locations beyond the possible display expansion", () => {
    const original = buildRunResultV1(minimalInput());
    const { resultSha256: _digest, ...body } = original;
    const injected = {
      ...body,
      credentialFindings: [
        {
          ...PUBLIC_CREDENTIAL_FINDING,
          location: "a".repeat(credentialFindingPresentationLocationReadBound() + 1),
        },
      ],
    };
    expect(() =>
      decodeRunResultV1({ ...injected, resultSha256: publicResultDigest(injected) }),
    ).toThrow();
    expect(() =>
      serializeRunResultV1({ ...injected, resultSha256: publicResultDigest(injected) }),
    ).toThrow();
  });

  it("refuses configured credentials in metadata rules with a safe actionable code", () => {
    const secret = configureCredential(plainConfiguredCredential("metadata-rule"));
    const record = minimalRunRecord({
      credentialFindings: [
        {
          ...PUBLIC_CREDENTIAL_FINDING,
          rule: `credential.${secret}`,
        },
      ],
    });
    let failure: unknown;
    try {
      buildRunResultV1(minimalInput({ record }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("credential-material");
    expect(envelope.nextAction).toContain("Inspect the saved run privately");
    expect(envelope.failure?.class).toBe("operator-input");
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });
});

function minimalRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-test-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    ...overrides,
  };
}

function minimalInput(overrides: Partial<BuildRunResultInput> = {}): BuildRunResultInput {
  return {
    record: minimalRunRecord(),
    recordPath: "/private/state/run-test-001.json",
    exitCode: 0,
    repositoryPath: "/tmp/example",
    ...overrides,
  };
}

function editorialNoChangeRecord(): {
  record: RunRecord;
  candidate: EditorialDecisionPayloadV1;
  candidateReference: EditorialDecisionArtifactReferenceV3;
  validated: EditorialDecisionPayloadV1;
  validatedReference: EditorialDecisionArtifactReferenceV3;
  coverage: WorkflowBranchCoverageV1;
} {
  const workspaceSnapshotSha256 = "d".repeat(64);
  const planBindingSha256 = "e".repeat(64);
  const candidateSha256 = "f".repeat(64);
  const validatedSha256 = "1".repeat(64);
  const common = {
    schemaVersion: 1 as const,
    kind: "docsfab-editorial-decision" as const,
    candidate: "no-change" as const,
    repositoryRevision: REVISION,
    workspaceSnapshotSha256,
    readerProvenanceSha256: "2".repeat(64),
    planBindingSha256,
    policySha256: "3".repeat(64),
    comparison: {
      kind: "base-head" as const,
      base_revision: "b".repeat(40),
      head_revision: REVISION,
    },
    rationaleSha256: "4".repeat(64),
  };
  const candidateReference: EditorialDecisionArtifactReferenceV3 = {
    kind: "editorial-decision",
    schemaVersion: 3,
    digest: candidateSha256,
    repositoryRevision: REVISION,
    repositoryContentDigest: "5".repeat(64),
  };
  const sourceReference = {
    kind: "context-packet" as const,
    schemaVersion: 1 as const,
    digest: "8".repeat(64),
    repositoryRevision: REVISION,
    repositoryContentDigest: candidateReference.repositoryContentDigest,
  };
  const candidate: EditorialDecisionPayloadV1 = {
    ...common,
    phase: "candidate",
    candidateArtifact: null,
    branchCoverage: null,
    evidenceRefs: [sourceReference],
    limitations: [],
    decisionSha256: candidateSha256,
  };
  const validatedReference: EditorialDecisionArtifactReferenceV3 = {
    ...candidateReference,
    digest: validatedSha256,
  };
  const validated: EditorialDecisionPayloadV1 = {
    ...common,
    phase: "validated",
    candidateArtifact: candidateReference,
    branchCoverage: {
      schemaVersion: 1,
      kind: "docsfab-workflow-branch-coverage-reference",
      coverageSha256: "7".repeat(64),
    },
    evidenceRefs: [candidateReference, sourceReference],
    limitations: ["experimental-quality-profile"],
    decisionSha256: validatedSha256,
  };
  const step = (id: string) => ({
    id,
    title: id,
    kind: "evaluate" as const,
    skill: id,
    mode: "read-only" as const,
    status: "succeeded" as const,
  });
  const record = minimalRunRecord({
    workflow: "update-documentation",
    steps: [
      {
        ...step("plan-documentation"),
        planBinding: {
          kind: "docsfab-documentation-plan",
          schemaVersion: 1,
          mode: "update",
          pages: [{ path: "docs/cli.md", disposition: "retain" }],
          sourceBindings: [],
          digest: planBindingSha256,
        },
      },
      step("verify-technical-accuracy"),
      step("review-documentation"),
      step("test-audience-understanding"),
      step("evaluate-document-quality"),
    ],
    artifacts: [
      { role: "output", stepId: "plan-documentation", reference: candidateReference },
      { role: "output", stepId: "evaluate-document-quality", reference: validatedReference },
    ],
  });
  const coverage = {
    schemaVersion: 1,
    kind: "docsfab-workflow-branch-coverage",
    workflow: "update-documentation",
    manifest: {} as WorkflowBranchCoverageV1["manifest"],
    manifestSha256: "6".repeat(64),
    repositoryRevision: REVISION,
    workspaceSnapshotSha256,
    selection: { branchId: "assess-no-change", candidateArtifact: candidateReference },
    requiredStepIds: record.steps.map((item) => item.id),
    excludedStepIds: ["derive-source-obligations", "write-documentation", "lint-documentation"],
    coverageSha256: "7".repeat(64),
  } satisfies WorkflowBranchCoverageV1;
  record.workflowBranchCoverage = coverage;
  return { record, candidate, candidateReference, validated, validatedReference, coverage };
}

function editorialDecodeOptions(
  value: ReturnType<typeof editorialNoChangeRecord>,
): WorkflowOutcomeDecodeOptionsV1 {
  const byDigest = new Map([
    [value.candidateReference.digest, value.candidate],
    [value.validatedReference.digest, value.validated],
  ]);
  return {
    decodeEditorialDecision(reference) {
      const decision = byDigest.get(reference.digest);
      if (!decision) throw new Error("missing retained decision bytes");
      return decision;
    },
    decodeWorkflowBranchCoverage(candidate) {
      if (candidate !== value.coverage) throw new Error("substituted coverage");
      return value.coverage;
    },
  };
}

function plannerFailureRecord(code: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return minimalRunRecord({
    workflow: "create-documentation",
    status: "failed",
    instruction: "Create docs/usage.md from approved repository evidence.",
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        kind: "evaluate",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        inference: { attempts: [{ outcome: "succeeded" }] } as never,
        planDiagnostic: {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code,
          responseSha256: "d".repeat(64),
          responseShape: "json-object",
        },
        summary: "PRIVATE_MODEL_TEXT_MUST_NOT_APPEAR",
        error: "sk-private-credential-must-not-appear",
      },
    ],
    error: "PRIVATE_RUN_ERROR_MUST_NOT_APPEAR",
    ...overrides,
  });
}

function malformedPlannerDiagnostic(
  mutate: (diagnostic: Record<string, unknown>, record: RunRecord) => void,
): RunRecord {
  const record = plannerFailureRecord("invalid-envelope");
  mutate(record.steps[0]!.planDiagnostic! as unknown as Record<string, unknown>, record);
  return record;
}

describe("RUN_RESULT_SCHEMA_VERSION stamping", () => {
  it("stamps schemaVersion from the exported constant, not a repeated literal", () => {
    const envelope = buildRunResultV1(minimalInput());
    // Comparing against the constant itself (rather than the literal `1`)
    // means a future bump to RUN_RESULT_SCHEMA_VERSION cannot silently leave
    // the stamped value disagreeing with the exported constant.
    expect(envelope.schemaVersion).toBe(RUN_RESULT_SCHEMA_VERSION);
  });
});

describe("serializeRunResultV1 round trip", () => {
  it("round-trips a minimal envelope: JSON.parse(serialize(x)) deep-equals x", () => {
    const envelope = buildRunResultV1(minimalInput());
    const parsed = JSON.parse(serializeRunResultV1(envelope)) as unknown;
    expect(parsed).toEqual(envelope);
  });

  it("round-trips a fully-populated envelope, including nested optional fields", () => {
    const envelope = buildRunResultV1(
      minimalInput({
        nextSteps: ["Review the patch.", "Publish when ready."],
        htmlReport: {
          url: "http://127.0.0.1:8787/reports/run-test-001/",
          path: "/private/state/reports/run-test-001/index.html",
          digestSha256: "d".repeat(64),
        },
      }),
    );
    const parsed = JSON.parse(serializeRunResultV1(envelope)) as unknown;
    expect(parsed).toEqual(envelope);
  });
});

describe("BuildRunResultInput optional fields", () => {
  describe("nextSteps", () => {
    it("defaults to an empty array when absent", () => {
      const envelope = buildRunResultV1(minimalInput());
      expect(envelope.nextSteps).toEqual([]);
    });

    it("carries the given nextSteps array through verbatim", () => {
      const nextSteps = ["Open a merge request.", "Ask a CODEOWNER to review."];
      const envelope = buildRunResultV1(minimalInput({ nextSteps }));
      expect(envelope.nextSteps).toEqual(nextSteps);
    });
  });

  describe("htmlReport", () => {
    it("is null when absent", () => {
      const envelope = buildRunResultV1(minimalInput());
      expect(envelope.htmlReport).toBeNull();
    });

    it("carries the given htmlReport object through verbatim", () => {
      const htmlReport = {
        url: "http://127.0.0.1:8787/reports/run-test-001/",
        path: "/private/state/reports/run-test-001/index.html",
        digestSha256: "e".repeat(64),
      };
      const envelope = buildRunResultV1(minimalInput({ htmlReport }));
      expect(envelope.htmlReport).toEqual(htmlReport);
    });
  });

  describe("repositoryContentDigestSha256", () => {
    let repositoryPath: string;

    afterEach(async () => {
      if (repositoryPath) await rm(repositoryPath, { recursive: true, force: true });
    });

    async function recordWithProjectableGapEvidence(): Promise<RunRecord> {
      repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-run-result-test-"));
      const workflow = getWorkflow("readiness");
      const step = workflow.steps[0]!;
      const plan = step.search!;
      const repository = {
        sourcePath: repositoryPath,
        requestedRevision: REVISION,
        revision: REVISION,
      };
      // An empty repository yields bounded-absence findings deterministically,
      // without stubbing search evidence by hand.
      const result = await new LocalWorkflowSearchCoordinator().search({
        runId: "run-result-test",
        repositoryPath,
        repository,
        workflow,
        step,
        plan,
        repositoryDefaultBranch: "main",
      });
      const evidence = normalizeWorkflowSearchEvidence({
        plan,
        repository,
        repositoryIdentitySha256: result.repositoryIdentitySha256,
        searches: result.searches,
      });
      const findings = projectDocumentationSearchFindings({
        workflow: "readiness",
        stepId: step.id,
        evidence,
      });
      const gapLedger = createDocumentationGapLedger({ currentRevision: REVISION, findings });
      return minimalRunRecord({
        repository,
        gapLedger,
        changes: {
          files: [{ path: "README.md", status: "modified" }],
          patch: {
            sha256: PATCH_SHA256,
            byteLength: 12,
            lineCount: 2,
            artifactPath: "/private/patches/changes.patch",
            format: "git-diff",
          },
        },
      });
    }

    it("yields an explicit repository-content-digest-unavailable limitation when absent", async () => {
      const record = await recordWithProjectableGapEvidence();
      const envelope = buildRunResultV1(
        minimalInput({ record, repositoryPath: record.repository.sourcePath }),
      );
      expect(envelope.execution.docChangeDelta).toEqual({
        status: "unavailable",
        limitation: "repository-content-digest-unavailable",
      });
    });

    it("changes the projected DocChangeDelta outcome when present", async () => {
      const record = await recordWithProjectableGapEvidence();
      const envelope = buildRunResultV1(
        minimalInput({
          record,
          repositoryPath: record.repository.sourcePath,
          repositoryContentDigestSha256: CONTENT_DIGEST_SHA256,
        }),
      );
      // The absent case above proves this exact limitation only fires when the
      // digest cannot be resolved; supplying it here must not still hit that
      // branch, whatever the ledger goes on to project.
      expect(envelope.execution.docChangeDelta).not.toEqual({
        status: "unavailable",
        limitation: "repository-content-digest-unavailable",
      });
    });
  });
});

describe("planner failure diagnosis", () => {
  it("projects a current invalid envelope without calling the record legacy", () => {
    const envelope = buildRunResultV1(
      minimalInput({ record: plannerFailureRecord("invalid-envelope"), exitCode: 1 }),
    );
    expect(envelope.product).toMatchObject({
      disposition: null,
      findings: [],
      limitations: ["structured-product-outcome-unavailable"],
      openDecisions: [],
    });
    expect(envelope.plannerDiagnostic).toEqual({
      category: "invalid-model-output",
      code: "invalid-envelope",
      responseShape: "json-object",
      responseSha256: "d".repeat(64),
    });
    const serialized = serializeRunResultV1(envelope);
    expect(serialized).not.toContain("legacy-no-product-disposition");
    expect(serialized).not.toContain("PRIVATE_");
    expect(serialized).not.toContain("sk-private");
  });

  it("keeps governed input separate from sealed workflow findings", () => {
    const envelope = buildRunResultV1(
      minimalInput({ record: plannerFailureRecord("missing-information"), exitCode: 1 }),
    );
    expect(envelope.product.disposition).toBe("needs-input");
    expect(envelope.product.findings).toEqual([]);
    expect(envelope.product.openDecisions).toEqual([]);
    expect(envelope.plannerDiagnostic).toMatchObject({
      category: "missing-governed-input",
      code: "missing-information",
    });
  });

  it("fails closed when current failure evidence is absent, malformed, or conflicting", () => {
    const absent = plannerFailureRecord("invalid-envelope", { steps: [] });
    const malformedSteps = [
      plannerFailureRecord("invalid-envelope", { steps: [null as never] }),
      plannerFailureRecord("invalid-envelope", { steps: [[] as never] }),
      plannerFailureRecord("invalid-envelope", { steps: ["untrusted-step" as never] }),
      plannerFailureRecord("invalid-envelope", { steps: null as never }),
    ];
    const conflicting = plannerFailureRecord("invalid-envelope", {
      steps: [
        plannerFailureRecord("invalid-envelope").steps[0]!,
        plannerFailureRecord("missing-information").steps[0]!,
      ],
    });
    const wrongWorkflow = plannerFailureRecord("invalid-envelope", {
      workflow: "credential-bearing-arbitrary-workflow" as RunRecord["workflow"],
    });
    const malformed = [
      malformedPlannerDiagnostic((diagnostic) => {
        diagnostic.rejectedText = "PRIVATE_REJECTED_RESPONSE";
      }),
      malformedPlannerDiagnostic((diagnostic) => {
        diagnostic.kind = "wrong-kind";
      }),
      malformedPlannerDiagnostic((diagnostic) => {
        diagnostic.schemaVersion = 2;
      }),
      malformedPlannerDiagnostic((diagnostic) => {
        diagnostic.responseSha256 = "D".repeat(64);
      }),
      malformedPlannerDiagnostic((diagnostic) => {
        diagnostic.responseShape = "markdown";
      }),
      malformedPlannerDiagnostic((diagnostic) => {
        diagnostic.code = "untrusted-arbitrary-code";
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.id = "untrusted-step";
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.skill = "untrusted-skill";
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.kind = "inference";
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.mode = "write";
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.status = "succeeded";
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.inference = { attempts: [{ outcome: "failed" }] } as never;
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.inference = { attempts: [null] } as never;
      }),
      malformedPlannerDiagnostic((_diagnostic, record) => {
        record.steps[0]!.inference = {
          attempts: [{ outcome: "succeeded" }, { outcome: "failed" }],
        } as never;
      }),
      ...(["queued", "running", "succeeded"] as const).map((status) =>
        plannerFailureRecord("invalid-envelope", { status }),
      ),
    ];
    for (const record of malformedSteps) {
      expect(projectRunProduct(record).disposition).toBeNull();
      expect(projectRunProduct(record).plannerDiagnostic).toBeUndefined();
    }
    for (const record of [absent, conflicting, wrongWorkflow, ...malformed]) {
      const envelope = buildRunResultV1(minimalInput({ record, exitCode: 1 }));
      expect(envelope.product.disposition).toBeNull();
      expect(envelope.product.limitations).toContain("planner-diagnostic-unavailable");
      expect(envelope.plannerDiagnostic).toBeUndefined();
      expect(serializeRunResultV1(envelope)).not.toContain("PRIVATE_REJECTED_RESPONSE");
    }
  });

  it("retains the legacy compatibility label only for a successful record without evidence", () => {
    expect(buildRunResultV1(minimalInput()).product.disposition).toBe(
      "legacy-no-product-disposition",
    );
    const currentFailure = minimalRunRecord({ status: "failed" });
    expect(
      buildRunResultV1(minimalInput({ record: currentFailure, exitCode: 1 })).product.disposition,
    ).toBeNull();
  });

  it("rejects a decoded planner diagnostic with conflicting category or extra fields", () => {
    const result = buildRunResultV1(
      minimalInput({ record: plannerFailureRecord("invalid-envelope"), exitCode: 1 }),
    );
    expect(() =>
      decodeRunResultV1({
        ...result,
        plannerDiagnostic: {
          ...result.plannerDiagnostic,
          category: "missing-governed-input",
        },
      }),
    ).toThrow("invalid sanitized planner diagnostic fields");
    expect(() =>
      decodeRunResultV1({
        ...result,
        plannerDiagnostic: { ...result.plannerDiagnostic, rawResponse: "PRIVATE_RESPONSE" },
      }),
    ).toThrow("invalid sanitized planner diagnostic fields");
  });

  it("rejects a decoded envelope whose retryDispositions cannot be read", () => {
    const result = buildRunResultV1(minimalInput());
    expect(() =>
      decodeRunResultV1({
        ...result,
        retryDispositions: [{ stepId: "assess-readiness" }],
      }),
    ).toThrow("invalid retry dispositions");
  });

  it("validates the #780 physical-attempt accounting and replay veto the envelope carries", () => {
    const result = buildRunResultV1(minimalInput());
    const accounting = {
      logicalTurns: 1,
      physicalRequests: 8,
      replayedRequests: 7,
      blankRequests: 0,
      governorStoppedTurns: 0,
      unaccountedTurns: 0,
      coverage: "complete",
    };
    const reading = {
      stepId: "assess-readiness",
      attempt: 1,
      outcome: "timeout",
      conditionRetryability: "eligible",
      retryDecision: "declined",
      decisionToken: "declined-host-refusal",
      retryable: false,
      retriesRemaining: 1,
      eligibilityDisagreement: "eligible-vs-retryable-false",
      physicalAttempts: accounting,
      replayVeto: "attempts-exhausted",
    };
    // Positive control: the shape the projector writes decodes, both with the
    // accounting present and with the `unavailable` sentinel and no veto.
    expect(() => decodeRunResultV1({ ...result, retryDispositions: [reading] })).not.toThrow();
    expect(() =>
      decodeRunResultV1({
        ...result,
        retryDispositions: [{ ...reading, physicalAttempts: "unavailable", replayVeto: undefined }],
      }),
    ).not.toThrow();
    // A missing accounting, a count that is not a count, a coverage word outside
    // the vocabulary, a partial accounting and an invented veto are all refused
    // rather than handed to an operator as fact.
    for (const broken of [
      { ...reading, physicalAttempts: undefined },
      { ...reading, physicalAttempts: { ...accounting, physicalRequests: -1 } },
      { ...reading, physicalAttempts: { ...accounting, logicalTurns: "1" } },
      { ...reading, physicalAttempts: { ...accounting, coverage: "total" } },
      { ...reading, physicalAttempts: { logicalTurns: 1 } },
      { ...reading, replayVeto: "invented-veto" },
      { ...reading, eligibilityDisagreement: "invented-disagreement" },
      { ...reading, retryable: "maybe" },
      { ...reading, retriesRemaining: -1 },
    ]) {
      expect(() => decodeRunResultV1({ ...result, retryDispositions: [broken] })).toThrow(
        "invalid retry dispositions",
      );
    }
  });

  it("accepts only the canonical lowercase 64-hex result digest the builder stamps", () => {
    const result = buildRunResultV1(minimalInput());
    expect(result.resultSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result))).resultSha256).toBe(
      result.resultSha256,
    );
    for (const resultSha256 of [
      "not-a-digest",
      result.resultSha256.toUpperCase(),
      result.resultSha256.slice(1),
      result.resultSha256 + "0",
      result.resultSha256 + "\n",
      1,
      true,
    ]) {
      expect(() => decodeRunResultV1({ ...result, resultSha256 })).toThrow("invalid result digest");
    }
    for (const resultSha256 of [undefined, null, ""]) {
      expect(() => decodeRunResultV1({ ...result, resultSha256 })).toThrow(
        "missing required execution fields",
      );
    }
  });
});

describe("tool-result archive overflow on run result", () => {
  it("does not throw when an inference attempt is null or malformed and keeps archive-ceiling LIMITATIONS", () => {
    const archiveLimit = limit("toolOutput.archiveCeilingBytes");
    const observedBytes = archiveLimit.value + 1;
    const snapshot = {
      receipts: [
        {
          schemaVersion: 1 as const,
          kind: "docsfab-tool-result-archive" as const,
          handle: "docsfab-tr-aaaaaaaaaaaaaaaa",
          sha256: "a".repeat(64),
          toolName: "read",
          totalBytes: observedBytes,
        },
      ],
      storedBytes: 0,
      ceilingBytes: archiveLimit.value,
      refusals: [{ limitName: "toolOutput.archiveCeilingBytes", observedBytes }],
    };
    const record = minimalRunRecord({
      status: "failed",
      steps: [
        {
          id: "assess-readiness",
          title: "Assess readiness",
          kind: "evaluate",
          skill: "assess-readiness",
          mode: "read-only",
          status: "failed",
          tools: { totalCalls: 1, failedCalls: 0, byTool: [], toolResultArchive: snapshot },
          inference: {
            attempts: [null, "untrusted-attempt", { tools: { toolResultArchive: snapshot } }],
          },
        } as never,
      ],
    });
    const envelope = buildRunResultV1(minimalInput({ record, exitCode: 1 }));
    expect(envelope.limitOverflow).toEqual(
      expect.arrayContaining([expect.stringContaining("tool-output-archive-ceiling-bytes-bound")]),
    );
    expect(envelope.limitOverflow?.join("\n")).toContain(String(observedBytes));
    expect(serializeRunResultV1(envelope)).not.toContain("PRIVATE");
    const shown = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 1,
      repositoryPath: "/tmp/example",
      quiet: true,
      tty: false,
      ci: false,
      noColor: true,
    }).join("\n");
    expect(shown).toContain("LIMITATIONS");
    expect(shown).toContain("tool-output-archive-ceiling-bytes-bound");
  });
});

describe("run-record editorial evidence projection", () => {
  it("keeps historical absence explicit instead of inferring no-change", () => {
    expect(decodeRunRecordEditorialEvidence(minimalRunRecord())).toEqual({
      state: "editorial-evidence-unavailable",
    });
  });

  it("enforces the complete retained editorial lifetime matrix", () => {
    const statuses = [
      "queued",
      "running",
      "failed",
      "needs-input",
      "needs-human-decision",
      "succeeded",
    ] as const;
    const coverageStages = ["absent", "preselection", "selected"] as const;
    const artifactStages = ["none", "candidate", "final"] as const;
    const partialStatuses = new Set<RunRecord["status"]>([
      "running",
      "failed",
      "needs-input",
      "needs-human-decision",
    ]);

    for (const coverageStage of coverageStages) {
      for (const artifactStage of artifactStages) {
        for (const status of statuses) {
          const value = editorialNoChangeRecord();
          value.record.status = status;
          if (coverageStage === "absent") delete value.record.workflowBranchCoverage;
          if (coverageStage === "preselection") value.coverage.selection = null;
          if (artifactStage === "none") value.record.artifacts = [];
          if (artifactStage === "candidate") {
            value.record.artifacts = [
              {
                role: "output",
                stepId: "plan-documentation",
                reference: value.candidateReference,
              },
            ];
          }
          const candidate =
            coverageStage === "preselection"
              ? { ...value.candidate, candidate: "insufficient-evidence" as const }
              : value.candidate;
          const options = {
            decodeEditorialDecision(reference: EditorialDecisionArtifactReferenceV3) {
              return reference.digest === value.candidateReference.digest
                ? candidate
                : value.validated;
            },
            decodeWorkflowBranchCoverage() {
              return value.coverage;
            },
          };
          const allowed =
            (coverageStage === "absent" && artifactStage === "none") ||
            (coverageStage === "preselection" &&
              artifactStage === "none" &&
              status !== "succeeded") ||
            (coverageStage === "preselection" &&
              artifactStage === "candidate" &&
              partialStatuses.has(status)) ||
            (coverageStage === "selected" &&
              artifactStage === "candidate" &&
              partialStatuses.has(status)) ||
            (coverageStage === "selected" && artifactStage === "final" && status === "succeeded");
          if (allowed) {
            expect(() => decodeRunRecordEditorialEvidence(value.record, options)).not.toThrow();
          } else {
            expect(() => decodeRunRecordEditorialEvidence(value.record, options)).toThrowError(
              expect.objectContaining({ code: "invalid-evidence" }),
            );
          }
        }
      }
    }
  });

  it("binds each selected branch to its admitted candidate kind", () => {
    const value = editorialNoChangeRecord();
    value.record.status = "running";
    value.record.artifacts = [
      { role: "output", stepId: "plan-documentation", reference: value.candidateReference },
    ];
    const decode = (candidate: EditorialDecisionPayloadV1["candidate"]) =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision() {
          return { ...value.candidate, candidate };
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      });

    expect(() => decode("no-change")).not.toThrow();
    for (const candidate of ["update", "insufficient-evidence"] as const) {
      expect(() => decode(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid-evidence" }),
      );
    }

    value.coverage.selection = {
      branchId: "author",
      candidateArtifact: value.candidateReference,
    };
    expect(() => decode("update")).not.toThrow();
    for (const candidate of ["no-change", "insufficient-evidence"] as const) {
      expect(() => decode(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid-evidence" }),
      );
    }
  });

  it("retains an independently reversed final only after the original selected branch succeeds", () => {
    const value = editorialNoChangeRecord();
    const decode = (finalCandidate: EditorialDecisionPayloadV1["candidate"]) =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision(reference) {
          return reference.digest === value.candidateReference.digest
            ? value.candidate
            : { ...value.validated, candidate: finalCandidate };
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      });

    for (const status of [
      "queued",
      "running",
      "failed",
      "needs-input",
      "needs-human-decision",
    ] as const) {
      value.record.status = status;
      for (const finalCandidate of ["update", "insufficient-evidence"] as const) {
        expect(() => decode(finalCandidate)).toThrowError(
          expect.objectContaining({ code: "invalid-evidence" }),
        );
      }
    }
    value.record.status = "succeeded";
    expect(() => decode("update")).not.toThrow();
    expect(() => decode("insufficient-evidence")).not.toThrow();
    expect(() => decode("no-change")).not.toThrow();
  });

  it("retains sealed prefix coverage as current preselection evidence", () => {
    const value = editorialNoChangeRecord();
    value.coverage.selection = null;
    value.record.artifacts = [];
    for (const status of [
      "queued",
      "running",
      "failed",
      "needs-input",
      "needs-human-decision",
    ] as const) {
      value.record.status = status;
      expect(
        decodeRunRecordEditorialEvidence(value.record, {
          decodeWorkflowBranchCoverage() {
            return value.coverage;
          },
        }),
      ).toEqual({ state: "current-preselection", coverage: value.coverage });
    }
    value.record.status = "succeeded";
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("retains only an insufficient candidate before branch selection", () => {
    const value = editorialNoChangeRecord();
    value.coverage.selection = null;
    value.record.status = "needs-input";
    value.record.artifacts = [
      { role: "output", stepId: "plan-documentation", reference: value.candidateReference },
    ];
    const insufficient = { ...value.candidate, candidate: "insufficient-evidence" as const };
    expect(
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision() {
          return insufficient;
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toMatchObject({
      state: "current",
      candidate: { candidate: "insufficient-evidence" },
      coverage: { selection: null },
    });

    for (const candidate of ["no-change", "update"] as const) {
      expect(() =>
        decodeRunRecordEditorialEvidence(value.record, {
          decodeEditorialDecision() {
            return { ...value.candidate, candidate };
          },
          decodeWorkflowBranchCoverage() {
            return value.coverage;
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
    }
    value.record.status = "succeeded";
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision() {
          return insufficient;
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("seals a successful planner's typed insufficient candidate without invented input", () => {
    const value = editorialNoChangeRecord();
    value.coverage.selection = null;
    value.record.status = "needs-input";
    value.record.steps = [value.record.steps[0]!];
    value.record.artifacts = [
      { role: "output", stepId: "plan-documentation", reference: value.candidateReference },
    ];
    const insufficient = {
      ...value.candidate,
      candidate: "insufficient-evidence" as const,
      limitations: ["comparison-unavailable"],
    };
    const evidence = [
      workflowOutcomeStepEvidence(value.record, "plan-documentation"),
      workflowOutcomeArtifactEvidence(value.record, value.record.artifacts[0]!),
    ];
    expect(
      createWorkflowOutcome(
        {
          disposition: "inconclusive",
          findings: [
            {
              id: "finding:comparison-unavailable",
              kind: "evidence-limitation",
              severity: "warning",
              code: "comparison-unavailable",
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
          evidence,
          limitations: ["comparison-unavailable"],
          openDecisions: [],
          producedArtifacts: [value.candidateReference],
        },
        value.record,
        {
          decodeEditorialDecision() {
            return insufficient;
          },
          decodeWorkflowBranchCoverage() {
            return value.coverage;
          },
        },
      ).disposition,
    ).toBe("inconclusive");
  });

  it("strictly cross-binds decoded decision artifacts, plan identity, and branch coverage", () => {
    const value = editorialNoChangeRecord();
    const projected = decodeRunRecordEditorialEvidence(value.record, editorialDecodeOptions(value));
    expect(projected).toMatchObject({
      state: "current",
      candidate: { phase: "candidate", candidate: "no-change" },
      validated: { phase: "validated", candidate: "no-change" },
      coverage: { selection: { branchId: "assess-no-change" } },
    });
  });

  it("projects verified no-change separately from execution and product disposition", () => {
    const value = editorialNoChangeRecord();
    const outcomeEvidence = [
      ...value.record.artifacts!.map((use) => workflowOutcomeArtifactEvidence(value.record, use)),
      ...value.record.steps.map((step) => workflowOutcomeStepEvidence(value.record, step.id)),
    ];
    value.record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "inconclusive",
        findings: [
          {
            id: "finding:experimental-quality-profile",
            kind: "evidence-limitation",
            severity: "warning",
            code: "experimental-quality-profile",
            evidenceIds: outcomeEvidence.map(({ id }) => id),
          },
        ],
        limitations: ["experimental-quality-profile"],
        openDecisions: [],
        evidence: outcomeEvidence,
        producedArtifacts: [value.candidateReference, value.validatedReference],
      },
      value.record,
      editorialDecodeOptions(value),
    );
    const result = buildRunResultV1(
      minimalInput({
        record: value.record,
        editorialDecodeOptions: editorialDecodeOptions(value),
      }),
    );

    expect(result.execution).toMatchObject({
      status: "succeeded",
      patchPath: null,
      patchSha256: null,
      docChangeDelta: null,
    });
    expect(result.product.disposition).toBe("inconclusive");
    expect(result.editorial).toEqual({
      state: "validated",
      outcome: "verified-no-change",
      decision: "no-change",
      candidateReference: value.candidateReference,
      validatedReference: value.validatedReference,
      evidenceRefs: value.validated.evidenceRefs,
      limitations: ["experimental-quality-profile"],
    });
    expect(result.quality).toBeNull();
    expect(result.product.limitations).not.toContain("quality-validation-unavailable");
    expect(result.product.limitations).not.toContain("quality-evaluator-not-run");
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result))).editorial).toEqual(
      result.editorial,
    );
  });

  it("keeps unresolved current evidence and legacy absence explicitly unavailable", () => {
    const value = editorialNoChangeRecord();
    expect(projectRunEditorialOutcome(minimalRunRecord())).toEqual({
      state: "unavailable",
      outcome: "unavailable",
      decision: null,
      candidateReference: null,
      validatedReference: null,
      evidenceRefs: [],
      limitations: ["editorial-evidence-unavailable"],
    });
    expect(projectRunEditorialOutcome(value.record)).toMatchObject({
      state: "unavailable",
      limitations: ["editorial-evidence-unresolved"],
    });

    value.record.status = "running";
    value.record.artifacts = [];
    value.coverage.selection = null;
    expect(
      projectRunEditorialOutcome(value.record, {
        decodeWorkflowBranchCoverage: () => value.coverage,
      }),
    ).toEqual({
      state: "unavailable",
      outcome: "unavailable",
      decision: null,
      candidateReference: null,
      validatedReference: null,
      evidenceRefs: [],
      limitations: ["editorial-selection-pending"],
    });
  });

  it("projects the independently validated decision when it reverses the planner candidate", () => {
    const value = editorialNoChangeRecord();
    const reversed = { ...value.validated, candidate: "update" as const };
    expect(
      projectRunEditorialOutcome(value.record, {
        ...editorialDecodeOptions(value),
        decodeEditorialDecision: (reference) =>
          reference.digest === value.candidateReference.digest ? value.candidate : reversed,
      }),
    ).toMatchObject({
      state: "validated",
      outcome: "update-recommended",
      decision: "update",
      candidateReference: value.candidateReference,
      validatedReference: value.validatedReference,
      limitations: ["experimental-quality-profile", "update-not-executed"],
    });
  });

  // A run whose product outcome was refused after every step keeps its
  // validated decision readable, but a failed run is never a verified result.
  it("never projects verified no-change for a failed run with a validated no-change decision", () => {
    const value = editorialNoChangeRecord();
    value.record.status = "failed";
    value.record.workflowOutcomeRejection = {
      code: "workflow-outcome-admission-invalid-outcome",
      location: "$",
    };
    const options = editorialDecodeOptions(value);

    const editorial = projectRunEditorialOutcome(value.record, options);
    expect(editorial).toMatchObject({
      state: "validated",
      outcome: "insufficient-evidence",
      decision: "no-change",
      validatedReference: value.validatedReference,
    });
    expect(editorial.limitations).toContain("no-change-unverified");
    // The strict transport decoder the hosted terminal and run results share
    // admits that projection, and only with its unverified limitation.
    expect(decodeRunEditorialOutcomeV1(editorial)).toEqual(editorial);
    expect(() =>
      decodeRunEditorialOutcomeV1({
        ...editorial,
        limitations: editorial.limitations.filter((code) => code !== "no-change-unverified"),
      }),
    ).toThrow("invalid-editorial-outcome");

    // Control: the same decision on the succeeded record is verified.
    value.record.status = "succeeded";
    delete value.record.workflowOutcomeRejection;
    expect(projectRunEditorialOutcome(value.record, options).outcome).toBe("verified-no-change");
  });

  // Every no-change without a comparison of two distinct commits names its
  // basis. A decision without a code reads as nominated source coverage; a
  // decision's own code stands. NEXT names the same basis and never redirects
  // the request.
  it.each([
    {
      name: "a commit comparison",
      comparison: { kind: "base-head", base_revision: "b".repeat(40), head_revision: REVISION },
      stored: [],
      expected: [],
      basis: "base and head commit comparison",
    },
    {
      name: "a workspace comparison sealed before the code",
      comparison: { kind: "workspace", snapshot_sha256: "d".repeat(64) },
      stored: [],
      expected: [NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION],
      basis: "nominated source coverage, no commit comparison",
    },
    {
      name: "a comparison of one commit sealed before the code",
      comparison: { kind: "base-head", base_revision: REVISION, head_revision: REVISION },
      stored: [],
      expected: [NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION],
      basis: "nominated source coverage, no commit comparison",
    },
    {
      name: "a workspace comparison with its code",
      comparison: { kind: "workspace", snapshot_sha256: "d".repeat(64) },
      stored: [NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION],
      expected: [NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION],
      basis: "nominated source coverage, no commit comparison",
    },
    {
      name: "kept pages under a workspace comparison",
      comparison: { kind: "workspace", snapshot_sha256: "d".repeat(64) },
      stored: [NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION],
      expected: [NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION],
      basis: "kept pages, no commit comparison",
    },
    {
      name: "kept pages with no comparison",
      comparison: { kind: "unknown" },
      stored: [NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION],
      expected: [NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION],
      basis: "kept pages, no commit comparison",
    },
  ] as const)("names the no-change basis of $name", ({ comparison, stored, expected, basis }) => {
    const value = editorialNoChangeRecord();
    value.candidate = { ...value.candidate, comparison, limitations: [...stored] };
    value.validated = {
      ...value.validated,
      comparison,
      limitations: [...value.validated.limitations, ...stored].sort(),
    };
    const editorialDecodeOptions_ = editorialDecodeOptions(value);
    const editorial = projectRunEditorialOutcome(value.record, editorialDecodeOptions_);
    expect(editorial.outcome).toBe("verified-no-change");
    expect(editorial.limitations.filter((code) => code.startsWith("no-change-basis."))).toEqual(
      expected,
    );
    expect(decodeRunEditorialOutcomeV1(editorial)).toEqual(editorial);
    const context = {
      record: value.record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0 as const,
      repositoryPath: "/tmp/example",
      editorialDecodeOptions: editorialDecodeOptions_,
      tty: false,
      ci: false,
      noColor: true,
    };
    const next = buildRunHumanNextCommand(context);
    expect(next?.reason).toBe(
      `No documentation change needed; review the saved evidence if you disagree. Basis: ${basis}. Recorded limitations: experimental-quality-profile.`,
    );
    expect(collectRunResultNextSteps(context)).toEqual([next!.command, next!.reason]);
    const summary = formatRunSummary(context).join("\n");
    expect(summary).toContain(
      expected.length > 0
        ? `Editorial outcome: verified-no-change (basis: ${basis})`
        : "Editorial outcome: verified-no-change\n",
    );
    expect(summary).not.toContain("Change the request");
    expect(summary).not.toContain("quality-validation-unavailable");
    expect(summary).not.toContain("quality-evaluator-not-run");
  });

  // The basis note qualifies a verified no-change only. A no-change that a
  // failed run did not verify keeps its basis code as a limitation, without a
  // basis in its outcome line.
  it("names no basis in the outcome line of a no-change the run did not verify", () => {
    const value = editorialNoChangeRecord();
    value.candidate = {
      ...value.candidate,
      comparison: { kind: "unknown" },
      limitations: [NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION],
    };
    value.validated = {
      ...value.validated,
      comparison: { kind: "unknown" },
      limitations: ["experimental-quality-profile", NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION],
    };
    value.record.status = "failed";
    value.record.workflowOutcomeRejection = {
      code: "workflow-outcome-admission-invalid-outcome",
      location: "$",
    };
    const options = editorialDecodeOptions(value);
    expect(projectRunEditorialOutcome(value.record, options)).toMatchObject({
      outcome: "insufficient-evidence",
      limitations: expect.arrayContaining([NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION]),
    });
    const summary = formatRunSummary({
      record: value.record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 1,
      repositoryPath: "/tmp/example",
      editorialDecodeOptions: options,
      tty: false,
      ci: false,
      noColor: true,
    }).join("\n");
    expect(summary).toContain("Editorial outcome: insufficient-evidence\n");
    expect(summary).toContain(`Limitation: ${NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION}`);
    expect(summary).not.toContain("(basis:");
  });

  // The kept pages come from the update plan's sealed binding, and only
  // pages it kept (disposition `retain`), never written or out-of-scope ones.
  it("reads every kept page, and only kept pages, from the sealed update plan", () => {
    const planBinding = createDocumentationPlanBinding({
      mode: "update",
      pages: [
        { path: "docs/z.md", disposition: "retain" },
        { path: "docs/a.md", disposition: "update" },
        { path: "docs/b.md", disposition: "retain" },
        { path: "docs/c.md", disposition: "out-of-scope" },
      ],
      sourceBindings: [{ pagePath: "docs/a.md", sources: ["src/a.ts"] }],
    });
    const record = (workflow: RunRecord["workflow"], binding: unknown) =>
      ({
        workflow,
        steps: [{ id: "plan-documentation", planBinding: binding }],
      }) as unknown as Pick<RunRecord, "workflow" | "steps">;
    expect(admittedKeptUnchangedPages(record("update-documentation", planBinding))).toEqual([
      "docs/b.md",
      "docs/z.md",
    ]);
    // A tampered binding admits nothing.
    expect(
      admittedKeptUnchangedPages(
        record("update-documentation", { ...planBinding, digest: "0".repeat(64) }),
      ),
    ).toEqual([]);
  });

  // Every page the update plan kept, sorted and unique, or absent.
  it("decodes only a sorted list of distinct kept plan pages", () => {
    const envelope = buildRunResultV1(minimalInput());
    const decode = (keptUnchangedPages: unknown) =>
      decodeRunResultV1({ ...JSON.parse(serializeRunResultV1(envelope)), keptUnchangedPages });
    expect(decode(["docs/a.md", "docs/b.md"]).keptUnchangedPages).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
    for (const invalid of [
      [],
      ["docs/b.md", "docs/a.md"],
      ["docs/a.md", "docs/a.md"],
      [".github/a.md"],
      ["docs/../a.md"],
      ["docs\\a.md"],
      [7],
      "docs/a.md",
    ]) {
      expect(() => decode(invalid), JSON.stringify(invalid)).toThrow(
        "invalid kept unchanged pages",
      );
    }
  });

  it("keeps a no-change candidate insufficient until independent validation completes", () => {
    const value = editorialNoChangeRecord();
    value.record.artifacts = value.record.artifacts?.filter(
      (use) => use.reference.digest !== value.validatedReference.digest,
    );
    value.record.status = "running";
    const options = editorialDecodeOptions(value);

    expect(projectRunEditorialOutcome(value.record, options)).toMatchObject({
      state: "candidate",
      outcome: "insufficient-evidence",
      decision: "no-change",
      validatedReference: null,
      limitations: ["no-change-unverified"],
    });
  });

  it("labels an update executed only with validated author coverage and a retained patch", () => {
    const value = editorialNoChangeRecord();
    value.candidate.candidate = "update";
    value.validated.candidate = "update";
    value.coverage.selection = {
      branchId: "author",
      candidateArtifact: value.candidateReference,
    };
    value.record.steps.splice(1, 0, {
      id: "write-documentation",
      title: "write-documentation",
      kind: "inference",
      skill: "write-documentation",
      mode: "write",
      status: "succeeded",
    });
    value.record.changes = {
      files: [{ path: "docs/cli.md", status: "modified" }],
      patch: {
        sha256: PATCH_SHA256,
        byteLength: 24,
        lineCount: 2,
        artifactPath: "/private/patches/update.patch",
        format: "git-diff",
      },
    };
    const options = editorialDecodeOptions(value);

    expect(projectRunEditorialOutcome(value.record, options).outcome).toBe("executed-update");
    delete value.record.changes;
    expect(projectRunEditorialOutcome(value.record, options)).toMatchObject({
      state: "validated",
      outcome: "update-recommended",
      limitations: ["experimental-quality-profile", "update-not-executed"],
    });
  });

  it("rejects tampered retained decision projection when strict decoders are supplied", () => {
    const value = editorialNoChangeRecord();
    expect(() =>
      projectRunEditorialOutcome(value.record, {
        ...editorialDecodeOptions(value),
        decodeEditorialDecision: () => ({
          ...value.validated,
          decisionSha256: "0".repeat(64),
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("fails closed when retained coverage cannot be semantically decoded", () => {
    const value = editorialNoChangeRecord();
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision(reference) {
          return reference.digest === value.candidateReference.digest
            ? value.candidate
            : value.validated;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("rejects selected branch coverage without its candidate and final decisions", () => {
    const value = editorialNoChangeRecord();
    value.record.artifacts = [];
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));

    value.record.artifacts = [
      { role: "output", stepId: "plan-documentation", reference: value.candidateReference },
    ];
    value.record.status = "succeeded";
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision() {
          return value.candidate;
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("preserves a selected candidate across running and interrupted suffixes", () => {
    const value = editorialNoChangeRecord();
    value.record.artifacts = [
      { role: "output", stepId: "plan-documentation", reference: value.candidateReference },
    ];
    for (const status of ["running", "failed", "needs-input", "needs-human-decision"] as const) {
      value.record.status = status;
      const interruptedStep = value.record.steps.find(
        (step) => step.id === "verify-technical-accuracy",
      )!;
      if (status === "failed") {
        interruptedStep.status = "failed";
        interruptedStep.summary = "technical source unavailable";
      }
      const projected = decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision() {
          return value.candidate;
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      });
      expect(projected).toMatchObject({
        state: "current",
        candidate: { phase: "candidate", candidate: "no-change" },
        coverage: { selection: { branchId: "assess-no-change" } },
      });
      if (projected.state === "current") expect(projected.validated).toBeUndefined();
      if (status === "failed") {
        expect(interruptedStep).toMatchObject({
          status: "failed",
          summary: "technical source unavailable",
        });
        interruptedStep.status = "succeeded";
        delete interruptedStep.summary;
      }
    }
    value.record.status = "queued";
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision() {
          return value.candidate;
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("rejects final decision bytes bound to another branch coverage seal", () => {
    const value = editorialNoChangeRecord();
    const substitutedFinal = {
      ...value.validated,
      branchCoverage: {
        ...value.validated.branchCoverage!,
        coverageSha256: "9".repeat(64),
      },
    };
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision(reference) {
          return reference.digest === value.candidateReference.digest
            ? value.candidate
            : substitutedFinal;
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));

    delete value.record.workflowBranchCoverage;
    expect(() =>
      decodeRunRecordEditorialEvidence(value.record, {
        decodeEditorialDecision(reference) {
          return reference.digest === value.candidateReference.digest
            ? value.candidate
            : value.validated;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("admits an honest inconclusive outcome for validated no-change evidence", () => {
    const value = editorialNoChangeRecord();
    const artifactEvidence = value.record.artifacts!.map((use) =>
      workflowOutcomeArtifactEvidence(value.record, use),
    );
    const stepEvidence = value.record.steps.map((step) =>
      workflowOutcomeStepEvidence(value.record, step.id),
    );
    const evidence = [...artifactEvidence, ...stepEvidence];
    expect(
      createWorkflowOutcome(
        {
          disposition: "inconclusive",
          findings: [
            {
              id: "finding:experimental-quality-profile",
              kind: "evidence-limitation",
              severity: "warning",
              code: "experimental-quality-profile",
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
          evidence,
          limitations: ["experimental-quality-profile"],
          openDecisions: [],
          producedArtifacts: [value.candidateReference, value.validatedReference],
        },
        value.record,
        {
          decodeEditorialDecision(reference) {
            return reference.digest === value.candidateReference.digest
              ? value.candidate
              : value.validated;
          },
          decodeWorkflowBranchCoverage() {
            return value.coverage;
          },
        },
      ),
    ).toMatchObject({ disposition: "inconclusive" });
  });

  it("requires reversed finals to project an evidenced gap or limitation", () => {
    const value = editorialNoChangeRecord();
    const artifactEvidence = value.record.artifacts!.map((use) =>
      workflowOutcomeArtifactEvidence(value.record, use),
    );
    const stepEvidence = value.record.steps.map((step) =>
      workflowOutcomeStepEvidence(value.record, step.id),
    );
    const evidence = [...artifactEvidence, ...stepEvidence];
    const options = (finalCandidate: EditorialDecisionPayloadV1["candidate"]) => ({
      decodeEditorialDecision(reference: EditorialDecisionArtifactReferenceV3) {
        const reversalCode =
          finalCandidate === "update"
            ? "product-gap.documentation-update-required"
            : "evidence-limitation.independent-assessment-rejected";
        return reference.digest === value.candidateReference.digest
          ? value.candidate
          : {
              ...value.validated,
              candidate: finalCandidate,
              limitations: [reversalCode],
            };
      },
      decodeWorkflowBranchCoverage() {
        return value.coverage;
      },
    });
    const ready = {
      disposition: "ready" as const,
      findings: [],
      evidence,
      limitations: [],
      openDecisions: [],
      producedArtifacts: [value.candidateReference, value.validatedReference],
    };
    for (const finalCandidate of ["update", "insufficient-evidence"] as const) {
      expect(() =>
        createWorkflowOutcome(ready, value.record, options(finalCandidate)),
      ).toThrowError(expect.objectContaining({ code: "contradictory-outcome" }));
    }

    expect(
      createWorkflowOutcome(
        {
          ...ready,
          disposition: "not-ready",
          findings: [
            {
              id: "finding:documentation-update-required",
              kind: "product-gap",
              severity: "blocking",
              code: "product-gap.documentation-update-required",
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
        },
        value.record,
        options("update"),
      ),
    ).toMatchObject({ disposition: "not-ready" });

    expect(
      createWorkflowOutcome(
        {
          ...ready,
          disposition: "inconclusive",
          findings: [
            {
              id: "finding:experimental-quality-profile",
              kind: "evidence-limitation",
              severity: "warning",
              code: "evidence-limitation.independent-assessment-rejected",
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
          limitations: ["evidence-limitation.independent-assessment-rejected"],
        },
        value.record,
        options("insufficient-evidence"),
      ),
    ).toMatchObject({ disposition: "inconclusive" });
  });

  it("requires exact outcome evidence for every selected-path step", () => {
    const value = editorialNoChangeRecord();
    const artifactEvidence = value.record.artifacts!.map((use) =>
      workflowOutcomeArtifactEvidence(value.record, use),
    );
    const stepEvidence = value.record.steps
      .filter((step) => step.id !== "test-audience-understanding")
      .map((step) => workflowOutcomeStepEvidence(value.record, step.id));
    const evidence = [...artifactEvidence, ...stepEvidence];
    expect(() =>
      createWorkflowOutcome(
        {
          disposition: "inconclusive",
          findings: [
            {
              id: "finding:experimental-quality-profile",
              kind: "evidence-limitation",
              severity: "warning",
              code: "experimental-quality-profile",
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
          evidence,
          limitations: ["experimental-quality-profile"],
          openDecisions: [],
          producedArtifacts: [value.candidateReference, value.validatedReference],
        },
        value.record,
        {
          decodeEditorialDecision(reference) {
            return reference.digest === value.candidateReference.digest
              ? value.candidate
              : value.validated;
          },
          decodeWorkflowBranchCoverage() {
            return value.coverage;
          },
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-evidence" }));
  });

  it("rejects validated no-change before a delivery adapter can publish", () => {
    const value = editorialNoChangeRecord();
    expect(() =>
      assertRunRecordEditorialDeliveryEligible(value.record, {
        decodeEditorialDecision(reference) {
          return reference.digest === value.candidateReference.digest
            ? value.candidate
            : value.validated;
        },
        decodeWorkflowBranchCoverage() {
          return value.coverage;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "no-document-change" }));
  });
});

describe("answers asked early in the operator summary", () => {
  it("counts every attempt the host asked to answer before it finished reading", () => {
    const step = (id: string, attempts: unknown[]) =>
      ({
        id,
        title: id,
        kind: "evaluate",
        skill: id,
        mode: "read-only",
        status: "succeeded",
        inference: { attempts },
      }) as never;
    const record = minimalRunRecord({
      steps: [
        step("review-documentation", [
          {
            attempt: 1,
            outcome: "succeeded",
            retryable: false,
            retryScheduled: false,
            concludeNow: { trigger: "attempt-deadline", turn: 3 },
          },
        ]),
        step("verify-technical-accuracy", [
          null,
          {
            attempt: 2,
            outcome: "malformed-response",
            retryable: true,
            retryScheduled: false,
            concludeNow: { trigger: "reading-budget", turn: 7 },
          },
        ]),
        step("evaluate-document-quality", [
          { attempt: 1, outcome: "succeeded", retryable: false, retryScheduled: false },
        ]),
      ],
    });
    // `docsfab runs show` replays the saved record through the same summary,
    // whose LIMITATIONS section does not depend on the replay context.
    const shown = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
      ci: false,
      noColor: true,
    }).join("\n");
    expect(shown).toContain("LIMITATIONS");
    expect(shown).toContain(
      "Answers asked early: 2 attempts were asked to answer from what the model had read, so their reading was cut short.",
    );
    expect(shown).toContain(
      "Asked early: review-documentation attempt 1 after turn 3, because only its answer reserve was left before the attempt deadline (outcome succeeded).",
    );
    expect(shown).toContain(
      "Asked early: verify-technical-accuracy attempt 2 after turn 7, because its judgment reading budget was spent (outcome malformed-response).",
    );
    // The JSON run result carries the same facts for automation, and its
    // decoder admits them.
    const envelope = buildRunResultV1(minimalInput({ record, exitCode: 0 }));
    expect(envelope.answersAskedEarly).toEqual([
      {
        stepId: "review-documentation",
        attempt: 1,
        trigger: "attempt-deadline",
        turn: 3,
        outcome: "succeeded",
      },
      {
        stepId: "verify-technical-accuracy",
        attempt: 2,
        trigger: "reading-budget",
        turn: 7,
        outcome: "malformed-response",
      },
    ]);
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(envelope))).answersAskedEarly).toEqual(
      envelope.answersAskedEarly,
    );
    expect(() =>
      decodeRunResultV1({
        ...JSON.parse(serializeRunResultV1(envelope)),
        answersAskedEarly: [{ stepId: "x", attempt: 1, trigger: "bogus", turn: 1, outcome: "x" }],
      }),
    ).toThrow("invalid answers asked early");
    expect(
      buildRunResultV1(minimalInput({ record: minimalRunRecord(), exitCode: 0 })),
    ).not.toHaveProperty("answersAskedEarly");
    expect(
      formatRunSummary({
        record: minimalRunRecord(),
        recordPath: "/private/state/run-test-001.json",
        exitCode: 0,
        repositoryPath: "/tmp/example",
        tty: false,
        ci: false,
        noColor: true,
      }).join("\n"),
    ).not.toContain("Answers asked early");
  });
});

describe("CREATE source proposal operator projections", () => {
  const receipt = {
    schemaVersion: 1,
    kind: "docsfab-source-proposal-admission",
    attempt: 2,
    path: "src/telemetry.ts",
    reason: "This tracked module contains the API behavior described by the proposal.",
    status: "refused",
    refusalCode: "write-target-source",
  } as const;

  function proposalRunRecord(): RunRecord {
    return minimalRunRecord({
      workflow: "create-documentation",
      steps: [
        {
          id: "derive-source-obligations",
          title: "Derive source obligations",
          skill: "derive-source-obligations",
          mode: "read-only",
          status: "succeeded",
          sourceProposalAdmissions: [receipt],
        } as never,
      ],
    });
  }

  it("projects retained admissions to the JSON run result and summary", () => {
    const record = proposalRunRecord();
    const result = buildRunResultV1(minimalInput({ record }));
    expect(result.sourceProposalAdmissions).toEqual([receipt]);
    expect(
      decodeRunResultV1(JSON.parse(serializeRunResultV1(result))).sourceProposalAdmissions,
    ).toEqual([receipt]);

    const summary = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
      ci: false,
      noColor: true,
    }).join("\n");
    expect(summary).toContain("SOURCE PROPOSALS");
    expect(summary).toContain("Attempt 2: src/telemetry.ts");
    expect(summary).toContain("Host disposition: refused (write-target-source)");
  });

  it("rejects malformed receipts and proposals outside CREATE in JSON results", () => {
    const result = buildRunResultV1(minimalInput({ record: proposalRunRecord() }));
    const parsed = JSON.parse(serializeRunResultV1(result));
    expect(() =>
      decodeRunResultV1({
        ...parsed,
        sourceProposalAdmissions: [{ ...receipt, attempt: 0 }],
      }),
    ).toThrow();
    expect(() =>
      decodeRunResultV1({
        ...parsed,
        sourceProposalAdmissions: [{ ...receipt, reason: ` ${receipt.reason} ` }],
      }),
    ).toThrow();
    expect(() =>
      decodeRunResultV1({
        ...parsed,
        execution: { ...parsed.execution, workflow: "review-documentation" },
      }),
    ).toThrow("source proposals outside CREATE");
  });
});
