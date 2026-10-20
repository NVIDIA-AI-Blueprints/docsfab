// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-only StudyEventV1 log. Same 0700/0600 policy as raw run records.
 * Created only when `--study` is on.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalJson } from "../contract-kit/index.js";
import {
  ensurePrivateRunDirectory,
  FileRunStoreError,
  type FileRunStoreErrorCode,
} from "./file-store.js";
import { assertRunNotTombstoned, withRunMaintenanceGate } from "./run-maintenance-gate.js";
import {
  createStudyEvent,
  createStudyRun,
  parseStudyRun,
  strongerObservationMode,
  summarizeStudyRun,
  type CreateStudyEventInput,
  type StudyEventV1,
  type StudyModelRefV1,
  type StudyObservationMode,
  type StudyRunSummary,
  type StudyRunV1,
} from "./study-event.js";

const PRIVATE_FILE_MODE = 0o600;
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Machine codes; FileRunStoreError already emits a path-free sentence. */
function _failStore(code: FileRunStoreErrorCode): never {
  throw new FileRunStoreError(code);
}

export function studyDirectory(stateDirectory: string): string {
  return resolve(stateDirectory, "study");
}

export interface StudySessionOptions {
  readonly directory: string;
  readonly now?: () => Date;
  readonly id?: () => string;
}

export interface StudyRunIdentity {
  readonly runId: string;
  readonly observationMode: StudyObservationMode;
  readonly modelRef: StudyModelRefV1;
}

export class StudySession {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private log: StudyRunV1 | undefined;

  public constructor(options: StudySessionOptions) {
    this.directory = resolve(options.directory);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  public summary(): StudyRunSummary | undefined {
    return this.log ? summarizeStudyRun(this.log) : undefined;
  }

  public snapshot(): StudyRunV1 | undefined {
    return this.log;
  }

  public async ensureRun(identity: StudyRunIdentity): Promise<StudyRunV1> {
    if (!SAFE_RECORD_ID.test(identity.runId)) {
      _failStore("unsafe-record-id");
    }
    await ensurePrivateRunDirectory(this.directory);
    if (!this.log) {
      this.log = createStudyRun({
        runId: identity.runId,
        observationMode: identity.observationMode,
        modelRef: identity.modelRef,
        events: [],
      });
      await this.persist();
      return this.log;
    }
    if (this.log.runId !== identity.runId) {
      _failStore("unsafe-record-id");
    }
    const observationMode = strongerObservationMode(
      this.log.observationMode,
      identity.observationMode,
    );
    if (observationMode !== this.log.observationMode) {
      this.log = createStudyRun({
        runId: this.log.runId,
        observationMode,
        modelRef: this.log.modelRef,
        events: this.log.events,
      });
      await this.persist();
    }
    return this.log;
  }

  public async recordSettlement(
    input: Omit<CreateStudyEventInput, "t"> & { readonly t?: string },
  ): Promise<StudyEventV1> {
    if (!this.log) {
      _failStore("write-failed");
    }
    const event = createStudyEvent({
      ...input,
      t: input.t ?? this.now().toISOString(),
    });
    this.log = createStudyRun({
      runId: this.log.runId,
      observationMode: this.log.observationMode,
      modelRef: this.log.modelRef,
      events: [...this.log.events, event],
    });
    await this.persist();
    return event;
  }

  private async persist(): Promise<void> {
    if (!this.log) _failStore("write-failed");
    await writePrivateStudyRun(this.directory, this.log, this.id);
  }
}

export async function readStudyRun(directory: string, runId: string): Promise<StudyRunV1> {
  if (!SAFE_RECORD_ID.test(runId)) {
    _failStore("unsafe-record-id");
  }
  const handle = await open(
    join(resolve(directory), `${runId}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const bytes = await handle.readFile("utf8");
    return parseStudyRun(JSON.parse(bytes) as unknown);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writePrivateStudyRun(
  directory: string,
  run: StudyRunV1,
  id: () => string,
): Promise<void> {
  const stateDirectory = dirname(resolve(directory));
  await withRunMaintenanceGate(stateDirectory, async () => {
    await assertRunNotTombstoned(stateDirectory, run.runId);
    await writePrivateStudyRunUnderGate(directory, run, id);
  });
}

async function writePrivateStudyRunUnderGate(
  directory: string,
  run: StudyRunV1,
  id: () => string,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(`${canonicalJson(run)}\n`, "utf8");
  } catch {
    _failStore("serialization-failed");
  }
  await ensurePrivateRunDirectory(directory);
  const destination = join(directory, `${run.runId}.json`);
  const temporaryId = id();
  if (!SAFE_RECORD_ID.test(temporaryId)) {
    _failStore("unsafe-entry");
  }
  const temporary = join(directory, `.${run.runId}.${temporaryId}.tmp`);
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    temporaryCreated = true;
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    assertPrivateFile(await handle.stat());
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    temporaryCreated = false;
    assertPrivateFile(await lstat(destination));
  } catch (error) {
    if (error instanceof FileRunStoreError) throw error;
    _failStore("write-failed");
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function assertPrivateFile(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== PRIVATE_FILE_MODE) {
    _failStore("unsafe-entry");
  }
}
