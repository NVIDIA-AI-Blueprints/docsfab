// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run citation coverage for source-grounded write steps.
 *
 * The run suites drive the shipped `update-documentation` manifest through the
 * real `WorkflowRunner` with a real source-evidence service, and the write step
 * cites through the confined tool definitions `createSourceToolDefinitions`
 * builds, the same objects the Pi adapter registers. Only the model turn and the
 * repository evidence collector are substituted, at their documented seams.
 *
 * Coverage judges the sentences the write step adds to its planned page, never
 * its status reply. An added sentence with no citation of the step's own is
 * recorded by page and line and the patch is kept; nothing here stops a write
 * except DocsFab's own ledger contradicting itself.
 *
 * Claim digests come from the shipped `sourceClaimSha256`, citation digests from
 * the shipped constructors, and refusal strings are the exact model-visible text.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { LocalRepositorySecurityScanner } from "../src/security/repository-scanner.js";
import { CatalogSkillCrateResolver } from "../src/skills/catalog-crate-resolver.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { createSourceToolDefinitions } from "../src/harness/source-tools.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import { decodeSuccessfulPublicationRunRecord } from "../src/delivery/run-record.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import { DEFAULT_NEXT_ACTIONS } from "../src/operator/error-envelope.js";
import {
  recordSourceCitationGaps,
  SOURCE_CITATION_GAPS_LIMITATION,
} from "../src/workflow-contracts/outcome.js";
import type { WorkflowOutcomeCandidateV1 } from "../src/workflow-contracts/contracts.js";
import {
  createSourceArtifactReference,
  createSourceBinding,
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  createSourceObservation,
  createSourceSpanAccess,
  createSourceStepPolicy,
  digestSourceProducerScopes,
  extractSourceRepresentation,
  htmlSourceExtractorAdapter,
  openExternalInputAccessCapture,
  projectSourceRequestContext,
  recordExternalInputAccess,
  registerFakeExternalInput,
  screenSourceSpanCitation,
  SOURCE_CITATION_LEDGER_CONTRADICTION_CODE,
  SOURCE_CITATION_PAGE_UNREADABLE_CODE,
  SourceCitationLedgerError,
  sourceCitationLedgerContradiction,
  sourceClaimSha256,
  sourceClaimText,
  sourceClaimWordCount,
  sourceDocumentationCitationCoverage,
  sourceDocumentationClaims,
  sourceMaterialClaims,
  sourceMaterialClaimSha256s,
  stepAdmitsSourceCite,
  SourceCitationError,
  type SourceRunCapabilityV1,
  type SourceSpanInventoryEntryV1,
} from "../src/inputs/index.js";
import {
  SOURCE_CITE_MAX_CLAIMS_PER_CALL,
  SOURCE_CITE_MAX_CLAIM_CHARACTERS,
  SOURCE_CITE_MAX_SPANS_PER_CALL,
  sourceClaimMinWords,
} from "../src/config/source-citation-limits.js";
import {
  CLI_SOURCE_CITE_SKILLS,
  CLI_SOURCE_READ_SKILLS,
} from "../src/cli/run/source-acquisition.js";
import {
  scriptedEditorialProtocol,
  type ScriptedValidatedDecision,
} from "./helpers/editorial-protocol.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { readyContextPreflight } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { listedInventory } from "./support/source-listing.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const HTML_FIXTURE = new URL("./fixtures/source-evidence/html/release-notes.html", import.meta.url);

/**
 * Every identifier differs from those in `source-citation-coverage.test.ts`
 * and the other citation suites, so no case passes on a fixture collision.
 */
const RUN_ID = "citation-gate-run-3308";
const OBSERVATION_ID = "obs-gate-release-notes";
const INPUT_ID = "input-gate-release-notes";
const FIXTURE_REVISION = "d".repeat(40);
const FIXTURE_SOURCE_PATH = "/fixtures/enforce-citation-coverage";
const CONTENT_DIGEST = createHash("sha256").update("content-983").digest("hex");
const PRODUCER_SCOPE = createHash("sha256").update("scope-983").digest("hex");
const PRODUCER_SCOPES = [{ producerId: "workspace-tracked-files", scopeSha256: PRODUCER_SCOPE }];
const WORKSPACE_IDENTITY = createHash("sha256").update("ws-983").digest("hex");
const PAGE_PATH = "docs/guide.md";
const CLAIM_MIN_WORDS_OVERRIDE = "DOCSFAB_SOURCES_CLAIM_MIN_WORDS";

/** One sentence, eight words: a material claim under the stated rule. */
const CLAIM_ONE = "The bound release note records the new ceiling.";
const CLAIM_ONE_TEXT = CLAIM_ONE;
/** A second material claim, nine words, cited only when asked. */
const CLAIM_TWO = "The bound release note also records the deprecation window.";

/**
 * The writer's status reply in the field shape (#1917): what it changed, the
 * items it left unresolved, and the checks it did not run. Every sentence has
 * four or more words, and none is documentation, so none is a claim.
 */
const STATUS_REPLY = [
  "Changed docs/guide.md to record the bound release note.",
  "Unresolved items: the release date is not in the bound source, so the page leaves it out.",
  "Checks not run: the repository markdown lint runs after this step, not inside it.",
].join("\n");

/**
 * The page the writer leaves, one sentence per line after the heading, so the
 * first sentence starts on line 3. Consecutive lines are one paragraph, so this
 * also proves that a sentence keeps the line it starts on after the join.
 */
function guidePage(...sentences: readonly string[]): string {
  return ["# Guide", "", ...sentences, ""].join("\n");
}

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const temporaryDirectories = temporaryRoots();

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

function updatePlanBinding(paths: readonly string[] = [PAGE_PATH]) {
  const mode = "update" as const;
  const pages = paths.map((path) => ({ path, disposition: mode }));
  const sourceBindings = paths.map((path) => ({ pagePath: path, sources: [path] }));
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

function updateRunRequest(workspacePath: string, sourceBinding?: unknown) {
  return {
    workflow: "update-documentation" as const,
    workspacePath,
    repository: {
      sourcePath: FIXTURE_SOURCE_PATH,
      requestedRevision: "HEAD",
      revision: FIXTURE_REVISION,
    },
    allowWrite: true,
    ...(sourceBinding ? { sourceBinding } : {}),
  };
}

interface CiteCall {
  readonly claim: string;
  readonly observationId: string;
  readonly representationId: string;
  readonly spanIds: readonly string[];
}

interface WriteScript {
  /** The documentation page the write step writes; the host judges its added sentences. */
  readonly page: string;
  /** Further planned pages, by path, that the write step writes after `page`. */
  readonly morePages?: Readonly<Record<string, string>>;
  /** Runs after the write step wrote its pages, before it returns. */
  readonly afterWrite?: (repositoryPath: string) => Promise<void>;
  /** The status reply the write step records; the host never reads claims from it. */
  readonly summary?: string;
  /** What the write step cites, decided from the host's own inventory. */
  readonly cite: (inventory: readonly SourceSpanInventoryEntryV1[]) => readonly CiteCall[];
}

/** Cite every listed claim against the first bound span. */
function citeFirstSpan(claims: readonly string[]): WriteScript["cite"] {
  return (inventory) => {
    const span = inventory[0]!;
    return claims.map((claim) => ({
      claim,
      observationId: span.observationId,
      representationId: span.representationId,
      spanIds: [span.spanId],
    }));
  };
}

/** Group the categories the confined tools recorded, in the decoder's order. */
function recordedFailureCategories(recorded: readonly string[]) {
  const counts = new Map<string, number>();
  for (const category of recorded) counts.set(category, (counts.get(category) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => ({ category: category as "citation-refused", count }));
}

function toolText(result: unknown): unknown {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return JSON.parse(content[0]?.text ?? "{}");
}

/**
 * A model that discovers its own identifiers: it lists, reads, and cites
 * through `createSourceToolDefinitions`, the factory the Pi adapter calls, so
 * the refusal text asserted here is the text a model would receive.
 */
class CitingWriteHarness implements AgentHarness {
  public readonly sawReaderOn: string[] = [];
  public readonly sawCiterOn: string[] = [];
  public readonly readSteps: string[] = [];
  public citeCalls = 0;
  public writerCalls = 0;
  /** Refusal text the tool handed back, exactly as a model would receive it. */
  public readonly citationRefusals: string[] = [];
  /** Failure categories the confined tool recorded, as PiHarness summarizes them. */
  public readonly citationFailures: string[] = [];

  public constructor(
    private readonly readOnSkills: readonly string[],
    private readonly script: WriteScript,
  ) {}

  public async inspectSkill(input: HarnessStepInput) {
    return new CatalogSkillCrateResolver(skillCrateDirectory).resolveSkill(input);
  }

  public async runStep(input: HarnessStepInput) {
    const skill = await this.inspectSkill(input);
    if (input.sourceReader) this.sawReaderOn.push(input.step.skill);
    if (input.sourceCiter) this.sawCiterOn.push(input.step.skill);
    // This step's own cite calls and refusals: a step's tool summary must add up.
    let stepCiteCalls = 0;
    const stepFailures: string[] = [];
    const tools = input.sourceReader
      ? createSourceToolDefinitions({
          reader: input.sourceReader,
          ...(input.sourceCiter ? { citer: input.sourceCiter } : {}),
          recordFailure: (category) => {
            this.citationFailures.push(category);
            stepFailures.push(category);
          },
        })
      : [];
    const tool = (name: string) => tools.find((definition) => definition.name === name);

    let inventory: readonly SourceSpanInventoryEntryV1[] = [];
    if (tools.length > 0) {
      inventory = listedInventory(
        toolText(await tool("docsfab_list_sources")!.execute()) as Parameters<
          typeof listedInventory
        >[0],
      );
      expect(inventory.length).toBeGreaterThan(1);
    }
    if (input.sourceReader && this.readOnSkills.includes(input.step.skill)) {
      const span = inventory[0]!;
      await tool("docsfab_read_source")!.execute("read-1", {
        observationId: span.observationId,
        representationId: span.representationId,
        spanIds: [span.spanId],
      });
      this.readSteps.push(input.step.id);
    }
    const verification = await verificationFixture(input);

    let summary = `Fixture completed ${input.step.skill} against the bound release note.`;
    if (input.step.mode === "write") {
      const citeTool = tool("docsfab_cite_source");
      for (const call of this.script.cite(inventory)) {
        if (!citeTool) break;
        this.citeCalls += 1;
        stepCiteCalls += 1;
        // As in `PiHarness`, a refused tool call returns to the model as an error
        // result and the step continues. Letting the error escape `runStep` would
        // exercise a path the real adapter never takes.
        try {
          await citeTool.execute(`cite-${this.citeCalls}`, {
            claim: call.claim,
            observationId: call.observationId,
            representationId: call.representationId,
            spanIds: [...call.spanIds],
          });
        } catch (error) {
          this.citationRefusals.push(error instanceof Error ? error.message : String(error));
        }
      }
      this.writerCalls += 1;
      const target = join(input.repositoryPath, PAGE_PATH);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, this.script.page);
      for (const [path, text] of Object.entries(this.script.morePages ?? {})) {
        await writeFile(join(input.repositoryPath, path), text);
      }
      await this.script.afterWrite?.(input.repositoryPath);
      summary = this.script.summary ?? STATUS_REPLY;
    }

    return {
      summary,
      ...verification,
      ...(input.step.id === "plan-documentation"
        ? {
            planBinding: updatePlanBinding([
              PAGE_PATH,
              ...Object.keys(this.script.morePages ?? {}),
            ]),
          }
        : {}),
      model: { provider: "fixture", model: "deterministic" },
      skill,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, turns: 1 },
      tools: {
        totalCalls: 1 + stepCiteCalls,
        failedCalls: stepFailures.length,
        byTool: [
          { name: input.step.mode === "write" ? "edit" : "read", calls: 1, failures: 0 },
          ...(stepCiteCalls > 0
            ? [
                {
                  name: "docsfab_cite_source",
                  calls: stepCiteCalls,
                  failures: stepFailures.length,
                },
              ]
            : []),
        ],
        // Derived from what the confined tools recorded, not a constant: a
        // hard-coded category cannot see a refusal routed to the wrong one.
        ...(stepFailures.length > 0
          ? { failureCategories: recordedFailureCategories(stepFailures) }
          : {}),
      },
    };
  }
}

/** The real producer chain: extraction, observation, binding, host service. */
async function buildUpdateSourceEvidence(
  workspacePath: string,
  options: {
    citeSkills?: readonly string[];
    recordCitation?: boolean;
    perStepBudgetBytes?: number;
  } = {},
) {
  const repository = {
    identitySha256: createHash("sha256").update(FIXTURE_SOURCE_PATH).digest("hex"),
    revision: FIXTURE_REVISION,
  };
  const policy = createSourceStepPolicy({
    sourceReadSkills: CLI_SOURCE_READ_SKILLS,
    ...(options.citeSkills === undefined ? {} : { sourceCiteSkills: options.citeSkills }),
    ...(options.perStepBudgetBytes === undefined
      ? {}
      : { perStepBudgetBytes: options.perStepBudgetBytes }),
  });
  const requestSha256 = projectSourceRequestContext(
    updateRunRequest(workspacePath) as unknown as Record<string, unknown>,
    { runId: RUN_ID, workspaceIdentitySha256: WORKSPACE_IDENTITY, repository },
  );
  const bytes = new Uint8Array(await readFile(HTML_FIXTURE));
  const { representation, derivative } = await extractSourceRepresentation({
    adapter: htmlSourceExtractorAdapter,
    bytes,
    mediaType: "text/html",
  });
  const observation = createSourceObservation({
    observationId: OBSERVATION_ID,
    originIdSha256: sha("origin-983"),
    inputId: INPUT_ID,
    registrationSha256: sha("registration-983"),
    runIdSha256: sha(RUN_ID),
    repository,
    requestSha256,
    producerId: "workspace-tracked-files",
    producerVersion: "1",
    producerScopeSha256: PRODUCER_SCOPE,
    acquisitionReceiptSha256: sha("receipt-983"),
    observedAt: "2026-09-17T09:00:00.000Z",
    original: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "text/html",
      locatorSha256: sha("docs/release-notes.html"),
      version: { kind: "repository-revision", revision: FIXTURE_REVISION },
      repositoryPath: "docs/release-notes.html",
    },
    representations: [representation],
  });
  const binding = createSourceBinding({
    runIdSha256: sha(RUN_ID),
    repository,
    requestSha256,
    hostPolicySha256: policy.policySha256,
    producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
    parentBindingSha256: null,
    observations: [
      { observationId: OBSERVATION_ID, observationSha256: observation.observationSha256 },
    ],
    requiredObservationIds: [OBSERVATION_ID],
  });
  const capture = openExternalInputAccessCapture({ runIdSha256: sha(RUN_ID), repository });
  const { contentDigestSha256 } = registerFakeExternalInput(capture, INPUT_ID, {
    adapterKind: "repository-document",
    canonicalLocator: "repository-document:docs/release-notes.html",
    safeTitle: "Release notes",
    body: Buffer.from(derivative).toString("utf8"),
    version: { kind: "repository-revision", revision: FIXTURE_REVISION },
    visibility: "internal",
    disclosurePolicy: "cite-and-quote",
    intendedRoles: ["evidence"],
  });
  const citationJoins: string[] = [];
  const service = createSourceEvidenceService(
    createSourceEvidenceHostAuthority({
      verifyCurrent: () => undefined,
      hostPolicySha256: policy.policySha256,
      producerScopes: PRODUCER_SCOPES,
      resolveBinding: (digest) => (digest === binding.bindingSha256 ? binding : undefined),
      resolveObservation: (id) => (id === OBSERVATION_ID ? observation : undefined),
      resolveDerivative: ({ representationId }) =>
        representationId === representation.representationId ? derivative : undefined,
      recordAccess: ({ stepId, spanIds }) =>
        recordExternalInputAccess(capture, {
          inputId: INPUT_ID,
          stepId,
          outcome: "opened",
          observedContentDigestSha256: contentDigestSha256!,
          accessorId: "docsfab-read-source",
          evidenceSha256s: [sha(spanIds.join(","))],
        }).observationSha256,
      // The host's citation join; removing it is the second half of the opt-in.
      ...(options.recordCitation === false
        ? {}
        : {
            recordCitation: ({ stepId, accessObservationSha256s, supportedClaimSha256 }) => {
              const digest = sha(
                `${stepId}|${supportedClaimSha256}|${[...accessObservationSha256s].sort().join(",")}`,
              );
              citationJoins.push(digest);
              return digest;
            },
          }),
      now: () => new Date("2026-09-17T09:05:00.000Z"),
    }),
  );
  return {
    binding,
    observation,
    representation,
    policy,
    citationJoins,
    reference: createSourceArtifactReference({
      kind: "source-binding",
      digest: binding.bindingSha256,
      repositoryRevision: FIXTURE_REVISION,
      repositoryContentDigest: CONTENT_DIGEST,
    }),
    runnerBinding: {
      service,
      workspaceIdentitySha256: WORKSPACE_IDENTITY,
      repositoryContentDigest: CONTENT_DIGEST,
      policy,
    },
  };
}

async function fixtureWorkspace(): Promise<string> {
  const workspace = await temporaryDirectories.create("docsfab-983-gate-");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, PAGE_PATH), "# Guide\n\nThe fixture guide is stale.\n");
  await writeFile(join(workspace, "README.md"), "fixture repository\n");
  return workspace;
}

function sourceObserverFixture(paths: readonly string[]) {
  return {
    ...sourceObligationObserverFixture,
    captureOriginalSourceAuthority: (
      input: Parameters<typeof sourceObligationObserverFixture.captureOriginalSourceAuthority>[0],
    ) =>
      sourceObligationObserverFixture.captureOriginalSourceAuthority({
        ...input,
        authorizedPaths: [...paths],
      }),
  };
}

/** Decode options for the editorial evidence the last runner built, to read its outcome. */
let editorialDecodeOptions: ReturnType<typeof scriptedEditorialProtocol>["decodeOptions"];

function updateRunner(
  harness: AgentHarness,
  store: RunStore,
  sourceEvidence?: Awaited<ReturnType<typeof buildUpdateSourceEvidence>>["runnerBinding"],
  options: {
    /** Every planned page, the first one `PAGE_PATH`. */
    readonly pages?: readonly string[];
    readonly validatedDecision?: ScriptedValidatedDecision;
  } = {},
) {
  const protocol = scriptedEditorialProtocol(harness, "update", options.validatedDecision);
  editorialDecodeOptions = protocol.decodeOptions;
  return new WorkflowRunner({
    ...protocol,
    hostOperations: { runStep: async () => ({ summary: "Fixture native checks passed" }) },
    store,
    repositoryScanner: new LocalRepositorySecurityScanner(),
    contextPreflight: readyContextPreflight,
    workflowSearch: new LocalWorkflowSearchCoordinator(),
    sourceObligationObserver: sourceObserverFixture(options.pages ?? [PAGE_PATH]),
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    repositoryEvidence: {
      capture: async (context: { persistPatch?: boolean }) => ({
        files: (options.pages ?? [PAGE_PATH]).map((path) => ({
          path,
          status: "modified" as const,
        })),
        ...(context.persistPatch
          ? {
              patch: {
                sha256: "e".repeat(64),
                byteLength: 128,
                lineCount: 6,
                artifactPath: "/tmp/docsfab-983-fixture.patch",
                format: "git-diff" as const,
              },
            }
          : {}),
      }),
    },
    ...(sourceEvidence ? { sourceEvidence } : {}),
    id: () => RUN_ID,
    now: () => new Date("2026-09-17T09:00:00.000Z"),
  } as ConstructorParameters<typeof WorkflowRunner>[0]);
}

function citationRefusal(code: string, remediation: string): string {
  return `DocsFab refused this source citation because the host reported ${code}. ${remediation} No citation was recorded.`;
}

const writeStepOf = (record: RunRecord) => record.steps.find((step) => step.mode === "write");
const writeCitations = (record: RunRecord) =>
  record.sourceCitations?.steps.find((entry) => entry.stepId === "write-documentation");

/** The located uncited claims a record carries for sentences of `PAGE_PATH`. */
function uncitedAt(...entries: readonly (readonly [line: number, sentence: string])[]) {
  return entries.map(([line, sentence]) => ({
    path: PAGE_PATH,
    line,
    claimSha256: sourceClaimSha256(sentence),
  }));
}

/** The shipped human footer for the run the last runner finished. */
function summaryText(record: RunRecord): string {
  return formatRunSummary({
    record,
    recordPath: "/fixtures/state/run.json",
    exitCode: 0,
    repositoryPath: "/fixtures/repository",
    tty: false,
    ci: true,
    noColor: true,
    editorialDecodeOptions,
  }).join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a source-grounded write keeps its patch (#1917)", () => {
  it(
    "delivers a write whose status reply reports unresolved items and checks not run",
    async () => {
      // The field shape: every documentation sentence is cited, and the writer's
      // reply carries the status lines its skill asks for. `plan-documentation` is
      // the only reading step, and the write step cites that read.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE, CLAIM_TWO),
        summary: STATUS_REPLY,
        cite: citeFirstSpan([CLAIM_ONE, CLAIM_TWO]),
      });
      const store = new MemoryStore();

      const record = await updateRunner(harness, store, evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      // Each status line is a sentence of four or more words: read as claims, as
      // the summary gate read them, all three were uncited and the run failed.
      expect(sourceMaterialClaims(STATUS_REPLY)).toHaveLength(3);
      expect(harness.citationRefusals).toEqual([]);
      expect(harness.readSteps).toEqual(["plan-documentation"]);
      // The citer reached exactly the writer, which is the policy's own grant.
      expect(harness.sawCiterOn).toEqual(["write-documentation"]);
      expect(harness.citeCalls).toBe(2);
      expect(record.status).toBe("succeeded");
      const write = writeStepOf(record)!;
      expect(write.status).toBe("succeeded");
      expect(write.error).toBeUndefined();
      // The reply is kept as the writer wrote it.
      expect(write.summary).toBe(STATUS_REPLY);
      expect(harness.writerCalls).toBe(1);
      expect(record.changes?.patch?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await readFile(join(workspace, PAGE_PATH), "utf8")).toBe(
        guidePage(CLAIM_ONE, CLAIM_TWO),
      );

      // The run record holds the host's citations, not the model's.
      const citations = record.sourceCitations!;
      expect(citations.kind).toBe("docsfab-source-run-citations");
      expect(citations.bindingSha256).toBe(evidence.binding.bindingSha256);
      expect(citations.steps.map((entry) => entry.stepId)).toEqual(["write-documentation"]);
      const gated = citations.steps[0]!;
      // The claims are the page's added sentences, not the reply's.
      expect([...gated.materialClaimSha256s]).toEqual(
        [sourceClaimSha256(CLAIM_ONE), sourceClaimSha256(CLAIM_TWO)].sort(),
      );
      expect(gated.uncitedClaims).toBeUndefined();
      // Per-run scope: the citation carries the step that read the span, which is
      // not the step that wrote.
      expect(gated.citations.map((entry) => entry.stepId)).toEqual([
        "plan-documentation",
        "plan-documentation",
      ]);
      expect(gated.citations.every((entry) => entry.spanAccessSha256s.length === 1)).toBe(true);
      for (const citation of gated.citations) {
        expect(gated.materialClaimSha256s).toContain(citation.supportedClaimSha256);
      }
      // The host's external-input join really ran, once per citation.
      expect(evidence.citationJoins).toHaveLength(2);
      // A fully cited write carries no citation label.
      expect(record.workflowOutcome?.limitations).not.toContain(SOURCE_CITATION_GAPS_LIMITATION);
      expect(summaryText(record)).not.toContain("Uncited sentences:");
    },
    testTimeoutMs(90_000),
  );

  it(
    "delivers a write with an uncited documentation sentence and names it by page and line",
    async () => {
      // The negative of the control above, differing in one variable: the second
      // sentence is written but not cited.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE, CLAIM_TWO),
        summary: STATUS_REPLY,
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citeCalls).toBe(1);
      // The finished write is kept and the run completes.
      expect(record.status).toBe("succeeded");
      expect(writeStepOf(record)?.status).toBe("succeeded");
      expect(writeStepOf(record)?.error).toBeUndefined();
      expect(record.changes?.patch?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const gated = writeCitations(record)!;
      expect([...gated.materialClaimSha256s]).toEqual(
        [sourceClaimSha256(CLAIM_ONE), sourceClaimSha256(CLAIM_TWO)].sort(),
      );
      // The second sentence starts on line 4 of the written page.
      expect(gated.uncitedClaims).toEqual(uncitedAt([4, CLAIM_TWO]));
      expect(gated.citations.map((entry) => entry.supportedClaimSha256)).toEqual([
        sourceClaimSha256(CLAIM_ONE),
      ]);
      // The product outcome labels the patch rather than discarding it.
      const outcome = record.workflowOutcome!;
      expect(outcome.limitations).toContain(SOURCE_CITATION_GAPS_LIMITATION);
      expect(outcome.findings).toContainEqual({
        id: `finding:${SOURCE_CITATION_GAPS_LIMITATION}`,
        kind: "evidence-limitation",
        severity: "warning",
        code: SOURCE_CITATION_GAPS_LIMITATION,
        evidenceIds: ["step:write-documentation"],
      });
      expect(outcome.disposition).not.toBe("ready");
      // Named by location, never quoted: the sentence is nowhere in the record.
      const saved = JSON.stringify(record);
      expect(saved).not.toContain(sourceClaimText(CLAIM_TWO));
      expect(saved).not.toContain(CLAIM_TWO);
      const footer = summaryText(record);
      expect(footer).toContain(
        `Uncited sentences: write-documentation added 1 sentence with no verified source citation, at ${PAGE_PATH}:4.`,
      );
      expect(footer).not.toContain(CLAIM_TWO);
      // NEXT reviews the kept patch; an uncited sentence is not a wall on the request.
      expect(footer).toContain(`(${SOURCE_CITATION_GAPS_LIMITATION})`);
      expect(footer).not.toContain("capability or policy wall");
    },
    testTimeoutMs(90_000),
  );

  it(
    "labels every added sentence when the write step cites nothing",
    async () => {
      // Tool bypass: `plan-documentation` read, so the required-source gate is
      // satisfied, and the writer never cites.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE, CLAIM_TWO),
        cite: () => [],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citeCalls).toBe(0);
      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)?.citations).toEqual([]);
      expect(writeCitations(record)?.uncitedClaims).toEqual(
        uncitedAt([3, CLAIM_ONE], [4, CLAIM_TWO]),
      );
      expect(summaryText(record)).toContain(
        `Uncited sentences: write-documentation added 2 sentences with no verified source citation, at ${PAGE_PATH}:3, ${PAGE_PATH}:4.`,
      );
    },
    testTimeoutMs(90_000),
  );

  it(
    "counts a sentence wrapped across lines as one claim, cited whole",
    async () => {
      // A hard-wrapped page: a model cites the sentence as it reads, unwrapped.
      const wrapped =
        "The bound release note records the new ceiling, and it also\nrecords the deprecation window for the old flag.";
      const unwrapped = wrapped.replace("\n", " ");
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(wrapped),
        cite: citeFirstSpan([unwrapped]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citationRefusals).toEqual([]);
      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)?.materialClaimSha256s).toEqual([sourceClaimSha256(unwrapped)]);
      expect(writeCitations(record)?.uncitedClaims).toBeUndefined();
    },
    testTimeoutMs(90_000),
  );

  it(
    "judges only the sentences the write step added to the page",
    async () => {
      // The page already held CLAIM_ONE at the revision; the writer keeps it and
      // adds CLAIM_TWO. Only the added sentence owes a citation.
      const workspace = await fixtureWorkspace();
      await writeFile(join(workspace, PAGE_PATH), guidePage(CLAIM_ONE));
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE, CLAIM_TWO),
        cite: () => [],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)?.materialClaimSha256s).toEqual([sourceClaimSha256(CLAIM_TWO)]);
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([4, CLAIM_TWO]));
    },
    testTimeoutMs(90_000),
  );

  it(
    "refuses a citation naming a span no step read in this run, and labels its sentence",
    async () => {
      const workspace = await fixtureWorkspace();
      // `plan-documentation` reads span 0, and the write step reads the spans
      // left after it only as far as its budget holds: every one but the last.
      // The writer cites that last span, which is in the sealed binding and
      // which nothing in this run opened.
      const spans = (await buildUpdateSourceEvidence(workspace)).representation.spans;
      const rest = spans.slice(1).reduce((total, span) => total + span.endByte - span.startByte, 0);
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
        perStepBudgetBytes: rest - 1,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: (inventory) => [
          {
            claim: CLAIM_ONE,
            observationId: inventory.at(-1)!.observationId,
            representationId: inventory.at(-1)!.representationId,
            spanIds: [inventory.at(-1)!.spanId],
          },
        ],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      // The model receives the tool's refusal, with its remediation.
      expect(harness.citationRefusals).toEqual([
        citationRefusal(
          "unread-span",
          "Have a source-granted step read the span with docsfab_read_source in this run before citing it.",
        ),
      ]);
      // Attributed to the citation family, not a path denial: a `denied-path` on a
      // write step with a plan binding becomes needs-input and skips the check.
      expect(harness.citationFailures).toEqual(["citation-refused"]);
      const write = writeStepOf(record)!;
      expect(write.status).toBe("succeeded");
      expect(write.summary).not.toContain("outside the approved documentation plan");
      // The refused citation was never recorded, so the claim is uncited.
      expect(writeCitations(record)?.citations).toEqual([]);
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([3, CLAIM_ONE_TEXT]));
    },
    testTimeoutMs(90_000),
  );

  it(
    "refuses a citation naming a forged span identifier",
    async () => {
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: (inventory) => [
          {
            claim: CLAIM_ONE,
            observationId: inventory[0]!.observationId,
            representationId: inventory[0]!.representationId,
            spanIds: [`span-${sha("forged-983").slice(0, 16)}`],
          },
        ],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citationRefusals).toEqual([
        citationRefusal(
          "unknown-span",
          "Name an observation, representation and span ids that docsfab_list_sources returned for this run.",
        ),
      ]);
      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([3, CLAIM_ONE_TEXT]));
    },
    testTimeoutMs(90_000),
  );

  it(
    "refuses a citation naming a span identifier minted at another revision",
    async () => {
      // Not a syntactic forgery: a real span id the shipped extractor produced
      // from a different revision of the document.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const other = await extractSourceRepresentation({
        adapter: htmlSourceExtractorAdapter,
        bytes: new Uint8Array(
          Buffer.from(
            "<html><body><p>A later revision of the same release note.</p>" +
              "<p>It carries a paragraph the sealed revision never had.</p></body></html>",
            "utf8",
          ),
        ),
        mediaType: "text/html",
      });
      const foreignSpanId = other.representation.spans[0]!.spanId;
      expect(evidence.representation.spans.some((span) => span.spanId === foreignSpanId)).toBe(
        false,
      );
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: (inventory) => [
          {
            claim: CLAIM_ONE,
            observationId: inventory[0]!.observationId,
            representationId: inventory[0]!.representationId,
            spanIds: [foreignSpanId],
          },
        ],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citationRefusals).toEqual([
        citationRefusal(
          "unknown-span",
          "Name an observation, representation and span ids that docsfab_list_sources returned for this run.",
        ),
      ]);
      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([3, CLAIM_ONE_TEXT]));
    },
    testTimeoutMs(90_000),
  );

  it(
    "refuses a citation whose claim is too short to be material",
    async () => {
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: (inventory) => [
          {
            claim: "Ceiling raised.",
            observationId: inventory[0]!.observationId,
            representationId: inventory[0]!.representationId,
            spanIds: [inventory[0]!.spanId],
          },
        ],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citationRefusals).toEqual([
        citationRefusal(
          "unsupported-claim",
          `Cite a whole sentence you write into the documentation, word for word as it appears there, of at least ${sourceClaimMinWords()} words (sources.claimMinWords).`,
        ),
      ]);
      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([3, CLAIM_ONE_TEXT]));
    },
    testTimeoutMs(90_000),
  );
});

describe("citation coverage stays opt-in (#983)", () => {
  it(
    "leaves a source run that did not opt in on its earlier behaviour",
    async () => {
      const workspace = await fixtureWorkspace();
      // No `sourceCiteSkills`: the policy without the citation opt-in.
      const evidence = await buildUpdateSourceEvidence(workspace);
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE, CLAIM_TWO),
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      // No citer, so no `docsfab_cite_source`, so no coverage check: the run
      // records no citation evidence and no label.
      expect(harness.sawCiterOn).toEqual([]);
      expect(harness.citeCalls).toBe(0);
      expect(writeStepOf(record)?.status).toBe("succeeded");
      expect(record.sourceCitations).toBeUndefined();
      expect(record.workflowOutcome?.limitations).not.toContain(SOURCE_CITATION_GAPS_LIMITATION);
      expect(evidence.policy.admittedTools).toEqual([
        "docsfab_list_sources",
        "docsfab_read_source",
      ]);
      expect(evidence.policy.sourceCiteSkills).toBeUndefined();
    },
    testTimeoutMs(90_000),
  );

  it("leaves an un-opted-in policy digest byte-identical to the shipped value", () => {
    // Pinned literal, not a symbol: the policy digest for
    // `CLI_SOURCE_READ_SKILLS` at the default budget (262,144 bytes since #1809)
    // without the citation opt-in. It catches the citation field leaking into
    // an un-opted-in digest.
    expect(createSourceStepPolicy({ sourceReadSkills: CLI_SOURCE_READ_SKILLS }).policySha256).toBe(
      "f612f55f862673311e476b069208f11ab8a8d25cb1aed573c3523dc821419280",
    );
    const opted = createSourceStepPolicy({
      sourceReadSkills: CLI_SOURCE_READ_SKILLS,
      sourceCiteSkills: CLI_SOURCE_CITE_SKILLS,
    });
    expect(opted.policySha256).not.toBe(
      "f612f55f862673311e476b069208f11ab8a8d25cb1aed573c3523dc821419280",
    );
    expect(opted.admittedTools).toContain("docsfab_cite_source");
  });

  it(
    "issues no citer when the host wired no citation join",
    async () => {
      // The second half of the opt-in, alone: the policy admits citation and the
      // host did not wire `recordCitation`, so no citer exists and the check does
      // not engage.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
        recordCitation: false,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE, CLAIM_TWO),
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.sawCiterOn).toEqual([]);
      expect(writeStepOf(record)?.status).toBe("succeeded");
      expect(record.sourceCitations).toBeUndefined();
    },
    testTimeoutMs(90_000),
  );

  it("admits the citation tool only under both halves of the grant", () => {
    expect(grantedTools("write", "inference", undefined, true, false, false)).not.toContain(
      "docsfab_cite_source",
    );
    expect(grantedTools("write", "inference", undefined, true, false, true)).toContain(
      "docsfab_cite_source",
    );
    const policy = createSourceStepPolicy({
      sourceReadSkills: CLI_SOURCE_READ_SKILLS,
      sourceCiteSkills: CLI_SOURCE_CITE_SKILLS,
    });
    expect(stepAdmitsSourceCite(policy, { skill: "write-documentation" })).toBe(true);
    expect(stepAdmitsSourceCite(policy, { skill: "review-documentation" })).toBe(false);
    expect(
      stepAdmitsSourceCite(createSourceStepPolicy({ sourceReadSkills: CLI_SOURCE_READ_SKILLS }), {
        skill: "write-documentation",
      }),
    ).toBe(false);
    expect(() =>
      createSourceStepPolicy({
        sourceReadSkills: ["plan-documentation"],
        sourceCiteSkills: ["write-documentation"],
      }),
    ).toThrowError(
      "A source-step policy admits source citation only to a skill it already admits to source reads. " +
        "Add write-documentation to sourceReadSkills, or drop it from sourceCiteSkills.",
    );
  });
});

describe("material claim extraction (#983)", () => {
  it("splits a text into one claim per qualifying sentence", () => {
    expect(sourceMaterialClaims(`${CLAIM_ONE} ${CLAIM_TWO}`)).toEqual([
      "the bound release note records the new ceiling.",
      "the bound release note also records the deprecation window.",
    ]);
  });

  it("drops fragments below the material word floor", () => {
    // Three words is furniture; four is an assertion. Nothing a model writes can
    // move the floor.
    expect(sourceMaterialClaims("Ceiling raised now. The ceiling was raised.")).toEqual([
      "the ceiling was raised.",
    ]);
    expect(sourceClaimMinWords()).toBe(4);
  });

  it("normalizes list markers and case so one claim is one digest", () => {
    expect(sourceClaimSha256("- The bound release note records the new ceiling.")).toBe(
      sourceClaimSha256("THE  bound release note   records the new ceiling."),
    );
    expect(sourceMaterialClaims("- The bound release note records the new ceiling.")).toEqual([
      "the bound release note records the new ceiling.",
    ]);
    // A heading is markup, not a claim.
    expect(sourceMaterialClaims("# The bound release note records the new ceiling.")).toEqual([]);
  });

  it("joins the lines of one paragraph, so a line break ends no sentence", () => {
    expect(sourceMaterialClaims(`${CLAIM_ONE}\n${CLAIM_TWO}`)).toHaveLength(2);
    expect(sourceMaterialClaims("The bound release note records\nthe new ceiling.")).toEqual([
      "the bound release note records the new ceiling.",
    ]);
  });

  it("does not collapse a multi-sentence text into one opaque claim", () => {
    // A whole-text digest would make these three sentences a single claim that
    // one citation could carry.
    const text = `${CLAIM_ONE} ${CLAIM_TWO} The bound release note names the supported adapters.`;
    expect(sourceMaterialClaimSha256s(text)).toHaveLength(3);
    expect(sourceMaterialClaimSha256s(text)).not.toContain(sourceClaimSha256(text));
  });

  it("counts only tokens that hold a letter or a digit as words", () => {
    // A table delimiter row has five tokens and no word.
    expect(sourceClaimWordCount(sourceClaimText("| --- | --- |"))).toBe(0);
    expect(sourceClaimWordCount(sourceClaimText("Use `--source` — to bind."))).toBe(4);
    expect(sourceMaterialClaims("| --- | --- |")).toEqual([]);
  });
});

describe("documentation claims are the sentences a write step adds (#1917)", () => {
  const claimsOf = (pages: Parameters<typeof sourceDocumentationClaims>[0]["pages"]) =>
    sourceDocumentationClaims({ pages, minWords: 4 }).map(({ path, line, claim }) => ({
      path,
      line,
      claim,
    }));

  it("names each added sentence by page and the line it starts on", () => {
    expect(
      claimsOf([
        {
          path: PAGE_PATH,
          before: guidePage("The fixture guide is stale."),
          // "Notes continue here." is three words: no claim, but it moves
          // CLAIM_TWO to the middle of line 5.
          after: guidePage(CLAIM_ONE, "Notes", `continue here. ${CLAIM_TWO}`),
        },
      ]),
    ).toEqual([
      { path: PAGE_PATH, line: 3, claim: sourceClaimText(CLAIM_ONE) },
      { path: PAGE_PATH, line: 5, claim: sourceClaimText(CLAIM_TWO) },
    ]);
  });

  it("does not count a kept, rewrapped, or moved sentence, and counts a changed one", () => {
    const moved = "The bound release note records the old flag.";
    const changed = "The bound release note records the new flag.";
    expect(
      claimsOf([
        {
          path: "docs/a.md",
          before: `${CLAIM_ONE}\n\nThe bound release note\nalso records the deprecation window.\n${moved}\n`,
          after: `${CLAIM_ONE}\n\n${CLAIM_TWO}\n${changed}\n`,
        },
        { path: "docs/b.md", before: "Unrelated text.\n", after: `${moved}\n` },
      ]),
    ).toEqual([{ path: "docs/a.md", line: 4, claim: sourceClaimText(changed) }]);
  });

  it("counts every sentence of a page the step created", () => {
    expect(claimsOf([{ path: "docs/new.md", before: null, after: guidePage(CLAIM_ONE) }])).toEqual([
      { path: "docs/new.md", line: 3, claim: sourceClaimText(CLAIM_ONE) },
    ]);
    expect(claimsOf([{ path: "docs/gone.md", before: guidePage(CLAIM_ONE), after: null }])).toEqual(
      [],
    );
  });

  it("skips front matter, fenced code, markup lines and headings, and ends blocks at items and rows", () => {
    const page = [
      "---",
      "title: The bound release note records everything",
      "---",
      "",
      "```bash",
      "docsfab run update-documentation --source docs/release-notes.html",
      "```",
      "<Note>",
      CLAIM_ONE,
      "</Note>",
      "## The bound release note heading here",
      "!!! note",
      "    The admonition body records the window.",
      "- The first list item names",
      "  its flag on a second line.",
      "- The second list item names one",
      "| Flag | Default | Meaning |",
      "| --- | --- | --- |",
      "| `--retries` | 3 | Attempts before the step fails. |",
    ].join("\n");
    expect(claimsOf([{ path: PAGE_PATH, before: null, after: page }])).toEqual([
      { path: PAGE_PATH, line: 9, claim: sourceClaimText(CLAIM_ONE) },
      { path: PAGE_PATH, line: 13, claim: "the admonition body records the window." },
      { path: PAGE_PATH, line: 14, claim: "the first list item names its flag on a second line." },
      { path: PAGE_PATH, line: 16, claim: "the second list item names one" },
      {
        path: PAGE_PATH,
        line: 19,
        claim: "| `--retries` | 3 | attempts before the step fails.",
      },
    ]);
  });

  it("splits added claims by this step's own citations", () => {
    const claims = sourceDocumentationClaims({
      pages: [{ path: PAGE_PATH, before: null, after: guidePage(CLAIM_ONE, CLAIM_TWO) }],
      minWords: 4,
    });
    const citation = { supportedClaimSha256: sourceClaimSha256(CLAIM_TWO) } as Parameters<
      typeof sourceDocumentationCitationCoverage
    >[0]["spanCitations"][number];
    const { cited, uncited } = sourceDocumentationCitationCoverage({
      claims,
      spanCitations: [citation],
    });
    expect(cited.map((claim) => claim.line)).toEqual([4]);
    expect(uncited.map((claim) => claim.line)).toEqual([3]);
  });
});

/**
 * Direct screen tests. `foreign-binding` is a ledger-side invariant: the run
 * capability holds its own binding's receipts, so a model cannot produce one
 * through the tool. It is proved here against receipts built with the shipped
 * `createSourceSpanAccess`, not claimed as a model-reachable refusal.
 */
async function screenFixture() {
  const bytes = new Uint8Array(await readFile(HTML_FIXTURE));
  const { representation } = await extractSourceRepresentation({
    adapter: htmlSourceExtractorAdapter,
    bytes,
    mediaType: "text/html",
  });
  const repository = {
    identitySha256: createHash("sha256").update(FIXTURE_SOURCE_PATH).digest("hex"),
    revision: FIXTURE_REVISION,
  };
  const observation = createSourceObservation({
    observationId: OBSERVATION_ID,
    originIdSha256: sha("origin-983-screen"),
    inputId: INPUT_ID,
    registrationSha256: sha("registration-983-screen"),
    runIdSha256: sha(RUN_ID),
    repository,
    requestSha256: sha("request-983-screen"),
    producerId: "workspace-tracked-files",
    producerVersion: "1",
    producerScopeSha256: PRODUCER_SCOPE,
    acquisitionReceiptSha256: sha("receipt-983-screen"),
    observedAt: "2026-09-17T09:00:00.000Z",
    original: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "text/html",
      locatorSha256: sha("docs/release-notes.html"),
      version: { kind: "repository-revision", revision: FIXTURE_REVISION },
      repositoryPath: "docs/release-notes.html",
    },
    representations: [representation],
  });
  const binding = createSourceBinding({
    runIdSha256: sha(RUN_ID),
    repository,
    requestSha256: sha("request-983-screen"),
    hostPolicySha256: sha("policy-983-screen"),
    producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
    parentBindingSha256: null,
    observations: [
      { observationId: OBSERVATION_ID, observationSha256: observation.observationSha256 },
    ],
    requiredObservationIds: [OBSERVATION_ID],
  });
  const spanId = representation.spans[0]!.spanId;
  const access = (overrides: { bindingSha256?: string; representationSha256?: string }) =>
    createSourceSpanAccess({
      bindingSha256: overrides.bindingSha256 ?? binding.bindingSha256,
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      representationSha256: overrides.representationSha256 ?? representation.representationSha256,
      stepId: "plan-documentation",
      accessObservationSha256: sha("access-983-screen"),
      spanIds: [spanId],
      observedAt: "2026-09-17T09:01:00.000Z",
    });
  const screen = (spanAccesses: Parameters<typeof screenSourceSpanCitation>[0]["spanAccesses"]) =>
    screenSourceSpanCitation({
      binding,
      observations: [observation],
      spanAccesses,
      request: {
        claim: CLAIM_ONE,
        observationId: OBSERVATION_ID,
        representationId: representation.representationId,
        spanIds: [spanId],
      },
      mintExternalInputCitationSha256: () => sha("join-983-screen"),
    });
  return { binding, observation, representation, spanId, access, screen };
}

/**
 * The real `docsfab_cite_source` tool over a real citer, reporting the refusal
 * text and the failure categories the tool itself recorded. Not the run
 * fixture: these argument-bound refusals are about the confined tool alone.
 */
async function citeToolFixture() {
  const fixture = await screenFixture();
  const categories: string[] = [];
  const citer = {
    cite: (request: {
      claim: string;
      observationId: string;
      representationId: string;
      spanIds: readonly string[];
    }) => {
      const citations = screenSourceSpanCitation({
        binding: fixture.binding,
        observations: [fixture.observation],
        spanAccesses: [fixture.access({})],
        request,
        mintExternalInputCitationSha256: () => sha("join-983-tool"),
      });
      return {
        supportedClaimSha256: citations[0]!.supportedClaimSha256,
        spanCitationSha256s: citations.map((entry) => entry.spanCitationSha256),
        readingStepIds: citations.map((entry) => entry.stepId),
      };
    },
  };
  const tool = createSourceToolDefinitions({
    reader: { listSources: () => [], read: () => ({}) as never },
    citer,
    recordFailure: (category) => categories.push(category),
  }).find((definition) => definition.name === "docsfab_cite_source")!;
  return {
    categories,
    async refusalFor(claim: string, spanIds: readonly string[] = [fixture.spanId]) {
      try {
        await tool.execute("cite-limit", {
          claim,
          observationId: OBSERVATION_ID,
          representationId: fixture.representation.representationId,
          spanIds: [...spanIds],
        });
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}

/** The same fixture, exposing one screen call per supplied claim text. */
async function screenFixtureForLimits() {
  const fixture = await screenFixture();
  return {
    screen: (claim: string) =>
      screenSourceSpanCitation({
        binding: fixture.binding,
        observations: [fixture.observation],
        spanAccesses: [fixture.access({})],
        request: {
          claim,
          observationId: OBSERVATION_ID,
          representationId: fixture.representation.representationId,
          spanIds: [fixture.spanId],
        },
        mintExternalInputCitationSha256: () => sha("join-983-limits"),
      }),
  };
}

describe("citation screening against the run ledger (#983)", () => {
  it("mints a citation whose seal names the reading step and its receipt", async () => {
    const fixture = await screenFixture();
    const supporting = fixture.access({});
    const [citation, ...rest] = fixture.screen([supporting]);
    expect(rest).toEqual([]);
    expect(citation!.stepId).toBe("plan-documentation");
    expect(citation!.spanAccessSha256s).toEqual([supporting.spanAccessSha256]);
    expect(citation!.supportedClaimSha256).toBe(sourceClaimSha256(CLAIM_ONE));
    expect(citation!.bindingSha256).toBe(fixture.binding.bindingSha256);
  });

  it("refuses a receipt sealed to another source binding", async () => {
    const fixture = await screenFixture();
    expect(() =>
      fixture.screen([fixture.access({ bindingSha256: sha("another-binding") })]),
    ).toThrow(new SourceCitationError("foreign-binding"));
  });

  it("refuses a receipt taken against another revision of the representation", async () => {
    const fixture = await screenFixture();
    expect(() =>
      fixture.screen([fixture.access({ representationSha256: sha("another-representation") })]),
    ).toThrow(new SourceCitationError("foreign-binding"));
  });

  it("refuses a citation with no supporting receipt at all", async () => {
    const fixture = await screenFixture();
    expect(() => fixture.screen([])).toThrow(new SourceCitationError("unread-span"));
  });
});

/**
 * Escapes that once let a run succeed with a claim carried by nothing, kept as
 * named cases so a change that reopens one fails a test naming it.
 */
describe("closed escapes: no added sentence goes unlabeled (#983, #1917)", () => {
  it(
    "does not let a citation of a sentence the page lacks cover the sentence it holds",
    async () => {
      // Every span cited was legitimately read, so the screen has nothing to
      // refuse: the citation is a real receipt attached to a sentence the step
      // never wrote. It is recorded, and it covers nothing.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_TWO),
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citeCalls).toBe(1);
      expect(harness.citationRefusals).toEqual([]);
      expect(record.status).toBe("succeeded");
      const gated = writeCitations(record)!;
      expect(gated.materialClaimSha256s).toEqual([sourceClaimSha256(CLAIM_TWO)]);
      expect(gated.citations.map((entry) => entry.supportedClaimSha256)).toEqual([
        sourceClaimSha256(CLAIM_ONE),
      ]);
      expect(gated.uncitedClaims).toEqual(uncitedAt([3, CLAIM_TWO]));
    },
    testTimeoutMs(90_000),
  );

  it(
    "keeps a write that adds no sentence of four or more words, with nothing to label",
    async () => {
      // The reply has no citable sentence either. The summary gate stopped this
      // write; the page holds no prose claim, so nothing is owed and nothing stops.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: "# Guide\n\n| Flag | Default |\n| --- | --- |\n| `--source` | none |\n",
        summary: "Docs updated. Guide revised. Ceiling changed. Done.",
        cite: () => [],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)).toEqual({
        stepId: "write-documentation",
        materialClaimSha256s: [],
        citations: [],
      });
      expect(record.workflowOutcome?.limitations).not.toContain(SOURCE_CITATION_GAPS_LIMITATION);
    },
    testTimeoutMs(90_000),
  );
});

describe("claim normalization is idempotent and its floor matches its digest (#983)", () => {
  const shapes = [
    "  - The bound release note records the new ceiling.",
    "\t> quoted claim about the bound release note.",
    "  1. The first ordered item about the bound note.",
    " * nested bullet with several words here",
    "### A heading that reads like a claim here",
    "- - doubled marker with several words here",
  ];

  it("normalizes to a fixed point", () => {
    // The tool normalizes a model-supplied sentence, the coverage check
    // normalizes the written page, and the two have to agree.
    for (const shape of shapes) {
      const once = sourceClaimText(shape);
      expect(sourceClaimText(once)).toBe(once);
      expect(once.startsWith("-")).toBe(false);
      expect(once.startsWith(">")).toBe(false);
      expect(once.startsWith("#")).toBe(false);
    }
  });

  it("counts words on the same text the digest is taken on", () => {
    for (const shape of shapes) {
      const text = sourceClaimText(shape);
      expect(sourceClaimSha256(shape)).toBe(sourceClaimSha256(text));
      expect(sourceClaimWordCount(text)).toBe(sourceClaimWordCount(sourceClaimText(text)));
    }
  });

  it(
    "does not turn an indented three-word bullet into an obligation",
    async () => {
      expect(sourceMaterialClaims("Changes:\n  - ceiling raised now\n")).toEqual([]);

      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: `# Guide\n\nChanges:\n  - ceiling raised now\n\n${CLAIM_ONE}\n`,
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      // The short bullet is not a claim; the real sentence is, and it is covered.
      expect(harness.citationRefusals).toEqual([]);
      expect(writeStepOf(record)?.status).toBe("succeeded");
      expect(writeCitations(record)?.materialClaimSha256s).toEqual([sourceClaimSha256(CLAIM_ONE)]);
      expect(writeCitations(record)?.uncitedClaims).toBeUndefined();
    },
    testTimeoutMs(90_000),
  );

  it(
    "keeps an indented four-word bullet as a claim, and it is citable",
    async () => {
      // The limit-plus-one side of the floor: one more word and the same shape
      // becomes a claim, which must then be satisfiable.
      expect(sourceMaterialClaims("Changes:\n  - the ceiling was raised\n")).toEqual([
        "the ceiling was raised",
      ]);
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: "# Guide\n\nChanges:\n  - the ceiling was raised\n",
        cite: citeFirstSpan(["  - the ceiling was raised"]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citationRefusals).toEqual([]);
      expect(writeStepOf(record)?.status).toBe("succeeded");
      expect(writeCitations(record)?.materialClaimSha256s).toEqual([
        sourceClaimSha256("the ceiling was raised"),
      ]);
      expect(writeCitations(record)?.uncitedClaims).toBeUndefined();
    },
    testTimeoutMs(90_000),
  );
});

describe("sentence segmentation keeps ordinary abbreviations citable (#983)", () => {
  it("does not split inside an abbreviation, an initial or a numbered reference", () => {
    expect(sourceMaterialClaims("The U.S. release note records the new ceiling.")).toEqual([
      "the u.s. release note records the new ceiling.",
    ]);
    expect(sourceMaterialClaims("See Fig. 4 for the deprecation window details.")).toEqual([
      "see fig. 4 for the deprecation window details.",
    ]);
    expect(sourceMaterialClaims("Use approx. 5 minutes for the whole run.")).toEqual([
      "use approx. 5 minutes for the whole run.",
    ]);
    expect(sourceMaterialClaims("Release 1.2 changes the retry ceiling here.")).toEqual([
      "release 1.2 changes the retry ceiling here.",
    ]);
  });

  it("does not split a declared abbreviation followed by a capital letter", () => {
    // The abbreviation list is load-bearing only here: every earlier case is
    // followed by a lowercase word or a digit, which the lowercase/digit rule
    // alone carries.
    expect(sourceMaterialClaims("Compare vs. The other adapter is slower.")).toEqual([
      "compare vs. the other adapter is slower.",
    ]);
    expect(sourceMaterialClaims("Contact et al. The guide lists it here.")).toEqual([
      "contact et al. the guide lists it here.",
    ]);
  });

  it("does not split an initial or a dotted acronym followed by a capital letter", () => {
    // The initials rule alone -- neither shape is in the abbreviation list. One
    // rule covers both: a one-letter token has no dot, so its tail is itself.
    expect(sourceMaterialClaims("See the parameter A. The guide lists it.")).toEqual([
      "see the parameter a. the guide lists it.",
    ]);
    expect(sourceMaterialClaims("It ships to the U.S. The guide lists it.")).toEqual([
      "it ships to the u.s. the guide lists it.",
    ]);
  });

  it("splits at an abbreviation the list does not declare", () => {
    // Negative control: `Nov.` is absent from the list, so it splits and the
    // three-word opening drops below the floor. That makes the assertions above
    // about the protections, not about a segmenter that never splits.
    expect(sourceMaterialClaims("Released in Nov. The guide lists it here.")).toEqual([
      "the guide lists it here.",
    ]);
  });

  it("still splits a sentence that ends in a number", () => {
    // A single letter before the period is an initial; a single digit is not.
    // Conflating them silently merges a sentence with the next.
    expect(
      sourceMaterialClaims("The bound note records reading number 0. The guide was revised."),
    ).toEqual(["the bound note records reading number 0.", "the guide was revised."]);
  });

  it("still splits real sentence boundaries", () => {
    expect(
      sourceMaterialClaims("The bound note records the ceiling. The guide was revised today."),
    ).toEqual(["the bound note records the ceiling.", "the guide was revised today."]);
  });

  it(
    "lets a model cite a sentence containing an abbreviation, end to end",
    async () => {
      // Splitting at `U.S.` would owe the fragment `release note records the new
      // ceiling.`, a claim no whole-sentence citation covers.
      const claim = "The U.S. release note records the new ceiling.";
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(claim),
        cite: citeFirstSpan([claim]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citationRefusals).toEqual([]);
      expect(writeStepOf(record)?.status).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toBeUndefined();
    },
    testTimeoutMs(90_000),
  );
});

describe("citation refusals are their own failure category (#983)", () => {
  it(
    "does not divert a refused citation into the documentation-plan stop",
    async () => {
      // A `denied-path` on a write step with a plan binding converts the step to
      // needs-input ("requested a path outside the approved documentation plan")
      // and skips the coverage check.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: (inventory) => [
          {
            claim: CLAIM_ONE,
            observationId: inventory[0]!.observationId,
            representationId: inventory[0]!.representationId,
            spanIds: [`span-${sha("forged-category-983").slice(0, 16)}`],
          },
        ],
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(harness.citationFailures).toEqual(["citation-refused"]);
      const write = writeStepOf(record)!;
      expect(write.status).toBe("succeeded");
      expect(write.summary ?? "").not.toContain("outside the approved documentation plan");
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([3, CLAIM_ONE]));
    },
    testTimeoutMs(90_000),
  );
});

describe("the one remaining stop is coded as a DocsFab defect (#1917)", () => {
  it("does not blame the model for a contradiction inside DocsFab", () => {
    const stop = sourceCitationLedgerContradiction({
      stepId: "write-documentation",
      codes: ["unread-span", "unread-span", "unknown-span"],
    });
    expect(stop).toContain("DocsFab's own citation ledger did not verify");
    expect(stop).toContain("(unknown-span, unread-span)");
    expect(stop).toContain(
      "This is a DocsFab defect, not a problem with the written documentation.",
    );
  });

  it("classifies the ledger stop by its own code and class, never uncoded-error", () => {
    const error = new SourceCitationLedgerError({
      stepId: "write-documentation",
      codes: ["wrong-step"],
    });
    expect(error.code).toBe(SOURCE_CITATION_LEDGER_CONTRADICTION_CODE);
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: SOURCE_CITATION_LEDGER_CONTRADICTION_CODE,
    });
    expect(DEFAULT_NEXT_ACTIONS[SOURCE_CITATION_LEDGER_CONTRADICTION_CODE]).toContain(
      "The saved run keeps the written patch for review",
    );
  });

  it(
    "stops a run whose own citation ledger contradicts itself, with that code",
    async () => {
      // Unreachable through the tool, which screens against the same ledger, so
      // the fixture tampers with what the capability reports for the write step.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const service = evidence.runnerBinding.service;
      const tampered = {
        ...evidence.runnerBinding,
        service: {
          bindRun: (...input: Parameters<typeof service.bindRun>): SourceRunCapabilityV1 => {
            const capability = service.bindRun(...input);
            return {
              ...capability,
              // Attribute each citation to the writer, which read nothing itself.
              spanCitationsFor: (stepId: string) =>
                capability
                  .spanCitationsFor(stepId)
                  .map((citation) => ({ ...citation, stepId: "write-documentation" })),
            };
          },
        },
      };
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), tampered).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(record.status).toBe("failed");
      const write = writeStepOf(record)!;
      expect(write.status).toBe("failed");
      expect(write.error).toBe(
        sourceCitationLedgerContradiction({
          stepId: "write-documentation",
          codes: ["wrong-step"],
        }),
      );
      expect(write.failure).toEqual({
        class: "contract-shape",
        layer: "workflow",
        code: SOURCE_CITATION_LEDGER_CONTRADICTION_CODE,
      });
      expect(record.sourceCitations).toBeUndefined();
    },
    testTimeoutMs(90_000),
  );
});

describe("the citation channel is narrowed to write steps (#983)", () => {
  it(
    "issues no citer to a read-only step even when the policy admits its skill",
    async () => {
      // A read-only step gets no citer, so it is never judged as a write.
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: ["review-documentation", "write-documentation"],
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      expect(evidence.policy.sourceCiteSkills).toContain("review-documentation");
      // The policy admits it; the step mode does not.
      expect(harness.sawCiterOn).toEqual(["write-documentation"]);
      expect(writeStepOf(record)?.status).toBe("succeeded");
      expect(record.sourceCitations?.steps.map((entry) => entry.stepId)).toEqual([
        "write-documentation",
      ]);
    },
    testTimeoutMs(90_000),
  );
});

describe("the claim word floor is declared, overridable, and shared (#1917)", () => {
  it("declares each bound with a value the code actually uses", () => {
    expect(sourceClaimMinWords()).toBe(4);
    expect(SOURCE_CITE_MAX_SPANS_PER_CALL).toBe(32);
    expect(SOURCE_CITE_MAX_CLAIMS_PER_CALL).toBe(8);
  });

  it("holds at the word floor and at the floor minus one", () => {
    const atLimit = "the ceiling was raised";
    const belowLimit = "ceiling was raised";
    expect(sourceClaimWordCount(sourceClaimText(atLimit))).toBe(sourceClaimMinWords());
    expect(sourceClaimWordCount(sourceClaimText(belowLimit))).toBe(sourceClaimMinWords() - 1);
    expect(sourceMaterialClaims(atLimit)).toEqual([atLimit]);
    expect(sourceMaterialClaims(belowLimit)).toEqual([]);
  });

  it("accepts an override from 1 through 64 and refuses one outside that range", () => {
    const at = (value: string) =>
      sourceClaimMinWords({ environment: { [CLAIM_MIN_WORDS_OVERRIDE]: value } });
    expect(at("1")).toBe(1);
    expect(at("64")).toBe(64);
    expect(() => at("0")).toThrowError(
      "DOCSFAB_SOURCES_CLAIM_MIN_WORDS must be an integer between 1 and 64.",
    );
    expect(() => at("65")).toThrowError(
      "DOCSFAB_SOURCES_CLAIM_MIN_WORDS must be an integer between 1 and 64.",
    );
  });

  it(
    "labels only longer sentences when the host raises the floor",
    async () => {
      // CLAIM_ONE has eight words and CLAIM_TWO nine; at a floor of nine only the
      // second is a claim. The default-floor control is the cite-nothing case
      // above, where both are.
      vi.stubEnv(CLAIM_MIN_WORDS_OVERRIDE, "9");
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE, CLAIM_TWO),
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      );

      // The cite tool reads the same floor: an eight-word sentence is not citable.
      expect(harness.citationRefusals).toEqual([
        citationRefusal(
          "unsupported-claim",
          "Cite a whole sentence you write into the documentation, word for word as it appears there, of at least 9 words (sources.claimMinWords).",
        ),
      ]);
      expect(record.status).toBe("succeeded");
      expect(writeCitations(record)?.materialClaimSha256s).toEqual([sourceClaimSha256(CLAIM_TWO)]);
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([4, CLAIM_TWO]));
    },
    testTimeoutMs(90_000),
  );

  it(
    "labels shorter sentences when the host lowers the floor",
    async () => {
      const short = "Raised the ceiling.";
      const run = async () => {
        const workspace = await fixtureWorkspace();
        const evidence = await buildUpdateSourceEvidence(workspace, {
          citeSkills: CLI_SOURCE_CITE_SKILLS,
        });
        const harness = new CitingWriteHarness(["plan-documentation"], {
          page: guidePage(short, CLAIM_ONE),
          cite: citeFirstSpan([CLAIM_ONE]),
        });
        return updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
          updateRunRequest(workspace, evidence.reference) as never,
        );
      };

      // Control: at the default floor the three-word sentence is not a claim.
      const atDefault = await run();
      expect(writeCitations(atDefault)?.uncitedClaims).toBeUndefined();

      vi.stubEnv(CLAIM_MIN_WORDS_OVERRIDE, "3");
      const lowered = await run();
      expect(lowered.status).toBe("succeeded");
      expect(writeCitations(lowered)?.uncitedClaims).toEqual(uncitedAt([3, short]));
    },
    testTimeoutMs(90_000),
  );
});

describe("declared per-call citation ceilings (#983)", () => {
  it("holds at the per-call claim ceiling and refuses at the ceiling plus one", async () => {
    const fixture = await screenFixtureForLimits();
    const sentence = (index: number) => `The bound note records reading number ${index}.`;
    const atLimit = Array.from({ length: SOURCE_CITE_MAX_CLAIMS_PER_CALL }, (_, index) =>
      sentence(index),
    ).join(" ");
    const overLimit = Array.from({ length: SOURCE_CITE_MAX_CLAIMS_PER_CALL + 1 }, (_, index) =>
      sentence(index),
    ).join(" ");
    expect(sourceMaterialClaims(atLimit)).toHaveLength(SOURCE_CITE_MAX_CLAIMS_PER_CALL);
    expect(fixture.screen(atLimit)).toHaveLength(SOURCE_CITE_MAX_CLAIMS_PER_CALL);
    // Refuses with a code rather than registering a prefix, and says why.
    expect(() => fixture.screen(overLimit)).toThrow(
      new SourceCitationError(
        "unsupported-claim",
        `This call carried ${SOURCE_CITE_MAX_CLAIMS_PER_CALL + 1} sentences; the limit sources.citeMaxClaimsPerCall is ${SOURCE_CITE_MAX_CLAIMS_PER_CALL}. Cite fewer sentences per call.`,
      ),
    );
  });

  it(
    "holds at the per-call claim-character ceiling and refuses at the ceiling plus one",
    async () => {
      // Both declared per-call bounds, driven through the real confined tool so the
      // category and the sentence are the ones a model receives.
      const fixture = await citeToolFixture();
      const filler = "the bound release note records reading ";
      const atLimit = filler.repeat(60).slice(0, SOURCE_CITE_MAX_CLAIM_CHARACTERS);
      expect(atLimit).toHaveLength(SOURCE_CITE_MAX_CLAIM_CHARACTERS);
      // At the limit the call is admitted and succeeds outright.
      expect(await fixture.refusalFor(atLimit)).toBe("");
      expect(fixture.categories).toEqual([]);

      const overLimit = `${atLimit}x`;
      const refusal = await fixture.refusalFor(overLimit);
      expect(refusal).toContain("unsupported-claim");
      expect(refusal).toContain(`carried ${overLimit.length} characters`);
      expect(refusal).toContain(
        `the limit SOURCE_CITE_MAX_CLAIM_CHARACTERS is ${SOURCE_CITE_MAX_CLAIM_CHARACTERS}`,
      );
      expect(refusal).not.toContain("outside the approved documentation plan");
      // One refusal, in the citation family, not `denied-path`, which would divert
      // the step to the documentation-plan stop.
      expect(fixture.categories).toEqual(["citation-refused"]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "holds at the per-call span ceiling and refuses at the ceiling plus one",
    async () => {
      const fixture = await citeToolFixture();
      const spanId = (index: number) => `span-${sha(`limit-${index}`).slice(0, 16)}`;
      const atLimit = Array.from({ length: SOURCE_CITE_MAX_SPANS_PER_CALL }, (_, i) => spanId(i));
      const overLimit = [...atLimit, spanId(SOURCE_CITE_MAX_SPANS_PER_CALL)];

      // At the limit: admitted by the bound, refused on membership instead.
      const atRefusal = await fixture.refusalFor(CLAIM_ONE, atLimit);
      expect(atRefusal).not.toContain("SOURCE_CITE_MAX_SPANS_PER_CALL");
      expect(atRefusal).toContain("unknown-span");

      const overRefusal = await fixture.refusalFor(CLAIM_ONE, overLimit);
      expect(overRefusal).toContain(`named ${overLimit.length} span ids`);
      expect(overRefusal).toContain(
        `the limit SOURCE_CITE_MAX_SPANS_PER_CALL is ${SOURCE_CITE_MAX_SPANS_PER_CALL}`,
      );
      expect(fixture.categories).toEqual(["citation-refused", "citation-refused"]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses an empty claim as a citation refusal, not a path denial",
    async () => {
      const fixture = await citeToolFixture();
      const refusal = await fixture.refusalFor("");
      expect(refusal).toContain("The claim argument was empty.");
      expect(refusal).not.toContain("source read");
      expect(fixture.categories).toEqual(["citation-refused"]);
    },
    testTimeoutMs(60_000),
  );
});

describe("the outcome label for uncited sentences (#1917)", () => {
  const record = (uncited: boolean) =>
    ({
      workflow: "update-documentation",
      repository: {
        sourcePath: FIXTURE_SOURCE_PATH,
        requestedRevision: "HEAD",
        revision: FIXTURE_REVISION,
      },
      steps: [
        {
          id: "write-documentation",
          title: "Write",
          kind: "inference",
          skill: "write-documentation",
          mode: "write",
          status: "succeeded",
          summary: STATUS_REPLY,
        },
      ],
      sourceCitations: {
        schemaVersion: 1,
        kind: "docsfab-source-run-citations",
        bindingSha256: sha("binding-1917"),
        steps: [
          {
            stepId: "write-documentation",
            materialClaimSha256s: [sourceClaimSha256(CLAIM_ONE)],
            citations: [],
            ...(uncited ? { uncitedClaims: uncitedAt([3, CLAIM_ONE]) } : {}),
          },
        ],
      },
    }) as unknown as RunRecord;
  const ready: WorkflowOutcomeCandidateV1 = {
    disposition: "ready",
    findings: [],
    evidence: [],
    limitations: [],
    openDecisions: [],
    producedArtifacts: [],
  };

  it("turns a ready candidate inconclusive, citing the step, and only once", () => {
    const labeled = recordSourceCitationGaps(ready, record(true));
    expect(labeled.disposition).toBe("inconclusive");
    expect(labeled.limitations).toEqual([SOURCE_CITATION_GAPS_LIMITATION]);
    expect(labeled.findings.map((finding) => finding.evidenceIds)).toEqual([
      ["step:write-documentation"],
    ]);
    expect(labeled.evidence.map((item) => item.id)).toEqual(["step:write-documentation"]);
    // Re-applied, the host rebuilds its own copy: the same label, once.
    expect(recordSourceCitationGaps(labeled, record(true))).toEqual(labeled);
  });

  it("leaves a candidate alone when every added sentence is cited", () => {
    expect(recordSourceCitationGaps(ready, record(false))).toBe(ready);
  });
});

/** A cite-nothing update run whose writer leaves `page`, through the real runner. */
async function runCitingNothing(page: string, morePages?: Readonly<Record<string, string>>) {
  const workspace = await fixtureWorkspace();
  for (const path of Object.keys(morePages ?? {})) {
    await writeFile(join(workspace, path), "# Page\n\nThis planned page is stale.\n");
  }
  const evidence = await buildUpdateSourceEvidence(workspace, {
    citeSkills: CLI_SOURCE_CITE_SKILLS,
  });
  const harness = new CitingWriteHarness(["plan-documentation"], {
    page,
    ...(morePages ? { morePages } : {}),
    cite: () => [],
  });
  return updateRunner(harness, new MemoryStore(), evidence.runnerBinding, {
    pages: [PAGE_PATH, ...Object.keys(morePages ?? {})],
  }).run(updateRunRequest(workspace, evidence.reference) as never);
}

describe("fences follow CommonMark, so no prose hides behind a non-fence (#1917)", () => {
  it(
    "labels the sentences after a line that opens with an inline triple-backtick span",
    async () => {
      // A backtick fence's info string holds no backtick, so line 3 is prose
      // and opens no fence that would swallow lines 4 and 5.
      const inline = "```--fast``` turns on the fast path.";
      const record = await runCitingNothing(guidePage(inline, CLAIM_ONE, CLAIM_TWO));
      expect(record.status, record.error).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toEqual(
        uncitedAt([3, inline], [4, CLAIM_ONE], [5, CLAIM_TWO]),
      );
    },
    testTimeoutMs(90_000),
  );

  it(
    "labels the sentence after a three-backtick line inside indented code",
    async () => {
      // Four columns of indentation outside a list is code, not a fence.
      const record = await runCitingNothing(
        ["# Guide", "", "Type a fence:", "", "    ```", "", CLAIM_ONE, ""].join("\n"),
      );
      expect(record.status, record.error).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([7, CLAIM_ONE]));
    },
    testTimeoutMs(90_000),
  );

  it(
    "keeps a fence open past a fence line that carries an info string",
    async () => {
      // Only a bare fence at least as long as the opener closes it, so line 4 is
      // code, line 6 closes, and the sentence on line 8 is prose.
      const record = await runCitingNothing(
        [
          "# Guide",
          "",
          "```",
          "```text",
          "The code line records the bound ceiling value.",
          "```",
          "",
          CLAIM_ONE,
          "",
        ].join("\n"),
      );
      expect(record.status, record.error).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toEqual(uncitedAt([8, CLAIM_ONE]));
    },
    testTimeoutMs(90_000),
  );

  it("still skips a fence indented inside a list item, and admonition markers", () => {
    // The positive control: a fence indented four columns under `1. ` sits
    // inside the item, so its code line is no claim.
    const page = [
      "1. Install the package:",
      "",
      "    ```bash",
      "    pip install the bound release package now",
      "    ```",
      "",
      CLAIM_ONE,
      ":::tip",
      CLAIM_TWO,
      ":::",
    ].join("\n");
    expect(
      sourceDocumentationClaims({
        pages: [{ path: PAGE_PATH, before: null, after: page }],
        minWords: 4,
      }).map(({ line, claim }) => ({ line, claim })),
    ).toEqual([
      { line: 7, claim: sourceClaimText(CLAIM_ONE) },
      { line: 9, claim: sourceClaimText(CLAIM_TWO) },
    ]);
  });
});

describe("every planned page and every citing step is judged (#1917)", () => {
  it(
    "labels an uncited sentence on the second planned page by that page and line",
    async () => {
      const second = "docs/second.md";
      const workspace = await fixtureWorkspace();
      await writeFile(join(workspace, second), "# Second\n\nThe second page is stale.\n");
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        morePages: { [second]: `# Second\n\n${CLAIM_TWO}\n` },
        cite: citeFirstSpan([CLAIM_ONE]),
      });

      const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding, {
        pages: [PAGE_PATH, second],
      }).run(updateRunRequest(workspace, evidence.reference) as never);

      expect(record.status, record.error).toBe("succeeded");
      expect(writeCitations(record)?.materialClaimSha256s).toEqual(
        [sourceClaimSha256(CLAIM_ONE), sourceClaimSha256(CLAIM_TWO)].sort(),
      );
      expect(writeCitations(record)?.uncitedClaims).toEqual([
        { path: second, line: 3, claimSha256: sourceClaimSha256(CLAIM_TWO) },
      ]);
      expect(summaryText(record)).toContain(
        `Uncited sentences: write-documentation added 1 sentence with no verified source citation, at ${second}:3.`,
      );
    },
    testTimeoutMs(90_000),
  );

  it("cites every write step that left a gap in the one outcome finding", () => {
    const gapRecord = {
      workflow: "create-documentation",
      repository: {
        sourcePath: FIXTURE_SOURCE_PATH,
        requestedRevision: "HEAD",
        revision: FIXTURE_REVISION,
      },
      steps: ["write-documentation", "revise-documentation"].map((id) => ({
        id,
        title: id,
        kind: "inference",
        skill: "write-documentation",
        mode: "write",
        status: "succeeded",
        summary: STATUS_REPLY,
      })),
      sourceCitations: {
        schemaVersion: 1,
        kind: "docsfab-source-run-citations",
        bindingSha256: sha("binding-1917-two"),
        steps: [
          ["write-documentation", CLAIM_ONE],
          ["revise-documentation", CLAIM_TWO],
        ].map(([stepId, claim]) => ({
          stepId,
          materialClaimSha256s: [sourceClaimSha256(claim!)],
          citations: [],
          uncitedClaims: [{ path: PAGE_PATH, line: 3, claimSha256: sourceClaimSha256(claim!) }],
        })),
      },
    } as unknown as RunRecord;
    const labeled = recordSourceCitationGaps(
      {
        disposition: "ready",
        findings: [],
        evidence: [],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      },
      gapRecord,
    );
    expect(labeled.findings).toEqual([
      expect.objectContaining({
        code: SOURCE_CITATION_GAPS_LIMITATION,
        evidenceIds: ["step:write-documentation", "step:revise-documentation"],
      }),
    ]);
    expect(labeled.evidence.map((item) => item.id)).toEqual([
      "step:write-documentation",
      "step:revise-documentation",
    ]);
  });
});

describe("the host owns the source-citation-gaps label (#1917)", () => {
  async function runWithDecision(
    cite: readonly string[],
    validatedDecision: ScriptedValidatedDecision,
  ) {
    const workspace = await fixtureWorkspace();
    const evidence = await buildUpdateSourceEvidence(workspace, {
      citeSkills: CLI_SOURCE_CITE_SKILLS,
    });
    const harness = new CitingWriteHarness(["plan-documentation"], {
      page: guidePage(CLAIM_ONE, CLAIM_TWO),
      cite: citeFirstSpan(cite),
    });
    return updateRunner(harness, new MemoryStore(), evidence.runnerBinding, {
      validatedDecision,
    }).run(updateRunRequest(workspace, evidence.reference) as never);
  }

  it(
    "replaces a model-authored copy with the host's when the host found a gap",
    async () => {
      const record = await runWithDecision([CLAIM_ONE], {
        limitations: [SOURCE_CITATION_GAPS_LIMITATION],
      });
      expect(record.status, record.error).toBe("succeeded");
      const outcome = record.workflowOutcome!;
      expect(
        outcome.findings.filter((item) => item.code === SOURCE_CITATION_GAPS_LIMITATION),
      ).toEqual([
        {
          id: `finding:${SOURCE_CITATION_GAPS_LIMITATION}`,
          kind: "evidence-limitation",
          severity: "warning",
          code: SOURCE_CITATION_GAPS_LIMITATION,
          evidenceIds: ["step:write-documentation"],
        },
      ]);
      expect(
        outcome.limitations.filter((code) => code === SOURCE_CITATION_GAPS_LIMITATION),
      ).toEqual([SOURCE_CITATION_GAPS_LIMITATION]);
    },
    testTimeoutMs(90_000),
  );

  it(
    "drops a model-authored copy when every added sentence is cited",
    async () => {
      const record = await runWithDecision([CLAIM_ONE, CLAIM_TWO], {
        limitations: [SOURCE_CITATION_GAPS_LIMITATION],
      });
      expect(record.status, record.error).toBe("succeeded");
      expect(writeCitations(record)?.uncitedClaims).toBeUndefined();
      expect(record.workflowOutcome?.limitations).not.toContain(SOURCE_CITATION_GAPS_LIMITATION);
      expect(record.workflowOutcome?.findings.map((item) => item.code)).not.toContain(
        SOURCE_CITATION_GAPS_LIMITATION,
      );
    },
    testTimeoutMs(90_000),
  );

  it(
    "admits a reversed decision that lists the code when the host found no gap",
    async () => {
      // The editorial check requires the decision's other limitations on the
      // outcome, but not the host's code: refusing here would be a new stop.
      const record = await runWithDecision([CLAIM_ONE, CLAIM_TWO], {
        candidate: "insufficient-evidence",
        limitations: ["evidence-limitation.bound-source-silent", SOURCE_CITATION_GAPS_LIMITATION],
      });
      expect(record.status, record.error).toBe("succeeded");
      expect(record.workflowOutcome?.disposition).toBe("inconclusive");
      expect(record.workflowOutcome?.limitations).toContain(
        "evidence-limitation.bound-source-silent",
      );
      expect(record.workflowOutcome?.limitations).not.toContain(SOURCE_CITATION_GAPS_LIMITATION);
    },
    testTimeoutMs(90_000),
  );

  it("prunes only the evidence a dropped copy alone used, and keeps a copy it cannot drop", () => {
    const record = {
      workflow: "update-documentation",
      repository: {
        sourcePath: FIXTURE_SOURCE_PATH,
        requestedRevision: "HEAD",
        revision: FIXTURE_REVISION,
      },
      steps: [],
    } as unknown as RunRecord;
    const step = (id: string) => ({
      id: `step:${id}`,
      kind: "step" as const,
      stepId: id,
      sha256: sha(id),
    });
    const copy = {
      id: `finding:authoring-quality:${SOURCE_CITATION_GAPS_LIMITATION}`,
      kind: "evidence-limitation" as const,
      severity: "warning" as const,
      code: SOURCE_CITATION_GAPS_LIMITATION,
      evidenceIds: ["step:alone", "step:shared"],
    };
    const other = {
      id: "finding:authoring-quality:insufficient-evidence",
      kind: "evidence-limitation" as const,
      severity: "warning" as const,
      code: "insufficient-evidence",
      evidenceIds: ["step:shared"],
    };
    const candidate: WorkflowOutcomeCandidateV1 = {
      disposition: "inconclusive",
      findings: [copy, other],
      evidence: [step("alone"), step("shared")],
      limitations: [SOURCE_CITATION_GAPS_LIMITATION, "insufficient-evidence"],
      openDecisions: [],
      producedArtifacts: [],
    };
    const dropped = recordSourceCitationGaps(candidate, record);
    expect(dropped.findings).toEqual([other]);
    expect(dropped.evidence.map((item) => item.id)).toEqual(["step:shared"]);
    expect(dropped.limitations).toEqual(["insufficient-evidence"]);
    // Dropping the only evidence limitation would make the outcome invalid, so
    // the copy stays rather than the run stopping.
    const only = { ...candidate, findings: [copy], limitations: [SOURCE_CITATION_GAPS_LIMITATION] };
    expect(recordSourceCitationGaps(only, record)).toBe(only);
  });
});

describe("a planned page the check cannot read is a coded stop (#1917)", () => {
  it.skipIf(process.getuid?.() === 0)(
    "names the page and the error code, classed as infrastructure",
    async () => {
      const workspace = await fixtureWorkspace();
      const evidence = await buildUpdateSourceEvidence(workspace, {
        citeSkills: CLI_SOURCE_CITE_SKILLS,
      });
      const harness = new CitingWriteHarness(["plan-documentation"], {
        page: guidePage(CLAIM_ONE),
        cite: () => [],
        afterWrite: (repositoryPath) => chmod(join(repositoryPath, PAGE_PATH), 0o000),
      });
      try {
        const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
          updateRunRequest(workspace, evidence.reference) as never,
        );
        const write = writeStepOf(record)!;
        expect(record.status).toBe("failed");
        expect(write.error).toBe(
          `Workflow step "write-documentation" could not read the planned page ${PAGE_PATH} to check its source citations (EACCES). Make the workspace readable to DocsFab, then start a new run.`,
        );
        expect(write.failure).toEqual({
          class: "infrastructure",
          layer: "workflow",
          code: SOURCE_CITATION_PAGE_UNREADABLE_CODE,
        });
        expect(DEFAULT_NEXT_ACTIONS[SOURCE_CITATION_PAGE_UNREADABLE_CODE]).toContain(
          "check the permissions of the planned page",
        );
      } finally {
        await chmod(join(workspace, PAGE_PATH), 0o644);
      }
    },
    testTimeoutMs(90_000),
  );
});
