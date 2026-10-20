// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared composition-root fixture for the `docsfab run --source` suites.
 *
 * The HTML, DOCX, and PDF suites share one fixture builder and one model
 * harness so they prove the same wiring; only the tracked originals and the
 * locator kind they produce differ. Everything here runs the real CLI
 * composition root. The only substitution is the model turn, at the documented
 * `executionHarness` seam.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createKnowledgeAcceptedSnapshot } from "../../src/canon/from-knowledge-snapshot.js";
import { FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH } from "../../src/cli/first-pass.js";
import { canonicalDigest } from "../../src/contract-kit/index.js";
import type { AgentHarness, HarnessStepInput } from "../../src/execution/contracts.js";
import { createSourceToolDefinitions } from "../../src/harness/source-tools.js";
import type { SourceSpanLocatorV1 } from "../../src/inputs/source-evidence.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../src/json-evidence.js";
import { documentationPlanBindingDigest } from "../../src/workflow-execution/plan-binding.js";
import {
  bindHostOwnedTechnicalCorrectionProposalV3,
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
} from "../../src/workflow-execution/source-obligation.js";
import { verificationFixture, verificationResultFixture } from "../helpers/verification.js";
import { createFixtureRepository } from "./execution-convergence.js";
import { authoringFixtureCandidateForInput } from "./authoring-quality-fixture.js";
import { listedInventory } from "./source-listing.js";

const exec = promisify(execFile);

export const PAGE_PATH = "docs/whats-new.md";
export const HTML_SOURCE_PATH = "docs/release-notes.html";

export interface SourceFixture {
  root: string;
  repository: string;
  stateDirectory: string;
  revision: string;
}

/**
 * A fixture repository whose revision already carries an approved knowledge
 * snapshot, so `create-documentation` reaches the workflow without a live
 * provider. Every path in `extraFiles` is written and tracked at that same
 * revision, which is how the DOCX and PDF suites get real originals into a real
 * repository without inventing a second fixture seed.
 */
export async function createSourceFixture(
  extraFiles: Readonly<Record<string, Uint8Array | string>> = {},
): Promise<SourceFixture> {
  const fixture = await createFixtureRepository("documented-html");
  for (const [repositoryPath, contents] of Object.entries(extraFiles)) {
    const target = join(fixture.repository, repositoryPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const snapshotPath = join(fixture.repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(
    snapshotPath,
    `${JSON.stringify(
      createKnowledgeAcceptedSnapshot({
        projectId: "PRJ-SOURCE",
        modelVersionId: "MODEL-SOURCE",
        streamVersion: 1,
        status: "approved",
        claims: [
          {
            id: "CL-001",
            kind: "behavior",
            scope: "Fixture CLI",
            statement: "The fixture CLI prints its installed version with the version flag.",
            modelState: "canonical",
            evidenceIds: ["SRC-001"],
          },
        ],
        sources: [{ id: "SRC-001", locator: "readme:README.md" }],
        conflicts: [],
      }),
      null,
      2,
    )}\n`,
  );
  await exec("git", ["add", "."], { cwd: fixture.repository });
  await exec("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "accept knowledge"], {
    cwd: fixture.repository,
  });
  const revision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
  ).stdout.trim();
  return { ...fixture, revision };
}

export const skillResolver = {
  resolveSkill: async (input: HarnessStepInput) => ({
    id: input.step.skill,
    contentSha256: "a".repeat(64),
  }),
};

export function planBinding(sourcePaths: readonly string[]) {
  const mode = "create" as const;
  const pages = [{ path: PAGE_PATH, disposition: mode }];
  const sourceBindings = [{ pagePath: PAGE_PATH, sources: [...sourcePaths] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

/** One source the host read into a write step's prompt, as the model sees it. */
export interface HostReadSource {
  readonly stepId: string;
  readonly observationId: string;
  readonly representationId: string;
  readonly repositoryPath: string | null;
  readonly spans: ReadonlyArray<{ readonly spanId: string; readonly text: string }>;
}

/** The sources the host read into this step's prompt: one JSON line per source. */
export function hostReadSources(stepId: string, prompt: string): HostReadSource[] {
  return prompt
    .split("\n")
    .filter((line) => line.startsWith('{"kind":"docsfab-source-required-read"'))
    .map((line) => {
      const source = JSON.parse(line) as Omit<HostReadSource, "stepId">;
      return {
        stepId,
        observationId: source.observationId,
        representationId: source.representationId,
        repositoryPath: source.repositoryPath,
        spans: source.spans,
      };
    });
}

/** One span the inventory tool disclosed, as the model sees it. */
export interface InventoryEntry {
  observationId: string;
  representationId: string;
  repositoryPath: string;
  mediaType: string;
  spanId: string;
  startByte: number;
  endByte: number;
  locator: SourceSpanLocatorV1;
}

export interface SourceToolHarnessOptions {
  /** The skill whose step uses the source tools, or `null` to use neither. */
  readonly readOnSkill: string | null;
  /** List the inventory but never read, to prove listing is not evidence. */
  readonly listOnly?: boolean;
  /**
   * Read every disclosed span instead of one per observation, the minimum the
   * required-source write gate accepts. The no-source-text guard can only look
   * for words it has seen, so suites that call it read the whole derivative.
   */
  readonly readAllSpans?: boolean;
  /**
   * Read each observation as one window from byte 0 of at most this many bytes,
   * through `docsfab_read_source` `fromByte`, instead of by span id.
   */
  readonly readWindowMaxBytes?: number;
  readonly planSourcePaths: readonly string[];
  /** Select the single supported V3 revision branch. */
  readonly revision?: boolean;
  /**
   * Write step ids that call `docsfab_cite_source`. Omit to cite on every write
   * step, which is what a compliant model does; naming a subset is how a test
   * asks "what happens when the second write step cites nothing".
   */
  readonly citeOnStepIds?: readonly string[];
  /**
   * Make the revision writer cite the sentence the first writer wrote, word for
   * word, instead of its own. A pooled run ledger cannot tell that step from
   * one that cited what it wrote.
   */
  readonly reviserCitesWriterClaim?: boolean;
}

/**
 * The one documentation sentence a writer step writes and cites.
 *
 * The page and the citation come from this single function on purpose: the
 * coverage check compares the digest of each sentence the step added against
 * the claim digest the citation carried, so a fixture that let the two drift
 * would be testing its own copy rather than the product rule.
 */
export function writerClaim(stepId: string): string {
  return stepId === "revise-documentation"
    ? "The corrected fixture CLI prints its installed version with the version flag."
    : "The fixture CLI prints its installed version with the version flag.";
}

/**
 * A writer's status reply in the field shape (#1917): what it changed, what it
 * left unresolved, and the checks it did not run. None of it is documentation,
 * so none of it owes a citation.
 */
export function writerStatusReply(stepId: string): string {
  return [
    `Step ${stepId} changed ${PAGE_PATH} from the bound release notes.`,
    "Unresolved items: the release date is not in the bound source.",
    "Checks not run: repository checks run after this step.",
  ].join("\n");
}

/**
 * Planner/writer harness that behaves like a real model would.
 *
 * It is given no identifiers. It calls `docsfab_list_sources` to discover what
 * this step may read, then passes those exact identifiers to
 * `docsfab_read_source`. Nothing is recomputed out of band -- not from git, not
 * from a fixture constant -- so a run only succeeds if the shipped host really
 * discloses a usable inventory for every source the operator selected.
 *
 * It reads one span per distinct observation, which is what the required-source
 * write gate demands: a run that read only the first of several selected sources
 * must not be able to write.
 */
export class SourceToolHarness implements AgentHarness {
  public readonly sawReaderOn: string[] = [];
  public readonly sawCiterOn: string[] = [];
  /** Spans this harness actually read, in read order. */
  public readonly readSpans: InventoryEntry[] = [];
  /**
   * Sources the host read into a write step's prompt. With `readSpans`, the only
   * citable set: a writer cites one of these when no step read with the tool.
   */
  public readonly hostReads: HostReadSource[] = [];
  public citeCalls = 0;
  /** Operator-visible refusal text the tool handed back, as the model sees it. */
  public readonly citationRefusals: string[] = [];
  public readonly citationFailures: string[] = [];
  public readonly sawReferenceOn: string[] = [];
  public readonly sawListToolOn: string[] = [];
  public readonly presentedTools: string[] = [];
  public readonly toolReads: string[] = [];
  /** Windows `docsfab_read_source` returned, as the model saw them. */
  public readonly windowReads: Array<{
    spans: Array<{ spanId: string; text: string }>;
    readBytes?: number;
    totalBytes?: number;
    nextFromByte?: number | null;
  }> = [];
  public readonly listed: InventoryEntry[] = [];
  /** The raw inventory payloads, exactly as the model received them. */
  public readonly listedPayloads: string[] = [];
  public readonly calls: Array<{
    stepId: string;
    skill: string;
    hasReader: boolean;
    hasSourceBinding: boolean;
    planBinding: string | null;
    sourceObligationLedger: string | null;
    repositoryPath: string;
    sourceBindingDigest: string | null;
    authoringPhaseSha256: string | null;
    technicalVerificationSha256: string | null;
  }> = [];
  public writerCalls = 0;

  private readonly readOnSkill: string | null;
  private readonly listOnly: boolean;
  private readonly readAllSpans: boolean;
  private readonly readWindowMaxBytes: number | undefined;
  private readonly planSourcePaths: readonly string[];
  private readonly revision: boolean;
  private readonly citeOnStepIds: readonly string[] | undefined;
  private readonly reviserCitesWriterClaim: boolean;
  private admittedPlanBinding: NonNullable<HarnessStepInput["planBinding"]> | undefined;
  private admittedTechnicalVerification: VerificationResult | undefined;

  public constructor(options: SourceToolHarnessOptions) {
    this.readOnSkill = options.readOnSkill;
    this.listOnly = options.listOnly ?? false;
    this.readAllSpans = options.readAllSpans ?? false;
    this.readWindowMaxBytes = options.readWindowMaxBytes;
    this.planSourcePaths = options.planSourcePaths;
    this.revision = options.revision ?? false;
    this.citeOnStepIds = options.citeOnStepIds;
    this.reviserCitesWriterClaim = options.reviserCitesWriterClaim ?? false;
  }

  /** Every span id the inventory disclosed, in disclosure order. */
  public get listedSpanIds(): string[] {
    return this.listed.map((entry) => entry.spanId);
  }

  /** Every locator kind the inventory actually disclosed, in first-seen order. */
  public get locatorKinds(): string[] {
    const kinds: string[] = [];
    for (const entry of this.listed) {
      if (!kinds.includes(entry.locator.kind)) kinds.push(entry.locator.kind);
    }
    return kinds;
  }

  /** Every repository path the inventory disclosed, in first-seen order. */
  public get listedPaths(): string[] {
    const paths: string[] = [];
    for (const entry of this.listed) {
      if (!paths.includes(entry.repositoryPath)) paths.push(entry.repositoryPath);
    }
    return paths;
  }

  public async inspectSkill(input: HarnessStepInput) {
    return { id: input.step.skill, contentSha256: "a".repeat(64) };
  }

  public async runStep(input: HarnessStepInput) {
    if (input.planBinding) this.admittedPlanBinding = input.planBinding;
    this.calls.push({
      stepId: input.step.id,
      skill: input.step.skill,
      hasReader: input.sourceReader !== undefined,
      hasSourceBinding: input.sourceBinding !== undefined,
      planBinding: input.planBinding ? JSON.stringify(input.planBinding) : null,
      sourceObligationLedger: input.sourceObligationLedger
        ? JSON.stringify(input.sourceObligationLedger)
        : null,
      repositoryPath: input.repositoryPath,
      sourceBindingDigest: input.sourceBinding?.digest ?? null,
      authoringPhaseSha256: input.evidenceIdentity?.authoringPhaseSha256 ?? null,
      technicalVerificationSha256: input.technicalVerification
        ? canonicalDigest(input.technicalVerification)
        : this.admittedTechnicalVerification
          ? canonicalDigest(this.admittedTechnicalVerification)
          : null,
    });
    if (input.sourceReader) this.sawReaderOn.push(input.step.skill);
    if (input.sourceCiter) this.sawCiterOn.push(input.step.skill);
    if (input.sourceBinding) this.sawReferenceOn.push(input.step.skill);
    this.hostReads.push(...hostReadSources(input.step.id, input.step.prompt));
    if (input.step.skill === "write-documentation") {
      this.writerCalls += 1;
      if (!input.planBinding) throw new Error("writer did not receive the planner binding");
      // A source-grounded write cites the sentence it is about to record
      // against a span some step of this run really read. The citer is absent
      // unless the policy admitted it, so a no-source or un-opted-in run takes
      // this branch and does nothing.
      const citesHere = this.citeOnStepIds?.includes(input.step.id) ?? true;
      if (input.sourceCiter && input.sourceReader && citesHere) {
        const cite = createSourceToolDefinitions({
          reader: input.sourceReader,
          citer: input.sourceCiter,
          recordFailure: (category) => this.citationFailures.push(category),
        }).find((entry) => entry.name === "docsfab_cite_source")!;
        // A model that read nothing with the tool cites a span the host read
        // into a write step's prompt, by the id printed beside its text.
        const hostRead = this.hostReads[0];
        const span =
          this.readSpans[0] ??
          (hostRead
            ? {
                observationId: hostRead.observationId,
                representationId: hostRead.representationId,
                spanId: hostRead.spans[0]!.spanId,
              }
            : undefined);
        if (!span) throw new Error("writer had no read span to cite");
        this.citeCalls += 1;
        // Behaves like `PiHarness`: a refused tool call is handed back to the
        // model as an error result and the step continues. A fixture that let
        // the error escape `runStep` would exercise a path the real adapter
        // never takes, and would hide whatever the runner does next.
        try {
          await cite.execute(`cite-${this.citeCalls}`, {
            claim: writerClaim(
              this.reviserCitesWriterClaim ? "write-documentation" : input.step.id,
            ),
            observationId: span.observationId,
            representationId: span.representationId,
            spanIds: [span.spanId],
          });
        } catch (error) {
          this.citationRefusals.push(error instanceof Error ? error.message : String(error));
        }
      }
      const target = join(input.repositoryPath, PAGE_PATH);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `# What Is New\n\n${writerClaim(input.step.id)}\n`, "utf8");
    }
    if (this.readOnSkill === input.step.skill && input.sourceReader !== undefined) {
      const definitions = createSourceToolDefinitions({
        reader: input.sourceReader,
        recordFailure: () => undefined,
      });
      this.presentedTools.push(...definitions.map((entry) => entry.name));
      const list = definitions.find((entry) => entry.name === "docsfab_list_sources")!;
      const read = definitions.find((entry) => entry.name === "docsfab_read_source")!;

      // Discovery. The harness knows no identifier before this call.
      this.sawListToolOn.push(input.step.skill);
      const listed = (await list.execute("list-1", {})) as { content: Array<{ text: string }> };
      const payload = listed.content[0]!.text;
      this.listedPayloads.push(payload);
      const inventory = { spans: listedInventory(payload) as unknown as InventoryEntry[] };
      if (inventory.spans.length === 0) throw new Error("inventory disclosed no readable span");
      this.listed.push(...inventory.spans);
      if (this.listOnly) return this.stepResult(input);

      if (this.readWindowMaxBytes !== undefined) {
        // One window per observation, by byte offset: the model names no span id.
        const sources = (JSON.parse(payload) as { sources: InventoryEntry[] }).sources;
        for (const [index, source] of sources.entries()) {
          const result = (await read.execute(`window-${index + 1}`, {
            observationId: source.observationId,
            representationId: source.representationId,
            fromByte: 0,
            maxBytes: this.readWindowMaxBytes,
          })) as { content: Array<{ text: string }>; details: { spanAccessSha256: string } };
          const window = JSON.parse(result.content[0]!.text) as {
            spans: Array<{ spanId: string; text: string }>;
          };
          this.toolReads.push(window.spans.map((span) => span.text).join("\n"));
          this.windowReads.push(window);
          for (const span of window.spans) {
            this.readSpans.push(
              inventory.spans.find((entry) => entry.spanId === span.spanId) ?? {
                ...source,
                spanId: span.spanId,
              },
            );
          }
          expect(result.details.spanAccessSha256).toMatch(/^[a-f0-9]{64}$/u);
        }
        return this.stepResult(input);
      }
      // Use only what the inventory returned, one span per observation, so a
      // multi-source run really reads every source it was asked to bind.
      const seen = new Set<string>();
      let call = 0;
      for (const span of inventory.spans) {
        if (!this.readAllSpans && seen.has(span.observationId)) continue;
        seen.add(span.observationId);
        call += 1;
        const result = (await read.execute(`read-${call}`, {
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        })) as { content: Array<{ text: string }>; details: { spanAccessSha256: string } };
        this.toolReads.push((JSON.parse(result.content[0]!.text) as { text: string }).text);
        this.readSpans.push(span);
        expect(result.details.spanAccessSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
    return this.stepResult(input);
  }

  private async stepResult(input: HarnessStepInput) {
    if (input.step.id === "revise-documentation") {
      const actionable = input.authoringRevisionInput?.actionableFacts[0];
      const issueId = actionable?.issueIds[0];
      const sourceLocator = actionable?.sourceLocators[0];
      if (!issueId || !sourceLocator) {
        throw new Error("Revision fixture did not receive admitted actionable source evidence.");
      }
      return {
        summary: writerStatusReply(input.step.id),
        authoringRevisionAccounting: {
          issueAccounting: [
            {
              issueId,
              disposition: "applied" as const,
              reason: "The admitted source supports this bounded correction.",
              sourceLocators: [sourceLocator],
            },
          ],
          changedPaths: [PAGE_PATH],
          unresolvedFacts: [],
        },
        model: { provider: "hosted", model: "test-model" },
        skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
      };
    }
    if (input.step.id === "evaluate-document-quality") {
      if (
        !this.admittedPlanBinding ||
        !this.admittedTechnicalVerification ||
        !input.evidenceIdentity?.authoringPhaseSha256
      ) {
        throw new Error("Quality fixture did not receive the admitted candidate evidence.");
      }
      const evidence = {
        kind: "docsfab-cli-source-quality-evidence",
        schemaVersion: 1,
        repositoryRevision: input.evidenceIdentity.repositoryRevision,
        targetPaths: this.admittedPlanBinding.pages.map((page) => page.path),
        planDigest: this.admittedPlanBinding.digest,
        ...(input.sourceBinding ? { sourceArtifactDigest: input.sourceBinding.digest } : {}),
        technicalVerificationSha256: canonicalDigest(this.admittedTechnicalVerification),
        candidatePhaseSha256: input.evidenceIdentity.authoringPhaseSha256,
      };
      const reportMarkdown = [
        "# Documentation quality evaluation report",
        "",
        `Evidence: ${canonicalDigest(evidence)}`,
      ].join("\n");
      const qualityCandidate =
        input.qualityProfileSelection &&
        (input.workflow.name === "create-documentation" ||
          input.workflow.name === "update-documentation")
          ? await authoringFixtureCandidateForInput(input)
          : undefined;
      if (qualityCandidate)
        qualityCandidate.reportMarkdown = qualityCandidate.reportMarkdown.replace(
          "## Evidence gaps and limitations",
          "## Source candidate evidence\n\n```json\n" +
            canonicalizeJsonEvidence(evidence as JsonEvidenceValue).trimEnd() +
            "\n```\n\n## Evidence gaps and limitations",
        );
      return {
        summary: qualityCandidate
          ? qualityCandidate.reportMarkdown
          : canonicalizeJsonEvidence({
              evaluation: evidence,
              qualityScore: null,
              reportMarkdown,
            } as JsonEvidenceValue).trimEnd(),
        ...(qualityCandidate ? { qualityArtifactCandidate: qualityCandidate } : {}),
        model: { provider: "hosted", model: "test-model" },
        skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
      };
    }
    const verification =
      this.revision && input.step.id === "verify-technical-accuracy"
        ? await this.actionableTechnicalVerification(input)
        : await verificationFixture(input);
    if (
      ["verify-technical-accuracy", "verify-revised-technical-accuracy"].includes(input.step.id) &&
      "verificationResult" in verification &&
      verification.verificationResult
    ) {
      this.admittedTechnicalVerification = verification.verificationResult;
    }
    if (
      input.step.id === "review-documentation" ||
      input.step.id === "review-revised-documentation"
    ) {
      return {
        summary: canonicalizeJsonEvidence({
          verdict: "pass",
          issues: [],
        } as JsonEvidenceValue).trimEnd(),
        model: { provider: "hosted", model: "test-model" },
        skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
      };
    }
    return {
      summary:
        input.step.skill === "write-documentation"
          ? writerStatusReply(input.step.id)
          : `ran ${input.step.skill}`,
      ...verification,
      ...(input.step.skill === "plan-documentation"
        ? { planBinding: planBinding(this.planSourcePaths) }
        : {}),
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
    };
  }

  private async actionableTechnicalVerification(input: HarnessStepInput) {
    if (
      input.sourceObligationLedger?.schemaVersion !== 2 ||
      !input.originalSourceAuthorityAdmission ||
      !input.runId
    ) {
      throw new Error("Actionable CLI verification requires V2 source authority.");
    }
    const sourcePath =
      input.sourceObligationLedger.identity.sources[0]?.path ?? this.planSourcePaths[0];
    if (!sourcePath) throw new Error("Actionable CLI verification requires a planned source.");
    const sourceLocator = /:\d+(?:-\d+)?$/u.test(sourcePath) ? sourcePath : `${sourcePath}:1`;
    const result = verificationResultFixture([PAGE_PATH], sourceLocator);
    result.review.verdict = "needs-revision";
    result.review.issues = [
      {
        id: "CLI-001",
        severity: "major",
        category: "technical_accuracy",
        location: PAGE_PATH,
        finding: "The candidate omits the source-backed corrected behavior.",
        evidence: { source_id: "admitted-source", locator: sourceLocator },
        required_change: "Document the corrected behavior from the admitted source.",
      },
    ];
    const fact = result.factInventory.dimensions[0]!.facts[0]!;
    fact.id = "FACT001";
    fact.documentationDisposition = "omitted";
    fact.issueIds = ["CLI-001"];
    const correction = await bindHostOwnedTechnicalCorrectionProposalV3(
      {
        kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
        schemaVersion: 3,
        verdict: result.review.verdict,
        coverage: result.coverage,
        factInventory: result.factInventory,
        issueJudgments: [
          {
            id: "CLI-001",
            severity: "major",
            category: "technical_accuracy",
            location: PAGE_PATH,
            factIds: ["FACT001"],
          },
        ],
        obligationAccounting: [],
      },
      input.sourceObligationLedger,
      input.originalSourceAuthorityAdmission,
      input.runId,
      [PAGE_PATH],
    );
    return {
      summary: canonicalizeJsonEvidence(
        correction.verificationResult as unknown as JsonEvidenceValue,
      ).trimEnd(),
      verificationResult: correction.verificationResult,
      technicalCorrectionEvidence: correction.evidence,
    };
  }
}

/**
 * Every locator field is a position, not a quotation.
 *
 * `kind` and `part` are the only strings a locator may carry: the closed
 * discriminant, and (DOCX only) the package part name the span was read from.
 * Everything else -- page numbers, byte offsets, block paths, table
 * coordinates -- must be a number or `null`, including inside arrays and the
 * `tableCell` object. A locator that grew a free-text field would be a place to
 * hide source text where no `toContain` check would look.
 */
function assertLocatorCarriesOnlyPositions(locator: SourceSpanLocatorV1): void {
  const numericLeaves = (value: unknown, path: string): void => {
    if (value === null || typeof value === "number") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => numericLeaves(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) numericLeaves(nested, `${path}.${key}`);
      return;
    }
    throw new Error(`locator field ${path} is ${typeof value}, expected a number or null`);
  };
  for (const [key, value] of Object.entries(locator)) {
    if (key === "kind" || key === "part") {
      expect(typeof value).toBe("string");
      continue;
    }
    numericLeaves(value, key);
  }
}

/** Alphanumeric runs of four characters or more, lowercased. */
function significantWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((word) => word.length >= 4),
  );
}

/** The complete key set `docsfab_list_sources` may emit. Identity and position. */
const INVENTORY_ENVELOPE_KEYS = [
  "kind",
  "truncated",
  "spanCount",
  "spans",
  "sourceCount",
  "sources",
] as const;
/** One per-representation summary row: identity, size, and extent only. */
const INVENTORY_SOURCE_KEYS = [
  "handle",
  "observationId",
  "representationId",
  "repositoryPath",
  "mediaType",
  "spanCount",
  "bytes",
] as const;
const INVENTORY_ENTRY_KEYS = ["source", "spanId", "startByte", "endByte", "locator"] as const;
const LOCATOR_KINDS = ["html-node", "docx-block", "pdf-page"] as const;

/**
 * Structural no-source-text guard for `docsfab_list_sources`. It asserts the
 * property, not one fixture string a leak of any other text would walk past:
 *
 * 1. The payload's key set is exactly the documented one, at the envelope and
 *    at every entry, so a leak cannot arrive under a new field name.
 * 2. Every locator carries positions only: `kind` and `part` are its only
 *    strings, and every other field is a number or `null`, recursively.
 * 3. No word of four characters or more that appears in any text
 *    `docsfab_read_source` returned appears in any string value of the payload.
 *
 * Three values the inventory discloses by contract are removed before the word
 * scan: the operator's own `repositoryPath`, the host-classified `mediaType`,
 * and the closed `kind` discriminants. Each is removed by *exact substring*
 * only, so text appended to one of them survives the removal and is still
 * scanned -- a leak cannot hide inside a field that is allowed to be a string.
 * Keys are never scanned, because a key is schema; `itemStart` is not a leak of
 * the word "item".
 */
export function assertInventoryDisclosesNoSourceText(
  model: SourceToolHarness,
  disclosed: {
    readonly repositoryPaths: readonly string[];
    readonly mediaTypes: readonly string[];
  },
): void {
  expect(model.listedPayloads.length).toBeGreaterThan(0);
  expect(model.listed.length).toBeGreaterThan(0);
  // Without a read there is no derivative text to look for, and the word half
  // of this assertion would pass vacuously.
  expect(model.toolReads.length).toBeGreaterThan(0);

  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) collect(nested);
    }
  };

  for (const payload of model.listedPayloads) {
    const envelope = JSON.parse(payload) as {
      kind: string;
      spans: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };
    expect(Object.keys(envelope).toSorted()).toEqual([...INVENTORY_ENVELOPE_KEYS].toSorted());
    for (const entry of envelope.spans) {
      expect(Object.keys(entry).toSorted()).toEqual([...INVENTORY_ENTRY_KEYS].toSorted());
      const locator = entry.locator as SourceSpanLocatorV1;
      expect(LOCATOR_KINDS).toContain(locator.kind);
      assertLocatorCarriesOnlyPositions(locator);
    }
    for (const entry of envelope.sources) {
      expect(Object.keys(entry).toSorted()).toEqual([...INVENTORY_SOURCE_KEYS].toSorted());
      expect(typeof entry.spanCount).toBe("number");
      expect(typeof entry.bytes).toBe("number");
    }
    collect(envelope);
  }

  const removable = [
    ...disclosed.repositoryPaths,
    ...disclosed.mediaTypes,
    ...LOCATOR_KINDS,
    "docsfab-source-span-inventory",
  ];
  let scanned = strings.join("\n");
  for (const value of removable) scanned = scanned.split(value).join("");
  scanned = scanned.toLowerCase();

  const derivativeWords = new Set<string>();
  for (const text of model.toolReads) {
    for (const word of significantWords(text)) derivativeWords.add(word);
  }
  // A guard with nothing to look for would be worth nothing. Every suite that
  // calls this reads the whole derivative, so this floor is generous.
  expect(derivativeWords.size).toBeGreaterThan(5);

  // Substring containment, not word equality: a leak concatenated onto an
  // identifier ("...a3f1quick brown...") is still a leak, and tokenizing the
  // payload first would lose it.
  const leaked = [...derivativeWords].filter((word) => scanned.includes(word));
  expect(leaked).toEqual([]);
}

export function runRequest(fixture: { repository: string }, sourcePaths?: readonly string[]) {
  return {
    workflow: "create-documentation" as const,
    instruction: `Create ${PAGE_PATH} describing the release notes for developers.`,
    repositoryPath: fixture.repository,
    revision: "HEAD",
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    ...(sourcePaths ? { sourcePaths } : {}),
  };
}
