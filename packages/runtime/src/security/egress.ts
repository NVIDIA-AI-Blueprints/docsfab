// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  findConfiguredCredential,
  findConfiguredCredentialInValue,
} from "./configured-credentials.js";
import { inspectCredentialMetadata } from "./credential-material.js";

export type HostRootKind = "workspace" | "state" | "home" | "tmp" | "config" | "other";

export interface HostRoot {
  readonly kind: HostRootKind;
  readonly path: string;
}

interface HostRootVariant {
  readonly text: string;
  readonly kind: HostRootKind;
  /** A percent-encoded URI form, whose hex digits match in either case. */
  readonly encoded: boolean;
}

/** Built only by `hostRootSet`; variants are ordered longest first. */
export interface HostRootSet {
  readonly variants: readonly HostRootVariant[];
  readonly kindOf: ReadonlyMap<string, HostRootKind>;
  readonly pattern: RegExp | undefined;
  /** Sticky and without the left boundary: a root that a separator run leads to. */
  readonly nested: RegExp | undefined;
}

export interface HostRootSetOptions {
  readonly platform?: NodeJS.Platform;
  /**
   * True for a declared public root (see `publicRootPredicate`). A public root,
   * the workspace included, is left as written.
   */
  readonly isPublic?: (path: string) => boolean;
}

export type EgressCredentialCode = "credential-material";

export type EgressResult =
  | { readonly ok: true; readonly text: string; readonly replaced: readonly HostRootKind[] }
  | { readonly ok: false; readonly code: EgressCredentialCode };

/** Two object keys that differ only by a host root would merge after replacement. */
export type EgressKeyCollisionCode = "egress-key-collision";

/**
 * The credential screen cannot walk the value: a cycle, accessor, symbol key,
 * sparse array, non-plain object such as a Map or Date, or a size over its cap.
 */
export type EgressUnwalkableCode = "egress-unwalkable-value";

export type EgressValueRefusalCode =
  | EgressCredentialCode
  | EgressKeyCollisionCode
  | EgressUnwalkableCode;

export type EgressValueResult<T> =
  | { readonly ok: true; readonly value: T; readonly replaced: readonly HostRootKind[] }
  | { readonly ok: false; readonly code: EgressValueRefusalCode };

const CREDENTIAL_CODE: EgressCredentialCode = "credential-material";
const KEY_COLLISION_CODE: EgressKeyCollisionCode = "egress-key-collision";
const UNWALKABLE_CODE: EgressUnwalkableCode = "egress-unwalkable-value";
const FILE_SCHEME = "file://";
const LOCALHOST_PREFIX = "file://localhost/";
/** Identical on every host, so never a root even when a caller passes one. */
const GENERIC_ROOTS: ReadonlySet<string> = new Set([
  "/tmp",
  "/var/tmp",
  "/private/tmp",
  "/private/var/tmp",
]);

/** Plain text that Markdown renderers and Slack show as written. */
const PLACEHOLDERS: Readonly<Record<Exclude<HostRootKind, "workspace">, string>> = {
  state: "$DOCSFAB_STATE_DIR",
  home: "~",
  tmp: "$TMPDIR",
  config: "$DOCSFAB_CONFIG_ROOT",
  other: "$HOST_PATH",
};

/**
 * ASCII only: a non-ASCII letter glued to a root (`位于/Users/alice`) must not
 * hide it. Over-replacing a non-ASCII sibling name is the accepted cost.
 */
const NAME_CHARACTERS = "A-Za-z0-9_~@+%.-";
const PATH_NAME_CHARACTER = `[${NAME_CHARACTERS}]`;
/** A root must not continue a name on its left; `replaceRoots` checks a separator there. */
const LEFT_BOUNDARY = `(?<![${NAME_CHARACTERS}])`;
/**
 * A root ends at a separator, the end, or a character that cannot continue a
 * path name. Dots end it only as punctuation, so `/tmp.` and `/tmp...` match
 * and `/abs/checkout.git` does not.
 */
const RIGHT_BOUNDARY = `(?=$|[/\\\\]|\\.+(?!${PATH_NAME_CHARACTER})|[^${NAME_CHARACTERS}])`;
/** The separators and `.` segments between a root and what follows it. */
const SEPARATOR_RUN = /[/\\](?:\.?[/\\])*/y;
const NAME_START = new RegExp(`^${PATH_NAME_CHARACTER}`, "u");

/** Expand this host's roots into the exact strings that can name them in text. */
export function hostRootSet(
  roots: readonly HostRoot[],
  options: HostRootSetOptions = {},
): HostRootSet {
  const platform = options.platform ?? process.platform;
  const byText = new Map<string, HostRootVariant>();
  for (const root of roots) {
    for (const { text, encoded } of rootVariants(root, platform, options.isPublic)) {
      if (!byText.has(text)) byText.set(text, { text, kind: root.kind, encoded });
    }
  }
  const variants = [...byText.values()].sort((left, right) => right.text.length - left.text.length);
  const kindOf = new Map(variants.map(({ text, kind }) => [text, kind]));
  const alternatives = `(${variants.map(variantPattern).join("|")})${RIGHT_BOUNDARY}`;
  const empty = variants.length === 0;
  return Object.freeze({
    variants: Object.freeze(variants),
    kindOf,
    pattern: empty ? undefined : new RegExp(`${LEFT_BOUNDARY}${alternatives}`, "gu"),
    nested: empty ? undefined : new RegExp(alternatives, "uy"),
  });
}

/**
 * Refuse outbound text that holds one of DocsFab's own configured credentials,
 * then replace this host's roots. Text that only looks like a credential is
 * published (#1807). A refusal carries only the code, never the matched text.
 */
export function egressText(text: string, roots: HostRootSet): EgressResult {
  if (findConfiguredCredential(text)) return { ok: false, code: CREDENTIAL_CODE };
  const replaced = new Set<HostRootKind>();
  const output = replaceRoots(text, roots, replaced);
  return { ok: true, text: output, replaced: [...replaced] };
}

/**
 * `egressText` over every string and object key inside a JSON-like value. A
 * structure the metadata walk cannot inspect safely is refused before any
 * credential match.
 */
export function egressValue<T>(value: T, roots: HostRootSet): EgressValueResult<T> {
  if (inspectCredentialMetadata(value).unsafeStructure) return { ok: false, code: UNWALKABLE_CODE };
  if (findConfiguredCredentialInValue(value)) return { ok: false, code: CREDENTIAL_CODE };
  const replaced = new Set<HostRootKind>();
  let collided = false;
  const visit = (candidate: unknown): unknown => {
    if (collided) return candidate;
    if (typeof candidate === "string") return replaceRoots(candidate, roots, replaced);
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!isPlainObject(candidate)) return candidate;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate)) {
      const outputKey = replaceRoots(key, roots, replaced);
      collided ||= Object.hasOwn(output, outputKey);
      if (collided) return candidate;
      Object.defineProperty(output, outputKey, {
        value: visit(child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  };
  const output = visit(value) as T;
  if (collided) return { ok: false, code: KEY_COLLISION_CODE };
  return { ok: true, value: output, replaced: [...replaced] };
}

function replaceRoots(text: string, roots: HostRootSet, replaced: Set<HostRootKind>): string {
  const { pattern } = roots;
  if (!pattern) return text;
  let output = "";
  let cursor = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    // A root after a separator continues a longer path. `replaceChain` takes the
    // roots that a replaced root's separator run leads to.
    if (match.index > 0 && isSeparator(text[match.index - 1])) continue;
    const chain = replaceChain(text, match.index, match[1]!, roots, replaced);
    output += text.slice(cursor, match.index) + chain.text;
    cursor = chain.end;
    pattern.lastIndex = chain.end;
  }
  return output + text.slice(cursor);
}

/**
 * Replace the root at `start` and each root joined to it, as in
 * `${root}//${absolutePath}` or `${root}/~user`. A separator run reads as one
 * separator, or as a doubled one when it holds two or more separators besides
 * its `.` segments, so `///` and `/.//` read as `//` and `/./` as `/`.
 */
function replaceChain(
  text: string,
  start: number,
  first: string,
  roots: HostRootSet,
  replaced: Set<HostRootKind>,
): { readonly text: string; readonly end: number } {
  let output = "";
  let root = first;
  let end = start + root.length;
  for (;;) {
    const kind = roots.kindOf.get(root) ?? roots.kindOf.get(canonicalUri(root)) ?? "other";
    replaced.add(kind);
    SEPARATOR_RUN.lastIndex = end;
    const run = SEPARATOR_RUN.exec(text)?.[0] ?? "";
    const separator = run.charAt(0);
    const dots = run.length - run.replaceAll(".", "").length;
    const doubled = run.length - 2 * dots >= 2;
    const next =
      run === ""
        ? undefined
        : ((doubled ? nestedRootAt(text, end + run.length - 1, roots) : undefined) ??
          nestedRootAt(text, end + run.length, roots));
    if (next) {
      output +=
        kind === "workspace" ? (doubled ? `.${separator}` : "") : PLACEHOLDERS[kind] + separator;
      root = next.root;
      end = next.start + root.length;
      continue;
    }
    if (run !== "" && NAME_START.test(text.slice(end + run.length, end + run.length + 1))) {
      output += kind === "workspace" ? "" : PLACEHOLDERS[kind] + separator;
      return { text: output, end: end + run.length };
    }
    if (kind !== "workspace") output += PLACEHOLDERS[kind];
    // Before a sentence's final period, `./.` cannot read as the parent `..`.
    else output += text[end] === "." ? "./" : ".";
    return { text: output, end };
  }
}

function nestedRootAt(
  text: string,
  start: number,
  roots: HostRootSet,
): { readonly root: string; readonly start: number } | undefined {
  if (!roots.nested) return undefined;
  roots.nested.lastIndex = start;
  const root = roots.nested.exec(text)?.[1];
  return root === undefined ? undefined : { root, start };
}

function isSeparator(character: string | undefined): boolean {
  return character === "/" || character === "\\";
}

function rootVariants(
  root: HostRoot,
  platform: NodeJS.Platform,
  isPublic: ((path: string) => boolean) | undefined,
): { readonly text: string; readonly encoded: boolean }[] {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  if (!root.path || !pathApi.isAbsolute(root.path)) return [];
  const logical = stripTrailingSeparators(pathApi.normalize(root.path), pathApi);
  // A realpath is only meaningful on the platform whose filesystem is present.
  const physical = platform === process.platform ? realpathOrAncestor(logical, pathApi) : undefined;
  // Each form is declared on its own: declaring a symlink's target leaves the link replaced.
  const bases = [logical, physical].filter(
    (candidate): candidate is string =>
      candidate !== undefined &&
      candidate !== pathApi.parse(candidate).root &&
      !GENERIC_ROOTS.has(candidate) &&
      !isPublic?.(candidate),
  );
  const variants: { text: string; encoded: boolean }[] = [];
  for (const base of bases) {
    const forward = windows ? base.replaceAll("\\", "/") : base;
    // RFC 8089 names the local host as `file:///p` or `file://localhost/p`.
    const uriPath = forward.replace(/^\/?/u, "");
    const encodedPath = pathToFileURL(base, { windows })
      .href.slice("file:///".length)
      .replace(/\/$/u, "");
    variants.push({ text: base, encoded: false }, { text: forward, encoded: false });
    for (const authority of ["", "localhost"]) {
      variants.push(
        { text: `file://${authority}/${uriPath}`, encoded: false },
        { text: `file://${authority}/${encodedPath}`, encoded: true },
      );
    }
  }
  if (root.kind === "home" && bases.includes(logical)) {
    // `~user` names this host's account; a bare `~` names no host and stays.
    variants.push({ text: `~${pathApi.basename(logical)}`, encoded: false });
  }
  return variants;
}

function stripTrailingSeparators(value: string, pathApi: path.PlatformPath): string {
  const root = pathApi.parse(value).root;
  let end = value.length;
  while (end > root.length && (value[end - 1] === "/" || value[end - 1] === pathApi.sep)) end -= 1;
  return value.slice(0, end);
}

/** A missing leaf still resolves through its nearest existing ancestor. */
function realpathOrAncestor(value: string, pathApi: path.PlatformPath): string | undefined {
  try {
    return realpathSync.native(value);
  } catch {
    const parent = pathApi.dirname(value);
    if (parent === value) return undefined;
    const resolved = realpathOrAncestor(parent, pathApi);
    return resolved === undefined ? undefined : pathApi.join(resolved, pathApi.basename(value));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** URI parts that match in either case: the scheme, `localhost`, and percent-hex digits. */
function canonicalUri(text: string): string {
  return text
    .replace(/^file:\/\/(?:localhost\/)?/iu, (prefix) => prefix.toLowerCase())
    .replace(/%[0-9a-f]{2}/giu, (octet) => octet.toUpperCase());
}

function variantPattern({ text, encoded }: HostRootVariant): string {
  let escaped = escapeRegExp(text);
  if (text.startsWith(FILE_SCHEME)) {
    const prefix = text.startsWith(LOCALHOST_PREFIX) ? LOCALHOST_PREFIX : FILE_SCHEME;
    escaped = `${escapeRegExp(prefix).replace(/[a-z]/gu, anyCase)}${escaped.slice(escapeRegExp(prefix).length)}`;
  }
  if (!encoded) return escaped;
  return escaped.replace(/%[0-9A-F]{2}/gu, (octet) =>
    octet.replace(/[A-F]/gu, (digit) => `[${digit}${digit.toLowerCase()}]`),
  );
}

function anyCase(letter: string): string {
  return `[${letter}${letter.toUpperCase()}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}
