// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { verificationFixture } from "./helpers/verification.js";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AgentHarness } from "../src/execution/contracts.js";
import type {
  ContextPacket,
  ContextPreflightResult,
  ContextPreflightService,
  ContextPreflightTarget,
} from "../src/context/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { LocalContextPreflightService } from "../src/context/index.js";
import { listWorkflows } from "../src/workflow-registry/catalog.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { LocalAuthoringCandidateLifecycle } from "../src/workflow-execution/authoring-runtime.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { temporaryRoots } from "./helpers/temp.js";
import { initFixtureRepo } from "./helpers/git.js";

export interface registerContextRunnerScenariosInputs {
  readonly populateNoDoc: (destination: string) => Promise<void>;
}

export function registerContextRunnerScenarios(inputs: registerContextRunnerScenariosInputs): void {
  const scratchRoots = temporaryRoots();

  class MemoryStore implements RunStore {
    public records: RunRecord[] = [];

    public async save(record: RunRecord): Promise<void> {
      this.records.push(structuredClone(record));
    }
  }

  const revision = "a".repeat(40);
  const repository = {
    sourcePath: "/source/repository",
    requestedRevision: "HEAD",
    revision,
  };
  const passedScanner: RepositorySecurityScanner = {
    scan: async () => ({
      ruleSet: "test-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    }),
  };

  function readyResult(packet: ContextPacket): ContextPreflightResult {
    return {
      status: "ready",
      packetDigest: packet.digest,
      consultedNodeIds: ["node-b", "node-a", "node-a"],
      ontologyVersion: "ontology-v1",
      effectiveDecisionIds: ["decision-b", "decision-a"],
      measurements: {
        byteLength: 512,
        estimatedTokens: 128,
        latencyMs: 4,
      },
      cache: {
        disposition: "hit",
        keyDigest: "c".repeat(64),
        rebuildAttempted: false,
      },
      packet,
    };
  }

  async function runReadiness(options: {
    harness: AgentHarness;
    contextPreflight?: ContextPreflightService;
    contextTarget?: ContextPreflightTarget;
    scanner?: RepositorySecurityScanner;
  }): Promise<RunRecord> {
    return new WorkflowRunner({
      harness: options.harness,
      store: new MemoryStore(),
      repositoryScanner: options.scanner ?? passedScanner,
      ...(options.contextPreflight ? { contextPreflight: options.contextPreflight } : {}),
      id: () => "context-run",
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    }).run({
      workflow: "readiness",
      workspacePath: "/disposable/repository",
      repository,
      ...(options.contextTarget ? { contextTarget: options.contextTarget } : {}),
      allowWrite: false,
    });
  }

  describe("workflow context preflight", () => {
    it("defines one data-driven context policy for every catalog step", () => {
      for (const workflow of listWorkflows()) {
        expect(workflow.contextPolicy.schemaVersion).toBe(1);
        expect(workflow.contextPolicy.steps.map((policy) => policy.stepId)).toEqual(
          workflow.steps.map((step) => step.id),
        );
        expect(
          workflow.contextPolicy.steps.every(
            (policy) =>
              policy.required &&
              ["local", "change-scoped", "corpus"].includes(policy.level) &&
              typeof policy.allowReadOnlyDegraded === "boolean",
          ),
        ).toBe(true);
      }
    });

    it("runs after scanning and before skill inspection, passing packet evidence only in memory", async () => {
      const events: string[] = [];
      const packet = {
        schemaVersion: 1,
        digest: "b".repeat(64),
        userEvidence: "PRIVATE_CONTEXT_PACKET_SENTINEL",
      };
      let inspectedPacket: ContextPacket | undefined;
      let executedPacket: ContextPacket | undefined;
      const contextTarget = { sourcePath: "docs/setup.md", anchor: "install" };
      const scanner: RepositorySecurityScanner = {
        scan: async () => {
          events.push("scan");
          return passedScanner.scan("ignored");
        },
      };
      const contextPreflight: ContextPreflightService = {
        preflight: async (input) => {
          events.push("context");
          expect(input.repository.revision).toBe(revision);
          expect(input.policy).toMatchObject({
            stepId: "assess-readiness",
            level: "corpus",
            query: "expand",
          });
          expect(input.contextTarget).toEqual(contextTarget);
          return {
            ...readyResult(packet),
            // A provider cannot smuggle arbitrary packet content into the record.
            privatePayload: "RUN_RECORD_SENTINEL",
          } as ContextPreflightResult;
        },
      };
      const harness: AgentHarness = {
        inspectSkill: async (input) => {
          events.push("inspect");
          inspectedPacket = input.contextPacket;
          return undefined;
        },
        runStep: async (input) => {
          events.push("model");
          executedPacket = input.contextPacket;
          return { summary: "done" };
        },
      };

      const record = await runReadiness({
        harness,
        contextPreflight,
        contextTarget,
        scanner,
      });

      expect(events).toEqual(["scan", "context", "inspect", "model"]);
      expect(inspectedPacket).toBe(packet);
      expect(executedPacket).toBe(packet);
      expect(record.steps[0]?.contextPreflight).toEqual({
        status: "ready",
        packetDigest: "b".repeat(64),
        consultedNodeIds: ["node-a", "node-b"],
        ontologyVersion: "ontology-v1",
        effectiveDecisionIds: ["decision-a", "decision-b"],
        measurements: {
          byteLength: 512,
          estimatedTokens: 128,
          latencyMs: 4,
        },
        cache: {
          disposition: "hit",
          keyDigest: "c".repeat(64),
          rebuildAttempted: false,
        },
      });
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("PRIVATE_CONTEXT_PACKET_SENTINEL");
      expect(serialized).not.toContain("RUN_RECORD_SENTINEL");
    });

    it("allows degraded read-only context only when the catalog policy explicitly permits it", async () => {
      let modelCalls = 0;
      const record = await runReadiness({
        contextPreflight: {
          preflight: async () => ({
            status: "degraded",
            reason: "semantic-state-unavailable",
          }),
        },
        harness: {
          runStep: async () => {
            modelCalls += 1;
            return { summary: "bounded read-only result" };
          },
        },
      });

      expect(record.status).toBe("succeeded");
      expect(modelCalls).toBe(1);
      expect(record.steps[0]?.contextPreflight).toEqual({
        status: "degraded",
        reason: "semantic-state-unavailable",
      });
    });

    it("fails closed when the preflight service fails, even for read-only work", async () => {
      let modelCalls = 0;
      const record = await runReadiness({
        contextPreflight: {
          preflight: async () => {
            throw new Error("PRIVATE_PROVIDER_FAILURE_SENTINEL");
          },
        },
        harness: {
          runStep: async () => {
            modelCalls += 1;
            return { summary: "must not run" };
          },
        },
      });

      expect(record.status).toBe("failed");
      expect(record.steps[0]?.contextPreflight).toEqual({
        status: "failed",
        reason: "preflight-internal-failure",
      });
      expect(record.steps[0]?.error).not.toContain("PRIVATE_PROVIDER_FAILURE_SENTINEL");
      expect(modelCalls).toBe(0);
    });

    it("fails a write step before skill inspection or inference when context is degraded", async () => {
      let harnessCalls = 0;
      const runner = new WorkflowRunner({
        harness: {
          inspectSkill: async () => {
            harnessCalls += 1;
            return undefined;
          },
          runStep: async () => {
            harnessCalls += 1;
            return { summary: "must not run" };
          },
        },
        store: new MemoryStore(),
        repositoryScanner: passedScanner,
        contextPreflight: {
          preflight: async () => ({
            status: "degraded",
            reason: "semantic-state-unavailable",
          }),
        },
        repositoryEvidence: {
          capture: async () => ({
            files: [],
            patch: {
              sha256: "d".repeat(64),
              byteLength: 0,
              lineCount: 0,
              artifactPath: "/durable/empty.patch",
              format: "git-diff",
            },
          }),
        },
        id: () => "write-context-run",
        now: () => new Date("2026-08-03T12:00:00.000Z"),
      });

      const record = await runner.run({
        workflow: "bootstrap",
        workspacePath: "/disposable/repository",
        repository,
        allowWrite: true,
      });

      expect(record.status).toBe("failed");
      expect(record.steps[0]?.status).toBe("failed");
      expect(record.steps[0]?.contextPreflight?.status).toBe("degraded");
      expect(harnessCalls).toBe(0);
    });

    it("fails closed when a required preflight service is not injected", async () => {
      let harnessCalls = 0;
      const record = await runReadiness({
        harness: {
          runStep: async () => {
            harnessCalls += 1;
            return { summary: "must not run" };
          },
        },
      });

      expect(record.status).toBe("failed");
      expect(record.steps[0]?.contextPreflight).toEqual({
        status: "failed",
        reason: "preflight-internal-failure",
      });
      expect(harnessCalls).toBe(0);
    });

    it("continues to context when repository findings are diagnostic", async () => {
      let contextCalls = 0;
      let harnessCalls = 0;
      const record = await runReadiness({
        scanner: {
          scan: async () => ({
            ruleSet: "test-v1",
            status: "blocked",
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [{ path: "README.md", ruleId: "credential.test" }],
          }),
        },
        contextPreflight: {
          preflight: async () => {
            contextCalls += 1;
            throw new Error("must not run");
          },
        },
        harness: {
          runStep: async () => {
            harnessCalls += 1;
            return { summary: "must not run" };
          },
        },
      });

      expect(record.status).toBe("failed");
      expect(record.steps[0]?.contextPreflight).toEqual({
        status: "failed",
        reason: "preflight-internal-failure",
      });
      expect(record.securityScanEffectiveDisposition).toEqual({ status: "advisory" });
      expect(contextCalls).toBe(1);
      expect(harnessCalls).toBe(0);
    });

    it("authorizes lint and later evaluate after a no-doc write adds nested markdown", async () => {
      const root = await scratchRoots.create("docsfab-context-runner-no-doc-");
      const workspace = resolve(root, "repository");
      await inputs.populateNoDoc(workspace);
      const createRevision = await initFixtureRepo(
        workspace,
        { "src/api.ts": "export const api = true;\n" },
        { branch: "main", message: "context fixture" },
      );
      const createRepository = {
        sourcePath: workspace,
        requestedRevision: createRevision,
        revision: createRevision,
      };
      const authoringWorkspace = await prepareRepositoryWorkspace(workspace, createRevision);
      const artifacts = await mkdtemp(resolve(tmpdir(), "docsfab-context-runner-artifacts-"));
      const evidenceCollector = await GitPatchEvidenceCollector.create(
        authoringWorkspace.path,
        artifacts,
      );
      const hostOperations = { runStep: async () => ({ summary: "Fixture lint passed" }) };
      const sourceObserver = new LocalSourceObligationSourceObserver(authoringWorkspace);
      const authoringLifecycle = new LocalAuthoringCandidateLifecycle({
        workspace: authoringWorkspace,
        evidenceCollector,
        search: new LocalWorkflowSearchCoordinator(),
        sourceObserver,
        hostOperations,
        artifactDirectory: artifacts,
      });
      const store = new MemoryStore();
      let record: RunRecord;
      try {
        record = await new WorkflowRunner({
          hostOperations,
          authoringCandidateLifecycle: authoringLifecycle,
          workflowSearch: new LocalWorkflowSearchCoordinator(),
          sourceObligationObserver: sourceObserver,
          harness: {
            runStep: async (input) => {
              if (input.step.id === "write-documentation") {
                await mkdir(resolve(input.repositoryPath, "docs"), { recursive: true });
                await writeFile(
                  resolve(input.repositoryPath, "docs/get-started.md"),
                  "# Getting Started\n\nIntro.\n\n## Check the documentation\n\nDetails.\n",
                  "utf8",
                );
              }
              return {
                summary:
                  input.step.id === "review-documentation"
                    ? canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd()
                    : `${input.step.id} complete`,
                ...(await verificationFixture(input)),
                ...(input.step.id === "plan-documentation"
                  ? {
                      planBinding: documentationPlanBinding(
                        "create",
                        "docs/get-started.md",
                        "src/api.ts:1",
                      ),
                    }
                  : {}),
              };
            },
          },
          store,
          repositoryScanner: passedScanner,
          contextPreflight: new LocalContextPreflightService({
            cacheRoot: resolve(root, "cache"),
          }),
          repositoryEvidence: evidenceCollector,
          id: () => "no-doc-write-context-run",
          now: () => new Date("2026-08-03T12:00:00.000Z"),
        }).run({
          workflow: "create-documentation",
          workspacePath: authoringWorkspace.path,
          repository: createRepository,
          allowWrite: true,
        });
      } finally {
        await evidenceCollector.dispose();
        await authoringWorkspace.dispose();
        await rm(artifacts, { recursive: true, force: true });
      }

      expect(record.status).toBe("succeeded");
      expect(record.steps.map((step) => [step.id, step.contextPreflight?.status])).toEqual([
        ["plan-documentation", "unnecessary"],
        ["derive-source-obligations", "unnecessary"],
        ["write-documentation", "unnecessary"],
        ["lint-documentation", "ready"],
        ["provisional-technical-verification", "ready"],
        ["review-documentation", "ready"],
        ["verify-technical-accuracy", "ready"],
        ["test-audience-understanding", "ready"],
        ["evaluate-document-quality", "ready"],
      ]);
      expect(record.authoringExecution?.selectedCandidate).toMatchObject({
        ordinal: 0,
        artifactName: "candidate-0.patch",
      });
    });
  });

  describe("read-only steps after a write (#1924)", () => {
    it("runs the read-only steps after a write without a packet when the written page makes the compile fail", async () => {
      const root = await scratchRoots.create("docsfab-context-runner-after-write-");
      const workspace = resolve(root, "repository");
      await inputs.populateNoDoc(workspace);
      const createRevision = await initFixtureRepo(
        workspace,
        { "src/api.ts": "export const api = true;\n" },
        { branch: "main", message: "context fixture" },
      );
      const authoringWorkspace = await prepareRepositoryWorkspace(workspace, createRevision);
      const artifacts = await mkdtemp(resolve(tmpdir(), "docsfab-context-runner-artifacts-"));
      const evidenceCollector = await GitPatchEvidenceCollector.create(
        authoringWorkspace.path,
        artifacts,
      );
      const hostOperations = { runStep: async () => ({ summary: "Fixture lint passed" }) };
      const sourceObserver = new LocalSourceObligationSourceObserver(authoringWorkspace);
      const modelSteps: string[] = [];
      let record: RunRecord;
      try {
        record = await new WorkflowRunner({
          hostOperations,
          authoringCandidateLifecycle: new LocalAuthoringCandidateLifecycle({
            workspace: authoringWorkspace,
            evidenceCollector,
            search: new LocalWorkflowSearchCoordinator(),
            sourceObserver,
            hostOperations,
            artifactDirectory: artifacts,
          }),
          workflowSearch: new LocalWorkflowSearchCoordinator(),
          sourceObligationObserver: sourceObserver,
          harness: {
            runStep: async (input) => {
              modelSteps.push(input.step.id);
              if (input.step.id === "write-documentation") {
                await mkdir(resolve(input.repositoryPath, "docs"), { recursive: true });
                // The fence language is decomposed (NFD): the index records it,
                // and the compiler's own decoder refuses it as `invalid-input`.
                await writeFile(
                  resolve(input.repositoryPath, "docs/get-started.md"),
                  `# Getting Started\n\nIntro.\n\n\`\`\`cafe${String.fromCodePoint(0x301)}\nprint(1)\n\`\`\`\n`,
                  "utf8",
                );
              }
              return {
                summary:
                  input.step.id === "review-documentation"
                    ? canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd()
                    : `${input.step.id} complete`,
                ...(await verificationFixture(input)),
                ...(input.step.id === "plan-documentation"
                  ? {
                      planBinding: documentationPlanBinding(
                        "create",
                        "docs/get-started.md",
                        "src/api.ts:1",
                      ),
                    }
                  : {}),
              };
            },
          },
          store: new MemoryStore(),
          repositoryScanner: passedScanner,
          contextPreflight: new LocalContextPreflightService({
            cacheRoot: resolve(root, "cache"),
          }),
          repositoryEvidence: evidenceCollector,
          id: () => "after-write-context-run",
          now: () => new Date("2026-10-06T12:00:00.000Z"),
        }).run({
          workflow: "create-documentation",
          workspacePath: authoringWorkspace.path,
          repository: {
            sourcePath: workspace,
            requestedRevision: createRevision,
            revision: createRevision,
          },
          allowWrite: true,
        });
      } finally {
        await evidenceCollector.dispose();
        await authoringWorkspace.dispose();
        await rm(artifacts, { recursive: true, force: true });
      }

      // Before #1924 the first step after the write stopped the run with
      // `preflight-internal-failure`; now every read-only step runs on.
      expect(record.status, record.error).toBe("succeeded");
      const compileFailed = {
        status: "degraded",
        reason: "context-compile-failed",
        cause: {
          code: "invalid-input",
          message:
            "The context compiler returned invalid-input (context-rebuild-failed) for the input DocsFab built.",
        },
      };
      expect(
        record.steps.map((step) => [
          step.id,
          step.contextPreflight?.status,
          step.contextPreflight?.reason,
        ]),
      ).toEqual([
        ["plan-documentation", "unnecessary", "target-not-applicable"],
        ["derive-source-obligations", "unnecessary", "target-not-applicable"],
        ["write-documentation", "unnecessary", "target-not-applicable"],
        ["lint-documentation", "degraded", "context-compile-failed"],
        ["provisional-technical-verification", "degraded", "context-compile-failed"],
        ["review-documentation", "degraded", "context-compile-failed"],
        ["verify-technical-accuracy", "degraded", "context-compile-failed"],
        ["test-audience-understanding", "degraded", "context-compile-failed"],
        ["evaluate-document-quality", "degraded", "context-compile-failed"],
      ]);
      for (const step of record.steps.slice(3)) {
        expect(step.contextPreflight, step.id).toMatchObject(compileFailed);
      }
      expect(modelSteps).toContain("review-documentation");
    });
  });

  function documentationPlanBinding(
    mode: "create" | "update" | "restructure",
    pagePath: string,
    sourcePath = "README.md",
  ) {
    const pages = [{ path: pagePath, disposition: mode }];
    const sourceBindings = [{ pagePath, sources: [sourcePath] }];
    return {
      kind: "docsfab-documentation-plan" as const,
      schemaVersion: 1 as const,
      mode,
      pages,
      sourceBindings,
      digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
    };
  }
}
