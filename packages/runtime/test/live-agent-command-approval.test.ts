// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { renderCommandApproval } from "../src/live-agent/command-approval.js";

const options = { columns: 80, color: false };
const request = { kind: "command" as const, repositoryPath: "/repo with spaces", command: "" };

describe("live-agent command approval presentation", () => {
  it("preserves shell quotes, literal backslashes, indentation, and actual line breaks", () => {
    const command = 'git status\nprintf "%s\\n" "two words"\n  git diff --check';
    const rendered = renderCommandApproval({ ...request, command }, options);
    expect(rendered).toContain("Repository: /repo with spaces");
    expect(rendered).toContain('│ git status\n│ printf "%s\\n" "two words"\n│   git diff --check');
    expect(rendered).not.toContain("hidden");
    expect(rendered).not.toContain("\u001b");
  });

  it("shows every character of multiline and long single-line scripts on the first display", () => {
    for (const command of [
      Array.from({ length: 20 }, (_, n) => `echo ${n}`).join("\n"),
      "x".repeat(16_000),
    ]) {
      const full = renderCommandApproval({ ...request, command }, options);
      expect(full.split("\n").filter((line) => /^[│↪] /u.test(line)).length).toBeGreaterThan(10);
      expect(full).not.toContain("hidden");
      const reconstructed = full
        .split("\n")
        .filter((line) => /^[│↪] /u.test(line))
        .map((line, index) => `${line.startsWith("│") && index > 0 ? "\n" : ""}${line.slice(2)}`)
        .join("");
      expect(reconstructed).toBe(command);
    }
  });

  it("marks wraps and does not interpret shell separators or escapes as formatting", () => {
    const command = 'echo "a;b && c\\nd" ' + "z".repeat(60);
    const full = renderCommandApproval({ ...request, command }, { columns: 32, color: false });
    expect(full).toContain('│ echo "a;b && c\\nd"');
    expect(full).toContain("\n↪ ");
    for (const line of full.split("\n").filter((line) => /^[│↪] /u.test(line))) {
      expect(line.length).toBeLessThanOrEqual(31);
    }
  });

  it("makes terminal controls, bidi overrides, and tabs visible instead of executing or hiding them", () => {
    const rendered = renderCommandApproval(
      { ...request, command: "echo\t\u009b31m\u001b[2J\u202evalue" },
      options,
    );
    expect(rendered).toContain("⟦U+0009⟧");
    expect(rendered).toContain("⟦U+009B⟧");
    expect(rendered).toContain("⟦U+001B⟧");
    expect(rendered).toContain("⟦U+202E⟧");
    expect(rendered).not.toMatch(/[\t\u009b\u001b\u202e]/u);
  });

  it("adds only presentation color while exposing invisible joiners", () => {
    const input = { ...request, command: "echo " + "👩‍💻界".repeat(20) };
    const plain = renderCommandApproval(input, options);
    const color = renderCommandApproval(input, { ...options, color: true });
    expect(stripVTControlCharacters(color)).toBe(plain);
    expect(color).toContain("\u001b[38;5;214m");
    expect(plain).toContain("⟦U+200D⟧");
  });

  it("reconstructs the exact approved script from the rendered rows, including wrapped spaces", () => {
    const decode = (full: string) =>
      full
        .split("\n")
        .filter((line) => /^[│↪] /u.test(line))
        .map((line, index) => `${line.startsWith("│") && index > 0 ? "\n" : ""}${line.slice(2)}`)
        .join("")
        .replace(/⟦U\+([0-9A-F]{4,6})⟧/gu, (_match, hex: string) =>
          String.fromCodePoint(Number.parseInt(hex, 16)),
        );
    for (const command of [
      // A wrapped line longer than the panel whose break points are spaces.
      "git commit --only -m 'docs: one two three four five six seven eight nine ten' -- docs/a.md docs/b.md",
      "  leading and trailing spaces around a command that is long enough to wrap twice here  ",
      "echo\tone two three four five six seven eight nine ten eleven twelve\u200b\u0085\u009b end",
      "printf '%s' 'literal ⟦U+0009⟧ and ⟦ and ⟧ text' ; echo a  b   c    d     e      f       g",
      "first line\n  second line with enough words to wrap around the panel at least once\n",
    ]) {
      for (const columns of [32, 80]) {
        const full = renderCommandApproval({ ...request, command }, { columns, color: false });
        expect(decode(full), `${columns}: ${command}`).toBe(command);
      }
    }
  });

  it("never renders literal escape text the same as the control it names", () => {
    const tab = renderCommandApproval({ ...request, command: "echo\tvalue" }, options);
    const literal = renderCommandApproval({ ...request, command: "echo⟦U+0009⟧value" }, options);
    expect(literal).not.toBe(tab);
    expect(literal).toContain("│ echo⟦U+27E6⟧U+0009⟧value");
    // Adjacent characters are not escaped: only the opener is ambiguous.
    expect(renderCommandApproval({ ...request, command: "a ⟧ [ ] 〚 b" }, options)).toContain(
      "│ a ⟧ [ ] 〚 b",
    );
  });
});
