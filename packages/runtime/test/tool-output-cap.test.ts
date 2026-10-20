// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import {
  capToolOutputText,
  DEFAULT_TOOL_OUTPUT_CAP_BYTES,
  deterministicGrepText,
  MAXIMUM_TOOL_OUTPUT_CAP_BYTES,
  MINIMUM_TOOL_OUTPUT_CAP_BYTES,
  OUTPUT_CAPPED_TOOL_NAMES,
  resolveToolOutputCapBytes,
  splitTrailingReadNotice,
  toolOutputCapMarker,
  TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE,
  withToolOutputCap,
} from "../src/harness/tool-output-cap.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporaryDirectories = temporaryRoots();

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

type CappableTool = Parameters<typeof withToolOutputCap>[0];

function stubTool(name: string, text: string): CappableTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object" as const },
    execute: async () => ({ content: [{ type: "text", text }], details: undefined }),
  } as unknown as CappableTool;
}

async function workspaceFixture() {
  const root = await temporaryDirectories.create("docsfab-tool-output-cap-");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "docs"), { recursive: true });
  return workspace;
}

describe("confined tool per-call output cap", () => {
  it("returns short payloads untouched and adds no marker", () => {
    const capped = capToolOutputText("alpha\nbeta\n", 64);
    expect(capped).toEqual({
      text: "alpha\nbeta\n",
      truncated: false,
      returnedBytes: 11,
      totalBytes: 11,
      returnedLines: 2,
    });
  });

  it("cuts to the last complete line at or under the byte cap", () => {
    const text = `${"a".repeat(9)}\n${"b".repeat(9)}\n${"c".repeat(9)}\n`;
    const capped = capToolOutputText(text, 25);
    expect(capped.text).toBe(`${"a".repeat(9)}\n${"b".repeat(9)}\n`);
    expect(capped.returnedBytes).toBe(20);
    expect(capped.returnedBytes).toBeLessThanOrEqual(25);
    expect(capped.totalBytes).toBe(30);
    expect(capped.truncated).toBe(true);
    expect(capped.returnedLines).toBe(2);
  });

  it("never splits a multi-byte code point at the cap boundary", () => {
    // Five 2-byte characters on one line; a 5-byte cap lands mid-character.
    const capped = capToolOutputText("ééééé", 5);
    expect(capped.returnedBytes).toBe(4);
    expect(capped.text).toBe("éé");
    expect(Buffer.byteLength(capped.text, "utf8")).toBe(capped.returnedBytes);
    expect(capped.returnedLines).toBe(0);
  });

  it("emits the exact read marker naming the byte range and continuation offset", () => {
    const text = `${"a".repeat(9)}\n${"b".repeat(9)}\n${"c".repeat(9)}\n`;
    const capped = capToolOutputText(text, 25);
    expect(toolOutputCapMarker({ toolName: "read", capBytes: 25, result: capped })).toBe(
      "[docsfab-output-cap read: returned bytes 1-20 of 30 (cap 25 bytes). " +
        "Continue with offset=3 (1-indexed line) and an explicit limit, or read a narrower range.]",
    );
    expect(
      toolOutputCapMarker({ toolName: "read", capBytes: 25, result: capped, startLine: 11 }),
    ).toContain("offset=13");
  });

  it("emits a no-offset marker for grep, find, and ls", () => {
    const capped = capToolOutputText("x".repeat(40), 16);
    for (const toolName of ["grep", "find", "ls"]) {
      expect(toolOutputCapMarker({ toolName, capBytes: 16, result: capped })).toBe(
        `[docsfab-output-cap ${toolName}: returned bytes 1-16 of 40 (cap 16 bytes). ` +
          "Narrow the request (path, pattern, glob, or limit) and call again; " +
          "this tool has no continuation offset.]",
      );
    }
  });

  it("tells the model that a single over-cap line cannot advance the offset", () => {
    const capped = capToolOutputText("x".repeat(40), 16);
    expect(toolOutputCapMarker({ toolName: "read", capBytes: 16, result: capped })).toBe(
      "[docsfab-output-cap read: returned bytes 1-16 of 40 (cap 16 bytes). " +
        "Line 1 alone exceeds the cap, so offset cannot advance; " +
        "use grep to select the part you need.]",
    );
  });

  it("caps a wrapped tool result byte-accurately and appends the marker", async () => {
    const text = `${"a".repeat(19)}\n`.repeat(10);
    const tool = withToolOutputCap(stubTool("read", text), 64);
    const result = await tool.execute("call-1", {}, undefined, undefined, undefined as never);
    const payload = textOf(result);
    const [body, marker] = splitMarker(payload);
    expect(Buffer.byteLength(body, "utf8")).toBe(60);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(64);
    expect(body).toBe(`${"a".repeat(19)}\n`.repeat(3));
    expect(marker).toBe(
      "[docsfab-output-cap read: returned bytes 1-60 of 200 (cap 64 bytes). " +
        "Continue with offset=4 (1-indexed line) and an explicit limit, or read a narrower range.]",
    );
  });

  it("leaves a wrapped tool result untouched when it fits the cap", async () => {
    const tool = withToolOutputCap(stubTool("ls", "docs\n"), 64);
    const result = await tool.execute("call-2", {}, undefined, undefined, undefined as never);
    expect(textOf(result)).toBe("docs\n");
    expect(textOf(result)).not.toContain("docsfab-output-cap");
  });

  it("rejects a non-positive cap rather than silently disabling the bound", () => {
    expect(() => capToolOutputText("alpha", 0)).toThrow(/positive safe integer/u);
    expect(() => withToolOutputCap(stubTool("read", "alpha"), -1)).toThrow(
      /positive safe integer/u,
    );
  });

  it("caps every read-only filesystem tool the confined set presents", async () => {
    const workspace = await workspaceFixture();
    const line = `${"topic ".repeat(20)}\n`;
    await writeFile(join(workspace, "docs", "large.md"), line.repeat(400), "utf8");
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 512,
    });
    const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
    expect([...tools.keys()]).toEqual(expect.arrayContaining([...OUTPUT_CAPPED_TOOL_NAMES]));

    const read = await tools
      .get("read")!
      .execute("read-1", { path: "docs/large.md" }, undefined, undefined, undefined as never);
    const [readBody, readMarker] = splitMarker(textOf(read));
    expect(Buffer.byteLength(readBody, "utf8")).toBeLessThanOrEqual(512);
    expect(readMarker).toMatch(
      /^\[docsfab-output-cap read: returned bytes 1-\d+ of \d+ \(cap 512 bytes\)\. Continue with offset=\d+ /u,
    );

    const grep = await tools
      .get("grep")!
      .execute(
        "grep-1",
        { path: "docs", pattern: "topic", literal: true },
        undefined,
        undefined,
        undefined as never,
      );
    const [grepBody, grepMarker] = splitMarker(textOf(grep));
    expect(Buffer.byteLength(grepBody, "utf8")).toBeLessThanOrEqual(512);
    expect(grepMarker).toContain("[docsfab-output-cap grep: returned bytes 1-");
    expect(grepMarker).toContain("this tool has no continuation offset.]");

    // find and ls are executed too, so a cap wrapping only read and grep fails.
    await Promise.all(
      Array.from({ length: 120 }, (_item, index) =>
        writeFile(
          join(workspace, "docs", `entry-${String(index).padStart(3, "0")}-with-a-long-name.md`),
          "body\n",
          "utf8",
        ),
      ),
    );
    for (const [name, parameters] of [
      ["find", { path: "docs", pattern: "*.md" }],
      ["ls", { path: "docs" }],
    ] as const) {
      const result = await tools
        .get(name)!
        .execute(`${name}-1`, parameters, undefined, undefined, undefined as never);
      const [body, marker] = splitMarker(textOf(result));
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(512);
      expect(marker).toContain(`[docsfab-output-cap ${name}: returned bytes 1-`);
      expect(marker).toContain("this tool has no continuation offset.]");
    }
  });

  it("defaults to the evidence-chosen 32 KiB cap and still truncates past it", async () => {
    // The default applies when no cap is configured, the returned payload never
    // exceeds it, the marker names the cap in force, and the marker reports the
    // bytes produced.
    const workspace = await workspaceFixture();
    // Larger than the cap, or the case stops truncating and proves nothing.
    // Multi-line on purpose: one line this long exceeds Pi's own 50 KB
    // single-line refusal, which returns a notice instead of content and never
    // exercises the cap.
    const line = `${"z".repeat(99)}\n`;
    const totalBytes = DEFAULT_TOOL_OUTPUT_CAP_BYTES * 4;
    await writeFile(
      join(workspace, "docs", "huge.md"),
      line.repeat(Math.ceil(totalBytes / line.length)),
      "utf8",
    );
    const toolSet = await createConfinedToolSet({ workspacePath: workspace, allowWrite: false });
    const read = toolSet.definitions.find((tool) => tool.name === "read")!;
    const result = await read.execute(
      "read-2",
      { path: "docs/huge.md" },
      undefined,
      undefined,
      undefined as never,
    );
    const [body, marker] = splitMarker(textOf(result));
    expect(DEFAULT_TOOL_OUTPUT_CAP_BYTES).toBe(32_768);
    expect(DEFAULT_TOOL_OUTPUT_CAP_BYTES).toBeGreaterThanOrEqual(MINIMUM_TOOL_OUTPUT_CAP_BYTES);
    expect(DEFAULT_TOOL_OUTPUT_CAP_BYTES).toBeLessThanOrEqual(MAXIMUM_TOOL_OUTPUT_CAP_BYTES);
    // The cap is applied, not merely declared: the payload is shorter than the
    // file and bounded by the cap. Asserting only `<= cap` would also pass if
    // the tool returned nothing at all, so the lower bound is asserted too.
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_CAP_BYTES);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(DEFAULT_TOOL_OUTPUT_CAP_BYTES / 2);
    // The marker names the cap in force and the bytes produced, derived from the
    // constant rather than restated, so it tracks a future re-size. `of N` is
    // what the tool handed the cap (Pi applies its own 50 KB ceiling first), and
    // it must exceed what was returned or nothing was actually withheld.
    expect(marker).toContain(`(cap ${DEFAULT_TOOL_OUTPUT_CAP_BYTES} bytes)`);
    const reported = /returned bytes 1-(\d+) of (\d+)/u.exec(marker);
    expect(reported, marker).not.toBeNull();
    const [returnedBytes, availableBytes] = [Number(reported![1]), Number(reported![2])];
    expect(returnedBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(availableBytes).toBeGreaterThan(returnedBytes);
  });

  it("reads a file that fits the raised cap in one call, with no continuation marker", async () => {
    // Positive control for the default's size: a file above 8 KiB and within
    // the default costs one round trip. At an 8192-byte cap this case fails.
    const workspace = await workspaceFixture();
    const body = `${"z".repeat(99)}\n`.repeat(200); // 20,000 B, just over the corpus p90
    await writeFile(join(workspace, "docs", "p90.md"), body, "utf8");
    const toolSet = await createConfinedToolSet({ workspacePath: workspace, allowWrite: false });
    const read = toolSet.definitions.find((tool) => tool.name === "read")!;
    const payload = textOf(
      await read.execute(
        "read-p90",
        { path: "docs/p90.md" },
        undefined,
        undefined,
        undefined as never,
      ),
    );
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(8192);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_CAP_BYTES);
    expect(payload).not.toContain("docsfab-output-cap");
  });
});

/**
 * Pi's read appends `\n\n[N more lines in file. Use offset=X to continue.]`. A
 * cut landing inside that notice must not pull back to the notice's own second
 * newline, or the marker advertises an offset one line past the content
 * actually returned and a line is silently skipped.
 */
describe("read continuation offset across Pi's own trailing notice", () => {
  const PI_NOTICE = "\n\n[90 more lines in file. Use offset=11 to continue.]";

  it("splits Pi's trailing bracketed notice off the content region", () => {
    const body = ["alpha", "beta", "gamma"].join("\n");
    expect(splitTrailingReadNotice(`${body}${PI_NOTICE}`)).toEqual({
      body,
      notice: PI_NOTICE,
    });
    expect(splitTrailingReadNotice(body)).toEqual({ body, notice: "" });
    // A notice-shaped line that is not at the very end is content, not a notice.
    expect(splitTrailingReadNotice(`${body}${PI_NOTICE}\nmore`).notice).toBe("");
    // Pi's longest real notice is well under 128 bytes. A bracketed line longer
    // than the bound is content, so it stays inside the capped region.
    const long = `[${"z".repeat(400)}]`;
    expect(splitTrailingReadNotice(`${body}\n\n${long}`).notice).toBe("");
    const short = `[${"z".repeat(200)}]`;
    expect(splitTrailingReadNotice(`${body}\n\n${short}`).notice).toBe(`\n\n${short}`);
  });

  it("keeps the offset on the content line when the cut lands inside the notice", async () => {
    // Ten 27-byte lines joined without a trailing newline, then Pi's notice.
    const lines = Array.from(
      { length: 10 },
      (_item, index) => `L${String(index + 1).padStart(2, "0")}${"x".repeat(24)}`,
    );
    const content = lines.join("\n");
    expect(Buffer.byteLength(content, "utf8")).toBe(10 * 27 + 9);
    const text = `${content}${PI_NOTICE}`;
    // Cap lands inside the notice: content + "\n\n" fits, the notice does not.
    const capBytes = Buffer.byteLength(content, "utf8") + 20;

    const tool = withToolOutputCap(stubTool("read", text), capBytes);
    const payload = textOf(
      await tool.execute(
        "read-notice",
        { path: "docs/x.md", limit: 10 },
        undefined,
        undefined,
        undefined as never,
      ),
    );

    const [body, marker] = splitMarker(payload);

    // The content fits, but Pi's notice would carry the block over the cap, so
    // the DocsFab marker replaces it -- naming the same line Pi's notice named.
    expect(body).toBe(content);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(capBytes);
    expect(marker).toContain("Continue with offset=11 (1-indexed line)");
    expect(PI_NOTICE).toContain("offset=11");
  });

  it("reports the bytes the tool produced when only the notice pushes the block over", async () => {
    // A block cut solely because the harness notice would not fit must not
    // report "returned bytes 1-N of N" beside a truncation marker, which says
    // nothing was left behind while marking that something was.
    const body = Array.from(
      { length: 9 },
      (_item, index) => `L${String(index + 1).padStart(3, "0")} xxxxx`,
    ).join("\n");
    const notice = "\n\n[91 more lines in file. Use offset=10 to continue.]";
    expect(Buffer.byteLength(body, "utf8")).toBe(98);
    expect(Buffer.byteLength(body + notice, "utf8")).toBe(151);

    const tool = withToolOutputCap(stubTool("read", body + notice), 100);
    const payload = textOf(
      await tool.execute(
        "read-produced",
        { path: "docs/x.md", offset: 1, limit: 9 },
        undefined,
        undefined,
        undefined as never,
      ),
    );
    const [returned, marker] = splitMarker(payload);

    expect(returned).toBe(body);
    expect(marker).toContain("returned bytes 1-98 of 151 (cap 100 bytes)");
    expect(marker).not.toContain("of 98 ");
  });

  it("keeps Pi's own notice when the whole block fits the cap", async () => {
    const lines = Array.from(
      { length: 10 },
      (_item, index) => `L${String(index + 1).padStart(2, "0")}${"x".repeat(24)}`,
    );
    const text = `${lines.join("\n")}${PI_NOTICE}`;
    const tool = withToolOutputCap(stubTool("read", text), Buffer.byteLength(text, "utf8"));
    const payload = textOf(
      await tool.execute(
        "read-fits",
        { path: "docs/x.md", limit: 10 },
        undefined,
        undefined,
        undefined as never,
      ),
    );

    expect(payload).toBe(text);
    expect(payload).not.toContain("docsfab-output-cap");
  });

  it("reports the content-only offset when the cap truncates a payload carrying a notice", async () => {
    const lines = Array.from(
      { length: 10 },
      (_item, index) => `L${String(index + 1).padStart(2, "0")}${"x".repeat(24)}`,
    );
    const content = lines.join("\n");
    const text = `${content}${PI_NOTICE}`;
    // Four complete 28-byte lines plus their newlines is 116 bytes.
    const tool = withToolOutputCap(stubTool("read", text), 120);
    const payload = textOf(
      await tool.execute(
        "read-cut",
        { path: "docs/x.md", limit: 10 },
        undefined,
        undefined,
        undefined as never,
      ),
    );
    const [body, marker] = splitMarker(payload);

    expect(body).toBe(`${lines.slice(0, 4).join("\n")}\n`);
    expect(marker).toContain("Continue with offset=5 (1-indexed line)");
    expect(marker).not.toContain("offset=6");
    // Pi's stale notice is dropped; the DocsFab marker supersedes it.
    expect(payload).not.toContain("more lines in file");
  });

  it("continues from the requested offset rather than line 1", async () => {
    const lines = Array.from(
      { length: 10 },
      (_item, index) => `L${String(index + 1).padStart(2, "0")}${"x".repeat(24)}`,
    );
    const tool = withToolOutputCap(stubTool("read", lines.join("\n")), 120);
    const payload = textOf(
      await tool.execute(
        "read-offset",
        { path: "docs/x.md", offset: 41 },
        undefined,
        undefined,
        undefined as never,
      ),
    );

    expect(splitMarker(payload)[1]).toContain("Continue with offset=45 (1-indexed line)");
  });

  // Each page is 20 bytes of line plus a newline. limit 24 makes the content
  // (503 B) fit the 530 B cap so the cut lands inside Pi's notice;
  // limit 30 makes the content (629 B) exceed it so DocsFab does the cutting.
  it.each([
    { limit: 24, cap: 530, cutsInside: "Pi's continuation notice" },
    { limit: 30, cap: 530, cutsInside: "the file content" },
  ])(
    "pages a real file visiting every line exactly once when the cut lands in $cutsInside",
    async ({ limit, cap }) => {
      const workspace = await workspaceFixture();
      const total = 100;
      const fileLines = Array.from(
        { length: total },
        (_item, index) => `L${String(index + 1).padStart(3, "0")}${"-".repeat(16)}`,
      );
      await writeFile(join(workspace, "docs", "paged.md"), fileLines.join("\n"), "utf8");
      const toolSet = await createConfinedToolSet({
        workspacePath: workspace,
        allowWrite: false,
        toolOutputCapBytes: cap,
      });
      const read = toolSet.definitions.find((tool) => tool.name === "read")!;

      const visited: string[] = [];
      let offset = 1;
      for (let page = 0; page < 60 && offset <= total; page += 1) {
        const payload = textOf(
          await read.execute(
            `page-${page}`,
            { path: "docs/paged.md", offset, limit },
            undefined,
            undefined,
            undefined as never,
          ),
        );
        const [body, marker] = splitMarker(payload);
        const { body: content } = splitTrailingReadNotice(body);
        for (const line of content.split("\n")) {
          if (line.startsWith("L")) visited.push(line);
        }
        const next = marker
          ? /offset=(\d+)/u.exec(marker)?.[1]
          : /Use offset=(\d+) to continue\./u.exec(payload)?.[1];
        if (!next) break;
        const parsed = Number(next);
        expect(parsed).toBeGreaterThan(offset);
        offset = parsed;
      }

      // Every line exactly once, in order: no skip and no duplicate.
      expect(visited).toEqual(fileLines);
    },
  );
});

/**
 * The notice split must not become a cap bypass: an unbounded notice pattern
 * would classify a long trailing content line as Pi's notice, hold it out of
 * the capped region, and return it untouched with no marker. The cap, not the
 * offset, is the boundary this module exists to hold.
 */
describe("per-call cap holds against a trailing bracketed content line", () => {
  const bracketLine = (bytes: number) => `[${"z".repeat(bytes - 2)}]`;

  it("caps a trailing bracketed line far longer than any real notice", async () => {
    const text = `# Title\nintro\n\n${bracketLine(49_000)}`;
    const tool = withToolOutputCap(stubTool("read", text), 8192);
    const payload = textOf(
      await tool.execute(
        "read-long",
        { path: "docs/x.md" },
        undefined,
        undefined,
        undefined as never,
      ),
    );
    const [body, marker] = splitMarker(payload);

    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(8192);
    expect(marker).toContain("docsfab-output-cap read:");
  });

  it("caps a flat one-line JSON array that follows a blank line", async () => {
    const array = `[${Array.from({ length: 6_000 }, (_item, index) => index).join(",")}]`;
    const tool = withToolOutputCap(stubTool("read", `// data\n\n${array}`), 8192);
    const payload = textOf(
      await tool.execute(
        "read-json",
        { path: "docs/x.json" },
        undefined,
        undefined,
        undefined as never,
      ),
    );

    expect(Buffer.byteLength(splitMarker(payload)[0], "utf8")).toBeLessThanOrEqual(8192);
    expect(payload).toContain("docsfab-output-cap read:");
  });

  it("marks a short trailing bracketed line that would carry the block over the cap", async () => {
    // The body fits, the notice-shaped line is short enough to match, but the
    // two together do not fit: the block must not be emitted untouched.
    const body = `${"a".repeat(199)}\n`.repeat(6);
    const text = `${body.slice(0, -1)}\n\n${bracketLine(120)}`;
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(1300);
    const tool = withToolOutputCap(stubTool("read", text), 1300);
    const payload = textOf(
      await tool.execute(
        "read-edge",
        { path: "docs/x.md" },
        undefined,
        undefined,
        undefined as never,
      ),
    );
    const [cappedBody, marker] = splitMarker(payload);

    expect(Buffer.byteLength(cappedBody, "utf8")).toBeLessThanOrEqual(1300);
    expect(marker).toContain("docsfab-output-cap read:");
  });

  it("still pages a file whose last line is an over-cap bracketed line without skipping", async () => {
    const workspace = await workspaceFixture();
    const fileLines = [
      ...Array.from(
        { length: 12 },
        (_item, index) => `L${String(index + 1).padStart(3, "0")}${"-".repeat(16)}`,
      ),
      "",
      bracketLine(4_000),
    ];
    await writeFile(join(workspace, "docs", "bracket.md"), fileLines.join("\n"), "utf8");
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
    });
    const read = toolSet.definitions.find((tool) => tool.name === "read")!;

    const visited: string[] = [];
    let offset = 1;
    for (let page = 0; page < 30; page += 1) {
      const payload = textOf(
        await read.execute(
          `bracket-${page}`,
          { path: "docs/bracket.md", offset, limit: 8 },
          undefined,
          undefined,
          undefined as never,
        ),
      );
      const [body, marker] = splitMarker(payload);
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(1024);
      const { body: content } = splitTrailingReadNotice(body);
      for (const line of content.split("\n")) {
        if (line.startsWith("L")) visited.push(line);
      }
      const next = marker
        ? /offset=(\d+)/u.exec(marker)?.[1]
        : /Use offset=(\d+) to continue\./u.exec(payload)?.[1];
      if (!next || Number(next) <= offset) break;
      offset = Number(next);
    }

    // The over-cap bracketed line may repeat, but no L-line may be skipped.
    expect(visited).toEqual(fileLines.filter((line) => line.startsWith("L")));
  });

  it("advances past a line whose bytes equal the cap exactly", () => {
    // The line fits; only its newline does not. Counting that as zero lines told
    // the model the line "alone exceeds the cap" and stalled paging on it.
    const capped = capToolOutputText(`${"a".repeat(32)}\n${"b".repeat(32)}`, 32);
    expect(capped.returnedBytes).toBe(32);
    expect(capped.returnedLines).toBe(1);
    expect(toolOutputCapMarker({ toolName: "read", capBytes: 32, result: capped })).toContain(
      "Continue with offset=2 (1-indexed line)",
    );

    // A line genuinely longer than the cap still says so.
    const overflowing = capToolOutputText(`${"a".repeat(64)}\nnext`, 32);
    expect(overflowing.returnedLines).toBe(0);
    expect(toolOutputCapMarker({ toolName: "read", capBytes: 32, result: overflowing })).toContain(
      "alone exceeds the cap",
    );
  });
});

describe("deterministic grep ordering before the cap", () => {
  it("orders plain match lines by path then line number", () => {
    const shuffled = ["b.md:9: hit", "a.md:10: hit", "a.md:2: hit", "b.md:1: hit"].join("\n");
    expect(deterministicGrepText(shuffled)).toBe(
      ["a.md:2: hit", "a.md:10: hit", "b.md:1: hit", "b.md:9: hit"].join("\n"),
    );
  });

  it("preserves Pi's trailing notice and leaves context blocks alone", () => {
    const withNotice = "b.md:2: hit\na.md:1: hit\n\n[100 matches limit reached]";
    expect(deterministicGrepText(withNotice)).toBe(
      "a.md:1: hit\nb.md:2: hit\n\n[100 matches limit reached]",
    );
    // Context mode emits multi-line blocks that must not be reordered.
    const contextual = "a.md:1: hit\n  surrounding line\nb.md:2: hit";
    expect(deterministicGrepText(contextual)).toBe(contextual);
    expect(deterministicGrepText("No matches found")).toBe("No matches found");
  });

  it("returns an identical capped window for identical calls", async () => {
    const matches = Array.from(
      { length: 60 },
      (_item, index) => `docs/f${String(index).padStart(3, "0")}.md:${index}: needle here`,
    );
    const shuffle = (values: string[]) => [...values].sort(() => Math.random() - 0.5);
    const windows = new Set<string>();
    for (let call = 0; call < 5; call += 1) {
      const tool = withToolOutputCap(stubTool("grep", shuffle(matches).join("\n")), 512);
      windows.add(
        textOf(await tool.execute(`grep-${call}`, {}, undefined, undefined, undefined as never)),
      );
    }
    expect(windows.size).toBe(1);
  });
});

describe("host-owned tool output cap setting", () => {
  it("uses the runtime default when the host sets nothing", () => {
    expect(resolveToolOutputCapBytes({})).toBe(DEFAULT_TOOL_OUTPUT_CAP_BYTES);
    expect(resolveToolOutputCapBytes({ [TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE]: "  " })).toBe(
      DEFAULT_TOOL_OUTPUT_CAP_BYTES,
    );
  });

  it("accepts a host setting inside the supported range", () => {
    expect(resolveToolOutputCapBytes({ [TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE]: "16384" })).toBe(
      16_384,
    );
    expect(
      resolveToolOutputCapBytes({
        [TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE]: String(MINIMUM_TOOL_OUTPUT_CAP_BYTES),
      }),
    ).toBe(MINIMUM_TOOL_OUTPUT_CAP_BYTES);
    expect(
      resolveToolOutputCapBytes({
        [TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE]: String(MAXIMUM_TOOL_OUTPUT_CAP_BYTES),
      }),
    ).toBe(MAXIMUM_TOOL_OUTPUT_CAP_BYTES);
  });

  it("fails closed instead of ignoring an out-of-range host setting", () => {
    for (const raw of ["0", "512", "1048576", "not-a-number", "8192.5"]) {
      expect(() =>
        resolveToolOutputCapBytes({ [TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE]: raw }),
      ).toThrow(/DOCSFAB_TOOL_OUTPUT_CAP_BYTES must be an integer between 1024 and 262144\./u);
    }
  });
});

function splitMarker(payload: string): [string, string] {
  const index = payload.lastIndexOf("\n[docsfab-output-cap ");
  if (index < 0) return [payload, ""];
  return [payload.slice(0, index), payload.slice(index + 1)];
}
