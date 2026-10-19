// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A real CLI composition-root journey with only the model turns scripted. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const firstPassBridgeProbe = vi.hoisted(() => ({ calls: 0, refuse: false }));
const campaignTaskProbe = vi.hoisted(() => ({ task: undefined as unknown }));

vi.mock("../src/cli/first-pass-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass-support.js")>();
  return {
    ...actual,
    createFirstPassSupportModelBridge: (
      ...args: Parameters<typeof actual.createFirstPassSupportModelBridge>
    ) => {
      firstPassBridgeProbe.calls += 1;
      if (firstPassBridgeProbe.refuse) {
        throw new Error("Single-page RST update unexpectedly entered first-pass gather.");
      }
      return actual.createFirstPassSupportModelBridge(...args);
    },
  };
});

vi.mock("../src/doc-improvement-cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/doc-improvement-cli.js")>();
  return {
    ...actual,
    loadAuthorizedDocImprovementWriteTask: async () => campaignTaskProbe.task,
  };
});

import { createKnowledgeAcceptedSnapshot } from "../src/canon/from-knowledge-snapshot.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH } from "../src/cli/first-pass.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { createSourceToolDefinitions } from "../src/harness/source-tools.js";
import { sourceClaimSha256 } from "../src/inputs/source-evidence-artifacts.js";
import { editorialAssessmentEvidenceRefsV1 } from "../src/harness/pi.js";
import { bindDocumentationPlanProposal } from "../src/workflow-execution/plan-binding.js";
import { verificationFixture, verificationResultFixture } from "./helpers/verification.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";
import { captureGitSnapshot, runtimeConfig } from "./support/execution-convergence.js";
import { listedInventory } from "./support/source-listing.js";
import {
  recordingProvider,
  toolPathHarness,
  toolResults,
} from "./support/answer-submission-fixtures.js";
import { resetSharedTestState, textTurn, toolTurn } from "./support/pi-harness-session-fixtures.js";

const runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = temporaryRoots();
const page = "docs/guide.rst";
const markdownPage = "docs/guide.md";
const source = "src/device.txt";
const original = [
  "Device setup",
  "============",
  "",
  "The device can run the demo after installation.",
  "",
  ".. _device-options:",
  "",
  "Options",
  "-------",
  "",
  "See :ref:`device-options` and :doc:`index` for navigation.",
  "",
  ".. tabs::",
  "",
  "   .. tab:: pip",
  "",
  "      pip install device-demo",
  "",
  ".. note::",
  "",
  "   Keep this warning and its blank line.",
  "",
  ".. list-table:: Supported devices",
  "   :header-rows: 1",
  "",
  "   * - Device",
  "     - Driver",
  "   * - Demo",
  "     - 7",
  "",
  ".. image:: device.png",
  "   :alt: Device diagram",
  "",
  ".. include:: details.inc",
  "",
].join("\n");
const oldParagraph = "The device can run the demo after installation.";
const supportedParagraph =
  "The device can run the demo after installation when driver 7 is installed.";

afterEach(async () => {
  process.exitCode = undefined;
  firstPassBridgeProbe.calls = 0;
  firstPassBridgeProbe.refuse = false;
  campaignTaskProbe.task = undefined;
  vi.unstubAllGlobals();
  await resetSharedTestState();
});

type RstOffer = { readonly regionId: string; readonly prose: string };
type ScriptedTool = {
  readonly name: string;
  readonly execute: (
    callId: string,
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ text: string }>;
  }>;
};

class RstModel implements AgentHarness {
  readonly inputs: HarnessStepInput[] = [];
  readonly listedPaths: string[] = [];
  readonly readTexts: string[] = [];
  readonly readSpans: Array<{
    observationId: string;
    representationId: string;
    spanId: string;
    repositoryPath: string | null;
  }> = [];
  readonly citationReceipts: string[] = [];
  readonly offers: RstOffer[] = [];

  constructor(
    private readonly scenario: {
      readonly target?: string;
      readonly pages?: readonly string[];
      readonly offer?: (input: HarnessStepInput) => RstOffer;
      readonly tamperAfterWrite?: boolean;
      readonly failAfterTamper?: boolean;
      readonly omitCitation?: boolean;
      readonly writeWithPi?: (
        input: HarnessStepInput,
        offer: RstOffer,
      ) => Promise<HarnessStepResult>;
    } = {},
  ) {}

  get stepIds(): string[] {
    return this.inputs.map((input) => input.step.id);
  }

  async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.inputs.push(input);
    if (input.sourceReader && this.listedPaths.length === 0) {
      const tools = createSourceToolDefinitions({
        reader: input.sourceReader,
        recordFailure: () => undefined,
      }) as unknown as ScriptedTool[];
      const list = tools.find((tool) => tool.name === "docsfab_list_sources")!;
      const read = tools.find((tool) => tool.name === "docsfab_read_source")!;
      const listing = await list.execute("rst-list", {});
      const spans = listedInventory(listing.content[0]!.text);
      const seen = new Set<string>();
      for (const span of spans) {
        this.listedPaths.push(span.repositoryPath!);
        if (seen.has(span.observationId)) continue;
        seen.add(span.observationId);
        const result = await read.execute(`rst-read-${seen.size}`, {
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        });
        this.readTexts.push((JSON.parse(result.content[0]!.text) as { text: string }).text);
        this.readSpans.push(span);
      }
    }
    const reference =
      input.step.id === "plan-documentation"
        ? input.editorialEvidenceRefs?.[0]
        : editorialAssessmentEvidenceRefsV1(input)[0];
    if (input.step.id === "plan-documentation") {
      if (!reference) throw new Error("RST planner received no admitted reader evidence");
      const pages = this.scenario.pages ?? [this.scenario.target ?? page];
      return {
        summary: "The tracked device source supports one existing guide update.",
        planBinding: bindDocumentationPlanProposal(
          {
            mode: "update",
            pages: pages.map((path) => ({ path, disposition: "update" as const })),
            sourceBindings: pages.map((path) => ({ pagePath: path, sources: [source] })),
          },
          { expectedMode: "update" },
        ),
        editorialDecisionProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-decision-proposal",
          candidate: "update",
          rationale:
            "The current guide omits the driver prerequisite established by source evidence.",
          evidenceRefs: [reference],
          limitations: [],
          impactBasis: {
            kind: "documentation-defect",
            rationale: "The tracked source states driver 7 is required for the demo.",
            evidence_refs: [
              {
                uri: source,
                sha256: createHash("sha256")
                  .update(await readFile(join(input.repositoryPath, source)))
                  .digest("hex"),
              },
            ],
          },
        },
      };
    }
    if (input.step.id === "write-documentation") {
      if (this.scenario.target === markdownPage) {
        await writeFile(
          join(input.repositoryPath, markdownPage),
          `# Device setup\n\n${supportedParagraph}\n`,
        );
        return { summary: "Updated the source-backed Markdown page." };
      }
      const context = input as HarnessStepInput & {
        rstAuthoring?: { regions: Array<{ id: string; kind: string; text: string }> };
      };
      const region = context.rstAuthoring?.regions.find(
        (candidate) => candidate.kind === "replace" && candidate.text.includes(oldParagraph),
      );
      if (!region) throw new Error("host did not offer the ordinary RST prose region");
      const offer = this.scenario.offer?.(input) ?? {
        regionId: region.id,
        prose: supportedParagraph,
      };
      this.offers.push(offer);
      if (this.scenario.writeWithPi) return this.scenario.writeWithPi(input, offer);
      if (
        !this.scenario.omitCitation &&
        input.sourceReader &&
        input.sourceCiter &&
        offer.prose === supportedParagraph
      ) {
        const span = this.readSpans.find((candidate) => candidate.repositoryPath === source);
        if (!span) throw new Error("writer has no tool-read source span to cite");
        const tools = createSourceToolDefinitions({
          reader: input.sourceReader,
          citer: input.sourceCiter,
          recordFailure: () => undefined,
        }) as unknown as ScriptedTool[];
        const cite = tools.find((tool) => tool.name === "docsfab_cite_source")!;
        const receipt = await cite.execute("rst-cite", {
          claim: supportedParagraph,
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        });
        this.citationReceipts.push(receipt.content[0]!.text);
      }
      // The host owns the write. This transport deliberately never edits the workspace.
      return { summary: JSON.stringify(offer) };
    }
    if (input.step.id === "test-audience-understanding") {
      if (!reference) throw new Error("audience check received no evidence reference");
      return {
        summary: "No representative audience was available for the local fixture.",
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "not-applicable",
          rationale: "This fixture has no representative audience.",
          evidenceRefs: [reference],
          limitations: ["audience-check-unavailable"],
          recommendation: null,
        },
      };
    }
    if (input.step.id === "review-documentation" && this.scenario.tamperAfterWrite) {
      const path = join(input.repositoryPath, page);
      const contents = await readFile(path, "utf8");
      await writeFile(
        path,
        contents.replace(
          "Keep this warning and its blank line.",
          "Changed this protected note body after the host edit.",
        ),
      );
      if (this.scenario.failAfterTamper) {
        throw new Error("Review stopped after protected RST bytes changed.");
      }
    }
    const result: HarnessStepResult = {
      summary:
        input.step.id === "review-documentation"
          ? JSON.stringify({ verdict: "pass", issues: [] })
          : `${input.step.id} checked the source-backed RST candidate.`,
      ...(input.step.id === "derive-source-obligations" ? await verificationFixture(input) : {}),
      ...(input.step.id === "verify-technical-accuracy"
        ? {
            verificationResult: verificationResultFixture(
              [this.scenario.target ?? page],
              `${source}:1`,
            ),
          }
        : {}),
      ...(input.step.id === "evaluate-document-quality" && input.qualityProfileSelection
        ? { qualityArtifactCandidate: await authoringFixtureCandidateForInput(input) }
        : {}),
    };
    if (
      reference &&
      [
        "derive-source-obligations",
        "verify-technical-accuracy",
        "review-documentation",
        "evaluate-document-quality",
      ].includes(input.step.id)
    ) {
      result.editorialAssessmentProposal = {
        schemaVersion: 1,
        kind: "docsfab-editorial-assessment-proposal",
        assessment: "accepted",
        rationale:
          "The retained page was compared with the admitted source and candidate evidence.",
        evidenceRefs: [reference],
        limitations: [],
        recommendation: null,
      };
    }
    return result;
  }
}

async function fixture(
  documentationRoot = "docs",
  exactFileRoot = false,
  rootConf = false,
  ancestorConf = false,
  optionBearingInclude = false,
  nestedSphinxConflict = false,
  withoutKnowledgeSnapshot = false,
  configuredDocumentationRoots: readonly string[] | null = [documentationRoot],
) {
  const repository = await roots.create("docsfab-rst-cli-repo-");
  const stateDirectory = await roots.create("docsfab-rst-cli-state-");
  const rstPath = exactFileRoot
    ? documentationRoot
    : join(documentationRoot, nestedSphinxConflict ? "sub/guide.rst" : "guide.rst");
  const sibling = (name: string) => join(dirname(rstPath), name);
  const markdownPath = sibling("guide.md");
  const snapshot = createKnowledgeAcceptedSnapshot({
    projectId: "RST-FIXTURE",
    modelVersionId: "RST-FIXTURE-1",
    streamVersion: 1,
    status: "approved",
    claims: [
      {
        id: "DRIVER-7",
        kind: "behavior",
        scope: "Device demo",
        statement: supportedParagraph,
        modelState: "canonical",
        evidenceIds: ["DRIVER-SOURCE"],
      },
    ],
    sources: [{ id: "DRIVER-SOURCE", locator: source }],
    conflicts: [],
  });
  const head = await initFixtureRepo(
    repository,
    {
      [rstPath]: optionBearingInclude
        ? original.replace(
            ".. include:: details.inc\n",
            ".. include:: snippet.rst\n   :start-after: CUT\n\nSee :ref:`excluded-label`.\n\n",
          )
        : original,
      [markdownPath]: "# Device setup\n\nThe device can run the demo after installation.\n",
      [sibling("index.rst")]: [
        "Device docs",
        "===========",
        "",
        ".. toctree::",
        "",
        "   guide",
        "",
      ].join("\n"),
      ...(nestedSphinxConflict
        ? {
            [join(documentationRoot, "conf.py")]:
              "project = 'Outer device docs'\nroot_doc = 'index'\n",
            [join(documentationRoot, "index.rst")]:
              "Device docs\n===========\n\n.. toctree::\n\n   sub/guide\n",
          }
        : {}),
      [rootConf
        ? "conf.py"
        : ancestorConf
          ? join(dirname(dirname(rstPath)), "conf.py")
          : sibling("conf.py")]: [
        "project = 'Device demo'",
        "extensions = ['sphinx_tabs.tabs']",
        ...(optionBearingInclude ? ["exclude_patterns = ['snippet.rst']"] : []),
        ...(rootConf ? ["root_doc = 'docs/index'"] : []),
        ...(ancestorConf ? ["root_doc = 'content/index'"] : []),
        "",
      ].join("\n"),
      ...(optionBearingInclude
        ? {
            [sibling("snippet.rst")]:
              ".. _excluded-label:\n\nExcluded prose.\n\nCUT\n\nIncluded prose.\n",
          }
        : { [sibling("details.inc")]: "Additional setup details remain unchanged.\n" }),
      [sibling("device.png")]: "fixture image bytes",
      [source]: "The device can run the demo after installation when driver 7 is installed.\n",
      "README.md": "# Device demo\n\nThe device CLI runs a demo.\n",
      ...(withoutKnowledgeSnapshot
        ? {}
        : { [FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH]: `${JSON.stringify(snapshot, null, 2)}\n` }),
      ".docsfab.json": `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
        ...(configuredDocumentationRoots === null
          ? {}
          : { documentationRoots: configuredDocumentationRoots }),
      })}\n`,
    },
    { branch: "main" },
  );
  await git(repository, [
    "remote",
    "add",
    "origin",
    "ssh://git@gitlab.example.invalid/docs/device.git",
  ]);
  await git(repository, ["update-ref", "refs/remotes/origin/main", head]);
  return {
    repository,
    stateDirectory,
    head,
    rstPath,
    markdownPath,
    config: runtimeConfig(join(stateDirectory, "runs")),
  };
}

function request(
  repositoryPath: string,
  instruction: string,
  currentPage = page,
  patchOnly = true,
) {
  const parsed = parseRunArguments([
    "update-documentation",
    "--repo",
    repositoryPath,
    "--revision",
    "HEAD",
    ...(patchOnly ? ["--patch-only"] : ["--allow-write"]),
    "--source",
    source,
    "--instruction",
    instruction,
  ]);
  expect(parsed.patchOnly).toBe(patchOnly ? true : undefined);
  expect(parsed.allowWrite).toBe(true);
  return {
    ...parsed,
    comparisonRequest: { kind: "workspace" as const },
    readerSources: [
      { role: "changed-source" as const, path: source },
      { role: "current-documentation" as const, path: currentPage },
      { role: "public-contract" as const, path: source },
    ],
  };
}

function interpreter(targets: readonly string[] = [page]) {
  return {
    async call() {
      return {
        text: JSON.stringify({
          authorityPreference: { preference: "unspecified", quote: null },
          operation: "update",
          targets: targets.map((path) => ({
            path,
            role: "write",
            chosenFrom: "named",
            quote: path,
          })),
        }),
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  };
}

function stoppedCode(outcome: unknown): string | undefined {
  if (outcome instanceof Error) return (outcome as Error & { code?: string }).code;
  if (typeof outcome === "object" && outcome !== null) {
    const record = outcome as {
      error?: string;
      status?: string;
      workflowOutcome?: { disposition?: string };
    };
    if (record.status === "succeeded") return undefined;
    return record.error ?? record.workflowOutcome?.disposition;
  }
  return undefined;
}

describe("bounded native RST update through CLI --patch-only", () => {
  it.each([
    ["a configured directory without a slash", ["docs"]],
    ["reordered configured roots", ["fern", "docs"]],
    ["the default roots", null],
  ])(
    "admits a canonical campaign-bound RST page with %s and retains its patch",
    async (_description, configuredRoots) => {
      const f = await fixture("docs", false, false, false, false, false, true, configuredRoots);
      const before = await captureGitSnapshot(f.repository);
      const originalBytes = await readFile(join(f.repository, page));
      const approvedProposal = `Update ${page} with the driver 7 prerequisite from ${source}.`;
      const hash = "a".repeat(64);
      campaignTaskProbe.task = {
        kind: "bounded-doc-improvement",
        campaignId: "rst-capability-campaign",
        repositoryId: "fixture/docs",
        testedCommit: f.head,
        repositoryIdentitySha256: createHash("sha256")
          .update(realpathSync(f.repository))
          .digest("hex"),
        contextSourcePath: source,
        gap: { id: "driver-7", evidenceSha256: hash, successCriterionSha256: hash },
        analysis: {
          runId: "rst-capability-analysis",
          recordSha256: hash,
          approvedOutcomeSha256: canonicalDigest(approvedProposal),
          approvedProposal,
        },
        authorization: { sha256: hash, digest: hash },
        intendedPaths: [page],
      };
      const campaignPath = join(f.stateDirectory, "campaign");
      const reviewerPolicyPath = join(f.stateDirectory, "reviewers.json");
      const parsed = parseRunArguments([
        "update-documentation",
        "--repo",
        f.repository,
        "--revision",
        f.head,
        "--allow-write",
        "--patch-only",
        "--doc-improvement-campaign",
        campaignPath,
        "--reviewer-policy",
        reviewerPolicyPath,
      ]);
      const model = new RstModel();
      const record = await executeRunRequest(
        {
          ...parsed,
          draftMr: false,
          comparisonRequest: { kind: "workspace" },
          readerSources: [
            { role: "changed-source", path: source },
            { role: "current-documentation", path: page },
          ],
        },
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );

      expect(record?.status, JSON.stringify({ error: record?.error })).toBe("succeeded");
      expect(model.stepIds).toContain("write-documentation");
      expect(record?.changes?.files.map((file) => file.path)).toEqual([page]);
      const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
      expect(patch).toContain(`+${supportedParagraph}`);
      expect(patch).toContain(`-${oldParagraph}`);
      expect(record?.changes?.patch?.byteLength).toBeGreaterThan(0);
      expect(await readFile(join(f.repository, page))).toEqual(originalBytes);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "retains a source-backed patch without a preloaded knowledge snapshot or first-pass gather",
    async () => {
      const f = await fixture("docs", false, false, false, false, false, true);
      await expect(
        readFile(join(f.repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const before = await captureGitSnapshot(f.repository);
      const originalPage = await readFile(join(f.repository, page));
      const originalSource = await readFile(join(f.repository, source));
      const model = new RstModel();
      firstPassBridgeProbe.refuse = true;

      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );

      expect(record?.status, JSON.stringify({ error: record?.error })).toBe("succeeded");
      expect(firstPassBridgeProbe.calls).toBe(0);
      expect(model.stepIds).toContain("write-documentation");
      expect(model.citationReceipts).toHaveLength(1);
      expect(record?.changes?.files.map((file) => file.path)).toEqual([page]);
      const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
      expect(patch).toContain(`+${supportedParagraph}`);
      expect(patch).toContain(`-${oldParagraph}`);
      expect(record?.changes?.patch?.byteLength).toBeGreaterThan(0);
      expect(await readFile(join(f.repository, page))).toEqual(originalPage);
      expect(await readFile(join(f.repository, source))).toEqual(originalSource);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "retains a source-backed paragraph patch and preserves every original checkout byte",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const originalBytes = await readFile(join(f.repository, page));
      const model = new RstModel();
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(
        record?.status,
        JSON.stringify({
          error: record?.error,
          steps: record?.steps.map((step) => ({
            id: step.id,
            status: step.status,
            error: step.error,
            rstPreservation: step.rstPreservation,
            rstStaticStructure: step.rstStaticStructure,
            rstStaticGraph: step.rstStaticGraph,
          })),
        }),
      ).toBe("succeeded");
      expect(model.stepIds).toEqual(
        expect.arrayContaining([
          "plan-documentation",
          "derive-source-obligations",
          "write-documentation",
          "verify-technical-accuracy",
          "review-documentation",
          "evaluate-document-quality",
        ]),
      );
      expect(
        record?.steps.find((step) => step.id === "plan-documentation")?.planBinding?.sourceBindings,
      ).toEqual([{ pagePath: page, sources: [source] }]);
      expect(model.offers).toHaveLength(1);
      const offeredReplacements = model.inputs
        .find((input) => input.step.id === "write-documentation")
        ?.rstAuthoring?.regions.filter((region) => region.kind === "replace")
        .map((region) => region.text);
      expect(offeredReplacements).toContain(oldParagraph);
      for (const protectedSyntax of [
        ".. tabs::",
        ".. note::",
        "Keep this warning and its blank line.",
        ".. list-table::",
        ".. image::",
        ".. include::",
      ]) {
        expect(offeredReplacements?.some((text) => text.includes(protectedSyntax))).toBe(false);
      }
      expect(model.listedPaths).toContain(source);
      expect(model.readTexts.join("\n")).toContain("driver 7");
      expect(model.citationReceipts).toHaveLength(1);
      expect(
        record?.sourceCitations?.steps.find((step) => step.stepId === "write-documentation"),
      ).toMatchObject({
        materialClaimSha256s: [sourceClaimSha256(supportedParagraph)],
        citations: [
          expect.objectContaining({ supportedClaimSha256: sourceClaimSha256(supportedParagraph) }),
        ],
      });
      expect(
        record?.sourceCitations?.steps.find((step) => step.stepId === "write-documentation")
          ?.uncitedClaims,
      ).toBeUndefined();
      const preservation = record?.steps.find(
        (step) => step.id === "write-documentation",
      )?.rstPreservation;
      expect(preservation).toMatchObject({
        path: page,
        baseSha256: createHash("sha256").update(originalBytes).digest("hex"),
      });
      expect(preservation?.candidateSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(preservation?.candidateSha256).not.toBe(preservation?.baseSha256);
      expect(preservation?.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(preservation?.unchangedRanges).toBeGreaterThan(0);
      const writeStep = record?.steps.find((step) => step.id === "write-documentation");
      expect(writeStep?.rstStaticStructure).toMatchObject({ state: "limited" });
      expect(writeStep?.rstStaticStructure?.opaqueRegions).toBeGreaterThan(0);
      expect(writeStep?.rstStaticGraph).toMatchObject({ state: "limited" });
      expect(writeStep?.rstStaticGraph?.checkedKinds).toEqual(
        expect.arrayContaining([
          "labels",
          "doc/ref",
          "toctree",
          "include/literalinclude",
          "directive-options",
        ]),
      );
      expect(writeStep?.rstNativeBuild).toBe("not-run");
      expect(record?.changes?.files.map((file) => file.path)).toEqual([page]);
      const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
      expect(patch).toContain(`+${supportedParagraph}`);
      expect(patch).toContain(`-${oldParagraph}`);
      expect(record?.changes?.patch?.byteLength).toBeGreaterThan(0);
      expect(createHash("sha256").update(patch).digest("hex")).toBe(record?.changes?.patch?.sha256);
      const applied = await roots.create("docsfab-rst-cli-applied-");
      await git(f.repository, ["clone", "-q", f.repository, applied]);
      await git(applied, ["apply", "--check", record!.changes!.patch!.artifactPath]);
      await git(applied, ["apply", record!.changes!.patch!.artifactPath]);
      expect(await readFile(join(applied, page), "utf8")).toBe(
        original.replace(oldParagraph, supportedParagraph),
      );
      expect(await readFile(join(f.repository, page))).toEqual(originalBytes);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "records only uncited selected RST prose at its absolute page line",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const originalPage = await readFile(join(f.repository, page), "utf8");
      expect(originalPage.split("\n").indexOf(oldParagraph) + 1).toBe(4);
      const model = new RstModel({ omitCitation: true });
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(record?.status, JSON.stringify({ error: record?.error })).toBe("succeeded");
      expect(model.offers).toHaveLength(1);
      expect(model.citationReceipts).toHaveLength(0);
      const writeCitations = record?.sourceCitations?.steps.find(
        (step) => step.stepId === "write-documentation",
      );
      expect(writeCitations?.materialClaimSha256s).toEqual([sourceClaimSha256(supportedParagraph)]);
      expect(writeCitations?.citations).toEqual([]);
      expect(writeCitations?.uncitedClaims).toEqual([
        { path: page, line: 4, claimSha256: sourceClaimSha256(supportedParagraph) },
      ]);
      expect(record?.changes?.files.map((file) => file.path)).toEqual([page]);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "runs the RST writer through real Pi source tools under the host tool ceiling",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({
        writeWithPi: async (input, offer) => {
          const span = model.readSpans.find((candidate) => candidate.repositoryPath === source);
          if (!span) throw new Error("RST Pi writer lacks the previously read source span.");
          expect(input.toolCeiling).toEqual(
            expect.arrayContaining(["docsfab_read_source", "docsfab_cite_source"]),
          );
          expect(input.toolCeiling).not.toContain("edit");
          expect(input.toolCeiling).not.toContain("write");

          const requests = recordingProvider([
            toolTurn([
              {
                id: "source-read",
                name: "docsfab_read_source",
                arguments: {
                  observationId: span.observationId,
                  representationId: span.representationId,
                  spanIds: [span.spanId],
                },
              },
            ]),
            toolTurn([
              {
                id: "source-cite",
                name: "docsfab_cite_source",
                arguments: {
                  claim: supportedParagraph,
                  observationId: span.observationId,
                  representationId: span.representationId,
                  spanIds: [span.spanId],
                },
              },
            ]),
            textTurn(JSON.stringify(offer)),
          ]);
          const result = await toolPathHarness().runStep(input);
          const offeredTools = (requests[0]!.tools as Array<{ function: { name: string } }>).map(
            (tool) => tool.function.name,
          );
          expect(offeredTools).toEqual(
            expect.arrayContaining(["docsfab_read_source", "docsfab_cite_source"]),
          );
          expect(offeredTools).not.toContain("edit");
          expect(offeredTools).not.toContain("write");
          expect(toolResults(requests[1]!).get("source-read")).toContain("driver 7");
          expect(toolResults(requests[2]!).get("source-cite")).toContain("supportedClaimSha256");

          const narrowedRequests = recordingProvider([textTurn(JSON.stringify(offer))]);
          await toolPathHarness().runStep({
            ...input,
            toolCeiling: ["read", "docsfab_read_source"],
          });
          const narrowedTools = (
            narrowedRequests[0]!.tools as Array<{ function: { name: string } }>
          ).map((tool) => tool.function.name);
          expect(narrowedTools).toContain("docsfab_read_source");
          expect(narrowedTools).not.toContain("docsfab_cite_source");
          expect(narrowedTools).not.toContain("edit");
          expect(narrowedTools).not.toContain("write");
          return result;
        },
      });
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(record?.status, JSON.stringify({ error: record?.error })).toBe("succeeded");
      expect(record?.changes?.files.map((file) => file.path)).toEqual([page]);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "updates an existing RST page under a configured Sphinx root",
    async () => {
      const f = await fixture("site/content");
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({ target: f.rstPath });
      const record = await executeRunRequest(
        request(
          f.repository,
          `Update ${f.rstPath} with the driver 7 prerequisite from ${source}.`,
          f.rstPath,
        ),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter([f.rstPath]) },
      );
      expect(record?.status, JSON.stringify({ error: record?.error })).toBe("succeeded");
      expect(record?.changes?.files.map((file) => file.path)).toEqual([f.rstPath]);
      expect(
        record?.steps.find((step) => step.id === "write-documentation")?.rstPreservation,
      ).toMatchObject({ path: f.rstPath });
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "updates docs from a repository-root Sphinx config with an explicit root doc",
    async () => {
      const f = await fixture("docs", false, true);
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel();
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(record?.status, JSON.stringify({ error: record?.error })).toBe("succeeded");
      expect(
        record?.steps.find((step) => step.id === "write-documentation")?.rstStaticGraph,
      ).toMatchObject({ checkedKinds: expect.arrayContaining(["toctree", "doc/ref"]) });
      expect(record?.changes?.files.map((file) => file.path)).toEqual([page]);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a nested RST page when a directory root contains competing Sphinx configurations",
    async () => {
      const f = await fixture("docs", false, false, false, false, true);
      const before = await captureGitSnapshot(f.repository);
      const originalBytes = await readFile(join(f.repository, f.rstPath));
      expect(f.rstPath).toBe("docs/sub/guide.rst");
      expect(
        JSON.parse(await readFile(join(f.repository, ".docsfab.json"), "utf8")).documentationRoots,
      ).toEqual(["docs"]);
      expect(
        (
          await git(f.repository, ["ls-files", "--", "docs/conf.py", "docs/sub/conf.py", f.rstPath])
        ).split("\n"),
      ).toEqual(["docs/conf.py", "docs/sub/conf.py", f.rstPath]);
      const model = new RstModel({ target: f.rstPath });
      const outcome = await executeRunRequest(
        request(
          f.repository,
          `Update ${f.rstPath} with the driver 7 prerequisite from ${source}.`,
          f.rstPath,
        ),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter([f.rstPath]) },
      ).then(
        (record) => record,
        (error: unknown) => error,
      );
      expect(stoppedCode(outcome)).toBe("proposal-scope-input-invalid");
      expect(model.stepIds).not.toContain("plan-documentation");
      expect(model.stepIds).not.toContain("write-documentation");
      expect(
        outcome instanceof Error
          ? undefined
          : (outcome as { changes?: { patch?: unknown } } | undefined)?.changes?.patch,
      ).toBeUndefined();
      expect(await readFile(join(f.repository, f.rstPath))).toEqual(originalBytes);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses an RST include whose start-after option hides a referenced label",
    async () => {
      const f = await fixture("docs", false, false, false, true);
      const before = await captureGitSnapshot(f.repository);
      const trackedPage = await readFile(join(f.repository, page), "utf8");
      expect(trackedPage).toContain(
        ".. include:: snippet.rst\n   :start-after: CUT\n\nSee :ref:`excluded-label`.",
      );
      expect(trackedPage).not.toContain(".. include:: details.inc");
      const model = new RstModel();
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(model.stepIds).toContain("write-documentation");
      expect(record?.status).toBe("failed");
      expect(record?.steps.find((step) => step.id === "write-documentation")?.error).toContain(
        "Sphinx include options or body are outside the bounded static graph",
      );
      expect(record?.changes?.patch?.byteLength ?? 0).toBe(0);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it.each([
    ["root-level", "guide.rst", false],
    ["nested", "site/content/guide.rst", false],
    ["nested-ancestor", "site/content/guide.rst", true],
  ])(
    "updates an existing RST page configured as an exact %s file root",
    async (_case, rstPath, ancestorConf) => {
      const f = await fixture(rstPath, true, false, ancestorConf);
      const before = await captureGitSnapshot(f.repository);
      const originalBytes = await readFile(join(f.repository, rstPath));
      const model = new RstModel({ target: rstPath });
      const record = await executeRunRequest(
        request(
          f.repository,
          `Update ${rstPath} with the driver 7 prerequisite from ${source}.`,
          rstPath,
        ),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter([rstPath]) },
      );
      expect(record?.status, JSON.stringify({ error: record?.error })).toBe("succeeded");
      expect(model.offers).toHaveLength(1);
      expect(record?.changes?.files.map((file) => file.path)).toEqual([rstPath]);
      expect(
        record?.steps.find((step) => step.id === "write-documentation")?.rstPreservation,
      ).toMatchObject({ path: rstPath });
      const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
      expect(patch).toContain(`+${supportedParagraph}`);
      expect(await readFile(join(f.repository, rstPath))).toEqual(originalBytes);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a protected exact RST file root before the writer",
    async () => {
      const target = "docs/vendor/guide.rst";
      const f = await fixture(target, true);
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({ target });
      const outcome = await executeRunRequest(
        request(
          f.repository,
          `Update ${target} with the driver 7 prerequisite from ${source}.`,
          target,
        ),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter([target]) },
      ).then(
        (record) => record,
        (error: unknown) => error,
      );
      expect(model.stepIds).not.toContain("write-documentation");
      expect(stoppedCode(outcome)).toMatch(
        /(?:proposal-scope|request-intent|documentation-|rst-)/u,
      );
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "still updates a Markdown page in a Sphinx repository that also tracks RST",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const rstBytes = await readFile(join(f.repository, page));
      const model = new RstModel({ target: markdownPage });
      const record = await executeRunRequest(
        request(
          f.repository,
          `Update ${markdownPage} with the driver 7 prerequisite from ${source}.`,
        ),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter([markdownPage]) },
      );
      expect(record?.status, JSON.stringify({ error: record?.error, steps: record?.steps })).toBe(
        "succeeded",
      );
      expect(model.stepIds).toContain("write-documentation");
      expect(record?.changes?.files.map((file) => file.path)).toEqual([markdownPage]);
      expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toContain(
        `+${supportedParagraph}`,
      );
      expect(await readFile(join(f.repository, page))).toEqual(rstBytes);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "retains a source-backed insertion before opaque content",
    async () => {
      const f = await fixture();
      const originalBytes = await readFile(join(f.repository, page));
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({
        offer: (input) => {
          const regions = input.rstAuthoring?.regions ?? [];
          const afterParagraph = regions.find(
            (region) =>
              region.kind === "insert" &&
              region.start > original.indexOf(oldParagraph) + oldParagraph.length &&
              region.start < original.indexOf(".. tabs::"),
          );
          if (!afterParagraph)
            throw new Error("host offered no safe insertion before the tab block");
          return { regionId: afterParagraph.id, prose: supportedParagraph };
        },
      });
      const record = await executeRunRequest(
        request(
          f.repository,
          `Add the driver 7 prerequisite before the tabs in ${page} from ${source}.`,
        ),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(
        record?.status,
        JSON.stringify({
          error: record?.error,
          steps: record?.steps.map((step) => ({
            id: step.id,
            status: step.status,
            error: step.error,
          })),
        }),
      ).toBe("succeeded");
      const writeStep = record?.steps.find((step) => step.id === "write-documentation");
      expect(writeStep?.rstPreservation?.selectedStart).toBe(
        writeStep?.rstPreservation?.selectedEnd,
      );
      expect(writeStep?.rstStaticStructure?.state).toBe("limited");
      expect(writeStep?.rstNativeBuild).toBe("not-run");
      const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
      expect(patch).toContain(`+${supportedParagraph}`);
      expect(patch).not.toContain(`-${oldParagraph}`);
      expect(await readFile(join(f.repository, page))).toEqual(originalBytes);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses final capture when a later review changes protected note bytes",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({ tamperAfterWrite: true });
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(model.stepIds).toContain("review-documentation");
      expect(record?.status).toBe("failed");
      expect(record?.error).toContain("rst-preservation-mismatch");
      expect(record?.changes?.patch?.byteLength ?? 0).toBe(0);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "retains the RST preservation diagnostic when review also fails",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({ tamperAfterWrite: true, failAfterTamper: true });
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(model.stepIds).toContain("review-documentation");
      expect(record?.status).toBe("failed");
      expect(record?.error).toContain("rst-preservation-mismatch");
      expect(record?.changes?.patch?.byteLength ?? 0).toBe(0);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a writer region ID sealed to a different base digest",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({
        offer: (input) => {
          const offered = input.rstAuthoring?.regions.find(
            (region) => region.kind === "replace" && region.text.includes(oldParagraph),
          );
          if (!offered || !input.rstAuthoring) throw new Error("missing sealed paragraph region");
          return {
            regionId: offered.id.replace(input.rstAuthoring.baseSha256, "0".repeat(64)),
            prose: supportedParagraph,
          };
        },
      });
      const record = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      );
      expect(model.offers).toHaveLength(1);
      expect(record?.status).toBe("failed");
      expect(record?.steps.find((step) => step.id === "write-documentation")?.error).toContain(
        "rst-edit-region-unsupported",
      );
      expect(record?.changes?.patch?.byteLength ?? 0).toBe(0);
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it.each([
    ["create target", "docs/new.rst"],
    ["configuration target", "docs/conf.py"],
    ["out of root", "outside.rst"],
  ])(
    "refuses %s before the writer",
    async (_case, target) => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({ target });
      const outcome = await executeRunRequest(
        request(f.repository, `Update ${target} with the driver prerequisite.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter([target]) },
      ).then(
        (record) => record,
        (error: unknown) => error,
      );
      expect(model.stepIds).not.toContain("write-documentation");
      expect(stoppedCode(outcome)).toMatch(
        /(?:proposal-scope|request-intent|documentation-|rst-)/u,
      );
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses two RST targets before the writer",
    async () => {
      const f = await fixture();
      const model = new RstModel({ pages: [page, "docs/index.rst"] });
      const outcome = await executeRunRequest(
        request(f.repository, `Update ${page} and docs/index.rst with the driver prerequisite.`),
        f.config,
        {
          silent: true,
          executionHarness: model,
          requestInterpreter: interpreter([page, "docs/index.rst"]),
        },
      ).then(
        (record) => record,
        (error: unknown) => error,
      );
      expect(model.stepIds).not.toContain("write-documentation");
      expect(stoppedCode(outcome)).toMatch(
        /(?:proposal-scope|request-intent|documentation-|rst-)/u,
      );
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses an RST update without patch-only authority before the writer",
    async () => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel();
      const parsedRequest = request(
        f.repository,
        `Update ${page} with the driver 7 prerequisite from ${source}.`,
        page,
        false,
      );
      expect(parsedRequest.patchOnly).toBeUndefined();
      expect(parsedRequest.draftMr).toBe(true);
      const freshnessCalls: string[] = [];
      const outcome = await executeRunRequest(parsedRequest, f.config, {
        silent: true,
        executionHarness: model,
        requestInterpreter: interpreter(),
        ensurePublicationFreshness: async ({ revision }) => {
          freshnessCalls.push(revision);
          return { branch: "main", revision: f.head };
        },
        submitAfterSucceededRun: async () => {
          throw new Error("RST refusal must never reach publication");
        },
      }).then(
        (record) => record,
        (error: unknown) => error,
      );
      expect(freshnessCalls).toEqual(["HEAD"]);
      expect(stoppedCode(outcome)).toMatch(
        /(?:proposal-scope|request-intent|documentation-|rst-)/u,
      );
      expect(model.stepIds).not.toContain("write-documentation");
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a present but untracked RST target before the writer",
    async () => {
      const f = await fixture();
      const untracked = "docs/untracked.rst";
      await writeFile(join(f.repository, untracked), original);
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({ target: untracked });
      const outcome = await executeRunRequest(
        request(f.repository, `Update ${untracked} with the driver prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter([untracked]) },
      ).then(
        (record) => record,
        (error: unknown) => error,
      );
      expect(stoppedCode(outcome)).toMatch(
        /(?:proposal-scope|request-intent|documentation-|rst-)/u,
      );
      expect(model.stepIds).not.toContain("write-documentation");
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );

  it.each([
    ["directive injection", ".. note::\n\n   Driver 7 is required."],
    ["role injection", "Use :ref:`device-options` after driver 7 is installed."],
    ["nested indentation", "   Driver 7 is required."],
    ["punctuation heading", "New heading\n/////"],
    ["trailing-space literal introducer", "Example:: "],
    ["quoted literal body", "> code"],
    ["option list", "--help  Show usage."],
    ["Unicode bullet list", "• Driver 7 is required."],
  ])(
    "refuses %s from the structured writer",
    async (_case, prose) => {
      const f = await fixture();
      const before = await captureGitSnapshot(f.repository);
      const model = new RstModel({
        offer: (input) => ({
          regionId: (
            input as HarnessStepInput & {
              rstAuthoring: { regions: Array<{ id: string; text: string }> };
            }
          ).rstAuthoring.regions.find((region) => region.text.includes(oldParagraph))!.id,
          prose,
        }),
      });
      const outcome = await executeRunRequest(
        request(f.repository, `Update ${page} with the driver 7 prerequisite from ${source}.`),
        f.config,
        { silent: true, executionHarness: model, requestInterpreter: interpreter() },
      ).then(
        (record) => record,
        (error: unknown) => error,
      );
      expect(model.offers).toHaveLength(1);
      expect(
        outcome instanceof Error ? outcome.message : (outcome as { status?: string })?.status,
      ).not.toBe("succeeded");
      expect(stoppedCode(outcome)).toContain("rst-edit-region-unsupported");
      expect(model.stepIds).toContain("write-documentation");
      expect(await captureGitSnapshot(f.repository)).toEqual(before);
    },
    testTimeoutMs(120_000),
  );
});
