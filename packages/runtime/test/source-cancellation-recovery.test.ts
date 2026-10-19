// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cancellation and recovery of a session source purge.
 *
 * A purge is the one `/sources` verb that destroys something, so these cases
 * cover what is true after it stops in the middle; `test/source-purge.test.ts`
 * covers success. Two properties:
 *
 * - Before any byte is deleted, a purge is all-or-nothing. Every named session
 *   is resolved, principal-checked, and writer-checked first, so a condition
 *   found on the third session stops the command with the first two untouched.
 * - After a byte is deleted, nothing is silently lost. A store that stops part
 *   way still deleted something, and that is written to the custody record,
 *   with `incomplete: true` and the copies that remain, before the command
 *   refuses. The refusal says so.
 *
 * Each partial case asserts the store really lost copies, and each atomic case
 * asserts the store was asked to delete nothing, so neither passes vacuously.
 *
 * Fixtures only: no `glab`, no network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { handleSourcesCommand } from "../src/cli/commands/sources.js";
import type { TrackedSourceReaderV1 } from "../src/inputs/source-acquisition.js";
import {
  SOURCE_COMMAND_REFUSALS,
  type LiveAgentSourcePortsV1,
} from "../src/live-agent/source-commands.js";
import {
  SessionSourceRemovalError,
  type SessionSourceCopyV1,
  type SessionSourceCustodyPortV1,
  type SessionSourceInventoryResultV1,
  type SourcePurgeCustodyRecordV1,
} from "../src/live-agent/source-custody.js";
import { initFixtureRepo } from "./helpers/git.js";

const FIRST_SESSION = "recover-2026-09-18-one";
const SECOND_SESSION = "recover-2026-09-18-two";
const THIRD_SESSION = "recover-2026-09-18-three";
const PRINCIPAL = "principal-4417";
const REPOSITORY = "repository-9925";
const SOURCE_PATH = "docs/release-notes.txt";
const SOURCE_BODY = "release notes body THETA-8127\n";
const RUN_ONE = "run-5516";
const RUN_TWO = "run-7038";

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

async function temporaryCheckout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-source-cancel-"));
  temporaryRoots.push(root);
  await initFixtureRepo(root, { [SOURCE_PATH]: SOURCE_BODY }, { branch: "main" });
  return root;
}

/**
 * Four divergent copies: two ordinary, one proved orphan, one transcript. Byte
 * counts all differ, so a partial removal's total cannot coincide with a whole
 * one's, and the orphan is third so a partial stop can land either side of it.
 */
function copies(): SessionSourceCopyV1[] {
  return [
    {
      copyId: "cancel-inventory-1",
      kind: "session-source-inventory",
      bytes: 303,
      runIds: [RUN_ONE],
      orphaned: false,
    },
    {
      copyId: "cancel-projection-2",
      kind: "session-source-projection",
      bytes: 2_048,
      runIds: [RUN_ONE, RUN_TWO],
      orphaned: false,
    },
    {
      copyId: "cancel-orphan-3",
      kind: "parser-temporary",
      bytes: 91_117,
      runIds: [RUN_TWO],
      orphaned: true,
    },
    {
      copyId: "cancel-transcript-4",
      kind: "session-transcript",
      bytes: 5_150,
      runIds: [],
      orphaned: false,
    },
  ];
}

interface StoreInputV1 {
  readonly sessions?: readonly string[];
  readonly activeWriter?: readonly string[];
  /** Sessions whose removal stops after this many copies. */
  readonly stopAfter?: Record<string, number>;
  readonly cancelled?: boolean;
}

type StoreV1 = SessionSourceCustodyPortV1 & {
  readonly removeCalls: string[];
  readonly records: SourcePurgeCustodyRecordV1[];
  readonly held: Map<string, SessionSourceCopyV1[]>;
};

/**
 * A custody store that can stop part way and reports what it did. `stopAfter`
 * is consumed on the first removal for a session, so a second purge finishes,
 * which makes the recovery case a recovery rather than a repeat failure.
 */
function store(input: StoreInputV1 = {}): StoreV1 {
  const removeCalls: string[] = [];
  const records: SourcePurgeCustodyRecordV1[] = [];
  const held = new Map<string, SessionSourceCopyV1[]>();
  const purgedAt = new Map<string, string>();
  const writers = new Set(input.activeWriter ?? []);
  const stopAfter = new Map(Object.entries(input.stopAfter ?? {}));
  for (const sessionId of input.sessions ?? [FIRST_SESSION]) held.set(sessionId, copies());
  return {
    removeCalls,
    records,
    held,
    principal: { principalId: PRINCIPAL, repositoryId: REPOSITORY },
    async inventory(reference: string): Promise<SessionSourceInventoryResultV1> {
      if (!held.has(reference)) return { kind: "unknown" };
      return {
        kind: "resolved",
        inventory: {
          sessionId: reference,
          principal: { principalId: PRINCIPAL, repositoryId: REPOSITORY },
          activeWriter: writers.has(reference),
          copies: [...(held.get(reference) ?? [])],
          retainedScopes: ["run-evidence-records"],
          previouslyPurgedAt: purgedAt.get(reference) ?? null,
        },
      };
    },
    async remove(request) {
      removeCalls.push(request.sessionId);
      const remaining = held.get(request.sessionId) ?? [];
      const targeted = remaining.filter((copy) => request.copyIds.includes(copy.copyId));
      const stop = stopAfter.get(request.sessionId);
      const deleted = stop === undefined ? targeted : targeted.slice(0, stop);
      held.set(
        request.sessionId,
        remaining.filter((copy) => !deleted.includes(copy)),
      );
      if (stop !== undefined) {
        // Consumed: the next attempt on this session finishes.
        stopAfter.delete(request.sessionId);
        throw new SessionSourceRemovalError(
          deleted,
          targeted.slice(stop),
          input.cancelled === true,
        );
      }
      return deleted;
    },
    async record(record) {
      records.push(record);
      purgedAt.set(record.sessionId, record.at);
    },
  };
}

function ports(custody: StoreV1): LiveAgentSourcePortsV1 & { readonly reads: string[] } {
  const contents = new Map([[SOURCE_PATH, SOURCE_BODY]]);
  const reader: TrackedSourceReaderV1 = {
    async isTrackedRegularFile(repositoryPath: string) {
      return contents.has(repositoryPath);
    },
    async readTrackedBytes(repositoryPath: string, maxBytes: number) {
      const value = contents.get(repositoryPath);
      if (value === undefined) throw new Error("not tracked");
      return encoder.encode(value).slice(0, maxBytes);
    },
  };
  return {
    reads: [],
    custody,
    entryPoint: "cli",
    withTrackedSourceReader: <T>(use: (open: TrackedSourceReaderV1) => Promise<T>) => use(reader),
  };
}

async function run(input: {
  root: string;
  ports: LiveAgentSourcePortsV1;
  argv: readonly string[];
}) {
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

function confirmationFrom(text: string): string {
  const matched = /\bConfirmation:\s*(\S+)/u.exec(text.replace(/\n[ \t]*/gu, " "));
  expect(matched, text).not.toBeNull();
  return (matched as RegExpExecArray)[1] as string;
}

describe("a purge that stops part way admits what it deleted", () => {
  it("records the deleted copies and the remaining ones before it refuses", async () => {
    const root = await temporaryCheckout();
    const custody = store({ stopAfter: { [FIRST_SESSION]: 2 } });
    const wired = ports(custody);
    const preview = await run({ root, ports: wired, argv: ["purge", FIRST_SESSION] });
    const result = await run({
      root,
      ports: wired,
      argv: ["purge", FIRST_SESSION, confirmationFrom(preview.text)],
    });
    expect(result.refused).toBe(true);
    expect(result.text).toContain(SOURCE_COMMAND_REFUSALS["purge-incomplete"]);
    expect(result.text).toContain("Selection: Unchanged.");
    expect(result.text).not.toContain("Outcome: No source selection was changed.");
    // Not vacuous: the store really lost the first two copies.
    expect(custody.held.get(FIRST_SESSION)?.map((copy) => copy.copyId)).toEqual([
      "cancel-orphan-3",
      "cancel-transcript-4",
    ]);
    // The admission exists, and it is honest about both halves.
    expect(custody.records).toHaveLength(1);
    const record = custody.records[0] as SourcePurgeCustodyRecordV1;
    expect(record.incomplete).toBe(true);
    expect(record.removed.map((copy) => copy.copyId)).toEqual([
      "cancel-inventory-1",
      "cancel-projection-2",
    ]);
    expect(record.notRemoved.map((copy) => copy.copyId)).toEqual([
      "cancel-orphan-3",
      "cancel-transcript-4",
    ]);
    // The refusal names the record, so the admission is findable from the
    // sentence the operator actually read.
    expect(result.text).toContain(record.recordId);
    expect(result.text).toContain("2 of 4 owned copies were deleted");
    expect(result.text).toContain(
      "What was deleted has already been written to the custody record",
    );
  }, 180_000);

  it("says a cancelled removal was cancelled rather than reporting it as a failure", async () => {
    const root = await temporaryCheckout();
    const custody = store({ stopAfter: { [FIRST_SESSION]: 1 }, cancelled: true });
    const wired = ports(custody);
    const preview = await run({ root, ports: wired, argv: ["purge", FIRST_SESSION] });
    const result = await run({
      root,
      ports: wired,
      argv: ["purge", FIRST_SESSION, confirmationFrom(preview.text)],
    });
    expect(result.refused).toBe(true);
    expect(result.text).toContain(
      "1 of 4 owned copies were deleted before the purge was cancelled",
    );
    expect(custody.records[0]?.incomplete).toBe(true);
    // A cancellation is still a deletion, so it is recorded: the record makes
    // recovery resumable from a known point.
    expect(custody.records[0]?.removed).toHaveLength(1);
    expect(custody.records[0]?.notRemoved).toHaveLength(3);
  }, 180_000);

  it("finishes the deletion and writes a second admission when the purge is run again", async () => {
    const root = await temporaryCheckout();
    const custody = store({ stopAfter: { [FIRST_SESSION]: 2 } });
    const wired = ports(custody);
    const first = await run({ root, ports: wired, argv: ["purge", FIRST_SESSION] });
    await run({
      root,
      ports: wired,
      argv: ["purge", FIRST_SESSION, confirmationFrom(first.text)],
    });
    // The recovery. A fresh preview over what is left mints its own
    // confirmation; the earlier one no longer describes this session.
    const second = await run({ root, ports: wired, argv: ["purge", FIRST_SESSION] });
    expect(second.text).toContain("Owned local copies: 2");
    const stale = await run({
      root,
      ports: wired,
      argv: ["purge", FIRST_SESSION, confirmationFrom(first.text)],
    });
    expect(stale.refused).toBe(true);
    expect(stale.text).toContain("Selection: Unchanged.");
    expect(stale.text).toContain(`ATTENTION: ${SOURCE_COMMAND_REFUSALS["purge-not-confirmed"]}`);
    const finished = await run({
      root,
      ports: wired,
      argv: ["purge", FIRST_SESSION, confirmationFrom(second.text)],
    });
    expect(finished.refused).toBe(false);
    expect(custody.held.get(FIRST_SESSION)).toEqual([]);
    // Two admissions, not one rewritten: the first says what the interrupted
    // attempt removed and the second says what finished it.
    expect(custody.records).toHaveLength(2);
    expect(custody.records[0]?.incomplete).toBe(true);
    expect(custody.records[1]?.incomplete).toBe(false);
    expect(custody.records[1]?.removed.map((copy) => copy.copyId)).toEqual([
      "cancel-orphan-3",
      "cancel-transcript-4",
    ]);
    expect(custody.records[0]?.recordId).not.toBe(custody.records[1]?.recordId);
  }, 180_000);

  it("leaves the sessions named after the interrupted one untouched", async () => {
    const root = await temporaryCheckout();
    const custody = store({
      sessions: [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION],
      stopAfter: { [SECOND_SESSION]: 1 },
    });
    const wired = ports(custody);
    const names = [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION].join(",");
    const preview = await run({ root, ports: wired, argv: ["purge", names] });
    const result = await run({
      root,
      ports: wired,
      argv: ["purge", names, confirmationFrom(preview.text)],
    });
    expect(result.refused).toBe(true);
    expect(result.text).toContain("The sessions named after this one were not touched.");
    // The first completed, the second stopped part way, the third was never
    // asked for. Each of the three is asserted rather than inferred.
    expect(custody.held.get(FIRST_SESSION)).toEqual([]);
    expect(custody.held.get(SECOND_SESSION)).toHaveLength(3);
    expect(custody.held.get(THIRD_SESSION)).toHaveLength(4);
    expect(custody.removeCalls).toEqual([FIRST_SESSION, SECOND_SESSION]);
    expect(custody.records.map((record) => record.sessionId)).toEqual([
      FIRST_SESSION,
      SECOND_SESSION,
    ]);
    expect(custody.records[0]?.incomplete).toBe(false);
    expect(custody.records[1]?.incomplete).toBe(true);
  }, 180_000);
});

describe("a purge refused before any deletion deletes nothing at all", () => {
  it("stops the whole command when a later session is held by a writer", async () => {
    const root = await temporaryCheckout();
    const custody = store({
      sessions: [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION],
      activeWriter: [THIRD_SESSION],
    });
    const wired = ports(custody);
    const names = [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION].join(",");
    const result = await run({ root, ports: wired, argv: ["purge", names] });
    expect(result.refused).toBe(true);
    expect(result.text).toContain("Selection: Unchanged.");
    expect(result.text).toContain(`ATTENTION: ${SOURCE_COMMAND_REFUSALS["session-active-writer"]}`);
    // Every session is checked before any is deleted, so a condition on the
    // third session leaves the first two untouched.
    expect(custody.removeCalls).toEqual([]);
    expect(custody.records).toEqual([]);
    for (const sessionId of [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION]) {
      expect(custody.held.get(sessionId), sessionId).toHaveLength(4);
    }
  }, 180_000);

  it("stops the whole command when a later session is unknown", async () => {
    const root = await temporaryCheckout();
    const custody = store({ sessions: [FIRST_SESSION, SECOND_SESSION] });
    const wired = ports(custody);
    const result = await run({
      root,
      ports: wired,
      argv: ["purge", [FIRST_SESSION, SECOND_SESSION, "recover-never-existed"].join(",")],
    });
    expect(result.refused).toBe(true);
    expect(result.text).toContain("Selection: Unchanged.");
    expect(result.text).toContain(
      `ATTENTION: ${SOURCE_COMMAND_REFUSALS["unknown-session-reference"]}`,
    );
    expect(custody.removeCalls).toEqual([]);
    expect(custody.held.get(FIRST_SESSION)).toHaveLength(4);
    expect(custody.held.get(SECOND_SESSION)).toHaveLength(4);
  }, 180_000);

  it("reports a proved orphan parser temporary as one and deletes it with the rest", async () => {
    const root = await temporaryCheckout();
    const custody = store();
    const wired = ports(custody);
    const preview = await run({ root, ports: wired, argv: ["purge", FIRST_SESSION] });
    // An orphan is a fact the store proved, reported apart from the copies it did
    // not prove orphaned. An inactive-looking directory proves nothing, so the
    // preview relays the store's assertion rather than deriving one.
    expect(preview.text).toContain(
      "cancel-orphan-3: parser-temporary; 91117 bytes; proved orphan;",
    );
    expect(preview.text).not.toContain(
      "cancel-transcript-4: session-transcript; 5150 bytes; proved orphan;",
    );
    const purged = await run({
      root,
      ports: wired,
      argv: ["purge", FIRST_SESSION, confirmationFrom(preview.text)],
    });
    expect(purged.refused).toBe(false);
    expect(custody.records[0]?.removed.map((copy) => copy.copyId)).toContain("cancel-orphan-3");
  }, 180_000);
});
