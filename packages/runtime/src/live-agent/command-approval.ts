// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Host-owned approval data, separate from the model's tool arguments. */
export interface CommandApproval {
  kind: "command";
  repositoryPath: string;
  command: string;
}

export type LiveConfirmation = string | CommandApproval;

export const COMMAND_APPROVAL_PROMPT = "[y] Approve  [n] Cancel (default: cancel): ";

/** Render only. Never parse, unescape, or rewrite the script that will execute. */
export function renderCommandApproval(
  request: CommandApproval,
  options: { columns: number; color: boolean },
): string {
  const width = Math.max(12, Math.min(100, options.columns - 1));
  const paint = (text: string, color: number) =>
    options.color ? `\u001b[38;5;${color}m${text}\u001b[0m` : text;
  const rows = wrap(request.command, width - 2);
  return [
    "",
    paint("── APPROVAL · Host command", 214),
    ...wrap(`Repository: ${request.repositoryPath}`, width).map((line) => line.text),
    paint("─".repeat(width), 238),
    ...rows.map(({ text, continuation }) => `${paint(continuation ? "↪" : "│", 238)} ${text}`),
    paint("─".repeat(width), 238),
    "Display: ↪ marks wraps; ⟦U+…⟧ marks tabs, invisible controls, and a literal ⟦.",
    "",
  ].join("\n");
}

function wrap(text: string, width: number): { text: string; continuation: boolean }[] {
  // Keep line breaks, quotes, backslashes, and shell syntax literal, so a shell
  // string containing \\n cannot look like a new command in this view. The
  // escape opener is itself escaped, so literal `⟦U+0009⟧` cannot render as a tab.
  const safe = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}⟦]/gu, (character) =>
    character === "\n"
      ? character
      : `⟦U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`,
  );
  const rows: { text: string; continuation: boolean }[] = [];
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const line of safe.split("\n")) {
    let row = "";
    let used = 0;
    let breakAt = 0;
    let breakCells = 0;
    let continuation = false;
    for (const { segment } of segments.segment(line)) {
      // Conservatively reserve two cells for non-ASCII graphemes; never split an
      // emoji or combining sequence or let a wide character overrun the panel.
      const cells = /^[\u0020-\u007e]$/u.test(segment) ? 1 : 2;
      if (used + cells > width) {
        // Prefer a space boundary, retaining that space so wrapping loses no data.
        rows.push({ text: breakAt ? row.slice(0, breakAt) : row, continuation });
        row = breakAt ? row.slice(breakAt) : "";
        used = breakAt ? used - breakCells : 0;
        breakAt = 0;
        breakCells = 0;
        continuation = true;
      }
      row += segment;
      used += cells;
      if (segment === " ") {
        breakAt = row.length;
        breakCells = used;
      }
    }
    rows.push({ text: row, continuation });
  }
  return rows;
}
