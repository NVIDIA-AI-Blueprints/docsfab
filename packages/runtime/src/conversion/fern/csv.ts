// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeNewlines } from "./escape.js";

export type CsvParse = { ok: true; rows: string[][] } | { ok: false; reason: string };

/**
 * RFC 4180 records with `"` quoting and doubled quotes, as `csv-table` reads
 * them: spaces after a delimiter are skipped and blank lines hold no record.
 */
export function parseCsv(source: string, delimiter: string): CsvParse {
  const text = normalizeNewlines(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let index = 0;
  const endField = (): void => {
    row.push(field);
    field = "";
    quoted = false;
    fieldStarted = false;
  };
  const endRow = (): void => {
    if (row.length > 0 || fieldStarted || field !== "") endField();
    if (row.length > 0) rows.push(row);
    row = [];
  };
  while (index < text.length) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        quoted = false;
        const next = text[index + 1];
        if (next !== undefined && next !== delimiter && next !== "\n") {
          return {
            ok: false,
            reason: `Text follows a closing quote in record ${rows.length + 1}.`,
          };
        }
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      fieldStarted = true;
      index += 1;
      while (text[index] === " " && delimiter !== " ") index += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      fieldStarted = true;
      index += 1;
      continue;
    }
    if (char === " " && field === "" && !fieldStarted && row.length === 0) {
      index += 1;
      continue;
    }
    field += char;
    fieldStarted = true;
    index += 1;
  }
  if (quoted) return { ok: false, reason: `Record ${rows.length + 1} has an unclosed quote.` };
  endRow();
  return { ok: true, rows };
}

/** The `:delim:` option: one character, or the names `tab` and `space`. */
export function csvDelimiter(option: string | undefined): string | undefined {
  if (option === undefined) return ",";
  if (option === "tab") return "\t";
  if (option === "space") return " ";
  return [...option].length === 1 ? option : undefined;
}
