// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { createSourceToolDefinitions } from "../src/harness/source-tools.js";
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
import { sourceObligationProposalFixture, verificationFixture } from "./helpers/verification.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { skillResolver } from "./support/source-acquisition-cli.js";
import { listedInventory } from "./support/source-listing.js";
import { githubPrReviewFixture } from "./support/github-pr-review-fixture.js";
import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { savedRunRecordBytes } from "../src/records/file-store.js";
import { decodeSavedRunRecord } from "../src/records/saved-run-record.js";
import { decodePrReviewSourceCitations } from "../src/records/pr-review-source-citations.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  createSourceBinding,
  createSourceObservation,
  createSourceSpanAccess,
  SOURCE_EXACT_ORIGINAL_FORM,
} from "../src/inputs/source-evidence.js";
import { limitDefinition } from "../src/config/limits.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import { changeSourceRepositoryPath } from "../src/inputs/change-source/acquisition.js";
import { withGithubPrReviewBasis } from "../src/inputs/adapters/github-pr-provider.js";
import { resolveCliPrReviewSourceEvidence } from "../src/cli/run/source-acquisition.js";
import { admitWorkflowRunRequest } from "../src/workflow-execution/runner-admission.js";
import type { WorkflowRunnerOptions } from "../src/workflow-execution/runner-ports.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { createPrReviewCheckAdmission } from "../src/workflow-execution/pr-review-check-admission.js";
import { WorkflowChecksHostOperation } from "../src/workflow-execution/workflow-checks.js";
import { createAuditHarness, textTurn, toolTurn } from "./support/pi-harness-session-fixtures.js";
import { validModelConfig } from "./helpers.js";
import { createChangeSnapshot } from "../src/inputs/change-snapshot.js";
import { projectVerifiedGitlabChange } from "../src/inputs/adapters/gitlab-change-projection.js";
import { projectPrReviewScope } from "../src/workflow-execution/pr-review-scope.js";
import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { executeWorkflowApplication } from "../src/application/execute-workflow.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { projectQualityReportFromRun } from "../src/evaluation-report/contracts.js";
import { persistHostedQualityReport } from "../src/evaluation-report/hosted-report.js";
import type { RunRequest } from "../src/execution/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const reviewSummary = (path = "docs/after.md", duplicateFinding = false) =>
  canonicalizeJsonEvidence({
    verdict: "needs-revision",
    issues: [
      {
        id: "FACT-001",
        severity: "minor",
        category: "technical_accuracy",
        location: `${path}:1`,
        finding: "The proposed page is titled Proposal after.",
        evidence: { source_id: path, locator: `${path}:1` },
        required_change: "Confirm that the proposed page title is intended.",
      },
      ...(duplicateFinding
        ? [
            {
              id: "FACT-002",
              severity: "minor",
              category: "technical_accuracy",
              location: `${path}:2`,
              finding: "The proposed page is titled Proposal after.",
              evidence: { source_id: path, locator: `${path}:2` },
              required_change: "Confirm the title on the second line.",
            },
          ]
        : []),
    ],
  } as JsonEvidenceValue).trimEnd();

const emptyReviewSummary = canonicalizeJsonEvidence({
  verdict: "pass",
  issues: [],
} as JsonEvidenceValue).trimEnd();

class ReviewHarness implements AgentHarness {
  constructor(
    readonly reviewPath = "docs/after.md",
    readonly issueCitation = true,
    readonly readPath?: string,
    readonly emptyFindings = false,
    readonly skipSourceRead = false,
    readonly readStepId = "review-documentation",
    readonly duplicateFindingSummary = false,
  ) {}
  readonly readTexts: string[] = [];
  readonly listedPaths: string[] = [];
  readonly steps: string[] = [];
  readonly cited: string[] = [];
  async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.steps.push(input.step.id);
    if (input.sourceReader && input.step.id === this.readStepId && !this.skipSourceRead) {
      const tools = createSourceToolDefinitions({
        reader: input.sourceReader,
        citer: input.sourceCiter,
        recordFailure: () => undefined,
      });
      const list = tools.find((tool) => tool.name === "docsfab_list_sources")!;
      const read = tools.find((tool) => tool.name === "docsfab_read_source")!;
      const result = (await (list.execute as (id: string, params: unknown) => Promise<unknown>)(
        "list",
        {},
      )) as {
        content: { text: string }[];
      };
      const inventory = listedInventory(result.content[0]!.text);
      this.listedPaths.push(...inventory.map((entry) => entry.repositoryPath ?? ""));
      const span =
        (this.readPath
          ? inventory.find((candidate) => candidate.repositoryPath === this.readPath)
          : undefined) ?? inventory[0]!;
      const viewed = (await (read.execute as (id: string, params: unknown) => Promise<unknown>)(
        "read",
        {
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        },
      )) as { content: { text: string }[] };
      this.readTexts.push(viewed.content[0]!.text);
      const cite = tools.find((tool) => tool.name === "docsfab_cite_source");
      if (cite && this.issueCitation) {
        await (cite.execute as (id: string, params: unknown) => Promise<unknown>)("cite", {
          claim: "The proposed page is titled Proposal after.",
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        });
        this.cited.push(span.spanId);
      }
    }
    if (requiresSourceObligationLedger(input)) {
      const proposal = sourceObligationProposalFixture(`${this.reviewPath}:1`);
      return {
        summary: canonicalSourceObligationProposal(proposal),
        sourceObligationProposal: proposal,
      };
    }
    if (input.step.id === "review-documentation") {
      return {
        summary: this.emptyFindings
          ? emptyReviewSummary
          : reviewSummary(this.reviewPath, this.duplicateFindingSummary),
      };
    }
    if (input.step.id === "evaluate-document-quality") {
      const candidate = await authoringFixtureCandidateForInput(input);
      return {
        summary: candidate.reportMarkdown,
        qualityArtifactCandidate: candidate,
      };
    }
    return {
      summary: `Completed ${input.step.id}.`,
      ...(await verificationFixture(input)),
    };
  }
}

class ScriptedPiReview {
  constructor(readonly reviewPath = "docs/after.md") {}
  readonly reads: string[] = [];
  readonly citations: string[] = [];
  readonly fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith(validModelConfig.baseUrl))
      throw new Error(`Unexpected model transport ${String(url)}`);
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<{
        role: string;
        tool_call_id?: string;
        content: unknown;
      }>;
    };
    const tools = request.messages.filter((message) => message.role === "tool");
    const text = (value: unknown) =>
      typeof value === "string"
        ? value
        : (value as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
    if (tools.length === 0)
      return toolTurn([{ id: "list", name: "docsfab_list_sources", arguments: {} }]);
    if (tools.length === 1) {
      const span = listedInventory(text(tools[0]!.content))[0]!;
      return toolTurn([
        {
          id: "read",
          name: "docsfab_read_source",
          arguments: {
            observationId: span.observationId,
            representationId: span.representationId,
            spanIds: [span.spanId],
          },
        },
      ]);
    }
    if (tools.length === 2) {
      this.reads.push(text(tools[1]!.content));
      const span = listedInventory(text(tools[0]!.content))[0]!;
      return toolTurn([
        {
          id: "cite",
          name: "docsfab_cite_source",
          arguments: {
            claim: "The proposed page is titled Proposal after.",
            observationId: span.observationId,
            representationId: span.representationId,
            spanIds: [span.spanId],
          },
        },
      ]);
    }
    this.citations.push(text(tools.at(-1)!.content));
    return textTurn(reviewSummary(this.reviewPath));
  }) as typeof globalThis.fetch;
}

class PiReviewHarness extends ReviewHarness {
  constructor(
    private readonly pi: Awaited<ReturnType<typeof createAuditHarness>>,
    reviewPath = "docs/after.md",
  ) {
    super(reviewPath);
  }
  override async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (input.step.id !== "review-documentation") return super.runStep(input);
    this.steps.push(input.step.id);
    return this.pi.runStep(input);
  }
}

describe("installed GitHub PR review path", () => {
  it(
    "rejects a substituted repository path at actual runner admission for the CLI H binding",
    async () => {
      const f = await githubPrReviewFixture();
      roots.push(f.root);
      await mkdir(join(f.root, "source-admission"));
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          scratchRoot: f.scratch,
          workspaceRoot: join(f.root, "source-admission"),
        },
        async (basis) => {
          const runId = "cli-h-source-admission";
          const request: RunRequest = {
            runId,
            workflow: "review-documentation",
            workspacePath: basis.headWorkspace.path,
            repository: {
              sourcePath: basis.headWorkspace.sourcePath,
              requestedRevision: basis.headWorkspace.H,
              revision: basis.headWorkspace.H,
            },
            allowWrite: false,
          };
          const custody = await resolveCliPrReviewSourceEvidence({
            basis,
            workspace: basis.headWorkspace,
            targetPaths: ["docs/after.md"],
            sourcePaths: ["docs/unchanged.md"],
            admittedRequest: request as unknown as Record<string, unknown>,
            runId,
          });
          try {
            expect(custody.sourceEvidence).not.toBeNull();
            expect(custody.sourceReference).not.toBeNull();
            expect(custody.observations.map((entry) => entry.original.repositoryPath)).toContain(
              "docs/unchanged.md",
            );
            const options = {
              harness: {
                async runStep() {
                  throw new Error("Admission must not invoke a model.");
                },
              },
              store: {
                async save() {
                  throw new Error("Admission must not save a record.");
                },
              },
              repositoryScanner: {
                async scan() {
                  throw new Error("Admission must not scan a repository.");
                },
              },
              sourceEvidence: custody.sourceEvidence!,
              sourceObligationObserver: new LocalSourceObligationSourceObserver(
                basis.headWorkspace,
              ),
            } as unknown as WorkflowRunnerOptions;
            const runner = { options, id: () => runId, timestamp: () => new Date().toISOString() };
            const bound = { ...request, sourceBinding: custody.sourceReference! };
            expect(admitWorkflowRunRequest(runner, bound).sourceCapability).toBeDefined();
            expect(() =>
              admitWorkflowRunRequest(runner, {
                ...bound,
                repository: {
                  ...bound.repository,
                  sourcePath: `${bound.repository.sourcePath}-substituted`,
                },
              }),
            ).toThrow(/repository-mismatch/u);
          } finally {
            custody.dispose();
          }
        },
      );
    },
    testTimeoutMs(90_000),
  );

  it.each([
    ["explicit H source beside changed MDX", false, "forked-mdx", "docs/after.mdx"],
    ["code-only change with H documentation", true, "markdown", "docs/unchanged.md"],
  ] as const)(
    "reads and cites %s through one installed PR run",
    async (_label, codeOnly, layout, reviewPath) => {
      const f = await githubPrReviewFixture(codeOnly, false, false, false, 0, layout);
      roots.push(f.root);
      const harness = new ReviewHarness(reviewPath, true, "docs/unchanged.md");
      const record = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--pr",
          "https://github.com/target/docs/pull/884",
          "--source",
          "docs/unchanged.md",
        ]),
        { ...runtimeConfig(join(f.root, "state")), projectRoot: f.work },
        {
          silent: true,
          executionHarness: harness,
          skillResolver,
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(record?.prReviewBasis).toMatchObject({ B: f.B, H: f.H, M: f.M });
      expect(harness.listedPaths).toContain("docs/unchanged.md");
      expect(harness.readTexts.join("\n")).toContain("Unchanged at H");
      expect(harness.readTexts.join("\n")).not.toContain("Mutable caller checkout");
      expect(record?.prReviewSourceCitations?.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "review-documentation",
            status: "cited",
          }),
        ]),
      );
      const saved = decodeSavedRunRecord(
        (await new FileRunStore(join(f.root, "state")).get(record!.id)) as never,
        record!.id,
      );
      expect(saved).toMatchObject({
        id: record!.id,
        prReviewSourceCitations: { kind: "docsfab-pr-review-source-citations" },
      });
      const report = await readFile(
        join(f.root, "state", "reports", record!.id, "quality-report.md"),
        "utf8",
      );
      expect(report).toContain("Admitted source spans:");
      if (codeOnly) {
        expect(record?.reviewScope?.targetPaths).toContain("docs/unchanged.md");
        expect(record?.reviewScope?.reason).toBe("scan-unavailable");
      }
    },
    testTimeoutMs(90_000),
  );

  it(
    "retains an earlier admitted read after an uncited review settlement",
    async () => {
      const f = await githubPrReviewFixture(false, false, false, false, 0, "mixed-code");
      roots.push(f.root);
      const harness = new ReviewHarness(
        "docs/after.md",
        false,
        undefined,
        false,
        false,
        "audit-documentation",
      );
      const record = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--pr",
          "https://github.com/target/docs/pull/884",
        ]),
        { ...runtimeConfig(join(f.root, "state")), projectRoot: f.work },
        {
          silent: true,
          executionHarness: harness,
          skillResolver,
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(harness.readTexts.length).toBeGreaterThan(0);
      expect(record?.prReviewSourceCitations?.spanAccesses).toEqual(
        expect.arrayContaining([expect.objectContaining({ stepId: "audit-documentation" })]),
      );
      expect(record?.prReviewSourceCitations?.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "uncited", citations: [] })]),
      );
      const saved = decodeSavedRunRecord(
        (await new FileRunStore(join(f.root, "state")).get(record!.id)) as never,
        record!.id,
      );
      expect(saved.prReviewSourceCitations?.spanAccesses).toEqual(
        record?.prReviewSourceCitations?.spanAccesses,
      );
      const bytes = savedRunRecordBytes(record!).bytes.byteLength;
      const bound = limitDefinition("runs.recordMaxBytes").value;
      expect(bytes, `multi-document saved record: ${bytes} bytes against ${bound}`).toBeLessThan(
        bound,
      );
      console.info(`PR review mixed-code saved record: ${bytes} / ${bound} bytes`);

      const citationRecord = saved.prReviewSourceCitations!;
      const reseal = (patch: Partial<typeof citationRecord>) => {
        const { digestSha256: _digest, ...body } = citationRecord;
        const changed = { ...body, ...patch };
        return { ...changed, digestSha256: canonicalDigest(changed) };
      };
      const reject = (patch: Partial<typeof citationRecord>, reason: RegExp) =>
        expect(() => decodePrReviewSourceCitations(reseal(patch), saved)).toThrow(reason);
      const access = citationRecord.spanAccesses[0]!;
      const {
        schemaVersion: _accessVersion,
        kind: _accessKind,
        spanAccessSha256: _accessSeal,
        ...accessBody
      } = access;
      const alteredAccess = (patch: Partial<typeof accessBody>) =>
        createSourceSpanAccess({ ...accessBody, ...patch });
      reject(
        { spanAccesses: [alteredAccess({ bindingSha256: "f".repeat(64) })] },
        /access receipt differs from its source binding/u,
      );
      reject(
        { spanAccesses: [alteredAccess({ observationId: "foreign-observation" })] },
        /access receipt differs from its source binding/u,
      );
      reject(
        { spanAccesses: [alteredAccess({ representationSha256: "f".repeat(64) })] },
        /access receipt differs from its source binding/u,
      );
      reject(
        { spanAccesses: [alteredAccess({ spanIds: ["foreign-span"] })] },
        /access receipt differs from its source binding/u,
      );
      reject(
        { spanAccesses: [alteredAccess({ stepId: "not-a-retained-step" })] },
        /access receipt differs from its source binding/u,
      );
      reject({ spanAccesses: [access, access] }, /access receipt differs from its source binding/u);
      const observation = citationRecord.sourceObservations.find(
        (row) => row.observationId === access.observationId,
      )!;
      const representation = observation.representations.find(
        (row) => row.representationId === access.representationId,
      )!;
      const chargeBody = { ...accessBody };
      if (representation.form === SOURCE_EXACT_ORIGINAL_FORM) {
        delete chargeBody.serializedChargeBytes;
      } else {
        chargeBody.serializedChargeBytes = 1;
      }
      reject(
        { spanAccesses: [createSourceSpanAccess(chargeBody)] },
        /access receipt differs from its source binding/u,
      );
      reject(
        { sourceObservations: citationRecord.sourceObservations.slice(1) },
        /source observations differ from the admitted binding/u,
      );
      reject(
        { sourceObservations: [...citationRecord.sourceObservations, observation] },
        /source observations differ from the admitted binding/u,
      );
      const {
        schemaVersion: _bindingVersion,
        kind: _bindingKind,
        bindingSha256: _bindingSeal,
        ...bindingBody
      } = citationRecord.sourceBinding;
      const runBinding = createSourceBinding({ ...bindingBody, runIdSha256: "f".repeat(64) });
      reject(
        { sourceBinding: runBinding, bindingSha256: runBinding.bindingSha256 },
        /source binding differs from the retained run/u,
      );
      const repositoryBinding = createSourceBinding({
        ...bindingBody,
        repository: { ...bindingBody.repository, identitySha256: "f".repeat(64) },
      });
      reject(
        { sourceBinding: repositoryBinding, bindingSha256: repositoryBinding.bindingSha256 },
        /source binding differs from the retained run/u,
      );
      const {
        schemaVersion: _observationVersion,
        kind: _observationKind,
        observationSha256: _observationSeal,
        ...observationBody
      } = observation;
      const requestObservation = createSourceObservation({
        ...observationBody,
        requestSha256: "f".repeat(64),
      });
      const requestBinding = createSourceBinding({
        ...bindingBody,
        observations: bindingBody.observations.map((row) =>
          row.observationId === observation.observationId
            ? { ...row, observationSha256: requestObservation.observationSha256 }
            : row,
        ),
      });
      reject(
        {
          sourceBinding: requestBinding,
          bindingSha256: requestBinding.bindingSha256,
          sourceObservations: citationRecord.sourceObservations.map((row) =>
            row.observationId === observation.observationId ? requestObservation : row,
          ),
        },
        /source observations differ from the admitted binding/u,
      );
    },
    testTimeoutMs(90_000),
  );

  it(
    "projects paired provider snapshots from verified native host facts through the shared application and report",
    async () => {
      const f = await githubPrReviewFixture(false, false, false, false, 0, "mixed-code");
      roots.push(f.root);
      await mkdir(join(f.root, "paired-basis"));
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          scratchRoot: f.scratch,
          workspaceRoot: join(f.root, "paired-basis"),
        },
        async (basis) => {
          const { B, H, M, baseTree, headTree, mergeTree, proposalCommits } =
            basis.acquisition.graph;
          const graph = {
            B,
            H,
            M,
            baseTree,
            headTree,
            mergeTree,
            proposalCommits,
          };
          const nativeSides = basis.acquisition.sides.map((side) => ({
            side: side.side,
            path: side.path,
            repositoryId: String(side.repositoryId),
            blobId: side.blobId,
            originalSha256: side.originalSha256,
            originalByteLength: side.bytes.byteLength,
            observationId: null,
            observationSha256: null,
          }));
          const github = createChangeSnapshot({
            ref: basis.acquisition.ref,
            sourceRepositoryId: String(basis.acquisition.headRepositoryId),
            graph,
            manifest: [...basis.acquisition.manifest],
            sourceSides: nativeSides,
            sourceBindingSha256: null,
            limitations: [],
            completeness: "complete",
          });
          // This is a host-fixture projection of the same authenticated native
          // facts, not an installed GitLab fetch or independent GitLab custody.
          const gitlab = projectVerifiedGitlabChange({
            host: "gitlab.example.test",
            targetProjectId: basis.headWorkspace.targetRepositoryId,
            sourceProjectId: basis.headWorkspace.headRepositoryId,
            mergeRequestIid: 813,
            graph,
            manifest: [...basis.acquisition.manifest],
            sourceSides: nativeSides,
            sourceBindingSha256: null,
            limitations: [],
          }).snapshot;
          expect(gitlab.ref.provider).toBe("gitlab");
          expect(gitlab.graph).toEqual(github.graph);
          expect(gitlab.manifest).toEqual(github.manifest);
          expect(gitlab.sourceSides).toEqual(github.sourceSides);
          const workflow = getWorkflow("review-documentation");
          const observed: Array<{
            scope: RunRequest["reviewScope"];
            scopeProjection: {
              impact: string;
              changedDocumentationPaths: readonly string[];
              deletedDocumentationPaths: readonly string[];
              limitations: readonly string[];
            };
            findings: Array<{
              code: string;
              summary: string;
              path: string | null;
            }>;
            findingAvailability: string;
            findingLimitations: readonly string[];
            quality: ReturnType<typeof projectQualityReportFromRun>;
            reportAvailable: boolean;
            markdownAvailable: boolean;
            checks: string | undefined;
          }> = [];
          for (const [provider, snapshot] of [
            ["github", github],
            ["gitlab", gitlab],
          ] as const) {
            const projectedScope = projectPrReviewScope({
              manifest: snapshot.manifest,
              headInventory: basis.headInventory,
              baseDocumentation: basis.baseDocumentation,
            });
            const stateDirectory = join(f.root, `paired-${provider}-state`);
            const config = {
              ...runtimeConfig(stateDirectory),
              projectRoot: f.work,
            };
            const repositoryEvidence = await GitPatchEvidenceCollector.create(
              basis.headWorkspace.path,
              join(f.root, `paired-${provider}-patches`),
            );
            try {
              const request: RunRequest = {
                workflow: "review-documentation",
                workspacePath: basis.headWorkspace.path,
                repository: {
                  sourcePath: basis.headWorkspace.sourcePath,
                  requestedRevision: basis.headWorkspace.requestedRevision,
                  revision: basis.headWorkspace.revision,
                },
                reviewScope: projectedScope.scope,
                allowWrite: false,
              };
              const assembled = await createLocalWorkflowApplicationServices({
                config,
                request,
                workflow,
                workspace: basis.headWorkspace,
                prReviewScope: projectedScope.scope,
                repositoryEvidence,
                baseHarness: new ReviewHarness(),
                skillResolver,
                hostOperations: new WorkflowChecksHostOperation(
                  basis.headWorkspace,
                  "lint-documentation",
                  { prReviewAdmission: createPrReviewCheckAdmission(basis) },
                ),
              });
              const record = await executeWorkflowApplication({
                services: assembled.services,
                request,
              });
              expect(record.status, record.error).toBe("succeeded");
              const findings = projectReviewFindingsFromRun(record);
              const quality = projectQualityReportFromRun(record);
              const evaluatorMarkdown = record.steps.find(
                (step) => step.id === "evaluate-document-quality",
              )!.summary!;
              expect(quality?.reportLocator.digestSha256).toBe(
                createHash("sha256").update(evaluatorMarkdown).digest("hex"),
              );
              const report = await persistHostedQualityReport({
                stateDirectory,
                runId: record.id,
                quality,
                markdown: evaluatorMarkdown,
              });
              observed.push({
                scope: record.reviewScope,
                scopeProjection: {
                  impact: projectedScope.impact,
                  changedDocumentationPaths: projectedScope.changedDocumentationPaths,
                  deletedDocumentationPaths: projectedScope.deletedDocumentationPaths,
                  limitations: projectedScope.limitations,
                },
                findings: findings.findings.map((finding) => ({
                  code: finding.code,
                  summary: finding.summary,
                  path: finding.path,
                })),
                findingAvailability: findings.availability,
                findingLimitations: findings.limitations,
                quality,
                reportAvailable: report.reportAvailable,
                markdownAvailable: report.markdownAvailable,
                checks: record.steps.find((step) => step.id === "lint-documentation")?.summary,
              });
            } finally {
              await repositoryEvidence.dispose();
            }
          }
          expect(observed).toHaveLength(2);
          expect(observed[0]?.scope).toEqual(observed[1]?.scope);
          expect(observed[0]?.scopeProjection).toEqual(observed[1]?.scopeProjection);
          expect(observed[0]?.findings).toEqual(observed[1]?.findings);
          expect(observed[0]?.findingAvailability).toEqual(observed[1]?.findingAvailability);
          expect(observed[0]?.findingLimitations).toEqual(observed[1]?.findingLimitations);
          // The evaluator artifact is minted separately for each run. Compare
          // its decoded judgment and coverage while retaining each real digest.
          const qualitySemantics = (quality: (typeof observed)[number]["quality"]) =>
            quality === null
              ? null
              : {
                  ...quality,
                  reportLocator: { kind: quality.reportLocator.kind },
                };
          expect(qualitySemantics(observed[0]!.quality)).toEqual(
            qualitySemantics(observed[1]!.quality),
          );
          expect(observed[0]?.quality?.reportLocator.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
          expect(observed[1]?.quality?.reportLocator.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
          expect(observed[0]?.reportAvailable).toEqual(observed[1]?.reportAvailable);
          expect(observed[0]?.markdownAvailable).toEqual(observed[1]?.markdownAvailable);
          expect(observed[0]?.checks).toEqual(observed[1]?.checks);
          expect(observed[0]?.scope?.targetPaths).toContain("docs/unchanged.md");
          expect(observed[0]?.scope?.deferredPaths).toEqual([]);
          expect(observed[0]?.scopeProjection.impact).toBe("documentation-set-uncertain");
          expect(observed[0]?.scopeProjection.deletedDocumentationPaths).toContain(
            "docs/deleted.md",
          );
          expect(observed[0]?.scopeProjection.limitations).toEqual(
            expect.arrayContaining([
              expect.stringContaining("Non-documentation, deleted, or uncertain changes"),
            ]),
          );
          expect(observed[0]?.checks).toContain("pr-review-not-admitted");
          expect(observed[0]?.quality).not.toBeNull();
          expect(observed[0]?.reportAvailable).toBe(true);
          expect(observed[0]?.markdownAvailable).toBe(true);
        },
      );
    },
    testTimeoutMs(90_000),
  );
  it(
    "invents no check authority for a PR even when a runnable backend is available",
    async () => {
      const f = await githubPrReviewFixture();
      roots.push(f.root);
      await mkdir(join(f.root, "basis"));
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          scratchRoot: f.scratch,
          workspaceRoot: join(f.root, "basis"),
        },
        async (basis) => {
          let prepares = 0;
          let runs = 0;
          const prepareAuthority = async () => {
            prepares += 1;
            return {
              resolve: async (program: string) => `/usr/bin/${program}`,
              run: async () => {
                runs += 1;
                return {
                  status: "passed" as const,
                  exitCode: 0,
                  output: "checked",
                };
              },
              cleanup: async () => undefined,
            };
          };
          const input: HarnessStepInput = {
            repositoryPath: basis.headWorkspace.path,
            step: {
              id: "lint-documentation",
              title: "Check documentation",
              skill: "lint-documentation",
              mode: "read-only",
              prompt: "",
            },
            workflow: {
              name: "review-documentation",
              title: "Review",
              outcome: "Review documentation",
              contextPolicy: { schemaVersion: 1, steps: [] },
              steps: [],
            },
          };
          const refused = await new WorkflowChecksHostOperation(
            basis.headWorkspace,
            "lint-documentation",
            {
              prReviewAdmission: createPrReviewCheckAdmission(basis),
              prepareAuthority,
            },
          ).runStep(input);
          const checks = JSON.parse(refused.summary) as {
            checks: Array<{ command?: string; status: string; cause?: string }>;
          };
          expect(checks.checks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                command: "npm run lint:docs",
                status: "unavailable",
                cause: "pr-review-not-admitted",
              }),
            ]),
          );
          expect(prepares).toBe(0);
          expect(runs).toBe(0);
          const ordinary = await new WorkflowChecksHostOperation(
            basis.headWorkspace,
            "lint-documentation",
            {
              prepareAuthority,
            },
          ).runStep(input);
          expect(prepares).toBe(1);
          expect(runs).toBeGreaterThan(0);
          expect(
            (
              JSON.parse(ordinary.summary) as {
                checks: Array<{ status: string }>;
              }
            ).checks,
          ).toEqual(expect.arrayContaining([expect.objectContaining({ status: "passed" })]));
        },
      );
    },
    testTimeoutMs(90_000),
  );

  it(
    "retains a canonical finding as uncited after read without cite",
    async () => {
      const f = await githubPrReviewFixture();
      roots.push(f.root);
      const harness = new ReviewHarness("docs/after.md", false);
      const record = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--pr",
          "https://github.com/target/docs/pull/884",
        ]),
        { ...runtimeConfig(join(f.root, "state")), projectRoot: f.work },
        {
          silent: true,
          executionHarness: harness,
          skillResolver,
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(harness.readTexts.length).toBeGreaterThan(0);
      expect(record?.prReviewSourceCitations?.spanAccesses).toEqual(
        expect.arrayContaining([expect.objectContaining({ stepId: "review-documentation" })]),
      );
      expect(record?.prReviewSourceCitations?.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "review-documentation",
            status: "uncited",
            citations: [],
          }),
        ]),
      );
      const report = await readFile(
        join(f.root, "state", "reports", record!.id, "quality-report.md"),
        "utf8",
      );
      expect(report).toContain("pr-review-finding-uncited:");
      const saved = decodeSavedRunRecord(
        (await new FileRunStore(join(f.root, "state")).get(record!.id)) as never,
        record!.id,
      );
      expect(saved.prReviewSourceCitations?.spanAccesses).toEqual(
        record?.prReviewSourceCitations?.spanAccesses,
      );
    },
    testTimeoutMs(90_000),
  );

  it(
    "does not apply one citation to two findings with the same summary",
    async () => {
      const f = await githubPrReviewFixture();
      roots.push(f.root);
      const harness = new ReviewHarness(
        "docs/after.md",
        true,
        undefined,
        false,
        false,
        "review-documentation",
        true,
      );
      const record = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--pr",
          "https://github.com/target/docs/pull/884",
        ]),
        { ...runtimeConfig(join(f.root, "state")), projectRoot: f.work },
        {
          silent: true,
          executionHarness: harness,
          skillResolver,
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(harness.cited.length).toBeGreaterThan(0);
      const rows = record?.prReviewSourceCitations?.findings.filter(
        (row) => row.stepId === "review-documentation",
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows?.map((row) => row.findingId)).size).toBe(2);
      expect(rows?.map((row) => ({ status: row.status, citations: row.citations }))).toEqual([
        { status: "uncited", citations: [] },
        { status: "uncited", citations: [] },
      ]);
      const saved = decodeSavedRunRecord(
        (await new FileRunStore(join(f.root, "state")).get(record!.id)) as never,
        record!.id,
      );
      expect(
        saved.prReviewSourceCitations?.findings.filter(
          (row) => row.stepId === "review-documentation",
        ),
      ).toEqual(rows);
    },
    testTimeoutMs(90_000),
  );

  it.each([
    ["read", false],
    ["unread", true],
  ] as const)(
    "retains zero-finding %s source access accurately on cold readback",
    async (_case, skipSourceRead) => {
      const f = await githubPrReviewFixture();
      roots.push(f.root);
      const harness = new ReviewHarness("docs/after.md", false, undefined, true, skipSourceRead);
      const record = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--pr",
          "https://github.com/target/docs/pull/884",
        ]),
        { ...runtimeConfig(join(f.root, "state")), projectRoot: f.work },
        {
          silent: true,
          executionHarness: harness,
          skillResolver,
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(record?.prReviewSourceCitations?.findings).toEqual([]);
      expect(harness.readTexts.length > 0).toBe(!skipSourceRead);
      expect((record?.prReviewSourceCitations?.spanAccesses.length ?? 0) > 0).toBe(!skipSourceRead);
      const saved = decodeSavedRunRecord(
        (await new FileRunStore(join(f.root, "state")).get(record!.id)) as never,
        record!.id,
      );
      expect(saved.prReviewSourceCitations?.spanAccesses).toEqual(
        record?.prReviewSourceCitations?.spanAccesses,
      );
    },
    testTimeoutMs(90_000),
  );

  it(
    "keeps the paired GitLab review on its existing decoded change path",
    async () => {
      const f = await githubPrReviewFixture(false, false, false, false, 0, "mixed-code");
      roots.push(f.root);
      const recorded = JSON.parse(
        await readFile(
          join(import.meta.dirname, "fixtures", "change-source-gitlab", "merge-request-get.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const mr = {
        ...recorded,
        state: "opened",
        merged_at: null,
        merge_commit_sha: null,
        sha: f.H,
        diff_refs: { base_sha: f.M, start_sha: f.M, head_sha: f.H },
      };
      const calls: string[][] = [];
      const commands = {
        async run(_command: string, args: readonly string[]) {
          calls.push([...args]);
          const endpoint = String(args.at(-1));
          return {
            stdout: JSON.stringify(
              endpoint.includes("/merge_requests/")
                ? mr
                : { id: 4242, path_with_namespace: "team/docs-project" },
            ),
            stderr: "",
            exitCode: 0,
          };
        },
      };
      const harness = new ReviewHarness();
      const record = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--repo",
          f.work,
          "--revision",
          f.H,
          "--change",
          "https://gitlab.example.test/team/docs-project/-/merge_requests/813",
        ]),
        runtimeConfig(join(f.root, "gitlab-state")),
        {
          silent: true,
          executionHarness: harness,
          skillResolver,
          changeRequestCommands: commands,
          changeRequestEnvironment: {},
        },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(record?.prReviewBasis).toBeUndefined();
      expect(record?.repository.revision).toBe(f.H);
      expect(harness.steps).toContain("review-documentation");
      expect(calls.length).toBeGreaterThan(0);
      expect(harness.listedPaths).toEqual(
        expect.arrayContaining([
          changeSourceRepositoryPath(f.H, "diff"),
          changeSourceRepositoryPath(f.H, "manifest"),
        ]),
      );
      const github = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--pr",
          "https://github.com/target/docs/pull/884",
        ]),
        { ...runtimeConfig(join(f.root, "github-state")), projectRoot: f.work },
        {
          silent: true,
          executionHarness: new ReviewHarness(),
          skillResolver,
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(github?.status, github?.error).toBe("succeeded");
      expect(
        projectReviewFindingsFromRun(record!).findings.map((finding) => finding.summary),
      ).toEqual(projectReviewFindingsFromRun(github!).findings.map((finding) => finding.summary));
      expect(record?.steps.map((step) => step.id)).toEqual(github?.steps.map((step) => step.id));
      expect(record?.reviewScope).toBeUndefined();
      expect(github?.reviewScope?.targetPaths).toContain("docs/unchanged.md");
      const checkRows = (run: NonNullable<typeof record>) =>
        JSON.parse(run.steps.find((step) => step.id === "lint-documentation")!.summary!) as {
          checks: Array<{ command?: string; status: string; cause?: string }>;
        };
      expect(
        checkRows(record!).checks.some((check) => check.cause === "pr-review-not-admitted"),
      ).toBe(false);
      expect(checkRows(github!).checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "npm run lint:docs",
            status: "unavailable",
            cause: "pr-review-not-admitted",
          }),
        ]),
      );
      const report = await readFile(
        join(f.root, "gitlab-state", "reports", record!.id, "quality-report.md"),
        "utf8",
      );
      expect(report).toContain("# Documentation quality evaluation report");
      expect(report).not.toContain("pr-review-check-not-run:");
    },
    testTimeoutMs(90_000),
  );

  it(
    "uses live private H and retains an honest partial run with no repository script execution",
    async () => {
      const f = await githubPrReviewFixture();
      roots.push(f.root);
      const harness = new ReviewHarness();
      const request = parseRunArguments([
        "review-documentation",
        "--pr",
        "https://github.com/target/docs/pull/884",
      ]);
      const printed: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((value) => {
        printed.push(String(value));
      });
      const record = await executeRunRequest(
        request,
        {
          ...runtimeConfig(join(f.root, "state")),
          projectRoot: f.work,
        },
        {
          json: true,
          executionHarness: harness,
          skillResolver,
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(record?.repository.revision).toBe(f.H);
      expect(record?.prReviewBasis).toMatchObject({ B: f.B, H: f.H, M: f.M });
      expect(record?.status, record?.error).toBe("succeeded");
      expect(record?.reviewScope?.targetPaths).toContain("docs/after.md");
      expect(
        harness.readTexts.length,
        JSON.stringify({
          status: record?.status,
          error: record?.error,
          failure: record?.failure,
          steps: record?.steps?.map((step) => ({
            id: step.id,
            status: step.status,
            summary: step.summary?.slice(0, 200),
          })),
          calls: harness.steps,
        }),
      ).toBeGreaterThan(0);
      expect(harness.listedPaths).toEqual(
        expect.arrayContaining([expect.stringContaining("docs/after.md")]),
      );
      expect(harness.cited.length).toBeGreaterThan(0);
      expect(record?.prReviewSourceCitations?.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "review-documentation",
            status: "cited",
          }),
        ]),
      );
      expect(harness.steps).toContain("review-documentation");
      const saved = decodeSavedRunRecord(
        (await new FileRunStore(join(f.root, "state")).get(record!.id)) as never,
        record!.id,
      );
      expect(saved).toMatchObject({
        id: record!.id,
        prReviewBasis: { H: f.H },
      });
      expect(() =>
        decodeSavedRunRecord(
          {
            ...saved!,
            prReviewBasis: { ...saved!.prReviewBasis!, H: "1".repeat(40) },
          } as never,
          record!.id,
        ),
      ).toThrow(/saved PR review basis is malformed or differs from its digest/u);
      expect(() =>
        decodeSavedRunRecord(
          {
            ...saved!,
            repository: { ...saved!.repository, revision: "1".repeat(40) },
          } as never,
          record!.id,
        ),
      ).toThrow(/differs from the reviewed H revision/u);
      expect(() =>
        decodePrReviewSourceCitations(saved!.prReviewSourceCitations, saved!),
      ).not.toThrow();
      const citedReviewRow = saved!.prReviewSourceCitations!.findings.find(
        (row) => row.stepId === "review-documentation" && row.status === "cited",
      )!;
      const duplicatedReviewStep = {
        ...saved!.steps.find((step) => step.id === "review-documentation")!,
        summary: reviewSummary("docs/after.md", true),
      };
      const duplicatedRun = {
        ...saved!,
        steps: saved!.steps.map((step) =>
          step.id === "review-documentation" ? duplicatedReviewStep : step,
        ),
      };
      const duplicateFindings = projectReviewFindingsFromRun({
        ...duplicatedRun,
        steps: [duplicatedReviewStep],
      }).findings;
      expect(duplicateFindings).toHaveLength(2);
      const { digestSha256: _digest, ...originalCitationBody } = saved!.prReviewSourceCitations!;
      const forgedCitationBody = {
        ...originalCitationBody,
        findings: [
          ...originalCitationBody.findings.filter((row) => row.stepId !== "review-documentation"),
          ...duplicateFindings.map((finding) => ({
            ...citedReviewRow,
            findingId: finding.id,
          })),
        ],
      };
      expect(() =>
        decodePrReviewSourceCitations(
          { ...forgedCitationBody, digestSha256: canonicalDigest(forgedCitationBody) },
          duplicatedRun,
        ),
      ).toThrow(/ambiguous/u);
      expect(() =>
        decodePrReviewSourceCitations(saved!.prReviewSourceCitations, {
          ...saved!,
          id: "different-run",
        }),
      ).toThrow(/retained run/u);
      expect(() =>
        decodePrReviewSourceCitations(saved!.prReviewSourceCitations, {
          ...saved!,
          steps: saved!.steps.map((step) =>
            step.id === "review-documentation"
              ? {
                  ...step,
                  summary: step.summary?.replace("Proposal after", "Substituted finding"),
                }
              : step,
          ),
        }),
      ).toThrow(/canonical finding/u);
      expect(JSON.stringify(saved)).not.toContain("Mutable caller checkout");
      const checks = JSON.parse(
        record!.steps.find((step) => step.id === "lint-documentation")!.summary!,
      ) as {
        checks: Array<{ command?: string; status: string; cause?: string }>;
      };
      expect(checks.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "npm run lint:docs",
            status: "unavailable",
            cause: "pr-review-not-admitted",
          }),
        ]),
      );
      const report = await readFile(
        join(f.root, "state", "reports", record!.id, "quality-report.md"),
        "utf8",
      );
      expect(report).toContain("pr-review-check-not-run:npm run lint:docs");
      expect(report).toContain("Admitted source spans:");
      expect(printed).toHaveLength(1);
      expect(printed[0]).toContain("pr-review-check-not-run:npm run lint:docs");
      expect(printed[0]).toContain("Admitted source spans:");
      log.mockRestore();
    },
    testTimeoutMs(90_000),
  );

  it.each([
    ["forked MDX", "forked-mdx", "docs/after.mdx"],
    ["mixed Markdown/code", "mixed-code", "docs/after.md"],
  ] as const)(
    "executes installed read-only review list/read/cite for %s through Pi OFFLINE transport",
    async (_label, layout, reviewPath) => {
      const f = await githubPrReviewFixture(false, false, false, false, 0, layout);
      roots.push(f.root);
      const pi = await createAuditHarness();
      const harness = new PiReviewHarness(pi, reviewPath);
      const model = new ScriptedPiReview(reviewPath);
      vi.stubGlobal("fetch", model.fetch);
      const record = await executeRunRequest(
        parseRunArguments([
          "review-documentation",
          "--pr",
          "https://github.com/target/docs/pull/884",
        ]),
        { ...runtimeConfig(join(f.root, "state")), projectRoot: f.work },
        {
          silent: true,
          executionHarness: harness,
          skillResolver: {
            resolveSkill: (input) =>
              input.step.id === "review-documentation"
                ? pi.inspectSkill(input)
                : skillResolver.resolveSkill(input),
          },
          githubPrFixturePorts: {
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            scratchRoot: f.scratch,
          },
        },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(record?.reviewScope?.targetPaths).toContain(reviewPath);
      if (layout === "mixed-code") {
        expect(record?.reviewScope?.targetPaths).toContain("docs/unchanged.md");
      }
      expect(model.reads.length).toBeGreaterThan(0);
      expect(model.citations.length).toBeGreaterThan(0);
      expect(record?.prReviewSourceCitations?.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "review-documentation",
            status: "cited",
          }),
        ]),
      );
    },
    testTimeoutMs(90_000),
  );
});
