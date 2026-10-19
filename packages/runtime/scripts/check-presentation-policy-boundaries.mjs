#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Keep the migrated CLI compatibility adapters on the shared terminal policy. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adapters = [
  {
    path: "src/operator/cli-format.ts",
    required: ["resolveProcessPresentationCapabilities", "paintTerminalText"],
  },
  {
    path: "src/operator/terminal-style.ts",
    required: ["resolvePresentationCapabilities", "paintTerminalText"],
  },
];
const forbidden = [
  ["direct process environment reads", /\bprocess\.env\b/u],
  ["local ANSI escape literals", /\\u001[bB]|\\x1[bB]/u],
];
const errors = [];

for (const adapter of adapters) {
  const source = readFileSync(join(root, adapter.path), "utf8");
  const sourceFile = ts.createSourceFile(
    adapter.path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calls = new Set();
  function collectCalls(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.add(node.expression.text);
    }
    ts.forEachChild(node, collectCalls);
  }
  collectCalls(sourceFile);
  for (const name of adapter.required) {
    if (!calls.has(name)) errors.push(`${adapter.path} must call ${name}`);
  }
  for (const [description, pattern] of forbidden) {
    if (pattern.test(source)) errors.push(`${adapter.path} contains ${description}`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Presentation policy boundary check passed (2 compatibility adapters).");
}
