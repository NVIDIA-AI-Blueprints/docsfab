// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Private sibling journal: one stopped run admits at most one choice and successor. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";

import { inspectProcessBirth } from "../init/storage.js";
import { createContractKit } from "../contract-kit/index.js";
import { hasErrnoCode } from "../shared/primitives.js";
import { runRecordMaxBytes } from "./run-record-limit.js";
import { decodeFirstPassChoice, type FirstPassChoiceV1 } from "./first-pass-choice.js";

interface EventV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-first-pass-choice-claim";
  readonly choice: FirstPassChoiceV1;
  readonly generation: number;
  readonly previousSha256: string | null;
  readonly ownerHost: string;
  readonly ownerPid: number;
  readonly ownerBirthIdentity: string | null;
}

interface ReplaySealV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-first-pass-replay-seal";
  readonly sourceRunId: string;
  readonly replaySha256: string;
  readonly recordSha256: string;
}

export class FirstPassChoiceClaimError extends Error {
  public constructor(public readonly code: "unsafe-store" | "malformed-claim" | "already-claimed") {
    super(`First-pass choice claim failed (${code}).`);
    this.name = "FirstPassChoiceClaimError";
  }
}

function fail(code: FirstPassChoiceClaimError["code"]): never {
  throw new FirstPassChoiceClaimError(code);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const eventKit = createContractKit<"malformed-claim">({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "malformed-claim",
    invalidValue: "malformed-claim",
    digestMismatch: "malformed-claim",
    credentialMaterial: "malformed-claim",
    schemaMismatch: "malformed-claim",
  },
});

function decodeEvent(value: unknown): EventV1 {
  eventKit.assertInert(value);
  eventKit.rejectCredentials(value);
  const root = eventKit.object(value);
  eventKit.exact(root, [
    "schemaVersion",
    "kind",
    "choice",
    "generation",
    "previousSha256",
    "ownerHost",
    "ownerPid",
    "ownerBirthIdentity",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-first-pass-choice-claim" ||
    !Number.isSafeInteger(root.generation) ||
    Number(root.generation) < 0 ||
    !Number.isSafeInteger(root.ownerPid) ||
    Number(root.ownerPid) < 1 ||
    eventKit.string(root.ownerHost).length === 0
  )
    fail("malformed-claim");
  try {
    return {
      schemaVersion: 1,
      kind: "docsfab-first-pass-choice-claim",
      choice: decodeFirstPassChoice(root.choice),
      generation: root.generation as number,
      previousSha256: eventKit.nullableHash(root.previousSha256),
      ownerHost: eventKit.string(root.ownerHost),
      ownerPid: root.ownerPid as number,
      ownerBirthIdentity: eventKit.nullableHash(root.ownerBirthIdentity),
    };
  } catch {
    return fail("malformed-claim");
  }
}

function sameSelection(left: FirstPassChoiceV1, right: FirstPassChoiceV1): boolean {
  return (
    left.sourceRunId === right.sourceRunId &&
    left.sourceRunRecordSha256 === right.sourceRunRecordSha256 &&
    left.repositoryPathSha256 === right.repositoryPathSha256 &&
    left.repositoryRevision === right.repositoryRevision &&
    left.instructionSha256 === right.instructionSha256 &&
    left.contradictionSha256 === right.contradictionSha256 &&
    left.obligationId === right.obligationId &&
    left.optionIndex === right.optionIndex &&
    left.optionSha256 === right.optionSha256 &&
    left.selection === right.selection
  );
}

function ownerAlive(event: EventV1): boolean {
  if (event.ownerHost !== `${process.platform}:${hostname()}`) return true;
  const observed = inspectProcessBirth(event.ownerPid);
  return (
    observed.alive &&
    (event.ownerBirthIdentity === null ||
      observed.identity === undefined ||
      observed.identity === event.ownerBirthIdentity)
  );
}

/** Sibling of the run-store directory: doctor does not classify it as a run record. */
export class FirstPassChoiceClaimStore {
  private readonly directory: string;

  public constructor(
    stateDirectory: string,
    private readonly ownerIsAlive: (event: EventV1) => boolean = ownerAlive,
  ) {
    this.directory = resolve(dirname(stateDirectory), "first-pass-choice-claims");
  }

  private async privateDirectoryIfPresent() {
    const info = await lstat(this.directory).catch((error: unknown) =>
      hasErrnoCode(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (!info) return undefined;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      fail("unsafe-store");
    return info;
  }

  private async privateDirectory() {
    const existing = await this.privateDirectoryIfPresent();
    if (existing) return existing;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const created = await this.privateDirectoryIfPresent();
    if (!created) fail("unsafe-store");
    return created;
  }

  private async journal(sourceRunId: string): Promise<EventV1 | undefined> {
    const key = hash(sourceRunId);
    const names = (await readdir(this.directory))
      .filter((name) => name.startsWith(`${key}.`) && name.endsWith(".json"))
      .sort((a, b) => Number(a.slice(key.length + 1, -5)) - Number(b.slice(key.length + 1, -5)));
    let prior: EventV1 | undefined;
    for (const name of names) {
      const generation = Number(name.slice(key.length + 1, -5));
      if (!Number.isSafeInteger(generation) || generation !== (prior?.generation ?? -1) + 1)
        fail("malformed-claim");
      const path = join(this.directory, name);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size > runRecordMaxBytes().value
      )
        fail("unsafe-store");
      let event: EventV1;
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const pinned = await handle.stat();
          if (pinned.dev !== info.dev || pinned.ino !== info.ino || pinned.size !== info.size)
            fail("unsafe-store");
          const bytes = Buffer.allocUnsafe(info.size + 1);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          const after = await handle.stat();
          if (
            bytesRead !== info.size ||
            after.size !== info.size ||
            after.dev !== info.dev ||
            after.ino !== info.ino
          )
            fail("unsafe-store");
          event = decodeEvent(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof FirstPassChoiceClaimError) throw error;
        fail("malformed-claim");
      }
      if (
        event.generation !== generation ||
        event.choice.sourceRunId !== sourceRunId ||
        event.previousSha256 !== (prior ? hash(JSON.stringify(prior)) : null) ||
        (prior && event.choice.choiceSha256 !== prior.choice.choiceSha256)
      )
        fail("malformed-claim");
      prior = event;
    }
    return prior;
  }

  private replaySealPath(sourceRunId: string): string {
    return join(this.directory, `assessment-${hash(sourceRunId)}.json`);
  }

  /** Bind the saved stop's exact bytes and assessment to producer-private state. */
  public async sealReplay(
    sourceRunId: string,
    replaySha256: string,
    recordSha256: string,
  ): Promise<void> {
    const root = await this.privateDirectory();
    const event: ReplaySealV1 = {
      schemaVersion: 1,
      kind: "docsfab-first-pass-replay-seal",
      sourceRunId,
      replaySha256,
      recordSha256,
    };
    const path = this.replaySealPath(sourceRunId);
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      await handle.sync();
      const current = await lstat(this.directory);
      if (current.dev !== root.dev || current.ino !== root.ino) fail("unsafe-store");
      const pinned = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await pinned.sync();
      } finally {
        await pinned.close();
      }
    } catch (error) {
      if (error instanceof FirstPassChoiceClaimError) throw error;
      fail("unsafe-store");
    } finally {
      await handle?.close();
    }
  }

  /** A self-consistent saved digest cannot replace the producer's observation. */
  public async verifyReplay(
    sourceRunId: string,
    replaySha256: string | undefined,
    recordSha256: string,
  ): Promise<boolean> {
    const directory = await this.privateDirectoryIfPresent();
    if (!directory) return replaySha256 === undefined;
    const path = this.replaySealPath(sourceRunId);
    const info = await lstat(path).catch((error: unknown) =>
      hasErrnoCode(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (!info) return replaySha256 === undefined;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > runRecordMaxBytes().value
    )
      fail("unsafe-store");
    let event: ReplaySealV1;
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const pinned = await handle.stat();
        if (pinned.dev !== info.dev || pinned.ino !== info.ino || pinned.size !== info.size)
          fail("unsafe-store");
        const bytes = Buffer.allocUnsafe(info.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat();
        if (
          bytesRead !== info.size ||
          after.size !== info.size ||
          after.dev !== info.dev ||
          after.ino !== info.ino
        )
          fail("unsafe-store");
        const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
        eventKit.assertInert(parsed);
        eventKit.rejectCredentials(parsed);
        const root = eventKit.object(parsed);
        eventKit.exact(root, [
          "schemaVersion",
          "kind",
          "sourceRunId",
          "replaySha256",
          "recordSha256",
        ]);
        event = {
          schemaVersion: 1,
          kind: "docsfab-first-pass-replay-seal",
          sourceRunId: eventKit.string(root.sourceRunId),
          replaySha256: eventKit.hash(root.replaySha256),
          recordSha256: eventKit.hash(root.recordSha256),
        };
        if (root.schemaVersion !== 1 || root.kind !== event.kind) fail("malformed-claim");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof FirstPassChoiceClaimError) throw error;
      fail("malformed-claim");
    }
    const current = await lstat(this.directory);
    if (current.dev !== directory.dev || current.ino !== directory.ino) fail("unsafe-store");
    return (
      event.sourceRunId === sourceRunId &&
      event.replaySha256 === replaySha256 &&
      event.recordSha256 === recordSha256
    );
  }

  public async inspect(sourceRunId: string): Promise<FirstPassChoiceV1 | undefined> {
    await this.privateDirectory();
    return (await this.journal(sourceRunId))?.choice;
  }

  /** Serialized provenance can execute only against its exact private reservation. */
  public async executionAdmission(
    choice: FirstPassChoiceV1,
    requireCurrentOwner: boolean,
  ): Promise<"matched" | "missing" | "mismatch" | "foreign-owner"> {
    const proposed = decodeFirstPassChoice(choice);
    await this.privateDirectory();
    const prior = await this.journal(proposed.sourceRunId);
    if (!prior) return "missing";
    if (prior.choice.choiceSha256 !== proposed.choiceSha256) return "mismatch";
    if (requireCurrentOwner) {
      const birth = inspectProcessBirth(process.pid).identity;
      if (
        prior.ownerHost !== `${process.platform}:${hostname()}` ||
        prior.ownerPid !== process.pid ||
        birth === undefined ||
        prior.ownerBirthIdentity !== birth
      )
        return "foreign-owner";
    }
    return "matched";
  }

  /** Returns the existing saved child on a duplicate; never invents a second ID. */
  public async claim(input: {
    readonly choice: FirstPassChoiceV1;
    readonly childExists: (id: string) => Promise<boolean>;
  }): Promise<{ readonly kind: "claimed" | "existing-child"; readonly choice: FirstPassChoiceV1 }> {
    const proposed = decodeFirstPassChoice(input.choice);
    const ownerBirthIdentity = inspectProcessBirth(process.pid).identity;
    if (!ownerBirthIdentity) fail("unsafe-store");
    const root = await this.privateDirectory();
    const prior = await this.journal(proposed.sourceRunId);
    if (prior) {
      if (!sameSelection(prior.choice, proposed)) fail("already-claimed");
      if (await input.childExists(prior.choice.successorRunId))
        return { kind: "existing-child", choice: prior.choice };
      if (this.ownerIsAlive(prior)) fail("already-claimed");
    }
    const choice = prior?.choice ?? proposed;
    const event: EventV1 = {
      schemaVersion: 1,
      kind: "docsfab-first-pass-choice-claim",
      choice,
      generation: (prior?.generation ?? -1) + 1,
      previousSha256: prior ? hash(JSON.stringify(prior)) : null,
      ownerHost: `${process.platform}:${hostname()}`,
      ownerPid: process.pid,
      ownerBirthIdentity,
    };
    const key = hash(choice.sourceRunId);
    const target = join(this.directory, `${key}.${event.generation}.json`);
    const temporary = join(this.directory, `.${key}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const current = await lstat(this.directory);
      if (current.dev !== root.dev || current.ino !== root.ino) fail("unsafe-store");
      await link(temporary, target);
      const linkedRoot = await lstat(this.directory);
      if (linkedRoot.dev !== root.dev || linkedRoot.ino !== root.ino) fail("unsafe-store");
      const pinned = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await pinned.sync();
      } finally {
        await pinned.close();
      }
    } catch (error) {
      if (hasErrnoCode(error, "EEXIST")) fail("already-claimed");
      if (error instanceof FirstPassChoiceClaimError) throw error;
      fail("unsafe-store");
    } finally {
      await handle?.close();
      await lstat(this.directory)
        .then((current) =>
          current.dev === root.dev && current.ino === root.ino ? unlink(temporary) : undefined,
        )
        .catch(() => undefined);
    }
    return { kind: "claimed", choice };
  }
}
