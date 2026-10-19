// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { persistFirstPassContradictionStop } from "../src/cli/run/first-pass-contradiction-stop.js";
import { planLiveFirstPassChoice } from "../src/live-agent/first-pass-choice.js";
import { FileRunStore } from "../src/records/file-store.js";
import { recordedIntent } from "./helpers/first-pass-intent.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { validModelConfig } from "./helpers.js";

const roots = temporaryRoots();
afterEach(() => roots.cleanup());

const cases = [
  {
    name: "constant template supplies the unique runtime value",
    text: "// Port 9090.\nexport const port = `8088`;\n",
    lines: [1, 2],
    selected: 1,
    explicitOption: 1,
  },
  {
    name: "ordinary constant and static template remain ambiguous",
    text: "export const oldPort = 9090;\nexport const port = `8088`;\n",
    lines: [1, 2],
    selected: null,
    explicitOption: 1,
  },
  {
    name: "code-like template text does not lend a scalar",
    text: "export const example = `export const port = 9090;`;\nexport const port = 8088;\n",
    lines: [1, 2],
    selected: 1,
    explicitOption: 1,
  },
  {
    name: "code-like template and runtime value share a line",
    text: "export const example = `export const port = 9090;`; export const port = 8088;\n",
    lines: [1, 1],
    selected: 1,
    explicitOption: 1,
  },
  {
    name: "dynamic template prefix does not establish the whole value",
    text: "// Port 9090.\nexport const port = `8088${suffix}`;\n",
    lines: [1, 2],
    selected: null,
    explicitOption: 1,
  },
  {
    name: "tagged template text does not establish the result",
    text: "// Port 9090.\nexport const port = tag`8088`;\n",
    lines: [1, 2],
    selected: null,
    explicitOption: 1,
  },
  {
    name: "erased template type cannot hide a runtime template",
    text: "export type Port = `9090`;\nexport const port = `8088`;\n",
    lines: [1, 2],
    selected: 1,
    explicitOption: 1,
  },
  {
    name: "nullable static template keeps source-only binding",
    text: "// Port 9090.\nexport const port = `8088`;\n",
    lines: [1, 2],
    values: [null, null],
    explicitOption: 1,
    exactExpected: "choice",
    selected: 1,
  },
  {
    name: "const enum and runtime const remain ambiguous",
    text: "export const port = 9090;\nexport const enum Port { Listen = 8088 }\n",
    lines: [1, 2],
    selected: null,
  },
  {
    name: "ordinary runtime enum",
    text: "// Port 9090.\nexport enum Port { Listen = 8088 }\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "const and runtime enum remain ambiguous",
    text: "export const port = 9090;\nexport enum Port { Listen = 8088 }\n",
    lines: [1, 2],
    selected: null,
  },
  {
    name: "erased type before runtime enum",
    text: "export type Port = 9090;\nexport enum RuntimePort { Listen = 8088 }\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "declared enum is erased",
    text: "export declare enum Port { Listen = 9090 }\nexport const port = 8088;\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "runtime namespace initializer",
    text: "// Port 9090.\nexport namespace Settings {\nexport const port = 8088;\n}\n",
    lines: [1, 3],
    selected: 1,
  },
  {
    name: "runtime parameter property",
    text: "// Port 9090.\nexport class Settings {\nconstructor(public port = 8088) {}\n}\n",
    lines: [1, 3],
    selected: 1,
  },
  {
    name: "runtime export assignment",
    text: "// Port 9090.\nexport = 8088;\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "as const expression keeps its value",
    text: "// Port 9090.\nexport const port = (8088 as const);\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "satisfies expression keeps its value",
    text: "// Port 9090.\nexport const port = (8088 satisfies number);\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "non-null expression keeps its value",
    text: "// Port 9090.\nexport const port = (8088 as number)!;\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "generic type argument is erased beside runtime argument",
    text: "export const port = identity<9090>(8088);\n",
    lines: [1, 1],
    selected: 1,
  },
  {
    name: "ambient module is erased",
    text: 'module "ambient" { export const port = 9090; }\nexport const port = 8088;\n',
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "const enum member remains a runtime value alternative",
    text: "// Port 9090.\nexport const enum Port { Listen = 8088 }\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "erased type versus runtime property",
    text: "export type Port = 9090;\nexport const settings = {\n  port: 8088,\n};\n",
    lines: [1, 3],
    selected: 1,
  },
  {
    name: "code-like string versus runtime property",
    text: 'export const example = "export const port = 9090;";\nexport const settings = {\n  port: 8088,\n};\n',
    lines: [1, 3],
    selected: 1,
  },
  {
    name: "comment versus runtime property",
    text: "// Port = 9090.\nexport const settings = {\n  port: 8088,\n};\n",
    lines: [1, 3],
    selected: 1,
  },
  {
    name: "comment versus constant",
    text: "// Port 9090.\nexport const port = 8088;\n",
    lines: [1, 2],
    selected: 1,
  },
  {
    name: "erased type shares a line with runtime property",
    text: "export type Port = 9090; export const settings = {port: 8088};\n",
    lines: [1, 1],
    selected: 1,
  },
  {
    name: "code-like string shares a line with runtime property",
    text: 'export const example = "export const port = 9090;"; export const settings = {port: 8088};\n',
    lines: [1, 1],
    selected: 1,
  },
  {
    name: "type annotation shares a line with runtime value",
    text: "export const settings: {port: 9090} = {port: 8088};\n",
    lines: [1, 1],
    selected: 1,
  },
  {
    name: "two erased types provide no implementation",
    text: "export type OldPort = 9090;\nexport type NewPort = 8088;\n",
    lines: [1, 2],
    selected: null,
  },
  {
    name: "two runtime constants remain ambiguous",
    text: "export const oldPort = 9090;\nexport const port = 8088;\n",
    lines: [1, 2],
    selected: null,
  },
  {
    name: "nullable comment and implementation preserve source-only binding",
    text: "// Port 9090.\nexport const port = 8088;\n",
    lines: [1, 2],
    values: [null, null],
    explicitOption: 1,
    exactExpected: "choice",
    selected: 1,
  },
  {
    name: "nullable same-line sources provide no unique identity",
    text: "export type Port = 9090; export const port = 8088;\n",
    lines: [1, 1],
    values: [null, null],
    explicitOption: 1,
    exactExpected: "refused",
    selected: null,
  },
  {
    name: "unary ownership: matching-negative",
    text: "// Port 9090.\nexport const port = -8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "-8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: wrong-positive-from-negative",
    text: "// Port 9090.\nexport const port = -8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: null,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: unary-sign-does-not-fabricate-ambiguity",
    text: "export const port = 9090;\nexport const otherPort = -8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: 0,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: genuine-two-runtime-ambiguity",
    text: "export const port = 9090;\nexport const otherPort = -8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "-8088"],
    selected: null,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: negative-through-runtime-wrapper",
    text: "// Port 9090.\nexport const port = (-8088 as const);\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "-8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: erased-negative-does-not-lend-runtime",
    text: "export type Port = -9090;\nexport const port = -8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["-9090", "-8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: nullable-negative-source-only",
    text: "// Port 9090.\nexport const port = -8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: [null, null],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: positive-adjacent-control",
    text: "// Port 9090.\nexport const port = 8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: unary-plus-preserves-positive-numeric-literal",
    text: "// Port 9090.\nexport const port = +8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: unary-plus-and-matching-negative-remain-ambiguous",
    text: "export const port = +9090;\nexport const otherPort = -8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "-8088"],
    selected: null,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: unary-plus-as-const",
    text: "// Port 9090.\nexport const port = +(8088 as const);\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: unary-plus-satisfies",
    text: "// Port 9090.\nexport const port = +(8088 satisfies number);\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: unary-plus-nonnull",
    text: "// Port 9090.\nexport const port = +((8088 as number)!);\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: inverse-nesting-as-number-positive",
    text: "// Port 9090.\nexport const port = +(8088 as number);\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: inverse-nesting-as-number-true-ambiguity",
    text: "export const oldPort = 9090;\nexport const port = +(8088 as number);\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "8088"],
    selected: null,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: operand-only-split-span-must-not-own-whole-unary",
    text: "// Port 9090.\nexport const port = +\n8088;\n",
    lines: [1, 3],
    lineEnds: [1, 3],
    values: ["9090", "8088"],
    selected: null,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: complete-split-unary-span-preserves-ownership",
    text: "// Port 9090.\nexport const port = +\n8088;\n",
    lines: [1, 2],
    lineEnds: [1, 3],
    values: ["9090", "8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
  {
    name: "unary ownership: exact-signed-plus-whole-source-match",
    text: "// Port 9090.\nexport const port = +8088;\n",
    lines: [1, 2],
    lineEnds: [1, 2],
    values: ["9090", "+8088"],
    selected: 1,
    explicitOption: 1,
    exactExpected: "choice",
  },
] as const;

describe("runtime syntax for an offered first-pass implementation reply", () => {
  it.each(cases)(
    "checks $name without changing the stop or allocating a claim",
    async (example) => {
      const root = await roots.create("choice-executable-");
      const repositoryPath = join(root, "repo");
      const revision = await initFixtureRepo(repositoryPath, {
        "README.md": "# Fixture\n",
        "src/server.ts": example.text,
      });
      const instruction = "Create docs/port.md for the listening port.";
      const config = {
        projectRoot: process.cwd(),
        stateDirectory: join(root, "runs"),
        model: validModelConfig,
      } as DocsFabConfig;
      const values = "values" in example ? example.values : ["9090", "8088"];
      const source = await persistFirstPassContradictionStop({
        request: {
          workflow: "create-documentation",
          repositoryPath,
          revision,
          instruction,
          allowWrite: true,
          releaseGate: false,
          patchOnly: true,
          requestIntent: recordedIntent(instruction, {
            operation: "create",
            targets: [{ path: "docs/port.md", quote: "docs/port.md" }],
          }),
        } as never,
        config,
        workspace: { sourcePath: repositoryPath, revision, requestedRevision: revision } as never,
        contradictions: [
          {
            obligationId: "port",
            targetPaths: ["docs/port.md"],
            condition: "listening port",
            sides: [
              {
                path: "src/server.ts",
                lineStart: example.lines[0],
                lineEnd: "lineEnds" in example ? example.lineEnds[0] : example.lines[0],
                value: values[0]!,
              },
              {
                path: "src/server.ts",
                lineStart: example.lines[1],
                lineEnd: "lineEnds" in example ? example.lineEnds[1] : example.lines[1],
                value: values[1]!,
              },
            ],
          },
        ],
      });
      const store = new FileRunStore(config.stateDirectory);
      const before = (await store.getWithDigest(source.id)).sha256;
      const selected = await planLiveFirstPassChoice({
        stateDirectory: config.stateDirectory,
        repositoryPath,
        pendingRunId: source.id,
        replyText: "Use the implementation",
      });
      if (example.selected === null) expect(selected.kind).toBe("refused");
      else {
        expect(selected.kind).toBe("choice");
        if (selected.kind !== "choice") return;
        expect(selected.plan.choices.at(-1)?.optionIndex).toBe(example.selected);
        expect(selected.plan.instruction).toBe(instruction);
        expect(selected.plan.revision).toBe(revision);
      }
      // Exact offered provenance stays independent of implementation shorthand.
      const optionIndex = "explicitOption" in example ? example.explicitOption : 0;
      const option = source.firstPassContradiction!.question.options[optionIndex]!;
      const exact = await planLiveFirstPassChoice({
        stateDirectory: config.stateDirectory,
        repositoryPath,
        pendingRunId: source.id,
        replyText: option,
      });
      if ("exactExpected" in example && example.exactExpected === "refused") {
        expect(source.firstPassContradiction!.question.options[0]).toBe(option);
        expect(exact.kind).toBe("refused");
      } else {
        expect(exact.kind).toBe("choice");
        if (exact.kind === "choice") {
          expect(exact.plan.choices.at(-1)?.optionIndex).toBe(optionIndex);
          expect(exact.plan.revision).toBe(revision);
          expect(exact.plan.sourceRunId).toBe(source.id);
        }
      }
      expect((await store.getWithDigest(source.id)).sha256).toBe(before);
      await expect(readdir(join(root, "first-pass-choice-claims"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
