// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A CREATE planner that proposes its plan as an UPDATE of pages the run's
 * revision already holds is admitted as the CREATE of those pages, for plan
 * admission to convert; a proposal that names a page the revision does not
 * hold is refused exactly as a `mode: "update"` CREATE plan always was. Each
 * case runs the real `PiHarness` planner step against a scripted provider.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import { createModelConnection } from "../src/model/provider.js";
import {
  createDocumentationPlanBinding,
  createProposalFromProposedUpdate,
  documentationPlanBindingDigest,
  validateDocumentationPlanBinding,
} from "../src/workflow-execution/plan-binding.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { nestedDeadlineMs } from "./helpers/test-timeouts.js";
import { scriptedProvider, textTurn } from "./support/execution-convergence.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const temporaryDirectories: string[] = [];
const PAGE = "docs/routing/guide.md";
const OTHER = "docs/routing/reference.md";

afterAll(async () => {
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});

/** A CREATE planner reply whose plan says UPDATE outright. */
function proposedUpdateReply(
  pages = [{ path: PAGE, disposition: "update" }],
  sources = ["README.md"],
  mode = "update",
): string {
  return JSON.stringify({
    summary: "Update the routing guide stub with the source-grounded task guide.",
    planBinding: {
      mode,
      pages,
      sourceBindings: pages
        .filter((page) => page.disposition !== "retain" && page.disposition !== "out-of-scope")
        .map((page) => ({ pagePath: page.path, sources })),
    },
  });
}

async function plannerStep(
  reply: string,
  planTargetExistence?: HarnessStepInput["planTargetExistence"],
) {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-proposed-update-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
  // A contract correction re-asks, so every attempt gets the same reply.
  vi.stubGlobal("fetch", scriptedProvider([textTurn(reply), textTurn(reply), textTurn(reply)]));
  try {
    const harness = new PiHarness({
      skillCrateDirectory,
      model: validModelConfig,
      createConnection: createModelConnection,
    });
    const workflow = getWorkflow("create-documentation");
    return await harness
      .runStep({
        runId: "planner-proposed-update",
        repositoryPath,
        workflow,
        step: workflow.steps.find((step) => step.id === "plan-documentation")!,
        evidenceIdentity: { repositoryRevision: "a".repeat(40) },
        ...(planTargetExistence ? { planTargetExistence } : {}),
      })
      .then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The refusal's recorded fields; a parity check compares all of them. */
function refusalRecord(error: unknown) {
  expect(error).toBeInstanceOf(InferenceStepError);
  const refusal = error as InferenceStepError;
  return {
    message: refusal.message,
    category: refusal.category,
    retryable: refusal.retryable,
    rejection: refusal.rejection,
    rejectedReplyShape: refusal.rejectedReplyShape,
    rejectedReplyExcerpt: refusal.rejectedReplyExcerpt,
  };
}

describe("CREATE planner reply proposed as an UPDATE", () => {
  it(
    "admits the proposal as the CREATE of a page the revision holds, marked for conversion",
    async () => {
      const queries: (readonly string[])[] = [];
      const { result, error } = await plannerStep(proposedUpdateReply(), async (paths) => {
        queries.push(paths);
        return paths;
      });
      expect(error).toBeUndefined();
      expect(queries).toEqual([[PAGE]]);
      expect(result?.planProposedMode).toBe("update");
      // Plan admission converts it; until then it is the CREATE of the page.
      expect(result?.planBinding).toMatchObject({
        mode: "create",
        pages: [{ path: PAGE, disposition: "create" }],
        sourceBindings: [{ pagePath: PAGE, sources: ["README.md"] }],
      });
      expect(result?.planBinding?.createConvertedToUpdate).toBeUndefined();
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it(
    "refuses a proposed UPDATE of a page the revision does not hold exactly as before",
    async () => {
      // Today's refusal: no oracle, so the proposal is never re-read.
      const before = await plannerStep(proposedUpdateReply());
      const after = await plannerStep(proposedUpdateReply(), async () => []);
      expect(before.result).toBeUndefined();
      expect(after.result).toBeUndefined();
      expect(refusalRecord(after.error)).toEqual(refusalRecord(before.error));
      expect(refusalRecord(after.error)).toMatchObject({
        message: "Planner planBinding mode does not match the requested documentation workflow.",
        category: "malformed-response",
        retryable: true,
        rejection: { code: "invalid-value", location: "$.planBinding.mode" },
      });
      expect(refusalRecord(after.error).rejectedReplyExcerpt).toBeDefined();
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it(
    "refuses it when only some of its pages exist",
    async () => {
      const { error } = await plannerStep(
        proposedUpdateReply([
          { path: PAGE, disposition: "update" },
          { path: OTHER, disposition: "update" },
        ]),
        async (paths) => paths.filter((path) => path === PAGE),
      );
      expect(refusalRecord(error).rejection).toEqual({
        code: "invalid-value",
        location: "$.planBinding.mode",
      });
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it(
    "stops on a host fault, not a reply refusal, when the existence oracle fails",
    async () => {
      const { error } = await plannerStep(proposedUpdateReply(), async () => {
        throw new Error("fixture: the revision export could not be read");
      });
      expect(error).not.toBeInstanceOf(InferenceStepError);
      expect((error as Error).message).toBe("fixture: the revision export could not be read");
    },
    nestedDeadlineMs(120_000, 240_000),
  );
});

describe("a CREATE plan that binds a page it writes as that page's own source", () => {
  // The page is the plan's only source.
  it.each([
    ["proposed as an UPDATE", "update", "update"],
    ["planned as a CREATE", "create", "create"],
  ])(
    "refuses it in the attempt when %s, so the planner can bind real sources",
    async (_name, mode, disposition) => {
      const { error } = await plannerStep(
        proposedUpdateReply([{ path: PAGE, disposition }], [`${PAGE}@${"a".repeat(40)}`], mode),
        async (paths) => paths,
      );
      expect(refusalRecord(error)).toMatchObject({
        message: "Planner planBinding contains empty, duplicate, or invalid source references.",
        category: "malformed-response",
        retryable: true,
        rejection: {
          code: "documentation-plan-source-write-target",
          location: "$.planBinding.sourceBindings[].sources[]",
        },
      });
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it("admits a source that is a page the plan only retains (adjacent)", () => {
    expect(
      createDocumentationPlanBinding(
        {
          mode: "create",
          pages: [
            { path: PAGE, disposition: "create" },
            { path: OTHER, disposition: "retain" },
          ],
          sourceBindings: [{ pagePath: PAGE, sources: [OTHER] }],
        },
        { expectedMode: "create" },
      ).sourceBindings,
    ).toEqual([{ pagePath: PAGE, sources: [OTHER] }]);
  });

  it("still reads a sealed binding that bound its own page, so older records decode", () => {
    const sealed = createDocumentationPlanBinding({
      mode: "create",
      pages: [{ path: PAGE, disposition: "create" }],
      sourceBindings: [{ pagePath: PAGE, sources: ["README.md"] }],
    });
    const pages = sealed.pages;
    const sourceBindings = [{ pagePath: PAGE, sources: [PAGE] }];
    const older = {
      ...sealed,
      sourceBindings,
      digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
    };
    expect(validateDocumentationPlanBinding(older).sourceBindings).toEqual(sourceBindings);
  });
});

describe("which proposals are re-read as CREATE", () => {
  it("re-reads update, retain and out-of-scope pages with at least one update", () => {
    expect(
      createProposalFromProposedUpdate({
        mode: "update",
        pages: [
          { path: PAGE, disposition: "update" },
          { path: OTHER, disposition: "retain" },
        ],
        sourceBindings: [{ pagePath: PAGE, sources: ["README.md"] }],
      }),
    ).toEqual({
      mode: "create",
      pages: [
        { path: PAGE, disposition: "create" },
        { path: OTHER, disposition: "retain" },
      ],
      sourceBindings: [{ pagePath: PAGE, sources: ["README.md"] }],
    });
  });

  it.each([
    ["a CREATE page", [{ path: PAGE, disposition: "create" }]],
    [
      "a CREATE page beside an UPDATE page",
      [
        { path: PAGE, disposition: "update" },
        { path: OTHER, disposition: "create" },
      ],
    ],
    ["no UPDATE page", [{ path: PAGE, disposition: "retain" }]],
    ["a restructure page", [{ path: PAGE, disposition: "move" }]],
  ])("leaves a proposal with %s to the mode refusal", (_name, pages) => {
    expect(
      createProposalFromProposedUpdate({ mode: "update", pages, sourceBindings: [] }),
    ).toBeUndefined();
  });

  it.each([
    ["mode create", { mode: "create", pages: [], sourceBindings: [] }],
    ["a sealed binding", { kind: "x", mode: "update", pages: [], sourceBindings: [] }],
    ["not an object", "update"],
  ])("leaves %s untouched", (_name, value) => {
    expect(createProposalFromProposedUpdate(value)).toBeUndefined();
  });
});
