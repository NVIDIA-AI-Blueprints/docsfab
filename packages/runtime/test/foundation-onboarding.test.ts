// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyFoundationGapDecisions,
  createFoundationGapDecision,
  createFoundationGapDecisionHostAuthority,
  decodeFoundationGapDecision,
  FoundationGapDecisionError,
  mintFoundationGapDecisionCapability,
} from "../src/canon/gap-decisions.js";
import { sha256 } from "../src/content-ir/canonical.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { ContextPreflightService } from "../src/context/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  completeFoundationOnboarding,
  FoundationHostOperation,
  FoundationWorkflowOutcomeProjector,
  incompleteFoundationInspectSeed,
  inspectFoundation,
  projectFoundationOnboardingQuestions,
  rescoreFoundationOnboarding,
} from "../src/foundation/index.js";
import { buildRunResultV1, decodeRunResultV1 } from "../src/operator/run-result.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { validModelEnvironment } from "./helpers.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class RejectingHarness implements AgentHarness {
  public calls = 0;
  public async runStep(): Promise<never> {
    this.calls += 1;
    throw new Error("Foundation onboarding must not invoke the model harness.");
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

const readyContextPreflight: ContextPreflightService = {
  preflight: async () => ({
    status: "unnecessary",
    reason: "target-not-applicable",
  }),
};

const NOW = "2026-08-11T15:00:00.000Z";
const EXPIRES = "2026-08-11T16:00:00.000Z";
const AUTHORITY_ID = sha256("foundation-onboarding-reviewer");

function hostAuthority(receipts: string[] = [sha256("receipt-1")]) {
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

describe("foundation onboarding (#220)", () => {
  it("moves needs-input → ready after authoritative typed decisions", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const prior = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      ...incompleteFoundationInspectSeed(fixture.revision),
    });
    expect(prior.readiness).toBe("needs-input");
    expect(prior.productDisposition).toBe("needs-input");

    const questions = projectFoundationOnboardingQuestions(prior);
    expect(questions.map((item) => item.questionKind).sort()).toEqual([
      "accepted-assumption",
      "applicability",
      "audience",
      "missing-fact",
      "output-scope",
      "ownership",
      "support-commitment",
    ]);

    const receipts = questions.map((_, index) => sha256(`receipt-ready-${index}`));
    const session = await completeFoundationOnboarding({
      repositoryPath: fixture.repository,
      inspect: prior,
      authority: hostAuthority(receipts),
      authorityIdentitySha256: AUTHORITY_ID,
      decisions: goldenDecisions(questions.map((item) => item.id)),
      expiresAt: EXPIRES,
      now: NOW,
    });

    expect(session.priorCanon.canonSha256).toBe(prior.canon.canonSha256);
    expect(session.canon.version).toBe("v2");
    expect(session.canon.supersession?.supersedesCanonSha256).toBe(prior.canon.canonSha256);
    expect(session.inspect.readiness).toBe("ready");
    expect(session.inspect.productDisposition).toBe("ready");
    expect(session.inspect.nextQuestions).toEqual([]);
    expect(session.verifiedClaimIds.length).toBeGreaterThan(0);
    expect(session.acceptedAssumptionIds).toEqual(["assumption:q-accepted-assumption"]);

    const assumptionClaims = session.canon.claims.filter(
      (claim) => claim.verificationStatus === "accepted-assumption",
    );
    const verifiedClaims = session.canon.claims.filter(
      (claim) => claim.verificationStatus === "verified",
    );
    expect(assumptionClaims.length).toBe(1);
    expect(verifiedClaims.length).toBeGreaterThan(0);
    expect(assumptionClaims[0]!.assumptionIds).toEqual(["assumption:q-accepted-assumption"]);
    expect(verifiedClaims.every((claim) => claim.assumptionIds.length === 0)).toBe(true);

    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("rescoring is deterministic for identical canon + decisions", async () => {
    const fixture = await createIncompleteFixture();
    const prior = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      ...incompleteFoundationInspectSeed(fixture.revision),
    });
    const questions = projectFoundationOnboardingQuestions(prior);
    const session = await completeFoundationOnboarding({
      repositoryPath: fixture.repository,
      inspect: prior,
      authority: hostAuthority(questions.map((_, i) => sha256(`det-${i}`))),
      authorityIdentitySha256: AUTHORITY_ID,
      decisions: goldenDecisions(questions.map((item) => item.id)),
      expiresAt: EXPIRES,
      now: NOW,
    });
    const first = await rescoreFoundationOnboarding({
      repositoryPath: fixture.repository,
      priorInspect: prior,
      canon: session.canon,
      decisions: session.decisions,
      questions,
    });
    const second = await rescoreFoundationOnboarding({
      repositoryPath: fixture.repository,
      priorInspect: prior,
      canon: session.canon,
      decisions: session.decisions,
      questions,
    });
    expect(first.resultSha256).toBe(second.resultSha256);
    expect(first.canon.canonSha256).toBe(session.canon.canonSha256);
  });

  it("fails closed on stale, replayed, over-broad, decoded, and unauthorized decisions", async () => {
    const fixture = await createIncompleteFixture();
    const prior = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      ...incompleteFoundationInspectSeed(fixture.revision),
    });
    const questions = projectFoundationOnboardingQuestions(prior);
    const question = questions[0]!;
    const authority = hostAuthority([sha256("replay-receipt"), sha256("replay-receipt")]);

    const first = mintFoundationGapDecisionCapability(
      {
        question,
        disposition: "answer",
        answerValueSha256: sha256("ok"),
        authorityIdentitySha256: AUTHORITY_ID,
        expiresAt: EXPIRES,
        now: NOW,
      },
      authority,
    );
    expect(createFoundationGapDecision(first).questionId).toBe(question.id);

    // Replayed authority receipt
    expect(() =>
      mintFoundationGapDecisionCapability(
        {
          question,
          disposition: "answer",
          answerValueSha256: sha256("ok-2"),
          authorityIdentitySha256: AUTHORITY_ID,
          expiresAt: EXPIRES,
          now: NOW,
        },
        authority,
      ),
    ).toThrowError(FoundationGapDecisionError);

    // Unauthorized lookalike authority
    expect(() =>
      mintFoundationGapDecisionCapability(
        {
          question,
          disposition: "answer",
          answerValueSha256: sha256("ok"),
          authorityIdentitySha256: AUTHORITY_ID,
          expiresAt: EXPIRES,
          now: NOW,
        },
        { kind: "docsfab-foundation-gap-decision-host-authority" },
      ),
    ).toThrow();

    // Over-broad: answer without digest
    expect(() =>
      mintFoundationGapDecisionCapability(
        {
          question,
          disposition: "answer",
          answerValueSha256: null,
          authorityIdentitySha256: AUTHORITY_ID,
          expiresAt: EXPIRES,
          now: NOW,
        },
        hostAuthority([sha256("overbroad")]),
      ),
    ).toThrowError(FoundationGapDecisionError);

    // Over-broad: reject with digest
    expect(() =>
      mintFoundationGapDecisionCapability(
        {
          question,
          disposition: "reject",
          answerValueSha256: sha256("should-not"),
          authorityIdentitySha256: AUTHORITY_ID,
          expiresAt: EXPIRES,
          now: NOW,
        },
        hostAuthority([sha256("reject-digest")]),
      ),
    ).toThrowError(FoundationGapDecisionError);

    // Expired
    expect(() =>
      mintFoundationGapDecisionCapability(
        {
          question,
          disposition: "answer",
          answerValueSha256: sha256("late"),
          authorityIdentitySha256: AUTHORITY_ID,
          expiresAt: NOW,
          now: NOW,
        },
        hostAuthority([sha256("expired")]),
      ),
    ).toThrowError(FoundationGapDecisionError);

    // Decoded historical decision cannot be applied (no live capability)
    const live = mintFoundationGapDecisionCapability(
      {
        question,
        disposition: "answer",
        answerValueSha256: sha256("live"),
        authorityIdentitySha256: AUTHORITY_ID,
        expiresAt: EXPIRES,
        now: NOW,
      },
      hostAuthority([sha256("live-receipt")]),
    );
    const decoded = decodeFoundationGapDecision(
      JSON.parse(JSON.stringify(createFoundationGapDecision(live))),
    );
    expect(decoded.decisionSha256).toBe(createFoundationGapDecision(live).decisionSha256);
    expect(() =>
      applyFoundationGapDecisions({
        priorCanon: prior.canon,
        questions,
        capabilities: [{ kind: "docsfab-foundation-gap-decision-capability" }],
        nextVersion: "v2",
        now: NOW,
      }),
    ).toThrowError(FoundationGapDecisionError);

    // Stale canon binding
    const staleQuestion = {
      ...question,
      canonSha256: sha256("stale-canon-version-binding-000000000000000000000000"),
    };
    // Re-seal would be needed for a real stale question; mutate via wrong prior instead:
    const other = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      canonId: "other-canon",
      ...incompleteFoundationInspectSeed(fixture.revision),
    });
    const capability = mintFoundationGapDecisionCapability(
      {
        question,
        disposition: "answer",
        answerValueSha256: sha256("stale-apply"),
        authorityIdentitySha256: AUTHORITY_ID,
        expiresAt: EXPIRES,
        now: NOW,
      },
      hostAuthority([sha256("stale-apply-receipt")]),
    );
    expect(() =>
      applyFoundationGapDecisions({
        priorCanon: other.canon,
        questions,
        capabilities: [capability],
        nextVersion: "v2",
        now: NOW,
      }),
    ).toThrowError(FoundationGapDecisionError);
    void staleQuestion;
  });

  it("defer keeps readiness needs-input; reject does not mint verified claims", async () => {
    const fixture = await createIncompleteFixture();
    const prior = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      ...incompleteFoundationInspectSeed(fixture.revision),
    });
    const questions = projectFoundationOnboardingQuestions(prior);
    const decisions = goldenDecisions(questions.map((item) => item.id)).map((item) =>
      item.questionId === "q-ownership"
        ? { questionId: item.questionId, disposition: "defer" as const, answerValueSha256: null }
        : item,
    );
    const session = await completeFoundationOnboarding({
      repositoryPath: fixture.repository,
      inspect: prior,
      authority: hostAuthority(decisions.map((_, i) => sha256(`defer-${i}`))),
      authorityIdentitySha256: AUTHORITY_ID,
      decisions,
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(session.inspect.readiness).toBe("needs-input");
    expect(session.canon.claims.some((claim) => claim.id === "claim:q-ownership")).toBe(false);
  });

  it("host-operation path reaches ready only after onboarding decisions", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const prior = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      ...incompleteFoundationInspectSeed(fixture.revision),
    });
    const questions = projectFoundationOnboardingQuestions(prior);
    const session = await completeFoundationOnboarding({
      repositoryPath: fixture.repository,
      inspect: prior,
      authority: hostAuthority(questions.map((_, i) => sha256(`host-${i}`))),
      authorityIdentitySha256: AUTHORITY_ID,
      decisions: goldenDecisions(questions.map((item) => item.id)),
      expiresAt: EXPIRES,
      now: NOW,
    });

    const harness = new RejectingHarness();
    const runner = new WorkflowRunner({
      harness,
      hostOperations: new FoundationHostOperation({
        inspectOverride: async () => session.inspect,
      }),
      outcomeProjector: new FoundationWorkflowOutcomeProjector(),
      store: new MemoryStore(),
      repositoryScanner: passedScanner,
      contextPreflight: readyContextPreflight,
      id: () => "foundation-onboarding-run-1",
      now: () => new Date(NOW),
    });
    const record = await runner.run({
      workflow: "foundation",
      workspacePath: fixture.repository,
      repository: {
        sourcePath: fixture.repository,
        requestedRevision: "HEAD",
        revision: fixture.revision,
      },
      allowWrite: false,
    });
    expect(harness.calls).toBe(0);
    expect(record.status).toBe("succeeded");
    expect(record.workflowOutcome?.disposition).toBe("ready");
    const result = buildRunResultV1({
      record,
      recordPath: "/private/runs/foundation-onboarding-run-1.json",
      exitCode: 0,
      repositoryPath: fixture.repository,
    });
    expect(decodeRunResultV1(JSON.parse(JSON.stringify(result))).product.disposition).toBe("ready");
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("CLI smoke: docsfab run foundation fails closed as unbound", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);

    const pre = await runDocsFabCli(["run", "foundation", "--repo", fixture.repository, "--json"]);
    expect(pre.exitCode).not.toBe(0);
    expect(`${pre.stdout}\n${pre.stderr}`).toMatch(/not bound to a catalog skill/u);
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  }, 60_000);
});

function extractRunResultJson(stdout: string): unknown {
  const kindAt = stdout.lastIndexOf('"kind": "docsfab-run-result"');
  if (kindAt < 0) throw new Error(`RunResultV1 JSON not found in CLI output:\n${stdout}`);
  let depth = 0;
  let start = -1;
  for (let index = kindAt; index >= 0; index -= 1) {
    const character = stdout[index];
    if (character === "}") depth += 1;
    else if (character === "{") {
      if (depth === 0) {
        start = index;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) throw new Error(`RunResultV1 object start not found:\n${stdout}`);
  depth = 0;
  for (let index = start; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(stdout.slice(start, index + 1));
    }
  }
  throw new Error(`RunResultV1 object end not found:\n${stdout}`);
}

async function createIncompleteFixture(): Promise<{ repository: string; revision: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-foundation-onboarding-")));
  roots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository, { recursive: true });
  await writeFile(
    join(repository, "README.md"),
    "# Incomplete golden\n\nNo registered evidence.\n",
  );
  await writeFile(join(repository, "AGENTS.md"), "# Agents\n\nRead-only fixture guidance.\n");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "docs", "guide.md"), "# Guide\n\nPlaceholder document.\n");

  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "foundation@example.test"], {
    cwd: repository,
  });
  await execFileAsync("git", ["config", "user.name", "Foundation Fixture"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "incomplete foundation onboarding golden"], {
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

async function runDocsFabCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const projectRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...validModelEnvironment,
          PI_OFFLINE: "1",
          CI: "1",
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}
