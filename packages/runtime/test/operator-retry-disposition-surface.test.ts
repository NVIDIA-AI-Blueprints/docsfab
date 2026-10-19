// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run record's retry condition (was the failure retryable) and decision
 * (what the policy did) as an operator sees them. Cases drive `WorkflowRunner`,
 * persist through `FileRunStore`, and read back through `docsfab runs show`
 * (`handleRunsCommand`) and `formatRunSummary`.
 *
 * Expected sentences come from `INFERENCE_RETRY_DECISION_REASONS`; one
 * hand-written anchor pins the shape of a rendered line. Each fixture carries
 * its own revision and provider error text, so a crossed assertion fails.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import type {
  AgentHarness,
  HarnessStepInput,
  InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import {
  formatRunSummary,
  INFERENCE_RETRY_DECISION_REASONS,
  RETRY_ELIGIBILITY_DISAGREEMENT,
  RETRY_ELIGIBILITY_DISAGREEMENT_REASON,
  type RunSummaryContext,
} from "../src/operator/index.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import type {
  RepositoryEvidenceCollector,
  RepositoryEvidenceContext,
} from "../src/repository/contracts.js";
import type { RepositorySecurityScanner, SecurityScanReport } from "../src/security/contracts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

afterEach(async () => {
  process.exitCode = undefined;
});

/** Each fixture's own identity, so a crossed assertion fails. */
const THROTTLED_RETRY_REVISION = "a3f0".padEnd(40, "1");
const WRITE_STEP_REVISION = "b4e1".padEnd(40, "2");
const TERMINAL_REVISION = "c5d2".padEnd(40, "3");
const CLEAN_REVISION = "d6c3".padEnd(40, "4");
const DIVERGENT_REVISION = "e7b4".padEnd(40, "5");
const HOST_REFUSAL_REVISION = "f8a5".padEnd(40, "6");
const TERMINAL_POLICY_REVISION = "09b6".padEnd(40, "7");
const NO_ALLOWANCE_REVISION = "1ac7".padEnd(40, "8");
const MALFORMED_OUTCOME_REVISION = "2bd8".padEnd(40, "9");
const DOWNSTREAM_REVISION = "3ce9".padEnd(40, "0");
const UNREADABLE_ATTEMPT_REVISION = "4df0".padEnd(40, "a");
const CORRUPT_PAIR_REVISION = "5e01".padEnd(40, "b");
const ELIGIBLE_DECLINED_REVISION = "6f12".padEnd(40, "c");

const THROTTLED_ERROR = "429 throttled by the front door";
const WRITE_STEP_ERROR = "429 throttled while scaffolding guidance";
const TERMINAL_ERROR = "400 invalid request for this deployment";
/** Reads like a throttle; is classified as a deterministic exhaustion. */
const MISLEADING_THROTTLE_ERROR = "429 throttled, please retry shortly";

class ScannerFixture implements RepositorySecurityScanner {
  public async scan(): Promise<SecurityScanReport> {
    return { ruleSet: "test-v1", status: "passed", scannedFiles: 2, binaryFiles: 0, findings: [] };
  }
}

class EvidenceFixture implements RepositoryEvidenceCollector {
  public async capture(_context: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    return { files: [] };
  }
}

interface PersistedRun {
  readonly runId: string;
  readonly stateDirectory: string;
  readonly record: RunRecord;
}

/**
 * Drives the runner to a terminal state and reads the persisted record, which
 * is what `runs show` later loads.
 */
async function persistRun(options: {
  runId: string;
  workflow: "readiness" | "bootstrap";
  revision: string;
  retryPolicy: InferenceRetryPolicy;
  runStep: AgentHarness["runStep"];
  allowWrite?: boolean;
}): Promise<PersistedRun> {
  const root = await roots.create("docsfab-480c-");
  const stateDirectory = join(root, "runs");
  const repository = join(root, "repository");
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(repository, { recursive: true });
  const runner = new WorkflowRunner({
    harness: { runStep: options.runStep },
    store: new FileRunStore(stateDirectory),
    repositoryScanner: new ScannerFixture(),
    contextPreflight: readyContextPreflight,
    repositoryEvidence: new EvidenceFixture(),
    retryPolicy: options.retryPolicy,
    retrySleep: async () => {},
    id: () => options.runId,
  });
  try {
    await runner.run({
      workflow: options.workflow,
      workspacePath: repository,
      repository: {
        sourcePath: repository,
        requestedRevision: "HEAD",
        revision: options.revision,
      },
      allowWrite: options.allowWrite ?? false,
    });
  } catch {
    // A failed workflow may reject; the persisted record is the subject.
  }
  const record = parseJsonEvidence(
    await readFile(join(stateDirectory, `${options.runId}.json`)),
  ) as unknown as RunRecord;
  return { runId: options.runId, stateDirectory, record };
}

async function persistMutatedRun(
  run: PersistedRun,
  mutate: (record: RunRecord) => void,
): Promise<PersistedRun> {
  mutate(run.record);
  await writeFile(join(run.stateDirectory, `${run.runId}.json`), `${JSON.stringify(run.record)}\n`);
  const record = parseJsonEvidence(
    await readFile(join(run.stateDirectory, `${run.runId}.json`)),
  ) as unknown as RunRecord;
  return { ...run, record };
}

function retryPolicy(maxRetries: number): InferenceRetryPolicy {
  return {
    maxRetries,
    baseDelayMs: 1,
    maxDelayMs: 1,
    retryableCategories: ["throttled"],
  };
}

function throttlingHarness(message: string): AgentHarness["runStep"] {
  return async (_input: HarnessStepInput) => {
    throw new InferenceStepError(message, "throttled", true, undefined, {
      code: "provider-throttle",
      location: "$response",
    });
  };
}

async function captureShow(run: PersistedRun, extra: readonly string[] = []): Promise<string> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => {
    chunks.push(values.map((value) => String(value)).join(" "));
  };
  try {
    await handleRunsCommand(["show", run.runId, "--state-dir", run.stateDirectory, ...extra]);
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

function runFooter(run: PersistedRun): string {
  const context: RunSummaryContext = {
    record: run.record,
    recordPath: join(run.stateDirectory, `${run.runId}.json`),
    exitCode: run.record.status === "failed" ? 2 : 0,
    repositoryPath: run.record.repository.sourcePath,
    tty: false,
    ci: false,
    noColor: true,
  };
  return formatRunSummary(context).join("\n");
}

describe("#480 part C: the retryability/decision pair on the operator surfaces", () => {
  it("shows one line per attempt for an eligible condition that was retried and then exhausted", async () => {
    const run = await persistRun({
      runId: "retry-exhausted-run",
      workflow: "readiness",
      revision: THROTTLED_RETRY_REVISION,
      retryPolicy: retryPolicy(2),
      runStep: throttlingHarness(THROTTLED_ERROR),
    });

    const attempts = run.record.steps[0]?.inference?.attempts ?? [];
    expect(attempts.map((attempt) => attempt.conditionRetryability)).toEqual([
      "eligible",
      "eligible",
      "eligible",
    ]);
    expect(attempts.map((attempt) => attempt.retryDecision)).toEqual([
      "retried",
      "retried",
      "exhausted",
    ]);

    const shown = await captureShow(run);
    expect(shown).toContain("RETRIES");
    // The hand-written anchor for the shape of a rendered attempt line.
    // The recorded retry rule is the token: this policy has no transport budget,
    // so the throttle was retried from the shared count, under its own rule.
    expect(shown).toContain(
      "Step assess-readiness attempt 1: throttled; condition eligible; retryable true; decision retried-transport" +
        " (the provider throttled or failed in transport, so the step retried from its transport budget);" +
        " retries remaining 1; physical unavailable; rejected by provider-throttle at $response",
    );
    expect(shown).toContain(
      `Step assess-readiness attempt 3: throttled; condition eligible; retryable true; decision exhausted (${INFERENCE_RETRY_DECISION_REASONS.exhausted})`,
    );
    // Each attempt is its own line, not collapsed to the terminal attempt.
    expect(shown).toContain("Step assess-readiness attempt 2: throttled; condition eligible");
    expect(shown.match(/Step assess-readiness attempt \d+:/gu)).toHaveLength(3);

    // The run footer states the terminal attempt in one sentence.
    expect(runFooter(run)).toContain(
      `Step assess-readiness condition eligible, retryable true, retry decision exhausted on attempt 3 (${INFERENCE_RETRY_DECISION_REASONS.exhausted}); retries remaining 0; physical unavailable.`,
    );
  });

  it("names the write-mode step as the reason an eligible condition was declined", async () => {
    const run = await persistRun({
      runId: "declined-write-step-run",
      workflow: "bootstrap",
      revision: WRITE_STEP_REVISION,
      retryPolicy: retryPolicy(2),
      runStep: throttlingHarness(WRITE_STEP_ERROR),
      allowWrite: true,
    });

    const execution = run.record.steps[0]?.inference;
    expect(execution?.replay).toBe("disabled-write-step");
    // A retry window was configured and the step still never had one.
    expect(execution?.configuredMaxRetries).toBe(2);
    expect(execution?.effectiveMaxRetries).toBe(0);
    expect(execution?.attempts.at(-1)?.conditionRetryability).toBe("eligible");
    expect(execution?.attempts.at(-1)?.retryDecision).toBe("declined");

    const shown = await captureShow(run);
    expect(shown).toContain(
      `Step bootstrap-guidance attempt 1: throttled; condition eligible; retryable true; decision declined-write-step (${INFERENCE_RETRY_DECISION_REASONS["declined-write-step"]})`,
    );
    // The decline is not reported as a spent allowance.
    expect(shown).not.toContain("decision exhausted");
    expect(shown).toContain(
      `Step bootstrap-guidance condition eligible, retryable true, retry decision declined-write-step on attempt 1 (${INFERENCE_RETRY_DECISION_REASONS["declined-write-step"]}); retries remaining 0; physical unavailable.`,
    );
    expect(runFooter(run)).toContain("retry decision declined-write-step on attempt 1");
  });

  it("shows a non-retryable condition as not-eligible with no decision to make", async () => {
    const run = await persistRun({
      runId: "terminal-condition-run",
      workflow: "readiness",
      revision: TERMINAL_REVISION,
      retryPolicy: retryPolicy(2),
      runStep: async () => {
        throw new InferenceStepError(TERMINAL_ERROR, "provider-terminal", false);
      },
    });

    const attempt = run.record.steps[0]?.inference?.attempts.at(-1);
    expect(attempt?.conditionRetryability).toBe("not-eligible");
    expect(attempt?.retryDecision).toBe("not-applicable");

    const shown = await captureShow(run);
    expect(shown).toContain(
      `Step assess-readiness attempt 1: provider-terminal; condition not-eligible; retryable false; decision not-applicable (${INFERENCE_RETRY_DECISION_REASONS["not-applicable"]})`,
    );
    expect(shown.match(/Step assess-readiness attempt \d+:/gu)).toHaveLength(1);
    expect(runFooter(run)).toContain(
      `Step assess-readiness condition not-eligible, retryable false, retry decision not-applicable on attempt 1 (${INFERENCE_RETRY_DECISION_REASONS["not-applicable"]}); retries remaining 2; physical unavailable.`,
    );
  });

  it("reads the record, not the error text, when the two disagree", async () => {
    // The failure text reads like a transient throttle and the harness reports
    // `retryable: true`, but the classified condition is a deterministic
    // context exhaustion no policy may list. Rendering from the message would
    // invite a retry that cannot succeed.
    const run = await persistRun({
      runId: "text-disagrees-run",
      workflow: "readiness",
      revision: DIVERGENT_REVISION,
      retryPolicy: retryPolicy(2),
      runStep: async () => {
        throw new InferenceStepError(MISLEADING_THROTTLE_ERROR, "context-exhausted", true);
      },
    });

    expect(run.record.error).toContain("throttled");
    expect(run.record.steps[0]?.error).toContain("throttled");
    const attempt = run.record.steps[0]?.inference?.attempts.at(-1);
    expect(attempt?.outcome).toBe("context-exhausted");
    expect(attempt?.conditionRetryability).toBe("not-eligible");

    const shown = await captureShow(run);
    expect(shown).toContain(
      "Step assess-readiness attempt 1: context-exhausted; condition not-eligible; retryable false; decision not-applicable",
    );
    expect(shown).not.toContain("condition eligible");
    expect(runFooter(run)).toContain(
      "Step assess-readiness condition not-eligible, retryable false, retry decision not-applicable on attempt 1",
    );
    expect(runFooter(run)).not.toContain("condition eligible");
  });

  it("carries the decoded fields verbatim into the --json envelope", async () => {
    const run = await persistRun({
      runId: "json-envelope-run",
      workflow: "readiness",
      revision: THROTTLED_RETRY_REVISION,
      retryPolicy: retryPolicy(1),
      runStep: throttlingHarness(THROTTLED_ERROR),
    });

    const json = await captureShow(run, ["--json"]);
    const envelope = parseJsonEvidence(json) as unknown as {
      retryDispositions?: readonly Record<string, unknown>[];
    };
    expect(envelope.retryDispositions).toEqual([
      {
        stepId: "assess-readiness",
        attempt: 1,
        outcome: "throttled",
        conditionRetryability: "eligible",
        retryDecision: "retried",
        decisionToken: "retried-transport",
        retryable: true,
        retriesRemaining: 0,
        // No turn ledger reached this record, so the physical-request count is
        // reported unavailable rather than claimed to be zero.
        physicalAttempts: "unavailable",
        rejection: { code: "provider-throttle", location: "$response" },
      },
      {
        stepId: "assess-readiness",
        attempt: 2,
        outcome: "throttled",
        conditionRetryability: "eligible",
        retryDecision: "exhausted",
        decisionToken: "exhausted",
        retryable: true,
        retriesRemaining: 0,
        physicalAttempts: "unavailable",
        rejection: { code: "provider-throttle", location: "$response" },
      },
    ]);
    // Verbatim: the JSON values are the record's own, not a re-derivation.
    const recorded = run.record.steps[0]?.inference?.attempts ?? [];
    expect(envelope.retryDispositions?.map((entry) => entry.retryDecision)).toEqual(
      recorded.map((attempt) => attempt.retryDecision),
    );
    expect(envelope.retryDispositions?.map((entry) => entry.conditionRetryability)).toEqual(
      recorded.map((attempt) => attempt.conditionRetryability),
    );
  });

  it("positive control: a step with no retry history renders nothing new", async () => {
    const run = await persistRun({
      runId: "clean-run",
      workflow: "readiness",
      revision: CLEAN_REVISION,
      retryPolicy: retryPolicy(2),
      runStep: async (input: HarnessStepInput) => ({
        summary: `ran ${input.step.skill}`,
        model: { provider: "hosted", model: "test-model" },
      }),
    });

    // The run succeeded on its first attempt, so the pair exists on the record
    // but is not an operator question.
    const attempts = run.record.steps[0]?.inference?.attempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("succeeded");
    expect(attempts[0]?.retryDecision).toBe("not-applicable");

    const shown = await captureShow(run);
    expect(shown).not.toContain("RETRIES");
    expect(shown).not.toContain("condition not-applicable");
    expect(shown).not.toContain("retry decision");
    expect(runFooter(run)).not.toContain("retry decision");

    const json = await captureShow(run, ["--json"]);
    const envelope = parseJsonEvidence(json) as unknown as {
      retryDispositions?: unknown;
    };
    expect(envelope.retryDispositions).toBeUndefined();
  });

  it("names host-refusal, terminal-policy, and no-allowance from the recorded fields", async () => {
    const hostRefusal = await persistRun({
      runId: "declined-host-refusal-run",
      workflow: "readiness",
      revision: HOST_REFUSAL_REVISION,
      retryPolicy: retryPolicy(2),
      runStep: async () => {
        throw new InferenceStepError(THROTTLED_ERROR, "throttled", false);
      },
    });
    expect(hostRefusal.record.steps[0]?.inference?.attempts.at(-1)?.retryable).toBe(false);
    expect(await captureShow(hostRefusal)).toContain(
      `decision declined-host-refusal (${INFERENCE_RETRY_DECISION_REASONS["declined-host-refusal"]})`,
    );
    expect(runFooter(hostRefusal)).toContain("retry decision declined-host-refusal");

    const terminalPolicy = await persistRun({
      runId: "declined-terminal-policy-run",
      workflow: "readiness",
      revision: TERMINAL_POLICY_REVISION,
      retryPolicy: {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["timeout"],
      },
      runStep: throttlingHarness(THROTTLED_ERROR),
    });
    expect(await captureShow(terminalPolicy)).toContain(
      `decision declined-terminal-policy (${INFERENCE_RETRY_DECISION_REASONS["declined-terminal-policy"]})`,
    );
    expect(runFooter(terminalPolicy)).toContain("retry decision declined-terminal-policy");

    const noAllowance = await persistRun({
      runId: "declined-no-allowance-run",
      workflow: "readiness",
      revision: NO_ALLOWANCE_REVISION,
      retryPolicy: retryPolicy(0),
      runStep: throttlingHarness(THROTTLED_ERROR),
    });
    expect(await captureShow(noAllowance)).toContain(
      `decision declined-no-allowance (${INFERENCE_RETRY_DECISION_REASONS["declined-no-allowance"]})`,
    );
    expect(runFooter(noAllowance)).toContain("retry decision declined-no-allowance");
    // `declined-unexplained` is not exercised here: the shipped writer
    // (`projectInferenceRetryDecision`) cannot emit `declined` after every
    // named cause has already been ruled out.
  });

  it("shows an eligible host-refused condition as declined with remaining budget", async () => {
    const run = await persistRun({
      runId: "eligible-but-declined-run",
      workflow: "readiness",
      revision: ELIGIBLE_DECLINED_REVISION,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["malformed-response", "throttled"],
      },
      runStep: async () => {
        throw new InferenceStepError(
          "Technical correction response rejected: invalid-fact-inventory.",
          "malformed-response",
          false,
          undefined,
          { code: "invalid-fact-inventory", location: "$.factInventory" },
        );
      },
    });

    const execution = run.record.steps[0]?.inference;
    expect(execution?.configuredMaxRetries).toBe(3);
    expect(execution?.effectiveMaxRetries).toBe(3);
    expect(execution?.attempts).toHaveLength(1);
    expect(execution?.attempts[0]).toMatchObject({
      outcome: "malformed-response",
      conditionRetryability: "eligible",
      retryable: false,
      retryDecision: "declined",
      retryScheduled: false,
    });

    const shown = await captureShow(run);
    expect(shown).toContain(
      "Step assess-readiness attempt 1: malformed-response; condition eligible; retryable false;" +
        ` decision declined-host-refusal (${INFERENCE_RETRY_DECISION_REASONS["declined-host-refusal"]});` +
        ` retries remaining 3; ${RETRY_ELIGIBILITY_DISAGREEMENT_REASON}`,
    );
    expect(runFooter(run)).toContain("retry decision declined-host-refusal on attempt 1");
    expect(runFooter(run)).toContain("retries remaining 3");
    expect(runFooter(run)).toContain(RETRY_ELIGIBILITY_DISAGREEMENT_REASON);
    expect(runFooter(run)).toContain("docsfab runs show");
    expect(runFooter(run)).toContain("--json");
    expect(runFooter(run)).toContain("Retry declined");
    expect(runFooter(run)).not.toContain("docsfab doctor");

    const envelope = parseJsonEvidence(await captureShow(run, ["--json"])) as {
      retryDispositions?: readonly Record<string, unknown>[];
    };
    expect(envelope.retryDispositions).toEqual([
      expect.objectContaining({
        stepId: "assess-readiness",
        attempt: 1,
        outcome: "malformed-response",
        conditionRetryability: "eligible",
        retryable: false,
        retryDecision: "declined",
        decisionToken: "declined-host-refusal",
        retriesRemaining: 3,
        eligibilityDisagreement: RETRY_ELIGIBILITY_DISAGREEMENT,
      }),
    ]);
  });

  it("fails closed when a declined attempt is missing its outcome", async () => {
    const run = await persistMutatedRun(
      await persistRun({
        runId: "malformed-outcome-run",
        workflow: "readiness",
        revision: MALFORMED_OUTCOME_REVISION,
        retryPolicy: retryPolicy(0),
        runStep: throttlingHarness(THROTTLED_ERROR),
      }),
      (record) => {
        const attempt = record.steps[0]?.inference?.attempts[0] as { outcome?: string } | undefined;
        delete attempt?.outcome;
      },
    );

    const shown = await captureShow(run);
    expect(shown).toContain("attempt 1: unavailable");
    expect(shown).toContain(
      `decision unavailable (${INFERENCE_RETRY_DECISION_REASONS.unavailable})`,
    );
    expect(shown).not.toContain("declined-terminal-policy");
    expect(shown).not.toContain("does not list that condition");
    expect(runFooter(run)).toContain("retry decision unavailable");
    expect(runFooter(run)).not.toContain("declined-terminal-policy");

    const envelope = parseJsonEvidence(await captureShow(run, ["--json"])) as {
      retryDispositions?: readonly { decisionToken?: string }[];
    };
    expect(envelope.retryDispositions?.[0]?.decisionToken).toBe("unavailable");
  });

  it("does not attach a retry sentence to a downstream failure after a succeeded attempt", async () => {
    const run = await persistRun({
      runId: "downstream-failure-run",
      workflow: "readiness",
      revision: DOWNSTREAM_REVISION,
      retryPolicy: retryPolicy(2),
      runStep: async (input: HarnessStepInput) => ({
        summary: `ran ${input.step.skill}`,
        model: { provider: "hosted", model: "test-model" },
        skill: { id: "review-documentation", contentSha256: "a".repeat(64) },
      }),
    });

    expect(run.record.status).toBe("failed");
    expect(run.record.error).toContain("unexpected skill identity");
    expect(run.record.steps[0]?.inference?.attempts).toEqual([
      expect.objectContaining({ outcome: "succeeded", retryDecision: "not-applicable" }),
    ]);

    const shown = await captureShow(run);
    expect(shown).not.toContain("RETRIES");
    expect(shown).not.toContain("retry decision");
    expect(runFooter(run)).toContain("Workflow step returned an unexpected skill identity.");
    expect(runFooter(run)).not.toContain("retry decision");

    const envelope = parseJsonEvidence(await captureShow(run, ["--json"])) as {
      retryDispositions?: unknown;
    };
    expect(envelope.retryDispositions).toBeUndefined();
  });

  it("keeps an unreadable attempt visible on every surface", async () => {
    const run = await persistMutatedRun(
      await persistRun({
        runId: "unreadable-attempt-run",
        workflow: "readiness",
        revision: UNREADABLE_ATTEMPT_REVISION,
        retryPolicy: retryPolicy(0),
        runStep: throttlingHarness(THROTTLED_ERROR),
      }),
      (record) => {
        const execution = record.steps[0]?.inference as { attempts?: unknown } | undefined;
        if (execution) execution.attempts = [null];
      },
    );

    const shown = await captureShow(run);
    expect(shown).toContain("RETRIES");
    expect(shown).toContain(
      `Step assess-readiness attempt unavailable: unavailable; condition unavailable; retryable unavailable; decision unavailable (${INFERENCE_RETRY_DECISION_REASONS.unavailable})`,
    );
    expect(runFooter(run)).toContain(
      `Step assess-readiness condition unavailable, retryable unavailable, retry decision unavailable on attempt unavailable (${INFERENCE_RETRY_DECISION_REASONS.unavailable}); retries remaining unavailable; physical unavailable.`,
    );
  });

  it("does not claim an unreadable pair predates the distinction", async () => {
    const run = await persistMutatedRun(
      await persistRun({
        runId: "corrupt-pair-run",
        workflow: "readiness",
        revision: CORRUPT_PAIR_REVISION,
        retryPolicy: retryPolicy(0),
        runStep: throttlingHarness(THROTTLED_ERROR),
      }),
      (record) => {
        const attempt = record.steps[0]?.inference?.attempts[0] as
          | { retryDecision?: string }
          | undefined;
        if (attempt) attempt.retryDecision = "probably-retried";
      },
    );

    const shown = await captureShow(run);
    expect(shown).toContain(
      `decision unavailable (${INFERENCE_RETRY_DECISION_REASONS.unavailable})`,
    );
    expect(shown).not.toContain("predates");
    expect(runFooter(run)).toContain("retry decision unavailable");
    expect(runFooter(run)).not.toContain("predates");
  });
});
