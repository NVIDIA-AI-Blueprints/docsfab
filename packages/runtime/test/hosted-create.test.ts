// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validateAuthoringRunRecordV1 } from "../src/records/authoring-execution.js";
import { FileRunStore } from "../src/records/file-store.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import {
  sealHostRuntimeTerminal,
  parseHostRuntimeTerminalWire,
} from "../src/host-invoker/contracts.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  createHostedCreateFixture,
  controlledHostedCreateHarness as controlledHarness,
  HOSTED_CREATE_TARGET as target,
  HOSTED_CREATE_PAGE as page,
} from "./helpers/hosted-create.js";

const fixtures: Awaited<ReturnType<typeof createHostedCreateFixture>>[] = [];
/** `git hash-object` of "# Older guide\n": a grant issued before the page last changed. */
const STALE_PREIMAGE = "c3cb8da9db5b3fe4bc50afbbede252fec60ae0cf";
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function fixture() {
  const f = await createHostedCreateFixture();
  fixtures.push(f);
  return f;
}

describe("hosted CREATE V3 assembly", () => {
  it("runs the real candidate lifecycle and transfers only its selected scoped patch", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const f = await fixture(),
      controlled = controlledHarness(f.request);
    const result = await runHostedWorkflow({
      request: f.request,
      credential: null,
      emit() {},
      executionHarness: controlled.harness,
      instruction: "Create the Foundation-bound intended page docs/new-guide.md.",
    });
    expect(
      controlled.calls.every(
        (call) =>
          call.instruction === "Create the Foundation-bound intended page docs/new-guide.md.",
      ),
    ).toBe(true);
    expect(
      controlled.calls.every(
        (call) =>
          JSON.stringify(call.toolCeiling) === JSON.stringify(f.request.composition.declaredTools),
      ),
    ).toBe(true);
    expect(result.record.status, result.record.error).toBe("succeeded");
    expect(() =>
      validateAuthoringRunRecordV1(result.record, getWorkflow("create-documentation"), {
        requireTerminalSuccess: true,
      }),
    ).not.toThrow();
    expect(result.record.authoringExecution?.selectedCandidate?.ordinal).toBe(0);
    expect(result.record.authoringExecution?.finalPatch?.candidateOrdinal).toBe(0);
    expect(result.record.changes?.files.map((file) => file.path)).toEqual([target]);
    expect(result.record.impactPostflight?.status).toBe("completed");
    const finalTechnical = result.record.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    const citations = finalTechnical.searchEvidence!.searches.flatMap((search) =>
      search.bounded.probes.flatMap((probe) => probe.citations.map((citation) => citation.path)),
    );
    expect(citations).toContain(target);
    expect(finalTechnical.technicalCorrectionEvidence?.schemaVersion).toBe(3);

    expect(result.patchEvidence?.changes.map((change) => change.path)).toEqual([target]);
    expect(await readFile(join(f.outer, target), "utf8")).toBe(page);
    expect((await f.git(["status", "--porcelain"])).stdout).toBe("");
    expect(
      controlled.calls.find((call) => call.step.id === "write-documentation")!.repositoryPath,
    ).not.toBe(f.outer);
    const lint = JSON.parse(
      result.record.steps.find((step) => step.id === "lint-documentation")!.summary!,
    );
    if (process.platform === "linux") expect(lint.status, JSON.stringify(lint)).toBe("passed");
    else expect(lint.status).toBe("unavailable");
    expect(result.record.workflowOutcome?.disposition).toBe("inconclusive");
    const retained = await new FileRunStore(f.state).get(f.request.runId);
    expect(retained).toEqual(JSON.parse(JSON.stringify(result.record)));
    const terminal = sealHostRuntimeTerminal({
      request: f.request,
      status: "succeeded",
      runtimeRecord: result.record,
      patch: result.patch,
      patchEvidence: result.patchEvidence,
      editorialOutcome: result.editorialOutcome,
    });
    expect(
      parseHostRuntimeTerminalWire(JSON.parse(JSON.stringify(terminal)), f.request).status,
    ).toBe("succeeded");
    // Valid terminal transport admits the canonical selected branch, not an
    // arbitrary catalog subset or a worker-asserted candidate pointer.
    const missingPhase = structuredClone(result.record);
    missingPhase.steps = missingPhase.steps.filter((step) => step.id !== "lint-documentation");
    const reordered = structuredClone(result.record);
    reordered.steps.reverse();
    const missingClosure = structuredClone(result.record);
    delete missingClosure.authoringExecution;
    const forgedSelection = structuredClone(result.record);
    forgedSelection.authoringExecution = {
      ...forgedSelection.authoringExecution!,
      selectedCandidate: { ...forgedSelection.authoringExecution!.selectedCandidate!, ordinal: 1 },
    };
    for (const invalid of [missingPhase, reordered, missingClosure, forgedSelection]) {
      expect(() =>
        sealHostRuntimeTerminal({
          request: f.request,
          status: "succeeded",
          runtimeRecord: invalid,
          patch: result.patch,
          patchEvidence: result.patchEvidence,
          editorialOutcome: result.editorialOutcome,
        }),
      ).toThrow(expect.objectContaining({ code: "terminal-step-substitution" }));
    }
  });
  it.each([
    ["has no target for it", {}],
    [
      "binds its modify target to other content",
      {
        grantTargets: [
          { path: target, operations: ["modify" as const], preimageObjectId: STALE_PREIMAGE },
        ],
      },
    ],
    [
      "lets it only delete the page",
      { grantTargets: [{ path: target, operations: ["delete" as const] }] },
    ],
    [
      "lets it modify only another path with the same content",
      {
        sourceFiles: { "docs/twin-guide.md": "# Old guide\n" },
        grantTargets: [{ path: "docs/twin-guide.md", operations: ["modify" as const] }],
      },
    ],
  ])(
    "refuses a CREATE onto an existing page at plan admission when the write grant %s",
    {
      timeout: testTimeoutMs(120_000),
    },
    async (_name, grant) => {
      const f = await createHostedCreateFixture({
        ...grant,
        sourceFiles: { [target]: "# Old guide\n", ...grant.sourceFiles },
      });
      fixtures.push(f);
      const controlled = controlledHarness(f.request);
      const result = await runHostedWorkflow({
        request: f.request,
        credential: null,
        emit() {},
        executionHarness: controlled.harness,
        instruction: "Create the Foundation-bound intended page docs/new-guide.md.",
      });
      // Refused before any write, not after spending the run on a patch the
      // terminal would reject as a scope escape.
      expect(result.record.status).toBe("failed");
      const planner = result.record.steps.find((step) => step.id === "plan-documentation")!;
      expect(planner.failure).toEqual({
        class: "planning-refusal",
        layer: "workflow",
        code: "create-target-exists",
      });
      expect(planner.error).toContain(
        `(${target} exists, and the run's write grant does not cover modifying it)`,
      );
      expect(controlled.calls.map((call) => call.step.id)).toEqual(["plan-documentation"]);
      expect(await readFile(join(f.outer, target), "utf8")).toBe("# Old guide\n");
    },
  );

  it("converts a CREATE onto an existing page the write grant lets it modify, through terminal", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const f = await createHostedCreateFixture({
      sourceFiles: { [target]: "# Old guide\n" },
      grantTargets: [{ path: target, operations: ["modify"] }],
    });
    fixtures.push(f);
    const controlled = controlledHarness(f.request);
    const result = await runHostedWorkflow({
      request: f.request,
      credential: null,
      emit() {},
      executionHarness: controlled.harness,
      instruction: "Create the Foundation-bound intended page docs/new-guide.md.",
    });
    expect(result.record.status, result.record.error).toBe("succeeded");
    const planner = result.record.steps.find((step) => step.id === "plan-documentation")!;
    expect(planner.planBinding?.createConvertedToUpdate).toMatchObject({
      reason: "create-target-exists",
      path: target,
    });
    expect(result.patchEvidence?.changes).toEqual([
      expect.objectContaining({ path: target, operation: "modify" }),
    ]);
    expect(await readFile(join(f.outer, target), "utf8")).toBe(page);
    const terminal = sealHostRuntimeTerminal({
      request: f.request,
      status: "succeeded",
      runtimeRecord: result.record,
      patch: result.patch,
      patchEvidence: result.patchEvidence,
      editorialOutcome: result.editorialOutcome,
    });
    expect(
      parseHostRuntimeTerminalWire(JSON.parse(JSON.stringify(terminal)), f.request).status,
    ).toBe("succeeded");
  });

  it.each([
    { planPath: "outside/new.md" },
    { sourceRevision: "f".repeat(40) },
    { mutateSource: true },
    { forgeCorrection: true },
  ])(
    "refuses unbound source, scope, or correction authority before patch transfer %j",
    { timeout: testTimeoutMs(120_000) },
    async (options) => {
      const f = await fixture(),
        controlled = controlledHarness(f.request, options);
      const result = await runHostedWorkflow({
        request: f.request,
        credential: null,
        emit() {},
        executionHarness: controlled.harness,
      });
      expect(result.record.status).toBe("failed");
      expect(result.patch).toBeNull();
      expect((await f.git(["status", "--porcelain"], f.outer)).stdout).toBe("");
      if (!options.mutateSource && !options.forgeCorrection)
        expect(controlled.calls.some((call) => call.step.mode === "write")).toBe(false);
    },
  );
  it.skipIf(process.platform !== "linux")(
    "retains a failed real candidate check without claiming document readiness",
    { timeout: testTimeoutMs(120_000) },
    async () => {
      const f = await fixture(),
        controlled = controlledHarness(f.request, { failCheck: true });
      const result = await runHostedWorkflow({
        request: f.request,
        credential: null,
        emit() {},
        executionHarness: controlled.harness,
      });
      const lint = JSON.parse(
        result.record.steps.find((step) => step.id === "lint-documentation")!.summary!,
      );
      expect(lint.status, JSON.stringify(lint)).toBe("failed");
      expect(
        lint.checks.some(
          (check: { exitCode?: number }) => check.exitCode !== undefined && check.exitCode !== 0,
        ),
      ).toBe(true);
      expect(result.record.workflowOutcome?.disposition).toBe("inconclusive");
      expect(result.record.authoringExecution?.selectedProducers?.lint.summarySha256).toBeTruthy();
    },
  );
});
