// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { UNDISPLAYABLE_CODE_POINT, escapeUndisplayable } from "../../shared/display-text.js";
import type { PresentationCapabilities } from "./capabilities.js";
import { unicodeCellWidth } from "./capabilities.js";
import type {
  PresentationAction,
  PresentationDetail,
  PresentationDocument,
  PresentationEvidence,
  PresentationRow,
} from "./types.js";

export interface RenderedPresentation {
  readonly stdout: string;
  readonly stderr: string;
}

export interface PresentationContext {
  readonly detail: PresentationDetail;
  readonly capabilities: PresentationCapabilities;
}

export type PresentationTerminalColor = "green" | "red" | "yellow" | "nvidiaGreen";

export interface PresentationTerminalStyle {
  readonly color?: PresentationTerminalColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

const ANSI_RESET = "\u001b[0m";
const ANSI_STYLES: Readonly<Record<PresentationTerminalColor | "bold" | "dim", string>> = {
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  nvidiaGreen: "\u001b[38;2;118;185;0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
};

/** Apply the shared ANSI palette to one line using already-resolved stream capabilities. */
export function paintTerminalText(
  text: string,
  style: PresentationTerminalStyle,
  capabilities: PresentationCapabilities["stdout"],
): string {
  if (!capabilities.color) return text;
  const prefix = [
    style.bold ? ANSI_STYLES.bold : "",
    style.dim ? ANSI_STYLES.dim : "",
    style.color === undefined ? "" : ANSI_STYLES[style.color],
  ].join("");
  return prefix ? `${prefix}${text}${ANSI_RESET}` : text;
}

function visibleText(value: string): string {
  return escapeUndisplayable(value);
}

function displayEvidence(evidence: PresentationEvidence<string>): string {
  return evidence.state === "known"
    ? visibleText(evidence.value)
    : `unknown${evidence.explanation ? ` (${visibleText(evidence.explanation)})` : ""}`;
}

function quoteArgument(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function displayAction(action: PresentationAction): {
  readonly text: string;
  readonly wrap: boolean;
} {
  switch (action.kind) {
    case "argv":
      if ([action.executable, ...action.args].some((part) => UNDISPLAYABLE_CODE_POINT.test(part))) {
        return {
          text: `${visibleText(action.label)}: command is not copyable because it contains control or format characters`,
          wrap: true,
        };
      }
      return {
        text: `${visibleText(action.label)}: ${[action.executable, ...action.args].map(quoteArgument).join(" ")}`,
        wrap: false,
      };
    case "link":
      return { text: `${visibleText(action.label)}: ${visibleText(action.href)}`, wrap: false };
    case "instruction":
      return { text: visibleText(action.text), wrap: true };
    case "decision":
      return { text: `${visibleText(action.label)} (decision required)`, wrap: true };
  }
}

function displayRow(
  row: PresentationRow,
  capabilities: PresentationCapabilities,
): { readonly stream: "stdout" | "stderr"; readonly text: string; readonly wrap: boolean } {
  switch (row.kind) {
    case "attention":
      return {
        stream: row.stream ?? "stdout",
        text: `ATTENTION: ${visibleText(row.message)}`,
        wrap: true,
      };
    case "summary":
      return { stream: row.stream ?? "stdout", text: visibleText(row.text), wrap: true };
    case "section":
      return {
        stream: row.stream ?? "stdout",
        text: capabilities[row.stream ?? "stdout"].ornaments
          ? `${capabilities.unicode ? "──" : "--"} ${visibleText(row.title)} ${capabilities.unicode ? "──" : "--"}`
          : visibleText(row.title),
        wrap: false,
      };
    case "field":
      return {
        stream: row.stream ?? "stdout",
        text: `${visibleText(row.label)}: ${displayEvidence(row.evidence)}`,
        wrap: true,
      };
    case "text":
      return { stream: row.stream ?? "stdout", text: visibleText(row.text), wrap: true };
    case "action":
      return { stream: row.stream ?? row.action.stream ?? "stdout", ...displayAction(row.action) };
    case "activity":
      return {
        stream: row.stream ?? "stdout",
        text: `${row.observedWait ? "Waiting: " : ""}${visibleText(row.phase)} ${visibleText(row.identity)}${row.occurredAt === undefined ? "" : ` (${displayEvidence(row.occurredAt)})`}: ${visibleText(row.message)}`,
        wrap: true,
      };
  }
}

function wrapLine(text: string, columns: number | undefined): string[] {
  if (columns === undefined || columns <= 0 || unicodeCellWidth(text) <= columns) return [text];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const words = text.split(/ +/u);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    let piece = "";
    const pieces: string[] = [];
    for (const { segment } of segmenter.segment(word)) {
      const candidatePiece = `${piece}${segment}`;
      if (piece.length > 0 && unicodeCellWidth(candidatePiece) > columns) {
        pieces.push(piece);
        piece = segment;
      } else {
        piece = candidatePiece;
      }
    }
    if (piece.length > 0) pieces.push(piece);
    for (const [index, part] of pieces.entries()) {
      const candidate = line.length === 0 ? part : `${line}${index === 0 ? " " : ""}${part}`;
      if (line.length > 0 && unicodeCellWidth(candidate) > columns) {
        lines.push(line);
        line = part;
      } else {
        line = candidate;
      }
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

function wrapProse(
  text: string,
  columns: number | undefined,
  unicode: boolean,
  prefix: string,
): string[] {
  const prefixWidth = unicodeCellWidth(prefix);
  const available = columns === undefined ? undefined : columns - prefixWidth;
  const continuationPrefix = " ".repeat(prefixWidth);
  const lines: string[] = [];
  for (const sourceLine of text.split("\n")) {
    wrapLine(sourceLine, available).forEach((line, index) => {
      lines.push(`${index === 0 ? prefix : continuationPrefix}${line}`);
    });
  }
  return lines;
}

/** Render only supplied semantics; performs no I/O, environment reads, or domain classification. */
export function renderPresentation(
  document: PresentationDocument,
  capabilities: PresentationCapabilities,
): RenderedPresentation {
  const output: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  output.stdout.push(
    ...wrapProse(
      visibleText(document.title),
      capabilities.stdout.columns,
      capabilities.unicode,
      "",
    ),
  );
  for (const row of document.rows) {
    const rendered = displayRow(row, capabilities);
    const streamCapabilities = capabilities[rendered.stream];
    const styled =
      rendered.stream === "stdout" && row.kind === "section"
        ? paintTerminalText(rendered.text, { bold: true }, streamCapabilities)
        : rendered.text;
    output[rendered.stream].push(
      ...(rendered.wrap
        ? wrapProse(styled, streamCapabilities.columns, capabilities.unicode, "  ")
        : [styled]),
    );
  }
  return {
    stdout: output.stdout.length === 0 ? "" : `${output.stdout.join("\n")}\n`,
    stderr: output.stderr.length === 0 ? "" : `${output.stderr.join("\n")}\n`,
  };
}

/** Named render boundary; detail has already been applied by the pure projector. */
export function renderTerminal(
  document: PresentationDocument,
  context: PresentationContext,
): RenderedPresentation {
  return renderPresentation(document, context.capabilities);
}
