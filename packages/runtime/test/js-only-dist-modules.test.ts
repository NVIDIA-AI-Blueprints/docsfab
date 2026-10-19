// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { JS_ONLY_DIST_MODULES } from "../scripts/js-only-dist-modules.mjs";

/**
 * Whether `source` is exactly one `export * from "./<base>.ts";` statement.
 * Parsed with the TypeScript scanner, so comments are trivia and no comment
 * arrangement can hide a statement.
 */
function isPureSameNameReexport(source: string, base: string): boolean {
  const file = ts.createSourceFile(
    "facade.js",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  if (file.statements.length !== 1) return false;
  const [statement] = file.statements;
  return (
    statement !== undefined &&
    ts.isExportDeclaration(statement) &&
    statement.exportClause === undefined &&
    !statement.isTypeOnly &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === `./${base}.ts`
  );
}

describe("JS-only dist modules", () => {
  it("copies limit-resolution next to compiled limits.js", () => {
    expect(JS_ONLY_DIST_MODULES.map((parts) => parts.join("/"))).toEqual(
      expect.arrayContaining([
        "config/limit-resolution.js",
        "config/limit-resolution.d.ts",
        "config/executable-route-urls.js",
        "config/executable-route-urls.d.ts",
        "operator/display-sanitize.js",
        "operator/display-sanitize.d.ts",
      ]),
    );
  });

  it("lists every JavaScript source module, or exempts it with a reason", () => {
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const listed = new Set(JS_ONLY_DIST_MODULES.map((parts) => parts.join("/")));
    const walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(directory, entry.name))
          : entry.name.endsWith(".js")
            ? [relative(sourceRoot, join(directory, entry.name)).split("\\").join("/")]
            : [],
      );
    // Exempt with a reason: a source-checkout facade whose only statement is
    // `export * from "./<same name>.ts"`. `tsc` compiles that `.ts` sibling to
    // the same `.js` path in dist, so copying the facade would be wrong. Any
    // other `.js` must be copied, so it must be listed.
    const facadeReason = (path: string): string | undefined => {
      const base = path.slice(path.lastIndexOf("/") + 1, -".js".length);
      if (!existsSync(join(sourceRoot, path.replace(/\.js$/u, ".ts")))) return undefined;
      return isPureSameNameReexport(readFileSync(join(sourceRoot, path), "utf8"), base)
        ? "facade over a same-named .ts that tsc emits to dist"
        : undefined;
    };
    const sources = walk(sourceRoot);
    const unlisted = sources
      .filter((path) => !listed.has(path) && facadeReason(path) === undefined)
      .sort();
    expect(unlisted).toEqual([]);
    for (const path of listed) {
      if (path.endsWith(".js")) {
        expect(sources).toContain(path);
        expect(listed.has(path.replace(/\.js$/u, ".d.ts"))).toBe(true);
        // A listed module must not also be a facade: dist would get two writers.
        expect(facadeReason(path)).toBeUndefined();
      }
    }
  });

  it("does not accept a side effect hidden between comment-shaped lines as a pure re-export", () => {
    const hidden = [
      "// /*",
      'globalThis.sideEffect = "ran";',
      "// */",
      'export * from "./freeze.ts";',
      "",
    ].join("\n");
    expect(isPureSameNameReexport(hidden, "freeze")).toBe(false);
    expect(isPureSameNameReexport('/** Facade. */\nexport * from "./freeze.ts";\n', "freeze")).toBe(
      true,
    );
    expect(isPureSameNameReexport('export * from "./other.ts";\n', "freeze")).toBe(false);
    expect(isPureSameNameReexport('export { a } from "./freeze.ts";\n', "freeze")).toBe(false);
  });
});
