// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `/sources` command family in the live terminal.
 *
 * Fixtures only. Every GitLab identity, page and tracked byte in this file is a
 * deterministic stub; no `glab`, no network and no checkout is touched, so this
 * is not a live provider proof.
 *
 * The file is organized around three properties, and each block is written so
 * that deleting the behaviour it describes makes it fail rather than pass
 * vacuously:
 *
 * - The dispatcher is the only mutation channel, and it is reached from the
 *   terminal line, never from model output. Every model-channel assertion has a
 *   positive control typed by the operator.
 * - The listing and the next run request are two projections of one state, so
 *   they are compared as values on every mutation rather than merely both being
 *   non-empty.
 * - Identity is resolved, and the resolution costs zero reads when the
 *   reference never parses.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { unicodeCellWidth } from "../src/operator/index.js";

import {
  ChangeRequestSelectorError,
  parseChangeRequestSelector,
} from "../src/inputs/change-request-selector.js";
import {
  GITLAB_READ_FAILURES,
  resolveGitLabAcquisitionScope,
  type GitLabProjectIdentityPortV1,
} from "../src/inputs/gitlab-source-provider.js";
import { SOURCE_DISCOVERY_REFUSALS, SourceDiscoveryError } from "../src/inputs/source-discovery.js";
import type { MergedMrPageV1 } from "../src/inputs/merged-mr-discovery.js";
import {
  resolveMergedMrDateWindow,
  type MergedMrRecordV1,
} from "../src/inputs/merged-mr-selection.js";
import {
  failSourceEvidenceService,
  type SourceStepReaderV1,
} from "../src/inputs/source-resolver.js";
import { createSourceStepSearcher } from "../src/inputs/source-step-search.js";
import type { TrackedSourceReaderV1 } from "../src/inputs/source-acquisition.js";
import { hostRootSet } from "../src/security/egress.js";
import {
  ORIGINAL_SOURCE_AUTHORITY_EVIDENCE_KIND,
  ORIGINAL_SOURCE_AUTHORITY_KIND,
  validateOriginalSourceAuthorityEvidence,
} from "../src/workflow-execution/source-obligation-authority.js";
import {
  createLiveAgentSourceSelection,
  isSourceCommandLine,
  parseSourceCommand,
  renderSourceCommandOutcome,
  SOURCE_COMMAND_LINE_LIMIT,
  SOURCE_COMMAND_PREFIX,
  SOURCE_COMMAND_REFUSAL_CODES,
  SOURCE_COMMAND_REFUSALS,
  SOURCE_COMMAND_VERBS,
  SOURCE_PREVIEW_MAX_CHARACTERS,
  SourceCommandError,
  type LiveAgentSourcePortsV1,
  type SourceCommandOutcomeV1,
} from "../src/live-agent/source-commands.js";
import {
  buildLiveAgentSystemPrompt,
  createLiveAgentBoundedRunner,
  createLiveAgentSourcePorts,
  liveAgentSourceCommandRefusal,
  liveAgentWorkflowRunRequest,
  runTerminalConversation,
} from "../src/live-agent/host.js";
import { RepositoryAccessRefusalError } from "../src/repository/workspace/access-refusal.js";
import { admitCliSourceSelection, parseRunArguments } from "../src/cli/run-arguments.js";
import { ExecInitCommandRunner } from "../src/init/shared.js";
import type { CommandRunner } from "../src/init/types.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { LiveAgentCapabilities } from "../src/live-agent/capabilities.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

const HOST = "gitlab.sources.test";
const PROJECT_PATH = "team/docs-project";
const PROJECT_ID = 437_040;
const OTHER_PROJECT_ID = 811_222;
const TARGET_BRANCH = "main";
const SOURCE_PATH = "docs/release-notes.txt";
const SECOND_SOURCE_PATH = "docs/upgrade-guide.txt";

/**
 * A path whose bytes are a shell substitution and a backtick command.
 *
 * It is a *fixture path*, never written to a filesystem: the assertion is that
 * the dispatcher stored exactly these bytes, so a dispatcher that expanded,
 * unquoted or globbed them would produce a different string.
 */
const LITERAL_EXPANSION_PATH = "docs/$(id)-`id`-${HOME}.txt";

/**
 * Credential-shaped fixture. It exists only in this file, is never written to
 * any artefact or shipped module, and is only ever fed to a screen that must
 * refuse it, by tests that make it one of DocsFab's own configured credentials
 * (#1807). SHAPED_FIXTURE has the same shape but is never configured, so the
 * screens let it through.
 */
const CREDENTIAL_FIXTURE = ["glpat", plantedCredentialValue(73, 24)].join("-");
const SHAPED_FIXTURE = ["glpat", plantedCredentialValue(74, 24)].join("-");

/** A host filesystem path fixture, likewise only ever fed to a screen. */
const HOST_PATH_FIXTURE = "see /Users/operator/secrets/notes.md for the rest";

const encoder = new TextEncoder();

/** The date-scoped instruction shape that mints its own merge-request binding. */
const DATE_WINDOW_INSTRUCTION =
  "Update docs for merge requests merged into main on 2026-09-15 in America/Los_Angeles.";

function identityPort(projectId = PROJECT_ID): GitLabProjectIdentityPortV1 & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async resolveProjectIdentity(reference: { host: string; projectPath: string }) {
      calls.push(`${reference.host}/${reference.projectPath}`);
      return { host: reference.host, projectPath: reference.projectPath, projectId };
    },
  };
}

/** An identity port that answers about a different project than it was asked. */
function crossProjectIdentityPort(): GitLabProjectIdentityPortV1 & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveProjectIdentity(reference: { host: string; projectPath: string }) {
      calls.push(`${reference.host}/${reference.projectPath}`);
      return { host: reference.host, projectPath: "other/project", projectId: OTHER_PROJECT_ID };
    },
  };
}

/** A tracked reader over fixture bytes that records every path it was asked for. */
function trackedReader(files: Record<string, string>): TrackedSourceReaderV1 & {
  readonly reads: string[];
  set(path: string, contents: string): void;
} {
  const contents = new Map(Object.entries(files));
  const reads: string[] = [];
  return {
    reads,
    set(path: string, value: string) {
      contents.set(path, value);
    },
    async isTrackedRegularFile(repositoryPath: string) {
      return contents.has(repositoryPath);
    },
    async readTrackedBytes(repositoryPath: string, maxBytes: number) {
      reads.push(repositoryPath);
      const value = contents.get(repositoryPath);
      if (value === undefined) throw new Error("not tracked");
      return encoder.encode(value).slice(0, maxBytes);
    },
  };
}

function row(iid: number, mergedAt: string): MergedMrRecordV1 {
  return {
    iid,
    state: "merged",
    mergedAt,
    targetBranch: TARGET_BRANCH,
    mergeCommitSha: createHash("sha256").update(`merge-${iid}`).digest("hex").slice(0, 40),
    squashCommitSha: null,
    sourceBranch: `agent/${iid}`,
    url: `https://${HOST}/${PROJECT_PATH}/-/merge_requests/${iid}`,
    title: `merge request ${iid}`,
    description: `body ${iid}`,
  };
}

/**
 * A step reader with an empty binding.
 *
 * Exactly what a live conversation has: nothing is sealed, so every observation
 * id is outside the binding. It is the real reader shape the merged-MR searcher
 * re-checks on construction, not a loosened stand-in.
 */
const emptyBindingReader: SourceStepReaderV1 = {
  listSources: () => [],
  read: () => failSourceEvidenceService("observation-unavailable"),
};

function countingPagePort(pages: readonly MergedMrPageV1[]) {
  const requested: number[] = [];
  return {
    requested,
    port: {
      orderedDescendingByMergedAt: true,
      async fetchPage(page: number): Promise<MergedMrPageV1> {
        requested.push(page);
        const fetched = pages[page - 1];
        if (!fetched) throw Object.assign(new Error("no such page"), { code: "response" });
        return fetched;
      },
    },
  };
}

/** Build the real merged-MR searcher over fixture pages and a proved scope. */
async function shippedSearcher(pages: readonly MergedMrPageV1[]) {
  const scope = await resolveGitLabAcquisitionScope({
    reference: { host: HOST, projectPath: PROJECT_PATH },
    identityPort: identityPort(),
  });
  const paging = countingPagePort(pages);
  return {
    requested: paging.requested,
    searcher: createSourceStepSearcher({
      scope,
      reader: emptyBindingReader,
      port: paging.port,
      window: resolveMergedMrDateWindow({
        timeZone: "UTC",
        startDate: "2026-09-01",
        endDate: "2026-09-30",
      }),
      targetBranch: TARGET_BRANCH,
    }),
  };
}

function selection(
  input: { sourcePaths?: readonly string[]; ports?: LiveAgentSourcePortsV1 } = {},
) {
  return createLiveAgentSourceSelection({
    ...(input.sourcePaths ? { sourcePaths: input.sourcePaths } : {}),
    ...(input.ports ? { ports: input.ports } : {}),
  });
}

/**
 * The exact request the live-agent run path would hand the shared assembly.
 *
 * Built through the shipped `liveAgentWorkflowRunRequest`, not restated here,
 * so the differential compares the listing against the real run-path request
 * rather than against a second copy of the same idea.
 */
function runRequestFor(state: ReturnType<typeof selection>) {
  return liveAgentWorkflowRunRequest({
    workflow: "update-documentation",
    instruction: "refresh the release notes",
    repositoryPath: "/workspace/docsfab",
    allowWrite: true,
    ...state.requestFields(),
  });
}

/**
 * The exact sentence the shared admission raises for a date-scoped instruction
 * beside a merge-request selector, taken from `parseRunArguments` itself for
 * the same instruction and merge request. The property is not the wording: a
 * live-agent turn relays *whatever* `docsfab run` raises for the same words,
 * verbatim, so a rewording moves both sides together.
 */
function sharedDateWindowRefusal(): string {
  try {
    parseRunArguments([
      "update-documentation",
      "--instruction",
      DATE_WINDOW_INSTRUCTION,
      "--pr",
      "843",
    ]);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(
    "The shared admission no longer refuses a date-scoped instruction beside a merge-request selector, so this suite cannot derive the sentence a live-agent turn must relay.",
  );
}

const execute = promisify(execFile);
const temporaryRoots: string[] = [];
afterAll(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A committed checkout, so the tracked reader has a revision to export. */
async function temporaryCheckout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-sources-"));
  temporaryRoots.push(root);
  await execute("git", ["init", "--initial-branch=main"], { cwd: root });
  await execute("git", ["config", "user.email", "fixture@docsfab.test"], { cwd: root });
  await execute("git", ["config", "user.name", "DocsFab Fixture"], { cwd: root });
  await execute("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  await execute("mkdir", ["-p", join(root, "docs")], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(root, path), contents, "utf8");
  }
  await execute("git", ["add", "-A"], { cwd: root });
  await execute("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

/**
 * A `glab` stand-in.
 *
 * Only the two project-identity reads the `/sources add !N` path performs are
 * answered; anything else fails the way an unavailable forge would, so a test
 * that accidentally reached a third endpoint would not silently pass.
 */
function fakeForge(projectId = PROJECT_ID): CommandRunner & { readonly calls: string[][] } {
  const calls: string[][] = [];
  // `git` still runs for real, against the temporary checkout: the point of the
  // fixture is to remove the network, not to remove the checkout resolution
  // this test exists to exercise.
  const real = new ExecInitCommandRunner();
  return {
    calls,
    async run(command: string, args: readonly string[], cwd: string, options?: unknown) {
      calls.push([command, ...args]);
      if (command !== "glab") {
        return (real as unknown as { run: (...a: unknown[]) => Promise<unknown> }).run(
          command,
          args,
          cwd,
          options,
        );
      }
      const endpoint = args[args.length - 1] ?? "";
      if (endpoint.startsWith("projects/")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: projectId, path_with_namespace: PROJECT_PATH }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "fixture forge refused" };
    },
  } as unknown as CommandRunner & { readonly calls: string[][] };
}

/**
 * Drive the shipped conversation loop over a scripted input stream.
 *
 * `runTerminalConversation` decides whether a typed line reaches the
 * dispatcher at all. Every assertion below that names "the real loop" goes
 * through here.
 */
async function driveTerminal(input: {
  selection: ReturnType<typeof selection>;
  lines: readonly string[];
  onDispatch?: (line: string) => void;
  prompt?: (message: string) => Promise<void>;
  columns?: number;
}): Promise<string> {
  const stream = new PassThrough();
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: input.columns ?? process.stdout.columns,
  });
  let transcript = "";
  output.on("data", (chunk) => {
    transcript += chunk.toString();
  });
  let consumed = 0;
  const conversation = runTerminalConversation(
    {
      sessionFile: undefined,
      subscribe: () => () => {},
      prompt: async (message: string) => {
        await input.prompt?.(message);
        consumed += 1;
      },
      abort: async () => {},
    } as never,
    stream,
    output,
    {
      environment: { TERM: "dumb", NO_COLOR: "" },
      skillIds: [],
      workflowIds: [],
      dispatchSourceCommand: async (line) => {
        input.onDispatch?.(line);
        try {
          return await input.selection.dispatch(line);
        } finally {
          consumed += 1;
        }
      },
    },
  );
  // One line at a time, each awaited to consumption. The loop stops accepting
  // input while a turn is in flight, so writing the whole script at once loses
  // lines — and a test that lost the line it was asserting about would pass for
  // the wrong reason.
  for (const line of input.lines) {
    const before = consumed;
    stream.write(`${line}\n`);
    await waitUntil(() => consumed > before);
  }
  stream.write("/exit\n");
  await conversation;
  return transcript;
}

async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("The scripted terminal line was never consumed.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("live-agent source command parsing", () => {
  it("wraps source attention to the caller-provided terminal sink width", async () => {
    const transcript = await driveTerminal({
      selection: selection(),
      lines: [`${SOURCE_COMMAND_PREFIX} unknown`],
      columns: 34,
    });

    expect(transcript).toContain("ATTENTION:");
    expect(
      transcript
        .split("\n")
        .filter(Boolean)
        .every((line) => unicodeCellWidth(line) <= 34),
    ).toBe(true);
  });

  it("parses every shipped verb through the real dispatcher", () => {
    expect(parseSourceCommand(SOURCE_COMMAND_PREFIX)).toEqual({ verb: "list", argument: null });
    expect(parseSourceCommand(`${SOURCE_COMMAND_PREFIX} list`)).toEqual({
      verb: "list",
      argument: null,
    });
    expect(parseSourceCommand(`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`)).toEqual({
      verb: "add",
      argument: SOURCE_PATH,
    });
    expect(parseSourceCommand(`${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`)).toEqual({
      verb: "show",
      argument: SOURCE_PATH,
    });
    expect(parseSourceCommand(`${SOURCE_COMMAND_PREFIX} refresh`)).toEqual({
      verb: "refresh",
      argument: null,
    });
    expect(parseSourceCommand(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`)).toEqual({
      verb: "remove",
      argument: SOURCE_PATH,
    });
    expect(parseSourceCommand(`${SOURCE_COMMAND_PREFIX} search`)).toEqual({
      verb: "search",
      argument: null,
    });
    // Every shipped verb is reachable from a line; a verb added to the
    // enumeration without a parse path would fail here.
    for (const verb of SOURCE_COMMAND_VERBS) {
      const line =
        verb === "list" || verb === "refresh" || verb === "search"
          ? `${SOURCE_COMMAND_PREFIX} ${verb}`
          : `${SOURCE_COMMAND_PREFIX} ${verb} ${SOURCE_PATH}`;
      expect(parseSourceCommand(line)?.verb, verb).toBe(verb);
    }
  });

  it("leaves a line that is not addressed to the family for the model", () => {
    expect(parseSourceCommand("what sources are attached?")).toBeUndefined();
    expect(parseSourceCommand(`${SOURCE_COMMAND_PREFIX}foo add x`)).toBeUndefined();
    expect(isSourceCommandLine(`${SOURCE_COMMAND_PREFIX}foo`)).toBe(false);
    expect(isSourceCommandLine(`${SOURCE_COMMAND_PREFIX} add x`)).toBe(true);
    expect(isSourceCommandLine(SOURCE_COMMAND_PREFIX)).toBe(true);
  });

  it("refuses an unknown verb instead of ignoring the line", () => {
    // A dispatcher that returned undefined for an unknown verb would hand
    // `/sources attach x` to the model and leave the operator believing a
    // source was attached.
    expect(() => parseSourceCommand(`${SOURCE_COMMAND_PREFIX} attach ${SOURCE_PATH}`)).toThrow(
      SOURCE_COMMAND_REFUSALS["unknown-verb"],
    );
    expect(() => parseSourceCommand(`${SOURCE_COMMAND_PREFIX} ADD ${SOURCE_PATH}`)).toThrow(
      SourceCommandError,
    );
  });

  it("refuses a malformed source command line by shape", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`${SOURCE_COMMAND_PREFIX} add`, SOURCE_COMMAND_REFUSALS["missing-argument"]],
      [`${SOURCE_COMMAND_PREFIX} show`, SOURCE_COMMAND_REFUSALS["missing-argument"]],
      [`${SOURCE_COMMAND_PREFIX} remove`, SOURCE_COMMAND_REFUSALS["missing-argument"]],
      [`${SOURCE_COMMAND_PREFIX} list x`, SOURCE_COMMAND_REFUSALS["unexpected-argument"]],
      [`${SOURCE_COMMAND_PREFIX} add a\u0007b`, SOURCE_COMMAND_REFUSALS["malformed-command"]],
      [
        `${SOURCE_COMMAND_PREFIX} add ${"a".repeat(SOURCE_COMMAND_LINE_LIMIT)}`,
        SOURCE_COMMAND_REFUSALS["malformed-command"],
      ],
      [
        `${SOURCE_COMMAND_PREFIX} add docs/cafe\u0301.md`,
        SOURCE_COMMAND_REFUSALS["malformed-command"],
      ],
    ];
    for (const [line, message] of cases) {
      expect(() => parseSourceCommand(line), line).toThrow(message);
    }
  });

  it("renders every source refusal code from one content-free table", () => {
    expect(Object.keys(SOURCE_COMMAND_REFUSALS).sort()).toEqual(
      [...SOURCE_COMMAND_REFUSAL_CODES].sort(),
    );
    for (const code of SOURCE_COMMAND_REFUSAL_CODES) {
      const message = SOURCE_COMMAND_REFUSALS[code];
      // Condition, then remediation: at least two sentences, and never an
      // interpolated value.
      expect(message.split(". ").length, code).toBeGreaterThan(1);
      expect(message.endsWith("."), code).toBe(true);
      expect(message, code).not.toMatch(/\$\{|undefined|\[object/u);
      expect(message, code).not.toMatch(/(?:\/Users|\/home|\/var|\/tmp|\/private|\/etc)\//u);
      expect(new SourceCommandError(code).message, code).toBe(message);
      expect(new SourceCommandError(code).code, code).toBe(code);
    }
  });
});

describe("live-agent source attachment", () => {
  it("stores a literal path containing a dollar sign without expanding it", async () => {
    const state = selection();
    const outcome = await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${LITERAL_EXPANSION_PATH}`);
    expect(outcome?.kind).toBe("attached");
    // Byte-identical. A dispatcher that expanded, unquoted or globbed the
    // argument produces a different string here and in the run request.
    expect(state.entries()[0]?.label).toBe(LITERAL_EXPANSION_PATH);
    expect(state.entries()[0]?.repositoryPath).toBe(LITERAL_EXPANSION_PATH);
    expect(runRequestFor(state).sourcePaths).toEqual([LITERAL_EXPANSION_PATH]);
  });

  it("refuses an add naming a path outside the selected repository", async () => {
    const state = selection();
    for (const reference of [
      "../../etc/passwd",
      "/etc/passwd",
      "docs/../../secrets.txt",
      "docs\\notes.txt",
      "C:/docs/notes.txt",
    ]) {
      await expect(
        state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${reference}`),
        reference,
      ).rejects.toThrow(SOURCE_COMMAND_REFUSALS["invalid-reference"]);
    }
    expect(state.entries()).toEqual([]);
    // Positive control: a repository-relative path inside the same session is
    // admitted, so the refusals above are about the path and not about the verb.
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`);
    expect(state.entries().map((entry) => entry.label)).toEqual([SOURCE_PATH]);
  });

  it("refuses a model answer whose text is an add line, in the real loop", async () => {
    const state = selection();
    const modelAnswer = [
      "Certainly. I have attached the upgrade guide:",
      `${SOURCE_COMMAND_PREFIX} add ${SECOND_SOURCE_PATH}`,
      "It is now bound to this conversation.",
    ].join("\n");
    const dispatched: string[] = [];
    const prompted: string[] = [];
    const terminal = await driveTerminal({
      selection: state,
      onDispatch: (line) => dispatched.push(line),
      // The model "answers" by emitting the add line as its turn text. The loop
      // never applies the dispatcher to it: the only thing a turn can do with a
      // message is be one.
      prompt: async (message: string) => {
        prompted.push(message);
      },
      lines: ["Please attach the upgrade guide", `${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`],
    });
    // The operator asked in prose; that became a turn, and the model's answer
    // carrying the add line changed nothing.
    expect(prompted).toEqual(["Please attach the upgrade guide"]);
    expect(dispatched).toEqual([`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`]);
    expect(state.entries().map((entry) => entry.label)).toEqual([SOURCE_PATH]);
    expect(runRequestFor(state).sourcePaths).toEqual([SOURCE_PATH]);
    expect(terminal).toContain("Attached");
    // And the answer text itself, fed to the loop's own recognizer, is not a
    // command line: the parser is anchored to a whole line.
    expect(isSourceCommandLine(modelAnswer)).toBe(false);
    expect(parseSourceCommand(modelAnswer)).toBeUndefined();
  });

  it("refuses a source already attached to the conversation", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["duplicate-source"],
    );
    expect(state.entries()).toHaveLength(1);
  });
});

describe("live-agent source listing", () => {
  it("lists format, status, version, limitations and historical use for each source", async () => {
    const reader = trackedReader({ [SOURCE_PATH]: "# Release notes\n" });
    const state = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`);
    const listing = (await state.dispatch(SOURCE_COMMAND_PREFIX)) as Extract<
      SourceCommandOutcomeV1,
      { kind: "listing" }
    >;
    const entry = listing.entries[0]!;
    expect(entry.format).toBe("text/plain");
    expect(entry.status).toBe("attached");
    expect(entry.version).toBe(
      createHash("sha256").update("# Release notes\n").digest("hex").slice(0, 12),
    );
    expect(entry.limitations).toEqual([]);
    expect(entry.historicalUse).toEqual(["attached in this conversation", "refreshed once"]);

    const rendered = renderSourceCommandOutcome(listing);
    for (const field of ["Format", "Status", "Version", "Limitations", "Historical use"]) {
      expect(rendered, field).toContain(field);
    }
    expect(rendered).toContain("text/plain");
    expect(rendered).toContain(entry.version!);
  });

  it("derives the listing from the same state the next run request carries", async () => {
    const state = selection();
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`);
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SECOND_SOURCE_PATH}`);
    const listing = (await state.dispatch(SOURCE_COMMAND_PREFIX)) as Extract<
      SourceCommandOutcomeV1,
      { kind: "listing" }
    >;
    // Compared as values against the request the shared assembly would actually
    // receive, in operator order, not merely "both non-empty".
    expect(listing.entries.map((entry) => entry.repositoryPath)).toEqual(
      runRequestFor(state).sourcePaths,
    );
    expect(listing.entries.map((entry) => entry.label)).toEqual([SOURCE_PATH, SECOND_SOURCE_PATH]);
    // An empty selection produces no request field at all, which keeps a
    // sourceless session's request unchanged.
    expect(runRequestFor(selection()).sourcePaths).toBeUndefined();
    expect(Object.hasOwn(runRequestFor(selection()), "sourcePaths")).toBe(false);
  });

  it("reports an empty selection without inventing an entry", async () => {
    const state = selection();
    const listing = await state.dispatch(SOURCE_COMMAND_PREFIX);
    expect(listing).toEqual({ kind: "listing", entries: [] });
    expect(renderSourceCommandOutcome(listing!)).toContain("No sources are attached");
  });
});

describe("live-agent merged-change attachment", () => {
  it("resolves the project path to its numeric id before minting the proved scope", async () => {
    const port = identityPort();
    const state = selection({ ports: { identityPort: port } });
    await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} add https://${HOST}/${PROJECT_PATH}/-/merge_requests/813`,
    );
    // The resolution happened, once, against the path the operator named.
    expect(port.calls).toEqual([`${HOST}/${PROJECT_PATH}`]);
    const entry = state.entries()[0]!;
    // Numeric id canonical, path recorded beside it, both present.
    expect(entry.projectId).toBe(PROJECT_ID);
    expect(entry.projectPath).toBe(PROJECT_PATH);
    expect(entry.changeNumber).toBe(813);
    expect(entry.locator).toBe(`gitlab-mr:v1:host=${HOST}:project=${PROJECT_ID}:mr=813`);
    // Only the inert selector reaches the request; the proved scope never does.
    const request = runRequestFor(state);
    expect(request.changeRequestSelector).toEqual(
      parseChangeRequestSelector(`${HOST}/${PROJECT_PATH}!813`),
    );
    expect(Object.keys(request.changeRequestSelector!)).not.toContain("provedAcquisitionScope");
    expect(JSON.stringify(request)).not.toContain("provedAcquisitionScope");
  });

  it("refuses a merged change whose project resolves to another project", async () => {
    const port = crossProjectIdentityPort();
    const state = selection({ ports: { identityPort: port } });
    await expect(
      state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${HOST}/${PROJECT_PATH}!813`),
    ).rejects.toThrow(SOURCE_DISCOVERY_REFUSALS["out-of-scope-locator"]);
    expect(port.calls).toHaveLength(1);
    expect(state.entries()).toEqual([]);
    expect(runRequestFor(state).changeRequestSelector).toBeUndefined();
  });

  it("reads nothing when the merged-change reference never parses", async () => {
    const port = identityPort();
    const state = selection({ ports: { identityPort: port } });
    for (const reference of [
      "http://insecure.example/team/project/-/merge_requests/1",
      `https://${HOST}/${PROJECT_PATH}/pull/7`,
      "!0",
      "!99999999999999999999",
    ]) {
      await expect(
        state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${reference}`),
        reference,
      ).rejects.toThrow(ChangeRequestSelectorError);
    }
    // Zero reads: the parse is pure and the identity port was never reached.
    expect(port.calls).toEqual([]);
    expect(state.entries()).toEqual([]);
  });

  it("grounds the conversation on one merged change at a time", async () => {
    const port = identityPort();
    const state = selection({ ports: { identityPort: port } });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${HOST}/${PROJECT_PATH}!813`);
    await expect(
      state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${HOST}/${PROJECT_PATH}!814`),
    ).rejects.toThrow(SOURCE_COMMAND_REFUSALS["one-change-request"]);
    // Refused before any read: one resolution, for the first reference only.
    expect(port.calls).toHaveLength(1);
    expect(state.entries()).toHaveLength(1);
  });

  it("refuses a bare number when the checkout has no resolvable project", async () => {
    const port = identityPort();
    const state = selection({ ports: { identityPort: port } });
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} add !813`)).rejects.toThrow(
      ChangeRequestSelectorError,
    );
    expect(port.calls).toEqual([]);
    // Positive control: the same bare number resolves once the host supplies
    // the checkout's project.
    const wired = selection({
      ports: {
        identityPort: port,
        checkoutProject: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      },
    });
    await wired.dispatch(`${SOURCE_COMMAND_PREFIX} add !813`);
    expect(wired.entries()[0]?.projectId).toBe(PROJECT_ID);
  });
});

describe("live-agent source detachment", () => {
  it("detaches exactly one source and moves the next request's binding digest", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH] });
    // The digest is taken over the request the shared assembly would actually
    // receive, not over a second copy of the idea kept beside it.
    const before = canonicalDigest(runRequestFor(state));
    const outcome = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detached" }>;
    expect(outcome.entry.label).toBe(SOURCE_PATH);
    // Exactly one: removing by label would remove both.
    expect(state.entries().map((entry) => entry.label)).toEqual([SECOND_SOURCE_PATH]);
    expect(runRequestFor(state).sourcePaths).toEqual([SECOND_SOURCE_PATH]);
    expect(canonicalDigest(runRequestFor(state))).not.toBe(before);
    // Divergent ids: detaching the *other* source from the same starting state
    // produces a third, different digest, so the digest tracks which source was
    // removed and not merely how many remain.
    const other = selection({ sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH] });
    await other.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SECOND_SOURCE_PATH}`);
    expect(canonicalDigest(runRequestFor(other))).not.toBe(canonicalDigest(runRequestFor(state)));
    expect(canonicalDigest(runRequestFor(other))).not.toBe(before);
  });

  it("refuses a reference that matches no attached source", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    await expect(
      state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SECOND_SOURCE_PATH}`),
    ).rejects.toThrow(SOURCE_COMMAND_REFUSALS["unknown-source"]);
    // Matching is byte-for-byte against the printed label, never a prefix.
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} remove docs/`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["unknown-source"],
    );
    expect(state.entries()).toHaveLength(1);
  });

  it("reports a required source's removal as a refusal naming the requiring step", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    const release = state.holdForRun("update-documentation");
    const refusal = await state
      .dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`)
      .then(() => undefined)
      .catch((error: unknown) => error as SourceCommandError);
    expect(refusal?.code).toBe("required-source");
    // The step is named from the workflow catalog the runner executes, so the
    // refusal names the step the required-source write gate would stop.
    expect(refusal?.message).toContain("Requiring steps: write-documentation");
    expect(state.entries()[0]?.requiredBy).toContain("write-documentation");
    expect(state.entries()).toHaveLength(1);
    // Positive control: the same detach succeeds once the run settles.
    release();
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`);
    expect(state.entries()).toEqual([]);
  });
});

describe("live-agent source refresh", () => {
  it("reports a drifted version as drift, not as a new attachment", async () => {
    const reader = trackedReader({ [SOURCE_PATH]: "first revision\n" });
    const state = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`);
    const firstEntry = state.entries()[0]!;
    expect(firstEntry.version).not.toBeNull();
    const boundBefore = canonicalDigest(runRequestFor(state));

    reader.set(SOURCE_PATH, "second revision\n");
    const outcome = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} refresh ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "refreshed" }>;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.disposition).toBe("drifted");
    expect(outcome.results[0]?.previousVersion).toBe(firstEntry.version);
    expect(outcome.results[0]?.version).not.toBe(firstEntry.version);

    // Drift, not a new attachment: one entry, the same host-issued id, the same
    // position, and a binding digest that did not move because the *selection*
    // did not change.
    expect(state.entries()).toHaveLength(1);
    expect(state.entries()[0]?.entryId).toBe(firstEntry.entryId);
    expect(state.entries()[0]?.status).toBe("drifted");
    expect(state.entries()[0]?.limitations).toContain("version-drifted-since-attachment");
    expect(runRequestFor(state).sourcePaths).toEqual([SOURCE_PATH]);
    // A refresh reports drift; it does not change what the next run binds.
    expect(canonicalDigest(runRequestFor(state))).toBe(boundBefore);
  });

  it("reports an unchanged version without claiming drift", async () => {
    const reader = trackedReader({ [SOURCE_PATH]: "steady\n" });
    const state = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`);
    const outcome = (await state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`)) as Extract<
      SourceCommandOutcomeV1,
      { kind: "refreshed" }
    >;
    expect(outcome.results[0]?.disposition).toBe("unchanged");
    expect(state.entries()[0]?.status).toBe("attached");
  });

  it("reports a source that vanished from the selected revision as unavailable", async () => {
    const reader = trackedReader({ [SOURCE_PATH]: "present\n" });
    const state = selection({
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    const outcome = (await state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`)) as Extract<
      SourceCommandOutcomeV1,
      { kind: "refreshed" }
    >;
    expect(outcome.results.map((result) => result.disposition)).toEqual([
      "unchanged",
      "unavailable",
    ]);
    expect(state.entries()[1]?.status).toBe("unavailable");
    expect(state.entries()[1]?.limitations).toContain("unreadable-at-selected-revision");
  });

  it("refuses a refresh with no host-wired reader instead of reporting no drift", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["inspection-unavailable"],
    );
  });
});

describe("live-agent source preview", () => {
  it("bounds a show preview to the shipped ceiling", async () => {
    const reader = trackedReader({ [SOURCE_PATH]: "x".repeat(10_000) });
    const state = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    const outcome = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
    expect(outcome.preview!.length).toBeLessThanOrEqual(SOURCE_PREVIEW_MAX_CHARACTERS);
    expect(outcome.previewTruncated).toBe(true);
    expect(renderSourceCommandOutcome(outcome)).toContain("Preview");
  });

  it("withholds a preview that carries a configured credential", async () => {
    configureCredential(CREDENTIAL_FIXTURE);
    const reader = trackedReader({ [SOURCE_PATH]: `token ${CREDENTIAL_FIXTURE}\n` });
    const state = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    const refusal = await state
      .dispatch(`${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`)
      .then(() => undefined)
      .catch((error: unknown) => error as SourceCommandError);
    expect(refusal?.code).toBe("disclosure-screen");
    expect(refusal?.message).not.toContain(CREDENTIAL_FIXTURE);
    // Positive control: the same file without the credential does preview.
    reader.set(SOURCE_PATH, "token rotated out of this document\n");
    const outcome = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
    expect(outcome.preview).toContain("rotated out");
    // A credential shape that is not configured previews too.
    reader.set(SOURCE_PATH, `token ${SHAPED_FIXTURE}\n`);
    const shaped = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
    expect(shaped.preview).toContain(SHAPED_FIXTURE);
  });

  it("replaces this host's roots in a preview and keeps a documentation path", async () => {
    const workspace = "/srv/checkouts/docs-project";
    const reader = trackedReader({
      [SOURCE_PATH]: `#!/usr/bin/env node\n${HOST_PATH_FIXTURE}\nsee ${workspace}/docs/guide.md\n`,
    });
    const state = selection({
      sourcePaths: [SOURCE_PATH],
      ports: {
        withTrackedSourceReader: (use) => use(reader),
        hostRoots: hostRootSet(
          [
            { kind: "workspace", path: workspace },
            { kind: "home", path: "/Users/operator" },
          ],
          { platform: "linux" },
        ),
      },
    });
    const outcome = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
    expect(outcome.preview).toBe(
      "#!/usr/bin/env node\nsee ~/secrets/notes.md for the rest\nsee docs/guide.md\n",
    );
    const rendered = renderSourceCommandOutcome(outcome);
    expect(rendered).not.toContain("/Users/operator");
    expect(rendered).not.toContain(workspace);
  });

  it("leaves a declared public HOME in a preview and replaces it when undeclared", async () => {
    const reader = trackedReader({ [SOURCE_PATH]: "Run it from /home/node/docs.\n" });
    const preview = async () => {
      const state = selection({
        sourcePaths: [SOURCE_PATH],
        ports: { withTrackedSourceReader: (use) => use(reader) },
      });
      const outcome = (await state.dispatch(
        `${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`,
      )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
      return outcome.preview;
    };
    vi.stubEnv("HOME", "/home/node");
    try {
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "/home/node");
      expect(await preview()).toBe("Run it from /home/node/docs.\n");
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "");
      expect(await preview()).toBe("Run it from ~/docs.\n");
      // An invalid declaration refuses when the selection is built.
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative/root");
      expect(() => selection()).toThrow(/public-roots-invalid/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not preview a merged change in the terminal", async () => {
    const state = selection({
      ports: { identityPort: identityPort() },
    });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${HOST}/${PROJECT_PATH}!813`);
    const outcome = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} show ${HOST}/${PROJECT_PATH}!813`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
    expect(outcome.preview).toBeNull();
    expect(renderSourceCommandOutcome(outcome)).toContain("sealed evidence inside a bound run");
  });
});

describe("live-agent source search", () => {
  it("refuses a search when the host did not opt in", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} search`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["search-unavailable"],
    );
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} search 5`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["search-unavailable"],
    );
  });

  it("routes an opted-in search through the shipped per-step searcher", async () => {
    const { searcher, requested } = await shippedSearcher([
      {
        items: [row(4101, "2026-09-20T12:00:00.000Z"), row(4102, "2026-09-18T12:00:00.000Z")],
        nextPage: null,
      },
    ]);
    const state = selection({ ports: { searcher } });
    const outcome = (await state.dispatch(`${SOURCE_COMMAND_PREFIX} search`)) as Extract<
      SourceCommandOutcomeV1,
      { kind: "search" }
    >;
    // The walk really happened, through the injected page port the searcher
    // holds; bypassing the opt-in would return without it.
    expect(requested).toEqual([1]);
    expect(outcome.descriptorCount).toBe(2);
    expect(outcome.windowCovered).toBe(true);
    expect(outcome.result.descriptors.map((descriptor) => descriptor.mergeRequestIid)).toEqual([
      4101, 4102,
    ]);
    expect(outcome.result.scope.projectId).toBe(PROJECT_ID);
    // A descriptor is a handle, not a copy: no title or body reaches the
    // terminal.
    const rendered = renderSourceCommandOutcome(outcome);
    expect(rendered).not.toContain("merge request 4101");
    expect(rendered).not.toContain("body 4101");
    expect(rendered).toContain("!4101");
  });

  it("admits only a descriptor ceiling as a search argument", async () => {
    const { searcher } = await shippedSearcher([{ items: [], nextPage: null }]);
    const state = selection({ ports: { searcher } });
    for (const argument of ["main", "project=1", "-1", "0", "51", "2026-09-01"]) {
      await expect(
        state.dispatch(`${SOURCE_COMMAND_PREFIX} search ${argument}`),
        argument,
      ).rejects.toThrow(SOURCE_COMMAND_REFUSALS["malformed-command"]);
    }
    // Positive control: a ceiling inside the shipped bound is admitted.
    const outcome = await state.dispatch(`${SOURCE_COMMAND_PREFIX} search 5`);
    expect(outcome?.kind).toBe("search");
  });
});

describe("live-agent source command surface", () => {
  const capabilities = {
    skills: [],
    workflows: [],
    qualityPack: { id: "docsfab-quality", version: "1.0.0" },
  } as unknown as LiveAgentCapabilities;

  it("pins workflow handoff guidance without adding a model source command surface", () => {
    // Reviewed digests of this fixture's prompt in both authorization modes.
    // Keep them fixed: comparing two calls to the same function would miss
    // prompt drift. Re-pin only after reviewing the prompt delta.
    const pinned: ReadonlyArray<readonly [boolean, string]> = [
      [false, "33bfcfbf3742889e2c461fe1baf39430b5a806b9d801be6ba8921422c3a260b3"],
      [true, "02a4812dbb600816df068e98e833f687e37b5ce29c1a32a8d098af853d31e856"],
    ];
    for (const [allowWrite, digest] of pinned) {
      const prompt = buildLiveAgentSystemPrompt(capabilities, allowWrite, undefined, undefined, []);
      expect(createHash("sha256").update(prompt, "utf8").digest("hex"), String(allowWrite)).toBe(
        digest,
      );
      expect(prompt, String(allowWrite)).not.toContain(SOURCE_COMMAND_PREFIX);
      expect(prompt, String(allowWrite)).not.toContain("attached bound sources");
    }
    // A session with every port wired — the state in which `/sources` is fully
    // usable — still renders those exact bytes, because the family adds no
    // model-facing surface at all.
    const optedIn = selection({
      ports: {
        identityPort: identityPort(),
        withTrackedSourceReader: (use) => use(trackedReader({})),
        checkoutProject: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      },
    });
    expect(optedIn.entries()).toEqual([]);
    // Positive control: the sentence appears only when evidence is attached,
    // and that permutation deliberately differs from the unbound prompt.
    const attached = buildLiveAgentSystemPrompt(capabilities, false, undefined, undefined, [
      SOURCE_PATH,
    ]);
    expect(attached).toContain("attached bound sources");
    expect(createHash("sha256").update(attached, "utf8").digest("hex")).not.toBe(pinned[0]![1]);
  });

  it("prints only coded refusal families to the terminal", () => {
    expect(liveAgentSourceCommandRefusal(new SourceCommandError("unknown-source"))).toBe(
      SOURCE_COMMAND_REFUSALS["unknown-source"],
    );
    expect(liveAgentSourceCommandRefusal(new SourceDiscoveryError("out-of-scope-locator"))).toBe(
      SOURCE_DISCOVERY_REFUSALS["out-of-scope-locator"],
    );
    expect(
      liveAgentSourceCommandRefusal(new ChangeRequestSelectorError("malformed-selector")),
    ).toContain("merge request's URL");
    // An uncoded throw never reaches the terminal with its own message, which
    // may carry a host path or a fragment of a file.
    const leak = new Error(`ENOENT: no such file or directory, open '${HOST_PATH_FIXTURE}'`);
    const rendered = liveAgentSourceCommandRefusal(leak);
    expect(rendered).not.toContain("/Users/operator");
    expect(rendered).toContain("withheld the underlying diagnostic");
  });
});

describe("live-agent source command atomicity", () => {
  /**
   * `contextPath` admits `~/notes.md` — it is not absolute, has no backslash,
   * no drive letter and no parent segment — while admission refuses it as
   * home-relative. Appending before screening would attach the entry while the
   * refusal said "nothing was changed", and every later `/sources` line would
   * refuse.
   */
  it("leaves the selection untouched when an add is refused, and keeps listing", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    const before = canonicalDigest(runRequestFor(state));

    const refusal = await state
      .dispatch(`${SOURCE_COMMAND_PREFIX} add ~/notes.md`)
      .then(() => undefined)
      .catch((error: unknown) => error as SourceCommandError);
    expect(refusal?.code).toBe("invalid-reference");
    expect(refusal?.message).toContain("Nothing was attached.");

    // Zero state change: no entry appended, the request unmoved.
    expect(state.entries().map((entry) => entry.label)).toEqual([SOURCE_PATH]);
    expect(canonicalDigest(runRequestFor(state))).toBe(before);
    expect(runRequestFor(state).sourcePaths).toEqual([SOURCE_PATH]);

    // The listing still works.
    const listing = await state.dispatch(SOURCE_COMMAND_PREFIX);
    expect(listing?.kind).toBe("listing");
    expect(renderSourceCommandOutcome(listing!)).toContain(SOURCE_PATH);

    // And a later, sound add still succeeds.
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SECOND_SOURCE_PATH}`);
    expect(state.entries().map((entry) => entry.label)).toEqual([SOURCE_PATH, SECOND_SOURCE_PATH]);
  });

  it("refuses a home-relative or configured-credential reference", async () => {
    configureCredential(CREDENTIAL_FIXTURE);
    // Fixture only: none of these is written to a filesystem, and the
    // credential-shaped one exists nowhere but this array.
    const poisoned = ["~", "~/notes.md", `docs/${CREDENTIAL_FIXTURE}.txt`];
    for (const reference of poisoned) {
      const state = selection({ sourcePaths: [SOURCE_PATH] });
      await expect(
        state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${reference}`),
        reference,
      ).rejects.toThrow(SOURCE_COMMAND_REFUSALS["invalid-reference"]);
      expect(
        state.entries().map((entry) => entry.label),
        reference,
      ).toEqual([SOURCE_PATH]);
      // Every verb still answers afterwards.
      expect((await state.dispatch(SOURCE_COMMAND_PREFIX))?.kind, reference).toBe("listing");
    }
    // The same references are refused at session start rather than producing a
    // conversation whose listing throws.
    for (const reference of poisoned) {
      expect(() => selection({ sourcePaths: [reference] }), reference).toThrow(
        SOURCE_COMMAND_REFUSALS["invalid-reference"],
      );
    }
    // A reference with a credential shape that is not configured is an
    // ordinary repository path (#1807).
    const shaped = `docs/${SHAPED_FIXTURE}.txt`;
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${shaped}`);
    expect(state.entries().map((entry) => entry.label)).toEqual([SOURCE_PATH, shaped]);
  });

  it("admits a repository-relative reference whose text reads like a host path", async () => {
    // Tracked names a shape screen refused: a templated segment before `etc`,
    // and a `file:` directory.
    const references = ["docs/{release}/etc/notes.md", "docs/file:/name.md"];
    const state = selection({ sourcePaths: [references[0]!] });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${references[1]}`);
    expect(state.entries().map((entry) => entry.label)).toEqual(references);
    expect(runRequestFor(state).sourcePaths).toEqual(references);
  });

  it("validates source-authority evidence whose member path reads like a host path", () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const members = [
      { path: "docs/{release}/etc/notes.md", mode: 0o644, byteLength: 12, sourceSha256: hash("m") },
    ];
    const content = {
      kind: ORIGINAL_SOURCE_AUTHORITY_KIND,
      schemaVersion: 1 as const,
      scope: "create-plan-sources" as const,
      repositoryRevision: "a".repeat(40),
      scopeSha256: hash("scope"),
      workspaceSnapshotSha256: hash("snapshot"),
      memberCount: members.length,
      membersSha256: canonicalDigest(members),
    };
    const descriptor = { ...content, digest: canonicalDigest(content) };
    const evidenceContent = {
      kind: ORIGINAL_SOURCE_AUTHORITY_EVIDENCE_KIND,
      schemaVersion: 1 as const,
      descriptor,
      members,
    };
    const evidence = { ...evidenceContent, digest: canonicalDigest(evidenceContent) };
    expect(validateOriginalSourceAuthorityEvidence(evidence).members.map((m) => m.path)).toEqual([
      "docs/{release}/etc/notes.md",
    ]);
  });

  it("leaves the selection untouched when a detach is refused", async () => {
    const reader = trackedReader({ [SOURCE_PATH]: `${HOST_PATH_FIXTURE}\n` });
    const state = selection({
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    const before = canonicalDigest(runRequestFor(state));
    const held = state.holdForRun("update-documentation");
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["required-source"],
    );
    expect(state.entries()).toHaveLength(2);
    expect(canonicalDigest(runRequestFor(state))).toBe(before);
    held();
    // Positive control: the detach lands once the hold is released, and the
    // request moves exactly then.
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`);
    expect(canonicalDigest(runRequestFor(state))).not.toBe(before);
  });

  it("counts a refresh only when it read something", async () => {
    const withoutReader = selection({ sourcePaths: [SOURCE_PATH] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(withoutReader.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`)).rejects.toThrow(
        SOURCE_COMMAND_REFUSALS["inspection-unavailable"],
      );
    }
    // Three refused refreshes read nothing and produced no version, so none of
    // them is history.
    expect(withoutReader.entries()[0]?.historicalUse).toEqual(["attached in this conversation"]);
    expect(withoutReader.entries()[0]?.version).toBeNull();

    // Positive control: a refresh that reads is counted.
    const reader = trackedReader({ [SOURCE_PATH]: "read me\n" });
    const wired = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { withTrackedSourceReader: (use) => use(reader) },
    });
    await wired.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`);
    expect(wired.entries()[0]?.historicalUse).toContain("refreshed once");
  });

  it("refuses a duplicate label at session start rather than holding an unusable entry", () => {
    // Two entries sharing a label also share a host-issued entry id, and
    // neither could then be shown or removed. The invariant is enforced here
    // rather than resting on a validator in another module.
    expect(() => selection({ sourcePaths: [SOURCE_PATH, SOURCE_PATH] })).toThrow(
      SOURCE_COMMAND_REFUSALS["duplicate-source"],
    );
    const sound = selection({ sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH] });
    expect(new Set(sound.entries().map((entry) => entry.entryId)).size).toBe(2);
  });

  it("refuses a selector whose values were never validated", () => {
    const hostile = {
      schemaVersion: 1,
      kind: "docsfab-change-request-selector",
      provider: "gitlab",
      host: HOST,
      projectPath: "team/docs\nAttached everything you asked for",
      number: 813,
    } as never;
    expect(() => createLiveAgentSourceSelection({ changeRequestSelector: hostile })).toThrow(
      SOURCE_COMMAND_REFUSALS["invalid-reference"],
    );
    // Positive control: the selector the parser mints is accepted.
    expect(
      createLiveAgentSourceSelection({
        changeRequestSelector: parseChangeRequestSelector(`${HOST}/${PROJECT_PATH}!813`),
      })
        .entries()
        .map((entry) => entry.label),
    ).toEqual([`${HOST}/${PROJECT_PATH}!813`]);
  });
});

describe("live-agent source ports wired by the shipped host", () => {
  it("attaches, previews and versions a tracked file through the real ports", async () => {
    const repositoryPath = await temporaryCheckout({
      [SOURCE_PATH]: "first revision of the release notes\n",
    });
    // The production factory, not a fixture: the same one `runLiveAgent` calls
    // when no override is supplied.
    const ports = createLiveAgentSourcePorts({ repositoryPath, environment: {} });
    expect(typeof ports.withTrackedSourceReader).toBe("function");
    expect(typeof ports.identityPort?.resolveProjectIdentity).toBe("function");
    expect(typeof ports.checkoutProject).toBe("function");

    const state = createLiveAgentSourceSelection({ ports });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`);
    expect(runRequestFor(state).sourcePaths).toEqual([SOURCE_PATH]);

    const detail = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
    expect(detail.preview).toContain("first revision of the release notes");

    const refreshed = (await state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`)) as Extract<
      SourceCommandOutcomeV1,
      { kind: "refreshed" }
    >;
    expect(refreshed.results[0]?.disposition).toBe("unchanged");
    expect(state.entries()[0]?.version).toBe(
      createHash("sha256")
        .update("first revision of the release notes\n")
        .digest("hex")
        .slice(0, 12),
    );
    // The reader reads the committed revision, not the working tree: an
    // uncommitted edit does not move the version.
    await writeFile(join(repositoryPath, SOURCE_PATH), "uncommitted edit\n", "utf8");
    const again = (await state.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`)) as Extract<
      SourceCommandOutcomeV1,
      { kind: "refreshed" }
    >;
    expect(again.results[0]?.disposition).toBe("unchanged");
  }, 60_000);

  it("names a path under the checkout repository-relative in a preview through the real ports", async () => {
    const repositoryPath = await temporaryCheckout({ [SOURCE_PATH]: "placeholder\n" });
    await writeFile(
      join(repositoryPath, SOURCE_PATH),
      `Build with ${repositoryPath}/scripts/build.sh first.\n`,
      "utf8",
    );
    await execute("git", ["commit", "-am", "name the checkout"], { cwd: repositoryPath });
    const state = createLiveAgentSourceSelection({
      sourcePaths: [SOURCE_PATH],
      ports: createLiveAgentSourcePorts({ repositoryPath, environment: {} }),
    });
    const detail = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} show ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detail" }>;
    expect(detail.preview).toBe("Build with scripts/build.sh first.\n");
    expect(renderSourceCommandOutcome(detail)).not.toContain(repositoryPath);
  }, 60_000);

  it("attaches a bare merge-request number through the real checkout and identity ports", async () => {
    const repositoryPath = await temporaryCheckout({ [SOURCE_PATH]: "notes\n" });
    await execute("git", ["remote", "add", "origin", `https://${HOST}/${PROJECT_PATH}.git`], {
      cwd: repositoryPath,
    });
    const forge = fakeForge();
    const state = createLiveAgentSourceSelection({
      ports: createLiveAgentSourcePorts({ repositoryPath, environment: {}, commands: forge }),
    });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add !843`);
    const entry = state.entries()[0]!;
    // The checkout's own remote supplied host and project; the identity port
    // resolved the canonical numeric id; both were recorded.
    expect(entry.label).toBe(`${HOST}/${PROJECT_PATH}!843`);
    expect(entry.projectId).toBe(PROJECT_ID);
    expect(entry.projectPath).toBe(PROJECT_PATH);
    expect(runRequestFor(state).changeRequestSelector?.number).toBe(843);
    // The forge was really reached, through the shipped transport.
    expect(forge.calls.some(([command]) => command === "glab")).toBe(true);
  }, 60_000);
});

describe("live-agent source command host seam", () => {
  it("dispatches a typed source line in the real conversation loop", async () => {
    const state = selection();
    const dispatched: string[] = [];
    const prompted: string[] = [];
    const transcript = await driveTerminal({
      selection: state,
      onDispatch: (line) => dispatched.push(line),
      prompt: async (message) => {
        prompted.push(message);
      },
      lines: [`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`, SOURCE_COMMAND_PREFIX, "hello"],
    });
    // Deleting the `/sources` branch from the loop leaves these three lines as
    // three model turns, which is exactly what this asserts they are not.
    expect(dispatched).toEqual([
      `${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`,
      SOURCE_COMMAND_PREFIX,
    ]);
    expect(prompted).toEqual(["hello"]);
    expect(transcript).toContain("Attached");
    expect(transcript).toContain("Attached Sources");
    expect(transcript).toContain(SOURCE_PATH);
    expect(state.entries().map((entry) => entry.label)).toEqual([SOURCE_PATH]);
  });

  it("prints a coded refusal to the terminal without ending the conversation", async () => {
    const state = selection();
    const transcript = await driveTerminal({
      selection: state,
      lines: [`${SOURCE_COMMAND_PREFIX} attach ${SOURCE_PATH}`, SOURCE_COMMAND_PREFIX],
    });
    expect(transcript).toContain(SOURCE_COMMAND_REFUSALS["unknown-verb"]);
    expect(transcript).toContain("No sources are attached");
  });

  it("binds the selection as it stands when the turn runs, not as it stood at session start", async () => {
    const state = selection();
    const received: Array<Record<string, unknown>> = [];
    const runner = createLiveAgentBoundedRunner({
      selection: state,
      repositoryPath: "/workspace/docsfab",
      allowWrite: true,
      config: {} as DocsFabConfig,
      persist: async () => ({ status: "not-needed" }) as never,
      runWorkflow: async (request) => {
        received.push(request as unknown as Record<string, unknown>);
        if (received.length === 1) {
          // The hold is live for the duration of the run: detaching the
          // evidence this run bound is refused, naming the step the
          // required-source write gate would stop.
          await expect(
            state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`),
          ).rejects.toThrow(SOURCE_COMMAND_REFUSALS["required-source"]);
        }
        return { id: "run-1", workflow: request.workflow, status: "succeeded", steps: [] } as never;
      },
    });

    // Session start attached nothing. The mid-conversation attach is the only
    // reason this run has evidence: a runner that re-read the session-start
    // options would send an empty selection.
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`);
    await runner("update-documentation", "refresh the release notes", undefined, undefined);
    expect(received).toHaveLength(1);
    expect(received[0]?.sourcePaths).toEqual([SOURCE_PATH]);

    // The hold is released when the run settles, so the same detach now lands.
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`);
    await runner("update-documentation", "second turn", undefined, undefined);
    expect(received).toHaveLength(2);
    expect(Object.hasOwn(received[1]!, "sourcePaths")).toBe(false);
  });

  it("releases the hold once even when a run fails", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    const runner = createLiveAgentBoundedRunner({
      selection: state,
      repositoryPath: "/workspace/docsfab",
      allowWrite: true,
      config: {} as DocsFabConfig,
      persist: async () => ({ status: "not-needed" }) as never,
      runWorkflow: async () => {
        throw new Error("the fixture run failed");
      },
    });
    await expect(runner("update-documentation", "a turn", undefined, undefined)).rejects.toThrow(
      "the fixture run failed",
    );
    expect(state.entries()[0]?.requiredBy).toEqual([]);
    // Overlapping holds are counted, so one release does not free an entry a
    // second run still binds.
    const first = state.holdForRun("update-documentation");
    const second = state.holdForRun("update-documentation");
    first();
    first();
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["required-source"],
    );
    second();
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`);
    expect(state.entries()).toEqual([]);
  });

  it("refuses a date-scoped turn that a mid-conversation merge request would split", async () => {
    const state = selection({ ports: { identityPort: identityPort() } });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${HOST}/${PROJECT_PATH}!843`);
    const runner = createLiveAgentBoundedRunner({
      selection: state,
      repositoryPath: "/workspace/docsfab",
      allowWrite: true,
      config: {} as DocsFabConfig,
      persist: async () => ({ status: "not-needed" }) as never,
      runWorkflow: async () => {
        throw new Error("the run must not start");
      },
    });
    // Whatever `docsfab run` raises for the same words, a live-agent turn
    // relays verbatim. Derived from the shipped admission, not restated, so a
    // rewording there moves both sides of this assertion together.
    const shared = sharedDateWindowRefusal();
    expect(shared.length).toBeGreaterThan(0);
    const caught = await runner(
      "update-documentation",
      DATE_WINDOW_INSTRUCTION,
      undefined,
      undefined,
    )
      .then(() => undefined)
      .catch((error: unknown) => error as SourceCommandError);
    expect(caught?.code).toBe("instruction-conflict");
    expect(caught?.message).toBe(`${SOURCE_COMMAND_REFUSALS["instruction-conflict"]} ${shared}`);
    // The refusal fires before anything is held, so the selection stays
    // detachable rather than stranded by a run that never started.
    expect(state.entries()[0]?.requiredBy).toEqual([]);
  });
});

describe("live-agent source label collisions", () => {
  /**
   * `contextPath` admits a repository-relative path that is textually a
   * merge-request reference, and `admitCliSourceSelection` admits it beside the
   * `--pr` it duplicates. A guard comparing `repositoryPath`, which is `null`
   * for a merged change, would construct both entries, and every later `show`,
   * `remove` and `refresh <label>` would refuse `unknown-source`.
   */
  it("refuses a source path that collides with the attached merged change's label", () => {
    const collidingPath = `${HOST}/${PROJECT_PATH}!813`;
    const selector = parseChangeRequestSelector(
      `https://${HOST}/${PROJECT_PATH}/-/merge_requests/813`,
    );
    // The pair really is admitted one layer up, so this refusal is the one that
    // has to hold.
    const admitted = admitCliSourceSelection([
      "--source",
      collidingPath,
      "--pr",
      `https://${HOST}/${PROJECT_PATH}/-/merge_requests/813`,
    ]);
    expect(admitted.sourcePaths).toEqual([collidingPath]);
    expect(admitted.changeRequestSelector?.number).toBe(813);

    expect(() =>
      createLiveAgentSourceSelection({
        sourcePaths: admitted.sourcePaths,
        changeRequestSelector: admitted.changeRequestSelector!,
      }),
    ).toThrow(SOURCE_COMMAND_REFUSALS["duplicate-source"]);
    // Refused outright: no half-built selection is left behind for the session.
    let built: ReturnType<typeof createLiveAgentSourceSelection> | undefined;
    try {
      built = createLiveAgentSourceSelection({
        sourcePaths: [collidingPath],
        changeRequestSelector: selector,
      });
    } catch {
      built = undefined;
    }
    expect(built).toBeUndefined();

    // Control: two labels that differ coexist, and each is addressable.
    const sound = createLiveAgentSourceSelection({
      sourcePaths: [SOURCE_PATH],
      changeRequestSelector: selector,
    });
    expect(sound.entries().map((entry) => entry.label)).toEqual([
      SOURCE_PATH,
      `${HOST}/${PROJECT_PATH}!813`,
    ]);
    expect(new Set(sound.entries().map((entry) => entry.label)).size).toBe(2);
  });

  it("refuses an add whose label already names an attached source", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH] });
    await expect(state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${SOURCE_PATH}`)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["duplicate-source"],
    );
    expect(state.entries()).toHaveLength(1);
  });
});

describe("live-agent source command screen ordering", () => {
  /**
   * The second screen, on the path where it is the only one.
   *
   * A merged change's label is composed, not typed: `team/glpat-…` is a legal
   * GitLab namespace path, so the selector's own grammar admits it and the
   * label it composes is credential-shaped. The admission screen never sees
   * that label — it screens what the operator typed — so this is the outcome
   * screen firing on its own, before anything is committed.
   */
  it("withholds an attach whose composed label holds a configured credential, and attaches nothing", async () => {
    configureCredential(CREDENTIAL_FIXTURE);
    const poisonedProject = `team/${CREDENTIAL_FIXTURE}`;
    const port = identityPort();
    const state = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { identityPort: port },
    });
    const before = canonicalDigest(runRequestFor(state));
    const refusal = await state
      .dispatch(
        `${SOURCE_COMMAND_PREFIX} add https://${HOST}/${poisonedProject}/-/merge_requests/813`,
      )
      .then(() => undefined)
      .catch((error: unknown) => error as SourceCommandError);
    expect(refusal?.code).toBe("disclosure-screen");
    // The identity really was resolved first, so the refusal is the screen and
    // not an earlier grammar stop.
    expect(port.calls).toEqual([`${HOST}/${poisonedProject}`]);
    // Zero state change, and the listing still answers.
    expect(state.entries().map((entry) => entry.label)).toEqual([SOURCE_PATH]);
    expect(canonicalDigest(runRequestFor(state))).toBe(before);
    expect((await state.dispatch(SOURCE_COMMAND_PREFIX))?.kind).toBe("listing");
    // Positive control: the same shape with a sound project attaches.
    await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} add https://${HOST}/${PROJECT_PATH}/-/merge_requests/813`,
    );
    expect(state.entries()).toHaveLength(2);
    // So does a project whose name has a credential shape but is not a
    // configured credential (#1807). A conversation grounds on one merged
    // change, so this one attaches in a fresh conversation.
    const shaped = selection({
      sourcePaths: [SOURCE_PATH],
      ports: { identityPort: identityPort() },
    });
    await shaped.dispatch(
      `${SOURCE_COMMAND_PREFIX} add https://${HOST}/team/${SHAPED_FIXTURE}/-/merge_requests/813`,
    );
    expect(shaped.entries()).toHaveLength(2);
  });

  it("reports the selection a detach produced, not the one it started from", async () => {
    const state = selection({ sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH] });
    const outcome = (await state.dispatch(
      `${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`,
    )) as Extract<SourceCommandOutcomeV1, { kind: "detached" }>;
    // The outcome is built from the post-detach list *before* the splice, so a
    // reordering that splices first and then computes that list from the same
    // index reports a different entry as remaining. (A reordering that splices
    // first and reads the array afterwards produces an identical post-state and
    // is unobservable.)
    expect(outcome.entries.map((entry) => entry.label)).toEqual([SECOND_SOURCE_PATH]);
    expect(outcome.entries.map((entry) => entry.label)).toEqual(
      state.entries().map((entry) => entry.label),
    );
    expect(outcome.entry.label).toBe(SOURCE_PATH);
  });
});

describe("live-agent source terminal diagnostics", () => {
  it("projects the content-free repository access refusal", () => {
    const canary = "private-path MODEL_API_KEY=secret";
    const refusal = new RepositoryAccessRefusalError("repository-ownership-mismatch");
    expect(liveAgentSourceCommandRefusal(refusal)).toContain("ownership does not match");
    expect(liveAgentSourceCommandRefusal(refusal)).not.toContain(canary);
  });

  it("relays the checkout-remote failure instead of withholding it", async () => {
    const repositoryPath = await temporaryCheckout({ [SOURCE_PATH]: "notes\n" });
    const state = createLiveAgentSourceSelection({
      ports: createLiveAgentSourcePorts({ repositoryPath, environment: {}, commands: fakeForge() }),
    });
    const caught = await state
      .dispatch(`${SOURCE_COMMAND_PREFIX} add !5`)
      .then(() => undefined)
      .catch((error: unknown) => error);
    // DocsFab's own content-free sentence, and the one the operator needs.
    expect(liveAgentSourceCommandRefusal(caught)).toBe(GITLAB_READ_FAILURES.repository);
    expect(liveAgentSourceCommandRefusal(caught)).not.toContain("withheld the underlying");
    expect(state.entries()).toEqual([]);

    // And it reaches the terminal through the shipped loop.
    const transcript = await driveTerminal({
      selection: state,
      lines: [`${SOURCE_COMMAND_PREFIX} add !5`],
    });
    expect(transcript).toContain(GITLAB_READ_FAILURES.repository);
  }, 60_000);

  it("names a terminal action on the shared date-window refusal", async () => {
    const state = selection({ ports: { identityPort: identityPort() } });
    await state.dispatch(`${SOURCE_COMMAND_PREFIX} add ${HOST}/${PROJECT_PATH}!843`);
    const runner = createLiveAgentBoundedRunner({
      selection: state,
      repositoryPath: "/workspace/docsfab",
      allowWrite: true,
      config: {} as DocsFabConfig,
      persist: async () => ({ status: "not-needed" }) as never,
      runWorkflow: async () => {
        throw new Error("the run must not start");
      },
    });
    const caught = await runner(
      "update-documentation",
      DATE_WINDOW_INSTRUCTION,
      undefined,
      undefined,
    )
      .then(() => undefined)
      .catch((error: unknown) => error as Error);
    // The shared sentence is relayed verbatim, so the cross-entrypoint property
    // survives, and the terminal's own coded sentence carries the action. Both
    // halves are compared against their shipped sources, never against a copy.
    expect(caught?.message).toBe(
      `${SOURCE_COMMAND_REFUSALS["instruction-conflict"]} ${sharedDateWindowRefusal()}`,
    );
    expect(caught?.message).toContain(sharedDateWindowRefusal());
    expect((caught as SourceCommandError).code).toBe("instruction-conflict");
    // The terminal's action names a source command, never a command-line option
    // this operator could not have typed.
    expect(SOURCE_COMMAND_REFUSALS["instruction-conflict"]).not.toContain("--pr");
    expect(SOURCE_COMMAND_REFUSALS["instruction-conflict"]).toContain("remove the attachment");
  });
});
