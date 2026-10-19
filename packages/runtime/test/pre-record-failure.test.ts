// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A workflow that stops before its RunRecord exists shows its failure class,
 * code, location, and a NEXT that names who can act, on both entry points (the
 * CLI operator envelope and the live-agent terminal), and does not point at a
 * run log that cannot exist.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  FIRST_PASS_SUPPORT_FAILURE_KIND,
  FirstPassSupportPreflightError,
} from "../src/cli/first-pass.js";
import {
  FIRST_RUN_PROPOSAL_SCOPE_FAILURES,
  rejectFirstRunProposalScope,
} from "../src/init/first-run-bootstrap.js";
import { LiveAgentActivityRenderer } from "../src/live-agent/activity-renderer.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import {
  classifyFirstPassFailure,
  FIRST_PASS_FAILURE_RULES,
  PROPOSAL_SCOPE_FAILURE_CODES,
} from "../src/operator/pre-record-failure.js";
import { isModelCorrectableFirstPassRule } from "../src/operator/first-pass-rejection-retryability.js";
import { DEFAULT_NEXT_ACTIONS } from "../src/operator/situation-catalog.js";

const RULES = [...FIRST_PASS_FAILURE_RULES];
const KNOWLEDGE_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../knowledge/src");
/** Literal rule names at the untyped knowledge raise sites. */
const KNOWLEDGE_RULE_LITERAL =
  /\brule: "([a-z0-9-]+)"|assessmentInvalid\([^,()]*, "([a-z0-9-]+)"|\brule = "([a-z0-9-]+)"/gu;
async function firstPassKnowledgeFiles(): Promise<string[]> {
  const entries = await readdir(KNOWLEDGE_SOURCE, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith("first-pass") && entry.name.endsWith(".mjs"),
    )
    .map((entry) => entry.name);
  const groupedFirstPass = entries.find(
    (entry) => entry.isDirectory() && entry.name === "first-pass",
  );
  if (groupedFirstPass) {
    files.push(
      ...(await readdir(join(KNOWLEDGE_SOURCE, groupedFirstPass.name), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
        .map((entry) => join(groupedFirstPass.name, entry.name)),
    );
  }
  return files;
}
/** A recorded create-live rejection location. */
const OBSERVED = "$response.additionalObligations[2].instructionQuote";
const DEAD_END = "Inspect the private session or run log";
const WHO =
  /^(?:You can act|You or your host administrator can act|Your host administrator can act|You or DocsFab maintainers can act|DocsFab maintainers can act)/u;
const CREATE_ARGS = { workflow: "create-documentation", instruction: "Write the usage page." };

function stopMessage(phase: string, rule: string, location: string): string {
  return "First-pass support stopped in " + phase + " at " + location + " under rule " + rule + ".";
}

/** A preflight error with evidence the envelope validator admits. */
function preflightError(phase: string, rule: string, location: string) {
  const body = {
    schemaVersion: 1 as const,
    kind: FIRST_PASS_SUPPORT_FAILURE_KIND,
    phase,
    rule,
    location,
    instructionSha256: "a".repeat(64),
    repositoryRevision: "b".repeat(40),
    modelCalls: { started: 1, completed: 1 },
    corrections: null,
    lastPromptSha256: null,
    lastResponseSha256: null,
    lastIdentitySha256: null,
  };
  return new FirstPassSupportPreflightError({
    ...body,
    evidenceSha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  });
}

function renderer() {
  const chunks: string[] = [];
  const activity = new LiveAgentActivityRenderer({
    environment: { NO_COLOR: "1" },
    skillIds: [],
    workflowIds: ["create-documentation", "update-documentation"],
    tty: false,
    write: (text) => chunks.push(text),
  });
  return { activity, output: () => chunks.join("") };
}

function toolError(
  text: string,
  toolCallId = "tool-1",
  args: unknown = CREATE_ARGS,
  toolName = "docsfab_run_workflow",
): AgentSessionEvent[] {
  return [
    {
      type: "tool_execution_start",
      toolName,
      args,
      toolCallId,
    },
    {
      type: "tool_execution_end",
      toolName,
      result: { content: [{ type: "text", text }] },
      isError: true,
      toolCallId,
    },
  ] as AgentSessionEvent[];
}

function renderStop(text: string): string {
  const { activity, output } = renderer();
  activity.begin();
  for (const event of toolError(text)) activity.handle(event);
  activity.finish();
  return output();
}

function workflowTool(run: () => Promise<unknown>) {
  return createLiveAgentToolDefinitions({
    capabilities: {
      skills: [],
      workflows: [{ name: "create-documentation", title: "Create documentation" }],
      qualityPack: {} as never,
    },
    runWorkflow: run as never,
  }).find((entry) => entry.name === "docsfab_run_workflow")!;
}

/** The message that actually crosses the tool boundary when the runner throws. */
async function thrownAcrossToolBoundary(error: Error): Promise<string> {
  const caught = await workflowTool(async () => {
    throw error;
  })
    .execute(
      "tool-1",
      { workflow: "create-documentation", instruction: "Write the usage page." },
      undefined,
      undefined,
      undefined as never,
    )
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  expect(caught).toBeInstanceOf(Error);
  return (caught as Error).message;
}

describe("pre-record failure classification", () => {
  it.each(RULES)(
    "classifies first-pass rule %s with a meaning and a NEXT that names who can act",
    (rule) => {
      const failure = classifyFirstPassFailure({
        phase: "decomposition",
        rule,
        location: OBSERVED,
      });
      expect(failure?.code).toBe(rule);
      expect(failure?.location).toBe(OBSERVED);
      expect(failure?.meaning.length).toBeGreaterThan(0);
      expect(failure?.next).toMatch(WHO);
      expect(failure?.next).not.toMatch(/run log|Inspect the private/u);
    },
  );

  it.each([
    ["model-connection-failed", "$model.connection", "docsfab doctor --live"],
    ["repository-read-budget-exhausted", "$repository", "docsfab doctor --limits"],
    ["bound-source-unavailable", "$repository", "Check the selected source path"],
    ["unsafe-target", "$instruction", "authorized write roots"],
    ["credential-material", "$instruction", "from the request, then"],
    ["credential-material", "$repository", "from the selected repository sources"],
    ["credential-material", "$response", "You or DocsFab maintainers can act"],
    ["output-policy-limit", "$model.requestPolicy", "Your host administrator can act"],
    ["output-policy-limit", "$model.requestPolicy", "Narrowing the request does not clear this"],
    ["identity-binding", "$response.identity", "DocsFab's own first-pass evidence binding failed"],
    ["strict-json", "$response", "docsfab setup --profile <id>"],
    ["response-size", "$response", "A retry can pass by chance but does not fix the rejection"],
    ["insufficient-evidence", "$repository", "Narrow the request to what the repository documents"],
    ["explicit-quote-binding", OBSERVED, "report rule explicit-quote-binding at " + OBSERVED],
  ])("routes %s at %s to the party that can act", (rule, location, expected) => {
    expect(classifyFirstPassFailure({ phase: "request", rule, location })?.next).toContain(
      expected,
    );
  });

  it.each([
    ["unknown-rule", OBSERVED],
    ["explicit-quote-binding", "$response.additionalObligations[2].instructionQuote PRIVATE"],
    ["explicit-quote-binding", "/private/session"],
  ])("refuses to classify an unvalidated rule or location: %s at %s", (rule, location) => {
    expect(classifyFirstPassFailure({ phase: "decomposition", rule, location })).toBeUndefined();
  });
});

describe("CLI operator envelope for a first-pass stop", () => {
  it.each(RULES)("names rule %s, its location, and who can act without a run log", (rule) => {
    const envelope = toOperatorErrorEnvelope(preflightError("decomposition", rule, OBSERVED));
    const failure = classifyFirstPassFailure({ phase: "decomposition", rule, location: OBSERVED })!;
    expect(envelope.code).toBe("first-pass-support-invalid");
    expect(envelope.details).toMatchObject({ phase: "decomposition", rule, location: OBSERVED });
    expect(envelope.nextAction).toContain(failure.meaning);
    expect(envelope.nextAction).toContain("This preflight did not create a RunRecord.");
    expect(envelope.nextAction).toContain(failure.next);
    const human = formatOperatorErrorEnvelope(envelope);
    expect(human).toContain("under rule " + rule);
    expect(human).toContain(OBSERVED);
    expect(human).not.toMatch(/run log|Inspect the private/u);
  });
});

describe("live-agent terminal for a stop before a run record", () => {
  it.each(RULES)("renders rule %s with its code, location, and NEXT", (rule) => {
    const transcript = renderStop(stopMessage("decomposition", rule, OBSERVED));
    expect(transcript).toContain(
      "Stopped before the workflow created a run record: " +
        rule +
        " in decomposition at " +
        OBSERVED +
        ". No workflow steps ran",
    );
    expect(transcript).toMatch(
      /\nMeaning: .+\nFailure class: [a-z-]+\.\nNEXT: (?:You can act|You or your host administrator can act|Your host administrator can act|You or DocsFab maintainers can act|DocsFab maintainers can act)/u,
    );
    // The class line names the rule's own catalogued class.
    const failure = classifyFirstPassFailure({ phase: "decomposition", rule, location: OBSERVED })!;
    expect(transcript).toContain(`\nFailure class: ${failure.failure.class}.\n`);
    expect(transcript).not.toContain("No safe failure detail");
    expect(transcript).not.toContain(DEAD_END);
  });

  it("renders the observed create-live explicit-quote-binding stop with its meaning", () => {
    const transcript = renderStop(stopMessage("decomposition", "explicit-quote-binding", OBSERVED));
    expect(transcript).toContain(
      "Meaning: A model-proposed explicit obligation does not quote a contiguous passage of the request verbatim, or its condition differs from that quote.",
    );
    expect(transcript).toContain(
      "NEXT: You or DocsFab maintainers can act. This is a first-pass policy stop on the model's answer, not missing input from you.",
    );
  });

  it("renders a model-call stop that carries no location", () => {
    const transcript = renderStop(
      "First-pass support stopped during assessment (provider-call-failed).",
    );
    expect(transcript).toContain("provider-call-failed in assessment. No workflow steps ran");
    expect(transcript).toContain("docsfab doctor --live");
  });

  it.each(PROPOSAL_SCOPE_FAILURE_CODES)(
    "renders proposal-scope refusal %s with the catalog action",
    (code) => {
      const transcript = renderStop(FIRST_RUN_PROPOSAL_SCOPE_FAILURES[code]);
      expect(transcript).toContain(code + " in proposal-scope-admission. No workflow steps ran");
      expect(transcript).toContain("Meaning: " + FIRST_RUN_PROPOSAL_SCOPE_FAILURES[code]);
      expect(transcript).toContain(DEFAULT_NEXT_ACTIONS[code]!);
      expect(transcript).not.toContain(DEAD_END);
    },
  );

  it("names the user as the actor for a non-actionable request", () => {
    const transcript = renderStop(
      FIRST_RUN_PROPOSAL_SCOPE_FAILURES["proposal-scope-non-actionable-targets"],
    );
    expect(transcript).toContain(
      "NEXT: You can act. Rephrase the instruction as a request to proceed with the change to the named pages, then start a new run.",
    );
  });

  it.each([
    stopMessage("decomposition", "explicit-quote-binding", OBSERVED) + " PRIVATE-QUOTE",
    stopMessage(
      "decomposition",
      "explicit-quote-binding",
      "$response.instructionQuote=PRIVATE-QUOTE",
    ),
    stopMessage("decomposition", "glpat-PRIVATEPRIVATEPRIVATE", "$response"),
    stopMessage("PRIVATE-phase", "strict-json", "$response"),
    FIRST_RUN_PROPOSAL_SCOPE_FAILURES["proposal-scope-unsafe-target"] + " PRIVATE-QUOTE",
  ])("withholds decorated or unvalidated stop text: %s", (text) => {
    const transcript = renderStop(text);
    expect(transcript).not.toContain("PRIVATE");
    expect(transcript).toContain("No safe failure detail is available.");
    expect(transcript).toContain(
      "stopped before DocsFab created a run record, so there is no run log",
    );
    expect(transcript).not.toContain(DEAD_END);
  });

  it("collapses a stop repeated by calls with the same tool and arguments", () => {
    const { activity, output } = renderer();
    activity.begin();
    const text = stopMessage("decomposition", "explicit-quote-binding", OBSERVED);
    for (const id of ["one", "two", "three"]) {
      for (const event of toolError(text, id)) activity.handle(event);
    }
    activity.finish();
    const transcript = output();
    expect(transcript.split("\nMeaning: ").length - 1).toBe(1);
    expect(transcript.split("NEXT: ").length - 1).toBe(1);
    expect(transcript).toContain(
      "Same stop again (attempt 2 this turn with the same arguments: explicit-quote-binding in decomposition at " +
        OBSERVED +
        ").",
    );
    expect(transcript).toContain("(attempt 3 this turn with the same arguments");
    expect(transcript).toContain(
      "Turn summary: Running workflow: create-documentation was called 3 times with the same arguments and stopped at explicit-quote-binding in decomposition at " +
        OBSERVED +
        " each time.",
    );
    expect(transcript).not.toMatch(/identical attempts|unchanged request did not change/u);
  });

  it.each([
    [
      "a different instruction",
      { workflow: "create-documentation", instruction: "Write the install page." },
      "docsfab_run_workflow",
    ],
    [
      "a different workflow",
      { workflow: "update-documentation", instruction: "Write the usage page." },
      "docsfab_run_workflow",
    ],
    [
      "different reader sources",
      { ...CREATE_ARGS, readerSources: [{ role: "source", path: "src/cli.ts" }] },
      "docsfab_run_workflow",
    ],
    ["a different tool", CREATE_ARGS, "docsfab_publish_workflow"],
  ])("does not collapse the same stop reached with %s", (_label, args, toolName) => {
    const { activity, output } = renderer();
    activity.begin();
    const text = stopMessage("decomposition", "strict-json", "$response");
    for (const event of toolError(text, "first")) activity.handle(event);
    for (const event of toolError(text, "second", args, toolName)) activity.handle(event);
    activity.finish();
    const transcript = output();
    expect(transcript.split("\nMeaning: ").length - 1).toBe(2);
    expect(transcript).not.toContain("Same stop again");
    expect(transcript).not.toContain("Turn summary");
  });

  it.each([
    ["two host commands that exit 1", "bash", { command: "npm test" }, { command: "npm run lint" }],
    ["two unclassified tool failures", "read", { path: "a.md" }, { path: "b.md" }],
    ["the same unclassified failure twice", "read", { path: "a.md" }, { path: "a.md" }],
  ])("prints %s in full without a repeat claim", (_label, toolName, first, second) => {
    const { activity, output } = renderer();
    activity.begin();
    for (const [id, args] of [
      ["first", first],
      ["second", second],
    ] as const) {
      activity.handle({
        type: "tool_execution_start",
        toolName,
        args,
        toolCallId: id,
      } as AgentSessionEvent);
      activity.handle({
        type: "tool_execution_end",
        toolName,
        result:
          toolName === "bash"
            ? { details: { status: "failed", exitCode: 1 } }
            : { content: [{ type: "text", text: "ENOENT PRIVATE" }] },
        isError: true,
        toolCallId: id,
      } as AgentSessionEvent);
    }
    activity.finish();
    const transcript = output();
    expect(transcript).not.toContain("Same stop again");
    expect(transcript).not.toContain("Turn summary");
    expect(transcript).not.toContain("PRIVATE");
  });

  it("prints each host command exit even when its output is a first-pass stop line", () => {
    const { activity, output } = renderer();
    activity.begin();
    const args = { command: "cat stop.txt" };
    for (const [id, exitCode] of [
      ["first", 1],
      ["second", 2],
    ] as const) {
      activity.handle({
        type: "tool_execution_start",
        toolName: "bash",
        args,
        toolCallId: id,
      } as AgentSessionEvent);
      activity.handle({
        type: "tool_execution_end",
        toolName: "bash",
        result: {
          details: { status: "failed", exitCode },
          content: [
            { type: "text", text: stopMessage("decomposition", "strict-json", "$response") },
          ],
        },
        isError: true,
        toolCallId: id,
      } as AgentSessionEvent);
    }
    activity.finish();
    const transcript = output();
    expect(transcript).toContain("Host command exited with code 1.");
    expect(transcript).toContain("Host command exited with code 2.");
    expect(transcript).not.toContain("Same stop again");
    expect(transcript).not.toContain("Turn summary");
    expect(transcript).not.toContain("strict-json");
  });

  it("renders each distinct stop in full and starts counting again on the next turn", () => {
    const { activity, output } = renderer();
    activity.begin();
    for (const event of toolError(stopMessage("decomposition", "strict-json", "$response"), "a"))
      activity.handle(event);
    for (const event of toolError(stopMessage("completeness", "schema-v1", "$response"), "b"))
      activity.handle(event);
    activity.finish();
    activity.begin();
    for (const event of toolError(stopMessage("decomposition", "strict-json", "$response"), "c"))
      activity.handle(event);
    activity.finish();
    const transcript = output();
    expect(transcript.split("\nMeaning: ").length - 1).toBe(3);
    expect(transcript).not.toContain("Same stop again");
    expect(transcript).not.toContain("Turn summary");
  });

  it("names the saved run rather than a missing log for an unclassified completed-run failure", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle({
      type: "tool_execution_start",
      toolName: "docsfab_run_workflow",
      args: { workflow: "create-documentation" },
      toolCallId: "run",
    } as AgentSessionEvent);
    activity.handle({
      type: "tool_execution_end",
      toolName: "docsfab_run_workflow",
      result: {
        details: { status: "failed", runId: "run-1122", error: "PRIVATE provider body" },
      },
      isError: false,
      toolCallId: "run",
    } as AgentSessionEvent);
    activity.finish();
    expect(output()).toContain(
      "Run run-1122 was saved; inspect its failed step with\ndocsfab runs show run-1122",
    );
    expect(output()).not.toContain("PRIVATE");
    expect(output()).not.toContain(DEAD_END);
  });

  it("carries a thrown first-pass stop across the workflow tool boundary", async () => {
    const message = await thrownAcrossToolBoundary(
      preflightError("decomposition", "explicit-quote-binding", OBSERVED),
    );
    expect(renderStop(message)).toContain(
      "explicit-quote-binding in decomposition at " + OBSERVED + ". No workflow steps ran",
    );
  });

  it("carries a thrown proposal-scope refusal across the workflow tool boundary", async () => {
    let refusal: unknown;
    try {
      rejectFirstRunProposalScope("proposal-scope-ambiguous-targets");
    } catch (error) {
      refusal = error;
    }
    const message = await thrownAcrossToolBoundary(refusal as Error);
    const transcript = renderStop(message);
    expect(transcript).toContain("proposal-scope-ambiguous-targets in proposal-scope-admission");
    expect(transcript).toContain("NEXT: You can act.");
  });
});

describe("knowledge first-pass raise sites", () => {
  it("names only rules the operator classification table covers", async () => {
    const files = await firstPassKnowledgeFiles();
    const raised = new Set<string>();
    for (const file of files) {
      const source = await readFile(join(KNOWLEDGE_SOURCE, file), "utf8");
      for (const match of source.matchAll(KNOWLEDGE_RULE_LITERAL)) {
        raised.add((match[1] ?? match[2] ?? match[3])!);
      }
    }
    // Guards the scan itself: the observed rules must be found.
    expect(raised).toContain("authority-expansion");
    expect(raised).toContain("explicit-quote-binding");
    expect(raised.size).toBeGreaterThan(20);
    expect([...raised].filter((rule) => !FIRST_PASS_FAILURE_RULES.has(rule))).toEqual([]);
  });

  it("has no rule form the literal scan cannot read", async () => {
    // The scan above reads string literals only. Every other line that names a
    // rule must be one of these reviewed pass-through forms; a new computed
    // form (for example a ternary) fails here until it is reviewed and
    // classified.
    const reviewed = new Set([
      "this.rule = diagnostic.rule;",
      "if (!assessmentIdentity || !finalResponse) assessmentInvalid();",
      "`First-pass support rejected ${phase} output at ${location} (${rule}).`,",
      "{ phase, rule, location },",
      "assessmentInvalid(diagnostic.phase, diagnostic.rule, diagnostic.location);",
      "assessmentInvalid();",
      // Correction rounds read the raised rule back into the correction prompt;
      // they raise no rule of their own.
      'typeof error.rule === "string" &&',
      "return isPhaseRejection(error, phase) && Object.hasOwn(FIRST_PASS_CORRECTIONS, error.rule);",
      "`Correction: the host rejected your previous response at ${error.location} under rule ${error.rule}. ${FIRST_PASS_CORRECTIONS[error.rule]}`,",
      "`Correction: the host rejected your previous assessment at ${error.location} under rule ${error.rule}. ${FIRST_PASS_CORRECTIONS[error.rule]}`,",
      '...(error.rule === "evidence-span-binding" ? evidenceSpanBindingHint(responseText, spans) : []),',
    ]);
    const files = await firstPassKnowledgeFiles();
    const unreviewed: string[] = [];
    for (const file of files) {
      const source = await readFile(join(KNOWLEDGE_SOURCE, file), "utf8");
      for (const line of source.split("\n")) {
        if (!/\brule\b|assessmentInvalid\(/u.test(line)) continue;
        if (new RegExp(KNOWLEDGE_RULE_LITERAL.source, "u").test(line)) continue;
        if (!reviewed.has(line.trim())) unreviewed.push(file + ": " + line.trim());
      }
    }
    expect(unreviewed).toEqual([]);
  });
});

describe("first-pass hinted correction rounds (#1123, #1284)", () => {
  const MODEL_PHASES = ["decomposition", "completeness", "assessment"] as const;
  const CORRECTED = RULES.filter(isModelCorrectableFirstPassRule);

  it.each(MODEL_PHASES.flatMap((phase) => CORRECTED.map((rule) => [rule, phase] as const)))(
    "says the host already re-asked the model for correctable rule %s in %s",
    (rule, phase) => {
      const next = classifyFirstPassFailure({ phase, rule, location: "$response" })!.next;
      expect(next).toContain(
        "Before stopping, DocsFab re-asks the model with a hint that names the rule and location, up to `retry.maxRetries` times per request; this stop comes from the last answer.",
      );
      expect(next).toContain(
        "Retrying the unchanged request starts a new first pass with its own correction rounds.",
      );
      expect(next).not.toContain("A retry can pass by chance");
      expect(next).toContain("report rule " + rule + " at $response");
      expect(next).toMatch(WHO);
    },
  );

  it.each([
    ["response-size", "decomposition", "$response"],
    ["invalid-response", "assessment", "$response"],
    ["assessment-invalid", "assessment", "$response"],
    ["credential-material", "assessment", "$response"],
    ["explicit-quote-binding", "request", OBSERVED],
  ])("keeps the chance-retry warning and claims no round for %s in %s", (rule, phase, location) => {
    const next = classifyFirstPassFailure({ phase, rule, location })!.next;
    expect(next).not.toContain("re-asks the model");
    expect(next).toContain(
      "A retry can pass by chance but does not fix the rejection, so do not rely on retrying the unchanged request.",
    );
  });

  it("names the recorded create-live span refusal as a model-output stop after hinted rounds", () => {
    const failure = classifyFirstPassFailure({
      phase: "assessment",
      rule: "evidence-span-binding",
      location: "$response.assessments[0].evidenceSpanIds",
    })!;
    expect(failure.kind).toBe("correct");
    expect(failure.failure.class).toBe("model-content");
    expect(failure.next).toContain("re-asks the model with a hint");
    expect(failure.next).not.toContain("does not fix the rejection");
  });

  it("names the recorded create-cli JSON refusal as model output, not a DocsFab binding defect", () => {
    const failure = classifyFirstPassFailure({
      phase: "assessment",
      rule: "assessment-binding-response-json",
      location: "$response",
    })!;
    expect(failure.kind).toBe("correct");
    expect(failure.meaning).toBe("The model's assessment answer is not valid JSON.");
    expect(failure.next).toMatch(/^You or DocsFab maintainers can act\./u);
    expect(failure.next).not.toContain("DocsFab's own first-pass evidence binding failed");
    expect(failure.next).toContain("re-asks the model with a hint");
  });

  it("classifies a truncated first-pass answer as a bound on the model's answer", () => {
    const failure = classifyFirstPassFailure({
      phase: "assessment",
      rule: "response-truncated",
      location: "$response",
    })!;
    expect(failure.kind).toBe("correct");
    expect(failure.failure.class).toBe("bound");
    expect(failure.next).toContain("re-asks the model with a hint");
  });
});
