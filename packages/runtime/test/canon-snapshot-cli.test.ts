// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { verificationFixture } from "./helpers/verification.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseRunArguments } from "../src/cli.js";
import {
  importCreateDocumentationCanonTask,
  importDocumentationCanonBinding,
} from "../src/cli/canon-snapshot.js";
import {
  inspectRequestedPageSupport,
  inspectSnapshotValue,
  isFirstPassSourceQuotationClaim,
} from "../src/cli/knowledge-resume.js";
import { usage } from "../src/cli/usage.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import type {
  RepositoryEvidenceContext,
  RepositoryEvidenceCollector,
} from "../src/repository/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  createKnowledgeAcceptedSnapshot,
  importFoundationCanonFromKnowledgeSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
} from "../src/canon/index.js";
import { normalizeWorkflowTaskInput } from "../src/workflow-contracts/task.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { LocalAuthoringCandidateLifecycle } from "../src/workflow-execution/authoring-runtime.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { initFixtureRepo } from "./helpers/git.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./fixtures/runtime-evaluation/fixtures/knowledge-accepted-snapshot.json",
);
// Recorded pilot request with no create/update/refresh/revise/write word.
const PILOT_CREATE_INSTRUCTION =
  "Add a concise configuration guide for operators using telemetryctl. Explain the configure command, its endpoint and output-format options, the default values, and what a successful invocation changes. Link it from the existing CLI documentation so a reader can find it. Ground every technical detail in the repository sources.";
const CANON_SHA256 = "d9fa679a1df1abf7b3f9ee8a9f44a8647dabb6306bed3f4a05ab8f7a7d10a727";
const REPOSITORY_REVISION = "f".repeat(40);
const REPOSITORY_IDENTITY = "a".repeat(64);

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class FakeHarness implements AgentHarness {
  public async runStep(input: HarnessStepInput) {
    if (input.step.id === "write-documentation") {
      await mkdir(join(input.repositoryPath, "docs"), { recursive: true });
      await writeFile(join(input.repositoryPath, "docs", "guide.md"), "# Canon fixture guide\n");
    }
    return {
      summary:
        input.step.skill === "review-documentation"
          ? canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd()
          : `ran ${input.step.skill}`,
      ...(await verificationFixture(input)),
      ...(input.step.id === "plan-documentation"
        ? {
            planBinding: documentationPlanBinding(),
          }
        : {}),
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
    };
  }
}

function documentationPlanBinding() {
  const pages = [{ path: "docs/guide.md", disposition: "create" as const }];
  const sourceBindings = [{ pagePath: "docs/guide.md", sources: ["src/api.ts:1"] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode: "create" as const,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
  };
}

class FakeScanner implements RepositorySecurityScanner {
  public async scan(): Promise<{
    ruleSet: string;
    status: "passed";
    scannedFiles: number;
    binaryFiles: number;
    findings: [];
  }> {
    return {
      ruleSet: "test-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    };
  }
}

class FakeEvidenceCollector implements RepositoryEvidenceCollector {
  public async capture(_context: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    return {
      files: [{ path: "docs/guide.md", status: "modified" }],
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

async function canonRunnerFixture(store: RunStore, runId: string) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-canon-source-authority-"));
  const repository = join(root, "repository");
  try {
    await initFixtureRepo(
      repository,
      { "src/api.ts": "export const api = true;\n" },
      { branch: "main", message: "canon source authority fixture" },
    );
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    const sourceObserver = new LocalSourceObligationSourceObserver(workspace);
    const artifactDirectory = await mkdtemp(join(tmpdir(), "docsfab-canon-artifacts-"));
    const evidenceCollector = await GitPatchEvidenceCollector.create(
      workspace.path,
      artifactDirectory,
    );
    const hostOperations = {
      runStep: async () => ({ summary: "Fixture native checks passed" }),
    };
    const authoringCandidateLifecycle = new LocalAuthoringCandidateLifecycle({
      workspace,
      evidenceCollector,
      search: new LocalWorkflowSearchCoordinator(),
      sourceObserver,
      hostOperations,
      artifactDirectory,
    });
    return {
      workspace,
      runner: new WorkflowRunner({
        harness: new FakeHarness(),
        hostOperations,
        store,
        repositoryScanner: new FakeScanner(),
        contextPreflight: readyContextPreflight,
        repositoryEvidence: new FakeEvidenceCollector(),
        workflowSearch: new LocalWorkflowSearchCoordinator(),
        sourceObligationObserver: sourceObserver,
        authoringCandidateLifecycle,
        id: () => runId,
        now: () => new Date("2026-08-20T12:00:00.000Z"),
      }),
      dispose: async () => {
        await evidenceCollector.dispose();
        await workspace.dispose();
        await rm(artifactDirectory, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

describe("create-documentation --canon-snapshot", () => {
  it("documents --canon-snapshot on create-documentation usage text", () => {
    expect(usage()).toMatch(/create-documentation[\s\S]*--canon-snapshot <json>/u);
  });

  it("parses --canon-snapshot only for create-documentation", () => {
    expect(
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved task guide.",
        "--allow-write",
        "--canon-snapshot",
        fixturePath,
      ]),
    ).toMatchObject({
      workflow: "create-documentation",
      canonSnapshotPath: fixturePath,
    });
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--canon-snapshot",
        fixturePath,
      ]),
    ).toThrow("only valid with create-documentation or update-documentation");
    expect(() =>
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved task guide.",
        "--allow-write",
        "--canon-snapshot",
        fixturePath,
        "--canon-snapshot",
        fixturePath,
      ]),
    ).toThrow("must not be duplicated");
  });

  it("imports the approved synthetic fixture to the known canonSha256", async () => {
    const snapshot = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const canon = importFoundationCanonFromKnowledgeSnapshot(snapshot);
    expect(canon.canonSha256).toBe(CANON_SHA256);

    const task = await importCreateDocumentationCanonTask(fixturePath);
    expect(task).toEqual({ kind: "create-documentation", canonSha256: CANON_SHA256 });
    expect(
      normalizeWorkflowTaskInput({
        workflow: "create-documentation",
        task,
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REPOSITORY_REVISION },
        allowWrite: true,
      }),
    ).toEqual(task);
  });

  it("records the imported canonSha256 on the create-documentation run record", async () => {
    const task = await importCreateDocumentationCanonTask(fixturePath);
    const store = new MemoryStore();
    const fixture = await canonRunnerFixture(store, "canon-snapshot-run-1");
    let record: RunRecord;
    try {
      record = await fixture.runner.run({
        workflow: "create-documentation",
        workspacePath: fixture.workspace.path,
        repository: {
          sourcePath: fixture.workspace.sourcePath,
          requestedRevision: fixture.workspace.revision,
          revision: fixture.workspace.revision,
        },
        instruction: "Create the approved task guide.",
        task,
        allowWrite: true,
      });
    } finally {
      await fixture.dispose();
    }

    expect(record.status, record.error).toBe("succeeded");
    expect(record.task).toEqual({
      kind: "create-documentation",
      canonSha256: CANON_SHA256,
    });
    expect(store.records.at(-1)?.task).toEqual(record.task);
  });

  it("documents and parses --accept-candidate-snapshot with --authority-id", () => {
    expect(usage()).toMatch(/--accept-candidate-snapshot --authority-id <id>/u);
    expect(
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved task guide.",
        "--allow-write",
        "--canon-snapshot",
        fixturePath,
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator-test",
      ]),
    ).toMatchObject({
      workflow: "create-documentation",
      canonSnapshotPath: fixturePath,
      acceptCandidateSnapshot: true,
      canonSnapshotAuthorityId: "operator-test",
    });
    expect(() =>
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved task guide.",
        "--allow-write",
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator-test",
      ]),
    ).toThrow("requires a --canon-snapshot");
    expect(() =>
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved task guide.",
        "--allow-write",
        "--canon-snapshot",
        fixturePath,
        "--accept-candidate-snapshot",
      ]),
    ).toThrow("requires an --authority-id");
  });

  it("host-accepts a candidate snapshot and records canonSha256 on the run", async () => {
    const snapshot = createKnowledgeAcceptedSnapshot({
      projectId: "PRJ-001",
      modelVersionId: "MODEL-001",
      streamVersion: 6,
      status: "candidate",
      claims: [
        {
          id: "CL-001",
          kind: "intent",
          scope: "Example Product",
          statement:
            "The knowledge-gathering workflow establishes a shared model before documentation generation.",
          modelState: "canonical",
          evidenceIds: ["SRC-001"],
        },
      ],
      sources: [{ id: "SRC-001", locator: "design" }],
      conflicts: [],
    } satisfies KnowledgeAcceptedSnapshotBodyV1);
    const directory = await mkdtemp(join(tmpdir(), "docsfab-candidate-snapshot-"));
    const candidatePath = join(directory, "candidate.json");
    const candidateBytes = JSON.stringify(snapshot);
    await writeFile(candidatePath, candidateBytes, "utf8");

    await expect(importCreateDocumentationCanonTask(candidatePath)).rejects.toThrow(
      "requires --accept-candidate-snapshot",
    );
    const expected = importFoundationCanonFromKnowledgeSnapshot(snapshot, {
      authorityId: "operator-test",
    });
    const task = await importCreateDocumentationCanonTask(candidatePath, {
      authorityId: "operator-test",
    });
    expect(task).toEqual({ kind: "create-documentation", canonSha256: expected.canonSha256 });

    const store = new MemoryStore();
    const fixture = await canonRunnerFixture(store, "canon-snapshot-run-candidate-1");
    let record: RunRecord;
    try {
      record = await fixture.runner.run({
        workflow: "create-documentation",
        workspacePath: fixture.workspace.path,
        repository: {
          sourcePath: fixture.workspace.sourcePath,
          requestedRevision: fixture.workspace.revision,
          revision: fixture.workspace.revision,
        },
        instruction: "Create the candidate task guide.",
        task,
        allowWrite: true,
      });
    } finally {
      await fixture.dispose();
    }
    expect(record.status, record.error).toBe("succeeded");
    expect(record.task).toEqual(task);
    expect(store.records.at(-1)?.task).toEqual(task);
    expect(await readFile(candidatePath, "utf8")).toBe(candidateBytes);
  });

  it("does not host-accept a README-heading candidate snapshot without operator flags", async () => {
    const snapshot = createKnowledgeAcceptedSnapshot(readmeHeadingCandidateBody());
    const directory = await mkdtemp(join(tmpdir(), "docsfab-readme-heading-snapshot-"));
    const candidatePath = join(directory, "candidate.json");
    await writeFile(candidatePath, JSON.stringify(snapshot), "utf8");

    expect(snapshot.claims.every((claim) => isFirstPassSourceQuotationClaim(claim.statement))).toBe(
      true,
    );
    await expect(importCreateDocumentationCanonTask(candidatePath)).rejects.toThrow(
      "requires --accept-candidate-snapshot",
    );
  });

  it("stops an intent-bearing About page when candidate claims are only README headings", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(readmeHeadingCandidateBody());
    const inspection = inspectRequestedPageSupport(
      snapshot,
      "Create an About page that states the product purpose.",
    );
    expect(inspection.disposition).toBe("needs-input");
    expect(inspection.stopReason).toBe("insufficient-evidence");
  });

  it("continues a path-less ordinary create instead of treating a missing .md token as unsupported", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(readmeHeadingCandidateBody());
    const inspection = inspectRequestedPageSupport(snapshot, "Create a get-started page.");
    expect(inspection.disposition).toBe("continue");
    expect(inspection.stopReason).toBeUndefined();
  });

  it("continues the recorded verb-free create request from a candidate snapshot", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(readmeHeadingCandidateBody());
    const inspection = inspectRequestedPageSupport(snapshot, PILOT_CREATE_INSTRUCTION);
    expect(inspection.disposition).toBe("continue");
    expect(inspection.stopReason).toBeUndefined();
  });

  it.each([
    ["Create docs/a.md and docs/b.md.", "continue"],
    ["Using docs/src.md, create docs/a.md and docs/b.md.", "continue"],
    ["Create docs/a.md using docs/src.md.", "needs-input"],
    ["Review docs/a.md and docs/b.md and update whatever is stale.", "needs-input"],
    // A source or exclusion named before the operation is not an output.
    ["Using docs/src.md, create docs/a.md.", "needs-input"],
    ["Based on docs/src.md, create docs/a.md.", "needs-input"],
    ["Use docs/src.md as context and create docs/a.md.", "needs-input"],
    ["Consulting docs/src.md, update docs/a.md.", "needs-input"],
    ["Do not change docs/old.md. Create docs/a.md.", "needs-input"],
    ["Keep docs/old.md unchanged and create docs/a.md.", "needs-input"],
    // Without an operation word no named page is an output; the parser asks too.
    ["Add docs/a.md and docs/b.md.", "needs-input"],
  ] as const)(
    "counts only pages after the operation in %s for the legacy disposition",
    (instruction, disposition) => {
      const snapshot = createKnowledgeAcceptedSnapshot(readmeHeadingCandidateBody());
      const inspection = inspectRequestedPageSupport(snapshot, instruction);
      expect(inspection.disposition).toBe(disposition);
      expect(inspection.stopReason).toBe(
        disposition === "needs-input" ? "insufficient-evidence" : undefined,
      );
    },
  );

  it("imports a candidate --canon-snapshot for the recorded verb-free create request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docsfab-verb-free-canon-"));
    try {
      const snapshot = createKnowledgeAcceptedSnapshot(readmeHeadingCandidateBody());
      const candidatePath = join(directory, "candidate.json");
      await writeFile(candidatePath, JSON.stringify(snapshot), "utf8");
      const hostAccept = { authorityId: "operator-test" };

      const binding = await importDocumentationCanonBinding(
        candidatePath,
        "create-documentation",
        PILOT_CREATE_INSTRUCTION,
        hostAccept,
      );
      expect(binding.task.kind).toBe("create-documentation");

      await expect(
        importDocumentationCanonBinding(
          candidatePath,
          "create-documentation",
          "Create docs/a.md using docs/src.md.",
          hostAccept,
        ),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "insufficient-evidence" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues a fully bounded request covered by attributed behavior claims (#271)", () => {
    const statement = "The widget --version command prints the installed version.";
    const snapshot = createKnowledgeAcceptedSnapshot({
      projectId: "PRJ-001",
      modelVersionId: "MODEL-001",
      streamVersion: 6,
      status: "candidate",
      claims: [
        {
          id: "CL-001",
          kind: "behavior",
          scope: "Example Product",
          statement,
          modelState: "candidate",
          evidenceIds: ["SRC-001"],
        },
      ],
      sources: [{ id: "SRC-001", locator: "readme:README.md" }],
      conflicts: [],
    } satisfies KnowledgeAcceptedSnapshotBodyV1);
    const inspection = inspectRequestedPageSupport(
      snapshot,
      [
        "Write `docs/get-started.md` using only these repository-observed behavior claims:",
        `- ${statement}`,
      ].join("\n"),
    );
    expect(inspection.disposition).toBe("continue");
    expect(inspection.stopReason).toBeUndefined();
  });

  it.each(["create-documentation", "update-documentation"] as const)(
    "imports %s with an exact target-scoped advisory receipt",
    async (workflow) => {
      const directory = await mkdtemp(join(tmpdir(), "docsfab-advisory-snapshot-"));
      const snapshot = createKnowledgeAcceptedSnapshot(classifiedConflictBody());
      const snapshotPath = join(directory, "snapshot.json");
      await writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");
      const instruction = [
        "Write `docs/reference/cli.mdx` using only these repository-observed behavior claims:",
        "- The widget --version command prints the installed version.",
      ].join("\n");

      const binding = await importDocumentationCanonBinding(snapshotPath, workflow, instruction);

      expect(binding.task.kind).toBe(workflow);
      expect(binding.knowledgeResumeReceipt).toMatchObject({
        snapshotSha256: snapshot.snapshotSha256,
        selectedTargetPath: "docs/reference/cli.mdx",
        advisoryConflicts: [
          {
            conflictId: "CF-ABOUT",
            claimIds: ["CL-ABOUT-1", "CL-ABOUT-2"],
            impact: "load-bearing",
            blockingDocumentationPaths: ["docs/about/product.md"],
          },
        ],
      });
      expect(snapshot.claims.filter((claim) => claim.modelState === "disputed")).toHaveLength(2);

      await expect(
        importDocumentationCanonBinding(
          snapshotPath,
          workflow,
          instruction.replace("docs/reference/cli.mdx", "docs/about/product.md"),
        ),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "conflict" });
      await expect(
        importDocumentationCanonBinding(snapshotPath, workflow, "Update the CLI guide."),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "conflict" });
    },
  );

  it("keeps unrelated unresolved claims blocking and excludes advisory variants from support", () => {
    const body = classifiedConflictBody();
    const unresolvedSnapshot = createKnowledgeAcceptedSnapshot({
      ...body,
      claims: [
        ...body.claims,
        {
          id: "CL-SEPARATE",
          kind: "behavior",
          scope: "CLI",
          statement: "The widget config command prints the active profile.",
          modelState: "unresolved",
          evidenceIds: ["SRC-001"],
        },
      ],
    });
    expect(
      inspectRequestedPageSupport(
        unresolvedSnapshot,
        [
          "Write `docs/reference/cli.mdx` using only these repository-observed behavior claims:",
          "- The widget --version command prints the installed version.",
        ].join("\n"),
      ),
    ).toMatchObject({ disposition: "needs-input", stopReason: "unresolved-claim" });

    const candidate = createKnowledgeAcceptedSnapshot({ ...body, status: "candidate" });
    expect(
      inspectRequestedPageSupport(
        candidate,
        [
          "Write `docs/reference/cli.mdx` using only these repository-observed behavior claims:",
          "- The product is designed for operators.",
        ].join("\n"),
      ),
    ).toMatchObject({ disposition: "needs-input", stopReason: "insufficient-evidence" });
  });

  it.each(["approved", "canonical"] as const)(
    "excludes disputed advisory variants from %s page support",
    async (status) => {
      const directory = await mkdtemp(join(tmpdir(), "docsfab-disputed-advisory-"));
      const body = classifiedConflictBody();
      const snapshot = createKnowledgeAcceptedSnapshot({
        ...body,
        status,
        claims: body.claims.map((claim) =>
          claim.id === "CL-ABOUT-1" ? { ...claim, kind: "behavior" } : claim,
        ),
      });
      const instruction = [
        "Write `docs/reference/cli.mdx` using only these repository-observed behavior claims:",
        "- The product is designed for operators.",
      ].join("\n");

      expect(inspectRequestedPageSupport(snapshot, instruction)).toMatchObject({
        disposition: "needs-input",
        stopReason: "insufficient-evidence",
      });

      const snapshotPath = join(directory, "snapshot.json");
      await writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");
      await expect(
        importDocumentationCanonBinding(snapshotPath, "create-documentation", instruction),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "insufficient-evidence" });
    },
  );

  it("gives an exact target-blocking conflict precedence over advisory groups", () => {
    const body = classifiedConflictBody();
    const snapshot = createKnowledgeAcceptedSnapshot({
      ...body,
      claims: [
        ...body.claims,
        {
          id: "CL-CLI-1",
          kind: "behavior",
          scope: "CLI",
          statement: "The CLI emits text output.",
          modelState: "disputed",
          evidenceIds: ["SRC-001"],
        },
        {
          id: "CL-CLI-2",
          kind: "behavior",
          scope: "CLI",
          statement: "The CLI emits JSON output.",
          modelState: "disputed",
          evidenceIds: ["SRC-001"],
        },
      ],
      conflicts: [
        ...body.conflicts,
        {
          id: "CF-CLI",
          claimIds: ["CL-CLI-1", "CL-CLI-2"],
          classification: {
            impact: "load-bearing",
            impactBasisSha256: "e".repeat(64),
            blockingDocumentationPaths: ["docs/reference/cli.mdx"],
            resolutionOwner: "cli-owner",
            authorityKind: "product-decision-owner",
          },
        },
      ],
    });
    expect(
      inspectRequestedPageSupport(
        snapshot,
        [
          "Write `docs/reference/cli.mdx` using only these repository-observed behavior claims:",
          "- The widget --version command prints the installed version.",
        ].join("\n"),
      ),
    ).toMatchObject({ disposition: "needs-input", stopReason: "conflict" });
  });

  it("promptly rejects prose after a list item containing repeated list markers", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(readmeHeadingCandidateBody());
    const instruction = [
      "Write `docs/get-started.md` using only these repository-observed behavior claims:",
      `- ${"fact - ".repeat(36)}done.`,
      "Extra unsupported prose.",
    ].join("\n");

    const startedAt = performance.now();
    const inspection = inspectSnapshotValue(snapshot, instruction);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(inspection.disposition).toBe("needs-input");
    expect(inspection.stopReason).toBe("insufficient-evidence");
    expect(elapsedMilliseconds).toBeLessThan(250);
  });
});

function readmeHeadingCandidateBody(): KnowledgeAcceptedSnapshotBodyV1 {
  return {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 6,
    status: "candidate",
    claims: [
      {
        id: "CL-001",
        kind: "behavior",
        scope: "Example Product",
        statement: 'Repository source README.md states: "Route one skill".',
        modelState: "candidate",
        evidenceIds: ["SRC-001"],
      },
    ],
    sources: [{ id: "SRC-001", locator: "readme:README.md" }],
    conflicts: [],
  };
}

function classifiedConflictBody(): KnowledgeAcceptedSnapshotBodyV1 {
  return {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 6,
    status: "approved",
    claims: [
      {
        id: "CL-SUPPORTED",
        kind: "behavior",
        scope: "CLI",
        statement: "The widget --version command prints the installed version.",
        modelState: "canonical",
        evidenceIds: ["SRC-001"],
      },
      {
        id: "CL-ABOUT-1",
        kind: "intent",
        scope: "About",
        statement: "The product is designed for operators.",
        modelState: "disputed",
        evidenceIds: ["SRC-001"],
      },
      {
        id: "CL-ABOUT-2",
        kind: "intent",
        scope: "About",
        statement: "The product is designed for developers.",
        modelState: "disputed",
        evidenceIds: ["SRC-001"],
      },
    ],
    sources: [{ id: "SRC-001", locator: "readme:README.md" }],
    conflicts: [
      {
        id: "CF-ABOUT",
        claimIds: ["CL-ABOUT-1", "CL-ABOUT-2"],
        classification: {
          impact: "load-bearing",
          impactBasisSha256: "b".repeat(64),
          blockingDocumentationPaths: ["docs/about/product.md"],
          resolutionOwner: "product-owner",
          authorityKind: "product-decision-owner",
        },
      },
    ],
  };
}
