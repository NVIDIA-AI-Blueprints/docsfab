// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import {
  readVerifiedQualityPackFiles,
  verifyQualityPackContext,
} from "../src/quality-pack/manifest.js";
import { catalogSkillDirectoryForStep } from "../src/skills/catalog-crate-selection.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(import.meta.dirname, "..");
const skillCrateDirectory = resolve(runtimeRoot, "skill-crate");
const qualityDirectory = resolve(runtimeRoot, "quality");
const qualityPackDirectory = resolve(runtimeRoot, "quality-pack");
const SRD_FORMAT_ASSET = "formats/requirements-document-format.md";
const temporaryDirectories = temporaryRoots();

describe("plan-documentation SRD format", () => {
  it("resolves the SRD format from the mounted quality pack, not the skill bundle", async () => {
    const step = getWorkflow("create-documentation").steps.find(
      (candidate) => candidate.skill === "plan-documentation",
    );
    expect(step).toBeDefined();
    const skillDirectory = await catalogSkillDirectoryForStep({ skillCrateDirectory, step: step! });
    const pack = await verifyQualityPackContext({
      qualityPackDirectory,
      qualityDirectory,
      skillCrateDirectory,
    });
    const [locked, ...extra] = await readVerifiedQualityPackFiles(pack, SRD_FORMAT_ASSET);
    expect(extra).toEqual([]);

    // One copy: the format is Pin C quality content, absent from the Pin B skill.
    const planSkill = pack.skillLock.skills.find((skill) => skill.id === "plan-documentation");
    expect(planSkill?.files.map((file) => file.path)).not.toContain(
      "references/requirements-document-format.md",
    );

    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");
    const targets = new Set(
      [...skill.matchAll(/\]\(([^)\s]*requirements-document-format\.md)\)/gu)].map(
        (match) => match[1]!,
      ),
    );
    expect([...targets]).toEqual([`../../quality/${SRD_FORMAT_ASSET}`]);

    // Follow the link the way the model does: relative to the mounted skill
    // root, through the read tool the planning step is granted.
    const workspace = await temporaryDirectories.create("docsfab-plan-srd-format-");
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      governedSkill: { id: "plan-documentation", directory: skillDirectory },
      governedQualityDirectory: pack.qualityRoot,
    });
    const mountedPath = posix.normalize(
      posix.join(toolSet.governedSkillVirtualPath!, [...targets][0]!),
    );
    expect(mountedPath).toBe(`${toolSet.governedQualityVirtualPath}/${SRD_FORMAT_ASSET}`);
    const read = toolSet.definitions.find((tool) => tool.name === "read")!;
    const result = (await read.execute(
      "srd-format",
      { path: mountedPath },
      undefined,
      undefined,
      undefined as never,
    )) as { content: Array<{ type: string; text?: string }> };
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    expect(text).toBe(locked!.bytes.toString("utf8"));
    expect(text).toContain("## Requirements and acceptance checks");
    expect(text).not.toContain("NVIDIA");
    expect(toolSet.getFailureCategories()).toEqual([]);
  });
});
