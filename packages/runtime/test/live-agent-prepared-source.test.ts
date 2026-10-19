// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPreparedLocalSourceManifest,
  createPreparedLocalSourcePorts,
  decodePreparedLocalSourceManifestV1,
  prepareLocalSourceSnapshot,
} from "../src/live-agent/prepared-source-ports.js";
import { initFixtureRepo } from "./helpers/git.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-live-prepared-source-"));
  temporary.push(root);
  await initFixtureRepo(root, files);
  return root;
}

async function mountSnapshot(
  root: string,
  snapshot: Awaited<ReturnType<typeof prepareLocalSourceSnapshot>>,
) {
  for (const file of snapshot.files) {
    const target = join(root, snapshot.ref.sourceId, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}

async function replaceDirectoryBeforeTargetLstat(
  target: string,
  replacement: () => Promise<void>,
  read: () => Promise<unknown>,
): Promise<void> {
  const original = fs.promises.lstat;
  let replaced = false;
  fs.promises.lstat = async (path, ...args) => {
    if (!replaced && String(path) === target) {
      replaced = true;
      await replacement();
    }
    return original.call(fs.promises, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await read();
  } finally {
    fs.promises.lstat = original;
    syncBuiltinESMExports();
  }
  expect(replaced).toBe(true);
}

async function growFileBeforeFirstDescriptorRead(
  target: string,
  read: () => Promise<unknown>,
): Promise<{
  readonly requestedBytes: number;
  readonly bytesRead: number;
  readonly failure: unknown;
}> {
  const probe = await fs.promises.open(target, "r");
  const handleApi = Object.getPrototypeOf(probe) as {
    read: typeof probe.read;
  };
  const originalRead = handleApi.read;
  await probe.close();
  let grew = false;
  let requestedBytes = 0;
  let bytesRead = 0;
  let failure: unknown;
  handleApi.read = async function (this: typeof probe, ...readArgs) {
    if (!grew) {
      grew = true;
      await writeFile(target, "growth".repeat(1024), { flag: "a" });
    }
    requestedBytes += readArgs[2] ?? 0;
    const result = await originalRead.apply(this, readArgs);
    bytesRead += result.bytesRead;
    return result;
  };
  try {
    await read().catch((error: unknown) => {
      failure = error;
    });
  } finally {
    handleApi.read = originalRead;
  }
  expect(grew).toBe(true);
  return { requestedBytes, bytesRead, failure };
}

describe("live-agent prepared local source ports (#2519)", () => {
  it("binds separate repositories and gives parent and workflow the same immutable evidence", async () => {
    const rootA = await repository({ "docs/guide.html": "<p>alpha</p>\n" });
    const rootB = await repository({ "README.txt": "beta\u0000bytes\n" });
    const snapshotA = await prepareLocalSourceSnapshot({
      sourceId: "alpha",
      repositoryPath: rootA,
      documentationRoots: ["docs"],
    });
    const snapshotB = await prepareLocalSourceSnapshot({
      sourceId: "beta",
      repositoryPath: rootB,
      documentationRoots: ["README.txt"],
    });
    const sourcesRoot = await mkdtemp(join(tmpdir(), "docsfab-prepared-mount-"));
    temporary.push(sourcesRoot);
    await mountSnapshot(sourcesRoot, snapshotA);
    await mountSnapshot(sourcesRoot, snapshotB);
    const manifest = createPreparedLocalSourceManifest([snapshotB, snapshotA]);
    const ports = await createPreparedLocalSourcePorts({
      manifest,
      refs: [snapshotA.ref, snapshotB.ref],
      sourcesRoot,
    });

    const parentEvidence = await ports.withTrackedSourceReader!(async (reader) => {
      expect(await reader.listTrackedRegularFiles?.()).toEqual([
        "alpha/docs/guide.html",
        "beta/README.txt",
      ]);
      return Promise.all([
        reader.readTrackedBytes("alpha/docs/guide.html", 4096),
        reader.readTrackedBytes("beta/README.txt", 4096),
      ]);
    });
    const workflowEvidence = await ports.withTrackedSourceReader!(async (reader) =>
      Promise.all([
        reader.readTrackedBytes("alpha/docs/guide.html", 4096),
        reader.readTrackedBytes("beta/README.txt", 4096),
      ]),
    );
    expect(workflowEvidence.map((bytes) => Buffer.from(bytes))).toEqual(
      parentEvidence.map((bytes) => Buffer.from(bytes)),
    );
    expect(Buffer.from(parentEvidence[0]!)).toEqual(Buffer.from("<p>alpha</p>\n"));
    expect(Buffer.from(parentEvidence[1]!)).toEqual(Buffer.from("beta\u0000bytes\n"));

    await writeFile(join(sourcesRoot, "alpha", "docs", "guide.html"), "tampered after bind");
    const afterMountTamper = await ports.withTrackedSourceReader!(async (reader) =>
      reader.readTrackedBytes("alpha/docs/guide.html", 4096),
    );
    expect(Buffer.from(afterMountTamper)).toEqual(Buffer.from(parentEvidence[0]!));
  });

  it("refuses altered mounted bytes, symlinks, path traversal, and undeclared reads", async () => {
    const root = await repository({
      "docs/guide.html": "<p>Guide</p>\n",
      "private/secret.txt": "not selected",
    });
    const snapshot = await prepareLocalSourceSnapshot({
      sourceId: "safe-source",
      repositoryPath: root,
      documentationRoots: ["docs"],
    });
    const sourcesRoot = await mkdtemp(join(tmpdir(), "docsfab-prepared-tamper-"));
    temporary.push(sourcesRoot);
    await mountSnapshot(sourcesRoot, snapshot);
    const manifest = createPreparedLocalSourceManifest([snapshot]);
    const ports = await createPreparedLocalSourcePorts({
      manifest,
      refs: [snapshot.ref],
      sourcesRoot,
    });
    await expect(
      ports.withTrackedSourceReader!(async (reader) =>
        reader.readTrackedBytes("safe-source/private/secret.txt", 4096),
      ),
    ).rejects.toMatchObject({ code: "source-unavailable" });

    await writeFile(join(sourcesRoot, "safe-source", "docs", "guide.html"), "changed bytes");
    await expect(
      createPreparedLocalSourcePorts({ manifest, refs: [snapshot.ref], sourcesRoot }),
    ).rejects.toMatchObject({ code: "source-tampered" });

    await rm(join(sourcesRoot, "safe-source", "docs", "guide.html"));
    await symlink(
      "../../../private/secret.txt",
      join(sourcesRoot, "safe-source", "docs", "guide.html"),
    );
    await expect(
      createPreparedLocalSourcePorts({ manifest, refs: [snapshot.ref], sourcesRoot }),
    ).rejects.toMatchObject({ code: "unsafe-entry" });

    const traversalRef = { ...snapshot.ref, paths: ["../private/secret.txt"] };
    expect(() =>
      decodePreparedLocalSourceManifestV1({
        ...manifest,
        sources: [
          {
            ref: traversalRef,
            files: [{ path: "../private/secret.txt", byteLength: 1, sha256: "0".repeat(64) }],
          },
        ],
      }),
    ).toThrow();

    const changedManifest = {
      ...manifest,
      sources: [
        {
          ...manifest.sources[0]!,
          files: [{ ...manifest.sources[0]!.files[0]!, sha256: "0".repeat(64) }],
        },
      ],
    };
    expect(() => decodePreparedLocalSourceManifestV1(changedManifest)).toThrow(
      /manifest-digest-mismatch/u,
    );
  });

  it("rejects source-root and nested-parent replacement during a real ports bind", async () => {
    for (const replacementKind of ["source-root", "nested-parent"] as const) {
      const source = await repository({ "docs/guide.html": "same admitted bytes\n" });
      const snapshot = await prepareLocalSourceSnapshot({
        sourceId: "safe-source",
        repositoryPath: source,
        documentationRoots: ["docs"],
      });
      const sourcesRoot = await mkdtemp(join(tmpdir(), "docsfab-prepared-race-"));
      const outsideRoot = await mkdtemp(join(tmpdir(), "docsfab-prepared-outside-"));
      const displacedRoot = `${sourcesRoot}-displaced`;
      temporary.push(sourcesRoot, outsideRoot, displacedRoot);
      await mountSnapshot(sourcesRoot, snapshot);
      await mountSnapshot(outsideRoot, snapshot);
      const manifest = createPreparedLocalSourceManifest([snapshot]);
      const target = join(await realpath(sourcesRoot), "safe-source", "docs", "guide.html");

      await expect(
        replaceDirectoryBeforeTargetLstat(
          target,
          async () => {
            if (replacementKind === "source-root") {
              await rename(sourcesRoot, displacedRoot);
              await symlink(outsideRoot, sourcesRoot);
            } else {
              const docs = join(sourcesRoot, "safe-source", "docs");
              const displacedDocs = join(sourcesRoot, "safe-source", "docs-displaced");
              await rename(docs, displacedDocs);
              await symlink(join(outsideRoot, "safe-source", "docs"), docs);
            }
          },
          () => createPreparedLocalSourcePorts({ manifest, refs: [snapshot.ref], sourcesRoot }),
        ),
      ).rejects.toMatchObject({ code: "source-tampered" });
    }
  });

  it("bounds a mounted-file growth race to the expected length plus one byte", async () => {
    const source = await repository({ "docs/guide.html": "bounded snapshot bytes\n" });
    const snapshot = await prepareLocalSourceSnapshot({
      sourceId: "bounded-source",
      repositoryPath: source,
      documentationRoots: ["docs"],
    });
    const sourcesRoot = await mkdtemp(join(tmpdir(), "docsfab-prepared-growth-"));
    temporary.push(sourcesRoot);
    await mountSnapshot(sourcesRoot, snapshot);
    const manifest = createPreparedLocalSourceManifest([snapshot]);
    const target = join(sourcesRoot, "bounded-source", "docs", "guide.html");

    const observed = await growFileBeforeFirstDescriptorRead(target, () =>
      createPreparedLocalSourcePorts({ manifest, refs: [snapshot.ref], sourcesRoot }),
    );

    expect(observed.failure).toMatchObject({ code: "source-tampered" });
    expect(observed.requestedBytes).toBe(snapshot.files[0]!.byteLength + 1);
    expect(observed.bytesRead).toBe(snapshot.files[0]!.byteLength + 1);
  });

  it("composes with the pinned baseline reader and refuses namespace collisions", async () => {
    const root = await repository({ "docs/guide.html": "prepared source" });
    const snapshot = await prepareLocalSourceSnapshot({
      sourceId: "handbook",
      repositoryPath: root,
      documentationRoots: ["docs"],
    });
    const sourcesRoot = await mkdtemp(join(tmpdir(), "docsfab-prepared-compose-"));
    temporary.push(sourcesRoot);
    await mountSnapshot(sourcesRoot, snapshot);
    const baseline = Buffer.from("baseline bytes");
    const basePorts = {
      withTrackedSourceReader: async <T>(
        use: (reader: {
          isTrackedRegularFile(path: string): Promise<boolean>;
          listTrackedRegularFiles(): Promise<readonly string[]>;
          readTrackedBytes(path: string, maxBytes: number): Promise<Uint8Array>;
        }) => Promise<T>,
      ) =>
        use({
          async isTrackedRegularFile(path) {
            return path === "workspace/README.md";
          },
          async listTrackedRegularFiles() {
            return ["workspace/README.md"];
          },
          async readTrackedBytes(path, maxBytes) {
            if (path !== "workspace/README.md") throw new Error("unknown baseline path");
            if (baseline.byteLength > maxBytes) throw new Error("baseline too large");
            return new Uint8Array(baseline);
          },
        }),
    };
    const ports = await createPreparedLocalSourcePorts({
      basePorts,
      manifest: createPreparedLocalSourceManifest([snapshot]),
      refs: [snapshot.ref],
      sourcesRoot,
    });
    await ports.withTrackedSourceReader!(async (reader) => {
      expect(await reader.listTrackedRegularFiles?.()).toEqual([
        "handbook/docs/guide.html",
        "workspace/README.md",
      ]);
      expect(Buffer.from(await reader.readTrackedBytes("workspace/README.md", 4096))).toEqual(
        baseline,
      );
      expect(Buffer.from(await reader.readTrackedBytes("handbook/docs/guide.html", 4096))).toEqual(
        Buffer.from("prepared source"),
      );
    });

    const collisionPorts = {
      withTrackedSourceReader: async <T>(
        use: Parameters<NonNullable<typeof basePorts.withTrackedSourceReader>>[0],
      ) =>
        basePorts.withTrackedSourceReader!(async (reader) =>
          use({
            ...reader,
            async isTrackedRegularFile(path) {
              return path === "handbook/docs/guide.html" || reader.isTrackedRegularFile(path);
            },
            async listTrackedRegularFiles() {
              return ["handbook/docs/guide.html", ...(await reader.listTrackedRegularFiles())];
            },
          }),
        ),
    };
    const collision = await createPreparedLocalSourcePorts({
      basePorts: collisionPorts,
      manifest: createPreparedLocalSourceManifest([snapshot]),
      refs: [snapshot.ref],
      sourcesRoot,
    });
    await expect(collision.withTrackedSourceReader!(async () => undefined)).rejects.toMatchObject({
      code: "invalid-scope",
    });
  });
});
