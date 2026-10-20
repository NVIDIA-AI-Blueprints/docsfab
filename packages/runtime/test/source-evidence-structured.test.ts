// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  extractStructuredSourceSet,
  jsonSourceExtractorAdapter,
  notebookSourceExtractorAdapter,
  STRUCTURED_SOURCE_EXTRACTOR_ADAPTERS,
  StructuredSourceError,
  textSourceExtractorAdapter,
  yamlSourceExtractorAdapter,
} from "../src/inputs/adapters/structured.js";
import {
  createSourceExtractorRegistry,
  createSourceSpanCitation,
  DEFAULT_SOURCE_EXTRACTION_LIMITS,
  extractSourceRepresentation,
  originalBudgetExceededError,
  SourceEvidenceServiceError,
  SourceExtractionError,
  verifySourceSpanCitations,
} from "../src/inputs/index.js";
import { resolveCliSourceEvidence } from "../src/cli/run/source-acquisition.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { createFixtureRepository, removeFixture } from "./support/execution-convergence.js";

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/source-evidence/structured/${name}`, import.meta.url)),
  );
const OPENAPI = fixture("openapi.json");
const COMPONENTS = fixture("components.json");
const OPENAPI_YAML = fixture("openapi.yaml");
const NOTEBOOK = fixture("example.ipynb");
const PRODUCTION_JSON = new Uint8Array(
  Buffer.from('{"paths":{"/pets":{"get":{"summary":"List pets"}}}}\n'),
);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const extractAdapter = (
  adapter: (typeof STRUCTURED_SOURCE_EXTRACTOR_ADAPTERS)[number],
  bytes: Uint8Array,
) =>
  adapter.extract({
    bytes,
    options: adapter.defaultOptions,
    limits: DEFAULT_SOURCE_EXTRACTION_LIMITS,
  });

async function expectStructuredCode(run: () => unknown, code: string): Promise<void> {
  try {
    await run();
    throw new Error("expected structured source rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredSourceError);
    expect((error as StructuredSourceError).code).toBe(code);
  }
}

describe("structured source adapters", () => {
  it("registers one fixed locator kind for every structured adapter", async () => {
    const registry = createSourceExtractorRegistry(STRUCTURED_SOURCE_EXTRACTOR_ADAPTERS);
    expect(registry.list().map(({ id, locatorKind }) => ({ id, locatorKind }))).toEqual([
      { id: "docsfab-text-bytes", locatorKind: "text" },
      { id: "docsfab-json-pointer", locatorKind: "json-pointer" },
      { id: "docsfab-yaml-pointer", locatorKind: "json-pointer" },
      { id: "docsfab-notebook-text", locatorKind: "notebook-cell" },
    ]);
  });

  it("maps exact UTF-8 text bytes without normalizing CRLF", async () => {
    const bytes = new Uint8Array(Buffer.from("alpha\r\nβeta\n", "utf8"));
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: textSourceExtractorAdapter,
      bytes,
      mediaType: "text/plain; charset=utf-8",
    });
    expect(Buffer.from(derivative).toString("utf8")).toBe("alpha\nβeta");
    expect(representation.spans.map((span) => span.locator)).toEqual([
      { kind: "text", startByte: 0, endByte: 5 },
      { kind: "text", startByte: 7, endByte: 12 },
    ]);
    for (const span of representation.spans) {
      const locator = span.locator;
      if (locator.kind !== "text") throw new Error("expected text locator");
      expect(Buffer.from(bytes.subarray(locator.startByte, locator.endByte)).toString("utf8")).toBe(
        Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8"),
      );
    }
  });

  it("accounts for a leading UTF-8 BOM before a multibyte text span", async () => {
    const bytes = new Uint8Array(Buffer.from("\uFEFFβeta\n", "utf8"));
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: textSourceExtractorAdapter,
      bytes,
      mediaType: "text/plain",
    });
    expect(Buffer.from(derivative).toString("utf8")).toBe("βeta");
    expect(representation.spans[0]!.locator).toEqual({
      kind: "text",
      startByte: 3,
      endByte: 8,
    });
    expect(Buffer.from(bytes.subarray(3, 8)).toString("utf8")).toBe("βeta");
  });

  it("reads tracked MDX through CLI admission and the bound reader as inert source text", async () => {
    const RUN_ID = "run-1919-mdx-admission";
    const sourceFixture = await createFixtureRepository("documented-html");
    const sourcePath = "docs/guide.mdx";
    const source = [
      'import MissingWidget from "__docsfab_module_must_not_resolve__";',
      "",
      "# Guide",
      "",
      "<MissingWidget>{globalThis.__docsfabMdxAdmissionSentinel = true}</MissingWidget>",
      "<script>globalThis.__docsfabMdxHtmlSentinel = true</script>",
      "",
    ].join("\n");
    await mkdir(join(sourceFixture.repository, "docs"), { recursive: true });
    await writeFile(join(sourceFixture.repository, sourcePath), source);
    await exec("git", ["add", sourcePath], { cwd: sourceFixture.repository });
    await exec("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "add MDX source"], {
      cwd: sourceFixture.repository,
    });
    const revision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: sourceFixture.repository })
    ).stdout.trim();
    const workspace = await prepareRepositoryWorkspace(sourceFixture.repository, revision);
    cleanups.push(async () => {
      await workspace.dispose();
      await removeFixture(sourceFixture.root);
    });
    const sentinel = "__docsfabMdxAdmissionSentinel";
    Object.defineProperty(globalThis, sentinel, { configurable: true, value: false });
    cleanups.push(async () => {
      delete (globalThis as Record<string, unknown>)[sentinel];
    });
    const request = {
      runId: RUN_ID,
      workflow: "create-documentation" as const,
      workspacePath: workspace.path,
      repository: {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      },
      allowWrite: true,
      instruction: "Read the MDX guide as source evidence.",
    };
    const sourceEvidence = await resolveCliSourceEvidence({
      workspace,
      sourcePaths: [sourcePath],
      admittedRequest: request,
      runId: RUN_ID,
      now: () => new Date("2026-10-15T12:00:00.000Z"),
    });
    const binding = sourceEvidence.acquired.binding;
    const entry = sourceEvidence.acquired.acquired[0]!;
    const observation = entry.observation;
    const representation = entry.representation;
    const bindContext = {
      runId: RUN_ID,
      requestSha256: binding.requestSha256,
      repository: binding.repository,
      workspaceIdentitySha256: sourceEvidence.runnerBinding.workspaceIdentitySha256,
      repositoryContentDigest: sourceEvidence.reference.repositoryContentDigest,
    };
    const reader = sourceEvidence.runnerBinding.service
      .bindRun(sourceEvidence.reference, bindContext)
      .forStep({
        stepId: "read-mdx-source",
        workflow: "create-documentation",
        readSource: true,
        remainingBudgetBytes: 4_096,
      })!;
    const read = reader.read({
      observationId: observation.observationId,
      representationId: representation.representationId,
      spanIds: representation.spans.map((span) => span.spanId),
    });

    expect(observation.original.mediaType).toBe("text/mdx");
    expect(observation.original.sha256).toBe(sha(source));
    expect(observation.original.byteLength).toBe(Buffer.byteLength(source));
    expect(read.text).toBe(
      source
        .trimEnd()
        .split("\n")
        .filter((line) => line.length > 0)
        .join("\n"),
    );
    expect(read.text).toContain('import MissingWidget from "__docsfab_module_must_not_resolve__";');
    expect(read.text).toContain("{globalThis.__docsfabMdxAdmissionSentinel = true}");
    expect(read.text).toContain("<script>globalThis.__docsfabMdxHtmlSentinel = true</script>");
    expect((globalThis as Record<string, unknown>)[sentinel]).toBe(false);
    expect(read.spanAccess.observationId).toBe(observation.observationId);
    expect(read.spanAccess.representationId).toBe(representation.representationId);
    expect(read.spanAccess.spanIds).toEqual(representation.spans.map((span) => span.spanId).sort());
  });

  it("emits RFC 6901 pointers for JSON and escapes source keys", async () => {
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: jsonSourceExtractorAdapter,
      bytes: OPENAPI,
      mediaType: "application/vnd.oai.openapi+json",
    });
    const summary = representation.spans.find(
      (span) =>
        span.locator.kind === "json-pointer" &&
        span.locator.pointer === "/paths/~1pets/get/summary",
    );
    expect(summary).toBeDefined();
    expect(
      Buffer.from(derivative.subarray(summary!.startByte, summary!.endByte)).toString("utf8"),
    ).toBe('"List pets"');
    expect(representation.completeness).toBe("complete");
  });

  it("retains nested __proto__ keys as source data", async () => {
    const bytes = new Uint8Array(
      Buffer.from('{"__proto__":{"statement":"retained","$ref":"components.json#/$defs/Pet"}}'),
    );
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: jsonSourceExtractorAdapter,
      bytes,
      mediaType: "application/json",
    });
    const statement = representation.spans.find(
      (span) =>
        span.locator.kind === "json-pointer" && span.locator.pointer === "/__proto__/statement",
    )!;
    expect(
      Buffer.from(derivative.subarray(statement.startByte, statement.endByte)).toString("utf8"),
    ).toBe('"retained"');
  });

  it("uses the same pointer contract for the strict YAML subset", async () => {
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: yamlSourceExtractorAdapter,
      bytes: OPENAPI_YAML,
      mediaType: "application/yaml",
    });
    const summary = representation.spans.find(
      (span) =>
        span.locator.kind === "json-pointer" &&
        span.locator.pointer === "/paths/~1pets/get/summary",
    );
    expect(summary).toBeDefined();
    expect(
      Buffer.from(derivative.subarray(summary!.startByte, summary!.endByte)).toString("utf8"),
    ).toBe('"List pets"');
  });

  it("binds notebook source and historical text output to cell identity and ordinal", async () => {
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: notebookSourceExtractorAdapter,
      bytes: NOTEBOOK,
      mediaType: "application/x-ipynb+json",
    });
    const source = representation.spans.find(
      (span) => span.locator.kind === "notebook-cell" && span.locator.part === "source",
    );
    const output = representation.spans.find(
      (span) => span.locator.kind === "notebook-cell" && span.locator.part === "output",
    );
    expect(source?.locator).toEqual({
      kind: "notebook-cell",
      cellId: "overview",
      cellOrdinal: 0,
      part: "source",
      outputOrdinal: null,
      startByte: 0,
      endByte: Buffer.byteLength("# Pet API\nThe client lists pets.", "utf8"),
    });
    const requestSource = representation.spans.find(
      (span) =>
        span.locator.kind === "notebook-cell" &&
        span.locator.part === "source" &&
        span.locator.cellId === "request",
    );
    expect(requestSource?.locator).toEqual({
      kind: "notebook-cell",
      cellId: "request",
      cellOrdinal: 1,
      part: "source",
      outputOrdinal: null,
      startByte: 0,
      endByte: Buffer.byteLength("response = list_pets()\nprint(response.status)", "utf8"),
    });
    expect(output?.locator).toEqual({
      kind: "notebook-cell",
      cellId: "request",
      cellOrdinal: 1,
      part: "output",
      outputOrdinal: 0,
      startByte: 0,
      endByte: 14,
    });
    expect(requestSource?.locator.cellOrdinal).toBe(output?.locator.cellOrdinal);
    expect(requestSource?.locator.cellId).toBe(output?.locator.cellId);
    expect(
      Buffer.from(derivative.subarray(output!.startByte, output!.endByte)).toString("utf8"),
    ).toBe("200 OK\n2 pets\n");
    expect(JSON.parse(Buffer.from(NOTEBOOK).toString("utf8")).cells[1].execution_count).toBe(7);
  });

  it("reports excluded non-text notebook output as an explicit gap", async () => {
    const notebook = new Uint8Array(
      Buffer.from(
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [
            {
              cell_type: "code",
              id: "plot",
              metadata: {},
              source: ["plot()"],
              outputs: [{ output_type: "display_data", data: { "image/png": "opaque-image" } }],
            },
          ],
        }),
      ),
    );
    const { representation } = await extractSourceRepresentation({
      adapter: notebookSourceExtractorAdapter,
      bytes: notebook,
      mediaType: "application/x-ipynb+json",
    });
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toEqual(["non-text-content-excluded"]);
  });

  it("flags dropped non-text siblings and markdown attachments as a limitation", async () => {
    const mixed = new Uint8Array(
      Buffer.from(
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [
            {
              cell_type: "markdown",
              id: "figure",
              metadata: {},
              source: ["![plot](attachment:plot.png)"],
              attachments: { "plot.png": { "image/png": "opaque-image" } },
            },
            {
              cell_type: "code",
              id: "plot",
              metadata: {},
              source: ["plot()"],
              outputs: [
                {
                  output_type: "display_data",
                  data: { "text/plain": "<Figure>", "image/png": "opaque-image" },
                },
              ],
            },
          ],
        }),
      ),
    );
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: notebookSourceExtractorAdapter,
      bytes: mixed,
      mediaType: "application/x-ipynb+json",
    });
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toEqual(["non-text-content-excluded"]);
    expect(Buffer.from(derivative).toString("utf8")).toContain("<Figure>");
  });

  it("rejects duplicate JSON and YAML keys, YAML tags, aliases, and duplicate cell ids", async () => {
    await expectStructuredCode(
      () =>
        extractAdapter(
          jsonSourceExtractorAdapter,
          new Uint8Array(Buffer.from('{"value":1,"value":2}')),
        ),
      "duplicate-key",
    );
    await expectStructuredCode(
      () =>
        extractAdapter(
          yamlSourceExtractorAdapter,
          new Uint8Array(Buffer.from("value: 1\nvalue: 2\n")),
        ),
      "duplicate-key",
    );
    await expectStructuredCode(
      () =>
        extractAdapter(
          yamlSourceExtractorAdapter,
          new Uint8Array(Buffer.from("value: !include private.yaml\n")),
        ),
      "unsupported-yaml-tag",
    );
    await expectStructuredCode(
      () =>
        extractAdapter(
          yamlSourceExtractorAdapter,
          new Uint8Array(Buffer.from("first: &shared value\nsecond: *shared\n")),
        ),
      "unsupported-yaml-alias",
    );
    await expectStructuredCode(
      () =>
        extractAdapter(
          yamlSourceExtractorAdapter,
          new Uint8Array(Buffer.from('1: first\n"1": second\n')),
        ),
      "unsupported-yaml-key",
    );
    await expectStructuredCode(
      () =>
        extractAdapter(
          yamlSourceExtractorAdapter,
          new Uint8Array(Buffer.from("merged:\n  <<: { value: 1 }\n")),
        ),
      "unsupported-yaml-key",
    );
    const notebook = JSON.parse(Buffer.from(NOTEBOOK).toString("utf8"));
    notebook.cells[1].id = notebook.cells[0].id;
    await expectStructuredCode(
      () =>
        extractAdapter(
          notebookSourceExtractorAdapter,
          new Uint8Array(Buffer.from(JSON.stringify(notebook))),
        ),
      "duplicate-notebook-cell-id",
    );
  });

  it("rejects integers that cannot retain their exact semantic value", async () => {
    for (const [adapter, bytes] of [
      [jsonSourceExtractorAdapter, '{"value":9007199254740993}'],
      [yamlSourceExtractorAdapter, "value: 9007199254740993\n"],
    ] as const) {
      await expectStructuredCode(
        () => extractAdapter(adapter, new Uint8Array(Buffer.from(bytes))),
        "unsafe-number",
      );
    }
  });

  it("emits original JSON and YAML number tokens instead of normalized values", async () => {
    const cases = [
      [jsonSourceExtractorAdapter, '{"value":1e2}', "application/json", "1e2"],
      [jsonSourceExtractorAdapter, '{"value":-0}', "application/json", "-0"],
      [
        jsonSourceExtractorAdapter,
        '{"value":1.0000000000000001}',
        "application/json",
        "1.0000000000000001",
      ],
      [yamlSourceExtractorAdapter, "value: 1e2\n", "application/yaml", "1e2"],
      [yamlSourceExtractorAdapter, "value: -0\n", "application/yaml", "-0"],
    ] as const;
    for (const [adapter, source, mediaType, token] of cases) {
      const { representation, derivative } = await extractSourceRepresentation({
        adapter,
        bytes: new Uint8Array(Buffer.from(source)),
        mediaType,
      });
      const span = representation.spans.find(
        (entry) => entry.locator.kind === "json-pointer" && entry.locator.pointer === "/value",
      );
      expect(span).toBeDefined();
      expect(
        Buffer.from(derivative.subarray(span!.startByte, span!.endByte)).toString("utf8"),
      ).toBe(token);
    }
  });

  it("refuses deep JSON nesting as malformed-source instead of leaking RangeError", async () => {
    const nested = `${"[".repeat(80)}${"]".repeat(80)}`;
    await expectStructuredCode(
      () => extractAdapter(jsonSourceExtractorAdapter, new Uint8Array(Buffer.from(nested))),
      "malformed-source",
    );
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["deep.json"],
          sources: [
            {
              path: "deep.json",
              mediaType: "application/json",
              bytes: new Uint8Array(Buffer.from(nested)),
            },
          ],
        }),
      "malformed-source",
    );
  });

  it("detects duplicate JSON keys in linear time without a second YAML JSON parse", async () => {
    const unique = Array.from({ length: 4_096 }, (_, index) => `"k${index}":${index}`).join(",");
    const duplicate = `{${unique},"k0":-1}`;
    const started = Date.now();
    await expectStructuredCode(
      () => extractAdapter(jsonSourceExtractorAdapter, new Uint8Array(Buffer.from(duplicate))),
      "duplicate-key",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("enforces media and original-byte budgets before producing evidence", async () => {
    await expect(
      extractSourceRepresentation({
        adapter: jsonSourceExtractorAdapter,
        bytes: OPENAPI,
        mediaType: "text/plain",
      }),
    ).rejects.toThrowError(new SourceExtractionError("unsupported-media-type"));
    await expect(
      extractSourceRepresentation({
        adapter: jsonSourceExtractorAdapter,
        bytes: OPENAPI,
        mediaType: "application/json",
        limits: { maxOriginalBytes: OPENAPI.byteLength - 1 },
      }),
    ).rejects.toThrowError(originalBudgetExceededError(OPENAPI.byteLength, OPENAPI.byteLength - 1));
  });
});

describe("bounded local reference closure", () => {
  const source = (path: string, bytes: Uint8Array, mediaType = "application/json") => ({
    path,
    bytes,
    mediaType,
  });

  it("follows only supplied local files and keeps one digest-bound representation per original", async () => {
    const result = await extractStructuredSourceSet({
      entryPaths: ["api/openapi.json"],
      sources: [
        source("api/openapi.json", OPENAPI),
        source("api/components.json", COMPONENTS, "application/schema+json"),
        source("unused.json", new Uint8Array(Buffer.from('{"unused":true}'))),
      ],
    });
    expect(result.sources.map((entry) => entry.path)).toEqual([
      "api/openapi.json",
      "api/components.json",
    ]);
    expect(result.references).toEqual([
      {
        fromPath: "api/openapi.json",
        reference: "components.json#/$defs/Pet",
        toPath: "api/components.json",
        pointer: "/$defs/Pet",
      },
    ]);
    expect(result.sources[0]!.originalSha256).toBe(sha(OPENAPI));
    expect(result.sources[1]!.originalSha256).toBe(sha(COMPONENTS));
  });

  it("keeps unreferenced malformed sources inert", async () => {
    const result = await extractStructuredSourceSet({
      entryPaths: ["entry.json"],
      sources: [
        source("entry.json", new Uint8Array(Buffer.from('{"value":"kept"}'))),
        source("unused.json", new Uint8Array(Buffer.from("{"))),
      ],
    });
    expect(result.sources.map((entry) => entry.path)).toEqual(["entry.json"]);
  });

  it("applies the frozen structured-source and entry limits through E1", async () => {
    const largeText = new Uint8Array(Buffer.from("x\n".repeat((5 * 1024 * 1024) / 2)));
    const result = await extractStructuredSourceSet({
      entryPaths: ["large.txt"],
      sources: [source("large.txt", largeText, "text/plain")],
    });
    expect(result.sources[0]!.originalSha256).toBe(sha(largeText));
    expect(result.sources[0]!.representation.limitations).toContain("span-budget-truncated");

    const oversizedText = new Uint8Array(20 * 1024 * 1024 + 1);
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["large.txt"],
          sources: [source("large.txt", oversizedText, "text/plain")],
        }),
      "source-budget-exceeded",
    );
    const sixteenMiB = new Uint8Array(Buffer.from("x\n".repeat(8 * 1024 * 1024)));
    await expect(
      extractStructuredSourceSet({
        entryPaths: ["part-0.txt"],
        sources: Array.from({ length: 4 }, (_, index) =>
          source(`part-${index}.txt`, sixteenMiB, "text/plain"),
        ),
      }),
    ).resolves.toBeDefined();
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: Array.from({ length: 65 }, (_, index) => `entry-${index}.json`),
          sources: [source("entry-0.json", new Uint8Array(Buffer.from("{}")))],
        }),
      "source-budget-exceeded",
    );
  });

  it("follows a local reference stored below a __proto__ source key", async () => {
    const result = await extractStructuredSourceSet({
      entryPaths: ["api/openapi.json"],
      sources: [
        source(
          "api/openapi.json",
          new Uint8Array(Buffer.from('{"__proto__":{"$ref":"components.json#/$defs/Pet"}}')),
        ),
        source("api/components.json", COMPONENTS),
      ],
    });
    expect(result.references).toEqual([
      {
        fromPath: "api/openapi.json",
        reference: "components.json#/$defs/Pet",
        toPath: "api/components.json",
        pointer: "/$defs/Pet",
      },
    ]);
  });

  it("follows acyclic internal and cross-file reference subtrees", async () => {
    const internal = await extractStructuredSourceSet({
      entryPaths: ["schema.json"],
      sources: [
        source(
          "schema.json",
          new Uint8Array(
            Buffer.from(
              '{"properties":{"pet":{"$ref":"#/$defs/Pet"}},"$defs":{"Pet":{"type":"string"}}}',
            ),
          ),
        ),
      ],
    });
    expect(internal.sources.map((entry) => entry.path)).toEqual(["schema.json"]);
    expect(internal.references).toEqual([
      {
        fromPath: "schema.json",
        reference: "#/$defs/Pet",
        toPath: "schema.json",
        pointer: "/$defs/Pet",
      },
    ]);

    const crossFile = await extractStructuredSourceSet({
      entryPaths: ["api/schema.json"],
      sources: [
        source(
          "api/schema.json",
          new Uint8Array(Buffer.from('{"$ref":"definitions.json#/$defs/Pet"}')),
        ),
        source(
          "api/definitions.json",
          new Uint8Array(Buffer.from('{"$defs":{"Pet":{"$ref":"types.json#/$defs/Name"}}}')),
        ),
        source(
          "api/types.json",
          new Uint8Array(Buffer.from('{"$defs":{"Name":{"type":"string"}}}')),
        ),
      ],
    });
    expect(crossFile.sources.map((entry) => entry.path)).toEqual([
      "api/schema.json",
      "api/definitions.json",
      "api/types.json",
    ]);
  });

  it("rejects actual internal reference cycles", async () => {
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["schema.json"],
          sources: [
            source(
              "schema.json",
              new Uint8Array(
                Buffer.from(
                  '{"$ref":"#/$defs/A","$defs":{"A":{"$ref":"#/$defs/B"},"B":{"$ref":"#/$defs/A"}}}',
                ),
              ),
            ),
          ],
        }),
      "cyclic-reference",
    );
  });

  it("rejects missing, remote, cyclic, and escaping references", async () => {
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["openapi.json"],
          sources: [source("openapi.json", OPENAPI)],
        }),
      "missing-reference",
    );
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["openapi.json"],
          sources: [
            source(
              "openapi.json",
              new Uint8Array(Buffer.from('{"$ref":"components.json#/missing"}')),
            ),
            source("components.json", COMPONENTS),
          ],
        }),
      "missing-reference",
    );
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["openapi.json"],
          sources: [
            source(
              "openapi.json",
              new Uint8Array(Buffer.from('{"$ref":"https://example.com/schema.json"}')),
            ),
          ],
        }),
      "remote-reference",
    );
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["a.json"],
          sources: [
            source("a.json", new Uint8Array(Buffer.from('{"$ref":"b.json"}'))),
            source("b.json", new Uint8Array(Buffer.from('{"$ref":"a.json"}'))),
          ],
        }),
      "cyclic-reference",
    );
    await expectStructuredCode(
      () =>
        extractStructuredSourceSet({
          entryPaths: ["api/openapi.json"],
          sources: [
            source(
              "api/openapi.json",
              new Uint8Array(Buffer.from('{"$ref":"../../private.json"}')),
            ),
          ],
        }),
      "invalid-source-path",
    );
  });
});

describe("registered workflow source read and citation", () => {
  it("acquires a structured span through E1 and verifies its host-side final citation", async () => {
    const RUN_ID = "run-836-structured";
    const sourceFixture = await createFixtureRepository("documented-html");
    const sourcePath = "api/openapi.json";
    await mkdir(join(sourceFixture.repository, "api"), { recursive: true });
    await writeFile(join(sourceFixture.repository, sourcePath), PRODUCTION_JSON);
    await exec("git", ["add", sourcePath], { cwd: sourceFixture.repository });
    await exec("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "add structured source"], {
      cwd: sourceFixture.repository,
    });
    const revision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: sourceFixture.repository })
    ).stdout.trim();
    const workspace = await prepareRepositoryWorkspace(sourceFixture.repository, revision);
    cleanups.push(async () => {
      await workspace.dispose();
      await removeFixture(sourceFixture.root);
    });
    const request = {
      runId: RUN_ID,
      workflow: "create-documentation" as const,
      workspacePath: workspace.path,
      repository: {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      },
      allowWrite: true,
      instruction: "Create a Pet API guide.",
    };
    const sourceEvidence = await resolveCliSourceEvidence({
      workspace,
      sourcePaths: [sourcePath],
      admittedRequest: request,
      runId: RUN_ID,
      now: () => new Date("2026-09-14T18:00:00.000Z"),
    });
    const binding = sourceEvidence.acquired.binding;
    const observation = sourceEvidence.acquired.acquired[0]!.observation;
    const representation = sourceEvidence.acquired.acquired[0]!.representation;
    const selected = representation.spans.find(
      (span) =>
        span.locator.kind === "json-pointer" &&
        span.locator.pointer === "/paths/~1pets/get/summary",
    )!;
    expect(selected).toBeDefined();
    expect(observation.original.sha256).toBe(sha(PRODUCTION_JSON));
    const bindContext = {
      runId: RUN_ID,
      requestSha256: binding.requestSha256,
      repository: binding.repository,
      workspaceIdentitySha256: sourceEvidence.runnerBinding.workspaceIdentitySha256,
      repositoryContentDigest: sourceEvidence.reference.repositoryContentDigest,
    };
    const capability = sourceEvidence.runnerBinding.service.bindRun(
      sourceEvidence.reference,
      bindContext,
    );
    const reader = capability.forStep({
      stepId: "verify-technical-accuracy",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: 4_096,
    })!;
    const read = reader.read({
      observationId: observation.observationId,
      representationId: representation.representationId,
      spanIds: [selected.spanId],
    });
    expect(read.text).toBe('"List pets"');
    const claimSha256 = sha("The Pet API defines a list operation.");
    const citation = createSourceSpanCitation({
      bindingSha256: binding.bindingSha256,
      observationId: observation.observationId,
      representationId: representation.representationId,
      representationSha256: representation.representationSha256,
      stepId: "verify-technical-accuracy",
      spanIds: [selected.spanId],
      spanAccessSha256s: [read.spanAccess.spanAccessSha256],
      supportedClaimSha256: claimSha256,
      externalInputCitationSha256: sha("external-citation-openapi"),
    });
    expect(
      verifySourceSpanCitations({
        binding,
        observations: [observation],
        spanAccesses: [read.spanAccess],
        spanCitations: [citation],
        materialClaimSha256s: [claimSha256],
      }),
    ).toEqual([]);

    const derivative = sourceEvidence.acquired.acquired[0]!.derivative;
    const firstByte = derivative[0]!;
    derivative[0] = firstByte ^ 0xff;
    try {
      expect(() => {
        const substitutedCapability = sourceEvidence.runnerBinding.service.bindRun(
          sourceEvidence.reference,
          bindContext,
        );
        const substitutedReader = substitutedCapability.forStep({
          stepId: "verify-technical-accuracy",
          workflow: "create-documentation",
          readSource: true,
          remainingBudgetBytes: 4_096,
        })!;
        substitutedReader.read({
          observationId: observation.observationId,
          representationId: representation.representationId,
          spanIds: [selected.spanId],
        });
      }).toThrowError(SourceExtractionError);
    } finally {
      derivative[0] = firstByte;
    }

    const budgetCapability = sourceEvidence.runnerBinding.service.bindRun(
      sourceEvidence.reference,
      bindContext,
    );
    const budgetReader = budgetCapability.forStep({
      stepId: "verify-technical-accuracy",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: 1,
    })!;
    expect(() =>
      budgetReader.read({
        observationId: observation.observationId,
        representationId: representation.representationId,
        spanIds: [selected.spanId],
      }),
    ).toThrowError(
      expect.objectContaining({ name: "SourceEvidenceServiceError", code: "budget-exhausted" }),
    );

    expect(() =>
      sourceEvidence.runnerBinding.service.bindRun(sourceEvidence.reference, {
        runId: RUN_ID,
        requestSha256: binding.requestSha256,
        repository: { identitySha256: sha("wrong-source"), revision: binding.repository.revision },
        workspaceIdentitySha256: sourceEvidence.runnerBinding.workspaceIdentitySha256,
        repositoryContentDigest: sourceEvidence.reference.repositoryContentDigest,
      }),
    ).toThrowError(new SourceEvidenceServiceError("repository-mismatch"));
  });
});
