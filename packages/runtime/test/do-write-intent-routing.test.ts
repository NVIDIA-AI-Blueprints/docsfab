// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * #1920: `docsfab do` routing under `--patch-only` and `--draft-mr`, on the
 * real `do` path, inside the admission decision (#164): the table classifies
 * first, the admission model runs only on a live table miss, an abstain or an
 * error stops, and `--route-only` never asks the model.
 *
 * The admission model is the production `liveAdmitCatalogWorkflow`; only the
 * provider reply is scripted, through a stubbed `fetch`, so these tests also
 * see the exact offer and prompt the model receives.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { liveAdmitCatalogWorkflow } from "../src/cli/admission-model.js";
import type { AdmissionOffer } from "../src/cli/admission-parse.js";
import {
  handleDoCommand,
  parseDoArguments,
  type AdmitCatalogWorkflow,
  type DoRunArguments,
} from "../src/cli/commands/do.js";
import {
  DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS,
  DeliveryFlagOperatorError,
  type DeliveryFlagConflict,
} from "../src/cli/delivery-grants.js";
import {
  GOLDEN_OUTCOME_REQUEST,
  NO_OUTCOME_AUTHORITY_GRANTS,
  isAdmissionModelEligible,
  routeOutcomeRequest,
  type OutcomeRouteDecision,
} from "../src/cli/outcome-router.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { RUNNABLE_WORKFLOW_NAMES } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { textTurn } from "./support/pi-harness-session-fixtures.js";

const installRoot = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/config/runtime-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/runtime-loader.js")>()),
  loadConfig: () => ({ projectRoot: installRoot.path, model: validModelConfig }),
}));

/** The benchmark wording from #1920: a check that may need no change. */
const CONDITIONAL_REQUEST =
  "Check whether the docs need a change for the new --timeout flag on kn service create, and update them if so";
const REVIEW_THEN_UPDATE_REQUEST =
  "Review the documentation for the --timeout flag change and update it if needed";
const IMPACT_REQUEST =
  "Check the documentation impact of this change and update the docs if needed";
const UPDATE_REQUEST = "Update the installation guide for the new setup command";
const CREATE_REQUEST = "Create a documentation page for this feature";
const POLISH_REQUEST = "Polish the documentation";
const REVIEW_REQUEST = "Review the documentation";
const AMBIGUOUS_REQUEST = "improve my docs";
const RISK_REQUEST = "publish a draft merge request for this documentation";
const UPDATE_NO_PUBLISH = `${UPDATE_REQUEST}. Do not publish.`;
const CONDITIONAL_NO_PUBLISH = `${CONDITIONAL_REQUEST}. Do not publish.`;
const CHECK_NO_PUBLISH = "Check the API reference for errors. Do not publish.";
const PATCH_WORKFLOWS = [
  "bootstrap",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
] as const;
const OLD_REFUSAL = "This workflow does not write a local patch. Omit --patch-only.";
/** A scripted reply that makes the provider answer HTTP 401 instead of a turn. */
const PROVIDER_ERROR = "<provider-error>";

interface AdmissionCall {
  readonly request: string;
  readonly offered: readonly string[];
  readonly prompt: string;
}

/** Scripted provider: the reply each request receives, and every call it saw. */
const provider = {
  replies: new Map<string, string>(),
  calls: [] as AdmissionCall[],
};

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function admissionCallOf(body: string): AdmissionCall {
  const prompt = stringsIn(JSON.parse(body)).find((text) =>
    text.startsWith("Reply with a single JSON object"),
  );
  if (prompt === undefined) throw new Error("admission prompt not found in the provider request");
  const offerBlock = prompt.slice(
    prompt.indexOf("whose value is one of:\n") + "whose value is one of:\n".length,
    prompt.indexOf("- abstain\n"),
  );
  const offered = offerBlock
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  const request = prompt.slice(prompt.lastIndexOf("Request:\n") + "Request:\n".length);
  return { request, offered, prompt };
}

beforeAll(async () => {
  installRoot.path = await mkdtemp(resolve(tmpdir(), "docsfab-do-write-intent-install-"));
});

afterAll(async () => {
  await rm(installRoot.path, { recursive: true, force: true });
});

let stateDirectory = "";

beforeEach(async () => {
  stateDirectory = await mkdtemp(resolve(tmpdir(), "docsfab-do-write-intent-state-"));
  provider.replies.clear();
  provider.calls = [];
  // The suite sets PI_OFFLINE, which makes the admission model return early.
  vi.stubEnv("PI_OFFLINE", "0");
  vi.stubGlobal("fetch", async (_request: RequestInfo | URL, init?: RequestInit) => {
    const call = admissionCallOf(String(init?.body));
    provider.calls.push(call);
    const reply = provider.replies.get(call.request);
    if (reply === undefined) throw new Error(`no scripted reply for ${call.request}`);
    if (reply === PROVIDER_ERROR) {
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return textTurn(reply);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await rm(stateDirectory, { recursive: true, force: true });
});

function scriptReply(request: string, workflow: string): void {
  provider.replies.set(request, JSON.stringify({ workflow }));
}

interface DoOutcome {
  readonly decision?: unknown;
  readonly error?: unknown;
  readonly runs: readonly DoRunArguments[];
  readonly logs: string;
  readonly exitCode: number | string | undefined;
  readonly admissionCalls: number;
}

async function runDo(
  args: readonly string[],
  admitCatalogWorkflow: AdmitCatalogWorkflow = liveAdmitCatalogWorkflow,
): Promise<DoOutcome> {
  const runs: DoRunArguments[] = [];
  const logs: string[] = [];
  const callsBefore = provider.calls.length;
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  process.exitCode = undefined;
  try {
    const decision = await handleDoCommand([...args, "--repo", "/tmp/example-repo"], {
      admitCatalogWorkflow,
      stateDirectory,
      runWorkflow: async (request) => {
        runs.push(request);
        return undefined;
      },
    });
    return {
      decision,
      runs,
      logs: logs.join("\n"),
      exitCode: process.exitCode,
      admissionCalls: provider.calls.length - callsBefore,
    };
  } catch (error) {
    return {
      error,
      runs,
      logs: logs.join("\n"),
      exitCode: process.exitCode,
      admissionCalls: provider.calls.length - callsBefore,
    };
  } finally {
    console.log = originalLog;
    process.exitCode = undefined;
  }
}

interface RouteEnvelope {
  readonly decision: OutcomeRouteDecision;
  readonly admission?: { readonly decidedBy: string; readonly workflows: readonly string[] };
}

describe("do routing under --patch-only and --draft-mr (#1920)", () => {
  it("admits bootstrap patch delivery only alongside its explicit --allow-write grant", async () => {
    scriptReply(CONDITIONAL_REQUEST, "bootstrap");
    const outcome = await runDo([CONDITIONAL_REQUEST, "--patch-only", "--allow-write"]);

    expect(outcome.error).toBeUndefined();
    expect(outcome.decision).toMatchObject({
      status: "selected",
      workflow: "bootstrap",
      classifiedBy: "admission-model",
    });
    expect(provider.calls.at(-1)?.offered).toEqual(PATCH_WORKFLOWS);
    expect(outcome.runs).toHaveLength(1);
    expect(outcome.runs[0]).toMatchObject({ workflow: "bootstrap", allowWrite: true });
    expect(outcome.runs[0]?.draftMr).toBeUndefined();
    expect(outcome.runs[0]?.remoteName).toBeUndefined();
  }, 60_000);

  it("offers the admission model only the delivering workflows and runs its update pick for a conditional request", async () => {
    expect(routeOutcomeRequest(CONDITIONAL_REQUEST)).toMatchObject({
      status: "needs-input",
      reason: "unsupported",
    });
    scriptReply(CONDITIONAL_REQUEST, "update-documentation");

    const outcome = await runDo([CONDITIONAL_REQUEST, "--patch-only"]);

    expect(outcome.error).toBeUndefined();
    expect(outcome.decision).toMatchObject({
      status: "selected",
      workflow: "update-documentation",
      classifiedBy: "admission-model",
      grants: NO_OUTCOME_AUTHORITY_GRANTS,
    });
    expect(outcome.exitCode).toBeUndefined();
    expect(outcome.runs).toHaveLength(1);
    expect(outcome.runs[0]).toMatchObject({
      workflow: "update-documentation",
      instruction: CONDITIONAL_REQUEST,
      allowWrite: true,
    });
    expect(outcome.runs[0]?.draftMr).toBeUndefined();
    expect(outcome.runs[0]?.remoteName).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request).toBe(CONDITIONAL_REQUEST);
    expect(provider.calls[0]?.offered).toEqual(PATCH_WORKFLOWS);
    expect(provider.calls[0]?.prompt).toContain(
      "The operator asked for a local patch or a draft merge request",
    );
    expect(provider.calls[0]?.prompt).toContain(
      "A request to check whether documentation needs a change, and to update it if so, is update-documentation",
    );
  }, 60_000);

  it("stops with needs-input, and starts no run, when the model names a read-only workflow, abstains, or fails", async () => {
    // The field mistake: the model names a read-only workflow, now outside the offer.
    scriptReply(CONDITIONAL_REQUEST, "review-documentation");
    const readOnly = await runDo([CONDITIONAL_REQUEST, "--patch-only"]);
    expect(readOnly.error).toBeUndefined();
    expect(readOnly.decision).toMatchObject({ status: "needs-input", reason: "unsupported" });
    expect(readOnly.exitCode).toBe(2);
    expect(readOnly.runs).toEqual([]);
    expect(readOnly.admissionCalls).toBe(1);
    expect(readOnly.logs).not.toContain(OLD_REFUSAL);

    scriptReply(CONDITIONAL_REQUEST, "abstain");
    const abstained = await runDo([CONDITIONAL_REQUEST, "--draft-mr"]);
    expect(abstained.decision).toMatchObject({ status: "needs-input" });
    expect(abstained.exitCode).toBe(2);
    expect(abstained.runs).toEqual([]);

    provider.replies.set(CONDITIONAL_REQUEST, PROVIDER_ERROR);
    const failed = await runDo([CONDITIONAL_REQUEST, "--patch-only"]);
    expect(failed.error).toBeUndefined();
    expect(failed.decision).toMatchObject({ status: "needs-input" });
    expect(failed.exitCode).toBe(2);
    expect(failed.runs).toEqual([]);
    expect(failed.admissionCalls).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("keeps only picks inside the offer and treats a throwing admission model as a miss", async () => {
    const offers: AdmissionOffer[] = [];
    const outside = await runDo([CONDITIONAL_REQUEST, "--patch-only"], async (_request, offer) => {
      offers.push(offer);
      return "review-documentation";
    });
    expect(offers.map((offer) => [offer.workflows, offer.writeIntent])).toEqual([
      [PATCH_WORKFLOWS, true],
    ]);
    expect(outside.error).toBeUndefined();
    expect(outside.decision).toMatchObject({ status: "needs-input" });
    expect(outside.runs).toEqual([]);

    for (const flags of [[], ["--patch-only"]]) {
      const thrown = await runDo([CONDITIONAL_REQUEST, ...flags], async () => {
        throw new Error("provider transport failed");
      });
      expect(thrown.error, flags.join(" ")).toBeUndefined();
      expect(thrown.decision, flags.join(" ")).toMatchObject({ status: "needs-input" });
      expect(thrown.exitCode, flags.join(" ")).toBe(2);
      expect(thrown.runs, flags.join(" ")).toEqual([]);
    }
  }, 60_000);

  it("runs a review the table picked as update-documentation under --patch-only or --draft-mr, with no model call", async () => {
    expect(routeOutcomeRequest(IMPACT_REQUEST)).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
    });
    const patch = await runDo([IMPACT_REQUEST, "--patch-only"]);
    expect(patch.decision).toMatchObject({
      status: "selected",
      workflow: "update-documentation",
      classifiedBy: "fixed-table",
      rationale: expect.stringMatching(/^The table picked a review/u),
    });
    expect(patch.admissionCalls).toBe(0);
    expect(patch.runs.map((run) => [run.workflow, run.allowWrite, run.draftMr])).toEqual([
      ["update-documentation", true, undefined],
    ]);

    const draft = await runDo([IMPACT_REQUEST, "--draft-mr"]);
    expect(draft.admissionCalls).toBe(0);
    expect(draft.runs.map((run) => [run.workflow, run.draftMr, run.remoteName])).toEqual([
      ["update-documentation", true, "origin"],
    ]);

    // Never another write workflow: a model the run does not ask cannot pick restructure.
    scriptReply(REVIEW_THEN_UPDATE_REQUEST, "restructure-documentation");
    const review = await runDo([REVIEW_THEN_UPDATE_REQUEST, "--draft-mr"]);
    expect(review.decision).toMatchObject({ workflow: "update-documentation" });
    expect(review.admissionCalls).toBe(0);

    // The exact workflow name is a review the table picked, too.
    const named = await runDo(["review-documentation", "--patch-only"]);
    expect(named.decision).toMatchObject({
      workflow: "update-documentation",
      classifiedBy: "fixed-table",
    });
    expect(named.admissionCalls).toBe(0);

    // Without a delivery flag the table's review stands, with or without --allow-write.
    for (const flags of [[], ["--allow-write"]]) {
      const plain = await runDo([IMPACT_REQUEST, ...flags]);
      expect(plain.decision, flags.join(" ")).toMatchObject({
        workflow: "review-documentation",
        classifiedBy: "fixed-table",
      });
      expect(
        plain.runs.map((run) => run.draftMr),
        flags.join(" "),
      ).toEqual([undefined]);
    }
  }, 60_000);

  it("--route-only asks no model: it names the offer on a table miss and otherwise reports the run's route", async () => {
    scriptReply(CONDITIONAL_REQUEST, "update-documentation");
    scriptReply(POLISH_REQUEST, "abstain");
    scriptReply(AMBIGUOUS_REQUEST, "review-documentation");
    const cases: ReadonlyArray<readonly string[]> = [
      [CONDITIONAL_REQUEST, "--patch-only"],
      [CONDITIONAL_REQUEST, "--draft-mr"],
      [CONDITIONAL_REQUEST],
      [POLISH_REQUEST, "--patch-only"],
      [AMBIGUOUS_REQUEST],
      [REVIEW_THEN_UPDATE_REQUEST, "--patch-only"],
      [IMPACT_REQUEST, "--draft-mr"],
      [REVIEW_REQUEST],
      [REVIEW_REQUEST, "--patch-only"],
      ["review-documentation", "--patch-only"],
      [UPDATE_REQUEST, "--patch-only"],
      [CREATE_REQUEST, "--draft-mr"],
      [UPDATE_NO_PUBLISH, "--patch-only"],
      ["release-documentation-readiness", "--patch-only"],
      [RISK_REQUEST, "--patch-only"],
      [UPDATE_NO_PUBLISH, "--draft-mr"],
      [UPDATE_NO_PUBLISH],
      [CONDITIONAL_NO_PUBLISH, "--draft-mr"],
      [CONDITIONAL_NO_PUBLISH],
    ];
    const outcomes = { routed: 0, offered: 0, refused: 0 };
    for (const args of cases) {
      const label = args.join(" ");
      const preview = await runDo([...args, "--route-only", "--json"]);
      const run = await runDo([...args, "--json"]);
      expect(preview.admissionCalls, label).toBe(0);
      expect(preview.runs, label).toEqual([]);
      if (run.error !== undefined || preview.error !== undefined) {
        outcomes.refused += 1;
        expect(run.error, label).toBeInstanceOf(DeliveryFlagOperatorError);
        expect(preview.error, label).toBeInstanceOf(DeliveryFlagOperatorError);
        const { code, message, nextAction } = run.error as DeliveryFlagOperatorError;
        expect(preview.error, label).toMatchObject({ code, message, nextAction });
        expect(run.admissionCalls, label).toBe(0);
        expect(run.runs, label).toEqual([]);
        continue;
      }
      const envelope = JSON.parse(preview.logs) as RouteEnvelope;
      expect(envelope.decision, label).toEqual(preview.decision);
      if (envelope.admission !== undefined) {
        outcomes.offered += 1;
        expect(preview.decision, label).toMatchObject({ status: "needs-input" });
        expect(preview.exitCode, label).toBe(2);
        expect(envelope.admission.decidedBy, label).toBe("admission-model");
        expect(run.admissionCalls, label).toBe(1);
        expect(provider.calls.at(-1)?.offered, label).toEqual(envelope.admission.workflows);
        const decision = run.decision as OutcomeRouteDecision;
        if (decision.status === "selected") {
          expect(decision.classifiedBy, label).toBe("admission-model");
          expect(envelope.admission.workflows, label).toContain(decision.workflow);
          expect(
            run.runs.map((item) => item.workflow),
            label,
          ).toEqual([decision.workflow]);
        } else {
          expect(decision, label).toEqual(preview.decision);
          expect(run.runs, label).toEqual([]);
        }
        continue;
      }
      outcomes.routed += 1;
      expect(run.admissionCalls, label).toBe(0);
      expect(preview.decision, label).toEqual(run.decision);
      expect(preview.exitCode, label).toBe(run.exitCode);
      const decision = run.decision as OutcomeRouteDecision;
      expect(
        run.runs.map((item) => item.workflow),
        label,
      ).toEqual(decision.status === "selected" ? [decision.workflow] : []);
    }
    expect(outcomes).toEqual({ routed: 9, offered: 5, refused: 5 });
  }, 120_000);

  it("refuses a publication the request prohibits before --route-only returns, with a code", async () => {
    for (const flags of [["--draft-mr"], []]) {
      const preview = await runDo([UPDATE_NO_PUBLISH, ...flags, "--route-only"]);
      expect(preview.error, flags.join(" ")).toMatchObject({
        code: "publication-prohibition-conflict",
        nextAction: "Pass --patch-only to retain a local patch without publishing.",
      });
    }
    // On a table miss the run refuses before the admission call; so does the preview.
    const missRun = await runDo([CHECK_NO_PUBLISH, "--allow-write"]);
    expect(missRun.error).toMatchObject({ code: "publication-prohibition-conflict" });
    expect(missRun.admissionCalls).toBe(0);
    const missPreview = await runDo([CHECK_NO_PUBLISH, "--route-only"]);
    expect(missPreview.error).toMatchObject({ code: "publication-prohibition-conflict" });
    expect(missPreview.admissionCalls).toBe(0);
    // --route-only still refuses --allow-write at parse: classify is not a grant (#164).
    const allowPreview = await runDo([CHECK_NO_PUBLISH, "--allow-write", "--route-only"]);
    expect(allowPreview.error).toMatchObject({
      code: "delivery-flag-conflict",
      message:
        "docsfab do --route-only cannot be combined with --allow-write; classification is not a grant.",
    });
    expect(allowPreview.admissionCalls).toBe(0);
    // --patch-only honors the prohibition, so the run and the preview both proceed.
    const patchPreview = await runDo([UPDATE_NO_PUBLISH, "--patch-only", "--route-only"]);
    expect(patchPreview.decision).toMatchObject({
      status: "selected",
      workflow: "update-documentation",
    });
  }, 60_000);
});

describe("do routing without --patch-only or --draft-mr matches main (#1920)", () => {
  it("offers every runnable workflow, keeps a read-only pick, and stops on an abstain, with or without --allow-write", async () => {
    scriptReply(CONDITIONAL_REQUEST, "review-documentation");
    for (const flags of [[], ["--allow-write"]]) {
      const label = flags.join(" ");
      const outcome = await runDo([CONDITIONAL_REQUEST, ...flags]);
      expect(outcome.decision, label).toMatchObject({
        status: "selected",
        workflow: "review-documentation",
        classifiedBy: "admission-model",
      });
      expect(
        outcome.runs.map((run) => [run.workflow, run.allowWrite, run.draftMr]),
        label,
      ).toEqual([["review-documentation", flags.length > 0, undefined]]);
      expect(provider.calls.at(-1)?.offered, label).toEqual(RUNNABLE_WORKFLOW_NAMES);
      expect(provider.calls.at(-1)?.prompt, label).not.toContain(
        "The operator asked for a local patch",
      );
    }
    scriptReply(POLISH_REQUEST, "abstain");
    const abstained = await runDo([POLISH_REQUEST, "--allow-write"]);
    expect(abstained.decision).toMatchObject({ status: "needs-input", reason: "unsupported" });
    expect(abstained.exitCode).toBe(2);
    expect(abstained.runs).toEqual([]);
  }, 60_000);

  it("runs a review request as review-documentation with no admission call, with or without --allow-write", async () => {
    const plain = await runDo([REVIEW_REQUEST]);
    expect(plain.decision).toMatchObject({
      status: "selected",
      workflow: "review-documentation",
      classifiedBy: "fixed-table",
    });
    expect(plain.admissionCalls).toBe(0);
    expect(plain.runs.map((run) => [run.workflow, run.allowWrite, run.draftMr])).toEqual([
      ["review-documentation", false, undefined],
    ]);

    const allow = await runDo([REVIEW_REQUEST, "--allow-write"]);
    expect(allow.runs.map((run) => [run.workflow, run.allowWrite, run.draftMr])).toEqual([
      ["review-documentation", true, undefined],
    ]);
  }, 60_000);
});

describe("no run opens a draft merge request without --draft-mr (#1920)", () => {
  it("keeps read-only picks read-only and stops on abstains and provider errors, for every flag but --draft-mr", async () => {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["Check whether the docs are ready for the 2.0 release", "release-documentation-readiness"],
      ["Check the API reference for errors", "review-documentation"],
      ["Proofread the installation guide", "review-documentation"],
      ["What do the docs say about the timeout flag?", "review-documentation"],
      ["Look over the install guide but do not change anything", "abstain"],
      ["Refactor the payment service to use the new SDK", "abstain"],
      ["Push my changes and open a pull request for the docs fix", "abstain"],
      ["Check whether the docs are ready for the 2.1 release", PROVIDER_ERROR],
    ];
    for (const [request, reply] of rows) {
      const table = routeOutcomeRequest(request);
      expect(table.status, request).toBe("needs-input");
      expect(isAdmissionModelEligible(request, table), request).toBe(true);
      provider.replies.set(
        request,
        reply === PROVIDER_ERROR ? PROVIDER_ERROR : JSON.stringify({ workflow: reply }),
      );
      const readOnlyPick = reply !== "abstain" && reply !== PROVIDER_ERROR;
      for (const flags of [[], ["--allow-write"], ["--patch-only"]]) {
        const label = [request, ...flags].join(" ");
        const outcome = await runDo([request, ...flags, "--json"]);
        expect(outcome.error, label).toBeUndefined();
        expect(
          outcome.runs.filter((run) => run.draftMr === true),
          label,
        ).toEqual([]);
        if (readOnlyPick && !flags.includes("--patch-only")) {
          expect(
            outcome.runs.map((run) => [run.workflow, run.allowWrite]),
            label,
          ).toEqual([[reply, flags.includes("--allow-write")]]);
        } else {
          expect(outcome.decision, label).toMatchObject({ status: "needs-input" });
          expect(outcome.exitCode, label).toBe(2);
          expect(outcome.runs, label).toEqual([]);
        }
      }
    }
  }, 300_000);
});

describe("do refusals name a code and one next action (#1920)", () => {
  it("refuses --patch-only on an exactly named read-only workflow in the run and the preview, with no model call", async () => {
    for (const extra of [[], ["--route-only"]] as const) {
      const outcome = await runDo(["release-documentation-readiness", "--patch-only", ...extra]);
      expect(outcome.runs).toEqual([]);
      expect(outcome.admissionCalls).toBe(0);
      expect(outcome.error).toBeInstanceOf(DeliveryFlagOperatorError);
      expect(outcome.error).toMatchObject({
        code: "workflow-delivery-flag-unsupported",
        message:
          "release-documentation-readiness has no write step to produce a local patch, so it cannot take --patch-only.",
        nextAction:
          "Omit --patch-only to run release-documentation-readiness, or select bootstrap, create-documentation, update-documentation, or restructure-documentation to retain a local patch.",
      });
      const envelope = toOperatorErrorEnvelope(outcome.error);
      expect(envelope.failure).toEqual({
        class: "operator-input",
        layer: "cli",
        code: "workflow-delivery-flag-unsupported",
      });
      expect(envelope.message).not.toContain(OLD_REFUSAL);
    }
  }, 60_000);

  it("names each do flag pair's own next action", () => {
    const pairs: ReadonlyArray<readonly [readonly string[], DeliveryFlagConflict, string]> = [
      [
        ["--route-only", "--allow-write"],
        "route-only/allow-write",
        "--route-only cannot be combined with --allow-write",
      ],
      [
        ["--dry-run", "--patch-only"],
        "dry-run/patch-only",
        "--dry-run cannot be combined with --patch-only",
      ],
      [
        ["--dry-run", "--draft-mr"],
        "dry-run/draft-mr",
        "--dry-run cannot be combined with --draft-mr",
      ],
      [
        ["--patch-only", "--draft-mr"],
        "patch-only/draft-mr",
        "--patch-only cannot be combined with --draft-mr",
      ],
      [
        ["--dry-run", "--allow-write"],
        "dry-run/allow-write",
        "--dry-run cannot be combined with --allow-write",
      ],
      [
        ["--route-only", "--dry-run"],
        "route-only/dry-run",
        "--route-only cannot be combined with --dry-run",
      ],
      [
        ["--route-only", "--comment-mr", "42"],
        "route-only/comment-mr",
        "--route-only cannot be combined with --comment-mr",
      ],
      [
        ["--draft-mr", "--comment-mr", "42"],
        "comment-mr/draft-mr",
        "--comment-mr cannot be combined with --draft-mr",
      ],
      [
        ["--dry-run", "--comment-mr", "42"],
        "dry-run/comment-mr",
        "--dry-run cannot be combined with --comment-mr",
      ],
      [
        ["--route-only", "--remote", "origin"],
        "route-only/remote",
        "--route-only cannot be combined with --remote",
      ],
    ];
    for (const [flags, conflict, message] of pairs) {
      expect(
        () => parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", ...flags]),
        conflict,
      ).toThrow(
        expect.objectContaining({
          code: "delivery-flag-conflict",
          message: expect.stringContaining(message),
          nextAction: DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS[conflict],
        }),
      );
    }
  });

  it("prints the admission offer, not an omit-the-flag action, for the conditional request under --route-only", async () => {
    const preview = await runDo([CONDITIONAL_REQUEST, "--patch-only", "--route-only"]);
    expect(preview.admissionCalls).toBe(0);
    expect(preview.exitCode).toBe(2);
    const output = preview.logs;
    expect(output).toContain("Outcome route: needs-input");
    expect(output).toContain("Reason: unsupported");
    expect(output).toContain(
      "Admission: the run asks the admission model to name one of bootstrap, create-documentation, update-documentation, restructure-documentation; if it names none, the run stops here.",
    );
    expect(output).not.toContain(OLD_REFUSAL);
    expect(output).not.toContain("Omit --patch-only");
  }, 60_000);

  it("keeps actionable choices and admission guidance visible with --quiet", async () => {
    const preview = await runDo([CONDITIONAL_REQUEST, "--patch-only", "--route-only", "--quiet"]);
    expect(preview.admissionCalls).toBe(0);
    expect(preview.exitCode).toBe(2);
    expect(preview.logs).toContain("Choices\n");
    expect(preview.logs).toContain("Available catalog workflows\n");
    expect(preview.logs).toContain("bootstrap");
    expect(preview.logs).toContain("if it names none, the run stops here.");
  }, 60_000);

  it("codes the source refusal for a route that cannot bind --source, without claiming no model ran", async () => {
    const outcome = await runDo([REVIEW_REQUEST, "--source", "docs/guide.md", "--route-only"]);
    expect(outcome.error).toMatchObject({
      code: "source-route-unsupported",
      message: expect.stringContaining(
        "This quoted request routed to review-documentation instead, so nothing was read and the workflow did not start.",
      ),
      nextAction:
        "Describe a change that routes to create-documentation or update-documentation, or drop --source.",
    });
    expect((outcome.error as Error).message).not.toContain("no model call was made");
    expect(toOperatorErrorEnvelope(outcome.error).failure).toEqual({
      class: "operator-input",
      layer: "cli",
      code: "source-route-unsupported",
    });
  }, 60_000);

  it("keeps the authority stop and its next action for risk-expanding text under --patch-only", async () => {
    const outcome = await runDo([RISK_REQUEST, "--patch-only"]);
    expect(outcome.decision).toMatchObject({ status: "needs-input", reason: "risk-expanding" });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.admissionCalls).toBe(0);
    expect(outcome.runs).toEqual([]);
    const output = outcome.logs;
    expect(output).toContain("Reason: risk-expanding");
    expect(output).toContain("NEXT");
    expect(output).toContain(
      "Do not ask the router to grant authority. Describe the task, target, and desired outcome, or use an explicit `docsfab run` command.",
    );
  }, 60_000);
});
