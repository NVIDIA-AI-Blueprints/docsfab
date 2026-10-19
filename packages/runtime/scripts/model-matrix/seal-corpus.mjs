#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reseal a model-matrix corpus after an intended content change.
 *
 *   npm run seal:model-matrix-corpus -- <corpus-dir>
 *
 * First the fixture's accepted knowledge snapshot is resealed through the
 * product's own `createKnowledgeAcceptedSnapshot`, then every manifest digest
 * is recomputed from the bytes on disk, then the result is verified by
 * loading and materializing it. No digest is ever computed by hand.
 *
 * Runs under `node --import tsx` because the snapshot module is TypeScript.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createKnowledgeAcceptedSnapshot,
  decodeKnowledgeAcceptedSnapshot,
} from "../../src/canon/from-knowledge-snapshot.ts";
import { loadCorpus, materializeCorpus, sealCorpus } from "./corpus.mjs";

const SNAPSHOT_PATH = ".docsfab/reference-model/knowledge-accepted-snapshot.json";

/** Reseal the snapshot body in place, changing only the seal value's bytes. */
export async function resealKnowledgeSnapshot(template) {
  const path = join(template, SNAPSHOT_PATH);
  if (!existsSync(path)) return { path, changed: false, present: false };
  const text = await readFile(path, "utf8");
  const {
    snapshotSha256: previous,
    schemaVersion: _version,
    kind: _kind,
    ...body
  } = JSON.parse(text);
  const sealed = createKnowledgeAcceptedSnapshot(body).snapshotSha256;
  if (sealed === previous) return { path, changed: false, present: true };
  const next = text.replace(`"snapshotSha256": "${previous}"`, `"snapshotSha256": "${sealed}"`);
  if (next === text) {
    throw new Error(`${path}: could not locate its snapshotSha256 value to reseal.`);
  }
  decodeKnowledgeAcceptedSnapshot(JSON.parse(next));
  await writeFile(path, next);
  return { path, changed: true, present: true, previous, sealed };
}

async function main() {
  const corpusDir = process.argv[2];
  if (!corpusDir || process.argv.length > 3) {
    throw new Error("usage: seal-corpus.mjs <corpus-dir>");
  }
  const dir = resolve(corpusDir);
  const previous = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const snapshot = await resealKnowledgeSnapshot(join(dir, previous.repository.templatePath));
  const manifest = await sealCorpus(dir);
  const corpus = await loadCorpus(dir);
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "model-matrix-verify-"));
  try {
    await materializeCorpus(corpus, join(scratch, "repository"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify(
      {
        corpusId: manifest.id,
        revision: manifest.repository.revision,
        manifestSha256: manifest.manifestSha256,
        knowledgeSnapshotResealed: snapshot.changed,
      },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
