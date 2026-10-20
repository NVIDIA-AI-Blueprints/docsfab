// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ReaderContextValidationError,
  READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
  readerContextProvenanceSha256,
  readerContextSha256,
  validateReaderContextInputV1,
  validateReaderContextProvenanceV1,
  validateReaderContextV1,
  type ReaderContextProvenanceV1,
  type ReaderContextV1,
} from "../src/context/reader-context.js";
import {
  conservativeReaderContextInput,
  createReaderTaskContextSupplier,
} from "../src/execution/task-context.js";
import { observeReaderTaskContextAdmissionV1 } from "../src/execution/reader-task-admission.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

const H = (character: string) => character.repeat(64);
const REVISION = "a".repeat(40);
const EVIDENCE = { uri: "artifact:current-docs", sha256: H("1") };

function input(): Omit<ReaderContextV1, "impact_basis"> {
  return {
    schema_version: 1,
    target_audience: "developers",
    reader_job: "run one inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public CLI", "current docs"],
    required_content: ["command", "verification"],
    excluded_content: ["unrelated internals"],
    unresolved_questions: [],
  };
}

function completed(): ReaderContextV1 {
  return {
    ...input(),
    impact_basis: {
      kind: "none",
      rationale: "The changed implementation is internal and public instructions remain current.",
      evidence_refs: [EVIDENCE],
    },
  };
}

function provenance(): ReaderContextProvenanceV1 {
  return {
    schema_version: 1,
    reader_context_sha256: readerContextSha256(completed()),
    baseline_sha256: H("2"),
    admitted_revision: REVISION,
    workspace_snapshot_sha256: H("3"),
    repository_identity_sha256: H("4"),
    policy: { id: "docsfab-documentation-quality", version: "v0.1", sha256: H("5") },
    comparison: {
      kind: "base-head",
      base_revision: "b".repeat(40),
      head_revision: REVISION,
    },
    sources: [
      { ...EVIDENCE, role: "current-documentation" },
      { uri: "artifact:public-contract", sha256: H("6"), role: "public-contract" },
      { uri: "artifact:changed-source", sha256: H("7"), role: "changed-source" },
    ],
    observed_at: "2026-09-12T12:00:00Z",
    limitations: [],
  };
}

function provenanceOptions(value = provenance()) {
  return {
    readerContextSha256: value.reader_context_sha256,
    baselineSha256: value.baseline_sha256,
    admittedRevision: value.admitted_revision,
    workspaceSnapshotSha256: value.workspace_snapshot_sha256,
    repositoryIdentitySha256: value.repository_identity_sha256,
    policy: value.policy,
    admittedSources: value.sources,
  };
}

describe("ReaderContextV1", () => {
  it("validates neutral input separately from the completed impact basis", () => {
    expect(validateReaderContextInputV1(input())).toEqual(input());
    expect(validateReaderContextV1(completed(), { admittedEvidence: [EVIDENCE] })).toEqual(
      completed(),
    );
    expect(() =>
      validateReaderContextInputV1({ ...input(), impact_basis: completed().impact_basis }),
    ).toThrow(ReaderContextValidationError);
  });

  it("rejects unknown fields, duplicates, noncanonical text, bounds and configured credentials", () => {
    const configured = configureCredential(["sk", plantedCredentialValue(64, 32)].join("-"));
    const bad = [
      { ...input(), extra: true },
      { ...input(), change_scope: ["docs/cli.md", "docs/cli.md"] },
      { ...input(), target_audience: "e\u0301" },
      { ...input(), reader_job: "line one\r\nline two" },
      { ...input(), source_priority: [] },
      { ...input(), target_audience: "x".repeat(1_025) },
      { ...input(), known_limitations: [`api_key=${configured}`] },
    ];
    for (const value of bad) expect(() => validateReaderContextInputV1(value)).toThrow();
    // A credential shape that is not one of DocsFab's own configured
    // credentials is reader context like any other text (#1807).
    const shaped = {
      ...input(),
      known_limitations: [`api_key=${["sk", plantedCredentialValue(65, 32)].join("-")}`],
    };
    expect(validateReaderContextInputV1(shaped)).toEqual(shaped);
  });

  it("requires non-unknown candidates to resolve every unique evidence identity", () => {
    expect(() => validateReaderContextV1(completed(), { admittedEvidence: [] })).toThrowError(
      expect.objectContaining({ code: "evidence-unavailable" }),
    );
    expect(() =>
      validateReaderContextV1(
        {
          ...completed(),
          impact_basis: { ...completed().impact_basis, evidence_refs: [EVIDENCE, EVIDENCE] },
        },
        { admittedEvidence: [EVIDENCE] },
      ),
    ).toThrow();
    expect(
      validateReaderContextV1(
        {
          ...completed(),
          impact_basis: {
            kind: "unknown",
            rationale: "The comparison evidence was not available.",
            evidence_refs: [],
          },
        },
        { admittedEvidence: [] },
      ).impact_basis.kind,
    ).toBe("unknown");
  });

  it("uses stable canonical identities without treating them as semantic approval", () => {
    const admitted = validateReaderContextV1(completed(), { admittedEvidence: [EVIDENCE] });
    expect(readerContextSha256(admitted)).toBe(
      "eaf2fa46563961f95c55118776061a9f712886302e3b6b608da55010174edcae",
    );
    expect(readerContextSha256(admitted)).toBe(readerContextSha256(structuredClone(admitted)));
  });
});

describe("ReaderContextProvenanceV1", () => {
  it("admits exact host identities, comparison and source inventory", () => {
    const value = provenance();
    const admitted = validateReaderContextProvenanceV1(value, provenanceOptions(value));
    expect(admitted).toEqual(value);
    expect(readerContextProvenanceSha256(admitted)).toBe(
      "019eeda3f1d29660376affc68c5fbd3d75a33a363899f8055f0cf6df1f42cf6e",
    );
  });

  it("rejects stale identity, changed snapshot, unknown source and unknown fields", () => {
    const value = provenance();
    const cases: Array<[unknown, ReturnType<typeof provenanceOptions>]> = [
      [value, { ...provenanceOptions(value), admittedRevision: "c".repeat(40) }],
      [{ ...value, workspace_snapshot_sha256: H("8") }, provenanceOptions(value)],
      [value, { ...provenanceOptions(value), admittedSources: value.sources.slice(1) }],
      [
        value,
        {
          ...provenanceOptions(value),
          admittedSources: [
            ...value.sources,
            { uri: "artifact:extra-host-source", sha256: H("9"), role: "request" },
          ],
        },
      ],
      [{ ...value, trusted: true }, provenanceOptions(value)],
    ];
    for (const [candidate, options] of cases) {
      expect(() => validateReaderContextProvenanceV1(candidate, options)).toThrow();
    }
  });

  it("keeps unknown comparison explicit and prevents it becoming no-change evidence", () => {
    const value = { ...provenance(), comparison: { kind: "unknown" } as const };
    const admitted = validateReaderContextProvenanceV1(value, provenanceOptions(value));
    expect(admitted.comparison).toEqual({ kind: "unknown" });
  });

  it("binds changed-source inapplicability only to an identical exact comparison", () => {
    const original = provenance();
    const sameRevision = {
      ...original,
      comparison: {
        kind: "base-head" as const,
        base_revision: REVISION,
        head_revision: REVISION,
      },
      sources: original.sources.filter((source) => source.role !== "changed-source"),
      limitations: [READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION],
    };
    expect(
      validateReaderContextProvenanceV1(sameRevision, provenanceOptions(sameRevision)),
    ).toEqual(sameRevision);

    const contradictory = {
      ...sameRevision,
      sources: original.sources,
    };
    expect(() =>
      validateReaderContextProvenanceV1(contradictory, provenanceOptions(contradictory)),
    ).toThrowError(expect.objectContaining({ code: "identity-mismatch" }));

    const changedComparison = {
      ...sameRevision,
      comparison: original.comparison,
    };
    expect(() =>
      validateReaderContextProvenanceV1(changedComparison, provenanceOptions(changedComparison)),
    ).toThrowError(expect.objectContaining({ code: "identity-mismatch" }));

    const honestMissing = { ...changedComparison, limitations: [] };
    expect(() =>
      validateReaderContextProvenanceV1(honestMissing, provenanceOptions(honestMissing)),
    ).not.toThrow();
  });
});

describe("shared reader task context supplier", () => {
  async function supplier() {
    return createReaderTaskContextSupplier(
      await verifyQualityPackContext({
        qualityPackDirectory: resolve("quality-pack"),
        qualityDirectory: resolve("quality"),
        skillCrateDirectory: resolve("skill-crate"),
      }),
    );
  }

  it("projects the exact locked baseline with neutral input only", async () => {
    const contextSupplier = await supplier();
    const projection = contextSupplier.projectInput(input());
    expect(projection.baseline.path).toBe(
      "profiles/docsfab-documentation-quality/reader-impact-baseline.md",
    );
    expect(projection.baseline.sha256).toBe(
      "f7f0942283a720e1aab1311de12dd9e985f629bbc682025492495956c84908b0",
    );
    expect(projection.policy).toEqual({
      id: "docsfab-documentation-quality",
      version: "v0.1",
      sha256: "579023cebc031149d559c070e86dfc0c43f596c0dac8fa68eb2f8dd65ad555a1",
    });
    expect(projection.prompt).toContain("# Reader Impact Baseline");
    expect(projection.prompt).toContain('"reader_job":"run one inspection"');
    expect(projection.prompt).not.toContain('"impact_basis"');
    expect(projection.noChangeAssessment).toBe("requires-evidence");
  });

  // The fallback names the evidence a no-change candidate needs instead of
  // ruling one out, and opens no reader question.
  it("keeps the ordinary update fallback bounded and leaves no-change to the evidence bar", async () => {
    const contextSupplier = await supplier();
    const fallback = conservativeReaderContextInput({ instruction: "Update the CLI guide." });
    expect(fallback.reader_job).toBe("Update the CLI guide.");
    expect(fallback.required_content).toEqual(["Update the CLI guide."]);
    expect(fallback.unresolved_questions).toEqual([]);
    expect(fallback.known_limitations).toHaveLength(2);
    expect(fallback.known_limitations?.join(" ")).not.toContain("ineligible");
    expect(fallback.known_limitations?.[1]).toContain(
      "a plan that keeps every planned page unchanged, each kept page admitted as current documentation",
    );
    const projection = contextSupplier.projectInput(fallback, {
      inputOrigin: "conservative-fallback",
    });
    expect(projection.noChangeAssessment).toBe("requires-evidence");
    expect(projection.prompt).not.toContain("ineligible for a no-change conclusion");
    expect(projection.prompt).toContain("The kept-page basis, unless a base and head commit");
  });

  it("keeps long update requests out of bounded intent fields without losing their evidence reference", () => {
    for (const length of [1_025, 3_751, 10_255]) {
      const instruction = "x".repeat(length);
      const fallback = conservativeReaderContextInput({ instruction });
      expect(fallback.reader_job).toContain("request:instruction");
      expect([...fallback.reader_job].length).toBeLessThanOrEqual(1_024);
      if (length <= 4_096) expect(fallback.required_content).toEqual([instruction]);
      else expect(fallback.required_content[0]).toContain("full request:instruction");
    }
    expect(conservativeReaderContextInput({ instruction: "😀".repeat(1_024) }).reader_job).toBe(
      "😀".repeat(1_024),
    );
  });

  it("seals exact comparison and source identity and rejects snapshot drift", async () => {
    const contextSupplier = await supplier();
    const source = { ...EVIDENCE, role: "current-documentation" as const };
    const admission = {
      admittedRevision: REVISION,
      workspaceSnapshotSha256: H("3"),
      repositoryIdentitySha256: H("4"),
      comparison: {
        kind: "base-head" as const,
        base_revision: H("b").slice(0, 40),
        head_revision: REVISION,
      },
      sources: [source],
      provenanceLimitations: [],
    };
    const handoff = contextSupplier.createHandoff({
      readerContextInput: input(),
      admission,
      sourceBinding: EVIDENCE,
    });
    expect(handoff.noChangeAssessment).toBe("requires-evidence");
    expect(contextSupplier.validateHandoff(structuredClone(handoff), admission)).toEqual(handoff);
    expect(() =>
      contextSupplier.validateHandoff(handoff, {
        ...admission,
        workspaceSnapshotSha256: H("8"),
      }),
    ).toThrowError(expect.objectContaining({ code: "stale" }));
    expect(() =>
      contextSupplier.createHandoff({
        readerContextInput: input(),
        admission,
        sourceBinding: { uri: "artifact:unknown", sha256: H("9") },
      }),
    ).toThrowError(expect.objectContaining({ code: "identity-mismatch" }));
  });

  it("revalidates completed context and provenance against current host admission", async () => {
    const contextSupplier = await supplier();
    const source = { ...EVIDENCE, role: "current-documentation" as const };
    const admission = {
      admittedRevision: REVISION,
      workspaceSnapshotSha256: H("3"),
      repositoryIdentitySha256: H("4"),
      comparison: { kind: "workspace" as const, snapshot_sha256: H("3") },
      sources: [source],
      provenanceLimitations: [],
    };
    const readerContext = completed();
    const readerProvenance = {
      schema_version: 1 as const,
      reader_context_sha256: readerContextSha256(readerContext),
      baseline_sha256: contextSupplier.baseline.sha256,
      admitted_revision: REVISION,
      workspace_snapshot_sha256: H("3"),
      repository_identity_sha256: H("4"),
      policy: contextSupplier.policy,
      comparison: admission.comparison,
      sources: admission.sources,
      observed_at: "2026-09-12T12:00:00Z",
      limitations: [],
    };
    const projection = contextSupplier.projectCompleted({
      readerContext,
      provenance: readerProvenance,
      admission,
    });
    expect(projection.readerContext).toEqual(readerContext);
    expect(projection.provenance).toEqual(readerProvenance);
    expect(projection.prompt).toContain("Host-validated ReaderContextV1");
    expect(() =>
      contextSupplier.projectCompleted({
        readerContext,
        provenance: readerProvenance,
        admission: { ...admission, repositoryIdentitySha256: H("9") },
      }),
    ).toThrow();
  });
});

describe("reader task admission observation", () => {
  it("hashes tracked comparison sources and rejects a dirty direct checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-reader-context-"));
    try {
      const baseRevision = await initFixtureRepo(
        root,
        {
          "docs/cli.md": "# CLI\n\nUse --old.\n",
          "src/cli.ts": "export const flag = '--old';\n",
        },
        { message: "base" },
      );
      await writeFile(join(root, "src/cli.ts"), "export const flag = '--new';\n");
      const headRevision = await commitFixture(root, "head");
      const observed = await observeReaderTaskContextAdmissionV1({
        repositoryPath: root,
        revision: headRevision,
        observationMode: "workflow-export",
        readerContextInput: input(),
        comparisonRequest: {
          kind: "base-head",
          baseRevision,
          headRevision,
        },
        sourceHints: [{ role: "public-contract", path: "src/cli.ts" }],
      });

      expect(observed.changedPaths).toEqual(["src/cli.ts"]);
      expect(observed.admission.comparison).toEqual({
        kind: "base-head",
        base_revision: baseRevision,
        head_revision: headRevision,
      });
      expect(observed.admission.sources.map(({ role, uri }) => [role, uri])).toEqual([
        ["changed-source", "src/cli.ts"],
        ["current-documentation", "docs/cli.md"],
        ["public-contract", "src/cli.ts"],
      ]);
      expect(observed.admission.provenanceLimitations).toEqual([]);

      const identical = await observeReaderTaskContextAdmissionV1({
        repositoryPath: root,
        revision: headRevision,
        observationMode: "workflow-export",
        readerContextInput: input(),
        comparisonRequest: {
          kind: "base-head",
          baseRevision: headRevision,
          headRevision,
        },
        sourceHints: [{ role: "public-contract", path: "src/cli.ts" }],
      });
      expect(identical.changedPaths).toEqual([]);
      expect(identical.admission.sources.map(({ role }) => role)).toEqual([
        "current-documentation",
        "public-contract",
      ]);
      expect(identical.admission.provenanceLimitations).toEqual([
        READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
      ]);
      const contextSupplier = await createReaderTaskContextSupplier(
        await verifyQualityPackContext({
          qualityPackDirectory: resolve("quality-pack"),
          qualityDirectory: resolve("quality"),
          skillCrateDirectory: resolve("skill-crate"),
        }),
      );
      const handoff = contextSupplier.createHandoff({
        readerContextInput: input(),
        admission: identical.admission,
      });
      expect(handoff.provenanceLimitations).toEqual([
        READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
      ]);
      expect(contextSupplier.validateHandoff(handoff, identical.admission)).toEqual(handoff);

      await writeFile(join(root, "docs/cli.md"), "# dirty\n");
      await expect(
        observeReaderTaskContextAdmissionV1({
          repositoryPath: root,
          observationMode: "selected-checkout",
          readerContextInput: input(),
        }),
      ).rejects.toMatchObject({ code: "identity-mismatch" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
