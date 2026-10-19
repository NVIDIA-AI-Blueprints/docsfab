// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { admitAuthorizedTrackedWrites } from "../src/repository/workspace/tracked-read.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  canonicalSourceObligationProposal,
  decodeProvisionalRichJudgment,
  validateProvisionalRichCandidateEvidence,
} from "../src/workflow-execution/source-obligation.js";
import { recordedReviewJudgmentFixture } from "./helpers/recorded-review-judgment.js";
import {
  countSourceLines,
  LocalSourceObligationSourceObserver,
} from "../src/workflow-execution/source-obligation-observer.js";
import { LocalAuthoringCandidateLifecycle } from "../src/workflow-execution/authoring-runtime.js";
import { sourceObligationProposalFixture, verificationFixture } from "./helpers/verification.js";
import { git, initFixtureRepo } from "./helpers/git.js";

describe("source-obligation runtime contracts", () => {
  it("seals exact provisional candidate bytes and refuses broken ledger links", () => {
    const fixture = recordedReviewJudgmentFixture("/workspace");
    const issue = (
      fixture.judgment.issueJudgments as Array<{ id: string; obligationIds: string[] }>
    )[0]!;
    const candidate = {
      issueId: issue.id,
      obligationIds: issue.obligationIds,
      title: "A source behavior is missing",
      readerConsequence: "Readers can select the wrong behavior.",
      proposedEdit: {
        kind: "advice",
        text: "  Document the source behavior and its e\u0301 qualification.\r\n",
      },
    };
    const reply = {
      kind: "docsfab-provisional-rich-judgment",
      schemaVersion: 1,
      judgment: fixture.judgment,
      richCandidates: [candidate],
    };
    const admitted = decodeProvisionalRichJudgment(
      JSON.stringify(reply),
      fixture.ledger,
      fixture.targets,
    );
    expect(admitted.evidence.candidates[0]).toMatchObject(candidate);
    expect(admitted.evidence.candidates[0]?.proposedEdit.text).toBe(candidate.proposedEdit.text);
    const replacement = decodeProvisionalRichJudgment(
      JSON.stringify({
        ...reply,
        richCandidates: [
          {
            ...candidate,
            proposedEdit: {
              kind: "replacement",
              text: "Remove the stale sentence.\r\n",
              path: fixture.targets[0],
              originalText: "The stale sentence.\r\n",
              replacementText: "",
            },
          },
        ],
      }),
      fixture.ledger,
      fixture.targets,
    );
    expect(replacement.evidence.candidates[0]?.proposedEdit).toMatchObject({
      originalText: "The stale sentence.\r\n",
      replacementText: "",
    });
    expect(
      validateProvisionalRichCandidateEvidence(
        admitted.evidence,
        fixture.ledger,
        admitted.verificationResult,
        fixture.targets,
      ),
    ).toEqual(admitted.evidence);
    expect(() =>
      decodeProvisionalRichJudgment(
        JSON.stringify({
          ...reply,
          richCandidates: [{ ...candidate, obligationIds: [] }],
        }),
        fixture.ledger,
        fixture.targets,
      ),
    ).toThrow();
    expect(() =>
      decodeProvisionalRichJudgment(
        JSON.stringify({
          ...reply,
          richCandidates: [
            { ...candidate, proposedEdit: { kind: "advice", text: "invalid\ud800" } },
          ],
        }),
        fixture.ledger,
        fixture.targets,
      ),
    ).toThrow();
    expect(() =>
      validateProvisionalRichCandidateEvidence(
        {
          ...admitted.evidence,
          extra: "unbound",
        },
        fixture.ledger,
        admitted.verificationResult,
        fixture.targets,
      ),
    ).toThrow();
  });
  it("names the revision's tracked regular files, not links, submodules, directories or untracked files", async () => {
    const fixture = await repositoryFixture();
    // Tracked entries that are not regular files: a symbolic link and a
    // submodule entry (a gitlink, here naming the fixture's own commit).
    await symlink("guide.md", join(fixture.source, "docs/alias.md"));
    await git(fixture.source, ["add", "docs/alias.md"]);
    const head = await git(fixture.source, ["rev-parse", "HEAD"]);
    await git(fixture.source, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},vendor/lib`,
    ]);
    await git(fixture.source, ["commit", "-q", "-m", "track a link and a submodule entry"]);
    expect(
      await git(fixture.source, ["ls-files", "--stage", "docs/alias.md", "vendor/lib"]),
    ).toMatch(/^120000 [0-9a-f]+ 0\tdocs\/alias\.md\n160000 [0-9a-f]+ 0\tvendor\/lib$/u);
    const workspace = await prepareRepositoryWorkspace(fixture.source, "HEAD");
    try {
      await writeFile(join(workspace.path, "untracked.md"), "# Not tracked\n");
      const tracked = await new LocalSourceObligationSourceObserver(
        workspace,
      ).trackedRegularPaths();
      expect([...tracked].sort()).toEqual([
        "docs/guide.md",
        "src/Alpha.ts",
        "src/api.ts",
        "src/extra.ts",
      ]);
    } finally {
      await workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails actual source drift before the CREATE writer is invoked", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.source, "HEAD");
    const artifacts = await mkdtemp(join(tmpdir(), "docsfab-source-obligation-artifacts-"));
    const evidenceCollector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
    try {
      const observer = new LocalSourceObligationSourceObserver(workspace);
      const calls: string[] = [];
      let checkedWriterBoundary = false;
      const workflowSearch = new LocalWorkflowSearchCoordinator({ workspace });
      const hostOperations = {
        runStep: async (input: HarnessStepInput) => ({
          summary: `ran ${input.step.id}`,
          ...(await verificationFixture(input)),
        }),
      };
      const authoringCandidateLifecycle = new LocalAuthoringCandidateLifecycle({
        workspace,
        evidenceCollector,
        search: workflowSearch,
        sourceObserver: observer,
        hostOperations,
        artifactDirectory: artifacts,
      });
      const savedRecords: RunRecord[] = [];
      let deriveCalls = 0;
      const runner = new WorkflowRunner({
        harness: {
          async runStep(input) {
            calls.push(input.step.id);
            if (input.step.id === "plan-documentation") {
              const planBinding = createPlanBinding("docs/new-guide.md", [
                `src/api.ts:1@${workspace.revision}`,
              ]);
              return { summary: "Bounded documentation plan.", planBinding };
            }
            if (input.step.id === "derive-source-obligations") {
              deriveCalls += 1;
              if (deriveCalls === 1) {
                throw new InferenceStepError(
                  "Temporary provider transport failure.",
                  "provider-transient",
                  true,
                );
              }
              const judgedReply = deriveCalls - 1;
              const proposalBase = sourceObligationProposalFixture("src/api.ts:1");
              let proposal: typeof proposalBase;
              if (judgedReply === 1) {
                proposal = {
                  ...proposalBase,
                  sourceProposals: [
                    { path: "src/extra.ts", reason: "It defines the companion API export." },
                    {
                      path: "docs/new-guide.md",
                      reason: "The page describes the API's public shape.",
                    },
                  ],
                };
              } else {
                proposal = {
                  ...proposalBase,
                  dimensions: proposalBase.dimensions.map((dimension, index) =>
                    index === 0 ? { ...dimension, sourceLocators: ["src/extra.ts:1"] } : dimension,
                  ),
                };
              }
              return {
                summary: canonicalSourceObligationProposal(proposal),
                sourceObligationProposal: proposal,
              };
            }
            return { summary: `ran ${input.step.id}`, ...(await verificationFixture(input)) };
          },
        },
        hostOperations,
        store: {
          save: async (saved) => {
            savedRecords.push(structuredClone(saved));
          },
        },
        repositoryScanner: passingScanner,
        contextPreflight: unnecessaryPreflight,
        workflowSearch,
        sourceObligationObserver: {
          observe: (paths) => observer.observe(paths),
          captureOriginalSourceAuthority: (input) => observer.captureOriginalSourceAuthority(input),
          admitOriginalSourceAuthorityProposals: (input) =>
            observer.admitOriginalSourceAuthorityProposals(input),
          assertUnchanged: async (sources, candidatePaths) => {
            if (!checkedWriterBoundary) {
              checkedWriterBoundary = true;
              await writeFile(join(workspace.path, "src", "api.ts"), "export const value = 2;\n");
            }
            await observer.assertUnchanged(sources, candidatePaths);
          },
        },
        repositoryEvidence: {
          capture: async () => ({
            files: [],
            patch: {
              sha256: "0".repeat(64),
              byteLength: 0,
              lineCount: 0,
              artifactPath: "/private/state/source-drift.patch",
              format: "git-diff" as const,
            },
          }),
        },
        authoringCandidateLifecycle,
        retryPolicy: {
          maxRetries: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          retryableCategories: ["malformed-response", "provider-transient"],
        },
        retrySleep: async () => undefined,
        id: () => "run-source-obligation-create-drift",
      });

      const record = await runner.run({
        workflow: "create-documentation",
        workspacePath: workspace.path,
        repository: {
          sourcePath: fixture.source,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
        instruction: "Create a bounded API guide.",
        allowWrite: true,
      });

      expect(record.status).toBe("failed");
      expect(record.error).toBe("Tracked repository file read failed: changed.");
      expect(checkedWriterBoundary).toBe(true);
      expect(
        record.steps.find((step) => step.id === "derive-source-obligations")?.inference?.attempts,
      ).toMatchObject([
        { attempt: 1, outcome: "provider-transient" },
        { attempt: 2, outcome: "malformed-response" },
        { attempt: 3, outcome: "succeeded" },
      ]);
      expect(
        record.steps.find((step) => step.id === "derive-source-obligations")
          ?.sourceProposalAdmissions,
      ).toMatchObject([
        {
          attempt: 2,
          path: "src/extra.ts",
          reason: "It defines the companion API export.",
          status: "admitted",
        },
        {
          attempt: 2,
          path: "docs/new-guide.md",
          status: "refused",
          refusalCode: "write-target-source",
        },
      ]);
      expect(
        record.steps
          .find((step) => step.id === "derive-source-obligations")
          ?.originalSourceAuthority?.members.map(({ path }) => path),
      ).toContain("src/extra.ts");
      expect(calls).toEqual([
        "plan-documentation",
        "derive-source-obligations",
        "derive-source-obligations",
        "derive-source-obligations",
      ]);
      expect(
        savedRecords.some((saved) =>
          saved.steps
            .find((step) => step.id === "derive-source-obligations")
            ?.sourceProposalAdmissions?.some(
              (entry) => entry.path === "docs/new-guide.md" && entry.status === "refused",
            ),
        ),
      ).toBe(true);
      expect(record.steps.find((step) => step.id === "write-documentation")?.status).toBe("failed");
    } finally {
      await evidenceCollector.dispose();
      await workspace.dispose();
      await rm(artifacts, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a wrong-revision CREATE source before derivation inference", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.source, "HEAD");
    const artifacts = await mkdtemp(join(tmpdir(), "docsfab-source-obligation-artifacts-"));
    const evidenceCollector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
    try {
      const calls: string[] = [];
      const workflowSearch = new LocalWorkflowSearchCoordinator({ workspace });
      const sourceObserver = new LocalSourceObligationSourceObserver(workspace);
      const hostOperations = {
        runStep: async (input: HarnessStepInput) => ({
          summary: `ran ${input.step.id}`,
          ...(await verificationFixture(input)),
        }),
      };
      const authoringCandidateLifecycle = new LocalAuthoringCandidateLifecycle({
        workspace,
        evidenceCollector,
        search: workflowSearch,
        sourceObserver,
        hostOperations,
        artifactDirectory: artifacts,
      });
      const runner = new WorkflowRunner({
        harness: {
          async runStep(input) {
            calls.push(input.step.id);
            if (input.step.id === "plan-documentation") {
              return {
                summary: "Bounded documentation plan.",
                planBinding: createPlanBinding("docs/new-guide.md", [
                  `src/api.ts:1@${"b".repeat(40)}`,
                ]),
              };
            }
            return { summary: `ran ${input.step.id}`, ...(await verificationFixture(input)) };
          },
        },
        hostOperations,
        store: { save: async () => undefined },
        repositoryScanner: passingScanner,
        contextPreflight: unnecessaryPreflight,
        workflowSearch,
        sourceObligationObserver: sourceObserver,
        authoringCandidateLifecycle,
        id: () => "run-source-obligation-wrong-revision",
      });
      const record = await runner.run({
        workflow: "create-documentation",
        workspacePath: workspace.path,
        repository: {
          sourcePath: fixture.source,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
        instruction: "Create a bounded API guide.",
        allowWrite: true,
      });
      expect(record.status).toBe("failed");
      expect(record.error).toContain("another repository revision");
      expect(calls).toEqual(["plan-documentation"]);
      expect(record.steps.find((step) => step.id === "derive-source-obligations")?.status).toBe(
        "failed",
      );
    } finally {
      await evidenceCollector.dispose();
      await workspace.dispose();
      await rm(artifacts, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("carries one canonical ledger through the real REVIEW runner and stores only final correction", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.source, "HEAD");
    try {
      const calls: HarnessStepInput[] = [];
      const records: RunRecord[] = [];
      const harness = {
        async runStep(input: HarnessStepInput) {
          calls.push(input);
          return {
            summary: `ran ${input.step.id}`,
            ...(await verificationFixture(input)),
          };
        },
      };
      const runner = new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: {
          save: async (record) => {
            records.push(structuredClone(record));
          },
        } satisfies RunStore,
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "source-obligation-fixture",
            status: "passed" as const,
            scannedFiles: 2,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: {
          preflight: async () => ({
            status: "unnecessary" as const,
            reason: "target-not-applicable",
          }),
        },
        workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
        sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
        id: () => "run-source-obligation-review",
      });
      const record = await runner.run({
        workflow: "review-documentation",
        workspacePath: workspace.path,
        repository: {
          sourcePath: fixture.source,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
        contextTarget: { sourcePath: "docs/guide.md" },
        allowWrite: false,
      });

      expect(record.status, record.error).toBe("succeeded");
      const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
      const provisional = record.steps.find(
        (step) => step.id === "provisional-technical-verification",
      )!;
      const final = record.steps.find((step) => step.id === "verify-technical-accuracy")!;
      expect(derive.summary).toContain("docsfab-source-obligation-ledger");
      expect(JSON.parse(derive.summary!).schemaVersion).toBe(2);
      expect(derive.originalSourceAuthority).toMatchObject({
        kind: "docsfab-original-source-authority-evidence",
      });
      expect(
        record.steps
          .filter((step) => step.originalSourceAuthority !== undefined)
          .map((step) => step.id),
      ).toEqual(["derive-source-obligations"]);
      expect(provisional.technicalCorrectionEvidence).toBeUndefined();
      expect(final.technicalCorrectionEvidence).toMatchObject({
        kind: "docsfab-technical-correction-evidence",
        schemaVersion: 3,
        proposal: { obligationAccounting: [] },
      });
      const ledgerInputs = calls
        .filter((input) =>
          ["provisional-technical-verification", "verify-technical-accuracy"].includes(
            input.step.id,
          ),
        )
        .map((input) => input.sourceObligationLedger);
      expect(ledgerInputs).toHaveLength(2);
      expect(ledgerInputs[0]).toEqual(ledgerInputs[1]);
      // Only the judgment steps receive the sealed sources' line counts.
      const sealedSources = ledgerInputs[0]!.identity.sources;
      expect(sealedSources.length).toBeGreaterThan(0);
      const expectedLines = await Promise.all(
        sealedSources.map(async ({ path, sha256 }) => ({
          path,
          sha256,
          lineCount: countSourceLines(await readFile(join(fixture.source, path))),
        })),
      );
      for (const input of calls) {
        const judgmentStep = [
          "provisional-technical-verification",
          "verify-technical-accuracy",
        ].includes(input.step.id);
        expect(input.admittedSourceLineCounts, input.step.id).toEqual(
          judgmentStep ? expectedLines : undefined,
        );
      }
      expect(records.at(-1)?.steps.find((step) => step.id === final.id)).toEqual(final);
    } finally {
      await workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("cancellation after provisional verification cannot run or admit the canonical final phase", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.source, "HEAD");
    const controller = new AbortController();
    try {
      const calls: string[] = [];
      const harness = {
        async runStep(input: HarnessStepInput) {
          calls.push(input.step.id);
          const result = { summary: `ran ${input.step.id}`, ...(await verificationFixture(input)) };
          if (input.step.id === "provisional-technical-verification") controller.abort();
          return result;
        },
      };
      const runner = new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: { save: async () => undefined },
        repositoryScanner: passingScanner,
        contextPreflight: unnecessaryPreflight,
        workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
        sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
        id: () => "run-source-obligation-cancelled",
      });

      const record = await runner.run({
        signal: controller.signal,
        workflow: "review-documentation",
        workspacePath: workspace.path,
        repository: {
          sourcePath: fixture.source,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
        contextTarget: { sourcePath: "docs/guide.md" },
        allowWrite: false,
      });

      expect(record.status).toBe("failed");
      expect(record.error).toBe("Workflow cancelled by user.");
      expect(calls).toContain("provisional-technical-verification");
      expect(calls).not.toContain("verify-technical-accuracy");
      const final = record.steps.find((step) => step.id === "verify-technical-accuracy")!;
      expect(final.status).toBe("pending");
      expect(final.summary).toBeUndefined();
      expect(final.technicalCorrectionEvidence).toBeUndefined();
    } finally {
      await workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("stops before provider work for an active workflow without its source observer", async () => {
    let calls = 0;
    const runner = new WorkflowRunner({
      harness: {
        runStep: async () => {
          calls += 1;
          return { summary: "unexpected" };
        },
      },
      store: { save: async () => undefined },
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "fixture",
          status: "passed" as const,
          scannedFiles: 0,
          binaryFiles: 0,
          findings: [],
        }),
      },
      sourceObligationObserver: undefined,
    });
    await expect(
      runner.run({
        workflow: "review-documentation",
        workspacePath: "/unreached",
        repository: {
          sourcePath: "/unreached",
          requestedRevision: "HEAD",
          revision: "a".repeat(40),
        },
        allowWrite: false,
      }),
    ).rejects.toThrow("require the exact-byte source observer");
    expect(calls).toBe(0);
  });
});

const passingScanner = {
  scan: async () => ({
    ruleSet: "source-obligation-fixture",
    status: "passed" as const,
    scannedFiles: 2,
    binaryFiles: 0,
    findings: [],
  }),
};

const unnecessaryPreflight = {
  preflight: async () => ({
    status: "unnecessary" as const,
    reason: "target-not-applicable" as const,
  }),
};

function createPlanBinding(pagePath = "docs/new-guide.md", sources = ["src/api.ts:1"]) {
  const pages = [{ path: pagePath, disposition: "create" as const }];
  const sourceBindings = [{ pagePath, sources }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode: "create" as const,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
  };
}

async function repositoryFixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-source-obligation-runner-"));
  const source = join(root, "source");
  await initFixtureRepo(source, {
    "src/api.ts": "export const value = 1;\n",
    "src/Alpha.ts": "export const alpha = 1;\n",
    "src/extra.ts": "export const extra = 1;\n",
    "docs/guide.md": "# Guide\n\nBounded fixture.\n",
  });
  return { root, source };
}
