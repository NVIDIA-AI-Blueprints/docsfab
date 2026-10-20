// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";

import { createKnowledgeAcceptedSnapshot } from "../src/canon/from-knowledge-snapshot.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import {
  ExplicitDocumentationWriteScopeError,
  FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
} from "../src/cli/first-pass.js";
import { ORIGINAL_TASK_PATH } from "../src/cli/knowledge-resume.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { limitDefinition } from "../src/config/limits.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { HarnessStepInput, HarnessStepResult } from "../src/execution/contracts.js";
import { RepositoryEvidenceProvenanceError } from "../src/repository/contracts.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { CatalogSkillCrateResolver } from "../src/skills/catalog-crate-resolver.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  decodeProvisionalVerificationJudgment,
  decodeTechnicalCorrectionResponseV3,
} from "../src/workflow-execution/source-obligation.js";
import { validModelConfig } from "./helpers.js";
import { verificationFixture, verificationResultFixture } from "./helpers/verification.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const harness = vi.hoisted(() => ({
  calls: [] as HarnessStepInput[],
  handler: undefined as ((input: HarnessStepInput) => Promise<HarnessStepResult>) | undefined,
}));
const snapshotTamper = vi.hoisted(() => ({ afterBinding: undefined as string | undefined }));

vi.mock("../src/cli/first-pass.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass.js")>();
  return {
    ...actual,
    bindFirstPassKnowledge: async (...args: Parameters<typeof actual.bindFirstPassKnowledge>) => {
      const binding = await actual.bindFirstPassKnowledge(...args);
      if (snapshotTamper.afterBinding !== undefined) {
        await (await import("node:fs/promises")).writeFile(
          `${args[0].workspacePath}/${actual.FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH}`,
          snapshotTamper.afterBinding,
        );
      }
      return binding;
    },
  };
});

vi.mock("../src/harness/pi.js", () => ({
  PiHarness: class {
    public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
      harness.calls.push(input);
      if (harness.handler) return harness.handler(input);
      throw new Error("planning fixture stopped before writing");
    }
  },
}));

import { executeRunRequest } from "../src/cli/run-request.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];
const SUPPORTED_BEHAVIOR = "The widget --version command prints the installed version.";
const RUN_STORE_WRITE_WAIT_MS = limitDefinition("retry.maxDelayMs").max;
const RUN_STORE_WRITE_POLL_MS = limitDefinition("retry.baseDelayMs").value;
const ROUTER_SIX_PAGE_DELIVERY_STEPS = [
  "plan-documentation",
  "derive-source-obligations",
  "write-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
] as const;

afterEach(async () => {
  process.exitCode = undefined;
  harness.calls.length = 0;
  harness.handler = undefined;
  snapshotTamper.afterBinding = undefined;
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((path) => removeTemporaryDirectory(path)));
}, RUN_STORE_WRITE_WAIT_MS + limitDefinition("retry.maxDelayMs").value);

describe("first-pass patch evidence", () => {
  it.each([0o0000, 0o0002])(
    "keeps every created sibling private in a real run under umask %s",
    async (umask) => {
      const repository = await fixtureRepository(true);
      const parent = await temporaryDirectory("docsfab-private-run-parent-");
      await chmod(parent, 0o777);
      const parentBefore = await lstat(parent);
      const stateDirectory = join(parent, "s");
      vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());
      const previous = process.umask(umask);
      try {
        const record = await executeRunRequest(
          runRequest(
            repository,
            `Write \`docs/get-started.md\` using only these repository-observed behavior claims:\n- ${SUPPORTED_BEHAVIOR}`,
            "create-documentation",
          ),
          stubConfig(stateDirectory),
          { silent: true },
        );
        expect(record?.status).toBe("failed");
        const patchPath = record?.changes?.patch?.artifactPath;
        expect(patchPath).toBeTruthy();
        const patchBytes = await readFile(patchPath!);
        expect(createHash("sha256").update(patchBytes).digest("hex")).toBe(
          record?.changes?.patch?.sha256,
        );
        const body = { source: "private-state-regression" };
        const digest = opaqueRecordDigest(body);
        await new DurableArtifactStore(join(parent, "artifacts")).putRecord(digest, body);
        const names = (await readdir(parent)).sort();
        expect(names).toEqual(
          expect.arrayContaining(["s", "patches", "artifacts", "run-index", "knowledge"]),
        );
        expect(
          names.every((name) =>
            [
              "s",
              "patches",
              "artifacts",
              "run-index",
              "knowledge",
              "context-cache",
              "quality-validation",
            ].includes(name),
          ),
        ).toBe(true);
        const walk = async (directory: string): Promise<void> => {
          for (const name of await readdir(directory)) {
            const entry = join(directory, name);
            const metadata = await lstat(entry);
            expect(metadata.isSymbolicLink(), entry).toBe(false);
            if (metadata.isDirectory()) {
              expect(metadata.mode & 0o777, entry).toBe(0o700);
              await walk(entry);
            } else {
              expect(metadata.isFile(), entry).toBe(true);
              expect(metadata.mode & 0o777, entry).toBe(0o600);
            }
          }
        };
        await walk(parent);
        const parentAfter = await lstat(parent);
        expect([parentAfter.dev, parentAfter.ino, parentAfter.mode & 0o777]).toEqual([
          parentBefore.dev,
          parentBefore.ino,
          0o777,
        ]);
      } finally {
        process.umask(previous);
      }
    },
    testTimeoutMs(120_000),
  );

  it("hands a tracked .docsfab.json's narrowed documentationRoots to the first-pass gatherer", async () => {
    const repository = await fixtureRepository(true, [], ["docs/user"]);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-roots-state-");
    const recorded = join(
      await temporaryDirectory("docsfab-first-pass-roots-record-"),
      "authorized-write-roots.json",
    );
    vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory({ recorded }));

    await executeRunRequest(
      runRequest(repository, "Create a get-started page.", "create-documentation"),
      stubConfig(join(stateDirectory, "runs")),
      { silent: true },
    ).catch(() => undefined);

    expect(
      JSON.parse(await readFile(recorded, "utf8")),
      "the tracked .docsfab.json documentationRoots did not reach first pass",
    ).toEqual(["docs/user/"]);
  });

  it("checkpoints candidate first-pass bookkeeping even when binding returns undefined", async () => {
    const repository = await fixtureRepository(true);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-state-");
    vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());

    const record = await executeRunRequest(
      {
        workflow: "create-documentation",
        repositoryPath: repository,
        revision: "HEAD",
        instruction: [
          "Write `docs/get-started.md` using only these repository-observed behavior claims:",
          `- ${SUPPORTED_BEHAVIOR}`,
        ].join("\n"),
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      stubConfig(join(stateDirectory, "runs")),
      { silent: true },
    );

    expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
    expect(record?.status).toBe("failed");
    expect(record?.steps[0]?.error).toContain("planning fixture stopped before writing");
    expect(record?.task).toBeUndefined();
    expect(record?.changes?.files).toEqual([]);
    expect(record?.changes?.patch).toMatchObject({
      sha256: createHash("sha256").update("").digest("hex"),
      byteLength: 0,
      lineCount: 0,
      format: "git-diff",
    });
    expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toBe("");
    await expect(readFile(join(repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH))).rejects.toThrow();
    await expect(readFile(join(repository, ORIGINAL_TASK_PATH))).rejects.toThrow();
  });

  it(
    "delivers an admitted create after replacing an uncovered tracked candidate without patching the source snapshot",
    async () => {
      const repository = await fixtureRepository(true);
      const candidate = createKnowledgeAcceptedSnapshot({
        projectId: "PRJ-001",
        modelVersionId: "MODEL-OLD",
        streamVersion: 1,
        status: "candidate",
        claims: [
          {
            id: "CL-OLD",
            kind: "behavior",
            scope: "Fixture product",
            statement: SUPPORTED_BEHAVIOR,
            modelState: "candidate",
            evidenceIds: ["SRC-OLD"],
          },
        ],
        sources: [{ id: "SRC-OLD", locator: "readme:README.md" }],
        conflicts: [],
      });
      const oldBytes = `${JSON.stringify(candidate, null, 2)}\n`;
      const snapshotPath = join(repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
      await mkdir(dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, oldBytes);
      await commitFixture(repository, "seed tracked candidate");
      await git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const sourceBytes = await repositoryBytesSha256(repository);
      const stateDirectory = await temporaryDirectory("docsfab-candidate-replacement-state-");
      const gatherCountPath = join(
        await temporaryDirectory("docsfab-candidate-replacement-count-"),
        "count",
      );
      vi.stubEnv(
        "DOCSFAB_KNOWLEDGE_DIR",
        await supportedCandidateKnowledgeDirectory({ approved: true, gatherCountPath }),
      );
      const page = "docs/fresh.md";
      const instruction = `Create ${page} from the repository README.`;
      const planBinding = createDocumentationPlanBinding({
        mode: "create",
        pages: [{ path: page, disposition: "create" }],
        sourceBindings: [{ pagePath: page, sources: ["README.md"] }],
      });
      const technicalJudgment = JSON.stringify({
        verdict: "pass",
        coverage: verificationResultFixture([page], "README.md:1").coverage,
        issueJudgments: [],
        obligationJudgments: [],
      });
      harness.handler = async (input) => {
        if (input.step.id === "write-documentation") {
          await mkdir(dirname(join(input.repositoryPath, page)), { recursive: true });
          await writeFile(
            join(input.repositoryPath, page),
            "# Fresh guide\n\nBased on README.md.\n",
          );
        }
        let technicalResponse: Partial<HarnessStepResult> = {};
        if (
          input.step.id === "provisional-technical-verification" ||
          input.step.id === "verify-technical-accuracy"
        ) {
          if (input.sourceObligationLedger?.schemaVersion !== 2) {
            throw new Error("CREATE fixture requires a sealed V2 source-obligation ledger.");
          }
          const correction =
            input.step.id === "verify-technical-accuracy"
              ? await decodeTechnicalCorrectionResponseV3(
                  technicalJudgment,
                  input.sourceObligationLedger,
                  input.originalSourceAuthorityAdmission!,
                  input.runId!,
                  [page],
                  input.admittedSourceLineCounts,
                )
              : undefined;
          const verificationResult = correction
            ? correction.verificationResult
            : decodeProvisionalVerificationJudgment(
                technicalJudgment,
                input.sourceObligationLedger,
                [page],
                input.admittedSourceLineCounts,
              );
          technicalResponse = {
            summary: canonicalizeJsonEvidence(
              verificationResult as unknown as JsonEvidenceValue,
            ).trimEnd(),
            verificationResult,
            ...(correction ? { technicalCorrectionEvidence: correction.evidence } : {}),
          };
        }
        return {
          ...(input.step.id === "evaluate-document-quality" && input.qualityProfileSelection
            ? { qualityArtifactCandidate: await authoringFixtureCandidateForInput(input) }
            : {}),
          summary:
            input.step.id === "review-documentation"
              ? canonicalizeJsonEvidence({ verdict: "pass", issues: [] }).trimEnd()
              : `completed ${input.step.id}`,
          ...(input.step.id === "plan-documentation" ? { planBinding } : {}),
          ...(input.step.id === "derive-source-obligations"
            ? await verificationFixture(input)
            : {}),
          ...technicalResponse,
          model: { provider: "fixture", model: "deterministic" },
          skill: await new CatalogSkillCrateResolver(join(runtimeRoot, "skill-crate")).resolveSkill(
            input,
          ),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
          tools: {
            totalCalls: 1,
            failedCalls: 0,
            byTool: [
              { name: input.step.mode === "write" ? "edit" : "read", calls: 1, failures: 0 },
            ],
          },
        };
      };
      const record = await executeRunRequest(
        runRequest(repository, instruction, "create-documentation"),
        stubConfig(join(stateDirectory, "runs")),
        {
          silent: true,
          requestInterpreter: {
            async call() {
              return {
                text: JSON.stringify({
                  authorityPreference: { preference: "unspecified", quote: null },
                  operation: "create",
                  targets: [{ path: page, role: "write", chosenFrom: "proposed-new", quote: page }],
                }),
                usage: { inputTokens: 3, outputTokens: 2 },
              };
            },
          },
        },
      );
      expect(await readFile(gatherCountPath, "utf8")).toBe("1");
      expect(record?.requestIntent?.admission.outcome).toBe("admitted");
      expect(record?.evidenceWarnings).toContainEqual(
        expect.stringContaining(candidate.snapshotSha256),
      );
      expect(
        record?.status,
        JSON.stringify({
          error: record?.error,
          steps: record?.steps.map(({ id, status, error }) => ({ id, status, error })),
        }),
      ).toBe("succeeded");
      expect(record?.error).toBeUndefined();
      expect(
        record?.changes?.files.map((file) => file.path),
        JSON.stringify({
          status: record?.status,
          error: record?.error,
          steps: record?.steps.map(({ id, status, error }) => ({ id, status, error })),
        }),
      ).toEqual([page]);
      expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toContain(page);
      expect(await readFile(snapshotPath, "utf8")).toBe(oldBytes);
      expect(await gitStatus(repository)).toBe("");
      expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    },
    testTimeoutMs(120_000),
  );

  it("refuses a changed gathered snapshot before admitting it as host evidence", async () => {
    const repository = await fixtureRepository(true);
    const candidate = createKnowledgeAcceptedSnapshot({
      projectId: "PRJ-001",
      modelVersionId: "MODEL-OLD",
      streamVersion: 1,
      status: "candidate",
      claims: [
        {
          id: "CL-OLD",
          kind: "behavior",
          scope: "Fixture product",
          statement: SUPPORTED_BEHAVIOR,
          modelState: "candidate",
          evidenceIds: ["SRC-OLD"],
        },
      ],
      sources: [{ id: "SRC-OLD", locator: "readme:README.md" }],
      conflicts: [],
    });
    const snapshotPath = join(repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify(candidate)}\n`);
    await commitFixture(repository, "seed candidate for tamper control");
    vi.stubEnv(
      "DOCSFAB_KNOWLEDGE_DIR",
      await supportedCandidateKnowledgeDirectory({ approved: true }),
    );
    snapshotTamper.afterBinding = "changed after first-pass binding\n";
    const page = "docs/fresh.md";
    await expect(
      executeRunRequest(
        runRequest(repository, `Create ${page} from README.md.`, "create-documentation"),
        stubConfig(join(await temporaryDirectory("docsfab-gathered-tamper-state-"), "runs")),
        {
          silent: true,
          requestInterpreter: {
            async call() {
              return {
                text: JSON.stringify({
                  authorityPreference: { preference: "unspecified", quote: null },
                  operation: "create",
                  targets: [{ path: page, role: "write", chosenFrom: "proposed-new", quote: page }],
                }),
                usage: { inputTokens: 3, outputTokens: 2 },
              };
            },
          },
        },
      ),
    ).rejects.toMatchObject({ name: "RepositoryWorkspaceReadError", code: "changed" });
    expect(harness.calls).toEqual([]);
  });

  it("keeps export authentication for an approved snapshot that first pass did not write", async () => {
    const repository = await fixtureRepository(true);
    const body = {
      projectId: "PRJ-001",
      modelVersionId: "MODEL-OLD",
      streamVersion: 1,
      status: "approved" as const,
      claims: [
        {
          id: "CL-OLD",
          kind: "behavior" as const,
          scope: "Fixture product",
          statement: SUPPORTED_BEHAVIOR,
          modelState: "canonical" as const,
          evidenceIds: ["SRC-OLD"],
        },
      ],
      sources: [{ id: "SRC-OLD", locator: "readme:README.md" }],
      conflicts: [],
    };
    const approved = createKnowledgeAcceptedSnapshot(body);
    const snapshotPath = join(repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify(approved)}\n`);
    await commitFixture(repository, "seed approved snapshot for tamper control");
    snapshotTamper.afterBinding = `${JSON.stringify(
      createKnowledgeAcceptedSnapshot({ ...body, modelVersionId: "MODEL-CHANGED" }),
    )}\n`;
    const gatherCountPath = join(
      await temporaryDirectory("docsfab-approved-gather-count-"),
      "count",
    );
    vi.stubEnv(
      "DOCSFAB_KNOWLEDGE_DIR",
      await supportedCandidateKnowledgeDirectory({ gatherCountPath }),
    );
    const page = "docs/fresh.md";
    const planBinding = createDocumentationPlanBinding({
      mode: "create",
      pages: [{ path: page, disposition: "create" }],
      sourceBindings: [{ pagePath: page, sources: ["README.md"] }],
    });
    harness.handler = async (input) => ({
      summary: `completed ${input.step.id}`,
      ...(input.step.id === "plan-documentation" ? { planBinding } : {}),
      model: { provider: "fixture", model: "deterministic" },
      skill: await new CatalogSkillCrateResolver(join(runtimeRoot, "skill-crate")).resolveSkill(
        input,
      ),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    });
    const record = await executeRunRequest(
      runRequest(repository, `Create ${page} from README.md.`, "create-documentation"),
      stubConfig(join(await temporaryDirectory("docsfab-approved-tamper-state-"), "runs")),
      {
        silent: true,
        requestInterpreter: {
          async call() {
            return {
              text: JSON.stringify({
                authorityPreference: { preference: "unspecified", quote: null },
                operation: "create",
                targets: [{ path: page, role: "write", chosenFrom: "proposed-new", quote: page }],
              }),
              usage: { inputTokens: 3, outputTokens: 2 },
            };
          },
        },
      },
    );
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("Tracked repository file snapshot changed");
    await expect(readFile(gatherCountPath)).rejects.toThrow();
  });

  it("keeps the exact ROUTER finite request free of bootstrap output through the planner boundary", async () => {
    const repository = await fixtureRepository(false);
    const sourceBytes = await repositoryBytesSha256(repository);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-router-state-");
    vi.stubEnv(
      "DOCSFAB_KNOWLEDGE_DIR",
      await supportedCandidateKnowledgeDirectory({ approved: true }),
    );
    const routerCase = await routerSixPageCase();

    const record = await executeRunRequest(
      runRequest(repository, routerCase.instruction, "update-documentation"),
      stubConfig(join(stateDirectory, "runs")),
      { silent: true },
    );

    expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
    expect(record?.status).toBe("failed");
    expect(record?.changes?.files).toEqual([]);
    expect(record?.changes?.patch).toBeUndefined();
    expect(await gitStatus(repository)).toBe("");
    expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    await expect(readFile(join(repository, ".docsfab.json"))).rejects.toThrow();
  });

  it(
    "delivers only the six requested ROUTER paths with host-private first-use setup",
    async () => {
      const routerCase = await routerSixPageCase();
      const repository = await fixtureRepository(false, routerCase.targetPaths);
      const sourceBytes = await repositoryBytesSha256(repository);
      const stateDirectory = await temporaryDirectory("docsfab-first-pass-router-delivery-state-");
      vi.stubEnv(
        "DOCSFAB_KNOWLEDGE_DIR",
        await supportedCandidateKnowledgeDirectory({ approved: true }),
      );
      const planBinding = createDocumentationPlanBinding({
        mode: "update",
        pages: routerCase.targetPaths.map((path) => ({ path, disposition: "update" as const })),
        sourceBindings: routerCase.targetPaths.map((path) => ({ pagePath: path, sources: [path] })),
      });
      const impactSource = {
        uri: "README.md",
        sha256: createHash("sha256")
          .update(await readFile(join(repository, "README.md")))
          .digest("hex"),
      };
      harness.handler = async (input) => {
        const readerEvidence = input.editorialEvidenceRefs?.[0];
        if (input.step.id === "write-documentation") {
          expect(input.planBinding).toEqual(planBinding);
          await Promise.all(
            routerCase.targetPaths.map((path) =>
              writeFile(
                join(input.repositoryPath, path),
                `# ${path}\n\nUpdated from the exact request and repository evidence.\n`,
              ),
            ),
          );
        }
        return {
          ...(input.step.id === "evaluate-document-quality" && input.qualityProfileSelection
            ? { qualityArtifactCandidate: await authoringFixtureCandidateForInput(input) }
            : {}),
          summary: `completed ${input.step.id}`,
          ...(input.step.id === "verify-technical-accuracy" ||
          input.step.id === "derive-source-obligations"
            ? await verificationFixture(input)
            : {}),
          ...(input.step.id === "plan-documentation"
            ? {
                planBinding,
                editorialDecisionProposal: {
                  schemaVersion: 1 as const,
                  kind: "docsfab-editorial-decision-proposal" as const,
                  candidate: "update" as const,
                  rationale:
                    "The exact finite request identifies six current documentation pages that require bounded updates.",
                  evidenceRefs: readerEvidence ? [readerEvidence] : [],
                  limitations: [],
                  impactBasis: {
                    kind: "documentation-defect" as const,
                    rationale:
                      "The admitted request and current documentation establish the six source-bound update targets.",
                    evidence_refs: [impactSource],
                  },
                },
              }
            : {}),
          ...(input.step.id === "verify-technical-accuracy" ||
          input.step.id === "review-documentation" ||
          input.step.id === "evaluate-document-quality"
            ? {
                editorialAssessmentProposal: {
                  schemaVersion: 1 as const,
                  kind: "docsfab-editorial-assessment-proposal" as const,
                  assessment: "accepted" as const,
                  rationale: `${input.step.id} independently checked the six retained documentation targets.`,
                  evidenceRefs: readerEvidence ? [readerEvidence] : [],
                  limitations: [],
                  recommendation: null,
                },
              }
            : input.step.id === "test-audience-understanding"
              ? {
                  editorialAssessmentProposal: {
                    schemaVersion: 1 as const,
                    kind: "docsfab-editorial-assessment-proposal" as const,
                    assessment: "not-applicable" as const,
                    rationale:
                      "No authorized representative audience fixture is available in this deterministic transport test.",
                    evidenceRefs: readerEvidence ? [readerEvidence] : [],
                    limitations: ["audience-check-unavailable"],
                    recommendation: null,
                  },
                }
              : {}),
          model: { provider: "fixture", model: "deterministic" },
          skill: await new CatalogSkillCrateResolver(join(runtimeRoot, "skill-crate")).resolveSkill(
            input,
          ),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            total: 2,
            turns: 1,
          },
          tools: {
            totalCalls: 1,
            failedCalls: 0,
            byTool: [
              { name: input.step.mode === "write" ? "edit" : "read", calls: 1, failures: 0 },
            ],
          },
        };
      };

      const record = await executeRunRequest(
        runRequest(repository, routerCase.instruction, "update-documentation"),
        stubConfig(join(stateDirectory, "runs")),
        { silent: true },
      );

      expect(
        record?.status,
        JSON.stringify({
          error: record?.error,
          artifacts: record?.artifacts,
          coverage: record?.workflowBranchCoverage,
          outcome: record?.workflowOutcome,
          steps: record?.steps.map(({ id, status, error }) => ({ id, status, error })),
        }),
      ).toBe("succeeded");
      expect(harness.calls.map((call) => call.step.id)).toEqual([
        ...ROUTER_SIX_PAGE_DELIVERY_STEPS,
      ]);
      expect(record?.changes?.files.map((file) => file.path)).toEqual(
        [...routerCase.targetPaths].sort(),
      );
      const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
      for (const path of routerCase.targetPaths) expect(patch).toContain(path);
      expect(patch).not.toContain(".docsfab.json");
      expect(await gitStatus(repository)).toBe("");
      expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
      await expect(readFile(join(repository, ".docsfab.json"))).rejects.toThrow();
    },
    RUN_STORE_WRITE_WAIT_MS * ROUTER_SIX_PAGE_DELIVERY_STEPS.length,
  );

  it("retains bootstrap output when the same finite request explicitly adds config", async () => {
    const repository = await fixtureRepository(false);
    const sourceBytes = await repositoryBytesSha256(repository);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-config-state-");
    vi.stubEnv(
      "DOCSFAB_KNOWLEDGE_DIR",
      await supportedCandidateKnowledgeDirectory({ approved: true }),
    );
    const routerCase = await routerSixPageCase();
    const instruction = routerCase.instruction.replace(
      " to clarify",
      ", and .docsfab.json to clarify",
    );

    const record = await executeRunRequest(
      runRequest(repository, instruction, "update-documentation"),
      stubConfig(join(stateDirectory, "runs")),
      { silent: true },
    );

    expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
    expect(record?.status).toBe("failed");
    expect(record?.changes?.files).toEqual([{ path: ".docsfab.json", status: "added" }]);
    expect(record?.changes?.patch).toBeUndefined();
    expect(await gitStatus(repository)).toBe("");
    expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    await expect(readFile(join(repository, ".docsfab.json"))).rejects.toThrow();
  });

  it("treats config documentation as a reference without granting config write authority", async () => {
    const repository = await fixtureRepository(false);
    const sourceBytes = await repositoryBytesSha256(repository);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-config-reference-state-");
    vi.stubEnv(
      "DOCSFAB_KNOWLEDGE_DIR",
      await supportedCandidateKnowledgeDirectory({ approved: true }),
    );

    const record = await executeRunRequest(
      runRequest(
        repository,
        "Update .docsfab.json documentation in docs/config.md and docs/setup.md.",
        "update-documentation",
      ),
      stubConfig(join(stateDirectory, "runs")),
      { silent: true },
    );

    expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
    expect(record?.status).toBe("failed");
    expect(record?.changes?.files).toEqual([]);
    expect(record?.changes?.patch).toBeUndefined();
    expect(await gitStatus(repository)).toBe("");
    expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    await expect(readFile(join(repository, ".docsfab.json"))).rejects.toThrow();
  });

  it("keeps an unscoped local first-use write free of project setup", async () => {
    const repository = await fixtureRepository(false);
    const sourceBytes = await repositoryBytesSha256(repository);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-default-state-");
    vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());

    const record = await executeRunRequest(
      runRequest(
        repository,
        "Write `docs/get-started.md` using only these repository-observed behavior claims:\n" +
          `- ${SUPPORTED_BEHAVIOR}`,
        "create-documentation",
      ),
      stubConfig(join(stateDirectory, "runs")),
      { silent: true },
    );

    expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
    expect(record?.status).toBe("failed");
    expect(record?.changes?.files).toEqual([]);
    expect(record?.changes?.patch?.byteLength).toBe(0);
    expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toBe("");
    expect(await gitStatus(repository)).toBe("");
    expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    await expect(readFile(join(repository, ".docsfab.json"))).rejects.toThrow();
  });

  it("retains the default model-profile publishing setup before planning", async () => {
    const repository = await fixtureRepository(false);
    const sourceBytes = await repositoryBytesSha256(repository);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-publishing-state-");
    vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());
    const instruction =
      "Write `docs/get-started.md` using only these repository-observed behavior claims:\n" +
      `- ${SUPPORTED_BEHAVIOR}`;
    const request = parseRunArguments([
      "create-documentation",
      "--repo",
      repository,
      "--instruction",
      instruction,
    ]);
    expect(request.draftMr).toBe(true);
    const revision = await git(repository, ["rev-parse", "HEAD"]);

    const record = await executeRunRequest(request, stubConfig(join(stateDirectory, "runs")), {
      silent: true,
      ensurePublicationFreshness: async () => ({ branch: "main", revision }),
    });

    expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
    expect(record?.status).toBe("failed");
    expect(record?.changes?.files).toEqual([{ path: ".docsfab.json", status: "added" }]);
    expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toContain(".docsfab.json");
    expect(await gitStatus(repository)).toBe("");
    expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
  });

  it("rejects unsafe finite scope before bootstrap, knowledge bookkeeping, or planning", async () => {
    const repository = await fixtureRepository(false);
    const sourceBytes = await repositoryBytesSha256(repository);
    const stateDirectory = await temporaryDirectory("docsfab-first-pass-unsafe-state-");
    vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());

    await expectExplicitWriteScopeRefusal(
      repository,
      "Update docs/a.md, docs/../unsafe.md, and docs/b.md.",
      {
        target: "docs/../unsafe.md",
        roots: DEFAULT_WRITE_SCOPE_ROOTS,
        nextAction: DEFAULT_WRITE_SCOPE_ACTION,
      },
      stateDirectory,
    );

    expect(harness.calls).toEqual([]);
    expect(await gitStatus(repository)).toBe("");
    expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    await expect(readFile(join(repository, ".docsfab.json"))).rejects.toThrow();
    await expect(stat(join(stateDirectory, "knowledge"))).rejects.toThrow();
  });

  it("advances only exact runtime paths and clears earlier capture staging", async () => {
    const workspace = await temporaryDirectory("docsfab-evidence-workspace-");
    const artifacts = await temporaryDirectory("docsfab-evidence-artifacts-");
    await writeFile(join(workspace, "README.md"), "baseline\n");
    const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
    try {
      await mkdir(join(workspace, ".docsfab", "reference-model"), { recursive: true });
      await writeFile(join(workspace, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH), "snapshot\n");
      await writeFile(join(workspace, ORIGINAL_TASK_PATH), "task\n");
      await writeFile(join(workspace, ".docsfab.json"), "proposed config\n");

      await collector.capture(evidenceContext(workspace, false));
      await collector.advanceBaselineForRuntimeChanges([
        FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
        ORIGINAL_TASK_PATH,
      ]);
      const retained = await collector.capture(evidenceContext(workspace, true));

      expect(retained.files).toEqual([{ path: ".docsfab.json", status: "added" }]);
      expect(await readFile(retained.patch!.artifactPath, "utf8")).toContain(".docsfab.json");
      expect(await readFile(join(workspace, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH), "utf8")).toBe(
        "snapshot\n",
      );
      expect(await readFile(join(workspace, ORIGINAL_TASK_PATH), "utf8")).toBe("task\n");
    } finally {
      await collector.dispose();
    }
  });

  it("retains only a successful documentation write with matching digest and apply readback", async () => {
    const source = await fixtureRepository(true);
    const artifacts = await temporaryDirectory("docsfab-evidence-doc-artifacts-");
    const applied = await temporaryDirectory("docsfab-evidence-applied-");
    let patchPath = "";
    const usage = "# Usage\n\nCall the fixture API.\n";

    await withRepositoryWorkspace(source, "HEAD", async (workspace) => {
      const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
      try {
        await mkdir(join(workspace.path, ".docsfab", "reference-model"), { recursive: true });
        await writeFile(
          join(workspace.path, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH),
          "trusted snapshot\n",
        );
        await writeFile(join(workspace.path, ORIGINAL_TASK_PATH), "trusted task\n");
        await collector.advanceBaselineForRuntimeChanges([
          FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
          ORIGINAL_TASK_PATH,
        ]);
        await mkdir(join(workspace.path, "docs"));
        await writeFile(join(workspace.path, "docs", "usage.md"), usage);

        const retained = await collector.capture(evidenceContext(workspace.path, true));
        expect(retained.files).toEqual([{ path: "docs/usage.md", status: "added" }]);
        const patch = await readFile(retained.patch!.artifactPath);
        expect(retained.patch!.sha256).toBe(createHash("sha256").update(patch).digest("hex"));
        expect(retained.patch!.byteLength).toBe(patch.byteLength);
        patchPath = retained.patch!.artifactPath;
      } finally {
        await collector.dispose();
      }
    });

    await git(source, ["clone", "-q", source, applied]);
    await git(applied, ["apply", "--check", patchPath]);
    await git(applied, ["apply", patchPath]);
    expect(await readFile(join(applied, "docs", "usage.md"), "utf8")).toBe(usage);
    expect(await gitStatus(source)).toBe("");
    await expect(readFile(join(source, "docs", "usage.md"))).rejects.toThrow();
  });

  it("does not use trusted bookkeeping as copy ancestry for identical documentation", async () => {
    const source = await fixtureRepository(false);
    const artifacts = await temporaryDirectory("docsfab-evidence-copy-artifacts-");
    const applied = await temporaryDirectory("docsfab-evidence-copy-applied-");
    const bookkeeping = '{"kind":"docsfab-original-task","schemaVersion":1}\n';
    const ordinarySource = await readFile(join(source, "README.md"), "utf8");
    let patchPath = "";

    await withRepositoryWorkspace(source, "HEAD", async (workspace) => {
      const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
      try {
        await mkdir(join(workspace.path, ".docsfab", "reference-model"), { recursive: true });
        await writeFile(join(workspace.path, ORIGINAL_TASK_PATH), bookkeeping);
        await collector.advanceBaselineForRuntimeChanges([ORIGINAL_TASK_PATH]);
        await mkdir(join(workspace.path, "docs"));
        await writeFile(join(workspace.path, "docs", "original-task-format.json"), bookkeeping);
        await writeFile(join(workspace.path, "docs", "readme-copy.md"), ordinarySource);

        const retained = await collector.capture(evidenceContext(workspace.path, true));
        expect(retained.files).toHaveLength(2);
        expect(retained.files).toEqual(
          expect.arrayContaining([
            { path: "docs/original-task-format.json", status: "added" },
            { path: "docs/readme-copy.md", previousPath: "README.md", status: "copied" },
          ]),
        );
        const patch = await readFile(retained.patch!.artifactPath, "utf8");
        expect(patch).not.toContain(`copy from ${ORIGINAL_TASK_PATH}`);
        expect(patch).toContain("docs/original-task-format.json");
        expect(patch).toContain("copy from README.md");
        patchPath = retained.patch!.artifactPath;
      } finally {
        await collector.dispose();
      }
    });

    await git(source, ["clone", "-q", source, applied]);
    await git(applied, ["apply", "--check", patchPath]);
    await git(applied, ["apply", patchPath]);
    expect(await readFile(join(applied, "docs", "original-task-format.json"), "utf8")).toBe(
      bookkeeping,
    );
    expect(await readFile(join(applied, "docs", "readme-copy.md"), "utf8")).toBe(ordinarySource);
    expect(await gitStatus(source)).toBe("");
  });

  it("retains partial documentation and later mutations to a reserved path", async () => {
    const source = await fixtureRepository(false);
    const artifacts = await temporaryDirectory("docsfab-evidence-later-artifacts-");
    const applied = await temporaryDirectory("docsfab-evidence-later-applied-");
    let patchPath = "";

    await withRepositoryWorkspace(source, "HEAD", async (workspace) => {
      const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
      try {
        await mkdir(join(workspace.path, ".docsfab", "reference-model"), { recursive: true });
        await writeFile(
          join(workspace.path, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH),
          "trusted snapshot\n",
        );
        await writeFile(join(workspace.path, ORIGINAL_TASK_PATH), "trusted task\n");
        await collector.advanceBaselineForRuntimeChanges([
          FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
          ORIGINAL_TASK_PATH,
        ]);

        await mkdir(join(workspace.path, "docs"));
        await writeFile(join(workspace.path, "docs", "partial.md"), "partial writer output\n");
        await writeFile(join(workspace.path, ORIGINAL_TASK_PATH), "later untrusted mutation\n");
        const retained = await collector.capture(evidenceContext(workspace.path, true));

        expect(retained.files).toEqual([
          { path: "docs/partial.md", status: "added" },
          { path: ORIGINAL_TASK_PATH, status: "added" },
        ]);
        const patch = await readFile(retained.patch!.artifactPath, "utf8");
        expect(patch).not.toContain(FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
        expect(patch).toContain("partial writer output");
        expect(patch).toContain("later untrusted mutation");
        patchPath = retained.patch!.artifactPath;
      } finally {
        await collector.dispose();
      }
    });

    await git(source, ["clone", "-q", source, applied]);
    await git(applied, ["apply", "--check", patchPath]);
    await git(applied, ["apply", patchPath]);
    expect(await readFile(join(applied, ORIGINAL_TASK_PATH), "utf8")).toBe(
      "later untrusted mutation\n",
    );
    expect(await readFile(join(applied, "docs", "partial.md"), "utf8")).toBe(
      "partial writer output\n",
    );
  });

  it("rejects a deleted runtime-only path that has no source-relative change", async () => {
    const source = await fixtureRepository(false);
    const artifacts = await temporaryDirectory("docsfab-evidence-deletion-artifacts-");
    const applied = await temporaryDirectory("docsfab-evidence-deletion-applied-");
    let patchPath = "";

    await withRepositoryWorkspace(source, "HEAD", async (workspace) => {
      const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
      try {
        await mkdir(join(workspace.path, ".docsfab", "reference-model"), { recursive: true });
        await writeFile(join(workspace.path, ORIGINAL_TASK_PATH), "trusted task\n");
        await collector.advanceBaselineForRuntimeChanges([ORIGINAL_TASK_PATH]);
        await mkdir(join(workspace.path, "docs"));
        await writeFile(join(workspace.path, "docs", "partial.md"), "partial docs\n");
        await rm(join(workspace.path, ORIGINAL_TASK_PATH));

        let captured: unknown;
        try {
          await collector.capture(evidenceContext(workspace.path, true));
        } catch (error) {
          captured = error;
        }
        expect(captured).toBeInstanceOf(RepositoryEvidenceProvenanceError);
        const evidence = (captured as RepositoryEvidenceProvenanceError).evidence;
        expect(evidence.files).toEqual([{ path: "docs/partial.md", status: "added" }]);
        patchPath = evidence.patch!.artifactPath;
        expect(await readFile(patchPath, "utf8")).toContain("partial docs\n");
      } finally {
        await collector.dispose();
      }
    });

    await git(source, ["clone", "-q", source, applied]);
    await git(applied, ["apply", "--check", patchPath]);
    await git(applied, ["apply", patchPath]);
    expect(await readFile(join(applied, "docs", "partial.md"), "utf8")).toBe("partial docs\n");
  });

  it("renders tracked reserved mutations against the original source", async () => {
    const source = await fixtureRepository(false);
    const artifacts = await temporaryDirectory("docsfab-evidence-tracked-artifacts-");
    const appliedModified = await temporaryDirectory("docsfab-evidence-tracked-modified-");
    const appliedDeleted = await temporaryDirectory("docsfab-evidence-tracked-deleted-");
    let modifiedPatch = "";
    let deletedPatch = "";
    await mkdir(join(source, ".docsfab", "reference-model"), { recursive: true });
    await writeFile(join(source, ORIGINAL_TASK_PATH), "source task\n");
    await commitFixture(source, "seed reserved task");

    await withRepositoryWorkspace(source, "HEAD", async (workspace) => {
      const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
      try {
        await collector.advanceBaselineForRuntimeChanges([ORIGINAL_TASK_PATH]);
        await writeFile(join(workspace.path, ORIGINAL_TASK_PATH), "modified task\n");
        const modified = await collector.capture({
          ...evidenceContext(workspace.path, true),
          runId: "tracked-modified",
        });
        expect(modified.files).toEqual([{ path: ORIGINAL_TASK_PATH, status: "modified" }]);
        modifiedPatch = modified.patch!.artifactPath;

        await rm(join(workspace.path, ORIGINAL_TASK_PATH));
        const deleted = await collector.capture({
          ...evidenceContext(workspace.path, true),
          runId: "tracked-deleted",
        });
        expect(deleted.files).toEqual([{ path: ORIGINAL_TASK_PATH, status: "deleted" }]);
        deletedPatch = deleted.patch!.artifactPath;
      } finally {
        await collector.dispose();
      }
    });

    await git(source, ["clone", "-q", source, appliedModified]);
    await git(appliedModified, ["apply", "--check", modifiedPatch]);
    await git(appliedModified, ["apply", modifiedPatch]);
    expect(await readFile(join(appliedModified, ORIGINAL_TASK_PATH), "utf8")).toBe(
      "modified task\n",
    );

    await git(source, ["clone", "-q", source, appliedDeleted]);
    await git(appliedDeleted, ["apply", "--check", deletedPatch]);
    await git(appliedDeleted, ["apply", deletedPatch]);
    await expect(readFile(join(appliedDeleted, ORIGINAL_TASK_PATH))).rejects.toThrow();
  });

  it("rejects unsafe, duplicate, repeated, and disposed baseline advances", async () => {
    const workspace = await temporaryDirectory("docsfab-evidence-reject-");
    const artifacts = await temporaryDirectory("docsfab-evidence-reject-artifacts-");
    await writeFile(join(workspace, "README.md"), "baseline\n");

    const unsafe = await GitPatchEvidenceCollector.create(workspace, artifacts);
    await expect(unsafe.advanceBaselineForRuntimeChanges(["../outside"])).rejects.toThrow(
      "safe repository-relative",
    );
    await expect(unsafe.advanceBaselineForRuntimeChanges(["same", "same"])).rejects.toThrow(
      "must be unique",
    );
    await writeFile(join(workspace, "runtime-file"), "trusted\n");
    await unsafe.advanceBaselineForRuntimeChanges(["runtime-file"]);
    await expect(unsafe.advanceBaselineForRuntimeChanges(["another"])).rejects.toThrow(
      "already advanced",
    );
    await unsafe.dispose();
    await expect(unsafe.advanceBaselineForRuntimeChanges(["another"])).rejects.toThrow("disposed");
  });
});

// #1914: named pages go through the run command's admission, which reads the
// tracked .docsfab.json. A local run may widen the write roots to configured
// documentation directories (owner amendment to Decision 8, #1914 note 72942914).
const DEFAULT_WRITE_SCOPE_ROOTS = '"docs/", "fern/"';
const CHANGE_WRITE_SCOPE_ACTION =
  "To change the scope for a permitted page or documentation directory, update documentationRoots in .docsfab.json, commit the change, and start a new request.";
const DEFAULT_WRITE_SCOPE_ACTION = `Name a page inside ${DEFAULT_WRITE_SCOPE_ROOTS}. ${CHANGE_WRITE_SCOPE_ACTION}`;

/**
 * Run one request through the run command, an update unless the caller says
 * otherwise. A refusal comes back as the error; a run that went ahead comes
 * back as a sentence naming its request.
 */
async function namedPageOutcome(
  repository: string,
  instruction: string,
  stateDirectory: string,
  workflow: "create-documentation" | "update-documentation" = "update-documentation",
  options: { readonly silent: boolean } = { silent: true },
): Promise<unknown> {
  return executeRunRequest(
    runRequest(repository, instruction, workflow),
    stubConfig(join(stateDirectory, "runs")),
    options,
  ).then(
    (record) => `ran "${instruction}" to status ${record?.status ?? "none"} instead of refusing it`,
    (error: unknown) => error,
  );
}

/** Assert a refusal before any model call, naming the request when it ran instead. */
async function expectNamedPageRefusal(
  repository: string,
  instruction: string,
  expected: { readonly code: string; readonly message: string },
): Promise<void> {
  const stateDirectory = await temporaryDirectory("docsfab-named-page-state-");
  const outcome = await namedPageOutcome(repository, instruction, stateDirectory);
  expect(typeof outcome === "string" ? outcome : undefined).toBeUndefined();
  expect(outcome, instruction).toMatchObject({
    ...expected,
    name: "FirstRunProposalScopeError",
    phase: "proposal-scope-admission",
    repositoryRevision: await git(repository, ["rev-parse", "HEAD"]),
    retryable: false,
    noWorkPerformed: true,
  });
  // No first-pass knowledge bookkeeping started for the refused request.
  await expect(stat(join(stateDirectory, "knowledge")), instruction).rejects.toThrow();
}

/** The early typed refusal carries guidance; its effects are measured directly. */
async function expectExplicitWriteScopeRefusal(
  repository: string,
  instruction: string,
  expected: {
    readonly target: string;
    readonly roots: string;
    readonly nextAction: string;
  },
  stateDirectory?: string,
): Promise<void> {
  const state = stateDirectory ?? (await temporaryDirectory("docsfab-explicit-scope-state-"));
  const sourceBytes = await repositoryBytesSha256(repository);
  const revision = await git(repository, ["rev-parse", "HEAD"]);
  const projectConfigPath = join(repository, ".docsfab.json");
  const projectConfigBytes = async () =>
    readFile(projectConfigPath).catch((error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) return undefined;
      throw error;
    });
  const originalConfig = await projectConfigBytes();
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("The outside-scope refusal must not call a provider."));
  try {
    const outcome = await namedPageOutcome(repository, instruction, state);
    expect(outcome, instruction).toBeInstanceOf(ExplicitDocumentationWriteScopeError);
    expect(outcome, instruction).toMatchObject({
      name: "ExplicitDocumentationWriteScopeError",
      code: "request-intent-outside-write-scope",
      message: `DocsFab cannot write ${JSON.stringify(expected.target)}: it is outside this run's documentation write scope. Granted documentation roots: ${expected.roots}. ${expected.nextAction}`,
      nextAction: expected.nextAction,
    });
    expect(provider, instruction).not.toHaveBeenCalled();
    expect(harness.calls, instruction).toEqual([]);
    expect(await gitStatus(repository), instruction).toBe("");
    expect(await git(repository, ["rev-parse", "HEAD"]), instruction).toBe(revision);
    expect(await repositoryBytesSha256(repository), instruction).toBe(sourceBytes);
    expect(await projectConfigBytes(), instruction).toEqual(originalConfig);
    await expect(stat(join(state, "knowledge")), instruction).rejects.toThrow();
  } finally {
    provider.mockRestore();
  }
}

describe("named-page admission through the run command", () => {
  it(
    "refuses pages outside the documentation write roots by name before any model call",
    async () => {
      const repository = await fixtureRepository(true, [
        "docs/a.md",
        "docs/b.md",
        "website/docs/intro.md",
        "src/guide.md",
      ]);
      const sourceBytes = await repositoryBytesSha256(repository);
      vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());
      for (const [instruction, target] of [
        ["Update website/docs/intro.md to describe the new flag.", "website/docs/intro.md"],
        ["Update src/guide.md to describe the new flag.", "src/guide.md"],
        ["Update /etc/guide.md to describe the new flag.", "/etc/guide.md"],
      ] as const) {
        await expectExplicitWriteScopeRefusal(repository, instruction, {
          target,
          roots: DEFAULT_WRITE_SCOPE_ROOTS,
          nextAction: DEFAULT_WRITE_SCOPE_ACTION,
        });
      }
      // A mention excludes the repeated page (owner decision, #1914 note 72956288).
      await expectNamedPageRefusal(
        repository,
        "Update docs/a.md to describe the new flag. Do not change docs/a.md.",
        {
          code: "proposal-scope-duplicate-targets",
          message:
            "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
        },
      );
      expect(harness.calls).toEqual([]);
      expect(await gitStatus(repository)).toBe("");
      expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    },
    testTimeoutMs(120_000),
  );

  it(
    "gives a path-less create and named pages one configuration refusal when no configured root is a write root",
    async () => {
      // Every configured root is unsafe, so no write root remains, and every
      // write path refuses the configuration the same way, before any model call.
      const repository = await fixtureRepository(
        true,
        ["site/content/en/docs/setup.md", "docs/a.md"],
        ["src/docs", ".github/docs"],
      );
      const sourceBytes = await repositoryBytesSha256(repository);
      const outcomes: unknown[] = [];
      for (const [instruction, workflow] of [
        ["Create a get-started page for the new flag.", "create-documentation"],
        ["Update docs/a.md to describe the new flag.", "update-documentation"],
        ["Update site/content/en/docs/setup.md to describe the new flag.", "update-documentation"],
      ] as const) {
        const outcome = await namedPageOutcome(
          repository,
          instruction,
          await temporaryDirectory("docsfab-roots-refusal-state-"),
          workflow,
        );
        expect(typeof outcome === "string" ? outcome : undefined).toBeUndefined();
        expect(outcome, instruction).toMatchObject({
          name: "DocumentationRootsOutsideWriteRootsError",
          code: "documentation-roots-outside-write-roots",
        });
        outcomes.push(outcome);
      }
      // One code, message, and next action from every path.
      const advice = outcomes.map((outcome) => {
        const { code, message, nextAction } = outcome as {
          code: string;
          message: string;
          nextAction: string;
        };
        return { code, message, nextAction };
      });
      expect(new Set(advice.map((item) => JSON.stringify(item))).size).toBe(1);
      expect(advice[0]?.message).toContain(
        'Dropped: "src/docs" (a code directory), ".github/docs" (a segment starts with ".").',
      );
      expect(advice[0]?.message).toContain("Fix documentationRoots in .docsfab.json");
      expect(advice[0]?.nextAction).toMatch(/^Fix documentationRoots in \.docsfab\.json/u);
      expect(harness.calls).toEqual([]);
      expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    },
    testTimeoutMs(180_000),
  );

  it(
    "narrows admission to the tracked documentationRoots and reports the roots it drops",
    async () => {
      const repository = await fixtureRepository(
        true,
        ["docs/user/setup.md", "docs/admin/setup.md"],
        ["docs/user", "src/docs"],
      );
      const sourceBytes = await repositoryBytesSha256(repository);
      vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());
      await expectExplicitWriteScopeRefusal(
        repository,
        "Update docs/admin/setup.md to describe the new flag.",
        {
          target: "docs/admin/setup.md",
          roots: '"docs/user/"',
          nextAction: `Name a page inside "docs/user/". ${CHANGE_WRITE_SCOPE_ACTION}`,
        },
      );
      expect(harness.calls).toEqual([]);

      // Positive control: a page inside the configured root reaches the planner,
      // and the run says which configured root it ignored.
      const written: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
        written.push(parts.map(String).join(" "));
      });
      let outcome: unknown;
      try {
        outcome = await namedPageOutcome(
          repository,
          "Update docs/user/setup.md to describe the new flag.",
          await temporaryDirectory("docsfab-named-page-state-"),
          "update-documentation",
          { silent: false },
        );
      } finally {
        stderr.mockRestore();
        log.mockRestore();
        error.mockRestore();
      }
      expect(outcome).toBe(
        'ran "Update docs/user/setup.md to describe the new flag." to status failed instead of refusing it',
      );
      expect(written.join("")).toContain(
        'documentationRoots entries in .docsfab.json that grant no write root: "src/docs" (a code directory); named and new pages go only under docs/user/',
      );
      expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
      expect(await gitStatus(repository)).toBe("");
      expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    },
    testTimeoutMs(120_000),
  );

  it("keeps protected and mixed targets on the generic proposal refusal", async () => {
    const repository = await fixtureRepository(
      true,
      ["site/content/AGENTS.md", "src/guide.md"],
      ["site/content"],
    );
    const sourceBytes = await repositoryBytesSha256(repository);
    vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());
    for (const [instruction, message] of [
      [
        "Update site/content/AGENTS.md to describe the new flag.",
        "DocsFab cannot write site/content/AGENTS.md: a named page cannot be in a protected, hidden, code, or CI path, or be an agent instruction file such as AGENTS.md.",
      ],
      [
        "Update src/guide.md and site/content/AGENTS.md to describe the new flag.",
        "DocsFab cannot write src/guide.md: a named page must be under site/content/, the documentationRoots in .docsfab.json. DocsFab cannot write site/content/AGENTS.md: a named page cannot be in a protected, hidden, code, or CI path, or be an agent instruction file such as AGENTS.md. To write pages in another documentation directory, list it in documentationRoots in .docsfab.json.",
      ],
    ] as const) {
      await expectNamedPageRefusal(repository, instruction, {
        code: "proposal-scope-unsafe-target",
        message,
      });
      expect(harness.calls, instruction).toEqual([]);
      expect(await gitStatus(repository), instruction).toBe("");
      expect(await repositoryBytesSha256(repository), instruction).toBe(sourceBytes);
    }
  });

  // Owner amendment to Decision 8, option A (#1914 note 72942914).
  it(
    "runs named pages under configured documentation directories in a local run",
    async () => {
      const pages = [
        "site/content/en/docs/setup.md",
        "website/docs/intro.md",
        "examples/agents/README.md",
        "doc/setup.md",
      ];
      const repository = await fixtureRepository(true, pages, [
        "site/content/en/docs",
        "website/docs",
        "examples/agents",
        "doc",
      ]);
      const sourceBytes = await repositoryBytesSha256(repository);
      vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());
      for (const page of pages) {
        const instruction = `Update ${page} to describe the new flag.`;
        const outcome = await namedPageOutcome(
          repository,
          instruction,
          await temporaryDirectory("docsfab-widened-state-"),
        );
        // Admitted: the run reaches the planner, which this fixture stops.
        expect(outcome, page).toBe(`ran "${instruction}" to status failed instead of refusing it`);
      }
      expect(harness.calls.map((call) => call.step.id)).toEqual(
        pages.map(() => "plan-documentation"),
      );
      expect(await gitStatus(repository)).toBe("");
      expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    },
    testTimeoutMs(180_000),
  );

  // Owner decision on #1914 (note 72956288).
  it(
    "runs a request that names a page twice and asks for a change each time",
    async () => {
      const repository = await fixtureRepository(true, ["docs/install.md"]);
      const sourceBytes = await repositoryBytesSha256(repository);
      vi.stubEnv("DOCSFAB_KNOWLEDGE_DIR", await supportedCandidateKnowledgeDirectory());
      const instruction =
        "Update docs/install.md to add the --verbose flag. In docs/install.md, also fix the broken link.";
      const outcome = await namedPageOutcome(
        repository,
        instruction,
        await temporaryDirectory("docsfab-repeated-page-state-"),
      );
      // Admitted: the run reaches the planner, which this fixture stops.
      expect(outcome).toBe(`ran "${instruction}" to status failed instead of refusing it`);
      expect(harness.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
      expect(await gitStatus(repository)).toBe("");
      expect(await repositoryBytesSha256(repository)).toBe(sourceBytes);
    },
    testTimeoutMs(120_000),
  );
});

function evidenceContext(workspacePath: string, persistPatch: boolean) {
  return {
    runId: persistPatch ? "retained" : "inspect",
    repository: {
      sourcePath: workspacePath,
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspacePath,
    persistPatch,
  };
}

async function fixtureRepository(
  withProjectConfig: boolean,
  documentationPaths: readonly string[] = [],
  documentationRoots?: readonly string[],
): Promise<string> {
  const repository = await temporaryDirectory("docsfab-first-pass-repository-");
  await writeFile(join(repository, "README.md"), "# Fixture product\n\nA local CLI reference.\n");
  for (const path of documentationPaths) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), `# ${path}\n\nOriginal fixture content.\n`);
  }
  if (withProjectConfig) {
    await writeFile(
      join(repository, ".docsfab.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
          ...(documentationRoots ? { documentationRoots } : {}),
        },
        null,
        2,
      )}\n`,
    );
  }
  await initFixtureRepo(repository, {}, { branch: "main" });
  await git(repository, [
    "remote",
    "add",
    "origin",
    "ssh://git@gitlab.example.test/group/docs.git",
  ]);
  await git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return repository;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

async function removeTemporaryDirectory(path: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await listRunStoreTemporaryFiles(path)).toEqual([]);
      await rm(path, { recursive: true, force: true });
    },
    { timeout: RUN_STORE_WRITE_WAIT_MS, interval: RUN_STORE_WRITE_POLL_MS },
  );
}

async function listRunStoreTemporaryFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const next = join(directory, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith(".tmp")) found.push(next);
    }
  }
  await walk(root);
  return found;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function supportedCandidateKnowledgeDirectory(
  options: { approved?: boolean; recorded?: string; gatherCountPath?: string } = {},
): Promise<string> {
  const root = await temporaryDirectory("docsfab-supported-candidate-");
  const sourceDirectory = join(root, "src");
  await mkdir(sourceDirectory, { recursive: true });
  const snapshot = createKnowledgeAcceptedSnapshot({
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 3,
    status: options.approved ? "approved" : "candidate",
    claims: [
      {
        id: "CL-001",
        kind: "behavior",
        scope: "Fixture product",
        statement: SUPPORTED_BEHAVIOR,
        modelState: options.approved ? "canonical" : "candidate",
        evidenceIds: ["SRC-001"],
      },
    ],
    sources: [{ id: "SRC-001", locator: "readme:README.md" }],
    conflicts: [],
  });
  // With `recorded`, the gatherer writes the write roots the host handed it.
  const record = options.recorded
    ? `  await (await import("node:fs/promises")).writeFile(${JSON.stringify(options.recorded)}, JSON.stringify(input.authorizedWriteRoots ?? null));\n`
    : "";
  const count = options.gatherCountPath
    ? `  const fs = await import("node:fs/promises");\n  const previous = Number(await fs.readFile(${JSON.stringify(options.gatherCountPath)}, "utf8").catch(() => "0"));\n  await fs.writeFile(${JSON.stringify(options.gatherCountPath)}, String(previous + 1));\n`
    : "";
  await writeFile(
    join(sourceDirectory, "first-pass.mjs"),
    `export async function gatherRepositoryFirstPass(input) {\n${record}${count}  return ${JSON.stringify(
      {
        snapshot,
        projectId: "PRJ-001",
        modelVersionId: "MODEL-001",
        sourceCount: 1,
      },
      null,
      2,
    )};\n}\n`,
  );
  await writeFile(
    join(sourceDirectory, "first-pass-support.mjs"),
    `export * from ${JSON.stringify(
      pathToFileURL(join(runtimeRoot, "..", "knowledge", "src", "first-pass-support.mjs")).href,
    )};\n`,
  );
  return root;
}

async function routerSixPageCase(): Promise<{ instruction: string; targetPaths: string[] }> {
  const corpus = JSON.parse(
    await readFile(
      join(
        runtimeRoot,
        "test",
        "fixtures",
        "knowledge-resume-loop",
        "multi-page-first-use-corpus.json",
      ),
      "utf8",
    ),
  ) as { positiveCases: { id: string; instruction: string; targetPaths: string[] }[] };
  const found = corpus.positiveCases.find((item) => item.id === "router-six-page-update");
  if (!found) throw new Error("missing labeled ROUTER corpus case");
  return found;
}

function runRequest(
  repositoryPath: string,
  instruction: string,
  workflow: "create-documentation" | "update-documentation",
) {
  return {
    workflow,
    repositoryPath,
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    ...(workflow === "update-documentation"
      ? {
          comparisonRequest: { kind: "workspace" as const },
          readerSources: [
            { role: "changed-source" as const, path: "README.md" },
            { role: "current-documentation" as const, path: "README.md" },
            { role: "public-contract" as const, path: "README.md" },
          ],
        }
      : {}),
  } as const;
}

async function repositoryBytesSha256(repository: string): Promise<string> {
  const listed = await git(repository, ["ls-files", "-z"], { trim: false });
  const paths = listed.split("\0").filter(Boolean);
  const digest = createHash("sha256");
  for (const path of paths) {
    digest
      .update(path)
      .update("\0")
      .update(await readFile(join(repository, path)));
  }
  return digest.digest("hex");
}

async function gitStatus(repository: string): Promise<string> {
  return await git(repository, ["status", "--short"]);
}

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: validModelConfig,
  };
}
