// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  assertExpectedVersion,
  emptyState,
  makeEvent,
  reduceEvent,
  replayEvents,
} from "./model.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

class PrivateKnowledgeStateError extends Error {
  code = "private-state-unsafe";
  nextAction = "Stop writers, back up the complete state parent, repair or move the owned state, then retry.";

  constructor(path) {
    super(`Private knowledge state is unsafe at ${path}. Stop writers, back up and repair or move the owned state, or select a fresh private root. Retained files have not been removed.`);
    this.name = "PrivateKnowledgeStateError";
  }
}

function missing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function currentUid(path) {
  if (typeof process.getuid !== "function" || typeof constants.O_NOFOLLOW !== "number" ||
      typeof constants.O_DIRECTORY !== "number") throw new PrivateKnowledgeStateError(path);
  return process.getuid();
}

async function osAlias(candidate) {
  if (process.platform !== "darwin" || (candidate !== "/var" && candidate !== "/tmp")) return false;
  return (await realpath(candidate).catch(() => "")) === `/private${candidate}`;
}

function ancestors(target) {
  const result = [];
  let cursor = path.resolve(target);
  while (true) {
    result.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return result.reverse();
}

function within(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function ensurePrivateDirectory(target, privateFrom = target) {
  const absolute = path.resolve(target);
  const boundary = path.resolve(privateFrom);
  if (!within(absolute, boundary)) throw new PrivateKnowledgeStateError(absolute);
  const uid = currentUid(absolute);
  const pins = [];
  for (const candidate of ancestors(absolute)) {
    let entry = await lstat(candidate).catch((error) => {
      if (missing(error)) return undefined;
      throw error;
    });
    const created = !entry;
    if (created) {
      await mkdir(candidate, { mode: PRIVATE_DIRECTORY_MODE });
      entry = await lstat(candidate);
    }
    const alias = entry.isSymbolicLink() && await osAlias(candidate);
    if ((entry.isSymbolicLink() && !alias) || (!entry.isSymbolicLink() && !entry.isDirectory())) {
      throw new PrivateKnowledgeStateError(candidate);
    }
    if (created || within(candidate, boundary)) {
      if (entry.isSymbolicLink() || entry.uid !== uid ||
          (entry.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
        throw new PrivateKnowledgeStateError(candidate);
      }
      const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const descriptor = await handle.stat();
        if (descriptor.dev !== entry.dev || descriptor.ino !== entry.ino ||
            descriptor.uid !== entry.uid || descriptor.mode !== entry.mode) {
          throw new PrivateKnowledgeStateError(candidate);
        }
      } finally {
        await handle.close();
      }
    }
    pins.push({ candidate, dev: entry.dev, ino: entry.ino, uid: entry.uid, mode: entry.mode, symlink: entry.isSymbolicLink() });
  }
  for (const pin of pins) {
    const entry = await lstat(pin.candidate).catch(() => { throw new PrivateKnowledgeStateError(pin.candidate); });
    if (entry.dev !== pin.dev || entry.ino !== pin.ino || entry.uid !== pin.uid ||
        entry.mode !== pin.mode || entry.isSymbolicLink() !== pin.symlink ||
        (pin.symlink && !(await osAlias(pin.candidate)))) throw new PrivateKnowledgeStateError(pin.candidate);
  }
}

function privateFileIdentity(entry, file) {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
      entry.uid !== currentUid(file) || (entry.mode & 0o7777) !== PRIVATE_FILE_MODE) {
    throw new PrivateKnowledgeStateError(file);
  }
  return { dev: entry.dev, ino: entry.ino, uid: entry.uid, mode: entry.mode };
}

async function inspectPrivateFile(file) {
  const entry = await lstat(file).catch((error) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!entry) return undefined;
  const pin = privateFileIdentity(entry, file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptor = privateFileIdentity(await handle.stat(), file);
    if (descriptor.dev !== pin.dev || descriptor.ino !== pin.ino ||
        descriptor.uid !== pin.uid || descriptor.mode !== pin.mode) throw new PrivateKnowledgeStateError(file);
    return pin;
  } finally {
    await handle.close();
  }
}

async function assertSameFile(file, expected) {
  const current = await inspectPrivateFile(file);
  if ((!expected && current) || (expected && !current) ||
      (expected && current && (expected.dev !== current.dev || expected.ino !== current.ino ||
        expected.uid !== current.uid || expected.mode !== current.mode))) {
    throw new PrivateKnowledgeStateError(file);
  }
}

async function openPrivateFile(file, flags, expected) {
  const pin = await inspectPrivateFile(file);
  if (!pin || (expected && (pin.dev !== expected.dev || pin.ino !== expected.ino))) {
    throw new PrivateKnowledgeStateError(file);
  }
  const handle = await open(file, flags | constants.O_NOFOLLOW);
  try {
    const descriptor = privateFileIdentity(await handle.stat(), file);
    if (descriptor.dev !== pin.dev || descriptor.ino !== pin.ino) throw new PrivateKnowledgeStateError(file);
    await assertSameFile(file, pin);
    return { handle, identity: pin };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function createPrivateFile(file) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    const identity = privateFileIdentity(await handle.stat(), file);
    await handle.sync();
    await assertSameFile(file, identity);
    return identity;
  } finally {
    await handle.close();
  }
}

async function replacePrivateFile(directory, destination, content, privateFrom = directory) {
  await ensurePrivateDirectory(directory, privateFrom);
  const before = await inspectPrivateFile(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await ensurePrivateDirectory(directory, privateFrom);
    await assertSameFile(destination, before);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function clone(value) {
  return structuredClone(value);
}

function requireSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a safe path segment`);
  }
  return value;
}

function parseEventLog(content, source) {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    if (line.trim() === "") throw new Error(`${source} contains a blank record at line ${index + 1}`);
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${source} contains invalid JSON at line ${index + 1}`, { cause: error });
    }
  });
}

export class KnowledgeStore {
  #artifactsPath;
  #events = [];
  #eventsPath;
  #eventsIdentity;
  #fatalError = null;
  #initialized = false;
  #queue = Promise.resolve();
  #state = emptyState();

  constructor(dataDirectory) {
    if (typeof dataDirectory !== "string" || dataDirectory.trim() === "") {
      throw new Error("An explicit data directory is required");
    }
    this.dataDirectory = path.resolve(dataDirectory);
    this.#eventsPath = path.join(this.dataDirectory, "events.jsonl");
    this.#artifactsPath = path.join(this.dataDirectory, "artifacts");
  }

  async initialize() {
    if (this.#initialized) throw new Error("Store is already initialized");
    await ensurePrivateDirectory(this.dataDirectory);
    await ensurePrivateDirectory(this.#artifactsPath, this.dataDirectory);
    let content;
    let identity = await inspectPrivateFile(this.#eventsPath);
    if (!identity) {
      identity = await createPrivateFile(this.#eventsPath);
      content = "";
    } else {
      const opened = await openPrivateFile(this.#eventsPath, constants.O_RDONLY);
      try {
        content = await opened.handle.readFile("utf8");
      } finally {
        await opened.handle.close();
      }
    }
    const events = parseEventLog(content, this.#eventsPath);
    this.#state = replayEvents(events);
    this.#events = events;
    this.#eventsIdentity = identity;
    this.#initialized = true;
    return this.getState();
  }

  getState() {
    this.#assertInitialized();
    return clone(this.#state);
  }

  getEvents() {
    this.#assertInitialized();
    return clone(this.#events);
  }

  health() {
    return {
      ok: this.#initialized && this.#fatalError === null,
      initialized: this.#initialized,
      version: this.#initialized ? this.#state.version : null,
      fatalError: this.#fatalError?.message ?? null,
    };
  }

  execute(expectedVersion, actor, buildSpecification) {
    if (typeof buildSpecification !== "function") {
      throw new Error("Command must provide an event specification builder");
    }
    const operation = this.#queue.then(async () => {
      this.#assertWritable();
      assertExpectedVersion(this.#state, expectedVersion);
      const specification = await buildSpecification(clone(this.#state), this);
      const event = makeEvent(this.#state, specification, { actor });
      const nextState = reduceEvent(this.#state, event);
      await this.#appendEvent(event);
      this.#events.push(event);
      this.#state = nextState;
      return { event: clone(event), state: clone(nextState) };
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async writeArtifact(projectId, artifactId, extension, content) {
    this.#assertWritable();
    const safeProjectId = requireSegment(projectId, "Project id");
    const safeArtifactId = requireSegment(artifactId, "Artifact id");
    const safeExtension = requireSegment(extension, "Artifact extension");
    if (typeof content !== "string") throw new Error("Artifact content must be a string");
    const projectPath = path.join(this.#artifactsPath, safeProjectId);
    await ensurePrivateDirectory(projectPath, this.dataDirectory);
    const filename = `${safeArtifactId}.${safeExtension}`;
    const finalPath = path.join(projectPath, filename);
    await replacePrivateFile(projectPath, finalPath, content, this.dataDirectory);
    return {
      path: path.relative(this.dataDirectory, finalPath),
      digest: createHash("sha256").update(content, "utf8").digest("hex"),
    };
  }

  /** Write a fixed-name first-pass support file beside events.jsonl. */
  async writePrivateFile(filename, content) {
    this.#assertWritable();
    const safeFilename = requireSegment(filename, "Knowledge filename");
    if (typeof content !== "string") throw new Error("Knowledge content must be a string");
    await replacePrivateFile(this.dataDirectory, path.join(this.dataDirectory, safeFilename), content);
  }

  #assertInitialized() {
    if (!this.#initialized) throw new Error("Store is not initialized");
  }

  #assertWritable() {
    this.#assertInitialized();
    if (this.#fatalError) {
      throw new Error("Store is unhealthy after a durability failure", { cause: this.#fatalError });
    }
  }

  async #appendEvent(event) {
    let handle;
    try {
      await ensurePrivateDirectory(this.dataDirectory);
      const opened = await openPrivateFile(this.#eventsPath, constants.O_WRONLY | constants.O_APPEND, this.#eventsIdentity);
      handle = opened.handle;
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
      await handle.close();
    } catch (error) {
      this.#fatalError = error;
      if (handle) {
        try {
          await handle.close();
        } catch (closeError) {
          throw new AggregateError([error, closeError], "Event append and file close both failed");
        }
      }
      throw error;
    }
  }
}
