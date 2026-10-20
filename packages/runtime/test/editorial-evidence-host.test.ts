// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createArtifact,
  DurableArtifactStore,
  type ArtifactReference,
} from "../src/artifacts/index.js";
import type { ContentIndexV1 } from "../src/content-ir/contracts.js";
import { canonicalDigest } from "../src/content-ir/index.js";
import type {
  ReaderContextComparisonV1,
  ReaderContextProvenanceSourceV1,
} from "../src/context/reader-context.js";
import { SUPERSEDED_READER_IMPACT_BASELINE_SHA256S } from "../src/execution/task-context.js";
import {
  NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
  NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION,
} from "../src/artifacts/editorial-decision.js";
import { observeReaderTaskContextAdmissionV1 } from "../src/execution/reader-task-admission.js";
import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  bindDocumentationPlanProposal,
  type DocumentationPlanBindingV1,
} from "../src/workflow-execution/plan-binding.js";
import {
  createEditorialEvidenceHostV1,
  HOST_AUDIENCE_ASSESSMENT_RATIONALE,
  loadEditorialEvidenceDecodeOptionsV1,
  type EditorialAssessmentProposalV1,
} from "../src/workflow-execution/editorial-evidence-host.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";

const revision = "a".repeat(40);
const contentDigest = "b".repeat(64);
const workspaceSnapshot = "c".repeat(64);
const temporaryDirectories = temporaryRoots();

describe("production editorial evidence host", () => {
  it("observes exact comparison and explicit source roles from tracked bytes", async () => {
    const root = await temporaryDirectories.create("docsfab-reader-observation-");
    const base = await initFixtureRepo(
      root,
      {
        "docs/cli.md": "# CLI\n\nUse --old.\n",
        "src/orbit.ts": "export const option = '--old';\n",
      },
      { message: "base" },
    );
    await writeFile(resolve(root, "src/orbit.ts"), "export const option = '--new';\n");
    const head = await commitFixture(root, "head");

    const observed = await observeReaderTaskContextAdmissionV1({
      repositoryPath: root,
      revision: head,
      observationMode: "workflow-export",
      readerContextInput: {
        schema_version: 1,
        target_audience: "Orbit users",
        reader_job: "run the command",
        change_scope: ["docs/cli.md"],
        source_priority: ["public contract", "current documentation"],
        required_content: ["current option"],
        excluded_content: [],
        unresolved_questions: [],
      },
      comparisonRequest: { kind: "base-head", baseRevision: base, headRevision: head },
      sourceHints: [{ role: "public-contract", path: "src/orbit.ts" }],
    });

    expect(observed.changedPaths).toEqual(["src/orbit.ts"]);
    expect(observed.admission).toMatchObject({
      admittedRevision: head,
      comparison: { kind: "base-head", base_revision: base, head_revision: head },
    });
    expect(observed.admission.sources.map(({ role, uri }) => [role, uri])).toEqual([
      ["changed-source", "src/orbit.ts"],
      ["current-documentation", "docs/cli.md"],
      ["public-contract", "src/orbit.ts"],
    ]);
    for (const retained of observed.sourceBytes) {
      expect(createHash("sha256").update(retained.bytes).digest("hex")).toBe(
        retained.source.sha256,
      );
    }
  });

  it("rejects dirty selected checkouts and configured-credential source bytes", async () => {
    const root = await temporaryDirectories.create("docsfab-reader-selected-checkout-");
    await initFixtureRepo(root, { "README.md": "# clean\n" }, { message: "base" });
    const readerContextInput = {
      schema_version: 1 as const,
      target_audience: "Orbit users",
      reader_job: "read the guide",
      change_scope: ["README.md"],
      source_priority: ["current documentation"],
      required_content: ["current behavior"],
      excluded_content: [],
      unresolved_questions: [],
    };

    await writeFile(resolve(root, "README.md"), "# dirty\n");
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: root,
        observationMode: "selected-checkout",
        readerContextInput,
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });

    // Only a configured credential refuses source bytes (#1807).
    const configured = configureCredential(
      `sk-${["Xq7L", "m2Rt", "9Wk4", "Hn3B", "vC8z", "Pd5G"].join("")}`,
    );
    await writeFile(resolve(root, "README.md"), `# clean\n\n${configured}\n`);
    await commitFixture(root, "credential");
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: root,
        observationMode: "selected-checkout",
        readerContextInput,
      }),
    ).rejects.toMatchObject({ code: "credential-material" });
  });

  it("admits credential-shaped source bytes and refuses a configured credential in them", async () => {
    // A credential shape is evidence like any other text (#1807).
    const shaped = `implementation bytes token ${["glpat", "-", "A1b2C3d4E5f6G7h8J9k0"].join("")}`;
    await expect(createFixture(undefined, shaped)).resolves.toBeDefined();
    const configured = configureCredential(["fixture", "evidence", "orchard", "lamp"].join("-"));
    await expect(
      createFixture(undefined, `implementation bytes ${configured}`),
    ).rejects.toMatchObject({
      code: "credential-material",
    });
  });

  // 0: an empty tracked file, such as an empty instruction file, is admitted
  // evidence rather than a pre-run `invalid-value`.
  it.each([0, 32, 49_153, 1024 * 1024])(
    "replays genuine decisions with %i admitted source bytes",
    async (sourceSize) => {
      const fixture = await createFixture(undefined, "x".repeat(sourceSize));
      const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
      const selection = await fixture.host.select({
        workflow: getWorkflow("update-documentation"),
        record,
        proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
      });
      expect(selection).toMatchObject({ candidate: "no-change", branchId: "assess-no-change" });
      expect(selection.candidateArtifact).toBeDefined();
      record.steps[0]!.artifacts!.push({
        role: "output",
        stepId: "plan-documentation",
        reference: selection.candidateArtifact!,
      });

      for (const [stepId, assessment] of [
        ["verify-technical-accuracy", "accepted"],
        ["review-documentation", "accepted"],
        ["test-audience-understanding", "not-applicable"],
        ["evaluate-document-quality", "accepted"],
      ] as const) {
        record.steps.push(step(stepId, fixture.reference));
        await fixture.host.observeAssessment({
          workflow: getWorkflow("update-documentation"),
          record,
          stepId,
          proposal: assessmentProposal(fixture.reference, assessment, "shared evidence"),
        });
      }
      const finalReference = await fixture.host.finalize({
        workflow: getWorkflow("update-documentation"),
        record,
        selection,
        coverageSha256: "d".repeat(64),
      });

      expect(
        fixture.host.decodeEditorialDecision(selection.candidateArtifact!, "plan-documentation"),
      ).toMatchObject({ phase: "candidate", candidate: "no-change" });
      expect(
        fixture.host.decodeEditorialDecision(finalReference, "evaluate-document-quality"),
      ).toMatchObject({
        phase: "validated",
        candidate: "no-change",
        candidateArtifact: selection.candidateArtifact,
      });

      record.artifacts = [
        { role: "output", stepId: "plan-documentation", reference: selection.candidateArtifact! },
        {
          role: "output",
          stepId: "evaluate-document-quality",
          reference: finalReference,
        },
      ];
      const replay = await loadEditorialEvidenceDecodeOptionsV1({
        store: new DurableArtifactStore(fixture.store.root),
        record,
        baselineSha256: fixture.baselineSha256,
        policy: fixture.policy,
        admission: fixture.admission,
      });
      expect(
        replay.decodeEditorialDecision(finalReference, "evaluate-document-quality"),
      ).toMatchObject({ phase: "validated", candidate: "no-change" });

      const locator = canonicalDigest({
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-locator",
        digest: finalReference.digest,
      });
      const objectPath = resolve(fixture.store.root, "objects", "sha256", `${locator}.json`);
      const retained = await readFile(objectPath, "utf8");
      await writeFile(
        objectPath,
        retained.replace('"candidate":"no-change"', '"candidate":"update"'),
      );
      await expect(
        loadEditorialEvidenceDecodeOptionsV1({
          store: new DurableArtifactStore(fixture.store.root),
          record,
          baselineSha256: fixture.baselineSha256,
          policy: fixture.policy,
          admission: fixture.admission,
        }),
      ).rejects.toBeDefined();
    },
  );

  // A no-change candidate rests on source coverage under a comparison or, when
  // no base and head comparison is declared, on the plan's kept pages, each
  // admitted as current documentation with the request. Each row names the
  // guard it pins. The label is the basis code the decision discloses; only a
  // comparison of two distinct commits carries none.
  it.each([
    {
      name: "a kept page under an unknown comparison",
      comparison: UNKNOWN,
      sources: "kept-page",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:kept-pages",
    },
    {
      name: "a kept page under a workspace comparison",
      comparison: WORKSPACE,
      sources: "kept-page",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:kept-pages",
    },
    {
      name: "a kept page with an out-of-scope page beside it",
      comparison: UNKNOWN,
      sources: "kept-page",
      pages: [RETAIN_CLI, { path: "docs/other.md", disposition: "out-of-scope" }],
      expected: "no-change:assess-no-change:kept-pages",
    },
    {
      name: "the commit comparison's own coverage",
      comparison: COMMIT,
      sources: "coverage",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:commit-comparison",
    },
    {
      name: "the commit comparison's coverage beside the request and a kept page",
      comparison: COMMIT,
      sources: "coverage-and-request",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:commit-comparison",
    },
    {
      name: "nominated coverage under a workspace comparison",
      comparison: WORKSPACE,
      sources: "coverage",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:nominated-coverage",
    },
    {
      // Both bases hold; coverage takes precedence over the kept page.
      name: "nominated coverage beside the request and a kept page (precedence)",
      comparison: WORKSPACE,
      sources: "coverage-and-request",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:nominated-coverage",
    },
    {
      name: "coverage beside the request and a kept page under an unknown comparison",
      comparison: UNKNOWN,
      sources: "coverage-and-request",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:kept-pages",
    },
    {
      // A base and head comparison of one commit declares no change, so its
      // coverage rests on nominated roles.
      name: "coverage under a comparison of one commit",
      comparison: SAME_COMMIT,
      sources: "coverage",
      pages: [RETAIN_CLI],
      expected: "no-change:assess-no-change:nominated-coverage",
    },
    {
      name: "a kept page under a comparison of one commit",
      comparison: SAME_COMMIT,
      sources: "kept-page",
      pages: [RETAIN_CLI],
      expected: "refused:independent-rejection",
    },
    {
      name: "a kept page with no admitted current documentation",
      comparison: UNKNOWN,
      sources: "kept-page",
      pages: [{ path: "docs/other.md", disposition: "retain" }],
      expected: "refused:independent-rejection",
    },
    {
      name: "a commit comparison without its source coverage",
      comparison: COMMIT,
      sources: "kept-page",
      pages: [RETAIN_CLI],
      expected: "refused:independent-rejection",
    },
    {
      name: "a plan that edits one page and keeps another (unknown comparison)",
      comparison: UNKNOWN,
      sources: "kept-pages",
      pages: [UPDATE_CLI, { path: "docs/guide.md", disposition: "retain" }],
      expected: "refused:independent-rejection",
    },
    {
      name: "a plan that edits one page and keeps another (workspace comparison)",
      comparison: WORKSPACE,
      sources: "kept-pages",
      pages: [UPDATE_CLI, { path: "docs/guide.md", disposition: "retain" }],
      expected: "refused:independent-rejection",
    },
    {
      name: "every source role but no comparison, with an editing plan",
      comparison: UNKNOWN,
      sources: "coverage",
      pages: [UPDATE_CLI],
      expected: "refused:independent-rejection",
    },
    {
      name: "a kept page without the admitted request",
      comparison: UNKNOWN,
      sources: "kept-page-no-request",
      pages: [RETAIN_CLI],
      expected: "refused:independent-rejection",
    },
    {
      name: "a plan that keeps no page and marks every page out of scope",
      comparison: UNKNOWN,
      sources: "kept-page",
      pages: [{ path: "docs/cli.md", disposition: "out-of-scope" }],
      expected: "refused:independent-rejection",
    },
  ] as const)("judges no-change for $name", async ({ comparison, sources, pages, expected }) => {
    const fixture = await createFixture(undefined, undefined, { comparison, sources });
    const plan = bindDocumentationPlanProposal(
      {
        mode: "update",
        pages: pages.map((page) => ({ ...page })),
        sourceBindings: pages
          .filter((page) => page.disposition === "update")
          .map((page) => ({ pagePath: page.path, sources: ["src/orbit.py"] })),
      },
      { expectedMode: "update" },
    );
    const record = runRecord(plan, [step("plan-documentation", fixture.reference)]);
    let selection;
    try {
      selection = await fixture.host.select({
        workflow: getWorkflow("update-documentation"),
        record,
        proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
      });
    } catch (error) {
      expect(`refused:${String((error as { code?: unknown }).code)}`).toBe(expected);
      return;
    }
    const decision = fixture.host.decodeEditorialDecision(
      selection.candidateArtifact!,
      "plan-documentation",
    );
    const disclosed = decision.limitations
      .filter((code) => code.startsWith(BASIS_PREFIX))
      .map((code) => code.slice(BASIS_PREFIX.length));
    const basis = disclosed.length > 0 ? disclosed.join("+") : "commit-comparison";
    expect(`${selection.candidate}:${String(selection.branchId)}:${basis}`).toBe(expected);
  });

  // The planner and every assessor name both host codes. The host drops each
  // copy, writes the code of the basis the evidence used, and the run seals.
  it.each([
    { name: "a commit comparison", comparison: COMMIT, sources: "coverage", expected: [] },
    {
      name: "nominated coverage",
      comparison: WORKSPACE,
      sources: "coverage",
      expected: [NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION],
    },
    {
      name: "a comparison of one commit",
      comparison: SAME_COMMIT,
      sources: "coverage",
      expected: [NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION],
    },
    {
      name: "kept pages",
      comparison: UNKNOWN,
      sources: "kept-page",
      expected: [NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION],
    },
  ] as const)(
    "owns the basis code: model copies never change the basis $name discloses",
    async ({ comparison, sources, expected }) => {
      // The whole `no-change-basis.` namespace is host-owned, including codes
      // the host never writes.
      const copies = [
        NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
        NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION,
        `${BASIS_PREFIX}model-invented`,
      ];
      const fixture = await createFixture(undefined, undefined, { comparison, sources });
      const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
      const selection = await fixture.host.select({
        workflow: getWorkflow("update-documentation"),
        record,
        proposal: {
          ...candidateProposal(fixture.reference, fixture.sources[0]!),
          limitations: copies,
        },
      });
      expect(
        fixture.host.decodeEditorialDecision(selection.candidateArtifact!, "plan-documentation")
          .limitations,
      ).toEqual(expected);
      const finalReference = await assessAndFinalize(fixture, record, selection, copies);
      const final = fixture.host.decodeEditorialDecision(
        finalReference,
        "evaluate-document-quality",
      );
      expect(final).toMatchObject({ phase: "validated", candidate: "no-change" });
      expect(final.limitations.filter((code) => code.startsWith(BASIS_PREFIX))).toEqual(expected);
    },
  );

  it("carries the kept-page basis code into the validated decision and its cold replay", async () => {
    const fixture = await createFixture(undefined, undefined, {
      comparison: UNKNOWN,
      sources: "kept-page",
    });
    const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
    const selection = await fixture.host.select({
      workflow: getWorkflow("update-documentation"),
      record,
      proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
    });
    const finalReference = await assessAndFinalize(fixture, record, selection, []);
    expect(
      fixture.host.decodeEditorialDecision(finalReference, "evaluate-document-quality").limitations,
    ).toContain(NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION);
    record.artifacts = [
      { role: "output", stepId: "plan-documentation", reference: selection.candidateArtifact! },
      { role: "output", stepId: "evaluate-document-quality", reference: finalReference },
    ];
    const replay = await loadEditorialEvidenceDecodeOptionsV1({
      store: new DurableArtifactStore(fixture.store.root),
      record,
      baselineSha256: fixture.baselineSha256,
      policy: fixture.policy,
      admission: fixture.admission,
    });
    expect(
      replay.decodeEditorialDecision(finalReference, "evaluate-document-quality").limitations,
    ).toContain(NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION);
  });

  it("binds the kept-page basis to the decision's own plan at the decoder", async () => {
    const fixture = await createFixture(undefined, undefined, {
      comparison: UNKNOWN,
      sources: "kept-page",
    });
    const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
    const selection = await fixture.host.select({
      workflow: getWorkflow("update-documentation"),
      record,
      proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
    });
    record.artifacts = [
      { role: "output", stepId: "plan-documentation", reference: selection.candidateArtifact! },
    ];
    record.steps[0]!.artifacts!.push(record.artifacts[0]!);
    const replay = (candidate: RunRecord) =>
      loadEditorialEvidenceDecodeOptionsV1({
        store: new DurableArtifactStore(fixture.store.root),
        record: candidate,
        baselineSha256: fixture.baselineSha256,
        policy: fixture.policy,
        admission: fixture.admission,
      }).then(
        (options) =>
          options.decodeEditorialDecision(selection.candidateArtifact!, "plan-documentation")
            .candidate,
        (error: unknown) => `refused:${String((error as { code?: unknown }).code)}`,
      );
    expect(await replay(record)).toBe("no-change");
    // Another valid plan that keeps the same page: the decoder itself refuses
    // the kept-page basis, before the replay's own plan-digest check.
    const substituted = structuredClone(record);
    substituted.steps[0]!.planBinding = bindDocumentationPlanProposal(
      {
        mode: "update",
        pages: [RETAIN_CLI, { path: "docs/other.md", disposition: "out-of-scope" }],
        sourceBindings: [],
      },
      { expectedMode: "update" },
    );
    expect(await replay(substituted)).toBe("refused:independent-rejection");
  });

  // A stored decision carries exactly its basis code, in either phase. The one
  // exception is a nominated-coverage decision sealed before decisions carried
  // the code; it still decodes, and readers disclose the basis for it. A
  // decision that is not a no-change carries no basis code.
  it.each([
    {
      name: "a current nominated-coverage candidate",
      phase: "candidate",
      comparison: WORKSPACE,
      sources: "coverage",
      stored: [NOMINATED],
      expected: "decoded",
    },
    {
      name: "a nominated-coverage candidate sealed before the code",
      phase: "candidate",
      comparison: WORKSPACE,
      sources: "coverage",
      stored: [],
      expected: "decoded",
    },
    {
      name: "a same-commit coverage candidate sealed before the code",
      phase: "candidate",
      comparison: SAME_COMMIT,
      sources: "coverage",
      stored: [],
      expected: "decoded",
    },
    {
      name: "nominated coverage forged as kept pages",
      phase: "candidate",
      comparison: WORKSPACE,
      sources: "coverage",
      stored: [KEPT],
      expected: "refused:invalid-value",
    },
    {
      name: "nominated coverage carrying both codes",
      phase: "candidate",
      comparison: WORKSPACE,
      sources: "coverage",
      stored: [KEPT, NOMINATED],
      expected: "refused:invalid-value",
    },
    {
      name: "a commit-comparison candidate carrying a basis code",
      phase: "candidate",
      comparison: COMMIT,
      sources: "coverage",
      stored: [NOMINATED],
      expected: "refused:invalid-value",
    },
    {
      name: "a kept-page candidate without its code",
      phase: "candidate",
      comparison: UNKNOWN,
      sources: "kept-page",
      stored: [],
      expected: "refused:invalid-value",
    },
    {
      name: "a kept-page candidate forged as nominated coverage",
      phase: "candidate",
      comparison: UNKNOWN,
      sources: "kept-page",
      stored: [NOMINATED],
      expected: "refused:invalid-value",
    },
    {
      name: "an insufficient-evidence candidate without a basis code",
      phase: "candidate",
      candidate: "insufficient-evidence",
      comparison: UNKNOWN,
      sources: "kept-page",
      stored: [],
      expected: "decoded",
    },
    {
      name: "an insufficient-evidence candidate carrying a basis code",
      phase: "candidate",
      candidate: "insufficient-evidence",
      comparison: UNKNOWN,
      sources: "kept-page",
      stored: [KEPT],
      expected: "refused:invalid-value",
    },
    {
      name: "a validated kept-page decision with its code",
      phase: "validated",
      comparison: UNKNOWN,
      sources: "kept-page",
      stored: [KEPT],
      expected: "decoded",
    },
    {
      name: "a validated kept-page decision without its code",
      phase: "validated",
      comparison: UNKNOWN,
      sources: "kept-page",
      stored: [],
      expected: "refused:invalid-value",
    },
    {
      name: "a validated kept-page decision forged as nominated coverage",
      phase: "validated",
      comparison: UNKNOWN,
      sources: "kept-page",
      stored: [NOMINATED],
      expected: "refused:invalid-value",
    },
    {
      name: "a validated nominated-coverage decision sealed before the code",
      phase: "validated",
      comparison: WORKSPACE,
      sources: "coverage",
      stored: [],
      expected: "decoded",
    },
    {
      name: "a validated nominated-coverage decision carrying both codes",
      phase: "validated",
      comparison: WORKSPACE,
      sources: "coverage",
      stored: [KEPT, NOMINATED],
      expected: "refused:invalid-value",
    },
    {
      name: "a validated commit-comparison decision carrying a basis code",
      phase: "validated",
      comparison: COMMIT,
      sources: "coverage",
      stored: [KEPT],
      expected: "refused:invalid-value",
    },
  ] as const)("replays $name from the store: $expected", async (row) => {
    const { phase, comparison, sources, stored, expected } = row;
    const candidate = "candidate" in row ? row.candidate : "no-change";
    const fixture = await createFixture(undefined, undefined, { comparison, sources });
    const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
    const proposal = candidateProposal(fixture.reference, fixture.sources[0]!);
    const selection = await fixture.host.select({
      workflow: getWorkflow("update-documentation"),
      record,
      proposal:
        candidate === "no-change"
          ? proposal
          : {
              ...proposal,
              candidate,
              limitations: ["comparison-unavailable"],
              impactBasis: { ...proposal.impactBasis, kind: "unknown" },
            },
    });
    const sealed =
      phase === "candidate"
        ? selection.candidateArtifact!
        : await assessAndFinalize(fixture, record, selection, []);
    const stepId = phase === "candidate" ? "plan-documentation" : "evaluate-document-quality";
    // Re-seal the stored decision with the given basis codes, as a decision
    // sealed by another build would be, and point the record at it.
    const original = (await fixture.store.getRecord(decisionLocator(sealed.digest))) as Record<
      string,
      unknown
    >;
    const { decisionSha256: _sealed, ...envelope } = original;
    const body = {
      ...envelope,
      limitations: [
        ...(envelope.limitations as string[]).filter((code) => !code.startsWith(BASIS_PREFIX)),
        ...stored,
      ].sort((left, right) => left.localeCompare(right)),
    };
    const resealed = { ...body, decisionSha256: canonicalDigest(body) };
    await fixture.store.putRecord(decisionLocator(resealed.decisionSha256), resealed);
    const reference = { ...sealed, digest: resealed.decisionSha256 };
    record.artifacts =
      phase === "candidate"
        ? [{ role: "output", stepId, reference }]
        : [
            {
              role: "output",
              stepId: "plan-documentation",
              reference: selection.candidateArtifact!,
            },
            { role: "output", stepId, reference },
          ];
    if (phase === "candidate") record.steps[0]!.artifacts!.push(record.artifacts[0]!);
    const result = await loadEditorialEvidenceDecodeOptionsV1({
      store: new DurableArtifactStore(fixture.store.root),
      record,
      baselineSha256: fixture.baselineSha256,
      policy: fixture.policy,
      admission: fixture.admission,
    }).then(
      (options) => options.decodeEditorialDecision(reference, stepId),
      (error: unknown) => `refused:${String((error as { code?: unknown }).code)}`,
    );
    if (expected === "decoded") {
      expect(result).toMatchObject({ phase, candidate });
      expect(
        (result as { limitations: string[] }).limitations.filter((code) =>
          code.startsWith(BASIS_PREFIX),
        ),
      ).toEqual([...stored]);
    } else {
      expect(result).toBe(expected);
    }
  });

  it("replays a decision recorded under the superseded baseline and refuses an unknown one", async () => {
    const installedBaselineSha256 = "7".repeat(64);
    const replay = async (recordedBaselineSha256: string) => {
      const fixture = await createFixture(undefined, undefined, {
        baselineSha256: recordedBaselineSha256,
      });
      const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
      const selection = await fixture.host.select({
        workflow: getWorkflow("update-documentation"),
        record,
        proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
      });
      record.artifacts = [
        { role: "output", stepId: "plan-documentation", reference: selection.candidateArtifact! },
      ];
      record.steps[0]!.artifacts!.push(record.artifacts[0]!);
      return loadEditorialEvidenceDecodeOptionsV1({
        store: new DurableArtifactStore(fixture.store.root),
        record,
        baselineSha256: installedBaselineSha256,
        policy: fixture.policy,
        admission: fixture.admission,
      }).then(
        (options) =>
          options.decodeEditorialDecision(selection.candidateArtifact!, "plan-documentation")
            .candidate,
        (error: unknown) => `refused:${String((error as { code?: unknown }).code)}`,
      );
    };
    expect(await replay(SUPERSEDED_READER_IMPACT_BASELINE_SHA256S[0]!)).toBe("no-change");
    expect(await replay("8".repeat(64))).toBe("refused:identity-mismatch");
  });

  it.each([
    ["not-supplied", "no-change", "host"],
    ["supplied", "insufficient-evidence", "reply"],
  ] as const)(
    "decides the audience assessment only when the run's audience protocol is %s",
    async (audienceProtocol, expectedCandidate, rationaleOwner) => {
      const fixture = await createFixture(undefined, undefined, { audienceProtocol });
      const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
      const selection = await fixture.host.select({
        workflow: getWorkflow("update-documentation"),
        record,
        proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
      });
      record.steps[0]!.artifacts!.push({
        role: "output",
        stepId: "plan-documentation",
        reference: selection.candidateArtifact!,
      });
      // The audience reply rejects the candidate for its missing prerequisites.
      const audienceReply = assessmentProposal(fixture.reference, "rejected", "audience");
      for (const [stepId, proposal] of [
        [
          "verify-technical-accuracy",
          assessmentProposal(fixture.reference, "accepted", "technical"),
        ],
        ["review-documentation", assessmentProposal(fixture.reference, "accepted", "review")],
        ["test-audience-understanding", audienceReply],
        [
          "evaluate-document-quality",
          assessmentProposal(fixture.reference, "accepted", "evaluator"),
        ],
      ] as const) {
        record.steps.push(step(stepId, fixture.reference));
        await fixture.host.observeAssessment({
          workflow: getWorkflow("update-documentation"),
          record,
          stepId,
          proposal,
        });
      }
      const finalReference = await fixture.host.finalize({
        workflow: getWorkflow("update-documentation"),
        record,
        selection,
        coverageSha256: "d".repeat(64),
      });

      expect(
        fixture.host.decodeEditorialDecision(finalReference, "evaluate-document-quality"),
      ).toMatchObject({ phase: "validated", candidate: expectedCandidate });
      // The retained rationale says who decided the audience verdict.
      const rationaleRecord = (text: string) =>
        new DurableArtifactStore(fixture.store.root).getRecord(
          canonicalDigest({
            schemaVersion: 1,
            kind: "docsfab-editorial-rationale-locator",
            digest: createHash("sha256").update(text).digest("hex"),
          }),
        );
      const [kept, dropped] =
        rationaleOwner === "host"
          ? [HOST_AUDIENCE_ASSESSMENT_RATIONALE, audienceReply.rationale]
          : [audienceReply.rationale, HOST_AUDIENCE_ASSESSMENT_RATIONALE];
      await expect(rationaleRecord(kept)).resolves.toMatchObject({ text: kept });
      await expect(rationaleRecord(dropped)).rejects.toBeDefined();
    },
  );

  it("allows identical assessment text in a second run over the same durable store", async () => {
    const first = await createFixture();
    await completeNoChange(first, "run-one");
    const second = await createFixture(first.store.root);
    await expect(completeNoChange(second, "run-two")).resolves.toBeDefined();
  });

  it("rejects unbound, stale, and conflicting assessment evidence", async () => {
    const fixture = await createFixture();
    const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)]);
    const selection = await fixture.host.select({
      workflow: getWorkflow("update-documentation"),
      record,
      proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
    });
    record.steps[0]!.artifacts!.push({
      role: "output",
      stepId: "plan-documentation",
      reference: selection.candidateArtifact!,
    });
    record.steps.push(step("verify-technical-accuracy", fixture.reference));

    const unbound = { ...fixture.reference, digest: "e".repeat(64) };
    await expect(
      fixture.host.observeAssessment({
        workflow: getWorkflow("update-documentation"),
        record,
        stepId: "verify-technical-accuracy",
        proposal: assessmentProposal(unbound, "accepted", "unbound evidence"),
      }),
    ).rejects.toMatchObject({ code: "evidence-unavailable" });

    const stale = structuredClone(record);
    stale.repository.revision = "f".repeat(40);
    await expect(
      fixture.host.observeAssessment({
        workflow: getWorkflow("update-documentation"),
        record: stale,
        stepId: "verify-technical-accuracy",
        proposal: assessmentProposal(fixture.reference, "accepted", "stale evidence"),
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });

    await fixture.host.observeAssessment({
      workflow: getWorkflow("update-documentation"),
      record,
      stepId: "verify-technical-accuracy",
      proposal: assessmentProposal(fixture.reference, "accepted", "accepted evidence"),
    });
    await expect(
      fixture.host.observeAssessment({
        workflow: getWorkflow("update-documentation"),
        record,
        stepId: "verify-technical-accuracy",
        proposal: assessmentProposal(fixture.reference, "rejected", "conflicting evidence"),
      }),
    ).rejects.toMatchObject({ code: "conflicting-assessment" });
  });
});

interface FixtureOptions {
  /** Whether the run supplied an audience protocol; not supplied by default. */
  readonly audienceProtocol?: "supplied" | "not-supplied";
  readonly baselineSha256?: string;
  readonly comparison?: ReaderContextComparisonV1;
  /** Admitted sources; the three source-coverage roles by default. */
  readonly sources?:
    | "coverage"
    | "coverage-and-request"
    | "kept-page"
    | "kept-page-no-request"
    | "kept-pages";
}

async function createFixture(
  storeRoot?: string,
  sourceText = "changed implementation bytes",
  options: FixtureOptions = {},
) {
  const root = await temporaryDirectories.create("docsfab-editorial-host-");
  const nodes: ContentIndexV1["nodes"] = [
    {
      id: "document:cli",
      kind: "document",
      sourcePath: "docs/cli.md",
      format: "markdown",
      byteLength: 64,
      anchors: [],
      frontmatter: [],
      directives: [],
      codeBlocks: [],
      regions: {
        body: "2".repeat(64),
        headings: "3".repeat(64),
        metadata: "4".repeat(64),
        navigation: "5".repeat(64),
        graph: "6".repeat(64),
      },
    },
  ];
  const indexDigest = canonicalDigest({
    schemaVersion: 1,
    repository: { revision, contentDigest },
    nodes,
    edges: [],
  });
  const index: ContentIndexV1 = {
    schemaVersion: 1,
    repository: { revision, contentDigest },
    indexDigest,
    nodes,
    edges: [],
    evidence: {
      repositoryRevision: revision,
      contentDigest,
      indexDigest,
      documentCount: 1,
      sectionCount: 0,
      edgeCount: 0,
    },
  };
  const artifact = createArtifact(
    "context-packet",
    {
      targetNodeId: "document:cli",
      pageRole: {
        contentType: "reference",
        readerJob: "reader:run-inspection",
        organizingAxis: "reader-job",
      },
      ancestors: [],
      siblings: [],
      relatedCanonicalPages: [],
      placementRules: { belongsHere: ["contract:public-command"], belongsElsewhere: [] },
      activeDecisionIds: [],
      structuralPressure: "healthy",
      evidence: [{ path: "docs/cli.md", nodeId: "document:cli" }],
    },
    { index },
  );
  const reference: ArtifactReference = {
    kind: artifact.kind,
    schemaVersion: 1,
    digest: artifact.digest,
    repositoryRevision: revision,
    repositoryContentDigest: contentDigest,
  };
  const page = source("docs/cli.md", "current-documentation", "current documentation bytes");
  const request = source("request:instruction", "request", "Check docs/cli.md for a change.");
  const sourceInputs =
    options.sources === "kept-page"
      ? [page, request]
      : options.sources === "kept-pages"
        ? [page, source("docs/guide.md", "current-documentation", "guide bytes"), request]
        : options.sources === "kept-page-no-request"
          ? [page]
          : [
              source("src/orbit.py", "changed-source", sourceText),
              source("src/orbit.py", "public-contract", sourceText),
              page,
              ...(options.sources === "coverage-and-request" ? [request] : []),
            ];
  const sources = sourceInputs.map(({ source }) => source);
  const store = new DurableArtifactStore(storeRoot ?? resolve(root, "store"));
  const baselineSha256 = options.baselineSha256 ?? "3".repeat(64);
  const policy = {
    id: "docsfab-documentation-quality",
    version: "v0.1",
    sha256: "4".repeat(64),
  };
  const comparison: ReaderContextComparisonV1 = options.comparison ?? {
    kind: "base-head",
    base_revision: "5".repeat(40),
    head_revision: revision,
  };
  const repositoryIdentitySha256 = "6".repeat(64);
  const host = await createEditorialEvidenceHostV1({
    store,
    index,
    readerContextInput: {
      schema_version: 1,
      target_audience: "developers using Orbit",
      reader_job: "run one inspection",
      change_scope: ["docs/cli.md"],
      source_priority: ["public contract", "current documentation", "changed source"],
      required_content: ["command and verification"],
      excluded_content: [],
      unresolved_questions: [],
    },
    baselineSha256,
    policy,
    comparison,
    repositoryIdentitySha256,
    workspaceSnapshotSha256: workspaceSnapshot,
    observedAt: "2026-09-14T12:00:00.000Z",
    provenanceLimitations: [],
    sources: sourceInputs,
    admittedArtifacts: [artifact],
    audienceProtocol: options.audienceProtocol ?? "not-supplied",
    projectCompletedReaderTaskContext: ({ readerContext, provenance }) => {
      const { impact_basis: _impactBasis, ...readerContextInput } = readerContext;
      return {
        schemaVersion: 1,
        kind: "docsfab-reader-task-context-completed",
        inputOrigin: "explicit",
        noChangeAssessment: "requires-evidence",
        readerContextInput,
        baseline: {
          path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md",
          sha256: baselineSha256,
          content: "Use actual reader and source evidence.",
        },
        policy,
        readerContext,
        provenance,
        prompt: "Completed host-validated reader context.",
      };
    },
  });
  return {
    host,
    store,
    baselineSha256,
    policy,
    admission: {
      admittedRevision: revision,
      workspaceSnapshotSha256: workspaceSnapshot,
      repositoryIdentitySha256,
      comparison,
      sources,
      provenanceLimitations: [],
    },
    reference,
    sources,
    plan: bindDocumentationPlanProposal(
      {
        mode: "update",
        pages: [{ path: "docs/cli.md", disposition: "retain" }],
        sourceBindings: [],
      },
      { expectedMode: "update" },
    ),
  };
}

const UNKNOWN: ReaderContextComparisonV1 = { kind: "unknown" };
const WORKSPACE: ReaderContextComparisonV1 = {
  kind: "workspace",
  snapshot_sha256: workspaceSnapshot,
};
const SAME_COMMIT: ReaderContextComparisonV1 = {
  kind: "base-head",
  base_revision: revision,
  head_revision: revision,
};
const COMMIT: ReaderContextComparisonV1 = {
  kind: "base-head",
  base_revision: "5".repeat(40),
  head_revision: revision,
};
const RETAIN_CLI = { path: "docs/cli.md", disposition: "retain" } as const;
const BASIS_PREFIX = "no-change-basis.";
const KEPT = NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION;
const NOMINATED = NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION;

/** The store locator of a retained editorial decision, as the host writes it. */
function decisionLocator(digest: string): string {
  return canonicalDigest({ schemaVersion: 1, kind: "docsfab-editorial-decision-locator", digest });
}
const UPDATE_CLI = { path: "docs/cli.md", disposition: "update" } as const;

/** Run the four independent assessments, each naming `limitations`, then finalize. */
async function assessAndFinalize(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  record: RunRecord,
  selection: Awaited<ReturnType<Awaited<ReturnType<typeof createFixture>>["host"]["select"]>>,
  limitations: readonly string[],
) {
  record.steps[0]!.artifacts!.push({
    role: "output",
    stepId: "plan-documentation",
    reference: selection.candidateArtifact!,
  });
  for (const [stepId, assessment] of [
    ["verify-technical-accuracy", "accepted"],
    ["review-documentation", "accepted"],
    ["test-audience-understanding", "not-applicable"],
    ["evaluate-document-quality", "accepted"],
  ] as const) {
    record.steps.push(step(stepId, fixture.reference));
    const proposal = assessmentProposal(fixture.reference, assessment, `${stepId} evidence`);
    await fixture.host.observeAssessment({
      workflow: getWorkflow("update-documentation"),
      record,
      stepId,
      proposal: { ...proposal, limitations: [...proposal.limitations, ...limitations] },
    });
  }
  return fixture.host.finalize({
    workflow: getWorkflow("update-documentation"),
    record,
    selection,
    coverageSha256: "d".repeat(64),
  });
}

async function completeNoChange(fixture: Awaited<ReturnType<typeof createFixture>>, runId: string) {
  const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)], runId);
  const selection = await fixture.host.select({
    workflow: getWorkflow("update-documentation"),
    record,
    proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
  });
  record.steps[0]!.artifacts!.push({
    role: "output",
    stepId: "plan-documentation",
    reference: selection.candidateArtifact!,
  });
  for (const [stepId, assessment] of [
    ["verify-technical-accuracy", "accepted"],
    ["review-documentation", "accepted"],
    ["test-audience-understanding", "not-applicable"],
    ["evaluate-document-quality", "accepted"],
  ] as const) {
    record.steps.push(step(stepId, fixture.reference));
    await fixture.host.observeAssessment({
      workflow: getWorkflow("update-documentation"),
      record,
      stepId,
      proposal: assessmentProposal(fixture.reference, assessment, "identical retained evidence"),
    });
  }
  return fixture.host.finalize({
    workflow: getWorkflow("update-documentation"),
    record,
    selection,
    coverageSha256: "d".repeat(64),
  });
}

function source(uri: string, role: ReaderContextProvenanceSourceV1["role"], text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    source: { uri, role, sha256: createHash("sha256").update(bytes).digest("hex") },
    bytes,
  };
}

function candidateProposal(
  reference: ArtifactReference,
  impactEvidence: ReaderContextProvenanceSourceV1,
) {
  return {
    schemaVersion: 1,
    kind: "docsfab-editorial-decision-proposal",
    candidate: "no-change",
    rationale: "The public command remains unchanged in the admitted comparison.",
    evidenceRefs: [reference],
    limitations: [],
    impactBasis: {
      kind: "none",
      rationale: "The implementation change does not alter the public command.",
      evidence_refs: [{ uri: impactEvidence.uri, sha256: impactEvidence.sha256 }],
    },
  };
}

function assessmentProposal(
  reference: ArtifactReference,
  assessment: EditorialAssessmentProposalV1["assessment"],
  label: string,
): EditorialAssessmentProposalV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-editorial-assessment-proposal",
    assessment,
    rationale: `The independent ${label} assessment inspected the retained evidence.`,
    evidenceRefs: [reference],
    limitations: assessment === "not-applicable" ? ["audience-check-unavailable"] : [],
    recommendation:
      assessment === "rejected"
        ? {
            candidate: "insufficient-evidence",
            kind: "evidence-limitation",
            code: "evidence-limitation.independent-assessment-rejected",
          }
        : null,
  };
}

function runRecord(
  plan: DocumentationPlanBindingV1,
  steps: StepRunRecord[],
  id = "run-editorial-host",
): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "update-documentation",
    repository: {
      sourcePath: "/tmp/repository",
      requestedRevision: revision,
      revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "running",
    createdAt: "2026-09-14T12:00:00.000Z",
    startedAt: "2026-09-14T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: steps.map((value) =>
      value.id === "plan-documentation" ? { ...value, planBinding: plan } : value,
    ),
  };
}

function step(id: string, reference: ArtifactReference): StepRunRecord {
  return {
    id,
    title: id,
    kind: "evaluate",
    skill: id,
    mode: "read-only",
    status: "succeeded",
    artifacts: [{ role: "input", stepId: id, reference }],
    summary: `${id} completed.`,
  };
}
