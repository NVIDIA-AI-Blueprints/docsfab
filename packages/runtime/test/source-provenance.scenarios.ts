// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, readdir, readFile, stat, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { CATALOG_SKILL_IDS } from "../src/skills/catalog-ids.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import { temporaryRoots } from "./helpers/temp.js";

const execute = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qualityPackGenerator = resolve(runtimeRoot, "scripts/generate-quality-pack.mjs");
const catalogCrateGenerator = resolve(runtimeRoot, "scripts/generate-catalog-crate.mjs");
const comparisonKitGenerator = resolve(runtimeRoot, "scripts/generate-model-comparison-kit.mjs");
const PUBLIC_SOURCE_REPOSITORY = "https://github.com/NVIDIA-AI-Blueprints/docsfab.git";
// Local budgets in ms. In CI each case gets at least test.ciTimeoutMs from
// config/limits.yaml; a generator child keeps its local share of that budget.
const localGeneratorCaseMs = 60_000;
const localGeneratorProcessMs = 45_000;
const roots = temporaryRoots();

async function generatorCheck(entry: string): Promise<string> {
  const { stdout } = await execute(process.execPath, [entry, "--check"], {
    cwd: runtimeRoot,
    timeout: nestedDeadlineMs(localGeneratorProcessMs, localGeneratorCaseMs),
  });
  return stdout;
}

async function lockAt(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(runtimeRoot, relativePath), "utf8"));
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function kitFiles(
  root: string,
  prefix = "",
): Promise<Array<{ path: string; sha256: string; mode: "100644" | "100755" }>> {
  const files: Array<{ path: string; sha256: string; mode: "100644" | "100755" }> = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await kitFiles(root, path)));
    else {
      const filePath = join(root, path);
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Unsupported model-comparison kit entry: ${path}`);
      }
      files.push({
        path,
        sha256: sha256(await readFile(filePath)),
        mode: (metadata.mode & fsConstants.S_IXUSR) === 0 ? "100644" : "100755",
      });
    }
  }
  return files;
}

function withoutKeys(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function repositories(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(repositories);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, member]) =>
    key === "repository" && typeof member === "string" ? [member] : repositories(member),
  );
}

export function registerSourceProvenanceSuite(input: {
  locks: readonly string[];
  portable: boolean;
  comparisonKitRelative?: string;
}): void {
  const comparisonKitRelative = input.comparisonKitRelative;
  describe("generated source provenance", { timeout: testTimeoutMs(localGeneratorCaseMs) }, () => {
    if (input.portable) {
      it("stamps every catalog skill in the current crate lock with the public source repository", async () => {
        expect(await generatorCheck(catalogCrateGenerator)).toContain(
          "Catalog skill crate is current",
        );
        const lock = (await lockAt("skill-crate/lock.json")) as {
          skills: Array<{ id: string; source: { repository: string } }>;
        };
        expect(lock.skills.map((skill) => skill.id).sort()).toEqual([...CATALOG_SKILL_IDS].sort());
        for (const skill of lock.skills) {
          expect(skill.source.repository, skill.id).toBe(PUBLIC_SOURCE_REPOSITORY);
        }
      });

      it("stamps the current runtime quality lock with the public source repository", async () => {
        expect(await generatorCheck(qualityPackGenerator)).toContain("Quality pack is current");
        const lock = (await lockAt("quality/lock.json")) as { source: { repository: string } };
        expect(lock.source.repository).toBe(PUBLIC_SOURCE_REPOSITORY);
      });
    }

    it("names no repository other than the public source in any generated lock", async () => {
      for (const path of input.locks) {
        const named = repositories(await lockAt(path));
        expect(named.length, path).toBeGreaterThan(0);
        expect(new Set(named), path).toEqual(new Set([PUBLIC_SOURCE_REPOSITORY]));
      }
    });

    if (comparisonKitRelative) {
      it("binds the installed model-comparison bundle to public repository provenance", async () => {
        const kitRoot = resolve(runtimeRoot, comparisonKitRelative);
        const descriptor = (await lockAt(
          `${comparisonKitRelative}/cross-harness-descriptor.json`,
        )) as {
          descriptorSha256: string;
          fixtureSha256: string;
          sourceProvenance: {
            revision: string;
            files: Array<{ path: string; sha256: string }>;
            snapshotSha256: string;
          };
        };
        const installed = (await lockAt(`${comparisonKitRelative}/installed-manifest.json`)) as {
          installedManifestSha256: string;
          bundleSha256: string;
          files: Array<{ path: string; sha256: string; mode: "100644" | "100755" }>;
        };
        const observedFiles = (await kitFiles(kitRoot))
          .filter((file) => file.path !== "installed-manifest.json")
          .sort((left, right) => left.path.localeCompare(right.path));
        const installedBody = withoutKeys(installed, ["installedManifestSha256"]);
        const descriptorBody = withoutKeys(descriptor, ["descriptorSha256"]);
        const descriptorFixtureBody = withoutKeys(descriptor, [
          "schemaVersion",
          "kind",
          "fixtureSha256",
          "descriptorSha256",
        ]);
        expect(installed.installedManifestSha256).toBe(canonicalDigest(installedBody));
        expect(observedFiles).toEqual(installed.files);
        expect(installed.bundleSha256).toBe(
          sha256(
            installed.files.map((file) => `${file.mode} ${file.sha256}  ${file.path}\n`).join(""),
          ),
        );
        expect(descriptor.descriptorSha256).toBe(canonicalDigest(descriptorBody));
        expect(descriptor.fixtureSha256).toBe(canonicalDigest(descriptorFixtureBody));
        expect(descriptor.sourceProvenance.snapshotSha256).toBe(
          canonicalDigest({
            revision: descriptor.sourceProvenance.revision,
            files: descriptor.sourceProvenance.files,
          }),
        );

        const qualityLock = await lockAt(
          `${comparisonKitRelative}/runtime-bindings/quality/lock.json`,
        );
        const skillLock = await lockAt(
          `${comparisonKitRelative}/runtime-bindings/skill-crate/lock.json`,
        );
        expect(repositories(qualityLock)).toEqual([PUBLIC_SOURCE_REPOSITORY]);
        expect(new Set(repositories(skillLock))).toEqual(new Set([PUBLIC_SOURCE_REPOSITORY]));

        // The generator's digest covers a fresh projection from canonical sources.
        // installed.bundleSha256 separately seals this retained campaign reprint,
        // whose manifest is allowed to keep historical skill and quality bindings.
        const stdout = await generatorCheck(comparisonKitGenerator);
        expect(stdout).toContain("Model-comparison kit is current");
      });
    }

    if (input.portable) {
      it("checks the quality pack when invoked through a symbolic link", async () => {
        const root = await roots.create("docsfab-quality-pack-link-");
        const linked = join(root, "generate-quality-pack.mjs");
        await symlink(qualityPackGenerator, linked);
        expect(await generatorCheck(linked)).toContain("Quality pack is current");
      });

      it("does not run the quality-pack generator when another module imports it", async () => {
        const lockPath = resolve(runtimeRoot, "quality/lock.json");
        const before = (await stat(lockPath)).mtimeMs;
        const imported = (await import(
          `${pathToFileURL(qualityPackGenerator).href}?import-only`
        )) as {
          SOURCE_ONLY_FILES: Set<string>;
        };
        expect(imported.SOURCE_ONLY_FILES).toBeInstanceOf(Set);
        expect(
          (await stat(lockPath)).mtimeMs,
          "importing the generator rewrote quality/lock.json",
        ).toBe(before);
      });
    }
  });
}
