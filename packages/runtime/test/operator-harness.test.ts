// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJsonEvidence,
  parsePrivateJsonEvidence,
  readPrivateJsonEvidenceLeaf,
  serializePrivateJsonEvidence,
  sha256PrivateJsonEvidence,
} from "../src/operator/json-evidence.js";
import {
  assertPrivateOperatorEvidenceDirectory,
  ensurePinnedPrivateOperatorRoot,
  preparePrivateOperatorRoot,
  publishCollectableOperatorEvidence,
} from "../src/operator/private-state.js";

async function privateFixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

describe("operator private-state helpers", () => {
  it("prepares an owner-private root outside the repository", async () => {
    const repository = await privateFixtureRoot("docsfab-op-repo-");
    const parent = await privateFixtureRoot("docsfab-op-parent-");
    await mkdir(join(repository, ".git"));
    const requested = join(parent, "evidence");

    const pinned = await preparePrivateOperatorRoot({
      requestedPath: requested,
      repositoryRoot: repository,
      label: "--evidence-dir",
    });

    expect(pinned.path).toBe(requested);
    await assertPrivateOperatorEvidenceDirectory(pinned);

    const again = await ensurePinnedPrivateOperatorRoot(requested);
    expect(again.dev).toBe(pinned.dev);
    expect(again.ino).toBe(pinned.ino);
  });

  it("rejects a requested root inside the repository", async () => {
    const repository = await privateFixtureRoot("docsfab-op-repo-");
    await mkdir(join(repository, ".git"));

    await expect(
      preparePrivateOperatorRoot({
        requestedPath: join(repository, "inside"),
        repositoryRoot: repository,
        label: "--state-dir",
      }),
    ).rejects.toThrow(/outside the source repository/u);
  });
});

describe("operator collectable-evidence helpers", () => {
  it("publishes minimized evidence inside the repository without relaxing private roots", async () => {
    const repository = await privateFixtureRoot("docsfab-op-repo-");
    const parent = await privateFixtureRoot("docsfab-op-parent-");
    try {
      await mkdir(join(repository, ".git"));
      const state = await preparePrivateOperatorRoot({
        requestedPath: join(parent, "state"),
        repositoryRoot: repository,
        label: "--state-dir",
      });
      const collect = join(repository, "ci-results", "live-model");
      const value = { schemaVersion: 1, passed: true, records: [] };

      const published = await publishCollectableOperatorEvidence({
        requestedPath: collect,
        privateRoots: [state.path],
        label: "--collect-dir",
        invocationId: "acceptance-one",
        file: "manifest.json",
        value,
        environment: { MODEL_API_KEY: "collectable-harness-secret" },
      });

      expect(published).toBe(join(collect, "acceptance-one", "manifest.json"));
      expect(JSON.parse(await readFile(published, "utf8"))).toEqual(value);
      // Exclusive publication never overwrites an earlier collection.
      await expect(
        publishCollectableOperatorEvidence({
          requestedPath: collect,
          privateRoots: [state.path],
          label: "--collect-dir",
          invocationId: "acceptance-one",
          file: "manifest.json",
          value,
          environment: {},
        }),
      ).rejects.toThrow(/already-exists/u);
      // The private-state boundary is unchanged for the same location.
      await expect(
        preparePrivateOperatorRoot({
          requestedPath: collect,
          repositoryRoot: repository,
          label: "--state-dir",
        }),
      ).rejects.toThrow(/outside the source repository/u);
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses unsafe evidence before creating the destination", async () => {
    const repository = await privateFixtureRoot("docsfab-op-repo-");
    try {
      const collect = join(repository, "ci-results");
      for (const [invocationId, value, message] of [
        ["acceptance-one", { leaked: "collectable-harness-secret" }, /value of MODEL_API_KEY/u],
        ["..", { passed: true }, /single safe invocation directory name/u],
        ["nested/escape", { passed: true }, /single safe invocation directory name/u],
      ] as const) {
        await expect(
          publishCollectableOperatorEvidence({
            requestedPath: collect,
            privateRoots: [],
            label: "--collect-dir",
            invocationId,
            file: "manifest.json",
            value,
            environment: { MODEL_API_KEY: "collectable-harness-secret" },
          }),
        ).rejects.toThrow(message);
      }
      expect(await readdir(repository)).toEqual([]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

describe("operator JSON-evidence helpers", () => {
  it("parses and canonicalizes private JSON evidence without credentials", async () => {
    const value = parsePrivateJsonEvidence('{"ok":true,"n":1}\n');
    expect(value).toEqual({ ok: true, n: 1 });
    expect(serializePrivateJsonEvidence(value).toString("utf8")).toBe(
      canonicalizeJsonEvidence(value),
    );
    expect(sha256PrivateJsonEvidence(value)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reads a private evidence leaf with strict JSON-evidence rules", async () => {
    const repository = await privateFixtureRoot("docsfab-op-repo-");
    const parent = await privateFixtureRoot("docsfab-op-parent-");
    await mkdir(join(repository, ".git"));
    const pinned = await preparePrivateOperatorRoot({
      requestedPath: join(parent, "campaign"),
      repositoryRoot: repository,
      label: "--campaign-dir",
    });
    const payload = canonicalizeJsonEvidence({ schemaVersion: 1, kind: "fixture" });
    const leafPath = join(pinned.path, "declaration.json");
    const handle = await open(
      leafPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    const leaf = await readPrivateJsonEvidenceLeaf(pinned, "declaration.json");
    expect(leaf.value).toEqual({ schemaVersion: 1, kind: "fixture" });
    expect(leaf.bytes.equals(Buffer.from(payload, "utf8"))).toBe(true);
  });

  it("rejects duplicate keys in private JSON evidence", () => {
    expect(() => parsePrivateJsonEvidence('{"id":1,"id":2}')).toThrow(/duplicate-key/u);
  });
});
