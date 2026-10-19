// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer side of the outcome pairing tests: each CLI surface that reads a
 * saved run record, invoked through its shipped command handler, and the
 * exact parsed field it reads for each producer family. A reader never
 * matches a substring of rendered text; it reads a JSON field or one parsed
 * line of a named section.
 */
import { handleRunsCommand } from "../../src/cli/commands/runs.js";
import { handleWhyCommand } from "../../src/cli/commands/why.js";
import { explainProductDisposition } from "../../src/operator/cli-format.js";
import type { ProductDisposition } from "../../src/workflow-contracts/contracts.js";
import type { PairingFamily } from "./known-failures.js";

/** A saved run a consumer reads. */
export interface SavedRun {
  readonly runId: string;
  readonly stateDirectory: string;
}

export interface ConsumerRead {
  /** The JSON field or parsed line the reader takes its value from. */
  readonly field: string;
  readonly read: (output: ConsumerOutput) => unknown;
  /**
   * The fed value's image under a typed mapping the consumer declares in
   * `src`; the identity when absent.
   */
  readonly image?: (value: string) => unknown;
}

export interface PairingConsumer {
  readonly id: string;
  /** `<src file>:<function or CLI argv>` the consumer is reached through. */
  readonly entry: string;
  readonly invoke: (run: SavedRun) => Promise<ConsumerOutput>;
  readonly reads: Readonly<Partial<Record<PairingFamily, ConsumerRead>>>;
}

/** Captured stdout lines of one command, and the error it threw, if any. */
export interface ConsumerOutput {
  readonly lines: readonly string[];
  readonly error?: { readonly code: string | undefined; readonly message: string };
}

/** Message shown as the image when the consumer's own mapping has none. */
export const MISSING_DECLARED_IMAGE = "missing from the consumer's declared mapping";

export const PAIRING_CONSUMERS: readonly PairingConsumer[] = Object.freeze([
  {
    id: "runs-show-json",
    entry: "src/cli/commands/runs.ts:docsfab runs show <id> --json",
    invoke: (run) =>
      capture(() =>
        handleRunsCommand(["show", run.runId, "--json", "--state-dir", run.stateDirectory]),
      ),
    reads: {
      "run-status": {
        field: "execution.status",
        read: (output) => at(json(output), "execution", "status"),
      },
      "product-disposition": {
        field: "product.disposition",
        read: (output) => at(json(output), "product", "disposition"),
      },
      "readiness-disposition": {
        field: "product.disposition",
        read: (output) => at(json(output), "product", "disposition"),
      },
      "editorial-outcome": {
        field: "editorial.outcome",
        read: (output) => at(json(output), "editorial", "outcome"),
      },
      "failure-class": {
        field: "failures[scope=run].class",
        read: (output) =>
          list(at(json(output), "failures"))
            .filter((failure) => at(failure, "scope") === "run")
            .map((failure) => at(failure, "class")),
        image: (value) => [value],
      },
    },
  },
  {
    id: "runs-show-text",
    entry: "src/cli/commands/runs.ts:docsfab runs show <id>",
    invoke: (run) =>
      capture(() => handleRunsCommand(["show", run.runId, "--state-dir", run.stateDirectory])),
    reads: {
      // The execution plane, and whether NEXT names `docsfab why`, which only
      // a failed run does.
      "run-status": {
        field: "VERDICT execution plane; NEXT Why line",
        read: (output) => ({
          execution: sectionValue(output, "VERDICT", /^execution (\S+)$/u),
          why: sectionValue(output, "NEXT", /^Why: (docsfab why) /u) !== null,
        }),
        image: (value) => ({ execution: value, why: value === "failed" }),
      },
      "product-disposition": {
        field: "PRODUCT disposition and meaning lines",
        read: (output) => ({
          disposition: sectionValue(output, "PRODUCT", /^Product disposition: (\S+)$/u),
          meaning: sectionValue(output, "PRODUCT", /^Product disposition meaning: (.+)$/u),
        }),
        image: (value) => ({
          disposition: value,
          meaning: explainProductDisposition(value as ProductDisposition) ?? MISSING_DECLARED_IMAGE,
        }),
      },
      "readiness-disposition": {
        field: "PRODUCT disposition and meaning lines",
        read: (output) => ({
          disposition: sectionValue(output, "PRODUCT", /^Product disposition: (\S+)$/u),
          meaning: sectionValue(output, "PRODUCT", /^Product disposition meaning: (.+)$/u),
        }),
        image: (value) => ({
          disposition: value,
          meaning: explainProductDisposition(value as ProductDisposition) ?? MISSING_DECLARED_IMAGE,
        }),
      },
      "editorial-outcome": {
        field: "EDITORIAL outcome line",
        read: (output) => sectionValue(output, "EDITORIAL", /^Editorial outcome: (\S+)/u),
      },
      "failure-class": {
        field: "FAILURE class line",
        read: (output) => sectionValue(output, "FAILURE", /^Failure class: (\S+) \(layer /u),
      },
    },
  },
  {
    id: "runs-query",
    entry: "src/cli/commands/runs-index.ts:docsfab runs query --where rowKind=run --json",
    invoke: (run) =>
      capture(() =>
        handleRunsCommand([
          "query",
          "--where",
          "rowKind=run",
          "--where",
          `runId=${run.runId}`,
          "--group-by",
          "runStatus,failureClass,readinessDisposition",
          "--state-dir",
          run.stateDirectory,
          "--json",
        ]),
      ),
    reads: {
      "run-status": {
        field: "groups[].key.runStatus",
        read: (output) => groupKeys(output, "runStatus"),
        image: (value) => [value],
      },
      "failure-class": {
        field: "groups[].key.failureClass",
        read: (output) => groupKeys(output, "failureClass"),
        image: (value) => [value],
      },
      "readiness-disposition": {
        field: "groups[].key.readinessDisposition",
        read: (output) => groupKeys(output, "readinessDisposition"),
        image: (value) => [value],
      },
    },
  },
  {
    id: "why",
    entry: "src/cli/commands/why.ts:docsfab why <id> --json",
    invoke: (run) =>
      capture(() => handleWhyCommand([run.runId, "--state-dir", run.stateDirectory, "--json"])),
    reads: {
      "readiness-disposition": {
        field: "diagnoses[].readinessDisposition",
        read: (output) =>
          list(at(json(output), "diagnoses")).map((diagnosis) =>
            at(diagnosis, "readinessDisposition"),
          ),
        image: (value) => [value],
      },
      "run-status": {
        field: "diagnoses[].runStatus",
        read: (output) =>
          list(at(json(output), "diagnoses")).map((diagnosis) => at(diagnosis, "runStatus")),
        image: (value) => [value],
      },
      "failure-class": {
        field: "diagnoses[].findings[role=terminal].evidence.failureClass",
        read: (output) =>
          list(at(json(output), "diagnoses")).flatMap((diagnosis) =>
            list(at(diagnosis, "findings"))
              .filter((finding) => at(finding, "role") === "terminal")
              .map((finding) => at(finding, "evidence", "failureClass")),
          ),
        image: (value) => [value],
      },
    },
  },
]);

export function pairingConsumer(id: string): PairingConsumer {
  const consumer = PAIRING_CONSUMERS.find((candidate) => candidate.id === id);
  if (!consumer) throw new Error(`unknown pairing consumer ${id}`);
  return consumer;
}

export function consumerReads(id: string, family: PairingFamily): boolean {
  return PAIRING_CONSUMERS.some(
    (consumer) => consumer.id === id && Object.hasOwn(consumer.reads, family),
  );
}

/** The consumers that read `family`, in declaration order. */
export function consumersReading(family: PairingFamily): readonly PairingConsumer[] {
  return PAIRING_CONSUMERS.filter((consumer) => Object.hasOwn(consumer.reads, family));
}

/** Run a command handler and keep its stdout lines and any thrown code. */
export async function capture(run: () => Promise<void>): Promise<ConsumerOutput> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (message?: unknown): void => {
    lines.push(String(message));
  };
  try {
    await run();
    return { lines };
  } catch (error) {
    return {
      lines,
      error: {
        code:
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    console.log = log;
    process.exitCode = undefined;
  }
}

/** The command's stdout parsed as one JSON document; a refusal throws its code. */
export function json(output: ConsumerOutput): unknown {
  if (output.error) {
    throw new Error(`consumer refused: ${output.error.code ?? output.error.message}`);
  }
  return JSON.parse(output.lines.join("\n")) as unknown;
}

/** The value at `path` in parsed JSON, or `undefined` when a step is missing. */
export function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function groupKeys(output: ConsumerOutput, field: string): unknown[] {
  return list(at(json(output), "groups")).map((group) => at(group, "key", field));
}

/**
 * The first capture of `pattern` in the body of section `title`, or `null`.
 * A section starts at an unindented title line and holds the indented lines
 * after it, compared without their indent.
 */
export function sectionValue(
  output: ConsumerOutput,
  title: string,
  pattern: RegExp,
): string | null {
  if (output.error)
    throw new Error(`consumer refused: ${output.error.code ?? output.error.message}`);
  let inSection = false;
  for (const line of output.lines.flatMap((entry) => entry.split("\n"))) {
    if (line.length > 0 && !line.startsWith(" ")) {
      inSection = line === title;
      continue;
    }
    if (!inSection) continue;
    const match = pattern.exec(line.trim());
    if (match) return match[1] ?? null;
  }
  return null;
}
