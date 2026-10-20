// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parse as parseYaml } from "yaml";

import type { LineRange, SourceOption } from "../contracts.js";
import { isBlank, type SourceLine } from "./lines.js";

/** Directives whose body is literal text, not Markdown; the reader never parses it as blocks. */
export const TEXT_BODY_DIRECTIVES: ReadonlySet<string> = new Set([
  "autoattribute",
  "autoclass",
  "autodata",
  "autodoc2-docstring",
  "autodoc2-object",
  "autodoc2-summary",
  "autoexception",
  "autofunction",
  "automethod",
  "automodule",
  "autosummary",
  "code-cell",
  "command-output",
  "csv-table",
  "digraph",
  "doctest",
  "eval-rst",
  "glossary",
  "graph",
  "graphviz",
  "highlight",
  "ipython",
  "jupyter-execute",
  "mermaid",
  "plantuml",
  "productionlist",
  "program-output",
  "raw",
  "spelling:word-list",
  "testcleanup",
  "testcode",
  "testoutput",
  "testsetup",
]);

export interface DirectiveContent {
  readonly options: SourceOption[];
  readonly body: SourceLine[];
}

export class DirectiveOptionsError extends Error {
  public constructor(
    message: string,
    public readonly line: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DirectiveOptionsError";
  }
}

const COLON_OPTION = /^[ \t]*:([A-Za-z0-9_][\w.+-]*):(?:[ \t]+(.*?))?[ \t]*$/u;

function optionFromYaml(name: string, value: unknown): SourceOption {
  if (value === null || value === undefined) return { name };
  if (typeof value === "string") return { name, value };
  if (typeof value === "number" || typeof value === "boolean")
    return { name, value: String(value) };
  return { name, value: JSON.stringify(value) };
}

/**
 * Split directive content into its option block and body. MyST accepts a
 * YAML block fenced by `---` lines or leading `:name: value` lines; one blank
 * line after the options is a separator, not body.
 */
export function splitDirectiveContent(content: readonly SourceLine[]): DirectiveContent {
  const options: SourceOption[] = [];
  let index = 0;
  if (content.length > 0 && content[0]!.text.trim() === "---") {
    const close = content.findIndex((line, at) => at > 0 && line.text.trim() === "---");
    if (close > 0) {
      const yaml = content
        .slice(1, close)
        .map((line) => line.text)
        .join("\n");
      let parsed: unknown;
      try {
        parsed = yaml.trim().length === 0 ? {} : parseYaml(yaml);
      } catch (error) {
        throw new DirectiveOptionsError(
          `The YAML option block does not parse: ${(error as Error).message.split("\n")[0]}.`,
          content[0]!.line,
          { cause: error },
        );
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new DirectiveOptionsError(
          "The YAML option block is not a mapping.",
          content[0]!.line,
        );
      }
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        options.push(optionFromYaml(name, value));
      }
      index = close + 1;
    }
  } else {
    while (index < content.length) {
      const match = COLON_OPTION.exec(content[index]!.text);
      if (!match) break;
      const name = match[1]!;
      let value = match[2];
      index += 1;
      while (
        index < content.length &&
        /^[ \t]+\S/u.test(content[index]!.text) &&
        !COLON_OPTION.test(content[index]!.text)
      ) {
        value =
          value === undefined
            ? content[index]!.text.trim()
            : `${value} ${content[index]!.text.trim()}`;
        index += 1;
      }
      options.push(value === undefined || value.length === 0 ? { name } : { name, value });
    }
  }
  if (options.length > 0 && index < content.length && isBlank(content[index]!.text)) index += 1;
  return { options, body: content.slice(index) };
}

/** Body lines with trailing blank lines removed, joined as text. */
export function bodyText(body: readonly SourceLine[]): string {
  let end = body.length;
  while (end > 0 && isBlank(body[end - 1]!.text)) end -= 1;
  let start = 0;
  while (start < end && isBlank(body[start]!.text)) start += 1;
  return body
    .slice(start, end)
    .map((line) => line.text)
    .join("\n");
}

/** Parse `1,3-5`; undefined when any part is not a closed range of positive integers. */
export function parseLineRanges(value: string | undefined): LineRange[] | undefined {
  if (value === undefined) return undefined;
  const ranges: LineRange[] = [];
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/u.exec(part);
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start) return undefined;
    ranges.push({ start, end });
  }
  return ranges.length > 0 ? ranges : undefined;
}

export function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d+\s*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 ? parsed : undefined;
}

/** Options by name, keeping the first occurrence; later duplicates stay in `rest`. */
export class OptionSet {
  private readonly byName = new Map<string, SourceOption>();
  private readonly consumed = new Set<SourceOption>();

  public constructor(private readonly options: readonly SourceOption[]) {
    for (const option of options)
      if (!this.byName.has(option.name)) this.byName.set(option.name, option);
  }

  public has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Take an option's value; a flag option yields an empty string. */
  public take(name: string): string | undefined {
    const option = this.byName.get(name);
    if (!option) return undefined;
    this.consumed.add(option);
    return option.value ?? "";
  }

  /** Take an option only when `accept` maps its value to a typed field. */
  public takeTyped<T>(
    name: string,
    accept: (value: string | undefined) => T | undefined,
  ): T | undefined {
    const option = this.byName.get(name);
    if (!option) return undefined;
    const typed = accept(option.value);
    if (typed !== undefined) this.consumed.add(option);
    return typed;
  }

  public rest(): SourceOption[] {
    return this.options.filter((option) => !this.consumed.has(option));
  }
}
