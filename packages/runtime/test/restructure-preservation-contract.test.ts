// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The restructure planner contract states what preservation means.
 *
 * A planner asked to reorder a page while preserving its anchors and links
 * can stop with `needs-input` / `ambiguous-scope`, treating the new section
 * order as a change to "anchor positions" or asking where an unmentioned
 * section goes. These tests pin the host-owned sentences that settle both
 * questions in the rendered planner prompt.
 *
 * Preservation is defined by destination: an anchor is preserved while it
 * identifies the same section. One test uses the product's real anchor
 * extraction to show why a reorder is anchor-safe only for unique heading
 * text. Another checks, with a scripted provider, that the harness still
 * admits a needs-input reply for a conflicting request and sends the rules on
 * the wire. Whether the model still asks is live-matrix evidence.
 *
 * The phrases are written out rather than imported, so removing a sentence
 * from the contract fails this suite.
 */
import { writeFile } from "node:fs/promises";
import {
  REORDER_INSTRUCTION,
  FIXTURE_GUIDE_SECTIONS,
  STATED_PLACEMENT_CASES,
} from "./helpers/restructure-preservation-inputs.js";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHostStepPrompt } from "../src/harness/pi.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { documentationMarkdownAnchors } from "../src/repository/documentation-source-support.js";
import { RESTRUCTURE_PRESERVATION_CONTRACT } from "../src/workflow-contracts/restructure-preservation.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  createAuditHarness,
  createRepository,
  firstUserMessageText,
  resetSharedTestState,
  scriptedProvider,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/** Load-bearing phrases of each host-owned sentence, independent of the module. */
const ANCHOR_IDENTIFIES_THE_SAME_SECTION = [
  "Preserving an anchor or link means the anchor still exists and still identifies the same section, and every link to it still resolves to that section; it does not fix where the section sits on the page.",
  "Reordering sections within a page, without renaming their headings, preserves the anchors of headings whose text is unique on the page and the links to them",
  "so such a reorder does not conflict with preserving anchors, links, or routes.",
];
const REPEATED_HEADINGS_UPDATE_LINKS_OR_ASK = [
  "Where heading text repeats on a page, its generated anchors are numbered in page order, such as example and example-1, so a reorder can shift a numbered anchor to a different section while every link still resolves.",
  "The plan must update the links that point at a shifted anchor within the request's scope",
  "if it cannot do that within the request's scope, that is a genuine conflict and needs-input is allowed.",
];
const STATED_PLACEMENT_WINS = [
  "A placement the request states explicitly, such as the requested order, to the top, to the end, or after another section, wins.",
  "Sections the request does not name keep their relative order, and a section that was last and is not named stays last.",
  "That placement is not an open decision and is not a reason to return needs-input.",
];
const GENUINE_CONFLICT_STILL_ASKS = [
  "Return needs-input only for a genuine conflict or gap, for example when",
  "the request contradicts itself",
  "asks to delete or rewrite content it also says to preserve",
  "depends on a decision or dependency that is not available",
];
const ALL_PHRASES = [
  ...ANCHOR_IDENTIFIES_THE_SAME_SECTION,
  ...REPEATED_HEADINGS_UPDATE_LINKS_OR_ASK,
  ...STATED_PLACEMENT_WINS,
  ...GENUINE_CONFLICT_STILL_ASKS,
];

function plannerPrompt(workflowName: string, instruction = REORDER_INSTRUCTION): string {
  const workflow = getWorkflow(workflowName as Parameters<typeof getWorkflow>[0]);
  return buildHostStepPrompt({
    repositoryPath: "/tmp/repository",
    workflow,
    step: workflow.steps.find((step) => step.skill === "plan-documentation")!,
    instruction,
  });
}

/**
 * A literal reading of RESTRUCTURE_UNMENTIONED_SECTION_ORDER, used only as a
 * test oracle for its wording, not a product ordering engine. Sections the
 * request places at the top come first, in the stated order. Unnamed sections
 * keep their relative order, and a section that was last and is not named
 * stays last, unless the request itself places a section at the end.
 */
function applyStatedPlacementRule(
  sections: readonly string[],
  placed: { readonly top?: readonly string[]; readonly end?: readonly string[] },
): readonly string[] {
  const top = placed.top ?? [];
  const end = placed.end ?? [];
  const named = new Set([...top, ...end]);
  const unnamed = sections.filter((section) => !named.has(section));
  const last = sections.at(-1);
  const lastStaysLast = last !== undefined && !named.has(last);
  const middle = lastStaysLast ? unnamed.slice(0, -1) : unnamed;
  return [...top, ...middle, ...(lastStaysLast ? [last] : []), ...end];
}

/** The generated anchor of each heading, in page order, from the product extractor. */
function headingAnchorsInOrder(sections: readonly string[]): readonly string[] {
  return documentationMarkdownAnchors(["# Guide", ...sections].join("\n\n"));
}

describe("restructure planner preservation semantics (#1361)", () => {
  it("defines a preserved anchor or link as one that still identifies the same section", () => {
    const prompt = plannerPrompt("restructure-documentation");
    for (const phrase of ANCHOR_IDENTIFIES_THE_SAME_SECTION) expect(prompt).toContain(phrase);
  });

  it("has the plan update links to a shifted repeated-heading anchor, or ask when it cannot", () => {
    const prompt = plannerPrompt("restructure-documentation");
    for (const phrase of REPEATED_HEADINGS_UPDATE_LINKS_OR_ASK) expect(prompt).toContain(phrase);
    // The link check reads no {#id} or MyST label, and an HTML anchor can
    // collide with the generated id, so the contract names no explicit anchor.
    expect(prompt).not.toMatch(/explicit anchor/iu);
  });

  it("lets a stated placement win and keeps unnamed sections in relative order", () => {
    const prompt = plannerPrompt("restructure-documentation");
    for (const phrase of STATED_PLACEMENT_WINS) expect(prompt).toContain(phrase);
    expect(prompt).not.toContain("each unmentioned section stays where it was");
  });

  it.each(STATED_PLACEMENT_CASES)(
    "the stated placement rule orders the fixture guide for $request",
    ({ placed, expected }) => {
      expect(applyStatedPlacementRule(FIXTURE_GUIDE_SECTIONS, placed)).toEqual(expected);
    },
  );

  it("offers needs-input for a genuine conflict or gap, by example rather than a closed list", () => {
    const prompt = plannerPrompt("restructure-documentation");
    for (const phrase of GENUINE_CONFLICT_STILL_ASKS) expect(prompt).toContain(phrase);
    expect(prompt).not.toContain("Return needs-input only for a genuine conflict or gap:");
    expect(prompt).toContain('"outcome":"needs-input"');
  });

  it("renders the block once, whole, inside the host-owned planner contract", () => {
    const prompt = plannerPrompt("restructure-documentation");
    const block = RESTRUCTURE_PRESERVATION_CONTRACT.join("\n");
    expect(prompt.split(block)).toHaveLength(2);
    const contractStart = prompt.indexOf("Runtime planner response contract (host-owned):");
    const instructionStart = prompt.indexOf("Requester instruction:");
    expect(contractStart).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(block)).toBeGreaterThan(contractStart);
    expect(prompt.indexOf(block)).toBeLessThan(instructionStart);
  });

  it.each(["create-documentation", "update-documentation"] as const)(
    "does not add restructure semantics to the %s planner",
    (workflowName) => {
      // The mode-generic planner contract, before any editorial envelope.
      const workflow = getWorkflow(workflowName);
      const prompt = buildDocsFabStepPrompt({
        repositoryPath: "/tmp/repository",
        workflow,
        step: workflow.steps.find((step) => step.skill === "plan-documentation")!,
        instruction: REORDER_INSTRUCTION,
      });
      expect(prompt).toContain("Runtime planner response contract (host-owned):");
      expect(prompt).not.toContain("Restructure preservation semantics (host-owned):");
      expect(prompt).not.toContain(STATED_PLACEMENT_WINS[0]);
    },
  );

  it("moves an order-numbered anchor to another section when a reorder swaps repeated headings", () => {
    // Why the contract says "identifies the same section" and limits the
    // reorder guarantee to unique heading text: the product's own anchor
    // extraction keeps the same anchor set, so a resolve-only check passes,
    // while #example changes section.
    const options = "## Options\n\n### Example\n\n--name Ada";
    const errors = "## Errors\n\n### Example\n\n--format xml";
    const before = headingAnchorsInOrder([options, errors]);
    const after = headingAnchorsInOrder([errors, options]);

    expect(before).toEqual(["guide", "options", "example", "errors", "example-1"]);
    expect(after).toEqual(["guide", "errors", "example", "options", "example-1"]);
    expect(new Set(after)).toEqual(new Set(before));
    // #example sat under Options and now sits under Errors.
    expect(before[before.indexOf("example") - 1]).toBe("options");
    expect(after[after.indexOf("example") - 1]).toBe("errors");

    // The in-scope link update: a link meant for the Options example now
    // targets #example-1.
    expect(after[after.indexOf("example-1") - 1]).toBe("options");

    // Unique heading text: the same reorder keeps every anchor on its section.
    const uniqueAfter = headingAnchorsInOrder([
      "## Errors\n\n### Errors example",
      "## Options\n\n### Options example",
    ]);
    expect(uniqueAfter[uniqueAfter.indexOf("options-example") - 1]).toBe("options");
    expect(uniqueAfter[uniqueAfter.indexOf("errors-example") - 1]).toBe("errors");
  });

  it("admits a scripted needs-input reply to a conflicting restructure and sends the rules on the wire", async () => {
    const repositoryPath = await createRepository();
    await writeFile(
      resolve(repositoryPath, "guide.md"),
      "# Guide\n\n## Errors\n\nStatus 2.\n\n## Options\n\n--name\n",
    );
    const summary =
      "The request asks to delete the Errors section of guide.md and also to preserve all of its facts, including the status 2 error fact; confirm which obligation wins.";
    const requests: string[] = [];
    const provider = scriptedProvider([
      textTurn(JSON.stringify({ summary, outcome: "needs-input", reason: "ambiguous-scope" })),
    ]);
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      return provider(request, init);
    });
    const workflow = getWorkflow("restructure-documentation");
    const result = await (await createAuditHarness()).runStep({
      runId: "restructure-genuine-conflict-run",
      repositoryPath,
      workflow,
      step: workflow.steps.find((step) => step.id === "plan-documentation")!,
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      instruction:
        "Delete the Errors section of guide.md and preserve every fact in guide.md unchanged.",
    });

    expect(result).toMatchObject({
      outcome: "needs-input",
      summary,
      planDiagnostic: { code: "ambiguous-scope", responseShape: "json-object" },
    });
    expect(result.planBinding).toBeUndefined();
    // The contract on the wire carried the reorder semantics and the
    // genuine-conflict rule this stop relies on.
    expect(requests).toHaveLength(1);
    const sent = firstUserMessageText(requests[0]!);
    for (const phrase of ALL_PHRASES) expect(sent).toContain(phrase);
  });
});
