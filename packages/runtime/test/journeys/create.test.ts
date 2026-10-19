// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Journey: create a page to a patch. `docsfab run create-documentation --source`
 * argv through the shipped parser and runner: the knowledge first pass, the
 * real `PiHarness` steps with their real source-tool grant, and a scripted
 * model. The patch is read back through the persisted record, the patch file,
 * and `docsfab runs show --json`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRunFailure } from "../../src/operator/failure-classification.js";
import { OmittedFirstPassTargetError } from "../../src/workflow-execution/plan-binding.js";
import { canonicalSourceObligationProposal } from "../../src/workflow-execution/source-obligation.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import { commitFixture, git } from "../helpers/git.js";
import { sourceObligationProposalFixture } from "../helpers/verification.js";
import { temporaryRoots } from "../helpers/temp.js";
import { captureGitSnapshot } from "../support/execution-convergence.js";
import { listedInventory, type SourceListing } from "../support/source-listing.js";
import {
  createJourneyFixture,
  expectOfflineInterpretation,
  journeyProviders,
  journeyTestTimeoutMs,
  readPersistedRecord,
  runJourney,
  type JourneyFixture,
  runsShowJson,
} from "../support/journey.js";
import {
  callTools,
  reply,
  replyJson,
  type JourneyRequest,
  type JourneyTurn,
} from "../support/journey-provider.js";

const roots = temporaryRoots();
const provider = journeyProviders();
const SOURCE = "src/greet.ts";
const PAGE = "docs/greeting.md";
const SUBSTITUTE_PAGE = "docs/welcome.md";
/**
 * #2335's own request: `docsfab run create-documentation --instruction
 * 'Create docs/a.md, a guide for developers.' --patch-only`.
 */
const ISSUE_PAGE = "docs/a.md";
const ISSUE_INSTRUCTION = `Create ${ISSUE_PAGE}, a guide for developers.`;
/** What `docsfab run` prints once it has decided which project setup the run needs. */
const LOCAL_UNCONFIGURED_LINE =
  "using default documentation roots; retaining a local result without project setup";
const HOST_PRIVATE_LINE = "using host-private project setup within the explicit proposal scope";
const SENTENCE = "The `greet` function returns the greeting Greeter prints for one name.";
/** The retain branch runs; the revise branch's steps never start. */
const REVISE_BRANCH = new Set([
  "revise-documentation",
  "lint-revised-documentation",
  "provisional-revised-technical-verification",
  "verify-revised-technical-accuracy",
  "review-revised-documentation",
]);

interface WindowRead {
  readonly kind: string;
  readonly spans: ReadonlyArray<{ readonly spanId: string; readonly text: string }>;
}

function sourceSpans(request: JourneyRequest, listCallId: string) {
  return listedInventory(request.toolResultJson<SourceListing>(listCallId)).filter(
    (span) => span.repositoryPath === SOURCE,
  );
}

/**
 * The first pass: decomposition, completeness audit, then the support
 * assessment citing an offered span of the bound source. Its target must be
 * PAGE, the page the instruction names, which the plan must then address.
 */
function firstPassTurns(): JourneyTurn[] {
  return [
    replyJson({ schemaVersion: 1, additionalObligations: [] }),
    replyJson({ schemaVersion: 1, complete: true, omissions: [] }),
    (request) => {
      const span = request.evidenceFrames().find((frame) => frame.path === SOURCE);
      if (!span) throw new Error(`no offered evidence frame for ${SOURCE}`);
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          assessments: [
            {
              obligationId: "target-01",
              status: "supported",
              evidenceSpanIds: [span.id],
              detail: "The greet source states the greeting Greeter prints.",
            },
            {
              obligationId: "workflow-target-set",
              status: "supported",
              evidenceSpanIds: [],
              detail: "Bound by the instruction.",
            },
          ],
        }),
      };
    },
  ];
}

/** plan-documentation: list the bound sources, read the source, then plan one page. */
function planTurns(page: string): JourneyTurn[] {
  return [
    callTools([{ id: "plan-list", name: "docsfab_list_sources", arguments: {} }]),
    callTools((request) => {
      const [span] = sourceSpans(request, "plan-list");
      return [
        {
          id: "plan-read",
          name: "docsfab_read_source",
          arguments: {
            observationId: span!.observationId,
            representationId: span!.representationId,
            fromByte: 0,
          },
        },
      ];
    }),
    replyJson({
      summary: `Create ${page} from the greet source.`,
      planBinding: {
        mode: "create",
        pages: [{ path: page, disposition: "create" }],
        sourceBindings: [{ pagePath: page, sources: [SOURCE] }],
      },
    }),
  ];
}

/** One reply per model turn of a create run: first pass, then each step in order. */
function createTurns(revision: string, page = PAGE): JourneyTurn[] {
  const judgment = {
    verdict: "pass",
    coverage: [
      {
        path: page,
        status: "verified",
        evidence: [`${SOURCE}:3-6`],
        reason: "Compared the page sentence with the greet source.",
      },
    ],
    issueJudgments: [],
    obligationJudgments: [],
  };
  return [
    ...firstPassTurns(),
    ...planTurns(page),
    // derive-source-obligations
    reply(canonicalSourceObligationProposal(sourceObligationProposalFixture(`${SOURCE}:3-6`))),
    // write-documentation: list, write the page and cite its one sentence, report.
    callTools([{ id: "write-list", name: "docsfab_list_sources", arguments: {} }]),
    callTools((request) => {
      const spans = sourceSpans(request, "write-list");
      return [
        {
          id: "write-page",
          name: "write",
          arguments: { path: page, content: `# Greeting\n\n${SENTENCE}\n` },
        },
        {
          id: "write-cite",
          name: "docsfab_cite_source",
          arguments: {
            claim: SENTENCE,
            observationId: spans[0]!.observationId,
            representationId: spans[0]!.representationId,
            spanIds: spans.map((span) => span.spanId),
          },
        },
      ];
    }),
    reply(`Created ${page} from the bound greet source.`),
    // provisional-technical-verification, review-documentation, verify-technical-accuracy
    replyJson(judgment),
    replyJson({ verdict: "pass", issues: [] }),
    replyJson(judgment),
    // test-audience-understanding, then evaluate-document-quality
    reply("Audience evidence is unavailable in this scripted journey."),
    replyJson({
      evaluation: {
        profile: { id: "docsfab-documentation-quality", version: "v0.1" },
        model_version: "documentation-quality-model-v0.2",
        target: { scope_type: "documentation-set", repository_revision: revision, paths: [page] },
      },
      qualityScore: null,
      reportMarkdown: "# Documentation quality evaluation report\n",
    }),
  ];
}

/** The create argv: the instruction names PAGE, which every plan of the run must address. */
function createArgv(fixture: JourneyFixture): string[] {
  return [
    "create-documentation",
    "--repo",
    fixture.repository,
    "--source",
    SOURCE,
    "--instruction",
    `Create ${PAGE} for the greet function.`,
    "--allow-write",
    "--patch-only",
  ];
}

/**
 * #2335's argv as the router parses it: the instruction and `flags`, never
 * `--allow-write`. `--repo` stands in for the working directory, and `--source`
 * binds the one source the scripted model reads, as in the other create journeys.
 */
function issueArgv(fixture: JourneyFixture, ...flags: string[]): string[] {
  return [
    "create-documentation",
    "--repo",
    fixture.repository,
    "--source",
    SOURCE,
    "--instruction",
    ISSUE_INSTRUCTION,
    ...flags,
  ];
}

/** The greeter fixture with its tracked `.docsfab.json` removed and committed, and no remote. */
async function unconfiguredFixture(): Promise<JourneyFixture> {
  const base = await createJourneyFixture("greeter", roots);
  await git(base.repository, ["rm", ".docsfab.json"]);
  return { ...base, revision: await commitFixture(base.repository, "unconfigured local source") };
}

/**
 * Give the repository a GitLab `origin` that needs no network: the host never
 * resolves, and the refs a clone would hold are made locally.
 */
async function addGitLabOrigin(repository: string): Promise<void> {
  const url = "ssh://git@gitlab.example.test/group/docs.git";
  await git(repository, ["remote", "add", "origin", url]);
  await git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
}

/** What a run must leave alone besides the checkout's files: remotes, refs, and linked worktrees. */
async function gitShape(repository: string) {
  return {
    remotes: await git(repository, ["remote"]),
    refs: await git(repository, ["for-each-ref"]),
    worktrees: await git(repository, ["worktree", "list", "--porcelain"]),
  };
}

describe("create journey", () => {
  it.each(["missing", "untracked-private"] as const)(
    "retains a source-grounded local patch without a project config or remote (%s)",
    async (configState) => {
      const fixture = await unconfiguredFixture();
      if (configState === "untracked-private") {
        await writeFile(
          join(fixture.repository, ".docsfab.json"),
          '{"documentationRoots":["private"],"provider":{"configuration":"private"}}\n',
        );
      }
      expect(await git(fixture.repository, ["remote"])).toBe("");
      const before = await captureGitSnapshot(fixture.repository);
      const model = provider(createTurns(fixture.revision));

      const record = await runJourney({ fixture, provider: model, argv: createArgv(fixture) });
      const saved = await readPersistedRecord(fixture, record.id);
      expect(saved).toMatchObject({
        status: "succeeded",
        repository: { revision: fixture.revision },
        changes: { files: [{ path: PAGE, status: "added" }] },
      });
      const patchPath = saved.changes!.patch!.artifactPath;
      const patch = await readFile(patchPath, "utf8");
      expect(patch).toContain(SENTENCE);
      expect(patch).not.toContain(".docsfab.json");
      await git(fixture.repository, ["apply", "--check", patchPath]);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
      if (configState === "missing") {
        await expect(readFile(join(fixture.repository, ".docsfab.json"))).rejects.toThrow();
      } else {
        expect(await git(fixture.repository, ["status", "--short"])).toBe("?? .docsfab.json");
      }
    },
    journeyTestTimeoutMs(),
  );

  it(
    "retains a local patch for the issue's own --patch-only request with no remote or project config (#2335)",
    async () => {
      const fixture = await unconfiguredFixture();
      const before = await captureGitSnapshot(fixture.repository);
      const shapeBefore = await gitShape(fixture.repository);
      expect(shapeBefore.remotes).toBe("");
      const model = provider(createTurns(fixture.revision, ISSUE_PAGE));
      const statusLines: string[] = [];

      const record = await runJourney({
        fixture,
        provider: model,
        argv: issueArgv(fixture, "--patch-only"),
        statusLines,
      });

      // Project setup ran first and took the local branch, which it announces.
      const printed = `status lines:\n${statusLines.join("\n")}`;
      const setup = statusLines.indexOf("checking project configuration");
      expect(statusLines.slice(setup, setup + 2), printed).toEqual([
        "checking project configuration",
        LOCAL_UNCONFIGURED_LINE,
      ]);
      expect(statusLines, printed).not.toContain(HOST_PRIVATE_LINE);
      const saved = await readPersistedRecord(fixture, record.id);
      expect(saved).toMatchObject({
        status: "succeeded",
        repository: { revision: fixture.revision },
        changes: { files: [{ path: ISSUE_PAGE, status: "added" }] },
      });
      const patchPath = saved.changes!.patch!.artifactPath;
      const patch = await readFile(patchPath, "utf8");
      expect(patch).toContain(SENTENCE);
      expect(patch).not.toContain(".docsfab.json");
      await git(fixture.repository, ["apply", "--check", patchPath]);

      // The checkout is as it was: files, index, HEAD, remotes, refs, and worktrees.
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
      expect(await gitShape(fixture.repository)).toEqual(shapeBefore);
      await expect(readFile(join(fixture.repository, ".docsfab.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    journeyTestTimeoutMs(),
  );

  it(
    "refuses the same request without --patch-only before any model call, since publishing needs a GitLab remote (control)",
    async () => {
      const fixture = await unconfiguredFixture();
      const before = await captureGitSnapshot(fixture.repository);
      const model = provider([]);

      await expect(
        runJourney({ fixture, provider: model, argv: issueArgv(fixture) }),
      ).rejects.toMatchObject({ code: "missing-remote" });

      expect(model.requests).toEqual([]);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    },
    journeyTestTimeoutMs(),
  );

  it(
    "still refuses an invalid tracked project config under --patch-only before any model call (control)",
    async () => {
      const base = await unconfiguredFixture();
      await writeFile(join(base.repository, ".docsfab.json"), '{"schemaVersion":1}\n');
      const fixture = {
        ...base,
        revision: await commitFixture(base.repository, "invalid tracked project config"),
      };
      const before = await captureGitSnapshot(fixture.repository);
      const model = provider([]);
      const statusLines: string[] = [];

      await expect(
        runJourney({
          fixture,
          provider: model,
          argv: issueArgv(fixture, "--patch-only"),
          statusLines,
        }),
      ).rejects.toThrow(
        "Existing DocsFab project configuration is invalid; no project file was changed.",
      );

      expect(model.requests).toEqual([]);
      expect(statusLines).not.toContain(LOCAL_UNCONFIGURED_LINE);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    },
    journeyTestTimeoutMs(),
  );

  it.each([
    {
      delivery: "--patch-only",
      flags: ["--patch-only"],
      announced: LOCAL_UNCONFIGURED_LINE,
      absent: HOST_PRIVATE_LINE,
    },
    {
      delivery: "the default draft merge request",
      flags: [] as string[],
      announced: HOST_PRIVATE_LINE,
      absent: LOCAL_UNCONFIGURED_LINE,
    },
  ])(
    "sets up the project only when the request publishes, even with a GitLab remote ($delivery)",
    async ({ flags, announced, absent }) => {
      const fixture = await unconfiguredFixture();
      await addGitLabOrigin(fixture.repository);
      const before = await captureGitSnapshot(fixture.repository);
      // The scripted plan addresses another page than the request names, so the
      // run stops at plan admission: after project setup, before any write.
      const model = provider([...firstPassTurns(), ...planTurns(SUBSTITUTE_PAGE)]);
      const statusLines: string[] = [];

      const record = await runJourney({
        fixture,
        provider: model,
        argv: issueArgv(fixture, ...flags),
        statusLines,
        options: {
          ensurePublicationFreshness: async () => ({ branch: "main", revision: fixture.revision }),
        },
      });

      const printed = `status lines:\n${statusLines.join("\n")}`;
      expect(statusLines, printed).toContain(announced);
      expect(statusLines, printed).not.toContain(absent);
      const saved = await readPersistedRecord(fixture, record.id);
      expect(readRunFailure(saved)).toMatchObject({ code: "omitted-mandatory-obligation" });
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    },
    journeyTestTimeoutMs(),
  );

  it(
    "creates a source-grounded page as a patch the repository accepts",
    async () => {
      const fixture = await createJourneyFixture("greeter", roots);
      const before = await captureGitSnapshot(fixture.repository);
      const model = provider(createTurns(fixture.revision));

      const record = await runJourney({
        fixture,
        provider: model,
        argv: createArgv(fixture),
      });
      // A succeeded run leaves the process exit code unset.
      expect(process.exitCode ?? 0).toBe(0);

      const saved = await readPersistedRecord(fixture, record.id);
      expect(saved).toMatchObject({
        id: record.id,
        workflow: "create-documentation",
        status: "succeeded",
        repository: { revision: fixture.revision },
        changes: { files: [{ path: PAGE, status: "added" }] },
      });
      expectOfflineInterpretation(saved);
      expect(saved.steps.map((step) => step.id)).toEqual(
        getWorkflow("create-documentation")
          .steps.map((step) => step.id)
          .filter((id) => !REVISE_BRANCH.has(id)),
      );
      expect(saved.steps.map((step) => step.status)).toEqual(saved.steps.map(() => "succeeded"));

      // The plan step read the bound source through the granted tool: the
      // result answering the read call carries the source text.
      const answered = model.requests.find(
        (request) => request.toolResult("plan-read") !== undefined,
      );
      expect(answered?.offeredTools).toContain("docsfab_read_source");
      expect(answered?.offeredTools).not.toContain("write");
      const read = answered!.toolResultJson<WindowRead>("plan-read");
      expect(read.kind).toBe("docsfab-source-window-read");
      const sourceText = await readFile(join(fixture.repository, SOURCE), "utf8");
      expect(read.spans.map((span) => span.text)).toEqual(sourceText.trimEnd().split("\n"));
      const plan = saved.steps.find((step) => step.id === "plan-documentation")!;
      expect(plan.tools?.byTool).toContainEqual({
        name: "docsfab_read_source",
        calls: 1,
        failures: 0,
      });

      // Every sentence the writer added is cited, so no citation gap is labelled.
      const writeCitations = saved.sourceCitations?.steps.find(
        (step) => step.stepId === "write-documentation",
      );
      expect(writeCitations?.materialClaimSha256s).toHaveLength(1);
      expect(writeCitations?.citations.map((citation) => citation.supportedClaimSha256)).toEqual(
        writeCitations?.materialClaimSha256s,
      );

      // The patch applies to the fixture and adds exactly the planned page,
      // and the source repository is untouched.
      const patchPath = saved.changes!.patch!.artifactPath;
      await git(fixture.repository, ["apply", "--check", patchPath]);
      const numstat = await git(fixture.repository, ["apply", "--numstat", patchPath]);
      expect(numstat.split("\n").map((line) => line.split("\t")[2])).toEqual([PAGE]);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);

      const shown = await runsShowJson(fixture, record.id);
      expect(shown.exitCode).toBe(0);
      expect(shown.value).toMatchObject({
        kind: "docsfab-run-result",
        execution: {
          runId: record.id,
          workflow: "create-documentation",
          status: "succeeded",
          exitCode: 0,
          patchPath,
          patchSha256: saved.changes!.patch!.sha256,
        },
      });
    },
    journeyTestTimeoutMs(),
  );
  it(
    "refuses a plan that omits the page the request named, before any write",
    async () => {
      const fixture = await createJourneyFixture("greeter", roots);
      const before = await captureGitSnapshot(fixture.repository);
      // The substitute page lies inside the run's docs/ write roots, so only
      // the binding to the named page can refuse it.
      const model = provider([...firstPassTurns(), ...planTurns(SUBSTITUTE_PAGE)]);

      const record = await runJourney({ fixture, provider: model, argv: createArgv(fixture) });
      const runExitCode = process.exitCode;

      const saved = await readPersistedRecord(fixture, record.id);
      expect(runExitCode).toBe(1);
      expect(saved).toMatchObject({
        id: record.id,
        workflow: "create-documentation",
        status: "failed",
        changes: { files: [] },
      });
      expect(readRunFailure(saved)).toEqual({
        class: "planning-refusal",
        layer: "workflow",
        code: "omitted-mandatory-obligation",
      });
      // The plan step is refused on its first and only attempt: no correction
      // round re-asks the model, and no later step starts.
      const [plan, ...later] = saved.steps;
      expect(plan).toMatchObject({ id: "plan-documentation", status: "failed" });
      expect(plan!.error).toBe(new OmittedFirstPassTargetError([PAGE], "create").message);
      expect(plan!.inference?.attempts).toHaveLength(1);
      expect(later.map((step) => step.status)).toEqual(later.map(() => "pending"));
      expect(model.requests).toHaveLength(model.turnCount);
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);

      const shown = await runsShowJson(fixture, record.id);
      expect(shown.exitCode).toBe(1);
      expect(shown.value).toMatchObject({
        execution: { runId: record.id, status: "failed", exitCode: 1 },
        failures: expect.arrayContaining([
          expect.objectContaining({
            scope: "step",
            stepId: "plan-documentation",
            code: "omitted-mandatory-obligation",
          }),
        ]),
      });
    },
    journeyTestTimeoutMs(),
  );
});
