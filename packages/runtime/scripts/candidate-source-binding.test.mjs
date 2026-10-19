// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CANDIDATE_SOURCES_DIRECTORY,
  CandidateSourceBindingError,
  verifyCandidateSource,
} from "./candidate-source-binding.mjs";

// Runnable with `node --test` and collectable by Vitest.
const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");

const SOURCE = `${CANDIDATE_SOURCES_DIRECTORY}/candidates/generation-example.json`;
const BYTES = '{"profileId":"generation-example"}\n';
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

async function withRepository(run) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-candidate-source-"));
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  try {
    write(SOURCE, BYTES);
    write("governance/model-profiles/candidates/generation-example.json", BYTES);
    await run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the candidate source to be refused");
}

describe("verifyCandidateSource", () => {
  it("accepts a source under model-compositions/sources whose bytes match the pin", async () => {
    await withRepository(async (root) => {
      await verifyCandidateSource({ repositoryRoot: root, locator: SOURCE, sha256: DIGEST });
    });
  });

  it("refuses a locator in an internal-only tree, naming the locator", async () => {
    await withRepository(async (root) => {
      const locator = "governance/model-profiles/candidates/generation-example.json";
      const error = await refusal(
        verifyCandidateSource({ repositoryRoot: root, locator, sha256: DIGEST }),
      );
      assert.ok(error instanceof CandidateSourceBindingError);
      assert.equal(error.code, "candidate-source-outside-runtime");
      assert.match(
        error.message,
        /^candidate-source-outside-runtime: candidate source governance\/model-profiles\/candidates\/generation-example\.json is outside packages\/runtime\/model-compositions\/sources\//u,
      );
    });
  });

  it("refuses a sibling that only shares the directory's name prefix", async () => {
    await withRepository(async (root, write) => {
      const locator = `${CANDIDATE_SOURCES_DIRECTORY}-extra/generation-example.json`;
      write(locator, BYTES);
      const error = await refusal(
        verifyCandidateSource({ repositoryRoot: root, locator, sha256: DIGEST }),
      );
      assert.equal(error.code, "candidate-source-outside-runtime");
    });
  });

  it("refuses a locator that climbs out of the directory", async () => {
    await withRepository(async (root) => {
      const locator = `${CANDIDATE_SOURCES_DIRECTORY}/../../../../governance/model-profiles/candidates/generation-example.json`;
      const error = await refusal(
        verifyCandidateSource({ repositoryRoot: root, locator, sha256: DIGEST }),
      );
      assert.equal(error.code, "candidate-source-outside-runtime");
    });
  });

  it("refuses a link inside the directory that resolves outside it", async () => {
    await withRepository(async (root) => {
      const locator = `${CANDIDATE_SOURCES_DIRECTORY}/candidates/linked.json`;
      symlinkSync(
        join(root, "governance/model-profiles/candidates/generation-example.json"),
        join(root, locator),
      );
      const error = await refusal(
        verifyCandidateSource({ repositoryRoot: root, locator, sha256: DIGEST }),
      );
      assert.equal(error.code, "candidate-source-outside-runtime");
      assert.match(error.message, /linked\.json resolves outside/u);
    });
  });

  it("names an absent source as missing, with its locator", async () => {
    await withRepository(async (root) => {
      const locator = `${CANDIDATE_SOURCES_DIRECTORY}/candidates/absent.json`;
      const error = await refusal(
        verifyCandidateSource({ repositoryRoot: root, locator, sha256: DIGEST }),
      );
      assert.equal(error.code, "candidate-source-missing");
      assert.match(error.message, /candidates\/absent\.json does not exist/u);
    });
  });

  it("does not report a path through a file as missing", async () => {
    await withRepository(async (root) => {
      // ENOTDIR, not ENOENT: the missing-source branch must not claim it.
      const error = await refusal(
        verifyCandidateSource({
          repositoryRoot: root,
          locator: `${SOURCE}/nested.json`,
          sha256: DIGEST,
        }),
      );
      assert.equal(error instanceof CandidateSourceBindingError, false);
      assert.equal(error.code, "ENOTDIR");
    });
  });

  it("refuses bytes that no longer match the pinned digest", async () => {
    await withRepository(async (root, write) => {
      write(SOURCE, `${BYTES}\n`);
      const error = await refusal(
        verifyCandidateSource({ repositoryRoot: root, locator: SOURCE, sha256: DIGEST }),
      );
      assert.equal(error.code, "candidate-source-digest-stale");
      assert.match(error.message, /candidate source digest is stale: packages\/runtime\//u);
    });
  });
});
