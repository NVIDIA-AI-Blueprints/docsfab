// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the DocsFab typecheck/build `tsc`.
 *
 * TypeScript 7 ships a native binary as `@typescript/native` (`npm:typescript@7`).
 * The `typescript` package is the TypeScript 6 JavaScript API (`tsc6`) for scripts
 * that still `import ts from "typescript"`. Invoke the returned path directly —
 * do not wrap it with `process.execPath`. Node cannot execute the native compiler.
 *
 * Resolve through `package.json` rather than `bin/tsc` subpaths. TypeScript 7
 * `exports` does not expose `./bin/tsc`.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function compilerFromPackage(packageName, relativeBins) {
  const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  for (const relativeBin of relativeBins) {
    const candidate = join(packageRoot, relativeBin);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function resolveTypeScriptCompiler() {
  const failures = [];
  try {
    const native = compilerFromPackage("@typescript/native", ["bin/tsc"]);
    if (native) {
      return native;
    }
    failures.push("@typescript/native: bin/tsc missing");
  } catch (error) {
    failures.push(`@typescript/native: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const legacy = compilerFromPackage("typescript", ["bin/tsc", "bin/tsc6"]);
    if (legacy) {
      return legacy;
    }
    failures.push("typescript: bin/tsc and bin/tsc6 missing");
  } catch (error) {
    failures.push(`typescript: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Unable to resolve tsc (${failures.join("; ")})`);
}
