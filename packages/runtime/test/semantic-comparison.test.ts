// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  parseHostRuntimeAcceptedEffectRevalidationData,
  parseHostRuntimeAcceptedEffectAssessmentData,
  parseHostRuntimeCorrectiveProposalRevalidationData,
  parseHostRuntimeCorrectiveProposalAssessmentData,
  parseHostRuntimeSemanticGatherRequestData,
  parseHostRuntimeOwnerInformationRequestData,
  parseHostRuntimeSemanticComparisonChunk,
  parseHostRuntimeSemanticComparisonChunkData,
  qualifyHostRuntimeSemanticComparisonSources,
  parseHostRuntimeSemanticComparisonProposal,
  parseHostRuntimeSemanticComparisonProposalData,
  semanticAcceptedEffectFacets,
  semanticComparisonSourceProofInputs,
  digest,
  parseHostRuntimeRequest,
  parseHostRuntimeTerminal,
  sealHostRuntimeComposition,
  sealHostRuntimeTerminal,
  sealHostRuntimeSemanticComparisonChunk,
  type HostRuntimeRequestV1,
  type HostRuntimeSemanticComparisonChunkV1,
  type HostRuntimeSemanticRepositoryRole,
} from "../src/host-invoker/contracts.js";
import { INERT_TRANSPORT_MAX_STRING_CHARS } from "../src/reader-task-transport.js";

import { inspectHostedWorkflowCatalog } from "../src/host-invoker/workflow-catalog.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { readHostRuntimeRequestSources } from "../src/host-invoker/semantic-source-reader.js";
import { readHostRuntimeRequest } from "../src/host-invoker/main.js";
import { containsRepositorySourceCredentialMaterial } from "../src/security/credential-material.js";
import { bindableCycleWorkflow, isRunnableWorkflowName } from "../src/workflow-registry/catalog.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { testTimeoutMs, nestedDeadlineMs } from "./helpers/test-timeouts.js";
import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plainConfiguredCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

afterEach(() => {
  clearPlantedCredential();
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("hosted semantic comparison", () => {
  it("binds the knowledge-owned read-only skill without relabeling a documentation workflow", async () => {
    const catalog = inspectHostedWorkflowCatalog("reconcile-product-behavior");
    expect(catalog.stepIds).toEqual(["compare-product-behavior"]);
    expect(catalog.writeStepIds).toEqual([]);
    expect(catalog.declaredTools).not.toContain("write");
    expect(isRunnableWorkflowName("reconcile-product-behavior")).toBe(false);
    expect(() => bindableCycleWorkflow("reconcile-product-behavior")).toThrow(
      /explicit hosted workflow/u,
    );
    const verified = await verifyCatalogSkill({
      skillCrateDirectory: resolve("skill-crate"),
      skillId: "reconcile-product-behavior",
      grantedTools: ["read", "grep", "find", "ls"],
    });
    expect(verified.skill.sourcePath).toBe(
      "packages/knowledge/skills/reconcile-product-behavior/SKILL.md",
    );
  });

  const hostedCases: {
    label: string;
    ownerInformation: boolean;
    sourceProof: boolean;
    large: boolean;
    invalid: string | null;
    foreignDigest?: boolean;
    cancellation?: { phase: "request" | "credential" | "replay"; signal: "SIGTERM" | "SIGINT" };
  }[] = [
    {
      label: "ordinary proposal",
      ownerInformation: false,
      sourceProof: false,
      large: false,
      invalid: null,
    },
    {
      label: "owner information",
      ownerInformation: true,
      sourceProof: false,
      large: false,
      invalid: null,
    },
    {
      label: "independent source proof",
      ownerInformation: false,
      sourceProof: true,
      large: false,
      invalid: null,
    },
    {
      label: "complete large proposal and 17 owner nominations",
      ownerInformation: true,
      sourceProof: false,
      large: true,
      invalid: null,
    },
    {
      label: "malformed model JSON",
      ownerInformation: false,
      sourceProof: false,
      large: false,
      invalid: "malformed",
    },
    {
      label: "malformed comparison reply corrected on the next attempt",
      ownerInformation: false,
      sourceProof: false,
      large: false,
      invalid: "corrected",
    },
    {
      // The host binds the reply to its own chunk; an echoed digest is not the binding.
      label: "reply echoing another chunk's digest is bound to its own chunk",
      ownerInformation: false,
      sourceProof: false,
      large: false,
      invalid: null,
      foreignDigest: true,
    },
    ...(["SIGTERM", "SIGINT"] as const).flatMap((signal) =>
      (["request", "credential", "replay"] as const).map((phase) => ({
        label: `cancels a held-open ${phase} descriptor on ${signal}`,
        ownerInformation: false,
        sourceProof: false,
        large: false,
        invalid: null,
        cancellation: { phase, signal },
      })),
    ),
  ];
  it.each(hostedCases)(
    "executes or refuses the governed hosted comparison: $label",
    async ({ ownerInformation, sourceProof, large, invalid, foreignDigest, cancellation }) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-semantic-runtime-"));
      const repository = join(root, "repository"),
        state = join(root, "state");
      await mkdir(repository);
      await mkdir(state);
      const git = (...args: string[]) =>
        execFileSync("/usr/bin/git", ["-C", repository, ...args], {
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        }).trim();
      try {
        git("init", "-q");
        git("config", "user.name", "Semantic runtime fixture");
        git("config", "user.email", "fixture@example.invalid");
        const model = "Ordinary messages require an explicit mention before a reply.\n";
        const before = "export const requiresMention = true;\n",
          after =
            (sourceProof ? "export interface Configuration { token: CredentialHandle }\n" : "") +
            "export const requiresMention = false;\n" +
            (sourceProof ? 'export const terminator = "\0";\n' : "");
        const startByte = sourceProof
          ? Buffer.byteLength(after.slice(0, after.indexOf("token:")))
          : 0;
        const afterFragment = Buffer.from(after).subarray(startByte).toString("utf8");
        await writeFile(join(repository, "model.md"), model);
        await writeFile(join(repository, "source.ts"), before);
        git("add", ".");
        git("commit", "-qm", "fixture baseline");
        const baseRevision = git("rev-parse", "HEAD");
        await writeFile(join(repository, "source.ts"), after);
        git("add", ".");
        git("commit", "-qm", "fixture contradiction");
        const revision = git("rev-parse", "HEAD"),
          sourceTreeObjectId = git("rev-parse", "HEAD^{tree}");
        let chunk = sealHostRuntimeSemanticComparisonChunk(
          {
            schemaVersion: 1,
            kind: "docsfab-semantic-comparison-chunk",
            projectId: "project-fixture",
            caseKind: "merge",
            caseSha256: sha("fixture-merge"),
            comparisonSha256: sha("fixture-comparison"),
            baselineGeneration: 1,
            baselineSha256: sha("fixture-approved-baseline"),
            approvalReceiptSha256: sha("fixture-approval"),
            modelSha256: sha(model),
            canonSha256: sha(model),
            sourceInventorySha256: sha("fixture-source-inventory"),
            ordinal: 1,
            chunkCount: 1,
            ...(sourceProof ? { repositoryObservationVersion: 3 as const } : {}),
            claims: [
              {
                claimId: "CLAIM-MENTION",
                statement: model,
                statementSha256: sha(model),
                scope: "ordinary messages",
                recordSha256: sha("fixture-atomic-record"),
              },
            ],
            evidence: [
              {
                evidenceId: "before",
                kind: "repository-before",
                version: baseRevision,
                sourcePath: "source.ts",
                change: "modified",
                content: before,
                contentSha256: sha(before),
                sourceContentSha256: sha(before),
                startByte: 0,
                endByte: Buffer.byteLength(before),
                totalBytes: Buffer.byteLength(before),
                sourceVersionSha256: null,
                ...(sourceProof
                  ? {
                      repositoryRole: {
                        sourceKind: "repository-source" as const,
                        classification: "implementation" as const,
                        coveragePlanSha256: sha("fixture-coverage"),
                      },
                    }
                  : {}),
              },
              {
                evidenceId: "after",
                kind: "repository-after",
                version: revision,
                sourcePath: "source.ts",
                change: "modified",
                content: afterFragment,
                contentSha256: sha(afterFragment),
                sourceContentSha256: sha(after),
                startByte,
                endByte: Buffer.byteLength(after),
                totalBytes: Buffer.byteLength(after),
                sourceVersionSha256: null,
                ...(sourceProof
                  ? {
                      repositoryRole: {
                        sourceKind: "repository-source" as const,
                        classification: "implementation" as const,
                        coveragePlanSha256: sha("fixture-coverage"),
                      },
                    }
                  : {}),
              },
            ],
          },
          sourceProof ? (item) => (item.kind === "repository-before" ? before : after) : undefined,
        );
        if (large) {
          const { inputSha256: _inputSha256, ...body } = chunk;
          chunk = sealHostRuntimeSemanticComparisonChunk({
            ...body,
            evidence: Array.from({ length: 17 }, (_, index) => ({
              ...body.evidence[index % body.evidence.length]!,
              evidenceId: `retained-source-${index}`,
            })),
          });
        }
        const catalog = inspectHostedWorkflowCatalog("reconcile-product-behavior");
        const composition = sealHostRuntimeComposition({
          compositionId: "semantic-offline-fixture",
          route: "offline-fixture",
          credentialFamily: "none",
          executionProfile: null,
          declaredTools: catalog.declaredTools,
        });
        const capsule = {
          receiptSha256: sha("fixture-context-receipt"),
          expiresAt: "2099-01-01T00:00:00.000Z",
          selectedEvidence: [{ evidenceId: "approved-model", content: model }],
        };
        let request = parseHostRuntimeRequest({
          schemaVersion: 1,
          kind: "docsfab-host-runtime-request",
          deploymentId: "deployment-fixture",
          projectId: "project-fixture",
          deploymentEpoch: "epoch-fixture",
          requestKey: "semantic-request",
          origin: { principalId: "fixture-owner", requestId: "semantic-origin" },
          runId: "semantic-fixture-run",
          fence: 1,
          workflow: catalog.workflow,
          revision,
          sourceTreeObjectId,
          packet: {
            packetFingerprintSha256: digest({ inputSha256: chunk.inputSha256 }),
            inputManifest: null,
            canon: {
              kind: "canon",
              sha256: sha(model),
              sourcePathSha256: sha("model.md"),
              gitObjectId: git("rev-parse", "HEAD:model.md"),
              content: model,
            },
            reviewEvent: null,
            semanticComparison: chunk,
          },
          stepIds: catalog.stepIds,
          toolPolicySha256: digest({
            workflow: catalog.workflow,
            stepIds: catalog.stepIds,
            declaredTools: catalog.declaredTools,
          }),
          workspacePath: repository,
          stateDirectory: state,
          capsule: { ...capsule, sha256: digest(capsule) },
          composition,
          allowWrite: false,
          writeAuthority: null,
        });
        if (sourceProof) {
          const wire = JSON.parse(JSON.stringify(request));
          // A type annotation such as `token: CredentialHandle` only looks like
          // an assignment: the chunk screen admits and records it, and it needs
          // no source proof (#1807).
          const admitted = collectCredentialFindings(() => parseHostRuntimeRequest(wire));
          expect(admitted.findings).toContainEqual({
            code: "credential-like-content",
            location: "hosted-semantic:comparisonChunk",
            rule: "credential.assigned-secret",
          });
          expect(semanticComparisonSourceProofInputs(wire.packet.semanticComparison)).toEqual([]);
          // DocsFab's own configured credential in a source item is refused,
          // proved or not. The planted value is source text that looks like no
          // credential, so only the exact match can refuse it.
          plantConfiguredCredential("CredentialHandle }");
          expect(() => parseHostRuntimeRequest(wire)).toThrow(/semantic-input-size-or-credential/u);
          expect(
            semanticComparisonSourceProofInputs(wire.packet.semanticComparison).map(
              (item) => item.evidenceId,
            ),
          ).toEqual(["after"]);
          expect(() =>
            qualifyHostRuntimeSemanticComparisonSources(
              wire.packet.semanticComparison,
              () => after,
            ),
          ).toThrow(/semantic-source-original-credential/u);
          const wrong = JSON.parse(JSON.stringify(wire));
          wrong.packet.semanticComparison.evidence[1].sourcePath = "missing-source.ts";
          const { inputSha256: _old, ...wrongBody } = wrong.packet.semanticComparison;
          wrong.packet.semanticComparison.inputSha256 = digest(wrongBody);
          wrong.packet.packetFingerprintSha256 = digest({
            inputSha256: wrong.packet.semanticComparison.inputSha256,
          });
          await expect(readHostRuntimeRequestSources(wrong)).rejects.toThrow(/source original/u);
          clearPlantedCredential();
          const capsuleOnly = plainConfiguredCredential("capsule");
          const capsuleCopy = JSON.parse(JSON.stringify(wire));
          capsuleCopy.capsule.selectedEvidence = [
            { evidenceId: "unbound-copy", content: `${afterFragment}${capsuleOnly}` },
          ];
          const { sha256: _capsuleSha, ...capsuleBody } = capsuleCopy.capsule;
          capsuleCopy.capsule.sha256 = digest(capsuleBody);
          expect(
            (await readHostRuntimeRequestSources(capsuleCopy)).capsule.selectedEvidence,
          ).toEqual(capsuleCopy.capsule.selectedEvidence);
          plantConfiguredCredential(capsuleOnly);
          await expect(readHostRuntimeRequestSources(capsuleCopy)).rejects.toThrow(
            /credential-material/u,
          );
          clearPlantedCredential();
          // The installed descriptor entrypoint retains both workflow capacity
          // checks and independent source qualification after composition.
          const inputFile = join(state, "semantic-request.json");
          await writeFile(inputFile, JSON.stringify(wire), { mode: 0o600 });
          const inputHandle = await open(inputFile, "r");
          try {
            request = await readHostRuntimeRequest(inputHandle.fd);
          } finally {
            await inputHandle.close();
          }
          const metadataCopy = fixtureProposal(request.packet.semanticComparison!);
          metadataCopy.assessments[0]!.explanation = afterFragment;
          // Proposal metadata quoting the fragment is admitted and recorded;
          // with the fragment configured as a credential it is refused.
          expect(
            collectCredentialFindings(() =>
              parseHostRuntimeSemanticComparisonProposal(
                metadataCopy,
                request.packet.semanticComparison!,
              ),
            ).findings.map((finding) => finding.location),
          ).toContain("hosted-semantic:comparisonProposal");
          plantConfiguredCredential("CredentialHandle }");
          expect(() =>
            parseHostRuntimeSemanticComparisonProposal(
              metadataCopy,
              request.packet.semanticComparison!,
            ),
          ).toThrow(/credential/u);
          clearPlantedCredential();
          for (const unsafe of [
            'export const value = { token: "' + "q".repeat(8) + '" };',
            'export const value = { token: getValue("' + "q".repeat(8) + '") };',
            'export const value = { token: getValue("' + "q".repeat(9) + '").value };',
            'export const token: CredentialHandle = getValue("' + "q".repeat(8) + '");',
            'export interface X { token: CredentialHandle }\nconst token: string = "' +
              "q".repeat(8) +
              '";',
            'class C { private token: string = "' + "q".repeat(8) + '"; }',
            'function f(token: string = "' + "q".repeat(8) + '") {}',
            'const token = f(\n"' + "q".repeat(8) + '"\n);',
            'export const value = { token: getValue("' + "a".repeat(32) + '") };',
            'export interface X { token: CredentialHandle }\nconst password = "' +
              "b".repeat(32) +
              '";',
            JSON.stringify({ token: "c".repeat(32) }),
            "/* token: " + "d".repeat(32) + " */\nexport const enabled = true;",
            afterFragment,
          ])
            expect(containsRepositorySourceCredentialMaterial(unsafe)).toBe(true);
        }
        expect(() =>
          parseHostRuntimeRequest({
            ...request,
            packet: { ...request.packet, semanticComparison: undefined },
          }),
        ).toThrow();
        expect(() =>
          parseHostRuntimeRequest({
            ...request,
            workflow: "review-documentation",
          }),
        ).toThrow(/semantic-workflow-binding/u);
        expect(() => parseHostRuntimeRequest({ ...request, projectId: "another-project" })).toThrow(
          /semantic-workflow-binding/u,
        );
        if (cancellation) {
          await assertHostedDescriptorCancellation(request, cancellation);
          expect(git("status", "--porcelain")).toBe("");
          return;
        }
        let calls = 0;
        let executedInstruction = "";
        let executedSummary = "";
        const runModelStep: WorkerModelStep = async (input) => {
          calls++;
          executedInstruction = input.instruction ?? "";
          expect(input.workflow.name).toBe("reconcile-product-behavior");
          expect(input.step.skill).toBe("reconcile-product-behavior");
          expect(input.step.mode).toBe("read-only");
          expect(input.instruction).toContain(chunk.inputSha256);
          expect(input.instruction).toContain("requiresMention = false");
          expect(input.instruction).toContain("ownerInformationRequests");
          expect(input.instruction).toContain("missingEvidence for agent work");
          const proposal = fixtureProposal(chunk, ownerInformation);
          if (large) {
            for (const assessment of proposal.assessments) {
              assessment.explanation = "Complete retained semantic evidence. ".repeat(700);
            }
          }
          if (foreignDigest) proposal.inputSha256 = sha("another immutable input");
          const response = sourceProof
            ? {
                ...proposal,
                assessments: proposal.assessments.map((assessment) => ({
                  ...assessment,
                  sourceCitations: [
                    {
                      evidenceId: assessment.evidenceId,
                      quote: chunk.evidence.find(
                        (item) => item.evidenceId === assessment.evidenceId,
                      )!.content,
                    },
                  ],
                })),
              }
            : proposal;
          if (invalid && calls > 1) {
            expect(input.responseCorrection?.rejection).toEqual({
              code: "semantic-proposal-not-json",
              location: "$.compareProductBehavior",
            });
          }
          executedSummary =
            invalid === "malformed" || (invalid === "corrected" && calls === 1)
              ? "not structured JSON"
              : canonicalJson(response);
          if (large) expect(Buffer.byteLength(executedSummary)).toBeGreaterThan(256 * 1024);
          return {
            summary: executedSummary,
            model: {
              provider: "offline-fixture",
              model: composition.compositionSha256.slice(0, 16),
            },
          };
        };
        const executionHarness: AgentHarness = { runStep: runModelStep };
        const worker =
          large || invalid ? await executeHostedWorker(request, runModelStep) : undefined;
        if (invalid === "malformed") {
          expect(worker!.exitCode).toBe(1);
          expect(worker!.terminal.status).toBe("failed");
          expect(worker!.terminal.runRecord.binding.semanticComparisonSha256).toBe(
            chunk.inputSha256,
          );
          expect(calls).toBe(2);
          expect(worker!.terminal.runRecord.runtimeRecord.code).toBe(
            "semantic-reply-proposal-not-json",
          );
          expect(worker!.terminal.runRecord.runtimeRecord.rejectedReplyShape).toBeDefined();
          expect(worker!.terminal.runRecord.runtimeRecord.rejectedReplyExcerpt).toBeDefined();
          expect(git("status", "--porcelain")).toBe("");
          const retained = JSON.parse(
            await readFile(join(state, `${request.runId}.json`), "utf8"),
          ) as RunRecord;
          const refused = retained.steps.find((step) => step.id === "compare-product-behavior")!;
          expect(refused.inference?.attempts).toHaveLength(2);
          expect(refused.inference?.attempts[0]?.retryScheduled).toBe(true);
          expect(refused.inference?.attempts[1]?.retryScheduled).toBe(false);
          return;
        }
        const result = worker
          ? {
              record: worker.terminal.runRecord.runtimeRecord as RunRecord,
              patch: worker.terminal.patch,
            }
          : await runHostedWorkflow({ request, credential: null, emit() {}, executionHarness });
        expect(result.record.status, JSON.stringify(result.record)).toBe("succeeded");
        expect(calls).toBe(invalid === "corrected" ? 2 : 1);
        expect(result.patch).toBeNull();
        expect(result.record.instruction).toBeUndefined();
        expect(git("status", "--porcelain")).toBe("");
        const terminal =
          worker?.terminal ??
          sealHostRuntimeTerminal({
            request,
            status: "succeeded",
            runtimeRecord: result.record,
            patch: null,
          });
        const normalized = parseHostRuntimeSemanticComparisonProposal(
          JSON.parse(executedSummary),
          chunk,
        );
        const returnedSummary = result.record.steps.find(
          (step) => step.id === "compare-product-behavior",
        )!.summary;
        expect(returnedSummary).toBe(canonicalJson(normalized));
        expect(JSON.parse(returnedSummary!).inputSha256).toBe(chunk.inputSha256);
        expect(
          parseHostRuntimeSemanticComparisonProposal(JSON.parse(returnedSummary!), chunk),
        ).toEqual(normalized);
        const retained = JSON.parse(
          await readFile(join(state, `${request.runId}.json`), "utf8"),
        ) as RunRecord;
        expect(retained.instruction).toBe(executedInstruction);
        expect(retained.steps.find((step) => step.id === "compare-product-behavior")?.summary).toBe(
          canonicalJson(normalized),
        );
        if (large) {
          expect(normalized.ownerInformationRequests).toHaveLength(17);
          expect(normalized.ownerInformationRequests!.map((row) => row.evidenceId)).toEqual(
            chunk.evidence.map((row) => row.evidenceId),
          );
          expect(Buffer.byteLength(returnedSummary!)).toBeGreaterThan(256 * 1024);
          expect(worker!.exitCode).toBe(0);
          const transported = terminal.runRecord.runtimeRecord as RunRecord;
          expect(transported.steps[0]!.summary).toBe(returnedSummary);
        }
        expect(terminal.runRecord.binding.semanticComparisonSha256).toBe(chunk.inputSha256);
        expect(parseHostRuntimeTerminal(terminal, request).status).toBe("succeeded");
        expect(JSON.stringify(terminal)).not.toContain("token: CredentialHandle");
        expect(parseHostRuntimeTerminal(JSON.parse(JSON.stringify(terminal)), request).status).toBe(
          "succeeded",
        );
        const { inputSha256: _inputSha256, ...chunkBody } = chunk;
        const changedChunk = sealHostRuntimeSemanticComparisonChunk(
          {
            ...chunkBody,
            baselineGeneration: 2,
          },
          sourceProof ? (item) => (item.kind === "repository-before" ? before : after) : undefined,
        );
        const changedRequest = parseHostRuntimeRequest({
          ...request,
          packet: { ...request.packet, semanticComparison: changedChunk },
        });
        expect(() => parseHostRuntimeTerminal(terminal, changedRequest)).toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    testTimeoutMs(120_000),
  );
});

/** Actual inherited pipes remain open in the parent until the signaled worker exits. */
async function assertHostedDescriptorCancellation(
  request: HostRuntimeRequestV1,
  cancellation: { phase: "request" | "credential" | "replay"; signal: "SIGTERM" | "SIGINT" },
) {
  const inputPath = join(request.stateDirectory, "cancellation-request.json");
  await writeFile(inputPath, JSON.stringify(request), { mode: 0o600 });
  const input = await open(inputPath, "r");
  const heldFd = cancellation.phase === "request" ? 3 : 4;
  const args = [
    "--request-fd",
    "3",
    ...(cancellation.phase === "request"
      ? []
      : [cancellation.phase === "credential" ? "--credential-fd" : "--replay-record-fd", "4"]),
  ];
  const mainUrl = new URL("../src/host-invoker/main.ts", import.meta.url).href;
  // Observe the real descriptor stat without replacing its value or any read.
  // This identifies the exact waiting phase, avoiding a timed startup guess.
  const code = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const stat = fs.fstatSync;
    let observing = false;
    fs.fstatSync = function(fd, ...args) {
      const result = Reflect.apply(stat, fs, [fd, ...args]);
      if (observing && fd === ${heldFd}) process.stdout.write("reading-held-fd\\n");
      return result;
    };
    syncBuiltinESMExports();
    const { hostInvokerMain } = await import(${JSON.stringify(mainUrl)});
    observing = true;
    await hostInvokerMain(${JSON.stringify(args)}).catch(() => { process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: resolve("."),
    stdio:
      cancellation.phase === "request"
        ? ["ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", input.fd, "pipe"],
    env: {
      PATH: process.env.PATH,
      PI_OFFLINE: "1",
      DOCSFAB_CONFIG_ROOT: join(request.stateDirectory, "empty-config"),
    },
  });
  let output = "";
  let exited = false;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    },
  );
  const entered = new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (bytes: Buffer) => {
      output += bytes.toString("utf8");
      if (output.includes("reading-held-fd\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Worker exited before the selected input phase.")));
  });
  child.stderr!.resume();
  const timers = new Set<NodeJS.Timeout>();
  const bounded = <T>(result: Promise<T>, milliseconds: number, message: string): Promise<T> =>
    Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timers.add(setTimeout(() => reject(new Error(message)), milliseconds));
      }),
    ]);
  try {
    await bounded(
      entered,
      nestedDeadlineMs(30_000, 120_000),
      "Worker did not reach its held descriptor.",
    );
    child.kill(cancellation.signal);
    expect(
      await bounded(
        done,
        nestedDeadlineMs(5_000, 120_000),
        "Worker ignored cancellation while its descriptor remained open.",
      ),
    ).toEqual({ code: 1, signal: null });
    expect(output).toBe("reading-held-fd\n");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (!exited) {
      child.kill("SIGKILL");
      await done;
    }
    child.stdio[heldFd]?.destroy();
    await input.close();
  }
}

/** Capture the actual worker NDJSON boundary; only its model edge is synthetic. */
type WorkerModelInput = Pick<
  Parameters<AgentHarness["runStep"]>[0],
  "workflow" | "step" | "instruction" | "responseCorrection"
>;
type WorkerModelStep = (input: WorkerModelInput) => ReturnType<AgentHarness["runStep"]>;

async function executeHostedWorker(request: HostRuntimeRequestV1, runModelStep: WorkerModelStep) {
  const inputFile = join(request.stateDirectory, "worker-request.json");
  await writeFile(inputFile, JSON.stringify(request), { mode: 0o600 });
  const held: Awaited<ReturnType<typeof open>>[] = [];
  try {
    // A long-lived CI worker can allocate descriptors above the CLI protocol's
    // 3..16 slots. Force that condition instead of relying on local allocation.
    do {
      held.push(await open(inputFile, "r"));
    } while (held.at(-1)!.fd <= 16);
    const handle = held.at(-1)!;
    expect(handle.fd).toBeGreaterThan(16);
    const mainUrl = new URL("../src/host-invoker/main.ts", import.meta.url).href;
    const code = `
      const { hostInvokerMain } = await import(${JSON.stringify(mainUrl)});
      const executionHarness = {
        runStep(input) {
          return new Promise((resolve, reject) => {
            const disconnected = () => reject(new Error("Test model channel disconnected."));
            process.once("disconnect", disconnected);
            process.once("message", message => {
              process.removeListener("disconnect", disconnected);
              if (message?.kind === "model-result") resolve(message.result);
              else reject(new Error("Test model edge refused."));
            });
            process.send({ kind: "model-step", input: {
              workflow: input.workflow, step: input.step, instruction: input.instruction,
              responseCorrection: input.responseCorrection,
            }});
          });
        },
      };
      try {
        await hostInvokerMain(["--request-fd", "3"], { executionHarness });
      } catch (error) {
        process.stderr.write(String(error) + "\\n");
        process.exitCode = 1;
      } finally {
        if (process.connected) process.disconnect();
      }
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe", handle.fd, "ipc"],
      env: {
        PATH: process.env.PATH,
        PI_OFFLINE: "1",
        DOCSFAB_CONFIG_ROOT: join(request.stateDirectory, "empty-config"),
      },
    });
    let output = "";
    let diagnostics = "";
    let exited = false;
    let modelError: unknown;
    const pending = new Set<Promise<void>>();
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (value: string) => {
      output += value;
    });
    child.stderr!.on("data", (value: string) => {
      diagnostics += value;
    });
    child.on("message", (message: { kind?: string; input?: WorkerModelInput }) => {
      const operation = (async () => {
        if (message?.kind !== "model-step" || !message.input)
          throw new Error("Unexpected test model request.");
        const result = await runModelStep(message.input);
        await new Promise<void>((resolve, reject) => {
          child.send({ kind: "model-result", result }, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      })().catch((error: unknown) => {
        modelError = error;
        child.kill("SIGKILL");
      });
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          exited = true;
          resolve({ code, signal });
        });
      },
    );
    try {
      const result = await done;
      await Promise.all(pending);
      if (modelError) throw modelError;
      expect(result.signal, diagnostics).toBeNull();
      const lines = output.trim().split("\n");
      expect(lines.at(-1), diagnostics).toBeTruthy();
      return {
        terminal: parseHostRuntimeTerminal(JSON.parse(lines.at(-1)!), request),
        exitCode: result.code,
      };
    } finally {
      if (!exited) {
        child.kill("SIGKILL");
        await done.catch(() => undefined);
      }
    }
  } finally {
    await Promise.all(held.map((handle) => handle.close()));
  }
}

function codecFixture(evidenceCount = 1) {
  const { chunk: original } = acceptedEffectFixture();
  const { inputSha256: _input, acceptedEffectRevalidation: _purpose, ...body } = original;
  const chunk = sealHostRuntimeSemanticComparisonChunk({
    ...body,
    evidence: Array.from({ length: evidenceCount }, (_, index) => ({
      ...original.evidence[0]!,
      evidenceId: `evidence-${index}`,
    })),
  });
  return { chunk, proposal: fixtureProposal(chunk) };
}

describe("semantic codec inert snapshots", () => {
  it("refuses active sealer inputs before reading properties or calling the source qualifier", () => {
    const { inputSha256: _digest, ...body } = codecFixture().chunk;
    expect(sealHostRuntimeSemanticComparisonChunk(body).projectId).toBe(body.projectId);
    let reads = 0;
    let qualifications = 0;
    const active = {
      ...body,
      get projectId() {
        reads++;
        return body.projectId;
      },
    };
    expect(() =>
      sealHostRuntimeSemanticComparisonChunk(active, () => {
        qualifications++;
        return undefined;
      }),
    ).toThrow(/invalid-shape/u);
    expect(reads).toBe(0);
    expect(qualifications).toBe(0);
    let traps = 0;
    const proxy = new Proxy(body, {
      ownKeys(target) {
        traps++;
        return Reflect.ownKeys(target);
      },
      get(target, key, receiver) {
        traps++;
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf(target) {
        traps++;
        return Reflect.getPrototypeOf(target);
      },
    });
    expect(() => sealHostRuntimeSemanticComparisonChunk(proxy)).toThrow(/invalid-shape/u);
    expect(traps).toBe(0);
  });

  it.each(["root", "nested containers"])(
    "freezes semantic data below pre-frozen %s without replacing its identity",
    (mode) => {
      const accepted = acceptedEffectFixture();
      const acceptedProposal = parseHostRuntimeSemanticComparisonProposal(
        accepted.proposal,
        accepted.chunk,
      );
      const corrective = correctiveProtocolFixture();
      const correctiveProposal = parseHostRuntimeSemanticComparisonProposal(
        corrective.proposal,
        corrective.chunk,
      );
      const { chunk } = codecFixture();
      const proposal = parseHostRuntimeSemanticComparisonProposal(
        fixtureProposal(chunk, true),
        chunk,
      );
      const cases: Array<{ name: string; value: unknown; parse: (input: unknown) => unknown }> = [
        {
          name: "accepted purpose",
          value: accepted.purpose,
          parse: parseHostRuntimeAcceptedEffectRevalidationData,
        },
        {
          name: "accepted assessment",
          value: acceptedProposal.acceptedEffectAssessments![0],
          parse: parseHostRuntimeAcceptedEffectAssessmentData,
        },
        {
          name: "corrective purpose",
          value: corrective.corrective,
          parse: parseHostRuntimeCorrectiveProposalRevalidationData,
        },
        {
          name: "corrective assessment",
          value: correctiveProposal.correctiveProposalAssessments![0],
          parse: parseHostRuntimeCorrectiveProposalAssessmentData,
        },
        { name: "chunk", value: chunk, parse: parseHostRuntimeSemanticComparisonChunkData },
        {
          name: "gather",
          value: {
            inputSha256: chunk.inputSha256,
            evidenceId: chunk.evidence[0]!.evidenceId,
            claimId: chunk.claims[0]!.claimId,
            question: { kind: "exact-path", path: "src/secondary.ts" },
          },
          parse: parseHostRuntimeSemanticGatherRequestData,
        },
        {
          name: "owner",
          value: proposal.ownerInformationRequests![0],
          parse: parseHostRuntimeOwnerInformationRequestData,
        },
        {
          name: "proposal",
          value: proposal,
          parse: parseHostRuntimeSemanticComparisonProposalData,
        },
      ];
      for (const { name, value, parse } of cases) {
        const input = structuredClone(value) as Record<string, unknown>;
        if (mode === "root") Object.freeze(input);
        else
          for (const child of Object.values(input)) {
            if (child && typeof child === "object") Object.freeze(child);
          }
        const before = canonicalJson(input);
        const parsed = parse(input);
        expect(parsed, name).toBe(input);
        const assertFrozen = (node: unknown): void => {
          if (!node || typeof node !== "object") return;
          expect(Object.isFrozen(node), name).toBe(true);
          for (const [key, child] of Object.entries(node)) {
            expect(Reflect.set(node, key, "changed after validation"), name).toBe(false);
            assertFrozen(child);
          }
        };
        assertFrozen(parsed);
        expect(canonicalJson(parsed), name).toBe(before);
      }
    },
  );
});

describe("a semantic reply degrades per element", () => {
  it("binds the reply to its own chunk and ignores fields outside the contract", () => {
    const { chunk, proposal } = codecFixture(2);
    const expected = parseHostRuntimeSemanticComparisonProposal(proposal, chunk);
    const { schemaVersion: _v, kind: _k, inputSha256: _i, missingEvidence: _m, ...bare } = proposal;
    const reply = {
      ...bare,
      commentary: "a field the contract does not name",
      assessments: bare.assessments.map((row) => ({ ...row, reasoning: "also not named" })),
    };
    expect(parseHostRuntimeSemanticComparisonProposal(reply, chunk)).toEqual(expected);
    // Adjacent: the assessments are the reply's answer, so a reply without them is refused.
    const { assessments: _a, ...unanswered } = bare;
    expect(() => parseHostRuntimeSemanticComparisonProposal(unanswered, chunk)).toThrow(
      /semantic-proposal-binding/u,
    );
  });

  it("anchors a repeated quote at its first occurrence and a missing one at the whole record", () => {
    const { chunk, proposal } = codecFixture(1);
    const item = chunk.evidence[0]!;
    const quote = [...item.content].find(
      (value) => item.content.indexOf(value) !== item.content.lastIndexOf(value),
    )!;
    expect(quote, "the fixture evidence repeats a character").toBeDefined();
    const quoted = {
      ...proposal,
      assessments: proposal.assessments.map((row) => ({
        ...row,
        sourceCitations: [
          { evidenceId: item.evidenceId, quote },
          { evidenceId: item.evidenceId, quote: "text the evidence never contained" },
        ],
      })),
    };
    const [first, whole] = parseHostRuntimeSemanticComparisonProposal(quoted, chunk).assessments[0]!
      .sourceCitations;
    const start = Buffer.byteLength(item.content.slice(0, item.content.indexOf(quote)));
    expect(first).toEqual({
      evidenceId: item.evidenceId,
      startByte: start,
      endByte: start + Buffer.byteLength(quote),
      sha256: sha(quote),
    });
    expect(whole).toEqual({
      evidenceId: item.evidenceId,
      startByte: 0,
      endByte: Buffer.byteLength(item.content),
      sha256: item.contentSha256,
    });
  });

  it("carries model prose as one inert line", () => {
    const { chunk, proposal } = codecFixture(1);
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      {
        ...proposal,
        assessments: proposal.assessments.map((row) => ({
          ...row,
          explanation: "Drops [E1] <b>\nsee /etc/docsfab/pilot.json",
          proposedClaim: { statement: "Replies need <no> [mention]", scope: {} },
        })),
      },
      chunk,
    );
    expect(parsed.assessments[0]!.explanation).toBe("Drops (E1) (b) see etc/docsfab/pilot.json");
    expect(parsed.assessments[0]!.proposedClaim!.statement).toBe("Replies need (no) (mention)");
    expect(
      parseHostRuntimeSemanticComparisonProposal(JSON.parse(canonicalJson(parsed)), chunk),
    ).toEqual(parsed);
  });

  it("names evidence the reply left unassessed and parses its own output unchanged", () => {
    const { chunk, proposal } = codecFixture(3);
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      { ...proposal, assessments: proposal.assessments.slice(1) },
      chunk,
    );
    expect(parsed.assessments).toHaveLength(2);
    expect(parsed.missingEvidence).toEqual([
      "The comparison did not assess 1 supplied evidence fragment(s).",
    ]);
    expect(
      parseHostRuntimeSemanticComparisonProposal(JSON.parse(canonicalJson(parsed)), chunk),
    ).toEqual(parsed);
    // Positive control: a reply that assesses every fragment carries no note.
    expect(parseHostRuntimeSemanticComparisonProposal(proposal, chunk).missingEvidence).toEqual([]);
  });
});

describe("semantic proposal codec capacity", () => {
  it("retains seventeen distinct owner nominations with their exact assessment bindings", () => {
    const { chunk } = codecFixture(17);
    const proposal = fixtureProposal(chunk, true);
    const parsed = parseHostRuntimeSemanticComparisonProposal(proposal, chunk);
    expect(parsed.ownerInformationRequests).toHaveLength(17);
    expect(parsed.ownerInformationRequests?.map((request) => request.evidenceId)).toEqual(
      chunk.evidence.map((item) => item.evidenceId),
    );
    expect(parseHostRuntimeSemanticComparisonProposalData(parsed)).toEqual(parsed);
    for (const absent of [[], null]) {
      const normalized = parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, ownerInformationRequests: absent },
        chunk,
      );
      expect(Object.hasOwn(normalized, "ownerInformationRequests")).toBe(false);
      expect(parseHostRuntimeSemanticComparisonProposalData(normalized)).toEqual(normalized);
      const data = parseHostRuntimeSemanticComparisonProposalData({
        ...parsed,
        ownerInformationRequests: absent,
      });
      expect(Object.hasOwn(data, "ownerInformationRequests")).toBe(false);
    }
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        {
          ...proposal,
          ownerInformationRequests: [
            ...proposal.ownerInformationRequests!,
            proposal.ownerInformationRequests![0],
          ],
        },
        chunk,
      ),
    ).toThrow(/semantic-owner-information-assessment/u);
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        {
          ...proposal,
          ownerInformationRequests: proposal.ownerInformationRequests!.map((request, index) =>
            index === 16 ? { ...request, claimId: "foreign-claim" } : request,
          ),
        },
        chunk,
      ),
    ).toThrow(/semantic-owner-information-assessment/u);
  });

  it("retains a proposal above 256 KiB using the shared free-text string allowance", () => {
    const { chunk, proposal } = codecFixture();
    const text = "界".repeat(INERT_TRANSPORT_MAX_STRING_CHARS);
    const expanded = {
      ...proposal,
      assessments: proposal.assessments.map((row) => ({
        ...row,
        explanation: text,
        scope: text,
        proposedClaim: { statement: text, scope: { surface: "ordinary messages" } },
      })),
      missingEvidence: [text],
    };
    expect(text.length).toBe(INERT_TRANSPORT_MAX_STRING_CHARS);
    expect(Buffer.byteLength(text)).toBeGreaterThan(INERT_TRANSPORT_MAX_STRING_CHARS);
    expect(Buffer.byteLength(canonicalJson(expanded))).toBeGreaterThan(256 * 1024);
    const parsed = parseHostRuntimeSemanticComparisonProposal(expanded, chunk);
    expect(parsed.assessments[0]?.explanation).toBe(text);
    expect(parsed.assessments[0]?.scope).toBe(text);
    expect(parsed.assessments[0]?.proposedClaim?.statement).toBe(text);
    expect(parsed.missingEvidence).toEqual([text]);
    expect(parseHostRuntimeSemanticComparisonProposalData(parsed)).toEqual(parsed);
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        {
          ...expanded,
          assessments: expanded.assessments.map((row) => ({ ...row, explanation: `${text}x` })),
        },
        chunk,
      ),
    ).toThrow(/invalid-value/u);
    expect(() =>
      parseHostRuntimeSemanticComparisonProposalData({
        ...parsed,
        missingEvidence: [`${text}x`],
      }),
    ).toThrow(/invalid-value/u);
  });

  it("uses the same shared string guard for owner questions and their explanations", () => {
    const { chunk } = codecFixture();
    const proposal = fixtureProposal(chunk, true);
    const text = "界".repeat(INERT_TRANSPORT_MAX_STRING_CHARS);
    const expanded = {
      ...proposal,
      ownerInformationRequests: proposal.ownerInformationRequests!.map((request) => ({
        ...request,
        question: text,
        whyOwnerNeeded: text,
      })),
    };
    const parsed = parseHostRuntimeSemanticComparisonProposal(expanded, chunk);
    expect(parsed.ownerInformationRequests?.[0]?.question).toBe(text);
    expect(parsed.ownerInformationRequests?.[0]?.whyOwnerNeeded).toBe(text);
    expect(parseHostRuntimeSemanticComparisonProposalData(parsed)).toEqual(parsed);
    for (const field of ["question", "whyOwnerNeeded"] as const) {
      expect(() =>
        parseHostRuntimeSemanticComparisonProposal(
          {
            ...expanded,
            ownerInformationRequests: expanded.ownerInformationRequests.map((request) => ({
              ...request,
              [field]: `${text}x`,
            })),
          },
          chunk,
        ),
      ).toThrow(/invalid-value/u);
      for (const invalid of ["", "\0", 7]) {
        expect(() =>
          parseHostRuntimeSemanticComparisonProposal(
            {
              ...expanded,
              ownerInformationRequests: expanded.ownerInformationRequests.map((request) => ({
                ...request,
                [field]: invalid,
              })),
            },
            chunk,
          ),
        ).toThrow(/semantic-owner-information-text/u);
      }
    }
  });
});

describe("semantic source qualification data", () => {
  it("binds complete immutable Git bytes to one object and keeps metadata screening strict", async () => {
    const repository = await mkdtemp(join(tmpdir(), "docsfab-semantic-codec-"));
    const git = (...args: string[]) =>
      execFileSync(
        "/usr/bin/git",
        ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", repository, ...args],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        },
      ).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "Semantic codec fixture");
      git("config", "user.email", "fixture@example.invalid");
      const source =
        "export interface Configuration { token: CredentialHandle }\nexport const requiresMention = false;\n";
      await writeFile(join(repository, "source.ts"), source);
      git("add", ".");
      git("commit", "-qm", "fixture source");
      const revision = git("rev-parse", "HEAD");
      const original = () =>
        execFileSync("/usr/bin/git", ["-C", repository, "show", `${revision}:source.ts`], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        });
      const { chunk } = codecFixture();
      const { inputSha256: _input, ...body } = chunk;
      const startByte = Buffer.byteLength(source.slice(0, source.indexOf("token:")));
      const fragment = Buffer.from(source).subarray(startByte).toString("utf8");
      const nextBody = {
        ...body,
        repositoryObservationVersion: 3 as const,
        evidence: [
          {
            ...chunk.evidence[0]!,
            version: revision,
            sourcePath: "source.ts",
            content: fragment,
            contentSha256: sha(fragment),
            sourceContentSha256: sha(source),
            startByte,
            endByte: Buffer.byteLength(source),
            totalBytes: Buffer.byteLength(source),
            repositoryRole: implementationRole,
          },
        ],
      };
      const wire = { ...nextBody, inputSha256: digest(nextBody) };
      expect(parseHostRuntimeSemanticComparisonChunkData(wire)).toEqual(wire);
      // Source text that only looks like an assignment needs no proof: the
      // chunk screen admits and records the text. See #1807.
      expect(
        collectCredentialFindings(() => parseHostRuntimeSemanticComparisonChunk(wire)).findings,
      ).toEqual([
        {
          code: "credential-like-content",
          location: "hosted-semantic:comparisonChunk",
          rule: "credential.assigned-secret",
        },
      ]);
      const shallowWire = Object.freeze(structuredClone(wire));
      const qualified = qualifyHostRuntimeSemanticComparisonSources(shallowWire, original);
      expect(qualified).toBe(shallowWire);
      expect(Object.isFrozen(qualified.evidence[0])).toBe(true);
      expect(parseHostRuntimeSemanticComparisonChunk(qualified)).toBe(qualified);
      const sealed = sealHostRuntimeSemanticComparisonChunk(nextBody, original);
      expect(parseHostRuntimeSemanticComparisonChunk(sealed)).toBe(sealed);
      const proposal = fixtureProposal(qualified);
      expect(
        parseHostRuntimeSemanticComparisonProposal(proposal, qualified).assessments,
      ).toHaveLength(1);
      const quoting = {
        ...proposal,
        assessments: proposal.assessments.map((row) => ({ ...row, explanation: fragment })),
      };
      expect(
        collectCredentialFindings(() =>
          parseHostRuntimeSemanticComparisonProposal(quoting, qualified),
        ).findings.map((finding) => finding.location),
      ).toContain("hosted-semantic:comparisonProposal");
      // DocsFab's own configured credential in the source text is refused,
      // proved or not; the planted value is source text that looks like none.
      plantConfiguredCredential("CredentialHandle }");
      expect(() => parseHostRuntimeSemanticComparisonChunk(wire)).toThrow(/credential/u);
      expect(() => qualifyHostRuntimeSemanticComparisonSources(wire, original)).toThrow(
        /semantic-source-original-credential/u,
      );
      expect(() => parseHostRuntimeSemanticComparisonProposal(quoting, qualified)).toThrow(
        /credential/u,
      );
    } finally {
      clearPlantedCredential();
      await rm(repository, { recursive: true, force: true });
    }
  });
});

function fixtureProposal(chunk: HostRuntimeSemanticComparisonChunkV1, ownerInformation = false) {
  const claim = chunk.claims[0]!;
  return {
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-proposal",
    inputSha256: chunk.inputSha256,
    assessments: chunk.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      claimId: claim.claimId,
      relationship: "behavior-conflict",
      assertion: "observed-implementation",
      explanation:
        "Fixture model identifies removal of the mention prerequisite in the after source.",
      scope: "Exact fixture source change only; no execution proof.",
      confidence: "high",
      modelCitation: {
        evidenceId: claim.claimId,
        startByte: 0,
        endByte: Buffer.byteLength(claim.statement),
        sha256: claim.statementSha256,
      },
      sourceCitations: [
        {
          evidenceId: item.evidenceId,
          startByte: 0,
          endByte: Buffer.byteLength(item.content),
          sha256: item.contentSha256,
        },
      ],
    })),
    missingEvidence: [],
    ...(ownerInformation
      ? {
          ownerInformationRequests: chunk.evidence.map((item) => ({
            evidenceId: item.evidenceId,
            claimId: claim.claimId,
            requestKind: "scope",
            question: "Which channels belong to the approved pilot?",
            whyOwnerNeeded:
              "The admitted product-intent evidence omits the accountable pilot boundary.",
            modelCitation: { evidenceId: claim.claimId, quote: claim.statement },
            sourceCitations: [{ evidenceId: item.evidenceId, quote: item.content }],
          })),
        }
      : {}),
  };
}

/** Synthetic immutable intent/observation and model output test only; no owner or currentness authority. */
function acceptedEffectFixture(
  subject: "desired-intent" | "observed-implementation" = "observed-implementation",
  deletion = false,
) {
  const before = {
    claim_id: "CLAIM-MENTION",
    statement: "Ordinary messages require a mention.",
    scope: { surface: "ordinary-messages" },
  };
  const offeredAfter = {
    ...before,
    statement: "Pilot messages may receive replies without a mention.",
    scope: { surface: "pilot-only" },
  };
  const baseline = {
    projectId: "fixture",
    generation: 1,
    baselineSha256: sha("baseline"),
    modelId: "MODEL",
    modelSha256: sha("model"),
    canonSha256: sha("canon"),
    approvalReceiptSha256: sha("approval"),
    sourceClosureSha256: sha("sources"),
  };
  const purposeBody = {
    schemaVersion: 1 as const,
    kind: "docsfab-accepted-effect-revalidation" as const,
    subject,
    baseline,
    original: {
      comparisonSha256: sha("original-comparison"),
      outcomeSha256: sha("original-outcome"),
      findingSha256: sha("original-finding"),
      assertion:
        subject === "desired-intent"
          ? ("proposed-intent" as const)
          : ("observed-implementation" as const),
    },
    decision: {
      sourceRegistrationSha256: sha("original-registration"),
      selectedOptionId: "keep-approved" as const,
      approvalTargetSha256: sha("offered-target"),
      offeredDeltaSha256: sha("offered-delta"),
    },
    claim: { beforeRecordSha256: sha("before-record"), before, offeredAfter, expected: before },
    repository: {
      observationSha256: sha("observation"),
      priorComparisonReceiptSha256: sha("prior-comparison"),
      priorInputInventorySha256: sha("all-prior-inputs"),
      previousRevision: "a".repeat(40),
      previousTree: "b".repeat(40),
      observedRevision: "c".repeat(40),
      observedTree: "d".repeat(40),
      origin: { originalMergeAnchorSha256: sha("actual-origin"), revision: "e".repeat(40) },
      unavailableEvidenceIds: [],
    },
    facets: semanticAcceptedEffectFacets(before),
  };
  const purpose = parseHostRuntimeAcceptedEffectRevalidationData({
    ...purposeBody,
    purposeSha256: digest(purposeBody),
  });
  if (purpose.schemaVersion !== 1) throw new Error("The legacy fixture requires a V1 purpose.");
  const content = "export const requiresMention = true;\n";
  const chunk = sealHostRuntimeSemanticComparisonChunk({
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-chunk",
    projectId: baseline.projectId,
    caseKind: "source-case",
    caseSha256: sha("real-case"),
    comparisonSha256: sha("new-comparison"),
    baselineGeneration: baseline.generation,
    baselineSha256: baseline.baselineSha256,
    approvalReceiptSha256: baseline.approvalReceiptSha256,
    modelSha256: baseline.modelSha256,
    canonSha256: baseline.canonSha256,
    sourceInventorySha256: sha("inventory"),
    ordinal: 1,
    chunkCount: 1,
    claims: [
      {
        claimId: before.claim_id,
        statement: before.statement,
        statementSha256: sha(before.statement),
        scope: canonicalJson(before.scope),
        recordSha256: purpose.claim.beforeRecordSha256,
      },
    ],
    evidence: [
      {
        evidenceId: "current-evidence",
        kind: deletion ? "repository-before" : "repository-after",
        version: deletion
          ? purpose.repository.previousRevision
          : purpose.repository.observedRevision,
        sourcePath: "behavior.ts",
        change: deletion ? "deleted" : "context",
        content,
        contentSha256: sha(content),
        sourceContentSha256: sha(content),
        startByte: 0,
        endByte: Buffer.byteLength(content),
        totalBytes: Buffer.byteLength(content),
        sourceVersionSha256: sha("current-source"),
      },
    ],
    acceptedEffectRevalidation: purpose,
  });
  const proposal = {
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-proposal",
    inputSha256: chunk.inputSha256,
    assessments: [
      {
        evidenceId: "current-evidence",
        claimId: before.claim_id,
        relationship: "compatible",
        assertion: "observed-implementation",
        explanation: "Synthetic ordinary assessment, independent of purpose readiness.",
        scope: "Exact fixture scope.",
        confidence: "high",
        modelCitation: { evidenceId: before.claim_id, quote: before.statement },
        sourceCitations: [{ evidenceId: "current-evidence", quote: content }],
      },
    ],
    missingEvidence: [],
    acceptedEffectAssessments: purpose.facets.map((facet) => ({
      facetId: facet.facetId,
      relationship: "supports-full-facet",
      assertion: purpose.original.assertion,
      explanation:
        "Synthetic full-facet assessment for contract validation, not executed behavior.",
      intentCitation: { evidenceId: facet.facetId, quote: facet.content },
      sourceCitations: [{ evidenceId: "current-evidence", quote: content }],
    })),
  };
  return { chunk, purpose, proposal };
}

const implementationRole: HostRuntimeSemanticRepositoryRole = {
  sourceKind: "repository-source",
  classification: "implementation",
  coveragePlanSha256: sha("synthetic protected coverage plan"),
};

/** Synthetic transport data only; the host must independently bind these roles to actual custody. */
function withRepositoryRole(
  input: HostRuntimeSemanticComparisonChunkV1,
  repositoryRole: HostRuntimeSemanticRepositoryRole | undefined,
  snapshot = false,
): HostRuntimeSemanticComparisonChunkV1 {
  const { purposeSha256: _purpose, ...original } = input.acceptedEffectRevalidation!;
  const purposeBody = {
    ...original,
    schemaVersion: 2 as const,
    repository: snapshot
      ? { ...original.repository, previousRevision: null, previousTree: null, origin: null }
      : original.repository,
  };
  const purpose = parseHostRuntimeAcceptedEffectRevalidationData({
    ...purposeBody,
    purposeSha256: digest(purposeBody),
  });
  const { inputSha256: _input, ...body } = input;
  let corrective = input.correctiveProposalRevalidation;
  if (corrective) {
    const { purposeSha256: _corrective, ...originalCorrective } = corrective;
    const correctiveBody = {
      ...originalCorrective,
      acceptedEffectPurposeSha256: purpose.purposeSha256,
    };
    corrective = parseHostRuntimeCorrectiveProposalRevalidationData(
      { ...correctiveBody, purposeSha256: digest(correctiveBody) },
      purpose,
    );
  }
  return sealHostRuntimeSemanticComparisonChunk({
    ...body,
    acceptedEffectRevalidation: purpose,
    ...(corrective ? { correctiveProposalRevalidation: corrective } : {}),
    evidence: input.evidence.map((item) => ({
      ...item,
      ...(repositoryRole === undefined ? {} : { repositoryRole }),
    })),
  });
}

describe("role-aware V2 accepted-effect protocol", () => {
  it.each([false, true])("requires declared current implementation for snapshot=%s", (snapshot) => {
    const fixture = acceptedEffectFixture();
    const chunk = withRepositoryRole(fixture.chunk, implementationRole, snapshot);
    expect(
      parseHostRuntimeSemanticComparisonProposal(
        { ...fixture.proposal, inputSha256: chunk.inputSha256 },
        chunk,
      ).acceptedEffectAssessments,
    ).toHaveLength(fixture.purpose.facets.length);
    for (const role of [
      undefined,
      { ...implementationRole, sourceKind: "prd", classification: "context" },
      { ...implementationRole, sourceKind: "repository-documentation", classification: "context" },
      {
        ...implementationRole,
        sourceKind: "product-reference-model",
        classification: "own-projection",
      },
      { ...implementationRole, sourceKind: null, classification: "unclassified" },
    ] as const) {
      const changed = withRepositoryRole(fixture.chunk, role, snapshot);
      expect(() =>
        parseHostRuntimeSemanticComparisonProposal(
          { ...fixture.proposal, inputSha256: changed.inputSha256 },
          changed,
        ),
      ).toThrow(/accepted-effect-current-evidence/u);
    }
  });

  it("preserves desired-intent and V1 eligibility without adding role bytes", () => {
    const legacy = acceptedEffectFixture();
    const legacyBytes = canonicalJson(legacy.chunk);
    expect(
      parseHostRuntimeSemanticComparisonProposal(legacy.proposal, legacy.chunk)
        .acceptedEffectAssessments,
    ).toHaveLength(legacy.purpose.facets.length);
    expect(canonicalJson(legacy.chunk)).toBe(legacyBytes);
    expect(legacy.chunk.evidence.every((item) => !Object.hasOwn(item, "repositoryRole"))).toBe(
      true,
    );
    const intent = acceptedEffectFixture("desired-intent");
    const chunk = withRepositoryRole(
      intent.chunk,
      {
        ...implementationRole,
        sourceKind: "prd",
        classification: "context",
      },
      true,
    );
    expect(
      parseHostRuntimeSemanticComparisonProposal(
        { ...intent.proposal, inputSha256: chunk.inputSha256 },
        chunk,
      ).acceptedEffectAssessments!.every((row) => row.assertion === "proposed-intent"),
    ).toBe(true);
    const { inputSha256: _old, ...body } = chunk;
    const stale = sealHostRuntimeSemanticComparisonChunk({
      ...body,
      evidence: body.evidence.map((item) => ({ ...item, version: "f".repeat(40) })),
    });
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        { ...intent.proposal, inputSha256: stale.inputSha256 },
        stale,
      ),
    ).toThrow(/accepted-effect-current-evidence/u);
  });

  it("accepts only paired V2 null boundaries and preserves the original subject and seal", () => {
    const fixture = acceptedEffectFixture();
    const chunk = withRepositoryRole(fixture.chunk, implementationRole, true);
    const purpose = chunk.acceptedEffectRevalidation!;
    expect(purpose.schemaVersion).toBe(2);
    expect(purpose.repository).toMatchObject({
      previousRevision: null,
      previousTree: null,
      origin: null,
    });
    expect(purpose.facets).toEqual(fixture.purpose.facets);
    expect(canonicalJson(parseHostRuntimeAcceptedEffectRevalidationData(purpose))).toBe(
      canonicalJson(purpose),
    );
    const { purposeSha256: _hash, ...body } = purpose;
    for (const changed of [
      { ...body, schemaVersion: 1 },
      { ...body, repository: { ...body.repository, previousRevision: "a".repeat(40) } },
      { ...body, repository: { ...body.repository, previousTree: "b".repeat(40) } },
      { ...body, repository: { ...body.repository, origin: fixture.purpose.repository.origin } },
      { ...body, subject: "desired-intent" },
      { ...body, repository: { ...body.repository, observedTree: null } },
    ]) {
      expect(() =>
        parseHostRuntimeAcceptedEffectRevalidationData({
          ...changed,
          purposeSha256: digest(changed),
        }),
      ).toThrow();
    }
    expect(() =>
      parseHostRuntimeAcceptedEffectRevalidationData({ ...purpose, purposeSha256: sha("wrong") }),
    ).toThrow();
  });

  it("rejects malformed or inconsistent present roles and never accepts model role assignments", () => {
    const fixture = acceptedEffectFixture();
    const { inputSha256: _old, ...body } = withRepositoryRole(fixture.chunk, implementationRole);
    for (const role of [
      undefined,
      null,
      [],
      "implementation",
      { ...implementationRole, sourceKind: "verified-behavior" },
      { ...implementationRole, sourceKind: "prd" },
      { ...implementationRole, sourceKind: null },
      { ...implementationRole, classification: "context" },
      { ...implementationRole, classification: "unclassified" },
      { ...implementationRole, classification: "approved" },
      { ...implementationRole, coveragePlanSha256: "not-a-digest" },
      { sourceKind: "repository-source", classification: "implementation" },
      { ...implementationRole, approved: true },
    ]) {
      expect(() =>
        sealHostRuntimeSemanticComparisonChunk({
          ...body,
          evidence: body.evidence.map((item) => ({ ...item, repositoryRole: role })),
        } as never),
      ).toThrow();
    }
    // A role the reply assigns at the top level or on an assessment is ignored, never
    // accepted: the parsed proposal is the one without it.
    const unassigned = parseHostRuntimeSemanticComparisonProposal(fixture.proposal, fixture.chunk);
    for (const changed of [
      { ...fixture.proposal, repositoryRole: implementationRole },
      {
        ...fixture.proposal,
        assessments: fixture.proposal.assessments.map((row) => ({
          ...row,
          repositoryRole: implementationRole,
        })),
      },
    ])
      expect(parseHostRuntimeSemanticComparisonProposal(changed, fixture.chunk)).toEqual(
        unassigned,
      );
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        {
          ...fixture.proposal,
          acceptedEffectAssessments: fixture.proposal.acceptedEffectAssessments.map((row) => ({
            ...row,
            repositoryRole: implementationRole,
          })),
        },
        fixture.chunk,
      ),
    ).toThrow(/invalid-shape/u);
  });

  it("rejects unhashed and executable role properties before reading them", () => {
    const fixture = acceptedEffectFixture();
    let reads = 0;
    for (const descriptor of [
      { value: implementationRole, enumerable: false },
      {
        get: () => {
          reads += 1;
          return implementationRole;
        },
        enumerable: true,
      },
    ]) {
      const chunk = structuredClone(fixture.chunk);
      Object.defineProperty(chunk.evidence[0]!, "repositoryRole", descriptor);
      expect(() => parseHostRuntimeSemanticComparisonChunk(chunk)).toThrow();
    }
    expect(reads).toBe(0);
  });

  it("requires a whole role-bound current absence witness for implementation support", () => {
    const fixture = acceptedEffectFixture();
    const content = canonicalJson({
      kind: "docsfab-observed-repository-absence",
      path: "behavior.ts",
      revision: fixture.purpose.repository.observedRevision,
      tree: fixture.purpose.repository.observedTree,
      observationSha256: fixture.purpose.repository.observationSha256,
    });
    const { inputSha256: _old, ...body } = fixture.chunk;
    const absence = sealHostRuntimeSemanticComparisonChunk({
      ...body,
      evidence: body.evidence.map((item) => ({
        ...item,
        kind: "supporting-context",
        sourcePath: null,
        content,
        contentSha256: sha(content),
        sourceContentSha256: sha(content),
        endByte: Buffer.byteLength(content),
        totalBytes: Buffer.byteLength(content),
      })),
    });
    const proposal = {
      ...fixture.proposal,
      assessments: fixture.proposal.assessments.map((row) => ({
        ...row,
        sourceCitations: [{ evidenceId: row.evidenceId, quote: content }],
      })),
      acceptedEffectAssessments: fixture.proposal.acceptedEffectAssessments.map((row) => ({
        ...row,
        sourceCitations: [{ evidenceId: "current-evidence", quote: content }],
      })),
    };
    const chunk = withRepositoryRole(absence, implementationRole, true);
    expect(
      parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, inputSha256: chunk.inputSha256 },
        chunk,
      ).acceptedEffectAssessments,
    ).toHaveLength(fixture.purpose.facets.length);
    const context = withRepositoryRole(
      absence,
      { ...implementationRole, sourceKind: "repository-documentation", classification: "context" },
      true,
    );
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, inputSha256: context.inputSha256 },
        context,
      ),
    ).toThrow(/accepted-effect-current-evidence/u);
    const partial = {
      ...proposal,
      acceptedEffectAssessments: proposal.acceptedEffectAssessments.map((row) => ({
        ...row,
        sourceCitations: [
          { evidenceId: "current-evidence", quote: "docsfab-observed-repository-absence" },
        ],
      })),
    };
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        { ...partial, inputSha256: chunk.inputSha256 },
        chunk,
      ),
    ).toThrow(/accepted-effect-current-evidence/u);
  });
});

describe("accepted-effect protocol", () => {
  it.each(["desired-intent", "observed-implementation"] as const)(
    "keeps %s explicit and anchors every complete facet",
    (subject) => {
      const { chunk, proposal, purpose } = acceptedEffectFixture(subject);
      const parsed = parseHostRuntimeSemanticComparisonProposal(proposal, chunk);
      expect(parseHostRuntimeSemanticComparisonProposalData(parsed)).toEqual(parsed);
      expect(parsed.acceptedEffectAssessments).toHaveLength(purpose.facets.length);
      for (const [index, row] of parsed.acceptedEffectAssessments!.entries()) {
        expect(row.assertion).toBe(purpose.original.assertion);
        expect(row.intentCitation.sha256).toBe(purpose.facets[index]!.contentSha256);
        expect(row.intentCitation.startByte).toBe(0);
        expect(row.intentCitation.endByte).toBe(Buffer.byteLength(purpose.facets[index]!.content));
      }
      const downgraded = structuredClone(proposal);
      downgraded.acceptedEffectAssessments[0]!.assertion =
        subject === "desired-intent" ? "observed-implementation" : "proposed-intent";
      expect(() => parseHostRuntimeSemanticComparisonProposal(downgraded, chunk)).toThrow(
        /accepted-effect-current-evidence/u,
      );
    },
  );

  it("rejects omitted facets, partial intent quotes, stale non-deletion evidence and made-up approvals", () => {
    const { chunk, purpose, proposal } = acceptedEffectFixture();
    // A source quote the host cannot find verbatim cites the whole record it names.
    const paraphrased = structuredClone(proposal);
    paraphrased.acceptedEffectAssessments[0]!.sourceCitations[0]!.quote = "Not supplied";
    const whole = parseHostRuntimeSemanticComparisonProposal(paraphrased, chunk)
      .acceptedEffectAssessments![0]!.sourceCitations[0]!;
    const cited = chunk.evidence.find((item) => item.evidenceId === whole.evidenceId)!;
    expect(whole).toEqual({
      evidenceId: cited.evidenceId,
      startByte: 0,
      endByte: Buffer.byteLength(cited.content),
      sha256: cited.contentSha256,
    });
    for (const mutate of [
      (value: typeof proposal) => {
        value.acceptedEffectAssessments.pop();
      },
      (value: typeof proposal) => {
        value.acceptedEffectAssessments[0]!.intentCitation.quote = "Ordinary";
      },
      (value: typeof proposal) => {
        Object.assign(value.acceptedEffectAssessments[0]!, { approved: true });
      },
    ]) {
      const changed = structuredClone(proposal);
      mutate(changed);
      expect(() => parseHostRuntimeSemanticComparisonProposal(changed, chunk)).toThrow();
    }
    const { inputSha256: _, ...body } = chunk;
    const stale = sealHostRuntimeSemanticComparisonChunk({
      ...body,
      evidence: chunk.evidence.map((item) => ({
        ...item,
        kind: "repository-before",
        change: "modified",
        version: purpose.repository.previousRevision,
      })),
    });
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, inputSha256: stale.inputSha256 },
        stale,
      ),
    ).toThrow(/accepted-effect-current-evidence/u);
    const { purposeSha256: _sha, ...purposeBody } = purpose;
    const lower = { ...purposeBody, subject: "desired-intent" };
    expect(() =>
      parseHostRuntimeAcceptedEffectRevalidationData({ ...lower, purposeSha256: digest(lower) }),
    ).toThrow(/accepted-effect-subject/u);
    const widened = {
      ...purposeBody,
      claim: { ...purpose.claim, expected: purpose.claim.offeredAfter },
    };
    expect(() =>
      parseHostRuntimeAcceptedEffectRevalidationData({
        ...widened,
        purposeSha256: digest(widened),
      }),
    ).toThrow(/accepted-effect-selected-core/u);
  });

  it("requires a whole exact W absence witness and refuses old deletion bytes, spoofed prose or partial markers", () => {
    const fixture = acceptedEffectFixture("observed-implementation", true);
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(fixture.proposal, fixture.chunk),
    ).toThrow(/accepted-effect-current-evidence/u);
    const marker = {
      kind: "docsfab-observed-repository-absence",
      path: "behavior.ts",
      revision: fixture.purpose.repository.observedRevision,
      tree: fixture.purpose.repository.observedTree,
      observationSha256: fixture.purpose.repository.observationSha256,
    };
    const make = (
      body: Record<string, unknown> = marker,
      kind: HostRuntimeSemanticComparisonChunkV1["evidence"][number]["kind"] = "supporting-context",
      partial = false,
      quote?: string,
    ) => {
      const content = canonicalJson(body),
        { inputSha256: _old, ...before } = fixture.chunk;
      const source = {
        evidenceId: "absence-evidence",
        kind,
        version: fixture.purpose.repository.observedRevision,
        sourcePath: null,
        change: "context" as const,
        content,
        contentSha256: sha(content),
        sourceContentSha256: partial ? sha(`x${content}x`) : sha(content),
        startByte: partial ? 1 : 0,
        endByte: Buffer.byteLength(content) + (partial ? 1 : 0),
        totalBytes: Buffer.byteLength(content) + (partial ? 2 : 0),
        sourceVersionSha256: sha("actual-current-observation-source"),
      };
      const chunk = sealHostRuntimeSemanticComparisonChunk({
        ...before,
        evidence: [...before.evidence, source],
      });
      const citations = [{ evidenceId: source.evidenceId, quote: quote ?? content }];
      const proposal = {
        ...fixture.proposal,
        inputSha256: chunk.inputSha256,
        assessments: [
          ...fixture.proposal.assessments,
          {
            ...fixture.proposal.assessments[0]!,
            evidenceId: source.evidenceId,
            assertion:
              kind === "supporting-context" ? "observed-implementation" : "proposed-intent",
            sourceCitations: citations,
          },
        ],
        acceptedEffectAssessments: fixture.proposal.acceptedEffectAssessments.map((row) => ({
          ...row,
          sourceCitations: citations,
        })),
      };
      return { chunk, proposal };
    };
    const accepted = make();
    expect(
      parseHostRuntimeSemanticComparisonProposal(accepted.proposal, accepted.chunk)
        .acceptedEffectAssessments,
    ).toHaveLength(fixture.purpose.facets.length);
    for (const [body, kind, partial, quote] of [
      [
        { ...marker, revision: fixture.purpose.repository.previousRevision },
        "supporting-context",
        false,
        undefined,
      ],
      [{ ...marker, tree: "f".repeat(40) }, "supporting-context", false, undefined],
      [
        { ...marker, observationSha256: sha("foreign-observation") },
        "supporting-context",
        false,
        undefined,
      ],
      [{ ...marker, path: "../escape" }, "supporting-context", false, undefined],
      [{ ...marker, approved: true }, "supporting-context", false, undefined],
      [marker, "supporting-context", true, undefined],
      [marker, "supporting-context", false, marker.kind],
      [marker, "issue-observation", false, undefined],
      [marker, "proposed-intent", false, undefined],
    ] as const) {
      const changed = make(body, kind, partial, quote);
      expect(() =>
        parseHostRuntimeSemanticComparisonProposal(changed.proposal, changed.chunk),
      ).toThrow();
    }
  });

  it("never adds purpose or results to legacy packets", () => {
    const { chunk, proposal } = acceptedEffectFixture("observed-implementation");
    expect(
      parseHostRuntimeSemanticComparisonProposal(proposal, chunk).acceptedEffectAssessments,
    ).toHaveLength(2);
    const { inputSha256: _, acceptedEffectRevalidation: _purpose, ...legacyBody } = chunk;
    const legacy = sealHostRuntimeSemanticComparisonChunk(legacyBody);
    const { acceptedEffectAssessments: _effects, ...legacyProposal } = proposal;
    const result = parseHostRuntimeSemanticComparisonProposal(
      { ...legacyProposal, inputSha256: legacy.inputSha256 },
      legacy,
    );
    expect(Object.hasOwn(legacy, "acceptedEffectRevalidation")).toBe(false);
    expect(Object.hasOwn(result, "acceptedEffectAssessments")).toBe(false);
    expect(legacy.inputSha256).toBe(digest(legacyBody));
    for (const absent of [[], null]) {
      const normalized = parseHostRuntimeSemanticComparisonProposal(
        { ...legacyProposal, inputSha256: legacy.inputSha256, acceptedEffectAssessments: absent },
        legacy,
      );
      expect(Object.hasOwn(normalized, "acceptedEffectAssessments")).toBe(false);
      expect(parseHostRuntimeSemanticComparisonProposalData(normalized)).toEqual(normalized);
      const data = parseHostRuntimeSemanticComparisonProposalData({
        ...normalized,
        acceptedEffectAssessments: absent,
      });
      expect(Object.hasOwn(data, "acceptedEffectAssessments")).toBe(false);
    }
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, inputSha256: legacy.inputSha256 },
        legacy,
      ),
    ).toThrow(/accepted-effect-purpose-binding/u);
  });
});

function correctiveProtocolFixture(
  subject: "desired-intent" | "observed-implementation" = "observed-implementation",
  implementation:
    | "retained-deviation-present"
    | "aligned"
    | "not-established" = "retained-deviation-present",
) {
  const base = acceptedEffectFixture(subject),
    body = {
      schemaVersion: 1 as const,
      kind: "docsfab-corrective-proposal-revalidation" as const,
      acceptedEffectPurposeSha256: base.purpose.purposeSha256,
      proposal: {
        candidateManifestSha256: sha("actual candidate fixture binding"),
        recipeSha256: sha("recipe"),
        targetRoutePolicySha256: sha("routes"),
        targets: [
          {
            claimId: base.purpose.claim.before.claim_id,
            targetId: "requirements",
            path: "docs/requirements.md",
            delivery: "public-documentation" as const,
            heading: "Mention requirement",
          },
        ],
      },
    };
  const corrective = parseHostRuntimeCorrectiveProposalRevalidationData(
    { ...body, purposeSha256: digest(body) },
    base.purpose,
  );
  const { inputSha256: _old, ...input } = base.chunk;
  const chunk = sealHostRuntimeSemanticComparisonChunk({
    ...input,
    correctiveProposalRevalidation: corrective,
  });
  const gap = implementation === "retained-deviation-present";
  const proposal = {
    ...base.proposal,
    inputSha256: chunk.inputSha256,
    assessments: base.proposal.assessments.map((row) => ({
      ...row,
      relationship: gap ? "behavior-conflict" : "compatible",
      ...(gap
        ? {
            proposedClaim: {
              statement: base.purpose.claim.offeredAfter.statement,
              scope: base.purpose.claim.offeredAfter.scope,
            },
          }
        : {}),
    })),
    acceptedEffectAssessments: base.proposal.acceptedEffectAssessments.map((row) => ({
      ...row,
      relationship: gap ? "contradicts" : "supports-full-facet",
    })),
    correctiveProposalAssessments: base.purpose.facets.map((facet) => ({
      facetId: facet.facetId,
      applicability: "within-approved-scope",
      implementation,
      explanation:
        "Explicit synthetic scope classification; not publication or execution authority.",
      intentCitation: { evidenceId: facet.facetId, quote: facet.content },
      sourceCitations: [
        { evidenceId: chunk.evidence[0]!.evidenceId, quote: chunk.evidence[0]!.content },
      ],
      gapFindings: gap
        ? [
            {
              evidenceId: chunk.evidence[0]!.evidenceId,
              claimId: base.purpose.claim.before.claim_id,
            },
          ]
        : [],
    })),
  };
  return { ...base, chunk, corrective, proposal };
}

describe("corrective-proposal protocol", () => {
  it("retains literal H2 selectors and explicitly carries a null document-root selector", () => {
    const fixture = correctiveProtocolFixture();
    for (const heading of [null, "# A literal H2 title"]) {
      const { purposeSha256: _sha, ...body } = fixture.corrective;
      const changed = {
        ...body,
        proposal: {
          ...body.proposal,
          targets: body.proposal.targets.map((target) => ({ ...target, heading })),
        },
      };
      const parsed = parseHostRuntimeCorrectiveProposalRevalidationData(
        { ...changed, purposeSha256: digest(changed) },
        fixture.purpose,
      );
      expect(parsed.proposal.targets[0]!.heading).toBe(heading);
    }
    for (const heading of [false, [], {}, "", "one\ntwo"]) {
      const { purposeSha256: _sha, ...body } = fixture.corrective;
      const changed = {
        ...body,
        proposal: {
          ...body.proposal,
          targets: body.proposal.targets.map((target) => ({ ...target, heading })),
        },
      };
      expect(() =>
        parseHostRuntimeCorrectiveProposalRevalidationData(
          { ...changed, purposeSha256: digest(changed) },
          fixture.purpose,
        ),
      ).toThrow();
    }
  });
  it.each(["aligned", "partially-established", "retained-deviation-present"] as const)(
    "requires V2 implementation evidence for corrective state %s",
    (implementation) => {
      const fixture = correctiveProtocolFixture(
        "desired-intent",
        implementation === "retained-deviation-present" ? implementation : "aligned",
      );
      const proposal = {
        ...fixture.proposal,
        correctiveProposalAssessments: fixture.proposal.correctiveProposalAssessments.map(
          (row) => ({ ...row, implementation }),
        ),
      };
      const eligible = withRepositoryRole(fixture.chunk, implementationRole, true);
      expect(
        parseHostRuntimeSemanticComparisonProposal(
          { ...proposal, inputSha256: eligible.inputSha256 },
          eligible,
        ).correctiveProposalAssessments!.every((row) => row.implementation === implementation),
      ).toBe(true);
      for (const role of [
        undefined,
        { ...implementationRole, sourceKind: "prd", classification: "context" },
        {
          ...implementationRole,
          sourceKind: "repository-documentation",
          classification: "context",
        },
        { ...implementationRole, classification: "own-projection" },
        { ...implementationRole, sourceKind: null, classification: "unclassified" },
      ] as const) {
        const chunk = withRepositoryRole(fixture.chunk, role, true);
        expect(() =>
          parseHostRuntimeSemanticComparisonProposal(
            { ...proposal, inputSha256: chunk.inputSha256 },
            chunk,
          ),
        ).toThrow(/corrective-proposal-implementation-evidence/u);
      }
    },
  );

  it("keeps V2 applicability contextual while requiring each claimed gap's own current implementation citation", () => {
    const contextRole: HostRuntimeSemanticRepositoryRole = {
      ...implementationRole,
      sourceKind: "prd",
      classification: "context",
    };
    const applicability = correctiveProtocolFixture("desired-intent", "not-established");
    const contextual = withRepositoryRole(applicability.chunk, contextRole, true);
    expect(
      parseHostRuntimeSemanticComparisonProposal(
        { ...applicability.proposal, inputSha256: contextual.inputSha256 },
        contextual,
      ).correctiveProposalAssessments!.every(
        (row) => row.applicability === "within-approved-scope",
      ),
    ).toBe(true);

    const fixture = correctiveProtocolFixture("desired-intent");
    const { inputSha256: _hash, ...body } = withRepositoryRole(fixture.chunk, contextRole);
    const implementation = {
      ...body.evidence[0]!,
      evidenceId: "separate-implementation",
      sourcePath: "other-behavior.ts",
      repositoryRole: implementationRole,
    };
    const chunk = sealHostRuntimeSemanticComparisonChunk({
      ...body,
      evidence: [...body.evidence, implementation],
    });
    const proposal = {
      ...fixture.proposal,
      inputSha256: chunk.inputSha256,
      assessments: [
        ...fixture.proposal.assessments,
        {
          ...applicability.proposal.assessments[0]!,
          evidenceId: implementation.evidenceId,
          sourceCitations: [
            { evidenceId: implementation.evidenceId, quote: implementation.content },
          ],
        },
      ],
      correctiveProposalAssessments: fixture.proposal.correctiveProposalAssessments.map((row) => ({
        ...row,
        sourceCitations: [{ evidenceId: implementation.evidenceId, quote: implementation.content }],
      })),
    };
    expect(() => parseHostRuntimeSemanticComparisonProposal(proposal, chunk)).toThrow(
      /corrective-proposal-unbound-implementation-gap/u,
    );
  });

  it("keeps the implementation contradiction while binding a separate corrective applicability assessment", () => {
    const fixture = correctiveProtocolFixture();
    const value = parseHostRuntimeSemanticComparisonProposal(fixture.proposal, fixture.chunk);
    expect(value.acceptedEffectAssessments![0]!.relationship).toBe("contradicts");
    expect(value.acceptedEffectAssessments![0]!.assertion).toBe("observed-implementation");
    expect(value.correctiveProposalAssessments).toHaveLength(fixture.purpose.facets.length);
    expect(parseHostRuntimeSemanticComparisonProposalData(value)).toEqual(value);
    expect(fixture.chunk.acceptedEffectRevalidation).toEqual(fixture.purpose);
  });

  it("does not turn an intent-origin assessment or issue-only citation into a current implementation gap", () => {
    const fixture = correctiveProtocolFixture("desired-intent", "not-established");
    expect(
      parseHostRuntimeSemanticComparisonProposal(fixture.proposal, fixture.chunk)
        .correctiveProposalAssessments![0]!.implementation,
    ).toBe("not-established");
    const gap = correctiveProtocolFixture("desired-intent");
    gap.proposal.assessments[0]!.assertion = "proposed-intent";
    expect(() => parseHostRuntimeSemanticComparisonProposal(gap.proposal, gap.chunk)).toThrow(
      /unbound-implementation-gap/u,
    );
    const { inputSha256: _hash, ...body } = fixture.chunk;
    const issue = sealHostRuntimeSemanticComparisonChunk({
      ...body,
      evidence: body.evidence.map((value) => ({
        ...value,
        kind: "issue-observation",
        sourcePath: null,
      })),
    });
    const response = {
      ...fixture.proposal,
      inputSha256: issue.inputSha256,
      assessments: fixture.proposal.assessments.map((row) => ({
        ...row,
        assertion: "proposed-intent",
      })),
      acceptedEffectAssessments: fixture.proposal.acceptedEffectAssessments.map((row) => ({
        ...row,
        relationship: "not-informative",
        assertion: "unknown",
      })),
    };
    expect(() => parseHostRuntimeSemanticComparisonProposal(response, issue)).toThrow(
      /corrective-proposal-current-evidence/u,
    );
  });

  it("refuses unknown facets, partial requirement quotes, unbound gaps, widened alternatives and invented approval", () => {
    const fixture = correctiveProtocolFixture();
    for (const mutate of [
      (value: typeof fixture.proposal) => {
        value.correctiveProposalAssessments.pop();
      },
      (value: typeof fixture.proposal) => {
        value.correctiveProposalAssessments[0]!.intentCitation.quote = "Ordinary";
      },
      (value: typeof fixture.proposal) => {
        value.correctiveProposalAssessments[0]!.gapFindings[0]!.evidenceId = "missing";
      },
      (value: typeof fixture.proposal) => {
        value.assessments[0]!.proposedClaim!.scope = { surface: "all channels" };
      },
      (value: typeof fixture.proposal) => {
        Object.assign(value.correctiveProposalAssessments[0]!, { approved: true });
      },
    ]) {
      const changed = structuredClone(fixture.proposal);
      mutate(changed);
      expect(() => parseHostRuntimeSemanticComparisonProposal(changed, fixture.chunk)).toThrow();
    }
    const { purposeSha256: _sha, ...body } = fixture.corrective;
    const changed = { ...body, acceptedEffectPurposeSha256: sha("another actual choice") };
    expect(() =>
      parseHostRuntimeCorrectiveProposalRevalidationData(
        { ...changed, purposeSha256: digest(changed) },
        fixture.purpose,
      ),
    ).toThrow();
  });

  it("permits an actual documentation artifact to implement its own requirement without a filename or authorship ban", () => {
    const fixture = correctiveProtocolFixture("observed-implementation", "aligned");
    const statement = "The requirements page states that ordinary messages require a mention.";
    const before = { ...fixture.purpose.claim.before, statement };
    const { purposeSha256: _effect, ...old } = fixture.purpose;
    const purposeBody = {
      ...old,
      claim: { ...old.claim, before, expected: before },
      facets: semanticAcceptedEffectFacets(before),
    };
    const effect = parseHostRuntimeAcceptedEffectRevalidationData({
      ...purposeBody,
      purposeSha256: digest(purposeBody),
    });
    const { purposeSha256: _corrective, ...oldCorrective } = fixture.corrective;
    const correctiveBody = { ...oldCorrective, acceptedEffectPurposeSha256: effect.purposeSha256 };
    const corrective = parseHostRuntimeCorrectiveProposalRevalidationData(
      { ...correctiveBody, purposeSha256: digest(correctiveBody) },
      effect,
    );
    const content = "Ordinary messages require an explicit mention.\n",
      { inputSha256: _input, ...input } = fixture.chunk;
    const chunk = sealHostRuntimeSemanticComparisonChunk({
      ...input,
      acceptedEffectRevalidation: effect,
      correctiveProposalRevalidation: corrective,
      claims: input.claims.map((row) => ({ ...row, statement, statementSha256: sha(statement) })),
      evidence: input.evidence.map((row) => ({
        ...row,
        sourcePath: "docs/requirements.md",
        content,
        contentSha256: sha(content),
        sourceContentSha256: sha(content),
        endByte: Buffer.byteLength(content),
        totalBytes: Buffer.byteLength(content),
      })),
    });
    const response = {
      ...fixture.proposal,
      inputSha256: chunk.inputSha256,
      assessments: fixture.proposal.assessments.map((row) => ({
        ...row,
        modelCitation: { evidenceId: before.claim_id, quote: statement },
        sourceCitations: [{ evidenceId: "current-evidence", quote: content }],
      })),
      acceptedEffectAssessments: effect.facets.map((facet) => ({
        ...fixture.proposal.acceptedEffectAssessments[0]!,
        facetId: facet.facetId,
        intentCitation: { evidenceId: facet.facetId, quote: facet.content },
        sourceCitations: [{ evidenceId: "current-evidence", quote: content }],
      })),
      correctiveProposalAssessments: effect.facets.map((facet) => ({
        ...fixture.proposal.correctiveProposalAssessments[0]!,
        facetId: facet.facetId,
        intentCitation: { evidenceId: facet.facetId, quote: facet.content },
        sourceCitations: [{ evidenceId: "current-evidence", quote: content }],
      })),
    };
    expect(
      parseHostRuntimeSemanticComparisonProposal(
        response,
        chunk,
      ).correctiveProposalAssessments!.every((row) => row.implementation === "aligned"),
    ).toBe(true);
  });

  it("omits every adjunct byte when absent and refuses output without its bound purpose", () => {
    const base = acceptedEffectFixture();
    const before = canonicalJson(base.chunk),
      parsed = parseHostRuntimeSemanticComparisonProposal(base.proposal, base.chunk);
    expect(
      canonicalJson(
        sealHostRuntimeSemanticComparisonChunk((({ inputSha256: _, ...rest }) => rest)(base.chunk)),
      ),
    ).toBe(before);
    expect(Object.hasOwn(base.chunk, "correctiveProposalRevalidation")).toBe(false);
    expect(Object.hasOwn(parsed, "correctiveProposalAssessments")).toBe(false);
    const extra = correctiveProtocolFixture();
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        {
          ...base.proposal,
          correctiveProposalAssessments: extra.proposal.correctiveProposalAssessments,
        },
        base.chunk,
      ),
    ).toThrow(/corrective-proposal-purpose-binding/u);
  });
});

describe("document placement and accepted-effect separation", () => {
  it("preserves the accepted-effect packet and rejects a fresh placement policy inside it", () => {
    const fixture = acceptedEffectFixture();
    expect(parseHostRuntimeSemanticComparisonChunk(fixture.chunk)).toEqual(fixture.chunk);
    const { inputSha256: _, ...body } = fixture.chunk;
    expect(() =>
      sealHostRuntimeSemanticComparisonChunk({
        ...body,
        documentTargets: {
          schemaVersion: 2,
          kind: "docsfab-product-feedback-document-targets",
          targets: [
            {
              targetId: "guide",
              path: "docs/guide.md",
              delivery: "public-documentation",
              sourceKind: "repository-documentation",
            },
          ],
        },
      }),
    ).toThrow(/semantic-projection-is-not-effect-revalidation/u);
  });
});
