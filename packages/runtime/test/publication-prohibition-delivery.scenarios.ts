// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The publication-prohibition guard `docsfab run` and `docsfab do` share:
 * every recognized phrase against every delivery, on `run --instruction`, the
 * `do` sentence, and `do --instruction`, with the same outcome on all three.
 * Also the affirmative, quoted, and mixed controls, and the `do` routes of
 * explicit local workflow requests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleDoCommand, type DoRunArguments } from "../src/cli/commands/do.js";
import { DeliveryFlagOperatorError } from "../src/cli/delivery-grants.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";

import type { PublicationScenarioInputs } from "./helpers/runtime-scenario-inputs.js";

export function registerPublicationProhibitionScenarios(inputs: PublicationScenarioInputs): void {
  const REPOSITORY = "/tmp/example-repo";
  const BASE = inputs.base;
  const CONFLICT = "publication-prohibition-conflict";
  const NEXT_ACTION = "Pass --patch-only to retain a local patch without publishing.";

  /** Every phrasing the guard recognizes, each after BASE. */
  const PROHIBITIONS = [
    "Do not publish.",
    "Do not publish it.",
    "Don't publish the docs.",
    "Never post anything.",
    "Keep the result local.",
    "Keep it local.",
    "Publication is forbidden.",
    "Do not open a merge request.",
    "Do not open an MR.",
    "Do not open a pull request.",
    "Local only, no publishing.",
    "Do not publish it and do not open a merge request.",
    "Do not push anything.",
    "Never push to origin.",
    "Do not commit or push.",
    "Do not commit, push, or open an MR.",
    "Do not commit, push, and open an MR.",
    "Don\u2019t commit and push.",
    "Keep the result local; do not commit, push, or open an MR.",
    "Please do not publish.",
    // Wrapped across a line, as an editor or a shell heredoc leaves it.
    "Never\npost anything.",
    "Do not\npublish.",
    "Keep the result\nlocal.",
    "Don't\npublish it.",
    "Publication is\nforbidden.",
    // A line break ends the clause before it: no sentence end on that line.
    "Cover every option\nDo not publish",
    // A missing space after a period.
    "Cover every option.Do not push anything.",
    // Markdown emphasis, code, list, and quote markers.
    "**Do not push.**",
    "_Do not push._",
    "`Do not publish.`",
    "\n- Do not publish.",
    "\n* Do not push anything.",
    "\n> Do not publish.",
    "\n1. Do not publish.",
    // Lead-ins.
    "IMPORTANT: Do not publish.",
    "However, do not publish.",
    "Please, do not publish.",
    "Kindly do not publish.",
    // An inch mark leaves the quotes unbalanced; the prohibition still counts.
    'Use a 3" margin in the diagram. Do not publish. Add a "Usage" section.',
    // An odd number of quotes: the text is also read with no quote masked.
    'Leave a 3 " margin. Do not publish." Then add a 5" border.',
    // Two inch marks are not a quoted passage.
    'Use a 3" margin. Do not publish. Use a 5" border.',
    // A file name inside the clause, also wrapped.
    "Do not publish docs/cli-reference.md.",
    "Do not\npublish docs/cli-reference.md.",
    "Never, ever\npublish docs/cli-reference.md.",
    // Objects, adverbs, destinations, and other shapes.
    "Do not push the new page.",
    "Do not ever push.",
    "Never push directly to origin.",
    "Do not publish the result to GitLab or GitHub.",
    "This must not be published.",
    "Nothing should be published.",
    "I don't want an MR.",
    "We don't need a merge request.",
    "Skip the MR.",
    "Leave the changes local.",
    "Keep the new page local.",
    "Without opening a merge request.",
    // "Without publishing" as a clause of its own, not inside a description.
    "Cover every option, without publishing.",
    "Without publishing, cover every option.",
    // A prohibition spliced on with a comma, a dash, or "then".
    "Cover every option, don't push.",
    "Cover every option, do not open an MR.",
    "Cover every option, keep it local.",
    "Write the guide, no MR.",
    "Cover every option, please do not publish.",
    "Cover every option\u2014do not push.",
    "Cover every option then do not push.",
    // Pasted or formatted text.
    "<p>Do not push.</p>",
    "\n## Do not push",
    "> Do not publish.",
    "Do not \u200Bpublish.",
    "\uFF24\uFF4F\u3000\uFF4E\uFF4F\uFF54\u3000\uFF50\uFF55\uFF42\uFF4C\uFF49\uFF53\uFF48\u3002",
    "Cover every option\rDo not publish",
    "Cover every option\u2028Do not publish",
    "Cover every option\u2029Do not publish",
    "Do not\u0085publish.",
    "Do not publish \u{1F64F}",
    "Do not publish :pray:",
    "Do not publish, OK?",
    "Do not publish please.",
    "Don\u00B4t publish.",
    "Don\u2018t publish.",
    "Never, ever publish.",
    "Do not, under any circumstances, publish.",
    // Quotes that touch nothing, or do not match, never mask the text between them.
    'Explain that a " inside a field is doubled. Keep the result local. Note that " must wrap fields.',
    'Use a 3 " margin. Do not post it. Use a 2 " gutter.',
    'Name it "Quick start\u201D. Keep the result local. Add a \u201CUsage" section.',
    'Document how the parser handles `"` characters. Do not push. Mention that `"` must be escaped.',
    // Any unpaired quote, straight or curly, adds a reading with nothing masked.
    'Add the rule "Build first. Do not push." and a "Usage section.',
    "Add the rule \u201CBuild first. Do not push.\u201D and a \u201CUsage section.",
    "No need for an MR.",
    // Time-bound and conditional prohibitions: publication waits on nothing DocsFab checks.
    "Do not publish yet.",
    "Do not publish until it is reviewed.",
    "Do not publish without approval.",
    // A patch is the whole delivery.
    "Only produce a patch.",
    "Just give me the diff.",
    "Patch only.",
  ] as const;

  /** Text that names publication without forbidding it: no refusal on any surface. */
  const NO_PROHIBITION = [
    "Cover commands, options, defaults, output examples, and errors.",
    'Quote the rule "Build first. Do not push." in the errors section.',
    "Do not push to main.",
  ] as const;

  const DELIVERIES = {
    default: [],
    "draft-mr": ["--draft-mr"],
    "patch-only": ["--patch-only"],
    "dry-run": ["--dry-run"],
  } as const satisfies Record<string, readonly string[]>;

  type Delivery = keyof typeof DELIVERIES;

  type Outcome =
    | { readonly kind: "refused"; readonly code: string; readonly nextAction: string }
    | { readonly kind: "runs"; readonly draftMr: boolean }
    | { readonly kind: "previews" }
    | { readonly kind: "stops"; readonly reason: string };

  let stateDirectory = "";

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-prohibition-state-"));
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await rm(stateDirectory, { recursive: true, force: true });
  });

  function refusal(error: unknown): Outcome {
    if (!(error instanceof DeliveryFlagOperatorError)) throw error;
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe(error.code);
    expect(envelope.failure).toMatchObject({ class: "operator-input", code: error.code });
    return { kind: "refused", code: error.code, nextAction: error.nextAction };
  }

  /** `docsfab run create-documentation --instruction <text>` with `flags`, as parsed. */
  function runOutcome(instruction: string, flags: readonly string[]): Outcome {
    let parsed: ReturnType<typeof parseRunArguments>;
    try {
      parsed = parseRunArguments([
        "create-documentation",
        "--repo",
        REPOSITORY,
        "--instruction",
        instruction,
        ...flags,
      ]);
    } catch (error) {
      return refusal(error);
    }
    return parsed.dryRun ? { kind: "previews" } : { kind: "runs", draftMr: parsed.draftMr };
  }

  /** `docsfab do` with `args`: what it refuses, previews, routes, or would run. */
  async function doOutcome(args: readonly string[]): Promise<Outcome> {
    const runs: DoRunArguments[] = [];
    const admissions: string[] = [];
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    process.exitCode = undefined;
    try {
      const decision = await handleDoCommand([...args, "--repo", REPOSITORY, "--json"], {
        stateDirectory,
        admitCatalogWorkflow: async (request) => {
          admissions.push(request);
          return undefined;
        },
        runWorkflow: async (request) => {
          runs.push(request);
          return undefined;
        },
      });
      expect(admissions).toEqual([]);
      if (decision && "status" in decision && decision.status === "needs-input") {
        expect(runs).toEqual([]);
        return { kind: "stops", reason: decision.reason };
      }
      if (args.includes("--dry-run") || args.includes("--route-only")) {
        expect(runs).toEqual([]);
        return { kind: "previews" };
      }
      expect(runs).toHaveLength(1);
      expect(runs[0]!.workflow).toBe("create-documentation");
      return { kind: "runs", draftMr: runs[0]!.draftMr === true };
    } catch (error) {
      expect(runs).toEqual([]);
      expect(admissions).toEqual([]);
      return refusal(error);
    } finally {
      console.log = originalLog;
      process.exitCode = undefined;
    }
  }

  /** The outcome every surface must give: refuse what would publish, keep --patch-only. */
  function expectedForProhibition(delivery: Delivery): Outcome {
    return delivery === "patch-only"
      ? { kind: "runs", draftMr: false }
      : { kind: "refused", code: CONFLICT, nextAction: NEXT_ACTION };
  }

  function expectedWithoutProhibition(delivery: Delivery): Outcome {
    if (delivery === "dry-run") return { kind: "previews" };
    return { kind: "runs", draftMr: delivery !== "patch-only" };
  }

  describe("run and do refuse a delivery that publishes when the request forbids it", () => {
    it.each(PROHIBITIONS)("gives one outcome per delivery on every surface: %s", async (phrase) => {
      const text = `${BASE} ${phrase}`;
      for (const [delivery, flags] of Object.entries(DELIVERIES) as [Delivery, string[]][]) {
        const expected = expectedForProhibition(delivery);
        const label = `${delivery}: ${phrase}`;
        expect(runOutcome(text, flags), `run --instruction, ${label}`).toEqual(expected);
        expect(await doOutcome([text, ...flags]), `do sentence, ${label}`).toEqual(expected);
        expect(
          await doOutcome([BASE, "--instruction", text, ...flags]),
          `do --instruction, ${label}`,
        ).toEqual(expected);
      }
      // The `do` route preview refuses what the run refuses, and routes under --patch-only.
      for (const args of [[text], [BASE, "--instruction", text]]) {
        expect(await doOutcome([...args, "--route-only"]), `route-only: ${args.join(" ")}`).toEqual(
          {
            kind: "refused",
            code: CONFLICT,
            nextAction: NEXT_ACTION,
          },
        );
        expect(
          await doOutcome([...args, "--route-only", "--patch-only"]),
          `route-only --patch-only: ${args.join(" ")}`,
        ).toEqual({ kind: "previews" });
      }
    });

    it.each(NO_PROHIBITION)("keeps every delivery without a prohibition: %s", async (phrase) => {
      const text = `${BASE} ${phrase}`;
      for (const [delivery, flags] of Object.entries(DELIVERIES) as [Delivery, string[]][]) {
        const expected = expectedWithoutProhibition(delivery);
        const label = `${delivery}: ${phrase}`;
        expect(runOutcome(text, flags), `run --instruction, ${label}`).toEqual(expected);
        expect(await doOutcome([text, ...flags]), `do sentence, ${label}`).toEqual(expected);
        expect(
          await doOutcome([BASE, "--instruction", text, ...flags]),
          `do --instruction, ${label}`,
        ).toEqual(expected);
      }
      for (const flags of [["--route-only"], ["--route-only", "--patch-only"]]) {
        expect(await doOutcome([text, ...flags]), flags.join(" ")).toEqual({ kind: "previews" });
      }
    });

    it("refuses --comment-mr beside a prohibition on run and do alike", async () => {
      const text = `Review docs/guide.md against ${inputs.sourcePath}. Never post anything.`;
      let runError: unknown;
      try {
        parseRunArguments([
          "review-documentation",
          "--repo",
          REPOSITORY,
          "--instruction",
          text,
          "--comment-mr",
          "12",
        ]);
      } catch (error) {
        runError = error;
      }
      expect(runError).toBeInstanceOf(DeliveryFlagOperatorError);
      expect(refusal(runError)).toEqual({
        kind: "refused",
        code: CONFLICT,
        nextAction: NEXT_ACTION,
      });
      expect(await doOutcome([text, "--comment-mr", "12"])).toEqual({
        kind: "refused",
        code: CONFLICT,
        nextAction: NEXT_ACTION,
      });
    });

    it("previews a read-only run --dry-run under a prohibition without refusing it", () => {
      const parsed = parseRunArguments([
        "review-documentation",
        "--repo",
        REPOSITORY,
        "--instruction",
        "Review docs/guide.md. Do not publish.",
        "--dry-run",
      ]);
      expect(parsed).toMatchObject({
        workflow: "review-documentation",
        dryRun: true,
        draftMr: false,
      });
    });
  });

  describe("run reads every instruction it is given", () => {
    it.each([
      [BASE, "Do not publish."],
      ["Do not publish.", BASE],
    ])("refuses a second --instruction instead of dropping it: %s / %s", (first, second) => {
      expect(() =>
        parseRunArguments([
          "create-documentation",
          "--repo",
          REPOSITORY,
          "--instruction",
          first,
          "--instruction",
          second,
          "--patch-only",
        ]),
      ).toThrow("The --instruction option must not be duplicated on docsfab run.");
    });
  });

  /**
   * Realistic documentation requests that name publication, pushes, commits, or
   * merge requests as their subject. None forbids publishing, so none refuses.
   */
  const REALISTIC_REQUESTS = [
    "Create docs/install.md, an installation guide for Linux users.",
    "Update the README to document the new --timeout flag.",
    "Review the documentation for accuracy against src/cli.ts.",
    "Restructure docs/guide.md so prerequisites come first.",
    "Document how to publish a release to npm.",
    "Explain how to push a Docker image to the registry.",
    "Write a tutorial on opening a merge request in GitLab.",
    "Create a page that explains our commit message conventions.",
    "Update the contributing guide: contributors must sign their commits.",
    "Add a section on how to keep your fork up to date with upstream.",
    "Document the publish command and its --dry-run option.",
    "Update docs/release.md with the steps to publish the package.",
    "Create docs/ci.md describing how CI pushes images on every merge to main.",
    "Explain why the pipeline never publishes from forks.",
    "Write a troubleshooting entry for push rejected errors.",
    "Document the draft merge request workflow for reviewers.",
    "Create a guide for maintainers on reviewing pull requests.",
    "Describe how to commit generated files with the pre-commit hook.",
    "Add an example that posts a message to the Slack webhook.",
    "Update the API reference for the publish endpoint.",
    "Create docs/offline.md explaining how to work without pushing to the server.",
    "Review docs/quickstart.md and report problems. Do not edit files.",
    "Create a changelog entry for version 2.3.",
    "Update the security guide to say tokens must never be committed.",
    "Write a section about local-only builds.",
    "Create docs/patch.md describing how to apply a patch with git am.",
    "Only document the public API; skip internal modules.",
    "Keep the examples short and keep the tone friendly.",
    "Update the deployment guide so it never mentions the old server.",
    "Create a reference page for the git push options we support.",
    "Document that users should not commit the .env file.",
    "Explain the merge request approval rules.",
    "Create a how-to for publishing docs with Fern.",
    "Revise the onboarding guide; keep it concise.",
    "Update docs/branching.md: never commit directly to main.",
    "Draft release notes for 1.4 and list breaking changes.",
    "Update the guide to explain that the bot posts a comment on each merge request.",
    "Write a guide for working offline without publishing your notes.",
    "Add a FAQ entry: why does the push fail with a 403?",
    "Create docs/cli-reference.md for developers. Use the existing style.",
    "Explain how to preview the site locally without publishing it.",
    "Document the steps to open a pull request from a fork.",
    "Add a preview step so authors can check the rendered page without publishing it.",
    "Write a tutorial on syncing a fork without pushing to origin.",
    "Update docs/faq.md, then link it from the README.",
    "Create the troubleshooting page, then add it to the navigation.",
    "Document the --no-push flag, its default, and an example.",
    "Explain what happens when a push is rejected, and how to retry.",
    "Write a page about draft merge requests, review apps, and approvals.",
    "Update the guide, keeping the examples short.",
    "Create docs/mirror.md describing how the mirror job publishes tags to GitHub.",
    "Describe the publish step in the release pipeline, including its approvals.",
    "Update docs/git.md: explain rebase, merge, and push in that order.",
    "Write the contributor guide; mention that maintainers merge, contributors push branches.",
    "Add a note that the CLI never posts telemetry.",
    "Document the commit hooks, the push hooks, and the merge checks.",
    "Create a guide on reviewing merge requests without approving them too early.",
    "Explain the difference between publishing a package and pushing a tag.",
    "Update the README so it says local builds do not need a token.",
    "Create docs/editing.md for authors who preview pages without a server.",
  ] as const;

  /** Rule lists read as prohibitions: a known over-refusal that --patch-only clears. */
  const OVER_REFUSED_RULE_LISTS = [
    "Add these rules. Never push to origin. Keep commits small.",
    "List the rules. Do not commit. Do not push. Run the tests first.",
    "Update the security checklist: never commit the credentials file.",
  ] as const;

  describe("realistic requests keep their delivery", () => {
    it("refuses none of the realistic requests that only mention publication", () => {
      const refused = REALISTIC_REQUESTS.filter(
        (request) => runOutcome(request, []).kind === "refused",
      );
      expect(refused).toEqual([]);
    });

    it('keeps the delivery when "without publishing" describes the content', () => {
      for (const request of [
        "Add a preview step so authors can check the rendered page without publishing it.",
        `${BASE} Cover every option without publishing.`,
      ]) {
        expect(runOutcome(request, []), request).toEqual({ kind: "runs", draftMr: true });
      }
    });

    it.each(OVER_REFUSED_RULE_LISTS)(
      "refuses a rule list and runs it with --patch-only: %s",
      (request) => {
        expect(runOutcome(request, [])).toEqual({
          kind: "refused",
          code: CONFLICT,
          nextAction: NEXT_ACTION,
        });
        expect(runOutcome(request, ["--patch-only"])).toEqual({ kind: "runs", draftMr: false });
      },
    );
  });

  describe("affirmative and mixed publication wording", () => {
    const AFFIRMATIVE = [
      "Publish the guide.",
      "Open an MR.",
      "Open a draft merge request for the new page.",
    ] as const;
    /** A prohibition beside a merge request ask: refused, and never routed past. */
    const MIXED = [
      "Do not push, but open a merge request.",
      "Do not push, and open a merge request.",
      "Do not publish and open a merge request.",
      "Do not publish, open a merge request.",
    ] as const;

    it.each(AFFIRMATIVE)("runs the default delivery for run --instruction: %s", (phrase) => {
      expect(runOutcome(`${BASE} ${phrase}`, [])).toEqual({ kind: "runs", draftMr: true });
    });

    it.each(AFFIRMATIVE)(
      "stops do as a publication request, with or without --patch-only: %s",
      async (phrase) => {
        for (const flags of [[], ["--patch-only"], ["--route-only", "--patch-only"]]) {
          expect(await doOutcome([`${BASE} ${phrase}`, ...flags]), flags.join(" ")).toEqual({
            kind: "stops",
            reason: "risk-expanding",
          });
        }
      },
    );

    it.each(MIXED)(
      "refuses the publishing delivery and never routes the ask: %s",
      async (phrase) => {
        const text = `${BASE} ${phrase}`;
        const refused = { kind: "refused", code: CONFLICT, nextAction: NEXT_ACTION };
        expect(runOutcome(text, []), "run").toEqual(refused);
        expect(runOutcome(text, ["--draft-mr"]), "run --draft-mr").toEqual(refused);
        expect(await doOutcome([text]), "do").toEqual(refused);
        for (const flags of [["--patch-only"], ["--route-only", "--patch-only"]]) {
          expect(await doOutcome([text, ...flags]), flags.join(" ")).toEqual({
            kind: "stops",
            reason: "risk-expanding",
          });
        }
      },
    );

    it("reads a double-quoted prohibition as content on run and do", async () => {
      const text = `${BASE} Quote the rule "Build first. Do not publish." in the errors section.`;
      expect(runOutcome(text, []), "run").toEqual({ kind: "runs", draftMr: true });
      expect(runOutcome(text, ["--dry-run"]), "run --dry-run").toEqual({ kind: "previews" });
      // The quoted word still reads as a publication request to the router.
      expect(await doOutcome([text, "--patch-only"]), "do --patch-only").toEqual({
        kind: "stops",
        reason: "risk-expanding",
      });
      expect(
        await doOutcome([BASE, "--instruction", text, "--dry-run"]),
        "do --instruction --dry-run",
      ).toEqual({ kind: "previews" });
    });
  });

  const WORKFLOW_PROMPTS = {
    review: inputs.review,
    create: inputs.create,
    update: inputs.update,
    restructure: inputs.restructure,
  };

  /** `do --route-only --json` with `flags`: the routed workflow, or the refusal code. */
  async function routeOnly(request: string, flags: readonly string[]): Promise<string> {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    process.exitCode = undefined;
    try {
      await handleDoCommand([request, "--repo", REPOSITORY, "--route-only", "--json", ...flags], {
        stateDirectory,
        admitCatalogWorkflow: async () => {
          throw new Error("--route-only must not ask the admission model");
        },
        runWorkflow: async () => {
          throw new Error("--route-only must not run a workflow");
        },
      });
      const envelope = JSON.parse(logs.join("\n")) as {
        decision: { status: string; workflow?: string; reason?: string };
      };
      return envelope.decision.status === "selected"
        ? envelope.decision.workflow!
        : `needs-input:${envelope.decision.reason}`;
    } catch (error) {
      return refusal(error).kind === "refused" ? (error as DeliveryFlagOperatorError).code : "";
    } finally {
      console.log = originalLog;
      process.exitCode = undefined;
    }
  }

  describe("do routes explicit local workflow requests", () => {
    it("routes each prompt under --patch-only and refuses the write prompts without it", async () => {
      const routes: Record<string, [string, string]> = {};
      for (const [name, prompt] of Object.entries(WORKFLOW_PROMPTS)) {
        routes[name] = [await routeOnly(prompt, ["--patch-only"]), await routeOnly(prompt, [])];
      }
      expect(routes).toEqual({
        review: ["update-documentation", "review-documentation"],
        create: ["create-documentation", CONFLICT],
        update: ["update-documentation", CONFLICT],
        restructure: ["restructure-documentation", CONFLICT],
      });
    });

    it("runs each write prompt under --patch-only with no draft merge request", async () => {
      for (const name of ["create", "update", "restructure"] as const) {
        const runs: DoRunArguments[] = [];
        await handleDoCommand([WORKFLOW_PROMPTS[name], "--repo", REPOSITORY, "--patch-only"], {
          stateDirectory,
          admitCatalogWorkflow: async () => {
            throw new Error("a table hit must not ask the admission model");
          },
          runWorkflow: async (request) => {
            runs.push(request);
            return undefined;
          },
        });
        expect(runs, name).toHaveLength(1);
        expect(runs[0], name).toMatchObject({
          workflow: `${name}-documentation`,
          allowWrite: true,
          instruction: WORKFLOW_PROMPTS[name],
        });
        expect(runs[0]!.draftMr, name).toBeUndefined();
        expect(runs[0]!.remoteName, name).toBeUndefined();
      }
    });
  });
}
