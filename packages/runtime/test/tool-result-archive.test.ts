// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolveLimitsOptions } from "../src/config/limits.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  collectRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import type { RunRecord } from "../src/records/contracts.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { PiHarness, readTextRenderingForStep } from "../src/harness/pi.js";
import { createModelConnection } from "../src/model/provider.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { inspectHostedWorkflowCatalog } from "../src/host-invoker/workflow-catalog.js";
import {
  grantedTools,
  normalizeObservedToolName,
  QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
  READ_ONLY_TOOLS,
} from "../src/harness/pi-tool-confine.js";
import {
  capToolOutputText,
  createToolResultRecallTool,
  resolveToolResultArchiveLimits,
  TOOL_RESULT_ARCHIVE_CEILING_LIMIT,
  TOOL_RESULT_RECALL_TOOL_NAME,
  ToolResultArchive,
  toolOutputCapMarker,
  toolOutputTail,
  withToolOutputCap,
} from "../src/harness/tool-output-cap.js";
import { CredentialBoundaryError } from "../src/security/credential-isolation.js";
import { temporaryRoots } from "./helpers/temp.js";

// Synthetic, never-real token shape, matching the C-04 intercept fixtures.
const GITLAB_TOKEN = `glpat-${"a".repeat(24)}`;
const BOUNDARY_MESSAGE =
  "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.";
const MARKER_PREFIX = "[docsfab-output-cap ";

const temporaryDirectories = temporaryRoots();

afterEach(async () => {
  vi.unstubAllGlobals();
});

/** Limits resolved only from the given overrides, never from host files. */
function limitsWith(overrides: Record<string, string> = {}): ResolveLimitsOptions {
  return { environment: { ...overrides }, hostFile: null, projectFile: null };
}

async function workspaceFixture(files: Record<string, string>) {
  const root = await temporaryDirectories.create("docsfab-tool-result-archive-");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "docs"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await writeFile(join(workspace, path), text, "utf8");
  }
  return workspace;
}

type AnyTool = Parameters<typeof withToolOutputCap>[0];

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

function detailsOf(result: unknown): Record<string, unknown> {
  const details = (result as { details?: unknown }).details;
  return (details ?? {}) as Record<string, unknown>;
}

function stubTool(name: string, text: string): AnyTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object" as const },
    execute: async () => ({ content: [{ type: "text", text }], details: undefined }),
  } as unknown as AnyTool;
}

async function call(tool: AnyTool, parameters: Record<string, unknown>): Promise<unknown> {
  return tool.execute("call", parameters, undefined, undefined, undefined as never);
}

function toolsByName(definitions: readonly AnyTool[]): Map<string, AnyTool> {
  return new Map(definitions.map((tool) => [tool.name, tool]));
}

function splitProjection(payload: string): { head: string; marker: string; tail: string } {
  let markerStart = 0;
  if (!payload.startsWith(MARKER_PREFIX)) {
    const index = payload.indexOf(`\n${MARKER_PREFIX}`);
    if (index < 0) return { head: payload, marker: "", tail: "" };
    markerStart = index + 1;
  }
  const head = markerStart === 0 ? "" : payload.slice(0, markerStart - 1);
  const rest = payload.slice(markerStart);
  const newline = rest.indexOf("\n");
  return newline < 0
    ? { head, marker: rest, tail: "" }
    : { head, marker: rest.slice(0, newline), tail: rest.slice(newline + 1) };
}

function archiveNamed(marker: string): { handle: string; sha256: string } {
  const match = /handle=(docsfab-tr-[0-9a-f]{16}) \(sha256 ([0-9a-f]{64})\)/u.exec(marker);
  expect(match, marker).not.toBeNull();
  return { handle: match![1]!, sha256: match![2]! };
}

function splitRecall(payload: string): { text: string; notice: string } {
  const index = payload.lastIndexOf("\n[docsfab-recall ");
  expect(index, payload).toBeGreaterThanOrEqual(0);
  return { text: payload.slice(0, index), notice: payload.slice(index + 1) };
}

function sha256Of(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const numberedLines = (count: number, width: number) =>
  Array.from(
    { length: count },
    (_item, index) => `L${String(index + 1).padStart(4, "0")}${"-".repeat(width)}`,
  ).join("\n");

describe("tool-result archive on the confined tool set (#1043)", () => {
  it("keeps an over-cap read whole and shows the head, tail, digest, handle, and marker", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(200, 40)}\n` });
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits: limitsWith(),
    });
    const result = await call(toolsByName(toolSet.definitions).get("read")!, {
      path: "docs/big.md",
    });
    // The exact original is the same read through a tool set whose cap never binds.
    const uncapped = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1_000_000,
      toolResultRecall: true,
      limits: limitsWith(),
    });
    const original = textOf(
      await call(toolsByName(uncapped.definitions).get("read")!, { path: "docs/big.md" }),
    );
    expect(uncapped.getToolResultArchive()!.receipts).toEqual([]);

    const { head, marker, tail } = splitProjection(textOf(result));
    expect(original.startsWith(head)).toBe(true);
    expect(tail.length).toBeGreaterThan(0);
    expect(original.endsWith(tail)).toBe(true);
    expect(Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(
      1024,
    );
    const headBytes = Buffer.byteLength(head, "utf8");
    const totalBytes = Buffer.byteLength(original, "utf8");
    const tailStart = totalBytes - Buffer.byteLength(tail, "utf8") + 1;
    expect(marker).toContain(
      `[docsfab-output-cap read: returned bytes 1-${headBytes} and ${tailStart}-${totalBytes} of ${totalBytes} (cap 1024 bytes). Continue with offset=`,
    );
    const { handle, sha256 } = archiveNamed(marker);
    expect(sha256).toBe(sha256Of(original));
    expect(marker).toContain(
      `call ${TOOL_RESULT_RECALL_TOOL_NAME} with that handle and byteOffset=${headBytes} for the omitted bytes ${headBytes + 1}-${tailStart - 1}`,
    );
    expect(marker).toContain(`The tail (bytes ${tailStart}-${totalBytes}) follows this notice.]`);

    const receipt = {
      schemaVersion: 1,
      kind: "docsfab-tool-result-archive",
      handle,
      sha256,
      toolName: "read",
      totalBytes,
    };
    expect(detailsOf(result).docsfabToolResultArchive).toEqual(receipt);
    expect(toolSet.getToolResultArchive()).toEqual({
      receipts: [receipt],
      storedBytes: totalBytes,
      ceilingBytes: resolveToolResultArchiveLimits(limitsWith()).ceiling.value,
      refusals: [],
    });
  });

  it("recalls exact byte ranges from the archive without reading the workspace again", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(300, 40)}\n` });
    const limits = limitsWith({ DOCSFAB_TOOL_OUTPUT_RECALL_PAGE_BYTES: "2000" });
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits,
    });
    const uncapped = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1_000_000,
      toolResultRecall: true,
      limits,
    });
    const original = textOf(
      await call(toolsByName(uncapped.definitions).get("read")!, { path: "docs/big.md" }),
    );
    const originalBytes = Buffer.from(original, "utf8");
    const tools = toolsByName(toolSet.definitions);
    const { head, marker } = splitProjection(
      textOf(await call(tools.get("read")!, { path: "docs/big.md" })),
    );
    const { handle, sha256 } = archiveNamed(marker);

    // Remove the file. A recall that re-read the workspace would now fail the
    // same way this second read does.
    await rm(join(workspace, "docs", "big.md"));
    await expect(call(tools.get("read")!, { path: "docs/big.md" })).rejects.toThrow(
      "DocsFab tool target is unavailable.",
    );

    const recall = tools.get(TOOL_RESULT_RECALL_TOOL_NAME)!;
    const headBytes = Buffer.byteLength(head, "utf8");
    const first = await call(recall, { handle, byteOffset: headBytes, byteLength: 700 });
    const { text, notice } = splitRecall(textOf(first));
    expect(
      Buffer.from(text, "utf8").equals(originalBytes.subarray(headBytes, headBytes + 700)),
    ).toBe(true);
    expect(notice).toBe(
      `[docsfab-recall ${handle}: returned bytes ${headBytes + 1}-${headBytes + 700} of ` +
        `${originalBytes.byteLength} (sha256 ${sha256}). Continue with byteOffset=${headBytes + 700}.]`,
    );
    expect(detailsOf(first).docsfabToolResultRecall).toEqual({
      schemaVersion: 1,
      kind: "docsfab-tool-result-recall",
      handle,
      sha256,
      byteOffset: headBytes,
      byteEnd: headBytes + 700,
      totalBytes: originalBytes.byteLength,
    });

    // Default-length pages rebuild the original byte for byte.
    const pages: Buffer[] = [];
    let offset = 0;
    for (let page = 0; page < 50 && offset < originalBytes.byteLength; page += 1) {
      const recalled = splitRecall(textOf(await call(recall, { handle, byteOffset: offset })));
      const bytes = Buffer.from(recalled.text, "utf8");
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(bytes.byteLength).toBeLessThanOrEqual(2000);
      pages.push(bytes);
      offset += bytes.byteLength;
      if (offset === originalBytes.byteLength) {
        expect(recalled.notice).toContain("End of the archived result.]");
      }
    }
    expect(Buffer.concat(pages).equals(originalBytes)).toBe(true);

    // The only recorded failure is the second read; every recall succeeded.
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "expected-missing-probe", count: 1 },
    ]);
  });

  it("shares one entry between identical results", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(100, 40)}\n` });
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits: limitsWith(),
    });
    const read = toolsByName(toolSet.definitions).get("read")!;
    const first = await call(read, { path: "docs/big.md" });
    const second = await call(read, { path: "docs/big.md" });
    expect(detailsOf(second).docsfabToolResultArchive).toEqual(
      detailsOf(first).docsfabToolResultArchive,
    );
    const snapshot = toolSet.getToolResultArchive()!;
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.storedBytes).toBe(snapshot.receipts[0]!.totalBytes);
  });

  it("scopes every archive to the tool set that filled it", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(100, 40)}\n` });
    const options = {
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits: limitsWith(),
    };
    const filled = await createConfinedToolSet(options);
    const other = await createConfinedToolSet(options);
    const { marker } = splitProjection(
      textOf(await call(toolsByName(filled.definitions).get("read")!, { path: "docs/big.md" })),
    );
    const { handle } = archiveNamed(marker);
    await expect(
      call(toolsByName(other.definitions).get(TOOL_RESULT_RECALL_TOOL_NAME)!, { handle }),
    ).rejects.toThrow("DocsFab has no archived tool result with that handle in this step.");
    await expect(
      call(toolsByName(filled.definitions).get(TOOL_RESULT_RECALL_TOOL_NAME)!, { handle }),
    ).resolves.toBeDefined();
  });
});

describe("configured-credential tool text", () => {
  it("fails closed and archives none of it", async () => {
    configureCredential(GITLAB_TOKEN);
    const workspace = await workspaceFixture({
      "docs/secret.md": `${numberedLines(100, 40)}\ntoken line ${GITLAB_TOKEN}\n`,
    });
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits: limitsWith(),
    });
    let failure: unknown;
    try {
      await call(toolsByName(toolSet.definitions).get("read")!, { path: "docs/secret.md" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(BOUNDARY_MESSAGE);
    expect(String(failure)).not.toContain(GITLAB_TOKEN);
    expect(toolSet.getToolResultArchive()).toMatchObject({ receipts: [], storedBytes: 0 });

    // The quality tool is capped too but never passes a path wrapper, so the
    // archive itself refuses the credential-shaped original.
    const qualitySet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits: limitsWith(),
      qualityCandidateValidationTool: stubTool(
        QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
        `${"x".repeat(2000)}\n${GITLAB_TOKEN}\n`,
      ),
    });
    await expect(
      call(toolsByName(qualitySet.definitions).get(QUALITY_CANDIDATE_VALIDATION_TOOL_NAME)!, {}),
    ).rejects.toThrow(BOUNDARY_MESSAGE);
    expect(qualitySet.getToolResultArchive()).toMatchObject({ receipts: [], storedBytes: 0 });

    const archive = new ToolResultArchive(resolveToolResultArchiveLimits(limitsWith()));
    expect(() => archive.archive("read", `x ${GITLAB_TOKEN}`)).toThrow(CredentialBoundaryError);
    expect(archive.snapshot()).toMatchObject({ receipts: [], storedBytes: 0 });
  });
});

describe("archive ceiling", () => {
  const REMEDIATION =
    "Narrow the tool request (offset and limit, path, pattern, or glob) so its result fits the " +
    "per-call cap, or raise toolOutput.archiveCeilingBytes in config/limits/toolOutput.yaml. Follow the named remediation.";

  it("accepts a result that lands exactly on the ceiling and refuses one byte past it by name", () => {
    const first = "a".repeat(600);
    const second = "b".repeat(400);

    const atCeiling = new ToolResultArchive(
      resolveToolResultArchiveLimits(
        limitsWith({ DOCSFAB_TOOL_OUTPUT_ARCHIVE_CEILING_BYTES: "1000" }),
      ),
    );
    expect("receipt" in atCeiling.archive("read", first)).toBe(true);
    expect("receipt" in atCeiling.archive("grep", second)).toBe(true);
    expect(atCeiling.snapshot()).toMatchObject({
      storedBytes: 1000,
      ceilingBytes: 1000,
      refusals: [],
    });

    const onePast = new ToolResultArchive(
      resolveToolResultArchiveLimits(
        limitsWith({ DOCSFAB_TOOL_OUTPUT_ARCHIVE_CEILING_BYTES: "999" }),
      ),
    );
    const kept = onePast.archive("read", first);
    expect("receipt" in kept).toBe(true);
    expect(onePast.archive("grep", second)).toEqual({
      refusal:
        "tool-output-archive-ceiling-bytes-bound: 1000 exceeds toolOutput.archiveCeilingBytes = 999 bytes. " +
        REMEDIATION,
    });
    expect(onePast.snapshot()).toMatchObject({
      storedBytes: 600,
      ceilingBytes: 999,
      refusals: [{ limitName: TOOL_RESULT_ARCHIVE_CEILING_LIMIT, observedBytes: 1000 }],
    });
    // Nothing was evicted to make room: the first original is still whole.
    const handle = (kept as { receipt: { handle: string } }).receipt.handle;
    expect(onePast.recall({ handle }).text).toBe(first);
    // An identical result shares its entry, so it costs nothing at the ceiling.
    expect(onePast.archive("read", first)).toEqual(kept);
  });

  it("carries the coded refusal to the model and keeps earlier handles recallable", async () => {
    const workspace = await workspaceFixture({
      "docs/one.md": `${numberedLines(60, 40)}\n`,
      "docs/two.md": `${numberedLines(61, 40)}\n`,
    });
    const uncapped = toolsByName(
      (
        await createConfinedToolSet({
          workspacePath: workspace,
          allowWrite: false,
          toolOutputCapBytes: 1_000_000,
          toolResultRecall: true,
          limits: limitsWith(),
        })
      ).definitions,
    ).get("read")!;
    const one = textOf(await call(uncapped, { path: "docs/one.md" }));
    const two = textOf(await call(uncapped, { path: "docs/two.md" }));
    const total = Buffer.byteLength(one, "utf8") + Buffer.byteLength(two, "utf8");

    for (const [ceiling, archivesBoth] of [
      [total, true],
      [total - 1, false],
    ] as const) {
      const toolSet = await createConfinedToolSet({
        workspacePath: workspace,
        allowWrite: false,
        toolOutputCapBytes: 1024,
        toolResultRecall: true,
        limits: limitsWith({ DOCSFAB_TOOL_OUTPUT_ARCHIVE_CEILING_BYTES: String(ceiling) }),
      });
      const tools = toolsByName(toolSet.definitions);
      const first = splitProjection(
        textOf(await call(tools.get("read")!, { path: "docs/one.md" })),
      );
      const secondResult = await call(tools.get("read")!, { path: "docs/two.md" });
      const second = splitProjection(textOf(secondResult));
      const { handle } = archiveNamed(first.marker);
      if (archivesBoth) {
        archiveNamed(second.marker);
        expect(toolSet.getToolResultArchive()).toMatchObject({ storedBytes: total, refusals: [] });
      } else {
        expect(second.marker).not.toContain("handle=");
        expect(second.marker).toContain(
          `The full result was not archived: tool-output-archive-ceiling-bytes-bound: ${total} ` +
            `exceeds toolOutput.archiveCeilingBytes = ${total - 1} bytes. ${REMEDIATION}]`,
        );
        // Without an archived original there is no tail: the head keeps the cap.
        expect(second.tail).toBe("");
        expect(Buffer.byteLength(second.head, "utf8")).toBeLessThanOrEqual(1024);
        expect(two.startsWith(second.head)).toBe(true);
        expect(detailsOf(secondResult).docsfabToolResultArchive).toBeUndefined();
        expect(toolSet.getToolResultArchive()).toMatchObject({
          storedBytes: Buffer.byteLength(one, "utf8"),
          refusals: [{ limitName: TOOL_RESULT_ARCHIVE_CEILING_LIMIT, observedBytes: total }],
        });
      }
      // The earlier original is never evicted.
      const recalled = splitRecall(
        textOf(await call(tools.get(TOOL_RESULT_RECALL_TOOL_NAME)!, { handle })),
      );
      expect(recalled.text).toBe(one);
    }
  });
});

describe("recall refusals", () => {
  it("refuses an unknown handle, a past-end offset, an over-page length, and malformed input", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(100, 40)}\n` });
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits: limitsWith({ DOCSFAB_TOOL_OUTPUT_RECALL_PAGE_BYTES: "64" }),
    });
    const tools = toolsByName(toolSet.definitions);
    const result = await call(tools.get("read")!, { path: "docs/big.md" });
    const { handle } = archiveNamed(splitProjection(textOf(result)).marker);
    const total = (detailsOf(result).docsfabToolResultArchive as { totalBytes: number }).totalBytes;
    const recall = tools.get(TOOL_RESULT_RECALL_TOOL_NAME)!;

    await expect(call(recall, { handle: "docsfab-tr-0000000000000000" })).rejects.toThrow(
      "DocsFab has no archived tool result with that handle in this step.",
    );
    await expect(call(recall, { handle, byteOffset: total })).rejects.toThrow(
      `DocsFab recall byteOffset ${total} is at or past the end of the archived result (${total} bytes).`,
    );
    await expect(call(recall, { handle, byteLength: 65 })).rejects.toThrow(
      "tool-output-recall-page-bytes-bound: 65 exceeds toolOutput.recallPageBytes = 64 bytes.",
    );
    await expect(call(recall, { handle, byteOffset: -1 })).rejects.toThrow(
      "DocsFab recall needs a handle string",
    );
    const page = splitRecall(textOf(await call(recall, { handle, byteLength: 64 })));
    expect(Buffer.byteLength(page.text, "utf8")).toBe(64);
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "expected-missing-probe", count: 2 },
      { category: "unsupported-pattern", count: 2 },
    ]);
  });

  it("never splits a UTF-8 code point and reports the exact range it returned", () => {
    const archive = new ToolResultArchive(resolveToolResultArchiveLimits(limitsWith()));
    const text = "aé€😀z".repeat(10);
    const outcome = archive.archive("read", text);
    const handle = (outcome as { receipt: { handle: string } }).receipt.handle;
    const bytes = Buffer.from(text, "utf8");

    // byteOffset 2 lands inside the two-byte character at bytes 1-2.
    const page = archive.recall({ handle, byteOffset: 2, byteLength: 5 });
    expect(page.start).toBe(1);
    expect(page.end).toBe(6);
    expect(page.text).toBe("é€");
    expect(Buffer.from(page.text, "utf8").equals(bytes.subarray(page.start, page.end))).toBe(true);

    // A length shorter than a four-byte character is refused, not expanded.
    const emoji = bytes.indexOf(Buffer.from("😀", "utf8"));
    expect(() => archive.recall({ handle, byteOffset: emoji, byteLength: 1 })).toThrow(
      /cannot return a whole UTF-8 code point at byteOffset \d+ within 1 bytes/u,
    );
    const whole = archive.recall({ handle, byteOffset: emoji, byteLength: 4 });
    expect(whole.text).toBe("😀");
    expect(whole.end - whole.start).toBe(4);
    expect(Buffer.byteLength(whole.text, "utf8")).toBeLessThanOrEqual(4);
  });

  it("refuses a recall page smaller than one UTF-8 code point at configuration", () => {
    expect(() =>
      resolveToolResultArchiveLimits(limitsWith({ DOCSFAB_TOOL_OUTPUT_RECALL_PAGE_BYTES: "1" })),
    ).toThrow("DOCSFAB_TOOL_OUTPUT_RECALL_PAGE_BYTES must be an integer between 4 and 32768.");
  });
});

describe("archived excerpt shape", () => {
  it("names both returned ranges, the handle, the digest, and the omitted bytes", () => {
    const capped = capToolOutputText("a\nb\nc\nd\n", 4);
    expect(
      toolOutputCapMarker({
        toolName: "grep",
        capBytes: 4,
        result: capped,
        totalBytes: 8,
        archive: { handle: "docsfab-tr-0123456789abcdef", sha256: "f".repeat(64) },
        tail: { startByte: 6, endByte: 8 },
      }),
    ).toBe(
      "[docsfab-output-cap grep: returned bytes 1-4 and 7-8 of 8 (cap 4 bytes). " +
        "Narrow the request (path, pattern, glob, or limit) and call again; this tool has no continuation offset. " +
        `Full result archived as handle=docsfab-tr-0123456789abcdef (sha256 ${"f".repeat(64)}); ` +
        `call ${TOOL_RESULT_RECALL_TOOL_NAME} with that handle and byteOffset=4 for the omitted bytes 5-6 ` +
        "without running this tool again. The tail (bytes 7-8) follows this notice.]",
    );
  });

  it("starts the tail on a line boundary inside its window and never before the head", () => {
    const source = Buffer.from("alpha\nbravo\ncharlie\n", "utf8");
    expect(toolOutputTail(source, 10, 6)).toEqual({
      text: "charlie\n",
      startByte: 12,
      endByte: 20,
    });
    // A last line longer than the window is a code-point-safe suffix.
    const long = Buffer.from(`x\n${"é".repeat(10)}`, "utf8");
    expect(toolOutputTail(long, 5, 2)).toEqual({ text: "éé", startByte: 18, endByte: 22 });
    expect(toolOutputTail(source, 10, 20)).toBeUndefined();
  });

  it("gives the head at least half the budget and the tail at most its declared limit", async () => {
    const text = `${numberedLines(100, 20)}\n`;
    const archive = new ToolResultArchive(
      resolveToolResultArchiveLimits(limitsWith({ DOCSFAB_TOOL_OUTPUT_EXCERPT_TAIL_BYTES: "64" })),
    );
    const projection = splitProjection(
      textOf(await call(withToolOutputCap(stubTool("grep", text), 1024, archive), {})),
    );
    expect(text.startsWith(projection.head)).toBe(true);
    expect(text.endsWith(projection.tail)).toBe(true);
    expect(Buffer.byteLength(projection.tail, "utf8")).toBeGreaterThan(0);
    expect(Buffer.byteLength(projection.tail, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(projection.head, "utf8")).toBeGreaterThan(1024 / 2);

    const small = splitProjection(
      textOf(
        await call(
          withToolOutputCap(
            stubTool("grep", text),
            100,
            new ToolResultArchive(resolveToolResultArchiveLimits(limitsWith())),
          ),
          {},
        ),
      ),
    );
    expect(Buffer.byteLength(small.tail, "utf8")).toBeGreaterThan(0);
    expect(Buffer.byteLength(small.tail, "utf8")).toBeLessThanOrEqual(50);
    expect(
      Buffer.byteLength(small.head, "utf8") + Buffer.byteLength(small.tail, "utf8"),
    ).toBeLessThanOrEqual(100);
  });

  it("keeps the pre-archive projection when no archive is supplied", async () => {
    const text = `${numberedLines(100, 20)}\n`;
    const result = await call(withToolOutputCap(stubTool("grep", text), 100), {});
    const projection = splitProjection(textOf(result));
    expect(projection.tail).toBe("");
    expect(projection.marker).not.toContain("handle=");
    expect(detailsOf(result).docsfabToolResultArchive).toBeUndefined();
  });
});

describe("recall grant", () => {
  it("grants and presents the recall tool only where the host opts in", async () => {
    for (const granted of [
      grantedTools("read-only", undefined, undefined, false, false, false, true),
      grantedTools("write", undefined, undefined, false, false, false, true),
      grantedTools("read-only", "evaluate", undefined, false, false, false, true),
    ]) {
      expect(granted).toContain(TOOL_RESULT_RECALL_TOOL_NAME);
      // Recorded under its own name: never as another read, never unknown.
      expect(normalizeObservedToolName(TOOL_RESULT_RECALL_TOOL_NAME, new Set(granted))).toBe(
        TOOL_RESULT_RECALL_TOOL_NAME,
      );
    }
    const workspace = await workspaceFixture({});
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolResultRecall: true,
      limits: limitsWith(),
    });
    expect(toolSet.definitions.map((tool) => tool.name)).toContain(TOOL_RESULT_RECALL_TOOL_NAME);
    expect(
      createToolResultRecallTool(
        new ToolResultArchive(resolveToolResultArchiveLimits(limitsWith())),
      ).name,
    ).toBe(TOOL_RESULT_RECALL_TOOL_NAME);
  });

  it("leaves the default grant, hosted catalog, and tool set exactly as before", async () => {
    // A hosted composition seals declaredTools; the recall tool is not in them.
    expect(READ_ONLY_TOOLS).not.toContain(TOOL_RESULT_RECALL_TOOL_NAME);
    expect(grantedTools("read-only")).not.toContain(TOOL_RESULT_RECALL_TOOL_NAME);
    expect(grantedTools("write")).not.toContain(TOOL_RESULT_RECALL_TOOL_NAME);
    for (const workflow of [
      "review-documentation",
      "update-documentation",
      "live-agent-turn",
    ] as const) {
      expect(inspectHostedWorkflowCatalog(workflow).declaredTools).not.toContain(
        TOOL_RESULT_RECALL_TOOL_NAME,
      );
    }

    // Without the opt-in the tool set registers no recall tool, keeps no
    // archive, and projects a capped result with no tail or handle.
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(100, 40)}\n` });
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
    });
    expect(toolSet.definitions.map((tool) => tool.name)).not.toContain(
      TOOL_RESULT_RECALL_TOOL_NAME,
    );
    expect(toolSet.getToolResultArchive()).toBeUndefined();
    const result = await call(toolsByName(toolSet.definitions).get("read")!, {
      path: "docs/big.md",
    });
    const projection = splitProjection(textOf(result));
    expect(projection.tail).toBe("");
    expect(projection.marker).not.toContain("handle=");
    expect(projection.marker).toMatch(/^\[docsfab-output-cap read: returned bytes 1-\d+ of \d+ /u);
    expect(detailsOf(result).docsfabToolResultArchive).toBeUndefined();
  });
});

describe("read paging with the archive enabled", () => {
  // With a tail on every cut page, the head's continuation offset still visits
  // every file line exactly once, in order.
  it.each([
    { limit: 24, cap: 530 },
    { limit: 30, cap: 530 },
  ])("visits every line exactly once at limit $limit", async ({ limit, cap }) => {
    const total = 100;
    const fileLines = Array.from(
      { length: total },
      (_item, index) => `L${String(index + 1).padStart(3, "0")}${"-".repeat(16)}`,
    );
    const workspace = await workspaceFixture({ "docs/paged.md": fileLines.join("\n") });
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: cap,
      toolResultRecall: true,
      limits: limitsWith(),
    });
    const read = toolsByName(toolSet.definitions).get("read")!;
    const visited: string[] = [];
    let offset = 1;
    let archived = 0;
    for (let page = 0; page < 60 && offset <= total; page += 1) {
      const payload = textOf(await call(read, { path: "docs/paged.md", offset, limit }));
      const { head, marker } = splitProjection(payload);
      if (marker.includes("handle=")) archived += 1;
      for (const line of head.split("\n")) {
        if (/^L\d{3}-/u.test(line)) visited.push(line);
      }
      const next = marker
        ? /Continue with offset=(\d+)/u.exec(marker)?.[1]
        : /Use offset=(\d+) to continue\./u.exec(payload)?.[1];
      if (!next) break;
      expect(Number(next)).toBeGreaterThan(offset);
      offset = Number(next);
    }
    expect(visited).toEqual(fileLines);
    expect(archived).toBeGreaterThan(0);
  });
});

const skillCrateDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skill-crate");

function auditStepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "tool-result-archive-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

function sseResponse(chunks: readonly object[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"];
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function scriptedTurn(
  delta: Record<string, unknown>,
  finishReason: "tool_calls" | "stop",
): Response {
  const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: "completion-archive-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, ...choice }],
    ...extra,
  });
  return sseResponse([
    chunk({ delta: { role: "assistant", ...delta }, finish_reason: null }),
    chunk(
      { delta: {}, finish_reason: finishReason },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ),
  ]);
}

function toolCallTurn(id: string, name: string, parameters: Record<string, unknown>): Response {
  return scriptedTurn(
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(parameters) },
        },
      ],
    },
    "tool_calls",
  );
}

function recordingProvider(responses: readonly Response[], delegated: string[]): typeof fetch {
  let index = 0;
  return async (_url: unknown, init?: RequestInit) => {
    delegated.push(String(init?.body ?? ""));
    const response = responses[index];
    index += 1;
    if (!response) throw new Error("Unexpected provider request.");
    return response.clone();
  };
}

describe("PiHarness with the tool-result archive", () => {
  it("grants, presents, and records a recall under its own name when the host opts in", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(400, 60)}\n` });
    const input = auditStepInput(workspace);
    // Handles are content-addressed, so the same read through an identically
    // configured tool set names the handle the harness will issue.
    const probe = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 4096,
      readTextRendering: readTextRenderingForStep(input),
      toolResultRecall: true,
    });
    const { handle } = archiveNamed(
      splitProjection(
        textOf(await call(toolsByName(probe.definitions).get("read")!, { path: "docs/big.md" })),
      ).marker,
    );

    const delegated: string[] = [];
    vi.stubGlobal(
      "fetch",
      recordingProvider(
        [
          toolCallTurn("call-1", "read", { path: "docs/big.md" }),
          toolCallTurn("call-2", TOOL_RESULT_RECALL_TOOL_NAME, {
            handle,
            byteOffset: 100,
            byteLength: 50,
          }),
          scriptedTurn({ content: "The documentation audit is complete." }, "stop"),
        ],
        delegated,
      ),
    );
    const harness = new PiHarness({
      skillCrateDirectory,
      model: validModelConfig,
      createConnection: createModelConnection,
      toolOutputCapBytes: 4096,
      toolResultRecall: true,
    });

    const result = await harness.runStep(input);

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(delegated).toHaveLength(3);
    expect(delegated[1]).toContain(`Full result archived as handle=${handle}`);
    expect(delegated[2]).toContain(`[docsfab-recall ${handle}: returned bytes 101-150 of`);
    expect(result.tools?.presented).toContain(TOOL_RESULT_RECALL_TOOL_NAME);
    expect(result.tools?.byTool).toEqual(
      expect.arrayContaining([
        { name: "read", calls: 1, failures: 0 },
        { name: TOOL_RESULT_RECALL_TOOL_NAME, calls: 1, failures: 0 },
      ]),
    );
    expect(result.tools?.byTool.map((entry) => entry.name)).not.toContain("unknown-tool");
    expect(result.tools?.failedCalls).toBe(0);
    expect(result.tools?.toolResultArchive?.receipts).toEqual(
      expect.arrayContaining([expect.objectContaining({ handle, toolName: "read" })]),
    );
    expect(decodeTools(result.tools!)).toEqual(result.tools);
  });

  it("keeps the harness tool set unchanged without the opt-in", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(400, 60)}\n` });
    const delegated: string[] = [];
    vi.stubGlobal(
      "fetch",
      recordingProvider(
        [
          toolCallTurn("call-1", "read", { path: "docs/big.md" }),
          scriptedTurn({ content: "The documentation audit is complete." }, "stop"),
        ],
        delegated,
      ),
    );
    const harness = new PiHarness({
      skillCrateDirectory,
      model: validModelConfig,
      createConnection: createModelConnection,
      toolOutputCapBytes: 4096,
    });

    const result = await harness.runStep(auditStepInput(workspace));

    expect(result.tools?.presented).not.toContain(TOOL_RESULT_RECALL_TOOL_NAME);
    expect(result.tools?.toolResultArchive).toBeUndefined();
    expect(delegated[1]).toContain("docsfab-output-cap read: returned bytes 1-");
    expect(delegated[1]).not.toContain("handle=docsfab-tr-");
  });

  it("preserves the host tool ceiling when result recall is configured", async () => {
    const workspace = await workspaceFixture({ "docs/big.md": `${numberedLines(400, 60)}\n` });
    const delegated: string[] = [];
    vi.stubGlobal(
      "fetch",
      recordingProvider(
        [
          toolCallTurn("call-1", "read", { path: "docs/big.md" }),
          scriptedTurn({ content: "The documentation audit is complete." }, "stop"),
        ],
        delegated,
      ),
    );
    const harness = new PiHarness({
      skillCrateDirectory,
      model: validModelConfig,
      createConnection: createModelConnection,
      toolOutputCapBytes: 4096,
      toolResultRecall: true,
    });

    const result = await harness.runStep({ ...auditStepInput(workspace), toolCeiling: ["read"] });

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(result.tools?.presented).toEqual(["read"]);
    expect(result.tools?.byTool).toEqual([{ name: "read", calls: 1, failures: 0 }]);
    expect(result.tools?.toolResultArchive?.receipts).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "read" })]),
    );
    expect(delegated[1]).not.toContain(`"name":"${TOOL_RESULT_RECALL_TOOL_NAME}"`);
  });

  it("records archive identity and ceiling refusals on attempt tool evidence", async () => {
    const workspace = await workspaceFixture({
      "docs/one.md": `${numberedLines(60, 40)}\n`,
      "docs/two.md": `${numberedLines(61, 40)}\n`,
    });
    const input = auditStepInput(workspace);
    const uncapped = toolsByName(
      (
        await createConfinedToolSet({
          workspacePath: workspace,
          allowWrite: false,
          toolOutputCapBytes: 1_000_000,
          toolResultRecall: true,
          readTextRendering: readTextRenderingForStep(input),
        })
      ).definitions,
    ).get("read")!;
    const one = textOf(await call(uncapped, { path: "docs/one.md" }));
    const two = textOf(await call(uncapped, { path: "docs/two.md" }));
    const total = Buffer.byteLength(one, "utf8") + Buffer.byteLength(two, "utf8");
    const limits = limitsWith({ DOCSFAB_TOOL_OUTPUT_ARCHIVE_CEILING_BYTES: String(total - 1) });

    const delegated: string[] = [];
    vi.stubGlobal(
      "fetch",
      recordingProvider(
        [
          toolCallTurn("call-1", "read", { path: "docs/one.md" }),
          toolCallTurn("call-2", "read", { path: "docs/two.md" }),
          scriptedTurn({ content: "The documentation audit is complete." }, "stop"),
        ],
        delegated,
      ),
    );
    const harness = new PiHarness({
      skillCrateDirectory,
      model: validModelConfig,
      createConnection: createModelConnection,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
      limits,
    });

    const result = await harness.runStep(input);

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(result.tools?.toolResultArchive?.refusals).toEqual([
      { limitName: TOOL_RESULT_ARCHIVE_CEILING_LIMIT, observedBytes: total },
    ]);
    expect(result.tools?.toolResultArchive?.receipts.length).toBe(1);
    expect(JSON.stringify(result.tools?.toolResultArchive)).not.toContain(one.slice(0, 40));
    expect(decodeTools(result.tools!)).toEqual(result.tools);
    const overflow = collectRunLimitOverflowEvidence({
      steps: [{ tools: result.tools, inference: { attempts: [{ tools: result.tools }] } }],
    } as RunRecord);
    const overflowLines = projectRunLimitOverflowLines({ ...overflow, limits });
    expect(overflowLines).toHaveLength(1);
    expect(overflowLines[0]).toContain("tool-output-archive-ceiling-bytes-bound");
    expect(overflowLines[0]).toContain(String(total));
    expect(overflowLines[0]).toContain(String(total - 1));
  });
});
