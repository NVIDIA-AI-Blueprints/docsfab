// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";

import { bindHostOwnedEditorialProposalIdentityV1 } from "../src/artifacts/editorial-decision.js";
import { parseRunArguments } from "../src/cli.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { limit } from "../src/config/limits.js";
import { assembleMergedMrUpdate, MergedMrUpdateError } from "../src/cli/run/merged-mr-update.js";
import { createKnowledgeAcceptedSnapshot } from "../src/canon/from-knowledge-snapshot.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { createSourceToolDefinitions } from "../src/harness/source-tools.js";
import { editorialAssessmentEvidenceRefsV1 } from "../src/harness/pi.js";
import type { MergedMrPagePortV1 } from "../src/inputs/merged-mr-discovery.js";
import type { GitLabMergedMrDiffBundleV1 } from "../src/inputs/merged-mr-gitlab.js";
import {
  MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
  MergedMrInstructionError,
  parseMergedMrUpdateInstruction,
} from "../src/inputs/merged-mr-instruction.js";
import type { MergedMrRecordV1 } from "../src/inputs/merged-mr-selection.js";
import { bindDocumentationPlanProposal } from "../src/workflow-execution/plan-binding.js";
import { validModelConfig } from "./helpers.js";
import { verificationFixture, verificationResultFixture } from "./helpers/verification.js";
import { captureGitSnapshot } from "./support/execution-convergence.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { listedInventory } from "./support/source-listing.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();

afterEach(() => {
  process.exitCode = undefined;
});

function pagePort(
  items: readonly MergedMrRecordV1[],
  failure?: { code: string },
): MergedMrPagePortV1 {
  return {
    orderedDescendingByMergedAt: true,
    async fetchPage(page: number) {
      if (failure) {
        const error = new Error("injected GitLab failure");
        (error as { code: string }).code = failure.code;
        throw error;
      }
      if (page !== 1) return { items: [], nextPage: null };
      return { items: [...items], nextPage: null };
    },
  };
}

function orbitDiff(iid: number, truncated = false): GitLabMergedMrDiffBundleV1 {
  return {
    iid,
    truncated,
    pagesRead: 1,
    files: [
      {
        oldPath: "src/orbit.ts",
        newPath: "src/orbit.ts",
        diff: "@@ -1 +1 @@\n-export const option = '--old';\n+export const option = '--new';\n",
        collapsed: truncated,
        tooLarge: truncated,
        newFile: false,
        deletedFile: false,
        renamedFile: false,
      },
      {
        oldPath: "docs/cli.md",
        newPath: "docs/cli.md",
        diff: "@@ -3 +3 @@\n-The public option is --old.\n+The public option is --old.\n",
        collapsed: false,
        tooLarge: false,
        newFile: false,
        deletedFile: false,
        renamedFile: false,
      },
    ],
  };
}

class MergedMrUpdateHarness implements AgentHarness {
  public readonly inputs: HarnessStepInput[] = [];
  public readonly listedPaths: string[] = [];
  public readonly toolReads: string[] = [];

  public constructor(
    private readonly options: {
      readonly candidate: "update" | "no-change";
      readonly impactSource?: { readonly uri: string; readonly sha256: string };
      readonly skipSourceReads?: boolean;
    },
  ) {}

  public get stepIds(): string[] {
    return this.inputs.map((input) => input.step.id);
  }

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.inputs.push(input);
    if (
      input.sourceReader &&
      input.step.id === "plan-documentation" &&
      !this.options.skipSourceReads
    ) {
      const definitions = createSourceToolDefinitions({
        reader: input.sourceReader,
        recordFailure: () => undefined,
      });
      const list = definitions.find((entry) => entry.name === "docsfab_list_sources")!;
      const read = definitions.find((entry) => entry.name === "docsfab_read_source")!;
      const listed = (await list.execute("list-1", {})) as { content: Array<{ text: string }> };
      const inventory = { spans: listedInventory(listed.content[0]!.text) };
      const seen = new Set<string>();
      let call = 0;
      for (const span of inventory.spans) {
        this.listedPaths.push(span.repositoryPath!);
        if (seen.has(span.observationId)) continue;
        seen.add(span.observationId);
        call += 1;
        const result = (await read.execute(`read-${call}`, {
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        })) as { content: Array<{ text: string }> };
        this.toolReads.push((JSON.parse(result.content[0]!.text) as { text: string }).text);
      }
    }
    const reference =
      input.step.id === "plan-documentation"
        ? input.editorialEvidenceRefs?.[0]
        : editorialAssessmentEvidenceRefsV1(input)[0];
    if (!reference) throw new Error("missing admitted reader evidence");
    if (input.step.id === "plan-documentation") {
      const update = this.options.candidate === "update";
      const impactSource = this.options.impactSource;
      return {
        summary: update
          ? "The merged merge request requires one documentation update."
          : "The requested merged-MR window does not require a documentation change.",
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
          candidate: this.options.candidate,
          rationale: update
            ? "The admitted merged-MR diffs change the public option while the guide still says --old."
            : "The requested window contained no matching merge requests.",
          evidenceRefs: [reference],
          limitations: update ? [] : ["merged-mr-window-exhausted-empty"],
          impactBasis: {
            kind: update ? "public-behavior-change" : "unknown",
            rationale: update
              ? "The public option source and current documentation disagree."
              : "No merge requests landed in the requested window.",
            evidence_refs: update && impactSource ? [impactSource] : [],
          },
        },
      };
    }
    if (input.step.id === "write-documentation") {
      await writeFile(
        join(input.repositoryPath, "docs/cli.md"),
        "# Orbit CLI\n\nThe public option is now --new.\n",
      );
      return { summary: "Updated the one source-bound documentation page." };
    }
    if (input.step.id === "test-audience-understanding") {
      return {
        summary: "No authorized representative audience fixture was available.",
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "not-applicable",
          rationale:
            "The candidate was retained, but the run had no authorized representative audience fixture.",
          evidenceRefs: [reference],
          limitations: ["audience-check-unavailable"],
          recommendation: null,
        },
      };
    }
    if (
      input.step.id === "derive-source-obligations" ||
      input.step.id === "verify-technical-accuracy" ||
      input.step.id === "review-documentation" ||
      input.step.id === "evaluate-document-quality"
    ) {
      return {
        summary:
          input.step.id === "review-documentation"
            ? JSON.stringify({ verdict: "pass", issues: [] })
            : `${input.step.id} accepted the source-bound candidate.`,
        ...(input.step.id === "derive-source-obligations" ? await verificationFixture(input) : {}),
        ...(input.step.id === "verify-technical-accuracy"
          ? { verificationResult: verificationResultFixture(["docs/cli.md"]) }
          : {}),
        ...(input.step.id === "evaluate-document-quality" && input.qualityProfileSelection
          ? { qualityArtifactCandidate: await authoringFixtureCandidateForInput(input) }
          : {}),
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "accepted",
          rationale: `${input.step.id} independently inspected the retained source and candidate evidence.`,
          evidenceRefs: [reference],
          limitations: [],
          recommendation: null,
        },
      };
    }
    return { summary: `${input.step.id} completed its deterministic check.` };
  }
}

async function repositoryFixture() {
  const repository = await roots.create("docsfab-merged-mr-update-repo-");
  const stateDirectory = await roots.create("docsfab-merged-mr-update-state-");
  const head = await initFixtureRepo(
    repository,
    {
      "docs/cli.md": "# Orbit CLI\n\nThe public option is --old.\n",
      "src/orbit.ts": "export const option = '--new';\n",
      ".docsfab.json": `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    },
    { branch: "main", message: "head" },
  );
  await git(repository, [
    "remote",
    "add",
    "origin",
    "ssh://git@gitlab.example.invalid/docs/orbit.git",
  ]);
  await git(repository, ["update-ref", "refs/remotes/origin/main", head]);
  const canonSnapshotPath = join(stateDirectory, "accepted-knowledge.json");
  await writeFile(
    canonSnapshotPath,
    `${JSON.stringify(
      createKnowledgeAcceptedSnapshot({
        projectId: "ORBIT",
        modelVersionId: "ORBIT-CLI-V2",
        streamVersion: 1,
        status: "approved",
        claims: [
          {
            id: "ORBIT-CLI-OPTION",
            kind: "behavior",
            scope: "docs/cli.md",
            statement: "The Orbit CLI public option changed to --new.",
            modelState: "canonical",
            evidenceIds: ["ORBIT-SOURCE"],
          },
        ],
        sources: [{ id: "ORBIT-SOURCE", locator: "src/orbit.ts" }],
        conflicts: [],
      }),
      null,
      2,
    )}\n`,
  );
  const orbitSha256 = createHash("sha256")
    .update(await readFile(join(repository, "src/orbit.ts")))
    .digest("hex");
  const config: DocsFabConfig = {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory: join(stateDirectory, "runs"),
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: validModelConfig,
  };
  return {
    repository,
    head,
    config,
    canonSnapshotPath,
    impactSource: { uri: "src/orbit.ts", sha256: orbitSha256 },
  };
}

function mergedRecord(iid: number, sha: string): MergedMrRecordV1 {
  return {
    iid,
    state: "merged",
    mergedAt: "2026-09-14T18:00:00.000Z",
    targetBranch: "main",
    mergeCommitSha: sha,
    squashCommitSha: null,
    sourceBranch: "feature/orbit",
    title: "Change the public option",
    description: "User-visible CLI flag.",
    url: null,
  };
}

describe("date-scoped merged-MR UPDATE instruction parsing (#896)", () => {
  it("turns the September 14 2026 Los Angeles reproduction into a half-open window", () => {
    const parsed = parseMergedMrUpdateInstruction(MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION);
    expect(parsed.kind).toBe("date-window");
    if (parsed.kind !== "date-window") throw new Error("expected date-window");
    expect(parsed.request.targetBranch).toBe("main");
    expect(parsed.request.window).toMatchObject({
      timeZone: "America/Los_Angeles",
      startDate: "2026-09-14",
      endDate: "2026-09-14",
      startUtc: "2026-09-14T07:00:00.000Z",
      endUtc: "2026-09-15T07:00:00.000Z",
    });
  });

  it("does not guess a time zone or treat an ordinary UPDATE as discovery", () => {
    expect(
      parseMergedMrUpdateInstruction("Update the authentication change across the overview."),
    ).toEqual({
      kind: "not-applicable",
    });
    expect(() =>
      parseMergedMrUpdateInstruction("Review the MRs merged into main on September 14, 2026."),
    ).toThrow(MergedMrInstructionError);
    expect(() =>
      parseMergedMrUpdateInstruction(
        "Review MR !12 merged into main on September 14, 2026, using America/Los_Angeles time.",
      ),
    ).toThrow(/explicit merge-request list or a date window, never both/u);
  });

  it("parses the instruction-only CLI shape and rejects competing selectors", () => {
    const parsed = parseRunArguments([
      "update-documentation",
      "--repo",
      "repository",
      "--patch-only",
      "--instruction",
      MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
    ]);
    expect(parsed.allowWrite).toBe(true);
    expect(parsed.draftMr).toBe(false);
    expect(parsed.mergedMrSelection).toMatchObject({
      kind: "date-window",
      targetBranch: "main",
    });
    expect(() =>
      parseRunArguments([
        "update-documentation",
        "--instruction",
        MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        "--reader-source",
        "changed-source=src/orbit.ts",
      ]),
    ).toThrow(/Do not combine it with --reader-source/u);
    expect(() =>
      parseRunArguments([
        "update-documentation",
        "--instruction",
        MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        "--comparison-workspace",
      ]),
    ).toThrow(/Do not combine it with --comparison-base or --comparison-workspace/u);
  });
});

describe("date-scoped merged-MR UPDATE assembly (#896)", () => {
  it("discovers selected MRs, binds diffs, and keeps reader_job under 1024 code points", async () => {
    const fixture = await repositoryFixture();
    const iid = 5501;
    const assembly = await assembleMergedMrUpdate({
      request: {
        workflow: "update-documentation",
        instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        repositoryPath: fixture.repository,
        revision: fixture.head,
        allowWrite: true,
        draftMr: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      workspace: {
        sourcePath: fixture.repository,
        path: fixture.repository,
        requestedRevision: fixture.head,
        revision: fixture.head,
      } as never,
      options: {
        mergedMrPagePort: pagePort([mergedRecord(iid, fixture.head)]),
        fetchMergedMrDiffs: async () => orbitDiff(iid),
        presentMergedMrRevisions: [fixture.head],
      },
    });
    expect(assembly?.discovery.windowCovered).toBe(true);
    expect(assembly?.discovery.selected.map((entry) => entry.iid)).toEqual([iid]);
    expect(assembly?.readerContextInput.reader_job.length).toBeLessThanOrEqual(1024);
    expect(assembly?.readerContextInput.reader_job).toMatch(/merged into main on 2026-09-14/u);
    expect(
      assembly?.readerContextInput.required_content.some((row) => row.includes("MR !5501")),
    ).toBe(true);
    expect(
      assembly?.readerContextInput.required_content.some((row) =>
        row.includes("export const option = '--new'"),
      ),
    ).toBe(true);
    expect(assembly?.readerSources).toEqual(
      expect.arrayContaining([
        { role: "public-contract", path: "src/orbit.ts" },
        { role: "changed-source", path: "src/orbit.ts" },
        { role: "current-documentation", path: "docs/cli.md" },
      ]),
    );
    expect(assembly?.sourceDiscovery).toBeNull();
  });

  it("omits missing, oversize, and export-excluded reader paths instead of nominating them", async () => {
    const fixture = await repositoryFixture();
    const iid = 5502;
    await writeFile(join(fixture.repository, "src/oversize-orbit.ts"), "x".repeat(65 * 1024));
    const assembly = await assembleMergedMrUpdate({
      request: {
        workflow: "update-documentation",
        instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        repositoryPath: fixture.repository,
        revision: fixture.head,
        allowWrite: true,
        draftMr: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      workspace: {
        sourcePath: fixture.repository,
        path: fixture.repository,
        requestedRevision: fixture.head,
        revision: fixture.head,
      } as never,
      options: {
        mergedMrPagePort: pagePort([mergedRecord(iid, fixture.head)]),
        fetchMergedMrDiffs: async () => ({
          ...orbitDiff(iid),
          files: [
            ...orbitDiff(iid).files,
            {
              oldPath: "src/deleted-orbit.ts",
              newPath: "src/deleted-orbit.ts",
              diff: "@@ -1 +0,0 @@\n-export const retired = true;\n",
              collapsed: false,
              tooLarge: false,
              newFile: false,
              deletedFile: true,
              renamedFile: false,
            },
            {
              oldPath: "src/oversize-orbit.ts",
              newPath: "src/oversize-orbit.ts",
              diff: "@@ -1 +1 @@\n-export const payload = '';\n+export const payload = 'x';\n",
              collapsed: false,
              tooLarge: false,
              newFile: false,
              deletedFile: false,
              renamedFile: false,
            },
            {
              oldPath: "node_modules/orbit/index.js",
              newPath: "node_modules/orbit/index.js",
              diff: "@@ -1 +1 @@\n-old\n+new\n",
              collapsed: false,
              tooLarge: false,
              newFile: false,
              deletedFile: false,
              renamedFile: false,
            },
          ],
        }),
        presentMergedMrRevisions: [fixture.head],
      },
    });
    expect(assembly?.readerSources).toEqual(
      expect.arrayContaining([
        { role: "public-contract", path: "src/orbit.ts" },
        { role: "changed-source", path: "src/orbit.ts" },
        { role: "current-documentation", path: "docs/cli.md" },
      ]),
    );
    expect(assembly?.readerSources.map((source) => source.path)).not.toContain(
      "src/deleted-orbit.ts",
    );
    expect(assembly?.readerSources.map((source) => source.path)).not.toContain(
      "src/oversize-orbit.ts",
    );
    expect(assembly?.readerSources.map((source) => source.path)).not.toContain(
      "node_modules/orbit/index.js",
    );
    expect(assembly?.readerContextInput.known_limitations).toContain(
      "merged-mr-reader-sources-bounded",
    );
  });

  it("never nominates a reader file that holds a configured credential, and nominates a credential shape (#1807)", async () => {
    const fixture = await repositoryFixture();
    const iid = 5503;
    // A configured value that does not look like a credential, and a
    // credential shape that is not configured.
    const credential = configureCredential(["harbor", plantedCredentialValue(91, 24)].join("-"));
    const shaped = ["glpat", plantedCredentialValue(92, 20)].join("-");
    await writeFile(
      join(fixture.repository, "src/keys-orbit.ts"),
      `export const key = "${credential}";\n`,
    );
    await writeFile(
      join(fixture.repository, "src/shaped-orbit.ts"),
      `export const token = "${shaped}";\n`,
    );
    const changed = (path: string) => ({
      oldPath: path,
      newPath: path,
      diff: "@@ -1 +1 @@\n-export const value = '';\n+export const value = 'x';\n",
      collapsed: false,
      tooLarge: false,
      newFile: false,
      deletedFile: false,
      renamedFile: false,
    });
    const assembly = await assembleMergedMrUpdate({
      request: {
        workflow: "update-documentation",
        instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        repositoryPath: fixture.repository,
        revision: fixture.head,
        allowWrite: true,
        draftMr: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      workspace: {
        sourcePath: fixture.repository,
        path: fixture.repository,
        requestedRevision: fixture.head,
        revision: fixture.head,
      } as never,
      options: {
        mergedMrPagePort: pagePort([mergedRecord(iid, fixture.head)]),
        fetchMergedMrDiffs: async () => ({
          ...orbitDiff(iid),
          files: [
            ...orbitDiff(iid).files,
            changed("src/keys-orbit.ts"),
            changed("src/shaped-orbit.ts"),
          ],
        }),
        presentMergedMrRevisions: [fixture.head],
      },
    });
    const nominated = assembly?.readerSources.map((source) => source.path) ?? [];
    expect(nominated).toContain("src/shaped-orbit.ts");
    expect(nominated).not.toContain("src/keys-orbit.ts");
  });

  it("routes through the released GitLab discovery service when a numeric project id is supplied", async () => {
    const fixture = await repositoryFixture();
    const iid = 5501;
    const assembly = await assembleMergedMrUpdate({
      request: {
        workflow: "update-documentation",
        instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        repositoryPath: fixture.repository,
        revision: fixture.head,
        allowWrite: true,
        draftMr: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      workspace: {
        sourcePath: fixture.repository,
        path: fixture.repository,
        requestedRevision: fixture.head,
        revision: fixture.head,
      } as never,
      options: {
        mergedMrPagePort: pagePort([mergedRecord(iid, fixture.head)]),
        mergedMrProject: {
          host: "gitlab.example.test",
          projectId: 437040,
          projectPath: "docs/orbit",
        },
        fetchMergedMrDiffs: async () => orbitDiff(iid),
        presentMergedMrRevisions: [fixture.head],
      },
    });
    expect(assembly?.sourceDiscovery?.scope.projectId).toBe(437040);
    expect(assembly?.sourceDiscovery?.descriptors).toHaveLength(1);
    expect(assembly?.discovery.selected[0]?.locator).toBe(
      "gitlab-mr:v1:host=gitlab.example.test:project=437040:mr=5501",
    );
  });

  it("distinguishes a fully exhausted empty window from a later-page retrieval failure", async () => {
    const fixture = await repositoryFixture();
    const request = {
      workflow: "update-documentation" as const,
      instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
      repositoryPath: fixture.repository,
      revision: fixture.head,
      allowWrite: true,
      draftMr: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    };
    const workspace = {
      sourcePath: fixture.repository,
      path: fixture.repository,
      requestedRevision: fixture.head,
      revision: fixture.head,
    } as never;
    const empty = await assembleMergedMrUpdate({
      request,
      workspace,
      options: {
        mergedMrPagePort: pagePort([
          {
            iid: 2901,
            state: "merged",
            mergedAt: "2026-09-12T11:00:00.000Z",
            targetBranch: "main",
            mergeCommitSha: fixture.head,
            squashCommitSha: null,
          },
        ]),
        fetchMergedMrDiffs: async () => {
          throw new Error("diffs must not run for an empty window");
        },
      },
    });
    expect(empty?.discovery.disposition).toBe("exhausted-empty");
    expect(empty?.discovery.windowCovered).toBe(true);
    expect(empty?.diffs).toEqual([]);
    await expect(
      assembleMergedMrUpdate({
        request,
        workspace,
        options: {
          mergedMrPagePort: pagePort([], { code: "authentication" }),
        },
      }),
    ).rejects.toMatchObject({
      name: "MergedMrUpdateError",
      disposition: "page-failed",
      failureCode: "authentication",
    });
  });
});

describe("instruction-only merged-MR UPDATE CLI (#896)", () => {
  it(
    "produces a scoped documentation patch without SHAs or --reader-source and leaves the checkout clean",
    async () => {
      const fixture = await repositoryFixture();
      const before = await captureGitSnapshot(fixture.repository);
      const originalDocs = await readFile(join(fixture.repository, "docs/cli.md"), "utf8");
      const iid = 5501;
      const harness = new MergedMrUpdateHarness({
        candidate: "update",
        impactSource: fixture.impactSource,
      });
      const record = await executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: fixture.repository,
          revision: fixture.head,
          instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
          canonSnapshotPath: fixture.canonSnapshotPath,
          allowWrite: true,
          draftMr: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        fixture.config,
        {
          silent: true,
          harness,
          mergedMrPagePort: pagePort([mergedRecord(iid, fixture.head)]),
          fetchMergedMrDiffs: async () => orbitDiff(iid),
          presentMergedMrRevisions: [fixture.head],
        },
      );
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
      const readerInput = (
        harness.inputs[0]?.readerTaskContext as
          | { readerContextInput?: { required_content?: string[]; reader_job?: string } }
          | undefined
      )?.readerContextInput;
      expect(readerInput?.reader_job).toMatch(/merged into main on 2026-09-14/u);
      expect(readerInput?.required_content?.some((row) => row.includes(`MR !${iid}`))).toBe(true);
      expect(
        readerInput?.required_content?.some((row) => row.includes("export const option = '--new'")),
      ).toBe(true);
      expect(harness.inputs[0]?.sourceBinding).toMatchObject({ kind: "source-binding" });
      expect(harness.listedPaths).toContain(`gitlab-mr/${iid}.diff`);
      expect(harness.toolReads.some((text) => text.includes("export const option = '--new'"))).toBe(
        true,
      );
      expect(await readFile(join(fixture.repository, "docs/cli.md"), "utf8")).toBe(originalDocs);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "writes after host-opened merged-MR diffs even when the planner does not re-read them",
    async () => {
      const fixture = await repositoryFixture();
      const iid = 5501;
      const harness = new MergedMrUpdateHarness({
        candidate: "update",
        impactSource: fixture.impactSource,
        skipSourceReads: true,
      });
      const record = await executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: fixture.repository,
          revision: fixture.head,
          instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
          canonSnapshotPath: fixture.canonSnapshotPath,
          allowWrite: true,
          draftMr: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        fixture.config,
        {
          silent: true,
          harness,
          mergedMrPagePort: pagePort([mergedRecord(iid, fixture.head)]),
          fetchMergedMrDiffs: async () => orbitDiff(iid),
          presentMergedMrRevisions: [fixture.head],
        },
      );
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
      expect(harness.listedPaths).toEqual([]);
      expect(harness.toolReads).toEqual([]);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it("keeps an exhausted empty window from becoming a retrieval failure or a dirty checkout", async () => {
    const fixture = await repositoryFixture();
    const before = await captureGitSnapshot(fixture.repository);
    const harness = new MergedMrUpdateHarness({ candidate: "no-change" });
    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: true,
        draftMr: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      {
        silent: true,
        harness,
        mergedMrPagePort: pagePort([
          {
            iid: 2901,
            state: "merged",
            mergedAt: "2026-09-16T11:00:00.000Z",
            targetBranch: "main",
            mergeCommitSha: fixture.head,
            squashCommitSha: null,
          },
        ]),
        fetchMergedMrDiffs: async () => {
          throw new Error("diffs must not run for an empty window");
        },
      },
    );
    expect(["succeeded", "needs-input"]).toContain(record?.status);
    expect(record?.changes).toBeUndefined();
    expect(harness.inputs[0]?.sourceBinding).toBeUndefined();
    expect(
      (
        harness.inputs[0]?.readerTaskContext as {
          readerContextInput?: { known_limitations?: string[] };
        }
      )?.readerContextInput?.known_limitations,
    ).toContain("merged-mr-window-exhausted-empty");
    expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
  }, 20_000);

  it("fails closed when diffs are unavailable and does not invent complete coverage", async () => {
    const fixture = await repositoryFixture();
    await expect(
      executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: fixture.repository,
          revision: fixture.head,
          instruction: MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
          canonSnapshotPath: fixture.canonSnapshotPath,
          allowWrite: true,
          draftMr: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        fixture.config,
        {
          silent: true,
          harness: new MergedMrUpdateHarness({ candidate: "update" }),
          mergedMrPagePort: pagePort([mergedRecord(9801, fixture.head)]),
          fetchMergedMrDiffs: async () => {
            const error = new Error("injected diff failure");
            (error as { code: string }).code = "network";
            throw error;
          },
          presentMergedMrRevisions: [fixture.head],
        },
      ),
    ).rejects.toBeInstanceOf(MergedMrUpdateError);
  }, 20_000);
});

describe("host-owned merged-MR editorial identity", () => {
  it("caps duplicate oversized impact refs and pairs no-change with kind none", () => {
    const digest = "a".repeat(64);
    const sources = Array.from({ length: 40 }, (_, index) => ({
      uri: `src/orbit-${String(index).padStart(2, "0")}.ts`,
      sha256: digest,
    }));
    const artifact = {
      kind: "context-packet" as const,
      schemaVersion: 1 as const,
      digest: "b".repeat(64),
      repositoryRevision: "c".repeat(40),
      repositoryContentDigest: "d".repeat(64),
    };
    const rationale =
      "Current public pages already cover the admitted merged-MR evidence without a further edit.";
    const bound = bindHostOwnedEditorialProposalIdentityV1(
      {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "no-change",
        rationale,
        evidenceRefs: [artifact],
        limitations: [],
        impactBasis: {
          kind: "documentation-defect",
          rationale,
          evidence_refs: [...sources, sources[0]],
        },
      },
      { artifactEvidenceRefs: [artifact], sourceEvidence: sources },
    ) as {
      candidate: string;
      impactBasis: { kind: string; evidence_refs: Array<{ uri: string; sha256: string }> };
    };
    expect(bound.candidate).toBe("no-change");
    expect(bound.impactBasis.kind).toBe("none");
    expect(bound.impactBasis.evidence_refs).toHaveLength(32);
    expect(bound.impactBasis.evidence_refs[0]).toEqual(sources[0]);
    expect(bound.impactBasis.evidence_refs.at(-1)).toEqual(sources[31]);
  });
});
