// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnswerRecordContinuationClaimStore,
  AnswerRecordContinuationStoreError,
} from "../src/records/answer-record-continuation-store.js";

const sha = (letter: string): string => letter.repeat(64);

describe("answer-record continuation claims", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "docsfab-answer-continuation-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("atomically allows one child for an exact source checkpoint", async () => {
    const store = new AnswerRecordContinuationClaimStore(
      root,
      () => new Date("2026-10-10T00:00:00.000Z"),
      () => "claim-1",
    );
    const input = {
      sourceRunId: "source-run",
      sourceRunRecordSha256: sha("a"),
      checkpointSha256: sha("b"),
      checkpointSequence: 4,
      checkpointAttempt: 2,
      logicalRunId: "logical-run",
      childRunId: "child-run-1",
    };
    const results = await Promise.allSettled([
      store.claim(input),
      new AnswerRecordContinuationClaimStore(root, undefined, () => "claim-2").claim({
        ...input,
        childRunId: "child-run-2",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status !== "rejected") throw new Error("Expected one duplicate claim.");
    expect(rejection.reason).toBeInstanceOf(AnswerRecordContinuationStoreError);
    expect(rejection.reason).toMatchObject({
      code: "already-claimed",
      existingChildRunId: expect.stringMatching(/^child-run-[12]$/u),
    });
  });

  it("removes an unpublished temporary claim after a pre-link failure", async () => {
    const store = new AnswerRecordContinuationClaimStore(
      root,
      () => new Date("2026-10-10T00:00:00.000Z"),
      () => "claim-1",
      {
        beforeLink: () => {
          throw new Error("injected-before-link");
        },
      },
    );
    await expect(
      store.claim({
        sourceRunId: "source-run",
        sourceRunRecordSha256: sha("a"),
        checkpointSha256: sha("b"),
        checkpointSequence: 4,
        checkpointAttempt: 2,
        logicalRunId: "logical-run",
        childRunId: "child-run",
      }),
    ).rejects.toMatchObject({ code: "claim-write-failed" });
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a symlink as the claim root", async () => {
    const target = join(root, "target");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias);
    const store = new AnswerRecordContinuationClaimStore(alias);
    await expect(
      store.inspect({
        sourceRunId: "source-run",
        sourceRunRecordSha256: sha("a"),
        checkpointSha256: sha("b"),
        checkpointSequence: 4,
        checkpointAttempt: 2,
        logicalRunId: "logical-run",
      }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
  });

  it("recovers an orphaned claim by appending a generation for the same child", async () => {
    const input = {
      sourceRunId: "source-run",
      sourceRunRecordSha256: sha("a"),
      checkpointSha256: sha("b"),
      checkpointSequence: 4,
      checkpointAttempt: 2,
      logicalRunId: "logical-run",
      childRunId: "child-run",
    };
    const abandoned = new AnswerRecordContinuationClaimStore(
      root,
      () => new Date("2026-10-10T00:00:00.000Z"),
      () => "claim-abandoned",
      {
        ownerPid: () => 2_147_483_000,
        ownerHost: () => "test-host",
        ownerIsAlive: () => false,
      },
    );
    await abandoned.claim(input);
    const recovered = new AnswerRecordContinuationClaimStore(
      root,
      () => new Date("2026-10-10T00:01:00.000Z"),
      () => "claim-recovered",
      {
        ownerPid: () => 100,
        ownerHost: () => "test-host",
        ownerIsAlive: () => false,
      },
    );

    const event = await recovered.claim(input);

    expect(event).toMatchObject({
      generation: 1,
      childRunId: "child-run",
      claimId: "claim-recovered",
    });
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });

  it("does not reclaim a claim owned by a live process", async () => {
    const input = {
      sourceRunId: "source-run",
      sourceRunRecordSha256: sha("a"),
      checkpointSha256: sha("b"),
      checkpointSequence: 4,
      checkpointAttempt: 2,
      logicalRunId: "logical-run",
      childRunId: "child-run",
    };
    await new AnswerRecordContinuationClaimStore(root, undefined, () => "claim-1", {
      ownerPid: () => 10,
      ownerHost: () => "test-host",
      ownerIsAlive: () => true,
    }).claim(input);

    await expect(
      new AnswerRecordContinuationClaimStore(root, undefined, () => "claim-2", {
        ownerIsAlive: () => true,
      }).claim(input),
    ).rejects.toMatchObject({ code: "already-claimed", existingChildRunId: "child-run" });
  });

  it("allows only one concurrent reclaimer to append the next generation", async () => {
    const input = {
      sourceRunId: "source-run",
      sourceRunRecordSha256: sha("a"),
      checkpointSha256: sha("b"),
      checkpointSequence: 4,
      checkpointAttempt: 2,
      logicalRunId: "logical-run",
      childRunId: "child-run",
    };
    await new AnswerRecordContinuationClaimStore(root, undefined, () => "claim-old", {
      ownerPid: () => 2_147_483_000,
      ownerHost: () => "test-host",
      ownerIsAlive: () => false,
    }).claim(input);
    const makeReclaimer = (claimId: string) =>
      new AnswerRecordContinuationClaimStore(root, undefined, () => claimId, {
        ownerPid: () => 100,
        ownerHost: () => "test-host",
        ownerIsAlive: (pid) => pid !== 2_147_483_000,
      });

    const outcomes = await Promise.allSettled([
      makeReclaimer("claim-next-a").claim(input),
      makeReclaimer("claim-next-b").claim(input),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });

  it("refuses a journal whose prior event no longer matches the next event digest", async () => {
    const input = {
      sourceRunId: "source-run",
      sourceRunRecordSha256: sha("a"),
      checkpointSha256: sha("b"),
      checkpointSequence: 4,
      checkpointAttempt: 2,
      logicalRunId: "logical-run",
      childRunId: "child-run",
    };
    const store = new AnswerRecordContinuationClaimStore(root, undefined, () => "claim-event", {
      ownerPid: () => 2_147_483_000,
      ownerHost: () => "test-host",
      ownerIsAlive: () => false,
    });
    await store.claim(input);
    await store.claim(input);
    const firstEvent = (await readdir(root)).find((name) => name.endsWith(".0.json"));
    if (!firstEvent) throw new Error("Expected generation zero event.");
    const path = join(root, firstEvent);
    const event = JSON.parse(await readFile(path, "utf8")) as { claimedAt: string };
    event.claimedAt = "2026-10-10T00:05:00.000Z";
    await writeFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });

    await expect(store.inspect(input)).rejects.toMatchObject({ code: "malformed-claim" });
  });
});
