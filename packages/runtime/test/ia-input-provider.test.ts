// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createArtifact,
  type Artifact,
  type ArtifactPayloadByKind,
  type ArtifactReference,
} from "../src/artifacts/index.js";
import {
  buildContentIndex,
  canonicalDigest,
  canonicalJson,
  type ContentIndexV1,
  type DocumentNode,
} from "../src/content-ir/index.js";
import {
  IaPlanningInputProviderError,
  DEFAULT_IA_NAVIGATION_TASKS,
  LocalIaAnalysisInputProvider,
  LocalIaPlanningInputProvider,
  inspectIaInputPackage,
  planningTaskKey,
  provisionIaAnalysisInputPackage,
  provisionIaPlanningInputPackage,
  prepareIaPlanningInputPackage,
  IA_INPUT_PACKAGE_DEFAULT_MAXIMUM_BYTES,
  type IaPlanningPackageInput,
} from "../src/ia/input-provider.js";
import { catalogCapacity } from "../src/config/catalog-capacity.js";
import { passedIaEvaluationFixture } from "./ia-evaluation-fixture.js";

const REVISION = "a".repeat(40);
const TASK = { kind: "ia-plan", scope: "site", mode: "create" } as const;
const roots: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalIaPlanningInputProvider", () => {
  it("binds the default package allowance to the catalogued limit", () => {
    // A hard-coded value equal to today's catalog maximum would also pass this,
    // so the at-limit and limit-plus-one pair below drives the refusal itself.
    expect(IA_INPUT_PACKAGE_DEFAULT_MAXIMUM_BYTES).toBe(catalogCapacity("ia.inputPackageMaxBytes"));
  });

  it("carries the exact canonical prepared size through provisioning and reading", async () => {
    // By option injection: `maxPackageBytes` is set to exactly the prepared
    // length (admitted) and one byte less (refused by name), without a 16 MiB
    // fixture.
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const options = {
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      input: evaluatedInput(index),
    };
    const prepared = await prepareIaPlanningInputPackage(options);
    await expect(
      provisionIaPlanningInputPackage({ ...options, maxPackageBytes: prepared.bytes.length - 1 }),
    ).rejects.toMatchObject({ code: "package-too-large" });
    const receipt = await provisionIaPlanningInputPackage({
      ...options,
      maxPackageBytes: prepared.bytes.length,
    });
    expect(await readFile(receipt.path)).toEqual(prepared.bytes);
    const selected = await new LocalIaPlanningInputProvider({
      packageRoot,
      repositoryRevision: REVISION,
      packageDigest: receipt.digest,
      maxPackageBytes: prepared.bytes.length,
    }).provide({ repositoryPath, task: TASK });
    expect("needsInput" in selected).toBe(false);
  });

  it("rebuilds the disposable index and returns explicit needs-input when no package exists", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const result = await provider(packageRoot).provide({ repositoryPath, task: TASK });

    expect(result.index.repository).toMatchObject({ revision: REVISION });
    expect(result).toMatchObject({
      needsInput: [
        {
          id: "planning-input-package-required",
          kind: "placement",
          evidence: [],
        },
      ],
    });
    expect(await missing(packageRoot)).toBe(true);
  });

  it("returns only the host-derived recovery command for a missing package", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const nextCommand =
      "docsfab ia input provision planning --repo '/durable/repo' --revision " +
      `${REVISION} --scope site --mode create --analysis-run 'analysis-1'`;
    const result = await new LocalIaPlanningInputProvider({
      packageRoot,
      repositoryRevision: REVISION,
      missingPackageNextCommand: nextCommand,
    }).provide({ repositoryPath, task: TASK });

    expect(result).toMatchObject({ nextCommand });
    expect(
      () =>
        new LocalIaPlanningInputProvider({
          packageRoot,
          repositoryRevision: REVISION,
          missingPackageNextCommand: `${nextCommand}\0untrusted`,
        }),
    ).toThrowError(
      new IaPlanningInputProviderError("invalid-package", "missingPackageNextCommand"),
    );
  });

  it("loads one owner-only task-keyed package bound to the exact task and index", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({
      repositoryPath,
      repositoryRevision: REVISION,
    });
    const provisioned = await provisionIaPlanningInputPackage({
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      input: evaluatedInput(index),
    });

    expect(provisioned.taskKey).toBe(planningTaskKey(TASK));
    expect((await lstat(packageRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(packageRoot, provisioned.taskKey))).mode & 0o777).toBe(0o700);
    expect((await lstat(provisioned.path)).mode & 0o777).toBe(0o600);

    const result = await provider(packageRoot).provide({ repositoryPath, task: TASK });
    expect(result.index.indexDigest).toBe(index.indexDigest);
    expect(result).toMatchObject({
      planId: "plan:site:create",
      ontology: { kind: "ontology" },
      candidates: { kind: "ia-candidates" },
      evaluation: { kind: "ia-evaluation" },
      evaluationInput: {
        index: { indexDigest: index.indexDigest },
        ontology: { kind: "ontology" },
        candidates: { kind: "ia-candidates" },
      },
      navigationEvaluation: { kind: "navigation-evaluation" },
    });
    if ("needsInput" in result) throw new Error("Expected evaluated package.");
    expect(result.evaluationInput.index).toEqual(result.index);
    expect(result.evaluationInput.ontology).toEqual(result.ontology);
    expect(result.evaluationInput.candidates).toEqual(result.candidates);
    expect("needsInput" in result).toBe(false);
  });

  it("binds plan versions exactly across replays, expiry changes, concurrent creation, and recovery", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const provision = (planId: string, expiresAt: string) =>
      provisionIaPlanningInputPackage({
        packageRoot,
        repositoryPath,
        task: TASK,
        index,
        input: evaluatedInput(index, planId),
        expiresAt,
        now: new Date("2026-08-05T12:00:00.000Z"),
      });
    const plan0 = await provision("plan:version:0", "2099-08-10T12:00:00.000Z");
    const replay = await provision("plan:version:0", "2099-08-10T12:00:00.000Z");
    expect(replay).toMatchObject({ created: false, digest: plan0.digest, path: plan0.path });
    const [plan1, plan2] = await Promise.all([
      provision("plan:version:1", "2099-08-10T12:00:00.000Z"),
      provision("plan:version:2", "2099-08-10T12:00:00.000Z"),
    ]);
    const shorter = await provision("plan:shorter-expiry", "2099-08-09T12:00:00.000Z");
    expect(new Set([plan0.digest, plan1.digest, plan2.digest, shorter.digest]).size).toBe(4);
    await expect(
      provider(packageRoot).provide({ repositoryPath, task: TASK }),
    ).rejects.toMatchObject({
      code: "invalid-package",
      path: expect.stringContaining("ambiguous-package"),
    });
    for (const [receipt, planId] of [
      [plan0, "plan:version:0"],
      [plan1, "plan:version:1"],
      [plan2, "plan:version:2"],
      [shorter, "plan:shorter-expiry"],
    ] as const) {
      const selected = await new LocalIaPlanningInputProvider({
        packageRoot,
        repositoryRevision: REVISION,
        packageDigest: receipt.digest,
      }).provide({ repositoryPath, task: TASK });
      expect(selected).toMatchObject({ planId });
      expect(receipt.nextCommand).toContain(`--input-digest ${receipt.digest}`);
    }
    await writeFile(plan1.path, "{", { mode: 0o600 });
    await expect(
      new LocalIaPlanningInputProvider({
        packageRoot,
        repositoryRevision: REVISION,
        packageDigest: plan1.digest,
      }).provide({ repositoryPath, task: TASK }),
    ).rejects.toMatchObject({ code: "invalid-json" });
    await expect(
      new LocalIaPlanningInputProvider({
        packageRoot,
        repositoryRevision: REVISION,
        packageDigest: plan2.digest,
      }).provide({ repositoryPath, task: TASK }),
    ).resolves.toMatchObject({ planId: "plan:version:2" });
  });

  it("fails closed when repository state is stale or package bytes are tampered", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const provisioned = await provisionIaPlanningInputPackage({
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      input: evaluatedInput(index),
    });
    const local = provider(packageRoot);

    await writeFile(join(repositoryPath, "README.md"), "# Mutated after provisioning\n");
    await expect(local.provide({ repositoryPath, task: TASK })).rejects.toEqual(
      new IaPlanningInputProviderError("stale-package", "$.repository"),
    );

    await writeFile(join(repositoryPath, "README.md"), "# DocsFab\n\nSource evidence.\n");
    const parsed = JSON.parse(await readFile(provisioned.path, "utf8")) as {
      input: { planId: string };
    };
    parsed.input.planId = "tampered-plan";
    await writeFile(provisioned.path, JSON.stringify(parsed), { mode: 0o600 });
    await expect(local.provide({ repositoryPath, task: TASK })).rejects.toEqual(
      new IaPlanningInputProviderError("integrity-mismatch", "$.digest"),
    );
  });

  it("rejects symlinks, insecure permissions, oversized packages, and roots inside the repository", async () => {
    const first = await fixturePaths();
    await mkdir(first.packageRoot, { mode: 0o700 });
    const taskDirectory = join(first.packageRoot, planningTaskKey(TASK));
    await symlink(first.repositoryPath, taskDirectory, "dir");
    await expect(
      provider(first.packageRoot).provide({
        repositoryPath: first.repositoryPath,
        task: TASK,
      }),
    ).rejects.toEqual(new IaPlanningInputProviderError("symlink", taskDirectory));

    const second = await fixturePaths();
    await mkdir(second.packageRoot, { mode: 0o700 });
    await chmod(second.packageRoot, 0o755);
    await expect(
      provider(second.packageRoot).provide({
        repositoryPath: second.repositoryPath,
        task: TASK,
      }),
    ).rejects.toEqual(new IaPlanningInputProviderError("insecure-permissions", second.packageRoot));

    const third = await fixturePaths();
    const index = await buildContentIndex({
      repositoryPath: third.repositoryPath,
      repositoryRevision: REVISION,
    });
    const thirdReceipt = await provisionIaPlanningInputPackage({
      packageRoot: third.packageRoot,
      repositoryPath: third.repositoryPath,
      task: TASK,
      index,
      input: evaluatedInput(index),
    });
    await expect(
      new LocalIaPlanningInputProvider({
        packageRoot: third.packageRoot,
        repositoryRevision: REVISION,
        maxPackageBytes: 32,
      }).provide({ repositoryPath: third.repositoryPath, task: TASK }),
    ).rejects.toEqual(new IaPlanningInputProviderError("package-too-large", thirdReceipt.path));

    const inside = join(third.repositoryPath, ".planning-inputs");
    await expect(
      provider(inside).provide({
        repositoryPath: third.repositoryPath,
        task: TASK,
      }),
    ).rejects.toEqual(new IaPlanningInputProviderError("unsafe-path", inside));
  });

  it("rejects candidate-parent target fields and non-normalized anchors outside the IA task surface", () => {
    expect(() =>
      planningTaskKey({
        kind: "ia-plan",
        scope: "section",
        mode: "reevaluate",
        target: {
          sourcePath: "README.md",
          anchor: "docsfab",
          candidateParentPath: "docs/index.md",
        },
      }),
    ).toThrowError(new IaPlanningInputProviderError("invalid-package", "$.task.target"));
    expect(() =>
      planningTaskKey({
        kind: "ia-plan",
        scope: "section",
        mode: "reevaluate",
        target: { sourcePath: "README.md", anchor: "docsfab\nsecret" },
      }),
    ).toThrowError(new IaPlanningInputProviderError("invalid-package", "$.task.target"));
  });
});

describe("LocalIaAnalysisInputProvider", () => {
  it("returns typed absence and replays unchanged provisioning without clobbering siblings", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    await expect(
      analysisProvider(packageRoot).provide({ repositoryPath, task: TASK }),
    ).rejects.toEqual(
      new IaPlanningInputProviderError("missing-package", join(packageRoot, planningTaskKey(TASK))),
    );
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const first = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
      expiresAt: "2099-08-10T12:00:00.000Z",
    });
    await writeFile(join(packageRoot, planningTaskKey(TASK), "unrelated.txt"), "preserve", {
      mode: 0o600,
    });
    const replay = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
      expiresAt: "2099-08-10T12:00:00.000Z",
    });
    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, digest: first.digest, path: first.path });
    expect(await readFile(join(packageRoot, planningTaskKey(TASK), "unrelated.txt"), "utf8")).toBe(
      "preserve",
    );
  });

  it("distinguishes wrong repository, wrong revision, and expiry", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      repositoryIdentity: "1".repeat(64),
      task: TASK,
      index,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
      expiresAt: "2026-08-10T12:00:00.000Z",
    });
    await expect(
      new LocalIaAnalysisInputProvider({
        packageRoot,
        repositoryRevision: REVISION,
        repositoryIdentity: "2".repeat(64),
        now: () => new Date("2026-08-05T12:00:00.000Z"),
      }).provide({ repositoryPath, task: TASK }),
    ).rejects.toMatchObject({ code: "wrong-repository" });
    await expect(
      new LocalIaAnalysisInputProvider({
        packageRoot,
        repositoryRevision: "b".repeat(40),
        repositoryIdentity: "1".repeat(64),
        now: () => new Date("2026-08-05T12:00:00.000Z"),
      }).provide({ repositoryPath, task: TASK }),
    ).rejects.toMatchObject({ code: "wrong-revision" });
    await expect(
      new LocalIaAnalysisInputProvider({
        packageRoot,
        repositoryRevision: REVISION,
        repositoryIdentity: "1".repeat(64),
        now: () => new Date("2026-08-11T12:00:00.000Z"),
      }).provide({ repositoryPath, task: TASK }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("provisions and loads an owner-only query-only package bound to the exact index", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const navigationTasks = [...DEFAULT_IA_NAVIGATION_TASKS];
    const provisioned = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      navigationTasks,
    });

    expect((await lstat(packageRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(packageRoot, provisioned.taskKey))).mode & 0o777).toBe(0o700);
    expect((await lstat(provisioned.path)).mode & 0o777).toBe(0o600);
    const packaged = JSON.parse(await readFile(provisioned.path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(packaged).sort()).toEqual(
      [
        "digest",
        "expiresAt",
        "navigationTasks",
        "repository",
        "schemaVersion",
        "task",
        "taskKey",
      ].sort(),
    );
    expect(JSON.stringify(packaged)).not.toMatch(
      /expectedNodeIds|acceptableNodeIds|ranked|recommendation|ontology|artifacts|output/u,
    );

    const result = await analysisProvider(packageRoot).provide({ repositoryPath, task: TASK });
    expect(result.index.indexDigest).toBe(index.indexDigest);
    expect(result.navigationTasks).toEqual(navigationTasks);
  });

  it("rejects stale repository state and tampered query bytes", async () => {
    const first = await fixturePaths();
    const firstIndex = await buildContentIndex({
      repositoryPath: first.repositoryPath,
      repositoryRevision: REVISION,
    });
    await provisionIaAnalysisInputPackage({
      packageRoot: first.packageRoot,
      repositoryPath: first.repositoryPath,
      task: TASK,
      index: firstIndex,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
    });
    await writeFile(join(first.repositoryPath, "README.md"), "# Changed after provisioning\n");
    await expect(
      analysisProvider(first.packageRoot).provide({
        repositoryPath: first.repositoryPath,
        task: TASK,
      }),
    ).rejects.toEqual(new IaPlanningInputProviderError("stale-package", "$.repository"));

    const second = await fixturePaths();
    const secondIndex = await buildContentIndex({
      repositoryPath: second.repositoryPath,
      repositoryRevision: REVISION,
    });
    const provisioned = await provisionIaAnalysisInputPackage({
      packageRoot: second.packageRoot,
      repositoryPath: second.repositoryPath,
      task: TASK,
      index: secondIndex,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
    });
    const tampered = JSON.parse(await readFile(provisioned.path, "utf8")) as {
      navigationTasks: Array<{ query: string }>;
    };
    tampered.navigationTasks[0]!.query = "A substituted query";
    await writeFile(provisioned.path, JSON.stringify(tampered), { mode: 0o600 });
    await expect(
      analysisProvider(second.packageRoot).provide({
        repositoryPath: second.repositoryPath,
        task: TASK,
      }),
    ).rejects.toEqual(new IaPlanningInputProviderError("integrity-mismatch", "$.digest"));
  });

  it("rejects an output-bearing package even when its integrity digest is recomputed", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const provisioned = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
    });
    const packaged = JSON.parse(await readFile(provisioned.path, "utf8")) as Record<
      string,
      unknown
    >;
    const { digest: _digest, ...unsigned } = packaged;
    const outputBearing = {
      ...unsigned,
      expectedNodeIds: ["document:README.md"],
    };
    const substituted = {
      ...outputBearing,
      digest: canonicalDigest(outputBearing),
    };
    const substitutedPath = join(
      packageRoot,
      planningTaskKey(TASK),
      `analysis-input-${substituted.digest}.json`,
    );
    await writeFile(substitutedPath, canonicalJson(substituted), { mode: 0o600 });
    await rename(provisioned.path, `${provisioned.path}.unrelated-preserved`);

    await expect(
      analysisProvider(packageRoot).provide({ repositoryPath, task: TASK }),
    ).rejects.toEqual(new IaPlanningInputProviderError("invalid-package", "$.package"));
  });

  it("rejects a fully rehashed substitution of the canonical host navigation authority", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const provisioned = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      task: TASK,
      index,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
    });
    const value = JSON.parse(await readFile(provisioned.path, "utf8")) as Record<string, unknown>;
    const { digest: _digest, ...unsigned } = value;
    (unsigned.navigationTasks as Array<{ query: string }>)[0]!.query = "Attacker-selected query";
    const attack = { ...unsigned, digest: canonicalDigest(unsigned) };
    const attackPath = join(
      packageRoot,
      planningTaskKey(TASK),
      `analysis-input-${attack.digest}.json`,
    );
    await writeFile(attackPath, canonicalJson(attack), { mode: 0o600 });
    await rename(provisioned.path, `${provisioned.path}.preserved`);

    await expect(
      analysisProvider(packageRoot).provide({ repositoryPath, task: TASK }),
    ).rejects.toEqual(new IaPlanningInputProviderError("invalid-package", "$.navigationTasks"));
  });

  it("quotes the complete section target and anchor in version-bound receipt commands", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const sourcePath = "docs/a b; ' $(touch INJECTED) `touch INJECTED2` * ?.md";
    const anchor = "section ; ' $(touch INJECTED3) `touch INJECTED4` * ?";
    await mkdir(join(repositoryPath, "docs"), { mode: 0o700 });
    await writeFile(join(repositoryPath, sourcePath), "# Section\n", { mode: 0o600 });
    const task = {
      kind: "ia-plan",
      scope: "section",
      mode: "reevaluate",
      target: { sourcePath, anchor },
    } as const;
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const receipt = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      commandRepositoryPath: repositoryPath,
      task,
      index,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
    });
    const inspected = await inspectIaInputPackage({
      packageKind: "analysis-input",
      packageRoot,
      repositoryPath,
      repositoryRevision: REVISION,
      commandRepositoryPath: repositoryPath,
      packageDigest: receipt.digest,
      task,
    });
    expect(inspected.nextCommand).toBe(receipt.nextCommand);
    const binRoot = join(packageRoot, "command-bin");
    await mkdir(binRoot, { mode: 0o700 });
    const capture = join(packageRoot, "captured-arguments.txt");
    await writeFile(
      join(binRoot, "docsfab"),
      ["#!/bin/sh", 'printf \'%s\\n\' "$@" > "$DOCSFAB_CAPTURE"', ""].join("\n"),
      { mode: 0o700 },
    );
    await execFile("/bin/sh", ["-c", receipt.nextCommand], {
      cwd: repositoryPath,
      env: {
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        DOCSFAB_CAPTURE: capture,
      },
    });
    expect((await readFile(capture, "utf8")).trimEnd().split("\n")).toEqual([
      "run",
      "ia-analysis",
      "--repo",
      repositoryPath,
      "--revision",
      REVISION,
      "--scope",
      "section",
      "--target",
      `${sourcePath}#${anchor}`,
      "--input-digest",
      receipt.digest,
    ]);
    const pageTask = {
      kind: "ia-plan",
      scope: "page",
      mode: "reevaluate",
      target: { sourcePath },
    } as const;
    const pageReceipt = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath,
      commandRepositoryPath: repositoryPath,
      task: pageTask,
      index,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
    });
    await execFile("/bin/sh", ["-c", pageReceipt.nextCommand], {
      cwd: repositoryPath,
      env: {
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        DOCSFAB_CAPTURE: capture,
      },
    });
    expect((await readFile(capture, "utf8")).trimEnd().split("\n")).toEqual([
      "run",
      "ia-analysis",
      "--repo",
      repositoryPath,
      "--revision",
      REVISION,
      "--scope",
      "page",
      "--target",
      sourcePath,
      "--input-digest",
      pageReceipt.digest,
    ]);
    for (const marker of ["INJECTED", "INJECTED2", "INJECTED3", "INJECTED4"]) {
      expect(await missing(join(repositoryPath, marker))).toBe(true);
    }
    expect(() =>
      planningTaskKey({
        ...task,
        target: { sourcePath, anchor: `${anchor}\0bad` },
      }),
    ).toThrowError(new IaPlanningInputProviderError("invalid-package", "$.task.target"));
  });

  it("recovers through immutable versions from expiry, wrong bindings, stale state, and damaged slots", async () => {
    const scenarios = [
      "expired",
      "wrong-repository",
      "wrong-revision",
      "stale",
      "malformed",
      "tampered",
    ] as const;
    for (const scenario of scenarios) {
      const { repositoryPath, packageRoot } = await fixturePaths();
      const firstIndex = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
      const first = await provisionIaAnalysisInputPackage({
        packageRoot,
        repositoryPath,
        repositoryIdentity: "1".repeat(64),
        task: TASK,
        index: firstIndex,
        navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
        expiresAt: "2026-08-06T12:00:00.000Z",
        now: new Date("2026-08-05T12:00:00.000Z"),
      });
      const sibling = join(packageRoot, planningTaskKey(TASK), "operator-note.txt");
      await writeFile(sibling, "preserved", { mode: 0o600 });
      let revision = REVISION;
      let identity = "1".repeat(64);
      let inspectionNow = new Date("2026-08-05T12:00:00.000Z");
      if (scenario === "expired") inspectionNow = new Date("2026-08-07T12:00:00.000Z");
      if (scenario === "wrong-repository") identity = "2".repeat(64);
      if (scenario === "wrong-revision") revision = "b".repeat(40);
      if (scenario === "stale") {
        await writeFile(join(repositoryPath, "README.md"), "# Recovered state\n");
      }
      if (scenario === "malformed") await writeFile(first.path, "{", { mode: 0o600 });
      if (scenario === "tampered") {
        const value = JSON.parse(await readFile(first.path, "utf8")) as {
          navigationTasks: Array<{ query: string }>;
        };
        value.navigationTasks[0]!.query = "tampered";
        await writeFile(first.path, JSON.stringify(value), { mode: 0o600 });
      }
      const before = await inspectFailure({
        packageRoot,
        repositoryPath,
        revision,
        identity,
        now: inspectionNow,
      });
      expect(before.code).toBe(
        scenario === "malformed"
          ? "invalid-json"
          : scenario === "tampered"
            ? "integrity-mismatch"
            : scenario === "stale"
              ? "stale-package"
              : scenario,
      );

      const recoveredIndex = await buildContentIndex({
        repositoryPath,
        repositoryRevision: revision,
      });
      const recovered = await provisionIaAnalysisInputPackage({
        packageRoot,
        repositoryPath,
        repositoryIdentity: identity,
        task: TASK,
        index: recoveredIndex,
        navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
        expiresAt: "2099-08-10T12:00:00.000Z",
        now: inspectionNow,
      });
      expect(recovered.path).not.toBe(first.path);
      expect(await readFile(sibling, "utf8")).toBe("preserved");
      await expect(
        inspectIaInputPackage({
          packageKind: "analysis-input",
          packageRoot,
          repositoryPath,
          repositoryRevision: revision,
          repositoryIdentity: identity,
          packageDigest: recovered.digest,
          task: TASK,
          now: inspectionNow,
        }),
      ).resolves.toMatchObject({
        digest: recovered.digest,
        nextCommand: expect.stringContaining("docsfab run ia-analysis"),
      });
    }
  });

  it("uses no-clobber version creation under races and requires an exact version when several are valid", async () => {
    const { repositoryPath, packageRoot } = await fixturePaths();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const provision = (expiresAt: string) =>
      provisionIaAnalysisInputPackage({
        packageRoot,
        repositoryPath,
        task: TASK,
        index,
        navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
        expiresAt,
        now: new Date("2026-08-05T12:00:00.000Z"),
      });
    const same = await Promise.all([
      provision("2099-08-10T12:00:00.000Z"),
      provision("2099-08-10T12:00:00.000Z"),
    ]);
    expect(same.filter((item) => item.created)).toHaveLength(1);
    expect(new Set(same.map((item) => item.path)).size).toBe(1);
    const changed = await Promise.all([
      provision("2099-08-11T12:00:00.000Z"),
      provision("2099-08-12T12:00:00.000Z"),
    ]);
    expect(changed.every((item) => item.created)).toBe(true);
    await expect(
      inspectIaInputPackage({
        packageKind: "analysis-input",
        packageRoot,
        repositoryPath,
        repositoryRevision: REVISION,
        task: TASK,
        now: new Date("2026-08-05T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid-package" });
    for (const receipt of [...same, ...changed]) {
      await expect(
        inspectIaInputPackage({
          packageKind: "analysis-input",
          packageRoot,
          repositoryPath,
          repositoryRevision: REVISION,
          packageDigest: receipt.digest,
          task: TASK,
          now: new Date("2026-08-05T12:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        digest: receipt.digest,
        expiresAt: receipt.expiresAt,
        nextCommand: expect.stringContaining(`--input-digest ${receipt.digest}`),
      });
    }
  });
});

async function inspectFailure(input: {
  packageRoot: string;
  repositoryPath: string;
  revision: string;
  identity: string;
  now: Date;
}): Promise<IaPlanningInputProviderError> {
  try {
    await inspectIaInputPackage({
      packageKind: "analysis-input",
      packageRoot: input.packageRoot,
      repositoryPath: input.repositoryPath,
      repositoryRevision: input.revision,
      repositoryIdentity: input.identity,
      task: TASK,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof IaPlanningInputProviderError) return error;
    throw error;
  }
  throw new Error("Expected package inspection to fail.");
}

function provider(packageRoot: string): LocalIaPlanningInputProvider {
  return new LocalIaPlanningInputProvider({
    packageRoot,
    repositoryRevision: REVISION,
  });
}

function analysisProvider(packageRoot: string): LocalIaAnalysisInputProvider {
  return new LocalIaAnalysisInputProvider({ packageRoot, repositoryRevision: REVISION });
}

async function fixturePaths(): Promise<{
  repositoryPath: string;
  packageRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-ia-input-provider-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { mode: 0o700 });
  await writeFile(join(repositoryPath, "README.md"), "# DocsFab\n\nSource evidence.\n");
  await writeFile(join(repositoryPath, "GUIDE.md"), "# Guide\n\nMore source evidence.\n");
  return { repositoryPath, packageRoot: join(root, "planning-inputs") };
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function evaluatedInput(
  index: ContentIndexV1,
  planId = "plan:site:create",
): IaPlanningPackageInput {
  const document = index.nodes.find((node): node is DocumentNode => node.kind === "document");
  if (!document) throw new Error("Missing fixture document.");
  const sourceEvidence = [{ path: document.sourcePath, nodeId: document.id }];
  const evaluated = passedIaEvaluationFixture(index);
  return {
    planId,
    ontology: evaluated.ontology,
    candidates: evaluated.candidates,
    evaluation: evaluated.evaluation,
    evaluationInput: evaluated.evaluationInput,
    navigationEvaluation: evaluated.navigationEvaluation,
    useCases: [
      {
        id: "use-case:start",
        actor: "Reader",
        trigger: "DocsFab is available",
        goal: "Get started",
        input: "A repository",
        outcome: "A working setup",
        evidence: sourceEvidence,
      },
    ],
    redirects: [],
    inboundLinkConsequences: [],
    policyBindings: [{ id: "policy:ia", version: "1", digest: "d".repeat(64) }],
    requiredApproval: "maintainer",
    expiresAt: "2099-08-10T12:00:00.000Z",
    plannedPages: [
      {
        topicId: "topic:get-started",
        title: "Get started",
        slug: "get-started",
        templateId: "template:tutorial",
        format: "gfm",
        outputPath: "docs/get-started.md",
        evidence: sourceEvidence,
      },
    ],
    migrationDispositions: [],
  };
}

function referenceFor<K extends Artifact["kind"]>(
  artifact: Extract<Artifact, { kind: K }>,
): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}
