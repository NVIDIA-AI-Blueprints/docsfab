// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  createHistoricalEmptyExternalInputManifest,
  digestExternalInputLocator,
  mintExternalInputManifest,
  openExternalInputAccessCapture,
  openExternalInputRegistry,
  projectExternalInputDisclosure,
  projectExternalInputManifest,
  registerExternalInput,
  registerFakeExternalInput,
  type ExternalInputRegistrationV1,
  type ExternalInputRunBindingV1,
} from "../src/inputs/index.js";
import { internalCreateExternalInputHostAuthority } from "../src/inputs/authority-internal.js";
import {
  createBoundedInstructionRequestIdentity,
  createHistoricalUnknownTaskLineage,
  createTaskLineageArtifacts,
  mintCliOperatorDirectedLineage,
  mintTaskLineageHostCapability,
  projectTaskLineage,
  type DecisionAttributionInputV1,
  type TaskOriginInputV1,
} from "../src/lineage/index.js";
import { internalCreateTaskLineageHostAuthority } from "../src/lineage/authority-internal.js";
import * as publicationPublicApi from "../src/publication/index.js";
import {
  MAX_PUBLICATION_INPUT_USES,
  PUBLICATION_DISCLOSURE_SURFACES,
  PUBLICATION_LIMITATION_CODES,
  PUBLICATION_PROVENANCE_PROJECTOR_SURFACE,
  PublicationProvenanceProjectorError,
  assertPublicationEvidenceProjection,
  assertPublicationEvidenceResumeEquivalent,
  assertPublicationProvenanceInputs,
  projectPublicationEvidence,
  projectPublicationEvidenceFromInputs,
  projectPublicationEvidenceFromRunLineage,
  projectPublicationInputDisclosure,
  projectPublicationProvenanceInputs,
  projectTaskLineage as projectPublicationTaskLineage,
  type PublicationEvidenceProjectionV1,
} from "../src/publication/index.js";
import { buildDocsFabPublicationMetadata } from "../src/delivery/metadata.js";
import {
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/contracts.js";
import { selectDocumentationValidationProfile } from "../src/delivery/validation-profile.js";
import { validationBackendPolicySha256 } from "../src/delivery/worktree/validation-backend.js";
import { buildCurrentTaskLineageFixture } from "./helpers/current-task-lineage.js";
import { configureCredential } from "./helpers/configured-credential.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

const lineageFixture = buildCurrentTaskLineageFixture();

const inputsFixture = JSON.parse(
  readFileSync(new URL("./fixtures/external-input-manifest-v1.json", import.meta.url), "utf8"),
) as {
  binding: ExternalInputRunBindingV1;
  supplier: ExternalInputRegistrationV1["supplier"];
  entries: Array<{
    inputId: string;
    sourceKind: ExternalInputRegistrationV1["sourceKind"];
    safeTitle: string;
    canonicalLocator: string;
    visibility: ExternalInputRegistrationV1["visibility"];
    disclosurePolicy: ExternalInputRegistrationV1["disclosurePolicy"];
    intendedRoles: ExternalInputRegistrationV1["intendedRoles"];
    version: ExternalInputRegistrationV1["version"];
    body: string | null;
  }>;
};

const SHA = (character: string) => character.repeat(64);

describe("publication provenance projectors", () => {
  it("exposes the documented #118 API surface without narrative renderers", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: Record<string, string>;
    };
    expect(packageJson.exports).toEqual({
      "./roadmap": "./dist/roadmap/index.js",
      "./lineage": "./dist/lineage/index.js",
      "./inputs": "./dist/inputs/index.js",
      "./canon": "./dist/canon/index.js",
      "./publication": "./dist/publication/index.js",
      "./review-delivery": "./dist/review-delivery/public.js",
    });
    expect(PUBLICATION_PROVENANCE_PROJECTOR_SURFACE.packageExports).toContain(
      "docsfab/publication",
    );
    expect(PUBLICATION_PROVENANCE_PROJECTOR_SURFACE.projectors).toEqual([
      "projectPublicationProvenanceInputs",
      "projectTaskLineage",
      "projectExternalInputManifest",
      "projectExternalInputDisclosure",
    ]);
    expect(PUBLICATION_PROVENANCE_PROJECTOR_SURFACE.nonGoals).toContain(
      "commit-message-narrative-rendering",
    );
    expect(PUBLICATION_PROVENANCE_PROJECTOR_SURFACE.nonGoals).toContain(
      "merge-request-narrative-rendering",
    );
    expect(PUBLICATION_DISCLOSURE_SURFACES).toEqual(["commit-message", "mr-description"]);

    const exported = Object.keys(publicationPublicApi);
    expect(exported).toContain("projectPublicationProvenanceInputs");
    expect(exported).toContain("projectTaskLineage");
    expect(exported).toContain("projectExternalInputManifest");
    expect(exported).toContain("projectExternalInputDisclosure");
    expect(exported).toContain("assertPublicationProvenanceInputs");
    expect(
      exported.some((name) =>
        /buildDocsFabPublicationMetadata|render|narrative|commitMessage/i.test(name),
      ),
    ).toBe(false);
    expect(
      exported.every((name) => !name.startsWith("internal") && !name.includes("HostAuthority")),
    ).toBe(true);
  });

  it("bundles lineage and inputs projections without inventing a third dialect", async () => {
    const artifacts = createTaskLineageArtifacts(await mintLineage("operator-directed", SHA("1")));
    const manifest = await mintManifest(SHA("2"));
    const lineageProjection = projectTaskLineage(artifacts.origin, artifacts.lineage);
    expect(projectPublicationTaskLineage(artifacts.origin, artifacts.lineage)).toEqual(
      lineageProjection,
    );
    const inputsProjection = projectExternalInputManifest(manifest);

    const bundled = projectPublicationProvenanceInputs({
      origin: artifacts.origin,
      lineage: artifacts.lineage,
      manifest,
    });

    expect(bundled.kind).toBe("docsfab-publication-provenance-inputs");
    expect(bundled.lineage).toEqual(lineageProjection);
    expect(bundled.inputs).toEqual(inputsProjection);
    expect(bundled.provenanceInputsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(assertPublicationProvenanceInputs(bundled)).toEqual(bundled);

    const text = JSON.stringify(bundled);
    expect(text).not.toContain("operator:fixture");
    expect(text).not.toContain("Guide");
    expect(text).not.toContain("repo://docs/guide.md");
    expect(text).not.toContain("Maintainers request");
    expect(text).not.toContain("glpat-");
    expect(bundled).not.toHaveProperty("approval");
    expect(bundled).not.toHaveProperty("safeTitle");
    expect(bundled.lineage).not.toHaveProperty("recommendation");
    expect(
      bundled.inputs.entries.every((entry) => !("safeTitle" in entry) && !("body" in entry)),
    ).toBe(true);
  });

  it("rejects unknown bundle fields, credentials, and tampered digests", async () => {
    configureCredential(["glpat", "abcdefghijklmnopqrst"].join("-"));
    const artifacts = createTaskLineageArtifacts(await mintLineage("docsfab-autonomous", SHA("3")));
    const manifest = await mintManifest(SHA("4"));
    expectProjectorError(
      () =>
        projectPublicationProvenanceInputs({
          origin: artifacts.origin,
          lineage: artifacts.lineage,
          manifest,
          narrative: "do not invent prose",
        } as never),
      "invalid-shape",
    );

    expectProjectorError(
      () =>
        projectPublicationProvenanceInputs({
          origin: {
            ...artifacts.origin,
            lineageId: "glpat-abcdefghijklmnopqrst",
          },
          lineage: artifacts.lineage,
          manifest,
        }),
      "credential-material",
    );

    const bundled = projectPublicationProvenanceInputs({
      origin: artifacts.origin,
      lineage: artifacts.lineage,
      manifest,
    });
    const tampered = {
      ...bundled,
      provenanceInputsSha256: "0".repeat(64),
    };
    expectProjectorError(() => assertPublicationProvenanceInputs(tampered), "digest-mismatch");
  });

  it("clamps publication disclosure to commit/MR surfaces via the inputs projector", async () => {
    const capability = openExternalInputAccessCapture(inputsFixture.binding);
    const repo = inputsFixture.entries[0]!;
    registerFakeExternalInput(capability, repo.inputId, {
      adapterKind: repo.sourceKind,
      canonicalLocator: repo.canonicalLocator,
      safeTitle: repo.safeTitle,
      body: repo.body,
      version: repo.version,
      visibility: repo.visibility,
      disclosurePolicy: repo.disclosurePolicy,
      intendedRoles: repo.intendedRoles,
    });

    const mr = projectPublicationInputDisclosure(capability, {
      inputId: repo.inputId,
      surface: "mr-description",
      requestedLevel: "bounded-excerpt",
      canonicalLocator: repo.canonicalLocator,
      excerptCandidate: "Bounded documentation improvement.",
    });
    expect(mr).toEqual(
      projectExternalInputDisclosure(capability, {
        inputId: repo.inputId,
        surface: "mr-description",
        requestedLevel: "bounded-excerpt",
        canonicalLocator: repo.canonicalLocator,
        excerptCandidate: "Bounded documentation improvement.",
      }),
    );
    expect(mr.level).toBe("permission-aware-link");
    expect(mr.boundedExcerpt).toBeNull();
    expect(JSON.stringify(mr)).not.toContain("Bounded documentation");

    expectProjectorError(
      () =>
        projectPublicationInputDisclosure(capability, {
          inputId: repo.inputId,
          surface: "prompt",
          requestedLevel: "bounded-excerpt",
          excerptCandidate: "must not use prompt surface here",
        }),
      "invalid-value",
    );
  });
});

describe("publication evidence projection (#130)", () => {
  it("derives a validated, content-minimized evidence summary from authenticated evidence", async () => {
    const artifacts = createTaskLineageArtifacts(await mintLineage("operator-directed", SHA("a")));
    const manifest = await mintManifest(SHA("b"));

    const evidence = projectPublicationEvidence({
      origin: artifacts.origin,
      lineage: artifacts.lineage,
      manifest,
    });

    expect(evidence.kind).toBe("docsfab-publication-evidence-projection");
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.taskOrigin).toBe("operator-directed");
    expect(evidence.authorityStatus).toBe("host-authenticated");
    expect(evidence.provenanceAvailable).toBe(true);
    expect(evidence.requestPresent).toBe(true);
    expect(evidence.selectedWorkflow).not.toBeNull();
    expect(evidence.inputUseCount).toBe(inputsFixture.entries.length);
    expect(evidence.inputUsesTruncated).toBe(false);
    expect(evidence.inputUses).toHaveLength(inputsFixture.entries.length);
    expect(evidence.disclosurePolicies).toEqual([...evidence.disclosurePolicies].sort());
    expect(evidence.limitations).toContain("restricted-disclosure-present");
    expect(evidence.limitations).not.toContain("historical-provenance-unavailable");
    expect(evidence.limitations).not.toContain("no-external-inputs");
    // Limitations are a sorted subset of the closed, honest vocabulary.
    expect(evidence.limitations).toEqual(
      PUBLICATION_LIMITATION_CODES.filter((code) => evidence.limitations.includes(code)),
    );
    expect(evidence.evidenceProjectionSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(assertPublicationEvidenceProjection(evidence)).toEqual(evidence);

    // Credential-free and prose-free: no private titles, bodies, or locators leak.
    const text = JSON.stringify(evidence);
    expect(text).not.toContain("Guide");
    expect(text).not.toContain("repo://docs/guide.md");
    expect(text).not.toContain("operator:fixture");
    expect(text).not.toContain("glpat-");
    for (const use of evidence.inputUses) {
      expect(use).not.toHaveProperty("safeTitle");
      expect(use).not.toHaveProperty("body");
    }
  });

  it("agrees whether derived from raw artifacts or a sealed provenance bundle", async () => {
    const artifacts = createTaskLineageArtifacts(await mintLineage("docsfab-autonomous", SHA("c")));
    const manifest = await mintManifest(SHA("d"));
    const bundle = projectPublicationProvenanceInputs({
      origin: artifacts.origin,
      lineage: artifacts.lineage,
      manifest,
    });

    const fromRaw = projectPublicationEvidence({
      origin: artifacts.origin,
      lineage: artifacts.lineage,
      manifest,
    });
    const fromBundle = projectPublicationEvidenceFromInputs(bundle);

    expect(fromRaw.taskOrigin).toBe("docsfab-autonomous");
    expect(fromBundle).toEqual(fromRaw);
    expect(fromBundle.provenanceInputsSha256).toBe(bundle.provenanceInputsSha256);
    expect(fromBundle.lineageProjectionSha256).toBe(bundle.lineage.projectionSha256);
    expect(fromBundle.inputsManifestProjectionSha256).toBe(bundle.inputs.projectionSha256);
    assertPublicationEvidenceResumeEquivalent(fromRaw, fromBundle);
  });

  it("rejects free-form, tampered, and drifted evidence", async () => {
    const artifacts = createTaskLineageArtifacts(await mintLineage("operator-directed", SHA("e")));
    const manifest = await mintManifest(SHA("f"));
    const evidence = projectPublicationEvidence({
      origin: artifacts.origin,
      lineage: artifacts.lineage,
      manifest,
    });

    expectProjectorError(
      () =>
        assertPublicationEvidenceProjection({
          ...evidence,
          taskOrigin: "docsfab-autonomous",
        }),
      "digest-mismatch",
    );
    expectProjectorError(
      () =>
        assertPublicationEvidenceProjection({
          ...evidence,
          limitations: [...evidence.limitations, "input-revoked"],
        }),
      "digest-mismatch",
    );
    expectProjectorError(
      () =>
        assertPublicationEvidenceProjection({
          schemaVersion: 1,
          kind: "docsfab-publication-evidence-projection",
          note: "hand-authored provenance",
        }),
      "invalid-shape",
    );
    expectProjectorError(
      () => assertPublicationEvidenceProjection({ ...evidence, schemaVersion: 2 }),
      "migration-required",
    );
    expect(() =>
      assertPublicationEvidenceResumeEquivalent(evidence, {
        ...evidence,
        evidenceProjectionSha256: SHA("0"),
      }),
    ).toThrow(PublicationProvenanceProjectorError);
  });

  it("gives historical runs an honest bounded fallback, not inferred provenance", () => {
    const historical = createHistoricalUnknownTaskLineage({
      lineageId: "lineage:historical",
      repository: structuredClone(lineageFixture.repository),
    });
    const manifest = createHistoricalEmptyExternalInputManifest({
      runIdSha256: SHA("7"),
      repository: structuredClone(lineageFixture.repository),
    });

    const evidence = projectPublicationEvidence({
      origin: historical.origin,
      lineage: historical.lineage,
      manifest,
    });

    expect(evidence.taskOrigin).toBe("historical-unknown");
    expect(evidence.authorityStatus).toBe("historical-inert");
    expect(evidence.provenanceAvailable).toBe(false);
    expect(evidence.requestPresent).toBe(false);
    expect(evidence.selectedWorkflow).toBeNull();
    expect(evidence.inputUseCount).toBe(0);
    expect(evidence.limitations).toContain("historical-provenance-unavailable");
    expect(evidence.limitations).toContain("no-external-inputs");
  });

  it("bounds, orders, and flags oversized input projections", async () => {
    const count = MAX_PUBLICATION_INPUT_USES + 3;
    const capability = openExternalInputRegistry(inputsFixture.binding);
    for (let index = 0; index < count; index += 1) {
      registerExternalInput(capability, boundedRegistration(index));
    }
    const manifest = await mintExternalInputManifest(
      capability,
      internalCreateExternalInputHostAuthority({
        async verifyCurrent(challenge) {
          return {
            status: "current" as const,
            challengeSha256: challenge.challengeSha256,
            observedAt: "2026-08-05T21:00:00.000Z",
            authorityReceiptSha256: SHA("9"),
          };
        },
      }),
    );
    const artifacts = createTaskLineageArtifacts(await mintLineage("operator-directed", SHA("8")));

    const evidence = projectPublicationEvidence({
      origin: artifacts.origin,
      lineage: artifacts.lineage,
      manifest,
    });

    expect(evidence.inputUseCount).toBe(count);
    expect(evidence.inputUses).toHaveLength(MAX_PUBLICATION_INPUT_USES);
    expect(evidence.inputUsesTruncated).toBe(true);
    expect(evidence.limitations).toContain("input-count-truncated");
    const ids = evidence.inputUses.map((use) => use.inputIdSha256);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe("publication metadata evidence binding (#130)", () => {
  it("renders a deterministic, enum-and-digest-only provenance section", async () => {
    const evidence = await makeMatchingEvidence("operator-directed", SHA("a"), SHA("b"));
    const plan = makeEvidencePlan();

    const first = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      evidence,
    });
    const second = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      evidence,
    });

    // Same run, plan, and evidence produce byte-identical metadata.
    expect(first).toEqual(second);
    expect(first.mergeRequestDescription).toContain("### Provenance evidence");
    expect(first.mergeRequestDescription).toContain("## Situation");
    expect(first.mergeRequestDescription).toContain("## Task");
    expect(first.mergeRequestDescription).toContain("## Action");
    expect(first.mergeRequestDescription).toContain("## Result");
    expect(first.mergeRequestDescription).toContain("**Task origin:** `operator-directed`");
    expect(first.mergeRequestDescription).toMatch(
      /- \*\*Task origin:\*\* `operator-directed`\n- \*\*Product disposition:\*\*/u,
    );
    expect(first.mergeRequestDescription).toContain(
      "- *A maintainer directed this task; DocsFab then selected and ran the governed workflow under one operator confirmation.*",
    );
    expect(first.mergeRequestDescription).toContain("- **Workflow:** `update-documentation`");
    expect(first.mergeRequestDescription).toContain(evidence.evidenceProjectionSha256);
    expect(first.commitMessage).toContain(
      `DocsFab-Evidence-SHA256: ${evidence.evidenceProjectionSha256}`,
    );
    // Exact provenance marker preserved and still the single marker line.
    expect(first.mergeRequestDescription).toContain(first.mergeRequestProvenanceMarker);
    expect(first.mergeRequestDescription).not.toContain("Guide");
    expect(first.mergeRequestDescription).not.toContain("glpat-");
  });

  it("rejects free-form provenance supplied independently of the run record", () => {
    const plan = makeEvidencePlan();
    expect(() =>
      buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Improve governed documentation",
        changedPaths: ["docs/guide.md"],
        evidence: {
          schemaVersion: 1,
          kind: "docsfab-publication-evidence-projection",
          taskOrigin: "operator-directed",
        } as unknown as PublicationEvidenceProjectionV1,
      }),
    ).toThrow();
  });

  it("rejects evidence whose revision drifts from the published plan", async () => {
    const evidence = await makeMatchingEvidence("operator-directed", SHA("c"), SHA("d"));
    const plan = { ...makeEvidencePlan(), baseRevision: "b".repeat(40) };
    const rebound = { ...plan, sha256: localUserPublicationPlanSha256(plan) };
    expect(() =>
      buildDocsFabPublicationMetadata({
        plan: rebound,
        workflowOutcome: "Improve governed documentation",
        changedPaths: ["docs/guide.md"],
        evidence,
      }),
    ).toThrow();
  });

  it("keeps an honest bounded fallback when no evidence is supplied", () => {
    const plan = makeEvidencePlan();
    const metadata = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
    });
    expect(metadata.mergeRequestDescription).not.toContain("### Provenance evidence");
    expect(metadata.mergeRequestDescription).toContain("## Situation");
    expect(metadata.mergeRequestDescription).toContain("**Task origin:** `unavailable`");
    expect(metadata.commitMessage).not.toContain("DocsFab-Evidence-SHA256");
    expect(metadata.mergeRequestDescription).toContain(metadata.mergeRequestProvenanceMarker);
  });
});

describe("evidence-aware narrative from run lineage (#129)", () => {
  async function runLineageProjection(
    origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">,
    receipt: string,
  ) {
    const artifacts = createTaskLineageArtifacts(await mintLineage(origin, receipt));
    return projectTaskLineage(artifacts.origin, artifacts.lineage);
  }

  it("projects deterministic, host-authenticated evidence with no captured inputs", async () => {
    const projection = await runLineageProjection("operator-directed", SHA("1"));
    const first = projectPublicationEvidenceFromRunLineage(projection);
    const second = projectPublicationEvidenceFromRunLineage(projection);
    expect(first).toEqual(second);
    expect(first.taskOrigin).toBe("operator-directed");
    expect(first.provenanceAvailable).toBe(true);
    expect(first.inputUseCount).toBe(0);
    expect(first.limitations).toContain("no-external-inputs");
    // A genuine seal round-trips through the metadata verifier.
    expect(assertPublicationEvidenceProjection(first)).toEqual(first);
  });

  it("renders a distinct narrative for each governed task origin", async () => {
    const plan = makeEvidencePlan();
    const descriptions = new Map<string, string>();
    const commits = new Map<string, string>();
    const receipts = {
      "operator-directed": SHA("a"),
      "docsfab-recommended-approved": SHA("b"),
      "docsfab-autonomous": SHA("c"),
    } as const;
    for (const origin of [
      "operator-directed",
      "docsfab-recommended-approved",
      "docsfab-autonomous",
    ] as const) {
      const evidence = projectPublicationEvidenceFromRunLineage(
        await runLineageProjection(origin, receipts[origin]),
      );
      const metadata = buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Improve governed documentation",
        changedPaths: ["docs/guide.md"],
        evidence,
      });
      descriptions.set(origin, metadata.mergeRequestDescription);
      commits.set(origin, metadata.commitMessage);
      expect(metadata.mergeRequestDescription).toContain(`**Task origin:** \`${origin}\``);
      expect(metadata.commitMessage).toContain(`DocsFab-Task-Origin: ${origin}`);
    }
    // Directed, recommended, and autonomous runs are materially different prose.
    expect(new Set(descriptions.values()).size).toBe(3);
    expect(descriptions.get("operator-directed")).toContain("A maintainer directed this task");
    expect(descriptions.get("docsfab-recommended-approved")).toContain(
      "DocsFab recommended this task",
    );
    expect(descriptions.get("docsfab-autonomous")).toContain(
      "DocsFab autonomously selected this task",
    );
    expect(new Set(commits.values()).size).toBe(3);
  });

  it("keeps the narrative credential-free and host-path-free", async () => {
    const projection = await runLineageProjection("docsfab-autonomous", SHA("2"));
    const evidence = projectPublicationEvidenceFromRunLineage(projection);
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      evidence,
    });
    for (const text of [metadata.commitMessage, metadata.mergeRequestDescription]) {
      expect(text).not.toMatch(/glpat-|PRIVATE-TOKEN|Authorization:|\/Users\/|\/home\//u);
    }
  });

  it("rejects a tampered or free-form lineage projection lookalike", async () => {
    const projection = await runLineageProjection("operator-directed", SHA("3"));
    expect(() =>
      projectPublicationEvidenceFromRunLineage({
        ...projection,
        taskOrigin: "docsfab-autonomous",
      }),
    ).toThrow();
    expect(() =>
      projectPublicationEvidenceFromRunLineage({
        schemaVersion: 1,
        kind: "docsfab-task-lineage-projection",
      } as never),
    ).toThrow();
  });

  it("renders the honest bounded fallback for historical lineage", () => {
    const artifacts = createHistoricalUnknownTaskLineage({
      lineageId: "lineage:historical",
      repository: { identitySha256: SHA("4"), revision: EVIDENCE_REVISION },
    });
    const projection = projectTaskLineage(artifacts.origin, artifacts.lineage);
    const evidence = projectPublicationEvidenceFromRunLineage(projection);
    expect(evidence.provenanceAvailable).toBe(false);
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      evidence,
    });
    expect(metadata.mergeRequestDescription).toContain("Provenance evidence is unavailable");
    expect(metadata.mergeRequestDescription).toContain("## Situation");
    expect(metadata.mergeRequestDescription).toContain("**Task origin:** `unavailable`");
    // No task origin is asserted in the commit trailer for unbacked provenance.
    expect(metadata.commitMessage).not.toContain("DocsFab-Task-Origin:");
    expect(metadata.commitMessage).toContain("DocsFab-Evidence-SHA256:");
  });
});

describe("STAR reviewer narrative (#245 / frozen #243)", () => {
  it("renders STAR headers for lineage-backed publication metadata", async () => {
    const evidence = await makeMatchingEvidence("operator-directed", SHA("e"), SHA("f"));
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      evidence,
    });
    for (const header of ["## Situation", "## Task", "## Action", "## Result"]) {
      expect(metadata.mergeRequestDescription).toContain(header);
    }
    expect(metadata.mergeRequestDescription.indexOf("## Situation")).toBeLessThan(
      metadata.mergeRequestDescription.indexOf("## Published by DocsFab"),
    );
    expect(metadata.mergeRequestDescription).toContain("**Workflow:** `update-documentation`");
    expect(metadata.mergeRequestDescription).toContain(metadata.mergeRequestProvenanceMarker);
  });

  it("projects structured-task identity labels for operator-directed runs", async () => {
    const instruction = "Improve onboarding clarity for maintainers";
    const evidence = await makeMatchingEvidence("operator-directed", SHA("0"), SHA("1"));
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      instruction,
      requestSha256: null,
      evidence,
    });
    expect(metadata.mergeRequestDescription).toContain("**Request kind:** `structured-task`");
  });

  it("omits oversized instruction evidence without blocking publication or leaking a prefix", async () => {
    const evidence = await makeMatchingEvidence("operator-directed", SHA("2"), SHA("3"));
    const instruction = "PRIVATE_PREFIX " + "Synthetic evidence ".repeat(400);
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      instruction,
      evidence,
    });
    expect(metadata.mergeRequestDescription).toContain(
      "omitted (exceeds publication display limit)",
    );
    expect(metadata.mergeRequestDescription).not.toContain("PRIVATE_PREFIX");
    expect(metadata.mergeRequestDescription.length).toBeLessThanOrEqual(8192);
  });

  it("omits unsafe instruction text with an explicit limitation line", async () => {
    const evidence = await makeMatchingEvidence("operator-directed", SHA("2"), SHA("3"));
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      instruction: "![inject](https://evil.test)",
      evidence,
    });
    expect(metadata.mergeRequestDescription).toContain("**Instruction:** omitted");
    expect(metadata.mergeRequestDescription).not.toContain("evil.test");
  });

  it("projects backtick-decorated bounded instructions as NFC plain text (#304 / #302)", async () => {
    const instruction = "Document the `NODE_EXTRA_CA_CERTS` trust bundle.";
    const { evidence, requestSha256 } = await makeBoundedInstructionEvidence(instruction);
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      instruction,
      requestSha256,
      evidence,
    });
    const task = extractMarkdownSection(metadata.mergeRequestDescription, "## Task");
    expect(task).toContain("**Instruction:** Document the NODE_EXTRA_CA_CERTS trust bundle.");
    expect(task).not.toMatch(/`NODE_EXTRA_CA_CERTS`/u);
    expect(metadata.mergeRequestDescription).toContain("## Situation");
    expect(metadata.mergeRequestDescription).toContain("## Action");
    expect(metadata.mergeRequestDescription).toContain("## Result");
  });

  it("omits a configured-credential instruction, flags a credential-like one, and replaces host roots", async () => {
    const evidence = await makeMatchingEvidence("operator-directed", SHA("4"), SHA("5"));
    // DocsFab's own configured credential is never published; it looks like none.
    const planted = plantConfiguredCredential();
    const credential = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      instruction: `Publish using ${planted}`,
      evidence,
    });
    clearPlantedCredential();
    expect(credential.mergeRequestDescription).toContain("**Instruction:** omitted");
    expect(credential.mergeRequestDescription).not.toContain(planted);
    // An instruction that only names a credential header is published and
    // named in the Notes block (#1807).
    const headerInstruction = "Document the PRIVATE-TOKEN header for the API page";
    const headerBound = await makeBoundedInstructionEvidence(headerInstruction);
    const flagged = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      instruction: headerInstruction,
      requestSha256: headerBound.requestSha256,
      evidence: headerBound.evidence,
    });
    expect(flagged.mergeRequestDescription).toContain(
      "**Instruction:** Document the PRIVATE-TOKEN header for the API page",
    );
    expect(flagged.mergeRequestDescription).toContain(
      "`publication:instruction` (`credential.private-token-header`)",
    );

    // Imported here so the registered fixture lines above keep their line numbers.
    const { hostRootSet } = await import("../src/security/egress.js");
    const instruction = "Write the patch under /Users/operator/docs, not /usr/local/bin";
    const bounded = await makeBoundedInstructionEvidence(instruction);
    const hostPath = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      instruction,
      requestSha256: bounded.requestSha256,
      evidence: bounded.evidence,
      hostRoots: hostRootSet([{ kind: "home", path: "/Users/operator" }]),
    });
    expect(hostPath.mergeRequestDescription).toContain(
      "**Instruction:** Write the patch under ~/docs, not /usr/local/bin",
    );
    expect(hostPath.mergeRequestDescription).not.toContain("/Users/operator");
  });

  it("keeps STAR sections honest when lineage evidence is absent", () => {
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
    });
    expect(metadata.mergeRequestDescription).toContain("**Task origin:** `unavailable`");
    expect(metadata.mergeRequestDescription).toContain("**Responsibility:** `unavailable`");
    expect(metadata.mergeRequestDescription).toContain("**Product disposition:** `unavailable`");
    expect(metadata.mergeRequestDescription).toContain(
      "**Catalog outcome (subtitle):** *Improve governed documentation*",
    );
  });
});

describe("Result from sealed workflowOutcome (#246 / frozen #243)", () => {
  const catalogBlurb = "A focused documentation patch grounded in an audit.";
  const inconclusiveEnvelope = {
    schemaVersion: 1,
    kind: "docsfab-workflow-outcome",
    disposition: "inconclusive",
    findings: [
      {
        id: "finding:structured-product-evidence-unavailable",
        kind: "evidence-limitation",
        severity: "warning",
        code: "structured-product-evidence-unavailable",
        evidenceIds: ["step:apply"],
      },
    ],
    evidence: [
      {
        id: "step:apply",
        kind: "step",
        stepId: "apply",
        sha256: "a".repeat(64),
      },
    ],
    limitations: ["structured-product-evidence-unavailable"],
    openDecisions: [],
    producedArtifacts: [],
    outcomeSha256: "b".repeat(64),
  } as const;

  it("projects inconclusive disposition and limitation codes into Result", () => {
    const metadata = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: catalogBlurb,
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      productOutcome: inconclusiveEnvelope as never,
    });
    const result = extractMarkdownSection(metadata.mergeRequestDescription, "## Result");
    expect(result).toContain("**Product disposition:** `inconclusive`");
    expect(result).toContain("structured-product-evidence-unavailable");
    expect(result).toContain("**Product limitations:** `structured-product-evidence-unavailable`");
    expect(result).toContain(`**Catalog outcome (subtitle):** *${catalogBlurb}*`);
    expect(result.indexOf("Product disposition:")).toBeLessThan(
      result.indexOf("Catalog outcome (subtitle):"),
    );
    // Title fails closed on sealed disposition — does not use optimistic catalog alone.
    expect(metadata.mergeRequestTitle).toBe(
      "Draft: [DocsFab Run] inconclusive — structured-product-evidence-unavailable",
    );
    expect(metadata.mergeRequestTitle).not.toContain(catalogBlurb);
  });

  it("treats catalog outcome alone as insufficient for STAR Result", () => {
    const catalogOnly = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: catalogBlurb,
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
    });
    const sealed = buildDocsFabPublicationMetadata({
      plan: makeEvidencePlan(),
      workflowOutcome: catalogBlurb,
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
      productOutcome: inconclusiveEnvelope as never,
    });
    expect(starResultSatisfied(catalogOnly.mergeRequestDescription)).toBe(false);
    expect(starResultSatisfied(sealed.mergeRequestDescription)).toBe(true);
    // Catalog string appears in both; only sealed disposition codes satisfy Result.
    expect(catalogOnly.mergeRequestDescription).toContain(catalogBlurb);
    expect(sealed.mergeRequestDescription).toContain(catalogBlurb);
  });

  it("projects built-in documentation validation profile identity without product-test evidence", () => {
    const selected = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["docs/guide.md"],
      hostPolicySha256: validationBackendPolicySha256(),
    });
    const { sha256: _omit, ...rest } = makeEvidencePlan();
    const candidate = {
      ...rest,
      validationCommand: selected.entrypointCommand,
      documentationValidation: selected.binding,
    };
    const plan = {
      ...candidate,
      sha256: localUserPublicationPlanSha256(candidate),
    };
    const metadata = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: catalogBlurb,
      changedPaths: ["docs/guide.md"],
      workflowId: "update-documentation",
    });
    expect(metadata.mergeRequestDescription).toContain("docsfab-documentation-validation");
    expect(metadata.mergeRequestDescription).toContain("docsfab-documentation-validator");
    expect(metadata.mergeRequestDescription).toContain(selected.binding.checkSetSha256);
    expect(metadata.mergeRequestDescription).not.toContain("docsfab test");
    expect(metadata.mergeRequestDescription).not.toContain("offline-product-test");
  });
});

/** STAR Result requires sealed disposition codes — not catalog copy alone. */
function starResultSatisfied(description: string): boolean {
  const result = extractMarkdownSection(description, "## Result");
  if (!result.includes("**Validation:**")) return false;
  if (!/\*\*Product disposition:\*\* `(?!unavailable)[^`]+`/u.test(result)) return false;
  if (!/\*\*Product (?:findings|limitations):\*\* `(?!unavailable|none)[^`]+`/u.test(result))
    return false;
  return true;
}

function extractMarkdownSection(description: string, header: string): string {
  const start = description.indexOf(header);
  if (start < 0) return "";
  const after = description.slice(start + header.length);
  const next = after.search(/\n## /u);
  return next < 0 ? after : after.slice(0, next);
}

const EVIDENCE_REVISION = "2".repeat(40);

async function makeBoundedInstructionEvidence(instruction: string): Promise<{
  evidence: PublicationEvidenceProjectionV1;
  requestSha256: string;
}> {
  const repository = {
    identitySha256: SHA("1"),
    revision: EVIDENCE_REVISION,
  };
  const artifacts = await mintCliOperatorDirectedLineage({
    instruction,
    task: null,
    workflow: "update-documentation",
    repository,
    authorityId: "local-operator",
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  return {
    evidence: projectPublicationEvidenceFromRunLineage(
      projectTaskLineage(artifacts.origin, artifacts.lineage),
    ),
    requestSha256: createBoundedInstructionRequestIdentity(
      instruction,
      null,
      "update-documentation",
      repository,
    ).requestSha256,
  };
}

async function makeMatchingEvidence(
  origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">,
  lineageReceipt: string,
  manifestReceipt: string,
): Promise<PublicationEvidenceProjectionV1> {
  const artifacts = createTaskLineageArtifacts(await mintLineage(origin, lineageReceipt));
  const manifest = await mintManifest(manifestReceipt);
  return projectPublicationEvidence({
    origin: artifacts.origin,
    lineage: artifacts.lineage,
    manifest,
  });
}

function makeEvidencePlan(): LocalUserPublicationPlanV1 {
  const candidate = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-1", recordSha256: "d".repeat(64) },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: EVIDENCE_REVISION,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-1",
    patch: {
      format: "git-diff",
      sha256: canonicalDigest("patch"),
      byteLength: 5,
      changedFileCount: 1,
    },
    validationCommand: "npm run check",
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
  } as const;
  return {
    ...candidate,
    sha256: localUserPublicationPlanSha256(candidate as never),
  };
}

function boundedRegistration(index: number): ExternalInputRegistrationV1 {
  return {
    inputId: `input:bounded-${index.toString().padStart(3, "0")}`,
    sourceKind: "url",
    safeTitle: `bounded source ${index}`,
    locator: {
      adapterKind: "url",
      locatorSha256: digestExternalInputLocator(`https://docs.example.test/bounded/${index}`),
      permissionClass: "readable",
    },
    supplier: structuredClone(inputsFixture.supplier),
    version: { kind: "repository-revision", revision: EVIDENCE_REVISION },
    contentDigestSha256: null,
    visibility: "public",
    disclosurePolicy: "cite-only",
    intendedRoles: ["context"],
    initialLifecycle: "supplied",
  };
}

async function mintLineage(
  origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">,
  receipt: string,
) {
  return mintTaskLineageHostCapability(
    {
      origin: currentOrigin(origin),
      lineage: lineageInput(origin),
    },
    internalCreateTaskLineageHostAuthority({
      async verifyCurrent(challenge) {
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt: "2026-08-05T18:00:00.000Z",
          authorityReceiptSha256: receipt,
        };
      },
    }),
  );
}

async function mintManifest(receipt: string) {
  const capability = openExternalInputRegistry(inputsFixture.binding);
  for (const entry of inputsFixture.entries) {
    registerExternalInput(capability, registrationFromFixture(entry));
  }
  return mintExternalInputManifest(
    capability,
    internalCreateExternalInputHostAuthority({
      async verifyCurrent(challenge) {
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt: "2026-08-05T20:00:00.000Z",
          authorityReceiptSha256: receipt,
        };
      },
    }),
  );
}

function registrationFromFixture(
  entry: (typeof inputsFixture.entries)[number],
): ExternalInputRegistrationV1 {
  const metadataOnly =
    entry.body === null ||
    entry.disclosurePolicy === "identity-only" ||
    entry.disclosurePolicy === "redacted" ||
    entry.disclosurePolicy === "forbidden";
  const contentDigestSha256 =
    entry.body === null || metadataOnly
      ? null
      : canonicalDigest({
          kind: "docsfab-external-input-fake-body",
          adapterKind: entry.sourceKind,
          body: entry.body,
        });
  return {
    inputId: entry.inputId,
    sourceKind: entry.sourceKind,
    safeTitle: entry.safeTitle,
    locator: {
      adapterKind: entry.sourceKind,
      locatorSha256: digestExternalInputLocator(entry.canonicalLocator),
      permissionClass: metadataOnly ? "metadata-only" : "readable",
    },
    supplier: structuredClone(inputsFixture.supplier),
    version: structuredClone(entry.version),
    contentDigestSha256,
    visibility: entry.visibility,
    disclosurePolicy: entry.disclosurePolicy,
    intendedRoles: [...entry.intendedRoles].sort(),
    initialLifecycle: "supplied",
  };
}

function currentOrigin(
  origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">,
): Exclude<TaskOriginInputV1, { origin: "historical-unknown" }> {
  const common = {
    lineageId: `lineage:${origin}`,
    repository: structuredClone(lineageFixture.repository),
    request: structuredClone(lineageFixture.request),
  };
  if (origin === "operator-directed") {
    return {
      ...common,
      origin,
      selectedBy: "operator",
      approval: structuredClone(lineageFixture.approval),
      recommendation: null,
      autonomousSelection: null,
    };
  }
  if (origin === "docsfab-recommended-approved") {
    return {
      ...common,
      origin,
      selectedBy: "operator",
      approval: {
        ...structuredClone(lineageFixture.approval),
        approvedRecommendationSha256: lineageFixture.recommendation.recommendationSha256,
      },
      recommendation: structuredClone(lineageFixture.recommendation),
      autonomousSelection: null,
    };
  }
  return {
    ...common,
    origin,
    selectedBy: "deterministic-workflow",
    approval: null,
    recommendation: null,
    autonomousSelection: structuredClone(lineageFixture.autonomousSelection),
  };
}

function lineageInput(origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">) {
  const taskActor = origin === "docsfab-autonomous" ? "deterministic-workflow" : "operator";
  const taskDecision: DecisionAttributionInputV1 = {
    id: "decision:task",
    domain: "task",
    actor: taskActor,
    effect: "authoritative",
    outcomeSha256: lineageFixture.request.taskSha256!,
    authoritySource: taskActor === "operator" ? "operator-approval" : "workflow-contract",
    authoritySha256:
      taskActor === "operator"
        ? lineageFixture.approval.approvalSha256
        : lineageFixture.autonomousSelection.decisionSha256,
    evidenceSha256s: [lineageFixture.request.requestSha256!],
    boundedByDecisionIds: [],
    reasonCode: origin,
  };
  return {
    lineageId: `lineage:${origin}`,
    candidates: structuredClone(lineageFixture.candidates),
    selectedCandidateSha256: lineageFixture.selectedCandidateSha256,
    selectedSourceAutoCandidateSha256:
      origin === "docsfab-autonomous" ? lineageFixture.autonomousSelection.candidateSha256 : null,
    rejectedAlternatives: structuredClone(lineageFixture.rejectedAlternatives),
    decisions: [taskDecision, ...structuredClone(lineageFixture.sharedDecisions)],
  };
}

function expectProjectorError(
  run: () => unknown,
  code: PublicationProvenanceProjectorError["code"] | "credential-material",
): void {
  try {
    run();
    throw new Error("Expected publication projector failure.");
  } catch (error) {
    if (code === "credential-material") {
      // Domain projectors reject credentials before the shim seals.
      expect(
        error instanceof PublicationProvenanceProjectorError ||
          (error instanceof Error && /credential-material/u.test(error.message)),
      ).toBe(true);
      return;
    }
    expect(error).toBeInstanceOf(PublicationProvenanceProjectorError);
    expect((error as PublicationProvenanceProjectorError).code).toBe(code);
  }
}
