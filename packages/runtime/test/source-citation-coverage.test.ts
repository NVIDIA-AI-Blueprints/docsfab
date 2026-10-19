// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The required-source write gate on update.
 *
 * Everything here drives the shipped `update-documentation` manifest through
 * the real `WorkflowRunner` with a real source-evidence service. Only the model
 * turn and the repository evidence collector are substituted, at their
 * documented seams. Expectations come from the shipped artefacts: the plan
 * digest from `documentationPlanBindingDigest`, the sealed source digest from
 * the binding the producer minted, and the refusal strings are the exact
 * operator-visible text, remediation included.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { LocalRepositorySecurityScanner } from "../src/security/repository-scanner.js";
import { CatalogSkillCrateResolver } from "../src/skills/catalog-crate-resolver.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  documentationPlanBindingDigest,
  documentationPlanBindingV2Digest,
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
  type SourceReadBudgetBasisV1,
  projectSourceRequestContext,
  recordExternalInputAccess,
  registerFakeExternalInput,
} from "../src/inputs/index.js";
import { CLI_SOURCE_READ_SKILLS } from "../src/cli/run/source-acquisition.js";
import { textSourceExtractorAdapter } from "../src/inputs/adapters/structured.js";
import { DEFAULT_NEXT_ACTIONS } from "../src/operator/error-envelope.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { readyContextPreflight } from "./helpers.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { hostReadSources } from "./support/source-acquisition-cli.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const HTML_FIXTURE = new URL("./fixtures/source-evidence/html/release-notes.html", import.meta.url);

/**
 * Every identifier differs from every other one in this file and from the
 * other citation suites, so no citation passes on an id collision.
 */
const RUN_ID = "update-citation-run-7741";
const OBSERVATION_ID = "obs-update-release-notes";
const INPUT_ID = "input-update-release-notes";
const FIXTURE_REVISION = "c".repeat(40);
const FIXTURE_SOURCE_PATH = "/fixtures/polish-citation-coverage";
const CONTENT_DIGEST = createHash("sha256").update("content-798d").digest("hex");
const PRODUCER_SCOPE = createHash("sha256").update("scope-798d").digest("hex");
const PRODUCER_SCOPES = [{ producerId: "workspace-tracked-files", scopeSha256: PRODUCER_SCOPE }];
const WORKSPACE_IDENTITY = createHash("sha256").update("ws-798d").digest("hex");
const PAGE_PATH = "docs/guide.md";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const temporaryDirectories = temporaryRoots();

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

function updatePlanBinding() {
  const mode = "update" as const;
  const pages = [{ path: PAGE_PATH, disposition: mode }];
  const sourceBindings = [{ pagePath: PAGE_PATH, sources: [PAGE_PATH] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

/** The exact request object the runner receives; the binding commits to it. */
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

/**
 * A model that discovers its own identifiers: it is handed no observation,
 * representation, or span id, calls the reader's own inventory, and passes
 * back what the host disclosed. `readOnSkills` decides which steps read,
 * which is the variable under test.
 */
class CitingUpdateHarness implements AgentHarness {
  public readonly sawReaderOn: string[] = [];
  public readonly readSteps: string[] = [];
  /** The prompt each write step's model received, by step id. */
  public readonly writePrompts = new Map<string, string>();
  public writerCalls = 0;

  public constructor(
    private readonly readOnSkills: readonly string[],
    private readonly plannerOutcome: "succeeded" | "needs-input" = "succeeded",
  ) {}

  public async inspectSkill(input: HarnessStepInput) {
    return new CatalogSkillCrateResolver(skillCrateDirectory).resolveSkill(input);
  }

  public async runStep(input: HarnessStepInput) {
    const skill = await this.inspectSkill(input);
    if (input.sourceReader) this.sawReaderOn.push(input.step.skill);
    if (input.sourceReader && this.readOnSkills.includes(input.step.skill)) {
      const inventory = input.sourceReader.listSources();
      expect(inventory.length).toBeGreaterThan(0);
      const span = inventory[0]!;
      input.sourceReader.read({
        observationId: span.observationId,
        representationId: span.representationId,
        spanIds: [span.spanId],
      });
      this.readSteps.push(input.step.id);
    }
    const verification = await verificationFixture(input);
    if (input.step.mode === "write") {
      this.writerCalls += 1;
      this.writePrompts.set(input.step.id, input.step.prompt);
      const target = join(input.repositoryPath, PAGE_PATH);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "# Guide\n\nThe fixture guide records the bound release note.\n");
    }
    if (input.step.id === "plan-documentation" && this.plannerOutcome === "needs-input") {
      return {
        summary: "The admitted source binding no longer covers the requested pages.",
        outcome: "needs-input" as const,
        model: { provider: "fixture", model: "deterministic" },
        skill,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15,
          turns: 1,
        },
      };
    }
    return {
      summary: `Fixture completed ${input.step.skill} against the bound release note.`,
      ...verification,
      ...(input.step.id === "plan-documentation" ? { planBinding: updatePlanBinding() } : {}),
      model: { provider: "fixture", model: "deterministic" },
      skill,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
        turns: 1,
      },
      tools: {
        totalCalls: 1,
        failedCalls: 0,
        byTool: [
          {
            name: input.step.mode === "write" ? "edit" : "read",
            calls: 1,
            failures: 0,
          },
        ],
      },
    };
  }
}

/** The real producer chain: extraction, observation, binding, host service. */
async function buildUpdateSourceEvidence(
  workspacePath: string,
  options: {
    sourceReadSkills?: readonly string[];
    perStepBudgetBytes?: number;
    /** A plain-text source in place of the HTML fixture. */
    text?: { readonly body: string; readonly repositoryPath: string };
    readBudgetBasis?: SourceReadBudgetBasisV1;
  } = {},
) {
  const repository = {
    identitySha256: createHash("sha256").update(FIXTURE_SOURCE_PATH).digest("hex"),
    revision: FIXTURE_REVISION,
  };
  const policy = createSourceStepPolicy({
    sourceReadSkills: options.sourceReadSkills ?? CLI_SOURCE_READ_SKILLS,
    ...(options.perStepBudgetBytes === undefined
      ? {}
      : { perStepBudgetBytes: options.perStepBudgetBytes }),
  });
  const requestSha256 = projectSourceRequestContext(
    updateRunRequest(workspacePath) as unknown as Record<string, unknown>,
    { runId: RUN_ID, workspaceIdentitySha256: WORKSPACE_IDENTITY, repository },
  );
  const bytes = options.text
    ? new TextEncoder().encode(options.text.body)
    : new Uint8Array(await readFile(HTML_FIXTURE));
  const mediaType = options.text ? "text/plain" : "text/html";
  const repositoryPath = options.text?.repositoryPath ?? "docs/release-notes.html";
  const { representation, derivative } = await extractSourceRepresentation({
    adapter: options.text ? textSourceExtractorAdapter : htmlSourceExtractorAdapter,
    bytes,
    mediaType,
  });
  const observation = createSourceObservation({
    observationId: OBSERVATION_ID,
    originIdSha256: sha("origin-798d"),
    inputId: INPUT_ID,
    registrationSha256: sha("registration-798d"),
    runIdSha256: sha(RUN_ID),
    repository,
    requestSha256,
    producerId: "workspace-tracked-files",
    producerVersion: "1",
    producerScopeSha256: PRODUCER_SCOPE,
    acquisitionReceiptSha256: sha("receipt-798d"),
    observedAt: "2026-09-16T09:00:00.000Z",
    original: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType,
      locatorSha256: sha(repositoryPath),
      version: { kind: "repository-revision", revision: FIXTURE_REVISION },
      repositoryPath,
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
      {
        observationId: OBSERVATION_ID,
        observationSha256: observation.observationSha256,
      },
    ],
    requiredObservationIds: [OBSERVATION_ID],
  });
  const capture = openExternalInputAccessCapture({
    runIdSha256: sha(RUN_ID),
    repository,
  });
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
      now: () => new Date("2026-09-16T09:05:00.000Z"),
    }),
  );
  return {
    binding,
    observation,
    representation,
    policy,
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
      ...(options.readBudgetBasis ? { readBudgetBasis: options.readBudgetBasis } : {}),
    },
  };
}

async function fixtureWorkspace(): Promise<string> {
  const workspace = await temporaryDirectories.create("docsfab-798d-update-");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, PAGE_PATH), "# Guide\n\nThe fixture guide is stale.\n");
  await writeFile(join(workspace, "README.md"), "fixture repository\n");
  return workspace;
}

function sourceObserverFixture() {
  return {
    ...sourceObligationObserverFixture,
    captureOriginalSourceAuthority: (
      input: Parameters<typeof sourceObligationObserverFixture.captureOriginalSourceAuthority>[0],
    ) =>
      sourceObligationObserverFixture.captureOriginalSourceAuthority({
        ...input,
        authorizedPaths: [PAGE_PATH],
      }),
  };
}

function updateRunner(
  harness: AgentHarness,
  store: RunStore,
  sourceEvidence?: Awaited<ReturnType<typeof buildUpdateSourceEvidence>>["runnerBinding"],
) {
  return new WorkflowRunner({
    ...scriptedEditorialProtocol(harness),
    hostOperations: {
      runStep: async () => ({ summary: "Fixture native checks passed" }),
    },
    store,
    repositoryScanner: new LocalRepositorySecurityScanner(),
    contextPreflight: readyContextPreflight,
    workflowSearch: new LocalWorkflowSearchCoordinator(),
    sourceObligationObserver: sourceObserverFixture(),
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    repositoryEvidence: {
      capture: async (context: { persistPatch?: boolean }) => ({
        files: [{ path: PAGE_PATH, status: "modified" as const }],
        ...(context.persistPatch
          ? {
              patch: {
                sha256: "e".repeat(64),
                byteLength: 128,
                lineCount: 6,
                artifactPath: "/tmp/docsfab-798d-fixture.patch",
                format: "git-diff" as const,
              },
            }
          : {}),
      }),
    },
    ...(sourceEvidence ? { sourceEvidence } : {}),
    id: () => RUN_ID,
    now: () => new Date("2026-09-16T09:00:00.000Z"),
  } as ConstructorParameters<typeof WorkflowRunner>[0]);
}

/** Bytes a whole read of the fixture's one representation charges. */
function wholeReadBytes(evidence: Awaited<ReturnType<typeof buildUpdateSourceEvidence>>): number {
  return evidence.representation.spans.reduce(
    (total, span) => total + span.endByte - span.startByte,
    0,
  );
}

describe("required-source write gate on update-documentation (#798, #1808)", () => {
  it("reads a required source no earlier step read into the update write step, whole", async () => {
    const workspace = await fixtureWorkspace();
    const evidence = await buildUpdateSourceEvidence(workspace);
    const harness = new CitingUpdateHarness([]);
    const store = new MemoryStore();

    const record = await updateRunner(harness, store, evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    // The reader really was offered to the earlier steps and really was not used.
    expect(harness.sawReaderOn).toContain("plan-documentation");
    expect(harness.sawReaderOn).toContain("verify-technical-accuracy");
    expect(harness.readSteps).toEqual([]);
    const write = record.steps.find((step) => step.mode === "write")!;
    expect(write.error).toBeUndefined();
    expect(write.status).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
    // The write step's model received every span of the source, with its id.
    const prompt = harness.writePrompts.get("write-documentation");
    const [source, ...others] = hostReadSources("write-documentation", prompt ?? "");
    expect(others).toEqual([]);
    expect(source).toMatchObject({
      observationId: OBSERVATION_ID,
      representationId: evidence.representation.representationId,
      repositoryPath: "docs/release-notes.html",
    });
    expect(source!.spans.map((span) => span.spanId)).toEqual(
      evidence.representation.spans.map((span) => span.spanId),
    );
    expect(source!.spans.map((span) => span.text).join("\n")).toContain(
      "The runtime reads a tracked source only through a host-issued reader.",
    );
    expect(prompt).toContain(
      `so the host read each one whole for this step, using ${wholeReadBytes(evidence)} of its ${evidence.policy.perStepBudgetBytes} source-read bytes.`,
    );
    expect(await readFile(join(workspace, PAGE_PATH), "utf8")).toContain("bound release note");
  }, 60_000);

  it("reads only the spans the planner left unread into the update write step", async () => {
    // The planner read one span. That is part of the source, not all of it
    // (#1809), so the write step reads the rest rather than nothing.
    const workspace = await fixtureWorkspace();
    const evidence = await buildUpdateSourceEvidence(workspace);
    const harness = new CitingUpdateHarness(["plan-documentation"]);
    const store = new MemoryStore();

    const record = await updateRunner(harness, store, evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    expect(harness.readSteps).toEqual(["plan-documentation"]);
    expect(record.steps.find((step) => step.mode === "write")?.error).toBeUndefined();
    expect(record.steps.find((step) => step.mode === "write")?.status).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
    const prompt = harness.writePrompts.get("write-documentation") ?? "";
    const [source, ...others] = hostReadSources("write-documentation", prompt);
    expect(others).toEqual([]);
    const spans = evidence.representation.spans;
    expect(source!.spans.map((span) => span.spanId)).toEqual(
      spans.slice(1).map((span) => span.spanId),
    );
    // The line says how much of the source the run has now read: all of it.
    const line = JSON.parse(
      prompt
        .split("\n")
        .find((entry) => entry.startsWith('{"kind":"docsfab-source-required-read"'))!,
    ) as { readBytes: number; totalBytes: number };
    expect(line).toMatchObject({
      readBytes: wholeReadBytes(evidence),
      totalBytes: wholeReadBytes(evidence),
    });
    expect(prompt).toContain(
      "No earlier step read all of these required sources with docsfab_read_source, so the host read the spans of each that no step had read,",
    );
    expect(prompt).not.toContain("did not fit this step's budget");
    expect(
      (record.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual([]);
    expect(await readFile(join(workspace, PAGE_PATH), "utf8")).toContain("bound release note");
  }, 60_000);

  it("reads an unread source that needs exactly the step's read budget", async () => {
    const workspace = await fixtureWorkspace();
    const sized = await buildUpdateSourceEvidence(workspace);
    const evidence = await buildUpdateSourceEvidence(workspace, {
      perStepBudgetBytes: wholeReadBytes(sized),
    });
    const harness = new CitingUpdateHarness([]);

    const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    expect(record.steps.find((step) => step.mode === "write")?.status).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
    expect(
      hostReadSources("write-documentation", harness.writePrompts.get("write-documentation") ?? ""),
    ).toHaveLength(1);
    // Read whole: the section is the one a whole read always had, and the run
    // records no partial read.
    expect(harness.writePrompts.get("write-documentation")).toContain(
      `so the host read each one whole for this step, using ${wholeReadBytes(evidence)} of its ${wholeReadBytes(evidence)} source-read bytes.`,
    );
    expect(
      (record.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual([]);
  }, 60_000);

  it("reads a window one byte over the step's read budget and records the source as partially read", async () => {
    const workspace = await fixtureWorkspace();
    const sized = await buildUpdateSourceEvidence(workspace);
    const needed = wholeReadBytes(sized);
    const evidence = await buildUpdateSourceEvidence(workspace, {
      perStepBudgetBytes: needed - 1,
    });
    const harness = new CitingUpdateHarness([]);
    const store = new MemoryStore();

    const record = await updateRunner(harness, store, evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    // The source is reachable: the write step reads every span but the last,
    // and writes, instead of stopping.
    const write = record.steps.find((step) => step.mode === "write")!;
    expect(write.error).toBeUndefined();
    expect(write.status).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
    const spans = evidence.representation.spans;
    const last = spans.at(-1)!;
    const readBytes = needed - (last.endByte - last.startByte);
    const prompt = harness.writePrompts.get("write-documentation") ?? "";
    expect(
      hostReadSources("write-documentation", prompt)[0]!.spans.map((span) => span.spanId),
    ).toEqual(spans.slice(0, -1).map((span) => span.spanId));
    expect(prompt).toContain(
      "The rest of docs/release-notes.html did not fit this step's budget and was not read.",
    );
    // The run record, and through it the LIMITATIONS footer, names the source,
    // the bytes read out of its total, the limit, and the remediation.
    const partial = [
      `source-read-partial: docs/release-notes.html was read ${readBytes} of ${needed} bytes when step write-documentation started writing; the rest of it was not read.`,
      `source-read-partial: step write-documentation could not read every required source whole. sources-read-response-ceiling-bytes-bound: ${needed} exceeds sources.readResponseCeilingBytes = ${needed - 1} bytes. Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least the bytes named, up to 67108864, so one step can read every required source whole, or bind fewer or smaller sources, then start a new run. Follow the named remediation.`,
    ];
    expect(
      (record.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual(partial);
    expect(store.records.at(-1)?.evidenceWarnings).toEqual(expect.arrayContaining(partial));
  }, 60_000);

  it("stops the update write step with a coded refusal when not one span fits its read budget", async () => {
    const workspace = await fixtureWorkspace();
    const sized = await buildUpdateSourceEvidence(workspace);
    const needed = wholeReadBytes(sized);
    const first = sized.representation.spans[0]!;
    const budget = first.endByte - first.startByte - 1;
    const evidence = await buildUpdateSourceEvidence(workspace, { perStepBudgetBytes: budget });
    const harness = new CitingUpdateHarness([]);

    const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    expect(record.status).toBe("failed");
    expect(harness.writerCalls).toBe(0);
    const write = record.steps.find((step) => step.mode === "write")!;
    expect(write.status).toBe("failed");
    // No attempt: the stop comes before the model is asked to write.
    expect(write.inference).toBeUndefined();
    expect(write.failure).toEqual({
      class: "bound",
      layer: "workflow",
      code: "required-source-unread",
    });
    // The exact operator-visible stop: condition, the source, the bytes, the
    // budget, and the remediation. Not a substring.
    expect(write.error).toBe(
      'Workflow step "write-documentation" cannot write while required source evidence is missing ' +
        `(${OBSERVATION_ID}:unread). ` +
        `No earlier step read docs/release-notes.html (${needed} bytes) with docsfab_read_source, ` +
        `and not one span of it fits in what is left of the step's source-read budget of ${budget} bytes (sources.readResponseCeilingBytes); reading what is left of every required source needs ${needed} bytes. ` +
        `Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least ${needed}, or bind fewer or smaller sources, such as fewer --source files or a narrower merge-request date range, then start a new run.`,
    );
    const next = buildRunHumanNextCommand({ record });
    expect(next).toEqual({
      command: `docsfab runs show ${RUN_ID}`,
      reason: DEFAULT_NEXT_ACTIONS["required-source-unread"],
    });
    expect(next?.command).not.toContain("doctor");
  }, 60_000);

  it("withholds a span holding a configured credential from the update write step and reports the bytes", async () => {
    const workspace = await fixtureWorkspace();
    // One of DocsFab's own configured credentials: only that is withheld; a
    // credential shape alone is read (#1807).
    const credential = configureCredential(plantedCredentialValue(80, 32));
    const lines = Array.from({ length: 12 }, (_, index) =>
      index === 6
        ? `Store the service key as ${credential} in the vault.`
        : `Guide line ${index} keeps the bound release note.`,
    );
    const evidence = await buildUpdateSourceEvidence(workspace, {
      text: { body: `${lines.join("\n")}\n`, repositoryPath: "docs/keys.txt" },
    });
    const harness = new CitingUpdateHarness([]);
    const store = new MemoryStore();

    const record = await updateRunner(harness, store, evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    const write = record.steps.find((step) => step.mode === "write")!;
    expect(write.error).toBeUndefined();
    expect(write.status).toBe("succeeded");
    const spans = evidence.representation.spans;
    const flagged = spans[6]!;
    const flaggedBytes = flagged.endByte - flagged.startByte;
    const total = wholeReadBytes(evidence);
    const prompt = harness.writePrompts.get("write-documentation") ?? "";
    // Every span but the withheld one reached the writer; the banner did not.
    expect(
      hostReadSources("write-documentation", prompt)[0]!.spans.map((span) => span.spanId),
    ).toEqual(spans.filter((span) => span !== flagged).map((span) => span.spanId));
    expect(prompt).not.toContain(credential);
    expect(prompt).toContain(
      "Spans of docs/keys.txt hold one of DocsFab's own configured credentials, so the host withheld them and they were not read.",
    );
    // Partial, with the withheld bytes, and no budget line: the budget held.
    expect(
      (record.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual([
      `source-read-partial: docs/keys.txt was read ${total - flaggedBytes} of ${total} bytes when step write-documentation started writing; the rest of it was not read, including ${flaggedBytes} bytes the credential screen withheld.`,
    ]);
  }, 60_000);

  it("reads a span with only a credential shape on the update write step like any other (#1807)", async () => {
    const workspace = await fixtureWorkspace();
    const marker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const lines = Array.from({ length: 12 }, (_, index) =>
      index === 6
        ? `Store the service key as ${marker} in the vault.`
        : `Guide line ${index} keeps the bound release note.`,
    );
    const evidence = await buildUpdateSourceEvidence(workspace, {
      text: { body: `${lines.join("\n")}\n`, repositoryPath: "docs/keys.txt" },
    });
    const harness = new CitingUpdateHarness([]);

    const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    expect(record.steps.find((step) => step.mode === "write")?.status).toBe("succeeded");
    const prompt = harness.writePrompts.get("write-documentation") ?? "";
    expect(
      hostReadSources("write-documentation", prompt)[0]!.spans.map((span) => span.spanId),
    ).toEqual(evidence.representation.spans.map((span) => span.spanId));
    expect(prompt).toContain(marker);
    expect(prompt).not.toContain("so the host withheld them");
    expect(
      (record.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual([]);
  }, 60_000);

  it("names the input-window share when it set the budget the read hit", async () => {
    const workspace = await fixtureWorkspace();
    const sized = await buildUpdateSourceEvidence(workspace);
    const needed = wholeReadBytes(sized);
    const basis = { kind: "input-window-share", share: 0.1, inputWindowTokens: 61_440 } as const;
    const evidence = await buildUpdateSourceEvidence(workspace, {
      perStepBudgetBytes: needed - 1,
      readBudgetBasis: basis,
    });
    const harness = new CitingUpdateHarness([]);

    const record = await updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
      updateRunRequest(workspace, evidence.reference) as never,
    );

    expect(record.steps.find((step) => step.mode === "write")?.status).toBe("succeeded");
    expect(
      (record.evidenceWarnings ?? [])
        .filter((entry) => entry.startsWith("source-read-partial:"))
        .at(-1),
    ).toBe(
      "source-read-partial: step write-documentation could not read every required source whole. " +
        `sources-read-input-window-share-bound: ${needed} exceeds the step's source-read budget of ${needed - 1} bytes, sources.readInputWindowShare = 0.1 of the model's 61440-token input window. ` +
        "Raise DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE, up to 1, so source reads may fill more of the model's input window, run with a model whose input window is larger, or bind fewer or smaller sources, then start a new run. Follow the named remediation.",
    );

    // The stop names the share too when not one span fits.
    const first = sized.representation.spans[0]!;
    const starved = await buildUpdateSourceEvidence(workspace, {
      perStepBudgetBytes: first.endByte - first.startByte - 1,
      readBudgetBasis: basis,
    });
    const stopped = await updateRunner(
      new CitingUpdateHarness([]),
      new MemoryStore(),
      starved.runnerBinding,
    ).run(updateRunRequest(workspace, starved.reference) as never);
    const stop = stopped.steps.find((step) => step.mode === "write")!;
    expect(stop.failure).toEqual({
      class: "bound",
      layer: "workflow",
      code: "required-source-unread",
    });
    expect(stop.error).toContain(
      `(sources.readInputWindowShare = 0.1 of the model's 61440-token input window); reading what is left of every required source needs ${needed} bytes. Raise DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE so source reads may fill more of the model's input window, run with a model whose input window is larger,`,
    );
  }, 90_000);

  it("fails preflight when a locked skill lost its source-read grant", async () => {
    const workspace = await fixtureWorkspace();
    // The installed locked skill set does not admit the writer's source read.
    const evidence = await buildUpdateSourceEvidence(workspace, {
      sourceReadSkills: CLI_SOURCE_READ_SKILLS.filter((skill) => skill !== "write-documentation"),
    });
    const harness = new CitingUpdateHarness(["plan-documentation"]);

    await expect(
      updateRunner(harness, new MemoryStore(), evidence.runnerBinding).run(
        updateRunRequest(workspace, evidence.reference) as never,
      ),
    ).rejects.toThrowError(
      'Workflow "update-documentation" cannot run with bound sources because its locked write skills ' +
        "have no source-read grant (write-documentation). " +
        "Reinstall the locked skill set that grants the source reader to those skills, or run without --source.",
    );
    // Preflight, not a late stop: no step saw a reader and nothing wrote.
    expect(harness.sawReaderOn).toEqual([]);
    expect(harness.writerCalls).toBe(0);
  }, 60_000);
});

describe("update plan binding under the admitted source binding (#798)", () => {
  it("seals the update plan binding to the whole admitted source binding and reports drift as needs-input", async () => {
    const workspace = await fixtureWorkspace();
    const evidence = await buildUpdateSourceEvidence(workspace);
    const store = new MemoryStore();

    const record = await updateRunner(
      new CitingUpdateHarness(["plan-documentation"]),
      store,
      evidence.runnerBinding,
    ).run(updateRunRequest(workspace, evidence.reference) as never);

    const planStep = record.steps.find((step) => step.skill === "plan-documentation")!;
    const sealed = planStep.planBinding as {
      schemaVersion: number;
      sourceBindingSha256: string;
      digest: string;
      mode: string;
      pages: readonly { path: string; disposition: string }[];
      sourceBindings: readonly {
        pagePath: string;
        sources: readonly string[];
      }[];
    };
    expect(sealed.schemaVersion).toBe(2);
    // The whole admitted binding digest, not a prefix of it.
    expect(sealed.sourceBindingSha256).toBe(evidence.binding.bindingSha256);
    expect(sealed.digest).toBe(
      documentationPlanBindingV2Digest({
        mode: sealed.mode as "update",
        pages: sealed.pages as never,
        sourceBindings: sealed.sourceBindings as never,
        sourceBindingSha256: evidence.binding.bindingSha256,
      }),
    );
    // A V2 seal is not a renamed V1 seal: the same pages under V1 digest differently.
    expect(sealed.digest).not.toBe(updatePlanBinding().digest);

    // Drift half: the planner reporting that the admitted binding no longer
    // covers the request stops the run at needs-input, before any write.
    const driftWorkspace = await fixtureWorkspace();
    const driftEvidence = await buildUpdateSourceEvidence(driftWorkspace);
    const driftHarness = new CitingUpdateHarness(["plan-documentation"], "needs-input");
    const driftRecord = await updateRunner(
      driftHarness,
      new MemoryStore(),
      driftEvidence.runnerBinding,
    ).run(updateRunRequest(driftWorkspace, driftEvidence.reference) as never);

    // The bounded needs-input continuation: the planner reports the drift, the
    // write step is not reached, and nothing after it runs.
    expect(driftRecord.steps.find((step) => step.id === "plan-documentation")?.status).toBe(
      "needs-input",
    );
    expect(
      driftRecord.steps.filter((step) => step.status === "pending").map((step) => step.id),
    ).toContain("write-documentation");
    expect(driftRecord.status).not.toBe("succeeded");
    expect(driftHarness.writerCalls).toBe(0);
  }, 90_000);

  it("keeps a no-source update run's plan binding at V1 byte for byte", async () => {
    const workspace = await fixtureWorkspace();
    const store = new MemoryStore();
    const harness = new CitingUpdateHarness([]);

    const record = await updateRunner(harness, store).run(updateRunRequest(workspace) as never);

    expect(harness.sawReaderOn).toEqual([]);
    const planStep = record.steps.find((step) => step.skill === "plan-documentation")!;
    // Byte for byte against the shipped V1 constructor, not a hand-written shape.
    expect(planStep.planBinding).toEqual(updatePlanBinding());
    expect(record.steps.find((step) => step.mode === "write")?.status).toBe("succeeded");
    expect(harness.writerCalls).toBe(1);
  }, 60_000);
});
