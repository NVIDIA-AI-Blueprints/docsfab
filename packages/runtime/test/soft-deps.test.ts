// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_AUTONOMY_IMPORTS,
  RULES,
  findSoftDependencyViolations,
} from "../scripts/check-soft-deps.mjs";

describe("soft package dependency check", () => {
  it("encodes the Epic D2 hard rules", () => {
    expect(RULES.map((rule) => rule.id)).toEqual([
      "assessment-must-not-import-publication",
      "publication-must-not-own-maturity-selection",
    ]);
    expect(ALLOWED_AUTONOMY_IMPORTS).toEqual(["assessment", "maturity", "roadmap"]);
  });

  it("accepts the current source tree with an empty allowlist", () => {
    const result = findSoftDependencyViolations({ exceptions: [] });
    expect(result.violations).toEqual([]);
    expect(result.staleExceptions).toEqual([]);
    expect(
      result.edges.some(
        (edge) =>
          edge.fromPackage === "autonomy" && ALLOWED_AUTONOMY_IMPORTS.includes(edge.toPackage),
      ),
    ).toBe(true);
  });

  it("detects assessment→delivery and delivery→maturity imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "docsfab-soft-deps-"));
    try {
      const src = join(dir, "src");
      mkdirSync(join(src, "repository"), { recursive: true });
      mkdirSync(join(src, "delivery"), { recursive: true });
      mkdirSync(join(src, "maturity"), { recursive: true });
      writeFileSync(
        join(src, "repository", "inventory.ts"),
        'import { publish } from "../delivery/publisher.js";\nexport const inventory = true;\n',
      );
      writeFileSync(join(src, "delivery", "publisher.ts"), "export function publish() {}\n");
      writeFileSync(
        join(src, "delivery", "run-record.ts"),
        'import { select } from "../maturity/cascade.js";\nexport const record = select;\n',
      );
      writeFileSync(join(src, "maturity", "cascade.ts"), "export function select() {}\n");

      const result = findSoftDependencyViolations({
        srcRoot: src,
        exceptions: [],
      });
      expect(result.violations.map((v) => v.rule).sort()).toEqual([
        "assessment-must-not-import-publication",
        "publication-must-not-own-maturity-selection",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors allowlisted temporary exceptions and rejects stale ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "docsfab-soft-deps-ex-"));
    try {
      const src = join(dir, "src");
      mkdirSync(join(src, "repository"), { recursive: true });
      mkdirSync(join(src, "delivery"), { recursive: true });
      writeFileSync(
        join(src, "repository", "inventory.ts"),
        'import { publish } from "../delivery/publisher.js";\n',
      );
      writeFileSync(join(src, "delivery", "publisher.ts"), "export function publish() {}\n");

      const exceptions = [
        {
          rule: "assessment-must-not-import-publication",
          importer: "src/repository/inventory.ts",
          imported: "src/delivery/publisher.ts",
          reason: "temporary fixture",
        },
      ];
      const allowed = findSoftDependencyViolations({ srcRoot: src, exceptions });
      expect(allowed.violations).toEqual([]);
      expect(allowed.staleExceptions).toEqual([]);

      const stale = findSoftDependencyViolations({
        srcRoot: src,
        exceptions: [
          ...exceptions,
          {
            rule: "assessment-must-not-import-publication",
            importer: "src/missing.ts",
            imported: "src/delivery/ghost.ts",
            reason: "stale",
          },
        ],
      });
      expect(stale.staleExceptions).toContain(
        "assessment-must-not-import-publication|src/missing.ts|src/delivery/ghost.ts",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
