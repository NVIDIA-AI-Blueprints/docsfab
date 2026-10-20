// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runnable with `node --test` and collectable by Vitest.
const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");

import {
  CONTRACT_LAYERING_RULE_ID,
  CYCLE_RULE_ID,
  findGraphGuardViolations,
} from "./check-soft-deps.mjs";

function withTempSource(build) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-soft-deps-"));
  const src = join(root, "src");
  mkdirSync(src);
  try {
    return build(src);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeSource(src, relativePath, contents) {
  const path = join(src, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function violationsFor(result, rule) {
  return result.violations.filter((violation) => violation.rule === rule);
}

describe("no-value-import-cycles", () => {
  it("flags every edge in a synthetic static value-import cycle", () => {
    withTempSource((src) => {
      writeSource(src, "a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
      writeSource(src, "b.ts", 'export { a as b } from "./a.js";\n');

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(
        violationsFor(result, CYCLE_RULE_ID).map(
          ({ importer, imported }) => `${importer}->${imported}`,
        ),
        ["src/a.ts->src/b.ts", "src/b.ts->src/a.ts"],
      );
      assert.equal(result.largestStronglyConnectedComponentSize, 2);
      assert.equal(result.cyclicComponents.length, 1);
      assert.equal(result.largestValueCycleSize, 2);
    });
  });

  it("drops import type, export type, and all-type named clauses from the value graph", () => {
    withTempSource((src) => {
      writeSource(
        src,
        "a.ts",
        [
          'import type { B } from "./b.js";',
          'export type { B as ReexportedB } from "./b.js";',
          'export { type B as NamedB } from "./b.js";',
          "export type A = B;",
          "",
        ].join("\n"),
      );
      writeSource(
        src,
        "b.ts",
        'import { value } from "./a.js";\nexport type B = string;\nexport const other = value;\n',
      );

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(violationsFor(result, CYCLE_RULE_ID), []);
      assert.equal(result.largestStronglyConnectedComponentSize, 2);
      assert.deepEqual(result.cyclicComponents, []);
    });
  });

  it("excludes dynamic import calls from the static graph", () => {
    withTempSource((src) => {
      writeSource(src, "a.ts", 'export async function a() { return import("./b.js"); }\n');
      writeSource(src, "b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(violationsFor(result, CYCLE_RULE_ID), []);
      assert.equal(result.largestStronglyConnectedComponentSize, 1);
    });
  });
});

describe("contract-must-not-import-cyclic-module", () => {
  it("uses full static edges and full-graph cycle membership for contract layering", () => {
    withTempSource((src) => {
      writeSource(
        src,
        "implementation/a.ts",
        'import type { B } from "./b.js";\nexport type A = B;\n',
      );
      writeSource(src, "implementation/b.ts", 'export type { A as B } from "./a.js";\n');
      writeSource(
        src,
        "consumer/thing-contracts.ts",
        'import type { A } from "../implementation/a.js";\nexport type Contract = A;\n',
      );

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(violationsFor(result, CYCLE_RULE_ID), []);
      assert.deepEqual(
        violationsFor(result, CONTRACT_LAYERING_RULE_ID).map(
          ({ importer, imported }) => `${importer}->${imported}`,
        ),
        ["src/consumer/thing-contracts.ts->src/implementation/a.ts"],
      );
    });
  });

  it("recognizes workflow-contracts files and init/types as contract surfaces", () => {
    withTempSource((src) => {
      writeSource(
        src,
        "operator/cli-format.ts",
        'import type { Helper } from "./helper.js";\nexport type Format = Helper;\n',
      );
      writeSource(
        src,
        "operator/helper.ts",
        'export type { Format as Helper } from "./cli-format.js";\n',
      );
      writeSource(
        src,
        "delivery/preflight.ts",
        'import type { Internal } from "./internal.js";\nexport type Preflight = Internal;\n',
      );
      writeSource(
        src,
        "delivery/internal.ts",
        'export type { Preflight as Internal } from "./preflight.js";\n',
      );
      writeSource(
        src,
        "workflow-contracts/outcome.ts",
        'import type { Format } from "../operator/cli-format.js";\nexport type Outcome = Format;\n',
      );
      writeSource(
        src,
        "init/types.ts",
        'import type { Preflight } from "../delivery/preflight.js";\nexport type Init = Preflight;\n',
      );

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(
        violationsFor(result, CONTRACT_LAYERING_RULE_ID)
          .map(({ importer, imported }) => `${importer}->${imported}`)
          .sort(),
        [
          "src/init/types.ts->src/delivery/preflight.ts",
          "src/workflow-contracts/outcome.ts->src/operator/cli-format.ts",
        ],
      );
    });
  });

  it("allows contract surfaces to depend on other contract surfaces", () => {
    withTempSource((src) => {
      writeSource(
        src,
        "workflow-contracts/task.ts",
        'import type { Other } from "./other.js";\nexport type Task = Other;\n',
      );
      writeSource(
        src,
        "workflow-contracts/other.ts",
        'export type { Task as Other } from "./task.ts";\n',
      );
      writeSource(
        src,
        "consumer/contracts.ts",
        'import type { Task } from "../workflow-contracts/task.js";\nexport type Consumer = Task;\n',
      );

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(violationsFor(result, CONTRACT_LAYERING_RULE_ID), []);
    });
  });

  it("exempts a genuine leaf with zero internal static imports", () => {
    withTempSource((src) => {
      writeSource(
        src,
        "implementation/a.ts",
        'import type { B } from "./b.js";\nexport type A = B;\n',
      );
      writeSource(src, "implementation/b.ts", 'export type { A as B } from "./a.js";\n');
      writeSource(src, "implementation/leaf.ts", "export type Leaf = string;\n");
      writeSource(
        src,
        "consumer/contracts.ts",
        'import type { Leaf } from "../implementation/leaf.js";\nexport type Contract = Leaf;\n',
      );

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(violationsFor(result, CONTRACT_LAYERING_RULE_ID), []);
    });
  });

  it("does not treat a contract importing within its own module as a layering edge", () => {
    withTempSource((src) => {
      writeSource(src, "module/a.ts", 'import type { B } from "./b.js";\nexport type A = B;\n');
      writeSource(src, "module/b.ts", 'export type { A as B } from "./a.js";\n');
      writeSource(
        src,
        "module/contracts.ts",
        'import type { A } from "./a.js";\nexport type Contract = A;\n',
      );

      const result = findGraphGuardViolations({ srcRoot: src, exceptions: [] });

      assert.deepEqual(violationsFor(result, CONTRACT_LAYERING_RULE_ID), []);
    });
  });
});

describe("edge-keyed baseline ratchet", () => {
  it("honors exact exceptions and reports stale entries", () => {
    withTempSource((src) => {
      writeSource(src, "a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
      writeSource(src, "b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
      const exceptions = [
        {
          rule: CYCLE_RULE_ID,
          importer: "src/a.ts",
          imported: "src/b.ts",
          reason: "fixture",
        },
        {
          rule: CYCLE_RULE_ID,
          importer: "src/b.ts",
          imported: "src/a.ts",
          reason: "fixture",
        },
      ];

      const allowed = findGraphGuardViolations({ srcRoot: src, exceptions });
      assert.deepEqual(allowed.violations, []);
      assert.deepEqual(allowed.staleExceptions, []);

      writeSource(src, "b.ts", "export const b = true;\n");
      const reduced = findGraphGuardViolations({ srcRoot: src, exceptions });
      assert.deepEqual(reduced.violations, []);
      assert.deepEqual(reduced.staleExceptions.sort(), [
        `${CYCLE_RULE_ID}|src/a.ts|src/b.ts`,
        `${CYCLE_RULE_ID}|src/b.ts|src/a.ts`,
      ]);
    });
  });

  it("does not let unchanged aggregate counts hide different cycle edges", () => {
    withTempSource((src) => {
      writeSource(src, "a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
      writeSource(src, "b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
      const exceptions = [
        {
          rule: CYCLE_RULE_ID,
          importer: "src/old-a.ts",
          imported: "src/old-b.ts",
          reason: "same aggregate count, different edge",
        },
        {
          rule: CYCLE_RULE_ID,
          importer: "src/old-b.ts",
          imported: "src/old-a.ts",
          reason: "same aggregate count, different edge",
        },
      ];

      const result = findGraphGuardViolations({ srcRoot: src, exceptions });

      assert.equal(violationsFor(result, CYCLE_RULE_ID).length, 2);
      assert.equal(result.staleExceptions.length, 2);
    });
  });
});

describe("current runtime baseline", () => {
  it("matches every committed edge and reports separate full/value graph measures", () => {
    const result = findGraphGuardViolations();

    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.staleExceptions, []);
    assert.ok(
      result.largestStronglyConnectedComponentSize >= result.largestValueCycleSize,
      "full graph SCC cannot be smaller than its value-only subgraph",
    );
    assert.ok(
      result.exceptions.every(({ rule }) =>
        [CYCLE_RULE_ID, CONTRACT_LAYERING_RULE_ID].includes(rule),
      ),
    );
  });
});
