// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Producer side of the outcome pairing tests. One scripted run through the
 * real CLI entry point (`executeRunRequest`, real Pi adapter, scripted
 * provider) yields the base record. Each row copies it, changes only the
 * field under test through the shipped producer for that field, saves it
 * through the shipped indexed and classifying run store, and proves the
 * shipped parse gate admits it before any consumer reads it.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { vi } from "vitest";

import { decodeSavedRunRecord } from "../../src/cli/commands/runs.js";
import { executeRunRequest } from "../../src/cli/run-request.js";
import { runHostedWorkflow } from "../../src/host-invoker/workflow-runner.js";
import { parseJsonEvidence } from "../../src/json-evidence.js";
import {
  INFERENCE_CATEGORY_FAILURE_CLASSES,
  RUN_FAILURE_CODE_CLASSES,
  classifyingRunStore,
  markRunRefusal,
  operatorCodeFailureClass,
} from "../../src/operator/failure-classification.js";
import type { FailureClass } from "../../src/operator/failure-class.js";
import { SITUATION_CATALOG } from "../../src/operator/situation-catalog.js";
import type { RunRecord, RunStatus } from "../../src/records/contracts.js";
import { createIndexedFileRunStore } from "../../src/records/run-index-store.js";
import type {
  ProductDisposition,
  WorkflowOutcomeCandidateV1,
} from "../../src/workflow-contracts/contracts.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../../src/workflow-contracts/outcome.js";
import { canonicalSourceObligationProposal } from "../../src/workflow-execution/source-obligation.js";
import {
  sourceObligationProposalFixture,
  unverifiedVerificationResultFixture,
} from "../helpers/verification.js";
import { EditorialProtocolHarness } from "../helpers/editorial-protocol-harness.js";
import type { HarnessStepInput } from "../../src/execution/contracts.js";
import { git, orbitOptionChangeRepository } from "../helpers/orbit-option-change-fixture.js";
import {
  createReadinessFixture,
  readinessModelEdge,
  readinessRequest,
} from "../helpers/readiness-fixture.js";
import {
  createFixtureRepository,
  runtimeConfig,
  scriptedProvider,
  textTurn,
} from "../support/execution-convergence.js";

export interface ProducerFixture {
  readonly root: string;
  readonly repository: string;
  readonly stateDirectory: string;
  readonly revision: string;
}

/**
 * The positive control: a read-only review run through the real CLI entry
 * point and Pi adapter, with a scripted provider, to a terminal state.
 */
export async function runScriptedReview(fixture: ProducerFixture): Promise<RunRecord> {
  const verificationResult = unverifiedVerificationResultFixture(
    ["README.md", "docs/guide.md"],
    "The frozen fixture contains documentation claims but no implementation source that could verify them.",
  );
  const technicalJudgment = JSON.stringify({
    verdict: verificationResult.review.verdict,
    coverage: verificationResult.coverage,
    issueJudgments: [],
    obligationJudgments: [],
  });
  vi.stubGlobal(
    "fetch",
    scriptedProvider([
      textTurn("Deterministic audit evidence."),
      textTurn(canonicalSourceObligationProposal(sourceObligationProposalFixture("README.md:1"))),
      textTurn(technicalJudgment),
      textTurn(technicalJudgment),
      textTurn(JSON.stringify({ verdict: "pass", issues: [] })),
      textTurn("Audience evidence is unavailable in this deterministic fixture."),
      textTurn(
        JSON.stringify({
          evaluation: {
            profile: { id: "docsfab-documentation-quality", version: "v0.1" },
            model_version: "documentation-quality-model-v0.2",
            target: {
              scope_type: "documentation-set",
              repository_revision: fixture.revision,
              paths: ["README.md", "docs/guide.md"],
            },
          },
          qualityScore: null,
          reportMarkdown: unavailableQualityReport(fixture.revision),
        }),
      ),
    ]),
  );
  try {
    const record = await executeRunRequest(
      {
        workflow: "review-documentation",
        repositoryPath: fixture.repository,
        revision: "HEAD",
        instruction: "Review the committed fixture documentation.",
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(fixture.stateDirectory),
      { silent: true },
    );
    if (!record) throw new Error("The scripted review run returned no record.");
    return record;
  } finally {
    vi.unstubAllGlobals();
  }
}

export async function createProducerFixture(): Promise<ProducerFixture> {
  const fixture = await createFixtureRepository("documented");
  return {
    root: fixture.root,
    repository: fixture.repository,
    stateDirectory: fixture.stateDirectory,
    revision: fixture.revision,
  };
}

/**
 * The readiness projection base: one credential-free hosted run through the
 * real readiness workflow and retained-record decoder.
 */
export async function runScriptedReadiness(temporaryDirectories: string[]): Promise<RunRecord> {
  const fixture = await createReadinessFixture();
  temporaryDirectories.push(fixture.root);
  const calls: HarnessStepInput[] = [];
  const result = await runHostedWorkflow({
    request: readinessRequest(fixture, "readiness"),
    credential: null,
    emit() {},
    executionHarness: readinessModelEdge(calls),
  });
  if (result.record.status !== "succeeded" || result.record.workflow !== "readiness") {
    throw new Error("The scripted readiness run did not reach its terminal readiness workflow.");
  }
  const saved = parseJsonEvidence(await readFile(join(fixture.state, `${result.record.id}.json`)));
  return decodeSavedRunRecord(saved, result.record.id);
}

/**
 * Copy `base` under a new id, apply `change`, save it through the shipped
 * indexed and classifying store, and return the record the shipped
 * `runs show` parse gate decodes from the saved bytes.
 */
export async function seedRun(
  base: RunRecord,
  stateDirectory: string,
  id: string,
  change: (record: RunRecord) => void,
): Promise<RunRecord> {
  const record = structuredClone(base);
  record.id = id;
  change(record);
  await classifyingRunStore(createIndexedFileRunStore(stateDirectory)).save(record);
  const saved = parseJsonEvidence(await readFile(join(stateDirectory, `${id}.json`)));
  return decodeSavedRunRecord(saved, id);
}

/**
 * Run status rows: only `status` changes. The base's sealed product outcome
 * binds the status it was sealed for, so every status row, the succeeded
 * control included, starts from the record as the runner holds it before it
 * seals one.
 */
export function withRunStatus(status: RunStatus): (record: RunRecord) => void {
  return (record) => {
    delete record.workflowOutcome;
    record.status = status;
  };
}

/**
 * One outcome candidate per disposition that the shipped outcome admission
 * accepts on a succeeded record. Keyed by the producer's own union, so a new
 * disposition has no shape here and its row fails as producer-unreachable.
 */
const DISPOSITION_CANDIDATES: Readonly<
  Record<string, (record: RunRecord) => WorkflowOutcomeCandidateV1>
> = Object.freeze({
  ready: (record) => candidate(record, "ready", { findings: [], limitations: [] }),
  "not-ready": (record) =>
    candidate(record, "not-ready", {
      findings: [finding(record, "product-gap", "blocking", "pairing-product-gap")],
      limitations: [],
    }),
  inconclusive: (record) =>
    candidate(record, "inconclusive", {
      findings: [finding(record, "evidence-limitation", "warning", "pairing-evidence-limitation")],
      limitations: ["pairing-evidence-limitation"],
    }),
  "needs-input": (record) => {
    const evidenceIds = [terminalEvidence(record).id];
    return candidate(record, "needs-input", {
      findings: [
        {
          ...finding(record, "missing-governed-input", "blocking", "pairing-governed-input"),
          inputId: "pairing-input",
        },
      ],
      limitations: [],
      openDecisions: [
        {
          id: "decision:pairing-input",
          kind: "governed-input",
          inputId: "pairing-input",
          evidenceIds,
        },
      ],
    });
  },
  blocked: (record) =>
    candidate(record, "blocked", {
      findings: [finding(record, "blocked-dependency", "blocking", "pairing-blocked-dependency")],
      limitations: [],
      openDecisions: [
        {
          id: "decision:pairing-dependency",
          kind: "dependency",
          evidenceIds: [terminalEvidence(record).id],
        },
      ],
    }),
});

export function dispositionCandidateDeclared(disposition: string): boolean {
  return Object.hasOwn(DISPOSITION_CANDIDATES, disposition);
}

/**
 * Product disposition rows: only the sealed outcome changes, sealed by the
 * shipped `createWorkflowOutcome` against the succeeded base record.
 */
export function withProductDisposition(
  disposition: ProductDisposition,
): (record: RunRecord) => void {
  return (record) => {
    const build = DISPOSITION_CANDIDATES[disposition];
    if (!build) throw new Error(`producer-unreachable ${disposition}: no outcome candidate shape`);
    record.workflowOutcome = createWorkflowOutcome(build(record), record);
  };
}

function terminalEvidence(record: RunRecord) {
  const terminal = record.steps.at(-1);
  if (!terminal) throw new Error("The base record has no step to cite.");
  return workflowOutcomeStepEvidence(record, terminal.id);
}

function finding(
  record: RunRecord,
  kind: WorkflowOutcomeCandidateV1["findings"][number]["kind"],
  severity: WorkflowOutcomeCandidateV1["findings"][number]["severity"],
  code: string,
): WorkflowOutcomeCandidateV1["findings"][number] {
  return {
    id: `finding:${code}`,
    kind,
    severity,
    code,
    evidenceIds: [terminalEvidence(record).id],
  };
}

function candidate(
  record: RunRecord,
  disposition: ProductDisposition,
  parts: Pick<WorkflowOutcomeCandidateV1, "findings" | "limitations"> &
    Partial<Pick<WorkflowOutcomeCandidateV1, "openDecisions">>,
): WorkflowOutcomeCandidateV1 {
  return {
    disposition,
    findings: parts.findings,
    evidence: [terminalEvidence(record)],
    limitations: parts.limitations,
    openDecisions: parts.openDecisions ?? [],
    producedArtifacts: [],
  };
}

/**
 * The catalogued code the shipped classifier maps to `failureClass`, chosen
 * at run time from the situation catalog, the run failure codes, and the
 * inference categories. `undefined` when no catalogued code reaches the class.
 */
export function cataloguedCodeFor(failureClass: FailureClass): string | undefined {
  const codes = [
    ...new Set([
      ...SITUATION_CATALOG.map((row) => row.id),
      ...Object.keys(RUN_FAILURE_CODE_CLASSES),
      ...Object.keys(INFERENCE_CATEGORY_FAILURE_CLASSES),
    ]),
  ].sort();
  return codes.find((code) => operatorCodeFailureClass(code) === failureClass);
}

/**
 * Failure class rows: the run fails, as a status row does, and the shipped
 * `markRunRefusal` classifies a catalogued code that maps to the class.
 */
export function withFailureClass(code: string): (record: RunRecord) => void {
  return (record) => {
    delete record.workflowOutcome;
    record.status = "failed";
    delete record.failure;
    markRunRefusal(record, code);
  };
}

function unavailableQualityReport(revision: string): string {
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      target: {
        paths: ["docs/guide.md"],
        repository_revision: revision,
        documentation_revision: revision,
      },
      profile: { id: "docsfab-documentation-quality", version: "1.0.0" },
      evaluation: { decision: "insufficient-evidence", confidence: 0.4, hard_gate_failures: [] },
      rubric: { status: "unavailable", reason: "Deterministic fixture has no live audience." },
      validation: {
        evaluation: "unavailable",
        quality_score: "unavailable",
        report_binding: "unavailable",
      },
      artifact_locators: {
        evaluation: null,
        quality_score: null,
        quality_report: null,
      },
    }),
    "```",
    "",
    "## Evidence gaps and limitations",
    "",
    "- Limitation: Deterministic fixture evidence is not live model or audience evidence.",
  ].join("\n");
}

/** An editorial run's record and the state directory it was saved in. */
export interface EditorialRun {
  readonly record: RunRecord;
  readonly stateDirectory: string;
}

type EditorialScenario = (temporaryDirectories: string[]) => Promise<EditorialRun>;

const ORBIT_PAGE_NEW = "# Orbit CLI\n\nThe public option is --new.\n";
const ORBIT_PAGE_OLD = "# Orbit CLI\n\nThe public option is --old.\n";
const CHECK_REQUEST =
  "Check whether the documentation needs an update for this change, starting from the Orbit CLI page (docs/cli.md). Update the documentation only if the change requires it; if it does not, make no edits and explain why.";

/**
 * One update-documentation run per editorial outcome, through the real CLI
 * entry point and runner with the deterministic editorial protocol harness.
 * The outcome is projected by the shipped `runs show` path from the retained
 * decisions, never written as a string. Keyed by the producer's own outcome
 * union, so a new outcome has no scenario here and its row fails as
 * producer-unreachable.
 */
const EDITORIAL_SCENARIOS: Readonly<Record<string, EditorialScenario>> = Object.freeze({
  "verified-no-change": (dirs) =>
    editorialRun(dirs, ORBIT_PAGE_NEW, { candidate: "no-change", plannerJudgment: true }),
  "insufficient-evidence": (dirs) =>
    editorialRun(dirs, ORBIT_PAGE_NEW, {
      candidate: "insufficient-evidence",
      plannerJudgment: true,
    }),
  "executed-update": (dirs) =>
    editorialRun(dirs, ORBIT_PAGE_OLD, { candidate: "update", plannerJudgment: true }),
  "update-recommended": (dirs) =>
    editorialRun(dirs, ORBIT_PAGE_NEW, {
      candidate: "no-change",
      plannerJudgment: true,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
    }),
  // The plan leaves the named page out of scope, so the run stops at the
  // planner before any editorial decision is retained.
  unavailable: (dirs) =>
    editorialRun(dirs, ORBIT_PAGE_NEW, {
      candidate: "no-change",
      plannerJudgment: true,
      plannerPages: [
        { path: "docs/cli.md", disposition: "out-of-scope" },
        { path: "docs/other.md", disposition: "retain" },
      ],
    }),
});

export function editorialScenarioDeclared(outcome: string): boolean {
  return Object.hasOwn(EDITORIAL_SCENARIOS, outcome);
}

export async function runEditorialScenario(
  outcome: string,
  temporaryDirectories: string[],
): Promise<EditorialRun> {
  const scenario = EDITORIAL_SCENARIOS[outcome];
  if (!scenario) throw new Error(`producer-unreachable ${outcome}: no editorial scenario`);
  return scenario(temporaryDirectories);
}

async function editorialRun(
  temporaryDirectories: string[],
  page: string,
  options: Omit<ConstructorParameters<typeof EditorialProtocolHarness>[0], "impactSource">,
): Promise<EditorialRun> {
  const fixture = await orbitOptionChangeRepository("docsfab-pairing", temporaryDirectories);
  let head = fixture.head;
  if (page === ORBIT_PAGE_NEW) {
    await writeFile(join(fixture.repository, "docs/cli.md"), page);
    await git(fixture.repository, "add", "--all");
    await git(
      fixture.repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "docs: describe --new",
    );
    head = await git(fixture.repository, "rev-parse", "HEAD");
    await git(fixture.repository, "update-ref", "refs/remotes/origin/main", head);
  }
  const harness = new EditorialProtocolHarness({
    ...options,
    impactSource: {
      uri: "docs/cli.md",
      sha256: createHash("sha256").update(page).digest("hex"),
    },
  });
  const record = await executeRunRequest(
    {
      workflow: "update-documentation",
      repositoryPath: fixture.repository,
      revision: head,
      instruction: CHECK_REQUEST,
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    },
    fixture.config,
    { silent: true, harness },
  );
  if (!record) throw new Error("The editorial run returned no record.");
  return { record, stateDirectory: fixture.config.stateDirectory };
}
