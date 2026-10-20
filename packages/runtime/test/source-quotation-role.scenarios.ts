// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sourceCommentQuotationReader } from "../src/repository/source-quotation-role.js";

import { join } from "node:path";
import type { QaPartitionInputs } from "./helpers/qa-partition-inputs.js";

export function registerSourceQuotationScenarios(inputs: QaPartitionInputs): void {
  describe("verified source-comment quotations", () => {
    it("distinguishes the actual export header from its function and return statement", async () => {
      const source = await readFile(
        join(inputs.fixtureRoot, inputs.repositoryDirectory, "src/export.ts.fixture"),
        "utf8",
      );
      const read = sourceCommentQuotationReader("src/export.ts", source);
      for (const value of [
        inputs.exportDocumentation.replace(/^.*?: /u, ""),
        inputs.exportDocumentation,
        inputs.exportUsage,
      ])
        expect(read({ lineStart: 1, lineEnd: inputs.exportLineEnd, value }), value).toBe(true);
      for (const value of [inputs.exportImplementation, inputs.exportDeclaration])
        expect(read({ lineStart: 1, lineEnd: inputs.exportLineEnd, value }), value).toBe(false);
    });

    it("parses the complete file when the cited line starts inside a block comment", () => {
      const source = "/*\n * Writes a greetings file.\n */\nexport const output = 'csv';\n";
      expect(
        sourceCommentQuotationReader(
          "src/export.ts",
          source,
        )({
          lineStart: 2,
          lineEnd: 2,
          value: "Writes a greetings file.",
        }),
      ).toBe(true);
    });

    it.each([
      ["// Writes a file.\n// Usage: export --out FILE", true],
      ["/* Writes a file. */\n/* Usage: export --out FILE */", true],
      ["// Writes a file.\nexport const out = 'csv';\n// Usage: export --out FILE", false],
      [
        "// Writes a file.\n// SPDX-License-Identifier: Apache-2.0\n// Usage: export --out FILE",
        false,
      ],
    ])(
      "requires an entire header quotation to contain only ordinary comments: %s",
      (value, expected) => {
        expect(
          sourceCommentQuotationReader(
            "src/export.ts",
            `${value}\n`,
          )({
            lineStart: 1,
            lineEnd: value.split("\n").length,
            value,
          }),
        ).toBe(expected);
      },
    );

    it.each([
      ["// Further handler details are documented here.\n", true],
      ["\n// Further handler details are documented here.\n// More examples follow.\n\n", true],
      ["/* Further handler details are documented here. */ \n\t", true],
      ["// Further handler details are documented here.\nexport const status = 500;\n", false],
      ["// Further handler details are documented here.\n// All rights are reserved.\n", false],
      ["/* node:coverage ignore next */\n", false],
      ['export const detail = "// Further handler details are documented here.";\n', false],
      [" \n\n", false],
    ])(
      "classifies an entire supporting excerpt including outer whitespace: %s",
      (source, expected) => {
        expect(
          sourceCommentQuotationReader(
            "src/support.ts",
            source,
          )({ lineStart: 1, lineEnd: source.split("\n").length, value: source }),
        ).toBe(expected);
      },
    );

    it.each([
      ['export const label = "// writes a file.";\n', "writes a file."],
      ["export const label = `/* writes a file. */`;\n", "writes a file."],
      ["// writes a file.\nexport const label = 'writes a file.';\n", "writes a file."],
      ["// writes a file.\n// writes a file.\n", "writes a file."],
      ["// header\nexport const label = 'csv';\n", "header\nexport"],
      ["/* writes a file.\n", "writes a file."],
    ])("does not promote runtime data, ambiguity or uncertain syntax: %s", (source, value) => {
      expect(
        sourceCommentQuotationReader(
          "src/export.ts",
          source,
        )({
          lineStart: 1,
          lineEnd: source.split("\n").length,
          value,
        }),
      ).toBe(false);
    });

    it.each([
      ["// @ts-expect-error deliberate type boundary", "deliberate type boundary"],
      ["/*#__PURE__*/", "__PURE__"],
      ['/// <reference types="node" />', "node"],
      ["// eslint-disable-next-line no-console", "no-console"],
      ["// SPDX-License-Identifier: Apache-2.0", "Apache-2.0"],
      ["/* Copyright Example. All rights reserved. */", "Example"],
      ["// All rights reserved.", "rights reserved"],
      ["// All rights are reserved.", "All rights are reserved."],
      ["// Some rights remain reserved.", "Some rights remain reserved."],
      ["// Licensed under the Example License.", "Example License"],
      ["// © Example Corporation", "Example Corporation"],
      ["// Security: authorization is required.", "authorization is required."],
      ["// Permission to use this software is restricted.", "use this software"],
      ["// sourceMappingURL=generated.js.map", "generated.js.map"],
      ["// Generated from the approved interface.", "approved interface"],
      ['/* webpackChunkName: "export" */', "export"],
      ["/* node:coverage ignore next */", "node:coverage ignore next"],
      ["// node:coverage disable", "node:coverage disable"],
      ["// noinspection JSUnusedGlobalSymbols", "noinspection JSUnusedGlobalSymbols"],
      ["/*\n * noinspection JSUnusedGlobalSymbols\n */", "noinspection JSUnusedGlobalSymbols"],
      ["// lint:ignore unused-variable", "lint:ignore unused-variable"],
      ["// const format = 'file';", "format"],
    ])("preserves directive, legal and security evidence: %s", (comment, value) => {
      expect(
        sourceCommentQuotationReader(
          "src/export.ts",
          `${comment}\nexport const value = 1;\n`,
        )({
          lineStart: 1,
          lineEnd: comment.split("\n").length,
          value,
        }),
      ).toBe(false);
    });

    it("does not let a different metadata comment hide an ordinary documented quotation", () => {
      const source =
        "// SPDX-License-Identifier: Apache-2.0\n// Writes a greetings file.\nexport const value = 1;\n";
      expect(
        sourceCommentQuotationReader(
          "src/export.ts",
          source,
        )({
          lineStart: 2,
          lineEnd: 2,
          value: "Writes a greetings file.",
        }),
      ).toBe(true);
    });

    it("requires a valued quotation inside its verified cited lines", () => {
      const read = sourceCommentQuotationReader(
        "src/export.ts",
        "// Writes a greetings file.\nexport const value = 1;\n",
      );
      for (const side of [
        { lineStart: 1, lineEnd: 1, value: null },
        { lineStart: 1, lineEnd: 1, value: "" },
        { lineStart: 1, lineEnd: 1, value: " " },
        { lineStart: 1, lineEnd: 1, value: "Not present." },
        { lineStart: 2, lineEnd: 2, value: "Writes a greetings file." },
        { lineStart: 0, lineEnd: 1, value: "Writes a greetings file." },
        { lineStart: 2, lineEnd: 1, value: "Writes a greetings file." },
        { lineStart: 1, lineEnd: 4, value: "Writes a greetings file." },
      ])
        expect(read(side), JSON.stringify(side)).toBe(false);
    });

    it.each(["src/export.py", "src/export.go", "docs/export.md", "src/export.unknown"])(
      "does not infer comment syntax for %s",
      (path) => {
        expect(
          sourceCommentQuotationReader(
            path,
            "// Writes a greetings file.\n",
          )({
            lineStart: 1,
            lineEnd: 1,
            value: "Writes a greetings file.",
          }),
        ).toBe(false);
      },
    );
  });
}
