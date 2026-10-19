// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ArtifactMigrationRegistry,
  ArtifactValidationError,
  canonicalArtifactDigest,
  migrateArtifact,
} from "../src/artifacts/index.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const invalidRoot = resolve(projectRoot, "test/fixtures/runtime-evaluation/artifacts/invalid");
const NOW = new Date("2026-08-03T16:00:00.000Z");
const index: ContentIndexV1 = {
  schemaVersion: 1,
  repository: {
    revision: "a".repeat(40),
    contentDigest: "b".repeat(64),
  },
  indexDigest: "c".repeat(64),
  nodes: [],
  edges: [],
  evidence: {
    repositoryRevision: "a".repeat(40),
    contentDigest: "b".repeat(64),
    indexDigest: "c".repeat(64),
    documentCount: 0,
    sectionCount: 0,
    edgeCount: 0,
  },
};
const validation = { index, now: NOW };

describe("artifact schema migrations", () => {
  it("applies the registered additive v0 to v1 migration deterministically", async () => {
    const legacy = JSON.parse(
      await readFile(resolve(invalidRoot, "legacy-v0-additive.json"), "utf8"),
    ) as Record<string, unknown>;

    const first = migrateArtifact(legacy, { validation });
    const second = migrateArtifact(structuredClone(legacy), { validation });

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.digest).toBe(canonicalArtifactDigest(first));
    expect(first.payload).toEqual(legacy.payload);
  });

  it("strictly validates migrated current-version output", async () => {
    const legacy = JSON.parse(
      await readFile(resolve(invalidRoot, "legacy-v0-additive.json"), "utf8"),
    ) as Record<string, unknown>;
    const payload = legacy.payload as Record<string, unknown>;
    payload.untrusted = true;

    expectMigrationError(() => migrateArtifact(legacy, { validation }), "unknown-field");
  });

  it("requires explicit opt-in for a registered breaking migration", async () => {
    const legacy = JSON.parse(
      await readFile(resolve(invalidRoot, "legacy-v0-breaking.json"), "utf8"),
    ) as Record<string, unknown>;
    const registry = new ArtifactMigrationRegistry();
    registry.register({
      kind: "legacy-navigation-evaluation",
      fromVersion: 0,
      toVersion: 1,
      compatibility: "breaking",
      migrate: (value) => {
        const migrated = {
          ...value,
          kind: "navigation-evaluation",
          schemaVersion: 1,
          payload: {
            tasks: [],
            results: [],
            metrics: {
              taskCount: 0,
              agreementRate: 0,
              recallAt3: 0,
              meanReciprocalRank: 0,
              noResultRate: 0,
              ambiguousPlacementRate: 0,
            },
          },
        };
        return { ...migrated, digest: canonicalArtifactDigest(migrated) };
      },
    });

    expectMigrationError(
      () => migrateArtifact(legacy, { registry, validation }),
      "breaking-migration-required",
    );
    const migrated = migrateArtifact(legacy, { registry, allowBreaking: true, validation });
    expect(migrated).toMatchObject({ kind: "navigation-evaluation", schemaVersion: 1 });
    expect(migrated.digest).toBe(canonicalArtifactDigest(migrated));
  });

  it("rejects future schema versions instead of guessing a downgrade", async () => {
    const future = JSON.parse(
      await readFile(resolve(invalidRoot, "future-schema.json"), "utf8"),
    ) as unknown;
    expectMigrationError(() => migrateArtifact(future, { validation }), "future-version");
  });
});

function expectMigrationError(
  operation: () => unknown,
  code: ArtifactValidationError["code"],
): void {
  try {
    operation();
    throw new Error(`Expected artifact migration to fail with ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactValidationError);
    expect((error as ArtifactValidationError).code).toBe(code);
  }
}
