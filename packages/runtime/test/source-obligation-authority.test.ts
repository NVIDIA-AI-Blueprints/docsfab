// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { limit } from "../src/config/limits.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { admitAuthorizedTrackedWrites } from "../src/repository/workspace/tracked-read.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  admitOriginalSourceAuthorityProposals,
  admitOriginalSourceAuthorityChecks,
  issueOriginalSourceAuthorityAdmission,
  originalSourceAuthorityMemberMap,
  sealOriginalSourceAuthority,
  validateOriginalSourceAuthorityDescriptor,
  validateOriginalSourceAuthorityEvidence,
  type OriginalSourceAuthorityEvidenceV1,
  type OriginalSourceAuthorityMemberV1,
  type OriginalSourceAuthorityScope,
  type OriginalSourceAuthoritySourceObserver,
} from "../src/workflow-execution/source-obligation-authority.js";
import {
  LocalSourceObligationSourceObserver,
  listPreservationSources,
  readPreservationSourceRange,
} from "../src/workflow-execution/source-obligation-observer.js";
import {
  admitReviewResponse,
  normalizeRepositoryLocator,
  TECHNICAL_FACT_DIMENSIONS,
} from "../src/workflow-execution/review-response.js";
import {
  createDocumentationPlanBinding,
  documentationPlanWritePaths,
  validateDocumentationPlanBinding,
} from "../src/workflow-execution/plan-binding.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";

const REVISION = "a".repeat(40);
const SCOPE_SHA256 = "b".repeat(64);
const SNAPSHOT_SHA256 = "c".repeat(64);
const RUN_ID = "authority-run-1";
const SPACED_ASSET_PATH =
  "packages/runtime/quality/formats/template-set-v1/tpl-new-page/assets/templates/images/Peer Review Diagram.png";
const SPACED_ASSET_BYTES = await readFile(
  new URL(
    "../quality/formats/template-set-v1/tpl-new-page/assets/templates/images/Peer%20Review%20Diagram.png",
    import.meta.url,
  ),
);

// Tracked paths from a real repository whose "{name}" directory segment is a
// brace-placeholder templated-route convention, not citation or escape syntax.
const ROUTER_BRACE_MEMBER_PATHS = [
  "src/router/dashboard/pages/registry/agent/{name}/_context.py",
  "src/router/dashboard/pages/registry/agent/{name}/_meta.py",
  "src/router/dashboard/pages/registry/agent/{name}/page.html",
  "src/router/dashboard/pages/registry/agent/{name}/page.py",
  "src/router/dashboard/pages/registry/chains/{name}/_context.py",
  "src/router/dashboard/pages/registry/chains/{name}/_meta.py",
  "src/router/dashboard/pages/registry/chains/{name}/page.html",
  "src/router/dashboard/pages/registry/chains/{name}/page.py",
  "src/router/dashboard/pages/registry/collections/catalog/{name}/_context.py",
  "src/router/dashboard/pages/registry/collections/catalog/{name}/_meta.py",
  "src/router/dashboard/pages/registry/collections/catalog/{name}/page.html",
  "src/router/dashboard/pages/registry/collections/catalog/{name}/page.py",
  "src/router/dashboard/pages/registry/collections/{name}/_context.py",
  "src/router/dashboard/pages/registry/collections/{name}/_meta.py",
  "src/router/dashboard/pages/registry/collections/{name}/page.html",
  "src/router/dashboard/pages/registry/collections/{name}/page.py",
  "src/router/dashboard/pages/registry/skill/{name}/_context.py",
  "src/router/dashboard/pages/registry/skill/{name}/_meta.py",
  "src/router/dashboard/pages/registry/skill/{name}/page.html",
  "src/router/dashboard/pages/registry/skill/{name}/page.py",
] as const;

// Tracked paths whose Git-legal characters the member-path rule once refused.
const GIT_LEGAL_MEMBER_PATHS = [
  "docs/c++/guide.md",
  "assets/logo@2x.png",
  "docs/Read me first!.md",
  "docs/Install, configure, and run.md",
  // Field evidence: this one tracked path stopped every update run in a real repository.
  "cli/tests/cli-reference@.md.snap",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function member(
  path: string,
  contents = `${path}\n`,
  patch: Partial<OriginalSourceAuthorityMemberV1> = {},
): OriginalSourceAuthorityMemberV1 {
  return {
    path,
    mode: 0o644,
    byteLength: Buffer.byteLength(contents),
    sourceSha256: sha256(contents),
    ...patch,
  };
}

function seal(
  members: readonly OriginalSourceAuthorityMemberV1[] = [member("src/api.ts")],
  scope: OriginalSourceAuthorityScope = "review-tracked-workspace",
) {
  return sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope,
    repositoryRevision: REVISION,
    scopeSha256: SCOPE_SHA256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
    members,
  });
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the action to throw, but it returned.");
}

function expectedBinding(scope: OriginalSourceAuthorityScope = "review-tracked-workspace") {
  return {
    scope,
    repositoryRevision: REVISION,
    scopeSha256: SCOPE_SHA256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
  } as const;
}

async function withRepositoryFixture(
  action: (input: {
    workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>>;
    observer: LocalSourceObligationSourceObserver;
  }) => Promise<void>,
  options: {
    mixedCaseRootFiles?: boolean;
    spacedAsset?: boolean;
    guideContent?: string;
    retainedPage?: boolean;
    retainedContent?: string;
    apiContent?: string;
    braceMembers?: boolean;
    malformedBraceMember?: boolean;
    gitLegalMembers?: boolean;
  } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-original-authority-"));
  const source = join(root, "source");
  let workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
  try {
    await mkdir(join(source, "src"), { recursive: true });
    await mkdir(join(source, "docs"), { recursive: true });
    await writeFile(join(source, "src", "api.ts"), options.apiContent ?? "export const api = 1;\n");
    await writeFile(join(source, "src", "extra.ts"), "export const extra = 2;\n");
    await writeFile(join(source, "docs", "guide.md"), options.guideContent ?? "# Original guide\n");
    if (options.retainedPage) {
      await writeFile(
        join(source, "docs", "retained.md"),
        options.retainedContent ?? "# Retained claim\n",
      );
    }
    await writeFile(join(source, ".env"), "FIXTURE_ONLY=yes\n");
    if (options.mixedCaseRootFiles) {
      await writeFile(join(source, "README.md"), "# Mixed-case ordering fixture\n");
      await writeFile(join(source, "package.json"), '{"name":"ordering-fixture"}\n');
    }
    if (options.spacedAsset) {
      await mkdir(join(source, SPACED_ASSET_PATH, ".."), { recursive: true });
      await writeFile(join(source, SPACED_ASSET_PATH), SPACED_ASSET_BYTES);
    }
    if (options.braceMembers) {
      for (const path of ROUTER_BRACE_MEMBER_PATHS) {
        await mkdir(join(source, path, ".."), { recursive: true });
        await writeFile(join(source, path), `${path}\n`);
      }
    }
    if (options.gitLegalMembers) {
      for (const path of GIT_LEGAL_MEMBER_PATHS) {
        await mkdir(join(source, path, ".."), { recursive: true });
        await writeFile(join(source, path), `${path}\n`);
      }
    }
    if (options.malformedBraceMember) {
      // A partial-segment brace ("pre{name}post") is not the exact "{identifier}"
      // placeholder convention and must keep failing the whole REVIEW capture.
      const path = "src/pre{name}post.py";
      await mkdir(join(source, path, ".."), { recursive: true });
      await writeFile(join(source, path), `${path}\n`);
    }
    await symlink("api.ts", join(source, "src", "link.ts"));
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "authority fixture");
    await writeFile(join(source, "src", "untracked.ts"), "export const untracked = 3;\n");
    workspace = await prepareRepositoryWorkspace(source, "HEAD");
    await action({ workspace, observer: new LocalSourceObligationSourceObserver(workspace) });
  } finally {
    await workspace?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

describe("original source authority host capture", () => {
  it("preserves the original text including its byte-order mark", async () => {
    const content = "\uFEFF# Original guide\r\n";
    await withRepositoryFixture(
      async ({ observer }) => {
        const base = await observer.capturePreservationBase(["docs/guide.md"]);
        expect(base.sources[0]).toEqual({
          path: "docs/guide.md",
          sha256: sha256(content),
          content,
        });
      },
      { guideContent: content },
    );
  });

  it("refuses a configured credential before presenting preservation evidence", async () => {
    await withRepositoryFixture(
      async ({ observer }) => {
        // A credential shape alone is presented (#1807).
        await expect(observer.capturePreservationBase(["docs/guide.md"])).resolves.toMatchObject({
          sources: [{ path: "docs/guide.md" }],
        });
        configureCredential(`glpat-${"x".repeat(24)}`);
        await expect(observer.capturePreservationBase(["docs/guide.md"])).rejects.toThrow(
          "configured credential",
        );
      },
      { guideContent: `glpat-${"x".repeat(24)}\n` },
    );
  });

  it("retains exact preservation bytes after the candidate changes and rejects recapture", async () => {
    await withRepositoryFixture(async ({ workspace, observer }) => {
      const base = await observer.capturePreservationBase(["docs/guide.md"]);
      expect(base).toEqual({
        repositoryRevision: workspace.revision,
        sources: [
          {
            path: "docs/guide.md",
            sha256: sha256("# Original guide\n"),
            content: "# Original guide\n",
          },
        ],
      });
      await writeFile(join(workspace.path, "docs/guide.md"), "# Changed candidate\n");
      expect(base.sources[0]!.content).toBe("# Original guide\n");
      await expect(observer.capturePreservationBase(["docs/guide.md"])).rejects.toThrow();
      await expect(observer.capturePreservationBase(["src/untracked.ts"])).rejects.toThrow();
    });
  });

  it("carries a retained page's bound source discrepancy through real reading, review admission, and findings", async () => {
    await withRepositoryFixture(
      async ({ workspace, observer }) => {
        const plan = createDocumentationPlanBinding({
          mode: "restructure",
          pages: [
            { path: "docs/guide.md", disposition: "move" },
            { path: "docs/retained.md", disposition: "retain" },
            { path: "docs/excluded.md", disposition: "out-of-scope" },
          ],
          sourceBindings: [
            { pagePath: "docs/guide.md", sources: ["docs/guide.md"] },
            { pagePath: "docs/retained.md", sources: ["docs/retained.md", "src/api.ts"] },
          ],
        });
        expect(documentationPlanWritePaths(plan)).toEqual(["docs/guide.md"]);
        const captured = await observer.captureOriginalSourceAuthority({
          runId: RUN_ID,
          workflow: getWorkflow("restructure-documentation"),
          repositoryRevision: workspace.revision,
          scopeSha256: SCOPE_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
        });
        // Restructure's outer authority includes all tracked files. The admitted
        // page/source map narrows the verifier's actual reader to this page's base
        // and the implementation file the planner selected.
        expect(captured.evidence.members.map(({ path }) => path)).toContain("src/extra.ts");
        const sources = plan.sourceBindings.flatMap((binding) => binding.sources);
        const base = await observer.capturePreservationBase(sources);
        expect(base.sources.map(({ path }) => path)).toEqual([
          "docs/guide.md",
          "docs/retained.md",
          "src/api.ts",
        ]);
        const reader = observer.createPreservationSourceReader({
          runId: RUN_ID,
          stepId: "verify-technical-accuracy",
          repositoryRevision: workspace.revision,
          capture: captured.capture,
          authority: captured.evidence,
          authorizedPaths: sources,
        });
        const references = listPreservationSources(reader);
        expect(references.map(({ path }) => path)).toEqual([
          "docs/guide.md",
          "docs/retained.md",
          "src/api.ts",
        ]);
        const implementation = references.find(({ path }) => path === "src/api.ts")!;
        const read = await readPreservationSourceRange({
          reader,
          sourceId: implementation.sourceId,
          fromByte: 0,
          maxBytes: implementation.byteLength,
        });
        const retained = references.find(({ path }) => path === "docs/retained.md")!;
        const documented = await readPreservationSourceRange({
          reader,
          sourceId: retained.sourceId,
          fromByte: 0,
          maxBytes: retained.byteLength,
        });
        const documentedSeconds = Number(documented.text.match(/defaults to (\d+) seconds/u)?.[1]);
        const implementedSeconds = Number(read.text.match(/API_TIMEOUT_SECONDS = (\d+)/u)?.[1]);
        expect(documentedSeconds).toBe(30);
        expect(implementedSeconds).toBe(60);
        expect(documentedSeconds).not.toBe(implementedSeconds);

        const workflow = getWorkflow("restructure-documentation");
        const input: HarnessStepInput = {
          repositoryPath: workspace.path,
          workflow,
          step: workflow.steps.find((step) => step.id === "verify-technical-accuracy")!,
          planBinding: plan,
        };
        const response = {
          review: {
            verdict: "needs-revision",
            issues: [
              {
                id: "FACT-001",
                severity: "major",
                category: "technical_accuracy",
                location: "docs/retained.md:1",
                finding: `The retained page says ${documentedSeconds} seconds, but the bound implementation says ${implementedSeconds} seconds.`,
                evidence: { source_id: workspace.revision, locator: "src/api.ts:1" },
                required_change:
                  "Resolve the documented default against the implementation source.",
              },
            ],
          },
          coverage: [
            {
              path: "docs/guide.md",
              status: "verified",
              evidence: ["docs/guide.md:1"],
              reason: "Compared the original guide with its bound source.",
            },
            {
              path: "docs/retained.md",
              status: "verified",
              evidence: ["docs/retained.md:1", "src/api.ts:1"],
              reason: "Compared the retained claim with its bound implementation source.",
            },
          ],
          factInventory: {
            completeness: "bounded-not-proven",
            dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
              dimension === "defaults-and-overrides"
                ? {
                    dimension,
                    status: "applicable",
                    reason:
                      "The bound implementation defines the default used by the retained page.",
                    sourceLocators: [],
                    facts: [
                      {
                        id: "API_TIMEOUT_DEFAULT",
                        dimension,
                        sourceLocators: ["src/api.ts:1"],
                        statement: `The implementation sets the API timeout default to ${implementedSeconds} seconds, while the retained page says ${documentedSeconds} seconds.`,
                        documentationDisposition: "conflicting",
                        uncertainty:
                          "Only this bound fixture source and retained page were inspected.",
                        issueIds: ["FACT-001"],
                      },
                    ],
                  }
                : {
                    dimension,
                    status: "not-applicable",
                    reason: `The bound implementation provides no ${dimension} claim for this timeout default.`,
                    sourceLocators: ["src/api.ts:1"],
                    facts: [],
                  },
            ),
            limitations: [
              "This bounded fixture does not establish completeness for another source.",
            ],
          },
        };
        const admitted = admitReviewResponse(input, JSON.stringify(response));
        const plannerStep = {
          id: "plan-documentation",
          title: "Plan documentation",
          skill: "plan-documentation",
          mode: "read-only",
          status: "succeeded",
          planBinding: plan,
        } as RunRecord["steps"][number];
        const technicalStep = {
          id: "verify-technical-accuracy",
          title: "Verify technical accuracy",
          skill: "verify-technical-accuracy",
          mode: "read-only",
          status: "succeeded",
          summary: admitted,
        } as RunRecord["steps"][number];
        const projection = projectReviewFindingsFromRun({
          workflow: "restructure-documentation",
          steps: [plannerStep, technicalStep],
        });
        expect(projection.findings.map((finding) => finding.code)).toContain("API_TIMEOUT_DEFAULT");
        expect(JSON.stringify(projection.findings)).toContain("docs/retained.md");
        expect(JSON.stringify(projection.findings)).toContain(String(documentedSeconds));
        expect(JSON.stringify(projection.findings)).toContain(String(implementedSeconds));
        expect(projection.limitations).not.toContain(
          "review-findings-invalid:verify-technical-accuracy:schema",
        );
        expect(await readFile(join(workspace.path, "docs/retained.md"), "utf8")).toBe(
          documented.text,
        );
        expect(await readFile(join(workspace.path, "src/api.ts"), "utf8")).toBe(read.text);

        const excluded = structuredClone(response);
        excluded.coverage.push({
          path: "docs/excluded.md",
          status: "verified",
          evidence: ["docs/excluded.md:1"],
          reason: "An out-of-scope page cannot become a verification target.",
        });
        expect(() => admitReviewResponse(input, JSON.stringify(excluded))).toThrow();

        const unbound = captured.evidence.members.find(({ path }) => path === "src/extra.ts")!;
        const unboundId = createHash("sha256")
          .update(`${RUN_ID}\0${workspace.revision}\0${unbound.path}\0${unbound.sourceSha256}`)
          .digest("hex");
        await expect(
          readPreservationSourceRange({
            reader,
            sourceId: unboundId,
            fromByte: 0,
            maxBytes: unbound.byteLength,
          }),
        ).rejects.toThrow("unavailable to this step");
        expect(() =>
          validateDocumentationPlanBinding({
            ...plan,
            sourceBindings: [
              ...plan.sourceBindings.slice(0, 1),
              { pagePath: "docs/retained.md", sources: [...sources, "src/extra.ts"] },
            ],
          }),
        ).toThrow();
      },
      {
        retainedPage: true,
        retainedContent: "# Retained claim\nThe API timeout defaults to 30 seconds.\n",
        apiContent: "export const API_TIMEOUT_SECONDS = 60;\n",
      },
    );
  });

  it("preserves literal spaced tracked members through real observation, sealing, parsing and admission", async () => {
    await withRepositoryFixture(
      async ({ workspace, observer }) => {
        const binding = {
          runId: RUN_ID,
          repositoryRevision: workspace.revision,
          scopeSha256: SCOPE_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
        };
        const captured = await observer.captureOriginalSourceAuthority({
          ...binding,
          workflow: getWorkflow("review-documentation"),
        });
        const sourceSha256 = createHash("sha256").update(SPACED_ASSET_BYTES).digest("hex");
        expect(captured.evidence.members).toContainEqual({
          path: SPACED_ASSET_PATH,
          mode: 0o644,
          byteLength: SPACED_ASSET_BYTES.byteLength,
          sourceSha256,
        });
        expect(captured.evidence.members).toHaveLength(4);
        expect(
          validateOriginalSourceAuthorityEvidence(captured.evidence, {
            ...expectedBinding(),
            repositoryRevision: workspace.revision,
          }),
        ).toEqual(captured.evidence);
        const admission = issueOriginalSourceAuthorityAdmission({
          capture: captured.capture,
          observer,
          ...binding,
        });
        await expect(
          admitOriginalSourceAuthorityChecks(admission, {
            runId: RUN_ID,
            descriptor: captured.evidence.descriptor,
            paths: [SPACED_ASSET_PATH],
          }),
        ).resolves.toEqual({
          originalSourceAuthoritySha256: captured.evidence.digest,
          sourceChecks: [{ path: SPACED_ASSET_PATH, sourceSha256 }],
        });
        await expect(
          admitOriginalSourceAuthorityChecks(admission, {
            runId: RUN_ID,
            descriptor: captured.evidence.descriptor,
            paths: [SPACED_ASSET_PATH.replaceAll(" ", "-")],
          }),
        ).rejects.toThrow("host-owned contract");
        const tampered = structuredClone(captured.evidence);
        const asset = tampered.members.find(({ path }) => path === SPACED_ASSET_PATH)!;
        (asset as { path: string }).path = SPACED_ASSET_PATH.replaceAll(" ", "-");
        expect(() => validateOriginalSourceAuthorityEvidence(tampered)).toThrow(
          "host-owned contract",
        );
      },
      { spacedAsset: true },
    );
  });

  it("admits only exact-revision tracked CREATE proposals and preserves idempotent/refused receipts", async () => {
    await withRepositoryFixture(async ({ workspace, observer }) => {
      const captured = await observer.captureOriginalSourceAuthority({
        runId: RUN_ID,
        workflow: getWorkflow("create-documentation"),
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
        authorizedPaths: ["src/api.ts"],
      });
      const admitted = await observer.admitOriginalSourceAuthorityProposals({
        runId: RUN_ID,
        repositoryRevision: workspace.revision,
        capture: captured.capture,
        authority: captured.evidence,
        originalPaths: ["src/api.ts"],
        writePaths: ["docs/guide.md"],
        proposals: [{ path: "src/extra.ts", reason: "It defines the other exported API." }],
        attempt: 1,
      });
      expect(admitted.admissions).toEqual([
        {
          schemaVersion: 1,
          kind: "docsfab-source-proposal-admission",
          attempt: 1,
          path: "src/extra.ts",
          reason: "It defines the other exported API.",
          status: "admitted",
        },
      ]);
      expect(admitted.evidence.members.map(({ path }) => path)).toEqual([
        "src/api.ts",
        "src/extra.ts",
      ]);
      expect(admitted.evidence.digest).not.toBe(captured.evidence.digest);

      // A resealed capture must carry the new digest: the old snapshot digest
      // would make this fresh reader fail before it can read the added source.
      const reader = observer.createPreservationSourceReader({
        runId: RUN_ID,
        stepId: "verify-technical-accuracy",
        repositoryRevision: workspace.revision,
        capture: admitted.capture!,
        authority: admitted.evidence,
        authorizedPaths: ["src/extra.ts"],
      });
      const [reference] = listPreservationSources(reader);
      const firstRange = await readPreservationSourceRange({
        reader,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: reference!.byteLength,
      });
      expect(firstRange.sha256).toBe(reference!.sha256);
      expect(firstRange.nextFromByte).toBeNull();

      const retry = await observer.admitOriginalSourceAuthorityProposals({
        runId: RUN_ID,
        repositoryRevision: workspace.revision,
        capture: admitted.capture!,
        authority: admitted.evidence,
        originalPaths: ["src/api.ts"],
        writePaths: ["docs/guide.md"],
        proposals: [
          { path: "src/extra.ts", reason: "It defines the other exported API." },
          { path: "docs/guide.md", reason: "The target shows the generated page." },
          { path: "src/missing.ts", reason: "It describes the source interface." },
          { path: "src/link.ts", reason: "It links to the API implementation." },
        ],
        attempt: 2,
      });
      expect(retry.evidence).toEqual(admitted.evidence);
      expect(retry.admissions.map(({ status, refusalCode }) => [status, refusalCode])).toEqual([
        ["admitted", undefined],
        ["refused", "write-target-source"],
        ["refused", "source-untracked"],
        ["refused", "source-not-regular"],
      ]);
    });
  });

  it("refuses cumulative CREATE additions at the configured per-run limit while keeping duplicates idempotent", () => {
    const maxAdded = limit("sources.createAddedAuthoritySourcesMax").value;
    const alreadyAdded = Array.from({ length: maxAdded }, (_, index) =>
      member(`src/extra-${index}.ts`),
    );
    const authority = seal([member("src/api.ts"), ...alreadyAdded], "create-plan-sources").evidence;
    const result = admitOriginalSourceAuthorityProposals({
      runId: RUN_ID,
      authority,
      originalPaths: ["src/api.ts"],
      writePaths: ["docs/guide.md"],
      trackedEntries: [
        {
          path: "src/overflow.ts",
          kind: "regular",
          mode: 0o644,
          byteLength: 18,
          sha256: sha256("export const x=1;\n"),
        },
      ],
      proposals: [
        { path: alreadyAdded[0]!.path, reason: "It contains the same supporting API detail." },
        { path: "src/overflow.ts", reason: "It supplies another supporting API detail." },
      ],
      attempt: 3,
    });

    expect(result.evidence).toEqual(authority);
    expect(result.admissions.map(({ status, refusalCode }) => [status, refusalCode])).toEqual([
      ["admitted", undefined],
      ["refused", "sources-create-added-authority-sources-max"],
    ]);
  });

  it("captures every regular tracked REVIEW member independently of observed citations", async () => {
    await withRepositoryFixture(async ({ workspace, observer }) => {
      const captured = await observer.captureOriginalSourceAuthority({
        runId: RUN_ID,
        workflow: getWorkflow("review-documentation"),
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
      });

      expect(captured.evidence.members.map(({ path }) => path)).toEqual([
        "docs/guide.md",
        "src/api.ts",
        "src/extra.ts",
      ]);
      expect(captured.evidence.members).toEqual([
        member("docs/guide.md", "# Original guide\n"),
        member("src/api.ts", "export const api = 1;\n"),
        member("src/extra.ts", "export const extra = 2;\n"),
      ]);
      expect(captured.evidence.descriptor).toMatchObject({
        scope: "review-tracked-workspace",
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
        memberCount: 3,
      });

      const admission = issueOriginalSourceAuthorityAdmission({
        capture: captured.capture,
        observer,
        runId: RUN_ID,
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
      });
      await expect(
        admitOriginalSourceAuthorityChecks(admission, {
          runId: RUN_ID,
          descriptor: captured.evidence.descriptor,
          paths: ["src/extra.ts"],
        }),
      ).resolves.toEqual({
        originalSourceAuthoritySha256: captured.evidence.digest,
        sourceChecks: [{ path: "src/extra.ts", sourceSha256: sha256("export const extra = 2;\n") }],
      });
    });
  });

  it("captures the tracked ROUTER brace-placeholder member paths through real observation, sealing, parsing and admission", async () => {
    await withRepositoryFixture(
      async ({ workspace, observer }) => {
        const captured = await observer.captureOriginalSourceAuthority({
          runId: RUN_ID,
          workflow: getWorkflow("review-documentation"),
          repositoryRevision: workspace.revision,
          scopeSha256: SCOPE_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
        });

        const capturedPaths = captured.evidence.members.map(({ path }) => path);
        for (const path of ROUTER_BRACE_MEMBER_PATHS) {
          expect(capturedPaths).toContain(path);
          expect(captured.evidence.members).toContainEqual(member(path, `${path}\n`));
        }
        expect(
          validateOriginalSourceAuthorityEvidence(captured.evidence, {
            ...expectedBinding(),
            repositoryRevision: workspace.revision,
          }),
        ).toEqual(captured.evidence);

        const admission = issueOriginalSourceAuthorityAdmission({
          capture: captured.capture,
          observer,
          runId: RUN_ID,
          repositoryRevision: workspace.revision,
          scopeSha256: SCOPE_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
        });
        const target = ROUTER_BRACE_MEMBER_PATHS[0];
        await expect(
          admitOriginalSourceAuthorityChecks(admission, {
            runId: RUN_ID,
            descriptor: captured.evidence.descriptor,
            paths: [target],
          }),
        ).resolves.toEqual({
          originalSourceAuthoritySha256: captured.evidence.digest,
          sourceChecks: [{ path: target, sourceSha256: sha256(`${target}\n`) }],
        });

        const createdPlan = await observer.captureOriginalSourceAuthority({
          runId: RUN_ID,
          workflow: getWorkflow("create-documentation"),
          repositoryRevision: workspace.revision,
          scopeSha256: SCOPE_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
          authorizedPaths: [target],
        });
        expect(createdPlan.evidence.members).toEqual([member(target, `${target}\n`)]);
      },
      { braceMembers: true },
    );
  });

  it("captures tracked members whose paths carry +, @, !, and , through real observation, sealing, parsing and admission", async () => {
    await withRepositoryFixture(
      async ({ workspace, observer }) => {
        const binding = {
          runId: RUN_ID,
          repositoryRevision: workspace.revision,
          scopeSha256: SCOPE_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
        };
        const captured = await observer.captureOriginalSourceAuthority({
          ...binding,
          workflow: getWorkflow("review-documentation"),
        });
        for (const path of GIT_LEGAL_MEMBER_PATHS) {
          expect(captured.evidence.members).toContainEqual(member(path, `${path}\n`));
        }
        expect(captured.evidence.members).toHaveLength(3 + GIT_LEGAL_MEMBER_PATHS.length);
        expect(
          validateOriginalSourceAuthorityEvidence(captured.evidence, {
            ...expectedBinding(),
            repositoryRevision: workspace.revision,
          }),
        ).toEqual(captured.evidence);
        const admission = issueOriginalSourceAuthorityAdmission({
          capture: captured.capture,
          observer,
          ...binding,
        });
        const targets = [...GIT_LEGAL_MEMBER_PATHS].sort();
        await expect(
          admitOriginalSourceAuthorityChecks(admission, {
            runId: RUN_ID,
            descriptor: captured.evidence.descriptor,
            paths: targets,
          }),
        ).resolves.toEqual({
          originalSourceAuthoritySha256: captured.evidence.digest,
          sourceChecks: targets.map((path) => ({ path, sourceSha256: sha256(`${path}\n`) })),
        });
      },
      { gitLegalMembers: true },
    );
  });

  it("refuses a tracked member path that uses braces outside the exact placeholder-segment convention", async () => {
    await withRepositoryFixture(
      async ({ workspace, observer }) => {
        await expect(
          observer.captureOriginalSourceAuthority({
            runId: RUN_ID,
            workflow: getWorkflow("review-documentation"),
            repositoryRevision: workspace.revision,
            scopeSha256: SCOPE_SHA256,
            workspaceSnapshotSha256: SNAPSHOT_SHA256,
          }),
        ).rejects.toMatchObject({
          code: "source-authority-path-refused",
          message: expect.stringContaining(
            'Tracked path "src/pre{name}post.py" cannot enter the original source authority: it uses { or } outside a whole-segment {name} placeholder.',
          ),
        });
      },
      { malformedBraceMember: true },
    );
  });

  it("captures exactly the normalized CREATE plan source set and rejects other tracked reads", async () => {
    await withRepositoryFixture(async ({ workspace, observer }) => {
      const captured = await observer.captureOriginalSourceAuthority({
        runId: RUN_ID,
        workflow: getWorkflow("create-documentation"),
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
        authorizedPaths: ["src/extra.ts", "src/api.ts", "src/api.ts"],
      });
      expect(captured.evidence.descriptor.scope).toBe("create-plan-sources");
      expect(captured.evidence.members.map(({ path }) => path)).toEqual([
        "src/api.ts",
        "src/extra.ts",
      ]);

      const observe = vi.fn<OriginalSourceAuthoritySourceObserver["observe"]>(async (paths) =>
        observer.observe(paths),
      );
      const admission = issueOriginalSourceAuthorityAdmission({
        capture: captured.capture,
        observer: { observe },
        runId: RUN_ID,
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
      });
      await expect(
        admitOriginalSourceAuthorityChecks(admission, {
          runId: RUN_ID,
          descriptor: captured.evidence.descriptor,
          paths: ["docs/guide.md"],
        }),
      ).rejects.toThrow("host-owned contract");
      expect(observe).not.toHaveBeenCalled();
    });
  });

  it("admits an exact empty path set without a read after capability and binding preflight", async () => {
    const captured = seal();
    const observe = vi.fn<OriginalSourceAuthoritySourceObserver["observe"]>(async () => []);
    const admission = issueOriginalSourceAuthorityAdmission({
      capture: captured.capture,
      observer: { observe },
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256: SCOPE_SHA256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    });

    await expect(
      admitOriginalSourceAuthorityChecks(admission, {
        runId: RUN_ID,
        descriptor: captured.evidence.descriptor,
        paths: [],
      }),
    ).resolves.toEqual({
      originalSourceAuthoritySha256: captured.evidence.digest,
      sourceChecks: [],
    });
    await expect(
      admitOriginalSourceAuthorityChecks(structuredClone(admission), {
        runId: RUN_ID,
        descriptor: captured.evidence.descriptor,
        paths: [],
      }),
    ).rejects.toThrow("host-owned contract");
    await expect(
      admitOriginalSourceAuthorityChecks(admission, {
        runId: "another-run",
        descriptor: captured.evidence.descriptor,
        paths: [],
      }),
    ).rejects.toThrow("host-owned contract");
    expect(observe).not.toHaveBeenCalled();
  });

  it("rejects untracked, excluded, symlink, unsafe, and malformed CREATE source members", async () => {
    await withRepositoryFixture(async ({ workspace, observer }) => {
      for (const path of [
        "src/untracked.ts",
        ".env",
        "src/link.ts",
        "../outside.ts",
        "src/api.ts:1",
      ]) {
        await expect(
          observer.captureOriginalSourceAuthority({
            runId: RUN_ID,
            workflow: getWorkflow("create-documentation"),
            repositoryRevision: workspace.revision,
            scopeSha256: SCOPE_SHA256,
            workspaceSnapshotSha256: SNAPSHOT_SHA256,
            authorizedPaths: [path],
          }),
        ).rejects.toMatchObject({
          name: "SourceObligationSourceReferenceError",
          code: "source-untracked",
        });
      }
    });
  });

  it("uses one canonical mixed-case member order for real CREATE and REVIEW capture", async () => {
    await withRepositoryFixture(
      async ({ workspace, observer }) => {
        const binding = {
          runId: RUN_ID,
          repositoryRevision: workspace.revision,
          scopeSha256: SCOPE_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
        };
        const created = await observer.captureOriginalSourceAuthority({
          ...binding,
          workflow: getWorkflow("create-documentation"),
          authorizedPaths: ["README.md", "package.json"],
        });
        const reviewed = await observer.captureOriginalSourceAuthority({
          ...binding,
          workflow: getWorkflow("review-documentation"),
        });

        expect(created.evidence.members.map(({ path }) => path)).toEqual([
          "README.md",
          "package.json",
        ]);
        expect(
          reviewed.evidence.members
            .map(({ path }) => path)
            .filter((path) => path === "README.md" || path === "package.json"),
        ).toEqual(["README.md", "package.json"]);
        expect(
          validateOriginalSourceAuthorityEvidence(created.evidence, {
            ...expectedBinding("create-plan-sources"),
            repositoryRevision: workspace.revision,
          }),
        ).toEqual(created.evidence);
        expect(
          validateOriginalSourceAuthorityEvidence(reviewed.evidence, {
            ...expectedBinding(),
            repositoryRevision: workspace.revision,
          }),
        ).toEqual(reviewed.evidence);
      },
      { mixedCaseRootFiles: true },
    );
  });
});

describe("original source authority durable validation", () => {
  it("preserves safe literal member paths independently of citation parsing", () => {
    for (const path of [
      SPACED_ASSET_PATH,
      "docs/Quick Start.md",
      "src/My Module.ts",
      "NOTICE",
      ".config/example file.json",
      ...ROUTER_BRACE_MEMBER_PATHS,
    ]) {
      const evidence = seal([member(path)]).evidence;
      expect(validateOriginalSourceAuthorityEvidence(evidence).members[0]?.path).toBe(path);
    }
    const distinct = seal([member("docs/Quick  Start.md"), member("docs/Quick Start.md")]);
    expect(distinct.evidence.descriptor.memberCount).toBe(2);
    expect(distinct.evidence.members[0]?.sourceSha256).not.toBe(
      distinct.evidence.members[1]?.sourceSha256,
    );
    expect(normalizeRepositoryLocator(SPACED_ASSET_PATH).fidelity).toBe("unavailable");
    expect(normalizeRepositoryLocator("src/api.ts:12")).toMatchObject({
      path: "src/api.ts",
      line: 12,
      fidelity: "exact",
    });
  });

  it("binds exact descriptor, member-array, and evidence digests and returns immutable values", () => {
    const sealed = seal([member("src/api.ts"), member("src/extra.ts")]);
    const descriptorBody = { ...sealed.evidence.descriptor, digest: undefined };
    delete descriptorBody.digest;
    const evidenceBody = { ...sealed.evidence, digest: undefined };
    delete evidenceBody.digest;

    expect(sealed.evidence.descriptor.memberCount).toBe(2);
    expect(Object.keys(sealed.evidence.descriptor)).toEqual([
      "kind",
      "schemaVersion",
      "scope",
      "repositoryRevision",
      "scopeSha256",
      "workspaceSnapshotSha256",
      "memberCount",
      "membersSha256",
      "digest",
    ]);
    expect(Object.keys(sealed.evidence)).toEqual([
      "kind",
      "schemaVersion",
      "descriptor",
      "members",
      "digest",
    ]);
    expect(sealed.evidence.descriptor.membersSha256).toBe(canonicalDigest(sealed.evidence.members));
    expect(sealed.evidence.descriptor.digest).toBe(canonicalDigest(descriptorBody));
    expect(sealed.evidence.digest).toBe(canonicalDigest(evidenceBody));
    expect(validateOriginalSourceAuthorityDescriptor(sealed.evidence.descriptor)).toEqual(
      sealed.evidence.descriptor,
    );
    expect(validateOriginalSourceAuthorityEvidence(sealed.evidence, expectedBinding())).toEqual(
      sealed.evidence,
    );
    expect(Object.isFrozen(sealed.evidence)).toBe(true);
    expect(Object.isFrozen(sealed.evidence.members)).toBe(true);
    expect(Object.isFrozen(sealed.evidence.members[0])).toBe(true);
  });

  it("rejects malformed, unsafe, duplicate, unsorted, and out-of-bounds member tuples", () => {
    const invalidMembers: readonly (readonly OriginalSourceAuthorityMemberV1[])[] = [
      [],
      [member("src/api.ts"), member("src/api.ts")],
      [member("src/z.ts"), member("src/a.ts")],
      [member("src/api.ts", undefined, { mode: -1 })],
      [member("src/api.ts", undefined, { mode: 0o1000 })],
      [member("src/api.ts", undefined, { byteLength: -1 })],
      [member("src/api.ts", undefined, { byteLength: 2 * 1024 * 1024 * 1024 + 1 })],
      [member("src/api.ts", undefined, { sourceSha256: "not-a-hash" })],
    ];
    for (const members of invalidMembers) {
      expect(() => seal(members)).toThrow("host-owned contract");
    }
    expect(() =>
      seal([
        member("src/a.ts", undefined, { byteLength: 1024 * 1024 * 1024 + 1 }),
        member("src/b.ts", undefined, { byteLength: 1024 * 1024 * 1024 }),
      ]),
    ).toThrow("host-owned contract");

    // An unsafe path stops with its own code, naming the path and the rule.
    for (const path of [
      "../outside.ts",
      "/absolute.ts",
      "src/api.ts:1",
      "",
      ".",
      "..",
      "./src/api.ts",
      "src/../api.ts",
      "src/./api.ts",
      "src//api.ts",
      "src/",
      " src/api.ts",
      "src/api.ts ",
      "src/ api.ts",
      "src /api.ts",
      "C:/api.ts",
      "C:\\api.ts",
      "\\\\server\\api.ts",
      "~/api.ts",
      "https://example.test/api.ts",
      "file:src/api.ts",
      "src/with\ttab.ts",
      "src/with\nnewline.ts",
      "src/with\0null.ts",
      "src/with\x7fdelete.ts",
      // Positive controls: brace placeholders are admitted only as an exact
      // whole-segment "{identifier}"; every other brace shape stays refused.
      "src/pre{name}post.ts",
      "src/{name}post.ts",
      "src/pre{name}.ts",
      "src/{}.ts",
      "src/{}/api.ts",
      "src/{name}{other}.ts",
      "src/{na me}.ts",
      "src/{{name}}.ts",
      "src/{name",
      "src/name}",
    ]) {
      expect(
        thrownBy(() => seal([member(path)])),
        JSON.stringify(path),
      ).toMatchObject({
        code: "source-authority-path-refused",
        message: expect.stringMatching(
          /^Tracked path ".*" cannot enter the original source authority: /u,
        ),
      });
    }
    expect(thrownBy(() => seal([member(`src/${"a".repeat(509)}`)]))).toMatchObject({
      code: "sources-authority-member-path-max-chars-bound",
    });
    // Citation-shaped names are literal Git paths; the authority never parses
    // them as citations, so it admits them as members.
    for (const path of [
      "src/api.ts#section",
      "src/api.ts@revision",
      "src/api.ts (section)",
      "src/api.ts, evidence",
      "src/api.ts; evidence",
    ]) {
      expect(seal([member(path)]).evidence.members.map((entry) => entry.path)).toEqual([path]);
    }
  });

  it("rejects direct tampering of every descriptor, member tuple, count, hash, and evidence digest coordinate", () => {
    const valid = seal([member("src/api.ts"), member("src/extra.ts")]).evidence;
    const mutations: Array<(value: OriginalSourceAuthorityEvidenceV1) => void> = [
      (value) => {
        (value.members[0] as { path: string }).path = "src/changed.ts";
      },
      (value) => {
        (value.members[0] as { mode: number }).mode = 0o755;
      },
      (value) => {
        (value.members[0] as { byteLength: number }).byteLength += 1;
      },
      (value) => {
        (value.members[0] as { sourceSha256: string }).sourceSha256 = "d".repeat(64);
      },
      (value) => {
        (value.descriptor as { memberCount: number }).memberCount += 1;
      },
      (value) => {
        (value.descriptor as { membersSha256: string }).membersSha256 = "d".repeat(64);
      },
      (value) => {
        (value.descriptor as { repositoryRevision: string }).repositoryRevision = "d".repeat(40);
      },
      (value) => {
        (value.descriptor as { scope: OriginalSourceAuthorityScope }).scope = "create-plan-sources";
      },
      (value) => {
        (value.descriptor as { scopeSha256: string }).scopeSha256 = "d".repeat(64);
      },
      (value) => {
        (value.descriptor as { workspaceSnapshotSha256: string }).workspaceSnapshotSha256 =
          "d".repeat(64);
      },
      (value) => {
        (value.descriptor as { digest: string }).digest = "d".repeat(64);
      },
      (value) => {
        (value as { digest: string }).digest = "d".repeat(64);
      },
    ];

    for (const mutate of mutations) {
      const tampered = structuredClone(valid);
      mutate(tampered);
      expect(() => validateOriginalSourceAuthorityEvidence(tampered, expectedBinding())).toThrow(
        "host-owned contract",
      );
    }
  });

  it("rejects re-digested descriptors whose scope, revision, or snapshot breaks expected binding", () => {
    const valid = seal().evidence;
    for (const patch of [
      { scope: "create-plan-sources" as const },
      { repositoryRevision: "d".repeat(40) },
      { scopeSha256: "d".repeat(64) },
      { workspaceSnapshotSha256: "d".repeat(64) },
    ]) {
      const descriptorBody = { ...valid.descriptor, ...patch };
      delete (descriptorBody as { digest?: string }).digest;
      const descriptor = { ...descriptorBody, digest: canonicalDigest(descriptorBody) };
      const evidenceBody = { ...valid, descriptor };
      delete (evidenceBody as { digest?: string }).digest;
      const tampered = { ...evidenceBody, digest: canonicalDigest(evidenceBody) };
      expect(() => validateOriginalSourceAuthorityEvidence(tampered, expectedBinding())).toThrow(
        "host-owned contract",
      );
    }
  });

  it("builds an exact member lookup without accepting malformed durable input", () => {
    const evidence = seal([member("src/api.ts"), member("src/extra.ts")]).evidence;
    const members = originalSourceAuthorityMemberMap(evidence);
    expect([...members]).toEqual(evidence.members.map((item) => [item.path, item]));
    expect(members.get("src/extra.ts")).toEqual(member("src/extra.ts"));

    const tampered = { ...structuredClone(evidence), members: [...evidence.members].reverse() };
    expect(() => originalSourceAuthorityMemberMap(tampered)).toThrow("host-owned contract");
  });
});

describe("original source authority opaque admission", () => {
  it("rejects cloned, rebound, cross-run, cross-scope, cross-revision, and cross-snapshot authorities", async () => {
    const sealed = seal();
    const observer: OriginalSourceAuthoritySourceObserver = {
      async observe(paths) {
        return paths.map((path) => ({ path, sha256: member(path).sourceSha256 }));
      },
    };
    const issue = (capture: typeof sealed.capture, patch: Record<string, string> = {}) =>
      issueOriginalSourceAuthorityAdmission({
        capture,
        observer,
        runId: RUN_ID,
        repositoryRevision: REVISION,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
        ...patch,
      });

    expect(() => issue(structuredClone(sealed.capture))).toThrow("host-owned contract");
    expect(() => issue(Object.assign(Object.create(null), sealed.capture))).toThrow(
      "host-owned contract",
    );
    expect(() => issue(sealed.capture, { runId: "other-run" })).toThrow("host-owned contract");
    expect(() => issue(sealed.capture, { repositoryRevision: "d".repeat(40) })).toThrow(
      "host-owned contract",
    );
    expect(() => issue(sealed.capture, { scopeSha256: "d".repeat(64) })).toThrow(
      "host-owned contract",
    );
    expect(() => issue(sealed.capture, { workspaceSnapshotSha256: "d".repeat(64) })).toThrow(
      "host-owned contract",
    );

    const admission = issue(sealed.capture);
    await expect(
      admitOriginalSourceAuthorityChecks(structuredClone(admission), {
        runId: RUN_ID,
        descriptor: sealed.evidence.descriptor,
        paths: ["src/api.ts"],
      }),
    ).rejects.toThrow("host-owned contract");
    await expect(
      admitOriginalSourceAuthorityChecks(admission, {
        runId: "other-run",
        descriptor: sealed.evidence.descriptor,
        paths: ["src/api.ts"],
      }),
    ).rejects.toThrow("host-owned contract");

    const otherScope = seal([member("src/api.ts")], "create-plan-sources");
    const otherAdmission = issueOriginalSourceAuthorityAdmission({
      capture: otherScope.capture,
      observer,
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256: SCOPE_SHA256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    });
    await expect(
      admitOriginalSourceAuthorityChecks(otherAdmission, {
        runId: RUN_ID,
        descriptor: sealed.evidence.descriptor,
        paths: ["src/api.ts"],
      }),
    ).rejects.toThrow("host-owned contract");
  });

  it("admits unchanged original bytes across an allowed documentation change and rejects source drift", async () => {
    await withRepositoryFixture(async ({ workspace, observer }) => {
      const captured = await observer.captureOriginalSourceAuthority({
        runId: RUN_ID,
        workflow: getWorkflow("review-documentation"),
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
      });
      const admission = issueOriginalSourceAuthorityAdmission({
        capture: captured.capture,
        observer,
        runId: RUN_ID,
        repositoryRevision: workspace.revision,
        scopeSha256: SCOPE_SHA256,
        workspaceSnapshotSha256: SNAPSHOT_SHA256,
      });

      await writeFile(join(workspace.path, "docs", "guide.md"), "# Revised candidate guide\n");
      await admitAuthorizedTrackedWrites(workspace, ["docs/guide.md"]);
      await expect(
        admitOriginalSourceAuthorityChecks(admission, {
          runId: RUN_ID,
          descriptor: captured.evidence.descriptor,
          paths: ["src/api.ts"],
        }),
      ).resolves.toMatchObject({
        originalSourceAuthoritySha256: captured.evidence.digest,
      });

      await writeFile(join(workspace.path, "src", "api.ts"), "export const api = 999;\n");
      await admitAuthorizedTrackedWrites(workspace, ["src/api.ts"]);
      await expect(
        admitOriginalSourceAuthorityChecks(admission, {
          runId: RUN_ID,
          descriptor: captured.evidence.descriptor,
          paths: ["src/api.ts"],
        }),
      ).rejects.toThrow("host-owned contract");
    });
  });

  it("preserves observer cancellation instead of converting it into authority evidence", async () => {
    const sealed = seal();
    const cancellation = new DOMException("cancelled by test", "AbortError");
    const admission = issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: {
        async observe() {
          throw cancellation;
        },
      },
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256: SCOPE_SHA256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    });
    await expect(
      admitOriginalSourceAuthorityChecks(admission, {
        runId: RUN_ID,
        descriptor: sealed.evidence.descriptor,
        paths: ["src/api.ts"],
      }),
    ).rejects.toBe(cancellation);
  });

  it("validates and retains the 100000-member contract while later boundaries expose only requested checks", async () => {
    const sourceSha256 = sha256("");
    const members = Array.from({ length: 100_000 }, (_, index) => ({
      path: `src/member-${String(index).padStart(5, "0")}.ts`,
      mode: 0o644,
      byteLength: 0,
      sourceSha256,
    }));
    const sealed = seal(members);
    const validated = validateOriginalSourceAuthorityEvidence(sealed.evidence, expectedBinding());
    expect(validated.descriptor.memberCount).toBe(100_000);
    expect(validated.members).toHaveLength(100_000);
    expect(originalSourceAuthorityMemberMap(validated).get("src/member-99999.ts")).toEqual(
      members[99_999],
    );
    expect(JSON.stringify(sealed.capture)).not.toContain("member-00000");
    expect(JSON.stringify(validated.descriptor)).not.toContain("member-00000");

    const admission = issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: {
        async observe(paths) {
          return paths.map((path) => ({ path, sha256: sourceSha256 }));
        },
      },
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256: SCOPE_SHA256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    });
    const admitted = await admitOriginalSourceAuthorityChecks(admission, {
      runId: RUN_ID,
      descriptor: sealed.evidence.descriptor,
      paths: ["src/member-00000.ts", "src/member-99999.ts"],
    });
    expect(admitted).toEqual({
      originalSourceAuthoritySha256: sealed.evidence.digest,
      sourceChecks: [
        { path: "src/member-00000.ts", sourceSha256 },
        { path: "src/member-99999.ts", sourceSha256 },
      ],
    });
    expect(JSON.stringify(admitted)).not.toContain("member-00001");
  }, 30_000);
});
