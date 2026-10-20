// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_OBJECT_BOUND_CODE,
  ARTIFACT_OBJECT_LIMIT,
  ArtifactStoreError,
  canonicalArtifactDigest,
  canonicalArtifactJson,
  DurableArtifactStore,
} from "../src/artifacts/index.js";
import { limit, LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.js";
import { operatorCodeFailureClass } from "../src/operator/failure-classification.js";
import type { Artifact } from "../src/artifacts/index.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";
import { temporaryRoots } from "./helpers/temp.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const index: ContentIndexV1 = {
  schemaVersion: 1,
  repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
  indexDigest: "c".repeat(64),
  nodes: [],
  edges: [],
  evidence: {
    repositoryRevision: REVISION,
    contentDigest: CONTENT_DIGEST,
    indexDigest: "c".repeat(64),
    documentCount: 0,
    sectionCount: 0,
    edgeCount: 0,
  },
};
const validation = { index, now: new Date("2026-08-03T16:00:00.000Z") };
const roots = temporaryRoots();

describe("DurableArtifactStore", () => {
  it("reads an existing private record without changing its bytes or directory tree", async () => {
    const root = await roots.create("docsfab-artifacts-passive-");
    const record = { marker: "retained" };
    await new DurableArtifactStore(root).putRecord(DIGEST_A, record);
    const objectPath = join(root, "objects", "sha256", `${DIGEST_A}.json`);
    const before = await readFile(objectPath);
    const children = await readdir(join(root, "objects", "sha256"));

    await expect(
      new DurableArtifactStore(root).getRecord(DIGEST_A, { readOnly: true }),
    ).resolves.toEqual(record);
    expect(await readFile(objectPath)).toEqual(before);
    expect(await readdir(join(root, "objects", "sha256"))).toEqual(children);
  });

  it("does not create absent directories or repair permissive directories during a passive record read", async () => {
    if (process.platform === "win32") return;
    const parent = await roots.create("docsfab-artifacts-passive-");
    const root = join(parent, "store");
    const store = new DurableArtifactStore(root);
    await expectStoreError(store.getRecord(DIGEST_A, { readOnly: true }), "not-found");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(root, { mode: 0o700 });
    await expectStoreError(store.getRecord(DIGEST_A, { readOnly: true }), "not-found");
    expect(await readdir(root)).toEqual([]);

    await mkdir(join(root, "objects"), { mode: 0o700 });
    await expectStoreError(store.getRecord(DIGEST_A, { readOnly: true }), "not-found");
    expect(await readdir(join(root, "objects"))).toEqual([]);

    const record = { marker: "retained" };
    await store.putRecord(DIGEST_A, record);
    const objectPath = join(root, "objects", "sha256", `${DIGEST_A}.json`);
    const before = await readFile(objectPath);
    for (const directory of [root, join(root, "objects"), join(root, "objects", "sha256")]) {
      await chmod(directory, 0o755);
      await expectStoreError(store.getRecord(DIGEST_A, { readOnly: true }), "insecure-permissions");
      expect((await lstat(directory)).mode & 0o7777).toBe(0o755);
      expect(await readFile(objectPath)).toEqual(before);
      await chmod(directory, 0o700);
    }
    await expect(store.getRecord(DIGEST_A, { readOnly: true })).resolves.toEqual(record);
  });

  it("refuses a passive record read after a directory changes during descriptor access", async () => {
    if (process.platform === "win32") return;
    const root = await roots.create("docsfab-artifacts-passive-");
    await new DurableArtifactStore(root).putRecord(DIGEST_A, { marker: "retained" });
    const objectDirectory = join(root, "objects", "sha256");
    const objectPath = join(objectDirectory, `${DIGEST_A}.json`);
    const before = await readFile(objectPath);
    const reader = new DurableArtifactStore(root, {
      beforeRead: async () => chmod(objectDirectory, 0o755),
    });

    await expectStoreError(reader.getRecord(DIGEST_A, { readOnly: true }), "unsafe-path");
    expect((await lstat(objectDirectory)).mode & 0o7777).toBe(0o755);
    expect(await readFile(objectPath)).toEqual(before);
  });

  it("atomically persists a private content-addressed artifact across store instances", async () => {
    const root = await roots.create("docsfab-artifacts-");
    const artifact = ontologyArtifact();
    const first = new DurableArtifactStore(root);

    await expect(first.put(artifact, validation)).resolves.toEqual({
      digest: artifact.digest,
      created: true,
    });
    await expect(first.put(artifact, validation)).resolves.toEqual({
      digest: artifact.digest,
      created: false,
    });

    const second = new DurableArtifactStore(root);
    await expect(second.get(artifact.digest, validation)).resolves.toEqual(artifact);
    await expect(second.has(artifact.digest)).resolves.toBe(true);

    const objectDirectory = join(root, "objects", "sha256");
    const objectPath = join(objectDirectory, `${artifact.digest}.json`);
    expect(await readFile(objectPath, "utf8")).toBe(canonicalArtifactJson(artifact));
    expect(await readdir(objectDirectory)).toEqual([`${artifact.digest}.json`]);
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(objectDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(objectPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("carries a real IA plan artifact without depending on process-local state", async () => {
    const root = await roots.create("docsfab-artifacts-");
    const fixture = JSON.parse(
      await readFile(
        join(projectRoot, "test/fixtures/runtime-evaluation/artifacts/v1/ia-plan.json"),
        "utf8",
      ),
    ) as Artifact;

    await new DurableArtifactStore(root).put(fixture);
    const restored = await new DurableArtifactStore(root).get(fixture.digest);

    expect(restored).toEqual(JSON.parse(canonicalArtifactJson(fixture)));
    expect(restored.kind).toBe("ia-plan");
  });

  it("rejects unbounded digest paths before resolving an object", async () => {
    const store = new DurableArtifactStore(await roots.create("docsfab-artifacts-"));
    await expectStoreError(store.get("../../outside"), "invalid-digest");
    await expectStoreError(store.get("A".repeat(64)), "invalid-digest");
  });

  it("does not follow a store root or artifact object symlink", async () => {
    const parent = await roots.create("docsfab-artifacts-");
    const realRoot = join(parent, "real");
    const linkedRoot = join(parent, "linked");
    await mkdir(realRoot, { mode: 0o700 });
    await symlink(realRoot, linkedRoot, "dir");
    await expectStoreError(new DurableArtifactStore(linkedRoot).initialize(), "symlink");
    await expectStoreError(
      new DurableArtifactStore(linkedRoot).getRecord(DIGEST_A, { readOnly: true }),
      "symlink",
    );

    const artifact = ontologyArtifact();
    const storeRoot = join(parent, "store");
    const store = new DurableArtifactStore(storeRoot);
    await store.initialize();
    const external = join(parent, "external.json");
    await writeFile(external, canonicalArtifactJson(artifact), { mode: 0o600 });
    await symlink(external, join(storeRoot, "objects", "sha256", `${artifact.digest}.json`));
    await expectStoreError(store.get(artifact.digest), "symlink");
    await expectStoreError(store.getRecord(artifact.digest, { readOnly: true }), "symlink");
  });

  it("rejects a symlinked ancestor before reading or creating private artifacts", async () => {
    const parent = await roots.create("docsfab-artifacts-");
    const real = join(parent, "real");
    const linked = join(parent, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked, "dir");
    const root = join(linked, "private", "artifacts");
    const store = new DurableArtifactStore(root);
    const artifact = ontologyArtifact("ancestor-link");

    await expectStoreError(store.put(artifact), "symlink");
    await expectStoreError(store.get(artifact.digest), "symlink");
    await expectStoreError(store.getRecord(DIGEST_A, { readOnly: true }), "symlink");
    await expect(lstat(join(real, "private"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a root replacement after opening an object instead of returning its bytes", async () => {
    const parent = await roots.create("docsfab-artifacts-");
    const root = join(parent, "artifacts");
    const displaced = join(parent, "displaced");
    const attacker = join(parent, "attacker");
    const artifact = ontologyArtifact("read-root-swap");
    await new DurableArtifactStore(root).put(artifact);
    const attackerObjectDirectory = join(attacker, "objects", "sha256");
    await mkdir(attackerObjectDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(attackerObjectDirectory, `${artifact.digest}.json`),
      canonicalArtifactJson(artifact),
      { mode: 0o600 },
    );
    const reader = new DurableArtifactStore(root, {
      beforeRead: async () => {
        await rename(root, displaced);
        await symlink(attacker, root, "dir");
      },
    });

    await expectStoreError(reader.get(artifact.digest), "unsafe-path");
  });

  it("refuses a passive record read when the store root is replaced after opening the object", async () => {
    const parent = await roots.create("docsfab-artifacts-passive-swap-");
    const root = join(parent, "artifacts");
    const displaced = join(parent, "displaced");
    const attacker = join(parent, "attacker");
    const record = { marker: "retained" };
    await new DurableArtifactStore(root).putRecord(DIGEST_A, record);
    const savedPath = join(root, "objects", "sha256", `${DIGEST_A}.json`);
    const savedBytes = await readFile(savedPath);
    await mkdir(join(attacker, "objects", "sha256"), { recursive: true, mode: 0o700 });
    const reader = new DurableArtifactStore(root, {
      beforeRead: async () => {
        await rename(root, displaced);
        await symlink(attacker, root, "dir");
      },
    });

    await expectStoreError(reader.getRecord(DIGEST_A, { readOnly: true }), "unsafe-path");
    expect(await readFile(join(displaced, "objects", "sha256", `${DIGEST_A}.json`))).toEqual(
      savedBytes,
    );
    expect(await readdir(join(attacker, "objects", "sha256"))).toEqual([]);
  });

  it("rejects object-directory replacement without redirected publication or cleanup", async () => {
    const root = await roots.create("docsfab-artifacts-");
    const objectDirectory = join(root, "objects", "sha256");
    const displaced = join(root, "objects", "displaced-sha256");
    const artifact = ontologyArtifact("object-directory-swap");
    let externalTemporary = "";
    const store = new DurableArtifactStore(root, {
      id: () => "object-swap",
      beforeCommit: async (temporary) => {
        await rename(objectDirectory, displaced);
        await mkdir(objectDirectory, { mode: 0o700 });
        externalTemporary = join(objectDirectory, basename(temporary));
        await writeFile(externalTemporary, "attacker sentinel\n", { mode: 0o600 });
      },
    });

    await expectStoreError(store.put(artifact), "unsafe-path");
    expect(await readFile(externalTemporary, "utf8")).toBe("attacker sentinel\n");
    await expect(lstat(join(objectDirectory, `${artifact.digest}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(join(displaced, `.${artifact.digest}.object-swap.tmp`))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("rejects object-directory permission drift during a pinned read", async () => {
    const root = await roots.create("docsfab-artifacts-");
    const artifact = ontologyArtifact("mode-drift");
    await new DurableArtifactStore(root).put(artifact);
    const objectDirectory = join(root, "objects", "sha256");
    const reader = new DurableArtifactStore(root, {
      beforeRead: async () => chmod(objectDirectory, 0o755),
    });

    await expectStoreError(reader.get(artifact.digest), "unsafe-path");
  });

  it("rejects insecure store or object permissions", async () => {
    if (process.platform === "win32") return;
    const root = await roots.create("docsfab-artifacts-");
    await chmod(root, 0o755);
    await expectStoreError(new DurableArtifactStore(root).initialize(), "insecure-permissions");

    await chmod(root, 0o700);
    const store = new DurableArtifactStore(root);
    const artifact = ontologyArtifact();
    await store.put(artifact);
    await chmod(join(root, "objects", "sha256", `${artifact.digest}.json`), 0o644);
    await expectStoreError(store.get(artifact.digest), "insecure-permissions");
  });

  it("detects malformed, non-canonical, and digest-mismatched object contents", async () => {
    const root = await roots.create("docsfab-artifacts-");
    const artifact = ontologyArtifact();
    const store = new DurableArtifactStore(root);
    await store.put(artifact);
    const objectPath = join(root, "objects", "sha256", `${artifact.digest}.json`);

    await writeFile(objectPath, "{", { mode: 0o600 });
    await expectStoreError(store.get(artifact.digest), "invalid-json");

    await writeFile(objectPath, `${canonicalArtifactJson(artifact)}\n`, { mode: 0o600 });
    await expectStoreError(store.get(artifact.digest), "integrity-mismatch");

    const changed = ontologyArtifact("changed");
    await writeFile(objectPath, canonicalArtifactJson(changed), { mode: 0o600 });
    await expectStoreError(store.get(artifact.digest), "integrity-mismatch");
  });

  it("bounds both writes and reads", async () => {
    const artifact = ontologyArtifact("bounded");
    const maximum = Buffer.byteLength(canonicalArtifactJson(artifact)) - 1;
    const root = await roots.create("docsfab-artifacts-");
    const store = new DurableArtifactStore(root, { maxArtifactBytes: maximum });
    await expectStoreError(store.put(artifact), "artifact-too-large");

    const normal = new DurableArtifactStore(root);
    await normal.put(artifact);
    await expectStoreError(store.get(artifact.digest), "artifact-too-large");
  });
});

describe("artifacts.maxObjectBytes", () => {
  const OVERRIDE = "DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES";
  const SERVICE_ENV = "DOCSFAB_SERVICE_ENV_FILE";
  afterEach(() => {
    delete process.env[OVERRIDE];
    delete process.env[SERVICE_ENV];
  });

  it("applies the catalogued 128 MiB default, which a host can raise, when a caller names no bound", async () => {
    const definition = LIMIT_DEFINITION_BY_NAME[ARTIFACT_OBJECT_LIMIT]!;
    expect(definition).toMatchObject({
      value: 134_217_728,
      unit: "bytes",
      override: OVERRIDE,
      refusal: ARTIFACT_OBJECT_BOUND_CODE,
    });
    expect(definition.max).toBeGreaterThan(definition.value);
    const root = await roots.create("docsfab-artifacts-bound-");
    expect(new DurableArtifactStore(root).maxObjectBytes).toBe(definition.value);
    expect(new DurableArtifactStore(root, { maxArtifactBytes: 512 }).maxObjectBytes).toBe(512);
  });

  it("stores an object at a lowered bound and refuses one byte more by the bound's own code", async () => {
    process.env[OVERRIDE] = "65536";
    const root = await roots.create("docsfab-artifacts-bound-");
    const store = new DurableArtifactStore(root);
    const atLimit = recordOfBytes(65_536);
    await expect(store.putRecord(DIGEST_A, atLimit)).resolves.toMatchObject({ created: true });
    await expect(store.getRecord(DIGEST_A)).resolves.toEqual(atLimit);

    const refusal = await store.putRecord(DIGEST_B, recordOfBytes(65_537)).catch((error) => error);
    expect(refusal).toBeInstanceOf(ArtifactStoreError);
    expect(refusal).toMatchObject({
      code: "artifacts-max-object-bytes-bound",
      limitName: "artifacts.maxObjectBytes",
      configured: 65_536,
      observed: 65_537,
    });
    expect((refusal as Error).message).toContain(
      "artifacts-max-object-bytes-bound: 65537 exceeds artifacts.maxObjectBytes = 65536 bytes. Raise DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES",
    );
    expect((refusal as Error).message).not.toContain("(artifact-too-large)");
    await expect(store.has(DIGEST_B)).resolves.toBe(false);
  });

  it("refuses to read an object over a lowered bound and names its observed size", async () => {
    const root = await roots.create("docsfab-artifacts-bound-");
    await new DurableArtifactStore(root).putRecord(DIGEST_A, recordOfBytes(100_000));
    process.env[OVERRIDE] = "65536";
    await expect(new DurableArtifactStore(root).getRecord(DIGEST_A)).rejects.toMatchObject({
      code: "artifacts-max-object-bytes-bound",
      configured: 65_536,
      observed: 100_000,
    });
  });

  it("honors an upward override over a lower host file value and above the catalog default", async () => {
    const root = await roots.create("docsfab-artifacts-bound-");
    const serviceEnv = join(root, "service.env");
    await writeFile(serviceEnv, "artifacts.maxObjectBytes=65536\n", { mode: 0o600 });
    process.env[SERVICE_ENV] = serviceEnv;
    const store = join(root, "store");
    await expect(
      new DurableArtifactStore(store).putRecord(DIGEST_A, recordOfBytes(100_000)),
    ).rejects.toMatchObject({ code: "artifacts-max-object-bytes-bound", observed: 100_000 });

    process.env[OVERRIDE] = "131072";
    await expect(
      new DurableArtifactStore(store).putRecord(DIGEST_A, recordOfBytes(100_000)),
    ).resolves.toMatchObject({ created: true });

    process.env[OVERRIDE] = "268435456";
    expect(limit(ARTIFACT_OBJECT_LIMIT)).toMatchObject({ value: 268_435_456, source: "host" });
    expect(new DurableArtifactStore(store).maxObjectBytes).toBe(268_435_456);

    process.env[OVERRIDE] = "536870888";
    expect(() => new DurableArtifactStore(store)).toThrow(
      "DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES must be an integer between 4096 and 536870887.",
    );
  });

  it("classifies the object bound refusal as a bound stop", () => {
    expect(operatorCodeFailureClass(ARTIFACT_OBJECT_BOUND_CODE)).toBe("bound");
  });
});

const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);

/** An opaque record whose stored JSON, `{"pad":"x..."}`, is exactly `bytes` long. */
function recordOfBytes(bytes: number): { pad: string } {
  return { pad: "x".repeat(bytes - Buffer.byteLength('{"pad":""}')) };
}

function ontologyArtifact(label?: string): Artifact {
  const value = {
    schemaVersion: 1 as const,
    kind: "ontology" as const,
    repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
    digest: "0".repeat(64),
    payload: {
      entities:
        label === undefined
          ? []
          : [
              {
                id: `concept:${label}`,
                label,
                kind: "concept" as const,
                evidence: [],
              },
            ],
      relationships: [],
    },
  };
  value.digest = canonicalArtifactDigest(value);
  return value;
}

async function expectStoreError(
  operation: Promise<unknown>,
  code: ArtifactStoreError["code"],
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected artifact store to fail with ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect((error as ArtifactStoreError).code).toBe(code);
  }
}
