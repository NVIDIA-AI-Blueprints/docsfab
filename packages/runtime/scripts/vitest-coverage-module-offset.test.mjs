// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __INTERNAL } from "vitest/runtime";

import { installCoverageModuleOffset } from "./vitest-coverage-module-offset.mjs";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { it } = testApi;
const require = createRequire(import.meta.url);
const version = require("vitest/package.json").version;
const coverage = { enabled: true, provider: "v8" };
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupFile = join(packageRoot, "test", "helpers", "coverage-module-offset.setup.mjs");
const moduleFile = resolve("test/fixtures/coverage-offset-module.ts");
const moduleUrl = pathToFileURL(moduleFile).href;

/** The evaluator context Vitest builds for an inlined module. */
function inlinedContext(ssrImport = () => Promise.resolve({})) {
  return {
    __vite_ssr_exports__: {},
    __vite_ssr_import_meta__: {
      url: moduleUrl,
      filename: moduleFile,
      dirname: resolve("test/fixtures"),
    },
    __vite_ssr_import__: ssrImport,
  };
}

it("records the real evaluator wrapper offset while a module import is still pending", async () => {
  class Evaluator extends __INTERNAL.VitestModuleEvaluator {}
  assert.equal(installCoverageModuleOffset({ coverage, version, Evaluator }), true);
  assert.equal(installCoverageModuleOffset({ coverage, version, Evaluator }), false);

  const moduleExecutionInfo = new Map();
  const evaluator = new Evaluator(undefined, { moduleExecutionInfo });
  let evaluatorOptions;
  const originalStart = evaluator.debug.startCalculateModuleExecutionInfo;
  evaluator.debug.startCalculateModuleExecutionInfo = function (filename, options) {
    evaluatorOptions = options;
    return originalStart.call(this, filename, options);
  };
  let resolveImport;
  let importStarted;
  const pendingImport = new Promise((resolve) => (resolveImport = resolve));
  const started = new Promise((resolve) => (importStarted = resolve));
  const context = inlinedContext(() => {
    importStarted();
    return pendingImport;
  });
  const evaluation = evaluator.runInlinedModule(
    context,
    'await __vite_ssr_import__("deferred"); __vite_ssr_exports__.result = 42;',
    { id: moduleUrl, file: moduleFile, importers: new Set(["coverage-regression"]) },
  );
  try {
    await started;
    const pending = moduleExecutionInfo.get(moduleUrl);
    assert.ok(pending, "pending evaluation must retain execution metadata");
    assert.ok(pending.startOffset > 0, "the actual execution wrapper must be accounted for");
    assert.equal(pending.startOffset, evaluatorOptions.startOffset);
    assert.equal(pending.duration, 0);
    assert.equal(pending.selfTime, 0);
    assert.equal(pending.importer, "coverage-regression");
    resolveImport({});
    await evaluation;
    const completed = moduleExecutionInfo.get(moduleUrl);
    assert.equal(completed.startOffset, pending.startOffset);
    assert.ok(completed.duration >= 0);
    assert.equal(context.__vite_ssr_exports__.result, 42);
  } finally {
    resolveImport({});
    await evaluation;
  }
});

it("leaves the evaluator unchanged when coverage is disabled or uses another provider", () => {
  for (const inactive of [
    undefined,
    { enabled: false, provider: "v8" },
    { enabled: true, provider: "istanbul" },
  ]) {
    class Evaluator extends __INTERNAL.VitestModuleEvaluator {}
    const original = Evaluator.prototype._runInlinedModule;
    assert.equal(
      installCoverageModuleOffset({ coverage: inactive, version: "future", Evaluator }),
      false,
    );
    assert.equal(Evaluator.prototype._runInlinedModule, original);
    assert.equal(Object.hasOwn(Evaluator.prototype, "_runInlinedModule"), false);
  }
});

it("refuses unknown versions and evaluator APIs before applying the compatibility hook", () => {
  class Evaluator extends __INTERNAL.VitestModuleEvaluator {}
  const original = Evaluator.prototype._runInlinedModule;
  assert.throws(
    () => installCoverageModuleOffset({ coverage, version: "5.0.1", Evaluator }),
    /requires Vitest 4\.1\.11; found 5\.0\.1.*Review the upstream #10643 fix/,
  );
  assert.equal(Evaluator.prototype._runInlinedModule, original);
  assert.throws(
    () => installCoverageModuleOffset({ coverage, version, Evaluator: class {} }),
    /unsupported Vitest evaluator API/,
  );
});

it("keeps externalized modules out of the execution info map and still calls Vitest's collector", async () => {
  class Evaluator extends __INTERNAL.VitestModuleEvaluator {}
  assert.equal(installCoverageModuleOffset({ coverage, version, Evaluator }), true);

  const moduleExecutionInfo = new Map();
  const evaluator = new Evaluator(undefined, { moduleExecutionInfo });
  const collected = [];
  const originalStart = evaluator.debug.startCalculateModuleExecutionInfo;
  evaluator.debug.startCalculateModuleExecutionInfo = function (filename, options) {
    collected.push({ filename, options });
    return originalStart.call(this, filename, options);
  };
  await evaluator.runInlinedModule(inlinedContext(), "__vite_ssr_exports__.ready = true;", {
    id: moduleUrl,
    file: moduleFile,
    importers: new Set(["coverage-regression"]),
  });

  // Positive control for the guarded condition: an inlined module is the
  // instrumented case and must be recorded.
  assert.ok(moduleExecutionInfo.has(moduleUrl), "inlined modules must retain execution metadata");
  const inlined = collected.at(-1);
  assert.ok(inlined.options.startOffset > 0);

  // Adjacent condition the `options.external !== true` branch must NOT handle:
  // an externalized module has no instrumented wrapper, so the hook must add
  // no entry for it while Vitest's own collector still runs.
  const externalUrl = pathToFileURL(resolve("test/fixtures/coverage-offset-external.ts")).href;
  const stop = evaluator.debug.startCalculateModuleExecutionInfo(externalUrl, {
    ...inlined.options,
    external: true,
  });
  assert.equal(
    moduleExecutionInfo.has(externalUrl),
    false,
    "externalized modules must not be given a wrapper offset",
  );
  assert.equal(
    typeof stop,
    "function",
    "Vitest's collector must still run for externalized modules",
  );
  assert.equal(collected.at(-1).filename, externalUrl);
});

it("refuses a Vitest build that supplies no module execution metadata", async () => {
  const unsupported = [
    ["the runner supplied no moduleExecutionInfo map", (Evaluator) => new Evaluator(undefined, {})],
    [
      "the evaluator exposes no execution-info collector",
      (Evaluator) => {
        const evaluator = new Evaluator(undefined, { moduleExecutionInfo: new Map() });
        evaluator.debug = { executionStack: [] };
        return evaluator;
      },
    ],
  ];
  for (const [label, build] of unsupported) {
    class Evaluator extends __INTERNAL.VitestModuleEvaluator {}
    assert.equal(installCoverageModuleOffset({ coverage, version, Evaluator }), true);
    await assert.rejects(
      build(Evaluator).runInlinedModule(inlinedContext(), "__vite_ssr_exports__.ready = true;", {
        id: moduleUrl,
        file: moduleFile,
        importers: new Set(),
      }),
      /unsupported Vitest metadata API/u,
      label,
    );
  }

  // Positive control: the real evaluator API passes the same guard and records.
  class Supported extends __INTERNAL.VitestModuleEvaluator {}
  assert.equal(installCoverageModuleOffset({ coverage, version, Evaluator: Supported }), true);
  const moduleExecutionInfo = new Map();
  const supported = new Supported(undefined, { moduleExecutionInfo });
  await supported.runInlinedModule(inlinedContext(), "__vite_ssr_exports__.ready = true;", {
    id: moduleUrl,
    file: moduleFile,
    importers: new Set(),
  });
  assert.ok(moduleExecutionInfo.has(moduleUrl), "a supported evaluator must record the offset");
});

it("is loaded by the shipped Vitest configuration every coverage lane resolves", async () => {
  // Reachability of the hook itself: the lane jobs run Vitest against
  // packages/runtime/vitest.config.ts, whose `setupFiles:
  // ["./test/helpers/coverage-module-offset.setup.mjs"]` entry is the only
  // thing that calls installCoverageModuleOffset in a real run. Ask Vitest's
  // own resolver rather than reading the config file.
  const { resolveConfig } = await import("vitest/node");
  const { vitestConfig } = await resolveConfig({ root: packageRoot });
  const setupFiles = [vitestConfig.setupFiles ?? []].flat();
  assert.ok(
    setupFiles.includes(setupFile),
    `resolved Vitest config must load the coverage offset setup entrypoint; got ${JSON.stringify(setupFiles)}`,
  );
});
