// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planOperatorNamedPaths } from "../src/cli/run/plan-operator-naming.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { requestInterpretationStep } from "../src/cli/run/request-intent-stop.js";
import {
  recordOperatorInputSupersession,
  type OperatorInputResumePlanV1,
} from "../src/inputs/operator-input-fill.js";
import { decodeRunRecordRequestIntent } from "../src/request-intent/interpret-record.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { PLAN_TARGET_NOT_NAMED_CODE } from "../src/workflow-execution/plan-binding.js";
import { notInterpreted, recordedIntent } from "./helpers/first-pass-intent.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  observePublicContract,
  orbitOptionChangeRepository,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
const instruction = "Update docs/guide.md for the new option.";
const special = "docs/AGENTS.md";
const prior = "docs/SKILL.md";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function currentMarker() {
  const seed = recordedIntent(instruction, {
    operation: "update",
    targets: [{ path: "docs/guide.md", quote: "docs/guide.md" }],
  });
  const value = requestInterpretationStep(
    { outcome: "admitted", intent: seed.intent!, calls: seed.admission.calls },
    0,
  ).recorded!;
  expect(decodeRunRecordRequestIntent(value, instruction)).toEqual(value);
  return JSON.parse(JSON.stringify(value));
}
function continuationMarker() {
  const value = notInterpreted("continuation");
  return { ...value, admission: { ...value.admission, reason: "operator-input-resume" } };
}
async function save(directory: string, id: string, paths: string[], marker: unknown) {
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({
      id,
      instruction,
      operatorTargetPaths: paths,
      ...(marker === undefined ? {} : { requestIntent: marker }),
    }),
  );
}
async function claim(directory: string) {
  await recordOperatorInputSupersession({
    stateDirectory: directory,
    plan: { originalRunId: "first", continuationRunId: "last", fills: [] },
    processes: { inspect: () => ({ alive: false }) },
  });
}
async function naming(marker: unknown, continued = false) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-marker-contract-"));
  roots.push(stateDirectory);
  await save(stateDirectory, "first", [prior, special], currentMarker());
  await save(stateDirectory, "last", continued ? ["docs/WARP.md"] : [special], marker);
  if (continued) await claim(stateDirectory);
  return planOperatorNamedPaths({
    stateDirectory,
    request: {
      instruction,
      operatorInputResume: { originalRunId: "last" } as OperatorInputResumePlanV1,
    },
    trackedPaths: [special, prior, "docs/WARP.md"],
  });
}
function without(value: any, location: readonly string[]) {
  const copy = structuredClone(value);
  let parent = copy;
  for (const key of location.slice(0, -1)) parent = parent[key];
  delete parent[location.at(-1)!];
  return copy;
}
const fields = [
  ["schemaVersion"],
  ["admission"],
  ["intent"],
  ...["outcome", "reason", "code", "location", "boundary", "calls", "clippedTitles"].map((key) => [
    "admission",
    key,
  ]),
];

describe("present naming markers use the complete stored host contract", () => {
  it.each(fields.map((field) => [field.join("."), field] as const))(
    "missing %s supplies no original authority",
    async (_label, field) => {
      const value = without(currentMarker(), field);
      expect(
        (await naming(value)).names(special),
        "a present incomplete marker must not become a legacy original",
      ).toBe(false);
    },
  );
  it.each(fields.map((field) => [field.join("."), field] as const))(
    "missing %s supplies no continuation authority",
    async (_label, field) => {
      const value = without(continuationMarker(), field);
      expect(
        (await naming(value, true)).names(prior),
        "an incomplete marker must not establish a continuation edge",
      ).toBe(false);
    },
  );
  it.each([
    [
      "wrong version",
      (v: any) => {
        v.schemaVersion = 2;
      },
    ],
    [
      "null version",
      (v: any) => {
        v.schemaVersion = null;
      },
    ],
    [
      "string version",
      (v: any) => {
        v.schemaVersion = "1";
      },
    ],
    [
      "extra envelope field",
      (v: any) => {
        v.extra = true;
      },
    ],
    [
      "extra admission field",
      (v: any) => {
        v.admission.extra = true;
      },
    ],
    [
      "null admission",
      (v: any) => {
        v.admission = null;
      },
    ],
    [
      "array admission",
      (v: any) => {
        v.admission = [];
      },
    ],
    [
      "unknown outcome",
      (v: any) => {
        v.admission.outcome = "invented";
      },
    ],
    [
      "wrong reason type",
      (v: any) => {
        v.admission.reason = false;
      },
    ],
    [
      "wrong code type",
      (v: any) => {
        v.admission.code = 7;
      },
    ],
    [
      "wrong location type",
      (v: any) => {
        v.admission.location = [];
      },
    ],
    [
      "wrong boundary type",
      (v: any) => {
        v.admission.boundary = false;
      },
    ],
    [
      "null calls",
      (v: any) => {
        v.admission.calls = null;
      },
    ],
    [
      "missing admitted call",
      (v: any) => {
        v.admission.calls = [];
      },
    ],
    [
      "malformed call",
      (v: any) => {
        v.admission.calls = [{}];
      },
    ],
    [
      "wrong call digest",
      (v: any) => {
        v.admission.calls[0].promptSha256 = "bad";
      },
    ],
    [
      "wrong call count",
      (v: any) => {
        v.admission.calls[0].inputTokens = -1;
      },
    ],
    [
      "wrong clipped count",
      (v: any) => {
        v.admission.clippedTitles = "0";
      },
    ],
    [
      "negative clipped count",
      (v: any) => {
        v.admission.clippedTitles = -1;
      },
    ],
    [
      "null admitted reading envelope",
      (v: any) => {
        v.intent = null;
      },
    ],
    [
      "array reading envelope",
      (v: any) => {
        v.intent = [];
      },
    ],
    [
      "scalar reading envelope",
      (v: any) => {
        v.intent = "invented";
      },
    ],
  ] as const)("%s supplies no naming", async (_label, mutate) => {
    const value = currentMarker();
    mutate(value);
    expect((await naming(value)).names(special)).toBe(false);
  });
  it.each([null, [], "marker"])(
    "a present non-object marker grants nothing (control %j)",
    async (marker) => {
      expect((await naming(marker)).names(special)).toBe(false);
    },
  );
  it.each([
    ["current admitted", currentMarker],
    ["legacy absence", () => undefined],
    ["offline", () => notInterpreted("offline")],
    ["not applicable", () => notInterpreted("not-applicable")],
    ["knowledge continuation", () => notInterpreted("continuation")],
  ] as const)("a valid %s original retains explicit input (control)", async (_label, marker) => {
    expect((await naming(marker())).names(special)).toBe(true);
  });
  it("a full producer-compatible continuation retains both originals and ignores its own target (control)", async () => {
    const paths = await naming(continuationMarker(), true);
    expect(paths.names(special)).toBe(true);
    expect(paths.names(prior)).toBe(true);
    expect(paths.names("docs/WARP.md")).toBe(false);
  });
  it("model reading contents and digest are not naming authority (control)", async () => {
    const marker = currentMarker();
    marker.intent = { targets: [{ path: "docs/WARP.md" }], bodySha256: "changed model data" };
    expect(() => decodeRunRecordRequestIntent(marker, instruction)).toThrow();
    const paths = await naming(marker);
    expect(paths.names(special)).toBe(true);
    expect(paths.names("docs/WARP.md")).toBe(false);
  });
});

describe("parsed-request execution enforces complete original markers", () => {
  it.each([
    ["damaged special", special, true],
    ["complete special control", special, false],
    ["damaged ordinary control", "docs/guide.md", true],
  ] as const)("%s", { timeout: testTimeoutMs(90_000) }, async (_label, target, damaged) => {
    const fixture = await orbitOptionChangeRepository("docsfab-marker-writer-", roots, {
      files: {
        [special]: "# Instructions\n\nUse --old.\n",
        [prior]: "# Skills\n\nUse --old.\n",
        "docs/guide.md": "# Guide\n\nUse --old.\n",
      },
    });
    await mkdir(fixture.config.stateDirectory, { recursive: true });
    const marker = currentMarker();
    if (damaged) delete marker.admission.reason;
    await save(fixture.config.stateDirectory, "first", [prior], undefined);
    await save(fixture.config.stateDirectory, "last", [special], marker);
    await claim(fixture.config.stateDirectory);
    await unlink(join(fixture.config.stateDirectory, "input-ask-supersession", "first.1.json"));
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
      plannerPages: [
        ...(target === special ? [{ path: "docs/guide.md", disposition: "retain" as const }] : []),
        { path: target, disposition: "update" },
      ],
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
    if (damaged && target === special) {
      expect(
        readRunFailure(result!)?.code,
        JSON.stringify({
          status: result?.status,
          paths: result?.changes?.files.map((file) => file.path),
          steps: harness.stepIds,
        }),
      ).toBe(PLAN_TARGET_NOT_NAMED_CODE);
      expect(harness.stepIds).not.toContain("write-documentation");
      expect(result?.changes?.files ?? []).toEqual([]);
    } else {
      expect(result?.status, result?.error).toBe("succeeded");
      expect(result?.changes?.files.map((file) => file.path)).toEqual([target]);
    }
    expect(result?.operatorTargetPaths ?? []).toEqual(damaged ? [] : [special]);
  });
});
