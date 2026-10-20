// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface BootstrapCase {
  id: string;
  repository: string;
  initialFiles: string[];
  evidenceSources: string[];
  decision: "patch" | "needs-input";
  expectedPatch: string | null;
  requiredPathsAfter: string[];
  requiredChanges: string[];
  preserveExactly: string[];
}

interface BootstrapContract {
  schemaVersion: number;
  status: string;
  skill: string;
  requiredSurfaces: string[];
  rules: string[];
  cases: BootstrapCase[];
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(projectRoot, "test/fixtures/runtime-evaluation/bootstrap-onboarding");
const execFileAsync = promisify(execFile);

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(directory, path)));
    else files.push(path);
  }
  return files.sort();
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.split(/[\\/]/u).includes("..");
}

describe("bootstrap onboarding contract", () => {
  it("records the bootstrap guidance surfaces and governed evaluation fixtures", async () => {
    const contract = JSON.parse(
      await readFile(resolve(fixtureRoot, "contract.json"), "utf8"),
    ) as BootstrapContract;

    expect(contract).toMatchObject({
      schemaVersion: 1,
      status: "governed",
      skill: "repo-bootstrap",
      requiredSurfaces: ["README.md", "AGENTS.md"],
    });
    expect(contract.rules).toHaveLength(5);
  });

  it("covers absent, partial, nested, and conflicting guidance", async () => {
    const contract = JSON.parse(
      await readFile(resolve(fixtureRoot, "contract.json"), "utf8"),
    ) as BootstrapContract;

    expect(contract.cases.map((item) => item.id)).toEqual([
      "absent",
      "partial",
      "nested",
      "conflicting",
    ]);

    for (const item of contract.cases) {
      const repository = resolve(fixtureRoot, item.repository);
      expect(repository.startsWith(`${fixtureRoot}${sep}`)).toBe(true);
      expect(await listFiles(repository)).toEqual([...item.initialFiles].sort());
      expect(
        [
          ...item.initialFiles,
          ...item.evidenceSources,
          ...item.requiredPathsAfter,
          ...item.requiredChanges,
          ...item.preserveExactly,
        ].every(isSafeRelativePath),
      ).toBe(true);
      expect(item.evidenceSources.every((path) => item.initialFiles.includes(path))).toBe(true);
      expect(item.requiredPathsAfter).toEqual(expect.arrayContaining(contract.requiredSurfaces));
    }

    const conflict = contract.cases.find((item) => item.id === "conflicting");
    expect(conflict).toMatchObject({
      decision: "needs-input",
      requiredChanges: [],
    });
    expect(conflict?.preserveExactly).toEqual(conflict?.initialFiles);
    expect(conflict?.expectedPatch).toBeNull();
    expect(await readFile(resolve(fixtureRoot, "cases/conflicting/AGENTS.md"), "utf8")).toContain(
      "generated",
    );
    expect(
      await readFile(resolve(fixtureRoot, "cases/conflicting/docs/AGENTS.md"), "utf8"),
    ).toContain("hand-maintained");
  });

  it("applies small expected patches while preserving scoped guidance", async () => {
    const contract = JSON.parse(
      await readFile(resolve(fixtureRoot, "contract.json"), "utf8"),
    ) as BootstrapContract;

    for (const item of contract.cases) {
      if (item.decision === "needs-input") {
        expect(item.expectedPatch).toBeNull();
        continue;
      }
      expect(item.expectedPatch).toBeTruthy();
      const temporary = await mkdtemp(resolve(tmpdir(), `docsfab-${item.id}-`));
      try {
        const source = resolve(fixtureRoot, item.repository);
        const repository = resolve(temporary, "repository");
        await cp(source, repository, { recursive: true });
        const initial = new Map(
          await Promise.all(
            item.initialFiles.map(
              async (path) => [path, await readFile(resolve(repository, path), "utf8")] as const,
            ),
          ),
        );
        const patchPath = resolve(fixtureRoot, item.expectedPatch!);
        const patch = await readFile(patchPath, "utf8");
        expect(patch.length).toBeLessThan(2_000);
        expect(
          [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)].map((match) => [
            match[1],
            match[2],
          ]),
        ).toEqual(expect.arrayContaining(item.requiredChanges.map((path) => [path, path])));

        await execFileAsync("git", ["apply", "--check", patchPath], {
          cwd: repository,
        });
        await execFileAsync("git", ["apply", patchPath], { cwd: repository });

        const afterFiles = await listFiles(repository);
        expect(afterFiles).toEqual(
          [...new Set([...item.initialFiles, ...item.requiredPathsAfter])].sort(),
        );
        const changed: string[] = [];
        for (const path of afterFiles) {
          const after = await readFile(resolve(repository, path), "utf8");
          if (initial.get(path) !== after) changed.push(path);
          if (item.preserveExactly.includes(path)) {
            expect(after).toBe(initial.get(path));
          }
        }
        expect(changed.sort()).toEqual([...item.requiredChanges].sort());
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  });
});
