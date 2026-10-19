// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shell words that start a command naming no program to resolve. */
const SHELL_BUILTINS = new Set([
  ".",
  ":",
  "[",
  "[[",
  "alias",
  "builtin",
  "case",
  "cd",
  "command",
  "declare",
  "done",
  "echo",
  "esac",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fi",
  "for",
  "function",
  "getopts",
  "hash",
  "in",
  "let",
  "local",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readonly",
  "return",
  "select",
  "set",
  "shift",
  "shopt",
  "source",
  "test",
  "time",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unset",
  "wait",
  "}",
]);

/** Shell words that open a compound command; a command after them is guarded. */
const SHELL_PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
]);

/** A word that names a program with no shell expansion or quoting. */
const PROGRAM_WORD = /^(?=[^-])(?=.*[A-Za-z])[A-Za-z0-9_+./-]+$/u;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * The simple commands of shell text, split at `;`, `&`, `|`, `&&`, `||`,
 * parentheses, and line breaks outside quotes and `$(...)`; each is its words,
 * quotes and substitutions kept. `undefined` when a quote or substitution is
 * still open at the end, or a here-document starts: such text is not read as
 * commands.
 */
export function shellSimpleCommands(text: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | undefined;
  const endWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      word += char;
      if (char === "\\" && quote !== "'") word += text[++index] ?? "";
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\") {
      word += char + (text[++index] ?? "");
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      word += char;
      continue;
    }
    if (char === "$" && text[index + 1] === "(") {
      // A substitution stays inside its word: DocsFab does not read it as a command.
      let depth = 0;
      for (; index < text.length; index += 1) {
        word += text[index];
        if (text[index] === "(") depth += 1;
        else if (text[index] === ")" && --depth === 0) break;
      }
      if (depth > 0) return undefined;
      continue;
    }
    if (char === "#" && !word) {
      // A comment runs to the end of its line.
      while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
      continue;
    }
    if (char === "<" && text[index + 1] === "<") return undefined;
    // `>&`, `<&`, `&>`, and `>|` redirect; they do not separate commands.
    const previous = text[index - 1];
    if (
      ((char === "&" || char === "|") && (previous === ">" || previous === "<")) ||
      (char === "&" && text[index + 1] === ">")
    ) {
      word += char;
      continue;
    }
    if (";&|()\n".includes(char)) {
      endCommand();
      continue;
    }
    if (/\s/u.test(char)) {
      endWord();
      continue;
    }
    word += char;
  }
  if (quote) return undefined;
  endCommand();
  return commands;
}

/**
 * The words of shell text that is one simple command and nothing else
 * (#1918): no `;`, `&`, `|`, `&&`, `||`, parenthesis, line break,
 * here-document, or command substitution outside single quotes, so the
 * command's exit status is the text's. Redirections such as `2>&1` stay.
 * `undefined` otherwise.
 */
export function soleSimpleCommand(text: string): string[] | undefined {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(")) return undefined;
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if ("();\r\n".includes(char) || (char === "<" && next === "<")) return undefined;
    const previous = text[index - 1];
    // `>|`, `>&`, `<&`, and `&>` redirect; any other `|` or `&` joins commands.
    if (char === "|" && previous !== ">") return undefined;
    if (char === "&" && previous !== ">" && previous !== "<" && next !== ">") return undefined;
  }
  if (quote) return undefined;
  const commands = shellSimpleCommands(text);
  return commands?.length === 1 ? commands[0] : undefined;
}

/**
 * A simple command's program and arguments, with leading `NAME=value`
 * assignments and an `env`, `cross-env`, or `npx` prefix removed. `undefined`
 * when its program cannot be read without a shell (a builtin, a keyword that
 * opens a compound command, or a quoted or expanded word), when an option
 * follows a prefix, or when the command sets `PATH` for its program.
 */
export function commandWords(
  words: readonly string[],
): { readonly words: readonly string[]; readonly npx: boolean } | undefined {
  let index = 0;
  let npx = false;
  for (;;) {
    while (index < words.length && ASSIGNMENT_WORD.test(words[index]!)) {
      if (words[index]!.startsWith("PATH=")) return undefined;
      index += 1;
    }
    const word = words[index];
    if (word === "env" || word === "cross-env" || word === "npx") {
      npx ||= word === "npx";
      index += 1;
      if (words[index]?.startsWith("-")) return undefined;
      continue;
    }
    break;
  }
  const command = words.slice(index);
  const program = command[0];
  if (
    !program ||
    SHELL_BUILTINS.has(program) ||
    SHELL_PREFIX_KEYWORDS.has(program) ||
    !PROGRAM_WORD.test(program)
  ) {
    return undefined;
  }
  return { words: command, npx };
}

/**
 * The words of a package script's first command, when that command's failure
 * would be the script's (#1918): the script is that one simple command, or
 * that command followed by `&&`, with no `||`, `;`, `&`, or line break after
 * it. Leading `NAME=value` assignments and an `env`, `cross-env`, or `npx`
 * prefix are removed. `undefined` when the command is guarded, its status can
 * be replaced, or its program cannot be read without a shell.
 */
export function scriptFirstCommand(body: string): readonly string[] | undefined {
  let quote: string | undefined;
  let split = body.length;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "&" && body[index + 1] === "&") {
      split = index;
      break;
    }
  }
  const rest = body.slice(split + 2);
  if (split < body.length && !soleCommandTail(rest)) return undefined;
  const first = soleSimpleCommand(body.slice(0, split));
  return first ? commandWords(first)?.words : undefined;
}

/**
 * Whether shell text after `&&` keeps a failure before it as the script's
 * status: no `||`, `;`, `&`, or line break outside single quotes.
 */
function soleCommandTail(text: string): boolean {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (";\r\n".includes(char)) return false;
    if (char === "|" && text[index + 1] === "|") return false;
    const previous = text[index - 1];
    if (
      char === "&" &&
      text[index + 1] !== "&" &&
      previous !== "&" &&
      previous !== ">" &&
      previous !== "<" &&
      text[index + 1] !== ">"
    ) {
      return false;
    }
  }
  return quote === undefined;
}
