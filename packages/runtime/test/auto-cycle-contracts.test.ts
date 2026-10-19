// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import type { WorkflowTaskInput } from "../src/workflow-contracts/contracts.js";
import * as autonomyPublicApi from "../src/autonomy/index.js";
import * as autonomyContracts from "../src/autonomy/contracts.js";
import { createAutoCycleRequest as createAutoCycleRequestWithWorkflowAccess } from "../src/autonomy/contracts.js";
import * as workflowCatalog from "../src/workflow-registry/catalog.js";

import {
  AUTO_CYCLE_MIGRATION_POLICY,
  AutoCycleContractError,
  assertAutoCycleAuthorized,
  assertAutoCycleExecutionTask,
  createAutoAssessment,
  createAutoCycleAuthorization,
  createAutoCycleCheckpoint,
  createAutoCycleRequest,
  createAutoCycleTerminalResult,
  createAutoWorkflowTaskBinding,
  createWorkflowCandidate,
  createWorkflowDecision,
  decodeAutoAssessment,
  decodeAutoCycleAuthorization,
  decodeAutoCycleCheckpoint,
  decodeAutoCycleRequest,
  decodeAutoCycleTerminalResult,
  decodeWorkflowCandidate,
  decodeWorkflowDecision,
  migrateAutoCycleCheckpoint,
  migrateAutoCycleAuthorization,
  migrateAutoCycleTerminalResult,
  migrateAutoCycleRequest,
  migrateAutoAssessment,
  migrateWorkflowCandidate,
  migrateWorkflowDecision,
  mintAutoCycleHostCapability,
  projectAutoCycleAuthorization,
  validateAutoCycleCheckpointChain,
  type AutoAssessmentV1,
  type AutoCycleRequestInputV1,
  type AutoCycleRequestV1,
  type AutoMaturityFindingReferenceV1,
  type WorkflowCandidateInputV1,
  type WorkflowCandidateV1,
  type WorkflowDecisionV1,
} from "./support/autonomy-contracts.js";
import { internalCreateAutoCycleHostAuthority } from "../src/autonomy/authority-internal.js";
import { configureCredential } from "./helpers/configured-credential.js";
import {
  WorkflowTaskValidationError,
  validateWorkflowRunRequestTask,
} from "../src/workflow-contracts/task.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/auto-cycle-v1.json", import.meta.url), "utf8"),
) as {
  request: AutoCycleRequestInputV1;
  task: WorkflowTaskInput;
  finding: AutoMaturityFindingReferenceV1;
  candidate: WorkflowCandidateInputV1;
  authorizationWindow: { authorizedAt: string; expiresAt: string };
  execution: {
    runId: string;
    recordSha256: string;
    validationId: string;
    validationEvidenceSha256: string;
    completedAt: string;
  };
};
const SHA = (character: string) => character.repeat(64);

describe("harness-neutral autonomous-cycle contracts", () => {
  it("uses caller-supplied workflow access to validate request bounds", () => {
    const checkedNames: string[] = [];
    const request = createAutoCycleRequestWithWorkflowAccess(fixture.request, {
      getWorkflow: workflowCatalog.getWorkflow,
      isRunnableWorkflowName(value) {
        checkedNames.push(value);
        return value === "update-documentation";
      },
    });

    expect(request.bounds.workflowNames).toEqual(["update-documentation"]);
    expect(checkedNames).toContain("update-documentation");
  });

  it("consumes fake workflow definitions through candidates, nested evidence, and authorization", async () => {
    const workflows = fakeWorkflowAccess();
    const requestInput = structuredClone(fixture.request);
    const candidateInputValue = candidateInput();
    expectError(
      () =>
        autonomyContracts.createWorkflowCandidate(
          { ...candidateInputValue, workflow: "review-documentation" },
          autonomyContracts.createAutoCycleRequest(requestInput, workflows),
          workflows,
        ),
      "workflow-not-registered",
    );
    expectError(
      () =>
        autonomyContracts.createWorkflowCandidate(
          candidateInputValue,
          autonomyContracts.createAutoCycleRequest(requestInput, workflows),
          workflows,
        ),
      "workflow-not-registered",
    );
    candidateInputValue.stepIds = workflows
      .getWorkflow("update-documentation")
      .steps.map((step) => step.id);
    const request = autonomyContracts.createAutoCycleRequest(requestInput, workflows);
    const candidate = autonomyContracts.createWorkflowCandidate(
      candidateInputValue,
      request,
      workflows,
    );
    expect(candidate.stepIds).toEqual(candidateInputValue.stepIds);
    expect(autonomyContracts.decodeWorkflowCandidate(json(candidate), request, workflows)).toEqual(
      candidate,
    );

    const assessment = autonomyContracts.createAutoAssessment(
      {
        ...assessmentInput(request),
        candidates: [stripCandidate(candidate)],
      },
      request,
      workflows,
    );
    const decision = autonomyContracts.createWorkflowDecision(
      {
        disposition: "execute",
        candidateSha256: candidate.candidateSha256,
        reasonCode: "eligible-candidate-selected",
      },
      request,
      assessment,
      workflows,
    );
    const capability = await autonomyContracts.mintAutoCycleHostCapability(
      { request, assessment, decision },
      internalCreateAutoCycleHostAuthority(
        currentHostVerifier({ value: fixture.authorizationWindow.authorizedAt }),
      ),
      workflows,
    );
    const authorization = autonomyContracts.createAutoCycleAuthorization(
      fixture.authorizationWindow,
      capability,
    );
    const initial = autonomyContracts.createAutoCycleCheckpoint({
      cycleId: request.cycleId,
      sequence: 0,
      phase: "assessing",
      requestSha256: request.requestSha256,
      assessmentSha256: null,
      decisionSha256: null,
      authorizationSha256: null,
      workflowExecutionStatus: null,
      previousCheckpointSha256: null,
    });
    const executing = autonomyContracts.createAutoCycleCheckpoint({
      cycleId: request.cycleId,
      sequence: 1,
      phase: "executing",
      requestSha256: request.requestSha256,
      assessmentSha256: assessment.assessmentSha256,
      decisionSha256: decision.decisionSha256,
      authorizationSha256: authorization.authorizationSha256,
      workflowExecutionStatus: "succeeded",
      previousCheckpointSha256: initial.checkpointSha256,
    });
    const run = {
      id: "run:fake-definition",
      recordSha256: fixture.execution.recordSha256,
      workflow: "update-documentation" as const,
      repository: request.repository,
      taskSha256: candidate.taskSha256,
      status: "succeeded" as const,
    };
    const evidence = { authorization, checkpoints: [initial, executing], run };
    const terminal = autonomyContracts.createAutoCycleTerminalResult(
      {
        cycleId: request.cycleId,
        requestSha256: request.requestSha256,
        assessmentSha256: assessment.assessmentSha256,
        decisionSha256: decision.decisionSha256,
        decisionDisposition: "execute",
        authorizationSha256: authorization.authorizationSha256,
        workflowExecutionStatus: "succeeded",
        runRecordSha256: run.recordSha256,
        runEvidenceSha256: canonicalDigest(run),
        finalCheckpointSha256: executing.checkpointSha256,
        validation: [
          {
            id: fixture.execution.validationId,
            status: "passed",
            evidenceSha256: fixture.execution.validationEvidenceSha256,
          },
        ],
        completedAt: fixture.execution.completedAt,
      },
      request,
      assessment,
      decision,
      evidence,
      workflows,
    );
    expect(
      autonomyContracts.decodeAutoCycleTerminalResult(
        json(terminal),
        request,
        assessment,
        decision,
        evidence,
        workflows,
      ),
    ).toEqual(terminal);

    const resolverB = fakeWorkflowAccess();
    await expectErrorAsync(
      () =>
        autonomyContracts.assertAutoCycleAuthorized(
          authorization,
          capability,
          fixture.task,
          resolverB,
        ),
      "authorization-required",
    );
  });

  it("round-trips the complete execute chain and keeps persisted authorization inert", async () => {
    const chain = executeChain();
    expect(
      Object.keys(autonomyPublicApi).some(
        (name) => name.startsWith("internal") || name.includes("HostAuthority"),
      ),
    ).toBe(false);
    await expectErrorAsync(
      () => mintAutoCycleHostCapability(capabilityInput(chain), undefined as never),
      "authorization-required",
    );
    await expectErrorAsync(
      () =>
        mintAutoCycleHostCapability(capabilityInput(chain), {
          async verifyCurrent() {
            return {
              status: "current",
              challengeSha256: SHA("0"),
              observedAt: fixture.authorizationWindow.authorizedAt,
            };
          },
        } as never),
      "authorization-required",
    );
    expect(decodeAutoCycleRequest(json(chain.request))).toEqual(chain.request);
    expect(decodeWorkflowCandidate(json(chain.candidate), chain.request)).toEqual(chain.candidate);
    expect(decodeAutoAssessment(json(chain.assessment), chain.request)).toEqual(chain.assessment);
    expect(decodeWorkflowDecision(json(chain.decision), chain.request, chain.assessment)).toEqual(
      chain.decision,
    );

    let currentChecks = 0;
    const clock = { value: fixture.authorizationWindow.authorizedAt };
    const capability = await mintAutoCycleHostCapability(
      {
        request: chain.request,
        assessment: chain.assessment,
        decision: chain.decision,
      },
      internalCreateAutoCycleHostAuthority(currentHostVerifier(clock, () => (currentChecks += 1))),
    );
    expect(currentChecks).toBe(1);
    const authorization = createAutoCycleAuthorization(
      {
        ...fixture.authorizationWindow,
      },
      capability,
    );
    const persisted = decodeAutoCycleAuthorization(json(authorization));
    expect(persisted).toEqual(authorization);
    clock.value = "2026-08-05T12:02:00.000Z";
    await expect(assertAutoCycleAuthorized(persisted, capability, fixture.task)).resolves.toEqual(
      authorization,
    );
    expect(currentChecks).toBe(2);
    expect(migrateWorkflowCandidate(json(chain.candidate), chain.request)).toEqual(chain.candidate);
    expect(migrateAutoAssessment(json(chain.assessment), chain.request)).toEqual(chain.assessment);
    expect(migrateWorkflowDecision(json(chain.decision), chain.request, chain.assessment)).toEqual(
      chain.decision,
    );
    expect(migrateAutoCycleAuthorization(json(authorization))).toEqual(authorization);

    const lookalike = { kind: "docsfab-auto-cycle-host-capability" } as const;
    await expectErrorAsync(
      () => assertAutoCycleAuthorized(persisted, lookalike, fixture.task),
      "authorization-required",
    );
    expectError(
      () =>
        createAutoCycleAuthorization(
          {
            authorizedAt: "2026-08-05T12:01:00.000Z",
            expiresAt: "2026-08-05T12:06:00.000Z",
          },
          lookalike,
        ),
      "authorization-required",
    );

    const rehashedLookalike = structuredClone(authorization);
    rehashedLookalike.targetBranch = "codex/rehashed-lookalike";
    const { authorizationSha256: _oldDigest, ...rehashedBody } = rehashedLookalike;
    rehashedLookalike.authorizationSha256 = canonicalDigest(rehashedBody);
    expect(decodeAutoCycleAuthorization(rehashedLookalike)).toEqual(rehashedLookalike);
    await expectErrorAsync(
      () => assertAutoCycleAuthorized(rehashedLookalike, capability, fixture.task),
      "authorization-required",
    );

    const rewrittenWindow = structuredClone(authorization);
    rewrittenWindow.authorizedAt = "2026-08-05T13:01:00.000Z";
    rewrittenWindow.expiresAt = "2026-08-05T13:06:00.000Z";
    const { authorizationSha256: _issuedDigest, ...rewrittenBody } = rewrittenWindow;
    rewrittenWindow.authorizationSha256 = canonicalDigest(rewrittenBody);
    expect(decodeAutoCycleAuthorization(rewrittenWindow)).toEqual(rewrittenWindow);
    await expectErrorAsync(
      () => assertAutoCycleAuthorized(rewrittenWindow, capability, fixture.task),
      "authorization-required",
    );

    clock.value = fixture.authorizationWindow.expiresAt;
    await expectErrorAsync(
      () => assertAutoCycleAuthorized(authorization, capability, fixture.task),
      "authorization-expired",
    );

    const projection = projectAutoCycleAuthorization(persisted);
    expect(projection.pathPrefixSha256s).toHaveLength(1);
    expect(projection.pathPrefixSha256s).toEqual([canonicalDigest("docs")]);
    expect(projection.targetBranchSha256).toBe(canonicalDigest("codex/fixture"));
    expect(projection).not.toHaveProperty("pathPrefixes");
    expect(projection).not.toHaveProperty("targetBranch");
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("allows only catalog workflows and refuses path, branch, delivery, or tracker expansion", () => {
    const request = requestFixture();
    expectError(
      () =>
        createWorkflowCandidate(
          {
            ...candidateInput(),
            workflow: "model-invented-workflow" as "update-documentation",
          },
          request,
        ),
      "workflow-not-registered",
    );
    expectError(
      () =>
        createWorkflowCandidate(
          {
            ...candidateInput(),
            workflow: "toString" as "update-documentation",
          },
          request,
        ),
      "workflow-not-registered",
    );
    expectError(
      () =>
        createWorkflowCandidate(
          {
            ...candidateInput(),
            pathPrefixes: ["src"],
          },
          request,
        ),
      "scope-expansion",
    );
    expectError(
      () =>
        createWorkflowCandidate(
          {
            ...candidateInput(),
            deliveryMode: "local-user-gitlab",
          },
          request,
        ),
      "scope-expansion",
    );
    expectError(
      () =>
        createWorkflowCandidate(
          {
            ...candidateInput(),
            validationIds: ["docs-build", "caller-added-validation"],
          },
          request,
        ),
      "scope-expansion",
    );
    expectError(
      () =>
        createWorkflowCandidate(
          {
            ...candidateInput(),
            prerequisites: [],
          },
          request,
        ),
      "prerequisite-unsatisfied",
    );
    expectError(
      () =>
        createWorkflowCandidate(
          {
            ...candidateInput(),
            taskSha256: SHA("e"),
          },
          request,
        ),
      "scope-expansion",
    );
    expectError(
      () =>
        createAutoCycleRequest({
          ...fixture.request,
          tracker: { ...fixture.request.tracker, authority: "tracker-write" as never },
        }),
      "invalid-value",
    );

    const differentTracker = structuredClone(fixture.request);
    differentTracker.tracker.observationSha256 = SHA("9");
    const otherRequest = createAutoCycleRequest(differentTracker);
    expectError(
      () =>
        createAutoAssessment(
          {
            ...assessmentInput(request),
            trackerObservationSha256: otherRequest.tracker.observationSha256,
          },
          request,
        ),
      "scope-expansion",
    );

    const expanded = structuredClone(request);
    expanded.bounds.targetBranch = "main";
    expectError(() => decodeAutoCycleRequest(expanded), "digest-mismatch");
    assertAutoCycleExecutionTask(
      createWorkflowCandidate(candidateInput(), request),
      request,
      fixture.task,
    );
    const changedTask = structuredClone(fixture.task) as Extract<
      WorkflowTaskInput,
      { kind: "bounded-doc-improvement" }
    >;
    changedTask.campaignId = "campaign:changed";
    expectError(
      () =>
        assertAutoCycleExecutionTask(
          createWorkflowCandidate(candidateInput(), request),
          request,
          changedTask,
        ),
      "scope-expansion",
    );
  });

  it("uses the WorkflowRunner's exact canonical task validator for autonomy bindings", () => {
    expect(fixture.task.kind).toBe("bounded-doc-improvement");
    if (fixture.task.kind !== "bounded-doc-improvement") throw new Error("fixture task kind");
    expect(fixture.task.repositoryId).toBe("group/project");
    expect(fixture.task.analysis.approvedOutcomeSha256).toBe(
      canonicalDigest(fixture.task.analysis.approvedProposal),
    );
    const runnerRequest = {
      workflow: "update-documentation" as const,
      workspacePath: "/fixture/workspace",
      repository: {
        sourcePath: "/fixture/repository",
        requestedRevision: "main",
        revision: fixture.request.repository.revision,
      },
      task: fixture.task,
      allowWrite: true,
    };
    const normalized = validateWorkflowRunRequestTask(runnerRequest);
    expect(canonicalDigest(normalized)).toBe(fixture.candidate.taskSha256);
    expect(
      createAutoWorkflowTaskBinding(
        "update-documentation",
        fixture.task,
        fixture.request.repository,
      ).taskSha256,
    ).toBe(fixture.candidate.taskSha256);

    for (const invalidTask of [
      { ...structuredClone(fixture.task), repositoryId: "repository:fixture" },
      {
        ...structuredClone(fixture.task),
        analysis: {
          ...structuredClone(fixture.task.analysis),
          approvedOutcomeSha256: SHA("9"),
        },
      },
    ] as WorkflowTaskInput[]) {
      expect(() =>
        validateWorkflowRunRequestTask({
          ...runnerRequest,
          task: invalidTask,
        }),
      ).toThrow(WorkflowTaskValidationError);
      expectError(
        () =>
          createAutoWorkflowTaskBinding(
            "update-documentation",
            invalidTask,
            fixture.request.repository,
          ),
        "invalid-value",
      );
    }
  });

  it("rejects a sufficient assessment before execute when a prerequisite is missing", () => {
    const request = requestFixture();
    const missing = createWorkflowCandidate(
      {
        ...candidateInput(),
        prerequisites: [{ id: "audit-complete", state: "missing", evidenceSha256s: [] }],
      },
      request,
    );
    expectError(
      () =>
        createAutoAssessment(
          {
            ...assessmentInput(request),
            candidates: [stripCandidate(missing)],
          },
          request,
        ),
      "decision-conflict",
    );
  });

  it("turns low-confidence and conflicting evidence into needs-input, never arbitrary execute", () => {
    for (const evidenceState of ["low-confidence", "conflicting"] as const) {
      const request = requestFixture();
      const assessment = createAutoAssessment(
        {
          ...assessmentInput(request),
          evidenceState,
          openInputIds: ["input:owner"],
        },
        request,
      );
      const candidate = assessment.candidates[0]!;
      expectError(
        () =>
          createWorkflowDecision(
            {
              disposition: "execute",
              candidateSha256: candidate.candidateSha256,
              reasonCode: "eligible-candidate-selected",
            },
            request,
            assessment,
          ),
        "decision-conflict",
      );
      const decision = createWorkflowDecision(
        {
          disposition: "needs-input",
          reasonCode: "evidence-needs-input",
          openInputIds: ["input:owner"],
        },
        request,
        assessment,
      );
      expect(decision.disposition).toBe("needs-input");
      expect(decision.workflow).toBeNull();
    }
  });

  it("rejects a sufficient label over uncertain maturity evidence", () => {
    const request = requestFixture();
    expectError(
      () =>
        createAutoAssessment(
          {
            ...assessmentInput(request),
            maturityFindings: [
              {
                ...fixture.finding,
                confidence: "inconclusive",
                disposition: "unknown",
              },
            ],
            evidenceState: "sufficient",
          },
          request,
        ),
      "decision-conflict",
    );
  });

  it("keeps all non-execute product outcomes separate from execution status", () => {
    const noAction = nonExecuteChain("no-action", "nothing-eligible", "sufficient");
    const decided = createAutoCycleCheckpoint({
      cycleId: noAction.request.cycleId,
      sequence: 0,
      phase: "decided",
      requestSha256: noAction.request.requestSha256,
      assessmentSha256: noAction.assessment.assessmentSha256,
      decisionSha256: noAction.decision.decisionSha256,
      authorizationSha256: null,
      workflowExecutionStatus: null,
      previousCheckpointSha256: null,
    });
    const terminalEvidence = { authorization: null, checkpoints: [decided], run: null };
    const noActionResult = createAutoCycleTerminalResult(
      {
        cycleId: noAction.request.cycleId,
        requestSha256: noAction.request.requestSha256,
        assessmentSha256: noAction.assessment.assessmentSha256,
        decisionSha256: noAction.decision.decisionSha256,
        decisionDisposition: "no-action",
        authorizationSha256: null,
        workflowExecutionStatus: "not-run",
        runRecordSha256: null,
        runEvidenceSha256: null,
        finalCheckpointSha256: decided.checkpointSha256,
        validation: [],
        completedAt: "2026-08-05T12:02:00.000Z",
      },
      noAction.request,
      noAction.assessment,
      noAction.decision,
      terminalEvidence,
    );
    expect(
      decodeAutoCycleTerminalResult(
        json(noActionResult),
        noAction.request,
        noAction.assessment,
        noAction.decision,
        terminalEvidence,
      ),
    ).toEqual(noActionResult);

    expectError(
      () =>
        createAutoCycleTerminalResult(
          {
            ...noActionResult,
            workflowExecutionStatus: "succeeded",
            runRecordSha256: SHA("8"),
          },
          noAction.request,
          noAction.assessment,
          noAction.decision,
          terminalEvidence,
        ),
      "invalid-shape",
    );

    const blocked = nonExecuteChain("blocked", "dependency-blocked", "blocked");
    expect(blocked.decision.disposition).toBe("blocked");
    const superseded = nonExecuteChain(
      "superseded",
      "new-request-observed",
      "sufficient",
      SHA("7"),
    );
    expect(superseded.decision.supersedingRequestSha256).toBe(SHA("7"));
  });

  it("round-trips resumable checkpoints and terminal execution results without capability state", async () => {
    const chain = executeChain();
    const capability = await mintAutoCycleHostCapability(
      capabilityInput(chain),
      internalCreateAutoCycleHostAuthority(
        currentHostVerifier({
          value: fixture.authorizationWindow.authorizedAt,
        }),
      ),
    );
    const authorization = createAutoCycleAuthorization(
      {
        ...fixture.authorizationWindow,
      },
      capability,
    );
    const initial = createAutoCycleCheckpoint({
      cycleId: chain.request.cycleId,
      sequence: 0,
      phase: "assessing",
      requestSha256: chain.request.requestSha256,
      assessmentSha256: null,
      decisionSha256: null,
      authorizationSha256: null,
      workflowExecutionStatus: null,
      previousCheckpointSha256: null,
    });
    const checkpoint = createAutoCycleCheckpoint({
      cycleId: chain.request.cycleId,
      sequence: 1,
      phase: "executing",
      requestSha256: chain.request.requestSha256,
      assessmentSha256: chain.assessment.assessmentSha256,
      decisionSha256: chain.decision.decisionSha256,
      authorizationSha256: authorization.authorizationSha256,
      workflowExecutionStatus: "running",
      previousCheckpointSha256: initial.checkpointSha256,
    });
    expect(decodeAutoCycleCheckpoint(json(checkpoint))).toEqual(checkpoint);
    expect(migrateAutoCycleCheckpoint(json(checkpoint))).toEqual(checkpoint);
    expect(validateAutoCycleCheckpointChain([json(initial), json(checkpoint)])).toEqual([
      initial,
      checkpoint,
    ]);
    expectError(
      () => validateAutoCycleCheckpointChain([initial, { ...checkpoint, sequence: 2 }]),
      "digest-mismatch",
    );
    const swappedDecision = createAutoCycleCheckpoint({
      ...checkpointInput(checkpoint),
      sequence: 2,
      decisionSha256: SHA("f"),
      previousCheckpointSha256: checkpoint.checkpointSha256,
    });
    expectError(
      () => validateAutoCycleCheckpointChain([initial, checkpoint, swappedDecision]),
      "invalid-value",
    );
    expectError(
      () =>
        createAutoCycleAuthorization(
          {
            authorizedAt: "2026-08-05T12:01:00.000Z",
            expiresAt: "2026-08-05T12:06:00.000Z",
          },
          checkpoint as never,
        ),
      "authorization-required",
    );

    const finalCheckpoint = createAutoCycleCheckpoint({
      ...checkpointInput(checkpoint),
      sequence: 2,
      workflowExecutionStatus: "succeeded",
      previousCheckpointSha256: checkpoint.checkpointSha256,
    });
    const regressedStatus = createAutoCycleCheckpoint({
      ...checkpointInput(finalCheckpoint),
      sequence: 3,
      workflowExecutionStatus: "running",
      previousCheckpointSha256: finalCheckpoint.checkpointSha256,
    });
    expectError(
      () =>
        validateAutoCycleCheckpointChain([initial, checkpoint, finalCheckpoint, regressedStatus]),
      "invalid-value",
    );
    const run = {
      id: fixture.execution.runId,
      recordSha256: fixture.execution.recordSha256,
      workflow: "update-documentation" as const,
      repository: chain.request.repository,
      taskSha256: chain.candidate.taskSha256,
      status: "succeeded" as const,
    };
    const terminalEvidence = {
      authorization,
      checkpoints: [initial, checkpoint, finalCheckpoint],
      run,
    };

    const result = createAutoCycleTerminalResult(
      {
        cycleId: chain.request.cycleId,
        requestSha256: chain.request.requestSha256,
        assessmentSha256: chain.assessment.assessmentSha256,
        decisionSha256: chain.decision.decisionSha256,
        decisionDisposition: "execute",
        authorizationSha256: authorization.authorizationSha256,
        workflowExecutionStatus: "succeeded",
        runRecordSha256: fixture.execution.recordSha256,
        runEvidenceSha256: canonicalDigest(run),
        finalCheckpointSha256: finalCheckpoint.checkpointSha256,
        validation: [
          {
            id: fixture.execution.validationId,
            status: "passed",
            evidenceSha256: fixture.execution.validationEvidenceSha256,
          },
        ],
        completedAt: fixture.execution.completedAt,
      },
      chain.request,
      chain.assessment,
      chain.decision,
      terminalEvidence,
    );
    expect(
      decodeAutoCycleTerminalResult(
        json(result),
        chain.request,
        chain.assessment,
        chain.decision,
        terminalEvidence,
      ),
    ).toEqual(result);
    expect(
      migrateAutoCycleTerminalResult(
        json(result),
        chain.request,
        chain.assessment,
        chain.decision,
        terminalEvidence,
      ),
    ).toEqual(result);

    expectError(
      () =>
        createAutoCycleTerminalResult(
          {
            ...terminalInput(result),
            validation: [{ id: "docs-build", status: "failed", evidenceSha256: SHA("9") }],
          },
          chain.request,
          chain.assessment,
          chain.decision,
          terminalEvidence,
        ),
      "decision-conflict",
    );
    const wrongRun = { ...run, taskSha256: SHA("e") };
    expectError(
      () =>
        createAutoCycleTerminalResult(
          {
            ...terminalInput(result),
            runEvidenceSha256: canonicalDigest(wrongRun),
          },
          chain.request,
          chain.assessment,
          chain.decision,
          {
            ...terminalEvidence,
            run: wrongRun,
          },
        ),
      "decision-conflict",
    );
    expectError(
      () =>
        createAutoCycleTerminalResult(
          {
            ...terminalInput(result),
            finalCheckpointSha256: checkpoint.checkpointSha256,
          },
          chain.request,
          chain.assessment,
          chain.decision,
          terminalEvidence,
        ),
      "decision-conflict",
    );
  });

  it("publishes identity-only v1 migration and rejects unknown versions and credentials", () => {
    const request = requestFixture();
    expect(AUTO_CYCLE_MIGRATION_POLICY.acceptedSourceVersions).toEqual([1]);
    expect(migrateAutoCycleRequest(json(request))).toEqual(request);
    expectError(
      () => migrateAutoCycleRequest({ ...request, schemaVersion: 2 }),
      "migration-required",
    );

    const credential = structuredClone(fixture.request);
    credential.bounds.targetBranch = "token/glpat-abcdefghijklmnopqrst";
    // A credential shape alone is a branch name (#1807). The same name is
    // refused once its token is one of DocsFab's own configured credentials.
    expect(createAutoCycleRequest(credential).bounds.targetBranch).toBe(
      credential.bounds.targetBranch,
    );
    configureCredential(credential.bounds.targetBranch.slice("token/".length));
    expectError(() => createAutoCycleRequest(credential), "invalid-value");

    const extra = { ...request, piSessionId: "pi-is-not-part-of-the-contract" };
    expectError(() => decodeAutoCycleRequest(extra), "invalid-shape");
    const chain = executeChain();
    expectError(
      () =>
        createWorkflowDecision(
          {
            disposition: "execute",
            candidateSha256: chain.candidate.candidateSha256,
            reasonCode: "eligible-candidate-selected",
            extraAuthority: SHA("f"),
          } as never,
          chain.request,
          chain.assessment,
        ),
      "invalid-shape",
    );
    const accessorDecision = structuredClone(chain.decision);
    Object.defineProperty(accessorDecision, "reasonCode", {
      enumerable: true,
      get: () => "eligible-candidate-selected",
    });
    expectError(
      () => decodeWorkflowDecision(accessorDecision, chain.request, chain.assessment),
      "invalid-shape",
    );
    expectError(
      () =>
        decodeWorkflowDecision(
          new Proxy(structuredClone(chain.decision), {}),
          chain.request,
          chain.assessment,
        ),
      "invalid-shape",
    );
    const sparseDecision = structuredClone(chain.decision);
    sparseDecision.openInputIds = new Array<string>(1);
    expectError(
      () => decodeWorkflowDecision(sparseDecision, chain.request, chain.assessment),
      "invalid-shape",
    );
    expect(JSON.stringify(request)).not.toContain("sourcePath");
    expect(JSON.stringify(request)).not.toContain("credential");
  });
});

function requestFixture(): AutoCycleRequestV1 {
  const binding = createAutoWorkflowTaskBinding(
    "update-documentation",
    fixture.task,
    fixture.request.repository,
  );
  expect(binding.taskSha256).toBe(fixture.candidate.taskSha256);
  return createAutoCycleRequest(fixture.request);
}

function candidateInput(): WorkflowCandidateInputV1 {
  return structuredClone(fixture.candidate);
}

function assessmentInput(request: AutoCycleRequestV1) {
  return {
    requestSha256: request.requestSha256,
    repository: request.repository,
    trackerObservationSha256: request.tracker.observationSha256,
    evidenceState: "sufficient" as const,
    maturityFindings: [fixture.finding],
    candidates: [candidateInput()],
    openInputIds: [],
  };
}

function executeChain(): {
  request: AutoCycleRequestV1;
  candidate: WorkflowCandidateV1;
  assessment: AutoAssessmentV1;
  decision: WorkflowDecisionV1;
} {
  const request = requestFixture();
  const candidate = createWorkflowCandidate(candidateInput(), request);
  const assessment = createAutoAssessment(
    {
      ...assessmentInput(request),
      candidates: [stripCandidate(candidate)],
    },
    request,
  );
  const decision = createWorkflowDecision(
    {
      disposition: "execute",
      candidateSha256: candidate.candidateSha256,
      reasonCode: "eligible-candidate-selected",
    },
    request,
    assessment,
  );
  return { request, candidate, assessment, decision };
}

function stripCandidate(value: WorkflowCandidateV1): WorkflowCandidateInputV1 {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    candidateSha256: _candidateSha256,
    ...candidate
  } = value;
  return candidate;
}

function checkpointInput(value: ReturnType<typeof createAutoCycleCheckpoint>) {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    checkpointSha256: _checkpointSha256,
    ...input
  } = value;
  return input;
}

function terminalInput(value: ReturnType<typeof createAutoCycleTerminalResult>) {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    terminalResultSha256: _terminalResultSha256,
    ...input
  } = value;
  return input;
}

function capabilityInput(chain: ReturnType<typeof executeChain>) {
  return {
    request: chain.request,
    assessment: chain.assessment,
    decision: chain.decision,
  };
}

function nonExecuteChain(
  disposition: "no-action" | "blocked" | "superseded",
  reasonCode: string,
  evidenceState: "sufficient" | "blocked",
  superseding?: string,
) {
  const request = requestFixture();
  const assessment = createAutoAssessment(
    {
      ...assessmentInput(request),
      evidenceState,
      candidates:
        disposition === "no-action" || disposition === "superseded"
          ? []
          : [
              {
                ...candidateInput(),
                prerequisites: [
                  {
                    id: "audit-complete",
                    state: "blocked" as const,
                    evidenceSha256s: [SHA("a")],
                  },
                ],
              },
            ],
    },
    request,
  );
  const decision = createWorkflowDecision(
    {
      disposition,
      reasonCode,
      ...(superseding ? { supersedingRequestSha256: superseding } : {}),
    },
    request,
    assessment,
  );
  return { request, assessment, decision };
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectError(run: () => unknown, code: AutoCycleContractError["code"]): void {
  try {
    run();
    throw new Error("Expected autonomous-cycle contract failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AutoCycleContractError);
    expect((error as AutoCycleContractError).code).toBe(code);
  }
}

async function expectErrorAsync(
  run: () => Promise<unknown>,
  code: AutoCycleContractError["code"],
): Promise<void> {
  try {
    await run();
    throw new Error("Expected autonomous-cycle contract failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AutoCycleContractError);
    expect((error as AutoCycleContractError).code).toBe(code);
  }
}

function currentHostVerifier(clock: { value: string }, onVerify: () => void = () => undefined) {
  return {
    async verifyCurrent(challenge: { challengeSha256: string }) {
      onVerify();
      return {
        status: "current" as const,
        challengeSha256: challenge.challengeSha256,
        observedAt: clock.value,
      };
    },
  };
}

function fakeWorkflowAccess() {
  const definition = structuredClone(workflowCatalog.getWorkflow("update-documentation"));
  definition.steps = definition.steps.map((step, index) => ({
    ...step,
    id: `fake-update-step-${index}`,
  }));
  return {
    isRunnableWorkflowName(value: string): value is "update-documentation" {
      return value === "update-documentation";
    },
    getWorkflow(name: "update-documentation") {
      if (name !== "update-documentation") throw new Error("workflow excluded");
      return definition;
    },
  };
}
