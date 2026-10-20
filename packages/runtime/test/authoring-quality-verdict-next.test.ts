// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The authoring verdict and NEXT say what is known about the retained patch,
 * not "a wall".
 *
 * Every projector case runs the shipped chain end to end:
 * `AuthoringQualityWorkflowOutcomeProjector.project` -> `createWorkflowOutcome`
 * -> `buildRunHumanNextCommand` / `formatRunSummary` /
 * `collectRunResultNextSteps`. The evaluate-step summaries are the staging
 * envelope `{evaluation, qualityScore, reportMarkdown}` trimmed from the
 * retained PRR records `683ab88d` and `d158e98a`
 * (`fixtures/authoring-quality-prr-20260925/`), never the host `summaryBase`.
 * Expected strings are transcribed literals, not recomputed through the code
 * under test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AuthoringQualityWorkflowOutcomeProjector,
  type AuthoringQualityOutcomeWorkflow,
} from "../src/evaluation-report/authoring-outcome-projector.js";
import {
  buildRunHumanNextCommand,
  collectRunResultNextSteps,
  formatRunSummary,
  type RunSummaryContext,
} from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import type {
  WorkflowName,
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeFindingV1,
} from "../src/workflow-contracts/contracts.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { buildRunResultV1 } from "../src/operator/run-result.js";

interface PrrFixture {
  readonly runId: string;
  readonly workflow: AuthoringQualityOutcomeWorkflow;
  readonly repositoryRevision: string;
  readonly changedFiles: NonNullable<RunRecord["changes"]>["files"];
  readonly patch: {
    artifactPath: string;
    byteLength: number;
    lineCount: number;
    format: "git-diff";
  };
  readonly evaluateEnvelope: Record<string, unknown> & {
    evaluation: Record<string, unknown>;
  };
  readonly audienceSummary: string;
  readonly storedWorkflowOutcome: Pick<
    WorkflowOutcomeCandidateV1,
    "disposition" | "findings" | "limitations" | "openDecisions" | "producedArtifacts"
  >;
}

function loadFixture(name: "683ab88d" | "d158e98a"): PrrFixture {
  return JSON.parse(
    readFileSync(resolve(`test/fixtures/authoring-quality-prr-20260925/${name}.json`), "utf8"),
  ) as PrrFixture;
}

const FAIL_RUN = loadFixture("683ab88d");
const INSUFFICIENT_RUN = loadFixture("d158e98a");
const STATE_DIR = "/private/state";
const EVALUATE = "step:evaluate-document-quality";
const AUDIENCE = "step:test-audience-understanding";

const WALL_REDIRECT =
  "This is a capability or policy wall, not missing input. Change the request instead: narrow or retarget it, wait for the capability, or accept the outcome as incomplete. Do not retry the unchanged request.";
const STANDING_CLAUSE =
  "standing limitations of this workflow's evaluation, not a wall on this request";
const ADVISORY_LABEL = "Quality evaluation (model-authored, advisory; not a product verdict)";
const GENERIC_PATCH_REASON =
  "Inspect the saved product evidence and review the local patch before deciding whether to publish.";

function prrRecord(
  fixture: PrrFixture,
  overrides: {
    readonly workflow?: WorkflowName;
    readonly envelope?: Record<string, unknown>;
    readonly withPatch?: boolean;
  } = {},
): RunRecord {
  const step = (id: string, summary: string): RunRecord["steps"][number] => ({
    id,
    title: id,
    kind: "evaluate",
    skill: id,
    mode: "read-only",
    status: "succeeded",
    startedAt: "2026-09-25T12:00:00.000Z",
    completedAt: "2026-09-25T12:00:01.000Z",
    durationMs: 1_000,
    summary,
  });
  return {
    schemaVersion: 2,
    id: fixture.runId,
    workflow: overrides.workflow ?? fixture.workflow,
    repository: {
      sourcePath: "/private/checkout",
      requestedRevision: "HEAD",
      revision: fixture.repositoryRevision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-25T12:00:00.000Z",
    startedAt: "2026-09-25T12:00:00.000Z",
    completedAt: "2026-09-25T12:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      step("plan-documentation", "Typed product evidence fixture."),
      step("test-audience-understanding", fixture.audienceSummary),
      step(
        "evaluate-document-quality",
        JSON.stringify(overrides.envelope ?? fixture.evaluateEnvelope, null, 2),
      ),
    ],
    ...(overrides.withPatch === false
      ? {}
      : {
          changes: {
            files: fixture.changedFiles,
            patch: { ...fixture.patch, sha256: "c".repeat(64) },
          },
        }),
  };
}

/** The shipped chain: project, seal, and store the outcome on the record. */
async function sealed(record: RunRecord): Promise<RunRecord> {
  const candidate = await new AuthoringQualityWorkflowOutcomeProjector().project(record);
  record.workflowOutcome = createWorkflowOutcome(candidate, record);
  return record;
}

function context(record: RunRecord): RunSummaryContext {
  return {
    record,
    recordPath: `${STATE_DIR}/${record.id}.json`,
    repositoryPath: "/private/checkout",
    exitCode: 0,
  };
}

function sortedCodes(record: RunRecord): string[] {
  return (record.workflowOutcome?.findings ?? []).map((finding) => finding.code).sort();
}

function withEvaluation(
  fixture: PrrFixture,
  evaluation: Record<string, unknown>,
  root: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...fixture.evaluateEnvelope,
    ...root,
    evaluation: { ...fixture.evaluateEnvelope.evaluation, ...evaluation },
  };
}

/** NEXT is identical in the human footer and the sealed `nextSteps`. */
function expectNext(record: RunRecord, expected: { command: string; reason: string }): void {
  const value = context(record);
  expect(buildRunHumanNextCommand(value)).toEqual(expected);
  expect(collectRunResultNextSteps(value)).toEqual([expected.command, expected.reason]);
  const footer = formatRunSummary(value);
  expect(footer.filter((line) => line.trim() === expected.command)).toHaveLength(1);
  expect(footer.filter((line) => line.trim() === `Reason: ${expected.reason}`)).toHaveLength(1);
}

describe("authoring verdict and NEXT (#1437)", () => {
  it.each(["create-documentation", "update-documentation"] as const)(
    "shows unavailable validated quality for %s in normal and quiet CLI output",
    (workflow) => {
      const record = prrRecord(FAIL_RUN, { workflow });
      for (const quiet of [false, true]) {
        const output = formatRunSummary({ ...context(record), quiet }).join("\n");
        expect(output).toContain("QUALITY");
        expect(output).toContain("Quality: unavailable/not projected");
        expect(output).toContain("Limitation: quality-validation-unavailable");
        expect(output).not.toContain("Decision: pass");
      }
    },
  );

  it.each(["create-documentation", "update-documentation"] as const)(
    "distinguishes a missing evaluator from unavailable validation for %s",
    (workflow) => {
      const record = prrRecord(FAIL_RUN, { workflow });
      record.steps = record.steps.filter((step) => step.skill !== "evaluate-document-quality");
      const output = formatRunSummary(context(record)).join("\n");
      expect(output).toContain("Limitation: quality-evaluator-not-run");
      expect(output).not.toContain("Limitation: quality-validation-unavailable");
      expect(output).not.toContain("Decision: pass");
    },
  );

  it.each(["create-documentation", "update-documentation"] as const)(
    "keeps the sealed %s product outcome when validated quality is unavailable",
    async (workflow) => {
      const record = await sealed(prrRecord(FAIL_RUN, { workflow }));
      const outcome = record.workflowOutcome!;
      const result = buildRunResultV1(context(record));
      expect(result.quality).toBeNull();
      expect(result.execution.status).toBe("succeeded");
      expect(result.product.disposition).toBe(outcome.disposition);
      expect(result.product.findings).toEqual(outcome.findings.map((finding) => finding.code));
      expect(result.product.limitations).toEqual(
        expect.arrayContaining([...outcome.limitations, "quality-validation-unavailable"]),
      );
    },
  );

  it("carries a fail decision and its hard gate as advisory findings, with no wall wording", async () => {
    const record = await sealed(prrRecord(FAIL_RUN));
    const outcome = record.workflowOutcome!;

    expect(outcome.disposition).toBe("inconclusive");
    expect(sortedCodes(record)).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-evaluation.fail",
      "quality-hard-gate.material-omission",
      "quality-rubric-unavailable",
    ]);
    // Advisory codes are findings only; limitations stay the standing set.
    expect(outcome.limitations).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-rubric-unavailable",
    ]);
    const advisory = outcome.findings.filter(
      (finding) =>
        finding.code.startsWith("quality-evaluation.") ||
        finding.code.startsWith("quality-hard-gate."),
    );
    expect(advisory).toEqual([
      {
        id: "finding:authoring-quality:quality-evaluation.fail",
        kind: "evidence-limitation",
        severity: "warning",
        code: "quality-evaluation.fail",
        evidenceIds: [EVALUATE],
      },
      {
        id: "finding:authoring-quality:quality-hard-gate.material-omission",
        kind: "evidence-limitation",
        severity: "warning",
        code: "quality-hard-gate.material-omission",
        evidenceIds: [EVALUATE],
      },
    ]);

    expectNext(record, {
      command: `docsfab runs show ${FAIL_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason:
        "Review the retained patch at /private/checkout/.docsfab/patches/683ab88d-467c-4645-8991-b6977bafae00.patch before deciding whether to publish. " +
        "Product inconclusive; standing limitations of this workflow's evaluation, not a wall on this request: experimental-quality-profile, insufficient-evidence, quality-rubric-unavailable. " +
        "Quality evaluation (model-authored, advisory; not a product verdict): quality-evaluation.fail, quality-hard-gate.material-omission.",
    });
    const reason = buildRunHumanNextCommand(context(record))!.reason;
    expect(reason).not.toContain(WALL_REDIRECT);
    expect(reason).not.toContain("at a wall");
  });

  it("gives the evaluator's insufficient-evidence decision its own code, apart from the audience rule's", async () => {
    const record = await sealed(prrRecord(INSUFFICIENT_RUN));
    const outcome = record.workflowOutcome!;

    expect(outcome.disposition).toBe("inconclusive");
    expect(sortedCodes(record)).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-evaluation.insufficient-evidence",
      "quality-rubric-unavailable",
    ]);
    // The audience rule's code cites the audience step; the evaluator's cites only evaluate.
    expect(
      outcome.findings.find((finding) => finding.code === "insufficient-evidence")?.evidenceIds,
    ).toEqual([EVALUATE, AUDIENCE]);
    expect(
      outcome.findings.find(
        (finding) => finding.code === "quality-evaluation.insufficient-evidence",
      )?.evidenceIds,
    ).toEqual([EVALUATE]);
    expectNext(record, {
      command: `docsfab runs show ${INSUFFICIENT_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason:
        "Review the retained patch at /private/checkout/.docsfab/patches/d158e98a-742d-4cae-a208-1c117b940faa.patch before deciding whether to publish. " +
        "Product inconclusive; standing limitations of this workflow's evaluation, not a wall on this request: experimental-quality-profile, insufficient-evidence, quality-rubric-unavailable. " +
        "Quality evaluation (model-authored, advisory; not a product verdict): quality-evaluation.insufficient-evidence.",
    });
  });

  it("reads quality-rubric-unavailable from the envelope's qualityScore, including a null score", async () => {
    expect(FAIL_RUN.evaluateEnvelope).not.toHaveProperty("rubric");
    expect(FAIL_RUN.evaluateEnvelope).not.toHaveProperty("quality_score");
    expect(FAIL_RUN.evaluateEnvelope.qualityScore).toMatchObject({
      status: "unavailable",
    });
    for (const fixture of [FAIL_RUN, INSUFFICIENT_RUN]) {
      const record = await sealed(prrRecord(fixture));
      expect(record.workflowOutcome?.limitations).toContain("quality-rubric-unavailable");
    }

    const nullScore = await sealed(
      prrRecord(FAIL_RUN, {
        envelope: withEvaluation(FAIL_RUN, {}, { qualityScore: null }),
      }),
    );
    expect(nullScore.workflowOutcome?.limitations).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-rubric-unavailable",
    ]);

    // Positive control: an available score adds no rubric limitation.
    const availableScore = await sealed(
      prrRecord(FAIL_RUN, {
        envelope: withEvaluation(
          FAIL_RUN,
          {},
          {
            qualityScore: { status: "available", rubric_id: "task-guide-v0.1" },
          },
        ),
      }),
    );
    expect(availableScore.workflowOutcome?.limitations).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
    ]);
  });

  it("never infers ready from a pass decision with no hard gates", async () => {
    const record = await sealed(
      prrRecord(FAIL_RUN, {
        envelope: withEvaluation(
          FAIL_RUN,
          { overall_decision: "pass", hard_gate_failures: [] },
          {
            qualityScore: { status: "available", rubric_id: "task-guide-v0.1" },
          },
        ),
      }),
    );
    expect(record.workflowOutcome?.disposition).toBe("inconclusive");
    expect(sortedCodes(record)).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-evaluation.pass",
    ]);
    const reason = buildRunHumanNextCommand(context(record))!.reason;
    expect(reason).toContain(`${ADVISORY_LABEL}: quality-evaluation.pass.`);
    expect(reason).not.toContain(WALL_REDIRECT);
  });

  it.each([
    ["pass", "quality-evaluation.pass"],
    ["conditional-pass", "quality-evaluation.conditional-pass"],
    ["fail", "quality-evaluation.fail"],
    ["human-review", "quality-evaluation.human-review"],
    ["insufficient-evidence", "quality-evaluation.insufficient-evidence"],
  ])("maps the %s decision to %s and keeps it off the wall", async (decision, code) => {
    const record = await sealed(
      prrRecord(FAIL_RUN, {
        envelope: withEvaluation(FAIL_RUN, {
          overall_decision: decision,
          hard_gate_failures: [],
        }),
      }),
    );
    expect(record.workflowOutcome?.disposition).toBe("inconclusive");
    expect(sortedCodes(record).filter((item) => item.startsWith("quality-evaluation."))).toEqual([
      code,
    ]);
    expect(buildRunHumanNextCommand(context(record))!.reason).toContain(
      `${ADVISORY_LABEL}: ${code}.`,
    );
  });

  it("seals off-grammar, non-string, and configured-credential hard gates under one fixed code", async () => {
    // Composed at run time so no credential-shaped literal is in this file.
    // Only a configured credential is refused; a gate name that merely has a
    // credential shape stays a gate code (#1807).
    const configured = configureCredential(["sk", "q7w3e9r2t5y8u4i6o1p0z2x4"].join("-"));
    const credentialShaped = ["sk", "m4n8b2v6c1x5z9l3k7j0h2g4"].join("-");
    const record = await sealed(
      prrRecord(FAIL_RUN, {
        envelope: withEvaluation(FAIL_RUN, {
          hard_gate_failures: [
            "material-omission",
            "Material_Omission",
            42,
            "g".repeat(120),
            configured,
            credentialShaped,
          ],
        }),
      }),
    );
    expect(sortedCodes(record)).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-evaluation.fail",
      "quality-hard-gate-unrepresentable",
      "quality-hard-gate.material-omission",
      `quality-hard-gate.${credentialShaped}`,
      "quality-rubric-unavailable",
    ]);
    expect(JSON.stringify(record.workflowOutcome)).not.toContain(configured);
    const reason = buildRunHumanNextCommand(context(record))!.reason;
    expect(reason).toContain("quality-hard-gate-unrepresentable");
    expect(reason).not.toContain(WALL_REDIRECT);

    // A present hard_gate_failures that is not an array is reported, not dropped.
    const scalar = await sealed(
      prrRecord(FAIL_RUN, {
        envelope: withEvaluation(FAIL_RUN, {
          hard_gate_failures: "material-omission",
        }),
      }),
    );
    expect(sortedCodes(scalar)).toContain("quality-hard-gate-unrepresentable");
    expect(sortedCodes(scalar)).not.toContain("quality-hard-gate.material-omission");

    // An absent hard_gate_failures adds no gate code.
    const absentEvaluation = { ...FAIL_RUN.evaluateEnvelope.evaluation };
    delete absentEvaluation.hard_gate_failures;
    const absent = await sealed(
      prrRecord(FAIL_RUN, {
        envelope: {
          ...FAIL_RUN.evaluateEnvelope,
          evaluation: absentEvaluation,
        },
      }),
    );
    expect(sortedCodes(absent).filter((code) => code.startsWith("quality-hard-gate"))).toEqual([]);
  });

  it("keeps the wall, listing only the request-caused code, when standing codes are mixed with one", async () => {
    // The shape `validatedEditorialOutcome` seals: standing authoring codes
    // plus an editorial limitation the request caused.
    const record = prrRecord(FAIL_RUN);
    const candidate = await new AuthoringQualityWorkflowOutcomeProjector().project(record);
    const requestCaused: WorkflowOutcomeFindingV1 = {
      id: "finding:authoring-quality:evidence-limitation.independent-assessment-rejected",
      kind: "evidence-limitation",
      severity: "warning",
      code: "evidence-limitation.independent-assessment-rejected",
      evidenceIds: [EVALUATE],
    };
    record.workflowOutcome = createWorkflowOutcome(
      {
        ...candidate,
        findings: [...candidate.findings, requestCaused],
        limitations: [...candidate.limitations, requestCaused.code],
      },
      record,
    );
    expectNext(record, {
      command: `docsfab runs show ${FAIL_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason: `Product inconclusive at a wall: evidence-limitation evidence-limitation.independent-assessment-rejected (the admitted evidence cannot support a complete result). ${WALL_REDIRECT} The retained local patch does not resolve the wall; review it before any publish.`,
    });
  });

  it("keeps the wall for a request-caused editorial limitation alone on an authoring job", () => {
    const record = prrRecord(FAIL_RUN);
    const evidence = workflowOutcomeStepEvidence(record, "evaluate-document-quality");
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "inconclusive",
        findings: [
          {
            id: "finding:authoring-quality:evidence-limitation.independent-assessment-rejected",
            kind: "evidence-limitation",
            severity: "warning",
            code: "evidence-limitation.independent-assessment-rejected",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: ["evidence-limitation.independent-assessment-rejected"],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
    );
    const reason = buildRunHumanNextCommand(context(record))!.reason;
    expect(reason).toContain(WALL_REDIRECT);
    expect(reason).toContain("evidence-limitation.independent-assessment-rejected");
    expect(reason).not.toContain(STANDING_CLAUSE);
  });

  // A no-change basis code discloses how a run verified no change; the
  // wall never names it, whatever else the outcome carries. Another editorial
  // limitation on the same outcome stays a wall (control).
  it.each([
    { codes: ["no-change-basis.kept-pages"], wall: undefined },
    { codes: ["no-change-basis.nominated-coverage"], wall: undefined },
    { codes: ["audience-check-unavailable"], wall: "audience-check-unavailable" },
    {
      codes: ["audience-check-unavailable", "no-change-basis.kept-pages"],
      wall: "audience-check-unavailable",
    },
  ])("never names a no-change basis code as a wall ($codes)", ({ codes, wall }) => {
    const record = prrRecord(FAIL_RUN, { withPatch: false });
    const evidence = workflowOutcomeStepEvidence(record, "evaluate-document-quality");
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "inconclusive",
        findings: codes.map((code) => ({
          id: `finding:authoring-quality:${code}`,
          kind: "evidence-limitation" as const,
          severity: "warning" as const,
          code,
          evidenceIds: [evidence.id],
        })),
        evidence: [evidence],
        limitations: [...codes],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
    );
    const next = [
      buildRunHumanNextCommand(context(record))?.reason ?? "",
      ...collectRunResultNextSteps(context(record)),
    ].join("\n");
    expect(next).not.toContain("no-change-basis.");
    if (wall === undefined) {
      expect(next).not.toContain(WALL_REDIRECT);
    } else {
      expect(next).toContain(
        `Product inconclusive at a wall: evidence-limitation ${wall} (the admitted evidence cannot support a complete result). ${WALL_REDIRECT}`,
      );
    }
  });

  it("changes NEXT for a historical record sealed before #1437 without re-projecting it", () => {
    // 683ab88d's sealed outcome as stored (digests recomputed over the trimmed steps).
    const stored = FAIL_RUN.storedWorkflowOutcome;
    expect(stored.findings.map((finding) => finding.code)).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
    ]);
    const record = prrRecord(FAIL_RUN);
    record.workflowOutcome = createWorkflowOutcome(
      {
        ...stored,
        evidence: [
          workflowOutcomeStepEvidence(record, "evaluate-document-quality"),
          workflowOutcomeStepEvidence(record, "test-audience-understanding"),
        ],
      },
      record,
    );
    expectNext(record, {
      command: `docsfab runs show ${FAIL_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason:
        "Review the retained patch at /private/checkout/.docsfab/patches/683ab88d-467c-4645-8991-b6977bafae00.patch before deciding whether to publish. " +
        "Product inconclusive; standing limitations of this workflow's evaluation, not a wall on this request: experimental-quality-profile, insufficient-evidence.",
    });
  });

  it("inspects the saved run, naming no patch, when a standing-only authoring run retained none", async () => {
    const record = await sealed(prrRecord(INSUFFICIENT_RUN, { withPatch: false }));
    expectNext(record, {
      command: `docsfab runs show ${INSUFFICIENT_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason:
        "Inspect the saved product evidence; this run retained no patch. " +
        "Product inconclusive; standing limitations of this workflow's evaluation, not a wall on this request: experimental-quality-profile, insufficient-evidence, quality-rubric-unavailable. " +
        "Quality evaluation (model-authored, advisory; not a product verdict): quality-evaluation.insufficient-evidence.",
    });
  });

  it("applies the non-wall rule to restructure-documentation too", async () => {
    const record = await sealed(prrRecord(FAIL_RUN, { workflow: "restructure-documentation" }));
    const reason = buildRunHumanNextCommand(context(record))!.reason;
    expect(reason).toContain("Review the retained patch at ");
    expect(reason).toContain("quality-evaluation.fail");
    expect(reason).not.toContain(WALL_REDIRECT);
  });

  it("leaves review-documentation walls unchanged, even for a code the authoring set names", () => {
    // A non-authoring workflow carrying an authoring code stays a wall.
    for (const code of ["audit-search-incomplete", "experimental-quality-profile"]) {
      const record = prrRecord(FAIL_RUN, { workflow: "review-documentation" });
      const evidence = workflowOutcomeStepEvidence(record, "evaluate-document-quality");
      record.workflowOutcome = createWorkflowOutcome(
        {
          disposition: "inconclusive",
          findings: [
            {
              id: `finding:${code}`,
              kind: "evidence-limitation",
              severity: "warning",
              code,
              evidenceIds: [evidence.id],
            },
          ],
          evidence: [evidence],
          limitations: [code],
          openDecisions: [],
          producedArtifacts: [],
        },
        record,
      );
      expect(buildRunHumanNextCommand(context(record))).toEqual({
        command: `docsfab runs show ${FAIL_RUN.runId} --state-dir ${STATE_DIR} --json`,
        reason: `Product inconclusive at a wall: evidence-limitation ${code} (the admitted evidence cannot support a complete result). ${WALL_REDIRECT} The retained local patch does not resolve the wall; review it before any publish.`,
      });
    }
  });

  it("keeps a product-gap finding a wall on an authoring job even when its code is a standing code", () => {
    // The exclusion reads kind as well as code.
    const record = prrRecord(FAIL_RUN);
    const evidence = workflowOutcomeStepEvidence(record, "evaluate-document-quality");
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "not-ready",
        findings: [
          {
            id: "finding:insufficient-evidence",
            kind: "product-gap",
            severity: "blocking",
            code: "insufficient-evidence",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
    );
    const reason = buildRunHumanNextCommand(context(record))!.reason;
    expect(reason).toContain(
      "at a wall: product-gap insufficient-evidence (the product does not provide what the request needs)",
    );
    expect(reason).toContain(WALL_REDIRECT);
  });

  it("keeps the generic patch NEXT for an authoring record with no sealed outcome", () => {
    expect(buildRunHumanNextCommand(context(prrRecord(FAIL_RUN)))).toEqual({
      command: `docsfab runs show ${FAIL_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason: GENERIC_PATCH_REASON,
    });
  });

  it("keeps the generic patch NEXT when the sealed authoring outcome does not decode", async () => {
    // The catch in projectAuthoringOutcomeNext handles only an undecodable
    // sealed outcome; a tampered code breaks the seal digest.
    const record = await sealed(prrRecord(FAIL_RUN));
    const tampered = structuredClone(record.workflowOutcome!);
    tampered.findings[0]!.code = "quality-evaluation.pass";
    record.workflowOutcome = tampered;
    expect(buildRunHumanNextCommand(context(record))).toEqual({
      command: `docsfab runs show ${FAIL_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason: GENERIC_PATCH_REASON,
    });
  });

  it("keeps the generic patch NEXT for an authoring outcome with no standing or advisory finding", () => {
    // A current outcome with no authoring finding (a hand-sealed ready outcome).
    const record = prrRecord(FAIL_RUN);
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "ready",
        findings: [],
        evidence: [workflowOutcomeStepEvidence(record, "evaluate-document-quality")],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
    );
    expect(buildRunHumanNextCommand(context(record))).toEqual({
      command: `docsfab runs show ${FAIL_RUN.runId} --state-dir ${STATE_DIR} --json`,
      reason: GENERIC_PATCH_REASON,
    });
  });
});
