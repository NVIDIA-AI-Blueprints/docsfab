// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/index.js";
import { limit } from "../src/config/limits.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { editorialAssessmentEvidenceRefsV1 } from "../src/harness/pi.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeReaderEvidencePolicy,
  sealHostRuntimeReaderTask,
  sealHostRuntimeWriteAuthority,
} from "../src/host-invoker/contracts.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { createReaderTaskContextSupplier } from "../src/execution/task-context.js";
import { bindDocumentationPlanProposal } from "../src/workflow-execution/plan-binding.js";
import { loadEditorialEvidenceDecodeOptionsFromStoreV1 } from "../src/workflow-execution/editorial-evidence-host.js";
import { workflowBranchCoverageDecodeOptionsV1 } from "../src/records/composition-execution.js";
import { decodeWorkflowBranchCoverageV1 } from "../src/workflow-contracts/branch-coverage.js";
import { decodeRunRecordEditorialEvidence } from "../src/workflow-contracts/outcome.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { verificationFixture, verificationResultFixture } from "./helpers/verification.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();

describe("hosted schema-v2 editorial evidence", () => {
  it.each(["update", "no-change"] as const)(
    "executes an installed editorial branch with retained evidence: %s",
    async (candidate) => {
      const fixture = await repositoryFixture(candidate);
      const request = requestFor(fixture, candidate);
      const harness = new EditorialHarness(candidate, {
        uri: "src/orbit.ts",
        sha256: createHash("sha256")
          .update(await readFile(join(fixture.repository, "src/orbit.ts")))
          .digest("hex"),
      });
      const result = await runHostedWorkflow({
        request,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      });
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.record.workflowBranchCoverage?.selection?.branchId).toBe(
        candidate === "update" ? "author" : "assess-no-change",
      );
      expect(harness.inputs.every((input) => input.readerTaskContext !== undefined)).toBe(true);
      const plannerPrompt =
        harness.inputs.find((input) => input.step.id === "plan-documentation")?.readerTaskContext
          ?.prompt ?? "";
      expect(plannerPrompt).toContain("src/orbit.ts");
      expect(plannerPrompt).toContain(harness.impactSource.sha256);
      expect(plannerPrompt).toContain("requires the exact evidence");
      expect(harness.inputs.every((input) => (input.editorialEvidenceRefs?.length ?? 0) >= 1)).toBe(
        true,
      );
      expect(
        new Set(
          result.record.artifacts
            ?.filter((use) => use.reference.kind === "editorial-decision")
            .map((use) => use.reference.digest),
        ),
      ).toHaveLength(2);
      expect(result.patchEvidence?.authoritySha256).toBe(request.writeAuthority?.authoritySha256);
      if (candidate === "update") {
        expect(result.patch).toContain("The public option is now --new.");
      } else {
        expect(result.patch).toBeNull();
        expect(result.patchEvidence?.changes).toHaveLength(0);
        expect(harness.inputs.some((input) => input.step.mode === "write")).toBe(false);
      }

      const verified = await verifyQualityPackContext({
        skillCrateDirectory: join(runtimeRoot, "skill-crate"),
        qualityDirectory: join(runtimeRoot, "quality"),
        qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      });
      const supplier = await createReaderTaskContextSupplier(verified);
      const replay = await loadEditorialEvidenceDecodeOptionsFromStoreV1({
        store: new DurableArtifactStore(join(fixture.state, "artifacts")),
        record: result.record,
        baselineSha256: supplier.baseline.sha256,
        policy: supplier.policy,
      });
      expect(
        decodeRunRecordEditorialEvidence(result.record, {
          decodeEditorialDecision: replay.decodeEditorialDecision,
          decodeWorkflowBranchCoverage: (value) =>
            decodeWorkflowBranchCoverageV1(
              value,
              workflowBranchCoverageDecodeOptionsV1({
                workflow: getWorkflow("update-documentation"),
                record: result.record,
              }),
            ),
        }).state,
      ).toBe("current");
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it("refuses missing or substituted reader evidence before model execution", async () => {
    const fixture = await repositoryFixture("update");
    const request = requestFor(fixture, "update");
    const raw = structuredClone(request) as unknown as Record<string, unknown>;
    const packet = structuredClone(request.packet) as unknown as Record<string, unknown>;
    delete packet.readerTask;
    raw.packet = packet;
    delete raw.readerEvidencePolicy;
    const missing = parseHostRuntimeRequest(raw);
    const harness = new EditorialHarness("update", {
      uri: "src/orbit.ts",
      sha256: createHash("sha256")
        .update(await readFile(join(fixture.repository, "src/orbit.ts")))
        .digest("hex"),
    });
    await expect(
      runHostedWorkflow({
        request: missing,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow("requires bound reader-task evidence");
    expect(harness.inputs).toHaveLength(0);

    const changedTask = structuredClone(request.packet.readerTask!);
    (changedTask.sources as Array<{ role: string; path: string }>)[0]!.path = "src/substitute.ts";
    expect(() =>
      parseHostRuntimeRequest({
        ...structuredClone(request),
        packet: { ...structuredClone(request.packet), readerTask: changedTask },
      }),
    ).toThrow("digest-mismatch");

    const { readerTaskSha256: _readerTaskSha256, ...readerTaskBody } = request.packet.readerTask!;
    const wrongHead = sealHostRuntimeReaderTask({
      ...readerTaskBody,
      comparison: {
        ...request.packet.readerTask!.comparison,
        headRevision: fixture.base,
      },
    });
    expect(() =>
      parseHostRuntimeRequest({
        ...structuredClone(request),
        packet: { ...structuredClone(request.packet), readerTask: wrongHead },
      }),
    ).toThrow("reader-task-binding-mismatch");
  });

  it("does not reuse the admitted snapshot after an ignored documentation mutation", async () => {
    const fixture = await repositoryFixture("no-change");
    await writeFile(join(fixture.repository, ".gitignore"), "docs/generated/\n");
    await commitFixture(fixture.repository, "ignore generated docs");
    const rebound = await rebindFixtureHead(fixture);
    const request = requestFor(rebound, "no-change");
    await mkdir(join(rebound.repository, "docs/generated"), { recursive: true });
    await writeFile(join(rebound.repository, "docs/generated/hidden.md"), "# Hidden\n");
    const harness = new EditorialHarness("no-change", {
      uri: "src/orbit.ts",
      sha256: createHash("sha256")
        .update(await readFile(join(rebound.repository, "src/orbit.ts")))
        .digest("hex"),
    });
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit: () => undefined,
      executionHarness: harness,
    });
    expect(result.record.status).not.toBe("succeeded");
    expect(result.record.steps[0]?.searchEvidence?.workspaceSnapshotSha256).not.toBe(
      result.record.workflowBranchCoverage?.workspaceSnapshotSha256,
    );
  });

  it("refuses a complete derived admission outside the installed policy", async () => {
    const fixture = await repositoryFixture("update");
    const request = requestFor(fixture, "update");
    const cases = [
      {
        sourceRoles: ["changed-source", "current-documentation", "request"] as const,
        pathCeiling: ["docs/"],
        maximumSourceNominations: 8,
      },
      {
        sourceRoles: ["current-documentation", "request"] as const,
        pathCeiling: ["docs/", "src/"],
        maximumSourceNominations: 8,
      },
      {
        sourceRoles: ["changed-source", "current-documentation", "request"] as const,
        pathCeiling: ["docs/", "src/"],
        maximumSourceNominations: 2,
      },
    ];
    for (const policy of cases) {
      const constrained = parseHostRuntimeRequest({
        ...structuredClone(request),
        readerEvidencePolicy: sealHostRuntimeReaderEvidencePolicy({
          workflow: "update-documentation",
          ...policy,
        }),
      });
      const harness = new EditorialHarness("update", {
        uri: "src/orbit.ts",
        sha256: "a".repeat(64),
      });
      await expect(
        runHostedWorkflow({
          request: constrained,
          credential: null,
          emit: () => undefined,
          executionHarness: harness,
        }),
      ).rejects.toThrow("exceeds the installed evidence policy");
      expect(harness.inputs).toHaveLength(0);
    }
  });

  it("refuses an unretained deleted C..H source before model execution", async () => {
    const fixture = await repositoryFixture("update");
    const base = fixture.head;
    await rm(join(fixture.repository, "src/orbit.ts"));
    const rebound = {
      ...fixture,
      base,
      head: await commitFixture(fixture.repository, "delete source"),
      tree: await git(fixture.repository, ["rev-parse", "HEAD^{tree}"]),
    };
    const request = requestFor(rebound, "update");
    const { readerTaskSha256: _digest, ...task } = request.packet.readerTask!;
    const readerTask = sealHostRuntimeReaderTask({
      ...task,
      sources: [{ role: "current-documentation", path: "docs/cli.md" }],
    });
    const parsed = parseHostRuntimeRequest({
      ...structuredClone(request),
      packet: { ...structuredClone(request.packet), readerTask },
    });
    const harness = new EditorialHarness("update", { uri: "src/orbit.ts", sha256: "a".repeat(64) });
    await expect(
      runHostedWorkflow({
        request: parsed,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow("evidence-unavailable");
    expect(harness.inputs).toHaveLength(0);
  });

  it("screens reader source paths at seal time: a configured credential refuses, a shape is recorded (#1807)", async () => {
    const fixture = await repositoryFixture("update");
    const request = requestFor(fixture, "update");
    const { readerTaskSha256: _digest, ...task } = request.packet.readerTask!;
    // DocsFab's own configured credential, which looks like no credential.
    const planted = plantConfiguredCredential();
    try {
      expect(() =>
        sealHostRuntimeReaderTask({
          ...task,
          sources: [{ role: "changed-source", path: `docs/${planted}.md` }],
        }),
      ).toThrow("credential-material");
    } finally {
      clearPlantedCredential();
    }
    const shapedPath = ["docs/glpat", `${"A".repeat(24)}.md`].join("-");
    const { result, findings } = collectCredentialFindings(() =>
      sealHostRuntimeReaderTask({
        ...task,
        sources: [{ role: "changed-source", path: shapedPath }],
      }),
    );
    expect(result.sources.map((source) => source.path)).toEqual([shapedPath]);
    expect(findings).toEqual([
      {
        code: "credential-like-content",
        location: "hosted-reader-task:sources",
        rule: "credential.gitlab-token",
      },
    ]);
  });

  it("does not exempt a tracked changed path that spoofs the virtual request URI", async () => {
    const fixture = await repositoryFixture("update");
    const base = fixture.head;
    await writeFile(join(fixture.repository, "request:instruction"), "tracked source\n");
    const rebound = {
      ...fixture,
      base,
      head: await commitFixture(fixture.repository, "add spoof path"),
      tree: await git(fixture.repository, ["rev-parse", "HEAD^{tree}"]),
    };
    const request = requestFor(rebound, "update");
    const harness = new EditorialHarness("update", { uri: "src/orbit.ts", sha256: "a".repeat(64) });
    await expect(
      runHostedWorkflow({
        request,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow("exceeds the installed evidence policy");
    expect(harness.inputs).toHaveLength(0);

    const sameRevision = requestFor({ ...rebound, base: rebound.head }, "update");
    const { readerTaskSha256: _digest, ...task } = sameRevision.packet.readerTask!;
    const spoofedTask = sealHostRuntimeReaderTask({
      ...task,
      sources: [
        { role: "request", path: "request:instruction" },
        { role: "current-documentation", path: "docs/cli.md" },
      ],
    });
    const explicitSpoof = parseHostRuntimeRequest({
      ...structuredClone(sameRevision),
      packet: { ...structuredClone(sameRevision.packet), readerTask: spoofedTask },
    });
    const secondHarness = new EditorialHarness("update", {
      uri: "src/orbit.ts",
      sha256: "a".repeat(64),
    });
    await expect(
      runHostedWorkflow({
        request: explicitSpoof,
        credential: null,
        emit: () => undefined,
        executionHarness: secondHarness,
      }),
    ).rejects.toThrow("exceeds the installed evidence policy");
    expect(secondHarness.inputs).toHaveLength(0);
  });
});

class EditorialHarness implements AgentHarness {
  readonly inputs: HarnessStepInput[] = [];
  constructor(
    private readonly candidate: "update" | "no-change",
    readonly impactSource: { uri: string; sha256: string },
  ) {}
  async inspectSkill(input: HarnessStepInput) {
    return { id: input.step.skill, contentSha256: digest({ skill: input.step.skill }) };
  }
  async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.inputs.push(input);
    const reference =
      input.step.id === "plan-documentation"
        ? input.editorialEvidenceRefs?.[0]
        : editorialAssessmentEvidenceRefsV1(input)[0];
    if (!reference) throw new Error("missing hosted editorial evidence");
    if (input.step.id === "plan-documentation") {
      const update = this.candidate === "update";
      return {
        summary: update ? "The public option requires an update." : "The docs remain accurate.",
        planBinding: bindDocumentationPlanProposal(
          {
            mode: "update",
            pages: [{ path: "docs/cli.md", disposition: update ? "update" : "retain" }],
            sourceBindings: update ? [{ pagePath: "docs/cli.md", sources: ["src/orbit.ts"] }] : [],
          },
          { expectedMode: "update" },
        ),
        editorialDecisionProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-decision-proposal",
          candidate: this.candidate,
          rationale: update
            ? "The current public option differs from the guide."
            : "The guide remains accurate.",
          evidenceRefs: [reference],
          limitations: [],
          impactBasis: {
            kind: update ? "public-behavior-change" : "none",
            rationale: update ? "The public source changed." : "The public behavior is unchanged.",
            evidence_refs: [this.impactSource],
          },
        },
      };
    }
    if (input.step.id === "write-documentation") {
      await writeFile(
        join(input.repositoryPath, "docs/cli.md"),
        "# Orbit CLI\n\nThe public option is now --new.\n",
      );
      return { summary: "Updated the bounded page." };
    }
    if (input.step.id === "test-audience-understanding") {
      return {
        summary: "No audience fixture is installed.",
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "not-applicable",
          rationale: "No authorized audience fixture is installed.",
          evidenceRefs: [reference],
          limitations: ["audience-check-unavailable"],
          recommendation: null,
        },
      };
    }
    return {
      summary: `${input.step.id} accepted the retained evidence.`,
      ...(input.step.id === "derive-source-obligations" ? await verificationFixture(input) : {}),
      ...(input.step.id === "verify-technical-accuracy"
        ? { verificationResult: verificationResultFixture(["docs/cli.md"]) }
        : {}),
      editorialAssessmentProposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-assessment-proposal",
        assessment: "accepted",
        rationale: `${input.step.id} inspected the retained source and candidate evidence.`,
        evidenceRefs: [reference],
        limitations: [],
        recommendation: null,
      },
    };
  }
}

async function repositoryFixture(candidate: "update" | "no-change") {
  const repository = await roots.create("docsfab-hosted-editorial-");
  const state = await roots.create("docsfab-hosted-editorial-state-");
  const base = await initFixtureRepo(
    repository,
    {
      "docs/cli.md": "# Orbit CLI\n\nThe public option is --old.\n",
      "src/orbit.ts": "export const option = '--old';\n",
    },
    { branch: "main", message: "base" },
  );
  await writeFile(
    join(repository, "src/orbit.ts"),
    candidate === "update"
      ? "export const option = '--new';\n"
      : "// The implementation remains compatible.\nexport const option = '--old';\n",
  );
  const head = await commitFixture(repository, "head");
  const tree = await git(repository, ["rev-parse", "HEAD^{tree}"]);
  const guide = await git(repository, ["rev-parse", "HEAD:docs/cli.md"]);
  return { repository, state, base, head, tree, guide };
}

async function rebindFixtureHead(fixture: Awaited<ReturnType<typeof repositoryFixture>>) {
  const head = await git(fixture.repository, ["rev-parse", "HEAD"]);
  return {
    ...fixture,
    base: head,
    head,
    tree: await git(fixture.repository, ["rev-parse", "HEAD^{tree}"]),
    guide: await git(fixture.repository, ["rev-parse", "HEAD:docs/cli.md"]),
  };
}

function requestFor(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  candidate: "update" | "no-change",
) {
  const workflow = getWorkflow("update-documentation");
  const declaredTools = [
    ...new Set(workflow.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search))),
  ].sort();
  const composition = sealHostRuntimeComposition({
    compositionId: "offline-editorial-v1",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools,
  });
  const stepIds = workflow.steps.map((step) => step.id);
  const capsule = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [],
  };
  const sealedCapsule = { ...capsule, sha256: digest(capsule) };
  const toolPolicySha256 = digest({ workflow: "update-documentation", stepIds, declaredTools });
  const readerTask = sealHostRuntimeReaderTask({
    schemaVersion: 1,
    kind: "docsfab-reader-task-evidence",
    readerContextInput: {
      schema_version: 1,
      target_audience: "Orbit CLI users",
      reader_job: "Use the current public option.",
      change_scope: ["docs/cli.md"],
      source_priority: ["public contract", "current documentation"],
      required_content: ["the current public option"],
      excluded_content: [],
      unresolved_questions: [],
    },
    inputOrigin: "explicit",
    comparison: { kind: "base-head", baseRevision: fixture.base, headRevision: fixture.head },
    sources: [
      {
        role: candidate === "update" ? "changed-source" : "public-contract",
        path: "src/orbit.ts",
      },
      { role: "current-documentation", path: "docs/cli.md" },
    ],
  });
  const readerEvidencePolicy = sealHostRuntimeReaderEvidencePolicy({
    workflow: "update-documentation",
    sourceRoles: ["public-contract", "changed-source", "current-documentation", "request"],
    pathCeiling: ["docs/", "src/"],
    maximumSourceNominations: 8,
  });
  const authority = sealHostRuntimeWriteAuthority({
    schemaVersion: 2,
    kind: "docsfab-host-runtime-write-authority",
    deploymentId: "deployment-test",
    projectId: "project-test",
    deploymentEpoch: "epoch-test",
    requestKey: "request-test",
    runId: "run-hosted-editorial",
    fence: 1,
    workflow: "update-documentation",
    sourceRevision: fixture.head,
    sourceTreeObjectId: fixture.tree,
    pathCeiling: ["docs/"],
    targets: [
      {
        path: "docs/cli.md",
        operations: ["modify"],
        preimageObjectId: fixture.guide,
        fileMode: "100644",
      },
    ],
    writeStepIds: ["write-documentation"],
    capsuleSha256: sealedCapsule.sha256,
    compositionSha256: composition.compositionSha256,
    toolPolicySha256,
    expiresAt: sealedCapsule.expiresAt,
    limits: { maximumChangedPaths: 4, maximumPatchBytes: 64 * 1024 },
  });
  const content = '{"schemaVersion":1,"kind":"fixture-input"}\n';
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "deployment-test",
    projectId: "project-test",
    deploymentEpoch: "epoch-test",
    requestKey: "request-test",
    origin: { principalId: "principal-test", requestId: "origin-test" },
    runId: "run-hosted-editorial",
    fence: 1,
    workflow: "update-documentation",
    revision: fixture.head,
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
      readerTask,
    },
    stepIds,
    toolPolicySha256,
    workspacePath: fixture.repository,
    stateDirectory: fixture.state,
    capsule: sealedCapsule,
    composition,
    readerEvidencePolicy,
    allowWrite: true,
    writeAuthority: authority,
  });
}
