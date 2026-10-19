// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  type HostRuntimeRequestV1,
} from "../src/host-invoker/contracts.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { servedModelWarning } from "../src/model/provider.js";
import {
  HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS,
  createHostedContextPreflightService,
} from "../src/host-invoker/context-preflight.js";
import {
  normalizeContextPreflight,
  preflightContext,
} from "../src/workflow-execution/runner-evidence.js";
import { contextPacketBudget } from "../src/context/budget.js";
import type { ContextPreflightInput, ContextPreflightResult } from "../src/context/contracts.js";
import {
  decodeContextPreflight,
  decodeSearchParticipation,
  ScorecardRecordError,
} from "../src/scorecard-record.js";
import { grantedTools, grantedToolsForStep } from "../src/harness/pi-tool-confine.js";
import { createPiExecutionLeaseController } from "../src/harness/pi-offline.js";
import { bindModelExecutionProfile, type ModelProfile } from "../src/model/configuration.js";
import { validModelConfig } from "./helpers.js";
import {
  sourceObligationProposalFixture,
  sourceObligationObserverFixture,
  verificationFixture,
  verificationResultFixture,
} from "./helpers/verification.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  createSearchParticipationState,
  markAuthorizedWrite,
  rememberSearchObservation,
  resolveSearchParticipation,
} from "../src/workflow-execution/search-participation.js";
import type {
  WorkflowSearchCoordinator,
  WorkflowSearchStepEvidenceV1,
} from "../src/workflow-contracts/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { normalizeWorkflowSearchEvidence } from "../src/workflow-contracts/search.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3 } from "../src/workflow-execution/source-obligation.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import * as workflowCatalog from "../src/workflow-registry/catalog.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const exec = promisify(execFile);
const roots: string[] = [];

/**
 * The tool set sealed into the pilot host's dispatcher composition. A literal, because
 * deriving it from `grantedTools` would make the tool-policy proof circular.
 */
const PILOT_DECLARED_TOOLS = [
  "canon_affected_docs",
  "canon_conflict_gap",
  "canon_propose_claim",
  "canon_query",
  "canon_submit_artifact",
  "canon_validate_citations",
  "find",
  "grep",
  "ls",
  "read",
];

const REVIEW_STEP_IDS = [
  "audit-documentation",
  "derive-source-obligations",
  "lint-documentation",
  "provisional-technical-verification",
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hosted review documentation search reuse", () => {
  it("keeps the review tool set inside the pilot's sealed declaration", () => {
    const workflow = getWorkflow("review-documentation");
    const computed = [
      ...new Set(workflow.steps.flatMap((step) => grantedToolsForStep(workflow, step))),
    ].sort();
    expect(computed).toEqual(PILOT_DECLARED_TOOLS);
    expect(computed).not.toContain("get_section");
    // An empty plan set would pass the assertion above for the wrong reason.
    expect(workflow.steps.map((step) => step.search?.id)).toEqual(
      REVIEW_STEP_IDS.map(() => documentationAuditSearch.id),
    );
    expect(workflow.steps.map((step) => step.searchMode)).toEqual([
      "observe",
      "revalidate",
      "reuse",
      "reuse",
      "revalidate",
      "reuse",
      "reuse",
      "reuse",
    ]);
    // The host derives toolPolicySha256 from exactly {workflow, stepIds,
    // declaredTools}. Pinned so a change cannot move the dispatcher's sealed digest.
    expect(
      digest({
        workflow: "review-documentation",
        stepIds: REVIEW_STEP_IDS,
        declaredTools: PILOT_DECLARED_TOOLS,
      }),
    ).toBe("b359c21988a636c6cf8b8c662f35d4fd0a36f73964da48dd595cfb9f649f6d3e");
  });

  it("proves the plan choice is load-bearing for the sealed tool set", () => {
    // `documentation-observation` delivers the same probes, but `grantedTools`
    // keys the observation grant on its id, so selecting it adds an eleventh tool.
    const workflow = getWorkflow("review-documentation");
    const evaluator = workflow.steps.find((step) => step.id === "evaluate-document-quality")!;
    expect(
      grantedToolsForStep(workflow, {
        ...evaluator,
        search: documentationObservationSearch,
      }).sort(),
    ).toEqual([...PILOT_DECLARED_TOOLS, "get_section"].sort());
    expect(grantedToolsForStep(workflow, evaluator).sort()).toEqual(PILOT_DECLARED_TOOLS);
    expect(grantedToolsForStep(workflow, evaluator, true).sort()).toEqual([
      ...PILOT_DECLARED_TOOLS,
      "validate_quality_candidate",
    ]);
    expect(grantedTools("read-only", "evaluate", documentationAuditSearch)).not.toContain(
      "validate_quality_candidate",
    );
    expect(
      documentationAuditSearch.targets[0]!.requiredProbes.map((probe) => probe.strategy),
    ).toContain("documentation-inventory");
  });

  it("observes at derivation and final correction while reusing each fixed observation", async () => {
    const fixture = await gitFixture();
    const prompts: string[] = [];
    vi.stubGlobal("fetch", recordingProvider(prompts, REVIEW_STEP_IDS.length));
    const result = await runHostedWorkflow({
      request: reviewRequest(fixture),
      credential: "fixture-credential",
      emit: () => undefined,
    });

    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    const steps = result.record.steps;
    expect(steps.map((step) => step.id)).toEqual(REVIEW_STEP_IDS);

    // 1. Every step carries search evidence: the coordinator ran.
    for (const step of steps) {
      expect(step.searchEvidence, `step ${step.id} has no search evidence`).toBeDefined();
    }

    // 2. Derivation and final correction each obtain a fresh source observation.
    expect(steps.map((step) => step.searchParticipation?.searchMode)).toEqual([
      "observe",
      "revalidate",
      "reuse",
      "reuse",
      "revalidate",
      "reuse",
      "reuse",
      "reuse",
    ]);
    expect(steps.map((step) => step.searchParticipation?.observedByStepId)).toEqual([
      "audit-documentation",
      "derive-source-obligations",
      "derive-source-obligations",
      "derive-source-obligations",
      "verify-technical-accuracy",
      "verify-technical-accuracy",
      "verify-technical-accuracy",
      "verify-technical-accuracy",
    ]);

    // 3. Reused observations remain byte-identical within each fixed phase.
    const deriveDigest = steps[1]!.searchEvidence!.evidenceSha256;
    const finalDigest = steps[4]!.searchEvidence!.evidenceSha256;
    expect(deriveDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(finalDigest).toMatch(/^[0-9a-f]{64}$/u);
    for (const step of steps) {
      expect(step.searchEvidence!.workspaceSnapshotSha256).toBe(
        steps[0]!.searchEvidence!.workspaceSnapshotSha256,
      );
    }
    expect(steps.slice(1, 4).map((step) => step.searchEvidence!.evidenceSha256)).toEqual(
      Array(3).fill(deriveDigest),
    );
    expect(steps.slice(4).map((step) => step.searchEvidence!.evidenceSha256)).toEqual(
      Array(4).fill(finalDigest),
    );

    // 4. Positive control: "reuse" cannot pass by delivering an empty observation.
    const citedPaths = steps[0]!
      .searchEvidence!.searches.flatMap((search) =>
        search.bounded.probes.flatMap((probe) => probe.citations.map((citation) => citation.path)),
      )
      .sort();
    expect(citedPaths).toContain("docs/guide.md");
    expect(citedPaths).toContain("README.md");

    // 5. The inventory reaches every step's prompt as rendered text.
    expect(prompts).toHaveLength(REVIEW_STEP_IDS.length - 1);
    for (const prompt of prompts) {
      expect(prompt).toContain("Coordinator search findings");
      expect(prompt).toContain("docs/guide.md");
    }
  }, 120_000);

  it("measures the same focused fixture before and after reuse plus change-scoped context", async () => {
    const fixture = await gitFixture();
    const baselineState = join(fixture.stateDirectory, "baseline");
    const focusedState = join(fixture.stateDirectory, "focused");
    await mkdir(baselineState, { recursive: true });
    await mkdir(focusedState, { recursive: true });
    const current = getWorkflow("review-documentation");
    expect(current.contextPolicy.steps.map((step) => [step.level, step.query])).toEqual(
      REVIEW_STEP_IDS.map(() => ["corpus", "expand"]),
    );
    const baseline = {
      ...current,
      contextPolicy: {
        ...current.contextPolicy,
        steps: current.contextPolicy.steps.map((step) => ({
          ...step,
          level: "corpus" as const,
          query: "expand" as const,
        })),
      },
      steps: current.steps.map((step, index) => ({
        ...step,
        searchMode: index === 0 ? ("observe" as const) : ("revalidate" as const),
      })),
    };
    const run = async (
      workflow: typeof current,
      stateDirectory: string,
      runId: string,
      focused: boolean,
    ): Promise<RunRecord> => {
      const actual = workflowCatalog.getWorkflow;
      const spy = vi
        .spyOn(workflowCatalog, "getWorkflow")
        .mockImplementation(((name: Parameters<typeof actual>[0]) =>
          name === "review-documentation" ? workflow : actual(name)) as typeof actual);
      const request = reviewRequest(
        { ...fixture, stateDirectory },
        ...(focused ? [reviewScopeFor(["docs/guide.md"])] : []),
      );
      vi.stubGlobal(
        "fetch",
        recordingProvider([], REVIEW_STEP_IDS.length, focused ? ["docs/guide.md"] : undefined),
      );
      try {
        return (
          await runHostedWorkflow({
            request: { ...request, runId },
            credential: "fixture-credential",
            emit: () => undefined,
          })
        ).record;
      } finally {
        (spy as unknown as { mockRestore(): void }).mockRestore();
      }
    };
    const before = await run(baseline, baselineState, "run-review-baseline", false);
    const after = await run(current, focusedState, "run-review-focused", true);
    const measure = (record: RunRecord) => ({
      providerTurns: record.usage.turns,
      toolCalls: record.tools.totalCalls,
      discoveryExecutions: record.steps.filter(
        (step) => step.searchParticipation?.searchMode !== "reuse",
      ).length,
      stepDurationMs: record.steps.map((step) => ({
        stepId: step.id,
        durationMs: step.durationMs ?? 0,
      })),
      totalDurationMs: record.durationMs ?? 0,
      contextBytes: record.steps.reduce(
        (sum, step) => sum + (step.contextPreflight?.measurements?.byteLength ?? 0),
        0,
      ),
    });
    const measurement = { before: measure(before), after: measure(after) };
    expect(before.status, JSON.stringify(before.error)).toBe("succeeded");
    expect(after.status, JSON.stringify(after.error)).toBe("succeeded");
    expect(measurement.before.discoveryExecutions).toBe(8);
    expect(measurement.after.discoveryExecutions).toBe(3);
    expect(measurement.before.providerTurns).toBeGreaterThan(0);
    expect(measurement.after.providerTurns).toBe(measurement.before.providerTurns);
    expect(measurement.before.toolCalls).toBe(0);
    expect(measurement.after.toolCalls).toBe(0);
    expect(measurement.before.contextBytes).toBeGreaterThan(0);
    expect(measurement.after.contextBytes).toBeLessThanOrEqual(measurement.before.contextBytes);
    expect(measurement.before.stepDurationMs).toHaveLength(8);
    expect(measurement.after.stepDurationMs).toHaveLength(8);
    console.info(`FOCUSED_REVIEW_MEASUREMENT ${JSON.stringify(measurement)}`);
  }, 180_000);

  it("attests the observation inside the step evidence identity", async () => {
    const fixture = await gitFixture();
    vi.stubGlobal("fetch", recordingProvider([], REVIEW_STEP_IDS.length));
    const result = await runHostedWorkflow({
      request: reviewRequest(fixture),
      credential: "fixture-credential",
      emit: () => undefined,
    });
    for (const step of result.record.steps) {
      if (step.kind === "host-operation") continue;
      const identities = (step.inference?.attempts ?? []).map((attempt) => attempt.identity);
      expect(identities.length, `step ${step.id} recorded no inference attempt`).toBeGreaterThan(0);
      for (const identity of identities) {
        expect(identity?.searchEvidenceSha256).toBe(step.searchEvidence!.evidenceSha256);
      }
    }
  }, 120_000);

  it("records a provider that answers under another model name, and completes", async () => {
    const fixture = await gitFixture();
    const provider = recordingProvider([], REVIEW_STEP_IDS.length);
    // A gateway that renames the model in every answer.
    vi.stubGlobal("fetch", (async (input: unknown, init?: { body?: unknown }) => {
      const answer = await (provider as (input: unknown, init?: unknown) => Promise<Response>)(
        input,
        init,
      );
      const text = (await answer.text()).replaceAll(
        '"model":"model-fixture"',
        '"model":"gateway/renamed"',
      );
      return new Response(text, { status: answer.status, headers: answer.headers });
    }) as unknown as typeof fetch);
    const result = await runHostedWorkflow({
      request: reviewRequest(fixture),
      credential: "fixture-credential",
      emit: () => undefined,
    });
    expect(result.record.status).toBe("succeeded");
    expect(result.record.evidenceWarnings).toContain(
      servedModelWarning({ expectedModel: "model-fixture", servedModels: ["gateway/renamed"] }),
    );
  }, 120_000);

  it("keeps a real ready corpus context for an untargeted documentation-set review", async () => {
    const fixture = await gitFixture();
    vi.stubGlobal("fetch", recordingProvider([], REVIEW_STEP_IDS.length));
    const request = reviewRequest(fixture);
    const result = await runHostedWorkflow({
      request,
      credential: "fixture-credential",
      emit: () => undefined,
    });
    for (const step of result.record.steps) {
      const evidence = step.contextPreflight!;
      expect(evidence.status).toBe("ready");
      expect(evidence.reason).toBeUndefined();
      expect(evidence.packetDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
  }, 120_000);

  it("sizes each corpus packet from the sealed composition's input window (#1932)", async () => {
    const fixture = await gitFixture();
    const prompts: string[] = [];
    vi.stubGlobal("fetch", recordingProvider(prompts, REVIEW_STEP_IDS.length));
    const request = reviewRequest(fixture);
    const window = request.composition.executionProfile!.profile.maxInputTokens;
    expect(window).toBe(131_072);
    const result = await runHostedWorkflow({
      request,
      credential: "fixture-credential",
      emit: () => undefined,
    });
    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    // 1,250 basis points of the sealed window, twice what the fallback window gives.
    const sealed = contextPacketBudget("corpus", window).maxEstimatedTokens;
    expect(sealed).toBe(16_384);
    expect(contextPacketBudget("corpus").maxEstimatedTokens).toBe(8_192);
    const withPacket = prompts.filter((prompt) =>
      prompt.includes("Revision-bound repository context"),
    );
    expect(withPacket.length).toBeGreaterThan(0);
    for (const prompt of withPacket) {
      expect(prompt).toContain(`"maxEstimatedTokens":${sealed}`);
    }
  }, 120_000);

  it("sizes each corpus packet from the fallback window when the sealed profile is unattested (#1809, #1932)", async () => {
    const fixture = await gitFixture();
    const prompts: string[] = [];
    vi.stubGlobal("fetch", recordingProvider(prompts, REVIEW_STEP_IDS.length));
    // The same sealed window, from a profile that matches no installed
    // composition and whose metadata nobody attested: DocsFab does not admit
    // against it, so packets take the fallback window, as source reads do.
    const request = reviewRequest(fixture, null, "metadata-unknown");
    expect(request.composition.executionProfile!.profile.maxInputTokens).toBe(131_072);
    const result = await runHostedWorkflow({
      request,
      credential: "fixture-credential",
      emit: () => undefined,
    });
    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    const fallback = contextPacketBudget("corpus").maxEstimatedTokens;
    expect(fallback).toBe(8_192);
    const withPacket = prompts.filter((prompt) =>
      prompt.includes("Revision-bound repository context"),
    );
    expect(withPacket.length).toBeGreaterThan(0);
    for (const prompt of withPacket) {
      expect(prompt).toContain(`"maxEstimatedTokens":${fallback}`);
    }
  }, 120_000);

  it("keeps corpus context for a multi-page focused review", async () => {
    const fixture = await gitFixture();
    vi.stubGlobal("fetch", recordingProvider([], REVIEW_STEP_IDS.length));
    const request = reviewRequest(fixture, reviewScopeFor(["docs/guide.md", "README.md"]));
    const result = await runHostedWorkflow({
      request,
      credential: "fixture-credential",
      emit: () => undefined,
    });
    const executed = result.record.steps.filter(
      (step) =>
        step.kind !== "host-operation" &&
        step.contextPreflight?.reason !== "workflow-stopped-before-step",
    );
    expect(executed.length).toBeGreaterThan(0);
    for (const step of executed) expect(step.contextPreflight?.status, step.id).toBe("ready");
    expect(
      result.record.steps.some((step) => step.contextPreflight?.reason === "target-not-applicable"),
    ).toBe(false);
  }, 120_000);

  it("runs fixed fresh observations and reuses only within each phase", async () => {
    const fixture = await gitFixture();
    const workflow = getWorkflow("review-documentation");

    const asDeclared = await countDiscovery(fixture, workflow);
    expect(asDeclared.searches).toBe(3);
    expect(asDeclared.record.status, JSON.stringify(asDeclared.record.error)).toBe("succeeded");

    // Positive control: revalidating the lint reuse adds exactly one observation.
    const revalidating = {
      ...workflow,
      steps: workflow.steps.map((step, index) =>
        index === 2 ? { ...step, searchMode: "revalidate" as const } : step,
      ),
    };
    const withRevalidate = await countDiscovery(await gitFixture(), revalidating);
    expect(withRevalidate.searches).toBe(4);
  }, 120_000);

  it("does not share an inventory identity across revisions", async () => {
    const first = await gitFixture();
    const before = await observeInventory(first);
    await writeFile(join(first.repository, "docs", "second.md"), "# Second\n\nAdded.\n");
    await exec("git", ["add", "."], { cwd: first.repository });
    await exec("git", ["commit", "-q", "-m", "second"], { cwd: first.repository });
    const second = {
      ...first,
      revision: (
        await exec("git", ["rev-parse", "HEAD"], { cwd: first.repository, encoding: "utf8" })
      ).stdout.trim(),
      tree: (
        await exec("git", ["rev-parse", "HEAD^{tree}"], {
          cwd: first.repository,
          encoding: "utf8",
        })
      ).stdout.trim(),
    };
    const after = await observeInventory(second);

    expect(second.revision).not.toBe(first.revision);
    expect(after.workspaceSnapshotSha256).not.toBe(before.workspaceSnapshotSha256);
    expect(after.evidenceSha256).not.toBe(before.evidenceSha256);
  }, 120_000);

  it("binds a single named target through the real compile and still reuses", async () => {
    const fixture = await gitFixture();
    const prompts: string[] = [];
    vi.stubGlobal("fetch", recordingProvider(prompts, REVIEW_STEP_IDS.length, ["docs/guide.md"]));
    const request = reviewRequest(fixture, reviewScopeFor(["docs/guide.md"]));
    const result = await runHostedWorkflow({
      request,
      credential: "fixture-credential",
      emit: () => undefined,
    });

    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    // "ready" alone is satisfied by a compile that ignores includePaths. The
    // named page bound when a real packet compiled (not the capsule echo) and it
    // is strictly narrower than the same run without a target.
    const compileFor = async (scope: Record<string, unknown> | null) => {
      const other = await gitFixture();
      vi.stubGlobal("fetch", recordingProvider([], REVIEW_STEP_IDS.length));
      const { record } = await runHostedWorkflow({
        request: reviewRequest(other, scope),
        credential: "fixture-credential",
        emit: () => undefined,
      });
      return record.steps[0]!.contextPreflight!;
    };
    const otherTarget = await compileFor(reviewScopeFor(["docs/reference.md"]));
    for (const step of result.record.steps) {
      const evidence = step.contextPreflight!;
      expect(evidence.status, `step ${step.id}`).toBe("ready");
      expect(evidence.cache!.disposition).not.toBe("rejected");
      expect(evidence.packetDigest).not.toBe(request.capsule.sha256);
      expect(evidence.ontologyVersion).not.toBe("hosted-v1");
      // Node ids are opaque digests, so a different target's node set is how
      // this proves this page bound.
      expect(evidence.consultedNodeIds).not.toEqual(otherTarget.consultedNodeIds);
    }
    // Inventory binds the comparison targets without asking that phase to review
    // the documentation candidate.
    expect(prompts).toHaveLength(REVIEW_STEP_IDS.length - 1);
    for (const [index, prompt] of prompts.entries()) {
      if (index === 1) {
        expect(prompt).toContain("Source inventory scope (authoritative, frozen before this run):");
        expect(prompt).toContain('Documentation targets for later comparison: ["docs/guide.md"]');
        expect(prompt).toContain("Inspect relevant admitted implementation sources");
        expect(prompt).not.toContain("Review scope (authoritative, frozen before this run):");
        expect(prompt).not.toContain("These are the only pages under review");
      } else {
        expect(prompt).toContain("Review scope (authoritative, frozen before this run):");
        expect(prompt).toContain('Approved paths: ["docs/guide.md"]');
        expect(prompt).not.toContain(
          "Source inventory scope (authoritative, frozen before this run):",
        );
      }
      expect(prompt).toContain("Coordinator search findings");
    }
    expect(result.record.steps.map((step) => step.searchParticipation?.searchMode)).toEqual([
      "observe",
      "revalidate",
      "reuse",
      "reuse",
      "revalidate",
      "reuse",
      "reuse",
      "reuse",
    ]);
  }, 120_000);

  it("treats a named target absent at the frozen revision as unnecessary, never widening to the capsule", async () => {
    const fixture = await gitFixture();
    vi.stubGlobal(
      "fetch",
      recordingProvider([], REVIEW_STEP_IDS.length, ["docs/guide.md", "README.md"]),
    );
    const result = await runHostedWorkflow({
      request: reviewRequest(fixture, reviewScopeFor(["docs/not-at-this-revision.md"])),
      credential: "fixture-credential",
      emit: () => undefined,
    });
    // Fail-open (owner directive): the operator's single named page is
    // absent, so there is nothing to review, but that is a benign outcome,
    // not a broken run -- the job still completes. A capsule fallback would
    // instead have reviewed the whole corpus while reporting the operator's
    // single page as reviewed, which is why every step still compiles no
    // packet at all rather than widening to it.
    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    for (const step of result.record.steps) {
      if (step.kind === "host-operation") continue;
      expect(step.contextPreflight, step.id).toMatchObject({
        status: "unnecessary",
        reason: "target-not-applicable",
      });
      expect(step.contextPreflight!.packetDigest).toBeUndefined();
    }
  }, 120_000);

  it("reviews the resolvable page of a mixed multi-target scope through the hosted preflight too", async () => {
    const fixture = await gitFixture();
    vi.stubGlobal(
      "fetch",
      recordingProvider([], REVIEW_STEP_IDS.length, ["docs/guide.md", "README.md"]),
    );
    const request = reviewRequest(
      fixture,
      reviewScopeFor(["docs/guide.md", "docs/not-at-this-revision.md"]),
    );
    const result = await runHostedWorkflow({
      request,
      credential: "fixture-credential",
      emit: () => undefined,
    });
    // The hosted wrapper's `contextPreflightAllowsExecution` check admits a
    // `degraded` compile immediately (allowReadOnlyDegraded), the same way
    // it already admits `navigation-coverage-incomplete`; it never reaches
    // the scoped-refusal / capsule-fallback branch below that check.
    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    for (const step of result.record.steps) {
      if (step.kind === "host-operation") continue;
      expect(step.contextPreflight, step.id).toMatchObject({
        status: "degraded",
        reason: "scope-target-partially-unresolved",
      });
      // A real compiled packet (not the untargeted or capsule-echo shape):
      // its digest differs from the capsule's own sha256.
      expect(step.contextPreflight!.packetDigest).toBeDefined();
      expect(step.contextPreflight!.packetDigest).not.toBe(request.capsule.sha256);
    }
  }, 120_000);

  it("keeps a multi-target scope on the untargeted compile", async () => {
    const fixture = await gitFixture();
    vi.stubGlobal(
      "fetch",
      recordingProvider([], REVIEW_STEP_IDS.length, ["docs/guide.md", "README.md"]),
    );
    const result = await runHostedWorkflow({
      request: reviewRequest(fixture, reviewScopeFor(["docs/guide.md", "README.md"])),
      credential: "fixture-credential",
      emit: () => undefined,
    });
    // Two targets have no single contextTarget, so they keep the catalog's corpus
    // context instead of a change-scoped preflight.
    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    for (const step of result.record.steps) {
      if (step.kind === "host-operation") continue;
      expect(step.contextPreflight!.status).toBe("ready");
      expect(step.contextPreflight!.reason).toBeUndefined();
    }
  }, 120_000);

  it("rejects a forged provenance claim in the record decoder", () => {
    const evidence = {
      planId: "source-readiness-discovery",
      evidenceSha256: "c".repeat(64),
      workspaceSnapshotSha256: "d".repeat(64),
    } as unknown as NonNullable<RunRecord["steps"][number]["searchEvidence"]>;
    const genuine = {
      schemaVersion: 1 as const,
      kind: "docsfab-step-search-participation" as const,
      planId: "source-readiness-discovery",
      searchMode: "observe" as const,
      observedByStepId: "assess-readiness",
      searchEvidenceSha256: "c".repeat(64),
      workspaceSnapshotSha256: "d".repeat(64),
    };
    // Baseline: the honest record decodes, so the rejections below are specific.
    expect(decodeSearchParticipation(genuine, evidence, "assess-readiness", [])).toEqual(genuine);

    // Every field a participation record restates must agree with the evidence
    // beside it; each forgery must be refused on its own.
    const forgeries: [string, Record<string, unknown>][] = [
      ["planId", { ...genuine, planId: "documentation-audit-discovery" }],
      ["searchEvidenceSha256", { ...genuine, searchEvidenceSha256: "a".repeat(64) }],
      ["workspaceSnapshotSha256", { ...genuine, workspaceSnapshotSha256: "b".repeat(64) }],
      ["observer for an observe step", { ...genuine, observedByStepId: "some-other-step" }],
      ["self-reuse", { ...genuine, searchMode: "reuse" }],
      ["unknown mode", { ...genuine, searchMode: "inherit" }],
    ];
    for (const [name, forged] of forgeries) {
      expect(
        () => decodeSearchParticipation(forged, evidence, "assess-readiness", []),
        `forged ${name} was accepted`,
      ).toThrowError(ScorecardRecordError);
    }

    // Participation with no evidence beside it is unverifiable.
    expect(() =>
      decodeSearchParticipation(genuine, undefined, "assess-readiness", []),
    ).toThrowError(ScorecardRecordError);

    // A reusing step must name a step that already ran in this record.
    expect(
      decodeSearchParticipation(
        { ...genuine, searchMode: "reuse", observedByStepId: "audit-documentation" },
        evidence,
        "lint-documentation",
        ["audit-documentation"],
      ).searchMode,
    ).toBe("reuse");
    for (const ghost of ["review-documentation", "assess-readiness", "no-such-step"]) {
      expect(
        () =>
          decodeSearchParticipation(
            { ...genuine, searchMode: "reuse", observedByStepId: ghost },
            evidence,
            "lint-documentation",
            ["audit-documentation"],
          ),
        `reuse from ${ghost} was accepted`,
      ).toThrowError(ScorecardRecordError);
    }
  });

  it("states what the hosted observation actually completed", async () => {
    const fixture = await gitFixture();
    const prompts: string[] = [];
    vi.stubGlobal("fetch", recordingProvider(prompts, REVIEW_STEP_IDS.length));
    const { record } = await runHostedWorkflow({
      request: reviewRequest(fixture),
      credential: "fixture-credential",
      emit: () => undefined,
    });
    const bounded = record.steps[0]!.searchEvidence!.searches[0]!.bounded;
    const byOutcome = new Map<string, string[]>();
    for (const probe of bounded.probes) {
      byOutcome.set(probe.outcome, [...(byOutcome.get(probe.outcome) ?? []), probe.id]);
    }
    // The hosted checkout is a detached Git worktree, not a registered
    // RepositoryWorkspace, so only the filesystem inventory probe completes. The
    // pinned denominator stops the runtime claiming more coverage than it delivered.
    expect(byOutcome.get("match")).toEqual(["audit-doc-inventory"]);
    expect(byOutcome.get("inconclusive")?.sort()).toEqual(
      [
        "audit-accuracy-rubric",
        "audit-completeness-rubric",
        "audit-usability-rubric",
        "audit-nav-rubric",
      ].sort(),
    );
    expect(byOutcome.get("blocked")).toEqual(["audit-nav-graph"]);
    expect([...byOutcome.values()].reduce((total, ids) => total + ids.length, 0)).toBe(6);
    expect(bounded.limitations.map((limitation) => limitation.id)).toEqual([
      "unsupported-local-probe",
    ]);
    expect(bounded.limitations[0]!.impact).toBe("blocking");

    // A loose bound would not notice the observation rendered twice. Subtract the
    // known skill block and correction contract, require each exact block once,
    // and bound the rest against the evidence. Do not widen the 1.5x + 8 KiB bound.
    const evidenceBytes = Buffer.byteLength(JSON.stringify(record.steps[0]!.searchEvidence));
    const correctionContractBytes = Buffer.byteLength(
      TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
      "utf8",
    );
    const skillBlockPattern =
      /<skill name="[^"]+" location="[^"]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?\n<\/skill>/u;
    const correctionStepPrompt = getWorkflow("review-documentation").steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!.prompt;
    let correctionPhasePrompts = 0;
    for (const prompt of prompts) {
      expect(prompt.split("Coordinator search findings").length - 1).toBe(1);
      const skillBlock = skillBlockPattern.exec(prompt)?.[0];
      expect(skillBlock, "expanded skill block in the rendered provider request").toBeDefined();
      expect(
        prompt.split(skillBlock!).length - 1,
        "skill block count for the rendered provider request",
      ).toBe(1);
      const correctionContractCount =
        prompt.split(TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3).length - 1;
      const expectedCorrectionContractCount = prompt.includes(correctionStepPrompt) ? 1 : 0;
      correctionPhasePrompts += expectedCorrectionContractCount;
      expect(
        correctionContractCount,
        "correction contract count for the rendered provider request",
      ).toBe(expectedCorrectionContractCount);
      const variablePromptBytes =
        Buffer.byteLength(prompt, "utf8") -
        expectedCorrectionContractCount * correctionContractBytes -
        Buffer.byteLength(skillBlock!, "utf8");
      expect(variablePromptBytes).toBeLessThan(evidenceBytes * 1.5 + 8 * 1024);
    }
    expect(correctionPhasePrompts).toBe(1);
  }, 120_000);

  it("binds the observation into the per-step lease digest", () => {
    // The record carrying the digest does not prove the lease binds it: without
    // the searchEvidenceSha256 spread in harness/pi-offline.ts the first two match.
    const workflow = getWorkflow("review-documentation");
    const { profile } = bindModelExecutionProfile(validModelConfig);
    const leaseEvidenceFor = (searchEvidenceSha256?: string): string =>
      createPiExecutionLeaseController(
        {
          runId: "lease-run",
          repositoryPath: "/tmp/repository",
          workflow,
          step: workflow.steps[0]!,
          evidenceIdentity: {
            repositoryRevision: "a".repeat(40),
            ...(searchEvidenceSha256 ? { searchEvidenceSha256 } : {}),
          },
        } as HarnessStepInput,
        profile,
        ["read"],
      ).coordinator.identity.evidenceSha256;

    const first = leaseEvidenceFor("c".repeat(64));
    const second = leaseEvidenceFor("d".repeat(64));
    expect(first).not.toBe(second);

    // Positive control: a step with no search plan keeps the digest without this
    // field, so runs that never observe do not shift.
    const unobserved = leaseEvidenceFor(undefined);
    expect(unobserved).not.toBe(first);
    expect(unobserved).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            consultedNodeIds: [],
            contextPacketSha256: createHash("sha256")
              .update(JSON.stringify({ kind: "docsfab-empty-context-packet" }))
              .digest("hex"),
            repositoryRevision: "a".repeat(40),
          }),
        )
        .digest("hex"),
    );
  });

  it("survives an unindexable corpus without refusing a present page", async () => {
    // Two pages sharing one frontmatter id make the untargeted index throw for
    // the whole compile (content-ir/indexer.ts). A present named page must not
    // be refused for it: a focused index never reads `other/`, and it skips an
    // optional sibling page alias, so the targeted run compiles a real `ready`
    // packet. The alias alone no longer stops an untargeted compile (#1910).
    const unindexableFixture = async (): Promise<GitFixture> => {
      const fixture = await gitFixture();
      await symlink("guide.md", join(fixture.repository, "docs", "alias.md"));
      await mkdir(join(fixture.repository, "other"), { recursive: true });
      for (const name of ["one", "two"]) {
        await writeFile(
          join(fixture.repository, "other", `${name}.md`),
          `---\nid: shared\n---\n# ${name}\n`,
        );
      }
      await exec("git", ["add", "-A"], { cwd: fixture.repository });
      await exec("git", ["commit", "-q", "-m", "symlink"], { cwd: fixture.repository });
      const revision = (
        await exec("git", ["rev-parse", "HEAD"], { cwd: fixture.repository, encoding: "utf8" })
      ).stdout.trim();
      const tree = (
        await exec("git", ["rev-parse", "HEAD^{tree}"], {
          cwd: fixture.repository,
          encoding: "utf8",
        })
      ).stdout.trim();
      return { ...fixture, revision, tree };
    };

    for (const scope of [
      null,
      reviewScopeFor(["docs/guide.md"]),
      reviewScopeFor(["README.md", "docs/guide.md"]),
    ]) {
      const label = scope ? `targeted x${(scope.targets as unknown[]).length}` : "untargeted";
      const unindexable = await unindexableFixture();
      vi.stubGlobal("fetch", recordingProvider([], REVIEW_STEP_IDS.length));
      const { record } = await runHostedWorkflow({
        request: reviewRequest(unindexable, scope),
        credential: "fixture-credential",
        emit: () => undefined,
      });
      expect(record.status, label).toBe("succeeded");
      for (const step of record.steps) {
        const evidence = step.contextPreflight!;
        if (scope) {
          expect(evidence.status, `${label} ${step.id}`).toBe("ready");
          expect(evidence.reason, `${label} ${step.id}`).toBeUndefined();
          expect(evidence.packetDigest, `${label} ${step.id}`).not.toBe(
            reviewRequest(unindexable, scope).capsule.sha256,
          );
        } else {
          // The capsule still stands in for the packet, and the record names
          // the real cause and both pages instead of an uncoded failure (#1924).
          expect(evidence.status, `${label} ${step.id}`).toBe("degraded");
          expect(evidence.reason).toBe("content-index-refused");
          expect(evidence.packetDigest).toBe(reviewRequest(unindexable, scope).capsule.sha256);
          expect(evidence.cause).toEqual({
            code: "duplicate-node-identity",
            message:
              'Content index contains a duplicate document identity: "other/one.md" and "other/two.md" share one. Give each page its own frontmatter id.',
          });
          expect(evidence.cache).toEqual({ disposition: "disabled", rebuildAttempted: true });
        }
        // The record must survive the repo's decoder, not just the normalizer.
        expect(() => decodeContextPreflight(evidence), `${label} ${step.id}`).not.toThrow();
      }
      // The fixed observation chain is unaffected by a degraded context packet.
      expect(
        record.steps.map((step) => step.searchParticipation?.searchMode),
        label,
      ).toEqual([
        "observe",
        "revalidate",
        "reuse",
        "reuse",
        "revalidate",
        "reuse",
        "reuse",
        "reuse",
      ]);
    }
  }, 180_000);

  it("keeps the compiler's verdict legible when it falls back", async () => {
    const workflow = getWorkflow("review-documentation");
    const capsule = {
      sha256: digest({ capsule: "fixture" }),
      receiptSha256: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
    };
    const inputFor = (contextTarget?: { sourcePath: string }): ContextPreflightInput =>
      ({
        runId: "run-preflight-unit",
        repository: { sourcePath: "/tmp/x", requestedRevision: "HEAD", revision: "a".repeat(40) },
        workspacePath: "/tmp/x",
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
        ...(contextTarget ? { contextTarget } : {}),
      }) as ContextPreflightInput;
    const serviceReturning = (result: ContextPreflightResult | Error, budgetMs = 30_000) =>
      createHostedContextPreflightService({
        capsule,
        stateDirectory: "/tmp/x-state",
        budgetMs,
        service: {
          async preflight() {
            if (result instanceof Error) throw result;
            return result;
          },
        },
      });

    const ready: ContextPreflightResult = {
      status: "ready",
      packetDigest: "e".repeat(64),
      consultedNodeIds: ["node-1"],
      ontologyVersion: "content-ir-v1",
    };
    expect(await serviceReturning(ready).preflight(inputFor())).toEqual(ready);

    // An untargeted refusal falls back, and the record says why the compile was unused.
    const refused = await serviceReturning({
      status: "failed",
      reason: "preflight-internal-failure",
    }).preflight(inputFor());
    // `degraded`, not `ready`: no packet was compiled, and `ready` with a
    // `reason` is a shape decodeContextPreflight refuses outright.
    expect(refused.status).toBe("degraded");
    expect(refused.packetDigest).toBe(capsule.sha256);
    expect(refused.cache).toEqual({ disposition: "disabled", rebuildAttempted: true });
    expect(refused.reason).toBe("preflight-internal-failure");
    await expectDecodableRecord(
      serviceReturning({
        status: "failed",
        reason: "preflight-internal-failure",
      }),
      inputFor(),
    );

    // A compile that threw is an internal failure, not a slow one.
    const threw = await serviceReturning(new Error("compiler exploded")).preflight(inputFor());
    expect(threw.packetDigest).toBe(capsule.sha256);
    expect(threw.cache).toEqual({ disposition: "disabled", rebuildAttempted: true });
    expect(threw.reason).toBe("preflight-internal-failure");
    expect(threw.limit).toBeUndefined();
    await expectDecodableRecord(serviceReturning(new Error("compiler exploded")), inputFor());

    // A compile that outruns its ceiling names the ceiling, its configured
    // value, and the elapsed time.
    const slowService = () =>
      createHostedContextPreflightService({
        capsule,
        stateDirectory: "/tmp/x-state",
        budgetMs: 1,
        service: {
          async preflight() {
            await new Promise((settle) => setTimeout(settle, 200));
            return ready;
          },
        },
      });
    const timedOut = await slowService().preflight(inputFor());
    expect(timedOut.packetDigest).toBe(capsule.sha256);
    expect(timedOut.cache).toEqual({ disposition: "disabled", rebuildAttempted: true });
    expect(timedOut.reason).toBe("preflight-budget-exceeded");
    expect(timedOut.limit).toEqual({
      name: "hostInvoker.contextPreflightBudgetMs",
      unit: "ms",
      configured: 1,
      observed: expect.any(Number) as number,
    });
    expect(timedOut.limit!.observed).toBeGreaterThanOrEqual(1);
    await expectDecodableRecord(slowService(), inputFor());
    // The coded ceiling has to survive the record trip, not only the seam.
    const budgeted = await preflightContext({
      contextPreflight: slowService(),
      ...inputFor(),
    });
    expect(budgeted.evidence.reason).toBe("preflight-budget-exceeded");
    expect(budgeted.evidence.limit?.name).toBe("hostInvoker.contextPreflightBudgetMs");
    expect(decodeContextPreflight(budgeted.evidence).limit).toEqual(budgeted.evidence.limit);

    // A host compiler may bound itself and return the budget reason with its own
    // bound. Without one it is a seam violation, recorded as a coded internal
    // failure rather than a normalizer throw.
    const compilerBound = await serviceReturning({
      status: "failed",
      reason: "preflight-budget-exceeded",
      limit: { name: "hostCompiler.ownBudgetMs", unit: "ms", configured: 5, observed: 6 },
    }).preflight(inputFor());
    expect(compilerBound.reason).toBe("preflight-budget-exceeded");
    expect(compilerBound.limit?.name).toBe("hostCompiler.ownBudgetMs");
    await expectDecodableRecord(
      serviceReturning({
        status: "failed",
        reason: "preflight-budget-exceeded",
        limit: { name: "hostCompiler.ownBudgetMs", unit: "ms", configured: 5, observed: 6 },
      }),
      inputFor(),
    );
    const unboundedClaim = () =>
      serviceReturning({ status: "failed", reason: "preflight-budget-exceeded" });
    const unbounded = await unboundedClaim().preflight(inputFor());
    expect(unbounded.reason).toBe("preflight-internal-failure");
    expect(unbounded.limit).toBeUndefined();
    await expect(
      preflightContext({ contextPreflight: unboundedClaim(), ...inputFor() }),
    ).resolves.toBeDefined();
    await expectDecodableRecord(unboundedClaim(), inputFor());

    // A malformed bound is the same seam violation as an absent one. The
    // normalizer's own rule routes both to the coded internal failure, so the
    // two cannot drift.
    const malformedClaims: ReadonlyArray<{ note: string; limit: unknown }> = [
      { note: "names itself but states no values", limit: { name: "hostCompiler.ownBudgetMs" } },
      {
        note: "observed below the bound it claims to have breached",
        limit: { name: "hostCompiler.ownBudgetMs", unit: "ms", configured: 9, observed: 1 },
      },
      {
        note: "a unit this record cannot carry",
        limit: { name: "hostCompiler.ownBudget", unit: "s", configured: 1, observed: 2 },
      },
    ];
    for (const { note, limit } of malformedClaims) {
      const malformedClaim = () =>
        serviceReturning({
          status: "failed",
          reason: "preflight-budget-exceeded",
          limit,
        } as unknown as ContextPreflightResult);
      const malformed = await malformedClaim().preflight(inputFor());
      expect(malformed.reason, note).toBe("preflight-internal-failure");
      expect(malformed.limit, note).toBeUndefined();
      await expectDecodableRecord(malformedClaim(), inputFor());
      // Positive control: unrouted, the normalizer throws on each of these.
      expect(() =>
        normalizeContextPreflight({
          status: "failed",
          reason: "preflight-budget-exceeded",
          limit,
        } as unknown as ContextPreflightResult),
      ).toThrow("Context preflight returned an invalid limit record");
    }

    // The fail-closed rule: a named target never widens back to the capsule.
    const targeted = await serviceReturning({
      status: "failed",
      reason: "target-not-applicable",
    }).preflight(inputFor({ sourcePath: "docs/guide.md" }));
    expect(targeted.status).toBe("failed");
    expect(targeted.reason).toBe("target-not-applicable");
    expect(targeted.packetDigest).toBeUndefined();

    // A named target plus a broken compiler is not evidence the page is missing,
    // so it falls back rather than refusing a present page.
    const targetedCrash = await serviceReturning({
      status: "failed",
      reason: "preflight-internal-failure",
    }).preflight(inputFor({ sourcePath: "docs/guide.md" }));
    expect(targetedCrash.status).toBe("degraded");
    expect(targetedCrash.packetDigest).toBe(capsule.sha256);
    await expectDecodableRecord(
      serviceReturning({ status: "failed", reason: "preflight-internal-failure" }),
      inputFor({ sourcePath: "docs/guide.md" }),
    );
  });

  it("separates a compile that lands at its budget from one that outruns it by a millisecond", async () => {
    const workflow = getWorkflow("review-documentation");
    const capsule = {
      sha256: digest({ capsule: "budget-boundary" }),
      receiptSha256: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
    };
    const input = {
      runId: "run-preflight-budget",
      repository: { sourcePath: "/tmp/x", requestedRevision: "HEAD", revision: "a".repeat(40) },
      workspacePath: "/tmp/x",
      workflow,
      step: workflow.steps[0]!,
      policy: workflow.contextPolicy.steps[0]!,
    } as ContextPreflightInput;
    const ready: ContextPreflightResult = {
      status: "ready",
      packetDigest: "e".repeat(64),
      consultedNodeIds: ["node-1"],
      ontologyVersion: "content-ir-v1",
    };
    const budgetMs = HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS;
    const serviceCompilingAfter = (compileMs: number) =>
      createHostedContextPreflightService({
        capsule,
        stateDirectory: "/tmp/x-state",
        budgetMs,
        clock: () => Date.now(),
        service: {
          async preflight() {
            await new Promise((settle) => setTimeout(settle, compileMs));
            return ready;
          },
        },
      });

    vi.useFakeTimers();
    try {
      // At the budget the compile lands and the result carries no limit.
      const atBudget = serviceCompilingAfter(budgetMs).preflight(input);
      await vi.advanceTimersByTimeAsync(budgetMs);
      const landed = await atBudget;
      expect(landed).toEqual(ready);
      expect(landed.limit).toBeUndefined();

      // One millisecond past the budget the ceiling binds and names itself.
      const pastBudget = serviceCompilingAfter(budgetMs + 1).preflight(input);
      await vi.advanceTimersByTimeAsync(budgetMs + 1);
      const stopped = await pastBudget;
      expect(stopped.status).toBe("degraded");
      expect(stopped.reason).toBe("preflight-budget-exceeded");
      expect(stopped.limit).toEqual({
        name: "hostInvoker.contextPreflightBudgetMs",
        unit: "ms",
        configured: budgetMs,
        observed: budgetMs,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("populates a preflight-budget reason when a hanging compile times out at the catalog budget and one millisecond past", async () => {
    const workflow = getWorkflow("review-documentation");
    const capsule = {
      sha256: digest({ capsule: "budget-timeout" }),
      receiptSha256: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
    };
    const input = {
      runId: "run-preflight-timeout",
      repository: { sourcePath: "/tmp/x", requestedRevision: "HEAD", revision: "a".repeat(40) },
      workspacePath: "/tmp/x",
      workflow,
      step: workflow.steps[0]!,
      policy: workflow.contextPolicy.steps[0]!,
    } as ContextPreflightInput;
    const budgetMs = HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS;
    const hanging = (waitNow: () => number) =>
      createHostedContextPreflightService({
        capsule,
        stateDirectory: "/tmp/x-state",
        budgetMs,
        waitNow,
        service: {
          async preflight() {
            return await new Promise<ContextPreflightResult>(() => undefined);
          },
        },
      });

    vi.useFakeTimers();
    try {
      let elapsedMs = 0;
      const atBudget = hanging(() => elapsedMs).preflight(input);
      elapsedMs = budgetMs;
      await vi.advanceTimersByTimeAsync(budgetMs);
      const timedOutAtBudget = await atBudget;
      expect(timedOutAtBudget.status).toBe("degraded");
      expect(timedOutAtBudget.reason).toBe("preflight-budget-exceeded");
      expect(timedOutAtBudget.limit).toEqual({
        name: "hostInvoker.contextPreflightBudgetMs",
        unit: "ms",
        configured: budgetMs,
        observed: budgetMs,
      });

      elapsedMs = 0;
      const pastBudget = hanging(() => elapsedMs).preflight(input);
      elapsedMs = budgetMs + 1;
      await vi.advanceTimersByTimeAsync(budgetMs);
      const timedOutPastBudget = await pastBudget;
      expect(timedOutPastBudget.status).toBe("degraded");
      expect(timedOutPastBudget.reason).toBe("preflight-budget-exceeded");
      expect(timedOutPastBudget.limit).toEqual({
        name: "hostInvoker.contextPreflightBudgetMs",
        unit: "ms",
        configured: budgetMs,
        observed: budgetMs + 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to reuse a review observation once a step has written", () => {
    const workflow = getWorkflow("review-documentation");
    const state = createSearchParticipationState();
    const observed = resolveSearchParticipation({ step: workflow.steps[0]!, state });
    expect(observed?.mode).toBe("observe");
    rememberSearchObservation(state, {
      stepId: "audit-documentation",
      observedByStepId: "audit-documentation",
      searchMode: "observe",
      planId: workflow.steps[0]!.search!.id,
      workspaceSnapshotSha256: "f".repeat(64),
      searchEvidence: searchStepEvidence({ evidenceSha256: "e".repeat(64) }),
      searchFindings: [],
      gapLedger: { ledgerSha256: "d".repeat(64) } as never,
    });
    expect(resolveSearchParticipation({ step: workflow.steps[2]!, state })?.mode).toBe("reuse");

    markAuthorizedWrite(state);
    expect(() => resolveSearchParticipation({ step: workflow.steps[2]!, state })).toThrow(
      'Workflow step "lint-documentation" cannot reuse search evidence after the workspace snapshot changed.',
    );
  });

  it("refuses a second observation of the review plan in one run", () => {
    const workflow = getWorkflow("review-documentation");
    const state = createSearchParticipationState();
    rememberSearchObservation(state, {
      stepId: "audit-documentation",
      observedByStepId: "audit-documentation",
      searchMode: "observe",
      planId: workflow.steps[0]!.search!.id,
      workspaceSnapshotSha256: "f".repeat(64),
      searchEvidence: searchStepEvidence({ evidenceSha256: "e".repeat(64) }),
      searchFindings: [],
      gapLedger: { ledgerSha256: "d".repeat(64) } as never,
    });
    expect(() => resolveSearchParticipation({ step: workflow.steps[0]!, state })).toThrow(
      `Workflow step "audit-documentation" cannot observe search plan "${documentationAuditSearch.id}" because this run already observed it.`,
    );
  });
});

/**
 * The hosted `review-documentation` path deliberately does NOT bind the
 * CLI's profile-selection-plus-validator-host seam (`application/
 * dependencies.ts`). That binding (!1379) made the locked validator's full
 * ~50-code rejection surface reachable from a live hosted job for the
 * first time, and the hosted pilot immediately hit two of those codes
 * (`hard-gate-unknown`, then a malformed-envelope rejection) that a
 * clamp-one-code-at-a-time approach (!1383) could not keep up with. This
 * reverts the bind; the pilot's own owner-directed fallback -- degrade to
 * the unbound evaluator rather than fail the run -- is now simply always
 * how this path behaves, not a fallback for a bind attempt that failed.
 */
describe("hosted review-documentation quality evaluator stays unbound", () => {
  it("never binds a quality-evaluator profile, so nothing validates or clamps the evaluator's reply", async () => {
    const fixture = await gitFixture();
    let qualityTurnText: string | undefined;
    const provider = recordingProvider([], REVIEW_STEP_IDS.length);
    // Shaped like production job 4b8fd2d0's `layer-confidence-exceeds-
    // dimensions` violation: if this path were bound, the locked validator
    // would reject an envelope with this shape outright. Unbound, this text
    // is never parsed as a structured envelope at all -- it ships as plain
    // narrative, exactly as the model wrote it.
    const violatingReply = JSON.stringify({
      evaluation: { confidence: 0.9, layers: { editorial: { confidence: 0.9, dimensions: [] } } },
      qualityScore: null,
      reportMarkdown: "# Quality report\n\nFixture report body.",
    });
    vi.stubGlobal("fetch", (async (input: unknown, init?: { body?: unknown }) => {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as { messages?: unknown }) : {};
      const rendered = JSON.stringify(body.messages ?? "");
      // "Evaluate the complete evidence package..." is this step's own base
      // prompt text (workflows/review-documentation.json), present whether
      // or not a validator is bound -- unlike the now-reverted bound
      // contract's "Runtime quality artifact response contract" text, which
      // only `bindQualityArtifactResponseContract` ever added.
      if (
        rendered.includes("Evaluate the complete evidence package") &&
        qualityTurnText === undefined
      ) {
        qualityTurnText = violatingReply;
        return sseResponse(violatingReply);
      }
      return (provider as (input: unknown, init: unknown) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch);
    const { record } = await runHostedWorkflow({
      request: reviewRequest(fixture),
      credential: "fixture-credential",
      emit: () => undefined,
    });
    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    expect(record.qualityProfileSelection).toBeUndefined();
    expect(record.qualityPack).toBeUndefined();
    expect(record.qualityArtifactValidation).toBeUndefined();
    const evaluateStep = record.steps.find((step) => step.id === "evaluate-document-quality")!;
    expect(evaluateStep.qualityValidationRejection).toBeUndefined();
    // No "Limitation: ... clamped ..." line: unbound, the model's reply is
    // never parsed as a structured envelope, so there is nothing to clamp
    // and nothing to report an adjustment for.
    expect(evaluateStep.summary).not.toMatch(/confidence clamped/u);
  }, 60_000);
});

interface GitFixture {
  repository: string;
  stateDirectory: string;
  revision: string;
  tree: string;
}

async function gitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-review-reuse-"));
  roots.push(root);
  const repository = join(root, "repository");
  const stateDirectory = join(root, "state");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "README.md"), "# Fixture\n\nSee [the guide](docs/guide.md).\n");
  await writeFile(join(repository, "docs", "guide.md"), "# Guide\n\n## Install\n\nBounded.\n");
  // A third page, so an untargeted compile is observably wider than a targeted
  // one; with two files the node counts tie.
  await writeFile(
    join(repository, "docs", "reference.md"),
    "# Reference\n\n## Options\n\nUnrelated to the guide.\n",
  );
  await exec("git", ["init", "-q"], { cwd: repository });
  await exec("git", ["config", "user.name", "DocsFab Test"], { cwd: repository });
  await exec("git", ["config", "user.email", "docsfab-test@example.invalid"], { cwd: repository });
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const revision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })
  ).stdout.trim();
  const tree = (
    await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" })
  ).stdout.trim();
  return { repository, stateDirectory, revision, tree };
}

function reviewScopeFor(paths: readonly string[]): Record<string, unknown> {
  // `scopeSha256` is self-verifying over the sealed body, so compute it here.
  const body = {
    schemaVersion: 1,
    kind: "docsfab-review-scope",
    scope: "focused-set",
    reason: "operator-named",
    targets: paths.map((path) => ({ path, reason: "operator-named" })),
    deferred: [] as { path: string; reason: string }[],
  };
  return { ...body, scopeSha256: digest(body), corpusFileCount: 2 };
}

function reviewRequest(
  fixture: GitFixture,
  reviewScope: Record<string, unknown> | null = null,
  effectiveLimitReason: ModelProfile["effectiveLimitReason"] = "composition-candidate",
): HostRuntimeRequestV1 {
  const composition = sealHostRuntimeComposition({
    compositionId: "review-reuse-fixture-v1",
    route: "nvidia-inference-api",
    credentialFamily: "nvidia-inference-api",
    executionProfile: {
      routeId: "nvidia-inference-api",
      providerId: "nvidia-inference-api",
      baseUrl: "https://example.invalid/v1",
      modelId: "model-fixture",
      transport: "openai-chat-completions",
      apiFormat: "chat_completions",
      profile: {
        configuredLimits: { contextWindow: 262144, maxInputTokens: 131072, maxOutputTokens: 2048 },
        contextWindow: 262144,
        maxInputTokens: 131072,
        maxOutputTokens: 2048,
        effectiveLimitReason,
        reasoning: false,
        input: ["text"],
        compatibility: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: false,
          apiFormats: ["chat_completions"],
        },
        costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
        metadata: {
          approvedSource: null,
          effectiveDate: null,
          reviewAfter: null,
          status: "unknown",
        },
      },
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 512 },
      compositionPolicy: { maxProviderTurns: 4, timeoutMs: 30_000, maxResponseBytes: 1_048_576 },
    },
    declaredTools: PILOT_DECLARED_TOOLS,
  });
  const selectedEvidence = [{ evidenceId: "product-model", content: "Approved product context." }];
  const receiptSha256 = "d".repeat(64);
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const content = '{"schemaVersion":1,"kind":"fixture-input"}\n';
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "deployment-test",
    projectId: "project-test",
    deploymentEpoch: "epoch-test",
    requestKey: "request-test",
    origin: { principalId: "principal-test", requestId: "request-origin" },
    runId: "run-review-reuse",
    fence: 1,
    workflow: "review-documentation",
    revision: fixture.revision,
    sourceTreeObjectId: fixture.tree,
    packet: {
      packetFingerprintSha256: "e".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: createHash("sha256").update(content).digest("hex"),
        sourcePathSha256: createHash("sha256").update("docs/input.json").digest("hex"),
        gitObjectId: "b".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
      ...(reviewScope ? { reviewScope } : {}),
    },
    stepIds: REVIEW_STEP_IDS,
    toolPolicySha256: digest({
      workflow: "review-documentation",
      stepIds: REVIEW_STEP_IDS,
      declaredTools: PILOT_DECLARED_TOOLS,
    }),
    workspacePath: fixture.repository,
    stateDirectory: fixture.stateDirectory,
    capsule: {
      sha256: digest({ receiptSha256, expiresAt, selectedEvidence }),
      receiptSha256,
      expiresAt,
      selectedEvidence,
    },
    composition,
    allowWrite: false,
  });
}

/**
 * A deterministic provider that answers each step with one text turn and
 * records its user prompt; the offline-fixture harness never renders a prompt.
 */
function recordingProvider(
  prompts: string[],
  turns: number,
  verificationPaths?: readonly string[],
): typeof fetch {
  let served = 0;
  return (async (_input: unknown, init?: { body?: unknown }) => {
    served += 1;
    if (served > turns + 2) throw new Error("unexpected deterministic provider request");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : { messages: [] };
    const rendered = (body.messages ?? [])
      .filter((message: { role: string }) => message.role === "user")
      // Unwrap rather than stringify: JSON escaping would break substring matches.
      .map((message: { content: unknown }) =>
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .map((block: unknown) =>
                  block && typeof block === "object" && "text" in block
                    ? String((block as { text: unknown }).text)
                    : JSON.stringify(block),
                )
                .join("\n")
            : JSON.stringify(message.content),
      )
      .join("\n");
    prompts.push(rendered);
    const renderedTargets = rendered.match(/Authoritative verification target: (\[[^\n]+\])/u);
    const responsePaths =
      verificationPaths ??
      (renderedTargets
        ? (JSON.parse(renderedTargets[1]!) as readonly string[])
        : ["docs/guide.md"]);
    const judgment = {
      verdict: "pass" as const,
      coverage: verificationResultFixture(responsePaths, `${responsePaths[0] ?? "README.md"}:1`)
        .coverage,
      issueJudgments: [],
      obligationJudgments: [],
    };
    const response = rendered.includes("Runtime source-obligation response contract (host-owned):")
      ? JSON.stringify(sourceObligationProposalFixture(`${responsePaths[0] ?? "README.md"}:1`))
      : rendered.includes(
            "Runtime provisional technical verification judgment contract (host-owned):",
          ) ||
          rendered.includes(
            "Runtime semantic technical-correction proposal V3 contract (host-owned):",
          )
        ? JSON.stringify(judgment)
        : rendered.includes("Runtime technical verification response contract (host-owned):")
          ? JSON.stringify(
              verificationResultFixture(responsePaths, `${responsePaths[0] ?? "README.md"}:1`),
            )
          : rendered.includes("Runtime editorial review response contract (host-owned):")
            ? JSON.stringify({ verdict: "pass", issues: [] })
            : `Deterministic evidence for turn ${served}.`;
    return sseResponse(response);
  }) as unknown as typeof fetch;
}

function sseResponse(text: string): Response {
  const chunks = [
    {
      id: "completion-text-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: "model-fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "completion-text-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: "model-fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

class RecordingHarness implements AgentHarness {
  public readonly calls: HarnessStepInput[] = [];
  public async runStep(input: HarnessStepInput): ReturnType<AgentHarness["runStep"]> {
    this.calls.push(input);
    return {
      summary: `ran ${input.step.skill}`,
      ...(await verificationFixture(input)),
    };
  }
}

class MemoryRunStore implements RunStore {
  public async save(): Promise<void> {}
}

/**
 * Drives `WorkflowRunner` with the real coordinator behind a call counter, so
 * "later steps perform no discovery" is measured, not inferred from digests.
 */
async function countDiscovery(
  fixture: GitFixture,
  workflow: ReturnType<typeof getWorkflow>,
): Promise<{ searches: number; record: RunRecord }> {
  const inner = new LocalWorkflowSearchCoordinator();
  let searches = 0;
  const counting: WorkflowSearchCoordinator = {
    async search(input) {
      searches += 1;
      return inner.search(input);
    },
  };
  const actual = workflowCatalog.getWorkflow;
  const spy = vi
    .spyOn(workflowCatalog, "getWorkflow")
    .mockImplementation(((name: Parameters<typeof actual>[0]) =>
      name === "review-documentation" ? workflow : actual(name)) as typeof actual);
  try {
    const runner = new WorkflowRunner({
      harness: new RecordingHarness(),
      hostOperations: {
        runStep: async () => ({
          summary: "fixture host check",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, cost: 0 },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        }),
      },
      store: new MemoryRunStore(),
      repositoryScanner: {
        async scan() {
          return {
            ruleSet: "review-reuse-fixture",
            status: "passed",
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [],
          };
        },
      },
      contextPreflight: {
        async preflight() {
          return { status: "unnecessary", reason: "target-not-applicable" };
        },
      },
      workflowSearch: counting,
      sourceObligationObserver: sourceObligationObserverFixture,
      id: () => "run-count-discovery",
    });
    const record = await runner.run({
      workflow: "review-documentation",
      workspacePath: fixture.repository,
      repository: {
        sourcePath: fixture.repository,
        requestedRevision: fixture.revision,
        revision: fixture.revision,
      },
      allowWrite: false,
    });
    return { searches, record };
  } finally {
    (spy as unknown as { mockRestore(): void }).mockRestore();
  }
}

/**
 * Runs step 1's observation as the hosted runner does and returns the identity
 * later steps would inherit.
 */
async function observeInventory(
  fixture: GitFixture,
): Promise<{ workspaceSnapshotSha256: string; evidenceSha256: string }> {
  const workflow = getWorkflow("review-documentation");
  const step = workflow.steps[0]!;
  const repository = {
    sourcePath: fixture.repository,
    requestedRevision: fixture.revision,
    revision: fixture.revision,
  };
  const result = await new LocalWorkflowSearchCoordinator().search({
    runId: "observe-inventory",
    repositoryPath: fixture.repository,
    repository,
    workflow,
    step,
    plan: step.search!,
  });
  const evidence = normalizeWorkflowSearchEvidence({
    plan: step.search!,
    repository,
    repositoryIdentitySha256: result.repositoryIdentitySha256,
    searches: result.searches,
    ...(result.workspaceSnapshotSha256
      ? { workspaceSnapshotSha256: result.workspaceSnapshotSha256 }
      : {}),
  });
  return {
    workspaceSnapshotSha256: evidence.workspaceSnapshotSha256,
    evidenceSha256: evidence.evidenceSha256,
  };
}

/**
 * A fallback must survive the real trip: `preflightContext` normalizes it into
 * the step record, then the repo's canonical decoder reads it.
 */
async function expectDecodableRecord(
  service: ReturnType<typeof createHostedContextPreflightService>,
  input: ContextPreflightInput,
): Promise<void> {
  const { evidence } = await preflightContext({ contextPreflight: service, ...input });
  expect(evidence.status).toBe("degraded");
  expect(() => decodeContextPreflight(evidence)).not.toThrow();
}
