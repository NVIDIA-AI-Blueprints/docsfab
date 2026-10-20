// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Real hosted CREATE assembly with controlled model answers only. No canned run records or check results. */
import { execFile } from "node:child_process";
import { authoringFixtureCandidateForInput } from "../support/authoring-quality-fixture.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../../src/execution/contracts.js";
import { CatalogSkillCrateResolver } from "../../src/skills/catalog-crate-resolver.js";
import { sealDocumentationPlanBinding } from "../../src/workflow-execution/plan-binding.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import { inspectHostedWorkflowCatalog } from "../../src/host-invoker/workflow-catalog.js";
import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeWriteAuthority,
  type HostRuntimeRequestV1,
} from "../../src/host-invoker/contracts.js";
import { canonicalizeJsonEvidence } from "../../src/json-evidence.js";
import { verificationFixture, sourceObligationProposalFixture } from "./verification.js";
import {
  bindHostOwnedTechnicalCorrectionProposalV3,
  canonicalSourceObligationProposal,
} from "../../src/workflow-execution/source-obligation.js";

const exec = promisify(execFile);
export const HOSTED_CREATE_TARGET = "docs/new-guide.md";
export const HOSTED_CREATE_PAGE = "# API guide\n\nThe API exposes a safe default.\n";
const target = HOSTED_CREATE_TARGET,
  page = HOSTED_CREATE_PAGE;

export async function createHostedCreateFixture(
  options: {
    sourceFiles?: Readonly<Record<string, string>>;
    /**
     * Write-grant targets for existing paths, added to the path ceiling. Each
     * is bound to its own committed blob unless `preimageObjectId` names
     * another, as a grant issued for older content would.
     */
    grantTargets?: readonly {
      readonly path: string;
      readonly operations: readonly ("modify" | "delete")[];
      readonly preimageObjectId?: string;
    }[];
    /** Another hosted write workflow over the same repository; CREATE by default. */
    workflow?: "create-documentation" | "restructure-documentation";
    /** The grant's changed-path bound; one, the CREATE page, by default. */
    maximumChangedPaths?: number;
    /** Seal the catalog an opted-in stage-specific preservation run declares; off by default. */
    preservationSourceRead?: boolean;
  } = {},
) {
  const workflow = options.workflow ?? "create-documentation";
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-hosted-create-")));
  const source = join(root, "source"),
    outer = join(root, "outer"),
    state = join(root, "state");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(source, "README.md"), "# Fixture API\n\nUse the safe default.\n");
  await writeFile(join(source, "src/api.ts"), "export const defaultMode = 'safe';\n");
  await writeFile(
    join(source, "Makefile"),
    "docs-check:\n\t@test -s docs/new-guide.md\n\t@grep -q 'safe default' docs/new-guide.md\n",
  );
  for (const [path, content] of Object.entries(options.sourceFiles ?? {})) {
    if (isAbsolute(path) || path.split(/[\\/]/u).includes(".."))
      throw new Error("Hosted CREATE fixture source files must remain inside its repository.");
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content);
  }
  const git = (args: string[], cwd = source) =>
    exec("git", args, {
      cwd,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  const revision = (await git(["rev-parse", "HEAD"])).stdout.trim(),
    tree = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const targets = await Promise.all(
    (options.grantTargets ?? []).map(async (grant) => ({
      path: grant.path,
      operations: [...grant.operations],
      preimageObjectId:
        grant.preimageObjectId ?? (await git(["rev-parse", `HEAD:${grant.path}`])).stdout.trim(),
      fileMode: "100644" as const,
    })),
  );
  await git(["clone", "--quiet", "--no-local", "--no-hardlinks", source, outer]);
  const catalog = inspectHostedWorkflowCatalog(workflow, {
    preservationSourceRead: options.preservationSourceRead === true,
  });
  const composition = sealHostRuntimeComposition({
    compositionId: "hosted-create-fixture",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools: catalog.declaredTools,
  });
  const capsuleBody = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [
      {
        evidenceId: "api",
        content:
          "The API source exports defaultMode = 'safe'. Create docs/new-guide.md from src/api.ts.",
      },
    ],
  };
  const capsule = { ...capsuleBody, sha256: digest(capsuleBody) };
  const binding = {
    deploymentId: "test-deployment",
    projectId: "test-project",
    deploymentEpoch: "test-epoch",
    requestKey: "create-request",
    runId: "create-run",
    fence: 1,
    workflow,
  };
  const toolPolicySha256 = digest({
    workflow: catalog.workflow,
    stepIds: catalog.stepIds,
    declaredTools: catalog.declaredTools,
  });
  const authority = sealHostRuntimeWriteAuthority({
    schemaVersion: 2,
    kind: "docsfab-host-runtime-write-authority",
    ...binding,
    sourceRevision: revision,
    sourceTreeObjectId: tree,
    pathCeiling: [target, ...targets.map((entry) => entry.path).filter((path) => path !== target)],
    targets,
    writeStepIds: getWorkflow(catalog.workflow)
      .steps.filter((step) => step.mode === "write")
      .map((step) => step.id),
    capsuleSha256: capsule.sha256,
    compositionSha256: composition.compositionSha256,
    toolPolicySha256,
    expiresAt: capsule.expiresAt,
    limits: {
      maximumChangedPaths: options.maximumChangedPaths ?? 1,
      maximumPatchBytes: 1024 * 1024,
    },
  });
  const content = "{}";
  const request = parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    ...binding,
    origin: { principalId: "fixture-member", requestId: "fixture-message" },
    revision,
    sourceTreeObjectId: tree,
    packet: {
      packetFingerprintSha256: "b".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        content,
        sha256: digest({}),
        sourcePathSha256: "c".repeat(64),
        gitObjectId: "d".repeat(40),
      },
      canon: null,
      reviewEvent: null,
    },
    stepIds: catalog.stepIds,
    toolPolicySha256,
    workspacePath: outer,
    stateDirectory: state,
    capsule,
    composition,
    allowWrite: true,
    writeAuthority: authority,
  });
  return {
    root,
    source,
    outer,
    state,
    request,
    git,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function controlledHostedCreateHarness(
  request: HostRuntimeRequestV1,
  options: {
    targetPath?: string;
    planPath?: string;
    sourceRevision?: string;
    mutateSource?: boolean;
    forgeCorrection?: boolean;
    failCheck?: boolean;
    technicalHumanReview?: boolean;
  } = {},
) {
  const target = options.targetPath ?? HOSTED_CREATE_TARGET;
  const resolver = new CatalogSkillCrateResolver(
    new URL("../../skill-crate", import.meta.url).pathname,
  );
  const calls: HarnessStepInput[] = [];
  const harness: AgentHarness = {
    inspectSkill: (input) => resolver.resolveSkill(input),
    async runStep(input) {
      calls.push(input);
      const common = {
        model: {
          provider: "offline-fixture",
          model: request.composition.compositionSha256.slice(0, 16),
        },
        skill: await resolver.resolveSkill(input),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      };
      if (input.step.id === "plan-documentation")
        return {
          ...common,
          summary: "Create the requested source-bound API guide.",
          planBinding: sealDocumentationPlanBinding(
            {
              mode: "create",
              pages: [{ path: options.planPath ?? target, disposition: "create" }],
              sourceBindings: [
                {
                  pagePath: options.planPath ?? target,
                  sources: [`src/api.ts:1@${options.sourceRevision ?? request.revision}`],
                },
              ],
            },
            { expectedMode: "create" },
          ),
        };
      if (input.step.id === "write-documentation") {
        await mkdir(dirname(join(input.repositoryPath, target)), { recursive: true });
        await writeFile(
          join(input.repositoryPath, target),
          options.failCheck ? "# Guide with missing assertion\n" : page,
        );
        if (options.mutateSource)
          await writeFile(
            join(input.repositoryPath, "src/api.ts"),
            "export const defaultMode = 'unsafe';\n",
          );
      }
      const answer: Partial<HarnessStepResult> =
        input.step.id === "derive-source-obligations"
          ? (() => {
              const sourceObligationProposal = sourceObligationProposalFixture("src/api.ts:1");
              return {
                summary: canonicalSourceObligationProposal(sourceObligationProposal),
                sourceObligationProposal,
              };
            })()
          : await verificationFixture(input);
      if (options.technicalHumanReview && answer.technicalCorrectionEvidence?.schemaVersion === 3) {
        if (
          input.sourceObligationLedger?.schemaVersion !== 2 ||
          !input.originalSourceAuthorityAdmission ||
          !input.runId
        )
          throw new Error("The controlled technical finding requires admitted original source.");
        const proposal = structuredClone(answer.technicalCorrectionEvidence.proposal);
        const fact = proposal.factInventory.dimensions.flatMap((row) => row.facts)[0];
        if (!fact) throw new Error("The controlled technical finding requires a source fact.");
        fact.documentationDisposition = "unverified-policy";
        fact.issueIds = ["TECH-001"];
        proposal.verdict = "human-review";
        proposal.issueJudgments = [
          {
            id: "TECH-001",
            severity: "minor",
            category: "technical_accuracy",
            location: `${target}:1`,
            factIds: [fact.id],
          },
        ];
        const bound = await bindHostOwnedTechnicalCorrectionProposalV3(
          proposal,
          input.sourceObligationLedger,
          input.originalSourceAuthorityAdmission,
          input.runId,
          [target],
        );
        Object.assign(answer, {
          verificationResult: bound.verificationResult,
          technicalCorrectionEvidence: bound.evidence,
          summary: canonicalizeJsonEvidence(
            bound.verificationResult as unknown as import("../../src/json-evidence.js").JsonEvidenceValue,
          ).trimEnd(),
        });
      }
      if (options.forgeCorrection && answer.technicalCorrectionEvidence?.schemaVersion === 3)
        answer.technicalCorrectionEvidence = {
          ...answer.technicalCorrectionEvidence,
          originalSourceAuthoritySha256: "f".repeat(64),
        };
      if (input.step.id === "evaluate-document-quality" && input.qualityProfileSelection) {
        const qualityArtifactCandidate = await authoringFixtureCandidateForInput(input);
        return {
          ...common,
          summary: qualityArtifactCandidate.reportMarkdown,
          qualityArtifactCandidate,
        };
      }
      return {
        ...common,
        summary:
          input.step.skill === "review-documentation"
            ? canonicalizeJsonEvidence({ verdict: "pass", issues: [] }).trimEnd()
            : "The controlled fixture supplies no audience study or quality approval.",
        ...answer,
      };
    },
  };
  return { harness, calls };
}
