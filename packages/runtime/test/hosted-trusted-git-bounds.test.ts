// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalogued bounds of the hosted runtime's Git entry point, read from the
 * catalog the module reads so the test moves with the bound.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { catalogCapacity } from "../src/config/catalog-capacity.js";
import { limit } from "../src/config/limits.js";
import {
  fetchTrustedLocalGitRevision,
  MAX_GIT_OUTPUT_BYTES,
  readTrustedGitBlob,
  runTrustedGit,
  TrustedGitBlobError,
  TrustedGitError,
} from "../src/host-invoker/trusted-git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { rewriteLooseObject } from "./support/change-source-fixture.js";

const exec = promisify(execFile);
const DEFAULT_OUTPUT_MAX_BYTES = catalogCapacity("hostInvoker.gitDefaultOutputMaxBytes");
const GIT_TIMEOUT_MS = catalogCapacity("hostInvoker.gitTimeoutMs");
const OUTPUT_BOUND_REFUSAL = "Hosted runtime Git output exceeded its closed bound.";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(objectFormat: "sha1" | "sha256" = "sha1") {
  const root = await mkdtemp(join(tmpdir(), "docsfab-trusted-git-"));
  roots.push(root);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await exec("/usr/bin/git", ["init", "--quiet", `--object-format=${objectFormat}`, root], {
    env,
  });
  return { root: await realpath(root), env };
}

/** Write a blob of exactly `bytes` and return its object id. */
async function blobOfSize(root: string, env: NodeJS.ProcessEnv, bytes: number) {
  const path = join(root, `blob-${bytes}`);
  await writeFile(path, Buffer.alloc(bytes, 0x61));
  const { stdout } = await exec("/usr/bin/git", ["-C", root, "hash-object", "-w", "--", path], {
    env,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

describe("hosted runtime trusted Git bounds", () => {
  it.each(["sha1", "sha256"] as const)(
    "streams a %s pinned blob larger than the sealed buffered-output cap",
    { timeout: testTimeoutMs(60_000) },
    async (objectFormat) => {
      const { root, env } = await repository(objectFormat);
      const length = MAX_GIT_OUTPUT_BYTES + 1;
      expect(length).toBeLessThan(limit("reviewDelivery.snapshotUniqueOriginalBytesMax").value);
      const objectId = await blobOfSize(root, env, length);
      await expect(
        runTrustedGit(root, ["cat-file", "blob", objectId], undefined, MAX_GIT_OUTPUT_BYTES),
      ).rejects.toMatchObject({ kind: "output-bound" });
      const result = await readTrustedGitBlob({
        sourcePath: root,
        objectId,
        objectFormat,
        expectedByteLength: length,
      });
      expect(result.byteLength).toBe(length);
      expect(result.equals(Buffer.alloc(length, 0x61))).toBe(true);
    },
  );

  it("validates the pinned request and owner limit before spawning Git", async () => {
    const { root } = await repository();
    const original = {
      sourcePath: root,
      objectId: "a".repeat(40),
      objectFormat: "sha1" as const,
      expectedByteLength: 5,
    };
    for (const input of [
      { ...original, sourcePath: "relative/repository" },
      { ...original, objectId: "A".repeat(40) },
      { ...original, objectFormat: "sha256" as const },
      { ...original, expectedByteLength: -1 },
    ]) {
      await expect(readTrustedGitBlob(input)).rejects.toBeInstanceOf(TrustedGitBlobError);
    }
    await expect(
      readTrustedGitBlob({
        ...original,
        expectedByteLength: limit("reviewDelivery.snapshotUniqueOriginalBytesMax").value + 1,
      }),
    ).rejects.toThrow(/reviewDelivery\.snapshotUniqueOriginalBytesMax/u);
  });

  it("refuses an actual blob whose Git header disagrees with the inspected length", async () => {
    const { root, env } = await repository();
    const objectId = await blobOfSize(root, env, 5);
    await expect(
      readTrustedGitBlob({
        sourcePath: root,
        objectId,
        objectFormat: "sha1",
        expectedByteLength: 6,
      }),
    ).rejects.toMatchObject({ code: "pinned-blob-type-or-length-mismatch" });
  });

  it("preserves an empty pinned blob and its trailer", async () => {
    const { root, env } = await repository();
    const objectId = await blobOfSize(root, env, 0);
    await expect(
      readTrustedGitBlob({
        sourcePath: root,
        objectId,
        objectFormat: "sha1",
        expectedByteLength: 0,
      }),
    ).resolves.toEqual(Buffer.alloc(0));
  });

  it("refuses a missing object, a wrong type and same-length changed bytes", async () => {
    const { root, env } = await repository();
    const treeId = (
      await exec("/usr/bin/git", ["-C", root, "hash-object", "-t", "tree", "-w", "/dev/null"], {
        env,
      })
    ).stdout.trim();
    for (const [objectId, expectedByteLength] of [
      ["f".repeat(40), 0],
      [treeId, 0],
    ] as const) {
      await expect(
        readTrustedGitBlob({
          sourcePath: root,
          objectId,
          objectFormat: "sha1",
          expectedByteLength,
        }),
      ).rejects.toMatchObject({ code: "pinned-blob-type-or-length-mismatch" });
    }
    const objectId = await blobOfSize(root, env, 5);
    await rewriteLooseObject(root, objectId, () => Buffer.from("wrong"));
    await expect(
      readTrustedGitBlob({
        sourcePath: root,
        objectId,
        objectFormat: "sha1",
        expectedByteLength: 5,
      }),
    ).rejects.toMatchObject({ code: "pinned-blob-object-id-mismatch" });
  });

  it("kills and reaps a Git blob read when the caller aborts", async () => {
    const { root, env } = await repository();
    const objectId = "a".repeat(40);
    const looseDirectory = join(root, ".git", "objects", objectId.slice(0, 2));
    await mkdir(looseDirectory, { recursive: true });
    // A malicious loose object can block Git while it opens the object path.
    // The fixed-purpose reader must kill and await that child on cancellation.
    await exec("/usr/bin/mkfifo", [join(looseDirectory, objectId.slice(2))], { env });
    const abort = new AbortController();
    const pending = readTrustedGitBlob({
      sourcePath: root,
      objectId,
      objectFormat: "sha1",
      expectedByteLength: 1,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("turns off automatic gc and maintenance for every trusted Git command", async () => {
    const { root } = await repository();
    // `git config --get` reads the command line's `-c` settings, so this runs
    // through the same fixed argument list as the fetch and checkout.
    const setting = async (key: string) =>
      (await runTrustedGit(root, ["config", "--get", key])).toString().trim();
    expect(await setting("gc.auto")).toBe("0");
    expect(await setting("maintenance.auto")).toBe("false");
  });

  it("returns output exactly at the catalogued default bound and refuses one byte more", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const { root, env } = await repository();
    // Positive control at the limit: `size > maximumBytes` refuses, so an
    // output of exactly the bound is admitted and returned in full.
    const atLimit = await blobOfSize(root, env, DEFAULT_OUTPUT_MAX_BYTES);
    const output = await runTrustedGit(root, ["cat-file", "blob", atLimit]);
    expect(output.length).toBe(DEFAULT_OUTPUT_MAX_BYTES);
    // Limit plus one: the same call, one byte larger, is refused by name.
    const overLimit = await blobOfSize(root, env, DEFAULT_OUTPUT_MAX_BYTES + 1);
    await expect(runTrustedGit(root, ["cat-file", "blob", overLimit])).rejects.toMatchObject({
      message: OUTPUT_BOUND_REFUSAL,
      kind: "output-bound",
    });
    // The whole-revision ceiling is a different catalogued number, and the
    // same oversized output passes under it.
    expect(MAX_GIT_OUTPUT_BYTES).toBe(catalogCapacity("hostInvoker.gitOutputMaxBytes"));
    expect(MAX_GIT_OUTPUT_BYTES).toBeGreaterThan(DEFAULT_OUTPUT_MAX_BYTES);
    const admitted = await runTrustedGit(
      root,
      ["cat-file", "blob", overLimit],
      undefined,
      MAX_GIT_OUTPUT_BYTES,
    );
    expect(admitted.length).toBe(DEFAULT_OUTPUT_MAX_BYTES + 1);
  });

  it("kills a Git invocation that outlives the catalogued deadline and keeps a slower-but-in-time one", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const { root, env } = await repository();
    // A FIFO blocks `git hash-object` inside `open()` until a writer appears:
    // no hook, no protocol and no network is involved, so this drives the
    // module's own timer rather than an external wait.
    const blocking = join(root, "blocking-fifo");
    await exec("/usr/bin/mkfifo", [blocking], { env });
    const started = Date.now();
    await expect(runTrustedGit(root, ["hash-object", "--", blocking])).rejects.toMatchObject({
      message: "Hosted runtime trusted Git timed out.",
      kind: "timeout",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(GIT_TIMEOUT_MS);
    // A call that is slow but finishes inside the deadline completes normally.
    const slow = join(root, "slow-fifo");
    await exec("/usr/bin/mkfifo", [slow], { env });
    const writer = (async () => {
      await new Promise((done) => setTimeout(done, 1000));
      const handle = await open(slow, "w");
      await handle.write("in time\n");
      await handle.close();
    })();
    const digest = await runTrustedGit(root, ["hash-object", "--", slow]);
    await writer;
    expect(digest.toString().trim()).toMatch(/^[a-f0-9]{40}$/u);
  });

  it("types a non-zero exit with its status, apart from a bound or a timeout", async () => {
    const { root } = await repository();
    const error = await runTrustedGit(root, ["cat-file", "-e", "f".repeat(40)]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TrustedGitError);
    expect(error).toMatchObject({
      kind: "exit",
      exitCode: 1,
      message: "Hosted runtime trusted Git failed (1).",
    });
  });

  it("ignores a repository grafts file that would rewrite history", async () => {
    const { root, env } = await repository();
    const identity = {
      ...env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    for (const message of ["one", "two", "three"]) {
      await exec(
        "/usr/bin/git",
        ["-C", root, "commit", "--quiet", "--allow-empty", "-m", message],
        {
          env: identity,
        },
      );
    }
    const commits = (await exec("/usr/bin/git", ["-C", root, "rev-list", "HEAD"], { env })).stdout
      .trim()
      .split("\n");
    // Graft the newest commit straight onto the oldest, hiding the middle one.
    await writeFile(join(root, ".git", "info", "grafts"), `${commits[0]} ${commits[2]}\n`);
    const subjects = async (run: () => Promise<string>) => (await run()).trim().split("\n");
    // Control: plain git honours the graft.
    expect(
      await subjects(
        async () =>
          (await exec("/usr/bin/git", ["-C", root, "log", "--format=%s"], { env })).stdout,
      ),
    ).toEqual(["three", "one"]);
    expect(
      await subjects(async () =>
        (await runTrustedGit(root, ["log", "--format=%s"])).toString("utf8"),
      ),
    ).toEqual(["three", "two", "one"]);
  });

  it("admits only an absolute local source and an exact revision for the private fetch", async () => {
    const { root } = await repository();
    const revision = "a".repeat(40);
    for (const [sourcePath, wanted] of [
      ["relative/source", revision],
      ["../escaping/source", revision],
      ["/absolute/source", "HEAD"],
      ["/absolute/source", "main"],
      ["/absolute/source", "A".repeat(40)],
      ["/absolute/source", "a".repeat(39)],
    ] as const) {
      await expect(fetchTrustedLocalGitRevision(root, sourcePath, wanted)).rejects.toThrow(
        "Hosted candidate source must be an absolute local repository and exact revision.",
      );
    }
  });
});
