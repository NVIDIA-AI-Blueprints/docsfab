// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFoundationGapDecisionHostAuthority } from "../src/canon/gap-decisions.js";
import { sha256 } from "../src/content-ir/canonical.js";
import {
  CandidateExperimentError,
  sealCandidateAttempt,
  sealCandidateBaseline,
  sealCandidateEvaluationVector,
  sealCandidateEvaluatorRecord,
  type CandidateAttemptInputV1,
} from "../src/autonomy/candidate-attempt.js";
import { decideCandidateKeepDiscard } from "../src/autonomy/candidate-keep-discard.js";
import {
  sealCandidateExperimentBudget,
  sealCandidatePlateauPolicy,
} from "../src/autonomy/candidate-plateau.js";
import {
  appendCandidateExperimentEntry,
  createCandidateExperimentLedger,
  decodeCandidateExperimentLedger,
  runBoundedCandidateExperiment,
} from "../src/autonomy/experiment-ledger.js";
import {
  completeFoundationOnboarding,
  incompleteFoundationInspectSeed,
  inspectFoundation,
  projectFoundationOnboardingQuestions,
  type FoundationInspectResultV1,
} from "../src/foundation/index.js";
import {
  createFoundationToPatchAuthorization,
  FOUNDATION_TO_PATCH_SKILLS,
  runFoundationToPatch,
} from "../src/foundation/to-patch.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NOW = "2026-08-12T15:00:00.000Z";
const EXPIRES = "2026-08-12T16:00:00.000Z";
const AUTHORITY_ID = sha256("candidate-keep-discard-reviewer");

const SOURCE = sha256("source-checkout");
const BASELINE_CANDIDATE = sha256("baseline-candidate");
const IMPROVED = sha256("improved-candidate");
const STYLISH_REGRESSION = sha256("stylish-but-wrong");
const POLICY = sha256("evaluator-policy");
const INPUT = sha256("evaluator-input");
const RESULT = sha256("evaluator-result");

describe("candidate keep/discard / plateau / experiment ledger (#226)", () => {
  it("discards without altering source or prior selected candidate", () => {
    const baseline = makeBaseline();
    const attempt = makeAttempt({
      attemptIndex: 0,
      candidateSha256: STYLISH_REGRESSION,
      evaluation: {
        objective: {
          factual: "fail",
          citation: "pass",
          security: "pass",
          scope: "pass",
          mechanical: "pass",
        },
        quality: { clarity: 9, coverage: 9, style: 99 },
      },
    });

    const decision = decideCandidateKeepDiscard({
      attempt,
      baseline,
      selectedEvaluation: baseline.evaluation,
      priorSelectedCandidateSha256: baseline.selectedCandidateSha256,
    });

    expect(decision.disposition).toBe("discard");
    expect(decision.reasonCode).toBe("objective-regression");
    expect(decision.sourceCheckoutSha256).toBe(SOURCE);
    expect(decision.selectedCandidateSha256).toBe(BASELINE_CANDIDATE);
    expect(decision.priorSelectedCandidateSha256).toBe(BASELINE_CANDIDATE);
    expect(decision.disposableWorkspaceId).toBe("workspace:attempt-0");
    expect(attempt.sourceCheckoutSha256).toBe(SOURCE);
    expect(baseline.selectedCandidateSha256).toBe(BASELINE_CANDIDATE);
  });

  it("rejects style gains that offset objective / mechanical regressions (lexicographic)", () => {
    const baseline = makeBaseline({
      quality: { clarity: 1, coverage: 1, style: 1 },
    });

    for (const dimension of ["factual", "citation", "security", "scope", "mechanical"] as const) {
      const objective = {
        factual: "pass" as const,
        citation: "pass" as const,
        security: "pass" as const,
        scope: "pass" as const,
        mechanical: "pass" as const,
        [dimension]: "fail" as const,
      };
      const decision = decideCandidateKeepDiscard({
        attempt: makeAttempt({
          attemptIndex: 0,
          candidateSha256: sha256(`regression:${dimension}`),
          evaluation: {
            objective,
            quality: { clarity: 99, coverage: 99, style: 99 },
          },
        }),
        baseline,
        selectedEvaluation: baseline.evaluation,
        priorSelectedCandidateSha256: baseline.selectedCandidateSha256,
      });
      expect(decision.disposition).toBe("discard");
      expect(decision.reasonCode).toBe("objective-regression");
      expect(decision.selectedCandidateSha256).toBe(BASELINE_CANDIDATE);
    }

    const keep = decideCandidateKeepDiscard({
      attempt: makeAttempt({
        attemptIndex: 1,
        candidateSha256: IMPROVED,
        evaluation: {
          objective: {
            factual: "pass",
            citation: "pass",
            security: "pass",
            scope: "pass",
            mechanical: "pass",
          },
          quality: { clarity: 5, coverage: 1, style: 1 },
        },
      }),
      baseline,
      selectedEvaluation: baseline.evaluation,
      priorSelectedCandidateSha256: baseline.selectedCandidateSha256,
    });
    expect(keep.disposition).toBe("keep");
    expect(keep.reasonCode).toBe("lexicographic-improvement");
    expect(keep.selectedCandidateSha256).toBe(IMPROVED);
  });

  it("records evaluator identity/policy, inputs, commands, results, and independence", () => {
    const evaluators = [
      sealCandidateEvaluatorRecord({
        evaluatorId: "deterministic-truth-gate",
        policySha256: POLICY,
        inputSha256: INPUT,
        commandsRun: ["gate:factual", "gate:citation"],
        resultSha256: RESULT,
        independence: "independent",
      }),
      sealCandidateEvaluatorRecord({
        evaluatorId: "advisory-persona",
        policySha256: sha256("persona-policy"),
        inputSha256: sha256("persona-input"),
        commandsRun: ["persona:clarity"],
        resultSha256: sha256("persona-result"),
        independence: "advisory",
      }),
    ];
    const attempt = sealCandidateAttempt({
      attemptIndex: 0,
      disposableWorkspaceId: "workspace:attempt-0",
      candidateSha256: IMPROVED,
      baselineSha256: makeBaseline().baselineSha256,
      sourceCheckoutSha256: SOURCE,
      evaluation: {
        objective: {
          factual: "pass",
          citation: "pass",
          security: "pass",
          scope: "pass",
          mechanical: "pass",
        },
        quality: { clarity: 3, coverage: 2, style: 2 },
      },
      evaluators,
    });

    expect(attempt.evaluators).toHaveLength(2);
    expect(attempt.evaluators[0]).toMatchObject({
      evaluatorId: "deterministic-truth-gate",
      policySha256: POLICY,
      inputSha256: INPUT,
      commandsRun: ["gate:citation", "gate:factual"],
      resultSha256: RESULT,
      independence: "independent",
    });
    expect(attempt.evaluators[0]!.recordSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attempt.evaluators[1]!.independence).toBe("advisory");
  });

  it("does not duplicate attempts or decisions on identical replay", () => {
    const baseline = makeBaseline();
    const budget = sealCandidateExperimentBudget({
      maxAttempts: 5,
      maxElapsedMs: 60_000,
      maxTokens: 10_000,
      maxCostUnits: 100,
    });
    const plateau = sealCandidatePlateauPolicy({ consecutiveNonImprovingLimit: 3 });
    let ledger = createCandidateExperimentLedger({
      experimentId: "experiment:replay",
      baseline,
      budget,
      plateau,
    });

    const attemptInput = attemptInputFrom(baseline, {
      attemptIndex: 0,
      candidateSha256: IMPROVED,
      evaluation: {
        objective: {
          factual: "pass",
          citation: "pass",
          security: "pass",
          scope: "pass",
          mechanical: "pass",
        },
        quality: { clarity: 4, coverage: 1, style: 1 },
      },
    });

    const first = appendCandidateExperimentEntry(ledger, { attempt: attemptInput });
    expect(first.replayIdempotent).toBe(false);
    expect(first.ledger.entries).toHaveLength(1);
    ledger = first.ledger;

    const second = appendCandidateExperimentEntry(ledger, { attempt: attemptInput });
    expect(second.replayIdempotent).toBe(true);
    expect(second.ledger.entries).toHaveLength(1);
    expect(second.ledger.ledgerSha256).toBe(ledger.ledgerSha256);
    expect(decodeCandidateExperimentLedger(second.ledger).entries).toHaveLength(1);
  });

  it("treats budget exhaustion and plateau as bounded successful terminals", () => {
    const baseline = makeBaseline();
    const budget = sealCandidateExperimentBudget({
      maxAttempts: 2,
      maxElapsedMs: 60_000,
      maxTokens: 10_000,
      maxCostUnits: 100,
    });
    const plateau = sealCandidatePlateauPolicy({ consecutiveNonImprovingLimit: 2 });

    const budgetRun = runBoundedCandidateExperiment({
      experimentId: "experiment:budget",
      baseline,
      budget,
      plateau: sealCandidatePlateauPolicy({ consecutiveNonImprovingLimit: 99 }),
      generateAttempt: ({ attemptIndex }) =>
        attemptInputFrom(baseline, {
          attemptIndex,
          candidateSha256: sha256(`budget-cand:${attemptIndex}`),
          evaluation: {
            objective: {
              factual: "pass",
              citation: "pass",
              security: "pass",
              scope: "pass",
              mechanical: "pass",
            },
            // Equal quality → discard / no improvement; still charges attempts.
            quality: { clarity: 1, coverage: 1, style: 1 },
          },
        }),
    });
    expect(budgetRun.ledger.terminal?.reason).toBe("budget-exhausted");
    expect(budgetRun.ledger.terminal?.boundedSuccess).toBe(true);
    expect(budgetRun.ledger.entries).toHaveLength(2);
    expect(budgetRun.ledger.selectedCandidateSha256).toBe(BASELINE_CANDIDATE);

    const plateauRun = runBoundedCandidateExperiment({
      experimentId: "experiment:plateau",
      baseline,
      budget: sealCandidateExperimentBudget({
        maxAttempts: 10,
        maxElapsedMs: 60_000,
        maxTokens: 10_000,
        maxCostUnits: 100,
      }),
      plateau,
      generateAttempt: ({ attemptIndex }) =>
        attemptInputFrom(baseline, {
          attemptIndex,
          candidateSha256: sha256(`plateau-cand:${attemptIndex}`),
          evaluation: {
            objective: {
              factual: "pass",
              citation: "pass",
              security: "pass",
              scope: "pass",
              mechanical: "pass",
            },
            quality: { clarity: 1, coverage: 1, style: 1 },
          },
        }),
    });
    expect(plateauRun.ledger.terminal?.reason).toBe("plateau");
    expect(plateauRun.ledger.terminal?.boundedSuccess).toBe(true);
    expect(plateauRun.ledger.entries).toHaveLength(2);
    expect(plateauRun.ledger.selectedCandidateSha256).toBe(BASELINE_CANDIDATE);
  });

  it("foundation-to-patch integration keeps dispositions and sourceCheckoutUnchanged", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const ready = await readyInspect(fixture);
    const authorization = createFoundationToPatchAuthorization({
      intendedPaths: ["docs/README.md"],
      decidedAt: NOW,
      expiresAt: EXPIRES,
    });
    const baseline = makeBaseline({
      sourceCheckoutSha256: sha256(`source:${fixture.revision}`),
      selectedCandidateSha256: sha256("ftp-baseline-candidate"),
    });

    const result = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: true,
      now: NOW,
      inspect: ready,
      authorization,
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
        status: "ready",
        planSha256: sha256("ftp-plan"),
        intendedPaths: ["docs/README.md"],
      }),
      candidateExperiment: {
        experimentId: "experiment:ftp",
        baseline,
        budget: sealCandidateExperimentBudget({
          maxAttempts: 3,
          maxElapsedMs: 60_000,
          maxTokens: 10_000,
          maxCostUnits: 100,
        }),
        plateau: sealCandidatePlateauPolicy({ consecutiveNonImprovingLimit: 3 }),
        generateAttempt: ({ attemptIndex, sourceCheckoutSha256, baselineSha256 }) => {
          if (attemptIndex >= 1) return null;
          return attemptInputFrom(baseline, {
            attemptIndex,
            sourceCheckoutSha256,
            baselineSha256,
            candidateSha256: sha256("ftp-improved-candidate"),
            evaluation: {
              objective: {
                factual: "pass",
                citation: "pass",
                security: "pass",
                scope: "pass",
                mechanical: "pass",
              },
              quality: { clarity: 4, coverage: 2, style: 2 },
            },
          });
        },
        toCandidateEvidence: (selectedCandidateSha256) => ({
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-candidate",
          skillId: FOUNDATION_TO_PATCH_SKILLS.draft,
          candidateSha256: selectedCandidateSha256,
          changedPaths: ["docs/README.md"],
        }),
      },
      validateStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-validation",
        status: "passed",
        validationSha256: sha256("ftp-validation"),
        changedPaths: ["docs/README.md"],
      }),
    });

    expect(result.sourceCheckoutUnchanged).toBe(true);
    expect(result.productDisposition).toBe("ready");
    expect(result.status).toBe("succeeded");
    expect(result.checkpoint.experiment?.boundedTerminal).toBe(true);
    expect(result.checkpoint.experiment?.attemptCount).toBe(1);
    expect(result.checkpoint.candidate?.candidateSha256).toBe(sha256("ftp-improved-candidate"));
    expect(result.checkpoint.experiment?.sourceCheckoutSha256).toBe(
      sha256(`source:${fixture.revision}`),
    );
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("rejects disposable workspace identity colliding with source checkout", () => {
    expect(() =>
      sealCandidateAttempt({
        attemptIndex: 0,
        disposableWorkspaceId: SOURCE,
        candidateSha256: IMPROVED,
        baselineSha256: makeBaseline().baselineSha256,
        sourceCheckoutSha256: SOURCE,
        evaluation: {
          objective: {
            factual: "pass",
            citation: "pass",
            security: "pass",
            scope: "pass",
            mechanical: "pass",
          },
          quality: { clarity: 1, coverage: 1, style: 1 },
        },
        evaluators: [defaultEvaluator()],
      }),
    ).toThrow(CandidateExperimentError);
  });
});

function makeBaseline(overrides?: {
  sourceCheckoutSha256?: string;
  selectedCandidateSha256?: string;
  quality?: { clarity: number; coverage: number; style: number };
}) {
  return sealCandidateBaseline({
    sourceCheckoutSha256: overrides?.sourceCheckoutSha256 ?? SOURCE,
    selectedCandidateSha256: overrides?.selectedCandidateSha256 ?? BASELINE_CANDIDATE,
    evaluation: sealCandidateEvaluationVector({
      objective: {
        factual: "pass",
        citation: "pass",
        security: "pass",
        scope: "pass",
        mechanical: "pass",
      },
      quality: overrides?.quality ?? { clarity: 1, coverage: 1, style: 1 },
    }),
  });
}

function defaultEvaluator() {
  return sealCandidateEvaluatorRecord({
    evaluatorId: "deterministic-truth-gate",
    policySha256: POLICY,
    inputSha256: INPUT,
    commandsRun: ["gate:factual"],
    resultSha256: RESULT,
    independence: "independent",
  });
}

function makeAttempt(input: {
  attemptIndex: number;
  candidateSha256: string;
  evaluation: {
    objective: {
      factual: "pass" | "fail";
      citation: "pass" | "fail";
      security: "pass" | "fail";
      scope: "pass" | "fail";
      mechanical: "pass" | "fail";
    };
    quality: { clarity: number; coverage: number; style: number };
  };
}) {
  const baseline = makeBaseline();
  return sealCandidateAttempt(attemptInputFrom(baseline, input));
}

function attemptInputFrom(
  baseline: ReturnType<typeof makeBaseline>,
  input: {
    attemptIndex: number;
    candidateSha256: string;
    evaluation: {
      objective: {
        factual: "pass" | "fail";
        citation: "pass" | "fail";
        security: "pass" | "fail";
        scope: "pass" | "fail";
        mechanical: "pass" | "fail";
      };
      quality: { clarity: number; coverage: number; style: number };
    };
    sourceCheckoutSha256?: string;
    baselineSha256?: string;
  },
): CandidateAttemptInputV1 {
  return {
    attemptIndex: input.attemptIndex,
    disposableWorkspaceId: `workspace:attempt-${input.attemptIndex}`,
    candidateSha256: input.candidateSha256,
    baselineSha256: input.baselineSha256 ?? baseline.baselineSha256,
    sourceCheckoutSha256: input.sourceCheckoutSha256 ?? baseline.sourceCheckoutSha256,
    evaluation: input.evaluation,
    evaluators: [defaultEvaluator()],
  };
}

function hostAuthority(receipts: string[]) {
  let index = 0;
  return createFoundationGapDecisionHostAuthority({
    verifyCurrent: (challenge) => {
      const receipt = receipts[index] ?? sha256(`receipt-extra-${index}`);
      index += 1;
      return {
        status: "current",
        challengeSha256: challenge.challengeSha256,
        observedAt: NOW,
        authorityReceiptSha256: receipt,
        authorityIdentitySha256: AUTHORITY_ID,
      };
    },
  });
}

function goldenDecisions(questionIds: readonly string[]) {
  return questionIds.map((questionId) => {
    if (questionId === "q-accepted-assumption") {
      return {
        questionId,
        disposition: "accept-assumption" as const,
        answerValueSha256: sha256(`assumption-answer:${questionId}`),
      };
    }
    return {
      questionId,
      disposition: "answer" as const,
      answerValueSha256: sha256(`answer:${questionId}`),
    };
  });
}

async function readyInspect(fixture: {
  repository: string;
  revision: string;
}): Promise<FoundationInspectResultV1> {
  const prior = await inspectFoundation({
    repositoryPath: fixture.repository,
    repositoryRevision: fixture.revision,
    ...incompleteFoundationInspectSeed(fixture.revision),
  });
  const questions = projectFoundationOnboardingQuestions(prior);
  const session = await completeFoundationOnboarding({
    repositoryPath: fixture.repository,
    inspect: prior,
    authority: hostAuthority(questions.map((_, i) => sha256(`ckd-${i}`))),
    authorityIdentitySha256: AUTHORITY_ID,
    decisions: goldenDecisions(questions.map((item) => item.id)),
    expiresAt: EXPIRES,
    now: NOW,
  });
  expect(session.inspect.readiness).toBe("ready");
  return session.inspect;
}

async function createIncompleteFixture(): Promise<{ repository: string; revision: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-candidate-kd-")));
  roots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository, { recursive: true });
  await writeFile(
    join(repository, "README.md"),
    "# Incomplete golden\n\nNo registered evidence.\n",
  );
  await writeFile(join(repository, "AGENTS.md"), "# Agents\n\nRead-only fixture guidance.\n");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "docs", "README.md"), "# Docs\n\nPlaceholder.\n");
  await writeFile(join(repository, "docs", "guide.md"), "# Guide\n\nPlaceholder document.\n");

  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "candidate@example.test"], {
    cwd: repository,
  });
  await execFileAsync("git", ["config", "user.name", "Candidate Fixture"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "candidate keep-discard golden"], {
    cwd: repository,
  });
  const revision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  return { repository, revision };
}

async function snapshotTree(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain"]);
  const { stdout: head } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  const readme = await readFile(join(root, "README.md"));
  return createHash("sha256")
    .update(head)
    .update("\0")
    .update(stdout)
    .update("\0")
    .update(readme)
    .digest("hex");
}
