// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  locateRunDeliveryAttempts,
  recordRunDeliveryAttemptLocation,
  RUN_DELIVERY_ATTEMPT_LOCATIONS,
  type RunDeliveryAttemptLocation,
} from "../src/delivery/run-deletion-adapter.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporary = temporaryRoots();
const runId = "run-discovery";
const recordSha256 = "a".repeat(64);
const planSha256 = "b".repeat(64);
const capsuleName = "run-discovery-capsule";

afterEach(() => temporary.cleanup());

async function roots() {
  const root = await temporary.create("docsfab-attempt-discovery-", { realpath: true });
  const stateDirectory = join(root, "state");
  const deliveryRoot = join(root, "delivery");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(deliveryRoot, { mode: 0o700 });
  return { root, stateDirectory, deliveryRoot };
}

function location(
  base: Awaited<ReturnType<typeof roots>>,
  overrides: Partial<Extract<RunDeliveryAttemptLocation, { schemaVersion: 1 }>> = {},
): RunDeliveryAttemptLocation {
  return {
    schemaVersion: 1,
    kind: "docsfab-run-delivery-attempt-location",
    stateDirectory: base.stateDirectory,
    runId,
    recordSha256,
    deliveryRoot: base.deliveryRoot,
    attemptPath: join(base.deliveryRoot, "attempts", "attempt-one"),
    planSha256,
    ...overrides,
  };
}

function locatorPath(stateDirectory: string, value: unknown): string {
  const name = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return join(stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS, `${name}.json`);
}

function query(
  base: Awaited<ReturnType<typeof roots>>,
  overrides: Partial<Parameters<typeof locateRunDeliveryAttempts>[0]> = {},
) {
  return locateRunDeliveryAttempts({
    stateDirectory: base.stateDirectory,
    runId,
    recordSha256,
    deliveryRoot: base.deliveryRoot,
    planSha256,
    capsuleName,
    ...overrides,
  });
}

describe("delivery attempt location discovery", () => {
  it("reads a receipt-root-bound v2 locator alongside an identical legacy v1 location", async () => {
    const base = await roots();
    const receiptRoot = join(base.root, "custom-receipts");
    await mkdir(receiptRoot, { mode: 0o700 });
    const legacy = location(base);
    const current = { ...legacy, schemaVersion: 2 as const, receiptRoot };
    await recordRunDeliveryAttemptLocation(legacy);
    const path = await recordRunDeliveryAttemptLocation(current);
    const bytes = await readFile(path);
    await expect(query(base)).resolves.toEqual([legacy.attemptPath]);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(current);
    await expect(recordRunDeliveryAttemptLocation(current)).resolves.toBe(path);
    expect(await readFile(path)).toEqual(bytes);
  });

  it("refuses a v2 locator with an unsafe receipt root before writing metadata", async () => {
    const base = await roots();
    const target = join(base.root, "receipt-target");
    const receiptRoot = join(base.root, "receipt-link");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, receiptRoot);
    await expect(
      recordRunDeliveryAttemptLocation({ ...location(base), schemaVersion: 2, receiptRoot }),
    ).rejects.toThrow(/unsafe/u);
    await expect(
      lstat(join(base.stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an exact valid locator when its attempt is absent or the attempts directory is empty", async () => {
    const base = await roots();
    const value = location(base);
    await recordRunDeliveryAttemptLocation(value);
    await expect(query(base)).resolves.toEqual([value.attemptPath]);
    await mkdir(join(base.deliveryRoot, "attempts"), { mode: 0o700 });
    await expect(query(base)).resolves.toEqual([value.attemptPath]);
  });

  it("ignores valid metadata for a different run or plan", async () => {
    const base = await roots();
    await recordRunDeliveryAttemptLocation(
      location(base, {
        runId: "another-run",
        recordSha256: "c".repeat(64),
        attemptPath: join(base.deliveryRoot, "attempts", "other-run"),
      }),
    );
    await recordRunDeliveryAttemptLocation(
      location(base, {
        planSha256: "d".repeat(64),
        attemptPath: join(base.deliveryRoot, "attempts", "other-plan"),
      }),
    );
    await expect(query(base)).resolves.toEqual([]);
  });

  it("orders the persisted exact attempt before lexically earlier legacy discovery", async () => {
    const base = await roots();
    const recordedPath = join(base.deliveryRoot, "attempts", "z-recorded");
    const discoveredPath = join(base.deliveryRoot, "attempts", "a-legacy");
    await recordRunDeliveryAttemptLocation(location(base, { attemptPath: recordedPath }));
    await mkdir(join(discoveredPath, capsuleName), { recursive: true, mode: 0o700 });

    await expect(query(base)).resolves.toEqual([recordedPath, discoveredPath]);
  });

  it("refuses multiple persisted paths for the same run and plan", async () => {
    const base = await roots();
    await recordRunDeliveryAttemptLocation(
      location(base, { attemptPath: join(base.deliveryRoot, "attempts", "attempt-one") }),
    );
    await recordRunDeliveryAttemptLocation(
      location(base, { attemptPath: join(base.deliveryRoot, "attempts", "attempt-two") }),
    );

    await expect(query(base)).rejects.toThrow(/Multiple delivery attempt locations/u);
  });

  it("refuses ambiguous legacy attempts without a persisted location", async () => {
    const base = await roots();
    for (const name of ["attempt-one", "attempt-two"]) {
      await mkdir(join(base.deliveryRoot, "attempts", name, capsuleName), {
        recursive: true,
        mode: 0o700,
      });
    }

    await expect(query(base)).rejects.toThrow(/Multiple legacy delivery attempt locations/u);
  });

  it("discovers a legacy exact capsule without following its repository symlink", async () => {
    const base = await roots();
    const attemptPath = join(base.deliveryRoot, "attempts", "legacy-attempt");
    const capsulePath = join(attemptPath, capsuleName);
    const outside = join(base.root, "outside");
    await mkdir(capsulePath, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "sentinel"), "untouched");
    await symlink(outside, join(capsulePath, "repository"));

    await expect(query(base)).resolves.toEqual([attemptPath]);
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("untouched");
  });

  it("keeps an identical recorded locator byte-for-byte and inode-idempotent", async () => {
    const base = await roots();
    const value = location(base);
    const path = await recordRunDeliveryAttemptLocation(value);
    const beforeStat = await lstat(path);
    const beforeBytes = await readFile(path);

    await expect(recordRunDeliveryAttemptLocation(value)).resolves.toBe(path);
    expect(await lstat(path)).toMatchObject({ dev: beforeStat.dev, ino: beforeStat.ino });
    expect(await readFile(path)).toEqual(beforeBytes);
  });

  it("refuses malformed metadata without modifying its bytes", async () => {
    const base = await roots();
    const invalid = { malformed: true };
    const path = locatorPath(base.stateDirectory, invalid);
    await mkdir(join(base.stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS), { mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify(invalid));
    await writeFile(path, bytes, { mode: 0o600 });

    await expect(query(base)).rejects.toThrow(/metadata .*invalid/u);
    await expect(readFile(path)).resolves.toEqual(bytes);
  });

  it("refuses a symlink locator without changing its target", async () => {
    const base = await roots();
    const value = location(base);
    const path = locatorPath(base.stateDirectory, value);
    const target = join(base.root, "locator-target.json");
    const bytes = Buffer.from(JSON.stringify(value));
    await mkdir(join(base.stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS), { mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    await symlink(target, path);

    await expect(query(base)).rejects.toThrow(/unsafe/u);
    await expect(readlink(path)).resolves.toBe(target);
    await expect(readFile(target)).resolves.toEqual(bytes);
  });
});
