// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Actual Foundation → authoring/review → impact → scoped patch composition. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest } from "../contract-kit/index.js";
import { canonicalJson, buildContentIndex } from "../content-ir/index.js";
import { DurableArtifactStore } from "../artifacts/store.js";
import type { FoundationInspectResultV1 } from "../foundation/inspect.js";
import {
  createFoundationToPatchAuthorization,
  FoundationToPatchHostOperation,
  FoundationToPatchWorkflowOutcomeProjector,
  FOUNDATION_TO_PATCH_CATALOG_SKILLS as skills,
  runFoundationToPatch,
  type FoundationToPatchRunResultV1,
} from "../foundation/to-patch.js";
import { LocalImpactPostflightService } from "../impact/postflight.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { CatalogSkillCrateResolver } from "../skills/catalog-crate-resolver.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import {
  decodeAdmittedVerificationSummary,
  decodeEditorialReviewResponse,
} from "../workflow-execution/review-response.js";
import { validateAuthoringRunRecordV1 } from "../records/authoring-execution.js";
import type { RunRecord } from "../records/contracts.js";
import { workflowOutcomeStepEvidence } from "../workflow-contracts/outcome.js";
import type { HostRuntimeRequestV1 } from "./contracts.js";
import { withinWriteCeiling } from "./wire-decode.js";
import { runTrustedGit } from "./trusted-git.js";
import { createHostedNativeCandidate } from "./native-candidate.js";
import type { NativeAuthoringExecutor, NativeAuthoringOutcome } from "./native-authoring.js";
import type { HostedNativeOperationAssembly } from "./native-operations.js";

export async function assembleHostedFoundationToPatch(input: {
  request: HostRuntimeRequestV1;
  workspace: RepositoryWorkspace;
  inspect: () => Promise<FoundationInspectResultV1>;
  runAuthoring: NativeAuthoringExecutor;
  signal?: AbortSignal;
}): Promise<HostedNativeOperationAssembly> {
  const { request, workspace } = input;
  const nativeTask = request.packet.nativeTask,
    grant = request.writeAuthority;
  // Through the wire, only `inputs.length !== 0` is reachable: this composition
  // consumes canon and approved model through custody, so an input package
  // would be silently ignored. The caller arm, `parseHostRuntimeRequest`, and
  // the runner enforce the rest; they stay as defence for in-process callers.
  if (
    request.workflow !== "foundation-to-patch" ||
    nativeTask?.task.kind !== "foundation-to-patch" ||
    nativeTask.inputs.length !== 0 ||
    !request.nativeCustody ||
    !grant ||
    !request.allowWrite ||
    workspace.revision !== request.revision
  )
    throw new Error(
      "Hosted Foundation-to-patch requires its bound task, current canon custody, and separate write grant.",
    );
  // Distinct message from the guard above and from the same ceiling re-check in
  // `prepareNativeAuthoringRequest`, so tests can tell the refusals apart.
  const intendedPaths = [...nativeTask.task.intendedPaths];
  if (intendedPaths.some((path) => !withinWriteCeiling(path, grant.pathCeiling)))
    throw new Error(
      "Foundation-to-patch intended paths exceed the installed workflow write scope.",
    );
  const evidence = await GitPatchEvidenceCollector.create(
    request.workspacePath,
    resolve(request.stateDirectory, "foundation-patches"),
  );
  const resolver = new CatalogSkillCrateResolver(
    fileURLToPath(new URL("../../skill-crate", import.meta.url)),
  );
  let result: FoundationToPatchRunResultV1 | undefined, nested: NativeAuthoringOutcome | undefined;
  let nestedRunSha256: string | undefined, inspection: FoundationInspectResultV1 | undefined;
  let selectedReviews: { status: "pass" | "inconclusive"; evidence: unknown } | undefined;
  let selectedChecks:
    | { status: "passed" | "failed" | "unavailable"; evidence: unknown }
    | undefined;
  const retain = async (key: string, value: unknown) => {
    const normalized = JSON.parse(JSON.stringify(value));
    await new DurableArtifactStore(resolve(request.stateDirectory, "artifacts"), {
      maxArtifactBytes: Buffer.byteLength(canonicalJson(normalized)),
    }).putRecord(key, normalized);
  };
  const operation = new FoundationToPatchHostOperation({
    run: async () => {
      inspection = await input.inspect();
      await retain(inspection.resultSha256, inspection);
      const now = new Date().toISOString();
      let candidate: Awaited<ReturnType<typeof createHostedNativeCandidate>> | undefined;
      try {
        const before = await buildContentIndex({
          repositoryPath: workspace.path,
          repositoryRevision: workspace.revision,
        });
        const impact = new LocalImpactPostflightService(before);
        result = await runFoundationToPatch({
          repositoryPath: workspace.path,
          repositoryRevision: workspace.revision,
          inspect: inspection,
          allowWrite: true,
          now,
          skillPolicy: "catalog-v1",
          authorization: createFoundationToPatchAuthorization({
            intendedPaths,
            decidedAt: now,
            expiresAt: grant.expiresAt,
            seed: grant.authoritySha256,
          }),
          planStep: () => ({
            schemaVersion: 1,
            kind: "docsfab-foundation-to-patch-plan",
            skillId: skills.plan,
            status: "ready",
            intendedPaths,
            planSha256: canonicalDigest({
              canonSha256: inspection!.canon.canonSha256,
              intendedPaths,
              repositoryRevision: workspace.revision,
            }),
          }),
          async draftStep() {
            candidate = await createHostedNativeCandidate({
              sourcePath: request.workspacePath,
              stateDirectory: request.stateDirectory,
              revision: request.revision,
              treeObjectId: request.sourceTreeObjectId,
              signal: input.signal,
            });
            nested = await input.runAuthoring({
              request,
              candidate,
              inspect: inspection!,
              intendedPaths,
            });
            nestedRunSha256 = canonicalDigest(nested.record);
            await retain(nestedRunSha256, {
              schemaVersion: 1,
              kind: "docsfab-native-authoring-run",
              parentRunId: request.runId,
              sourceRunSha256: nestedRunSha256,
              record: nested.record,
            });
            if (nested.patch !== null)
              await retain(canonicalDigest({ run: nested.record.id, patch: nested.patch }), {
                schemaVersion: 1,
                kind: "docsfab-native-authoring-patch",
                parentRunId: request.runId,
                sourceRunId: nested.record.id,
                patchSha256: nested.patchEvidence?.patchSha256,
                patch: nested.patch,
              });
            if (
              nested.record.status === "needs-input" ||
              nested.record.status === "needs-human-decision"
            )
              return {
                schemaVersion: 1 as const,
                kind: "docsfab-foundation-to-patch-pending-input" as const,
                sourceWorkflow: "create-documentation" as const,
                sourceRunId: nested.record.id,
                sourceRunSha256: nestedRunSha256,
                writeEntered: nested.record.steps.some(
                  (step) => step.mode === "write" && step.status !== "pending",
                ),
              };
            if (nested.record.status !== "succeeded" || !nested.patch || !nested.patchEvidence)
              throw new Error(
                "Nested documentation authoring did not produce a successful scoped patch; inspect its retained run evidence.",
              );
            const admitted = validateAuthoringRunRecordV1(
              nested.record,
              getWorkflow("create-documentation"),
              { requireTerminalSuccess: true },
            );
            const check = nested.record.steps.find(
              (step) => step.id === admitted.selectedProducers!.lint.stepId,
            );
            if (!check?.summary)
              throw new Error(
                "Nested authoring run lacks retained check evidence for its selected candidate.",
              );
            const checks: unknown = JSON.parse(check.summary);
            if (
              !checks ||
              typeof checks !== "object" ||
              !("status" in checks) ||
              !["passed", "failed", "unavailable"].includes(String(checks.status))
            )
              throw new Error(
                "Nested authoring selected check evidence has an unsupported result shape.",
              );
            selectedChecks = {
              status: checks.status as "passed" | "failed" | "unavailable",
              evidence: checks,
            };
            const technicalStep = nested.record.steps.find(
              (step) => step.id === admitted.selectedProducers!.technical.stepId,
            );
            const editorialStep = nested.record.steps.find(
              (step) => step.id === admitted.selectedProducers!.editorial.stepId,
            );
            const technical = decodeAdmittedVerificationSummary(
              technicalStep?.summary,
              admitted.writePaths,
            );
            if (!technical || !editorialStep?.summary)
              throw new Error(
                "Nested authoring run lacks retained review evidence for its selected candidate.",
              );
            const editorial = decodeEditorialReviewResponse(editorialStep.summary);
            selectedReviews = {
              status:
                technical.review.verdict === "pass" && editorial.verdict === "pass"
                  ? "pass"
                  : "inconclusive",
              evidence: { technical, editorial, producers: admitted.selectedProducers },
            };
            return {
              schemaVersion: 1,
              kind: "docsfab-foundation-to-patch-candidate",
              skillId: skills.draft,
              candidateSha256: nested.patchEvidence.patchSha256,
              changedPaths: nested.patchEvidence.changes.map((change) => change.path),
            };
          },
          validateStep: () => ({
            schemaVersion: 1,
            kind: "docsfab-foundation-to-patch-validation",
            status: selectedChecks!.status,
            validationSha256: canonicalDigest({
              security: nested!.record.securityScan,
              checks: selectedChecks!.evidence,
            }),
            changedPaths: nested!.patchEvidence!.changes.map((change) => change.path),
          }),
          adversarialStep: () => ({
            schemaVersion: 1,
            kind: "docsfab-foundation-to-patch-adversarial",
            skillId: skills.adversarial,
            status: selectedReviews!.status,
            reviewSha256: canonicalDigest(selectedReviews!.evidence),
          }),
          patchStep: () => ({
            schemaVersion: 1,
            kind: "docsfab-foundation-to-patch-patch",
            patchSha256: nested!.patchEvidence!.patchSha256,
            byteLength: nested!.patchEvidence!.patchBytes,
            changedPaths: nested!.patchEvidence!.changes.map((change) => change.path),
          }),
          async impactStep() {
            const actual = await impact.postflight({
              runId: nested!.record.id,
              workflow: "create-documentation",
              repository: nested!.record.repository,
              workspacePath: candidate!.workspacePath,
              changedFiles: nested!.record.changes!.files,
            });
            if (actual.status !== "completed")
              throw new Error(
                "A non-empty native authoring patch has no completed impact evidence.",
              );
            await retain(actual.analysisDigest, {
              schemaVersion: 1,
              kind: "docsfab-native-authoring-impact",
              sourceRunId: nested!.record.id,
              evidence: actual,
            });
            return {
              schemaVersion: 1,
              kind: "docsfab-foundation-to-patch-impact",
              status: "completed",
              impactSha256: actual.analysisDigest,
              changedPaths: actual.changedPaths,
            };
          },
          completionDisposition: () =>
            nested!.record.workflowOutcome?.disposition === "ready" ? "ready" : "inconclusive",
        });
        await retain(result.resultSha256, result);
        if (result.status === "succeeded") {
          const directory = resolve(request.stateDirectory, "foundation-transfer");
          await mkdir(directory, { mode: 0o700 });
          const path = resolve(directory, "candidate.patch");
          await writeFile(path, nested!.patch!, { mode: 0o600, flag: "wx" });
          await runTrustedGit(
            request.workspacePath,
            ["apply", "--check", "--", path],
            input.signal,
          );
          await runTrustedGit(request.workspacePath, ["apply", "--", path], input.signal);
        }
        return result;
      } finally {
        await candidate?.dispose();
      }
    },
  });
  const fallback = new FoundationToPatchWorkflowOutcomeProjector();
  return {
    task: { kind: "foundation-to-patch", intendedPaths },
    workspacePath: request.workspacePath,
    repositoryEvidence: evidence,
    harness: {
      inspectSkill: (step) => resolver.resolveSkill(step),
      async runStep() {
        throw new Error("The native composition guidance does not invoke a model directly.");
      },
    },
    hostOperations: {
      async runStep(step) {
        const executed = await operation.runStep(step);
        const questions = [
          ...(inspection?.nextQuestions ?? []),
          ...(nested?.record.steps
            .filter(
              (value) => value.status === "needs-input" || value.status === "needs-human-decision",
            )
            .map((value) => value.summary ?? "") ?? []),
        ].filter(Boolean);
        return {
          ...executed,
          summary: [executed.summary, ...questions].join("\n"),
          ...(nested ? { models: nested.record.models } : {}),
          ...(nested ? { usage: nested.record.usage, tools: nested.record.tools } : {}),
        };
      },
    },
    outcomeProjector: {
      async project(record) {
        if (result?.status !== "succeeded" || !nested?.record.workflowOutcome)
          return fallback.project(record);
        const evidence = workflowOutcomeStepEvidence(
            record as RunRecord,
            "compose-foundation-to-patch",
          ),
          outcome = nested.record.workflowOutcome;
        return {
          disposition: outcome.disposition,
          limitations: [...outcome.limitations],
          evidence: [evidence],
          producedArtifacts: [],
          findings: outcome.findings.map((finding) => ({ ...finding, evidenceIds: [evidence.id] })),
          openDecisions: outcome.openDecisions.map((decision) => ({
            ...decision,
            evidenceIds: [evidence.id],
          })),
        };
      },
    },
  };
}
