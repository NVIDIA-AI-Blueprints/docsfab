// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { notInterpreted } from "./helpers/first-pass-intent.js";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planOperatorNamedPaths } from "../src/cli/run/plan-operator-naming.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import {
  recordOperatorInputSupersession,
  type OperatorInputResumePlanV1,
} from "../src/inputs/operator-input-fill.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { PLAN_TARGET_NOT_NAMED_CODE } from "../src/workflow-execution/plan-binding.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  observePublicContract,
  orbitOptionChangeRepository,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
const instruction = "Update the selected documentation for the new option.";
const originalPath = "docs/SKILL.md";
const intermediatePath = "docs/AGENTS.md";
const knowledgeMarker = notInterpreted("continuation");
const continuation = {
  ...knowledgeMarker,
  admission: { ...knowledgeMarker.admission, reason: "operator-input-resume" },
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function record(directory: string, id: string, fields: Record<string, unknown>) {
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, instruction, ...fields }));
}
async function claim(directory: string, originalRunId: string, continuationRunId: string) {
  await recordOperatorInputSupersession({
    stateDirectory: directory,
    plan: { originalRunId, continuationRunId, fills: [] },
    processes: { inspect: () => ({ alive: false }) },
  });
}
async function chain(directory?: string, requestIntent: unknown = continuation) {
  const stateDirectory = directory ?? (await mkdtemp(join(tmpdir(), "docsfab-chain-integrity-")));
  if (!directory) roots.push(stateDirectory);
  await mkdir(stateDirectory, { recursive: true });
  await record(stateDirectory, "first", { operatorTargetPaths: [originalPath] });
  await record(stateDirectory, "last", { operatorTargetPaths: [intermediatePath], requestIntent });
  await claim(stateDirectory, "first", "last");
  return stateDirectory;
}
async function named(stateDirectory: string, originalRunId = "last") {
  return planOperatorNamedPaths({
    stateDirectory,
    request: { instruction, operatorInputResume: { originalRunId } as OperatorInputResumePlanV1 },
    trackedPaths: [originalPath, intermediatePath],
  });
}

const corruptAdmissions = [
  ["missing reason", { admission: { outcome: "continuation" } }],
  ["wrong reason", { admission: { outcome: "continuation", reason: "pi-offline" } }],
  ["wrong outcome", { admission: { outcome: "admitted", reason: "operator-input-resume" } }],
  ["missing outcome", { admission: { reason: "operator-input-resume" } }],
  ["erased interpretation", null],
  ["erased admission", {}],
  ["malformed admission", { admission: [] }],
  ["unknown outcome", { admission: { outcome: "invented", reason: null } }],
  ["apparently original admission", notInterpreted("offline")],
  ["different continuation kind", notInterpreted("continuation")],
] as const;

describe("continuation naming requires coherent origin evidence", () => {
  it.each([
    { admission: { outcome: "continuation" } },
    { admission: { outcome: "unknown", reason: null } },
  ])(
    "does not accept malformed markers even without an incoming claim (%j)",
    async (requestIntent) => {
      const directory = await chain(undefined, requestIntent);
      await unlink(join(directory, "input-ask-supersession", "first.1.json"));
      expect((await named(directory)).names(intermediatePath)).toBe(false);
    },
  );
  it("does not infer a legacy origin from an unreadable claim", async () => {
    const directory = await chain();
    await record(directory, "last", { operatorTargetPaths: [intermediatePath] });
    await writeFile(join(directory, "input-ask-supersession", "first.1.json"), "{");
    expect((await named(directory)).names(intermediatePath)).toBe(false);
  });
  it.each([
    "missing claim",
    "missing predecessor",
    "wrong saved identity",
    "ambiguous predecessors",
    "cycle",
  ] as const)("%s grants no naming (control)", async (corruption) => {
    const directory = await chain();
    if (corruption === "missing claim")
      await unlink(join(directory, "input-ask-supersession", "first.1.json"));
    if (corruption === "missing predecessor") await unlink(join(directory, "first.json"));
    if (corruption === "wrong saved identity")
      await record(directory, "first", { id: "another", operatorTargetPaths: [originalPath] });
    if (corruption === "ambiguous predecessors") {
      await record(directory, "another", { operatorTargetPaths: ["docs/QWEN.md"] });
      await claim(directory, "another", "last");
    }
    if (corruption === "cycle") {
      await record(directory, "first", {
        operatorTargetPaths: [originalPath],
        requestIntent: continuation,
      });
      await claim(directory, "last", "first");
    }
    const paths = await named(directory);
    expect(paths.names(originalPath)).toBe(false);
    expect(paths.names(intermediatePath)).toBe(false);
  });

  it.each(corruptAdmissions)(
    "grants no naming from a continued record with %s",
    async (_label, admission) => {
      const paths = await named(await chain(undefined, admission));
      expect(
        paths.names(intermediatePath),
        "a corrupt continuation must not become an original request",
      ).toBe(false);
      expect(paths.names(originalPath)).toBe(false);
    },
  );
  it("does not treat an erased interpretation as legacy when a predecessor exists", async () => {
    const directory = await chain();
    await record(directory, "last", { operatorTargetPaths: [intermediatePath] });
    expect((await named(directory)).names(intermediatePath)).toBe(false);
  });
  it("does not trust an erased marker when a claim also loses its successor", async () => {
    const directory = await chain();
    await record(directory, "last", { operatorTargetPaths: [intermediatePath] });
    const path = join(directory, "input-ask-supersession", "first.1.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    delete value.supersededBy;
    await writeFile(path, JSON.stringify(value));
    expect((await named(directory)).names(intermediatePath)).toBe(false);
  });
  it.each([
    ["wrong schema", { schemaVersion: 2 }],
    ["wrong sequence", { sequence: 2 }],
    ["missing sequence", { sequence: null }],
  ] as const)("does not use predecessor evidence with %s", async (_label, replacement) => {
    const directory = await chain();
    const path = join(directory, "input-ask-supersession", "first.1.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...value, ...replacement }));
    expect(
      (await named(directory)).names(originalPath),
      "malformed predecessor identity must name nothing",
    ).toBe(false);
  });
  it("does not infer predecessor identity from a loose file prefix", async () => {
    const directory = await chain();
    await rename(
      join(directory, "input-ask-supersession", "first.1.json"),
      join(directory, "input-ask-supersession", "first.claim.json"),
    );
    expect((await named(directory)).names(originalPath)).toBe(false);
  });
  it("refuses duplicate claims even when they name the same predecessor", async () => {
    const directory = await chain();
    const path = join(directory, "input-ask-supersession", "first.1.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      join(directory, "input-ask-supersession", "first.2.json"),
      JSON.stringify({ ...value, sequence: 2 }),
    );
    expect((await named(directory)).names(originalPath)).toBe(false);
  });
  it.each([undefined, notInterpreted("offline"), notInterpreted("continuation")])(
    "retains a genuine original or legacy record without an InputAsk predecessor (control %j)",
    async (requestIntent) => {
      const directory = await chain();
      await record(directory, "first", { operatorTargetPaths: [originalPath], requestIntent });
      const paths = await named(directory);
      expect(paths.names(originalPath)).toBe(true);
      expect(paths.names(intermediatePath)).toBe(false);
    },
  );
  it("retains legacy request-text naming without explicit path metadata (control)", async () => {
    const directory = await chain();
    const typed = `Update ${originalPath} for the new option.`;
    await record(directory, "first", { instruction: typed });
    const paths = await planOperatorNamedPaths({
      stateDirectory: directory,
      request: {
        instruction: typed,
        operatorInputResume: { originalRunId: "last" } as OperatorInputResumePlanV1,
      },
      trackedPaths: [originalPath, intermediatePath],
    });
    expect(paths.names(originalPath)).toBe(true);
    expect(paths.names(intermediatePath)).toBe(false);
  });
});

describe("real continuation plan admission preserves the naming boundary", () => {
  it.each([
    ["corrupt special", intermediatePath, { admission: { outcome: "continuation" } }, false],
    ["valid original special control", originalPath, continuation, true],
    [
      "corrupt ordinary page control",
      "docs/guide.md",
      { admission: { outcome: "continuation" } },
      true,
    ],
  ] as const)(
    "%s",
    { timeout: testTimeoutMs(90_000) },
    async (_label, target, marker, succeeds) => {
      const fixture = await orbitOptionChangeRepository("docsfab-chain-admission-", roots, {
        files: {
          [originalPath]: "# Guidance\n\nUse --old.\n",
          [intermediatePath]: "# Instructions\n\nUse --old.\n",
          "docs/guide.md": "# Guide\n\nUse --old.\n",
        },
      });
      await chain(fixture.config.stateDirectory, marker);
      const request = parseRunArguments([
        "update-documentation",
        "--repo",
        fixture.repository,
        "--revision",
        fixture.head,
        "--instruction",
        instruction,
        "--canon-snapshot",
        fixture.canonSnapshotPath,
        "--comparison-base",
        fixture.base,
        "--reader-source",
        "public-contract=src/orbit.ts",
        "--patch-only",
      ]);
      const harness = new EditorialProtocolHarness({
        candidate: "update",
        impactSource: await observePublicContract(fixture.repository, fixture.head),
        writePlannedPages: true,
        plannerPages: [{ path: target, disposition: "update" }],
      });
      const result = await executeRunRequest(
        {
          ...request,
          operatorInputResume: {
            originalRunId: "last",
            workflow: "update-documentation",
            instruction,
            instructionSha256: "a".repeat(64),
            repositoryPath: fixture.repository,
            revision: fixture.head,
            fills: [],
            skipPlanner: false,
            skipSearchObserve: false,
            revalidate: true,
            verifiedNoChange: false,
            readerSources: [],
            slots: [],
          },
        },
        fixture.config,
        { silent: true, harness },
      );
      if (succeeds) {
        expect(result?.status, result?.error).toBe("succeeded");
        expect(result?.changes?.files.map((file) => file.path)).toEqual([target]);
      } else {
        expect(readRunFailure(result!)?.code, result?.error).toBe(PLAN_TARGET_NOT_NAMED_CODE);
        expect(harness.stepIds).not.toContain("write-documentation");
        expect(result?.changes?.files ?? []).toEqual([]);
      }
      expect(result?.operatorTargetPaths ?? []).toEqual(
        marker === continuation ? [originalPath] : [],
      );
    },
  );
});
