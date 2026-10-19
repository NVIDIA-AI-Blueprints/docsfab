// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";

import {
  resolveDocsFabProjectRoot,
  resolveDocsFabStateDirectory,
} from "../../config/host-paths.js";
import { loadConfig } from "../../config/runtime-loader.js";
import {
  IaSiteBootstrapCycleCoordinator,
  approveIaPlanForBootstrap,
  inspectIaLifecycleInput,
  localIaRepositoryIdentity,
  parseIaLifecycleArguments,
  provisionDefaultIaAnalysisInput,
  provisionIaPlanningInputFromAnalysis,
} from "../../ia/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { withRepositoryWorkspace } from "../../repository/workspace/materialize.js";
import { formatIaLifecycleResult } from "../ia-format.js";
import { executeRunRequest } from "../run-request.js";

export async function handleIaCommand(args: string[]): Promise<void> {
  const request = parseIaLifecycleArguments(args);
  if (request.command === "cycle") {
    const config = loadConfig();
    const stateRoot = dirname(config.stateDirectory);
    const repositoryIdentity = await localIaRepositoryIdentity(request.repositoryPath);
    const result = await withRepositoryWorkspace(
      request.repositoryPath,
      request.revision,
      async (workspace) => {
        const coordinator = new IaSiteBootstrapCycleCoordinator({
          provisionAnalysis: async (input) =>
            await withRepositoryWorkspace(
              request.repositoryPath,
              input.repositoryRevision,
              async (provisionWorkspace) => {
                const receipt = await provisionDefaultIaAnalysisInput({
                  packageRoot: resolve(stateRoot, "ia-analysis-inputs", input.repositoryIdentity),
                  repositoryPath: provisionWorkspace.path,
                  repositoryRevision: provisionWorkspace.revision,
                  repositoryIdentity: input.repositoryIdentity,
                  commandRepositoryPath: provisionWorkspace.sourcePath,
                  task: input.task,
                  expiresAt: input.expiresAt,
                  now: new Date(),
                });
                return {
                  repositoryIdentity: receipt.repositoryIdentity,
                  repositoryRevision: receipt.repositoryRevision,
                  inputDigest: receipt.digest,
                  expiresAt: receipt.expiresAt,
                };
              },
            ),
          runAnalysis: async (input) => {
            const record = await executeRunRequest(
              {
                workflow: "ia-analysis",
                repositoryPath: request.repositoryPath,
                revision: input.repositoryRevision,
                task: input.task,
                inputDigest: input.inputDigest,
                allowWrite: false,
                releaseGate: false,
                verbose: false,
                json: false,
                showScan: false,
              },
              config,
              // Not `--quiet`: `ia cycle` owns the consolidated output, so under
              // `--json` this sub-run's footer must not reach stdout ahead of it.
              { silent: request.json },
            );
            if (!record) throw new Error("IA cycle analysis did not produce a run record.");
            return record;
          },
          provisionPlanning: async (input) =>
            await withRepositoryWorkspace(
              request.repositoryPath,
              input.repositoryRevision,
              async (provisionWorkspace) => {
                const receipt = await provisionIaPlanningInputFromAnalysis({
                  analysisOutputRoot: resolve(
                    stateRoot,
                    "ia-analysis-outputs",
                    input.repositoryIdentity,
                  ),
                  planningInputRoot: resolve(stateRoot, "ia-inputs", input.repositoryIdentity),
                  repositoryPath: provisionWorkspace.path,
                  repositoryRevision: provisionWorkspace.revision,
                  repositoryIdentity: input.repositoryIdentity,
                  commandRepositoryPath: provisionWorkspace.sourcePath,
                  task: input.task,
                  analysisRunId: input.analysisRunId,
                  projectRoot: config.projectRoot,
                  now: new Date(),
                });
                return {
                  repositoryIdentity: receipt.repositoryIdentity,
                  repositoryRevision: receipt.repositoryRevision,
                  inputDigest: receipt.digest,
                  expiresAt: receipt.expiresAt,
                };
              },
            ),
          runPlanning: async (input) => {
            const record = await executeRunRequest(
              {
                workflow: "ia-plan",
                repositoryPath: request.repositoryPath,
                revision: input.repositoryRevision,
                task: input.task,
                inputDigest: input.inputDigest,
                allowWrite: false,
                releaseGate: false,
                verbose: false,
                json: false,
                showScan: false,
              },
              config,
              // See the analysis sub-run above.
              { silent: request.json },
            );
            if (!record) throw new Error("IA cycle planning did not produce a run record.");
            return record;
          },
        });
        return await coordinator.run({
          repositoryIdentity,
          repositoryRevision: workspace.revision,
          expiresAt: request.expiresAt,
          commandRepositoryPath: workspace.sourcePath,
          reviewer: {
            reviewerPolicyPath: request.reviewerPolicyPath,
            reviewerId: request.reviewerId,
            privateKeyPath: request.privateKeyPath,
          },
        });
      },
    );
    console.log(
      request.json
        ? canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue)
        : formatIaLifecycleResult(result),
    );
    return;
  }
  const stateDirectory = resolveDocsFabStateDirectory();
  const stateRoot = dirname(stateDirectory);
  const repositoryIdentity = await localIaRepositoryIdentity(request.repositoryPath);
  await withRepositoryWorkspace(request.repositoryPath, request.revision, async (workspace) => {
    let result: unknown;
    if (
      request.command === "input" &&
      request.operation === "provision" &&
      request.packageKind === "analysis-input"
    ) {
      result = await provisionDefaultIaAnalysisInput({
        packageRoot: resolve(stateRoot, "ia-analysis-inputs", repositoryIdentity),
        repositoryPath: workspace.path,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        commandRepositoryPath: workspace.sourcePath,
        task: request.task,
        expiresAt: request.expiresAt!,
        now: new Date(),
      });
    } else if (request.command === "input" && request.operation === "provision") {
      result = await provisionIaPlanningInputFromAnalysis({
        analysisOutputRoot: resolve(stateRoot, "ia-analysis-outputs", repositoryIdentity),
        planningInputRoot: resolve(stateRoot, "ia-inputs", repositoryIdentity),
        repositoryPath: workspace.path,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        commandRepositoryPath: workspace.sourcePath,
        task: request.task,
        analysisRunId: request.analysisRunId!,
        projectRoot: resolveDocsFabProjectRoot(),
        now: new Date(),
      });
    } else if (request.command === "input") {
      result = await inspectIaLifecycleInput({
        packageKind: request.packageKind,
        packageRoot: resolve(
          stateRoot,
          request.packageKind === "analysis-input" ? "ia-analysis-inputs" : "ia-inputs",
          repositoryIdentity,
        ),
        repositoryPath: workspace.path,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        commandRepositoryPath: workspace.sourcePath,
        packageDigest: request.inputDigest,
        task: request.task,
        now: new Date(),
      });
      if (
        request.operation === "validate" &&
        (result as { disposition?: string }).disposition !== "ready"
      ) {
        process.exitCode = 1;
      }
    } else {
      result = await approveIaPlanForBootstrap({
        stateRoot,
        repositoryPath: workspace.path,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        commandRepositoryPath: workspace.sourcePath,
        task: request.task,
        planningRunId: request.planningRunId,
        reviewerPolicyPath: request.reviewerPolicyPath,
        reviewerId: request.reviewerId,
        privateKeyPath: request.privateKeyPath,
        now: new Date(),
      });
    }
    console.log(
      request.json
        ? canonicalizeJsonEvidence(result as JsonEvidenceValue)
        : formatIaLifecycleResult(result),
    );
  });
  return;
}
