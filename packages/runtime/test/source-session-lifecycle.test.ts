// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session source revalidation and bind refusal.
 *
 * Resume never treats history or cached bytes as authority: a source-bound
 * session must rebuild current access for every admitted source before
 * anything binds it, and must refuse stale or revoked bytes rather than
 * carrying them forward. This file proves both halves — the coded states, and
 * the bounded-run gate that honours them — so that removing the behaviour
 * makes it fail rather than pass vacuously.
 *
 * - Both sides are shipped entry points: `runTerminalConversation` over a
 *   scripted input stream, and `handleSourcesCommand`, which
 *   `src/cli/router.ts` calls. The bind gate is proved at
 *   `createLiveAgentBoundedRunner`, the shipped live-agent run callback.
 *   Nothing here calls the dispatcher, the classifier or
 *   `renderSourceCommandOutcome` to build an expectation.
 * - Every coded state message is read from the shipped
 *   `SOURCE_REVALIDATION_STATE_MESSAGES` table and asserted in the bytes the
 *   entry point wrote; bind refusals use the shipped `SOURCE_COMMAND_REFUSALS`
 *   sentences the same way.
 * - The no-drop claim carries a positive control: the same membership
 *   assertion is applied to a detach, where it must fail to hold. A refused
 *   bind keeps the source in `requestFields`.
 * - Fixtures diverge: the two tracked files, the two revisions of the drifting
 *   file, and the second project id all differ from each other.
 *
 * Fixtures only: no `glab`, no network, and no substitute for an
 * authenticated live proof.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { handleSourcesCommand } from "../src/cli/commands/sources.js";
import { limit } from "../src/config/limits.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { GitLabProjectIdentityPortV1 } from "../src/inputs/gitlab-source-provider.js";
import {
  TrackedSourceOversizeError,
  type TrackedSourceReaderV1,
} from "../src/inputs/source-acquisition.js";
import { createLiveAgentBoundedRunner, runTerminalConversation } from "../src/live-agent/host.js";
import {
  createLiveAgentSourceSelection,
  NO_RECORDED_PROJECT_REFERENCE_DETAIL,
  SOURCE_BIND_REFUSAL_BY_STATE,
  SOURCE_COMMAND_PREFIX,
  SOURCE_COMMAND_REFUSALS,
  SOURCE_REVALIDATION_BASES,
  SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT,
  SOURCE_REVALIDATION_MAX_ENTRIES_LIMIT,
  SOURCE_REVALIDATION_STATE_MESSAGES,
  SOURCE_REVALIDATION_STATES,
  SOURCE_VERSION_MAX_BYTES,
  SourceCommandError,
  sourceRevalidationWindowMs,
  type LiveAgentSourcePortsV1,
  type LiveAgentSourceSelection,
  type SourceCommandOutcomeV1,
  type SourceCommandRefusalCodeV1,
} from "../src/live-agent/source-commands.js";
import { initFixtureRepo } from "./helpers/git.js";

/**
 * The two revalidation bounds, read through the same `limit()` seam the
 * dispatcher reads and never retyped, so the test follows the catalog.
 */
const REVALIDATION_MAX_ENTRIES = limit(SOURCE_REVALIDATION_MAX_ENTRIES_LIMIT);
const REVALIDATION_WINDOW = limit(SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT);

/**
 * One minute of milliseconds, asked of the platform calendar rather than
 * `sourceRevalidationWindowMs`, the conversion under test. A boundary case that
 * advanced its clock by that function's output would be self-consistent at any
 * unit, so the duration is derived independently and the two have to agree.
 */
const ONE_MINUTE_MS = Date.UTC(1970, 0, 1, 0, 1) - Date.UTC(1970, 0, 1, 0, 0);

/** The declared window in milliseconds, built without the function under test. */
const REVALIDATION_WINDOW_MS = REVALIDATION_WINDOW.value * ONE_MINUTE_MS;

const HOST = "gitlab.lifecycle.test";
const PROJECT_PATH = "team/docs-project";
const PROJECT_ID = 437_040;
const OTHER_PROJECT_ID = 811_222;
const CHANGE = 843;
const SOURCE_PATH = "docs/release-notes.txt";
const SECOND_SOURCE_PATH = "docs/upgrade-guide.txt";
const MISSING_SOURCE_PATH = "docs/never-committed.txt";

/** Divergent bodies: a swapped comparison could not confuse these three. */
const SOURCE_BODY = "release notes body GAMMA-5510\n";
const SECOND_SOURCE_BODY = "upgrade guide body DELTA-7731\n";
const DRIFTED_SOURCE_BODY = "release notes body EPSILON-2264, rewritten\n";

const encoder = new TextEncoder();

const temporaryRoots: string[] = [];
afterAll(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

afterEach(() => {
  process.exitCode = undefined;
});

async function temporaryCheckout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-source-lifecycle-"));
  temporaryRoots.push(root);
  await initFixtureRepo(root, files, { branch: "main" });
  return root;
}

/** A tracked reader whose contents can move between two reads, as a repository does. */
function trackedReader(files: Record<string, string>): TrackedSourceReaderV1 & {
  readonly reads: string[];
  set(path: string, contents: string): void;
  drop(path: string): void;
} {
  const contents = new Map(Object.entries(files));
  const reads: string[] = [];
  return {
    reads,
    set(path: string, value: string) {
      contents.set(path, value);
    },
    drop(path: string) {
      contents.delete(path);
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

/**
 * How the forge answers the project-identity read.
 *
 * `throws` and `malformed` both reach the `catch` around
 * `resolveGitLabAcquisitionScope` with a port actually wired. A missing port
 * also fails closed inside the resolver and reaches that `catch`, so wiring a
 * port is what proves the failure came from an actual call.
 */
type IdentityBehaviourV1 =
  | "answers"
  /** A plain transport failure, the way an unreachable forge fails. */
  | "throws"
  /** Answers, but not with a usable numeric id: the provider raises `scope-identity`. */
  | "malformed"
  /** Answers about this project on the first call and a different id afterwards. */
  | "moves";

function identityPort(
  projectPath = PROJECT_PATH,
  projectId = PROJECT_ID,
  behaviour: IdentityBehaviourV1 = "answers",
) {
  const calls: string[] = [];
  const port: GitLabProjectIdentityPortV1 & { readonly calls: string[] } = {
    calls,
    async resolveProjectIdentity(reference: { host: string; projectPath: string }) {
      calls.push(`${reference.host}/${reference.projectPath}`);
      if (behaviour === "throws") {
        // Not a `SourceDiscoveryError`: this is the network refusing, which is
        // the case the catch arm must not report as a changed identity.
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }
      if (behaviour === "malformed") {
        // Structurally an answer, with no usable numeric id. The shipped
        // provider turns this into `SourceDiscoveryError("scope-identity")`,
        // which is a coded failure that is still not an identity *change*.
        return {
          host: reference.host,
          projectPath,
          projectId: "not-a-number",
        } as unknown as { host: string; projectPath: string; projectId: number };
      }
      if (behaviour === "moves") {
        // Same project path, different canonical id — a project deleted and
        // re-created under its old path. The path check inside the provider
        // passes, so this reaches the recorded-id comparison and nothing else.
        return {
          host: reference.host,
          projectPath,
          projectId: calls.length === 1 ? projectId : OTHER_PROJECT_ID,
        };
      }
      return { host: reference.host, projectPath, projectId };
    },
  };
  return port;
}

/** A settable clock, so the freshness window's two boundaries are executable. */
function clock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

interface FixturePortsInputV1 {
  readonly files?: Record<string, string>;
  /** Omit the tracked reader entirely, as a host that wired none does. */
  readonly reader?: boolean;
  /** Omit the project identity resolver entirely. */
  readonly identity?: boolean;
  readonly projectPath?: string;
  readonly projectId?: number;
  readonly identityBehaviour?: IdentityBehaviourV1;
  readonly now?: () => number;
  /** Substitute the tracked reader wholesale, to inject a read failure. */
  readonly substituteReader?: TrackedSourceReaderV1;
}

type FixturePortsV1 = LiveAgentSourcePortsV1 & {
  readonly reads: string[];
  readonly identityCalls: string[];
  set(path: string, contents: string): void;
  drop(path: string): void;
};

function fixturePorts(input: FixturePortsInputV1 = {}): FixturePortsV1 {
  const tracked = trackedReader(
    input.files ?? { [SOURCE_PATH]: SOURCE_BODY, [SECOND_SOURCE_PATH]: SECOND_SOURCE_BODY },
  );
  const reader: TrackedSourceReaderV1 = input.substituteReader
    ? { ...tracked, ...input.substituteReader }
    : tracked;
  const identity = identityPort(input.projectPath, input.projectId, input.identityBehaviour);
  return {
    reads: tracked.reads,
    identityCalls: identity.calls,
    set: (path, contents) => tracked.set(path, contents),
    drop: (path) => tracked.drop(path),
    ...(input.identity === false ? {} : { identityPort: identity }),
    ...(input.reader === false
      ? {}
      : {
          withTrackedSourceReader: <T>(use: (open: TrackedSourceReaderV1) => Promise<T>) =>
            use(reader),
        }),
    ...(input.now ? { now: input.now } : {}),
    checkoutProject: async () => ({ host: HOST, projectPath: input.projectPath ?? PROJECT_PATH }),
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("The scripted terminal line was never consumed.");
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

/**
 * Drive the shipped conversation loop over a scripted input stream.
 *
 * `blocks` records each separate write the loop performed, which is what makes a
 * byte assertion strict: a rendering must be one whole write of the terminal,
 * not merely a substring of the transcript.
 */
async function driveTerminal(input: {
  selection: LiveAgentSourceSelection;
  lines: readonly string[];
  between?: Record<number, () => void>;
}): Promise<{
  transcript: string;
  blocks: readonly string[];
  outcomes: readonly SourceCommandOutcomeV1[];
}> {
  const stream = new PassThrough();
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: process.stdout.columns,
  });
  const blocks: string[] = [];
  output.on("data", (chunk) => {
    blocks.push(chunk.toString());
  });
  const outcomes: SourceCommandOutcomeV1[] = [];
  let consumed = 0;
  const conversation = runTerminalConversation(
    {
      sessionFile: undefined,
      subscribe: () => () => {},
      prompt: async () => {
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
        try {
          const outcome = await input.selection.dispatch(line);
          if (outcome) outcomes.push(outcome);
          return outcome;
        } finally {
          consumed += 1;
        }
      },
    },
  );
  for (const [index, line] of input.lines.entries()) {
    input.between?.[index]?.();
    const before = consumed;
    stream.write(`${line}\n`);
    await waitUntil(() => consumed > before);
  }
  stream.write("/exit\n");
  await conversation;
  return { transcript: blocks.join(""), blocks, outcomes };
}

/** Run the live entry point over one seeded selection and a script of lines. */
async function live(input: {
  ports: FixturePortsV1;
  sourcePaths?: readonly string[];
  changeReference?: string;
  lines: readonly string[];
  between?: Record<number, () => void>;
}) {
  const selection = createLiveAgentSourceSelection({
    ...(input.sourcePaths?.length ? { sourcePaths: input.sourcePaths } : {}),
    ports: input.ports,
  });
  const terminal = await driveTerminal({
    selection,
    lines: input.lines,
    ...(input.between ? { between: input.between } : {}),
  });
  return { selection, ...terminal };
}

/** Run the command-line entry point over one seeded selection and one verb. */
async function cli(input: { root: string; ports: FixturePortsV1; argv: readonly string[] }) {
  const written: string[] = [];
  const result = await handleSourcesCommand([...input.argv, "--repo", input.root], {
    cwd: input.root,
    environment: {},
    write: (text) => written.push(text),
    writeError: (text) => written.push(text),
    ports: input.ports,
  });
  expect(written.join("")).toBe(result.text);
  return result;
}

/**
 * The last source listing the terminal wrote.
 *
 * Found by its own first line rather than taken as the last write, because the
 * loop writes a bare newline as it closes and a listing asserted against that
 * would pass by finding nothing.
 */
function lastListing(blocks: readonly string[]): string {
  const listing = blocks.filter(
    (block) =>
      block.startsWith("Attached Sources") ||
      block.startsWith("No sources are attached to this conversation."),
  );
  expect(listing.length, JSON.stringify(blocks)).toBeGreaterThan(0);
  return listing[listing.length - 1] as string;
}

/** Find the rendered detail section for one source without depending on table layout. */
function sourceDetails(text: string, label: string): string {
  const normalized = text.replace(/\n[ \t]*/gu, " ");
  const sections = normalized.split(/(?=Source: )/u);
  return sections.find((section) => section.startsWith(`Source: ${label} `)) ?? "";
}

function expectRenderedRefusal(text: string, code: SourceCommandRefusalCodeV1): void {
  const normalized = text.replace(/\n[ \t]*/gu, " ");
  expect(normalized).toContain("Selection: Unchanged.");
  expect(normalized).toContain(`ATTENTION: ${SOURCE_COMMAND_REFUSALS[code]}`);
}

/** Labels currently attached, as the selection itself reports them. */
function attachedLabels(selection: LiveAgentSourceSelection): readonly string[] {
  return selection.entries().map((entry) => entry.label);
}

describe("session source revalidation states", () => {
  it("reports a first observation as fresh on that basis rather than on a comparison", async () => {
    const root = await temporaryCheckout({
      [SOURCE_PATH]: SOURCE_BODY,
      [SECOND_SOURCE_PATH]: SECOND_SOURCE_BODY,
    });
    const livePorts = fixturePorts();
    const terminal = await live({
      ports: livePorts,
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 2"));
    expect(rendered, terminal.transcript).toBeDefined();
    // The state, the basis, and the coded sentence — all three, because the
    // state alone would let `fresh` on a never-compared file read as proof that
    // the file has not moved.
    expect(sourceDetails(rendered as string, SOURCE_PATH)).toContain(
      "Revalidation: fresh (first-observation)",
    );
    expect(sourceDetails(rendered as string, SECOND_SOURCE_PATH)).toContain(
      "Revalidation: fresh (first-observation)",
    );
    expect(rendered).toContain(SOURCE_REVALIDATION_STATE_MESSAGES.fresh);
    expect(rendered).not.toContain("recorded-digest");

    const cliPorts = fixturePorts();
    const result = await cli({
      root,
      ports: cliPorts,
      argv: ["revalidate", "--source", SOURCE_PATH, "--source", SECOND_SOURCE_PATH],
    });
    expect(result.refused).toBe(false);
    // Byte-identical to the terminal's own write, with only this surface's
    // process-scope note appended after it.
    expect(result.text.startsWith(rendered as string)).toBe(true);
    expect(livePorts.reads).toEqual(cliPorts.reads);
  });

  it("reports a source whose bytes moved since the recorded version as stale", async () => {
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [
        // The refresh records the baseline; the repository then moves under the
        // conversation; the revalidation must notice.
        `${SOURCE_COMMAND_PREFIX} refresh`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
        `${SOURCE_COMMAND_PREFIX}`,
      ],
      between: { 1: () => ports.set(SOURCE_PATH, DRIFTED_SOURCE_BODY) },
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
    expect(rendered, terminal.transcript).toBeDefined();
    expect(sourceDetails(rendered as string, SOURCE_PATH)).toContain(
      "Revalidation: stale (recorded-digest)",
    );
    expect(rendered).toContain(SOURCE_REVALIDATION_STATE_MESSAGES.stale);
    // Both digests are named, and they differ: a report that printed one value
    // twice would be reporting a comparison it did not make.
    const versions = /\(recorded ([0-9a-f]{12}), observed ([0-9a-f]{12})\)/u.exec(
      rendered as string,
    );
    expect(versions, rendered).not.toBeNull();
    expect((versions as RegExpExecArray)[1]).not.toBe((versions as RegExpExecArray)[2]);

    // Checked, not adopted. The listing printed after the revalidation still
    // carries the version the refresh recorded, so a later refresh still has
    // drift to report.
    const listing = lastListing(terminal.blocks);
    expect(sourceDetails(listing, SOURCE_PATH)).toContain(
      `Version: ${(versions as RegExpExecArray)[1]}`,
    );
    expect(sourceDetails(listing, SOURCE_PATH)).toContain("Revalidation: stale (recorded-digest)");
    // The verdict is the one field a revalidation writes. `Status` is what a
    // refresh adopts, so it still reads `attached` here: two fields answering
    // the same question could disagree, and a `status` a check had written
    // would strand as `unavailable` the moment a missing source came back.
    expect(sourceDetails(listing, SOURCE_PATH)).toContain("Status: attached");
  });

  it("reports a source that vanished from the selected revision as missing", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const livePorts = fixturePorts();
    const terminal = await live({
      ports: livePorts,
      sourcePaths: [MISSING_SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
    expect(rendered, terminal.transcript).toBeDefined();
    expect(sourceDetails(rendered as string, MISSING_SOURCE_PATH)).toContain(
      "Revalidation: missing (not-compared)",
    );
    expect(rendered).toContain(SOURCE_REVALIDATION_STATE_MESSAGES.missing);
    // Still attached. This is the sentence the state message makes, asserted
    // against the shipped selection rather than trusted.
    expect(attachedLabels(terminal.selection)).toEqual([MISSING_SOURCE_PATH]);

    const cliPorts = fixturePorts();
    const result = await cli({
      root,
      ports: cliPorts,
      argv: ["revalidate", "--source", MISSING_SOURCE_PATH],
    });
    expect(result.refused).toBe(false);
    expect(result.text.startsWith(rendered as string)).toBe(true);
  });

  it("reports a merged change whose project resolves elsewhere as identity-changed", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const reference = `${HOST}/${PROJECT_PATH}!${CHANGE}`;
    // The forge answers about a different project than the one the reference
    // named, which is the shipped provider's `out-of-scope-locator` condition.
    const livePorts = fixturePorts({ projectPath: "other/project", projectId: OTHER_PROJECT_ID });
    const liveSelection = createLiveAgentSourceSelection({
      changeRequestSelector: Object.freeze({
        schemaVersion: 1 as const,
        kind: "docsfab-change-request-selector" as const,
        provider: "gitlab" as const,
        host: HOST,
        projectPath: PROJECT_PATH,
        number: CHANGE,
      }),
      ports: livePorts,
    });
    const terminal = await driveTerminal({
      selection: liveSelection,
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
    expect(rendered, terminal.transcript).toBeDefined();
    expect(sourceDetails(rendered as string, reference)).toContain(
      "Revalidation: identity-changed (unresolved-project-identity)",
    );
    expect(rendered).toContain(SOURCE_REVALIDATION_STATE_MESSAGES["identity-changed"]);
    // No version was taken: comparing bytes across two identities would report
    // two different sources as one source that drifted.
    expect(livePorts.reads).toEqual([]);
    expect(attachedLabels(liveSelection)).toEqual([reference]);

    const cliPorts = fixturePorts({ projectPath: "other/project", projectId: OTHER_PROJECT_ID });
    const result = await cli({
      root,
      ports: cliPorts,
      argv: ["revalidate", "--pr", reference],
    });
    expect(result.refused).toBe(false);
    expect(result.text.startsWith(rendered as string)).toBe(true);
    expect(cliPorts.reads).toEqual([]);
  });

  it("proves a merged change against the numeric identity recorded when one was proved", async () => {
    // Attached through `/sources add`, which resolves and proves the numeric id,
    // so the admission record carries it and the re-check compares against it.
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      lines: [
        `${SOURCE_COMMAND_PREFIX} add ${HOST}/${PROJECT_PATH}!${CHANGE}`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
      ],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
    expect(rendered, terminal.transcript).toBeDefined();
    expect(sourceDetails(rendered as string, `${HOST}/${PROJECT_PATH}!${CHANGE}`)).toContain(
      "Revalidation: fresh (recorded-project-identity)",
    );
    // The resolver was asked twice: once to attach and once to re-check. A
    // revalidation that trusted the recorded id without asking would show one.
    expect(ports.identityCalls).toEqual([`${HOST}/${PROJECT_PATH}`, `${HOST}/${PROJECT_PATH}`]);
  });

  it("names one content-free sentence for every coded state and basis", () => {
    expect(Object.keys(SOURCE_REVALIDATION_STATE_MESSAGES).sort()).toEqual(
      [...SOURCE_REVALIDATION_STATES].sort(),
    );
    for (const state of SOURCE_REVALIDATION_STATES) {
      const message = SOURCE_REVALIDATION_STATE_MESSAGES[state];
      // Condition, then what the operator does about it: at least two sentences.
      expect(message.split(". ").length, state).toBeGreaterThan(1);
      expect(message.endsWith("."), state).toBe(true);
      expect(message, state).not.toMatch(/\$\{|undefined|\[object/u);
      expect(message, state).not.toMatch(/(?:\/Users|\/home|\/var|\/tmp|\/private|\/etc)\//u);
    }
    // Every basis is a value the report can print, so none may be a dangling
    // name: each is reachable from one of the cases in this file.
    expect([...SOURCE_REVALIDATION_BASES].sort()).toEqual([
      "first-observation",
      "not-compared",
      "recorded-digest",
      "recorded-project-identity",
      "unresolved-project-identity",
    ]);
  });
});

describe("session source revalidation distinguishes an unanswered identity from a changed one", () => {
  /**
   * The `catch` arm. The first two cases wire a port that is actually called and
   * then fails; since a missing port also reaches this `catch`, the call ledger
   * is what proves the refusal came from that call.
   */
  const CHANGE_REFERENCE = `${HOST}/${PROJECT_PATH}!${CHANGE}`;

  async function revalidateOneChange(ports: FixturePortsV1, root: string) {
    const selector = Object.freeze({
      schemaVersion: 1 as const,
      kind: "docsfab-change-request-selector" as const,
      provider: "gitlab" as const,
      host: HOST,
      projectPath: PROJECT_PATH,
      number: CHANGE,
    });
    const selection = createLiveAgentSourceSelection({ changeRequestSelector: selector, ports });
    const terminal = await driveTerminal({
      selection,
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    const cliPorts = fixturePorts({
      ...(ports.identityPort ? {} : { identity: false }),
      identityBehaviour: (ports as { behaviour?: IdentityBehaviourV1 }).behaviour ?? "answers",
    });
    return { selection, terminal, cliPorts, root };
  }

  it("refuses when a wired identity port throws a transport failure", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const livePorts = fixturePorts({ identityBehaviour: "throws" });
    const { selection, terminal } = await revalidateOneChange(livePorts, root);
    // The port was wired and was actually called, so the guard above the `try`
    // cannot be what produced this.
    expect(livePorts.identityCalls).toEqual([`${HOST}/${PROJECT_PATH}`]);
    expect(terminal.transcript).toContain(SOURCE_COMMAND_REFUSALS["identity-unverifiable"]);
    expect(terminal.transcript).not.toContain("identity-changed");
    expect(selection.entries()[0]?.revalidation ?? null).toBeNull();

    const cliPorts = fixturePorts({ identityBehaviour: "throws" });
    const result = await cli({
      root,
      ports: cliPorts,
      argv: ["revalidate", "--pr", CHANGE_REFERENCE],
    });
    expect(cliPorts.identityCalls).toEqual([`${HOST}/${PROJECT_PATH}`]);
    expect(result.refused).toBe(true);
    expectRenderedRefusal(result.text, "identity-unverifiable");
    expect(result.selection?.entries()[0]?.revalidation ?? null).toBeNull();
  });

  it("refuses when a wired identity port answers without a usable numeric id", async () => {
    // A coded provider failure that is still not an identity change: the shipped
    // provider raises SourceDiscoveryError("scope-identity"), and only
    // "out-of-scope-locator" may be read as a change.
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const livePorts = fixturePorts({ identityBehaviour: "malformed" });
    const { selection, terminal } = await revalidateOneChange(livePorts, root);
    expect(livePorts.identityCalls).toEqual([`${HOST}/${PROJECT_PATH}`]);
    expect(terminal.transcript).toContain(SOURCE_COMMAND_REFUSALS["identity-unverifiable"]);
    expect(terminal.transcript).not.toContain("identity-changed");
    expect(selection.entries()[0]?.revalidation ?? null).toBeNull();

    const cliPorts = fixturePorts({ identityBehaviour: "malformed" });
    const result = await cli({
      root,
      ports: cliPorts,
      argv: ["revalidate", "--pr", CHANGE_REFERENCE],
    });
    expect(result.refused).toBe(true);
    expectRenderedRefusal(result.text, "identity-unverifiable");
  });

  it("refuses a bare-number change that recorded no project reference to re-resolve", async () => {
    // The other reachable arm: a merged change attached as a bare number at
    // session start records no host and no project path, so there is nothing to
    // re-resolve rather than a resolution that failed.
    //
    // The shared sentence and the empty port ledger also hold with the guard
    // deleted — a null reference is refused by the provider before any I/O and
    // rendered through the same catch. The host-held detail distinguishes the
    // two arms, so that is what this asserts.
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts();
    const result = await cli({ root, ports, argv: ["revalidate", "--pr", String(CHANGE)] });
    expect(result.refused).toBe(true);
    expectRenderedRefusal(result.text, "identity-unverifiable");
    expect(result.text).toContain(NO_RECORDED_PROJECT_REFERENCE_DETAIL);
    expect(ports.identityCalls).toEqual([]);
    expect(result.selection?.entries()[0]?.revalidation ?? null).toBeNull();
  });

  it("refuses with no forge call at all when no identity resolver was wired", async () => {
    // No port means the shipped provider fails closed before any I/O, and the
    // catch turns that into the one refusal. Asserting the empty call ledger is
    // what proves "fails closed" rather than "failed after calling out".
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({ identity: false });
    const result = await cli({
      root,
      ports,
      argv: ["revalidate", "--pr", `${HOST}/${PROJECT_PATH}!${CHANGE}`],
    });
    expect(result.refused).toBe(true);
    // The whole reference was recorded, so this arm is the forge declining to
    // answer rather than the bare-number arm, and the body carries the shared
    // sentence with no detail appended. Asserted as bytes beside the case
    // above, which is what makes the two arms distinguishable at the surface.
    expectRenderedRefusal(result.text, "identity-unverifiable");
    expect(result.text).not.toContain(NO_RECORDED_PROJECT_REFERENCE_DETAIL);
    expect(ports.identityCalls).toEqual([]);
  });

  it("names the by-label escape so a permanently gone project is not a dead end", () => {
    // One unreachable merged change stops the whole command, so the refusal has
    // to say what still works. Asserted on the shipped sentence rather than on a
    // copy of it.
    expect(SOURCE_COMMAND_REFUSALS["identity-unverifiable"]).toContain(
      "revalidate the sources you can by naming each label the source listing prints",
    );
  });

  it("still reports a project that resolves elsewhere as identity-changed, not as unverifiable", async () => {
    // The positive control for the two cases above: the same code path, a
    // different forge answer, and a state rather than a refusal.
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({ projectPath: "other/project", projectId: OTHER_PROJECT_ID });
    const result = await cli({
      root,
      ports,
      argv: ["revalidate", "--pr", CHANGE_REFERENCE],
    });
    expect(result.refused).toBe(false);
    expect(result.text).toContain("identity-changed (unresolved-project-identity)");
    expect(result.text).not.toContain(SOURCE_COMMAND_REFUSALS["identity-unverifiable"]);
  });

  it("reports a project whose canonical id moved under the same path as identity-changed", async () => {
    // The divergent-id fixture. Attaching proves PROJECT_ID and records it; the
    // re-check answers about the same path with OTHER_PROJECT_ID, which is a
    // project deleted and re-created. Only the recorded-id comparison can catch
    // this: the path check inside the provider passes.
    const ports = fixturePorts({ identityBehaviour: "moves" });
    const terminal = await live({
      ports,
      lines: [
        `${SOURCE_COMMAND_PREFIX} add ${CHANGE_REFERENCE}`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
        SOURCE_COMMAND_PREFIX,
      ],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
    expect(rendered, terminal.transcript).toBeDefined();
    expect(sourceDetails(rendered as string, CHANGE_REFERENCE)).toContain(
      "Revalidation: identity-changed (recorded-project-identity)",
    );
    expect(rendered).toContain(SOURCE_REVALIDATION_STATE_MESSAGES["identity-changed"]);
    // Two calls, divergent answers: the comparison had something to fail on.
    expect(ports.identityCalls).toHaveLength(2);
    // Still attached, and the listing carries the verdict.
    expect(attachedLabels(terminal.selection)).toEqual([CHANGE_REFERENCE]);
    expect(sourceDetails(lastListing(terminal.blocks), CHANGE_REFERENCE)).toContain(
      "Revalidation: identity-changed (recorded-project-identity)",
    );
  });

  it("reports the same change as fresh when the canonical id has not moved", async () => {
    // The control for the fixture above: identical script, a port that answers
    // consistently, and the opposite verdict.
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      lines: [
        `${SOURCE_COMMAND_PREFIX} add ${CHANGE_REFERENCE}`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
      ],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
    expect(sourceDetails(rendered as string, CHANGE_REFERENCE)).toContain(
      "Revalidation: fresh (recorded-project-identity)",
    );
    expect(ports.identityCalls).toHaveLength(2);
  });
});

describe("session source revalidation separates an absent file from an unreadable one", () => {
  /** A reader that finds the file present and fails to read it. */
  function failingReader(error: Error): TrackedSourceReaderV1 {
    return {
      async isTrackedRegularFile() {
        return true;
      },
      async readTrackedBytes() {
        throw error;
      },
    };
  }

  const cases: ReadonlyArray<readonly [string, () => Error]> = [
    ["over the version ceiling", () => new TrackedSourceOversizeError(SOURCE_PATH)],
    ["failing with an I/O error", () => Object.assign(new Error("read failed"), { code: "EIO" })],
  ];

  it.each(cases.map(([name, build]) => [name, build] as const))(
    "reports a present file %s as unreadable rather than missing",
    async (_name, build) => {
      const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
      const livePorts = fixturePorts({ substituteReader: failingReader(build()) });
      const terminal = await live({
        ports: livePorts,
        sourcePaths: [SOURCE_PATH],
        lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
      });
      const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
      expect(rendered, terminal.transcript).toBeDefined();
      expect(sourceDetails(rendered as string, SOURCE_PATH)).toContain(
        "Revalidation: unreadable (not-compared)",
      );
      expect(rendered).toContain(SOURCE_REVALIDATION_STATE_MESSAGES.unreadable);
      // The two facts must not be confusable: a present file is never told to be
      // restored, and never claimed to have drifted.
      expect(rendered).not.toContain("missing");
      expect(rendered).not.toContain("stale");
      expect(rendered).not.toContain(SOURCE_REVALIDATION_STATE_MESSAGES.missing);
      // Still attached, and the message names the ceiling it may have hit.
      expect(attachedLabels(terminal.selection)).toEqual([SOURCE_PATH]);
      expect(SOURCE_REVALIDATION_STATE_MESSAGES.unreadable).toContain(
        `${SOURCE_VERSION_MAX_BYTES}-byte version ceiling`,
      );

      const cliPorts = fixturePorts({ substituteReader: failingReader(build()) });
      const result = await cli({
        root,
        ports: cliPorts,
        argv: ["revalidate", "--source", SOURCE_PATH],
      });
      expect(result.refused).toBe(false);
      expect(result.text.startsWith(rendered as string)).toBe(true);
    },
    120_000,
  );

  it("still reports a file the host says is not tracked there as missing", async () => {
    // The control that keeps the split honest in both directions: absence is a
    // definite answer and stays a state of its own.
    const ports = fixturePorts({
      substituteReader: {
        async isTrackedRegularFile() {
          return false;
        },
        async readTrackedBytes() {
          throw new Error("must not be read when the host says it is not there");
        },
      },
    });
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 1"));
    expect(sourceDetails(rendered as string, SOURCE_PATH)).toContain(
      "Revalidation: missing (not-compared)",
    );
    expect(rendered).toContain(SOURCE_REVALIDATION_STATE_MESSAGES.missing);
    expect(rendered).not.toContain("unreadable");
  });

  it("reports one unreadable file without stopping the others from being re-checked", async () => {
    // Why this is a per-source state and not a whole-command refusal: an
    // oversized file must not cost the operator every other verdict.
    const ports = fixturePorts({
      substituteReader: {
        async isTrackedRegularFile() {
          return true;
        },
        async readTrackedBytes(repositoryPath: string) {
          if (repositoryPath === SOURCE_PATH) throw new Error("unreadable");
          return encoder.encode(SECOND_SOURCE_BODY);
        },
      },
    });
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 2"));
    expect(rendered, terminal.transcript).toBeDefined();
    expect(sourceDetails(rendered as string, SOURCE_PATH)).toContain(
      "Revalidation: unreadable (not-compared)",
    );
    expect(sourceDetails(rendered as string, SECOND_SOURCE_PATH)).toContain(
      "Revalidation: fresh (first-observation)",
    );
  });
});

describe("session source revalidation never drops a source", () => {
  it("keeps every attached source bound after a revalidation finds none of them current", async () => {
    const ports = fixturePorts({
      files: { [SOURCE_PATH]: SOURCE_BODY, [SECOND_SOURCE_PATH]: SECOND_SOURCE_BODY },
    });
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH, MISSING_SOURCE_PATH],
      lines: [
        `${SOURCE_COMMAND_PREFIX} refresh`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
        `${SOURCE_COMMAND_PREFIX}`,
      ],
      between: {
        1: () => {
          ports.set(SOURCE_PATH, DRIFTED_SOURCE_BODY);
          ports.drop(SECOND_SOURCE_PATH);
        },
      },
    });
    const rendered = terminal.blocks.find((block) => block.startsWith("Revalidated 3"));
    expect(rendered, terminal.transcript).toBeDefined();
    expect(sourceDetails(rendered as string, SOURCE_PATH)).toContain(
      "Revalidation: stale (recorded-digest)",
    );
    expect(sourceDetails(rendered as string, SECOND_SOURCE_PATH)).toContain(
      "Revalidation: missing (not-compared)",
    );
    expect(sourceDetails(rendered as string, MISSING_SOURCE_PATH)).toContain(
      "Revalidation: missing (not-compared)",
    );
    expect(rendered).toContain("3 sources remain attached; revalidation detaches nothing.");

    // The three places a dropped source would actually hurt: the listing an
    // operator reads, the selection state, and the fields the next bounded run
    // binds. All three still carry all three sources.
    const expected = [SOURCE_PATH, SECOND_SOURCE_PATH, MISSING_SOURCE_PATH];
    expect(attachedLabels(terminal.selection)).toEqual(expected);
    expect(terminal.selection.requestFields().sourcePaths).toEqual(expected);
    const listing = lastListing(terminal.blocks);
    for (const label of expected) expect(listing).toContain(label);
    expect(listing).toContain("Attached Sources");
  });

  it("carries this command's verdicts in the outcome, not the previous command's", async () => {
    // `outcome` is public API — `SourcesCommandResultV1.outcome` — and its
    // `entries` field is documented as the listing after the check. Projecting
    // the entries as they stood would give it the membership of after and the
    // freshness of before, so on a first revalidation every verdict would read
    // `null` while the very next listing shows one.
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts();
    const result = await cli({ root, ports, argv: ["revalidate", "--source", SOURCE_PATH] });
    expect(result.refused).toBe(false);
    expect(result.outcome?.kind).toBe("revalidated");
    const projected =
      result.outcome?.kind === "revalidated" ? result.outcome.entries[0]?.revalidation : undefined;
    expect(projected).toEqual({
      state: "fresh",
      basis: "first-observation",
      withinWindow: true,
    });
    // And it agrees with the selection the operator reads next, which is the
    // property the field exists to carry.
    expect(projected).toEqual(result.selection?.entries()[0]?.revalidation);
  });

  it("carries this command's revalidation count in the outcome, not the previous command's", async () => {
    // A revalidation moves exactly two projected fields — the verdict and the
    // count the "Historical use" line is built from. Both are asserted against
    // the same selection the operator reads next, so substituting one without
    // the other fails here.
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts();
    const result = await cli({ root, ports, argv: ["revalidate", "--source", SOURCE_PATH] });
    expect(result.refused).toBe(false);
    const outcomeEntry =
      result.outcome?.kind === "revalidated" ? result.outcome.entries[0] : undefined;
    const nextListing = result.selection?.entries()[0];
    expect(outcomeEntry?.historicalUse).toEqual([
      "attached in this conversation",
      "revalidated once",
    ]);
    expect(outcomeEntry?.historicalUse).toEqual(nextListing?.historicalUse);
    // The whole projected entry, not only the two fields named above: any other
    // field that a revalidation moved without being substituted diverges here.
    expect(outcomeEntry).toEqual(nextListing);
  });

  it("reports an unrevalidated source with no revalidation count at all", async () => {
    // The positive control for the case above. Without it, an outcome that
    // always printed "revalidated once" would satisfy the assertion, and the
    // count would stop being evidence of anything.
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [SOURCE_COMMAND_PREFIX],
    });
    expect(terminal.selection.entries()[0]?.historicalUse).toEqual([
      "attached in this conversation",
    ]);
    expect(lastListing(terminal.blocks)).not.toContain("revalidated once");
  });

  it("counts a second revalidation as two in the outcome of the second command", async () => {
    // One command's substitution is indistinguishable from an off-by-one that
    // always reports one. Two revalidations through the shipped conversation
    // loop, reading the second command's own outcome, separate them — and the
    // rendered listing that follows carries the same sentence.
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [
        `${SOURCE_COMMAND_PREFIX} revalidate`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
        SOURCE_COMMAND_PREFIX,
      ],
    });
    const second = terminal.outcomes[1];
    expect(second?.kind).toBe("revalidated");
    const entry = second?.kind === "revalidated" ? second.entries[0] : undefined;
    expect(entry?.historicalUse).toEqual(["attached in this conversation", "revalidated 2 times"]);
    expect(entry?.historicalUse).toEqual(terminal.selection.entries()[0]?.historicalUse);
    expect(sourceDetails(lastListing(terminal.blocks), SOURCE_PATH)).toContain(
      "Historical use: attached in this conversation; revalidated 2 times",
    );
  });

  it("detects a dropped source when one is actually detached", async () => {
    // The positive control for the assertion above. The same three checks are
    // applied to a `remove`, where the membership *must* change: an assertion
    // that could not see a source leave would pass here too, and this fails.
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} remove ${SECOND_SOURCE_PATH}`, SOURCE_COMMAND_PREFIX],
    });
    expect(attachedLabels(terminal.selection)).toEqual([SOURCE_PATH]);
    expect(terminal.selection.requestFields().sourcePaths).toEqual([SOURCE_PATH]);
    const listing = lastListing(terminal.blocks);
    expect(listing).toContain("Attached Sources");
    expect(listing).not.toContain(SECOND_SOURCE_PATH);
  });

  it("records nothing at all when the whole command is refused", async () => {
    // A refusal that had already written some verdicts would leave the listing
    // claiming a check that the operator was told did not happen.
    const ports = fixturePorts({ reader: false });
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`, SOURCE_COMMAND_PREFIX],
    });
    expect(terminal.transcript).toContain(SOURCE_COMMAND_REFUSALS["inspection-unavailable"]);
    expect(terminal.selection.entries()[0]?.revalidation).toBeNull();
    expect(sourceDetails(lastListing(terminal.blocks), SOURCE_PATH)).toContain(
      "Revalidation: not revalidated in this conversation",
    );
  });
});

describe("session source revalidation stops rather than reporting a partial check", () => {
  it("refuses the whole command when no reader for the selected revision was wired", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({ reader: false });
    const result = await cli({ root, ports, argv: ["revalidate", "--source", SOURCE_PATH] });
    expect(result.refused).toBe(true);
    expectRenderedRefusal(result.text, "inspection-unavailable");
    expect(ports.reads).toEqual([]);
  });

  it("spends no forge call on a revalidation that is already going to refuse", async () => {
    // A file with no reader wired refuses whatever the forge says, so asking it
    // is a credentialed round trip that buys nothing. The precondition is
    // checked before the merged change is walked, not after.
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({ reader: false });
    const result = await cli({
      root,
      ports,
      argv: ["revalidate", "--source", SOURCE_PATH, "--pr", `${HOST}/${PROJECT_PATH}!${CHANGE}`],
    });
    expect(result.refused).toBe(true);
    expectRenderedRefusal(result.text, "inspection-unavailable");
    expect(ports.reads).toEqual([]);
    expect(ports.identityCalls).toEqual([]);
  });

  it("answers an empty selection the way every other verb answers it", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts();
    const result = await cli({ root, ports, argv: ["revalidate"] });
    expect(result.refused).toBe(false);
    expect(result.text).toContain("No sources are attached to this conversation.");
    expect(result.text).not.toContain("Revalidated 0");
    expect(ports.reads).toEqual([]);
  });

  it("refuses the whole command when an attached change's identity cannot be re-resolved", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const reference = `${HOST}/${PROJECT_PATH}!${CHANGE}`;
    const ports = fixturePorts({ identity: false });
    const result = await cli({ root, ports, argv: ["revalidate", "--pr", reference] });
    expect(result.refused).toBe(true);
    // Not `identity-changed`: an unanswerable question is not a changed answer.
    expectRenderedRefusal(result.text, "identity-unverifiable");
    expect(result.selection?.entries()[0]?.revalidation ?? null).toBeNull();
  });
});

describe("session source revalidation bounds", () => {
  /** `count` distinct repository paths, tracked in the fixture reader. */
  function manySources(count: number): { paths: string[]; files: Record<string, string> } {
    const paths: string[] = [];
    const files: Record<string, string> = {};
    for (let index = 0; index < count; index += 1) {
      const path = `docs/bounded-${String(index).padStart(3, "0")}.txt`;
      paths.push(path);
      // Divergent bodies, so a classifier that compared the wrong pair fails.
      files[path] = `bounded source body ${index}\n`;
    }
    return { paths, files };
  }

  it("revalidates exactly the maximum attached sources in one command", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const { paths, files } = manySources(REVALIDATION_MAX_ENTRIES.value);
    const ports = fixturePorts({ files });
    const argv = ["revalidate", ...paths.flatMap((path) => ["--source", path])];
    const result = await cli({ root, ports, argv });
    expect(result.refused).toBe(false);
    expect(result.text).toContain(`Revalidated ${REVALIDATION_MAX_ENTRIES.value} attached sources`);
    expect(ports.reads).toEqual(paths);
  });

  it("refuses one more than the maximum before reading anything", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const { paths, files } = manySources(REVALIDATION_MAX_ENTRIES.value + 1);
    const cliPorts = fixturePorts({ files });
    const argv = ["revalidate", ...paths.flatMap((path) => ["--source", path])];
    const result = await cli({ root, ports: cliPorts, argv });
    expect(result.refused).toBe(true);
    expectRenderedRefusal(result.text, "too-many-sources");
    // The limit, the observed count and the bound are all named, which is what
    // makes the stop actionable, and nothing was read, which is what makes it
    // true. The limit's catalog name is what an operator types into
    // `docsfab doctor --limits` to see the value in force.
    expect(result.text).toContain(
      `This conversation has ${REVALIDATION_MAX_ENTRIES.value + 1} attached sources and one revalidation re-checks at most ${REVALIDATION_MAX_ENTRIES.value} (${REVALIDATION_MAX_ENTRIES.name}).`,
    );
    expect(REVALIDATION_MAX_ENTRIES.name).toBe("sources.revalidationMaxEntries");
    expect(cliPorts.reads).toEqual([]);

    const livePorts = fixturePorts({ files });
    const terminal = await live({
      ports: livePorts,
      sourcePaths: paths,
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    expect(terminal.transcript).toContain(SOURCE_COMMAND_REFUSALS["too-many-sources"]);
    expect(livePorts.reads).toEqual([]);
    // The escape the refusal names actually works: one at a time is admitted.
    const single = await live({
      ports: fixturePorts({ files }),
      sourcePaths: paths,
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate ${paths[0] as string}`],
    });
    expect(single.transcript).toContain("Revalidated 1 attached source");
  });

  it("reports a verdict as current at the freshness window and lapsed one millisecond later", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const atWindow = clock();
    const livePorts = fixturePorts({ now: atWindow.now });
    const terminal = await live({
      ports: livePorts,
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`, SOURCE_COMMAND_PREFIX, SOURCE_COMMAND_PREFIX],
      between: {
        1: () => atWindow.advance(REVALIDATION_WINDOW_MS),
        2: () => atWindow.advance(1),
      },
    });
    const listings = terminal.blocks.filter((block) => block.startsWith("Attached Sources"));
    expect(listings).toHaveLength(2);
    // Exactly at the window the verdict is still current.
    expect(sourceDetails(listings[0] as string, SOURCE_PATH)).toContain(
      "Revalidation: fresh (first-observation)",
    );
    expect(listings[0]).not.toContain("beyond the revalidation window");
    // One millisecond past it, the state and its basis are kept and only the
    // currency claim lapses. A listing that dropped the verdict here would be
    // indistinguishable from one that never checked.
    // The duration and its unit are both read from the shipped limits catalog,
    // not retyped or converted here, so the line an operator reads agrees with
    // the row `docsfab doctor --limits` prints.
    expect(sourceDetails(listings[1] as string, SOURCE_PATH)).toContain(
      `Revalidation: fresh (first-observation), checked more than ${REVALIDATION_WINDOW.value} ${REVALIDATION_WINDOW.unit} ago and beyond the revalidation window`,
    );
    expect(REVALIDATION_WINDOW.unit).toBe("minutes");

    // Both boundaries render the same way at the command-line surface, which
    // reads its own clock through the same port.
    const lapsed = clock();
    const cliPorts = fixturePorts({ now: lapsed.now });
    const result = await cli({
      root,
      ports: cliPorts,
      argv: ["revalidate", "--source", SOURCE_PATH],
    });
    expect(result.refused).toBe(false);
    lapsed.advance(REVALIDATION_WINDOW_MS);
    expect(result.selection?.entries()[0]?.revalidation?.withinWindow).toBe(true);
    lapsed.advance(1);
    expect(result.selection?.entries()[0]?.revalidation?.withinWindow).toBe(false);
    expect(result.selection?.entries()[0]?.revalidation?.state).toBe("fresh");
  });

  it("converts the declared window into minutes of milliseconds, not merely into a linear unit", () => {
    /**
     * The conversion the dispatcher performs, pinned for its unit and not only
     * for its linearity.
     *
     * The catalog declares this bound in minutes, the unit the operator line
     * prints; the comparison needs milliseconds. A linearity check alone stays
     * true if the conversion used seconds, which would report a verdict seconds
     * old as past a window stated in minutes. So the unit is read out of the
     * platform calendar, which can contradict the conversion. Neither assertion
     * retypes a factor.
     */
    expect(sourceRevalidationWindowMs(1)).toBe(ONE_MINUTE_MS);
    const oneMinuteLater = new Date(sourceRevalidationWindowMs(1));
    expect(oneMinuteLater.getUTCMinutes()).toBe(1);
    expect(oneMinuteLater.getUTCSeconds()).toBe(0);
    expect(oneMinuteLater.getUTCMilliseconds()).toBe(0);

    // The declared window is that unit taken the catalog's number of times, and
    // it is what the boundary case above advances its own clock by.
    expect(sourceRevalidationWindowMs()).toBe(REVALIDATION_WINDOW.value * ONE_MINUTE_MS);
    expect(sourceRevalidationWindowMs()).toBe(REVALIDATION_WINDOW_MS);

    // Ninety minutes rolls the UTC hour field over and still lands exactly, in
    // the fields as well as in the total.
    expect(sourceRevalidationWindowMs(90)).toBe(90 * ONE_MINUTE_MS);
    const ninetyMinutesLater = new Date(sourceRevalidationWindowMs(90));
    expect(ninetyMinutesLater.getUTCHours()).toBe(1);
    expect(ninetyMinutesLater.getUTCMinutes()).toBe(30);
    expect(ninetyMinutesLater.getUTCSeconds()).toBe(0);
  });
});

describe("session source revalidation checks where a refresh adopts", () => {
  it("leaves the recorded version where a refresh of the same drift would move it", async () => {
    // One fixture, two verbs, one difference. The refresh adopts and the next
    // listing is current; the revalidation reports and the next listing still
    // carries the version the conversation recorded.
    const adopting = fixturePorts();
    const adopted = await live({
      ports: adopting,
      sourcePaths: [SOURCE_PATH],
      lines: [
        `${SOURCE_COMMAND_PREFIX} refresh`,
        `${SOURCE_COMMAND_PREFIX} refresh`,
        SOURCE_COMMAND_PREFIX,
      ],
      between: { 1: () => adopting.set(SOURCE_PATH, DRIFTED_SOURCE_BODY) },
    });
    const checking = fixturePorts();
    const checked = await live({
      ports: checking,
      sourcePaths: [SOURCE_PATH],
      lines: [
        `${SOURCE_COMMAND_PREFIX} refresh`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
        SOURCE_COMMAND_PREFIX,
      ],
      between: { 1: () => checking.set(SOURCE_PATH, DRIFTED_SOURCE_BODY) },
    });
    const adoptedVersion = adopted.selection.entries()[0]?.version;
    const checkedVersion = checked.selection.entries()[0]?.version;
    expect(adoptedVersion).toBeDefined();
    expect(checkedVersion).toBeDefined();
    // The two surfaces read the same two revisions of the same file, so the
    // versions can only differ because one verb adopted and the other did not.
    expect(adoptedVersion).not.toBe(checkedVersion);
    expect(adopting.reads).toEqual(checking.reads);
    expect(adopted.selection.entries()[0]?.revalidation).toBeNull();
    expect(checked.selection.entries()[0]?.revalidation?.state).toBe("stale");
  });
});

describe("session source bind refuses a last verdict that is not current", () => {
  /**
   * The shipped live-agent run callback, with a spy in place of the shared
   * assembly. Proof lives here rather than on `assertBindable` alone: a helper
   * that refused while the runner still bound would leave the gate unenforced.
   */
  function bindRunner(selection: LiveAgentSourceSelection) {
    const started: { workflow: string; sourcePaths?: readonly string[] }[] = [];
    const runner = createLiveAgentBoundedRunner({
      selection,
      repositoryPath: "/workspace/docsfab",
      allowWrite: true,
      config: {} as DocsFabConfig,
      persist: async () => ({ status: "not-needed" }) as never,
      runWorkflow: async (request) => {
        started.push({
          workflow: request.workflow,
          ...(request.sourcePaths ? { sourcePaths: request.sourcePaths } : {}),
        });
        return { id: "bind-ok", workflow: request.workflow, status: "completed" } as never;
      },
    });
    return { runner, started };
  }

  const BIND_INSTRUCTION = "Create the export guide.";

  async function expectBindRefusal(
    selection: LiveAgentSourceSelection,
    code: SourceCommandRefusalCodeV1,
  ): Promise<SourceCommandError> {
    const { runner, started } = bindRunner(selection);
    const caught = await runner("create-documentation", BIND_INSTRUCTION)
      .then(() => undefined)
      .catch((error: unknown) => error as SourceCommandError);
    expect(caught?.code).toBe(code);
    expect(caught?.message.startsWith(SOURCE_COMMAND_REFUSALS[code])).toBe(true);
    expect(started).toEqual([]);
    for (const entry of selection.entries()) {
      expect(entry.requiredBy).toEqual([]);
      expect(entry.historicalUse.some((line) => line.includes("bound by"))).toBe(false);
    }
    expect(caught).toBeDefined();
    return caught as SourceCommandError;
  }

  it("names a bind refusal for every coded state that is not fresh", () => {
    const nonFresh = SOURCE_REVALIDATION_STATES.filter((state) => state !== "fresh");
    expect(Object.keys(SOURCE_BIND_REFUSAL_BY_STATE).sort()).toEqual([...nonFresh].sort());
    for (const state of nonFresh) {
      expect(SOURCE_COMMAND_REFUSALS[SOURCE_BIND_REFUSAL_BY_STATE[state]]).toContain(
        "Nothing was started",
      );
    }
    expect(SOURCE_COMMAND_REFUSALS["bind-expired"]).toContain("freshness window");
  });

  it("binds a source this conversation has never revalidated", async () => {
    const terminal = await live({
      ports: fixturePorts(),
      sourcePaths: [SOURCE_PATH],
      lines: [SOURCE_COMMAND_PREFIX],
    });
    expect(terminal.selection.entries()[0]?.revalidation).toBeNull();
    const { runner, started } = bindRunner(terminal.selection);
    await runner("create-documentation", BIND_INSTRUCTION);
    expect(started).toEqual([{ workflow: "create-documentation", sourcePaths: [SOURCE_PATH] }]);
  });

  it("binds a fresh verdict that is still within the window", async () => {
    const terminal = await live({
      ports: fixturePorts(),
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    expect(terminal.selection.entries()[0]?.revalidation).toMatchObject({
      state: "fresh",
      withinWindow: true,
    });
    const { runner, started } = bindRunner(terminal.selection);
    await runner("create-documentation", BIND_INSTRUCTION);
    expect(started).toEqual([{ workflow: "create-documentation", sourcePaths: [SOURCE_PATH] }]);
  });

  it("refuses a stale last verdict, keeps the source, and binds after a refresh re-checks fresh", async () => {
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} refresh`, `${SOURCE_COMMAND_PREFIX} revalidate`],
      between: { 1: () => ports.set(SOURCE_PATH, DRIFTED_SOURCE_BODY) },
    });
    expect(terminal.selection.entries()[0]?.revalidation?.state).toBe("stale");
    expect(terminal.selection.requestFields()).toEqual({ sourcePaths: [SOURCE_PATH] });
    await expectBindRefusal(terminal.selection, "bind-stale");
    expect(terminal.selection.requestFields()).toEqual({ sourcePaths: [SOURCE_PATH] });

    await terminal.selection.dispatch(`${SOURCE_COMMAND_PREFIX} refresh`);
    await terminal.selection.dispatch(`${SOURCE_COMMAND_PREFIX} revalidate`);
    expect(terminal.selection.entries()[0]?.revalidation).toMatchObject({
      state: "fresh",
      withinWindow: true,
    });
    const { runner, started } = bindRunner(terminal.selection);
    await runner("create-documentation", BIND_INSTRUCTION);
    expect(started).toEqual([{ workflow: "create-documentation", sourcePaths: [SOURCE_PATH] }]);
  });

  it("refuses a missing last verdict without dropping the source from the next request", async () => {
    const terminal = await live({
      ports: fixturePorts(),
      sourcePaths: [MISSING_SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    expect(terminal.selection.entries()[0]?.revalidation?.state).toBe("missing");
    await expectBindRefusal(terminal.selection, "bind-missing");
    expect(terminal.selection.requestFields()).toEqual({ sourcePaths: [MISSING_SOURCE_PATH] });
  });

  it("refuses an unreadable last verdict rather than treating it as missing", async () => {
    const terminal = await live({
      ports: fixturePorts({
        substituteReader: {
          async isTrackedRegularFile() {
            return true;
          },
          async readTrackedBytes() {
            throw new TrackedSourceOversizeError(SOURCE_PATH);
          },
        },
      }),
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    expect(terminal.selection.entries()[0]?.revalidation?.state).toBe("unreadable");
    await expectBindRefusal(terminal.selection, "bind-unreadable");
  });

  it("refuses an identity-changed last verdict on a merged change", async () => {
    const ports = fixturePorts({ identityBehaviour: "moves" });
    const reference = `${HOST}/${PROJECT_PATH}!${CHANGE}`;
    const terminal = await live({
      ports,
      lines: [`${SOURCE_COMMAND_PREFIX} add ${reference}`, `${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    expect(terminal.selection.entries()[0]?.revalidation?.state).toBe("identity-changed");
    await expectBindRefusal(terminal.selection, "bind-identity-changed");
    expect(terminal.selection.requestFields().changeRequestSelector?.number).toBe(CHANGE);
  });

  it("refuses a fresh verdict one millisecond past the window as expired, not as stale", async () => {
    const atWindow = clock();
    const terminal = await live({
      ports: fixturePorts({ now: atWindow.now }),
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} revalidate`],
    });
    expect(terminal.selection.entries()[0]?.revalidation).toMatchObject({
      state: "fresh",
      withinWindow: true,
    });
    atWindow.advance(REVALIDATION_WINDOW_MS);
    expect(terminal.selection.entries()[0]?.revalidation?.withinWindow).toBe(true);
    atWindow.advance(1);
    expect(terminal.selection.entries()[0]?.revalidation).toMatchObject({
      state: "fresh",
      withinWindow: false,
    });
    const caught = await expectBindRefusal(terminal.selection, "bind-expired");
    expect(caught.message).toContain(REVALIDATION_WINDOW.name);
    expect(caught.message).toContain(`${REVALIDATION_WINDOW.value} ${REVALIDATION_WINDOW.unit}`);
    expect(caught.message).not.toContain("stale");

    await terminal.selection.dispatch(`${SOURCE_COMMAND_PREFIX} revalidate`);
    expect(terminal.selection.entries()[0]?.revalidation).toMatchObject({
      state: "fresh",
      withinWindow: true,
    });
    const { runner, started } = bindRunner(terminal.selection);
    await runner("create-documentation", BIND_INSTRUCTION);
    expect(started).toEqual([{ workflow: "create-documentation", sourcePaths: [SOURCE_PATH] }]);
  });

  it("refuses the whole run when one of two sources is stale, and still names both", async () => {
    const ports = fixturePorts();
    const terminal = await live({
      ports,
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} refresh`, `${SOURCE_COMMAND_PREFIX} revalidate`],
      between: { 1: () => ports.set(SOURCE_PATH, DRIFTED_SOURCE_BODY) },
    });
    expect(terminal.selection.entries().map((entry) => entry.revalidation?.state)).toEqual([
      "stale",
      "fresh",
    ]);
    await expectBindRefusal(terminal.selection, "bind-stale");
    expect(terminal.selection.requestFields()).toEqual({
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
    });
  });
});
