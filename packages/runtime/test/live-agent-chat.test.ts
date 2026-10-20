// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { LiveAgentChatRenderer } from "../src/live-agent/chat-renderer.js";

function render(environment: NodeJS.ProcessEnv = {}, columns = 80) {
  let output = "";
  const chat = new LiveAgentChatRenderer({
    environment,
    columns: () => columns,
    tty: true,
    write: (text) => {
      output += text;
    },
  });
  return { chat, raw: () => output, plain: () => stripVTControlCharacters(output) };
}

describe("live-agent chat presentation", () => {
  it("separates input and rendered Markdown without repeating startup mode or help", () => {
    const { chat, plain, raw } = render();
    expect(stripVTControlCharacters(chat.prompt())).toBe("You: ");
    chat.append("## Create a report\n\nUse **the CLI** with `--output`.\n\n");
    chat.close();
    chat.prompt();
    expect(plain().match(/YOU/gu)).toHaveLength(2);
    expect(plain()).not.toMatch(/WORKFLOW WRITES ENABLED|READ-ONLY|\/exit to quit/u);
    expect(plain()).toContain("DOCSFAB");
    expect(plain()).toContain("Create a report");
    expect(plain()).not.toContain("## Create");
    expect(plain()).not.toContain("**the CLI**");
    expect(raw()).toContain("\u001b[38;5;");
  });

  it("keeps split code fences together and closes message framing at the next prompt", () => {
    const { chat, plain } = render();
    for (const chunk of ["```", "`bash\nnode cli.mjs export --output report.txt\n", "```", "`\n"])
      chat.append(chunk);
    chat.close();
    chat.prompt();
    expect(plain()).toContain("node cli.mjs export --output report.txt");
    expect(plain()).not.toContain("````");
    expect(plain()).toContain("YOU");
    expect(plain().indexOf("node cli")).toBeLessThan(plain().indexOf("YOU"));
  });

  it("renders a wrapped quoted request without adding characters to copied text", () => {
    const { chat, plain } = render();
    const request =
      "Check DocsFab development changes merged on October 7, 2026 (UTC−07:00), and update the current documentation to reflect them. Do not commit, push, or open an MR.";
    chat.append(`> ${request}`);
    chat.close();
    const body = plain()
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("──") && !/^─+$/u.test(line));
    expect(body.length).toBeGreaterThan(1);
    expect(body.map((line) => line.trimEnd()).join(" ")).toBe(request);
    expect(plain()).not.toContain("│");
  });

  it("keeps nested quotes readable without vertical borders", () => {
    const { chat, plain, raw } = render();
    chat.append("> First quote.\n>\n> > Nested **quote**.\n\nOrdinary prose.\n");
    chat.close();
    expect(plain()).toContain("First quote.");
    expect(plain()).toContain("Nested quote.");
    expect(plain()).toContain("Ordinary prose.");
    expect(plain()).not.toContain("│");
    expect(plain()).not.toContain("> ");
    expect(raw()).toMatch(/\u001b\[[\d;]*mFirst quote\./u);
  });

  it("preserves literal bars and pipes in copied code without adding a message border", () => {
    const { chat, plain } = render();
    chat.append('```text\nprintf "│ value" | cat\n```\n');
    chat.close();
    expect(plain()).toContain('printf "│ value" | cat');
    expect(plain().match(/│/gu)).toHaveLength(1);
    expect(plain()).not.toMatch(/^│/mu);
  });

  it("preserves literal Markdown characters in indented code", () => {
    const { chat, plain } = render();
    chat.append('    print("**literal**")\n    print("```next```")\n');
    chat.close();
    expect(plain()).toContain('    print("**literal**")');
    expect(plain()).toContain('    print("```next```")');
  });

  it("flushes an unfinished fence at interruption without swallowing the next message", () => {
    const { chat, plain } = render();
    chat.append("```text\nPartial response");
    chat.close();
    chat.append("## Next response\n\nNormal prose.");
    chat.close();
    expect(plain()).toContain("Partial response");
    expect(plain()).toContain("Next response");
    expect(plain()).not.toContain("## Next");
    expect(plain().match(/DOCSFAB/gu)).toHaveLength(2);
  });

  it.each([{ NO_COLOR: "" }, { TERM: "dumb" }, { FORCE_COLOR: "0" }])(
    "preserves immediate plain-text streaming with %j",
    (environment) => {
      const { chat, raw } = render(environment);
      expect(chat.prompt()).toBe("You: ");
      chat.append("## Raw ");
      expect(raw()).toBe("DocsFab: ## Raw ");
      chat.append("Markdown");
      chat.close();
      expect(raw()).toBe("DocsFab: ## Raw Markdown\n");
    },
  );

  it("wraps Unicode text at the current width and removes model terminal controls", () => {
    const { chat, raw, plain } = render({}, 35);
    chat.append("Text \u001b[2Jwith 漢字 and an emoji 🦋 in a long response.\n\n");
    chat.close();
    expect(raw()).not.toContain("\u001b[2J");
    expect(plain()).toContain("漢字");
    expect(plain()).toContain("🦋");
    for (const line of plain().split("\n")) expect([...line].length).toBeLessThanOrEqual(35);
  });
});
