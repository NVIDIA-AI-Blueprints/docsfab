// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import {
  assertOwnerOnlyRunStateSupported,
  ensurePrivateRunDirectory,
  FileRunStore,
  FileRunStoreError,
} from "../src/records/file-store.js";
import { runRecordMaxBytes } from "../src/records/run-record-limit.js";
import { temporaryRoots } from "./helpers/temp.js";

const execFileAsync = promisify(execFile);
const roots = temporaryRoots();

describe("owner-only file run store", () => {
  it("reads exact private record bytes without preparing the store", async () => {
    const parent = await roots.create("docsfab-file-store-passive-");
    const root = join(parent, "runs");
    const store = new FileRunStore(root);
    await store.save(record("run-passive", "succeeded"));
    const path = join(root, "run-passive.json");
    const before = await readFile(path);
    const beforeRoot = await lstat(root);
    const loaded = await store.getWithDigest("run-passive", {
      readOnly: true,
      maxBytes: runRecordMaxBytes().value,
    });
    expect(loaded.sha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect(await readFile(path)).toEqual(before);
    expect((await lstat(root)).mode).toBe(beforeRoot.mode);
    expect(await readdir(root)).toEqual(["run-passive.json"]);
  });

  it("does not create a missing store for a passive read", async () => {
    const parent = await roots.create("docsfab-file-store-passive-missing-");
    const root = join(parent, "absent-runs");
    await expect(
      new FileRunStore(root).getWithDigest("run-passive", { readOnly: true }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not tighten permissions during a passive read", async () => {
    const parent = await roots.create("docsfab-file-store-passive-permissions-");
    const root = join(parent, "runs");
    const store = new FileRunStore(root);
    await store.save(record("run-passive", "succeeded"));
    await chmod(root, 0o755);
    await expect(store.getWithDigest("run-passive", { readOnly: true })).rejects.toMatchObject({
      code: "insecure-permissions",
    });
    expect((await lstat(root)).mode & 0o777).toBe(0o755);
  });

  it("creates and atomically replaces owner-only records", async () => {
    const parent = await roots.create("docsfab-file-store-");
    const root = join(parent, "runs");
    const store = new FileRunStore(root);

    await store.save(record("run-1", "queued"));
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    const destination = join(root, "run-1.json");
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);

    await store.save(record("run-1", "succeeded"));
    expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({
      id: "run-1",
      status: "succeeded",
    });
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads a pinned record at the byte bound and refuses one grown past it", async () => {
    const parent = await roots.create("docsfab-file-store-bound-");
    const root = join(parent, "runs");
    const path = join(root, "run-bound.json");
    const held = new FileRunStore(root);
    await held.save(record("run-bound", "succeeded"));
    const size = (await lstat(path)).size;
    await expect(held.getWithDigest("run-bound", { maxBytes: size })).resolves.toMatchObject({
      record: expect.objectContaining({ id: "run-bound" }),
    });
    const grown = new FileRunStore(root, {
      beforeRead: async () => {
        await appendFile(path, "x");
      },
    });
    await expect(grown.getWithDigest("run-bound", { maxBytes: size })).rejects.toMatchObject({
      code: "bounds-exceeded",
    });
  });

  it("caps the descriptor read when the pinned file grows after the size precheck", async () => {
    const parent = await roots.create("docsfab-file-store-read-cap-");
    const root = join(parent, "runs");
    const path = join(root, "run-bound.json");
    const writer = new FileRunStore(root);
    await writer.save(record("run-bound", "succeeded"));
    const size = (await lstat(path)).size;
    const requested: number[] = [];
    const grown = new FileRunStore(root, {
      beforeRead: async () => {
        await appendFile(path, Buffer.alloc(size, "x"));
      },
      observeReadLength: (length) => {
        requested.push(length);
      },
    });
    await expect(grown.getWithDigest("run-bound", { maxBytes: size })).rejects.toMatchObject({
      code: "bounds-exceeded",
    });
    expect(requested).toEqual([size + 1]);
  });

  it("returns the SHA-256 of the exact validated record bytes", async () => {
    const parent = await roots.create("docsfab-file-store-digest-");
    const root = join(parent, "runs");
    const path = join(root, "run-digest.json");
    const store = new FileRunStore(root);
    await store.save(record("run-digest", "succeeded"));

    const storedBytes = await readFile(path);
    const first = await store.getWithDigest("run-digest");
    expect(first).toEqual({
      record: JSON.parse(storedBytes.toString("utf8")),
      sha256: createHash("sha256").update(storedBytes).digest("hex"),
    });
    await expect(store.get("run-digest")).resolves.toEqual(first.record);

    const reformattedBytes = Buffer.from(`${JSON.stringify(first.record)}\n`, "utf8");
    expect(reformattedBytes.equals(storedBytes)).toBe(false);
    await writeFile(path, reformattedBytes, { mode: 0o600 });
    const reformatted = await store.getWithDigest("run-digest");
    expect(reformatted.record).toEqual(first.record);
    expect(reformatted.sha256).toBe(createHash("sha256").update(reformattedBytes).digest("hex"));
    expect(reformatted.sha256).not.toBe(first.sha256);
  });

  it("advances an earlier writer's record only at its exact saved digest", async () => {
    const root = await roots.create("docsfab-file-store-cas-");
    const writer = new FileRunStore(root);
    await writer.save(record("run-cas", "succeeded"));
    const first = await new FileRunStore(root).getWithDigest("run-cas");
    const outcome = {
      schemaVersion: 1,
      kind: "checkout-persistence",
      outcome: "failed",
      errorCode: "patch-conflict",
    } as const;
    const updated = { ...(first.record as RunRecord), checkoutPersistence: outcome };
    await new FileRunStore(root).replaceIfDigest(
      "run-cas",
      first.sha256,
      updated,
      runRecordMaxBytes().value,
    );
    const second = await new FileRunStore(root).getWithDigest("run-cas");
    expect(second.record).toMatchObject({ status: "succeeded", checkoutPersistence: outcome });
    await expect(
      new FileRunStore(root).replaceIfDigest(
        "run-cas",
        first.sha256,
        {
          ...updated,
          checkoutPersistence: { ...outcome, errorCode: "patch-invalid" },
        },
        runRecordMaxBytes().value,
      ),
    ).rejects.toMatchObject({ code: "record-exists" });
    expect((await new FileRunStore(root).getWithDigest("run-cas")).sha256).toBe(second.sha256);
  });

  it("refuses a CAS replacement if the saved leaf changes during preparation", async () => {
    const root = await roots.create("docsfab-file-store-cas-race-");
    const path = join(root, "run-cas-race.json");
    await new FileRunStore(root).save(record("run-cas-race", "succeeded"));
    const first = await new FileRunStore(root).getWithDigest("run-cas-race");
    const externalBytes = Buffer.from(`${JSON.stringify(first.record)}\n`, "utf8");
    const writer = new FileRunStore(root, {
      beforeRename: async () => {
        await writeFile(path, externalBytes, { mode: 0o600 });
      },
    });
    await expect(
      writer.replaceIfDigest(
        "run-cas-race",
        first.sha256,
        {
          ...(first.record as RunRecord),
          checkoutPersistence: {
            schemaVersion: 1,
            kind: "checkout-persistence",
            outcome: "applied",
          },
        },
        runRecordMaxBytes().value,
      ),
    ).rejects.toMatchObject({ code: "record-exists" });
    expect(await readFile(path)).toEqual(externalBytes);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("tightens an existing owned permissive root without replacing a legacy record", async () => {
    const root = await roots.create("docsfab-file-store-permissive-");
    await chmod(root, 0o755);
    const destination = join(root, "legacy.json");
    await writeFile(destination, "legacy\n", { mode: 0o644 });

    await expect(new FileRunStore(root).save(record("legacy", "succeeded"))).rejects.toEqual(
      new FileRunStoreError("record-exists"),
    );

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(destination)).mode & 0o777).toBe(0o644);
    expect(await readFile(destination, "utf8")).toBe("legacy\n");
  });

  it("never exposes a broader temporary and preserves the prior record on interruption", async () => {
    const root = await roots.create("docsfab-file-store-interrupt-");
    let observedTemporary = false;
    let writes = 0;
    const store = new FileRunStore(root, {
      id: () => "interrupted",
      beforeRename: async (temporary) => {
        writes += 1;
        if (writes === 1) return;
        observedTemporary = true;
        expect((await lstat(temporary)).mode & 0o777).toBe(0o600);
        throw new Error("injected interruption with private content sentinel");
      },
    });
    await store.save(record("run-2", "queued"));

    await expect(store.save(record("run-2", "succeeded"))).rejects.toMatchObject({
      code: "write-failed",
    });
    expect(observedTemporary).toBe(true);
    expect(JSON.parse(await readFile(join(root, "run-2.json"), "utf8"))).toMatchObject({
      status: "queued",
    });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects symlink, non-directory, destination-symlink, and traversal inputs", async () => {
    const parent = await roots.create("docsfab-file-store-unsafe-");
    const real = join(parent, "real");
    await mkdir(real, { mode: 0o700 });
    const linked = join(parent, "linked");
    await symlink(real, linked);
    const regular = join(parent, "regular");
    await writeFile(regular, "not a directory\n", { mode: 0o600 });

    await expect(new FileRunStore(linked).save(record("run-3", "failed"))).rejects.toMatchObject({
      code: "unsafe-root",
    });
    await expect(new FileRunStore(regular).save(record("run-3", "failed"))).rejects.toMatchObject({
      code: "unsafe-root",
    });

    const target = join(parent, "external.json");
    await writeFile(target, "external sentinel\n", { mode: 0o600 });
    await symlink(target, join(real, "run-3.json"));
    await expect(new FileRunStore(real).save(record("run-3", "failed"))).rejects.toMatchObject({
      code: "unsafe-entry",
    });
    expect(await readFile(target, "utf8")).toBe("external sentinel\n");

    const unsafe = record("../escape", "failed");
    await expect(new FileRunStore(join(parent, "missing")).save(unsafe)).rejects.toMatchObject({
      code: "unsafe-record-id",
    });
    await expect(lstat(join(parent, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => new FileRunStore("")).toThrowError(new FileRunStoreError("invalid-root"));
    expect(() => new FileRunStore(parse(resolve(parent)).root)).toThrowError(
      new FileRunStoreError("invalid-root"),
    );
    await expect(
      new FileRunStore(real, { id: () => "../../escape" }).save(record("safe-id", "failed")),
    ).rejects.toMatchObject({ code: "unsafe-entry" });
  });

  it("rejects a symlinked ancestor before reading or creating private run state", async () => {
    const parent = await roots.create("docsfab-file-store-ancestor-link-");
    const real = join(parent, "real");
    const linked = join(parent, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked);
    const root = join(linked, "private", "runs");
    const store = new FileRunStore(root);

    await expect(store.save(record("run-ancestor", "queued"))).rejects.toMatchObject({
      code: "unsafe-root",
    });
    await expect(store.get("run-ancestor")).rejects.toMatchObject({ code: "unsafe-root" });
    await expect(lstat(join(real, "private"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not clean up through a substituted root", async () => {
    const parent = await roots.create("docsfab-file-store-swap-");
    const root = join(parent, "runs");
    const displaced = join(parent, "displaced");
    const attacker = join(parent, "attacker");
    await ensurePrivateRunDirectory(root);
    await mkdir(attacker, { mode: 0o700 });
    let externalTemporary = "";
    const store = new FileRunStore(root, {
      id: () => "swap",
      beforeRename: async (temporary) => {
        await rename(root, displaced);
        externalTemporary = join(attacker, basename(temporary));
        await writeFile(externalTemporary, "attacker sentinel\n", { mode: 0o600 });
        await symlink(attacker, root);
      },
    });

    await expect(store.save(record("run-4", "failed"))).rejects.toBeInstanceOf(FileRunStoreError);
    expect(await readFile(externalTemporary, "utf8")).toBe("attacker sentinel\n");
    expect((await lstat(join(displaced, ".run-4.swap.tmp"))).mode & 0o777).toBe(0o600);
  });

  it("rejects an ancestor replacement without publishing or cleaning through it", async () => {
    const parent = await roots.create("docsfab-file-store-ancestor-swap-");
    const state = join(parent, "state");
    const root = join(state, "runs");
    const displaced = join(parent, "displaced-state");
    const attacker = join(parent, "attacker-state");
    await ensurePrivateRunDirectory(root);
    await mkdir(join(attacker, "runs"), { recursive: true, mode: 0o700 });
    let externalTemporary = "";
    const store = new FileRunStore(root, {
      id: () => "ancestor-swap",
      beforeRename: async (temporary) => {
        await rename(state, displaced);
        externalTemporary = join(attacker, "runs", basename(temporary));
        await writeFile(externalTemporary, "attacker sentinel\n", { mode: 0o600 });
        await symlink(attacker, state);
      },
    });

    await expect(store.save(record("run-ancestor-swap", "failed"))).rejects.toMatchObject({
      code: "unsafe-root",
    });
    expect(await readFile(externalTemporary, "utf8")).toBe("attacker sentinel\n");
    await expect(lstat(join(attacker, "runs", "run-ancestor-swap.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await lstat(join(displaced, "runs", ".run-ancestor-swap.ancestor-swap.tmp"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("rejects a root replacement after opening a record instead of returning trusted bytes", async () => {
    const parent = await roots.create("docsfab-file-store-read-swap-");
    const root = join(parent, "runs");
    const displaced = join(parent, "displaced");
    const attacker = join(parent, "attacker");
    const writer = new FileRunStore(root);
    await writer.save(record("run-read-swap", "succeeded"));
    await mkdir(attacker, { mode: 0o700 });
    await writeFile(
      join(attacker, "run-read-swap.json"),
      `${JSON.stringify(record("run-read-swap", "failed"))}\n`,
      { mode: 0o600 },
    );
    const reader = new FileRunStore(root, {
      beforeRead: async () => {
        await rename(root, displaced);
        await symlink(attacker, root);
      },
    });

    await expect(reader.get("run-read-swap")).rejects.toMatchObject({ code: "unsafe-root" });
  });

  it("rejects private root permission drift during a pinned read", async () => {
    const root = await roots.create("docsfab-file-store-mode-drift-");
    const writer = new FileRunStore(root);
    await writer.save(record("run-mode-drift", "succeeded"));
    const reader = new FileRunStore(root, {
      beforeRead: async () => chmod(root, 0o755),
    });

    await expect(reader.get("run-mode-drift")).rejects.toMatchObject({
      code: "insecure-permissions",
    });
  });

  it("rejects temporary-file substitution before atomic rename", async () => {
    const root = await roots.create("docsfab-file-store-temp-swap-");
    const store = new FileRunStore(root, {
      id: () => "swap",
      beforeRename: async (temporary) => {
        await rename(temporary, `${temporary}.original`);
        await writeFile(temporary, "attacker replacement\n", { mode: 0o600 });
      },
    });

    await expect(store.save(record("run-4b", "failed"))).rejects.toMatchObject({
      code: "unsafe-entry",
    });
    await expect(lstat(join(root, "run-4b.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".run-4b.swap.tmp"), "utf8")).toBe("attacker replacement\n");
    expect((await lstat(join(root, ".run-4b.swap.tmp.original"))).mode & 0o777).toBe(0o600);
  });

  it("fails closed on platforms where owner-only state cannot be verified", () => {
    expect(() => assertOwnerOnlyRunStateSupported("win32", undefined)).toThrowError(
      new FileRunStoreError("unsupported-platform"),
    );
    expect(() => assertOwnerOnlyRunStateSupported("linux", null)).toThrowError(
      new FileRunStoreError("unsupported-platform"),
    );
  });

  it("keeps filesystem and record content out of errors", async () => {
    const parent = await roots.create("docsfab-file-store-errors-");
    const unsafeRoot = join(parent, "PRIVATE_PATH_SENTINEL");
    await writeFile(unsafeRoot, "MODEL_OUTPUT_SENTINEL\n", { mode: 0o600 });
    let error: unknown;
    try {
      await new FileRunStore(unsafeRoot).save(record("run-5", "failed"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FileRunStoreError);
    expect(String(error)).not.toContain("PRIVATE_PATH_SENTINEL");
    expect(String(error)).not.toContain("MODEL_OUTPUT_SENTINEL");
  });

  it("enforces exact modes under ordinary and restrictive umasks in isolated processes", async () => {
    const parent = await roots.create("docsfab-file-store-umask-");
    const modulePath = fileURLToPath(new URL("../src/records/file-store.ts", import.meta.url));
    const recordValue = record("spawned", "succeeded");
    for (const [name, mask] of [
      ["ordinary", 0o022],
      ["restrictive", 0o077],
    ] as const) {
      const root = join(parent, name);
      const script = [
        `import { FileRunStore } from ${JSON.stringify(modulePath)};`,
        `process.umask(${mask});`,
        `await new FileRunStore(${JSON.stringify(root)}).save(${JSON.stringify(recordValue)});`,
      ].join("\n");
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: resolve(dirname(modulePath), "../.."),
          env: { ...process.env },
        },
      );
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(root, "spawned.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects cross-process run-id replay and preserves the original record", async () => {
    const parent = await roots.create("docsfab-file-store-replay-");
    const root = join(parent, "runs");
    const modulePath = fileURLToPath(new URL("../src/records/file-store.ts", import.meta.url));
    const execute = async (value: RunRecord): Promise<void> => {
      const script = [
        `import { FileRunStore } from ${JSON.stringify(modulePath)};`,
        `await new FileRunStore(${JSON.stringify(root)}).save(${JSON.stringify(value)});`,
      ].join("\n");
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: resolve(dirname(modulePath), "../.."),
          env: { ...process.env },
        },
      );
    };

    await execute(record("authorized-run-1", "queued"));
    await expect(execute(record("authorized-run-1", "succeeded"))).rejects.toMatchObject({
      code: 1,
    });
    expect(JSON.parse(await readFile(join(root, "authorized-run-1.json"), "utf8"))).toMatchObject({
      id: "authorized-run-1",
      status: "queued",
    });
    expect((await lstat(join(root, "authorized-run-1.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

function record(id: string, status: RunRecord["status"]): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "readiness",
    repository: {
      sourcePath: "/operator/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status,
    createdAt: "2026-08-03T20:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
}
