// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EditorialDecisionValidationError,
  hostFillEditorialDecisionProposalFromJudgmentV1,
  readEditorialDecisionJudgmentV1,
} from "../src/artifacts/editorial-decision.js";
import type { ArtifactReference } from "../src/artifacts/contracts.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { loadSavedRunEditorialDecodeOptions } from "../src/cli/run/editorial-replay.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import {
  admitEditorialPlannerEnvelopeV1,
  admitEditorialPlannerProposalV1,
  buildEditorialResponseContractV1,
  editorialAssessmentEvidenceRefsV1,
} from "../src/harness/pi.js";
import {
  collectRunResultNextSteps,
  defaultRunRecordPath,
  formatRunSummary,
} from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { bindDocumentationPlanProposal } from "../src/workflow-execution/plan-binding.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { verificationResultFixture } from "./helpers/verification.js";
import { journeyTestTimeoutMs } from "./support/journey.js";
import {
  observePublicContract,
  orbitOptionChangeRepository,
} from "./helpers/orbit-option-change-fixture.js";

const temporaryDirectories: string[] = [];
const RATIONALE =
  "The admitted public source changed while the guide still documents the old option.";

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CREATE planner stop through the shipped CLI and filesystem evidence", () => {
  it(
    "exits 2 for ambiguous-scope and persists no empty pre-write patch",
    async () => {
      const capture = vi.spyOn(GitPatchEvidenceCollector.prototype, "capture");
      const { record, json, fixture, calls } = await createPlannerStop();
      expect(record?.status, record?.error).toBe("needs-input");
      expect(process.exitCode).toBe(2);
      expect(json.execution).toMatchObject({ status: "needs-input", exitCode: 2 });
      expect(json.product).toMatchObject({ disposition: "needs-input" });
      expect(
        record?.steps.find((step) => step.id === "plan-documentation")?.planDiagnostic,
      ).toMatchObject({
        code: "ambiguous-scope",
      });
      expect(calls).toEqual(["plan-documentation"]);
      expect(capture.mock.calls.map(([context]) => context.persistPatch)).toEqual([false]);
      expect(record?.changes).toEqual({ files: [] });
      const saved = JSON.parse(
        await readFile(join(fixture.config.stateDirectory, `${record!.id}.json`), "utf8"),
      ) as RunRecord;
      expect(saved.changes).toEqual({ files: [] });
      expect(await patchFiles(fixture.config.stateDirectory)).toEqual([]);
      expect(await readFile(join(fixture.repository, "fern/docs.yml"), "utf8")).toContain(
        "navigation:",
      );
    },
    journeyTestTimeoutMs(),
  );

  it(
    "retains a real patch when the filesystem changes before the planner stops",
    async () => {
      const capture = vi.spyOn(GitPatchEvidenceCollector.prototype, "capture");
      const { record, json, fixture } = await createPlannerStop("unexpected-change");
      expect(record?.status, record?.error).toBe("needs-input");
      expect(json.execution).toMatchObject({ status: "needs-input", exitCode: 2 });
      expect(capture.mock.calls.map(([context]) => context.persistPatch)).toEqual([false, true]);
      expect(record?.changes?.files).toContainEqual({ path: "docs/partial.md", status: "added" });
      expect(record?.changes?.patch?.byteLength).toBeGreaterThan(0);
      const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
      expect(patch).toContain("+Retain this partial documentation.");
      expect(await patchFiles(fixture.config.stateDirectory)).toContain(`${record!.id}.patch`);
      await expect(readFile(join(fixture.repository, "docs/partial.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    journeyTestTimeoutMs(),
  );

  it(
    "keeps a failed planner at exit 1 and follows normal patch finalization",
    async () => {
      const capture = vi.spyOn(GitPatchEvidenceCollector.prototype, "capture");
      const { record, json, fixture } = await createPlannerStop("failed");
      expect(record?.status).toBe("failed");
      expect(record?.error).toContain("planner-produced-invalid-response");
      expect(process.exitCode).toBe(1);
      expect(json.execution).toMatchObject({ status: "failed", exitCode: 1 });
      expect(capture.mock.calls.map(([context]) => context.persistPatch)).toEqual([true]);
      expect(record?.changes?.patch).toBeDefined();
      expect(await patchFiles(fixture.config.stateDirectory)).toContain(`${record!.id}.patch`);
    },
    journeyTestTimeoutMs(),
  );
});

async function createPlannerStop(mode: "clean" | "unexpected-change" | "failed" = "clean") {
  const fixture = await orbitOptionChangeRepository(
    "docsfab-create-planner-stop",
    temporaryDirectories,
    {
      files: { "fern/docs.yml": "navigation:\n  - page: ../docs/cli.md\n" },
      documentationRoots: ["docs", "fern"],
    },
  );
  const calls: string[] = [];
  const harness: AgentHarness = {
    async runStep(input) {
      calls.push(input.step.id);
      if (input.step.id !== "plan-documentation") {
        throw new Error(`The planner stop unexpectedly reached ${input.step.id}.`);
      }
      if (mode === "failed") throw new Error("planner-produced-invalid-response");
      if (mode === "unexpected-change") {
        await writeFile(
          join(input.repositoryPath, "docs/partial.md"),
          "Retain this partial documentation.\n",
        );
      }
      return {
        summary: "Confirm whether fern/docs.yml may change before planning the new guide.",
        outcome: "needs-input",
        planDiagnostic: {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code: "ambiguous-scope",
          responseSha256: "c".repeat(64),
          responseShape: "json-object",
        },
      };
    },
  };
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const request = parseRunArguments([
    "create-documentation",
    "--repo",
    fixture.repository,
    "--revision",
    fixture.head,
    "--instruction",
    "Create docs/deployment.md using src/orbit.ts and integrate the guide into the documentation navigation.",
    "--canon-snapshot",
    fixture.canonSnapshotPath,
    "--source",
    "src/orbit.ts",
    "--patch-only",
    "--json",
  ]);
  const record = await executeRunRequest(request, fixture.config, { executionHarness: harness });
  const json = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as {
    execution: { status: string; exitCode: number };
    product: { disposition: string };
  };
  return { record, json, fixture, calls };
}

async function patchFiles(stateDirectory: string): Promise<string[]> {
  try {
    return await readdir(join(dirname(stateDirectory), "patches"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("planner judgment host-fill", () => {
  it("host-decodes completed judgment without minted identity from the closed admission set", () => {
    const artifact = admittedArtifact();
    const source = admittedSource();
    const proposal = hostFillEditorialDecisionProposalFromJudgmentV1(
      {
        candidate: "update",
        rationale: RATIONALE,
        slotIds: ["public-contract", "current-documentation"],
      },
      fillOptions(artifact, source),
    );
    expect(proposal.candidate).toBe("update");
    expect(proposal.rationale).toBe(RATIONALE);
    expect(proposal.schemaVersion).toBe(1);
    expect(proposal.kind).toBe("docsfab-editorial-decision-proposal");
    expect(proposal.evidenceRefs).toEqual([artifact]);
    expect(proposal.impactBasis.evidence_refs).toEqual([source]);
    expect(proposal.impactBasis.kind).toBe("documentation-defect");
  });

  it("ignores model-minted sha256 and artifact refs as authority", () => {
    const artifact = admittedArtifact();
    const source = admittedSource();
    const mintedArtifact = { ...artifact, digest: "a".repeat(64) };
    const mintedSource = { uri: "file:///minted", sha256: "b".repeat(64) };
    const proposal = hostFillEditorialDecisionProposalFromJudgmentV1(
      {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "update",
        rationale: RATIONALE,
        slotIds: ["public-contract"],
        evidenceRefs: [mintedArtifact],
        limitations: ["minted-limitation"],
        impactBasis: {
          kind: "none",
          rationale: RATIONALE,
          evidence_refs: [mintedSource],
        },
      },
      fillOptions(artifact, source),
    );
    expect(proposal.evidenceRefs).toEqual([artifact]);
    expect(proposal.evidenceRefs[0]?.digest).toBe(artifact.digest);
    expect(proposal.impactBasis.evidence_refs).toEqual([source]);
    expect(proposal.impactBasis.kind).toBe("documentation-defect");
    expect(proposal.limitations).toEqual([]);
  });

  it("rejects unknown judgment slot ids before the decoder", () => {
    expect(() =>
      readEditorialDecisionJudgmentV1({
        candidate: "update",
        rationale: RATIONALE,
        slotIds: ["not-a-slot"],
      }),
    ).toThrow(EditorialDecisionValidationError);
  });
});

describe("editorial planner harness admission", () => {
  it("marks completed judgment succeeded only when the decoder would succeed", () => {
    const input = plannerInput();
    const artifact = input.editorialEvidenceRefs![0]!;
    const source = input.readerContextProvenance!.sources[0]!;
    const admitted = admitEditorialPlannerEnvelopeV1(
      {
        editorialDecisionProposal: {
          candidate: "update",
          rationale: RATIONALE,
          slotIds: ["public-contract"],
        },
      },
      input,
    );
    expect(admitted.status).toBe("completed");
    if (admitted.status !== "completed") return;
    expect(admitted.proposal.evidenceRefs).toEqual([artifact]);
    expect(admitted.proposal.impactBasis.evidence_refs).toEqual([
      { uri: source.uri, sha256: source.sha256 },
    ]);
  });

  it("does not mark planner success when host-fill cannot decode", () => {
    const input = plannerInput({ editorialEvidenceRefs: [] });
    expect(() =>
      admitEditorialPlannerProposalV1(
        { candidate: "update", rationale: RATIONALE, slotIds: ["public-contract"] },
        input,
      ),
    ).toThrow(EditorialDecisionValidationError);
    expect(() =>
      admitEditorialPlannerEnvelopeV1(
        {
          editorialDecisionProposal: {
            candidate: "update",
            rationale: RATIONALE,
            slotIds: ["public-contract"],
          },
        },
        input,
      ),
    ).toThrow(EditorialDecisionValidationError);
  });

  it("uses the blocked needs-input envelope without requiring the decoder", () => {
    const admitted = admitEditorialPlannerEnvelopeV1(
      {
        outcome: "needs-input",
        reason: "missing-source",
      },
      plannerInput({ editorialEvidenceRefs: [] }),
    );
    expect(admitted).toEqual({ status: "blocked", reasonCode: "missing-source" });
  });

  it("asks the model for judgment only in the host-owned planner contract", () => {
    const contract = buildEditorialResponseContractV1(plannerInput());
    expect(contract).toContain("Return judgment only");
    expect(contract).toContain('"slotIds"');
    expect(contract).toContain("specific missing evidence or dependency and the resolution needed");
    expect(contract).not.toContain("impactBasis");
  });
});

describe("operator InputAsk after planner judgment", () => {
  it(
    "host-fills judgment and still projects InputAsk slots from the blocked envelope path",
    async () => {
      const fixture = await repositoryFixture();
      const harness = new JudgmentHarness({
        mode: "blocked",
        impactSource: fixture.impactSource,
      });
      const output: string[] = [];
      const log = console.log;
      console.log = (message?: unknown): void => {
        output.push(String(message));
      };
      let record;
      try {
        record = await executeRunRequest(
          {
            workflow: "update-documentation",
            repositoryPath: fixture.repository,
            revision: fixture.head,
            instruction: "Assess whether docs/cli.md needs an update based on current behavior.",
            readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
            canonSnapshotPath: fixture.canonSnapshotPath,
            allowWrite: true,
            releaseGate: false,
            verbose: false,
            json: true,
            showScan: false,
          },
          fixture.config,
          { harness },
        );
      } finally {
        console.log = log;
      }

      expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
      expect(record?.changes?.patch).toBeUndefined();
      const patches = await readdir(join(dirname(fixture.config.stateDirectory), "patches")).catch(
        () => [],
      );
      expect(patches).not.toContain(`${record?.id}.patch`);
      expect(harness.stepIds).toEqual(["plan-documentation"]);
      expect(record?.workflowBranchCoverage?.selection).toBeNull();
      const json = JSON.parse(output.at(-1) ?? "{}") as {
        execution?: { exitCode?: number };
        nextSteps?: string[];
        product?: { plannerDiagnostic?: { category?: string; code?: string } };
      };
      expect(process.exitCode).toBe(2);
      expect(json.execution?.exitCode).toBe(2);
      expect(json.nextSteps?.join(" ")).toMatch(/InputAsk|governed input/i);
      expect(json.product?.plannerDiagnostic?.category ?? "missing-governed-input").toBe(
        "missing-governed-input",
      );
    },
    journeyTestTimeoutMs(),
  );

  it("still projects InputAsk slots when filled no-change judgment is rejected at select", async () => {
    const fixture = await repositoryFixture();
    // The plan keeps a page the revision does not hold, so it has no admitted
    // current documentation and selection refuses the no-change.
    const harness = new JudgmentHarness({
      mode: "no-change",
      impactSource: fixture.impactSource,
      planPage: "docs/absent.md",
    });
    const output: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      output.push(String(message));
    };
    let record;
    try {
      record = await executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: fixture.repository,
          revision: fixture.head,
          instruction: "Assess whether docs/cli.md needs an update based on current behavior.",
          readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
          canonSnapshotPath: fixture.canonSnapshotPath,
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: true,
          showScan: false,
        },
        fixture.config,
        { harness },
      );
    } finally {
      console.log = log;
    }

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    const findings = record?.workflowOutcome?.findings ?? [];
    expect(findings.every((finding) => finding.kind === "missing-governed-input")).toBe(true);
    expect(findings.some((finding) => finding.inputId === "comparison")).toBe(true);
    const json = JSON.parse(output.at(-1) ?? "{}") as { nextSteps?: string[] };
    expect(json.nextSteps?.join(" ")).toContain("InputAsk");
    const decodeOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    const human = formatRunSummary({
      record: record!,
      recordPath: defaultRunRecordPath(fixture.config.stateDirectory, record!.id),
      repositoryPath: fixture.repository,
      exitCode: 2,
      editorialDecodeOptions: decodeOptions,
    }).join("\n");
    expect(human).toContain("Product input:");
    expect(
      collectRunResultNextSteps({
        record: record!,
        recordPath: defaultRunRecordPath(fixture.config.stateDirectory, record!.id),
        repositoryPath: fixture.repository,
        exitCode: 2,
        editorialDecodeOptions: decodeOptions,
      }).join(" "),
    ).toContain("InputAsk");
  }, 20_000);
});

class JudgmentHarness implements AgentHarness {
  public readonly inputs: HarnessStepInput[] = [];

  public constructor(
    private readonly options: {
      mode: "blocked" | "no-change" | "update";
      impactSource: { uri: string; sha256: string };
      /** The planned page; `docs/cli.md` by default. */
      planPage?: string;
    },
  ) {}

  public get stepIds(): string[] {
    return this.inputs.map((input) => input.step.id);
  }

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.inputs.push(input);
    const admitted =
      input.step.id === "plan-documentation"
        ? input.editorialEvidenceRefs?.[0]
        : editorialAssessmentEvidenceRefsV1(input)[0];
    if (!admitted) throw new Error("missing admitted reader evidence");
    if (input.step.id === "plan-documentation") {
      if (this.options.mode === "blocked") {
        return {
          summary:
            "The comparison and public contract are still required before planning can close.",
          outcome: "needs-input",
          planDiagnostic: {
            schemaVersion: 1,
            kind: "docsfab-documentation-plan-diagnostic",
            code: "missing-source",
            responseSha256: "c".repeat(64),
            responseShape: "json-object",
          },
        };
      }
      const update = this.options.mode === "update";
      const proposal = admitEditorialPlannerProposalV1(
        {
          candidate: update ? "update" : "no-change",
          rationale: update
            ? RATIONALE
            : "The admitted source comparison preserves the documented public behavior.",
          slotIds: ["public-contract", "current-documentation"],
          evidenceRefs: [{ ...admitted, digest: "a".repeat(64) }],
          impactBasis: {
            kind: "none",
            rationale: RATIONALE,
            evidence_refs: [{ uri: "file:///minted", sha256: "b".repeat(64) }],
          },
        },
        input,
      );
      return {
        summary: update
          ? "The changed public option requires one documentation update."
          : "The admitted comparison shows no reader-visible documentation change.",
        planBinding: bindDocumentationPlanProposal(
          {
            mode: "update",
            pages: [
              {
                path: this.options.planPage ?? "docs/cli.md",
                disposition: update ? "update" : "retain",
              },
            ],
            sourceBindings: update
              ? [{ pagePath: this.options.planPage ?? "docs/cli.md", sources: ["src/orbit.ts"] }]
              : [],
          },
          { expectedMode: "update" },
        ),
        editorialDecisionProposal: proposal,
      };
    }
    if (input.step.id === "write-documentation") {
      await writeFile(
        join(input.repositoryPath, "docs/cli.md"),
        "# Orbit CLI\n\nThe public option is now --new.\n",
      );
      return { summary: "Updated the one source-bound documentation page." };
    }
    if (input.step.id === "test-audience-understanding") {
      return {
        summary: "No authorized representative audience fixture was available.",
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "not-applicable",
          rationale:
            "The candidate was retained, but the run had no authorized representative audience fixture.",
          evidenceRefs: [admitted],
          limitations: ["audience-check-unavailable"],
          recommendation: null,
        },
      };
    }
    if (
      input.step.id === "verify-technical-accuracy" ||
      input.step.id === "review-documentation" ||
      input.step.id === "evaluate-document-quality"
    ) {
      return {
        summary:
          input.step.id === "review-documentation"
            ? JSON.stringify({ verdict: "pass", issues: [] })
            : `${input.step.id} accepted the source-bound candidate.`,
        ...(input.step.id === "verify-technical-accuracy"
          ? { verificationResult: verificationResultFixture(["docs/cli.md"]) }
          : {}),
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "accepted",
          rationale: `${input.step.id} independently inspected the retained source and candidate evidence.`,
          evidenceRefs: [admitted],
          limitations: [],
          recommendation: null,
        },
      };
    }
    return { summary: `${input.step.id} completed its deterministic check.` };
  }
}

function plannerInput(overrides: Partial<HarnessStepInput> = {}): HarnessStepInput {
  const workflow = getWorkflow("update-documentation");
  const readerContextInput = {
    schema_version: 1 as const,
    target_audience: "Orbit users",
    reader_job: "run an inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public contract"],
    required_content: ["current command"],
    excluded_content: [],
    unresolved_questions: [],
  };
  const artifact = admittedArtifact();
  const source = admittedSource();
  return {
    repositoryPath: "/tmp/repository",
    workflow,
    step: workflow.steps.find((step) => step.skill === "plan-documentation")!,
    readerContextInput,
    readerTaskContext: {
      schemaVersion: 1 as const,
      kind: "docsfab-reader-task-context-input" as const,
      inputOrigin: "explicit" as const,
      noChangeAssessment: "requires-evidence" as const,
      readerContextInput,
      baseline: {
        path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md" as const,
        sha256: "a".repeat(64),
        content: "Use actual reader and source evidence.",
      },
      policy: { id: "docsfab-documentation-quality", version: "v0.1", sha256: "b".repeat(64) },
      prompt: "Verified reader task context.",
    },
    readerContextProvenance: {
      schema_version: 1,
      reader_context_sha256: "1".repeat(64),
      baseline_sha256: "a".repeat(64),
      admitted_revision: artifact.repositoryRevision,
      workspace_snapshot_sha256: "2".repeat(64),
      repository_identity_sha256: "3".repeat(64),
      policy: { id: "docsfab-documentation-quality", version: "v0.1", sha256: "b".repeat(64) },
      comparison: { kind: "unknown" },
      sources: [{ ...source, role: "public-contract" }],
      observed_at: "2026-09-16T12:00:00.000Z",
      limitations: [],
    },
    editorialEvidenceRefs: [artifact],
    ...overrides,
  };
}

function fillOptions(artifact: ArtifactReference, source: { uri: string; sha256: string }) {
  return {
    readerContextInput: {
      schema_version: 1 as const,
      target_audience: "Orbit users",
      reader_job: "run an inspection",
      change_scope: ["docs/cli.md"],
      source_priority: ["public contract"],
      required_content: ["current command"],
      excluded_content: [],
      unresolved_questions: [],
    },
    admittedReaderEvidence: [source],
    admittedEvidenceRefs: [artifact],
  };
}

function admittedArtifact(): ArtifactReference {
  return {
    kind: "context-packet",
    schemaVersion: 1,
    digest: "c".repeat(64),
    repositoryRevision: "d".repeat(40),
    repositoryContentDigest: "e".repeat(64),
  };
}

function admittedSource(): { uri: string; sha256: string } {
  return { uri: "repo://src/orbit.ts", sha256: "f".repeat(64) };
}

async function repositoryFixture() {
  const fixture = await orbitOptionChangeRepository(
    "docsfab-planner-judgment",
    temporaryDirectories,
  );
  return {
    ...fixture,
    impactSource: await observePublicContract(fixture.repository, fixture.head),
  };
}
