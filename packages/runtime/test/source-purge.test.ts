// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session source purge and its custody record: preview and confirmation,
 * affected run IDs and remaining retention scope, removal versus cache
 * invalidation versus purge semantics, no claim of external-provider erasure,
 * and no purge the model can invoke.
 *
 * Rules that keep it from passing vacuously:
 *
 * - Both sides are shipped entry points: `runTerminalConversation` over a
 *   scripted input stream, and `handleSourcesCommand`, which
 *   `src/cli/router.ts` calls. Nothing here calls the dispatcher or
 *   `renderSourceCommandOutcome` to build an expectation.
 * - Every coded sentence is read from the shipped tables
 *   (`SOURCE_COMMAND_REFUSALS`, `SOURCE_STATE_OPERATION_MESSAGES`,
 *   `SOURCE_PURGE_RETENTION_NOTE`) and asserted in the bytes an entry point
 *   wrote, not in a returned object a renderer might never print.
 * - The destructive claims carry positive controls. The same ledger assertion
 *   applies to a detach, which must write no custody record, and to a purge,
 *   which must. A second purge must be a no-op, so the first purge's removal is
 *   asserted to have happened.
 * - The confirmation is never minted by this file: every confirming case reads
 *   the token out of the bytes the shipped preview printed.
 * - Fixtures diverge: copy ids, run ids, byte counts, session ids, the two
 *   principals and the two repositories all differ from each other.
 *
 * Fixtures only: no `glab`, no network, and no custody store is wired into any
 * shipped host, which is itself asserted here.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { handleSourcesCommand } from "../src/cli/commands/sources.js";
import { findPublicCommand } from "../src/cli/command-registry.js";
import { limit } from "../src/config/limits.js";
import type { TrackedSourceReaderV1 } from "../src/inputs/source-acquisition.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { createLiveAgentSourcePorts, runTerminalConversation } from "../src/live-agent/host.js";
import {
  createLiveAgentSourceSelection,
  SOURCE_COMMAND_PREFIX,
  SOURCE_COMMAND_REFUSALS,
  type LiveAgentSourcePortsV1,
  type LiveAgentSourceSelection,
  type SourceCommandOutcomeV1,
} from "../src/live-agent/source-commands.js";
import {
  SESSION_SOURCE_COPY_KINDS,
  SESSION_SOURCE_COPY_KIND_MESSAGES,
  SOURCE_PURGE_MAX_SESSIONS_LIMIT,
  SOURCE_PURGE_PREVIEW_MAX_ROWS_LIMIT,
  SOURCE_PURGE_RETENTION_NOTE,
  SOURCE_STATE_OPERATIONS,
  SOURCE_STATE_OPERATION_MESSAGES,
  SessionSourceRemovalError,
  type SessionSourceCopyV1,
  type SessionSourceCustodyPortV1,
  type SessionSourceInventoryResultV1,
  type SessionSourceInventoryV1,
  type SourcePurgeCustodyRecordV1,
} from "../src/live-agent/source-custody.js";
import { initFixtureRepo } from "./helpers/git.js";

/**
 * Both purge bounds, read through the same `limit()` seam the dispatcher reads
 * and never retyped, so the test follows the catalog.
 */
const MAX_SESSIONS = limit(SOURCE_PURGE_MAX_SESSIONS_LIMIT);
const PREVIEW_MAX_ROWS = limit(SOURCE_PURGE_PREVIEW_MAX_ROWS_LIMIT);

const SESSION = "live-2026-09-18-alpha";
const OTHER_SESSION = "live-2026-09-18-bravo";
const PRINCIPAL = "principal-7741";
const OTHER_PRINCIPAL = "principal-2209";
const REPOSITORY = "repository-5563";
const OTHER_REPOSITORY = "repository-8814";
const SOURCE_PATH = "docs/release-notes.txt";
const SECOND_SOURCE_PATH = "docs/upgrade-guide.txt";
const SOURCE_BODY = "release notes body ZETA-3380\n";
const SECOND_SOURCE_BODY = "upgrade guide body ETA-6194\n";
const RUN_ONE = "run-3301";
const RUN_TWO = "run-9942";

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
  const root = await mkdtemp(join(tmpdir(), "docsfab-source-purge-"));
  temporaryRoots.push(root);
  await initFixtureRepo(root, files, { branch: "main" });
  return root;
}

function trackedReader(files: Record<string, string>): TrackedSourceReaderV1 {
  const contents = new Map(Object.entries(files));
  return {
    async isTrackedRegularFile(repositoryPath: string) {
      return contents.has(repositoryPath);
    },
    async readTrackedBytes(repositoryPath: string, maxBytes: number) {
      const value = contents.get(repositoryPath);
      if (value === undefined) throw new Error("not tracked");
      return encoder.encode(value).slice(0, maxBytes);
    },
  };
}

/** Divergent copies: byte counts, kinds and run references that cannot be confused. */
function fixtureCopies(): SessionSourceCopyV1[] {
  return [
    {
      copyId: "copy-inventory-1",
      kind: "session-source-inventory",
      bytes: 411,
      runIds: [RUN_ONE],
      orphaned: false,
    },
    {
      copyId: "copy-projection-2",
      kind: "session-source-projection",
      bytes: 1_270,
      runIds: [RUN_ONE, RUN_TWO],
      orphaned: false,
    },
    {
      copyId: "copy-parser-3",
      kind: "parser-temporary",
      bytes: 58_903,
      runIds: [RUN_TWO],
      orphaned: true,
    },
    {
      copyId: "copy-transcript-4",
      kind: "session-transcript",
      bytes: 7_004,
      runIds: [],
      orphaned: false,
    },
  ];
}

interface FixtureCustodyInputV1 {
  readonly sessions?: Record<string, Partial<SessionSourceInventoryV1>>;
  readonly principalId?: string;
  readonly repositoryId?: string;
  /** References this store reports as matching more than one session. */
  readonly ambiguous?: Record<string, number>;
  /** Throw part way through a removal, having removed this many copies. */
  readonly failRemovalAfter?: number;
  readonly cancelRemoval?: boolean;
}

type FixtureCustodyV1 = SessionSourceCustodyPortV1 & {
  readonly inventoryCalls: string[];
  readonly removeCalls: { sessionId: string; copyIds: readonly string[] }[];
  readonly records: SourcePurgeCustodyRecordV1[];
  readonly held: Map<string, SessionSourceCopyV1[]>;
};

/**
 * A custody store that holds copies, deletes exactly what it is asked for, and
 * records what it did.
 *
 * `held` is the store's own state, so "the copies are gone" is asserted against
 * what the store holds afterwards rather than against the command's own report
 * of itself. A second purge then reads an empty session for a real reason.
 */
function fixtureCustody(input: FixtureCustodyInputV1 = {}): FixtureCustodyV1 {
  const inventoryCalls: string[] = [];
  const removeCalls: { sessionId: string; copyIds: readonly string[] }[] = [];
  const records: SourcePurgeCustodyRecordV1[] = [];
  const held = new Map<string, SessionSourceCopyV1[]>();
  const purgedAt = new Map<string, string>();
  const declared = input.sessions ?? { [SESSION]: {} };
  const overrides = new Map(Object.entries(declared));
  for (const [sessionId, override] of overrides) {
    held.set(sessionId, [...(override.copies ?? fixtureCopies())]);
  }
  return {
    inventoryCalls,
    removeCalls,
    records,
    held,
    principal: {
      principalId: input.principalId ?? PRINCIPAL,
      repositoryId: input.repositoryId ?? REPOSITORY,
    },
    async inventory(reference: string): Promise<SessionSourceInventoryResultV1> {
      inventoryCalls.push(reference);
      const matches = input.ambiguous?.[reference];
      if (matches !== undefined) return { kind: "ambiguous", matches };
      const override = overrides.get(reference);
      if (!override) return { kind: "unknown" };
      return {
        kind: "resolved",
        inventory: {
          sessionId: reference,
          principal: {
            principalId: override.principal?.principalId ?? PRINCIPAL,
            repositoryId: override.principal?.repositoryId ?? REPOSITORY,
          },
          activeWriter: override.activeWriter ?? false,
          copies: [...(held.get(reference) ?? [])],
          retainedScopes: override.retainedScopes ?? [
            "run-evidence-records",
            "operator-owned-files",
          ],
          previouslyPurgedAt: purgedAt.get(reference) ?? null,
        },
      };
    },
    async remove(request) {
      removeCalls.push({ sessionId: request.sessionId, copyIds: [...request.copyIds] });
      const remaining = held.get(request.sessionId) ?? [];
      const targeted = remaining.filter((copy) => request.copyIds.includes(copy.copyId));
      const stopAfter = input.failRemovalAfter;
      const deleted = stopAfter === undefined ? targeted : targeted.slice(0, stopAfter);
      held.set(
        request.sessionId,
        remaining.filter((copy) => !deleted.includes(copy)),
      );
      if (stopAfter !== undefined) {
        throw new SessionSourceRemovalError(
          deleted,
          targeted.slice(stopAfter),
          input.cancelRemoval === true,
        );
      }
      purgedAt.set(request.sessionId, "2026-09-18T19:00:00.000Z");
      return deleted;
    },
    async record(record) {
      records.push(record);
      purgedAt.set(record.sessionId, record.at);
    },
  };
}

interface FixturePortsInputV1 extends FixtureCustodyInputV1 {
  readonly custody?: FixtureCustodyV1 | false;
  readonly entryPoint?: "live-terminal" | "cli" | false;
  readonly sessionId?: string;
  readonly now?: () => number;
}

type FixturePortsV1 = LiveAgentSourcePortsV1 & {
  readonly reads: string[];
  readonly store: FixtureCustodyV1 | undefined;
};

function fixturePorts(input: FixturePortsInputV1 = {}): FixturePortsV1 {
  const store = input.custody === false ? undefined : (input.custody ?? fixtureCustody(input));
  const reader = trackedReader({
    [SOURCE_PATH]: SOURCE_BODY,
    [SECOND_SOURCE_PATH]: SECOND_SOURCE_BODY,
  });
  return {
    reads: [],
    store,
    ...(store ? { custody: store } : {}),
    ...(input.entryPoint === false ? {} : { entryPoint: input.entryPoint ?? "live-terminal" }),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.now ? { now: input.now } : {}),
    withTrackedSourceReader: <T>(use: (open: TrackedSourceReaderV1) => Promise<T>) => use(reader),
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("The scripted terminal line was never consumed.");
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

/** Drive the shipped conversation loop over a scripted input stream. */
async function driveTerminal(input: {
  selection: LiveAgentSourceSelection;
  lines: readonly string[];
}): Promise<{ blocks: readonly string[]; outcomes: readonly SourceCommandOutcomeV1[] }> {
  const stream = new PassThrough();
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 100,
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
  for (const line of input.lines) {
    const before = consumed;
    stream.write(`${line}\n`);
    await waitUntil(() => consumed > before);
  }
  stream.write("/exit\n");
  await conversation;
  return { blocks, outcomes };
}

/** Run the live entry point over one seeded selection and a script of lines. */
async function live(input: {
  ports: FixturePortsV1;
  sourcePaths?: readonly string[];
  lines: readonly string[];
}) {
  const selection = createLiveAgentSourceSelection({
    ...(input.sourcePaths?.length ? { sourcePaths: input.sourcePaths } : {}),
    ports: input.ports,
  });
  const terminal = await driveTerminal({ selection, lines: input.lines });
  return { selection, ...terminal };
}

/** Run the command-line entry point over one verb. */
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
 * The confirmation the shipped preview printed, read out of the rendered bytes.
 * A token computed with `sourcePurgeConfirmation` would agree with itself no
 * matter what the operator was shown.
 */
function confirmationFrom(text: string): string {
  const normalized = text.replace(/\n[ \t]*/gu, " ");
  const matched = /\bConfirmation:\s*(\S+)/u.exec(normalized);
  expect(matched, text).not.toBeNull();
  return (matched as RegExpExecArray)[1] as string;
}

/** The terminal write that is one whole purge rendering. */
function purgeBlock(blocks: readonly string[]): string {
  const found = blocks.filter(
    (block) => block.startsWith("Source Purge Authorization") || block.startsWith("Purged "),
  );
  expect(found.length, JSON.stringify(blocks)).toBeGreaterThan(0);
  return (found[found.length - 1] as string).replace(/\n[ \t]*/gu, " ");
}

describe("session source purge is host-invoked only", () => {
  it("names the source command in no live tool definition or capability list", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "docsfab-purge-tools-"));
    temporaryRoots.push(workspace);
    const live = createLiveAgentToolDefinitions({
      allowWrite: true,
      capabilities: { skills: [], qualityPack: {} as never, workflows: [] },
      attachedSources: [SOURCE_PATH, SECOND_SOURCE_PATH],
      async runWorkflow() {
        throw new Error("No workflow runs in this assertion.");
      },
    });
    const confined = await createConfinedToolSet({ workspacePath: workspace, allowWrite: true });
    const surface = JSON.stringify([
      ...live.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      ...confined.definitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    ]);
    // The claim: nothing a model can read names this verb or its family, so no
    // model output can reach the dispatcher by naming it.
    expect(surface).not.toContain("purge");
    expect(surface).not.toContain(SOURCE_COMMAND_PREFIX);
    // Positive control. Two empty tool lists would satisfy both assertions
    // above, so the serialization is proved to be a populated one that does
    // name the tools a live session really exposes.
    expect(live.length).toBeGreaterThan(0);
    expect(confined.definitions.length).toBeGreaterThan(0);
    expect(surface).toContain("docsfab_run_workflow");
    expect(surface).toContain("read");
  }, 120_000);

  it("wires no custody store into either shipped host, and says so rather than pretending", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    // The ports the shipped `docsfab sources` and `docsfab live-agent` build.
    const ports = createLiveAgentSourcePorts({
      repositoryPath: root,
      environment: {},
      entryPoint: "cli",
    });
    expect(ports.custody).toBeUndefined();
    const result = await cli({ root, ports: ports as FixturePortsV1, argv: ["purge", SESSION] });
    expect(result.refused).toBe(true);
    expect(result.text).toContain(SOURCE_COMMAND_REFUSALS["custody-unavailable"]);
    expect(result.text).toContain("No deletion happened and none is claimed.");
  }, 120_000);

  it("refuses a purge when a custody store is wired without an entry point to record", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({ entryPoint: false });
    const result = await cli({ root, ports, argv: ["purge", SESSION] });
    expect(result.refused).toBe(true);
    expect(result.text).toContain(SOURCE_COMMAND_REFUSALS["entry-point-unrecorded"]);
    // Nothing was read, so the refusal's own claim is true.
    expect(ports.store?.inventoryCalls).toEqual([]);
    expect(ports.store?.removeCalls).toEqual([]);
  }, 120_000);
});

describe("session source purge previews before it deletes", () => {
  it("previews the copies, the runs and the retention without deleting anything", async () => {
    const ports = fixturePorts();
    const session = await live({ ports, lines: [`${SOURCE_COMMAND_PREFIX} purge ${SESSION}`] });
    const block = purgeBlock(session.blocks);
    expect(block).toContain("Purge preview for 1 session.");
    expect(block).toContain("No copies have been deleted.");
    // Every copy, its kind and its own sentence.
    for (const copy of fixtureCopies()) {
      expect(block).toContain(copy.copyId);
      expect(block).toContain(SESSION_SOURCE_COPY_KIND_MESSAGES[copy.kind]);
    }
    // The proved orphan is marked as one rather than folded in with the rest.
    expect(block).toContain("copy-parser-3: parser-temporary; 58903 bytes; proved orphan");
    // Affected runs, de-duplicated: RUN_ONE is referenced by two copies.
    expect(block).toContain(`Affected runs: ${RUN_ONE}, ${RUN_TWO}`);
    expect(block).toContain("Retained scopes: run-evidence-records, operator-owned-files");
    // The retention statement, verbatim from the shipped constant.
    expect(block).toContain(SOURCE_PURGE_RETENTION_NOTE);
    expect(block).toContain("DocsFab claims no erasure by any external model provider.");
    // It read, and it deleted nothing: the store still holds every copy and
    // was never asked to remove one.
    expect(ports.store?.inventoryCalls).toEqual([SESSION]);
    expect(ports.store?.removeCalls).toEqual([]);
    expect(ports.store?.records).toEqual([]);
    expect(ports.store?.held.get(SESSION)).toHaveLength(fixtureCopies().length);
  }, 120_000);

  it("prints the three operations apart from each other in the preview", async () => {
    const ports = fixturePorts();
    const session = await live({ ports, lines: [`${SOURCE_COMMAND_PREFIX} purge ${SESSION}`] });
    const block = purgeBlock(session.blocks);
    // Walked from the shipped enumeration, so a fourth operation, or a renamed
    // one, fails here rather than being paraphrased into the preview.
    for (const operation of SOURCE_STATE_OPERATIONS) {
      expect(block, operation).toContain(`${operation}:`);
      expect(block, operation).toContain(SOURCE_STATE_OPERATION_MESSAGES[operation]);
    }
    // The distinction that matters, in the shipped words: only one of the three
    // deletes, and only one is recorded.
    expect(block).toContain("It deletes no bytes anywhere, it writes no custody record");
    expect(block).toContain(
      "It is the only one of the three that deletes anything, the only one that is confirmed, and the only one that is recorded.",
    );
  }, 120_000);

  it("deletes and records only against the confirmation its own preview printed", async () => {
    const ports = fixturePorts({ sessionId: SESSION });
    const session = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} purge ${SESSION}`],
    });
    const confirmation = confirmationFrom(purgeBlock(session.blocks));
    const confirmed = await driveTerminal({
      selection: session.selection,
      lines: [`${SOURCE_COMMAND_PREFIX} purge ${SESSION} ${confirmation}`],
    });
    const block = purgeBlock(confirmed.blocks);
    expect(block).toContain("Purged 1 session");
    expect(block).toContain("4 owned local copies deleted; 67588 bytes.");
    expect(block).toContain("purge detaches nothing");
    // The store really lost them.
    expect(ports.store?.held.get(SESSION)).toEqual([]);
    expect(ports.store?.removeCalls).toEqual([
      { sessionId: SESSION, copyIds: fixtureCopies().map((copy) => copy.copyId) },
    ]);
    // Exactly one custody record, carrying what, when, why, by which entry
    // point, and under which principal.
    expect(ports.store?.records).toHaveLength(1);
    const record = ports.store?.records[0] as SourcePurgeCustodyRecordV1;
    expect(record.kind).toBe("docsfab-session-source-purge-custody-record");
    expect(record.sessionId).toBe(SESSION);
    expect(record.operation).toBe("purge");
    expect(record.reason).toBe("operator-requested");
    expect(record.entryPoint).toBe("live-terminal");
    expect(record.principal).toEqual({ principalId: PRINCIPAL, repositoryId: REPOSITORY });
    expect(record.removed.map((copy) => copy.copyId)).toEqual(
      fixtureCopies().map((copy) => copy.copyId),
    );
    expect(record.notRemoved).toEqual([]);
    expect(record.incomplete).toBe(false);
    expect(record.affectedRunIds).toEqual([RUN_ONE, RUN_TWO]);
    expect(record.retainedScopes).toEqual(["run-evidence-records", "operator-owned-files"]);
    expect(record.confirmation).toBe(confirmation);
    expect(record.retentionNote).toBe(SOURCE_PURGE_RETENTION_NOTE);
    expect(Date.parse(record.at)).not.toBeNaN();
    // The receipt names the record and the instant, so an operator can find the
    // admission and knows when the deletion happened. The instant is the one
    // value the byte-equivalence differential has to freeze, and asserting it is
    // really rendered is what stops that freeze from hiding a missing field.
    expect(block).toContain(record.recordId);
    expect(block).toContain(record.at);
  }, 120_000);

  it("refuses a confirmation that no longer matches what the session holds", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts();
    const preview = await cli({ root, ports, argv: ["purge", SESSION] });
    const confirmation = confirmationFrom(preview.text);
    // The session gains a copy between the preview and the confirmation, which
    // is the case the token exists for: confirming now would delete something
    // the operator never read.
    ports.store?.held.get(SESSION)?.push({
      copyId: "copy-arrived-later-5",
      kind: "parser-temporary",
      bytes: 22,
      runIds: [RUN_TWO],
      orphaned: false,
    });
    const refused = await cli({ root, ports, argv: ["purge", SESSION, confirmation] });
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain(SOURCE_COMMAND_REFUSALS["purge-not-confirmed"]);
    expect(ports.store?.removeCalls).toEqual([]);
    expect(ports.store?.records).toEqual([]);
    // Positive control for the token itself: the *unchanged* inventory's token
    // does confirm, so the refusal above is about the change and not about
    // every confirmation being rejected.
    const second = await cli({ root, ports, argv: ["purge", SESSION] });
    const current = await cli({
      root,
      ports,
      argv: ["purge", SESSION, confirmationFrom(second.text)],
    });
    expect(current.refused).toBe(false);
    expect(ports.store?.records).toHaveLength(1);
    expect(confirmationFrom(second.text)).not.toBe(confirmation);
  }, 120_000);
});

describe("session source purge is distinct from removal and from cache invalidation", () => {
  it("writes no custody record when a source is merely detached", async () => {
    const ports = fixturePorts({ sessionId: SESSION });
    const session = await live({
      ports,
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      lines: [`${SOURCE_COMMAND_PREFIX} remove ${SOURCE_PATH}`],
    });
    // The positive control for the whole distinction: a detach changed what the
    // conversation binds and touched the custody store not at all.
    expect(session.selection.entries().map((entry) => entry.label)).toEqual([SECOND_SOURCE_PATH]);
    expect(ports.store?.records).toEqual([]);
    expect(ports.store?.removeCalls).toEqual([]);
    expect(ports.store?.inventoryCalls).toEqual([]);
    expect(ports.store?.held.get(SESSION)).toHaveLength(fixtureCopies().length);
  }, 120_000);

  it("invalidates this conversation's derivatives without detaching anything", async () => {
    const ports = fixturePorts({ sessionId: SESSION });
    const session = await live({
      ports,
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
      lines: [
        `${SOURCE_COMMAND_PREFIX} refresh`,
        `${SOURCE_COMMAND_PREFIX} revalidate`,
        `${SOURCE_COMMAND_PREFIX} purge ${SESSION}`,
      ],
    });
    // The derivatives exist before the purge, so their absence afterwards is a
    // change rather than a state they were always in.
    const before = session.selection.entries();
    expect(before.every((entry) => entry.version !== null)).toBe(true);
    expect(before.every((entry) => entry.revalidation !== null)).toBe(true);
    const confirmation = confirmationFrom(purgeBlock(session.blocks));
    await driveTerminal({
      selection: session.selection,
      lines: [`${SOURCE_COMMAND_PREFIX} purge ${SESSION} ${confirmation}`],
    });
    const after = session.selection.entries();
    // Not detached: same membership, same order, same labels.
    expect(after.map((entry) => entry.label)).toEqual([SOURCE_PATH, SECOND_SOURCE_PATH]);
    // Invalidated: the derived fields are gone and the limitation is explicit,
    // so a later read resolves to "unavailable" rather than to silence.
    expect(after.every((entry) => entry.version === null)).toBe(true);
    expect(after.every((entry) => entry.revalidation === null)).toBe(true);
    expect(after.every((entry) => entry.limitations.includes("owned-local-copy-purged"))).toBe(
      true,
    );
    // The run request still binds both sources: a purge deletes bodies and does
    // not silently rewrite what the next run would read.
    expect(session.selection.requestFields()).toEqual({
      sourcePaths: [SOURCE_PATH, SECOND_SOURCE_PATH],
    });
  }, 120_000);

  it("leaves this conversation untouched when some other session is purged", async () => {
    const ports = fixturePorts({
      sessionId: SESSION,
      sessions: { [OTHER_SESSION]: {} },
    });
    const session = await live({
      ports,
      sourcePaths: [SOURCE_PATH],
      lines: [
        `${SOURCE_COMMAND_PREFIX} refresh`,
        `${SOURCE_COMMAND_PREFIX} purge ${OTHER_SESSION}`,
      ],
    });
    const confirmation = confirmationFrom(purgeBlock(session.blocks));
    await driveTerminal({
      selection: session.selection,
      lines: [`${SOURCE_COMMAND_PREFIX} purge ${OTHER_SESSION} ${confirmation}`],
    });
    // Another session's deletion says nothing about what this one holds, so
    // this conversation's derivatives are not invalidated on that basis.
    const [entry] = session.selection.entries();
    expect(entry?.version).not.toBeNull();
    expect(entry?.limitations).not.toContain("owned-local-copy-purged");
    expect(ports.store?.records).toHaveLength(1);
    expect(ports.store?.records[0]?.sessionId).toBe(OTHER_SESSION);
  }, 120_000);
});

describe("session source purge is idempotent and refuses loudly on ambiguity", () => {
  it("states a second purge as a no-op and writes no second custody record", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts();
    const preview = await cli({ root, ports, argv: ["purge", SESSION] });
    const first = await cli({
      root,
      ports,
      argv: ["purge", SESSION, confirmationFrom(preview.text)],
    });
    expect(first.refused).toBe(false);
    // The precondition: the first purge really removed something. Without this
    // the no-op below would hold over a session that never held anything.
    expect(ports.store?.records).toHaveLength(1);
    expect(ports.store?.held.get(SESSION)).toEqual([]);
    const second = await cli({ root, ports, argv: ["purge", SESSION] });
    expect(second.refused).toBe(false);
    expect(second.text).toContain("Nothing to purge in 1 named session");
    expect(second.text).toContain("No copy was deleted and no custody record was written.");
    // Which of the two no-op facts applies is stated, not left to be inferred.
    expect(second.text).toContain(`Previously purged: ${ports.store?.records[0]?.at}`);
    expect(ports.store?.records).toHaveLength(1);
    expect(ports.store?.removeCalls).toHaveLength(1);
    // A stale confirmation against an empty session is the same stated no-op,
    // not a mismatch refusal: there is nothing to authorize.
    const third = await cli({
      root,
      ports,
      argv: ["purge", SESSION, confirmationFrom(preview.text)],
    });
    expect(third.refused).toBe(false);
    expect(third.text).toContain("Nothing to purge in 1 named session");
    expect(ports.store?.records).toHaveLength(1);
  }, 120_000);

  it("separates a session that never held a copy from one an earlier purge emptied", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({ sessions: { [SESSION]: { copies: [] } } });
    const result = await cli({ root, ports, argv: ["purge", SESSION] });
    expect(result.text).toContain(`${SESSION}\n`);
    expect(result.text).toContain("Owned local copies: 0");
    expect(result.text).not.toContain("already purged at");
  }, 120_000);

  it("refuses an ambiguous, unknown or malformed session reference before reading anything", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ambiguous = fixturePorts({ ambiguous: { "live-2026": 3 } });
    const byPrefix = await cli({ root, ports: ambiguous, argv: ["purge", "live-2026"] });
    expect(byPrefix.refused).toBe(true);
    expect(byPrefix.text).toContain(SOURCE_COMMAND_REFUSALS["ambiguous-session-reference"]);
    expect(byPrefix.text).toContain("That reference matches 3 sessions.");
    expect(ambiguous.store?.removeCalls).toEqual([]);

    const unknown = fixturePorts();
    const missing = await cli({ root, ports: unknown, argv: ["purge", "live-nobody-held-this"] });
    expect(missing.refused).toBe(true);
    expect(missing.text).toContain(SOURCE_COMMAND_REFUSALS["unknown-session-reference"]);
    // Named apart from the already-purged no-op, in the shipped words.
    expect(missing.text).toContain("this is not a statement that the session was already purged");

    const malformed = fixturePorts();
    const shaped = await cli({ root, ports: malformed, argv: ["purge", "live/../etc/passwd"] });
    expect(shaped.refused).toBe(true);
    expect(shaped.text).toContain(SOURCE_COMMAND_REFUSALS["invalid-session-reference"]);
    // Refused on shape, so the store never saw the text.
    expect(malformed.store?.inventoryCalls).toEqual([]);
  }, 120_000);

  it("refuses a session held by another principal or bound to another repository", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const otherPrincipal = fixturePorts({
      sessions: {
        [SESSION]: { principal: { principalId: OTHER_PRINCIPAL, repositoryId: REPOSITORY } },
      },
    });
    const byPrincipal = await cli({ root, ports: otherPrincipal, argv: ["purge", SESSION] });
    expect(byPrincipal.refused).toBe(true);
    expect(byPrincipal.text).toContain(SOURCE_COMMAND_REFUSALS["session-principal-mismatch"]);
    expect(byPrincipal.text).toContain(
      "The recorded principal is not the one this command is running as.",
    );
    expect(otherPrincipal.store?.removeCalls).toEqual([]);

    const otherRepository = fixturePorts({
      sessions: {
        [SESSION]: { principal: { principalId: PRINCIPAL, repositoryId: OTHER_REPOSITORY } },
      },
    });
    const byRepository = await cli({ root, ports: otherRepository, argv: ["purge", SESSION] });
    expect(byRepository.refused).toBe(true);
    // The two mismatches share a code and are told apart by the detail, so an
    // operator is not sent to the wrong fix.
    expect(byRepository.text).toContain(
      "The recorded repository is not the one this command is running against.",
    );
    expect(otherRepository.store?.removeCalls).toEqual([]);
  }, 120_000);

  it("refuses a session a writer still holds rather than racing it", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({ sessions: { [SESSION]: { activeWriter: true } } });
    const result = await cli({ root, ports, argv: ["purge", SESSION] });
    expect(result.refused).toBe(true);
    expect(result.text).toContain(SOURCE_COMMAND_REFUSALS["session-active-writer"]);
    expect(result.text).toContain("a saved handle and a directory that looks inactive");
    expect(ports.store?.removeCalls).toEqual([]);
    expect(ports.store?.records).toEqual([]);
  }, 120_000);
});

describe("session source purge bounds", () => {
  const manySessions = (count: number): Record<string, Partial<SessionSourceInventoryV1>> =>
    Object.fromEntries(
      Array.from({ length: count }, (_unused, index) => [
        `live-bounded-${String(index).padStart(3, "0")}`,
        {},
      ]),
    );

  it("purges exactly the maximum sessions one invocation names", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const sessions = manySessions(MAX_SESSIONS.value);
    const ports = fixturePorts({ sessions });
    const names = Object.keys(sessions).join(",");
    const preview = await cli({ root, ports, argv: ["purge", names] });
    expect(preview.refused).toBe(false);
    expect(preview.text).toContain(`Purge preview for ${MAX_SESSIONS.value} sessions.`);
    const purged = await cli({
      root,
      ports,
      argv: ["purge", names, confirmationFrom(preview.text)],
    });
    expect(purged.refused).toBe(false);
    // One custody record per session: the admission is per session, because a
    // single record over several would not say which one lost which copies.
    expect(ports.store?.records).toHaveLength(MAX_SESSIONS.value);
    expect(ports.store?.records.map((record) => record.sessionId).sort()).toEqual(
      Object.keys(sessions).sort(),
    );
  }, 180_000);

  it("refuses one more than the maximum before reading anything", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const sessions = manySessions(MAX_SESSIONS.value + 1);
    const ports = fixturePorts({ sessions });
    const result = await cli({ root, ports, argv: ["purge", Object.keys(sessions).join(",")] });
    expect(result.refused).toBe(true);
    expect(result.text).toContain(SOURCE_COMMAND_REFUSALS["too-many-sessions"]);
    // The coded refusal names the limit, the observed value and the remediation,
    // which is the shape `AGENTS.md` requires of a bound refusal. Both numbers
    // come from the catalog rather than from a literal in this file.
    expect(result.text).toContain(
      `This purge names ${MAX_SESSIONS.value + 1} sessions and one invocation deletes at most ${MAX_SESSIONS.value} (${MAX_SESSIONS.name}).`,
    );
    // The refusal's own claim, executed: nothing was read.
    expect(ports.store?.inventoryCalls).toEqual([]);
    expect(ports.store?.removeCalls).toEqual([]);
    expect(ports.store?.records).toEqual([]);
  }, 180_000);

  const rows = (count: number): SessionSourceCopyV1[] =>
    Array.from({ length: count }, (_unused, index) => ({
      copyId: `copy-row-${String(index).padStart(4, "0")}`,
      kind: SESSION_SOURCE_COPY_KINDS[index % SESSION_SOURCE_COPY_KINDS.length] as never,
      bytes: index + 1,
      runIds: [RUN_ONE],
      orphaned: false,
    }));

  it("prints exactly the maximum preview rows with no withheld-row line", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const ports = fixturePorts({
      sessions: { [SESSION]: { copies: rows(PREVIEW_MAX_ROWS.value) } },
    });
    const preview = await cli({ root, ports, argv: ["purge", SESSION] });
    expect(preview.text).toContain(
      `copy-row-${String(PREVIEW_MAX_ROWS.value - 1).padStart(4, "0")}`,
    );
    expect(preview.text).not.toContain("not printed here");
  }, 180_000);

  it("flags the withheld rows in the operator summary rather than clipping them silently", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const overBound = rows(PREVIEW_MAX_ROWS.value + 1);
    const ports = fixturePorts({ sessions: { [SESSION]: { copies: overBound } } });
    const preview = await cli({ root, ports, argv: ["purge", SESSION] });
    const withheld = overBound[overBound.length - 1] as SessionSourceCopyV1;
    // The row is not printed...
    expect(preview.text).not.toContain(withheld.copyId);
    // ...and the operator is told so, by name and by count, with the limit.
    expect(preview.text).toContain("Copy rows not printed: 1");
    expect(preview.text).toContain(
      `At most ${PREVIEW_MAX_ROWS.value} copy rows per session are printed (${PREVIEW_MAX_ROWS.name}).`,
    );
    expect(preview.text).toContain(
      "Every unprinted row remains counted above and included in the exact confirmation.",
    );
    // The count printed above the rows is the whole set, not the printed subset.
    expect(preview.text).toContain(`Owned local copies: ${overBound.length}`);
    // And the confirmation covers the withheld row: purging deletes it too.
    const purged = await cli({
      root,
      ports,
      argv: ["purge", SESSION, confirmationFrom(preview.text)],
    });
    expect(purged.refused).toBe(false);
    expect(ports.store?.held.get(SESSION)).toEqual([]);
    expect(ports.store?.records[0]?.removed.some((copy) => copy.copyId === withheld.copyId)).toBe(
      true,
    );
  }, 180_000);
});

describe("the shipped source command surface names purge honestly", () => {
  it("no longer claims the sources command only reads", () => {
    const command = findPublicCommand("sources");
    expect(command).toEqual({
      name: "sources",
      description: "Inspect and manage the sources one invocation binds.",
      // Purge deletes owned local copies and appends a durable record, so a
      // read-only catalog entry would be false exactly where a reader looks to
      // find out whether a command can destroy something.
      readOnly: false,
    });
  });

  it("records the entry point of the surface that performed the purge", async () => {
    const root = await temporaryCheckout({ [SOURCE_PATH]: SOURCE_BODY });
    const fromCli = fixturePorts({ entryPoint: "cli" });
    const cliPreview = await cli({ root, ports: fromCli, argv: ["purge", SESSION] });
    await cli({
      root,
      ports: fromCli,
      argv: ["purge", SESSION, confirmationFrom(cliPreview.text)],
    });

    const fromTerminal = fixturePorts({ entryPoint: "live-terminal" });
    const session = await live({
      ports: fromTerminal,
      lines: [`${SOURCE_COMMAND_PREFIX} purge ${SESSION}`],
    });
    await driveTerminal({
      selection: session.selection,
      lines: [
        `${SOURCE_COMMAND_PREFIX} purge ${SESSION} ${confirmationFrom(purgeBlock(session.blocks))}`,
      ],
    });

    expect(fromCli.store?.records[0]?.entryPoint).toBe("cli");
    expect(fromTerminal.store?.records[0]?.entryPoint).toBe("live-terminal");
    // The two records differ in exactly that field and agree on the rest, which
    // is what "recorded but never rendered" has to mean.
    expect(fromCli.store?.records[0]?.removed).toEqual(fromTerminal.store?.records[0]?.removed);
    expect(fromCli.store?.records[0]?.confirmation).toBe(
      fromTerminal.store?.records[0]?.confirmation,
    );
  }, 180_000);
});
