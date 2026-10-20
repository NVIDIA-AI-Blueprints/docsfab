// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { assertUsableHarnessStepResult, InferenceStepError } from "../src/execution/contracts.js";

describe("harness step result contract", () => {
  it("rejects an unparsed literal tool call as malformed evidence", () => {
    expect(() =>
      assertUsableHarnessStepResult({
        summary: '<tool_call><function=find>{"pattern":"title"}</function></tool_call>',
      }),
    ).toThrowError(
      expect.objectContaining({
        category: "malformed-response",
        retryable: true,
      }),
    );
  });

  it("rejects a model report that its requested skill is unavailable", () => {
    expect(() =>
      assertUsableHarnessStepResult({
        summary: "The requested skill is not available in this repository.",
      }),
    ).toThrowError(
      expect.objectContaining({
        category: "provider-terminal",
        retryable: false,
      }),
    );
  });

  it("rejects the observed multi-sentence unavailable-skill report", () => {
    expect(() =>
      assertUsableHarnessStepResult({
        summary:
          "The skill `test-audience-understanding` is not available in the repository. " +
          "Based on the repository structure and the skill's location reference " +
          "(`/Users/example-user/repos/docsfab/packages/runtime/skill-crate/...`), this skill " +
          "exists in a different repository checkout, not in the current workspace. " +
          "The audience evidence could not be collected from this checkout. No artifacts " +
          "were produced by the step.",
      }),
    ).toThrowError(
      expect.objectContaining({
        category: "provider-terminal",
        retryable: false,
      }),
    );
  });

  it.each([
    "The guide says the requested skill is not available in offline mode, but that sentence is outdated.",
    "The page documents this malformed sample: <tool_call><function=find>{}</function></tool_call>, which must be removed.",
  ])("accepts prose that quotes a failure signal: %s", (summary) => {
    expect(assertUsableHarnessStepResult({ summary })).toEqual({ summary });
  });

  it("retains the existing validation for a normal non-empty result", () => {
    expect(assertUsableHarnessStepResult({ summary: "Completed the inspection." })).toEqual({
      summary: "Completed the inspection.",
    });
  });

  it.each([
    ["blank", { summary: "  " }, "blank-response"],
    ["missing summary", {}, "malformed-response"],
  ] as const)("rejects %s result", (_label, result, category) => {
    expect(() => assertUsableHarnessStepResult(result)).toThrowError(
      expect.objectContaining<Partial<InferenceStepError>>({ category }),
    );
  });
});

describe("execution source-evidence port ownership", () => {
  function workflowExecutionDependencies(source: string): string[] {
    const file = ts.createSourceFile(
      "execution-contracts.test-fixture.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const dependencies: string[] = [];
    const isWorkflowExecutionSpecifier = (specifier: string) =>
      specifier.startsWith(".") && specifier.split("/").includes("workflow-execution");

    function visit(node: ts.Node) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isWorkflowExecutionSpecifier(node.moduleSpecifier.text)
      ) {
        dependencies.push(node.moduleSpecifier.text);
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isWorkflowExecutionSpecifier(node.moduleSpecifier.text)
      ) {
        dependencies.push(node.moduleSpecifier.text);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal) &&
        isWorkflowExecutionSpecifier(node.argument.literal.text)
      ) {
        dependencies.push(node.argument.literal.text);
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteralLike(node.moduleReference.expression) &&
        isWorkflowExecutionSpecifier(node.moduleReference.expression.text)
      ) {
        dependencies.push(node.moduleReference.expression.text);
      }
      ts.forEachChild(node, visit);
    }

    visit(file);
    return dependencies;
  }

  function expectNoWorkflowExecutionDependency(source: string) {
    expect(workflowExecutionDependencies(source)).toEqual([]);
  }

  it("owns SourceEvidenceRunnerBinding without type-importing workflow-execution", () => {
    const source = readFileSync(
      new URL("../src/execution/contracts/execution-services.ts", import.meta.url),
      "utf8",
    );
    const facade = readFileSync(new URL("../src/execution/contracts.ts", import.meta.url), "utf8");
    expect(source).toMatch(/export interface SourceEvidenceRunnerBinding\b/);
    expect(source).toMatch(/sourceEvidence\?:\s*SourceEvidenceRunnerBinding;/);
    expect(facade).toMatch(/export \* from ["']\.\/contracts\/execution-services\.js["'];/);
    expectNoWorkflowExecutionDependency(source);
  });

  it("rejects imports, exports, and import-equals workflow dependencies across syntax forms", () => {
    const prohibited = [
      `import type {
  SourceEvidenceRunnerBinding as RunnerBinding,
} from "../../workflow-execution/source-evidence.js";`,
      `interface ExecutionServices {
  sourceEvidence?: import(
    "../../workflow-execution/source-evidence.js"
  ).SourceEvidenceRunnerBinding;
}`,
      `export type RunnerBinding =
  import("../../workflow-execution/source-evidence.js")
    .SourceEvidenceRunnerBinding;`,
      `export type {
  SourceEvidenceRunnerBinding as RunnerBinding,
} from "../../workflow-execution/source-evidence.js";`,
      `export {
  type SourceEvidenceRunnerBinding as RunnerBinding,
  executionService,
} from "../../workflow-execution/source-evidence.js";`,
      `export * as workflowExecution from "../../workflow-execution/source-evidence.js";`,
      `import WorkflowExecution = require("../../workflow-execution/source-evidence.js");`,
    ];

    for (const source of prohibited) {
      expect(() => expectNoWorkflowExecutionDependency(source)).toThrow();
    }
  });

  it("ignores workflow-execution text in comments and string literals", () => {
    expectNoWorkflowExecutionDependency(`
      // import type { RunnerBinding } from "../../workflow-execution/source-evidence.js";
      const example = 'import("../../workflow-execution/source-evidence.js")';
      const exportExample = 'export type { RunnerBinding } from "../../workflow-execution/source-evidence.js"';
    `);
  });
});
