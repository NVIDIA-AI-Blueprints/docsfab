// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { QualityPackError, verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { loadTemplateSet } from "../src/templates/load.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = "formats/template-set-v1/REGISTRY.json";
const licensePath = "formats/template-set-v1/LICENSE";
const REGISTRY_REFUSAL = "Template set REGISTRY.json does not name its source homepage.";
// Local budget in ms; CI raises it to test.ciTimeoutMs from config/limits.yaml.
const localCaseMs = 30_000;
const roots = temporaryRoots();

interface QualityLock {
  bundleSha256: string;
  files: Array<{ path: string; sha256: string }>;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function copiedRuntimeAssets(): Promise<string> {
  const root = await roots.create("docsfab-template-provenance-");
  await mkdir(resolve(root, "skill-crate"), { recursive: true });
  await Promise.all([
    cp(resolve(projectRoot, "quality"), resolve(root, "quality"), { recursive: true }),
    cp(resolve(projectRoot, "quality-pack"), resolve(root, "quality-pack"), { recursive: true }),
    copyFile(resolve(projectRoot, "skill-crate/lock.json"), resolve(root, "skill-crate/lock.json")),
  ]);
  return root;
}

// Rewrites (or removes, for null) the staged REGISTRY.json and re-derives the
// generated quality lock and pack binding, so the quality pack verifies and
// only the template set seal in load.ts can refuse the bytes.
async function withRegistry(registry: string | null): Promise<string> {
  const root = await copiedRuntimeAssets();
  const target = resolve(root, "quality", registryPath);
  const lockPath = resolve(root, "quality/lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as QualityLock;
  if (registry === null) {
    await rm(target);
    lock.files = lock.files.filter((file) => file.path !== registryPath);
  } else {
    await writeFile(target, registry, "utf8");
    const entry = lock.files.find((file) => file.path === registryPath)!;
    entry.sha256 = sha256(registry);
  }
  await resealQualityPack(root, lock);
  return root;
}

async function resealQualityPack(root: string, lock: QualityLock): Promise<void> {
  const lockPath = resolve(root, "quality/lock.json");
  const manifestPath = resolve(root, "quality-pack/manifest.json");
  lock.bundleSha256 = sha256(lock.files.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
  const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
  await writeFile(lockPath, lockBytes, "utf8");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    skillCrate: { lockSha256: string };
    quality: { lockSha256: string; bundleSha256: string };
    bindingSha256: string;
  };
  manifest.quality.lockSha256 = sha256(lockBytes);
  manifest.quality.bundleSha256 = lock.bundleSha256;
  manifest.bindingSha256 = sha256(
    `${manifest.skillCrate.lockSha256}\n${manifest.quality.lockSha256}\n`,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function sealedRegistry(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(resolve(projectRoot, "quality", registryPath), "utf8"),
  ) as Record<string, unknown>;
}

async function refusal(root: string): Promise<QualityPackError> {
  const error = await loadTemplateSet(root).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(QualityPackError);
  return error as QualityPackError;
}

describe("template set source provenance", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it("records the sealed registry homepage as the source repository", async () => {
    const registry = await sealedRegistry();
    const bundle = await loadTemplateSet(projectRoot);
    expect(typeof registry.homepage).toBe("string");
    expect(bundle.evidence.source.repository).toBe(`${registry.homepage as string}.git`);
  });

  it("loads a resealed pack whose registry bytes are unchanged", async () => {
    const bytes = await readFile(resolve(projectRoot, "quality", registryPath), "utf8");
    const bundle = await loadTemplateSet(await withRegistry(bytes));
    expect(bundle.evidence.source.repository).toBe(
      `${(await sealedRegistry()).homepage as string}.git`,
    );
  });

  it.each([
    ["absent", null],
    ["not strict JSON", '{"homepage": "https://git.example.com/docs/templates",}\n'],
    ["an array", '["https://git.example.com/docs/templates"]\n'],
    ["missing its homepage", '{"registry": "templates"}\n'],
    ["carrying a non-string homepage", '{"homepage": 7}\n'],
  ])("names the refusal for a registry that is %s", async (_, registry) => {
    const error = await refusal(await withRegistry(registry));
    expect(error.code).toBe("checksum-mismatch");
    expect(error.message).toBe(REGISTRY_REFUSAL);
  });

  it("leaves a registry naming another repository to the bundle seal", async () => {
    const registry = await sealedRegistry();
    registry.homepage = "https://git.example.com/docs/templates";
    const error = await refusal(await withRegistry(`${JSON.stringify(registry, null, 2)}\n`));
    expect(error).toEqual(new QualityPackError("checksum-mismatch"));
    expect(error.message).not.toBe(REGISTRY_REFUSAL);
  });

  it.each(["replaced", "appended"] as const)(
    "refuses a %s template license after the quality pack is resealed",
    async (mutation) => {
      const root = await copiedRuntimeAssets();
      const path = resolve(root, "quality", licensePath);
      const original = await readFile(path, "utf8");
      const changed = mutation === "replaced" ? "Unapproved license fixture.\n" : `${original}\n`;
      await writeFile(path, changed, "utf8");
      const lock = JSON.parse(
        await readFile(resolve(root, "quality/lock.json"), "utf8"),
      ) as QualityLock;
      lock.files.find((file) => file.path === licensePath)!.sha256 = sha256(changed);
      await resealQualityPack(root, lock);

      await verifyQualityPackContext({
        qualityPackDirectory: resolve(root, "quality-pack"),
        qualityDirectory: resolve(root, "quality"),
        skillCrateDirectory: resolve(root, "skill-crate"),
      });
      expect(await refusal(root)).toEqual(new QualityPackError("checksum-mismatch"));
    },
  );
});
