// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * #1927: governed workflow search on a tree larger than the generic contract
 * decode ceilings stopped `plan-documentation` with an uncoded "Governed
 * workflow search could not be completed." The field trigger was the
 * repository inventory decode: vLLM Semantic Router's 10,327-file inventory
 * crossed `runtime.contract.maxArrayLength` (10,000) and
 * `runtime.contract.maxNodes` (100,000), and the search catch-all dropped the
 * cause. These suites lower the same ceilings through the supported host
 * override so a small tree reproduces the trigger.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSavedRunRecord } from "../src/cli/commands/runs.js";
import {
  activateContractDecodeLimits,
  limit,
  OperationalLimitError,
} from "../src/config/limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { repositoryInventoryMaxEntries } from "../src/config/repository-discovery-limits.js";
import { ContentIndexError } from "../src/content-ir/contracts.js";
import {
  contractBoundExceededOf,
  contractDecodeLimits,
  createContractKit,
  type ContractDecodeLimitSnapshot,
} from "../src/contract-kit/index.js";
import { installContractDecodeLimitSnapshot } from "../src/contract-kit/decode-bounds.js";
import { diagnoseRunRecord } from "../src/diagnosis/record.js";
import { formatRunDiagnosisLines } from "../src/diagnosis/render.js";
import type { JsonEvidenceValue } from "../src/json-evidence.js";
import { operatorCodeFailureClass } from "../src/operator/failure-classification.js";
import {
  collectRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  buildRepositoryDiscoveryInventory,
  decodeRepositoryDiscoveryInventory,
  isRepositoryNavigationRoute,
  RepositoryInventoryError,
} from "../src/repository/inventory.js";
import { isRepositoryInventoryEntryLimitation } from "../src/config/repository-inventory-limit.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { BoundedSearchContractError } from "../src/search/bounded-search-contracts.js";
import { SearchProgressContractError } from "../src/search/progress-contracts.js";
import type { WorkflowSearchCoordinator } from "../src/workflow-contracts/contracts.js";
import {
  WORKFLOW_SEARCH_FAILURE_CODES,
  WorkflowSearchError,
  workflowSearch,
} from "../src/workflow-execution/runner-evidence.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { snapshotWorkflowSearchCoordinatorResult } from "../src/workflow-contracts/search.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

/** Git fixtures and workspace exports need headroom under parallel Vitest workers. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;
/** Writing and walking 4,100 files takes seconds on CI but minutes on a loaded shared host. */
const MANY_FILES_TIMEOUT_MS = 600_000;
const REVISION = "a".repeat(40);
/** Credential-shaped only at run time, so the source carries no token literal. */
const SYNTHETIC_PROVIDER_DETAIL = ["glpat", "do-not-persist-this-provider-detail"].join("-");
const INVENTORY_REMEDIATION =
  "Raise DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES to at least the tracked entry count to inventory the whole tree, or narrow the repository. A tree past the workspace export's ceiling also needs DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_ENTRIES raised. Follow the named remediation.";
const temporary: string[] = [];
let catalogDecodeLimits: ContractDecodeLimitSnapshot;

beforeEach(() => {
  catalogDecodeLimits = contractDecodeLimits();
});

afterEach(async () => {
  installContractDecodeLimitSnapshot(catalogDecodeLimits);
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}, MANY_FILES_TIMEOUT_MS);

describe("governed search over an inventory past the generic decode ceilings (#1927)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("completes plan-documentation search on a tree the generic ceilings refuse", async () => {
    const repository = await documentationRepository(130);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      lowerDecodeCeilings({ maxArrayLength: 100, maxNodes: 3_000 });
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.status).toBe("complete");
      expect(inventory.files).toHaveLength(130);

      // Positive controls: a kit without a size governor refuses this exact
      // inventory on each axis, as the field inventory was refused.
      expect(() => ungovernedKit().assertInert(structuredClone(inventory))).toThrow(
        "bound-exceeded axis=runtime.contract.maxArrayLength limit=100 observed=130",
      );
      lowerDecodeCeilings({ maxNodes: 3_000 });
      expect(() => ungovernedKit().assertInert(structuredClone(inventory))).toThrow(
        "bound-exceeded axis=runtime.contract.maxNodes limit=3000 observed=3001",
      );
      lowerDecodeCeilings({ maxArrayLength: 100, maxNodes: 3_000 });

      // repository.inventoryMaxEntries governs the inventory's size, so its
      // own decoder admits what the builder produced.
      expect(decodeRepositoryDiscoveryInventory(structuredClone(inventory))).toEqual(inventory);
      const result = await planDocumentationSearch(workspace);
      expect(result.evidence.searches.map((search) => search.bounded.finding.disposition)).toEqual([
        "found",
      ]);
      expect(result.evidence.searches.flatMap((search) => search.bounded.limitations)).toEqual([]);

      // Release readiness returns the inventory itself, inside its batch
      // authority; the result snapshot must not refuse it either. Its own
      // search evidence has more nodes than the lowered node ceiling whatever
      // the tree's size, so only the array ceiling stays below the inventory.
      lowerDecodeCeilings({ maxArrayLength: 100 });
      const release = await releaseReadinessSearch(workspace);
      expect(release.repositoryBatchAuthority?.inventory.files).toHaveLength(130);
      expect(release.trustedInventory?.files).toHaveLength(130);
    } finally {
      await workspace.dispose();
    }
  });

  it("degrades past repository.inventoryMaxEntries with a recorded limitation, and honours a raised override", async () => {
    const repository = await documentationRepository(61);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "30");
      const clipped = await buildRepositoryDiscoveryInventory({ workspace });
      expect(clipped.failures.map((failure) => failure.category)).toContain("entry-limit-exceeded");
      const degraded = await planDocumentationSearch(workspace);
      expect(
        degraded.evidence.searches.map((search) => search.bounded.finding.disposition),
      ).toEqual(["found"]);
      expect(
        degraded.evidence.searches.flatMap((search) =>
          search.bounded.limitations.map((item) => `${item.id}:${item.category}`),
        ),
      ).toEqual(["local-index-incomplete:index-incomplete"]);
      expect(degraded.evidenceWarnings).toContain(
        `repository-inventory-max-entries-bound: 61 exceeds repository.inventoryMaxEntries = 30 count. ${INVENTORY_REMEDIATION}`,
      );

      vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "100");
      expect((await buildRepositoryDiscoveryInventory({ workspace })).status).toBe("complete");
      const complete = await planDocumentationSearch(workspace);
      expect(complete.evidence.searches.flatMap((search) => search.bounded.limitations)).toEqual(
        [],
      );
      expect(
        (complete.evidenceWarnings ?? []).filter(isRepositoryInventoryEntryLimitation),
      ).toEqual([]);
    } finally {
      await workspace.dispose();
    }
  });
});

describe("a clipped inventory reaches LIMITATIONS for every governed workflow (#1927)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("prints the entry-limit line and its remediation for a clipped non-release run", async () => {
    const root = await documentationRepository(61);
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    try {
      vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "30");
      const record = await runReadinessSearch(
        new LocalWorkflowSearchCoordinator({ workspace }),
        workspace.path,
        {
          sourcePath: workspace.sourcePath,
          requestedRevision: workspace.requestedRevision,
          revision: workspace.revision,
        },
      );
      const line = `repository-inventory-max-entries-bound: 61 exceeds repository.inventoryMaxEntries = 30 count. ${INVENTORY_REMEDIATION}`;
      expect(record.status).toBe("succeeded");
      expect(record.steps[0]!.repositoryBatchAuthority).toBeUndefined();
      expect(record.evidenceWarnings).toEqual([line]);
      expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([line]);
      const summary = formatRunSummary({
        record,
        recordPath: "run.json",
        exitCode: 0,
        repositoryPath: root,
      }).join("\n");
      expect(summary).toContain("LIMITATIONS");
      expect(summary).toContain(line);
    } finally {
      await workspace.dispose();
    }
  });

  it("prints the clip a release run recorded, not one recomputed under a later limit", async () => {
    const root = await documentationRepository(61);
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    try {
      vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "30");
      const release = await releaseReadinessSearch(workspace);
      const recorded = `repository-inventory-max-entries-bound: 61 exceeds repository.inventoryMaxEntries = 30 count. ${INVENTORY_REMEDIATION}`;
      expect(release.evidenceWarnings).toEqual([recorded]);
      expect(
        release.repositoryBatchAuthority?.inventory.failures.map((failure) => failure.category),
      ).toContain("entry-limit-exceeded");

      // A release record keeps the clipped inventory on its step and the
      // line the run recorded when it searched.
      vi.unstubAllEnvs();
      const readme = await temporaryDirectory();
      await writeFile(join(readme, "README.md"), "# Product\n");
      const record = await runReadinessSearch(new LocalWorkflowSearchCoordinator(), readme);
      record.steps[0]!.repositoryBatchAuthority = release.repositoryBatchAuthority;
      record.evidenceWarnings = [...(release.evidenceWarnings ?? [])];

      // Shown later under a different limit, the recorded bound still reads.
      vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "100");
      const lines = projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record));
      expect(lines).toContain(recorded);
      expect(lines.filter((line) => line.includes("repository.inventoryMaxEntries = 100"))).toEqual(
        [],
      );
      const summary = formatRunSummary({
        record,
        recordPath: "run.json",
        exitCode: 0,
        repositoryPath: root,
      }).join("\n");
      expect(summary).toContain("61 exceeds repository.inventoryMaxEntries = 30");
      expect(summary).not.toContain("repository.inventoryMaxEntries = 100");
    } finally {
      await workspace.dispose();
    }
  });

  it("projects only entry-limit lines as inventory clips", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "README.md"), "# Product\n");
    const clip =
      "repository-inventory-max-entries-bound: exceeded repository.inventoryMaxEntries = 30 count.";
    const reporting: WorkflowSearchCoordinator = {
      async search(input) {
        const result = await new LocalWorkflowSearchCoordinator().search(input);
        return { ...result, evidenceWarnings: ["free text from a coordinator", clip] };
      },
    };
    const record = await runReadinessSearch(reporting, root);
    expect(record.status).toBe("succeeded");
    const evidence = collectRunLimitOverflowEvidence(record);
    expect(evidence.inventoryLimitations).toEqual([clip]);
    expect(projectRunLimitOverflowLines(evidence)).toEqual([clip]);
  });
});

describe("repository.inventoryMaxEntries host override (#1927)", () => {
  it("raises as far as the workspace export's tree-entry ceiling can, and no further", () => {
    const resolve = (name: string, variable: string, value: string) =>
      limit(name, { environment: { [variable]: value }, hostFile: null, projectFile: null });
    const inventory = (value: string) =>
      resolve("repository.inventoryMaxEntries", "DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", value);
    // The tie (F4): an inventory never holds more entries than the export
    // admits, so both limits share one maximum.
    const exportCeiling = LIMIT_DEFINITION_BY_NAME["repository.workspaceExportMaxTreeEntries"]!;
    expect(LIMIT_DEFINITION_BY_NAME["repository.inventoryMaxEntries"]!.max).toBe(exportCeiling.max);
    // A host that raises the export past its 100,000 default raises the
    // inventory to match; the former 100,000 cap no longer refuses that.
    expect(
      resolve(
        "repository.workspaceExportMaxTreeEntries",
        "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_ENTRIES",
        "150000",
      ).value,
    ).toBe(150_000);
    expect(inventory("150000").value).toBe(150_000);
    expect(inventory(String(exportCeiling.max)).value).toBe(exportCeiling.max);
    expect(() => inventory(`${exportCeiling.max}0`)).toThrow(
      `DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES must be an integer between 1 and ${exportCeiling.max}.`,
    );
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "150000");
    expect(repositoryInventoryMaxEntries()).toBe(150_000);
  });
});

describe("filesystem-only search shares the declared inventory bound (#1927)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it(
    "reads past 4,096 documents without marking the index incomplete",
    async () => {
      const root = await temporaryDirectory();
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "README.md"), "# Product\n");
      const names = Array.from({ length: 4_100 }, (_, index) => `page-${index}.md`);
      for (let start = 0; start < names.length; start += 512) {
        await Promise.all(
          names
            .slice(start, start + 512)
            .map((name) => writeFile(join(root, "docs", name), "# Page\n")),
        );
      }
      expect(limitationIds(await legacySearch(root))).not.toContain("local-index-incomplete");
    },
    MANY_FILES_TIMEOUT_MS,
  );

  it("admits exactly repository.inventoryMaxEntries walked entries and clips one more", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), "# Product\n");
    for (let index = 0; index < 28; index += 1) {
      await writeFile(join(root, "docs", `page-${index}.md`), "# Page\n");
    }
    // The walk counts every entry it visits: README.md, docs, and 28 pages.
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "30");
    const atLimit = await legacySearch(root);
    expect(limitationIds(atLimit)).not.toContain("local-index-incomplete");
    expect(atLimit?.evidenceWarnings).toBeUndefined();
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "29");
    const pastLimit = await legacySearch(root);
    expect(limitationIds(pastLimit)).toContain("local-index-incomplete");
    expect(pastLimit?.evidenceWarnings).toEqual([
      `repository-inventory-max-entries-bound: exceeded repository.inventoryMaxEntries = 29 count. ${INVENTORY_REMEDIATION}`,
    ]);
  });

  it("marks the index incomplete past repository.inventoryMaxEntries and follows its override", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), "# Product\n");
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(root, "docs", `page-${index}.md`), "# Page\n");
    }
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "30");
    const clipped = await legacySearch(root);
    expect(limitationIds(clipped)).toContain("local-index-incomplete");
    // The walk stops at the bound, so its line states the limit, not a count.
    expect(clipped?.evidenceWarnings).toEqual([
      `repository-inventory-max-entries-bound: exceeded repository.inventoryMaxEntries = 30 count. ${INVENTORY_REMEDIATION}`,
    ]);
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "100");
    const complete = await legacySearch(root);
    expect(limitationIds(complete)).not.toContain("local-index-incomplete");
    expect(complete?.evidenceWarnings).toBeUndefined();
  });
});

describe("a governed search stop keeps its cause (#1927)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it.each([
    ["bounded", () => new BoundedSearchContractError("invalid-evidence"), "bounded"],
    ["progress", () => new SearchProgressContractError("invalid-observation"), "progress"],
  ] as const)(
    "attributes a trusted %s contract refusal to the host",
    async (_label, thrown, kind) => {
      const record = await runReadinessSearch({
        async search() {
          throw thrown();
        },
      });
      expect(record.steps[0]!.failure).toEqual({
        class: "contract-shape",
        layer: "workflow",
        code: "workflow-search-contract-failed",
      });
      expect(record.steps[0]!.error).toContain(`${kind} host search evidence`);
      const saved = decodeSavedRunRecord(
        JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
        record.id,
      );
      const diagnosis = diagnoseRunRecord(saved, "/tmp/state/run.json")!;
      const finding = diagnosis.findings.find((entry) => entry.role === "terminal")!;
      expect([finding.ownerClass, finding.cause]).toEqual([
        "docsfab-defect",
        "host-built-value-refused",
      ]);
      expect(finding.nextAction).toContain("Report this DocsFab defect");
      const human = formatRunDiagnosisLines(diagnosis, {
        location: { indexArgs: "", showArgs: "" },
      }).join("\n");
      expect(human).toContain("Owner: DocsFab defect.");
      expect(human).not.toContain("endpoint enforces structured output");
      expect(human).not.toContain("operator configuration");
      expect(JSON.stringify(diagnosis)).toContain('"cause":"host-built-value-refused"');
    },
  );

  it("does not trust a plain Error that spoofs a search contract name and code", async () => {
    const record = await runReadinessSearch({
      async search() {
        throw Object.assign(new Error("spoofed"), {
          name: "BoundedSearchContractError",
          code: "invalid-evidence",
        });
      },
    });
    expect(record.steps[0]!.failure?.code).not.toBe("workflow-search-contract-failed");
  });

  it("keeps hostile typed error properties out of persisted evidence", async () => {
    const hostile = new BoundedSearchContractError("invalid-evidence");
    hostile.message =
      "private /private/host/sentinel\u0001 glpat-do-not-persist-this-provider-detail";
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("private /private/host/sentinel");
      },
    });
    Object.defineProperty(hostile, "path", {
      get() {
        throw new Error("/private/host/sentinel");
      },
    });
    Object.defineProperty(hostile, "name", { value: "glpat-do-not-persist-this-provider-detail" });
    const record = await runReadinessSearch({
      async search() {
        throw hostile;
      },
    });
    expect(record.steps[0]!.failure?.code).toBe("workflow-search-contract-failed");
    expect(JSON.stringify(record)).not.toContain("/private/host");
    expect(JSON.stringify(record)).not.toContain("do-not-persist");
    expect(JSON.stringify(record)).not.toContain("\u0001");
  });

  it("does not turn an older generic coordinator failure into provider configuration or a proven defect", async () => {
    const record = await runReadinessSearch({
      async search() {
        throw new Error("unknown cause");
      },
    });
    const saved = decodeSavedRunRecord(
      JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
      record.id,
    );
    const diagnosis = diagnoseRunRecord(saved, "/tmp/state/run.json")!;
    const finding = diagnosis.findings.find((entry) => entry.role === "terminal")!;
    expect([finding.ownerClass, finding.cause]).toEqual([
      "unattributed-search",
      "search-cause-unresolved",
    ]);
    const human = formatRunDiagnosisLines(diagnosis, {
      location: { indexArgs: "", showArgs: "" },
    }).join("\n");
    expect(human).toContain("Owner: search cause unresolved.");
    expect(human).toContain("checkout");
    expect(human).not.toContain("configured endpoint, credential, model");
    expect(human).not.toContain("DocsFab defect.");
    expect(JSON.stringify(diagnosis)).toContain('"ownerClass":"unattributed-search"');
  });
  it.each([
    {
      title: "an uncoded error",
      error: () => new Error(`${SYNTHETIC_PROVIDER_DETAIL} at /private/host/sentinel`),
      failure: { class: "infrastructure", code: "workflow-search-coordinator-failed" },
      message:
        "Governed workflow search could not be completed (workflow-search-coordinator-failed): its coordinator phase raised Error with no code.",
    },
    {
      title: "an unclassified inventory code",
      error: () =>
        new RepositoryInventoryError(
          "invalid-inventory",
          "Repository inventory is invalid at /private/host/sentinel.",
        ),
      failure: { class: "infrastructure", code: "workflow-search-coordinator-failed" },
      message:
        "Governed workflow search could not be completed (workflow-search-coordinator-failed): its coordinator phase raised RepositoryInventoryError with unclassified code invalid-inventory.",
    },
    {
      title: "an error name that is not an identifier",
      error: () => Object.assign(new Error("Refused."), { name: "Leaked /private/host/sentinel" }),
      failure: { class: "infrastructure", code: "workflow-search-coordinator-failed" },
      message:
        "Governed workflow search could not be completed (workflow-search-coordinator-failed): its coordinator phase raised Error with no code.",
    },
    {
      title: "a catalogued code whose class is unknown",
      error: () => Object.assign(new Error("Refused."), { code: "operator-error" }),
      failure: { class: "infrastructure", code: "workflow-search-coordinator-failed" },
      message:
        "Governed workflow search could not be completed (workflow-search-coordinator-failed): its coordinator phase raised Error with unclassified code operator-error.",
    },
    {
      // The quality pack throws `unsafe-path` too, but its class follows its error type.
      title: "a code the quality pack shares with other errors",
      error: () =>
        new ContentIndexError("unsafe-path", "Content index rejects symlink: docs/page.md."),
      failure: { class: "infrastructure", code: "workflow-search-coordinator-failed" },
      message:
        "Governed workflow search could not be completed (workflow-search-coordinator-failed): its coordinator phase raised ContentIndexError with unclassified code unsafe-path.",
    },
    {
      title: "a catalogued contract code with a repository path",
      error: () =>
        Object.assign(new Error("Refused /private/host/sentinel."), {
          code: "invalid-shape",
          path: "deploy/kubernetes/llmd-base/llmd+public-llm/values.yaml",
        }),
      failure: { class: "contract-shape", code: "invalid-shape" },
      message:
        "Governed workflow search could not be completed (invalid-shape): its coordinator phase raised Error with that code at deploy/kubernetes/llmd-base/llmd+public-llm/values.yaml.",
    },
    {
      title: "a host path that is not repository-relative",
      error: () =>
        Object.assign(new Error("Refused."), {
          code: "invalid-shape",
          path: "/private/host/sentinel/values.yaml",
        }),
      failure: { class: "contract-shape", code: "invalid-shape" },
      message:
        "Governed workflow search could not be completed (invalid-shape): its coordinator phase raised Error with that code.",
    },
    {
      title: "an operational limit refusal",
      error: () => new OperationalLimitError(limit("repository.inventoryMaxEntries"), 20_001),
      failure: { class: "bound", code: "repository-inventory-max-entries-bound" },
      message:
        "Governed workflow search could not be completed: its coordinator phase stopped at a limit. repository-inventory-max-entries-bound: 20001 exceeds repository.inventoryMaxEntries = 20000 count.",
    },
    {
      title: "the field trigger, a contract decode bound",
      error: () => decodeBoundRefusal(),
      failure: { class: "bound", code: "runtime-contract-max-array-length-bound" },
      message:
        "Governed workflow search could not be completed: its coordinator phase stopped at a limit. runtime-contract-max-array-length-bound: 10001 exceeds runtime.contract.maxArrayLength = 10000 count.",
    },
  ])(
    "records $title on the step, the run, and docsfab why",
    async ({ error, failure, message }) => {
      const record = await runReadinessSearch({
        async search() {
          throw error();
        },
      });
      const expected = { class: failure.class, layer: "workflow", code: failure.code };
      expect(record.status).toBe("failed");
      expect(record.steps[0]!.failure).toEqual(expected);
      expect(record.failure).toEqual(expected);
      expect(record.steps[0]!.error).toContain(message);
      expect(record.error).toBe(record.steps[0]!.error);
      expect(JSON.stringify(record)).not.toContain("do-not-persist");
      expect(JSON.stringify(record)).not.toContain("/private/host");

      // The saved record round-trips, and `docsfab why` names the code and class.
      const saved = decodeSavedRunRecord(
        JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
        record.id,
      );
      const finding = diagnoseRunRecord(saved, "/tmp/state/run.json")?.findings.find(
        (entry) => entry.role === "terminal",
      );
      expect(finding?.stepId).toBe("assess-readiness");
      expect(finding?.evidence.failureClass).toBe(failure.class);
      expect(finding?.why).toContain(
        `recorded failure class ${failure.class} at layer workflow (code ${failure.code}).`,
      );
      expect(finding?.why).not.toContain("uncoded-error");
    },
  );

  it("names the evidence phase when the coordinator returns a malformed result", async () => {
    const record = await runReadinessSearch({
      async search() {
        return {} as never;
      },
    });
    expect(record.steps[0]!.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "workflow-search-evidence-failed",
    });
    expect(record.steps[0]!.error).toBe(
      "Governed workflow search could not be completed (workflow-search-evidence-failed): its evidence phase raised WorkflowSearchEvidenceError with unclassified code invalid-result.",
    );
  });

  it("names the plan phase and retains the cause in process", async () => {
    const workflow = getWorkflow("readiness");
    const step = workflow.steps[0]!;
    const thrown = await workflowSearch({
      workflowSearch: {
        async search() {
          throw new Error("coordinator must not run");
        },
      },
      runId: "workflow-search-plan-failure",
      repositoryPath: "/selected/workspace",
      repository: repository(),
      workflow,
      step: { ...step, search: { ...step.search!, schemaVersion: 2 as never } },
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(WorkflowSearchError);
    const searchError = thrown as WorkflowSearchError;
    expect(searchError.code).toBe("workflow-search-plan-failed");
    expect(searchError.phase).toBe("plan");
    expect(operatorCodeFailureClass(searchError.code)).toBe("contract-shape");
    expect((searchError.cause as { code?: unknown }).code).toBe("invalid-plan");
  });

  it("withholds a cause that would carry credential material", async () => {
    const record = await runReadinessSearch({
      async search() {
        throw Object.assign(new Error("Refused."), {
          code: "invalid-shape",
          path: `config/glpat-${"a".repeat(24)}.yaml`,
        });
      },
    });
    expect(record.steps[0]!.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "invalid-shape",
    });
    expect(record.steps[0]!.error).toBe(
      "Governed workflow search could not be completed (invalid-shape): its coordinator phase stopped.",
    );
    expect(JSON.stringify(record)).not.toContain("glpat-");
  });

  it("withholds a cause that would carry a configured credential, though the cause looks like none (#1807)", async () => {
    // A configured value that does not look like a credential, so only the
    // exact match withholds the cause.
    const credential = configureCredential(["meadow", plantedCredentialValue(102, 24)].join("-"));
    const refusing = (path: string): WorkflowSearchCoordinator => ({
      async search() {
        throw Object.assign(new Error("Refused."), { code: "invalid-shape", path });
      },
    });
    const withheld = await runReadinessSearch(refusing(`config/${credential}.yaml`));
    expect(withheld.steps[0]!.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "invalid-shape",
    });
    expect(withheld.steps[0]!.error).toBe(
      "Governed workflow search could not be completed (invalid-shape): its coordinator phase stopped.",
    );
    expect(JSON.stringify(withheld)).not.toContain(credential);

    // The same cause with a path that holds no configured credential names it.
    const other = ["meadow", plantedCredentialValue(103, 24)].join("-");
    expect(detectCredentialRuleIds(`config/${other}.yaml`)).toEqual([]);
    const named = await runReadinessSearch(refusing(`config/${other}.yaml`));
    expect(named.steps[0]!.error).toBe(
      `Governed workflow search could not be completed (invalid-shape): its coordinator phase raised Error with that code at config/${other}.yaml.`,
    );
  });

  it("leaves a successful search unchanged", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "README.md"), "# Product\n");
    const record = await runReadinessSearch(new LocalWorkflowSearchCoordinator(), root);
    expect(record.steps[0]!.status).toBe("succeeded");
    expect(record.steps[0]!.failure).toBeUndefined();
    expect(record.steps[0]!.error).toBeUndefined();
    expect(record.steps[0]!.searchEvidence?.searches.length).toBeGreaterThan(0);
  });

  it("names the release-authority phase when release readiness has no batch authority", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "README.md"), "# Product\n");
    const workflow = getWorkflow("release-documentation-readiness");
    const step = workflow.steps.find((candidate) => candidate.search !== undefined)!;
    const thrown = await workflowSearch({
      // The filesystem-only coordinator returns evidence but no batch authority.
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      runId: "workflow-search-release-authority",
      repositoryPath: root,
      repository: repository(),
      workflow,
      step,
      repositoryDefaultBranch: "main",
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(WorkflowSearchError);
    const searchError = thrown as WorkflowSearchError;
    expect(searchError.phase).toBe("release-authority");
    expect(searchError.code).toBe("workflow-search-release-authority-failed");
    expect(operatorCodeFailureClass(searchError.code)).toBe("contract-shape");
    expect(searchError.message).toBe(
      "Governed workflow search could not be completed (workflow-search-release-authority-failed): its release-authority phase raised Error with no code.",
    );
  });

  it("names the configured value of a lowered decode ceiling, not the catalog default", async () => {
    lowerDecodeCeilings({ maxArrayLength: 100 });
    const record = await runReadinessSearch({
      async search() {
        throw decodeBoundRefusal(101);
      },
    });
    expect(record.steps[0]!.failure).toEqual({
      class: "bound",
      layer: "workflow",
      code: "runtime-contract-max-array-length-bound",
    });
    expect(record.steps[0]!.error).toContain(
      "runtime-contract-max-array-length-bound: 101 exceeds runtime.contract.maxArrayLength = 100 count.",
    );
  });

  it("names the configured value of an overridden operational limit, not the catalog default", async () => {
    const lowered = limit("repository.inventoryMaxEntries", {
      environment: { DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES: "30" },
      hostFile: null,
      projectFile: null,
    });
    const refusal = await runReadinessSearch({
      async search() {
        throw new OperationalLimitError(lowered, 31);
      },
    });
    expect(refusal.steps[0]!.error).toContain(
      "repository-inventory-max-entries-bound: 31 exceeds repository.inventoryMaxEntries = 30 count.",
    );
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "30");
    const coded = await runReadinessSearch({
      async search() {
        throw Object.assign(new Error("Refused."), {
          code: "repository-inventory-max-entries-bound",
        });
      },
    });
    expect(coded.steps[0]!.failure?.class).toBe("bound");
    expect(coded.steps[0]!.error).toContain(
      "repository-inventory-max-entries-bound: exceeded repository.inventoryMaxEntries = 30 count.",
    );
  });

  it("reads phase stops in docsfab why as host causes, never as a model's reply", async () => {
    const coordinator = await runReadinessSearch({
      async search() {
        throw new Error("Refused.");
      },
    });
    const evidence = await runReadinessSearch({
      async search() {
        return {} as never;
      },
    });
    const read = (record: RunRecord) =>
      diagnoseRunRecord(record, "/tmp/state/run.json")?.findings.find(
        (entry) => entry.role === "terminal",
      );
    const host = read(coordinator);
    expect(host?.cause).toBe("search-cause-unresolved");
    expect(host?.ownerClass).toBe("unattributed-search");
    expect(host?.why).toContain(
      "Governed workflow search stopped in its coordinator phase, before this step's inference.",
    );
    expect(`${host?.why} ${host?.nextAction}`).not.toMatch(/\bmodel that\b|structured output/u);
    const defect = read(evidence);
    expect(defect?.cause).toBe("host-built-value-refused");
    expect(defect?.ownerClass).toBe("docsfab-defect");
    expect(defect?.why).toContain(
      "Governed workflow search stopped in its evidence phase, before this step's inference.",
    );
    expect(defect?.nextAction).toContain("Report this DocsFab defect");
    expect(`${defect?.why} ${defect?.nextAction}`).not.toMatch(/\bmodel that\b|structured output/u);
  });

  it("catalogues a class for every phase code", () => {
    expect(WORKFLOW_SEARCH_FAILURE_CODES).toEqual([
      "workflow-search-plan-failed",
      "workflow-search-coordinator-failed",
      "workflow-search-evidence-failed",
      "workflow-search-release-authority-failed",
    ]);
    for (const code of WORKFLOW_SEARCH_FAILURE_CODES) {
      expect(operatorCodeFailureClass(code), code).toMatch(/^(?:infrastructure|contract-shape)$/u);
    }
  });
});

describe("inventory navigation route grammar (#1927 review)", () => {
  it("keeps the route language and answers a hostile route in linear time", () => {
    for (const route of ["/", "/a", "/a/", "/docs/getting-started/", "/~x._-/y"]) {
      expect(isRepositoryNavigationRoute(route), route).toBe(true);
    }
    for (const route of ["", "a", "//", "/a//b", "/a b", "/é", null]) {
      expect(isRepositoryNavigationRoute(route), String(route)).toBe(false);
    }
    expect(isRepositoryNavigationRoute(`/${"a/".repeat(50_000)}`)).toBe(true);
    // The nested-quantifier form backtracked exponentially: at 24 characters a
    // loaded host took about 0.1 s, doubling per character, so this route took
    // tens of seconds. The linear grammar answers in microseconds; the budget
    // is generous so only a backtracking grammar can miss it.
    const started = performance.now();
    expect(isRepositoryNavigationRoute(`/${"a".repeat(34)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("contract-kit size governor (#1927)", () => {
  it("refuses a governor that config/limits does not declare", () => {
    expect(() =>
      createContractKit({
        fail: refuse,
        inertMode: "strict",
        sizeGovernedBy: "repository.notDeclared",
        codes: kitCodes(),
      }),
    ).toThrow("Contract kit size governor repository.notDeclared is not declared");
  });

  it("keeps depth and inertness checks on a governed contract", () => {
    lowerDecodeCeilings({ maxDepth: 2 });
    const governed = createContractKit({
      fail: refuse,
      inertMode: "strict",
      sizeGovernedBy: "repository.inventoryMaxEntries",
      codes: kitCodes(),
    });
    expect(() => governed.assertInert({ a: { b: { c: true } } })).toThrow(
      "bound-exceeded axis=runtime.contract.maxDepth limit=2 observed=3",
    );
    expect(() => governed.assertInert(new Proxy({}, {}))).toThrow("invalid-shape");
  });

  it("keeps the generic array ceiling on search evidence in the result snapshot", () => {
    const evidence = {
      repositoryIdentitySha256: "a".repeat(64),
      searches: [{}, {}, {}],
    } as never;
    const warnings = {
      repositoryIdentitySha256: "a".repeat(64),
      searches: [],
      evidenceWarnings: ["one", "two", "three"],
    } as never;
    // Positive control: at the catalog ceiling both results snapshot.
    expect(() => snapshotWorkflowSearchCoordinatorResult(evidence)).not.toThrow();
    expect(() => snapshotWorkflowSearchCoordinatorResult(warnings)).not.toThrow();
    lowerDecodeCeilings({ maxArrayLength: 2 });
    expect(() => snapshotWorkflowSearchCoordinatorResult(evidence)).toThrow(
      "bound-exceeded axis=runtime.contract.maxArrayLength limit=2 observed=3",
    );
    expect(() => snapshotWorkflowSearchCoordinatorResult(warnings)).toThrow(
      "bound-exceeded axis=runtime.contract.maxArrayLength limit=2 observed=3",
    );
  });

  it("records the crossed bound on the error the kit throws", () => {
    const error = decodeBoundRefusal();
    expect(contractBoundExceededOf(error)).toEqual({
      axis: "runtime.contract.maxArrayLength",
      limit: 10_000,
      observed: 10_001,
    });
    expect(contractBoundExceededOf(new Error("plain"))).toBeUndefined();
  });
});

function lowerDecodeCeilings(ceilings: {
  maxArrayLength?: number;
  maxNodes?: number;
  maxDepth?: number;
}): void {
  // The supported startup path: a host override may lower these ceilings.
  activateContractDecodeLimits({
    environment: {
      ...(ceilings.maxArrayLength
        ? { DOCSFAB_RUNTIME_CONTRACT_MAX_ARRAY_LENGTH: String(ceilings.maxArrayLength) }
        : {}),
      ...(ceilings.maxNodes
        ? { DOCSFAB_RUNTIME_CONTRACT_MAX_NODES: String(ceilings.maxNodes) }
        : {}),
      ...(ceilings.maxDepth
        ? { DOCSFAB_RUNTIME_CONTRACT_MAX_DEPTH: String(ceilings.maxDepth) }
        : {}),
    },
    hostFile: null,
    projectFile: null,
  });
}

function refuse(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function kitCodes() {
  return {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  };
}

/** A strict kit with the generic size ceilings, as the inventory decoder used. */
function ungovernedKit() {
  return createContractKit({ fail: refuse, inertMode: "strict", codes: kitCodes() });
}

/** The field trigger's shape: an inventory refusal annotated with a decode bound. */
function decodeBoundRefusal(length = 10_001): unknown {
  const kit = createContractKit({
    fail: () => {
      throw new RepositoryInventoryError("invalid-inventory", "Repository inventory is invalid.");
    },
    inertMode: "strict",
    codes: kitCodes(),
  });
  try {
    kit.assertInert({ files: Array.from({ length }, () => 0) });
  } catch (error) {
    return error;
  }
  throw new Error("The decode bound did not refuse.");
}

async function documentationRepository(count: number): Promise<string> {
  const root = await temporaryDirectory();
  const files: Record<string, string> = { "README.md": "# Product\n" };
  for (let index = 1; index < count; index += 1) {
    files[`docs/page-${String(index).padStart(3, "0")}.md`] = `# Page ${index}\n\nBody ${index}.\n`;
  }
  await initFixtureRepo(root, files, { message: "governed search fixture" });
  return root;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-search-cause-"));
  temporary.push(root);
  return root;
}

function repository() {
  return { sourcePath: "/selected/source", requestedRevision: REVISION, revision: REVISION };
}

async function planDocumentationSearch(workspace: RepositoryWorkspace) {
  const workflow = getWorkflow("update-documentation");
  const step = workflow.steps.find((candidate) => candidate.id === "plan-documentation")!;
  const result = await workflowSearch({
    workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
    runId: "governed-search-large-tree",
    repositoryPath: workspace.path,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    workflow,
    step,
  });
  if (!result) throw new Error("plan-documentation declares a search plan.");
  return result;
}

async function legacySearch(root: string) {
  const workflow = getWorkflow("update-documentation");
  const step = workflow.steps.find((candidate) => candidate.id === "plan-documentation")!;
  return workflowSearch({
    workflowSearch: new LocalWorkflowSearchCoordinator(),
    runId: "filesystem-search",
    repositoryPath: root,
    repository: repository(),
    workflow,
    step,
  });
}

function limitationIds(result: Awaited<ReturnType<typeof workflowSearch>>): string[] {
  return (result?.evidence.searches ?? []).flatMap((search) =>
    search.bounded.limitations.map((item) => item.id),
  );
}

async function releaseReadinessSearch(workspace: RepositoryWorkspace) {
  const workflow = getWorkflow("release-documentation-readiness");
  const step = workflow.steps.find((candidate) => candidate.search !== undefined)!;
  const result = await workflowSearch({
    workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
    runId: "governed-release-search",
    repositoryPath: workspace.path,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    workflow,
    step,
    repositoryDefaultBranch: "main",
  });
  if (!result) throw new Error("release readiness declares a search plan.");
  return result;
}

async function runReadinessSearch(
  workflowSearchCoordinator: WorkflowSearchCoordinator,
  workspacePath = "/selected/workspace",
  repositoryBinding = repository(),
): Promise<RunRecord> {
  let tick = 0;
  const runner = new WorkflowRunner({
    harness: {
      async runStep(input) {
        return { summary: input.searchEvidence?.evidenceSha256 ?? "missing", outcome: "succeeded" };
      },
    },
    store: { async save() {} },
    repositoryScanner: {
      async scan() {
        return {
          ruleSet: "workflow-search-fixture",
          status: "passed",
          scannedFiles: 1,
          binaryFiles: 0,
          findings: [],
        };
      },
    },
    contextPreflight: {
      async preflight() {
        return { status: "unnecessary", reason: "target-not-applicable" };
      },
    },
    workflowSearch: workflowSearchCoordinator,
    id: () => "workflow-search-cause",
    now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, tick++)),
  });
  return runner.run({
    workflow: "readiness",
    workspacePath,
    repository: repositoryBinding,
    allowWrite: false,
  });
}
