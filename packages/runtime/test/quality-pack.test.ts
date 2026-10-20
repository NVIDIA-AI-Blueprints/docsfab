// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CATALOG_SKILL_IDS } from "../src/skills/catalog-ids.js";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRuntimeQualityLock,
  RUNTIME_POLICY_FILES,
  SOURCE_ONLY_FILES,
} from "../scripts/generate-quality-pack.mjs";
import { QUALITY_SOURCE_ROOTS } from "../scripts/derived-products.mjs";
import {
  parseQualityPackManifest,
  parseRuntimeQualityLock,
  QualityPackError,
  readVerifiedQualityPackFiles,
  verifyQualityPack,
  verifyQualityPackContext,
} from "../src/quality-pack/manifest.js";
import { decodeQualityPackEvidence } from "../src/scorecard-record.js";

const runtimeRoot = resolve(import.meta.dirname, "..");
const qualitySourceRoot = resolve(runtimeRoot, "../quality");

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(qualityBytes = "id: fixture-task-guide\n"): Promise<{
  root: string;
  qualityDirectory: string;
  qualityPackDirectory: string;
  skillCrateDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-quality-pack-"));
  roots.push(root);
  const qualityDirectory = join(root, "quality");
  const qualityPackDirectory = join(root, "quality-pack");
  const skillCrateDirectory = join(root, "skill-crate");
  await Promise.all([
    mkdir(join(qualityDirectory, "rubrics"), { recursive: true }),
    mkdir(join(qualityDirectory, "profiles/fixture-style"), { recursive: true }),
    mkdir(join(qualityDirectory, "profiles/fixture-evaluation"), { recursive: true }),
    mkdir(qualityPackDirectory, { recursive: true }),
    mkdir(skillCrateDirectory, { recursive: true }),
  ]);

  const qualityPath = "rubrics/task-guide.yaml";
  const payload: Record<string, string> = {
    [qualityPath]: qualityBytes,
    "profiles/product-default.json": '{"layer":"product"}\n',
    "profiles/fixture-style/profile.json": '{"id":"fixture-style","version":"v1"}\n',
    "profiles/fixture-style/style-guide.md": "# Style\n\nUse active voice.\n",
    "profiles/fixture-style/TERMINOLOGY.md": "# Terminology\n",
    "profiles/fixture-evaluation/profile.json": '{"id":"fixture-evaluation","version":"v1"}\n',
    "profiles/fixture-evaluation/reader-impact-baseline.md": "# Baseline\n",
  };
  for (const [path, bytes] of Object.entries(payload)) {
    await writeFile(join(qualityDirectory, path), bytes, "utf8");
  }
  const files = Object.keys(payload)
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({ path, sha256: sha256(payload[path]!) }));
  const linesSha256 = (paths: readonly string[]) =>
    sha256(
      [...paths]
        .sort((left, right) => left.localeCompare(right))
        .map((path) => `${sha256(payload[path]!)}  ${path}\n`)
        .join(""),
    );
  const qualityBundleSha256 = linesSha256(Object.keys(payload));
  const qualityLock = {
    schemaVersion: 2,
    bundleHashFormat: "sha256-lines-v1",
    source: {
      repository: "https://example.test/docsfab.git",
      revision: "1111111111111111111111111111111111111111",
      path: "packages/quality",
    },
    qualityRoot: ".",
    bars: [
      { id: "check:fixture", kind: "check", assetPath: qualityPath },
      {
        id: "profile:fixture-evaluation",
        kind: "profile",
        assetPath: "profiles/fixture-evaluation/profile.json",
      },
      {
        id: "profile:fixture-style",
        kind: "profile",
        assetPath: "profiles/fixture-style/profile.json",
      },
    ],
    productDefaults: {
      declarationPath: "profiles/product-default.json",
      layer: "product",
      style: {
        barId: "profile:fixture-style",
        profileId: "fixture-style",
        version: "v1",
        assetPath: "profiles/fixture-style/profile.json",
        deliveredPaths: [
          "profiles/fixture-style/style-guide.md",
          "profiles/fixture-style/TERMINOLOGY.md",
        ],
        sha256: linesSha256([
          "profiles/fixture-style/profile.json",
          "profiles/fixture-style/style-guide.md",
          "profiles/fixture-style/TERMINOLOGY.md",
        ]),
      },
      evaluation: {
        barId: "profile:fixture-evaluation",
        profileId: "fixture-evaluation",
        version: "v1",
        assetPath: "profiles/fixture-evaluation/profile.json",
        readerImpactBaselinePath: "profiles/fixture-evaluation/reader-impact-baseline.md",
        sha256: linesSha256([
          "profiles/fixture-evaluation/profile.json",
          "profiles/fixture-evaluation/reader-impact-baseline.md",
        ]),
      },
    },
    bundleSha256: qualityBundleSha256,
    files,
  };
  const qualityLockBytes = `${JSON.stringify(qualityLock, null, 2)}\n`;
  await writeFile(join(qualityDirectory, "lock.json"), qualityLockBytes, "utf8");

  const skillIds = [...CATALOG_SKILL_IDS];
  const skills = [];
  for (const id of skillIds) {
    const skillBytes = `${id}\n`;
    const contentSha256 = sha256(skillBytes);
    await mkdir(join(skillCrateDirectory, id), { recursive: true });
    await writeFile(join(skillCrateDirectory, id, "SKILL.md"), skillBytes, "utf8");
    skills.push({
      id,
      version: "0.0.0-fixture",
      license: "Apache-2.0",
      provenanceStatus: "docsfab-local",
      source: {
        repository: "https://example.test/docsfab.git",
        revision: "2222222222222222222222222222222222222222",
      },
      sourcePath: `packages/${id === "reconcile-product-behavior" ? "knowledge/skills" : "skills"}/${id}/SKILL.md`,
      skillRoot: id,
      contentSha256,
      bundleSha256: sha256(`${contentSha256}  SKILL.md\n`),
      files: [{ path: "SKILL.md", sha256: contentSha256 }],
      inputs: [],
      outputs: [],
      toolPolicy: { declared: [], granted: [], withheld: ["write"] },
    });
  }
  const skillLockBytes = `${JSON.stringify(
    {
      schemaVersion: 1,
      bundleHashFormat: "sha256-lines-v1",
      contractHashFormat: "sha256-catalog-skill-contract-v1",
      skills,
    },
    null,
    2,
  )}\n`;
  await writeFile(join(skillCrateDirectory, "lock.json"), skillLockBytes, "utf8");

  const skillLockSha256 = sha256(skillLockBytes);
  const qualityLockSha256 = sha256(qualityLockBytes);
  const manifest = {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    skillCrate: {
      lockPath: "../skill-crate/lock.json",
      lockSha256: skillLockSha256,
      skillIds,
    },
    quality: {
      lockPath: "../quality/lock.json",
      lockSha256: qualityLockSha256,
      bundleSha256: qualityBundleSha256,
      barIds: qualityLock.bars.map((bar) => bar.id),
    },
    bindingSha256: sha256(`${skillLockSha256}\n${qualityLockSha256}\n`),
  };
  await writeFile(
    join(qualityPackDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { root, qualityDirectory, qualityPackDirectory, skillCrateDirectory };
}

describe("generated B+C quality pack", () => {
  it("verifies the exact skill lock, quality bytes, and selected bar ids", async () => {
    const input = await fixture();
    const evidence = await verifyQualityPack(input);
    expect(evidence.id).toBe("docsfab-default");
    expect(evidence.barIds).toEqual([
      "check:fixture",
      "profile:fixture-evaluation",
      "profile:fixture-style",
    ]);
    expect(evidence.qualityBundleSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(decodeQualityPackEvidence(evidence)).toEqual(evidence);
  });

  it("records the declared product-default resources and that no other layer resolved", async () => {
    const input = await fixture();
    const lock = JSON.parse(await readFile(join(input.qualityDirectory, "lock.json"), "utf8"));
    const evidence = await verifyQualityPack(input);
    expect(evidence.resolvedResources).toEqual({
      schemaVersion: 1,
      declarationPath: "profiles/product-default.json",
      declarationSha256: sha256('{"layer":"product"}\n'),
      resources: [
        {
          kind: "style-profile",
          id: "profile:fixture-style",
          layer: "product",
          version: "v1",
          sha256: lock.productDefaults.style.sha256,
        },
        {
          kind: "evaluation-profile",
          id: "profile:fixture-evaluation",
          layer: "product",
          version: "v1",
          sha256: lock.productDefaults.evaluation.sha256,
        },
      ],
      unresolvedLayers: ["organization", "target", "request"],
    });
    // A record written before the declaration still decodes.
    const { resolvedResources: _resolved, ...legacy } = evidence;
    expect(decodeQualityPackEvidence(legacy)).toEqual(legacy);
  });

  it("refuses a version 1 quality lock as migration-required", async () => {
    const input = await fixture();
    const lockPath = join(input.qualityDirectory, "lock.json");
    const { productDefaults: _defaults, ...rest } = JSON.parse(await readFile(lockPath, "utf8"));
    const legacy = { ...rest, schemaVersion: 1 };
    expect(() => parseRuntimeQualityLock(legacy)).toThrowError(
      new QualityPackError("migration-required"),
    );
    await writeFile(lockPath, `${JSON.stringify(legacy, null, 2)}\n`);
    await expect(verifyQualityPack(input)).rejects.toMatchObject({ code: "migration-required" });
  });

  it("refuses product-default bindings the lock's bars and files do not support", async () => {
    const input = await fixture();
    const lock = JSON.parse(await readFile(join(input.qualityDirectory, "lock.json"), "utf8"));
    const unknownBar = structuredClone(lock);
    unknownBar.productDefaults.style.barId = "check:fixture";
    expect(() => parseRuntimeQualityLock(unknownBar)).toThrow(QualityPackError);
    const outside = structuredClone(lock);
    outside.productDefaults.style.deliveredPaths = ["rubrics/task-guide.yaml"];
    expect(() => parseRuntimeQualityLock(outside)).toThrow(QualityPackError);
    const digest = structuredClone(lock);
    digest.productDefaults.style.sha256 = "0".repeat(64);
    expect(() => parseRuntimeQualityLock(digest)).toThrowError(
      new QualityPackError("checksum-mismatch"),
    );
  });

  it("rejects quality-byte tampering and undeclared files", async () => {
    const input = await fixture();
    await writeFile(join(input.qualityDirectory, "rubrics/task-guide.yaml"), "id: tampered\n");
    await expect(verifyQualityPack(input)).rejects.toEqual(
      new QualityPackError("checksum-mismatch"),
    );

    const extra = await fixture();
    await writeFile(join(extra.qualityDirectory, "rubrics/extra.json"), "{}\n");
    await expect(verifyQualityPack(extra)).rejects.toEqual(
      new QualityPackError("file-set-mismatch"),
    );
  });

  it("scans NUL-bearing text for credential material", async () => {
    const credential = "glpat-" + "A".repeat(24);
    const input = await fixture(`id: fixture-task-guide\nmarker: ${credential}\n\0`);
    await expect(verifyQualityPack(input)).rejects.toEqual(new QualityPackError("tampered"));
  });

  it("returns defensive copies of verified payload entries and bytes", async () => {
    const input = await fixture();
    const context = await verifyQualityPackContext(input);
    const first = await readVerifiedQualityPackFiles(context, "rubrics");
    first[0]!.path = "mutated";
    first[0]!.bytes[0] = first[0]!.bytes[0]! ^ 0xff;

    const reread = await readVerifiedQualityPackFiles(context, "rubrics");
    expect(reread[0]!.path).toBe("rubrics/task-guide.yaml");
    expect(sha256(reread[0]!.bytes)).toBe(reread[0]!.sha256);
    expect(reread[0]!.bytes.toString("utf8")).toBe("id: fixture-task-guide\n");
  });

  it("rejects stale Pin B or Pin C lock bindings", async () => {
    const skill = await fixture();
    const skillLockPath = join(skill.skillCrateDirectory, "lock.json");
    await writeFile(skillLockPath, `${await readFile(skillLockPath, "utf8")}\n`);
    await expect(verifyQualityPack(skill)).rejects.toEqual(new QualityPackError("stale"));

    const quality = await fixture();
    const qualityLockPath = join(quality.qualityDirectory, "lock.json");
    await writeFile(qualityLockPath, `${await readFile(qualityLockPath, "utf8")}\n`);
    await expect(verifyQualityPack(quality)).rejects.toEqual(new QualityPackError("stale"));
  });

  it("fails closed when a required generated lock or manifest is missing", async () => {
    const input = await fixture();
    await rm(join(input.qualityPackDirectory, "manifest.json"));
    await expect(verifyQualityPack(input)).rejects.toEqual(
      new QualityPackError("lock-unavailable"),
    );
  });

  it("rejects path escape, credentialed provenance, symlinks, and hard links", async () => {
    const pathEscape = await fixture();
    const manifestPath = join(pathEscape.qualityPackDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.quality.lockPath = "../../quality/lock.json";
    expect(() => parseQualityPackManifest(manifest)).toThrowError(
      new QualityPackError("invalid-manifest"),
    );

    const credential = await fixture();
    const lockPath = join(credential.qualityDirectory, "lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.source.repository = "https://user:secret@example.test/repo.git";
    expect(() => parseRuntimeQualityLock(lock)).toThrowError(new QualityPackError("invalid-lock"));

    const linked = await fixture();
    const taskGuide = join(linked.qualityDirectory, "rubrics/task-guide.yaml");
    const hardLink = join(linked.qualityDirectory, "rubrics/task-guide-hard-link.yaml");
    await link(taskGuide, hardLink);
    await expect(verifyQualityPack(linked)).rejects.toEqual(new QualityPackError("unsafe-path"));

    const symbolic = await fixture();
    const symbolicTaskGuide = join(symbolic.qualityDirectory, "rubrics/task-guide.yaml");
    const target = join(symbolic.root, "task-guide.yaml");
    await writeFile(target, await readFile(symbolicTaskGuide));
    await rm(symbolicTaskGuide);
    await symlink(target, symbolicTaskGuide);
    await expect(verifyQualityPack(symbolic)).rejects.toEqual(new QualityPackError("unsafe-path"));
  });
});

describe("quality pack Pin C template sources", () => {
  it("stages template-set-v1 and template-structural-schemas from packages/quality/formats", async () => {
    const qualityLock = JSON.parse(
      await readFile(join(runtimeRoot, "quality/lock.json"), "utf8"),
    ) as { files: Array<{ path: string }> };
    const stagedPaths = qualityLock.files.map((file) => file.path);

    expect(stagedPaths.some((path) => path.startsWith("formats/template-set-v1/"))).toBe(true);
    expect(stagedPaths).toContain("formats/template-structural-schemas/README.md");
    await expect(
      access(join(qualitySourceRoot, "formats/template-set-v1/REGISTRY.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(qualitySourceRoot, "formats/template-structural-schemas/README.md")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(runtimeRoot, "governed-assets/template-set-v1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(runtimeRoot, "governed-assets/template-structural-schemas")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("quality pack source-only staging", () => {
  it("preserves installed policy across source distribution changes and binds policy edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-quality-policy-"));
    roots.push(root);
    for (const subtree of [...QUALITY_SOURCE_ROOTS, "runtime-policy"]) {
      await cp(join(qualitySourceRoot, subtree), join(root, subtree), {
        recursive: true,
        filter: (path) => !path.split("/").includes("__pycache__"),
      });
    }
    const original = await buildRuntimeQualityLock(root);
    for (const path of [...SOURCE_ONLY_FILES, ...Object.keys(RUNTIME_POLICY_FILES)]) {
      await writeFile(join(root, path), "# Independently changed source distribution tooling.\n");
    }
    expect(await buildRuntimeQualityLock(root)).toEqual(original);
    for (const [path, source] of Object.entries(RUNTIME_POLICY_FILES)) {
      expect(await readFile(join(runtimeRoot, "quality", path))).toEqual(
        await readFile(join(qualitySourceRoot, source)),
      );
      await writeFile(join(root, source), "# Changed installed policy resource.\n");
    }
    const changed = await buildRuntimeQualityLock(root);
    expect(changed.bundleSha256).not.toBe(original.bundleSha256);
    expect(changed.source.revision).not.toBe(original.source.revision);
  });

  it("keeps generator source-only files out of runtime quality staging", async () => {
    expect(SOURCE_ONLY_FILES.size).toBeGreaterThan(0);
    const qualityLock = JSON.parse(
      await readFile(join(runtimeRoot, "quality/lock.json"), "utf8"),
    ) as { files: Array<{ path: string }> };
    const stagedPaths = new Set(qualityLock.files.map((file) => file.path));

    for (const relativePath of SOURCE_ONLY_FILES) {
      await expect(access(join(qualitySourceRoot, relativePath))).resolves.toBeUndefined();
      await expect(access(join(runtimeRoot, "quality", relativePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(stagedPaths.has(relativePath)).toBe(false);
    }
  });
});
