// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { executeRunRequest } from "../src/cli/run-request.js";
import { previewFreshGitLabReviewDelivery } from "../src/cli/review-delivery.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { decodeSuccessfulReviewRunRecord } from "../src/delivery/run-record.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  loadRetainedReviewSource,
  retainSourceSnapshotParts,
} from "../src/review-delivery/source-snapshot-store.js";
import {
  loadRetainedReviewResult,
  retainOriginalReviewResult,
} from "../src/review-delivery/result-store.js";
import {
  decodeReviewLocatorObservation,
  loadReviewLocatorAuthority,
  retainReviewLocatorObservation,
  resolveReviewLocator,
} from "../src/review/locator-provenance.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { resolve } from "node:path";
import { limit } from "../src/config/limits.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
} from "../src/workflow-execution/source-obligation.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { createSourceFixture } from "./support/source-acquisition-cli.js";
import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";
import {
  createAuditHarness,
  resetSharedTestState,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";
import { sourceObligationProposalFixture, verificationFixture } from "./helpers/verification.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/verification-result.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { commitFiles } from "./support/change-source-fixture.js";
import { fixtureGit } from "./support/change-source-fixture.js";
import { resolveGitLabMergeRequestChangeSource } from "../src/inputs/change-source/gitlab.js";
import { resolveGithubChangeSource } from "../src/inputs/change-source/github.js";
import {
  decodeChangeSourceV1,
  parseChangeSourceSelector,
  type GitLabMergeRequestSelectorV1,
} from "../src/inputs/change-source.js";
import { createReviewTargetV2 } from "../src/review/index.js";
import { reviewResultFromRun } from "../src/review/run-result.js";
import { planRetainedReviewDelivery } from "../src/review-delivery/index.js";
import { planRetainedReviewDelivery as planInstalledPublic } from "../src/review-delivery/public.js";
import {
  createReviewDeliveryPlan,
  reviewDeliverySnapshotDigest,
} from "../src/review-delivery/plan.js";
import { projectReviewResultV1 } from "../src/review/target-migration.js";
import { createReviewResultV6 } from "../src/review/target-migration.js";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { FakeGithub, OWNER, NAME, REPOSITORY_ID } from "./support/github-change-source-fixture.js";
import { acquireChangeSourceObservations } from "../src/inputs/change-source/acquisition.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import {
  CLI_SOURCE_READ_SCOPE,
  cliSourceExtractionLimits,
} from "../src/cli/run/source-acquisition.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import { validModelConfig } from "./helpers.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import {
  createWorkflowOutcome,
  decodeWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
  resealWorkflowOutcomeAfterRetainedReviewResult,
  ReviewResultTransitionError,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import type { ReviewDeliverySnapshotReferenceV1 } from "../src/records/review-delivery-snapshot-reference.js";

const roots = temporaryRoots();
afterEach(async () => {
  await resetSharedTestState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class RealReadReviewHarness implements AgentHarness {
  private readonly pi: Awaited<ReturnType<typeof createAuditHarness>>;
  public constructor(
    pi: Awaited<ReturnType<typeof createAuditHarness>>,
    private readonly readPaths: readonly string[] = ["README.md"],
    private readonly technicalIssue = true,
  ) {
    this.pi = pi;
  }
  public async inspectSkill(input: HarnessStepInput) {
    return this.pi.inspectSkill(input);
  }
  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (input.step.id === "verify-technical-accuracy") {
      const responses = [
        toolTurn(
          this.readPaths.map((path, index) => ({
            id: `retained-read-${index}`,
            name: "read",
            arguments: { path },
          })),
        ),
        textTurn(
          JSON.stringify({
            verdict: this.technicalIssue ? "needs-revision" : "pass",
            coverage: this.readPaths.map((path) => ({
              path,
              status: "verified",
              evidence: [`${path}:1`],
              reason: "The opening line was checked.",
            })),
            issueJudgments: this.technicalIssue
              ? [
                  {
                    id: "TECH-001",
                    severity: "major",
                    category: "technical_accuracy",
                    location: "README.md:1",
                    obligationIds: ["OBL-INPUT-REPRESENTATIONS-1"],
                  },
                ]
              : [],
            obligationJudgments: [
              {
                obligationId: "OBL-INPUT-REPRESENTATIONS-1",
                disposition: "retained",
                documentationDisposition: this.technicalIssue ? "conflicting" : "documented",
                issueIds: this.technicalIssue ? ["TECH-001"] : [],
              },
            ],
          }),
        ),
      ];
      let index = 0;
      vi.stubGlobal("fetch", async () => {
        const response = responses[index++];
        if (!response) throw new Error("Unexpected provider request.");
        return response.clone();
      });
      return this.pi.runStep(input);
    }
    const profile = validModelConfig.profile;
    const governed = governProviderTurn({
      context: { messages: [{ role: "user", content: "Perform the fixture review step." }] },
      policy: {
        budget: {
          configuredContextWindow: profile.configuredLimits.contextWindow,
          effectiveContextWindow: profile.contextWindow,
          configuredMaxInputTokens: profile.configuredLimits.maxInputTokens,
          effectiveMaxInputTokens: profile.maxInputTokens,
          configuredMaxOutputTokens: profile.configuredLimits.maxOutputTokens,
          effectiveMaxOutputTokens: profile.maxOutputTokens,
          reservedTokens: validModelConfig.requestPolicy.reservedContextTokens,
          requiredMinimumOutputTokens: validModelConfig.requestPolicy.minimumOutputTokens,
        },
        maxProviderTurns: 1,
        maxToolCalls: 1,
        maxCompactions: 1,
        minRecentToolTurns: 1,
      },
      state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
      evidenceIdentity: input.evidenceIdentity!,
      pinnedMessageCount: 0,
    });
    const evidence = {
      model: createModelEvidence(validModelConfig),
      skill: await this.inspectSkill(input),
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      turns: [governed.evidence],
    };
    if (requiresSourceObligationLedger(input)) {
      const proposal = sourceObligationProposalFixture("README.md:1");
      proposal.dimensions[0] = {
        dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
        status: "applicable",
        reason: "The reviewed opening line states one source-backed claim.",
        sourceLocators: [],
        obligations: [
          {
            id: "OBL-IGNORED",
            dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
            sourceLocators: ["README.md:1"],
            statement: "The opening line names the reviewed head.",
            evidenceClass: "source-observation",
            uncertainty: "none",
          },
        ],
      };
      return {
        summary: canonicalSourceObligationProposal(proposal),
        sourceObligationProposal: proposal,
        ...evidence,
      };
    }
    if (input.step.id === "review-documentation") {
      return {
        summary: canonicalizeJsonEvidence({
          verdict: "pass",
          issues: [],
        } as JsonEvidenceValue).trimEnd(),
        ...evidence,
      };
    }
    if (input.step.id === "evaluate-document-quality") {
      const candidate = await authoringFixtureCandidateForInput(input);
      const target = candidate.evaluation.target as {
        documentation_family_evidence: Array<{ paths: string[] }>;
        paths: string[];
      };
      target.documentation_family_evidence[0]!.paths = [...this.readPaths];
      target.paths = [...this.readPaths];
      const limitations = candidate.evaluation.limitations as string[];
      for (const limitation of input.technicalVerification?.factInventory.limitations ?? []) {
        if (!limitations.includes(limitation)) limitations.push(limitation);
      }
      for (const dimension of input.technicalVerification?.factInventory.dimensions ?? []) {
        if (dimension.status === "unverified")
          limitations.push(`${dimension.dimension}: ${dimension.reason}`);
      }
      candidate.evaluation.findings = [
        {
          id: "DQ-TRACE-001",
          severity: "major",
          dimension_id: "factual-accuracy",
          description:
            "FACT-1 links the reviewed head difference to TECH-001 with uncertainty none.",
          evidence: [
            {
              evidence_class: "grounded-judgment",
              strength: "direct",
              provider_id: "fixture-evaluator",
              locator: "README.md:1",
              description: "The opening line was read under the registered confined tool.",
            },
          ],
          owner: "documentation owner",
          acceptance_condition:
            "Resolve FACT-1 and TECH-001 against the retained source line; uncertainty none.",
          status: "open",
        },
      ];
      return {
        summary: candidate.reportMarkdown,
        qualityArtifactCandidate: candidate,
        ...evidence,
      };
    }
    return {
      summary: `Completed ${input.step.id}.`,
      ...(await verificationFixture(input)),
      ...evidence,
    };
  }
}

describe("installed local review locator journey", () => {
  it.each(["human", "quiet", "json", "silent"] as const)(
    "previews an explicit fresh GitLab target from the exact retained CLI run without a forge write: %s",
    async (mode) => {
      const fixture = await createSourceFixture({ "README.md": "# Before\n" });
      roots.track(fixture.root);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      const head = await commitFiles(
        fixture.repository,
        { "README.md": "# Reviewed head\n" },
        "Modify reviewed page",
      );
      const host = "gitlab.example.test";
      const projectPath = "team/docs-project";
      const projectId = 4242;
      const iid = 813;
      const url = `https://${host}/${projectPath}/-/merge_requests/${iid}`;
      const template = readFileSync(
        new URL("./fixtures/change-source-gitlab/merge-request-get.json", import.meta.url),
        "utf8",
      );
      const answer = JSON.parse(template, (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("@")
          ? ({ base, start: base, head, merge: null } as Record<string, unknown>)[value.slice(1)]
          : value,
      ) as Record<string, unknown>;
      answer.state = "opened";
      answer.merge_commit_sha = null;
      answer.squash_commit_sha = null;
      const calls: string[][] = [];
      const commands = {
        async run(_command: string, args: readonly string[]) {
          calls.push([...args]);
          const endpoint = String(args.at(-1));
          if (args.includes("config")) return { stdout: "Fixture User\n", stderr: "", exitCode: 0 };
          const body = endpoint.includes("/merge_requests/")
            ? answer
            : { id: projectId, path_with_namespace: projectPath };
          return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
        },
      };
      const request = parseRunArguments([
        "review-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        "Review README.md for technical accuracy.",
        "--change",
        url,
        "--review-delivery-target",
        url,
        "--review-delivery",
        "preview",
      ]);
      const pi = await createAuditHarness({
        reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
      });
      const harness = new RealReadReviewHarness(pi);
      const modelStep = vi.spyOn(harness, "runStep");
      await expect(
        executeRunRequest(
          { ...request, reviewDeliveryTarget: url.replace(/813$/u, "814") },
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: harness,
            changeRequestCommands: commands,
            changeRequestEnvironment: {},
          },
        ),
      ).rejects.toThrow("target must equal the selected GitLab change source");
      expect(modelStep).not.toHaveBeenCalled();
      let preview: Awaited<ReturnType<typeof planInstalledPublic>> | undefined;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((message) => {
        stdout.push(String(message));
      });
      const error = vi.spyOn(console, "error").mockImplementation((message) => {
        stderr.push(String(message));
      });
      let record: Awaited<ReturnType<typeof executeRunRequest>>;
      try {
        record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
          quiet: mode === "quiet",
          json: mode === "json",
          silent: mode === "silent",
          executionHarness: harness,
          changeRequestCommands: commands,
          changeRequestEnvironment: {},
          onReviewDeliveryPreview: (value) => {
            preview = value;
          },
        });
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(record?.reviewDeliverySnapshot?.reviewedHeadSha).toBe(head);
      expect(preview?.target.scmProvider).toBe("gitlab");
      expect(preview?.target.headSha).toBe(head);
      expect(preview?.source.changeSourceSha256).toBe(
        record?.reviewDeliverySnapshot?.changeSourceSha256,
      );
      expect(preview?.actions.length).toBeGreaterThan(0);
      expect(calls.every((args) => !args.includes("POST") && !args.includes("PUT"))).toBe(true);
      if (mode === "human") {
        const indexPath = resolve(fixture.stateDirectory, "..", "run-index", "runs.jsonl");
        const indexBefore = await readFile(indexPath);
        const indexStatBefore = await stat(indexPath);
        await previewFreshGitLabReviewDelivery({
          stateDirectory: fixture.stateDirectory,
          runId: record!.id,
          binding: { target: preview!.target, source: preview!.source },
        });
        expect(await readFile(indexPath)).toEqual(indexBefore);
        expect((await stat(indexPath)).mtimeMs).toBe(indexStatBefore.mtimeMs);
      }
      if (mode === "silent") {
        expect(stdout).toEqual([]);
        expect(stderr).toEqual([]);
      } else {
        const shown = stderr.join("\n");
        expect(shown).toContain("publish-summary");
        expect(shown).toContain("publish-inline");
        expect(shown).toContain("README.md");
        expect(shown).toContain("after");
        expect(shown).toContain("no-location");
        expect(shown).toContain("The opening line names the reviewed head");
        if (mode === "json") {
          expect(stdout).toHaveLength(1);
          expect(JSON.parse(stdout[0]!)).toHaveProperty("resultSha256");
        } else {
          expect(stdout.join("\n")).toContain("RECORD");
        }
      }
      const cold = decodeSuccessfulReviewRunRecord(
        (await new FileRunStore(fixture.stateDirectory).getWithDigest(record!.id)).record,
      );
      expect(cold.reviewDeliverySnapshot).toEqual(record?.reviewDeliverySnapshot);
      const retained = await loadRetainedReviewResult({
        runStore: new FileRunStore(fixture.stateDirectory),
        artifacts: new DurableArtifactStore(resolve(fixture.stateDirectory, "..", "artifacts")),
        runId: record!.id,
        target: preview!.target,
        readOnly: true,
      });
      expect(retained.source.snapshot.files[0]?.afterBytes).toEqual(
        new TextEncoder().encode("# Reviewed head\n"),
      );
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "retains registered Pi read bytes through the ordinary CLI runner",
    async () => {
      const fixture = await createSourceFixture({ "README.md": "# Before\n" });
      roots.track(fixture.root);
      await commitFiles(
        fixture.repository,
        { "README.md": "# Reviewed head\n" },
        "Modify reviewed page",
      );
      const pi = await createAuditHarness({
        reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
      });
      const request = parseRunArguments([
        "review-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        "Review README.md for technical accuracy.",
        "--change",
        "HEAD~1..HEAD",
      ]);
      const record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
        silent: true,
        executionHarness: new RealReadReviewHarness(pi),
      });
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      const pinned = await new FileRunStore(fixture.stateDirectory).getWithDigest(record!.id);
      const cold = decodeSuccessfulReviewRunRecord(pinned.record);
      const reference = cold.steps.find(
        (step) => step.id === "verify-technical-accuracy",
      )?.reviewLocatorObservation;
      expect(reference).toBeDefined();
      const object = await new DurableArtifactStore(
        resolve(fixture.stateDirectory, "..", "artifacts"),
      ).getRecord(reference!.objectSha256);
      const observation = decodeReviewLocatorObservation(object);
      expect(
        observation.files.some(
          (file) => file.path === "README.md" && file.lines.some((line) => line.line === 1),
        ),
      ).toBe(true);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "keeps the public cold planner read-only across private and invalid state",
    async () => {
      const fixture = await createSourceFixture({ "README.md": "# Before\n" });
      roots.track(fixture.root);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      const head = await commitFiles(
        fixture.repository,
        { "README.md": "# Reviewed head\n" },
        "Modify reviewed page",
      );
      const host = "gitlab.example.test";
      const projectPath = "team/docs-project";
      const projectId = 4242;
      const iid = 813;
      const url = `https://${host}/${projectPath}/-/merge_requests/${iid}`;
      const template = readFileSync(
        new URL("./fixtures/change-source-gitlab/merge-request-get.json", import.meta.url),
        "utf8",
      );
      const answer = JSON.parse(template, (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("@")
          ? ({ base, start: base, head, merge: null } as Record<string, unknown>)[value.slice(1)]
          : value,
      ) as Record<string, unknown>;
      answer.state = "opened";
      answer.merge_commit_sha = null;
      answer.squash_commit_sha = null;
      const commands = {
        async run(_command: string, args: readonly string[]) {
          const endpoint = String(args.at(-1));
          const body = endpoint.includes("/merge_requests/")
            ? answer
            : { id: projectId, path_with_namespace: projectPath };
          return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
        },
      };
      const request = parseRunArguments([
        "review-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        "Review README.md for technical accuracy.",
        "--change",
        url,
      ]);
      const pi = await createAuditHarness({
        reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
      });
      const record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
        silent: true,
        executionHarness: new RealReadReviewHarness(pi),
        changeRequestCommands: commands,
        changeRequestEnvironment: {},
      });
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      const source = decodeChangeSourceV1(
        (
          await resolveGitLabMergeRequestChangeSource({
            selector: parseChangeSourceSelector(url) as GitLabMergeRequestSelectorV1,
            sourcePath: fixture.repository,
            repositoryPath: fixture.repository,
            workspaceRevision: head,
            forge: { commands, environment: {} },
          })
        ).changeSource,
      );
      const cold = decodeSuccessfulReviewRunRecord(
        (await new FileRunStore(fixture.stateDirectory).getWithDigest(record!.id)).record,
      );
      const reference = cold.steps.find(
        (step) => step.id === "verify-technical-accuracy",
      )?.reviewLocatorObservation;
      expect(reference).toBeDefined();
      const target = createReviewTargetV2(
        {
          scmProvider: "gitlab",
          host,
          projectId,
          mergeRequestIid: iid,
          sourceFork: false,
          sourceBranch: "topic",
          targetBranch: "main",
          baseSha: base,
          headSha: head,
          trigger: "api",
          requestIdentitySha256: sha256("review:813"),
          workflow: "review-documentation",
          deliveryIntent: "comment-existing-mr",
          logicalRequestId: "request:813",
          changeSourceSha256: source.changeSourceSha256,
        },
        source,
      );
      const result = reviewResultFromRun(record!, { target, source });
      const beforeBytes = new TextEncoder().encode("# Before\n");
      const afterBytes = new Uint8Array(await readFile(resolve(fixture.repository, "README.md")));
      const delivery = {
        snapshot: {
          changeSourceSha256: source.changeSourceSha256,
          files: [
            {
              oldPath: "README.md",
              newPath: "README.md",
              beforeBytes,
              afterBytes,
              beforeSha256: sha256(beforeBytes),
              afterSha256: sha256(afterBytes),
              state: "complete",
              hunks: [
                {
                  lines: [
                    { kind: "removed", text: "# Before", beforeLine: 1, afterLine: null },
                    { kind: "added", text: "# Reviewed head", beforeLine: null, afterLine: 1 },
                  ],
                },
              ],
            },
          ],
        },
        artifact: {
          kind: "retained-review-result",
          id: "artifact:813",
          resultSha256: result.resultSha256,
        },
        actor: { host, id: "user:42" },
        capabilities: { scmProvider: "gitlab", host, summary: true, inline: true },
      } as const;
      const publicInput = {
        stateDirectory: fixture.stateDirectory,
        runId: record!.id,
        binding: { target, source },
        delivery,
      };
      const savedPath = resolve(fixture.stateDirectory, `${record!.id}.json`);
      const objectDirectory = resolve(
        fixture.stateDirectory,
        "..",
        "artifacts",
        "objects",
        "sha256",
      );
      const objectPath = resolve(objectDirectory, `${reference!.objectSha256}.json`);
      const savedBytes = await readFile(savedPath);
      const objectBytes = await readFile(objectPath);
      const objectEntries = await readdir(objectDirectory);
      const privateDirectories = [
        fixture.stateDirectory,
        resolve(fixture.stateDirectory, "..", "artifacts"),
        resolve(objectDirectory, ".."),
        objectDirectory,
      ];
      const privateModes = await Promise.all(
        privateDirectories.map(async (directory) => (await stat(directory)).mode & 0o7777),
      );
      const publicPlan = await planInstalledPublic(publicInput);
      expect(
        publicPlan.findings.find(
          (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
        )?.disposition,
      ).toMatchObject({
        kind: "inline-candidate",
        anchor: { side: "after", path: "README.md", startLine: 1 },
      });
      expect(await readFile(savedPath)).toEqual(savedBytes);
      expect(await readFile(objectPath)).toEqual(objectBytes);
      expect(await readdir(objectDirectory)).toEqual(objectEntries);
      expect(
        await Promise.all(
          privateDirectories.map(async (directory) => (await stat(directory)).mode & 0o7777),
        ),
      ).toEqual(privateModes);

      const absentRunDirectory = resolve(fixture.root, "absent-public-runs");
      await expect(
        planInstalledPublic({ ...publicInput, stateDirectory: absentRunDirectory }),
      ).rejects.toMatchObject({ code: "unsafe-root" });
      await expect(lstat(absentRunDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      if (process.platform !== "win32") {
        await chmod(fixture.stateDirectory, 0o755);
        try {
          await expect(planInstalledPublic(publicInput)).rejects.toMatchObject({
            code: "insecure-permissions",
          });
          expect((await stat(fixture.stateDirectory)).mode & 0o7777).toBe(0o755);
          expect(await readFile(savedPath)).toEqual(savedBytes);
        } finally {
          await chmod(fixture.stateDirectory, 0o700);
        }
      }

      const isolatedRunDirectory = resolve(fixture.root, "isolated-public-state", "runs");
      await new FileRunStore(isolatedRunDirectory).save(cold);
      const isolatedRunPath = resolve(isolatedRunDirectory, `${record!.id}.json`);
      const isolatedRunBytes = await readFile(isolatedRunPath);
      const absentArtifactRoot = resolve(isolatedRunDirectory, "..", "artifacts");
      const noArtifactPlan = await planInstalledPublic({
        ...publicInput,
        stateDirectory: isolatedRunDirectory,
      });
      expect(
        noArtifactPlan.findings.find(
          (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
        ),
      ).toMatchObject({
        disposition: { kind: "summary-candidate", reason: "inline-unavailable" },
        limitations: expect.arrayContaining(["review-locator:observation-invalid"]),
      });
      expect(noArtifactPlan.actions.some((action) => action.kind === "publish-inline")).toBe(false);
      await expect(lstat(absentArtifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(isolatedRunPath)).toEqual(isolatedRunBytes);
      if (process.platform !== "win32") {
        await mkdir(absentArtifactRoot, { mode: 0o700 });
        await chmod(absentArtifactRoot, 0o755);
        const insecureArtifactPlan = await planInstalledPublic({
          ...publicInput,
          stateDirectory: isolatedRunDirectory,
        });
        expect(
          insecureArtifactPlan.findings.find(
            (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
          )?.disposition.kind,
        ).toBe("summary-candidate");
        expect(
          insecureArtifactPlan.actions.some((action) => action.kind === "publish-inline"),
        ).toBe(false);
        expect((await stat(absentArtifactRoot)).mode & 0o7777).toBe(0o755);
        expect(await readdir(absentArtifactRoot)).toEqual([]);
        expect(await readFile(isolatedRunPath)).toEqual(isolatedRunBytes);
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it.each(["planner-boundaries", "cold-source-and-result"] as const)(
    "plans an after-side inline candidate from an object-backed GitLab MR: %s",
    async (variant) => {
      const fixture = await createSourceFixture({
        "README.md": "# Before\n",
        "docs/B.md": "# Über before\n",
        "docs/a.md": "# Café before\n",
      });
      roots.track(fixture.root);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      const head = await commitFiles(
        fixture.repository,
        {
          "README.md": "# Reviewed head\n",
          "docs/B.md": "# Über after\n",
          "docs/a.md": "# Café after\n",
        },
        "Modify reviewed page",
      );
      const host = "gitlab.example.test";
      const projectPath = "team/docs-project";
      const projectId = 4242;
      const iid = 813;
      const url = `https://${host}/${projectPath}/-/merge_requests/${iid}`;
      const template = readFileSync(
        new URL("./fixtures/change-source-gitlab/merge-request-get.json", import.meta.url),
        "utf8",
      );
      const answer = JSON.parse(template, (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("@")
          ? ({ base, start: base, head, merge: null } as Record<string, unknown>)[value.slice(1)]
          : value,
      ) as Record<string, unknown>;
      answer.state = "opened";
      answer.merge_commit_sha = null;
      answer.squash_commit_sha = null;
      const commands = {
        async run(_command: string, args: readonly string[]) {
          const endpoint = String(args.at(-1));
          const body = endpoint.includes("/merge_requests/")
            ? answer
            : { id: projectId, path_with_namespace: projectPath };
          return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
        },
      };
      const request = parseRunArguments([
        "review-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        "Review README.md, docs/a.md, and docs/B.md for technical accuracy.",
        "--change",
        url,
      ]);
      const pi = await createAuditHarness({
        reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
      });
      const record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
        silent: true,
        executionHarness: new RealReadReviewHarness(pi, ["README.md", "docs/a.md", "docs/B.md"]),
        changeRequestCommands: commands,
        changeRequestEnvironment: {},
      });
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      const resolvedChange = await resolveGitLabMergeRequestChangeSource({
        selector: parseChangeSourceSelector(url) as GitLabMergeRequestSelectorV1,
        sourcePath: fixture.repository,
        repositoryPath: fixture.repository,
        workspaceRevision: head,
        forge: { commands, environment: {} },
      });
      const source = decodeChangeSourceV1(resolvedChange.changeSource);
      expect(record!.changeSources?.[0]?.changeSourceSha256).toBe(source.changeSourceSha256);
      const persisted = await new FileRunStore(fixture.stateDirectory).getWithDigest(record!.id);
      const cold = decodeSuccessfulReviewRunRecord(persisted.record);
      expect(cold.reviewScope?.targetPaths).toEqual(["README.md", "docs/B.md", "docs/a.md"]);
      expect(cold.changeSources).toEqual([
        expect.objectContaining({ changeSourceSha256: source.changeSourceSha256 }),
      ]);
      const reference = cold.steps.find(
        (step) => step.id === "verify-technical-accuracy",
      )?.reviewLocatorObservation;
      expect(reference).toBeDefined();
      const observation = decodeReviewLocatorObservation(
        await new DurableArtifactStore(
          resolve(fixture.stateDirectory, "..", "artifacts"),
        ).getRecord(reference!.objectSha256),
      );
      expect(observation.files.map((file) => file.path)).toEqual([
        "README.md",
        "docs/B.md",
        "docs/a.md",
      ]);
      expect(
        observation.files.map((file) => Buffer.from(file.rawBase64, "base64").toString("utf8")),
      ).toEqual(["# Reviewed head\n", "# Über after\n", "# Café after\n"]);
      expect(
        JSON.parse(record!.steps.find((step) => step.id === "verify-technical-accuracy")!.summary!)
          .review.issues,
      ).toHaveLength(1);
      const target = createReviewTargetV2(
        {
          scmProvider: "gitlab",
          host,
          projectId,
          mergeRequestIid: iid,
          sourceFork: false,
          sourceBranch: "topic",
          targetBranch: "main",
          baseSha: base,
          headSha: head,
          trigger: "api",
          requestIdentitySha256: sha256("review:813"),
          workflow: "review-documentation",
          deliveryIntent: "comment-existing-mr",
          logicalRequestId: "request:813",
          changeSourceSha256: source.changeSourceSha256,
        },
        source,
      );
      const result = reviewResultFromRun(record!, { target, source });
      expect(() =>
        reviewResultFromRun({ ...record!, changeSources: undefined }, { target, source }),
      ).toThrow();
      expect(() =>
        reviewResultFromRun(
          {
            ...record!,
            changeSources: [{ ...record!.changeSources![0]!, changeSourceSha256: "0".repeat(64) }],
          },
          { target, source },
        ),
      ).toThrow();
      const beforeBytes = new TextEncoder().encode(
        `${await fixtureGit(fixture.repository, ["show", `${base}:README.md`])}\n`,
      );
      const afterBytes = new Uint8Array(await readFile(resolve(fixture.repository, "README.md")));
      const additionalSnapshotFiles = [
        ["docs/B.md", "# Über before", "# Über after"],
        ["docs/a.md", "# Café before", "# Café after"],
      ].map(([path, before, after]) => {
        const beforeBytes = new TextEncoder().encode(`${before}\n`);
        const afterBytes = new TextEncoder().encode(`${after}\n`);
        return {
          oldPath: path!,
          newPath: path!,
          beforeBytes,
          afterBytes,
          beforeSha256: sha256(beforeBytes),
          afterSha256: sha256(afterBytes),
          state: "complete" as const,
          hunks: [
            {
              lines: [
                { kind: "removed" as const, text: before!, beforeLine: 1, afterLine: null },
                { kind: "added" as const, text: after!, beforeLine: null, afterLine: 1 },
              ],
            },
          ],
        };
      });
      const delivery = {
        snapshot: {
          changeSourceSha256: source.changeSourceSha256,
          files: [
            {
              oldPath: "README.md",
              newPath: "README.md",
              beforeBytes,
              afterBytes,
              beforeSha256: sha256(beforeBytes),
              afterSha256: sha256(afterBytes),
              state: "complete",
              hunks: [
                {
                  lines: [
                    { kind: "removed", text: "# Before", beforeLine: 1, afterLine: null },
                    { kind: "added", text: "# Reviewed head", beforeLine: null, afterLine: 1 },
                  ],
                },
              ],
            },
            ...additionalSnapshotFiles,
          ],
        },
        artifact: {
          kind: "retained-review-result",
          id: "artifact:813",
          resultSha256: result.resultSha256,
        },
        actor: { host, id: "user:42" },
        capabilities: { scmProvider: "gitlab", host, summary: true, inline: true },
      } as const;
      const retained = {
        runStore: new FileRunStore(fixture.stateDirectory),
        artifacts: new DurableArtifactStore(resolve(fixture.stateDirectory, "..", "artifacts")),
        runId: record!.id,
        binding: { target, source },
      };
      const plan = await planRetainedReviewDelivery({ ...retained, delivery });
      if (variant === "planner-boundaries") {
        expect(plan.actions.map((action) => action.kind)).toEqual([
          "publish-summary",
          "publish-inline",
        ]);
        expect(
          plan.findings.find(
            (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
          )?.disposition,
        ).toMatchObject({
          kind: "inline-candidate",
          anchor: { side: "after", path: "README.md", startLine: 1 },
        });
        const manifestBytes = Buffer.byteLength(JSON.stringify(observation));
        const capturedFilesBytes = Buffer.byteLength(JSON.stringify({ files: observation.files }));
        expect(capturedFilesBytes).toBeLessThan(manifestBytes - 1);
        const technicalStep = cold.steps.find((step) => step.id === "verify-technical-accuracy")!;
        for (const [label, objectBytes, expectedRetained] of [
          ["below", manifestBytes - 1, false],
          ["exact", manifestBytes, true],
          ["above", manifestBytes + 1, true],
        ] as const) {
          const artifacts = new DurableArtifactStore(resolve(fixture.root, `locator-${label}`), {
            maxArtifactBytes: objectBytes,
          });
          const boundaryReference = await retainReviewLocatorObservation({
            artifacts,
            record: cold,
            step: technicalStep,
            observation: { unavailable: false, invalidPaths: [], files: observation.files },
            targetPaths: observation.targetPaths,
          });
          expect(boundaryReference !== null, label).toBe(expectedRetained);
          if (expectedRetained) {
            expect(boundaryReference?.objectSha256).toBe(reference?.objectSha256);
            const boundaryPlan = await planRetainedReviewDelivery({
              ...retained,
              artifacts,
              delivery,
            });
            expect(
              boundaryPlan.findings.find(
                (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
              )?.disposition,
            ).toMatchObject({ kind: "inline-candidate", anchor: { side: "after" } });
          } else {
            const boundaryPlan = await planRetainedReviewDelivery({
              ...retained,
              artifacts,
              delivery,
            });
            expect(
              boundaryPlan.findings.find(
                (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
              )?.disposition,
            ).toMatchObject({ kind: "summary-candidate", reason: "inline-unavailable" });
          }
        }
        expect(request.allowWrite).toBe(false);
        expect(record!.changes?.files).toEqual([]);
        const projection = projectReviewResultV1(result, target);
        const proof = await loadReviewLocatorAuthority({
          ...retained,
          result: projection,
          snapshotSha256: reviewDeliverySnapshotDigest(delivery.snapshot, source),
        });
        expect(proof.kind).toBe("verified");
        if (proof.kind !== "verified")
          throw new Error("Cold review locator proof failed verification for this test run.");
        const explicitDelivery = { ...delivery, requestedActions: "overview" as const };
        const freshOverview = createReviewDeliveryPlan({
          ...explicitDelivery,
          target,
          source,
          result: reviewResultFromRun(cold, { target, source }),
          locatorEvidence: proof,
        });
        const coldOverview = await planRetainedReviewDelivery({
          ...retained,
          delivery: explicitDelivery,
        });
        const installedOverview = await planInstalledPublic({
          stateDirectory: fixture.stateDirectory,
          runId: record!.id,
          binding: { target, source },
          delivery: explicitDelivery,
        });
        expect(coldOverview).toEqual(freshOverview);
        expect(installedOverview).toEqual(freshOverview);
        expect(installedOverview.requestedActions).toBe("overview");
        expect(installedOverview.actions[0]).toMatchObject({ kind: "publish-summary" });
        expect(installedOverview.actions).toEqual(plan.actions);
        const summaryOnlyCold = await planInstalledPublic({
          stateDirectory: fixture.stateDirectory,
          runId: record!.id,
          binding: { target, source },
          delivery: { ...delivery, requestedActions: "summary-only" },
        });
        expect(summaryOnlyCold.actions.map((action) => action.kind)).toEqual(["publish-summary"]);
        expect(summaryOnlyCold.actions[0]).toMatchObject({
          kind: "publish-summary",
          findingIds: summaryOnlyCold.findings
            .filter((finding) => finding.disposition.kind === "summary-candidate")
            .map((finding) => finding.inventoryId),
        });
        expect(
          summaryOnlyCold.findings.some((finding) => finding.disposition.kind === "unsupported"),
        ).toBe(false);
        const locatorQuery = {
          resultSha256: projection.originalResultSha256,
          sourceSha256: source.changeSourceSha256,
          reviewedHeadSha: target.headSha,
          snapshotSha256: reviewDeliverySnapshotDigest(delivery.snapshot, source),
          collection: "issues" as const,
          index: 0,
          id: projection.issues![0]!.id,
          path: "README.md",
          line: 1,
          file: {
            oldPath: "README.md",
            newPath: "README.md",
            afterBytes,
            afterSha256: sha256(afterBytes),
          },
        };
        expect(resolveReviewLocator(proof.authority, locatorQuery)).toMatchObject({
          kind: "verified",
          side: "after",
          path: "README.md",
          line: 1,
        });
        expect(
          resolveReviewLocator({ kind: "docsfab-review-locator-authority" }, locatorQuery),
        ).toMatchObject({ kind: "unavailable", reason: "binding-mismatch" });
        for (const wrong of [
          { ...locatorQuery, resultSha256: "0".repeat(64) },
          { ...locatorQuery, sourceSha256: "0".repeat(64) },
          { ...locatorQuery, reviewedHeadSha: "0".repeat(40) },
          { ...locatorQuery, snapshotSha256: "0".repeat(64) },
          { ...locatorQuery, index: 1 },
          { ...locatorQuery, id: "OTHER" },
          { ...locatorQuery, path: "other.md" },
          { ...locatorQuery, line: 2 },
          {
            ...locatorQuery,
            file: { ...locatorQuery.file, afterBytes: new TextEncoder().encode("changed\n") },
          },
        ]) {
          expect(resolveReviewLocator(proof.authority, wrong)).toMatchObject({
            kind: "unavailable",
          });
        }
        const missingProof = await planRetainedReviewDelivery({
          ...retained,
          artifacts: new DurableArtifactStore(resolve(fixture.root, "missing-review-observation")),
          delivery,
        });
        const unavailableArtifacts = new DurableArtifactStore(
          resolve(fixture.root, "missing-review-observation"),
        );
        const unavailableLocator = await loadReviewLocatorAuthority({
          ...retained,
          artifacts: unavailableArtifacts,
          result: projection,
          snapshotSha256: reviewDeliverySnapshotDigest(delivery.snapshot, source),
        });
        expect(unavailableLocator.kind).toBe("unavailable");
        expect(
          await planRetainedReviewDelivery({
            ...retained,
            artifacts: unavailableArtifacts,
            delivery: explicitDelivery,
          }),
        ).toEqual(
          createReviewDeliveryPlan({
            ...explicitDelivery,
            target,
            source,
            result: reviewResultFromRun(cold, { target, source }),
            locatorEvidence: unavailableLocator,
          }),
        );
        expect(
          missingProof.findings.find(
            (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
          ),
        ).toMatchObject({
          disposition: { kind: "summary-candidate", reason: "inline-unavailable" },
          limitations: expect.arrayContaining(["review-locator:observation-invalid"]),
        });
        const altered = structuredClone(record!);
        const selected = altered.steps.find((step) => step.id === "verify-technical-accuracy")!;
        selected.reviewLocatorObservation = {
          ...selected.reviewLocatorObservation!,
          summarySha256: "0".repeat(64),
        };
        expect(() => decodeSuccessfulReviewRunRecord(altered)).toThrow();
        const legacy = structuredClone(record!);
        delete legacy.steps.find((step) => step.id === "verify-technical-accuracy")!
          .reviewLocatorObservation;
        const legacyStore = new FileRunStore(resolve(fixture.root, "legacy-state"));
        await legacyStore.save(legacy);
        const legacyPlan = await planRetainedReviewDelivery({
          ...retained,
          runStore: legacyStore,
          delivery,
        });
        expect(
          legacyPlan.findings.find(
            (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
          ),
        ).toMatchObject({
          disposition: { kind: "summary-candidate", reason: "inline-unavailable" },
          limitations: expect.arrayContaining(["review-locator:legacy-unavailable"]),
        });
        const sourceReference = record!.steps.find(
          (step) => step.id === "verify-technical-accuracy",
        )!.reviewLocatorObservation!;
        const corruptManifest = {
          ...decodeReviewLocatorObservation(
            await retained.artifacts.getRecord(sourceReference.objectSha256),
          ),
          domainSha256: "0".repeat(64),
        };
        const corruptObjectSha256 = opaqueRecordDigest(corruptManifest);
        await retained.artifacts.putRecord(corruptObjectSha256, corruptManifest);
        const corruptRecord = structuredClone(record!);
        corruptRecord.steps.find(
          (step) => step.id === "verify-technical-accuracy",
        )!.reviewLocatorObservation = {
          ...sourceReference,
          objectSha256: corruptObjectSha256,
          domainSha256: corruptManifest.domainSha256,
        };
        const corruptStore = new FileRunStore(resolve(fixture.root, "corrupt-domain-state"));
        await corruptStore.save(corruptRecord);
        const corruptPlan = await planRetainedReviewDelivery({
          ...retained,
          runStore: corruptStore,
          delivery,
        });
        expect(
          corruptPlan.findings.find(
            (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
          ),
        ).toMatchObject({
          disposition: { kind: "summary-candidate", reason: "inline-unavailable" },
          limitations: expect.arrayContaining(["review-locator:observation-invalid"]),
        });
        const changedBytes = new TextEncoder().encode("# Changed after read\n");
        await expect(
          planRetainedReviewDelivery({
            ...retained,
            delivery: {
              ...delivery,
              snapshot: {
                ...delivery.snapshot,
                files: [
                  {
                    ...delivery.snapshot.files[0]!,
                    afterBytes: changedBytes,
                    afterSha256: sha256(changedBytes),
                  },
                ],
              },
            },
          }),
        ).rejects.toThrow("snapshot-mismatch");
        return;
      }

      // Attach a source graph to the actual saved successful run as a reader
      // fixture. This tests cold admission, not a host acquisition writer.
      const citation = cold.changeSources![0]!;
      const observationIdFor = (role: "manifest" | "diff") =>
        citation.observations.find((item) => item.role === role)!.observationId;
      const snapshotRows = source.files.map((file, index) => {
        const row = delivery.snapshot.files[index]!;
        const side = (which: "before" | "after") => {
          const original = which === "before" ? row.beforeBytes : row.afterBytes;
          const id = which === "before" ? file.oldBlob : file.newBlob;
          if (original === null || id === null)
            return { reason: "not-in-source" as const, statedSha256: null };
          return { objectId: id, bytes: original, statedSha256: sha256(original) };
        };
        return { state: row.state, sections: 1, before: side("before"), after: side("after") };
      });
      const snapshotRef = await retainSourceSnapshotParts(retained.artifacts, {
        runId: cold.id,
        sourceSha256: source.changeSourceSha256,
        repositoryIdentitySha256: source.revision.repository.identitySha256,
        reviewedHeadSha: head,
        snapshotSha256: reviewDeliverySnapshotDigest(delivery.snapshot, source),
        manifest: {
          observationId: observationIdFor("manifest"),
          bytes: resolvedChange.manifestBytes,
        },
        diff: { observationId: observationIdFor("diff"), bytes: resolvedChange.diffBytes },
        rows: snapshotRows,
      });
      const snapshotReference = {
        kind: "docsfab-review-delivery-snapshot-reference" as const,
        schemaVersion: 1 as const,
        runId: cold.id,
        rootObjectSha256: snapshotRef.rootObjectSha256,
        snapshotSha256: reviewDeliverySnapshotDigest(delivery.snapshot, source),
        changeSourceSha256: source.changeSourceSha256,
        reviewedHeadSha: head,
        repositoryIdentitySha256: source.revision.repository.identitySha256,
      };
      const coldStore = new FileRunStore(resolve(fixture.root, "snapshot-cold-state"));
      await expect(
        retainOriginalReviewResult({
          run: structuredClone(cold),
          artifacts: retained.artifacts,
          result,
        }),
      ).rejects.toThrow("source-reference-missing");
      const retainedCold = structuredClone({ ...cold, reviewDeliverySnapshot: snapshotReference });
      // A hosted report is a valid field in the first provider original, but
      // cannot be reconstructed from the saved run. Cold locator proof must
      // use this retained original, not a fresh run projection.
      const retainedOriginal = reviewResultFromRun(
        cold,
        { target, source },
        `https://${host}/reports/${cold.id}/index.html`,
      );
      expect(retainedOriginal.resultSha256).not.toBe(result.resultSha256);
      // This reader fixture adds the output use after the original run. Its
      // prior outcome seal is stale until the exact permitted use is resealed.
      const retainedUse = await retainOriginalReviewResult({
        run: retainedCold,
        artifacts: retained.artifacts,
        result: retainedOriginal,
      });
      const staleOutcomeStore = new FileRunStore(resolve(fixture.root, "snapshot-stale-outcome"));
      await staleOutcomeStore.save({ ...retainedCold, workflowOutcome: cold.workflowOutcome });
      await expect(
        loadRetainedReviewResult({
          runStore: staleOutcomeStore,
          artifacts: retained.artifacts,
          runId: cold.id,
          target,
        }),
      ).rejects.toThrow("Publication run record rejected");
      retainedCold.workflowOutcome = resealWorkflowOutcomeAfterRetainedReviewResult({
        before: cold,
        after: retainedCold,
        sourceReference: snapshotReference,
        resultUse: retainedUse,
      });
      await coldStore.save(retainedCold);
      const original = await loadRetainedReviewResult({
        runStore: coldStore,
        artifacts: retained.artifacts,
        runId: cold.id,
        target,
      });
      expect(canonicalJson(original.result)).toBe(canonicalJson(retainedOriginal));
      expect(original.result.resultSha256).toBe(retainedOriginal.resultSha256);
      if (result.schemaVersion !== 4) throw new Error("Expected the V2 provider result fixture.");
      const {
        schemaVersion: _version,
        kind: _kind,
        target: _target,
        targetSha256: _targetSha256,
        reviewedHeadSha: _headSha,
        resultSha256: _resultSha256,
        ...baseResult
      } = result;
      const richResult = createReviewResultV6(target, source, {
        ...baseResult,
        issues: (result.issues ?? []).map((issue) => ({
          ...issue,
          rich: { status: "unavailable", reason: "candidate-absent" },
        })),
        sourceContexts: result.sourceContexts ?? [],
      } as never);
      const richRun = structuredClone({ ...cold, reviewDeliverySnapshot: snapshotReference });
      delete richRun.workflowOutcome;
      await retainOriginalReviewResult({
        run: richRun,
        artifacts: retained.artifacts,
        result: richResult,
      });
      const richStore = new FileRunStore(resolve(fixture.root, "snapshot-rich-original-state"));
      await richStore.save(richRun);
      const richLoaded = await loadRetainedReviewResult({
        runStore: richStore,
        artifacts: retained.artifacts,
        runId: cold.id,
        target,
      });
      expect(richLoaded.result.schemaVersion).toBe(6);
      expect(canonicalJson(richLoaded.result)).toBe(canonicalJson(richResult));
      expect(richLoaded.result.resultSha256).toBe(richResult.resultSha256);
      expect(
        (
          await loadReviewLocatorAuthority({
            runStore: richStore,
            artifacts: retained.artifacts,
            runId: cold.id,
            binding: { target, source },
            result: projectReviewResultV1(richResult, target),
            snapshotSha256: snapshotReference.snapshotSha256,
          })
        ).kind,
      ).toBe("verified");
      const savedPlan = await planRetainedReviewDelivery({
        ...retained,
        runStore: coldStore,
        delivery: {
          ...delivery,
          artifact: { ...delivery.artifact, resultSha256: retainedOriginal.resultSha256 },
        },
      });
      expect(
        savedPlan.findings.find(
          (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
        ),
      ).toMatchObject({
        disposition: { kind: "inline-candidate", anchor: { side: "after", path: "README.md" } },
        retained: { resultSha256: retainedOriginal.resultSha256 },
      });
      expect(savedPlan.actions.map((action) => action.kind)).toEqual([
        "publish-summary",
        "publish-inline",
      ]);
      expect(savedPlan).not.toEqual(plan);
      const coldLocator = {
        runStore: coldStore,
        artifacts: retained.artifacts,
        runId: cold.id,
        binding: { target, source },
        result: projectReviewResultV1(retainedOriginal, target),
        snapshotSha256: snapshotReference.snapshotSha256,
      };
      expect((await loadReviewLocatorAuthority(coldLocator)).kind).toBe("verified");
      expect(
        await loadReviewLocatorAuthority({
          ...coldLocator,
          result: projectReviewResultV1(result, target),
        }),
      ).toMatchObject({ kind: "unavailable", reason: "binding-mismatch" });
      expect(
        await loadReviewLocatorAuthority({ ...coldLocator, snapshotSha256: "0".repeat(64) }),
      ).toMatchObject({ kind: "unavailable", reason: "binding-mismatch" });
      expect(
        await loadReviewLocatorAuthority({
          ...coldLocator,
          artifacts: new DurableArtifactStore(resolve(fixture.root, "unrelated-artifacts")),
        }),
      ).toMatchObject({ kind: "unavailable", reason: "binding-mismatch" });
      const missingResultStore = new FileRunStore(resolve(fixture.root, "snapshot-no-result"));
      await missingResultStore.save({
        ...cold,
        workflowOutcome: undefined,
        reviewDeliverySnapshot: snapshotReference,
      });
      expect(
        await loadReviewLocatorAuthority({ ...coldLocator, runStore: missingResultStore }),
      ).toMatchObject({ kind: "unavailable", reason: "binding-mismatch" });
      await expect(
        loadRetainedReviewResult({
          runStore: missingResultStore,
          artifacts: retained.artifacts,
          runId: cold.id,
          target,
        }),
      ).rejects.toThrow("result-reference-not-unique");
      const duplicateResultStore = new FileRunStore(
        resolve(fixture.root, "snapshot-duplicate-result"),
      );
      await duplicateResultStore.save({
        ...retainedCold,
        artifacts: [...retainedCold.artifacts!, retainedCold.artifacts!.at(-1)!],
      });
      await expect(
        loadRetainedReviewResult({
          runStore: duplicateResultStore,
          artifacts: retained.artifacts,
          runId: cold.id,
          target,
        }),
      ).rejects.toThrow();
      const wrongKindStore = new FileRunStore(resolve(fixture.root, "snapshot-wrong-result-kind"));
      const wrongKind = structuredClone(retainedCold);
      for (const use of [...wrongKind.artifacts!, ...wrongKind.steps.at(-1)!.artifacts!]) {
        if (use.reference.kind === "review-result") use.reference.kind = "roadmap-ledger";
      }
      await wrongKindStore.save(wrongKind);
      await expect(
        loadRetainedReviewResult({
          runStore: wrongKindStore,
          artifacts: retained.artifacts,
          runId: cold.id,
          target,
        }),
      ).rejects.toThrow("Publication run record rejected");
      const substitutedStore = new FileRunStore(
        resolve(fixture.root, "snapshot-substituted-result"),
      );
      const substituted = structuredClone(retainedCold);
      for (const use of [...substituted.artifacts!, ...substituted.steps.at(-1)!.artifacts!]) {
        if (use.reference.kind === "review-result") {
          use.reference.digest = snapshotRef.rootObjectSha256;
        }
      }
      await substitutedStore.save(substituted);
      await expect(
        loadRetainedReviewResult({
          runStore: substitutedStore,
          artifacts: retained.artifacts,
          runId: cold.id,
          target,
        }),
      ).rejects.toThrow();
      const restoredSource = await loadRetainedReviewSource({
        runStore: coldStore,
        artifacts: retained.artifacts,
        runId: cold.id,
      });
      expect(restoredSource.source).toEqual(source);
      expect(restoredSource.snapshot).toEqual(delivery.snapshot);
      // A provider's stated side hash is evidence independent of the verified
      // raw object hash. Cold loading must preserve both identities.
      const distinctStatedSha256 = "f".repeat(64);
      const statedSnapshot = {
        ...delivery.snapshot,
        files: delivery.snapshot.files.map((row, index) =>
          index === 0 ? { ...row, afterSha256: distinctStatedSha256 } : row,
        ),
      };
      const statedRows = snapshotRows.map((row, index) =>
        index === 0
          ? {
              ...row,
              after: { ...row.after, statedSha256: distinctStatedSha256 },
            }
          : row,
      );
      const statedRef = await retainSourceSnapshotParts(retained.artifacts, {
        runId: cold.id,
        sourceSha256: source.changeSourceSha256,
        repositoryIdentitySha256: source.revision.repository.identitySha256,
        reviewedHeadSha: head,
        snapshotSha256: reviewDeliverySnapshotDigest(statedSnapshot, source),
        manifest: {
          observationId: observationIdFor("manifest"),
          bytes: resolvedChange.manifestBytes,
        },
        diff: { observationId: observationIdFor("diff"), bytes: resolvedChange.diffBytes },
        rows: statedRows,
      });
      const statedStore = new FileRunStore(resolve(fixture.root, "snapshot-stated-hash-state"));
      await statedStore.save({
        ...cold,
        reviewDeliverySnapshot: {
          ...snapshotReference,
          rootObjectSha256: statedRef.rootObjectSha256,
          snapshotSha256: reviewDeliverySnapshotDigest(statedSnapshot, source),
        },
      });
      expect(
        (
          await loadRetainedReviewSource({
            runStore: statedStore,
            artifacts: retained.artifacts,
            runId: cold.id,
          })
        ).snapshot,
      ).toEqual(statedSnapshot);
      const falseRoot = {
        ...((await retained.artifacts.getRecord(snapshotRef.rootObjectSha256)) as Record<
          string,
          unknown
        >),
        snapshotSha256: "f".repeat(64),
      };
      const falseRootDigest = opaqueRecordDigest(falseRoot);
      await retained.artifacts.putRecord(falseRootDigest, falseRoot);
      const falseStore = new FileRunStore(resolve(fixture.root, "snapshot-self-consistent-false"));
      await falseStore.save({
        ...cold,
        reviewDeliverySnapshot: {
          ...snapshotReference,
          rootObjectSha256: falseRootDigest,
          snapshotSha256: falseRoot.snapshotSha256 as string,
        },
      });
      await expect(
        loadRetainedReviewSource({
          runStore: falseStore,
          artifacts: retained.artifacts,
          runId: cold.id,
        }),
      ).rejects.toThrow("snapshot-digest-mismatch");
      const originalDiffText = new TextDecoder().decode(resolvedChange.diffBytes);
      const invalidDiffText = originalDiffText.replace("-# Café before", "!# Café before");
      expect(invalidDiffText).not.toBe(originalDiffText);
      const fallbackSnapshot = {
        ...delivery.snapshot,
        files: delivery.snapshot.files.map((row) =>
          row.newPath === "docs/a.md" ? { ...row, hunks: [] } : row,
        ),
      };
      const invalidRef = await retainSourceSnapshotParts(retained.artifacts, {
        runId: cold.id,
        sourceSha256: source.changeSourceSha256,
        repositoryIdentitySha256: source.revision.repository.identitySha256,
        reviewedHeadSha: head,
        snapshotSha256: reviewDeliverySnapshotDigest(fallbackSnapshot, source),
        manifest: {
          observationId: observationIdFor("manifest"),
          bytes: resolvedChange.manifestBytes,
        },
        diff: {
          observationId: observationIdFor("diff"),
          bytes: new TextEncoder().encode(invalidDiffText),
        },
        rows: snapshotRows,
      });
      const invalidStore = new FileRunStore(resolve(fixture.root, "snapshot-invalid-row-state"));
      await invalidStore.save({
        ...cold,
        reviewDeliverySnapshot: {
          ...snapshotReference,
          rootObjectSha256: invalidRef.rootObjectSha256,
          snapshotSha256: reviewDeliverySnapshotDigest(fallbackSnapshot, source),
        },
      });
      expect(
        (
          await loadRetainedReviewSource({
            runStore: invalidStore,
            artifacts: retained.artifacts,
            runId: cold.id,
          })
        ).snapshot,
      ).toEqual(fallbackSnapshot);
      const duplicateStore = new FileRunStore(resolve(fixture.root, "snapshot-duplicate-state"));
      await duplicateStore.save({
        ...cold,
        reviewDeliverySnapshot: snapshotReference,
        changeSources: [citation, citation],
      });
      await expect(
        loadRetainedReviewSource({
          runStore: duplicateStore,
          artifacts: retained.artifacts,
          runId: cold.id,
        }),
      ).rejects.toThrow();
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "plans an after-side inline candidate from GitHub's native object-backed pull request",
    async () => {
      const fixture = await createSourceFixture({ "README.md": "# Before\n" });
      roots.track(fixture.root);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      await fixtureGit(fixture.repository, ["checkout", "-q", "-b", "feature/reviewed-head"]);
      const head = await commitFiles(
        fixture.repository,
        { "README.md": "# Reviewed head\n" },
        "Modify reviewed page",
      );
      const fake = new FakeGithub(fixture.repository);
      await fake.servePull({
        number: 7,
        state: "open",
        merged: false,
        baseSha: base,
        baseRef: "main",
        headSha: head,
        baseNow: base,
      });
      vi.stubGlobal("fetch", fake.fetch);
      const url = `https://github.com/${OWNER}/${NAME}/pull/7`;
      const request = parseRunArguments([
        "review-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        "Review the documentation set for technical accuracy.",
        "--change",
        url,
      ]);
      const pi = await createAuditHarness({
        reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
      });
      const record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
        silent: true,
        executionHarness: new RealReadReviewHarness(pi),
      });
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      const cold = decodeSuccessfulReviewRunRecord(
        (await new FileRunStore(fixture.stateDirectory).getWithDigest(record!.id)).record,
      );
      expect(cold.reviewScope).toBeUndefined();
      expect(
        cold.steps.find((step) => step.id === "verify-technical-accuracy")
          ?.reviewLocatorObservation,
      ).toBeDefined();
      const withoutAuthority = structuredClone(cold);
      delete withoutAuthority.steps.find((step) => step.id === "derive-source-obligations")!
        .originalSourceAuthority;
      expect(() => decodeSuccessfulReviewRunRecord(withoutAuthority)).toThrow();
      const staleAuthority = structuredClone(cold);
      const derive = staleAuthority.steps.find((step) => step.id === "derive-source-obligations")!;
      derive.originalSourceAuthority = {
        ...derive.originalSourceAuthority!,
        descriptor: {
          ...derive.originalSourceAuthority!.descriptor,
          repositoryRevision: "0".repeat(40),
        },
      };
      expect(() => decodeSuccessfulReviewRunRecord(staleAuthority)).toThrow();
      const source = decodeChangeSourceV1(
        (
          await resolveGithubChangeSource({
            selector: parseChangeSourceSelector(url) as Parameters<
              typeof resolveGithubChangeSource
            >[0]["selector"],
            fetch: fake.fetch,
          })
        ).changeSource,
      );
      expect(record!.changeSources?.[0]?.changeSourceSha256).toBe(source.changeSourceSha256);
      const target = createReviewTargetV2(
        {
          scmProvider: "github",
          host: "github.com",
          repositoryId: REPOSITORY_ID,
          headRepositoryId: REPOSITORY_ID,
          pullRequestNumber: 7,
          sourceBranch: "feature/reviewed-head",
          targetBranch: "main",
          baseSha: base,
          headSha: head,
          trigger: "api",
          requestIdentitySha256: sha256("review:github:7"),
          workflow: "review-documentation",
          deliveryIntent: "comment-existing-mr",
          logicalRequestId: "request:github:7",
          changeSourceSha256: source.changeSourceSha256,
        },
        source,
      );
      const result = reviewResultFromRun(record!, { target, source });
      const beforeBytes = new TextEncoder().encode("# Before\n");
      const afterBytes = new Uint8Array(await readFile(resolve(fixture.repository, "README.md")));
      const retained = {
        runStore: new FileRunStore(fixture.stateDirectory),
        artifacts: new DurableArtifactStore(resolve(fixture.stateDirectory, "..", "artifacts")),
        runId: record!.id,
        binding: { target, source },
      };
      const delivery = {
        snapshot: {
          changeSourceSha256: source.changeSourceSha256,
          files: [
            {
              oldPath: "README.md",
              newPath: "README.md",
              beforeBytes,
              afterBytes,
              beforeSha256: sha256(beforeBytes),
              afterSha256: sha256(afterBytes),
              state: "complete",
              hunks: [
                {
                  lines: [
                    { kind: "removed", text: "# Before", beforeLine: 1, afterLine: null },
                    { kind: "added", text: "# Reviewed head", beforeLine: null, afterLine: 1 },
                  ],
                },
              ],
            },
          ],
        },
        artifact: {
          kind: "retained-review-result",
          id: "artifact:github:7",
          resultSha256: result.resultSha256,
        },
        actor: { host: "github.com", id: "user:42" },
        capabilities: { scmProvider: "github", host: "github.com", summary: true, inline: true },
      } as const;
      const plan = await planRetainedReviewDelivery({ ...retained, delivery });
      expect(
        plan.findings.find(
          (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
        )?.disposition,
      ).toMatchObject({
        kind: "inline-candidate",
        anchor: { side: "after", path: "README.md", startLine: 1 },
      });
      const reference = cold.steps.find((step) => step.id === "verify-technical-accuracy")!
        .reviewLocatorObservation!;
      const manifest = decodeReviewLocatorObservation(
        await retained.artifacts.getRecord(reference.objectSha256),
      );
      const forgedTargetPaths = ["README.md", "unadmitted.md"];
      const forgedManifest = {
        ...manifest,
        targetPaths: forgedTargetPaths,
        domainSha256: sha256(
          canonicalJson({ ...manifest, targetPaths: forgedTargetPaths, domainSha256: undefined }),
        ),
      };
      const forgedObjectSha256 = opaqueRecordDigest(forgedManifest);
      await retained.artifacts.putRecord(forgedObjectSha256, forgedManifest);
      const forgedRun = structuredClone(cold);
      forgedRun.steps.find(
        (step) => step.id === "verify-technical-accuracy",
      )!.reviewLocatorObservation = {
        ...reference,
        objectSha256: forgedObjectSha256,
        domainSha256: forgedManifest.domainSha256,
      };
      const forgedStore = new FileRunStore(resolve(fixture.root, "unadmitted-target-state"));
      await forgedStore.save(forgedRun);
      const refused = await planRetainedReviewDelivery({
        ...retained,
        runStore: forgedStore,
        delivery,
      });
      expect(
        refused.findings.find(
          (finding) => finding.originalId === "issue:verify-technical-accuracy:TECH-001",
        ),
      ).toMatchObject({
        disposition: { kind: "summary-candidate", reason: "inline-unavailable" },
        limitations: expect.arrayContaining(["review-locator:observation-invalid"]),
      });
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );
  it(
    "retains the first V2 provider result before the real CLI run reports success",
    async () => {
      const fixture = await createSourceFixture({ "README.md": "# Before\n" });
      roots.track(fixture.root);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      const head = await commitFiles(
        fixture.repository,
        { "README.md": "# Reviewed head\n" },
        "Modify reviewed page",
      );
      const host = "gitlab.example.test";
      const projectPath = "team/docs-project";
      const projectId = 4242;
      const iid = 813;
      const url = `https://${host}/${projectPath}/-/merge_requests/${iid}`;
      const template = readFileSync(
        new URL("./fixtures/change-source-gitlab/merge-request-get.json", import.meta.url),
        "utf8",
      );
      const answer = JSON.parse(template, (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("@")
          ? ({ base, start: base, head, merge: null } as Record<string, unknown>)[value.slice(1)]
          : value,
      ) as Record<string, unknown>;
      answer.state = "opened";
      answer.merge_commit_sha = null;
      answer.squash_commit_sha = null;
      const commands = {
        async run(_command: string, args: readonly string[]) {
          const endpoint = String(args.at(-1));
          return {
            stdout: JSON.stringify(
              endpoint.includes("/merge_requests/")
                ? answer
                : { id: projectId, path_with_namespace: projectPath },
            ),
            stderr: "",
            exitCode: 0,
          };
        },
      };
      const request = {
        ...parseRunArguments([
          "review-documentation",
          "--repo",
          fixture.repository,
          "--instruction",
          "Review README.md for technical accuracy.",
          "--change",
          url,
        ]),
        runId: "retained-gitlab-original-814",
      };
      const resolvedChange = await resolveGitLabMergeRequestChangeSource({
        selector: parseChangeSourceSelector(url) as GitLabMergeRequestSelectorV1,
        sourcePath: fixture.repository,
        repositoryPath: fixture.repository,
        workspaceRevision: head,
        forge: { commands, environment: {} },
      });
      const source = decodeChangeSourceV1(resolvedChange.changeSource);
      const target = createReviewTargetV2(
        {
          scmProvider: "gitlab",
          host,
          projectId,
          mergeRequestIid: iid,
          sourceFork: false,
          sourceBranch: "topic",
          targetBranch: "main",
          baseSha: base,
          headSha: head,
          trigger: "api",
          requestIdentitySha256: sha256("review:814"),
          workflow: "review-documentation",
          deliveryIntent: "comment-existing-mr",
          logicalRequestId: "request:814",
          changeSourceSha256: source.changeSourceSha256,
        },
        source,
      );
      const beforeBytes = new TextEncoder().encode(
        `${await fixtureGit(fixture.repository, ["show", `${base}:README.md`])}\n`,
      );
      const afterBytes = new Uint8Array(await readFile(resolve(fixture.repository, "README.md")));
      const snapshot = {
        changeSourceSha256: source.changeSourceSha256,
        files: [
          {
            oldPath: "README.md",
            newPath: "README.md",
            beforeBytes,
            afterBytes,
            beforeSha256: sha256(beforeBytes),
            afterSha256: sha256(afterBytes),
            state: "complete" as const,
            hunks: [
              {
                lines: [
                  { kind: "removed" as const, text: "# Before", beforeLine: 1, afterLine: null },
                  {
                    kind: "added" as const,
                    text: "# Reviewed head",
                    beforeLine: null,
                    afterLine: 1,
                  },
                ],
              },
            ],
          },
        ],
      };
      const artifacts = new DurableArtifactStore(
        resolve(fixture.stateDirectory, "..", "artifacts"),
      );
      const repositoryBinding = { identitySha256: sha256(fixture.repository), revision: head };
      const acquired = await acquireChangeSourceObservations({
        resolved: resolvedChange,
        externalInputs: openExternalInputAccessCapture({
          runIdSha256: sha256(request.runId),
          repository: repositoryBinding,
        }),
        readScope: CLI_SOURCE_READ_SCOPE,
        runIdSha256: sha256(request.runId),
        repository: repositoryBinding,
        requestSha256: sha256("retained-test-request"),
        observedAt: new Date("2026-10-17T12:00:00.000Z").toISOString(),
        limits: cliSourceExtractionLimits(),
      });
      const observationIdFor = (role: "manifest" | "diff") =>
        acquired.acquired.find((entry) => entry.role === role)!.observation.observationId;
      const file = source.files[0]!;
      const retainedSource = await retainSourceSnapshotParts(artifacts, {
        runId: request.runId,
        sourceSha256: source.changeSourceSha256,
        repositoryIdentitySha256: source.revision.repository.identitySha256,
        reviewedHeadSha: head,
        snapshotSha256: reviewDeliverySnapshotDigest(snapshot, source),
        manifest: {
          observationId: observationIdFor("manifest"),
          bytes: resolvedChange.manifestBytes,
        },
        diff: { observationId: observationIdFor("diff"), bytes: resolvedChange.diffBytes },
        rows: [
          {
            state: "complete",
            sections: 1,
            before: {
              objectId: file.oldBlob!,
              bytes: beforeBytes,
              statedSha256: sha256(beforeBytes),
            },
            after: { objectId: file.newBlob!, bytes: afterBytes, statedSha256: sha256(afterBytes) },
          },
        ],
      });
      let original: ReturnType<typeof reviewResultFromRun> | undefined;
      let preRetentionRun: RunRecord | undefined;
      let preparedReference: ReviewDeliverySnapshotReferenceV1 | undefined;
      let prepareCalls = 0;
      let projectorCalls = 0;
      const pi = await createAuditHarness({
        reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
      });
      const record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
        silent: true,
        executionHarness: new RealReadReviewHarness(pi, ["README.md"], false),
        changeRequestCommands: commands,
        changeRequestEnvironment: {},
        outcomeProjector: {
          async project(run) {
            projectorCalls++;
            const evidence = workflowOutcomeStepEvidence(
              run as RunRecord,
              "evaluate-document-quality",
            );
            return {
              ...defaultInconclusiveWorkflowOutcome(run as RunRecord),
              disposition: "blocked" as const,
              evidence: [evidence],
              findings: [
                {
                  id: "finding:review-dependency",
                  kind: "blocked-dependency" as const,
                  severity: "blocking" as const,
                  code: "review-dependency",
                  evidenceIds: [evidence.id],
                },
              ],
              limitations: [],
              openDecisions: [
                {
                  id: "decision:review-dependency",
                  kind: "dependency" as const,
                  evidenceIds: [evidence.id],
                },
              ],
            };
          },
        },
        reviewResultRetention: {
          artifacts,
          async prepare(run) {
            prepareCalls++;
            expect(run.status).toBe("succeeded");
            expect(run.id).toBe(request.runId);
            expect(run.workflowOutcome?.findings.map((finding) => finding.code)).toContain(
              "review-dependency",
            );
            preRetentionRun = structuredClone(run) as RunRecord;
            original = reviewResultFromRun(run, { target, source });
            preparedReference = {
              kind: "docsfab-review-delivery-snapshot-reference",
              schemaVersion: 1,
              runId: run.id,
              rootObjectSha256: retainedSource.rootObjectSha256,
              snapshotSha256: reviewDeliverySnapshotDigest(snapshot, source),
              changeSourceSha256: source.changeSourceSha256,
              reviewedHeadSha: head,
              repositoryIdentitySha256: source.revision.repository.identitySha256,
            };
            return {
              originalResult: original,
              sourceReference: preparedReference,
            };
          },
        },
      });
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(prepareCalls).toBe(1);
      expect(projectorCalls).toBe(1);
      expect(original?.schemaVersion).toBe(4);
      expect(original?.findings.map((finding) => finding.code)).toContain("review-dependency");
      expect(original?.unresolvedQuestions.map((question) => question.summary)).toContain(
        "Open decision: decision:review-dependency.",
      );
      const runStore = new FileRunStore(fixture.stateDirectory);
      const saved = decodeSuccessfulReviewRunRecord(
        (await runStore.getWithDigest(request.runId)).record,
      );
      expect(saved.workflowOutcome).toBeDefined();
      const finalOutcome = decodeWorkflowOutcome(saved.workflowOutcome, saved);
      expect(finalOutcome.findings.map((finding) => finding.code)).toContain("review-dependency");
      expect(finalOutcome.openDecisions.map((decision) => decision.id)).toContain(
        "decision:review-dependency",
      );
      const resultUse = saved.artifacts?.filter((use) => use.reference.kind === "review-result");
      expect(resultUse).toHaveLength(1);
      expect(saved.steps.at(-1)?.artifacts).toContainEqual(resultUse![0]);
      const before = preRetentionRun!;
      const use = resultUse![0]!;
      const reference = preparedReference!;
      const after = {
        ...before,
        reviewDeliverySnapshot: reference,
        steps: before.steps.map((step, index) =>
          index === before.steps.length - 1
            ? { ...step, artifacts: [...(step.artifacts ?? []), use] }
            : step,
        ),
        artifacts: [...(before.artifacts ?? []), use],
      };
      const resealed = () =>
        resealWorkflowOutcomeAfterRetainedReviewResult({
          before,
          after,
          sourceReference: reference,
          resultUse: use,
        });
      expect(resealed()).toEqual(finalOutcome);
      const foreignRun = structuredClone(before);
      foreignRun.steps.at(-1)!.summary = "Independently completed foreign review.";
      const foreignOutcome = createWorkflowOutcome(
        defaultInconclusiveWorkflowOutcome(foreignRun),
        foreignRun,
      );
      expect(decodeWorkflowOutcome(foreignOutcome, foreignRun)).toEqual(foreignOutcome);
      expect(() =>
        resealWorkflowOutcomeAfterRetainedReviewResult({
          before: { ...before, workflowOutcome: foreignOutcome },
          after: { ...after, workflowOutcome: foreignOutcome },
          sourceReference: reference,
          resultUse: use,
        }),
      ).toThrow(ReviewResultTransitionError);
      expect(() =>
        resealWorkflowOutcomeAfterRetainedReviewResult({
          before: {
            ...before,
            workflowOutcome: { ...before.workflowOutcome!, outcomeSha256: "0".repeat(64) },
          },
          after,
          sourceReference: reference,
          resultUse: use,
        }),
      ).toThrow(ReviewResultTransitionError);
      expect(before.steps.at(-1)?.searchEvidence).toBeDefined();
      for (const changed of [
        {
          ...after,
          evidenceWarnings: [
            ...(after.evidenceWarnings ?? []),
            "Foreign warning added after the admitted prior outcome.",
          ],
        },
        {
          ...after,
          steps: after.steps.map((step, index) =>
            index === after.steps.length - 1 ? { ...step, summary: "changed" } : step,
          ),
        },
        {
          ...after,
          steps: after.steps.map((step, index) =>
            index === 0 ? { ...step, summary: "changed" } : step,
          ),
        },
        {
          ...after,
          steps: after.steps.map((step, index) =>
            index === after.steps.length - 1
              ? {
                  ...step,
                  searchEvidence: {
                    ...step.searchEvidence!,
                    evidenceSha256: "0".repeat(64),
                  },
                }
              : step,
          ),
        },
        {
          ...after,
          steps: after.steps.map((step, index) =>
            index === 0
              ? {
                  ...step,
                  tools: { ...step.tools!, failedCalls: (step.tools?.failedCalls ?? 0) + 1 },
                }
              : step,
          ),
        },
        {
          ...after,
          artifacts: [
            ...after.artifacts,
            {
              ...use,
              reference: { ...use.reference, digest: "f".repeat(64) },
            },
          ],
        },
        { ...after, artifacts: after.artifacts.filter((item) => item !== use) },
      ]) {
        expect(() =>
          resealWorkflowOutcomeAfterRetainedReviewResult({
            before,
            after: changed,
            sourceReference: reference,
            resultUse: use,
          }),
        ).toThrow(ReviewResultTransitionError);
      }
      const priorOutput = {
        role: "output" as const,
        stepId: before.steps.at(-1)!.id,
        reference: {
          kind: "context-packet" as const,
          schemaVersion: 1 as const,
          digest: sha256("preexisting-review-output"),
          repositoryRevision: before.repository.revision,
          repositoryContentDigest: sha256("preexisting-review-content"),
        },
      };
      const withPriorOutput = structuredClone(before);
      withPriorOutput.steps.at(-1)!.artifacts = [
        ...(withPriorOutput.steps.at(-1)!.artifacts ?? []),
        priorOutput,
      ];
      withPriorOutput.artifacts = [...(withPriorOutput.artifacts ?? []), priorOutput];
      const priorClaims = decodeWorkflowOutcome(before.workflowOutcome, before);
      withPriorOutput.workflowOutcome = createWorkflowOutcome(
        {
          disposition: priorClaims.disposition,
          findings: priorClaims.findings,
          evidence: priorClaims.evidence.map((evidence) =>
            evidence.kind === "step" && evidence.stepId === priorOutput.stepId
              ? workflowOutcomeStepEvidence(withPriorOutput, evidence.stepId)
              : evidence,
          ),
          limitations: priorClaims.limitations,
          openDecisions: priorClaims.openDecisions,
          producedArtifacts: [...priorClaims.producedArtifacts, priorOutput.reference],
        },
        withPriorOutput,
      );
      expect(decodeWorkflowOutcome(withPriorOutput.workflowOutcome, withPriorOutput)).toEqual(
        withPriorOutput.workflowOutcome,
      );
      const priorAfter = {
        ...withPriorOutput,
        reviewDeliverySnapshot: reference,
        steps: withPriorOutput.steps.map((step, index) =>
          index === withPriorOutput.steps.length - 1
            ? { ...step, artifacts: [...(step.artifacts ?? []), use] }
            : step,
        ),
        artifacts: [...(withPriorOutput.artifacts ?? []), use],
      };
      expect(
        resealWorkflowOutcomeAfterRetainedReviewResult({
          before: withPriorOutput,
          after: priorAfter,
          sourceReference: reference,
          resultUse: use,
        }),
      ).toBeDefined();
      for (const mutation of ["remove", "replace", "extra"] as const) {
        const changed = structuredClone(priorAfter);
        const final = changed.steps.at(-1)!;
        const replacement = {
          ...priorOutput,
          reference: { ...priorOutput.reference, digest: sha256("replaced-output") },
        };
        if (mutation === "remove") {
          final.artifacts = final.artifacts?.filter(
            (entry) => entry.reference.digest !== priorOutput.reference.digest,
          );
          changed.artifacts = changed.artifacts?.filter(
            (entry) => entry.reference.digest !== priorOutput.reference.digest,
          );
        } else if (mutation === "replace") {
          final.artifacts = final.artifacts?.map((entry) =>
            entry.reference.digest === priorOutput.reference.digest ? replacement : entry,
          );
          changed.artifacts = changed.artifacts?.map((entry) =>
            entry.reference.digest === priorOutput.reference.digest ? replacement : entry,
          );
        } else {
          final.artifacts?.push(replacement);
          changed.artifacts?.push(replacement);
        }
        expect(() =>
          resealWorkflowOutcomeAfterRetainedReviewResult({
            before: withPriorOutput,
            after: changed,
            sourceReference: reference,
            resultUse: use,
          }),
        ).toThrow(ReviewResultTransitionError);
      }
      const stored = await artifacts.getRecord(resultUse![0]!.reference.digest, { readOnly: true });
      expect(canonicalJson(stored)).toBe(canonicalJson(original));
      expect(resultUse![0]!.reference.digest).toBe(opaqueRecordDigest(original));
      const cold = await loadRetainedReviewResult({
        runStore,
        artifacts,
        runId: request.runId,
        target,
      });
      expect(canonicalJson(cold.result)).toBe(canonicalJson(original));
      expect(cold.result.resultSha256).toBe(original!.resultSha256);
      expect(canonicalJson(cold.source.source)).toBe(canonicalJson(source));
      expect(reviewDeliverySnapshotDigest(cold.source.snapshot, source)).toBe(
        reviewDeliverySnapshotDigest(snapshot, source),
      );
      const unattachedRun = () => ({
        ...before,
        reviewDeliverySnapshot: reference,
        steps: structuredClone(before.steps),
        artifacts: structuredClone(before.artifacts),
      });
      const resultObjectId = opaqueRecordDigest(original);
      const putOriginal = artifacts.putRecord.bind(artifacts);
      const putFailure = vi
        .spyOn(artifacts, "putRecord")
        .mockImplementation(async (digest, body) => {
          if (digest === resultObjectId) throw new Error("private result put failed");
          return putOriginal(digest, body);
        });
      try {
        const failed = unattachedRun();
        await expect(
          retainOriginalReviewResult({ run: failed, artifacts, result: original! }),
        ).rejects.toThrow("private result put failed");
        expect(
          failed.artifacts?.some((item) => item.reference.kind === "review-result") ?? false,
        ).toBe(false);
      } finally {
        putFailure.mockRestore();
      }
      const getOriginal = artifacts.getRecord.bind(artifacts);
      const readFailure = vi
        .spyOn(artifacts, "getRecord")
        .mockImplementation(async (digest, opts) =>
          digest === resultObjectId
            ? { ...original, resultSha256: "0".repeat(64) }
            : getOriginal(digest, opts),
        );
      try {
        const failed = unattachedRun();
        await expect(
          retainOriginalReviewResult({ run: failed, artifacts, result: original! }),
        ).rejects.toThrow("result-object-address-mismatch");
        expect(
          failed.artifacts?.some((item) => item.reference.kind === "review-result") ?? false,
        ).toBe(false);
      } finally {
        readFailure.mockRestore();
      }
      const delivery = {
        snapshot,
        artifact: {
          kind: "retained-review-result" as const,
          id: "artifact:814",
          resultSha256: original!.resultSha256,
        },
        actor: { host, id: "user:42" },
        capabilities: { scmProvider: "gitlab" as const, host, summary: true, inline: true },
      };
      const plan = await planRetainedReviewDelivery({
        runStore,
        artifacts,
        runId: request.runId,
        binding: { target, source },
        delivery,
      });
      expect(plan.actions.map((action) => action.kind)).toContain("publish-summary");
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );
});
