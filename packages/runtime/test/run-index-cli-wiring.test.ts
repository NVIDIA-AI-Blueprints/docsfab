// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";

import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { loadDocsFabEnvironment, resolveDocsFabStateDirectory } from "../src/config/host-paths.js";
import { findPublicCommand } from "../src/cli/command-registry.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import type { RunRecord } from "../src/records/contracts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run index on the CLI run path", () => {
  it("indexes a terminal record saved through the local workflow run store", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-run-index-wiring-"));
    roots.push(root);
    const stateDirectory = join(root, "runs");
    const { services } = await createLocalWorkflowApplicationServices({
      config: {
        stateDirectory,
        skillCrateDirectory: resolve("skill-crate"),
        qualityDirectory: resolve("quality"),
        qualityPackDirectory: resolve("quality-pack"),
      },
      request: { workflow: "update-documentation" },
      workflow: { schemaVersion: 2 },
      workspace: {},
      repositoryEvidence: {},
      baseHarness: {},
    } as never);

    const record = {
      schemaVersion: 2,
      id: "wired-run",
      workflow: "update-documentation",
      repository: { sourcePath: "/fixture", requestedRevision: "HEAD", revision: "a".repeat(40) },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      createdAt: "2026-09-23T09:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "plan-documentation",
          title: "Plan",
          skill: "plan",
          mode: "read-only",
          status: "failed",
        },
      ],
    } as unknown as RunRecord;
    await services.store.save(record);

    const index = await readFile(join(root, "run-index", "runs.jsonl"), "utf8");
    const rows = index
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toEqual([
      expect.objectContaining({ rowKind: "run", runId: "wired-run", outcome: "failed" }),
      expect.objectContaining({
        rowKind: "step",
        origin: "run-store",
        runId: "wired-run",
        stepId: "plan-documentation",
        outcome: "failed",
      }),
    ]);
  });
});

describe("verifier disagreement on the CLI run path (#1439)", () => {
  it("indexes a saved record's disagreement count and groups by it through runs query", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-run-index-verifier-"));
    roots.push(root);
    const stateDirectory = join(root, "runs");
    const { services } = await createLocalWorkflowApplicationServices({
      config: {
        stateDirectory,
        skillCrateDirectory: resolve("skill-crate"),
        qualityDirectory: resolve("quality"),
        qualityPackDirectory: resolve("quality-pack"),
      },
      request: { workflow: "update-documentation" },
      workflow: { schemaVersion: 2 },
      workspace: {},
      repositoryEvidence: {},
      baseHarness: {},
    } as never);
    const disagreement = {
      schemaVersion: 1,
      kind: "docsfab-verifier-disagreement",
      provisionalStepId: "provisional-technical-verification",
      status: "compared",
      rows: [{ kind: "canonical-issue", canonicalIssueId: "TECH-002", category: "completeness" }],
    };
    await services.store.save({
      schemaVersion: 2,
      id: "wired-verifier-run",
      workflow: "review-documentation",
      repository: { sourcePath: "/fixture", requestedRevision: "HEAD", revision: "a".repeat(40) },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      createdAt: "2026-09-25T09:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "verify-technical-accuracy",
          title: "Verify",
          skill: "verify-technical-accuracy",
          mode: "read-only",
          status: "failed",
          verifierDisagreement: disagreement,
        },
      ],
    } as unknown as RunRecord);

    const io = await captureStdout(() =>
      handleRunsCommand([
        "query",
        "--index-dir",
        join(root, "run-index"),
        "--where",
        "rowKind=run",
        "--group-by",
        "verifierDisagreementCount",
        "--json",
      ]),
    );
    expect((JSON.parse(io) as { groups: unknown }).groups).toEqual([
      { key: { verifierDisagreementCount: 1 }, rows: 1, runs: 1, share: 1 },
    ]);
  });
});

describe("run model and state location on the CLI run path (#1688)", () => {
  const saved = {
    root: process.env.DOCSFAB_CONFIG_ROOT,
    state: process.env.DOCSFAB_STATE_DIR,
  };
  afterEach(() => {
    for (const [name, value] of [
      ["DOCSFAB_CONFIG_ROOT", saved.root],
      ["DOCSFAB_STATE_DIR", saved.state],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("answers a run-row model query with no flags, from the state directory the host's env file names", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-run-index-located-"));
    roots.push(root);
    const configurationRoot = join(root, "config");
    const stateDirectory = join(root, "elsewhere", "runs");
    await mkdir(configurationRoot, { recursive: true });
    await chmod(configurationRoot, 0o700);
    // A legacy-layout host: `docsfab run` loads this file before it picks the store.
    await writeFile(join(configurationRoot, ".env"), `DOCSFAB_STATE_DIR=${stateDirectory}\n`);
    process.env.DOCSFAB_CONFIG_ROOT = configurationRoot;
    delete process.env.DOCSFAB_STATE_DIR;
    const loaded: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: configurationRoot };
    loadDocsFabEnvironment(loaded);
    expect(resolveDocsFabStateDirectory(loaded)).toBe(stateDirectory);

    const { services } = await createLocalWorkflowApplicationServices({
      config: {
        stateDirectory: resolveDocsFabStateDirectory(loaded),
        skillCrateDirectory: resolve("skill-crate"),
        qualityDirectory: resolve("quality"),
        qualityPackDirectory: resolve("quality-pack"),
      },
      request: { workflow: "update-documentation" },
      workflow: { schemaVersion: 2 },
      workspace: {},
      repositoryEvidence: {},
      baseHarness: {},
    } as never);
    await services.store.save({
      schemaVersion: 2,
      id: "located-run",
      workflow: "update-documentation",
      repository: { sourcePath: "/fixture", requestedRevision: "HEAD", revision: "a".repeat(40) },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      createdAt: "2026-09-30T09:00:00.000Z",
      models: [{ provider: "nvidia-api-catalog", model: "nvidia/nemotron-fixture" }],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [],
    } as unknown as RunRecord);

    const io = await captureStdout(() =>
      handleRunsCommand([
        "query",
        "--where",
        "rowKind=run",
        "--group-by",
        "model,docsfabRevision",
        "--json",
      ]),
    );
    const envelope = JSON.parse(io) as { index: { path: string }; groups: unknown };
    expect(envelope.index.path).toBe(join(root, "elsewhere", "run-index", "runs.jsonl"));
    // A source checkout's build is unstamped, so its revision reads unavailable.
    expect(envelope.groups).toEqual([
      {
        key: { model: "nvidia/nemotron-fixture", docsfabRevision: null },
        rows: 1,
        runs: 1,
        share: 1,
      },
    ]);
  });
});

/** The runs command prints its JSON envelope through console.log. */
async function captureStdout(action: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("CLI run-store construction", () => {
  it("does not advertise runs as read-only, because runs import writes index rows", () => {
    expect(findPublicCommand("runs")?.readOnly).toBe(false);
  });

  it("builds every saving run store under src/cli and src/application through the indexed factory", async () => {
    const files: string[] = [];
    for (const root of ["src/cli", "src/application"]) {
      for (const entry of await readdir(resolve(root), { recursive: true })) {
        if (entry.endsWith(".ts")) files.push(join(root, entry));
      }
    }
    const unindexed: string[] = [];
    for (const file of files) {
      const source = await readFile(resolve(file), "utf8");
      if (hasUnindexedRunStoreConstruction(source)) unindexed.push(file);
    }
    expect(unindexed).toEqual([]);
  });

  it("admits a bound store only when every use is an exact read-only load", () => {
    const allowed = `import { loadRetainedReviewResult } from "../review-delivery/result-store.js";
    async function preview() {
      const runStore = new FileRunStore(stateDirectory);
      await loadRetainedReviewResult({ runStore, readOnly: true });
      await runStore.getWithDigest(runId, { readOnly: true });
    }`;
    expect(hasUnindexedRunStoreConstruction(allowed)).toBe(false);
    for (const unsafe of [
      allowed.replace("await runStore.getWithDigest", "await runStore.save"),
      allowed.replace("{ readOnly: true });\n    }", ");\n    }"),
      allowed.replace(
        "loadRetainedReviewResult({ runStore, readOnly: true })",
        "unknown({ runStore })",
      ),
      allowed.replace(
        "await runStore.getWithDigest",
        "const alias = runStore;\n      await alias.getWithDigest",
      ),
      allowed.replace(
        "await runStore.getWithDigest",
        "async function nested() { const runStore = unsafe; await runStore.save(record); }\n      await runStore.getWithDigest",
      ),
      allowed.replace(
        "await loadRetainedReviewResult({ runStore, readOnly: true });",
        "const loadRetainedReviewResult = unknownLoader;\n      await loadRetainedReviewResult({ runStore, readOnly: true });",
      ),
    ]) {
      expect(hasUnindexedRunStoreConstruction(unsafe)).toBe(true);
    }
  });

  it("distinguishes inline non-saving record reads from writes or escaping stores", () => {
    const inline = (method: string) =>
      `async function inspect() { await new FileRunStore(stateDirectory).${method}; }`;
    for (const read of [
      "get(runId)",
      "getWithDigest(runId)",
      "getWithDigest(runId, { readOnly: true })",
    ]) {
      expect(hasUnindexedRunStoreConstruction(inline(read))).toBe(false);
    }
    for (const write of [
      "save(record)",
      "replaceIfDigest(runId, digest, record)",
      "replaceExactBytes(runId, bytes)",
    ]) {
      expect(hasUnindexedRunStoreConstruction(inline(write))).toBe(true);
    }
    expect(
      hasUnindexedRunStoreConstruction(
        "async function inspect() { await inspectStore(new FileRunStore(stateDirectory)); }",
      ),
    ).toBe(true);
  });
});

/** Direct record reads save no run/index row; bound stores need the proven cold read-only APIs. */
function hasUnindexedRunStoreConstruction(source: string): boolean {
  const file = ts.createSourceFile(
    "run-store-construction.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const readOnlyTrue = (value: ts.Node): boolean =>
    ts.isObjectLiteralExpression(value) &&
    value.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(file) === "readOnly" &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    );
  const hasKnownLoaderImport = file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "../review-delivery/result-store.js" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          element.name.text === "loadRetainedReviewResult" && element.propertyName === undefined,
      ),
  );
  const directRead = (construction: ts.NewExpression): boolean => {
    const access = construction.parent;
    return (
      ts.isPropertyAccessExpression(access) &&
      access.expression === construction &&
      (access.name.text === "get" || access.name.text === "getWithDigest") &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access
    );
  };
  const boundRead = (construction: ts.NewExpression): boolean => {
    if (!hasKnownLoaderImport) return false;
    const declaration = construction.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== construction ||
      !ts.isIdentifier(declaration.name) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    )
      return false;
    let scope: ts.Node | undefined = declaration.parent;
    while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
    if (!scope) return false;
    // A same-name local binding can shadow the trusted import. Refuse it even
    // when the bound store is only passed through an otherwise read-only call.
    const declaresLoader = (node: ts.Node): boolean =>
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === "loadRetainedReviewResult";
    let localLoader = false;
    const findLocalLoader = (node: ts.Node): void => {
      if (declaresLoader(node)) localLoader = true;
      ts.forEachChild(node, findLocalLoader);
    };
    for (
      let container: ts.Node | undefined = scope;
      container && !ts.isSourceFile(container);
      container = container.parent
    )
      findLocalLoader(container);
    if (localLoader) return false;
    // Same-name runStore shadowing is refused conservatively, so it cannot hide a save.
    const references: ts.Identifier[] = [];
    const collect = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node.text === declaration.name.getText(file) &&
        node !== declaration.name
      )
        references.push(node);
      ts.forEachChild(node, collect);
    };
    collect(scope);
    return (
      references.length > 0 &&
      references.every((reference) => {
        const parent = reference.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
          const call = parent.parent;
          return (
            parent.name.text === "getWithDigest" &&
            ts.isCallExpression(call) &&
            call.expression === parent &&
            call.arguments.length > 1 &&
            readOnlyTrue(call.arguments[1]!)
          );
        }
        if (!ts.isShorthandPropertyAssignment(parent) || parent.name !== reference) return false;
        const object = parent.parent;
        const call = object.parent;
        return (
          ts.isObjectLiteralExpression(object) &&
          ts.isCallExpression(call) &&
          call.arguments[0] === object &&
          ts.isIdentifier(call.expression) &&
          call.expression.text === "loadRetainedReviewResult" &&
          readOnlyTrue(object)
        );
      })
    );
  };
  let unindexed = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "FileRunStore" &&
      !directRead(node) &&
      !boundRead(node)
    )
      unindexed = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return unindexed;
}
