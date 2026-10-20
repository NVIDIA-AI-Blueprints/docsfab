// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  InferenceStepError,
  type HarnessStepInput,
  type InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import { admitPlannerReply } from "../src/harness/reply-admission/planner.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import {
  classifyInferenceAttempt,
  classifyThrownFailure,
} from "../src/operator/failure-classification.js";
import {
  bindDocumentationPlanProposal,
  DocumentationPlanBindingError,
  validateDocumentationPlanBinding,
  type DocumentationPlanMode,
} from "../src/workflow-execution/plan-binding.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  assertSourceObligationSourceAuthority,
  SourceObligationSourceReferenceError,
  sourceReferencePath,
} from "../src/workflow-execution/source-obligation.js";

/**
 * Documentation-plan admission and source-obligation derivation read a plan's
 * source locators through one grammar, so a planner cannot admit
 * `<path>@<revision>:<lines>` locators that derivation then refuses,
 * terminally and as `unknown`.
 */

/** The revision of the recorded run. */
const REVISION = "0bd6fa60ceefdf49d8b92fb760d446cda3434761";
const OTHER_REVISION = "1".repeat(40);
const LONG_REVISION = "2".repeat(64);

/** The recorded run's admitted sources, verbatim. */
const RECORDED_SOURCES = [
  `docs/guide.md@${REVISION}:1-28`,
  `docs/quickstart.md@${REVISION}:1-22`,
  `README.md@${REVISION}:1-9`,
  `src/sprout.mjs@${REVISION}`,
] as const;
/** The recorded run's sealed plan digest, over those exact bytes. */
const RECORDED_DIGEST = "57f19ab4496ded55461ed029c4537a2884e5d2da3462b7fd52cfdf0dea8951b9";
const PAGE = "docs/cli-reference.md";

function plannerInput(workflow: string, revision = REVISION): HarnessStepInput {
  return {
    workflow: { name: workflow, schemaVersion: 1, steps: [] },
    step: { id: "plan-documentation", skill: "plan-documentation", mode: "read-only" },
    evidenceIdentity: { repositoryRevision: revision },
  } as unknown as HarnessStepInput;
}

function plannerReply(mode: DocumentationPlanMode, sources: readonly string[]): string {
  return JSON.stringify({
    summary: "Plan one CLI reference page from the guide and the CLI source.",
    planBinding: {
      mode,
      pages: [{ path: PAGE, disposition: mode === "restructure" ? "restructure" : mode }],
      sourceBindings: [{ pagePath: PAGE, sources }],
    },
  });
}

/** The planner step's real reply admission. */
function admitPlan(workflow: string, mode: DocumentationPlanMode, sources: readonly string[]) {
  const reply = plannerReply(mode, sources);
  return admitPlannerReply(plannerInput(workflow), reply, {
    decodedResponse: reply,
    collectAttemptEvidence: () => ({}),
    refuseContractPlaceholder: () => undefined,
  });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("plan source locator grammar (#1370)", () => {
  it("admits the recorded planner locators canonically and derivation resolves every one", () => {
    const admission = admitPlan("create-documentation", "create", RECORDED_SOURCES);
    expect(admission?.outcome).toBe("completed");
    const planBinding = admission?.outcome === "completed" ? admission.planBinding : undefined;
    expect(planBinding?.sourceBindings).toEqual([
      {
        pagePath: PAGE,
        sources: [
          `docs/guide.md:1-28@${REVISION}`,
          `docs/quickstart.md:1-22@${REVISION}`,
          `README.md:1-9@${REVISION}`,
          `src/sprout.mjs@${REVISION}`,
        ],
      },
    ]);
    // The step derivation runs before its model turn, over the admitted plan.
    expect(
      assertSourceObligationSourceAuthority({
        workflow: { name: "create-documentation" } as HarnessStepInput["workflow"],
        planBinding: planBinding!,
        evidenceIdentity: { repositoryRevision: REVISION },
      }),
    ).toEqual(["README.md", "docs/guide.md", "docs/quickstart.md", "src/sprout.mjs"]);

    // A recorded run's sealed binding still reads under its recorded digest,
    // and derivation resolves it instead of stopping the run.
    const sealed = validateDocumentationPlanBinding({
      kind: "docsfab-documentation-plan",
      schemaVersion: 1,
      mode: "create",
      pages: [{ path: PAGE, disposition: "create" }],
      sourceBindings: [{ pagePath: PAGE, sources: [...RECORDED_SOURCES] }],
      digest: RECORDED_DIGEST,
    });
    expect(sealed.sourceBindings[0]!.sources).toEqual(
      [...RECORDED_SOURCES].sort((left, right) => left.localeCompare(right)),
    );
    expect(
      assertSourceObligationSourceAuthority({
        workflow: { name: "create-documentation" } as HarnessStepInput["workflow"],
        planBinding: sealed,
        evidenceIdentity: { repositoryRevision: REVISION },
      }),
    ).toEqual(["README.md", "docs/guide.md", "docs/quickstart.md", "src/sprout.mjs"]);
  });

  /**
   * Drift guard: for every form, plan admission and derivation agree on
   * whether it is admitted, on the path it names, and on why it is refused.
   * `path` is the derivation's path; `refusal` its recorded refusal code.
   */
  const FORMS: ReadonlyArray<{
    readonly source: string;
    readonly path?: string;
    readonly refusal?: "invalid-reference" | "revision-mismatch";
  }> = [
    { source: "src/sprout.mjs", path: "src/sprout.mjs" },
    { source: `src/sprout.mjs@${REVISION}`, path: "src/sprout.mjs" },
    { source: `README.md:9@${REVISION}`, path: "README.md" },
    { source: `docs/guide.md:1-28@${REVISION}`, path: "docs/guide.md" },
    { source: `docs/guide.md#install@${REVISION}`, path: "docs/guide.md" },
    { source: `docs/guide.md@${REVISION}:1-28`, path: "docs/guide.md" },
    { source: `docs/guide.md@${REVISION}:9`, path: "docs/guide.md" },
    { source: `docs/guide.md@${REVISION}#install`, path: "docs/guide.md" },
    { source: "docs/guide.md:1-28", path: "docs/guide.md" },
    { source: `git:${REVISION}:docs/guide.md`, path: "docs/guide.md" },
    { source: `git:${REVISION}:docs/guide.md:1-28`, path: "docs/guide.md" },
    { source: "src/sprout.mjs@HEAD", refusal: "invalid-reference" },
    { source: "src/sprout.mjs@0bd6fa6", refusal: "invalid-reference" },
    { source: `docs/guide.md@${REVISION}@${REVISION}`, refusal: "invalid-reference" },
    { source: `docs/guide.md@${REVISION} lines 1-28`, refusal: "invalid-reference" },
    { source: `docs/guide.md@${REVISION}:0`, refusal: "invalid-reference" },
    { source: `docs/guide.md@${REVISION}:28-1`, refusal: "invalid-reference" },
    { source: `git:${REVISION}:docs/guide.md@${REVISION}`, refusal: "invalid-reference" },
    { source: "https://example.com/docs/guide.md", refusal: "invalid-reference" },
    { source: "../outside.md", refusal: "invalid-reference" },
    { source: "/etc/hosts", refusal: "invalid-reference" },
    { source: "src/**/*.ts", refusal: "invalid-reference" },
    { source: "the CLI help output", refusal: "invalid-reference" },
    { source: `src/sprout.mjs@${OTHER_REVISION}`, refusal: "revision-mismatch" },
    { source: `src/sprout.mjs@${OTHER_REVISION}:1-9`, refusal: "revision-mismatch" },
    { source: `src/sprout.mjs@${LONG_REVISION}`, refusal: "revision-mismatch" },
    { source: `git:${OTHER_REVISION}:src/sprout.mjs`, refusal: "revision-mismatch" },
  ];

  const derivation = (source: string) => {
    try {
      return { path: sourceReferencePath(source, REVISION) };
    } catch (error) {
      expect(error).toBeInstanceOf(SourceObligationSourceReferenceError);
      return { refusal: (error as SourceObligationSourceReferenceError).code };
    }
  };
  const admission = (mode: DocumentationPlanMode, source: string) => {
    try {
      const binding = bindDocumentationPlanProposal(
        {
          mode,
          pages: [{ path: PAGE, disposition: mode === "restructure" ? "restructure" : mode }],
          sourceBindings: [{ pagePath: PAGE, sources: [source] }],
        },
        { expectedMode: mode, expectedRevision: REVISION },
      );
      return { source: binding.sourceBindings[0]!.sources[0]! };
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentationPlanBindingError);
      return { rejection: (error as DocumentationPlanBindingError).rejection?.code };
    }
  };

  it.each(
    FORMS.flatMap((form) =>
      (["create", "restructure"] as const).map((mode) => [mode, form.source, form] as const),
    ),
  )("%s admission and derivation agree on %s", (mode, source, form) => {
    const derived = derivation(source);
    expect(derived).toEqual(form.path ? { path: form.path } : { refusal: form.refusal });
    const admitted = admission(mode, source);
    if (form.path) {
      // The admitted canonical spelling names the same file to derivation.
      expect(admitted.source).toBeDefined();
      expect(derivation(admitted.source!)).toEqual({ path: form.path });
    } else {
      expect(admitted).toEqual({
        rejection:
          form.refusal === "revision-mismatch"
            ? "plan-source-locator-revision-mismatch"
            : "plan-source-locator-grammar",
      });
    }
  });

  it("leaves UPDATE plan sources as evidence text, which the host never resolves", () => {
    const binding = bindDocumentationPlanProposal(
      {
        mode: "update",
        pages: [{ path: PAGE, disposition: "update" }],
        sourceBindings: [{ pagePath: PAGE, sources: ["the CLI help output", "src/cli.ts@HEAD"] }],
      },
      { expectedMode: "update", expectedRevision: REVISION },
    );
    expect(binding.sourceBindings[0]!.sources).toEqual(["src/cli.ts@HEAD", "the CLI help output"]);
  });

  it("refuses an unresolvable locator at planner admission as correctable model content with the grammar as its retry hint", async () => {
    const bad = plannerReply("create", [`docs/guide.md@${REVISION}:1-28`, "src/sprout.mjs@HEAD"]);
    const good = plannerReply("create", [`docs/guide.md:1-28@${REVISION}`, "src/sprout.mjs"]);
    const corrections: string[] = [];
    const policy: InferenceRetryPolicy = {
      maxRetries: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: ["malformed-response"],
    };
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => undefined,
      execute: async (attempt, correction) => {
        corrections.push(responseCorrectionInstruction(correction));
        const reply = attempt === 1 ? bad : good;
        const admitted = admitPlannerReply(plannerInput("create-documentation"), reply, {
          decodedResponse: reply,
          collectAttemptEvidence: () => ({}),
          refuseContractPlaceholder: () => undefined,
        });
        return { summary: admitted?.summary ?? "", skill: { id: "plan-documentation" } } as never;
      },
    });

    expect(execution.status).toBe("succeeded");
    const refused = execution.evidence.attempts[0]!;
    expect(refused.rejection).toEqual({
      code: "plan-source-locator-grammar",
      location: "$.planBinding.sourceBindings[].sources[]",
    });
    expect(refused.retryScheduled).toBe(true);
    expect(classifyInferenceAttempt(refused)).toMatchObject({
      class: "model-content",
      code: "plan-source-locator-grammar",
    });
    // The retry states the rule, naming each accepted part of a locator.
    expect(corrections[0]).toBe("");
    expect(corrections[1]).toContain(
      "failed host rule plan-source-locator-grammar at $.planBinding.sourceBindings[].sources[]",
    );
    for (const part of [":line", ":start-end", "#section", "host-supplied repository revision"]) {
      expect(corrections[1]).toContain(part);
    }
    expect(corrections[1]).not.toContain("has no specific repair hint");
  });

  it("refuses a source at another revision at planner admission, not at derivation", () => {
    const error = thrown(() =>
      admitPlan("create-documentation", "create", [`src/sprout.mjs@${OTHER_REVISION}`]),
    );
    expect(error).toBeInstanceOf(InferenceStepError);
    const failure = error as InferenceStepError;
    expect(failure.retryable).toBe(true);
    expect(failure.category).toBe("malformed-response");
    expect(failure.rejection).toEqual({
      code: "plan-source-locator-revision-mismatch",
      location: "$.planBinding.sourceBindings[].sources[]",
    });
    expect(classifyThrownFailure(failure, "workflow")).toMatchObject({
      class: "model-content",
      code: "plan-source-locator-revision-mismatch",
    });
    expect(responseCorrectionInstruction({ rejection: failure.rejection })).toContain(
      "exactly the host-supplied repository revision",
    );
  });
});
