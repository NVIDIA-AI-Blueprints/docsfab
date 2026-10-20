// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KnowledgeBackend } from "../src/backend.mjs";
import { KnowledgeStore } from "../src/store.mjs";

const roots = [];
test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docsfab-knowledge-private-"));
  roots.push(root);
  return root;
}

async function mode(path) {
  return (await lstat(path)).mode & 0o777;
}

for (const umask of [0o0000, 0o0002]) {
  test(`knowledge persistence is private under umask ${umask.toString(8)}`, async () => {
    const root = await fixture();
    const previous = process.umask(umask);
    try {
      const directory = join(root, "new-parent", "knowledge");
      const store = new KnowledgeStore(directory);
      await store.initialize();
      const backend = new KnowledgeBackend(store);
      await backend.dispatch("project.activate", {
        expectedVersion: 0,
        actor: "test-operator",
        input: {
          name: "Example Product",
          productVersion: "Preview",
          outcome: "Ground a documentation brief",
          audience: "Documentation team",
          targetTask: "Document the product",
          authority: {
            requesterEntitlement: "Contribute",
            repositoryGrant: "Observe",
            workflowPolicy: "Contribute",
            backendCapability: "Contribute",
          },
          policy: { localOnly: true },
        },
      });
      const artifact = await store.writeArtifact("PRJ-001", "ART-001", "txt", "private artifact\n");
      for (const path of [join(root, "new-parent"), directory, join(directory, "artifacts"), join(directory, "artifacts", "PRJ-001")]) {
        assert.equal(await mode(path), 0o700, path);
      }
      for (const path of [join(directory, "events.jsonl"), join(directory, artifact.path)]) {
        assert.equal(await mode(path), 0o600, path);
      }
      assert.equal(await readFile(join(directory, artifact.path), "utf8"), "private artifact\n");
      const recovered = new KnowledgeStore(directory);
      await recovered.initialize();
      assert.equal(recovered.getEvents().length, 1);
    } finally {
      process.umask(previous);
    }
  });
}

test("knowledge refuses an existing broad root without changing saved bytes", async () => {
  const root = await fixture();
  const directory = join(root, "knowledge");
  const store = new KnowledgeStore(directory);
  await store.initialize();
  const eventPath = join(directory, "events.jsonl");
  const before = await readFile(eventPath);
  await chmod(directory, 0o777);
  await assert.rejects(new KnowledgeStore(directory).initialize(), /knowledge|private|permission|state|unsafe/i);
  assert.deepEqual(await readFile(eventPath), before);
  assert.equal(await mode(directory), 0o777);
});

test("knowledge refuses a symlink root and a hard-linked event file", async () => {
  const root = await fixture();
  const foreign = join(root, "foreign");
  await new KnowledgeStore(foreign).initialize();
  const target = join(root, "linked");
  await symlink(foreign, target);
  await assert.rejects(new KnowledgeStore(target).initialize());
  const other = join(root, "second-link");
  await link(join(foreign, "events.jsonl"), other);
  await assert.rejects(new KnowledgeStore(foreign).initialize());
  assert.equal((await lstat(other)).nlink, 2);
});

test("knowledge artifact replacement preserves safe bytes and refuses a hard-linked destination", async () => {
  const root = await fixture();
  const store = new KnowledgeStore(join(root, "knowledge"));
  await store.initialize();
  const first = await store.writeArtifact("PRJ-001", "ART-001", "txt", "first\n");
  const destination = join(store.dataDirectory, first.path);
  await store.writeArtifact("PRJ-001", "ART-001", "txt", "second\n");
  assert.equal(await readFile(destination, "utf8"), "second\n");
  assert.equal(await mode(destination), 0o600);
  const other = join(root, "second-link");
  await link(destination, other);
  await assert.rejects(store.writeArtifact("PRJ-001", "ART-001", "txt", "third\n"));
  assert.equal(await readFile(destination, "utf8"), "second\n");
  assert.equal(await readFile(other, "utf8"), "second\n");
});

test("knowledge support replacement refuses an unsafe existing destination", async () => {
  const root = await fixture();
  const store = new KnowledgeStore(join(root, "knowledge"));
  await store.initialize();
  await store.writePrivateFile("docsfab-first-pass-support.json", "safe\n");
  const destination = join(store.dataDirectory, "docsfab-first-pass-support.json");
  await chmod(destination, 0o666);
  await assert.rejects(store.writePrivateFile("docsfab-first-pass-support.json", "replacement\n"));
  assert.equal(await readFile(destination, "utf8"), "safe\n");
  assert.equal(await mode(destination), 0o666);
  const foreign = join(root, "foreign-file");
  await writeFile(foreign, "foreign\n", { mode: 0o600 });
  const linked = join(store.dataDirectory, "documentation-partial.json");
  await symlink(foreign, linked);
  await assert.rejects(store.writePrivateFile("documentation-partial.json", "replacement\n"));
  assert.equal(await readFile(foreign, "utf8"), "foreign\n");
});
