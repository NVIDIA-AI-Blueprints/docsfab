// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";

import { ArtifactValidationError } from "../src/artifacts/contracts.js";
import { EditorialDecisionValidationError } from "../src/artifacts/editorial-decision.js";
import { ArtifactStoreError } from "../src/artifacts/store.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { limit } from "../src/config/limits.js";
import { ReaderContextValidationError } from "../src/context/reader-context.js";
import { loadSavedRunEditorialDecodeOptions } from "../src/cli/run/editorial-replay.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { ReaderTaskContextError } from "../src/execution/task-context.js";
import { editorialAssessmentEvidenceRefsV1 } from "../src/harness/pi.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStoreError } from "../src/records/file-store.js";
import {
  buildRunHumanNextCommand,
  collectRunResultNextSteps,
  defaultRunRecordPath,
  formatRunSummary,
} from "../src/operator/run-summary.js";
import { bindDocumentationPlanProposal } from "../src/workflow-execution/plan-binding.js";
import {
  EditorialEvidenceHostError,
  EditorialEvidenceHostV1,
} from "../src/workflow-execution/editorial-evidence-host.js";
import {
  shouldHostBindDirectedUpdate,
  synthesizeEditorialInputAskSlots,
} from "../src/workflow-execution/runner.js";
import {
  EDITORIAL_SELECT_HOST_STOP_CODES,
  editorialSelectErrorCode,
} from "../src/workflow-execution/runner-ports.js";
import {
  createWorkflowOutcome,
  redactOperatorFacingSummaryV1,
  releaseGateWorkflowOutcomePolicy,
  workflowOutcomeExitCode,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import {
  observePublicContract,
  orbitOptionChangeRepository,
} from "./helpers/orbit-option-change-fixture.js";
import { verificationFixture, verificationResultFixture } from "./helpers/verification.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("operator InputAsk helpers", () => {
  it("decides a directed update from the write grant, the plan, and the comparison only", () => {
    const directed = { planMutates: true, allowWrite: true, comparisonUnknown: true };
    expect(shouldHostBindDirectedUpdate(directed)).toBe(true);
    expect(shouldHostBindDirectedUpdate({ ...directed, allowWrite: false })).toBe(false);
    expect(shouldHostBindDirectedUpdate({ ...directed, planMutates: false })).toBe(false);
    expect(shouldHostBindDirectedUpdate({ ...directed, comparisonUnknown: false })).toBe(false);
  });

  it("synthesizes 1:1 InputAsk slots from the retained stop code", () => {
    const slots = synthesizeEditorialInputAskSlots({
      code: EDITORIAL_SELECT_HOST_STOP_CODES.noChangeUnsupported,
      comparisonUnknown: true,
      sourceRoles: ["request"],
      planPages: ["docs/cli.md"],
      assessmentOnly: true,
    });
    expect(slots.map((slot) => slot.inputId)).toEqual([
      "comparison",
      "current-documentation",
      "public-contract",
      "prd",
      "accepted-decision",
    ]);
    expect(new Set(slots.map((slot) => slot.inputId)).size).toBe(slots.length);
    expect(
      slots.every((slot) => slot.code === EDITORIAL_SELECT_HOST_STOP_CODES.noChangeUnsupported),
    ).toBe(true);
  });

  it("never names a selection stop independent-rejection: no reviewer has run yet", () => {
    expect(
      editorialSelectErrorCode(new EditorialDecisionValidationError("independent-rejection")),
    ).toBe(EDITORIAL_SELECT_HOST_STOP_CODES.noChangeUnsupported);
    expect(editorialSelectErrorCode(new Error("x"))).toBe(
      EDITORIAL_SELECT_HOST_STOP_CODES.hostFailure,
    );
    expect(editorialSelectErrorCode(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      EDITORIAL_SELECT_HOST_STOP_CODES.hostFailure,
    );
    // A grammar-valid code on an untyped error is still not a contract refusal.
    expect(
      editorialSelectErrorCode(Object.assign(new Error("x"), { code: "independent-rejection" })),
    ).toBe(EDITORIAL_SELECT_HOST_STOP_CODES.hostFailure);
    expect(editorialSelectErrorCode("independent-rejection")).toBe(
      EDITORIAL_SELECT_HOST_STOP_CODES.hostFailure,
    );
  });

  it("keeps every typed contract refusal code at selection", () => {
    expect(
      editorialSelectErrorCode(new EditorialDecisionValidationError("evidence-unavailable")),
    ).toBe("evidence-unavailable");
    expect(
      editorialSelectErrorCode(new EditorialDecisionValidationError("identity-mismatch")),
    ).toBe("identity-mismatch");
    expect(editorialSelectErrorCode(new EditorialEvidenceHostError("conflicting-assessment"))).toBe(
      "conflicting-assessment",
    );
    expect(editorialSelectErrorCode(new ReaderContextValidationError("size-exceeded"))).toBe(
      "size-exceeded",
    );
    expect(editorialSelectErrorCode(new ArtifactStoreError("not-found", "/tmp/x"))).toBe(
      "not-found",
    );
    // Raised by the reader task context projection that selection calls.
    expect(editorialSelectErrorCode(new ReaderTaskContextError("identity-mismatch"))).toBe(
      "identity-mismatch",
    );
    // Raised by artifact reference and canonical JSON validation inside selection.
    expect(editorialSelectErrorCode(new ArtifactValidationError("invalid-json", "$"))).toBe(
      "invalid-json",
    );
  });

  it("names a typed error from outside selection's call graph a host failure", () => {
    // The run record store is never called by selection, so its typed code is not a selection refusal.
    expect(editorialSelectErrorCode(new FileRunStoreError("unsafe-root"))).toBe(
      EDITORIAL_SELECT_HOST_STOP_CODES.hostFailure,
    );
  });

  it("redacts a path-shaped planner summary without deleting why or label", () => {
    const summary = JSON.stringify({
      why: "The operator asked to update the guide",
      label: "Current documentation",
      path: "/Users/example/docs/cli.md",
      digest: "a".repeat(64),
    });
    const redacted = redactOperatorFacingSummaryV1(summary);
    expect(redacted).toContain('"why"');
    expect(redacted).toContain("The operator asked to update the guide");
    expect(redacted).toContain('"label"');
    expect(redacted).toContain("Current documentation");
    expect(redacted).not.toContain("/Users/example");
    expect(redacted).not.toContain("file://");
    expect(redacted).not.toMatch(/[a-f0-9]{64}/);
  });
});

describe("operator InputAsk honesty", () => {
  it(
    "host-binds a directed unknown-comparison update after admitting planned pages",
    async () => {
      const fixture = await repositoryFixture();
      const harness = new HonestyHarness({
        candidate: "update",
        impactSource: fixture.impactSource,
        mintIdentity: true,
      });
      const output: string[] = [];
      const log = console.log;
      console.log = (message?: unknown): void => {
        output.push(String(message));
      };
      let record;
      try {
        record = await executeRunRequest(
          {
            workflow: "update-documentation",
            repositoryPath: fixture.repository,
            revision: fixture.head,
            instruction: "Update docs/cli.md so it documents the current public option.",
            readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
            canonSnapshotPath: fixture.canonSnapshotPath,
            allowWrite: true,
            releaseGate: false,
            verbose: false,
            json: true,
            showScan: false,
          },
          fixture.config,
          { harness },
        );
      } finally {
        console.log = log;
      }

      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(harness.stepIds).toContain("write-documentation");
      expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("author");
      const decodeOptions = await loadSavedRunEditorialDecodeOptions(
        record!,
        fixture.config.stateDirectory,
      );
      const summary = formatRunSummary({
        record: record!,
        recordPath: defaultRunRecordPath(fixture.config.stateDirectory, record!.id),
        repositoryPath: fixture.repository,
        exitCode: 0,
        editorialDecodeOptions: decodeOptions,
      }).join("\n");
      const next = buildRunHumanNextCommand({
        record: record!,
        recordPath: defaultRunRecordPath(fixture.config.stateDirectory, record!.id),
        repositoryPath: fixture.repository,
        exitCode: 0,
        editorialDecodeOptions: decodeOptions,
      });
      expect(summary).not.toContain("docsfab doctor");
      expect(next?.command).not.toContain("docsfab doctor");
      expect(JSON.stringify(output)).not.toContain("docsfab doctor");
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it("retains the select rejection code as InputAsk slots with 1:1 inputId bindings", async () => {
    const fixture = await repositoryFixture();
    // The plan keeps a page the revision does not hold, so the host admits no
    // current documentation for it and refuses the no-change at selection (a
    // kept page with admitted evidence would be supported).
    const harness = new HonestyHarness({
      candidate: "no-change",
      planPage: "docs/absent.md",
      impactSource: fixture.impactSource,
      mintIdentity: true,
    });
    const output: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      output.push(String(message));
    };
    let record;
    try {
      record = await executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: fixture.repository,
          revision: fixture.head,
          instruction: "Assess whether docs/cli.md needs an update based on current behavior.",
          readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
          canonSnapshotPath: fixture.canonSnapshotPath,
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: true,
          showScan: false,
        },
        fixture.config,
        { harness },
      );
    } finally {
      console.log = log;
    }

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    expect(record?.changes).toBeUndefined();
    expect(record?.workflowBranchCoverage?.selection).toBeNull();
    const plan = record?.steps.find((step) => step.id === "plan-documentation");
    expect(plan?.status).toBe("needs-input");
    expect(selectStopCode(plan?.error)).toBe(EDITORIAL_SELECT_HOST_STOP_CODES.noChangeUnsupported);
    const findings = record?.workflowOutcome?.findings ?? [];
    const decisions = record?.workflowOutcome?.openDecisions ?? [];
    expect(record?.workflowOutcome?.disposition).toBe("needs-input");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.kind === "missing-governed-input")).toBe(true);
    expect(findings.map((finding) => finding.inputId).sort()).toEqual(
      decisions.map((decision) => decision.inputId).sort(),
    );
    expect(new Set(findings.map((finding) => finding.inputId)).size).toBe(findings.length);
    expect(findings.some((finding) => finding.inputId === "comparison")).toBe(true);
    expect(findings.every((finding) => finding.code.length > 0)).toBe(true);
    expect(harness.stepIds).not.toContain("write-documentation");
    const json = JSON.parse(output.at(-1) ?? "{}") as {
      product?: { disposition?: string };
      nextSteps?: string[];
      execution?: { exitCode?: number };
    };
    expect(json.product?.disposition).toBe("needs-input");
    expect(json.nextSteps?.join(" ")).toContain("InputAsk");
    expect(json.nextSteps?.join(" ")).not.toContain("docsfab doctor");
    const decodeOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(
      workflowOutcomeExitCode(record!, releaseGateWorkflowOutcomePolicy(), decodeOptions),
    ).toBe(2);
    const human = formatRunSummary({
      record: record!,
      recordPath: defaultRunRecordPath(fixture.config.stateDirectory, record!.id),
      repositoryPath: fixture.repository,
      exitCode: 2,
      editorialDecodeOptions: decodeOptions,
    }).join("\n");
    const product = human.slice(human.indexOf("PRODUCT"), human.indexOf("EDITORIAL"));
    expect(product).toContain("Product input:");
    expect(product).toContain("(comparison)");
    expect(product).not.toContain(fixture.repository);
    expect(product).not.toContain("file://");
    expect(product).not.toMatch(/[a-f0-9]{64}/);
    expect(human).not.toContain("docsfab doctor");
  }, 20_000);

  it("asks and does not host-bind update when write is not granted", async () => {
    const fixture = await repositoryFixture();
    const harness = new HonestyHarness({
      candidate: "no-change",
      planDisposition: "update",
      impactSource: fixture.impactSource,
      mintIdentity: true,
    });
    const record = await runUpdate(fixture, harness, {
      instruction: PILOT_INSTRUCTION,
      allowWrite: false,
    });

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    expect(record?.workflowBranchCoverage?.selection).toBeNull();
    expect(record?.workflowOutcome?.disposition).toBe("needs-input");
    const plan = record?.steps.find((step) => step.id === "plan-documentation");
    expect(selectStopCode(plan?.error)).toBe(EDITORIAL_SELECT_HOST_STOP_CODES.noChangeUnsupported);
    expect(askedInputIds(record)).toEqual(
      ["accepted-decision", "comparison", "prd", "public-contract"].sort(),
    );
  }, 20_000);
});

/** The pilot request: no update verb, write granted, comparison unknown. */
const PILOT_INSTRUCTION =
  "Bring the configuration page up to date with the current implementation. Correct the default sampling interval and document the environment variable used for the endpoint, while retaining the existing troubleshooting advice and its stable anchor. Keep unrelated documentation unchanged.";

describe("a declared update with write granted is a directed update", () => {
  it(
    "host-binds the pilot request that names no update verb",
    async () => {
      const fixture = await repositoryFixture();
      const harness = bindOnlyHarness(fixture);
      const record = await runUpdate(fixture, harness, {
        instruction: PILOT_INSTRUCTION,
        allowWrite: true,
        readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
      });

      // Checked first so a regression reports the selection stop it hit.
      const plan = record?.steps.find((step) => step.id === "plan-documentation");
      expect(plan?.error).toBeUndefined();
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("author");
      expect(harness.stepIds).toContain("write-documentation");
      expect(record?.steps.some((step) => step.error?.startsWith("editorial-select:"))).toBe(false);
      expect(
        (record?.workflowOutcome?.findings ?? []).filter(
          (finding) => finding.kind === "missing-governed-input",
        ),
      ).toEqual([]);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it.each([
    PILOT_INSTRUCTION,
    "Add the missing flag to docs/cli.md.",
    "Document the environment variable for the endpoint.",
    "Correct the default sampling interval.",
    "Make docs/cli.md match the current implementation.",
    "Assess whether docs/cli.md still matches the public option.",
  ])(
    "reaches the same outcome whatever the request says: %s",
    async (instruction) => {
      const fixture = await repositoryFixture();
      const harness = bindOnlyHarness(fixture);
      const record = await runUpdate(fixture, harness, {
        instruction,
        allowWrite: true,
        readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
      });

      expect(outcomeShape(record)).toEqual({
        status: "succeeded",
        branchId: "author",
        steps: (await authorPathStepIds()).map((stepId) => `${stepId}:succeeded`),
        planStopCode: undefined,
      });
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "does not bind a run whose admitted plan writes nothing, even with write granted",
    async () => {
      const fixture = await repositoryFixture();
      const harness = new HonestyHarness({
        candidate: "no-change",
        impactSource: fixture.impactSource,
        mintIdentity: true,
      });
      const record = await runUpdate(fixture, harness, {
        instruction: PILOT_INSTRUCTION,
        allowWrite: true,
      });

      // The host never binds an update for a plan that keeps every page. With
      // the kept page admitted as current documentation, the planner's own
      // no-change takes the read-only assessment path and writes nothing.
      const plan = record?.steps.find((step) => step.id === "plan-documentation");
      expect(plan?.error).toBeUndefined();
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("assess-no-change");
      expect(harness.stepIds).not.toContain("write-documentation");
      expect(record?.changes).toBeUndefined();
      expect(askedInputIds(record)).toEqual([]);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "keeps the planner's candidate when the comparison is known",
    async () => {
      const fixture = await repositoryFixture();
      const harness = bindOnlyHarness(fixture);
      const record = await runUpdate(fixture, harness, {
        instruction: PILOT_INSTRUCTION,
        allowWrite: true,
        readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
        comparisonRequest: {
          kind: "base-head",
          baseRevision: fixture.base,
          headRevision: fixture.head,
        },
      });

      // The planner's own no-change candidate reaches selection unbound. With the
      // commit comparison's current-documentation, public-contract, and
      // changed-source evidence admitted, it takes the read-only assessment
      // path; the conservative context does not rule it out.
      expect(outcomeShape(record)).toEqual({
        status: "succeeded",
        branchId: "assess-no-change",
        steps: [
          "plan-documentation:succeeded",
          "verify-technical-accuracy:succeeded",
          "review-documentation:succeeded",
          "test-audience-understanding:succeeded",
          "evaluate-document-quality:succeeded",
        ],
        planStopCode: undefined,
      });
      expect(harness.stepIds).not.toContain("write-documentation");
      expect(record?.changes).toBeUndefined();
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it("does not bind when the planned page has no admitted current documentation", async () => {
    const fixture = await repositoryFixture();
    const harness = bindOnlyHarness(fixture, "docs/absent.md");
    const record = await runUpdate(fixture, harness, {
      instruction: PILOT_INSTRUCTION,
      allowWrite: true,
      readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
    });

    // The planner's own no-change candidate reaches selection unbound and is refused there.
    expect(outcomeShape(record)).toEqual({
      status: "needs-input",
      branchId: undefined,
      steps: ["plan-documentation:needs-input"],
      planStopCode: EDITORIAL_SELECT_HOST_STOP_CODES.noChangeUnsupported,
    });
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    // The premise of this case: the planned page was never admitted as current documentation.
    expect(askedInputIds(record)).toContain("current-documentation");
  }, 20_000);
});

describe("selection stop codes at the shipped catch", () => {
  type Projection = (input: {
    admission: { workspaceSnapshotSha256: string } & Record<string, unknown>;
  }) => unknown;

  it("keeps the reader task context refusal the real projection raises during selection", async () => {
    const fixture = await repositoryFixture();
    const harness = bindOnlyHarness(fixture);
    const select = EditorialEvidenceHostV1.prototype.select;
    const thrown: unknown[] = [];
    const spy = vi
      .spyOn(EditorialEvidenceHostV1.prototype, "select")
      .mockImplementation(async function (this: EditorialEvidenceHostV1, input) {
        // Drive the host's real projection with an admission whose comparison
        // drifted from the provenance, so the real supplier refuses it.
        const options = (
          this as unknown as { options: { projectCompletedReaderTaskContext: Projection } }
        ).options;
        const project = options.projectCompletedReaderTaskContext;
        options.projectCompletedReaderTaskContext = (projection) => {
          try {
            return project({
              ...projection,
              admission: {
                ...projection.admission,
                comparison: {
                  kind: "workspace",
                  snapshot_sha256: projection.admission.workspaceSnapshotSha256,
                },
              },
            });
          } catch (error) {
            thrown.push(error);
            throw error;
          }
        };
        return select.call(this, input);
      });
    const record = await runUpdate(fixture, harness, {
      instruction: PILOT_INSTRUCTION,
      allowWrite: true,
      readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toBeInstanceOf(ReaderTaskContextError);
    expect((thrown[0] as ReaderTaskContextError).code).toBe("identity-mismatch");
    expect(outcomeShape(record)).toEqual({
      status: "needs-input",
      branchId: undefined,
      steps: ["plan-documentation:needs-input"],
      planStopCode: "identity-mismatch",
    });
  }, 20_000);

  it.each([
    {
      name: "an artifact validation refusal keeps its code",
      error: new ArtifactValidationError("invalid-json", "$"),
      code: "invalid-json",
    },
    {
      // Adjacent condition: a typed error selection never raises is not a refusal.
      name: "a run store error is a host failure",
      error: new FileRunStoreError("unsafe-root"),
      code: EDITORIAL_SELECT_HOST_STOP_CODES.hostFailure,
    },
  ])(
    "$name",
    async ({ error, code }) => {
      const fixture = await repositoryFixture();
      const harness = bindOnlyHarness(fixture);
      const spy = vi.spyOn(EditorialEvidenceHostV1.prototype, "select").mockRejectedValue(error);
      const record = await runUpdate(fixture, harness, {
        instruction: PILOT_INSTRUCTION,
        allowWrite: true,
        readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(outcomeShape(record)).toEqual({
        status: "needs-input",
        branchId: undefined,
        steps: ["plan-documentation:needs-input"],
        planStopCode: code,
      });
    },
    20_000,
  );
});

/** Prefix steps plus the `author` branch, read from the shipped workflow manifest. */
async function authorPathStepIds(): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(new URL("../workflows/update-documentation.json", import.meta.url), "utf8"),
  ) as {
    prefix: { steps: { id: string }[] };
    branches: { id: string; steps: { id: string }[] }[];
  };
  const author = manifest.branches.find((branch) => branch.id === "author");
  if (!author) throw new Error("update-documentation has no author branch");
  return [...manifest.prefix.steps, ...author.steps].map((step) => step.id);
}

const SELECT_STOP = /^editorial-select:([a-z0-9.-]+):[a-f0-9]{64}$/u;

function selectStopCode(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  const match = SELECT_STOP.exec(error);
  if (!match) throw new Error(`plan step error is not an editorial-select stop: ${error}`);
  return match[1];
}

function askedInputIds(record: RunRecord | undefined): string[] {
  return (record?.workflowOutcome?.findings ?? [])
    .filter((finding) => finding.kind === "missing-governed-input")
    .map((finding) => finding.inputId ?? "")
    .sort();
}

function outcomeShape(record: RunRecord | undefined) {
  return {
    status: record?.status,
    branchId: record?.workflowBranchCoverage?.selection?.branchId,
    steps: (record?.steps ?? []).map((step) => `${step.id}:${step.status}`),
    planStopCode: selectStopCode(
      record?.steps.find((step) => step.id === "plan-documentation")?.error,
    ),
  };
}

/**
 * A mutating plan with a planner `no-change` proposal: the run reaches the
 * author branch only if the host binds the directed update.
 */
function bindOnlyHarness(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  planPage?: string,
): HonestyHarness {
  return new HonestyHarness({
    candidate: "no-change",
    planDisposition: "update",
    ...(planPage ? { planPage } : {}),
    impactSource: fixture.impactSource,
    mintIdentity: true,
  });
}

type RunRequestInput = Parameters<typeof executeRunRequest>[0];

async function runUpdate(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  harness: HonestyHarness,
  input: Pick<RunRequestInput, "instruction" | "allowWrite"> &
    Partial<Pick<RunRequestInput, "readerSources" | "comparisonRequest">>,
): Promise<RunRecord | undefined> {
  return executeRunRequest(
    {
      workflow: "update-documentation",
      repositoryPath: fixture.repository,
      revision: fixture.head,
      canonSnapshotPath: fixture.canonSnapshotPath,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      ...input,
    },
    fixture.config,
    { silent: true, harness },
  );
}

class HonestyHarness implements AgentHarness {
  public readonly inputs: HarnessStepInput[] = [];

  public constructor(
    private readonly options: {
      candidate: "update" | "no-change";
      /** Plan disposition, separate from the proposal so a host bind is observable. */
      planDisposition?: "update" | "retain";
      planPage?: string;
      impactSource: { uri: string; sha256: string };
      mintIdentity: boolean;
    },
  ) {}

  public get stepIds(): string[] {
    return this.inputs.map((input) => input.step.id);
  }

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.inputs.push(input);
    const admitted =
      input.step.id === "plan-documentation"
        ? input.editorialEvidenceRefs?.[0]
        : editorialAssessmentEvidenceRefsV1(input)[0];
    if (!admitted) throw new Error("missing admitted reader evidence");
    const reference = this.options.mintIdentity
      ? { ...admitted, digest: "a".repeat(64) }
      : admitted;
    if (input.step.id === "plan-documentation") {
      const update = this.options.candidate === "update";
      const planUpdates =
        (this.options.planDisposition ?? (update ? "update" : "retain")) === "update";
      const planPage = this.options.planPage ?? "docs/cli.md";
      return {
        summary: update
          ? "The changed public option requires one documentation update."
          : "The admitted comparison shows no reader-visible documentation change.",
        planBinding: bindDocumentationPlanProposal(
          {
            mode: "update",
            pages: [{ path: planPage, disposition: planUpdates ? "update" : "retain" }],
            sourceBindings: planUpdates ? [{ pagePath: planPage, sources: ["src/orbit.ts"] }] : [],
          },
          { expectedMode: "update" },
        ),
        editorialDecisionProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-decision-proposal",
          candidate: this.options.candidate,
          rationale: update
            ? "The admitted public source changed from --old to --new while the guide still says --old."
            : "The admitted source comparison preserves the documented public behavior.",
          evidenceRefs: [reference],
          limitations: [],
          impactBasis: {
            kind: update ? "public-behavior-change" : "none",
            rationale: update
              ? "The public option source and current documentation disagree."
              : "The changed implementation preserves the current documented behavior.",
            evidence_refs: [this.options.impactSource],
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
          evidenceRefs: [admitted],
          limitations: ["audience-check-unavailable"],
          recommendation: null,
        },
      };
    }
    if (
      input.step.id === "verify-technical-accuracy" ||
      input.step.id === "review-documentation" ||
      input.step.id === "evaluate-document-quality"
    ) {
      return {
        summary:
          input.step.id === "review-documentation"
            ? JSON.stringify({ verdict: "pass", issues: [] })
            : `${input.step.id} accepted the source-bound candidate.`,
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
          evidenceRefs: [admitted],
          limitations: [],
          recommendation: null,
        },
      };
    }
    return {
      summary: `${input.step.id} completed its deterministic check.`,
      ...(input.step.id === "derive-source-obligations" ? await verificationFixture(input) : {}),
    };
  }
}

async function repositoryFixture() {
  const fixture = await orbitOptionChangeRepository("docsfab-input-honesty", temporaryDirectories);
  return {
    ...fixture,
    impactSource: await observePublicContract(fixture.repository, fixture.head),
  };
}

describe("PRODUCT labels stay free of host paths", () => {
  it("keeps why and label after redacting a path-shaped needs-input summary", () => {
    const valueRecord: RunRecord = {
      schemaVersion: 2 as const,
      id: "run-honesty-product",
      workflow: "update-documentation" as const,
      repository: {
        sourcePath: "/tmp/example",
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
      },
      workspace: { strategy: "tracked-export" as const, disposable: true as const },
      status: "needs-input" as const,
      createdAt: "2026-09-16T12:00:00Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "plan-documentation",
          title: "Plan documentation",
          skill: "plan-documentation",
          mode: "read-only" as const,
          status: "needs-input" as const,
          summary: JSON.stringify({
            why: "Need an admitted public contract",
            label: "Public contract",
            path: "/Users/example/src/orbit.ts",
          }),
        },
      ],
    };
    const evidence = workflowOutcomeStepEvidence(valueRecord, "plan-documentation");
    valueRecord.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "needs-input",
        findings: [
          {
            id: "finding:editorial:public-contract",
            kind: "missing-governed-input",
            severity: "warning",
            code: "independent-rejection",
            inputId: "public-contract",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:editorial:public-contract",
            kind: "governed-input",
            inputId: "public-contract",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      },
      valueRecord,
    );
    const context = {
      record: valueRecord,
      recordPath: "/tmp/state/run-honesty-product.json",
      repositoryPath: "/tmp/example",
      exitCode: 2 as const,
    };
    const human = formatRunSummary(context).join("\n");
    const json = collectRunResultNextSteps(context).join("\n");
    const next = buildRunHumanNextCommand(context);
    const product = human.slice(human.indexOf("PRODUCT"), human.indexOf("EDITORIAL"));
    expect(product).toContain("Public contract");
    expect(product).toContain("(path)");
    expect(product).toContain("Need an admitted public contract");
    expect(product).not.toContain("/Users/example");
    expect(product).not.toMatch(/[a-f0-9]{64}/);
    expect(next?.command).toBe("docsfab do --continue run-honesty-product");
    expect(next?.command).not.toContain("docsfab doctor");
    expect(json).not.toContain("docsfab doctor");
    expect(json).toContain("Public contract (path)");
  });
});
