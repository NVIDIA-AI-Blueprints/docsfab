// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The constrained YAML subset the dependency-free catalog generators read.
 *
 * `runtime:derived:preflight` runs the catalog generators before `npm ci`, so
 * they cannot rely on the npm `yaml` package. Each generator prefers that
 * package and falls back to this parser, which reads only a small, explicit
 * subset and refuses everything else rather than guessing:
 *
 * - comments and blank lines;
 * - block mappings whose keys are identifiers or contract locations
 *   (`$.field[]`);
 * - block lists of scalars or of mappings, including a mapping whose first key
 *   holds a block scalar or a nested collection;
 * - plain scalars (`true`, `false`, `null`, `~`, decimal integers, and text);
 * - folded (`>`, `>-`) and literal (`|`, `|-`) block scalars;
 * - the empty flow collections `[]` and `{}`.
 *
 * Anything the npm `yaml` parser (YAML 1.2 core schema) could read differently
 * is refused rather than guessed: quoted scalars, non-empty flow collections,
 * anchors, aliases, tags, tabs, a comment where a value belongs, other
 * spellings of booleans and null, floats and non-decimal numbers, a plain
 * scalar containing `: ` or ending in `:`, keep (`+`) chomping, more-indented
 * lines in a folded scalar, and trailing whitespace in a block scalar. Every
 * error names the source file and line.
 */

const KEY_PATTERN = /^([$A-Za-z][A-Za-z0-9_.$[\]-]*):(?:\s+(.*))?$/u;
const BLOCK_SCALAR_STYLES = new Set([">", ">-", "|", "|-"]);

/**
 * Parse `text` from `source` (a repository-relative name used in errors).
 *
 * @param {string} text
 * @param {string} source
 * @returns {unknown}
 */
export function parseYamlSubset(text, source) {
  if (text.includes("\t")) {
    throw new Error(`${source}: tabs are not in the preflight subset`);
  }
  const parser = new SubsetParser(text.split(/\r?\n/u), source);
  const first = parser.nextSignificant(0);
  if (first === null) return null;
  const parsed = parser.parseMapping(first, parser.indentOf(first));
  if (parsed.next < parser.lines.length && parser.nextSignificant(parsed.next) !== null) {
    throw new Error(`${source}: unsupported trailing syntax at line ${parsed.next + 1}`);
  }
  return parsed.value;
}

class SubsetParser {
  constructor(lines, source) {
    this.lines = lines;
    this.source = source;
  }

  fail(message, index) {
    throw new Error(`${this.source}: ${message} at line ${index + 1}`);
  }

  nextSignificant(index) {
    for (let cursor = index; cursor < this.lines.length; cursor += 1) {
      const trimmed = this.lines[cursor].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      return cursor;
    }
    return null;
  }

  indentOf(index) {
    const raw = this.lines[index];
    return raw.length - raw.trimStart().length;
  }

  splitKeyValue(trimmed, index) {
    const match = KEY_PATTERN.exec(trimmed);
    if (!match) this.fail("expected key: value", index);
    const value = match[2] ?? "";
    return { key: match[1], value, hasValue: value.length > 0 };
  }

  decodeScalar(raw, index) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null" || raw === "~") return null;
    if (raw === "[]") return [];
    if (raw === "{}") return {};
    if (/^-?\d+$/u.test(raw)) return Number(raw);
    if (
      // Indicators a plain scalar cannot start with, or that change its meaning.
      /^['"[\]{}&*!|>%@`#,]/u.test(raw) ||
      /^[-?:](?:\s|$)/u.test(raw) ||
      raw.includes(" #") ||
      raw.includes(": ") ||
      raw.endsWith(":") ||
      // Core-schema spellings the subset does not decode.
      /^(?:true|false|null|y|yes|n|no|on|off)$/iu.test(raw) ||
      /^[-+]?(?:\.\d+|\d+\.\d*|\d+(?:\.\d*)?[eE][-+]?\d+)$/u.test(raw) ||
      /^[-+]?\.(?:inf|nan)$/iu.test(raw) ||
      /^\+\d+$/u.test(raw) ||
      /^0[xo]/iu.test(raw)
    ) {
      this.fail("unsupported scalar", index);
    }
    return raw;
  }

  /** The value of `key` whose text starts at line `index` with `value` after the colon. */
  parseValue(value, hasValue, index, indent, key) {
    if (hasValue && BLOCK_SCALAR_STYLES.has(value)) {
      return this.parseBlockScalar(index + 1, indent, value);
    }
    if (hasValue) return { value: this.decodeScalar(value, index), next: index + 1 };
    const nestedAt = this.nextSignificant(index + 1);
    if (nestedAt === null || this.indentOf(nestedAt) <= indent) {
      this.fail(`missing value for ${key}`, index);
    }
    const nestedIndent = this.indentOf(nestedAt);
    return this.lines[nestedAt].trim().startsWith("- ")
      ? this.parseList(nestedAt, nestedIndent)
      : this.parseMapping(nestedAt, nestedIndent);
  }

  parseMapping(start, indent, into = {}) {
    const mapping = into;
    let index = start;
    while (index < this.lines.length) {
      const significant = this.nextSignificant(index);
      if (significant === null) return { value: mapping, next: this.lines.length };
      const currentIndent = this.indentOf(significant);
      if (currentIndent < indent) return { value: mapping, next: significant };
      if (currentIndent !== indent) this.fail("unexpected indent", significant);
      const trimmed = this.lines[significant].trim();
      if (trimmed.startsWith("- ") || trimmed === "-") {
        this.fail("unexpected list item", significant);
      }
      const { key, value, hasValue } = this.splitKeyValue(trimmed, significant);
      if (Object.hasOwn(mapping, key)) this.fail(`repeated key ${key}`, significant);
      const parsed = this.parseValue(value, hasValue, significant, indent, key);
      mapping[key] = parsed.value;
      index = parsed.next;
    }
    return { value: mapping, next: index };
  }

  parseList(start, indent) {
    const list = [];
    let index = start;
    while (index < this.lines.length) {
      const significant = this.nextSignificant(index);
      if (significant === null) return { value: list, next: this.lines.length };
      const currentIndent = this.indentOf(significant);
      if (currentIndent < indent) return { value: list, next: significant };
      if (currentIndent !== indent) this.fail("unexpected indent", significant);
      const trimmed = this.lines[significant].trim();
      if (!trimmed.startsWith("- ")) this.fail("expected a list item", significant);
      const rest = trimmed.slice(2).trim();
      if (KEY_PATTERN.test(rest)) {
        const { key, value, hasValue } = this.splitKeyValue(rest, significant);
        const item = {};
        const first = this.parseValue(value, hasValue, significant, indent + 2, key);
        item[key] = first.value;
        const fields = this.parseMapping(first.next, indent + 2, item);
        list.push(fields.value);
        index = fields.next;
        continue;
      }
      list.push(this.decodeScalar(rest, significant));
      index = significant + 1;
    }
    return { value: list, next: index };
  }

  parseBlockScalar(start, parentIndent, style) {
    // Content starts at the first non-blank line. A line that starts with `#`
    // is content here, not a comment, as in YAML.
    let contentAt = start;
    while (contentAt < this.lines.length && this.lines[contentAt].trim() === "") contentAt += 1;
    if (contentAt >= this.lines.length || this.indentOf(contentAt) <= parentIndent) {
      this.fail("empty block scalar", Math.min(contentAt, this.lines.length) - 1);
    }
    const contentIndent = this.indentOf(contentAt);
    const chunks = [];
    let index = contentAt;
    while (index < this.lines.length) {
      const raw = this.lines[index];
      if (raw.trim() === "") {
        let look = index + 1;
        while (look < this.lines.length && this.lines[look].trim() === "") look += 1;
        if (look >= this.lines.length || this.indentOf(look) < contentIndent) break;
        chunks.push("");
        index += 1;
        continue;
      }
      if (this.indentOf(index) < contentIndent) break;
      if (raw !== raw.trimEnd()) this.fail("trailing whitespace in a block scalar", index);
      if (style.startsWith(">") && this.indentOf(index) > contentIndent) {
        this.fail("a more-indented line in a folded scalar", index);
      }
      chunks.push(raw.slice(contentIndent));
      index += 1;
    }
    let text;
    if (style.startsWith(">")) {
      // Folding: adjacent lines join with a space; each blank line between two
      // lines becomes one line break.
      text = "";
      let blanks = 0;
      for (const chunk of chunks) {
        if (chunk === "") {
          blanks += 1;
          continue;
        }
        if (text !== "") text += blanks > 0 ? "\n".repeat(blanks) : " ";
        text += chunk;
        blanks = 0;
      }
    } else {
      text = chunks.join("\n");
    }
    // Clip chomping (`>` and `|`) keeps exactly one final line break.
    if (!style.endsWith("-")) text += "\n";
    return { value: text, next: index };
  }
}
