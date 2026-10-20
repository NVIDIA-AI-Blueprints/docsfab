// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFoundationGapDecisionHostAuthority } from "../src/canon/gap-decisions.js";
import { sha256 } from "../src/content-ir/canonical.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { ContextPreflightService } from "../src/context/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  completeFoundationOnboarding,
  incompleteFoundationInspectSeed,
  inspectFoundation,
  projectFoundationOnboardingQuestions,
  type FoundationInspectResultV1,
} from "../src/foundation/index.js";
import { buildRunResultV1, decodeRunResultV1 } from "../src/operator/run-result.js";
import { getWorkflow, isWorkflowName, listWorkflows } from "../src/workflow-registry/catalog.js";
import {
  createFoundationToPatchAuthorization,
  FoundationToPatchHostOperation,
  FoundationToPatchWorkflowOutcomeProjector,
  FOUNDATION_TO_PATCH_SKILLS,
  FOUNDATION_TO_PATCH_CATALOG_SKILLS,
  runFoundationToPatch,
} from "../src/foundation/to-patch.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
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
    throw new Error("Foundation-to-patch must not invoke the model harness.");
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
const AUTHORITY_ID = sha256("foundation-to-patch-reviewer");

describe("foundation-to-patch composed workflow (#225)", () => {
  it("registers foundation-to-patch as a catalog host-operation workflow", () => {
    expect(isWorkflowName("foundation-to-patch")).toBe(true);
    const workflow = getWorkflow("foundation-to-patch");
    expect(workflow.steps).toEqual([
      expect.objectContaining({
        id: "compose-foundation-to-patch",
        kind: "host-operation",
        operation: "foundation-to-patch",
        skill: FOUNDATION_TO_PATCH_CATALOG_SKILLS.plan,
        mode: "write",
        invokes: "create-documentation",
      }),
    ]);
    expect(listWorkflows().some((item) => item.name === "foundation-to-patch")).toBe(false);
  });

  it("refuses not-ready / needs-input / missing canon before planning or drafting", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const missing = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: false,
      now: NOW,
    });
    expect(missing.productDisposition).toBe("needs-input");
    expect(missing.guarantees.planningEnteredAsReady).toBe(false);
    expect(missing.checkpoint.stage).toBe("gate");
    expect(missing.checkpoint.plan).toBeUndefined();
    expect(missing.checkpoint.candidate).toBeUndefined();
    expect(missing.sourceCheckoutUnchanged).toBe(true);

    const planCalls: string[] = [];
    const draftCalls: string[] = [];
    const gated = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: true,
      now: NOW,
      planStep: async () => {
        planCalls.push("plan");
        throw new Error("plan must not run");
      },
      draftStep: async () => {
        draftCalls.push("draft");
        throw new Error("draft must not run");
      },
    });
    expect(gated.guarantees.planningEnteredAsReady).toBe(false);
    expect(planCalls).toEqual([]);
    expect(draftCalls).toEqual([]);
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("preserves legacy phase bytes while the hosted caller records actual catalog identities", async () => {
    const fixture = await createIncompleteFixture();
    const inspect = await readyInspect(fixture);
    const base = {
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      inspect,
      now: NOW,
      allowWrite: false,
    };
    const legacy = await runFoundationToPatch(base);
    expect(await runFoundationToPatch({ ...base, skillPolicy: "legacy-v1" })).toEqual(legacy);
    await expect(runFoundationToPatch({ ...base, skillPolicy: "catalog-v1" })).rejects.toThrow(
      "invalid-step",
    );
    const hosted = await runFoundationToPatch({
      ...base,
      skillPolicy: "catalog-v1",
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_CATALOG_SKILLS.plan,
        status: "ready",
        intendedPaths: ["docs/guide.md"],
        planSha256: sha256("actual hosted plan evidence"),
      }),
    });
    expect(hosted.status).toBe("needs-input");
    expect(hosted.checkpoint.plan?.skillId).toBe(FOUNDATION_TO_PATCH_CATALOG_SKILLS.plan);
    expect(legacy.checkpoint.plan?.skillId).toBe(FOUNDATION_TO_PATCH_SKILLS.plan);
  });

  it("retains an authoring input request without fabricating a candidate or running later review", async () => {
    const fixture = await createIncompleteFixture();
    const inspect = await readyInspect(fixture);
    const pending = {
      schemaVersion: 1 as const,
      kind: "docsfab-foundation-to-patch-pending-input" as const,
      sourceWorkflow: "create-documentation" as const,
      sourceRunId: "nested-authoring",
      sourceRunSha256: sha256("retained nested run"),
      writeEntered: false,
    };
    const result = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      inspect,
      now: NOW,
      allowWrite: true,
      skillPolicy: "catalog-v1",
      authorization: createFoundationToPatchAuthorization({
        intendedPaths: ["docs/README.md"],
        decidedAt: NOW,
        expiresAt: EXPIRES,
      }),
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_CATALOG_SKILLS.plan,
        status: "ready",
        intendedPaths: ["docs/README.md"],
        planSha256: sha256("actual hosted plan evidence"),
      }),
      draftStep: () => pending,
      patchStep: () => {
        throw new Error("must not create an absent patch");
      },
      impactStep: () => {
        throw new Error("must not invent impact");
      },
      completionDisposition: () => {
        throw new Error("must not complete a paused run");
      },
      validateStep: () => {
        throw new Error("must not validate an absent candidate");
      },
      adversarialStep: () => {
        throw new Error("must not review an absent candidate");
      },
    });
    expect(result.status).toBe("needs-input");
    expect(result.checkpoint.pendingInput).toEqual(pending);
    expect(result.checkpoint.candidate).toBeUndefined();
    expect(result.checkpoint.patch).toBeUndefined();
    expect(result.guarantees.writeToolsGranted).toBe(false);
  });

  it("requires current write authorization and blocks intended-path expansion", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const ready = await readyInspect(fixture);

    const withoutAuth = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: true,
      now: NOW,
      inspect: ready,
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
        status: "ready",
        planSha256: sha256("plan"),
        intendedPaths: ["docs/guide.md"],
      }),
      draftStep: () => {
        throw new Error("draft must not run without authorization");
      },
    });
    expect(withoutAuth.status).toBe("needs-input");
    expect(withoutAuth.stage).toBe("authorize");
    expect(withoutAuth.checkpoint.plan?.planSha256).toBe(sha256("plan"));
    expect(withoutAuth.checkpoint.candidate).toBeUndefined();

    const expired = createFoundationToPatchAuthorization({
      intendedPaths: ["docs/guide.md"],
      decidedAt: "2026-08-11T14:00:00.000Z",
      expiresAt: "2026-08-11T14:30:00.000Z",
    });
    const staleAuth = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: true,
      now: NOW,
      inspect: ready,
      authorization: expired,
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
        status: "ready",
        planSha256: sha256("plan-2"),
        intendedPaths: ["docs/guide.md"],
      }),
      draftStep: () => {
        throw new Error("draft must not run with expired authorization");
      },
    });
    expect(staleAuth.status).toBe("needs-input");
    expect(staleAuth.stage).toBe("authorize");

    const auth = createFoundationToPatchAuthorization({
      intendedPaths: ["docs/guide.md"],
      decidedAt: NOW,
      expiresAt: EXPIRES,
    });
    const expanded = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: true,
      now: NOW,
      inspect: ready,
      authorization: auth,
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
        status: "ready",
        planSha256: sha256("plan-3"),
        intendedPaths: ["docs/guide.md"],
      }),
      draftStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-candidate",
        skillId: FOUNDATION_TO_PATCH_SKILLS.draft,
        candidateSha256: sha256("candidate-expand"),
        changedPaths: ["docs/guide.md", "docs/secret.md"],
      }),
    });
    expect(expanded.status).toBe("failed");
    expect(expanded.productDisposition).toBe("blocked");
    expect(expanded.checkpoint.plan?.planSha256).toBe(sha256("plan-3"));
    expect(expanded.checkpoint.candidate).toBeUndefined();
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("preserves last valid checkpoint on interrupt and failed validation", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const ready = await readyInspect(fixture);
    const auth = createFoundationToPatchAuthorization({
      intendedPaths: ["docs/guide.md"],
      decidedAt: NOW,
      expiresAt: EXPIRES,
    });

    const interrupted = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: true,
      now: NOW,
      inspect: ready,
      authorization: auth,
      interruptAfter: "draft",
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
        status: "ready",
        planSha256: sha256("plan-int"),
        intendedPaths: ["docs/guide.md"],
      }),
      draftStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-candidate",
        skillId: FOUNDATION_TO_PATCH_SKILLS.draft,
        candidateSha256: sha256("candidate-int"),
        changedPaths: ["docs/guide.md"],
      }),
    });
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.checkpoint.canonSha256).toBe(ready.canon.canonSha256);
    expect(interrupted.checkpoint.plan?.planSha256).toBe(sha256("plan-int"));
    expect(interrupted.checkpoint.candidate?.candidateSha256).toBe(sha256("candidate-int"));
    expect(interrupted.checkpoint.validation).toBeUndefined();
    expect(interrupted.checkpoint.patch).toBeUndefined();

    const failedValidation = await runFoundationToPatch({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      allowWrite: true,
      now: NOW,
      inspect: ready,
      authorization: auth,
      planStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-plan",
        skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
        status: "ready",
        planSha256: sha256("plan-fail"),
        intendedPaths: ["docs/guide.md"],
      }),
      draftStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-candidate",
        skillId: FOUNDATION_TO_PATCH_SKILLS.draft,
        candidateSha256: sha256("candidate-fail"),
        changedPaths: ["docs/guide.md"],
      }),
      validateStep: () => ({
        schemaVersion: 1,
        kind: "docsfab-foundation-to-patch-validation",
        status: "failed",
        validationSha256: sha256("validation-fail"),
        changedPaths: ["docs/guide.md"],
      }),
    });
    expect(failedValidation.status).toBe("failed");
    expect(failedValidation.checkpoint.plan?.planSha256).toBe(sha256("plan-fail"));
    expect(failedValidation.checkpoint.candidate?.candidateSha256).toBe(sha256("candidate-fail"));
    expect(failedValidation.checkpoint.validation?.status).toBe("failed");
    expect(failedValidation.checkpoint.patch).toBeUndefined();
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("refuses synthetic legacy phase success without an actual patch", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const ready = await readyInspect(fixture);
    const auth = createFoundationToPatchAuthorization({
      intendedPaths: ["docs/guide.md"],
      decidedAt: NOW,
      expiresAt: EXPIRES,
    });

    const harness = new RejectingHarness();
    const hostOperations = new FoundationToPatchHostOperation({
      runInput: {
        allowWrite: true,
        now: NOW,
        inspect: ready,
        authorization: auth,
        planStep: () => ({
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-plan",
          skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
          status: "ready",
          planSha256: sha256("plan-ok"),
          intendedPaths: ["docs/guide.md"],
        }),
        draftStep: () => ({
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-candidate",
          skillId: FOUNDATION_TO_PATCH_SKILLS.draft,
          candidateSha256: sha256("candidate-ok"),
          changedPaths: ["docs/guide.md"],
        }),
      },
    });
    const collector = await GitPatchEvidenceCollector.create(
      fixture.repository,
      join(dirname(fixture.repository), "patches"),
    );
    const runner = new WorkflowRunner({
      repositoryEvidence: collector,
      harness,
      hostOperations,
      outcomeProjector: new FoundationToPatchWorkflowOutcomeProjector(),
      store: new MemoryStore(),
      repositoryScanner: passedScanner,
      contextPreflight: readyContextPreflight,
      id: () => "foundation-to-patch-run-1",
      now: () => new Date(NOW),
    });
    const record = await runner.run({
      workflow: "foundation-to-patch",
      workspacePath: fixture.repository,
      repository: {
        sourcePath: fixture.repository,
        requestedRevision: "HEAD",
        revision: fixture.revision,
      },
      allowWrite: true,
    });
    await collector.dispose();

    expect(harness.calls).toBe(0);
    expect(record.status).toBe("failed");
    expect(record.workflowOutcome).toBeUndefined();
    expect(record.error).toBe("Write workflow completed without changing any repository file.");
    // This composition needs no `emptyWriteResultAdmission` port: a completed
    // run that changed no file records the runner's default code, which the
    // operator tables classify. A composition-specific code without its own
    // table row would move `class` to `unknown`.
    expect(record.failure).toEqual({
      class: "model-content",
      layer: "workflow",
      code: "empty-write-result",
    });
    expect(record.changes?.files).toEqual([]);
    expect(record.steps[0]?.operation).toBe("foundation-to-patch");

    const result = buildRunResultV1({
      record,
      recordPath: "/private/runs/foundation-to-patch-run-1.json",
      exitCode: 1,
      repositoryPath: fixture.repository,
    });
    expect(decodeRunResultV1(JSON.parse(JSON.stringify(result))).product.disposition).toBeNull();
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  // The "model content fails open" seam: `runFoundationToPatch` degrades the
  // disposition to `inconclusive` when validation is `unavailable` or the
  // adversarial review is `inconclusive`, and still returns `succeeded` with the
  // patch. Each is driven with the other condition passing; the third case
  // keeps the nested `ready` disposition.
  it("degrades an unavailable check or an inconclusive review to inconclusive and keeps the patch", async () => {
    const fixture = await createIncompleteFixture();
    const ready = await readyInspect(fixture);
    const auth = createFoundationToPatchAuthorization({
      intendedPaths: ["docs/guide.md"],
      decidedAt: NOW,
      expiresAt: EXPIRES,
    });
    const completed = async (
      validationStatus: "passed" | "unavailable",
      adversarialStatus: "pass" | "inconclusive",
    ) =>
      runFoundationToPatch({
        repositoryPath: fixture.repository,
        repositoryRevision: fixture.revision,
        allowWrite: true,
        now: NOW,
        inspect: ready,
        authorization: auth,
        planStep: () => ({
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-plan",
          skillId: FOUNDATION_TO_PATCH_SKILLS.plan,
          status: "ready",
          planSha256: sha256(`plan-${validationStatus}-${adversarialStatus}`),
          intendedPaths: ["docs/guide.md"],
        }),
        draftStep: () => ({
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-candidate",
          skillId: FOUNDATION_TO_PATCH_SKILLS.draft,
          candidateSha256: sha256(`candidate-${validationStatus}-${adversarialStatus}`),
          changedPaths: ["docs/guide.md"],
        }),
        validateStep: () => ({
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-validation",
          status: validationStatus,
          validationSha256: sha256(`validation-${validationStatus}`),
          changedPaths: ["docs/guide.md"],
        }),
        adversarialStep: () => ({
          schemaVersion: 1,
          kind: "docsfab-foundation-to-patch-adversarial",
          skillId: FOUNDATION_TO_PATCH_SKILLS.adversarial,
          status: adversarialStatus,
          reviewSha256: sha256(`review-${adversarialStatus}`),
        }),
        completionDisposition: () => "ready",
      });

    const unavailableCheck = await completed("unavailable", "pass");
    expect(unavailableCheck.status).toBe("succeeded");
    expect(unavailableCheck.productDisposition).toBe("inconclusive");
    expect(unavailableCheck.checkpoint.patch?.changedPaths).toEqual(["docs/guide.md"]);

    const inconclusiveReview = await completed("passed", "inconclusive");
    expect(inconclusiveReview.status).toBe("succeeded");
    expect(inconclusiveReview.productDisposition).toBe("inconclusive");
    expect(inconclusiveReview.checkpoint.patch?.changedPaths).toEqual(["docs/guide.md"]);

    // Neither degrading condition holds, so the nested disposition survives;
    // otherwise an always-`inconclusive` completion would pass the cases above.
    const clean = await completed("passed", "pass");
    expect(clean.status).toBe("succeeded");
    expect(clean.productDisposition).toBe("ready");
  });

  it("CLI smoke: docsfab run foundation-to-patch fails closed as unbound", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const { stdout, stderr, exitCode } = await runDocsFabCli([
      "run",
      "foundation-to-patch",
      "--repo",
      fixture.repository,
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/not bound to a catalog skill/u);
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  }, 60_000);
});

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
    authority: hostAuthority(questions.map((_, i) => sha256(`ftp-${i}`))),
    authorityIdentitySha256: AUTHORITY_ID,
    decisions: goldenDecisions(questions.map((item) => item.id)),
    expiresAt: EXPIRES,
    now: NOW,
  });
  expect(session.inspect.readiness).toBe("ready");
  return session.inspect;
}

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
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-foundation-to-patch-")));
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
  await execFileAsync("git", ["commit", "-q", "-m", "incomplete foundation-to-patch golden"], {
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
