// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { QualityPackError } from "../src/quality-pack/manifest.js";
import { listTemplates } from "../src/templates/catalog.js";
import {
  loadTemplateSet,
  prepareTemplateSet,
  resolveTemplateSet,
  type TemplateSetCapability,
} from "../src/templates/load.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qualitySourceRoot = resolve(projectRoot, "../quality");
const bundleId = "template-set-v1";
const pinCPrefix = "formats/template-set-v1";
const contentRevision = "97dd73cf5ee17704d05cb64e8ffc6dc871e9670900ab12c092c8a197ee3febfb";
const bundleSha256 = "ea013c43db06a329e7f025e814d1c02e72db285312b43e00e1d9bea8ae40a3a1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("canonical template set assets", { timeout: 30_000 }, () => {
  it("verifies the 1.0.0 GFM/MyST mechanics at the pinned content revision", async () => {
    const bundle = await loadTemplateSet(projectRoot);
    const catalog = listTemplates({ bundle });

    expect(bundle.evidence).toMatchObject({
      id: bundleId,
      version: "1.0.0",
      license: "Apache-2.0 AND CC-BY-4.0",
      bundleSha256,
      source: {
        repository: "https://github.com/NVIDIA-AI-Blueprints/docsfab.git",
        revision: contentRevision,
        path: "packages/quality/formats/template-set-v1",
      },
    });
    expect(bundle.evidence.files).toHaveLength(88);

    const hashes = new Map(bundle.evidence.files.map((file) => [file.path, file.sha256]));
    expect(hashes.get("REGISTRY.json")).toBe(
      "6a3b2e2108b450e594fc3e708641d970b8eb388f73870010b35d3031fba7009c",
    );
    expect(hashes.get("chains.yaml")).toBe(
      "9bec6e73bf489e7de18059ec82997c9800d60e8bfb6589b006b2447a2e62f498",
    );
    expect(hashes.get("tpl-new-site/assets/site-map.yaml")).toBe(
      "7de1886dd4e8bd3a02ef900e9f9a8a252793e638b4fe6c9cbfc341662d359b68",
    );
    expect(hashes.get("tpl-lint/scripts/validate.py")).toBe(
      "085f943bd7087e35bdc1f274d29e29bbd503cee7cffc376da9219de8eaff322c",
    );
    expect(hashes.get("LICENSE")).toBe(
      "79a6a78693f4e02b1f43837ceb014aefda32d319e4298425c7314465c26abe23",
    );
    expect(hashes.get("tpl-new-page/assets/templates/get-started/quickstart.md")).toBe(
      "9d24158a03283d8aceeef95bf889193aee0d282bdcd2e3be156d51e409cca78e",
    );
    expect(hashes.get("tpl-new-page/assets/templates/get-started/quickstart-gfm.md")).toBe(
      "b6d0ada9711dff72595a1ed53d1cc22e71dd8a5f0c7977a5ab26527feb1c62e1",
    );

    for (const skill of ["tpl-pick", "tpl-new-site", "tpl-new-page", "tpl-lint"]) {
      expect(hashes.has(`${skill}/SKILL.md`)).toBe(true);
    }
    const templates = bundle.evidence.files.filter((file) =>
      file.path.startsWith("tpl-new-page/assets/templates/"),
    );
    expect(templates.filter((file) => file.path.endsWith(".md"))).toHaveLength(54);
    expect(templates.some((file) => file.path.endsWith(".mdx"))).toBe(false);
    expect(templates.some((file) => file.path.endsWith(".rst"))).toBe(false);
    expect(hashes.has("tpl-lint/assets/schemas/quickstart.yaml")).toBe(true);
    expect(hashes.has("tpl-new-page/scripts/scaffold.py")).toBe(true);
    expect(hashes.has("tpl-new-site/scripts/site-scaffold.py")).toBe(true);
    expect(catalog.templates.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "installation-gfm",
        "installation-myst",
        "quickstart-gfm",
        "quickstart-myst",
        "troubleshooting-gfm",
      ]),
    );
  });

  it("keeps the local tpl-design-ia skill out of the template set registry", async () => {
    const bundle = await loadTemplateSet(projectRoot);
    const registry = JSON.parse(
      await readFile(resolve(qualitySourceRoot, pinCPrefix, "REGISTRY.json"), "utf8"),
    ) as { version: string; skills: Array<{ name: string }> };

    expect(registry.version).toBe("1.0.0");
    expect(registry.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["tpl-pick", "tpl-new-site", "tpl-new-page", "tpl-lint"]),
    );
    expect(registry.skills.some((skill) => skill.name === "tpl-design-ia")).toBe(false);
    expect(bundle.evidence.files.some((file) => file.path.includes("tpl-design-ia"))).toBe(false);
  });

  it("issues an opaque capability bound to the exact governed catalog", async () => {
    const capability = await prepareTemplateSet(projectRoot);
    const bundle = resolveTemplateSet(capability);
    const catalog = listTemplates({ bundle });

    expect(capability).toEqual({
      catalogDigest: catalog.digest,
      bundle: catalog.bundle,
    });
    expect(capability.catalogDigest).toBe(
      "7b6b8c9bdaa1843294bb016da4a6e75a1d26fac3ca5a5b87861ab160cf7ac23b",
    );
    expect(capability.bundle).toMatchObject({
      id: bundleId,
      version: "1.0.0",
      sourceRevision: contentRevision,
      bundleSha256,
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.bundle)).toBe(true);
    expect(JSON.stringify(capability)).not.toContain("Quickstart for");
    expect(resolveTemplateSet(capability)).toBe(bundle);
  });

  it("keeps every bundle value resolved from a capability deeply immutable", async () => {
    const capability = await prepareTemplateSet(projectRoot);
    const bundle = resolveTemplateSet(capability);
    const template = bundle.manifest.templates[0]!;
    const originalContent = template.template.content;

    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.manifest.templates)).toBe(true);
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.template)).toBe(true);
    expect(() => {
      (template.template as { content: string }).content = "mutated";
    }).toThrow(TypeError);
    expect(() => {
      (bundle.manifest.templates as unknown[]).push({});
    }).toThrow(TypeError);
    expect(resolveTemplateSet(capability).manifest.templates[0]!.template.content).toBe(
      originalContent,
    );
  });

  it("rejects forged or cloned template set capabilities", async () => {
    const capability = await prepareTemplateSet(projectRoot);
    const forgedValues: unknown[] = [
      undefined,
      {},
      Object.freeze({ ...capability }),
      Object.freeze({
        catalogDigest: capability.catalogDigest,
        bundle: capability.bundle,
      }) satisfies TemplateSetCapability,
    ];

    for (const forged of forgedValues) {
      expect(() => resolveTemplateSet(forged)).toThrow(
        "The template set capability is not governed by this module.",
      );
    }
  });

  it("fails closed on tampered, extra, and untracked Pin C template bytes", async () => {
    const tampered = await copiedRuntimeAssets();
    await writeFile(
      resolve(
        tampered,
        "quality",
        pinCPrefix,
        "tpl-new-page/assets/templates/get-started/quickstart.md",
      ),
      "tampered\n",
      "utf8",
    );
    await expect(loadTemplateSet(tampered)).rejects.toEqual(
      new QualityPackError("checksum-mismatch"),
    );

    const extra = await copiedRuntimeAssets();
    await writeFile(resolve(extra, "quality", pinCPrefix, "extra.md"), "extra\n", "utf8");
    await expect(loadTemplateSet(extra)).rejects.toEqual(new QualityPackError("file-set-mismatch"));
  });

  it("rejects a symlink substituted for a locked Pin C template asset", async () => {
    const root = await copiedRuntimeAssets();
    const asset = resolve(root, "quality", pinCPrefix, "tpl-new-site/assets/site-map.yaml");
    const outside = resolve(root, "unlocked-site-map.yaml");
    await writeFile(outside, "sections: {}\n", "utf8");
    await rm(asset);
    await symlink(outside, asset);

    await expect(loadTemplateSet(root)).rejects.toEqual(new QualityPackError("unsafe-path"));
  });

  it("refuses live sibling quality bytes and a missing generated Pin C payload", async () => {
    await expect(loadTemplateSet(qualitySourceRoot)).rejects.toEqual(
      new QualityPackError("lock-unavailable"),
    );

    const missingPack = await copiedRuntimeAssets();
    await rm(resolve(missingPack, "quality-pack"), { recursive: true, force: true });
    await expect(loadTemplateSet(missingPack)).rejects.toEqual(
      new QualityPackError("lock-unavailable"),
    );
  });
});

async function copiedRuntimeAssets(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "docsfab-template-assets-"));
  temporaryDirectories.push(root);
  await mkdir(resolve(root, "skill-crate"), { recursive: true });
  await Promise.all([
    cp(resolve(projectRoot, "quality"), resolve(root, "quality"), { recursive: true }),
    cp(resolve(projectRoot, "quality-pack"), resolve(root, "quality-pack"), { recursive: true }),
    copyFile(resolve(projectRoot, "skill-crate/lock.json"), resolve(root, "skill-crate/lock.json")),
  ]);
  return root;
}
