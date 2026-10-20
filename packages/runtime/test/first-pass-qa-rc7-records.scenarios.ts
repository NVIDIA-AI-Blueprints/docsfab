// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest, sha256 } from "../src/content-ir/canonical.js";
import { bindFirstPassKnowledge } from "../src/cli/first-pass.js";
import {
  firstPassAssessmentBindingSha256,
  FirstPassSupportValidationError,
  validateFirstPassSupport,
  type FirstPassSupportModelBridge,
} from "../src/cli/first-pass-support.js";
import { firstPassContradictionAdmission } from "../src/records/first-pass-contradiction-admission.js";
import { createFirstPassChoice } from "../src/records/first-pass-choice.js";
import { FirstPassChoiceContinuationError } from "../src/cli/run/first-pass-choice-continuation.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { parseEvidenceFrames, renderEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";

import type { QaPartitionInputs } from "./helpers/qa-partition-inputs.js";

export function registerQaRecordScenarios(inputs: QaPartitionInputs): void {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fixtureRoot = inputs.fixtureRoot;
  const roots = temporaryRoots();
  afterEach(() => roots.cleanup());

  async function cases() {
    return JSON.parse(await readFile(join(fixtureRoot, "cases.json"), "utf8"));
  }
  async function workspace() {
    const root = await roots.create("first-pass-rc7-records-");
    const path = join(root, "repository");
    const files: Record<string, string> = {};
    for (const name of [
      "README.md",
      "docs/guide.md",
      "docs/quickstart.md",
      `${inputs.cliSourcePath}`,
    ])
      files[name] = await readFile(
        join(
          fixtureRoot,
          inputs.repositoryDirectory,
          name === `${inputs.cliSourcePath}` ? `${name}.fixture` : name,
        ),
        "utf8",
      );
    const provenance = (await cases()).provenance[inputs.sourceDigestKey];
    for (const [name, text] of Object.entries(files)) expect(sha256(text)).toBe(provenance[name]);
    files[".docsfab.json"] = await readFile(
      join(fixtureRoot, "project-config.json.fixture"),
      "utf8",
    );
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(path, name)), { recursive: true });
      await writeFile(join(path, name), text);
    }
    return { root, path, files };
  }
  function binding(support: any, files: Record<string, string>): string {
    const mandatory = support.obligations.map((row: any) =>
      Object.fromEntries(
        ["id", "origin", "instructionSpan", "targetPaths", "condition", "requiredSourceSupport"]
          .filter((key) => key in row)
          .map((key) => [key, row[key]]),
      ),
    );
    const rows = support.obligations.map((row: any) => ({
      obligationId: row.id,
      status: row.status,
      evidenceSpanIds: row.evidenceSpanIds,
      detail: row.detail,
      ...(row.sides ? { sides: row.sides } : {}),
    }));
    const line = `Mandatory obligations: ${JSON.stringify(mandatory)}`;
    const frames = support.sourceSpans.map((span: any) => ({
      ...span,
      text: files[span.path]!.normalize("NFC")
        .replace(/\r\n?/gu, "\n")
        .split("\n")
        .slice(span.lineStart - 1, span.lineEnd)
        .join("\n"),
    }));
    const prompt = [line, ...renderEvidenceFrames(frames, [line])].join("\n\n");
    return firstPassAssessmentBindingSha256(
      prompt,
      JSON.stringify({ schemaVersion: 1, assessments: rows }),
      parseEvidenceFrames,
    );
  }

  describe(inputs.suiteLabel, () => {
    it.each(["setup", "harness"] as const)(
      "continues from the original %s support with every recorded citation intact",
      async (name) => {
        const setup = await workspace();
        const data = await cases();
        const support = JSON.parse(
          await readFile(join(fixtureRoot, `${name}-support.json.fixture`), "utf8"),
        );
        const before = JSON.stringify(support);
        const notices: string[] = [];
        const validated = await validateFirstPassSupport({
          support,
          workspacePath: setup.path,
          workflow: "create-documentation",
          instruction: data[name].instruction,
          instructionTargetPaths: support.targetPaths,
          revision: support.repositoryRevision,
          snapshotSha256: support.snapshotSha256,
          expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
          expectedAssessmentBindingSha256: binding(support, setup.files),
          onResolvedContradictions: (_ids, lines) => notices.push(...lines),
        }).catch((error: unknown) => {
          const code = error instanceof FirstPassSupportValidationError ? error.code : "unknown";
          throw new Error(`Retained ${name} support stopped (${code}).`, { cause: error });
        });
        expect(validated).toMatchObject({
          workflow: "create-documentation",
          targetPaths: support.targetPaths,
        });
        expect(notices.join("\n")).toContain("docs-stale:");
        expect(notices.join("\n")).toContain(`${inputs.cliSourcePath}`);
        expect(JSON.stringify(support)).toBe(before);
      },
    );

    it.each([false, true])(
      "verifies full bytes beyond an unvalued presentation span (tampered %s)",
      async (tampered) => {
        const setup = await workspace();
        const support = JSON.parse(
          await readFile(join(fixtureRoot, "harness-support.json.fixture"), "utf8"),
        );
        const source = support.sourceSpans.find(
          (span: any) => span.path === `${inputs.cliSourcePath}`,
        );
        source.lineEnd = inputs.presentationEndLine;
        source.spanSha256 = sha256(
          setup.files[source.path]!.split("\n")
            .slice(source.lineStart - 1, source.lineEnd)
            .join("\n"),
        );
        const { supportSha256: _hash, ...body } = support;
        support.supportSha256 = canonicalDigest(body);
        if (tampered)
          await writeFile(
            join(setup.path, source.path),
            setup.files[source.path]!.replace(
              "JSON.stringify({message})",
              "JSON.stringify({greeting: message})",
            ),
          );
        const notices: string[] = [];
        const result = validateFirstPassSupport({
          support,
          workspacePath: setup.path,
          workflow: "create-documentation",
          instruction: (await cases()).harness.instruction,
          instructionTargetPaths: support.targetPaths,
          revision: support.repositoryRevision,
          snapshotSha256: support.snapshotSha256,
          expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
          expectedAssessmentBindingSha256: binding(support, setup.files),
          onResolvedContradictions: (_ids, lines) => notices.push(...lines),
        });
        if (tampered)
          await expect(result).rejects.toMatchObject({ code: "support-provenance-invalid" });
        else {
          await expect(result).resolves.toMatchObject({ workflow: "create-documentation" });
          expect(notices.join("\n")).toContain('corroborated JSON property: "message"');
          expect(notices.join("\n")).toContain(`lines ${inputs.serializerLines}`);
          expect(notices.join("\n")).toContain(
            `lines 1-${inputs.presentationEndLine}; no disputed value asserted`,
          );
          expect(notices.join("\n")).toContain("example payload is not verified product truth");
        }
      },
    );

    it.each([
      ["an arbitrary object", "({ message })"],
      ["a computed property", 'JSON.stringify({ ["message"]: message })'],
      ["a spread", "JSON.stringify({ ...extra, message })"],
      ["a second property", "JSON.stringify({ message, other: true })"],
      ["an undefined property value", "JSON.stringify({ message: undefined })"],
      ["a function property value", "JSON.stringify({ message: () => 'hello' })"],
      ["a symbol property value", "JSON.stringify({ message: Symbol('hello') })"],
      ["an undefined const binding", "JSON.stringify({message})", "undefined"],
      ["a function const binding", "JSON.stringify({message})", "() => 'hello'"],
      ["a symbol const binding", "JSON.stringify({message})", "Symbol('hello')"],
      [
        "a shadowed const binding",
        "(function render(message) { return JSON.stringify({message}); }, JSON.stringify({message}))",
      ],
      [
        "different serializer properties",
        "(JSON.stringify({ other: message }), JSON.stringify({ message }))",
      ],
      [
        "a neighboring dynamic serializer",
        "(JSON.stringify({ [key]: message }), JSON.stringify({ message }))",
      ],
      ["a custom toJSON property", "JSON.stringify({ toJSON: message })"],
      ["a local JSON binding", "((JSON) => JSON.stringify({ message }))(customSerializer)"],
      [
        "a reassigned serializer",
        "((JSON.stringify = customSerializer), JSON.stringify({ message }))",
      ],
    ])(
      "does not corroborate the original JSON example from %s",
      async (_name, expression, initializer: string | undefined = undefined) => {
        const setup = await workspace();
        const support = JSON.parse(
          await readFile(join(fixtureRoot, "harness-support.json.fixture"), "utf8"),
        );
        setup.files[`${inputs.cliSourcePath}`] = setup.files[`${inputs.cliSourcePath}`]!.replace(
          "JSON.stringify({message})",
          expression,
        );
        if (initializer !== undefined)
          setup.files[`${inputs.cliSourcePath}`] = setup.files[`${inputs.cliSourcePath}`]!.replace(
            inputs.messageDeclaration,
            `const message = ${initializer};`,
          );
        await writeFile(
          join(setup.path, `${inputs.cliSourcePath}`),
          setup.files[`${inputs.cliSourcePath}`]!,
        );
        for (const span of support.sourceSpans) {
          if (span.path !== `${inputs.cliSourcePath}`) continue;
          const text = setup.files[span.path]!.normalize("NFC").replace(/\r\n?/gu, "\n");
          span.fileSha256 = sha256(setup.files[span.path]!);
          span.spanSha256 = sha256(
            text
              .split("\n")
              .slice(span.lineStart - 1, span.lineEnd)
              .join("\n"),
          );
        }
        const { supportSha256: _hash, ...body } = support;
        support.supportSha256 = canonicalDigest(body);
        await expect(
          validateFirstPassSupport({
            support,
            workspacePath: setup.path,
            workflow: "create-documentation",
            instruction: (await cases()).harness.instruction,
            instructionTargetPaths: support.targetPaths,
            revision: support.repositoryRevision,
            snapshotSha256: support.snapshotSha256,
            expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
            expectedAssessmentBindingSha256: binding(support, setup.files),
          }),
        ).rejects.toMatchObject({ code: "contradicted" });
      },
    );

    it("does not confuse a destructuring key with a JSON binding", async () => {
      const setup = await workspace();
      const support = JSON.parse(
        await readFile(join(fixtureRoot, "harness-support.json.fixture"), "utf8"),
      );
      setup.files[`${inputs.cliSourcePath}`] = setup.files[`${inputs.cliSourcePath}`]!.replace(
        "const message =",
        "const { JSON: serializer } = { JSON: null };\nconst message =",
      );
      await writeFile(
        join(setup.path, `${inputs.cliSourcePath}`),
        setup.files[`${inputs.cliSourcePath}`]!,
      );
      for (const span of support.sourceSpans) {
        const text = setup.files[span.path]!.normalize("NFC").replace(/\r\n?/gu, "\n");
        span.fileSha256 = sha256(setup.files[span.path]!);
        span.spanSha256 = sha256(
          text
            .split("\n")
            .slice(span.lineStart - 1, span.lineEnd)
            .join("\n"),
        );
      }
      const { supportSha256: _hash, ...body } = support;
      support.supportSha256 = canonicalDigest(body);
      const notices: string[] = [];
      await expect(
        validateFirstPassSupport({
          support,
          workspacePath: setup.path,
          workflow: "create-documentation",
          instruction: (await cases()).harness.instruction,
          instructionTargetPaths: support.targetPaths,
          revision: support.repositoryRevision,
          snapshotSha256: support.snapshotSha256,
          expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
          expectedAssessmentBindingSha256: binding(support, setup.files),
          onResolvedContradictions: (_ids, lines) => notices.push(...lines),
        }),
      ).resolves.toMatchObject({ workflow: "create-documentation" });
      expect(notices.join("\n")).toContain('corroborated JSON property: "message"');
    });

    it.each([
      ["the plain serializer", ""],
      [
        "an inherited serializer",
        'Object.prototype.toJSON = function () { return { greeting: "hello" }; };\n',
      ],
      [
        "an aliased inherited serializer",
        'const inherited = Object.prototype; inherited.toJSON = function () { return { greeting: "hello" }; };\n',
      ],
      [
        "a reflective serializer definition",
        'Object.defineProperty(Object.prototype, "toJSON", { value() { return { greeting: "hello" }; } });\n',
      ],
      [
        "a reflected inherited serializer",
        'Reflect.set(Object.prototype, "toJSON", function () { return { greeting: "hello" }; });\n',
      ],
      ["an unverified runtime import", 'import "./custom-serializer.mjs";\n'],
      ["an unverified setup call", "configureSerialization();\n"],
      ["an unverified constructor", "new SerializerHooks();\n"],
      [
        "the global JSON loop-write review example",
        `for (JSON of [{ stringify() { return '{"greeting":"hello"}'; } }]) {}\n`,
      ],
      [
        "the destructured global JSON loop-write review example",
        `for ([JSON] of [[{ stringify() { return '{"greeting":"hello"}'; } }]]) {}\n`,
      ],
      ["a default expression that only reads JSON", "let other; for ([other = JSON] of [[]]) {}\n"],
      ["a declaration default that only reads JSON", "const [other = JSON] = [];\n"],
      [
        "an inherited serializer assigned by iteration",
        'for (Object.prototype.toJSON of [function () { return { greeting: "hello" }; }]) {}\n',
      ],
      [
        "an inherited serializer assigned by destructured iteration",
        'for ([Object.prototype.toJSON] of [[function () { return { greeting: "hello" }; }]]) {}\n',
      ],
      [
        "an inherited serializer assigned by destructuring",
        '({ toJSON: Object.prototype.toJSON } = { toJSON() { return { greeting: "hello" }; } });\n',
      ],
    ])("checks the original JSON contradiction with %s", async (_name, prelude) => {
      const setup = await workspace();
      const support = JSON.parse(
        await readFile(join(fixtureRoot, "harness-support.json.fixture"), "utf8"),
      );
      setup.files[`${inputs.cliSourcePath}`] = setup.files[`${inputs.cliSourcePath}`]!.replace(
        "console.log(format === 'json' ? JSON.stringify({message}) : message);",
        `${prelude}const output = JSON.stringify({ message: "hello" });\nconsole.log(format === 'json' ? output : message);`,
      );
      await writeFile(
        join(setup.path, `${inputs.cliSourcePath}`),
        setup.files[`${inputs.cliSourcePath}`]!,
      );
      for (const span of support.sourceSpans) {
        const text = setup.files[span.path]!.normalize("NFC").replace(/\r\n?/gu, "\n");
        span.fileSha256 = sha256(setup.files[span.path]!);
        span.spanSha256 = sha256(
          text
            .split("\n")
            .slice(span.lineStart - 1, span.lineEnd)
            .join("\n"),
        );
      }
      const { supportSha256: _hash, ...body } = support;
      support.supportSha256 = canonicalDigest(body);
      const notices: string[] = [];
      const result = validateFirstPassSupport({
        support,
        workspacePath: setup.path,
        workflow: "create-documentation",
        instruction: (await cases()).harness.instruction,
        instructionTargetPaths: support.targetPaths,
        revision: support.repositoryRevision,
        snapshotSha256: support.snapshotSha256,
        expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
        expectedAssessmentBindingSha256: binding(support, setup.files),
        onResolvedContradictions: (_ids, lines) => notices.push(...lines),
      });
      if (
        prelude &&
        _name !== "a default expression that only reads JSON" &&
        _name !== "a declaration default that only reads JSON"
      )
        await expect(result).rejects.toMatchObject({ code: "contradicted" });
      else {
        await expect(result).resolves.toMatchObject({ workflow: "create-documentation" });
        expect(notices.join("\n")).toContain('corroborated JSON property: "message"');
      }
    });

    it("keeps an unrelated literal from settling the CLI default", async () => {
      const setup = await workspace();
      const support = JSON.parse(
        await readFile(join(fixtureRoot, "setup-support.json.fixture"), "utf8"),
      );
      const item = support.obligations.find((row: any) => row.status === "contradicted");
      item.sides = item.sides.filter(
        (side: any) =>
          support.sourceSpans.find((span: any) => span.id === side.spanId).path !==
          `${inputs.cliSourcePath}`,
      );
      item.sides[0].value = `${inputs.currentName}`;
      item.sides[1].value = `${inputs.oldName}`;
      setup.files[`${inputs.cliSourcePath}`] = setup.files[`${inputs.cliSourcePath}`]!.replace(
        "const args =",
        `const retryDelay = '${inputs.currentName}'; const args =`,
      ).replace(`let name = '${inputs.currentName}';`, "let name = 'developer';");
      await writeFile(
        join(setup.path, `${inputs.cliSourcePath}`),
        setup.files[`${inputs.cliSourcePath}`]!,
      );
      for (const span of support.sourceSpans) {
        const text = setup.files[span.path]!.normalize("NFC").replace(/\r\n?/gu, "\n");
        span.fileSha256 = sha256(setup.files[span.path]!);
        span.spanSha256 = sha256(
          text
            .split("\n")
            .slice(span.lineStart - 1, span.lineEnd)
            .join("\n"),
        );
      }
      const { supportSha256: _hash, ...body } = support;
      support.supportSha256 = canonicalDigest(body);
      await expect(
        validateFirstPassSupport({
          support,
          workspacePath: setup.path,
          workflow: "create-documentation",
          instruction: (await cases()).setup.instruction,
          instructionTargetPaths: support.targetPaths,
          revision: support.repositoryRevision,
          snapshotSha256: support.snapshotSha256,
          expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
          expectedAssessmentBindingSha256: binding(support, setup.files),
        }),
      ).rejects.toMatchObject({ code: "contradicted" });
    });

    it.each([
      ["the original argument collection", "const args = process.argv.slice(2);"],
      [
        "a reassigned argument collection",
        `let args = process.argv.slice(2); args = ['${inputs.command}', '--name', 'other'];`,
      ],
      [
        "a pushed synthetic flag",
        "const args = process.argv.slice(2); args.push('--name', 'other');",
      ],
      [
        "a written synthetic flag",
        "const args = process.argv.slice(2); args[1] = '--name'; args[2] = 'other';",
      ],
      [
        "an aliased argument mutation",
        "const args = process.argv.slice(2); const alias = args; alias.push('--name', 'other');",
      ],
      [
        "the exact plain review example",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact global process assignment review example",
        "",
        `process = { argv: ["node", "${inputs.cliSourcePath.slice("src/".length)}", "--name", "other"] };\nconst args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact global process for-of review example",
        "",
        `for (process of [{ argv: ["node", "${inputs.cliSourcePath.slice("src/".length)}", "--name", "other"] }]) {}\nconst args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact destructured global process for-of review example",
        "",
        `for ([process] of [[{ argv: ["node", "${inputs.cliSourcePath.slice("src/".length)}", "--name", "other"] }]]) {}\nconst args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact reassigned-argv review example",
        "",
        `let args = process.argv.slice(2);\nargs = ["--name", "other"];\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact mutated-argv review example",
        "",
        `const args = process.argv.slice(2);\nargs.push("--name", "other");\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact loop-write review control",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\n\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact for-of review example",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nfor (name of ["other"]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact for-in review example",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nfor (name in {other: true}) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "the exact destructured for-of review example",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nfor ([name] of [["other"]]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an unrelated loop-write control",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nfor (let other of ["other"]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an array default that only reads the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nlet other; for ([other = name] of [[]]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an object default that only reads the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nlet other; for ({other = name} of [{}]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an assignment default that only reads the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nlet other; [other = name] = [];\nconst output = JSON.stringify({ name });`,
      ],
      [
        "a declaration default that only reads the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nconst [other = name] = [];\nconst output = JSON.stringify({ name });`,
      ],
      [
        "a computed pattern key that only reads the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nlet other; for ({[name]: other} of [{${inputs.currentName}: "read"}]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an array default that writes the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nfor ([name = "other"] of [[]]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an object default that writes the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nfor ({other: name = "other"} of [{}]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an array rest target that writes the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nfor ([...name] of [["other"]]) {}\nconst output = JSON.stringify({ name });`,
      ],
      [
        "an assignment inside a default expression that writes the CLI name",
        "",
        `const args = process.argv.slice(2);\nlet name = "${inputs.currentName}";\nfor (let i = 0; i < args.length; i++) { if (args[i] === "--name") name = args[i + 1]; }\nlet other; for ([other = (name = "other")] of [[]]) {}\nconst output = JSON.stringify({ name });`,
      ],
    ])("checks the documented CLI default against %s", async (name, declaration, exactProgram) => {
      const setup = await workspace();
      const support = JSON.parse(
        await readFile(join(fixtureRoot, "setup-support.json.fixture"), "utf8"),
      );
      const item = support.obligations.find((row: any) => row.status === "contradicted");
      item.sides = item.sides.filter(
        (side: any) =>
          support.sourceSpans.find((span: any) => span.id === side.spanId).path !==
          `${inputs.cliSourcePath}`,
      );
      item.sides[0].value = `${inputs.currentName}`;
      item.sides[1].value = `${inputs.oldName}`;
      setup.files[`${inputs.cliSourcePath}`] =
        exactProgram ??
        setup.files[`${inputs.cliSourcePath}`]!.replace(
          "const args = process.argv.slice(2);",
          declaration,
        );
      await writeFile(
        join(setup.path, `${inputs.cliSourcePath}`),
        setup.files[`${inputs.cliSourcePath}`]!,
      );
      for (const span of support.sourceSpans) {
        const text = setup.files[span.path]!.normalize("NFC").replace(/\r\n?/gu, "\n");
        if (exactProgram && span.path === `${inputs.cliSourcePath}`)
          span.lineEnd = text.split("\n").length;
        span.fileSha256 = sha256(setup.files[span.path]!);
        span.spanSha256 = sha256(
          text
            .split("\n")
            .slice(span.lineStart - 1, span.lineEnd)
            .join("\n"),
        );
      }
      const { supportSha256: _hash, ...body } = support;
      support.supportSha256 = canonicalDigest(body);
      const notices: string[] = [];
      const result = validateFirstPassSupport({
        support,
        workspacePath: setup.path,
        workflow: "create-documentation",
        instruction: (await cases()).setup.instruction,
        instructionTargetPaths: support.targetPaths,
        revision: support.repositoryRevision,
        snapshotSha256: support.snapshotSha256,
        expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
        expectedAssessmentBindingSha256: binding(support, setup.files),
        onResolvedContradictions: (_ids, lines) => notices.push(...lines),
      });
      if (
        name === "the original argument collection" ||
        name === "the exact plain review example" ||
        name === "the exact loop-write review control" ||
        name === "an unrelated loop-write control" ||
        name === "an array default that only reads the CLI name" ||
        name === "an object default that only reads the CLI name" ||
        name === "an assignment default that only reads the CLI name" ||
        name === "a declaration default that only reads the CLI name" ||
        name === "a computed pattern key that only reads the CLI name"
      ) {
        await expect(result).resolves.toMatchObject({ workflow: "create-documentation" });
        expect(notices.join("\n")).toContain(`chosen value: "${inputs.currentName}"`);
      } else await expect(result).rejects.toMatchObject({ code: "contradicted" });
    });

    it("does not claim a __proto__ setter is an own serialized property", async () => {
      const setup = await workspace();
      const support = JSON.parse(
        await readFile(join(fixtureRoot, "harness-support.json.fixture"), "utf8"),
      );
      setup.files["docs/guide.md"] = setup.files["docs/guide.md"]!.replaceAll(
        '"message"',
        '"__proto__"',
      );
      setup.files[`${inputs.cliSourcePath}`] = setup.files[`${inputs.cliSourcePath}`]!.replace(
        "JSON.stringify({message})",
        "JSON.stringify({ __proto__: message })",
      );
      for (const name of ["docs/guide.md", `${inputs.cliSourcePath}`])
        await writeFile(join(setup.path, name), setup.files[name]!);
      const item = support.obligations.find((row: any) => row.status === "contradicted");
      item.sides[0].value = item.sides[0].value.replace('"message"', '"__proto__"');
      for (const span of support.sourceSpans) {
        const text = setup.files[span.path]!.normalize("NFC").replace(/\r\n?/gu, "\n");
        span.fileSha256 = sha256(setup.files[span.path]!);
        span.spanSha256 = sha256(
          text
            .split("\n")
            .slice(span.lineStart - 1, span.lineEnd)
            .join("\n"),
        );
      }
      const { supportSha256: _hash, ...body } = support;
      support.supportSha256 = canonicalDigest(body);
      await expect(
        validateFirstPassSupport({
          support,
          workspacePath: setup.path,
          workflow: "create-documentation",
          instruction: (await cases()).harness.instruction,
          instructionTargetPaths: support.targetPaths,
          revision: support.repositoryRevision,
          snapshotSha256: support.snapshotSha256,
          expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
          expectedAssessmentBindingSha256: binding(support, setup.files),
        }),
      ).rejects.toMatchObject({ code: "contradicted" });
    });

    it("admits the exact W0 non-authoritative live context while preserving its digest", async () => {
      const data = (await cases()).export;
      expect(
        firstPassContradictionAdmission({
          runId: "export-stop",
          repositoryRevision: "a".repeat(40),
          instruction: data.instruction,
          instructionContext: data.instructionContext,
          contradiction: data.firstPassContradiction,
        }),
      ).toMatchObject({
        outcome: "repository-only",
        instructionContextSha256: canonicalDigest(data.instructionContext),
      });
    });

    it.each([
      "renamed docs discrepancy",
      "new implementation conflict",
      "changed selected source",
    ] as const)(
      "retains the original source choice and independently handles a %s",
      async (mode) => {
        const setup = await workspace();
        const data = (await cases()).restart;
        const revision = "f".repeat(40);
        const field = data.firstPassContradiction;
        const original = field.contradictions[0];
        const choice = createFirstPassChoice({
          sourceRunId: "saved-stop",
          sourceRunRecordSha256: sha256("saved record"),
          successorRunId: "next-run",
          repositoryPathSha256: canonicalDigest(setup.path),
          repositoryRevision: revision,
          instructionSha256: canonicalDigest(data.instruction),
          contradictionSha256: canonicalDigest(field),
          obligationId: original.obligationId,
          optionIndex: 0,
          optionSha256: canonicalDigest(field.question.options[0]),
          selection: "side",
          selectedAt: "2026-10-16T02:45:37.720Z",
        });
        if (mode === "new implementation conflict") {
          // An adjacent fresh claim must remain unresolved even if the old choice's
          // model-generated ID has disappeared. The original selected docs stay exact.
          setup.files[`${inputs.cliSourcePath}`] = setup.files[`${inputs.cliSourcePath}`]!.replace(
            "const args =",
            "const defaultPort = 8088; const configuredPort = 9090;\nconst args =",
          );
          await writeFile(
            join(setup.path, `${inputs.cliSourcePath}`),
            setup.files[`${inputs.cliSourcePath}`]!,
          );
        }
        if (mode === "changed selected source") {
          setup.files["docs/guide.md"] = setup.files["docs/guide.md"]!.replace(
            `{"message":"${inputs.exampleMessage}"}`,
            `{"message":"${inputs.changedExampleMessage}"}`,
          );
          await writeFile(join(setup.path, "docs/guide.md"), setup.files["docs/guide.md"]!);
        }
        const currentId =
          mode !== "new implementation conflict"
            ? data.freshObligation.id
            : "decomposed-new-port-conflict";
        const condition =
          mode !== "new implementation conflict"
            ? data.freshObligation.condition
            : "Implementation ports agree.";
        let lastIdentity: string | undefined;
        let lastBinding: string | undefined;
        const bridge: FirstPassSupportModelBridge = {
          call: async (call) => {
            let result: unknown;
            if (call.prompt.startsWith("Phase: obligation-decomposition"))
              result = {
                schemaVersion: 1,
                additionalObligations: [
                  {
                    id: currentId,
                    origin: mode !== "new implementation conflict" ? "explicit" : "inferred",
                    instructionQuote: mode !== "new implementation conflict" ? condition : null,
                    targetPaths: [`${inputs.continuationPage}`],
                    condition,
                    requiredSourceSupport: true,
                  },
                ],
              };
            else if (call.prompt.startsWith("Phase: obligation-completeness-audit"))
              result = { schemaVersion: 1, complete: true, omissions: [] };
            else {
              const seeds = JSON.parse(
                call.prompt
                  .split("\n")
                  .find((line) => line.startsWith("Mandatory obligations: "))!
                  .slice("Mandatory obligations: ".length),
              );
              const frames = parseEvidenceFrames(call.prompt) as {
                id: string;
                path: string;
                text: string;
              }[];
              const find = (path: string, value: string) => {
                const frame = frames.find((row) => row.path === path && row.text.includes(value));
                if (!frame) throw new Error(`Missing offered QA source ${path}: ${value}`);
                return frame.id;
              };
              result = {
                schemaVersion: 1,
                assessments: seeds.map((seed: any) => {
                  if (seed.id !== currentId)
                    return {
                      obligationId: seed.id,
                      status: "supported",
                      evidenceSpanIds: seed.requiredSourceSupport
                        ? [find(`${inputs.cliSourcePath}`, `${inputs.currentName}`)]
                        : [],
                      detail: "The implementation supplies the command evidence.",
                    };
                  const sides =
                    mode !== "new implementation conflict"
                      ? [
                          {
                            spanId: find(
                              `${inputs.cliSourcePath}`,
                              `let name = '${inputs.currentName}';`,
                            ),
                            value: `let name = '${inputs.currentName}';`,
                          },
                          {
                            spanId: find(
                              "docs/quickstart.md",
                              `The default name is \`${inputs.oldName}\``,
                            ),
                            value: `The default name is \`${inputs.oldName}\``,
                          },
                        ]
                      : [
                          { spanId: find(`${inputs.cliSourcePath}`, "9090"), value: "9090" },
                          { spanId: find(`${inputs.cliSourcePath}`, "8088"), value: "8088" },
                        ];
                  return {
                    obligationId: seed.id,
                    status: "contradicted",
                    evidenceSpanIds: [...new Set(sides.map((side) => side.spanId))],
                    sides,
                    detail: "The retained assessment reports different values.",
                  };
                }),
              };
            }
            const responseText = JSON.stringify(result);
            const identity = {
              providerId: "qa-regression",
              modelId: "recorded-assessment",
              profileSha256: sha256("profile"),
              compositionSha256: null,
              requestPolicySha256: null,
              systemPromptSha256: sha256(call.systemPrompt),
              promptSha256: call.promptSha256,
              procedureSha256: call.procedureSha256,
              responseSha256: sha256(responseText),
              turnEvidenceSha256: sha256("turn"),
            };
            lastIdentity = canonicalDigest(identity);
            if (!call.prompt.startsWith("Phase:"))
              lastBinding = firstPassAssessmentBindingSha256(
                call.prompt,
                responseText,
                parseEvidenceFrames,
              );
            return { responseText, identity, usage: { inputTokens: 20, outputTokens: 10 } };
          },
          lastAssessmentIdentitySha256: () => lastIdentity,
          lastAssessmentBindingSha256: () => lastBinding,
        };
        const config = {
          projectRoot: runtimeRoot,
          skillCrateDirectory: join(runtimeRoot, "skill-crate"),
          qualityDirectory: join(runtimeRoot, "quality"),
          qualityPackDirectory: join(runtimeRoot, "quality-pack"),
          stateDirectory: join(setup.root, "runs"),
          retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
          model: { provider: "none", model: "none" },
        } as unknown as DocsFabConfig;
        const result = await bindFirstPassKnowledge({
          request: {
            workflow: "create-documentation",
            repositoryPath: setup.path,
            revision,
            instruction: data.instruction,
            requestIntent: data.requestIntent,
            allowWrite: true,
            releaseGate: false,
            verbose: false,
            json: false,
            showScan: false,
          },
          config,
          workspacePath: setup.path,
          revision,
          firstPassChoices: [{ choice, source: field }],
          trackedSourceReader: {
            isTrackedRegularFile: async (path: string) => Object.hasOwn(setup.files, path),
            listTrackedRegularFiles: async () => Object.keys(setup.files),
            readTrackedBytes: async () => {
              throw new Error("First pass must read through its bounded acquisition path.");
            },
          },
          status: () => undefined,
          supportModelBridge: bridge,
        }).catch((error: unknown) => error);
        if (mode === "changed selected source") {
          expect(result).toBeInstanceOf(FirstPassChoiceContinuationError);
          expect(result).toMatchObject({ code: "stale" });
        } else if (mode === "renamed docs discrepancy") {
          expect(result).toMatchObject({ completed: true });
          expect(
            (result as { firstPassEvidenceWarnings: string[] }).firstPassEvidenceWarnings.join(
              "\n",
            ),
          ).toContain("operator-choice:");
        } else {
          expect(result, result instanceof Error ? result.message : undefined).toBeInstanceOf(
            FirstPassSupportValidationError,
          );
          expect(result).toMatchObject({
            code: "contradicted",
            contradictions: [expect.objectContaining({ obligationId: currentId })],
          });
        }
      },
    );
  });
}
