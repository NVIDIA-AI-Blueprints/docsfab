// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing: every outcome value a producer registry holds, checked against
 * every CLI consumer that reads a saved run record (`runs show` text and
 * `--json`, `runs query` over the run index, and `why`).
 *
 * Rows derive from the producers' own registries at run time. Each row's
 * record comes from one real scripted run (or, for editorial outcomes, a real
 * runner run per outcome) and passes the shipped parse gate before a consumer
 * reads it. The invariant: the consumer's parsed field equals the fed value,
 * or its image under a mapping the consumer declares in `src`. A gap another
 * issue owns is a row in `known-failures.ts`, never a skipped case.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleRunsCommand } from "../../src/cli/commands/runs.js";
import { limit } from "../../src/config/limits.js";
import { RUN_EDITORIAL_OUTCOME_KEYS } from "../../src/host-invoker/terminal.js";
import { FAILURE_CLASSES, type FailureClass } from "../../src/operator/failure-class.js";
import { defaultRunRecordPath } from "../../src/operator/run-summary.js";
import { RUN_STATUS_KEYS, type RunRecord, type RunStatus } from "../../src/records/contracts.js";
import {
  RUN_INDEX_QUERY_FIELDS,
  RUN_INDEX_READINESS_DISPOSITIONS,
  RUN_INDEX_TERMINAL_STATUSES,
} from "../../src/records/run-index.js";
import {
  PRODUCT_DISPOSITION_KEYS,
  type ProductDisposition,
} from "../../src/workflow-contracts/contracts.js";
import { hookTimeoutMs } from "../helpers/test-timeouts.js";
import {
  at,
  capture,
  consumerReads,
  consumersReading,
  json,
  pairingConsumer,
  PAIRING_CONSUMERS,
  type SavedRun,
} from "./consumers.js";
import {
  DECLARED_EXCLUSIONS,
  FAMILIES_NOT_CARRIED,
  INDEX_PROJECTIONS,
  declaredExclusion,
  type DeclaredExclusion,
} from "./declared-domains.js";
import {
  KNOWN_FAILURES,
  PAIRING_FAMILIES,
  PAIRING_TASK,
  knownFailureKey,
  knownFailureTableProblems,
  ownerSuffix,
  resolvePair,
  type PairingFamily,
} from "./known-failures.js";
import {
  cataloguedCodeFor,
  createProducerFixture,
  runEditorialScenario,
  runScriptedReview,
  runScriptedReadiness,
  seedRun,
  withFailureClass,
  withProductDisposition,
  withRunStatus,
  type ProducerFixture,
} from "./producers.js";

/** Each producer family's values, read from the producer's own registry. */
const REGISTRIES: Readonly<Record<PairingFamily, readonly string[]>> = Object.freeze({
  "run-status": Object.keys(RUN_STATUS_KEYS),
  "product-disposition": Object.keys(PRODUCT_DISPOSITION_KEYS),
  "readiness-disposition": Object.keys(PRODUCT_DISPOSITION_KEYS),
  "editorial-outcome": Object.keys(RUN_EDITORIAL_OUTCOME_KEYS),
  "failure-class": [...FAILURE_CLASSES],
});

/** A field name that would carry a family the run index does not carry. */
const NOT_CARRIED_FIELD: Readonly<Partial<Record<PairingFamily, RegExp>>> = Object.freeze({
  "product-disposition": /productDisposition/iu,
  "readiness-disposition": /readinessDisposition|readinessReasonCodes/iu,
  "editorial-outcome": /editorial/iu,
});

type Seed =
  | { readonly run: SavedRun; readonly record: RunRecord }
  | { readonly unreachable: string };

const temporaryDirectories: string[] = [];
const seeds = new Map<string, Seed>();
let fixture: ProducerFixture;
let base: RunRecord;
let readinessBase: RunRecord;

/**
 * Each pair as `[value, consumer, owner suffix]`. A known-failure pair's title
 * ends in its owner, so the passing title is absent while the gap stands.
 */
function rowsFor(family: PairingFamily): [string, string, string][] {
  return REGISTRIES[family].flatMap((value) =>
    consumersReading(family).map((consumer): [string, string, string] => [
      value,
      consumer.id,
      ownerSuffix(KNOWN_FAILURES, { family, producerValue: value, consumer: consumer.id }),
    ]),
  );
}

function seedKey(family: PairingFamily, value: string): string {
  return `${family}/${value}`;
}

async function seedFamilyRow(
  family: PairingFamily,
  value: string,
  change: ((record: RunRecord) => void) | string,
  seedBase: RunRecord = base,
): Promise<void> {
  if (typeof change === "string") {
    seeds.set(seedKey(family, value), { unreachable: change });
    return;
  }
  const runId = `pair-${family}-${value}`;
  try {
    const record = await seedRun(seedBase, fixture.stateDirectory, runId, change);
    seeds.set(seedKey(family, value), {
      run: { runId, stateDirectory: fixture.stateDirectory },
      record,
    });
  } catch (error) {
    seeds.set(seedKey(family, value), {
      unreachable: `seed ${seedKey(family, value)} refused by the shipped producer or parse gate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

const pairingProducerLocalHookMs = limit("test.pairingProducerLocalHookTimeoutMs").value;

beforeAll(async () => {
  fixture = await createProducerFixture();
  temporaryDirectories.push(fixture.root);
  base = await runScriptedReview(fixture);
  readinessBase = await runScriptedReadiness(temporaryDirectories);
  for (const status of REGISTRIES["run-status"]) {
    await seedFamilyRow("run-status", status, withRunStatus(status as RunStatus));
  }
  for (const disposition of REGISTRIES["product-disposition"]) {
    await seedFamilyRow(
      "product-disposition",
      disposition,
      withProductDisposition(disposition as ProductDisposition),
    );
  }
  for (const disposition of REGISTRIES["readiness-disposition"]) {
    await seedFamilyRow(
      "readiness-disposition",
      disposition,
      withProductDisposition(disposition as ProductDisposition),
      readinessBase,
    );
  }
  for (const failureClass of REGISTRIES["failure-class"]) {
    const code = cataloguedCodeFor(failureClass as FailureClass);
    await seedFamilyRow(
      "failure-class",
      failureClass,
      code === undefined
        ? `producer-unreachable ${failureClass}: no catalogued code maps to this class`
        : withFailureClass(code),
    );
  }
  for (const outcome of REGISTRIES["editorial-outcome"]) {
    try {
      const run = await runEditorialScenario(outcome, temporaryDirectories);
      seeds.set(seedKey("editorial-outcome", outcome), {
        run: { runId: run.record.id, stateDirectory: run.stateDirectory },
        record: run.record,
      });
    } catch (error) {
      seeds.set(seedKey("editorial-outcome", outcome), {
        unreachable: error instanceof Error ? error.message : String(error),
      });
    }
  }
}, hookTimeoutMs(pairingProducerLocalHookMs));

afterAll(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function checkPair(family: PairingFamily, value: string, consumerId: string) {
  const seed = seeds.get(seedKey(family, value));
  if (!seed) throw new Error(`no producer seed for ${seedKey(family, value)}`);
  if ("unreachable" in seed) throw new Error(seed.unreachable);
  const exclusion = declaredExclusion(consumerId, family, value);
  if (exclusion) {
    await expectExplicitHandling(exclusion, seed.run, value);
    return;
  }
  const consumer = pairingConsumer(consumerId);
  const reader = consumer.reads[family];
  if (!reader) throw new Error(`${consumerId} declares no reader for ${family}`);
  const output = await consumer.invoke(seed.run);
  const observed = output.error
    ? { refused: output.error.code ?? output.error.message }
    : reader.read(output);
  resolvePair(KNOWN_FAILURES, {
    family,
    producerValue: value,
    consumer: consumerId,
    observed,
    expected: reader.image ? reader.image(value) : value,
  });
}

/** An excluded value gets the consumer's explicit handling, never a silent drop. */
async function expectExplicitHandling(
  exclusion: DeclaredExclusion,
  run: SavedRun,
  value: string,
): Promise<void> {
  const output = await capture(() =>
    handleRunsCommand([
      "import",
      defaultRunRecordPath(run.stateDirectory, run.runId),
      "--index-dir",
      join(run.stateDirectory, "..", `pairing-import-${run.runId}`),
      "--json",
    ]),
  );
  const listed = (at(json(output), "notTerminal") as unknown[] | undefined) ?? [];
  expect(
    listed.map((entry) => ({ runId: at(entry, "runId"), status: at(entry, "status") })),
    `${exclusion.consumer} handling of ${value}`,
  ).toEqual([{ runId: run.runId, status: value }]);
}

describe("outcome pairing producers", () => {
  it("reaches a terminal state through the real entry point and the shipped parse gate", () => {
    // The positive control every seeded row starts from.
    expect(base.status).toBe("succeeded");
    expect(base.workflow).toBe("review-documentation");
    for (const family of PAIRING_FAMILIES) {
      for (const value of REGISTRIES[family]) {
        expect(seeds.has(seedKey(family, value)), seedKey(family, value)).toBe(true);
      }
    }
  });
});

describe("run status x CLI record consumers", () => {
  it("derives a non-empty row set equal to the run status registry", () => {
    const rows = rowsFor("run-status");
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(([value]) => value))).toEqual(new Set(Object.keys(RUN_STATUS_KEYS)));
  });

  it.each(rowsFor("run-status"))("run status %s pairs with %s%s", async (value, consumer) => {
    await checkPair("run-status", value, consumer);
  });
});

describe("product disposition x CLI record consumers", () => {
  it("derives a non-empty row set equal to the product disposition registry", () => {
    const rows = rowsFor("product-disposition");
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(([value]) => value))).toEqual(
      new Set(Object.keys(PRODUCT_DISPOSITION_KEYS)),
    );
  });

  it.each(rowsFor("product-disposition"))(
    "product disposition %s pairs with %s%s",
    async (value, consumer) => {
      await checkPair("product-disposition", value, consumer);
    },
  );
});

describe("readiness disposition x CLI record consumers", () => {
  it("derives a non-empty row set matching the producer and run-index registries", () => {
    const rows = rowsFor("readiness-disposition");
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(([value]) => value))).toEqual(
      new Set(Object.keys(PRODUCT_DISPOSITION_KEYS)),
    );
    expect(new Set(RUN_INDEX_READINESS_DISPOSITIONS)).toEqual(
      new Set(Object.keys(PRODUCT_DISPOSITION_KEYS)),
    );
    expect(readinessBase.workflow).toBe("readiness");
    for (const value of REGISTRIES["readiness-disposition"]) {
      expect(seeds.get(seedKey("readiness-disposition", value))).toMatchObject({
        record: { workflow: "readiness" },
      });
    }
  });

  it.each(rowsFor("readiness-disposition"))(
    "readiness disposition %s pairs with %s%s",
    async (value, consumer) => {
      await checkPair("readiness-disposition", value, consumer);
    },
  );
});

describe("editorial outcome x CLI record consumers", () => {
  it("derives a non-empty row set equal to the editorial outcome registry", () => {
    const rows = rowsFor("editorial-outcome");
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(([value]) => value))).toEqual(
      new Set(Object.keys(RUN_EDITORIAL_OUTCOME_KEYS)),
    );
  });

  it.each(rowsFor("editorial-outcome"))(
    "editorial outcome %s pairs with %s%s",
    async (value, consumer) => {
      await checkPair("editorial-outcome", value, consumer);
    },
  );
});

describe("failure class x CLI record consumers", () => {
  it("derives a non-empty row set equal to the failure class registry", () => {
    const rows = rowsFor("failure-class");
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(([value]) => value))).toEqual(new Set(FAILURE_CLASSES));
  });

  it.each(rowsFor("failure-class"))("failure class %s pairs with %s%s", async (value, consumer) => {
    await checkPair("failure-class", value, consumer);
  });
});

describe("declared consumer domains", () => {
  it("excludes from the run index consumers exactly the statuses the index does not hold", () => {
    const unindexed = Object.keys(RUN_STATUS_KEYS).filter(
      (status) => !(RUN_INDEX_TERMINAL_STATUSES as readonly string[]).includes(status),
    );
    for (const exclusion of DECLARED_EXCLUSIONS) {
      expect(
        new Set(exclusion.excluded),
        `declared domain changed for ${exclusion.consumer}`,
      ).toEqual(new Set(unindexed));
    }
  });

  it("lists every family a consumer has no reader for, and no family it reads", () => {
    for (const consumer of PAIRING_CONSUMERS) {
      for (const family of PAIRING_FAMILIES) {
        const declared = FAMILIES_NOT_CARRIED.some(
          (entry) => entry.consumer === consumer.id && entry.family === family,
        );
        expect(declared, `declared domain changed for ${consumer.id}: ${family}`).toBe(
          !consumerReads(consumer.id, family),
        );
      }
    }
  });

  it("keeps editorial fields out of the run index", () => {
    for (const { consumer, family } of FAMILIES_NOT_CARRIED) {
      if (consumer !== "runs-query" || family === "product-disposition") continue;
      const pattern = NOT_CARRIED_FIELD[family];
      if (!pattern) throw new Error(`declared domain changed for ${consumer}: ${family}`);
      expect(
        RUN_INDEX_QUERY_FIELDS.filter((field) => pattern.test(field)),
        `declared domain changed for ${consumer}: the run index now has a ${family} field`,
      ).toEqual([]);
    }
  });

  it("owns every disposition-like run-index field with a unique readiness projection", () => {
    const declaredFields = INDEX_PROJECTIONS.map((projection) => projection.field);
    expect(new Set(declaredFields).size).toBe(declaredFields.length);
    expect([...declaredFields].sort()).toEqual(
      RUN_INDEX_QUERY_FIELDS.filter((field) => /disposition/iu.test(field)).sort(),
    );
    for (const projection of INDEX_PROJECTIONS) {
      expect(RUN_INDEX_QUERY_FIELDS).toContain(projection.field);
      expect(projection.workflow).toBe("readiness");
      expect(consumerReads("runs-query", projection.family)).toBe(true);
      expect(REGISTRIES[projection.family]).toEqual([...RUN_INDEX_READINESS_DISPOSITIONS]);
    }
  });

  it("keeps the readiness index projection null for every generic review disposition", async () => {
    const consumer = pairingConsumer("runs-query");
    const reader = consumer.reads["readiness-disposition"];
    if (!reader) throw new Error("runs-query declares no readiness-disposition reader");
    for (const value of REGISTRIES["product-disposition"]) {
      const seed = seeds.get(seedKey("product-disposition", value));
      if (!seed || "unreachable" in seed) throw new Error(`no review seed for ${value}`);
      expect(seed.record.workflow).toBe("review-documentation");
      expect(seed.record.workflowOutcome?.disposition).toBe(value);
      const output = await consumer.invoke(seed.run);
      expect(at(json(output), "population", "runs"), `query row count for ${value}`).toBe(1);
      expect(reader.read(output), `readiness projection for ${value}`).toEqual([null]);
    }
  });

  it("keeps why readiness fields null for every generic review disposition", async () => {
    for (const value of REGISTRIES["product-disposition"]) {
      const seed = seeds.get(seedKey("product-disposition", value));
      if (!seed || "unreachable" in seed) throw new Error(`no product disposition seed: ${value}`);
      const output = await pairingConsumer("why").invoke(seed.run);
      const diagnoses = at(json(output), "diagnoses");
      const entries = Array.isArray(diagnoses) ? diagnoses : [];
      expect(entries, value).toHaveLength(1);
      expect(at(entries[0], "workflow")).toBe("review-documentation");
      expect(at(entries[0], "readinessDisposition")).toBeNull();
      expect(at(entries[0], "readinessReasonCodes")).toBeNull();
      const keys = nestedKeys(diagnoses);
      expect(keys.filter((key) => /productDisposition|editorial/iu.test(key))).toEqual([]);
    }
  });

  it("refuses in why a run id with no saved record as why-run-not-found", async () => {
    // The adjacent condition to an unfinished saved run: only a missing run
    // may get this refusal once the known failures for why are fixed.
    const output = await pairingConsumer("why").invoke({
      runId: "pair-run-status-never-saved",
      stateDirectory: fixture.stateDirectory,
    });
    expect(output.error?.code).toBe("why-run-not-found");
  });
});

/** Every object key at any depth of parsed JSON. */
function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...nestedKeys(child)]);
}

describe("known-failure table", () => {
  it("has unique rows owned by another issue that name produced values and reading consumers", () => {
    expect(knownFailureTableProblems(KNOWN_FAILURES, REGISTRIES, consumerReads)).toEqual([]);
  });

  it("has no row for a pair a consumer declares excluded, which the invariant never reaches", () => {
    expect(
      KNOWN_FAILURES.filter((row) =>
        declaredExclusion(row.consumer, row.family, row.producerValue),
      ).map(knownFailureKey),
    ).toEqual([]);
  });
});

describe("known-failure resolver", () => {
  const row = {
    family: "run-status",
    producerValue: "queued",
    consumer: "runs-show-text",
    owner: "#1",
    observed: "running",
  } as const;
  const pair = {
    family: "run-status",
    producerValue: "queued",
    consumer: "runs-show-text",
  } as const;

  it("passes a pair with no row that meets the invariant, and a row whose gap stands", () => {
    expect(() =>
      resolvePair([], { ...pair, observed: "queued", expected: "queued" }),
    ).not.toThrow();
    expect(() =>
      resolvePair([row], { ...pair, observed: "running", expected: "queued" }),
    ).not.toThrow();
  });

  it("fails a pair with no row that breaks the invariant, naming the pair", () => {
    expect(() => resolvePair([], { ...pair, observed: "running", expected: "queued" })).toThrow(
      'pair run-status/queued/runs-show-text breaks the invariant: observed "running", expected "queued"',
    );
  });

  it("fails a row whose pair now meets the invariant as stale", () => {
    expect(() => resolvePair([row], { ...pair, observed: "queued", expected: "queued" })).toThrow(
      "stale known-failure row run-status/queued/runs-show-text (owner #1): delete it",
    );
  });

  it("fails a row whose gap now shows different output", () => {
    expect(() => resolvePair([row], { ...pair, observed: "failed", expected: "queued" })).toThrow(
      'known-failure row run-status/queued/runs-show-text (owner #1) observed mismatch: observed "failed", row records "running"',
    );
  });

  it("keys a row on family, value, and consumer together", () => {
    // The same value at another consumer has no row and must meet the invariant.
    expect(() =>
      resolvePair([row], {
        ...pair,
        consumer: "runs-show-json",
        observed: "queued",
        expected: "queued",
      }),
    ).not.toThrow();
    expect(() =>
      resolvePair([row], {
        ...pair,
        consumer: "runs-show-json",
        observed: "running",
        expected: "queued",
      }),
    ).toThrow("pair run-status/queued/runs-show-json breaks the invariant");
  });

  it("titles a pair with the owner of its own row, and no other pair", () => {
    expect(ownerSuffix([row], pair)).toBe(" (#1)");
    expect(ownerSuffix([row], { ...pair, consumer: "runs-show-json" })).toBe("");
    expect(ownerSuffix([row], { ...pair, producerValue: "running" })).toBe("");
  });

  it("reports duplicate, self-owned, malformed-owner, and orphaned rows", () => {
    const produced = { ...REGISTRIES };
    expect(knownFailureTableProblems([row], produced, consumerReads)).toEqual([]);
    expect(knownFailureTableProblems([row, row], produced, consumerReads)).toEqual([
      "duplicate known-failure row run-status/queued/runs-show-text",
    ]);
    expect(
      knownFailureTableProblems([{ ...row, owner: PAIRING_TASK }], produced, consumerReads),
    ).toEqual([
      `known-failure row run-status/queued/runs-show-text needs an owning issue other than ${PAIRING_TASK}`,
    ]);
    expect(knownFailureTableProblems([{ ...row, owner: "2081" }], produced, consumerReads)).toEqual(
      [
        `known-failure row run-status/queued/runs-show-text needs an owning issue other than ${PAIRING_TASK}`,
      ],
    );
    expect(
      knownFailureTableProblems([{ ...row, producerValue: "paused" }], produced, consumerReads),
    ).toEqual(["orphaned known-failure row run-status/paused/runs-show-text (owner #1)"]);
    expect(
      knownFailureTableProblems([{ ...row, consumer: "slack" }], produced, consumerReads),
    ).toEqual(["orphaned known-failure row run-status/queued/slack (owner #1)"]);
    expect(
      knownFailureTableProblems(
        [{ ...row, family: "product-disposition", producerValue: "ready", consumer: "runs-query" }],
        produced,
        consumerReads,
      ),
    ).toEqual(["orphaned known-failure row product-disposition/ready/runs-query (owner #1)"]);
  });
});
