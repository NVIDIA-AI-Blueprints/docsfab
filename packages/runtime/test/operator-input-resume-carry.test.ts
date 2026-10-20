// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab do --continue` carries the original run's comparison request and
 * explicit reader nominations, so a resumed update never stops on a
 * `comparison` slot that `do` cannot fill.
 *
 * Original stops come from the shipped writer: `docsfab run
 * update-documentation` arguments through the real runner with a fake
 * editorial harness. Continuations go through `handleDoCommand`. Hand-built
 * records appear only where the writer cannot produce the case: a record from
 * before the field, a malformed value, a duplicate nomination, the bound, and
 * repository-path canonicalization.
 */
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { handleDoCommand, type DoRunArguments } from "../src/cli/commands/do.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { limit, OperationalLimitError } from "../src/config/limits.js";
import {
  observeReaderTaskContextAdmissionV1,
  READER_SOURCE_NOMINATIONS_LIMIT,
} from "../src/execution/reader-task-admission.js";
import { createReaderTaskContextSupplier } from "../src/execution/task-context.js";
import {
  editorialInputAskSlots,
  listOpenEditorialRuns,
  OperatorInputFillError,
} from "../src/inputs/operator-input-fill.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import type { RunRecord } from "../src/records/contracts.js";
import { retainedReaderEvidenceRequest } from "../src/records/reader-evidence-request.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  git,
  observePublicContract,
  orbitOptionChangeRepository,
  orbitReaderContextInput,
  type OrbitOptionChangeFixture,
} from "./helpers/orbit-option-change-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const INSTRUCTION = "Assess whether docs/cli.md needs an update for the changed option source.";
const REPLY = "Admit the product requirements: the public option is --new.";
const REVISION = "b".repeat(40);
const CARRY_PREFIX = "docsfab-continue-carry";
const HAND_PREFIX = "docsfab-continue-hand-";

const temporaryDirectories: string[] = [];
const roots = temporaryRoots();
let tmpdirBefore: string[] = [];

async function ownTemporaryEntries(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith(CARRY_PREFIX) || name.startsWith(HAND_PREFIX))
    .sort();
}

beforeAll(async () => {
  tmpdirBefore = await ownTemporaryEntries();
});

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await roots.cleanup();
  // Every fixture directory this file created is gone; the shared host keeps no residue.
  expect(await ownTemporaryEntries()).toEqual(tmpdirBefore);
});

interface CarryFixture extends OrbitOptionChangeFixture {
  /** The canonical repository path the runner records as `repository.sourcePath`. */
  readonly canonicalRepository: string;
  readonly harness: EditorialProtocolHarness;
  readonly captured: DoRunArguments[];
  readonly runWorkflow: (request: DoRunArguments) => Promise<RunRecord | undefined>;
}

async function carryFixture(name: string): Promise<CarryFixture> {
  const fixture = await orbitOptionChangeRepository(
    `${CARRY_PREFIX}-${name}`,
    temporaryDirectories,
  );
  const canonicalRepository = await realpath(fixture.repository);
  // The planner also keeps a page the revision does not hold. With no admitted
  // evidence for it, the kept-page no-change basis is unavailable, so
  // an original stop waits on the evidence a continuation supplies.
  const harness = new EditorialProtocolHarness({
    candidate: "no-change",
    impactSource: await observePublicContract(fixture.repository, fixture.head),
    plannerPages: [
      { path: "docs/absent.md", disposition: "retain" },
      { path: "docs/cli.md", disposition: "retain" },
    ],
  });
  const captured: DoRunArguments[] = [];
  return {
    ...fixture,
    canonicalRepository,
    harness,
    captured,
    runWorkflow: async (request) => {
      captured.push(structuredClone(request));
      return executeRunRequest(request, fixture.config, { silent: true, harness });
    },
  };
}

/** The original `docsfab run update-documentation` stop, through the shipped writer. */
async function originalStop(
  fixture: CarryFixture,
  extra: readonly string[],
  instruction = INSTRUCTION,
): Promise<RunRecord> {
  const request = parseRunArguments([
    "update-documentation",
    "--repo",
    fixture.canonicalRepository,
    "--instruction",
    instruction,
    "--patch-only",
    ...extra,
  ]);
  const record = await executeRunRequest(request, fixture.config, {
    silent: true,
    harness: fixture.harness,
  });
  if (!record) throw new Error("the original run saved no record");
  return record;
}

async function savedRecord(
  stateDirectory: string,
  runId: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(stateDirectory, `${runId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function slotIds(record: unknown): string[] {
  return editorialInputAskSlots(record).map((slot) => slot.inputId);
}

async function continueRun(
  fixture: CarryFixture,
  runId: string,
  fill: { readonly attach?: string; readonly reply?: string },
  extra: readonly string[] = [],
): Promise<void> {
  await handleDoCommand(
    [
      ...(fill.reply ? [fill.reply] : []),
      "--repo",
      fixture.canonicalRepository,
      "--continue",
      runId,
      ...(fill.attach ? ["--attach", fill.attach] : []),
      "--patch-only",
      "--quiet",
      ...extra,
    ],
    { stateDirectory: fixture.config.stateDirectory, runWorkflow: fixture.runWorkflow },
  );
}

async function supersessionMarkers(stateDirectory: string): Promise<string[]> {
  try {
    return await readdir(join(stateDirectory, "input-ask-supersession"));
  } catch {
    return [];
  }
}

async function rejection(promise: Promise<unknown>): Promise<OperatorInputFillError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OperatorInputFillError);
  return error as OperatorInputFillError;
}

const WORKSPACE_ARGUMENTS = [
  "--comparison-workspace",
  "--reader-source",
  "changed-source=src/orbit.ts",
  "--reader-source",
  "current-documentation=docs/cli.md",
] as const;

const WORKSPACE_UNION = [
  { role: "changed-source", path: "src/orbit.ts" },
  { role: "current-documentation", path: "docs/cli.md" },
  { role: "public-contract", path: "src/orbit.ts" },
];

const CHAIN_ARGUMENTS = [
  "--comparison-workspace",
  "--reader-source",
  "current-documentation=docs/cli.md",
] as const;

const CHAIN_UNION = [
  { role: "current-documentation", path: "docs/cli.md" },
  { role: "public-contract", path: "src/orbit.ts" },
];

/**
 * An instruction that names the page, so the page is admitted as current
 * documentation without any operator nomination.
 */
const NAMED_PAGE_INSTRUCTION = "Update docs/cli.md only if the changed option source requires it.";

describe("do --continue carries the original comparison and nominations", () => {
  it("continues a workspace-comparison stop without asking for a comparison", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await carryFixture("workspace");
    const original = await originalStop(fixture, WORKSPACE_ARGUMENTS);
    expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
    expect(slotIds(original)).toContain("public-contract");
    expect(slotIds(original)).not.toContain("comparison");
    const originalSaved = await savedRecord(fixture.config.stateDirectory, original.id);
    expect(JSON.stringify(originalSaved.readerEvidenceRequest)).toBe(
      JSON.stringify({
        comparisonRequest: { kind: "workspace" },
        readerSources: [
          { role: "changed-source", path: "src/orbit.ts" },
          { role: "current-documentation", path: "docs/cli.md" },
        ],
      }),
    );

    await continueRun(fixture, original.id, { attach: "src/orbit.ts" });

    expect(fixture.captured).toHaveLength(1);
    const continued = fixture.captured[0]!;
    const continuedRecord = await savedRecord(fixture.config.stateDirectory, continued.runId!);
    // The comparison was admitted, and with the attached public contract every
    // evidence role it needs is too, so the continuation completes the
    // read-only assessment instead of asking for anything.
    expect(slotIds(continuedRecord)).not.toContain("comparison");
    expect(slotIds(continuedRecord)).toEqual([]);
    expect(continuedRecord.status, JSON.stringify(continuedRecord.error)).toBe("succeeded");
    expect(continued.comparisonRequest).toEqual({ kind: "workspace" });
    expect(continued.readerSources).toEqual(WORKSPACE_UNION);
    // The continuation's own record keeps the union, so a later continue carries it too.
    expect(JSON.stringify(continuedRecord.readerEvidenceRequest)).toBe(
      JSON.stringify({ comparisonRequest: { kind: "workspace" }, readerSources: WORKSPACE_UNION }),
    );
  });

  it("continues a base-head stop at its head revision after HEAD moved", {
    timeout: testTimeoutMs(40_000),
  }, async () => {
    const fixture = await carryFixture("base-head");
    const original = await originalStop(fixture, [
      "--revision",
      fixture.head,
      "--comparison-base",
      fixture.base,
      "--reader-source",
      "current-documentation=docs/cli.md",
    ]);
    expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
    expect(slotIds(original)).toContain("public-contract");
    expect(slotIds(original)).not.toContain("comparison");
    await writeFile(join(fixture.repository, "README.md"), "# Orbit\n");
    await git(fixture.repository, "add", "--all");
    await git(
      fixture.repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "after head",
    );
    const moved = await git(fixture.repository, "rev-parse", "HEAD");
    expect(moved).not.toBe(fixture.head);

    // A named revision other than the comparison head refuses before any claim.
    const refusal = await rejection(
      continueRun(fixture, original.id, { attach: "src/orbit.ts" }, ["--revision", moved]),
    );
    expect(refusal.code).toBe("continue-revision-mismatch");
    expect(refusal.message).toContain(fixture.head);
    expect(refusal.message).toContain(moved);
    expect(fixture.captured).toEqual([]);
    expect(await supersessionMarkers(fixture.config.stateDirectory)).toEqual([]);

    await continueRun(fixture, original.id, { attach: "src/orbit.ts" });

    expect(fixture.captured).toHaveLength(1);
    const continued = fixture.captured[0]!;
    expect(continued.revision).toBe(fixture.head);
    expect(continued.comparisonRequest).toEqual({
      kind: "base-head",
      baseRevision: fixture.base,
      headRevision: fixture.head,
    });
    const continuedRecord = await savedRecord(fixture.config.stateDirectory, continued.runId!);
    expect(continuedRecord.repository).toMatchObject({ revision: fixture.head });
    // Every evidence role the commit comparison needs is admitted now, so the
    // continuation completes the read-only assessment.
    expect(continuedRecord.status, JSON.stringify(continuedRecord.error)).toBe("succeeded");
    expect(slotIds(continuedRecord)).not.toContain("comparison");
    expect(slotIds(continuedRecord)).toEqual([]);
  });

  it("still carries the comparison and nominations on a second continuation", {
    timeout: testTimeoutMs(40_000),
  }, async () => {
    const fixture = await carryFixture("chain");
    // No changed source is nominated, so after the first fill the evidence is
    // still incomplete and the first continuation stops again.
    const original = await originalStop(fixture, CHAIN_ARGUMENTS);
    await continueRun(fixture, original.id, { attach: "src/orbit.ts" });
    const first = fixture.captured[0]!;
    await continueRun(fixture, first.runId!, { reply: REPLY });

    expect(fixture.captured).toHaveLength(2);
    const second = fixture.captured[1]!;
    expect(second.operatorInputResume?.originalRunId).toBe(first.runId);
    expect(second.comparisonRequest).toEqual({ kind: "workspace" });
    expect(second.readerSources).toEqual(CHAIN_UNION);
    const secondRecord = await savedRecord(fixture.config.stateDirectory, second.runId!);
    expect(slotIds(secondRecord)).not.toContain("comparison");
    expect(JSON.stringify(secondRecord.readerEvidenceRequest)).toBe(
      JSON.stringify({ comparisonRequest: { kind: "workspace" }, readerSources: CHAIN_UNION }),
    );
  });
});

describe("a run without a comparison or nominations is unaffected", () => {
  it("saves no field and continues with the fills alone", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await carryFixture("plain");
    const original = await originalStop(fixture, [], NAMED_PAGE_INSTRUCTION);
    expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
    const originalSaved = await savedRecord(fixture.config.stateDirectory, original.id);
    expect(originalSaved).not.toHaveProperty("readerEvidenceRequest");
    // With no comparison, the stop asks for one. Write is granted, so there is
    // no accepted-knowledge ask for an assessment.
    expect(slotIds(original)).toEqual(["comparison", "public-contract"]);

    await continueRun(fixture, original.id, { attach: "src/orbit.ts" });

    const continued = fixture.captured[0]!;
    expect(continued).not.toHaveProperty("comparisonRequest");
    expect(continued.revision).toBe("HEAD");
    expect(continued.readerSources).toEqual([{ role: "public-contract", path: "src/orbit.ts" }]);
    const continuedRecord = await savedRecord(fixture.config.stateDirectory, continued.runId!);
    expect(continuedRecord.readerEvidenceRequest).toEqual({
      readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
    });
  });

  it("saves no field for an empty nomination list", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await carryFixture("empty");
    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.canonicalRepository,
        revision: "HEAD",
        instruction: INSTRUCTION,
        readerSources: [],
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness: fixture.harness },
    );
    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(await savedRecord(fixture.config.stateDirectory, record!.id)).not.toHaveProperty(
      "readerEvidenceRequest",
    );
  });

  it("never saves a comparison or sources a reader handoff supplied", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await carryFixture("handoff");
    const verifiedPack = await verifyQualityPackContext({
      skillCrateDirectory: fixture.config.skillCrateDirectory,
      qualityDirectory: fixture.config.qualityDirectory,
      qualityPackDirectory: fixture.config.qualityPackDirectory,
    });
    const supplier = await createReaderTaskContextSupplier(verifiedPack);
    const readerContextInput = orbitReaderContextInput();
    const observation = await observeReaderTaskContextAdmissionV1({
      repositoryPath: fixture.repository,
      revision: fixture.head,
      observationMode: "workflow-export",
      readerContextInput,
      comparisonRequest: {
        kind: "base-head",
        baseRevision: fixture.base,
        headRevision: fixture.head,
      },
      sourceHints: [{ role: "public-contract", path: "src/orbit.ts" }],
    });
    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.canonicalRepository,
        revision: fixture.head,
        instruction: INSTRUCTION,
        readerTaskContext: supplier.createHandoff({
          readerContextInput,
          admission: observation.admission,
          inputOrigin: "explicit",
          sourceBinding: observation.sourceBinding,
        }),
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness: fixture.harness },
    );
    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    // The handoff's base-head comparison drove admission, but the operator supplied none.
    expect(await savedRecord(fixture.config.stateDirectory, record!.id)).not.toHaveProperty(
      "readerEvidenceRequest",
    );
  });

  it("continues a record saved before the field exactly as before", async () => {
    const fixture = await handBuiltOpenRun({ runId: "pre-field-001", inputIds: ["prd"] });
    const captured = await captureContinue(fixture, [REPLY, "--continue", fixture.runId]);
    expect(captured).not.toHaveProperty("comparisonRequest");
    expect(captured).not.toHaveProperty("readerSources");
    expect(captured.revision).toBe("HEAD");
    expect(captured.operatorInputResume?.originalRunId).toBe(fixture.runId);
  });
});

describe("a retained request the host cannot carry refuses by name", () => {
  it("refuses a malformed retained value without hiding the run or claiming it", async () => {
    const fixture = await handBuiltOpenRun({
      runId: "malformed-retained-001",
      inputIds: ["prd"],
      readerEvidenceRequest: { comparisonRequest: { kind: "nearest-tag" } },
    });
    const error = await rejection(captureContinue(fixture, [REPLY, "--continue", fixture.runId]));
    expect(error.code).toBe("retained-reader-input-malformed");
    expect(error.message).toContain("docsfab run update-documentation");
    expect((await listOpenEditorialRuns(fixture.stateDirectory)).map((run) => run.runId)).toEqual([
      fixture.runId,
    ]);
    expect(await supersessionMarkers(fixture.stateDirectory)).toEqual([]);
  });

  it("refuses a retained value on a workflow that cannot produce it", async () => {
    const fixture = await handBuiltOpenRun({
      runId: "create-retained-001",
      inputIds: ["prd"],
      workflow: "create-documentation",
      readerEvidenceRequest: retainedReaderEvidenceRequest({
        comparisonRequest: { kind: "workspace" },
      }),
    });
    const error = await rejection(captureContinue(fixture, [REPLY, "--continue", fixture.runId]));
    expect(error.code).toBe("retained-reader-input-malformed");
  });

  it("names a duplicate nomination once, original first", async () => {
    const fixture = await handBuiltOpenRun({
      runId: "duplicate-nomination-001",
      inputIds: ["current-documentation"],
      readerEvidenceRequest: retainedReaderEvidenceRequest({
        readerSources: [
          { role: "public-contract", path: "src/orbit.ts" },
          { role: "current-documentation", path: "docs/cli.md" },
        ],
      }),
      files: { "docs/cli.md": "# Orbit CLI\n" },
    });
    const captured = await captureContinue(fixture, [
      "--continue",
      fixture.runId,
      "--attach",
      "docs/cli.md",
    ]);
    expect(captured.readerSources).toEqual([
      { role: "public-contract", path: "src/orbit.ts" },
      { role: "current-documentation", path: "docs/cli.md" },
    ]);
  });

  it("admits a union at the nomination bound and refuses one past it", async () => {
    const bound = limit(READER_SOURCE_NOMINATIONS_LIMIT).value;
    const retained = (count: number) =>
      retainedReaderEvidenceRequest({
        readerSources: Array.from({ length: count }, (_, index) => ({
          role: "current-documentation" as const,
          path: `docs/page-${String(index)}.md`,
        })),
      });
    const atBound = await handBuiltOpenRun({
      runId: "bound-at-001",
      inputIds: ["public-contract"],
      readerEvidenceRequest: retained(bound - 1),
      files: { "src/orbit.ts": "export const option = '--new';\n" },
    });
    const admitted = await captureContinue(atBound, [
      "--continue",
      atBound.runId,
      "--attach",
      "src/orbit.ts",
    ]);
    expect(admitted.readerSources).toHaveLength(bound);
    expect(admitted.readerSources?.at(-1)).toEqual({
      role: "public-contract",
      path: "src/orbit.ts",
    });

    const overBound = await handBuiltOpenRun({
      runId: "bound-over-001",
      inputIds: ["public-contract"],
      readerEvidenceRequest: retained(bound),
      files: { "src/orbit.ts": "export const option = '--new';\n" },
    });
    const error = await captureContinue(overBound, [
      "--continue",
      overBound.runId,
      "--attach",
      "src/orbit.ts",
    ]).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // The catalog refusal: code, observed union, the bound by name, and its remediation.
    expect(error).toBeInstanceOf(OperationalLimitError);
    const refusal = error as OperationalLimitError;
    expect(refusal.code).toBe("reader-source-nominations-over-bound");
    expect(refusal.limitName).toBe(READER_SOURCE_NOMINATIONS_LIMIT);
    expect(refusal.observed).toBe(bound + 1);
    expect(refusal.configured).toBe(bound);
    expect(refusal.message).toContain("fewer --reader-source options");
    expect(await supersessionMarkers(overBound.stateDirectory)).toEqual([]);
    expect(
      (await listOpenEditorialRuns(overBound.stateDirectory)).map((run) => run.runId),
    ).toContain(overBound.runId);
  });
});

describe("the open run is found through a symbolic link to its repository", () => {
  it("matches the canonical repository and never breaks on a stale run", async () => {
    const root = await roots.create(HAND_PREFIX, { realpath: true });
    const fixture = await handBuiltOpenRun({
      runId: "symlinked-repo-001",
      inputIds: ["prd"],
      root,
    });
    const link = join(root, "repo-link");
    await symlink(fixture.repositoryPath, link, "dir");

    // Implicit continue: the only open run for the linked repository.
    const implicit = await captureContinue(fixture, [REPLY], link);
    expect(implicit.operatorInputResume?.originalRunId).toBe(fixture.runId);

    // A stale run whose repository was removed sits beside the live one.
    const stale = await handBuiltOpenRun({
      runId: "stale-repo-001",
      inputIds: ["prd"],
      root,
      stateDirectory: fixture.stateDirectory,
      repositoryName: "removed-repo",
    });
    await rm(stale.repositoryPath, { recursive: true, force: true });
    const routed = await captureContinue(fixture, [REPLY], link);
    expect(routed.operatorInputResume?.originalRunId).toBe(fixture.runId);
    const explicit = await captureContinue(fixture, [REPLY, "--continue", fixture.runId], link);
    expect(explicit.operatorInputResume?.originalRunId).toBe(fixture.runId);

    // A different repository never matches the run.
    const other = join(root, "other-repo");
    await mkdir(other);
    await expect(
      captureContinue(fixture, [REPLY, "--continue", fixture.runId], other),
    ).rejects.toThrow(`No open editorial needs-input run named ${fixture.runId}`);

    // Debt: a --repo inside the repository does not resolve to its top level yet.
    const subdirectory = join(fixture.repositoryPath, "docs");
    await mkdir(subdirectory);
    await expect(
      captureContinue(fixture, [REPLY, "--continue", fixture.runId], subdirectory),
    ).rejects.toThrow(`No open editorial needs-input run named ${fixture.runId}`);
  });
});

interface HandBuiltRun {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly stateDirectory: string;
}

/** The continued request, captured without running a workflow; the claim is released. */
async function captureContinue(
  fixture: HandBuiltRun,
  args: readonly string[],
  repositoryPath: string = fixture.repositoryPath,
): Promise<DoRunArguments> {
  const captured: DoRunArguments[] = [];
  await handleDoCommand([...args, "--repo", repositoryPath, "--patch-only", "--quiet"], {
    stateDirectory: fixture.stateDirectory,
    currentWorkspaceSnapshotSha256: "c".repeat(64),
    runWorkflow: async (request) => {
      captured.push(structuredClone(request));
      return undefined;
    },
  });
  if (captured.length !== 1) throw new Error("the continuation did not reach the workflow");
  return captured[0]!;
}

/** An open editorial InputAsk stop in the shape the runner saves, built by hand. */
async function handBuiltOpenRun(options: {
  readonly runId: string;
  readonly inputIds: readonly string[];
  readonly workflow?: "create-documentation" | "update-documentation";
  readonly readerEvidenceRequest?: unknown;
  readonly files?: Readonly<Record<string, string>>;
  readonly root?: string;
  readonly stateDirectory?: string;
  readonly repositoryName?: string;
}): Promise<HandBuiltRun> {
  const root = options.root ?? (await roots.create(HAND_PREFIX, { realpath: true }));
  const repositoryPath = join(root, options.repositoryName ?? "repo");
  const stateDirectory = options.stateDirectory ?? join(root, "state");
  await mkdir(repositoryPath, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(join(repositoryPath, path, ".."), { recursive: true });
    await writeFile(join(repositoryPath, path), content, { mode: 0o600 });
  }
  const record: RunRecord = {
    schemaVersion: 2,
    id: options.runId,
    workflow: options.workflow ?? "update-documentation",
    repository: { sourcePath: repositoryPath, requestedRevision: "HEAD", revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: INSTRUCTION,
    ...(options.readerEvidenceRequest !== undefined
      ? { readerEvidenceRequest: options.readerEvidenceRequest as never }
      : {}),
    status: "needs-input",
    createdAt: "2026-10-01T12:00:00.000Z",
    completedAt: "2026-10-01T12:00:01.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        summary: "The planner asked for named InputAsk fills.",
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "plan-documentation");
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "needs-input",
      findings: options.inputIds.map((inputId) => ({
        id: `finding:editorial:${inputId}`,
        kind: "missing-governed-input" as const,
        severity: "warning" as const,
        code: "independent-rejection",
        inputId,
        evidenceIds: [evidence.id],
      })),
      evidence: [evidence],
      limitations: [],
      openDecisions: options.inputIds.map((inputId) => ({
        id: `decision:editorial:${inputId}`,
        kind: "governed-input" as const,
        inputId,
        evidenceIds: [evidence.id],
      })),
      producedArtifacts: [],
    },
    record,
  );
  await writeFile(join(stateDirectory, `${options.runId}.json`), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  return { runId: options.runId, repositoryPath, stateDirectory };
}
