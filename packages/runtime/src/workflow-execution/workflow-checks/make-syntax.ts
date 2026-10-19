// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { commandWords, soleSimpleCommand } from "./shell-syntax.js";

/** The makefile names GNU make reads, in its order. */
export const DEFAULT_MAKEFILES = ["GNUmakefile", "makefile", "Makefile"] as const;
/** Functions a dry run still expands, with side effects or output, and recursion. */
const MAKE_DRY_RUN_FUNCTIONS =
  /\$[({](?:shell|info|warning|error|eval|file|guile|MAKE|MAKE_COMMAND)(?=[\s)}])/u;
/** Variables that tell a makefile it is in a dry run, or which goals were asked for. */
const MAKE_MODE_VARIABLES = /\b(?:MAKEFLAGS|MFLAGS|MAKECMDGOALS|MAKELEVEL|MAKEOVERRIDES)\b/u;
/** Variables that change the program a recipe line starts, or how its status counts. */
const MAKE_RECIPE_VARIABLES = new Set(["PATH", "SHELL", ".SHELLFLAGS", ".RECIPEPREFIX"]);
/** A standard shell, possibly through `env`, with options; it runs one simple command as `sh` does. */
const STANDARD_SHELL =
  /^(?:\/usr\/bin\/env\s+)?(?:(?:\/usr)?\/bin\/)?(?:ba|da)?sh(?:\s+-[A-Za-z]+(?:\s+[a-z]+)?)*$/u;
/** Shell options that end with `-c`, such as `-eu -o pipefail -c`. */
const STANDARD_SHELLFLAGS = /^(?:-[A-Za-z]+(?:\s+[a-z]+)?\s+)*-[A-Za-z]*c$/u;

/**
 * A TAB-led line, without its TAB and `@` prefixes, that GNU make may read as
 * a directive, as an assignment that changes what a recipe runs, or as a
 * shell or computed-name assignment. DocsFab cannot tell which branch of a
 * conditional make takes, so it cannot be sure a TAB-led line is a recipe
 * line; it reads no dry run when such a line appears anywhere (#1918).
 */
const MAKE_DIRECTIVE_LIKE =
  /^(?:-?(?:s?include|load)|define|endef|undefine|export|unexport|override|private|vpath)(?:\s|$)|(?:^|[\s:;])(?:PATH|SHELL|\.SHELLFLAGS|\.RECIPEPREFIX)\s*(?::{1,3}=|[+?!]?=)|^(?:(?:export|unexport|override|private)\s+)*(?:[A-Za-z_.][\w.-]*\s*!=|\S*\$\S*\s*(?::{1,3}=|[+?!]?=))/u;

/** Text with `$(...)` and `${...}` references removed, for reading make syntax. */
function withoutMakeReferences(text: string): string {
  let out = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "$" && (text[index + 1] === "(" || text[index + 1] === "{")) {
      depth += 1;
      index += 1;
      continue;
    }
    if (depth > 0) {
      if (char === "(" || char === "{") depth += 1;
      else if (char === ")" || char === "}") depth -= 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Why a make dry run would not show what the real run does (#1918), or
 * `undefined` when it would. GNU make's dry run still executes `$(MAKE)` and
 * `+` lines and expands `$(shell)`, `$(info)`, and the like, a `-` prefix and
 * guards hide which command decides the status, and target-specific
 * variables, `.ONESHELL`, and `PATH` changes change what a recipe line runs.
 * The makefile must hold none of them, and no `include`, `define`, `!=`, or
 * rule that remakes the makefile itself, whose effects DocsFab does not read.
 * A TAB-led line outside a rule's context is makefile syntax, as GNU make
 * reads it, so it is held to the same checks.
 */
export function makefileDryRunBlocker(text: string): string | undefined {
  if (MAKE_DRY_RUN_FUNCTIONS.test(text)) return "a function a dry run executes or prints";
  if (MAKE_MODE_VARIABLES.test(text)) return "a variable that reveals the dry run or its goals";
  // As GNU make reads it, a TAB-led line is a recipe line only in a rule's
  // context: after a rule line, until a line that is not blank, a comment, or
  // a conditional. Any other TAB-led line is makefile syntax. This guess does
  // not know which branch of a conditional make takes, so a TAB-led line with
  // a `-` or `+` prefix, or shaped like a directive, is not read in any context.
  let inRule = false;
  for (const line of text.replace(/\\\r?\n/gu, " ").split(/\r?\n/u)) {
    if (line.startsWith("\t")) {
      if (/^\t[ \t@+-]*[+-]/u.test(line)) return "a recipe line with a `-` or `+` prefix";
      if (MAKE_DIRECTIVE_LIKE.test(line.replace(/^\t[ \t@]*/u, ""))) {
        return "a TAB-led line make may read as a directive";
      }
      if (inRule) continue;
    }
    const code = withoutMakeReferences(line.replace(/(^|[^\\])#.*$/u, "$1")).trim();
    if (!code) continue;
    const words = code.split(/\s+/u);
    if (/^(?:ifeq|ifneq|ifdef|ifndef|else|endif)$/u.test(words[0]!)) continue;
    inRule = false;
    // A search path for prerequisites; its colons separate directories, not a rule.
    if (words[0] === "vpath") continue;
    if (/^-?(?:s?include|load)$/u.test(words[0]!)) return "a makefile DocsFab does not read";
    if (/^(?:(?:export|override|private)\s+)?(?:define|endef)\b/u.test(code)) {
      return "a multi-line variable";
    }
    if (/^\.(?:ONESHELL|IGNORE)\b/u.test(code)) return "a special target that changes recipes";
    const assignment = /(::?:?=|[+?!]?=)/u.exec(code);
    const colon = /:(?!:?:?=)/u.exec(code);
    if (colon && (!assignment || colon.index < assignment.index)) {
      // A rule line.
      const targets = code.slice(0, colon.index).split(/\s+/u);
      if (targets.some((target) => (DEFAULT_MAKEFILES as readonly string[]).includes(target))) {
        return "a rule that remakes the makefile";
      }
      const rest = code.slice(colon.index + 1);
      if (rest.includes("=")) return "a target-specific variable";
      if (rest.includes(";")) return "a recipe on its rule line";
      inRule = true;
      continue;
    }
    if (assignment) {
      if (assignment[1] === "!=") return "a variable a shell command sets";
      const name = code
        .slice(0, assignment.index)
        .trim()
        .split(/\s+/u)
        .filter((word) => !/^(?:export|unexport|override|private)$/u.test(word))
        .join(" ");
      const value = code.slice(assignment.index + assignment[1]!.length).trim();
      const standard =
        (name === "SHELL" && STANDARD_SHELL.test(value)) ||
        (name === ".SHELLFLAGS" && STANDARD_SHELLFLAGS.test(value));
      if (!name || /[$\s]/u.test(name) || (MAKE_RECIPE_VARIABLES.has(name) && !standard)) {
        return "a variable that changes what a recipe runs";
      }
      continue;
    }
    if (
      /^(?:(?:override|private)\s+)*(?:export|unexport|undefine)\s+(?:\S+\s+)*PATH(?:\s|$)/u.test(
        code,
      )
    ) {
      return "a variable that changes what a recipe runs";
    }
  }
  return undefined;
}

/**
 * The one command a GNU make dry run (`--dry-run --trace <goal>`) lists for
 * `goal` (#1918): exactly `goal`'s trace line, then one line that is a sole
 * simple command. `undefined` for any other listing, such as a prerequisite's
 * recipe, a second recipe line, parse-time text, or a make message.
 */
export function makeDryRunSoleCommand(
  output: string,
  goal: string,
): { readonly words: readonly string[]; readonly npx: boolean } | undefined {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2) return undefined;
  const trace =
    /^(?:GNUmakefile|makefile|Makefile):\d+: (?:target '(.+)' does not exist|update target '(.+)' due to: .*)$/u.exec(
      lines[0]!,
    );
  if (!trace || (trace[1] ?? trace[2]) !== goal) return undefined;
  const words = soleSimpleCommand(lines[1]!);
  return words ? commandWords(words) : undefined;
}
