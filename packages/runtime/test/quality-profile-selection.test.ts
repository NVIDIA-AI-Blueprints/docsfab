// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QualityProfileSelectionError,
  decodeQualityProfileSelectionReceipt,
  selectDocumentationQualityProfile,
} from "../src/evaluation-report/quality-profile-selection.js";
import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { resolveLocalReviewScope } from "../src/workflow-execution/local-review-scope.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { temporaryRoots } from "./helpers/temp.js";

/** Lets one test hand selection a non-exact target, to prove the self-check refuses it. */
const targetOverride = vi.hoisted(() => ({
  derive: undefined as
    | undefined
    | ((input: unknown) => Array<{ path: string; directory: boolean; pageCount: number }>),
}));
vi.mock("../src/evaluation-report/evaluation-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/evaluation-report/evaluation-target.js")>();
  return {
    ...actual,
    deriveEvaluationTarget: (input: Parameters<typeof actual.deriveEvaluationTarget>[0]) =>
      targetOverride.derive ? targetOverride.derive(input) : actual.deriveEvaluationTarget(input),
  };
});

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await roots.cleanup();
});

async function verifiedPack() {
  return verifyQualityPackContext({
    qualityDirectory: `${runtimeRoot}/quality`,
    qualityPackDirectory: `${runtimeRoot}/quality-pack`,
    skillCrateDirectory: `${runtimeRoot}/skill-crate`,
  });
}

async function target(paths: string[] = ["README.md", "docs/guide.md"], binary = false) {
  const repository = await roots.create("docsfab-quality-selection-");
  const files: Record<string, string | Uint8Array> = {
    "package.json": '{"name":"quality-selection-fixture"}\n',
  };
  for (const path of paths) files[path] = `# ${path}\n\nDeterministic documentation.\n`;
  if (binary) files["diagram.png"] = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await initFixtureRepo(repository, files);
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  workspaces.push(workspace);
  return {
    workspace,
    inventory: await buildRepositoryDiscoveryInventory({ workspace }),
    workflow: getWorkflow("review-documentation"),
  };
}

describe("review-documentation quality profile selection", () => {
  it("binds natural-language and CLI page selection to the same exact quality target", async () => {
    const fixture = await target();
    const pack = await verifiedPack();
    const natural = resolveLocalReviewScope({
      inventory: fixture.inventory,
      instruction: "Review exactly `docs/guide.md`. Remain read-only.",
    })!;
    expect(
      resolveLocalReviewScope({ inventory: fixture.inventory, sourcePath: "./docs/guide.md" }),
    ).toEqual(natural);
    expect(natural).toMatchObject({ targetPaths: ["docs/guide.md"], corpusFileCount: 2 });
    const selected = await selectDocumentationQualityProfile({
      ...fixture,
      pack,
      targetPaths: natural.targetPaths,
    });
    expect(selected.documentationPaths).toEqual(["docs/guide.md"]);
    expect(selected.receipt.documentCount).toBe(1);
    expect(selected.focused).toBe(true);
    const whole = await selectDocumentationQualityProfile({ ...fixture, pack });
    expect(selected.receipt.targetPathSetSha256).not.toBe(whole.receipt.targetPathSetSha256);
    expect(selected.receipt.selectionSha256).not.toBe(whole.receipt.selectionSha256);
    const multiple = resolveLocalReviewScope({
      inventory: fixture.inventory,
      instruction: "Review docs/guide.md#start, README.md and docs/guide.md.",
    });
    expect(multiple?.targetPaths).toEqual(["README.md", "docs/guide.md"]);
    expect(
      resolveLocalReviewScope({
        inventory: fixture.inventory,
        instruction: "Review all documentation; see https://example.test/reference.md.",
      }),
    ).toBeUndefined();
  });

  it("rejects missing named targets without silently broadening or dropping them", async () => {
    const fixture = await target();
    for (const instruction of [
      "Review missing.md",
      "Review docs/guide.md and missing.md",
      "Review ../README.md",
    ]) {
      expect(() => resolveLocalReviewScope({ inventory: fixture.inventory, instruction })).toThrow(
        "Review target selection failed",
      );
    }
    expect(() => resolveLocalReviewScope({ inventory: fixture.inventory, sourcePath: "" })).toThrow(
      "Review target selection failed",
    );
    const pack = await verifiedPack();
    for (const targetPaths of [[], ["missing.md"], ["README.md", "README.md"]]) {
      await expect(
        selectDocumentationQualityProfile({ ...fixture, pack, targetPaths }),
      ).rejects.toEqual(new QualityProfileSelectionError());
    }
  });

  it("does not turn supporting references or whole-set qualifiers into focused targets", async () => {
    const { inventory } = await target();
    for (const instruction of [
      "Review docs/guide.md using README.md as supporting evidence",
      "Review the entire documentation set, especially docs/guide.md",
      "Review docs/guide.md but exclude README.md",
      "Review docs/guide.md, not README.md",
      "Review docs/guide.md. Do not review README.md",
    ]) {
      expect(() => resolveLocalReviewScope({ inventory, instruction })).toThrow(
        "selection is ambiguous",
      );
      expect(
        resolveLocalReviewScope({ inventory, instruction, sourcePath: "docs/guide.md" })
          ?.targetPaths,
      ).toEqual(["docs/guide.md"]);
    }
  });

  it("seals the exact experimental profile and deterministic document inventory", async () => {
    const fixture = await target();
    const selected = await selectDocumentationQualityProfile({
      ...fixture,
      pack: await verifiedPack(),
    });

    expect(selected.receipt).toMatchObject({
      profileBarId: "profile:docsfab-documentation-quality",
      profileId: "docsfab-documentation-quality",
      profileVersion: "v0.1",
      profileModel: "documentation-quality-model-v0.2",
      profileStatus: "experimental",
      releaseGateEligible: false,
      profilePayloadSha256: "579023cebc031149d559c070e86dfc0c43f596c0dac8fa68eb2f8dd65ad555a1",
      documentCount: 2,
      targetScope: "documentation-set",
    });
    expect(selected.receipt.repositoryRevision).toBe(fixture.workspace.revision);
    expect(selected.receipt.qualityPackManifestSha256).toBe(selected.pack.evidence.manifestSha256);
    expect(selected.receipt.qualityLockSha256).toBe(selected.pack.evidence.qualityLockSha256);
    expect(decodeQualityProfileSelectionReceipt(selected.receipt)).toEqual(selected.receipt);
    expect(() =>
      decodeQualityProfileSelectionReceipt({ ...selected.receipt, schemaVersion: 2 }),
    ).toThrowError(expect.objectContaining({ code: "migration-required" }));
    expect(JSON.stringify(selected.receipt)).not.toContain("required_dimensions_by_layer");
    expect(selected.documentationPaths).toEqual(["README.md", "docs/guide.md"]);
  });

  it("fails before inference for a revision mismatch or empty recognized documentation set", async () => {
    const pack = await verifiedPack();
    const fixture = await target();
    await expect(
      selectDocumentationQualityProfile({
        ...fixture,
        workspace: { ...fixture.workspace, revision: "d".repeat(40) },
        pack,
      }),
    ).rejects.toEqual(new QualityProfileSelectionError());
    const empty = await target([]);
    await expect(
      selectDocumentationQualityProfile({
        ...empty,
        pack,
      }),
    ).rejects.toEqual(new QualityProfileSelectionError());
  });

  it("rejects missing, duplicate, wrong-kind, or digest-mismatched locked profile entries", async () => {
    const pack = await verifiedPack();
    const fixture = await target();
    const selectedBar = pack.qualityLock.bars.find(
      (bar) => bar.id === "profile:docsfab-documentation-quality",
    )!;
    const unrelatedBars = pack.qualityLock.bars.filter((bar) => bar !== selectedBar);
    const profileFile = pack.qualityLock.files.find(
      (file) => file.path === "profiles/docsfab-documentation-quality/profile.json",
    )!;
    const cases = [
      { ...pack.qualityLock, bars: unrelatedBars },
      { ...pack.qualityLock, bars: [...pack.qualityLock.bars, { ...selectedBar }] },
      {
        ...pack.qualityLock,
        bars: pack.qualityLock.bars.map((bar) =>
          bar === selectedBar ? { ...bar, kind: "rubric" as const } : bar,
        ),
      },
      {
        ...pack.qualityLock,
        files: pack.qualityLock.files.map((file) =>
          file === profileFile ? { ...file, sha256: "d".repeat(64) } : file,
        ),
      },
    ];

    for (const qualityLock of cases) {
      await expect(
        selectDocumentationQualityProfile({
          ...fixture,
          pack: { ...pack, qualityLock },
        }),
      ).rejects.toEqual(new QualityProfileSelectionError());
    }
  });

  it("selects the evaluation profile the locked declaration names, not a source constant", async () => {
    const pack = await verifiedPack();
    const fixture = await target();
    const declared = pack.qualityLock.productDefaults.evaluation;
    const selected = await selectDocumentationQualityProfile({ ...fixture, pack });
    expect(selected.receipt).toMatchObject({
      profileBarId: declared.barId,
      profileAssetPath: declared.assetPath,
      profileId: declared.profileId,
      profileVersion: declared.version,
    });
    // Receipt v1 records one evaluation profile identity, so a declaration
    // naming any other profile refuses instead of selecting the old one.
    const style = pack.qualityLock.productDefaults.style;
    const qualityLock = {
      ...pack.qualityLock,
      productDefaults: {
        ...pack.qualityLock.productDefaults,
        evaluation: {
          ...declared,
          barId: style.barId,
          profileId: style.profileId,
          version: style.version,
          assetPath: style.assetPath,
        },
      },
    };
    await expect(
      selectDocumentationQualityProfile({ ...fixture, pack: { ...pack, qualityLock } }),
    ).rejects.toEqual(new QualityProfileSelectionError());
  });

  it("selects the locked profile despite unrelated binary discovery gaps", async () => {
    const fixture = await target(["README.md", "docs/guide.md"], true);
    expect(fixture.inventory.status).toBe("incomplete");
    const selected = await selectDocumentationQualityProfile({
      ...fixture,
      pack: await verifiedPack(),
    });
    expect(selected.documentationPaths).toEqual(["README.md", "docs/guide.md"]);
    expect(selected.receipt.inventorySha256).toBe(fixture.inventory.inventorySha256);
    expect(selected.discoveryLimitations).toEqual([
      expect.stringContaining("Repository discovery is incomplete"),
    ]);
    expect(decodeQualityProfileSelectionReceipt(selected.receipt)).toEqual(selected.receipt);
  });

  it("rejects ambiguous documentation inventory evidence", async () => {
    const fixture = await target();
    await expect(
      selectDocumentationQualityProfile({
        ...fixture,
        inventory: structuredClone(fixture.inventory),
        pack: await verifiedPack(),
      }),
    ).rejects.toEqual(new QualityProfileSelectionError());
  });

  it("rejects a substituted sealed receipt", async () => {
    const fixture = await target();
    const selected = await selectDocumentationQualityProfile({
      ...fixture,
      pack: await verifiedPack(),
    });
    expect(() =>
      decodeQualityProfileSelectionReceipt({ ...selected.receipt, documentCount: 3 }),
    ).toThrow(QualityProfileSelectionError);
  });

  it("stops the review-documentation CLI path as quality-profile-selection-invalid before any harness call", async () => {
    const fixture = await target([]);
    const stateDirectory = await roots.create("docsfab-quality-selection-state-");
    const harness = unreachableHarness();
    await expect(
      executeRunRequest(
        {
          workflow: "review-documentation",
          repositoryPath: fixture.workspace.sourcePath,
          revision: "HEAD",
          instruction: "Review this package's existing user documentation.",
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(stateDirectory),
        { silent: true, harness },
      ),
    ).rejects.toEqual(new QualityProfileSelectionError());
    expect(harness.calls).toBe(0);
  }, 30_000);

  it("binds the step 8 evaluation target with the selection, focused and unfocused", async () => {
    const fixture = await target();
    const pack = await verifiedPack();
    const whole = await selectDocumentationQualityProfile({ ...fixture, pack });
    expect(whole.evaluationTarget).toEqual([
      { path: "README.md", directory: false, pageCount: 1 },
      { path: "docs", directory: true, pageCount: 1 },
    ]);
    const focused = await selectDocumentationQualityProfile({
      ...fixture,
      targetPaths: ["docs/guide.md"],
      pack,
    });
    expect(focused.evaluationTarget).toEqual([
      { path: "docs/guide.md", directory: false, pageCount: 1 },
    ]);
  });

  it("refuses a derived target that is not an exact cover of the scope", async () => {
    const fixture = await target(["README.md", "docs/guide.md", "docs/setup.md"]);
    const pack = await verifiedPack();
    const nonExact = [
      // Misses docs/setup.md.
      [
        { path: "README.md", directory: false, pageCount: 1 },
        { path: "docs/guide.md", directory: false, pageCount: 1 },
      ],
      // The repository root.
      [{ path: ".", directory: true, pageCount: 3 }],
      // Covers a path that is not a scope page.
      [
        { path: "README.md", directory: false, pageCount: 1 },
        { path: "docs", directory: true, pageCount: 2 },
        { path: "package.json", directory: false, pageCount: 1 },
      ],
    ];
    try {
      for (const entries of nonExact) {
        targetOverride.derive = () => entries;
        await expect(selectDocumentationQualityProfile({ ...fixture, pack })).rejects.toEqual(
          new QualityProfileSelectionError(),
        );
      }
    } finally {
      targetOverride.derive = undefined;
    }
    // Positive control: the real derivation passes the same self-check.
    await expect(selectDocumentationQualityProfile({ ...fixture, pack })).resolves.toMatchObject({
      evaluationTarget: [
        { path: "README.md", directory: false, pageCount: 1 },
        { path: "docs", directory: true, pageCount: 2 },
      ],
    });
  });

  it(
    "refuses a target above reviewScope.maxTargets before inference on both shipped paths",
    async () => {
      const pack = await verifiedPack();
      // Root pages never collapse, so each is one target entry.
      const pages = (count: number) =>
        Array.from({ length: count }, (_, index) => `page-${String(index).padStart(3, "0")}.md`);
      const over = await target(pages(257));
      // Positive control at the bound: a focused selection of 256 of those pages.
      await expect(
        selectDocumentationQualityProfile({ ...over, targetPaths: pages(256), pack }),
      ).resolves.toMatchObject({ receipt: { documentCount: 256 } });
      const refusal =
        "review-scope-max-targets-bound: 257 exceeds reviewScope.maxTargets = 256 count.";
      await expect(selectDocumentationQualityProfile({ ...over, pack })).rejects.toThrow(refusal);

      // The CLI preflight (cli/run/execution.ts) refuses before any harness call.
      const stateDirectory = await roots.create("docsfab-quality-selection-state-");
      const harness = unreachableHarness();
      await expect(
        executeRunRequest(
          {
            workflow: "review-documentation",
            repositoryPath: over.workspace.sourcePath,
            revision: "HEAD",
            instruction: "Review this package's existing user documentation.",
            allowWrite: false,
            releaseGate: false,
            verbose: false,
            json: false,
            showScan: false,
          },
          runtimeConfig(stateDirectory),
          { silent: true, harness },
        ),
      ).rejects.toThrow(refusal);
      expect(harness.calls).toBe(0);

      // The local service assembly (application/dependencies.ts) refuses the same way.
      const assemblyHarness = unreachableHarness();
      await expect(
        createLocalWorkflowApplicationServices({
          config: {
            stateDirectory: resolve(stateDirectory, "assembly", "runs"),
            skillCrateDirectory: `${runtimeRoot}/skill-crate`,
            qualityDirectory: `${runtimeRoot}/quality`,
            qualityPackDirectory: `${runtimeRoot}/quality-pack`,
          },
          request: { workflow: "review-documentation" },
          workflow: over.workflow,
          workspace: over.workspace,
          repositoryEvidence: {},
          baseHarness: assemblyHarness,
        } as never),
      ).rejects.toThrow(refusal);
      expect(assemblyHarness.calls).toBe(0);
    },
    testTimeoutMs(120_000),
  );
});

function unreachableHarness(): AgentHarness & { calls: number } {
  const harness = {
    calls: 0,
    async inspectSkill() {
      harness.calls += 1;
      throw new Error("Harness inspectSkill must not run after quality-profile-selection-invalid.");
    },
    async runStep() {
      harness.calls += 1;
      throw new Error("Harness runStep must not run after quality-profile-selection-invalid.");
    },
  };
  return harness;
}

describe("authoring quality profile admission", () => {
  it.each(["create-documentation", "update-documentation"] as const)(
    "selects a locked quality profile for exact %s final candidate scope",
    async (name) => {
      const fixture = await target(["docs/cli-reference.md"]);
      const selected = await selectDocumentationQualityProfile({
        ...fixture,
        workflow: getWorkflow(name),
        pack: await verifiedPack(),
        targetPaths: ["docs/cli-reference.md"],
      });
      expect(selected.receipt.workflow).toBe(name);
      expect(decodeQualityProfileSelectionReceipt(selected.receipt)).toEqual(selected.receipt);
      expect(selected.documentationPaths).toEqual(["docs/cli-reference.md"]);
      expect(selected.receipt.selectorId).toBe(`${name}:docsfab-documentation-quality:v1`);
    },
  );
});
