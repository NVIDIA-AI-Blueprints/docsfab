// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { verificationFixture } from "./helpers/verification.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  access,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { bindFirstPassKnowledge } from "../src/cli/first-pass.js";
import {
  firstPassAssessmentBindingSha256,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../src/cli/first-pass-support.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { AgentHarness, HarnessStepInput, RunRequest } from "../src/execution/contracts.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import { parseEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import type {
  RepositoryEvidenceCollector,
  RepositoryEvidenceContext,
} from "../src/repository/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import {
  WorkflowRunner,
  type FirstPassDocumentationTargetControl,
} from "../src/workflow-execution/runner.js";
import { deriveDocumentationSourceApplicability } from "../src/repository/documentation-source-applicability.js";
import { validateSourceAwareStructuralDocumentation } from "../src/delivery/structural-documentation-validator.js";
import { DARWIN_DOCKER_DESKTOP_IMAGE } from "../src/delivery/worktree/docker-desktop-backend.js";
import { readyContextPreflight } from "./helpers.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { LocalAuthoringCandidateLifecycle } from "../src/workflow-execution/authoring-runtime.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import type { HostOperationExecutor } from "../src/execution/contracts.js";
import { limit } from "../src/config/limits.js";
import {
  CHECK_COMMAND_TIMEOUT_LIMIT,
  CHECK_ISOLATION_UNAVAILABLE,
  CHECK_OUTPUT_RETAINED_LIMIT,
  checkSandboxEnvironment,
  presentCheckedGitMetadata,
  runBoundedCheckCommand,
  type CheckCommandResult,
} from "../src/workflow-execution/check-sandbox.js";
import {
  hostSelectedCheckAuthority,
  observeCheckedSnapshot,
  WorkflowChecksHostOperation,
  type CheckCommandAuthority,
} from "../src/workflow-execution/workflow-checks.js";
import { DockerCheckPreparationError } from "../src/validation/host-containment.js";
import {
  mintHostJobEnvelope,
  requirePublishableWritePatch,
  submitAfterSucceededRun,
} from "../src/autonomy/managed-publish-host.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { buildRunResultV1 } from "../src/operator/run-result.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../src/workflow-contracts/outcome.js";
import {
  materializePilotHead,
  PILOT_REQUIRED_CHECK,
  PILOT_CLI,
  documentationUpdateRequest,
  RECORDED_PLANNER_STOP,
  recordingAuthority,
} from "./helpers/documentation-supervision-pilot.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

import {
  documentationPlanBindingDigest,
  documentationPlanConsumerSkill,
  documentationPlanModeForWorkflow,
  documentationPlanVerificationPaths,
  documentationPlanWritePaths,
  createDocumentationPlanBinding,
  sealDocumentationPlanBinding,
  validateDocumentationPlanBinding,
  bindDocumentationPlanProposal,
  admittedDocumentationPlanBindingSha256,
  createSourceAwareDocumentationPlanBinding,
  documentationPlanBindingV2Digest,
  isSourceAwareDocumentationPlanBinding,
  validateAdmittedDocumentationPlanBinding,
  validateSourceAwareDocumentationPlanBinding,
  DocumentationPlanBindingError,
  documentationPlanAddressedPaths,
  OmittedFirstPassTargetError,
  PlanWriteScopeError,
  type DocumentationPlanMode,
  type DocumentationPlanPageV1,
} from "../src/workflow-execution/plan-binding.js";
import {
  createSourceArtifactReference,
  createSourceBinding,
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  createSourceObservation,
  createSourceStepPolicy,
  digestSourceProducerScopes,
  extractSourceRepresentation,
  htmlSourceExtractorAdapter,
  openExternalInputAccessCapture,
  projectSourceRequestContext,
  recordExternalInputAccess,
  registerFakeExternalInput,
} from "../src/inputs/index.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { decodeTemplateAuditReport } from "../src/templates/audit.js";
import { prepareTemplateSet, type TemplateSetCapability } from "../src/templates/load.js";

function binding(mode: "create" | "update" | "restructure" = "create") {
  const pages =
    mode === "restructure"
      ? [
          { path: "docs/guide.md", disposition: "move" as const },
          { path: "docs/recovery.md", disposition: "split" as const },
        ]
      : [
          { path: "docs/index.md", disposition: mode },
          { path: "docs/setup.md", disposition: mode },
          { path: "docs/troubleshooting.md", disposition: mode },
          { path: "docs/reference.md", disposition: mode },
        ];
  const sourceBindings = pages.map((page) => ({
    pagePath: page.path,
    sources: [`src/${page.path.split("/").at(-1)}`],
  }));
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

class TargetPlanHarness implements AgentHarness {
  public writerCalls = 0;
  public plannerInstructions: Array<string | undefined> = [];
  public plannerRevisions: Array<string | undefined> = [];

  public constructor(
    private readonly paths: readonly string[],
    private readonly onPlan?: () => void,
  ) {}

  public async runStep(input: HarnessStepInput) {
    if (input.step.skill === "write-documentation") {
      this.writerCalls += 1;
      if (!input.planBinding) throw new Error("writer did not receive the planner binding");
      for (const page of input.planBinding.pages) {
        await mkdir(dirname(join(input.repositoryPath, page.path)), { recursive: true });
        await writeFile(
          join(input.repositoryPath, page.path),
          `# Deterministic target fixture\n\nPath: ${page.path}\n`,
          "utf8",
        );
      }
    }
    if (input.step.skill === "plan-documentation") {
      this.plannerInstructions.push(input.instruction);
      this.plannerRevisions.push(input.evidenceIdentity?.repositoryRevision);
      this.onPlan?.();
    }
    return {
      summary:
        input.step.skill === "review-documentation"
          ? canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd()
          : `ran ${input.step.skill}`,
      ...(await verificationFixture(input)),
      ...(input.step.skill === "plan-documentation"
        ? {
            planBinding: bindingForPaths(
              this.paths,
              documentationPlanModeForWorkflow(input.workflow.name) ?? "create",
            ),
          }
        : {}),
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
    };
  }
}

/** A planner that returns one page per path with the given disposition. */
class DispositionPlanHarness implements AgentHarness {
  public writerCalls = 0;

  public constructor(
    private readonly mode: DocumentationPlanMode,
    private readonly dispositions: Readonly<Record<string, DocumentationPlanPageV1["disposition"]>>,
  ) {}

  public async runStep(input: HarnessStepInput) {
    if (input.step.skill === "write-documentation") this.writerCalls += 1;
    const pages = Object.entries(this.dispositions).map(([path, disposition]) => ({
      path,
      disposition,
    }));
    const sourceBindings = pages
      .filter((page) => page.disposition !== "retain" && page.disposition !== "out-of-scope")
      .map((page) => ({ pagePath: page.path, sources: ["README.md:1"] }));
    return {
      summary: `ran ${input.step.skill}`,
      ...(await verificationFixture(input)),
      ...(input.step.skill === "plan-documentation"
        ? {
            planBinding: {
              kind: "docsfab-documentation-plan" as const,
              schemaVersion: 1 as const,
              mode: this.mode,
              pages,
              sourceBindings,
              digest: documentationPlanBindingDigest({ mode: this.mode, pages, sourceBindings }),
            },
          }
        : {}),
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
    };
  }
}

class FilesystemWriterHarness implements AgentHarness {
  public readonly calls: string[] = [];
  public readonly writtenPaths = new Set<string>();
  public readonly plannerInstructions: string[] = [];
  public readonly plannerRevisions: string[] = [];
  public readonly writerPlanPaths: string[][] = [];

  public constructor(
    private readonly expectedBytes: Readonly<Record<string, string>>,
    private readonly mode: "create" | "update",
  ) {}

  public async runStep(input: HarnessStepInput) {
    this.calls.push(input.step.id);
    if (input.step.id === "plan-documentation") {
      this.plannerInstructions.push(input.instruction ?? "");
      this.plannerRevisions.push(input.evidenceIdentity?.repositoryRevision ?? "");
      return {
        summary: "planner produced the exact source-scoped documentation plan",
        ...(await verificationFixture(input)),
        planBinding: bindingForPaths(Object.keys(this.expectedBytes), this.mode),
      };
    }
    if (input.step.id === "write-documentation") {
      if (!input.planBinding) throw new Error("writer did not receive the planner binding");
      this.writerPlanPaths.push(input.planBinding.pages.map((page) => page.path).sort());
      for (const [relativePath, bytes] of Object.entries(this.expectedBytes)) {
        await mkdir(dirname(join(input.repositoryPath, relativePath)), { recursive: true });
        await writeFile(join(input.repositoryPath, relativePath), bytes, "utf8");
        this.writtenPaths.add(relativePath);
      }
    }
    return {
      summary:
        input.step.skill === "review-documentation"
          ? canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd()
          : `${input.step.id} completed from the deterministic harness`,
      ...(await verificationFixture(input)),
    };
  }
}

class WriterChangeEvidence implements RepositoryEvidenceCollector {
  public constructor(
    private readonly writer: FilesystemWriterHarness,
    private readonly status: "added" | "modified",
  ) {}

  public async capture(_context: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    const files = [...this.writer.writtenPaths]
      .sort()
      .map((path) => ({ path, status: this.status }));
    return {
      files,
      patch: {
        sha256: digestText(files.map((file) => `${file.status}:${file.path}`).join("\n")),
        byteLength: files.length,
        lineCount: files.length,
        artifactPath: ".docsfab/patches/deterministic-writer.patch",
        format: "git-diff",
      },
    };
  }
}

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class PassingScanner implements RepositorySecurityScanner {
  public async scan() {
    return {
      ruleSet: "test-v1",
      status: "passed" as const,
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    };
  }
}

class TargetEvidence implements RepositoryEvidenceCollector {
  public async capture(_context: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    return {
      files: [{ path: "docs/reference/cli.mdx", status: "modified" }],
      patch: {
        sha256: "b".repeat(64),
        byteLength: 1,
        lineCount: 1,
        artifactPath: ".docsfab/patches/run-1.patch",
        format: "git-diff",
      },
    };
  }
}

const SIX_DOCUMENTATION_TARGETS = [
  "docs/collections/README.md",
  "docs/collections/guide.md",
  "docs/collections/reference.md",
  "fern/pages/collections/_index.mdx",
  "fern/pages/collections/concepts.mdx",
  "fern/pages/collections/guide.mdx",
] as const;
const ROUTER_REVISION = "735d162e2134cbc6c284bac022686ec2e14063bc";
const ROUTER_INSTRUCTION =
  "Update exactly docs/collections/README.md, docs/collections/guide.md, docs/collections/reference.md and their Fern projections fern/pages/collections/_index.mdx, fern/pages/collections/concepts.mdx, fern/pages/collections/guide.mdx to clarify the Source, Shortcut, Installed, and Estate vocabulary and operational next steps using only current repository evidence. Preserve current behavior, routes, links, and unrelated content. Change no other path, and stop with a typed scope or input outcome before mutation if another page is required.";
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];
const activeSourceWorkspaces: RepositoryWorkspace[] = [];
const activeEvidenceCollectors: GitPatchEvidenceCollector[] = [];

afterEach(async () => {
  await Promise.all(activeEvidenceCollectors.splice(0).map((collector) => collector.dispose()));
  await Promise.all(activeSourceWorkspaces.splice(0).map((workspace) => workspace.dispose()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("documentation plan binding", () => {
  it("identifies write, verify, and review skills as plan consumers", () => {
    expect(
      [
        "write-documentation",
        "lint-documentation",
        "verify-technical-accuracy",
        "review-documentation",
      ].every((skill) => documentationPlanConsumerSkill(skill)),
    ).toBe(true);
    expect(documentationPlanConsumerSkill("plan-documentation")).toBe(false);
    expect(documentationPlanConsumerSkill("evaluate-document-quality")).toBe(false);
  });

  it.each(["create", "update", "restructure"] as const)(
    "hashes validated %s proposals on the host and supplies the writer with the same binding",
    (mode) => {
      const { digest, ...proposal } = binding(mode);
      const result = bindDocumentationPlanProposal(proposal, { expectedMode: mode });
      expect(result.digest).toBe(digest);
      expect(validateDocumentationPlanBinding(result)).toEqual(result);
      expect(bindDocumentationPlanProposal({ ...proposal, digest: "guessed-by-model" })).toEqual(
        result,
      );
      const workflow = getWorkflow(`${mode}-documentation`);
      const plannerPrompt = buildDocsFabStepPrompt({
        repositoryPath: "/tmp/repository",
        workflow,
        step: workflow.steps.find((step) => step.skill === "plan-documentation")!,
      });
      expect(plannerPrompt).toContain(`"planBinding":{"mode":"${mode}","pages"`);
      expect(plannerPrompt).toContain(`"disposition":"${mode === "restructure" ? "move" : mode}"`);
      expect(plannerPrompt).toContain('"outcome":"needs-input"');
      expect(plannerPrompt).toContain("Do not provide kind, schemaVersion, or digest");
      expect(plannerPrompt).not.toContain("planBinding must contain kind");
      const writerPrompt = buildDocsFabStepPrompt({
        repositoryPath: "/tmp/repository",
        workflow,
        step: workflow.steps.find((step) => step.skill === "write-documentation")!,
        planBinding: result,
      });
      expect(writerPrompt).toContain(JSON.stringify(result));
      expect(writerPrompt).not.toContain("Runtime planner response contract");
    },
  );

  it("rejects tampered or missing digests on existing bindings instead of repairing them", () => {
    const original = bindDocumentationPlanProposal(binding("update"));
    expect(() => validateDocumentationPlanBinding({ ...original, digest: "0".repeat(64) })).toThrow(
      "digest-mismatch",
    );
    expect(() => validateDocumentationPlanBinding({ ...original, digest: undefined })).toThrow(
      "invalid-shape",
    );
    const tampered = {
      ...original,
      sourceBindings: original.sourceBindings.map((entry) => ({
        ...entry,
        sources: ["different-source"],
      })),
    };
    expect(() => validateDocumentationPlanBinding(tampered)).toThrow("digest-mismatch");
  });

  it("validates proposal shape, mode, paths, and source coverage before binding", () => {
    expect(() => bindDocumentationPlanProposal({ ...binding(), extra: true })).toThrow(
      "invalid-shape",
    );
    expect(() => bindDocumentationPlanProposal(binding(), { expectedMode: "update" })).toThrow(
      "invalid-mode",
    );
    expect(() =>
      bindDocumentationPlanProposal({
        ...binding(),
        pages: [{ path: "../escape.md", disposition: "create" }],
      }),
    ).toThrow("invalid-path");
    expect(() => bindDocumentationPlanProposal({ ...binding(), sourceBindings: [] })).toThrow(
      "missing-source-binding",
    );
  });
  it("derives the plan mode from the declared documentation workflow", () => {
    expect(documentationPlanModeForWorkflow("create-documentation")).toBe("create");
    expect(documentationPlanModeForWorkflow("update-documentation")).toBe("update");
    expect(documentationPlanModeForWorkflow("restructure-documentation")).toBe("restructure");
    expect(documentationPlanModeForWorkflow("review-documentation")).toBeUndefined();
  });

  it("normalizes a deterministic multi-page binding and exposes only mutation paths", () => {
    const value = validateDocumentationPlanBinding(binding());
    expect(value.pages.map((page) => page.path)).toEqual([
      "docs/index.md",
      "docs/reference.md",
      "docs/setup.md",
      "docs/troubleshooting.md",
    ]);
    expect(documentationPlanWritePaths(value)).toEqual([
      "docs/index.md",
      "docs/reference.md",
      "docs/setup.md",
      "docs/troubleshooting.md",
    ]);
  });

  it("lets the host seal semantic model input and rejects supplied digest tampering", () => {
    const complete = binding();
    const { kind: _kind, schemaVersion: _schemaVersion, digest: _digest, ...semantic } = complete;
    const normalized = validateDocumentationPlanBinding(complete);
    expect(createDocumentationPlanBinding(semantic)).toEqual(normalized);
    expect(sealDocumentationPlanBinding(semantic)).toEqual(normalized);
    expect(() => sealDocumentationPlanBinding({ ...complete, digest: "0".repeat(64) })).toThrow(
      "digest-mismatch",
    );
  });

  it("accepts restructure dispositions and rejects an unbound expansion", () => {
    expect(
      documentationPlanWritePaths(validateDocumentationPlanBinding(binding("restructure"))),
    ).toEqual(["docs/guide.md", "docs/recovery.md"]);
    const original = binding();
    const expanded = {
      ...original,
      pages: [...original.pages, { path: "docs/extra.md", disposition: "create" }],
    };
    expect(() => validateDocumentationPlanBinding(expanded)).toThrow("missing-source-binding");
  });

  it("admits optional read evidence for a retained page without granting writes or out-of-scope reads", () => {
    const pages = [
      { path: "docs/guide.md", disposition: "restructure" },
      { path: "docs/reference.md", disposition: "retain" },
      { path: "docs/internal.md", disposition: "out-of-scope" },
    ];
    const required = { pagePath: "docs/guide.md", sources: ["docs/guide.md"] };
    const retained = {
      pagePath: "docs/reference.md",
      sources: ["docs/reference.md", "src/config.ts"],
    };
    const plan = bindDocumentationPlanProposal({
      mode: "restructure",
      pages,
      sourceBindings: [required, retained],
    });
    expect(plan.sourceBindings).toContainEqual(retained);
    expect(validateDocumentationPlanBinding(plan)).toEqual(plan);
    const sourceAware = createSourceAwareDocumentationPlanBinding(plan, "c".repeat(64));
    expect(validateSourceAwareDocumentationPlanBinding(sourceAware)).toEqual(sourceAware);
    expect(documentationPlanWritePaths(plan)).toEqual(["docs/guide.md"]);
    expect(documentationPlanVerificationPaths(plan)).toEqual([
      "docs/guide.md",
      "docs/reference.md",
    ]);
    expect(
      bindDocumentationPlanProposal({ mode: "restructure", pages, sourceBindings: [required] })
        .sourceBindings,
    ).toEqual([required]);
    expect(() =>
      bindDocumentationPlanProposal({ mode: "restructure", pages, sourceBindings: [retained] }),
    ).toThrow("missing-source-binding");
    for (const pagePath of ["docs/internal.md", "docs/unknown.md"]) {
      expect(() =>
        bindDocumentationPlanProposal({
          mode: "restructure",
          pages,
          sourceBindings: [required, retained, { pagePath, sources: ["src/extra.ts"] }],
        }),
      ).toThrow("missing-source-binding");
    }
  });

  it("still refuses a CREATE write target cited by a retained page's source binding", () => {
    const pages = [
      { path: "docs/new.md", disposition: "create" },
      { path: "docs/retained.md", disposition: "retain" },
    ];
    const required = { pagePath: "docs/new.md", sources: ["src/api.ts"] };
    expect(() =>
      bindDocumentationPlanProposal({
        mode: "create",
        pages,
        sourceBindings: [required, { pagePath: "docs/retained.md", sources: ["docs/new.md"] }],
      }),
    ).toThrow("invalid-source");
    expect(() =>
      bindDocumentationPlanProposal(
        {
          mode: "create",
          pages,
          sourceBindings: [
            required,
            { pagePath: "docs/retained.md", sources: [`src/config.ts@${"b".repeat(40)}`] },
          ],
        },
        { expectedRevision: "a".repeat(40) },
      ),
    ).toThrow("invalid-source");
  });

  it("fails closed when a mutating page has no source binding", () => {
    const value = binding();
    value.sourceBindings = value.sourceBindings.slice(1);
    value.digest = documentationPlanBindingDigest(value);
    expect(() => validateDocumentationPlanBinding(value)).toThrow("missing-source-binding");
  });

  it.each([
    { name: "a different target", paths: ["docs/about/product.md"] },
    {
      name: "a mixed target expansion",
      paths: ["docs/reference/cli.mdx", "docs/about/product.md"],
    },
  ])("rejects $name before the writer receives access", async ({ paths }) => {
    const harness = new TargetPlanHarness(paths);
    const store = new MemoryStore();
    const runner = await targetBoundRunner(harness, store);

    const record = await runner.run(targetBoundRequest());

    expect(record.status).toBe("failed");
    expect(record.steps.find((step) => step.skill === "plan-documentation")?.error).toBe(
      "Documentation plan target does not match the knowledge resume receipt.",
    );
    expect(record.knowledgeResumeReceipt).toEqual(targetReceipt());
    expect(harness.writerCalls).toBe(0);
    expect(store.records.at(-1)?.knowledgeResumeReceipt).toEqual(targetReceipt());
  });

  it("allows the exact receipt target and retains the receipt from queued through success", async () => {
    const harness = new TargetPlanHarness(["docs/reference/cli.mdx"]);
    const store = new MemoryStore();

    const record = await (await targetBoundRunner(harness, store)).run(targetBoundRequest());

    expect(record.status, record.error).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
    expect(store.records[0]?.status).toBe("queued");
    expect(store.records.every((saved) => saved.knowledgeResumeReceipt !== undefined)).toBe(true);
    expect(record.knowledgeResumeReceipt).toEqual(targetReceipt());
  });

  it("lets an exact six-target first-pass plan reach the writer", async () => {
    const harness = new TargetPlanHarness(SIX_DOCUMENTATION_TARGETS);
    const store = new MemoryStore();

    const record = await (await targetBoundRunner(harness, store)).run(
      firstPassRequest(),
      firstPassTargetControl(),
    );

    expect(record.status, record.error).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
  });

  it("carries real gathered support through host binding into the runner (scripted transport, not semantic or live proof)", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-runner-first-pass-integration-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    await mkdir(workspace, { recursive: true });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(workspace, "README.md"),
      [
        "# Collections CLI",
        "",
        "Source is canonical input. Shortcut is a local alias. Installed is locally available.",
        "Estate is the ordered set of collections. Run `router list` to inspect the next step.",
      ].join("\n"),
    );
    for (const [index, targetPath] of SIX_DOCUMENTATION_TARGETS.entries()) {
      await mkdir(dirname(join(workspace, targetPath)), { recursive: true });
      await writeFile(
        join(workspace, targetPath),
        [
          `# Collections page ${String(index + 1)}`,
          "",
          "Source is canonical input. Shortcut is a local alias. Installed is locally available.",
          "Estate is the ordered set of collections. Run `router list` for operational next steps.",
        ].join("\n"),
      );
    }
    const observedPrompts: string[] = [];
    const binding = await bindFirstPassKnowledge({
      request: firstPassCliRequest(workspace),
      config: firstPassStubConfig(stateDirectory),
      workspacePath: workspace,
      revision: ROUTER_REVISION,
      status: () => undefined,
      supportModelBridge: integratedScriptedBridge(observedPrompts),
    });
    const control = binding?.firstPassTargetControl;
    if (!control) throw new Error("real first-pass binding did not return a target control");

    expect(observedPrompts).toHaveLength(3);
    expect(observedPrompts[0]).toContain(
      `Original instruction: ${JSON.stringify(ROUTER_INSTRUCTION)}`,
    );
    expect(observedPrompts[1]).toContain(
      `Exact write targets: ${JSON.stringify([...SIX_DOCUMENTATION_TARGETS].sort())}`,
    );
    for (const targetPath of SIX_DOCUMENTATION_TARGETS) {
      expect(parseEvidenceFrames(observedPrompts[2]!).map((frame) => frame.path)).toContain(
        targetPath,
      );
    }
    expect(control).toMatchObject({
      workflow: "update-documentation",
      instructionSha256: digestText(ROUTER_INSTRUCTION.normalize("NFC")),
      repositoryRevision: ROUTER_REVISION,
      targetPaths: [...SIX_DOCUMENTATION_TARGETS].sort(),
    });

    const request = integratedFirstPassRequest(workspace);
    const exactHarness = new TargetPlanHarness(control.targetPaths);
    const exactRunner = await targetBoundRunner(exactHarness, new MemoryStore());
    const exactRecord = await exactRunner.run(request, control);
    expect(exactRecord.status).toBe("succeeded");
    expect(exactHarness.writerCalls).toBe(1);
    expect(exactHarness.plannerInstructions).toEqual([ROUTER_INSTRUCTION]);
    expect(exactHarness.plannerRevisions).toEqual([exactRunner.repositoryRevision]);

    for (const [plannedPaths, expectedError] of [
      [
        control.targetPaths.slice(1),
        new OmittedFirstPassTargetError(control.targetPaths.slice(0, 1), "update").message,
      ],
      [
        [...control.targetPaths, "docs/collections/extra.md"],
        // With no write roots handed to it, the runner confines the plan to the named pages.
        new PlanWriteScopeError(
          [{ path: "docs/collections/extra.md", refusal: "outside-roots" }],
          control.targetPaths,
        ).message,
      ],
    ] as const) {
      const driftHarness = new TargetPlanHarness(plannedPaths);
      const driftRunner = await targetBoundRunner(driftHarness, new MemoryStore());
      const driftRecord = await driftRunner.run(request, control);
      expect(driftRecord.status).toBe("failed");
      expect(driftRecord.steps.find((step) => step.skill === "plan-documentation")?.error).toBe(
        expectedError,
      );
      expect(driftHarness.writerCalls).toBe(0);
      expect(driftHarness.plannerInstructions).toEqual([ROUTER_INSTRUCTION]);
      expect(driftHarness.plannerRevisions).toEqual([driftRunner.repositoryRevision]);
    }
  });

  it("executes first pass, planning, and a writer for a plain root create", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-runner-plain-root-create-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    await mkdir(workspace, { recursive: true });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(workspace, "README.md"),
      "# Widget CLI\n\nThe widget reads its configuration from widget.toml.\n",
    );
    await writeFile(join(workspace, "unrelated.md"), "# Keep this page unchanged\n");

    const instruction =
      "Create exactly getting-started.md and reference.md using only current repository evidence. Preserve unrelated content and change no other path.";
    const revision = "1".repeat(40);
    const observedPrompts: string[] = [];
    const binding = await bindFirstPassKnowledge({
      request: firstPassCliRequestFor(workspace, "create-documentation", instruction, revision),
      config: firstPassStubConfig(stateDirectory),
      workspacePath: workspace,
      revision,
      status: () => undefined,
      supportModelBridge: integratedScriptedBridge(observedPrompts),
    });
    const control = binding?.firstPassTargetControl;
    if (!control) throw new Error("plain root create did not produce a first-pass target control");
    expect(observedPrompts).toHaveLength(3);
    expect(control.targetPaths).toEqual(["getting-started.md", "reference.md"]);

    const expectedBytes = {
      "getting-started.md":
        "# Getting started\n\nThe widget reads its configuration from widget.toml.\n",
      "reference.md": "# Reference\n\nThe widget configuration is documented here.\n",
    };
    const writer = new FilesystemWriterHarness(expectedBytes, "create");
    const runner = await targetBoundRunner(
      writer,
      new MemoryStore(),
      new WriterChangeEvidence(writer, "added"),
      workspace,
    );
    const record = await runner.run(
      runnerRequestFor(workspace, "create-documentation", instruction, revision),
      control,
    );

    expect(record.status, record.error).toBe("succeeded");
    expect(writer.calls.slice(0, 3)).toEqual([
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
    ]);
    expect(writer.plannerInstructions).toEqual([instruction]);
    expect(writer.plannerRevisions).toEqual([runner.repositoryRevision]);
    expect(writer.writerPlanPaths).toEqual([["getting-started.md", "reference.md"]]);
    expect([...writer.writtenPaths].sort()).toEqual(["getting-started.md", "reference.md"]);
    expect(record.models).toEqual([]);
    expect(record.usage.total).toBe(0);
    expect(record.changes?.files).toEqual([
      { path: "getting-started.md", status: "copied", previousPath: "README.md" },
      { path: "reference.md", status: "added" },
    ]);
    const changedPaths = Object.keys(expectedBytes)
      .sort()
      .map((path) => ({ path, status: "added" as const }));
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: runner.workspacePath,
      repositoryIdentitySha256: digestText("plain-root-create-repository"),
      baseRevision: revision,
      candidateInputTreeSha256: digestText(JSON.stringify(expectedBytes)),
      changedPaths,
    });
    expect(applicability.roots).toEqual([
      expect.objectContaining({
        root: ".",
        adapterId: "plain-markdown",
        navigationMode: "none",
        configurationFiles: [],
        limitations: [],
      }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(runner.workspacePath, changedPaths, applicability),
    ).resolves.toEqual([
      { id: "documentation-source-applicability", status: "passed" },
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "documentation-navigation-targets", status: "passed" },
    ]);
    for (const [relativePath, bytes] of Object.entries(expectedBytes)) {
      expect(await readFile(join(runner.workspacePath, relativePath), "utf8")).toBe(bytes);
    }
    expect(await readFile(join(runner.workspacePath, "unrelated.md"), "utf8")).toBe(
      "# Keep this page unchanged\n",
    );
  });

  it("executes first pass, planning, and a writer for a nested package multi-page update", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-runner-nested-package-update-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    const packageRoot = join(workspace, "packages", "widget");
    await mkdir(join(packageRoot, "docs"), { recursive: true });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(packageRoot, "README.md"),
      "# Widget package\n\nThe widget package exposes the collection command.\n",
    );
    await writeFile(
      join(packageRoot, "docs", "guide.md"),
      "# Old guide\n\nThe previous guide content.\n",
    );
    await writeFile(
      join(packageRoot, "docs", "reference.md"),
      "# Old reference\n\nThe previous reference content.\n",
    );
    await writeFile(join(packageRoot, "notes.md"), "# Keep package notes unchanged\n");

    const instruction =
      "Update exactly packages/widget/docs/guide.md and packages/widget/docs/reference.md using only current repository evidence. Preserve unrelated content and change no other path.";
    const revision = "2".repeat(40);
    const observedPrompts: string[] = [];
    const binding = await bindFirstPassKnowledge({
      request: firstPassCliRequestFor(workspace, "update-documentation", instruction, revision),
      config: firstPassStubConfig(stateDirectory),
      workspacePath: workspace,
      revision,
      status: () => undefined,
      supportModelBridge: integratedScriptedBridge(observedPrompts),
    });
    const control = binding?.firstPassTargetControl;
    if (!control)
      throw new Error("nested package update did not produce a first-pass target control");
    expect(observedPrompts).toHaveLength(3);
    expect(control.targetPaths).toEqual([
      "packages/widget/docs/guide.md",
      "packages/widget/docs/reference.md",
    ]);

    const expectedBytes = {
      "packages/widget/docs/guide.md":
        "# Widget guide\n\nThe collection command is documented for package operators.\n",
      "packages/widget/docs/reference.md":
        "# Widget reference\n\nThe collection command lists available entries.\n",
    };
    const writer = new FilesystemWriterHarness(expectedBytes, "update");
    const runner = await targetBoundRunner(
      writer,
      new MemoryStore(),
      new WriterChangeEvidence(writer, "modified"),
      workspace,
    );
    const record = await runner.run(
      runnerRequestFor(workspace, "update-documentation", instruction, revision),
      control,
    );

    expect(record.status).toBe("succeeded");
    expect(writer.calls.slice(0, 3)).toEqual([
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
    ]);
    expect(writer.plannerInstructions).toEqual([instruction]);
    expect(writer.plannerRevisions).toEqual([runner.repositoryRevision]);
    expect(writer.writerPlanPaths).toEqual([
      ["packages/widget/docs/guide.md", "packages/widget/docs/reference.md"],
    ]);
    expect([...writer.writtenPaths].sort()).toEqual([
      "packages/widget/docs/guide.md",
      "packages/widget/docs/reference.md",
    ]);
    expect(record.models).toEqual([]);
    expect(record.usage.total).toBe(0);
    expect(record.changes?.files).toEqual([
      { path: "packages/widget/docs/guide.md", status: "modified" },
      { path: "packages/widget/docs/reference.md", status: "modified" },
    ]);
    const changedPaths = Object.keys(expectedBytes)
      .sort()
      .map((path) => ({ path, status: "modified" as const }));
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: runner.workspacePath,
      repositoryIdentitySha256: digestText("nested-package-update-repository"),
      baseRevision: revision,
      candidateInputTreeSha256: digestText(JSON.stringify(expectedBytes)),
      changedPaths,
    });
    expect(applicability.roots).toEqual([
      expect.objectContaining({
        root: "packages/widget",
        adapterId: "plain-markdown",
        navigationMode: "none",
        configurationFiles: [],
        limitations: [],
      }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(runner.workspacePath, changedPaths, applicability),
    ).resolves.toEqual([
      { id: "documentation-source-applicability", status: "passed" },
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "documentation-navigation-targets", status: "passed" },
    ]);
    for (const [relativePath, bytes] of Object.entries(expectedBytes)) {
      expect(await readFile(join(runner.workspacePath, relativePath), "utf8")).toBe(bytes);
    }
    expect(
      await readFile(join(runner.workspacePath, "packages", "widget", "notes.md"), "utf8"),
    ).toBe("# Keep package notes unchanged\n");
  });

  it.each([
    {
      name: "a missing target",
      paths: SIX_DOCUMENTATION_TARGETS.slice(1),
      error: new OmittedFirstPassTargetError(SIX_DOCUMENTATION_TARGETS.slice(0, 1), "update")
        .message,
    },
    {
      name: "an extra target, when no write roots widen the named pages",
      paths: [...SIX_DOCUMENTATION_TARGETS, "docs/collections/extra.md"],
      error: new PlanWriteScopeError(
        [{ path: "docs/collections/extra.md", refusal: "outside-roots" }],
        [...SIX_DOCUMENTATION_TARGETS].sort(),
      ).message,
    },
    {
      name: "a substituted target",
      paths: [...SIX_DOCUMENTATION_TARGETS.slice(0, -1), "fern/pages/collections/reference.mdx"],
      error: new OmittedFirstPassTargetError(SIX_DOCUMENTATION_TARGETS.slice(-1), "update").message,
    },
  ])("stops $name before the writer", async ({ paths, error }) => {
    const harness = new TargetPlanHarness(paths);
    const store = new MemoryStore();

    const record = await (await targetBoundRunner(harness, store)).run(
      firstPassRequest(),
      firstPassTargetControl(),
    );

    expect(record.status).toBe("failed");
    expect(record.steps.find((step) => step.skill === "plan-documentation")?.error).toBe(error);
    expect(harness.writerCalls).toBe(0);
  });

  // Only an update plan addresses a named page by keeping it; a create
  // or restructure plan still writes every named page.
  it("addresses a kept page only in an update plan", () => {
    const pages = (mode: DocumentationPlanMode, written: string) =>
      createDocumentationPlanBinding({
        mode,
        pages: [
          { path: "docs/a.md", disposition: written as DocumentationPlanPageV1["disposition"] },
          { path: "docs/b.md", disposition: "retain" },
          { path: "docs/c.md", disposition: "out-of-scope" },
        ],
        sourceBindings: [{ pagePath: "docs/a.md", sources: ["README.md:1"] }],
      });
    expect(documentationPlanAddressedPaths(pages("update", "update"))).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
    expect(documentationPlanAddressedPaths(pages("create", "create"))).toEqual(["docs/a.md"]);
    expect(documentationPlanAddressedPaths(pages("restructure", "restructure"))).toEqual([
      "docs/a.md",
    ]);
  });

  it("stops a create plan that keeps a named target before the writer", async () => {
    const targets = ["docs/collections/new-guide.md", "docs/collections/new-reference.md"];
    const harness = new DispositionPlanHarness("create", {
      [targets[0]!]: "create",
      [targets[1]!]: "retain",
    });

    const record = await (await targetBoundRunner(harness, new MemoryStore())).run(
      firstPassRequest({ workflow: "create-documentation" }),
      firstPassTargetControl({ workflow: "create-documentation", targetPaths: targets }),
    );

    expect(record.status).toBe("failed");
    const planner = record.steps.find((step) => step.skill === "plan-documentation");
    expect(planner?.error).toBe(new OmittedFirstPassTargetError([targets[1]!], "create").message);
    expect(planner?.failure).toMatchObject({
      class: "planning-refusal",
      code: "omitted-mandatory-obligation",
    });
    expect(harness.writerCalls).toBe(0);
  });

  it("misleading-plan-omits-obligation cannot report full completion", async () => {
    const harness = new TargetPlanHarness(SIX_DOCUMENTATION_TARGETS.slice(1));
    const store = new MemoryStore();
    const record = await (await targetBoundRunner(harness, store)).run(
      firstPassRequest(),
      firstPassTargetControl(),
    );
    expect(record.status).toBe("failed");
    expect(record.workflowOutcome).not.toEqual(expect.objectContaining({ disposition: "ready" }));
    expect(record.steps.find((step) => step.skill === "plan-documentation")?.error).toBe(
      new OmittedFirstPassTargetError(SIX_DOCUMENTATION_TARGETS.slice(0, 1), "update").message,
    );
    expect(harness.writerCalls).toBe(0);
  });

  it.each([
    {
      name: "closed shape",
      request: firstPassRequest(),
      control: {
        ...firstPassTargetControl(),
        addedAuthority: true,
      } as FirstPassDocumentationTargetControl,
    },
    {
      name: "body digest",
      request: firstPassRequest(),
      control: firstPassTargetControl({ bodySha256: "0".repeat(64) }),
    },
    {
      name: "instruction",
      request: firstPassRequest({
        instruction: "A different original instruction.",
      }),
      control: firstPassTargetControl(),
    },
    {
      name: "workflow",
      request: firstPassRequest({
        workflow: "create-documentation",
      }),
      control: firstPassTargetControl(),
    },
    {
      name: "repository revision",
      request: firstPassRequest({
        repository: {
          sourcePath: "/tmp/repository",
          requestedRevision: "HEAD",
          revision: "e".repeat(40),
        },
      }),
      control: firstPassTargetControl(),
    },
    {
      name: "target path",
      request: firstPassRequest(),
      control: firstPassTargetControl({ targetPaths: ["../escape.md"] }),
    },
  ])("rejects $name drift before creating a run record", async ({ request, control }) => {
    const harness = new TargetPlanHarness(SIX_DOCUMENTATION_TARGETS);
    const store = new MemoryStore();

    await expect((await targetBoundRunner(harness, store)).run(request, control)).rejects.toThrow(
      "First-pass documentation target control does not match the workflow request.",
    );
    expect(store.records).toHaveLength(0);
    expect(harness.writerCalls).toBe(0);
  });

  it("does not retain a first-pass target control for a later uncontrolled call", async () => {
    const harness = new TargetPlanHarness(SIX_DOCUMENTATION_TARGETS);
    const store = new MemoryStore();
    const runner = await targetBoundRunner(harness, store);
    const request = firstPassRequest();

    expect((await runner.run(request, firstPassTargetControl())).status).toBe("succeeded");
    expect((await runner.run(request)).status).toBe("succeeded");
    expect(harness.writerCalls).toBe(2);
  });

  it("holds a defensive target snapshot if the caller mutates its array during planning", async () => {
    const mutableTargets: string[] = [...SIX_DOCUMENTATION_TARGETS];
    const harness = new TargetPlanHarness(SIX_DOCUMENTATION_TARGETS, () => {
      mutableTargets.splice(0, mutableTargets.length, "docs/substituted.md");
    });
    const store = new MemoryStore();
    const control = firstPassTargetControl({ targetPaths: mutableTargets });

    const record = await (await targetBoundRunner(harness, store)).run(firstPassRequest(), control);

    expect(record.status).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
    expect(mutableTargets).toEqual(["docs/substituted.md"]);
  });
});

function bindingForPaths(paths: readonly string[], mode: DocumentationPlanMode = "create") {
  const pages = paths.map((path) => ({ path, disposition: mode }));
  const sourceBindings = paths.map((path) => ({ pagePath: path, sources: ["README.md:1"] }));
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

function targetReceipt() {
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-knowledge-resume-receipt" as const,
    snapshotSha256: "c".repeat(64),
    selectedTargetPath: "docs/reference/cli.mdx",
    advisoryConflicts: [
      {
        conflictId: "CF-ABOUT",
        claimIds: ["CL-ABOUT-1", "CL-ABOUT-2"],
        impact: "load-bearing" as const,
        impactBasisSha256: "d".repeat(64),
        blockingDocumentationPaths: ["docs/about/product.md"],
        resolutionOwner: "product-owner",
        authorityKind: "product-decision-owner" as const,
      },
    ],
  };
}

function targetBoundRequest() {
  return {
    workflow: "create-documentation" as const,
    workspacePath: "/tmp/docsfab-workspace/repository",
    repository: {
      sourcePath: "/tmp/repository",
      requestedRevision: "HEAD",
      revision: "f".repeat(40),
    },
    instruction: [
      "Write `docs/reference/cli.mdx` using only these repository-observed behavior claims:",
      "- The widget --version command prints the installed version.",
    ].join("\n"),
    allowWrite: true,
    knowledgeResumeReceipt: targetReceipt(),
  };
}

function firstPassRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    workflow: "update-documentation",
    workspacePath: "/tmp/docsfab-workspace/repository",
    repository: {
      sourcePath: "/tmp/repository",
      requestedRevision: ROUTER_REVISION,
      revision: ROUTER_REVISION,
    },
    instruction: ROUTER_INSTRUCTION,
    allowWrite: true,
    ...overrides,
  };
}

function firstPassTargetControl(
  overrides: Partial<FirstPassDocumentationTargetControl> = {},
): FirstPassDocumentationTargetControl {
  const body = {
    workflow: "update-documentation" as const,
    instructionSha256: createHash("sha256")
      .update(ROUTER_INSTRUCTION.normalize("NFC"), "utf8")
      .digest("hex"),
    repositoryRevision: ROUTER_REVISION,
    targetPaths: SIX_DOCUMENTATION_TARGETS as readonly string[],
    ...overrides,
  };
  const bodySha256 = createHash("sha256")
    .update(
      JSON.stringify({
        workflow: body.workflow,
        instructionSha256: body.instructionSha256,
        repositoryRevision: body.repositoryRevision,
        targetPaths: body.targetPaths,
      }),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({ ...body, bodySha256, ...overrides });
}

function firstPassCliRequest(repositoryPath: string): RunRequestWithPublishProjection {
  return {
    workflow: "update-documentation",
    repositoryPath,
    revision: ROUTER_REVISION,
    instruction: ROUTER_INSTRUCTION,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

function firstPassCliRequestFor(
  repositoryPath: string,
  workflow: "create-documentation" | "update-documentation",
  instruction: string,
  revision: string,
): RunRequestWithPublishProjection {
  return {
    workflow,
    repositoryPath,
    revision,
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

function integratedFirstPassRequest(workspacePath: string): RunRequest {
  return firstPassRequest({
    workspacePath,
    repository: {
      sourcePath: workspacePath,
      requestedRevision: ROUTER_REVISION,
      revision: ROUTER_REVISION,
    },
  });
}

function runnerRequestFor(
  workspacePath: string,
  workflow: "create-documentation" | "update-documentation",
  instruction: string,
  revision: string,
): RunRequest {
  return {
    workflow,
    workspacePath,
    repository: {
      sourcePath: workspacePath,
      requestedRevision: revision,
      revision,
    },
    instruction,
    allowWrite: true,
  };
}

function firstPassStubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "..", "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: { provider: "none", model: "none" },
  } as unknown as DocsFabConfig;
}

function integratedScriptedBridge(observedPrompts: string[]): FirstPassSupportModelBridge {
  let lastIdentitySha256: string | undefined;
  let lastBindingSha256: string | undefined;
  return {
    call: async (request: FirstPassSupportModelRequest) => {
      observedPrompts.push(request.prompt);
      let value: unknown;
      if (request.prompt.startsWith("Phase: obligation-decomposition")) {
        value = { schemaVersion: 1, additionalObligations: [] };
      } else if (request.prompt.startsWith("Phase: obligation-completeness-audit")) {
        value = { schemaVersion: 1, complete: true, omissions: [] };
      } else {
        const obligationsLine = request.prompt
          .split("\n")
          .find((line) => line.startsWith("Mandatory obligations: "));
        if (!obligationsLine) throw new Error("assessment prompt omitted mandatory obligations");
        const obligations = JSON.parse(
          obligationsLine.slice("Mandatory obligations: ".length),
        ) as Array<{
          id: string;
          targetPaths: string[];
          requiredSourceSupport: boolean;
        }>;
        const spansByPath = new Map(
          parseEvidenceFrames(request.prompt).map((frame) => [frame.path, frame.id] as const),
        );
        const firstSpan = spansByPath.values().next().value as string | undefined;
        if (!firstSpan) throw new Error("assessment prompt omitted repository evidence");
        value = {
          schemaVersion: 1,
          assessments: obligations.map((obligation) => {
            const matchingSpan = obligation.targetPaths
              .map((targetPath) => spansByPath.get(targetPath))
              .find((span) => span !== undefined);
            return {
              obligationId: obligation.id,
              status: "supported",
              evidenceSpanIds: obligation.requiredSourceSupport ? [matchingSpan ?? firstSpan] : [],
              detail: "Deterministic transport fixture selected an offered repository span.",
            };
          }),
        };
      }
      const responseText = JSON.stringify(value);
      const identity = {
        providerId: "scripted-transport",
        modelId: "scripted-transport-v1",
        profileSha256: digestText("scripted-profile"),
        compositionSha256: null,
        requestPolicySha256: null,
        systemPromptSha256: digestText(request.systemPrompt),
        promptSha256: request.promptSha256,
        procedureSha256: request.procedureSha256,
        responseSha256: digestText(responseText),
        turnEvidenceSha256: digestText("scripted-turn-evidence"),
      };
      lastIdentitySha256 = digestCanonical(identity);
      if (!request.prompt.startsWith("Phase:")) {
        lastBindingSha256 = firstPassAssessmentBindingSha256(
          request.prompt,
          responseText,
          parseEvidenceFrames,
        );
      }
      return {
        responseText,
        identity,
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    },
    lastAssessmentIdentitySha256: () => lastIdentitySha256,
    lastAssessmentBindingSha256: () => lastBindingSha256,
  };
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function targetBoundRunner(
  harness: AgentHarness,
  store: RunStore,
  repositoryEvidence: RepositoryEvidenceCollector = new TargetEvidence(),
  sourcePath?: string,
) {
  const sourceWorkspace = await prepareSourceAuthorityWorkspace(sourcePath);
  const sourceObserver = new LocalSourceObligationSourceObserver(sourceWorkspace);
  const artifactDirectory = await mkdtemp(join(tmpdir(), "docsfab-plan-authoring-artifacts-"));
  temporaryDirectories.push(artifactDirectory);
  const evidenceCollector = await GitPatchEvidenceCollector.create(
    sourceWorkspace.path,
    artifactDirectory,
  );
  activeEvidenceCollectors.push(evidenceCollector);
  const hostOperations = {
    runStep: async () => ({ summary: "Fixture native checks passed" }),
  };
  const authoringCandidateLifecycle = new LocalAuthoringCandidateLifecycle({
    workspace: sourceWorkspace,
    evidenceCollector,
    search: new LocalWorkflowSearchCoordinator(),
    sourceObserver,
    hostOperations,
    artifactDirectory,
  });
  const protocol = scriptedEditorialProtocol(harness);
  const runner = new WorkflowRunner({
    ...protocol,
    hostOperations,
    store,
    repositoryScanner: new PassingScanner(),
    contextPreflight: readyContextPreflight,
    repositoryEvidence,
    workflowSearch: new LocalWorkflowSearchCoordinator(),
    sourceObligationObserver: sourceObserver,
    authoringCandidateLifecycle,
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    id: () => "target-bound-run",
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  });
  return {
    workspacePath: sourceWorkspace.path,
    repositoryRevision: sourceWorkspace.revision,
    run: (request: RunRequest, control?: FirstPassDocumentationTargetControl) => {
      const reboundControl =
        control && control.repositoryRevision === request.repository.revision
          ? rebindTargetControlRevision(control, sourceWorkspace.revision)
          : control;
      return runner.run(
        {
          ...request,
          workspacePath: sourceWorkspace.path,
          repository: {
            sourcePath: sourceWorkspace.sourcePath,
            requestedRevision: sourceWorkspace.revision,
            revision: sourceWorkspace.revision,
          },
        },
        reboundControl,
      );
    },
  };
}

function rebindTargetControlRevision(
  control: FirstPassDocumentationTargetControl,
  repositoryRevision: string,
): FirstPassDocumentationTargetControl {
  const originalBody = {
    workflow: control.workflow,
    instructionSha256: control.instructionSha256,
    repositoryRevision: control.repositoryRevision,
    targetPaths: control.targetPaths,
  };
  const expectedKeys = [
    "bodySha256",
    "instructionSha256",
    "repositoryRevision",
    "targetPaths",
    "workflow",
  ];
  if (
    JSON.stringify(Object.keys(control).sort()) !== JSON.stringify(expectedKeys) ||
    createHash("sha256").update(JSON.stringify(originalBody), "utf8").digest("hex") !==
      control.bodySha256
  ) {
    return control;
  }
  const body = { ...originalBody, repositoryRevision };
  return Object.freeze({
    ...body,
    bodySha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  });
}

async function prepareSourceAuthorityWorkspace(sourcePath?: string): Promise<RepositoryWorkspace> {
  const root = sourcePath
    ? undefined
    : await mkdtemp(join(tmpdir(), "docsfab-plan-source-authority-"));
  if (root) temporaryDirectories.push(root);
  const repository = sourcePath ?? join(root!, "repository");
  await mkdir(join(repository, "src"), { recursive: true });
  try {
    await readFile(join(repository, "README.md"));
  } catch {
    await writeFile(join(repository, "README.md"), "deterministic plan source evidence\n");
  }
  try {
    await readFile(join(repository, "src", "api.ts"));
  } catch {
    await writeFile(join(repository, "src", "api.ts"), "export const api = true;\n");
  }
  await initFixtureRepo(repository, {}, { message: "source authority fixture" });
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  activeSourceWorkspaces.push(workspace);
  return workspace;
}

describe("source-aware documentation plan binding (V2)", () => {
  const SOURCE_BINDING_SHA = "c".repeat(64);
  const OTHER_SOURCE_BINDING_SHA = "d".repeat(64);
  const PLAN = {
    mode: "create" as const,
    pages: [{ path: "docs/guide.md", disposition: "create" as const }],
    sourceBindings: [{ pagePath: "docs/guide.md", sources: ["docs/source.html"] }],
  };

  it("seals a V2 binding that carries the complete source-binding digest", () => {
    const binding = createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA);
    expect(binding.schemaVersion).toBe(2);
    expect(binding.sourceBindingSha256).toBe(SOURCE_BINDING_SHA);
    expect(validateSourceAwareDocumentationPlanBinding(binding)).toEqual(binding);
  });

  it("never collides with the V1 digest of the same pages and sources", () => {
    const v1 = createDocumentationPlanBinding(PLAN);
    const v2 = createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA);
    expect(v2.digest).not.toBe(v1.digest);
    expect(admittedDocumentationPlanBindingSha256(v1)).toBe(v1.digest);
    expect(admittedDocumentationPlanBindingSha256(v2)).toBe(v2.digest);
    expect(admittedDocumentationPlanBindingSha256(v2)).not.toBe(
      admittedDocumentationPlanBindingSha256(v1),
    );
  });

  it("changes identity when the admitted source binding changes", () => {
    expect(createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA).digest).not.toBe(
      createSourceAwareDocumentationPlanBinding(PLAN, OTHER_SOURCE_BINDING_SHA).digest,
    );
  });

  it("rejects a V2 binding whose source digest was swapped after sealing", () => {
    const binding = createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA);
    expect(() =>
      validateSourceAwareDocumentationPlanBinding({
        ...binding,
        sourceBindingSha256: OTHER_SOURCE_BINDING_SHA,
      }),
    ).toThrowError(new DocumentationPlanBindingError("digest-mismatch"));
  });

  it("rejects a V2 binding with a truncated source digest", () => {
    const binding = createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA);
    expect(() =>
      validateSourceAwareDocumentationPlanBinding({
        ...binding,
        sourceBindingSha256: SOURCE_BINDING_SHA.slice(0, 32),
      }),
    ).toThrowError(new DocumentationPlanBindingError("invalid-source-evidence"));
  });

  it("preserves the exact V1 bytes and authority for a no-source plan", () => {
    const v1 = createDocumentationPlanBinding(PLAN);
    expect(v1.schemaVersion).toBe(1);
    expect(Object.keys(v1).sort()).toEqual([
      "digest",
      "kind",
      "mode",
      "pages",
      "schemaVersion",
      "sourceBindings",
    ]);
    expect(validateDocumentationPlanBinding(v1)).toEqual(v1);
    expect(isSourceAwareDocumentationPlanBinding(v1)).toBe(false);
  });

  it("dispatches on the explicit variant and refuses an unknown one", () => {
    const v1 = createDocumentationPlanBinding(PLAN);
    const v2 = createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA);
    expect(validateAdmittedDocumentationPlanBinding(v1)).toEqual(v1);
    expect(validateAdmittedDocumentationPlanBinding(v2)).toEqual(v2);
    expect(() =>
      validateAdmittedDocumentationPlanBinding({ ...v2, schemaVersion: 9 }),
    ).toThrowError(new DocumentationPlanBindingError("unknown-plan-variant"));
  });

  it("refuses to reduce a V2 binding to a V1 identity", () => {
    const v2 = createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA);
    // The V1 validator does not recognize the extra source field, so a V2
    // binding can never be silently recorded under a V1 digest.
    expect(() => validateDocumentationPlanBinding(v2)).toThrowError(DocumentationPlanBindingError);
  });

  it("keeps the same write paths for both variants", () => {
    expect(documentationPlanWritePaths(createDocumentationPlanBinding(PLAN))).toEqual([
      "docs/guide.md",
    ]);
    expect(
      documentationPlanWritePaths(
        createSourceAwareDocumentationPlanBinding(PLAN, SOURCE_BINDING_SHA),
      ),
    ).toEqual(["docs/guide.md"]);
  });
});

describe("source-aware documentation run through the real workflow (#835)", () => {
  const SOURCE_REVISION = "f".repeat(40);
  const SOURCE_REPOSITORY_PATH = "/tmp/repository";
  const SOURCE_WORKSPACE_IDENTITY = createHash("sha256").update("ws-835").digest("hex");
  const SOURCE_CONTENT_DIGEST = createHash("sha256").update("content-835").digest("hex");
  const SOURCE_PRODUCER_SCOPE = createHash("sha256").update("scope-835").digest("hex");
  const SOURCE_PRODUCER_SCOPES = [
    { producerId: "workspace-tracked-files", scopeSha256: SOURCE_PRODUCER_SCOPE },
  ];
  const SOURCE_POLICY = createSourceStepPolicy({
    // The planner reads sources, then the writer has evidence for the
    // required-coverage gate, as in the real step ordering.
    sourceReadSkills: ["plan-documentation", "write-documentation"],
    perStepBudgetBytes: 8 * 1024,
  });
  const sourceSha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const SOURCE_HTML = new Uint8Array(
    readFileSync(new URL("./fixtures/source-evidence/html/release-notes.html", import.meta.url)),
  );

  async function buildSourceEvidence(
    input = {
      sourcePath: SOURCE_REPOSITORY_PATH,
      revision: SOURCE_REVISION,
      workspacePath: "/tmp/docsfab-workspace/repository",
    },
  ) {
    const runId = "target-bound-run";
    const repository = {
      identitySha256: createHash("sha256").update(input.sourcePath).digest("hex"),
      revision: input.revision,
    };
    const requestSha256 = projectSourceRequestContext(
      {
        workflow: "create-documentation",
        workspacePath: input.workspacePath,
        repository: {
          sourcePath: input.sourcePath,
          requestedRevision: input.revision,
          revision: input.revision,
        },
        allowWrite: true,
        instruction: targetBoundRequest().instruction,
        knowledgeResumeReceipt: targetReceipt(),
      },
      { runId, workspaceIdentitySha256: SOURCE_WORKSPACE_IDENTITY, repository },
    );
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: SOURCE_HTML,
      mediaType: "text/html",
    });
    const observation = createSourceObservation({
      observationId: "obs-release-notes",
      originIdSha256: sourceSha("origin"),
      inputId: "input-release-notes",
      registrationSha256: sourceSha("registration"),
      runIdSha256: sourceSha(runId),
      repository,
      requestSha256,
      producerId: "workspace-tracked-files",
      producerVersion: "1",
      producerScopeSha256: SOURCE_PRODUCER_SCOPE,
      acquisitionReceiptSha256: sourceSha("receipt"),
      observedAt: "2026-09-14T18:00:00.000Z",
      original: {
        sha256: createHash("sha256").update(SOURCE_HTML).digest("hex"),
        byteLength: SOURCE_HTML.byteLength,
        mediaType: "text/html",
        locatorSha256: sourceSha("docs/release-notes.html"),
        version: { kind: "repository-revision", revision: input.revision },
        repositoryPath: "docs/release-notes.html",
      },
      representations: [representation],
    });
    const sourceBinding = createSourceBinding({
      runIdSha256: sourceSha(runId),
      repository,
      requestSha256,
      hostPolicySha256: SOURCE_POLICY.policySha256,
      producerScopeSha256: digestSourceProducerScopes(SOURCE_PRODUCER_SCOPES),
      parentBindingSha256: null,
      observations: [
        { observationId: "obs-release-notes", observationSha256: observation.observationSha256 },
      ],
      requiredObservationIds: ["obs-release-notes"],
    });
    const capture = openExternalInputAccessCapture({
      runIdSha256: sourceSha(runId),
      repository,
    });
    const { contentDigestSha256 } = registerFakeExternalInput(capture, observation.inputId, {
      adapterKind: "repository-document",
      canonicalLocator: "repository-document:docs/release-notes.html",
      safeTitle: "Release notes",
      body: Buffer.from(derivative).toString("utf8"),
      version: { kind: "repository-revision", revision: SOURCE_REVISION },
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    const service = createSourceEvidenceService(
      createSourceEvidenceHostAuthority({
        verifyCurrent: () => undefined,
        hostPolicySha256: SOURCE_POLICY.policySha256,
        producerScopes: SOURCE_PRODUCER_SCOPES,
        resolveBinding: (digest) =>
          digest === sourceBinding.bindingSha256 ? sourceBinding : undefined,
        resolveObservation: (id) => (id === observation.observationId ? observation : undefined),
        resolveDerivative: ({ representationId }) =>
          representationId === representation.representationId ? derivative : undefined,
        recordAccess: ({ stepId, spanIds }) =>
          recordExternalInputAccess(capture, {
            inputId: observation.inputId,
            stepId,
            outcome: "opened",
            observedContentDigestSha256: contentDigestSha256!,
            accessorId: "docsfab-read-source",
            evidenceSha256s: [sourceSha(spanIds.join(","))],
          }).observationSha256,
        now: () => new Date("2026-09-14T18:05:00.000Z"),
      }),
    );
    const reference = createSourceArtifactReference({
      kind: "source-binding",
      digest: sourceBinding.bindingSha256,
      repositoryRevision: input.revision,
      repositoryContentDigest: SOURCE_CONTENT_DIGEST,
    });
    return {
      reference,
      sourceBinding,
      representationId: representation.representationId,
      spanId: representation.spans[0]!.spanId,
      runnerBinding: {
        service,
        workspaceIdentitySha256: SOURCE_WORKSPACE_IDENTITY,
        repositoryContentDigest: SOURCE_CONTENT_DIGEST,
        policy: SOURCE_POLICY,
      },
    };
  }

  class SourceReadingHarness extends TargetPlanHarness {
    public readonly readSpans: string[] = [];
    public readonly sawReaderOn: string[] = [];
    public readonly sawReferenceOn: string[] = [];
    public writePrompt: string | undefined;

    public constructor(
      paths: readonly string[],
      private readonly selection: { representationId: string; spanId: string },
      private readonly readOnSkill: string | null,
    ) {
      super(paths);
    }

    public override async runStep(input: HarnessStepInput) {
      if (input.sourceReader) this.sawReaderOn.push(input.step.skill);
      if (input.sourceBinding) this.sawReferenceOn.push(input.step.skill);
      if (input.step.mode === "write") this.writePrompt = input.step.prompt;
      if (this.readOnSkill && input.step.skill === this.readOnSkill && input.sourceReader) {
        const read = input.sourceReader.read({
          observationId: "obs-release-notes",
          representationId: this.selection.representationId,
          spanIds: [this.selection.spanId],
        });
        this.readSpans.push(read.text);
      }
      return super.runStep(input);
    }
  }

  async function sourceAwareRunner(harness: AgentHarness, store: RunStore) {
    const sourceWorkspace = await prepareSourceAuthorityWorkspace();
    const evidence = await buildSourceEvidence({
      sourcePath: sourceWorkspace.sourcePath,
      revision: sourceWorkspace.revision,
      workspacePath: sourceWorkspace.path,
    });
    const sourceObserver = new LocalSourceObligationSourceObserver(sourceWorkspace);
    const artifactDirectory = await mkdtemp(join(tmpdir(), "docsfab-source-aware-artifacts-"));
    temporaryDirectories.push(artifactDirectory);
    const evidenceCollector = await GitPatchEvidenceCollector.create(
      sourceWorkspace.path,
      artifactDirectory,
    );
    activeEvidenceCollectors.push(evidenceCollector);
    const hostOperations = {
      runStep: async () => ({ summary: "Fixture native checks passed" }),
    };
    const authoringCandidateLifecycle = new LocalAuthoringCandidateLifecycle({
      workspace: sourceWorkspace,
      evidenceCollector,
      search: new LocalWorkflowSearchCoordinator(),
      sourceObserver,
      hostOperations,
      artifactDirectory,
    });
    const runner = new WorkflowRunner({
      ...scriptedEditorialProtocol(harness),
      hostOperations,
      store,
      repositoryScanner: new PassingScanner(),
      contextPreflight: readyContextPreflight,
      repositoryEvidence: evidenceCollector,
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      sourceObligationObserver: sourceObserver,
      authoringCandidateLifecycle,
      outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
      sourceEvidence: evidence.runnerBinding,
      id: () => "target-bound-run",
      now: () => new Date("2026-09-10T12:00:00.000Z"),
    });
    return {
      evidence,
      run: (request: RunRequest) =>
        runner.run({
          ...request,
          workspacePath: sourceWorkspace.path,
          repository: {
            sourcePath: sourceWorkspace.sourcePath,
            requestedRevision: sourceWorkspace.revision,
            revision: sourceWorkspace.revision,
          },
        }),
    };
  }

  it("drives a real workflow through the seam and seals a V2 plan binding", async () => {
    const selection = await buildSourceEvidence();
    const harness = new SourceReadingHarness(
      ["docs/reference/cli.mdx"],
      { representationId: selection.representationId, spanId: selection.spanId },
      "plan-documentation",
    );
    const store = new MemoryStore();
    const runtime = await sourceAwareRunner(harness, store);

    const record = await runtime.run({
      ...targetBoundRequest(),
      sourceBinding: runtime.evidence.reference,
    });

    expect(record.status).toBe("succeeded");
    expect(harness.sawReaderOn).toEqual(["plan-documentation", "write-documentation"]);
    expect(harness.readSpans).toHaveLength(1);
    expect(harness.readSpans[0]!.length).toBeGreaterThan(0);
    // The inert reference reaches every step, including ungranted ones.
    expect(harness.sawReferenceOn).toContain("verify-technical-accuracy");
    const planStep = record.steps.find((step) => step.skill === "plan-documentation");
    expect(planStep?.planBinding?.schemaVersion).toBe(2);
    expect(
      (planStep?.planBinding as { sourceBindingSha256?: string } | undefined)?.sourceBindingSha256,
    ).toBe(runtime.evidence.sourceBinding.bindingSha256);
    expect(validateSourceAwareDocumentationPlanBinding(planStep!.planBinding)).toEqual(
      planStep!.planBinding,
    );
    expect(harness.writerCalls).toBe(1);
  });

  it("reads a required source the planner never read into the write step", async () => {
    const selection = await buildSourceEvidence();
    const harness = new SourceReadingHarness(
      ["docs/reference/cli.mdx"],
      { representationId: selection.representationId, spanId: selection.spanId },
      null,
    );
    const store = new MemoryStore();
    const runtime = await sourceAwareRunner(harness, store);

    const record = await runtime.run({
      ...targetBoundRequest(),
      sourceBinding: runtime.evidence.reference,
    });

    expect(record.status, record.error).toBe("succeeded");
    expect(harness.sawReaderOn).toEqual(["plan-documentation", "write-documentation"]);
    expect(harness.readSpans).toEqual([]);
    expect(harness.writerCalls).toBe(1);
    // The writer's model received the source, by the span id the planner could have read.
    expect(harness.writePrompt).toContain("Required sources the host read for this step");
    expect(harness.writePrompt).toContain(`"observationId":"obs-release-notes"`);
    expect(harness.writePrompt).toContain(`"spanId":"${selection.spanId}"`);
  });

  it("keeps a no-source run on the V1 plan binding with no reader anywhere", async () => {
    const selection = await buildSourceEvidence();
    const harness = new SourceReadingHarness(
      ["docs/reference/cli.mdx"],
      { representationId: selection.representationId, spanId: selection.spanId },
      null,
    );
    const store = new MemoryStore();
    const runtime = await sourceAwareRunner(harness, store);

    const record = await runtime.run(targetBoundRequest());

    expect(record.status).toBe("succeeded");
    expect(harness.sawReaderOn).toEqual([]);
    expect(harness.sawReferenceOn).toEqual([]);
    expect(
      record.steps.find((step) => step.skill === "plan-documentation")?.planBinding?.schemaVersion,
    ).toBe(1);
  });
});

describe("plan binding canonical ordering (#835 coverage of the sort seam)", () => {
  // Every digest path normalizes page, source-binding, and source order. A
  // single-element plan never exercises those comparators, so this plan has two
  // of each.
  const SOURCE_BINDING_SHA = "e".repeat(64);

  const ascending = {
    mode: "create" as const,
    pages: [
      { path: "docs/a-guide.md", disposition: "create" as const },
      { path: "docs/b-guide.md", disposition: "create" as const },
    ],
    sourceBindings: [
      { pagePath: "docs/a-guide.md", sources: ["src/alpha.ts", "src/beta.ts"] },
      { pagePath: "docs/b-guide.md", sources: ["src/gamma.ts", "src/delta.ts"] },
    ],
  };
  const shuffled = {
    mode: "create" as const,
    pages: [
      { path: "docs/b-guide.md", disposition: "create" as const },
      { path: "docs/a-guide.md", disposition: "create" as const },
    ],
    sourceBindings: [
      { pagePath: "docs/b-guide.md", sources: ["src/delta.ts", "src/gamma.ts"] },
      { pagePath: "docs/a-guide.md", sources: ["src/beta.ts", "src/alpha.ts"] },
    ],
  };

  it("gives a V1 plan the same digest whatever order the planner emitted", () => {
    expect(documentationPlanBindingDigest(shuffled)).toBe(
      documentationPlanBindingDigest(ascending),
    );
    const sealed = createDocumentationPlanBinding(shuffled);
    expect(sealed.pages.map((page) => page.path)).toEqual(["docs/a-guide.md", "docs/b-guide.md"]);
    expect(sealed.sourceBindings.map((entry) => entry.pagePath)).toEqual([
      "docs/a-guide.md",
      "docs/b-guide.md",
    ]);
    expect(sealed.sourceBindings[0]!.sources).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(sealed.sourceBindings[1]!.sources).toEqual(["src/delta.ts", "src/gamma.ts"]);
  });

  it("gives a V2 plan the same digest whatever order the planner emitted", () => {
    expect(
      documentationPlanBindingV2Digest({ ...shuffled, sourceBindingSha256: SOURCE_BINDING_SHA }),
    ).toBe(
      documentationPlanBindingV2Digest({
        ...ascending,
        sourceBindingSha256: SOURCE_BINDING_SHA,
      }),
    );
    const sealed = createSourceAwareDocumentationPlanBinding(shuffled, SOURCE_BINDING_SHA);
    expect(sealed.pages.map((page) => page.path)).toEqual(["docs/a-guide.md", "docs/b-guide.md"]);
    expect(sealed.sourceBindings[0]!.sources).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(validateSourceAwareDocumentationPlanBinding(sealed)).toEqual(sealed);
  });

  it("still separates a multi-page V1 digest from its V2 counterpart", () => {
    expect(
      documentationPlanBindingV2Digest({ ...ascending, sourceBindingSha256: SOURCE_BINDING_SHA }),
    ).not.toBe(documentationPlanBindingDigest(ascending));
  });

  it("reorders sources inside a validated multi-source plan", () => {
    // validateDocumentationPlanContent's comparator runs only when a page binds
    // more than one source.
    const validated = bindDocumentationPlanProposal({
      kind: "docsfab-documentation-plan",
      schemaVersion: 1,
      ...shuffled,
      digest: documentationPlanBindingDigest(shuffled),
    });
    expect(validated.sourceBindings[1]!.sources).toEqual(["src/delta.ts", "src/gamma.ts"]);
    expect(documentationPlanWritePaths(validated)).toEqual(["docs/a-guide.md", "docs/b-guide.md"]);
  });

  it("refuses an admitted binding whose variant is unrecognized", () => {
    // The unknown-variant arm of admittedDocumentationPlanBindingSha256.
    const sealed = createSourceAwareDocumentationPlanBinding(ascending, SOURCE_BINDING_SHA);
    expect(admittedDocumentationPlanBindingSha256(sealed)).toBe(sealed.digest);
    expect(() =>
      admittedDocumentationPlanBindingSha256({
        ...createDocumentationPlanBinding(ascending),
        schemaVersion: 7,
      } as never),
    ).toThrowError(new DocumentationPlanBindingError("unknown-plan-variant"));
  });
});

describe("repository-required checks before an update proposal (#848)", () => {
  const CORRECTED_CLI = PILOT_CLI.corrected;

  function pilotPlan() {
    const mode = "update" as const;
    const pages = [{ path: "docs/cli.md", disposition: mode }];
    const sourceBindings = [{ pagePath: "docs/cli.md", sources: [PILOT_CLI.source] }];
    return {
      kind: "docsfab-documentation-plan" as const,
      schemaVersion: 1 as const,
      mode,
      pages,
      sourceBindings,
      digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
    };
  }

  class PilotUpdateHarness implements AgentHarness {
    public readonly calls: string[] = [];

    public constructor(private readonly plannerStops = false) {}

    public async runStep(input: HarnessStepInput) {
      this.calls.push(input.step.id);
      if (input.step.id === "plan-documentation") {
        if (this.plannerStops) {
          return { summary: RECORDED_PLANNER_STOP, outcome: "needs-input" as const };
        }
        return {
          summary: `Update docs/cli.md to the current ${PILOT_CLI.currentOption} option. Validation: repository-required ${PILOT_REQUIRED_CHECK} before proposing.`,
          ...(await verificationFixture(input)),
          planBinding: pilotPlan(),
        };
      }
      if (input.step.id === "write-documentation") {
        await writeFile(join(input.repositoryPath, "docs", "cli.md"), CORRECTED_CLI, "utf8");
        // A model claim of success is never check evidence.
        return { summary: `Updated docs/cli.md. ${PILOT_REQUIRED_CHECK} passed.` };
      }
      return {
        summary:
          input.step.skill === "review-documentation"
            ? canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd()
            : `${input.step.id} completed from the deterministic harness`,
        ...(await verificationFixture(input)),
      };
    }
  }

  async function pilotRun(input: {
    harness: PilotUpdateHarness;
    hostOperations: (workspace: RepositoryWorkspace) => HostOperationExecutor;
    projectOutcome?: boolean;
    afterPatchCaptured?: (workspace: RepositoryWorkspace) => Promise<void>;
    /** Files that replace the pilot head's, committed before the export; text is UTF-8. */
    headFiles?: Record<string, string | Uint8Array>;
    templateSet?: TemplateSetCapability;
  }) {
    const { root, repository } = await materializePilotHead();
    temporaryDirectories.push(root);
    if (input.headFiles) {
      for (const [path, content] of Object.entries(input.headFiles)) {
        await writeFile(join(repository, path), content);
      }
      await commitFixture(repository, "pilot head under test");
    }
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    activeSourceWorkspaces.push(workspace);
    const artifactDirectory = await mkdtemp(join(tmpdir(), "docsfab-848-artifacts-"));
    temporaryDirectories.push(artifactDirectory);
    const evidenceCollector = await GitPatchEvidenceCollector.create(
      workspace.path,
      artifactDirectory,
    );
    activeEvidenceCollectors.push(evidenceCollector);
    const repositoryEvidence = input.afterPatchCaptured
      ? {
          capture: async (context: RepositoryEvidenceContext) => {
            const evidence = await evidenceCollector.capture(context);
            if (context.persistPatch) await input.afterPatchCaptured!(workspace);
            return evidence;
          },
        }
      : evidenceCollector;
    const modelInputs = { request: await documentationUpdateRequest() };
    const protocol = scriptedEditorialProtocol(input.harness);
    const runner = new WorkflowRunner({
      ...protocol,
      hostOperations: input.hostOperations(workspace),
      store: new MemoryStore(),
      repositoryScanner: new PassingScanner(),
      contextPreflight: readyContextPreflight,
      repositoryEvidence,
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
      ...(input.projectOutcome === false
        ? {}
        : { outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector() }),
      id: () => "pilot-848-run",
      now: () => new Date("2026-09-22T12:00:00.000Z"),
      ...(input.templateSet ? { templateSet: input.templateSet } : {}),
    });
    const record = await runner.run({
      workflow: "update-documentation",
      workspacePath: workspace.path,
      repository: {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.revision,
        revision: workspace.revision,
      },
      instruction: modelInputs.request,
      allowWrite: true,
    });
    return { record, workspace, decodeOptions: protocol.decodeOptions };
  }

  function checksWith(authority: CheckCommandAuthority) {
    return (workspace: RepositoryWorkspace) =>
      new WorkflowChecksHostOperation(workspace, "lint-documentation", {
        prepareAuthority: async () => authority,
      });
  }

  /** The human footer and the `--json` result a finished run prints. */
  function operatorSurfaces(record: RunRecord, decodeOptions: WorkflowOutcomeDecodeOptionsV1) {
    const context = {
      record,
      recordPath: "/tmp/state/runs/pilot-848-run.json",
      exitCode: 0 as const,
      repositoryPath: "/tmp/repo",
      editorialDecodeOptions: decodeOptions,
    };
    return {
      summary: formatRunSummary({ ...context, tty: false, ci: false, noColor: true }),
      result: buildRunResultV1(context),
    };
  }

  /**
   * Drives the `--draft-mr` delivery entry point with its GitLab side effects
   * replaced, and returns the steps it reached for this run.
   */
  async function deliverAsDraftMr(record: RunRecord): Promise<string[]> {
    const reached: string[] = [];
    await submitAfterSucceededRun(
      record,
      mintHostJobEnvelope(record.id, { source: "cli-argv", allowWrite: true, draftMr: true }),
      {
        cwd: "/tmp",
        repositoryPath: "/tmp/repo",
        stateDirectory: "/tmp/state/runs",
        preflight: (async (plan: { runId: string }) => {
          reached.push(`preflight ${plan.runId}`);
          return { sha256: "a".repeat(64) };
        }) as never,
        execute: (async (args: readonly string[]) => {
          reached.push(`execute ${args[0]}`);
          return {
            mergeRequest: {
              iid: 1,
              url: "https://gitlab.example.invalid/docs/-/merge_requests/1",
              draft: true,
              headRevision: "b".repeat(40),
            },
          };
        }) as never,
      },
    );
    return reached;
  }

  it("honors a validation-prerequisite stop before any writer or check", async () => {
    const harness = new PilotUpdateHarness(true);
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { record, workspace } = await pilotRun({
      harness,
      hostOperations: checksWith(authority),
      projectOutcome: false,
    });

    expect(record.status, record.error).toBe("needs-input");
    expect(harness.calls).toEqual(["plan-documentation"]);
    expect(authority.calls).toEqual([]);
    expect(record.changes?.files ?? []).toEqual([]);
    expect(record.steps[0]?.summary).toContain(PILOT_REQUIRED_CHECK);
    expect(await readFile(join(workspace.path, "docs", "cli.md"), "utf8")).toContain(
      PILOT_CLI.staleOption,
    );
  });

  it("reaches the actual required check under isolated authority before the update is proposed", async () => {
    const harness = new PilotUpdateHarness();
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { record, workspace, decodeOptions } = await pilotRun({
      harness,
      hostOperations: checksWith(authority),
    });

    // A passing check is unchanged by #1918: no limitation, and delivery proceeds.
    expect(record.evidenceWarnings ?? []).toEqual([]);
    const { summary, result } = operatorSurfaces(record, decodeOptions);
    expect(summary.join("\n")).not.toContain("required check could not run");
    expect(result.product.limitations).not.toContain("required-check-not-run");
    expect(result.nextSteps.join("\n")).not.toContain("required check could not run");
    await expect(deliverAsDraftMr(record)).resolves.toEqual([
      "preflight pilot-848-run",
      "execute pilot-848-run",
    ]);

    expect(record.status, record.error).toBe("succeeded");
    expect(authority.calls).toEqual([
      {
        executable: "/fixture/bin/python3",
        argv: ["-m", "unittest", "discover", "-s", "tests"],
        cwd: resolve(workspace.path, "."),
      },
    ]);
    const stepIds = record.steps.map((step) => step.id);
    const lint = record.steps.find((step) => step.id === "lint-documentation");
    expect(stepIds.indexOf("write-documentation")).toBeLessThan(
      stepIds.indexOf("lint-documentation"),
    );
    expect(lint).toMatchObject({ kind: "host-operation", status: "succeeded" });
    const evidence = JSON.parse(lint!.summary!);
    expect(evidence.snapshotSha256).toBe((await observeCheckedSnapshot(workspace.path)).sha256);
    expect(evidence.checks).toEqual([
      expect.objectContaining({ command: PILOT_REQUIRED_CHECK, required: true, status: "passed" }),
    ]);
    expect(record.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(await readFile(join(workspace.path, "docs", "cli.md"), "utf8")).toBe(CORRECTED_CLI);
  });

  it("gives the writer template guidance from the base page and audits the candidate after it", async () => {
    class GuidanceHarness extends PilotUpdateHarness {
      public readonly guidance = new Map<string, HarnessStepInput["pageTemplateGuidance"]>();

      public override async runStep(input: HarnessStepInput) {
        this.guidance.set(input.step.id, input.pageTemplateGuidance);
        return super.runStep(input);
      }
    }
    const harness = new GuidanceHarness();
    const templates = await prepareTemplateSet(resolve(import.meta.dirname, ".."));
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { record } = await pilotRun({
      harness,
      templateSet: templates,
      headFiles: {
        "docs/cli.md": `---\ntemplate: single-procedural\n---\n\n# ${PILOT_CLI.title}\n\nRun \`python3 -m ${PILOT_CLI.module} ${PILOT_CLI.staleOption} .\`.\n`,
      },
      hostOperations: (workspace) =>
        new WorkflowChecksHostOperation(workspace, "lint-documentation", {
          prepareAuthority: async () => authority,
          templates,
        }),
    });

    expect(record.status, record.error).toBe("succeeded");
    // The planner names no page before it plans, so it reads no guidance.
    expect(harness.guidance.get("plan-documentation")).toBeUndefined();
    // The writer's base page declares its template, which wins over the path.
    const writer = harness.guidance.get("write-documentation");
    expect(writer?.pages).toEqual([
      {
        path: "docs/cli.md",
        status: "mapped",
        templateId: "single-procedural-gfm",
        basis: "frontmatter",
        signal: "template: single-procedural",
      },
    ]);
    expect(writer?.templates.map((template) => template.templateId)).toEqual([
      "single-procedural-gfm",
    ]);
    // The candidate dropped the declaration, so the advisory audit cannot map
    // it, and the check status stays the required check's own.
    const lint = JSON.parse(
      record.steps.find((step) => step.id === "lint-documentation")!.summary!,
    );
    expect(lint.status).toBe("passed");
    expect(decodeTemplateAuditReport(lint.templateConformance).pages).toEqual([
      { path: "docs/cli.md", status: "unmapped", reason: "no-template-signal", candidates: [] },
    ]);
  });

  it("gives the writer the read refusal, not a path guess, for a base page it cannot read", async () => {
    class GuidanceHarness extends PilotUpdateHarness {
      public readonly guidance = new Map<string, HarnessStepInput["pageTemplateGuidance"]>();

      public override async runStep(input: HarnessStepInput) {
        this.guidance.set(input.step.id, input.pageTemplateGuidance);
        return super.runStep(input);
      }
    }
    const harness = new GuidanceHarness();
    const templates = await prepareTemplateSet(resolve(import.meta.dirname, ".."));
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { record } = await pilotRun({
      harness,
      templateSet: templates,
      headFiles: {
        // The page declares its template, but one byte is not valid UTF-8, so
        // the host refuses to read it and cannot see the declaration.
        "docs/cli.md": Buffer.concat([
          Buffer.from(
            `---\ntemplate: single-procedural\n---\n\n# ${PILOT_CLI.title}\n\nRun `,
            "utf8",
          ),
          Buffer.from([0xff]),
          Buffer.from(`\`python3 -m ${PILOT_CLI.module} ${PILOT_CLI.staleOption} .\`.\n`, "utf8"),
        ]),
      },
      hostOperations: (workspace) =>
        new WorkflowChecksHostOperation(workspace, "lint-documentation", {
          prepareAuthority: async () => authority,
          templates,
        }),
    });

    expect(record.status, record.error).toBe("succeeded");
    // The refusal reaches the writer; no template is guessed from the path.
    const writer = harness.guidance.get("write-documentation");
    expect(writer?.pages).toEqual([
      { path: "docs/cli.md", status: "refused", code: "page-not-utf8" },
    ]);
    expect(writer?.templates).toEqual([]);
  });

  it("withholds the proposal for a check that ran and failed with unknown cause", async () => {
    const harness = new PilotUpdateHarness();
    const { record, decodeOptions } = await pilotRun({
      harness,
      hostOperations: checksWith(
        recordingAuthority({ status: "failed", exitCode: 1, output: "FAILED (failures=1)\n" }),
      ),
    });

    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/^required-check-failed: /u);
    expect(record.error).toContain("was not proposed");
    expect(record.error).toContain("docsfab runs show pilot-848-run");
    // The check ran on the candidate, but that alone cannot establish cause.
    expect(readRunFailure(record)).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "required-check-failed",
    });
    expect(record.evidenceWarnings ?? []).toEqual([]);
    expect(operatorSurfaces(record, decodeOptions).summary.join("\n")).not.toContain(
      "required check could not run",
    );
    // The retained patch remains inspectable; it is not delivered.
    expect(record.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(() => requirePublishableWritePatch(record)).toThrow(
      "Draft-MR publication requires a succeeded write run",
    );
  });

  const MAKE_DOCS_CHECK = {
    "AGENTS.md": `This fixture describes only the fictional ${PILOT_CLI.title}. Before proposing a change, run \`make docs-check\`.\n`,
    Makefile: "docs-check:\n\tgit archive --format=tar HEAD >/dev/null\n",
  };
  const NEXT_FROM_ROOT =
    "Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.";
  const NPM_LINT_DOCS = {
    "AGENTS.md": `This fixture describes only the fictional ${PILOT_CLI.title}. Before proposing a change, run \`npm run lint:docs\`.\n`,
    "package.json": `${JSON.stringify(
      {
        name: PILOT_CLI.packageName,
        private: true,
        scripts: { "lint:docs": "markdownlint-cli2 docs/cli.md" },
      },
      null,
      2,
    )}\n`,
  };
  /** A check the pre-flight stops must never reach the executor. */
  const NEVER_RUNS = {
    onRun: async () => {
      throw new Error("A required check that could not run reached the executor.");
    },
  };

  /**
   * The in-sandbox pre-flight resolver's contract on this host's files: the
   * first candidate that is an executable file. Its `PATH` is empty, so a
   * program installed on this host never stands in for the checked copy's own.
   */
  function preflightAuthority() {
    const lookups: string[][] = [];
    return {
      ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }, NEVER_RUNS),
      lookups,
      searchPath: [] as readonly string[],
      resolveExecutable: async (candidates: readonly string[]) => {
        lookups.push([...candidates]);
        for (const candidate of candidates) {
          try {
            await access(candidate, constants.X_OK);
            return candidate;
          } catch {
            /* Not installed here. */
          }
        }
        return undefined;
      },
    };
  }

  it.each([
    {
      name: "an unsupported check form",
      headFiles: {
        "AGENTS.md": `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`${PILOT_REQUIRED_CHECK}\` and \`ruff format .\` before proposing a documentation change.\n`,
      },
      checks: () =>
        checksWith(recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" })),
      limitation: `required check could not run: \`ruff format .\` (unsupported check form). ${NEXT_FROM_ROOT}`,
    },
    {
      name: "a program the executor cannot resolve",
      headFiles: undefined,
      checks: () =>
        checksWith({
          ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
          resolve: async () => undefined,
        }),
      limitation: `required check could not run: \`${PILOT_REQUIRED_CHECK}\` (dependency unavailable). ${NEXT_FROM_ROOT}`,
    },
    {
      name: "an npm script whose program is not installed",
      headFiles: NPM_LINT_DOCS,
      checks: () => checksWith(preflightAuthority()),
      limitation: `required check could not run: \`npm run lint:docs\` (dependency unavailable). ${NEXT_FROM_ROOT}`,
    },
    {
      name: "a link checker that needs the network",
      headFiles: {
        "AGENTS.md": `This fixture describes only the fictional ${PILOT_CLI.title}. Before proposing a change, run \`lychee docs/\`.\n`,
      },
      checks: () =>
        checksWith(
          recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }, NEVER_RUNS),
        ),
      limitation: `required check could not run: \`lychee docs/\` (network unavailable in the check sandbox). ${NEXT_FROM_ROOT}`,
    },
    {
      name: "no isolation backend on macOS",
      headFiles: undefined,
      checks: () => (workspace: RepositoryWorkspace) =>
        new WorkflowChecksHostOperation(workspace, "lint-documentation", {
          // The shipped default authority, on a host the platform selects as macOS.
          prepareAuthority: (repository) =>
            hostSelectedCheckAuthority(repository, {
              platform: "darwin",
              prepareDocker: async () => {
                throw new DockerCheckPreparationError(
                  "The pinned Docker image is unavailable.",
                  "unavailable",
                );
              },
            }),
        }),
      limitation: `required check could not run: \`${PILOT_REQUIRED_CHECK}\` (no check isolation on this host). ${NEXT_FROM_ROOT} Platform remedy: start Docker Desktop and load the pinned image with 'docker pull ${DARWIN_DOCKER_DESKTOP_IMAGE}', then start a new run on this Mac.`,
    },
    {
      name: "an isolation failure without a typed refusal",
      headFiles: undefined,
      checks: () => (workspace: RepositoryWorkspace) =>
        new WorkflowChecksHostOperation(workspace, "lint-documentation", {
          prepareAuthority: async (): Promise<CheckCommandAuthority> => {
            throw new Error(CHECK_ISOLATION_UNAVAILABLE);
          },
        }),
      limitation: `required check could not run: \`${PILOT_REQUIRED_CHECK}\` (no check isolation on this host). ${NEXT_FROM_ROOT} Platform remedy: to have DocsFab run the check, rerun on a host where the isolated check executor can run the command, for example Linux with working bubblewrap user namespaces and the named tool installed.`,
    },
    {
      name: "a make recipe whose program is not installed",
      headFiles: {
        "AGENTS.md": `This fixture describes only the fictional ${PILOT_CLI.title}. Before proposing a change, run \`make docs-check\`.\n`,
        Makefile: "docs-check:\n\tsphinx-build -M html docs _build\n",
      } as Record<string, string>,
      checks: () =>
        checksWith({
          ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }, NEVER_RUNS),
          searchPath: ["/usr/bin"],
          resolveExecutable: async (candidates) =>
            candidates.find((candidate) => candidate === "/usr/bin/make"),
          // Only the make dry run reaches this authority, as it would inside
          // the sandbox; running the check itself throws.
          run: async (_executable, argv) => {
            if (argv[0] !== "--dry-run") throw new Error("The make target ran.");
            return {
              status: "passed" as const,
              exitCode: 0,
              output: [
                "Makefile:1: target 'docs-check' does not exist",
                "sphinx-build -M html docs _build",
                "",
              ].join("\n"),
            };
          },
        }),
      limitation: `required check could not run: \`make docs-check\` (dependency unavailable). ${NEXT_FROM_ROOT}`,
    },
    {
      // #1932: a check stopped at its declared time limit is a limitation too.
      name: "the declared time limit",
      headFiles: undefined,
      checks: () =>
        checksWith({
          ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
          run: async () => ({
            status: "failed" as const,
            exitCode: null,
            output: "Building the documentation site\n",
            reason: "timeout" as const,
            timeoutMs: 600_000,
            elapsedMs: 600_213,
          }),
        }),
      limitation: `required check could not run: \`${PILOT_REQUIRED_CHECK}\` (it did not finish within the check time limit). ${NEXT_FROM_ROOT} Limit: checks-command-timeout-ms-bound: 600213 exceeds checks.commandTimeoutMs = 600000 ms. Run the check yourself before you merge the change, or raise DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS (up to 86400000 ms) so the check finishes in the isolated check executor. Follow the named remediation.`,
    },
  ])(
    "delivers the patch with a recorded limitation when $name keeps a required check from running (#1918)",
    async ({ headFiles, checks, limitation }) => {
      const harness = new PilotUpdateHarness();
      const { record, decodeOptions } = await pilotRun({
        harness,
        hostOperations: checks(),
        ...(headFiles ? { headFiles } : {}),
      });

      // Delivered: the write succeeds with its patch, and draft-MR delivery proceeds.
      expect(record.status, record.error).toBe("succeeded");
      expect(record.error).toBeUndefined();
      expect(record.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
      expect(record.changes?.patch?.byteLength).toBeGreaterThan(0);
      await expect(deliverAsDraftMr(record)).resolves.toEqual([
        "preflight pilot-848-run",
        "execute pilot-848-run",
      ]);
      // Never classed model content: the run records no failure at all.
      expect(readRunFailure(record)).toBeUndefined();
      expect(record.failure).toBeUndefined();
      // The run record names the command and the reason ...
      expect(record.evidenceWarnings).toEqual([limitation]);
      // ... and so do the operator summary and the --json result.
      const { summary, result } = operatorSurfaces(record, decodeOptions);
      const limitations = summary.indexOf("LIMITATIONS");
      expect(limitations, summary.join("\n")).toBeGreaterThan(-1);
      expect(summary.slice(limitations + 1).map((line) => line.trim())).toContain(limitation);
      expect(summary.join("\n")).not.toContain("FAILURE");
      expect(result.execution.status).toBe("succeeded");
      expect(result.product.limitations).toContain("required-check-not-run");
      expect(result.nextSteps).toContain(limitation);
    },
  );

  const RAN_AND_FAILED: ReadonlyArray<
    readonly [
      string,
      Record<string, string> | undefined,
      Pick<CheckCommandResult, "status" | "exitCode" | "output">,
    ]
  > = [
    [
      "a shell's exit 127 and command-not-found text",
      undefined,
      { status: "failed", exitCode: 127, output: "sh: 1: python3: not found\n" },
    ],
    [
      "a missing Python module",
      undefined,
      {
        status: "failed",
        exitCode: 1,
        output: `ModuleNotFoundError: No module named '${PILOT_CLI.moduleName}'\n`,
      },
    ],
    [
      "Git's not-a-repository text",
      MAKE_DOCS_CHECK,
      {
        status: "failed",
        exitCode: 2,
        output:
          "fatal: not a git repository (or any of the parent directories): .git\nmake: *** [Makefile:2: docs-check] Error 128\n",
      },
    ],
    [
      "a name-resolution failure",
      MAKE_DOCS_CHECK,
      {
        status: "failed",
        exitCode: 2,
        output:
          "curl: (6) Could not resolve host: example.com\nmake: *** [Makefile:2: docs-check] Error 6\n",
      },
    ],
  ];

  it.each(RAN_AND_FAILED)(
    "refuses a required check that ran and failed with %s, without inferred cause (#1918)",
    async (_name, headFiles, outcome) => {
      // The output reads like a missing tool, Git, or network, but the check
      // ran: only structural signals before a run make it a limitation.
      const { record, decodeOptions } = await pilotRun({
        harness: new PilotUpdateHarness(),
        hostOperations: checksWith(recordingAuthority(outcome)),
        ...(headFiles ? { headFiles } : {}),
      });

      expect(record.status).toBe("failed");
      expect(record.error).toMatch(/^required-check-failed: /u);
      expect(readRunFailure(record)).toEqual({
        class: "unknown",
        layer: "workflow",
        code: "required-check-failed",
      });
      expect(record.evidenceWarnings ?? []).toEqual([]);
      expect(operatorSurfaces(record, decodeOptions).summary.join("\n")).not.toContain(
        "required check could not run",
      );
      expect(() => requirePublishableWritePatch(record)).toThrow(
        "Draft-MR publication requires a succeeded write run",
      );
    },
  );

  /**
   * DocsFab's Git metadata over the checked copy, and each check run by the
   * real bounded executor on this host. The Linux sandbox runs the same
   * command inside bubblewrap, with the same metadata mounted read-only.
   */
  async function presentedGitAuthority(repository: string): Promise<CheckCommandAuthority> {
    const scratch = await mkdtemp(join(tmpdir(), "docsfab-1918-check-"));
    temporaryDirectories.push(scratch);
    await presentCheckedGitMetadata(repository, limit(CHECK_COMMAND_TIMEOUT_LIMIT).value);
    return {
      resolve: async (program) => (program === "make" ? "/usr/bin/make" : undefined),
      // The make pre-flight's dry run runs too: GNU make 4 lists the one-line
      // recipe and DocsFab finds `git` on this PATH; a make without `--trace`
      // fails the dry run. Either way the target runs.
      searchPath: String(checkSandboxEnvironment(process.execPath, scratch).PATH).split(":"),
      resolveExecutable: async (candidates) => {
        for (const candidate of candidates) {
          try {
            await access(candidate, constants.X_OK);
            return candidate;
          } catch {
            /* Not installed here. */
          }
        }
        return undefined;
      },
      run: (executable, argv, options) =>
        runBoundedCheckCommand(executable, [...argv], {
          cwd: options.cwd,
          env: checkSandboxEnvironment(process.execPath, scratch),
          timeoutMs: limit(CHECK_COMMAND_TIMEOUT_LIMIT).value,
          retainedOutputBytes: limit(CHECK_OUTPUT_RETAINED_LIMIT).value,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      cleanup: () => rm(join(repository, ".git"), { recursive: true, force: true }),
    };
  }

  it.each([
    ["passes", "docs/cli.md"],
    ["fails", "docs/retired.md"],
  ])(
    "runs a Make target that calls Git on the checked copy, and it %s on its merits (#1918)",
    async (outcome, path) => {
      // The Automodel shape: a required `make` target whose recipe asks Git
      // about the checked tree, which the workspace copy has no metadata for.
      const prepared: string[] = [];
      const { record, workspace } = await pilotRun({
        harness: new PilotUpdateHarness(),
        headFiles: {
          "AGENTS.md": `This fixture describes only the fictional ${PILOT_CLI.title}. Before proposing a change, run \`make docs-check\`.\n`,
          Makefile: `docs-check:\n\tgit ls-files --error-unmatch ${path}\n`,
        },
        hostOperations: (bound) =>
          new WorkflowChecksHostOperation(bound, "lint-documentation", {
            prepareAuthority: async (repository) => {
              prepared.push(repository);
              return presentedGitAuthority(repository);
            },
          }),
      });

      const lint = record.steps.find((step) => step.id === "lint-documentation");
      const [check] = JSON.parse(lint!.summary!).checks as Array<Record<string, unknown>>;
      // It ran: no could-not-run cause, whichever way it went.
      expect(check).not.toHaveProperty("cause");
      expect(record.evidenceWarnings ?? []).toEqual([]);
      if (outcome === "passes") {
        expect(record.status, record.error).toBe("succeeded");
        expect(check).toMatchObject({ command: "make docs-check", status: "passed", exitCode: 0 });
        // Git answered from the presented metadata, which holds the checked tree.
        expect(String(check!.output).split("\n")).toContain("docs/cli.md");
      } else {
        expect(record.status).toBe("failed");
        expect(readRunFailure(record)).toEqual({
          class: "unknown",
          layer: "workflow",
          code: "required-check-failed",
        });
        expect(check).toMatchObject({ command: "make docs-check", status: "failed", exitCode: 2 });
        expect(String(check!.output)).toContain(
          "error: pathspec 'docs/retired.md' did not match any file(s) known to git",
        );
      }
      // The metadata covered the checked copy only while its checks ran.
      expect(prepared).toEqual([workspace.path]);
      await expect(lstat(join(workspace.path, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    },
    // Real Git and Make processes beside the whole workflow run.
    testTimeoutMs(30_000),
  );

  it("keeps a run whose check sandbox could not be removed, and records why (#1918)", async () => {
    // A cleanup that fails, as a background Git process can make it, never
    // fails the run: the evidence records its code.
    const { record } = await pilotRun({
      harness: new PilotUpdateHarness(),
      hostOperations: checksWith({
        ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
        cleanup: async () => {
          throw Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
        },
      }),
    });
    expect(record.status, record.error).toBe("succeeded");
    expect(readRunFailure(record)).toBeUndefined();
    const lint = record.steps.find((step) => step.id === "lint-documentation");
    expect(JSON.parse(lint!.summary!)).toMatchObject({
      sandboxCleanup: { status: "failed", code: "ENOTEMPTY" },
      checks: [expect.objectContaining({ command: PILOT_REQUIRED_CHECK, status: "passed" })],
    });
    await expect(deliverAsDraftMr(record)).resolves.toEqual([
      "preflight pilot-848-run",
      "execute pilot-848-run",
    ]);
  });

  it("refuses stale and substituted check evidence even when the writer claims success", async () => {
    const stale = await pilotRun({
      harness: new PilotUpdateHarness(),
      hostOperations: (workspace) => {
        const checks = checksWith(
          recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
        )(workspace);
        return {
          runStep: async (stepInput: HarnessStepInput) => {
            const result = await checks.runStep(stepInput);
            // The proposed tree changes after the checks produced their evidence.
            await writeFile(
              join(workspace.path, "docs", "cli.md"),
              `${CORRECTED_CLI}\nLate edit.\n`,
            );
            return result;
          },
        };
      },
    });
    expect(stale.record.status).toBe("failed");
    expect(stale.record.error).toMatch(/^required-check-evidence-stale: /u);
    // Missing or stale check evidence is a contract-shape defect, not model content (#1918).
    expect(readRunFailure(stale.record)).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "required-check-evidence-stale",
    });

    const substituted = await pilotRun({
      harness: new PilotUpdateHarness(),
      hostOperations: () => ({
        runStep: async () => ({ summary: `Fixture native checks passed: ${PILOT_REQUIRED_CHECK}` }),
      }),
    });
    expect(substituted.record.status).toBe("failed");
    expect(substituted.record.error).toMatch(/^required-check-evidence-missing: /u);
    expect(readRunFailure(substituted.record)).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "required-check-evidence-missing",
    });
  });

  it("fails closed after patch capture when the final snapshot cannot be observed", async () => {
    const harness = new PilotUpdateHarness();
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { record } = await pilotRun({
      harness,
      hostOperations: checksWith(authority),
      projectOutcome: false,
      afterPatchCaptured: async (workspace) => {
        await rm(workspace.path, { recursive: true, force: true });
      },
    });

    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/^required-check-snapshot-unavailable: /u);
    expect(record.error).toContain("was not proposed");
    expect(readRunFailure(record)).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "required-check-snapshot-unavailable",
    });
    expect(record.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
  });

  it("keeps the no-change branch free of writes and checks while the author branch checks before evaluation", () => {
    const workflow = getWorkflow("update-documentation");
    if (!("branching" in workflow) || !workflow.branching) {
      throw new Error("update-documentation must declare its editorial branches.");
    }
    const branch = (id: string) =>
      workflow.branching!.branches.find((candidate) => candidate.id === id)!.steps;
    const noChange = branch("assess-no-change");
    expect(noChange.some((step) => step.mode === "write")).toBe(false);
    expect(noChange.some((step) => step.kind === "host-operation")).toBe(false);
    const author = branch("author").map((step) => `${step.id}:${step.kind}`);
    expect(author.indexOf("write-documentation:inference")).toBeLessThan(
      author.indexOf("lint-documentation:host-operation"),
    );
    expect(author.indexOf("lint-documentation:host-operation")).toBeLessThan(
      author.indexOf("evaluate-document-quality:evaluate"),
    );
  });
});
