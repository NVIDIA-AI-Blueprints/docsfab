// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

async function loadLint() {
  return import(
    pathToFileURL(join(process.cwd(), "scripts/lint-exception-hygiene.mjs")).href
  ) as Promise<{
    runExceptionHygiene: (options?: {
      source?: string;
      baseline?: string;
      writeBaseline?: boolean;
      repoRoot?: string;
    }) => {
      status: number;
      findings: Array<{ rule: string; path: string; evidence: string; line: number }>;
      stdout: string;
      stderr: string;
    };
  }>;
}

describe("exception hygiene ratchet", () => {
  it("accepts an empty hermetic source with an empty baseline", async () => {
    const root = await roots.create("docsfab-hygiene-empty-");
    const source = join(root, "src");
    await mkdir(source);
    const baseline = join(root, "baseline.json");
    await writeFile(baseline, JSON.stringify({ fingerprints: [] }), "utf8");

    const { runExceptionHygiene } = await loadLint();
    const result = runExceptionHygiene({ source, baseline, repoRoot: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no exception-hygiene drift/u);
  });

  it("rejects a new low-quality public throw against an empty baseline", async () => {
    const root = await roots.create("docsfab-hygiene-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(
      join(source, "bad.ts"),
      `export function publicThrow(): never {\n  throw new Error("nope");\n}\n`,
      "utf8",
    );
    const baseline = join(root, "baseline.json");
    await writeFile(baseline, JSON.stringify({ fingerprints: [] }), "utf8");

    const { runExceptionHygiene } = await loadLint();
    const result = runExceptionHygiene({
      source,
      baseline,
      repoRoot: root,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/raise-message/u);
    expect(result.stderr).toMatch(/nope/u);
  });

  it("allows private throws, envelope helpers, and hygiene justifications", async () => {
    const root = await roots.create("docsfab-hygiene-ok-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(
      join(source, "ok.ts"),
      `
export function _privateInvariant(): never {
  throw new Error("short");
}
export function wrapped(): never {
  throw toOperatorErrorEnvelope(new Error("short"));
}
export function justified(): never {
  throw new Error("short"); // hygiene: ok
}
export function contractPath(): never {
  throw new SampleContractError("invalid-shape");
}
class SampleContractError extends Error {
  constructor(public readonly code: string) {
    super("Sample contract rejected: " + code + ".");
  }
}
declare function toOperatorErrorEnvelope(error: unknown): Error;
`,
      "utf8",
    );
    const baseline = join(root, "baseline.json");
    await writeFile(baseline, JSON.stringify({ fingerprints: [] }), "utf8");

    const { runExceptionHygiene } = await loadLint();
    const result = runExceptionHygiene({
      source,
      baseline,
      repoRoot: root,
    });
    expect(result.status).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("treats the baseline as a bidirectional ratchet", async () => {
    const root = await roots.create("docsfab-hygiene-ratchet-");
    const source = join(root, "src");
    await mkdir(source);
    const file = join(source, "ratchet.ts");
    await writeFile(
      file,
      `export function publicThrow(): never {\n  throw new Error("short");\n}\n`,
      "utf8",
    );
    const baseline = join(root, "baseline.json");
    const { runExceptionHygiene } = await loadLint();

    const written = runExceptionHygiene({
      source,
      baseline,
      repoRoot: root,
      writeBaseline: true,
    });
    expect(written.status).toBe(0);

    await writeFile(
      file,
      `export function publicThrow(): never {\n  throw new Error("This public failure now has eight words ending correctly.");\n}\n`,
      "utf8",
    );
    const stale = runExceptionHygiene({ source, baseline, repoRoot: root });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/Stale exception-hygiene baseline/u);
  });

  it("fails a CLI-reachable throw new Error without catalog or stem mapping", async () => {
    const root = await roots.create("docsfab-hygiene-cli-");
    const source = join(root, "src");
    await mkdir(join(source, "cli"), { recursive: true });
    await writeFile(
      join(source, "cli", "mutant.ts"),
      `export function publicThrow(): never {\n  throw new Error("This public failure now has eight words ending correctly.");\n}\n`,
      "utf8",
    );
    const baseline = join(root, "baseline.json");
    await writeFile(baseline, JSON.stringify({ fingerprints: [] }), "utf8");

    const { runExceptionHygiene } = await loadLint();
    const result = runExceptionHygiene({ source, baseline, repoRoot: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unmapped-cli-throw/u);
    expect(result.stderr).toMatch(/cli\/mutant\.ts/u);
  });

  it("does not apply the CLI mapping rule outside src/cli", async () => {
    const root = await roots.create("docsfab-hygiene-noncli-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(
      join(source, "helper.ts"),
      `export function publicThrow(): never {\n  throw new Error("This public failure now has eight words ending correctly.");\n}\n`,
      "utf8",
    );
    const baseline = join(root, "baseline.json");
    await writeFile(baseline, JSON.stringify({ fingerprints: [] }), "utf8");

    const { runExceptionHygiene } = await loadLint();
    const result = runExceptionHygiene({ source, baseline, repoRoot: root });
    expect(result.status).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("allows CLI throws that already go through wrapKnowledgeAdapterFailure", async () => {
    const root = await roots.create("docsfab-hygiene-cli-wrap-");
    const source = join(root, "src");
    await mkdir(join(source, "cli"), { recursive: true });
    await writeFile(
      join(source, "cli", "wrapped.ts"),
      `export function wrapped(): never {\n  throw wrapKnowledgeAdapterFailure(new Error("short"));\n}\ndeclare function wrapKnowledgeAdapterFailure(error: unknown): Error;\n`,
      "utf8",
    );
    const baseline = join(root, "baseline.json");
    await writeFile(baseline, JSON.stringify({ fingerprints: [] }), "utf8");

    const { runExceptionHygiene } = await loadLint();
    const result = runExceptionHygiene({ source, baseline, repoRoot: root });
    expect(result.status).toBe(0);
    expect(result.findings).toEqual([]);
  });
});
