// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  admissionOfferFor,
  handleDoCommand,
  parseDoArguments,
  type DoRunArguments,
} from "../src/cli/commands/do.js";
import {
  GOLDEN_OUTCOME_REQUEST,
  NO_OUTCOME_AUTHORITY_GRANTS,
  applyAdmissionModelSelection,
  buildOutcomeRouteEnvelope,
  formatOutcomeRouteDecision,
  isAdmissionModelEligible,
  routeOutcomeRequest,
} from "../src/cli/outcome-router.js";
import { hasExplicitPublicationProhibition } from "../src/cli/publication-prohibition.js";
import {
  ADMISSION_MODEL_SYSTEM_PROMPT,
  ADMISSION_MODEL_USER_PROMPT_PREFIX,
  buildAdmissionModelPrompt,
  parseAdmissionModelResponse,
  type AdmissionOffer,
} from "../src/cli/admission-parse.js";
import { usage } from "../src/cli/usage.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { git, initFixtureRepo } from "./helpers/git.js";

const execFileAsync = promisify(execFile);
const roots = temporaryRoots();
const projectRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const LOCAL_CONSUMER_GUIDE_REQUEST =
  "Create docs/usage.md, a concise consumer guide for @dl/nemo-ui-utils for application developers. Include how to install and import it, a realistic fetchWithCsrf usage example, defaults and behavior supported by source, and clear limits. Change only docs/usage.md; leave source files, package configuration, and all existing documentation unchanged. Keep the result local; do not publish.";

const PATHLESS_HEALTH_PAGE_REQUEST =
  "Create a reader-facing health endpoint page for people operating the service. Cover the GET path, response fields and their meanings, the healthy status code, and one curl example. Put the page in the existing API guide's navigation. Use only facts supported by the implementation and current documentation.";

afterEach(async () => {
  process.exitCode = undefined;
});

describe("outcome router classification (#227)", () => {
  it("routes the golden user-level request to review-documentation with rationale", () => {
    const decision = routeOutcomeRequest(GOLDEN_OUTCOME_REQUEST);
    expect(decision).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      readWriteScope: "read-only",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    if (decision.status !== "selected") throw new Error("expected selected");
    expect(decision.rationale.toLowerCase()).toContain("review");
    expect(decision.expectedValidations.length).toBeGreaterThan(0);
    expect(decision.authorizationBoundary.toLowerCase()).toContain("never grants");
    expect(GOLDEN_OUTCOME_REQUEST.toLowerCase()).not.toMatch(
      /foundation-to-patch|documentation-plan|compose-foundation/u,
    );
    expect(decision.classifiedBy).toBe("fixed-table");
  });

  it("routes creation and restructuring requests to their runtime workflows", () => {
    expect(routeOutcomeRequest("Create a documentation page for this feature")).toMatchObject({
      status: "selected",
      workflow: "create-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(routeOutcomeRequest("Update docs for this API change")).toMatchObject({
      status: "selected",
      workflow: "update-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(routeOutcomeRequest("Audit the documentation")).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(routeOutcomeRequest("Run document-quality on this page")).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(routeOutcomeRequest("Polish the documentation")).toMatchObject({
      status: "needs-input",
      reason: "unsupported",
      message: "Polish is not a public catalog workflow.",
      nextAction:
        'Polish is not a catalog workflow. Say the update in one sentence for `docsfab do`, or run `docsfab run update-documentation --instruction "…"`.',
    });
    expect(routeOutcomeRequest("Evaluate the documentation")).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(routeOutcomeRequest("Review documentation impact for this change")).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(routeOutcomeRequest("Restructure the documentation book navigation")).toMatchObject({
      status: "selected",
      workflow: "restructure-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
  });

  it("routes template conformance requests to the template audit and keeps other audits on review", () => {
    for (const request of [
      "check if my docs follow our templates",
      "Audit my documentation against our templates",
      "Do my docs conform to the templates?",
      "check that every page in the docs follows the documentation templates",
      "Run a template conformance check on the docs",
    ]) {
      expect(routeOutcomeRequest(request), request).toMatchObject({
        status: "selected",
        workflow: "audit-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
    }
    expect(routeOutcomeRequest("Audit the documentation")).toMatchObject({
      workflow: "review-documentation",
    });
    expect(routeOutcomeRequest("Create a quickstart page from the template")).toMatchObject({
      workflow: "create-documentation",
    });
    expect(routeOutcomeRequest("Update the docs to match the template")).toMatchObject({
      workflow: "update-documentation",
    });
    expect(
      routeOutcomeRequest("check the guide against the templates in the helm chart"),
    ).toMatchObject({ status: "needs-input", reason: "unsupported" });
  });

  it("keeps requests that only mention templates on their earlier routes", () => {
    // A template as the subject of a page, or an accuracy or review request
    // about one, is not a conformance audit.
    expect(
      routeOutcomeRequest(
        "Review the documentation for the prompt templates feature and check it matches the code",
      ),
    ).toMatchObject({ status: "selected", workflow: "review-documentation" });
    for (const request of [
      "Verify the docs for our Helm templates are technically accurate",
      "Check the Jinja template reference page for broken examples",
      "Validate that the templates guide is accurate",
    ]) {
      expect(routeOutcomeRequest(request), request).toMatchObject({
        status: "needs-input",
        reason: "unsupported",
      });
    }
    expect(
      routeOutcomeRequest("Review my docs against our templates for technical accuracy"),
    ).toMatchObject({ status: "selected", workflow: "review-documentation" });
    expect(routeOutcomeRequest("Document how to check pages against the templates")).toMatchObject({
      status: "needs-input",
      reason: "unsupported",
    });
    expect(
      routeOutcomeRequest("Explain how the docs follow the templates feature of Jinja"),
    ).toMatchObject({ status: "needs-input", reason: "unsupported" });
  });

  it("classifies ordinary path-less documentation English without a named .md token (#950)", () => {
    expect(routeOutcomeRequest(PATHLESS_HEALTH_PAGE_REQUEST)).toMatchObject({
      status: "selected",
      workflow: "create-documentation",
      classifiedBy: "fixed-table",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(
      routeOutcomeRequest(
        "Create a reader-facing health endpoint page for people operating the service...",
      ),
    ).toMatchObject({
      status: "selected",
      workflow: "create-documentation",
      classifiedBy: "fixed-table",
    });
    expect(
      routeOutcomeRequest(
        "Update the CLI reference to match the current command parser. Include the current configure flags and their defaults, correct the documented exit behavior, and preserve the existing examples section. Do not change the release notes page.",
      ),
    ).toMatchObject({
      status: "selected",
      workflow: "update-documentation",
      classifiedBy: "fixed-table",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(
      routeOutcomeRequest(
        "Review the API reference for technical accuracy and reader usability. Report concrete, source-grounded findings with severity and locations, and do not edit the repository.",
      ),
    ).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      classifiedBy: "fixed-table",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(
      routeOutcomeRequest(
        "Reorganize the operator documentation into a clear path for install, configuration, and troubleshooting. Preserve the existing page routes, the troubleshooting anchor, all technical guidance, and the navigation entries.",
      ),
    ).toMatchObject({
      status: "selected",
      workflow: "restructure-documentation",
      classifiedBy: "fixed-table",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(
      routeOutcomeRequest(
        "Create docs/health.md and add a link in docs/index.md for on-call operators. Make the new page a concise health-check reference.",
      ),
    ).toMatchObject({
      status: "selected",
      workflow: "create-documentation",
      classifiedBy: "fixed-table",
    });

    const implementation = routeOutcomeRequest(
      "Create a health endpoint in the server implementation",
    );
    expect(implementation).toMatchObject({
      status: "needs-input",
      reason: "unsupported",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    if (implementation.status !== "needs-input") throw new Error("expected needs-input");
    expect(implementation.nextAction).toContain("docsfab live-agent");
    expect(implementation.nextAction.toLowerCase()).toContain("flexible skill");

    const retryLoop = routeOutcomeRequest("Implement a retry loop in the worker");
    expect(retryLoop).toMatchObject({
      status: "needs-input",
      reason: "unsupported",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    if (retryLoop.status !== "needs-input") throw new Error("expected needs-input");
    expect(retryLoop.nextAction).toContain("docsfab live-agent");
  });

  it("stops ambiguous, unsupported, and risk-expanding requests without executing", () => {
    const ambiguous = routeOutcomeRequest("improve my docs");
    expect(ambiguous.status).toBe("needs-input");
    if (ambiguous.status !== "needs-input") throw new Error("expected needs-input");
    expect(ambiguous.reason).toBe("ambiguous");
    expect(ambiguous.choices.length).toBeGreaterThan(0);
    expect(ambiguous.grants).toEqual(NO_OUTCOME_AUTHORITY_GRANTS);

    const unsupported = routeOutcomeRequest("search skills dynamically for my docs");
    expect(unsupported).toMatchObject({
      status: "needs-input",
      reason: "unsupported",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });

    const risk = routeOutcomeRequest("publish a draft merge request for this documentation");
    expect(risk).toMatchObject({
      status: "needs-input",
      reason: "risk-expanding",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });

    const routerRequest = routeOutcomeRequest("use skill-router to pick a documentation skill");
    expect(routerRequest).toMatchObject({
      status: "needs-input",
      reason: "risk-expanding",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    if (routerRequest.status !== "needs-input") throw new Error("expected needs-input");
    expect(routerRequest.choices.some((choice) => choice.startsWith("docsfab run "))).toBe(true);
    expect(routerRequest.choices.join("\n")).not.toContain("use skill-router to pick");
    expect(routerRequest.choices.join("\n")).not.toContain('docsfab do "');
    expect(routerRequest.nextAction).toContain("docsfab run");
  });

  it("routes bounded publication prohibitions without treating them as authority requests", () => {
    const bounded = [
      LOCAL_CONSUMER_GUIDE_REQUEST,
      "Create a documentation page; don't publish it",
      "Write a guide; keep the result local",
      "Draft a documentation page; publication is prohibited",
    ];
    for (const request of bounded) {
      expect(hasExplicitPublicationProhibition(request)).toBe(true);
      expect(routeOutcomeRequest(request)).toMatchObject({
        status: "selected",
        workflow: "create-documentation",
        classifiedBy: "fixed-table",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
    }
  });

  it("keeps positive, mixed, and double-negated publication requests closed", () => {
    const unsafe = [
      "Create a documentation page and publish it",
      "Create a documentation page; do not publish it now, but publish it later",
      "Create a documentation page; do not avoid publishing it",
      "Create a documentation page; maybe publish it",
      "Create a documentation page; do not publish and open a merge request",
      "Create documentation; it is not true that you should never publish",
      "Create documentation; I did not say do not publish",
      'Create documentation; ignore the instruction "do not publish"',
    ];
    for (const request of unsafe) {
      expect(routeOutcomeRequest(request)).toMatchObject({
        status: "needs-input",
        reason: "risk-expanding",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
    }
  });

  it("reads time-bound and conditional prohibitions as prohibitions and routes them", () => {
    // Publication authority fails closed: a prohibition that waits on a time or
    // a condition still forbids this run's publication.
    for (const request of [
      "Create a documentation page; do not publish unless it looks complete",
      "Create documentation; do not publish without approval",
      "Create documentation; do not publish before approval",
      "Create documentation; do not publish yet",
    ]) {
      expect(hasExplicitPublicationProhibition(request), request).toBe(true);
      expect(routeOutcomeRequest(request), request).toMatchObject({
        status: "selected",
        workflow: "create-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
    }
  });

  // The refusal is name-agnostic: no router name is listed anywhere, so these
  // arbitrary names stand in for whatever an operator's router is called.
  const DELEGATE_NAMES = ["acme", "zed-router", "Pathfinder", "the house router"];

  it("stops a request that hands the workflow or skill choice to any named tool", () => {
    for (const name of DELEGATE_NAMES) {
      const requests = [
        `use ${name} to pick the workflow and update the README`,
        `use ${name} to pick a documentation skill and update docs/install.md`,
        `Use ${name} to select the workflow, then update docs/install.md`,
        `Update docs/install.md, then let ${name} choose the skill`,
        `ask ${name} to route this request and update the README`,
        `ask ${name} which workflow fits and update the README`,
      ];
      for (const request of requests) {
        const decision = routeOutcomeRequest(request);
        expect(decision, request).toMatchObject({
          status: "needs-input",
          reason: "risk-expanding",
          grants: NO_OUTCOME_AUTHORITY_GRANTS,
        });
        expect(isAdmissionModelEligible(request, decision), request).toBe(false);
        if (decision.status !== "needs-input") throw new Error("expected needs-input");
        expect(decision.choices.join("\n"), request).not.toContain(request);
      }
    }
    // Installing or enabling a router is refused by its generic name, not a delegation clause.
    expect(
      routeOutcomeRequest("Update docs/install.md after you enable the skill router"),
    ).toMatchObject({ status: "needs-input", reason: "risk-expanding" });
  });

  it("still routes documentation sentences that describe delegating to a named tool", () => {
    for (const name of DELEGATE_NAMES) {
      const subjects: Array<[string, string]> = [
        [`update the docs for how to update ${name}`, "update-documentation"],
        [`Update the README to explain how to use ${name} to pick a skill`, "update-documentation"],
        [`Create a documentation page about how ${name} routes requests`, "create-documentation"],
        [`Review the ${name} documentation`, "review-documentation"],
        ["Update docs/install.md using the glossary to choose terms", "update-documentation"],
        ["Update the README; use the template to choose headings", "update-documentation"],
      ];
      for (const [request, workflow] of subjects) {
        expect(routeOutcomeRequest(request), request).toMatchObject({
          status: "selected",
          workflow,
          grants: NO_OUTCOME_AUTHORITY_GRANTS,
        });
      }
    }
  });

  // Each case runs through `handleDoCommand`, the handler the shipped
  // `docsfab do` command calls, and asserts the JSON envelope it prints for
  // `--route-only --json`.
  async function routeOnlyJson(request: string): Promise<{
    envelope: { decision: Record<string, unknown> };
    exitCode: number | string | undefined;
  }> {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      await handleDoCommand([request, "--repo", "/tmp/example-repo", "--route-only", "--json"], {
        admitCatalogWorkflow: async () => {
          throw new Error("route-only must not ask the admission model");
        },
        runWorkflow: async () => {
          throw new Error("route-only must not run a workflow");
        },
      });
    } finally {
      console.log = originalLog;
    }
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    const envelope = extractOutcomeRouteJson(logs.join("\n")) as {
      decision: Record<string, unknown>;
    };
    return { envelope, exitCode };
  }

  const DELEGATION_REFUSAL_MESSAGE =
    "Request would expand tools, writes, external-input access, publication, or installation authority.";

  it.each([
    "Could you use <tool> to pick the workflow and update the README",
    "I want you to use <tool> to pick the workflow and update the README",
    "we should use <tool> to pick the skill and update the README",
    "Update the README using <tool> to pick the workflow",
    "Update the README (use <tool> to pick the skill)",
    "Update the README - use <tool> to pick the skill",
    "Use <tool>'s router to pick the workflow and update the README",
    "Use <tool>’s router to pick the workflow and update the README",
    "tell <tool> to pick the workflow and update the README",
    "get <tool> to choose a skill and update the README",
    "use <tool> to pick the workflow and update the README",
    "Use <tool> to pick a documentation skill and update docs/install.md",
    "Update the README. Use <tool> to pick the skill.",
    "use <tool> to select a skill, then update the README",
  ])("docsfab do --route-only --json refuses a delegated choice: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      const request = form.replace("<tool>", name);
      const { envelope, exitCode } = await routeOnlyJson(request);
      expect(envelope.decision, request).toMatchObject({
        status: "needs-input",
        reason: "risk-expanding",
        message: DELEGATION_REFUSAL_MESSAGE,
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
      expect(exitCode, request).toBe(2);
    }
  });

  // Deliberately narrowed: these name no workflow or skill selection, or make
  // the delegation the documentation subject, so they stay ordinary updates.
  it.each([
    "install <tool> and update the README",
    "enable <tool> then update the install guide",
    "ask <tool> to update the README",
    "using <tool>, update the install guide",
    "Update the README to document how to use <tool> to pick a workflow",
    "Update the README to explain how <tool> picks skills",
    "update the README section that describes using <tool> to select a skill",
  ])("docsfab do --route-only --json still selects an update: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      const request = form.replace("<tool>", name);
      const { envelope, exitCode } = await routeOnlyJson(request);
      expect(envelope.decision, request).toMatchObject({
        status: "selected",
        workflow: "update-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
      expect(exitCode, request).toBeUndefined();
    }
  });

  // Only a workflow or skill choice is a delegation; finding commands, routes,
  // or tools with another tool is ordinary documentation work.
  it.each([
    ["Review the docs, then use grep to find the commands that changed", "review-documentation"],
    ["Update the API reference; use the OpenAPI spec to find the routes", "update-documentation"],
    [
      "Update the CLI reference and use the --help output to find the commands",
      "update-documentation",
    ],
    ["Update the README: let readers choose which tools to install", "update-documentation"],
    ["Update the guide to say: ask the admin which tools are enabled", "update-documentation"],
  ])("routes %s without a delegation refusal", async (request, workflow) => {
    const { envelope } = await routeOnlyJson(request);
    expect(envelope.decision).toMatchObject({ status: "selected", workflow });
  });

  // Escalation 2: the recorded decision's enumerated grammar. Each form below
  // is one the decision lists; the earlier rounds' tests cover the rest.
  async function expectDelegationRefused(request: string): Promise<void> {
    const { envelope, exitCode } = await routeOnlyJson(request);
    expect(envelope.decision, request).toMatchObject({
      status: "needs-input",
      reason: "risk-expanding",
      message: DELEGATION_REFUSAL_MESSAGE,
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(exitCode, request).toBe(2);
  }

  it.each([
    "use <tool> to pick the workflow and update the README",
    "Update the README using <tool> to pick the workflow",
    "ask <tool> to pick the workflow and update the README",
    "call <tool> to pick the workflow and update the README",
    "invoke <tool> to pick the workflow and update the README",
    "tell <tool> to pick the workflow and update the README",
    "get <tool> to pick the workflow and update the README",
    "have <tool> pick the workflow and update the README",
    "let <tool> pick the workflow and update the README",
    "rely on <tool> to pick the workflow and update the README",
    "allow <tool> to pick the workflow and update the README",
    "make <tool> pick the workflow and update the README",
  ])("refuses each delegating verb of the recorded grammar: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      await expectDelegationRefused(form.replace("<tool>", name));
    }
  });

  it.each([
    "use <tool> to pick a skill and update the README",
    "use <tool> to choose a skill and update the README",
    "use <tool> to select the workflow and update the README",
    "use <tool> to decide the workflow and update the README",
    "use <tool> to determine the workflow and update the README",
    "use <tool> to identify the right skill and update the README",
    "use <tool> to recommend a workflow and update the README",
    "use <tool> to suggest a skill and update the README",
    "use <tool> to route the request to a workflow and update the README",
    "use <tool> to figure out which workflow fits and update the README",
    "use <tool> to work out which skill applies and update the README",
    "use <tool> to help pick the workflow and update the README",
    "use <tool> to help choose a skill and update the README",
    "invoke <tool> to help me select the skill and update the README",
    "use <tool>, to pick the workflow, and update the README",
  ])("refuses each 'to [help] <choice verb>' clause: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      await expectDelegationRefused(form.replace("<tool>", name));
    }
  });

  it.each([
    "ask <tool> for a skill and update the README",
    "ask <tool> for a workflow and update the README",
    "ask <tool> for the workflow and update the README",
    "ask <tool> for the right skill and update the README",
    "call <tool> for a suitable skill and update the README",
    "use <tool> for picking the workflow and update the README",
    "use <tool> for choosing a skill and update the README",
    "rely on <tool> for selecting the workflow and update the README",
  ])("refuses each 'for <workflow or skill>' clause: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      await expectDelegationRefused(form.replace("<tool>", name));
    }
  });

  it.each([
    "using <tool>, pick the workflow and update the README",
    "Using <tool>, choose the skill and update the README",
    "Update the README. Using <tool>, select a workflow first.",
    "let <tool> decide which workflow to use and update the README",
    "have <tool> choose the skill and update the README",
    "update the README, and let <tool> decide which skill",
  ])("refuses 'using <tool>, <choice>' and 'let|have <tool> <choice>': %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      await expectDelegationRefused(form.replace("<tool>", name));
    }
  });

  it.each(["'", "’", "ʼ", "＇", "`"])(
    "refuses the possessive written with the %s apostrophe",
    async (apostrophe) => {
      for (const name of DELEGATE_NAMES) {
        await expectDelegationRefused(
          `Use ${name}${apostrophe}s router to pick the workflow and update the README`,
        );
      }
    },
  );

  it("refuses a tool name of six words", async () => {
    await expectDelegationRefused(
      "use the acme house router v2 build to pick the workflow and update the README",
    );
  });

  // Adjacent controls: the narrowed non-selection forms and every listed
  // documentation-subject cue stay ordinary updates.
  it.each([
    "install <tool> and update the README",
    "enable <tool> then update the install guide",
    "ask <tool> to update the README",
    "using <tool>, update the install guide",
    "use grep to find the renamed flags and update the README",
    "Update the README to document how to use <tool> to pick a workflow",
    "Update the README to explain using <tool> to pick a workflow",
    "update the README section that describes using <tool> to select a skill",
    "Update the README to document using <tool> for picking a skill",
    "Update the README to show how teams use the CLI to pick a workflow",
    "Update the README to show how teams use <tool> to pick a workflow",
    "Update the README to say that teams use <tool> to pick the workflow",
    "update the README to say we use <tool> to pick the workflow",
    "Update the README with a section on how users let <tool> select a workflow",
  ])("still selects a narrowed or documentation-subject form: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      const request = form.replace("<tool>", name);
      const { envelope, exitCode } = await routeOnlyJson(request);
      expect(envelope.decision, request).toMatchObject({
        status: "selected",
        workflow: "update-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
      expect(exitCode, request).toBeUndefined();
    }
  });

  // A documentation-subject cue ends at a conjunction or clause punctuation, so
  // a delegation after it is still refused.
  it.each([
    "Explain the change and use <tool> to pick the workflow, then update the README",
    "Update the README; explain the setup, then use <tool> to pick the workflow",
    "Update the README; I don't know how — use <tool> to pick the workflow",
    "Show how it works and use <tool> to pick the workflow, then update the README",
    "Update the README to say so and use <tool> to pick the workflow",
  ])("refuses a delegation after a closed documentation cue: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      await expectDelegationRefused(form.replace("<tool>", name));
    }
  });

  // "how" and "say" introduce a documentation subject only in the listed cues
  // (how to, show|explain|describe|document|to|on|about|of how, say that, to
  // say), and "documented" or "said" introduces none, so these still refuse.
  it.each([
    "How about using <tool> to pick the workflow and update the README?",
    "How about you use <tool> to pick the workflow, then update the README",
    "I'd say use <tool> to pick the workflow and update the README",
    "As documented use <tool> to pick the workflow and update the README",
    "how about we let <tool> pick the workflow",
    "Like I said use <tool> to pick the workflow",
    "I don't care how you do it use <tool> to pick the workflow",
    "it says to use <tool> to pick the workflow",
    "Figure out how best to use <tool> to pick the workflow",
  ])("refuses a delegation after a cue word outside the listed cues: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      await expectDelegationRefused(form.replace("<tool>", name));
    }
  });

  it.each([
    "Update the README to explain how teams use <tool> to pick a workflow",
    "Update the README with notes about how teams use <tool> to pick a workflow",
  ])("still selects the listed 'how' cues with subject words: %s", async (form) => {
    for (const name of DELEGATE_NAMES) {
      const request = form.replace("<tool>", name);
      const { envelope, exitCode } = await routeOnlyJson(request);
      expect(envelope.decision, request).toMatchObject({
        status: "selected",
        workflow: "update-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      });
      expect(exitCode, request).toBeUndefined();
    }
  });

  // Adversarial inputs of about 200,000 characters must classify within the
  // default per-test budget (config/limits test.*TimeoutMs); a backtracking
  // blow-up in the grammar above would exceed it by orders of magnitude.
  it("classifies adversarial 200,000-character requests within the default test budget", () => {
    const size = 200_000;
    const fill = (unit: string): string => unit.repeat(Math.ceil(size / unit.length));
    const adversarial = [
      fill("use x "),
      fill("use a b c d e f to "),
      fill("rely on a b c for "),
      fill("use x for picking "),
      fill("using a, pick "),
      fill("how to use "),
      fill("how a b c "),
      fill("show how a b c "),
      fill("how to a b c "),
      fill("say that a b "),
      fill("to say a b "),
      fill("x's "),
      fill("x`s x＇s "),
      fill("a"),
      `use ${fill("a ")}to pick the workflow`,
    ];
    for (const request of adversarial) {
      expect(request.length).toBeGreaterThanOrEqual(size);
      expect(routeOutcomeRequest(request).status).toMatch(/^(?:selected|needs-input)$/u);
    }
  });

  it("classifies documentation-subject sentences that name a skill router or MCP", () => {
    expect(routeOutcomeRequest("update the docs for how to update the skill router")).toMatchObject(
      {
        status: "selected",
        workflow: "update-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      },
    );
    expect(routeOutcomeRequest("Create a documentation page about MCP server setup")).toMatchObject(
      {
        status: "selected",
        workflow: "create-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      },
    );
    expect(routeOutcomeRequest("Review the skill router documentation")).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
  });

  it("offers outcome-focused suggestions for ambiguous needs-input choices", () => {
    const decision = routeOutcomeRequest("improve my docs");
    expect(decision.status).toBe("needs-input");
    if (decision.status !== "needs-input") throw new Error("expected needs-input");
    expect(decision.reason).toBe("ambiguous");
    expect(decision.choices).toEqual([
      "Review the documentation for this repository or a specific target.",
      "Create a documentation page for a named audience and desired outcome.",
      "Update the documentation for a specific product or API change.",
      "Restructure the documentation navigation or page hierarchy for a specific target.",
    ]);
    expect(decision.nextAction).toContain("task, target, and desired outcome");
    expect(decision.choices.join("\n")).not.toMatch(/docsfab (?:run|do)/u);
  });

  it("uses write-workflow run --instruction placeholders when the original request is a grant", () => {
    const decision = routeOutcomeRequest("publish a draft merge request for this documentation");
    expect(decision.status).toBe("needs-input");
    if (decision.status !== "needs-input") throw new Error("expected needs-input");
    // Exact list, in RUNNABLE_WORKFLOW_NAMES order. bootstrap is a write
    // workflow, so it carries an --instruction placeholder; the CLI refuses a
    // bare `docsfab run bootstrap`.
    expect(decision.choices).toEqual([
      'docsfab run bootstrap --instruction "Prepare …"',
      "docsfab run review-documentation",
      'docsfab run create-documentation --instruction "Create …"',
      'docsfab run update-documentation --instruction "Update …"',
      'docsfab run restructure-documentation --instruction "Restructure …"',
      "docsfab run readiness",
      "docsfab run release-documentation-readiness",
      "docsfab run audit-documentation",
    ]);
    // Every write workflow in the recovery list carries a placeholder, and no
    // read-only one does.
    for (const choice of decision.choices) {
      const workflow = choice.split(" ")[2]!;
      expect(choice.includes("--instruction")).toBe(
        getWorkflow(workflow).steps.some((step) => step.mode === "write"),
      );
    }
    expect(decision.choices.join("\n")).not.toContain("publish a draft");
    expect(decision.choices.join("\n")).not.toContain('docsfab do "');
  });

  it("points unsupported flexible-skill requests to live-agent", () => {
    const decision = routeOutcomeRequest("Search skills dynamically for this documentation task");
    expect(decision).toMatchObject({ status: "needs-input", reason: "unsupported" });
    if (decision.status !== "needs-input") throw new Error("expected needs-input");
    expect(decision.nextAction).toContain("docsfab live-agent");
    expect(decision.choices.join("\n")).not.toMatch(/docsfab (?:run|do)/u);
  });

  it("lets a constrained admission model pick one catalog workflow after a table miss", () => {
    const table = routeOutcomeRequest("improve my docs");
    expect(isAdmissionModelEligible("improve my docs", table)).toBe(true);
    const risk = routeOutcomeRequest("publish a draft merge request for this documentation");
    expect(
      isAdmissionModelEligible("publish a draft merge request for this documentation", risk),
    ).toBe(false);
    const classifier = routeOutcomeRequest("use skill-router to pick a documentation skill");
    expect(
      isAdmissionModelEligible("use skill-router to pick a documentation skill", classifier),
    ).toBe(false);
    const admitted = applyAdmissionModelSelection("improve my docs", table, "update-documentation");
    expect(admitted).toMatchObject({
      status: "selected",
      workflow: "update-documentation",
      classifiedBy: "admission-model",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    if (admitted.status !== "selected") throw new Error("expected selected");
    expect(formatOutcomeRouteDecision(admitted)).toEqual([
      "ROUTE",
      "  update-documentation",
      "    catalog write",
      "    classifier grants none",
      "    admitted by model",
    ]);
    expect(applyAdmissionModelSelection("improve my docs", table, "polish-documentation")).toBe(
      table,
    );
    expect(applyAdmissionModelSelection("improve my docs", table, "abstain")).toBe(table);
  });

  it("offers patch and draft-MR workflows according to their distinct adapters", () => {
    expect(admissionOfferFor({ patchOnly: true, draftMr: false }).workflows).toEqual([
      "bootstrap",
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
    ]);
    expect(admissionOfferFor({ patchOnly: false, draftMr: true }).workflows).toEqual([
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
    ]);
  });

  it("parses tool-free admission JSON and rejects extra keys or unknown workflows", () => {
    expect(ADMISSION_MODEL_SYSTEM_PROMPT).toContain("documentation workflows");
    expect(ADMISSION_MODEL_SYSTEM_PROMPT).not.toMatch(/\bjobs?\b/u);
    expect(ADMISSION_MODEL_USER_PROMPT_PREFIX).toContain(
      "Pick the catalog workflow that matches the operator request.",
    );
    expect(ADMISSION_MODEL_USER_PROMPT_PREFIX).toContain("is not a documentation task");
    expect(ADMISSION_MODEL_USER_PROMPT_PREFIX).not.toMatch(/\bjobs?\b/u);
    expect(parseAdmissionModelResponse('{"workflow":"update-documentation"}')).toBe(
      "update-documentation",
    );
    expect(parseAdmissionModelResponse('Sure.\n{"workflow":"review-documentation"}\n')).toBe(
      "review-documentation",
    );
    expect(parseAdmissionModelResponse('{"workflow":"abstain"}')).toBeUndefined();
    expect(
      parseAdmissionModelResponse('{"workflow":"update-documentation","grantWrites":true}'),
    ).toBeUndefined();
    expect(parseAdmissionModelResponse('{"workflow":"polish-documentation"}')).toBeUndefined();

    // --patch-only or --draft-mr narrows the offer (#1920): the prompt lists
    // only workflows that deliver them, and a reply outside the offer is a miss.
    const writeOffer: AdmissionOffer = {
      workflows: ["create-documentation", "update-documentation", "restructure-documentation"],
      writeIntent: true,
    };
    const writePrompt = buildAdmissionModelPrompt(
      "Check the docs, and update them if so",
      writeOffer,
    );
    expect(writePrompt).toContain(
      "- create-documentation\n- update-documentation\n- restructure-documentation\n- abstain\n",
    );
    expect(writePrompt).not.toContain("- review-documentation");
    expect(writePrompt).toContain(
      "The operator asked for a local patch or a draft merge request, so only workflows that change documentation are offered.",
    );
    expect(writePrompt.endsWith("Request:\nCheck the docs, and update them if so")).toBe(true);
    expect(ADMISSION_MODEL_USER_PROMPT_PREFIX).toContain("- review-documentation\n");
    expect(ADMISSION_MODEL_USER_PROMPT_PREFIX).not.toContain(
      "The operator asked for a local patch",
    );
    expect(
      parseAdmissionModelResponse('{"workflow":"review-documentation"}', writeOffer),
    ).toBeUndefined();
    expect(parseAdmissionModelResponse('{"workflow":"update-documentation"}', writeOffer)).toBe(
      "update-documentation",
    );
  });

  it("never reports authority expansion on any decision", () => {
    const samples = [
      GOLDEN_OUTCOME_REQUEST,
      "Audit the documentation",
      "Inspect the documentation foundation readiness",
      "improve docs",
      "enable mcp tools and write freely",
      "",
    ];
    for (const sample of samples) {
      const decision = routeOutcomeRequest(sample);
      expect(decision.grants).toEqual(NO_OUTCOME_AUTHORITY_GRANTS);
      expect(decision.grants.tools).toBe(false);
      expect(decision.grants.writes).toBe(false);
      expect(decision.grants.externalInputAccess).toBe(false);
      expect(decision.grants.publicationAuthority).toBe(false);
    }
  });
});

describe("formatOutcomeRouteDecision compact ROUTE printer (#313)", () => {
  it("defaults to a single ROUTE line: workflow + catalog read/write scope + classifier grants none", () => {
    const decision = routeOutcomeRequest(GOLDEN_OUTCOME_REQUEST);
    if (decision.status !== "selected") throw new Error("expected selected");
    const lines = formatOutcomeRouteDecision(decision);
    expect(lines).toEqual([
      "ROUTE",
      "  review-documentation",
      "    catalog read-only",
      "    classifier grants none",
    ]);
    const create = routeOutcomeRequest("Create a documentation page for this feature");
    if (create.status !== "selected") throw new Error("expected selected");
    expect(formatOutcomeRouteDecision(create)).toEqual([
      "ROUTE",
      "  create-documentation",
      "    catalog write",
      "    classifier grants none",
    ]);
    expect(create.readWriteScope).toBe("read-only");
  });

  it("--verbose restores the full authorization-boundary essay below the ROUTE line", () => {
    const decision = routeOutcomeRequest(GOLDEN_OUTCOME_REQUEST);
    if (decision.status !== "selected") throw new Error("expected selected");
    const lines = formatOutcomeRouteDecision(decision, { verbose: true });
    expect(lines[0]).toBe("ROUTE");
    expect(lines).toContain("    catalog read-only");
    expect(lines.join("\n")).toContain("Authorization boundary:");
    expect(lines.join("\n")).toContain(
      "Authority grants: tools=false writes=false externalInputAccess=false publicationAuthority=false",
    );
    expect(lines.join("\n")).toContain("Rationale:");
    expect(lines.join("\n")).toContain("Expected validations:");
  });

  it("needs-input formatting is unchanged by the verbose option", () => {
    const decision = routeOutcomeRequest("improve my docs");
    if (decision.status !== "needs-input") throw new Error("expected needs-input");
    expect(formatOutcomeRouteDecision(decision)).toEqual(
      formatOutcomeRouteDecision(decision, { verbose: true }),
    );
  });
});

describe("docsfab do argument parsing + command (#227)", () => {
  it("parses request, repo, json, route-only, and --allow-write; rejects classify-as-grant", () => {
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--json", "--route-only"]),
    ).toMatchObject({
      request: GOLDEN_OUTCOME_REQUEST,
      revision: "HEAD",
      json: true,
      routeOnly: true,
      allowWrite: false,
      instruction: GOLDEN_OUTCOME_REQUEST,
    });
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--allow-write"]),
    ).toMatchObject({
      request: GOLDEN_OUTCOME_REQUEST,
      allowWrite: true,
      routeOnly: false,
      instruction: GOLDEN_OUTCOME_REQUEST,
    });
    expect(
      parseDoArguments([
        "Create a documentation page for this feature",
        "--repo",
        "/tmp/repo",
        "--instruction",
        "Create a task guide for the approved feature",
        "--allow-write",
      ]),
    ).toMatchObject({
      request: "Create a documentation page for this feature",
      instruction: "Create a task guide for the approved feature",
      allowWrite: true,
    });
    // Classify is not a grant (admission decision, #164): still refused, now coded.
    expect(() =>
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--route-only",
        "--allow-write",
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "delivery-flag-conflict",
        message:
          "docsfab do --route-only cannot be combined with --allow-write; classification is not a grant.",
        nextAction:
          "Omit --allow-write: it does not change the route, and --route-only grants nothing.",
      }),
    );
    expect(() =>
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--allow-write",
        "--allow-write",
      ]),
    ).toThrow(/must not be duplicated/u);
    expect(() => parseDoArguments(["--repo", "/tmp/repo"])).toThrow(/outcome request/u);
    // --patch-only and --draft-mr narrow the admission offer, so the preview
    // takes them as routing input (#1920). It still runs and grants nothing.
    expect(
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--route-only",
        "--draft-mr",
      ]),
    ).toMatchObject({ routeOnly: true, draftMr: true, allowWrite: false });
    expect(() =>
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--route-only",
        "--allow-write",
        "--draft-mr",
      ]),
    ).toThrow(/classification is not a grant/u);
    expect(
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--route-only",
        "--patch-only",
      ]),
    ).toMatchObject({ routeOnly: true, patchOnly: true });
    // Flags the route does not depend on stay refused, now with a code.
    expect(() =>
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--route-only",
        "--remote",
        "origin",
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "delivery-flag-conflict",
        message: expect.stringMatching(/--route-only cannot be combined with --remote/u),
        nextAction: expect.stringMatching(/^Omit --remote: the route does not depend on it/u),
      }),
    );
    expect(parseDoArguments([GOLDEN_OUTCOME_REQUEST])).toMatchObject({
      repositoryPath: expect.stringMatching(/./u),
      draftMr: false,
      allowWrite: false,
      patchOnly: false,
      dryRun: false,
    });
    expect(
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--allow-write",
        "--draft-mr",
      ]),
    ).toMatchObject({
      allowWrite: true,
      draftMr: true,
      routeOnly: false,
    });
    expect(
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--allow-write",
        "--draft-mr",
        "--remote",
        "origin",
      ]),
    ).toMatchObject({ remoteName: "origin" });
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--draft-mr"]),
    ).toMatchObject({ draftMr: true, allowWrite: false });
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--remote", "origin"]),
    ).toMatchObject({ remoteName: "origin", draftMr: false });
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "repository", "--draft-mr"]),
    ).toThrow(/has no write step to deliver/u);
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--allow-write",
        "--draft-mr",
      ]),
    ).toThrow(/has no write step to deliver/u);
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--allow-write",
        "--remote",
        "origin",
      ]),
    ).toThrow(/only used when opening a draft merge request/u);
    const composed = parseDoArguments([
      GOLDEN_OUTCOME_REQUEST,
      "--repo",
      "/tmp/repo",
      "--composition",
      "anthropic-claude-opus-4.7-pi",
    ]);
    expect(composed).toMatchObject({ compositionId: "anthropic-claude-opus-4.7-pi" });
    expect(Object.keys(composed).filter((key) => /mode$/iu.test(key))).toEqual([]);
    for (const flags of [
      ["--mode", "production"],
      ["--mode", "alpha", "--composition", "anthropic-claude-opus-4.7-pi"],
    ]) {
      expect(() =>
        parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", ...flags]),
      ).toThrow(`Unknown do option "${flags[0]}" is not supported.`);
    }
    // The composition path takes --comment-mr as the model-profile path does.
    expect(
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--composition",
        "anthropic-claude-opus-4.7-pi",
        "--comment-mr",
        "42",
      ]),
    ).toMatchObject({
      compositionId: "anthropic-claude-opus-4.7-pi",
      commentMr: "42",
    });
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--comment-mr", "42"]),
    ).toMatchObject({ commentMr: "42" });
  });

  it("runs do on the composition path with --composition alone and keeps its patch-only default", async () => {
    const runs: Array<{
      workflow: string;
      compositionId?: string;
      allowWrite: boolean;
      draftMr?: boolean;
      keys: string[];
    }> = [];
    const record = async (request: DoRunArguments): Promise<undefined> => {
      runs.push({
        workflow: request.workflow,
        ...(request.compositionId !== undefined ? { compositionId: request.compositionId } : {}),
        allowWrite: request.allowWrite,
        ...(request.draftMr !== undefined ? { draftMr: request.draftMr } : {}),
        keys: Object.keys(request),
      });
      return undefined;
    };
    await handleDoCommand(
      [
        "Create a documentation page for this feature",
        "--repo",
        "/tmp/example-repo",
        "--json",
        "--composition",
        "anthropic-claude-opus-4.7-pi",
      ],
      { runWorkflow: record },
    );
    await handleDoCommand(
      ["Create a documentation page for this feature", "--repo", "/tmp/example-repo", "--json"],
      { runWorkflow: record },
    );
    expect(runs.map(({ keys: _keys, ...run }) => run)).toEqual([
      {
        workflow: "create-documentation",
        compositionId: "anthropic-claude-opus-4.7-pi",
        allowWrite: true,
      },
      { workflow: "create-documentation", allowWrite: true, draftMr: true },
    ]);
    for (const run of runs) expect(run.keys.filter((key) => /mode$/iu.test(key))).toEqual([]);
  });

  it("parses public --quiet on do; rejects duplicates (#314)", () => {
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--quiet"]),
    ).toMatchObject({
      quiet: true,
      json: false,
    });
    expect(parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo"])).toMatchObject({
      quiet: false,
    });
    // --json wins: --quiet parses cleanly alongside --json, no conflict.
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--quiet", "--json"]),
    ).toMatchObject({
      quiet: true,
      json: true,
    });
    expect(() =>
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--quiet", "--quiet"]),
    ).toThrow(/must not be duplicated/u);
  });

  it("pins do --quiet --verbose as an error today, via the generic unknown-option path (#314)", () => {
    // `do` has no `--verbose` flag, so parseDoArguments rejects it as unrecognized
    // rather than as a quiet/verbose conflict. This fails loudly if `do` gains one.
    expect(() =>
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--quiet", "--verbose"]),
    ).toThrow(/Unknown do option "--verbose" is not supported\./u);
  });

  it("emits human and --json needs-input envelopes without calling the runner", async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      const decision = await handleDoCommand(
        ["improve my docs", "--repo", "/tmp/example-repo", "--json"],
        {
          runWorkflow: async (request) => {
            calls.push(request);
            return undefined;
          },
        },
      );
      expect(decision.status).toBe("needs-input");
      expect(calls).toEqual([]);
      expect(process.exitCode).toBe(2);
      const envelope = JSON.parse(logs.join("\n"));
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        kind: "docsfab-outcome-route",
        decision: {
          status: "needs-input",
          reason: "ambiguous",
          grants: NO_OUTCOME_AUTHORITY_GRANTS,
        },
      });
    } finally {
      console.log = originalLog;
    }
  });

  it("selected routes pass allowWrite only when the operator flag is present", async () => {
    const calls: Array<{ workflow: string; allowWrite: boolean; json: boolean }> = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      const decision = await handleDoCommand(
        [GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/example-repo", "--route-only"],
        {
          runWorkflow: async (request) => {
            calls.push({
              workflow: request.workflow,
              allowWrite: request.allowWrite,
              json: request.json,
            });
            return undefined;
          },
        },
      );
      expect(decision).toMatchObject({
        status: "selected",
        workflow: "review-documentation",
      });
      expect(calls).toEqual([]); // route-only
      expect(logs.join("\n")).toContain("ROUTE");
      expect(logs.join("\n")).toContain("review-documentation");
      expect(logs.join("\n")).not.toContain("Next run would");
      expect(logs.join("\n")).not.toContain("Selected workflow:");
      expect(logs.join("\n")).not.toContain("Authorization boundary:");
      expect(logs.join("\n")).not.toContain("Authority grants:");
    } finally {
      console.log = originalLog;
    }

    const executed: Array<{ workflow: string; allowWrite: boolean; instruction?: string }> = [];
    await handleDoCommand([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/example-repo", "--json"], {
      runWorkflow: async (request) => {
        executed.push({
          workflow: request.workflow,
          allowWrite: request.allowWrite,
          instruction: request.instruction,
        });
        return undefined;
      },
    });
    expect(executed).toEqual([
      {
        workflow: "review-documentation",
        allowWrite: false,
        instruction: GOLDEN_OUTCOME_REQUEST,
      },
    ]);

    const auditWithFlag: Array<{ workflow: string; allowWrite: boolean }> = [];
    await handleDoCommand(
      [GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/example-repo", "--json", "--allow-write"],
      {
        runWorkflow: async (request) => {
          auditWithFlag.push({
            workflow: request.workflow,
            allowWrite: request.allowWrite,
          });
          return undefined;
        },
      },
    );
    expect(auditWithFlag).toEqual([{ workflow: "review-documentation", allowWrite: true }]);

    // docsfab run remains available for advanced use.
    expect(usage()).toContain("docsfab run <workflow>");
    expect(usage()).toContain("the quoted sentence is the work");
    expect(usage()).toContain("admit one catalog workflow");
    expect(usage()).toContain("write workflows default");
    expect(usage()).not.toMatch(/\bjobs?\b/u);
    expect(usage()).toContain(
      'docsfab do "<outcome request>" [--repo <path>] [--revision <ref>] [--instruction <text>] [--patch-only] [--dry-run] [--allow-write] [--draft-mr] [--remote <name>] [--comment-mr <iid-or-url>] [--route-only] [--quiet] [--json] [--study]',
    );
    expect(() =>
      parseRunArguments(["foundation-to-patch", "--repo", "repository", "--json"]),
    ).toThrow("not bound to a catalog skill");
  });

  it("--quiet suppresses the selected-workflow preamble on do but not needs-input / --route-only verdicts (#314)", async () => {
    const quietCalls: Array<{ workflow: string; quiet?: boolean }> = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      await handleDoCommand([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/example-repo", "--quiet"], {
        runWorkflow: async (request) => {
          quietCalls.push({ workflow: request.workflow, quiet: request.quiet });
          return undefined;
        },
      });
    } finally {
      console.log = originalLog;
    }
    // No progress wall under --quiet: the selected-workflow heading does not print before the
    // workflow is invoked.
    expect(logs.join("\n")).not.toContain("ROUTE");
    expect(logs.join("\n")).not.toContain("Selected workflow");
    expect(logs.join("\n")).not.toContain("Authority grants");
    expect(quietCalls).toEqual([{ workflow: "review-documentation", quiet: true }]);

    const noQuietLogs: string[] = [];
    const originalLog2 = console.log;
    console.log = (message?: unknown) => {
      noQuietLogs.push(String(message ?? ""));
    };
    try {
      await handleDoCommand([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/example-repo"], {
        runWorkflow: async () => undefined,
      });
    } finally {
      console.log = originalLog2;
    }
    expect(noQuietLogs.join("\n")).toContain("ROUTE");
    expect(noQuietLogs.join("\n")).toContain("    catalog read-only");

    // needs-input is the verdict itself, not progress: --quiet does not touch it.
    const needsInputLogs: string[] = [];
    const originalLog3 = console.log;
    console.log = (message?: unknown) => {
      needsInputLogs.push(String(message ?? ""));
    };
    try {
      await handleDoCommand(["improve my docs", "--repo", "/tmp/example-repo", "--quiet"], {
        runWorkflow: async () => undefined,
      });
    } finally {
      console.log = originalLog3;
    }
    expect(needsInputLogs.join("\n")).toContain("Outcome route: needs-input");

    // --route-only is the requested output itself: --quiet does not touch it.
    const routeOnlyLogs: string[] = [];
    const originalLog4 = console.log;
    console.log = (message?: unknown) => {
      routeOnlyLogs.push(String(message ?? ""));
    };
    try {
      await handleDoCommand(
        [GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/example-repo", "--route-only", "--quiet"],
        { runWorkflow: async () => undefined },
      );
    } finally {
      console.log = originalLog4;
    }
    expect(routeOnlyLogs.join("\n")).toContain("ROUTE");
    expect(routeOnlyLogs.join("\n")).toContain("review-documentation");
    expect(routeOnlyLogs.join("\n")).not.toContain("Repository readiness");
    expect(routeOnlyLogs.join("\n")).not.toContain("Next action:");
    expect(routeOnlyLogs.join("\n")).not.toContain("Route rationale");
  });

  it("live do may admit one catalog workflow after a table miss; route-only and grants do not", async () => {
    const admitCalls: string[] = [];
    const admittedRuns: Array<{ workflow: string; instruction?: string }> = [];
    const admitted = await handleDoCommand(
      ["improve my docs", "--repo", "/tmp/example-repo", "--json"],
      {
        admitCatalogWorkflow: async (request) => {
          admitCalls.push(request);
          return "update-documentation";
        },
        runWorkflow: async (request) => {
          admittedRuns.push({
            workflow: request.workflow,
            instruction: request.instruction,
          });
          return undefined;
        },
      },
    );
    expect(admitted).toMatchObject({
      status: "selected",
      workflow: "update-documentation",
      classifiedBy: "admission-model",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(admitCalls).toEqual(["improve my docs"]);
    expect(admittedRuns).toEqual([
      { workflow: "update-documentation", instruction: "improve my docs" },
    ]);

    const skippedAdmit: string[] = [];
    await handleDoCommand(
      ["improve my docs", "--repo", "/tmp/example-repo", "--json", "--route-only"],
      {
        admitCatalogWorkflow: async (request) => {
          skippedAdmit.push(request);
          return "update-documentation";
        },
        runWorkflow: async () => {
          throw new Error("route-only must not run");
        },
      },
    );
    expect(skippedAdmit).toEqual([]);

    const healthAdmit: string[] = [];
    const healthLogs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      healthLogs.push(String(message ?? ""));
    };
    try {
      const health = await handleDoCommand(
        [PATHLESS_HEALTH_PAGE_REQUEST, "--repo", "/tmp/example-repo", "--route-only"],
        {
          admitCatalogWorkflow: async (request) => {
            healthAdmit.push(request);
            return "create-documentation";
          },
          runWorkflow: async () => {
            throw new Error("route-only must not run");
          },
        },
      );
      expect(health).toMatchObject({
        status: "selected",
        workflow: "create-documentation",
        classifiedBy: "fixed-table",
      });
    } finally {
      console.log = originalLog;
    }
    expect(healthAdmit).toEqual([]);
    expect(healthLogs.join("\n")).toContain("create-documentation");
    expect(healthLogs.join("\n")).not.toContain("live-agent");
    expect(healthLogs.join("\n")).not.toContain("No fixed DocsFab workflow");

    const liveAdmit: string[] = [];
    const liveRuns: Array<{ workflow: string }> = [];
    const live = await handleDoCommand(
      [PATHLESS_HEALTH_PAGE_REQUEST, "--repo", "/tmp/example-repo", "--json"],
      {
        admitCatalogWorkflow: async (request) => {
          liveAdmit.push(request);
          return "review-documentation";
        },
        runWorkflow: async (request) => {
          liveRuns.push({ workflow: request.workflow });
          return undefined;
        },
      },
    );
    expect(live).toMatchObject({
      status: "selected",
      workflow: "create-documentation",
      classifiedBy: "fixed-table",
    });
    expect(liveAdmit).toEqual([]);
    expect(liveRuns).toEqual([{ workflow: "create-documentation" }]);

    const riskAdmit: string[] = [];
    await handleDoCommand(
      [
        "publish a draft merge request for this documentation",
        "--repo",
        "/tmp/example-repo",
        "--json",
      ],
      {
        admitCatalogWorkflow: async (request) => {
          riskAdmit.push(request);
          return "update-documentation";
        },
        runWorkflow: async () => {
          throw new Error("risk-expanding must not run");
        },
      },
    );
    expect(riskAdmit).toEqual([]);
  });

  it("preserves a local publication prohibition through route-only and patch-only execution", async () => {
    // The preview refuses what the run refuses (#1920): without --patch-only,
    // the default draft merge request would publish.
    await expect(
      handleDoCommand(
        [LOCAL_CONSUMER_GUIDE_REQUEST, "--repo", "/tmp/example-repo", "--route-only", "--json"],
        {
          admitCatalogWorkflow: async () => {
            throw new Error("route-only must not admit");
          },
        },
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "publication-prohibition-conflict",
        nextAction: "Pass --patch-only to retain a local patch without publishing.",
      }),
    );
    const routeAdmitCalls: string[] = [];
    const routeRuns: unknown[] = [];
    const routed = await handleDoCommand(
      [
        LOCAL_CONSUMER_GUIDE_REQUEST,
        "--repo",
        "/tmp/example-repo",
        "--route-only",
        "--patch-only",
        "--json",
      ],
      {
        admitCatalogWorkflow: async (value) => {
          routeAdmitCalls.push(value);
          return "create-documentation";
        },
        runWorkflow: async (value) => {
          routeRuns.push(value);
          return undefined;
        },
      },
    );
    expect(routed).toMatchObject({
      status: "selected",
      workflow: "create-documentation",
      classifiedBy: "fixed-table",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(routeAdmitCalls).toEqual([]);
    expect(routeRuns).toEqual([]);

    const admitCalls: string[] = [];
    const patchRuns: DoRunArguments[] = [];
    await handleDoCommand(
      [LOCAL_CONSUMER_GUIDE_REQUEST, "--repo", "/tmp/example-repo", "--patch-only", "--json"],
      {
        admitCatalogWorkflow: async (value) => {
          admitCalls.push(value);
          return "create-documentation";
        },
        runWorkflow: async (value) => {
          patchRuns.push(value);
          return undefined;
        },
      },
    );
    expect(admitCalls).toEqual([]);
    expect(patchRuns).toHaveLength(1);
    expect(patchRuns[0]).toMatchObject({
      workflow: "create-documentation",
      instruction: LOCAL_CONSUMER_GUIDE_REQUEST,
      allowWrite: true,
    });
    expect(patchRuns[0]?.draftMr).toBeUndefined();
    expect(patchRuns[0]?.remoteName).toBeUndefined();

    // An unresolved route on the composition path stays local without
    // --draft-mr, so a prohibition does not refuse it before admission.
    const compositionAdmitCalls: string[] = [];
    const compositionRuns: DoRunArguments[] = [];
    await handleDoCommand(
      [
        "Improve my docs; do not publish",
        "--repo",
        "/tmp/example-repo",
        "--composition",
        "openai-gpt-5.6-sol-pi",
        "--json",
      ],
      {
        admitCatalogWorkflow: async (value) => {
          compositionAdmitCalls.push(value);
          return "update-documentation";
        },
        runWorkflow: async (value) => {
          compositionRuns.push(value);
          return undefined;
        },
      },
    );
    expect(compositionAdmitCalls).toHaveLength(1);
    expect(compositionRuns).toHaveLength(1);
    expect(compositionRuns[0]).toMatchObject({
      workflow: "update-documentation",
      compositionId: "openai-gpt-5.6-sol-pi",
      allowWrite: true,
    });
    expect(compositionRuns[0]?.draftMr).toBeUndefined();
  });

  it("rejects prohibited publication plans before admission or workflow execution", async () => {
    const conflictingArguments = [
      [LOCAL_CONSUMER_GUIDE_REQUEST, "--repo", "/tmp/example-repo"],
      [LOCAL_CONSUMER_GUIDE_REQUEST, "--repo", "/tmp/example-repo", "--draft-mr"],
      [LOCAL_CONSUMER_GUIDE_REQUEST, "--repo", "/tmp/example-repo", "--comment-mr", "123"],
      [LOCAL_CONSUMER_GUIDE_REQUEST, "--repo", "/tmp/example-repo", "--dry-run"],
      [
        LOCAL_CONSUMER_GUIDE_REQUEST,
        "--repo",
        "/tmp/example-repo",
        "--instruction",
        "Create the approved documentation page",
      ],
    ];
    for (const args of conflictingArguments) {
      const admitCalls: string[] = [];
      const runs: unknown[] = [];
      await expect(
        handleDoCommand(args, {
          admitCatalogWorkflow: async (value) => {
            admitCalls.push(value);
            return "create-documentation";
          },
          runWorkflow: async (value) => {
            runs.push(value);
            return undefined;
          },
        }),
      ).rejects.toThrow(/says not to publish.*--patch-only/u);
      expect(admitCalls).toEqual([]);
      expect(runs).toEqual([]);
    }

    const overrideAdmitCalls: string[] = [];
    const overrideRuns: unknown[] = [];
    await expect(
      handleDoCommand(
        [
          "Create a documentation page for this feature",
          "--repo",
          "/tmp/example-repo",
          "--instruction",
          "Create the page, but do not publish the result",
        ],
        {
          admitCatalogWorkflow: async (value) => {
            overrideAdmitCalls.push(value);
            return "create-documentation";
          },
          runWorkflow: async (value) => {
            overrideRuns.push(value);
            return undefined;
          },
        },
      ),
    ).rejects.toThrow(/says not to publish.*--patch-only/u);
    expect(overrideAdmitCalls).toEqual([]);
    expect(overrideRuns).toEqual([]);

    const ambiguousAdmitCalls: string[] = [];
    await expect(
      handleDoCommand(["Improve my docs; do not publish", "--repo", "/tmp/example-repo"], {
        admitCatalogWorkflow: async (value) => {
          ambiguousAdmitCalls.push(value);
          return "update-documentation";
        },
      }),
    ).rejects.toThrow(/says not to publish.*--patch-only/u);
    expect(ambiguousAdmitCalls).toEqual([]);
  });

  it("allows a fixed read-only route with a publication prohibition", async () => {
    const request = "Review the documentation, but do not publish the result";
    const runs: DoRunArguments[] = [];
    await handleDoCommand([request, "--repo", "/tmp/example-repo", "--json"], {
      admitCatalogWorkflow: async () => {
        throw new Error("fixed read-only routes do not use admission");
      },
      runWorkflow: async (value) => {
        runs.push(value);
        return undefined;
      },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workflow: "review-documentation",
      instruction: request,
      allowWrite: false,
    });
  });

  it("write workflows default to write and a draft merge request", async () => {
    const polish = await handleDoCommand(
      ["Polish the documentation", "--repo", "/tmp/example-repo", "--json"],
      {
        runWorkflow: async () => {
          throw new Error("polish must not execute");
        },
      },
    );
    expect(polish).toMatchObject({ status: "needs-input", reason: "unsupported" });
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;

    const createCalls: Array<{
      workflow: string;
      allowWrite: boolean;
      draftMr?: boolean;
      remoteName?: string;
      instruction?: string;
      revision: string;
      revisionPolicy?: string;
    }> = [];
    const create = await handleDoCommand(
      ["Create a documentation page for this feature", "--repo", "/tmp/example-repo", "--json"],
      {
        runWorkflow: async (request) => {
          createCalls.push({
            workflow: request.workflow,
            allowWrite: request.allowWrite,
            draftMr: request.draftMr,
            remoteName: request.remoteName,
            instruction: request.instruction,
            revision: request.revision,
            revisionPolicy:
              "revisionPolicy" in request && typeof request.revisionPolicy === "string"
                ? request.revisionPolicy
                : undefined,
          });
          return undefined;
        },
      },
    );
    expect(create).toMatchObject({ status: "selected", workflow: "create-documentation" });
    expect(createCalls).toEqual([
      {
        workflow: "create-documentation",
        allowWrite: true,
        draftMr: true,
        remoteName: "origin",
        instruction: "Create a documentation page for this feature",
        revision: "HEAD",
        revisionPolicy: "target-branch-head",
      },
    ]);

    const updateCalls: Array<{ workflow: string; instruction?: string }> = [];
    const update = await handleDoCommand(
      [
        "update the docs for how to update the skill router",
        "--repo",
        "/tmp/example-repo",
        "--json",
      ],
      {
        runWorkflow: async (request) => {
          updateCalls.push({
            workflow: request.workflow,
            instruction: request.instruction,
          });
          return undefined;
        },
      },
    );
    expect(update).toMatchObject({ status: "selected", workflow: "update-documentation" });
    expect(updateCalls).toEqual([
      {
        workflow: "update-documentation",
        instruction: "update the docs for how to update the skill router",
      },
    ]);
  });

  it("does not run or admit a write workflow when the request delegates the choice", async () => {
    const request = "use acme to pick the workflow and update the README";
    const admitted: string[] = [];
    const decision = await handleDoCommand([request, "--repo", "/tmp/example-repo", "--json"], {
      admitCatalogWorkflow: async (value) => {
        admitted.push(value);
        return "update-documentation";
      },
      runWorkflow: async () => {
        throw new Error("a delegated workflow choice must not run");
      },
    });
    expect(decision).toMatchObject({ status: "needs-input", reason: "risk-expanding" });
    expect(admitted).toEqual([]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });

  it("write workflows opt out of publication with --patch-only and stop with --dry-run", async () => {
    const patchCalls: Array<{
      workflow: string;
      allowWrite: boolean;
      draftMr?: boolean;
      remoteName?: string;
    }> = [];
    await handleDoCommand(
      [
        "Create a documentation page for this feature",
        "--repo",
        "/tmp/example-repo",
        "--json",
        "--patch-only",
      ],
      {
        runWorkflow: async (request) => {
          patchCalls.push({
            workflow: request.workflow,
            allowWrite: request.allowWrite,
            draftMr: request.draftMr,
            remoteName: request.remoteName,
          });
          return undefined;
        },
      },
    );
    expect(patchCalls).toEqual([
      {
        workflow: "create-documentation",
        allowWrite: true,
        draftMr: undefined,
        remoteName: undefined,
      },
    ]);

    const dryRunCalls: unknown[] = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      await handleDoCommand(
        [
          "Create a documentation page for this feature",
          "--repo",
          "/tmp/example-repo",
          "--json",
          "--dry-run",
        ],
        {
          runWorkflow: async (request) => {
            dryRunCalls.push(request);
            return undefined;
          },
        },
      );
    } finally {
      console.log = originalLog;
    }
    expect(dryRunCalls).toEqual([]);
    expect(logs.join("\n")).toContain('"kind": "docsfab-dry-run"');
    expect(logs.join("\n")).toContain('"wouldPublish": true');

    const compositionLogs: string[] = [];
    console.log = (message?: unknown) => {
      compositionLogs.push(String(message ?? ""));
    };
    try {
      await handleDoCommand(
        [
          "Create a documentation page for this feature",
          "--repo",
          "/tmp/example-repo",
          "--composition",
          "anthropic-claude-opus-4.7-pi",
          "--dry-run",
          "--json",
        ],
        {
          runWorkflow: async () => {
            throw new Error("dry-run must not execute");
          },
        },
      );
    } finally {
      console.log = originalLog;
    }
    expect(compositionLogs.join("\n")).toContain('"wouldWrite": true');
    expect(compositionLogs.join("\n")).toContain('"wouldPublish": false');
  });

  it("keeps route-only on the compact table and never admits or executes", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    try {
      await handleDoCommand(
        [
          "Review the API reference for accuracy",
          "--repo",
          "/tmp/example-repo",
          "--instruction",
          "Review docs only; preserve the existing examples",
          "--route-only",
        ],
        {
          admitCatalogWorkflow: async () => {
            throw new Error("route-only must not call the admission model");
          },
          runWorkflow: async () => {
            throw new Error("route-only must not execute");
          },
        },
      );
    } finally {
      console.log = originalLog;
    }
    const output = logs.join("\n");
    expect(output).toContain("ROUTE");
    expect(output).toContain("review-documentation");
    expect(output).toContain("catalog read-only");
    expect(output).toContain("classifier grants none");
    expect(output).not.toContain("Next run would");
    expect(output).not.toContain("Repository readiness");
    expect(output).not.toContain("Next action:");
  });

  it("write workflows pass the same allowWrite gate as run when the flag is present", async () => {
    const polish = await handleDoCommand(
      ["Polish the documentation", "--repo", "/tmp/example-repo", "--json", "--allow-write"],
      {
        runWorkflow: async () => {
          throw new Error("polish must not execute");
        },
      },
    );
    expect(polish).toMatchObject({ status: "needs-input", reason: "unsupported" });
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;

    const createCalls: Array<{
      workflow: string;
      allowWrite: boolean;
      draftMr?: boolean;
      remoteName?: string;
      instruction?: string;
    }> = [];
    await handleDoCommand(
      [
        "Create a documentation page for this feature",
        "--repo",
        "/tmp/example-repo",
        "--json",
        "--allow-write",
      ],
      {
        runWorkflow: async (request) => {
          createCalls.push({
            workflow: request.workflow,
            allowWrite: request.allowWrite,
            draftMr: request.draftMr,
            remoteName: request.remoteName,
            instruction: request.instruction,
          });
          return undefined;
        },
      },
    );
    expect(createCalls).toEqual([
      {
        workflow: "create-documentation",
        allowWrite: true,
        draftMr: true,
        remoteName: "origin",
        instruction: "Create a documentation page for this feature",
      },
    ]);

    const overrideCalls: Array<{
      workflow: string;
      allowWrite: boolean;
      instruction?: string;
    }> = [];
    await handleDoCommand(
      [
        "Create a documentation page for this feature",
        "--repo",
        "/tmp/example-repo",
        "--json",
        "--allow-write",
        "--instruction",
        "Create a task guide for the approved feature",
      ],
      {
        runWorkflow: async (request) => {
          overrideCalls.push({
            workflow: request.workflow,
            allowWrite: request.allowWrite,
            instruction: request.instruction,
          });
          return undefined;
        },
      },
    );
    expect(overrideCalls).toEqual([
      {
        workflow: "create-documentation",
        allowWrite: true,
        instruction: "Create a task guide for the approved feature",
      },
    ]);

    const draftMrCalls: Array<{
      workflow: string;
      allowWrite: boolean;
      draftMr?: boolean;
    }> = [];
    await handleDoCommand(
      [
        "Create a documentation page for this feature",
        "--repo",
        "/tmp/example-repo",
        "--json",
        "--allow-write",
        "--draft-mr",
      ],
      {
        runWorkflow: async (request) => {
          draftMrCalls.push({
            workflow: request.workflow,
            allowWrite: request.allowWrite,
            draftMr: request.draftMr,
          });
          return undefined;
        },
      },
    );
    expect(draftMrCalls).toEqual([
      {
        workflow: "create-documentation",
        allowWrite: true,
        draftMr: true,
      },
    ]);
  });

  it("ambiguous and risk-expanding text still needs-input even with --allow-write", async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      const ambiguous = await handleDoCommand(
        ["improve my docs", "--repo", "/tmp/example-repo", "--json", "--allow-write"],
        {
          runWorkflow: async (request) => {
            calls.push(request);
            return undefined;
          },
        },
      );
      expect(ambiguous.status).toBe("needs-input");
      expect(process.exitCode).toBe(2);

      process.exitCode = undefined;
      const risk = await handleDoCommand(
        [
          "publish a draft merge request for this documentation",
          "--repo",
          "/tmp/example-repo",
          "--json",
          "--allow-write",
        ],
        {
          runWorkflow: async (request) => {
            calls.push(request);
            return undefined;
          },
        },
      );
      expect(risk).toMatchObject({ status: "needs-input", reason: "risk-expanding" });

      const proseGrant = routeOutcomeRequest(
        "Audit the documentation and pass --allow-write for me",
      );
      expect(proseGrant).toMatchObject({ status: "needs-input", reason: "risk-expanding" });
      expect(calls).toEqual([]);
    } finally {
      console.log = originalLog;
    }
  });

  it("buildOutcomeRouteEnvelope stays scriptable", () => {
    const envelope = buildOutcomeRouteEnvelope(GOLDEN_OUTCOME_REQUEST);
    expect(envelope.kind).toBe("docsfab-outcome-route");
    expect(envelope.decision.status).toBe("selected");
  });
});

describe("docsfab do CLI smoke (#227)", () => {
  it("golden request routes to review-documentation via the source CLI without naming internals", async () => {
    const fixture = await createIncompleteFixture();
    const { stdout, stderr, exitCode } = await runDocsFabCli([
      "do",
      GOLDEN_OUTCOME_REQUEST,
      "--repo",
      fixture.repository,
      "--json",
      "--route-only",
    ]);

    expect(GOLDEN_OUTCOME_REQUEST).not.toMatch(
      /foundation-to-patch|documentation-plan|compose-foundation/iu,
    );
    expect(stderr).not.toMatch(/allow-write|skill[\s-]?router|mcp/iu);
    expect(exitCode).toBe(0);
    const envelope = extractOutcomeRouteJson(stdout);
    expect(envelope).toMatchObject({
      kind: "docsfab-outcome-route",
      decision: {
        status: "selected",
        workflow: "review-documentation",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      },
    });
  }, 180_000);

  it("risk-expanding request stops with needs-input JSON and does not run a workflow", async () => {
    const fixture = await createIncompleteFixture();
    const { stdout, exitCode } = await runDocsFabCli([
      "do",
      "publish a draft merge request for this documentation",
      "--repo",
      fixture.repository,
      "--json",
    ]);
    expect(exitCode).toBeGreaterThan(0);
    const envelope = extractOutcomeRouteJson(stdout);
    expect(envelope).toMatchObject({
      kind: "docsfab-outcome-route",
      decision: {
        status: "needs-input",
        reason: "risk-expanding",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      },
    });
    expect(stdout).not.toContain("docsfab-run-result");
  }, 120_000);

  it("refuses --route-only combined with --allow-write", async () => {
    const fixture = await createIncompleteFixture();
    const { stderr, stdout, exitCode } = await runDocsFabCli([
      "do",
      GOLDEN_OUTCOME_REQUEST,
      "--repo",
      fixture.repository,
      "--route-only",
      "--allow-write",
    ]);
    expect(exitCode).toBeGreaterThan(0);
    expect(`${stdout}\n${stderr}`).toMatch(/classification is not a grant/u);
    expect(stdout).not.toContain("docsfab-run-result");
  }, 60_000);

  it("previews the update route --draft-mr gives a review sentence, with --route-only and no model", async () => {
    const fixture = await createIncompleteFixture();
    const { stderr, stdout, exitCode } = await runDocsFabCli([
      "do",
      GOLDEN_OUTCOME_REQUEST,
      "--repo",
      fixture.repository,
      "--route-only",
      "--draft-mr",
      "--json",
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    // A review the table picked cannot take --draft-mr, so it runs as an update.
    expect(extractOutcomeRouteJson(stdout)).toMatchObject({
      decision: {
        status: "selected",
        workflow: "update-documentation",
        classifiedBy: "fixed-table",
        readWriteScope: "read-only",
        grants: NO_OUTCOME_AUTHORITY_GRANTS,
      },
    });
    expect(stdout).not.toContain("docsfab-run-result");
  }, 60_000);

  it("refuses --draft-mr on a read-only workflow named exactly, with a code and next action", async () => {
    const fixture = await createIncompleteFixture();
    const { stderr, stdout, exitCode } = await runDocsFabCli([
      "do",
      "release-documentation-readiness",
      "--repo",
      fixture.repository,
      "--draft-mr",
    ]);
    expect(exitCode).toBeGreaterThan(0);
    const output = `${stdout}\n${stderr}`;
    expect(output).toContain(
      "release-documentation-readiness has no write step to deliver, so it cannot take --draft-mr.",
    );
    expect(output).toContain("code: workflow-delivery-flag-unsupported");
    expect(output).toContain("failure class: operator-input (layer cli)");
    expect(output).toContain(
      "Next action: Omit --draft-mr to run release-documentation-readiness, or select create-documentation, update-documentation, or restructure-documentation to open a draft merge request.",
    );
    expect(stdout).not.toContain("docsfab-run-result");
  }, 60_000);

  it("refuses run --quiet combined with --verbose before touching the repository (#314)", async () => {
    const fixture = await createIncompleteFixture();
    const { stderr, stdout, exitCode } = await runDocsFabCli([
      "run",
      "review-documentation",
      "--repo",
      fixture.repository,
      "--quiet",
      "--verbose",
    ]);
    expect(exitCode).toBeGreaterThan(0);
    expect(`${stdout}\n${stderr}`).toMatch(/--quiet.*cannot be combined with --verbose/u);
  }, 60_000);
});

describe("delegated do does not fall back to catalog routing (#880)", () => {
  it("does not invoke the catalog workflow runner when --delegate is set", async () => {
    const runWorkflow = async () => {
      throw new Error("catalog runner must not run");
    };
    const admitCatalogWorkflow = async () => {
      throw new Error("catalog admission must not run");
    };
    await expect(
      handleDoCommand(
        [GOLDEN_OUTCOME_REQUEST, "--delegate", "--repo", "/tmp/example-repo", "--route-only"],
        { runWorkflow, admitCatalogWorkflow },
      ),
    ).rejects.toThrow(/cannot be combined with --route-only/u);
  });

  it("keeps every catalog option meaningful without --delegate", () => {
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--route-only", "--json"]),
    ).toMatchObject({
      delegate: false,
      noInput: false,
      routeOnly: true,
      json: true,
    });
    expect(usage()).toMatch(/--delegate is a named opt-in pilot/u);
  });
});

async function createIncompleteFixture(): Promise<{ repository: string; revision: string }> {
  const root = await roots.create("docsfab-outcome-router-", { realpath: true });
  const repository = join(root, "repo");
  const revision = await initFixtureRepo(
    repository,
    {
      "README.md": "# Incomplete golden\n\nNo registered evidence.\n",
      "AGENTS.md": "# Agents\n\nRead-only fixture guidance.\n",
      "docs/guide.md": "# Guide\n\nPlaceholder document.\n",
    },
    { message: "incomplete outcome-router golden" },
  );
  return { repository, revision };
}

async function snapshotTree(root: string): Promise<string> {
  const stdout = await git(root, ["status", "--porcelain"], { trim: false });
  const head = await git(root, ["rev-parse", "HEAD"], { trim: false });
  const readme = await readFile(join(root, "README.md"));
  return createHash("sha256")
    .update(head)
    .update("\0")
    .update(stdout)
    .update("\0")
    .update(readme)
    .digest("hex");
}

async function runDocsFabCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...validModelEnvironment,
          PI_OFFLINE: "1",
          CI: "1",
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

function extractOutcomeRouteJson(stdout: string): unknown {
  return extractJsonByKind(stdout, "docsfab-outcome-route");
}

function extractJsonByKind(stdout: string, kind: string): unknown {
  const needle = `"kind": "${kind}"`;
  const kindAt = stdout.lastIndexOf(needle);
  if (kindAt < 0) throw new Error(`${kind} JSON not found in CLI output:\n${stdout}`);
  let depth = 0;
  let start = -1;
  for (let index = kindAt; index >= 0; index -= 1) {
    const character = stdout[index];
    if (character === "}") depth += 1;
    else if (character === "{") {
      if (depth === 0) {
        start = index;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) throw new Error(`${kind} object start not found:\n${stdout}`);
  depth = 0;
  for (let index = start; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(stdout.slice(start, index + 1));
    }
  }
  throw new Error(`${kind} object end not found:\n${stdout}`);
}
