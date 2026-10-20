// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readCatalogSkillCrateLock } from "../src/skills/catalog-crate.js";
import {
  PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS,
  ROADMAP_SKILL_PACK_CONTRACTS,
  ROADMAP_SKILL_PACK_IDS,
} from "../src/skills/roadmap-pack.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");

describe("roadmap skill packs", () => {
  it("does not include parked roadmap adapters in the production catalog crate", async () => {
    const ids = new Set(
      (await readCatalogSkillCrateLock(skillCrateDirectory)).skills.map((skill) => skill.id),
    );
    for (const id of ROADMAP_SKILL_PACK_IDS) {
      expect(ids.has(id as never)).toBe(false);
    }
  });
});

// Pins the pre-removal-attestation status of the three `contractSha256`
// values that were not recomputed when `save_execute.py` left the
// `roadmap-helpers-repository-license` bundle. See
// `PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS` in `roadmap-pack.ts`.
describe("pre-removal contractSha256 attestations (Task #1449)", () => {
  const preRemovalIds = ["doc-fix-issues", "doc-session-insights", "doc-pr-auto-sync"] as const;

  it("covers exactly the three packs left unrecomputed by the bundle removal", () => {
    expect(Object.keys(PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS).sort()).toEqual(
      [...preRemovalIds].sort(),
    );
    // `release-docs-epic` was recomputed against the current bundle and must
    // not be added here.
    expect(
      Object.prototype.hasOwnProperty.call(
        PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS,
        "release-docs-epic",
      ),
    ).toBe(false);
  });

  it.each(preRemovalIds)(
    "%s's shipped contractSha256 is still pinned to its pre-removal value",
    (id) => {
      // Regenerating this pack's real contractSha256 changes the left-hand side,
      // so that change must also touch PRE_REMOVAL_ROADMAP_SKILL_PACK_ATTESTATIONS
      // (or remove this test) rather than leave a stale attestation behind.
      expect(ROADMAP_SKILL_PACK_CONTRACTS[id].contractSha256).toBe(expectedPreRemovalContract[id]);
    },
  );
});

const expectedPreRemovalContract: Record<
  Exclude<(typeof ROADMAP_SKILL_PACK_IDS)[number], "release-docs-epic">,
  string
> = {
  "doc-fix-issues": "967c149e2cae2654371b21ef52a77698b6ea55411c4202fd3f110a27627b8f53",
  "doc-session-insights": "d162a3d9a7c4f9b5c89e6e82e85065c8884e6d457347c44fee0a29f459e25d5a",
  "doc-pr-auto-sync": "ef0e84700cbdc45e0b8c5d1716fcdbe74e4fcf9bbcfb9a6aa402ff094456ff31",
};
