// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { copyJsOnlyDistModules } from "../scripts/js-only-dist-modules.mjs";
import { resolveTypeScriptCompiler } from "../scripts/resolve-typescript-compiler.mjs";
import { canonicalDigest, canonicalJson } from "../src/content-ir/index.js";
import { buildContentIndexV2 } from "../src/content-ir/indexer.js";
import type { RunRecord } from "../src/records/contracts.js";
import { provisionDefaultIaAnalysisInput } from "../src/ia/lifecycle.js";
import { createImpactAnalysis } from "../src/impact/contracts.js";
import * as maturityPublic from "../src/maturity/index.js";
import {
  DOCUMENTATION_MATURITY_EVALUATOR_CATALOG,
  DOCUMENTATION_MATURITY_DEFECT_CLASSES,
  DOCUMENTATION_MATURITY_HOST_POLICY_PATH,
  DocumentationMaturityEvaluatorError,
  decodeDocumentationMaturityEvaluatorCatalog,
  decodeDocumentationMaturityGateEvaluation,
  documentationMaturityEvaluator,
  evaluateDocumentationMaturityGate,
  mapRepositoryInventoryToG0,
  mapContentIndexToG3,
  mapImpactAnalysisToMaturity,
  mapIaCapabilitiesToG2,
  mapIaSelfServiceInputToG2,
  mapRoadmapLedgerToG5,
  mapWorkflowOutcomeToMaturity,
  validateDocumentationMaturityGateEvaluation,
} from "../src/maturity/index.js";
import { assertInertPlainData } from "../src/maturity/evaluators/dialect.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { createRoadmapLedger } from "../src/roadmap/contracts/ledger.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import type { WorkflowOutcomeCandidateV1 } from "../src/workflow-contracts/contracts.js";
import { git, initFixtureRepo } from "./helpers/git.js";

const exec = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("documentation maturity evaluator mapping", () => {
  it("rejects proxies before inert-data normalization invokes their traps", () => {
    let proxyCalls = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          proxyCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          proxyCalls += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          proxyCalls += 1;
          return undefined;
        },
      },
    );

    expect(() => assertInertPlainData(proxy)).toThrowErrorCode("invalid-source");
    expect(proxyCalls).toBe(0);
  });

  it("rejects cyclic plain data before undefined-leaf normalization recurses", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => assertInertPlainData(cyclic)).toThrowErrorCode("invalid-source");
  });

  it("publishes deterministic G0-G5 mappings with explicit inputs, checks, semantics, and limits", () => {
    const knownAnswer = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/runtime-evaluation/maturity/evaluator-catalog-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect({
      schemaVersion: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.schemaVersion,
      catalogVersion: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.version,
      gateOrder: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.evaluators.map((item) => item.gateId),
      applicability: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.evaluators.map(
        (item) => item.applicability,
      ),
      checkCounts: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.evaluators.map(
        (item) => item.checks.length,
      ),
      defectClasses: [...DOCUMENTATION_MATURITY_DEFECT_CLASSES].sort(),
      forbiddenEvidence: [
        ...DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.evaluators[0]!.evidenceLimits.forbidden,
      ].sort(),
    }).toEqual(knownAnswer);
    expect(DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.evaluators.map((item) => item.gateId)).toEqual([
      "G0",
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
    ]);
    expect(
      DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.evaluators.every(
        (item) =>
          item.inputs.length > 0 &&
          item.checks.length > 0 &&
          (item.inputs.some((input) => input.layer === "semantic")
            ? item.semanticReview?.policy === "optional-after-deterministic"
            : item.semanticReview === null) &&
          item.checks.every((check) =>
            check.sourceInputIds.every((inputId) =>
              item.inputs.some((input) => input.id === inputId && input.layer === "deterministic"),
            ),
          ) &&
          item.evidenceLimits.forbidden.includes("folder-name-applicability") &&
          item.evaluatorSha256 === canonicalDigest(without(item, "evaluatorSha256")),
      ),
    ).toBe(true);
    expect(DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.catalogSha256).toBe(
      canonicalDigest(without(DOCUMENTATION_MATURITY_EVALUATOR_CATALOG, "catalogSha256")),
    );
    expect(documentationMaturityEvaluator("G3").checks.map((item) => item.id)).toEqual([
      "article-completeness",
      "article-modularity",
      "article-accuracy",
      "article-freshness",
    ]);
    expect(documentationMaturityEvaluator("G4").checks.map((item) => item.id)).toEqual([
      "presentation-polish",
      "examples",
      "accessibility",
      "consistency",
    ]);
    expect(
      documentationMaturityEvaluator("G5").inputs.find((item) => item.id === "roadmap"),
    ).toMatchObject({ contract: "docsfab-roadmap-ledger@1", layer: "deterministic" });
    expect(documentationMaturityEvaluator("G5").semanticReview).toBeNull();
  });

  it("rejects a huge sparse inert-data array without expanding its declared length", () => {
    const sparse: unknown[] = [];
    sparse.length = 0xffff_ffff;
    sparse[0] = DOCUMENTATION_MATURITY_EVALUATOR_CATALOG;
    expect(() => decodeDocumentationMaturityEvaluatorCatalog(sparse)).toThrowErrorCode(
      "invalid-source",
    );
  });

  it("rejects huge sparse and hidden evaluator evidence sequences before expansion", async () => {
    const repository = {
      sourcePath: "/tmp/repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    };
    const huge: unknown[] = [];
    huge.length = 0xffff_ffff;
    huge[0] = {};
    await expect(
      evaluateDocumentationMaturityGate({
        gateId: "G0",
        repository,
        policyWorkspace: null,
        mappings: huge as never,
      }),
    ).rejects.toMatchObject({ code: "evidence-limit-exceeded" });

    const hidden = [{}];
    Object.defineProperty(hidden, "0", { value: {}, enumerable: false });
    await expect(
      evaluateDocumentationMaturityGate({
        gateId: "G0",
        repository,
        policyWorkspace: null,
        mappings: hidden as never,
      }),
    ).rejects.toMatchObject({ code: "invalid-source" });
  });

  it("ships no deep-importable product-need or modularity authority issuer", async () => {
    const compilationRoot = await mkdtemp(join(tmpdir(), "docsfab-maturity-dist-"));
    temporary.push(compilationRoot);
    await writeFile(join(compilationRoot, "package.json"), canonicalJson({ type: "module" }));
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const outputRoot = join(compilationRoot, "dist");
    await exec(
      resolveTypeScriptCompiler(),
      [
        "-p",
        join(repositoryRoot, "tsconfig.json"),
        "--outDir",
        outputRoot,
        "--declaration",
        "false",
        "--sourceMap",
        "false",
      ],
      { cwd: repositoryRoot },
    );
    await copyJsOnlyDistModules(repositoryRoot, outputRoot);
    const evaluatorModule = (await import(
      `${pathToFileURL(join(outputRoot, "maturity", "evaluators.js")).href}?fixture=${Date.now()}`
    )) as Record<string, unknown>;
    const indexModule = (await import(
      `${pathToFileURL(join(outputRoot, "maturity", "index.js")).href}?fixture=${Date.now()}`
    )) as Record<string, unknown>;
    const formerIssuers = [
      "createDocumentationProductNeedAuthority",
      "internalCreateDocumentationProductNeedHostAuthority",
      "internalIssueDocumentationProductNeedCapability",
      "internalCreateDocumentationModularityPolicyHostAuthority",
      "internalIssueDocumentationModularityPolicyCapability",
    ];
    for (const name of formerIssuers) {
      expect(evaluatorModule[name]).toBeUndefined();
      expect(indexModule[name]).toBeUndefined();
    }
    await expect(
      import(
        `${
          pathToFileURL(join(outputRoot, "maturity", "evaluator-authority-internal.js")).href
        }?fixture=${Date.now()}`
      ),
    ).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
  }, 30_000);

  it("adapts authentic inventory to G0 and emits validated non-mutating #101 work", async () => {
    const fixture = await repositoryFixture({ documentation: true, validation: true });
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const repository = {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      };
      const mapping = mapRepositoryInventoryToG0({ inventory, repository });
      const evaluation = await evaluateDocumentationMaturityGate({
        gateId: "G0",
        repository,
        policyWorkspace: null,
        mappings: [mapping],
      });
      expect(evaluation.disposition).toBe("satisfied");
      expect(evaluation.checks.every((check) => check.state === "satisfied")).toBe(true);
      expect(evaluation.findings).toEqual([]);
      expect(evaluation.workUnits).toEqual([]);
      expect(evaluation.trackerMutation).toBe("not-authorized");
      expect(Object.isFrozen(evaluation.checks[0])).toBe(true);
      expect(decodeDocumentationMaturityGateEvaluation(structuredClone(evaluation))).toEqual(
        evaluation,
      );
      expect(
        await validateDocumentationMaturityGateEvaluation(structuredClone(evaluation), {
          gateId: "G0",
          repository,
          policyWorkspace: null,
          mappings: [mapping],
        }),
      ).toEqual(evaluation);

      const rehashed = structuredClone(evaluation);
      rehashed.checks[0]!.state = "blocked";
      rehashed.evaluationSha256 = canonicalDigest(without(rehashed, "evaluationSha256"));
      expect(() => decodeDocumentationMaturityGateEvaluation(rehashed)).toThrowErrorCode(
        "invalid-mapping",
      );

      const duplicateCheck = structuredClone(evaluation);
      duplicateCheck.checks.splice(1, 0, structuredClone(duplicateCheck.checks[0]!));
      duplicateCheck.evaluationSha256 = canonicalDigest(
        without(duplicateCheck, "evaluationSha256"),
      );
      expect(() => decodeDocumentationMaturityGateEvaluation(duplicateCheck)).toThrowErrorCode(
        "invalid-mapping",
      );

      const reorderedChecks = structuredClone(evaluation);
      reorderedChecks.checks.reverse();
      reorderedChecks.evaluationSha256 = canonicalDigest(
        without(reorderedChecks, "evaluationSha256"),
      );
      expect(() => decodeDocumentationMaturityGateEvaluation(reorderedChecks)).toThrowErrorCode(
        "invalid-mapping",
      );

      const extraNested = structuredClone(evaluation) as typeof evaluation & {
        checks: Array<(typeof evaluation.checks)[number] & { promptClaim?: string }>;
      };
      extraNested.checks[0]!.promptClaim = "trust me";
      extraNested.evaluationSha256 = canonicalDigest(without(extraNested, "evaluationSha256"));
      expect(() => decodeDocumentationMaturityGateEvaluation(extraNested)).toThrowErrorCode(
        "invalid-mapping",
      );

      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G0",
          repository,
          policyWorkspace: null,
          mappings: [structuredClone(mapping)],
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });
    } finally {
      await workspace.dispose();
    }
  });

  it("keeps absent documentation conditional on product need and distinguishes infrastructure", async () => {
    const fixture = await repositoryFixture({ documentation: false, validation: false });
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const repository = {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      };
      expect("createDocumentationProductNeedAuthority" in maturityPublic).toBe(false);
      const mapping = mapRepositoryInventoryToG0({ inventory, repository });
      const evaluation = await evaluateDocumentationMaturityGate({
        gateId: "G0",
        repository,
        policyWorkspace: null,
        mappings: [mapping],
      });
      expect(evaluation.disposition).toBe("not-ready");
      expect(
        evaluation.checks.find((item) => item.checkId === "documentation-input-surface"),
      ).toMatchObject({
        state: "unknown",
        defectClass: "missing-content",
        limitationCodes: ["documentation-product-need-unresolved"],
      });
      expect(
        evaluation.checks.find((item) => item.checkId === "validation-infrastructure"),
      ).toMatchObject({ state: "finding", defectClass: "missing-infrastructure" });
      expect(evaluation.findings).toHaveLength(1);
      expect(evaluation.findings[0]).toMatchObject({
        gateId: "G0",
        findingKey: "validation-infrastructure",
        disposition: "observed-absence",
      });
      expect(evaluation.workUnits).toHaveLength(1);
      expect(evaluation.workUnits[0]).toMatchObject({
        trackerMutation: "not-authorized",
        execution: { state: "ready" },
        workflow: { name: "readiness", stepId: "assess-readiness" },
      });
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects self-rehashed workflow outcomes until the harness provides producer authority", async () => {
    const fixture = await repositoryFixture({ documentation: true, validation: true });
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    try {
      const repository = {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      };
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const deterministic = mapRepositoryInventoryToG0({ inventory, repository });
      const record = workflowOutcomeRecord(repository, "not-ready");
      expect(() =>
        mapWorkflowOutcomeToMaturity({
          gateId: "G0",
          record,
        }),
      ).toThrowErrorCode("invalid-source");
      const evaluation = await evaluateDocumentationMaturityGate({
        gateId: "G0",
        repository,
        policyWorkspace: null,
        mappings: [deterministic],
      });
      expect(evaluation.checks.every((check) => check.state === "satisfied")).toBe(true);
      expect(evaluation.semanticReviews).toEqual([]);
      expect(evaluation.disposition).toBe("satisfied");
      expect(decodeDocumentationMaturityGateEvaluation(structuredClone(evaluation))).toEqual(
        evaluation,
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("uses explicit repository/documentation type authority instead of a docs-folder heuristic", async () => {
    const notRequiredFixture = await repositoryFixture({
      documentation: false,
      validation: true,
      policy: { documentationType: "none", need: "not-required" },
    });
    const requiredFixture = await repositoryFixture({
      documentation: false,
      validation: true,
      policy: { documentationType: "operator-guide", need: "required" },
    });
    const unknownFixture = await repositoryFixture({
      documentation: false,
      validation: true,
      policy: { documentationType: "unknown", need: "unknown" },
    });
    const g2OnlyFixture = await repositoryFixture({
      documentation: false,
      validation: true,
      policy: { documentationType: "operator-guide", need: "required", gateIds: ["G2"] },
    });
    const [workspace, requiredWorkspace, unknownWorkspace, g2OnlyWorkspace] = await Promise.all([
      prepareRepositoryWorkspace(notRequiredFixture, "HEAD"),
      prepareRepositoryWorkspace(requiredFixture, "HEAD"),
      prepareRepositoryWorkspace(unknownFixture, "HEAD"),
      prepareRepositoryWorkspace(g2OnlyFixture, "HEAD"),
    ]);
    let successorWorkspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
    try {
      const repository = {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      };
      const evaluation = await evaluateDocumentationMaturityGate({
        gateId: "G1",
        repository,
        policyWorkspace: workspace,
        mappings: [],
      });
      expect(evaluation).toMatchObject({
        applicability: "not-applicable",
        disposition: "not-applicable",
        findings: [],
        workUnits: [],
      });

      const requiredRepository = repositoryFor(requiredWorkspace);
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository: requiredRepository,
          policyWorkspace: requiredWorkspace,
          mappings: [],
        }),
      ).resolves.toMatchObject({ applicability: "applicable", disposition: "unknown" });
      const unknownRepository = repositoryFor(unknownWorkspace);
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository: unknownRepository,
          policyWorkspace: unknownWorkspace,
          mappings: [],
        }),
      ).resolves.toMatchObject({ applicability: "unknown", disposition: "unknown" });

      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository: { ...repository, sourcePath: `${repository.sourcePath}-substituted` },
          policyWorkspace: workspace,
          mappings: [],
        }),
      ).rejects.toMatchObject({ code: "repository-mismatch" });
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository,
          policyWorkspace: { ...workspace } as never,
          mappings: [],
        }),
      ).rejects.toMatchObject({ code: "invalid-product-need" });
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository: repositoryFor(g2OnlyWorkspace),
          policyWorkspace: g2OnlyWorkspace,
          mappings: [],
        }),
      ).rejects.toMatchObject({ code: "invalid-product-need" });

      await writeFile(
        join(notRequiredFixture, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
        canonicalJson(hostPolicy({ documentationType: "operator-guide", need: "required" })),
      );
      await git(notRequiredFixture, ["add", DOCUMENTATION_MATURITY_HOST_POLICY_PATH]);
      await git(notRequiredFixture, ["commit", "-qm", "required policy revision"]);
      successorWorkspace = await prepareRepositoryWorkspace(notRequiredFixture, "HEAD");
      const successorRepository = repositoryFor(successorWorkspace);
      expect(successorRepository.revision).not.toBe(repository.revision);
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository: successorRepository,
          policyWorkspace: successorWorkspace,
          mappings: [],
        }),
      ).resolves.toMatchObject({ applicability: "applicable", disposition: "unknown" });

      const substituted = hostPolicy({ documentationType: "operator-guide", need: "required" });
      await writeFile(
        join(workspace.path, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
        canonicalJson(substituted),
      );
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository,
          policyWorkspace: workspace,
          mappings: [],
        }),
      ).rejects.toMatchObject({ code: "invalid-product-need" });
    } finally {
      await Promise.all([
        workspace.dispose(),
        requiredWorkspace.dispose(),
        unknownWorkspace.dispose(),
        g2OnlyWorkspace.dispose(),
        ...(successorWorkspace ? [successorWorkspace.dispose()] : []),
      ]);
    }
  });

  it("maps Content IR modularity defects into G3 without semantic invention", async () => {
    const fixture = await repositoryFixture({ documentation: true, validation: true });
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    let thresholdWorkspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
    let laxWorkspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
    try {
      const repository = {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      };
      const index = await buildContentIndexV2({ workspace });
      const forgedIndex = structuredClone(index);
      forgedIndex.nodes = [];
      forgedIndex.edges = [];
      forgedIndex.indexDigest = canonicalDigest({
        schemaVersion: 2,
        repository: forgedIndex.repository,
        nodes: forgedIndex.nodes,
        edges: forgedIndex.edges,
      });
      forgedIndex.evidence = {
        ...forgedIndex.evidence,
        indexDigest: forgedIndex.indexDigest,
        documentCount: 0,
        sectionCount: 0,
        edgeCount: 0,
        assetCount: 0,
      };
      await expect(
        mapContentIndexToG3({
          repository,
          index: forgedIndex,
          policyWorkspace: workspace,
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });

      const mapping = await mapContentIndexToG3({
        repository,
        index,
        policyWorkspace: workspace,
      });
      const evaluation = await evaluateDocumentationMaturityGate({
        gateId: "G3",
        repository,
        policyWorkspace: workspace,
        mappings: [mapping],
      });
      expect(evaluation.disposition).toBe("not-ready");
      expect(evaluation.checks.find((item) => item.checkId === "article-modularity")).toMatchObject(
        { state: "finding", defectClass: "structural-defect" },
      );
      expect(evaluation.findings).toHaveLength(1);
      expect(evaluation.findings[0]!.affectedPaths).toEqual(["guide/start.md"]);
      expect(evaluation.workUnits[0]).toMatchObject({
        workflow: { name: "update-documentation", stepId: "write-documentation" },
        trackerMutation: "not-authorized",
      });

      const racingRepository = { ...repository };
      const racingMappings = [mapping];
      const racingEvaluationPromise = evaluateDocumentationMaturityGate({
        gateId: "G3",
        repository: racingRepository,
        policyWorkspace: workspace,
        mappings: racingMappings,
      });
      racingRepository.sourcePath = `${repository.sourcePath}-substituted`;
      racingMappings.splice(0);
      const racingEvaluation = await racingEvaluationPromise;
      expect(racingEvaluation.repository).toEqual(evaluation.repository);
      expect(racingEvaluation.sourceMappings).toHaveLength(1);
      expect(racingEvaluation.disposition).toBe("not-ready");

      const racingMapRepository = { ...repository };
      const racingIndex = structuredClone(index);
      const racingMapInput: Parameters<typeof mapContentIndexToG3>[0] = {
        repository: racingMapRepository,
        index: racingIndex,
        policyWorkspace: workspace,
      };
      const racingMappingPromise = mapContentIndexToG3(racingMapInput);
      racingMapRepository.sourcePath = `${repository.sourcePath}-substituted`;
      racingIndex.nodes.splice(0);
      racingMapInput.policyWorkspace = null as never;
      const racingMapping = await racingMappingPromise;
      expect(racingMapping.repository).toEqual(mapping.repository);
      expect(racingMapping.checks[0]).toMatchObject({ state: "finding" });
      expect(racingMapping.findings).toHaveLength(1);

      const changedPolicy = structuredClone(mapping);
      changedPolicy.checks[0]!.evidenceSha256s[1] = canonicalDigest("other-policy");
      changedPolicy.mappingSha256 = canonicalDigest(without(changedPolicy, "mappingSha256"));
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G3",
          repository,
          policyWorkspace: workspace,
          mappings: [changedPolicy],
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });

      const laxBody = {
        id: "fixture-modularity",
        version: "2-lax",
        maximumSectionsPerDocument: 10_000,
        maximumSectionDepth: 10_000,
      };
      await expect(
        mapContentIndexToG3({
          repository,
          index,
          policyWorkspace: workspace,
          policy: laxBody,
        } as never),
      ).rejects.toMatchObject({ code: "invalid-source" });

      await writeFile(
        join(workspace.path, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
        canonicalJson(hostPolicy({ modularityPolicy: laxBody })),
      );
      await expect(
        mapContentIndexToG3({
          repository,
          index,
          policyWorkspace: workspace,
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });

      await writeFile(
        join(fixture, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
        canonicalJson(
          hostPolicy({
            modularityPolicy: {
              id: "fixture-modularity",
              version: "2-deeper",
              maximumSectionsPerDocument: 1,
              maximumSectionDepth: 2,
            },
          }),
        ),
      );
      await git(fixture, ["add", DOCUMENTATION_MATURITY_HOST_POLICY_PATH]);
      await git(fixture, ["commit", "-qm", "changed threshold"]);
      thresholdWorkspace = await prepareRepositoryWorkspace(fixture, "HEAD");
      const thresholdRepository = repositoryFor(thresholdWorkspace);
      const thresholdMapping = await mapContentIndexToG3({
        repository: thresholdRepository,
        index: await buildContentIndexV2({ workspace: thresholdWorkspace }),
        policyWorkspace: thresholdWorkspace,
      });
      expect(thresholdMapping.findings).toHaveLength(1);
      expect(thresholdMapping.findings[0]!.scopeSha256).not.toBe(mapping.findings[0]!.scopeSha256);
      expect(thresholdMapping.findings[0]!.fingerprint).not.toBe(mapping.findings[0]!.fingerprint);

      await writeFile(
        join(fixture, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
        canonicalJson(hostPolicy({ modularityPolicy: laxBody })),
      );
      await git(fixture, ["add", DOCUMENTATION_MATURITY_HOST_POLICY_PATH]);
      await git(fixture, ["commit", "-qm", "lax policy revision"]);
      laxWorkspace = await prepareRepositoryWorkspace(fixture, "HEAD");
      const laxRepository = repositoryFor(laxWorkspace);
      expect(laxRepository.revision).not.toBe(repository.revision);
      const laxIndex = await buildContentIndexV2({ workspace: laxWorkspace });
      const laxMapping = await mapContentIndexToG3({
        repository: laxRepository,
        index: laxIndex,
        policyWorkspace: laxWorkspace,
      });
      expect(laxMapping.checks[0]).toMatchObject({ state: "satisfied" });
    } finally {
      await workspace.dispose();
      await thresholdWorkspace?.dispose();
      await laxWorkspace?.dispose();
    }
  }, 20_000);

  it("authenticates only IA Content IR and cannot mint diagnostics from public artifacts", async () => {
    const fixture = await repositoryFixture({ documentation: true, validation: true });
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    try {
      const repository = repositoryFor(workspace);
      const index = await buildContentIndexV2({ workspace });
      const publicDiagnosticsInput = {
        index,
        ontology: { caller: "self-rehashed" },
        candidates: { caller: "self-rehashed" },
        semantics: [{ caller: "self-rehashed" }],
        candidateId: "candidate:caller",
        structure: { caller: "self-rehashed" },
        policy: { caller: "self-rehashed" },
      };
      const mappings = await mapIaCapabilitiesToG2({
        repository,
        workspace,
        diagnosticsInput: publicDiagnosticsInput as never,
      });
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toMatchObject({
        capability: "content-ir",
        checks: [{ checkId: "content-structure-indexed", state: "satisfied" }],
      });
      expect(mappings.some((mapping) => mapping.capability === "ia-diagnostics")).toBe(false);

      const forgedIndex = structuredClone(index);
      forgedIndex.nodes = [];
      forgedIndex.edges = [];
      forgedIndex.indexDigest = canonicalDigest({
        schemaVersion: 2,
        repository: forgedIndex.repository,
        nodes: forgedIndex.nodes,
        edges: forgedIndex.edges,
      });
      forgedIndex.evidence = {
        ...forgedIndex.evidence,
        indexDigest: forgedIndex.indexDigest,
        documentCount: 0,
        sectionCount: 0,
        edgeCount: 0,
        assetCount: 0,
      };
      await expect(
        mapIaCapabilitiesToG2({
          repository,
          workspace,
          diagnosticsInput: { ...publicDiagnosticsInput, index: forgedIndex } as never,
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });
    } finally {
      await workspace.dispose();
    }
  });

  it("fails closed on missing, noncanonical, and duplicate tracked host-policy state", async () => {
    const [missingFixture, noncanonicalFixture, duplicateFixture] = await Promise.all([
      repositoryFixture({ documentation: true, validation: true }),
      repositoryFixture({ documentation: true, validation: true }),
      repositoryFixture({ documentation: true, validation: true }),
    ]);
    await rm(join(missingFixture, DOCUMENTATION_MATURITY_HOST_POLICY_PATH));
    await git(missingFixture, ["add", "-u"]);
    await git(missingFixture, ["commit", "-qm", "missing policy"]);
    await writeFile(
      join(noncanonicalFixture, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
      `${canonicalJson(hostPolicy())}\n`,
    );
    await git(noncanonicalFixture, ["add", DOCUMENTATION_MATURITY_HOST_POLICY_PATH]);
    await git(noncanonicalFixture, ["commit", "-qm", "noncanonical policy"]);
    const duplicatePolicy = hostPolicy();
    duplicatePolicy.modularity.policies.push(
      structuredClone(duplicatePolicy.modularity.policies[0]!),
    );
    await writeFile(
      join(duplicateFixture, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
      canonicalJson(duplicatePolicy),
    );
    await git(duplicateFixture, ["add", DOCUMENTATION_MATURITY_HOST_POLICY_PATH]);
    await git(duplicateFixture, ["commit", "-qm", "duplicate policy"]);
    const workspaces = await Promise.all([
      prepareRepositoryWorkspace(missingFixture, "HEAD"),
      prepareRepositoryWorkspace(noncanonicalFixture, "HEAD"),
      prepareRepositoryWorkspace(duplicateFixture, "HEAD"),
    ]);
    try {
      for (const workspace of workspaces) {
        await expect(
          evaluateDocumentationMaturityGate({
            gateId: "G1",
            repository: repositoryFor(workspace),
            policyWorkspace: workspace,
            mappings: [],
          }),
        ).rejects.toBeInstanceOf(DocumentationMaturityEvaluatorError);
      }
    } finally {
      await Promise.all(workspaces.map((workspace) => workspace.dispose()));
    }
  });

  it("rejects public impact and roadmap contracts before they can collide or degrade a gate", () => {
    const revision = "a".repeat(40);
    const repository = {
      sourcePath: "/tmp/repository",
      requestedRevision: "HEAD",
      revision,
    };
    const impact = createImpactAnalysis({
      schemaVersion: 1,
      mode: "incremental",
      beforeRepository: {
        revision,
        contentDigest: "b".repeat(64),
        indexDigest: "c".repeat(64),
      },
      afterRepository: {
        revision,
        contentDigest: "d".repeat(64),
        indexDigest: "e".repeat(64),
      },
      changedPaths: ["docs/guide.md"],
      changedRegions: ["body"],
      neighborhood: [
        {
          nodeId: "document:docs/guide.md",
          regions: ["body"],
          reasons: ["direct-change"],
        },
      ],
      policy: { id: "policy:impact", version: "1", digest: "f".repeat(64) },
    });
    expect(() =>
      mapImpactAnalysisToMaturity({
        gateId: "G5",
        repository,
        impact,
      }),
    ).toThrowErrorCode("invalid-source");

    const ledger = createRoadmapLedger({
      id: "ledger:maturity-forged",
      repository: { revision, contentDigest: "1".repeat(64) },
      project: {
        provider: "gitlab",
        host: "gitlab.example.com",
        fullPath: "group/repository",
        projectId: 1,
      },
      boundary: {
        id: "boundary:maturity",
        mode: "documentation-health",
        observedAt: "2026-08-05T12:00:00.000Z",
        queryDigest: "2".repeat(64),
      },
      trackerObservedAt: "2026-08-05T12:00:00.000Z",
      tracker: [],
      evidence: [],
      findings: [],
      workstreams: [],
      dedup: [],
      transitions: [],
      sweeps: [
        {
          id: "sweep:maturity",
          observedAt: "2026-08-05T12:00:00.000Z",
          repositoryRevision: revision,
          trackerObservedAt: "2026-08-05T12:00:00.000Z",
          findingFingerprints: [],
          newFindingIds: [],
          disposition: "clean",
        },
      ],
      closeouts: [],
      createdAt: "2026-08-05T12:00:00.000Z",
      updatedAt: "2026-08-05T12:00:00.000Z",
    });
    expect(() => mapRoadmapLedgerToG5({ repository, ledger })).toThrowErrorCode("invalid-source");

    let proxyCalls = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          proxyCalls += 1;
          return Object.prototype;
        },
      },
    );
    expect(() =>
      mapImpactAnalysisToMaturity({
        gateId: "G5",
        repository,
        impact: proxy as never,
      }),
    ).toThrowErrorCode("invalid-source");
    expect(() =>
      mapRoadmapLedgerToG5({
        repository,
        ledger: proxy as never,
      }),
    ).toThrowErrorCode("invalid-source");
    expect(() =>
      mapWorkflowOutcomeToMaturity({
        gateId: "G0",
        record: proxy as never,
      }),
    ).toThrowErrorCode("invalid-source");
    expect(proxyCalls).toBe(0);
  });

  it("accepts G2 self-service readiness only through a live #79 package inspection", async () => {
    const fixture = await repositoryFixture({ documentation: true, validation: true });
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    const packageRoot = await mkdtemp(join(tmpdir(), "docsfab-maturity-ia-package-"));
    temporary.push(packageRoot);
    try {
      const repository = {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      };
      const task = { kind: "ia-plan", scope: "site", mode: "create" } as const;
      const now = new Date("2026-08-05T12:00:00.000Z");
      const repositoryIdentity = canonicalDigest(workspace.sourcePath);
      const receipt = await provisionDefaultIaAnalysisInput({
        packageRoot,
        repositoryPath: workspace.sourcePath,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        task,
        expiresAt: "2026-08-06T12:00:00.000Z",
        now,
      });
      const inspection = {
        packageKind: "analysis-input" as const,
        packageRoot,
        repositoryPath: workspace.sourcePath,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        packageDigest: receipt.digest,
        task,
        now,
      };
      const mapping = await mapIaSelfServiceInputToG2({ repository, inspection });
      const evaluation = await evaluateDocumentationMaturityGate({
        gateId: "G2",
        repository,
        policyWorkspace: workspace,
        mappings: [mapping],
      });
      expect(
        evaluation.checks.find((check) => check.checkId === "ia-self-service-input"),
      ).toMatchObject({ state: "satisfied" });
      expect(evaluation.sourceMappings).toEqual([
        {
          capability: "ia-self-service",
          sourceSha256: mapping.sourceSha256,
          mappingSha256: mapping.mappingSha256,
        },
      ]);
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G2",
          repository,
          policyWorkspace: workspace,
          mappings: [structuredClone(mapping)],
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });
      await expect(
        mapIaSelfServiceInputToG2({
          repository,
          inspection: { ...inspection, packageDigest: canonicalDigest("forged-receipt") },
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });
    } finally {
      await workspace.dispose();
    }
  });

  it("snapshots #79 repository and inspection inputs before asynchronous inspection", async () => {
    const fixture = await repositoryFixture({ documentation: true, validation: true });
    const cloneParent = await mkdtemp(join(tmpdir(), "docsfab-maturity-ia-clone-"));
    const clone = join(cloneParent, "repository");
    const packageRoot = await mkdtemp(join(tmpdir(), "docsfab-maturity-ia-race-package-"));
    temporary.push(cloneParent, packageRoot);
    await git(cloneParent, ["clone", "-q", fixture, clone]);
    const [workspace, cloneWorkspace] = await Promise.all([
      prepareRepositoryWorkspace(fixture, "HEAD"),
      prepareRepositoryWorkspace(clone, "HEAD"),
    ]);
    try {
      expect(cloneWorkspace.revision).toBe(workspace.revision);
      const repository = repositoryFor(workspace);
      const task = { kind: "ia-plan", scope: "site", mode: "create" } as const;
      const now = new Date("2026-08-05T12:00:00.000Z");
      const repositoryIdentity = canonicalDigest(workspace.sourcePath);
      const receipt = await provisionDefaultIaAnalysisInput({
        packageRoot,
        repositoryPath: workspace.sourcePath,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        task,
        expiresAt: "2026-08-06T12:00:00.000Z",
        now,
      });
      const inspection = {
        packageKind: "analysis-input" as const,
        packageRoot,
        repositoryPath: workspace.sourcePath,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        packageDigest: receipt.digest,
        task,
        now,
      };
      const pending = mapIaSelfServiceInputToG2({ repository, inspection });
      repository.sourcePath = cloneWorkspace.sourcePath;
      inspection.repositoryPath = cloneWorkspace.sourcePath;
      inspection.packageDigest = canonicalDigest("substituted-after-await");
      now.setUTCFullYear(2030);
      const mapping = await pending;

      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G2",
          repository: repositoryFor(workspace),
          policyWorkspace: workspace,
          mappings: [mapping],
        }),
      ).resolves.toMatchObject({
        repository: { identitySha256: canonicalDigestPath(workspace.sourcePath) },
      });
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G2",
          repository: repositoryFor(cloneWorkspace),
          policyWorkspace: cloneWorkspace,
          mappings: [mapping],
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });
    } finally {
      await Promise.all([workspace.dispose(), cloneWorkspace.dispose()]);
    }
  });

  it("rejects a hidden #79 task anchor instead of inspecting a different package", async () => {
    const fixture = await repositoryFixture({ documentation: true, validation: true });
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    const packageRoot = await mkdtemp(join(tmpdir(), "docsfab-maturity-ia-hidden-task-"));
    temporary.push(packageRoot);
    try {
      const repository = repositoryFor(workspace);
      const packageTask = {
        kind: "ia-plan" as const,
        scope: "section" as const,
        mode: "create" as const,
        target: { sourcePath: "guide/start.md" },
      };
      const now = new Date("2026-08-05T12:00:00.000Z");
      const repositoryIdentity = canonicalDigest(workspace.sourcePath);
      const receipt = await provisionDefaultIaAnalysisInput({
        packageRoot,
        repositoryPath: workspace.sourcePath,
        repositoryRevision: workspace.revision,
        repositoryIdentity,
        task: packageTask,
        expiresAt: "2026-08-06T12:00:00.000Z",
        now,
      });
      const inspectionTask = structuredClone(packageTask) as typeof packageTask & {
        target: { sourcePath: string; anchor?: string };
      };
      Object.defineProperty(inspectionTask.target, "anchor", {
        value: "different-hidden-anchor",
        enumerable: false,
      });

      await expect(
        mapIaSelfServiceInputToG2({
          repository,
          inspection: {
            packageKind: "analysis-input",
            packageRoot,
            repositoryPath: workspace.sourcePath,
            repositoryRevision: workspace.revision,
            repositoryIdentity,
            packageDigest: receipt.digest,
            task: inspectionTask,
            now,
          },
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects #79 inspection accessors and symbol fields without invoking traps", async () => {
    const repository = {
      sourcePath: "/tmp/repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    };
    let getterCalls = 0;
    const inspection = Object.defineProperty({}, "packageKind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "analysis-input";
      },
    });
    await expect(
      mapIaSelfServiceInputToG2({
        repository,
        inspection: inspection as never,
      }),
    ).rejects.toMatchObject({ code: "invalid-source" });
    expect(getterCalls).toBe(0);

    const symbolInspection = {
      packageKind: "analysis-input" as const,
      packageRoot: "/tmp/package",
      repositoryPath: repository.sourcePath,
      repositoryRevision: repository.revision,
      task: { kind: "ia-plan", scope: "site", mode: "create" } as const,
      [Symbol("extra")]: "must-not-bypass-exactness",
    };
    await expect(
      mapIaSelfServiceInputToG2({
        repository,
        inspection: symbolInspection,
      }),
    ).rejects.toMatchObject({ code: "invalid-source" });

    let nestedGetterCalls = 0;
    const accessorTarget = Object.defineProperty({ sourcePath: "guide/start.md" }, "anchor", {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        return "hidden";
      },
    });
    await expect(
      mapIaSelfServiceInputToG2({
        repository,
        inspection: {
          packageKind: "analysis-input",
          packageRoot: "/tmp/package",
          repositoryPath: repository.sourcePath,
          repositoryRevision: repository.revision,
          task: {
            kind: "ia-plan",
            scope: "section",
            mode: "create",
            target: accessorTarget,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-source" });
    expect(nestedGetterCalls).toBe(0);

    const sparseTarget = new Array(2);
    sparseTarget[0] = "guide/start.md";
    await expect(
      mapIaSelfServiceInputToG2({
        repository,
        inspection: {
          packageKind: "analysis-input",
          packageRoot: "/tmp/package",
          repositoryPath: repository.sourcePath,
          repositoryRevision: repository.revision,
          task: {
            kind: "ia-plan",
            scope: "section",
            mode: "create",
            target: sparseTarget as never,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-source" });

    let coercionCalls = 0;
    const coerciveScope = {
      [Symbol.toPrimitive]() {
        coercionCalls += 1;
        return "site";
      },
    };
    await expect(
      mapIaSelfServiceInputToG2({
        repository,
        inspection: {
          packageKind: "analysis-input",
          packageRoot: "/tmp/package",
          repositoryPath: repository.sourcePath,
          repositoryRevision: repository.revision,
          task: {
            kind: "ia-plan",
            scope: coerciveScope as never,
            mode: "create",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-source" });
    expect(coercionCalls).toBe(0);
  });

  it("fails closed before proxy or accessor traps and rejects cross-repository reuse", async () => {
    const first = await repositoryFixture({ documentation: true, validation: true });
    const second = await repositoryFixture({ documentation: true, validation: true });
    const workspace = await prepareRepositoryWorkspace(first, "HEAD");
    const other = await prepareRepositoryWorkspace(second, "HEAD");
    try {
      let proxyCalls = 0;
      const proxy = new Proxy(
        {},
        {
          getPrototypeOf() {
            proxyCalls += 1;
            return Object.prototype;
          },
        },
      );
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository: {
            sourcePath: workspace.sourcePath,
            requestedRevision: workspace.requestedRevision,
            revision: workspace.revision,
          },
          policyWorkspace: proxy as never,
          mappings: [],
        }),
      ).rejects.toMatchObject({ code: "invalid-product-need" });
      expect(proxyCalls).toBe(0);

      let getterCalls = 0;
      const accessor = Object.defineProperty({}, "repository", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return {};
        },
      });
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G1",
          repository: {
            sourcePath: workspace.sourcePath,
            requestedRevision: workspace.requestedRevision,
            revision: workspace.revision,
          },
          policyWorkspace: accessor as never,
          mappings: [],
        }),
      ).rejects.toMatchObject({ code: "invalid-product-need" });
      expect(getterCalls).toBe(0);

      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const mapping = mapRepositoryInventoryToG0({
        inventory,
        repository: {
          sourcePath: workspace.sourcePath,
          requestedRevision: workspace.requestedRevision,
          revision: workspace.revision,
        },
      });
      await expect(
        evaluateDocumentationMaturityGate({
          gateId: "G0",
          repository: {
            sourcePath: other.sourcePath,
            requestedRevision: other.requestedRevision,
            revision: other.revision,
          },
          policyWorkspace: null,
          mappings: [mapping],
        }),
      ).rejects.toMatchObject({ code: "invalid-source" });
    } finally {
      await workspace.dispose();
      await other.dispose();
    }
  });
});

function repositoryFor(workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>>) {
  return {
    sourcePath: workspace.sourcePath,
    requestedRevision: workspace.requestedRevision,
    revision: workspace.revision,
  };
}

function canonicalDigestPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function hostPolicy(
  overrides: {
    documentationType?: "developer-reference" | "operator-guide" | "none" | "unknown";
    need?: "required" | "not-required" | "unknown";
    gateIds?: Array<"G1" | "G2" | "G3" | "G4" | "G5">;
    modularityPolicy?: {
      id: string;
      version: string;
      maximumSectionsPerDocument: number;
      maximumSectionDepth: number;
    };
  } = {},
) {
  const need = overrides.need ?? "required";
  const modularityPolicy = overrides.modularityPolicy ?? {
    id: "fixture-modularity",
    version: "1",
    maximumSectionsPerDocument: 1,
    maximumSectionDepth: 1,
  };
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-host-policy" as const,
    productNeed: {
      repositoryType: "library" as const,
      documentationType: overrides.documentationType ?? "developer-reference",
      gateIds: overrides.gateIds ?? ["G1", "G2", "G3", "G4", "G5"],
      decision: {
        id: `fixture-${need}`,
        need,
        authorityId: "fixture-product-governance",
        decidedAt: "2026-08-05T12:00:00.000Z",
        evidenceSha256: need === "unknown" ? null : canonicalDigest(`fixture-evidence-${need}`),
        predecessorDecisionSha256: null,
      },
    },
    modularity: {
      activePolicyId: modularityPolicy.id,
      activePolicyVersion: modularityPolicy.version,
      policies: [modularityPolicy],
    },
  };
}

function workflowOutcomeRecord(
  repository: RunRecord["repository"],
  disposition: "ready" | "not-ready",
): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: "run:maturity-evaluator-semantic-overlay",
    workflow: "readiness",
    repository,
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Semantic overlay fixture.",
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
  const candidate: WorkflowOutcomeCandidateV1 =
    disposition === "ready"
      ? {
          disposition,
          findings: [],
          evidence: [evidence],
          limitations: [],
          openDecisions: [],
          producedArtifacts: [],
        }
      : {
          disposition,
          findings: [
            {
              id: "finding:maturity-not-ready",
              kind: "product-gap",
              severity: "blocking",
              code: "maturity-not-ready",
              evidenceIds: [evidence.id],
            },
          ],
          evidence: [evidence],
          limitations: [],
          openDecisions: [],
          producedArtifacts: [],
        };
  record.workflowOutcome = createWorkflowOutcome(candidate, record);
  return record;
}

async function repositoryFixture(options: {
  documentation: boolean;
  validation: boolean;
  policy?: Parameters<typeof hostPolicy>[0];
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-maturity-evaluator-"));
  temporary.push(root);
  const files: Record<string, string> = {
    "src/index.ts": "export const value = 1;\n",
    "package.json": JSON.stringify({
      name: "fixture",
      scripts: options.validation
        ? { test: "node --test", "docs:build": "node docs-build.js" }
        : {},
    }),
    [DOCUMENTATION_MATURITY_HOST_POLICY_PATH]: canonicalJson(hostPolicy(options.policy)),
  };
  if (options.documentation) {
    files["guide/start.md"] = "# Start\n\n## Run\n\n1. Run it.\n";
  }
  await initFixtureRepo(root, files);
  return root;
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

expect.extend({
  toThrowErrorCode(received: () => unknown, code: DocumentationMaturityEvaluatorError["code"]) {
    try {
      received();
      return { pass: false, message: () => `expected ${code}` };
    } catch (error) {
      const pass = error instanceof DocumentationMaturityEvaluatorError && error.code === code;
      return { pass, message: () => `expected ${code}, received ${String(error)}` };
    }
  },
});

declare module "vitest" {
  interface Assertion<T = any> {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    toThrowErrorCode(code: DocumentationMaturityEvaluatorError["code"]): T;
  }
  interface AsymmetricMatchersContaining {
    toThrowErrorCode(code: DocumentationMaturityEvaluatorError["code"]): unknown;
  }
}
