// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Merged-MR diff evidence for REVIEW and CREATE, through the binding path
 * `update-documentation` uses (`assembleMergedMrUpdate`,
 * `issueMergedMrCliSourceEvidence`, `acquireMergedMrDiffBinding`).
 * `restructure-documentation` stays ineligible: a reordering request has no
 * changed-path set to derive scope from.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRunArguments } from "../src/cli.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import {
  assembleMergedMrUpdate,
  issueMergedMrCliSourceEvidence,
} from "../src/cli/run/merged-mr-update.js";
import { sourceReadBudgetForModel } from "../src/cli/run/source-acquisition.js";
import { limit } from "../src/config/limits.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { createSourceToolDefinitions } from "../src/harness/source-tools.js";
import {
  gitlabMergedMrDiffExtractorAdapter,
  renderMergedMrDiffOriginal,
} from "../src/inputs/merged-mr-evidence.js";
import type { MergedMrPagePortV1 } from "../src/inputs/merged-mr-discovery.js";
import type { GitLabMergedMrDiffBundleV1 } from "../src/inputs/merged-mr-gitlab.js";
import type { MergedMrRecordV1 } from "../src/inputs/merged-mr-selection.js";
import { extractSourceRepresentation } from "../src/inputs/source-extraction.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
} from "../src/workflow-execution/source-obligation.js";
import { captureGitSnapshot, runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { sourceObligationProposalFixture, verificationFixture } from "./helpers/verification.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { listedInventory } from "./support/source-listing.js";

const roots = temporaryRoots();

const MERGED_MR_INSTRUCTION =
  "Assess the MRs merged into main on September 14, 2026, using America/Los_Angeles time. " +
  "Identify what documentation this change needs, if anything, and report evidence gaps honestly.";

function pagePort(items: readonly MergedMrRecordV1[]): MergedMrPagePortV1 {
  return {
    orderedDescendingByMergedAt: true,
    async fetchPage(page: number) {
      if (page !== 1) return { items: [], nextPage: null };
      return { items: [...items], nextPage: null };
    },
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
    sourceBranch: "feature/new-flag",
    title: "Add the --format flag",
    description: "User-visible CLI flag.",
    url: null,
  };
}

const FEATURE_DIFF_MARKER = "export const format = " + "'--json';";

function featureDiff(iid: number): GitLabMergedMrDiffBundleV1 {
  return {
    iid,
    truncated: false,
    pagesRead: 1,
    files: [
      {
        oldPath: "src/feature.ts",
        newPath: "src/feature.ts",
        diff: "Added " + FEATURE_DIFF_MARKER + " to src/feature.ts.",
        collapsed: false,
        tooLarge: false,
        newFile: false,
        deletedFile: false,
        renamedFile: false,
      },
    ],
  };
}

describe("merged-MR diff evidence eligibility (#1086)", () => {
  it("binds for review-documentation and create-documentation the same way it does for update-documentation", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const iid = 7001;
    for (const workflow of ["review-documentation", "create-documentation"] as const) {
      const assembly = await assembleMergedMrUpdate({
        request: {
          workflow,
          instruction: MERGED_MR_INSTRUCTION,
          repositoryPath: fixture.repository,
          revision: fixture.revision,
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
          requestedRevision: fixture.revision,
          revision: fixture.revision,
        } as never,
        options: {
          mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
          fetchMergedMrDiffs: async () => featureDiff(iid),
          presentMergedMrRevisions: [fixture.revision],
        },
      });
      expect(assembly?.discovery.windowCovered).toBe(true);
      expect(assembly?.discovery.selected.map((entry) => entry.iid)).toEqual([iid]);
      expect(assembly?.diffs).toHaveLength(1);
    }
  });

  it("leaves restructure-documentation ineligible: no discovery is attempted at all", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const assembly = await assembleMergedMrUpdate({
      request: {
        workflow: "restructure-documentation",
        instruction: MERGED_MR_INSTRUCTION,
        repositoryPath: fixture.repository,
        revision: fixture.revision,
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
        requestedRevision: fixture.revision,
        revision: fixture.revision,
      } as never,
      options: {
        mergedMrPagePort: {
          orderedDescendingByMergedAt: true,
          async fetchPage() {
            throw new Error("merged-MR discovery must never run for restructure-documentation");
          },
        },
      },
    });
    expect(assembly).toBeUndefined();
  });

  it("leaves the CLI-level mergedMrSelection parse path untouched for review and create", () => {
    for (const workflow of ["review-documentation", "create-documentation"] as const) {
      const parsed = parseRunArguments([
        workflow,
        "--repo",
        "repository",
        "--instruction",
        MERGED_MR_INSTRUCTION,
      ]);
      expect(parsed.mergedMrSelection).toBeUndefined();
      expect(parsed.instruction).toBe(MERGED_MR_INSTRUCTION);
    }
  });
});

describe("create-documentation merged-MR diff CLI (#1086)", () => {
  it(
    "reads the merged-MR diff through docsfab_read_source, authors from it, and leaves the checkout clean",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const before = await captureGitSnapshot(fixture.repository);
      const iid = 7002;
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const instruction = "Create the documentation this change needs. " + MERGED_MR_INSTRUCTION;

      const record = await executeRunRequest(
        {
          workflow: "create-documentation",
          instruction,
          repositoryPath: fixture.repository,
          revision: "HEAD",
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
          mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
          fetchMergedMrDiffs: async () => featureDiff(iid),
          presentMergedMrRevisions: [fixture.revision],
        },
      );

      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(model.sawReaderOn).toContain("plan-documentation");
      expect(model.listedPaths).toContain("gitlab-mr/" + iid + ".diff");
      expect(model.toolReads.some((text) => text.includes(FEATURE_DIFF_MARKER))).toBe(true);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "mints no source binding and asks nothing of the reader when the instruction names no merged-MR window",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const record = await executeRunRequest(
        {
          workflow: "create-documentation",
          instruction: "Create docs/whats-new.md describing the release notes for developers.",
          repositoryPath: fixture.repository,
          revision: "HEAD",
          allowWrite: true,
          sourcePaths: [HTML_SOURCE_PATH],
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(model.listedPaths.some((path) => path.startsWith("gitlab-mr/"))).toBe(false);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );
});

describe("a merged-MR diff with a chunk holding a configured credential (#1809)", () => {
  // One of DocsFab's own configured credentials for each test: only that is
  // withheld; a credential shape alone is read (#1807).
  const CONFIGURED_KEY = plantedCredentialValue(98, 32);
  const KEY_MARKER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  configureCredentialsForEachTest(CONFIGURED_KEY);

  /** About 6 KB of diff lines; line 60, past the reader-context clip, carries `key`. */
  function keyedDiff(iid: number, key = CONFIGURED_KEY): GitLabMergedMrDiffBundleV1 {
    const lines = Array.from({ length: 96 }, (_, index) =>
      index === 60
        ? `+Place the TLS key ${key} in the key file.`
        : `+ Line ${String(index).padStart(2, "0")} of the changed guide.`.padEnd(64, "."),
    );
    return {
      iid,
      truncated: false,
      pagesRead: 1,
      files: [
        {
          oldPath: "docs/guide.md",
          newPath: "docs/guide.md",
          diff: lines.join("\n"),
          collapsed: false,
          tooLarge: false,
          newFile: false,
          deletedFile: false,
          renamedFile: false,
        },
      ],
    };
  }

  it("binds, seeds every other span as read, and reports the withheld chunk as unread", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const iid = 7004;
    const instruction = "Create the documentation this change needs. " + MERGED_MR_INSTRUCTION;
    const options = {
      mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
      fetchMergedMrDiffs: async () => keyedDiff(iid),
      presentMergedMrRevisions: [fixture.revision],
    };
    // The diff's spans, as the host extracts the rendered original.
    const assembly = await assembleMergedMrUpdate({
      request: {
        workflow: "create-documentation",
        instruction,
        repositoryPath: fixture.repository,
        revision: fixture.revision,
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
        requestedRevision: fixture.revision,
        revision: fixture.revision,
      } as never,
      options,
    });
    const original = renderMergedMrDiffOriginal(
      assembly!.discovery.selected[0]!,
      assembly!.diffs[0]!,
    );
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: gitlabMergedMrDiffExtractorAdapter,
      bytes: original.bytes,
      mediaType: "text/plain",
    });
    const spanText = (span: { startByte: number; endByte: number }) =>
      Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8");
    const keyed = representation.spans.filter((span) => spanText(span).includes(CONFIGURED_KEY));
    expect(keyed).toHaveLength(1);
    expect(representation.spans.length).toBeGreaterThan(keyed.length + 1);
    const totalBytes = representation.spans.reduce(
      (total, span) => total + (span.endByte - span.startByte),
      0,
    );
    const withheldBytes = keyed[0]!.endByte - keyed[0]!.startByte;

    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [HTML_SOURCE_PATH],
    });
    const record = await executeRunRequest(
      {
        workflow: "create-documentation",
        instruction,
        repositoryPath: fixture.repository,
        revision: "HEAD",
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver, ...options },
    );

    // The bind did not fail on the key, and the run went on to write.
    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(model.writerCalls).toBe(1);
    // Seeding read every span but the key's, so the write step had nothing
    // left to read into its prompt: its only planned span was withheld.
    expect(model.hostReads.filter((source) => source.stepId === "write-documentation")).toEqual([]);
    expect(
      (record?.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual([
      `source-read-partial: gitlab-mr/${iid}.diff was read ${totalBytes - withheldBytes} of ${totalBytes} bytes when step write-documentation started writing; the rest of it was not read, including ${withheldBytes} bytes the credential screen withheld.`,
    ]);
  }, 60_000);

  it("reads a chunk with only a key banner like the rest of the diff, and runs on (#1807)", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const iid = 7005;
    const instruction = "Create the documentation this change needs. " + MERGED_MR_INSTRUCTION;
    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [HTML_SOURCE_PATH],
    });
    const record = await executeRunRequest(
      {
        workflow: "create-documentation",
        instruction,
        repositoryPath: fixture.repository,
        revision: "HEAD",
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(fixture.stateDirectory),
      {
        silent: true,
        executionHarness: model,
        skillResolver,
        mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
        fetchMergedMrDiffs: async () => keyedDiff(iid, KEY_MARKER),
        presentMergedMrRevisions: [fixture.revision],
      },
    );

    // A credential shape is the maintainers' to judge: nothing is withheld,
    // seeding reads the whole diff, and the run writes.
    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(model.writerCalls).toBe(1);
    expect(
      (record?.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual([]);
  }, 60_000);
});

describe("merged-MR diff budgets through the CLI (#1809, #1932)", () => {
  const instruction = "Create the documentation this change needs. " + MERGED_MR_INSTRUCTION;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function assembleRequest(fixture: { repository: string; revision: string }) {
    return {
      request: {
        workflow: "create-documentation" as const,
        instruction,
        repositoryPath: fixture.repository,
        revision: fixture.revision,
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
        requestedRevision: fixture.revision,
        revision: fixture.revision,
      } as never,
    };
  }

  /** One changed file whose diff is `lines` lines of 64 bytes. */
  function longDiff(iid: number, lines: number): GitLabMergedMrDiffBundleV1 {
    return {
      iid,
      truncated: false,
      pagesRead: 1,
      files: [
        {
          oldPath: "docs/guide.md",
          newPath: "docs/guide.md",
          diff: Array.from({ length: lines }, (_, index) =>
            `+ Line ${String(index).padStart(6, "0")} of the changed guide.`.padEnd(64, "."),
          ).join("\n"),
          collapsed: false,
          tooLarge: false,
          newFile: false,
          deletedFile: false,
          renamedFile: false,
        },
      ],
    };
  }

  /** The rendered original's byte length, the size extraction observes. */
  async function renderedBytes(
    fixture: { repository: string; revision: string },
    options: Parameters<typeof assembleMergedMrUpdate>[0]["options"],
  ): Promise<number> {
    const assembly = await assembleMergedMrUpdate({ ...assembleRequest(fixture), options });
    return renderMergedMrDiffOriginal(assembly!.discovery.selected[0]!, assembly!.diffs[0]!).bytes
      .byteLength;
  }

  async function runCreate(
    fixture: { repository: string; revision: string; stateDirectory: string },
    options: Parameters<typeof assembleMergedMrUpdate>[0]["options"],
  ) {
    return executeRunRequest(
      {
        workflow: "create-documentation",
        instruction,
        repositoryPath: fixture.repository,
        revision: "HEAD",
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(fixture.stateDirectory),
      {
        silent: true,
        executionHarness: new SourceToolHarness({
          readOnSkill: "plan-documentation",
          planSourcePaths: [HTML_SOURCE_PATH],
        }),
        skillResolver,
        ...options,
      },
    );
  }

  it("forwards the read budget and the limit that set it to the merged-MR runner binding", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const iid = 7005;
    const options = {
      mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
      fetchMergedMrDiffs: async () => featureDiff(iid),
      presentMergedMrRevisions: [fixture.revision],
    };
    const assembly = await assembleMergedMrUpdate({ ...assembleRequest(fixture), options });
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    try {
      const admittedRequest = {
        workflow: "create-documentation",
        instruction,
        allowWrite: true,
        workspacePath: workspace.path,
      };
      // A 65,536-token window with setup's 1,024-token reserve.
      const readBudget = sourceReadBudgetForModel({
        contextAdmission: "host-window",
        profile: { maxInputTokens: 65_536 },
        requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 1_024 },
      });
      expect(readBudget).toEqual({
        budgetBytes: 38_707,
        basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 64_512 },
      });
      const bounded = await issueMergedMrCliSourceEvidence({
        workspace,
        admittedRequest,
        runId: "run-1809-merged-mr-budget",
        assembly: assembly!,
        readBudget,
      });
      expect(bounded?.runnerBinding.readBudgetBasis).toEqual(readBudget.basis);
      expect(bounded?.runnerBinding.policy.perStepBudgetBytes).toBe(38_707);
      // With no bound model the declared ceiling applies, and no basis is named.
      const ceiling = await issueMergedMrCliSourceEvidence({
        workspace,
        admittedRequest,
        runId: "run-1809-merged-mr-ceiling",
        assembly: assembly!,
      });
      expect(ceiling?.runnerBinding.readBudgetBasis).toBeUndefined();
      expect(ceiling?.runnerBinding.policy.perStepBudgetBytes).toBe(262_144);
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("binds a diff past the derivative ceiling in part and names the cut once", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const iid = 7006;
    // About 2.2 MB: past the 1 MiB derivative ceiling, under the 4 MiB original ceiling.
    const options = {
      mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
      fetchMergedMrDiffs: async () => longDiff(iid, 34_000),
      presentMergedMrRevisions: [fixture.revision],
    };
    const observed = await renderedBytes(fixture, options);
    expect(observed).toBeGreaterThan(2 * 1_048_576);
    expect(observed).toBeLessThan(4_194_304);

    const record = await runCreate(fixture, options);

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    const shown = JSON.parse(
      await captureLog(() =>
        handleRunsCommand(["show", record!.id, "--json", "--state-dir", fixture.stateDirectory]),
      ),
    ) as { limitOverflow?: string[] };
    expect(shown.limitOverflow).toContain(
      `byte-budget-truncated; sources-extraction-max-derivative-bytes-bound: ${observed} exceeds sources.extractionMaxDerivativeBytes = 1048576 bytes. ` +
        "Bind a smaller file or a narrower selection, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES, up to 67108864, then start a new run. Follow the named remediation.",
    );
    for (const line of shown.limitOverflow ?? []) {
      expect(line.split("Follow the named remediation.").length - 1, line).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it("refuses a diff past the original ceiling with a coded line, and binds it once the ceiling is raised", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const iid = 7007;
    // About 4.5 MB: past the 4 MiB original ceiling.
    const options = {
      mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
      fetchMergedMrDiffs: async () => longDiff(iid, 70_000),
      presentMergedMrRevisions: [fixture.revision],
    };
    const observed = await renderedBytes(fixture, options);
    expect(observed).toBeGreaterThan(4_194_304);

    await expect(runCreate(fixture, options)).rejects.toMatchObject({
      code: "original-budget-exceeded",
      message:
        "Source extraction rejected: original-budget-exceeded. " +
        `sources-extraction-max-original-bytes-bound: ${observed} exceeds sources.extractionMaxOriginalBytes = 4194304 bytes. ` +
        "Bind a smaller source, such as a narrower merged-MR window or a smaller tracked file, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES, up to 67108864, then start a new run. " +
        "Follow the named remediation.",
    });

    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES", String(observed));
    const record = await runCreate(fixture, options);
    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
  }, 180_000);
});

/** Everything `console.log` printed while `run` ran. */
async function captureLog(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => {
    lines.push(String(message ?? ""));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

class ReviewHarness implements AgentHarness {
  public readonly stepIds: string[] = [];
  public readonly listedPaths: string[] = [];
  public readonly toolReads: string[] = [];

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.stepIds.push(input.step.id);
    if (input.sourceReader && input.step.id === "verify-technical-accuracy") {
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
        const result = (await read.execute("read-" + call, {
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        })) as { content: Array<{ text: string }> };
        this.toolReads.push((JSON.parse(result.content[0]!.text) as { text: string }).text);
      }
    }
    if (requiresSourceObligationLedger(input)) {
      const proposal = sourceObligationProposalFixture("README.md:1");
      return {
        summary: canonicalSourceObligationProposal(proposal),
        sourceObligationProposal: proposal,
      };
    }
    const verification = await verificationFixture(input);
    if (input.step.id === "review-documentation") {
      return {
        summary: canonicalizeJsonEvidence({
          verdict: "pass",
          issues: [],
        } as JsonEvidenceValue).trimEnd(),
      };
    }
    return {
      summary: input.step.id + " completed its deterministic read-only check.",
      ...verification,
    };
  }
}

describe("review-documentation merged-MR diff CLI (#1086)", () => {
  it("has no write-mode step in its manifest: a patch is structurally impossible", () => {
    const workflow = getWorkflow("review-documentation");
    expect(workflow.steps.some((step) => step.mode === "write")).toBe(false);
  });

  it(
    "reads the merged-MR diff through docsfab_read_source and leaves the checkout clean",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const before = await captureGitSnapshot(fixture.repository);
      const iid = 7003;
      const harness = new ReviewHarness();

      const record = await executeRunRequest(
        {
          workflow: "review-documentation",
          instruction: MERGED_MR_INSTRUCTION,
          repositoryPath: fixture.repository,
          revision: "HEAD",
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: harness,
          skillResolver,
          mergedMrPagePort: pagePort([mergedRecord(iid, fixture.revision)]),
          fetchMergedMrDiffs: async () => featureDiff(iid),
          presentMergedMrRevisions: [fixture.revision],
        },
      );

      // Every read-only step ahead of evaluate-document-quality admitted the diff.
      // That step separately requires a profile-scored quality-artifact candidate
      // (validate_documentation_quality_evaluation.py), which this run does not
      // supply, so the stop there is asserted explicitly below.
      expect(harness.listedPaths).toContain("gitlab-mr/" + iid + ".diff");
      expect(harness.toolReads.some((text) => text.includes(FEATURE_DIFF_MARKER))).toBe(true);
      const priorSteps =
        record?.steps?.filter((step) => step.id !== "evaluate-document-quality") ?? [];
      expect(priorSteps.every((step) => step.status === "succeeded")).toBe(true);
      expect(record?.steps?.find((step) => step.id === "evaluate-document-quality")?.status).toBe(
        "failed",
      );

      // Non-mutating: no write step, no draftMr/commentMr/publish option, and the
      // checkout is byte-for-byte unchanged.
      expect(record?.changes?.files ?? []).toEqual([]);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );
});
