// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Compile the actual validator closure, retaining the package's JS-only copy path. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  copyJsOnlyDistModules,
  JS_ONLY_DIST_MODULES,
} from "../../scripts/js-only-dist-modules.mjs";

const exists = async (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageName = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

export async function compileTerminalSlice(packageRoot, targetRoot) {
  const sourceRoot = join(packageRoot, "src"),
    output = join(targetRoot, "dist");
  const queue = [
    "host-invoker/terminal-validation.ts",
    "host-invoker/terminal-validation-runtime.ts",
    "host-invoker/terminal.ts",
  ];
  const seen = new Set(),
    dependencies = new Set(),
    sources = [];
  const runtimeRequire = createRequire(join(packageRoot, "package.json"));
  await mkdir(output, { recursive: true });
  await copyFile(join(packageRoot, "package.json"), join(targetRoot, "package.json"));
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(sourceRoot, name),
      bytes = await readFile(path);
    const emitted = name.endsWith(".ts")
      ? ts.transpileModule(bytes.toString("utf8"), {
          fileName: path,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText
      : bytes.toString("utf8");
    const emittedName = name.replace(/\.ts$/u, ".js");
    await mkdir(dirname(join(output, emittedName)), { recursive: true });
    await writeFile(join(output, emittedName), emitted);
    sources.push({
      path: `src/${name}`,
      sha256: sha(bytes),
      emittedPath: `dist/${emittedName}`,
      emittedSha256: sha(emitted),
    });
    const ast = ts.createSourceFile(
      emittedName,
      emitted,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of ast.statements) {
      if (
        (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const spec = statement.moduleSpecifier.text;
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        dependencies.add(packageName(spec));
        continue;
      }
      const candidate = resolve(dirname(path), spec);
      const selected =
        candidate.endsWith(".js") && (await exists(candidate.replace(/\.js$/u, ".ts")))
          ? candidate.replace(/\.js$/u, ".ts")
          : candidate;
      const local = relative(sourceRoot, selected);
      if (local.startsWith(".."))
        throw new Error("Validator fixture import leaves runtime source.");
      queue.push(local);
    }
  }
  await copyJsOnlyDistModules(packageRoot, output);
  for (const parts of JS_ONLY_DIST_MODULES) {
    const bytes = await readFile(join(output, ...parts));
    sources.push({
      path: `src/${parts.join("/")}`,
      sha256: sha(bytes),
      copiedByPackageBuildHelper: true,
    });
  }
  for (const directory of ["workflows", "quality/schemas"]) {
    await mkdir(join(targetRoot, directory), { recursive: true });
    for (const name of await readdir(join(packageRoot, directory))) {
      if (!name.endsWith(".json")) continue;
      await copyFile(join(packageRoot, directory, name), join(targetRoot, directory, name));
    }
  }
  for (const name of dependencies) {
    if (name === "tsx") throw new Error("Compiled validator unexpectedly imports source tooling.");
    const installed = dirname(runtimeRequire.resolve(`${name}/package.json`));
    const target = join(targetRoot, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(installed, target, "dir");
  }
  return {
    kind: "compiled-canonical-validator-slice",
    sources,
    linkedProductionDependencies: [...dependencies].sort(),
    sourceFiles: seen.size,
    usedActualJsOnlyCopyHelper: true,
    tsxInstalled: false,
    completeTarballClaimed: false,
  };
}
