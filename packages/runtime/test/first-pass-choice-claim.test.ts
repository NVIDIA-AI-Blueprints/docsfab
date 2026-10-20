// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processStorage from "../src/init/storage.js";
import { createFirstPassChoice, decodeFirstPassChoice } from "../src/records/first-pass-choice.js";
import { FirstPassChoiceClaimStore } from "../src/records/first-pass-choice-store.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
afterEach(() => vi.restoreAllMocks());

function choice(successorRunId: string, optionIndex = 0, obligationId = "target-01") {
  return createFirstPassChoice({
    sourceRunId: "source-run",
    sourceRunRecordSha256: "a".repeat(64),
    successorRunId,
    repositoryPathSha256: "b".repeat(64),
    repositoryRevision: "c".repeat(40),
    instructionSha256: "d".repeat(64),
    contradictionSha256: "e".repeat(64),
    obligationId,
    optionIndex,
    optionSha256: optionIndex === 0 ? "f".repeat(64) : "1".repeat(64),
    selection: "side",
    selectedAt: "2026-10-14T00:00:00.000Z",
  });
}

describe("private first-pass choice claims", () => {
  it("reads an absent legacy seal without creating a directory and refuses an unsealed replay", async () => {
    const root = await roots.create("first-pass-choice-unsealed-");
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory);
    const store = new FirstPassChoiceClaimStore(stateDirectory);
    const recordSha256 = "a".repeat(64);
    expect(await store.verifyReplay("source-run", undefined, recordSha256)).toBe(true);
    expect(await store.verifyReplay("source-run", "b".repeat(64), recordSha256)).toBe(false);
    expect(await readdir(root)).toEqual(["runs"]);
  });

  it("refuses an unavailable process birth identity before creating or consuming a claim", async () => {
    const root = await roots.create("first-pass-choice-unknown-birth-");
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory);
    vi.spyOn(processStorage, "inspectProcessBirth").mockReturnValue({ alive: true });
    const childExists = vi.fn(async () => false);
    await expect(
      new FirstPassChoiceClaimStore(stateDirectory).claim({
        choice: choice("child-one"),
        childExists,
      }),
    ).rejects.toMatchObject({ code: "unsafe-store" });
    expect(childExists).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["runs"]);
  });

  it("leaves an existing claim unchanged when this process has no stable birth identity", async () => {
    const root = await roots.create("first-pass-choice-retained-birth-");
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory);
    const store = new FirstPassChoiceClaimStore(stateDirectory);
    await store.claim({ choice: choice("child-one"), childExists: async () => false });
    const directory = join(root, "first-pass-choice-claims");
    const names = await readdir(directory);
    const original = await readFile(join(directory, names[0]!), "utf8");
    const birth = vi.spyOn(processStorage, "inspectProcessBirth").mockReturnValue({ alive: true });
    const childExists = vi.fn(async () => true);
    await expect(store.claim({ choice: choice("child-two"), childExists })).rejects.toMatchObject({
      code: "unsafe-store",
    });
    expect(childExists).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(names);
    expect(await readFile(join(directory, names[0]!), "utf8")).toBe(original);
    birth.mockRestore();
    expect(await store.executionAdmission(choice("child-one"), true)).toBe("matched");
  });

  it("retains the original obligation identity without imposing a run-file grammar", () => {
    const selected = choice("child-one", 0, "port:service/listen");
    expect(decodeFirstPassChoice(JSON.parse(JSON.stringify(selected))).obligationId).toBe(
      "port:service/listen",
    );
  });

  it("reuses the exact child after a dead owner without granting a different choice", async () => {
    const root = await roots.create("first-pass-choice-claim-");
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory);
    const first = new FirstPassChoiceClaimStore(stateDirectory);
    expect(
      await first.claim({ choice: choice("child-one"), childExists: async () => false }),
    ).toMatchObject({ kind: "claimed", choice: { successorRunId: "child-one" } });
    await expect(
      first.claim({ choice: choice("child-two"), childExists: async () => false }),
    ).rejects.toMatchObject({ code: "already-claimed" });
    const recovered = new FirstPassChoiceClaimStore(stateDirectory, () => false);
    expect(
      await recovered.claim({ choice: choice("child-two"), childExists: async () => false }),
    ).toMatchObject({ kind: "claimed", choice: { successorRunId: "child-one" } });
    expect(
      await recovered.claim({ choice: choice("child-three"), childExists: async () => true }),
    ).toMatchObject({ kind: "existing-child", choice: { successorRunId: "child-one" } });
    await expect(
      recovered.claim({ choice: choice("child-four", 1), childExists: async () => false }),
    ).rejects.toMatchObject({ code: "already-claimed" });
  });

  it("refuses a symlinked sibling claim directory", async () => {
    const root = await roots.create("first-pass-choice-symlink-");
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory);
    await symlink(stateDirectory, join(root, "first-pass-choice-claims"));
    await expect(
      new FirstPassChoiceClaimStore(stateDirectory).claim({
        choice: choice("child-one"),
        childExists: async () => false,
      }),
    ).rejects.toMatchObject({ code: "unsafe-store" });
  });
});
