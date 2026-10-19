// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { sourceReadBudgetForModel } from "../src/cli/run/source-acquisition.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import {
  bindModelExecutionProfile,
  parseModelEndpoint,
  type BoundModelExecutionProfile,
  type ModelEndpointConfig,
} from "../src/model/configuration.js";
import { parseRunArguments } from "../src/cli.js";
import { projectExecutionProfileIntoEnvironment } from "../src/config/execution-profile.js";
import { loadDocsFabEnvironment } from "../src/config/host-paths.js";
import { limit } from "../src/config/limits.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { projectSourceRequestContext } from "../src/inputs/source-evidence.js";
import { sourceClaimSha256 } from "../src/inputs/source-evidence-artifacts.js";
import { DEFAULT_NEXT_ACTIONS } from "../src/operator/error-envelope.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import { buildRunResultV1 } from "../src/operator/run-result.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH as SOURCE_PATH,
  PAGE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
  writerClaim,
} from "./support/source-acquisition-cli.js";
import { SOURCE_CITATION_GAPS_LIMITATION } from "../src/workflow-contracts/outcome.js";
import { temporaryRoots } from "./helpers/temp.js";
import { setupPlaceholderModel } from "./support/setup-placeholder-model.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const sourceAcquisitionTimeoutMs = testTimeoutMs(
  limit("test.sourceAcquisitionLocalTimeoutMs").value,
);
const sourceApplicationTimeoutMs = testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value);
const sourceReadTimeoutMs = testTimeoutMs(limit("test.sourceAcquisitionReadLocalTimeoutMs").value);
const sourceRaisedLimitsTimeoutMs = testTimeoutMs(
  limit("test.sourceAcquisitionRaisedLimitsLocalTimeoutMs").value,
);

/**
 * The harness a `PiHarness` construction returns while a test scripts one, so
 * a run with no execution harness binds its configured model through the real
 * operator binding and only the provider connection is replaced. Every other
 * test passes its harness directly and never constructs one.
 */
const scriptedPiHarness = vi.hoisted(() => ({
  current: undefined as unknown,
  /** The bound execution profile each scripted construction received. */
  profiles: [] as unknown[],
}));

vi.mock("../src/harness/pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/harness/pi.js")>();
  // A function, not a class: `new` on a function that returns an object
  // evaluates to that object, so the run receives the scripted harness itself.
  function ScriptedPiHarness(options: ConstructorParameters<typeof actual.PiHarness>[0]) {
    if (scriptedPiHarness.current === undefined) return new actual.PiHarness(options);
    scriptedPiHarness.profiles.push((options as { executionProfile?: unknown }).executionProfile);
    return scriptedPiHarness.current;
  }
  return { ...actual, PiHarness: ScriptedPiHarness };
});

/** Every case here selects the one tracked HTML original the seed already has. */
function harness(
  readOnSkill: string | null,
  listOnly = false,
  revision = false,
  citeOnStepIds?: readonly string[],
  reviserCitesWriterClaim = false,
) {
  return new SourceToolHarness({
    readOnSkill,
    listOnly,
    revision,
    planSourcePaths: [SOURCE_PATH],
    ...(citeOnStepIds ? { citeOnStepIds } : {}),
    ...(reviserCitesWriterClaim ? { reviserCitesWriterClaim } : {}),
  });
}

function expectCanonicalQualityEvidence(
  record: RunRecord,
  model: SourceToolHarness,
  technicalStepId: "verify-technical-accuracy" | "verify-revised-technical-accuracy",
) {
  const qualityStep = record.steps.find((step) => step.id === "evaluate-document-quality")!;
  const qualityCall = model.calls.find((call) => call.stepId === "evaluate-document-quality")!;
  const planStep = record.steps.find((step) => step.id === "plan-documentation")!;
  const technicalStep = record.steps.find((step) => step.id === technicalStepId)!;
  const block = /## Source candidate evidence\s+```json\n(?<json>\{[\s\S]*?\})\n```/u.exec(
    qualityStep.summary!,
  );
  expect(block).not.toBeNull();
  const evidence = JSON.parse(block!.groups!.json!) as {
    repositoryRevision: string;
    targetPaths: string[];
    planDigest: string;
    sourceArtifactDigest: string;
    technicalVerificationSha256: string;
    candidatePhaseSha256: string;
  };

  expect(evidence).toMatchObject({
    repositoryRevision: record.repository.revision,
    targetPaths: ["docs/whats-new.md"],
    planDigest: planStep.planBinding?.digest,
    sourceArtifactDigest: qualityCall.sourceBindingDigest,
    technicalVerificationSha256: qualityCall.technicalVerificationSha256,
    candidatePhaseSha256: qualityCall.authoringPhaseSha256,
  });
  expect(record.qualityArtifactValidation?.status).toBe("passed");
  expect(record.qualityArtifactValidation?.artifacts.qualityScore).toBeNull();
  expect(record.qualityArtifactValidation?.evaluatedCandidate?.patchSha256).toBe(
    record.changes?.patch?.sha256,
  );
  expect(evidence.technicalVerificationSha256).toBe(
    canonicalDigest(JSON.parse(technicalStep.summary!)),
  );
  expect(qualityStep.summary).toContain("Documentation quality evaluation report");
}

afterEach(async () => {
  process.exitCode = undefined;
});

describe("docsfab run --source flag parsing (#835)", () => {
  it("accumulates repeated --source values in operator order", () => {
    const parsed = parseRunArguments([
      "create-documentation",
      "--instruction",
      "Create the page.",
      "--source",
      "docs/release-notes.html",
      "--source",
      "docs/upgrade.html",
    ]);
    expect(parsed.sourcePaths).toEqual(["docs/release-notes.html", "docs/upgrade.html"]);
  });

  it("omits the field entirely when the flag is absent", () => {
    const parsed = parseRunArguments(["create-documentation", "--instruction", "Create the page."]);
    expect(Object.hasOwn(parsed, "sourcePaths")).toBe(false);
  });

  it("refuses an unsafe path, a duplicate, a missing value, and an unsupported workflow", () => {
    const base = ["create-documentation", "--instruction", "Create the page."];
    for (const unsafe of ["../escape.html", "/etc/passwd", "docs/../escape.html"]) {
      expect(() => parseRunArguments([...base, "--source", unsafe])).toThrowError(
        /--source requires a safe repository-relative path/u,
      );
    }
    expect(() =>
      parseRunArguments([...base, "--source", "docs/a.html", "--source", "docs/a.html"]),
    ).toThrowError(/Every --source option must name a distinct repository-relative path/u);
    expect(() => parseRunArguments([...base, "--source"])).toThrowError(
      /The --source option was passed without a repository-relative path to bind/u,
    );
    expect(() =>
      parseRunArguments(["review-documentation", "--source", "docs/release-notes.html"]),
    ).toThrowError(
      /--source is supported only for the create-documentation and update-documentation workflows/u,
    );
  });

  it("refuses to combine --source with a durable knowledge resume", () => {
    expect(() =>
      parseRunArguments([
        "create-documentation",
        "--resume-from",
        "stopped-run",
        "--canon-snapshot",
        "snapshot.json",
        "--allow-write",
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator",
        "--source",
        "docs/release-notes.html",
      ]),
    ).toThrowError(/--source cannot be combined with --resume-from/u);
  });
});

describe("docsfab run --source request-hash parity (#835)", () => {
  it("leaves the version-1 request projection byte-identical when the flag is absent", () => {
    // `sourcePaths` rides on the CLI arguments and is consumed before the run
    // request is built, so adding the flag cannot move an existing run's hash.
    const runId = "parity-run";
    const repository = { identitySha256: "c".repeat(64), revision: "d".repeat(40) };
    const resolved = { runId, workspaceIdentitySha256: "e".repeat(64), repository };
    const request = {
      signal: undefined,
      runId,
      workflow: "create-documentation",
      workspacePath: "/tmp/workspace",
      repository,
      instruction: "Create the page.",
      allowWrite: true,
    };
    const before = projectSourceRequestContext({ ...request }, resolved);
    const parsedWithFlag = parseRunArguments([
      "create-documentation",
      "--instruction",
      "Create the page.",
      "--source",
      "docs/release-notes.html",
    ]);
    const parsedWithout = parseRunArguments([
      "create-documentation",
      "--instruction",
      "Create the page.",
    ]);
    expect(parsedWithFlag.sourcePaths).toBeDefined();
    expect(parsedWithout.sourcePaths).toBeUndefined();
    expect(projectSourceRequestContext({ ...request }, resolved)).toBe(before);
  });
});

describe("docsfab run --source end to end (#835)", () => {
  it(
    "retains the source-backed candidate and seals a V2 plan binding the writer honors",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness("plan-documentation");

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status).toBe("succeeded");
      // The reader reached the granted steps and the inert reference reached all.
      expect(model.sawReaderOn).toContain("plan-documentation");
      expect(model.sawReferenceOn).toContain("write-documentation");
      // The shipped CLI policy admits the citation channel to the writer only, and
      // the write passed the coverage gate through the host's citation join.
      expect(model.sawCiterOn).toEqual(["write-documentation"]);
      expect(model.citeCalls).toBe(1);
      const cited = record!.sourceCitations!;
      expect(cited.kind).toBe("docsfab-source-run-citations");
      expect(cited.steps.map((entry) => entry.stepId)).toEqual(["write-documentation"]);
      // Per-run coverage: the receipt behind the writer's claim belongs to the
      // planner, which is the only step that read.
      expect(cited.steps[0]!.citations.map((entry) => entry.stepId)).toEqual([
        "plan-documentation",
      ]);
      // The claim is the sentence the writer added to the page; its status reply,
      // which reports unresolved items and checks not run, owes nothing.
      expect(cited.steps[0]!.materialClaimSha256s).toEqual([
        sourceClaimSha256(writerClaim("write-documentation")),
      ]);
      expect(cited.steps[0]!.uncitedClaims).toBeUndefined();
      expect(record!.workflowOutcome?.limitations).not.toContain(SOURCE_CITATION_GAPS_LIMITATION);
      // The step learned its span ids from the shipped inventory tool; nothing else
      // in the run discloses them.
      expect(model.sawListToolOn).toEqual(["plan-documentation"]);
      expect(model.listedSpanIds.length).toBeGreaterThan(0);
      expect(model.listedSpanIds.every((id) => /^span-[a-f0-9]{64}$/u.test(id))).toBe(true);
      // The inventory disclosed identity and position only.
      const inventory = model.listedPayloads[0]!;
      expect(inventory).toContain("docsfab-source-span-inventory");
      expect(inventory).toContain("docs/release-notes.html");
      expect(inventory).not.toContain("Fixture CLI Release Notes");
      expect(inventory).not.toContain("must never reach the derivative");
      expect(model.toolReads).toHaveLength(1);
      expect(model.toolReads[0]).toContain("Fixture CLI Release Notes");
      expect(model.toolReads[0]).not.toContain("must never reach the derivative");
      expect(model.toolReads[0]).not.toContain("Unpublished draft note");
      // The planner read one span: part of the source, not the whole source, so
      // the write step reads the rest of it, and only the rest (#1809).
      expect(model.hostReads.map((source) => source.stepId)).toEqual(["write-documentation"]);
      expect(model.hostReads[0]!.spans.map((span) => span.spanId)).toEqual(
        model.listedSpanIds.slice(1),
      );
      expect(
        (record!.evidenceWarnings ?? []).filter((entry) =>
          entry.startsWith("source-read-partial:"),
        ),
      ).toEqual([]);

      const planStep = record!.steps.find((step) => step.skill === "plan-documentation");
      expect(planStep?.planBinding?.schemaVersion).toBe(2);
      expect(
        (planStep?.planBinding as { sourceBindingSha256?: string } | undefined)
          ?.sourceBindingSha256,
      ).toMatch(/^[a-f0-9]{64}$/u);
      expect(model.writerCalls).toBe(1);
      expect(record?.authoringExecution).toMatchObject({
        selection: { branchId: "retain" },
        selectedCandidate: { ordinal: 0 },
        finalPatch: { candidateOrdinal: 0 },
      });
      expectCanonicalQualityEvidence(record!, model, "verify-technical-accuracy");

      const planSnapshots = new Set(
        model.calls.flatMap((call) => (call.planBinding ? [call.planBinding] : [])),
      );
      const ledgerSnapshots = new Set(
        model.calls.flatMap((call) =>
          call.sourceObligationLedger ? [call.sourceObligationLedger] : [],
        ),
      );
      expect(planSnapshots.size).toBe(1);
      expect(ledgerSnapshots.size).toBe(1);

      const saved = JSON.parse(
        await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
      ) as RunRecord;
      expect(saved).toStrictEqual(record);
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "attributes each write step's citations to that step and no other",
    async () => {
      // `create-documentation` has two write steps holding the citer. A pooled
      // ledger would let the second inherit the first's coverage.
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness("plan-documentation", false, true);

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      expect(model.writerCalls).toBe(2);
      expect(model.citeCalls).toBe(2);
      const cited = record!.sourceCitations!;
      expect(cited.steps.map((entry) => entry.stepId)).toEqual([
        "write-documentation",
        "revise-documentation",
      ]);
      expect(cited.steps.map((entry) => entry.citations.length)).toEqual([1, 1]);
      // The reviser's claim is its own.
      const digests = cited.steps.map((entry) => entry.citations[0]!.spanCitationSha256);
      expect(new Set(digests).size).toBe(2);
      for (const step of cited.steps) {
        expect(step.citations[0]!.supportedClaimSha256).toBe(step.materialClaimSha256s[0]);
      }
    },
    sourceApplicationTimeoutMs,
  );

  it(
    "labels the revision write step's sentence when it cites nothing, whatever the first write step cited",
    async () => {
      // The final patch of a `create-documentation --source` run comes from
      // `revise-documentation`, so the writer's citations must not cover the
      // sentence the reviser added. The revised patch is still delivered.
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness("plan-documentation", false, true, ["write-documentation"]);

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(model.citeCalls).toBe(1);
      expect(record?.status, record?.error).toBe("succeeded");
      const revise = record!.steps.find((step) => step.id === "revise-documentation")!;
      expect(revise.status).toBe("succeeded");
      expect(record?.authoringExecution).toMatchObject({
        selection: { branchId: "revise" },
        finalPatch: { candidateOrdinal: 1 },
      });
      // The record does not credit the reviser with the writer's citation.
      const steps = record!.sourceCitations!.steps;
      expect(steps.map((entry) => entry.stepId)).toEqual([
        "write-documentation",
        "revise-documentation",
      ]);
      expect(steps[0]!.uncitedClaims).toBeUndefined();
      expect(steps[1]!.citations).toEqual([]);
      expect(steps[1]!.uncitedClaims).toEqual([
        {
          path: PAGE_PATH,
          line: 3,
          claimSha256: sourceClaimSha256(writerClaim("revise-documentation")),
        },
      ]);
      expect(record!.workflowOutcome?.limitations).toContain(SOURCE_CITATION_GAPS_LIMITATION);
    },
    testTimeoutMs(60_000),
  );

  it(
    "names every write step that left a gap in the one outcome finding",
    async () => {
      // Neither write step cites, so each leaves its own added sentence
      // uncited, and the outcome's one finding cites both steps.
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness("plan-documentation", false, true, []);

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(model.citeCalls).toBe(0);
      expect(record?.status, record?.error).toBe("succeeded");
      expect(
        record!.sourceCitations!.steps.map((entry) => [entry.stepId, entry.uncitedClaims]),
      ).toEqual(
        (["write-documentation", "revise-documentation"] as const).map((stepId) => [
          stepId,
          [{ path: PAGE_PATH, line: 3, claimSha256: sourceClaimSha256(writerClaim(stepId)) }],
        ]),
      );
      expect(
        record!.workflowOutcome!.findings.filter(
          (finding) => finding.code === SOURCE_CITATION_GAPS_LIMITATION,
        ),
      ).toEqual([
        expect.objectContaining({
          evidenceIds: ["step:revise-documentation", "step:write-documentation"],
        }),
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "does not let a reviser's citation of the first writer's sentence cover its own",
    async () => {
      // The reviser cites, but cites the sentence the first writer wrote, which
      // the revision replaced. Pooled, the reviser would show "claims 1, citations
      // 1" as if it had cited what it wrote.
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness("plan-documentation", false, true, undefined, true);

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(model.citeCalls).toBe(2);
      expect(model.citationRefusals).toEqual([]);
      expect(record?.status, record?.error).toBe("succeeded");
      const revise = record!.sourceCitations!.steps.find(
        (entry) => entry.stepId === "revise-documentation",
      )!;
      expect(revise.citations.map((citation) => citation.supportedClaimSha256)).toEqual([
        sourceClaimSha256(writerClaim("write-documentation")),
      ]);
      expect(revise.materialClaimSha256s).toEqual([
        sourceClaimSha256(writerClaim("revise-documentation")),
      ]);
      expect(revise.uncitedClaims).toEqual([
        {
          path: PAGE_PATH,
          line: 3,
          claimSha256: sourceClaimSha256(writerClaim("revise-documentation")),
        },
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "revises once without replacing the admitted source plan or cumulative read coverage",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness("plan-documentation", false, true);

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      expect(record?.authoringExecution).toMatchObject({
        selection: { branchId: "revise" },
        selectedCandidate: { ordinal: 1 },
        finalPatch: { candidateOrdinal: 1 },
      });
      expectCanonicalQualityEvidence(record!, model, "verify-revised-technical-accuracy");
      expect(model.writerCalls).toBe(2);
      expect(model.toolReads).toHaveLength(1);

      const revisionCalls = model.calls.filter((call) =>
        [
          "revise-documentation",
          "provisional-revised-technical-verification",
          "verify-revised-technical-accuracy",
          "review-revised-documentation",
        ].includes(call.stepId),
      );
      expect(revisionCalls.map((call) => call.stepId)).toEqual([
        "revise-documentation",
        "provisional-revised-technical-verification",
        "verify-revised-technical-accuracy",
        "review-revised-documentation",
      ]);
      expect(revisionCalls.every((call) => call.hasSourceBinding)).toBe(true);
      expect(
        revisionCalls
          .filter((call) =>
            ["write-documentation", "verify-technical-accuracy", "review-documentation"].includes(
              call.skill,
            ),
          )
          .every((call) => call.hasReader),
      ).toBe(true);
      expect(new Set(revisionCalls.map((call) => call.repositoryPath)).size).toBe(1);
      expect(revisionCalls[0]!.repositoryPath).not.toBe(fixture.repository);

      const planSnapshots = new Set(
        model.calls.flatMap((call) => (call.planBinding ? [call.planBinding] : [])),
      );
      const ledgerSnapshots = new Set(
        model.calls.flatMap((call) =>
          call.sourceObligationLedger ? [call.sourceObligationLedger] : [],
        ),
      );
      expect(planSnapshots.size).toBe(1);
      expect(ledgerSnapshots.size).toBe(1);
      expect(revisionCalls.filter((call) => call.sourceObligationLedger).length).toBeGreaterThan(0);
      expect(revisionCalls.filter((call) => call.planBinding).length).toBeGreaterThan(0);
      expect(
        revisionCalls
          .filter((call) => call.planBinding)
          .every((call) => call.planBinding === [...planSnapshots][0]),
      ).toBe(true);
      expect(
        revisionCalls
          .filter((call) => call.sourceObligationLedger)
          .every((call) => call.sourceObligationLedger === [...ledgerSnapshots][0]),
      ).toBe(true);

      const saved = JSON.parse(
        await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
      ) as RunRecord;
      expect(saved).toStrictEqual(record);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "binds the committed revision bytes when the working tree diverges",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      // Diverge the working tree after the selected commit; only the text the
      // reader returns can distinguish the two.
      await writeFile(
        join(fixture.repository, SOURCE_PATH),
        "<html><body><p>Uncommitted working tree prose.</p></body></html>\n",
        "utf8",
      );
      const model = harness("plan-documentation");

      const record = await executeRunRequest(
        { ...runRequest(fixture, [SOURCE_PATH]), revision: fixture.revision },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status).toBe("succeeded");
      expect(model.toolReads).toHaveLength(1);
      expect(model.toolReads[0]).toContain("Fixture CLI Release Notes");
      expect(model.toolReads[0]).not.toContain("Uncommitted working tree prose");
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "reads the source into the write step when the planner only listed it",
    async () => {
      // Listing is not access evidence, so the write step itself reads the
      // source whole before it writes, and cites what it read.
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness("plan-documentation", true);

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(model.sawListToolOn).toEqual(["plan-documentation"]);
      expect(model.listedSpanIds.length).toBeGreaterThan(0);
      expect(model.toolReads).toEqual([]);
      expect(record?.status, record?.error).toBe("succeeded");
      expect(model.writerCalls).toBe(1);
      // Whole: every span the planner's inventory listed, in that order.
      expect(model.hostReads.map((source) => source.stepId)).toEqual(["write-documentation"]);
      expect(model.hostReads[0]!.repositoryPath).toBe(SOURCE_PATH);
      expect(model.hostReads[0]!.spans.map((span) => span.spanId)).toEqual(model.listedSpanIds);
      expect(model.hostReads[0]!.spans.map((span) => span.text)).toContain(
        "The fixture CLI prints its installed version with the version flag.",
      );
      // The writer cited a span its own step read; no other step read one.
      expect(record!.sourceCitations!.steps.map((entry) => entry.stepId)).toEqual([
        "write-documentation",
      ]);
      expect(
        record!.sourceCitations!.steps[0]!.citations.map((citation) => citation.stepId),
      ).toEqual(["write-documentation"]);
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "reads a required source no earlier step read into the write step, whole",
    async () => {
      // The reported runs: the earlier steps never call docsfab_read_source.
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness(null);

      const record = await executeRunRequest(
        runRequest(fixture, [SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(model.sawReaderOn).toContain("plan-documentation");
      expect(model.sawReaderOn).toContain("verify-technical-accuracy");
      expect(model.toolReads).toEqual([]);
      expect(record?.status, record?.error).toBe("succeeded");
      expect(record!.steps.find((step) => step.id === "write-documentation")?.status).toBe(
        "succeeded",
      );
      expect(model.writerCalls).toBe(1);
      // Read once, by the first write step; the revision writer needs no second read.
      expect(model.hostReads.map((source) => source.stepId)).toEqual(["write-documentation"]);
      const texts = model.hostReads[0]!.spans.map((span) => span.text);
      // The title and the heading are two spans with the same text.
      expect(texts).toEqual([
        "Fixture CLI Release Notes",
        "Fixture CLI Release Notes",
        "The fixture CLI prints its installed version with the version flag.",
        "Version 2 adds a quiet flag that suppresses progress output.",
        "The version flag exits with status zero.",
        "The quiet flag still prints the final verdict.",
      ]);
      expect(texts.join("\n")).not.toContain("must never reach the derivative");
      expect(texts.join("\n")).not.toContain("Unpublished draft note");
      expect(
        record!.sourceCitations!.steps[0]!.citations.map((citation) => citation.stepId),
      ).toEqual(["write-documentation"]);
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "refuses an untracked --source path before any workflow model call",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness(null);

      // The refusal runs ahead of the knowledge evidence gate, so the operator
      // reads the actionable "no such source" sentence; the structured code stays.
      const error = (await executeRunRequest(
        runRequest(fixture, ["docs/not-committed.html"]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      ).catch((caught: unknown) => caught)) as { code?: string; message: string };
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe("path-not-tracked");
      expect(error.message).toBe(
        "No such source: docs/not-committed.html is not a tracked regular file at the selected revision. " +
          "Nothing was read and no model call was made. Check the path, or commit the file, then run again.",
      );
      expect(model.sawReaderOn).toEqual([]);
      expect(model.sawReferenceOn).toEqual([]);
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "names the export exclusion when a committed --source file is one the export never materializes",
    async () => {
      const fixture = await createSourceFixture({ ".env": "EXPORT_LIMIT=10\n" });
      roots.track(fixture.root);
      const model = harness(null);

      const error = (await executeRunRequest(
        runRequest(fixture, [".env"]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      ).catch((caught: unknown) => caught)) as { code?: string; message: string };
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe("path-not-tracked");
      expect(error.message).toMatch(
        /^Source excluded: \.env is excluded from the source export, which never materializes credential files \(\.env and \.env\.\* /u,
      );
      expect(error.message).toContain("Nothing was read and no model call was made.");
      expect(model.sawReaderOn).toEqual([]);
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "refuses a tracked --source path whose media type no adapter claims",
    async () => {
      const unsupportedPath = "docs/guide.rst";
      const fixture = await createSourceFixture({
        [unsupportedPath]: "Unsupported source format.\n",
      });
      roots.track(fixture.root);
      const model = harness(null);

      await expect(
        executeRunRequest(
          runRequest(fixture, [unsupportedPath]),
          runtimeConfig(fixture.stateDirectory),
          { silent: true, executionHarness: model, skillResolver },
        ),
      ).rejects.toThrowError(/unsupported-media-type/u);
      expect(model.sawReaderOn).toEqual([]);
      expect(model.writerCalls).toBe(0);
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "leaves a run without --source on the V1 plan binding and no reader anywhere",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = harness(null);

      const record = await executeRunRequest(
        runRequest(fixture),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status).toBe("succeeded");
      expect(model.sawReaderOn).toEqual([]);
      expect(model.sawReferenceOn).toEqual([]);
      expect(
        record!.steps.find((step) => step.skill === "plan-documentation")?.planBinding
          ?.schemaVersion,
      ).toBe(1);
      expect(model.writerCalls).toBe(1);
    },
    sourceAcquisitionTimeoutMs,
  );
});

describe("docsfab run --source <json> end to end (#836)", () => {
  const STRUCTURED_SOURCE_PATH = "api/standalone.json";
  const COMMITTED_JSON = '{"summary":"List pets"}\n';

  it(
    "acquires a tracked JSON pointer through the installed structured registry",
    async () => {
      const fixture = await createSourceFixture({ [STRUCTURED_SOURCE_PATH]: COMMITTED_JSON });
      roots.track(fixture.root);
      await writeFile(
        join(fixture.repository, STRUCTURED_SOURCE_PATH),
        '{"summary":"Do not read this"}\n',
        "utf8",
      );
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [STRUCTURED_SOURCE_PATH],
      });

      const record = await executeRunRequest(
        { ...runRequest(fixture, [STRUCTURED_SOURCE_PATH]), revision: fixture.revision },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status).toBe("succeeded");
      expect(model.sawListToolOn).toEqual(["plan-documentation"]);
      expect(model.locatorKinds).toEqual(["json-pointer"]);
      expect(model.listedPaths).toEqual([STRUCTURED_SOURCE_PATH]);
      expect(model.listed[0]?.locator).toEqual({ kind: "json-pointer", pointer: "/summary" });
      expect(model.toolReads).toEqual(['"List pets"']);
      expect(model.toolReads[0]).not.toContain("Do not read this");
      expect(model.listedPayloads[0]).toContain('"pointer":"/summary"');
      expect(
        record!.steps.find((step) => step.skill === "plan-documentation")?.planBinding
          ?.schemaVersion,
      ).toBe(2);
      expect(model.writerCalls).toBe(1);
    },
    sourceAcquisitionTimeoutMs,
  );

  it(
    "acquires a tracked source under a hidden directory",
    async () => {
      const HIDDEN_SOURCE_PATH = ".bench/change.json";
      const fixture = await createSourceFixture({ [HIDDEN_SOURCE_PATH]: COMMITTED_JSON });
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HIDDEN_SOURCE_PATH],
      });

      const record = await executeRunRequest(
        { ...runRequest(fixture, [HIDDEN_SOURCE_PATH]), revision: fixture.revision },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      expect(model.listedPaths).toEqual([HIDDEN_SOURCE_PATH]);
      expect(model.toolReads).toEqual(['"List pets"']);
    },
    sourceAcquisitionTimeoutMs,
  );
});

describe("docsfab run --source required-source read budget (#1808, #1809)", () => {
  const REQUIREMENTS_PATH = "docs/requirements.txt";
  const DEFAULT_BUDGET = 262_144;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A text source with one span per line, so its span bytes are exact: 2,048
   * lines of 128 bytes are the shipped 262,144-byte per-step budget, and
   * `extraBytes` lengthens the last line past it. 2,048 lines is also the
   * extraction span ceiling, so the source stays one complete extract.
   */
  function requirements(extraBytes: number): string {
    const lines = Array.from({ length: 2048 }, (_, index) =>
      `Requirement ${String(index).padStart(4, "0")} keeps the export bounded.`.padEnd(128, "."),
    );
    lines[2047] = `${lines[2047]!}${"+".repeat(extraBytes)}`;
    return `${lines.join("\n")}\n`;
  }

  function writeStepReads(model: SourceToolHarness) {
    return model.hostReads.filter((source) => source.stepId === "write-documentation");
  }

  function spanBytes(source: { spans: ReadonlyArray<{ text: string }> } | undefined): number {
    return (source?.spans ?? []).reduce((total, span) => total + Buffer.byteLength(span.text), 0);
  }

  function partialReads(record: RunRecord | undefined): string[] {
    return (record?.evidenceWarnings ?? []).filter((entry) =>
      entry.startsWith("source-read-partial:"),
    );
  }

  it(
    "reads an unread source of exactly the per-step read budget into the write step",
    async () => {
      const fixture = await createSourceFixture({ [REQUIREMENTS_PATH]: requirements(0) });
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: null,
        planSourcePaths: [REQUIREMENTS_PATH],
      });

      const record = await executeRunRequest(
        runRequest(fixture, [REQUIREMENTS_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      expect(model.toolReads).toEqual([]);
      expect(model.writerCalls).toBe(1);
      const [source] = writeStepReads(model);
      expect(source?.repositoryPath).toBe(REQUIREMENTS_PATH);
      expect(source?.spans).toHaveLength(2048);
      expect(spanBytes(source)).toBe(DEFAULT_BUDGET);
      const writer = model.calls.find((call) => call.stepId === "write-documentation");
      expect(writer?.hasReader).toBe(true);
      expect(partialReads(record)).toEqual([]);
    },
    sourceReadTimeoutMs,
  );

  it(
    "reads a window one byte over the per-step read budget and reports the rest as unread",
    async () => {
      const fixture = await createSourceFixture({ [REQUIREMENTS_PATH]: requirements(1) });
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: null,
        planSourcePaths: [REQUIREMENTS_PATH],
      });

      const record = await executeRunRequest(
        runRequest(fixture, [REQUIREMENTS_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      // Reachable, not stopped: the write step reads every line but the last.
      expect(record?.status, record?.error).toBe("succeeded");
      const write = record!.steps.find((step) => step.id === "write-documentation")!;
      expect(write.status).toBe("succeeded");
      expect(write.failure).toBeUndefined();
      expect(model.writerCalls).toBe(1);
      const [source] = writeStepReads(model);
      expect(source?.spans).toHaveLength(2047);
      expect(spanBytes(source)).toBe(DEFAULT_BUDGET - 128);
      // The run record names the source, the bytes read out of its total, the
      // limit, and the remediation. It is never reported as considered.
      const partial = [
        `source-read-partial: ${REQUIREMENTS_PATH} was read ${DEFAULT_BUDGET - 128} of ${DEFAULT_BUDGET + 1} bytes when step write-documentation started writing; the rest of it was not read.`,
        "source-read-partial: step write-documentation could not read every required source whole. " +
          `sources-read-response-ceiling-bytes-bound: ${DEFAULT_BUDGET + 1} exceeds sources.readResponseCeilingBytes = ${DEFAULT_BUDGET} bytes. ` +
          "Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least the bytes named, up to 67108864, so one step can read every required source whole, or bind fewer or smaller sources, then start a new run. Follow the named remediation.",
      ];
      expect(partialReads(record)).toEqual(partial);
      // The operator summary's LIMITATIONS section and the --json result carry it.
      const recordPath = join(fixture.stateDirectory, `${record!.id}.json`);
      const summary = formatRunSummary({
        record: record!,
        recordPath,
        exitCode: 0,
        repositoryPath: fixture.repository,
        quiet: true,
        tty: false,
        ci: false,
        noColor: true,
      }).join("\n");
      expect(summary).toContain("LIMITATIONS");
      for (const line of partial) expect(summary).toContain(line);
      expect(
        buildRunResultV1({
          record: record!,
          recordPath,
          exitCode: 0,
          repositoryPath: fixture.repository,
        }).limitOverflow,
      ).toEqual(expect.arrayContaining(partial));
      // `docsfab runs show` replays it from the saved record, in both forms.
      const saved = JSON.parse(await readFile(recordPath, "utf8")) as RunRecord;
      expect(partialReads(saved)).toEqual(partial);
      const shown = await captureLog(() =>
        handleRunsCommand(["show", record!.id, "--state-dir", fixture.stateDirectory]),
      );
      expect(shown).toContain("LIMITATIONS");
      for (const line of partial) expect(shown).toContain(line);
      const shownJson = JSON.parse(
        await captureLog(() =>
          handleRunsCommand(["show", record!.id, "--json", "--state-dir", fixture.stateDirectory]),
        ),
      ) as { limitOverflow?: string[] };
      expect(shownJson.limitOverflow).toEqual(expect.arrayContaining(partial));
    },
    sourceReadTimeoutMs,
  );

  it(
    "reads the same source whole under an upward override of the budget",
    async () => {
      vi.stubEnv("DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES", String(2 * DEFAULT_BUDGET));
      const fixture = await createSourceFixture({ [REQUIREMENTS_PATH]: requirements(1) });
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: null,
        planSourcePaths: [REQUIREMENTS_PATH],
      });

      const record = await executeRunRequest(
        runRequest(fixture, [REQUIREMENTS_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      const [source] = writeStepReads(model);
      expect(source?.spans).toHaveLength(2048);
      expect(spanBytes(source)).toBe(DEFAULT_BUDGET + 1);
      expect(partialReads(record)).toEqual([]);
      const writer = model.calls.find((call) => call.stepId === "write-documentation");
      expect(writer?.hasReader).toBe(true);
    },
    sourceReadTimeoutMs,
  );
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

describe("source-read budget for the bound model's input window (#1809)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function model(maxInputTokens: number, contextAdmission?: "host-window" | "provider") {
    return {
      profile: { maxInputTokens } as BoundModelExecutionProfile["profile"],
      requestPolicy: { reservedContextTokens: 4096, minimumOutputTokens: 16 },
      ...(contextAdmission ? { contextAdmission } : {}),
    };
  }

  it("takes a share of a small window and keeps the ceiling on a large one", () => {
    // 0.15 of the window after its reserve, at 4 bytes per token: more than
    // the former 32 KiB default on a 65,536-token window.
    expect(sourceReadBudgetForModel(model(65_536))).toEqual({
      budgetBytes: 36_864,
      basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 61_440 },
    });
    expect(sourceReadBudgetForModel(model(128_000))).toEqual({
      budgetBytes: 74_342,
      basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 123_904 },
    });
    // The share reaches the ceiling at 441,003 tokens, and not one token sooner.
    expect(sourceReadBudgetForModel(model(441_002))).toEqual({
      budgetBytes: 262_143,
      basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 436_906 },
    });
    expect(sourceReadBudgetForModel(model(441_003))).toEqual({
      budgetBytes: 262_144,
      basis: { kind: "ceiling" },
    });
    expect(sourceReadBudgetForModel(model(1_000_000))).toEqual({
      budgetBytes: 262_144,
      basis: { kind: "ceiling" },
    });
  });

  it("keeps the ceiling when no host window is attested", () => {
    expect(sourceReadBudgetForModel(undefined)).toEqual({
      budgetBytes: 262_144,
      basis: { kind: "ceiling" },
    });
    expect(sourceReadBudgetForModel(model(65_536, "provider"))).toEqual({
      budgetBytes: 262_144,
      basis: { kind: "ceiling" },
    });
  });

  it("keeps the ceiling for the placeholder window setup writes, with or without its admission mode", () => {
    // 0.15 of that 32,768-token window after its 1,024-token reserve would be
    // 19,046 bytes, below the former 32 KiB default.
    const bound = bindModelExecutionProfile(setupPlaceholderModel()).profile;
    expect(bound.profile.maxInputTokens).toBe(32_768);
    expect(bound.requestPolicy.reservedContextTokens).toBe(1_024);
    const ceiling = { budgetBytes: 262_144, basis: { kind: "ceiling" } };
    expect(sourceReadBudgetForModel(bound)).toEqual(ceiling);
    const { contextAdmission: _admission, ...withoutAdmission } = bound;
    expect(sourceReadBudgetForModel(withoutAdmission)).toEqual(ceiling);
    // An installed composition's window still sets the share, whatever the
    // YAML metadata says: the composition's qualification attests it.
    expect(
      sourceReadBudgetForModel({
        ...withoutAdmission,
        profile: {
          ...bound.profile,
          maxInputTokens: 65_536,
          effectiveLimitReason: "composition-candidate",
        },
      }),
    ).toEqual({
      budgetBytes: 38_707,
      basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 64_512 },
    });
  });

  it("honors an upward override of the share, under the ceiling, and refuses one past its max", () => {
    vi.stubEnv("DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE", "0.5");
    expect(sourceReadBudgetForModel(model(65_536))).toEqual({
      budgetBytes: 122_880,
      basis: { kind: "input-window-share", share: 0.5, inputWindowTokens: 61_440 },
    });
    expect(sourceReadBudgetForModel(model(1_000_000)).budgetBytes).toBe(262_144);
    vi.stubEnv("DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE", "2");
    expect(() => sourceReadBudgetForModel(model(65_536))).toThrowError(
      /DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE/u,
    );
  });
});

describe("source-read budget through the CLI composition root (#1809)", () => {
  const REQUIREMENTS_PATH = "docs/requirements.txt";
  /** 468 lines of 64 bytes: 29,952 bytes of spans, which the former 32 KiB default read whole. */
  const LINES = 468;
  const SPAN_BYTES = LINES * 64;

  afterEach(() => {
    vi.unstubAllEnvs();
    scriptedPiHarness.current = undefined;
    scriptedPiHarness.profiles.length = 0;
  });

  function requirements(): string {
    return `${Array.from({ length: LINES }, (_, index) =>
      `Requirement ${String(index).padStart(4, "0")} keeps the export bounded.`.padEnd(64, "."),
    ).join("\n")}\n`;
  }

  /** The shipped test model, with an attested 65,536-token input window. */
  function smallWindowConfig(stateDirectory: string): DocsFabConfig {
    const config = runtimeConfig(stateDirectory);
    const profile = config.model.profile;
    return {
      ...config,
      model: {
        ...config.model,
        profile: {
          ...profile,
          configuredLimits: {
            ...profile.configuredLimits,
            contextWindow: 65_536,
            maxInputTokens: 65_536,
          },
          contextWindow: 65_536,
          maxInputTokens: 65_536,
        },
      },
    };
  }

  /** A run with no execution harness, so the CLI binds the configured model itself. */
  async function runThroughOperatorBinding(
    configured?: ModelEndpointConfig,
    bound: { contextAdmission: "host-window" | "provider"; maxInputTokens: number } = {
      contextAdmission: "host-window",
      maxInputTokens: 65_536,
    },
  ) {
    const fixture = await createSourceFixture({ [REQUIREMENTS_PATH]: requirements() });
    roots.track(fixture.root);
    const model = new SourceToolHarness({
      readOnSkill: null,
      planSourcePaths: [REQUIREMENTS_PATH],
    });
    scriptedPiHarness.current = model;
    const config = smallWindowConfig(fixture.stateDirectory);
    const record = await executeRunRequest(
      runRequest(fixture, [REQUIREMENTS_PATH]),
      configured ? { ...config, model: configured } : config,
      { silent: true, skillResolver },
    );
    // The real operator binding bound the model the harness runs with.
    expect(scriptedPiHarness.profiles).toEqual([
      expect.objectContaining({
        contextAdmission: bound.contextAdmission,
        profile: expect.objectContaining({ maxInputTokens: bound.maxInputTokens }),
      }),
    ]);
    return {
      record,
      writeReads: model.hostReads.filter((source) => source.stepId === "write-documentation"),
    };
  }

  function spanBytes(source: { spans: ReadonlyArray<{ text: string }> } | undefined): number {
    return (source?.spans ?? []).reduce((total, span) => total + Buffer.byteLength(span.text), 0);
  }

  function partialReads(record: RunRecord | undefined): string[] {
    return (record?.evidenceWarnings ?? []).filter((entry) =>
      entry.startsWith("source-read-partial:"),
    );
  }

  it(
    "reads a 29,952-byte source whole at the default share of a 65,536-token window",
    async () => {
      expect(Buffer.byteLength(requirements())).toBe(SPAN_BYTES + LINES);
      const { record, writeReads } = await runThroughOperatorBinding();

      expect(record?.status, record?.error).toBe("succeeded");
      expect(writeReads).toHaveLength(1);
      expect(writeReads[0]!.spans).toHaveLength(LINES);
      expect(spanBytes(writeReads[0])).toBe(SPAN_BYTES);
      expect(partialReads(record)).toEqual([]);
    },
    sourceReadTimeoutMs,
  );

  it(
    "reads the source whole at the ceiling when the model is the placeholder setup writes",
    async () => {
      // The placeholder's 32,768-token window would hold 19,046 bytes at the
      // default share; no one attested it, so the ceiling applies.
      const { record, writeReads } = await runThroughOperatorBinding(setupPlaceholderModel(), {
        contextAdmission: "provider",
        maxInputTokens: 32_768,
      });

      expect(record?.status, record?.error).toBe("succeeded");
      expect(writeReads).toHaveLength(1);
      expect(writeReads[0]!.spans).toHaveLength(LINES);
      expect(spanBytes(writeReads[0])).toBe(SPAN_BYTES);
      expect(partialReads(record)).toEqual([]);
    },
    sourceReadTimeoutMs,
  );

  it(
    "reads the share of an explicit installed composition's window, whatever its profile metadata says",
    async () => {
      // What `docsfab setup --profile <composition>` writes: the composition's
      // 128,000-token window, metadata nobody attested, and a 1,024-token reserve.
      const compositionId = "nvidia-nemotron-3.5-lightning-30b-a3b-pi";
      const environment: NodeJS.ProcessEnv = {};
      projectExecutionProfileIntoEnvironment(compositionId, environment);
      environment.MODEL_API_KEY = "test-secret";
      const configured = parseModelEndpoint(environment, "MODEL");
      expect(configured.profile.metadata.status).toBe("unknown");
      expect(configured.profile.maxInputTokens).toBe(128_000);
      expect(configured.requestPolicy.reservedContextTokens).toBe(1_024);
      // 1,400 lines of 64 bytes: 89,600 bytes of spans.
      const lines = 1_400;
      const fixture = await createSourceFixture({
        [REQUIREMENTS_PATH]: `${Array.from({ length: lines }, (_, index) =>
          `Requirement ${String(index).padStart(4, "0")} keeps the export bounded.`.padEnd(64, "."),
        ).join("\n")}\n`,
      });
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: null,
        planSourcePaths: [REQUIREMENTS_PATH],
      });
      scriptedPiHarness.current = model;

      // The scripted harness reports a product the composition does not seal, so
      // delivery refuses the finished run's outcome; the run record is saved first.
      await expect(
        executeRunRequest(
          { ...runRequest(fixture, [REQUIREMENTS_PATH]), compositionId },
          { ...runtimeConfig(fixture.stateDirectory), model: configured },
          { silent: true, skillResolver },
        ),
      ).rejects.toMatchObject({ code: "execution-product-mismatch" });
      const saved = (await readdir(fixture.stateDirectory)).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".limit-overflow.json"),
      );
      expect(saved).toHaveLength(1);
      const record = JSON.parse(
        await readFile(join(fixture.stateDirectory, saved[0]!), "utf8"),
      ) as RunRecord;

      // The explicit composition's binding admits against its window.
      expect(scriptedPiHarness.profiles).toEqual([
        expect.objectContaining({
          contextAdmission: "host-window",
          profile: expect.objectContaining({
            maxInputTokens: 128_000,
            effectiveLimitReason: "composition-candidate",
          }),
        }),
      ]);
      // 0.15 of 126,976 tokens after the reserve, at 4 bytes per token, is
      // 76,185 bytes: 1,190 whole lines, not the 89,600 the ceiling would admit.
      const writeReads = model.hostReads.filter(
        (source) => source.stepId === "write-documentation",
      );
      expect(writeReads).toHaveLength(1);
      expect(writeReads[0]!.spans).toHaveLength(1_190);
      expect(spanBytes(writeReads[0])).toBe(76_160);
      expect(partialReads(record)).toEqual([
        `source-read-partial: ${REQUIREMENTS_PATH} was read 76160 of ${lines * 64} bytes when step write-documentation started writing; the rest of it was not read.`,
        "source-read-partial: step write-documentation could not read every required source whole. " +
          `sources-read-input-window-share-bound: ${lines * 64} exceeds the step's source-read budget of 76185 bytes, sources.readInputWindowShare = 0.15 of the model's 126976-token input window. ` +
          "Raise DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE, up to 1, so source reads may fill more of the model's input window, run with a model whose input window is larger, or bind fewer or smaller sources, then start a new run. Follow the named remediation.",
      ]);
    },
    sourceReadTimeoutMs,
  );

  it(
    "reads the share's bytes under a lowered share and names the share as the bound",
    async () => {
      vi.stubEnv("DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE", "0.1");
      // 0.1 of the 61,440 tokens left after the reserve, at 4 bytes per token.
      const budget = 24_576;
      const { record, writeReads } = await runThroughOperatorBinding();

      expect(record?.status, record?.error).toBe("succeeded");
      expect(writeReads).toHaveLength(1);
      expect(writeReads[0]!.spans).toHaveLength(budget / 64);
      expect(spanBytes(writeReads[0])).toBe(budget);
      expect(partialReads(record)).toEqual([
        `source-read-partial: ${REQUIREMENTS_PATH} was read ${budget} of ${SPAN_BYTES} bytes when step write-documentation started writing; the rest of it was not read.`,
        "source-read-partial: step write-documentation could not read every required source whole. " +
          `sources-read-input-window-share-bound: ${SPAN_BYTES} exceeds the step's source-read budget of ${budget} bytes, sources.readInputWindowShare = 0.1 of the model's 61440-token input window. ` +
          "Raise DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE, up to 1, so source reads may fill more of the model's input window, run with a model whose input window is larger, or bind fewer or smaller sources, then start a new run. Follow the named remediation.",
      ]);
    },
    sourceReadTimeoutMs,
  );
});

describe("docsfab run --source requirements documents past the old 32 KiB budget (#1809)", () => {
  const PRD_PATH = "docs/prd.txt";
  /** The reported requirements document's exported size. */
  const PRD_FILE_BYTES = 39_789;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Exactly `PRD_FILE_BYTES` of text: 612 lines of 64 bytes and one of 8, each
   * newline-terminated. Its spans hold 39,176 bytes, the file less its newlines.
   */
  function prd(): string {
    const lines = Array.from({ length: 612 }, (_, index) =>
      `Feature ${String(index).padStart(3, "0")} keeps the documented behavior.`.padEnd(64, "."),
    );
    lines.push("Closing.");
    return `${lines.join("\n")}\n`;
  }
  const PRD_SPAN_BYTES = 612 * 64 + 8;

  function partialReads(record: RunRecord | undefined): string[] {
    return (record?.evidenceWarnings ?? []).filter((entry) =>
      entry.startsWith("source-read-partial:"),
    );
  }

  it(
    "reads a 39,789-byte requirements document whole by default and passes the write gate",
    async () => {
      expect(Buffer.byteLength(prd())).toBe(PRD_FILE_BYTES);
      const fixture = await createSourceFixture({ [PRD_PATH]: prd() });
      roots.track(fixture.root);
      const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [PRD_PATH] });

      const record = await executeRunRequest(
        runRequest(fixture, [PRD_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      const reads = model.hostReads.filter((source) => source.stepId === "write-documentation");
      expect(reads).toHaveLength(1);
      expect(reads[0]!.spans).toHaveLength(613);
      expect(reads[0]!.spans.reduce((total, span) => total + Buffer.byteLength(span.text), 0)).toBe(
        PRD_SPAN_BYTES,
      );
      // The write gate passed on a citation of what the write step read.
      expect(record!.sourceCitations!.steps.map((entry) => entry.stepId)).toEqual([
        "write-documentation",
      ]);
      expect(partialReads(record)).toEqual([]);
    },
    sourceReadTimeoutMs,
  );

  it(
    "reads a window of it under a lowered budget and reports it as partially read",
    async () => {
      vi.stubEnv("DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES", "16384");
      const fixture = await createSourceFixture({ [PRD_PATH]: prd() });
      roots.track(fixture.root);
      const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [PRD_PATH] });

      const record = await executeRunRequest(
        runRequest(fixture, [PRD_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      const reads = model.hostReads.filter((source) => source.stepId === "write-documentation");
      expect(reads[0]!.spans).toHaveLength(256);
      expect(partialReads(record)).toEqual([
        `source-read-partial: ${PRD_PATH} was read 16384 of ${PRD_SPAN_BYTES} bytes when step write-documentation started writing; the rest of it was not read.`,
        "source-read-partial: step write-documentation could not read every required source whole. " +
          `sources-read-response-ceiling-bytes-bound: ${PRD_SPAN_BYTES} exceeds sources.readResponseCeilingBytes = 16384 bytes. ` +
          "Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least the bytes named, up to 67108864, so one step can read every required source whole, or bind fewer or smaller sources, then start a new run. Follow the named remediation.",
      ]);
    },
    sourceReadTimeoutMs,
  );

  it(
    "reads it across steps: the planner reads a window by byte offset and the writer the rest",
    async () => {
      // Neither step's budget holds the whole document.
      vi.stubEnv("DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES", "24576");
      const fixture = await createSourceFixture({ [PRD_PATH]: prd() });
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        readWindowMaxBytes: 20_000,
        planSourcePaths: [PRD_PATH],
      });

      const record = await executeRunRequest(
        runRequest(fixture, [PRD_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      // The planner's window: 312 whole lines, named by no span id.
      expect(model.windowReads).toHaveLength(1);
      const window = model.windowReads[0]!;
      expect(window.spans).toHaveLength(312);
      expect(window.readBytes).toBe(312 * 64);
      expect(window.totalBytes).toBe(PRD_SPAN_BYTES);
      // The write step read exactly the rest, so the run read the whole document.
      const reads = model.hostReads.filter((source) => source.stepId === "write-documentation");
      expect(reads).toHaveLength(1);
      expect(reads[0]!.spans).toHaveLength(613 - 312);
      expect(new Set([...window.spans, ...reads[0]!.spans].map((span) => span.spanId)).size).toBe(
        613,
      );
      expect(partialReads(record)).toEqual([]);
      // The writer cited the planner's read; the gate accepted it.
      expect(
        record!.sourceCitations!.steps[0]!.citations.map((citation) => citation.stepId),
      ).toEqual(["plan-documentation"]);
    },
    sourceReadTimeoutMs,
  );
});

describe("docsfab run --source past the original ceiling (#1809, #1932)", () => {
  const RAISED = 5 * 1024 * 1024;
  // 2,000 lines of 2,250 bytes: past the 4 MiB default and under the raise,
  // with no more spans than the extraction ceiling admits.
  const BIG_PATH = "docs/big.txt";
  const BIG = `${Array.from({ length: 2000 }, (_, index) => `${index}`.padEnd(2250, "b")).join("\n")}\n`;
  // 2,000 lines of 2,750 bytes: past the raise too.
  const HUGE_PATH = "docs/huge.txt";
  const HUGE = `${Array.from({ length: 2000 }, (_, index) => `${index}`.padEnd(2750, "h")).join("\n")}\n`;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A configuration root whose `.env` raises both extraction ceilings, loaded the way `main()` loads it. */
  async function raiseInConfigurationRoot(): Promise<void> {
    const root = await roots.create("docsfab-source-config-root-");
    await writeFile(
      join(root, ".env"),
      `DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES=${RAISED}\nDOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES=${RAISED}\n`,
      "utf8",
    );
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    // Stubbed first, so the restore also removes what the root's .env sets.
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES", undefined);
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", undefined);
    // The CLI loads the configuration root after every module is imported, so
    // only a limit resolved when the run acquires can see this raise.
    loadDocsFabEnvironment();
    expect(limit("sources.extractionMaxOriginalBytes").value).toBe(RAISED);
  }

  function refusal(path: string, observed: number, bound: number): string {
    return (
      `Source acquisition refused: input-over-limit (${path}). ` +
      `sources-extraction-max-original-bytes-bound: ${observed} exceeds sources.extractionMaxOriginalBytes = ${bound} bytes. ` +
      "Bind a smaller source, such as a narrower merged-MR window or a smaller tracked file, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES, up to 67108864, then start a new run. " +
      "Follow the named remediation."
    );
  }

  it(
    "refuses a file past the default ceiling with the code, its bytes, the bound, and the override",
    async () => {
      const fixture = await createSourceFixture({ [BIG_PATH]: BIG });
      roots.track(fixture.root);
      const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [BIG_PATH] });

      await expect(
        executeRunRequest(runRequest(fixture, [BIG_PATH]), runtimeConfig(fixture.stateDirectory), {
          silent: true,
          executionHarness: model,
          skillResolver,
        }),
      ).rejects.toThrowError(refusal(BIG_PATH, Buffer.byteLength(BIG), 4_194_304));
      expect(model.calls).toEqual([]);
    },
    sourceReadTimeoutMs,
  );

  it(
    "refuses a file whose extracted text is past the derivative ceiling with that limit's line",
    async () => {
      // 1,000 lines of 1,500 bytes: under the original ceiling, but its text is
      // past the 1 MiB derivative ceiling, which a bound source may not truncate.
      const MID_PATH = "docs/mid.txt";
      const MID = `${Array.from({ length: 1000 }, (_, index) => `${index}`.padEnd(1500, "m")).join("\n")}\n`;
      const fixture = await createSourceFixture({ [MID_PATH]: MID });
      roots.track(fixture.root);

      await expect(
        executeRunRequest(runRequest(fixture, [MID_PATH]), runtimeConfig(fixture.stateDirectory), {
          silent: true,
          executionHarness: new SourceToolHarness({
            readOnSkill: null,
            planSourcePaths: [SOURCE_PATH],
          }),
          skillResolver,
        }),
      ).rejects.toThrowError(
        /^Source acquisition refused: input-over-limit \(docs\/mid\.txt\)\. sources-extraction-max-derivative-bytes-bound: \d+ exceeds sources\.extractionMaxDerivativeBytes = 1048576 bytes\. Bind a smaller file or a narrower selection, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES, up to 67108864, then start a new run\. Follow the named remediation\.$/u,
      );
    },
    sourceReadTimeoutMs,
  );

  it(
    "binds a file between the default and a configuration-root raise, and refuses one past the raise",
    async () => {
      await raiseInConfigurationRoot();
      const fixture = await createSourceFixture({ [BIG_PATH]: BIG, [HUGE_PATH]: HUGE });
      roots.track(fixture.root);

      // The plan names the seed page, so no step but source acquisition reads
      // the bound file under a ceiling of its own.
      const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [SOURCE_PATH] });
      const record = await executeRunRequest(
        runRequest(fixture, [BIG_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      // Bound whole: 2,000 spans of 2,250 bytes. The write step reads what its
      // 262,144-byte budget holds and reports the rest.
      expect(record?.evidenceWarnings ?? []).toContain(
        `source-read-partial: ${BIG_PATH} was read 261000 of 4500000 bytes when step write-documentation started writing; the rest of it was not read.`,
      );

      await expect(
        executeRunRequest(runRequest(fixture, [HUGE_PATH]), runtimeConfig(fixture.stateDirectory), {
          silent: true,
          executionHarness: new SourceToolHarness({
            readOnSkill: null,
            planSourcePaths: [HUGE_PATH],
          }),
          skillResolver,
        }),
      ).rejects.toThrowError(refusal(HUGE_PATH, Buffer.byteLength(HUGE), RAISED));
    },
    sourceRaisedLimitsTimeoutMs,
  );
});

describe("docsfab run --source with a line longer than one step's read budget", () => {
  const LOG_PATH = "docs/build-log.txt";
  /** 40,001 bytes on one line: an "a", then two-byte characters. */
  const LINE = `a${"é".repeat(20_000)}`;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "reads the line across steps by window and passes the write gate",
    async () => {
      vi.stubEnv("DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES", "24576");
      const fixture = await createSourceFixture({ [LOG_PATH]: `${LINE}\n` });
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        readWindowMaxBytes: 16_384,
        planSourcePaths: [LOG_PATH],
      });

      const record = await executeRunRequest(
        runRequest(fixture, [LOG_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      expect(model.windowReads).toHaveLength(1);
      const window = model.windowReads[0]!;
      expect(window.readBytes).toBeLessThanOrEqual(16_384);
      const reads = model.hostReads.filter((source) => source.stepId === "write-documentation");
      expect(reads).toHaveLength(1);
      // The planner's window and the writer's read hold every byte of the line once.
      expect([...window.spans, ...reads[0]!.spans].map((span) => span.text).join("")).toBe(LINE);
      expect(
        (record?.evidenceWarnings ?? []).filter((entry) =>
          entry.startsWith("source-read-partial:"),
        ),
      ).toEqual([]);
    },
    sourceReadTimeoutMs,
  );
});
