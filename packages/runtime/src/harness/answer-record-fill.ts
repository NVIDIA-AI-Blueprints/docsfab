// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical locations and the one host-minted fill for records-mode
 * contracts (closed-schema-answer-records-decision.md §1.4, "Generated fill").
 *
 * Kept apart from the records core so the text path's fill
 * (`evaluation-target.ts`) loads only the generated declaration table: this
 * module reads no limit, catalog hint, or host file when it loads.
 */

import type { AnswerRecordContractDeclaration } from "../contracts/model-output.generated.js";

/** A DocsFab defect in a declaration, a host input, or a caller; never model content. */
export class AnswerRecordHostError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnswerRecordHostError";
  }
}

export function hostDefect(message: string): never {
  throw new AnswerRecordHostError(message);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type Segment =
  | { readonly prop: string }
  | { readonly any: true }
  | { readonly selector: string }
  | { readonly items: true };
export type ConcretePath = readonly (string | number)[];

const LOCATION_SEGMENT = /\.(?:[A-Za-z_][A-Za-z0-9_]*|\*|\{[a-z][a-z0-9-]*\})|\[\]/gu;

export function parseRecordLocation(location: string): Segment[] {
  const body = location.startsWith("$") ? location.slice(1) : "";
  const segments = body.match(LOCATION_SEGMENT) ?? [];
  if (!location.startsWith("$.") || segments.join("") !== body) {
    hostDefect(`${location} is not a canonical location.`);
  }
  return segments.map((segment): Segment => {
    if (segment === "[]") return { items: true };
    const name = segment.slice(1);
    if (name === "*") return { any: true };
    if (name.startsWith("{")) return { selector: name.slice(1, -1) };
    return { prop: name };
  });
}

/** Every existing instance of `segments` in `root` whose parent exists, with its concrete path. */
export function instances(
  root: Record<string, unknown>,
  segments: readonly Segment[],
  selectors: Readonly<Record<string, readonly string[]>>,
): ConcretePath[] {
  let frontier: { node: unknown; path: (string | number)[] }[] = [{ node: root, path: [] }];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const last = index === segments.length - 1;
    const next: { node: unknown; path: (string | number)[] }[] = [];
    for (const { node, path } of frontier) {
      if ("items" in segment) {
        if (Array.isArray(node))
          node.forEach((item, position) => next.push({ node: item, path: [...path, position] }));
      } else if (isObject(node)) {
        const names =
          "prop" in segment
            ? [segment.prop]
            : "selector" in segment
              ? (
                  selectors[segment.selector] ??
                  hostDefect(`Selector {${segment.selector}} has no resolved members.`)
                ).filter((name) => Object.hasOwn(node, name))
              : Object.keys(node);
        for (const name of names) {
          if (last || Object.hasOwn(node, name))
            next.push({ node: node[name], path: [...path, name] });
        }
      }
    }
    frontier = next;
  }
  return frontier.map((entry) => entry.path);
}

export function readAt(root: unknown, path: ConcretePath): unknown {
  let node = root;
  for (const step of path) node = (node as Record<string | number, unknown> | undefined)?.[step];
  return node;
}

export function writeAt(root: Record<string, unknown>, path: ConcretePath, value: unknown): void {
  let node: Record<string | number, unknown> = root;
  for (const step of path.slice(0, -1)) {
    if (node[step] === undefined) node[step] = {};
    node = node[step] as Record<string | number, unknown>;
  }
  node[path.at(-1)!] = value;
}

export function isPrefix(prefix: ConcretePath, path: ConcretePath): boolean {
  return prefix.length <= path.length && prefix.every((step, index) => path[index] === step);
}

// ---------------------------------------------------------------------------
// Host-minted fill (one fill for assembly, staging, and the text path)

/**
 * A host-minted value: the value itself, or a projection of its source for
 * one declared member (`field`), returning `undefined` for a member this
 * caller does not bind.
 */
export type HostMintedValue = unknown | ((field: string) => unknown);

export type HostMintedValues = Readonly<Record<string, HostMintedValue>>;

/** Core-owned sources: the ledger key of the record that holds the member. */
const LEDGER_SOURCES = new Set(["ledger.record-key", "ledger.finding-order"]);

/**
 * Write each declared host-minted member the caller binds into `artifact`
 * (keyed by canonical member) and return the members written. A member is
 * written at every existing instance of its location, over any value there.
 * `recordKeyAt` resolves the `ledger.*` sources; a caller without a ledger
 * (the text path) binds none of them. Never mutates `artifact`.
 */
export function fillHostMinted<A extends Record<string, unknown>>(
  declaration: Pick<AnswerRecordContractDeclaration, "hostMinted">,
  artifact: A,
  values: HostMintedValues,
  options: {
    readonly recordKeyAt?: (path: ConcretePath) => string | undefined;
    readonly selectors?: Readonly<Record<string, readonly string[]>>;
    /** Refuse (as a host defect) any declared member left unbound. */
    readonly requireAll?: boolean;
  } = {},
): { artifact: A; written: readonly string[] } {
  const filled = structuredClone(artifact) as A;
  const written: string[] = [];
  for (const { field, source } of declaration.hostMinted) {
    const segments = parseRecordLocation(field);
    const ledgerSource = LEDGER_SOURCES.has(source);
    const binding = ledgerSource ? undefined : values[source];
    const value =
      ledgerSource || binding === undefined
        ? undefined
        : typeof binding === "function"
          ? (binding as (field: string) => unknown)(field)
          : binding;
    if (!ledgerSource && value === undefined) {
      if (options.requireAll) hostDefect(`Host-minted source ${source} is not bound for ${field}.`);
      continue;
    }
    if (ledgerSource && !options.recordKeyAt) {
      if (options.requireAll) hostDefect(`Host-minted source ${source} needs a ledger.`);
      continue;
    }
    const parent = segments.slice(0, -1);
    const last = segments.at(-1)!;
    if (!("prop" in last)) hostDefect(`Host-minted member ${field} must end in a member name.`);
    const targets =
      parent.length === 1 && "prop" in parent[0]! && filled[parent[0].prop] === undefined
        ? []
        : instances(filled, parent, options.selectors ?? {}).filter((path) =>
            isObject(readAt(filled, path)),
          );
    for (const path of targets) {
      const target = [...path, last.prop];
      const minted = ledgerSource ? options.recordKeyAt!(target) : value;
      if (minted === undefined) hostDefect(`No ledger record holds ${field}.`);
      writeAt(filled, target, structuredClone(minted));
    }
    if (targets.length > 0) written.push(field);
  }
  return { artifact: filled, written };
}
